-- ============================================================================
-- 029 — supersession_proposals: a pass PROPOSES that one thought replaces
--       another; a reviewer confirms; nothing is applied unreviewed
--
-- Why (Linear SMD-1294)
--   025 gave `thoughts` a `supersedes` column and `capture_thought` a way to
--   set it. Nothing populates it except a caller who already knows the answer
--   at capture time. So a decision captured in March and its reversal in June
--   sit side by side, both rank on cosine alone (020's recency blend is off by
--   measurement), and `search_thoughts` hands the caller both with no signal
--   that one is dead. The caller has to notice the conflict and resolve it on
--   every retrieval, for ever. GBrain's public design runs this as an overnight
--   job: sample pairs of nearby facts, ask a model whether they conflict, and
--   surface the result for review rather than acting on it. This fork had every
--   ingredient of that loop and none of the loop: a leased, resumable, parallel
--   worker (015), a way to narrow the candidate pairs (016's shared entities,
--   the vector), a place to write the verdict (025), and a resident metadata
--   model. This migration is the loop's schema; `db/consolidate.ts` is the
--   worker; `server-portable/consolidate.ts` holds the judge's prompt.
--
-- The one rule: the machine PROPOSES, someone confirms
--   Both GBrain's docs and the review of 025 arrive at the same rule, and this
--   file enforces it structurally: the pass writes to THIS table and never to
--   `thoughts`. `thoughts.supersedes` is written only by
--   `review_supersession_proposal(..., 'accept')`, a call an operator makes,
--   one proposal at a time. Reversing a wrong supersession is one edit;
--   reversing a hundred applied blind would be a migration.
--
-- Which pairs are judged, and why each restriction
--   `consolidation_candidates(thought)` returns the thoughts to compare a
--   thought against. It restricts on all of:
--     * SHARES AN ENTITY (016). A conflict is about a subject, and a subject
--       both thoughts name is what 016 recorded. Two thoughts near in vector
--       space with no name in common are far more often two notes in one
--       register than two claims about one thing; the judge cost is per pair,
--       so the pool is narrowed by the cheap signal before the expensive one.
--       Consequence: a thought with no extracted entities has no candidates,
--       and the worker pools only thoughts that have some (extraction first).
--     * OLDER, by at least a calendar day (UTC). Two directions: the pair
--       (older, newer) is reached from the NEWER thought only, so a pair is
--       judged once with no memory of "already judged" needed, and every
--       thought captured later judges itself against what came before it;
--       and a burst of captures on one day (an import, a meeting's notes) is
--       not compared with itself. A same-day contradiction is therefore not
--       found by this pass: stated, not hidden.
--     * NEAREST BY COSINE, exact over the candidate set, top k, at or above a
--       floor. The ticket said "by search_thoughts_hybrid"; the keyword arm of
--       017 has nothing to add when the query is a whole thought (it fuses on
--       identifier-shaped literals a question carries, not a document), and
--       an HNSW walk filtered to "shares an entity with this one" is exactly
--       the filtered-scan shape 014 exists to work around. The candidate set
--       is a join on `thought_entities`, usually tens of rows, and an exact
--       cosine over it is cheaper than the index. k and the floor are the
--       worker's flags; their defaults were chosen by measurement
--       (`evals/eval-consolidate.ts`, `evals/README.md`).
--     * NOT ALREADY DECIDED. A pair with a proposal row in any state is not a
--       candidate again: a rejected pair stays rejected across re-runs and a
--       cleared claim table; an accepted one is done. A thought that already
--       supersedes, or is superseded by, a thought is not paired with it, and
--       a thought some thought already supersedes is out of the pass on either
--       side: the label it could gain is the one it has.
--
-- What is recorded
--   Only conflicts. `agree` and `unrelated` verdicts are the pass's cost, not
--   its product; the worker's --dump writes every verdict for the eval, and
--   the claim row is the per-thought record that the pass reached it. A row
--   carries the judge's verdict WITH its direction (`newer_supersedes_older`,
--   `older_supersedes_newer`, `conflict_undirected` when the texts do not say
--   which is current), its confidence and one-sentence reason (what a reviewer
--   reads first), the cosine at judging time, and the pass key
--   `consolidate:<model>@p<prompt version>` — the judge model on the row,
--   the way 021 puts the embedding model beside the vector (SMD-1254). The
--   worker's agent id rides along as 016's mentions carry theirs.
--
-- The accept path writes the column directly, under the audit trigger
--   The ticket asked that acceptance call `update_thought`. It cannot yet:
--   `update_thought` has no provenance parameter (025 left post-hoc provenance
--   edits as a follow-up), and giving it one is a redefinition of the edit
--   signature — a DROP and re-create with the ACL replayed, the constant in
--   config.mjs, preflight's `edit signature` check, both stores, the MCP tool —
--   a second mechanism in this change. So `review_supersession_proposal` sets
--   `ob1.actor` as 009's functions do, locks the superseding row, and writes
--   `supersedes` in one UPDATE. 025's audit trigger diffs that column, so the
--   change is recorded with the reviewer as actor exactly as an edit through
--   `update_thought` would be; 001's trigger moves `updated_at`. What this
--   path does NOT do that `update_thought` would: nothing — the column is
--   not part of the fingerprint, the vector or the windows. When
--   `update_thought` grows a provenance envelope, acceptance should call it
--   and this function's UPDATE go; the follow-up is filed from the change.
--
--   Acceptance refuses what would leave the column wrong: the superseding
--   thought already pointing at a THIRD thought (ALREADY_SUPERSEDES: the
--   column holds one predecessor, and which one is the reviewer's call), or a
--   pointer that would close a loop (WOULD_CYCLE, checked by walking the
--   chain from the superseded thought). An undirected verdict needs the
--   reviewer to name the direction (DIRECTION_REQUIRED). Rejecting an ACCEPTED
--   proposal undoes its write while it still stands (the pointer is still the
--   one this proposal set) and no further: a later edit that pointed the
--   thought elsewhere is not this proposal's to clear.
--
-- Staleness, the same pass's second output
--   `stale_entities(older_than)` — per entity, the newest capture among the
--   thoughts that mention it, for the entities nothing has mentioned within
--   the window. Reported by the worker's --stale and acted on by nobody: a
--   subject gone quiet is a question for its owner, not a defect in the store.
--
-- No trigger, no recorded key
--   016's trigger enqueues extraction on every capture because extraction is
--   per thought and the thought is complete at capture. Consolidation is per
--   PAIR and needs the thought's entities first, so a trigger on `thoughts`
--   would judge a capture before 016's worker reached it and find nothing —
--   and the claim row would then be terminal, the thought never judged. The
--   worker builds its own pool instead — thoughts with at least one mention
--   and no row under its key — on every run and every --follow poll, which is
--   the dependency order (extract, then consolidate) made structural. There is
--   no `ob1_config` key for the pass: each proposal carries the key that
--   judged it, and two models' passes are two pools that share the pair table
--   (the first to judge a pair records it; the second finds it decided).
--
-- Safety
--   * Additive. `thoughts` gains no column and loses none; the two functions
--     that write it touch `supersedes` only, under the triggers already on it.
--   * ON DELETE CASCADE from `thoughts` on both sides: a deleted thought takes
--     its proposals with it; 008's delete row keeps its content.
--   * No DELETE in this file. Rejection is an UPDATE of status.
--   * Idempotent: IF NOT EXISTS, CREATE OR REPLACE, drop-then-add constraints.
--   * Plain functions, SECURITY INVOKER, no GRANT: the application connects as
--     the owner (db/README.md), and PostgREST reaches them over rpc.
--
-- Prerequisites
--   Migrations 015 (the lease table), 016 (thought_entities) and 025
--   (thoughts.supersedes). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `supersession_proposals` exists, empty, with four functions beside it. The
--   corpus is unchanged until `db/consolidate.ts` runs, and `thoughts` is
--   unchanged until someone accepts a proposal.
-- ============================================================================

CREATE TABLE IF NOT EXISTS supersession_proposals (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The pair, by capture order: older_id was captured at least a day before
  -- newer_id. The pointer is written on whichever the verdict (or the
  -- reviewer) names as current.
  older_id           uuid         NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  newer_id           uuid         NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  verdict            text         NOT NULL
    CHECK (verdict IN ('newer_supersedes_older', 'older_supersedes_newer', 'conflict_undirected')),
  confidence         numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- The judge's one sentence: what the two disagree on. What a reviewer reads.
  reason             text,
  -- Cosine between the two whole vectors when the pair was judged.
  similarity         real,
  -- The pass that judged it: consolidate:<model>@p<prompt version>.
  judge_key          text         NOT NULL CHECK (judge_key <> ''),
  judged_at          timestamptz  NOT NULL DEFAULT now(),
  canonical_agent_id uuid,
  status             text         NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_at        timestamptz,
  review_note        text,
  -- While accepted: the thought whose supersedes column this proposal set.
  superseding_id     uuid,
  CHECK (older_id <> newer_id),
  CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CHECK ((status = 'accepted') = (superseding_id IS NOT NULL)),
  CHECK (superseding_id IS NULL OR superseding_id IN (older_id, newer_id)),
  UNIQUE (older_id, newer_id)
);

COMMENT ON TABLE supersession_proposals IS
  'One row per pair of thoughts a consolidation pass judged to CONFLICT, with the judge''s verdict on which is current. Written by db/consolidate.ts; thoughts.supersedes is written only when a reviewer accepts a row through review_supersession_proposal. A pair is recorded once whatever its later status, so a rejected pair is never proposed again. Migration 029 / SMD-1294.';
COMMENT ON COLUMN supersession_proposals.verdict IS
  'The judge''s answer: newer_supersedes_older, older_supersedes_newer, or conflict_undirected when the texts conflict but do not say which is current (accepting one needs the reviewer to name a direction).';
COMMENT ON COLUMN supersession_proposals.judge_key IS
  'The pass that judged the pair, consolidate:<model>@p<prompt version>: the judge model rides with the verdict as the embedding model rides with the vector (021).';
COMMENT ON COLUMN supersession_proposals.superseding_id IS
  'Set while status is accepted: the thought whose supersedes column this acceptance wrote. Rejecting an accepted proposal clears that column while it still holds this proposal''s value, and this.';

-- The review queue: pending rows, most confident first.
CREATE INDEX IF NOT EXISTS supersession_proposals_pending_idx
  ON supersession_proposals (confidence DESC, judged_at)
  WHERE status = 'pending';

-- The UNIQUE above serves older_id lookups (and the cascade); the newer side
-- needs its own for the cascade and for "was this pair decided" from the
-- newer thought, which is the side consolidation_candidates asks from.
CREATE INDEX IF NOT EXISTS supersession_proposals_newer_idx
  ON supersession_proposals (newer_id);

-- ---------------------------------------------------------------------------
-- consolidation_candidates — the older thoughts one thought is judged against
--
-- See the header for each restriction. STABLE: reads only. Exact cosine over
-- the entity join, ordered by distance then id so the top k is deterministic.
-- A thought with no vector, no entities, or that some thought already
-- supersedes returns nothing.
-- ---------------------------------------------------------------------------
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
     AND NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.older_id = o.id AND p.newer_id = me.id)
     AND 1 - (o.embedding <=> me.embedding) >= COALESCE(p_min_similarity, 0)
   ORDER BY o.embedding <=> me.embedding, o.id
   LIMIT GREATEST(COALESCE(p_k, 5), 1)
