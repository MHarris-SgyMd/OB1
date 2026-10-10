-- =============================================================================
-- Migration 084: the consolidation judge's relations are stored — a
--                `relation` facet on the newer thought for a pair it judged
--                related, evolves or duplicate, with its lineage, kept as a
--                set per pair and closed when a re-judge says otherwise or
--                the other thought is deleted (SMD-1873 PR 2)
-- =============================================================================
--
-- WHY
--   Prompt 4 (SMD-1873 PR 1, #339) asks the judge for five verdicts. Only
--   "outdates" is a supersession proposal; "related", "evolves" and
--   "duplicate" relate two thoughts that both stand, and until now the pass
--   only counted them. A duplicate in particular is no proposal: three review
--   passes each found a way for a proposed duplicate to hand one writer's
--   near-copy the standing of another's thought. A relation edge records what
--   the judge saw without moving either thought's standing.
--
-- WHAT
--   * thought_facets_validate gains a `relation` branch (053's body, lifted
--     whole — CREATE OR REPLACE takes the whole body). A relation: relation
--     one of related | evolves | duplicate; target a thought id that exists
--     and is not the thought's own; judge_key the pass's key; confidence a
--     number in 0..1 or absent; origin `judged`, written here. The facet sits
--     on the NEWER thought and names the older as its target. It is written
--     standing and only ever closed: the one UPDATE admitted sets valid_until,
--     every other column as it was; a rewrite, a re-open, a move, or another
--     kind turned into a relation is refused.
--   * One active relation per pair: a partial unique index; a probe on the
--     target for "what is related to X".
--   * derivations: `relation` joins the artifact kinds (064's CHECK and
--     ob1_record_derivation's list) — an edge's lineage row names both
--     thoughts at the fingerprints the judge was sent, in the transaction
--     that writes the edge (the event-log rule for a comprehended artifact).
--   * record_thought_relation(newer, older, relation, confidence, judge_key,
--     agent, older_fp, newer_fp, recipe) — the pass's one write, a set per
--     pair: the same relation standing, by the same judge key at the same
--     confidence, is kept (its lineage moved to the texts judged now); any
--     other replaces it (the old edge closed, a new one written); a NULL
--     relation closes the pair's edge (a re-judge said unrelated or outdates,
--     or the score fell under the floor). Both thoughts are locked FOR KEY
--     SHARE before the facet, so a delete of either waits rather than
--     deadlocks. Returns {ok, action, id}.
--   * A facet keeps its kind: an UPDATE changing it is refused for every
--     kind, which closes a capture-group role's forging of a citation from a
--     link (review pass 2).
--   * Grants: none new. The caller needs INSERT on thought_facets — the
--     structure group's, held since 053, which also writes source rows,
--     links and citations: Postgres grants INSERT per table, so a role that
--     writes relations can write any facet kind — and the capture group's
--     UPDATE on it and on thoughts and its derivations writes.
--   * The other thought deleted: an AFTER DELETE trigger on thoughts closes
--     the active relations naming it. The facet's own thought deleted: the
--     foreign key cascades, and an AFTER DELETE trigger on thought_facets
--     drops the relation's lineage row.
--   * The comment on supersession_proposals no longer says "judged to
--     CONFLICT" (p4's "outdates").
--
--   ob1:relation-facet and ob1:relation-lineage-with-its-artifact — CONTRACT
--   SENTINELS, not prose (the 014 convention).
--
-- NOT HERE (SMD-2726)
--   * A text edited after its edge was judged: rebuild_derived (067) has no
--     relation arm, so the edge stands until the pass judges the pair again.
--     `consolidate.ts --list relations` flags it stale (its lineage
--     fingerprint no longer the text's). Until then rebuild_derived counts a
--     relation's lineage row among the rows it keeps — its ELSE arm, whose
--     word means a person's decision elsewhere.
--   * A reader outside db/consolidate.ts: search, fetch and a read tool.
--   * A relation whose side is later superseded, or that a former judge key
--     wrote: the candidate rule no longer pairs a superseded thought, and a
--     new key re-judges only the pairs it reaches, so such a relation stands;
--     --list relations marks it, and --status counts the other key's.
--   * Restoring a closed relation by INSERT: refused (a relation is inserted
--     standing); 042's detached citation is the shape a restore inserts whole,
--     a relation has no such shape.
--
-- Idempotent: CREATE OR REPLACE, the constraint dropped by shape and added
-- again (064's way), each trigger dropped by name first, the indexes IF NOT
-- EXISTS.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('thought_facets') IS NULL
     OR to_regclass('page_sections') IS NULL
     OR to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL
     OR to_regprocedure('record_source_links(uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 084 needs 042, 053, 061 and 064 (thought_facets, record_source_links, ob1_record_derivation, page_sections); this schema lacks them',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The `relation` facet kind — thought_facets_validate extended
--
-- 053's body verbatim but the kind-keeping check (no facet changes its kind
-- on UPDATE), the kind check, which names three kinds now, and the new branch
-- above the link's.
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
  v_conf     jsonb;
BEGIN
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.payload must be a JSON object, got %s', COALESCE(jsonb_typeof(NEW.payload), 'null'));
  END IF;
  -- 084: a facet keeps its kind. An UPDATE turning a link into a citation
  -- was admitted by the citation branch, so a role holding the capture
  -- group's UPDATE could forge a citation of any thought and have its delete
  -- refused (CITED); the same for a link or a relation made from another
  -- kind. No writer changes a kind (SMD-1873 PR 2 review pass 2).
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a facet keeps its kind: a %s is not turned into a %s; write a new facet', OLD.kind, NEW.kind);
  END IF;
  IF NEW.kind IS DISTINCT FROM 'citation' AND NEW.kind IS DISTINCT FROM 'link' AND NEW.kind IS DISTINCT FROM 'relation' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.kind %L is not a registered facet kind', NEW.kind),
      HINT = 'The registered kinds are: citation (migration 042), link (migration 053), relation (migration 084). A new kind is registered by a migration that extends thought_facets_validate.';
  END IF;

  IF NEW.kind = 'relation' THEN
    -- ob1:relation-facet (084)
    -- A relation is written once and only ever closed. The one UPDATE is the
    -- close — record_thought_relation, or the target's delete, setting
    -- valid_until with every other column as it was — and it is not re-judged:
    -- the target may be gone by then. Any other UPDATE of a relation, or one
    -- turning another kind into a relation, is refused: a rewrite would leave
    -- its lineage naming what it no longer says, and a re-open could stand an
    -- edge on a deleted thought (SMD-1873 PR 2 review pass 1).
    IF TG_OP = 'UPDATE' THEN
      -- The close sets valid_until to a time not in the future: a future one
      -- would leave the row off the one-standing index while
      -- thought_facet_active still counted it active (review pass 2).
      IF NEW.id = OLD.id AND NEW.thought_id = OLD.thought_id AND NEW.payload = OLD.payload
         AND NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by AND NEW.created_at = OLD.created_at
         AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation is written once and only closed: the one update it takes sets valid_until, not in the future, on a standing relation, every other column as it was',
        HINT = 'record_thought_relation replaces a relation (the old one closed, a new one written); write a new row rather than edit one.';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation is written standing: valid_until and superseded_by are set only by its close';
    END IF;
    v_relation := NEW.payload->>'relation';
    v_target   := NEW.payload->>'target';
    v_conf     := NEW.payload->'confidence';
    IF v_relation IS NULL OR v_relation NOT IN ('related', 'evolves', 'duplicate') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s relation must be related, evolves or duplicate, got %L', v_relation);
    END IF;
    IF jsonb_typeof(NEW.payload->'target') IS DISTINCT FROM 'string'
       OR v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s target must be a thought id, got %L', left(v_target, 60));
    END IF;
    IF v_target::uuid = NEW.thought_id THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a thought is not related to itself';
    END IF;
    IF jsonb_typeof(NEW.payload->'judge_key') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'judge_key') = '' OR length(NEW.payload->>'judge_key') > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation names the pass that judged it: judge_key, a non-empty string of at most 200 characters';
    END IF;
    IF v_conf IS NOT NULL AND jsonb_typeof(v_conf) <> 'null'
       AND (jsonb_typeof(v_conf) <> 'number' OR (v_conf)::numeric < 0 OR (v_conf)::numeric > 1) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s confidence is a number from 0 to 1, got %s', left(v_conf::text, 40));
    END IF;
    IF v_target IS DISTINCT FROM (v_target::uuid)::text THEN
      NEW.payload := NEW.payload || jsonb_build_object('target', v_target::uuid);
      v_target := (v_target::uuid)::text;
    END IF;
    -- The target must exist when the edge is written; locked FOR KEY SHARE so
    -- a delete of it waits, and then closes the edge (084's trigger on thoughts).
    PERFORM 1 FROM thoughts WHERE id = v_target::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s target %s is not a thought', v_target);
    END IF;
    -- Origin is the validator's word, not the writer's: a pass judged it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'judged');
    RETURN NEW;
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
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind. For a citation (042): a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — stores source_id lower-case, locks the source row FOR KEY SHARE; source_id may be null only in the detached shape, which keeps what it lost and is not re-pointed. For a link (053): relation one of references | child_of | blocks | blocked_by | relates_to | duplicate_of, system one lower-case word, target a non-empty identity within it, never the thought''s own (thought_sources); writes origin = structured. For a relation (084): written standing (no valid_until, no superseded_by), relation one of related | evolves | duplicate, target an existing thought (locked FOR KEY SHARE) that is not the thought itself, stored lower-case, judge_key a non-empty string of at most 200 characters, confidence a number in 0..1 or absent; writes origin = judged; afterwards only its close (valid_until set, not in the future, every other column as it was) is admitted — no rewrite, re-open or move. Since 084 no facet changes its kind on UPDATE. A pure close of a link passes unjudged. Migrations 042, 053, 084.';

-- One active relation per pair (the newer thought, the older target): the
-- set is the index's, not a writer's discipline. Closed rows are history.
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_relation_active_uniq
  ON thought_facets (thought_id, (payload->>'target'))
  WHERE kind = 'relation' AND valid_until IS NULL;

-- "What is related to X" from X's side, and the target's delete, probe the target.
CREATE INDEX IF NOT EXISTS thought_facets_relation_target_idx
  ON thought_facets ((payload->>'target'))
  WHERE kind = 'relation';

-- ---------------------------------------------------------------------------
-- 2. derivations: `relation` joins the artifact kinds
--
-- 064's drop-by-shape, add NOT VALID, then VALIDATE; ob1_record_derivation is
-- 064's body with one more value in the kind list and its message.
-- ---------------------------------------------------------------------------
DO $ck$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'derivations'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE 'CHECK ((artifact_kind = ANY (ARRAY[%'
  LOOP
    EXECUTE format('ALTER TABLE derivations DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$ck$;
ALTER TABLE derivations ADD CONSTRAINT derivations_artifact_kind_check
  CHECK (artifact_kind IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section', 'relation')) NOT VALID;
ALTER TABLE derivations VALIDATE CONSTRAINT derivations_artifact_kind_check;

CREATE OR REPLACE FUNCTION ob1_record_derivation(
  p_kind         text,
  p_artifact     uuid,
  p_inputs       uuid[],
  p_fingerprints text[],
  p_produced_by  text,
  p_recipe       jsonb,
  p_agent        uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- The write path is the choke point, or an untrusted-input hole (025):
  -- every refusal is a RAISE, since a producer that cannot record its lineage
  -- must not commit its artifact either — the two are one transaction.
  IF p_kind IS NULL OR p_kind NOT IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section', 'relation') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: artifact_kind must be chunks, entities, proposal, vector, metadata, section or relation, got %L', p_kind),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_artifact IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_record_derivation: artifact_id is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_inputs IS NULL OR cardinality(p_inputs) < 1 OR array_position(p_inputs, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_record_derivation: input_ids must name at least one input and no NULL', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_fingerprints IS NULL OR cardinality(p_fingerprints) <> cardinality(p_inputs) OR array_position(p_fingerprints, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: input_fingerprints must be one non-NULL fingerprint per input (%s inputs, %s fingerprints)',
                       cardinality(p_inputs), COALESCE(cardinality(p_fingerprints), 0)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_produced_by IS NULL OR p_produced_by = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_record_derivation: produced_by must name the pass', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_recipe IS NULL OR jsonb_typeof(p_recipe) <> 'object' OR COALESCE(jsonb_typeof(p_recipe->'deterministic'), '') <> 'boolean' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'ob1_record_derivation: recipe must be a JSON object carrying a boolean "deterministic"',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- ob1:rerun-clears-the-mark — a CONTRACT SENTINEL, not prose (the 014
  -- convention); db/test-schema.ts reads it. 063: the producer's write is the
  -- answer to a rebuild's request, so the upsert clears stale_since and
  -- stale_reason (SMD-1732).
  INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, canonical_agent_id)
  VALUES (p_kind, p_artifact, p_inputs, p_fingerprints, p_produced_by, p_recipe, p_agent)
  ON CONFLICT (artifact_kind, artifact_id, produced_by) DO UPDATE
    SET input_ids          = EXCLUDED.input_ids,
        input_fingerprints = EXCLUDED.input_fingerprints,
        recipe             = EXCLUDED.recipe,
        produced_at        = now(),
        canonical_agent_id = EXCLUDED.canonical_agent_id,
        stale_since        = NULL,
        stale_reason       = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid) IS
  'Records one derived artifact''s lineage in `derivations`, upserting on (artifact_kind, artifact_id, produced_by) and moving produced_at: the inputs and their fingerprints (parallel, no NULL), the pass, the recipe (a JSON object with a boolean `deterministic`), the agent. Refuses a bad shape with a RAISE — a producer that cannot record its lineage must not commit its artifact either. Seven kinds since 084: chunks, entities, proposal, vector, metadata (061), section (064, a page section a machine wrote) and relation (084, a judged relation between two thoughts); the upsert clears 063''s mark (ob1:rerun-clears-the-mark). Migrations 061, 063, 064, 084 / SMD-1731, SMD-1732, SMD-1812, SMD-1873.';

COMMENT ON TABLE derivations IS
  'Lineage for every derived artifact (SMD-1731, Phase 1b of SMD-1729): one row per artifact per producing pass, written in the transaction that writes the artifact. artifact_kind names the tier — chunks (a thought''s window set), entities (a thought''s extraction under one extraction_key), proposal (one supersession proposal), vector (a thought''s embedding), metadata (a thought''s capture-time tags), since 064 section (a page section a machine wrote — SMD-1812), and since 084 relation (a judged relation between two thoughts, a `relation` facet — SMD-1873); artifact_id is the thought''s id for the four keyed by a thought, the proposal''s id for a proposal, the section''s id for a section, the facet''s id for a relation. input_ids and input_fingerprints are parallel arrays naming what the artifact was computed from and the text it was computed from — a row whose fingerprints no longer match its inputs'' is stale, which is a read (preflight counts them), not a trigger. produced_by is the pass; recipe is a JSON object carrying a boolean `deterministic` (what rebuild_derived reads, migration 063: a re-derivation the database owns against a re-run a worker owns) and the producer''s own record — model, prompt_version, prompt_hash, window parameters; `legacy: true` on a row 061 backfilled, `declared: false` where a caller sent no recipe. stale_since and stale_reason (063) carry a rebuild''s request for a re-run until the producer writes the row again. No foreign key: thoughts_drop_derivations, supersession_proposals_drop_derivation, page_sections_drop_derivations and thought_facets_drop_relation_derivation drop the rows a deleted thought, proposal, section or relation keyed; rebuild_derived deletes a row whose artifact is gone while its thought stands. Migrations 061, 063, 064, 084 / SMD-1731, SMD-1732, SMD-1812, SMD-1873.';

-- ---------------------------------------------------------------------------
-- 3. record_thought_relation — the pass's one write, a set per pair
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_relation(
  p_newer      uuid,
  p_older      uuid,
  p_relation   text,
  p_confidence numeric,
  p_judge_key  text,
  p_agent      uuid,
  p_older_fp   text,
  p_newer_fp   text,
  p_recipe     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_active    uuid;
  v_relation  text;
  v_key       text;
  v_conf      numeric;
  v_id        uuid;
BEGIN
  IF p_newer IS NULL OR p_older IS NULL OR p_newer = p_older THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_relation: two different thoughts are required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_relation IS NOT NULL AND p_relation NOT IN ('related', 'evolves', 'duplicate') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_relation: relation must be related, evolves, duplicate or NULL (close), got %L', p_relation),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    -- The validator's bound, refused here as a parameter error: a check
    -- violation would read to the pass as a side deleted mid-write (review pass 2).
    RAISE EXCEPTION USING MESSAGE = 'record_thought_relation: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer per pair at a time: two passes judging the pair at once would
  -- otherwise both find nothing active and the second insert hit the index.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:relation:' || p_newer::text || ':' || p_older::text, 0));
  -- Both thoughts locked FOR KEY SHARE before the facet row: a delete of either
  -- then waits here, rather than holding its thought while its trigger (the
  -- close, or the cascade) waits on the facet this call locked — a deadlock
  -- Postgres would break by aborting one side, the user's delete perhaps
  -- (review pass 1). A thought already gone answers none: nothing to write.
  PERFORM 1 FROM thoughts WHERE id IN (p_newer, p_older) ORDER BY id FOR KEY SHARE;
  IF (SELECT count(*) FROM thoughts WHERE id IN (p_newer, p_older)) < 2 THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;

  SELECT f.id, f.payload->>'relation', f.payload->>'judge_key', (f.payload->>'confidence')::numeric INTO v_active, v_relation, v_key, v_conf
    FROM thought_facets f
   WHERE f.thought_id = p_newer AND f.kind = 'relation' AND f.valid_until IS NULL
     AND f.payload->>'target' = p_older::text
   FOR UPDATE;

  IF p_relation IS NULL THEN
    IF v_active IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'action', 'none');
    END IF;
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
    RETURN jsonb_build_object('ok', true, 'action', 'closed', 'id', v_active);
  END IF;

  IF v_active IS NOT NULL AND v_relation = p_relation AND v_key = p_judge_key
     AND v_conf IS NOT DISTINCT FROM round(p_confidence, 2) THEN
    -- Kept: the same word, by the same pass, at the same confidence — the
    -- edge stands, its lineage moved to the texts judged now. Anything else
    -- is a replace, since a relation is never edited (the validator): its
    -- payload says who judged it and how sure, and its lineage is that judge's
    -- (review pass 1: a kept edge under another key read stale).
    PERFORM ob1_record_derivation('relation', v_active, ARRAY[p_older, p_newer], ARRAY[p_older_fp, p_newer_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', false, 'declared', false)), p_agent);
    RETURN jsonb_build_object('ok', true, 'action', 'kept', 'id', v_active);
  END IF;
  IF v_active IS NOT NULL THEN
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
  END IF;

  INSERT INTO thought_facets (thought_id, kind, payload)
  VALUES (p_newer, 'relation',
          jsonb_build_object('relation', p_relation, 'target', p_older, 'judge_key', p_judge_key)
          || CASE WHEN p_confidence IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('confidence', round(p_confidence, 2)) END)
  RETURNING id INTO v_id;
  -- ob1:relation-lineage-with-its-artifact — a CONTRACT SENTINEL, not prose:
  -- the edge and its lineage are one transaction (061's rule).
  PERFORM ob1_record_derivation('relation', v_id, ARRAY[p_older, p_newer], ARRAY[p_older_fp, p_newer_fp], p_judge_key,
                                COALESCE(p_recipe, jsonb_build_object('deterministic', false, 'declared', false)), p_agent);
  RETURN jsonb_build_object('ok', true, 'action', CASE WHEN v_active IS NULL THEN 'added' ELSE 'replaced' END, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb) IS
  'The consolidation pass''s write of one judged relation (SMD-1873 PR 2): a `relation` facet on the newer thought naming the older as target, a set per pair under an advisory lock on the pair, both thoughts locked FOR KEY SHARE first. The same relation already standing, by the same judge key at the same confidence, is kept (its lineage row moved to the fingerprints judged now); anything else replaces it (the old edge closed with valid_until, a new one inserted — a relation is never edited); a NULL relation closes the pair''s standing edge, or answers none; a thought gone answers none. Each new edge''s lineage row (artifact_kind relation, inputs older and newer at the fingerprints the judge was sent, produced_by the judge key) is written in the same transaction (ob1:relation-lineage-with-its-artifact). Returns {ok, action: added | kept | replaced | closed | none, id}. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group). Migration 084 / SMD-1873.';

-- ---------------------------------------------------------------------------
-- 4. Deletes: the other thought's closes the edge; the facet's own drops its lineage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_close_relations_to_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE thought_facets SET valid_until = now()
   WHERE kind = 'relation' AND valid_until IS NULL AND payload->>'target' = OLD.id::text;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_close_relations_to_deleted() IS
  'AFTER DELETE on thoughts (thoughts_close_relations, 084): closes (valid_until) the active `relation` facets whose target was the deleted thought — a payload id has no foreign key, and an edge to nothing is not current. A close is an UPDATE, which the capture group holds; the facet stays as history. Migration 084 / SMD-1873.';

DROP TRIGGER IF EXISTS thoughts_close_relations ON thoughts;
CREATE TRIGGER thoughts_close_relations
  AFTER DELETE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ob1_close_relations_to_deleted();

CREATE OR REPLACE FUNCTION ob1_drop_relation_derivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM derivations WHERE artifact_kind = 'relation' AND artifact_id = OLD.id;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_drop_relation_derivation() IS
  'AFTER DELETE on thought_facets for a relation (thought_facets_drop_relation_derivation, 084): drops the `derivations` row the relation keyed. A relation goes with its newer thought''s cascade, and this fires under it, as 064''s does for a page section. Migration 084 / SMD-1873.';

DROP TRIGGER IF EXISTS thought_facets_drop_relation_derivation ON thought_facets;
CREATE TRIGGER thought_facets_drop_relation_derivation
  AFTER DELETE ON thought_facets
  FOR EACH ROW WHEN (OLD.kind = 'relation') EXECUTE FUNCTION ob1_drop_relation_derivation();

-- 042's comments named one kind; the catalog's copy follows the three.
COMMENT ON COLUMN thought_facets.payload IS
  'Shaped by kind. citation: text (non-empty), stance (stated | retrieved | inferred), source_id (an existing thought, not thought_id itself, stored lower-case); after the source is deleted, source_id null with source_deleted_id and source_deleted_at set by the guard — a shape a restore may insert whole, and that is never re-pointed at a new source. link (053): relation, system, target (an identity in the system), origin structured. relation (084): relation (related | evolves | duplicate), target (the older thought''s id), judge_key, confidence, origin judged; inserted standing only, so a restore re-inserts a closed relation as standing or not at all.';
COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, three kinds registered: citation (042), payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id; link (053), payload {relation, system, target, origin} — a source system''s structured link from the thought to another identity in it; relation (084), payload {relation, target, judge_key, confidence, origin} — the consolidation judge''s related, evolves or duplicate verdict on the thought (the newer) and the target thought (the older), written once — by record_thought_relation, the consolidation pass''s door, though origin `judged` marks the kind and any role holding INSERT on the table (the structure group) can write one — and only ever closed. Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while valid_until is NULL or future and no facet that still exists supersedes it (thought_facet_active); only active citations make thoughts_guard_citation_sources refuse a delete of their source. Migrations 042, 053, 084 / SMD-1712, SMD-1867, SMD-1873.';
COMMENT ON COLUMN thought_facets.kind IS
  'The registered kind: citation (042), link (053) or relation (084). A later migration registers another by extending thought_facets_validate, not by a registry table.';

-- ---------------------------------------------------------------------------
-- 5. supersession_proposals: p4's word on the table
-- ---------------------------------------------------------------------------
COMMENT ON TABLE supersession_proposals IS
  'One row per pair of thoughts a consolidation pass judged one to make the other out of date — prompt 4''s "outdates" (SMD-1873; "conflict" under prompts 1 to 3) — with the judge''s verdict on which is current. A pair the judge called related, evolves or duplicate is a `relation` facet (084), not a row here. Written by db/consolidate.ts; thoughts.supersedes is written only when a reviewer accepts a row through review_supersession_proposal. A pair is recorded once whatever its later status, so a pair a person rejected is never proposed again; a pair the pass itself settled (review_note beginning ''settled by the pass:'', 067) is judged again when a text moves under it, through the stale status (063). Migrations 029, 063, 067, 084 / SMD-1294, SMD-1732, SMD-2297, SMD-1873.';
