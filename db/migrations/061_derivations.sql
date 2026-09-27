-- =============================================================================
-- Migration 061: lineage for every derived artifact, with its recipe — one
--                `derivations` table every producer writes in the transaction
--                that writes its artifact: the chunk set, the extraction, the
--                proposal, the vector, the capture-time tags; the input's
--                fingerprint beside the recipe; the artifacts standing today
--                backfilled and marked legacy (SMD-1731; Phase 1b of SMD-1729)
-- =============================================================================
--
-- WHY
--   docs/event-log-as-truth.md (SMD-1997) makes everything off the thought row
--   a projection with a recorded key: "a projection's key names everything its
--   value is a function of — the input's fingerprint and the recipe — or the
--   rebuild cannot be incremental." Its table of projections says what each
--   records today: the vector by (content_fingerprint, embedding_model), the
--   whole key; the graph by extraction_key alone — half a key, the input's
--   fingerprint CHECKED by record_thought_entities and never stored; the chunk
--   rows by nothing but the parent's label (022); the capture-time tags by
--   nothing at all; the proposals by both fingerprints and the judge's key, the
--   shape to copy. SMD-1729's rule for the program: an event and its lineage
--   row commit together — a derived row without lineage is the Graphiti bug —
--   and SMD-1732's rebuild_derived (not built; this table is what it will walk),
--   SMD-1734's trust propagation and SMD-1723's forget all read the same rows.
--   The derivation records exist today as JSONL side files the two workers
--   append (`--dump` in db/extract-entities.ts and db/consolidate.ts), "until a
--   lineage table holds it". This file is that table.
--
-- WHAT
--   1. THE TABLE. `derivations`: one row per derived artifact per producing
--      pass — artifact_kind in (chunks, entities, proposal, vector, metadata),
--      artifact_id (the thought's id for the four keyed by a thought, the
--      proposal's for a proposal), input_ids and input_fingerprints (parallel
--      arrays, no NULL element: the thought's fingerprint COLUMN where 003's
--      contract keeps it — a writer that moves the text owns the column, as
--      every function here does — and the text hashed again where the column
--      is NULL, 018's state and a raw row; a raw writer that moved the text
--      and left the column is trusted as 003 and 060's snapshot trust it,
--      and the census inherits that trust (run-it, third review pass)),
--      produced_by (the pass: an extraction_key, a judge_key,
--      'capture' / 'edit' for the windows, 'metadata' for the tags, the vector
--      trigger's name), recipe (a JSON object carrying `deterministic`, a
--      boolean the CHECK requires — what SMD-1732 will read to tell a re-run
--      from a re-derivation; the rest is the producer's: model, prompt_version,
--      prompt_hash, the window parameters, `legacy: true` on a backfilled row,
--      `declared: false` where a caller sent none), produced_at, and 010's
--      canonical_agent_id as 016 and 029 record it. UNIQUE (artifact_kind,
--      artifact_id, produced_by): the granularity is the unit each producer
--      REPLACES — a thought's chunk SET, a thought's extraction under one key,
--      one proposal, one vector, one set of tags — so a rewrite upserts one
--      row and moves produced_at, and a walk from an input is one GIN probe on
--      input_ids per node (026's bound applies to the walk, not here); the
--      UNIQUE index serves the artifact's own rows. NO
--      FOREIGN KEY to thoughts (the kind is polymorphic; 060's snapshot has
--      none either): two AFTER DELETE row triggers drop the rows keyed by a
--      deleted thought (thoughts_drop_derivations) and by a deleted proposal
--      (supersession_proposals_drop_derivation), as the artifacts themselves
--      go by 007's, 016's and 029's cascades. Nothing that survives a delete is
--      lost with them — the snapshot row (keyed by fingerprint), a derived
--      thought (025's derived_from) and a shared entity (pruned by 016's rule)
--      are not rows of this table keyed by the thought.
--   2. THE WRITER. ob1_record_derivation(kind, artifact, inputs, fingerprints,
--      produced_by, recipe, agent): validates and upserts one row. Refuses an
--      unknown kind, arrays of unequal length or with a NULL fingerprint, a
--      recipe without a boolean `deterministic` — the write path is the choke
--      point, or an untrusted-input hole (025's words). SECURITY INVOKER, as
--      every writer: the caller's role needs the table (db/config.mjs, the
--      capture group). ob1_actor_agent_id() reads the agent the write set in
--      ob1.actor (008/010), for the rows the write functions record.
--   3. THE PRODUCERS, each recording in the transaction that writes its rows:
--      - THE VECTOR: a row trigger, thoughts_record_vector_lineage, AFTER
--        INSERT OR UPDATE on thoughts — 060's snapshot trigger's shape: no
--        column list (the projector's UPDATE names every column on every
--        event, and a probe that drops the label column would take a
--        column-scoped trigger with it — 2BP01), nothing under
--        ob1.projecting_replay (a fold is not a live write; the fold copies
--        this table beside the snapshot — SMD-2117 owns the copy), nothing when
--        the vector and its label stand — a text edit alone leaves the row
--        naming the text the vector came from, stale by design, which is what
--        the census reads. A vector written records
--        {deterministic: true, model, dims} for the row at its fingerprint —
--        the whole recipe the ADR's table names for it; a vector cleared drops
--        the row. Every writer is covered, a raw INSERT and a vendored server's
--        3-argument capture included, which is why the vector's row is the
--        trigger's and not the envelope's.
--      - THE WINDOWS: upsert_thought's 4-argument form (013's body) and
--        update_thought (060's body) record the chunk set they write, beside
--        the DELETE ... INSERT that replaces it: the caller's recipe from the
--        lineage envelope (p_payload.lineage.chunks / p_lineage.chunks: the
--        window tokens and overlap, the threshold, the estimator, the blurb
--        model and its prompt's hash, `deterministic` false when 013's blurbs
--        ran), or the label alone marked `declared: false`; the set's size
--        beside it; no windows, no row. The 3-argument form's 022 rule — a
--        label that no longer vouches for the windows deletes them — deletes
--        their row with them.
--      - THE TAGS: upsert_thought's 3-argument form and update_thought record
--        the capture-time metadata WHEN the envelope declares its recipe
--        (p_payload.lineage.metadata / p_lineage.metadata: the model, the
--        prompt's version and hash, the temperature) and the write moved the
--        metadata — a fresh capture, a re-capture or an edit whose event
--        carries a metadata diff. A caller that sends tags of its own sends no
--        recipe and gets no row: a client's tags are not a derivation. On the
--        board sync the extractor's tags and Linear's facets ride one patch,
--        so a facet's move re-records the row: produced_at is the last write
--        that carried the tags with a recipe, not the tagging time (cold read,
--        second review pass) — the recipe's model and prompt are what a
--        rebuild reads. The 2-argument form is not redefined — it is a body of its own (060), and
--        no in-tree caller of it runs the extractor; a PostgREST caller by name
--        gets no row, said here.
--      - THE EXTRACTION: record_thought_entities gains p_recipe (a 7th
--        argument, defaulted; the 6-argument form is dropped first, since a
--        defaulted parameter beside the old arity makes every 6-argument call
--        "function is not unique") and records the pass under its own
--        replacement rule (053/056): an extraction's row replaces every
--        extracted row's, a structured `source:<system>` pass's replaces its
--        own key's. THE FINGERPRINT IT STORES IS THE ONE IT CHECKED —
--        p_content_fingerprint, or the row's hashed again — the half of the
--        graph's key 016 left out. No rows standing under the key after the
--        write (053's take pruning an old holder with an empty set; an
--        extraction the gate refused whole) is no artifact and drops the row;
--        a structured pass that wrote and removed nothing leaves its row as it
--        leaves last_seen_at. Without p_recipe the row carries the key alone,
--        `declared: false`.
--      - THE PROPOSAL: record_supersession_proposal gains p_recipe (an 11th
--        argument; the 10-argument form dropped first, the same reason) and
--        records a proposal it inserted — both thoughts at the fingerprints
--        the judge saw, exactly as the row takes them — under the judge's key.
--        A pair already judged inserts nothing and records nothing.
--   4. THE BACKFILL. Four INSERT ... SELECT statements, one per kind that has
--      rows to describe, every recipe carrying `legacy: true` so the gap is
--      visible where it stands: every proposal (both fingerprints from its
--      columns, the judge key parsed into model and prompt version where it
--      has 029's shape), every (thought, extraction_key) pair over the
--      mentions and edges (at the thought's CURRENT fingerprint — the rows
--      vouch for nothing older — and the pass's last write), every chunk set
--      (the parent's label), every vector (label and width, as the trigger
--      would). The tags are NOT backfilled: nothing on a row says the
--      extractor tagged it (SMD-1254's extractor_model key was never built),
--      and a row written for a client's tags would be a lie; preflight counts
--      the thoughts tagged before this file as coverage, not as a failure.
--      ON CONFLICT DO NOTHING on every statement: a re-apply moves no row.
--
-- SAFETY
--   Additive: thoughts is untouched (no column, no index; one row trigger
--   added, none redefined); one table with two indexes; two functions and
--   three trigger functions added. Five bodies redefined — the 3- and
--   4-argument upsert_thought and update_thought under 060's and 013's
--   bodies carried verbatim plus the lineage lines; record_thought_entities
--   and record_supersession_proposal under 056's and 029's — of which three
--   change arity: update_thought's 10-argument form is dropped for the
--   11-argument one with its ACL carried as 032, 046 and 060 did;
--   record_thought_entities' 6-argument and record_supersession_proposal's
--   10-argument forms are dropped for the 7- and 11-argument ones with no ACL
--   carried — functions are PUBLIC EXECUTE by default and `--grant` grants
--   tables, not functions (db/README.md, "Grants for a capturing role"), so a
--   brain that revoked EXECUTE on either by hand re-grants it by hand. Every
--   positional caller in the tree sends the old arity or fewer and resolves
--   through the defaults; the named-argument calls — 032's and 036's
--   update_thought(…, p_actor => …, p_provenance => …) in the delete path,
--   the PostgREST store's rpc — name arguments every form keeps, and the new
--   one defaults (cold read, third review pass). No return shape
--   changes. The backfill is four reads of the artifact tables (ACCESS SHARE)
--   into one table, the length of a read of them; measured on a copy of the
--   dogfood brain in the record (changes/smd-1731.md). A brain that reverts
--   to 060's bodies (`bun migrate.ts --reapply` runs every file in order, so
--   this one puts its bodies back last) writes its artifacts and no lineage
--   until this file is re-applied; preflight's `lineage` check says so by
--   name and fails on the rows without one. MINOR under FORK.md's version
--   rules: a table and functions added, none renamed. A role granted before
--   this file lacks every privilege on `derivations`: run `migrate.ts --grant`
--   for it again before the server writes (db/config.mjs's capture group
--   carries the row; preflight's write privileges check refuses such a role,
--   naming the table) — the vector trigger and the write functions run as the
--   caller on every capture and edit.
--
-- Prerequisites
--   013 (thought_chunks.context and the 4-argument upsert_thought's context arm), 029 (supersession_proposals),
--   056 (record_thought_entities' body and entity_type_gate), 060
--   (ob1_refresh_thought_vector, ob1_embedding_snapshot, the write functions
--   this file carries). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape): the bodies below are plpgsql and would fail at their
-- first call with a bare "does not exist" otherwise. Every probe names an
-- object that stands on a brain at this file too (the 6- and 10-argument
-- forms dropped below are not probed), so a --reapply passes.
DO $qc$
BEGIN
  -- 007 created the 4-argument form; 013 gave it the context arm this file
  -- carries, and the column that arm writes is the probe (a schema at 007
  -- has the function and not the column — run-it, the build).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thought_chunks' AND column_name = 'context') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 061 needs 013 (thought_chunks.context, the 4-argument upsert_thought''s context arm); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 061 needs 029 (supersession_proposals); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('entity_type_gate(text, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 061 needs 056 (entity_type_gate, record_thought_entities'' body); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_refresh_thought_vector(uuid, vector, text)') IS NULL
     OR to_regclass('ob1_embedding_snapshot') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 061 needs 060 (ob1_refresh_thought_vector, ob1_embedding_snapshot); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derivations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_kind      text        NOT NULL CHECK (artifact_kind IN ('chunks', 'entities', 'proposal', 'vector', 'metadata')),
  artifact_id        uuid        NOT NULL,
  input_ids          uuid[]      NOT NULL CHECK (cardinality(input_ids) >= 1),
  input_fingerprints text[]      NOT NULL CHECK (cardinality(input_fingerprints) = cardinality(input_ids)
                                                 AND array_position(input_fingerprints, NULL) IS NULL),
  produced_by        text        NOT NULL CHECK (produced_by <> ''),
  -- COALESCE: a missing key is NULL, and a CHECK that answers NULL passes (the smoke's first refusal, run-it).
  recipe             jsonb       NOT NULL CHECK (jsonb_typeof(recipe) = 'object' AND COALESCE(jsonb_typeof(recipe->'deterministic'), '') = 'boolean'),
  produced_at        timestamptz NOT NULL DEFAULT now(),
  canonical_agent_id uuid,
  UNIQUE (artifact_kind, artifact_id, produced_by)
);

-- The forward walk: every artifact an input fed, one probe per node. The
-- artifact's own rows — what a delete drops, what preflight joins on — are
-- served by the UNIQUE index, whose first two columns they are (a second
-- btree on the prefix cost 11% of the table and a write per upsert for
-- nothing: run-it, first review pass).
CREATE INDEX IF NOT EXISTS idx_derivations_inputs ON derivations USING GIN (input_ids);

COMMENT ON TABLE derivations IS
  'Lineage for every derived artifact (SMD-1731, Phase 1b of SMD-1729): one row per artifact per producing pass, written in the transaction that writes the artifact. artifact_kind names the tier — chunks (a thought''s window set), entities (a thought''s extraction under one extraction_key), proposal (one supersession proposal), vector (a thought''s embedding), metadata (a thought''s capture-time tags); artifact_id is the thought''s id for the four keyed by a thought and the proposal''s id for a proposal. input_ids and input_fingerprints are parallel arrays naming what the artifact was computed from and the text it was computed from — a row whose fingerprints no longer match its inputs'' is stale, which is a read (preflight counts them), not a trigger. produced_by is the pass; recipe is a JSON object carrying a boolean `deterministic` (what SMD-1732''s rebuild will read) and the producer''s own record — model, prompt_version, prompt_hash, window parameters; `legacy: true` on a row 061 backfilled, `declared: false` where a caller sent no recipe. No foreign key: thoughts_drop_derivations and supersession_proposals_drop_derivation drop the rows a deleted thought or proposal keyed. A `metadata` row outlives tags an edit strips — it reads as stale, and nothing drops it (a read, not a trigger). Migration 061 / SMD-1731.';
COMMENT ON COLUMN derivations.input_fingerprints IS
  '003''s fingerprint of each input''s text as the producer read it (parallel to input_ids; no NULL element — a row in 018''s state is hashed again). Differing from the input''s current fingerprint means the artifact is stale (migration 061 / SMD-1731).';
COMMENT ON COLUMN derivations.recipe IS
  'What re-runs the derivation: a JSON object with `deterministic` (boolean, required — chunks without blurbs, a vector at a fixed model and a structured pass are true; a model''s answer is false) and the producer''s own keys — model, prompt_version, prompt_hash ("sha256:<hex>" of the prompt text), params, key; `legacy: true` on a backfilled row, `declared: false` on one whose caller sent no recipe (migration 061 / SMD-1731).';

-- ---------------------------------------------------------------------------
-- 2. The writer, and the agent a write names.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_actor_agent_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_actor text := NULLIF(current_setting('ob1.actor', true), '');
  v_id    text;
BEGIN
  -- 008's actor as the write functions set it (an object, or a bare name from
  -- an older caller); 010's agent_id from it when it has the canonical
  -- hyphenated form — a malformed id must not break the write (055's rule).
  IF v_actor IS NULL OR v_actor !~ '^\s*\{' THEN
    RETURN NULL;
  END IF;
  v_id := (v_actor::jsonb)->>'agent_id';
  IF v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v_id::uuid;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_actor_agent_id() IS
  'The canonical agent id (010) of the actor the current write set in ob1.actor (008), or NULL — what the write functions record on a lineage row they write. Migration 061 / SMD-1731.';

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
  IF p_kind IS NULL OR p_kind NOT IN ('chunks', 'entities', 'proposal', 'vector', 'metadata') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: artifact_kind must be chunks, entities, proposal, vector or metadata, got %L', p_kind),
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
  INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, canonical_agent_id)
  VALUES (p_kind, p_artifact, p_inputs, p_fingerprints, p_produced_by, p_recipe, p_agent)
  ON CONFLICT (artifact_kind, artifact_id, produced_by) DO UPDATE
    SET input_ids          = EXCLUDED.input_ids,
        input_fingerprints = EXCLUDED.input_fingerprints,
        recipe             = EXCLUDED.recipe,
        produced_at        = now(),
        canonical_agent_id = EXCLUDED.canonical_agent_id
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid) IS
  'Records one derived artifact''s lineage in `derivations`, upserting on (artifact_kind, artifact_id, produced_by) and moving produced_at: the inputs and their fingerprints (parallel, no NULL), the pass, the recipe (a JSON object with a boolean `deterministic`), the agent. Refuses a bad shape with invalid_parameter_value — a producer that cannot record its lineage does not commit its artifact. Called by the write functions, record_thought_entities, record_supersession_proposal and the vector trigger, in the artifact''s own transaction. Migration 061 / SMD-1731.';

-- ---------------------------------------------------------------------------
-- 3. The vector's row: a trigger on the row store, 060's snapshot trigger's
--    shape — every writer covered, a raw one included.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_record_vector_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_fp text;
BEGIN
  -- A fold's write is not a live derivation: the row it lands carries the
  -- lineage the copied table already holds (SMD-2117 copies both).
  IF COALESCE(current_setting('ob1.projecting_replay', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  -- Every UPDATE reaches here (the trigger names no column — 060's reason:
  -- a probe that drops one would take the trigger with it, 2BP01, and the
  -- projector's UPDATE names every column on every event). The row is
  -- re-recorded when the VECTOR or its label moved, and never when the text
  -- alone did: a raw content edit that leaves the vector standing must leave
  -- its row naming the text the vector was computed from, or the census that
  -- compares the two could never see a stale vector (run-it, first review
  -- pass: the first shape re-recorded on a text move and laundered it). The
  -- vectors compared through the real[] cast, as 060 compares them: a session
  -- with pgvector off its search_path has no `=` for the type by name.
  IF TG_OP = 'UPDATE'
     AND NEW.embedding_model IS NOT DISTINCT FROM OLD.embedding_model THEN
    IF NEW.embedding::real[] IS NOT DISTINCT FROM OLD.embedding::real[] THEN
      RETURN NULL;
    END IF;
  END IF;
  IF NEW.embedding IS NULL THEN
    -- A vector cleared (an edit with content and no vector, 021's rule) is no
    -- artifact: its row goes.
    DELETE FROM derivations WHERE artifact_kind = 'vector' AND artifact_id = NEW.id;
    RETURN NULL;
  END IF;
  -- The fingerprint the row names: the text the VECTOR was computed from. A
  -- vector that moved was computed from the row's current text; a label that
  -- moved alone (021's and 030's backfills, a hand relabel) leaves the vector
  -- as it was, so the row keeps the fingerprint it had — a stale row stays
  -- stale (run-it, second review pass: a relabel re-hashed the current text
  -- and laundered it), and a row that had none is at the current text.
  IF TG_OP = 'UPDATE' AND NEW.embedding::real[] IS NOT DISTINCT FROM OLD.embedding::real[] THEN
    SELECT d.input_fingerprints[1] INTO v_fp FROM derivations d
     WHERE d.artifact_kind = 'vector' AND d.artifact_id = NEW.id AND d.produced_by = 'thoughts_record_vector_lineage';
  END IF;
  v_fp := COALESCE(v_fp, NEW.content_fingerprint, content_fingerprint_of(NEW.content));
  -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not
  -- prose (the 014 convention); preflight's `lineage` reads it. The whole
  -- recipe the decision's table names for a vector: the model and the width.
  -- The row's key as written, or the text hashed again (018's state, a raw
  -- row): a lineage row always names a fingerprint.
  PERFORM ob1_record_derivation('vector', NEW.id, ARRAY[NEW.id],
                                ARRAY[v_fp],
                                'thoughts_record_vector_lineage',
                                jsonb_build_object('deterministic', true, 'dims', array_length(NEW.embedding::real[], 1))
                                  || jsonb_strip_nulls(jsonb_build_object('model', NEW.embedding_model)),
                                ob1_actor_agent_id());
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_record_vector_lineage() IS
  'AFTER INSERT OR UPDATE on thoughts (thoughts_record_vector_lineage, 061): records the row''s vector in `derivations` (artifact_kind vector, {deterministic: true, model, dims}, the row at its fingerprint) when the vector or its label moved — a text edit that leaves the vector standing leaves the row naming the text the vector came from, stale as the census reads it; drops the row when the vector is cleared; nothing under ob1.projecting_replay. Migration 061 / SMD-1731.';

DROP TRIGGER IF EXISTS thoughts_record_vector_lineage ON thoughts;
CREATE TRIGGER thoughts_record_vector_lineage
  AFTER INSERT OR UPDATE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ob1_record_vector_lineage();

-- ---------------------------------------------------------------------------
-- 4. What a delete drops: the rows a thought or a proposal keyed. No foreign
--    key carries this (the kind is polymorphic), so two row triggers do, as
--    007's, 016's and 029's cascades drop the artifacts themselves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_drop_thought_derivations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM derivations
   WHERE artifact_kind IN ('chunks', 'entities', 'vector', 'metadata') AND artifact_id = OLD.id;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_drop_thought_derivations() IS
  'AFTER DELETE on thoughts (thoughts_drop_derivations, 061): drops the `derivations` rows the thought keyed — its chunk set''s, its extractions'', its vector''s, its tags''. A proposal naming it goes by 029''s cascade and takes its own row through supersession_proposals_drop_derivation. Fires under a replay too: a replayed tombstone drops the rows a fold copied, which a fold that copies this table and then replays the log in order expects (SMD-2117). Migration 061 / SMD-1731.';

DROP TRIGGER IF EXISTS thoughts_drop_derivations ON thoughts;
CREATE TRIGGER thoughts_drop_derivations
  AFTER DELETE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ob1_drop_thought_derivations();

CREATE OR REPLACE FUNCTION ob1_drop_proposal_derivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM derivations WHERE artifact_kind = 'proposal' AND artifact_id = OLD.id;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_drop_proposal_derivation() IS
  'AFTER DELETE on supersession_proposals (supersession_proposals_drop_derivation, 061): drops the proposal''s `derivations` row. Migration 061 / SMD-1731.';

DROP TRIGGER IF EXISTS supersession_proposals_drop_derivation ON supersession_proposals;
CREATE TRIGGER supersession_proposals_drop_derivation
  AFTER DELETE ON supersession_proposals
  FOR EACH ROW EXECUTE FUNCTION ob1_drop_proposal_derivation();

-- ---------------------------------------------------------------------------
-- 5. upsert_thought, the 3-argument form — 060's body carried verbatim, plus
--    the tags' lineage row and the windows' row going with the windows.
--    CREATE OR REPLACE takes the whole body: anything that redefines this
--    function again must carry this file's lines forward too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}})
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint    text;
  v_id             uuid;
  -- 022: whether a row was there to lock, and the model its vector — and so
  -- its windows — was labelled with before this write (NULL: unknown). 035:
  -- read for every capture, so `existed` in the return is always right.
  v_existed        boolean := false;
  v_old_label      text;
  -- 060: the rest of the row the after-image is computed from.
  v_old_meta       jsonb;
  v_old_has_vec    boolean;
  v_old_sup        uuid;
  v_old_derived    jsonb;
  -- 035: the row's pointer after the write — the fresh row's, or the one the
  -- existing row keeps — returned so a caller told `existed` can say what
  -- stands instead of guessing.
  v_supersedes_now uuid;
  -- 025: the provenance the envelope carries, if any — written on a fresh
  -- row only (035).
  v_derived        jsonb;
  v_supersedes     text  := p_payload->>'supersedes';
  v_event          jsonb;  -- 046
  v_new_meta       jsonb;
  v_diff           jsonb;
  v_ev             uuid;
  v_label          text := p_payload->>'embedding_model';  -- 021
  -- 061: the lineage envelope — {"metadata": recipe, "chunks": recipe} —
  -- what the caller's producers declare about the tags (and, for the
  -- 4-argument form, the windows) this write carries. Absent: no row.
  v_lineage        jsonb := p_payload->'lineage';
BEGIN
  /**
   * Migration 005's guard, carried forward verbatim.
   *
   * This is the trap in redefining a function from a later migration: CREATE OR
   * REPLACE takes the whole body, so every change made to it in between is
   * silently reverted. Anything that redefines upsert_thought again must carry
   * this, the actor, the event and the locks forward too.
   */
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 025: derived_from is validated HERE — the write is the choke point, or an
  -- untrusted-input hole (SMD-1253). 033: through 032's validate_derived_from,
  -- the one copy of the rule. 035: validated before the write is known to be
  -- a dedup, so a bad reference is refused whether or not the text is new.
  v_derived := validate_derived_from(p_payload->'derived_from');

  -- 025: supersedes existence is the self-FK's job; check only its SHAPE here,
  -- so a bad string fails with a message about supersedes rather than a raw
  -- uuid cast error, and the FK reports a missing target.
  IF v_supersedes IS NOT NULL
     AND v_supersedes !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION
      'upsert_thought: supersedes must be a thought UUID string, got %.', v_supersedes;
  END IF;

  -- 060: 005's guard for the payload's metadata too (the 2-argument form
  -- says why); a JSON null stays.
  IF p_payload ? 'metadata' AND jsonb_typeof(p_payload->'metadata') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload.metadata must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload->'metadata');
  END IF;

  -- 061: 005's guard for the lineage envelope; a JSON null is no envelope.
  IF v_lineage IS NOT NULL AND jsonb_typeof(v_lineage) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload.lineage must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(v_lineage);
  END IF;
  -- …and each recipe it names is an object carrying a boolean deterministic,
  -- refused HERE by the key's name — not three frames down in the writer
  -- (run-it, first review pass: a scalar was ignored and an object without
  -- the key failed the capture naming ob1_record_derivation).
  IF v_lineage ? 'metadata' AND (jsonb_typeof(v_lineage->'metadata') <> 'object' OR COALESCE(jsonb_typeof(v_lineage->'metadata'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'upsert_thought: p_payload.lineage.metadata must be a JSON object carrying a boolean "deterministic", got %.', v_lineage->'metadata';
  END IF;
  IF v_lineage ? 'chunks' AND (jsonb_typeof(v_lineage->'chunks') <> 'object' OR COALESCE(jsonb_typeof(v_lineage->'chunks'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'upsert_thought: p_payload.lineage.chunks must be a JSON object carrying a boolean "deterministic", got %.', v_lineage->'chunks';
  END IF;

  -- Transaction-local, so it cannot outlive this call on a pooled connection.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 046: the write event's shape, refused here as a bad derived_from is. 060:
  -- the event rides the append; the setting a raw write later in this
  -- transaction would read is cleared here, as 046 cleared it before its write.
  v_event := validate_write_event(p_payload->'event');
  PERFORM set_config('ob1.event', '', true);

  v_fingerprint := content_fingerprint_of(p_content);

  -- 035: no supersession lock here. 033 took it first when the envelope named
  -- supersedes, to order the ON CONFLICT fill of a NULL pointer against
  -- update_thought's cycle walk; the fill is gone, and the pointer a fresh
  -- row writes is one no concurrent walk can reach.

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same. Taken
  -- BEFORE the row read, so a concurrent writer of this text — an edit
  -- taking the key, a first capture racing this one, an edit moving another
  -- row onto it — has committed before the read runs and the read finds its
  -- row (READ COMMITTED: a fresh snapshot per statement).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022/035: the row this capture lands on, if any, locked — so the write
  -- below lands on THIS row, not on one a concurrent writer commits meanwhile
  -- — and its label before the write, which says whether its windows still
  -- hold. FOR NO KEY UPDATE: ordered against update_thought's row lock, not
  -- against the FOR KEY SHARE every foreign key onto this row holds. 060: the
  -- rest of the row too, for the after-image.
  SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
    INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  v_existed := FOUND;

  -- ob1:capture-sets-write-event — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 046: the
  -- declared event reaches the audit row — since 060 by the append itself.
  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 060: the event
  -- is appended first and the row projected from it, the caller's vector
  -- and label (021) riding the projection.
  IF NOT v_existed THEN
    BEGIN
      v_id       := gen_random_uuid();
      -- 050: a new text — the writer from the envelope. 025: derived_from and
      -- supersedes written on a fresh row, validated above.
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb));
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, p_embedding IS NOT NULL,
                                     NULL, v_supersedes::uuid, NULL, v_derived, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NULL THEN
        RAISE EXCEPTION 'upsert_thought: the append recorded no capture event for %', v_id;
      END IF;
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
      v_supersedes_now := v_supersedes::uuid;
    EXCEPTION WHEN unique_violation THEN
      -- A writer that takes no fingerprint lock — a raw import, a backfill,
      -- a community schema — committed this text between the row read and
      -- the projection. 046's INSERT ... ON CONFLICT merged into it; the
      -- projector's INSERT meets the unique index. The event rolls back with
      -- this block; the row that landed is read under the lock still held
      -- and merged as a re-capture below (run-it, first review pass).
      SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
        INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
        FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_existed := true;
      v_ev := NULL;
    END;
  END IF;
  IF v_existed THEN
    -- ob1:re-capture-writes-no-provenance — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); preflight's `atomic capture` reads it. 035: the
    -- envelope's derived_from and supersedes are NOT written on an existing
    -- row — the diff below carries the old values on both sides, so the
    -- event names no move and the projector leaves them. Setting, changing
    -- or clearing provenance on an existing thought is update_thought's,
    -- through its p_provenance envelope (032).
    -- 050: the same text — the mark as it was. 046's gate: an update event
    -- only when the merge changed something, the vector's presence flipped
    -- or the envelope declared stance, cites or a window.
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta,
                                   v_old_has_vec, v_old_has_vec OR p_embedding IS NOT NULL,
                                   v_old_sup, v_old_sup, v_old_derived, v_old_derived, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
    END IF;
    IF v_ev IS NOT NULL THEN
      -- The vector rides the projection: kept when none arrives (021), the
      -- caller's when one does.
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
    ELSIF p_embedding IS NOT NULL THEN
      -- No event to project, a vector to place: a projection refresh — no
      -- event, no updated_at (060's named delta).
      PERFORM ob1_refresh_thought_vector(v_id, p_embedding, v_label);
    END IF;
    v_supersedes_now := v_old_sup;
  END IF;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed). The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = v_label) IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
    -- 061: the windows' lineage goes with the windows — no artifact, no row.
    DELETE FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = v_id;
  END IF;

  -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
  -- (the 014 convention); preflight's `atomic capture` reads it. 061: the
  -- tags' lineage row commits with the tags (SMD-1731) — on a fresh row, or
  -- on a re-capture whose event moved the metadata; a re-capture that wrote
  -- nothing, or refreshed the vector alone, records nothing and moves no
  -- produced_at. The vector's own row is thoughts_record_vector_lineage's.
  IF v_lineage ? 'metadata' AND jsonb_typeof(v_lineage->'metadata') = 'object'
     AND (NOT v_existed OR v_diff ? 'metadata') THEN
    PERFORM ob1_record_derivation('metadata', v_id, ARRAY[v_id], ARRAY[v_fingerprint], 'metadata',
                                  v_lineage->'metadata', ob1_actor_agent_id());
  END IF;

  -- 035: `existed` — the text was already captured; metadata merged, vector
  -- and windows by 021/022, provenance in the envelope not written — and
  -- `supersedes`, the row's pointer as it stands after this write.
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed, 'supersedes', v_supersedes_now);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one call. Reads p_payload.actor (008), p_payload.embedding_model (021), p_payload.derived_from / p_payload.supersedes (025), p_payload.event (046: {stance, cites, valid_from, valid_until, trust, actor_kind}, validated by validate_write_event and carried by the append) and p_payload.lineage (061: {metadata: recipe} — the tags'' derivation, recorded in `derivations` with the write; absent, no row) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s, checked where the column is written — a first capture (035). Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED); no supersession lock (035). Since 060 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event) with the caller''s vector: a fresh text is a capture event; a re-capture is an update event only when the metadata merge, the vector''s presence or a declared event gives it one, a vector onto a row that has one is a refresh with no event and no updated_at, and a re-capture that changes nothing writes nothing. On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022) — and their lineage row with them (061) — and the envelope''s provenance is NOT written (035) — setting, changing or clearing it is update_thought''s p_provenance (032). Returns {id, fingerprint, existed, supersedes}. Migration 004 / 021 / 022 / 025 / 033 / 035 / 046 / 060 / 061 (SMD-1731).';

-- ---------------------------------------------------------------------------
-- 6. upsert_thought, the 4-argument form — 013's body carried verbatim, plus
--    the chunk set's lineage row. It delegates to the 3-argument form, as it
--    did; 060's capture sentinel is that form's and does not appear here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}}),
  p_chunks    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_result jsonb;
  v_id     uuid;
  v_n      int := 0;
