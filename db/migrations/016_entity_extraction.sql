-- ============================================================================
-- 016 — entities, mentions and edges: a structured layer over the thoughts
--
-- Why
--   Every thought is opaque text plus whatever `metadata` the extraction model
--   attached at capture (`topics`, `people`, `type`). Nothing records that two
--   thoughts mention the same person, that a system depends on another, or
--   that a decision superseded an earlier one, so "everything touching X, and
--   what X connects to" cannot be asked — only "text semantically near X".
--   This is the prerequisite for SMD-948 (GraphRAG) and useful before it: a
--   typed entity is a filter dimension free-text metadata cannot offer.
--
-- Ported from schemas/entity-extraction, and it is a rewrite rather than a
-- port, for the reasons SMD-947 gives (36 Supabase couplings, an Edge Function
-- worker). What changed, and why:
--
--   1. EVIDENCE IS THE EDGE. Upstream keeps `edges` with a `support_count` the
--      worker increments, and `thought_entities` as a separate evidence table
--      for mentions only — so an edge does not know which thoughts justified
--      it, deleting a thought cannot take its edges with it, and re-extracting
--      a thought increments support again. Here every edge row carries the
--      thought that evidenced it: the same relation asserted by three thoughts
--      is three rows, and "support" is a count. Deleting a thought removes its
--      edges by foreign key, re-extracting it replaces exactly its rows, and no
--      counter can drift from the rows it summarises.
--
--   2. NO QUEUE TABLE. Upstream adds `entity_extraction_queue` with its own
--      status machine and a worker that claims by read-then-update. Migration
--      015 already has a lease table built for exactly this, so the trigger
--      below enqueues into thought_work_claims under the extraction key, and
--      `db/extract-entities.ts` is a second consumer of `claim_thoughts`, not a
--      second coordination mechanism.
--
--   3. RE-EXTRACTION CONVERGES BY CONSTRUCTION. `record_thought_entities`
--      replaces a thought's mentions and edges wholesale inside one call, then
--      prunes entities left with no mention and no edge. Running it twice on
--      the same output leaves the same rows; running it on a re-extraction
--      leaves only what the new extraction said. Near-duplicates cannot
--      accumulate from repetition — only from the model naming the same thing
--      two ways, which the resolution rule below addresses and the eval
--      measures.
--
--   4. NOTHING FOR SUPABASE. No RLS, no `service_role` grants, no `NOTIFY
--      pgrst`; migrations 004, 008, 010 and 015 set the precedent and
--      db/test-schema.ts [10] enforces it. No `consolidation_log` either:
--      nothing here consolidates.
--
-- The resolution rule — decided, written down, tested
--   An entity is identified by (entity_type, normalized_name), and
--   normalized_name is `normalize_entity_name()` below: Unicode NFKC, lower
--   case, hyphen/underscore/slash read as spaces, surrounding quotes and
--   punctuation stripped, whitespace collapsed. That is the whole rule.
--   "Postgres", "postgres" and "clinician-portal"/"clinician portal" are one
--   entity each; "Postgres" and "PostgreSQL" are two. The alternative — fuzzy
--   merging by trigram similarity or by asking the model to canonicalise
--   against the existing table — makes the result depend on the order thoughts
--   were processed in and merges "Anita" with "Anika" as readily as "Postgres"
--   with "PostgreSQL", and a wrong merge is far harder to undo than a
--   duplicate is to merge. So the pipeline never merges. The prompt asks the
--   model for the most complete common name and for aliases; aliases are
--   RECORDED on the entity (`aliases`) and never used to resolve. A human
--   merges with `merge_entities(survivor, loser)`, which re-points mentions and
--   edges and keeps the loser's name as an alias. evals/eval-entities.ts
--   reports how many near-duplicates the strict rule leaves on the real corpus,
--   so the trade is measured rather than asserted.
--
-- On update and delete (migration 009's verbs)
--   Editing content invalidates what was extracted from it: the trigger below
--   re-enqueues the thought on `UPDATE OF content`, and the next extraction
--   replaces its rows. Until then the old mentions stand — stale but present
--   is preferred to absent, and `extract-entities.ts --status` shows the
--   pending count. If the edit lands while a worker holds the thought's lease,
--   the re-enqueue sets the claim back to pending, the worker's release
--   returns false, and the thought is extracted again from the new content.
--   Deleting a thought cascades to its mentions and its edges (point 1), and
--   prunes nothing else — an entity the deleted thought introduced stays until
--   the next extraction pass touches it, or for ever if nothing does; the
--   eval reports orphan counts and `prune_orphan_entities()` removes them.
--
-- Cost, stated up front
--   Extraction is an LLM call per thought — a recurring cost proportional to
--   corpus size, unlike everything else in this schema. Nothing here spends
--   it: the trigger enqueues only when `ob1_config.entity_extraction_key` is
--   set, and only `db/extract-entities.ts` sets it, on its first run. Until an
--   operator runs the worker this migration costs one catalog lookup per
--   capture and nothing more. The measured cost of a full pass is in FORK.md
--   change 30 and evals/README.md.
--
-- Safety
--   * Additive. `thoughts` gains a trigger and no columns.
--   * Every DELETE is qualified: a thought's own rows, or entities with no
--     mention and no edge.
--   * Idempotent.
--
-- Prerequisites
--   Migrations 011 (pg_trgm, for the eval's near-duplicate report) and 015.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The resolution rule, as a function
--
-- IMMUTABLE so it can back the unique index and be used in a lookup without
-- re-evaluation; STRICT so NULL stays NULL. `normalize()` is the Postgres
-- built-in (13+), not an ICU call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_entity_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $$
  SELECT NULLIF(
    regexp_replace(
      btrim(
        -- Hyphen, underscore, slash and backslash are word separators. The
        -- first corpus run left 1,853 near-duplicate pairs, and every one of
        -- the fifteen closest was this: "anonymous-intake" beside "anonymous
        -- intake", "state_of_care" beside "State of Care",
        -- "siggymd/infrastructure" beside "SiggyMD infrastructure". Folding the
        -- separators is still a spelling rule, not a guess at meaning.
        regexp_replace(lower(normalize(p_name, NFKC)), '[-_/\\#]+', ' ', 'g'),
        E' \t\n\r"''`.,;:!?()[]{}<>'),
      '\s+', ' ', 'g'),
    '')
$$;

COMMENT ON FUNCTION normalize_entity_name(text) IS
  'The entity resolution rule: NFKC, lower case, hyphen/underscore/slash treated as spaces, surrounding quotes and punctuation stripped, whitespace collapsed. Two names that normalise alike within a type are one entity; nothing fuzzier is ever applied automatically.';

-- ---------------------------------------------------------------------------
-- The entities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_entities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text        NOT NULL
    CHECK (entity_type IN ('person', 'organization', 'project', 'tool', 'topic', 'place')),
  -- The display name: the first form the model gave, kept as written.
  name             text        NOT NULL CHECK (name <> '' AND length(name) <= 200),
  normalized_name  text        NOT NULL,
  -- Other forms the model has offered for this entity. Recorded, never used to
  -- resolve; see the header.
  aliases          text[]      NOT NULL DEFAULT '{}',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, normalized_name)
);

