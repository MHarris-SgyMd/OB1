-- ============================================================================
-- 077 — jobs.door: which server started a job, so a server's start-up
--        reconcile marks only its own jobs lost (SMD-2284)
--
-- Why
--   069's durable jobs table is reconciled at a server's start-up: every row
--   still pending or running is marked `lost`, since the process that ran it is
--   gone and a detached run does not resume. That assumed one serving process
--   per database. SMD-2284 adds a second — the REST core (server-portable/
--   api.ts) beside the MCP server (index.ts), on the same database — and each
--   starts jobs (scan_thoughts). With one table and no owner, the REST core's
--   start-up would mark the MCP server's live jobs lost, and the reverse on
--   every MCP restart; a job that then succeeded could not record it (the
--   writer keeps a terminal row terminal), and a poll read `lost` for a job
--   that finished.
--
-- What
--   One column, `door`: the name of the server that started the job — the
--   door a write through it records as thought_audit.origin (046):
--   `open-brain` for the MCP server, `open-brain-api` for the REST core. A
--   server writes its own name on every job it starts and reconciles only the
--   rows bearing it. Rows written before this file can only have been the MCP
--   server's (it was the one serving process), so the column's default is its
--   name, which every existing row takes; the default also covers a server
--   from before this file writing against it.
--
-- What it does not touch
--   The core `thoughts` table and every capture/search function are unchanged.
--   069's columns, constraints, indexes and prune_jobs are unchanged; a poll
--   reads a job by its owner's key whichever server started it.
--
-- Needs 069 (the jobs table); refused by name without it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the constraint added only when absent.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 077 needs 069 (the jobs table); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS door text NOT NULL DEFAULT 'open-brain';

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_door_named' AND conrelid = 'public.jobs'::regclass) THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_door_named CHECK (door <> '');
  END IF;
END
$c$;

COMMENT ON COLUMN jobs.door IS
  'The server that started the job, by the door its writes record as thought_audit.origin (046): open-brain (the MCP server) or open-brain-api (the REST core). A server reconciles only its own live rows to lost at start-up, so two servers on one database leave each other''s jobs alone. Rows from before migration 077 take open-brain, the one serving process then. Migration 077 (SMD-2284).';
