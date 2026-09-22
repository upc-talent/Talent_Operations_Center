# Talent Operations Center — project handoff

Everything a new developer (human or AI agent) needs to continue this project.
**No secrets are in this file** — the trainer login and database credentials live only in the Supabase
Edge Function secrets (ask the owner).

---

## 1. What this is

A web tool for **United Pharmacy (UPC) — Talent Management** that coordinates pharmacist training between
**supervisors** and the **training team (trainers)**.

- **Supervisors** pick their name, then assign each of their pharmacists to a training day or record a status
  (Sick Leave / Annual Leave / Resignation / Promotion), request new pharmacists and annual leave (both need
  trainer approval), and see notes about their pharmacists.
- **Trainers** (behind a login) mark attendance (Attended/Absent, On Time/Late + arrival time, notes), manage the
  roster and training days, approve requests, see analytics, and export Excel/PNG/PDF.
- Data lives in **Supabase Postgres**; a single **Edge Function** (`api`) is the backend; the front end is static
  files on **GitHub Pages**.

**Owner:** muhammed.zaghloul237@gmail.com. Working dir on the owner's PC: `D:\Work\UPC\Sync Training`.

**History:** it began as a single 2.2 MB HTML artifact, was split into pages backed by a Google Sheet, and was
later migrated off Google Sheets entirely onto Supabase for speed. The Sheet is no longer involved in any way.

---

## 2. Repository layout

```
index.html            Landing: Supervisor · Course Progress Reports (external) · trainer icon (bottom-right)
supervisor.html       Supervisor page (no login; pick your name)
trainer.html          Trainer page: sign-in form first, app hidden until a valid token exists
assets/
  css/app.css         All styles
  img/logo.png        Default header logo (a logo uploaded in Trainer>Setup overrides it)
  vendor/             xlsx.full.min.js, jszip.min.js, html2canvas.min.js, jspdf.umd.min.js
  js/config.js        ONLY place for URLs: Supabase URL + anon key, COMPLETION_REPORTS_URL, LINKS
  js/api.js           Backend client + storage adapter (getShared/setShared) — see §4
  js/common.js        Shared helpers (formatting, colours, filters, sort, modals, exports, capacity,
                      loadCoreData, bulk-selection framework, optimistic saveShared)
  js/supervisor.js    Supervisor logic + page startup
  js/trainer.js       Trainer logic (setup, attendance, approvals, analytics, calendar) + sign-in + startup
supabase/
  schema.sql          The database: tables, indexes, RLS lockdown
  functions/api/      The Edge Function (TypeScript/Deno) — all reads, writes and auth
  README.md           Setup + redeploy runbook, performance notes
dev/serve.ps1         Tiny static server (PowerShell HttpListener) — the PC has NO Node or Python
docs/PROJECT_HANDOFF.md   this file
README.md             Overview, data model, security model
```

The JS files are **classic scripts sharing globals** (~170 inline `onclick="fn()"` handlers), not ES modules.
Load order per page: vendor libs → `config.js` → `api.js` → `common.js` → page script.

---

## 3. Database (Supabase Postgres)

Project ref `aoqgabdsayaqgqroscdw`. Schema in `supabase/schema.sql`.

| Table | Content |
|---|---|
| `pharmacists` | The roster, one row per person. Master columns + `assignment` / `attendance` (`jsonb`) + `note`, `completion_pct`. |
| `training_days` | One row per day; the whole day object lives in `data` (`jsonb`). |
| `approvals` | `New Pharmacist` / `Annual Leave` / `Over-Quota Decision` rows; columns for filtering, full record in `data`. |
| `notifications` | Approval results shown to supervisors. |
| `settings` | `key` → `value` (`jsonb`): maxCapacity, trainerNames, coordinatorNames, trainingNames, completionCourse, completionLastSynced, logo. |
| `venues` | `city` → recommended venue, offered in Add/Edit Training Day. |
| `kv_cache` | Small expiring key/value store (login lockout counter, generated token secret). |

**Every table has RLS enabled with no policies** → the public anon key can read/write nothing. Only the Edge
Function touches the data, using the service-role connection. Indexes: `supervisor`, and an expression index on
`(assignment->>'dateId')` which the seat-count query relies on.