COMMENT ON TABLE ob1_entities IS
  'Typed entities extracted from thoughts, one row per (entity_type, normalized_name). The name is the first form seen; aliases collect the others. Nothing merges automatically — merge_entities() is the human step.';

-- ---------------------------------------------------------------------------
-- Mentions: which thought mentioned which entity, with what confidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thought_entities (
  thought_id       uuid        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE, on the entity side: see "Why the entity keys
  -- restrict" above record_thought_entities.
  entity_id        uuid        NOT NULL REFERENCES ob1_entities(id) ON DELETE RESTRICT,
  confidence       numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- The pass that wrote this row: `extract:<model>@p<prompt version>`. What a
  -- later pass under another key replaces, and what a reader can trust
  -- differently by.
  extraction_key   text        NOT NULL,
  -- Who ran the pass: the worker's stable agent id from ob1_agents when it had
  -- one (it authenticates like any client), NULL when it did not.
  canonical_agent_id uuid,
  extracted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thought_id, entity_id)
);

COMMENT ON TABLE thought_entities IS
  'Which thought mentions which entity. Replaced wholesale per thought on each extraction, so a re-extraction leaves only what the new pass said.';

CREATE INDEX IF NOT EXISTS thought_entities_entity_idx
  ON thought_entities (entity_id);