$$;

COMMENT ON FUNCTION consolidation_candidates(uuid, int, float) IS
  'The older thoughts a thought is judged against for a supersession: sharing at least one entity (016), captured at least a calendar day (UTC) earlier, nearest by exact cosine, at or above p_min_similarity, at most p_k; pairs already proposed and thoughts already superseded are left out. Migration 029.';

-- ---------------------------------------------------------------------------
-- record_supersession_proposal — the worker's one write
--
-- Inserts a pending row for a conflict; returns its id, or NULL when the pair
-- already has a row in any state (the second judge of a pair, a re-run over a
-- cleared claim table). The pair's order is the caller's: older_id captured
-- before newer_id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_supersession_proposal(
  p_older_id   uuid,
  p_newer_id   uuid,
  p_verdict    text,
  p_confidence numeric,
  p_reason     text,
  p_similarity float,
  p_judge_key  text,
  p_agent_id   uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_verdict NOT IN ('newer_supersedes_older', 'older_supersedes_newer', 'conflict_undirected') THEN
    RAISE EXCEPTION 'record_supersession_proposal: p_verdict must be newer_supersedes_older, older_supersedes_newer or conflict_undirected, got %', p_verdict;
  END IF;
  IF p_judge_key IS NULL OR p_judge_key = '' THEN
    RAISE EXCEPTION 'record_supersession_proposal: p_judge_key must name the pass, e.g. consolidate:<model>@p1';
  END IF;
  INSERT INTO supersession_proposals (older_id, newer_id, verdict, confidence, reason, similarity, judge_key, canonical_agent_id)
  VALUES (p_older_id, p_newer_id, p_verdict,
          LEAST(GREATEST(COALESCE(p_confidence, 0), 0), 1),
          p_reason, p_similarity, p_judge_key, p_agent_id)
  ON CONFLICT (older_id, newer_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid) IS
  'Record one conflict the pass found, pending review. Returns the new row''s id, or NULL when the pair already has a row in any state. Migration 029.';

-- ---------------------------------------------------------------------------
-- review_supersession_proposal — the reviewer's decision, and the ONLY path
-- from this table to thoughts.supersedes
--
-- p_decision 'accept' writes the pointer (see the header for what it refuses);
-- 'reject' marks the row and, if the row was accepted, undoes its write while
-- it still stands. p_direction ('newer' or 'older') is required to accept an
-- undirected verdict and overrides a directed one. p_actor is the reviewer,
-- set on `ob1.actor` for the audit trigger as 009's functions do.
--
-- Returns jsonb: {ok:true, id, status, superseding_id, superseded_id, written}
-- on accept (written=false when the pointer already held this value);
-- {ok:true, id, status, cleared} on reject; {ok:false, error, ...} for
-- NOT_FOUND, DIRECTION_REQUIRED, ALREADY_ACCEPTED, ALREADY_SUPERSEDES (with
-- `current`, the third thought the column names) and WOULD_CYCLE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_supersession_proposal(
  p_id        uuid,
  p_decision  text,
  p_note      text  DEFAULT NULL,
  p_direction text  DEFAULT NULL,
  p_actor     jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r           supersession_proposals%ROWTYPE;
  v_dir       text;
  v_sup       uuid;
  v_old       uuid;
  v_current   uuid;
  v_walk      uuid;
  v_steps     int := 0;
  v_n         int;
BEGIN
  IF p_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'review_supersession_proposal: p_decision must be accept or reject, got %', p_decision;
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('newer', 'older') THEN
    RAISE EXCEPTION 'review_supersession_proposal: p_direction must be newer or older, got %', p_direction;
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  SELECT * INTO r FROM supersession_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id);
  END IF;

  IF p_decision = 'reject' THEN
    v_n := 0;
    IF r.status = 'accepted' THEN
      -- Undo this proposal's write while it still stands, and no further.
      v_old := CASE WHEN r.superseding_id = r.newer_id THEN r.older_id ELSE r.newer_id END;
      UPDATE thoughts SET supersedes = NULL
       WHERE id = r.superseding_id AND supersedes = v_old;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    UPDATE supersession_proposals
       SET status = 'rejected', reviewed_at = now(), review_note = p_note, superseding_id = NULL
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'rejected', 'cleared', v_n > 0);
  END IF;

  -- accept
  IF r.status = 'accepted' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_ACCEPTED', 'id', p_id, 'superseding_id', r.superseding_id);
  END IF;
  v_dir := COALESCE(p_direction,
                    CASE r.verdict WHEN 'newer_supersedes_older' THEN 'newer'
                                   WHEN 'older_supersedes_newer' THEN 'older' END);
  IF v_dir IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DIRECTION_REQUIRED', 'id', p_id, 'verdict', r.verdict);
  END IF;
  IF v_dir = 'newer' THEN v_sup := r.newer_id; v_old := r.older_id;
  ELSE                    v_sup := r.older_id; v_old := r.newer_id;
  END IF;

  -- The superseding row, locked for the write; its current pointer decides.
  SELECT supersedes INTO v_current FROM thoughts WHERE id = v_sup FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id, 'thought_id', v_sup);
  END IF;
  IF v_current IS NOT NULL AND v_current <> v_old THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_SUPERSEDES', 'id', p_id,
                              'superseding_id', v_sup, 'current', v_current);
  END IF;
  -- Would the pointer close a loop? Walk the chain from the thought about to
  -- be superseded; reaching the superseding thought means yes. Bounded: a
  -- chain longer than the bound is refused rather than walked for ever.
  v_walk := v_old;
  LOOP
    SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_walk;
    EXIT WHEN v_walk IS NULL;
    IF v_walk = v_sup THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'id', p_id, 'superseding_id', v_sup, 'superseded_id', v_old);
    END IF;
    v_steps := v_steps + 1;
    IF v_steps > 1000 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'id', p_id, 'superseding_id', v_sup, 'superseded_id', v_old, 'detail', 'chain longer than 1000');
    END IF;
  END LOOP;

  IF v_current IS DISTINCT FROM v_old THEN
    UPDATE thoughts SET supersedes = v_old WHERE id = v_sup;
  END IF;
  UPDATE supersession_proposals
     SET status = 'accepted', reviewed_at = now(), review_note = p_note, superseding_id = v_sup
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'accepted',
                            'superseding_id', v_sup, 'superseded_id', v_old,
                            'written', v_current IS DISTINCT FROM v_old);
