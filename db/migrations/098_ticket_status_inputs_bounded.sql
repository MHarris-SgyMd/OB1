-- =============================================================================
-- Migration 098: the stated-status label's read bounded — 095's
--                ticket_status_inputs waits at most 200 ms for a lock, never
--                JIT-compiles, and reads each event's diff once (SMD-2540)
-- =============================================================================
--
-- WHY
--   SMD-2540 PR 2b puts 095's call on every search that names a ticket, and
--   its review pass 7 measured three costs the base search never had:
--   * A lock: the call reads thought_audit, ob1_config, ob1_ticket_head and
--     node_state's tables, which the search itself does not. An ACCESS
--     EXCLUSIVE lock on one (an ALTER TABLE, a VACUUM FULL, a DDL statement
--     queued behind a long reader) held three seconds let 17 labelled
--     searches finish against the base's 3,373, each waiting the whole hold
--     on a pool connection, and a list_thoughts meanwhile waited 2.6 s for
--     one. With a lock_timeout the label is dropped and the search answers.
--   * JIT: the order's every-row arm (060, 095) is estimated at the whole log
--     under the generic plan its nested body gets, past jit_above_cost once
--     thought_audit holds roughly 100,000 rows — 18 functions compiled, about
--     7 ms on every call (10.2 ms against 2.9 ms off, on a seeded brain of
--     151,000 audit rows). 017, 019, 020 and 068's reconcile turn it off.
--   * The diff read four times: the LATERAL that names each event's metadata
--     was pulled up, so its COALESCE ran in the filter and each of the three
--     outputs, decompressing the diff each time. An OFFSET 0 fence keeps it
--     one evaluation (the history arm 1.81 → 1.21 ms at 10 keys, 8.4 → 6.0 ms
--     at 80; the same rows over 90 trials).
--
-- WHAT
--   ticket_status_inputs(uuid[], text[]) redefined over the same signature,
--   rows and order (CREATE OR REPLACE: a --reapply runs 095's body, then this
--   one): SET lock_timeout = '200ms', SET jit = off beside 095's
--   max_parallel_workers_per_gather = 0, and the fence. A lock not granted in
--   200 ms fails the call with 55P03, which the store reads as no label
--   (best-effort, as before 095) and says once (server-portable/store.ts's
--   labelReadFailed). No table, column, index or grant. MINOR under the
--   version rules.
--
-- NOT HERE
--   * A narrower history — only the events at or before a hit's written time
--     plus the settle hour, about 74% of what is read on a seeded brain — needs
--     a per-ticket cutoff argument; the measured cost on stable is the keys a
--     search sends (about 0.1 ms each), not this.
--   * statement_timeout: a SET on the function does not bound the statement
--     that calls it; the store's caller is the place, and the lock is the
--     measured stall.
--
-- Expected outcome
--   SELECT proconfig FROM pg_proc WHERE oid = 'ticket_status_inputs(uuid[], text[])'::regprocedure
--   lists max_parallel_workers_per_gather=0, jit=off and lock_timeout=200ms.
-- Dependencies: 095 (ticket_status_inputs; through it 058, 060, 068).
-- =============================================================================

