#!/usr/bin/env bun
/**
 * bench-querylog.ts — the two query_log costs SMD-1492 is about, measured rather
 * than argued.
 *
 * SMD-1295 shipped query_log opt-in with two acceptances the review flagged for
 * scale, and SMD-1492 is where they are settled with numbers instead of prose:
 *
 *   1. The write is awaited on the hot path. Under OB1_QUERY_LOG=on every search
 *      / fetch / edit / delete awaits a single INSERT before returning (best-
 *      effort, swallowed, but on the latency path). Fire-and-forget would shave it
 *      off, but SMD-1806 replays this log to build the canary, where a dropped row
 *      is a lost replay — so the await stays and the question is only how much it
 *      costs. This measures that INSERT's latency, and how much migration 047's
 *      new btree adds to it (the "fourth index write cost" the ticket weighs, and
 *      the number a future BRIN follow-up would try to erase).
 *
 *   2. prune could not seek. prune_query_log deletes WHERE logged_at < cutoff with
 *      no agent_id predicate; 034's only logged_at index is the composite
 *      (agent_id, logged_at), whose leading column is agent_id, so the delete fell
 *      to a sequential scan. Migration 047 adds a plain btree on logged_at. This
 *      runs the prune DELETE under EXPLAIN (ANALYZE) with and without that index
 *      and shows the plan flip from Seq Scan to an index range scan.
 *
 *   ./with-postgres.sh bun bench-querylog.ts
 *   OB1_BENCH_SCALES=1000000 ./with-postgres.sh bun bench-querylog.ts
 *
 * Every arm starts from a fresh schema (resetSchema applies every migration,
 * including 047, so the index is built by the schema, not bolted on), and the
 * "without" arm drops just query_log_logged_at_idx — so the two arms differ by
 * that one index and nothing else. The prune measurements roll their DELETE back,
 * so both arms see the same rows.
 */

import { SQL } from "bun";
import { requireDatabaseUrl, resetSchema } from "./test-support.ts";

const URL_ = requireDatabaseUrl("bench-querylog.ts");

/** query_log carries no vector; dim/model only satisfy the migration substitution. */
const OPTS = { dim: 8, model: "stub-embed" };

/** Row counts the prune arm populates. query_log rows are small; a million loads in seconds. */
const SCALES = (process.env.OB1_BENCH_SCALES ?? "1000,10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Rows the batched write-cost arm inserts in one statement (round-trip amortized, isolates the index). */
const WRITE_BATCH = Number(process.env.OB1_BENCH_WRITE_BATCH ?? 20000);

/** Single-row awaited INSERTs timed for the hot-path latency number (one round trip each). */
const AWAITED_PROBES = Number(process.env.OB1_BENCH_AWAITED ?? 300);

/** Repeats per prune probe. The median is reported; the first run is discarded as warm-up. */
const REPEATS = Number(process.env.OB1_BENCH_REPEATS ?? 5);

/** The retention window prune deletes past. */
const KEEP_DAYS = 30;

/**
 * The fraction of rows prune deletes — a realistic retention prune trims a small
 * old tail off a mostly-recent log, NOT half the table. This is the case the
 * logged_at index is for: a ~50% range delete is often served best by a Seq Scan
 * (and the planner keeps one in both arms), so spreading rows to delete only a
 * small fraction is what exercises the index. Rows are aged uniformly over
 * SPREAD_DAYS so exactly this fraction lands older than KEEP_DAYS.
 */
const DELETE_FRACTION = Number(process.env.OB1_BENCH_DELETE_FRACTION ?? 0.1);
if (!(DELETE_FRACTION > 0 && DELETE_FRACTION < 1)) {
  throw new Error(`OB1_BENCH_DELETE_FRACTION must be in (0, 1), got ${process.env.OB1_BENCH_DELETE_FRACTION}`);
}
const SPREAD_DAYS = KEEP_DAYS / (1 - DELETE_FRACTION);

// The numeric knobs guard their own edges, as DELETE_FRACTION does: an unset value
// takes the default, but a supplied 0, negative, fractional or non-numeric one would
// otherwise slip through to a divide-by-zero (perRowUs, awaitedMs), an undefined
// median (REPEATS=0 leaves the sample array empty), a generate_series(1, NaN) SQL
// error, or an empty SCALES that prints a "flips at every scale" conclusion drawn
// from zero rows. Fail fast instead.
for (const [name, val] of [
  ["OB1_BENCH_WRITE_BATCH", WRITE_BATCH],
  ["OB1_BENCH_AWAITED", AWAITED_PROBES],
  ["OB1_BENCH_REPEATS", REPEATS],
] as const) {
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(`${name} must be an integer >= 1, got ${process.env[name]}`);
  }
}
if (SCALES.length === 0) {
  throw new Error(`OB1_BENCH_SCALES must list at least one positive integer, got ${process.env.OB1_BENCH_SCALES}`);
}

