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
  js/config.js        ONLY place for URLs: Supabase URL + anon key, LINKS
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
docs/WORK_SUMMARY.md      record of the Sept 2026 changes (what, why, measured results, open items)
README.md             Overview, data model, security model
```

The JS files are **classic scripts sharing globals** (~170 inline `onclick="fn()"` handlers), not ES modules.
Load order per page: vendor libs → `config.js` → `api.js` → `common.js` → page script.

---

## 3. Database (Supabase Postgres)

Project ref `aoqgabdsayaqgqroscdw`. Schema in `supabase/schema.sql`.

| Table | Content |
|---|---|
| `pharmacists` | The roster, one row per person. Master columns + `assignment` / `attendance` (`jsonb`) + `note`, `completion_pct` (Core Completion), `capsule_pct` (Capsule Completion), `work_shift` (Morning Shift / Night Shift, set by the supervisor). |
| `training_days` | One row per day; the whole day object lives in `data` (`jsonb`). |
| `approvals` | `New Pharmacist` / `Annual Leave` / `Over-Quota Decision` / `Date Change` (Request Change) / `Submission` (supervisor pressed Submit) rows; columns for filtering, full record in `data`. |
| `notifications` | Approval results shown to supervisors. |
| `settings` | `key` → `value` (`jsonb`): maxCapacity, trainerNames, coordinatorNames, trainingNames, cityRoster (`[{name, supervisors}]`), completionCourse, completionLastSynced, logo. |
| `venues` | `city` → recommended venue, offered in Add/Edit Training Day. |
| `kv_cache` | Small expiring key/value store (login lockout counter, generated token secret, `presence:<supervisor>` pings for "supervisors online", `backup_state` fingerprints for the backup Log). |

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
`pharmacist-notifications`, `change-requests`, `supervisor-submissions` are arrays of `{id,…}`; `operations` =
`{assignments:{pid:{type:'date'|'leave',locked?,…}}, attendance:{pid:{status,reason?,punctuality,time,note,day1,day2,…}}, shifts:{pid:'Morning Shift'|'Night Shift'}}`
(wire form `{pid:{a,t,s}}`); `training-config` = `{dates:[…], maxCapacity, trainerNames, coordinatorNames,
trainingNames, completionCourse, completionLastSynced}`; `company-logo` = data-URL string.

### HTTP API (`POST` JSON to the Edge Function, with the anon key in the headers)
`{action, token?|supervisor?, …}` →
`login{username,password}` · `supervisors` (names list, public) · `get{key}` · `getMany{keys}` ·
`patch{key,records,settings}` · `venues` (trainer) · `me` · `submit` (supervisor: lock all their choices) ·
`ping` (supervisor heartbeat, every 60 s) · `presence` (trainer: how many supervisors pinged in the last 150 s). `get company-logo` is public.
Every response includes `_ms`, the server's own execution time.

### Auth & authorization (server-side; the URL and anon key are public by nature of a static site)
- **Trainer** *(v4: named accounts — see "v4" at the end)*: username/password compared to the `TRAINER_USER` / `TRAINER_PASS` secrets; returns an HMAC-signed
  token (`TOKEN_SECRET`), TTL 10 h, kept in `sessionStorage`. 8 failed logins in 10 min lock login for 10 min.
- **Admin** (lower access): same sign-in page, credentials in the `ADMIN_USER` / `ADMIN_PASS` secrets; the token
  carries `r:'admin'`. Tabs: Attendance · Calendar (view only) · Analytics & Export
  (Master Sheet Preview only) · General Configurations (Import Completion only). The server lets it read roster /
  operations / days / pending list and write `operations`, `master-pharmacists` and only the four completion-sync
  settings of `training-config` (`ADMIN_SETTING_KEYS`) — everything else is refused.
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
- **Hidden days are hidden from supervisors only.** Trainers still see, edit and assign them (marked "hidden from
  supervisors" in dropdowns; dashed border in the calendar). Supervisors never receive them in their lists.
- **Attended = locked for supervisors.** Once a pharmacist is fully attended (both days for a split online training),
  a supervisor can't change their day/leave status or clear it — enforced in the UI and in `patchOps`
  (`hasAttended`). Trainers can still change it. "Partial" is not locked (a make-up day is still needed).
- **Day labels are numbered per group** in date order (`computeDayLabels` in trainer.js): in-person by city code
  (JED N 1, JED N 2…), online by training name else city (Online QAS 1, Online QAS 2…); a split online training
  counts once; names already ending in a number ("Mix 3") are kept. Display only — nothing is stored.
- **Master Sheet export = upload format.** Analytics & Export → Master Sheet columns (District … SCFHS, Attendance
  Status, Work Shift, Notes) are exactly what General Configurations → Master Pharmacist Data accepts. The upload
  matches each row to an existing pharmacist (email → employee ID → name+supervisor), so they keep their id, day and attendance; duplicate rows are
  skipped; "Date" / "Attendance Status" text is read back into assignments and attendance (blank / "Not Assigned"
  leaves what's recorded). The trainer chooses whether people missing from the file are kept or removed.
  When two days share a city and date, the Date text gets the training name, e.g. `Online — 5 - 6 October 26 (Mix 4)`.
  If a Date text still matches several groups, the upload picks the one the pharmacist's **own supervisor** can see.
- **Same-date groups** (e.g. "Online QAS" for Dr. Islam Jaber and "Online North" for Dr. Mahmoud Sorour, both
  6 - 7 Oct, city "Online") are labelled `Online QAS — 6 - 7 October 26 · Dr. Islam Jaber` in every list
  (`dayGroupText` in common.js). Trainers may still put anyone in any group.
- **Group mix-up check** (Attendance tab banner): lists pharmacists in a group their supervisor can't see and moves
  them, after review, to their supervisor's group on the same date. Rows unticked in the review are remembered per
  browser (`group-fix-ignored`) and not flagged again.
- **Edit Selected** (Attendance tab): tick pharmacists → edit their master details in a grid → review a before/after
  list → Confirm saves (duplicate emails are refused; a brand-new supervisor name is flagged as a possible typo).
- **Submit needs everything filled:** every one of the supervisor's pharmacists (Offline and Online) must have a Date
  or other status AND a Work Shift, or Submit is refused (in the page and in `submitSupervisor`) and the table shows
  only the missing rows. Work Shift: Night = red, Morning = green.
- **No-date lock:** when every day a supervisor can see for a pharmacist's type is not editable for them, a pharmacist
  with no date has the whole Date slot locked, leave statuses included (`noDateSlotLocked` / `supNoDateSlotLocked`).
- **Submit & locks (supervisor).** Choices are free until the supervisor presses **Submit** (`submit` action): every
  pharmacist with a date or leave status gets `assignment.locked`, and a `Submission` row notifies the trainer
  (Approvals tab + badge). Locked pharmacists lose their dropdown; the supervisor asks via **Request Change**
  (`change-requests`, reason required) → trainer approves (applied, still locked) or rejects (supervisor notified).
  Trainer changes keep the lock (`patchOps` carries it over). Exception: a pharmacist who **missed** training
  (Absent, or Partial on a 2-day online training) gets the dropdown back and can be booked onto another visible day
  (the missed day isn't offered); that new pick is free until the next Submit. Work Shift is never locked.
- **Visible vs Editable (per day).** Edit Training Day → Visible to has two columns; Editable defaults to Visible.
  Unticked = `readOnlySupervisors`: the supervisor sees the day but can't put pharmacists on it or move them off it
  (except someone who missed training) — only through Request Change. Enforced in `validateSupervisorAssignment`.
- **Absent reason is optional** (Interaction / Pharmacy / LMS): one click on Absent records it; the reason buttons
  under it add, change or remove `reason` on the attendance (per day for split trainings). Shown as "Absent - LMS" in exports and the supervisor view, and read back by the upload.
- **City Roster** (General Configurations): cities + linked supervisors. "Auto-select by city" and the bulk "City"
  action make a day visible to exactly the linked supervisors (falls back to the old guess when none are linked).
  Renaming a city renames it on training days, not on pharmacists.
- **Cascading filters** everywhere: each filter lists only values present among rows matching the other filters
  (`registerFilterFacets` / `narrowMsOptions` in common.js).
- **Attendance tab date labels** are short: `Online QAS - 11,12 Oct 26` (online: training name, else city;
  in-person: city) — `shortDayText`; a supervisor hint is added only if two days would still read the same.
- **Bulk actions**: checkboxes on the trainer Records table, the trainer Days table and the supervisor table.
  Pharmacists → Assign to a day / set a leave status / unassign (+ trainer-only delete from roster).
  Days → Hide / Unhide / Deadline / Supervisors / Capacity / Trainer · Coordinator / City / Delete (Supervisors and
  Trainer can Add to or Replace what the days have). Anything that doesn't fit (wrong online/offline type, day full) is skipped and
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
- Roster upload keeps existing people's ids (see §5). A person whose email, employee ID *and* name/supervisor all
  changed at once can't be recognised and is treated as new. Blank cells in a mapped column overwrite that field
  (except Notes, which a blank never wipes). Completion % isn't in the file and is kept as is.
- `patchMaster` writes in one transaction with set-based statements, so an upload is all-or-nothing.
- Days for cities with no pharmacists have no supervisor until pharmacists exist (or "Visible to" is set by hand).
- Supervisors have no password (name picker only). Optional next step: per-supervisor access codes.
  (Staff have named accounts and an Activity Log since v4; lockout is per username.)
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

## Later additions (v3)

- **Two completion columns** in the Attendance tab: Core Completion (`completion_pct`) and Capsule Completion
  (`capsule_pct`). General Configurations → Import Completion syncs each from its own LMS course (Capsule defaults to
  "Learning Capsule - Selling Opps. in Acne & Dry Skin Condition") and the Excel upload has an "Import into" choice.
- **Trainer's Attendance exports** (Excel / Image / PDF) leave out Core + Capsule Completion, Attendance, Late
  Arrival Time and Notes; the admin's keep them (`col-export-skip` cells, hidden while `.exporting`).
- **Hidden days** use 👁 (visible) / an eye-with-a-slash icon (hidden, `EYE_OFF_SVG`); dropdowns end hidden days
  with 🚫 (v4; was "(hidden)"). Attendance-tab day dropdowns are in date order.
- **Hourly Google Sheet backup**: `supabase/functions/backup` + `supabase/backup.sql` (pg_cron); setup steps in
  `supabase/README.md`.

## v4 (update v4.md)

- **Named staff accounts** (`STAFF_ACCOUNTS` secret, PBKDF2 hashes made offline with `dev/password-hash.html`):
  `UPC_TMD` superadmin · `UPC_T1`–`T4` trainer · `UPC_Co`, `UPC_Co1`, `UPC_Co2` coordinator (the old "admin" role —
  same limited tabs; CSS hooks keep the `admin-view` / `admin-hidden` names). Tokens carry `v:2` (older tokens are
  refused). Lockout is per username (8 tries → 10 min) plus an overall cap. The old `TRAINER_*` / `ADMIN_*` secrets are
  only a fallback while `STAFF_ACCOUNTS` is unset. The server stamps `assignedBy`, `markedBy`, `decidedBy`, `mergedBy`
  with the signed-in username. The Admins Dashboard (trainer.html) badge shows "Role · username".
- **Activity Log** (superadmin tab): table `activity_log` (append-only, written best-effort by the Edge Function for
  every sign-in/failed sign-in, date/attendance/shift change, roster add/edit/delete, day add/edit/delete, setting,
  approval decision, supervisor request/submit, group merge). Read through the `activity` action (superadmin only,
  500 rows a page). The hourly backup appends new rows to an **Activity** tab.
- **Retraining history**: column `pharmacists.history` (jsonb array). When a pharmacist whose attendance failed
  (Absent, or Partial = one day attended + the other marked Absent) gets a different day / a leave / no day, the
  server archives the missed attempt (not when moved to another group on the SAME date — that's a Mix-up fix) and
  marks the new booking `a.retraining = {attempt, originalDateId, originalDate}`. `patch operations` returns
  `{ops:{pid:{a,h}}}` so the page shows it at once (`APP_HOOKS.onOpsUpdated`). Supervisors only get their own
  pharmacists' history. Shown as a "↻ Retraining #n" badge (click → all attempts), a Retraining filter (T-A, S-6) and
  Master Sheet columns "Original Date (absent)" / "Attempt" (ignored by the roster upload).
  Split attendance: Day 1 attended + Day 2 not marked = in progress (not failed) — client and server agree now.
- **Adherence Rate** card (Analytics overview, `adherenceStats`): attended ÷ invited, one invitation per booking on a
  day already held (first attempt + each retraining); future days and unapproved over-quota bookings don't count.
- **Group merges** (approvals type "Group Merge", key `group-merges`, staff incl. coordinators): ≥2 online groups on
  the same date run as one session; both keep their pharmacists/attendance. Record: trainer, coordinator, typed total
  attendees, note, merged/unmerged by+at. 🔗 badges on the session card, days table and calendar; "Merged Groups" card
  at the bottom of the Attendance tab.
- **S-13**: Request Change only for submitted (locked) or training-team-managed pharmacists — UI and server
  (`changeRequestAllowed`); target days follow each pharmacist's own online/offline type.
- **S-11**: Submit locks what is filled; empty rows stay open. Only pharmacists on a training day need a Work Shift.
  Submissions with empty rows show a "Partial" tag in Approvals.
- **Request Data Edit** (approvals type "Data Edit", key `data-edit-requests`): supervisor asks to change name, email,
  pharmacy no., employee ID, phone, SCFHS, city / online-physical; the server whitelists fields
  (`cleanDataEditChanges`). Trainer ticks which changes to apply → Approved / Partially Approved / Rejected; a type
  change clears a booked day of the other kind. `patchMaster` now keeps Core Completion when the field isn't sent.
- **Deploy order matters**: run the `schema.sql` upgrade lines (history column + activity_log) BEFORE deploying the new
  `api` function — it reads/writes `pharmacists.history`.

## v5 — Reports (in progress — see docs/Hub_Reports_Integration_Plan.md)

- **Done: Phases 1–5** (database, Edge Function, staff tabs, Hub columns, public page). Phase 6 is manual (below). Tables `courses`, `course_progress` (one row per learner per
  course; a publish replaces the course's rows), `course_uploads` (publish audit; never the exclusion list),
  `lms_learners` (onboarding people for completion reporting only — never part of the roster). Settings keys
  `coreCourseId` / `capsuleCourseId`.
- Roles: `requireReportsAdmin` = superadmin + coordinator (trainers refused); `courseDelete` superadmin only.
- `coursePublish` validates every row on the server (email, state, done ≤ total, rate 0–100, final_done ⇒ finished
  state, dates ISO or null, text ≤ 200). A finished learner whose timestamp couldn't be read is stored with
  `final_at = null` and is always "Completed (date unknown)" — never On time / Late (`scheduleOf`, computed at read time).
  Roster / onboarding / not-in-roster counts are recounted on the server.
- One merge (`mergedCourseRows`) feeds the staff export and the public page: roster by email wins, else onboarding, else
  "Not in roster"; optional "No completion data" rows for roster people missing from the upload.
- Public actions run before `authenticate()`, are rate-limited per IP in `kv_cache` (`rl:<ip>:<minute>`, daily
  `rlhits:<date>` counter), cached 60 s per isolate, mask emails (`ab•••@domain`) and send only enabled columns.
- `pharmacists.completion_pct` / `capsule_pct` are kept but no longer read or written. Until Phase 4, the Attendance
  tab's Core / Capsule columns show "—" and the old Import Completion card no longer saves anything.
- Fixed with this change: `patchMaster` declared `const s` twice (a v4 syntax error that would stop `api` deploying).
- **Phase 3 (staff tabs)** — `assets/js/reports-admin.js` (all globals `rp*`), tabs `t-moodle`, `t-sap`, `t-repconf` (class
  `reports-only`: superadmin + coordinator; `isReportsAdmin()`); coordinators no longer see General Configurations.
  Moodle Reports ports the old tool: sheets read with `raw:true` (no locale date guessing); `rpParseTs` accepts
  `YYYY-MM-DD HH:MM[:SS]`, `D/M/YYYY[ H:MM[ AM|PM]]` (day first), `[Weekday, ]D Month YYYY[, H:MM AM|PM]` and Excel serials,
  all as KSA (UTC+3); anything else is "unreadable" → counted, shown with examples in the preview, and Publish needs an
  explicit tick. Deadline = date + time + :59 s KSA. Engine settings (final videos, counted statuses, excluded videos) and
  the deadline are saved on the course at publish; the exclusion list is never saved. `rpSelfTest()` runs with `?debug=1`.
- `common.js`: `downloadStyledXlsx` takes `opts.autoName` and `opts.sheets` (multi-sheet), writes real numbers as numbers,
  colours course states / roster match (`statusCols`); `reportFileName()`; `registerFilterScope()` lets new tables use
  the cascading multi-select filters. SheetJS upgraded to 0.20.3 (re-test Master upload, Calendar import, Bulk Add).
- **Phase 4 (Hub columns)** — `loadCoreData` also reads `course-slots` into the global `courseSlots`. Attendance tab
  Core / Capsule use `courseSlotCellHtml` (✔ date, red when finished after the booked training day; ✔ Completed (no
  date); bar + %; —), sort `core` / `capsule` = finished by date → finished without date → in progress by % → none,
  coordinator export text via `courseSlotText` ("Completed 5 Oct 26" / "Completed (no date)" / "45%" / blank). The
  supervisor page has Core % / Capsule % columns (percentage only) and exports them. The Import Completion card, its
  Excel import and the Apps Script Sync Now code are gone (General Configurations shows a read-only "Course Completion"
  line); Edit Selected no longer edits Completion %. `pharmacists.completion_pct` / `capsule_pct` remain in the table as
  old data only — nothing reads, writes or exports them.
- **Phase 5 (public page)** — `reports.html` + `assets/js/reports.js` (globals `pub*`), `API.init('public')` (no token,
  no supervisor). Overview (totals only) → course table with the columns switched on in Reports Configuration; cascading
  filters (scope `pub`), name search (200 ms debounce), chronological date sort, Days Left (KSA calendar days: Done /
  Today! / ≤3 critical / ≤7 warning / Overdue), Excel (JSZip writer, rate as a number) / Image / PDF named with
  `reportFileName`, share link `reports.html?c=<slug>` (locked view), offline fallback from
  `localStorage['upc:reports-cache']` (last 8 courses), print styles, `noindex`. UI round (owner request): layout follows the
  old dashboard (Live status bar + Refresh, View picker with count badge, one toolbar, status legend, course cards with
  Done / In progress / Not started / Total, completion bar, "N modules" = `agg.modules`). **Emails are shown in full**
  on the public page and its Excel (owner decision — the plan had them masked); switch the Email column off per course
  in Reports Configuration to send no emails for that course. A "Report
  unavailable" answer (inactive course / renewed link) is never replaced by the saved copy. `config.js` no longer has
  any Apps Script link; the landing card opens `reports.html`.
- **Phase 6 (manual, owner) — migration and retirement of the old dashboard:**
  1. For each course tab of the old Google Sheet: File → Download → .xlsx.
  2. Reports Configuration → track a course with the same name (Moodle) → Moodle Reports → choose it → upload that
     file → check the preview (final video, counted statuses, unreadable timestamps) → Publish.
  3. Compare per course with the old dashboard (totals, finished, in progress) — differences usually come from the
     final-video or counted-status choice, or people missing from the roster (see "Not in roster").
  4. Switch the courses to **Active**; pick Core / Capsule in Reports Configuration → Hub columns.
  5. In the old `LMS-reporting` repo, replace its page with a one-line "Moved → <Hub>/reports.html".
  6. Archive the Apps Script deployment and set the old Sheet to **Restricted** (its URL was public and exposed the roster).
