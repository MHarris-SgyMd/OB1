-- ============================================================================
-- 009 — update_thought / delete_thought
--
-- Why
--   The tool surface could write and read but never correct or remove. A typo, a
--   mis-captured secret, a duplicate the fingerprint missed — all permanent
--   through the documented interface. That is a missing verb, not a missing
--   feature; upstream ships an entire second Edge Function to add one of them.
--
-- Ported from integrations/update-thought-mcp and delete-thought-mcp, fixing two
-- defects in the original along the way and adding what this fork needs:
--
--   1. UPSTREAM NEVER RECOMPUTES content_fingerprint ON A CONTENT CHANGE.
--      It issues a plain UPDATE of content and metadata, leaving the fingerprint
--      describing text the row no longer holds. Dedup then breaks in BOTH
--      directions: re-capturing the OLD text hits the stale fingerprint and
--      merges into the edited row, and capturing the NEW text finds no match and
--      creates a duplicate of it. Migration 003's whole purpose, undone by an
--      edit. Recomputed here, in the same statement.
--
--   2. UPSTREAM'S CONCURRENCY CHECK IS A RACE.
--      It SELECTs updated_at, compares in application code, then UPDATEs. Another
--      writer can commit between the read and the write — the exact lost update
--      `if_unchanged_since` exists to prevent. Here the comparison is a predicate
--      in the UPDATE's WHERE clause, so the check and the write are one atomic
--      statement.
--
--   3. CHUNKS AND THE EMBEDDING MUST FOLLOW THE CONTENT.
--      Migration 007 gave a long thought per-window embeddings. Editing content
--      without replacing them leaves the search index describing the previous
--      text — findable by words that are no longer there, and not by the ones
--      that are. Handled the same way capture does it: replace wholesale.
--
-- Safety
--   * Additive. No column on `thoughts` is altered or dropped.
--   * Both functions fire migration 008's audit trigger, so an update records a
--     before/after diff and a delete preserves the prior content in full. That
--     is what makes a HARD delete defensible rather than reckless.
--   * Idempotent.
--
-- Prerequisites
--   Migrations 007 and 008.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- update_thought
--
-- Returns jsonb: {ok, id, updated_at} on success, or {ok:false, error} where
-- error is one of NOT_FOUND | STALE_READ | DUPLICATE_CONTENT. Returning a code
-- rather than raising lets the caller distinguish "your read was stale, refetch"
-- from a genuine fault — a RAISE would be indistinguishable from a bug at the
-- tool boundary.
--
-- p_content NULL      → leave the text, embedding and chunks alone
-- p_metadata_patch    → shallow merge; keys not mentioned are untouched
-- p_if_unchanged_since NULL → last-write-wins, as before
-- ---------------------------------------------------------------------------
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
  v_existing   thoughts%ROWTYPE;
  v_fingerprint text;
  v_updated    timestamptz;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  SELECT * INTO v_existing FROM thoughts WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- Distinguish a stale read from a missing row before attempting the write, so
  -- the caller gets the reason rather than a bare "0 rows".
  IF p_if_unchanged_since IS NOT NULL
     AND COALESCE(v_existing.updated_at, v_existing.created_at) > p_if_unchanged_since THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  -- Recomputed from the NEW text, by the same rule migration 003 uses for
  -- capture. Identical normalisation matters: a fingerprint computed differently
  -- here would silently stop matching the ones capture writes.
  IF p_content IS NOT NULL THEN
    v_fingerprint := encode(
      sha256(convert_to(lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')),
      'hex');

    -- Editing a thought into an exact duplicate of another one. The partial
    -- unique index would reject this anyway, but as a constraint violation that
    -- surfaces at the tool boundary as an opaque 23505.
    IF EXISTS (
      SELECT 1 FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
    END IF;
  END IF;

  /**
   * One statement. The `if_unchanged_since` predicate is repeated here rather
   * than relied on from the check above: between that SELECT and this UPDATE
   * another writer can commit, which is the race upstream's version has. Belt
   * and braces is the wrong metaphor — the WHERE clause is the actual guard and
   * the check above exists only to produce a better error message.
   */
  UPDATE thoughts SET
    content             = COALESCE(p_content, content),
    content_fingerprint = CASE WHEN p_content IS NOT NULL THEN v_fingerprint ELSE content_fingerprint END,
    metadata            = CASE WHEN p_metadata_patch IS NOT NULL
                               THEN metadata || p_metadata_patch ELSE metadata END,
    -- Only when new content arrived. A metadata-only edit must not blank the
    -- vector and quietly remove the row from every semantic search.
    embedding           = CASE WHEN p_content IS NOT NULL THEN p_embedding ELSE embedding END,
    updated_at          = now()
  WHERE id = p_id
    AND (p_if_unchanged_since IS NULL
         OR COALESCE(updated_at, created_at) <= p_if_unchanged_since)
  RETURNING updated_at INTO v_updated;

  IF v_updated IS NULL THEN
    -- Lost the race after the check above passed.
    RETURN jsonb_build_object('ok', false, 'error', 'STALE_READ');
  END IF;

  -- Chunks describe the content, so they follow it. Replaced wholesale, exactly
  -- as migration 007's capture path does — a partial update would leave windows
  -- of the previous text in the search index.
  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
      SELECT p_id, (ord - 1)::int, elem->>'content',
             (elem->>'embedding')::vector({{EMBEDDING_DIM}})
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated);
END;
$$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks when content changes; checks if_unchanged_since as a predicate in the UPDATE rather than in a preceding SELECT, so the guard is atomic. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT.';

-- ---------------------------------------------------------------------------
-- delete_thought
--
-- A hard delete, which is only defensible because migration 008's audit trigger
-- preserves previous_content and previous_metadata in full before the row goes.
-- Without that this should have been a soft delete.
--
-- thought_chunks is removed by its ON DELETE CASCADE, so no explicit cleanup is
-- needed — but the test asserts it, because a cascade silently not firing is
-- exactly the sort of thing that leaves orphaned vectors answering searches.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_thought(
  p_id    uuid,
  p_actor jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted uuid;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  DELETE FROM thoughts WHERE id = p_id RETURNING id INTO v_deleted;

  IF v_deleted IS NULL THEN
    -- A distinct outcome, not a silent success. The caller asked to remove a
    -- specific thing; not finding it is information.
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_deleted);
END;
$$;

COMMENT ON FUNCTION delete_thought(uuid, jsonb) IS
  'Hard-delete a thought by id. Chunks go by cascade; migration 008 audits the delete with previous_content preserved, which is what makes a hard delete recoverable. Returns {ok:false, error:NOT_FOUND} rather than succeeding silently.';