const INDEX = "query_log_logged_at_idx";

// ── Setup ──────────────────────────────────────────────────────────────────────

/**
 * A fresh schema (every migration, index present) on its own single connection.
 * Assert the index is actually there, symmetric with dropIndex's post-check: if the
 * migration ever stops building it (renamed, guarded out, lost in a merge), the
 * "with index" arm would silently measure an index-less table and both arms would
 * read alike — a false "no change" that looks like a clean result, not a broken bench.
 */
async function load(): Promise<SQL> {
  await resetSchema(URL_, OPTS);
  const c = new SQL({ url: URL_, max: 1 });
  const [n] = await c`SELECT count(*)::int AS c FROM pg_indexes WHERE indexname = ${INDEX}`;
  if (n.c !== 1) throw new Error(`${INDEX} was not built by the schema — the with-index arm would measure an index-less table`);
  return c;
}

/** Drop 047's index and prove it is gone — "with" silently staying "with" would read as a clean result. */
async function dropIndex(c: SQL): Promise<void> {
  await c`DROP INDEX IF EXISTS query_log_logged_at_idx`;
  const [n] = await c`SELECT count(*)::int AS c FROM pg_indexes WHERE indexname = ${INDEX}`;
  if (n.c !== 0) throw new Error(`${INDEX} survived the drop — the no-index arm would be invalid`);
}

/**
 * Populate `n` search rows with logged_at aged uniformly over SPREAD_DAYS, so
 * prune(KEEP_DAYS) deletes the oldest DELETE_FRACTION of them — the small old tail
 * a real retention prune trims off a mostly-recent log, which is the selective
 * range the logged_at index is for (half the table would favour a Seq Scan in both
 * arms). agent_id is random so the composite index is as populated as it would be
 * in life (and cannot accidentally serve the bare-logged_at range).
 */
async function populate(c: SQL, n: number): Promise<void> {
  await c`
    INSERT INTO query_log (logged_at, kind, tool, query, agent_id)
    SELECT now() - make_interval(days => 1) * (${SPREAD_DAYS} * g::float8 / ${n}),
           'search', 'search_thoughts', 'q' || g, gen_random_uuid()
      FROM generate_series(1, ${n}) AS g`;
  await c`ANALYZE query_log`;
}

// ── Measurement ──────────────────────────────────────────────────────────────

type Timing = { ms: number; plan: string; rows: number };

/**
 * The scan node under a Delete — the answer to "did prune seek the index", and
 * the node that carries the real matched-row count (the top Delete node reports 0
 * Actual Rows without a RETURNING clause, so reading rows off it would always say
 * 0 even when the delete matched half the table).
 */
function scanNode(node: Record<string, unknown>): Record<string, unknown> | null {
  const t = String(node["Node Type"] ?? "?");
  if (t === "Seq Scan" || t === "Index Scan" || t === "Index Only Scan" || t === "Bitmap Heap Scan") return node;
  const kids = (node.Plans ?? []) as Array<Record<string, unknown>>;
  for (const k of kids) {
    const found = scanNode(k);
    if (found) return found;
  }
  return null;
}

