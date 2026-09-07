-- 017 — search_thoughts_hybrid: one fused search, so the caller does not pick
--
-- SMD-958. Retrieval in this fork has been two disjoint tools since 012:
-- `search_thoughts` and the ChatGPT-compat `search` call `match_thoughts`
-- (cosine over pgvector); `search_thoughts_keyword` is an escaped ILIKE
-- substring. 012 chose that split deliberately — "get exact match right first;
-- blending is a follow-up with its own evaluation" — and left two things open:
--
--   * The caller has to know which retriever to use. A query that is partly a
--     literal and partly a description — "the scheduler timeout around
--     ERR_POSTGRES_SERVER_ERROR" — is served badly by both: the vector arm
--     blurs the identifier into a neighbourhood, the keyword arm ignores every
--     word except the literal. Nothing routes.
--   * The compat `search` cannot reach keyword search at all. ChatGPT's
--     restricted connectors, company knowledge and deep research match on the
--     exact `search`/`fetch` tool shapes, so that tool cannot grow a `mode`
--     parameter. For an identifier it gets what 012 measured over 441 real
--     issues: vector R@1 10%, 37 of 60 not in the top ten, MRR 0.201.
--
-- Adding a third tool fixes neither. Fusing behind the tools that exist does.
-- This migration adds `search_thoughts_hybrid`, which `search` and
-- `search_thoughts` now call; `search_thoughts_keyword` stays as the exact
-- tool, with its paging and its true `total_count`.
--
-- Requires: 012 (search_thoughts_keyword) and 014 (match_thoughts with the
-- filter inside the scan). Both are called, neither is changed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- The fusion: rank on the vector arm, presence on the keyword arm
-- ═══════════════════════════════════════════════════════════════════════════
-- Two candidates were on the table, and the ticket asked that one be chosen
-- rather than inherited.
--
-- WEIGHTED SCORE BLENDING — a·similarity + b·f(occurrences) — is rejected. The
-- two numbers are not commensurable: a cosine similarity is bounded and
-- continuous, an occurrence count is an unbounded integer whose scale depends on
-- document length. Any normalisation of the second (divide by the max? by
-- length? a log?) is a modelling decision with no data behind it, and the two
-- weights would be tuned to the one corpus available. Upstream's tsvector
-- variant does this with a flat 0.35 for ILIKE hits against a computed
-- ts_rank_cd; that constant is the thing being avoided.
--
-- RECIPROCAL RANK FUSION — score = Σ 1/(k + rank), k = 60 — needs no
-- normalisation, which is why it is the default answer. But applied to BOTH
-- lists it encodes something false: `search_thoughts_keyword` orders by
-- occurrence count, then recency, then id. That is a stable page order, not a
-- relevance ranking — on a token in fifty documents its rank positions are
-- close to arbitrary, and RRF would read them as evidence.
--
-- So the fusion here is asymmetric, and every part of it is a stated reason:
--
--   score  =  1/(k + vector_rank)            if the vector arm returned the row
--          +  matched_needles × 1/(k + 1)    for every literal the row contains
--
--   * The vector arm contributes its RRF term. Its rank IS a relevance order.
--   * The keyword arm contributes PRESENCE, not rank: each needle a row contains
--     is worth exactly what a rank-1 vector hit is worth. Containing the literal
--     the caller typed is a certainty, not a similarity, and a row containing
--     two of them beats a row containing one.
--   * Among rows the keyword arm found, the ORDER comes from the vector arm —
--     not from the vector list, which is cut at N rows, but from each hit's own
--     cosine similarity, computed for it directly (a primary-key probe, best of
--     the thought's vector and its chunks, exactly as match_thoughts scores a
--     row). That is the tiebreak, so a token in fifty documents is ordered by
--     meaning rather than by how many times it was repeated.
--
-- Two consequences fall out, and both are what a caller wants: a row both arms
-- return outranks any row only one returns (1/(k+1) + 1/(k+r) > 1/(k+1) for any
-- r); and with no needle in the query the score is a monotone function of
-- vector rank, so THE RESULT IS match_thoughts' RESULT, row for row — which is
-- how "hybrid must not lose to vector on the semantic set" is met for every
-- query that has no identifier in it, and db/test-schema.ts asserts it.
--
-- ── The gate: a query that is only literals gives the vector arm no vote ─────
-- Embedding `SMD-506` on its own is noise. 012 measured it: the containing
-- document ranked 150th, `additional_notes` 277th of 441. When the query minus
-- its needles has nothing left that the English text-search parser keeps as a
-- lexeme — no content word, only stopwords or nothing — the vector arm's rank
-- term is dropped (its similarity still orders the fill below the exact hits).
-- With a content word left, the two arms are peers as above.
--
-- Why this matters, concretely. Without the gate an identifier-only query ties
-- its exact hit (1/(k+1), keyword only) against the vector arm's top row
-- (1/(k+1), rank 1, semantically nearest to a string that means nothing), and
-- the tiebreak — similarity — hands first place to the noise. The identifier
-- set would score MRR 0.5 where the keyword tool alone scores 1.0. Breaking
-- ties the other way (needles first) fixes that and breaks the opposite case:
-- a strong semantic match with a wrong identifier appended ("the scheduler
-- timeout SMD-506", where SMD-506 is about something else) would put the
-- decoy first. The gate separates the two cases by the one thing that
-- distinguishes them — whether there was anything to embed. `evals/eval-hybrid.ts`
-- measures both variants beside this one; see the numbers below.
--
-- The stopword test is `to_tsvector('english', residual)`: whatever the parser
-- keeps is content. For a non-English query that degrades to "any word", which
-- is the conservative direction — the vector arm keeps its vote.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Needles: what the keyword arm is asked for
-- ═══════════════════════════════════════════════════════════════════════════
-- The keyword arm has to be given literals, and the whole query is almost never
-- one — a sentence does not occur verbatim in any thought. `extract_search_needles`
-- decides, in one place for every caller including a hand-written PostgREST
-- RPC:
--
--   1. A span in double quotes or backticks is a needle as written. That is the
--      caller saying "this part exactly": "App Store", `upsert_thought`.
--   2. Of the remaining tokens — split on whitespace and the punctuation that
--      wraps an identifier rather than the punctuation inside one, the same
--      delimiters evals/eval-keyword.ts uses — keep the identifier-shaped ones,
--      3 to 64 characters: a digit or underscore (but not a bare integer: 2024
--      is a year, not an identifier), an interior slash or dot (db/config.mjs,
--      pgvector 0.8.6), or an interior capital (getUserById). Ordinary words,
--      rare or not, are left to the vector arm: "harpsichord" has a meaningful
--      embedding, "PGRST202" does not.
--   3. Case-insensitive de-duplication, first eight.
--
-- A needle found in MORE THAN 100 THOUGHTS is not used. 100 is the keyword
-- function's page cap, so a needle within it comes back complete and the
-- presence boost lands on every row that contains it; one above it would boost
-- an arbitrary 100 of its rows — the first page of an ordering that is not a
-- relevance order — and leave the rest. A literal in that many thoughts is a
-- word, and the vector arm already handles words. Such needles are returned in
-- `common_needles` so the tool can say so.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- The window, paging, threshold — decided once, and SMD-945 inherits them
-- ═══════════════════════════════════════════════════════════════════════════
-- THE VECTOR ARM IS match_thoughts(query, −1, N): the N rows the semantic tool
-- would itself have returned for this call, and only those carry a rank term.
-- That is a decision the eval made, not a default. The first version fetched
-- least(100, greatest(4N, 40)) — the usual RRF over-fetch, on the usual worry
-- that a candidate cut before fusion cannot win. Here the worry does not apply
-- and the over-fetch had a cost:
--
--   * It does not apply because keyword hits carry their own similarity (the
--     direct probe above), so an exact hit outside the vector's top N loses
--     nothing by not being in the window; and a vector-only row below N is
--     below every vector-only row above N by construction.
--   * It had a cost because a row in BOTH arms outranks any row in one, and
--     "both" at F = 40 meant "contains the literal and is among the 9% nearest
--     by meaning" — which on a decoy query (a strong semantic match with a
--     wrong identifier appended) promoted the wrong document 19 times in 60.
--     At F = N it means "contains the literal and the semantic tool would have
--     returned it", which is what a caller reading "both arms agree" expects,
--     and the same set lost 15. Every other set was unchanged or better; see
--     the table below.
--
-- The keyword arm fetches its full page (100) per needle, because "complete or
-- dropped" is the rule above.
--
-- NO PAGING. The function returns a fixed top N, N clamped to 1–100 (the tools'
-- bound). 012's `total_count` is exact and cheap because its ordering already
-- materialises the whole match set; a fused result's total is the size of a
-- UNION that neither arm knows without running unbounded. Rather than report a
-- number that is not a count, the shape has no total and no offset. The exact
-- tool still pages.
--
-- THRESHOLD. The vector arm runs at −1.0 to get ranks for everything scoreable,
-- and a row the keyword arm did not return is kept only if `similarity >
-- match_threshold`, strictly, as match_thoughts does. A keyword hit is kept
-- whatever its similarity — the caller typed the string and the row contains
-- it. A keyword hit with no vector and no chunks (captured through the 2-arg
-- fallback, not yet re-embedded) has NULL similarity and is still returned, last
-- among ties, because exactness is the one thing it is certain of.
--
-- SMD-945 (recency) has not landed. When it does it belongs in match_thoughts,
-- and this function inherits it through the vector arm's rank. The keyword arm
-- is boolean here — its created_at ordering is never read — so age cannot be
-- counted twice, which was the interaction that ticket warned about.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Where it runs, and why one function calls two
-- ═══════════════════════════════════════════════════════════════════════════
-- One SQL function rather than fusion in server-portable: one round trip on the
-- SQL store and on PostgREST alike, the needle rule defined once for every
-- caller, and the ranker tested in PGlite like every function in this
-- directory. It calls `match_thoughts` and `search_thoughts_keyword` rather
-- than inlining either, so their measured access paths — HNSW with the filter
-- inside the scan (014), the trigram bitmap through an escaped pattern (012) —
-- are inherited, not re-proven, and cannot drift from what the two tools that
-- still expose them directly do. `db/bench-hybrid.ts` confirms both indexes are
-- read through this function, by pg_stat counters rather than EXPLAIN, at
-- 10,000 rows.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Measured — evals/eval-hybrid.ts, 441 real issues, qwen3-embedding:4b@1024
-- ═══════════════════════════════════════════════════════════════════════════
-- evals/eval-keyword.ts cannot judge a blend: its queries are hapax by
-- construction, so any fusion containing the keyword arm scores ~100% there.
-- The hybrid eval builds four sets mechanically from the corpus, each stated,
-- and asks the arms and the variants the same questions. The numbers are in
-- evals/README.md beside how each set was built; the table below is the one
-- this file's decisions rest on.
--
--   At the tools' own setting — ten results, threshold 0.5. "identifier" is
--   eval-keyword.ts's 60 hapax tokens, the token alone; "semantic" is
--   eval-real.ts's 441 titles against bodies; "mixed" is 38 titles the vector
--   arm misses at rank 1 with an identifier from the body appended (one found
--   in 2–30 documents and absent from the wrongly-ranked one); "decoy" is 60
--   titles the vector arm gets right at rank 1 with a token unique to a
--   DIFFERENT document appended.
--
--     set          n    arm        R@1    R@5   not in top-10   MRR
--     ----------  ---   -------   -----  -----  -------------  -----
--     identifier   60   vector     10%    15%        51        0.116
--                       keyword   100%   100%         0        1.000
--                       hybrid    100%   100%         0        1.000
--     semantic    441   vector     83%    97%         8        0.894
--                       keyword    10%    13%       376        0.111
--                       hybrid     83%    97%         9        0.895
--     mixed        38   vector     47%    89%         1        0.656
--                       keyword    26%    84%         0        0.503
--                       hybrid     95%   100%         0        0.974
--     decoy        60   vector     88%    98%         0        0.930
--                       keyword     7%     7%        56        0.067
--                       hybrid     75%    98%         0        0.850
--
--   Hybrid equals keyword on identifiers, equals vector on the semantic set
--   (one more miss in 441), takes the mixed set from 47% to 95% at rank 1, and
--   pays on the decoy set: the document that contains the literal AND is among
--   the ten nearest by meaning wins 15 times in 60 over the semantic top hit.
--   R@5 does not move there. That is "both arms" beating "one" as designed; the
--   header states it rather than tuning it away, and every row carries the
--   needles it matched so the caller can see why it is there.
--
--   The variants, same setting, where they differ from the shipped rule:
--     no gate                  identifier MRR 0.925 (0.850 at 100 results)
--     needles-first tiebreak   decoy MRR 0.513
--     plain RRF, both lists    semantic 0.869, mixed 0.947, identifier 0.925
--     wide window (4N, ≥ 40)   decoy 0.816, one more semantic miss
--     rarity-weighted presence one semantic miss fewer, nothing else; not shipped
--
--   At 100 results and no threshold — the setting comparable to the published
--   baselines — vector is 0.899 on the semantic set and hybrid 0.897; the
--   identifier and mixed sets are unchanged; the decoy set falls to 0.713,
--   because at N = 100 "both arms" means "among the hundred nearest", which
--   most decoys are. The tools send ten.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- What this query must not do — found by db/bench-hybrid.ts, not by reading
-- ═══════════════════════════════════════════════════════════════════════════
-- The first draft joined `thoughts` at the end to fetch each result's columns,
-- and cost 15 ms per call at 10,000 rows where its two arms together cost 1.3.
-- Neither arm was slow. The planner cannot see into a plpgsql function, so it
-- estimates 1,000 rows from each function scan; the union of the two came to
-- ~6,000 candidates, the join to `thoughts` was planned as a hash of the whole
-- table, and the estimated cost — 216,000 against a real cost of a few hundred
-- — crossed `jit_above_cost`. PostgreSQL then JIT-compiled 112 expressions on
-- EVERY call (plpgsql caches the plan; the compilation is per execution), and
-- that was the 14 ms. auto_explain with nested statements showed it; nothing
-- at the SQL level did.
--
-- Two changes, both kept:
--   * No join to `thoughts`. Both arms already return the row — content,
--     metadata, created_at — so the candidates carry their columns through,
--     and only a keyword hit outside the vector window touches the table again
--     (the similarity probe, a primary-key lookup). That removes the hash of
--     the table the estimate invited, which at 100,000 rows would have been a
--     real cost and not only an estimated one.
--   * `SET jit = off` on the function. Nothing here has enough rows for JIT to
--     pay for itself — the arms return at most 100 rows each — and the
--     estimate it is priced from is structurally wrong, not wrong for this
--     corpus. The setting is scoped to the call, as 014's hnsw setting is.
--
-- The bench prints the fusion's overhead over its two arms called separately,
-- and the wrapper's cost on a query with no needle, which is what every
-- ordinary semantic search pays now.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Shape, grants, and the trap
-- ═══════════════════════════════════════════════════════════════════════════
-- A third row type, deliberately. store.ts models `ThoughtMatch` (similarity)
-- and `ThoughtKeywordMatch` (occurrences, totalCount) as distinct because their
-- numbers are not comparable; a fused row is neither with a field reinterpreted.
-- `similarity` here is nullable; `matched_needles` is per row; `needles`,
-- `common_needles` and `literal_only` repeat on every row, the way 012 repeats
-- `total_count`, so a caller reading one row knows what the query was taken to
-- mean.
--
-- No GRANT, no SECURITY DEFINER — 004, 008, 010 and 012 each say why: the
-- Supabase roles do not exist off Supabase, and this reads exactly what its
-- caller could already read. db/test-schema.ts [10] asserts it repo-wide.
--
-- `CREATE OR REPLACE FUNCTION` cannot change a return type, and RETURNS TABLE
-- is the return type. A later migration that needs another column must `DROP
-- FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb)` first.
-- Same for `extract_search_needles(text)` — text[] today.

