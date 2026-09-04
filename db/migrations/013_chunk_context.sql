-- ============================================================================
-- 013 — thought_chunks.context: room for a situating blurb, and a way to tell
--
-- Why
--   Migration 007 embeds each window of a long capture on its own, so a window
--   reading "we settled on thirty minutes, anything longer needs sign-off"
--   carries nothing about which system it concerns. Contextual retrieval
--   (Anthropic, September 2024) generates a short blurb naming the subject and
--   prepends it before embedding.
--
--   This migration adds the column that records what was prepended. It does NOT
--   turn the feature on — OB1_CHUNK_CONTEXT defaults to off, and the measurement
--   below is why.
--
-- ── What the measurement says, before anyone turns it on ───────────────────
--   `evals/eval-contextual.ts`, 441 real issues, the 15 that reach the chunking
--   threshold, 37 queries that name a document's subject and ask for a detail
--   living in exactly one window. Against the bare windows stored today:
--
--     arm                                    MRR      helped   hurt
--     bare windows (before change 27)        0.904         —      —
--     whole content + windows (TODAY)        0.935         3      0
--     a blurb per window                     0.826         1      8
--     a 20-word blurb per window             0.847         0      5
--     one blurb per document                 0.759         1     13
--
--   Helped/hurt are against the baseline row. Against what the server stores
--   today the gap is wider: 0.935 to 0.867 for the best contextual arm.
--
--   It is worse, and the mechanism is measured rather than guessed: the same
--   harness compares each query against the exact window it was written for, and
--   prepending a blurb moves that window AWAY from its own query — 0.034 with a
--   full blurb (lower on 32 of 37), 0.014 with a 20-word one (27 of 37). Fixed
--   vector, added words, less room for the sentence that actually answers.
--
--   The sign is a property of the MODEL. On `embeddinggemma` — 768 dimensions
--   against 1024, and a real 2048-token ceiling — the same harness reports a
--   blurb per window at +0.041. That is why this ships as a column and a flag
--   rather than not at all: a weaker window vector has more to gain from the
--   extra subject signal than it loses to dilution.
--
--   Cost, when it is on: one LLM call per chunk at capture, 1.2 to 2.2 seconds
--   each at `qwen2.5:7b` locally across four runs.
--
-- Design
--   * ADDITIVE and NULLABLE. An existing chunk row keeps working untouched, and
--     NULL is the honest reading of one written before this existed: not "no
--     context was generated", but "this row predates the question".
--   * The column is the ONLY way to tell a contextualized corpus from a bare one.
--     A chunk is not a substring of its parent — `chunkContent` joins paragraph
--     segments with a space — so nothing can be recovered by comparing text, and
--     without this column a corpus captured half with the flag on and half with
--     it off would be undetectable and silently inconsistent. preflight.ts counts
--     both and says so.
--   * The EMBEDDING is of `context || E'\n\n' || content` when context is
--     present. That composition rule lives in db/config.mjs
--     (`composeChunkForEmbedding`) because the server, the benchmark and any
--     future backfill must all produce byte-identical text or their vectors are
--     not comparable — and nothing would report it.
--   * No backfill. Re-contextualizing an existing corpus is a bulk pass over
--     every chunked thought, which wants the claim/lease table from SMD-946.
--     Until that exists, flipping the flag applies to new captures only, and
--     preflight reports the mixed state rather than pretending it is not there.
--
-- Prerequisites
--   Migrations 007 (thought_chunks) and 009 (update_thought). Applied by
--   `bun db/migrate.ts`.
--
-- Expected outcome
--   `thought_chunks.context`, the two chunk-writing functions carrying it
--   through, and `ob1_config.chunk_context` recording what the server was
--   configured with when the schema was last migrated.
-- ============================================================================

ALTER TABLE thought_chunks ADD COLUMN IF NOT EXISTS context text;

COMMENT ON COLUMN thought_chunks.context IS
  'Generated blurb situating this window in its parent document, prepended to content before embedding. NULL means the window was embedded bare — either the feature was off, or the generating call failed and capture degraded rather than losing the thought.';

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector, jsonb) — carry context through
--
-- Byte-identical to migration 007's version but for the two lines that read and
-- write `context`. Repeated in full rather than patched because CREATE OR
-- REPLACE has no partial form, and the signature is unchanged, so this replaces
-- rather than adds an overload — `db/test-schema.ts` still asserts exactly three.
--
-- `elem->>'context'` is NULL for a caller that does not send the key, which is
-- every caller running with the flag off and every older client. That is the
-- behaviour wanted: an omitted key and an explicit null both mean "bare".
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
  END IF;

  RETURN v_result || jsonb_build_object('chunks', v_n);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector, jsonb) IS
  'Atomic capture including per-chunk embeddings and their situating context. Replaces any existing chunks for the thought. Overload of the 3-arg form, which it delegates to.';

-- ---------------------------------------------------------------------------
-- update_thought — the other place chunks are written
--
-- An edit replaces chunks wholesale, so it has to carry context too. Without
-- this half, editing a contextualized thought would silently strip the context
-- from every one of its windows while leaving the embeddings looking fine — the
-- corpus would go inconsistent through the ordinary use of a tool, which is
-- exactly the failure the column exists to make visible.
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

  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  IF p_content IS NOT NULL THEN
    v_fingerprint := encode(
      sha256(convert_to(lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')),
      'hex');

    IF EXISTS (
      SELECT 1 FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
    END IF;
  END IF;

  UPDATE thoughts SET
    content             = COALESCE(p_content, content),
    content_fingerprint = CASE WHEN p_content IS NOT NULL THEN v_fingerprint ELSE content_fingerprint END,
    metadata            = CASE WHEN p_metadata_patch IS NOT NULL
                               THEN metadata || p_metadata_patch ELSE metadata END,
    embedding           = CASE WHEN p_content IS NOT NULL THEN p_embedding ELSE embedding END,
    updated_at          = now()
  WHERE id = p_id
    AND (p_if_unchanged_since IS NULL
         OR date_trunc('milliseconds', COALESCE(updated_at, created_at))
            <= date_trunc('milliseconds', p_if_unchanged_since))
  RETURNING updated_at INTO v_updated;

  IF v_updated IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STALE_READ');
  END IF;

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

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated);
END;
$$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; checks if_unchanged_since as a predicate in the UPDATE rather than in a preceding SELECT, so the guard is atomic. Returns {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT.';

-- ---------------------------------------------------------------------------
-- Record the setting, the way 006 records the embedding contract
--
-- This is the INTENDED state, not the observed one, and the difference matters.
-- The flag is read per capture, so a server restarted with it flipped starts
-- writing a different kind of chunk immediately, without another migration run.
-- preflight therefore checks the rows as well: this row says what was configured
-- when the schema was last migrated, and `thought_chunks` says what is actually
-- in there. Disagreement between them is the thing worth reporting.
-- ---------------------------------------------------------------------------
INSERT INTO ob1_config (key, value) VALUES
  ('chunk_context', '{{CHUNK_CONTEXT}}')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
