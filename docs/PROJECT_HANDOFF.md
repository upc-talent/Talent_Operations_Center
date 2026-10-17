# Talent Operations Center — project handoff

Everything a new developer (human or AI agent) needs to continue this project.

**No secrets are in this file.** Passwords, the token secret and the backup credentials live only in the Supabase Edge
Function secrets (ask the owner).

Companion documents:

| Document | What it gives you |
|---|---|
| [FEATURE_CATALOGUE.md](FEATURE_CATALOGUE.md) | Every feature and rule, with IDs |
| [LESSONS_LEARNED.md](LESSONS_LEARNED.md) | Mistakes made, how they were found and how to avoid them |
| [../supabase/README.md](../supabase/README.md) | Setup and the deploy checklist |
| [WORK_SUMMARY.md](WORK_SUMMARY.md) | Sept 2026 history |

---

## 1. What this is

A web tool for **United Pharmacy (UPC) — Talent Management**.

- **Supervisors** (no password, pick their name):
  - book each of their pharmacists on a training day or record a status (Sick / Annual Leave, Resignation, Promotion);
  - press **Submit** to lock their choices;
  - ask for changes (Request Change, Request Data Edit, new pharmacists, annual leave).
- **The training team** (Admins Dashboard, own accounts) does all of the following, as far as each account's permissions allow:
  - attendance, training days and the calendar;
  - approvals, analytics and exports;
  - course completion reports: Moodle Reports, Reports Configuration and the public page.
- **The superadmin** (`UPC_TMD`) also has the Activity Log and **Admins Permissions**: per-account switches, password resets and creating users.
- **Anyone** can open the public **Course Progress Reports** page (`reports.html`).
- **How it is built:**
  - Data lives in **Supabase Postgres**.
  - One **Edge Function** (`api`) is the whole backend.
  - The front end is static files on **GitHub Pages**.
  - A second function (`backup`) copies everything to a Google Sheet every hour.

**Owner:** muhammed.zaghloul237@gmail.com. Working dir on the owner's PC: `D:\Work\UPC\Digital Tools\[Active] Talent Operation Hub` (moved from `D:\Work\UPC\Sync Training` in Oct 2026). Git repo, branch `main`;
the owner pushes to GitHub.

**History:**
1. A single 2.2 MB HTML file.
2. Pages backed by a Google Sheet.
3. Supabase (Sept 2026).
4. Then versions v3 → v7.5; see §10 and [LESSONS_LEARNED.md](LESSONS_LEARNED.md).

The old reporting tool (separate `LMS-reporting` repo + public Google Sheet) was folded into the Hub in v5. Copies of the
old tools are kept locally in `reference/` (git-ignored).

---

## 2. Repository layout

```
index.html            Landing: Supervisor · Course Progress Reports (reports.html) · Admins Dashboard icon
supervisor.html       Supervisor page
trainer.html          Admins Dashboard: sign-in first; the app shows only the tabs the account may see
reports.html          Public course progress reports
assets/
  css/app.css         All styles (version blocks appended at the end: v4 … v7.5)
  img/logo.png        Default logo (a logo uploaded in General Configurations overrides it)
  vendor/             SheetJS 0.20.3 (xlsx.full.min.js), jszip, html2canvas, jspdf
  js/config.js        ONLY place for URLs: Supabase URL + anon key
  js/api.js           Backend client: sessions (token in session/localStorage), API.can(), getShared/setShared diffs
  js/common.js        Shared helpers: filters (cascading), sort, modals, exports (styled Excel), attendance rules,
                      bulk-selection framework, optimistic saveShared, loadCoreData
  js/supervisor.js    Supervisor logic + startup
  js/trainer.js       Admins Dashboard: every staff tab, sign-in, change password, Admins Permissions, users
  js/reports-admin.js Moodle Reports engine (rp*), Reports Configuration, people not in the roster, colours
  js/reports.js       Public page (pub*): overview, course table, filters, headcount sheet, exports, colours
supabase/
  schema.sql          Tables, indexes, RLS lockdown; safe to re-run; upgrade blocks v4, v5, v6, v7 at the end
  functions/api/      The Edge Function (TypeScript / Deno) — all reads, writes and auth
  functions/backup/   Hourly Google Sheet backup
  backup.sql          pg_cron job for the backup
  README.md           Setup, secrets, deploy checklist, version notes
dev/serve.ps1         Static server (PowerShell) — the PC has NO Node, Python or Deno
dev/password-hash.html  Offline PBKDF2 tool for STAFF_ACCOUNTS (no network access)
docs/                 This file, FEATURE_CATALOGUE, LESSONS_LEARNED, WORK_SUMMARY, Hub_Reports_Integration_Plan
reference/            Old tools (local only, git-ignored)
```

