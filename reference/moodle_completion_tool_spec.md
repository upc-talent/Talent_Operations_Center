# Moodle Completion Rate Tool: Feature & Logic Specification

> **Target Audience**: AI Engineering Assistants (Claude Code, GitHub Copilot) & Frontend/Fullstack Developers  
> **Backend Requirement**: **None (100% Client-Side / Pure In-Memory Business Logic — Zero Supabase Dependencies)**  
> **Purpose**: Embed this tool's exact data processing, merging, deadline tracking, and export capabilities into an existing web application or dashboard.

---

## 1. Executive Summary & Core Philosophy

The **Moodle Completion Rate Tool** is a client-side analytics and aggregation engine designed to process course completion spreadsheets exported from Moodle (or similar LMS platforms).

### Key Architectural Tenets:
1. **Zero Database / Zero Supabase**: The engine operates purely in-memory using JavaScript data structures (`AoA` -> normalized student/activity graphs).
2. **Multi-Source Unification**: Multiple sheets (e.g., from different branch LMS instances or multiple platform exports of the same course) are automatically unified:
   - **Students** are merged across sheets by case-insensitive `email`.
   - **Course Activities/Videos** are merged by normalized title.
   - **Completion Rule**: If a student completed a video in *any* sheet, they are counted as completed. The *earliest* completion timestamp wins.
3. **Flexible Activity Finality**: Courses do not always have the final video at the last column. Each sheet supports independent final-video assignment with localStorage memory.
4. **Deadline & Cut-Off Engine**: Calculates On-Time, Late, Overdue, and Cut-off compliance with exact day counts and date parsing.
5. **Privacy & Exclusion**: Regex-based email and `@domain.com` exclusions that keep excluded rows visible (dimmed) in UI preview but strip them from the generated export.
6. **Self-Documenting Two-Sheet Excel Export**: Generates an `.xlsx` file containing the filtered student dataset plus an audit sheet documenting all parameters, thresholds, and merge rules applied.

---

## 2. In-Memory Data Models & State Types

Below are the core TypeScript interfaces modeling the tool's runtime state:

```typescript
export interface ActivityColumn {
  name: string;        // Original column name from sheet (e.g., "Module 1 Video")
  key: string;         // Normalized key: clean(name).toLowerCase()
  sCol: number;        // Column index of status (e.g., "Completed")
  tCol: number | null; // Column index of completion timestamp (if adjacent blank header)
}

export interface LoadedFile {
  id: string;          // Unique identifier (e.g., "f1", "f2")
  fileName: string;    // e.g., "Course_A_Platform1.xlsx"
  label: string;       // User-editable display name / platform label
  sig: string;         // Unique signature: `${name}|${size}|${lastModified}`
  acts: ActivityColumn[];
  rows: string[][];    // Raw AoA rows (excluding header)
  emailCol: number;    // Detected index of the email column
}

export interface ActivityCellEntry {
  st: string;          // Status text (e.g. "Completed", "(blank)")
  ts: string;          // Raw timestamp string (e.g. "2024-05-12 14:30:00")
  src: string;         // File ID where this record came from
}

export interface MergedStudent {
  name: string;
  email: string;
  srcIds: string[];    // Array of file IDs where student was found
  // Map of activity normalized key -> array of cell entries across all sheets
  cells: Record<string, ActivityCellEntry[]>;
}

export type StudentState = 
  | 'Completed' 
  | 'Final video done, others missing' 
  | 'In progress' 
  | 'Not started';

export type ScheduleResult = 
  | 'On time' 
  | 'Late' 
  | 'Overdue' 
  | 'Still within deadline' 
  | 'Completed (date unknown)';

export interface EvaluatedStudentResult {
  name: string;
  email: string;
  srcIds: string[];
  srcText: string;            // Comma-separated labels of source platforms
  done: number;               // Count of included videos completed
  total: number;              // Count of included videos
  rate: number;               // Completion percentage (0 - 100)
  fDone: boolean;             // Whether final video was completed
  fStatus: string;            // Raw status of the final video
  fTime: string;              // Earliest completion timestamp of final video
  fDate: string;              // Date-only representation (YYYY-MM-DD)
  latest: string;             // Latest completion timestamp across any video
  missing: string[];          // List of activity names not yet completed
  state: StudentState;
  
  // Deadline Schedule Fields
  sched: ScheduleResult | '';
  sText: string;              // e.g., "Late by 3 days", "Overdue by 5 days"
  sCls: 'ok' | 'mid' | 'no' | '';
  sDays: number;
  sSort: number;              // Numeric sort rank (rank * 100,000 + days)
  
  // Cut-off Check Fields
  cb: string;                 // "Yes" | "No, completed later" | "No, not completed" | "Completed (date unknown)"
  cbCls: 'ok' | 'mid' | 'no' | '';
  cbSort: number;             // Numeric sort rank
}
```