-- ---------------------------------------------------------------------------
-- Edges: a relation between two entities, evidenced by one thought
--
-- One row per (thought, from, to, relation). Support is `count(*)` over the
-- rows for a (from, to, relation); confidence is per evidence. Symmetric
-- relations are stored with from < to (record_thought_entities orders them),
-- so "A co-occurs with B" and "B co-occurs with A" are the same row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_entity_edges (
  thought_id       uuid        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  from_entity_id   uuid        NOT NULL REFERENCES ob1_entities(id) ON DELETE RESTRICT,
  to_entity_id     uuid        NOT NULL REFERENCES ob1_entities(id) ON DELETE RESTRICT,
  relation         text        NOT NULL
    CHECK (relation IN ('works_on', 'uses', 'member_of', 'located_in', 'depends_on', 'related_to', 'co_occurs_with')),
  confidence       numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extraction_key   text        NOT NULL,
  canonical_agent_id uuid,
  extracted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thought_id, from_entity_id, to_entity_id, relation),
  CHECK (from_entity_id <> to_entity_id)
);

COMMENT ON TABLE ob1_entity_edges IS
  'A relation between two entities as evidenced by one thought. Support for a relation is the count of its rows; deleting the thought deletes the evidence. Symmetric relations (related_to, co_occurs_with) are stored with from_entity_id < to_entity_id.';

CREATE INDEX IF NOT EXISTS ob1_entity_edges_from_idx
  ON ob1_entity_edges (from_entity_id, relation);
CREATE INDEX IF NOT EXISTS ob1_entity_edges_to_idx
  ON ob1_entity_edges (to_entity_id, relation);