BEGIN
  v_result := upsert_thought(p_content, p_payload, p_embedding);
  v_id     := (v_result->>'id')::uuid;

  DELETE FROM thought_chunks WHERE thought_id = v_id;
  -- 061: the set is replaced wholesale, so its lineage row goes with it.
  DELETE FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = v_id;

  IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
    INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
    SELECT
      v_id,
      (ord - 1)::int,
      elem->>'content',
      (elem->>'embedding')::vector({{EMBEDDING_DIM}}),
      elem->>'context'
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
    -- (the 014 convention). 061: the windows' lineage row commits with the
    -- windows (SMD-1731): the caller's recipe from p_payload.lineage.chunks
    -- (the window parameters, the blurb model) when it declares one; the
    -- label alone when it does not — a deterministic split whose parameters
    -- were not declared, said so. The set's size rides the recipe either way.
    PERFORM ob1_record_derivation('chunks', v_id, ARRAY[v_id], ARRAY[v_result->>'fingerprint'], 'capture',
      COALESCE(CASE WHEN jsonb_typeof(p_payload->'lineage'->'chunks') = 'object' THEN p_payload->'lineage'->'chunks' END,
               jsonb_build_object('deterministic', true, 'declared', false)
                 || jsonb_strip_nulls(jsonb_build_object('model', p_payload->>'embedding_model')))
        || jsonb_build_object('count', v_n),
      ob1_actor_agent_id());
  END IF;

  RETURN v_result || jsonb_build_object('chunks', v_n);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector, jsonb) IS
  'Atomic capture including per-chunk embeddings and their situating context. Replaces any existing chunks for the thought — and, since 061, the chunk set''s lineage row in `derivations` (artifact_kind chunks, the thought''s id; the recipe from p_payload.lineage.chunks when the caller declares one, the label alone when not; no windows, no row). Overload of the 3-arg form, which it delegates to. Migration 007 / 013 / 061 (SMD-1731).';

