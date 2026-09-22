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
create index if not exists pharmacists_supervisor_idx on pharmacists (supervisor);
create index if not exists pharmacists_assignment_day_idx on pharmacists ((assignment->>'dateId'));

-- Training days (was the TrainingDays tab). The full day object lives in `data`.
create table if not exists training_days (
  id         text primary key,                   -- day_...
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Approvals (was the Approvals tab): New Pharmacist / Annual Leave / Over-Quota Decision (history)
-- and the live Over-Quota Request mirror. `data` holds the full record; the columns are for filtering.
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

-- ── Lock everything to the anon API (deny-all). The Edge Function uses service_role and bypasses this. ──
alter table pharmacists   enable row level security;
alter table training_days enable row level security;
alter table approvals     enable row level security;
alter table notifications enable row level security;
alter table settings      enable row level security;
alter table venues        enable row level security;
alter table kv_cache      enable row level security;

-- Default capacity (matches the app's built-in default of 30).
insert into settings (key, value) values ('maxCapacity', '30'::jsonb)
  on conflict (key) do nothing;
