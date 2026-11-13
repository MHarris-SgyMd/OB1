-- =============================================================================
-- Migration 139: an entity's priority statements follow it — the prunes spare
--                an entity someone stated a priority on, a retype merge moves
--                its statements as merge_entities does, and a merge restates
--                the due references naming its loser (SMD-4241)
-- =============================================================================
--
-- WHY
--   136 closes a deleted entity's open statements as `deleted`, and
--   merge_entities restates a loser's on its survivor. Three entity paths
--   still lost a stance no one withdrew:
--   * THE PRUNE. Extraction prunes an entity nothing mentions any more: the
--     thought's next extraction no longer names it (or names it as another
--     type), or its thought is deleted. A re-extraction naming the same
--     entity keeps its id (061's upsert runs before the mentions are
--     replaced), so the prune is the one loss. Its statements closed as
--     `deleted`, and a later capture of the name made a new entity with none.
--   * THE RETYPE MERGE. 056's apply_entity_type_gate merges a retyped entity
--     into the one of its new type inline, by merge_entities' steps, and
--     deletes it: its statements closed rather than moved.
--   * DUE REFERENCES. A merge left other statements whose due reference
--     names the loser, and the read found no due time through them, though
--     the item referenced lives on as the survivor.
--
-- WHAT (the maintainer's choices, 2026-11-13)
--   * AN ENTITY WITH AN OPEN PRIORITY STATEMENT IS NO ORPHAN. The three
--     prunes skip it: record_thought_entities (061's body, carried),
--     rebuild_derived (067's body, carried; both of its prunes, where its
--     input thought is gone) and prune_orphan_entities (016's). It stays in
--     the graph with no mention until its statements are cleared; the next
--     prune touching it, or prune_orphan_entities, then takes it. A
--     deliberate delete still closes them as `deleted` (136): a merge, the
--     gate's refusal of a name, an operator's DELETE. The test is
--     ob1_entity_has_open_priority(id); a role without SELECT on
--     priority_assertions is answered false and prunes as before, leaving
--     the statements to 136's sweep (a query naming the table would fail
--     the role's whole extraction).
--   * ob1_priority_merge_entity(survivor, loser), shared by merge_entities
--     and the gate's merge, does what 136's merge_entities did inline: the
--     loser's open statements restated on the survivor, the maker's later
--     word there standing. It also restates each open statement on another
--     item whose due reference names the loser: the same maker, level,
--     times, reason, flag, tier and asserted_at, the reference naming the
--     survivor, the old one closed as replaced by it. A reference that
--     would then name its own item (a statement on the survivor, or a
--     loser's restated there) is dropped, as 136 drops one. Every item it
--     touches is locked first, in the order of its pool's key (133's
--     ob1_priority_lock_key, the order the rebuild takes), and re-projected
--     after. A restatement is the newest written within its tier on its
--     item, so it may outrank another maker's statement written there after
--     the original: 136 kept that for the survivor (merges being an
--     operator's step), and it holds for an item whose due reference moved.
--     A role that could not restate, or a transaction above READ
--     COMMITTED, moves nothing, as in 136.
--   * merge_entities (136's, carried) calls it; its answer gains
--     `priority_refs_moved`. apply_entity_type_gate (056's, carried) calls
--     it in its merge; its answer gains `priorities_moved` and
--     `priority_refs_moved`.
--
--   NOT CHANGED. A writer that read a due reference's item as standing
--   before a merge committed, and commits after the merge read the
--   references, keeps naming the loser: the read finds no due time through
--   it, as 136 left a reference to a deleted item. A writer stating a
--   priority on an entity a prune is deleting at that instant writes on a
--   deleted entity, for 136's sweep. The carried bodies are verbatim but for
--   the lines marked `139`.
--
-- SAFETY
--   Two new functions; five replaced with their signatures and return types
--   (record_thought_entities, rebuild_derived, prune_orphan_entities,
--   merge_entities, apply_entity_type_gate). No table or grant changes. The
--   prunes delete fewer rows; a merge writes rows only by restating.
--   MINOR under FORK.md's version rules. test-schema [126],
--   test-upgrade [20cd].
--
-- Prerequisites
--   What the carried bodies call: 016 (normalize_entity_name,
--   content_fingerprint_of, requeue_thought_work), 056 and 065
--   (entity_type_gate), 060 (ob1_refresh_thought_vector), 061
--   (ob1_actor_agent_id, ob1_record_derivation), 063
--   (derivation_descendants), 067 (rebuild_derived's body), 116
--   (priority_assertions, ob1_priority_project, ob1_priority_is_maker), 133
--   (ob1_priority_lock, ob1_priority_lock_key) and 136
--   (ob1_priority_can_close). Applied by `bun db/migrate.ts`. Re-applied:
--   the functions are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['normalize_entity_name(text)', '016 (normalize_entity_name)'],
    ARRAY['content_fingerprint_of(text)', '016 (content_fingerprint_of)'],
    ARRAY['requeue_thought_work(text, uuid)', '016 (requeue_thought_work)'],
    ARRAY['prune_orphan_entities()', '016 (prune_orphan_entities)'],
    ARRAY['merge_entities(uuid, uuid)', '016 (merge_entities)'],
    ARRAY['entity_type_gate(text, text)', '056 (entity_type_gate)'],
    ARRAY['apply_entity_type_gate()', '056 (apply_entity_type_gate)'],
    ARRAY['ob1_actor_agent_id()', '061 (ob1_actor_agent_id)'],
    ARRAY['record_thought_entities(uuid, text, jsonb, jsonb, text, uuid, jsonb)', '061 (record_thought_entities)'],
    ARRAY['derivation_descendants(uuid, integer, integer)', '063 (derivation_descendants)'],
    ARRAY['rebuild_derived(uuid, text, boolean, text[], boolean, boolean)', '063 (rebuild_derived)'],
    ARRAY['settle_supersession_proposal(uuid, text, jsonb, text, text, text, jsonb, uuid)', '067 (settle_supersession_proposal)'],
    ARRAY['ob1_priority_project(text, text)', '116 (ob1_priority_project)'],
    ARRAY['ob1_priority_is_maker(priority_assertions, text, uuid)', '116 (ob1_priority_is_maker)'],
    ARRAY['ob1_priority_lock_key(text, text)', '133 (ob1_priority_lock_key)'],
    ARRAY['ob1_priority_lock(text, text)', '133 (ob1_priority_lock)'],
    ARRAY['ob1_priority_can_close()', '136 (ob1_priority_can_close)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 139 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  -- By name: ob1_refresh_thought_vector's argument list names the brain's
  -- vector dimension, and ob1_record_derivation is asked the same way.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ob1_record_derivation')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ob1_refresh_thought_vector') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 139 needs 060 and 061 (ob1_refresh_thought_vector, ob1_record_derivation); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('priority_assertions') IS NULL OR to_regclass('ob1_entities') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 139 needs 016 and 116 (ob1_entities, priority_assertions); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_entity_has_open_priority — the prunes' spare test
-- ---------------------------------------------------------------------------
-- plpgsql, the table read only in the branch a role that may read it takes:
-- a SQL function's query, or the prune's own, is checked for privilege
-- whole at every call, and a role without SELECT on priority_assertions
-- would fail its extraction (SMD-3711's lesson). Such a role is answered
-- false, and prunes as before 139.
CREATE OR REPLACE FUNCTION ob1_entity_has_open_priority(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF NOT has_table_privilege('priority_assertions', 'SELECT') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM priority_assertions a
                  WHERE a.closed_at IS NULL AND a.item_kind = 'entity' AND a.item_key = p_id::text);
END;
$$;
COMMENT ON FUNCTION ob1_entity_has_open_priority(uuid) IS
  'Whether an entity has an open priority statement, which spares it from the prunes of unreferenced entities (record_thought_entities, rebuild_derived, prune_orphan_entities): an entity someone stated a priority on is no orphan. False for a role without SELECT on priority_assertions, which prunes as before; 136''s ob1_close_orphan_priorities closes what that leaves. Migration 139 / SMD-4241.';

-- ---------------------------------------------------------------------------
-- prune_orphan_entities — 016's, an entity with an open statement spared
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_orphan_entities()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_n int := 0;
BEGIN
  -- Lock, then delete in a fresh statement — the same ordering as the prune in
  -- record_thought_entities, for the same reason: a worker's concurrent
  -- mention waits on the lock or is already visible, so each candidate is
  -- decided against the current state and none is lost to the snapshot.
  -- 139: an entity with an open priority statement is no orphan.
  PERFORM 1 FROM ob1_entities en
   WHERE NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = en.id)
     AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = en.id OR g.to_entity_id = en.id)
     AND NOT ob1_entity_has_open_priority(en.id)
   FOR UPDATE;
  DELETE FROM ob1_entities en
   WHERE NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = en.id)
     AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = en.id OR g.to_entity_id = en.id)
     AND NOT ob1_entity_has_open_priority(en.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION prune_orphan_entities() IS
  'Delete entities with no mention and no edge — what a deleted thought leaves behind. Returns the count. Since 139 an entity with an open priority statement is spared (ob1_entity_has_open_priority). Migration 016; migration 139 / SMD-4241.';


-- ---------------------------------------------------------------------------
-- record_thought_entities — 061's, an entity with an open statement spared
-- ---------------------------------------------------------------------------
-- 061's body verbatim but for the lines marked 139: its prune skips an
-- entity someone stated a priority on.

CREATE OR REPLACE FUNCTION record_thought_entities(
  p_thought_id          uuid,
  p_extraction_key      text,
  p_entities            jsonb,
  p_relations           jsonb DEFAULT '[]'::jsonb,
  p_content_fingerprint text  DEFAULT NULL,
  p_agent_id            uuid  DEFAULT NULL,
  -- 061: the pass's recipe — model, prompt version and hash, the windows —
  -- recorded beside the input's fingerprint in `derivations` (SMD-1731).
  -- NULL: the key alone, said to be undeclared.
  p_recipe              jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_fp text;
  v_exists     boolean;
  v_new        int := 0;
  v_mentions   int := 0;
  v_edges      int := 0;
  v_dropped    int := 0;
  v_ambiguous  int := 0;
  v_pruned     int := 0;
  v_entities   int := 0;
  v_refused    int := 0;
  v_retyped    int := 0;
  -- ob1:structured-wins (053): a `source:<system>` key is a structured pass.
  v_structured boolean := p_extraction_key LIKE 'source:%';
  -- 061: whether rows stand under this key after the write, and whether
  -- this call wrote or removed any — the lineage row's two gates.
  v_standing   boolean;
  v_touched    int := 0;
  v_recipe     jsonb;
  v_recorded   jsonb;
BEGIN
  IF p_extraction_key IS NULL OR p_extraction_key = '' THEN
    RAISE EXCEPTION 'record_thought_entities: p_extraction_key must name the pass, e.g. extract:<model>@p1 or source:<system>';
  END IF;
  IF p_entities IS NULL OR jsonb_typeof(p_entities) <> 'array' THEN
    RAISE EXCEPTION 'record_thought_entities: p_entities must be a JSON array, got %', COALESCE(jsonb_typeof(p_entities), 'NULL');
  END IF;
  IF p_relations IS NOT NULL AND jsonb_typeof(p_relations) <> 'array' THEN
    RAISE EXCEPTION 'record_thought_entities: p_relations must be a JSON array, got %', jsonb_typeof(p_relations);
  END IF;
  IF p_recipe IS NOT NULL AND (jsonb_typeof(p_recipe) <> 'object' OR COALESCE(jsonb_typeof(p_recipe->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'record_thought_entities: p_recipe must be a JSON object carrying a boolean "deterministic", got %', p_recipe;
  END IF;

  SELECT true, COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))
    INTO v_exists, v_current_fp FROM thoughts t WHERE t.id = p_thought_id;
  IF v_exists IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_content_fingerprint IS NOT NULL AND v_current_fp IS DISTINCT FROM p_content_fingerprint THEN
    RETURN jsonb_build_object('ok', false, 'stale', true, 'error', 'STALE_CONTENT');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _rte_in (
    name text, ntype text, nname text, confidence numeric(3,2), aliases text[]
  ) ON COMMIT DROP;
  DELETE FROM _rte_in WHERE true;
  -- ob1:name-gate (056): what the gate refuses and retypes, over the entities
  -- the insert below would otherwise have written — the same four
  -- conditions, one per answered (type, name): `hono/mcp` answered as a
  -- person and as a place is two retypes onto one tool. An
  -- extraction only: a structured pass states its names on the source's
  -- authority (a Linear label `2024` is a label) and is not gated.
  IF NOT v_structured THEN
    SELECT count(DISTINCT (g.xtype, g.nname)) FILTER (WHERE g.ntype IS NULL),
           count(DISTINCT (g.xtype, g.nname)) FILTER (WHERE g.ntype <> g.xtype)
      INTO v_refused, v_retyped
      FROM (SELECT lower(btrim(x->>'type')) AS xtype, normalize_entity_name(x->>'name') AS nname,
                   entity_type_gate(x->>'name', lower(btrim(x->>'type'))) AS ntype
              FROM jsonb_array_elements(p_entities) x
             WHERE jsonb_typeof(x) = 'object'
               AND normalize_entity_name(x->>'name') IS NOT NULL
               AND length(btrim(x->>'name')) BETWEEN 1 AND 200
               AND lower(btrim(x->>'type')) IN ('person', 'organization', 'project', 'tool', 'topic', 'place')) g;
  END IF;
  INSERT INTO _rte_in (name, ntype, nname, confidence, aliases)
  SELECT DISTINCT ON (e.ntype, e.nname) e.name, e.ntype, e.nname, e.confidence, e.aliases
    FROM (
      SELECT btrim(x->>'name')                                            AS name,
             lower(btrim(x->>'type'))                                     AS xtype,
             CASE WHEN v_structured THEN lower(btrim(x->>'type'))
                  ELSE entity_type_gate(x->>'name', lower(btrim(x->>'type'))) END AS ntype,
             normalize_entity_name(x->>'name')                            AS nname,
             LEAST(GREATEST(COALESCE((x->>'confidence')::numeric, 0.5), 0), 1)::numeric(3,2) AS confidence,
             COALESCE(ARRAY(SELECT DISTINCT btrim(a) FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(x->'aliases') = 'array' THEN x->'aliases' ELSE '[]'::jsonb END) a
               WHERE btrim(a) <> '' AND btrim(a) <> btrim(x->>'name') ORDER BY 1), '{}'::text[]) AS aliases
        FROM jsonb_array_elements(p_entities) x
       WHERE jsonb_typeof(x) = 'object'
    ) e
   WHERE e.nname IS NOT NULL
     AND length(e.name) BETWEEN 1 AND 200
     AND e.xtype IN ('person', 'organization', 'project', 'tool', 'topic', 'place')
     AND e.ntype IS NOT NULL
   ORDER BY e.ntype, e.nname, e.confidence DESC;

  UPDATE _rte_in i
     SET nname   = en.normalized_name,
         aliases = ARRAY(SELECT DISTINCT a FROM unnest(i.aliases || ARRAY[i.name]) a WHERE a <> en.name ORDER BY a),
         name    = en.name
    FROM ob1_entities en
   WHERE en.entity_type = i.ntype AND en.merged_from @> ARRAY[i.nname];
  DELETE FROM _rte_in a USING _rte_in b
   WHERE a.ntype = b.ntype AND a.nname = b.nname
     AND (a.confidence < b.confidence OR (a.confidence = b.confidence AND a.ctid > b.ctid));

  -- A structured pass re-stating what it stated before is not a new sighting:
  -- last_seen_at moves for an extraction (016's rule) and, for a structured
  -- pass, only where a mention is actually written below — so a sync pass
  -- over an unchanged ticket leaves the project entity's last_seen_at where
  -- it was and 029's stale_entities can still see it (053's third review
  -- pass, independent read).
  -- …and a structured pass that brings no new alias writes no entity row at
  -- all: without the WHERE, a no-op pass left a dead tuple per entity every
  -- five minutes on every stale ticket (053's fourth review pass). An extraction
  -- still moves last_seen_at, so it always writes.
  WITH up AS (
    INSERT INTO ob1_entities (entity_type, name, normalized_name, aliases)
    SELECT i.ntype, i.name, i.nname, i.aliases FROM _rte_in i
    ON CONFLICT (entity_type, normalized_name) DO UPDATE
      SET last_seen_at = CASE WHEN v_structured THEN ob1_entities.last_seen_at ELSE now() END,
          aliases = (SELECT ARRAY(SELECT DISTINCT a FROM unnest(
                       ob1_entities.aliases
                       || EXCLUDED.aliases
                       || CASE WHEN EXCLUDED.name <> ob1_entities.name THEN ARRAY[EXCLUDED.name] ELSE '{}'::text[] END
                     ) a WHERE a <> ob1_entities.name ORDER BY a))
      WHERE NOT v_structured
         OR EXISTS (SELECT 1 FROM unnest(EXCLUDED.aliases || CASE WHEN EXCLUDED.name <> ob1_entities.name THEN ARRAY[EXCLUDED.name] ELSE '{}'::text[] END) a
                     WHERE a <> ob1_entities.name AND NOT (a = ANY(ob1_entities.aliases)))
    RETURNING (xmax = 0) AS created
  )
  SELECT count(*) FILTER (WHERE created) INTO v_new FROM up;
  SELECT count(*) INTO v_entities FROM _rte_in;

  -- The entities this call names, resolved.
  CREATE TEMP TABLE IF NOT EXISTS _rte_ids (id uuid) ON COMMIT DROP;
  DELETE FROM _rte_ids WHERE true;
  INSERT INTO _rte_ids
  SELECT en.id FROM _rte_in i JOIN ob1_entities en ON en.entity_type = i.ntype AND en.normalized_name = i.nname;

  -- Replace the calling pass's class of rows, remembering which entities
  -- they pointed at (the only candidates for pruning). An extraction replaces
  -- every extracted row, as 016 did. A structured pass is a SET: its own rows
  -- for entities it no longer names go, its own rows for entities it still
  -- names STAND (no delete-and-reinsert — the same set twice writes no row,
  -- as record_source_links's does), and what it newly names is inserted.
  -- Its edges are still replaced whole: no adapter states an entity relation
  -- yet, so the set rule for edges waits for the first that does.
  CREATE TEMP TABLE IF NOT EXISTS _rte_touched (id uuid) ON COMMIT DROP;
  DELETE FROM _rte_touched WHERE true;
  WITH d AS (
    DELETE FROM ob1_entity_edges
     WHERE thought_id = p_thought_id
       AND CASE WHEN v_structured THEN extraction_key = p_extraction_key ELSE extraction_key NOT LIKE 'source:%' END
    RETURNING from_entity_id, to_entity_id)
  INSERT INTO _rte_touched SELECT from_entity_id FROM d UNION SELECT to_entity_id FROM d;
  WITH d AS (
    DELETE FROM thought_entities
     WHERE thought_id = p_thought_id
       AND CASE WHEN v_structured
                THEN extraction_key = p_extraction_key AND entity_id NOT IN (SELECT id FROM _rte_ids)
                ELSE extraction_key NOT LIKE 'source:%' END
    RETURNING entity_id)
  INSERT INTO _rte_touched SELECT entity_id FROM d;

  -- On the same (thought, entity) the structured row stands: an extracted
  -- insert onto it does nothing, a structured insert onto an extracted row
  -- takes it over, and a structured insert onto its own standing row is no
  -- write at all.
  CREATE TEMP TABLE IF NOT EXISTS _rte_new (id uuid) ON COMMIT DROP;
  DELETE FROM _rte_new WHERE true;
  WITH w AS (
    INSERT INTO thought_entities (thought_id, entity_id, confidence, extraction_key, canonical_agent_id)
    SELECT p_thought_id, en.id, i.confidence, p_extraction_key, p_agent_id
      FROM _rte_in i
      JOIN ob1_entities en ON en.entity_type = i.ntype AND en.normalized_name = i.nname
    ON CONFLICT (thought_id, entity_id) DO UPDATE
      SET confidence = EXCLUDED.confidence, extraction_key = EXCLUDED.extraction_key,
          canonical_agent_id = EXCLUDED.canonical_agent_id, extracted_at = now()
      WHERE thought_entities.extraction_key NOT LIKE 'source:%'
    RETURNING entity_id)
  INSERT INTO _rte_new SELECT entity_id FROM w;
  SELECT count(*) INTO v_mentions FROM _rte_new;
  -- A mention a structured pass did write is a sighting.
  IF v_structured THEN
    UPDATE ob1_entities SET last_seen_at = now() WHERE id IN (SELECT id FROM _rte_new);
  END IF;

  WITH rel AS (
    SELECT r.relation, r.confidence, f.id AS from_id, t.id AS to_id,
           (f.id IS NOT NULL AND t.id IS NOT NULL AND f.id <> t.id) AS resolvable,
           ((SELECT count(*) FROM _rte_in i WHERE i.nname = r.nfrom) > 1
             OR (SELECT count(*) FROM _rte_in i WHERE i.nname = r.nto) > 1) AS ambiguous
      FROM (
        SELECT lower(btrim(x->>'relation')) AS relation,
               LEAST(GREATEST(COALESCE((x->>'confidence')::numeric, 0.5), 0), 1)::numeric(3,2) AS confidence,
               normalize_entity_name(x->>'from') AS nfrom,
               normalize_entity_name(x->>'to')   AS nto
          FROM jsonb_array_elements(COALESCE(p_relations, '[]'::jsonb)) x
         WHERE jsonb_typeof(x) = 'object'
      ) r
      LEFT JOIN LATERAL (
        SELECT en.id FROM _rte_in i JOIN ob1_entities en ON en.entity_type = i.ntype AND en.normalized_name = i.nname
         WHERE i.nname = r.nfrom
         ORDER BY i.confidence DESC, array_position(ARRAY['person','organization','project','tool','topic','place'], i.ntype) LIMIT 1) f ON true
      LEFT JOIN LATERAL (
        SELECT en.id FROM _rte_in i JOIN ob1_entities en ON en.entity_type = i.ntype AND en.normalized_name = i.nname
         WHERE i.nname = r.nto
         ORDER BY i.confidence DESC, array_position(ARRAY['person','organization','project','tool','topic','place'], i.ntype) LIMIT 1) t ON true
     WHERE r.relation IN ('works_on', 'uses', 'member_of', 'located_in', 'depends_on', 'related_to', 'co_occurs_with')
  ),
  ins AS (
    INSERT INTO ob1_entity_edges (thought_id, from_entity_id, to_entity_id, relation, confidence, extraction_key, canonical_agent_id)
    SELECT DISTINCT ON (fid, tid, relation) p_thought_id, fid, tid, relation, confidence, p_extraction_key, p_agent_id
      FROM (
        SELECT relation, confidence,
               CASE WHEN relation IN ('related_to', 'co_occurs_with') THEN LEAST(from_id, to_id) ELSE from_id END AS fid,
               CASE WHEN relation IN ('related_to', 'co_occurs_with') THEN GREATEST(from_id, to_id) ELSE to_id END AS tid
          FROM rel WHERE resolvable
      ) o
     ORDER BY fid, tid, relation, confidence DESC
    ON CONFLICT (thought_id, from_entity_id, to_entity_id, relation) DO UPDATE
      SET confidence = EXCLUDED.confidence, extraction_key = EXCLUDED.extraction_key,
          canonical_agent_id = EXCLUDED.canonical_agent_id, extracted_at = now()
      WHERE ob1_entity_edges.extraction_key NOT LIKE 'source:%'
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins),
         (SELECT count(*) FROM rel WHERE NOT resolvable),
         (SELECT count(*) FROM rel WHERE resolvable AND ambiguous)
    INTO v_edges, v_dropped, v_ambiguous;

  PERFORM 1 FROM ob1_entities en WHERE en.id IN (SELECT id FROM _rte_touched) FOR UPDATE;
  WITH gone AS (
    DELETE FROM ob1_entities en
     WHERE en.id IN (SELECT id FROM _rte_touched)
       AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = en.id)
       AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = en.id OR g.to_entity_id = en.id)
       -- 139: an entity with an open priority statement is no orphan.
       AND NOT ob1_entity_has_open_priority(en.id)
    RETURNING 1
  )
  SELECT count(*) INTO v_pruned FROM gone;

  -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
  -- (the 014 convention); preflight's `lineage` reads it. 061: the pass's
  -- lineage row commits with its rows (SMD-1731) and carries the INPUT'S
  -- FINGERPRINT the stale check above compared and 016 never stored (the
  -- ADR's half a key, closed). A structured pass that wrote and removed
  -- nothing (the same set twice) leaves its row where it was, as it leaves
  -- last_seen_at (053's fourth review pass) — unless its RECIPE moved,
  -- which SMD-1732's rebuild reads (cold read, first review pass); an
  -- extraction always writes and always records. Then the thought's
  -- lineage rows are aligned to what STANDS, not to this pass's key: a row
  -- under a key with no mention and no edge left goes — the extracted class
  -- this extraction replaced above, this pass's own on an empty set (the
  -- take at 053 pruning an old holder, an extraction the gate refused
  -- whole: no artifact, no row), and what a pass racing this one under
  -- another key left standing: its DELETE above does not see rows the
  -- other committed after its snapshot, so they stand (016's race), and a
  -- delete by KEY took their lineage row with them — a start refused for
  -- a race the schema allows (cold read, third review pass).
  SELECT count(*) INTO v_touched FROM _rte_touched;
  v_recipe := COALESCE(p_recipe, jsonb_build_object('deterministic', v_structured, 'key', p_extraction_key, 'declared', false));
  SELECT d.recipe INTO v_recorded FROM derivations d
   WHERE d.artifact_kind = 'entities' AND d.artifact_id = p_thought_id AND d.produced_by = p_extraction_key;
  v_standing := EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = p_thought_id AND m.extraction_key = p_extraction_key)
             OR EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = p_thought_id AND g.extraction_key = p_extraction_key);
  IF v_standing AND (NOT v_structured OR v_mentions > 0 OR v_edges > 0 OR v_touched > 0 OR v_recorded IS DISTINCT FROM v_recipe) THEN
    PERFORM ob1_record_derivation('entities', p_thought_id, ARRAY[p_thought_id],
                                  ARRAY[COALESCE(p_content_fingerprint, v_current_fp)], p_extraction_key,
                                  v_recipe, p_agent_id);
  END IF;
  DELETE FROM derivations d
   WHERE d.artifact_kind = 'entities' AND d.artifact_id = p_thought_id
     AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = p_thought_id AND m.extraction_key = d.produced_by)
     AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = p_thought_id AND g.extraction_key = d.produced_by);

  RETURN jsonb_build_object(
    'ok', true, 'stale', false,
    'entities', v_entities, 'new_entities', v_new, 'mentions', v_mentions,
    'edges', v_edges, 'dropped_relations', v_dropped, 'ambiguous_relations', v_ambiguous,
    'pruned_entities', v_pruned, 'refused_entities', v_refused, 'retyped_entities', v_retyped);
END;
$$;

COMMENT ON FUNCTION record_thought_entities(uuid, text, jsonb, jsonb, text, uuid, jsonb) IS
  'Writes one thought''s entities and relations atomically (016), with 053''s resolution rule and 056''s name gate. An extraction''s entities are written under entity_type_gate()''s type: a number or a type-vocabulary word is refused (not written, and a relation naming it dropped and counted), an identifier-shaped person or place retyped to project or tool; a structured pass is not gated. An extraction_key `source:<system>` is a structured pass (the source''s own project, labels, members — no model call) that keeps its own rows as a set — the same set twice writes nothing, and moves no last_seen_at; an `extract:*` pass replaces only extracted rows; and where both name one (thought, entity) or (thought, from, to, relation) the structured row stands — an extracted insert onto it does nothing, a structured insert onto an extracted row takes it over. Entities upserted by (type, normalised name); a relation naming an unlisted entity is dropped and counted; entities left unreferenced are pruned. p_content_fingerprint NULL skips the stale check. Since 061 the pass''s lineage row is written with its rows in `derivations` (artifact_kind entities, the thought''s id, produced_by the key): the input''s fingerprint as checked, p_recipe (the model, prompt version and hash, the windows — or the key alone, marked undeclared, when NULL), replaced under the pass''s own rule; no rows standing under the key, no lineage row. Returns {ok, stale, entities, new_entities, mentions, edges, dropped_relations, ambiguous_relations, pruned_entities, refused_entities, retyped_entities}. Migrations 016, 053, 056, 061 / SMD-947, SMD-1867, SMD-1935, SMD-1731. Since 139 an entity with an open priority statement is not pruned (ob1_entity_has_open_priority). Migration 139 / SMD-4241.';


-- ---------------------------------------------------------------------------
-- rebuild_derived — 067's, an entity with an open statement spared
-- ---------------------------------------------------------------------------
-- 067's body verbatim but for the lines marked 139: both of its prunes,
-- where the input thought is gone, skip an entity someone stated a priority
-- on.

CREATE OR REPLACE FUNCTION rebuild_derived(
  p_input        uuid,
  p_reason       text,
  p_input_gone   boolean DEFAULT false,
  p_fingerprints text[]  DEFAULT NULL,
  p_force        boolean DEFAULT false,
  -- 063, first review pass: the orphan sweep (db/rebuild.ts --orphans) acts
  -- on the rows whose artifact is gone and nothing else — a stale row on the
  -- same thought keeps its own reason for its own rebuild (cold read: the
  -- sweep marked and handed on every stale row under the sweep's name).
  p_orphans_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_t            record;             -- the input's row
  v_a            record;             -- the artifact's thought, per row
  v_a_found      boolean := false;
  v_p            record;             -- the proposal, per row
  v_row          record;             -- one walk row
  v_fp           text;               -- the input's current fingerprint
  v_cur          text;               -- the artifact's thought's current fingerprint
  v_cfg_model    text;
  v_cfg_dim      text;
  v_cfg_key      text;
  v_model        text;
  v_pool         text;
  v_snap_ok      boolean;            -- a usable snapshot row for the vector arm (no variable of the vector type: the body must run with pgvector off the search_path — db/test-search-path.ts)
  v_fps          text[];
  v_touched      uuid[];
  v_more         uuid[];
  v_graph_done   boolean := false;
  v_windows_done boolean := false;
  v_orphan       boolean;
  v_stale        boolean;
  v_fp_stale     boolean;
  v_stale_props  int := 0;
  v_walked       int := 0;
  v_depth        int := 0;
  v_rebuilt      int := 0;
  v_enqueued     int := 0;
  v_deleted      int := 0;
  v_marked       int := 0;
  v_unqueued     int := 0;
  v_kept         int := 0;
  v_current      int := 0;
  v_legacy       int := 0;
  v_casc_prop    int := 0;
  v_casc_rows    int := 0;
  v_n            int;
  v_irre         uuid[] := ARRAY[]::uuid[];
  v_pools        text[] := ARRAY[]::text[];
  v_claims       text[] := ARRAY[]::text[];  -- distinct (pool, thought) enqueued
  -- ob1:rebuild-acts-on-a-held-frontier — a CONTRACT SENTINEL (the 014
  -- convention), read by db/test-schema.ts: the walk is materialised whole
  -- (a plpgsql set-returning function's rows) before any row moves, and the
  -- supersession advisory lock is taken before the input's row — 036's and
  -- 060's order, kept here because this function moves proposal rows.
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'rebuild_derived: p_reason must say why (forget, edit, trust, sweep ...) - it is recorded on every row marked',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_input_gone AND p_orphans_only THEN
    RAISE EXCEPTION USING
      MESSAGE = 'rebuild_derived: p_input_gone and p_orphans_only exclude each other - a leaving input takes every artifact it keyed, a sweep takes orphans alone',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF COALESCE(current_setting('ob1.projecting_replay', true), '') = 'on' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REPLAYING', 'id', p_input);
  END IF;

  -- The locks, in delete_thought's order (036/060): the supersession lock
  -- first and unconditionally, then the input's row.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  SELECT t.id, t.content, t.content_fingerprint, t.embedding, t.embedding_model, t.metadata
    INTO v_t FROM thoughts t WHERE t.id = p_input FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_input);
  END IF;
  v_fp := COALESCE(v_t.content_fingerprint, content_fingerprint_of(v_t.content));

  -- The workers' current keys (the pools they drain); NULL where unset.
  -- An empty value is unset, as 016's trigger reads the extraction key (and
  -- 015's claims refuse an empty work_type) — first review pass, cold read.
  SELECT NULLIF(value, '') INTO v_cfg_model FROM ob1_config WHERE key = 'embedding_model';
  SELECT NULLIF(value, '') INTO v_cfg_dim   FROM ob1_config WHERE key = 'embedding_dim';
  SELECT NULLIF(value, '') INTO v_cfg_key   FROM ob1_config WHERE key = 'entity_extraction_key';

  -- The input leaving: the snapshot fingerprints, computed while the input's
  -- own lineage rows still stand — its OWN position on each (a proposal's row
  -- carries both thoughts'), the current one, the caller's from the log —
  -- minus any a standing thought other than the input holds.
  IF p_input_gone THEN
    SELECT array_agg(DISTINCT s.f) INTO v_fps
      FROM (SELECT v_fp AS f
            UNION ALL
            SELECT d.input_fingerprints[array_position(d.input_ids, p_input)]
              FROM derivations d WHERE d.input_ids @> ARRAY[p_input]
            UNION ALL
            SELECT unnest(COALESCE(p_fingerprints, ARRAY[]::text[]))) AS s
     WHERE s.f IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM thoughts o
                        WHERE o.id <> p_input
                          AND (o.content_fingerprint = s.f
                               OR (o.content_fingerprint IS NULL AND content_fingerprint_of(o.content) = s.f)));
  END IF;

  -- The walk, held whole (the set-returning function materialises its rows
  -- before the first is read), then acted on row by row.
  FOR v_row IN SELECT * FROM derivation_descendants(p_input) LOOP
    v_walked := v_walked + 1;
    v_depth  := GREATEST(v_depth, v_row.depth);

    -- Prose: a derived_from child. Listed; its text did not move, and its
    -- recipe is a synthesis no rebuild re-runs — the limit, named.
    IF v_row.prose THEN
      -- (Not under orphans_only: the sweep reproduces nothing, so it reports
      -- nothing as irreproducible — second review pass, cold read.)
      IF NOT p_orphans_only THEN v_irre := v_irre || v_row.artifact_id; END IF;
      CONTINUE;
    END IF;

    -- The artifact's thought (the proposal's is the pair; read below). The
    -- SELECT INTO runs on EVERY row: a record variable never assigned has no
    -- tuple shape, and the first expression that names one of its fields
    -- raises "record is not assigned yet" — the first rebuild in a session
    -- whose first row was a proposal failed so (run-it, first review pass).
    -- A no-row SELECT INTO leaves a NULL row WITH a shape.
    SELECT t.id, t.content, t.content_fingerprint, t.embedding, t.embedding_model, t.metadata
      INTO v_a FROM thoughts t WHERE t.id = v_row.artifact_id AND v_row.artifact_kind <> 'proposal';
    v_a_found := FOUND;

    -- ORPHAN rules first: a row whose artifact is gone names nothing to
    -- re-derive, and a vector row on a NULL embedding must never reach the
    -- refresh (OB002 would roll a forget back).
    v_orphan := CASE v_row.artifact_kind
      WHEN 'chunks'   THEN NOT EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = v_row.artifact_id)
      WHEN 'entities' THEN NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = v_row.artifact_id AND m.extraction_key = v_row.produced_by)
                       AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = v_row.artifact_id AND g.extraction_key = v_row.produced_by)
      WHEN 'vector'   THEN NOT v_a_found OR v_a.embedding IS NULL
      WHEN 'metadata' THEN NOT v_a_found OR NOT COALESCE(v_a.metadata ? 'type' OR v_a.metadata ? 'topics', false)
      WHEN 'proposal' THEN NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.id = v_row.artifact_id)
      ELSE false END;
    IF v_orphan THEN
      DELETE FROM derivations WHERE id = v_row.derivation_id;
      v_deleted := v_deleted + 1;
      CONTINUE;
    END IF;
    IF p_orphans_only THEN
      v_current := v_current + 1;
      CONTINUE;
    END IF;
    IF v_row.recipe->>'legacy' = 'true' THEN v_legacy := v_legacy + 1; END IF;

    -- THE INPUT LEAVING, for the artifacts it keys: they go with it.
    IF p_input_gone AND v_row.artifact_id = p_input THEN
      CASE v_row.artifact_kind
        WHEN 'chunks' THEN
          IF NOT v_windows_done THEN
            DELETE FROM thought_chunks WHERE thought_id = p_input;
            v_windows_done := true;
          END IF;
          DELETE FROM derivations WHERE id = v_row.derivation_id;
          v_deleted := v_deleted + 1;
        WHEN 'entities' THEN
          IF NOT v_graph_done THEN
            -- The worker's lock order (016, 053): the entities first, then
            -- the mention and edge rows, then the prune over what was touched.
            SELECT array_agg(DISTINCT e) INTO v_touched
              FROM (SELECT m.entity_id AS e FROM thought_entities m WHERE m.thought_id = p_input
                    UNION ALL SELECT g.from_entity_id FROM ob1_entity_edges g WHERE g.thought_id = p_input
                    UNION ALL SELECT g.to_entity_id   FROM ob1_entity_edges g WHERE g.thought_id = p_input) AS s;
            IF v_touched IS NOT NULL THEN
              PERFORM e.id FROM ob1_entities e WHERE e.id = ANY(v_touched) ORDER BY e.id FOR UPDATE;
            END IF;
            -- The deletes RETURN what they touched: a worker that committed
            -- while this waited on the entity lock wrote rows the snapshot
            -- above did not see, and its entities are pruned too (run-it,
            -- the build: test-live [31]'s race left the worker's new entity
            -- standing).
            WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_input RETURNING from_entity_id, to_entity_id)
            SELECT array_agg(x) INTO v_more FROM (SELECT d.from_entity_id FROM d UNION SELECT d.to_entity_id FROM d) AS s(x);
            v_touched := COALESCE(v_touched, ARRAY[]::uuid[]) || COALESCE(v_more, ARRAY[]::uuid[]);
            WITH d AS (DELETE FROM thought_entities WHERE thought_id = p_input RETURNING entity_id)
            SELECT array_agg(d.entity_id) INTO v_more FROM d;
            v_touched := v_touched || COALESCE(v_more, ARRAY[]::uuid[]);
            IF cardinality(v_touched) > 0 THEN
              DELETE FROM ob1_entities e
               WHERE e.id = ANY(v_touched)
                 AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = e.id)
                 AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id)
                 -- 139: an entity with an open priority statement is no orphan.
                 AND NOT ob1_entity_has_open_priority(e.id);
            END IF;
            v_graph_done := true;
          END IF;
          DELETE FROM derivations WHERE id = v_row.derivation_id;
          v_deleted := v_deleted + 1;
        ELSE
          -- The vector's and the tags' rows: 061's drop trigger's, at the
          -- caller's row delete.
          v_casc_rows := v_casc_rows + 1;
      END CASE;
      CONTINUE;
    END IF;
    IF p_input_gone AND v_row.artifact_kind = 'proposal' THEN
      -- 029's cascade takes the proposal at the caller's row delete; its
      -- lineage row goes by the proposal's own drop trigger.
      v_casc_prop := v_casc_prop + 1;
      CONTINUE;
    END IF;

    -- THE INPUT STANDING (or a row fed by the leaving input that another
    -- thought keys): stale when any input's fingerprint moved or the input
    -- has no row; --force says every row is.
    v_fp_stale := (p_input_gone AND p_input = ANY(v_row.input_ids))
               OR EXISTS (SELECT 1 FROM unnest(v_row.input_ids, v_row.input_fingerprints) AS u(iid, ifp)
                            LEFT JOIN thoughts t ON t.id = u.iid
                           WHERE t.id IS NULL
                              OR u.ifp IS DISTINCT FROM COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)));
    v_stale := p_force OR v_fp_stale;
    IF NOT v_stale THEN
      v_current := v_current + 1;
      CONTINUE;
    END IF;

    CASE v_row.artifact_kind
      WHEN 'vector' THEN
        v_cur   := COALESCE(v_a.content_fingerprint, content_fingerprint_of(v_a.content));
        v_model := COALESCE(v_row.recipe->>'model', v_a.embedding_model, v_cfg_model);
        -- (The row's OWN model — its recipe's or its label — against the
        -- configured one, not v_model's fallback to the config: an unlabelled
        -- vector would otherwise be re-recorded under a model nothing named,
        -- where the pool's write moves the label and records — fourth
        -- review pass.)
        IF NOT v_fp_stale AND (v_cfg_model IS NULL OR COALESCE(v_row.recipe->>'model', v_a.embedding_model) IS NOT DISTINCT FROM v_cfg_model) THEN
          -- --force on a vector whose text did not move, AT THE CONFIGURED
          -- MODEL: the vector IS the current text's (a deterministic model,
          -- the fingerprint the row carries), so what force renews is the
          -- RECORD — the row is written again under the recipe as it stands,
          -- which drops `legacy` and clears the mark. Sending it to the pool
          -- would mark a row no worker could clear: the re-embedding
          -- reproduces the vector, and the trigger returns before recording
          -- when neither the vector nor its label moved (second review pass,
          -- cold read and run-it). A vector at ANOTHER model — a corpus
          -- mid-switch — takes the pool path below: the re-embed moves the
          -- label, the trigger records, the mark clears (third review pass,
          -- cold read: the re-record left such rows at the old model and
          -- called them rebuilt). The row's agent stands when the session
          -- sets no actor: the vector did not change, its writer's word does
          -- (third pass, run-it).
          PERFORM ob1_record_derivation('vector', v_a.id, ARRAY[v_a.id], ARRAY[v_cur], v_row.produced_by,
                                        jsonb_build_object('deterministic', true, 'dims', array_length(v_a.embedding::real[], 1))
                                          || jsonb_strip_nulls(jsonb_build_object('model', v_model)),
                                        COALESCE(ob1_actor_agent_id(), (SELECT d.canonical_agent_id FROM derivations d WHERE d.id = v_row.derivation_id)));
          v_rebuilt := v_rebuilt + 1;
        ELSE
        -- A usable snapshot row: the current text at the model, holding a
        -- vector OTHER than the one the row carries. An identical vector is
        -- not the new text's: 060's snapshot trigger records the standing
        -- vector under the row's key when a raw writer moves the text and
        -- leaves the vector, so that row is the raw writer's copy (a model
        -- does not embed two texts to the same vector), and restoring it
        -- would launder the staleness the census exists to see (061's first
        -- review pass named the same trap on the vector trigger) — run-it,
        -- the build: the smoke's raw move "rebuilt" its own stale vector.
        -- …and only for a row stale BY FINGERPRINT: under --force alone the
        -- row's text did not move, so a differing snapshot vector at its key
        -- is a twin's raw move overwriting it (060's trigger upserts under
        -- the key), and restoring it would launder the other way (cold read,
        -- first review pass) — force sends the row to the pool instead.
        v_snap_ok := v_fp_stale AND v_model IS NOT NULL AND EXISTS (
          SELECT 1 FROM ob1_embedding_snapshot s
           WHERE s.content_fingerprint = v_cur AND s.embedding_model = v_model
             AND s.embedding::real[] IS DISTINCT FROM v_a.embedding::real[]);
        IF v_snap_ok THEN
          -- The one re-derivation this database owns: the text's vector at
          -- the model already stands in the snapshot. A projection refresh
          -- (no event, no updated_at); the vector moved, so the vector
          -- trigger re-records the row at the current fingerprint.
          PERFORM ob1_refresh_thought_vector(v_a.id,
                                             (SELECT s.embedding FROM ob1_embedding_snapshot s WHERE s.content_fingerprint = v_cur AND s.embedding_model = v_model),
                                             v_model);
          v_rebuilt := v_rebuilt + 1;
        ELSE
          v_pool := CASE WHEN v_cfg_model IS NOT NULL AND v_cfg_dim IS NOT NULL THEN 'reembed:' || v_cfg_model || '@' || v_cfg_dim END;
          UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
          v_marked := v_marked + 1;
          IF v_pool IS NULL THEN
            v_unqueued := v_unqueued + 1;
          ELSIF NOT ((v_pool || '|' || v_a.id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_a.id);
            v_claims := v_claims || (v_pool || '|' || v_a.id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        END IF;
        END IF;
      WHEN 'chunks' THEN
        -- The windows: split and embedded by db/reembed.ts under the
        -- configured model, through the 11-argument update_thought, which
        -- re-records them.
        v_pool := CASE WHEN v_cfg_model IS NOT NULL AND v_cfg_dim IS NOT NULL THEN 'reembed:' || v_cfg_model || '@' || v_cfg_dim END;
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked := v_marked + 1;
        IF v_pool IS NULL THEN
          v_unqueued := v_unqueued + 1;
        ELSIF NOT ((v_pool || '|' || v_a.id::text) = ANY(v_claims)) THEN
          PERFORM requeue_thought_work(v_pool, v_a.id);
          v_claims := v_claims || (v_pool || '|' || v_a.id::text);
          v_enqueued := v_enqueued + 1;
          IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
        END IF;
      WHEN 'entities' THEN
        IF v_row.produced_by LIKE 'source:%' THEN
          -- A structured pass reads the source's own record, not the text.
          v_kept := v_kept + 1;
        ELSE
          v_pool := COALESCE(v_cfg_key, v_row.produced_by);
          UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
          v_marked := v_marked + 1;
          IF NOT ((v_pool || '|' || v_a.id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_a.id);
            v_claims := v_claims || (v_pool || '|' || v_a.id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        END IF;
      WHEN 'proposal' THEN
        SELECT p.id, p.status, p.newer_id, p.judge_key, p.review_note INTO v_p
          FROM supersession_proposals p WHERE p.id = v_row.artifact_id FOR UPDATE;
        -- ob1:pass-settled-is-the-pass-to-reopen — a CONTRACT SENTINEL (the
        -- 014 convention), read by db/test-schema.ts and by preflight: a
        -- rejected row whose review_note begins 'settled by the pass:' was
        -- decided by db/consolidate.ts about texts that have now moved, so a
        -- text move makes it stale again as it makes a pending one; a
        -- person's decision stands (067, SMD-2297). The literal is
        -- server-portable/consolidate.ts's PASS_SETTLED_PREFIX; test-schema
        -- holds the two to one string.
        IF v_p.status IN ('pending', 'stale')
           OR (v_p.status = 'rejected' AND v_p.review_note LIKE 'settled by the pass:%') THEN
          -- The proposal's own status is its mark: the lineage row is left
          -- unmarked, since nothing but the pass's replacement writes it
          -- again — a reviewer's decision on the stale row would otherwise
          -- leave a mark standing for ever and the census counting it (cold
          -- read, 063's first review pass). The judge's key is the pool by
          -- construction (029: db/consolidate.ts writes its job as the key);
          -- no config records the current one, so the claim written here
          -- sits under the ROW's key — and since 067 the pass re-pools every
          -- stale row's newer thought under its OWN key at the start of a
          -- run, so a judge-model change no longer strands the pair (a
          -- stray pending row under the old key is what --status shows).
          -- A row already stale is requeued again and not counted again.
          -- From pending or from the pass's own rejection: reviewed_at goes
          -- back to NULL (063's unreviewed CHECK reads a stale row as
          -- unreviewed) and the pass's note with it, as 063's replacement
          -- clears a note — a stale row carries none.
          IF v_p.status IN ('pending', 'rejected') THEN
            UPDATE supersession_proposals
               SET status = 'stale', reviewed_at = NULL, review_note = NULL
             WHERE id = v_p.id AND status IN ('pending', 'rejected');
            v_stale_props := v_stale_props + 1;
          END IF;
          v_pool := v_p.judge_key;
          IF NOT ((v_pool || '|' || v_p.newer_id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_p.newer_id);
            v_claims := v_claims || (v_pool || '|' || v_p.newer_id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        ELSE
          -- A person's decision stands — an accepted row, or a rejection
          -- whose note is not the pass's; the queue says edited-since.
          v_kept := v_kept + 1;
        END IF;
      WHEN 'section' THEN
        -- 064's generated page section (SMD-1812): no pool regenerates it —
        -- its generator calls write_page_section, whose lineage upsert
        -- clears the mark — so it is marked for the operator, as the tags
        -- are. Before this file the row fell to the kept arm below, unmarked
        -- and uncounted as waiting (067's post-merge review pass, run-it).
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked   := v_marked + 1;
        v_unqueued := v_unqueued + 1;
      WHEN 'metadata' THEN
        -- No pool re-tags a thought: marked for the operator, nothing more.
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked   := v_marked + 1;
        v_unqueued := v_unqueued + 1;
      ELSE
        v_kept := v_kept + 1;
    END CASE;
  END LOOP;

  -- The input leaving, whatever the walk held: mentions written by a producer
  -- from before 061 (or by a raw writer) have no lineage row, so the windows
  -- and the graph go here when no row in the walk took them (run-it, first
  -- review pass: a thought whose entities rows were gone kept its mentions
  -- for the cascade and its entities for nobody). A worker committing an
  -- extraction after this ran leaves an entity the caller's row delete does
  -- not prune — delete_thought's own residue; prune_orphan_entities() is its
  -- broom.
  IF p_input_gone AND NOT v_windows_done THEN
    DELETE FROM thought_chunks WHERE thought_id = p_input;
    v_windows_done := true;
  END IF;
  IF p_input_gone AND NOT v_graph_done THEN
    SELECT array_agg(DISTINCT e) INTO v_touched
      FROM (SELECT m.entity_id AS e FROM thought_entities m WHERE m.thought_id = p_input
            UNION ALL SELECT g.from_entity_id FROM ob1_entity_edges g WHERE g.thought_id = p_input
            UNION ALL SELECT g.to_entity_id   FROM ob1_entity_edges g WHERE g.thought_id = p_input) AS s;
    IF v_touched IS NOT NULL THEN
      PERFORM e.id FROM ob1_entities e WHERE e.id = ANY(v_touched) ORDER BY e.id FOR UPDATE;
    END IF;
    WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_input RETURNING from_entity_id, to_entity_id)
    SELECT array_agg(x) INTO v_more FROM (SELECT d.from_entity_id FROM d UNION SELECT d.to_entity_id FROM d) AS s(x);
    v_touched := COALESCE(v_touched, ARRAY[]::uuid[]) || COALESCE(v_more, ARRAY[]::uuid[]);
    WITH d AS (DELETE FROM thought_entities WHERE thought_id = p_input RETURNING entity_id)
    SELECT array_agg(d.entity_id) INTO v_more FROM d;
    v_touched := v_touched || COALESCE(v_more, ARRAY[]::uuid[]);
    IF cardinality(v_touched) > 0 THEN
      DELETE FROM ob1_entities e
       WHERE e.id = ANY(v_touched)
         AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id)
         -- 139: an entity with an open priority statement is no orphan.
         AND NOT ob1_entity_has_open_priority(e.id);
    END IF;
    v_graph_done := true;
  END IF;

  -- The input leaving: the snapshot rows at its fingerprints (060 names this
  -- file as their removal path).
  IF p_input_gone AND v_fps IS NOT NULL THEN
    DELETE FROM ob1_embedding_snapshot WHERE content_fingerprint = ANY(v_fps);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'input', p_input, 'reason', p_reason, 'input_gone', p_input_gone, 'force', p_force, 'orphans_only', p_orphans_only,
    -- at_cap: the walk returned its cap of rows; whatever stood beyond, if
    -- anything, is the next call's (the walk is deterministic and shrinks as
    -- rows are deleted or re-recorded) — first review pass: "truncated" read
    -- as a cut on exactly the cap.
    'walked', v_walked, 'depth', v_depth, 'at_cap', v_walked >= 2000,
    'rebuilt', v_rebuilt, 'enqueued', v_enqueued, 'deleted', v_deleted,
    'marked', v_marked, 'unqueued', v_unqueued, 'stale_proposals', v_stale_props, 'kept', v_kept, 'current', v_current, 'legacy', v_legacy,
    'irreproducible', to_jsonb(v_irre),
    'cascading', jsonb_build_object('proposals', v_casc_prop, 'lineage_rows', v_casc_rows),
    'pools', to_jsonb(v_pools));
END;
$$;

COMMENT ON FUNCTION rebuild_derived(uuid, text, boolean, text[], boolean, boolean) IS
  'The one primitive over the lineage table (SMD-1732, Phase 1c of SMD-1729): walks `derivations` forward from p_input (derivation_descendants) and acts on every descendant. A row whose artifact is gone is deleted. With the input standing, a row whose inputs'' fingerprints moved (or p_force) is: re-derived when the database can — a vector whose current text has a snapshot row at the model, by ob1_refresh_thought_vector (rebuilt); otherwise handed to the worker that owns the recipe through requeue_thought_work under the worker''s current key — the reembed pool for a vector or the windows, the extraction key for an extract: pass, the judge''s key — with stale_since/stale_reason set on the lineage row (marked; the tags have no pool: unqueued; the first request standing is kept) — and, for a pending proposal or one the consolidation pass itself rejected (a review_note beginning ''settled by the pass:'', 067), its status set stale with reviewed_at and the note cleared (the status is the mark; stale_proposals; the next pass replaces the row when it finds the conflict again and settles it when it does not); under p_force a vector whose text did not move, at the configured model, is re-recorded, not re-embedded (one at another model goes to the pool); a source: pass and a person''s decision on a proposal are kept; a generated page section (064) is marked with no pool, as the tags are; an unmoved row is current. With p_input_gone (SMD-1723''s forget, called BEFORE the row delete in its transaction): the windows, the input''s mentions and edges (entities locked first, orphans pruned) and their lineage rows are deleted, the snapshot rows at the input''s own fingerprints and p_fingerprints removed where no standing thought holds them, the proposals and the vector''s and tags'' rows counted for the cascade. derived_from children are listed as irreproducible. Refuses an empty reason; answers a replay with REPLAYING and a missing input with NOT_FOUND. Takes the supersession advisory lock, then the input''s row. With p_orphans_only (the sweep''s mode) only the orphan rule runs. Returns {ok, input, reason, input_gone, force, orphans_only, walked, depth, at_cap, rebuilt, enqueued, deleted, marked, unqueued, stale_proposals, kept, current, legacy, irreproducible, cascading, pools}. Migrations 063, 067 / SMD-1732, SMD-2297. Since 139 an entity with an open priority statement is not pruned (ob1_entity_has_open_priority). Migration 139 / SMD-4241.';

-- ---------------------------------------------------------------------------
-- ob1_priority_merge_entity — a merge's priority statements, moved
-- ---------------------------------------------------------------------------
-- 136's restatement loop, out of merge_entities so the gate's merge shares
-- it, with the due references naming the loser restated first. The caller
-- holds both entity rows (merge_entities locks them, the gate locks the
-- table) and deletes the loser after. moved: the loser's statements
-- restated on the survivor and still standing; refs_moved: the statements
-- whose due reference now names the survivor (or was dropped, naming its
-- own item), still standing.
CREATE OR REPLACE FUNCTION ob1_priority_merge_entity(p_survivor uuid, p_loser uuid)
RETURNS TABLE (moved int, refs_moved int)
LANGUAGE plpgsql
AS $$
DECLARE
  v_restated uuid[] := '{}';
  v_repointed uuid[] := '{}';
  v_kinds text[];
  v_keys  text[];
  v_now timestamptz;
  v_id uuid;
  v_maker uuid;
  v_loser priority_assertions;
  v_have  priority_assertions;
  v_open  priority_assertions;
  v_ref   priority_assertions;
  i int;
BEGIN
  moved := 0;
  refs_moved := 0;
  -- A role that could not restate (INSERT, and the registry for a maker's
  -- id: 136's review pass 2), or a transaction above READ COMMITTED, as the
  -- writers refuse one (136's review pass 3), moves nothing: the delete's
  -- trigger or the sweep closes the loser's as deleted, and a reference to
  -- the loser stays.
  IF NOT (current_setting('transaction_isolation') IN ('read committed', 'read uncommitted')
          AND ob1_priority_can_close() AND has_table_privilege('priority_assertions', 'INSERT')
          AND has_table_privilege('ob1_agents', 'SELECT')) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- The items to lock: both entities, and every item holding an open
  -- statement whose due reference names the loser. Each lock taken in the
  -- order of its pool's key, the order the rebuild takes them (133), so two
  -- holders of several never wait on each other. A statement naming the
  -- loser written after this read, on an item not in it, is left naming the
  -- loser (NOT CHANGED, in the header).
  SELECT array_agg(s.kind ORDER BY ob1_priority_lock_key(s.kind, s.key), s.kind, s.key),
         array_agg(s.key  ORDER BY ob1_priority_lock_key(s.kind, s.key), s.kind, s.key)
    INTO v_kinds, v_keys
    FROM (SELECT 'entity' AS kind, p_survivor::text AS key
          UNION SELECT 'entity', p_loser::text
          UNION SELECT a.item_kind, a.item_key FROM priority_assertions a
                 WHERE a.closed_at IS NULL AND a.due_ref_kind = 'entity' AND a.due_ref_key = p_loser::text) s;
  FOR i IN 1 .. cardinality(v_kinds) LOOP
    PERFORM ob1_priority_lock(v_kinds[i], v_keys[i]);
  END LOOP;
  v_now := clock_timestamp();

  -- The due references naming the loser, on the items locked, in the order
  -- written (139). None is on the loser: 116's CHECK refuses a reference to
  -- the item itself, as it would the survivor's restated, which is dropped.
  FOR v_ref IN SELECT x.* FROM priority_assertions x
                WHERE x.closed_at IS NULL AND x.due_ref_kind = 'entity' AND x.due_ref_key = p_loser::text
                  AND (x.item_kind, x.item_key) IN (SELECT * FROM unnest(v_kinds, v_keys))
                ORDER BY x.seq LOOP
    v_id := gen_random_uuid();
    UPDATE priority_assertions SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
     WHERE id = v_ref.id AND closed_at IS NULL;
    INSERT INTO priority_assertions (id, item_kind, item_key, level, due_at, not_before, due_ref_kind, due_ref_key, reason, inferred,
                                     maker_name, maker_agent_id, maker_kind, maker_trust, maker_scope, maker_source, tier, asserted_at)
    VALUES (v_id, v_ref.item_kind, v_ref.item_key, v_ref.level, v_ref.due_at, v_ref.not_before,
            -- An item's reference may not name itself: the survivor's own is dropped.
            CASE WHEN v_ref.item_kind = 'entity' AND v_ref.item_key = p_survivor::text THEN NULL ELSE 'entity' END,
            CASE WHEN v_ref.item_kind = 'entity' AND v_ref.item_key = p_survivor::text THEN NULL ELSE p_survivor::text END,
            v_ref.reason, v_ref.inferred, v_ref.maker_name, v_ref.maker_agent_id, v_ref.maker_kind, v_ref.maker_trust,
            v_ref.maker_scope, v_ref.maker_source, v_ref.tier, v_ref.asserted_at);
    v_repointed := v_repointed || v_id;
  END LOOP;

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
    -- closed_at (136's review pass 2).
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

  -- What still stands: a maker's by-name and by-id statements on the loser
  -- are restated in turn, the later replacing the earlier (136's review pass
  -- 5), and a restated loser's may replace a survivor's whose reference was
  -- just restated.
  moved := (SELECT count(*)::int FROM priority_assertions WHERE id = ANY(v_restated) AND closed_at IS NULL);
  refs_moved := (SELECT count(*)::int FROM priority_assertions WHERE id = ANY(v_repointed) AND closed_at IS NULL);
  FOR i IN 1 .. cardinality(v_kinds) LOOP
    PERFORM ob1_priority_project(v_kinds[i], v_keys[i]);
  END LOOP;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION ob1_priority_merge_entity(uuid, uuid) IS
  'A merge''s priority statements, moved (merge_entities and apply_entity_type_gate''s merge call it before deleting the loser): each open statement on another item whose due reference names the loser is restated with the reference naming the survivor (dropped where that would name the survivor itself, which 116''s CHECK refuses), and each open statement on the loser is restated on the survivor by its maker (136''s rule: the maker''s later word on the survivor stands). Every item touched is locked first, in its pool key''s order, and re-projected. Returns moved (the loser''s restated, standing) and refs_moved (references restated, standing); zeros for a role that could not restate or a transaction above READ COMMITTED. Migration 139 / SMD-4241.';

-- ---------------------------------------------------------------------------
-- merge_entities — 136's, its priority step the shared helper's
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
  v_moved int;
  v_refs int;
BEGIN
  -- Both rows locked first, in id order (136's review pass 4): a prune of the
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

  -- The loser's priority statements restated on the survivor (136), and the
  -- due references naming the loser restated to name it (139): a merge says
  -- the two were one.
  SELECT h.moved, h.refs_moved INTO v_moved, v_refs FROM ob1_priority_merge_entity(p_survivor, p_loser) h;

  DELETE FROM ob1_entities WHERE id = p_loser;

  RETURN jsonb_build_object('ok', true, 'survivor', p_survivor, 'merged', v_l.name, 'mentions_moved', v_mentions, 'edges_moved', v_edges,
                            'priorities_moved', v_moved, 'priority_refs_moved', v_refs);
END;
$$;

COMMENT ON FUNCTION merge_entities(uuid, uuid) IS
  'Merge one entity into another of the same type: mentions and edges move to the survivor (duplicates and self-joins dropped), the loser''s name and aliases become aliases, its normalised name joins merged_from so later extractions resolve to the survivor, and the loser is deleted. Since 136 the loser''s open priority statements are restated on the survivor by the same maker, matched as 116''s is_maker matches one (the loser''s closed as replaced by the restatement; where the maker''s latest word on the survivor is later, a statement replaces the loser''s and a clear clears it), counted as priorities_moved; a restatement is the survivor''s newest within its tier. Since 139 each open statement whose due reference names the loser is restated to name the survivor, counted as priority_refs_moved (ob1_priority_merge_entity does both). A role that could not restate, or a transaction above READ COMMITTED, moves none, and the loser''s close as deleted. Both rows are locked first, in id order. The one resolution step that is a human''s to take. Migration 016; priorities, migration 136 / SMD-3711; due references, migration 139 / SMD-4241.';


-- ---------------------------------------------------------------------------
-- apply_entity_type_gate — 056's, its merge moving priority statements
-- ---------------------------------------------------------------------------
-- 056's body verbatim but for the lines marked 139: a retyped entity merged
-- into the one of its new type has its statements moved by the helper
-- merge_entities calls.

CREATE OR REPLACE FUNCTION apply_entity_type_gate()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_refused  int := 0;
  v_mentions int := 0;
  v_edges    int := 0;
  v_moved    int := 0;
  v_merged   int := 0;
  v_prio     int := 0;
  v_refs     int := 0;
  v_m        int;
  v_r        int;
  v_target   uuid;
  r          record;
BEGIN
  -- A writer's INSERT waits for this, and this for a writer that has
  -- written. It does not reach a call already running 053's body when the
  -- file commits: that call writes by 053's rule, so run this again once the
  -- workers that were running have finished (it is idempotent).
  LOCK TABLE ob1_entities IN SHARE ROW EXCLUSIVE MODE;

  -- Each entity's verdict, once: NULL refused, a type retyped. Two kinds of
  -- entity are left as they stand: one a structured pass names — the
  -- source's, not the model's guess (a Linear label `2024`) — and one a human
  -- curated, a name merged into it with merge_entities(): retyped, the
  -- names merged into it would come back as entities of the old type, split
  -- from it (third review pass). Judged on the entity's name, its first-seen
  -- spelling, as the writer judges each answer's.
  CREATE TEMP TABLE IF NOT EXISTS _aetg (id uuid, to_type text) ON COMMIT DROP;
  DELETE FROM _aetg WHERE true;
  WITH v AS MATERIALIZED (
    SELECT e.id, e.entity_type, entity_type_gate(e.name, e.entity_type) AS to_type
      FROM ob1_entities e
     WHERE cardinality(e.merged_from) = 0
       AND NOT EXISTS (SELECT 1 FROM thought_entities s WHERE s.entity_id = e.id AND s.extraction_key LIKE 'source:%'))
  INSERT INTO _aetg (id, to_type)
  SELECT v.id, v.to_type FROM v WHERE v.to_type IS DISTINCT FROM v.entity_type;

  -- Refused: the edges on either end, the mentions, the row.
  WITH gone AS (
    DELETE FROM ob1_entity_edges g
     WHERE g.from_entity_id IN (SELECT id FROM _aetg WHERE to_type IS NULL)
        OR g.to_entity_id IN (SELECT id FROM _aetg WHERE to_type IS NULL)
    RETURNING 1)
  SELECT count(*) INTO v_edges FROM gone;
  WITH gone AS (
    DELETE FROM thought_entities m WHERE m.entity_id IN (SELECT id FROM _aetg WHERE to_type IS NULL)
    RETURNING 1)
  SELECT count(*) INTO v_mentions FROM gone;
  WITH gone AS (
    DELETE FROM ob1_entities e WHERE e.id IN (SELECT id FROM _aetg WHERE to_type IS NULL)
    RETURNING 1)
  SELECT count(*) INTO v_refused FROM gone;

  -- Retyped, oldest first: merged into the entity of the new type the writer
  -- would resolve its name to — the one a human merged the name into, else
  -- the one of that name — and moved when there is none. Two rows bound for
  -- one target meet here too: the first moves, the second merges into it.
  -- A retyped row has no merged_from (a curated one is left above), so none
  -- crosses into the new type. Two index probes, not one OR: 016's GIN index
  -- serves `@>` and the unique key serves the name, where `= ANY(...) OR`
  -- scanned every entity of the type once per retyped row (third review
  -- pass: ~2 ms a row at 80,000 entities).
  FOR r IN
    SELECT e.id, e.name, e.normalized_name, e.aliases, e.first_seen_at, e.last_seen_at, a.to_type
      FROM _aetg a JOIN ob1_entities e ON e.id = a.id
     WHERE a.to_type IS NOT NULL
     ORDER BY e.first_seen_at, e.id
  LOOP
    SELECT en.id INTO v_target FROM ob1_entities en
     WHERE en.entity_type = r.to_type AND en.merged_from @> ARRAY[r.normalized_name]
     ORDER BY en.first_seen_at, en.id
     LIMIT 1;
    IF v_target IS NULL THEN
      SELECT en.id INTO v_target FROM ob1_entities en
       WHERE en.entity_type = r.to_type AND en.normalized_name = r.normalized_name;
    END IF;
    IF v_target IS NULL THEN
      UPDATE ob1_entities SET entity_type = r.to_type WHERE id = r.id;
      v_moved := v_moved + 1;
      CONTINUE;
    END IF;

    -- merge_entities' steps (016), which refuses a merge across types: the
    -- mentions the target lacks move and the rest go with the row; edges are
    -- re-pointed, a symmetric relation re-ordered as the writer orders it,
    -- a duplicate or a self-edge dropped.
    UPDATE thought_entities m SET entity_id = v_target
     WHERE m.entity_id = r.id
       AND NOT EXISTS (SELECT 1 FROM thought_entities s WHERE s.thought_id = m.thought_id AND s.entity_id = v_target);
    DELETE FROM thought_entities WHERE entity_id = r.id;
    WITH moved AS (
      SELECT g.thought_id, g.relation, g.confidence, g.extraction_key, g.canonical_agent_id, g.extracted_at,
             CASE WHEN g.from_entity_id = r.id THEN v_target ELSE g.from_entity_id END AS f,
             CASE WHEN g.to_entity_id   = r.id THEN v_target ELSE g.to_entity_id   END AS t
        FROM ob1_entity_edges g
       WHERE g.from_entity_id = r.id OR g.to_entity_id = r.id
    ),
    ordered AS (
      SELECT thought_id, relation, confidence, extraction_key, canonical_agent_id, extracted_at,
             CASE WHEN relation IN ('related_to', 'co_occurs_with') THEN LEAST(f, t) ELSE f END AS f,
             CASE WHEN relation IN ('related_to', 'co_occurs_with') THEN GREATEST(f, t) ELSE t END AS t
        FROM moved WHERE f <> t
    )
    INSERT INTO ob1_entity_edges (thought_id, from_entity_id, to_entity_id, relation, confidence, extraction_key, canonical_agent_id, extracted_at)
    SELECT DISTINCT ON (thought_id, f, t, relation) thought_id, f, t, relation, confidence, extraction_key, canonical_agent_id, extracted_at
      FROM ordered ORDER BY thought_id, f, t, relation, confidence DESC
    ON CONFLICT (thought_id, from_entity_id, to_entity_id, relation) DO NOTHING;
    DELETE FROM ob1_entity_edges WHERE from_entity_id = r.id OR to_entity_id = r.id;

    UPDATE ob1_entities en
       SET aliases       = ARRAY(SELECT DISTINCT a FROM unnest(en.aliases || r.aliases || ARRAY[r.name]) a WHERE a <> en.name ORDER BY a),
           first_seen_at = LEAST(en.first_seen_at, r.first_seen_at),
           last_seen_at  = GREATEST(en.last_seen_at, r.last_seen_at)
     WHERE en.id = v_target;
    -- 139: its priority statements restated on the target, and the due
    -- references naming it restated to name the target, as merge_entities
    -- does (one helper). Without this the delete closed them as deleted.
    SELECT h.moved, h.refs_moved INTO v_m, v_r FROM ob1_priority_merge_entity(v_target, r.id) h;
    v_prio := v_prio + v_m;
    v_refs := v_refs + v_r;
    DELETE FROM ob1_entities WHERE id = r.id;
    v_merged := v_merged + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'refused_entities', v_refused, 'dropped_mentions', v_mentions, 'dropped_edges', v_edges,
                            'moved_entities', v_moved, 'merged_entities', v_merged,
                            'priorities_moved', v_prio, 'priority_refs_moved', v_refs);
END;
$$;

COMMENT ON FUNCTION apply_entity_type_gate() IS
  'Applies entity_type_gate() to the entities already written (056), each judged on its name; an entity a structured pass names or a human curated (a non-empty merged_from) is left as it stands. A refused entity''s edges, mentions and row are deleted; a retyped one merges into the entity of its new type the writer would resolve its name to (the one a human merged the name into, else the one of that name) by merge_entities'' steps — the mentions it lacks moved, edges re-pointed, aliases and seen-at folded — or moves when there is none. Idempotent. Returns {ok, refused_entities, dropped_mentions, dropped_edges, moved_entities, merged_entities, priorities_moved, priority_refs_moved}; the first run''s is kept in ob1_config under entity_name_gate_056. SMD-1935. Since 139 a merge moves the retyped entity''s priority statements, and the due references naming it, as merge_entities does (ob1_priority_merge_entity), counted as priorities_moved and priority_refs_moved; a refused entity''s close as deleted (136). Migration 139 / SMD-4241.';
