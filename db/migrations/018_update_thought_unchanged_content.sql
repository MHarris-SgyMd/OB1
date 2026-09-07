-- ============================================================================
-- 018 — update_thought: an edit that changes nothing is never a duplicate
--
-- Why
--   update_thought (009, redefined in 013) runs its duplicate check whenever
--   p_content is given: another row carrying the same fingerprint means
--   {ok:false, error:'DUPLICATE_CONTENT'}. The check assumes the text is NEW.
--   db/reembed.ts passes the row's own unchanged content, because that is the
--   only way to make update_thought replace the embedding and the chunk rows,
--   and for one class of row the check then refuses the row's own text.
--
--   Migration 003 added content_fingerprint with a partial unique index
--   (WHERE content_fingerprint IS NOT NULL) and no backfill. Two rows captured
--   before it that normalise to the same text — `Same Text` and `same   text`
--   — both carry NULL fingerprints and coexist; a bulk load that inserted into
--   `thoughts` directly (as db/test-live.ts [8] itself does) leaves the same
--   state. Re-embedding the first of the pair set its fingerprint as a side
--   effect of the update. Re-embedding the second then found the first and was
--   refused: the claim row marked failed, the run exited 1, and --retry-failed
--   reproduced the refusal on every run while ob1_config already recorded the
--   new model. Rows from before 003 are the common case for any brain that
--   predates this fork's migrations (SMD-1022, found by the first review pass
--   of SMD-946).
--
-- The decision
--   Redefine update_thought rather than give the re-embed a write path of its
--   own. A `reembed_thought(id, embedding, chunks, …)` would have to copy the
--   stale-read guard, the actor setting and the chunk replacement out of this
--   function — a value defined twice, which is the defect this fork keeps
--   removing, with every stored vector as the value. One writer stays one
--   writer, and the semantic stands on its own: when the new text normalises
--   to what the row already holds, the edit cannot create a duplicate that was
--   not already there. The check keeps working for the case 009 wrote it for,
--   editing a thought into another thought's text.
--
-- The rule
--   1. v_fingerprint := content_fingerprint_of(p_content), 016's function, so
--      the hash rule has one owner instead of a third inline copy. The edit is
--      UNCHANGED when it equals content_fingerprint_of(existing content).
--   2. pg_advisory_xact_lock on the fingerprint, before the check, for every
--      content write. Two transactions fingerprinting the same text are
--      serialised on it, so the EXISTS that follows is authoritative — under
--      READ COMMITTED each statement takes a fresh snapshot, and the second
--      arrives after the first has committed. Without it two legacy twins
--      re-embedded by two workers at the same moment both pass the check and
--      the second hits the unique index with an opaque 23505; the same lock
--      also closes the race 009's header left open for a genuine edit (two
--      rows edited into the same new text at once now get DUPLICATE_CONTENT,
--      not a constraint error). Transaction-scoped, released at commit, one
--      lock per edit. Deadlock is possible only for a transaction that calls
--      update_thought twice with different texts while another does the
--      reverse; no caller here does, and Postgres would report it rather than
--      hang. db/test-live.ts [6b] holds the lock open on one connection and
--      shows the other waiting on the ADVISORY lock in pg_locks, then told,
--      not refused. With the PERFORM below removed, the same scenario waits
--      on the transaction id instead and raises the 23505 once the first
--      commits — measured, which is why the test names the lock type.
--   3. Changed text: the check as before. Another row with this fingerprint →
--      DUPLICATE_CONTENT.
--   4. Unchanged text: no refusal. If another row already carries the
--      fingerprint, this row's fingerprint is LEFT AS IT IS — necessarily NULL,
--      since two fingerprinted rows cannot collide — so the partial index is
--      never violated, and the result carries `duplicate_of` naming the other
--      row. Otherwise the fingerprint is written: the backfill 003 never had,
--      one row at a time, now stated rather than incidental. Embedding and
--      chunks are replaced exactly as before whenever content is given.
--
-- What the caller sees
--   {ok:true, id, updated_at} as before, plus `duplicate_of` (uuid) when the
--   unchanged text is also another thought's. db/reembed.ts counts and names
--   the pairs at the end of a pass and under --status; the update_thought tool
--   appends a note to its reply. Nothing is written to the claim row for it:
--   the pair is a fact about the corpus, reproducible by one query at any time
--   (group by COALESCE(content_fingerprint, content_fingerprint_of(content))).
--
-- Not fixed here, and stated
--   upsert_thought capturing text equal to a legacy NULL-fingerprint row still
--   creates a second row — ON CONFLICT cannot see a NULL — and the row the
--   pass leaves without a fingerprint stays a target for that. The pairs query
--   surfaces both kinds. Deleting one of a pair is the operator's call;
--   delete_thought keeps the previous content in the audit row.
--
-- The trap
--   CREATE OR REPLACE takes the whole body. Everything the current body holds
--   is carried forward verbatim — 008's `ob1.actor` (the audit trigger's
--   attribution), 009's millisecond-truncated `if_unchanged_since` predicate in
--   the UPDATE itself, 013's `context` in the chunk insert — and the signature
--   is unchanged, so this replaces rather than adds an overload. 008's header
--   records what dropping one of these looked like. db/test-schema.ts [14]
--   still asserts exactly one update_thought carrying context; [19] asserts
--   the actor, the guard, the lock and the fingerprint function by name in
--   pg_proc, and the behaviour above.
--
-- Safety
--   * Additive. No column on `thoughts` is altered or dropped; no DELETE beyond
--     the chunk replacement 009 already did.
--   * Idempotent.
--
-- Prerequisites
--   Migrations 013 (the body this replaces) and 016 (content_fingerprint_of).
--   Applied by `bun db/migrate.ts`.
-- ============================================================================

CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing     thoughts%ROWTYPE;
  v_fingerprint  text;
  v_unchanged    boolean := false;
  v_duplicate_of uuid;
  v_updated      timestamptz;
BEGIN
  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the UPDATE so the AFTER trigger sees it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  SELECT * INTO v_existing FROM thoughts WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- 009: a stale read is told apart from a missing row before the write, so
  -- the caller gets the reason rather than a bare "0 rows". Truncated on both
  -- sides to milliseconds — JavaScript's Date carries no more, and a caller
  -- passing back exactly what it read must pass this.
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  IF p_content IS NOT NULL THEN
    -- 003's rule, through 016's function: a fingerprint computed differently
    -- here would silently stop matching the ones capture writes.
    v_fingerprint := content_fingerprint_of(p_content);
    v_unchanged   := v_fingerprint = content_fingerprint_of(v_existing.content);

    -- Serialise every writer of this fingerprint until commit, so the checks
    -- below see the other writer's row rather than racing it to the unique
    -- index. See "The rule", 2, in the header.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

    IF NOT v_unchanged THEN
      -- Editing a thought into an exact duplicate of another one. The partial
      -- unique index would reject this anyway, but as a constraint violation
      -- that surfaces at the tool boundary as an opaque 23505.
      IF EXISTS (
        SELECT 1 FROM thoughts
        WHERE content_fingerprint = v_fingerprint AND id <> p_id
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
      END IF;
    ELSE
      -- The text is what the row already holds, so no duplicate is being
      -- created — but one may already exist, from before 003 or from a load
      -- that bypassed upsert_thought. Name it, and leave this row's fingerprint
      -- (necessarily NULL) alone so the partial index is never violated.
      SELECT id INTO v_duplicate_of FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
      LIMIT 1;
    END IF;
  END IF;

  /**
   * One statement. The `if_unchanged_since` predicate is repeated here rather
   * than relied on from the check above: between that SELECT and this UPDATE
   * another writer can commit, which is the race upstream's version has. The
   * WHERE clause is the actual guard; the check above exists only to produce a
   * better error message.
   */
  UPDATE thoughts SET
    content             = COALESCE(p_content, content),
    content_fingerprint = CASE
                            WHEN p_content IS NULL             THEN content_fingerprint
                            WHEN v_duplicate_of IS NOT NULL    THEN content_fingerprint
                            ELSE v_fingerprint
                          END,
    metadata            = CASE WHEN p_metadata_patch IS NOT NULL
                               THEN metadata || p_metadata_patch ELSE metadata END,
    -- Only when content arrived. A metadata-only edit must not blank the
    -- vector and quietly remove the row from every semantic search.
    embedding           = CASE WHEN p_content IS NOT NULL THEN p_embedding ELSE embedding END,
    updated_at          = now()
  WHERE id = p_id
    AND (p_if_unchanged_since IS NULL
         OR date_trunc('milliseconds', COALESCE(updated_at, created_at))
            <= date_trunc('milliseconds', p_if_unchanged_since))
  RETURNING updated_at INTO v_updated;

  IF v_updated IS NULL THEN
    -- Lost the race after the check above passed.
    RETURN jsonb_build_object('ok', false, 'error', 'STALE_READ');
  END IF;

  -- Chunks describe the content, so they follow it: replaced wholesale, as
  -- migration 007's capture path does, carrying 013's context.
  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
      SELECT p_id, (ord - 1)::int, elem->>'content',
             (elem->>'embedding')::vector({{EMBEDDING_DIM}}),
             elem->>'context'
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated)
         || CASE WHEN v_duplicate_of IS NOT NULL
                 THEN jsonb_build_object('duplicate_of', v_duplicate_of)
                 ELSE '{}'::jsonb END;
END;
$$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row already carries that fingerprint (a pair from before migration 003). Writers of one fingerprint are serialised on an advisory lock. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT.';