-- The prerequisite, by name: CREATE OR REPLACE would otherwise create the
-- function on a schema that lacks 095's, binding its calls only when it runs.
DO $g$
BEGIN
  IF to_regprocedure('ticket_status_inputs(uuid[], text[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 098 needs 095 (ticket_status_inputs); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

CREATE OR REPLACE FUNCTION ticket_status_inputs(p_ids uuid[], p_issues text[])
RETURNS TABLE (kind text, thought_id uuid, issue text, status text, status_type text, history jsonb)
LANGUAGE sql
STABLE
-- No parallel workers (095); no JIT, whose compile cost the every-row arm's
-- estimate buys past ~100,000 audit rows; and a lock held elsewhere costs a
-- search 200 ms and its label, never the hold.
SET max_parallel_workers_per_gather = 0
SET jit = off
SET lock_timeout = '200ms'
AS $f$
  -- Arrays and = ANY throughout, and each event's fields read out of its
  -- jsonb once: under a generic plan (a prepared statement's sixth call) an
  -- IN (SELECT …) over the keys joined every event to every key and re-read
  -- the diff per pair — 1,032 keys took 5.3 s against 148 ms custom (095's
  -- first review pass, on a copy of stable).
  WITH want AS MATERIALIZED (
    SELECT coalesce(array_agg(DISTINCT k), ARRAY[]::text[]) AS issues,
           coalesce(array_agg(DISTINCT md5(k)::uuid), ARRAY[]::uuid[]) AS issue_keys
      FROM unnest(coalesce(p_issues, ARRAY[]::text[])) AS k
     WHERE k IS NOT NULL
  ),
  ev AS MATERIALIZED (
    SELECT a.ordinality AS ord, a.created_at AS at, x.md->>'issue' AS issue, x.md->>'status' AS status, x.md->>'status_type' AS status_type
      FROM ob1_thought_events_in_order(ARRAY(
             -- 068's thoughts_issue_key_idx serves this: its expression and its partial predicate.
             SELECT t.id FROM thoughts t, want w
              WHERE t.metadata ? 'issue' AND md5(t.metadata->>'issue')::uuid = ANY(w.issue_keys))) WITH ORDINALITY AS a
      -- OFFSET 0 keeps the metadata one evaluation: pulled up, its COALESCE
      -- ran in the filter and each output, decompressing the diff four times.
      CROSS JOIN LATERAL (SELECT coalesce(a.diff #> '{metadata,after}', CASE WHEN a.action = 'capture' THEN a.diff -> 'metadata' END) AS md OFFSET 0) x
     WHERE a.action IN ('capture', 'update') AND x.md ? 'status'
  )
  SELECT 'lifecycle'::text, n.thought_id, NULL::text, NULL::text, NULL::text, NULL::jsonb
    FROM node_state(coalesce(p_ids, ARRAY[]::uuid[])) n
   WHERE n.open IS NOT NULL
  UNION ALL
  SELECT 'head', NULL, h.issue, h.status, h.status_type, NULL
    FROM ob1_ticket_head h, want w
   WHERE h.issue_key = ANY(w.issue_keys)
     AND h.status_type = ANY(node_lifecycle_types())
     AND coalesce(h.status, '') <> ''
  UNION ALL
  -- One row per ticket, its statuses in the log's order: a set-returning RPC
  -- behind PostgREST is cut at db-max-rows (Supabase's 1,000), silently and
  -- from the tail — the newest statuses — so a row per event would mislabel.
  SELECT 'history', NULL, e.issue, NULL, NULL,
         jsonb_agg(jsonb_build_object('at', (extract(epoch FROM e.at) * 1000)::float8, 'status', e.status, 'status_type', e.status_type) ORDER BY e.ord)
    FROM ev e, want w
   WHERE e.issue = ANY(w.issues)
     AND e.status_type = ANY(node_lifecycle_types())
     AND coalesce(e.status, '') <> ''
   GROUP BY e.issue
$f$;

COMMENT ON FUNCTION ticket_status_inputs(uuid[], text[]) IS
  'What the stated-status label reads (SMD-2540), one tagged row set: kind lifecycle — a hit of p_ids with a lifecycle of its own (node_state open IS NOT NULL), never labelled; kind head — each ticket of p_issues ob1_ticket_head holds with a known lifecycle type and a status, its status now; kind history — one row per such ticket with every status its rows held, one element per capture or update event carrying it (at in ms since the epoch, status, status_type), in the log''s order (060''s ob1_thought_events_in_order, never thought_audit''s seq alone). A NULL or empty list of tickets reads no ticket, of ids no hit. The reading (moved-session-settled, measured by evals/eval-stated-status.ts) runs in the server. STABLE, SECURITY INVOKER; the order reads ob1_config, so a role without that soft grant fails the call and the server shows no label (node_state''s thought_sources is not read when only open is). A lock not granted in 200 ms fails it too (55P03), and it never JIT-compiles. Migration 095 / SMD-2540; bounded, 098.';
