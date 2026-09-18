-- ============================================================================
-- 040 — match_thoughts runs with `jit = off`: a planner path an operator
--        disables no longer JIT-compiles the gate's sample on every call,
--        and a generic plan's flat estimate no longer compiles the walk
--        (SMD-1624)
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 014's and 019's SET clauses, so
--   this file declares the same floor; db/migrate.ts reads the line)
--
-- If filtered search is slow with this file installed
--   This file adds no statement and reads nothing: it is 039's function with
--   one more SET clause, `jit = off`, scoped to the call. A `JIT:` block
--   under ANY statement of the body in auto_explain (log_nested_statements;
--   an EXPLAIN of the call shows only the Function Scan) means the clause is
--   gone — a later redefinition without it, since CREATE OR REPLACE resets
--   every SET clause — and preflight's `candidate scan` check says so with
--   the ALTER FUNCTION that puts it back until `bun db/migrate.ts --reapply`
--   does. A cost past 1e10 on the sample or the walk WITHOUT a JIT block is
--   a planner path disabled at some level (enable_tidscan, enable_nestloop,
--   enable_hashagg with enable_sort) on PostgreSQL 14–17: the plan is the
--   same, the eight page reads are the same, and since this file the cost
--   figure is all there is to it. On 18 the node reads `Disabled: true` at
--   an ordinary cost instead — and under `enable_tidscan = off` the probe
--   has no TID Range path at all there and is a sequential scan of the heap
--   per block (SMD-1703). A `Seq Scan on thoughts` under the collection or
--   the walk means row-level security on the table (SMD-1625, unchanged
--   here); a body carrying TABLESAMPLE means 037 was pasted over 038, 039
--   and this file (038's first screen); a walk ordered by the raw column
--   over the half-precision indexes means 038 was pasted over 039 and this
--   file (preflight's `walk index` check, 039's). On Supabase, whose images
--   are built without LLVM JIT and whose upgrades set `jit = off`, nothing
--   here compiles today whatever the clause says; the clause is for a
--   self-hosted or future server, and for the generic plan wherever JIT is
--   on. Failure modes below has each.
--
-- Why
--   038's sample statement has, in every piece, exactly one viable planner
--   path: a TID Range Scan for the block (019's enable_seqscan = off is on
--   the function), a Nested Loop for the LATERAL join (nothing else takes a
--   lateral reference), Sort/Unique or HashAggregate for the DISTINCT draw.
--   When a session, role or database turns that path off — `SET
--   enable_tidscan = off`, `enable_nestloop = off`, or `enable_hashagg` and
--   `enable_sort` both off; `ALTER DATABASE … SET enable_nestloop = off` is
--   a spelling operators use to tame a nested-loop disaster elsewhere — the
--   planner still chooses the path and adds disable_cost, 1e10, to it. The
--   statement's estimated cost is then far past jit_above_cost (100,000)
--   and past the inlining and optimisation thresholds (500,000), so the
--   executor JIT-compiles the sample, with inlining and optimisation, on
--   EVERY execution. The plan node, the rows, the eight buffers, preflight
--   and the ledger are unchanged; the time is the compiler's. 038's header
--   measured it and stated the premise; SMD-1624 asked for the decision.
--
--   Measured again for this file, through the function on 25,000 rows at
--   1,024 dimensions (385 heap pages — the vectors are TOASTed; HNSW index
--   dropped, so the 50% column is a GIN bitmap and a sort, the fixture's
--   cost and not the function's), the floor lowered to 0 so the sample runs,
--   medians of nine calls after three warm ones, round trip included, an
--   empty-match filter / a filter matching half the rows. The function
--   measured was 038's: main took 039 (the half-precision index, which
--   changes the walk's ORDER BY and nothing in the sample) while this file
--   was in review, and the statement the compile is about is the same in
--   038, 039 and this file:
--
--     setting (session)                 038's function     038's + `jit = off`
--     default                            0.99 /  59 ms       1.30 /  66 ms
--     enable_tidscan = off              51.3  / 108          1.28 /  62
--     enable_nestloop = off             59.0  / 108          1.07 /  66
--     enable_hashagg + enable_sort off 105    / 270          0.99 /  65
--     enable_tidscan off, session jit off 1.04 / 66          1.11 /  60
--
--   The sample statement alone under enable_tidscan = off: total cost
--   80,000,000,070 (eight times disable_cost), 52 ms with the JIT block —
--   Inlining 7.4, Optimization 23.4, Emission 20.9 — and 0.18 ms without.
--   The hashagg-and-sort case costs more than the other two because every
--   ORDER BY in the body carries disable_cost with sort disabled: the walk's
--   statements were compiled too (270 against 108 on the 50% filter), and
--   the tidscan and nestloop sensitivities are 038's while the sort one is
--   037's (its `count(DISTINCT …)` sorted). Session-level `jit = off` (last
--   row) removes it, which is what the function-level clause does for every
--   caller.
--
--   The second thing the clause buys was measured before this ticket. At
--   ten million rows plpgsql's GENERIC plans — adopted after five calls when
--   not costlier — carried 30–110 ms their custom twins did not: the
--   routing count on the empty filter 31 ms against 0.03, the exact branch
--   108 against 24, the 2,000-row walk 136 against 20; with `jit = off` those
--   were 0.03, 11 and 23 (FORK.md change 28, "At scale"; db/bench-hnsw.ts
--   section C's third column since then). The generic plan's flat estimate
--   carries the statements past jit_above_cost between a million rows and
--   ten million, and every call then compiles — the way 017 found
--   search_thoughts_hybrid doing (15 ms where its arms cost 1.3) and put
--   `SET jit = off` on that function for it. The one generic plan whose cost
--   is not JIT, the 50% walk's GIN bitmap over five million rows sorted by
--   distance (11.6 s against 15 ms custom; 11.7 with jit off), this file
--   does not touch: that is the plan mode, SMD-1464.
--
-- What
--   039's CREATE OR REPLACE with one clause added between 019's
--   `SET enable_seqscan = off` and `AS $$`:
--
--     SET jit = off
--
--   017's clause, for 017's reason: nothing in this body has enough rows for
--   JIT to pay for itself — the walk passes a few hundred tuples under the
--   seeded bounds, the exact branch scores at most v_exact rows, the
--   collection stops at v_exact + 1, the sample reads eight pages — and what
--   prices its statements past the threshold is never the work, it is
--   disable_cost or a flat estimate. The body is 039's byte for byte
--   (db/test-upgrade.ts [18] compares prosrc; db/test-schema.ts [20]
--   re-applies 039 alone and compares too), and with it 039's half-precision
--   cast in the walk's ORDER BY, 014's sentinel, the two template constants,
--   019's two clauses and ROWS 10, 020's DROP of the 4-argument form with its
--   ACL capture and replay — this file is the last definer of the FUNCTION,
--   which preflight's remedy and the suites' restoreShipped apply alone.
--   039's index swap is not here: it is a one-time move of two indexes, not
--   part of the function, and 039's own header lists what a successor
--   carries (the cast) and what it does not (the swap). preflight's `walk
--   index` check still names 039 for an index out of step with the body;
--   after a hand re-apply of 039 the `candidate scan` check names this file
--   for the clause 039's CREATE resets.
--
-- Design — why this and not the alternatives SMD-1624 listed
--   * Not the paths pinned. `SET enable_tidscan = on` would be harmless (no
--     other statement in the body has a TID path) and cover one case;
--     `enable_nestloop = on` covers a second and overrides an operator's
--     setting for the walk's chunk join too; the third needs `enable_sort =
--     on` as well, which overrides it for every ORDER BY in the body — and
--     none of the three touches the generic plan's JIT at ten million rows,
--     the compile under row-level security (SMD-1625), or PostgreSQL 13's
--     (038's Prerequisites). One clause removes the compile in every case
--     and overrides nothing about which plan the operator's settings choose
--     — including the one the ticket asked to be measured: what the walk
--     does under `enable_nestloop = off` is under Failure modes, and its
--     decision is SMD-1677.
--   * Not a higher jit_above_cost on the function. disable_cost is 1e10 per
--     disabled node; no finite threshold is safely above it, and "off" says
--     what is meant.
--   * Not left stated. 038 stated the premise; a database-level
--     `enable_nestloop = off` gives every fresh connection 41–67 ms a call
--     with nothing in preflight, the ledger or the rows to show it.
--   * Not a plan mode. 038's sample adopts the generic plan by design (both
--     modes price it alike); the walk's plan mode is SMD-1464's question,
--     and 019's rule stands — a plan mode is what the benches exist to show
--     both sides of. 019's "no other SET" was written about the walk's
--     bounds (database-level, the operator's knob) and a plan mode; `jit`
--     is neither, and 017 and 027 have carried it since.
--   * Where JIT might have paid, checked: a statement that evaluates
--     expressions over many rows. The collection's cost is inside GIN (no
--     expression per row); the walk's sort over a bitmap at ten million
--     rows was measured with and without (11.6 s / 11.7 s). db/bench-hnsw.ts
--     section C keeps a "generic, jit on" arm so the claim stays checkable
--     at every scale the bench runs.
--
-- Failure modes
--   * The clause dropped by a later redefinition — or by 039's file
--     re-applied by hand for its index swap, whose CREATE carries 019's
--     clauses and not this one. CREATE OR REPLACE resets
--     proconfig, exactly as it resets 014's and 019's clauses, and the
--     ledger cannot see it. preflight's `candidate scan` check (019's) reads
--     `jit = off` beside `enable_seqscan = off` and ROWS 10, names this
--     file while the ledger does not record it and prints the ALTER
--     FUNCTION for whichever clause is missing once it does (a plain run
--     skips a recorded file); db/test-schema.ts [20] pins
--     the three clauses on the shipped body and fails on a successor that
--     drops one.
--   * A disabled planner path, still (14–17). The plan under `enable_tidscan
--     = off` is the same TID Range Scan at cost 8e10, under `enable_nestloop
--     = off` the same Nested Loop at 1e10: disable_cost is a planner
--     penalty, not a prohibition, and with the compile gone nothing else in
--     the call changes (the table under Why). A reader of auto_explain sees
--     the cost and no JIT block.
--   * What the clause does not fix. Under row-level security the collection
--     and the walk's direct CTE are sequential scans of the heap (SMD-1625:
--     jsonb_contains is not leakproof, so `@>` cannot be an index qual); the
--     compile goes, the scan stays. On PostgreSQL 13 the probe has no TID
--     Range path and is a sequential scan per block; the same. A trivially
--     true policy (`USING (true)`) is folded by the planner and triggers
--     neither — the row-level case was not reproduced by that fixture here.
--   * PostgreSQL 18. It replaced the disable_cost penalty with a count of
--     disabled nodes kept beside the cost (`Disabled: true` in EXPLAIN), so
--     a disabled path no longer carries the sample past jit_above_cost and
--     the compile under Why cannot be triggered that way there — measured
--     on 18.6: nothing is compiled under any of the three, with the clause
--     or without it (db/test-live.ts [5e] asserts the absence on 18). Under
--     `enable_nestloop = off` and hashagg-with-sort the probe keeps its TID
--     Range Scan (cost 36 on the fixture). Under `enable_tidscan = off` 18
--     does not build the TID Range path at all — tidpath.c returns before
--     it, where 14–17 built the path and priced it — and each probe is a
--     sequential scan of the heap with the ctid range as a filter (cost
--     1,490 on a 3,000-row fixture; eight full scans of the heap per
--     filtered call at scale): 13's state (038's Prerequisites), the cost
--     the gate exists to avoid, and no clause on the function reaches it
--     (SMD-1703). The clause
--     stands on 18 for the generic plan's flat estimate, the compile under
--     row-level security and 13's, none of which 18 changed.
--   * A server built without JIT, or with its own `jit` off. Supabase — the
--     fork's stated target since 038's Prerequisites — builds its 15 and 17
--     images without LLVM JIT (`pg_jit_available()` is false) and its
--     upgrade scripts set `jit = off`; PGlite has no JIT either. There the
--     clause is accepted and does nothing today, and preflight's warning for
--     a missing clause says so in a parenthesis; db/test-live.ts [5e] runs
--     its forced-on plan and its timing only where the server has JIT and
--     its own `jit` is on, and asserts the clause on the catalog everywhere.
--   * An operator's `enable_nestloop = off`, for the rest of the call. This
--     file removes the sample's compile under it (the empty filter at a
--     million rows: 66.8 ms a call under 038's function, 0.6 under this
--     one); it does not give the walk or the exact branch their nested
--     loops back — every filtered tier with rows costs 2–3 s at a million
--     rows under that setting, the same under 038 and this file, identical
--     rows (the table is in FORK.md change 81). Pinning `enable_nestloop =
--     on` on the function would, and would override the operator's setting
--     for the whole call: SMD-1677, not here.
--   * An operator who wants JIT inside match_thoughts. A function-level SET
--     beats a session or database setting for the call. No measured case
--     wants it; `ALTER FUNCTION … RESET jit` is the escape, and preflight
--     then warns until the migrator re-applies this file.
--
-- Cost
--   One more proconfig entry: a GUC set at call entry and restored at exit,
--   microseconds, the same 017 and 027 pay. The default column under Why is
--   within the run's spread (0.99–1.30 ms across the six cells that ran
--   without JIT under either function). Over the floor, the sample's eight
--   page reads are 038's, unchanged.
--
--   At a million rows (db/bench-hnsw.ts's corpus: 64 dimensions, 49,999
--   heap pages, kept under OB1_PG_KEEP so every arm read ONE corpus with
--   one set of statistics; 038's function, before 039 landed), the function
--   with this clause, with it RESET — 038's function — and with it again,
--   twenty seeded queries per tier on a
--   fresh connection each, medians of calls 6–20 / 1–5: identical rows on
--   every tier in every arm, the times within the run's spread — 50% 13 /
--   17 / 14 ms, 10% 66 / 64 / 53, 1% 55 / 43 / 44, 5,000 rows 34 / 26 / 25,
--   900 rows 12 / 9 / 11, the empty filter 1.3 / 0.7 / 0.8 — and the first
--   five calls (custom plans) costing what the rest cost (generic where
--   adopted) under both functions: at a million rows no generic plan of
--   this body is priced past jit_above_cost yet (FORK.md change 28 put that
--   between a million and ten million), so the clause has nothing to remove
--   there and costs nothing. Two separately loaded containers (the bench's
--   before and after arms) had disagreed on the 5,000-row and 1% tiers —
--   the walk statement's plan was the HNSW walk under 038 (546 and 424 ms,
--   8.8 and 8.9 of 10) and a GIN bitmap with a sort under this file (61 and
--   86 ms, 10 of 10) — which is the edge FORK.md change 28 documented for
--   exactly those two tiers ("between about half a percent and one percent
--   of the table, the walk branch is on the planner's edge, and which side
--   it lands on is decided by the statistics sample": 332 and 283 ms in two
--   of its passes, 23 and 38 in the third), between two corpora's sampled
--   statistics and not this clause; the one-corpus run above is the
--   attribution. The ten-million arm was not re-run for this file (the
--   machine was shared); db/bench-hnsw.ts section C's third column is where
--   the claim is read.
--
-- What a successor must carry
--   039's list, unchanged — `SET hnsw.iterative_scan = relaxed_order`, `SET
--   enable_seqscan = off`, `ROWS 10`, the `ob1:filter-inside-scan` sentinel,
--   the pgvector floor line, 020's DROP with the ACL capture and replay, the
--   two template constants, the estimate as ONE statement over locals
--   declared at entry, the walk's `embedding::halfvec(D) <=>
--   query_embedding::halfvec(D)` on both tables (the expression 039's
--   indexes are built over; test-schema [38] holds the pair) — and `SET jit
--   = off`, which db/test-schema.ts [20] pins and preflight reads. A
--   successor that removes it should say in its
--   header which statement it measured gaining from JIT, and expect the
--   table under Why to come back.
--
-- Prerequisites
--   Migration 039 (the function this file redefines: 038's gate and sample,
--   the half-precision walk, 020's signature). PostgreSQL 14 or later as 038
--   requires; the `jit`
--   GUC exists on every supported build, with or without JIT compiled in.
--   The disabled-path trigger under Why is 14–17's (Failure modes has 18).
--   Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `match_thoughts` returns what 039's returned for every call — the body
--   is 039's — and no statement of its body is JIT-compiled whatever the
--   session, role or database sets: under each of the three disabled paths
--   the call costs what it costs by default (the table under Why, right
--   column); at a million rows every tier returns the rows it returned
--   without the clause in the same time (Cost); at ten million, where
--   FORK.md change
--   28 measured the generic plans paying 30–110 ms of JIT, db/bench-hnsw.ts
--   section C's generic column should read what its "jit off" column read
--   then (not re-run for this file; the third column is now the compile
--   the clause removes). pg_proc.proconfig carries `jit=off` beside 014's
--   and 019's clauses; preflight's `candidate scan` reports all three.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below: the SET
-- clause names an hnsw.* setting, which a non-superuser owner is refused for
-- until the library is loaded (014's header has the reproduction).
SELECT '[1]'::vector;

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
-- JIT off for the call (this file, SMD-1624; 017's clause, for 017's reason).
-- Nothing in this body has enough rows for JIT to pay for itself — the walk
-- passes a few hundred tuples, the exact branch scores at most v_exact rows,
-- the sample reads eight pages — and what prices its statements past
-- jit_above_cost is never the work: a planner path an operator disabled adds
-- disable_cost (1e10) on PostgreSQL 14–17 and the sample was compiled on
-- every call, ~50 ms; a generic plan's flat estimate at ten million rows
-- compiled the route, exact and walk statements for 30–110 ms (FORK.md
-- change 28). The header has the table, and why this is not a plan mode and
-- not the enable_* paths pinned.
SET jit = off
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