- **Classic scripts sharing globals.** The JS files are not ES modules, and handlers are inline `onclick="fn()"`.
- **Load order per page:** vendor libs → `config.js` → `api.js` → `common.js` → page script(s).
- **The Admins Dashboard** also loads `reports-admin.js`.
- **Name prefixes:** reports globals start with `rp` (staff) and `pub` (public).

---

## 3. Database (Supabase Postgres)

Project ref `aoqgabdsayaqgqroscdw`. Schema in `supabase/schema.sql`.

| Table | Content |
|---|---|
| `pharmacists` | The roster.<br>Master columns, plus `assignment` / `attendance` (jsonb), `note`, `work_shift`.<br>`history` (jsonb): retraining attempts, v4.<br>`completion_pct` / `capsule_pct`: old data, unused since v5. |
| `training_days` | One row per day; the day object in `data` (jsonb).<br>Includes `visibleSupervisors`, `readOnlySupervisors` (managed), quotas, capacity, deadline, online format. |
| `approvals` | Types: New Pharmacist, Annual Leave, Over-Quota Decision, Date Change, Submission, Group Merge, Data Edit.<br>Full record in `data`. |
| `notifications` | Results shown to supervisors. |
| `settings` | `key` → jsonb.<br>maxCapacity, trainerNames, coordinatorNames, trainingNames, cityRoster, logo, `coreCourseId`, `capsuleCourseId`, `categoryColors`. |
| `venues` | City → recommended venue. |
| `kv_cache` | Expiring key / value store:<br>`login_fails:<user>`, `login_fails_all`, `token_secret`, `presence:<supervisor>`, `rl:<ip>:<minute>`, `rlhits:<date>`, backup state. |
| `activity_log` | Append-only audit (v4); superadmin reads it. |
| `courses` | Tracked courses (v5).<br>`display` jsonb: columns, deadline options, `color` / `bg` / `text`.<br>`engine` jsonb.<br>Random `share_slug`. |
| `course_progress` | One row per learner per course; a publish replaces the course's rows. |
| `course_uploads` | Publish history (counts only, never the exclusion list). |
| `report_hidden` | v6. Not-in-roster people hidden from the public reports. |
| `staff_accounts` | v6 / v7 / v7.5. Own password `hash`, `session_version`, `must_change`, `perms` (overrides).<br>For app-made users: `role`, `disabled`, `created_*`.<br>v7.5, any account: `display_name`, `login_name` (a different sign-in username; `username` stays the fixed id). |
| `lms_learners` | v5 onboarding learners: kept as old data, unused since v6. |

**Every table has RLS enabled with no policies**, so the anon key can read and write nothing. Only the Edge Function
touches the data. ID prefixes: `ph_` pharmacist, `day_` day, `lr_` leave request, `ntf_` notification,
`qh_` over-quota decision, `sub_` submission.

---

## 4. Front-end ↔ backend contract

### Storage adapter (`api.js`)
- **Reads:** `getShared(key, fallback)` fetches `{records, settings}` and remembers a **snapshot**.
- **Writes:** `setShared(key, value)` **diffs against the snapshot and sends only the changed records**. This prevents
  last-write-wins data loss.
- **Optimistic saves:** `saveShared(key, getValue)` updates the screen first and coalesces rapid changes. A failed save
  triggers `APP_HOOKS.onSaveFailed`, which reloads the true state.
- **Values the server stores** (retraining markers, unsubmit) come back in `{ops:{pid:{a,h}}}` and are applied through
  `applyServerOps` / `APP_HOOKS.onOpsUpdated`.

**Data keys:**
- **Arrays of `{id,…}`:** `master-pharmacists`, `pending-pharmacists`, `leave-requests`, `quota-approval-history`,
  `pharmacist-notifications`, `change-requests`, `supervisor-submissions`, `group-merges`, `data-edit-requests`.
- **`operations`:** `{assignments:{pid:{type,dateId|status,locked?,retraining?…}}, attendance:{pid:{…,day1,day2}}, shifts:{pid}}`.
  Wire form `{pid:{a,t,s,h}}`.
- **`training-config`:** `{dates:[…], maxCapacity, trainerNames, coordinatorNames, trainingNames, cityRoster}`.
- **`company-logo`**.
- **`course-slots`:** Core / Capsule course data. Staff only; needs `attend.coreCapsule`.

### HTTP API (`POST` JSON to the Edge Function, anon key in the headers)

