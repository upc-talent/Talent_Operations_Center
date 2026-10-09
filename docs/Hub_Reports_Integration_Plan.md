# Talent Operations Center — Reports Integration Plan

**For:** Claude Code, working directly in the Hub repo (`Sync Training/`)
**Owner:** Zaghloul (UPC Talent Management)
**Status:** Approved design. Build in the phase order in §11.

> **Read first:** `docs/PROJECT_HANDOFF.md` (especially the v4 section), `supabase/README.md`, `supabase/schema.sql`, `supabase/functions/api/index.ts`, `assets/js/api.js`, `assets/js/common.js`. Follow the existing conventions: classic scripts sharing globals (no ES modules, no build step), `esc()` around every interpolated value, `<thead>` cell count equal to the row template, and every write goes through the `api` Edge Function. The owner's PC has no Node, Python or Deno. Review the Edge Function carefully; the owner deploys it by hand.

---

## 0. Goal in one paragraph

Bring three external tools into the Hub and retire Google Sheets and Apps Script entirely.

- The **Moodle Completion Rate Tool** (`moodle-completion-tool_final Version.html`, a single-file client-side engine) becomes a new staff tab, **Moodle Reports**.
- The old **LMS Completion Dashboard** (`index.html` plus its Apps Script) becomes a new public page, **`reports.html`**.
- A new staff tab, **Reports Configuration**, manages tracked courses and decides what the public page shows.
- **SAP Reports** is a "Coming Soon" placeholder.
- All completion data lives in the Hub's Supabase database. The Hub's `pharmacists` table stays the single roster for everything.
- The Attendance tab's **Core** and **Capsule** columns read automatically from the published course data.

---

## 1. Decisions (locked)

