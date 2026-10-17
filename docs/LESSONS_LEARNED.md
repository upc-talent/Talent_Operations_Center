# Talent Operations Center — lessons learned

What went wrong while building this project, how each problem was found, and what to do differently. Read this
before changing the code. For how the system works today, see [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md); for every
feature, see [FEATURE_CATALOGUE.md](FEATURE_CATALOGUE.md).

---

## 1. The project's story in short

| Stage | What happened | Why |
|---|---|---|
| Single HTML artifact | One 2.2 MB file | Quick start |
| Pages + Google Sheet | Split into supervisor / trainer pages; data in a Sheet through Apps Script | Shared data between people |
| Speed work (Sept 2026) | Redraw one row instead of ~1,450; dropdowns built on first open | A click took ~0.6–1.1 s to redraw |
| **Supabase** | Moved all data to Postgres behind one Edge Function | Apps Script added 1–2 s to every request (see [WORK_SUMMARY.md](WORK_SUMMARY.md)) |
| v3 | Two completion columns, hidden-day icons, hourly Google Sheet backup | Owner requests |
| v4 | Named accounts, Activity Log, retraining history, group merges, data-edit requests | One shared trainer login gave no audit trail |
| v5 | Course progress reports moved into the Hub (Moodle Reports, Reports Configuration, public `reports.html`) | The old reporting tool lived in a separate repo + a public Google Sheet |
| v6 | Admins Permissions, own passwords, hidden report people, bulk attendance, lock fix | Owner requests + a lock bug |
| v7 | Training Date filter, Unsubmit, course and category card colours, users made in the app | Owner requests |
| v7.3 | Image / PDF exports never cut off | Phone and small-window downloads lost the columns past the right edge |
| v7.4 | Headcount sheet on the Attendance tab | The public page had it; trainers wanted to filter the roster by their own email list |
| v7.5 | Display names, changeable sign-in usernames, typed temporary passwords | Owner request: real names instead of UPC_T1, and a way to help someone who forgot their password |

---

## 2. The working environment (owner's Windows PC)