/**
 * Time the prune DELETE under EXPLAIN (ANALYZE), rolled back so the rows survive
 * for the next arm and the next repeat. TIMING stays ON: with it off Postgres
 * reports the plan but zero durations, which reads as an infinitely fast query.
 *
 * The cutoff is a fixed timestamp passed in, not `now() - interval` re-evaluated
 * per query: the two arms run seconds apart (twelve EXPLAINs plus a large ANALYZE
 * between them), and with rows densely packed near the boundary at scale a moving
 * `now()` would carry the cutoff past a few rows, so the arms would delete slightly
 * different counts and the controlled comparison would abort. A bound timestamp
 * plans identically to `now() - interval` (both a range predicate on logged_at) and
 * makes both arms delete exactly the same rows.
 */
async function timePrune(c: SQL, cutoff: Date): Promise<Timing> {
  const runs: number[] = [];
  let plan = "?";
  let rows = 0;
  for (let i = 0; i <= REPEATS; i++) {
    await c`BEGIN`;
    try {
      const res = await c`EXPLAIN (ANALYZE, FORMAT JSON)
        DELETE FROM query_log WHERE logged_at < ${cutoff}`;
      const json = (res[0] as Record<string, unknown>)["QUERY PLAN"] as Array<Record<string, unknown>>;
      if (i > 0) {
        runs.push(Number(json[0]["Execution Time"] ?? 0));
        const scan = scanNode(json[0].Plan as Record<string, unknown>);
        plan = scan ? String(scan["Node Type"]) : "?";
        rows = scan ? Number(scan["Actual Rows"] ?? 0) : 0;
      }
    } finally {
      await c`ROLLBACK`;
    }
  }
  runs.sort((a, b) => a - b);
  return { ms: runs[Math.floor(runs.length / 2)], plan, rows };
}

/**
 * The median wall time of a bulk INSERT of `n` rows in one statement, over REPEATS
 * batches (the first discarded as warm-up), matching timePrune's rigor rather than
 * trusting a single cold sample. The round trip is amortized across each batch, so
 * the with/without-index difference is the btree's per-row maintenance cost rather
 * than network latency — the number to compare between the two arms. (A per-row
 * awaited INSERT cannot isolate it: at ~1 ms a round trip and ~µs of index work, the
 * maintenance is lost in the connection noise.) Each batch grows the table, but both
 * arms grow identically, so the comparison stays controlled.
 */
