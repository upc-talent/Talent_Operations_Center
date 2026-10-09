-- ════════════════════════════════════════════════════════════════════
-- Talent Operations Center — Supabase (Postgres) schema
-- Run this ONCE: Supabase dashboard → SQL Editor → paste → Run.
-- Safe to re-run (everything is IF NOT EXISTS / idempotent).
--
-- Security model: every table has Row-Level Security ENABLED with NO policies,
-- which means the public (anon) API can read/write NOTHING. All access goes through
-- the Edge Function, which uses the service_role key and bypasses RLS. This mirrors
-- the old model where the Google Sheet was private and only the script could touch it.
-- ════════════════════════════════════════════════════════════════════

-- Master roster (was the HeadCount tab). One row per pharmacist.
create table if not exists pharmacists (
  id             text primary key,               -- ph_...
  district       text not null default '',
  area_manager   text not null default '',
  city           text not null default '',
  supervisor     text not null default '',
  pharmacy_no    text not null default '',
  employee_id    text not null default '',
  email          text not null default '',
  display_name   text not null default '',
  phone          text not null default '',
  scfhs          text not null default '',
  note           text not null default '',
  completion_pct text,                           -- null = not set
  assignment     jsonb,                          -- the "a" object (date/leave) or null
  attendance     jsonb,                          -- the "t" object or null
  created_at     timestamptz not null default now()
);
-- Work Shift (Morning Shift / Night Shift), set by the supervisor. Added later — this line also upgrades an existing database.
alter table pharmacists add column if not exists work_shift text not null default '';
-- Capsule Completion (second LMS course; "completion_pct" is the Core Completion). Also an upgrade line.
alter table pharmacists add column if not exists capsule_pct text;
-- Retraining history (v4): each missed attempt (Absent / Partial) that was replaced by a new day — never thrown away.
alter table pharmacists add column if not exists history jsonb not null default '[]'::jsonb;
create index if not exists pharmacists_supervisor_idx on pharmacists (supervisor);
create index if not exists pharmacists_assignment_day_idx on pharmacists ((assignment->>'dateId'));

-- Training days (was the TrainingDays tab). The full day object lives in `data`.
create table if not exists training_days (
  id         text primary key,                   -- day_...
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Approvals (was the Approvals tab): New Pharmacist / Annual Leave / Over-Quota Decision (history)
-- / Date Change (supervisor Request Change) / Submission (a supervisor pressed Submit), and the live Over-Quota Request mirror. `data` holds the full record; the columns are for filtering.
create table if not exists approvals (
  id           text primary key,
  type         text not null,
  status       text not null default '',
  supervisor   text not null default '',
  pharmacist   text not null default '',
  submitted_at text not null default '',
  decided_at   text not null default '',
  reason       text not null default '',
  data         jsonb
);
create index if not exists approvals_type_idx on approvals (type);
create index if not exists approvals_supervisor_idx on approvals (supervisor);

-- Notifications (was the Notifications tab).
create table if not exists notifications (
  id              text primary key,
  supervisor      text not null default '',
  pharmacist_name text not null default '',
  result          text not null default '',
  reason          text not null default '',
  decided_at      text not null default '',
  read            boolean not null default false,
  seen_in_history boolean not null default false
);
create index if not exists notifications_supervisor_idx on notifications (supervisor);

-- Settings (was the Settings tab): maxCapacity, trainerNames, coordinatorNames, trainingNames, logo, …
create table if not exists settings (
  key   text primary key,
  value jsonb
);

-- Venues (was the Venues tab): the city → recommended-venue list offered when adding a training day.
create table if not exists venues (
  id    bigint generated always as identity primary key,
  city  text not null,
  venue text not null
);

-- Small key/value store with expiry — replaces the script CacheService (login lockout counter, etc.).
create table if not exists kv_cache (
  key        text primary key,
  value      text,
  expires_at timestamptz
);

-- Activity Log (v4): every sign-in and every change, under the signed-in account. Append-only — the app has no way
-- to edit or delete it; only the superadmin can read it (through the Edge Function). Also copied hourly to the backup Sheet.
create table if not exists activity_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  username    text not null default '',
  role        text not null default '',
  action      text not null default '',
  target_kind text not null default '',
  target_id   text not null default '',
  target_name text not null default '',
  details     jsonb
);
create index if not exists activity_log_at_idx on activity_log (at desc);
create index if not exists activity_log_user_idx on activity_log (username);

-- ── Lock everything to the anon API (deny-all). The Edge Function uses service_role and bypasses this. ──
alter table pharmacists   enable row level security;
alter table training_days enable row level security;
alter table approvals     enable row level security;
alter table notifications enable row level security;
alter table settings      enable row level security;
alter table venues        enable row level security;
alter table kv_cache      enable row level security;
alter table activity_log  enable row level security;

-- Default capacity (matches the app's built-in default of 30).
insert into settings (key, value) values ('maxCapacity', '30'::jsonb)
  on conflict (key) do nothing;

-- ════════════════════════════════════════════════════════════════════
-- v5 — Reports (Moodle Reports / Reports Configuration / public reports.html)
-- Safe to re-run. Completion data lives here; pharmacists stays the single roster.
-- (pharmacists.completion_pct / capsule_pct are kept as old data but no longer read or written.)
-- Settings keys used: coreCourseId, capsuleCourseId (which course feeds the Attendance tab's Core / Capsule columns).
-- ════════════════════════════════════════════════════════════════════
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
  engine             jsonb not null default '{}'::jsonb,       -- saved Moodle settings: {finalVideos, acceptedStatuses, excludedVideos}
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
  stats         jsonb not null default '{}'::jsonb,            -- {rowsIn,students,stored,excluded,noEmail,matchedRoster,matchedOnboarding,notInRoster,unreadableTimestamps}
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