| Who | Actions |
|---|---|
| **Public** | `login{username,password,remember}`, `supervisors`, `get company-logo`, `reportsPublic`, `reportsPublicCourse{slug}` |
| **Supervisor or staff** | `me`, `get{key}`, `getMany{keys}`, `patch{key,records,settings}`, `submit` (supervisor), `ping` (supervisor heartbeat) |
| **Staff, by permission** | `venues`, `presence`, `coursesList`, `courseSave`, `courseDelete`, `courseShareRotate`, `courseSlotsSet`, `coursePublish`, `courseExport`, `categoryColorsSet`, `notInRosterList`, `reportHideSet` |
| **Own account** | `changePassword{current,next}` |
| **Superadmin** | `activity`, `adminAccounts`, `adminSetPerms`, `adminResetPassword`, `adminSignOut`, `adminCreateUser`, `adminSetDisabled`, `adminDeleteUser`, `adminSetNames` |

Every response includes `_ms`, the server's own time.

### Auth and authorization
- **Staff accounts:**
  - The `STAFF_ACCOUNTS` secret (`{user:{role,hash}}`), plus app-made accounts in `staff_accounts`. The secret wins on a clash.
  - **Names (v7.5):** the typed sign-in username is resolved to the account id by `resolveLogin()` (`staff_accounts.login_name`). After a rename the original username no longer signs in. Everything else (tokens, permissions, Activity Log, stamps) uses the fixed id; the page shows display names through `API.staffNames` / `staffLabel()`.
  - A password the person chose (`staff_accounts.hash`) replaces the secret's hash.
  - Lockout: 8 wrong tries per username in 10 minutes, plus an overall cap.
- **Tokens:**
  - HMAC-signed `{u, r, v:2, sv, rm, e}`, valid 10 h, or 144 h with "Keep me signed in".
  - Stored in `sessionStorage`, or `localStorage` when remembered.
  - Each request re-checks: the account exists with that role, it isn't switched off, and `sv` matches `session_version`.
  - While `must_change` is set, only `me` and `changePassword` are allowed.
- **Permissions:**
  - `PERM_KEYS` and the role defaults in `rolePerms`, plus per-account overrides. `effectivePerms` also turns off a tab's children when the tab is off.
  - The server guards actions with `requirePerm`.
  - Writes are mapped by `checkWritePerms` (a booking change accepts Change dates / Edit Selected / Decide requests / Master upload / Edit training days).
  - The page hides `data-perm` elements and calls `can()`.
- **Supervisors:**
  - Name checked by an indexed lookup; they see only their own pharmacists.
  - Every write is re-validated: ownership, visible and active day, online ↔ physical match, deadline, capacity, quota, locks, and no attendance writes.
- **Concurrency:** writes that move someone between days run in a transaction with a Postgres advisory lock, so two
  people can't take the last seat.

---

## 5. Business rules worth knowing

The full list with IDs is in [FEATURE_CATALOGUE.md](FEATURE_CATALOGUE.md) §11. The ones that cause the most questions:

- **Capacity:** default 30 (per-day override). Trainers may go over after a confirmation; supervisors may not.
- **Quotas:** per-supervisor quotas work on every day. Bookings over quota wait for approval.
- **Hidden days** are hidden from supervisors only. Trainers still see and use them, and they appear in the public
  Training Date filter.
- **Visible vs Editable:** a day can be visible but not editable for a supervisor (a "managed" day). They can't book
  onto it or move people off it; they use Request Change instead.
- **Submit:**
  - Locks every pharmacist the supervisor has filled in.
  - Pharmacists booked on a training day need a Work Shift first.
  - Empty rows stay open.
- **The lock always wins (v6)**, including for absent pharmacists. Rebook them through Request Change, or a trainer
  **Unsubmits** them (v7). Unsubmit doesn't override a managed day.
- **Attended:** only the training team can change the pharmacist.
- **Split online training:**
  - Day 2 can't be Attended before Day 1; Day 1 Absent marks Day 2 Absent.
  - One day attended + one day Absent = Partial (failed).
  - Day 1 attended + Day 2 not marked = in progress.
- **Retraining:** a failed attempt is archived when the pharmacist moves to another date; the new booking carries
  `retraining`. It isn't archived for a move to another group on the same date.
- **Master Sheet export = upload format.** The upload matches people by email → employee ID → name + supervisor, and
  keeps their ids, days and attendance.
- **Calendar import:** identity = the day code (`JED N 1`, `MIX 4`), so re-importing updates the same day.
- **Headcount sheet (v7.4):** an Excel / CSV of emails filters the Attendance tab (T-A15) and the public course page (PUB-8). Read in the browser only; matched by email ignoring case; lost on reload.
- **Image / PDF exports (v7.3):** drawn from a full-width copy, so nothing is cut off on phones or small windows; very long tables come out smaller.
- **Reports:**
  - **Roster match:** the roster (by email) wins; anyone else is "Not in roster", and can be hidden from the reports.
  - **Timestamps:** read in KSA. An unreadable timestamp means "Completed (date unknown)", never Late.
  - **Course colours:** a course's own colour wins, then its category's colour, then the default.

