-- =============================================================================
-- Migration 053: the source beside the thought — thought_sources holds the
--                canonical form and the stable identity, `link` facets hold the
--                typed relations a source's structured layer names, and
--                record_thought_entities lets a structured pass and an
--                extracted pass coexist with the structured row standing
--                (SMD-1867; SMD-1865 is its Linear instance)
-- =============================================================================
--
-- WHY
--   Every capture source carries two things besides its text: presentation
--   markup, which is noise for retrieval, and structure — links, parents,
--   memberships — which the source already knows with full precision. The
--   Linear ingester stored the markup verbatim (~80 bytes of URL boilerplate
--   per cross-reference, a cause of the capture failures SMD-1864 measured and
--   of ~19% extraction failures on the board load) and threw the structure
--   away, leaving 016's model to re-infer from prose what the source had said
--   outright. And a text cleaned before it is stored is a text that cannot be
--   written back: a two-way connector (SMD-949) needs the source form kept as
--   the truth, the clean text and the edges derived from it.
--
-- WHAT
--   1. thought_sources — one row per thought that came from a source system:
--      the system, the identity that survives a rename on the source side
--      (SMD-1813's rule; a Linear identifier, a Markdown file's frontmatter id),
--      the CANONICAL form byte for byte (a `text`: UTF-8 without NUL is
--      byte-faithful; the two cases it cannot hold are refused by the adapter,
--      never stored mangled), its media type, its hash (written beside it, so
--      "did the source change" is one compare) and the ingest run that wrote
--      it. `UNIQUE (system, identity)`: an identity names one thought.
--      record_thought_source() writes it idempotently — the same canonical is
--      "unchanged", a moved one "updated" — and refuses an identity another
--      thought holds (IDENTITY_HELD, the holder named) unless the caller says
--      p_take: the board sync does, because the row that holds a ticket moves
--      when an older paste becomes the chain's head (SMD-1954), and the
--      identity follows the head; the ingester does not, because its ids are
--      deterministic and a holder is a real second writer. source_thought() resolves an
--      identity to a thought for readers: this table first, then the board
--      sync's `metadata.issue` claim for `linear` (SMD-1954 keyed the dogfood
--      rows on it before this table existed), the head of a twin chain.
--
--   2. A second facet kind, `link` (042 said a later migration registers one by
--      extending thought_facets_validate): payload {relation, system, target,
--      origin} — a typed relation from the thought to another item of the same
--      source system, named by IDENTITY, never by id, so a link to an item not
--      yet ingested is a fact today and resolves the day the item arrives
--      (source_thought). relation is one of references | child_of | blocks |
--      blocked_by | relates_to | duplicate_of; origin is `structured` (the
--      source said it) — the validator writes it. A self-link is refused.
--      record_source_links(thought, system, links) is the writer, with SET
--      semantics: a link the source no longer states is CLOSED (valid_until =
--      now(), history — 042's rule that history is labelled, never hidden), a
--      link already active is kept, a new one added; the same set twice writes
--      nothing. One active row per (thought, system, relation, target) is held
--      by a partial unique index, so no writer can double an edge.
--
--   3. THE RESOLUTION RULE, in record_thought_entities: an extraction_key
--      `source:<system>` marks a structured pass — the source's own project,
--      labels, members, written as mentions with confidence 1 and no model
--      call. Such a pass replaces only ITS OWN rows (the same key); an
--      `extract:*` pass replaces only extracted rows (every key not `source:`),
--      where before it replaced the thought's rows wholesale and would have
--      erased the import on its next run. And where the two name the same
--      (thought, entity) or (thought, from, to, relation), the structured row
--      stands: an extracted insert onto a structured row does nothing, a
--      structured insert onto an extracted row takes it over. The body carries
--      the `ob1:structured-wins` sentinel so a test can tell 053's definition
--      from 016's.
--
-- SAFETY
--   Additive: a new table, a new facet kind the validator admits (every row it
--   admitted before it admits still — the citation branch is 042's verbatim),
--   two indexes, three new functions, two functions redefined with the same
--   signature and the same return shape (thought_facets_validate admits one
--   more kind; a caller of 016's record_thought_entities sees no change unless
--   it wrote `source:` keys, which none did). Idempotent under --reapply:
--   CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR REPLACE everywhere, no
--   trigger re-created (042's trigger calls the function by name). No data
--   change, no ACL; DDL on fork-owned tables — MINOR under the version rules.
--   Every DELETE carries its WHERE: record_thought_entities's own rows and its
--   temp tables (check 21 reads them as 016's), and record_thought_source's
--   one row of the holder an identity is taken from.
--
-- Dependencies: 001 (thoughts), 016 (the entity tables, record_thought_entities,
--   normalize_entity_name), 025 (supersedes, for the chain head), 042
--   (thought_facets, thought_facets_validate).
-- =============================================================================

-- Each prerequisite named on its own, as 052 names its two: the operator is
-- told which migration the schema lacks (eighth review pass). Driven by
-- test-upgrade.ts [20g].
DO $g$
BEGIN
  IF to_regclass('ob1_entity_edges') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 053 needs 016 (ob1_entity_edges); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply';
  END IF;
  IF to_regclass('thought_facets') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 053 needs 042 (thought_facets); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- thought_sources — the canonical form and the identity, beside the thought
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thought_sources (
  thought_id     uuid        PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  -- The source system: `linear`, `markdown`, … — lower case, one word.
  system         text        NOT NULL CHECK (system ~ '^[a-z][a-z0-9_-]*$'),
  -- The identity within the system that survives a rename or a move there.
  identity       text        NOT NULL CHECK (identity <> '' AND length(identity) <= 512),
  -- The source form, byte for byte. The text and the edges are DERIVED from it.
  canonical      text        NOT NULL,
  media_type     text        NOT NULL CHECK (media_type <> ''),
  -- sha256 of the canonical, hex. Written by record_thought_source from the same
  -- expression content_fingerprint_of uses; not a generated column, because
  -- convert_to() is STABLE, not IMMUTABLE, and a generation expression must be.
  canonical_hash text        NOT NULL CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  -- Which run of which tool wrote this canonical — the lineage SMD-1731 asks for.
  ingest_run     text,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system, identity)
);

COMMENT ON TABLE thought_sources IS
  'The source beside the thought (SMD-1867): for a thought ingested from a source system, the system, the identity that survives a rename there, and the CANONICAL form byte for byte — the truth a two-way connector writes back, from which thoughts.content (the clean text) and the link facets are derived, never the other way. One thought per (system, identity). Written through record_thought_source; resolved through source_thought. Migration 053.';
COMMENT ON COLUMN thought_sources.canonical IS
  'The source form as read: a Linear issue as JSON with stable key order, a Markdown file''s bytes. A text column is byte-faithful for UTF-8 without NUL; an adapter refuses the two inputs it cannot hold rather than storing them mangled (SMD-1867).';
COMMENT ON COLUMN thought_sources.canonical_hash IS
  'sha256 of the canonical, hex, written by record_thought_source beside the canonical — "did the source change" as one compare.';

-- ---------------------------------------------------------------------------
-- record_thought_source — the canonical, written idempotently
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_source(
  p_thought_id  uuid,
  p_system      text,
  p_identity    text,
  p_canonical   text,
  p_media_type  text,
  p_run         text DEFAULT NULL,
  p_take        boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_holder   uuid;
  v_outcome  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM thoughts WHERE id = p_thought_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  -- An identity another thought holds is not re-pointed by default: two
  -- thoughts claiming one source item is a state the caller must resolve, not
  -- one this writer hides by moving the row. A caller that has resolved it —
  -- the board sync, whose head row for a ticket moves when an older paste
  -- becomes the chain's head — says p_take, and the identity follows: the
  -- holder's row goes (the canonical is re-recorded on the new holder below).
  SELECT thought_id INTO v_holder FROM thought_sources
   WHERE system = p_system AND identity = p_identity AND thought_id <> p_thought_id;
  -- IS NOT TRUE: a NULL p_take is not a take (fourth review pass — NOT NULL is
  -- NULL, and the guard fell through to the takeover).
  IF v_holder IS NOT NULL AND p_take IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'IDENTITY_HELD', 'held_by', v_holder);
  END IF;
  IF v_holder IS NOT NULL THEN
    -- The structure goes with the identity: the holder's active links from
    -- this system are closed (history, as a dropped relation is) and its
    -- structured mentions under this system's key are removed — the new
    -- holder records them afresh — so a reader asking "what links to X" sees
    -- the item's edges once, on the row that is the item (second review pass).
    UPDATE thought_facets
       SET valid_until = now()
     WHERE thought_id = v_holder AND kind = 'link' AND valid_until IS NULL
       AND payload->>'system' = p_system;
    PERFORM record_thought_entities(v_holder, 'source:' || p_system, '[]'::jsonb, '[]'::jsonb, NULL, NULL);
    DELETE FROM thought_sources WHERE thought_id = v_holder;
  END IF;
  -- The lookup above and this write are two statements: two writers landing
  -- one identity on two thoughts in the same instant race to the unique key,
  -- and the loser's violation is answered as IDENTITY_HELD with the holder
  -- re-read, not thrown up a run (third review pass, independent read).
  BEGIN
    INSERT INTO thought_sources (thought_id, system, identity, canonical, media_type, canonical_hash, ingest_run)
    VALUES (p_thought_id, p_system, p_identity, p_canonical, p_media_type, encode(sha256(convert_to(p_canonical, 'UTF8')), 'hex'), p_run)
    ON CONFLICT (thought_id) DO UPDATE
      SET system = EXCLUDED.system, identity = EXCLUDED.identity,
          canonical = EXCLUDED.canonical, media_type = EXCLUDED.media_type,
          canonical_hash = EXCLUDED.canonical_hash,
          ingest_run = EXCLUDED.ingest_run, ingested_at = now()
      WHERE thought_sources.canonical IS DISTINCT FROM EXCLUDED.canonical
         OR thought_sources.system IS DISTINCT FROM EXCLUDED.system
         OR thought_sources.identity IS DISTINCT FROM EXCLUDED.identity
         OR thought_sources.media_type IS DISTINCT FROM EXCLUDED.media_type
    RETURNING CASE WHEN xmax = 0 THEN 'inserted' ELSE 'updated' END INTO v_outcome;
  EXCEPTION WHEN unique_violation THEN
    SELECT thought_id INTO v_holder FROM thought_sources
     WHERE system = p_system AND identity = p_identity AND thought_id <> p_thought_id;
    RETURN jsonb_build_object('ok', false, 'error', 'IDENTITY_HELD', 'held_by', v_holder);
  END;
  RETURN jsonb_build_object('ok', true, 'outcome', COALESCE(v_outcome, 'unchanged'), 'taken_from', v_holder);
END;
$$;

COMMENT ON FUNCTION record_thought_source(uuid, text, text, text, text, text, boolean) IS
  'Writes a thought''s source row (053): inserted, updated when the canonical (or the system, identity or media type) moved, unchanged otherwise — the same canonical twice writes nothing. Refuses NOT_FOUND for a thought that is not there and IDENTITY_HELD when another thought holds the (system, identity), naming it, rather than re-pointing the identity — unless p_take, when the identity follows the caller''s thought: the holder''s source row goes, its active links from this system are closed and its source:<system> mentions removed (taken_from names it); the board sync says p_take because a ticket''s head row moves. SMD-1867.';

-- ---------------------------------------------------------------------------
-- source_thought — an identity, resolved to a thought
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION source_thought(p_system text, p_identity text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT thought_id FROM thought_sources WHERE system = p_system AND identity = p_identity),
    -- The board sync's claim (SMD-1954): a linear ticket row is the one carrying
    -- metadata.issue, and of a twin chain the head — the row nothing supersedes.
    (SELECT t.id FROM thoughts t
      WHERE p_system = 'linear'
        AND t.metadata @> jsonb_build_object('source', 'linear', 'issue', p_identity)
        AND NOT EXISTS (SELECT 1 FROM thoughts n WHERE n.supersedes = t.id)
      ORDER BY t.created_at DESC, t.id LIMIT 1)
  )
$$;

COMMENT ON FUNCTION source_thought(text, text) IS
  'The thought a source identity names, or NULL: thought_sources first; for `linear`, the head of the board sync''s twin chain claiming metadata.issue (SMD-1954), so a link facet''s target resolves on a brain the sync filled before 053. Readers resolve link targets through this; the link itself stores the identity. Migration 053 / SMD-1867.';

-- ---------------------------------------------------------------------------
-- The `link` facet kind — thought_facets_validate extended
--
-- 042's citation branch verbatim below the new branch; only the kind check
-- names two kinds now. A link: relation in the six, system a word, target a
-- non-empty identity within that system, origin `structured` (written here),
-- and not the thought's own identity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_facets_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source   text;
  v_deleted  text;
  v_text     text;
  v_stance   text;
  v_relation text;
  v_system   text;
  v_target   text;
BEGIN
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.payload must be a JSON object, got %s', COALESCE(jsonb_typeof(NEW.payload), 'null'));
  END IF;
  IF NEW.kind IS DISTINCT FROM 'citation' AND NEW.kind IS DISTINCT FROM 'link' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.kind %L is not a registered facet kind', NEW.kind),
      HINT = 'The registered kinds are: citation (migration 042), link (migration 053). A new kind is registered by a migration that extends thought_facets_validate.';
  END IF;

  IF NEW.kind = 'link' THEN
    -- ob1:link-facet (053)
    -- A close — record_source_links setting valid_until with the payload as
    -- it was — is not a new link and is not re-judged: an identity re-pointed
    -- onto the target since (record_thought_source on the same thought) would
    -- otherwise make the row impossible to close, and every later structure
    -- write on the thought would fail (fourth review pass).
    -- Exactly a close and nothing else: the same link row, on the same
    -- thought, going from open to closed — a raw UPDATE that moves the row to
    -- another thought, re-opens it or turns a citation into a link is judged
    -- like any write (fifth review pass, independent read).
    IF TG_OP = 'UPDATE' AND OLD.kind = 'link' AND NEW.thought_id = OLD.thought_id
       AND NEW.payload = OLD.payload AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_relation := NEW.payload->>'relation';
    v_system   := NEW.payload->>'system';
    v_target   := NEW.payload->>'target';
    IF v_relation IS NULL OR v_relation NOT IN ('references', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a link''s relation must be references, child_of, blocks, blocked_by, relates_to or duplicate_of, got %L', v_relation);
    END IF;
    IF v_system IS NULL OR v_system !~ '^[a-z][a-z0-9_-]*$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a link names its source system as one lower-case word, got %L', v_system);
    END IF;
    IF jsonb_typeof(NEW.payload->'target') IS DISTINCT FROM 'string' OR btrim(v_target) = '' OR length(v_target) > 512 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a link names its target by identity within the system: a non-empty string of at most 512 characters';
    END IF;
    IF EXISTS (SELECT 1 FROM thought_sources s WHERE s.thought_id = NEW.thought_id AND s.system = v_system AND s.identity = v_target) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a thought does not link to itself (%s %s)', v_system, v_target);
    END IF;
    -- Origin is the validator's word, not the writer's: the source said it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'structured');
    RETURN NEW;
  END IF;

  v_text    := NEW.payload->>'text';
  v_stance  := NEW.payload->>'stance';
  v_source  := NEW.payload->>'source_id';
  v_deleted := NEW.payload->>'source_deleted_id';

  IF jsonb_typeof(NEW.payload->'text') IS DISTINCT FROM 'string' OR btrim(v_text) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation needs a non-empty text: the statement that rests on the source';
  END IF;
  IF v_stance IS NULL OR v_stance NOT IN ('stated', 'retrieved', 'inferred') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s stance must be stated, retrieved or inferred, got %L', v_stance);
  END IF;

  IF v_source IS NULL THEN
    IF v_deleted IS NULL
       OR v_deleted !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NEW.payload->>'source_deleted_at' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a citation names its source: payload.source_id must be a thought id (null only with source_deleted_id and source_deleted_at — the shape the guard writes when a source is deleted, or a detached row restored whole)';
    END IF;
    BEGIN
      PERFORM (NEW.payload->>'source_deleted_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a detached citation''s source_deleted_at must be a timestamp, got %L', left(NEW.payload->>'source_deleted_at', 40));
    END;
    IF v_deleted IS DISTINCT FROM (v_deleted::uuid)::text THEN
      NEW.payload := NEW.payload || jsonb_build_object('source_deleted_id', v_deleted::uuid);
      v_deleted := (v_deleted::uuid)::text;
    END IF;
    IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM thoughts WHERE id = v_deleted::uuid) THEN
      NEW.payload := (NEW.payload - 'source_deleted_id' - 'source_deleted_at') || jsonb_build_object('source_id', v_deleted::uuid);
      v_source := v_deleted;
    ELSE
      IF TG_OP = 'INSERT' OR OLD.payload->>'source_id' IS NOT NULL THEN
        IF TG_OP = 'UPDATE' AND v_deleted::uuid IS DISTINCT FROM (OLD.payload->>'source_id')::uuid THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('a citation is detached only from the source it had (%s), not %s', OLD.payload->>'source_id', v_deleted);
        END IF;
        IF EXISTS (SELECT 1 FROM thoughts WHERE id = v_deleted::uuid) THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('a citation is detached only when its source is gone; thought %s still exists', v_deleted);
        END IF;
      ELSIF v_deleted::uuid IS DISTINCT FROM (OLD.payload->>'source_deleted_id')::uuid THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'a detached citation keeps the source it lost';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF v_source !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s source_id must be a thought id, got %L', left(v_source, 60));
  END IF;
  IF v_source::uuid = NEW.thought_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a thought cannot cite itself as a source';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payload->>'source_id' IS NULL AND OLD.payload ? 'source_deleted_id' THEN
    IF v_source::uuid IS DISTINCT FROM (OLD.payload->>'source_deleted_id')::uuid THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a detached citation is not re-pointed at a new source (it rested on %s, deleted %s); record a new citation — it may only be re-attached to %s once that thought exists again', OLD.payload->>'source_deleted_id', OLD.payload->>'source_deleted_at', OLD.payload->>'source_deleted_id');
    END IF;
    NEW.payload := NEW.payload - 'source_deleted_id' - 'source_deleted_at';
  END IF;
  IF v_source IS DISTINCT FROM (v_source::uuid)::text THEN
    NEW.payload := NEW.payload || jsonb_build_object('source_id', v_source::uuid);
    v_source := (v_source::uuid)::text;
  END IF;
  IF NEW.payload ? 'source_deleted_id' OR NEW.payload ? 'source_deleted_at' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation with a source carries no source_deleted_id or source_deleted_at — those are the detached shape''s, written when the source is deleted';
  END IF;
  IF TG_OP = 'INSERT' OR v_source IS DISTINCT FROM (OLD.payload->>'source_id') THEN
    PERFORM 1 FROM thoughts WHERE id = v_source::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a citation''s source_id %s is not a thought', v_source);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION thought_facets_validate() IS
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind. For a citation (042): a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — stores source_id lower-case, locks the source row FOR KEY SHARE; source_id may be null only in the detached shape, which keeps what it lost and is not re-pointed. For a link (053): relation one of references | child_of | blocks | blocked_by | relates_to | duplicate_of, system one lower-case word, target a non-empty identity within it, never the thought''s own (thought_sources); writes origin = structured. Migrations 042, 053.';