-- ---------------------------------------------------------------------------
-- content_fingerprint_of — migration 003's rule, as a function
--
-- Rows from before 003, and rows loaded around upsert_thought, carry a NULL
-- content_fingerprint. The stale-content guard below cannot be allowed to fall
-- silent for them — that is exactly the row an old extraction could overwrite a
-- newer one on — so both sides compute the fingerprint from the content when
-- the column is NULL, with this one definition. Byte-identical to 003's and
-- 009's inline expression.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION content_fingerprint_of(p_content text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $$
  SELECT encode(sha256(convert_to(lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')), 'hex')
$$;

COMMENT ON FUNCTION content_fingerprint_of(text) IS
  'The content fingerprint rule of migration 003 as a function, for rows whose content_fingerprint column is NULL.';

-- ---------------------------------------------------------------------------
-- Why the entity keys restrict
--
-- The prune at the end of record_thought_entities decides "no mention and no
-- edge references this entity" from its own snapshot. Under READ COMMITTED
-- another worker can have committed a mention of that entity a moment before,
-- after this call's snapshot was taken: the DELETE waits on the row lock that
-- worker held, re-checks its WHERE against the new row version, but the
-- NOT EXISTS subqueries still see the old snapshot, and the entity is deleted.
-- With ON DELETE CASCADE that removed the other worker's committed mention and
-- edges, silently, both calls reporting ok. With ON DELETE RESTRICT the
-- foreign-key check runs against the latest committed state and raises
-- instead, and the prune below catches that and keeps the entity: a referenced
-- entity is not an orphan, whatever the snapshot said. The thought side of the
-- keys still cascades — deleting a thought deletes its own rows.
--
-- record_thought_entities — one thought's extraction, written atomically
--
-- p_entities:  [{"name": "PostgreSQL", "type": "tool", "confidence": 0.9,
--                "aliases": ["Postgres"]}, …]
-- p_relations: [{"from": "Anita", "to": "PostgreSQL", "relation": "uses",
--                "confidence": 0.8}, …]  — names, resolved through the rule
--
-- Entities are upserted by (type, normalized name): a new one takes the name
-- as given; an existing one keeps its name, gains any new aliases (including
-- the form just seen, when it differs from the stored name), and moves
-- last_seen_at. The thought's previous mentions and edges are deleted and the
-- new ones inserted, and entities left with no mention and no edge anywhere
-- are pruned. A relation naming an entity not in p_entities is dropped and
-- counted, not invented: the model asserted a link to something it did not
-- list, and a node with no mention would be an edge to nothing.
--
-- p_content_fingerprint is the fingerprint of the content the extraction was
-- made FROM — content_fingerprint_of() it if the column was NULL, as the worker
-- does. When it differs from the thought's current fingerprint (likewise
-- computed when NULL) the content changed under the worker; nothing is written
-- and stale=true comes back. NULL skips the check, for callers that have no
-- content to compare — the eval's replay.
--
-- A relation endpoint is resolved by normalised name among the entities the
-- model listed for this thought. When the model listed the same name under two
-- types the higher confidence wins, then the type order person, organization,
-- project, tool, topic, place — deterministic rather than heap order — and the
-- relation is counted in ambiguous_relations so the choice is visible.
--
-- Returns {ok, stale, entities, new_entities, mentions, edges, dropped_relations,
-- ambiguous_relations, pruned_entities}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_entities(
  p_thought_id          uuid,
  p_extraction_key      text,
  p_entities            jsonb,
  p_relations           jsonb DEFAULT '[]'::jsonb,
  p_content_fingerprint text  DEFAULT NULL,
  p_agent_id            uuid  DEFAULT NULL
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
BEGIN
  IF p_extraction_key IS NULL OR p_extraction_key = '' THEN
    RAISE EXCEPTION 'record_thought_entities: p_extraction_key must name the pass, e.g. extract:<model>@p1';
  END IF;
  IF p_entities IS NULL OR jsonb_typeof(p_entities) <> 'array' THEN
    RAISE EXCEPTION 'record_thought_entities: p_entities must be a JSON array, got %', COALESCE(jsonb_typeof(p_entities), 'NULL');
  END IF;
  IF p_relations IS NOT NULL AND jsonb_typeof(p_relations) <> 'array' THEN
    RAISE EXCEPTION 'record_thought_entities: p_relations must be a JSON array, got %', jsonb_typeof(p_relations);
  END IF;

  SELECT true, COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))
    INTO v_exists, v_current_fp FROM thoughts t WHERE t.id = p_thought_id;
  IF v_exists IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_content_fingerprint IS NOT NULL AND v_current_fp IS DISTINCT FROM p_content_fingerprint THEN
    RETURN jsonb_build_object('ok', false, 'stale', true, 'error', 'STALE_CONTENT');
  END IF;

  -- The model's output, cleaned to what the tables accept. Names outside the
  -- length bound or types outside the enum are dropped here rather than
  -- failing the whole thought on one bad item.
  CREATE TEMP TABLE IF NOT EXISTS _rte_in (
    name text, ntype text, nname text, confidence numeric(3,2), aliases text[]
  ) ON COMMIT DROP;
  DELETE FROM _rte_in WHERE true;
  INSERT INTO _rte_in (name, ntype, nname, confidence, aliases)
  SELECT DISTINCT ON (e.ntype, e.nname) e.name, e.ntype, e.nname, e.confidence, e.aliases
    FROM (
      SELECT btrim(x->>'name')                                            AS name,
             lower(btrim(x->>'type'))                                     AS ntype,
             normalize_entity_name(x->>'name')                            AS nname,
             LEAST(GREATEST(COALESCE((x->>'confidence')::numeric, 0.5), 0), 1)::numeric(3,2) AS confidence,
             -- Other written forms only: an alias equal to the name is the name.
             COALESCE(ARRAY(SELECT DISTINCT btrim(a) FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(x->'aliases') = 'array' THEN x->'aliases' ELSE '[]'::jsonb END) a
               WHERE btrim(a) <> '' AND btrim(a) <> btrim(x->>'name') ORDER BY 1), '{}'::text[]) AS aliases
        FROM jsonb_array_elements(p_entities) x
       WHERE jsonb_typeof(x) = 'object'
    ) e
   WHERE e.nname IS NOT NULL
     AND length(e.name) BETWEEN 1 AND 200
     AND e.ntype IN ('person', 'organization', 'project', 'tool', 'topic', 'place')
   ORDER BY e.ntype, e.nname, e.confidence DESC;

  -- Upsert the entities. A new row takes the name as given; an existing row
  -- keeps its name and collects the other forms as aliases.
  WITH up AS (
    INSERT INTO ob1_entities (entity_type, name, normalized_name, aliases)
    SELECT i.ntype, i.name, i.nname, i.aliases FROM _rte_in i
    ON CONFLICT (entity_type, normalized_name) DO UPDATE
      SET last_seen_at = now(),
          aliases = (SELECT ARRAY(SELECT DISTINCT a FROM unnest(
                       ob1_entities.aliases
                       || EXCLUDED.aliases
                       || CASE WHEN EXCLUDED.name <> ob1_entities.name THEN ARRAY[EXCLUDED.name] ELSE '{}'::text[] END
                     ) a WHERE a <> ob1_entities.name ORDER BY a))
    RETURNING (xmax = 0) AS created
  )
  SELECT count(*) FILTER (WHERE created), count(*) INTO v_new, v_entities FROM up;

  -- Replace the thought's rows, remembering which entities they pointed at:
  -- those are the only candidates for pruning.
  CREATE TEMP TABLE IF NOT EXISTS _rte_touched (id uuid) ON COMMIT DROP;
  DELETE FROM _rte_touched WHERE true;
  WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_thought_id RETURNING from_entity_id, to_entity_id)
  INSERT INTO _rte_touched SELECT from_entity_id FROM d UNION SELECT to_entity_id FROM d;
  WITH d AS (DELETE FROM thought_entities WHERE thought_id = p_thought_id RETURNING entity_id)
  INSERT INTO _rte_touched SELECT entity_id FROM d;

  INSERT INTO thought_entities (thought_id, entity_id, confidence, extraction_key, canonical_agent_id)
  SELECT p_thought_id, en.id, i.confidence, p_extraction_key, p_agent_id
    FROM _rte_in i
    JOIN ob1_entities en ON en.entity_type = i.ntype AND en.normalized_name = i.nname;
  GET DIAGNOSTICS v_mentions = ROW_COUNT;

  -- Edges, resolved by name through the same rule, restricted to entities the
  -- model listed for this thought. Symmetric relations are ordered.
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
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins),
         (SELECT count(*) FROM rel WHERE NOT resolvable),
         (SELECT count(*) FROM rel WHERE resolvable AND ambiguous)
    INTO v_edges, v_dropped, v_ambiguous;

  -- Entities this thought used to reference and nothing references any more —
  -- typically the previous extraction's, for a thought whose content changed.
  -- Guarded: see "Why the entity keys restrict". A concurrent mention this
  -- snapshot cannot see makes the DELETE fail its foreign key, and then every
  -- candidate is kept; the next pass, or prune_orphan_entities(), gets the
  -- ones that really are orphans.
  BEGIN
    WITH gone AS (
      DELETE FROM ob1_entities en
       WHERE en.id IN (SELECT id FROM _rte_touched)
         AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = en.id)
         AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = en.id OR g.to_entity_id = en.id)
      RETURNING 1
    )
    SELECT count(*) INTO v_pruned FROM gone;
  EXCEPTION WHEN foreign_key_violation THEN
    v_pruned := 0;
  END;

  RETURN jsonb_build_object(
    'ok', true, 'stale', false,
    'entities', v_entities, 'new_entities', v_new, 'mentions', v_mentions,
    'edges', v_edges, 'dropped_relations', v_dropped, 'ambiguous_relations', v_ambiguous,
    'pruned_entities', v_pruned);
