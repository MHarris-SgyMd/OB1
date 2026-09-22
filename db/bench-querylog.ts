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
 *      costs. This measures that INSERT's latency, and how much migration 046's
 *      new btree adds to it (the "fourth index write cost" the ticket weighs, and
 *      the number a future BRIN follow-up would try to erase).
 *
 *   2. prune could not seek. prune_query_log deletes WHERE logged_at < cutoff with
 *      no agent_id predicate; 034's only logged_at index is the composite
 *      (agent_id, logged_at), whose leading column is agent_id, so the delete fell
 *      to a sequential scan. Migration 046 adds a plain btree on logged_at. This
 *      runs the prune DELETE under EXPLAIN (ANALYZE) with and without that index
 *      and shows the plan flip from Seq Scan to an index range scan.
 *
 *   ./with-postgres.sh bun bench-querylog.ts
 *   OB1_BENCH_SCALES=1000000 ./with-postgres.sh bun bench-querylog.ts
 *
 * Every arm starts from a fresh schema (resetSchema applies every migration,
 * including 046, so the index is built by the schema, not bolted on), and the
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

/** The retention window prune deletes past; the rows below are spread over twice it. */
const KEEP_DAYS = 30;

const INDEX = "query_log_logged_at_idx";

// ── Setup ──────────────────────────────────────────────────────────────────────

/** A fresh schema (every migration, index present) on its own single connection. */
async function load(): Promise<SQL> {
  await resetSchema(URL_, OPTS);
  return new SQL({ url: URL_, max: 1 });
}

/** Drop 046's index and prove it is gone — "with" silently staying "with" would read as a clean result. */
async function dropIndex(c: SQL): Promise<void> {
  await c`DROP INDEX IF EXISTS query_log_logged_at_idx`;
  const [n] = await c`SELECT count(*)::int AS c FROM pg_indexes WHERE indexname = ${INDEX}`;
  if (n.c !== 0) throw new Error(`${INDEX} survived the drop — the no-index arm would be invalid`);
}

/**
 * Populate `n` search rows with logged_at spread evenly over 2 * KEEP_DAYS, oldest
 * first, so prune(KEEP_DAYS) deletes about the older half — a real range, not all
 * or nothing. agent_id is random so the composite index is as populated as it
 * would be in life (and cannot accidentally serve the bare-logged_at range).
 */
async function populate(c: SQL, n: number): Promise<void> {
  await c`
    INSERT INTO query_log (logged_at, kind, tool, query, agent_id)
    SELECT now() - make_interval(days => ${2 * KEEP_DAYS}) * (g::float8 / ${n}),
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
 */
async function timePrune(c: SQL): Promise<Timing> {
  const runs: number[] = [];
  let plan = "?";
  let rows = 0;
  for (let i = 0; i <= REPEATS; i++) {
    await c`BEGIN`;
    try {
      const res = await c`EXPLAIN (ANALYZE, FORMAT JSON)
        DELETE FROM query_log WHERE logged_at < now() - make_interval(days => ${KEEP_DAYS})`;
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
 * One bulk INSERT of `n` rows in a single statement. The round trip is amortized
 * across the batch, so the with/without-index difference is the btree's per-row
 * maintenance cost rather than network latency — the number to compare between the
 * two arms. (A per-row awaited INSERT cannot isolate it: at ~1 ms a round trip and
 * ~µs of index work, the maintenance is lost in the connection noise.)
 */
async function timeBatchInsert(c: SQL, n: number): Promise<number> {
  const t = performance.now();
  await c`INSERT INTO query_log (kind, tool, query, agent_id, tier, arm)
          SELECT 'search', 'search_thoughts', 'q' || g, gen_random_uuid(), 'canary', 'hybrid'
            FROM generate_series(1, ${n}) AS g`;
  return performance.now() - t;
}

/**
 * `n` single-row awaited INSERTs, one round trip each — the exact shape and cost
 * the request hot path pays when OB1_QUERY_LOG=on (round-trip dominated). This is
 * the number the "keep the await" decision is grounded in: it is what a search or
 * a fetch waits for before returning.
 */
async function timeAwaitedInserts(c: SQL, n: number): Promise<number> {
  const t = performance.now();
  for (let i = 0; i < n; i++) {
    await c`INSERT INTO query_log (kind, tool, query, agent_id, tier, arm)
            VALUES ('search', 'search_thoughts', ${"q" + i}, gen_random_uuid(), 'canary', 'hybrid')`;
  }
  return performance.now() - t;
}

function fmtMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(0)} ms`;
}

/**
 * The index's per-row maintenance cost, signed. Below ±0.5 µs it is reported as
 * negligible rather than as a number: at 20k batched rows that band is warm-up and
 * ordering noise, and a signed "+0.1 µs" (or a negative one) invites a reader to
 * believe a difference a second run would reverse. That the cost lands here at all
 * is the finding — the btree is far below the ~0.5 ms round trip the await pays.
 */
