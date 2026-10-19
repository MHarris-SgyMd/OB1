-- =============================================================================
-- Migration 100: the consolidation judge's distinct is stored — 084's
--                relation vocabulary gains `distinct`, so a pair the judge
--                calls unrelated (two near neighbours about different
--                subjects) is a standing relation on the newer thought,
--                kept and counted, where until now the verdict only closed
--                the pair's edge (SMD-3117)
-- =============================================================================
--
-- WHY
--   Every pair the consolidation pass judges is a near neighbour (029's
--   candidate rule), so an unrelated verdict says two look-alikes are about
--   different subjects. 084 stores related, evolves and duplicate as a
--   `relation` facet, and an unrelated verdict only closes the pair's edge:
--   the judgement that the two are apart is lost. Nothing tells a reader, a
--   merge or a later judge, and SMD-3116 — the typed-label spike, which
--   renamed unrelated to distinct (differentiation: look-alikes kept apart,
--   never merged) — has no pool of such pairs to measure. The maintainer
--   decided on 2026-10-19 that the pass records it.
--
-- WHAT
--   * thought_facets_validate — 084's body, with one change: a relation's
--     relation is one of related | evolves | duplicate | distinct.
--   * record_thought_relation — 084's body, with one change: it takes
--     distinct, and its refusal names the four.
--   * The comments on both functions and on thought_facets say so.
--   * Nothing else moves. 084's set per pair stands: one standing relation
--     per pair (the partial unique index), so a re-judge that sees a
--     relation replaces a standing distinct, and one that sees distinct
--     replaces a relation; a delete of either thought closes or drops it
--     (084's triggers); its lineage row is written with it
--     (ob1:relation-lineage-with-its-artifact); the grants are 084's.
--
-- WHO WRITES IT
--   db/consolidate.ts, through server-portable/consolidate.ts's
--   relationVerdict: a well-formed unrelated verdict whose own probability —
--   the word's token probability under the judge, H2O's under decide mode
--   (SMD-3115), where only H2O's own top unrelated counts, not one taken
--   after a proposal failed — is at the floor; under it the verdict closes
--   the pair's edge, as before. Prompt 4's word stays unrelated, so no pass
--   key moves.
--
-- NOT HERE
--   * A pair judged unrelated before this file has no distinct row: nothing
--     recorded the verdict. It gains one when the pass judges it again.
--   * Keeping distinct apart from the relations a reader counts: board
--     findings never post one, brain_info and --status count it on its
--     own, and --list relations leaves it out (SMD-3117) — code, not this
--     file.
--   * Skipping the re-judge of a pair whose distinct stands at the texts
--     judged, and showing distinct at retrieval: follow-ups if wanted.
--
-- Idempotent: CREATE OR REPLACE and COMMENT ON only.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('thought_facets') IS NULL
     OR to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 100 needs 084 (thought_facets and record_thought_relation); this schema lacks them',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. thought_facets_validate — 084's body; a relation may say distinct
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
    -- ob1:relation-facet (084; distinct since 100)
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
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind. For a citation (042): a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — stores source_id lower-case, locks the source row FOR KEY SHARE; source_id may be null only in the detached shape, which keeps what it lost and is not re-pointed. For a link (053): relation one of references | child_of | blocks | blocked_by | relates_to | duplicate_of, system one lower-case word, target a non-empty identity within it, never the thought''s own (thought_sources); writes origin = structured. For a relation (084): written standing (no valid_until, no superseded_by), relation one of related | evolves | duplicate | distinct (distinct since 100), target an existing thought (locked FOR KEY SHARE) that is not the thought itself, stored lower-case, judge_key a non-empty string of at most 200 characters, confidence a number in 0..1 or absent; writes origin = judged; afterwards only its close (valid_until set, not in the future, every other column as it was) is admitted — no rewrite, re-open or move. Since 084 no facet changes its kind on UPDATE. A pure close of a link passes unjudged. Migrations 042, 053, 084, 100.';

-- ---------------------------------------------------------------------------
-- 2. record_thought_relation — 084's body; it takes distinct
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
  -- ob1:relation-distinct — a CONTRACT SENTINEL, not prose (the 014
  -- convention): this door takes distinct (100, SMD-3117). db/consolidate.ts
  -- reads it to know whether to send the word: 100 keeps 084's signature.
  IF p_relation IS NOT NULL AND p_relation NOT IN ('related', 'evolves', 'duplicate', 'distinct') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_relation: relation must be related, evolves, duplicate, distinct or NULL (close), got %L', p_relation),
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
  'The consolidation pass''s write of one judged relation (SMD-1873 PR 2): a `relation` facet on the newer thought naming the older as target — related, evolves, duplicate, or since 100 distinct (two near neighbours the judge called unrelated: different subjects, kept apart; SMD-3117) — a set per pair under an advisory lock on the pair, both thoughts locked FOR KEY SHARE first. The same relation already standing, by the same judge key at the same confidence, is kept (its lineage row moved to the fingerprints judged now); anything else replaces it (the old edge closed with valid_until, a new one inserted — a relation is never edited); a NULL relation closes the pair''s standing edge, or answers none; a thought gone answers none. Each new edge''s lineage row (artifact_kind relation, inputs older and newer at the fingerprints the judge was sent, produced_by the judge key) is written in the same transaction (ob1:relation-lineage-with-its-artifact). Returns {ok, action: added | kept | replaced | closed | none, id}. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group). Migrations 084, 100 / SMD-1873, SMD-3117.';

-- ---------------------------------------------------------------------------
-- 3. The catalog's copy of the vocabulary
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN thought_facets.payload IS
  'Shaped by kind. citation: text (non-empty), stance (stated | retrieved | inferred), source_id (an existing thought, not thought_id itself, stored lower-case); after the source is deleted, source_id null with source_deleted_id and source_deleted_at set by the guard — a shape a restore may insert whole, and that is never re-pointed at a new source. link (053): relation, system, target (an identity in the system), origin structured. relation (084): relation (related | evolves | duplicate | distinct — distinct since 100), target (the older thought''s id), judge_key, confidence, origin judged; inserted standing only, so a restore re-inserts a closed relation as standing or not at all.';
COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, three kinds registered: citation (042), payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id; link (053), payload {relation, system, target, origin} — a source system''s structured link from the thought to another identity in it; relation (084), payload {relation, target, judge_key, confidence, origin} — the consolidation judge''s related, evolves or duplicate verdict on the thought (the newer) and the target thought (the older), or since 100 its distinct (the pair it called unrelated: two near neighbours about different subjects, kept apart), written once — by record_thought_relation, the consolidation pass''s door, though origin `judged` marks the kind and any role holding INSERT on the table (the structure group) can write one — and only ever closed. Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while valid_until is NULL or future and no facet that still exists supersedes it (thought_facet_active); only active citations make thoughts_guard_citation_sources refuse a delete of their source. Migrations 042, 053, 084, 100 / SMD-1712, SMD-1867, SMD-1873, SMD-3117.';
COMMENT ON TABLE supersession_proposals IS
  'One row per pair of thoughts a consolidation pass judged one to make the other out of date — prompt 4''s "outdates" (SMD-1873; "conflict" under prompts 1 to 3) — with the judge''s verdict on which is current. A pair the judge called related, evolves or duplicate is a `relation` facet (084), not a row here, and so since 100 is a pair it called unrelated, as a distinct relation. Written by db/consolidate.ts; thoughts.supersedes is written only when a reviewer accepts a row through review_supersession_proposal. A pair is recorded once whatever its later status, so a pair a person rejected is never proposed again; a pair the pass itself settled (review_note beginning ''settled by the pass:'', 067) is judged again when a text moves under it, through the stale status (063). Migrations 029, 063, 067, 084, 100 / SMD-1294, SMD-1732, SMD-2297, SMD-1873, SMD-3117.';
