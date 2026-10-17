# Talent Operations Center — feature and logic catalogue (v7.5, Oct 2026)

Every feature has an ID, so you can say "bug in T-A3" or "change S-11".

| Prefix | Area |
|---|---|
| `P-` | Platform |
| `S-` | Supervisor page |
| `T-A` | Admins Dashboard: Attendance |
| `T-D` | Admins Dashboard: Training Days Setup |
| `T-C` | Admins Dashboard: Calendar |
| `T-P` | Admins Dashboard: Approvals |
| `T-X` | Admins Dashboard: Analytics & Export |
| `T-G` | Admins Dashboard: General Configurations |
| `RP-` | Reports (staff) |
| `PUB-` | Public reports page |
| `SA-` | Superadmin |
| `R-` | Rules that cut across screens |
| `B-` | Backend |

The **logic** behind the rules is in §11.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| Training Day / Group | One scheduled session. Days with the same city and date for different supervisors are same-date groups. |
| Date slot | A pharmacist's Date cell: a training day, a leave status (Sick / Annual Leave, Resignation, Promotion), or Not Assigned. |
| Split training | An online training over 2 days, with Day 1 and Day 2 attendance. |
| Submit / Lock | The supervisor locks their choices with Submit; a locked pharmacist changes only through Request Change, or when the training team unsubmits them. |
| Managed day | A day that is visible to a supervisor but not Editable for them. |
| Retraining | A new booking after a missed attempt; the missed attempt is kept in the pharmacist's history. |
| Merge | Two or more parallel online groups run as one session. |
| Tracked course | A course in Reports Configuration (Moodle or SAP). |
| Publish | Saving the computed completion rows of a course; replaces its data. |
| Not in roster | A person in course data whose email isn't in the roster. They can be hidden from the reports. |
| Permission | One switch in Admins Permissions (a tab, a section or an action) for one account. |

---

## 2. Platform (P)

- **P-1 Landing page.** Supervisor card; Course Progress Reports (opens `reports.html`); Admins Dashboard icon bottom-right.
- **P-2 Users.**
  - Superadmin, trainers and coordinators come from `STAFF_ACCOUNTS`, plus trainers and coordinators the superadmin adds in the app.
  - Supervisors pick their name, with no password.
- **P-3 Sync pill** (Retrieving / Sending / Saved).
- **P-4 Optimistic saving.** The screen updates first and the save happens in the background; values the server stores are applied back.
- **P-5 Supervisors online** counter (needs the `presence.view` permission).
- **P-6 Cascading multi-select filters** on every table: each filter lists only the values present among the rows matching the other filters.
- **P-7 Pinned sideways scrollbar** for wide tables.
- **P-8 Names and emails** are never cut off.
- **P-9 Exports.**
  - Styled Excel: multi-sheet, automatic file names, real numbers, coloured statuses.
  - Image and PDF: the whole table at full width, on any screen or phone (v7.3). Very long tables come out smaller so the browser can still make the image.
- **P-10 Hidden days.** 👁 / an eye-with-a-slash icon; 🚫 after hidden days in dropdowns.
- **P-11 Custom pop-ups** and toasts.
- **P-12 Named accounts.**
  - Passwords are stored as PBKDF2 hashes.
  - 8 wrong tries lock that username for 10 minutes.
- **P-13 Sign-in page.**
  - Two-panel design, show / hide password, Caps Lock warning.
  - **Keep me signed in for 6 days** (otherwise 10 hours).
- **P-14 Change password** (🔑 in the top bar, every admin).
  - The current password is checked; the new one needs 10+ characters with a letter and a number, and must not contain the username.
  - All other sessions are signed out.
- **P-15 Full-width layout.**
  - Responsive gutter; the tab bar scrolls sideways on narrow screens.
  - The bulk bar sticks while scrolling.

## 3. Supervisor page (S)

- **S-1** Name picker.
- **S-2** Offline / Online tabs.
- **S-3** Day cards.
- **S-4** Status cards.
- **S-5** Other counts.
- **S-6** Filters: District, Area Manager, City, Date. The Retraining filter was removed in v6.
- **S-7 Pharmacist list.** Name, Pharmacy No., Email, Date, Attendance, Work Shift, Notes. Core % / Capsule % were removed in v6.
- **S-8** Date dropdown.
- **S-9** Work Shift.
- **S-10** Bulk assign.
- **S-11 Submit.**
  - Locks what is filled; empty rows stay open.
  - People booked on a training day need a Work Shift first.
- **S-12 Lock notes.**
  - 🔒 Attended / Submitted / Managed.
  - "↻ Missed the training — use Request Change" for a locked absent pharmacist.
- **S-13 Request Change.**
  - Only for submitted or managed pharmacists, including absent ones.
  - Target days follow each pharmacist's own online / physical type.
