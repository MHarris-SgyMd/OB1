-- =============================================================================
-- Migration 106: a keyed rebuild of 071's gate mirror for a status-set change
--                — only the rows whose status_type the change moves, not the
--                whole mirror (SMD-3160)
-- =============================================================================
--
-- WHY
--   071's ob1_source_gate stores, per source row, whether its thought's
--   status_type is in node_lifecycle_types(), and 071 asks a migration that
--   changes the set to run ob1_rebuild_source_gate(): a reconcile of the whole
--   mirror under SHARE locks on thoughts and thought_sources, held to the
--   migration's commit. 105 (SMD-2935, `duplicate`) did, as 071's own install
--   did. The reconcile joins every source row to its thought, so writes wait
--   for as long as that takes, not for the rows the change moves — measured on
--   PG 16 at compose defaults (SMD-2935 review pass 5): 26 ms at 10,000
--   source rows, 221 ms at 100,000, 3.3–4.4 s at a million (2M thoughts),
--   heading for minutes at the 1B horizon (SMD-2754, SMD-2758). A set change
--   moves only the rows of the types it adds or drops: stable had 16.
--
-- WHAT
--   * ob1_rebuild_source_gate_for_types(text[]) — the keyed form. It refuses
--     outside READ COMMITTED and takes SHARE on thoughts, then
--     thought_sources, as the full rebuild does (a writer working from the
--     old set could otherwise move a status after the scan), then finds the
--     sourced thoughts whose status_type is one of the types given — one
--     probe of 001's GIN index on thoughts.metadata per type, as
--     `metadata @> {"status_type": <type>}` — and reconciles those alone
--     with 071's ob1_source_gate_reconcile(ids). It returns what it wrote
--     and deleted, as the full rebuild does. No advisory lock: SHARE holds
--     off every writer of either table, whose triggers are the mirror's only
--     other writers — the full rebuild takes none either. An empty or NULL
--     array touches nothing.
--   * The full rebuild stays, for repair after a write made with the tables'
--     triggers disabled; its comment now names the keyed form for a set
--     change. 071's header still says to run the full rebuild — the file is
--     not edited (append-only); this one supersedes that note.
--   * ob1_refresh_set_readers() — 105's DO $touch$ block as a call: it alters
--     each of the brain's own functions that name a set to the volatility it
--     has (dropping every session's plans built on it) and returns how many.
--     Without it a pooled session keeps the old set — its searches, its
--     node_state, 071's gate triggers, and drift() itself, which in a warmed
--     session reported 12 phantom rows (review pass 3, run as the next author
--     would).
--   A migration that changes node_lifecycle_types() runs, after the change:
--     SELECT ob1_refresh_set_readers();
--     SELECT * FROM ob1_rebuild_source_gate_for_types('{<each type it adds or drops>}');
--   A change to node_settled_types() alone runs the first and needs no mirror
--   work: the mirror reads node_lifecycle_types() only. check 39 of
--   scripts/check-fork-consistency.ts holds both for a lifecycle change, as
--   top-level statements after the set. What follows the set by hand, and the
--   tests that pin it, are named in node_lifecycle_types()'s comment, where
--   the next change is made.
--   No table, column or grant. MINOR under the version rules.
--
-- NOT HERE
--   * Repair of drift the change did not cause: a row whose stored gate is
--     wrong for another reason (a write with triggers disabled) is the full
--     rebuild's, and drift() names it.
--   * 105 itself: applied, and append-only; its full rebuild stands.
--   * A status_type stored as a JSON number or boolean: the probe matches a
--     JSON string, as Linear and every writer here store it; a set listing
--     '7' or 'true' would need the full rebuild for such rows.
--   * A common type: a type held by a large share of the rows (40%, say) is
--     scanned rather than probed, at about the full rebuild's cost — the
--     keyed form pays for the rows it moves.
--
-- Measured (PG 16, compose defaults, 1M source rows, a capture issued as the
-- call took its locks): with 21,212 rows of the moved type the capture waited
-- 1.39 s for the keyed form against 8.9 s for the full rebuild; with 16
-- (stable's count), 29 ms against 6.2 s. A full reconcile after it found
-- nothing to fix in every run.
--
-- Expected outcome
--   SELECT * FROM ob1_rebuild_source_gate_for_types('{duplicate}');  → 0, 0
--   on an exact mirror.
-- Dependencies: 071 (ob1_source_gate, ob1_source_gate_reconcile,
-- ob1_rebuild_source_gate); 001's GIN index on thoughts.metadata.
-- =============================================================================

-- The prerequisite, by name: the function would otherwise bind its calls only
-- when it first runs.
DO $g$
BEGIN
  IF to_regprocedure('ob1_source_gate_reconcile(uuid[])') IS NULL OR to_regprocedure('ob1_rebuild_source_gate()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 106 needs 071 (ob1_source_gate_reconcile, ob1_rebuild_source_gate); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

CREATE OR REPLACE FUNCTION ob1_rebuild_source_gate_for_types(p_types text[])
RETURNS TABLE (written int, deleted int)
LANGUAGE plpgsql
SET jit = off
-- Planned with its type each time, so each probe is the index's.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_type text;
  v_ids uuid[] := '{}';
  -- Each type once, NULLs out: a list naming one a thousand times would
  -- otherwise probe, and copy the ids gathered so far, a thousand times under
  -- the locks (review pass 1: 8 s at 1,000 repeats of a type of 668 rows);
  -- and a list of NULLs is as empty as '{}', taking no lock (review pass 2).
  v_types text[] := ARRAY(SELECT DISTINCT x FROM unnest(p_types) x WHERE x IS NOT NULL);
BEGIN
  written := 0; deleted := 0;
  IF cardinality(v_types) = 0 THEN
    RETURN NEXT;
    RETURN;
  END IF;
  -- Its snapshot must postdate the locks, as the full rebuild's.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_rebuild_source_gate_for_types() must run under READ COMMITTED; this transaction is %s', upper(current_setting('transaction_isolation'))),
      HINT = 'BEGIN ISOLATION LEVEL READ COMMITTED; then call it (a call outside a transaction takes the default level, which is what refused it).',
      ERRCODE = 'feature_not_supported';
  END IF;
  -- thoughts before thought_sources, the order a writer of both takes them.
  LOCK TABLE thoughts IN SHARE MODE;
  LOCK TABLE thought_sources IN SHARE MODE;
  FOREACH v_type IN ARRAY v_types LOOP
    v_ids := v_ids || ARRAY(
      SELECT o.thought_id
        FROM thoughts t JOIN thought_sources o ON o.thought_id = t.id
       WHERE t.metadata @> jsonb_build_object('status_type', v_type));
  END LOOP;
  RETURN QUERY SELECT * FROM ob1_source_gate_reconcile(v_ids);
END
$$;

-- The plan refresh, as a call: 105's DO $touch$ block, word for word in its
-- rule, so the next set change runs it by name and check 39 can require it.
-- Without it a pooled session keeps a plan built on the old set — its
-- searches, its node_state, and 071's own gate triggers, which would go on
-- writing gates from it — and drift() itself reads the old set there (review
-- pass 3: 12 phantom drift rows in a warmed session). Returns how many of the
-- brain's functions it altered.
CREATE OR REPLACE FUNCTION ob1_refresh_set_readers()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn,
           CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS vol
      FROM pg_proc p
      JOIN pg_proc s ON s.oid = 'node_settled_types()'::regprocedure
     WHERE p.pronamespace = s.pronamespace AND p.proowner = s.proowner
       AND p.prokind IN ('f', 'w')
       AND (p.prosrc ~* 'node_(lifecycle|settled)_types"?[[:space:]]*[(]'
            OR EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_proc'::regclass
                          AND d.refobjid IN ('node_lifecycle_types()'::regprocedure, 'node_settled_types()'::regprocedure)))
       AND p.oid NOT IN ('node_lifecycle_types()'::regprocedure, 'node_settled_types()'::regprocedure,
                         'ob1_refresh_set_readers()'::regprocedure)
  LOOP
    EXECUTE format('ALTER FUNCTION %s %s', r.fn, r.vol);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$$;

COMMENT ON FUNCTION ob1_refresh_set_readers() IS
  'Alters each of the brain''s own functions that name node_lifecycle_types() or node_settled_types() (their schema and owner; by text, in any case, or by dependency) to the volatility it has — a no-op that drops every session''s plans built on it — and returns how many. 105''s DO $touch$ block as a call: a migration that changes either set runs it after the change, then, for a change to node_lifecycle_types(), ob1_rebuild_source_gate_for_types(<the types it adds and drops>). Migration 106 / SMD-3160.';

COMMENT ON FUNCTION ob1_rebuild_source_gate_for_types(text[]) IS
  'Reconciles ob1_source_gate for the sourced thoughts whose status_type is one of the types given — what a change to node_lifecycle_types() that adds or drops them moves — under the full rebuild''s SHARE locks on thoughts and thought_sources, and returns what it wrote and deleted. Each type is one probe of 001''s GIN index on thoughts.metadata, so the cost follows those rows, not the table. Refuses to run outside READ COMMITTED; an empty or NULL array touches nothing. Migration 106 / SMD-3160.';

COMMENT ON FUNCTION ob1_rebuild_source_gate() IS
  'Reconciles the whole of ob1_source_gate under SHARE locks on thoughts and thought_sources and returns what it wrote and deleted — zeros when it was exact. Refuses to run outside READ COMMITTED. 071''s seed and the repair after a write made with either table''s user triggers disabled (beside ob1_rebuild_node_projection(), 068''s). A migration that changes node_lifecycle_types() runs ob1_rebuild_source_gate_for_types(<the types it adds and drops>) instead, whose cost follows those rows (106). Migrations 071, 106 / SMD-2267, SMD-3160.';

-- Where the next set change is made: the set's own comment says what follows
-- it (105's words kept, then this).
COMMENT ON FUNCTION node_lifecycle_types() IS
  'The status types node_state knows — Linear''s state types, in board order. A status_type outside them is unknown: no lifecycle, no claim that a blocker is settled. A migration that changes it, after the change: SELECT ob1_refresh_set_readers(); then SELECT * FROM ob1_rebuild_source_gate_for_types(''{<each type it adds or drops>}''); — check 39 holds both. What follows the set by hand: graph-centrality.ts''s LIFECYCLE_TYPES and LIFECYCLE_FILTERS (open, active, done), stated-status.ts''s TYPE_WORDS (a word for the type), and for a settled change render.ts''s DEMOTIONS and node_settled_types(); the tests that pin it: test-schema [54], [94] and test-e2e-sql [22]. Migration 058 / SMD-2074; duplicate since migration 105 / SMD-2935; the recipe, 106 / SMD-3160.';
