-- =============================================================================
-- Migration 111: a thought's own subject is recorded — a `subject` facet,
--                one standing per thought, with its lineage at the text's
--                fingerprint, so the thoughts about one subject read as one
--                thread in capture order (SMD-3306)
-- =============================================================================
--
-- WHY
--   The consolidation pass decides "evolves" pair by pair: H2O's verdict,
--   then since decide version 4 a 27B link step that caps a pair linked only
--   through a third subject (SMD-3203). Three rounds of asking that step
--   another way did not meet their bars (SMD-3299). SMD-3116 defines evolves
--   as a later segment of the same work, which is a property of each
--   thought's own subject, not of the pair: asked of one thought alone, the
--   27B names the ticket blind raters agree on for 241 to 242 of the 245
--   thoughts whose own subject is a ticket, under the test's versions 2 and 3
--   (SMD-3299, comment ac4f9321). A work thread is one
--   subject's thoughts in time order (SMD-3306). This file records the subject;
--   the pass that finds it, the threads and the pass's use of them follow.
--
-- WHAT
--   * thought_facets_validate — 102's body, with two changes: the kind check
--     admits `subject`, and a `subject` branch, written standing and only
--     ever closed, as a relation is (084). Its payload:
--       key       — the subject, namespaced: ticket:<ID>, pr:<number>,
--                   version:<v1.2.3> or phrase:<lower-case words>
--                   (subject_key_valid);
--       by        — how it was found: metadata (the thought's ticket or
--                   issue), first_line (the first ticket on its first line) or
--                   model (the judge model, asked of the thought alone);
--       judge_key — the pass that found it, as a relation's names its judge;
--       origin    — `derived`, the validator's word.
--   * One standing subject per thought: a partial unique index; and a probe on
--     the key for "every thought about this subject".
--   * subject_key_valid(text) — the key's shape, one rule for the validator
--     and the writer.
--   * record_thought_subject(thought, key, by, judge_key, agent, fingerprint,
--     recipe) — the pass's one write: refused when the text moved since the
--     pass read it (the fingerprint, as record_thought_entities does); the
--     same key, way and pass standing is kept (its lineage moved to the text
--     read now); anything else replaces it; a NULL key closes the standing
--     subject. The facet and its lineage are one transaction.
--   * derivations: `subject` joins the artifact kinds (084's CHECK and
--     ob1_record_derivation's list) — a subject's lineage row names its
--     thought at the fingerprint the pass read.
--   * The facet's own thought deleted: the foreign key cascades, and an AFTER
--     DELETE trigger on thought_facets drops the subject's lineage row.
--   * Grants: none new, as 084's: INSERT on thought_facets is the structure
--     group's, UPDATE on it and on thoughts and the derivations writes the
--     capture group's.
--
--   ob1:subject-facet and ob1:subject-lineage-with-its-artifact — CONTRACT
--   SENTINELS, not prose (the 014 convention).
--
-- NOT HERE
--   * The pass that finds a subject (SMD-3306 PR 2: the extraction worker's
--     rules, and its --subjects sweep for the rest), its place in sleep and
--     rebuild_derived's arm for an edited text (PR 3): until then a subject
--     whose text moved stands at its old fingerprint, and the sweep finds it
--     by that.
--   * Threads, their read, and the consolidation pass's use of them.
--
-- SAFETY
--   A new facet kind, a new artifact kind and a new function: nothing writes
--   a subject until the pass runs, and no existing row changes. The kind
--   check and the derivations CHECK only widen.
--
-- Idempotent: CREATE OR REPLACE, the constraint dropped by shape and added
-- again (084's way), each trigger dropped by name first, the indexes IF NOT
-- EXISTS.
-- =============================================================================

DO $qc$
DECLARE
  v_missing text;
BEGIN
  -- The first prerequisite missing, in file order, named: 102's is its door's
  -- sentinel, since 102 keeps 084's signature and this file carries 102's
  -- validator, distinct and all.
  v_missing := CASE
    WHEN to_regprocedure('content_fingerprint_of(text)') IS NULL THEN '016 (content_fingerprint_of)'
    WHEN to_regclass('thought_facets') IS NULL THEN '042 (thought_facets)'
    WHEN to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL THEN '061 (ob1_record_derivation)'
    WHEN to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)') IS NULL THEN '084 (record_thought_relation)'
    WHEN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)')) NOT LIKE '%ob1:relation-distinct%'
      THEN '102 (record_thought_relation taking distinct)'
  END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 111 needs %s; this schema lacks it', v_missing),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The key's shape — one rule for the validator and the writer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION subject_key_valid(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key IS NOT NULL AND length(p_key) <= 207 AND (
       p_key ~ '^ticket:[A-Z][A-Z0-9]*-[0-9]+$'
    OR p_key ~ '^pr:[0-9]{1,9}$'
    OR p_key ~ '^version:v[0-9]+(\.[0-9]+){1,3}$'
    OR p_key ~ '^phrase:[^[:space:][:upper:]]+( [^[:space:][:upper:]]+)*$')
$$;

COMMENT ON FUNCTION subject_key_valid(text) IS
  'Whether a text is a thought subject''s key (111, SMD-3306): ticket:<ID> (a ticket id, upper case, as SMD-123), pr:<number>, version:v<n>.<n>[.<n>[.<n>]], or phrase:<words> — lower case, one space between words, none at either end, on one line — at most 207 characters in all. The facet validator and record_thought_subject both read it. Migration 111 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 2. The `subject` facet kind — thought_facets_validate extended
--
-- 102's body verbatim but the kind check, which names four kinds now, and the
-- new branch above the relation's.
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
  v_key      text;
  v_by       text;
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
  IF NEW.kind IS DISTINCT FROM 'citation' AND NEW.kind IS DISTINCT FROM 'link' AND NEW.kind IS DISTINCT FROM 'relation'
     AND NEW.kind IS DISTINCT FROM 'subject' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.kind %L is not a registered facet kind', NEW.kind),
      HINT = 'The registered kinds are: citation (migration 042), link (migration 053), relation (migration 084), subject (migration 111). A new kind is registered by a migration that extends thought_facets_validate.';
  END IF;

  IF NEW.kind = 'subject' THEN
    -- ob1:subject-facet (111)
    -- A thought's own subject (SMD-3306), written once and only ever closed,
    -- as a relation is: the one UPDATE is the close — record_thought_subject
    -- setting valid_until with every other column as it was. A rewrite would
    -- leave its lineage naming what it no longer says.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.id = OLD.id AND NEW.thought_id = OLD.thought_id AND NEW.payload = OLD.payload
         AND NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by AND NEW.created_at = OLD.created_at
         AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject is written once and only closed: the one update it takes sets valid_until, not in the future, on a standing subject, every other column as it was',
        HINT = 'record_thought_subject replaces a subject (the old one closed, a new one written); write a new row rather than edit one.';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject is written standing: valid_until and superseded_by are set only by its close';
    END IF;
    v_key := NEW.payload->>'key';
    v_by  := NEW.payload->>'by';
    IF jsonb_typeof(NEW.payload->'key') IS DISTINCT FROM 'string' OR NOT subject_key_valid(v_key) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a subject''s key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(v_key, 80));
    END IF;
    IF v_by IS NULL OR v_by NOT IN ('metadata', 'first_line', 'model') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a subject says how it was found: by is metadata, first_line or model, got %L', v_by);
    END IF;
    IF jsonb_typeof(NEW.payload->'judge_key') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'judge_key') = '' OR length(NEW.payload->>'judge_key') > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject names the pass that found it: judge_key, a non-empty string of at most 200 characters';
    END IF;
    -- Origin is the validator's word, not the writer's: a pass derived it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'derived');
    RETURN NEW;
  END IF;

  IF NEW.kind = 'relation' THEN
    -- ob1:relation-facet (084; distinct since 102)
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
    IF v_relation IS NULL OR v_relation NOT IN ('related', 'evolves', 'duplicate', 'distinct') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s relation must be related, evolves, duplicate or distinct, got %L', v_relation);
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
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind. For a citation (042): a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — stores source_id lower-case, locks the source row FOR KEY SHARE; source_id may be null only in the detached shape, which keeps what it lost and is not re-pointed. For a link (053): relation one of references | child_of | blocks | blocked_by | relates_to | duplicate_of, system one lower-case word, target a non-empty identity within it, never the thought''s own (thought_sources); writes origin = structured. For a relation (084): written standing (no valid_until, no superseded_by), relation one of related | evolves | duplicate | distinct (distinct since 102), target an existing thought (locked FOR KEY SHARE) that is not the thought itself, stored lower-case, judge_key a non-empty string of at most 200 characters, confidence a number in 0..1 or absent; writes origin = judged; afterwards only its close (valid_until set, not in the future, every other column as it was) is admitted — no rewrite, re-open or move. For a subject (111): written standing, key a subject key (subject_key_valid), by one of metadata | first_line | model, judge_key a non-empty string of at most 200 characters; writes origin = derived; afterwards only its close, as a relation''s. Since 084 no facet changes its kind on UPDATE. A pure close of a link passes unjudged. Migrations 042, 053, 084, 102, 111.';