---

## 3. Core Features & Business Logic Breakdown

### Feature 1: Multi-Sheet Ingestion & Header Pair Parsing
- **Inputs**: File objects (`.xlsx`, `.xls`, `.csv`).
- **Sheet Parser**: Read via SheetJS (`XLSX.read(Uint8Array, {type:'array'})`).
- **Header Structure Convention**:
  - Column 0: Student Name.
  - Email Column: Detected dynamically using `/e-?mail/i`. Defaults to index 1 if no matching header found.
  - Subsequent columns: Pairs of `[Activity Status Header, Blank Header]` or single `[Activity Status Header]`.
- **Timestamp Pair Detection Algorithm**:
  ```javascript
  // For each column after emailCol:
  // If h[c] has text, it is an activity.
  // If h[c + 1] has an empty header string, it is recognized as that activity's completion timestamp!
  var acts = [];
  var c = emailCol + 1;
  while (c < h.length) {
    if (h[c]) {
      var a = { name: h[c], key: norm(h[c]), sCol: c, tCol: null };
      if (c + 1 < h.length && !h[c + 1]) {
        a.tCol = c + 1;
        c++; // Skip the paired timestamp column
      }
      acts.push(a);
    }
    c++;
  }
  ```

---

### Feature 2: Multi-Platform Merge Engine (Email as Foreign Key)
- **Problem**: Large organizations host the same course across multiple regional Moodle instances. Students may finish half the videos on Platform A and the rest on Platform B.
- **Merge Logic**:
  1. Unique students are keyed by `email.toLowerCase()`. If a row has no email, fallback unique key is `n:<fileId>:<rowIndex>`.
  2. If a student exists across sheets, their names are reconciled (non-blank wins) and their file source IDs are appended to `srcIds`.
  3. Cell values for each activity are stored in an array under `student.cells[activityKey]`.
  4. Global activity catalog (`S.acts`) represents the union of all activity names across all uploaded files.

---

### Feature 3: Per-Platform Final Video Assignment & Memory
- **Problem**: Activity ordering can vary between Moodle exports, so the final video is not guaranteed to be the rightmost column.
- **Logic**:
  1. Each file `f` has its own final video selection: `S.finals[file.id]`.
  2. **Auto-Detection Priority**:
     - Check `localStorage` list of recently chosen final video names (`moodle_final_video`, up to 30 items).
     - If any saved name matches an activity in this file, automatically pick it.
     - Otherwise, default to the rightmost activity (`f.acts[f.acts.length - 1]`).
  3. **Batch Sync**: Button "Use the first sheet's final video in every sheet that has it" allows 1-click unification across sheets.
  4. **Mismatch Warning**: If the selected final video is not the final column in the sheet, a warning note alerts the user of column discrepancy.

---

### Feature 4: Dynamic Completion Status Criteria
- **Status Discovery**: As files are loaded, all distinct status strings across all activity cells are collected into `S.statuses` with frequency counts (e.g., `Completed: 420`, `Incomplete: 110`, `Not started: 80`, `(blank): 50`).
- **Default Heuristic**:
  ```javascript
  function defaultDone(statusText) {
    return /^(complet|done|pass)/i.test(statusText) && !/\b(not|fail)/i.test(statusText);
  }
  ```
