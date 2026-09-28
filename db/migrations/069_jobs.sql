-- ============================================================================
-- 069 — jobs: a durable record of the async job-handle registry, so a job's
--        result survives a server restart (SMD-2318, follow-up to SMD-2273)
--
-- Why
--   SMD-2273 shipped the async response pattern (Post/Redirect/Get): a tool
--   returns a { jobId, status: "accepted", poll, stream } handle at once and the
--   caller comes back for the result — the `job_status` tool, `GET /jobs/<id>`,
--   or the `/jobs/<id>/stream` SSE subscription (server-portable/jobs.ts). That
--   store is in memory: a job does not survive a restart (a running one is
--   marked `lost` on SIGTERM, and a poll after the restart got `not found`), and
--   it is invisible to a second reader. That fit the single-process Bun server
--   and the `scan_thoughts` demo, but a real operator job — a worker drain
--   (SMD-2272), a large backfill, a full re-embed — wants its result to outlive
--   a deploy and be readable by a `worker_status`-style query. The SMD-2273 plan
--   deferred this explicitly: in memory now, a durable table "when a consumer
--   needs restart-survival."
--
-- What
--   One table, `jobs`, written through by the server as the in-memory registry
--   moves a job along: a row per job (INSERT on start, UPDATE on the
--   running-transition, throttled progress, and the terminal state), read back
--   by the same ownership token the in-memory store uses — the SHA-256 of the
--   key that started it (`owner_key_hash`). A job that finished before a restart
--   is then still readable with its result; a job still running at a restart is
--   reconciled to `lost` at startup (the detached run does not survive the
--   process, so it is reported gone, not resumed — the single-process semantic).
--   The live SSE fan-out and the detached runner stay in the process; this table
--   holds only the record, so the HTTP + tool surface is unchanged.
--
--   Retention, as with 034's query_log, is part of this version, not a
--   follow-up: prune_jobs(p_keep_minutes) deletes terminal rows past the window
--   and returns the count. The DELETE is always bounded by ended_at, never
--   unqualified (the CLAUDE.md SQL guard / check-fork 21). An operator or a
--   scheduler runs it; the server never prunes on the hot path (the in-memory
--   store evicts its own Map records under a cap; the table is pruned out of
--   band).
--
-- What it does not touch
--   The core `thoughts` table and every capture/search function are unchanged —
--   this migration only adds a new table and one maintenance function. No
--   trigger fires; every write is an explicit, best-effort call from the
--   server's job runner (a write failure is swallowed so it can never fail a
--   tool call, exactly as the query_log write is), and the startup reconcile is
--   the durable guarantee regardless of whether the last write landed.
--
-- Grants
--   A self-hosted server role needs SELECT, INSERT, UPDATE on jobs to write and
--   read the registry, and DELETE for prune_jobs (owner or scheduler).
--   db/config.mjs ROLE_GRANTS carries jobs as its own group (`jobs`, since 069);
--   `migrate.ts --grant` issues it and db/README.md documents it. The dogfood
--   server connects as owner, so it is unaffected; a --grant role must be
--   re-granted after this migration or its job writes fail.
--
-- Prerequisites
--   None referenced by a foreign key. Like query_log (034), the record outlives
--   the agent or the thoughts a job names: a pruned agent or a deleted thought
--   must not cascade a job out of the record. Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   jobs exists, empty, with prune_jobs() beside it. No tool behaves any
--   differently; the async surface (SMD-2273) now reads through this table on
--   the Bun/SQL server and falls back to the in-memory store on Workers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS jobs (
  id             uuid        PRIMARY KEY,
  -- The tool that started the job ('scan_thoughts', and the heavier consumers to
  -- come). Non-empty; kept as free text so a new job kind needs no migration.
  kind           text        NOT NULL CHECK (kind <> ''),
  -- The ownership token: the SHA-256 of the presented key, the same hash the
  -- in-memory store keys on. A job is visible only to the key that started it.
  -- Deliberately no FK to a key/agent row — a rotated or pruned key must not take
  -- its finished jobs' history with it.
  owner_key_hash text        NOT NULL CHECK (owner_key_hash <> ''),
  -- Who ran it, for a `worker_status`-style read: the resolved agent id, or the
  -- key's name when the registry has not answered (the store's actor fallback).
  actor          text        NOT NULL,
  -- pending -> running -> one terminal state. `lost` is a job the server's stop
  -- cut off (in memory: not resumable), now durable across the restart.
  status         text        NOT NULL
                   CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'lost')),
  -- { done, total, message? } — the last progress report, for the poll body.
  progress       jsonb,
  -- The run's value on success (a small summary), its error on failure
  -- ({ message, code? }). Terminal rows carry one or the other.
  result         jsonb,
  error          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  ended_at       timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- A terminal row records when it ended; a live one does not (the reconcile and
  -- the retention both key on ended_at).
  CONSTRAINT jobs_terminal_has_ended
    CHECK ((status IN ('succeeded', 'failed', 'lost')) = (ended_at IS NOT NULL))
);

-- A key reads its own jobs newest-first (the `worker_status`-style listing and
-- the single-id poll both filter by owner_key_hash).
CREATE INDEX IF NOT EXISTS jobs_owner_created_idx ON jobs (owner_key_hash, created_at DESC);
-- The startup reconcile and any "what is in flight" read scan only the live
-- rows; a partial index keeps that off the terminal bulk.
CREATE INDEX IF NOT EXISTS jobs_live_idx ON jobs (status)
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE jobs IS
  'Durable record of the async job-handle registry (SMD-2318, server-portable/jobs.ts, SMD-2273). One row per long-running job: id, kind, owner_key_hash (the SHA-256 of the starting key — the ownership token, no FK), actor, status (pending|running|succeeded|failed|lost), progress/result/error as jsonb, and the lifecycle timestamps. Written through best-effort by the server as the in-memory registry moves a job along; read back so a job survives a restart. A job still running at a restart is reconciled to lost at startup. Pruned by prune_jobs(); the live SSE fan-out and the detached runner stay in the process.';

-- ── prune_jobs: the retention window, run by the owner or a scheduler ────────
CREATE OR REPLACE FUNCTION prune_jobs(p_keep_minutes int DEFAULT 60)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_keep_minutes IS NULL OR p_keep_minutes < 0 THEN
    RAISE EXCEPTION 'prune_jobs: p_keep_minutes must be >= 0, got %', p_keep_minutes;
  END IF;
  DELETE FROM jobs
   WHERE ended_at IS NOT NULL
     AND ended_at < now() - make_interval(mins => p_keep_minutes);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION prune_jobs(int) IS
  'Delete terminal jobs rows (ended_at set) older than p_keep_minutes (default 60) and return the count deleted. The DELETE is always bounded by ended_at — a live job (ended_at NULL) is never touched. Run by the owner or a scheduler; the hot path never prunes. p_keep_minutes 0 deletes every terminal row older than now().';
