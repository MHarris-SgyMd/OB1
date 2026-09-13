-- =============================================================================
-- Migration 027: search_thoughts_hybrid — a scale-relative admission cutoff
--                replaces the absolute 0.5 cosine floor (SMD-1300)
-- =============================================================================
--
-- WHY
--   `search_thoughts` and the ChatGPT-compat `search` both floored admission at
--   a raw cosine of 0.5 (020's `WHERE s.matched IS NOT NULL OR s.sim >
--   v_threshold`, with the tools sending 0.5). That constant is right only for
--   the corpus every prior eval used — short tracker issues, where a matching
--   pair clears 0.5 with room. On a LONG capture (a transcript, a meeting
--   write-up) a short question scores 0.2–0.4 cosine against a 2,600-token
--   session, so the floor removes the RIGHT answer, silently: fewer rows, all
--   plausible.
--
--   Measured on LongMemEval-S (SMD-1039, 470 questions, qwen3-embedding:0.6b),
--   strict recall_all@5:
--
--     admission rule                    ALL     >3k-token gold docs   mean rows
--     absolute floor 0.5 (shipped)      45.3%   36.1%                 1.1
--     no floor (threshold -1)           87.7%   84.7%                 5.0
--     relative cutoff, f = 0.5          87.4%   84.4%                 4.3
--
--   The floor's damage is entirely on long documents; short ones (<1k tokens)
--   score 100% under every rule. An absolute cosine floor cannot be right for
--   both a 125-token note and a 2,600-token transcript under one model — and
--   021 lets the model (hence the similarity scale) differ per row. So the fix
--   is not a smaller constant but a cutoff RELATIVE TO THE TOP CANDIDATE: admit
--   the strongest match and every row within `f` (0.5) of it. On LongMemEval it
--   ties the no-floor recall while returning fewer, cleaner rows; on the short
--   corpus, where the top score is ~0.8, f=0.5 keeps rows ≥0.4×top, close to
--   the old floor. (Full sweep + the eval-hybrid decoy report: SMD-1300.)
--
-- WHAT CHANGED (from 020's body, carried forward verbatim otherwise)
--   * The final admission clause only. A keyword hit is still exempt; a scored
--     row is now admitted when it is within v_relfloor (0.5) of the top
--     candidate's similarity AND clears the caller's absolute match_threshold.
--     The absolute threshold is kept as an OPTIONAL further tightening — a
--     caller can still impose a hard floor — but the tools (server-portable/
--     index.ts) stop sending 0.5 and send 0, so the relative cutoff governs.
--     A NEGATIVE match_threshold disables the relative cutoff too and returns
--     the raw ranked list — the sentinel this codebase already uses everywhere
--     for "no floor" (the eval's -1 arm, match_thoughts parity). `top` is
--     max(similarity) over the candidate set (the new `topsim` CTE).
--   * A contract sentinel, `ob1:relative-floor`, in the body.
--
-- WHAT A SUCCESSOR REDEFINITION MUST CARRY
--   The whole 020 body (the needle probe, the RRF fusion, the recency blend, and
--   the `similarity` = raw cosine contract) rides along under CREATE OR REPLACE:
--   a redefinition reverts anything it does not repeat. Keep the relative
--   admission and the sentinel, or SMD-1300 returns.
--
-- SAFETY
--   * One function, by CREATE OR REPLACE, same signature and same RETURNS TABLE
--     — so the REPLACE is legal and the ACL is preserved (no DROP, no replay).
--   * `similarity` still reports the raw cosine; only ADMISSION changes. The
--     `% match` a caller sees is unchanged.
--   * Privileges unchanged, plain SECURITY INVOKER; the COMMENT is re-issued.
--     Idempotent. No pgvector dependency beyond 001's. match_thoughts,
--     find_derivatives, upsert_thought, the columns and indexes are untouched.
-- =============================================================================

CREATE OR REPLACE FUNCTION search_thoughts_hybrid(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
  -- Passed through to match_thoughts (020); the vector arm's rank is then the
  -- blended order. The 5-argument form was dropped once, in 020; 027 is a plain
  -- CREATE OR REPLACE of this 7-argument signature (it preserves the ACL).
  recency_weight   float   DEFAULT 0.0,
  half_life_days   float   DEFAULT 90.0
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,     -- NULL for a keyword hit with no vector and no chunks
  matched_needles  text[],    -- the needles this row contains, in query order
  needles          text[],    -- every row: the needles the keyword arm was asked for
  needle_counts    int[],     -- every row: how many thoughts contain each of `needles` (0 = none), so a hit cut by match_count is not reported as absent
  common_needles   text[],    -- every row: extracted, but its page was not its whole match set (more than 100 thoughts today), so not used
  literal_only     boolean,   -- every row: the query had nothing to embed, so the vector arm's rank was not scored
  score            float
)
LANGUAGE plpgsql
STABLE
-- Scoped to this call, like 014's hnsw setting. See "what this query must not
-- do" in 017's header: the planner prices JIT off an estimate that is three
-- orders of magnitude high here, and paid 14 ms of compilation per call for it.
SET jit = off
AS $$
DECLARE
  -- RRF's conventional constant. A rank-1 hit is worth 1/61; presence of one
  -- needle is worth the same.
  k              constant int := 60;
  -- Clamped rather than trusted, to the bound the tools enforce. It is also the
  -- vector arm's window: the rows match_thoughts would return for this call are
  -- the rows whose rank counts (see 017's header for the measurement behind that).
  v_count        int    := least(greatest(coalesce(match_count, 10), 1), 100);
  -- Coalesced like the other two: an explicit NULL from a hand-written RPC
  -- would otherwise make `sim > NULL` unknown and drop every vector-only row.
  v_threshold    float  := coalesce(match_threshold, 0.7);
  v_filter       jsonb  := coalesce(filter, '{}'::jsonb);
  v_all          text[] := extract_search_needles(query_text);
  v_residual     text   := coalesce(query_text, '');
  v_literal_only boolean;
  v_needle       text;
  -- SMD-1300: the admission cutoff is RELATIVE to the top candidate's raw
  -- cosine, not an absolute constant — one constant cannot fit both a
  -- 125-token note (top ~0.8) and a 2,600-token transcript (top ~0.3) under
  -- one model, and 021 lets the model differ per row. Admit the strongest
  -- match and every row within half of it.
  v_relfloor     constant float := 0.5;
  -- ob1:relative-floor — a CONTRACT SENTINEL (the 014 convention), asserted
  -- by db/test-schema.ts. Its presence is the machine-checkable proof this
  -- body is the relative-admission one and not 020's absolute floor.
BEGIN
  -- The gate. Remove every extracted needle (and the quotes that marked one)
  -- from the query; if the English parser keeps no lexeme of what is left,
  -- there was nothing to embed and the vector arm's rank is not scored.
  -- Longest needle first, and lower-cased on both sides. The needles were
  -- de-duplicated case-insensitively keeping the first spelling, so a second
  -- spelling ("smd-944" after "SMD-944") or a needle that is a prefix of
  -- another ("ERR_TIMEOUT" removed before "ERR_TIMEOUT_LONG") would otherwise
  -- leave fragments the parser keeps as lexemes, and the gate would open for a
  -- query that is nothing but literals (review pass). The parser is
  -- case-insensitive, so lowering the residual changes nothing else.
  v_residual := lower(v_residual);
  FOR v_needle IN SELECT n FROM unnest(v_all) AS n ORDER BY length(n) DESC LOOP
    v_residual := replace(v_residual, lower(v_needle), ' ');
  END LOOP;
  -- The quote characters around a span are left in: the parser keeps no lexeme
  -- for punctuation, so stripping them changed nothing (review pass).
  v_literal_only := cardinality(v_all) > 0 AND length(to_tsvector('english', v_residual)) = 0;

  RETURN QUERY
  WITH
  -- Keyword arm: the full page per needle, with total_count deciding whether
  -- that page is the whole match set. `ord` keeps query order for the arrays.
  -- The row's columns ride along: both arms already return the whole row, so
  -- nothing below joins `thoughts` again (see "what this query must not do").
  -- Before a needle is paged, a probe asks whether it has more matches than a
  -- page holds: the 101st matching row, found and abandoned, not counted.
  -- 012's page materialises its whole match set to count it exactly — the
  -- 731 ms per 100,000 rows its header prices for a needle in every row — and
  -- for a common needle that page would only be discarded below. The pattern
  -- is escaped exactly as 012 escapes it, and db/test-schema.ts [17b] plants
  -- a decoy only an unescaped pattern matches so the two cannot drift.
  probe AS (
    SELECT n.needle, n.ord,
           EXISTS (SELECT 1 FROM thoughts t
                   WHERE t.content ILIKE '%' || replace(replace(replace(n.needle, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                     AND (v_filter = '{}'::jsonb OR t.metadata @> v_filter)
                   OFFSET 100 LIMIT 1) AS common
    FROM unnest(v_all) WITH ORDINALITY AS n(needle, ord)
  ),
  kw AS (
    SELECT p.needle, p.ord, h.id AS hit_id, h.content AS hit_content, h.metadata AS hit_metadata,
           h.created_at AS hit_created_at, h.total_count
    FROM probe p
    CROSS JOIN LATERAL search_thoughts_keyword(p.needle, 100, 0, v_filter) AS h
    WHERE NOT p.common
  ),
  -- A needle is USED when the probe found no 101st row AND its page is its
  -- whole match set — the rows that came back equal total_count — and COMMON
  -- otherwise. The second test is the completeness itself rather than the page
  -- constant, so a change to 012's clamp cannot silently make the probe's 100
  -- wrong: it would only make the probe late, never the rule.
  kw_needles AS (
    SELECT p.needle, p.ord, p.common, coalesce(max(k2.total_count), 0) AS total, count(k2.hit_id) AS fetched
    FROM probe p
    LEFT JOIN kw k2 ON k2.needle = p.needle
    GROUP BY p.needle, p.ord, p.common
  ),
  used AS (
    SELECT coalesce(array_agg(kn.needle ORDER BY kn.ord) FILTER (WHERE NOT kn.common AND kn.fetched = kn.total), '{}'::text[]) AS needles,
           coalesce(array_agg(kn.total::int ORDER BY kn.ord) FILTER (WHERE NOT kn.common AND kn.fetched = kn.total), '{}'::int[])  AS counts,
           coalesce(array_agg(kn.needle ORDER BY kn.ord) FILTER (WHERE kn.common OR kn.fetched < kn.total), '{}'::text[]) AS common
    FROM kw_needles kn
  ),
  hits AS (
    SELECT k3.hit_id,
           array_agg(k3.needle ORDER BY k3.ord) AS matched,
           (array_agg(k3.hit_content))[1]  AS hit_content,
           (array_agg(k3.hit_metadata))[1] AS hit_metadata,
           min(k3.hit_created_at)          AS hit_created_at
    FROM kw k3
    JOIN kw_needles kn ON kn.needle = k3.needle AND NOT kn.common AND kn.fetched = kn.total
    GROUP BY k3.hit_id
  ),
  -- Vector arm: ranks over the N rows match_thoughts would return. At weight 0
  -- that is the call at threshold -1 — every scoreable row ranked, the
  -- threshold applied below after the exact hits are exempted, sub-threshold
  -- rows at the tail where the LIMIT never reaches them. Under a weight (020)
  -- the tail is wherever age puts it, so the caller's threshold is passed:
  -- the window is then the N rows the weighted semantic tool would show, and
  -- a sub-threshold keyword hit is still returned below, by presence. Ranked
  -- by match_thoughts' own `score` (the blend; the similarity at weight 0);
  -- `vsim` stays the raw similarity, which is what the threshold reads, and
  -- `vscore` is the tiebreak.
  vec AS (
    SELECT m.id AS vid, m.content AS vcontent, m.metadata AS vmetadata, m.created_at AS vcreated_at,
           m.similarity AS vsim, m.score AS vscore,
           row_number() OVER (ORDER BY m.score DESC, m.id) AS rnk
    FROM match_thoughts(query_embedding,
                        CASE WHEN COALESCE(recency_weight, 0.0) > 0 THEN v_threshold ELSE -1.0 END,
                        v_count, v_filter, recency_weight, half_life_days) AS m
  ),
  cand AS (
    SELECT v.vid AS cid FROM vec v
    UNION
    SELECT h.hit_id FROM hits h
  ),
  scored AS (
    SELECT
      c.cid,
      coalesce(v.vcontent,    h.hit_content)    AS content,
      coalesce(v.vmetadata,   h.hit_metadata)   AS metadata,
      coalesce(v.vcreated_at, h.hit_created_at) AS created_at,
      -- A keyword hit outside the vector window is scored directly, by the
      -- rule match_thoughts uses: best of the thought's own vector and its
      -- chunks. THIS IS A SECOND COPY OF THAT RULE, and the one place a change
      -- to match_thoughts' `similarity` must be mirrored. 020's recency blend
      -- did not change it, deliberately: the blend is a separate `score`
      -- column and `similarity` stays the raw cosine, so an in-window row and
      -- a keyword-only row still carry the same quantity and the tiebreak
      -- among exact hits compares like with like. db/test-live.ts [11] reaches
      -- this path with a window of one and holds it to match_thoughts' number.
      coalesce(
        v.vsim,
        (SELECT max(1 - (x.e <=> query_embedding))
         FROM (SELECT t2.embedding AS e FROM thoughts t2 WHERE t2.id = c.cid AND t2.embedding IS NOT NULL
               UNION ALL
               SELECT ch.embedding FROM thought_chunks ch WHERE ch.thought_id = c.cid) AS x)
      ) AS sim,
      h.matched,
      v.vscore,
      -- The rank term. A row in the window: 1/(k + rank), as 017. Under a
      -- weight (020) the window is the N rows ABOVE the threshold, so a
      -- keyword hit below it is not in the window at any rank — where at
      -- weight 0 it sat in the tail with a rank of its own. Without a rank term
      -- it would tie a rank-1 vector-only row at exactly 1/(k + 1) and lose the
      -- tiebreak to that row's higher similarity: "exact hits first" broken by
      -- the threshold, not by age. So under a weight a keyword hit outside the
      -- window carries the rank just past it, 1/(k + N + 1): still ahead of
      -- every vector-only row, still behind a hit the window holds. At weight 0
      -- nothing here changes (second review pass).
      (CASE WHEN v.rnk IS NOT NULL AND NOT v_literal_only THEN 1.0 / (k + v.rnk)
            WHEN h.matched IS NOT NULL AND NOT v_literal_only AND COALESCE(recency_weight, 0.0) > 0 THEN 1.0 / (k + v_count + 1)
            ELSE 0.0 END)
        + coalesce(cardinality(h.matched), 0) * (1.0 / (k + 1)) AS fused
    FROM cand c
    LEFT JOIN vec  v ON v.vid    = c.cid
    LEFT JOIN hits h ON h.hit_id = c.cid
  ),
  -- The tiebreak among equal fused scores is the BLENDED value (020): a row in
  -- the window carries match_thoughts' `score`; a keyword hit outside it gets
  -- the same formula over the probe's similarity, from the one function that
  -- owns it. At weight 0 both are the similarity, and this is 017's order. It
  -- decides the whole order for a literal-only query, where the gate gives the
  -- vector arm no vote and every row not containing the needle has fused 0.
  -- A hit with no vector and no chunks has no similarity: at weight 0 it sorts
  -- last among ties, as 017 had it; under a weight it is scored by age alone —
  -- a similarity of 0 into the same formula — so "newest first" holds for a
  -- thought captured today through the 2-arg fallback too (second review pass).
  blended AS (
    SELECT s.*,
           coalesce(s.vscore,
                    recency_score(CASE WHEN s.sim IS NULL AND COALESCE(recency_weight, 0.0) > 0 THEN 0.0 ELSE s.sim END,
                                  s.created_at, recency_weight, half_life_days)) AS rscore
    FROM scored s
  ),
  -- The top candidate's raw cosine, the yardstick the relative cutoff below
  -- measures against. Taken over ALL candidates, which is the vector arm's top:
  -- a keyword-only hit (in via a needle, not the vector window) cannot exceed
  -- it, because any row scoring above the window's minimum is already IN the
  -- window — so a floor-exempt keyword hit never raises the bar for the vector
  -- rows. NULL when no scored row has a vector (a pure keyword query), and then
  -- only keyword hits are admitted.
  topsim AS (SELECT max(sim) AS top FROM blended)
  SELECT
    s.cid, s.content, s.metadata, s.created_at,
    s.sim::float,
    coalesce(s.matched, '{}'::text[]),
    u.needles,
    u.counts,
    u.common,
    v_literal_only,
    s.fused::float
  FROM blended s
  CROSS JOIN used u
  CROSS JOIN topsim ts
  -- SMD-1300: relative admission. A keyword hit is exempt, as it always was. A
  -- scored row is admitted when it clears the caller's absolute match_threshold
  -- AND is within v_relfloor (0.5) of the top candidate's raw cosine. The tools
  -- send match_threshold 0 (index.ts), so the relative cutoff is what governs
  -- for them. A NEGATIVE match_threshold disables the relative cutoff too — the
  -- raw ranked list, the sentinel this codebase already uses everywhere for "no
  -- floor" (the eval's -1 arm, match_thoughts parity, a caller who wants
  -- everything). GREATEST(top,0) keeps a corpus whose best match is negative
  -- (nothing is really similar) from inverting the comparison. `similarity`
  -- (s.sim) is still the raw cosine, unchanged.
  WHERE s.matched IS NOT NULL
     OR (s.sim > v_threshold
         AND (v_threshold < 0 OR s.sim >= v_relfloor * GREATEST(ts.top, 0.0)))
  ORDER BY s.fused DESC, s.rscore DESC NULLS LAST, s.created_at DESC, s.cid
  LIMIT v_count;
END;
$$;

-- Re-issued: the description records the relative admission (020's said the
-- threshold gated raw similarity). The marker is the sentinel in the body, not
-- this text.
COMMENT ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float) IS
  'match_thoughts and search_thoughts_keyword fused: reciprocal rank on the vector arm (in match_thoughts'' own order — its `score`, the recency blend at recency_weight, similarity alone at 0), presence per matched needle on the keyword arm, each hit''s own blended score as the tiebreak. Admission is RELATIVE (SMD-1300, migration 027): a scored row is kept when its raw cosine is within half of the top candidate''s (v_relfloor 0.5) and clears match_threshold, which the tools send as 0 so the relative cutoff governs; a keyword hit is exempt, and a negative match_threshold disables the relative cutoff (the raw ranked list). `similarity` stays the raw cosine. Needles come from extract_search_needles(query_text). Fixed top-N (no paging). See the 017, 020 and 027 headers.';