-- ---------------------------------------------------------------------------
-- 7. update_thought — the 11-argument form: 060's body carried verbatim
--    under a signature with the lineage envelope as its last parameter (046's
--    p_event refuses a key its shape does not have, so the envelope cannot
--    ride it). 032/046/060's mechanism, carried: the ACL of the form this
--    file meets captured, the older forms dropped (or every shorter call is
--    "function is not unique"), the ACL replayed onto this one.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)')), '')
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)')), '')
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)')), '')
                       ELSE
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  -- 021: the model that produced p_embedding, as OB1_EMBEDDING_MODEL names it.
  p_embedding_model    text        DEFAULT NULL,
  -- 032: the provenance envelope — {"supersedes": uuid|null, "derived_from":
  -- [uuid…]|null}. An absent key leaves the column, a JSON null clears it, a
  -- value sets it.
  p_provenance         jsonb       DEFAULT NULL,
  -- 046: the write event — {"stance": stated|retrieved|inferred, "cites":
  -- [uuid…], "valid_from", "valid_until", "trust", "actor_kind"} — validated by
  -- validate_write_event and carried by the append; trust and actor_kind are
  -- claims the append checks against the key, never copies.
  p_event              jsonb       DEFAULT NULL,
  -- 061: the lineage envelope — {"chunks": recipe, "metadata": recipe} — what
  -- the caller's producers declare about the windows and the tags this edit
  -- carries (SMD-1731). Absent: the windows' row from the label alone, no
  -- row for the tags.
  p_lineage            jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing     thoughts%ROWTYPE;
  v_fingerprint  text;
  v_unchanged    boolean;
  -- The row holding v_fingerprint in the unique index, if any, and whether its
  -- text still hashes to it (a raw update around this function can leave a
  -- stale key): the twin, or the stale holder, reported as such below.
  v_other        uuid;
  v_other_same   boolean;
  v_updated      timestamptz;
  -- 032: whether the envelope names each key, and the value to write when it
  -- does (NULL clears). Two flags rather than two nullable values, because
  -- "clear" and "leave alone" are both NULL.
  v_set_supersedes boolean := COALESCE(p_provenance ? 'supersedes', false);
  v_set_derived    boolean := COALESCE(p_provenance ? 'derived_from', false);
  v_supersedes     uuid;
  v_derived        jsonb;
  v_walk           uuid;
  v_steps          int := 0;
  v_event          jsonb;  -- 046
  -- 060: the after-image, as 046's UPDATE would have left the row.
  v_new_content    text;
  v_new_fp         text;
  v_new_meta       jsonb;
  v_new_sup        uuid;
  v_new_derived    jsonb;
  v_new_has_vec    boolean;
  v_same_text      boolean;
  v_diff           jsonb;
  v_ev             uuid;
  -- 060: a window's vector, assigned through the column's type — the text of
  -- the JSON fed to the type's input function — rather than cast to `vector`
  -- by name, which a session with pgvector off its search_path cannot
  -- resolve inside a body (cold read, second review pass; 046's cast).
  elem             jsonb;
  v_chunk_i        integer := 0;
  v_chunk_vec      thought_chunks.embedding%TYPE;
BEGIN
  -- 032: the envelope's shape, before any lock is taken — 005's guard, for
  -- this parameter: a client that binds a JS string to a jsonb parameter
  -- double-encodes it. Then each key's value: supersedes a UUID string or
  -- null (shape here, existence under the row lock below), derived_from
  -- through the one rule.
  IF p_provenance IS NOT NULL AND jsonb_typeof(p_provenance) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_provenance must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_provenance);
  END IF;
  -- 060: the same guard for the patch — `{} || 'null'` and `{} || '[…]'`
  -- make an ARRAY of the row's metadata, after which every later event has
  -- no source and no mark (run-it, first review pass; 046 accepted it).
  IF p_metadata_patch IS NOT NULL AND jsonb_typeof(p_metadata_patch) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_metadata_patch must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_metadata_patch);
  END IF;
  -- 061: the same guard for the lineage envelope, and for each recipe it
  -- names — an object carrying a boolean deterministic, refused by the
  -- key's name (run-it, first review pass).
  -- A JSON null is no envelope, as p_payload.lineage's is (run-it, second
  -- review pass: the two forms disagreed).
  IF p_lineage IS NOT NULL AND jsonb_typeof(p_lineage) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'update_thought: p_lineage must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_lineage);
  END IF;
  IF p_lineage ? 'metadata' AND (jsonb_typeof(p_lineage->'metadata') <> 'object' OR COALESCE(jsonb_typeof(p_lineage->'metadata'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'update_thought: p_lineage.metadata must be a JSON object carrying a boolean "deterministic", got %.', p_lineage->'metadata';
  END IF;
  IF p_lineage ? 'chunks' AND (jsonb_typeof(p_lineage->'chunks') <> 'object' OR COALESCE(jsonb_typeof(p_lineage->'chunks'->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'update_thought: p_lineage.chunks must be a JSON object carrying a boolean "deterministic", got %.', p_lineage->'chunks';
  END IF;
  IF v_set_supersedes AND jsonb_typeof(p_provenance->'supersedes') <> 'null' THEN
    IF jsonb_typeof(p_provenance->'supersedes') <> 'string'
       OR (p_provenance->>'supersedes') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION
        'update_thought: supersedes must be a thought UUID string or null, got %.', p_provenance->'supersedes';
    END IF;
    v_supersedes := (p_provenance->>'supersedes')::uuid;
  END IF;
  IF v_set_derived THEN
    v_derived := validate_derived_from(p_provenance->'derived_from');
  END IF;

  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the write so the append reads it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- 046: the event's shape, refused here before any lock. 060: the event
  -- rides the append, which runs after every refusal this function can
  -- return (NOT_FOUND, STALE_READ, DUPLICATE_CONTENT, SUPERSEDES_NOT_FOUND,
  -- WOULD_CYCLE) — so a refused call leaves no event, in the log or on the
  -- transaction; the setting a raw write later would read is cleared here.
  -- The ACTOR set above stays, as 008 scoped it.
  v_event := validate_write_event(p_event);
  PERFORM set_config('ob1.event', '', true);

  -- ob1:supersession-review (032/036): a supersedes write is serialised with
  -- every other on 029's lock, taken BEFORE the row lock — see "Lock order"
  -- in 033's header — so the walk below reads committed pointers.
  -- Re-entrant: review_supersession_proposal holds it already when it calls
  -- here.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- 033: the fingerprint lock BEFORE the row, whenever content arrives — the
  -- order every capture takes, so no writer holds a row while waiting on a
  -- fingerprint lock another writer holds while waiting on a row. 003's
  -- rule, through 016's function: a fingerprint computed differently here
  -- would silently stop matching the ones capture writes.
  IF p_content IS NOT NULL THEN
    v_fingerprint := content_fingerprint_of(p_content);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  END IF;

  -- The row lock: what "unchanged" is decided against below is the row as it
  -- is NOW, and stays so until this transaction ends. FOR NO KEY UPDATE, not
  -- 018's FOR UPDATE (032): the supersedes write takes FOR KEY SHARE on the
  -- target row, which FOR UPDATE on that row — another edit of it, waiting
  -- on a fingerprint lock this one holds — would deadlock with. Two edits of
  -- one row still serialise, and delete_thought still waits.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- 009: a stale read is told apart from a missing row before the write, so
  -- the caller gets the reason rather than a bare "0 rows". Truncated on both
  -- sides to milliseconds — JavaScript's Date carries no more, and a caller
  -- passing back exactly what it read must pass this. 060: this is THE
  -- guard. 046's second copy in the UPDATE's own WHERE is gone with the
  -- UPDATE: under READ COMMITTED with the row locked FOR NO KEY UPDATE
  -- above, the row this read saw is the row the projector writes.
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  -- 032: the target exists, and pointing at it closes no loop. The first read
  -- answers both: NOT FOUND is the ghost; its pointer starts the walk. 029's
  -- walk, moved here so a hand edit and an acceptance are refused alike;
  -- bounded, so a chain longer than the bound is refused rather than walked
  -- for ever. A thought cannot supersede itself.
  IF v_supersedes IS NOT NULL THEN
    IF v_supersedes = p_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
    END IF;
    SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_supersedes;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SUPERSEDES_NOT_FOUND', 'supersedes', v_supersedes);
    END IF;
    WHILE v_walk IS NOT NULL LOOP
      IF v_walk = p_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
      END IF;
      v_steps := v_steps + 1;
      IF v_steps > 1000 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes, 'detail', 'chain longer than 1000');
      END IF;
      SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_walk;
    END LOOP;
  END IF;

  IF p_content IS NOT NULL THEN
    IF v_existing.content_fingerprint = v_fingerprint THEN
      -- The row already owns this key, and it is locked: the unique index
      -- says no other row can hold it, so there is nothing to look up. The
      -- common case — every fingerprinted row a re-embed pass visits, every
      -- same-text re-save through the tool.
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);

      -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL, not prose (the
      -- 014 convention). The one definition of "another row holding this key":
      -- the refusal below and the duplicate_of report both read it. Under the
      -- fingerprint lock taken above, so it sees the other writer's committed
      -- row rather than racing it to the unique index — see "The rule", 2, in
      -- 018's header. The holder's text is hashed again, because a stale key
      -- — a raw update of content around this function — is not the same
      -- text, and must not be reported as a twin.
      SELECT id, content_fingerprint_of(content) = v_fingerprint
        INTO v_other, v_other_same
      FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
      LIMIT 1;

      IF v_other IS NOT NULL THEN
        -- Editing a thought INTO a key another row holds. The partial unique
        -- index would reject this anyway, but as a constraint violation that
        -- surfaces at the tool boundary as an opaque 23505. An edit whose text
        -- normalises to what the row already holds creates no duplicate that
        -- was not already there, so it is not refused; what was found is
        -- reported instead — the twin, or the row whose stale key blocks the
        -- fingerprint this row should have had.
        IF NOT v_unchanged THEN
          RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
        END IF;
      END IF;
    END IF;
  END IF;

  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `edit signature` reads it. 060: the
  -- after-image, as 046's UPDATE would have left the row, computed here;
  -- the diff from it; the event appended; the row projected from the event.
  v_new_content := COALESCE(p_content, v_existing.content);
  -- v_other is set only when content arrived: another row holds this key, so
  -- this row must not claim it — NULL, whatever a raw update around this
  -- function may have left here (018).
  v_new_fp      := CASE WHEN p_content IS NULL   THEN v_existing.content_fingerprint
                        WHEN v_other IS NOT NULL THEN NULL
                        ELSE v_fingerprint END;
  -- 050: the actor follows the content — the same text (the same bytes, or
  -- 003's normalised fingerprint) keeps the mark, a new text takes the
  -- envelope's; the two arms 055 lifted out of ob1_stamp_actor.
  v_same_text   := p_content IS NULL OR p_content IS NOT DISTINCT FROM v_existing.content
                   OR content_fingerprint_of(v_existing.content) IS NOT DISTINCT FROM v_fingerprint;
  v_new_meta    := CASE WHEN p_metadata_patch IS NOT NULL THEN v_existing.metadata || p_metadata_patch ELSE v_existing.metadata END;
  v_new_meta    := CASE WHEN v_same_text THEN ob1_actor_stamp_kept(v_new_meta, v_existing.metadata) ELSE ob1_actor_stamp(v_new_meta) END;
  -- 032: each provenance column moves only when the envelope names its key
  -- — to the value given, NULL included.
  v_new_sup     := CASE WHEN v_set_supersedes THEN v_supersedes ELSE v_existing.supersedes END;
  v_new_derived := CASE WHEN v_set_derived THEN v_derived ELSE v_existing.derived_from END;
  -- Only when content arrived does the vector move (021): a metadata-only
  -- edit must not blank the vector and quietly remove the row from every
  -- semantic search.
  v_new_has_vec := CASE WHEN p_content IS NOT NULL THEN p_embedding IS NOT NULL ELSE v_existing.embedding IS NOT NULL END;
  v_diff := ob1_thought_diff('update',
    v_existing.content, v_new_content,
    v_existing.metadata, v_new_meta,
    v_existing.embedding IS NOT NULL, v_new_has_vec,
    v_existing.supersedes, v_new_sup,
    v_existing.derived_from, v_new_derived,
    v_existing.content_fingerprint, v_new_fp);

  -- 046's gate, as the trigger applied it: an edit that changes nothing and
  -- declares nothing is not an event.
  IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
    v_ev := ob1_append_thought_event(p_id, 'update', v_new_meta->>'source', v_diff, v_event);
  END IF;
  IF v_ev IS NOT NULL THEN
    -- The label follows the vector (021): the caller's with a vector, NULL
    -- with content and no vector, untouched without content — the projector
    -- writes it so from the event and these two.
    PERFORM ob1_project_thought_event(v_ev, CASE WHEN p_content IS NOT NULL THEN p_embedding END, p_embedding_model);
    SELECT updated_at INTO v_updated FROM thoughts WHERE id = p_id;
  ELSIF p_content IS NOT NULL AND p_embedding IS NOT NULL THEN
    -- The same text with a new vector (the re-embed's shape): a projection
    -- refresh — no event, no updated_at (060's named delta).
    PERFORM ob1_refresh_thought_vector(p_id, p_embedding, p_embedding_model);
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  ELSE
    -- Nothing changed: no event, no write, no updated_at (060's named delta;
    -- 046 bumped the stamp and recorded no audit row).
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  END IF;

  -- Chunks describe the content, so they follow it: replaced wholesale, as
  -- migration 007's capture path does, carrying 013's context.
  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    -- 061: the set is replaced wholesale, so its lineage row goes with it.
    DELETE FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      FOR elem IN SELECT x.e FROM jsonb_array_elements(p_chunks) AS x(e) LOOP
        v_chunk_vec := elem->>'embedding';
        INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
        VALUES (p_id, v_chunk_i, elem->>'content', v_chunk_vec, elem->>'context');
        v_chunk_i := v_chunk_i + 1;
      END LOOP;
    END IF;
    -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); preflight's `edit signature` reads it. 061: the
    -- windows' lineage row commits with the windows (SMD-1731) — the caller's
    -- recipe from p_lineage.chunks, the label alone when none is declared;
    -- no windows, no row. The row's key as this edit leaves it (018's NULL
    -- under a twin hashed again, so the row always names a fingerprint).
    IF v_chunk_i > 0 THEN
      PERFORM ob1_record_derivation('chunks', p_id, ARRAY[p_id], ARRAY[COALESCE(v_new_fp, v_fingerprint)], 'edit',
        COALESCE(CASE WHEN jsonb_typeof(p_lineage->'chunks') = 'object' THEN p_lineage->'chunks' END,
                 jsonb_build_object('deterministic', true, 'declared', false)
                   || jsonb_strip_nulls(jsonb_build_object('model', p_embedding_model)))
          || jsonb_build_object('count', v_chunk_i),
        ob1_actor_agent_id());
    END IF;
  END IF;
  -- 061: the tags' lineage row, when the caller's extractor wrote the patch
  -- and the event moved the metadata — or the TEXT moved under the
  -- extractor's recipe: the tags were computed again from the new text and
  -- came out the same, so the caller sent no patch, and the row moves to
  -- the text they were computed from (a false stale otherwise; cold read,
  -- third review pass). A patch that changed nothing on standing text, or
  -- one no extractor produced, records nothing (SMD-1731).
  IF p_lineage ? 'metadata' AND jsonb_typeof(p_lineage->'metadata') = 'object' AND (v_diff ? 'metadata' OR NOT v_same_text) THEN
    PERFORM ob1_record_derivation('metadata', p_id, ARRAY[p_id],
                                  ARRAY[COALESCE(v_new_fp, v_fingerprint, content_fingerprint_of(v_new_content))], 'metadata',
                                  p_lineage->'metadata', ob1_actor_agent_id());
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated)
         || CASE WHEN v_other IS NULL   THEN '{}'::jsonb
                 WHEN v_other_same       THEN jsonb_build_object('duplicate_of', v_other)
                 ELSE jsonb_build_object('fingerprint_held_by', v_other) END;
END;
$$;

DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_update_thought', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. Every edit with content takes the fingerprint advisory lock (READ COMMITTED) — the one every capture through upsert_thought takes since 033 — and then locks the row FOR NO KEY UPDATE (032); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since against the locked row before the write — since 060 the one check, the row it read being the row it writes. Since 060 the edit is an event first: the after-image is computed in the body (050''s stamp arms, 046''s diff rule), appended (ob1_append_thought_event) and projected (ob1_project_thought_event); a same-text edit carrying a vector is a refresh with no event and no updated_at (ob1_refresh_thought_vector); an edit that changes nothing writes nothing. p_embedding_model (021) is written beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. p_event (046) is the write event {"stance", "cites", "valid_from", "valid_until", "trust", "actor_kind"}: validated by validate_write_event (a bad shape is refused) and carried by the append, which stamps stance, cites and the window on the row and checks trust and actor_kind against the key rather than copying them. p_lineage (061) is the lineage envelope {"chunks": recipe, "metadata": recipe}: with content, the windows written are recorded in `derivations` (artifact_kind chunks) under the caller''s recipe, or the label alone when none is declared — no windows, no row; the tags are recorded (artifact_kind metadata) when the envelope names their recipe and the event moved the metadata. Returns {ok:true, id, updated_at} — the row''s stamp after the call, unmoved by a refresh or a no-op — or {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE. Migration 009 / 013 / 018 / 021 / 032 / 033 / 046 / 060 / 061 (SMD-1731).';

-- ---------------------------------------------------------------------------
-- 8. record_thought_entities — 056's body carried verbatim under a 7-argument
--    signature (p_recipe), the 6-argument form dropped first; the pass's
--    lineage row with the input's fingerprint stored.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_thought_entities(uuid, text, jsonb, jsonb, text, uuid);

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
  'Writes one thought''s entities and relations atomically (016), with 053''s resolution rule and 056''s name gate. An extraction''s entities are written under entity_type_gate()''s type: a number or a type-vocabulary word is refused (not written, and a relation naming it dropped and counted), an identifier-shaped person or place retyped to project or tool; a structured pass is not gated. An extraction_key `source:<system>` is a structured pass (the source''s own project, labels, members — no model call) that keeps its own rows as a set — the same set twice writes nothing, and moves no last_seen_at; an `extract:*` pass replaces only extracted rows; and where both name one (thought, entity) or (thought, from, to, relation) the structured row stands — an extracted insert onto it does nothing, a structured insert onto an extracted row takes it over. Entities upserted by (type, normalised name); a relation naming an unlisted entity is dropped and counted; entities left unreferenced are pruned. p_content_fingerprint NULL skips the stale check. Since 061 the pass''s lineage row is written with its rows in `derivations` (artifact_kind entities, the thought''s id, produced_by the key): the input''s fingerprint as checked, p_recipe (the model, prompt version and hash, the windows — or the key alone, marked undeclared, when NULL), replaced under the pass''s own rule; no rows standing under the key, no lineage row. Returns {ok, stale, entities, new_entities, mentions, edges, dropped_relations, ambiguous_relations, pruned_entities, refused_entities, retyped_entities}. Migrations 016, 053, 056, 061 / SMD-947, SMD-1867, SMD-1935, SMD-1731.';

-- ---------------------------------------------------------------------------
-- 9. record_supersession_proposal — 029's body carried verbatim under an
--    11-argument signature (p_recipe), the 10-argument form dropped first;
--    the proposal's lineage row with both fingerprints as the row takes them.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text);

CREATE OR REPLACE FUNCTION record_supersession_proposal(
  p_older_id          uuid,
  p_newer_id          uuid,
  p_verdict           text,
  p_confidence        numeric,
  p_reason            text,
  p_similarity        float,
  p_judge_key         text,
  p_agent_id          uuid DEFAULT NULL,
  p_older_fingerprint text DEFAULT NULL,
  p_newer_fingerprint text DEFAULT NULL,
  -- 061: the judge's recipe — model, prompt version and hash, the candidate
  -- parameters — recorded with the proposal in `derivations` (SMD-1731).
  p_recipe            jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id       uuid;
  -- 061: the two fingerprints as the row takes them, so the lineage row
  -- carries the same values.
  v_fp_older text;
  v_fp_newer text;
BEGIN
  IF p_verdict NOT IN ('newer_supersedes_older', 'older_supersedes_newer', 'conflict_undirected') THEN
    RAISE EXCEPTION 'record_supersession_proposal: p_verdict must be newer_supersedes_older, older_supersedes_newer or conflict_undirected, got %', p_verdict;
  END IF;
  IF p_judge_key IS NULL OR p_judge_key = '' THEN
    RAISE EXCEPTION 'record_supersession_proposal: p_judge_key must name the pass, e.g. consolidate:<model>@p1';
  END IF;
  IF p_recipe IS NOT NULL AND (jsonb_typeof(p_recipe) <> 'object' OR COALESCE(jsonb_typeof(p_recipe->'deterministic'), '') <> 'boolean') THEN
    RAISE EXCEPTION 'record_supersession_proposal: p_recipe must be a JSON object carrying a boolean "deterministic", got %', p_recipe;
  END IF;
  v_fp_older := COALESCE(p_older_fingerprint, (SELECT content_fingerprint_of(content) FROM thoughts WHERE id = p_older_id));
  v_fp_newer := COALESCE(p_newer_fingerprint, (SELECT content_fingerprint_of(content) FROM thoughts WHERE id = p_newer_id));
  INSERT INTO supersession_proposals (older_id, newer_id, verdict, confidence, reason, similarity, judge_key, canonical_agent_id, older_fingerprint, newer_fingerprint)
  VALUES (p_older_id, p_newer_id, p_verdict,
          LEAST(GREATEST(COALESCE(p_confidence, 0), 0), 1),
          p_reason, p_similarity, p_judge_key, p_agent_id,
          v_fp_older, v_fp_newer)
  ON CONFLICT (older_id, newer_id) DO NOTHING
  RETURNING id INTO v_id;
  -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
  -- (the 014 convention); preflight's `lineage` reads it. 061: the
  -- proposal's lineage row commits with the proposal (SMD-1731): both
  -- inputs at the fingerprints the judge saw, the judge's key and recipe.
  -- A pair already judged inserts nothing and records nothing — the first
  -- judgement's row stands.
  IF v_id IS NOT NULL THEN
    PERFORM ob1_record_derivation('proposal', v_id, ARRAY[p_older_id, p_newer_id], ARRAY[v_fp_older, v_fp_newer], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', false, 'key', p_judge_key, 'declared', false)),
                                  p_agent_id);
  END IF;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text, jsonb) IS
  'Record one conflict the pass found, pending review, with 016''s fingerprint of each text as the judge saw it (NULL: as of the write). Returns the new row''s id, or NULL when the pair already has a row in any state. Since 061 a recorded proposal''s lineage row is written with it in `derivations` (artifact_kind proposal, the proposal''s id, inputs the two thoughts at those fingerprints, produced_by the judge key, p_recipe the judge''s model, prompt version and hash or the key alone when NULL). Migration 029 / 061 (SMD-1731).';

-- ---------------------------------------------------------------------------
-- 10. The backfill: the artifacts standing today, each with the lineage its
--     own rows vouch for, marked `legacy: true`. ON CONFLICT DO NOTHING: a
--     re-apply, or a brain whose producers already wrote the row, keeps the
--     row it has. The tags are not backfilled — nothing on a row says the
--     extractor tagged it — and preflight counts them as coverage.
-- ---------------------------------------------------------------------------
-- Every proposal: both fingerprints from its columns (hashed again where 029
-- left one NULL), the judge key parsed where it has 029's shape
-- (consolidate:<model>@p<n>; a key of another shape carries no model).
INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, produced_at, canonical_agent_id)
SELECT 'proposal', sp.id, ARRAY[sp.older_id, sp.newer_id],
       ARRAY[COALESCE(sp.older_fingerprint, content_fingerprint_of(o.content)),
             COALESCE(sp.newer_fingerprint, content_fingerprint_of(n.content))],
       sp.judge_key,
       jsonb_build_object('deterministic', false, 'legacy', true, 'key', sp.judge_key)
         || jsonb_strip_nulls(jsonb_build_object(
              'model', substring(sp.judge_key from '^consolidate:(.+)@p[0-9]+$'),
              'prompt_version', substring(sp.judge_key from '^consolidate:.+@p([0-9]+)$')::int)),
       COALESCE(sp.judged_at, now()), sp.canonical_agent_id
  FROM supersession_proposals sp
  JOIN thoughts o ON o.id = sp.older_id
  JOIN thoughts n ON n.id = sp.newer_id
ON CONFLICT (artifact_kind, artifact_id, produced_by) DO NOTHING;

-- Every (thought, extraction_key) pair over the mentions and the edges: the
-- thought's CURRENT fingerprint (the rows vouch for nothing older — 016 never
-- stored the input's), the pass's last write, any agent the rows name.
-- The pairs aggregated first, the thought joined once per pair: grouping
-- the join by the thought's text as well ran 2.6 s over 26,502 rows on a
-- copy of the dogfood brain, this shape 60 ms (run-it, the build).
INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, produced_at, canonical_agent_id)
SELECT 'entities', x.thought_id, ARRAY[x.thought_id],
       ARRAY[COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))],
       x.extraction_key,
       jsonb_build_object('deterministic', x.extraction_key LIKE 'source:%', 'legacy', true, 'key', x.extraction_key),
       x.produced_at, x.agent
  FROM (SELECT u.thought_id, u.extraction_key, COALESCE(max(u.extracted_at), now()) AS produced_at,
               (array_agg(u.canonical_agent_id) FILTER (WHERE u.canonical_agent_id IS NOT NULL))[1] AS agent
          FROM (SELECT m.thought_id, m.extraction_key, m.extracted_at, m.canonical_agent_id FROM thought_entities m
                UNION ALL
                SELECT g.thought_id, g.extraction_key, g.extracted_at, g.canonical_agent_id FROM ob1_entity_edges g) u
         GROUP BY u.thought_id, u.extraction_key) x
  JOIN thoughts t ON t.id = x.thought_id
