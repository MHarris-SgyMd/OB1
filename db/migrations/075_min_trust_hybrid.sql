-- ============================================================================
-- 075 — min_trust on search_thoughts_hybrid and search_thoughts_current:
--        an 8-argument form of each, every argument required, beside the
--        7-argument form the servers call, which passes no min_trust
--        (SMD-1724)
--
-- WHY
--   074 gave match_thoughts and search_thoughts_keyword a min_trust. The
--   servers' search tools call neither directly: search_thoughts and search
--   read the hybrid, and prefer_current reads search_thoughts_current over it.
--   Without the argument here, a read could not ask for "at or above this
--   trust" through the path the tools take.
--
--   Not 074's shape — a defaulted argument and the shorter form dropped. 059
--   defines search_thoughts_current in LANGUAGE sql, whose body PostgreSQL
--   resolves when it is created, and calls the hybrid with seven arguments.
--   A --reapply runs every file in order: 027 puts the 7-argument hybrid back
--   beside a defaulted 8-argument one, and 059's CREATE then fails, "function
--   search_thoughts_hybrid(…) is not unique" (db/test-schema.ts [2], the
--   re-apply of every file, on the first draft). 059 is frozen. So the
--   8-argument forms carry no defaults — a parameter after a defaulted one
--   must have one, so none of theirs do — and a call is resolved by its
--   count: seven or fewer to the 7-argument form, eight to the new one. The
--   maintainer's call (2026-10-02), over a reserved filter key or a session
--   setting.
--
-- WHAT
--   * search_thoughts_hybrid(…, min_trust text): 027's body, every argument
--     required; min_trust passed to match_thoughts (its seventh) and to
--     search_thoughts_keyword (its fifth), and the needle probe — which
--     decides whether a needle's page is its whole match set — counting only
--     rows at or above it, as the keyword arm returns them. A word off the
--     ladder is refused before either arm runs (ob1_min_trust_rank). ROWS 100,
--     068's, in the defining statement.
--   * search_thoughts_current(…, min_trust text): 068's body, every argument
--     required, min_trust passed to the hybrid.
--   * The 7-argument forms keep their signatures, defaults, ACLs and callers
--     (the stores send seven) and become one statement each: the 8-argument
--     form with NULL. One body each, not two to keep in step. A --reapply
--     puts 027's and 068's bodies back over them on the way and this file
--     wraps them again.
--   * Each 8-argument form is created with the privileges its 7-argument form
--     held, replayed as 020 replays them — an operator's REVOKE reaches the
--     new form too — on the run that creates it.
--
-- NOT HERE
--   * The servers' argument and the tools' label — SMD-1724's PR 3, which
--     sends all eight.
--
--   * A call by name follows the same rule: one naming all seven of the
--     7-argument form's arguments, or fewer, resolves to it; one naming
--     min_trust must name all eight (no defaults), or it finds no function.
--     PostgREST is the same — it leaves out a function whose required
--     arguments are not all named.
--
-- Idempotent: CREATE OR REPLACE throughout; a re-run finds the 8-argument
-- forms and replays nothing.
-- ============================================================================

-- The prerequisites, by name: 074's min_trust on both arms and the rank it
-- reads, and 068's node_state. A plpgsql body binds its calls when it runs,
-- so without this a hand apply ahead of 074 would succeed and every search
-- through the 7-argument forms fail at its first call (first review pass).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_min_trust_rank(text)') IS NULL
     OR to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float, text)') IS NULL
     OR to_regprocedure('search_thoughts_keyword(text, int, int, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 075 needs 074 (ob1_min_trust_rank, match_thoughts and search_thoughts_keyword with min_trust); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('node_state(uuid[])') IS NULL OR to_regclass('public.ob1_superseded_by') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 075 needs 068 (node_state, ob1_superseded_by); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. search_thoughts_hybrid(…, min_trust) — 027's body, min_trust passed on.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_search_thoughts_hybrid',
                  CASE WHEN to_regprocedure('search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text)') IS NOT NULL THEN ''
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('search_thoughts_hybrid(vector, text, float, int, jsonb, float, float)')), '') END,
                  false);

