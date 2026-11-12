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
--   * TRIGGERS, AFTER DELETE FOR EACH ROW on thoughts and on ob1_entities:
--     every open statement on a deleted item closes as `deleted`, and the
--     item is re-projected (its priority_current row goes). Every delete path
--     fires them: delete_thought's projector, a raw DELETE, a cascade, and the
--     extraction passes' pruning. Row by row, each first asking whether its item has an
--     open statement at all (review pass 2: a statement trigger's transition
--     table copied every deleted row whole, a thought's vector included, to
--     read its id). A delete in a transaction above READ COMMITTED skips, as
--     every priority writer refuses one, and leaves it to the sweep: a
--     delete that never touched a priority must not start failing on one.
--   * THE EXTRACTION GROUP, whose pruning of unreferenced entities is the
--     commonest entity delete, gains what closing takes (the maintainer,
--     review pass 1): SELECT and UPDATE on priority_assertions, and SELECT,
--     INSERT, UPDATE and DELETE on priority_current. This file grants them to
--     each role holding DELETE on ob1_entities already. 116's guard lets such
--     a role close a statement, never write or reopen one.
--   * A ROLE WITHOUT THOSE GRANTS deletes as before: the trigger asks
--     ob1_priority_can_close() and, when the role could not close a
--     statement, skips, so no delete fails for this file. What it leaves
--     open, ob1_close_orphan_priorities() closes: every open statement on a
--     thought or an entity the brain no longer holds. It runs once here, for
--     items already gone, and after that when an operator calls it.
--   * merge_entities (016's, carried) moves the loser's statements onto the
--     survivor before the loser is deleted: a merge says the two were one.
--     Each open statement on the loser is restated on the survivor — the same
--     maker, level, times, reason, flag, tier and asserted_at — and the
--     loser's closes as replaced by it, as does the maker's own earlier open
--     statement on the survivor. Where the maker's latest word on the
--     survivor is the later written, it stands: an open statement replaces
--     the loser's, a clear clears it (review pass 1: a clear was overlooked
--     and the merge brought back a level the maker had withdrawn). A maker is
--     as the writers match one (116's is_maker: its agent id, a by-name
--     statement taking the id the registry gives its name). A due reference
--     naming the survivor is dropped from the copy (an item's may not name
--     itself). Its answer gains `priorities_moved`. Two words said at one
--     instant (the clock's resolution) go to the loser's, restated: the merge
--     compares times across two items, where no seq orders them (review pass
--     4, said). A restatement is written last, so within its tier it is the
--     survivor's newest, and may outrank another maker's statement written
--     there after the original (the maintainer, review pass 1: kept, merges
--     being an operator's step). A role that could not restate (no INSERT on
--     priority_assertions, no read of the registry), or a transaction above
--     READ COMMITTED, merges as before, and the trigger or the sweep closes
--     the loser's as `deleted`.
--   * A due reference naming the deleted item is left as it is: its
--     statement keeps its own level, and the read finds no due time through
--     a missing reference (the maintainer: closing it would withdraw a level
--     its maker never withdrew).
--
--   NOT CHANGED. Tickets: a ticket is no row of its own, its head is
--   rebuilt wholesale, and a deleted row deletes no ticket. A ticket's own
--   row deleted closes the statements made on it, as a thought's: they
--   counted as the ticket's while the row stood, and the read stopped
--   counting them once it was gone, before 134 too (review pass 5, said).
--   Open items are never deleted (they are dropped, a status). A merge that
--   clears a loser's statement because the maker's latest word on the
--   survivor is a clear records the clear at the merge's time (review pass
--   5, said). A TRUNCATE fires no delete trigger, and leaves its items'
--   statements to the sweep. A reason's text stays: removing it is
--   forgetting, SMD-1723's, which relaxes 116's guard for it. Filed as
--   SMD-4241 from
--   review pass 1: an entity that extraction re-derives (pruned, then made
--   again under a new id) closes as deleted rather than following its name; a
--   merge leaves other statements' due references naming the loser, which
--   then read no due time; 056's apply_entity_type_gate merges a retyped
--   entity inline, so its statements close rather than move.
--
-- CONCURRENCY
--   The triggers update only open rows (closed_at IS NULL), so a writer
--   closing the same statement first leaves them nothing to do. A writer
--   asserting on an item being deleted is refused ITEM_NOT_FOUND once the
--   delete commits, or committed before the trigger's statement and is
--   closed by it; one that checked existence before the delete committed
--   and commits after the trigger read leaves its statement open, for the
--   sweep (review pass 1: locking every deleted key would take a lock per
--   row of a bulk delete). merge_entities locks both entities' rows, in id
--   order, then both their priority locks, in key order, before it reads
--   (review pass 4: a prune of the loser beside it could deadlock with it).
--   A delete's close takes no priority
--   lock (review pass 3, reversing pass 2): held to commit, a lock per item
--   would fill the shared lock table on a bulk delete or the upgrade's sweep,
--   and failing a delete is not this file's to do. A close racing a writer's
--   re-projection of the same item can leave priority_current behind, which
--   the drift check names and ob1_rebuild_priority_projection repairs.
--
-- SAFETY
--   One CHECK replaced with a wider one; four new functions and two
--   triggers; merge_entities replaced with its signature; the extraction
--   group's priority grants carried. Rows change only by closing a statement
--   whose item is gone, or by a merge's restating.
--   MINOR under FORK.md's version rules. test-schema [121], test-upgrade
--   [20by].
--
-- Prerequisites
--   016 (ob1_entities, merge_entities), 116 (priority_assertions,
--   ob1_priority_project, ob1_priority_isolation, ob1_priority_is_maker),
--   133 (ob1_priority_lock by the pool's key). Applied by `bun db/migrate.ts`. Re-applied: the
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
    ARRAY['ob1_priority_is_maker(priority_assertions, text, uuid)', '116 (ob1_priority_is_maker)'],
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
-- and each item it closed one on re-projected. The number closed. No
-- priority lock (review pass 3): see CONCURRENCY above.
CREATE OR REPLACE FUNCTION ob1_priority_close_items(p_kind text, p_keys text[])
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_now  timestamptz;
  v_keys text[];
  v_n    int := 0;
  v_c    int;
  k      text;
BEGIN
  IF p_keys IS NULL OR cardinality(p_keys) = 0 THEN
    RETURN 0;
  END IF;
  v_keys := ARRAY(SELECT DISTINCT a.item_key FROM priority_assertions a
                   WHERE a.closed_at IS NULL AND a.item_kind = p_kind AND a.item_key = ANY(p_keys) ORDER BY 1);
  v_now := clock_timestamp();
  FOREACH k IN ARRAY v_keys LOOP
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'deleted'
     WHERE a.closed_at IS NULL AND a.item_kind = p_kind AND a.item_key = k;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_n := v_n + v_c;
    PERFORM ob1_priority_project(p_kind, k);
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION ob1_priority_close_items(text, text[]) IS
  'Closes every open priority statement on the items of kind p_kind keyed p_keys as `deleted`, re-projects each item it closed one on, and returns how many it closed. It takes no priority lock: a race with a writer''s re-projection is the drift check''s to name and the rebuild''s to repair. Its callers: the delete triggers and ob1_close_orphan_priorities. Migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- The delete triggers
-- ---------------------------------------------------------------------------
-- One function for both tables: the item kind is the trigger's argument
-- (review pass 1: by table name, a renamed table would close nothing).
-- Skipped for a role that could not close a statement, and in a transaction
-- above READ COMMITTED (review pass 2): the delete is not this file's to
-- refuse, and the sweep closes what it left. An item with no open statement,
-- nearly every one, costs one index probe.
CREATE OR REPLACE FUNCTION ob1_priority_close_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The probe first, the full grant check only for an item with a statement
  -- (review pass 3: six privilege lookups a deleted row, nearly none needed).
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted')
     OR NOT has_table_privilege('priority_assertions', 'SELECT') THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM priority_assertions a
              WHERE a.closed_at IS NULL AND a.item_kind = TG_ARGV[0] AND a.item_key = OLD.id::text)
     AND ob1_priority_can_close() THEN
    PERFORM ob1_priority_close_items(TG_ARGV[0], ARRAY[OLD.id::text]);
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION ob1_priority_close_deleted() IS
  'The AFTER DELETE row triggers'' function on thoughts and ob1_entities, the item kind its argument: every open priority statement on a deleted thought or entity closes as `deleted` and its item is re-projected (ob1_priority_close_items). Skipped for a role without what closing takes (ob1_priority_can_close) and in a transaction above READ COMMITTED, which ob1_close_orphan_priorities then covers. Migration 134 / SMD-3711.';

