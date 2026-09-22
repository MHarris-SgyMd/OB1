-- =============================================================================
-- Migration 047: a seekable prune index on query_log.logged_at (SMD-1492)
-- =============================================================================
--
-- WHY
--   prune_query_log(p_keep_days) (034) deletes WHERE logged_at < now() - interval,
--   a pure time-range delete with no agent_id predicate. 034 gave query_log two
--   indexes — the composite btree (agent_id, logged_at) for the export join and a
--   partial GIN on result_ids — and neither seeks a bare logged_at range: the
--   composite's leading column is agent_id, so a prune that filters only on
--   logged_at cannot descend it and falls back to a sequential scan of the whole
--   table. Fine while the log is small and prune is a rare manual op; but SMD-1806
--   makes query_log the canary's replay source (a lost row is a lost replay) and
--   SMD-1794 runs prune on a schedule, so at volume the retention delete must be a
--   range scan, not a full-table scan. 045 left this to SMD-1492.
--
--   A plain btree on logged_at is the deliberate choice (SMD-1492): universally
--   supported and an exact range seek for the DELETE. Its cost is one more btree
--   maintained on every INSERT — the "fourth index write cost" the ticket weighs;
--   accepted here, with a follow-up (SMD-1950) to investigate a BRIN alternative (the log is
--   append-only and logged_at is monotonic, so a BRIN would be near-free on insert
--   and still range-scan the prune) once the write cost is measured at volume
--   (db/bench-querylog.ts). The awaited log write stays on the hot path
--   deliberately — a dropped row is a lost replay for SMD-1806 — so a cheaper
--   insert path matters, which is what the BRIN follow-up is about.
--
-- WHAT
--   * A guard first (045's shape): on a schema without 034's table the CREATE INDEX
--     would fail bare. Refuse up front naming 034 and --reapply. The brain that
--     meets this is one adopted with --baseline whose ledger records 034 but whose
--     schema never had it.
--   * CREATE INDEX IF NOT EXISTS query_log_logged_at_idx ON query_log (logged_at) —
--     a btree the prune DELETE range-scans. Not CONCURRENTLY: migrations run in one
--     transaction (034's own indexes are plain CREATE INDEX), and CONCURRENTLY
--     cannot run inside a transaction block. A plain build takes a lock that blocks
--     writes to query_log for its duration; on a large opt-in log this is a
--     deploy-time stall of the awaited hot-path log writes. It is bounded in
--     practice: a fresh brain builds it on an empty table, and SMD-1806's canary —
--     the tier that carries the log at volume — is rebuilt from stable's dump on
--     every merge, so 047 runs against the refreshed copy as it is loaded, not
--     against the live stable writer. Migrating an existing large log in place is
--     the case to run in a quiet window (SMD-1794's maintenance window, or by hand).
--   * COMMENT ON INDEX records what it is for.
--
-- SAFETY
--   Additive. One index created; no table, column, function, constraint or ACL
--   changed, no data touched. Idempotent: CREATE INDEX IF NOT EXISTS, so a re-run
--   under --reapply adds nothing. prune_query_log's body is unchanged — it simply
--   gains an index to seek. A MINOR change under the version rules (additive DDL);
--   a fragment that ships it may not claim `bump: patch`.
--
-- Expected outcome
--   query_log gains a third index, query_log_logged_at_idx. Prune's time-range
--   DELETE can range-scan it; every other read and write behaves exactly as before.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('query_log') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 047 needs 034 (query_log); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

CREATE INDEX IF NOT EXISTS query_log_logged_at_idx ON query_log (logged_at);

COMMENT ON INDEX query_log_logged_at_idx IS
  'Btree on logged_at so prune_query_log''s time-range DELETE (WHERE logged_at < cutoff, no agent_id predicate) range-scans instead of sequentially scanning the table; 034''s (agent_id, logged_at) composite cannot serve a bare logged_at range because agent_id leads it (SMD-1492). Cost is one more btree maintained per INSERT — a BRIN alternative is a follow-up (SMD-1950), the log being append-only with a monotonic logged_at.';
