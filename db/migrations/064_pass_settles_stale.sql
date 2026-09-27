-- =============================================================================
-- Migration 064: a stale proposal the consolidation pass no longer finds in
--                conflict is the pass's to settle, and a pass-settled row is
--                the pass's to reopen — rebuild_derived redefined on 063's
--                body (SMD-2297)
-- =============================================================================
--
-- WHY
--   063 (SMD-1732) gave supersession_proposals.status a fourth value, stale:
--   rebuild_derived sets it on a pending proposal when one of the pair's
--   texts moved under the verdict and requeues the newer thought under the
--   judge's key; consolidation_candidates yields a stale pair again;
--   record_supersession_proposal replaces the stale row in place — WHEN the
--   pass finds the conflict again. db/consolidate.ts writes a proposal only
--   for a conflict at or above its confidence floor, so when the edit that
--   made the row stale RESOLVED the conflict — the likely outcome — the pass
--   judged the pair, found none, and wrote nothing: the row stayed stale for
--   ever, unreviewed, counted by --status, by preflight's consolidate-pass
--   row and by db/rebuild.ts --status, listed under --list stale with an
--   --accept … --force / --reject line for a person, and requeued by every
--   later rebuild of either thought. 063's second review pass found the dead
--   end and left the mechanism to this ticket (changes/smd-1732.md).
--
-- WHAT
--   1. THE SETTLE. settle_supersession_proposal(id, note, actor, judge_key,
--      older_fingerprint, newer_fingerprint, recipe, agent) is what
--      db/consolidate.ts calls when a judgement on a pair with a stale row
--      finds no conflict — agree, unrelated, or a conflict under the floor.
--      It refuses a row that is not stale (a pending row is a reviewer's, a
--      decided one is decided) and a note without the marker; it rejects the
--      row through review_supersession_proposal(id, 'reject', note, NULL,
--      actor, false) — whose reject arm (036) checks no status and sets
--      reviewed_at, which 063's unreviewed CHECK requires of a row that
--      leaves stale — and then RE-RECORDS the proposal's lineage row at the
--      fingerprints the pass judged, under the pass's key, the row's older
--      lineage rows dropped first as 063's replacement drops them. The
--      lineage row is where the reopen below reads staleness: left at the
--      old texts' fingerprints, a settled row would read stale for ever and
--      every later rebuild would reopen it (the build's first cold read).
--      The note begins 'settled by the pass:' — THE MARKER: the one string
--      that says a machine, not a person, decided this row (server-portable/
--      consolidate.ts's PASS_SETTLED_PREFIX). The pass settles a stale pair
--      the candidate rule no longer admits for a reason that means "no
--      conflict" — no shared entity, under the similarity floor, a side
--      superseded — too, with a note that says so; one a side of which has
--      no vector yet waits (the reembed pool writes it; the run after that
--      re-pools it); one whose call timed out, was refused by the egress
--      gate or drew a malformed answer stays stale with the thought recorded
--      failed, for --retry-failed. The pass also re-pools every stale row's
--      newer thought under its OWN key at the start of a run — a pair both
--      sides of which have a vector, with no live or failed claim there — so
--      a pass under a new judge key, or one whose earlier claim on the
--      thought succeeded, reaches the row 063 requeued under the row's key
--      (a failed claim is --retry-failed's, 015's rule). 029's posture — the
--      pass proposes, never applies — is not crossed: a rejection applies
--      nothing.
--   2. THE REOPEN is this file's. rebuild_derived is redefined on 063's body
--      verbatim, the proposal arm alone changed: a rejected row whose
--      review_note begins 'settled by the pass:' is the pass's, so a text
--      move under it sets the row stale again — status stale, reviewed_at
--      back to NULL, the note cleared as 063's replacement clears one — for
--      the next pass to judge, replace or settle; a person's rejected or
--      accepted row is KEPT, as in 063 (the maintainer's choice, 2026-09-27,
--      over keeping a pass-settled row as a person's — which would leave a
--      pair the pass once found clear unproposable when its texts later come
--      to conflict — and over a fifth status). stale_proposals counts both
--      transitions; under p_force the same arm runs. The sentinel
--      ob1:pass-settled-is-the-pass-to-reopen names the rule; preflight's
--      lineage check reads it where settle_supersession_proposal stands, so
--      063 re-applied by hand over this file (whose rebuild_derived keeps
--      every rejected row) is a WARN, not a silent regression — 063's own
--      lesson about 061 over 063.
--   3. THE RECORD. The status column's COMMENT and 029's table COMMENT
--      ("a rejected pair is never proposed again") re-issued to say so.
--
-- SAFETY
--   One body redefined on its own text with no arity change (CREATE OR
--   REPLACE keeps the ACL); one function added; two COMMENTs. Nothing runs
--   at apply time but the DDL. The one DELETE names its rows in its own WHERE
--   (check-fork-consistency's check 21); nothing under a replay (the
--   primitive's REPLAYING answer stands; the settle is the pass's live
--   write). No grant moves: the settle writes supersession_proposals and
--   derivations, which the worker role writing proposals reaches already
--   (029's record function and 063's replacement run as the caller), and a
--   stale row never carries a written pointer, so the reject arm's
--   update_thought call is never reached. thoughts is untouched. MINOR under
--   FORK.md's version rules. 063's file is not edited: brains hold its sha in
--   the ledger.
--   Measured on a read-only copy of the dogfood brain (1,042 thoughts, 2,585
--   lineage rows, 24 proposals — 22 stale by fingerprint, every one rejected
--   by hand; PostgreSQL 16): the settle 0.3-3.4 ms a row (median under a
--   millisecond), the queue read under 4 ms, the re-pool read under 3 ms,
--   the pass's stale-row read under 1.5 ms a thought, the uncapped candidate
--   read for a left-out stale pair under 5 ms; a rebuild after a settle with
--   nothing moved read every settled row current (24 of 24), a rebuild after
--   a second move reopened every one (24 of 24, under 2 ms a call); a rebuild
--   over every thought 595-829 ms for 1,042 calls, 063's order
--   (changes/smd-2297.md has the runs).
--
-- Prerequisites
--   036 (review_supersession_proposal), 061 (ob1_record_derivation), 063
--   (the mark's columns, the stale status and its CHECKs, the six-argument
--   rebuild_derived this file carries). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape). Every probe names an object that stands on a brain at
-- this file too, so a --reapply passes.
DO $qc$
BEGIN
  IF to_regprocedure('review_supersession_proposal(uuid, text, text, text, jsonb, boolean)') IS NULL
     OR to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 064 needs 036 (review_supersession_proposal) and 061 (ob1_record_derivation); this schema lacks them',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'derivations' AND column_name = 'stale_since')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'supersession_proposals'::regclass AND conname = 'supersession_proposals_unreviewed_check') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 064 needs 063 (rebuild_derived, the mark''s columns, the stale proposal status); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The record: what a stale row is now, and what a rejected one may be.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN supersession_proposals.status IS
  'pending: the judge''s verdict awaits a reviewer. accepted / rejected: a decision (review_supersession_proposal) — a person''s, or since 064 the consolidation pass''s own when its review_note begins ''settled by the pass:'' (the pass re-judged a stale pair and found no conflict, or the pair no longer meets the candidate rule). stale (063, SMD-1732): rebuild_derived found one of the pair''s texts moved since the judge saw them — the verdict is about texts that no longer stand; the pair is judged again by the next consolidation pass, whose record_supersession_proposal replaces this row in place (back to pending) when it finds the conflict again and which rejects it with its own note when it does not (064, SMD-2297). A text move under a pass-settled rejection sets the row stale again; a person''s decision stands. A reviewer may still accept a stale row with p_force or reject it. Migrations 029, 063, 064.';

COMMENT ON TABLE supersession_proposals IS
  'One row per pair of thoughts a consolidation pass judged to CONFLICT, with the judge''s verdict on which is current. Written by db/consolidate.ts; thoughts.supersedes is written only when a reviewer accepts a row through review_supersession_proposal. A pair is recorded once whatever its later status, so a pair a person rejected is never proposed again; a pair the pass itself settled (review_note beginning ''settled by the pass:'', 064) is judged again when a text moves under it, through the stale status (063). Migrations 029, 063, 064 / SMD-1294, SMD-1732, SMD-2297.';

-- ---------------------------------------------------------------------------
-- 2. The settle: the pass's rejection of a stale row it no longer finds in
--    conflict, with the proposal's lineage re-recorded at the texts judged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settle_supersession_proposal(
  p_id                uuid,
  p_note              text,
  p_actor             jsonb,
  p_judge_key         text,
  p_older_fingerprint text,
  p_newer_fingerprint text,
  p_recipe            jsonb,
  p_agent_id          uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v jsonb;
BEGIN
  -- The marker is the contract: a note without it would be read as a
  -- person's by rebuild_derived, and the row kept for ever on a later move.
  IF p_note IS NULL OR p_note NOT LIKE 'settled by the pass:%' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'settle_supersession_proposal: p_note must begin with ''settled by the pass:'' - the marker rebuild_derived reads',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR p_judge_key = '' OR p_older_fingerprint IS NULL OR p_newer_fingerprint IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'settle_supersession_proposal: the judge key and both fingerprints the pass judged are required - they are what the lineage row records',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The locks in review_supersession_proposal's order (036): the advisory
  -- lock first (re-entrant: the review below takes it again), then the row.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  SELECT p.id, p.older_id, p.newer_id, p.status INTO r
    FROM supersession_proposals p WHERE p.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id);
  END IF;
  -- The pass settles a STALE row only: a pending row awaits a reviewer (the
  -- pass never decides a verdict it did not re-judge), a decided row is
  -- decided. Answered as a value: a race with a reviewer or a replacement
  -- is a fact about the row, not a fault in the pass.
  IF r.status <> 'stale' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_STALE', 'id', p_id, 'status', r.status);
  END IF;
  v := review_supersession_proposal(p_id, 'reject', p_note, NULL, p_actor, false);
  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v;
  END IF;
  -- ob1:settle-records-the-texts-it-judged — a CONTRACT SENTINEL (the 014
  -- convention), read by db/test-schema.ts: the proposal's lineage row is
  -- rewritten at the fingerprints the pass judged, under the pass's key —
  -- the older rows dropped first (the key may differ; 061's UNIQUE is per
  -- key), as 063's replacement does. rebuild_derived reads staleness from
  -- this row: at the old texts' fingerprints a settled row would read stale
  -- for ever and every later rebuild would reopen it.
  DELETE FROM derivations WHERE artifact_kind = 'proposal' AND artifact_id = p_id;
  PERFORM ob1_record_derivation('proposal', p_id, ARRAY[r.older_id, r.newer_id],
                                ARRAY[p_older_fingerprint, p_newer_fingerprint], p_judge_key, p_recipe, p_agent_id);
  RETURN v || jsonb_build_object('settled', true, 'older_id', r.older_id, 'newer_id', r.newer_id);
