# Training Operations Hub

Coordinates training schedules between supervisors and the Talent Management training team.
Static front-end (GitHub Pages) + Google Apps Script backend + a Google Sheet as the database.

```
index.html          Landing page: Supervisor · Course Progress Reports · LMS Ticketing · (trainer icon, bottom-right)
supervisor.html     Supervisor page (pick your name → assign pharmacists, request additions/leave)
trainer.html        Trainer page — behind a sign-in (attendance, setup, approvals, analytics, calendar)
assets/js/config.js Every URL lives here (backend, LMS reports, ticketing form)
assets/js/api.js    Backend client — sends only the records that changed
assets/js/common.js Helpers shared by both pages
backend/Code.gs     Google Apps Script backend (paste into the Sheet's Apps Script project)
dev/                Local test server + in-browser fake sheet (synthetic data only)
```

## 1. One-time backend setup

1. **Keep the Google Sheet private.** *Share → General access → Restricted.* The script runs as you, so the
   sheet never needs to be public. (If it is "anyone with the link", anyone can read/edit every pharmacist's
   data directly and no app login can protect it.)
2. In the Sheet: **Extensions → Apps Script**. Replace the contents of `Code.gs` with `backend/Code.gs`.
   *(Optional)* show the manifest (Project Settings → "Show appsscript.json") and paste `backend/appsscript.json` — it sets the Riyadh time zone, which the supervisor deadlines use.
3. Pick **`setupSheets`** in the function drop-down → **Run** → approve the permissions. It:
   - adds helper columns **N–T** to `HeadCount` (your columns A–M are untouched),
   - creates the tabs `Approvals`, `TrainingDays`, `Notifications`, `Settings`,
   - gives every pharmacist row a unique ID.
4. **Project Settings → Script Properties → Add**:
   `TRAINER_USER` and `TRAINER_PASS` (the trainer-page login). They are stored on Google's side only — never in this repo.
5. **Deploy → Manage deployments →** (edit the existing one) **→ Version: New version → Deploy.**
   Settings: *Execute as: Me · Who has access: Anyone.* The URL stays the same. (A brand-new deployment gives a new URL — put it in `assets/js/config.js`.)
6. Sanity check: open the web-app URL in a browser — you should see `{"ok":true,"service":"Training Operations Hub API"}`.
   Optionally run **`checkSetup`** in the editor and read *Execution log*.

## 2. Sheet structure

| Tab | Purpose | Edited by |
|---|---|---|
| **HeadCount** | Master roster. **E = Date** (or leave status), **L = Attendance Status**, **M = Notes** are written by the app. | app (roster changes: trainer) |
| **2026 - Q4 Training Calendar** | The planning grid. Trainer page → Calendar → *Import from Google Sheet* reads it. | you |
| **Venues** | `City` / `Recommended Venues` list, offered when adding a training day. | you |
| **Approvals** | Requests waiting for / decided by the trainer (below). | app (you may read/filter freely) |
| TrainingDays | The normalised list of training days the app works with. | app |
| Notifications | Approval results shown to supervisors. | app |
| Settings | Capacity, trainer/coordinator/training-name lists, logo. | app |

**HeadCount helper columns (N–T):** `Pharmacist ID`, `Session` (city — date text), `Punctuality`, `Arrival Time`, `Completion %`,
and two hidden system columns (`Assignment`, `Attendance` — the app's source of truth for those rows).
**Edit assignments/attendance through the app**: E/L/M are overwritten from the system columns when a row changes.
New pharmacists you paste in by hand get an ID automatically the next time the app reads the sheet.

**Approvals tab**

| Column | Meaning |
|---|---|
| A ID | unique id |
| B Type | `New Pharmacist` · `Annual Leave` · `Over-Quota Request` (live, waiting) · `Over-Quota Decision` (history) |
| C Status | `Pending` / `Approved` / `Rejected` |
| D Supervisor | who submitted it |
| E Pharmacist | person (over-quota rows also show the day) |
| F Submitted At · G Decided At | ISO timestamps |
| H Reason | rejection reason |
| I Data (hidden) | full record (system) |

Nothing reaches `HeadCount` column E until it is approved: a new pharmacist is only appended to HeadCount on approval,
an Annual Leave request only sets the status on approval, and an over-quota assignment leaves **E blank** (Session shows
*"Pending quota approval — …"*) until the trainer approves it. Approve/reject in the app so the follow-up steps run.

## 3. Run locally

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
```

Open `http://localhost:5173/?mock=1` to use an **in-browser fake sheet with synthetic data** (runs the real `Code.gs`;
trainer login `demo` / `demo`). `?mock=0` switches back to the live backend. Reset the fake data from the console: `MockBackend.reset()`.

## 4. Publish on GitHub Pages

Push this folder, then *Settings → Pages → Deploy from a branch → `main` / root*.
**Never commit the Excel files or any real roster export** (`.gitignore` already blocks `*.xlsx`).
GitHub Pages only serves the static front-end — the backend stays in Google Apps Script.

## 5. Security model (read this)

- The backend URL is visible to anyone who opens the site's source — that is unavoidable for a static site, so the
  protection is enforced **on the server**:
  - **Trainer actions** need a signed, expiring (10 h) token issued only after `TRAINER_USER`/`TRAINER_PASS` match.
    8 failed sign-ins in 10 minutes lock sign-in for everyone for 10 minutes.
  - **Supervisor requests** are limited to that supervisor's own pharmacists (no phone/licence numbers), and the server
    re-checks every change: pharmacist ownership, training-day visibility, deadline, capacity, per-supervisor quota.
    Supervisors cannot record attendance, approve anything, or touch setup data.
  - Supervisors still pick their name from a list (no password) — anyone who knows the URL can act as any supervisor
    *within those limits*. If that is not acceptable, add a per-supervisor access code next.
- The trainer credential is shared by the whole training team, so attendance "marked by" is not recorded per person.

## 6. Known differences from the old single-file tool

- The embedded *Completion Reports* dashboard was removed — it is now the **Course Progress Reports** card (opens in a new tab).
  The optional *Sync completion % from the LMS reports source* in Trainer → Setup is unchanged.
- The "Share Direct Links" card and the role picker are gone (each role now has its own page).
- Logo uploads are shrunk automatically so they fit in a Google Sheets cell.
- Not changed (still as in v16): analytics buckets that don't add up when someone is assigned but not yet marked;
  Undo/Redo covers training-day/config changes only.