- **S-14** Add / Bulk Add new pharmacists (needs approval).
- **S-15** Over-quota bookings wait for approval.
- **S-16** Submission History.
- **S-17** Exports.
- **S-18** Bulk Annual Leave (dormant, no button).
- **S-19 Request Data Edit.** Name, email, pharmacy no., employee ID, phone, SCFHS, city / online ↔ physical.

## 4. Admins Dashboard — Attendance (T-A)

- **T-A1 Filters.**
  - District, Area Manager, City, Supervisor, Date, **Attendance** (On Time, Late, Absent, Partial, Day 1 only, Not marked, No training day), Retraining.
- **T-A2 Columns.** City, Supervisor, Date, Email, Name, Core, Capsule (`attend.coreCapsule`), Attendance, Notes.
- **T-A3** Mark attendance one by one: Attended / Absent (optional reason) / Late with a time / Clear.
- **T-A4** Split attendance rules (see R-3).
- **T-A5** Session card.
- **T-A6** Date dropdown, with the ↻ Retraining badge and attempt history.
- **T-A7 Bulk bar.** Assign, **✔ Mark attendance**, **🔓 Unsubmit**, Delete from roster. Each action shows only with its permission.
- **T-A8** Edit Selected (details of ticked pharmacists).
- **T-A9** Group Mix-up banner.
- **T-A10** Notes.
- **T-A11 Exports.**
  - Short version by default.
  - Full version (completion, attendance, late time, notes) with `attend.exportFull`.
- **T-A12** Group Merge and the Merged Groups card.
- **T-A13 Bulk Mark attendance.**
  - Options: Day 1 / Day 2 / both Attended, Day 1 / Day 2 / both Absent, with an optional reason.
  - One-day trainings use the Day 1 options.
  - People with no training day are skipped, with a report of who was skipped and why.
- **T-A14 Submitted tag and Unsubmit.**
  - "🔒 Submitted · Unsubmit" in the Date cell.
  - Hands the choice back to the supervisor; their date stays.
- **T-A15 Headcount sheet (v7.4).** Like PUB-8, for every account that sees the Attendance tab.
  - **Upload Headcount Sheet:** an Excel or CSV with an Email (or Username) column, read in the browser only and kept until the page is reloaded.
  - **Headcount only:** the table, the filter lists, bulk selection and the exports show just the roster pharmacists whose email is in the sheet. **Everyone** shows the whole roster.
  - **Not in roster (n):** sheet emails that no pharmacist has, with the name and supervisor from the sheet, and Copy emails.
  - Clear Filters keeps the sheet; **Remove file** drops it.

## 5. Training Days (T-D), Calendar (T-C), Approvals (T-P), Analytics (T-X), General Configurations (T-G)

- **T-D** Training days table and bulk actions (hide / unhide / deadline / supervisors / capacity / staff / city / delete); 🔗 merged badges.
- **T-D Visible / Editable** per supervisor on each day (Editable off = managed day).
- **T-C** Quarter calendar: add, import a planning sheet, drag to reschedule, undo / redo; analytics under the calendar.
- **T-P1** Supervisor Submissions: Seen, **🔓 Unsubmit…** (pick days or statuses), and a Partial tag.
- **T-P2** Date Change Requests.
- **T-P3** Over-quota bookings.
- **T-P4** Annual Leave requests.
- **T-P5** New pharmacists.
- **T-P6** Decision History.
- **T-P7** Data Edit Requests: apply the ticked changes or reject.
- **T-X Overview panel.**
  - Cascading filters: District, Area Manager, City, Supervisor, Type, Date, Attendance, Work Shift, Retraining.
  - Status cards, including the Adherence Rate.
  - Master Sheet Preview with Excel / Image / PDF.
- **T-X Breakdown** (by City / District / Area Manager / Supervisor) sits below the Overview and follows its filters.
- **T-G1** Master Pharmacist Data upload; the file format matches the Master Sheet export.
- **T-G2** Course Completion line (read-only).
- **T-G3** Capacity.
- **T-G4** Trainers and Coordinators rosters.
- **T-G5** Training names.
- **T-G6** City Roster.
- **T-G7** Logo.

## 6. Reports — staff (RP)

- **RP-1 Moodle Reports.**
  - Steps: 0 Course · 1 Upload (several sheets) · 2 Merge note · 3 Final video per sheet · 4 Counted statuses & included videos · 5 Deadline (KSA) · 6 Cut-off check (session only) · 7 Exclusions (never stored) · **8 People not in the roster** · 9 Preview · 10 Local Excel & Publish.
  - The preview warns about unreadable timestamps.