END;
$$;

COMMENT ON FUNCTION record_thought_entities(uuid, text, jsonb, jsonb, text, uuid) IS
  'Write one thought''s extraction atomically: upsert entities by (type, normalized name), replace the thought''s mentions and edges, prune entities left unreferenced. Refuses with stale=true when p_content_fingerprint no longer matches the thought. Idempotent for identical input.';

-- ---------------------------------------------------------------------------
-- merge_entities — the human step the resolution rule leaves to a human
--
-- Re-points the loser's mentions and edges at the survivor (dropping rows the
-- survivor already has, and edges that would join the survivor to itself),
-- records the loser's name and aliases as aliases of the survivor, and
-- deletes the loser. Both must share a type: merging a person into a project
-- is not a resolution, it is a mistake this refuses to make.
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
         first_seen_at = LEAST(first_seen_at, v_l.first_seen_at),
         last_seen_at  = GREATEST(last_seen_at, v_l.last_seen_at)
   WHERE id = p_survivor;

  DELETE FROM ob1_entities WHERE id = p_loser;

  RETURN jsonb_build_object('ok', true, 'survivor', p_survivor, 'merged', v_l.name, 'mentions_moved', v_mentions, 'edges_moved', v_edges);
END;
$$;

COMMENT ON FUNCTION merge_entities(uuid, uuid) IS
  'Merge one entity into another of the same type: mentions and edges move to the survivor (duplicates and self-joins dropped), the loser''s name and aliases become aliases, the loser is deleted. The one resolution step that is a human''s to take.';