function perRowUs(withMs: number, withoutMs: number, n: number): string {
  const us = ((withMs - withoutMs) * 1000) / n;
  if (Math.abs(us) < 0.5) return "negligible (<0.5 µs)";
  return `${us > 0 ? "+" : ""}${us.toFixed(2)} µs`;
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

console.log(`scales:  ${SCALES.join(", ")} rows (spread over ${2 * KEEP_DAYS} days; prune keeps ${KEEP_DAYS})`);
console.log(`writes:  ${WRITE_BATCH.toLocaleString()} batched (index cost), ${AWAITED_PROBES} single awaited (hot-path latency)`);
console.log(`repeats: ${REPEATS} per prune probe, median reported\n`);

type PruneRow = { scale: number; withIdx: Timing; without: Timing };
type WriteRow = { withoutMs: number; withMs: number; awaitedMs: number };

const pruneRows: PruneRow[] = [];

// ── Prune: the plan flip, one populated table per scale ─────────────────────────
for (const scale of SCALES) {
  console.log(`── ${scale.toLocaleString()} rows ${"─".repeat(Math.max(0, 50 - String(scale).length))}`);
  const c = await load();
  await populate(c, scale);

  const withIdx = await timePrune(c);
  console.log(`   prune, with ${INDEX}:  ${fmtMs(withIdx.ms).padStart(9)} (${withIdx.plan}, ${withIdx.rows} rows)`);

  await dropIndex(c);
  await c`ANALYZE query_log`;
  const without = await timePrune(c);
  console.log(`   prune, no logged_at index: ${fmtMs(without.ms).padStart(9)} (${without.plan}, ${without.rows} rows)`);

  if (withIdx.rows !== without.rows) {
    throw new Error(`the two prune arms deleted different counts (${withIdx.rows} vs ${without.rows}) — not a controlled comparison`);
  }
  pruneRows.push({ scale, withIdx, without });
  await c.close();
  console.log();
}

// ── Write cost, and the hot-path latency ─────────────────────────────────────────
// Two freshly loaded tables so bloat from one arm cannot reach the other. The
// batched insert isolates the index's maintenance cost; the awaited probes measure
// what a live call actually waits for (run on the index-present table, as a
// deployment has).
console.log(`── write cost ${"─".repeat(40)}`);
const withIdxC = await load();
const withMs = await timeBatchInsert(withIdxC, WRITE_BATCH);
const awaitedMs = await timeAwaitedInserts(withIdxC, AWAITED_PROBES);
await withIdxC.close();

const noIdxC = await load();
await dropIndex(noIdxC);
const withoutMs = await timeBatchInsert(noIdxC, WRITE_BATCH);
await noIdxC.close();

const write: WriteRow = { withoutMs, withMs, awaitedMs };
console.log(
  `   batch ${WRITE_BATCH.toLocaleString()}: ${fmtMs(withoutMs)} without → ${fmtMs(withMs)} with  ` +
    `(${perRowUs(withMs, withoutMs, WRITE_BATCH)}/row for the index)`
);
console.log(`   awaited single INSERT: ${(awaitedMs / AWAITED_PROBES).toFixed(2)} ms/call (what the hot path waits for)`);
console.log();

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\n### Prune: does the DELETE seek logged_at? (median of " + REPEATS + ", EXPLAIN ANALYZE, rolled back)\n");
console.log("| rows | deleted | without index | plan | with 046 | plan | change |");
console.log("| ---: | ---: | ---: | --- | ---: | --- | ---: |");
for (const r of pruneRows) {
  console.log(
    `| ${r.scale.toLocaleString()} | ${r.withIdx.rows.toLocaleString()} | ${fmtMs(r.without.ms)} | ${r.without.plan} | ` +
      `${fmtMs(r.withIdx.ms)} | ${r.withIdx.plan} | ${change(r.without.ms, r.withIdx.ms)} |`
  );
}
console.log("\nWithout the index the plan is a Seq Scan of the whole log; with 046 it is an index range scan.");

console.log("\n### Write cost of the index, and the awaited hot-path latency\n");
console.log(`A batch of ${WRITE_BATCH.toLocaleString()} rows in one INSERT into two freshly loaded tables that differ only`);
console.log(`by 046's index — the round trip is amortized, so the delta is the btree's per-row`);
console.log(`maintenance (what a BRIN follow-up would try to erase). The awaited number is a single`);
console.log(`INSERT per round trip, index present: what OB1_QUERY_LOG=on makes a search or fetch wait`);
console.log(`for before it returns, and the cost the "keep the await" decision accepts.\n`);
console.log("| batch without index | batch with 046 | index adds per row | awaited single INSERT |");
console.log("| ---: | ---: | ---: | ---: |");
console.log(
  `| ${fmtMs(write.withoutMs)} | ${fmtMs(write.withMs)} | ` +
    `${perRowUs(write.withMs, write.withoutMs, WRITE_BATCH)} | ${(write.awaitedMs / AWAITED_PROBES).toFixed(2)} ms/call |`
);
console.log();