CREATE OR REPLACE TRIGGER priority_close_on_thought_delete
  AFTER DELETE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ob1_priority_close_deleted('thought');
CREATE OR REPLACE TRIGGER priority_close_on_entity_delete
  AFTER DELETE ON ob1_entities
  FOR EACH ROW EXECUTE FUNCTION ob1_priority_close_deleted('entity');

-- ---------------------------------------------------------------------------
-- ob1_close_orphan_priorities — the sweep
-- ---------------------------------------------------------------------------
-- Every open statement on a thought or an entity the brain no longer holds,
-- closed as `deleted`: what a delete by a role without the grants left, and,
-- once on this upgrade, what every delete before 134 left. A thought key that
-- is no uuid names no thought (only a raw write leaves one); a uuid's case is
-- no matter (review pass 2: a raw upper-case key on a thought still there was
-- read as gone).
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
       AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = CASE WHEN a.item_key ~* c_uuid THEN a.item_key::uuid END)));
  entities_closed := ob1_priority_close_items('entity', ARRAY(
    SELECT DISTINCT a.item_key FROM priority_assertions a
     WHERE a.closed_at IS NULL AND a.item_kind = 'entity'
       AND NOT EXISTS (SELECT 1 FROM ob1_entities e WHERE e.id = CASE WHEN a.item_key ~* c_uuid THEN a.item_key::uuid END)));
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
  v_restated uuid[] := '{}';
  v_now timestamptz;
  v_id uuid;
  v_maker uuid;
  v_loser priority_assertions;
  v_have  priority_assertions;
  v_open  priority_assertions;
