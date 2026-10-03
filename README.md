# Sri Rohit Motors – Quotation app (GitHub Pages + SQL backend)

```
index.html        → frontend (GitHub Pages) – design unchanged
backend/          → Node.js + Express API, PostgreSQL (Sl.No. = PRIMARY KEY)
```

## 1. Database (PostgreSQL)
Create a hosted Postgres database (e.g. Neon) and copy its connection string.
The `quotations` table is created automatically when the server starts.

## 2. Backend (e.g. Render – Web Service)
- Repo: this one · **Root Directory:** `backend` · **Build:** `npm install` · **Start:** `npm start`
- Environment variables (see `backend/.env.example`):
  `DATABASE_URL`, `API_KEY` (any long random string), `ALLOWED_ORIGINS`
  (`https://YOUR-USERNAME.github.io` – no repo path), `SERIAL_START` (your last used Sl.No. + 1)
- Free instances sleep when idle, so the first request after a break can take up to a minute.
  Check the host's current free-tier terms.

## 3. Frontend
In `index.html` set `API_BASE` to your backend URL (no trailing slash), commit, push.
First time on each device the page asks for the access key (`API_KEY`) once.

## Using it
- Opens on the next free Sl.No.
- **Save** → stores the quotation in the database, then downloads the PDF as before.
- **Load an old quotation:** type its Sl.No. in the Sl.No. box and press Enter / Tab.
- Change the Sl.No. of a loaded quotation and Save → stores a copy under the new number.

## API (header `x-api-key` required)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/quotations/next-serial` | next free Sl.No. |
| GET | `/api/quotations?q=&limit=&offset=` | list / search |
| GET | `/api/quotations/:slNo` | one full record |
| POST | `/api/quotations` | create (409 if Sl.No. exists) |
| PUT | `/api/quotations/:slNo` | update |
| DELETE | `/api/quotations/:slNo` | delete |
| GET | `/health` | no key needed |

## Run locally
```
cd backend && cp .env.example .env   # fill in values
npm install && npm start             # http://localhost:3000
```
Serve `index.html` from `http://localhost:5500` and set `API_BASE = 'http://localhost:3000'`.
