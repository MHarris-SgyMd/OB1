#!/usr/bin/env bun
/**
 * bench-hnsw.ts — what `match_thoughts` actually returns under a metadata
 * filter, measured against an exact scan of the same rows.
 *
 * SMD-968 (upstream NateBJones-Projects/OB1#417) says a filtered semantic
 * search silently loses recall: pgvector's HNSW scan hands over its first
 * `hnsw.ef_search` candidates (40 by default) and stops, and a filter applied
 * after that sees only those 40. This fork's function had the sharper form —
 * an explicit `LIMIT v_fetch` inside each candidate CTE, applied before the
 * filter — plus a second defect the same mechanism predicts: `v_fetch` above
 * 40 could never be honoured, so `match_count = 50` returned 40 rows.
 *
 * Both are claims about a scan, and the fork's rule is that a claim about a
 * plan is measured, not inferred (SMD-925 learned this the hard way: a
 * statistics counter read too early said "index not used" while the timing
 * column said otherwise). So this loads a synthetic corpus, asks the function
 * as shipped by migrations 001–013, applies 014 and every later migration on
 * top of the SAME rows, and asks again.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *
 *   L. The load itself, at every scale: rows per second into a table with
 *      every secondary index dropped and its user triggers disabled (the
 *      audit and entity-extraction triggers would otherwise write a row per
 *      row, and the schema under the load differs between the arms), the HNSW
 *      build time for each vector index once the rows are in, the other
 *      indexes' rebuild, and the table and index sizes. Only the INSERT
 *      round-trips are timed; the generator and the confound check run
 *      between them, untimed. 014's header argued the walk's bounds
 *      past 2.5 million rows from arithmetic; SMD-1018 asked for the numbers,
 *      and the build's cost and the index's size are the first two a brain
 *      that large would meet. A scale above the before arm's is KEPT when the
 *      database outlives the run (`OB1_PG_KEEP`, with-postgres.sh): the next
 *      pass finds the corpus, checks it and re-migrates it rather than
 *      rebuilding it, and the table says per scale which it did ("A kept
 *      corpus", below).
 *
 *   A. Unfiltered row count at match_count 10 / 20 / 50 / 100 — requested
 *      against returned — and the median latency at match_count 10, which is
 *      every first-party caller's path. The overfetch cap shows up as "asked
 *      50, got 40"; the latency column is what 014's extra join costs there.
 *      Beside them, the unfiltered top-10's overlap with the exact top-10 over
 *      the whole table: the index's own recall at the default `ef_search`, on
 *      this corpus, at this size. Every filtered number in section B sits on
 *      that floor — a 50% filter cannot score better than the index does with
 *      no filter at all — and at a million random rows the floor is low
 *      (SMD-1018 found it; random uniform vectors are HNSW's hardest case).
 *      The same call is repeated with `hnsw.ef_search` raised tenfold, so
 *      the floor can be told from the ceiling: what the index could recall
 *      here if it were asked to look harder, and at what cost.
 *
 *   B. Filtered overlap. For each selectivity (a `tier` key planted at 50%,
 *      10%, 1%, 0.1% and 0.01% of rows, and at a FIXED 900, 2,000 and 5,000
 *      rows whatever the scale) and Q random query vectors: how many rows came
 *      back of the 10 asked for, how many of those the EXACT top-10 within the
 *      filter also contains, and how often the result was empty. The oracle is
 *      the same scoring (MAX over a thought's own vector and its chunks) with
 *      the vector index kept out of the plan, so it is exact by construction
 *      and shares no code with the function under test. It is computed once
 *      per query and tier; both arms are scored against the same answer.
 *
 *      The fixed-count tiers exist for the scale question. 014 answers a
 *      filter matching at most 1,000 thoughts exactly and walks the index for
 *      anything broader; the walk visits about `v_fetch * N / matches` tuples
 *      and stops at the bounds 014 seeds (100,000 tuples; work_mem * 8). So
 *      900 rows is the exact branch at its widest, at every scale; 2,000 rows
 *      is the walk with the most to do — 20,000 tuples at a million rows,
 *      200,000 at ten million, past the seeded cap — and 5,000 rows is the
 *      walk that the seeded cap covers at ten million (80,000 tuples) but
 *      pgvector's default of 20,000 does not. Their shares shrink with the
 *      table, which is the point: the same filter, a growing brain. A fixed
 *      count is planted only where it is under half the table (5,000 rows at
 *      the default 10,000 says nothing the 50% tier does not), and where it
 *      lands on a share tier's exact share the two are one tier under both
 *      names; the run says which tiers it dropped or merged. (A row count is
 *      a nominal size — membership is a coin per row — so the table prints
 *      the count actually planted, and a tier goes to section D or E by that
 *      count against the threshold, not by its name: the 0.1% tier at a
 *      million rows plants about 1,000 and lands on either side.)
 *
 *      The thinnest tiers have fewer matching rows than the candidate budget,
 *      so a walk for them cannot stop early and must run until it exhausts the
 *      index or reaches the bounds. A filter matching NOTHING is measured too —
 *      a typo'd tag, an empty project — because that is the case where the
 *      scan does the most work to return the least.
 *
 *      The queries are RANDOM vectors, not perturbed copies of a target. A
 *      perturbed copy makes the target the global nearest neighbour, which no
 *      filter can lose — the first draft of this bench did exactly that and
 *      reported 50/50 recall for a function that returns nothing at 1%.
 *
 *   C. Plan shape. The live function body is read from the catalog
 *      (`pg_get_functiondef`), each filtered branch's statement is extracted
 *      with its plpgsql variables rewritten as parameters, and the result is
 *      PREPAREd and EXPLAINed under both a custom and a generic plan — plpgsql
 *      may use either, and 014 declares no plan mode. The walk branch is
 *      explained on the thinnest filter above the exact threshold — where the
 *      planner may prefer the GIN index to the vector index — and on the
 *      broadest, where it walks HNSW; the exact branch on the broadest filter
 *      under the threshold (the exact branch takes any
 *      filter matching at most 1,000 thoughts); the routing statement itself —
 *      the capped id collection every filtered call ran first until 037, and
 *      every call the gate lets through still does — on
 *      the 50% filter, where GIN builds its largest bitmap before the LIMIT
 *      can stop anything, on the thinnest filter with rows, and on the empty
 *      one; and the gate's estimate — the sample of the heap that runs before
 *      it on a large heap and decides whether it runs at all: 037's
 *      TABLESAMPLE count, eight TID range probes since 038 — on the same three,
 *      so the sample's cost stands beside the collection's it saves. That
 *      inspects the SQL actually deployed rather than a copy of it kept here,
 *      and it fails loudly if the function no longer has the shape the rewrite
 *      expects.
 *
 *   D. The walk, forced onto the thin and empty filters. The function itself
 *      answers those exactly and never walks for them; to show what the bounds
 *      it seeds do when the walk IS reached with nothing to find, this section
 *      runs the walk branch's statement directly — the text section C
 *      extracted — under a forced generic plan, on the filters where the walk
 *      has the most to do to return the least.
 *
 *   E. The walk THROUGH THE FUNCTION, on every tier it routes to the walk,
 *      under the bounds 014 seeds and again under pgvector's defaults (20,000
 *      tuples; work_mem * 1) — the two bounds are database-level settings the
 *      function does not override, so a session SET is what an operator's
 *      tuning would be — and once more with `hnsw.ef_search` raised tenfold
 *      under the seeded bounds, which tells a walk cut short by a bound from a
 *      walk that completed with the index's own recall. Beside each: what the
 *      exact branch would return and cost if the threshold were raised to
 *      route that tier to it, from the exact branch's own statement with its
 *      floor lifted. That is the table
 *      the decision in 014's header rests on — whether the seeded bounds or
 *      the threshold should follow the table's size — and it is measured
 *      through the deployed function, not through a statement extracted from
 *      it (SMD-1018).
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *
 *   ./with-postgres.sh bun bench-hnsw.ts             # 10,000 and 100,000 rows, 50 queries
 *   OB1_BENCH_SCALES=1000 OB1_BENCH_QUERIES=20 ./with-postgres.sh bun bench-hnsw.ts
 *   # a million rows and up: one scale per container, with the shared memory
 *   # the parallel build needs — the two commands are in db/README.md
 *   ./with-postgres.sh bun bench-hnsw.ts --plans     # print the full plans
 *   OB1_BENCH_UPTO=040 ./with-postgres.sh bun bench-hnsw.ts   # the after arm's schema stops at 040: the function before 041 (039, 038 and 037 for the ones before 040, 039 and 038)
 *
 *   # Keep the ten-million-row corpus between passes: the first run builds it
 *   # and records the exact pass's answers in its marker; every later run under
 *   # the same name finds it and skips the load, the builds and the exact pass.
 *   OB1_PG_KEEP=hnsw10m OB1_BENCH_SCALES=10000000 OB1_PG_SHM_SIZE=11g OB1_BENCH_MAINTENANCE_MEM=9GB ./with-postgres.sh bun bench-hnsw.ts
 *
 * Vectors are 64-wide random unit vectors: wide enough that HNSW behaves like
 * HNSW, narrow enough that a 100,000-row index builds in a minute and a
 * 10,000,000-row one in twenty; 100,000,000 rows are ~26 GB of vectors before
 * the index and want a machine sized for them (FORK.md change 28, "At scale",
 * names what was run where and what it needs). Nothing here reads any corpus,
 * so nothing sensitive is involved.
 *
 * ── What the scale runs found (SMD-1018) ─────────────────────────────────────
 *
 * 014's header sized the walk by arithmetic — `v_fetch × N / matches` tuples
 * against the seeded cap, "covers tables to ~2.5 million rows". Measured at a
 * million and ten million rows, that is not what binds: the planner serves
 * every filter up to about 1% of a ten-million-row table from the GIN index
 * (exact, whatever the bounds say) and walks HNSW only for broad filters,
 * where the walk needs a few hundred tuples and the recall it loses is the
 * index's own at the default ef_search (section A's control: 8.2 / 5.0 / 2.2
 * of 10 unfiltered at 10k / 100k / 1M random rows). The seeded bounds matter
 * in one band — moderately selective filters at around a million rows, where
 * the walk does walk and pgvector's default MEMORY bound cuts it short — and
 * there the exact branch would have been faster and exact (section E). The
 * routing count grows linearly with the matches, ~250 ms at 50% of ten
 * million rows. FORK.md change 28 has the tables and the three follow-ups
 * (SMD-1463 the routing count, SMD-1464 the threshold and plan mode, SMD-1465
 * the recall floor on real vectors); 014's own header is not edited, because
 * migrations are checksummed and append-only. Migration 037 (SMD-1463, FORK.md
 * change 70) then gated the routing count behind a sample of the heap; the
 * before/after tables there are this bench with and without OB1_BENCH_UPTO=036,
 * and section C prints the sample's cost beside the collection's. Migration
 * 038 (SMD-1526, change 80) draws that sample by TID range — eight page reads
 * whatever the heap holds, where 037's TABLESAMPLE cost ~2 ns a heap page —
 * and its before/after is OB1_BENCH_UPTO=037 against the default. Migration
 * 040 (SMD-1624, change 91) puts `jit = off` on the function — a planner path
 * an operator disabled had JIT-compiled the sample on every call, and a
 * generic plan's flat estimate the walk — and its before/after is
 * OB1_BENCH_UPTO=039 against the default; section C's third column is what
 * the clause saves the generic plan. Migration 041 (SMD-1677 and SMD-1703,
 * change 92) pins `enable_nestloop = on` and `enable_tidscan = on` on the
 * function — under an operator's `enable_nestloop = off` every join in the
 * call had become a merge or hash join over the whole table, and on
 * PostgreSQL 18 under `enable_tidscan = off` each of the gate's probes a scan
 * of the whole heap — and its before/after is OB1_BENCH_UPTO=040 against the
 * default, which under default session settings should agree in every column:
 * the pins change nothing where the paths are on.
 *
 * The before arm — the function as shipped by 001–013 — runs at the published
 * scales only (up to 100,000 rows). Its defect is established there; at a
 * million rows and up it would double the load to show 007 returning nothing
 * at 1% once more, and every question SMD-1018 asks is about the shipped
 * function. Above that the schema is applied whole before the load and the
 * after arm is the only arm.
 *
 * The rows are generated in two passes over one seeded stream — the first
 * only to reach the queries, which the stream yields after the rows (the
 * generator's step is additive, so the skip is one multiply), the second to
 * insert — so at 10,000 and 100,000 rows the vectors, the queries and the
 * share tiers' membership are exactly the published corpus's while nothing
 * holds N vectors in memory. Not byte for byte: each row's metadata now also
 * carries whichever fixed-count tiers it fell into, so the heap and the GIN
 * index are a little wider than the published run's. Bun's SQL driver has no
 * COPY protocol (a `COPY ... FROM STDIN` hangs), so the rows go in as
 * multi-row INSERTs into a table whose secondary indexes have been dropped
 * and whose user triggers are disabled for the load (so 008's audit table
 * stays empty, where the published run's held a row per thought); the indexes
 * are rebuilt after it, with `maintenance_work_mem` sized for the graph. That
 * is also how a brain that size would be bulk-loaded.
 */

import { SQL } from "bun";
import { BENCH_MARKER, applyFunctionSettings, applyMigrations, assertThrowawayDatabase, dropSchema, explainPrepared, extractBody, hasKeptCorpus, ledgerNames, ledgerStrangers, migratorEnv, preparedSignature, requireDatabaseUrl, resetSchema, routingAt, runMigrator, seededRandom } from "./test-support.ts";
import type { Branch } from "./test-support.ts";
import { digestOf, markerAnswers } from "./bench-oracle.ts";
import type { OracleAnswer, OracleCache } from "./bench-oracle.ts";
import { BOUNDS_IN_FORCE_SQL, DB_LEVEL_SETTINGS_SQL, HNSW_BOUNDS, HNSW_SEEDS, parseSetConfig } from "./config.mjs";

const URL_ = requireDatabaseUrl("bench-hnsw.ts");
const PRINT_PLANS = process.argv.includes("--plans");

