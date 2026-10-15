-- =============================================================================
-- Migration 092: what the stated-status label reads, in one call — the hits
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
--       kind 'event'     — every status each named ticket's rows held, one row
--                          per audit event carrying it, in the log's order
--                          (`ord`): 060's ob1_thought_events_in_order over the
--                          rows that carry the ticket's key now. Board-sync
--                          updates a ticket row in place, so its events hold
--                          each status it had (055's payload). Not thought_audit's
--                          seq order: 046's backfill numbered a ticket's older
--                          events after newer ones (the eval's first graded
--                          run found it).
--     An event row's `at` is its event's created_at (the transaction's clock);
--     the reader takes the last event in `ord` order at or before a time.
--
-- NOT HERE
--   * The reading and the label (server-portable/stated-status.ts and the
--     search reply, SMD-2540 PR 2b). No search function changes, so no rank
--     moves and no column is reshaped.
--   * Grants: none. EXECUTE is PUBLIC; the server's role reads thoughts,
--     thought_audit and ob1_ticket_head already (db/config.mjs's capture
--     group). node_state reads thought_sources, a soft grant: a role without
--     it fails this call, and the server shows no label rather than failing
--     the search (the store's best-effort read, as supersededAmong's).
--   * A ticket row deleted, or one whose `issue` facet was taken off, leaves
--     its events out: the rows read are those carrying the key now (068's
--     thoughts_issue_key_idx), not every audit row that ever carried it —
--     board-sync deletes no ticket row. The eval read every event carrying
--     the key; on a brain where the two differ, the label reads the narrower.
--
-- SAFETY
--   Additive: one function, LANGUAGE sql with a string body (no recorded
--   dependency, so a reset drops it in any order), STABLE, SECURITY INVOKER.
--   No table, column or trigger. MINOR under the version rules.
--
-- Expected outcome
--   SELECT kind, issue, status_type FROM ticket_status_inputs(ARRAY[]::uuid[], ARRAY['SMD-1'])
--   returns SMD-1's head and its events, oldest first.
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
      MESSAGE = 'migration 092 needs 068 (ob1_ticket_head, node_state); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_thought_events_in_order(uuid[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 092 needs 060 (ob1_thought_events_in_order); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

CREATE OR REPLACE FUNCTION ticket_status_inputs(p_ids uuid[], p_issues text[])
RETURNS TABLE (kind text, thought_id uuid, issue text, ord bigint, at timestamptz, status text, status_type text)
LANGUAGE sql
STABLE
AS $f$
  WITH keys AS MATERIALIZED (
    SELECT DISTINCT k AS issue, md5(k)::uuid AS issue_key
      FROM unnest(coalesce(p_issues, ARRAY[]::text[])) AS k
     WHERE k IS NOT NULL
  ),
  known AS MATERIALIZED (SELECT unnest(node_lifecycle_types()) AS t),
  carriers AS MATERIALIZED (
    -- 068's thoughts_issue_key_idx serves this: the expression and the partial
    -- predicate are its own.
    SELECT t.id
      FROM thoughts t
     WHERE t.metadata ? 'issue'
       AND md5(t.metadata->>'issue')::uuid IN (SELECT issue_key FROM keys)
  )
  SELECT 'lifecycle'::text, n.thought_id, NULL::text, NULL::bigint, NULL::timestamptz, NULL::text, NULL::text
    FROM node_state(coalesce(p_ids, ARRAY[]::uuid[])) n
   WHERE n.open IS NOT NULL
  UNION ALL
  SELECT 'head', NULL, h.issue, NULL, NULL, h.status, h.status_type
    FROM ob1_ticket_head h
   WHERE h.issue_key IN (SELECT issue_key FROM keys)
     AND h.status_type IN (SELECT t FROM known)
  UNION ALL
  SELECT 'event', NULL, x.md->>'issue', a.ordinality, a.created_at, x.md->>'status', x.md->>'status_type'
    FROM ob1_thought_events_in_order(ARRAY(SELECT id FROM carriers)) WITH ORDINALITY AS a
    CROSS JOIN LATERAL (SELECT coalesce(a.diff #> '{metadata,after}', CASE WHEN a.action = 'capture' THEN a.diff -> 'metadata' END) AS md) x
   WHERE a.action IN ('capture', 'update')
     AND x.md ? 'status'
     AND x.md->>'issue' IN (SELECT issue FROM keys)
     AND x.md->>'status_type' IN (SELECT t FROM known)
$f$;

COMMENT ON FUNCTION ticket_status_inputs(uuid[], text[]) IS
  'What the stated-status label reads (SMD-2540), one tagged row set: kind lifecycle — a hit of p_ids with a lifecycle of its own (node_state open IS NOT NULL), never labelled; kind head — each ticket of p_issues ob1_ticket_head holds with a known lifecycle type, its status now; kind event — every status those tickets'' rows held, one row per capture or update event carrying it, ord its place in the log (060''s ob1_thought_events_in_order, never thought_audit''s seq alone), at its created_at. The reading (moved-session-settled, measured by evals/eval-stated-status.ts) runs in the server. STABLE, SECURITY INVOKER; node_state reads thought_sources, so a role without that soft grant fails the call and the server shows no label. Migration 092 / SMD-2540.';