- **Interactive UI**: Users can toggle any status tag (e.g., include "Pass" or custom status codes). When toggled, all stats and student states recompute immediately.

---

### Feature 5: Multi-Source Completion & Earliest Timestamp Resolution
- **Rule**: A student is completed for activity `A` if *any* sheet records an accepted completion status.
- **Earliest Timestamp Picker**:
  ```javascript
  function pickDone(entries) {
    var pick = null, pt = null;
    entries.forEach(function(e) {
      if (!isDone(e.st)) return; // Check if status counts as completed
      var t = tsVal(e.ts);      // Parse Date timestamp value
      // Pick earliest timestamp; entries with valid timestamps win over timestamp-less completions
      if (pick === null || (t !== null && (pt === null || t < pt))) {
        pick = e;
        pt = t;
      }
    });
    return pick;
  }
  ```

---

### Feature 6: Student State Categorization Matrix
Every student is evaluated into one of 4 mutually exclusive states:
1. **`Completed`**: Completed all included videos (`done === total && total > 0`).
2. **`Final video done, others missing`**: Completed the final video (`fDone === true`), but has uncompleted modules earlier in the course (`done < total`).
3. **`In progress`**: Completed at least 1 video (`done > 0`), but final video is not completed (`fDone === false`).
4. **`Not started`**: Completed 0 videos (`done === 0`) and final video is not completed.

---

### Feature 7: Course Deadline Tracking Engine
- **Input**: Date (`YYYY-MM-DD`) + Time (`HH:MM`, defaults to `23:59`).
- **Deadline Timestamp**: `new Date(date + 'T' + time + ':59').getTime()`.
- **Persistence**: Saved to `localStorage` under `moodle_deadline:<joined_final_video_names>`.
- **Classification Tree**:
  - If Student **Completed Final Video** (`fDone === true`):
    - Has valid timestamp `t`:
      - `t <= deadline` -> **`On time`** (`rank: 0`, green)
      - `t > deadline` -> **`Late`** by `Math.ceil((t - deadline) / 86400000)` days (`rank: 3`, red)
    - Missing or unparseable timestamp -> **`Completed (date unknown)`** (`rank: 2`, amber)
  - If Student **Has NOT Completed Final Video** (`fDone === false`):
    - `currentTimestamp > deadline` -> **`Overdue`** by `Math.ceil((now - deadline) / 86400000)` days (`rank: 4`, red)
    - `currentTimestamp <= deadline` -> **`Still within deadline`** (`rank: 1`, amber)

---

### Feature 8: Cut-Off Date Verification ("Completed Before Date")
- **Purpose**: Distinct from course deadline. Used for milestone reporting (e.g., "Who had completed before end of Q1?").
- **Parameters**:
  - `Cutoff Date`: Specific date (`YYYY-MM-DD`).
  - `Mode`:
    - `before`: strictly before midnight of date (`< T00:00:00`).
    - `onbefore`: on or before end of day (`<= T23:59:59`).
  - `Basis`:
    - `final`: Evaluates timestamp of final video completion.
    - `all`: Evaluates whether all included videos were completed (`state === 'Completed'`) using the latest completion timestamp among all modules.
- **Results**:
  - `Yes` (Met cut-off condition)
  - `No, completed later` (Completed, but timestamp is after cut-off)
  - `No, not completed` (Did not complete the required modules)
  - `Completed (date unknown)` (Completed, but no valid timestamp recorded)

---

### Feature 9: Privacy & Exclusion Filtering (Individual & Domain)
- **Input**: Textarea and/or File Upload (`.xlsx`, `.xls`, `.csv`, `.txt`).
- **Syntax**:
  - Exact email: `john.doe@company.com`
  - Domain wildcard: `@contractors.partner.org` (any email ending with this suffix is excluded).
- **Behavior**:
  - Excluded students are **NOT** deleted from state; they are flagged with `isExcluded(email) = true`.
  - In the UI table, excluded rows appear dimmed (`opacity: 0.5`) with a badge `hidden from download`.
  - In Excel export, excluded rows are strictly omitted.
