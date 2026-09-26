# Talent Operations Center — work summary (Sept 2026)

A record of every change made in this round of work: what was wrong, what was changed, how it was
verified, and what is still open. For how the system works *today*, see
[PROJECT_HANDOFF.md](PROJECT_HANDOFF.md); for backend setup, see [../supabase/README.md](../supabase/README.md).

---

## At a glance

| # | Change | Result |
|---|---|---|
| 1 | Trainer table: redraw one row instead of all ~1,450 | A click's redraw went from **~600 ms → 0.06 ms** |
| 2 | Day dropdowns built on first open, not up front | **87,000 → 1,450** `<option>` elements; full render **~600 → 76 ms** |
| 3 | Moved the database from Google Sheets to **Supabase** (Postgres) | Requests **~1–2 s → ~0.5–0.8 s**; 1,456 pharmacists copied over |
| 4 | Database connection pooler | Cut per-request database overhead |
| 5 | **Optimistic saves** (screen first, save in background) | A click shows its result in **0–1 ms**; 6 fast clicks → 2 requests |
| 6 | Status pill ("Sending… / Saved") stays visible while scrolling | Pinned bottom-left |
| 7 | **Bulk actions** with checkboxes (trainer + supervisor) | Assign / leave / unassign / delete pharmacists; hide / unhide / delete days |
| 8 | Server query audit | Writes read 1 row instead of 1,456; bulk writes in 1 statement |
| 9 | **Quotas on in-person days** (were online-only) | Set and enforced on every day |
| 10 | Removed Google Sheets completely | Supabase is the only source of truth |

Numbers in rows 1–2 and 5 were measured in the browser at full roster size (1,450 pharmacists × 55 days).
Network numbers vary with location; see "Measured results" below.

---

## 1. Front-end speed: the trainer table

**Problem.** Every attendance click (Attended, Absent, On Time, Late, Clear) redrew the *whole* trainer
table. Each of the ~1,450 rows carried its own dropdown listing all ~55 training days, so one redraw built
about **87,000 dropdown options** and took ~0.6–1.1 s — on every click.

**Changes** (`assets/js/trainer.js`, `assets/js/common.js`)
- **Single-row updates.** The row's HTML now comes from one shared function, `trainerRowCells()`, used by
  both the full render and a new `updateTrainerRow()`. Because both use the same template, a row refreshed
  on its own can never differ from a full redraw. `afterTrainerRowChange()` falls back to a full redraw only
  when the table is sorted by Attendance, the one case where a mark can reorder rows.
- **Lazy dropdowns.** Each day dropdown now starts with just its current value and fills in the full day
  list the first time it is opened (`fillAssignSelect()`). What the closed dropdown shows is unchanged.
- **Day index.** `dayById()` replaces repeated `trainingConfig.dates.find(...)` scans in rendering and
  sorting.

Assignment changes still redraw the full table, because they can change which rows match the filters.

## 2. Google Apps Script tweak (historical)

While the Sheet was still the database, attendance saves were also reading and rewriting the over-quota
list in the Approvals tab. That was limited to saves that change an assignment. The Apps Script code has
since been deleted (see §10), so this change now only matters as history.

## 3. Migration to Supabase

