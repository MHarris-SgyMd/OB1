-- ============================================================================
-- 041 — match_thoughts pins the two planner paths its statements are built
--        around: `enable_nestloop = on`, so an operator's `enable_nestloop =
--        off` no longer turns every join in the call into a merge or hash
--        join over the whole table, and `enable_tidscan = on`, so on
--        PostgreSQL 18 `enable_tidscan = off` no longer turns the gate's
--        eight one-page probes into eight scans of the heap
--        (SMD-1677, SMD-1703)
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 014's, 019's and 040's SET
--   clauses, so this file declares the same floor; db/migrate.ts reads the
--   line)
--
-- If filtered search is slow with this file installed
--   This file adds no statement and reads nothing: it is 040's function with
--   two more SET clauses, `enable_nestloop = on` and `enable_tidscan = on`,
--   scoped to the call. A `Merge Join` or `Hash Join` under any statement of
--   the body in auto_explain (log_nested_statements; an EXPLAIN of the call
--   shows only the Function Scan) — the parent lookup that closes each branch
--   as a Merge Join over an Index Scan of the whole primary key, the walk's
--   chunk side as a Sort over a Hash Join of every chunk row — means the
--   first clause is gone: a later redefinition without it, since CREATE OR
--   REPLACE resets every SET clause, and preflight's `candidate scan` check
--   says so with the ALTER FUNCTION that puts both back until `bun
--   db/migrate.ts --reapply` does. A `Seq Scan on thoughts` under the gate's
--   probe with `Disabled: true` on it (PostgreSQL 18) means the second is
--   gone, the same way. Since this file the only cost past 1e10 a reader of
--   auto_explain can see on 14–17 is the sample's DISTINCT draw under
--   `enable_hashagg` and `enable_sort` both off — the one disabled path this
--   file does not pin, because the plan under it is the same plan (Design).
--   A `Seq Scan on thoughts` under the collection or the walk means
--   row-level security on the table (SMD-1625, unchanged here); a body
--   carrying TABLESAMPLE means 037 was pasted over 038 and everything since
--   (038's first screen); a walk ordered by the raw column over the
--   half-precision indexes means 038 was pasted over 039 and everything since
--   (preflight's `walk index` check, 039's). Failure modes below has each.
--
-- Why
--   Every join in this body is a primary-key probe driven by an outer the
--   statement itself bounds. The unfiltered walk and the broad-filter walk
--   close with `FROM best b JOIN thoughts t ON t.id = b.tid` over at most
--   2 x v_fetch candidates; the exact branch closes the same way over at most
--   v_exact rows; the broad walk's chunk side joins each HNSW-ordered chunk
--   candidate to its parent (`JOIN thoughts p ON p.id = c.thought_id`) to
--   test the filter, stopping at v_fetch; the gate's sample joins eight block
--   numbers to eight one-page TID range probes. A nested loop with an index
--   probe on the inner side is the plan for each by construction: the outer
--   is a few dozen to a few thousand rows whatever the table holds. The
--   nested-loop disaster that `SET enable_nestloop = off` exists to tame — a
--   misestimated outer of millions of rows, each probing the inner — cannot
--   happen here, and the setting is one operators reach for at database
--   level (`ALTER DATABASE … SET enable_nestloop = off`) to stop such a plan
--   elsewhere, which then reaches every call to this function.
--
--   What the planner did under it, read out of the installed body with
--   db/test-support.ts's extractBody and EXPLAIN (ANALYZE, BUFFERS)ed under
--   the function's own settings (enable_seqscan off, jit off; custom plan,
--   warm) on 100,000 rows at 64 dimensions (4,767 heap pages, 50,000 chunk
--   rows), PostgreSQL 16:
--
--     statement            default              enable_nestloop = off
--     unfiltered            1.10 ms /   3,436 buffers   41.6 ms / 101,458
--     walk (50% filter)     2.01 ms /   4,631           82.3 ms / 156,453
--     exact (900 rows)      2.38 ms /   8,213           39.6 ms / 104,924
--
--   In every statement the closing Nested Loop became a Merge Join whose
--   inner side is `Index Scan using thoughts_pkey on thoughts` over the whole
--   table (97,800 to 99,813 rows read, 31–36 ms of each call), the side that
--   pays; in the walk the chunk side's Nested Loop became, in addition, a
--   Sort over a Hash Join of every chunk row (`thought_chunks_thought_id_idx`,
--   50,000 rows) against a Bitmap Heap Scan of every filtered parent (50,000
--   rows, 46 ms) — an exact top-v_fetch over all chunks in place of the
--   HNSW's, so the walk's ANSWER changed, not only its time. The UNFILTERED
--   branch is hit too: SMD-1624's table, which filed this, had only the
--   filtered tiers.
--
--   Through the function on the same corpus — median of calls 6–20 / 1–5 on
--   one fresh connection per cell, rows compared across arms:
--
--     tier         default        enable_nestloop = off    off, this file
--     unfiltered    2.39 /  4.14     34.8 /  36.7             3.32 / 3.38
--     50%           6.19 /  6.26     97.5 /  78.0  (≠ rows)   6.78 / 7.34
--     1%            4.73 /  5.36     35.4 /  42.6             5.92 / 6.34
--     5,000 rows   25.1  / 23.5      49.0 /  61.5            23.8  / 27.7
--     900 rows      2.33 /  3.10     40.1 /  37.1             2.40 / 3.11
--     nothing       0.34 /  0.40      0.38 / 0.50             0.34 / 0.42
--
--   And at a million rows (49,999 heap pages, 400,000 chunk rows; the corpus
--   db/bench-hnsw.ts builds, kept under OB1_PG_KEEP=nl1m and measured in one
--   run, arm by arm, on 040's function with the two pins applied as an ALTER
--   for the pinned arms), PostgreSQL 16, twenty seeded queries per tier:
--
--     tier         A default        B nestloop off        C off, pinned    D tidscan off   F default, pinned   A′ default again
--     unfiltered    6.12 / 10.4     1,330 / 1,348          6.85 / 10.1      5.93 /  8.68    6.94 /  9.95        6.59 /  9.16
--     50%          10.6  / 10.8     2,154 / 1,868 (≠)     10.9  / 11.5      9.85 / 10.4    11.0  / 12.8        11.6  / 11.9
--     10%          32.4  / 29.7     1,757 / 1,662 (≠)     36.5  / 34.2     33.0  / 32.7    38.6  / 36.9        39.7  / 37.8
--     1%           31.8  / 35.1     1,813 / 1,784         35.0  / 35.5     34.6  / 33.5    34.5  / 47.0        36.5  / 33.7
--     5,000 rows   18.9  / 19.6     1,732 / 1,687         20.4  / 21.8     22.8  / 21.8    20.5  / 21.4        21.4  / 22.7
--     2,000 rows    9.47 / 12.3     1,830 / 2,143         11.9  / 12.9     10.8  / 13.1    11.1  / 12.2        12.0  / 12.6
--     0.1%          7.67 /  7.52    1,820 / 1,847          7.50 /  8.63     7.62 /  8.02    8.08 /  8.06        8.92 /  9.51
--     900 rows      5.59 /  6.90    1,649 / 1,647          5.27 /  6.78     6.68 /  6.27    6.25 /  8.31        7.07 /  7.80
--     0.01%         1.13 /  1.53    1,524 / 1,534          1.09 /  1.51     1.17 /  1.76    1.10 /  1.23        1.26 /  1.84
--     nothing       0.43 /  0.58        0.44 / 0.68        0.41 /  0.55     0.43 /  0.58    0.40 /  0.52        0.44 /  0.51
--
--   Every arm but B returned arm A's rows in every tier; B's 50% and 10%
--   tiers did not (the hash-join walk's answer). The `nothing` tier is the
--   one an operator's setting never reached: its exact branch has an empty
--   candidate set and a hash join with an empty build side reads no probe
--   side. Column F against A and A′ is what the pins cost where the paths
--   were already on: nothing outside the run's own spread.
--
--   The second pin is SMD-1703's. The gate's probe (038) reads one page by
--   `ctid >= '(b,0)' AND ctid < '(b+1,0)'`, which has exactly one path, a
--   TID Range Scan. On 14–17 `enable_tidscan = off` leaves that path in
--   place at disable_cost (the compile that priced, 040 removed). On
--   PostgreSQL 18 tidpath.c does not build the path at all when the setting
--   is off, so the probe's only plan is a sequential scan of the heap with
--   the ctid range as a filter — `Disabled: true`, taken anyway — once per
--   block drawn. Measured on 18.6 with the same 100,000-row corpus, the
--   sample statement read out of the body, the floor lowered so the gate
--   runs:
--
--     session                probe node         buffers        exec
--     default                Tid Range Scan          8          0.35 ms
--     enable_tidscan = off   Seq Scan, Disabled   38,136        74.7 ms    (8 x 4,767 pages)
--     off, this file         Tid Range Scan          8          0.25 ms
--
--   and through the function on 18 under `enable_tidscan = off` every
--   filtered tier cost 78–83 ms against 0.7–4.8 by default, the empty-match
--   filter included (78 ms: the sample runs before the collection); with the
--   pin every tier read the default's time and rows. At scale that is eight
--   reads of the whole heap on every filtered call, the cost the gate was
--   built to skip. On 16 the setting changes nothing but the cost figure
--   (column D above), and the pin nothing at all.
--
-- What
--   040's CREATE OR REPLACE with two clauses added between 040's `SET jit =
--   off` and `AS $$`:
--
--     SET enable_nestloop = on
--     SET enable_tidscan = on
--
--   A function-level SET beats a session, role or database setting for the
--   duration of the call and is restored on exit, exactly as 014's, 019's
--   and 040's clauses are. The body is 040's — 039's — byte for byte
--   (db/test-upgrade.ts [19] compares prosrc across the upgrade;
--   db/test-schema.ts [20] re-applies 039 and 040 alone and compares too),
--   and with it 039's half-precision cast in the walk's ORDER BY, 038's gate,
--   014's sentinel, the two template constants, 019's two clauses and ROWS
--   10, 040's `jit = off`, 020's DROP of the 4-argument form with its ACL
--   capture and replay — this file is the last definer of the FUNCTION,
--   which preflight's remedy and the suites' restoreShipped apply alone.
--   039's index swap is not here, for 040's reason.
--
-- Design — why two pins, and not the alternatives the tickets listed
--   * Why pinning is right here where 040 declined it. 040 was about a
--     COMPILE: JIT fired on a cost figure, and one clause on the executor
--     removed it in every case — a disabled path, a generic plan's flat
--     estimate, row-level security — where pinning paths would have covered
--     one case each and overridden the operator for nothing. This file is
--     about a PLAN: under the setting the planner chooses a different, worse
--     plan, and only a pin or a statement shape that admits no other plan
--     can give the right one back. The argument is 019's for `enable_seqscan
--     = off`: the body's statements are built around one path each — an
--     index for the candidate scan (019), a primary-key probe for every join
--     and a TID range for the sample (this file) — and a planner setting made
--     for tables that are not shaped like that does not tune this call, it
--     defeats it. 019's "no other SET" was written about the walk's bounds
--     (database-level, the operator's knob) and a plan mode (what the benches
--     show both sides of); 040 took the exception for `jit` and this file
--     takes it for two planner paths, on the same reading. Both tickets asked
--     the policy question once (SMD-1677 decides it, SMD-1703 follows): the
--     function pins the paths its statements rely on, and any pins ship in
--     one migration, one preflight check and one clause count.
--   * Not a statement shape. A LATERAL subquery that cannot be pulled up —
--     `CROSS JOIN LATERAL (SELECT … FROM thoughts t WHERE t.id = b.tid LIMIT
--     1) t`, the sample's own trick; a bare LATERAL is pulled back up into
--     the join, as the exact branch's comment records — admits only a nested
--     loop, and measured under `enable_nestloop = off` it held the default's
--     plan, buffers and time in all three branches (1.46 / 1.37 / 2.43 ms at
--     100,000 rows). It is the same decision — the function chooses its join
--     method — written into four statements instead of one clause: it
--     changes the shipped statement texts test-schema [20] compares, swaps
--     the plan aliases the bench attributes nodes by, carries disable_cost in
--     the estimate (1e10 per join, 2e10 in the walk; harmless since 040, but
--     a reader of auto_explain sees it), and rests on a planner-internals
--     rule (a subquery with LIMIT is not flattened) where a SET clause rests
--     on a documented one. And it has no answer for the TID range probe,
--     whose path on 18 is not costed away but never built.
--   * Not stated only. 040's header stated it (Failure modes) and filed the
--     ticket. Two seconds on every call to a brain whose operator turned
--     nested loops off, with nothing in preflight, the ledger or the rows to
--     show why, is the class of failure the fork's checks exist for.
--   * Not `enable_hashagg` or `enable_sort` pinned. With both off the sample's
--     DISTINCT draw and every ORDER BY in the body carry disable_cost, and the
--     planner takes them anyway: there is no other plan, so the plan is the
--     same plan and the rows are the same rows — 040 removed the compile that
--     figure used to trigger, and nothing else about the call changes (040's
--     table). Pinning them would override the operator for no measured gain.
--     Under those two settings a reader of auto_explain still sees a cost
--     past 1e10 on 14–17 and `Disabled: true` on 18; the first screen says so.
--   * Not every planner GUC. `enable_indexscan = off` or `enable_bitmapscan
--     = off` would defeat every index in the body — 019's clause, the GIN
--     collection, the HNSW walk — and `enable_hashjoin` with `enable_mergejoin`
--     off leaves only the nested loops this file wants. No measured case, no
--     operator reason to set them database-wide, and a function that pins
--     every planner setting is a plan_cache_mode by another name: the wrong
--     altitude. The two pinned here are the two an operator's setting was
--     measured defeating.
--   * The operator's escape is 040's: `ALTER FUNCTION match_thoughts(vector,
--     float, int, jsonb, float, float) RESET enable_nestloop` (or
--     `enable_tidscan`) takes a pin off for a brain whose operator wants the
--     session's setting inside the call too, and preflight then warns until
--     the migrator re-applies this file.
--
-- Failure modes
--   * A clause dropped by a later redefinition — or by 040's, 039's, 038's
--     or 037's file re-applied by hand: their CREATEs carry their own SET
--     clauses and not this file's. preflight's `candidate scan` reads both
--     pins beside 019's clause and 040's, warns with what each lets back in,
--     and names this file as the remedy while the ledger does not record it
--     and the ALTER FUNCTION once it does; `bun db/migrate.ts --reapply`
--     applies this file last. db/test-schema.ts [20] and [21] pin exactly five
--     clauses on the shipped body; db/test-live.ts [5e] and [5f] run the
--     mutants (each pin RESET) and watch the plan change.
--   * `enable_hashagg` and `enable_sort` both off. Not pinned (Design): the
--     sample's plan is the same plan at disable_cost on 14–17 (`Disabled:
--     true` on 18), no compile since 040, the same eight buffers. A reader of
--     auto_explain sees the cost figure and nothing else.
--   * Row-level security on the table. `jsonb_contains` is not leakproof, so
--     the collection and the walk's direct CTE are sequential scans of the
--     heap under a policy, and no clause on the function reaches that —
--     SMD-1625, unchanged here.
--   * PostgreSQL 13. The probe has no TID Range path there whatever the
--     setting (038's Prerequisites); the pin is accepted and changes nothing.
--   * An operator who set `enable_nestloop = off` FOR this function — because
--     a nested loop inside it misbehaved on their data. No measured case: the
--     outers here are bounded by the statements. Should one appear, RESET the
--     pin (Design) and file it with the plan.
--
-- Cost
--   Two more proconfig entries: GUCs set at call entry and restored at exit,
--   microseconds, what 014, 019 and 040 pay. Under default session settings
--   the pins change nothing — the paths are on already — and the million-row
--   table under Why holds the pinned function (F) against the unpinned one
--   before and after it (A, A′): every tier within the run's spread, every
--   tier the same rows. The bench's before/after for this file is
--   OB1_BENCH_UPTO=040 against the default; measured as the build run of the
--   kept corpus against a reuse with this file applied onto it, section B
--   agreed in every row and recall column and its medians sat within the
--   run's spread (FORK.md change 92 has both rows of figures and the one
--   confounded run that is not cited). Where the setting IS off the pinned call costs the
--   default's time in place of 1.3–2.2 s at a million rows (C against A).
--   At ten million rows (the SMD-1018 corpus brought to this file by hand;
--   ten queries per tier, median of calls 4–10, PostgreSQL 16), through the
--   function:
--
--     tier         default    enable_nestloop = off    off, this file (warm)
--     unfiltered     7.6 ms       18,075 ms                 12.0 ms
--     50%           11.4         28,726 (≠ rows)            13.4
--     5,000 rows    54.4         19,884                     52.8
--     900 rows      11.0         16,779                     10.7
--     nothing        0.5              0.4                     0.6
--
--   Seventeen to thirty-four seconds a call without the pin — the merge
--   join's inner side is an index scan over ten million primary-key
--   entries, the walk's hash join builds over four million chunk rows.
--   FORK.md change 92 has the full run, including the cold-cache column the
--   whole-table arm left behind.
--
-- What a successor must carry
--   040's list — the `-- requires: pgvector >= 0.8.0` header line, `SET
--   hnsw.iterative_scan = relaxed_order`, `SET enable_seqscan = off`, `SET
--   jit = off`, `ROWS 10`, the `-- ob1:filter-inside-scan` sentinel in the
--   BODY, the 6-argument signature with 020's DROP and ACL replay, 039's
--   half-precision cast on both sides of each walk ORDER BY, 038's gate with
--   its two template constants — and now `SET enable_nestloop = on` and `SET
--   enable_tidscan = on`. db/test-schema.ts [20]/[21] count five clauses;
--   preflight's `candidate scan` names whichever is missing.
--
-- Prerequisites
--   Migration 040 (this file re-creates its function and carries its clause).
--   PostgreSQL 14 or later, as 038; the tidscan pin does something only on
--   18, the nestloop pin on every version. Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `match_thoughts` returns what 040's returned for every call under default
--   session settings, in the same time; under a session, role or database
--   `enable_nestloop = off` every tier returns the same rows in the same time
--   as by default (the million-row table, C against A) where before it cost
--   1.3–2.2 s and the walk's rows changed; on PostgreSQL 18 under
--   `enable_tidscan = off` the gate's probe is a TID Range Scan reading eight
--   buffers, and the call costs what it costs by default. pg_proc.proconfig
--   carries `enable_nestloop=on` and `enable_tidscan=on` beside 014's, 019's
--   and 040's clauses; preflight's `candidate scan` reports all five.
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
-- The two planner paths this body is built around, pinned for the call (this
-- file, SMD-1677 and SMD-1703). Every join here is a primary-key probe driven
-- by an outer the statement itself bounds — 2 x v_fetch candidates, at most
-- v_exact ids, the sample's eight blocks — so a nested loop is the plan by
-- construction, and the misestimated outer that `enable_nestloop = off`
-- exists to tame cannot occur inside this call; under that setting the
-- planner had replaced every join with a merge or hash join over the WHOLE
-- table, 1.3–2.2 s a call at a million rows, the unfiltered call included,
-- and the walk's rows changed. The sample's probe has exactly one path, a
-- TID Range Scan; on PostgreSQL 18 `enable_tidscan = off` removes it and
-- each probe scanned the whole heap. 019's argument for enable_seqscan = off
-- applied to two more paths — the header has the tables, why not a statement
-- shape, and what is deliberately NOT pinned (hashagg, sort, the rest).
SET enable_nestloop = on
SET enable_tidscan = on
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