- **RP-2 Section 8: People not in the roster.**
  - Everyone in any published course whose email isn't in the roster, with their courses.
  - Search; Everyone / Shown / Hidden; bulk **Hide from reports** / **Unhide**; **Download list**.
- **RP-3** SAP Reports: "Coming soon" plus the list of tracked SAP courses.
- **RP-4 Reports Configuration.**
  - Track and edit courses: name, source, display name, category, order, Active.
  - Card colours: Accent, Card fill, Text. Choose from presets, the colour wheel, or a typed **hex or RGB** code, with a live preview. An empty colour = "Use category colour".
  - What the public page shows: columns, deadline, Days Left, roster people with no data.
  - Tracked courses table: colour dot, share link copy / renew, Download data, Open in Moodle Reports, Delete (`repconf.delete`).
  - **Category colours:** one set per category with an Edit colours pop-up, which can also clear courses' own colours so the whole category follows.
  - Hub columns: the Core and Capsule courses.
- **RP-5** `rpSelfTest()` (23 engine checks, runs with `?debug=1`).

## 7. Public reports page (PUB) — `reports.html`, no sign-in

- **PUB-1** Live / Offline status bar with Refresh.
- **PUB-2** View picker (Overview or one course) with a count badge.
- **PUB-3 Course cards.**
  - Modules badge, Done / In progress / Not started / Total, completion bar, Updated.
  - **Course or category colours.**
- **PUB-4 Course view.**
  - Summary card in the course's colours.
  - Table with the columns switched on.
  - Badges: Not in roster, No completion data, Not in course data.
- **PUB-5 Toolbar.**
  - Search.
  - Filters: District, Area Manager, City, Supervisor, **Completion Date**, **Training Date**, Status, Roster match.
  - Clear all; Share link; Excel; PDF; Image.
- **PUB-6** Share links: one locked course; "Report unavailable" when switched off or renewed.
- **PUB-7** Offline copy (last 8 courses), print layout, phone layout.
- **PUB-8 Upload Headcount Sheet.**
  - The file is read in the browser only.
  - **Headcount only** shows just the people in the sheet; people missing from the course data are listed with details from the sheet.
  - **Everyone** shows the normal view.
  - Needs the Email column.

## 8. Superadmin (SA)

- **SA-1 Activity Log.** Every sign-in and change, with before → after values. It can't be edited and is copied hourly to the backup Sheet.
- **SA-2 Admins Permissions.** Per-account switches for every tab, section and action. Role defaults reproduce the original access.
- **SA-3 Reset password** (a forgotten password). The superadmin has one generated or types it themselves (v7.5). It is shown once, with the sign-in username; the person must change it at the next sign-in. Other sessions are signed out.
- **SA-4** Sign out everywhere.
- **SA-5 + Add user** (trainer or coordinator), with an optional display name. The temporary password is generated or typed (v7.5), shown once and must be changed at first sign-in.
- **SA-6** Switch an account off / on (not your own, not superadmins).
- **SA-7** Delete an app-made account.
- **SA-8 Name & username (v7.5)**, for any account, including the superadmin's own.
  - **Display name:** shown instead of the username in the top bar, Admins Permissions, the Activity Log and "merged by", also on past entries.
  - **Sign-in username:** what the person types to sign in. Changing it signs them out everywhere (not for your own account) and the old one stops working. Typing the original username goes back to it.
  - The original username stays the account's fixed id, so its permissions, history and stamps stay attached.

## 9. Default access by role

| | Superadmin | Trainer | Coordinator |
|---|---|---|---|
| Attendance (all actions) | ✔ | ✔ (short exports) | ✔ (full exports) |
| Unsubmit | ✔ | ✔ | — |
| Training Days, Calendar edit, Approvals, General Configurations, Analytics cards | ✔ | ✔ | — (Calendar view only; Analytics = filters + Master Sheet Preview) |
| Moodle Reports, SAP Reports, Reports Configuration | ✔ | — | ✔ (no course delete) |
| Supervisors online | ✔ | ✔ | — |
| Activity Log, Admins Permissions | ✔ | — | — |

The superadmin can change any of this per account.

## 10. Backend (B)

- **B-1 Edge Function `api`.** The only door to the data.
  - Public actions: `login`, `supervisors`, `company-logo`, `reportsPublic`, `reportsPublicCourse`.
  - Everything else needs a staff token or a supervisor name.
- **B-2 Tables.** `pharmacists`, `training_days`, `approvals`, `notifications`, `settings`, `venues`, `kv_cache`, `activity_log`, `courses`, `course_progress`, `course_uploads`, `lms_learners` (old data, unused), `report_hidden`, `staff_accounts`.
- **B-3 Hourly backup** (`backup` function + pg_cron) to a Google Sheet.
  - One tab per table.
  - A Log tab, an Activity tab (append-only), the report tabs, Hidden From Reports, and Admin Accounts (no password hashes).
