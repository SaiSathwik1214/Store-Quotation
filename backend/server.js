require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const { DATABASE_URL, API_KEY } = process.env;
const PORT = process.env.PORT || 3000;
const SERIAL_START = parseInt(process.env.SERIAL_START || '1', 10) || 1;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',')
  .map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (!API_KEY || API_KEY.length < 8) throw new Error('API_KEY must be set (min 8 characters)');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL_DISABLE === 'true' ? false : { rejectUnauthorized: false },
  max: 5
});

// Column list shared by all "full record" queries (names match what the frontend uses)
const COLS = `sl_no AS "slNo", to_char(quote_date,'YYYY-MM-DD') AS "date", customer_name AS "name",
  customer_addr AS "addr", customer_phone AS "phone", total_feet AS "totalFeet",
  quoted_feet AS "quotedFeet", items, grand_total::float8 AS "grandTotal",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
  maxAge: 600
}));
app.use(express.json({ limit: '100kb' }));

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---------- helpers ----------
const clean = (v, max) => String(v ?? '').slice(0, max);

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Returns { error } or { value: [params in INSERT/UPDATE order] }
function validate(b, slNo) {
  if (!b || typeof b !== 'object') return { error: 'Invalid request body' };
  if (!Number.isInteger(slNo) || slNo < 1 || slNo > 2147483647) return { error: 'Sl.No. must be a positive whole number' };
  const date = clean(b.date, 10);
  if (!validDate(date)) return { error: 'Date must be a valid YYYY-MM-DD' };
  const name = clean(b.name, 200).trim();
  const phone = clean(b.phone, 30).trim();
  if (!name) return { error: 'Customer name is required' };
  if (!phone) return { error: 'Phone number is required' };
  if (!Array.isArray(b.items) || b.items.length > 60) return { error: 'items must be an array of up to 60 rows' };

  const items = b.items.map(it => {
    const row = { p: clean(it?.p, 300), u: clean(it?.u, 20), q: clean(it?.q, 30), r: clean(it?.r, 30) };
    if (Array.isArray(it?.sub)) row.sub = it.sub.slice(0, 3).map(s => clean(s, 60));
    return row;
  });
  const total = items.reduce((s, it) => s + (parseFloat(it.q) || 0) * (parseFloat(it.r) || 0), 0);
  if (!Number.isFinite(total) || total >= 1e12) return { error: 'Quantity / rate values are out of range' };

  return { value: [slNo, date, name, clean(b.addr, 500).trim(), phone,
    clean(b.totalFeet, 50), clean(b.quotedFeet, 50), JSON.stringify(items), Math.round(total * 100) / 100] };
}

const serialOf = req => { const n = Number(req.params.slNo); return Number.isInteger(n) ? n : NaN; };

function requireKey(req, res, next) {
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ error: 'Invalid access key' });
}

// ---------- routes ----------
app.get('/health', wrap(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

const router = express.Router();
// Throttle only wrong-key attempts (20 per 15 min per IP)
router.use(rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  standardHeaders: true, legacyHeaders: false
}));
router.use(requireKey);

router.get('/quotations/next-serial', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT GREATEST(COALESCE(MAX(sl_no), 0) + 1, $1::int) AS next FROM quotations', [SERIAL_START]);
  res.json({ nextSerial: Number(rows[0].next) });
}));

router.get('/quotations', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = String(req.query.q || '').trim().replace(/[\\%_]/g, '\\$&');
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if ((from && !validDate(from)) || (to && !validDate(to))) {
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  }

  const params = [limit + 1, offset];          // fetch one extra row to know if more pages exist
  const conds = [];
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    conds.push(`(customer_name ILIKE $${i} OR customer_phone ILIKE $${i} OR sl_no::text ILIKE $${i})`);
  }
  if (from) { params.push(from); conds.push(`quote_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`quote_date <= $${params.length}::date`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT sl_no AS "slNo", to_char(quote_date,'YYYY-MM-DD') AS "date", customer_name AS "name",
            customer_phone AS "phone", grand_total::float8 AS "grandTotal"
       FROM quotations ${where} ORDER BY quote_date DESC, sl_no DESC LIMIT $1 OFFSET $2`, params);
  res.json({ quotations: rows.slice(0, limit), hasMore: rows.length > limit });
}));

router.get('/quotations/:slNo', wrap(async (req, res) => {
  const n = serialOf(req);
  if (!(n >= 1)) return res.status(400).json({ error: 'Invalid Sl.No.' });
  const { rows } = await pool.query(`SELECT ${COLS} FROM quotations WHERE sl_no = $1`, [n]);
  if (!rows.length) return res.status(404).json({ error: `Quotation ${n} not found` });
  res.json(rows[0]);
}));

router.post('/quotations', wrap(async (req, res) => {
  const v = validate(req.body, parseInt(req.body?.slNo, 10));
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO quotations (sl_no, quote_date, customer_name, customer_addr, customer_phone,
                               total_feet, quoted_feet, items, grand_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING ${COLS}`, v.value);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: `Sl.No. ${v.value[0]} already exists` });
    throw e;
  }
}));

router.put('/quotations/:slNo', wrap(async (req, res) => {
  const v = validate(req.body, serialOf(req));
  if (v.error) return res.status(400).json({ error: v.error });
  const { rows } = await pool.query(
    `UPDATE quotations SET quote_date=$2, customer_name=$3, customer_addr=$4, customer_phone=$5,
            total_feet=$6, quoted_feet=$7, items=$8::jsonb, grand_total=$9, updated_at=now()
      WHERE sl_no=$1 RETURNING ${COLS}`, v.value);
  if (!rows.length) return res.status(404).json({ error: `Quotation ${v.value[0]} not found` });
  res.json(rows[0]);
}));

router.delete('/quotations/:slNo', wrap(async (req, res) => {
  const n = serialOf(req);
  if (!(n >= 1)) return res.status(400).json({ error: 'Invalid Sl.No.' });
  const { rowCount } = await pool.query('DELETE FROM quotations WHERE sl_no = $1', [n]);
  if (!rowCount) return res.status(404).json({ error: `Quotation ${n} not found` });
  res.status(204).end();
}));

app.use('/api', router);
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.message === 'Origin not allowed') return res.status(403).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  app.listen(PORT, () => console.log(`Quotation API listening on ${PORT}`));
})().catch(e => { console.error('Startup failed:', e); process.exit(1); });