- **Persistence**: Saved to `localStorage` (`moodle_hidden_emails`).

---

### Feature 10: Multi-Criteria Search, Filter & Sort
- **Search**: Free-text filter on student name and email.
- **Dropdown Filters**:
  - State filter (`All`, `Completed`, `Final video done, others missing`, `In progress`, `Not started`).
  - Source Platform filter (when multiple files loaded).
  - Schedule filter (On time, Late, Overdue, etc.).
  - Cut-off filter (Yes, No, etc.).
- **Sorting**:
  - Default rate/done sort direction is descending.
  - Strings and dates sort ascending by default.
  - Custom compound keys:
    - Schedule sort: `rank * 100000 + daysLateOrOverdue`.
    - Final completion time: null dates sort to the bottom.

---

### Feature 11: Professional Dual-Sheet Excel Generation
- Uses SheetJS (`XLSX.utils.book_new()`, `book_append_sheet()`).
- **Sheet 1: `Completion`**:
  - Contains all visible (non-excluded, non-filtered) students.
  - Columns: `Name`, `Email`, `Source` (if multi-file), `Videos completed`, `Total videos`, `Completion rate %`, `Final video status`, `Final video completed at`, `Latest completion timestamp (any video)`, `State`, `Deadline`, `Schedule`, `Days late / overdue`, `Cut-off`, `Completed by cut-off`.
  - Auto-fitted column widths based on maximum string lengths.
- **Sheet 2: `Settings used`**:
  - Comprehensive parameter audit for compliance and verification:
    - Source files & row counts.
    - Final videos assigned per sheet.
    - Videos included in rate.
    - Accepted completion status texts vs rejected status texts.
    - Deadline date and time used.
    - Cut-off parameters used.
    - Merge rules applied.

---

## 4. Standalone Logic Module (Ready to Embed)

Here is the complete, dependency-free JavaScript/TypeScript processing module extracted from the HTML file. His friend can copy this file directly into their codebase (e.g. `moodleCoreEngine.ts`):

