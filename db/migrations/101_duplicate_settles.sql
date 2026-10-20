-- =============================================================================
-- Migration 101: Linear's `duplicate` status type is a lifecycle, and it
--                settles — 058's two status sets gain it (SMD-2935)
-- =============================================================================
--
-- WHY
--   058's node_lifecycle_types() lists six state types and node_settled_types()
--   is {completed, canceled}. Linear has a seventh: its Duplicate status has
--   status_type `duplicate`, not `canceled`. Stable's ob1_ticket_head held 16
--   such tickets on 2026-10-19, and to every reader of the sets a Duplicate
--   ticket was an unknown status:
--   * node_state: `open` NULL (18 rows on stable — the 16 tickets and two
--     notes filed under them), not false;
--   * a Duplicate blocker still blocked whatever it blocked, and counted
--     among `unknown_blockers`;
--   * prefer_current never demoted a Duplicate ticket, and 077 never counted
--     one among a thought's finished tickets;
--   * graph-centrality's --status done and --decay-done passed it at full
--     weight;
--   * SMD-2932's findings poster needed a closed set of its own
--     (db/board-findings.ts's closed()), a third definition of settled.
--
-- WHAT
--   * node_lifecycle_types(): the seven, `duplicate` after `canceled`, as
--     Linear's board lists it. node_settled_types(): {completed, canceled,
--     duplicate}. Same signatures, IMMUTABLE as before; CREATE OR REPLACE.
--   * Every function in their schema whose body names either set is altered
--     to the volatility it has — a no-op that invalidates every session's
--     plans built on it. CREATE OR REPLACE alone does not reach a plan that
--     folded the set through a function inlined into another: on PG 16 a
--     session that had called search_thoughts_current (plpgsql) six times,
--     its generic plan cached, kept demoting by the six after 101 while a
--     fresh session did not (review pass 1, run-it). A running server's
--     pooled connections are such sessions; test-upgrade [20at] holds one.
--   * ob1_rebuild_source_gate() after them: 071's mirror stores, per source
--     row, whether its thought's status_type is in node_lifecycle_types(),
--     and says a migration that changes the set runs it (stable: 16 rows
--     false → true). Its locks are SHARE on thoughts and thought_sources,
--     held to this file's commit. No other stored row is computed from the
--     sets: ob1_ticket_head stores the head's status_type as written.
--   * graph-centrality.ts's LIFECYCLE_TYPES and LIFECYCLE_FILTERS.done,
--     board-findings.ts's closed(), the search reply's demotion words
--     (server-portable/render.ts) and the label's fixed words
--     (stated-status.ts) follow, in the same change.
--   No table, column, index or grant. MINOR under the version rules.
--
--   A --reapply runs 058's six, then this file's seven. An older tree's
--   --reapply over a 101 brain puts the six back (and its 071 rebuilds the
--   mirror to them): run this tree's --reapply after it — a plain run skips
--   101, recorded as applied. (On a brain holding a judged relation every
--   --reapply fails at 064 today, before reaching either: SMD-3149.)
--
-- NOT HERE
--   * A Duplicate's target (Linear's duplicateOf): a duplicate settles as a
--     cancel does; what it duplicates stays a link (053's duplicate_of
--     facet), not a status.
--   * graph-centrality's --status open and active: a Duplicate is not open,
--     so they keep their four and two types.
--   * A Duplicate whose original is still open reads finished, as a cancel
--     does: a note filed under it is demoted, a summary naming only it is
--     about finished work (077), and it no longer blocks. The work moved to
--     the original, which is read for itself; following duplicate_of to it
--     would be a rule of its own.
--
-- Expected outcome
--   SELECT node_lifecycle_types(), node_settled_types();
--   → {triage,backlog,unstarted,started,completed,canceled,duplicate},
--     {completed,canceled,duplicate}
--   SELECT * FROM ob1_rebuild_source_gate();  → 0, 0 (the file's own ran)
-- Dependencies: 058 (the sets), 071 (ob1_source_gate, ob1_rebuild_source_gate).
-- =============================================================================

-- The prerequisites, by name: CREATE OR REPLACE would otherwise create the
-- sets on a schema without node_state, and the rebuild would fail unnamed.
DO $g$
BEGIN
  IF to_regprocedure('node_lifecycle_types()') IS NULL OR to_regprocedure('node_settled_types()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 101 needs 058 (node_lifecycle_types, node_settled_types); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_rebuild_source_gate()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 101 needs 071 (ob1_source_gate, ob1_rebuild_source_gate); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

CREATE OR REPLACE FUNCTION node_lifecycle_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT '{triage,backlog,unstarted,started,completed,canceled,duplicate}'::text[] $$;

COMMENT ON FUNCTION node_lifecycle_types() IS
  'The status types node_state knows — Linear''s seven state types, in board order. A status_type outside them is unknown: no lifecycle, no claim that a blocker is settled. graph-centrality.ts''s LIFECYCLE_TYPES must equal it. Migration 058 / SMD-2074; duplicate since migration 101 / SMD-2935.';

CREATE OR REPLACE FUNCTION node_settled_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT '{completed,canceled,duplicate}'::text[] $$;

COMMENT ON FUNCTION node_settled_types() IS
  'The status types that settle a node: a settled blocker blocks nothing and a settled thought is not blocked. graph-centrality.ts''s LIFECYCLE_FILTERS.done must equal it, and db/board-findings.ts reads it for a closed ticket. Migration 058 / SMD-2074; duplicate since migration 101 / SMD-2935.';

-- Every reader's cached plans, in every session: a no-op ALTER of each
-- function whose body names a set (node_state, ticket_references_settled,
-- ticket_status_inputs, 071's gate, …) invalidates the plans that inlined it,
-- and so those of its callers. Read from the catalog, not listed: a reader a
-- later migration adds is covered by its own CREATE OR REPLACE.
DO $touch$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn,
           CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS vol
      FROM pg_proc p
     WHERE p.pronamespace = (SELECT pronamespace FROM pg_proc WHERE oid = 'node_settled_types()'::regprocedure)
       AND p.prosrc ~ 'node_(lifecycle|settled)_types[[:space:]]*[(]'
       AND p.oid NOT IN ('node_lifecycle_types()'::regprocedure, 'node_settled_types()'::regprocedure)
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s %s', r.fn, r.vol);
  END LOOP;
END
$touch$;

-- 071's mirror, to the new set (its own note: a migration that changes
-- node_lifecycle_types() runs this after itself).
SELECT * FROM ob1_rebuild_source_gate();