ID prefixes: `ph_` pharmacist, `day_` training day, `lr_` leave request, `ntf_` notification, `qh_` over-quota decision.

---

## 4. Front-end ↔ backend contract

### Storage adapter (`api.js`)
The app calls `getShared(key, fallback)` / `setShared(key, value)`. `getShared` fetches `{records, settings}`,
remembers a **snapshot**, and returns the old-style value; `setShared` **diffs against the snapshot and sends only
changed records** (`patch`) — this is what prevents "two people save → last one wins" data loss. No prior snapshot
⇒ only adds/updates, never deletes. `peekSnapshot(key)` is used by undo history.

**Saves are optimistic**: the caller updates the screen first, then `saveShared(key, getValue)` persists in the
background, coalescing rapid changes into as few requests as possible. If a save fails, `APP_HOOKS.onSaveFailed`
reloads the true state and re-renders, which reverts the optimistic change.

Keys → shapes: `master-pharmacists`, `pending-pharmacists`, `leave-requests`, `quota-approval-history`,
`pharmacist-notifications` are arrays of `{id,…}`; `operations` =
`{assignments:{pid:{type:'date'|'leave',…}}, attendance:{pid:{status,punctuality,time,note,day1,day2,…}}}`
(wire form `{pid:{a,t}}`); `training-config` = `{dates:[…], maxCapacity, trainerNames, coordinatorNames,
trainingNames, completionCourse, completionLastSynced}`; `company-logo` = data-URL string.

### HTTP API (`POST` JSON to the Edge Function, with the anon key in the headers)
`{action, token?|supervisor?, …}` →
`login{username,password}` · `supervisors` (names list, public) · `get{key}` · `getMany{keys}` ·
`patch{key,records,settings}` · `venues` (trainer) · `me`. `get company-logo` is public.
Every response includes `_ms`, the server's own execution time.

### Auth & authorization (server-side; the URL and anon key are public by nature of a static site)
- **Trainer:** username/password compared to the `TRAINER_USER` / `TRAINER_PASS` secrets; returns an HMAC-signed
  token (`TOKEN_SECRET`), TTL 10 h, kept in `sessionStorage`. 8 failed logins in 10 min lock login for 10 min.
- **Supervisor:** picks a name (no password), validated by an indexed lookup. Server limits reads to that
  supervisor's own pharmacists (no phone/SCFHS) and scopes approvals/notifications; other supervisors' ops rows
  are reduced to `{type:'date',dateId}` (seat counts only).
- **Supervisor writes are re-validated server-side** (`patchOps` / `validateSupervisorAssignment`): pharmacist
  ownership, day visible/active, online↔offline match, deadline, capacity, per-supervisor quota (recomputed —
  a forged `quotaApproved` is ignored), leave-status allow-list, no attendance writes.