const DIM = 64;
// No trigram index: nothing here reads content, and 011's GIN would otherwise
// be maintained for every row of the load (review pass).
const OPTS = { dim: DIM, model: "stub-embed", trgm: false };
/** The migrator's shell for the whole-schema arm — the same width, model and no trigram index, through migrate.ts so its ledger exists (see the kept corpus, below). */
const MIGRATOR_ENV = migratorEnv(URL_, OPTS);
// The defaults are the run every published table came from, so the documented
// command reproduces the documented numbers — with one caveat since 019: the
// after arm applies every migration from 014 on, so the function it times and
// explains carries `enable_seqscan = off` as well. The recall tables in 014's
// header and FORK.md change 28 were measured under 014 alone; at K = 10 the
// index was the plan either way, so they reproduce, while the asked-500
// latencies in section A and the chunk side of section C's plans (where the
// planner's own choice at 64 dimensions was a seq scan above 200 candidates)
// are now the deployed function's and may differ from the published lines.
// And since SMD-1493 both HNSW relations are read into the page cache before
// section A on both paths (pg_prewarm), where the published run's cache was
// whatever the build and the oracle had left.
const SCALES = [...new Set((process.env.OB1_BENCH_SCALES ?? "10000,100000").split(",").map((s) => Number(s.trim())))];
if (SCALES.some((n) => !Number.isInteger(n) || n <= 0)) {
  // Validated up front like Q: a fraction would pass every step until the
  // generator's skip refused it, after the schema had been rebuilt.
  console.error(`OB1_BENCH_SCALES must be positive integers (got ${JSON.stringify(process.env.OB1_BENCH_SCALES)})`);
  process.exit(2);
}
/** The before arm (001–013) runs up to this scale; see the header. A corpus is kept only above it. */
const BEFORE_ARM_MAX = 100_000;
// A kept database holds one corpus, and only a scale above the before arm's is
// kept, so under OB1_PG_KEEP a run is exactly one such scale — judged where the
// list is parsed, before anything is connected to or dropped (the container
// with-postgres.sh started for us stays; an empty kept volume is the worst a
// refused run leaves, and the exit line names it). The three rules this
// replaces (a marker of another scale, a small scale after a large one, a
// descending list that built the large corpus and then replaced it) were
// each a seam the review passes found; one invariant has none.
/** Whether the database outlives the run (with-postgres.sh's OB1_PG_KEEP): the marker is written only then. */
const KEPT = Boolean(process.env.OB1_PG_KEEP);
if (KEPT && !(SCALES.length === 1 && SCALES[0] > BEFORE_ARM_MAX)) {
  console.error(
    `bench-hnsw.ts: under OB1_PG_KEEP a run is one scale above ${BEFORE_ARM_MAX.toLocaleString()} rows (got OB1_BENCH_SCALES=${SCALES.join(",")}): a kept database holds one corpus, and scales up to ${BEFORE_ARM_MAX.toLocaleString()} are never kept. Run the small scales, or several scales, without OB1_PG_KEEP.`
  );
  process.exit(2);
}
/** Random queries per selectivity. Validated: a typo here would surface only after the load. */
const Q = Number(process.env.OB1_BENCH_QUERIES ?? 50);
if (!Number.isInteger(Q) || Q < 1) {
  console.error(`OB1_BENCH_QUERIES must be a positive integer (got ${JSON.stringify(process.env.OB1_BENCH_QUERIES)})`);
  process.exit(2);
}
/** Result size for the filtered arm. The server's default is 10. */
const K = 10;
/** Share of thoughts that also get chunk rows, so the chunk CTE is exercised. */
const CHUNKED_SHARE = 0.2;
const CHUNKS_PER = 2;
/** Rows per INSERT statement during the load. */
const BATCH = 2000;
/** The two vector indexes the load drops and rebuilds, timed each; section L reads them by these names. */
const HNSW_INDEXES = ["thoughts_embedding_idx", "thought_chunks_embedding_idx"] as const;
/**
 * `maintenance_work_mem` for the HNSW builds, or "auto": pgvector builds the
 * graph in memory while it fits and falls back to a far slower on-disk phase
 * when it does not (it says so with a NOTICE the server log carries at
 * log_min_messages = notice; the client driver does not surface notices).
 * A 64-dimensional element with its neighbour lists is under a kilobyte, so
 * "auto" sizes the graph at 1 KB a row, floored at 256 MB. Override to fit
 * the machine — the run's value is printed with the build time.
 */
const MAINTENANCE_MEM = process.env.OB1_BENCH_MAINTENANCE_MEM ?? "auto";
const BUILD_WORKERS = Number(process.env.OB1_BENCH_BUILD_WORKERS ?? 4);
/** Workers per exact-oracle scan: the build's count, and never below the image's own two (a serial build is still a parallel oracle). */
const ORACLE_WORKERS = Math.max(2, BUILD_WORKERS);
if (!Number.isInteger(BUILD_WORKERS) || BUILD_WORKERS < 0) {
  console.error(`OB1_BENCH_BUILD_WORKERS must be a non-negative integer (got ${JSON.stringify(process.env.OB1_BENCH_BUILD_WORKERS)})`);
  process.exit(2);
}
/**
 * The after arm's schema stops at this migration prefix ("035"), so one tree
 * can measure the function as it was before a later file and as it is: the
 * before/after a redefinition of match_thoughts is judged by (SMD-1463 was
 * the first). Unset, the whole set applies. The arm's label says which.
 */
const UPTO = process.env.OB1_BENCH_UPTO;
if (UPTO !== undefined && (!/^\d{3}$/.test(UPTO) || UPTO < "014")) {
  // 014 or later: the after arm reads the function's locals from the
  // catalog, and a body from before 014 has none to read (review pass 1).
  console.error(`OB1_BENCH_UPTO must be a three-digit migration prefix of 014 or later, such as 037 (got ${JSON.stringify(UPTO)})`);
  process.exit(2);
}
if (UPTO !== undefined && KEPT) {
  // A schema cut at a migration is not the tree's schema: the migrator applies
  // every file and its ledger would not describe the cut, so such a corpus is
  // never kept — nothing would vouch for it on the next run (SMD-1493).
  console.error(`bench-hnsw.ts: OB1_BENCH_UPTO and OB1_PG_KEEP do not combine — a corpus built under a schema cut at ${UPTO} is measured and dropped, never kept. Run the cut without OB1_PG_KEEP.`);
  process.exit(2);
}
/** Whether the after arm applies this migration file. */
const upTo = (f: string) => UPTO === undefined || f.slice(0, 3) <= UPTO;
const AFTER: Arm = UPTO === undefined ? "after (014 on)" : `after (014–${UPTO})`;

/**
 * Planted selectivities. `tiers` is one key so a filter is one containment
 * test — the shape a direct caller sends as `{"type": "decision"}`. (The
 * server's own `search_thoughts` sends no filter; the filter argument is
 * reached by direct SQL, PostgREST RPC callers and community code such as the
 * enhanced-mcp integration's `metadata_filter`.) Every tier is a threshold on
 * ONE uniform draw per row, so the tiers nest (a row in t001 is also in t01,
 * t1, t10, t50, and in whichever fixed-count tiers are broader) and every
 * selectivity is a superset of the next: the comparison is between filter
 * sizes only. `none` matches no row.
 *
 * A tier is either a SHARE of the table or a fixed ROW COUNT resolved to a
 * share at each scale (see the header on why 900 / 2,000 / 5,000). The share
 * tiers are the published ones and their membership is unchanged by the
 * additions: the draw is the same draw.
 */
type TierSpec = { key: string; share: number } | { key: string; rows: number };
const TIERS: TierSpec[] = [
  { key: "t50", share: 0.5 },
  { key: "t10", share: 0.1 },
  { key: "t1", share: 0.01 },
  { key: "t01", share: 0.001 },
  { key: "t001", share: 0.0001 },
  { key: "r5k", rows: 5000 },
  { key: "r2k", rows: 2000 },
  { key: "r900", rows: 900 },
  { key: "none", share: 0 },
];
type Tier = { key: string; share: number; label: string };

/**
 * The tiers at one scale, broadest first, with each fixed count turned into
 * its share of the table. A fixed count above half the table says nothing the
 * 50% tier does not, and a share tier planting less than one row is dropped —
 * `none` stays, since matching nothing is its job.
 */
function tiersAt(n: number): { tiers: Tier[]; notes: string[] } {
  const out: Tier[] = [];
  const notes: string[] = [];
  // Membership is one draw against the share, so two tiers with the same
  // share are the same rows under two names (5,000 rows at five million is
  // the 0.1% tier, 2,000 at 20,000 the 10% one); they are one tier, labelled
  // with both names, so nothing is measured twice and nothing vanishes.
  const aliases = new Map<string, string[]>();
  const push = (t: Tier) => {
    const twin = out.find((o) => o.share === t.share);
    if (twin) {
      aliases.set(twin.key, [...(aliases.get(twin.key) ?? []), t.label]);
      notes.push(`${t.label} is the ${twin.label} tier at this scale`);
    } else out.push(t);
  };
  for (const t of TIERS) {
    if ("rows" in t) {
      if (t.rows >= n / 2) {
        notes.push(`${t.rows.toLocaleString()} rows is at least half the table; not planted`);
        continue;
      }
      push({ key: t.key, share: t.rows / n, label: `${t.rows.toLocaleString()} rows` });
    } else if (t.share === 0) {
      push({ key: t.key, share: 0, label: "nothing" });
    } else if (n * t.share >= 1) {
      push({ key: t.key, share: t.share, label: `${t.share * 100}%` });
    } else {
      notes.push(`${t.share * 100}% of ${n.toLocaleString()} rows is under one row; not planted`);
    }
  }
  for (const t of out) if (aliases.has(t.key)) t.label = `${t.label} (also the ${aliases.get(t.key)!.join(" and the ")} tier)`;
  return { tiers: out.sort((a, b) => b.share - a.share), notes };
}

// ── Deterministic data ──────────────────────────────────────────────────────
//
// Re-seeded per scale, so the 100,000-row corpus is the same corpus whether or
// not 10,000 ran first. The generator is test-support's; the copy this file had
// cycled after ~10,000 draws and made most queries exact copies of stored rows,
// which is why the confound check below exists.
//
// One stream yields the rows and THEN the queries, as the first draft's
// in-memory generator did. Keeping that order keeps the published corpus, so
// the queries are reached by running the stream over the rows once without
// building them (a row is 1 + 2 * DIM draws: the tier coin, then two per
// Gaussian), and the rows are generated a second time, batch by batch, as they
// are inserted.

const lit = (v: number[]) => `[${v.join(",")}]`;

function seedFor(n: number) {
  return seededRandom(20260904 + n);
}

/** Draws per row in the stream: the tier coin, then two per Gaussian component. */
const DRAWS_PER_ROW = 1 + 2 * DIM;

/** The Q queries the stream yields after n rows, without materialising the rows. */
function queriesFor(n: number): number[][] {
  const { skip, unitVector } = seedFor(n);
  skip(n * DRAWS_PER_ROW);
  return Array.from({ length: Q }, () => unitVector(DIM));
}

// The skip must equal the draws a ROW costs, or the queries are not the
// published ones: checked once, before anything loads, by generating one row
// the way rowBatches does (the tier coin, then the vector) beside one skip of
// the budget queriesFor assumes — so a generator that starts caching its
// second Gaussian, or a row that gains a draw, fails here rather than
// landing the queries off the stream while every other check still passes.
{
  const a = seedFor(1);
  const b = seedFor(1);
  rowFrom(a, 0, []);
  b.skip(DRAWS_PER_ROW);
  if (a.rnd() !== b.rnd()) throw new Error("seededRandom.skip(DRAWS_PER_ROW) does not reproduce one rowFrom()'s draws; the queries and a kept corpus's regenerated rows would be off the stream");
}

type Row = { doc: number; v: number[]; tiers: string[] };
type Stream = ReturnType<typeof seedFor>;

/** The next row off the stream: DRAWS_PER_ROW draws, the tier coin first. The one recipe, whether rows are streamed for the load or one is regenerated to check a kept table. */
function rowFrom(stream: Stream, i: number, tiers: Tier[]): Row {
  const r = stream.rnd();
  const keys = tiers.filter((t) => r < t.share).map((t) => t.key);
  return { doc: i, v: stream.unitVector(DIM), tiers: keys };
}