---

### 5.1 Detailed rules (from earlier versions, still valid)

- **Online days** (city `Online`, "Mix n"): split over 2 days by default (no Friday start), or a full day.
- **Absent reason is optional** (Interaction / Pharmacy / LMS).
  - One click on Absent records the absence; the reason buttons add, change or remove `reason` (per day for split
    trainings).
  - Shown as "Absent - LMS" in exports and on the supervisor page, and read back by the roster upload.
- **New pharmacists and Annual Leave** requested by supervisors take effect only once a trainer approves them. Bulk-add
  and annual-leave Excel templates exist.
- **City colours / codes:** JED N/S = blue, JAZ/BAH/ABH/TAIF = green, MAD/MEC = yellow, RUH/EAST = purple,
  Online = grey.
- **Day labels are numbered per group** in date order (`computeDayLabels`). Display only; nothing is stored.
  - In-person days by city code (JED N 1, JED N 2…); online days by training name, else city (Online QAS 1…).
  - A split online training counts once; names already ending in a number ("Mix 3") are kept.
- **Same-date groups** (e.g. "Online QAS" and "Online North", both 6–7 Oct, city "Online") are labelled with the
  training name and supervisor in every list (`dayGroupText`). Trainers may still put anyone in any group.
- **Attendance tab date labels** are short, e.g. `Online QAS - 11,12 Oct 26` (`shortDayText`). A supervisor hint is
  added only when two days would still read the same.
- **Group mix-up check** (Attendance tab banner):
  - Lists pharmacists in a group their supervisor can't see.
  - After review, moves them to their supervisor's group on the same date.
  - Rows unticked in the review are remembered per browser (`group-fix-ignored`).
- **Edit Selected** (Attendance tab): tick pharmacists → edit their details in a grid → review before / after → Confirm.
  Duplicate emails are refused; a brand-new supervisor name is flagged as a possible typo.
- **Master Sheet upload:**
  - The Date text is read back into assignments. When two days share a city and date, it includes the training name,
    e.g. `Online — 5 - 6 October 26 (Mix 4)`.
  - If a Date text still matches several groups, the upload picks the one the pharmacist's own supervisor can see.
  - The trainer chooses whether people missing from the file are kept or removed.
- **City Roster** (General Configurations): cities and their linked supervisors.
  - "Auto-select by city" and the bulk "City" action make a day visible to exactly the linked supervisors.
  - Renaming a city renames it on training days, not on pharmacists.
- **Calendar import** (`parseCalendarAoa`):
  - Day identity = the code, normalised (`JEDN1`; repeats get `#2`), so re-imports update days and keep what was set in
    the app.
  - A day block is at most 5 columns wide.
  - A `MIX n` shown under both of its days is kept once.
  - Ignored entries: `Salaries`, `Saudi National Day`, `CC`, `Re-Training`, `Learning Booster`, `Ams & SVs`.
- **Bulk actions:**
  - Pharmacists: assign / leave / unassign / Mark attendance / Unsubmit / delete.
  - Days: hide / unhide / deadline / supervisors / capacity / trainer · coordinator / city / delete.
  - Anything that doesn't fit (wrong online / physical type, day full, attended…) is skipped and reported.
  - Selections shrink to what is visible when filters change.
- **Work Shift colours:** Night = red, Morning = green. The Work Shift is never locked.


## 6. Performance design

- **Rendering:**
  - The trainer table refreshes only the changed row (`updateTrainerRow`).
  - Day dropdowns are filled on first open.
  - `dayById` uses an index.
- **Saving:** optimistic and coalesced.
- **Server:**
  - Writes read only the rows they touch.
  - Seat counts use a `GROUP BY` limited to the days involved.
  - Bulk writes are one statement.
  - Public answers are cached for 60 s per instance.
- **Measuring:** `?debug=1` logs round-trip vs server time.

---

## 7. Known issues and limits

- **Supervisor access:** supervisors have no password.
- **Analytics:** buckets don't add up when someone is assigned but not yet marked.
- **Undo / Redo:**
  - Covers training-config only.
  - Deleting a day also wipes its assignments and attendance.
- **Roster upload:**
  - Someone whose email, employee ID *and* name / supervisor all changed at once is treated as new.
  - Blank cells overwrite fields (except Notes).
- **Permissions:**
  - Changes apply on the person's next page load.
  - Write checks are lenient by design (any screen that makes a change allows it).
