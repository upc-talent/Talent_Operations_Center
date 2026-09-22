# Performance analysis & plan — Talent Operations Center

Goal: make sending/receiving data faster and the tool feel smoother **without changing any feature**, keeping Google Sheets as the database.

## Status (updated)

**Phase 1 implemented, except 1.2 and 1.5:**
- ✅ **1.1 One request per click** — `backend/Code.gs` still re-validates everything server-side; the client no longer re-reads a key immediately before saving it. Done for the hot path: trainer attendance/assignment/notes (`assets/js/trainer.js`) and supervisor assignment (`assets/js/supervisor.js`). Admin/config actions (calendar drag-drop, day delete, undo/redo) were left as they were — they're low-frequency and already use `peekSnapshot` where it mattered.
- ⏭️ **1.2 Server-side read cache** — **deferred on purpose.** Capacity/quota safety depends on `patchOps_` reading the live sheet on every write (see the comment above `patchOps_` in `Code.gs`); caching that risks a stale seat count under concurrent bookings. Only worth revisiting if 1.1/1.3/1.4 aren't enough.
- ✅ **1.3 Batch writes** — `writeCells_` now writes one covering range per row (using the row's already-known values to fill the gaps) instead of one call per contiguous group, and the per-write `setNumberFormat` calls were dropped (columns are already formatted as text when the column is created). Verified via the mock harness: a single assignment/attendance/notes save is now 1 write call instead of 4, inside 1 request instead of 2.
- ✅ **1.4 Removed duplicate requests** — the trainer Approvals tab and the supervisor notifications check each fetched their list twice (once for the badge/dot count, once for the actual data); the dot/count now reuses the list the other call just fetched instead of fetching it again.
- ⏭️ **1.5 Redraw only what changed** — **not done.** This is the highest-risk item ("the row-update code must match the full renderer") and the biggest remaining lever for the trainer table specifically. Left for a follow-up if the above isn't enough.

Verified in `?mock=1` against the real `Code.gs`: sign-in, assign/attendance/notes save, Approvals tab open + approve, and a capacity-rejection (client-stale-but-server-still-rejects, with the view auto-refreshing after) all still behave the same as before — only the request/call counts changed.

## 1. How it was measured (and how far to trust it)

The dev harness (`dev/mock-backend.js`, `?mock=1`) runs the **real `Code.gs`** against a fake sheet, filled to the real roster size
(**1,450 pharmacists × ~20 columns**, 55 training days). It now counts, for every request, the Sheets / Cache / Properties / Lock operations
the script performs (`MockBackend.lastStats`, `MockBackend.log`).

- **Request counts, sheet-operation counts, cells read/written, payload sizes and browser rendering cost are real measurements.**
- **Google's actual latency is not measured here.** Typical Apps Script behaviour (my estimate, to be confirmed — see §5):
  a web-app round-trip costs roughly **0.5–1.5 s** (two HTTP hops because of Google's redirect, plus cold starts after idle), and each Spreadsheet
  service call costs roughly **50–400 ms** (grows with cells; writes are slower than reads). So *fewer requests* and *fewer sheet calls per request* are what matter.
- The live sheet currently has ~190 pharmacists; reads grow linearly, so the figures below are what you will see at full size.

## 2. What happens today (measured at 1,450 pharmacists)

| Action | Requests (sequential) | Sheet calls on server (reads / writes) | Cells read | Notes |
|---|---|---|---|---|
| Trainer: assign / Attended / On Time→Late | **2** (`get:operations` → `patch:operations`) | 9 / 8 | **58,808** | the whole HeadCount is read twice for one click |
| Trainer: edit a Notes box | 2 (`get:master` → `patch:master`) | 4 / 2 | 57,960 | same pattern |
| Trainer: open Calendar / Analytics tab, click Refresh | 1 (`getMany:4`) | 7 / 0 | 29,828 | a full reload each time you switch tab |
| Trainer: open Approvals tab | 2 (`get:leave-requests` ×2) | 2 / 0 | 0 | the same request twice |
| Trainer: page start | 5 (`getMany`, `venues`, `company-logo`, `leave-requests` ×2) | 11 / 0 | 29,836 | |
| Supervisor: open page + pick name | 5 (`logo`, `supervisors`, `getMany`, `notifications` ×2) | 15 / 0 | 32,220 | notifications fetched twice |
| Supervisor: assign one pharmacist | **2** (`get:operations` → `patch:operations`) | 9 / 8 | 58,808 | reads all 1,450 rows to change 1 |
| Supervisor: Refresh | 3 (`getMany`, `notifications` ×2) | 9 / 0 | 29,828 | 1 would do |

Payloads: trainer full load **431 KB** (master alone 410 KB); a supervisor's full load **73 KB**.

Browser side (trainer, 1,449 rows): drawing the attendance table takes **~1.1 s**, creates **~90,000 page elements** (58,000 `<option>`s — every row gets its own
dropdown with all 55 days) and **5 MB of HTML**, and **every action redraws it all**. Supervisor view (245 rows): ~54 ms — fine.

### The five findings
1. **Two sequential requests per click** — the code re-reads the data, then writes. That read is no longer needed now that saves are per-record and the server re-validates.
2. **The server reads the entire HeadCount to change one row** (twice per click, once for the read and once inside the write), and re-reads the days/settings/approvals tabs each time.
3. **Many tiny writes:** one assignment = 8 separate write calls for 7 cells (a number-format call + a value call for each of four column groups).
4. **Duplicate and needless requests:** notifications and leave-requests are fetched twice, tab switches reload everything, logo/venues fetched on every start.
5. **The trainer table is drawn from scratch on every change** (1.1 s and growing with the roster) — this is a browser cost, not a Google cost, but it is what makes the trainer page feel sluggish.

## 3. Plan — ordered by value / risk (all keep every feature and the Sheet as the database)

### Phase 1 — quick wins (low risk, no visible change except speed)
| # | Change | Effect (expected) | Risk |
|---|---|---|---|
| 1.1 | **One request per click**: drop the pre-read before a save (use the in-memory data; the server already validates capacity/quota/deadline and returns a clear error, after which the page refreshes that view) | clicks ~**40–50 % faster** (2 requests → 1) | low; keep a refresh on "day full" style errors |
| 1.2 | **Server: read only what is needed.** Keep a compact cached index of HeadCount in `CacheService` (id → row, supervisor, assignment/attendance JSON), refreshed on every write and every ~60 s; a patch then touches only its target rows instead of scanning 29,800 cells. Cache TrainingDays, Settings, Venues too | per-click server work **−60–80 %**, load grows much slower with roster size | medium: cache invalidation (hand edits in the sheet appear within ~1 min) |
| 1.3 | **Server: batch writes** — one call for all cells of a patch (contiguous-range writes, and stop re-applying number format on every write since setup already formats the columns; or the Advanced Sheets service `batchUpdate`) | 8 write calls → 1–2 | low |
| 1.4 | **Remove duplicate/extra requests**: fold notifications, leave-requests, logo, venues into the single startup `getMany`; one refresh = one request; tab switches use loaded data unless it is older than ~30 s | Supervisor open 5 → 2 requests; Approvals tab 2 → 0–1; Refresh 3 → 1 | low |
| 1.5 | **Redraw only what changed** in the trainer/supervisor tables (update the one row, not all 1,449), build the day-options HTML once and reuse it, and draw large tables in chunks so the page stays responsive | trainer click redraw **1.1 s → ~few ms**; no feature change (exports still contain every row) | medium: the row-update code must match the full renderer |

### Phase 2 — makes it feel instant and more "live"
| # | Change | Effect | Risk |
|---|---|---|---|
| 2.1 | **Optimistic UI + save queue**: update the screen immediately, send in the background in order, show a small "saving… / saved / failed → undone" state per row | perceived latency **≈ 0** for clicks | medium: careful failure/undo handling |
| 2.2 | **Version check instead of full reloads**: server keeps a change counter; the page asks "anything new?" (a tiny cached call) every ~20–30 s and on tab focus, and reloads only if something changed → other people's changes appear on their own | live collaboration; far fewer full loads | low–medium |
| 2.3 | **Slimmer payloads**: supervisors currently receive an assignment record for *every* pharmacist just to count seats — send per-day seat counts instead; trainer master could load per filter/tab | supervisor load 73 KB → ~15 KB; trainer 431 KB → smaller | medium (front-end capacity logic changes) |
| 2.4 | Debounce typing in Notes/time boxes; keep-alive/warm-up ping on page open to soften Google's cold start | fewer writes; first click faster | low |

### Phase 3 — only if it is still not fast enough
- **Advanced Sheets service** (`Sheets.Spreadsheets.Values.batchGet/batchUpdate`) for all reads/writes: one API call for many ranges, usually 2–4× faster than repeated `SpreadsheetApp` calls.
- **Fast store + Sheet as mirror**: keep the same API but serve reads/writes from Firebase/Supabase (~50–150 ms) and sync to the Google Sheet in the background. Biggest speed-up, but the Sheet stops being the live source of truth — a product decision, not just a technical one.

## 4. Expected result (estimates)
- Today at full roster: a click ≈ 2 requests ≈ **2–4 s**, trainer table redraw +1 s, tab switches ≈ full reload.
- After Phase 1: a click ≈ 1 request with ~2–4 sheet calls ≈ **~1 s**; redraw ~instant; fewer reloads.
- After Phase 2: click feels **instant** (background save); other users' changes appear within ~30 s automatically.

## 5. Do this first: measure the real thing
Add cheap timing so decisions use real Google numbers: the server returns its own execution time (`_ms`) in every response and the page logs
`round-trip vs server` per request (and shows it with `?debug=1`). Two days of real use then tells us whether network hop, cold starts or sheet calls dominate.

## 6. Ground rules for any optimisation
- No feature may change: same rules (capacity, deadlines, quotas, approvals), same exports (all rows), same sheet columns.
- Server stays the authority; client optimisations must fall back cleanly if the server rejects a change.
- Keep the dev counters (`MockBackend.log`) and re-run the scenarios in §2 after each step; the table above is the acceptance test.
