-- =============================================================================
-- Migration 095: what the stated-status label reads, in one call — the hits
--                with a lifecycle of their own, each named ticket's status
--                now, and every status it held, in the log's order (SMD-2540)
-- =============================================================================
--
-- WHY
--   A session summary that says "2306 is in progress" stays first for a
--   "what next" query after SMD-2306 went Done: 077 never demotes a thought
--   that names an open ticket, and a work log is never superseded by
--   consolidation (SMD-2937). SMD-2540 labels the hit instead — "SMD-2306:
--   In Progress when written, Done now" — and leaves its rank alone. Which
--   reading finds the moved tickets was measured before this file
--   (evals/eval-stated-status.ts, PR 1, #401): moved-session-settled — the
--   ticket's status when the note's session ended (the hook's last line, else
--   when the row was stored) against its status now, no label when the ticket
--   already held its current status type an hour after the note. Held out
--   29 of 30 right, pooled 82 of 84.
--
--   The reading runs in the server, in TypeScript — the code the eval
--   measured (server-portable/stated-status.ts, held to the eval's by its
--   self-check) — because the label moves no rank: nothing here changes a
--   search function. This file gives that reading its inputs.
--
-- WHAT
--   * ticket_status_inputs(p_ids uuid[], p_issues text[]) — STABLE, one tagged
--     row set:
--       kind 'lifecycle' — a hit (p_ids) with a lifecycle of its own
--                          (node_state's open IS NOT NULL: a ticket row, a
--                          note filed under one). The label never reads it:
--                          its status is its own;
--       kind 'head'      — each ticket named (p_issues) that ob1_ticket_head
--                          (068) holds with a known lifecycle type
--                          (node_lifecycle_types()): its status now;
--       kind 'history'   — one row per named ticket: every status its rows
--                          held, one element per audit event carrying it
--                          ({at, status, status_type}, `at` in ms since the
--                          epoch, the event's created_at), in the log's order:
--                          060's ob1_thought_events_in_order over the rows that
--                          carry the ticket's key now. Board-sync updates a
--                          ticket row in place, so its events hold each status
--                          it had (055's payload). Not thought_audit's seq
--                          order: 046's backfill numbered a ticket's older
--                          events after newer ones (the eval's first graded run
--                          found it). One row per ticket, not per event: a
--                          set-returning RPC behind PostgREST is cut at
--                          db-max-rows, silently, from the newest statuses.
--     The reader takes the last status in the log's order at or before a time.
--     A head, or a history element, with no status is left out.
--   * ob1_thought_events_in_order, 060's, redefined to return the same rows in
--     the same order with a list read by thought_audit_thought_id_idx: its one
--     filter, `p_thoughts IS NULL OR thought_id = ANY(p_thoughts)`, read the
--     whole log whenever its body was not inlined — and it is not, as called
--     here (the first review pass). Two arms, each a one-time filter.
--
-- NOT HERE
--   * The reading and the label (server-portable/stated-status.ts and the
--     search reply, SMD-2540 PR 2b). No search function changes, so no rank
--     moves and no column is reshaped.
--   * Grants: none. EXECUTE is PUBLIC; the server's role reads thoughts,
--     thought_audit, ob1_ticket_head and ob1_superseded_by already
--     (db/config.mjs's capture group). The log's order reads ob1_config, a
--     soft grant (the server group): a role without it fails this call, and
--     the server shows no label rather than failing the search (the store's
--     best-effort read, as supersededAmong's). node_state's thought_sources is
--     not read: reading only `open` removes its dependency join (068's
--     observed behaviour; the third review pass found the call working without
--     it on PG16 and PG18).
--   * A ticket row deleted, or one whose `issue` facet was taken off, leaves
--     its events out: the rows read are those carrying one of the named keys
--     now (068's thoughts_issue_key_idx), and each of their events counts
--     toward the ticket the event itself names — not every audit row that ever
--     carried a key. Board-sync deletes and re-keys no ticket row. The eval
--     read every event carrying the key; on stable the two give the same
--     history for every ticket named (0 of the 1,032 keys named across its
--     thoughts differ, the first review pass).
--   * A history element with no status (JSON null or empty) is left out, as a
--     head with none is. The eval kept such an element; stable holds none
--     (all 5,172 statuses are text), so no measured label moves.
--
-- SAFETY
--   Additive: one function, LANGUAGE sql with a string body (no recorded
--   dependency, so a reset drops it in any order), STABLE, SECURITY INVOKER;
--   and 060's ob1_thought_events_in_order redefined over the same signature,
--   rows and order (CREATE OR REPLACE: a --reapply runs 060's body, then this
--   one). No table, column or trigger. MINOR under the version rules.
--
-- Expected outcome
--   SELECT kind, issue, status_type, history FROM ticket_status_inputs(ARRAY[]::uuid[], ARRAY['SMD-1'])
--   returns SMD-1's head and one history row, its statuses oldest first.
-- Dependencies: 058 (node_state, node_lifecycle_types), 060
--   (ob1_thought_events_in_order), 068 (ob1_ticket_head, thoughts_issue_key_idx).
-- =============================================================================

-- The prerequisites, by name: a LANGUAGE sql body binds its calls when it
-- runs, so without this a hand apply ahead of 060 or 068 would succeed and
-- every labelled search lose its label at its first call.
DO $g$
BEGIN
  IF to_regclass('public.ob1_ticket_head') IS NULL OR to_regprocedure('node_state(uuid[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 095 needs 068 (ob1_ticket_head, node_state); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_thought_events_in_order(uuid[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 095 needs 060 (ob1_thought_events_in_order); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

-- 060's order, unchanged in what it returns, rewritten so a list is an index
-- probe. Its one filter, `p_thoughts IS NULL OR a.thought_id = ANY(p_thoughts)`,
-- cannot use thought_audit_thought_id_idx when the body is not inlined — and
-- it is not, with a sub-select argument or WITH ORDINALITY, as 095 calls it —
-- so every call read the whole log (the first review pass). Two arms, each a
-- one-time filter on the argument: the list's rows by index, or every row.
CREATE OR REPLACE FUNCTION ob1_thought_events_in_order(p_thoughts uuid[] DEFAULT NULL)
RETURNS SETOF thought_audit
LANGUAGE sql
STABLE
AS $$
  SELECT a.*
    FROM (SELECT * FROM thought_audit WHERE p_thoughts IS NOT NULL AND thought_id = ANY(p_thoughts)
          UNION ALL
          SELECT * FROM thought_audit WHERE p_thoughts IS NULL) a,
         (SELECT COALESCE((SELECT c.value::timestamptz FROM ob1_config c WHERE c.key = 'audit_seq_exact_since'), 'infinity'::timestamptz) AS b) k
   ORDER BY (a.created_at >= k.b), CASE WHEN a.created_at >= k.b THEN NULL ELSE a.created_at END, a.seq
$$;

COMMENT ON FUNCTION ob1_thought_events_in_order(uuid[]) IS
  'The log in the order a fold replays it (SMD-1997, step 2): every thought_audit row — or the rows of the thoughts named — with the rows before ob1_config.audit_seq_exact_since first, by (created_at, seq), then the rows since, by seq alone (055''s rule: seq is exact insertion order since 050 and heap order before; created_at is the transaction''s clock and inverts a row''s history). The one copy of the rule; ob1_project_thought_event with p_replay walks it, and ticket_status_inputs reads a ticket''s statuses through it. A list is read by thought_audit_thought_id_idx, whatever the plan (095). Migration 060 / SMD-2116; index-friendly, 095 / SMD-2540.';

CREATE OR REPLACE FUNCTION ticket_status_inputs(p_ids uuid[], p_issues text[])
RETURNS TABLE (kind text, thought_id uuid, issue text, status text, status_type text, history jsonb)
LANGUAGE sql
STABLE
-- No parallel workers: the order's every-row arm is estimated at the whole log
-- under the generic plan its body gets, and starting two workers cost more
-- than reading the few hundred events a search names (ten hits: 11 ms with
-- them, 7 without, on a copy of stable).
SET max_parallel_workers_per_gather = 0
AS $f$
  -- Arrays and = ANY throughout, and each event's fields read out of its
  -- jsonb once: under a generic plan (a prepared statement's sixth call) an
  -- IN (SELECT …) over the keys joined every event to every key and re-read
  -- the diff per pair — 1,032 keys took 5.3 s against 148 ms custom (the
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
      CROSS JOIN LATERAL (SELECT coalesce(a.diff #> '{metadata,after}', CASE WHEN a.action = 'capture' THEN a.diff -> 'metadata' END) AS md) x
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
  'What the stated-status label reads (SMD-2540), one tagged row set: kind lifecycle — a hit of p_ids with a lifecycle of its own (node_state open IS NOT NULL), never labelled; kind head — each ticket of p_issues ob1_ticket_head holds with a known lifecycle type and a status, its status now; kind history — one row per such ticket with every status its rows held, one element per capture or update event carrying it (at in ms since the epoch, status, status_type), in the log''s order (060''s ob1_thought_events_in_order, never thought_audit''s seq alone). A NULL or empty list of tickets reads no ticket, of ids no hit. The reading (moved-session-settled, measured by evals/eval-stated-status.ts) runs in the server. STABLE, SECURITY INVOKER; the order reads ob1_config, so a role without that soft grant fails the call and the server shows no label (node_state''s thought_sources is not read when only open is). Migration 095 / SMD-2540.';
