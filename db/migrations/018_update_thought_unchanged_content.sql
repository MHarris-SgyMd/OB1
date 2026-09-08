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
--   2. The row is read FOR UPDATE, so "unchanged" is decided against the row
--      as it is now and it cannot change under the call — without that, a
--      caller passing no if_unchanged_since could read X, have another edit
--      commit Y, and write X back as an "unchanged" edit 013 would have
--      refused. Then, when the row does not already own the key (if it does,
--      the unique index says nobody else can, and nothing below is needed),
--      pg_advisory_xact_lock on the fingerprint. Two edits taking the same key
--      are serialised on it, so the lookup that follows sees the other edit's
--      committed row. That argument needs READ COMMITTED — each statement takes
--      a fresh snapshot, so the waiter's lookup runs after the holder's commit
--      — which is the default and what every caller here runs at; under
--      REPEATABLE READ or SERIALIZABLE the waiter's snapshot predates the
--      commit and the unique index, not this function, gives the answer.
--      Without the lock two legacy twins re-embedded by two workers at the
--      same moment both pass the check and the second hits the unique index
--      with an opaque 23505; the same lock turns the race 009's header left
--      open for a genuine edit (two rows edited into the same new text at
--      once) into DUPLICATE_CONTENT instead of a constraint error. It covers
--      edit against edit only: upsert_thought writes fingerprints without it,
--      so a capture of text X committing while an edit to X is in flight still
--      ends, as before this migration, in the edit raising 23505 (SMD-1043
--      would take the same lock there). Both locks are transaction-scoped,
--      taken in the same order within one call, row then key, and HELD UNTIL
--      THE CALLER'S TRANSACTION ENDS — a refused call (STALE_READ,
--      DUPLICATE_CONTENT) included, where 013 held nothing. Every caller here
--      runs one call per transaction, so both locks are gone when the call
--      returns. A caller that wraps several calls in one transaction keeps
--      every row and key its earlier calls touched, and can deadlock against
--      one ordinary concurrent edit (T1 holds row1 and key X; T2 holds row2
--      and waits for X; T1 then asks for row2); Postgres reports that after
--      deadlock_timeout rather than hanging, and one of the two retries.
--      db/test-live.ts [6b] holds the lock open on one connection and shows
--      the other waiting on the ADVISORY lock in pg_locks, then told, not
--      refused. With the PERFORM below removed, the same scenario waits on the
--      transaction id instead and raises the 23505 once the first commits —
--      measured, which is why the test names the lock type.
--   3. One lookup, after the lock, for the row holding this key in the unique
--      index — and whether its text still hashes to it, since a raw update of
--      content around this function leaves a stale key that is not the same
--      text. Changed text and any holder → DUPLICATE_CONTENT, as before (the
--      key is taken, whatever the holder's text).
--   4. Unchanged text: no refusal. This row's fingerprint is set to NULL when
--      the key is held — which is what it already was unless a raw UPDATE
--      (upstream's pre-009 path never recomputed it) left a hash describing
--      text the row no longer holds; either way the column must not claim a
--      key another row holds, and the partial index is never violated — and
--      the result says who holds it: `duplicate_of` when the holder's text is
--      the same (a twin), `fingerprint_held_by` when the holder's key is stale
--      and this row cannot take the fingerprint it should have. Otherwise the
--      fingerprint is written: the backfill 003 never had, one row at a time,
--      now stated rather than incidental — for the rows a pass visits; a
--      one-shot backfill for the rest is SMD-1042. Which twin owns the text is
--      therefore whichever edit committed first, until SMD-1042 states a rule
--      (oldest by created_at) and applies it to the rest. Embedding and chunks
--      are replaced exactly as before whenever content is given.
--
-- What the caller sees
--   {ok:true, id, updated_at} as before, plus `duplicate_of` (uuid) when the
--   unchanged text is also another thought's, or `fingerprint_held_by` (uuid)
--   when another row's stale key blocks the fingerprint. db/reembed.ts says so
--   per row and lists the groups at the end of a pass and under --status; the
--   update_thought tool appends a note to its reply. Nothing is written to the
--   claim row for it: the pair is a fact about the corpus, reproducible by one
--   query at any time (group by COALESCE(content_fingerprint,
--   content_fingerprint_of(content)) — hashing only the rows without one, so
--   the probe that is asked repeatedly during a pass stays cheap; a stale key
--   is reported by this function when it blocks a row, not by that query).
--   Neither field says which row is older or which came first: a capture
--   merged around a legacy row produces the same pair as two legacy rows do.
--
-- Not fixed here, and stated
--   upsert_thought capturing text equal to a legacy NULL-fingerprint row still
--   creates a second row — ON CONFLICT cannot see a NULL — and the row the
--   pass leaves without a fingerprint stays a target for that. The pairs query
--   surfaces both kinds. Deleting one of a pair is the operator's call;
--   delete_thought keeps the previous content in the audit row. The one-shot
--   backfill that would fingerprint every legacy singleton without a re-embed
--   pass is SMD-1042 — a data migration with its own questions (a full-table
--   hash inside one transaction, re-apply), not folded in here.
--
--   The body carries `ob1:unchanged-edit-not-duplicate`, a contract sentinel in
--   the 014 convention: it lives in pg_proc.prosrc, which every CREATE OR
--   REPLACE rewrites, so db/reembed.ts can ask whether the function installed
--   is this one rather than whether a field name appears somewhere. A
--   successor that keeps the behaviour keeps the sentinel; one that drops the
--   behaviour must drop it, and reembed.ts refuses to run.
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
  -- The row holding v_fingerprint in the unique index, if any, and whether its
  -- text still hashes to it (a raw update around this function can leave a
  -- stale key). Only one of the two below is ever set.
  v_other        uuid;
  v_other_same   boolean;
  v_duplicate_of uuid;
  v_held_by      uuid;
  v_updated      timestamptz;
BEGIN
  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the UPDATE so the AFTER trigger sees it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  -- FOR UPDATE: what "unchanged" is decided against below is the row as it is
  -- NOW, and stays so until this transaction ends. Without the lock a caller
  -- passing no if_unchanged_since could read text X, have another edit commit
  -- Y, and write X back over it as an "unchanged" edit that 013 would have
  -- refused. Taken before the advisory lock, so the two are always acquired in
  -- the same order — see "The rule", 2.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR UPDATE;
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

    IF v_existing.content_fingerprint = v_fingerprint THEN
      -- The row already owns this key, and it is locked: the unique index
      -- says no other row can hold it, so there is nothing to serialise and
      -- nothing to look up. The common case — every fingerprinted row a
      -- re-embed pass visits, every same-text re-save through the tool.
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);

      -- Serialise every edit that would take this key until commit, so the
      -- lookup below sees the other edit's row rather than racing it to the
      -- unique index. See "The rule", 2, in the header.
      PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

      -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL, not prose (the
      -- 014 convention). The one definition of "another row holding this key":
      -- the refusal below and the duplicate_of report both read it. The
      -- holder's text is hashed again, because a stale key — a raw update of
      -- content around this function — is not the same text, and must not be
      -- reported as a twin.
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
        IF v_other_same THEN
          v_duplicate_of := v_other;
        ELSE
          v_held_by := v_other;
        END IF;
      END IF;
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
    -- v_other is set only when content arrived: another row holds this key,
    -- so this row must not claim it — NULL, whatever a raw update around this
    -- function may have left here.
    content_fingerprint = CASE
                            WHEN p_content IS NULL   THEN content_fingerprint
                            WHEN v_other IS NOT NULL THEN NULL
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
                 WHEN v_held_by IS NOT NULL
                   THEN jsonb_build_object('fingerprint_held_by', v_held_by)
                 ELSE '{}'::jsonb END;
END;
$$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. The row is locked FOR UPDATE and edits that would take a key the row does not own are serialised on an advisory lock (READ COMMITTED; captures through upsert_thought are not); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since as a predicate in the UPDATE, so the guard is atomic. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT.';
