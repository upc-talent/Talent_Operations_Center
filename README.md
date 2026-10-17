# Talent Operations Center

Coordinates pharmacist training between supervisors and the Talent Management training team, and publishes course
completion reports.

- **Front end:** static pages on GitHub Pages.
- **Backend:** **Supabase**, a Postgres database behind one Edge Function.

| Read this | For |
|---|---|
| [docs/FEATURE_CATALOGUE.md](docs/FEATURE_CATALOGUE.md) | Every feature and rule, with IDs |
| [docs/PROJECT_HANDOFF.md](docs/PROJECT_HANDOFF.md) | How it works inside, plus the change history (v3 → v7.5) |
| [docs/LESSONS_LEARNED.md](docs/LESSONS_LEARNED.md) | Trials, errors and fixes — read before changing code |
| [supabase/README.md](supabase/README.md) | Database, secrets, deploying the Edge Functions, backup |
| [docs/Hub_Reports_Integration_Plan.md](docs/Hub_Reports_Integration_Plan.md) | The plan for moving course reports into the Hub (v5) |
| [docs/WORK_SUMMARY.md](docs/WORK_SUMMARY.md) | Sept 2026 history: speed work and the move from Google Sheets to Supabase |

```
index.html                  Landing page: Supervisor · Course Progress Reports · Admins Dashboard (icon, bottom-right)
supervisor.html             Supervisor page (pick your name → book pharmacists, Submit, requests)
trainer.html                Admins Dashboard — sign-in, then the tabs the account is allowed to see
reports.html                Public course progress reports (no sign-in; ?c=<share link> opens one course)
assets/js/config.js         Every URL lives here (Supabase URL + anon key)
assets/js/api.js            Backend client: sessions, permissions, sends only the records that changed
assets/js/common.js         Helpers shared by the pages (filters, exports, modals, attendance rules…)
assets/js/supervisor.js     Supervisor page
assets/js/trainer.js        Admins Dashboard (all staff tabs, sign-in, passwords, Admins Permissions)
assets/js/reports-admin.js  Moodle Reports engine + Reports Configuration (staff)
assets/js/reports.js        Public reports page
assets/vendor/              SheetJS 0.20.3, JSZip, html2canvas, jsPDF
supabase/schema.sql         The database (safe to re-run; upgrade blocks v4 → v7.5 at the end)
supabase/functions/api      The Edge Function — all reads, writes and sign-ins go through it
supabase/functions/backup   Hourly copy of every table to a Google Sheet
dev/serve.ps1               Local static server (the owner's PC has no Node / Python)
dev/password-hash.html      Offline tool that makes the STAFF_ACCOUNTS password hashes
```

## 1. Who uses it

| Who | How they get in | What they do |
|---|---|---|
| Supervisors | Pick their name (no password) | Book their pharmacists on training days, record leave, Submit, Request Change / Data Edit |
| Training team (trainers, coordinators) | Their own account | Attendance, training days, calendar, approvals, analytics, course reports — whatever their permissions allow |
| Superadmin (`UPC_TMD`) | Their own account | Everything, plus the Activity Log and Admins Permissions: per-account switches, display names and sign-in usernames, password resets (generated or typed), new users |
| Anyone with the link | No sign-in | The public course progress reports |

## 2. Data model

| Table | Purpose |
|---|---|
| `pharmacists` | The roster: master fields, `assignment` / `attendance` (JSON), work shift, notes, retraining `history` |
| `training_days` | One row per training day (the full day object in `data`) |
| `approvals` | New pharmacists, annual leave, over-quota, date changes, submissions, group merges, data edits |
| `notifications` | Results shown to supervisors |
| `settings` | Capacity, rosters, training names, city roster, logo, Core / Capsule courses, category colours |
| `venues` | City → recommended venue |
| `kv_cache` | Small expiring store: sign-in lockouts, token secret, presence pings, rate limits, backup state |
| `activity_log` | Every sign-in and change (append-only, superadmin reads it) |
| `courses`, `course_progress`, `course_uploads` | Tracked courses, published completion rows, publish history |
| `report_hidden` | People not in the roster who are hidden from the public reports |
| `staff_accounts` | App side of admin accounts: own password hash, session version, must-change, permissions, app-made users, display name and sign-in username (v7.5) |
| `lms_learners` | Old onboarding data (no longer used) |

Everything is edited **through the app**. Exports (Excel / image / PDF) are made in the browser.

## 3. Run locally

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
```

Open `http://localhost:5173/`.

- **It talks to the live Supabase backend.** Anything that needs new server code only shows after that code is
  deployed.
- Add `?debug=1` to log round-trip vs server time per request (and to run `rpSelfTest()` on the Admins Dashboard).

## 4. Deploy

Follow the checklist in [supabase/README.md](supabase/README.md#deploy-checklist):
1. Run `schema.sql`.
2. Deploy `api`.
3. Deploy `backup`.
4. Push to GitHub, where Pages serves `main` / root.

**Never commit roster exports.** `.gitignore` blocks `*.xlsx`, `*.xls` and `*.csv`, and the old tools in `reference/`.

## 5. Security model

The backend URL and the Supabase **anon key** are visible in the page source; that can't be avoided for a static site.
They are not what protects the data:

- **Row-Level Security is on for every table, with no policies.** The anon key can read and write nothing directly;
  only the `api` Edge Function touches the database.
- **Admin sign-in:**
  - Named accounts, with passwords stored only as PBKDF2 hashes (in `STAFF_ACCOUNTS`, or in `staff_accounts` once
    someone changes their password or is created in the app).
  - 8 wrong tries lock that username for 10 minutes.
  - Tokens last 10 hours, or 6 days with "Keep me signed in".
  - A password change, a reset, a new sign-in username or "Sign out everywhere" ends every other session.
  - After a reset by the superadmin the person must choose their own password before they can do anything else.
  - Switched-off accounts can't sign in.
- **Permissions:** each admin account has per-tab / per-action switches (Admins Permissions). The server checks them
  on every action; the page only hides what is off.
- **Supervisors:**
  - They see only their own pharmacists (no phone / licence numbers).
  - The server re-checks every change: ownership, day visibility, deadline, capacity, quota and locks.
  - They can't record attendance or approve anything.
  - They pick their name without a password, so anyone with the URL can act as any supervisor *within those limits*.
- **Public reports:**
  - Read-only, 30 requests / minute / IP.
  - Only active courses, and only the columns switched on per course.
  - Emails are shown in full when the Email column is on (owner decision).
- **Audit:** every change and sign-in is in the Activity Log and copied hourly to the backup Sheet.

## 6. Known limitations

- Supervisors have no password (name picker only).
- Analytics buckets don't add up when someone is assigned but not yet marked.
- Undo / Redo covers training-day / config changes only.
- Permission changes take effect on the person's next page load.
- Public answers are cached for up to 60 seconds.
- Image / PDF exports of a very long table come out smaller, because browsers refuse huge images; use Excel for those.
- A headcount sheet uploaded on the Attendance tab or the public page lives in that browser tab only; reloading drops it.
- A free Supabase project pauses after 7 days without use (one-click resume).