```typescript
/**
 * Moodle Completion Tool - Pure Calculation & Aggregation Core
 * Zero backend / Supabase dependencies.
 */

// Helper string normalization
export function clean(s: any): string {
  return String(s == null ? '' : s).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

export function norm(s: any): string {
  return clean(s).toLowerCase();
}

export function defaultDone(statusText: string): boolean {
  return /^(complet|done|pass)/i.test(statusText) && !/\b(not|fail)/i.test(statusText);
}

export function parseTimestamp(ts: string): number | null {
  var t = Date.parse(String(ts || '').replace(' ', 'T'));
  return isNaN(t) ? null : t;
}

export function dateOnly(ts: string): string {
  var t = String(ts || '').trim();
  if (!t) return '';
  var m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return t.replace(/[\sT]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(AM|PM)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, '').trim();
}

/**
 * Parses raw Array-of-Arrays from Excel/CSV into activities and student rows
 */
export function parseSheetAoA(aoa: any[][]) {
  if (!aoa || !aoa.length) throw new Error('Sheet is empty');
  const h = aoa[0].map(x => clean(x));
  
  let emailCol = h.findIndex(x => /e-?mail/i.test(x));
  if (emailCol < 0) emailCol = 1; // Default to Column B

  const acts: { name: string; key: string; sCol: number; tCol: number | null }[] = [];
  let c = emailCol + 1;
  while (c < h.length) {
    if (h[c]) {
      const a = { name: h[c], key: norm(h[c]), sCol: c, tCol: null as number | null };
      if (c + 1 < h.length && !h[c + 1]) {
        a.tCol = c + 1;
        c++;
      }
      acts.push(a);
    }
    c++;
  }

  if (!acts.length) {
    throw new Error('No activity/video columns found after the email column.');
  }

  const rows = aoa.slice(1).filter(r => clean(r[0]) || clean(r[emailCol]));
  return { acts, rows, emailCol };
}

/**
 * Evaluates Deadline compliance for a student
 */
export function computeSchedule(
  fDone: boolean, 
  fTimeStr: string, 
  deadlineEpoch: number | null
) {
  if (!deadlineEpoch) return { s: '', t: '', c: '', days: 0, rank: 0 };
  
  if (fDone) {
    const t = parseTimestamp(fTimeStr);
    if (!fTimeStr || t === null) {
      return { s: 'Completed (date unknown)', t: 'Completed (date unknown)', c: 'mid', days: 0, rank: 2 };
    }
    if (t <= deadlineEpoch) {
      return { s: 'On time', t: 'On time', c: 'ok', days: 0, rank: 0 };
    }
    const daysLate = Math.ceil((t - deadlineEpoch) / 86400000);
    return { s: 'Late', t: `Late by ${daysLate} day${daysLate === 1 ? '' : 's'}`, c: 'no', days: daysLate, rank: 3 };
  }

  const now = Date.now();
  if (now > deadlineEpoch) {
    const daysOverdue = Math.ceil((now - deadlineEpoch) / 86400000);
    return { s: 'Overdue', t: `Overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}`, c: 'no', days: daysOverdue, rank: 4 };
  }

  return { s: 'Still within deadline', t: 'Still within deadline', c: 'mid', days: 0, rank: 1 };
}

/**
 * Evaluates Cut-off milestone compliance
 */
export function computeCutoff(
  isCompleted: boolean, 
  timestampStr: string, 
  cutoffEpoch: number | null, 
  mode: 'before' | 'onbefore'
) {
  if (!cutoffEpoch) return { s: '', c: '', rank: 0 };
  if (!isCompleted) return { s: 'No, not completed', c: 'no', rank: 3 };

  const t = parseTimestamp(timestampStr);
  if (!timestampStr || t === null) {
    return { s: 'Completed (date unknown)', c: 'mid', rank: 2 };
  }

  const metCutoff = mode === 'before' ? t < cutoffEpoch : t <= cutoffEpoch;
  return metCutoff 
    ? { s: 'Yes', c: 'ok', rank: 0 } 
    : { s: 'No, completed later', c: 'mid', rank: 1 };
}

/**
 * Checks if an email is excluded based on exact match or @domain suffix
 */
export function isEmailExcluded(
  email: string, 
  excludedEmails: Set<string>, 
  excludedDomains: string[]
): boolean {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return false;
  if (excludedEmails.has(e)) return true;
  return excludedDomains.some(d => e.endsWith(d));
}
```

---

## 5. How to Embed into Your Friend's Application

When pasting this into Claude Code from your friend's workspace, instruct Claude Code with:

```markdown
"We want to embed the Moodle Completion Rate calculation engine into our application.
Refer to moodle_completion_tool_spec.md for the complete functional specification.
Do NOT connect any Supabase tables or backend services for this tool.
All state should be managed locally in our frontend state store (e.g., React useState/Zustand/Pinia).
Implement:
1. File upload handling using SheetJS (xlsx) for single or multiple sheets.
2. Auto-merging of duplicate students by email address across sheets.
3. Earliest-timestamp selection when videos are completed in multiple sources.
4. Final video selector with localStorage preference recall.
5. Status checkboxes, deadline date picker, and cut-off filters.
6. The dual-sheet Excel download matching the format in section 3, feature 11."
```

---

## 6. Verification & Test Checklist

When embedding is completed, verify against these edge cases:
- [ ] **Email variations**: `Test@domain.com` and `test@domain.com` merge into a single student record.
- [ ] **Multi-sheet video completion**: If Student A completed Video 1 on Platform 1 in June and on Platform 2 in May, Platform 2's timestamp (May) is retained.
- [ ] **Unregistered timestamp**: If a status is "Completed" but the timestamp column is blank, the student is marked as completed with status `(no date)` / `Completed (date unknown)`.
- [ ] **Excluded domains**: `@client.com` in exclusion textarea dims all `@client.com` students in UI and strips them completely from downloaded `.xlsx`.
- [ ] **Timezone consistency**: Timestamps from sheets are parsed via ISO strings and compared directly with local deadline timestamps.
