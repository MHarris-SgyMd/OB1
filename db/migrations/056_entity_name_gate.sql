-- =============================================================================
-- Migration 056: the entity graph refuses a number or a type word as a name,
--                and a person or place with an identifier's shape is retyped
--                — at the writer, and over the rows written before it
--                (SMD-1935)
-- =============================================================================
--
-- WHY
--   016's extractor mints context-stripped fragments as entities, and types
--   them by guess. On the dogfood brain at 053 (3,384 entities): 107 names are
--   only digits, dots, colons and spaces — migration numbers lifted out of
--   "migration 021", the Ollama port, loopback addresses, CIDRs — spread over
--   every type (17 of the 50 `person` rows); 9 are the type vocabulary itself
--   (`person`, `place`); and 12 persons and places are identifiers: `hono/mcp`
--   and `SMD-1804` as people; three hosts, a domain, a Docker network, a URL
--   and four path globs as places. Every reader that trusts a type (facets, the
--   person layer, SMD-1933's people handling, graph centrality) is misled,
--   and graph-centrality has filtered the numbers on read since SMD-1938.
--
--   SMD-1937 measured the ticket's proposed gate on 201 blind-graded mentions
--   before this file was written. The number and vocabulary rules are right;
--   REFUSING an identifier-shaped person or place dropped seven real entities
--   (code artifacts, which the maintainer decided are entities, typed `place`)
--   for one junk mention. So a shape corrects the type instead.
--
-- WHAT
--   1. entity_type_gate(name, type) — IMMUTABLE, STRICT — the type the graph
--      stores a name under, or NULL to refuse it:
--        * refused: a name whose normalize_entity_name(), trimmed, is digits,
--          then any run of digits, dots, colons and spaces (entity-gate.ts's
--          NUMERIC_NAME_RE; `10/8` and `127.0.0.1:11434` fold into it), or
--          a type-vocabulary word (`person`, `people`, `tools`, `entity` …);
--        * retyped: a person or place with a ticket id's shape (`SMD-1804`)
--          to `project`; with a URL's, a package's or path's, or a
--          host:port's to `tool`; a place (not a person — a handle takes
--          these: `john.smith`, `@john_doe`) with a host's, domain's or
--          file's, or a snake_case name's or glob's to `tool`. Read on the
--          name as written, trimmed of ASCII whitespace, every class spelled
--          out (never \w or \S, which Postgres reads by locale);
--        * otherwise the type given.
--      server-portable/entity-gate.ts is its JavaScript twin, for the
--      `people` metadata facet that never reaches this function (a name the
--      gate does not keep as a person is dropped there); test-schema holds
--      the two to one answer over a probe list.
--
--   2. record_thought_entities redefined on 053's body, same signature: each
--      entity's type is the gate's answer, a refused one is not written (and
--      a relation naming it is dropped and counted, as a relation to an
--      unlisted entity always was), and the result gains `refused_entities`
--      and `retyped_entities`, one per answered (type, name). An extraction
--      is gated; a `source:` pass is not — it states its names on the
--      source's authority, and a Linear label `2024` or `Tools` is a label
--      (first review pass). So a numeric name a source states can remain.
--      The merged_from redirect is spelled `@>`, which 016's GIN index
--      serves (third review pass). The body carries the `ob1:name-gate`
--      sentinel.
--
--   3. apply_entity_type_gate() — the same rule over the rows already
--      written, each entity judged on its name (its first-seen spelling).
--      Two kinds of entity stand, with their extracted mentions: one a
--      structured pass names (once the source stops naming it, a later run
--      of this takes it), and one a human curated — a name merged into it
--      with merge_entities() — since retyping it would bring the names merged
--      into it back as entities of the old type (third review pass). A
--      refused entity's edges, mentions and row are deleted. A
--      retyped one is MERGED into the entity of the new type the writer
--      would resolve its name to — the one a human merged the name into,
--      else the one of that name (hono/mcp the person into hono/mcp the
--      tool) — by merge_entities' steps, which 016's function will not take
--      across types: the mentions the target lacks move, its edges are
--      re-pointed (a symmetric relation re-ordered, a duplicate or self-edge
--      dropped), its name and aliases fold into the target's, the earlier
--      first_seen_at and later last_seen_at kept. With no such entity it is
--      moved. A retyped row carries no merged_from (a curated one stands), so
--      no human merge crosses into another type. Returns the counts.
--      This file runs it once and keeps what the first run did in ob1_config
--      under `entity_name_gate_056` — a NOTICE would reach no one, the
--      migrator's client surfacing none. It is idempotent, so --reapply finds
--      nothing (and keeps the first run's record).
--
-- SAFETY
--   A data change: MINOR under the version rules. What it deletes is what the
--   rule refuses — rows no reader should have trusted — and every DELETE
--   names its rows. An extraction re-run does not re-mint them: the writer
--   applies the same rule. Nothing re-extracts; the model's answers are not
--   needed, since the gate reads only a name and a type. No ACL: the two new
--   functions are callable as any function this fork defines (010's reason),
--   and apply_entity_type_gate() only does what the writer does to every
--   answer. Its lock (SHARE ROW EXCLUSIVE on ob1_entities) waits for a
--   writer that has written and holds the next one's INSERT until it commits;
--   a writer call already running 053's body when the file commits still
--   writes by 053's rule, so stop the extraction workers for the upgrade, or
--   run `SELECT apply_entity_type_gate()` once they have finished.
--
-- Dependencies: 016 (the entity tables, normalize_entity_name), 053
--   (record_thought_entities' body, redefined here).
-- =============================================================================

-- Each prerequisite named on its own, as 053 names its two. Driven by
-- test-upgrade.ts [20j].
DO $g$
BEGIN
  IF to_regclass('ob1_entity_edges') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 056 needs 016 (ob1_entity_edges); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply';
  END IF;
  IF to_regclass('thought_sources') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 056 needs 053 (thought_sources, and its record_thought_entities body); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- entity_type_gate — the rule
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entity_type_gate(p_name text, p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $$
  SELECT CASE
    WHEN s.n IS NULL OR s.n = '' THEN NULL
    WHEN s.n ~ '^[0-9][0-9 .:]*$' THEN NULL
    WHEN s.n IN ('person', 'persons', 'people', 'organization', 'organizations', 'organisation', 'organisations',
                 'project', 'projects', 'tool', 'tools', 'topic', 'topics', 'place', 'places', 'entity', 'entities') THEN NULL
    WHEN p_type NOT IN ('person', 'place') THEN p_type
    WHEN s.r ~ '^[A-Za-z]+-[0-9]+$' THEN 'project'
    WHEN s.r ~ '^[A-Za-z][A-Za-z0-9+.-]*://'
      OR s.r ~ '^@?[A-Za-z0-9_.-]+/[A-Za-z0-9_.*/-]*$'
      OR s.r ~ '^[^ \t\n\r\f\v]+:[0-9]+$' THEN 'tool'
    -- The handle of a person takes these two shapes (john.smith, @john_doe),
    -- so they retype a place only (second review pass).
    WHEN p_type = 'place' AND (s.r ~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$'
                            OR s.r ~ '^[^ \t\n\r\f\v]*[_*][^ \t\n\r\f\v]*$') THEN 'tool'
    ELSE p_type
  END
  -- The shapes read the name trimmed of ASCII whitespace, and spell that
  -- class out, never \S: Postgres reads \s by locale and btrim() strips
  -- spaces alone, so `SMD-1804` and a trailing tab parted from the twin
  -- (first review pass). The normalised name is trimmed of spaces too: the
  -- outer strip of 016 knows no form feed, so `\f021` normalises to ` 021`
  -- (second review pass). No apostrophe in these comments: test-schema [52]
  -- reads the quoted literals of this body.
  FROM (SELECT btrim(normalize_entity_name(p_name)) AS n, regexp_replace(p_name, '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g') AS r) s
$$;

COMMENT ON FUNCTION entity_type_gate(text, text) IS
  'The entity name gate (056): the type the graph stores a name under, or NULL to refuse it. Refused: a name that normalises to digits, dots, colons and spaces (a migration number, port, address, CIDR) or to a type-vocabulary word. Retyped: a person or place with a ticket id''s shape to project; with a URL''s, a package''s, a path''s or a host:port''s to tool; a place (not a person, whose handle takes these) with a host''s, domain''s, file''s, snake_case name''s or glob''s to tool. Otherwise the type given. server-portable/entity-gate.ts is its twin. SMD-1935.';

-- ---------------------------------------------------------------------------
-- record_thought_entities — 053's writer with the gate
--
-- The body is 053's with two changes: the type an extraction's entity is
-- written under is entity_type_gate()'s answer, a refused entity is not
-- written, and the two counts are returned; and the merged_from redirect
-- reads `merged_from @> ARRAY[name]`, which 016's GIN index serves, where
-- `name = ANY(merged_from)` scanned every entity of the type on every call.
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
  v_refused    int := 0;
  v_retyped    int := 0;
  -- ob1:structured-wins (053): a `source:<system>` key is a structured pass.
  v_structured boolean := p_extraction_key LIKE 'source:%';
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
  -- it was and 029's stale_entities can still see it (third review pass,
  -- independent read).
  -- …and a structured pass that brings no new alias writes no entity row at
  -- all: without the WHERE, a no-op pass left a dead tuple per entity every
  -- five minutes on every stale ticket (fourth review pass). An extraction
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
    RETURNING 1
  )
  SELECT count(*) INTO v_pruned FROM gone;

  RETURN jsonb_build_object(
    'ok', true, 'stale', false,
    'entities', v_entities, 'new_entities', v_new, 'mentions', v_mentions,
    'edges', v_edges, 'dropped_relations', v_dropped, 'ambiguous_relations', v_ambiguous,
    'pruned_entities', v_pruned, 'refused_entities', v_refused, 'retyped_entities', v_retyped);
END;
$$;

COMMENT ON FUNCTION record_thought_entities(uuid, text, jsonb, jsonb, text, uuid) IS
  'Writes one thought''s entities and relations atomically (016), with 053''s resolution rule and 056''s name gate. An extraction''s entities are written under entity_type_gate()''s type: a number or a type-vocabulary word is refused (not written, and a relation naming it dropped and counted), an identifier-shaped person or place retyped to project or tool; a structured pass is not gated. An extraction_key `source:<system>` is a structured pass (the source''s own project, labels, members — no model call) that keeps its own rows as a set — the same set twice writes nothing, and moves no last_seen_at; an `extract:*` pass replaces only extracted rows; and where both name one (thought, entity) or (thought, from, to, relation) the structured row stands — an extracted insert onto it does nothing, a structured insert onto an extracted row takes it over. Entities upserted by (type, normalised name); a relation naming an unlisted entity is dropped and counted; entities left unreferenced are pruned. p_content_fingerprint NULL skips the stale check. Returns {ok, stale, entities, new_entities, mentions, edges, dropped_relations, ambiguous_relations, pruned_entities, refused_entities, retyped_entities}. Migrations 016, 053, 056 / SMD-947, SMD-1867, SMD-1935.';

-- ---------------------------------------------------------------------------
-- apply_entity_type_gate — the rule over the rows written before it
-- ---------------------------------------------------------------------------
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
    v_target := NULL;
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
    DELETE FROM ob1_entities WHERE id = r.id;
    v_merged := v_merged + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'refused_entities', v_refused, 'dropped_mentions', v_mentions, 'dropped_edges', v_edges,
                            'moved_entities', v_moved, 'merged_entities', v_merged);
END;
$$;

COMMENT ON FUNCTION apply_entity_type_gate() IS
  'Applies entity_type_gate() to the entities already written (056), each judged on its name; an entity a structured pass names or a human curated (a non-empty merged_from) is left as it stands. A refused entity''s edges, mentions and row are deleted; a retyped one merges into the entity of its new type the writer would resolve its name to (the one a human merged the name into, else the one of that name) by merge_entities'' steps — the mentions it lacks moved, edges re-pointed, aliases and seen-at folded — or moves when there is none. Idempotent. Returns {ok, refused_entities, dropped_mentions, dropped_edges, moved_entities, merged_entities}; the first run''s is kept in ob1_config under entity_name_gate_056. SMD-1935.';

-- The rows written before the gate, once. What the first run did is kept in
-- ob1_config: a NOTICE reaches no one (the migrator's client does not surface
-- notices, and the server logs from WARNING), and a second run finds nothing,
-- so the count of rows deleted would otherwise be nowhere (third review
-- pass). ON CONFLICT DO NOTHING: --reapply keeps the first run's.
INSERT INTO ob1_config (key, value)
VALUES ('entity_name_gate_056', apply_entity_type_gate()::text)
ON CONFLICT (key) DO NOTHING;
