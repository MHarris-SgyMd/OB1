-- =============================================================================
-- Migration 149: rebuild_derived hands a stale tags row to the re-tag
--                worker's pool — the metadata arm requeues under
--                ob1_config.retag_key when db/retag.ts has recorded one
--                (SMD-2298)
-- =============================================================================
--
-- WHY
--   063's rebuild_derived finds a tags row (derivations, artifact_kind
--   metadata) stale when its thought's text moved, and could only mark it:
--   "the tags have no pool", counted unqueued. SMD-2298's PR 1b gave the tags
--   a pool — db/retag.ts, which records its key in ob1_config.retag_key on
--   its first writing run — but nothing fed it between runs: each run found
--   the marked rows itself. A text move now reaches the worker as an
--   extraction does its own.
--
-- WHAT
--   * rebuild_derived — 067's body, under its signature, with one change:
--     the metadata arm marks the row as before and, when ob1_config.retag_key
--     names a key, requeues the thought under it (requeue_thought_work, once
--     a call, the key counted in `pools`, the row in `enqueued`), as the
--     extraction arm does under entity_extraction_key. With no key recorded
--     the row is marked alone and counted unqueued, as before. A new
--     sentinel names the rule, and the comment says it.
--
-- NOT HERE
--   * The worker's own pooling stays: db/retag.ts's run still pools what no
--     rebuild marks — a thought tagged before 061 with no row, a capture
--     that fell back, a row at other text that no rebuild walked (a raw
--     text move nobody rebuilt).
--   * Preflight's retag rows and the prompt version's --switch (SMD-2298
--     PR 3); a sleep pass (PR 4).
--   * A requeue revokes a live lease on the thought, as every arm's does:
--     the holder's write meets STALE_READ (the text moved under it) and its
--     release returns false.
--
-- SAFETY
--   One function redefined under its own signature; its comment. MINOR:
--   nothing changes shape, no data step: rows marked before this file stay
--   marked, and db/retag.ts's next run pools them. EXECUTE as before
--   (CREATE OR REPLACE keeps the grants). Re-applying 067, or 063, puts the
--   older arm back; this file, applied after it, restores it (`bun
--   migrate.ts --reapply` restores every file).
--
-- Prerequisites
--   067 (the six-argument rebuild_derived this file carries; 063's mark,
--   061's lineage writer) and 016 (requeue_thought_work). Applied by `bun
--   db/migrate.ts`.
--
-- Idempotent: CREATE OR REPLACE.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape). Every probe names an object that stands on a brain at
-- this file too, so a --reapply passes.
DO $qc$
BEGIN
  IF to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NULL
     OR to_regprocedure('requeue_thought_work(text, uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('derivations') AND attname = 'stale_since' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 149 needs 063 and 067 (rebuild_derived, the mark''s columns) and 016 (requeue_thought_work); this schema lacks one',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- rebuild_derived — 067's body; the tags' arm feeds the re-tag pool.
-- ---------------------------------------------------------------------------
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
  v_cfg_retag    text;               -- 149: db/retag.ts's recorded key, the tags' pool; NULL where unset
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
  SELECT NULLIF(value, '') INTO v_cfg_retag FROM ob1_config WHERE key = 'retag_key';

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
        -- ob1:tags-requeued-under-retag-key — a CONTRACT SENTINEL, not prose
        -- (the 014 convention). 149 (SMD-2298): marked, and handed to the
        -- re-tag worker's pool when db/retag.ts has recorded its key
        -- (ob1_config.retag_key), as the extraction arm hands an extract:
        -- row to entity_extraction_key's; the worker's write settles the row
        -- (148). With no key recorded, marked alone, unqueued, as before.
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked := v_marked + 1;
        IF v_cfg_retag IS NULL THEN
          v_unqueued := v_unqueued + 1;
        ELSIF NOT ((v_cfg_retag || '|' || v_a.id::text) = ANY(v_claims)) THEN
          PERFORM requeue_thought_work(v_cfg_retag, v_a.id);
          v_claims := v_claims || (v_cfg_retag || '|' || v_a.id::text);
          v_enqueued := v_enqueued + 1;
          IF NOT (v_cfg_retag = ANY(v_pools)) THEN v_pools := v_pools || v_cfg_retag; END IF;
        END IF;
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
         AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id);
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
  'The one primitive over the lineage table (SMD-1732, Phase 1c of SMD-1729): walks `derivations` forward from p_input (derivation_descendants) and acts on every descendant. A row whose artifact is gone is deleted. With the input standing, a row whose inputs'' fingerprints moved (or p_force) is: re-derived when the database can — a vector whose current text has a snapshot row at the model, by ob1_refresh_thought_vector (rebuilt); otherwise handed to the worker that owns the recipe through requeue_thought_work under the worker''s current key — the reembed pool for a vector or the windows, the extraction key for an extract: pass, the judge''s key — with stale_since/stale_reason set on the lineage row (marked; the first request standing is kept) — and, since 149 (SMD-2298), the tags'' row to db/retag.ts''s pool under ob1_config.retag_key when one is recorded (marked alone, unqueued, when not) — and, for a pending proposal or one the consolidation pass itself rejected (a review_note beginning ''settled by the pass:'', 067), its status set stale with reviewed_at and the note cleared (the status is the mark; stale_proposals; the next pass replaces the row when it finds the conflict again and settles it when it does not); under p_force a vector whose text did not move, at the configured model, is re-recorded, not re-embedded (one at another model goes to the pool); a source: pass and a person''s decision on a proposal are kept; a generated page section (064) is marked with no pool, as the tags were before 149; an unmoved row is current. With p_input_gone (SMD-1723''s forget, called BEFORE the row delete in its transaction): the windows, the input''s mentions and edges (entities locked first, orphans pruned) and their lineage rows are deleted, the snapshot rows at the input''s own fingerprints and p_fingerprints removed where no standing thought holds them, the proposals and the vector''s and tags'' rows counted for the cascade. derived_from children are listed as irreproducible. Refuses an empty reason; answers a replay with REPLAYING and a missing input with NOT_FOUND. Takes the supersession advisory lock, then the input''s row. With p_orphans_only (the sweep''s mode) only the orphan rule runs. Returns {ok, input, reason, input_gone, force, orphans_only, walked, depth, at_cap, rebuilt, enqueued, deleted, marked, unqueued, stale_proposals, kept, current, legacy, irreproducible, cascading, pools}. Migrations 063, 067, 149 / SMD-1732, SMD-2297, SMD-2298.';
