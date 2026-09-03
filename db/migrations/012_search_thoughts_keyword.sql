-- 012 — search_thoughts_keyword: exact-string retrieval
--
-- SMD-944. Retrieval in this fork is purely semantic: `search_thoughts` and the
-- ChatGPT-compat `search` both call `match_thoughts` (cosine over pgvector),
-- `list_thoughts` filters on metadata, `fetch` is a lookup by id. Nothing matches
-- the literal text of `thoughts.content`, so a caller who knows the exact string
-- — an error code, a ticket key, a commit SHA, a symbol name — has no way to ask
-- for it. An embedding blurs an identifier into a neighbourhood, and the 0.7
-- default threshold can drop the containing thought entirely.
--
-- ── That gap, measured rather than asserted ──────────────────────────────────
-- `evals/eval-keyword.ts`, over 441 real issues from an issue tracker. The
-- queries are tokens that appear in exactly one document BY SUBSTRING, and are
-- identifier-shaped; the answer is that document. Embeddings from
-- qwen3-embedding:4b, this fork's default, with the server's own query prompt:
--
--   instrument                          R@1    not in top-10    MRR
--   ---------------------------------   ----   -------------   -----
--   vector (qwen3-embedding:4b)          10%        37/60       0.201
--   keyword (this function)             100%         0/60       1.000
--
-- The keyword row is 100% by construction and proves nothing on its own — every
-- query is unique to one document, so a correct substring search cannot do worse.
-- It is there to show that the vector row is not. Sliced by what the token looks
-- like, because the three kinds are not equally hard and an average hides it:
--
--   digit or underscore  (SMD-506, temporal_activity)   n=27    7%   16/27 missed
--   slash or dot         (UI/API, db/config.mjs)        n=28    7%   19/28 missed
--   interior capitals    (getUserById)                  n= 5   40%    2/5  missed
--
-- The first row is the one the issue is actually about, and it is no better than
-- the others — 7% R@1, more than half not in the top ten at all. The embedding
-- ranked "additional_notes" 277th of 441 and "SMD-506" 150th.
--
-- Requires: migration 011 (pg_trgm). The index 011 builds is optional and this
-- function is correct without it — only slower. See "what happens without the
-- index" below.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- The strategy decision: substring, not tsvector
-- ═══════════════════════════════════════════════════════════════════════════
-- `schemas/enhanced-thoughts` answers this with `to_tsvector` + a
-- `websearch_to_tsquery`, falling back to ILIKE when the tsvector arm returns
-- too few rows. This function does substring matching only. That is a decision,
-- not an omission, and here is what it rests on.
--
-- Measured on PostgreSQL (PGlite 0.3.10, PG17, `simple` configuration), asking
-- both instruments the queries this feature exists to serve:
--
--   query                        tsvector    ILIKE     note
--   --------------------------   ---------   -------   ----------------------
--   upsert_thought               hit         hit       parser splits the
--                                                      underscore; the query
--                                                      becomes the phrase
--                                                      'upsert' <-> 'thought'
--   ERR_POSTGRES_SERVER_ERROR    hit         hit       same, four lexemes
--   PGRST202                     hit         hit       one alphanumeric token
--   SMD-944                      hit         hit       'smd' <-> '-944'
--   PGRST      (in PGRST202)     MISS        hit       fragment of a token
--   9543c29    (in 9543c29ab)    MISS        hit       short SHA prefix
--
-- tsvector is better than a first guess suggests — `websearch_to_tsquery`
-- produces a phrase query for an underscored identifier rather than a bare AND,
-- so "we upsert the thought later" is correctly NOT a hit for `upsert_thought`.
-- It handles four of the six cases above, with ranking, boolean operators and a
-- much smaller index.
--
-- It is still the wrong choice here, for three reasons:
--
--   1. The two rows it misses are the reason this feature exists. Everything
--      tsvector matches, it matches at token granularity — and token-granularity
--      word overlap is the closest thing to what the embedding already does, and
--      does better. The capability keyword search uniquely adds is EXACTNESS AND
--      SUB-TOKEN REACH: a fragment inside an identifier, a camelCase interior
--      (`UserById` in `getUserById`, which the parser does not split), a SHA
--      prefix, a substring of a filename. Choosing tsvector spends a new
--      subsystem on the half of the problem that was already covered.
--
--   2. It needs its own GIN index over the lexemes, which is a second index and
--      a second per-capture write cost, on top of the trigram index migration
--      011 already defines and measured.
--
--   3. Two arms means two rank scales and an arbitrary constant to reconcile
--      them (upstream uses a flat 0.35 for ILIKE hits against a computed
--      `ts_rank_cd`). One arm has one behaviour, describable to a caller in a
--      single sentence: "returns thoughts whose text contains this string".
--
-- What that costs, stated plainly rather than left to be discovered:
--
--   * No boolean operators. `a OR b`, `-not` and quoted phrases are not
--     supported; the query is one literal string.
--   * A multi-word query means literal adjacency. `postgres error` matches
--     "postgres error" and not "error from postgres". Semantic search is the
--     right tool for the second.
--   * No relevance ranking in the tsvector sense. See the ordering note below.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Escaping, which is a correctness issue and not a detail
-- ═══════════════════════════════════════════════════════════════════════════
-- `_` and `%` are ILIKE wildcards, and `_` is the single most common character
-- in the identifiers this function exists to find. Unescaped, measured:
--
--   ILIKE '%upsert_thought%'  matches  "call upsert_thought here"
--                                      "call upsert-thought here"   ← wrong
--                                      "call upsertXthought here"   ← wrong
--
-- A tool whose contract is exactness cannot return those. The needle is escaped
-- for backslash, percent and underscore before the wildcards are added, which
-- narrows the three rows above to the one correct row. `%` in a query — "100%
-- certain" — is likewise a literal.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Whitespace: the needle is used exactly as given
-- ═══════════════════════════════════════════════════════════════════════════
-- The query is NOT trimmed. That reads like an oversight and is the opposite:
-- an earlier version trimmed it, and `db/../test-store-sql.ts` caught what that
-- does. Searching for 'SMD-944 ' — trailing space deliberate, to exclude the
-- longer key — silently became a search for 'SMD-944', which also returns
-- SMD-9440. The caller asked for exactness and got approximation with no signal,
-- which is the one failure this whole function exists to remove.
--
-- So: the needle is matched as written, and `trim()` is used in exactly one
-- place, to decide whether the query is empty. An all-whitespace query is
-- refused as a caller bug; a query with whitespace AROUND something is honoured.
-- The cost is that a pasted needle with a stray leading space finds nothing, so
-- the MCP tool says so explicitly when the query it was handed has one.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Ordering, paging and total_count
-- ═══════════════════════════════════════════════════════════════════════════
-- ORDER BY occurrences DESC, created_at DESC, id
--
-- `occurrences` is how many times the needle appears, case-insensitively — a
-- thought that mentions an error code five times is more about it than one that
-- mentions it once. It is a tiebreak, not a relevance model, and it is not
-- normalised by length; a long document is not penalised.
--
-- `id` last is load-bearing. Every ORDER BY that feeds OFFSET/LIMIT needs a
-- unique final key or the sort is not total, and Postgres may order equal rows
-- differently between the two executions that fetch page 1 and page 2 — silently
-- duplicating one row and dropping another across the boundary. Upstream's
-- `ORDER BY rank DESC, created_at DESC` has no unique key and can do exactly
-- that. `db/test-schema.ts` pages a set of identical-rank rows and asserts the
-- union is the whole set with no repeats.
--
-- `total_count` is `count(*) OVER ()`, the true number of matches, not a capped
-- one. Upstream caps its hit set at 2000 + 500 rows and reports the capped
-- number as the total, which reads as a count and is not one. The window makes
-- the true count nearly free HERE specifically because the ordering already
-- forces the whole match set to be materialised — an unordered LIMIT could stop
-- early, a sorted one cannot, so the count costs no extra scan.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- The index: does an ESCAPED pattern still reach it?
-- ═══════════════════════════════════════════════════════════════════════════
-- This is the question the escaping above raises and nothing else answers. `_`
-- is the most common character in the identifiers this function exists to find,
-- and after escaping the pattern contains `\_`. If pg_trgm cannot extract grams
-- across that, every identifier search sequentially scans and flipping
-- OB1_TRGM_INDEX on by default buys nothing for the main case.
--
-- It can. `db/bench-keyword.ts`, PG16, needle `resolve_agent_zylotrope` in 5 of
-- N rows, with `resolve-agent-zylotrope` planted at the same frequency as a decoy
-- that only an unescaped pattern matches:
--
--   rows       index used by the function   plan of the equivalent query
--   -------    --------------------------   ----------------------------
--     1,000    no                           Seq Scan
--    10,000    yes                          Bitmap Heap Scan
--   100,000    yes                          Bitmap Heap Scan
--
-- "Index used" is `pg_stat_user_indexes.idx_scan` read before and after the call,
-- not a plan — EXPLAIN of a plpgsql function shows a Function Scan and nothing
-- about what happens inside it. The 1,000-row "no" is the planner being right:
-- 011's own benchmark put the crossover between 1,000 and 10,000 rows.
--
-- ── What the function costs over the bare pattern ────────────────────────────
-- Median of 5, same run, wall clock including the client round-trip:
--
--   rows       bare ILIKE   + occurrences   + total_count   full function
--   -------    ----------   -------------   -------------   -------------
--     1,000    2.91 ms      2.90 ms         2.80 ms         2.98 ms
--    10,000    0.48 ms      0.51 ms         0.47 ms         0.59 ms
--   100,000    0.51 ms      0.54 ms         0.51 ms         0.63 ms
--
-- The middle columns are not cumulative; each adds one extra to the bare pattern.
-- `total_count` is within noise of free, which is what the argument above
-- predicted: the ordering already materialises the whole match set, so the window
-- costs no extra scan. The whole function is ~0.1 ms over the raw pattern at
-- 100,000 rows, and part of that is returning content instead of ids.
--
-- ── The ceiling, which is selectivity and not scale ──────────────────────────
-- A needle in ~10% of rows, through the function: 0.90 ms at 1,000 rows, 7.3 ms
-- at 10,000, 75 ms at 100,000. That is the honest limit of this feature. A needle
-- in a tenth of the corpus has to touch a tenth of the heap however it is found,
-- and the occurrence count and total_count are then paid on all of it. Keyword
-- search is fast for the queries it exists for — exact, rare strings — and
-- unremarkable for everything else.
--
-- ── Without the index at all ─────────────────────────────────────────────────
-- A sequential scan, with the correct rows. Migration 011's measurements say
-- that is 267 ms at 100,000 rows against 0.20 ms with the index, and identical
-- below ~10,000 rows where the planner correctly ignores the index anyway.
--
-- Because this function is the first core caller of that index, SMD-944 also
-- flips `OB1_TRGM_INDEX` to default ON. The argument for off was specifically
-- "no core query can reach it", and that is no longer true. A deployment that
-- already applied 011 with the flag off keeps the old behaviour — migrations run
-- once — so `preflight.ts` compares the setting against `pg_indexes` on every
-- boot and prints the one statement to run.
--
-- A pattern under three characters gets nothing from the index in principle:
-- pg_trgm indexes three-character grams, so a two-character needle produces none
-- to look up and the planner reads the table. It still returns the right rows.
-- Unindexable is acceptable; silently wrong is not, and `db/test-schema.ts`
-- asserts the two-character case returns exactly the same set as a filter in
-- application code would.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why not extend match_thoughts, and why the name is not search_thoughts_text
-- ═══════════════════════════════════════════════════════════════════════════
-- A `mode` parameter on `match_thoughts` would give one function two return
-- shapes and two cost models behind one signature. A separate function keeps the
-- semantic contract — strict `> match_threshold`, cosine ordering — exactly as it
-- is, and `db/test-schema.ts` still asserts the three `upsert_thought` overloads
-- and the audit trail are untouched by this migration.
--
-- The name avoids `search_thoughts_text` deliberately. A deployment that
-- installed `schemas/enhanced-thoughts` by hand has a function of that name with
-- a different RETURNS TABLE, and `CREATE OR REPLACE` across a changed return
-- type is a hard error ("cannot change return type of existing function") that
-- would fail the migration for exactly the operators most likely to want this.
-- Hybrid ranking — fusing this with `match_thoughts` — is deliberately not here.
-- Get exact match right first; blending is a follow-up with its own evaluation.