ON CONFLICT (artifact_kind, artifact_id, produced_by) DO NOTHING;

-- Every chunk set: the parent's label vouches for it (022) and nothing else
-- was recorded; the set's size; the row's stamp as its time (thought_chunks
-- carries none), as 060's seed took it.
INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, produced_at)
SELECT 'chunks', t.id, ARRAY[t.id],
       ARRAY[COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))],
       'capture',
       jsonb_build_object('deterministic', true, 'legacy', true, 'count', count(c.chunk_index))
         || jsonb_strip_nulls(jsonb_build_object('model', t.embedding_model)),
       COALESCE(t.updated_at, t.created_at, now())
  FROM thoughts t
  JOIN thought_chunks c ON c.thought_id = t.id
 GROUP BY t.id, t.content_fingerprint, t.content, t.embedding_model, t.updated_at, t.created_at
ON CONFLICT (artifact_kind, artifact_id, produced_by) DO NOTHING;

-- Every vector: label and width, as the trigger records a live one.
INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, produced_at)
SELECT 'vector', t.id, ARRAY[t.id],
       ARRAY[COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))],
       'thoughts_record_vector_lineage',
       jsonb_build_object('deterministic', true, 'legacy', true, 'dims', array_length(t.embedding::real[], 1))
         || jsonb_strip_nulls(jsonb_build_object('model', t.embedding_model)),
       COALESCE(t.updated_at, t.created_at, now())
  FROM thoughts t
 WHERE t.embedding IS NOT NULL
ON CONFLICT (artifact_kind, artifact_id, produced_by) DO NOTHING;
