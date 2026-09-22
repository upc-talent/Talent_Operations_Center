# Talent Operations Center

Coordinates training schedules between supervisors and the Talent Management training team.
Static front-end (GitHub Pages) + a **Supabase** backend (Postgres behind an Edge Function).

```
index.html            Landing page: Supervisor · Course Progress Reports · (trainer icon, bottom-right)
supervisor.html       Supervisor page (pick your name → assign pharmacists, request additions/leave)
trainer.html          Trainer page — behind a sign-in (attendance, setup, approvals, analytics, calendar)
assets/js/config.js   Every URL lives here (backend, LMS reports)
assets/js/api.js      Backend client — sends only the records that changed
assets/js/common.js   Helpers shared by both pages
supabase/schema.sql   The database (run once)
supabase/functions/   The `api` Edge Function — all reads/writes and all auth go through it
dev/serve.ps1         Local static server
```

## 1. Backend setup

See **[supabase/README.md](supabase/README.md)** for the full runbook: create the tables, set the
secrets (`TRAINER_USER`, `TRAINER_PASS`, `TOKEN_SECRET`, `DB_URL`), and deploy the `api` function.

## 2. Data model

| Table | Purpose |
|---|---|
| `pharmacists` | The roster. Master fields plus `assignment` / `attendance` (JSON) per person. |
| `training_days` | One row per training day; the full day object lives in `data`. |
| `approvals` | New-pharmacist, Annual-Leave and over-quota records (live + history). |
| `notifications` | Approval results shown to supervisors. |
| `settings` | Capacity, trainer/coordinator/training-name lists, logo. |
| `venues` | `city` → recommended venue, offered when adding a training day. |

Everything is edited **through the app** — it is the only thing that writes to the database.
Exports (Excel / image / PDF) are produced in the browser and always contain every filtered row.

**Training days** are created in the app (Trainer → Calendar → *Add Training Day*), or imported in bulk from a
planning spreadsheet via **Trainer → Calendar → Import Calendar**. Each entry is recognised by its **code**
(`JED N 1`, `RUH 3`, `MIX 4`…), so re-importing updates the same day instead of duplicating it, and everything you
set in the app (visible-to, quotas, capacity, deadline, venue, coordinator) is kept. Cells that aren't trainings
(`Salaries`, holidays, `Re-Training`, `Learning Booster`, `Ams & SVs`, `CC`) are ignored.

**Per-supervisor quotas** can be set on **any** training day — in-person or online. Once a supervisor reaches
their quota for a day, further assignments they make are held as *Pending quota approval* until the trainer
approves them (Trainer → Approvals).

## 3. Run locally

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
```

Then open `http://localhost:5173/`. It talks to the live Supabase backend.
Add `?debug=1` to any page to log, per request, the round-trip vs. server time in the console.

## 4. Publish on GitHub Pages

Push this folder, then *Settings → Pages → Deploy from a branch → `main` / root*.
**Never commit real roster exports** (`.gitignore` already blocks `*.xlsx`).
GitHub Pages serves only the static front-end — the backend stays in Supabase.

## 5. Security model (read this)

- The backend URL and the Supabase **anon key** are visible to anyone who opens the site's source — that is
  unavoidable for a static site. They are not what protects the data:
  - **Row-Level Security is on for every table with no policies**, so the anon key can read and write
    *nothing* directly. Only the `api` Edge Function touches the database.
  - **Trainer actions** need a signed, expiring (10 h) token issued only after `TRAINER_USER`/`TRAINER_PASS`
    match. 8 failed sign-ins in 10 minutes lock sign-in for everyone for 10 minutes.
  - **Supervisor requests** are limited to that supervisor's own pharmacists (no phone/licence numbers), and the
    server re-checks every change: pharmacist ownership, training-day visibility, deadline, capacity, and
    per-supervisor quota. Supervisors cannot record attendance, approve anything, or touch setup data.
  - Supervisors still pick their name from a list (no password) — anyone who knows the URL can act as any
    supervisor *within those limits*. If that is not acceptable, add a per-supervisor access code next.
- The trainer credential is shared by the whole training team, so attendance "marked by" is not recorded per person.

## 6. Known limitations

- Analytics buckets don't add up when someone is assigned but not yet marked.
- Undo/Redo covers training-day/config changes only.
- A free Supabase project pauses after 7 days of inactivity (one-click resume) — see the runbook.