BEGIN
  -- Both rows locked first, in id order (134's review pass 4): a prune of the
  -- loser running beside the merge waits for it, rather than closing the
  -- loser's statements in its trigger while the merge holds them and
  -- deadlocking on the loser's row.
  PERFORM 1 FROM ob1_entities WHERE id IN (p_survivor, p_loser) ORDER BY id FOR UPDATE;
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
  -- says the two were one. Both items' locks first, in key order; a role that
  -- could not restate (INSERT, and the registry for a maker's id: review pass
  -- 2), or a transaction above READ COMMITTED, as the writers refuse one
  -- (review pass 3), merges as before, and the delete's trigger or the sweep
  -- closes the loser's as deleted.
  IF current_setting('transaction_isolation') IN ('read committed', 'read uncommitted')
     AND ob1_priority_can_close() AND has_table_privilege('priority_assertions', 'INSERT') AND has_table_privilege('ob1_agents', 'SELECT') THEN
    -- Explicitly in key order (review pass 3), as every holder of two takes them.
    PERFORM ob1_priority_lock('entity', LEAST(p_survivor::text, p_loser::text));
    PERFORM ob1_priority_lock('entity', GREATEST(p_survivor::text, p_loser::text));
    v_now := clock_timestamp();
    -- In the order they were said, so a maker's later one on the loser
    -- replaces its own restated earlier one.
    FOR v_loser IN SELECT * FROM priority_assertions x
                    WHERE x.closed_at IS NULL AND x.item_kind = 'entity' AND x.item_key = p_loser::text
                    ORDER BY x.asserted_at, x.seq LOOP
      -- The maker as the writers match one: its agent id, a by-name
      -- statement taking the id the registry gives its name now.
      v_maker := COALESCE(v_loser.maker_agent_id, (SELECT g.canonical_agent_id FROM ob1_agents g WHERE g.label = v_loser.maker_name));
      -- Its latest word on the survivor, by when it was said: a statement's
      -- asserted_at (a restatement keeps its original's), a clear's
      -- closed_at (review pass 2: by seq, an earlier merge's restatement read
      -- as later than the maker's statement on another loser, and a clear
      -- counted from when its statement was made).
      SELECT * INTO v_have FROM priority_assertions y
       WHERE y.item_kind = 'entity' AND y.item_key = p_survivor::text AND ob1_priority_is_maker(y, v_loser.maker_name, v_maker)
       ORDER BY GREATEST(y.asserted_at, CASE WHEN y.close_reason = 'cleared' THEN y.closed_at END) DESC, y.seq DESC
       LIMIT 1;
      IF v_have.id IS NOT NULL
         AND GREATEST(v_have.asserted_at, CASE WHEN v_have.close_reason = 'cleared' THEN v_have.closed_at END) > v_loser.asserted_at THEN
        -- The maker's later word on the survivor stands: its open statement
        -- replaces the loser's, and with none open, its clear clears it.
        SELECT * INTO v_open FROM priority_assertions y
         WHERE y.closed_at IS NULL AND y.item_kind = 'entity' AND y.item_key = p_survivor::text
           AND ob1_priority_is_maker(y, v_loser.maker_name, v_maker)
         ORDER BY y.seq DESC LIMIT 1;
        IF v_open.id IS NOT NULL THEN
          UPDATE priority_assertions SET closed_at = v_now, close_reason = 'replaced', closed_by = v_open.id WHERE id = v_loser.id AND closed_at IS NULL;
        ELSE
          UPDATE priority_assertions SET closed_at = v_now, close_reason = 'cleared' WHERE id = v_loser.id AND closed_at IS NULL;
        END IF;
      ELSE
        v_id := gen_random_uuid();
        -- The maker's open statements on the survivor, and the loser's, close
        -- as replaced by the restatement; closed first, as 116's one open
        -- statement per item and maker holds.
        UPDATE priority_assertions y SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
         WHERE (y.id = v_loser.id AND y.closed_at IS NULL)
            OR (y.closed_at IS NULL AND y.item_kind = 'entity' AND y.item_key = p_survivor::text
                AND ob1_priority_is_maker(y, v_loser.maker_name, v_maker));
        INSERT INTO priority_assertions (id, item_kind, item_key, level, due_at, not_before, due_ref_kind, due_ref_key, reason, inferred,
                                         maker_name, maker_agent_id, maker_kind, maker_trust, maker_scope, maker_source, tier, asserted_at)
        VALUES (v_id, 'entity', p_survivor::text, v_loser.level, v_loser.due_at, v_loser.not_before,
                CASE WHEN v_loser.due_ref_kind = 'entity' AND v_loser.due_ref_key = p_survivor::text THEN NULL ELSE v_loser.due_ref_kind END,
                CASE WHEN v_loser.due_ref_kind = 'entity' AND v_loser.due_ref_key = p_survivor::text THEN NULL ELSE v_loser.due_ref_key END,
                v_loser.reason, v_loser.inferred, v_loser.maker_name, v_loser.maker_agent_id, v_loser.maker_kind, v_loser.maker_trust,
                v_loser.maker_scope, v_loser.maker_source, v_loser.tier, v_loser.asserted_at);
        v_restated := v_restated || v_id;
      END IF;
    END LOOP;
    -- The restatements still standing: a maker's by-name and by-id statements
    -- on the loser are restated in turn, the later replacing the earlier
    -- (review pass 5: counted each, priorities_moved said two for one).
    v_moved := (SELECT count(*)::int FROM priority_assertions WHERE id = ANY(v_restated) AND closed_at IS NULL);
    PERFORM ob1_priority_project('entity', p_loser::text);
    PERFORM ob1_priority_project('entity', p_survivor::text);
  END IF;

  DELETE FROM ob1_entities WHERE id = p_loser;

  RETURN jsonb_build_object('ok', true, 'survivor', p_survivor, 'merged', v_l.name, 'mentions_moved', v_mentions, 'edges_moved', v_edges,
                            'priorities_moved', v_moved);
END;
$$;

COMMENT ON FUNCTION merge_entities(uuid, uuid) IS
  'Merge one entity into another of the same type: mentions and edges move to the survivor (duplicates and self-joins dropped), the loser''s name and aliases become aliases, its normalised name joins merged_from so later extractions resolve to the survivor, and the loser is deleted. Since 134 the loser''s open priority statements are restated on the survivor by the same maker, matched as 116''s is_maker matches one (the loser''s closed as replaced by the restatement; where the maker''s latest word on the survivor is later, a statement replaces the loser''s and a clear clears it), counted as priorities_moved; a restatement is the survivor''s newest within its tier. A role that could not restate, or a transaction above READ COMMITTED, moves none, and the loser''s close as deleted. Both rows are locked first, in id order. The one resolution step that is a human''s to take. Migration 016; priorities, migration 134 / SMD-3711.';

-- ---------------------------------------------------------------------------
-- The extraction group's priority grants, carried
-- ---------------------------------------------------------------------------
-- What closing takes, granted to each role holding DELETE on ob1_entities
-- already (the extraction group's), as 132 carried its table: its pruning of
-- unreferenced entities is the commonest entity delete, and without them the
-- trigger skips it (the maintainer, review pass 1). Never to PUBLIC (review
-- pass 2): a closing grant is a role's. The owner holds them already; a
-- re-apply grants what is held, which changes nothing.
DO $grant$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT a.grantee
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'ob1_entities'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0 AND a.privilege_type = 'DELETE'
  LOOP
    EXECUTE format('GRANT SELECT, UPDATE ON priority_assertions TO %1$s; GRANT SELECT, INSERT, UPDATE, DELETE ON priority_current TO %1$s',
                   quote_ident(pg_get_userbyid(v_role.grantee)));
  END LOOP;
END
$grant$;

-- ---------------------------------------------------------------------------
-- On upgrade: the statements on items deleted before 134
-- ---------------------------------------------------------------------------
DO $sweep$
BEGIN
  PERFORM ob1_close_orphan_priorities();
END
$sweep$;