**Why.** Once rendering was fixed, what remained was Google Apps Script itself. Each request took about
1–2 s (Google's redirect plus cold starts), and code changes couldn't make that shorter.

**Architecture**
```
Browser (static site on GitHub Pages)
   │  assets/js/api.js   (only this layer talks to the network)
   ▼
Supabase Edge Function "api"      ← all reads, writes and authentication
   │  service-role connection via the transaction pooler
   ▼
Supabase Postgres                 ← Row-Level Security denies the public key everything
```

**Pieces built**
- `supabase/schema.sql` has 7 tables: `pharmacists`, `training_days`, `approvals`, `notifications`,
  `settings`, `venues`, `kv_cache`. Every table has Row-Level Security turned on **with no policies**, so
  the public (anon) key can't read or write anything directly.
- `supabase/functions/api/index.ts` is a TypeScript port of the old Apps Script backend. It uses the same
  JSON protocol, so the front end only had to change the URL and headers it calls. Trainer sign-in uses
  the same signed, expiring (10 h) token. Supervisors are limited to their own pharmacists on the server.
  Capacity, quota, deadline, visibility and online/offline rules are all re-checked on the server.
  Capacity stays correct when two people book at once because assignment changes run in a database
  transaction holding a lock.
- **Settings chosen when the project was created:** turned off "Automatically expose new tables" and
  turned on "Enable automatic RLS".
- **Secrets** (Edge Functions → Secrets): `TRAINER_USER`, `TRAINER_PASS`, `TOKEN_SECRET`, `DB_URL`
  (transaction pooler, port 6543). None of these are in the repository.

**Data migration** (one-time tool, since removed). Copied **1,456 pharmacists, 53 training days,
1 assignment, 1 attendance record, 1 quota decision and 2 notifications**. All 27 supervisors were then
read back from Postgres, and a live supervisor page loaded correctly.

## 4. Connection pooler

Measurements split the ~600 ms request into about **320 ms** of network and function start-up and about
**300 ms** of opening a direct Postgres connection. Pointing `DB_URL` at Supabase's **transaction pooler**
(port 6543) is the recommended setup for Edge Functions. The code was already compatible with the pooler
(`prepare:false`, locks that only last one transaction).

## 5. Optimistic saves

The screen no longer waits for the server. `saveShared(key, getValue)` in `common.js`:
1. the handler updates memory and redraws right away;
2. the save goes out in the background;
3. clicks made while a save is in flight are combined into one follow-up save;
4. if the server rejects a save, `APP_HOOKS.onSaveFailed` reloads the real state and redraws, which undoes
   the change, and an error message appears.

This applies to all attendance, assignment and note handlers on the trainer page and to single-row
assignment on the supervisor page. The server still checks every rule.

**Verified:** the row updated in **0 ms** while its save was still in flight. **6 fast clicks → 2 network
requests**, all saved. A forced save failure **undid the row and showed an error message**.

## 6. Status pill always visible

The "Retrieving… / Sending… / Saved" pill used to sit inside the top bar and scroll out of view. It is now
a `position:fixed` pill at the **bottom-left** (the trainer's round button is bottom-right and messages
appear bottom-centre), with a solid navy background so it can be read over the page (`assets/css/app.css`).
Checked: it stays in the same place at the top of the page and at the bottom.

## 7. Bulk actions

Each row now has a checkbox, the table header has a select-all checkbox, and an action bar appears
whenever anything is selected. The shared logic is in `common.js` (`bulkSel`, `bulkCheckboxCell`,
`updateBulkBar`, `bulkSyncAfterRender`). The actions themselves live in each page's own script.

| Table | Actions |
|---|---|
| Trainer → Records | Assign to a day · set a leave status · unassign · **delete from roster** (with confirmation) |
| Trainer → Training Days | Hide · Unhide · Delete (confirms first; people on deleted days are unassigned; undo/redo works) |
| Supervisor → Pharmacist List | Assign · set leave · unassign (**no delete**) |

Supervisor bulk assign follows the same rules as assigning one row: online/offline must match, deadline,
capacity (seats are counted as it goes), and quota (people over quota are marked *pending approval*).
Anyone who doesn't fit is skipped, and the message tells you how many, e.g. *"Updated 2, skipped 4 (day
full or wrong type)"*. When filters change, the selection shrinks to the rows still visible.

**Verified:** assign, unassign, the online/offline mismatch skip, day hide/unhide/delete, deletes still
there after a reload, and the supervisor capacity limit (limit 2 → 2 assigned, 4 skipped).

## 8. Server query audit

The port had lost some savings the old backend had, and some queries were doing more work than needed.
Fixed in `index.ts` (the request and response format is unchanged, so the front end needed no changes):

| Before | After |
|---|---|
| Every save read **all 1,456 rows** | Reads only the rows being changed (`where id in …`) |
| Seat counts built by scanning the whole roster | Counted by Postgres (`GROUP BY`) for the affected days only |
| Days + settings loaded on every save | Loaded only when a supervisor changes an assignment |
| Every save queued behind a lock | Only assignment changes take the lock |
| One `UPDATE` per row | One statement per batch (`unnest`) |
| `select *`; supervisors got the whole roster, then filtered it in JS | Only the needed columns; supervisor filter done in SQL |
| Full supervisor-name scan on every supervisor request | One indexed lookup (`limit 1`) |
| No server timing | Every response includes `_ms`; `?debug=1` prints round-trip, server and network time |

**Checked before and after:** responses are already gzip-compressed (**31.8 KB → 4.2 KB**), so making
responses smaller was not worth changing the protocol. On the live data, a supervisor assignment was
written, checked on the server, and then **put back to unassigned exactly as it was**.

## 9. Quotas on in-person days

Per-supervisor quotas used to work only on online days. The quota section sat inside the online-only part
of the Add/Edit Day windows, and five places in the code checked `isOnline` first. Now:
- the quota section shows for every day, and saving keeps quotas for in-person days too;
- `isOnline` was removed from those checks in: the server (`validateSupervisorAssignment`), supervisor
  single-row assign, supervisor bulk assign, the supervisor's day cards, and the trainer's Day Status window.

**Verified in the browser:** the quota section shows on an in-person day with its saved value, and a
supervisor's in-person day card shows *"2/2 reached"*.
**Not yet tested end-to-end:** no live day has a quota set yet (see Open items).

## 10. Google Sheets removed

- **Deleted:** `backend/` (Code.gs, appsscript.json), `dev/mock-backend.js`, `dev/fixtures/`,
  `dev/migrate.html`, `docs/PERFORMANCE_PLAN.md` (that plan is fully done).
- `config.js` now points only at Supabase. The old Apps Script URL and the `?mock` / `?backend` switches
  are gone.
- `api.js` no longer has the mock loader, the second (Apps Script) request path, or the
  `calendarGrid`/`syncCalendar` calls.