CREATE OR REPLACE FUNCTION search_thoughts_keyword(
  p_query   text,
  p_limit   int   DEFAULT 25,
  p_offset  int   DEFAULT 0,
  p_filter  jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id           uuid,
  content      text,
  metadata     jsonb,
  created_at   timestamptz,
  occurrences  int,
  total_count  bigint
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  -- NOT trimmed. See the whitespace note in the header: trimming turns the
  -- exact needle 'SMD-944 ' into 'SMD-944', which also matches SMD-9440, and a
  -- tool whose contract is exactness cannot silently widen the string it was
  -- given. `trim()` appears once below, only to decide whether the query is
  -- empty.
  v_needle  text := coalesce(p_query, '');
  v_lower   text;
  v_pattern text;
  -- Clamped rather than trusted. `total_count` tells the caller what it did not
  -- get, so a capped page is visible rather than silent.
  v_limit   int  := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  int  := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- No needle, no rows. Returning the whole table for an empty query would make
  -- a bug in a caller look like a very slow success. An all-whitespace query is
  -- refused for the same reason — it is a caller bug, not a request for every
  -- thought containing two spaces — but note the asymmetry this creates and is
  -- meant to create: '  ' is refused, while ' a ' searches for a space, an "a"
  -- and a space, exactly as written.
  IF trim(v_needle) = '' THEN
    RETURN;
  END IF;

  v_lower := lower(v_needle);

  -- Escape order matters: backslash first, or the escapes introduced for % and _
  -- would themselves be escaped. See the measured false matches above.
  v_pattern := '%' || replace(replace(replace(v_needle, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  WITH hits AS (
    SELECT
      t.id         AS hit_id,
      t.content    AS hit_content,
      t.metadata   AS hit_metadata,
      t.created_at AS hit_created_at,
      -- Occurrence count by subtraction: how much shorter the text gets when
      -- every copy of the needle is removed, divided by the needle's length.
      -- Both sides are computed on the lowered text, because lower() is not
      -- length-preserving for every Unicode input and mixing the two would give
      -- a fractional, occasionally negative, count.
      ((length(lower(t.content)) - length(replace(lower(t.content), v_lower, '')))
        / length(v_lower))::int AS hit_occurrences
    FROM thoughts t
    WHERE t.content ILIKE v_pattern
      -- Same containment semantics as match_thoughts, including treating an
      -- empty object as "no filter" rather than as a predicate matching
      -- everything, so the planner sees no filter at all.
      AND (p_filter IS NULL OR p_filter = '{}'::jsonb OR t.metadata @> p_filter)
  )
  SELECT
    h.hit_id,
    h.hit_content,
    h.hit_metadata,
    h.hit_created_at,
    h.hit_occurrences,
    -- Computed over the whole match set, before OFFSET and LIMIT apply.
    count(*) OVER () AS hit_total
  FROM hits h
  ORDER BY h.hit_occurrences DESC, h.hit_created_at DESC, h.hit_id
  OFFSET v_offset
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION search_thoughts_keyword(text, int, int, jsonb) IS
  'Exact substring search over thoughts.content, case-insensitive, backed by the pg_trgm index from migration 011. Returns occurrences and the true total_count. No boolean operators: the query is one literal string. See the migration header for why this is substring and not tsvector.';
