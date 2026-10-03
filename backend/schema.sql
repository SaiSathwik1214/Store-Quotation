-- Runs automatically on every server start (safe to re-run).
CREATE TABLE IF NOT EXISTS quotations (
  sl_no          INTEGER       PRIMARY KEY CHECK (sl_no > 0),   -- the Sl.No. on the form
  quote_date     DATE          NOT NULL,
  customer_name  TEXT          NOT NULL,
  customer_addr  TEXT          NOT NULL DEFAULT '',
  customer_phone TEXT          NOT NULL,
  total_feet     TEXT          NOT NULL DEFAULT '',
  quoted_feet    TEXT          NOT NULL DEFAULT '',
  items          JSONB         NOT NULL DEFAULT '[]'::jsonb,    -- every table row: particulars, split fields, unit, qty, rate
  grand_total    NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotations_phone ON quotations (customer_phone);
CREATE INDEX IF NOT EXISTS idx_quotations_date  ON quotations (quote_date DESC);