END;
$$;

COMMENT ON FUNCTION settle_supersession_proposal(uuid, text, jsonb, text, text, text, jsonb, uuid) IS
  'The consolidation pass''s settle of a STALE proposal it re-judged and no longer finds in conflict (064, SMD-2297): rejects the row through review_supersession_proposal with p_note — which must begin ''settled by the pass:'', the marker rebuild_derived reads to reopen the row on a later text move — and re-records the proposal''s lineage row at the fingerprints the pass judged, under the pass''s key (the older rows dropped first). Refuses a note without the marker and missing fingerprints (invalid_parameter_value); answers NOT_FOUND and NOT_STALE as values — a pending row is a reviewer''s, a decided one is decided. Takes the supersession advisory lock, then the row. Returns the review''s jsonb plus settled, older_id, newer_id. Called by db/consolidate.ts; a person uses consolidate.ts --reject. Migration 064 / SMD-2297.';

-- ---------------------------------------------------------------------------
-- 3. The primitive: 063's body verbatim, the proposal arm reopening a
--    pass-settled row.
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
        -- person's decision stands (064, SMD-2297). The literal is
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
          -- sits under the ROW's key — and since 064 the pass re-pools every
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
  'The one primitive over the lineage table (SMD-1732, Phase 1c of SMD-1729): walks `derivations` forward from p_input (derivation_descendants) and acts on every descendant. A row whose artifact is gone is deleted. With the input standing, a row whose inputs'' fingerprints moved (or p_force) is: re-derived when the database can — a vector whose current text has a snapshot row at the model, by ob1_refresh_thought_vector (rebuilt); otherwise handed to the worker that owns the recipe through requeue_thought_work under the worker''s current key — the reembed pool for a vector or the windows, the extraction key for an extract: pass, the judge''s key — with stale_since/stale_reason set on the lineage row (marked; the tags have no pool: unqueued; the first request standing is kept) — and, for a pending proposal or one the consolidation pass itself rejected (a review_note beginning ''settled by the pass:'', 064), its status set stale with reviewed_at and the note cleared (the status is the mark; stale_proposals; the next pass replaces the row when it finds the conflict again and settles it when it does not); under p_force a vector whose text did not move, at the configured model, is re-recorded, not re-embedded (one at another model goes to the pool); a source: pass and a person''s decision on a proposal are kept; an unmoved row is current. With p_input_gone (SMD-1723''s forget, called BEFORE the row delete in its transaction): the windows, the input''s mentions and edges (entities locked first, orphans pruned) and their lineage rows are deleted, the snapshot rows at the input''s own fingerprints and p_fingerprints removed where no standing thought holds them, the proposals and the vector''s and tags'' rows counted for the cascade. derived_from children are listed as irreproducible. Refuses an empty reason; answers a replay with REPLAYING and a missing input with NOT_FOUND. Takes the supersession advisory lock, then the input''s row. With p_orphans_only (the sweep''s mode) only the orphan rule runs. Returns {ok, input, reason, input_gone, force, orphans_only, walked, depth, at_cap, rebuilt, enqueued, deleted, marked, unqueued, stale_proposals, kept, current, legacy, irreproducible, cascading, pools}. Migrations 063, 064 / SMD-1732, SMD-2297.';