async function medianBatchMs(c: SQL, n: number): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i <= REPEATS; i++) {
    const t = performance.now();
    await c`INSERT INTO query_log (kind, tool, query, agent_id, tier, arm)
            SELECT 'search', 'search_thoughts', 'q' || g, gen_random_uuid(), 'canary', 'hybrid'
              FROM generate_series(1, ${n}) AS g`;
    if (i > 0) runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/**
 * The median wall time of one single-row awaited INSERT — one round trip each, the
 * exact shape and cost the request hot path pays when OB1_QUERY_LOG=on (round-trip
 * dominated). This is the number the "keep the await" decision is grounded in, so it
 * takes the median of `n` calls with the first discarded as warm-up, not a single
 * mean: a GC pause or scheduler stall in one call then moves one sample, not the
 * headline figure (matching timePrune / medianBatchMs).
 */
async function medianAwaitedMs(c: SQL, n: number): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = performance.now();
    await c`INSERT INTO query_log (kind, tool, query, agent_id, tier, arm)
            VALUES ('search', 'search_thoughts', ${"q" + i}, gen_random_uuid(), 'canary', 'hybrid')`;
    if (i > 0) runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

function fmtMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(0)} ms`;
}

/**
 * The index's per-row maintenance cost. Reported as negligible unless it clears
 * +0.5 µs: the two arms are timed on separately loaded tables (bloat can't cross
 * between them, but ambient load can skew each), so a small "+0.1 µs" would invite a
 * reader to believe a difference a second run would reverse — and a *negative* result
 * is physically impossible (an index cannot speed up an insert), so it can only be
 * that same noise. Both collapse to "negligible", which is itself the finding: the
 * btree's cost sits far below the ~0.5 ms round trip the await already pays.
 */
function perRowUs(withMs: number, withoutMs: number, n: number): string {
  const us = ((withMs - withoutMs) * 1000) / n;
  if (us < 0.5) return "negligible (< 0.5 µs, at/below measurement noise)";
  return `+${us.toFixed(2)} µs`;
}

/** before/after as a ratio, with a ±5% dead band (noise at these durations). */
function change(before: number, after: number): string {
  if (!Number.isFinite(before) || !Number.isFinite(after) || after <= 0 || before <= 0) return "n/a";
  const r = before / after;
  if (r >= 1.05) return `${r.toFixed(1)}x faster`;
  if (r <= 0.95) return `${(1 / r).toFixed(1)}x slower`;
  return "no change";
}

// ── Run ────────────────────────────────────────────────────────────────────────

console.log(`scales:  ${SCALES.join(", ")} rows (aged over ${SPREAD_DAYS.toFixed(1)} days; prune keeps ${KEEP_DAYS}, deletes the oldest ~${Math.round(DELETE_FRACTION * 100)}%)`);
console.log(`writes:  ${WRITE_BATCH.toLocaleString()} batched (index cost), ${AWAITED_PROBES} single awaited (hot-path latency)`);
console.log(`repeats: ${REPEATS} per prune probe, median reported\n`);

type PruneRow = { scale: number; withIdx: Timing; without: Timing };
type WriteRow = { withoutMs: number; withMs: number; awaitedMs: number };

const pruneRows: PruneRow[] = [];

// ── Prune: the plan flip, one populated table per scale ─────────────────────────
for (const scale of SCALES) {
  console.log(`── ${scale.toLocaleString()} rows ${"─".repeat(Math.max(0, 50 - String(scale).length))}`);
  const c = await load();
  try {
    await populate(c, scale);
    // One cutoff for both arms (see timePrune) — prune_query_log's own now()-interval.
    const [{ cutoff }] = (await c`SELECT now() - make_interval(days => ${KEEP_DAYS}) AS cutoff`) as { cutoff: Date }[];

    const withIdx = await timePrune(c, cutoff);
    console.log(`   prune, with ${INDEX}:  ${fmtMs(withIdx.ms).padStart(9)} (${withIdx.plan}, ${withIdx.rows} rows)`);

    await dropIndex(c);
    await c`ANALYZE query_log`;
    const without = await timePrune(c, cutoff);
    console.log(`   prune, no logged_at index: ${fmtMs(without.ms).padStart(9)} (${without.plan}, ${without.rows} rows)`);

    // Same cutoff, same table, rolled back between — the arms must delete the same rows.
    if (withIdx.rows !== without.rows) {
      throw new Error(`the two prune arms deleted different counts (${withIdx.rows} vs ${without.rows}) — not a controlled comparison`);
    }

    // Tie the inlined predicate to the function it stands in for. EXPLAIN cannot see
    // inside a plpgsql body, so the plan above is measured on a copy of the DELETE;
    // run the real prune_query_log(KEEP_DAYS) rolled back and confirm it deletes the
    // same rows (allowing a small drift for its own slightly-later now()), so a future
    // change to the function's predicate is caught here, not silently measured stale.
    await c`BEGIN`;
    let funcDeleted = 0;
    try {
      const [r] = await c`SELECT prune_query_log(${KEEP_DAYS}) AS n`;
      funcDeleted = Number(r.n);
    } finally {
      await c`ROLLBACK`;
    }
    const drift = Math.max(5, Math.ceil(scale * 0.005));
    if (Math.abs(funcDeleted - withIdx.rows) > drift) {
      throw new Error(`the inlined prune predicate deleted ${withIdx.rows} rows but prune_query_log deleted ${funcDeleted} (drift > ${drift}) — the bench has drifted from the function it measures`);
    }

    pruneRows.push({ scale, withIdx, without });
  } finally {
    await c.close();
  }
  console.log();
}

// ── Write cost, and the hot-path latency ─────────────────────────────────────────
// Two freshly loaded tables so bloat from one arm cannot reach the other. The
// batched insert isolates the index's maintenance cost; the awaited probes measure
// what a live call actually waits for (run on the index-present table, as a
// deployment has).
console.log(`── write cost ${"─".repeat(40)}`);
const withIdxC = await load();
let withMs: number, awaitedMs: number;
try {
  withMs = await medianBatchMs(withIdxC, WRITE_BATCH);
  awaitedMs = await medianAwaitedMs(withIdxC, AWAITED_PROBES);
} finally {
  await withIdxC.close();
}

const noIdxC = await load();
let withoutMs: number;
try {
  await dropIndex(noIdxC);
  withoutMs = await medianBatchMs(noIdxC, WRITE_BATCH);
} finally {
  await noIdxC.close();
}

const write: WriteRow = { withoutMs, withMs, awaitedMs };
console.log(
  `   batch ${WRITE_BATCH.toLocaleString()}: ${fmtMs(withoutMs)} without → ${fmtMs(withMs)} with  ` +
    `(${perRowUs(withMs, withoutMs, WRITE_BATCH)}/row for the index)`
);
console.log(`   awaited single INSERT: ${awaitedMs.toFixed(2)} ms/call median (what the hot path waits for)`);
console.log();

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\n### Prune: does the DELETE seek logged_at? (median of " + REPEATS + ", EXPLAIN ANALYZE, rolled back)\n");
console.log("| rows | deleted | without index | plan | with 047 | plan | change |");
console.log("| ---: | ---: | ---: | --- | ---: | --- | ---: |");
for (const r of pruneRows) {
  console.log(
    `| ${r.scale.toLocaleString()} | ${r.withIdx.rows.toLocaleString()} | ${fmtMs(r.without.ms)} | ${r.without.plan} | ` +
      `${fmtMs(r.withIdx.ms)} | ${r.withIdx.plan} | ${change(r.without.ms, r.withIdx.ms)} |`
  );
}
// Report the flip only where it was actually observed — at small scales the table
// is cheap enough that Postgres scans regardless (the crossover, as bench-trgm found
// for the trigram index), and a hard-coded "it flips" would contradict the table above.
const flipped = pruneRows.filter((r) => r.without.plan === "Seq Scan" && r.withIdx.plan !== "Seq Scan");
if (flipped.length === pruneRows.length) {
  console.log("\nAt every scale the delete flips from a Seq Scan of the whole log (no index) to an index range scan (047).");
} else if (flipped.length > 0) {
  console.log(`\nThe delete flips from a Seq Scan to an index range scan at ${flipped.map((r) => r.scale.toLocaleString()).join(", ")} rows; below that the table is small enough that Postgres scans regardless (the crossover).`);
} else {
  console.log("\nNo scale showed a Seq-Scan→index-scan flip: the table is small enough that Postgres scans regardless. Raise OB1_BENCH_SCALES (e.g. 1000000) to cross over.");
}

console.log("\n### Write cost of the index, and the awaited hot-path latency\n");
console.log(`A batch of ${WRITE_BATCH.toLocaleString()} rows in one INSERT into two freshly loaded tables that differ only`);
console.log(`by 047's index — the round trip is amortized, so the delta is the btree's per-row`);
console.log(`maintenance (what a BRIN follow-up would try to erase). The awaited number is a single`);
console.log(`INSERT per round trip, index present: what OB1_QUERY_LOG=on makes a search or fetch wait`);
console.log(`for before it returns, and the cost the "keep the await" decision accepts.\n`);
console.log("| batch without index | batch with 047 | index adds per row | awaited single INSERT |");
console.log("| ---: | ---: | ---: | ---: |");
console.log(
  `| ${fmtMs(write.withoutMs)} | ${fmtMs(write.withMs)} | ` +
    `${perRowUs(write.withMs, write.withoutMs, WRITE_BATCH)} | ${write.awaitedMs.toFixed(2)} ms/call |`
);
console.log();
