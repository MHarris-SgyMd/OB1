-- ============================================================================
-- 034 — query_log: an opt-in record of the searches a brain is actually asked
--        and what the caller did next, so a retrieval change can be measured
--        against real use, not only the one saturated corpus (SMD-1295)
--
-- Why
--   Every retrieval decision the fork has shipped is measured on one thing: the
--   441 Linear issues of evals/eval-real.ts, where the baseline already reaches
--   recall@10 0.98. On a corpus that saturated, the reranker cascade, hybrid
--   fusion, contextual chunks and GraphRAG all came out neutral or worse, and
--   each write-up names the corpus as the reason (SMD-1039). Meanwhile the one
--   source of ground truth a real brain produces on every request — the query a
--   person or agent typed, and which returned thought they went on to open — is
--   discarded: the server logs nothing about a search beyond the transport line.
--
--   A caller who searches and then fetches, edits or deletes result 3 has
--   labelled result 3 relevant. That is click-through relevance — a proxy, not a
--   judgement (a fetch can be a wrong guess), and it is kept as a second opinion
--   beside the hand-labelled sets, never as their replacement. But it measures
--   what the brain is actually asked, and it is a by-product of use rather than a
--   dataset someone has to go and build.
--
-- What
--   One table, query_log, off by default. The server writes it only when
--   OB1_QUERY_LOG=on; nothing reads it on the hot path and nothing joins it into
--   a capture or a search. Two kinds of row share the table:
--
--     * a 'search' row per search call — the query text, the arguments
--       (match_count, threshold, recency_weight, filter) and the ids returned in
--       rank order with their fused scores;
--     * an 'action' row when the same agent fetches, edits or deletes an id —
--       the target id and which tool touched it.
--
--   There is no request/session token threaded through the MCP handlers to key
--   an action to the search that produced its id (each call is an independent
--   HTTP request; migration 008's actor envelope carries an unused `session`
--   slot and nothing populates it). So the two are NOT joined at write time. The
--   link is recovered at export time (evals/export-queries.ts) by the only keys
--   both rows share: the acting agent (010) and the returned id, within a time
--   window — an action is attributed to the most recent prior search by the same
--   agent whose result set contained the id. Each search row's own id is the
--   "request id" the export prints; an action row references no search row.
--
--   Retention is part of this version, not a follow-up: query_log is personal
--   data at rest (every query someone typed). prune_query_log(p_keep_days)
--   deletes rows older than the window and returns the count; the default 30
--   days matches OB1_QUERY_LOG_RETENTION_DAYS (db/config.mjs). The DELETE is
--   always bounded by logged_at, never unqualified. An operator schedules it (or
--   the server prunes opportunistically); either way the hot path never deletes.
--
-- What it does not touch
--   The core `thoughts` table and every capture/search function are unchanged —
--   this migration only adds a new table and one maintenance function. No
--   trigger fires on capture; the write is an explicit call from the server's
--   read/write handlers, guarded by the env flag, and best-effort (a log failure
--   is swallowed so it can never fail a search or a capture).
--
-- Grants
--   A self-hosted server role needs INSERT on query_log to write the log, and
--   the owner runs prune_query_log. db/config.mjs ROLE_GRANTS carries query_log
--   as its own group (`querylog`, since 034); `migrate.ts --grant` issues it and
--   db/README.md documents it. Because the log is off by default and preflight
--   cannot read a server env flag, the `query log` preflight check reports the
--   table's presence and that it is off, and does not refuse a role that lacks
--   the INSERT — it is a documented, conditional grant, not an enforced one.
--
-- Prerequisites
--   Migration 001 (thoughts, for the id shape) and 010 (ob1_agents, for the
--   agent id the search records) are expected; neither is referenced by a
--   foreign key — the log outlives the rows it names, and a pruned agent or a
--   deleted thought must not cascade a query out of the record. Applied by
--   `bun db/migrate.ts`.
--
-- Expected outcome
--   query_log exists, empty, with prune_query_log() beside it. No capture, edit,
--   search or delete behaves any differently until OB1_QUERY_LOG=on.
-- ============================================================================

CREATE TABLE IF NOT EXISTS query_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  logged_at      timestamptz NOT NULL DEFAULT now(),
  -- 'search' rows carry the ranking; 'action' rows carry a follow-up touch.
  kind           text        NOT NULL CHECK (kind IN ('search', 'action')),
  -- The acting agent (010), or NULL when no key was presented or the registry
  -- was unreachable. Deliberately no FK: the log is a record, and a pruned agent
  -- must not take its history with it. The export joins agent to agent with
  -- IS NOT DISTINCT FROM, so NULL is its own bucket rather than a wildcard.
  agent_id       uuid,
  -- Which tool wrote the row: 'search' | 'search_thoughts' for a search,
  -- 'fetch' | 'update_thought' | 'delete_thought' for an action.
  tool           text        NOT NULL CHECK (tool <> ''),

  -- 'search' columns (NULL on an action row).
  query          text,
  match_count    int,
  threshold      real,
  recency_weight real,
  filter         jsonb,
  -- The ids returned, in rank order, and the fused scores aligned to them.
  result_ids     uuid[],
  result_scores  real[],

  -- 'action' columns (NULL on a search row).
  target_id      uuid,

  -- A search row has a query; an action row has a target. Kept minimal so a
  -- future tool that logs differently is not boxed in by the CHECK.
  CONSTRAINT query_log_search_has_query CHECK (kind <> 'search' OR query      IS NOT NULL),
  CONSTRAINT query_log_action_has_target CHECK (kind <> 'action' OR target_id IS NOT NULL)
);

-- The export walks actions to the searches that returned their id, by agent and
-- time: (agent_id, logged_at) narrows to one agent's recent calls, and the GIN
-- on result_ids answers "which of those searches returned this id" (@>).
CREATE INDEX IF NOT EXISTS query_log_agent_time_idx  ON query_log (agent_id, logged_at);
CREATE INDEX IF NOT EXISTS query_log_result_ids_idx  ON query_log USING gin (result_ids)
  WHERE kind = 'search';

COMMENT ON TABLE query_log IS
  'Opt-in (OB1_QUERY_LOG=on), off by default: one row per search call (the query, its arguments, and the ids returned in rank order with scores) and one per follow-up fetch/edit/delete of a returned id (the target). Personal data at rest — every query typed. Nothing reads it on the hot path; the write is best-effort and never fails a search. An action is linked to its search at export time by (agent_id, target_id, time window), not at write time — there is no request/session token in the handlers. Pruned by prune_query_log(); default retention 30 days (OB1_QUERY_LOG_RETENTION_DAYS).';

-- ── prune_query_log: the retention window, run by the owner or a scheduler ──
CREATE OR REPLACE FUNCTION prune_query_log(p_keep_days int DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days < 0 THEN
    RAISE EXCEPTION 'prune_query_log: p_keep_days must be >= 0, got %', p_keep_days;
  END IF;
  DELETE FROM query_log
   WHERE logged_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION prune_query_log(int) IS
  'Delete query_log rows older than p_keep_days (default 30, matching OB1_QUERY_LOG_RETENTION_DAYS) and return the count deleted. The DELETE is always bounded by logged_at. Run by the owner or a scheduler; the hot path never prunes. p_keep_days 0 deletes everything older than now().';
