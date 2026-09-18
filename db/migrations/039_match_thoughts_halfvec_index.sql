-- ============================================================================
-- 039 — match_thoughts walks a half-precision index: the two HNSW indexes
--        are rebuilt over `embedding::halfvec(D)` under their names, and the
--        walk branches order by that cast; the stored vectors, the exact
--        branch and the similarity stay full precision (SMD-1501)
--
-- requires: pgvector >= 0.8.0
--   (halfvec and its HNSW operator classes arrived in 0.7.0; this file
--   redefines match_thoughts with 014's and 019's SET clauses, so it declares
--   the floor those declared; db/migrate.ts reads the line)
--
-- Why
--   At the shipped width — 1,024 dimensions, qwen3-embedding:4b truncated —
--   an HNSW element over `vector` is 4,096 bytes of floats plus its neighbour
--   lists, and pgvector packs an index page by whole elements: two do not fit
--   an 8 KB page, so every vector costs the index a page. Measured on two
--   corpora below, 8.2 KB per row on both tables — which puts a
--   ten-million-row brain's `thoughts` index near 80 GB before its chunks',
--   not the "four times 5.4 GB" the width ratio from SMD-1018's
--   64-dimensional bench suggested. Three half-precision elements fit a page
--   (2.75 KB per row, measured); a binary-quantised element is 128 bytes and
--   a page holds twenty (0.4 KB). What either costs in recall on REAL vectors,
--   and whether a rerank on the full vectors gives it back, was the question
--   (the published results — Instaclustr's dbpedia-openai-1M runs, the 2026
--   recall surveys — are other models' vectors). evals/eval-quant.ts measured
--   it on the two real corpora this fork holds at 1,024 dimensions:
--   LongMemEval-S under the shipped model (19,825 whole vectors and 56,267
--   windows, the two tables match_thoughts scans) and LongMemEval-M under
--   qwen3-embedding:0.6b at the same width (51,660 and 145,705), the
--   unfiltered default path at match_count 10 for the 470 questions, each
--   arm's ten ids against an exact pass made with no vector index in
--   existence. FORK.md change 81 has every row; the default ef_search's:
--
--     arm, ef_search 40             recall@10 vs exact   median ms    index bytes   build time
--                                   S       M            S     M      (of vector)   (of vector)
--     vector (001 / 007)            0.984   0.971        4.1   4.2    100%          100%
--     halfvec (this file)           0.974   0.970        3.1   4.1     33%           57–64%
--     binary, 40 candidates         0.955   0.939        1.8   3.1      5%           18–25%
--     binary, 80 → 40 reranked      0.980   0.973        3.1   4.1      5%
--     binary, 160 → 40 reranked     0.993   0.991        5.6   7.9      5%
--     binary, 400 → 40 reranked     0.998   0.997       13.3  17.4      5%
--
--   (Each corpus was built and measured twice; the table is the second
--   pass. The first put halfvec at 0.981 / 0.971 and vector at 0.983 /
--   0.973, S / M — an HNSW graph built in parallel differs build to build,
--   and a hundredth of recall is that spread; the latencies moved by a
--   quarter between passes on a shared machine. "Exact" is the function's
--   own candidate shape under an exact scan — the true nearest v_fetch on
--   each side, merged by MAX — which is what a perfect index would return;
--   not the ten highest MAX scores over every row, which the two-CTE shape
--   does not compute, and the harness counts how often the two differ: on
--   none of the 470 questions, on either corpus.) halfvec returns what the
--   vector index returns, within the spread at every ef_search measured
--   (40 / 100 / 400: 0.974 / 0.993 / 0.999 against 0.984 / 0.996 / 0.999 on
--   S; 0.970 / 0.989 / 0.999 against 0.971 / 0.989 / 0.998 on M), in the
--   same time or less — the walk reads a third of the pages — and in a
--   third of the bytes; at ef_search 40 it gives the identical ten rows on
--   93% of S's questions and 95% of M's, and the same LongMemEval gold
--   sessions within a point. Binary is declined, not on the numbers alone:
--   without a rerank it loses three hundredths of recall at the default
--   ef_search; reranked at 80 → 40 it meets every number the bar asks
--   (recall within four thousandths, latency at the vector index's, a
--   twentieth of the bytes); reranked further (160 → 40) it passes the
--   vector index's recall at 1.4–1.9× its latency, because every candidate's
--   full vector is read out of TOAST, once per CTE. But any rerank is a
--   change to the body — a subquery and a second depth to size in each of
--   the four walk CTEs — that returns the identical ten rows on only 79–83%
--   of questions, where halfvec clears the bar with a cast and 93–95%. It
--   stays the right shape for a brain past what halfvec keeps in memory — a
--   choice to make on that brain's numbers, and eval-quant.ts's binary arm
--   is how.
--
-- What
--   Two things, in this order.
--
--   1. The index swap. For each of `thoughts` and `thought_chunks`: an HNSW
--      index over the expression `(embedding::halfvec({{EMBEDDING_DIM}}))`
--      with `halfvec_cosine_ops` is built under a STAGING name
--      (`<table>_embedding_halfvec_idx`), the `vector_cosine_ops` index 001 or
--      007 built under the shipped name is dropped, and the staging index
--      takes the shipped name. The names stay because everything that reads
--      them stays: preflight, db/test-live.ts [5]/[5c], bench-hnsw.ts and
--      bench-plan.ts match plans on `Index Scan using thoughts_embedding_idx`,
--      and the suites drop and recreate the index by that name. A re-run —
--      or `--reapply` — finds the shipped name already over halfvec, of this
--      shape and valid, and does nothing (the DO block reads pg_get_indexdef
--      through to_regclass, so an index dropped by hand is simply built). A
--      staging index that already exists is adopted when it is valid and of
--      this shape, refused by name when of another, and dropped first when
--      it is INVALID: that is the by-hand path for a large brain, below.
--
--   2. The function. 038's body verbatim but for the two walk branches — the
--      unfiltered path and the broad filter — whose four candidate ORDER BYs
--      become `embedding::halfvec(D) <=> query_embedding::halfvec(D)`, the
--      index's expression token for token. Everything else is as 038 left
--      it: the similarity is `1 - (embedding <=> query_embedding)` on the
--      full vector (the candidates' heap rows are read anyway, so scoring
--      them at full precision costs nothing and keeps the threshold, the
--      merge with the chunk side and the exact branch on one scale); the
--      exact branch reads no index and casts nothing; v_fetch, v_exact, the
--      gate, the blend, the sentinel, the SET clauses, ROWS 10, 020's DROP of
--      the 4-argument form with its ACL capture and replay — carried.
--      search_thoughts_hybrid calls match_thoughts by name and inherits.
--
--   The stored vectors do not change. db/reembed.ts, the servers, every
--   writer and every reader of `embedding` are untouched; the expression
--   index keeps itself on every write, as the column index did.
--
-- Design
--   * An expression index, not a halfvec column. A second column would be a
--     second copy of every vector to write in step with the first, through
--     every writer this fork has audited onto one path (changes 69 and 71),
--     and a re-embed would have two to keep. The cast in the index is one
--     conversion per write; the cast on the query side is one per call.
--   * The cast written on both sides. The planner matches an index
--     expression to an ORDER BY's left operand structurally, so the column's
--     cast is what decides the plan: `embedding <=> q` has no index after
--     this file. The right operand pgvector would cast implicitly (vector to
--     halfvec is an implicit cast; the operator resolves to halfvec's); it is
--     written out so the statement says what it does and so a reader of the
--     body, or of a plan's `Order By:` line, sees one expression on both
--     sides. test-schema [38] holds the walk to an Index Scan by the index's
--     name under the body's ORDER BY and to none under the raw column's.
--   * The similarity on the full vector. The halfvec walk decides which
--     v_fetch candidates each side yields; the score they are merged, cut
--     and ordered by is the same number 038 computed, so a caller's
--     threshold and a stored `similarity` compare across the upgrade. The
--     alternative — `1 - (halfvec <=> halfvec)` — saves nothing (the row is
--     in hand) and moves every similarity by up to a few parts in ten
--     thousand.
--   * halfvec, not binary (Why): at the default count the rerank binary
--     needs costs more than the walk it saves, and a walk that skips the
--     rerank drops three to four hundredths of recall. The bytes it would
--     save past halfvec's third are a question for a brain that has them.
--   * The build inside the file, not CONCURRENTLY. migrate.ts runs each file
--     in one transaction, where CONCURRENTLY is refused. A plain CREATE INDEX
--     holds SHARE on the table for the build: readers go on — the walk uses
--     the old index until the swap — and writers wait. Measured under
--     maintenance_work_mem 2GB with four parallel workers, the graph in
--     memory: 7.9 s for the S corpus's two indexes (76,092 rows), 18.5 s
--     for M's (197,365) — about 100 µs a row at that setting (change 28's
--     64-dimensional builds ran at one rate from one to ten million rows),
--     so a million-row brain is a couple of minutes of held writers and ten
--     million something like twenty. UNDER THE SERVER'S DEFAULT it is not.
--     This file is the first bulk graph build most brains meet — 001 and 007
--     indexed an empty table that then grew row by row — and neither the file
--     nor migrate.ts sets maintenance_work_mem, so the compose stack's
--     migrate service and a `bun db/migrate.ts` from a shell build under
--     64 MB and two workers: pgvector keeps the graph in that memory while it
--     fits (some 25,000 vectors at this width, 2.5 KB each) and finishes the
--     rest in its on-disk phase, many times slower, with a NOTICE no driver
--     here surfaces. Size it first, for the session the migrator gets:
--     2.5 KB × the vectors across both tables (thoughts plus windows) —
--     about 250 MB per 100,000 vectors, 2.5 GB per million — as
--     `ALTER ROLE <the migrating role> SET maintenance_work_mem = '<size>'`
--     and `… SET max_parallel_maintenance_workers = 4`, RESET after. With
--     workers the graph sits in dynamic shared memory, so a container's
--     /dev/shm must hold it (deploy/compose.yaml's POSTGRES_SHM_SIZE,
--     db/with-postgres.sh's OB1_PG_SHM_SIZE), or workers = 0 builds in
--     backend memory. migrate.ts prints the vector count and the setting in
--     force just before this file runs, so the two can be compared before
--     the wait. For a brain where holding writers that long is too much,
--     build the staging indexes first, by hand, outside the migrator — the
--     same memory rule, in that session — and let this file adopt them:
--
--       SET maintenance_work_mem = '<size>';
--       SET max_parallel_maintenance_workers = 4;
--       CREATE INDEX CONCURRENTLY thoughts_embedding_halfvec_idx
--         ON thoughts USING hnsw ((embedding::halfvec({{EMBEDDING_DIM}})) halfvec_cosine_ops);
--       CREATE INDEX CONCURRENTLY thought_chunks_embedding_halfvec_idx
--         ON thought_chunks USING hnsw ((embedding::halfvec({{EMBEDDING_DIM}})) halfvec_cosine_ops);
--       bun db/migrate.ts
--
--     CONCURRENTLY holds no writers and takes about the wall time a plain
--     build takes under the same memory; the swap then needs only the
--     lock the DROP and RENAME take, for milliseconds.
--     The swap then drops the old index and renames — milliseconds once the
--     lock is granted (Failure modes: the DROP's lock). An interrupted
--     concurrent build leaves the staging index INVALID; the DO block drops
--     such an index and builds its own rather than adopt a graph with rows
--     missing. A valid index under the staging name that is not this shape —
--     another operator class, another width, not HNSW — is refused by name:
--     nothing is guessed about what an operator built. And the staging index
--     survives a rolled-back run, which the plain build does not (below).
--
-- Failure modes, each with its cost
--   * A statement that orders by the raw column. `ORDER BY embedding <=> q`
--     from direct SQL — an operator's psql, a recipe's own query, a harness —
--     had the vector index until this file and has no index after it: a
--     sequential scan of the table, exact and slow (10–100 ms per hundred
--     thousand rows at this width). The cast is the index's key now;
--     db/test-live.ts [5] orders by it for that reason. Nothing in the
--     repo's runtime does this — the servers and both stores call
--     match_thoughts, and search_thoughts_hybrid calls it by name — and the
--     evals that do (an exact oracle, a k-NN control) mean the scan.
--   * An earlier definer re-applied by hand. 038 or 020 applied over this
--     file puts a body that orders by the raw column over an index that
--     holds the cast: every walk becomes the sequential scan above, under
--     `enable_seqscan = off` (a penalty, not a prohibition — 019). Answers
--     are exact, latency is 019's problem back. preflight's remedy names
--     this file as match_thoughts' last definer, and re-applying it alone
--     restores the body (the index is already right, so the swap does
--     nothing).
--   * 001 or 007 re-applied by hand. Their `CREATE INDEX IF NOT EXISTS` finds
--     the shipped name held by the halfvec index and does nothing.
--   * The index dropped and rebuilt by hand from 001's DDL. A vector index
--     under the shipped name again, and the halfvec body above it: the
--     sequential scan again. Re-applying this file swaps it back.
--   * Half-precision rounding. Two candidates whose distances differ by less
--     than fp16 tells apart can change places in the walk; the merge and the
--     final ORDER BY then score them at full precision. Nothing measurable on
--     the real vectors above, and nothing on random ones either: 2,000
--     random unit vectors at this width through the walk itself give about
--     7 of 10 exact ids at ef_search 40 under either index (HNSW's hardest
--     case, change 28's floor).
--   * A statement_timeout. migrate.ts sets none, and a platform or a hardened
--     role does (Supabase sets one per role): a build of minutes would be
--     cancelled part-way and the file rolled back after the wasted work. The
--     file lifts it for its own transaction (`set_config('statement_timeout',
--     '0', true)` before the swap — local, as 023 scopes its lock_timeout) and
--     leaves the session's setting alone.
--   * The DROP's lock. CREATE INDEX holds SHARE; DROP INDEX and ALTER INDEX
--     RENAME take ACCESS EXCLUSIVE on the table, inside the file's one
--     transaction, so the swap waits behind every open reader — an
--     idle-in-transaction pooled connection, a long SELECT — and queues new
--     readers behind it while it waits. migrate.ts sets lock_timeout for the
--     transaction (config.mjs's LOCK_TIMEOUT_S); a reader held past it aborts
--     the statement and rolls the file back, the plain build with it, to be
--     run again from nothing. A staging index built by hand beforehand is its
--     own committed relation and survives the rollback: re-run, and the swap
--     adopts it in the milliseconds it takes once the lock is granted. End
--     the holder first, as the migrator's message says.
--   * A cheaper index moves the planner. The halfvec index is a third of the
--     pages, and the planner prices its scan lower — so on a filtered call
--     whose plan sat on the edge between the walk and the GIN bitmap, it can
--     now walk where it used to read the bitmap, and the bitmap was exact.
--     db/test-live.ts [5b] is that case: 2,000 random rows, a 99% filter, the
--     walk branch — under the vector index the planner served every call
--     from the bitmap (exact, 100 of 100 ids), and under this one its custom
--     plans take the index (2.6 ms and the walk's 7 of 10 on random vectors)
--     while its generic plan, adopted from the sixth call of a session, still
--     takes the bitmap (9.7 ms, exact). Nothing moved but the plan's cost
--     estimate; the walk's recall is what it was. At scale the routing gate
--     (038) and the GIN-or-HNSW choice change 28 measured are unchanged in
--     kind; FORK.md change 81 has section A under this file at the two
--     published scales.
--   * Dimensions past 2,000. halfvec's HNSW ceiling is 4,000 where vector's
--     is 2,000, and a model's native width (qwen3-embedding:4b's 2,560)
--     would fit — but 001 still builds the vector index first, at the column's
--     width, so config.mjs's ceiling stays 2,000 here. A follow-up, not this
--     file.
--   * A filtered call under the exact threshold. Unchanged: the exact branch
--     reads rows by id, no index, full precision.
--   * hnsw.ef_search, the walk's bounds, the gate. Unchanged and not this
--     file's; SMD-1465 sizes ef_search on real vectors, and the recall
--     column above is what the default gives on these.
--
-- Cost, measured (evals/eval-quant.ts, this file's development machine —
-- Apple M5 Pro, podman VM, pgvector 0.8.6, maintenance_work_mem 2GB, four
-- parallel workers; FORK.md change 81 has the tables)
--
--     LongMemEval-S, qwen3-embedding:4b@1024 (19,825 thoughts + 56,267 chunks)
--       vector   thoughts 155 MB, chunks 423 MB; built in 13.9 s (both)
--       halfvec  thoughts  52 MB, chunks 141 MB; built in  7.9 s
--     LongMemEval-M, qwen3-embedding:0.6b@1024 (51,660 + 145,705)
--       vector   thoughts 404 MB, chunks 1,079 MB; built in 28.7 s
--       halfvec  thoughts 135 MB, chunks   360 MB; built in 18.5 s
--
--   Per call, unfiltered, match_count 10, median of 470 questions (round
--   trip from the harness): S 4.1 → 3.1 ms, M 4.2 → 4.1 ms at ef_search 40;
--   at 400, S 18.1 → 9.1 ms, M 17.4 → 14.8 ms.
--
-- What a successor must carry
--   038's list — `SET hnsw.iterative_scan = relaxed_order`, `SET
--   enable_seqscan = off`, `ROWS 10`, the `ob1:filter-inside-scan` sentinel
--   in the body, the pgvector floor line, 020's DROP of the 4-argument form
--   with the ACL capture before and the replay after, the two template
--   constants and the estimate as one statement over locals declared at
--   entry — and now the cast: the walk branches order by
--   `embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})`
--   on both tables, the expression the two indexes are built over. A
--   successor that changes the index changes the ORDER BY with it, in the
--   same file, or the walk has no index; test-schema [38] holds the pair.
--
-- Prerequisites
--   Migration 038 (the body this file carries). pgvector 0.8.0 or later.
--   maintenance_work_mem sized for the graph in the migrating session
--   (Design: 2.5 KB a vector across both tables), and /dev/shm to hold it
--   under parallel workers. Applied by `bun db/migrate.ts`; on a brain past
--   a million rows, the CONCURRENTLY builds under Design first.
--
-- Expected outcome
--   `match_thoughts` returns what 038's returned up to the index's
--   approximation: at the default ef_search the identical ten rows on 93%
--   of S's questions and 95% of M's, and recall against the exact answer
--   within a hundredth (the build-to-build spread) — evals/eval-filtered.ts's
--   unfiltered control reports the rows that moved on its corpus and stops
--   only when the two paths no longer agree. pg_indexes shows both indexes
--   under their names over `halfvec_cosine_ops`; pg_relation_size shows each
--   a third of what it was; EXPLAIN of the unfiltered statement reads `Index
--   Scan using thoughts_embedding_idx` and `… thought_chunks_embedding_idx`
--   (db/test-schema.ts [38], db/test-live.ts [5] and [5c]); pg_proc.prosrc
--   carries the cast on both sides in the walk branches and nowhere in the
--   exact one; and preflight's `walk index` check reads the pair — the
--   body's ORDER BY against each index's definition and validity — as ok.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below: the SET
-- clause names an hnsw.* setting, which a non-superuser owner is refused for
-- until the library is loaded (014's header has the reproduction).
SELECT '[1]'::vector;

-- The build inside the swap below can run for minutes on a large brain, and a
-- statement_timeout a platform or a hardened role sets (Supabase sets one per
-- role; db/migrate.ts sets none) would cancel it part-way and roll the file
-- back after the wasted work. Lifted for THIS transaction only — the
-- migrator's, or the implicit one a multi-statement apply runs in — as 023
-- scopes its own lock_timeout; the session keeps its setting.
SELECT set_config('statement_timeout', '0', true);

-- The index swap (the header's What), one table at a time. The shipped name
-- already holding a VALID HNSW index of exactly this shape means nothing to
-- do — a re-run, or --reapply. Holding an INVALID one (a by-hand CREATE INDEX
-- CONCURRENTLY under the shipped name, interrupted) means the planner ignores
-- it and every walk is a sequential scan, so it is dropped below and rebuilt;
-- holding a valid index of ANOTHER shape that names the operator class (an
-- IVFFlat over halfvec from pgvector's docs, an HNSW with other options) is
-- refused by name — nothing is guessed about what an operator built — where
-- a vector index, 001's and 007's, is what this file exists to replace.
-- Otherwise the staging index is built, or ADOPTED when a valid one of exactly
-- this shape was built by hand beforehand (CREATE INDEX CONCURRENTLY under the
-- staging name, the path for a brain whose build would hold writers too long —
-- the header); a valid index of another shape under the staging name is
-- refused the same way, and an INVALID one — the state an interrupted
-- concurrent build leaves — is dropped and rebuilt. Then the vector index
-- under the shipped name goes and the staging index takes the name.
-- to_regclass, not a catalog join by name: an index dropped by hand resolves
-- to NULL and is simply built.
DO $swap$
DECLARE
  v_rel   text;
  v_idx   text;
  v_new   text;
  v_def   text;
  v_valid boolean;
  v_shape constant text := 'USING hnsw \(\(\(embedding\)::(\w+\.)?halfvec\({{EMBEDDING_DIM}}\)\) (\w+\.)?halfvec_cosine_ops\)$';
BEGIN
  FOR v_rel, v_idx IN
    SELECT * FROM (VALUES ('thoughts', 'thoughts_embedding_idx'), ('thought_chunks', 'thought_chunks_embedding_idx')) AS t(rel, idx)
  LOOP
    v_new := v_rel || '_embedding_halfvec_idx';
    SELECT pg_get_indexdef(i.indexrelid), i.indisvalid INTO v_def, v_valid
      FROM pg_index i WHERE i.indexrelid = to_regclass(v_idx);
    IF v_valid AND v_def ~ v_shape THEN
      CONTINUE;
    ELSIF v_valid AND v_def LIKE '%halfvec%' THEN
      RAISE EXCEPTION 'migration 039: % exists but is not an HNSW index over (embedding::halfvec({{EMBEDDING_DIM}})) with halfvec_cosine_ops — %. Build % as the header says (CONCURRENTLY, so the walk keeps this index meanwhile), then drop this one and re-run: the staging index is adopted under the name.', v_idx, v_def, v_new
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT pg_get_indexdef(i.indexrelid), i.indisvalid INTO v_def, v_valid
      FROM pg_index i WHERE i.indexrelid = to_regclass(v_new);
    IF v_valid IS FALSE THEN
      EXECUTE format('DROP INDEX %I', v_new);
      v_valid := NULL;
    ELSIF v_valid AND v_def !~ v_shape THEN
      RAISE EXCEPTION 'migration 039: % exists but is not an HNSW index over (embedding::halfvec({{EMBEDDING_DIM}})) with halfvec_cosine_ops — %. Drop it, or build it as the header says, and re-run.', v_new, v_def
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF v_valid IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON %I USING hnsw ((embedding::halfvec({{EMBEDDING_DIM}})) halfvec_cosine_ops)', v_new, v_rel);
    END IF;
    EXECUTE format('DROP INDEX IF EXISTS %I', v_idx);
    EXECUTE format('ALTER INDEX %I RENAME TO %I', v_new, v_idx);
  END LOOP;
END
$swap$;

-- The 4-argument form's privileges, read before the DROP below so the CREATE
-- can be given the same ones — 020's capture, carried because this file is now
-- the last definer and is applied alone over a hand-re-applied 014 or 019 (see
-- the header). Empty when the 6-argument form already exists (the ordinary
-- case: CREATE OR REPLACE keeps its ACL and the replay does nothing).
SELECT set_config('ob1.acl_match_thoughts',
                  CASE WHEN to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float)') IS NOT NULL THEN ''
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb)')), '') END,
                  false);

-- The 4-argument form goes first, as in 020: beside the 6-argument one it makes
-- every 4-argument call ambiguous; IF EXISTS keeps this file re-runnable.
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int, jsonb);

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding  vector({{EMBEDDING_DIM}}),
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
  -- The blend (020). 0 is today's ranking, by similarity alone; 1 ranks the
  -- candidates by age alone. Defaulted, so every caller before 020 is
  -- unchanged — and the 4-argument function is DROPPED above, because beside
  -- this one it would make their calls ambiguous (see the header).
  recency_weight   float   DEFAULT 0.0,
  half_life_days   float   DEFAULT 90.0
)
RETURNS TABLE (
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  float,       -- the raw cosine, what the threshold gates — unchanged by the blend
  created_at  timestamptz,
  score       float        -- what the rows are ordered by: similarity when the weight is 0
)
LANGUAGE plpgsql
-- STABLE, as 012's search_thoughts_keyword is: the body only reads, so the
-- planner may treat it as such and PostgREST runs its POST RPC — the form every
-- caller in the repo uses — in a READ ONLY transaction.
STABLE
-- The planner's row estimate for a call (SMD-1041). It cannot see into plpgsql
-- and assumes 1,000 rows from any set-returning function without this clause;
-- the function returns match_count rows, 10 by default. It lives HERE and not
-- in an ALTER FUNCTION because CREATE OR REPLACE resets it — see 019's header.
ROWS 10
-- Scoped to this call and restored on exit. Requires pgvector >= 0.8.0, and the
-- CREATE fails on anything older rather than producing a function that quietly
-- stops at the first ef_search candidates. The walk's two BOUNDS are
-- deliberately not here: a function-level SET would override the database-level
-- values 014 seeded, which are the operator's tuning knob.
SET hnsw.iterative_scan = relaxed_order
-- The plan (SMD-969). At the shipped width a vector is TOASTed, and the
-- planner's seq-scan estimate counts heap pages and never the detoast reads —
-- so wherever the heap is small (every brain up to some tens of thousands of
-- thoughts, and the ceiling at every size) it chose a sequential scan of the
-- chunk table and, above the default count, of `thoughts`, reading five to
-- twenty times the buffers the index reads. A penalty, not a prohibition: a
-- relation with no usable index still seq-scans, and every statement in this
-- body has one — see 019's header for the measurement and for what was not chosen.
SET enable_seqscan = off
AS $$
DECLARE
  -- Clamped here, as 012 clamps its p_limit: the cost of a call is now
  -- proportional to match_count (the iterative scan honours v_fetch), and the
  -- callers who send a filter are direct SQL and PostgREST — outside the zod
  -- clamp the two servers apply. Three edges change from 007, deliberately:
  -- 0 returns 1 row (was 0), a negative count returns 1 row (was an error),
  -- NULL returns 10 (was LIMIT NULL, the whole candidate set). The ceiling,
  -- {{MATCH_COUNT_CEILING}}, is the largest count any caller in the repo sends
  -- (enhanced-mcp, 500 under a date filter) — an earlier draft's 100 cut two
  -- integrations' post-filter headroom short with no signal (tenth review
  -- pass) — and it is measured: db/bench-hnsw.ts section A times asked-500.
  -- A count above it is cut to it and a NOTICE says so, for the callers whose
  -- driver surfaces notices; the others get the ceiling's rows, which is more
  -- than 007 ever returned.
  v_count      int     := LEAST(GREATEST(COALESCE(match_count, 10), 1), {{MATCH_COUNT_CEILING}});
  -- The blend's two inputs (020). The weight is clamped to [0, 1] as
  -- match_count is clamped, with a NOTICE below; NULL is 0, the ranking every
  -- caller before 020 got. The half-life is checked below: a non-positive one
  -- has no meaning and is refused rather than replaced.
  v_weight     float   := LEAST(GREATEST(COALESCE(recency_weight, 0.0), 0.0), 1.0);
  v_half       float   := COALESCE(half_life_days, 90.0);
  -- The candidate window. Under a weight it widens fourfold: the blend can
  -- only reorder the candidates the scan produced, and a recent row just
  -- outside the nearest 4 * count can be the right answer once age counts.
  -- The header prices the factor and says how it was measured. v_base is the
  -- unweighted window, which v_exact below is sized from: the exact/walk
  -- boundary does not move with the weight (second review pass).
  v_base       int     := GREATEST(v_count * 4, 20);
  v_fetch      int     := v_base * CASE WHEN v_weight > 0 THEN 4 ELSE 1 END;
  -- Filters matching at most this many thoughts are answered EXACTLY, from the
  -- matching rows and their chunks, with no index walk at all (see the
  -- filtered branches below). v_fetch * 4 for the counts where the walk would
  -- have to find nearly every matching row anyway; 1,000 as a floor because a
  -- thousand parents and their chunks are a few thousand distance
  -- computations — milliseconds at any width — and no walk is cheaper.
  v_exact      int     := GREATEST(v_base * 4, 1000);
  -- The matching thoughts' ids, at most v_exact + 1 of them — collected once,
  -- through the GIN index, and used both to ROUTE (more than v_exact means the
  -- walk) and to DRIVE the exact branch by primary key. One pass over the
  -- filter: an earlier draft counted first and re-evaluated `metadata @>
  -- filter` to build the matched set, two GIN scans and two rounds of heap
  -- fetches per call, under two snapshots (eleventh review pass).
  v_ids        uuid[];
  -- The gate on that collection (037; the sample's statement is 038's). The
  -- heap's size in pages, exact and cheap (pg_relation_size is a stat of the
  -- main fork; to_regclass resolves the name on every call, so a cached plan
  -- never holds a dropped table's OID — the header says what a temp table
  -- shadowing the name does): the range the sample draws its block numbers
  -- from. Computed at entry — a few microseconds, on the unfiltered path too
  -- — so the estimate statement below stands alone with its locals
  -- substituted, which is how db/bench-hnsw.ts section C reads it out of the
  -- catalog.
  v_pages      bigint  := GREATEST(pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int, 1);
  v_hits       int;
  v_hit_pages  int;
  v_pages_seen int;
  -- True when the sample says the filter is far too broad for the exact
  -- branch: then the collection is skipped and the walk runs at once.
  v_broad      boolean := false;
BEGIN
  IF match_count > {{MATCH_COUNT_CEILING}} THEN
    RAISE NOTICE 'match_thoughts: match_count % clamped to {{MATCH_COUNT_CEILING}}', match_count;
  END IF;
  IF recency_weight < 0.0 OR recency_weight > 1.0 THEN
    RAISE NOTICE 'match_thoughts: recency_weight % clamped to %', recency_weight, v_weight;
  END IF;
  IF v_half <= 0.0 THEN
    RAISE EXCEPTION 'match_thoughts: half_life_days must be positive, got %', half_life_days
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- ob1:filter-inside-scan — a CONTRACT SENTINEL, not prose. It lives in the
  -- BODY (pg_proc.prosrc), which every CREATE OR REPLACE rewrites, so it says
  -- something about the function actually installed. (An earlier draft put a
  -- marker in COMMENT ON FUNCTION; pg_description is keyed on the OID that a
  -- replace preserves, so a successor that omitted its own COMMENT inherited
  -- the claim.) A later migration that redefines match_thoughts and keeps the
  -- filter inside the candidate scan carries this line; one that reintroduces
  -- a post-LIMIT filter must not. preflight reads it, and on the SQL store
  -- also probes the NULL-filter behaviour beside it; db/test-schema.ts [8b]
  -- asserts it.
  --
  -- Three branches, not one query with `v_unfiltered OR metadata @> filter`.
  -- Earlier drafts kept a single text and paid for it: the OR against a
  -- parameter hid the GIN index from the generic plan, which then needed
  -- `plan_cache_mode = force_custom_plan` on the function, which needed a
  -- LEFT JOIN whose removal depended on the OR folding to true, which needed
  -- a paragraph of invariants for the next author. With the predicate a plain
  -- `metadata @> filter` the planner has the GIN index whichever plan mode
  -- plpgsql picks, and none of that is load-bearing.
  --
  -- The filtered case then splits on how many thoughts match. Their ids are
  -- collected through the GIN index, at most v_exact + 1 of them: GIN builds
  -- its whole bitmap for the filter before the first row comes back, so what
  -- the LIMIT caps is the heap fetches (and the recheck each one carries), not
  -- the bitmap — db/bench-hnsw.ts section C explains this statement on the
  -- broadest and the empty filter for that reason. Since 037 that collection
  -- is gated: on a heap of {{ROUTE_ESTIMATE_MIN_PAGES}} pages or more, a
  -- sample of {{ROUTE_SAMPLE_PAGES}} pages is read first (since 038 by TID
  -- range, {{ROUTE_SAMPLE_PAGES}} page reads whatever the heap holds), and
  -- when it shows the filter matching far more than v_exact thoughts the
  -- collection is not run at all — the walk is the answer for such a filter,
  -- and the bitmap it would have built costs the number of matching rows
  -- (037's header has the rule and this file's the statement). At most v_exact matching:
  -- score those rows and their chunks directly by id — exact, no index walk,
  -- and a filter matching NOTHING (the shape one integration sends on every
  -- call) costs that one GIN probe and returns empty, where the walk-only
  -- draft ran to the scan bound and returned the same empty answer at 60+ ms
  -- (tenth review pass). More than v_exact matching: the HNSW walk with the
  -- predicate inside the scan, which has at least v_exact rows to find its
  -- v_fetch among, so it visits about v_fetch * N / v_exact tuples — N / 25
  -- at the default count — and the database-level bounds are its ceiling on
  -- tables past ~2.5 million rows. db/test-schema.ts [8b]/[8c] hold all three
  -- branches to the exact answer on the same rows; [8e] and db/test-live.ts
  -- [5d] hold the gate.
  IF filter IS NULL OR filter = '{}'::jsonb THEN
    -- Unfiltered. A NULL filter is unfiltered: 007 evaluated
    -- `NULL = '{}' OR metadata @> NULL`, which excluded every row.
    -- 039: the walk orders by the half-precision cast, on BOTH sides of the
    -- operator — token for token the expression thoughts_embedding_idx and
    -- thought_chunks_embedding_idx are built over since this file, or the
    -- planner has no index path and the scan below is a sequential one under
    -- enable_seqscan = off (a penalty, not a prohibition) — and scores the
    -- candidates on the full vector, so the similarity, the threshold and the
    -- merge with the chunk side mean what they meant. The broad-filter walk
    -- below does the same; the exact branch reads no index and casts nothing.
    RETURN QUERY
    WITH direct AS (
      SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
      FROM thoughts t
      WHERE t.embedding IS NOT NULL
      ORDER BY t.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
      LIMIT v_fetch
    ),
    chunked AS (
      SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
      FROM thought_chunks c
      ORDER BY c.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
      LIMIT v_fetch
    ),
    best AS (
      SELECT u.tid, MAX(u.sim) AS sim
      FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
      GROUP BY u.tid
    )
    SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
           -- The blend (020), over the candidates above: recency_score() is the
           -- one copy of the formula, inlined by the planner. Ordered by position
           -- (a bare `score` here would be the OUT parameter), then by id so the
           -- order is total when rows share a created_at.
           recency_score(b.sim, t.created_at, v_weight, v_half)
    FROM best b
    JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > match_threshold
    ORDER BY 6 DESC, t.id
    LIMIT v_count;
  ELSE
    -- The gate (037), sampling by TID range (038). On a heap large enough for
    -- the collection below to cost more than a sample of it, draw
    -- {{ROUTE_SAMPLE_PAGES}} block numbers and read each block as one TID
    -- range — `ctid >= '(b,0)' AND ctid < '(b+1,0)'`, a TID Range Scan, one
    -- page read per block whatever the heap holds — and count the rows that
    -- pass the filter and carry a vector, the pages those rows sit on, and
    -- the pages drawn. A row with a vector, not the collection's "vector or
    -- chunks": an EXISTS probe here became a hashed subplan over the whole
    -- chunk table, and counting fewer scoreable rows than there are only
    -- biases the gate towards running the collection, the safe side. The
    -- draw is DISTINCT (a block drawn twice is read and counted once), the
    -- join is LEFT (a page with no live row counts among the pages drawn),
    -- and the probe's LIMIT never cuts a page — it keeps the probe a
    -- subquery, which is what gives it a TID Range path, and caps the
    -- planner's estimate under jit_above_cost. The header has the
    -- measurements behind each, the planner paths the statement depends on
    -- (SMD-1624), and why sampling by page needs the third condition below.
    IF v_pages >= {{ROUTE_ESTIMATE_MIN_PAGES}} THEN
      SELECT count(*) FILTER (WHERE p.hit), count(DISTINCT b.blk) FILTER (WHERE p.hit), count(DISTINCT b.blk)
        INTO v_hits, v_hit_pages, v_pages_seen
      FROM (
        SELECT DISTINCT floor(random() * v_pages)::bigint AS blk
        FROM generate_series(1, {{ROUTE_SAMPLE_PAGES}})
      ) b
      LEFT JOIN LATERAL (
        SELECT (t.metadata @> filter AND t.embedding IS NOT NULL) AS hit
        FROM thoughts t
        WHERE t.ctid >= ('(' || b.blk || ',0)')::tid
          AND t.ctid <  ('(' || b.blk + 1 || ',0)')::tid
        LIMIT 291
      ) p ON true;
      -- Skip the collection only when all three hold: the sample, scaled to
      -- the table (hits x pages / pages drawn), puts the filter at ten times
      -- the exact threshold or more; at least eight sampled rows passed, so
      -- one or two lucky rows on a huge table cannot decide; and they sit on
      -- at least three different pages, so one page of clustered matches
      -- cannot either. Anything less runs the collection, as before 037: a
      -- filter the gate lets through costs what it always cost, a filter it
      -- wrongly skipped would go to the walk, which is correct but slower
      -- for a thin filter and, at a million rows, can return short — so the
      -- rule is built to make the second mistake rare (037's header has the
      -- arithmetic and the one layout it is weakest against; this file's
      -- has the rates re-measured for the TID-range draw).
      v_broad := v_hits >= 8
                 AND v_hit_pages >= 3
                 AND v_hits * v_pages >= 10 * v_exact * v_pages_seen;
    END IF;

    -- Only rows a branch can SCORE count towards the threshold: a thought
    -- captured through the 2-arg fallback has no vector and, until re-embedded,
    -- no chunks, so it can never be a candidate on either side. Counting those
    -- (the eleventh draft did) could route a filter with 1,200 matches of which
    -- 30 are scoreable to the walk, which then needs 40 passing rows that do not
    -- exist, runs to the scan bound and returns short — where the exact branch
    -- scores all 30 (twelfth review pass; db/test-schema.ts [8d] pins it).
    -- 014's statement, verbatim (db/test-schema.ts [20] compares it), run
    -- only when the gate above did not already decide.
    IF NOT v_broad THEN
      SELECT array_agg(s.id) INTO v_ids
      FROM (
        SELECT t.id FROM thoughts t
        WHERE t.metadata @> filter
          AND (t.embedding IS NOT NULL OR EXISTS (SELECT 1 FROM thought_chunks k WHERE k.thought_id = t.id))
        LIMIT v_exact + 1
      ) s;
    END IF;

    IF NOT v_broad AND COALESCE(cardinality(v_ids), 0) <= v_exact THEN
      -- Thin filter: the exact answer over the matching rows, driven by the ids
      -- already collected — primary-key probes for the thoughts, and
      -- thought_chunks_thought_id_idx probes for their chunks, both with the
      -- array. With the set capped at v_exact, index probes are the right plan
      -- by construction, and the array form is the one the planner cannot turn
      -- into a scan of the whole table: written as a join (or a LATERAL, which
      -- it pulls back up into one) its default 1% estimate for `@>` chose a
      -- sequential scan of the chunk table plus a hash instead — measured at
      -- 100,000 rows, 6–11 ms for a filter matching 6–998 thoughts, a cost that
      -- grew with the table and not with the match. No ORDER BY over an index
      -- and no LIMIT inside the CTEs: nothing here can walk.
      RETURN QUERY
      WITH direct AS (
        SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
        FROM thoughts t
        WHERE t.id = ANY (v_ids)
          AND t.embedding IS NOT NULL
      ),
      chunked AS (
        SELECT k.thought_id AS tid, 1 - (k.embedding <=> query_embedding) AS sim
        FROM thought_chunks k
        WHERE k.thought_id = ANY (v_ids)
      ),
      best AS (
        SELECT u.tid, MAX(u.sim) AS sim
        FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
        GROUP BY u.tid
      )
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             -- The blend (020), over the candidates above: recency_score() is the
             -- one copy of the formula, inlined by the planner. Ordered by position
             -- (a bare `score` here would be the OUT parameter), then by id so the
             -- order is total when rows share a created_at.
             recency_score(b.sim, t.created_at, v_weight, v_half)
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > match_threshold
      ORDER BY 6 DESC, t.id
      LIMIT v_count;
    ELSE
      -- Broad filter: the walk. The predicate sits INSIDE each candidate CTE,
      -- so the scan applies it to every candidate it produces and keeps going
      -- until v_fetch pass — the iterative scan declared above is what lets it
      -- keep going. The chunk side joins its parent row for the metadata; a
      -- join rather than EXISTS because inside an OR (an earlier shape) EXISTS
      -- became a hashed subplan — one full pass over thoughts per call — and a
      -- join is one primary-key lookup per candidate.
      RETURN QUERY
      WITH direct AS (
        SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
        FROM thoughts t
        WHERE t.embedding IS NOT NULL
          AND t.metadata @> filter
        ORDER BY t.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
        LIMIT v_fetch
      ),
      chunked AS (
        SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
        FROM thought_chunks c
        JOIN thoughts p ON p.id = c.thought_id
        WHERE p.metadata @> filter
        ORDER BY c.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
        LIMIT v_fetch
      ),
      best AS (
        SELECT u.tid, MAX(u.sim) AS sim
        FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
        GROUP BY u.tid
      )
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             -- The blend (020), over the candidates above: recency_score() is the
             -- one copy of the formula, inlined by the planner. Ordered by position
             -- (a bare `score` here would be the OUT parameter), then by id so the
             -- order is total when rows share a created_at.
             recency_score(b.sim, t.created_at, v_weight, v_half)
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > match_threshold
      ORDER BY 6 DESC, t.id
      LIMIT v_count;
    END IF;
  END IF;
END;
$$;

-- Replay the old function's privileges onto the new one (see the header). The
-- setting is empty when the new form already existed before this run (a
-- re-run: CREATE OR REPLACE kept its ACL and there is nothing to replay), when
-- there was no old function, or when the old ACL was NULL — the defaults — and
-- then nothing is done. Otherwise: revoke from EVERY grantee the CREATE gave
-- the new function (PUBLIC, and whatever ALTER DEFAULT PRIVILEGES added — on
-- Supabase anon, authenticated, service_role), then grant exactly what the
-- old ACL held, grant option included.
DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_match_thoughts', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;