| Problem we hit | What we do now |
|---|---|
| **No Python, Node or Deno** on the PC, so no way to run or type-check JavaScript / TypeScript locally. Loading TypeScript from a CDN was blocked at first, but works in the built-in browser (see §5). | A small Perl script, `scopecheck.pl` (kept in the agent's scratchpad, not in the repo), checks balanced braces and duplicate `const` / `let` names in one block. It caught a real deploy-breaking bug (§4). Its "declared twice" warnings for `for (const k …)` loops in separate blocks are false positives. **Then load every changed page in the browser** — that is the real syntax check. |
| `git` refused to run: *"dubious ownership"*. | Pass it per command — `git -c safe.directory='*' …` — instead of changing the global Git config. |
| "LF will be replaced by CRLF" warnings on every commit. | Harmless (Windows line endings). Ignore. |
| The owner pushes to GitHub themselves. | Commit locally with a clear message after each phase; never push. |
| `dev/serve.ps1` is the only local web server. | `.claude/launch.json` starts it as "hub" on port 5173. |

---

## 3. Editing files safely — mistakes that cost time

These all happened. Each one either broke a page or wasted a round of work.

1. **Perl `$1` written literally into code (4 times).** Building a Perl replacement by joining strings
   (`"…" . '$1'`) inserts the characters `$1` instead of the matched text. It replaced function headers, e.g.
   `async function mergedCourseRows(` became `$1courseId: string, …`, and also hit `pubModulesBadge`,
   `rpRenderCfgForm` and `courseSlotsSet`. One page went blank (`pubState is not defined`).
   **Do:** after any scripted edit, run `grep -n '^\$1\|\$1[a-z{]' <files>`; prefer the Edit tool or "write a
   block to a file, then splice it in by line numbers".
2. **Perl `q( … )` / `q{ … }` with unbalanced brackets inside** stopped compiling ("runaway multi-line string").
   **Do:** use a delimiter that never appears in JavaScript, such as `q~ … ~`.
3. **Bash heredocs with apostrophes / backticks** failed with "unexpected EOF while looking for matching quote".
   **Do:** write the content with the Write tool, then `cat file >> target`.
4. **`cat > file` with no input** waited for keyboard input forever; the command had to be stopped.
5. **A double-quoted `$1` inside a Perl `r("…$1…")` call** expanded to nothing at call time and silently deleted
   the "Active" checkbox from the course form. **Do:** check the result of each edit, not just "applied N".
6. **An apostrophe inside a single-quoted JS string** (`'…course's data…'`) broke all of `reports.js`. The scope
   checker had warned "unclosed blocks: 1" and was ignored. **Do:** treat any checker warning on a file you just
   edited as real until proven otherwise.
7. `perl -0pi -e '… or die'` aborts *without* writing — the file stays intact, which is safe but easy to miss.

---

## 4. Bugs found (and fixed), by area

### Server (Edge Function `api`)
- **`const s` declared twice in `patchMaster` (v4)** — a syntax error that would have stopped `api` from deploying
  at all. Found by `scopecheck.pl` during v5.
- **Core Completion wiped** — `patchMaster` wrote `completion_pct` unconditionally, so any roster save without that
  field erased it. Fixed in v4 (only written when sent); in v5 the column stopped being used.
- **Deadline wiped** — `courseSave` replaced the stored deadline with nothing when a course was edited. Now it keeps
  the stored deadline unless `deadline` is sent.
- **"Partial" mismatch** — the page treated "Day 1 attended, Day 2 not marked" as Partial (unlocked the dropdown)
  while the server did not, so the save was refused. Both now say: in progress, not failed.

### Locks (the biggest behaviour change)
- **v4 rule:** a pharmacist who missed training got the Date dropdown back, even on a submitted or training-team-managed
  day. **The owner reported this as a bug in v6**: supervisors could move people the training team had locked.
- **v6 rule: the lock always wins.** Locked people are rebooked through Request Change, which now also accepts
  absent pharmacists. Changed in three server places (`patchOps`, `validateSupervisorAssignment`,
  `changeRequestAllowed`) and on the supervisor page.
- **v7:** trainers can **Unsubmit** to hand choices back without a Request Change. Kept separate from a day's
  "Editable" switch on purpose — merging them would let one switch silently reopen other people's submitted choices.

### Permissions (v6)
- First version: an inner switch (e.g. "Decide requests") still worked with its tab switched off. Found in testing.
  **Fix:** a tab switched off turns off everything inside it (`effectivePerms`).
- By design, and surprising at first: **a change is allowed if any screen that makes it is allowed.** Example: a
  trainer with "Mark attendance" off but "Master upload" on can still save attendance, because a roster upload
  carries attendance. Buttons are still hidden; the server is lenient on purpose so that legitimate screens don't
  break.
- The coordinator's Analytics filters disappeared because the old `admin-hidden` rule hid everything except the
  Master Sheet card. Replaced by `data-perm` tags.

### Public reports page
- "Report unavailable" (course switched off / link renewed) must never be replaced by the saved offline copy.
- **Rate limit:** 30 requests / minute / IP. Fast reloads while testing hit it — clear the counter, don't raise the
  limit.
- **Answers are cached 60 s per server instance.** After publishing or hiding someone, the public page can lag by up
  to a minute.
- **Owner decision:** emails are shown in full (the plan had them masked). Switch the Email column off per course to
  send none. The headcount sheet needs that column.
- **"I can't see the new filter locally"** — the local page talks to the **live** backend. Anything that needs new
  server data (e.g. the Training Date filter) only appears after `api` is redeployed. Explain this first when the owner
  tests locally.

### Moodle Reports engine
- Excel dates were guessed by locale (5/10 read as May 10). **Fix:** read sheets with `{raw:true, cellDates:false}`
  and parse timestamps ourselves (`rpParseTs`, day-first, KSA).
- An unreadable timestamp must never become "Late" or "On time" → "Completed (date unknown)", shown with examples in
  the preview, and Publish needs a tick when there are any. `rpSelfTest()` (23 checks, `?debug=1`) guards this.
- SheetJS went from 0.18.5 to 0.20.3 for this — re-test Master upload, Calendar import and Bulk Add after any upgrade.

### Deploying (v7.2 → v7.5)
- **"Could not save — Unknown action" on category colours.** The front end (v7.2) was live but the `api` Edge Function was
  still v7, so it didn't know `categoryColorsSet`. The same old `api` was also silently dropping each course's Card fill and
  Text colours (v7.1) on save. **Do:** deploy `schema.sql` → `api` → `backup` → front end, always in that order, and
  after a deploy try one new action on the live site. To check which `api` is live without signing in, ask the public
  endpoint (`reportsPublic`) for a field the new version adds (a v7.1 `api` sends `display.bg` / `display.text`).
- **A folder name with `[ ]` brackets** broke `dev/serve.ps1`: `Resolve-Path` and `Test-Path` treat `[Active]` as a
  wildcard, so every page came back 404 and the preview was blank. **Do:** `-LiteralPath` in PowerShell scripts.

### Exports (v7.3)
- **Cut-off Image / PDF on phones and small windows.** `html2canvas` captured the element at the window's width, so a
  1,300 px table inside a 300 px card kept only its left quarter, and phone CSS squeezed and wrapped the rest.
  **Fix:** capture a copy at the table's own width (`captureFull`), with a `windowWidth` wide enough that the phone
  layout doesn't apply. Wide-but-fitting things (the calendar grid) use `minWidth` instead.
- **Canvas limits.** Browsers refuse canvases over about 32,000 px a side, and phones over about 16 million pixels,
  returning a blank or cut image. The export scale drops for very long tables (`exportCanvasScale`).
- **Test with a marker.** Put a coloured marker in the last cell of every row and check that its pixels appear at the
  right edge of the exported image; "the image looks wide" isn't proof.

### Accounts (v7.5)
- **A rename must not rewrite history.** Changing the sign-in username could have meant updating every Activity Log row,
  permission and "marked by" stamp. Instead `username` stays a fixed id, `login_name` is an alias, and display names are
  applied when shown (`staffLabel`). Nothing stored has to change, and a rename can be undone by typing the original.
- **"API.login is not a function" — nobody could sign in (v7.5).** The `API` object already had a method `login()`. v7.5
  added a property also called `login` (the sign-in username), and the later one replaced the method, so every new
  sign-in failed. People already signed in kept working, because their session check doesn't call `login()`. The test
  round missed it because it replaced `API.call` and never used the real sign-in form. **Fix:** the property is
  `API.loginName`. **Do:** before adding a property to a shared object (`API`, `APP_HOOKS`), search for that name
  (`grep -n "API\.name\|name(" assets/js/api.js`); and always test sign-in through the page's own form with only the
  network stubbed (`window.fetch`), after any change to `api.js` or the login flow.
- **The superadmin can lock themselves out** by renaming their own sign-in username and forgetting it. There is a SQL
  escape hatch in supabase/README.md; keep it documented.

### UI
- **Side margins** on wide screens came from `main{max-width:1800px}`. Now full width with a responsive gutter.
- **Accent stripe vanished** on cards with a fill: the fill rule's `border-color` shorthand overrode the accent
  `border-top`. Set only the left / right / bottom colours.
- **Title lost its accent colour** with automatic text. Only an explicitly chosen text colour overrides the title.
- **White ✓ on a white swatch** was invisible — added a dark text-shadow.
- **"Use category colour" read as "Default"** in the course form: the form read the category input before that input
  existed on the page. Keep needed values in state (`rpState.cfgCategory`), not in the DOM, while building HTML.

---

## 5. Testing approach that worked

- **Mock backend in the browser.** A copy of the Edge Function's rules written in JavaScript (`mock-api.js`,
  scratchpad) intercepts `fetch` and keeps data in `localStorage['mockdb']`. Temporary pages
  `dev/_t_trainer.TEMP.html` / `_t_supervisor` / `_t_reports` load the real page plus the mock. **They are deleted
  after every test round and never committed.**