/** The n rows, in insertion order, one batch at a time. */
function* rowBatches(n: number, tiers: Tier[]): Generator<Row[]> {
  const stream = seedFor(n);
  let batch: Row[] = [];
  for (let i = 0; i < n; i++) {
    batch.push(rowFrom(stream, i, tiers));
    if (batch.length === BATCH) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

/**
 * A query that IS a stored row is its own global nearest neighbour, which no
 * post-filter can lose — the confound this bench exists to avoid. Random unit
 * vectors in 64 dimensions sit near cosine 0 of each other; anything close to
 * 1 means the generator repeated itself. Refuse to publish numbers on that.
 * Accumulated row by row during the load, since the rows are not kept.
 */
class Confound {
  private readonly flat: Float64Array;
  max = -1;
  constructor(private readonly queries: number[][]) {
    this.flat = new Float64Array(queries.length * DIM);
    queries.forEach((q, i) => this.flat.set(q, i * DIM));
  }
  see(v: number[]): void {
    for (let qi = 0; qi < this.queries.length; qi++) {
      let dot = 0;
      const base = qi * DIM;
      for (let i = 0; i < DIM; i++) dot += this.flat[base + i] * v[i];
      if (dot > this.max) this.max = dot;
    }
  }
  /** The one threshold, for the build's accumulated maximum and the exact pass alike. */
  static check(max: number): number {
    if (max > 0.99) {
      throw new Error(`a query vector coincides with a stored row (cosine ${max.toFixed(4)}); the generator is not random enough to measure with`);
    }
    return max;
  }
}

type LoadStats = {
  scale: number;
  schema: string;
  confound: number;
  insertS: number;
  chunkRows: number;
  chunkS: number;
  buildS: Record<string, number>;
  /** The non-HNSW indexes rebuilt after the load, and their time together; the set differs by schema. */
  otherIndexes: string[];
  otherIndexesS: number;
  sizes: Record<string, number>;
  maintenanceMem: string;
  workers: number;
  /** When this build ran (ISO), and whether THIS run did it or reused it. */
  builtAt: string;
  source: "loaded" | "reused";
};

// ── A kept corpus ───────────────────────────────────────────────────────────
//
// A pass at ten million rows is about forty minutes, thirty of them the load
// and the index builds, and the corpus is deterministic: the same scale is the
// same rows. Under `OB1_PG_KEEP=<name> ./with-postgres.sh …` the database
// outlives the run, and this bench then finds the corpus it built last time
// and measures it instead of building it again (SMD-1493). What vouches for
// the rows is checked, not assumed:
//
//   - a marker row this bench writes once the load and every build have
//     finished — the scale, the parameters that shape the rows (width, tiers,
//     the chunked share), the tier match counts it counted as it generated,
//     and section L's numbers — so an interrupted load leaves nothing to reuse;
//   - the row counts of both tables against the marker's, and the first and
//     last rows of the corpus regenerated from the seed and compared with what
//     the table holds, so a generator change or a foreign table cannot pass as
//     the corpus;
//   - the migrator's ledger: above the before arm's scales the schema is
//     applied through migrate.ts, whose ledger records what ran, and a reuse
//     runs migrate.ts again — a migration added since the build is applied
//     onto the corpus (as onto a real brain that size); a file edited since is
//     caught by a `--dry-run` first and refused before the live run, since a
//     plain run reports drift but still applies what is pending around it;
//     and a name the ledger records that this tree has no file for is refused
//     here, since the runner would not notice it. A kept corpus is never
//     measured under a schema older than the tree's.
//
// And once the rows are vouched for, the exact pass — most of a reuse's
// minutes at ten million rows — is not paid again either: the marker keeps
// the pass's answers (`OracleCache`), a reuse takes the first Q of them and
// computes only what the marker lacks (SMD-1562).
//
// The published scales are not kept: the before arm needs 001–013 under the
// rows, a build that size is seconds, and a kept database holds ONE corpus —
// a run asking for another scale is refused rather than replacing thirty
// minutes of build without being asked (a corpus this run built itself is
// this run's to replace: a run over several scales keeps the last).
/** The marker table — test-support's name, which its schema reset and the reuse suite share; every statement below reads it from here (through `unsafe`, since a tagged template would bind it as a parameter, not an identifier). */
const MARKER = BENCH_MARKER;
/**
 * Bumped when the marker's MEANING changes — a new key in `matches`, a
 * physical field read differently — so a marker an earlier bench wrote is
 * refused up front with the remedies (as a parameter change is). A LoadStats
 * field added is caught by name (LOAD_STATS_KEYS), not by this number; 2 dates
 * from the merge that brought `otherIndexes` in, when both mechanisms were new.
 * The seed lives in `seedFor`; a change there is caught by the regenerated rows.
 * The oracle cache is not this number's either: it names its own inputs (a
 * digest of the oracle's statement and the server's kernel as the map's key,
 * a digest per query) and is computed afresh under a new key where they
 * differ.
 */
const MARKER_FORMAT = 2;
/** Every field section L reads, named once: a marker missing one is refused before the run, not a TypeError in the report after it. The compiler keeps this list whole when LoadStats grows. */
const LOAD_STATS_KEYS: Record<keyof LoadStats, true> = { scale: true, schema: true, confound: true, insertS: true, chunkRows: true, chunkS: true, buildS: true, otherIndexes: true, otherIndexesS: true, sizes: true, maintenanceMem: true, workers: true, builtAt: true, source: true };
type CorpusParams = { format: number; dim: number; tiers: { key: string; share: number }[]; chunkedShare: number; chunksPer: number };
// The exact pass's answers, kept in the marker (SMD-1562) — what an entry
// holds and what of it a run may trust — are bench-oracle.ts's (the pure
// part, which test-schema.ts drives); the map's key is `oracleShapeOn`'s.
/**
 * The marker's payload. The scale and build time live in `stats` (the one
 * copy the report reads); `physical` is the four relations' state at the
 * build and `builtXid` the transaction id then, so a reuse can count rows
 * written since — exact at any share, blind to a statistics reset; `oracle`
 * is the exact pass's answers by statement shape, so a reuse need not compute
 * them; `rewritten` holds the evidence of a change found on a reuse — a
 * corpus so marked is refused on every later run, not only the one that
 * found it (review passes).
 */
type Marker = { params: CorpusParams; matches: Record<string, number>; stats: LoadStats; physical: Physical; builtXid: number; oracle?: Record<string, OracleCache>; rewritten?: string[] };

/** A kept table that is not the corpus its marker describes — told apart from a dropped connection or a timeout, which are not the corpus's fault (review pass). */
class NotTheCorpus extends Error {}
/**
 * Per relation: rows inserted + updated + deleted so far (the cumulative
 * counters, which autovacuum does not reset but a crash recovery does), the
 * file the relation lives in (which DML never changes and a rewrite always
 * does), and the main fork's size in bytes (which DML over the rows grows and
 * nothing resets — the witness that survives a recovery; review pass).
 */
type Physical = Record<string, { tuples: number; file: number; bytes: number }>;
/** Growth of a relation's main fork past this share of the build's is a rewrite; a vacuum's or a truncate's jitter is far below it. */
const GROWTH_TOLERANCE = 0.1;
const PHYSICAL_RELATIONS: readonly string[] = ["thoughts", "thought_chunks", ...HNSW_INDEXES];
const mb = (b: number) => (b / 1048576).toFixed(0);

const corpusParams = (tiers: Tier[]): CorpusParams => ({ format: MARKER_FORMAT, dim: DIM, tiers: tiers.map((t) => ({ key: t.key, share: t.share })), chunkedShare: CHUNKED_SHARE, chunksPer: CHUNKS_PER });
/** A build time for a console line or a table cell: one spelling, from the ISO stamp `stats` carries. */
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

// The jsonb values below are bound as OBJECTS, in `unsafe`'s parameter array
// (the table's name is interpolated, so a tagged template is not available):
// a JSON string handed to a `$n::jsonb` parameter is JSON-encoded once more
// by the driver and lands as a jsonb *string*, which `@>` never matches and a
// reader has to parse twice. Comparisons of what comes back use
// Bun.deepEquals: jsonb hands an object back with its keys in its own order,
// so a text compare of a round trip is not a compare of the value.
async function readMarker(sql: SQL): Promise<Marker | null> {
  if (!(await hasKeptCorpus(sql))) return null;
  try {
    const [row] = await sql.unsafe(`SELECT corpus FROM ${MARKER}`);
    if (!row) throw new Error("the table exists but holds no row, so nothing vouches for what is under it");
    const corpus = row.corpus as Marker;
    const shaped = corpus && typeof corpus === "object" && corpus.params && corpus.stats && corpus.physical && corpus.stats.scale > BEFORE_ARM_MAX;
    if (!shaped) throw new Error("its row is not the shape this bench writes");
    const missing = Object.keys(LOAD_STATS_KEYS).filter((k) => !(k in corpus.stats));
    if (missing.length) throw new Error(`its stats lack ${missing.join(", ")}`);
    return corpus;
  } catch (err) {
    // The one kept-corpus refusal that would otherwise be a stack trace.
    console.error(`bench-hnsw.ts: the database has a ${MARKER} table this bench cannot read (${(err as Error).message}); a marker an earlier revision wrote, or another table of that name. Remove the kept volume (db/README.md names the command), or the table where the database is your own. Nothing was touched.`);
    process.exit(2);
  }
}

/** One transaction: a marker table with no row would read as "no corpus" and let a later run drop what it stands over. The columns are for a glance from psql; the payload is the record. */
async function writeMarker(sql: SQL, marker: Marker): Promise<void> {
  await sql.begin(async (tx: SQL) => {
    // `scale` is generated from the payload, so the two cannot disagree;
    // `built_at` cannot be (timestamptz input is not immutable) and is a
    // plain copy for a glance from psql. The payload's `stats.confound` is the
    // exact pass's value over the build's queries (the marker is written after
    // that pass); the load's client-side accumulator was the early abort.
    await tx.unsafe(`CREATE TABLE ${MARKER} (one boolean PRIMARY KEY DEFAULT true CHECK (one), scale bigint GENERATED ALWAYS AS ((corpus->'stats'->>'scale')::bigint) STORED, built_at timestamptz NOT NULL, corpus jsonb NOT NULL)`);
    await tx.unsafe(`INSERT INTO ${MARKER} (built_at, corpus) VALUES ($1::timestamptz, $2::jsonb)`, [marker.stats.builtAt, marker]);
  });
}

/** Fields of the marker's payload updated in place (`rewritten`, on a refusal). A top-level key is replaced whole. */
async function amendMarker(sql: SQL, patch: Partial<Marker>): Promise<void> {
  await sql.unsafe(`UPDATE ${MARKER} SET corpus = corpus || $1::jsonb`, [patch]);
}

/** This tree's entry in the marker's oracle map, written or replaced under its key; other keys' entries stay. A map that is not an object (a hand-cleared `null`) is started over — `||` on it would build an array, and the cache would be dead from then on (review pass). */
async function amendOracle(sql: SQL, shape: string, record: OracleCache): Promise<void> {
  await sql.unsafe(`UPDATE ${MARKER} SET corpus = corpus || jsonb_build_object('oracle', CASE WHEN jsonb_typeof(corpus->'oracle') = 'object' THEN corpus->'oracle' ELSE '{}'::jsonb END || $1::jsonb)`, [{ [shape]: record }]);
}

// `markerAnswers` (bench-oracle.ts) judges the entry; the ids it hands back
// are not re-checked against the table — the fingerprint the reuse has just
// passed says no row was written since they were read.

/** The physical state of the four relations the measurements depend on: the marker records the build's, a reuse compares. */
async function physicalState(sql: SQL): Promise<Physical> {
  const [{ counted }] = await sql`SELECT current_setting('track_counts') = 'on' AS counted`;
  if (!counted) console.log("  (track_counts is off on this server: the row counters are frozen, and only each relation's file and size can say what moved)");
  const rows = await sql.unsafe(`
    SELECT c.relname, c.relfilenode::bigint AS file, pg_relation_size(c.oid, 'main')::bigint AS bytes,
           COALESCE(s.n_tup_ins + s.n_tup_upd + s.n_tup_del, 0)::bigint AS tuples
    FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relname = ANY($1) AND c.relnamespace = 'public'::regnamespace`, [sql.array([...PHYSICAL_RELATIONS], "TEXT")]);
  return Object.fromEntries(rows.map((r: { relname: string; file: string | number; bytes: string | number; tuples: string | number }) => [r.relname, { tuples: Number(r.tuples), file: Number(r.file), bytes: Number(r.bytes) }]));
}

/**
 * What moved since a recorded state, in words, or nothing: another file, a
 * main fork grown past the tolerance, or rows the counters saw. A counter that
 * went DOWN is a statistics reset (a crash-recovered data directory) — said,
 * not refused, since the file and the size still judge the heap and the
 * graphs: rows a migration rewrote before the reset grew the fork, and that
 * growth is what the size catches (review pass).
 */
function physicalMoves(since: Physical, now: Physical, sinceWhat: string): string[] {
  const out: string[] = [];
  for (const rel of PHYSICAL_RELATIONS) {
    const b = since[rel];
    const c = now[rel];
    if (!b || !c) {
      out.push(`${rel}: ${!c ? "gone" : `not recorded at ${sinceWhat}`}`);
      continue;
    }
    if (c.file !== b.file) out.push(`${rel}: rewritten into another file since ${sinceWhat}`);
    else if (c.bytes > b.bytes * (1 + GROWTH_TOLERANCE)) out.push(`${rel}: grew from ${mb(b.bytes)} to ${mb(c.bytes)} MiB since ${sinceWhat}`);
    else if (c.tuples > b.tuples) out.push(`${rel}: ${(c.tuples - b.tuples).toLocaleString()} rows inserted, updated or deleted since ${sinceWhat}`);
    else if (c.tuples < b.tuples) console.log(`  (${rel}: its row counters are below ${sinceWhat}'s — reset by a crash recovery; the file and the size are ${sinceWhat}'s)`);
  }
  return out;
}

/** Both HNSW relations into the page cache, on a reuse. False where pg_prewarm cannot be had. */
async function prewarm(sql: SQL): Promise<boolean> {
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_prewarm`);
    for (const rel of HNSW_INDEXES) await sql.unsafe(`SELECT pg_prewarm($1::regclass, 'read')`, [rel]);
    return true;
  } catch {
    return false;
  }
}

/** Row i of the n-row corpus, regenerated from the seed without the rows before it. */
function rowAt(n: number, tiers: Tier[], i: number): Row {
  const stream = seedFor(n);
  stream.skip(i * DRAWS_PER_ROW);
  return rowFrom(stream, i, tiers);
}

/**
 * The kept table holds the corpus this run would generate: both counts, and
 * the first and last rows byte for byte in their tiers and to float32 in
 * their vectors (the column is float32; the generator is float64).
 */
async function assertKeptCorpus(sql: SQL, n: number, tiers: Tier[], marker: Marker): Promise<void> {
  const [{ c: rows }] = await sql.unsafe(`SELECT count(*)::bigint AS c FROM thoughts`);
  if (Number(rows) !== n) throw new NotTheCorpus(`the kept corpus holds ${Number(rows).toLocaleString()} thoughts, not ${n.toLocaleString()}`);
  const [{ c: chunks }] = await sql.unsafe(`SELECT count(*)::bigint AS c FROM thought_chunks`);
  if (Number(chunks) !== marker.stats.chunkRows) throw new NotTheCorpus(`the kept corpus holds ${Number(chunks).toLocaleString()} chunk rows; its marker says ${marker.stats.chunkRows.toLocaleString()}`);
  for (const i of [0, n - 1]) {
    const want = rowAt(n, tiers, i);
    const found = await sql`SELECT metadata->'tiers' AS tiers, embedding::text AS v FROM thoughts WHERE metadata @> ${{ doc: i }}::jsonb`;
    if (found.length !== 1) throw new NotTheCorpus(`row ${i} of the kept corpus: ${found.length} thoughts carry doc ${i}`);
    const tiersHeld = found[0].tiers;
    if (JSON.stringify(tiersHeld) !== JSON.stringify(want.tiers)) throw new NotTheCorpus(`row ${i} of the kept corpus carries tiers ${JSON.stringify(tiersHeld)}; the generator says ${JSON.stringify(want.tiers)}`);
    const held: number[] = JSON.parse(String(found[0].v));
    const drift = Math.max(...want.v.map((x, k) => Math.abs(x - (held[k] ?? NaN))));
    if (!(held.length === DIM && drift < 1e-5)) throw new NotTheCorpus(`row ${i} of the kept corpus is not the generator's row ${i} (max component difference ${drift})`);
  }
}

/** The current transaction id, as the marker records it at the build. */
async function currentXid(sql: SQL): Promise<number> {
  const [{ xid }] = await sql`SELECT pg_current_xact_id()::text::bigint AS xid`;
  return Number(xid);
}

/**
 * Rows of either table written since the build — any row version whose xmin
 * is newer than the transaction id the marker recorded. Exact at any share
 * and untouched by a statistics reset, where the counters are not (review
 * pass): a subset backfill that committed on an earlier, interrupted run and
 * grew the heap by less than the tolerance is caught here.
 */
async function rowsWrittenSince(sql: SQL, xid: number): Promise<string[]> {
  const out: string[] = [];
  for (const rel of ["thoughts", "thought_chunks"]) {
    const [{ c }] = await sql.unsafe(`SELECT count(*)::bigint AS c FROM ${rel} WHERE xmin::text::bigint > $1`, [xid % 4294967296]);
    if (Number(c) > 0) out.push(`${rel}: ${Number(c).toLocaleString()} rows written since the build`);
  }
  return out;
}

/**
 * The whole schema through migrate.ts — the ledger and the runner's own
 * refusals — for the arm above the before arm's scales, and again on a reuse,
 * where what it applies is what the tree gained since the build. On a kept
 * corpus a `--dry-run` goes first: a plain run that finds a recorded file
 * edited since reports the drift and exits 1, but only AFTER applying every
 * pending file around it, so the drift is judged before anything runs; on a
 * fresh database there is no ledger to drift from and the refusal, if any, is
 * the runner's own (a pgvector floor, a privilege). Returns the files the live
 * run recorded, read from the ledger rather than the runner's output.
 */
async function migrateWhole(sql: SQL, onto: "kept" | "fresh"): Promise<string[]> {
  const refuse = (run: { code: number; out: string }, what: string) => {
    console.error(run.out.trimEnd());
    console.error(
      `\nbench-hnsw.ts: ${what}. ${onto === "kept" ? "A kept corpus is measured only under the tree's schema; nothing was measured." : "The schema could not be applied to the empty database; nothing was loaded."}`
    );
    process.exit(1);
  };
  if (onto === "kept") {
    // A stand-in for the runner judging drift before it applies anything —
    // SMD-1504's change to migrate.ts, after which this dry run and
    // test-support's ledgerStrangers both go.
    const dry = await runMigrator(URL_, MIGRATOR_ENV, "--dry-run");
    if (dry.code !== 0) refuse(dry, `migrate.ts --dry-run exited ${dry.code} (above), before anything ran`);
    // 039 rebuilds both HNSW indexes as NEW relations under their names, which
    // the physical fingerprint below would refuse as rewritten — after a build
    // inside migrate.ts under the server's default maintenance_work_mem, hours
    // at ten million rows. The dry run already says it is pending: refuse now.
    if (/039_\S+\s+would apply/.test(dry.out)) {
      refuse(dry, "migration 039 is pending on this kept corpus: its swap rebuilds both HNSW indexes as new relations, which the marker's fingerprint would refuse as rewritten once built — remove the kept volume (the exit line prints the command) and build the corpus again under this tree");
    }
  }
  const before = new Set((await ledgerNames(sql)) ?? []);
  const run = await runMigrator(URL_, MIGRATOR_ENV);
  if (run.code !== 0) refuse(run, `migrate.ts exited ${run.code} (above)`);
  return ((await ledgerNames(sql)) ?? []).filter((name) => !before.has(name));
}

/**
 * The load: every secondary index on both tables dropped and the user
 * triggers disabled, rows streamed in, chunk rows derived server-side, the
 * indexes rebuilt with `maintenance_work_mem` sized for the graph (the HNSW
 * ones timed each, the rest together), triggers re-enabled, everything
 * measured. Only the INSERT round-trips count towards `insertS`: the
 * generator, the JSON and the confound check run between them on the client
 * and would otherwise scale the "load" with OB1_BENCH_QUERIES. The schema
 * under the load differs between the arms (001–013 or the whole set), which
 * is why the indexes and triggers come off: what remains per row during the
 * INSERTs is the heap and the primary key, the same in both. The set rebuilt
 * afterwards is not the same — 023's and 025's three indexes exist only under
 * the whole schema — so section L names how many "other indexes" its column
 * timed. Returns the tier match counts too —
 * counted as the rows are generated, so no pass over the table is needed.
 */
async function load(sql: SQL, n: number, schema: string, tiers: Tier[], queries: number[][]): Promise<{ stats: LoadStats; matches: Map<string, number> }> {
  // Every index on the two tables that a constraint does not own — the
  // primary keys stay, and so would a UNIQUE constraint's index if one were
  // added (none today; 003's unique partial index is a plain index).
  const secondary: { name: string; def: string }[] = await sql.unsafe(
    `SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname = 'public' AND t.relname IN ('thoughts', 'thought_chunks')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
     ORDER BY i.relname`
  );
  for (const name of HNSW_INDEXES) {
    if (!secondary.some((i) => i.name === name)) throw new Error(`index ${name} is not defined; the load cannot rebuild it`);
  }
  for (const i of secondary) await sql.unsafe(`DROP INDEX ${i.name}`);
  // User triggers only (008's audit, 016's entity extraction, the updated_at
  // trigger): ALL would take the FK triggers too and needs a superuser.
  for (const rel of ["thoughts", "thought_chunks"]) await sql.unsafe(`ALTER TABLE ${rel} DISABLE TRIGGER USER`);
  // A bulk load's commit latency is not what is measured; the WAL is still written.
  await sql.unsafe(`SET synchronous_commit = off`);

  const confound = new Confound(queries);
  const matches = new Map<string, number>(tiers.map((t) => [t.key, 0]));
  let insertMs = 0;
  let done = 0;
  for (const batch of rowBatches(n, tiers)) {
    const values = batch
      .map((r) => {
        confound.see(r.v);
        for (const k of r.tiers) matches.set(k, matches.get(k)! + 1);
        const meta = JSON.stringify({ doc: r.doc, tiers: r.tiers });
        return `('doc ${r.doc}', '${meta}'::jsonb, '${lit(r.v)}'::vector)`;
      })
      .join(",");
    const t0 = performance.now();
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
    insertMs += performance.now() - t0;
    done += batch.length;
    if (done % 1_000_000 === 0) process.stdout.write(`${(done / 1e6).toFixed(0)}M `);
  }
  const insertS = insertMs / 1000;
  // Refuse before the builds, not after them: a repeating generator should
  // cost the load, not the load plus twenty minutes of index.
  const nearest = Confound.check(confound.max);

  // Chunk rows for a share of thoughts, carrying the parent's own vector: the
  // point is that the chunk CTE has rows to scan and the merge has duplicates
  // to collapse, not that a chunk out-scores its parent.
  const t1 = performance.now();
  await sql.unsafe(`
    INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
    SELECT t.id, g.i, 'chunk ' || g.i, t.embedding
    FROM thoughts t, generate_series(0, ${CHUNKS_PER - 1}) AS g(i)
    WHERE (t.metadata->>'doc')::int % ${Math.round(1 / CHUNKED_SHARE)} = 0`);
  const chunkS = (performance.now() - t1) / 1000;
  const [{ chunkRows }] = await sql.unsafe(`SELECT count(*)::int AS "chunkRows" FROM thought_chunks`);

  const maintenanceMem = MAINTENANCE_MEM === "auto" ? `${Math.max(256, Math.ceil(n / 1024))}MB` : MAINTENANCE_MEM;
  // The parallel build keeps its graph in dynamic shared memory sized by this
  // setting, and the container's /dev/shm is the ceiling (with-postgres.sh
  // gives 1 GB unless OB1_PG_SHM_SIZE says more). Nothing here can read the
  // ceiling, so say what the build is about to ask for.
  if (BUILD_WORKERS > 0) process.stdout.write(`(parallel build under ${maintenanceMem}: /dev/shm must hold it — OB1_PG_SHM_SIZE) `);
  await sql.unsafe(`SET maintenance_work_mem = '${maintenanceMem}'`);
  // pgvector says when the graph stops fitting in maintenance_work_mem with a
  // NOTICE, which this driver does not surface; sent to the server log it can
  // be read after the run (`podman logs`). Superuser-only, so best effort.
  await sql.unsafe(`SET log_min_messages = notice`).catch(() => undefined);
  await sql.unsafe(`SET max_parallel_maintenance_workers = ${BUILD_WORKERS}`);
  const buildS: Record<string, number> = {};
  const otherIndexes: string[] = [];
  let otherIndexesS = 0;
  for (const { name, def } of secondary) {
    const t2 = performance.now();
    await sql.unsafe(def);
    const s = (performance.now() - t2) / 1000;
    if ((HNSW_INDEXES as readonly string[]).includes(name)) buildS[name] = s;
    else {
      otherIndexes.push(name);
      otherIndexesS += s;
    }
  }
  for (const rel of ["thoughts", "thought_chunks"]) await sql.unsafe(`ALTER TABLE ${rel} ENABLE TRIGGER USER`);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
  const sizes: Record<string, number> = {};
  for (const rel of ["thoughts", "thought_chunks"]) sizes[rel] = Number((await sql.unsafe(`SELECT pg_table_size($1::regclass)::bigint AS b`, [rel]))[0].b);
  for (const name of HNSW_INDEXES) sizes[name] = Number((await sql.unsafe(`SELECT pg_relation_size($1::regclass)::bigint AS b`, [name]))[0].b);
  for (const name of ["synchronous_commit", "maintenance_work_mem", "max_parallel_maintenance_workers"]) await sql.unsafe(`RESET ${name}`);
  await sql.unsafe(`RESET log_min_messages`).catch(() => undefined);

  return {
    stats: { scale: n, schema, confound: nearest, insertS, chunkRows: Number(chunkRows), chunkS, buildS, otherIndexes, otherIndexesS, sizes, maintenanceMem, workers: BUILD_WORKERS, builtAt: new Date().toISOString(), source: "loaded" },
    matches,
  };
}

// ── The measurements ────────────────────────────────────────────────────────

/** The answers' key for the exact answer over the whole table (section A's control); no tier is keyed so. */
const WHOLE_TABLE = "whole table";

/** A filter for a tier: `{"tiers": ["t1"]}` — array containment, one key. */
const tierFilter = (key: string) => JSON.stringify({ tiers: [key] });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Row counts asked for in section A; the last is the function's own ceiling, timed too. */
const ASKS = [10, 20, 50, 100, 200, 500];

async function unfiltered(sql: SQL, queries: number[][], wants: OracleAnswer[]): Promise<{ counts: Record<number, string>; ms10: number; msMax: number; overlap: number; ms10Raised: number; overlapRaised: number }> {
  const counts: Record<number, string> = {};
  for (const count of ASKS) {
    let min = Infinity;
    let max = -Infinity;
    for (const q of queries.slice(0, 10)) {
      const [{ c }] = await sql.unsafe(
        `SELECT count(*)::int AS c FROM match_thoughts('${lit(q)}'::vector, -1.0, ${count}, '{}'::jsonb)`
      );
      min = Math.min(min, Number(c));
      max = Math.max(max, Number(c));
    }
    counts[count] = min === max ? String(min) : `${min}–${max}`;
  }
  // The default path's latency, over every query so the median means something,
  // and the ceiling's: what asking for the most the function will return costs.
  // The default path's rows are also scored against the exact top-K over the
  // whole table — the index's recall with no filter in the way.
  const time = async (count: number): Promise<{ ms: number; overlap: number }> => {
    const times: number[] = [];
    let overlap = 0;
    for (const [i, q] of queries.entries()) {
      const t0 = performance.now();
      const got = (await sql.unsafe(`SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${count}, '{}'::jsonb)`)).map((r: { id: string }) => r.id);
      times.push(performance.now() - t0);
      overlap += got.filter((id) => wants[i].ids.includes(id)).length;
    }
    return { ms: median(times), overlap: overlap / queries.length };
  };
  const at10 = await time(K);
  const atMax = await time(ASKS[ASKS.length - 1]);
  // The same default-path call with the index asked to look harder: the
  // function does not set ef_search, so a session SET reaches it.
  await sql.unsafe(`SET hnsw.ef_search = ${EF_SEARCH_RAISED}`);
  const raised = await time(K);
  await sql.unsafe(`RESET hnsw.ef_search`);
  return { counts, ms10: at10.ms, msMax: atMax.ms, overlap: at10.overlap, ms10Raised: raised.ms, overlapRaised: raised.overlap };
}

/**
 * Exact top-K within a filter. The function scores MAX over a thought's own
 * vector and its chunks; here every chunk carries its parent's vector (see
 * the load), so that MAX is the parent's score and the thoughts table alone
 * is the exact answer — `chunksCarryParentVectors` holds the bench to that
 * once per scale, loudly, so a future chunk-vector change cannot make this
 * oracle quietly wrong (an earlier draft joined and aggregated the chunk
 * table on every call for no answer it changed). The vector index is an
 * Index Scan and nothing else, so `enable_indexscan = off` keeps it out of
 * the plan; the GIN index reaches the table through a bitmap and stays
 * available, because a filter's bitmap is exact by construction and a thin
 * filter at ten million rows should not cost a sequential scan per query.
 * A null filter is the whole table, with no predicate to evaluate on every
 * row. Correct by construction, slow on purpose where the filter is broad —
 * which is why it runs once per (tier, query) and not once per arm, and on
 * a kept corpus once per query ever (the marker keeps the answers). The ids
 * come back in distance order, the marker's form.
 */
async function oracle(sql: SQL, q: number[], filter: string | null): Promise<{ ids: string[]; top: number }> {
  // The distance is selected under an alias and the ORDER BY names the alias:
  // `1 - (embedding <=> q)` in the target list beside `embedding <=> q` in the
  // ORDER BY is two expressions to the planner, and it evaluated the distance
  // twice per row — 12–15% of every exact scan (review pass, EXPLAIN VERBOSE).
  const rows = await sql.begin(async (tx: SQL) => {
    for (const setting of ORACLE_SETTINGS) await tx.unsafe(setting);
    // The scan is parallel-eligible (Limit over a Gather Merge over a Parallel
    // Seq Scan; the distance operator is parallel safe) and the image's cap is
    // two workers; raised to the build's worker count, so the exact pass — most
    // of a reuse's minutes at ten million rows — uses the machine the build
    // did (review pass; the saving itself is not measured here). Shapes the
    // plan's speed, not its answer, so it is outside ORACLE_SHAPE.
    await tx.unsafe(`SET LOCAL max_parallel_workers_per_gather = ${ORACLE_WORKERS}`);
    return tx.unsafe(oracleStatement(lit(q), filter));
  });
  // `top` is the nearest row's cosine — the confound, read off the same exact
  // scan rather than a second query or an index probe (review passes).
  return { ids: rows.map((r: { id: string }) => r.id), top: rows.length ? 1 - Number(rows[0].d) : -1 };
}
/**
 * The settings the exact scan's exactness rests on: the vector index is an
 * Index Scan and nothing else, so the first keeps it out of the plan — and
 * the second keeps the sequential scan in, since with both off (the setting
 * 019 puts on match_thoughts, and a database- or role-level setting could
 * put on a session) the planner reaches for the index again (review pass,
 * EXPLAIN on the bench's image). `assertOracleExact` reads the plan once per
 * scale rather than trusting them.
 */
const ORACLE_SETTINGS = ["SET LOCAL enable_indexscan = off", "SET LOCAL enable_seqscan = on"] as const;
/**
 * The exact scan's statement, one place: what `oracle()` runs and what the
 * shape digests. The tie-break on id makes a K-boundary tie between rows at
 * the same float4 distance the statement's to resolve, not the worker's
 * whose stream they landed in — an answer the marker keeps must not depend
 * on the plan that computed it (review pass).
 */
const oracleStatement = (vector: string, filter: string | null) => `
      SELECT t.id, t.embedding <=> '${vector}'::vector AS d FROM thoughts t
      WHERE t.embedding IS NOT NULL${filter === null ? "" : ` AND t.metadata @> '${filter}'::jsonb`}
      ORDER BY d, t.id LIMIT ${K}`;
/**
 * What an answer IS, by value, on the client's side: a digest of the
 * oracle's statement in both filter forms and the tier filter's form as
 * rendered over placeholders, a probe of how a vector is rendered into the
 * literal (the per-query digests are of that literal, so two trees that
 * render differently must not share an entry), and ANSWER_FORM, how
 * `oracle()` derives what is stored from the rows (review passes). The
 * planner settings are not in it: they decide the plan, `assertOracleExact`
 * holds the plan, and a reordered SET LOCAL should not cost a recomputation.
 * `oracleShapeOn` adds the server's side and the stream's.
 */
/** How `oracle()` turns the rows into an answer; an edit to that derivation must change this tag, or an earlier tree's entries read as this one's. */
const ANSWER_FORM = "ids: id per row in row order; top: 1 - d of the first row, -1 where none";
const ORACLE_SHAPE = digestOf([oracleStatement("<vector>", "<filter>"), oracleStatement("<vector>", null), tierFilter("<key>"), lit([0.1, -1 / 3, 1e-7, 2]), ANSWER_FORM]);
/**
 * The key of this tree's entry in the marker's oracle map, on THIS server:
 * ORACLE_SHAPE with a probe of the distance kernel — the cosine pgvector
 * computes between two fixed vectors, as text. The kernel accumulates in
 * float4 and its last bits differ between pgvector builds and CPUs, which a
 * pinned image TAG does not fix and `extversion` does not show; a rank-K
 * near-tie resolved differently is a stale id trusted as exact, so a
 * server whose kernel rounds differently gets an entry of its own (review
 * pass) — and with the first query's digest, so a tree whose query stream
 * differs (an edit to the draws that leaves the rows alone, which the
 * regenerated rows do not catch) is another entry rather than a write over
 * this one (review pass). An edit to any input — a tie-break, another
 * operator, another containment shape, another kernel, another stream — is
 * another key: every kept answer under the old key stays for the tree that
 * wrote it, and this tree computes its own (a hand-bumped number was the
 * first draft; review passes).
 */
async function oracleShapeOn(sql: SQL, firstQuery: string): Promise<string> {
  const a = lit(Array.from({ length: DIM }, (_, i) => Math.sin(i + 1)));
  const b = lit(Array.from({ length: DIM }, (_, i) => Math.cos(3 * i + 1) / (i + 2)));
  // Rendered under a pinned extra_float_digits: the text of a float8 is the
  // session's to shorten, and a role default set by some other tool would
  // otherwise key the cache away from itself (review pass).
  const d: string = await sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL extra_float_digits = 3`);
    const [row] = await tx.unsafe(`SELECT ('${a}'::vector <=> '${b}'::vector)::text AS d`);
    return String(row.d);
  });
  return digestOf([ORACLE_SHAPE, d, firstQuery]);
}
/**
 * The plan the exact scan gets on THIS server, once per scale before any
 * answer is computed: refused if it reaches the vector index, since an
 * approximate "exact" pass would be written into the marker under a shape
 * that vouches for it and trusted by every later reuse (review pass). The
 * whole-table form is the one the planner most wants the index for.
 */
async function assertOracleExact(sql: SQL): Promise<void> {
  const plan: string[] = await sql.begin(async (tx: SQL) => {
    for (const setting of ORACLE_SETTINGS) await tx.unsafe(setting);
    const rows = await tx.unsafe(`EXPLAIN ${oracleStatement(lit(Array(DIM).fill(0)), null)}`);
    return rows.map((r: Record<string, string>) => String(Object.values(r)[0]));
  });
  // By node kind, not index name: the statement reads one relation, and an
  // Index Scan of any name over it is the vector index doing the ordering
  // (a bitmap over the GIN is not an Index Scan node). Under both settings
  // and the tie-break the planner has no ordered index path left — the gate
  // reproduced when it had (enable_seqscan forced off, ORDER BY d alone) and
  // fires now only on an edit in this tree or a planner that learned a new
  // path; a refusal with its reason, like every other gate before a
  // measurement (review passes).
  const viaIndex = plan.find((line) => /(?<!Bitmap )\bIndex (Only )?Scan\b/.test(line));
  if (viaIndex) {
    console.error(`\nbench-hnsw.ts: the exact pass would read an index on this server (${viaIndex.trim()}), so its answers would not be exact: the statement, its settings or the planner no longer keep the sequential scan. Nothing was measured.`);
    process.exit(1);
  }
}

async function chunksCarryParentVectors(sql: SQL): Promise<void> {
  const [{ c }] = await sql.unsafe(
    `SELECT count(*)::int AS c FROM thought_chunks c JOIN thoughts t ON t.id = c.thought_id WHERE c.embedding IS DISTINCT FROM t.embedding`
  );
  if (Number(c) !== 0) throw new Error(`${c} chunk rows carry a vector other than their parent's; the oracle would no longer be exact`);
}

type FilteredResult = { returned: number; overlap: number; empty: number; ms: number; exact: number };

/** The function call the arms measure; sections D and E substitute extracted statements. */
const viaFunction = (q: number[], filter: string) => `SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb)`;

async function filtered(
  sql: SQL,
  queries: number[][],
  filter: string,
  wants: OracleAnswer[],
  statement: (q: number[], filter: string) => string = viaFunction
): Promise<FilteredResult> {
  let returned = 0;
  let overlap = 0;
  let empty = 0;
  let exact = 0;
  const times: number[] = [];
  for (const [i, q] of queries.entries()) {
    const want = wants[i];
    const t0 = performance.now();
    const got = (await sql.unsafe(statement(q, filter))).map((r: { id: string }) => r.id);
    times.push(performance.now() - t0);
    returned += got.length;
    // Both lists are at most K long; a scan beside an index probe is noise.
    overlap += got.filter((id) => want.ids.includes(id)).length;
    exact += want.ids.length;
    if (got.length === 0) empty++;
  }
  return {
    returned: returned / queries.length,
    overlap: overlap / queries.length,
    exact: exact / queries.length,
    empty,
    ms: median(times),
  };
}

type PlanShape = { thoughts: string; chunks: string; ms: number; text: string };

/**
 * How each candidate CTE reached its rows. The vector index names are
 * unambiguous; a GIN bitmap or a sequential scan on `thoughts` could in
 * principle be the outer join instead, which is why only the CURRENT function
 * is explained (its outer join is a primary-key lookup and cannot match these).
 */
function shapeOf(plan: string, ms: number): PlanShape {
  // Each CTE is judged by the node that produced ITS rows, named by alias —
  // `thoughts t` (direct), `thought_chunks c` and its parent `thoughts p`
  // (chunked). The final SELECT also joins `thoughts t`, and when a CTE is
  // inlined the planner renames the inner one `t_1`, so an alias may carry a
  // numeric suffix; the outer `t` is a primary-key lookup and matches none of
  // the access patterns below. A bare `Bitmap Index Scan on
  // thoughts_metadata_idx` carries no alias, so it is attributed through the
  // Bitmap Heap Scan above it.
  const access = (alias: string, vectorIdx: string): string => {
    const a = `${alias}(?:_\\d+)?\\b`;
    if (new RegExp(`Index Scan using ${vectorIdx} on ${a}`).test(plan)) return "HNSW index scan";
    if (new RegExp(`Index (Only )?Scan using thought_chunks_(thought_id_idx|pkey) on ${a}`).test(plan)) return "chunk lookups by parent";
    if (alias.startsWith("thought_chunks") && new RegExp(`Bitmap Heap Scan on ${a}`).test(plan) && /Bitmap Index Scan on thought_chunks_(thought_id_idx|pkey)/.test(plan)) return "chunk lookups by parent (bitmap)";
    if (new RegExp(`Bitmap Heap Scan on ${a}`).test(plan)) return "GIN bitmap";
    if (new RegExp(`Tid Range Scan on ${a}`).test(plan)) return "TID range scan"; // 038's estimate: one block per probe
    if (new RegExp(`Sample Scan on ${a}`).test(plan)) return "sample scan"; // 037's estimate: TABLESAMPLE SYSTEM
    if (new RegExp(`Seq Scan on ${a}`).test(plan)) return "seq scan";
    return "?";
  };
  // The walk's chunk CTE may come at the parent's GIN index and look chunks up
  // from there; the exact branch's reads `matched` (a GIN bitmap on `thoughts
  // t`) and probes the chunk table's thought_id index (or primary key) with
  // the matched ids as an array — as an index scan or a bitmap, whichever the
  // planner picks; the exact branch's alias for the chunk table is `k`.
  const chunkDriver = /Bitmap Heap Scan on thoughts p(?:_\d+)?\b/.test(plan)
    ? "GIN bitmap on parent + PK lookups"
    : /thought_chunks k\b/.test(plan)
      ? access("thought_chunks k", "thought_chunks_embedding_idx")
      : access("thought_chunks c", "thought_chunks_embedding_idx");
  return {
    thoughts: access("thoughts t", "thoughts_embedding_idx"),
    chunks: chunkDriver,
    ms,
    text: plan,
  };
}

type Plans = { custom: PlanShape; generic: PlanShape; genericJitOn: PlanShape };

async function plans(sql: SQL, q: number[], filter: string, branch: Branch): Promise<Plans> {
  // The estimate's locals as literals, the values the function's own custom
  // plan sees — the heap's page count (037 and 038) and 037's sample share:
  // left as their declaring expressions (volatile) the planner could not size
  // 037's sample scan and, at ten million rows, JIT-compiled a statement the
  // function runs in a millisecond (routingAt says more).
  const overrides =
    branch === "estimate"
      ? { ...(routing.vPages !== undefined ? { v_pages: String(routing.vPages) } : {}), ...(routing.vPct !== undefined ? { v_pct: String(routing.vPct) } : {}) }
      : undefined;
  const body = await extractBody(sql, branch, DIM, { overrides });
  const arm = async (mode: "force_custom_plan" | "force_generic_plan", jitOn: boolean): Promise<PlanShape> => {
    const { text, ms } = await sql.begin(async (tx: SQL) => {
      // Function-level SETs are not in effect outside the function; apply the
      // same settings the function declares so the plan is the one it gets —
      // all but a plan mode, since this section exists to show both plans.
      await applyFunctionSettings(tx);
      // The third arm forces JIT back on over the function's `jit = off`
      // (040): what the same plan pays without the clause.
      if (jitOn) await tx.unsafe(`SET LOCAL jit = on`);
      return explainPrepared(tx, { body, dim: DIM, args: `'${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0`, mode });
    });
    return shapeOf(text, ms);
  };
  // The generic plan twice: as the function gets it, and with JIT forced on.
  // At ten million rows every generic plan carried 30–110 ms of startup its
  // custom twin did not, and the flat estimate that makes a plan generic is
  // also what carries its cost past jit_above_cost; the third arm read that
  // rather than inferring it (SMD-1018 review pass) and, since 040 put
  // `jit = off` on the function, reads what the clause saves. On a body
  // before 040 (OB1_BENCH_UPTO=039) the last two columns agree.
  return { custom: await arm("force_custom_plan", false), generic: await arm("force_generic_plan", false), genericJitOn: await arm("force_generic_plan", true) };
}

/**
 * PREPARE an extracted statement under the function's own settings and a
 * plan mode, hand the caller an EXECUTE builder for it, and take everything
 * down afterwards — the bracket sections D and E both open (session scope,
 * since the EXECUTEs run outside a transaction; the caller's plan mode,
 * since the two sections exist to pin different ones).
 */
async function withPrepared<T>(
  name: string,
  body: string,
  mode: "force_custom_plan" | "force_generic_plan",
  run: (via: (q: number[], filter: string) => string) => Promise<T>
): Promise<T> {
  const applied = await applyFunctionSettings(sql, { scope: "session" });
  await sql.unsafe(`SET plan_cache_mode = ${mode}`);
  await sql.unsafe(`PREPARE ${name}${preparedSignature(DIM)} AS ${body}`);
  const result = await run((q, filter) => `EXECUTE ${name}('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0)`);
  await sql.unsafe(`DEALLOCATE ${name}`);
  await sql.unsafe(`RESET plan_cache_mode`);
  for (const setting of applied) await sql.unsafe(`RESET ${setting}`);
  return result;
}

// ── Run ─────────────────────────────────────────────────────────────────────

let sql = new SQL({ url: URL_, max: 1 });
/**
 * Database-level settings (014 seeds the walk's two bounds with ALTER DATABASE)
 * are read at session START. RESET ALL does not fetch them — it restores the
 * connect-time value — so a session that predates the migration keeps
 * pgvector's defaults. The first draft did exactly that and measured section D
 * under bounds it did not have. Reconnect instead.
 */
async function reconnect(): Promise<void> {
  await sql.close();
  sql = new SQL({ url: URL_, max: 1 });
}

type Arm = "before (001–013)" | "after (014 on)" | `after (014–${string})`;
type Cell = FilteredResult & { label: string; matches: number };
type Result = {
  scale: number;
  arm: Arm;
  counts: Record<number, string>;
  ms10: number;
  msMax: number;
  /** The default path's mean overlap with the exact top-K over the whole table, and the same at the raised ef_search. */
  overlap: number;
  ms10Raised: number;
  overlapRaised: number;
  cells: Cell[];
  plan?: Record<string, { branch: Branch; tier: string; matches: number } & Plans>;
};
type WalkRow = FilteredResult & { scale: number; label: string; matches: number };
type BoundsRow = { scale: number; label: string; matches: number; tuples: number; seeded: FilteredResult; defaults: FilteredResult; raised: FilteredResult; exact?: FilteredResult };
/** Section L's row: the load's stats, and where this run's exact answers came from — `computed`, `reused` (the marker's), or `n of Q reused, the rest computed`. */
type LoadRow = LoadStats & { oracle: string };
const results: Result[] = [];
const loads: LoadRow[] = [];
const walk: WalkRow[] = [];
const bounds: BoundsRow[] = [];

// Every destructive statement below used to sit behind resetSchema's loopback
// guard; the kept-corpus paths drop a marker table and run the migrator
// without it, so the guard is asked once here, for the whole run (review pass).
assertThrowawayDatabase(URL_);

// The after arm asserts the bounds 014 seeds are in force. A role that does not
// own the database cannot seed them, and finding that out after a 100,000-row
// load discards everything measured, so ask first.
{
  const [{ owner }] = await sql`
    SELECT (pg_get_userbyid(d.datdba) = current_user OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) AS owner
    FROM pg_database d WHERE d.datname = current_database()`;
  if (!owner) {
    console.error("bench-hnsw.ts needs to run as the database's owner (or a superuser): migration 014 seeds two database-level settings the after arm depends on.");
    process.exit(2);
  }
}

/**
 * The deployed function's v_fetch and v_exact at K — read from its own
 * DECLARE block and evaluated by the server once the after arm is in place
 * (test-support's routingAt), so the tiers are routed by the threshold the
 * function actually has, not by a copy of 014's arithmetic.
 */
let routing: { vFetch: number; vExact: number; vPages?: number; vPct?: number } = { vFetch: NaN, vExact: NaN };
/**
 * pgvector's own defaults for the bounds 014 seeds, read from the server once
 * the library is loaded (`pg_settings.boot_val`) over the same HNSW_BOUNDS
 * list the in-force assertion and the RESETs use — not a second literal map,
 * which a third seeded bound would have left out of the "defaults" arm
 * (third review pass).
 */
let pgvectorDefaults: Record<string, string> = {};
async function readPgvectorDefaults(sql: SQL): Promise<Record<string, string>> {
  // The hnsw.* settings exist in pg_settings only once the library is loaded
  // in THIS session (014's header: they come from vector.so, not the catalog),
  // and this runs right after a reconnect. One cast loads it.
  await sql.unsafe(`SELECT '[1]'::vector`);
  const rows = await sql.unsafe(`SELECT name, boot_val FROM pg_settings WHERE name = ANY($1)`, [sql.array(HNSW_BOUNDS, "TEXT")]);
  const out: Record<string, string> = Object.fromEntries(rows.map((r: { name: string; boot_val: string }) => [r.name, r.boot_val]));
  for (const b of HNSW_BOUNDS) if (!(b in out)) throw new Error(`pg_settings has no boot value for ${b}; is pgvector loaded in this session?`);
  return out;
}
/** The raised `hnsw.ef_search` for the recall controls in sections A and E; pgvector's default is 40, the function leaves it alone. */
const EF_SEARCH_RAISED = 400;
/**
 * Section E measures the exact branch on a walk tier up to this many matching
 * rows: every tier to 1% of a ten-million-row table, so the tiers the walk
 * actually walks at scale have the exact branch measured beside them — the
 * first draft stopped at 50,000 and left the 1% tier at ten million as a
 * dash, which is where the "exact would be faster" claim most needs a number
 * (review pass). With headroom over the nominal 100,000: the planted count
 * is binomial about it, and a ceiling AT the mean would print the dash on
 * half of all seeds. Scoring the 50% tier row by row is still not a candidate.
 */
const EXACT_CEILING = 110_000;

// A kept corpus from an earlier run, judged against the WHOLE run before
// anything is dropped: a kept database holds one corpus, so a run that names
// any other scale would replace it — refused up front rather than after the
// kept scale was measured (a refusal at the second scale would discard the
// first's measurements, printed only after the loop). Under OB1_PG_KEEP the
// list is one scale already (judged where it was parsed); this also covers a
// persistent database reached some other way.
// Read once: only the pre-loop marker can ever be reused (a marker is written
// only under OB1_PG_KEEP, where the list is one scale, and a fresh load drops
// the table), so every rule about it is judged here and the loop reads none.
const kept = await readMarker(sql);
{
  const others = SCALES.filter((s) => s !== kept?.stats.scale);
  if (kept && others.length > 0) {
    console.error(
      `bench-hnsw.ts: the database holds a kept ${kept.stats.scale.toLocaleString()}-row corpus (built ${when(kept.stats.builtAt)}); this run asks for ${others.map((s) => s.toLocaleString()).join(", ")} rows, which would replace it.\n` +
        `  Reuse it with OB1_BENCH_SCALES=${kept.stats.scale}; run other scales without OB1_PG_KEEP (a throwaway container) or under another OB1_PG_KEEP name; or remove the kept volume (db/README.md names the command), or the ${MARKER} table where the database is your own. Nothing was touched.`
    );
    process.exit(2);
  }
  // The same refusal for a corpus of the right scale that stopped matching —
  // built from other parameters or under another marker format, or with rows
  // or files changed by migrations an earlier run applied — whichever way: a
  // kept build is never dropped without being asked (review passes).
  if (kept && kept.rewritten) {
    console.error(
      `bench-hnsw.ts: the kept ${kept.stats.scale.toLocaleString()}-row corpus (built ${when(kept.stats.builtAt)}) had its tables changed by migrations applied onto it on an earlier run (${kept.rewritten.join("; ")}); its heap and HNSW graphs are not the build's, and it was refused then.\n` +
        `  Remove the kept volume and build again under the new schema (db/README.md names the command). Nothing was touched.`
    );
    process.exit(2);
  }
  if (kept && !Bun.deepEquals(kept.params, corpusParams(tiersAt(kept.stats.scale).tiers))) {
    console.error(
      `bench-hnsw.ts: the database holds a kept ${kept.stats.scale.toLocaleString()}-row corpus (built ${when(kept.stats.builtAt)}) built from other parameters — width, tiers, chunk share or marker format — than this bench's; measuring it would be measuring another corpus.\n` +
        `  Build it again under another OB1_PG_KEEP name, or remove the kept volume (db/README.md names the command). Nothing was touched.`
    );
    process.exit(2);
  }
}

let banner = false;
for (const n of SCALES) {
  const beforeArm = n <= BEFORE_ARM_MAX;
  const { tiers, notes } = tiersAt(n);
  const params = corpusParams(tiers);

  // A kept corpus is this scale's, above the before arm's (the block above
  // and readMarker's shape refused every other case), and is reused.
  let stats: LoadStats;
  let matches: Map<string, number>;
  let appliedFiles: string[] = [];
  if (kept) {
    console.log(`▸ ${n.toLocaleString()} rows — reusing the corpus kept in this database (built ${when(kept.stats.builtAt)})`);
    // The rows first — two counts and two indexed probes, needing only 001's
    // and 007's objects — so a table that is not the generator's is refused
    // before the migrator walks it (a pending backfill over ten million rows
    // is the better part of an hour).
    try {
      await assertKeptCorpus(sql, n, tiers, kept);
    } catch (err) {
      if (!(err instanceof NotTheCorpus)) throw err;
      console.error(`bench-hnsw.ts: ${err.message}. The kept table is not the corpus its marker describes — a migration applied onto it on an earlier run may have changed rows; remove the kept volume and build again (db/README.md names the command). Nothing was touched.`);
      process.exit(1);
    }
    const strangers = await ledgerStrangers(sql);
    if (strangers === null) {
      console.error("bench-hnsw.ts: the kept corpus has no migration ledger, so nothing vouches for the schema under it; remove the kept volume and load again.");
      process.exit(1);
    }
    if (strangers.length > 0) {
      console.error(`bench-hnsw.ts: the kept corpus was migrated by files this tree does not carry (${strangers.join(", ")}); a kept corpus belongs to one tree. Keep another OB1_PG_KEEP name for this one, or remove its volume.`);
      process.exit(1);
    }
    // migrate.ts onto the corpus: pending files applied, a drifted file refused first.
    const physicalBefore = await physicalState(sql);
    appliedFiles = await migrateWhole(sql, "kept");
    await reconnect();
    // The tables' physical state against the BUILD's, recorded in the marker:
    // a migration of 023's kind (an apply-time UPDATE or DELETE over the
    // rows) leaves the heap at twice its pages and the HNSW graphs as
    // incrementally inserted twins, repaired, and a rewrite without DML (a
    // column type change, a re-created index) changes a relation's file —
    // neither is the bulk-built state the marker's sizes describe and the
    // published tables measure (SMD-1018's fourth pass judged a plain VACUUM
    // insufficient for exactly this, and a VACUUM FULL at ten million rows is
    // the rebuild the reuse exists to avoid). Judged twice: against the
    // BUILD, so a migrator that committed a rewriting file and failed on the
    // next, or a statistics flush that landed after the read, is caught by
    // the run after; and against this run's own read before the migrator,
    // so DML this run applied is caught even where the counters had been
    // reset by a crash recovery and a full rewrite landed them back on the
    // build's figure (review passes). The refusal records the evidence — what
    // moved, not a guess at which file did it — so every later run refuses.
    const physicalNow = await physicalState(sql);
    const moved = [...new Set([...physicalMoves(kept.physical, physicalNow, "the build"), ...physicalMoves(physicalBefore, physicalNow, "this run's migrator"), ...(await rowsWrittenSince(sql, kept.builtXid))])];
    if (moved.length > 0) {
      await amendMarker(sql, { rewritten: moved });
      console.error(
        `bench-hnsw.ts: the kept corpus's tables have changed (${moved.join("; ")}); its heap and HNSW graphs are no longer the bulk-built ones the marker describes, so measuring it would not be measuring the build. The marker now says so, and every later run under this name refuses too. Remove the kept volume and build again under the new schema (db/README.md names the command).`
      );
      process.exit(1);
    }
    console.log(`  ${n.toLocaleString()} thoughts and ${kept.stats.chunkRows.toLocaleString()} chunk rows counted, rows 0 and ${(n - 1).toLocaleString()} regenerated from the seed and matched, none written since the build`);
    console.log(appliedFiles.length ? `  migrations applied onto it this run: ${appliedFiles.join(", ")}` : "  schema already at the tree's; nothing applied");
  } else {
    console.log(`▸ ${n.toLocaleString()} rows — loading${beforeArm ? "" : ` (schema applied whole${UPTO === undefined ? " through migrate.ts" : `, up to ${UPTO}, bare`}; the before arm runs up to ${BEFORE_ARM_MAX.toLocaleString()} rows)`}`);
    if (beforeArm) {
      await resetSchema(URL_, { ...OPTS, only: (f) => f < "014" });
    } else if (UPTO !== undefined) {
      // A schema cut at a migration is not a tree's schema, so the migrator
      // (which applies every file) does not apply it and no ledger records
      // it: a bare apply, never kept (OB1_PG_KEEP with OB1_BENCH_UPTO is
      // refused where the list is parsed).
      await resetSchema(URL_, { ...OPTS, only: upTo });
    } else {
      await dropSchema(URL_);
      await migrateWhole(sql, "fresh");
    }
    await reconnect();
  }
  if (!banner) {
    // The extension exists only once the schema does, so the banner waits.
    const [{ extversion }] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    const [{ v }] = await sql`SELECT version() AS v`;
    const [{ shared_buffers, work_mem }] = await sql`SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('work_mem') AS work_mem`;
    console.log(`  ${String(v).split(" on ")[0]}, pgvector ${extversion}, shared_buffers ${shared_buffers}, work_mem ${work_mem}`);
    console.log(`  ${DIM}-dimensional random unit vectors, ${Q} random queries per filter, K=${K}`);
    banner = true;
  }
  for (const note of notes) console.log(`  (${note})`);
  const queries = queriesFor(n);
  // The oracle's premise — every chunk carries its parent's vector — is
  // checked on a build; on a reuse the fingerprint has just established that
  // no row of either table was written since the build, which is the only
  // way a kept chunk vector could have changed, so the minute-long join over
  // every chunk row is not paid again (review passes).
  if (kept) {
    stats = { ...kept.stats, source: "reused" };
    matches = new Map(Object.entries(kept.matches));
  } else {
    process.stdout.write("  inserting         ");
    ({ stats, matches } = await load(sql, n, beforeArm ? "001–013" : "whole", tiers, queries));
    console.log(`done — ${stats.insertS.toFixed(0)} s, nearest query-to-row cosine ${stats.confound.toFixed(3)} (a repeat would read 1.000)`);
    console.log(`  HNSW builds       ${Object.entries(stats.buildS).map(([k, s]) => `${k} ${s.toFixed(0)} s`).join(", ")}, ${stats.otherIndexes.length} other indexes ${stats.otherIndexesS.toFixed(0)} s (maintenance_work_mem ${stats.maintenanceMem}, up to ${stats.workers} workers)`);
    await chunksCarryParentVectors(sql);
  }
  // The exact answer for each (tier, query) once — shared by both arms — and
  // over the whole table, for section A's recall control and for the
  // confound, on both paths: the exact pass sees every row for every query
  // this run will use (an index probe would see its first ef_search
  // candidates), and one computation for both paths keeps a loaded and a
  // reused row comparable. The load's own accumulator stays as the early
  // abort before the index builds (review passes). On a kept corpus the
  // answers come from the marker where it holds them: the first `have`
  // queries of this run are the first `have` of the build's, by the stream's
  // construction, and the rest — none, on a reuse at the build's Q — are
  // computed here and the marker extended to hold them (SMD-1562).
  const withCounts = tiers.map((t) => ({ ...t, matches: matches.get(t.key)! }));
  const keys = [...withCounts.map((t) => t.key), WHOLE_TABLE];
  // The digests cover the literal the server parses, not the doubles it was
  // rendered from, so a change to the rendering is a change of query.
  const digests = queries.map((q) => digestOf(lit(q)));
  // One three-way state — every answer the marker's, some, none — decided
  // once as the three lines it is rendered as: the run line, section L's
  // `oracle` column and the confound's note; where the answers went is the
  // marker lines' to say (review passes).
  const shape = await oracleShapeOn(sql, digests[0]);
  // An exact answer holds K ids, or every matching row where fewer match
  // (the load inserts no NULL vector, and the fingerprint says no row moved).
  // markerAnswers is total: no marker, no map, no entry all answer for nothing.
  const exactSize = (key: string) => Math.min(K, key === WHOLE_TABLE ? n : matches.get(key)!);
  const { have, had, taken } = markerAnswers(kept?.oracle?.[shape], keys, digests, exactSize);
  const note =
    have === Q
      ? { column: "reused", run: `reused from the marker (${had === Q ? `all ${Q} queries` : `the first ${Q} of the ${had} it keeps`})`, confound: " (all of them the marker's)" }
      : have > 0
        ? { column: `${have} of ${Q} reused, the rest computed`, run: `${have} of ${Q} queries from the marker, computing the rest `, confound: ` (${have} of them the marker's)` }
        : { column: "computed", run: "", confound: "" };
  process.stdout.write(`  exact oracle      ${note.run}`);
  if (have < Q) await assertOracleExact(sql);
  const answers: Record<string, OracleAnswer[]> = {};
  for (const key of keys) {
    const rows: OracleAnswer[] = [...taken[key]];
    for (const q of queries.slice(have)) rows.push(await oracle(sql, q, key === WHOLE_TABLE ? null : tierFilter(key)));
    answers[key] = rows;
    if (have < Q) process.stdout.write(".");
  }
  // "done" is the computing pass's word; a pass the marker answered ends its line as it stands.
  console.log(have < Q ? " done" : "");
  const max = answers[WHOLE_TABLE].reduce((m, a) => Math.max(m, a.top), -1);
  try {
    stats.confound = Confound.check(max);
  } catch (err) {
    // The gate over this run's queries, the marker's and the computed alike
    // (a reuse with more queries than its build meets it first); a refusal
    // with its reason, like every other kept-corpus path.
    console.error(`bench-hnsw.ts: ${(err as Error).message}. Nothing was measured.`);
    process.exit(1);
  }
  console.log(`  nearest query-to-row cosine ${max.toFixed(3)} over this run's ${Q} queries, from the exact pass${note.confound} (a repeat would read 1.000)`);
  loads.push({ ...stats, oracle: note.column });
  // The marker last, once everything a reuse would skip — the load, the
  // builds, the premise check, the exact pass and its own confound gate — has
  // finished and passed: an interrupted or refused build leaves nothing that
  // reads as a corpus. Only where the database is kept (the one-scale rule
  // at parse makes this the scale above the before arm's): a throwaway
  // container's marker would serve nothing, and a persistent database reached
  // some other way is not this bench's to mark, on either write. This
  // tree's entry in the marker's oracle map, where it answered for fewer of
  // this run's queries than it asked, is replaced by what this run holds —
  // the answers it took plus the ones it computed — which is a shorter entry
  // only where the stream changed after its first query (the first is in
  // the key) and this run asked fewer; an entry that answered for every
  // query is left as it is, however many more it holds; other keys' entries
  // are never touched.
  const entry = (): OracleCache => ({ queries: digests, answers });
  if (!kept && KEPT) {
    await writeMarker(sql, { params, matches: Object.fromEntries(matches), stats, physical: await physicalState(sql), builtXid: await currentXid(sql), oracle: { [shape]: entry() } });
    console.log(`  corpus kept: marker written, with the exact pass's answers for ${Q} queries`);
  } else if (kept && have < Q) {
    if (KEPT) {
      await amendOracle(sql, shape, entry());
      console.log(`  marker extended: the exact pass's answers for ${Q} queries (${had === 0 ? "had none" : `had ${had}, ${have} of them this run's`})`);
    } else {
      console.log(`  (the exact pass's answers were not kept: no OB1_PG_KEEP)`);
    }
  }

  // Both HNSW relations are read into the page cache here, on BOTH paths,
  // just before the first section that walks them, so what each path's walks
  // find of the graphs in the cache is made the same by construction rather
  // than assumed (review passes). The heap's state differs by what ran
  // before: a computed exact pass streams it some five hundred times and
  // touches every tier's GIN pages; a reuse from the marker last read it
  // whole in the fingerprint's xmin scan, and each tier's first query finds
  // its bitmap pages cold (one outlier in a median of Q). Section L's
  // `oracle` column names which, and rows with the same value compare.
  // Best effort: pg_prewarm ships with the image, and its absence is said.
  {
    const warmed = await prewarm(sql);
    console.log(warmed ? `  HNSW indexes read into the page cache (pg_prewarm)` : `  (pg_prewarm unavailable; the first walks may read a cold index)`);
  }

  const arms: Arm[] = beforeArm ? ["before (001–013)", AFTER] : [AFTER];
  for (const arm of arms) {
    if (arm === AFTER) {
      // 014 and everything after it: 019 redefines match_thoughts, and the
      // plans below are read from the catalog, so the arm holds the function
      // a deployment actually has rather than a superseded one. Above the
      // before arm's scales the schema was applied whole before the load.
      if (beforeArm) {
        await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "014" && upTo(f) });
        // 023's apply-time fingerprint backfill UPDATEs every loaded row (none
        // carries a fingerprint), and the column is indexed, so the update is
        // not HOT: every row gets a new heap tuple and a second, identical
        // entry in the HNSW index beside its dead twin (third review pass). A
        // plain VACUUM removes the dead entries but leaves the heap at twice
        // its pages and the graph as the incrementally inserted twins, repaired
        // — a state the large scales, whose schema is applied to an empty
        // table, never have (fourth review pass). VACUUM FULL rewrites the
        // heap and rebuilds every index from scratch, the bulk-built state the
        // load produced, and the dead-tuple count is asserted rather than
        // assumed.
        for (const rel of ["thoughts", "thought_chunks"]) {
          await sql.unsafe(`VACUUM FULL ANALYZE ${rel}`);
          const [{ dead }] = await sql.unsafe(`SELECT n_dead_tup::int AS dead FROM pg_stat_user_tables WHERE relname = $1`, [rel]);
          if (Number(dead) !== 0) throw new Error(`${rel} still has ${dead} dead tuples after VACUUM FULL; the after arm would measure a table the load did not produce`);
        }
      }
      await reconnect(); // the database-level bounds 014 seeded are read at connect
      const inForce = Object.fromEntries((await sql.unsafe(BOUNDS_IN_FORCE_SQL)).map((r: { name: string; value: string | null }) => [r.name, r.value]));
      const [row] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
      const cfg = parseSetConfig(row?.cfg);
      if (HNSW_BOUNDS.some((b) => cfg[b] !== inForce[b])) {
        throw new Error(`session did not pick up the database-level bounds (in force ${JSON.stringify(inForce)}; database has ${JSON.stringify(cfg)})`);
      }
      console.log(`  bounds in force: ${HNSW_BOUNDS.map((b) => `${b}=${inForce[b]}`).join(", ")}`);
      // The tree's seeds, not just the database's: a kept database carries the
      // ALTER DATABASE its build's 014 ran, the migrator skips a recorded 014,
      // and 014's guard leaves a seed in place — so a config-only change to
      // HNSW_SEEDS would measure under the old bound while section E's header
      // named the new one (review pass). Refused on either path, since a
      // fresh schema seeds from the same constants.
      const stale = HNSW_BOUNDS.filter((b) => String(inForce[b]) !== String((HNSW_SEEDS as Record<string, unknown>)[b]));
      if (stale.length > 0) {
        console.error(
          `bench-hnsw.ts: the database-level bounds in force (${stale.map((b) => `${b}=${inForce[b]}`).join(", ")}) are not this tree's seeds (${stale.map((b) => `${b}=${(HNSW_SEEDS as Record<string, unknown>)[b]}`).join(", ")}); the walk would run under one bound and the tables name another. ${kept ? "Remove the kept volume and build again under this tree, or re-seed the database by hand" : "Reset the database-level settings and run again"}. Nothing was measured.`
        );
        process.exit(1);
      }
      routing = await routingAt(sql, K);
      pgvectorDefaults = await readPgvectorDefaults(sql);
      console.log(`  routing at K=${K}: v_fetch ${routing.vFetch}, exact threshold ${routing.vExact} matching thoughts; pgvector defaults ${HNSW_BOUNDS.map((b) => `${b}=${pgvectorDefaults[b]}`).join(", ")}`);
    }
    process.stdout.write(`  ${arm.padEnd(18)}`);
    const { counts, ms10, msMax, overlap, ms10Raised, overlapRaised } = await unfiltered(sql, queries, answers[WHOLE_TABLE]);
    const cells: Cell[] = [];
    for (const t of withCounts) {
      const r = await filtered(sql, queries, tierFilter(t.key), answers[t.key]);
      cells.push({ ...r, label: t.label, matches: t.matches });
      process.stdout.write(".");
    }
    // Plans only for the function under test: see shapeOf. Each branch is
    // explained on a tier the function actually routes to it, chosen by match
    // count against the exact threshold rather than by name: a small scale
    // drops tiers (n * share < 1) and would otherwise dereference a missing one
    // after the whole load, and at 1,000 rows the "10%" tier is 100 matches —
    // the exact branch, not the walk (twelfth review pass). The walk gets the
    // thinnest tier above the threshold; the exact branch the broadest tier
    // under it; the routing statement the broadest tier of all — GIN builds the
    // whole bitmap before the LIMIT can stop anything, so that is its worst
    // case — the thinnest tier with rows, where a generic plan's flat estimate
    // for `@>` has the least to go on (SMD-1018's second note), and the empty
    // one, the shape one integration sends every call.
    const withRows = withCounts.filter((t) => t.matches > 0).sort((a, b) => a.matches - b.matches);
    const walkTier = withRows.find((t) => t.matches > routing.vExact);
    const exactTier = [...withRows].reverse().find((t) => t.matches <= routing.vExact);
    const broadest = withRows[withRows.length - 1];
    const thinnest = withRows[0];
    const plan: Result["plan"] = arm === AFTER ? {} : undefined;
    if (plan) {
      if (walkTier) plan.walk = { branch: "walk", tier: walkTier.label, matches: walkTier.matches, ...(await plans(sql, queries[0], tierFilter(walkTier.key), "walk")) };
      else console.log(`\n  (no tier above the exact threshold of ${routing.vExact} rows at this scale; the walk branch is not explained)`);
      if (walkTier && broadest && broadest !== walkTier) plan.walkBroad = { branch: "walk", tier: broadest.label, matches: broadest.matches, ...(await plans(sql, queries[0], tierFilter(broadest.key), "walk")) };
      if (exactTier) plan.exact = { branch: "exact", tier: exactTier.label, matches: exactTier.matches, ...(await plans(sql, queries[0], tierFilter(exactTier.key), "exact")) };
      if (broadest) plan.routeBroad = { branch: "route", tier: broadest.label, matches: broadest.matches, ...(await plans(sql, queries[0], tierFilter(broadest.key), "route")) };
      if (thinnest && thinnest !== broadest) plan.routeThin = { branch: "route", tier: thinnest.label, matches: thinnest.matches, ...(await plans(sql, queries[0], tierFilter(thinnest.key), "route")) };
      plan.routeNone = { branch: "route", tier: "nothing", matches: 0, ...(await plans(sql, queries[0], tierFilter("none"), "route")) };
      // The gate's estimate — the sample of the heap that runs before `route`
      // and decides whether it runs (037's TABLESAMPLE, 038's TID ranges) —
      // on the same three filters: its cost is the pages it reads, so the
      // three rows should agree, and the difference between them and
      // `route`'s is what the gate saves or costs a call. A body from before
      // 037 (OB1_BENCH_UPTO=036) has no such statement. Whether the body
      // declares the heap's page count is routingAt's to say; a rewrite
      // failure on a body that does must propagate, not read as "before 037"
      // (review pass 1).
      const gated = routing.vPages !== undefined;
      if (!gated) console.log("\n  (the deployed match_thoughts declares no heap page count — a body from before 037 — so no estimate is explained)");
      if (gated) {
        if (broadest) plan.estimateBroad = { branch: "estimate", tier: broadest.label, matches: broadest.matches, ...(await plans(sql, queries[0], tierFilter(broadest.key), "estimate")) };
        if (thinnest && thinnest !== broadest) plan.estimateThin = { branch: "estimate", tier: thinnest.label, matches: thinnest.matches, ...(await plans(sql, queries[0], tierFilter(thinnest.key), "estimate")) };
        plan.estimateNone = { branch: "estimate", tier: "nothing", matches: 0, ...(await plans(sql, queries[0], tierFilter("none"), "estimate")) };
      }
    }
    results.push({ scale: n, arm, counts, ms10, msMax, overlap, ms10Raised, overlapRaised, cells, plan });
    console.log(" done");
  }

  // E. The walk through the function, under the seeded bounds and under
  // pgvector's defaults, on every tier the function routes to the walk — and
  // what the exact branch would do with the same tier. The two bounds are
  // database-level settings the function does not override, so a session SET
  // is exactly how an operator's tuning reaches it; RESET restores the
  // connect-time value, which is the database-level seed. The exact branch's
  // statement is extracted with `v_exact` overridden to just past the tier,
  // for tiers up to a bound where an exact answer is still conceivable —
  // scoring the 50% tier row by row is not a candidate for anything — and
  // PREPAREd under a forced custom plan: the function's medians above are
  // custom plans' (plpgsql's first five and, in every session here, the rest),
  // and a comparison against them must not drift onto the generic plan and
  // its JIT after the fifth EXECUTE (review pass).
  process.stdout.write("  bounds, via fn    ");
  const walkTiers = withCounts.filter((t) => t.matches > routing.vExact).sort((a, b) => a.matches - b.matches);
  for (const t of walkTiers) {
    const seeded = await filtered(sql, queries, tierFilter(t.key), answers[t.key]);
    for (const name of HNSW_BOUNDS) await sql.unsafe(`SET ${name} = ${pgvectorDefaults[name]}`);
    const defaults = await filtered(sql, queries, tierFilter(t.key), answers[t.key]);
    for (const name of HNSW_BOUNDS) await sql.unsafe(`RESET ${name}`);
    await sql.unsafe(`SET hnsw.ef_search = ${EF_SEARCH_RAISED}`);
    const raised = await filtered(sql, queries, tierFilter(t.key), answers[t.key]);
    await sql.unsafe(`RESET hnsw.ef_search`);
    let exact: FilteredResult | undefined;
    if (t.matches <= EXACT_CEILING) {
      const body = await extractBody(sql, "exact", DIM, { overrides: { v_exact: String(t.matches + 1) } });
      exact = await withPrepared("bench_exact", body, "force_custom_plan", (via) => filtered(sql, queries, tierFilter(t.key), answers[t.key], via));
    }
    bounds.push({ scale: n, label: t.label, matches: t.matches, tuples: Math.round((routing.vFetch * n) / t.matches), seeded, defaults, raised, exact });
    process.stdout.write(".");
  }
  console.log(" done");

  // D. The walk, forced. The function answers thin filters exactly and never
  // walks for them, so the bounds it seeds are not reached through the
  // function for them at any scale. This section runs the walk branch's own
  // statement — extracted from the catalog as section C does — under the
  // function's scan mode and a forced generic plan (the filter a parameter, so
  // the chunk side, whose filter lives on the parent row, walks its HNSW index
  // and looks each candidate's parent up), on every tier under the threshold
  // — the same count gate section E uses from the other side — and the empty
  // one. It
  // shows what the seeded bounds do when the walk IS reached with next to
  // nothing to find: the cost of a walk that cannot stop early. It runs last
  // for its scale — the next scale resets the schema — so nothing needs
  // restoring.
  process.stdout.write("  the walk, forced  ");
  // Under the function's own SET clauses — under 019 that is the scan mode AND
  // enable_seqscan, and a plan the deployed function cannot produce is not
  // worth timing — and a forced generic plan.
  const walkBody = await extractBody(sql, "walk", DIM);
  const thin = withCounts.filter((t) => t.matches <= routing.vExact);
  await withPrepared("bench_walk", walkBody, "force_generic_plan", async (via) => {
    for (const t of thin) {
      const r = await filtered(sql, queries, tierFilter(t.key), answers[t.key], via);
      walk.push({ scale: n, label: t.label, matches: t.matches, ...r });
      process.stdout.write(".");
    }
  });
  console.log(" done");
}

