#!/usr/bin/env bun
/**
 * bench-stats.ts — thought_stats aggregated in SQL (migration 024's
 * thought_stats_summary()) against the application page walk it replaces, at the
 * corpus sizes we have, measured rather than argued (the fork's rule, SMD-925).
 *
 * SMD-1249. The tool used to page store.pageThoughtMeta(offset, 1000) and tally
 * type/topic/people counts in JS, up to a 100,000-row ceiling past which it
 * under-reported. On the direct-SQL path Postgres does the whole corpus in one
 * statement. This measures both — the function and a faithful copy of the walk —
 * so the header and FORK.md change 45 quote numbers, and prints the plan so the
 * "full scan, accepted for a once-called tool" claim is shown, not asserted.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *
 * Per scale: the median wall-clock of `SELECT thought_stats_summary()` against
 * the median wall-clock of the page walk (metadata paged 1,000 at a time and
 * tallied in TS, as store-postgrest.ts still does), the walk's round-trip count,
 * and the plan of the function's topic-unnest arm under EXPLAIN (ANALYZE,
 * BUFFERS). Rows are content-only (no vectors — stats never reads embedding), so
 * there is no HNSW build and this runs in seconds even at 100,000.
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *
 *   ./with-postgres.sh bun bench-stats.ts                       # 1,000 / 10,000 / 100,000 rows
 *   OB1_BENCH_SCALES=1000,10000 ./with-postgres.sh bun bench-stats.ts
 *   ./with-postgres.sh bun bench-stats.ts --plans               # print the full EXPLAIN text
 */

import { SQL } from "bun";
import { applyMigrations, requireDatabaseUrl, resetSchema, seededRandom } from "./test-support.ts";
import { EMBEDDING_DIM } from "./config.mjs";

const URL_ = requireDatabaseUrl("bench-stats.ts");
const PRINT_PLANS = process.argv.includes("--plans");
const OPTS = { dim: EMBEDDING_DIM, model: "stub-embed" };
const SCALES = (process.env.OB1_BENCH_SCALES ?? "1000,10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
if (SCALES.length === 0) {
  console.error(`OB1_BENCH_SCALES must name at least one positive row count (got ${JSON.stringify(process.env.OB1_BENCH_SCALES)})`);
  process.exit(2);
}
const REPEATS = Number(process.env.OB1_BENCH_REPEATS ?? 5);
const PAGE = 1000; // the walk's page size, as the store uses

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmtMs = (ms: number) => (ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`);

// A small, realistic metadata distribution: a handful of types, a long-ish tail
// of topics and people, and one row in ten with no arrays at all — enough for
// the aggregation to do real work without being a stress test of its own.
const TYPES = ["note", "idea", "task", "decision", "question"];
const TOPICS = Array.from({ length: 40 }, (_, i) => `topic-${i}`);
const PEOPLE = Array.from({ length: 25 }, (_, i) => `person-${i}`);

async function load(sql: SQL, n: number): Promise<void> {
  const { rnd } = seededRandom(20260911 + n);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const B = 500;
  for (let i = 0; i < n; i += B) {
    const values = Array.from({ length: Math.min(B, n - i) }, (_, k) => {
      const bare = rnd() < 0.1;
      const meta = bare
        ? { type: pick(TYPES) }
        : { type: pick(TYPES), topics: [pick(TOPICS), pick(TOPICS)], people: [pick(PEOPLE)] };
      return `('row ${i + k}', '${JSON.stringify(meta).replace(/'/g, "''")}'::jsonb)`;
    }).join(",");
    await sql.unsafe(`INSERT INTO thoughts (content, metadata) VALUES ${values}`);
  }
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
}

/**
 * The page walk, faithful to store-postgrest.ts: page metadata newest-first and
 * tally in TS, null array elements skipped as that store does. The maps are
 * intentionally built and discarded — the point is to time the same work the
 * real walk pays for, which is what makes the comparison honest.
 */
async function walk(sql: SQL): Promise<{ ms: number; roundTrips: number }> {
  const t0 = performance.now();
  const types: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const people: Record<string, number> = {};
  let roundTrips = 0;
  for (let off = 0; ; off += PAGE) {
    const page = await sql`SELECT metadata FROM thoughts ORDER BY created_at DESC LIMIT ${PAGE}::int OFFSET ${off}::int`;
    roundTrips++;
    if (page.length === 0) break;
    for (const r of page) {
      const m = (r.metadata || {}) as Record<string, unknown>;
      if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
      if (Array.isArray(m.topics)) for (const t of m.topics) if (t != null) topics[t as string] = (topics[t as string] || 0) + 1;
      if (Array.isArray(m.people)) for (const p of m.people) if (p != null) people[p as string] = (people[p as string] || 0) + 1;
    }
    if (page.length < PAGE) break;
  }
  return { ms: performance.now() - t0, roundTrips };
}

type Row = { scale: number; fnMs: number; walkMs: number; roundTrips: number; plan: string };
const results: Row[] = [];

for (const scale of SCALES) {
  await resetSchema(URL_, OPTS);
  await applyMigrations(URL_, OPTS);
  const sql = new SQL({ url: URL_, max: 1 });
  try {
    await load(sql, scale);

    // Warm both paths once, then take the median of REPEATS.
    await sql`SELECT thought_stats_summary()`;
    await walk(sql);
    const fnTimes: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const t0 = performance.now();
      await sql`SELECT thought_stats_summary()`;
      fnTimes.push(performance.now() - t0);
    }
    const walkTimes: number[] = [];
    let roundTrips = 0;
    for (let i = 0; i < REPEATS; i++) {
      const w = await walk(sql);
      walkTimes.push(w.ms);
      roundTrips = w.roundTrips;
    }

    const plan = (await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT topic, count(*) FROM thoughts, ` +
        `jsonb_array_elements_text(CASE WHEN jsonb_typeof(metadata->'topics')='array' THEN metadata->'topics' ELSE '[]'::jsonb END) AS topic ` +
        `GROUP BY topic`
    )).map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");

    results.push({ scale, fnMs: median(fnTimes), walkMs: median(walkTimes), roundTrips, plan });
  } finally {
    await sql.close();
  }
}

console.log("\n### thought_stats_summary() vs the page walk (median of " + REPEATS + ")\n");
console.log("| rows | function | page walk | walk round trips | speedup |");
console.log("| ---: | ---: | ---: | ---: | ---: |");
for (const r of results) {
  console.log(`| ${r.scale.toLocaleString()} | ${fmtMs(r.fnMs)} | ${fmtMs(r.walkMs)} | ${r.roundTrips} | ${(r.walkMs / r.fnMs).toFixed(1)}× |`);
}

console.log("\n### The topic-unnest arm's plan (first node)\n");
for (const r of results) {
  console.log(`- ${r.scale.toLocaleString()} rows: ${r.plan.split("\n")[0].trim()}`);
}

if (PRINT_PLANS) {
  for (const r of results) {
    console.log(`\n#### ${r.scale.toLocaleString()} rows — topic unnest\n`);
    console.log(r.plan);
  }
}
console.log();