| # | Decision |
|---|---|
| D1 | One Supabase database (the Hub's). New tables `courses`, `course_progress`, `course_uploads`, `lms_learners`. **No table per course.** A new course is a new row in `courses` plus its rows in `course_progress`. |
| D2 | `pharmacists` (the headcount) stays unchanged and is the single roster for every Hub function. |
| D3 | **Onboarding learners**: people not yet in the roster can be uploaded from Moodle Reports for completion reporting **only**. They are stored in a separate table, `lms_learners`. They never appear in the supervisor list, Attendance, Master Sheet, Analytics or the roster upload. If the same email later appears in `pharmacists`, the roster record wins. |
| D4 | The **exclusion list** (emails and `@domains`) is provided fresh at every publish or export and is **never stored** (not in the database, not in `localStorage`). Excluded people are left out of the published dataset. Only the excluded **count** is logged. |
| D5 | Two distinct labels: **"Not in roster"** means the person is in the LMS file but in neither `pharmacists` nor `lms_learners`. **"No completion data"** means the person is in the roster but not in the uploaded file. Neither is shown as 0%. |
| D6 | Every feature of the old dashboard is rebuilt. **Nothing depends on Google Sheets or Apps Script afterwards.** Remove `COMPLETION_REPORTS_URL`, Sync Now and the Apps Script fetch code. |
| D7 | The public page is **fully public** (no login), hardened as in §8. |
| D8 | "Download data" in Reports Configuration produces an Excel file with an auto-generated, Windows-safe filename: `10 Oct 26 - 1 PM - <Course Name> - Moodle.xlsx` (§7.4). |
| D9 | Configuration controls, per course: active, display name, category, display order, visible columns, show deadline, show Days Left, and show roster people with no data. More options will be added later, so keep the structure extensible (a `display` jsonb column). |
| D10 | Days Left on the public page counts down to the **course deadline**, which is set in Moodle Reports and stored on the course. |
| D11 | Publishing **replaces** a course's data completely. Each publish is logged in `course_uploads`. |
| D12 | Core and Capsule in the Attendance tab are fed by two settings in Reports Configuration ("Core course" and "Capsule course"), each reassignable at any time. |
| D13 | "Finished" means state **Completed** OR **Final video done, others missing**. Finished people show `✔ 5 Oct 26`, or `✔ Completed (no date)` when there is no timestamp. In-progress people show a bar and %. No data shows `—`. The date turns red if they finished **after** their assigned training day. |
| D14 | The old **Import Completion** card (Excel "Import into" and both Sync Now buttons) is removed and replaced by a read-only status line. |
| D15 | Coordinator Attendance exports show `Completed 5 Oct 26` / `Completed (no date)` / `45%` / blank in the Core and Capsule columns. |
| D16 | The **supervisor page** gains Core % and Capsule % columns for their own pharmacists (percentage only). |
| D17 | Sorting the Core or Capsule column puts finishers first (earliest date first), then in-progress people (highest % first), then blanks. |
| D18 | **Moodle Reports** and **Reports Configuration** are visible to **superadmin and coordinator only**, not trainers (UPC_T1–T4). This is enforced on the server too. |
| D19 | The public page has a **share link per course** that opens only that course in a locked view. |
| D20 | **SAP Reports** shows "Coming Soon". SAP courses can be created in Configuration but have no upload path yet. |

---

## 2. Architecture

```
Staff (trainer.html, signed in)                    Public (reports.html, no login)
 ├─ Moodle Reports tab  ── parse/merge in browser ─┐        │
 │    (ported Moodle engine)                       │        │ reportsPublic / reportsPublicCourse
 ├─ Reports Configuration tab ── course CRUD ──────┤        │ (read-only, masked emails, rate-limited)
 ├─ SAP Reports tab (Coming Soon)                  │        │
 └─ Attendance tab: Core / Capsule  ◄── course-slots key    │
                                                   ▼        ▼
                              Supabase Edge Function "api"  (all auth + validation)
                                                   ▼
                     Postgres: pharmacists (roster, unchanged) · courses · course_progress
                               course_uploads · lms_learners · settings (coreCourseId, capsuleCourseId)
```

- **Parsing and calculation happen in the browser** (as in the Moodle tool). The browser sends **computed rows** to `coursePublish`. The server validates them and writes them in one transaction.
- **Schedule results** (On time, Late, Overdue, Still within deadline) depend on "now", so they are **computed at read time** from the stored `final_at` and the course deadline. They are never stored.

---

## 3. Database (`supabase/schema.sql`, append; idempotent)

```sql
-- ═════════ Reports: tracked courses ═════════
create table if not exists courses (
  id                 text primary key,                         -- crs_...
  name               text not null,
  source             text not null check (source in ('moodle','sap')),
  active             boolean not null default false,           -- visible on the public page
  display_name       text not null default '',                 -- '' = use name
  category           text not null default '',
  sort_order         int  not null default 0,
  deadline           timestamptz,                              -- course deadline (KSA input), null = none
  display            jsonb not null default '{}'::jsonb,       -- {columns:[…], showDeadline, showDaysLeft, includeRosterNoData}
  engine             jsonb not null default '{}'::jsonb,       -- saved Moodle settings: {finalVideos:[names], acceptedStatuses:[…], excludedVideos:[…]}
  share_slug         text not null unique,                     -- random 24-char public id (rotatable)
  created_at         timestamptz not null default now(),
  created_by         text not null default '',
  last_published_at  timestamptz,
  last_published_by  text not null default '',
  row_count          int not null default 0
);

-- One row per learner per course (the latest publish only — a publish replaces the course's rows)
create table if not exists course_progress (
  course_id      text not null references courses(id) on delete cascade,
  email          text not null,                                -- lowercase, trimmed, non-empty
  lms_name       text not null default '',                     -- name as written in the LMS file
  sources        text not null default '',                     -- platform labels, comma-separated
  done           int  not null default 0,
  total          int  not null default 0,
  rate           numeric(5,1) not null default 0,              -- 0..100, one decimal
  state          text not null,                                -- Completed | Final video done, others missing | In progress | Not started
  final_done     boolean not null default false,
  final_status   text not null default '',
  final_at       timestamptz,                                  -- earliest final-video completion (null = unknown / not done)
  final_at_raw   text not null default '',                     -- timestamp text exactly as in the file
  latest_at      timestamptz,                                  -- latest completion of any included video
  latest_raw     text not null default '',
  missing        jsonb not null default '[]'::jsonb,           -- names of included videos not completed
  primary key (course_id, email)
);
create index if not exists course_progress_email_idx on course_progress (email);

-- Audit of every publish (no exclusion list stored — count only)
create table if not exists course_uploads (
  id            bigint generated always as identity primary key,
  course_id     text not null references courses(id) on delete cascade,
  at            timestamptz not null default now(),
  by_user       text not null default '',
  files         jsonb not null default '[]'::jsonb,            -- [{fileName,label,rows,videos}]
  stats         jsonb not null default '{}'::jsonb,            -- {rowsIn,students,stored,excluded,noEmail,matchedRoster,matchedOnboarding,notInRoster}
  settings      jsonb not null default '{}'::jsonb             -- final videos, included videos, accepted/rejected statuses, deadline, merge rule
);
create index if not exists course_uploads_course_idx on course_uploads (course_id, at desc);

-- Onboarding learners: completion reporting ONLY, never part of the roster
create table if not exists lms_learners (
  email          text primary key,                             -- lowercase
  display_name   text not null default '',
  district       text not null default '',
  area_manager   text not null default '',
  city           text not null default '',
  supervisor     text not null default '',
  pharmacy_no    text not null default '',
  employee_id    text not null default '',
  note           text not null default '',
  created_at     timestamptz not null default now(),
  created_by     text not null default ''
);

alter table courses         enable row level security;
alter table course_progress enable row level security;
alter table course_uploads  enable row level security;
alter table lms_learners    enable row level security;
```

**Settings keys (existing `settings` table):** `coreCourseId`, `capsuleCourseId` (text course ids or null).

**Leave `pharmacists.completion_pct` and `capsule_pct` in place** (old data, backup), but **stop reading and writing them** (§6.5).

---

## 4. Edge Function (`supabase/functions/api/index.ts`)

### 4.1 Roles

Add `requireReportsAdmin(ctx)`: allows `superadmin` and `coordinator` only, and throws "Reports access required." otherwise. **Trainers are refused** (D18).

### 4.2 New actions

All staff actions write to `activity_log` with `target_kind: "course"` (or `"lms_learner"`).

| Action | Who | Request | Response / behaviour |
|---|---|---|---|
| `coursesList` | reports admin | `{}` | All courses (including inactive), each with its last 10 `course_uploads`, plus `coreCourseId` and `capsuleCourseId`. |
| `courseSave` | reports admin | `{course:{id?,name,source,active,displayName,category,sortOrder,deadline,display}}` | Create (new id `crs_` plus a random part, and a 24-char random `share_slug` from `crypto.getRandomValues`) or update. Validate: name 1–150 chars and unique case-insensitive; source in `moodle`/`sap`; display keys allow-listed. |
| `courseDelete` | **superadmin only** | `{id}` | Deletes the course; its progress and uploads cascade. If it was the Core or Capsule course, clear that setting. |
| `courseShareRotate` | reports admin | `{id}` | New `share_slug`; old links stop working. |
| `courseSlotsSet` | reports admin | `{coreCourseId, capsuleCourseId}` | Each must be an existing course id or null. |
| `coursePublish` | reports admin | `{courseId, rows:[…], files:[…], stats:{…}, settings:{…}, engine:{…}, deadline}` | **Moodle courses only** (refuse SAP in this phase). Validate every row (§4.3). In **one transaction**: delete the course's rows, insert the new ones (one `unnest` or `jsonb_to_recordset` statement), update the course (`engine`, `deadline`, `last_published_*`, `row_count`), insert into `course_uploads`. Cap at 20,000 rows. Return `{ok, stored}`. |
| `courseExport` | reports admin | `{id}` | Full rows for the staff Excel: **unmasked** emails, merged with roster and onboarding fields and flags (same merge as §8.2). |
| `lmsLearnersList` / `lmsLearnersUpsert` / `lmsLearnersDelete` | reports admin | rows by email | Onboarding CRUD. Upsert refuses emails that already exist in `pharmacists` and reports them as "already in roster". |
| `reportsPublic` | **anyone** | `{}` | Active courses with display config and **server-computed aggregates** (§8.1). No learner rows. |
| `reportsPublicCourse` | **anyone** | `{slug}` | One active course's learner rows, **masked** (§8.2). Unknown or inactive slug returns `{ok:false, error:"Report unavailable"}`. |

**Route order:** `reportsPublic` and `reportsPublicCourse` are handled **before** `authenticate()`, like `supervisors` and `company-logo`.

### 4.3 `coursePublish` row validation (server)

- `email`: lowercased, trimmed, matches a basic email pattern, unique within the payload. Rows without email are rejected (the client already drops them and counts them as `noEmail`).
- `state` must be one of the four states. `rate` is in 0..100. `done` and `total` are non-negative integers with `done ≤ total`.
- `final_at` and `latest_at` are ISO strings or null. `final_at_raw`, `latest_raw` and `lms_name` are each at most 200 chars. `missing` is an array of at most 500 strings.
- `final_done = true` requires state `Completed` or `Final video done, others missing`. Otherwise reject.

### 4.4 New read key for the Hub: `course-slots`

Add it to `getKey` and to `COORD_KEYS`. Trainers can read it too: the Attendance tab needs it, and only the *tabs* are reports-admin-only.

```
{ records: [], settings: {
    core:    { courseId, name, lastPublishedAt, byEmail: { "<email>": { s:<state>, r:<rate>, f:<final_at ISO|null>, d:<final_done> } } } | null,
    capsule: { … same … } | null } }
```

- **Staff:** `byEmail` covers every row of the two courses.
- **Supervisor:** `byEmail` is limited to their own pharmacists' emails (join on `pharmacists.supervisor = ctx.who`) and **only `r`** (percentage) is sent (D16).

### 4.5 Changes to existing code

- `getMaster`: stop selecting and returning `completion_pct` / `capsule_pct` (both branches; supervisors currently receive Core % unused).
- `patchMaster`: ignore `completionPct` / `capsulePct` if sent (keep the stored columns untouched).
- Remove `completionCourse`, `completionLastSynced`, `capsuleCourse` and `capsuleLastSynced` from `getConfig` and `COORD_SETTING_KEYS`. With no remaining keys, the coordinator `training-config` patch exception (`coordConfigOk`) can be removed. Keep the coordinator's `operations`, `master-pharmacists` and `group-merges` writes as they are (Attendance-tab features).
- **Backup function** (`supabase/functions/backup/index.ts`): add tabs **Courses**, **Course Progress**, **Course Uploads** and **Onboarding Learners**.

---

## 5. Staff tabs (`trainer.html`, new file `assets/js/reports-admin.js`)

### 5.1 Tab bar and roles

- Add three tabs after "General Configurations": **Moodle Reports**, **SAP Reports**, **Reports Configuration**.
- Add a new class `reports-only`, shown for `superadmin` and `coordinator` and hidden for `trainer`. Do **not** reuse `trainer-only`, whose meaning is "hidden for coordinators".
- **Coordinators:** after D14 their General Configurations tab has nothing left, so hide it for coordinators (`COORD_TABS` = Attendance, Calendar, Analytics (Master Sheet Preview), Moodle Reports, SAP Reports, Reports Configuration).
- Load `xlsx` (upgraded, §10), then `reports-admin.js` after `trainer.js`. All new globals are prefixed `rp` (for example `rpState`, `rpParseAoa`) to avoid collisions.

### 5.2 Moodle Reports tab: a port of every Moodle tool feature

The workflow is laid out as numbered panels, like the original tool.

0. **Course.** A dropdown of tracked **Moodle** courses, active or not, with a link "+ Track a new course" that opens Reports Configuration. It shows the last publish (when, who, rows). Choosing a course loads its saved `engine` settings and `deadline`.
1. **Upload completion sheets.** Drag-and-drop or browse, multiple `.xlsx/.xls/.csv` files. Files with the same signature are skipped. Each file has an editable platform label and a Remove button, plus Remove all. Parsing (Feature 1):
   - Column A is the name. The email column is found with `/e-?mail/i`, defaulting to column B.
   - Each activity is a header cell; a following **blank-header** column is its timestamp.
   - Rows need a name or an email.
2. **Merge (Feature 2).** Students are matched by lowercase email and videos by normalised title. A video counts as done if completed in **any** sheet, using the **earliest** timestamp (`pickDone`).
   - The merge note shows rows → students, how many appear in more than one sheet, and a warning for videos missing from some sheets.
3. **Final video (Feature 3).** One selector per sheet, defaulting to the course's saved `engine.finalVideos` (matched by name), else the rightmost column.
   - "Use the first sheet's final video in every sheet that has it".
   - A note when the final video isn't the last column.
   - Choices are saved to `courses.engine` **on publish**. This replaces the `localStorage` memory.
4. **Statuses counted as completed (Feature 4).** Chips with counts. The default is `/^(complet|done|pass)/i` and not `/\b(not|fail)/i`, overridden by the saved `engine.acceptedStatuses`.
   - "Videos included in the rate", with Select all / Clear all and n/N-sheets coverage, defaulting to all except the saved `engine.excludedVideos`.
5. **Deadline (Feature 7).** Date and time (default 23:59), interpreted as **KSA time (UTC+3)**, saved to `courses.deadline` on publish. Clear button.
6. **Cut-off check (Feature 8).** Date, mode (before / on or before) and basis (final video / every included video). **This is session-only analysis**: shown in the preview and the local Excel, never published.
7. **Exclusions (Feature 9, D4).** A textarea plus an "Upload a sheet of emails" button (any sheet, any column; finds emails and `@domains`).
   - **Not stored anywhere.** It is cleared when the page reloads or the course changes.
   - Excluded rows stay visible but dimmed, tagged "excluded from publish". Note how many excluded entries weren't found.
8. **Onboarding learners (D3).** A collapsible panel:
   - Upload an Excel with the Master Sheet columns (District, Area Manager, City, Supervisor Name, Pharmacy No., User/Employee ID, Username (Email), Display Name (Pharmacist name)), or add one person at a time.
   - Shows the list with delete. Emails already in the roster are refused and listed.
   - Saved through `lmsLearnersUpsert` (persistent, shared by every course).
9. **Preview.**
   - **Stat cards (Feature 6, 10):** students, average rate, Completed, Finished final video, in more than one sheet, On time / Late / Overdue (when there's a deadline), cut-off Yes (when set).
   - **Two more cards:** Matched to roster, Onboarding, Not in roster.
   - **Stats are computed on the non-excluded rows**, which fixes the original tool's mismatch between screen and download.
   - **Toolbar:** search (name/email), State, Source, Schedule, Cut-off and **Roster match** (In roster / Onboarding / Not in roster) filters.
   - **Table:** Name, Email, Source (multi-file), Videos done (tooltip: missing videos), Rate (bar), Final video completed at, State, Schedule, Cut-off, Roster match. Sortable, using the compound sort keys from the spec.
10. **Actions.**
    - **Download Excel (local analysis).** Two sheets, "Completion" and "Settings used" (Feature 11), built with the Hub's styled exporter (§7). Excluded rows are omitted. Auto filename (§7.4).
    - **Publish to course.** A confirm dialog with the summary: rows to store, excluded, no-email dropped, not in roster, and **"This replaces all current data for <course>"**. Then `coursePublish`. On success, show a toast and refresh the course's last-publish line.

**Port, don't copy.** Rewrite the engine as `rp*` functions in `reports-admin.js`, with these fixes:

- **Timestamps.** Use an explicit parser, `rpParseTs(text)`, that accepts:
  - `YYYY-MM-DD HH:MM[:SS]`
  - `D/M/YYYY[ H:MM[ AM|PM]]` (day first)
  - `[Weekday, ]D Month YYYY[, H:MM AM|PM]`
  - Excel serial numbers

  Treat all of them as **KSA local time (UTC+3)** and return epoch milliseconds or null. Read sheets with `raw:true, cellDates:false` so serial numbers aren't reformatted by the browser locale. Keep the raw text for display. **Add unit-style self-checks** (§12).
- The deadline is `deadline date + time + :59 seconds` in KSA, as in the original (inclusive minute). Document this in the UI note.
- Remove `window.claude.use('downloads')`.
- Rows without email are dropped from publish and counted as `noEmail` in the summary.

### 5.3 SAP Reports tab

A centred card: "SAP Reports — Coming Soon", one line saying SAP SuccessFactors Learning completion imports will arrive here, and a list of SAP courses already tracked (from `coursesList`).

### 5.4 Reports Configuration tab

**Card A: Track New Course Completion** (a form plus the courses table)

- **Form fields:**
  - Course name.
  - Source (Moodle / SAP).
  - **Active (visible on the public page)**, default **off** so nothing appears before the first publish.
  - Display name (optional).
  - Category.
  - Display order.
- **Courses table:**
  - Columns: Course, Source, Active toggle, Category, Order, Last published (relative + by), Rows, Deadline, Share link (copy / rotate), Actions.
  - Actions: Edit, **Download data**, Open in Moodle Reports, Delete (superadmin only, with confirm).
- **Download data** calls `courseExport`, then the Hub's styled Excel with the auto filename (§7.4).
  - **Columns:** Name, Email, District, Area Manager, City, Supervisor, Roster match (Roster / Onboarding / Not in roster / No completion data), Videos completed, Total videos, Completion rate %, State, Final video completed at, Latest completion (any video), Deadline, Schedule, Days late/overdue.
  - **Second sheet "Settings used":** taken from the last `course_uploads` row.
- **Validation:**
  - An active course with no publish yet shows a warning chip "No data yet".
  - The public page shows it as "No data published yet".

**Card B: What the public page shows** (per course, opened from Edit)

- **Visible columns:** checkboxes, all on by default. #, District, Area Manager, City, Supervisor, Email (masked), Name, Completion rate, State, Completion date, Days Left.
- **Show deadline**, **Show Days Left**.
- **Show roster people with no completion data:** on = the whole roster appears, with people missing from the upload labelled "No completion data"; off = only people in the uploaded file.
- Store all of these in `courses.display`. Keep unknown keys when saving so later options can be added.

**Card C: Hub columns (Core / Capsule)** (D12)

- Two dropdowns, **Core course** and **Capsule course**, listing all tracked courses plus "— none —". Saved with `courseSlotsSet`.
- Show each slot's last publish.

---

## 6. Hub changes outside the new tabs

### 6.1 Attendance tab: Core and Capsule columns (`trainer.js`, `common.js`)

- In `loadCoreData`, add `course-slots` to the `getSharedMany` keys and keep it in a global, `courseSlots`.
- Replace `completionCellHtml(p, key)` with `courseSlotCellHtml(p, 'core'|'capsule')`. Look up `courseSlots[slot].byEmail[lower(p.email)]`:
  - `d === true`, `f` set: `✔ 5 Oct 26` (`--ok`). **Red** (`--danger`) and tooltip "Finished after the training day" when `f` is after the pharmacist's assigned training day (`dayById(ops.assignments[p.id].dateId).date`, day 1 for split; ignore when unassigned or on leave).
  - `d === true`, `f` null: `✔ Completed (no date)`.
  - `d === false`: the current bar and % (`r`).
  - No entry: `—`.
- Header tooltip: "Core = <course name> · published <date>".
- **Sort** (D17): `getSortValue` for `core` / `capsule` returns a tuple-like number. Finished with a date sort as `0`-band by date ascending, finished without a date go next, then in progress by rate descending, then none.
- **Exports** (D15, coordinator full export, `trainer.js` around line 3752): text `Completed 5 Oct 26` / `Completed (no date)` / `45%` / blank. The trainer's export still skips these columns.
- **Edit Selected grid** (`trainer.js` around lines 2833, 2880 and 2934): remove the `completionPct` field and its validation.

### 6.2 General Configurations

Remove the **Import Completion** card from `trainer.html` (lines 131–155) and these functions: `handleCompletionUpload`, `apsFetch`, `extractLearnerRate`, `COMPLETION_KINDS`, `courseKey`, `completionStatusText`, `loadCompletionCourseList` and `syncCompletionFromCourse`, plus their call sites. Add a small read-only card instead: "Course completion now comes from **Reports Configuration → Hub columns**. Core: <name> (published <date>) · Capsule: <name> (published <date>)."

### 6.3 Supervisor page (D16)

- `supervisor.html` / `supervisor.js`: add **Core %** and **Capsule %** columns (bar plus %, `—` when there's no data), keeping `<thead>` and the row template in sync.
- Include both columns in the supervisor Excel export (S-17).
- Data comes from `course-slots` (supervisor-scoped, percentage only).

### 6.4 Config and landing

- `config.js`: delete `COMPLETION_REPORTS_URL` and `LINKS.progressReports`.
- `index.html`: the "Course Progress Reports" card now links to **`reports.html`** (same tab, not external). Update its text to "Live course completion across the pharmacy network".

### 6.5 Old completion columns

`pharmacists.completion_pct` and `capsule_pct` stay in the schema but are no longer read, written or exported. Note this in `PROJECT_HANDOFF.md`.

---

## 7. Shared front-end utilities (`common.js`)

### 7.1 Excel exporter

- Extend `downloadStyledXlsx` to accept `opts.autoName` (skip `promptForFilename`) and **multiple sheets**: `sheets:[{name, headers, rows, colWidths, opts}]`.
- Keep the style counts consistent. The current `buildStylesXml_` is correct, so extend it carefully and update every `count=` attribute.
- Add styles for status cells: Completed, In progress, Not started, Not in roster, No completion data.

### 7.2 Image / PDF

Reuse `exportTableImage` and the jsPDF path for the public page.

### 7.3 Filters

Reuse `registerFilterFacets` / `narrowMsOptions` (cascading multi-select) on the public page and in Moodle Reports.

### 7.4 Auto filename (D8)

```js
// "10 Oct 26 - 1 PM - <Course Name> - Moodle.xlsx" — Windows-safe
function reportFileName(courseName, source, ext, d){
  d = d || new Date(); ext = ext || 'xlsx';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const stamp = `${d.getDate()} ${M[d.getMonth()]} ${String(d.getFullYear()).slice(-2)} - ${h} ${ap}`;
  const src = String(source).toLowerCase() === 'sap' ? 'SAP' : 'Moodle';
  const clean = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ')
                                    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  let base = `${stamp} - ${clean(courseName) || 'Course'} - ${src}`;
  if (base.length > 150) base = base.slice(0, 150).replace(/[. ]+$/, '');
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(base)) base = '_' + base;
  return `${base}.${ext}`;
}
```

Uses the computer's local time. Use it for every completion export: staff Excel, the Moodle local Excel, and the public page's Excel, Image and PDF (with `png` / `pdf`).

---

## 8. Public page `reports.html` + `assets/js/reports.js`

It follows the old dashboard's components and behaviour, styled with the Hub's `app.css` tokens. Loads: `xlsx` is **not** needed. Load `jszip`, `html2canvas`, `jspdf`, `config.js`, `api.js` (`API.init('public')`, which sends no token and no supervisor), the needed parts of `common.js`, then `reports.js`. Add `<meta name="robots" content="noindex,nofollow">`.

### 8.1 `reportsPublic` (overview) payload

```
{ ok, generatedAt, courses: [ { slug, title, category, order, source, lastPublishedAt, deadline|null (if showDeadline),
     display:{columns, showDeadline, showDaysLeft, includeRosterNoData},
     agg:{ total, completed, finalOnly, inProgress, notStarted, noData, notInRoster, onboarding, avgRate } } ] }
```

Aggregates are computed on the server with the same merge as §8.2. **No names or emails in this call.**

### 8.2 `reportsPublicCourse {slug}`: rows and merge rule (server)

Population:
- `course_progress` rows, plus
- if `includeRosterNoData`: every `pharmacists` row with `display_name <> ''` and a non-empty email not in progress (state **"No completion data"**), plus
- `lms_learners` rows with progress.

Each progress row resolves its person:
1. `pharmacists` by email (roster wins).
2. Else `lms_learners` (flag **Onboarding**).
3. Else flag **Not in roster** (org fields `—`, name = `lms_name`).

Row shape:

```
{ n:<display name>, e:<masked email>, di, am, ci, su, r:<rate|null>, s:<state>, f:<final_at ISO|null>, fd:<final_done>, fl:'roster'|'onboarding'|'not_in_roster' }
```

### 8.3 Security hardening (the most secure option that keeps the page fully public)

1. **Separate read-only actions.** Only SELECTs, and only for `active = true` courses. They never return phone, SCFHS, employee ID, pharmacy no., notes, attendance, assignments or history.
2. **Masked emails.** The server returns `ab•••@domain.com` (first two characters of the local part, then `•••`). Full emails exist only in the staff export (`courseExport`). Public search is by **name** only.
3. **Unguessable share links.** `reports.html?c=<share_slug>` (24 random URL-safe characters). Course names never appear in URLs. **Rotate** in Configuration to kill old links. Inactive or rotated slugs show "Report unavailable".
4. **No enumeration of learners.** `reportsPublic` returns aggregates only. Learner rows need a valid slug of an active course (slugs are listed for active courses so the dropdown works, which is acceptable because active means published).
5. **Rate limit.** Per IP (first `x-forwarded-for` value), 30 public requests per minute in `kv_cache` (`rl:<ip>:<minute>`). Over the limit returns `{ok:false, error:"Too many requests — try again in a minute"}`.
6. **Short server cache.** Cache public responses in a module-level `Map` for 60 s per key (`overview`, `course:<slug>`). Publishing doesn't need to bust it; staleness is at most 60 s. Show "Data as of <time>".
7. **Payload discipline.** Short keys and only the columns enabled in `display.columns`. For example, if Email is hidden in Configuration, `e` is not sent at all. **Server-side column filtering, not just hiding in CSS.**
8. **The browser cache** (offline fallback, `localStorage['upc:reports-cache']`) stores only the masked payload.
9. **Activity log:** do not log public reads (volume). Do log rate-limit hits as a daily counter in `kv_cache` if cheap.

### 8.4 Features: parity with the old dashboard

| Old dashboard feature | New behaviour |
|---|---|
| Header with logo and 4 stat chips | The same. Chips show **Total / Finished / In progress / Not started**, plus a small chip each for No completion data and Not in roster when non-zero. On the overview, the label is "Enrolments" (sum across courses). |
| Source banner | "Live · data as of HH:MM", or "Offline — showing saved copy" (cached masked data), and "Updated Xh ago" per course from `lastPublishedAt`. |
| Course dropdown | Overview plus active courses, grouped by category when there are 2 or more categories, ordered by `sort_order` then title, with counts and "Updated X ago". |
| Overview cards | One per course: Finished / In progress / Not started / Total, average completion bar, deadline (if shown), last published. Click to open the course. |
| Course table | Columns from `display.columns`: #, District, Area Manager, City (badge), Supervisor, Name, Email (masked), Completion rate (bar), State (tag), Completion date (`final_at`, `DD-Mon-YY`), Days Left. Badges: **Onboarding**, **Not in roster**, **No completion data**. |
| Search | By name (debounced 200 ms). |
| Cascading multi-select filters | District, Area Manager, City, Supervisor, **State** (Completed / Final video done / In progress / Not started / No completion data / Not in roster), **Roster match**, Completion date. In-panel search, Select all / Clear, badges, Clear all. |
| Days Left (D10) | Uses the course deadline. Finished = **Done**. No deadline = `—`. Past = **Overdue** (`row-overdue`). Today = **Today!**. 3 days or less = critical (`row-critical`). 7 days or less = warning. More than 7 = ok. Hidden when `showDaysLeft` is off. |
| Sort | Every column, with **chronological** date sorting. Default: rate descending. |
| Exports | Excel (Hub styled exporter, filtered rows, **current sort**, rate stored as a number), Image, PDF. All use `reportFileName(course, source, ext)`. |
| Share link | Copies `reports.html?c=<slug>`. In **locked mode** the dropdown is hidden and the page shows only that course, with a 🔒 banner "Shared report · updated …". |
| Offline fallback | The last masked payload from `localStorage`. |
| Print styles | `.no-print`, colour-exact. |
| Legend | Finished / In progress / Not started / No data. |

Also: **Mobile layout** at 16 px gutters (table scrolls horizontally, using `attachFloatingScrollbar`), and **all `innerHTML` values pass through `esc()`**. This fixes the old XSS in filter panels.

Status buckets on this page: **Finished** = Completed + Final video done, others missing (shown as two tags but counted together in chips). **In progress** = rate > 0, not finished. **Not started** = rate 0. **No completion data** and **Not in roster** are separate.

---

## 9. Retirement of the old stack (after parity sign-off)

1. Export each course tab of the old Google Sheet to `.xlsx`. Create a tracked course in Configuration for each and publish it through **Moodle Reports**; the layout is the same as Moodle exports.
2. Compare counts with the old dashboard per course (see §12).
3. Point the old dashboard's URL (`upc-talent.github.io/LMS-reporting/`) to a one-line page: "Moved → <Hub>/reports.html" (the owner does this in that repo).
4. **Archive the Apps Script deployment** and set the old Sheet to **Restricted**. Its URL was public, so it exposes the whole roster until it is archived.

---

## 10. Libraries

- Replace `assets/vendor/xlsx.full.min.js` (currently SheetJS **0.18.5**) with **0.20.3** from `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`, vendored, to fix CVE-2023-30533 and CVE-2024-22363. Re-test the Master upload, Calendar import, Bulk Add and the new Moodle upload.
- No new libraries.

---

## 11. Build phases and deploy order

| Phase | Work | Deploy |
|---|---|---|
| **1. Database** | §3 SQL | Run in the Supabase SQL Editor **first**. |
| **2. Backend** | §4 (new actions, `course-slots`, `getMaster` / `patchMaster` / `getConfig` changes, backup tabs) | Deploy `api`, then `backup`. The old front end keeps working: unknown keys are ignored, and the Core/Capsule columns show `—` until phase 4. |
| **3. Staff tabs** | §5, §7, §10 | GitHub Pages. |
| **4. Hub columns** | §6.1–§6.3, §6.5 | GitHub Pages. Assign the Core and Capsule courses in Configuration right after. |
| **5. Public page** | §8 and the §6.4 landing link | GitHub Pages. |
| **6. Migration and retirement** | §9 | Manual. |

Update `README.md`, `docs/PROJECT_HANDOFF.md` (new "v5 — Reports" section, new tables, actions, roles) and `supabase/README.md` (new SQL, backup tabs).

---

## 12. Test checklist

**Engine** (add `rpSelfTest()` runnable from the console with `?debug=1`):
- [ ] `Test@x.com` and `test@x.com` merge into one student.
- [ ] Video 1 completed in June on platform A and in May on platform B keeps **May**.
- [ ] "Completed" with a blank timestamp gives `Completed (date unknown)` / `✔ Completed (no date)`.
- [ ] `rpParseTs` reads `2026-10-05 14:30`, `5/10/2026 2:30 PM` (5 October), `Monday, 5 October 2026, 2:30 PM` and the Excel serial `46300.6`, all as KSA time.
- [ ] Deadline 2026-10-05 23:59: a completion at 23:59:30 is On time; at 2026-10-06 00:00:10 it is Late by 1 day.
- [ ] Cut-off "before" and "on or before" behave as specified, for both bases.
- [ ] `@domain` exclusion removes every matching row from the stats, the publish and the local Excel.

**Publish and database:**
- [ ] Publishing twice leaves only the second dataset; `course_uploads` has 2 rows; no exclusion list is stored anywhere.
- [ ] A trainer token calling `coursePublish` or `courseSave` is refused; coordinator and superadmin succeed; a coordinator calling `courseDelete` is refused.
- [ ] An onboarding learner never appears in `supervisors`, the Attendance tab, the Master Sheet or Analytics. After the same email is added to the roster, reports show them as roster.

**Hub:**
- [ ] Core/Capsule cells: finished shows the date, red when after the training day; in progress shows %; no data shows `—`. Sort order is as D17. The coordinator export text is as D15.
- [ ] Reassigning the Core course in Configuration changes the Attendance column after a reload.
- [ ] A supervisor sees only their own pharmacists' Core % and Capsule %. The network response has no other emails and no dates.
- [ ] No reference to `script.google.com` remains in the repo (`grep`).

**Public page:**
- [ ] An inactive course is absent from the dropdown, and its share link says "Report unavailable". A rotated slug is dead.
- [ ] Emails are masked in the network responses (not only on screen). A hidden column's field is absent from the payload.
- [ ] The 31st request in a minute from one IP gets the rate-limit message.
- [ ] Per-course totals equal the table row count. Filters cascade. Days Left is correct in Chrome **and** Safari (ISO dates only).
- [ ] The Excel opens in Excel without a repair prompt. The filename looks like `9 Oct 26 - 6 PM - <Course> - Moodle.xlsx`, and a course name containing `: / ? *` is sanitised.
- [ ] The phone width (375 px) has no horizontal page scroll.

---

## 13. Open items (do not block the build)

- **A sample real Moodle export** is needed to confirm the timestamp formats for `rpParseTs`. Ask the owner before finalising the parser.
- **Brand palette.** The Hub still uses `#003261` / `#2FB3DF`, but the official UPC palette is `#223974` / `#188CCD` / `#F8991D` / `#00A99B`. This is a separate decision, so don't change it in this work.
- **SAP import path:** phase 2, once SF Learning export formats are known.
