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
--   for the whole table, not for the rows the change moves — measured on
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
--   A migration that changes node_lifecycle_types() does two things after it,
--   as 105 did: the plan refresh — 105's no-op ALTER of the brain's own
--   functions that name a set, so no session keeps a plan built on the old
--   set (071's gate triggers among them, which would go on writing gates
--   from it) — and
--     SELECT * FROM ob1_rebuild_source_gate_for_types('{<each type it adds or drops>}');
--   A change to node_settled_types() alone needs the plan refresh and no
--   mirror work: the mirror reads node_lifecycle_types() only.
--   scripts/check-fork-consistency.ts check 39 holds the rebuild: a migration
--   that changes the set calls one of the two, and the keyed one with exactly
--   the types the change adds and drops. node_lifecycle_types()'s comment
--   says the same, where the next change is made.
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
BEGIN
  written := 0; deleted := 0;
  IF p_types IS NULL OR cardinality(p_types) = 0 THEN
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
  -- Each type once: a list naming one a thousand times would otherwise probe,
  -- and copy the ids gathered so far, a thousand times under the locks
  -- (review pass 1: 8 s at 1,000 repeats of a type of 668 rows).
  FOREACH v_type IN ARRAY ARRAY(SELECT DISTINCT x FROM unnest(p_types) x WHERE x IS NOT NULL) LOOP
    v_ids := v_ids || ARRAY(
      SELECT o.thought_id
        FROM thoughts t JOIN thought_sources o ON o.thought_id = t.id
       WHERE t.metadata @> jsonb_build_object('status_type', v_type));
  END LOOP;
  RETURN QUERY SELECT * FROM ob1_source_gate_reconcile(v_ids);
END
$$;

COMMENT ON FUNCTION ob1_rebuild_source_gate_for_types(text[]) IS
  'Reconciles ob1_source_gate for the sourced thoughts whose status_type is one of the types given — what a change to node_lifecycle_types() that adds or drops them moves — under the full rebuild''s SHARE locks on thoughts and thought_sources, and returns what it wrote and deleted. Each type is one probe of 001''s GIN index on thoughts.metadata, so the cost follows those rows, not the table. Refuses to run outside READ COMMITTED; an empty or NULL array touches nothing. Migration 106 / SMD-3160.';

COMMENT ON FUNCTION ob1_rebuild_source_gate() IS
  'Reconciles the whole of ob1_source_gate under SHARE locks on thoughts and thought_sources and returns what it wrote and deleted — zeros when it was exact. Refuses to run outside READ COMMITTED. 071''s seed and the repair after a write made with either table''s user triggers disabled (beside ob1_rebuild_node_projection(), 068''s). A migration that changes node_lifecycle_types() runs ob1_rebuild_source_gate_for_types(<the types it moves>) instead, whose cost follows those rows (106). Migrations 071, 106 / SMD-2267, SMD-3160.';

-- Where the next set change is made: the set's own comment says what follows
-- it (105's words kept, then this).
COMMENT ON FUNCTION node_lifecycle_types() IS
  'The status types node_state knows — Linear''s seven state types, in board order. A status_type outside them is unknown: no lifecycle, no claim that a blocker is settled. graph-centrality.ts''s LIFECYCLE_TYPES must equal it. A migration that changes it runs, after it, the plan refresh (105''s no-op ALTER of the brain''s functions that name a set) and SELECT * FROM ob1_rebuild_source_gate_for_types(''{<each type it adds or drops>}'') — check 39 holds the second. Migration 058 / SMD-2074; duplicate since migration 105 / SMD-2935; the rebuild, 106 / SMD-3160.';
