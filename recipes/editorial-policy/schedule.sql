-- ============================================================
-- Schedule weekly auditor via pg_cron
-- Run this against your brain's database with psql (one-time setup), if that
-- database has pg_cron and pg_net; a cron line on the auditor's host does the
-- same (the README's Step 6).
--
-- BEFORE RUNNING:
--   Replace <YOUR-AUDITOR-URL> with the auditor's URL as the DATABASE reaches
--   it (the auditor listens on the host that runs `bun`, PORT 8787 in the
--   README; from the compose stack's Postgres that host is not 127.0.0.1).
--   Replace <YOUR-AUDITOR-KEY> with the KEY whose sha256 is an entry in the
--   auditor's AUDITOR_ACCESS_KEYS (name:scope:sha256; the URL carries the key,
--   the environment its hash). Use a write-scoped key: the run stores a report.
-- ============================================================
--
-- Prerequisites:
--   pg_cron + pg_net extensions enabled: CREATE EXTENSION pg_cron; CREATE EXTENSION pg_net;
--
-- Default timing: Sunday 09:00 UTC. Adjust the cron expression
-- to fit your weekly summary schedule. The auditor should run BEFORE
-- the weekly summary so it has the full week to inspect.
-- ============================================================

SELECT cron.schedule(
  'weekly-auditor',
  '0 9 * * 0',
  $$
  SELECT net.http_post(
    url := '<YOUR-AUDITOR-URL>/?key=<YOUR-AUDITOR-KEY>',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'days', 30,
      'post_to_slack', true,
      'dry_run', false,
      'prior_audit_count', 4
    )
  );
  $$
);

-- ============================================================
-- Verify scheduled:
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'weekly-auditor';
--
-- Run history:
--   SELECT jobname, start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'weekly-auditor')
--   ORDER BY start_time DESC LIMIT 5;
--
-- Manual test (dry run, no Slack post, no audit_report stored):
--   SELECT net.http_post(
--     url := '<YOUR-AUDITOR-URL>/?key=<YOUR-AUDITOR-KEY>',
--     headers := jsonb_build_object('Content-Type', 'application/json'),
--     body := jsonb_build_object('days', 30, 'post_to_slack', false, 'dry_run', true)
--   );
--
-- Remove the schedule (if needed):
--   SELECT cron.unschedule('weekly-auditor');
-- ============================================================
