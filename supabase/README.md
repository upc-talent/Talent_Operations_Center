# Supabase backend — setup runbook

Supabase is the single source of truth: a Postgres database behind one Edge Function that handles
every read, every write, and all authentication. The front‑end talks to it through one thin layer
(`assets/js/api.js`).

```
supabase/schema.sql            ← run once in the SQL editor (creates tables + locks them down)
supabase/functions/api/        ← the Edge Function — all reads/writes and all auth
```

---

## Step 1 — Create the tables

Supabase dashboard → **SQL Editor** → paste all of [`schema.sql`](schema.sql) → **Run**.
It creates the tables and enables Row‑Level Security with **no policies**, so the public (anon) key
can touch nothing — only the Edge Function (service_role) can. Safe to re‑run.

## Step 2 — Set the Edge Function secrets

Dashboard → **Edge Functions → Secrets** (or `supabase secrets set NAME=value`). Add:

| Secret | Value |
|---|---|
| `TRAINER_USER` | the trainer‑page username (same one you use today) |
| `TRAINER_PASS` | the trainer‑page password |
| `ADMIN_USER` / `ADMIN_PASS` | the lower‑access Admin login (Attendance tab only). Optional — admin sign‑in stays off until both are set. |
| `TOKEN_SECRET` | any long random string (e.g. paste a UUID or two). Optional — if you skip it, the function generates and stores one automatically. |

`SUPABASE_DB_URL`, `SUPABASE_URL`, etc. are provided by Supabase automatically — don't add those.

## Step 3 — Deploy the Edge Function

**Option A — Supabase CLI (recommended):**
```bash
supabase login
supabase link --project-ref aoqgabdsayaqgqroscdw
supabase functions deploy api
```

**Option B — Dashboard:** Edge Functions → **Create function** → name it exactly `api` →
paste the contents of [`functions/api/index.ts`](functions/api/index.ts) → **Deploy**.

Quick check — this should return `{"ok":true,...}` (replace ANON with your anon key):
```bash
curl -s -X POST "https://aoqgabdsayaqgqroscdw.supabase.co/functions/v1/api" \
  -H "Authorization: Bearer ANON" -H "apikey: ANON" -H "Content-Type: application/json" \
  -d '{"action":"supervisors"}'
```
(It returns the list of supervisor names once the roster is loaded.)

## Step 4 — Redeploying after a change

The Edge Function is the only backend. After editing `functions/api/index.ts`, redeploy it the same way
(dashboard → the `api` function → paste → **Deploy**, or `supabase functions deploy api`). The front‑end
is static: publish `assets/`, `*.html` to GitHub Pages as usual. The two are independent — the wire
protocol between them only changes if a data key is added.

---

### Performance notes (how the daily queries are kept cheap)
- **Writes read only what they touch.** `patchOps` fetches just the rows being changed (`where id in …`) and asks
  Postgres for seat counts with a `GROUP BY` limited to the days involved — it never scans the whole roster.
- **Trainer writes skip the capacity machinery.** Training days, settings and seat counts are only loaded when a
  *supervisor* changes an assignment, so marking attendance is 1 select + 1 update.
- **The lock is only taken when seats move.** Attendance-only writes don't serialize against each other.
- **Batched writes.** A bulk action updates every affected row in one statement, not one per row.
- **Reads select only the columns that are actually returned**, and a supervisor's rows are filtered in SQL.
- **Supervisor auth is an indexed lookup**, not a full distinct-scan on every request.
- **Responses are gzip-compressed** by Supabase (measured ~7.5× on real data), so payload size is not the bottleneck.
- **Measuring:** open any page with `?debug=1` and the console logs `round-trip` vs `server` time per request
  (the function returns its own execution time as `_ms`). That's how you tell network from database.

### Notes
- **Training days** are managed in the app, or imported in bulk from a planning spreadsheet via
  **Trainer → Calendar → Import Calendar** (parsed in the browser, then saved like any other change).
- **Free‑tier pause:** a free Supabase project sleeps after 7 days of inactivity (one‑click resume). If you
  have quiet weeks, add a weekly keep‑alive ping or a `pg_cron` job.
- **Concurrency safety:** a write that moves someone between days runs in a transaction holding a Postgres
  advisory lock, so two people can't both grab the last seat.
- **Per-supervisor quotas** apply to in-person days as well as online ones; the server enforces them in
  `validateSupervisorAssignment`.

---

## Hourly Google Sheet backup (optional, recommended)

A second Edge Function, `backup` ([`functions/backup/index.ts`](functions/backup/index.ts)), copies every table
into a Google Sheet once an hour: one tab per table (Pharmacists, Training Days, Approvals, Notifications,
Settings, Venues — each fully replaced every run) plus a **Log** tab with one row per run (time, status, rows per
table, and what was added / removed / changed since the previous backup, with names).

**Why it is safe:** the app never talks to the Sheet. Supabase's scheduler calls the function with a secret, the
function writes to the Sheet through a Google *service account* (a robot account that can open only the Sheets you
share with it), and it never sends data back to whoever called it. `kv_cache` (which holds the login-token secret)
is never backed up.

1. **Google Cloud** (console.cloud.google.com, any Google account): create a project → *APIs & Services → Library*
   → enable **Google Sheets API** → *IAM & Admin → Service Accounts* → **Create service account** (no roles needed)
   → open it → *Keys → Add key → JSON*. A `.json` file downloads — keep it private, never put it in the repo.
2. **Google Sheet:** create an empty Sheet, click **Share**, add the service account's email (the
   `client_email` inside the .json, ends in `.iam.gserviceaccount.com`) as **Editor**. Copy the Sheet id from its
   URL: `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`.
3. **Secrets** (Dashboard → Edge Functions → Secrets):
   | Secret | Value |
   |---|---|
   | `GOOGLE_SERVICE_ACCOUNT` | the whole contents of the .json key file |
   | `BACKUP_SHEET_ID` | the Sheet id from step 2 |
   | `BACKUP_SECRET` | a long random string you make up (e.g. two UUIDs joined) |
4. **Deploy** a new Edge Function named exactly `backup` with the code of `functions/backup/index.ts`
   (Dashboard → Edge Functions → Deploy a new function → via editor), or `supabase functions deploy backup`.
5. **Schedule it:** open [`backup.sql`](backup.sql), replace `<BACKUP_SECRET>` (same value as step 3) and
   `<ANON_KEY>` (from `assets/js/config.js`), paste it in the SQL Editor → **Run**. It runs every hour on the hour.
   To test right away, run the "Run a backup right now" lines at the bottom of `backup.sql`; within a few seconds
   the Sheet gets its tabs and the Log its first row ("First backup").

If a run fails, the Log gets a **FAILED** row with the reason (e.g. the Sheet isn't shared with the service account).