CREATE OR REPLACE FUNCTION search_thoughts_hybrid(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  -- 075: no defaults. A parameter after a defaulted one must have a default,
  -- and a defaulted eighth beside the 7-argument form makes every 7-argument
  -- call "function is not unique" — 059's LANGUAGE sql body among them, which
  -- PostgreSQL resolves when it is created, so a --reapply would stop there.
  -- The 7-argument form below keeps its defaults and calls this one.
  match_threshold  float,
  match_count      int,
  filter           jsonb,
  recency_weight   float,
  half_life_days   float,
  -- 075: at or above this trust, passed to both arms (074's min_trust on
  -- match_thoughts and the keyword function) and read by the needle probe;
  -- NULL is no constraint.
  min_trust        text
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
-- 068's estimate, in the defining statement (CREATE OR REPLACE resets an
-- unstated ROWS to 1,000): the window search_thoughts_current reads is at most
-- 100 rows.
ROWS 100
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
  -- 075: the rank a row must reach (0: no constraint), refused here for a word
  -- off the ladder before either arm runs.
  v_min          int    := ob1_min_trust_rank(min_trust);
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
                     -- 075: the probe counts what the keyword arm would return.
                     AND (v_min = 0 OR ob1_trust_rank(t.metadata->>'trust') >= v_min)
                   OFFSET 100 LIMIT 1) AS common
    FROM unnest(v_all) WITH ORDINALITY AS n(needle, ord)
  ),
  kw AS (
    SELECT p.needle, p.ord, h.id AS hit_id, h.content AS hit_content, h.metadata AS hit_metadata,
           h.created_at AS hit_created_at, h.total_count
    FROM probe p
    CROSS JOIN LATERAL search_thoughts_keyword(p.needle, 100, 0, v_filter, min_trust) AS h
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
                        v_count, v_filter, recency_weight, half_life_days, min_trust) AS m
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
  -- measures against — the best similarity available for this query, over all
  -- candidates. At weight 0 (the tools' default, and the whole SMD-1300 path)
  -- this equals the vector arm's top: a keyword-only hit cannot exceed it,
  -- because any row above the vector window's minimum is already IN the window.
  -- Under a recency weight the window is ranked by the blend, so a needle-
  -- matched high-cosine row aged out of it can be the top here — deliberately:
  -- admission is on raw similarity (as 020's absolute floor was under a weight),
  -- and the best real match is the right bar. NULL when no scored row has a
  -- vector (a pure keyword query), and then only keyword hits are admitted.
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

DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_search_thoughts_hybrid', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

CREATE OR REPLACE FUNCTION search_thoughts_hybrid(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
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
)LANGUAGE plpgsql
STABLE
ROWS 100
SET jit = off
AS $$
BEGIN
  -- ob1:seven-calls-eight — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `search signatures` reads it: this form is
  -- 075's, and without the 8-argument form beside it every call fails.
  -- 075: 027's function, as the 8-argument form with no min_trust — one body,
  -- not two to keep in step.
  RETURN QUERY SELECT * FROM search_thoughts_hybrid(query_embedding, query_text, match_threshold, match_count,
                                                    filter, recency_weight, half_life_days, NULL::text);
END;
$$;

COMMENT ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text) IS
  'match_thoughts and search_thoughts_keyword fused: reciprocal rank on the vector arm (in match_thoughts'' own order — its `score`, the recency blend at recency_weight, similarity alone at 0), presence per matched needle on the keyword arm, each hit''s own blended score as the tiebreak. Admission is RELATIVE (SMD-1300, migration 027): a scored row is kept when its raw cosine is within half of the top candidate''s (v_relfloor 0.5) and clears match_threshold, which the tools send as 0 so the relative cutoff governs; a keyword hit is exempt, and a negative match_threshold disables the relative cutoff (the raw ranked list). `similarity` stays the raw cosine. Needles come from extract_search_needles(query_text). min_trust (075) is passed to both arms (074: at or above that trust, a row with none below every word; NULL no constraint, any other word refused). Every argument required — a call by name naming min_trust names all eight; the 7-argument form, with its defaults, is this with min_trust NULL. Fixed top-N (no paging). See the 017, 020, 027, 074 and 075 headers.';

COMMENT ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float) IS
  'search_thoughts_hybrid with no min_trust: the 8-argument form called with NULL, under the defaults 020 gave this signature. The form the servers call (they send seven). See the 8-argument form and the 075 header.';

-- ---------------------------------------------------------------------------
-- 2. search_thoughts_current(…, min_trust) — 068's body, min_trust passed to
--    the hybrid.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_search_thoughts_current',
                  CASE WHEN to_regprocedure('search_thoughts_current(vector, text, float, int, jsonb, float, float, text)') IS NOT NULL THEN ''
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('search_thoughts_current(vector, text, float, int, jsonb, float, float)')), '') END,
                  false);