- **Running the real Edge Function in the browser (v7.5).** The built-in browser *can* load TypeScript from
  `https://cdn.jsdelivr.net/npm/typescript@5.4.5/lib/typescript.js`:
  1. **Syntax check:** `ts.transpileModule(src, {reportDiagnostics:true})` on `index.ts` / `backup/index.ts` catches
     syntax errors.
  2. **Run it:** to run the server's own logic, replace the `import postgres …` line with a stub whose `sql` tag
     answers the few queries the flow uses from in-memory tables. Stub `Deno.env.get` / `Deno.serve`, append
     `globalThis.__srv = {route, hashPassword}`, transpile and `import()` it from a Blob URL. Then call
     `route({action:'login', …})` and the rest directly.
  3. **What it checked:** every sign-in, rename, reset and forced-change case for v7.5.
  4. **Testing the page against it:** point the page's `API.call` at `__srv.route`. Throw on any query the stub doesn't
     know, so nothing passes by accident.
- **Every server change needs the same change in the mock.** When the mock lagged (e.g. it ignored display settings on
  new courses), tests looked broken while the real server was fine. Seed test data in the mock's own format (e.g.
  approvals use `_type`).
- **Live checks are read-only.** Writes are only tested against the mock.
- **Don't race the page.** Signing out from a test script while the page was still loading its startup data cleared
  the new token ("Not authorised"). Reload, wait, then act.
- **Screenshots time out** when the browser pane isn't drawn. Retry, or check with DOM queries / `get_page_text`.
- **Test the server, not just the screen:** for locks and permissions, call the API directly as the supervisor or as
  the restricted account and confirm the refusal message.

---

## 6. Working with the owner

- **Ask before adding anything outside the request** ("Don't add any feature … before asking me first"). When a
  choice is genuinely theirs (e.g. Unsubmit vs Editable, who may create superadmins), recommend one option and build
  it, saying so.
- **Secrets never in the repo**: `STAFF_ACCOUNTS`, `TOKEN_SECRET`, `BACKUP_SECRET`, `GOOGLE_SERVICE_ACCOUNT`,
  `BACKUP_SHEET_ID` live only in Supabase secrets. Roster exports (`*.xlsx`, `*.xls`, `*.csv`) are git-ignored. The old
  tools in `reference/` stay local.
- **Deploy order matters**: run `supabase/schema.sql` *before* deploying a new `api` (it reads the new columns), then
  `backup`, then push the front end.
- Explain in plain words, with the exact buttons and steps to deploy.
