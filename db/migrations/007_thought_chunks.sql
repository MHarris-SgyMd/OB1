-- ============================================================================
-- 007 — thought_chunks: make a long capture findable by its ending
--
-- Why
--   One thought was one row with one vector, so a capture was embedded in a
--   single provider call. Past that provider's per-request ceiling — 2048 tokens
--   by default on Ollama, see evals/README.md — the tail of a long capture was
--   never represented in the vector. The text was stored intact and `fetch`
--   returned it whole, but `search_thoughts` could not find the note by anything
--   said in its second half. Silently: no error on the write, none on the search.
--
--   Measured: a 4000-token note whose conclusion is in the final sentence is
--   retrieved at chance (1/4) by every model whose batch is smaller than the
--   document. Chunked, it is retrieved perfectly.
--
-- Design
--   * ADDITIVE. `thoughts` is untouched — no new columns, no altered ones — so
--     the core guard rail holds. `thoughts.embedding` keeps its current meaning
--     (the whole-content embedding, truncated by the provider exactly as before),
--     so EXISTING ROWS KEEP WORKING WITH NO RE-EMBEDDING. Chunks are additional
--     evidence, never a replacement.
--   * Chunks are written only for content that needs them. A short thought — which
--     is nearly all of them; both corpora measured in evals/ average under 500
--     tokens — produces no chunk rows at all, so the common case pays nothing in
--     storage or write latency.
--   * ON DELETE CASCADE, so removing a thought cannot leave orphan vectors that
--     still answer searches.
--
-- Prerequisites
--   Migration 004. Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   A `thought_chunks` table with its own HNSW index, a 4-argument
--   `upsert_thought` overload, and a `match_thoughts` that searches both tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS thought_chunks (
  thought_id  uuid    NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  chunk_index int     NOT NULL,
  content     text    NOT NULL,
  embedding   vector({{EMBEDDING_DIM}}) NOT NULL,
  PRIMARY KEY (thought_id, chunk_index)
);

COMMENT ON TABLE thought_chunks IS
  'Overlapping windows of a long thought, each embedded separately so the tail of a long capture stays searchable. Empty for thoughts short enough to embed in one call.';

-- Its own HNSW index. Without this the chunk half of match_thoughts degrades to a
-- sequential scan and the feature costs more than it returns.
CREATE INDEX IF NOT EXISTS thought_chunks_embedding_idx
  ON thought_chunks USING hnsw (embedding vector_cosine_ops);

-- Recall path for the filtered case: match_thoughts joins chunks back to thoughts
-- to apply the metadata filter.
CREATE INDEX IF NOT EXISTS thought_chunks_thought_id_idx
  ON thought_chunks (thought_id);

-- ---------------------------------------------------------------------------
-- upsert_thought(text, jsonb, vector, jsonb) — capture with chunks, atomically
--
-- A fifth thing to keep consistent, so it joins the same single statement as the
-- other four rather than becoming a second round trip that can fail on its own.
-- Chunks are replaced wholesale on re-capture: content that changed enough to be
-- re-embedded must not keep windows of the previous text.
--
-- p_chunks is [{"content": "...", "embedding": "[0.1,0.2,...]"}], the embedding a
-- STRING in pgvector's text form. Passing it as a JSON array of numbers would
-- require a per-element cast and buys nothing.
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
  -- Reuse the 3-arg overload so fingerprinting and conflict handling live in one
  -- place; this function only adds the chunk rows.
  v_result := upsert_thought(p_content, p_payload, p_embedding);
  v_id     := (v_result->>'id')::uuid;

  DELETE FROM thought_chunks WHERE thought_id = v_id;

  IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
    INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
    SELECT
      v_id,
      (ord - 1)::int,
      elem->>'content',
      (elem->>'embedding')::vector({{EMBEDDING_DIM}})
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  RETURN v_result || jsonb_build_object('chunks', v_n);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector, jsonb) IS
  'Atomic capture including per-chunk embeddings. Replaces any existing chunks for the thought. Overload of the 3-arg form, which it delegates to.';

-- ---------------------------------------------------------------------------
-- match_thoughts — now searches whole-thought vectors AND chunk vectors
--
-- The shape matters. The obvious version computes a similarity for every row and
-- sorts, which cannot use an HNSW index and turns every search into two
-- sequential scans. Instead each source takes its own indexed top-K — `ORDER BY
-- <=> ... LIMIT` is the form pgvector's index can answer — and the two candidate
-- sets are merged afterwards.
--
-- A thought that matches on both its whole-content vector and one of its chunks
-- appears once, scored by whichever matched best.
--
-- The overfetch factor exists because the two sources compete for the same final
-- slots: a thought whose best evidence is its ninth chunk needs that chunk to
-- survive the chunk-side top-K. Four times the requested count is a recall budget,
-- not a guess at how many will be returned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding  vector({{EMBEDDING_DIM}}),
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  float,
  created_at  timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_fetch int := GREATEST(match_count * 4, 20);
BEGIN
  RETURN QUERY
  WITH direct AS (
    SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
    FROM thoughts t
    WHERE t.embedding IS NOT NULL
    ORDER BY t.embedding <=> query_embedding
    LIMIT v_fetch
  ),
  chunked AS (
    SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
    FROM thought_chunks c
    ORDER BY c.embedding <=> query_embedding
    LIMIT v_fetch
  ),
  best AS (
    SELECT u.tid, MAX(u.sim) AS sim
    FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
    GROUP BY u.tid
  )
  SELECT
    t.id,
    t.content,
    t.metadata,
    b.sim,
    t.created_at
  FROM best b
  JOIN thoughts t ON t.id = b.tid
  WHERE b.sim > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY b.sim DESC
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_thoughts(vector, float, int, jsonb) IS
  'Semantic search over whole-thought vectors and chunk vectors, deduplicated to one row per thought scored by its best evidence.';