-- ---------------------------------------------------------------------------
-- prune_orphan_entities — entities no thought mentions and no edge joins
--
-- record_thought_entities prunes after every write, so this is for the case
-- that call never sees: a deleted thought took its mentions with it and the
-- entities it introduced remain. Returns how many went.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_orphan_entities()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_n int := 0;
BEGIN
  -- Guarded for the same reason record_thought_entities' prune is: a mention
  -- committed after this snapshot fails the foreign key rather than being
  -- cascaded away, and the pass reports nothing pruned.
  BEGIN
    DELETE FROM ob1_entities en
     WHERE NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = en.id)
       AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = en.id OR g.to_entity_id = en.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    v_n := 0;
  END;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION prune_orphan_entities() IS
  'Delete entities with no mention and no edge — what a deleted thought leaves behind. Returns the count.';

-- ---------------------------------------------------------------------------
-- The trigger: new and edited content joins the pool
--
-- Only when a key is set. `ob1_config.entity_extraction_key` is written by
-- db/extract-entities.ts on its first run and names the pass new captures
-- should join; absent, this trigger does nothing, and no LLM is ever called
-- on anyone's behalf who did not ask. `requeue_thought_work` sets an existing
-- claim back to pending whatever its state — including `claimed`, which is
-- what revokes a worker's lease when the content changes under it.
--
-- AFTER INSERT OR UPDATE OF content: a metadata-only edit does not change what
-- the text says, and upsert_thought's ON CONFLICT branch (same content again)
-- is an UPDATE that leaves content alone, so a repeated import re-enqueues
-- nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION requeue_thought_work(p_work_type text, p_thought_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO thought_work_claims (thought_id, work_type)
  VALUES (p_thought_id, p_work_type)
  ON CONFLICT (thought_id, work_type) DO UPDATE
    SET status = 'pending', ttl_expires_at = NULL, attempt_count = 0,
        last_error = NULL, finished_at = NULL, enqueued_at = now(), worker_id = NULL
$$;

COMMENT ON FUNCTION requeue_thought_work(text, uuid) IS
  'Put one thought (back) in the pool for a work_type, whatever its current claim state — a claimed lease is revoked, and the holder''s release will return false.';

CREATE OR REPLACE FUNCTION thoughts_enqueue_entity_extraction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT value INTO v_key FROM ob1_config WHERE key = 'entity_extraction_key';
  IF v_key IS NULL OR v_key = '' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    RETURN NULL;
  END IF;
  PERFORM requeue_thought_work(v_key, NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS thoughts_entity_extraction ON thoughts;
CREATE TRIGGER thoughts_entity_extraction
  AFTER INSERT OR UPDATE OF content ON thoughts
  FOR EACH ROW EXECUTE FUNCTION thoughts_enqueue_entity_extraction();