-- Load pgvector into this session before a vector(N) parameter is resolved;
-- 014 explains the case this covers.
SELECT '[1]'::vector;

CREATE OR REPLACE FUNCTION extract_search_needles(p_query text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_q     text   := coalesce(p_query, '');
  v_rest  text;
  v_tok   text;
  v_out   text[] := '{}';
  v_seen  text[] := '{}';
  m       text[];
BEGIN
  -- 1. Quoted spans, as written. "…" or `…`; a span that is only whitespace,
  --    or outside 3–64 characters, is ignored rather than searched.
  FOR m IN SELECT regexp_matches(v_q, '"([^"]+)"|`([^`]+)`', 'g') LOOP
    v_tok := coalesce(m[1], m[2]);
    CONTINUE WHEN trim(v_tok) = '' OR length(v_tok) < 3 OR length(v_tok) > 64;
    CONTINUE WHEN lower(v_tok) = ANY (v_seen);
    v_out  := v_out  || v_tok;
    v_seen := v_seen || lower(v_tok);
    EXIT WHEN cardinality(v_out) >= 8;
  END LOOP;

  -- 2. Identifier-shaped tokens from what is left. Split on whitespace and the
  --    punctuation that WRAPS an identifier; strip a leading or trailing dot or
  --    hyphen (sentence punctuation), keep the interior ones (SMD-944, v0.8.6).
  v_rest := regexp_replace(v_q, '"[^"]*"|`[^`]*`', ' ', 'g');
  FOR v_tok IN SELECT regexp_split_to_table(v_rest, '[\s`"''(){}\[\]<>,;:!?*|]+') LOOP
    EXIT WHEN cardinality(v_out) >= 8;
    v_tok := regexp_replace(v_tok, '^[.\-]+|[.\-]+$', '', 'g');
    CONTINUE WHEN length(v_tok) < 3 OR length(v_tok) > 64;
    CONTINUE WHEN v_tok ~ '^[0-9]+$';                                   -- a bare number is not an identifier
    CONTINUE WHEN NOT (v_tok ~ '[0-9_]' OR v_tok ~ '[./]' OR v_tok ~ '[a-z][A-Z]');
    CONTINUE WHEN lower(v_tok) = ANY (v_seen);
    v_out  := v_out  || v_tok;
    v_seen := v_seen || lower(v_tok);
  END LOOP;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION extract_search_needles(text) IS
  'The literals search_thoughts_hybrid asks the keyword arm for: quoted or backticked spans as written, then identifier-shaped tokens (a digit or underscore, an interior slash or dot, an interior capital; 3-64 chars; not a bare number). Case-insensitively de-duplicated, at most eight. See the 017 header.';

CREATE OR REPLACE FUNCTION search_thoughts_hybrid(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,     -- NULL for a keyword hit with no vector and no chunks
  matched_needles  text[],    -- the needles this row contains, in query order
  needles          text[],    -- every row: the needles the keyword arm was asked for
  common_needles   text[],    -- every row: extracted, but in more than 100 thoughts, so not used
  literal_only     boolean,   -- every row: the query had nothing to embed, so the vector arm's rank was not scored
  score            float
)
LANGUAGE plpgsql
STABLE
-- Scoped to this call, like 014's hnsw setting. See "what this query must not
-- do" in the header: the planner prices JIT off an estimate that is three
-- orders of magnitude high here, and paid 14 ms of compilation per call for it.
SET jit = off
AS $$
DECLARE
  -- RRF's conventional constant. A rank-1 hit is worth 1/61; presence of one
  -- needle is worth the same.
  k              constant int := 60;
  -- Clamped rather than trusted, to the bound the tools enforce. It is also the
  -- vector arm's window: the rows match_thoughts would return for this call are
  -- the rows whose rank counts (see the header for the measurement behind that).
  v_count        int    := least(greatest(coalesce(match_count, 10), 1), 100);
  v_filter       jsonb  := coalesce(filter, '{}'::jsonb);
  v_all          text[] := extract_search_needles(query_text);
  v_residual     text   := coalesce(query_text, '');
  v_literal_only boolean;
  v_needle       text;
BEGIN
  -- The gate. Remove every extracted needle (and the quotes that marked one)
  -- from the query; if the English parser keeps no lexeme of what is left,
  -- there was nothing to embed and the vector arm's rank is not scored.
  FOREACH v_needle IN ARRAY v_all LOOP
    v_residual := replace(v_residual, v_needle, ' ');
  END LOOP;
  v_residual     := regexp_replace(v_residual, '["`]', ' ', 'g');
  v_literal_only := cardinality(v_all) > 0 AND length(to_tsvector('english', v_residual)) = 0;

  RETURN QUERY
  WITH
  -- Keyword arm: the full page per needle, with total_count deciding whether
  -- that page is the whole match set. `ord` keeps query order for the arrays.
  -- The row's columns ride along: both arms already return the whole row, so
  -- nothing below joins `thoughts` again (see "what this query must not do").
  kw AS (
    SELECT n.needle, n.ord, h.id AS hit_id, h.content AS hit_content, h.metadata AS hit_metadata,
           h.created_at AS hit_created_at, h.total_count
    FROM unnest(v_all) WITH ORDINALITY AS n(needle, ord)
    CROSS JOIN LATERAL search_thoughts_keyword(n.needle, 100, 0, v_filter) AS h
  ),
  kw_needles AS (
    SELECT n.needle, n.ord, coalesce(max(k2.total_count), 0) AS total
    FROM unnest(v_all) WITH ORDINALITY AS n(needle, ord)
    LEFT JOIN kw k2 ON k2.needle = n.needle
    GROUP BY n.needle, n.ord
  ),
  used AS (
    SELECT coalesce(array_agg(kn.needle ORDER BY kn.ord) FILTER (WHERE kn.total <= 100), '{}'::text[]) AS needles,
           coalesce(array_agg(kn.needle ORDER BY kn.ord) FILTER (WHERE kn.total  > 100), '{}'::text[]) AS common
    FROM kw_needles kn
  ),
  hits AS (
    SELECT k3.hit_id,
           array_agg(k3.needle ORDER BY k3.ord) AS matched,
           (array_agg(k3.hit_content))[1]  AS hit_content,
           (array_agg(k3.hit_metadata))[1] AS hit_metadata,
           min(k3.hit_created_at)          AS hit_created_at
    FROM kw k3
    WHERE k3.total_count <= 100
    GROUP BY k3.hit_id
  ),
  -- Vector arm: ranks over the N rows match_thoughts would return, whatever
  -- their similarity — the threshold is applied below, after the exact hits
  -- have been exempted from it.
  vec AS (
    SELECT m.id AS vid, m.content AS vcontent, m.metadata AS vmetadata, m.created_at AS vcreated_at,
           m.similarity AS vsim,
           row_number() OVER (ORDER BY m.similarity DESC, m.id) AS rnk
    FROM match_thoughts(query_embedding, -1.0, v_count, v_filter) AS m
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
      -- rule match_thoughts uses: best of the thought's own vector and its chunks.
      coalesce(
        v.vsim,
        (SELECT max(1 - (x.e <=> query_embedding))
         FROM (SELECT t2.embedding AS e FROM thoughts t2 WHERE t2.id = c.cid AND t2.embedding IS NOT NULL
               UNION ALL
               SELECT ch.embedding FROM thought_chunks ch WHERE ch.thought_id = c.cid) AS x)
      ) AS sim,
      h.matched,
      (CASE WHEN v.rnk IS NOT NULL AND NOT v_literal_only THEN 1.0 / (k + v.rnk) ELSE 0.0 END)
        + coalesce(cardinality(h.matched), 0) * (1.0 / (k + 1)) AS fused
    FROM cand c
    LEFT JOIN vec  v ON v.vid    = c.cid
    LEFT JOIN hits h ON h.hit_id = c.cid
  )
  SELECT
    s.cid, s.content, s.metadata, s.created_at,
    s.sim::float,
    coalesce(s.matched, '{}'::text[]),
    u.needles,
    u.common,
    v_literal_only,
    s.fused::float
  FROM scored s
  CROSS JOIN used u
  WHERE s.matched IS NOT NULL OR s.sim > match_threshold
  ORDER BY s.fused DESC, s.sim DESC NULLS LAST, s.created_at DESC, s.cid
  LIMIT v_count;
END;
$$;

COMMENT ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb) IS
  'match_thoughts and search_thoughts_keyword fused: reciprocal rank on the vector arm, presence per matched needle on the keyword arm, each hit''s own cosine similarity as the tiebreak. Needles come from extract_search_needles(query_text). Fixed top-N (no paging); a query with no needle returns exactly what match_thoughts returns. See the 017 header for the decisions and the measurements.';