- **Trainer-only:** master roster, training-config/days, settings, logo, quota history, approvals, attendance.
- Writes that move someone between days run in a transaction holding a Postgres advisory lock, so capacity stays
  correct under concurrency. Attendance-only writes skip the lock (they can't overbook).

---

## 5. Business rules worth knowing

- Capacity per day (default 30, `settings.maxCapacity`, optional per-day override). Trainers may exceed capacity
  after a confirm; supervisors may not.
- Supervisor deadline per day (disables assignment after the date/time).
- **Per-supervisor quotas work on any day — in-person or online.** Beyond quota, an assignment is *pending* and
  needs trainer approval (Trainer → Approvals → over-quota).
- Online days (city `Online`, "Mix n"): default **split = 2 days** (no Friday start) or full-day.
- Split attendance: Day 2 can't be Attended unless Day 1 was; Absent on Day 1 auto-marks Day 2 Absent; one
  attended day ⇒ `Partial` (make-up).
- New pharmacists and Annual Leave requests are submitted by supervisors and **only take effect on trainer
  approval** (bulk-add and annual-leave Excel templates exist).
- City colours/codes: JED N/S = blue, JAZ/BAH/ABH/TAIF = green, MAD/MEC = yellow, RUH/EAST = purple, Online = grey.
- **Bulk actions**: checkboxes on the trainer Records table, the trainer Days table and the supervisor table.
  Pharmacists → Assign to a day / set a leave status / unassign (+ trainer-only delete from roster).
  Days → Hide / Unhide / Delete. Anything that doesn't fit (wrong online/offline type, day full) is skipped and
  reported; selections prune to what's visible when filters change.

### Training days / calendar
Days are created in the app, or imported in bulk from a planning spreadsheet via **Trainer → Calendar → Import
Calendar** (parsed in the browser by `parseCalendarAoa`, then saved like any other config change).
- **Identity = the code** (`JED N 1`, `RUH 3`, `MIX 4`, normalised `JEDN1`; repeats get `#2`), so re-importing
  updates the same day instead of duplicating it, and everything set in the app is preserved.
- A day block is at most **5 columns wide** so the summary tables to the right of the grid aren't read as trainings.
- A `MIX n` appears under **both** of its two days in the grid → keep day 1 only.
- Ignored (not pharmacist trainings): `Salaries`, `Saudi National Day`, `CC`, `Re-Training`, `Learning Booster`, `Ams & SVs`.

---

## 6. Performance design (why it is fast)

- **Rendering:** the trainer table's row template is one shared function; an attendance change refreshes only that
  row (`updateTrainerRow`), not all ~1,450. Day dropdowns render one option and fill the full list on first open.
  `dayById` replaces repeated linear scans.
- **Saving:** optimistic + coalesced (see §4), so a click never waits on the network.
- **Server:** writes read only the rows they touch; seat counts come from a `GROUP BY` limited to the days
  involved; trainer/attendance writes skip the capacity machinery entirely; bulk writes are one statement.
  See `supabase/README.md` → *Performance notes*.
- **Measuring:** open any page with `?debug=1` to log round-trip vs server time per request.

---

## 7. Known issues and limits

- Analytics buckets don't sum: people assigned but not yet marked, and split "Partial" attendees, appear in no bucket.
- Undo/Redo covers training-config only; deleting a day also wipes its assignments and attendance (not restorable).
- Re-uploading the roster replaces everyone with **new ids** (assignments/approvals for the old ids are lost).
  Notes are preserved only if the Excel has a `Notes` column.
- Days for cities with no pharmacists have no supervisor until pharmacists exist (or "Visible to" is set by hand).
- Supervisors have no password (name picker only). Optional next step: per-supervisor access codes. The trainer
  login is one shared credential ⇒ no per-trainer audit (`markedBy` is empty).
- Login lockout is global (an attacker can lock the trainers out for 10 min).
- Notes are visible to supervisors — by design, but sensitive notes are exposed to them.
- Deadline comparison uses the browser's clock against the stored ISO timestamp.
- A free Supabase project pauses after 7 days of inactivity (one-click resume).

**Ideas not built**: per-supervisor codes / per-trainer accounts, fixing analytics buckets, realtime live-sync
(Supabase supports it), ES-module refactor, automated tests.

---

## 8. How to run, test and deploy

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
```
Open `http://localhost:5173/`. It talks to the **live Supabase backend** — there is no offline mock any more
(the old one emulated Google Sheets, which no longer exists). Use a throwaway supervisor/day when testing writes.

**Deploying a change:**
- Front end → commit/push (GitHub Pages: branch `main`, root).
- Backend → paste `supabase/functions/api/index.ts` into the `api` function and **Deploy**
  (or `supabase functions deploy api`). See `supabase/README.md`.
- The two are independent; the wire protocol only changes if a data key is added.

---

## 9. Gotchas for whoever continues

- The owner's Windows PC has **no Node/Python/Deno**; use PowerShell (`dev/serve.ps1`). Git is installed but the
  owner pushes to GitHub themselves.
- Never commit real roster/attendance exports (`*.xlsx` are git-ignored).
- Table column order must stay in sync between the `<thead>` in the HTML and the row template in the JS
  (header cell count = body cell count, including the bulk-select checkbox column).
- Keep `esc()` around every value interpolated into HTML.
- Any new field on a pharmacist needs adding in three places: the `schema.sql` column, the Edge Function's
  `getMaster`/`patchMaster`, and the front-end master shape.
- The Edge Function can't be type-checked on the owner's PC (no Deno) — review carefully, deploy, then exercise
  the supervisor path (it needs no password) to smoke-test reads *and* writes.