await sql.close();

// ── Report ──────────────────────────────────────────────────────────────────

console.log("\n### L. The load: insert rate, HNSW build time and relation sizes\n");
console.log("Rows go in as multi-row INSERTs with every secondary index dropped and user triggers disabled (\"schema\" is what the table carried: 001–013 where the before arm runs, the whole set above); only the INSERT round-trips are timed. The indexes are built afterwards with the maintenance_work_mem shown — the two HNSW builds timed each, the others together, with how many there were (the set differs by schema: 023's and 025's three exist only under the whole one). Sizes are pg_table_size (heap + TOAST) and pg_relation_size (index), in MiB. \"workers\" is the cap given to max_parallel_maintenance_workers, not the count launched. \"source\" says whether this run built the corpus or reused one kept from an earlier run (OB1_PG_KEEP); a reused row's numbers are the build that made it, dated. \"oracle\" says where the exact pass's answers came from — computed, reused from the kept corpus's marker, or the first n of this run's queries reused and the rest computed; the heap is warmer after a computed pass, so latencies compare between rows with the same value.\n");
console.log("| rows | source | oracle | schema | insert s | rows/s | chunk rows | chunk s | thoughts MiB | thoughts HNSW MiB | build s | chunks MiB | chunks HNSW MiB | build s | other indexes s (count) | maintenance_work_mem | workers |");
console.log("| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
for (const l of loads) {
  const source = l.source === "loaded" ? "loaded" : `reused (built ${when(l.builtAt)})`;
  console.log(
    `| ${l.scale.toLocaleString()} | ${source} | ${l.oracle} | ${l.schema} | ${l.insertS.toFixed(0)} | ${Math.round(l.scale / l.insertS).toLocaleString()} | ${l.chunkRows.toLocaleString()} | ${l.chunkS.toFixed(0)} | ${mb(l.sizes.thoughts)} | ${mb(l.sizes.thoughts_embedding_idx)} | ${l.buildS.thoughts_embedding_idx.toFixed(0)} | ${mb(l.sizes.thought_chunks)} | ${mb(l.sizes.thought_chunks_embedding_idx)} | ${l.buildS.thought_chunks_embedding_idx.toFixed(0)} | ${l.otherIndexesS.toFixed(0)} (${l.otherIndexes.length}) | ${l.maintenanceMem} | ${l.workers} |`
  );
}

console.log("\n### A. Unfiltered: rows returned for rows requested, the latency of the default path and of the ceiling, and the default path's recall\n");
console.log(`"in exact top-${K}" is the unfiltered default path scored against an exact scan of the whole table: the index's own recall at the default ef_search (40), which every filtered tier in section B sits under; the last two columns repeat the call with hnsw.ef_search = ${EF_SEARCH_RAISED}.\n`);
console.log(`| rows | arm | ${ASKS.map((a) => `asked ${a}`).join(" | ")} | median ms, asked ${K} | median ms, asked ${ASKS[ASKS.length - 1]} | in exact top-${K}, asked ${K} | ef_search ${EF_SEARCH_RAISED}: in exact top-${K} | median ms |`);
console.log(`| ---: | --- | ${ASKS.map(() => "---:").join(" | ")} | ---: | ---: | ---: | ---: | ---: |`);
for (const r of results) {
  console.log(`| ${r.scale.toLocaleString()} | ${r.arm} | ${ASKS.map((a) => r.counts[a]).join(" | ")} | ${r.ms10.toFixed(2)} | ${r.msMax.toFixed(2)} | ${r.overlap.toFixed(1)} | ${r.overlapRaised.toFixed(1)} | ${r.ms10Raised.toFixed(2)} |`);
}

console.log(`\n### B. Filtered: of ${K} asked, mean returned and mean overlap with the exact top-${K}\n`);
console.log("\"exact has\" is the oracle's own size: a tier thinner than K rows cannot fill the list. A tier named by row count is nominal; \"matching rows\" is what was planted.\n");
console.log("| rows | filter matches | matching rows | arm | returned | in exact top-10 | exact has | empty results | median ms |");
console.log("| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
for (const r of results) {
  for (const c of r.cells) {
    console.log(
      `| ${r.scale.toLocaleString()} | ${c.label} | ${c.matches.toLocaleString()} | ${r.arm} | ${c.returned.toFixed(1)} | ${c.overlap.toFixed(1)} | ${c.exact.toFixed(1)} | ${c.empty}/${Q} | ${c.ms.toFixed(2)} |`
    );
  }
}

console.log("\n### C. Plan shape of each filtered branch, on the filter the function routes to it (custom plan / generic plan)\n");
console.log("plpgsql runs custom plans for the first five calls, then generic if it is not costlier; both are shown under the function's own settings, and the generic plan once more with `jit` forced on over the function's `jit = off` (040) — the flat estimate that makes a plan generic can also carry its cost past jit_above_cost, and the difference between the last two columns is what the clause saves the call. On a body before 040 (OB1_BENCH_UPTO=039) the last two columns agree.\n");
console.log("`route` is the capped id collection that decides between the other two; it has no chunk side, and its cost is the filter's matching rows (GIN builds the whole bitmap before the LIMIT). `estimate` is the gate's sample of the heap (037), which runs before `route` on a heap of ROUTE_ESTIMATE_MIN_PAGES pages or more and skips it when the sample says the filter is far too broad for the exact branch; its cost is the pages it reads, whatever the filter — eight TID range probes since 038, where 037's TABLESAMPLE SYSTEM also paid ~2 ns a heap page. It is explained wherever the deployed body has it — the function itself runs it only on a heap of that many pages, so under the floor the row prices a statement the call never makes. Its three columns explain one plan: the gate's locals (the heap's page count; 037's sample share) are substituted as the literals the function's custom plan sees (routingAt), so nothing is left for a generic plan to leave unknown — the whole-heap estimate a generic plan would make of 037's sample scan is exactly what the substitution removes; 038's probes are priced alike under both modes.\n");
console.log("| rows | branch | filter | matching rows | thoughts side | chunk side | exec ms: custom / generic / generic, jit on |");
console.log("| ---: | --- | ---: | ---: | --- | --- | ---: |");
for (const r of results) {
  if (!r.plan) continue;
  for (const { branch, tier, matches, custom, generic, genericJitOn } of Object.values(r.plan)) {
    const chunks = branch === "route" || branch === "estimate" ? "—" : `${custom.chunks} / ${generic.chunks}`;
    console.log(
      `| ${r.scale.toLocaleString()} | ${branch} | ${tier} | ${matches.toLocaleString()} | ${custom.thoughts} / ${generic.thoughts} | ${chunks} | ${custom.ms.toFixed(2)} / ${generic.ms.toFixed(2)} / ${genericJitOn.ms.toFixed(2)} |`
    );
  }
}
if (PRINT_PLANS) {
  for (const r of results) {
    if (!r.plan) continue;
    for (const [key, { branch, tier, custom, generic, genericJitOn }] of Object.entries(r.plan)) {
      for (const [mode, shape] of [["custom", custom], ["generic", generic], ["generic, jit on", genericJitOn]] as const) {
        console.log(`\n#### ${r.scale.toLocaleString()} rows, ${branch} branch (${key}, ${tier}), ${mode} plan\n`);
        console.log(shape.text.replace(/\[[-\d.,e]+\]'::vector/g, "[…]'::vector"));
      }
    }
  }
}

console.log("\n### D. The walk branch, forced onto thin and empty filters (generic plan)\n");
console.log("Every tier under the exact threshold, and the empty filter. The function answers these exactly and never walks for them; this runs the walk's own statement on them to show what the two scan bounds do when the walk is reached with next to nothing to find.\n");
console.log("| rows | filter matches | matching rows | returned | in exact top-10 | exact has | median ms |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const g of walk) {
  console.log(
    `| ${g.scale.toLocaleString()} | ${g.label} | ${g.matches.toLocaleString()} | ${g.returned.toFixed(1)} | ${g.overlap.toFixed(1)} | ${g.exact.toFixed(1)} | ${g.ms.toFixed(2)} |`
  );
}

console.log(`\n### E. The walk through the function, under the seeded bounds (${HNSW_BOUNDS.map((b) => `${b.replace("hnsw.", "")}=${HNSW_SEEDS[b as keyof typeof HNSW_SEEDS]}`).join(", ")}), under pgvector's defaults (${HNSW_BOUNDS.map((b) => `${b.replace("hnsw.", "")}=${pgvectorDefaults[b]}`).join(", ")}), and under the seeded bounds with hnsw.ef_search = ${EF_SEARCH_RAISED}, beside the exact branch with its threshold lifted to the same tier\n`);
console.log(`"walk visits" is the header's arithmetic, v_fetch × N / matching rows (${routing.vFetch} × N / matches): the tuples the walk must pass to fill its candidate budget, against the seeded cap of ${Number(HNSW_SEEDS["hnsw.max_scan_tuples"]).toLocaleString()} and pgvector's ${Number(pgvectorDefaults["hnsw.max_scan_tuples"]).toLocaleString()}. The seeded column is section B's after-arm call for the same tier made again, later in the same session, as the paired control for the other two settings — its median differs from B's by cache warmth, not by anything the function did. The exact column is the exact branch's own statement with v_exact lifted past the tier, under a forced custom plan (the plan the function's medians are), measured only where an exact answer is conceivable (at most ${EXACT_CEILING.toLocaleString()} matching rows).\n`);
console.log(`| rows | filter matches | matching rows | walk visits | seeded: returned | in exact top-10 | median ms | defaults: returned | in exact top-10 | median ms | ef_search ${EF_SEARCH_RAISED}: returned | in exact top-10 | median ms | exact branch: returned | in exact top-10 | median ms |`);
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
const cell = (r: FilteredResult) => `${r.returned.toFixed(1)} | ${r.overlap.toFixed(1)} | ${r.ms.toFixed(2)}`;
for (const b of bounds) {
  console.log(
    `| ${b.scale.toLocaleString()} | ${b.label} | ${b.matches.toLocaleString()} | ${b.tuples.toLocaleString()} | ${cell(b.seeded)} | ${cell(b.defaults)} | ${cell(b.raised)} | ${b.exact ? cell(b.exact) : "— | — | —"} |`
  );
}
console.log();