-- One standing subject per thought: the rule is the index's, not a writer's
-- discipline. Closed rows are history.
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_subject_active_uniq
  ON thought_facets (thought_id)
  WHERE kind = 'subject' AND valid_until IS NULL;

-- "Every thought about this subject": the thread reads the key.
CREATE INDEX IF NOT EXISTS thought_facets_subject_key_idx
  ON thought_facets ((payload->>'key'))
  WHERE kind = 'subject' AND valid_until IS NULL;

-- ---------------------------------------------------------------------------
-- 3. derivations: `subject` joins the artifact kinds
--
-- 084's drop-by-shape, add NOT VALID, then VALIDATE; ob1_record_derivation is
-- 084's body with one more value in the kind list and its message.
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
  CHECK (artifact_kind IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section', 'relation', 'subject')) NOT VALID;
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
  IF p_kind IS NULL OR p_kind NOT IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section', 'relation', 'subject') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: artifact_kind must be chunks, entities, proposal, vector, metadata, section, relation or subject, got %L', p_kind),
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
  'Records one derived artifact''s lineage in `derivations`, upserting on (artifact_kind, artifact_id, produced_by) and moving produced_at: the inputs and their fingerprints (parallel, no NULL), the pass, the recipe (a JSON object with a boolean `deterministic`), the agent. Refuses a bad shape with a RAISE — a producer that cannot record its lineage must not commit its artifact either. Eight kinds since 111: chunks, entities, proposal, vector, metadata (061), section (064, a page section a machine wrote), relation (084, a judged relation between two thoughts) and subject (111, a thought''s own subject); the upsert clears 063''s mark (ob1:rerun-clears-the-mark). Migrations 061, 063, 064, 084, 111 / SMD-1731, SMD-1732, SMD-1812, SMD-1873, SMD-3306.';

