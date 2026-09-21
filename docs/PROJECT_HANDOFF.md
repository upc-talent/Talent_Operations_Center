# Training Operations Hub — project handoff

Everything a new developer (human or AI agent) needs to continue this project. Written at the end of the first build
session. **No secrets are in this file** — the trainer login lives only in the Apps Script *Script Properties* (ask the owner).

---

## 1. What this is

A web tool for **United Pharmacy (UPC) — Talent Management** that coordinates pharmacist training between
**supervisors** and the **training team (trainers)**.

- **Supervisors** pick their name, then assign each of their pharmacists to a training day or record a status
  (Sick Leave / Annual Leave / Resignation / Promotion), request new pharmacists and annual leave (both need trainer approval),
  and see notes about their pharmacists.
- **Trainers** (behind a login) mark attendance (Attended/Absent, On Time/Late + arrival time, notes), manage the roster and
  training days, approve requests, see analytics, and export Excel/PNG/PDF.
- Data lives in a **Google Sheet**; a **Google Apps Script** web app is the backend; the front end is static files on **GitHub Pages**.

**Origin:** it started as a single 2.2 MB HTML file (`training-scheduler-v16.html`, a Claude *artifact* that used the artifact-only
`window.storage`), ~3,600 lines of vanilla JS + bundled libraries. That file is *not* in this repo (it lived in
`D:\Work\UPC\Omar Tool\`, next to `Q4 Full Attendance (1).xlsx` and `Q4 Calendar V10.3.xlsx`, the spreadsheets it replaces).
This project splits it into pages and moves storage to Google Sheets.

**Owner:** muhammed.zaghloul237@gmail.com (owns the Google Sheet). Working dir on the owner's PC: `D:\Work\UPC\Sync Training`.

---

## 2. Status at handoff

Built, tested in a browser against a fake spreadsheet (the real `Code.gs` runs against it — see §9), and the owner has deployed
and used it on the live sheet (sign-in, loading pharmacists, calendar, GitHub Pages site all worked).
**Confirm with the owner** that the *latest* `Code.gs` (auto calendar-sync, header-driven columns, Attendance Adherence, Notes) is
pasted into Apps Script and re-deployed — the last few features were tested only against the fake sheet.

Not verified against the real Google runtime: the newest `Code.gs` paths (header-based column detection/migration, calendar auto-sync).
If something misbehaves, run `checkSetup` in the Apps Script editor first — it logs which column was found for each field.

---

## 3. Repository layout

```
index.html            Landing: 2 cards (Supervisor → supervisor.html; Course Progress Reports → external, new tab) —
                      the LMS Ticketing card was removed on request (link kept commented in config.js) — + small trainer icon (bottom-right) → trainer.html
supervisor.html       Supervisor page (no login; pick your name)
trainer.html          Trainer page: sign-in form first, app hidden until a valid token exists
assets/
  css/app.css         All styles (original CSS + landing/login/notes additions at the end)
  img/logo.png        Header logo (default). A logo uploaded in Trainer>Setup is stored in the sheet and overrides it
  vendor/             xlsx.full.min.js, jszip.min.js, html2canvas.min.js, jspdf.umd.min.js (extracted from the old file)
  js/config.js        ONLY place for URLs: backend API_URL, COMPLETION_REPORTS_URL, LINKS (reports + ticketing); ?mock=1 switch
  js/api.js           Backend client + storage adapter (getShared/setShared) — see §5
  js/common.js        Helpers shared by both pages (formatting, colours, filters, sort, modals, exports, capacity, loadCoreData…)
  js/supervisor.js    Supervisor logic + page startup
  js/trainer.js       Trainer logic (setup, attendance, approvals, analytics, calendar) + sign-in + page startup
backend/
  Code.gs             Apps Script backend (paste into the Sheet's Apps Script project)  ← ~1,250 lines
  appsscript.json     Manifest: time zone Asia/Riyadh, web app executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS
dev/
  serve.ps1           Tiny static server (PowerShell HttpListener) — the PC has NO Node or Python
  mock-backend.js     Fake Google services + synthetic data; loads and runs the REAL backend/Code.gs in the browser
  fixtures/calendar-grid.json   The real calendar tab as a grid (used to test the parser)
docs/PROJECT_HANDOFF.md   this file
README.md             Setup / sheet structure / security model
.gitignore            blocks *.xlsx/*.csv (personal data), .claude/
.claude/launch.json   (git-ignored) preview-server config used by the AI tooling
```

The JS files are **classic scripts sharing globals** (the old code uses ~170 inline `onclick="fn()"` handlers), not ES modules.
Load order per page: vendor libs → `config.js` → `api.js` → `common.js` → page script.

---

## 4. Google Sheet (database)

Spreadsheet ID: `1WPFKNeJlbAevuRL7DmKqhMWu4cynUoY7Tjp7mAIhK8U` (in `CONFIG.SPREADSHEET_ID`, `Code.gs`).
Apps Script is the Sheet's own project (Extensions → Apps Script), deployed as a **Web App: Execute as Me, access Anyone**.
The deployed URL is in `assets/js/config.js` (`API_URL`); after editing `Code.gs` you must **Deploy → Manage deployments → edit → New version**
(the URL then stays the same).

| Tab | Content | Written by |
|---|---|---|
| **HeadCount** | Master roster, one row per pharmacist (~190 rows so far: Riyadh, Online, 8 "Supervisors") | roster: trainer via app; some columns by app |
| **2026 - Q4 Training Calendar** | Human planning grid (merged cells) → auto-synced into TrainingDays | the owner, by hand |
| **Venues** | `City` / `Recommended Venues` (offered in Add/Edit Training Day; trainer-only read) | owner |
| **Approvals** | Requests + decisions (9 cols: ID, Type, Status, Supervisor, Pharmacist, Submitted At, Decided At, Reason, Data(system, hidden)) | app |
| **TrainingDays** | Normalised training days (15 cols; col O `Data (system)` JSON is the source of truth) | app |
| **Notifications** | Approval results shown to supervisors (8 cols) | app |
| **Settings** | `Key` / `Value (JSON)`: maxCapacity, trainerNames, coordinatorNames, trainingNames, completionCourse, completionLastSynced, logo, calendarHash, calendarSyncedAt | app |

### HeadCount columns — found by HEADER TEXT, never by position
(Lesson learned: the owner inserted a column, which broke the original position-based version. `initHCLayout_()` maps headers → column numbers,
adds missing helper columns at the far right, adopts an unlabeled column of `ph_…` ids as "Pharmacist ID", adopts unlabeled JSON
columns as the system columns, and `readHC_()` repairs ids that ended up in the Notes column.)

| Header | Meaning / writer |
|---|---|
| District, Area Manager, City, Supervisor Name, Pharmacy No., User/Employee ID, Username (Email), Display Name (Pharmacist name), Phone number (Whatsapp), SCFHS | roster (owner / trainer roster upload) |
| **Date** | app: the training day label (`5 October 26`, split online `5 - 6 October 26`) or the leave status; blank while an over-quota assignment awaits approval |
| **Attendance Status** | app: `Attended` / `Absent` / `Partial (Day n missing)` / leave status |
| **Attendance Adherence** | app: `On Time` or `Late` when marked Attended (split online: Late if either attended day was late) |
| **Notes** | the owner / trainer's Notes box. **Shown to the pharmacist's supervisor.** The app never overwrites it |
| Pharmacist ID | app-generated `ph_…` id (stable key for everything) |
| Session | app: `City — date` text (or `Pending quota approval — …`) |
| Arrival Time | app: late arrival time (split: `Day1: 09:10 / Day2: …`) |
| Completion % | roster upload / LMS sync |
| Assignment (system), Attendance (system) | hidden JSON — the app's source of truth per row. **Edits to Date/Status/Adherence by hand are overwritten** when the row changes |

ID prefixes: `ph_` pharmacist, `day_` training day, `lr_` leave request, `ntf_` notification, `qh_` over-quota decision, `oq_<pid>` live over-quota mirror row in Approvals.

---

## 5. Front-end ↔ backend contract

### Storage adapter (`api.js`)
The old code calls `getShared(key, fallback)` / `setShared(key, value)` (read-modify-write of whole JSON blobs). These are kept, but:
`getShared` fetches `{records, settings}` from the server, remembers a **snapshot**, and returns the old-style value; `setShared` **diffs against the
snapshot and sends only changed records** (`patch`), which fixed the old "two people save → last one wins" data-loss bug.
No prior snapshot ⇒ only adds/updates, never deletes. `peekSnapshot(key)` is used by undo history so a save doesn't refresh the snapshot.
Failed saves toast the server's message and call `APP_HOOKS.onSaveFailed` (supervisor page re-loads its view).

Keys → shapes: `master-pharmacists`, `pending-pharmacists`, `leave-requests`, `quota-approval-history`, `pharmacist-notifications` are arrays of `{id,…}`;
`operations` = `{assignments:{pid:{type:'date'|'leave',…}}, attendance:{pid:{status,punctuality,time,note,day1,day2,…}}}` (wire form `{pid:{a,t}}`);
`training-config` = `{dates:[…], maxCapacity, trainerNames, coordinatorNames, trainingNames, completionCourse, completionLastSynced}`; `company-logo` = data-URL string.

### HTTP API (`doPost`, JSON body sent as text/plain to avoid CORS pre-flight)
`{action, token?|supervisor?, …}` →
`login{username,password}` · `supervisors` (names list, public) · `get{key}` · `patch{key,records,settings}` · `calendarGrid` (trainer) ·
`syncCalendar` (trainer, forces sync) · `venues` (trainer) · `me`. `get company-logo` is public. `doGet` = health check only.

### Auth & authorization (server-side; the URL is public by nature of a static site)
- **Trainer:** username/password compared to Script Properties `TRAINER_USER` / `TRAINER_PASS`; returns an HMAC-signed token (secret auto-created in `TOKEN_SECRET`), TTL 10 h, kept in `sessionStorage`. 8 failed logins in 10 min lock login for everyone for 10 min.
- **Supervisor:** picks a name (no password). Server limits reads to that supervisor's own pharmacists (no phone/SCFHS) and scopes approvals/notifications; ops for others are reduced to `{type:'date',dateId}` (only for seat counts).
- **Supervisor writes are re-validated on the server** (`patchOps_`/`validateSupervisorAssignment_`): pharmacist ownership, day visible/active, online↔offline match, deadline (script time zone), capacity, per-supervisor quota (recomputed, forged `quotaApproved` ignored), leave statuses allow-list, no attendance writes. Pending requests can only be created as `Pending` for their own name.
- **Trainer-only:** master roster, training-config/days, settings, logo, quota history, approvals decisions, attendance.
- All writes run under `LockService`; capacity counts come from the current sheet state.

---

## 6. Behaviour worth knowing (business rules kept from the original)

- Capacity per day (default 30, `Settings.maxCapacity`, optional per-day override). Trainers may exceed capacity after a confirm; supervisors may not.
- Supervisor deadline per day (disables assignment after the date/time).
- Online days (city `Online`, "Mix n"): default **split = 2 days** (no Friday start) or full-day; per-supervisor **quotas** — beyond quota an assignment is *pending* and needs trainer approval (mirrored in Approvals as `Over-Quota Request`; Date column stays blank until approved).
- Split attendance: Day 2 can't be Attended unless Day 1 was; Absent on Day 1 auto-marks Day 2 Absent; one attended day ⇒ `Partial` (make-up).
- New pharmacists and Annual Leave requests are submitted by supervisors and **only take effect on trainer approval** (bulk-add and annual-leave Excel templates exist).
- City colours/codes: JED N/S = blue, JAZ/BAH/ABH/TAIF = green, MAD/MEC = yellow, RUH/EAST = purple, Mix/Online = grey.
- Trainer table Notes box now edits the HeadCount **Notes** column for any pharmacist (not only assigned ones).

### Calendar → training days (automatic; the owner's request: "no manual import")
`autoSyncCalendar_()` runs whenever `training-config` is read (throttled to once per 45 s via CacheService; skipped if the grid hash in `Settings.calendarHash` is unchanged).
`parseCalendar_()` (port of the old client parser, plus fixes) reads the grid: date header cells (`Mon 21 Sep`, space optional — `Mon14 Dec` exists), the row below = codes, the row below that = trainers.
- **Identity = the code** (`JED N 1`, `RUH 3`, `MIX 4`, normalised `JEDN1`, repeats get `#2`): new code → new day; moved code → same day, new date (assignments follow); removed code → `active:false, removedFromCalendar:true` (never deleted); reappearing → re-activated.
- A day block is at most **5 columns wide** (`MAX_DAY_COLS`) — the summary tables to the right of the grid must not be read as trainings (a real bug that was fixed).
- A `MIX n` appears under **both** of its two days in the grid → keep day 1 only (same code within 1–3 days ⇒ duplicate).
- Ignored (not pharmacist trainings): `Salaries`, `Saudi National Day`, `CC`, `Re-Training`, `Learning Booster`, `Ams & SVs`.
- Visible supervisors are auto-filled by **city code** (`cityCode_` mirrors the front-end `cityCodeFor`); Mix days → supervisors who have `Online` pharmacists. Recomputed on later syncs only while a day has no supervisors. Trainer names in the grid are added to the roster; a trainer changed manually in the app isn't overwritten (`calendarTrainer` remembers the last synced one). Everything else set in the app is preserved. Hand-made days (no `calendarCode`) are untouched.
- Trainer page → Calendar → **Calendar Sync** forces a re-read and shows a summary. An *Excel upload* fallback still exists (same identity code, idempotent).
- Real calendar result: **55 days = Mix 1–16 + 39 city days**, matching the planning table inside the sheet.

---

## 7. Decisions made with the owner

- Three pages (home / supervisor / trainer). Trainer credentials `UPC_TMD` + a password the owner chose — **stored server-side in Script Properties, deliberately not in the repo** (public GitHub). Ask the owner.
- The Apps Script URL cannot be "hidden" on a static site; protection is enforced on the server (see §5). It sits in one file, `config.js`.
- "Course Progress Reports" card → `https://upc-talent.github.io/LMS-reporting/` (new tab). "LMS Ticketing System" → the ClickUp form `https://forms.clickup.com/90152546261/f/2kyr5byn-5335/DH1J7W33E380VYJM8C` (new tab).
- The old embedded *Completion Reports* dashboard was removed. The optional Trainer > Setup > **Sync completion % from the LMS reports source** still calls the *old* Apps Script (`COMPLETION_REPORTS_URL`, actions `meta`/`course`, matched by email).
- Kept the trainer logo-upload feature (downscaled to fit a cell, stored in Settings); `assets/img/logo.png` is the default.
- "Share Direct Links" card and the role picker were removed (each role has its own page).

---

## 8. Known issues, limits and open items

**Security / ops**
- The Google Sheet was found shared as **"Anyone with the link can edit"** (Drive permissions). That bypasses every app rule. It must be **Restricted** — confirm the owner did this.
- Supervisors have no password (name picker only). Optional next step: per-supervisor access codes. The trainer login is one shared credential ⇒ no per-trainer audit (`markedBy` is empty; the old trainer-identity dropdown is dead code).
- Notes are visible to supervisors — fine for the owner's request, but sensitive notes ("legal problem…") are exposed to them by design.
- Login lockout is global (an attacker can lock the trainers out for 10 min).

**Behaviour**
- Analytics buckets don't sum: people assigned but not yet marked, and split "Partial" attendees, appear in no bucket (inherited from v16).
- Undo/Redo covers training-config only; deleting a day also wipes its assignments and attendance (not restorable).
- Re-uploading the roster replaces everyone with **new ids** (assignments/approvals for the old ids are lost). Notes are preserved only if the Excel has a `Notes` column.
- Days for cities with no pharmacists in HeadCount have no supervisor until pharmacists exist (or "Visible to" is set by hand).
- If only one day of a two-day Mix block is moved in the grid, the app sees a second training (`MIX n#2`).
- Deadline compare uses the **script time zone** (`Asia/Riyadh` in the manifest) vs the browser's local time.
- Apps Script latency is ~1–3 s per call; each action does several calls. First load after a calendar change is slower (sync runs inline).
- The old build wrote values by column position after the owner inserted a column: the owner may still have **unlabeled leftover columns** (e.g. old Punctuality text) — safe to delete after checking.
- Duplicate-email checks for new pharmacists on the supervisor side now only see the supervisor's own people.

**Ideas not built**: per-supervisor codes / per-trainer accounts, fixing analytics buckets, importing `Re-Training` / `Ams & SVs` as event types, ES-module refactor, automated tests, a scheduled trigger for calendar sync, restoring assignments on undo-delete.

---

## 9. How to run and test

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
```
Open `http://localhost:5173/?mock=1` → the real `Code.gs` runs inside the browser against a synthetic sheet (stored in `localStorage`);
trainer login `demo` / `demo`. `?mock=0` returns to the live backend. `MockBackend.dump()` shows the fake sheet, `MockBackend.setup()` = run `setupSheets`,
`MockBackend.reset()` wipes it. The fake sheet mimics the owner's real layout (Attendance Adherence in M, Notes in N, unlabeled ids in O).

Test scenarios that were run (all passed): trainer login/lockout; forged/tampered tokens; supervisor scoping (own rows only, no phone/SCFHS); capacity, deadline, quota and forged
`quotaApproved`; concurrent saves to different rows both kept; bulk roster add/delete/update; approvals (new pharmacist, leave, over-quota) incl. forged "Approved" request;
attendance single + split → Date/Status/Adherence/Session/Arrival columns; note edit; calendar parse of the real grid (55 days); move/remove/re-add/trainer change on the calendar;
re-import idempotency; header-driven column migration incl. polluted Notes and orphaned JSON columns; logo shrink round-trip; console clean on all pages.
`dev/fixtures/calendar-grid.json` is the parser's regression fixture (expected: 55 days, Mix 1–16, cities Jeddah N 6, Jeddah S 6, Jazan 2, Taif 5, Madinah 3, Riyadh 4, Abha 3, Al Bahah 2, Mecca 5, Eastern 3).

**Deploying a change:** front end → commit/push (GitHub Pages: branch main, root). Backend → paste `backend/Code.gs` into Apps Script, save, run `setupSheets` (idempotent), Deploy → New version.
Script Properties needed: `TRAINER_USER`, `TRAINER_PASS` (`TOKEN_SECRET` is created automatically). Time zone: Asia/Riyadh.

---

## 10. Gotchas for whoever continues

- The owner's Windows PC has **no Node/Python**; use PowerShell (`dev/serve.ps1`) or the browser mock. Git is installed but the AI never initialised or pushed the repo — the owner pushes to GitHub themselves.
- Never commit real roster/attendance exports (`*.xlsx` are git-ignored). The fake data in `dev/` is synthetic; `dev/fixtures/calendar-grid.json` contains only the calendar (dates, codes, first names of trainers).
- When editing files with `sed` in Git Bash, backslashes in regexes get lost (a `\s` became `s` once) — prefer proper edit tools and re-read the result.
- `Code.gs` runs in a fresh context per request but `HC` (column layout) is cached per execution; setup resets `HC_LAYOUT_DONE`. Any new HeadCount field must be added to `HC_FIELDS`, not hard-coded by position.
- Text everywhere: the script sets number format `@` on written ranges so phones/ids/times stay strings; JSON columns can hold up to ~49,000 chars per cell (logo limit relies on this).
- Keep `esc()` around every value interpolated into HTML (no XSS was found in the original; keep it that way).

---

## 11. Later changes (after the first handoff)

- **Landing page:** the "LMS Ticketing System" card was removed at the owner's request. The ClickUp form URL is kept as a comment in `assets/js/config.js` for when it comes back.
- **Table column order (owner's request):** every table that lists pharmacists now starts with **Pharmacist Name** (a small grey row number sits in front of it — there is no separate `#` column) then **Email**, then Supervisor, District, Area Manager, City, then the remaining columns. Applies to: Supervisor table, Trainer attendance table, Master Sheet Preview, over-quota / annual-leave / new-pharmacist approval tables, decision history, the supervisor's Submission History, and the Excel exports (supervisor, attendance, master sheet). Column-order lives in `supervisor.html`/`trainer.html` (`<thead>`) and in the row templates in `supervisor.js`/`trainer.js` — keep the two in sync (header count = cell count).
- **Intermittent "Server error (HTTP 404)" toast fixed:** Google Apps Script sometimes answers a valid request with a 404/5xx/HTML page, mostly when several requests arrive at once (the page used to fire 4 parallel loads, each reading the whole HeadCount tab). Now: (1) `loadCoreData()` makes **one** `getMany` request (`Code.gs` `getMany_`, which also shares a single HeadCount read via `HC_MEMO`); (2) `api.js` **retries** temporary failures (network error, HTTP 404/408/429/5xx, non-JSON reply) twice with 0.7 s / 1.8 s back-off — safe because writes are per-record upserts/deletes; application errors (`ok:false`, e.g. wrong password) are never retried; (3) if the deployed script is an older version that doesn't know `getMany`, the client falls back to loading keys one by one.
  Deploying: front end can go first (falls back); redeploy `Code.gs` (New version) to get the single-request load.
