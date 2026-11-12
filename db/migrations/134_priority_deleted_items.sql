-- =============================================================================
-- Migration 134: a deleted thought's or entity's priority statements close —
--                close reason `deleted`, on every delete path, by triggers; a
--                merged entity's move onto its survivor; a sweep for what a
--                role without the priority grants left open (SMD-3711)
-- =============================================================================
--
-- WHY
--   116 keeps every priority statement, and its guard lets a row change only
--   by closing. Deleting the item did nothing to them: delete_thought, a raw
--   DELETE, merge_entities and extraction's pruning of unreferenced entities
--   all left the item's statements open, priority_current kept its winner,
--   and priority_of answered for an item the brain no longer holds (116's
--   section 8 named this SMD-3711's).
--
-- WHAT (the maintainer's choices, 2026-11-12)
--   * CLOSE REASON `deleted`, beside replaced and cleared:
--     priority_assertions_closed is replaced with the three. closed_by stays
--     for `replaced` alone.
--   * TRIGGERS, AFTER DELETE FOR EACH STATEMENT on thoughts and on
--     ob1_entities: every open statement on a deleted item closes as
--     `deleted`, and each item is re-projected (its priority_current row
--     goes). Every delete path fires them: delete_thought's projector, a raw
--     DELETE, a cascade, and the extraction passes' pruning.
--   * A ROLE WITHOUT THE PRIORITY GRANTS (the extraction worker's, say)
--     deletes as before: the trigger asks ob1_priority_can_close() and, when
--     the role could not close a statement, skips, so no delete fails for
--     this file. What it leaves open, ob1_close_orphan_priorities() closes:
--     every open statement on a thought or an entity the brain no longer
--     holds. It runs once here, for items already gone, and after that when
--     an operator calls it.
--   * merge_entities (016's, carried) moves the loser's statements onto the
--     survivor before the loser is deleted: a merge says the two were one.
--     Each open statement on the loser is restated on the survivor — the same
--     maker, level, times, reason, flag, tier and asserted_at — and the
--     loser's closes as replaced by it; where the maker's own statement on
--     the survivor is the later written, that one stands and the loser's
--     closes as replaced by it. A due reference naming the survivor is
--     dropped from the copy (an item's may not name itself). Its answer
--     gains `priorities_moved`. A role without the grants merges as before,
--     and the trigger or the sweep closes the loser's as `deleted`.
--   * A due reference naming the deleted item is left as it is: its
--     statement keeps its own level, and the read finds no due time through
--     a missing reference (the maintainer: closing it would withdraw a level
--     its maker never withdrew).
--
--   NOT CHANGED. Tickets: a ticket is no row of its own, its head is
--   rebuilt wholesale, and a deleted row deletes no ticket; that row's own
--   statements close as a thought's. Open items are never deleted (they are
--   dropped, a status). A reason's text stays: removing it is forgetting,
--   SMD-1723's, which relaxes 116's guard for it.
--
-- CONCURRENCY
--   The triggers update only open rows (closed_at IS NULL), so a writer
--   closing the same statement first leaves them nothing to do; a writer
--   asserting on an item being deleted is refused ITEM_NOT_FOUND once the
--   delete commits, or wrote first and is closed by it. merge_entities takes
--   both entities' priority locks, in key order, before it reads.
--
-- SAFETY
--   One CHECK replaced with a wider one; four new functions and two
--   triggers; merge_entities replaced with its signature. Rows change only
--   by closing a statement whose item is gone, or by a merge's restating.
--   MINOR under FORK.md's version rules. test-schema [121], test-upgrade
--   [20by].
--
-- Prerequisites
--   016 (ob1_entities, merge_entities), 116 (priority_assertions,
--   ob1_priority_project, ob1_priority_isolation), 133 (ob1_priority_lock
--   by the pool's key). Applied by `bun db/migrate.ts`. Re-applied: the
--   CHECK, functions and triggers are replaced as they were; the sweep finds
--   nothing left to close.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['merge_entities(uuid, uuid)', '016 (merge_entities)'],
    ARRAY['ob1_priority_project(text, text)', '116 (ob1_priority_project)'],
    ARRAY['ob1_priority_isolation(text)', '116 (ob1_priority_isolation)'],
    ARRAY['ob1_priority_lock_key(text, text)', '133 (ob1_priority_lock_key)'],
    ARRAY['ob1_priority_lock(text, text)', '133 (ob1_priority_lock)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 134 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('priority_assertions') IS NULL OR to_regclass('ob1_entities') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 134 needs 016 and 116 (ob1_entities, priority_assertions); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- The close reason `deleted`
-- ---------------------------------------------------------------------------
ALTER TABLE priority_assertions DROP CONSTRAINT IF EXISTS priority_assertions_closed;
ALTER TABLE priority_assertions ADD CONSTRAINT priority_assertions_closed
  CHECK ((closed_at IS NULL) = (close_reason IS NULL)
         AND (close_reason IS NULL OR close_reason IN ('replaced', 'cleared', 'deleted'))
         AND (closed_by IS NULL OR close_reason = 'replaced'));

COMMENT ON TABLE priority_assertions IS
  'One statement that an item matters at a level (0 none to 5 critical), optionally by a due time, from a start time, or by another item''s due time, with a reason, made by one key at one time (docs/priority.md decision 2). Append-only: a row changes only to close its window, when its maker replaces or clears it, or (since 134) when its item is deleted. The item is (item_kind, item_key): thought, ticket, entity or item. Written through assert_priority and clear_priority; read through priority_of and priority_history. Migration 116 / SMD-3663; closed on delete, migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- ob1_priority_can_close — whether this role may close and re-project
-- ---------------------------------------------------------------------------
-- What closing a statement and re-projecting its item takes: the priority
-- group's grants on the assertions and the projection. A trigger runs as the
-- deleting role, which need not hold them.
CREATE OR REPLACE FUNCTION ob1_priority_can_close()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT has_table_privilege('priority_assertions', 'SELECT') AND has_table_privilege('priority_assertions', 'UPDATE')
     AND has_table_privilege('priority_current', 'SELECT') AND has_table_privilege('priority_current', 'INSERT')
     AND has_table_privilege('priority_current', 'UPDATE') AND has_table_privilege('priority_current', 'DELETE')
$$;
COMMENT ON FUNCTION ob1_priority_can_close() IS
  'Whether the current role holds what closing a priority statement and re-projecting its item takes: SELECT and UPDATE on priority_assertions, and SELECT, INSERT, UPDATE and DELETE on priority_current (the priority group''s). The delete triggers skip without it. Migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- ob1_priority_close_items — close the statements on items deleted
-- ---------------------------------------------------------------------------
-- Every open statement on the items of one kind named, closed as `deleted`,
-- and each item it closed one on re-projected. The number closed.
CREATE OR REPLACE FUNCTION ob1_priority_close_items(p_kind text, p_keys text[])
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_keys text[];
  v_n    int;
  k      text;
BEGIN
  IF p_keys IS NULL OR cardinality(p_keys) = 0 THEN
    RETURN 0;
  END IF;
  WITH closed AS (
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'deleted'
     WHERE a.closed_at IS NULL AND a.item_kind = p_kind AND a.item_key = ANY(p_keys)
    RETURNING a.item_key)
  SELECT count(*)::int, array_agg(DISTINCT c.item_key ORDER BY c.item_key) INTO v_n, v_keys FROM closed c;
  IF v_n > 0 THEN
    FOREACH k IN ARRAY v_keys LOOP
      PERFORM ob1_priority_project(p_kind, k);
    END LOOP;
  END IF;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION ob1_priority_close_items(text, text[]) IS
  'Closes every open priority statement on the items of kind p_kind keyed p_keys as `deleted`, re-projects each item it closed one on, and returns how many it closed. Its callers: the delete triggers and ob1_close_orphan_priorities. Migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- The delete triggers
-- ---------------------------------------------------------------------------
-- One function for both tables, by the transition table every trigger below
-- names `gone`. Skipped for a role that could not close a statement: the
-- delete is not this file's to refuse, and the sweep closes what it left.
CREATE OR REPLACE FUNCTION ob1_priority_close_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT ob1_priority_can_close() THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'thoughts' THEN
    PERFORM ob1_priority_close_items('thought', ARRAY(SELECT g.id::text FROM gone g));
  ELSIF TG_TABLE_NAME = 'ob1_entities' THEN
    PERFORM ob1_priority_close_items('entity', ARRAY(SELECT g.id::text FROM gone g));
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION ob1_priority_close_deleted() IS
  'The AFTER DELETE statement triggers'' function on thoughts and ob1_entities: every open priority statement on a deleted thought or entity closes as `deleted` and its item is re-projected (ob1_priority_close_items). Skipped for a role without the priority group''s grants (ob1_priority_can_close), which ob1_close_orphan_priorities then covers. Migration 134 / SMD-3711.';

CREATE OR REPLACE TRIGGER priority_close_on_thought_delete
  AFTER DELETE ON thoughts
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_priority_close_deleted();
CREATE OR REPLACE TRIGGER priority_close_on_entity_delete
  AFTER DELETE ON ob1_entities
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_priority_close_deleted();

-- ---------------------------------------------------------------------------
-- ob1_close_orphan_priorities — the sweep
-- ---------------------------------------------------------------------------
-- Every open statement on a thought or an entity the brain no longer holds,
-- closed as `deleted`: what a delete by a role without the grants left, and,
-- once on this upgrade, what every delete before 134 left. A thought key that
-- is no uuid names no thought (only a raw write leaves one).
CREATE OR REPLACE FUNCTION ob1_close_orphan_priorities()
RETURNS TABLE (thoughts_closed int, entities_closed int)
LANGUAGE plpgsql
AS $$
DECLARE
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  PERFORM ob1_priority_isolation('ob1_close_orphan_priorities()');
  thoughts_closed := ob1_priority_close_items('thought', ARRAY(
    SELECT DISTINCT a.item_key FROM priority_assertions a
     WHERE a.closed_at IS NULL AND a.item_kind = 'thought'
       AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = CASE WHEN a.item_key ~ c_uuid THEN a.item_key::uuid END)));
  entities_closed := ob1_priority_close_items('entity', ARRAY(
    SELECT DISTINCT a.item_key FROM priority_assertions a
     WHERE a.closed_at IS NULL AND a.item_kind = 'entity'
       AND NOT EXISTS (SELECT 1 FROM ob1_entities e WHERE e.id = CASE WHEN a.item_key ~ c_uuid THEN a.item_key::uuid END)));
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION ob1_close_orphan_priorities() IS
  'Closes, as `deleted`, every open priority statement on a thought or an entity the brain no longer holds, re-projecting each item, and returns how many of each it closed (thoughts_closed, entities_closed) — zeros when none is left. What a delete by a role without the priority grants leaves (the triggers skip for it); run once by migration 134 for every item deleted before it. Refuses to run outside READ COMMITTED. Migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- merge_entities — 016's, the loser's statements moved onto the survivor
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION merge_entities(p_survivor uuid, p_loser uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_s ob1_entities%ROWTYPE;
  v_l ob1_entities%ROWTYPE;
  v_mentions int;
  v_edges int;
  v_moved int := 0;
  v_now timestamptz;
  v_id uuid;
  v_loser priority_assertions;
  v_have  priority_assertions;
BEGIN
  SELECT * INTO v_s FROM ob1_entities WHERE id = p_survivor;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'SURVIVOR_NOT_FOUND'); END IF;
  SELECT * INTO v_l FROM ob1_entities WHERE id = p_loser;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'LOSER_NOT_FOUND'); END IF;
  IF p_survivor = p_loser THEN RETURN jsonb_build_object('ok', false, 'error', 'SAME_ENTITY'); END IF;
  IF v_s.entity_type <> v_l.entity_type THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TYPE_MISMATCH', 'survivor_type', v_s.entity_type, 'loser_type', v_l.entity_type);
  END IF;

  -- Mentions: move those the survivor lacks, drop the rest with the loser.
  UPDATE thought_entities m SET entity_id = p_survivor
   WHERE m.entity_id = p_loser
     AND NOT EXISTS (SELECT 1 FROM thought_entities s WHERE s.thought_id = m.thought_id AND s.entity_id = p_survivor);
  GET DIAGNOSTICS v_mentions = ROW_COUNT;

  -- Edges: re-point either end, keep symmetric ordering, drop what would
  -- duplicate or self-join.
  WITH moved AS (
    SELECT g.thought_id, g.relation, g.confidence, g.extraction_key, g.canonical_agent_id, g.extracted_at,
           CASE WHEN g.from_entity_id = p_loser THEN p_survivor ELSE g.from_entity_id END AS f,
           CASE WHEN g.to_entity_id   = p_loser THEN p_survivor ELSE g.to_entity_id   END AS t
      FROM ob1_entity_edges g
     WHERE g.from_entity_id = p_loser OR g.to_entity_id = p_loser
  ),
  ordered AS (
    SELECT thought_id, relation, confidence, extraction_key, canonical_agent_id, extracted_at,
           CASE WHEN relation IN ('related_to', 'co_occurs_with') THEN LEAST(f, t) ELSE f END AS f,
           CASE WHEN relation IN ('related_to', 'co_occurs_with') THEN GREATEST(f, t) ELSE t END AS t
      FROM moved WHERE f <> t
  ),
  ins AS (
    INSERT INTO ob1_entity_edges (thought_id, from_entity_id, to_entity_id, relation, confidence, extraction_key, canonical_agent_id, extracted_at)
    SELECT DISTINCT ON (thought_id, f, t, relation) thought_id, f, t, relation, confidence, extraction_key, canonical_agent_id, extracted_at
      FROM ordered ORDER BY thought_id, f, t, relation, confidence DESC
    ON CONFLICT (thought_id, from_entity_id, to_entity_id, relation) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_edges FROM ins;
  DELETE FROM ob1_entity_edges WHERE from_entity_id = p_loser OR to_entity_id = p_loser;
  -- The mentions the survivor already had, which did not move. Explicit, since
  -- the entity key restricts rather than cascades.
  DELETE FROM thought_entities WHERE entity_id = p_loser;

  UPDATE ob1_entities
     SET aliases = (SELECT ARRAY(SELECT DISTINCT a FROM unnest(aliases || v_l.aliases || ARRAY[v_l.name]) a WHERE a <> name ORDER BY a)),
         -- The decision, remembered: future extractions naming the loser land here.
         merged_from = (SELECT ARRAY(SELECT DISTINCT m FROM unnest(merged_from || v_l.merged_from || ARRAY[v_l.normalized_name]) m ORDER BY m)),
         first_seen_at = LEAST(first_seen_at, v_l.first_seen_at),
         last_seen_at  = GREATEST(last_seen_at, v_l.last_seen_at)
   WHERE id = p_survivor;

  -- The loser's priority statements restated on the survivor (134): a merge
  -- says the two were one. Both items' locks first, in key order; a role
  -- without the grants merges as before, and the delete's trigger or the
  -- sweep closes the loser's as deleted.
  IF ob1_priority_can_close() THEN
    PERFORM ob1_priority_lock('entity', k) FROM unnest(ARRAY[p_survivor::text, p_loser::text]) AS k ORDER BY k;
    v_now := clock_timestamp();
    FOR v_loser IN SELECT * FROM priority_assertions x
                    WHERE x.closed_at IS NULL AND x.item_kind = 'entity' AND x.item_key = p_loser::text
                    ORDER BY x.seq LOOP
      SELECT * INTO v_have FROM priority_assertions y
       WHERE y.closed_at IS NULL AND y.item_kind = 'entity' AND y.item_key = p_survivor::text AND y.maker_key = v_loser.maker_key;
      IF v_have.id IS NOT NULL AND v_have.seq > v_loser.seq THEN
        -- The maker's later word on the survivor stands.
        UPDATE priority_assertions SET closed_at = v_now, close_reason = 'replaced', closed_by = v_have.id WHERE id = v_loser.id;
      ELSE
        v_id := gen_random_uuid();
        -- The maker's earlier one on the survivor, if any, and the loser's
        -- close as replaced by the restatement; closed first, as 116's one
        -- open statement per item and maker holds.
        UPDATE priority_assertions SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
         WHERE id = v_loser.id OR id = v_have.id;
        INSERT INTO priority_assertions (id, item_kind, item_key, level, due_at, not_before, due_ref_kind, due_ref_key, reason, inferred,
                                         maker_name, maker_agent_id, maker_kind, maker_trust, maker_scope, maker_source, tier, asserted_at)
        VALUES (v_id, 'entity', p_survivor::text, v_loser.level, v_loser.due_at, v_loser.not_before,
                CASE WHEN v_loser.due_ref_kind = 'entity' AND v_loser.due_ref_key = p_survivor::text THEN NULL ELSE v_loser.due_ref_kind END,
                CASE WHEN v_loser.due_ref_kind = 'entity' AND v_loser.due_ref_key = p_survivor::text THEN NULL ELSE v_loser.due_ref_key END,
                v_loser.reason, v_loser.inferred, v_loser.maker_name, v_loser.maker_agent_id, v_loser.maker_kind, v_loser.maker_trust,
                v_loser.maker_scope, v_loser.maker_source, v_loser.tier, v_loser.asserted_at);
        v_moved := v_moved + 1;
      END IF;
    END LOOP;
    PERFORM ob1_priority_project('entity', p_loser::text);
    PERFORM ob1_priority_project('entity', p_survivor::text);
  END IF;

  DELETE FROM ob1_entities WHERE id = p_loser;

  RETURN jsonb_build_object('ok', true, 'survivor', p_survivor, 'merged', v_l.name, 'mentions_moved', v_mentions, 'edges_moved', v_edges,
                            'priorities_moved', v_moved);
END;
$$;

COMMENT ON FUNCTION merge_entities(uuid, uuid) IS
  'Merge one entity into another of the same type: mentions and edges move to the survivor (duplicates and self-joins dropped), the loser''s name and aliases become aliases, its normalised name joins merged_from so later extractions resolve to the survivor, and the loser is deleted. Since 134 the loser''s open priority statements are restated on the survivor by the same maker (the loser''s closed as replaced by the restatement, or by the maker''s later statement already on the survivor), counted as priorities_moved; a role without the priority grants moves none, and the loser''s close as deleted. The one resolution step that is a human''s to take. Migration 016; priorities, migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- On upgrade: the statements on items deleted before 134
-- ---------------------------------------------------------------------------
DO $sweep$
BEGIN
  PERFORM ob1_close_orphan_priorities();
END
$sweep$;