-- ---------------------------------------------------------------------------
-- 4. record_thought_subject — the pass's one write
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_subject(
  p_thought   uuid,
  p_key       text,
  p_by        text,
  p_judge_key text,
  p_agent     uuid,
  p_fp        text,
  p_recipe    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_active uuid;
  v_key    text;
  v_by     text;
  v_judge  text;
  v_fp     text;
  v_id     uuid;
BEGIN
  IF p_thought IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: a thought is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    -- The validator's bounds, refused here as parameter errors: a check
    -- violation would read to the pass as the thought deleted mid-write (084's way).
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND NOT subject_key_valid(p_key) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subject: the key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, or NULL (close), got %L', left(p_key, 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND (p_by IS NULL OR p_by NOT IN ('metadata', 'first_line', 'model')) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subject: by is metadata, first_line or model, got %L', p_by),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND (p_fp IS NULL OR btrim(p_fp) = '') THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: the fingerprint of the text the subject was found in is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer per thought at a time: two passes at once would otherwise both
  -- find nothing standing and the second insert hit the index.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  -- The thought locked FOR KEY SHARE before its facet row, as 084 locks a
  -- relation's two: a delete then waits here rather than deadlocking with the
  -- facet this call locks. A thought already gone answers none.
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) INTO v_fp
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- The text moved since the pass read it: the subject was found in a text
  -- that is gone, so nothing is written; the edit leaves the thought for the
  -- pass to read again (its pool finds a subject off its text).
  IF p_key IS NOT NULL AND p_fp IS DISTINCT FROM v_fp THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  SELECT f.id, f.payload->>'key', f.payload->>'by', f.payload->>'judge_key' INTO v_active, v_key, v_by, v_judge
    FROM thought_facets f
   WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
   FOR UPDATE;

  IF p_key IS NULL THEN
    IF v_active IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'action', 'none');
    END IF;
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
    RETURN jsonb_build_object('ok', true, 'action', 'closed', 'id', v_active);
  END IF;

  IF v_active IS NOT NULL AND v_key = p_key AND v_by = p_by AND v_judge = p_judge_key THEN
    -- Kept: the same subject, found the same way by the same pass — the facet
    -- stands, its lineage moved to the text read now.
    PERFORM ob1_record_derivation('subject', v_active, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
    RETURN jsonb_build_object('ok', true, 'action', 'kept', 'id', v_active);
  END IF;
  IF v_active IS NOT NULL THEN
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
  END IF;

  INSERT INTO thought_facets (thought_id, kind, payload)
  VALUES (p_thought, 'subject', jsonb_build_object('key', p_key, 'by', p_by, 'judge_key', p_judge_key))
  RETURNING id INTO v_id;
  -- ob1:subject-lineage-with-its-artifact — a CONTRACT SENTINEL, not prose:
  -- the facet and its lineage are one transaction (061's rule).
  PERFORM ob1_record_derivation('subject', v_id, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
  RETURN jsonb_build_object('ok', true, 'action', CASE WHEN v_active IS NULL THEN 'added' ELSE 'replaced' END, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION record_thought_subject(uuid, text, text, text, uuid, text, jsonb) IS
  'The subject pass''s write of one thought''s own subject (SMD-3306): a `subject` facet on the thought, one standing, under an advisory lock on the thought, the thought locked FOR KEY SHARE first. Refused (action none, stale) when the thought''s fingerprint is not the one the pass read — the subject was found in a text that is gone. The same key, found the same way by the same pass, is kept (its lineage row moved to the fingerprint read now); anything else replaces it (the old facet closed with valid_until, a new one inserted — a subject is never edited); a NULL key closes the standing subject, or answers none; a thought gone answers none. Each new facet''s lineage row (artifact_kind subject, its thought at the fingerprint read, produced_by the pass''s key; the recipe the caller''s, else deterministic unless the model found it) is written in the same transaction (ob1:subject-lineage-with-its-artifact). Returns {ok, action: added | kept | replaced | closed | none, id, stale?, gone?}. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group). Migration 111 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 5. The facet's own thought deleted: its lineage row goes with it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_drop_subject_derivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM derivations WHERE artifact_kind = 'subject' AND artifact_id = OLD.id;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_drop_subject_derivation() IS
  'AFTER DELETE on thought_facets for a subject (thought_facets_drop_subject_derivation, 111): drops the `derivations` row the subject keyed. A subject goes with its thought''s cascade, and this fires under it, as 084''s does for a relation. Migration 111 / SMD-3306.';

DROP TRIGGER IF EXISTS thought_facets_drop_subject_derivation ON thought_facets;
CREATE TRIGGER thought_facets_drop_subject_derivation
  AFTER DELETE ON thought_facets
  FOR EACH ROW WHEN (OLD.kind = 'subject') EXECUTE FUNCTION ob1_drop_subject_derivation();

-- ---------------------------------------------------------------------------
-- 6. The catalog's copy of the vocabulary
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN thought_facets.payload IS
  'Shaped by kind. citation: text (non-empty), stance (stated | retrieved | inferred), source_id (an existing thought, not thought_id itself, stored lower-case); after the source is deleted, source_id null with source_deleted_id and source_deleted_at set by the guard — a shape a restore may insert whole, and that is never re-pointed at a new source. link (053): relation, system, target (an identity in the system), origin structured. relation (084): relation (related | evolves | duplicate | distinct — distinct since 102), target (the older thought''s id), judge_key, confidence, origin judged; inserted standing only, so a restore re-inserts a closed relation as standing or not at all. subject (111): key (ticket:<ID> | pr:<number> | version:<v> | phrase:<words>), by (metadata | first_line | model), judge_key, origin derived; inserted standing only, as a relation.';
COMMENT ON COLUMN thought_facets.kind IS
  'The registered kind: citation (042), link (053), relation (084) or subject (111). A later migration registers another by extending thought_facets_validate, not by a registry table.';
COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, four kinds registered: citation (042), payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id; link (053), payload {relation, system, target, origin} — a source system''s structured link from the thought to another identity in it; relation (084), payload {relation, target, judge_key, confidence, origin} — the consolidation judge''s related, evolves or duplicate verdict on the thought (the newer) and the target thought (the older), or since 102 its distinct (the pair it called unrelated: two near neighbours about different subjects, kept apart), written once — by record_thought_relation, the consolidation pass''s door, though origin `judged` marks the kind and any role holding INSERT on the table (the structure group) can write one — and only ever closed; subject (111), payload {key, by, judge_key, origin} — the thought''s own subject, one standing per thought, written by record_thought_subject and only ever closed. Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while valid_until is NULL or future and no facet that still exists supersedes it (thought_facet_active); only active citations make thoughts_guard_citation_sources refuse a delete of their source. Migrations 042, 053, 084, 102, 111 / SMD-1712, SMD-1867, SMD-1873, SMD-3117, SMD-3306.';
COMMENT ON TABLE derivations IS
  'Lineage for every derived artifact (SMD-1731, Phase 1b of SMD-1729): one row per artifact per producing pass, written in the transaction that writes the artifact. artifact_kind names the tier — chunks (a thought''s window set), entities (a thought''s extraction under one extraction_key), proposal (one supersession proposal), vector (a thought''s embedding), metadata (a thought''s capture-time tags), since 064 section (a page section a machine wrote — SMD-1812), since 084 relation (a judged relation between two thoughts, a `relation` facet — SMD-1873), and since 111 subject (a thought''s own subject, a `subject` facet — SMD-3306); artifact_id is the thought''s id for the four keyed by a thought, the proposal''s id for a proposal, the section''s id for a section, the facet''s id for a relation or a subject. input_ids and input_fingerprints are parallel arrays naming what the artifact was computed from and the text it was computed from — a row whose fingerprints no longer match its inputs'' is stale, which is a read (preflight counts them), not a trigger. produced_by is the pass; recipe is a JSON object carrying a boolean `deterministic` (what rebuild_derived reads, migration 063: a re-derivation the database owns against a re-run a worker owns) and the producer''s own record — model, prompt_version, prompt_hash, window parameters; `legacy: true` on a row 061 backfilled, `declared: false` where a caller sent no recipe. stale_since and stale_reason (063) carry a rebuild''s request for a re-run until the producer writes the row again. No foreign key: thoughts_drop_derivations, supersession_proposals_drop_derivation, page_sections_drop_derivations, thought_facets_drop_relation_derivation and thought_facets_drop_subject_derivation drop the rows a deleted thought, proposal, section, relation or subject keyed; rebuild_derived deletes a row whose artifact is gone while its thought stands. Migrations 061, 063, 064, 084, 111 / SMD-1731, SMD-1732, SMD-1812, SMD-1873, SMD-3306.';