END;
$$;

COMMENT ON FUNCTION review_supersession_proposal(uuid, text, text, text, jsonb) IS
  'The reviewer''s decision on one proposal, and the only path from the table to thoughts.supersedes: accept writes the pointer on the thought the verdict (or p_direction, required for an undirected verdict) names as current, refusing a pointer at a third thought or one that would close a loop; reject marks the row and undoes an accepted write while it still stands. p_actor is set on ob1.actor for the audit trigger. Migration 029.';

-- ---------------------------------------------------------------------------
-- list_supersession_proposals — the review queue, with both thoughts
--
-- p_status NULL lists every state. Most confident first; capped at 200.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_supersession_proposals(
  p_status text DEFAULT 'pending',
  p_limit  int  DEFAULT 20
)
RETURNS TABLE (
  id               uuid,
  status           text,
  verdict          text,
  confidence       numeric,
  reason           text,
  similarity       real,
  judge_key        text,
  judged_at        timestamptz,
  reviewed_at      timestamptz,
  review_note      text,
  superseding_id   uuid,
  older_id         uuid,
  older_content    text,
  older_created_at timestamptz,
  newer_id         uuid,
  newer_content    text,
  newer_created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT p.id, p.status, p.verdict, p.confidence, p.reason, p.similarity, p.judge_key,
         p.judged_at, p.reviewed_at, p.review_note, p.superseding_id,
         o.id, o.content, o.created_at,
         n.id, n.content, n.created_at
    FROM supersession_proposals p
    JOIN thoughts o ON o.id = p.older_id
    JOIN thoughts n ON n.id = p.newer_id
   WHERE p_status IS NULL OR p.status = p_status
   ORDER BY p.confidence DESC, p.judged_at, p.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200)
$$;

COMMENT ON FUNCTION list_supersession_proposals(text, int) IS
  'The proposals in one status (NULL for all), most confident first, each with both thoughts'' content and capture time. At most 200. Migration 029.';

-- ---------------------------------------------------------------------------
-- stale_entities — subjects nothing has been written about within a window
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stale_entities(
  p_older_than interval DEFAULT interval '90 days',
  p_limit      int      DEFAULT 20
)
RETURNS TABLE (entity_id uuid, entity_type text, name text, thoughts int, newest_at timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT e.id, e.entity_type, e.name, count(*)::int, max(t.created_at)
    FROM ob1_entities e
    JOIN thought_entities m ON m.entity_id = e.id
    JOIN thoughts t ON t.id = m.thought_id
   GROUP BY e.id, e.entity_type, e.name
  HAVING max(t.created_at) < now() - COALESCE(p_older_than, interval '90 days')
   ORDER BY max(t.created_at), e.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 1000)
$$;

COMMENT ON FUNCTION stale_entities(interval, int) IS
  'Per entity, the newest capture among the thoughts that mention it, for the entities nothing has mentioned within p_older_than. Reported by db/consolidate.ts --stale; acted on by nobody. Migration 029.';