-- One active link per (thought, system, relation, target): the idempotency of
-- the edge layer is the index's, not a writer's discipline. Closed rows
-- (valid_until set) are history and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_link_active_uniq
  ON thought_facets (thought_id, (payload->>'system'), (payload->>'relation'), (payload->>'target'))
  WHERE kind = 'link' AND valid_until IS NULL;

-- The reverse question — "what links to X" (everything under an epic, the
-- issues blocking a ticket) — is a probe on the target.
CREATE INDEX IF NOT EXISTS thought_facets_link_target_idx
  ON thought_facets ((payload->>'system'), (payload->>'target'))
  WHERE kind = 'link';

-- ---------------------------------------------------------------------------
-- record_source_links — one thought's links from one system, as a set
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_source_links(
  p_thought_id uuid,
  p_system     text,
  p_links      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_added   int := 0;
  v_closed  int := 0;
  v_dropped int := 0;
  v_total   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM thoughts WHERE id = p_thought_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_system IS NULL OR p_system !~ '^[a-z][a-z0-9_-]*$' THEN
    RAISE EXCEPTION 'record_source_links: p_system must name the source system as one lower-case word, got %', COALESCE(p_system, 'NULL');
  END IF;
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'array' THEN
    RAISE EXCEPTION 'record_source_links: p_links must be a JSON array of {relation, target}, got %', COALESCE(jsonb_typeof(p_links), 'NULL');
  END IF;

  -- The set the source states, cleaned to what the validator admits: a
  -- malformed item, an unknown relation or a self-reference is dropped and
  -- counted, not refused whole — one bad link must not lose the other forty.
  CREATE TEMP TABLE IF NOT EXISTS _rsl_in (relation text, target text) ON COMMIT DROP;
  DELETE FROM _rsl_in WHERE true;
  INSERT INTO _rsl_in (relation, target)
  SELECT DISTINCT lower(btrim(x->>'relation')), btrim(x->>'target')
    FROM jsonb_array_elements(p_links) x
   WHERE jsonb_typeof(x) = 'object'
     AND lower(btrim(x->>'relation')) IN ('references', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of')
     AND jsonb_typeof(x->'target') = 'string'
     AND btrim(x->>'target') <> '' AND length(btrim(x->>'target')) <= 512
     AND NOT EXISTS (SELECT 1 FROM thought_sources s WHERE s.thought_id = p_thought_id AND s.system = p_system AND s.identity = btrim(x->>'target'));
  SELECT count(*) INTO v_total FROM _rsl_in;
  v_dropped := (SELECT count(*) FROM jsonb_array_elements(p_links)) - v_total;

  -- Links this system stated before and does not now: closed, kept as history.
  WITH c AS (
    UPDATE thought_facets f
       SET valid_until = now()
     WHERE f.thought_id = p_thought_id AND f.kind = 'link' AND f.valid_until IS NULL
       AND f.payload->>'system' = p_system
       AND NOT EXISTS (SELECT 1 FROM _rsl_in i WHERE i.relation = f.payload->>'relation' AND i.target = f.payload->>'target')
    RETURNING 1)
  SELECT count(*) INTO v_closed FROM c;

  -- Links stated now and not active: added. An active one is kept as it is.
  WITH a AS (
    INSERT INTO thought_facets (thought_id, kind, payload)
    SELECT p_thought_id, 'link', jsonb_build_object('relation', i.relation, 'system', p_system, 'target', i.target)
      FROM _rsl_in i
     WHERE NOT EXISTS (
       SELECT 1 FROM thought_facets f
        WHERE f.thought_id = p_thought_id AND f.kind = 'link' AND f.valid_until IS NULL
          AND f.payload->>'system' = p_system AND f.payload->>'relation' = i.relation AND f.payload->>'target' = i.target)
    RETURNING 1)
  SELECT count(*) INTO v_added FROM a;

  RETURN jsonb_build_object('ok', true, 'added', v_added, 'closed', v_closed, 'kept', v_total - v_added, 'dropped', v_dropped);
END;
$$;

COMMENT ON FUNCTION record_source_links(uuid, text, jsonb) IS
  'One thought''s links from one source system, as a SET (053): every {relation, target} stated is active after the call — added when it was not, kept when it was — and every active link of that system not stated is closed (valid_until = now(), history, never deleted). The same set twice writes nothing. A malformed item, an unknown relation or a self-reference is dropped and counted. Returns {ok, added, closed, kept, dropped}; NOT_FOUND for a thought that is not there. SMD-1867.';

-- ---------------------------------------------------------------------------
-- record_thought_entities — 016's writer with the resolution rule
--
-- The body is 016's with three changes: the two DELETEs replace only the
-- calling pass's class of rows (its own key for a `source:` pass, every
-- non-`source:` key for an extraction), and the two INSERTs take ON CONFLICT
-- clauses under which a structured row stands and an extracted one yields.
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
  INSERT INTO _rte_in (name, ntype, nname, confidence, aliases)
  SELECT DISTINCT ON (e.ntype, e.nname) e.name, e.ntype, e.nname, e.confidence, e.aliases
    FROM (
      SELECT btrim(x->>'name')                                            AS name,
             lower(btrim(x->>'type'))                                     AS ntype,
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
     AND e.ntype IN ('person', 'organization', 'project', 'tool', 'topic', 'place')
   ORDER BY e.ntype, e.nname, e.confidence DESC;

  UPDATE _rte_in i
     SET nname   = en.normalized_name,
         aliases = ARRAY(SELECT DISTINCT a FROM unnest(i.aliases || ARRAY[i.name]) a WHERE a <> en.name ORDER BY a),
         name    = en.name
    FROM ob1_entities en
   WHERE en.entity_type = i.ntype AND i.nname = ANY(en.merged_from);
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
    'pruned_entities', v_pruned);
END;
$$;

COMMENT ON FUNCTION record_thought_entities(uuid, text, jsonb, jsonb, text, uuid) IS
  'Writes one thought''s entities and relations atomically (016), with 053''s resolution rule: an extraction_key `source:<system>` is a structured pass (the source''s own project, labels, members — no model call) that keeps its own rows as a set — the same set twice writes nothing, and moves no last_seen_at; an `extract:*` pass replaces only extracted rows; and where both name one (thought, entity) or (thought, from, to, relation) the structured row stands — an extracted insert onto it does nothing, a structured insert onto an extracted row takes it over. Entities upserted by (type, normalised name); a relation naming an unlisted entity is dropped and counted; entities left unreferenced are pruned. p_content_fingerprint NULL skips the stale check. Returns {ok, stale, entities, new_entities, mentions, edges, dropped_relations, ambiguous_relations, pruned_entities}. Migrations 016, 053 / SMD-947, SMD-1867.';