- **Public page:** can lag up to 60 s after a publish or hide (cache).
- **Headcount filter:** needs the course's Email column on the public page (the Attendance tab uses each pharmacist's email). The file is kept in that browser tab only.
- **Image / PDF:** a very long table is drawn smaller so the browser can still make the image (about 16 million pixels on phones); Excel is the better export for a whole course.
- **Names:** a changed sign-in username signs the person out; a forgotten superadmin username can be restored with SQL (see supabase/README.md).
- **Notes:** visible to supervisors, by design.
- **Old reporting dashboard:** its retirement (archiving the Apps Script deployment and setting the old Google Sheet to Restricted) is no longer a tracked phase in these docs. That Sheet's URL was public and exposed the roster, so confirm it was done.
- **Free Supabase:** pauses after 7 days without use.

**Ideas not built:**
- Per-supervisor access codes.
- Realtime live sync.
- An Unlock / auto-notification to supervisors after Unsubmit.
- A contrast warning in the colour picker.
- Automated tests.
- An ES-module refactor.

---

## 8. How to run, test and deploy

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
```

Open `http://localhost:5173/`. It talks to the **live** backend, so:

- **Writes are tested against an in-browser mock** of the Edge Function (see [LESSONS_LEARNED.md](LESSONS_LEARNED.md) §5).
  Temporary `dev/_t_*.TEMP.html` pages load the real page plus the mock. Delete them afterwards; never commit them.
- **Server code can be run in the browser too (v7.5):** load TypeScript from a CDN, stub the database and call `route()` directly; see [LESSONS_LEARNED.md](LESSONS_LEARNED.md) §5.
- **Checks against the live system are read-only.**
- **`rpSelfTest()`** (with `?debug=1`) runs 23 Moodle-engine checks.