CREATE OR REPLACE FUNCTION search_thoughts_current(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  -- 075: no defaults, as the hybrid's 8-argument form (see it).
  match_threshold  float,
  match_count      int,
  filter           jsonb,
  recency_weight   float,
  half_life_days   float,
  -- 075: passed to the hybrid, which refuses a word off the ladder.
  min_trust        text
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,
  matched_needles  text[],
  needles          text[],
  needle_counts    int[],
  common_needles   text[],
  literal_only     boolean,
  score            float,     -- fused × the weight: the rank's own score
  fused            float,     -- the hybrid's score, before the weight
  demoted          text[],    -- the status_type and/or 'superseded' that weighted it; NULL when not
  window_rows      int,       -- every row: the window's size
  window_known     int,       -- every row: how many in the window carry a lifecycle
  window_demoted   int,       -- every row: how many in the window were demoted
  window_synced_at text,      -- every row: the latest source watermark in the window
  window_exact     boolean    -- every row: the top N is the whole admitted list, weighted
)
LANGUAGE plpgsql
STABLE
SET jit = off
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH n AS (SELECT least(greatest(coalesce(match_count, 10), 1), 100) AS v_count),
  win AS (
    SELECT h.*, least(100, 4 * n.v_count) AS w
      FROM n, search_thoughts_hybrid(query_embedding, query_text, match_threshold, least(100, 4 * n.v_count),
                                     filter, recency_weight, half_life_days, min_trust)
           WITH ORDINALITY AS h(hid, hcontent, hmetadata, hcreated_at, hsim, hmatched, hneedles, hcounts, hcommon, hliteral, hfused, ord)),
  st AS (
    SELECT win.*, s.status_type, s.synced_at, s.open,
           coalesce(s.open = false, false) AS settled,
           s.superseded_by IS NOT NULL AS superseded
      FROM win LEFT JOIN node_state(NULL) s ON s.thought_id = win.hid),
  agg AS (
    SELECT count(*)::int AS rows_,
           count(*) FILTER (WHERE open IS NOT NULL)::int AS known,
           count(*) FILTER (WHERE settled OR superseded)::int AS dem,
           max(synced_at) FILTER (WHERE open IS NOT NULL) AS synced,
           max(w) AS w
      FROM st)
  SELECT st.hid, st.hcontent, st.hmetadata, st.hcreated_at, st.hsim, st.hmatched, st.hneedles, st.hcounts, st.hcommon, st.hliteral,
         (st.hfused * CASE WHEN st.settled OR st.superseded THEN search_demote_weight() ELSE 1 END)::float,
         st.hfused::float,
         nullif(array_remove(ARRAY[CASE WHEN st.settled THEN st.status_type END,
                                   CASE WHEN st.superseded THEN 'superseded' END], NULL), '{}'),
         a.rows_, a.known, a.dem, a.synced,
         (a.rows_ < a.w OR a.rows_ - a.dem >= (SELECT v_count FROM n))
    FROM st CROSS JOIN agg a
   ORDER BY 11 DESC, (st.settled OR st.superseded), st.ord
   LIMIT (SELECT v_count FROM n);
END
$$;

DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_search_thoughts_current', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('search_thoughts_current(vector, text, float, int, jsonb, float, float, text)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

CREATE OR REPLACE FUNCTION search_thoughts_current(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
  recency_weight   float   DEFAULT 0.0,
  half_life_days   float   DEFAULT 90.0
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,
  matched_needles  text[],
  needles          text[],
  needle_counts    int[],
  common_needles   text[],
  literal_only     boolean,
  score            float,     -- fused × the weight: the rank's own score
  fused            float,     -- the hybrid's score, before the weight
  demoted          text[],    -- the status_type and/or 'superseded' that weighted it; NULL when not
  window_rows      int,       -- every row: the window's size
  window_known     int,       -- every row: how many in the window carry a lifecycle
  window_demoted   int,       -- every row: how many in the window were demoted
  window_synced_at text,      -- every row: the latest source watermark in the window
  window_exact     boolean    -- every row: the top N is the whole admitted list, weighted
)LANGUAGE plpgsql
STABLE
SET jit = off
AS $$
BEGIN
  -- ob1:seven-calls-eight — a CONTRACT SENTINEL, not prose (the 014
  -- convention). 075: 068's function, as the 8-argument form with no
  -- min_trust.
  RETURN QUERY SELECT * FROM search_thoughts_current(query_embedding, query_text, match_threshold, match_count,
                                                     filter, recency_weight, half_life_days, NULL::text);
END
$$;

COMMENT ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) IS
  'search_thoughts_hybrid with settled and superseded thoughts ranked below current ones, for search_thoughts'' opt-in prefer_current: over the hybrid''s top min(100, 4N), a thought node_state (058) says is settled (its ticket completed or canceled — a note under a Done ticket included) or superseded weighs search_demote_weight() (0.25) of its fused score, once; the window is re-sorted (ties to the current row, then the hybrid''s order) and cut to N. In practice every current match in the window ranks first; an exact-literal hit on a demoted thought is demoted too, keeping a quarter of its literal bonus (1/61 per literal it holds), so on a query of literals only, or holding several literals, it can still outrank current rows. Blocked or unknown status does not demote a thought (superseded still does). Returns the hybrid''s columns, then fused, demoted (why), and on every row the window''s size, lifecycle coverage, demoted count, latest source watermark and whether the top N is exact. min_trust (075) is passed to the hybrid; every argument required. Migration 059 / SMD-2255 (SMD-2074); plpgsql since 068; min_trust 075 / SMD-1724.';

COMMENT ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float) IS
  'search_thoughts_current with no min_trust: the 8-argument form called with NULL, under 059''s defaults. The form the servers call. Migration 059 / SMD-2255 (SMD-2074); plpgsql since 068; a wrapper since 075 / SMD-1724.';
