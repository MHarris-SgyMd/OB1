-- =============================================================================
-- Migration 063: rebuild_derived — the one primitive over the lineage table:
--                walk `derivations` forward from an input and, for every
--                descendant, re-derive what the database can, hand the rest
--                to the leased workers with the reason marked on the row,
--                delete what has no artifact, and report what cannot be
--                reproduced (SMD-1732; Phase 1c of SMD-1729)
-- =============================================================================
--
-- WHY
--   061 (SMD-1731) gave every derived artifact a lineage row — its inputs at
--   their fingerprints, the pass, the recipe with its `deterministic` flag —
--   and a GIN index on input_ids "for the forward walk", naming this file as
--   the walker: "SMD-1732's rebuild_derived (not built; this table is what it
--   will walk)". Staleness has been a READ since 061 (a row whose recorded
--   fingerprint differs from its input's current one); preflight counts the
--   stale rows and nothing re-derives them. docs/event-log-as-truth.md states
--   the contract this file meets: "walk the lineage forward and re-derive or
--   delete every descendant — chunks, entities, proposals, the snapshot row
--   for that fingerprint — and report what it could not reproduce", and 060's
--   header names the snapshot row's removal as this ticket's arm of the
--   forgetting rule. Behind this file stand SMD-1723's forget (a tombstone,
--   then a rebuild), SMD-1734's trust propagation (the walk, reused),
--   SMD-2243's invalidate-on-supersession and SMD-1794's sleep scheduler.
--
-- WHAT THE DATABASE CAN AND CANNOT RE-RUN
--   `deterministic: true` on a recipe means "reproducible from the recipe",
--   not "runnable in plpgsql". The windows need the splitter and the
--   embedder, a vector needs the model, an extraction and a judgement need a
--   language model, the tags need the server's extractor. The ONE
--   re-derivation this database owns: a vector whose current text already has
--   a row in 060's snapshot at the recipe's model — restored by
--   ob1_refresh_thought_vector (a projection refresh: no event, no
--   updated_at; the vector trigger re-records the lineage row). Everything
--   else is HANDED to the workers that own the model calls, through 015's
--   pool under 016's requeue_thought_work — which puts a thought (back) in a
--   pool whatever its claim state, revoking a live lease as 016's own
--   content-edit trigger does; the worker's in-flight write may still land and
--   is superseded by the re-run. The pool keys are the workers' CURRENT keys,
--   not the row's: db/extract-entities.ts refuses a job other than
--   ob1_config.entity_extraction_key without --switch-key, and db/reembed.ts
--   drains reembed:<ob1_config.embedding_model>@<embedding_dim>, so a row's
--   own key is the fallback where the config records none; a proposal's judge
--   key is db/consolidate.ts's job by construction (029). The tags have no
--   pool — no worker re-tags — so their rows are marked and reported, nothing
--   more (the open item docs/event-log-as-truth.md names; the mark waits for
--   a pool).
--
-- WHAT
--   1. THE MARK. `derivations` gains stale_since and stale_reason, both
--      nullable: "a rebuild asked for a re-run of this row, when and why".
--      Not staleness — that stays the fingerprint read — but the request, so
--      preflight can count what awaits a worker and an operator can read why.
--      The FIRST request standing is the one kept: a later rebuild over the
--      same row (an orphan sweep after an edit) leaves the earlier reason and
--      time in place (run-it, the build: the sweep overwrote "edit" with its
--      own name).
--      ob1_record_derivation is redefined on 061's body plus one line: the
--      upsert a producer's re-run makes CLEARS the mark. A chunks row is
--      deleted and rewritten by its writer (061: 'capture' then 'edit'), so
--      its mark goes with the row.
--   2. THE `stale` PROPOSAL STATUS. A pair cannot be judged again while its
--      proposal row stands in any status — 029's consolidation_candidates
--      leaves such pairs out and record_supersession_proposal inserts nothing
--      on the pair — and 029's status CHECK admitted pending, accepted and
--      rejected. The maintainer chose a fourth status over a delete (029's
--      posture: no DELETE in its file; a verdict is a record) and over a mark
--      alone (which would leave the pair unjudgeable). The CHECK is widened;
--      the pairing CHECK reads "unreviewed" as pending OR stale;
--      consolidation_candidates yields a pair whose proposal is stale;
--      record_supersession_proposal (061's body) REPLACES a stale row in place
--      — verdict, confidence, reason, similarity, judge key, both fingerprints,
--      judged_at, back to pending — and re-records its lineage row (the old
--      one dropped first: the key may have moved, and 061's UNIQUE is per
--      key), which clears the mark; a non-stale conflict still records nothing
--      (the first judgement stands). review_supersession_proposal (036's body)
--      is untouched: it refuses only an accepted row on accept and takes any
--      other status, so a stale row is a reviewer's to accept — with p_force,
--      since its fingerprints have moved — or reject. list_supersession_proposals
--      takes any status text; 'stale' lists them.
--   3. THE WALK. derivation_descendants(input, max_depth, node_cap): 026's
--      shape — an iterative, level-by-level walk in plpgsql with a WALK-GLOBAL
--      seen set, never a recursive CTE (026's header says why: a CTE's visited
--      set is per path, and a dense graph multiplies). Per level one GIN probe,
--      `input_ids && frontier`, yields the lineage rows the frontier fed —
--      the ACTIONS — and their artifacts join the next frontier once; a
--      thought's derived_from children (025) are yielded as PROSE rows and
--      not expanded: their text did not change, so their own artifacts are
--      current, and their recipe is a person's or a model's synthesis no
--      rebuild can re-run — the limit the epic names. Said plainly: on the
--      graph the producers write today the walk is ONE level deep (every
--      mechanical artifact's inputs are thoughts — a proposal's two, the rest
--      the thought itself — and a proposal is a leaf), so level order is
--      topological order; the depth clamp (1..10), the node cap (1..2000) and
--      the seen set are for a producer that one day records an artifact fed by
--      another artifact, and the deferral such a chain would need (act on a
--      node only when none of its inputs is still in the frontier) is the
--      extension point, named and not built. The seen set is exercised by
--      every real row today: a thought's own rows name the thought as their
--      input — the self-loop the set guards.
--   4. THE PRIMITIVE. rebuild_derived(input, reason, input_gone, fingerprints,
--      force) → jsonb. SECURITY INVOKER as every function here. Refuses an
--      empty reason (invalid_parameter_value); answers a replay
--      (ob1.projecting_replay = 'on') with {ok:false, error:'REPLAYING'} — a
--      rebuild is a live operation, and SMD-2117's fold copies this table
--      rather than rebuilding through it — and a missing input with NOT_FOUND.
--      Locks in delete_thought's order (036, 060): the supersession advisory
--      lock FIRST and unconditionally (the primitive moves proposal rows, and
--      review_supersession_proposal holds that lock before it touches a
--      thought — taking the thought first would be the two-function cycle 036
--      removed), then the input's row FOR NO KEY UPDATE; no fingerprint lock
--      (033's order: supersession before row). The walk is held whole before
--      anything moves (a plpgsql set-returning function materialises its rows;
--      026's rule — act on a frontier you hold, never on a cursor over rows
--      you are deleting under it). Per row, ORPHAN rules run before STALE
--      rules: a row whose artifact is gone — a chunks row with no windows, an
--      entities row with no standing mention or edge under its key, a vector
--      row on a NULL embedding (the vector trigger returns under a replay
--      before its NULL arm, so a replayed clear leaves the row), a metadata
--      row on a thought with neither type nor topics — is deleted, the
--      direction 061's record handed this file (preflight did not check it);
--      and the vector refresh is gated on a vector standing, since
--      ob1_refresh_thought_vector refuses a vector onto a row without one
--      (OB002 — inside a forget's transaction that would roll the forget back).
--      THE INPUT STANDING: a row is stale when any input's recorded
--      fingerprint differs from its current one or the input has no row
--      (--force treats every row as stale: 061 backfilled at the CURRENT text,
--      so a legacy row reads current for ever — the report counts them).
--      Stale, by kind: a vector with a snapshot row at (current fingerprint,
--      model) is REBUILT by the refresh, the vector trigger re-recording the
--      row — unless the snapshot's vector is the one the row already carries:
--      060's snapshot trigger records the standing vector under the new key
--      when a raw writer moves the text and leaves the vector, so an identical
--      vector is the raw writer's copy, not the text's, and restoring it would
--      launder the staleness the census reads (run-it, the build); a vector
--      without a usable snapshot row and the windows are
--      ENQUEUED under the reembed key and marked (no configured model or
--      width: marked alone, the reason named); an extraction under an
--      `extract:` key is enqueued under the configured extraction key and
--      marked, a `source:` pass is KEPT (its input is the external record, not
--      the text); a pending proposal is set stale, marked, and its newer
--      thought requeued under the judge's key, a decided one KEPT (a
--      reviewer's decision; the queue already says edited-since); the tags
--      are marked, a pool named as missing. Enqueued counts distinct
--      (pool, thought) — the vector and the windows share one reembed claim.
--      The workers' order across pools is their own: a requeued judgement may
--      run before the requeued extraction lands and find no shared entity for
--      the pair; the next pass finds it.
--      THE INPUT LEAVING (input_gone; SMD-1723's forget calls this after its
--      tombstone or redaction event and BEFORE the row delete, in one
--      transaction — after the delete 061's drop trigger leaves nothing to
--      walk): a recipe consumes all its inputs, so every mechanical artifact
--      keyed by the input goes. The windows and their row are deleted. The
--      graph in the worker's lock order — the touched entities locked FIRST,
--      then the input's edges and mentions deleted, then the entities left
--      with no mention and no edge pruned (016's rule; the ticket's "re-counts
--      the entity"), then the input's entities lineage rows deleted — so a
--      worker writing the same thought waits on the entity lock and finds its
--      rows gone (a deadlock would otherwise be possible: the worker holds
--      an entity from its upsert and waits on a mention row this function
--      deleted; 036's residue: a 40P01 inside a forget is retryable). The
--      proposals naming the input are COUNTED, not deleted: 029's cascade
--      takes them at the caller's row delete (a referential action needs no
--      grant, and 029's file forbids a DELETE); so are the vector's and the
--      tags' lineage rows, 061's drop trigger's at the same moment. The
--      snapshot rows at the input's fingerprints are deleted — the current
--      one, the input's OWN position on its lineage rows (a proposal's row
--      carries both thoughts' fingerprints; taking every element would remove
--      the other thought's vector), and the caller's `fingerprints` (earlier
--      texts' fingerprints live only in the log, which the forget reads before
--      it redacts) — minus any fingerprint a standing thought other than the
--      input still holds (018's twins; a snapshot row "outlives the thought it
--      came from on purpose", 060). Derived_from children are listed as
--      irreproducible; SMD-1723 strips the pointer.
--      THE REPORT: {ok, input, reason, input_gone, force, walked, depth,
--      truncated, rebuilt, enqueued, deleted, marked, unqueued, kept, current,
--      legacy, irreproducible: [ids], cascading: {proposals, lineage_rows},
--      pools: [keys]} — the ticket's four counts and what makes the zeros
--      honest: `kept` and `current` say why nothing moved, `unqueued` says a
--      mark waits for a pool, `pools` says what an operator drains
--      (db/rebuild.ts prints the commands).
--
-- SAFETY
--   Additive: two nullable columns on derivations; one CHECK widened and one
--   rewritten on supersession_proposals (no row is refused that was admitted
--   before: every pending, accepted and rejected row satisfies both); two
--   functions added; three bodies redefined on their own text with no arity
--   change (ob1_record_derivation, consolidation_candidates,
--   record_supersession_proposal — CREATE OR REPLACE keeps each ACL).
--   record_supersession_proposal keeps 061's sentinel and its call to the
--   writer, so preflight's producer probe still counts six current bodies.
--   Nothing runs at apply time but the DDL. Every DELETE names its rows in its
--   own WHERE (the rail check-fork-consistency's check 21 reads). Nothing here
--   runs under a replay. thoughts is untouched: no column, no trigger; the
--   only write to it is ob1_refresh_thought_vector's, the projection refresh
--   060 defined. The primitive is SECURITY INVOKER: a role that runs it needs
--   the tables it touches — the capture group (derivations, thought_chunks,
--   thoughts), the worker group (thought_work_claims, supersession_proposals,
--   and from this file DELETE on ob1_embedding_snapshot), the extraction group
--   (the entity tables) and SELECT on ob1_config (db/config.mjs; `migrate.ts
--   --grant` issues every group). MINOR under FORK.md's version rules.
--   Measured on a read-only copy of the dogfood brain (1,025 thoughts, 2,472
--   lineage rows, 15,520 mentions, 12,057 edges; PostgreSQL 16): the walk
--   from the most-fed thought 3.3 ms, a rebuild on it 3-4 ms whatever the
--   arm, every thought in turn 523 ms for 1,025 calls, the orphan census
--   36 ms (changes/smd-1732.md has the table).
--
-- Prerequisites
--   016 (requeue_thought_work, the entity tables), 029 (supersession_proposals,
--   consolidation_candidates), 060 (ob1_refresh_thought_vector,
--   ob1_embedding_snapshot), 061 (derivations, ob1_record_derivation, the
--   11-argument record_supersession_proposal this file carries). Applied by
--   `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape): the bodies below are plpgsql and would fail at their
-- first call with a bare "does not exist" otherwise. Every probe names an
-- object that stands on a brain at this file too, so a --reapply passes.
DO $qc$
BEGIN
  IF to_regprocedure('requeue_thought_work(text, uuid)') IS NULL OR to_regclass('thought_entities') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 016 (requeue_thought_work, the entity tables); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL OR to_regprocedure('consolidation_candidates(uuid, int, float)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 029 (supersession_proposals, consolidation_candidates); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_refresh_thought_vector(uuid, vector, text)') IS NULL
     OR to_regclass('ob1_embedding_snapshot') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 060 (ob1_refresh_thought_vector, ob1_embedding_snapshot); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('derivations') IS NULL
     OR to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL
     OR to_regprocedure('record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 061 (derivations, ob1_record_derivation, the 11-argument record_supersession_proposal); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The mark: a rebuild's request for a re-run, on the row it concerns.
-- ---------------------------------------------------------------------------
ALTER TABLE derivations ADD COLUMN IF NOT EXISTS stale_since  timestamptz;
ALTER TABLE derivations ADD COLUMN IF NOT EXISTS stale_reason text;

COMMENT ON COLUMN derivations.stale_since IS
  'When rebuild_derived asked for this row''s artifact to be re-derived (NULL: no request stands). Not staleness — that is the fingerprint read — but the request: set with stale_reason when the row is handed to a worker''s pool or, with no pool for its kind, marked for the operator; cleared by the producer''s next write of the row (ob1_record_derivation''s upsert). Migration 063 / SMD-1732.';
COMMENT ON COLUMN derivations.stale_reason IS
  'Why rebuild_derived asked for the re-run — the caller''s p_reason (forget, an edit, a trust change, an operator''s sweep). Cleared with stale_since. Migration 063 / SMD-1732.';

COMMENT ON TABLE derivations IS
  'Lineage for every derived artifact (SMD-1731, Phase 1b of SMD-1729): one row per artifact per producing pass, written in the transaction that writes the artifact. artifact_kind names the tier — chunks (a thought''s window set), entities (a thought''s extraction under one extraction_key), proposal (one supersession proposal), vector (a thought''s embedding), metadata (a thought''s capture-time tags); artifact_id is the thought''s id for the four keyed by a thought and the proposal''s id for a proposal. input_ids and input_fingerprints are parallel arrays naming what the artifact was computed from and the text it was computed from — a row whose fingerprints no longer match its inputs'' is stale, which is a read (preflight counts them), not a trigger. produced_by is the pass; recipe is a JSON object carrying a boolean `deterministic` (what rebuild_derived reads, migration 063: a re-derivation the database owns against a re-run a worker owns) and the producer''s own record — model, prompt_version, prompt_hash, window parameters; `legacy: true` on a row 061 backfilled, `declared: false` where a caller sent no recipe. stale_since and stale_reason (063) carry a rebuild''s request for a re-run until the producer writes the row again. No foreign key: thoughts_drop_derivations and supersession_proposals_drop_derivation drop the rows a deleted thought or proposal keyed; rebuild_derived deletes a row whose artifact is gone while its thought stands. Migrations 061, 063 / SMD-1731, SMD-1732.';

-- 061's body, verbatim, plus the two columns the upsert clears: a producer's
-- re-run is the answer to the request the mark records.
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
  'Records one derived artifact''s lineage in `derivations`, upserting on (artifact_kind, artifact_id, produced_by) and moving produced_at: the inputs and their fingerprints (parallel, no NULL), the pass, the recipe (a JSON object with a boolean `deterministic`), the agent. Refuses a bad shape with invalid_parameter_value — a producer that cannot record its lineage does not commit its artifact. Called by the write functions, record_thought_entities, record_supersession_proposal and the vector trigger, in the artifact''s own transaction. Since 063 the upsert clears stale_since and stale_reason: a producer''s write answers a rebuild''s request. Migrations 061, 063 / SMD-1731, SMD-1732.';

-- ---------------------------------------------------------------------------
-- 2. The `stale` proposal status: 029's two CHECKs on status, widened, and
--    the two bodies that read the status — the candidate filter and the
--    writer — redefined on their own text.
-- ---------------------------------------------------------------------------
-- 029 named neither constraint, so each is found by its definition and
-- dropped by name; the two this file adds are named, so a re-apply drops and
-- re-adds them (IF EXISTS) and moves nothing.
DO $st$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'supersession_proposals'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%status = ANY (ARRAY[%'
            OR pg_get_constraintdef(oid) LIKE '%(status = ''pending''::text) = (reviewed_at IS NULL)%')
  LOOP
    EXECUTE format('ALTER TABLE supersession_proposals DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$st$;
ALTER TABLE supersession_proposals DROP CONSTRAINT IF EXISTS supersession_proposals_unreviewed_check;
ALTER TABLE supersession_proposals
  ADD CONSTRAINT supersession_proposals_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'stale'));
-- A stale row is unreviewed, as a pending one is: reviewed_at stays NULL
-- until a reviewer decides it (029's pairing rule, one status wider).
ALTER TABLE supersession_proposals
  ADD CONSTRAINT supersession_proposals_unreviewed_check
    CHECK ((status IN ('pending', 'stale')) = (reviewed_at IS NULL));

COMMENT ON COLUMN supersession_proposals.status IS
  'pending: the judge''s verdict awaits a reviewer. accepted / rejected: the reviewer''s decision (review_supersession_proposal). stale (063, SMD-1732): rebuild_derived found one of the pair''s texts moved since the judge saw them — the verdict is about texts that no longer stand; the pair is judged again by the next consolidation pass, whose record_supersession_proposal replaces this row in place (back to pending), and a reviewer may still accept it with p_force or reject it. Migrations 029, 063.';

-- 029's body, verbatim, plus one condition: a pair whose proposal is stale is
-- a candidate again — the judge's next pass re-proposes it, and the writer
-- below replaces the stale row rather than inserting beside it.
CREATE OR REPLACE FUNCTION consolidation_candidates(
  p_thought_id     uuid,
  p_k              int   DEFAULT 5,
  p_min_similarity float DEFAULT 0
)
RETURNS TABLE (older_id uuid, similarity float, shared_entities int)
LANGUAGE sql
STABLE
AS $$
  WITH me AS (
    SELECT t.id, t.embedding, t.created_at, t.supersedes
      FROM thoughts t
     WHERE t.id = p_thought_id
       AND t.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = t.id)
  ),
  shared AS (
    SELECT b.thought_id, count(DISTINCT a.entity_id)::int AS n
      FROM thought_entities a
      JOIN thought_entities b ON b.entity_id = a.entity_id AND b.thought_id <> a.thought_id
     WHERE a.thought_id = p_thought_id
     GROUP BY b.thought_id
  )
  SELECT o.id,
         1 - (o.embedding <=> me.embedding),
         s.n
    FROM me
    JOIN shared s ON true
    JOIN thoughts o ON o.id = s.thought_id
   WHERE o.embedding IS NOT NULL
     AND (o.created_at AT TIME ZONE 'UTC')::date < (me.created_at AT TIME ZONE 'UTC')::date
     AND o.supersedes IS DISTINCT FROM me.id
     AND me.supersedes IS DISTINCT FROM o.id
     AND NOT EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = o.id)
     -- 063: a stale proposal does not hold the pair — the pass judges it again.
     AND NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.older_id = o.id AND p.newer_id = me.id AND p.status <> 'stale')
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
   ORDER BY o.embedding <=> me.embedding, o.id
   LIMIT GREATEST(COALESCE(p_k, 5), 1)
$$;

COMMENT ON FUNCTION consolidation_candidates(uuid, int, float) IS
  'The older thoughts a thought is judged against for a supersession: sharing at least one entity (016), captured at least a calendar day (UTC) earlier, nearest by exact cosine, at or above p_min_similarity, at most p_k; pairs already proposed and thoughts already superseded are left out — since 063 a pair whose proposal is stale (rebuild_derived found a text moved) is judged again. Migrations 029, 063.';

-- 061's body, verbatim, plus the stale replacement: the pair's stale row is
-- locked, its lineage row dropped (the judge key may have moved, and 061's
-- UNIQUE is per key), and the INSERT's conflict arm rewrites the row back to
-- pending — a conflict on any other status still writes nothing.
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
  v_stale    uuid;
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
  -- 063: a stale row on the pair is this judgement's to replace. Locked here
  -- so two judges of one pair serialise; its lineage row goes first (the key
  -- may differ from the one that stands), and the conflict arm below rewrites
  -- the row (SMD-1732).
  SELECT id INTO v_stale FROM supersession_proposals
   WHERE older_id = p_older_id AND newer_id = p_newer_id AND status = 'stale'
   FOR UPDATE;
  IF v_stale IS NOT NULL THEN
    DELETE FROM derivations WHERE artifact_kind = 'proposal' AND artifact_id = v_stale;
  END IF;
  INSERT INTO supersession_proposals (older_id, newer_id, verdict, confidence, reason, similarity, judge_key, canonical_agent_id, older_fingerprint, newer_fingerprint)
  VALUES (p_older_id, p_newer_id, p_verdict,
          LEAST(GREATEST(COALESCE(p_confidence, 0), 0), 1),
          p_reason, p_similarity, p_judge_key, p_agent_id,
          v_fp_older, v_fp_newer)
  ON CONFLICT (older_id, newer_id) DO UPDATE
    SET verdict            = EXCLUDED.verdict,
        confidence         = EXCLUDED.confidence,
        reason             = EXCLUDED.reason,
        similarity         = EXCLUDED.similarity,
        judge_key          = EXCLUDED.judge_key,
        canonical_agent_id = EXCLUDED.canonical_agent_id,
        older_fingerprint  = EXCLUDED.older_fingerprint,
        newer_fingerprint  = EXCLUDED.newer_fingerprint,
        judged_at          = now(),
        status             = 'pending'
    WHERE supersession_proposals.status = 'stale'
  RETURNING id INTO v_id;
  -- ob1:derivation-recorded-with-its-artifact — a CONTRACT SENTINEL, not prose
  -- (the 014 convention); preflight's `lineage` reads it. 061: the
  -- proposal's lineage row commits with the proposal (SMD-1731): both
  -- inputs at the fingerprints the judge saw, the judge's key and recipe.
  -- A pair already judged inserts nothing and records nothing — the first
  -- judgement's row stands; a stale one is replaced and recorded again (063).
  IF v_id IS NOT NULL THEN
    PERFORM ob1_record_derivation('proposal', v_id, ARRAY[p_older_id, p_newer_id], ARRAY[v_fp_older, v_fp_newer], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', false, 'key', p_judge_key, 'declared', false)),
                                  p_agent_id);
  END IF;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text, jsonb) IS
  'Record one conflict the pass found, pending review, with 016''s fingerprint of each text as the judge saw it (NULL: as of the write). Returns the new row''s id, or NULL when the pair already has a row in any state but stale — a stale row (063: rebuild_derived found a text moved) is replaced in place, back to pending, and its id returned. Since 061 a recorded proposal''s lineage row is written with it in `derivations` (artifact_kind proposal, the proposal''s id, inputs the two thoughts at those fingerprints, produced_by the judge key, p_recipe or the key alone marked undeclared); a replaced row''s old lineage row goes first. Migrations 029, 061, 063 / SMD-1294, SMD-1731, SMD-1732.';

-- ---------------------------------------------------------------------------
-- 3. The walk.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION derivation_descendants(
  p_input     uuid,
  p_max_depth int DEFAULT 3,
  p_node_cap  int DEFAULT 2000
)
RETURNS TABLE (
  derivation_id      uuid,
  artifact_kind      text,
  artifact_id        uuid,
  produced_by        text,
  input_ids          uuid[],
  input_fingerprints text[],
  recipe             jsonb,
  stale_since        timestamptz,
  depth              int,
  prose              boolean
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_max_depth int    := GREATEST(1, LEAST(COALESCE(p_max_depth, 3), 10));
  v_node_cap  int    := GREATEST(1, LEAST(COALESCE(p_node_cap, 2000), 2000));
  v_seen      uuid[];   -- every node discovered so far; WALK-GLOBAL (026)
  v_frontier  uuid[];   -- the nodes whose descendants this level yields
  v_next      uuid[];   -- the artifacts not yet seen, the next frontier
  v_prose     uuid[];   -- the derived_from children found this level
  v_depth     int    := 0;
  v_emitted   int    := 0;
  v_rows      int;
  -- ob1:derivation-walk-bounded — a CONTRACT SENTINEL (the 014 convention),
  -- read by db/test-schema.ts: this walk expands each node once through a
  -- walk-global seen set and stops at its clamps — 026's bound, which a
  -- per-path recursive CTE cannot give. A redefinition keeps the property and
  -- this string, or the test fails.
BEGIN
  IF p_input IS NULL THEN RETURN; END IF;
  v_seen     := ARRAY[p_input];
  v_frontier := ARRAY[p_input];

  WHILE v_depth < v_max_depth
        AND v_frontier IS NOT NULL AND array_length(v_frontier, 1) > 0
        AND v_emitted < v_node_cap LOOP
    v_depth := v_depth + 1;

    -- The lineage rows this frontier fed: one GIN probe (`&&`, array_ops).
    -- Kind order is the primitive's order of action, then the artifact and
    -- the pass — deterministic, so a cap truncates the same way twice.
    RETURN QUERY
      SELECT d.id, d.artifact_kind, d.artifact_id, d.produced_by, d.input_ids, d.input_fingerprints, d.recipe, d.stale_since, v_depth, false
        FROM derivations d
       WHERE d.input_ids && v_frontier
       ORDER BY array_position(ARRAY['vector', 'chunks', 'entities', 'proposal', 'metadata'], d.artifact_kind), d.artifact_id, d.produced_by
       LIMIT (v_node_cap - v_emitted);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_emitted := v_emitted + v_rows;
    IF v_emitted >= v_node_cap THEN EXIT; END IF;

    -- The frontier's derived_from children (025's pointer, its GIN): prose,
    -- listed once and not expanded — their text did not move.
    SELECT array_agg(DISTINCT t.id) INTO v_prose
      FROM unnest(v_frontier) AS w(node)
      JOIN thoughts t ON t.derived_from @> jsonb_build_array(w.node::text)
     WHERE NOT (t.id = ANY(v_seen));
    IF v_prose IS NOT NULL THEN
      RETURN QUERY
        SELECT NULL::uuid, 'thought'::text, c.id, 'derived_from'::text,
               (SELECT array_agg(w.node) FROM unnest(v_frontier) AS w(node) WHERE c.derived_from @> jsonb_build_array(w.node::text)),
               NULL::text[], NULL::jsonb, NULL::timestamptz, v_depth, true
          FROM thoughts c
         WHERE c.id = ANY(v_prose)
         ORDER BY c.id
         LIMIT (v_node_cap - v_emitted);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_emitted := v_emitted + v_rows;
      v_seen := v_seen || v_prose;
    END IF;

    -- The next frontier: the artifacts this level yielded that are not yet
    -- seen. A thought's own rows name the thought — already seen, so the
    -- self-loop ends here; a proposal's id enters and feeds nothing (nothing
    -- records a proposal as an input today), which is one empty probe.
    SELECT array_agg(DISTINCT d.artifact_id) INTO v_next
      FROM derivations d
     WHERE d.input_ids && v_frontier
       AND NOT (d.artifact_id = ANY(v_seen));
    v_seen     := v_seen || COALESCE(v_next, ARRAY[]::uuid[]);
    v_frontier := COALESCE(v_next, ARRAY[]::uuid[]);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION derivation_descendants(uuid, int, int) IS
  'Walks `derivations` FORWARD from an input: every lineage row the input (and, level by level, the artifacts those rows produced) fed, with the row''s inputs, fingerprints, recipe and mark, at its depth; and the input''s derived_from children (025) as prose rows (artifact_kind thought, produced_by derived_from, prose true), listed once and not expanded. 026''s shape: an iterative level-by-level walk with a walk-global seen set, each node expanded once (a thought''s own rows name the thought — the self-loop the set guards); depth clamped 1..10 (default 3), rows capped 1..2000 (default 2000), the same order every time (kind, artifact, pass). On the graph the producers write today the walk is one level deep; the clamps are for a producer that one day records an artifact fed by another artifact. Read by rebuild_derived, and by SMD-1734''s trust propagation. Migration 063 / SMD-1732.';

-- ---------------------------------------------------------------------------
-- 4. The primitive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebuild_derived(
  p_input        uuid,
  p_reason       text,
  p_input_gone   boolean DEFAULT false,
  p_fingerprints text[]  DEFAULT NULL,
  p_force        boolean DEFAULT false
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
  SELECT value INTO v_cfg_model FROM ob1_config WHERE key = 'embedding_model';
  SELECT value INTO v_cfg_dim   FROM ob1_config WHERE key = 'embedding_dim';
  SELECT value INTO v_cfg_key   FROM ob1_config WHERE key = 'entity_extraction_key';

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
      v_irre := v_irre || v_row.artifact_id;
      CONTINUE;
    END IF;

    -- The artifact's thought (the proposal's is the pair; read below).
    IF v_row.artifact_kind <> 'proposal' THEN
      SELECT t.id, t.content, t.content_fingerprint, t.embedding, t.embedding_model, t.metadata
        INTO v_a FROM thoughts t WHERE t.id = v_row.artifact_id;
      v_a_found := FOUND;
    END IF;

    -- ORPHAN rules first: a row whose artifact is gone names nothing to
    -- re-derive, and a vector row on a NULL embedding must never reach the
    -- refresh (OB002 would roll a forget back).
    v_orphan := CASE v_row.artifact_kind
      WHEN 'chunks'   THEN NOT EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = v_row.artifact_id)
      WHEN 'entities' THEN NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = v_row.artifact_id AND m.extraction_key = v_row.produced_by)
                       AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = v_row.artifact_id AND g.extraction_key = v_row.produced_by)
      WHEN 'vector'   THEN NOT v_a_found OR v_a.embedding IS NULL
      WHEN 'metadata' THEN NOT v_a_found OR NOT (v_a.metadata ? 'type' OR v_a.metadata ? 'topics')
      WHEN 'proposal' THEN NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.id = v_row.artifact_id)
      ELSE false END;
    IF v_orphan THEN
      DELETE FROM derivations WHERE id = v_row.derivation_id;
      v_deleted := v_deleted + 1;
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
                 AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id);
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
    v_stale := p_force
            OR (p_input_gone AND p_input = ANY(v_row.input_ids))
            OR EXISTS (SELECT 1 FROM unnest(v_row.input_ids, v_row.input_fingerprints) AS u(iid, ifp)
                         LEFT JOIN thoughts t ON t.id = u.iid
                        WHERE t.id IS NULL
                           OR u.ifp IS DISTINCT FROM COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)));
    IF NOT v_stale THEN
      v_current := v_current + 1;
      CONTINUE;
    END IF;

    CASE v_row.artifact_kind
      WHEN 'vector' THEN
        v_cur   := COALESCE(v_a.content_fingerprint, content_fingerprint_of(v_a.content));
        v_model := COALESCE(v_row.recipe->>'model', v_a.embedding_model, v_cfg_model);
        -- A usable snapshot row: the current text at the model, holding a
        -- vector OTHER than the one the row carries. An identical vector is
        -- not the new text's: 060's snapshot trigger records the standing
        -- vector under the row's key when a raw writer moves the text and
        -- leaves the vector, so that row is the raw writer's copy (a model
        -- does not embed two texts to the same vector), and restoring it
        -- would launder the staleness the census exists to see (061's first
        -- review pass named the same trap on the vector trigger) — run-it,
        -- the build: the smoke's raw move "rebuilt" its own stale vector.
        v_snap_ok := v_model IS NOT NULL AND EXISTS (
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
        SELECT p.id, p.status, p.newer_id, p.judge_key INTO v_p
          FROM supersession_proposals p WHERE p.id = v_row.artifact_id FOR UPDATE;
        IF v_p.status IN ('pending', 'stale') THEN
          IF v_p.status = 'pending' THEN
            UPDATE supersession_proposals SET status = 'stale' WHERE id = v_p.id AND status = 'pending';
          END IF;
          UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
          v_marked := v_marked + 1;
          v_pool := v_p.judge_key;
          IF NOT ((v_pool || '|' || v_p.newer_id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_p.newer_id);
            v_claims := v_claims || (v_pool || '|' || v_p.newer_id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        ELSE
          -- A reviewer's decision stands; the queue says edited-since.
          v_kept := v_kept + 1;
        END IF;
      WHEN 'metadata' THEN
        -- No pool re-tags a thought: marked for the operator, nothing more.
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked   := v_marked + 1;
        v_unqueued := v_unqueued + 1;
      ELSE
        v_kept := v_kept + 1;
    END CASE;
  END LOOP;

  -- The input leaving: the snapshot rows at its fingerprints (060 names this
  -- file as their removal path).
  IF p_input_gone AND v_fps IS NOT NULL THEN
    DELETE FROM ob1_embedding_snapshot WHERE content_fingerprint = ANY(v_fps);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'input', p_input, 'reason', p_reason, 'input_gone', p_input_gone, 'force', p_force,
    'walked', v_walked, 'depth', v_depth, 'truncated', v_walked >= 2000,
    'rebuilt', v_rebuilt, 'enqueued', v_enqueued, 'deleted', v_deleted,
    'marked', v_marked, 'unqueued', v_unqueued, 'kept', v_kept, 'current', v_current, 'legacy', v_legacy,
    'irreproducible', to_jsonb(v_irre),
    'cascading', jsonb_build_object('proposals', v_casc_prop, 'lineage_rows', v_casc_rows),
    'pools', to_jsonb(v_pools));
END;
$$;

COMMENT ON FUNCTION rebuild_derived(uuid, text, boolean, text[], boolean) IS
  'The one primitive over the lineage table (SMD-1732, Phase 1c of SMD-1729): walks `derivations` forward from p_input (derivation_descendants) and acts on every descendant. A row whose artifact is gone is deleted. With the input standing, a row whose inputs'' fingerprints moved (or p_force) is: re-derived when the database can — a vector whose current text has a snapshot row at the model, by ob1_refresh_thought_vector (rebuilt); otherwise handed to the worker that owns the recipe through requeue_thought_work under the worker''s current key — the reembed pool for a vector or the windows, the extraction key for an extract: pass, the judge''s key for a pending proposal, which is set stale (enqueued) — with stale_since/stale_reason set on the row (marked; the tags have no pool: unqueued); a source: pass and a decided proposal are kept; an unmoved row is current. With p_input_gone (SMD-1723''s forget, called BEFORE the row delete in its transaction): the windows, the input''s mentions and edges (entities locked first, orphans pruned) and their lineage rows are deleted, the snapshot rows at the input''s own fingerprints and p_fingerprints removed where no standing thought holds them, the proposals and the vector''s and tags'' rows counted for the cascade. derived_from children are listed as irreproducible. Refuses an empty reason; answers a replay with REPLAYING and a missing input with NOT_FOUND. Takes the supersession advisory lock, then the input''s row. Returns {ok, input, reason, input_gone, force, walked, depth, truncated, rebuilt, enqueued, deleted, marked, unqueued, kept, current, legacy, irreproducible, cascading, pools}. Migration 063 / SMD-1732.';
