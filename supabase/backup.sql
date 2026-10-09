-- ════════════════════════════════════════════════════════════════════
-- Hourly Google Sheet backup — schedule (run ONCE in the SQL Editor, after the
-- "backup" Edge Function is deployed and its secrets are set; see supabase/README.md).
--
-- Replace the placeholder before running:
--   <BACKUP_SECRET>  the same long random string you saved as the BACKUP_SECRET function secret
-- The "backup" function must have "Verify JWT" switched OFF (its own BACKUP_SECRET check is what protects it).
-- The backup secret is stored encrypted in Supabase Vault, not in this file or the job text.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- the secret the scheduler sends to the backup function
select vault.create_secret('<BACKUP_SECRET>', 'backup_secret', 'Sent by the hourly backup job to the backup Edge Function');

-- every hour, on the hour
select cron.schedule(
  'hourly-sheet-backup',
  '0 * * * *',
  $job$
    select net.http_post(
      url := 'https://aoqgabdsayaqgqroscdw.supabase.co/functions/v1/backup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-backup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'backup_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);

-- ── Useful afterwards ──────────────────────────────────────────────
-- Run a backup right now (same call the job makes):
--   select net.http_post(url := 'https://aoqgabdsayaqgqroscdw.supabase.co/functions/v1/backup',
--     headers := jsonb_build_object('Content-Type','application/json',
--       'x-backup-secret',(select decrypted_secret from vault.decrypted_secrets where name='backup_secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
-- See the last runs of the job:        select * from cron.job_run_details order by start_time desc limit 10;
-- See what the backup function replied: select id, status_code, content from net._http_response order by id desc limit 5;
-- Stop the hourly backup:              select cron.unschedule('hourly-sheet-backup');