- **B-4 Secrets.** `STAFF_ACCOUNTS`, `TOKEN_SECRET`, `BACKUP_SECRET`, `GOOGLE_SERVICE_ACCOUNT`, `BACKUP_SHEET_ID`.

---

## 11. Logic catalogue

### R-1 Locks
- **Attended:** only the training team can change the pharmacist.
- **Submitted:** `assignment.locked`; change only through Request Change, or the training team unsubmits.
- **Managed day:** a supervisor in a day's `readOnlySupervisors` can't book onto it or move off it.
- **No-date slot:** when every day the supervisor can see for that type is managed, the whole slot is locked.
- **The lock always wins (v6),** also for absent pharmacists. An *unlocked* absent pharmacist on an editable day can still be rebooked directly.
- **Unsubmit (v7)** removes `locked`, but not the managed-day rule. Attended pharmacists can't be unsubmitted.
- **Trainer changes keep the lock.**

### R-2 Visibility and booking
- **Hidden days** are hidden from supervisors only.
- **Supervisor bookings are checked:** day active and visible, online ↔ physical match, deadline not passed, capacity, quota (over quota = pending approval).

### R-3 Split attendance
- Day 2 can be Attended only if Day 1 is.
- Day 1 Absent marks Day 2 Absent.
- One day attended + the other Absent = **Partial** (failed).
- Day 1 attended + Day 2 not marked = in progress.

### R-4 Retraining
- A failed pharmacist moved to another date, a leave or no date has the attempt archived in `history`.
- The new booking is marked `retraining {attempt, originalDate}`.
- Not when moved to another group on the same date (that is a mix-up fix).

### R-5 Adherence
- Attended ÷ invited.
- Every booking on a day already held counts, including retrainings.
- Partial doesn't count as attended.

### R-6 Merge
- Online days only, same date, at least 2; a day can be in only one active merge.
- Attendance stays per day; the total attendees figure is typed in.

### R-7 Data edit
- Only the pharmacist's own fields; partial approval.
- A duplicate email is refused.
- An online ↔ physical switch clears a booked day of the other kind.

### R-8 Accounts and sessions
- **Accounts** = `STAFF_ACCOUNTS` (wins on a clash) + app-made accounts. Each keeps its original username as a fixed id; a display name and a different sign-in username are optional (v7.5). Usernames and sign-in usernames are unique ignoring case.
- **Passwords:** a chosen password replaces the secret's hash. PBKDF2-SHA256, 150k rounds.
- **Tokens:** HMAC-signed `{u, r, v:2, sv, rm, e}`, valid 10 h, or 144 h with "Keep me signed in".
- **Each request** re-checks: account exists, same role, not switched off, session version matches.
- **Must-change:** while set, only `me` and `changePassword` are allowed.

### R-9 Permissions
- **Effective permissions** = role defaults + the account's overrides. A tab off turns off its children. The superadmin always has everything.
- **Server writes** accept any permission whose screen makes that kind of change (`checkWritePerms`).

### R-10 Moodle engine
- **Merging sheets:**
  - Students are merged across sheets by lowercase email; videos by normalised title.
  - A video counts as done if it is done in any sheet; the earliest readable time wins.
  - One final video per sheet.
- **States:** Completed / Final video done, others missing / In progress / Not started.
- **Timestamps** are read in KSA. An unreadable one gives "Completed (date unknown)", never On time or Late.
- **Deadline** = date + time + 59 s.
- **Exclusions** are never stored.

### R-11 Publish
- The server validates every row (up to 20,000 rows).
- It replaces the course's rows in one transaction and recounts the roster match itself.

### R-12 Roster match
- The roster (by email) wins; otherwise the person is **Not in roster**.
- Optional "No completion data" rows for roster people missing from the upload.
- **Hidden** people (not in the roster) are left out of the public page's tables and counts.

### R-13 Public security
- Public actions run before authentication.
- Limited to 30 requests per minute per IP; cached for 60 s.
- Only active courses; only the enabled columns are sent.
- Random 24-character share link, which can be renewed.

### R-14 Public buckets and Days Left
- **Done** = Completed + Final video done.
- **In progress** = rate above 0.
- **Not started** = rate 0, plus people with no data.
- **Days Left** in KSA calendar days: Done / Today! / ≤3 critical / ≤7 warning / Overdue.

### R-15 Training Date (public)
- The booked training day of each roster person, whether the day is visible or hidden.
- Label: training name (online) or city, then the date.

### R-16 Card colours
- **Accent:** band, title, button, bar.
- **Fill:** background; the number boxes stay white.
- **Text:** a colour, or auto black / white by contrast.
- **Precedence:** course colour → category colour → default, decided per colour.