**Deploy:** use the checklist in [../supabase/README.md](../supabase/README.md#deploy-checklist).
1. `schema.sql`.
2. `api`.
3. `backup`.
4. Push the front end.

Always run the schema before deploying a new `api`.

---

## 9. Gotchas for whoever continues

- **No Node / Python / Deno on the owner's PC.** Check scripts with the Perl scope checker and by loading every changed
  page in the browser. See [LESSONS_LEARNED.md](LESSONS_LEARNED.md) for the editing traps (Perl `$1`, heredocs,
  apostrophes in JS strings).
- **Git** refuses with "dubious ownership" on this folder. Pass `-c safe.directory='*'` per command (`git -c safe.directory='*' status`) instead of changing the global config. The owner pushes; commit per phase.
- **The folder name has brackets** (`[Active] …`). Tools that treat `[ ]` as a pattern break: `dev/serve.ps1` needed `-LiteralPath` (fixed in v7.3). Use literal-path options in any new PowerShell script.
- **Never commit roster exports** (`*.xlsx`, `*.xls`, `*.csv` are ignored) or secrets.
- **Table columns:** the `<thead>` in the HTML and the row template in the JS must have the same number of cells
  (including the bulk-select checkbox column).
- **`esc()`** around every value put into HTML.
- **A new field on a pharmacist** needs four changes: `schema.sql`, `getMaster` / `patchMaster` in the Edge Function, the
  front-end master shape, and the mock.
- **A new staff screen or action** needs four things:
  - a permission key in `PERM_KEYS` (server) and `PERM_TREE` (Admins Permissions);
  - a role default in `rolePerms`;
  - a server check;
  - a `data-perm` tag or `can()` call on the page.
- **A new Activity Log action** needs a label in `ACTIVITY_LABELS` (trainer.js).
- **Ask the owner** before adding anything they didn't ask for.

---

## 10. Change history (oldest first)

Older entries describe the rules **as they were then**. Where a later version changed a rule, the later entry wins.
§5 above is always current.

### Before v3 (Sept 2026)
- **Speed work and the move from Google Sheets to Supabase.** See [WORK_SUMMARY.md](WORK_SUMMARY.md).
- **Rules from then that were later changed:**
  - **Submit needed every row filled.** Since v4 (S-11) it locks only what is filled.
  - **A pharmacist who missed training got the dropdown back, even when locked.** Removed in v6: the lock always wins.
  - **One shared trainer login (`TRAINER_USER`/`TRAINER_PASS`) and an "admin" login (`ADMIN_USER`/`ADMIN_PASS`).**
    Replaced by named accounts in v4. The four secrets still work only as a fallback while `STAFF_ACCOUNTS` is unset.
  - **Core / Capsule completion was imported into `pharmacists.completion_pct` / `capsule_pct`.** Since v5 it comes
    from published course data.

### v3

- **Two completion columns** in the Attendance tab: Core Completion (`completion_pct`) and Capsule Completion
  (`capsule_pct`). General Configurations → Import Completion syncs each from its own LMS course (Capsule defaults to
  "Learning Capsule - Selling Opps. in Acne & Dry Skin Condition") and the Excel upload has an "Import into" choice.
- **Trainer's Attendance exports** (Excel / Image / PDF) leave out Core + Capsule Completion, Attendance, Late
  Arrival Time and Notes; the admin's keep them (`col-export-skip` cells, hidden while `.exporting`).
- **Hidden days** use 👁 (visible) / an eye-with-a-slash icon (hidden, `EYE_OFF_SVG`); dropdowns end hidden days
  with 🚫 (v4; was "(hidden)"). Attendance-tab day dropdowns are in date order.
- **Hourly Google Sheet backup**: `supabase/functions/backup` + `supabase/backup.sql` (pg_cron); setup steps in
  `supabase/README.md`.

### v4 (update v4.md)

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

### v5 — Reports (see Hub_Reports_Integration_Plan.md)

- **Done: Phases 1–5** (database, Edge Function, staff tabs, Hub columns, public page). Tables `courses`, `course_progress` (one row per learner per
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
  `rlhits:<date>` counter), cached 60 s per isolate and send only enabled columns (emails were masked at first; since the v5 UI round they are shown in full — owner decision).
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


### v6 — permissions, passwords, report people, attendance tools

- **Lock fix (R-1):** the lock always wins. A pharmacist who missed their training on a submitted or managed day no
  longer gets the Date dropdown back; the supervisor rebooks them through Request Change (allowed now for failed
  pharmacists too). Server: `patchOps` refuses any change to a locked assignment, `validateSupervisorAssignment` refuses
  leaving a managed day, and `changeRequestAllowed` no longer excludes failed pharmacists. An unlocked absent pharmacist
  on an editable day can still be rebooked directly. The note under the date reads "Missed the training — use Request Change".
- **Supervisor page:** Core % / Capsule % columns, their export columns and the Retraining filter are gone. The page no
  longer requests `course-slots`, and the server returns nothing for supervisors.
- **Attendance tab:**
  - Bulk "✔ Mark attendance" pop-up: Day 1 / Day 2 / both Attended, Day 1 / Day 2 / both Absent, with an optional
    absence reason. One-day trainings use the Day 1 choices and skip the Day 2 ones. The split-day rules hold: Day 2
    Attended needs Day 1 Attended; Day 1 Absent marks Day 2 Absent. People with no training day are skipped.
  - New Attendance filter (`attStatusKey`): On Time, Late, Absent, Partial, Day 1 only, Not marked, No training day.
- **Analytics & Export:** the filter bar moved to the top and applies to the cards, the Breakdown and the Master Sheet
  Preview (`analyticsScope()` / `renderAnalyticsView()`). It has District, Area Manager, City, Supervisor, Type, Date,
  Attendance, Work Shift and Retraining, all cascading.
- **Moodle Reports section 8 — People not in the roster (replaces Onboarding learners):**
  - `notInRosterList` returns everyone in any published course whose email isn't in the roster, with their courses.
  - Bulk Hide / Unhide (`reportHideSet`) uses the new `report_hidden` table. A hidden person is left out of the public
    page's tables and counts in every course (`mergedCourseRows(…, skipHidden)`). The staff export keeps them, marked
    "(hidden from reports)".
  - A hidden email that later joins the roster shows again, because the roster wins.
  - "Download list" exports the filtered list to Excel.
  - `lms_learners` is no longer read or written; the table is kept as old data, and the onboarding actions are removed.
- **Public page — headcount sheet (from the old tool):** "Upload Headcount Sheet" reads an Excel or CSV in the browser
  only; it is never uploaded. The header row is found automatically (Email / Username column, or else the column with
  the most email addresses).
  - "Headcount only" shows just those people. Sheet people missing from the course data appear as "No completion
    data" / "Not in course data", with their details taken from the sheet. Details the course data lacks are also
    filled in from the sheet.
  - "Everyone" shows the normal view.
  - The numbers, filters and exports follow the mode.
  - It needs the course's Email column.
- **Accounts (`staff_accounts` table):**
  - Who exists, and their role, still come from `STAFF_ACCOUNTS`. A row adds `hash` (a password the person chose,
    PBKDF2-SHA256 150k with a random salt), `session_version`, `must_change` and `perms` (overrides only).
  - Tokens carry `sv`. A password change, a superadmin reset or "Sign out everywhere" raises `session_version`, which
    signs out every other session. The account and role are re-checked against `STAFF_ACCOUNTS` on every request.
  - "Keep me signed in" issues a 6-day token stored in `localStorage`. Otherwise the token lasts 10 hours and is kept
    in `sessionStorage`.
  - Change password (🔑 in the top bar) checks the current password, with wrong tries counting towards the sign-in
    lockout. The new password needs 10+ characters, a letter and a number, and must not contain the username.
  - Superadmin reset: the browser generates a temporary password, which is shown once. While `must_change` is set,
    the server allows only `me` / `changePassword` until the person picks their own.
  - If the superadmin forgets their own password, delete their `staff_accounts.hash` (SQL editor) to fall back to the
    `STAFF_ACCOUNTS` hash.
- **Admins Permissions tab (superadmin):** per-account switches, one per tab plus one per section or action inside it
  (`PERM_TREE` in trainer.js, `PERM_KEYS` / `rolePerms` in index.ts).
  - Role defaults reproduce the v5 access.
  - A tab switched off turns off everything inside it.
  - Server: `can()` / `requirePerm()` guard every action. `checkWritePerms` maps each kind of write to the
    permissions whose screens make it (e.g. a booking change is accepted with Change dates, Edit Selected, Decide
    requests, Master upload or Edit training days). Approval lists need `approvals.view`, and `course-slots` needs
    `attend.coreCapsule`.
  - Client: `data-perm="key|key2"` hides elements, and rows call `can()`. Body classes handle the rest:
    `no-cal-edit`, `ro-days`, `ro-approvals`, `perm-export-full`, `no-core-capsule`.
  - Changes take effect on the person's next page load and are logged as `permissions`.
- **UI:** `main` is full width (no 1800 px cap), with a responsive gutter. The tab bar scrolls sideways on narrow
  screens. The bulk bar sticks while scrolling. Buttons have focus and disabled states.
- **Activity actions added:** `report_hide`, `report_unhide`, `password_change`, `password_change_failed`,
  `password_reset`, `sign_out_all`, `permissions`.
- **Backup:** new tabs "Hidden From Reports" and "Admin Accounts" (no hashes). "Onboarding Learners" is no longer written.
- **Deploy v6:**
  1. Run `schema.sql` (the v6 block creates `report_hidden` and `staff_accounts`).
  2. Redeploy `api`, then `backup`.
  3. Push the front end.

  `STAFF_ACCOUNTS` stays as it is. Existing sessions keep working; everyone gets the new features on their next page load.

### v7 — Training Date filter, Unsubmit, course colours, users made in the app

- **Public page:** new **Training Date** filter, showing the training day each roster person is booked on in the Admins
  Dashboard. It covers visible and hidden days, plus "No training day".
  - `reportsPublicCourse` sends `td` (ISO date, for sorting) and `tl` (label from `pubDayLabel`, e.g. "JED - 5 Oct 26",
    "Online QAS - 11, 12 Oct 26").
  - The old "Date" filter is renamed **Completion Date**. It always was the date each person finished the final video (KSA).
- **Unsubmit:**
  - **Where trainers do it:** a "🔒 Submitted" tag with an **Unsubmit** link on the Attendance Date cell, a bulk
    **🔓 Unsubmit**, and **🔓 Unsubmit…** on each Approvals → Supervisor Submissions row (pick days or statuses).
  - **Effect:** the date or status stays, the `locked` flag is removed, and the supervisor can change it and Submit again.
  - **Server:** an explicit `a.locked === false` from staff needs the `attend.unsubmit` permission. Pharmacists who
    attended are refused. The change is logged as `unsubmit`.
  - **Defaults:** on for trainers, off for coordinators.
  - **Separate from a day's Editable switch:** a pharmacist on a non-editable day stays managed by the training team.
- **Course card colour:** Reports Configuration offers ten preset colours, any custom colour, or Default.
  - It is stored as `courses.display.color` (`#rrggbb`) and validated in `cleanDisplay`.
  - On the public page it colours the top band of the course's card and summary, its title, its button and its progress bar.
- **Users made in the app** (Admins Permissions → **+ Add user**):
  - **New columns:** `staff_accounts.role`, `disabled`, `created_at` and `created_by`.
  - **Who:** trainer or coordinator only (a superadmin stays in `STAFF_ACCOUNTS`). The username must be unique,
    ignoring case, across both sources.
  - **First sign-in:** a temporary password is shown once, with `must_change`.
  - **Switch off / on:** works for any account except your own and superadmins. Switching off signs the person out
    everywhere and blocks sign-in.
  - **Delete:** only for app-made accounts.
  - **Sign-in rule:** `accountFrom()` resolves an account from the secret first, then the app.
  - **New activity actions:** `user_create`, `user_disable`, `user_enable`, `user_delete`.
- **Deploy v7:**
  1. Run `schema.sql` again (it adds the v7 block of `staff_accounts` columns).
  2. Redeploy `api`, then `backup`.
  3. Push the front end.
- **Card colours, v7.1:** each course now has three colours, `display.color` (accent), `display.bg` (card fill) and `display.text`, each `#rrggbb` or "" for the default.
  - **Accent:** colours the top band, title, button and progress bar.
  - **Fill:** the card and summary background; the number boxes stay white so the figures stay readable.
  - **Text:** an empty text colour with a fill means automatic (black or white by contrast, `pubAutoText` / `rpAutoText`).
  - **Form:** Reports Configuration has a picker row for each colour and a live preview.
- **Category colours, v7.2:** `settings.categoryColors` holds `{category: {color, bg, text}}`; category names match regardless of upper / lower case.
  - **Precedence:** a course's own colours win per colour, so an empty one follows its category (`publicCourseHead`, `rpEffectiveColors`).
  - **Editing:** Reports Configuration → Category colours → Edit colours. The pop-up can also clear the courses' own colours, so the whole category follows.
  - **Server:** action `categoryColorsSet` (needs `repconf.edit`), logged as `category_colors`. `coursesList` returns `categoryColors`.
  - **Course form:** in a course's form the empty swatch reads "Use category colour".

### v7.3 — Image / PDF exports never cut off

- **Problem:** Image and PDF exports captured only what fitted on screen. On a phone, or in a window that didn't fill the
  screen, columns past the right edge were lost and the rest were squeezed.
- **Fix (`captureFull` in common.js):** the export draws a copy laid out off the page, so the page itself doesn't move.
  - **Tables** (default; course report, Attendance, Master Sheet Preview, supervisor list): the copy takes the table's
    whole width (CSS class `export-full`): no sideways scroll box, no wrapping and no "…" cells.
  - **Calendar:** `{minWidth:1100}`, so it is laid out at desktop width at least.
  - **Unchanged:** the `.exporting` rules, e.g. the trainer's short export still leaves out `col-export-skip`.
- **Size limits:** the image is 2× for sharp text. It is made smaller for very long tables, because browsers refuse
  canvases over about 32,000 px on a side, and phones over about 16.7 million pixels (`exportCanvasScale`). Example: a
  1,400-row course on a phone gives a complete but small image; use Excel for that.
- **Deploy:** front end only.
- **Also fixed:** `dev/serve.ps1` uses `-LiteralPath`, so the local server works in a folder whose name has `[ ]`
  brackets.

### v7.4 — Attendance tab headcount sheet

- **What:** the public page's "Upload Headcount Sheet" (PUB-8), now also on the Attendance tab (T-A15), for every
  account that sees that tab. No permission switch and no server change: the file is read in the browser only.
- **Code:**
  - `readHeadcountFile` / `parseHeadcountSheet` moved from reports.js into common.js, so both pages share them.
    The header row is found in the first 10 rows (Email / Username column), or else the column with the most emails.
  - trainer.js `trainerHc*`. `applyTrainerFilters` keeps only sheet emails in "Headcount only" mode, so the table,
    bulk selection and the Excel export follow; Image / PDF follow the table on screen.
  - The `trainer` filter facets and the District / Area Manager / City / Supervisor lists use `trainerHcBase()`.
    Values already ticked stay listed.
  - Emails match ignoring upper / lower case and spaces.
- **Deploy:** front end only.

### v7.5 — account names and typed temporary passwords

- **Admins Permissions → ✎ Name & username** (SA-8), for any account:
  - **Display name** (`staff_accounts.display_name`, up to 60 characters). Shown in the top bar, Admins Permissions,
    the Activity Log (and its export and user filter), "merged by" and the Master Sheet's marked-by, also on past entries.
  - **Sign-in username** (`staff_accounts.login_name`, unique ignoring case). `login()` resolves it with
    `resolveLogin()`. Once it is set, the original username no longer signs in. Changing it raises `session_version`
    (signed out everywhere), except for the superadmin's own account.
  - **Fixed id:** `username` stays the account's id everywhere: tokens, `staff_accounts` key, permissions, Activity
    Log rows, stamps. So a rename rewrites nothing. A new username or sign-in username must not equal any account's
    original username or sign-in username, ignoring case.
  - **Server:** `adminSetNames {username, displayName, loginName}` (superadmin; logged as `user_name` / `user_login`).
    `login` and `me` also return `login`, `displayName` and `staffNames` (`{id: {n, l}}`; `l` only for the superadmin).
  - **Front end:** `API.loginName`, `API.displayName`, `API.staffNames` (not `API.login`, which is the sign-in function); `staffLabel(id)` / `staffLabelFull(id)` in
    common.js; `renderRoleBadge()` in trainer.js.
- **Reset password and Add user:** "Generate one for me" or "Type it myself" (`chosenTempPassword`). Same rules as the
  server: 10+ characters, a letter and a number, and it must not contain either username. Either way the person must
  choose their own password at the next sign-in. Add user also takes an optional display name.
- **Password rule:** `passwordProblem(pw, ...users)` now refuses both the original username and the sign-in username.
- **Backup:** the Admin Accounts tab has "display name" and "sign-in username (if changed)".
- **Deploy v7.5:**
  1. Run `schema.sql` (the v7.5 block adds `display_name`, `login_name` and a unique index).
  2. Redeploy `api`, then `backup`.
  3. Push the front end.