- **Calendar:** "Calendar Sync" (which read a tab of the Sheet) is now **Import Calendar**, which reads an
  Excel file in the browser. Each day's code (e.g. `RUH 3`) identifies it, so importing again updates
  existing days instead of adding copies.
- **Docs:** README, `supabase/README.md` and `PROJECT_HANDOFF.md` were rewritten for the new setup.
- **Kept on purpose:** `COMPLETION_REPORTS_URL`. It is the separate, read-only LMS reports service behind
  Trainer → Setup → "Sync completion %", not the app's database.

**Verified:** the live supervisor page loads from Supabase (27 supervisors), no Google URL is left in the
config, every file the HTML pages load exists, and the console shows no errors.

---

## Measured results

| What | Before | After | How it was measured |
|---|---|---|---|
| Redraw after an attendance click | ~600 ms (full table) | **0.06 ms** (one row) | Browser, 1,450 × 55 |
| Full trainer table render | ~600 ms | **76 ms** | Browser, 1,450 × 55 |
| `<option>` elements when the table is drawn | 87,000 | **1,450** | Browser |
| Click → result on screen | waited for the server | **0–1 ms** | Browser, optimistic save |
| Requests for 6 fast clicks | 6 | **2** | Browser |
| Backend round-trip | ~1–2 s (Apps Script) | **~0.5–0.8 s** (Supabase) | Owner's browser, varies with network |
| Server time, 1 query / full page load | — | **~120 ms / ~195 ms** | `_ms` field |
| Page-load response size | 31.8 KB | **4.2 KB** sent | gzip is on by default |

**About the remaining ~120 ms of server time.** Most of it is a fixed cost: the function opens a new
database connection on each call. Each extra query adds only about 15–20 ms. Running the queries in
parallel would probably make it *slower*, because each parallel query would open its own connection. The
only real fix is to change how the function talks to the database, and that would mean giving up the
transaction lock that keeps capacity correct. It was **left as is on purpose**: saves happen in the
background, so nobody waits for them.

---

## Files changed

| File | Summary |
|---|---|
| `assets/js/trainer.js` | Row template + single-row updates; background saves; bulk actions (records + days); quota section on all days; Import Calendar |
| `assets/js/common.js` | `dayById`, lazy dropdowns, `saveShared`, shared bulk-selection code |
| `assets/js/supervisor.js` | Background saves; bulk assign with rule checks; quota on in-person days |
| `assets/js/api.js` | Supabase-only requests; `?debug=1` timing log |
| `assets/js/config.js` | Supabase URL + anon key only |
| `assets/css/app.css` | Fixed status pill; checkbox column + bulk action bar |
| `trainer.html`, `supervisor.html` | Select-all header checkboxes, bulk bars, "Import Calendar" button |
| `supabase/schema.sql` | **New** — the database |
| `supabase/functions/api/index.ts` | **New** — the backend |
| `supabase/README.md` | **New** — setup / redeploy guide + performance notes |
| `README.md`, `docs/PROJECT_HANDOFF.md` | Rewritten for the Supabase setup |
| `backend/`, `dev/mock-backend.js`, `dev/fixtures/`, `dev/migrate.html`, `docs/PERFORMANCE_PLAN.md` | **Deleted** |

---

## Open items / next steps

1. **Test in-person quotas end-to-end.** On one in-person day, set a quota of `1` for a supervisor who has
   2+ pharmacists. The second assignment should show as *Pending quota approval* and appear in
   Trainer → Approvals. Supervisor pages need no password, so this can be checked directly against the
   live system.
2. **Publish the front end** (GitHub Pages) so users get all of the above. Until then, the live site still
   runs the old version.
3. ⚠️ **Watch for changes made after the migration.** If people kept using the old live site (still on the
   Google Sheet) after the data was copied on **22 Sep 2026**, those edits are in the Sheet but not in
   Supabase. Check before switching over. The copy tool was deleted but can be rebuilt quickly if needed.
4. **After switching over:** archive the Apps Script deployment and keep the Google Sheet *Restricted*,
   so nothing can write to the old store.
5. **Free-tier pause:** a free Supabase project goes to sleep after 7 days without use. Add a weekly
   keep-alive (e.g. `pg_cron`), or resume it by hand after quiet weeks.
6. **Testing:** there is no offline test setup any more (the old one simulated Google Sheets). Test against
   Supabase with a spare supervisor or day, or add automated tests later.
7. **Version control:** this folder is not a git repository yet. Commit it so changes can be tracked and
   undone.

## Decisions made along the way

- **Supabase over Firebase:** the data is relational, and Postgres gives real transactions for capacity.
- **Supervisors stay password-less**, so every database request goes through the Edge Function
  (Row-Level Security denies everything else).
- **The Sheet was retired, not kept in sync:** keeping a live copy in the Sheet would have brought back the
  slow Sheet writes.
- **Responses were not made smaller:** gzip already shrinks them about 7.5×.
- **The last ~100 ms of server time was left alone:** fixing it would cost the capacity guarantee, and the
  background saves already hide it.
