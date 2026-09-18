#!/usr/bin/env bun
/**
 * eval-replay.ts — replay a query-log fixture (export-queries.ts, SMD-1295)
 * against the current schema and server code, and score the ranking real callers
 * would have got.
 *
 * export-queries.ts writes what the brain was actually asked — query text, the
 * ids the caller went on to touch (`relevant`, click-through relevance), and the
 * ranking the log recorded at the time (`baseline`). This re-runs each query
 * through the SHIPPED retrieval — search_thoughts_hybrid over the live corpus,
 * the same function the server calls — and reports:
 *
 *   • recall@k and MRR against `relevant` — did this code still surface the
 *     thoughts the caller opened?
 *   • rank drift against `baseline` — how far each relevant id moved from where
 *     the log last saw it, so a change that reorders the pool is visible even
 *     when recall@5 is unmoved.
 *
 * The output mirrors eval-real.ts's leaderboard so the numbers sit in the same
 * README table. This is the LOCAL, model-backed replay against your own brain;
 * the offline, model-free CI gate is db/test-replay.ts over committed vectors.
 *
 *   DATABASE_URL=postgres://… OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024 \
 *     bun evals/eval-replay.ts fixture.json
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { embed, parseSpec } from "./lib.ts";
import { parsePgUuidArray } from "./query-log.ts";

loadEnv();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  process.stderr.write("DATABASE_URL is not set — replay runs the fixture against the live corpus.\n");
  process.exit(2);
}
const FIXTURE = process.argv[2] ?? process.env.OB1_REPLAY_FIXTURE;
if (!FIXTURE) {
  process.stderr.write("Usage: bun evals/eval-replay.ts <fixture.json>  (from export-queries.ts)\n");
  process.exit(2);
}

const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:0.6b@1024";
const spec = parseSpec(EMBED_MODEL);
// A positive integer or the default — a stray value must not become a `LIMIT NaN`.
const rawSubk = Number.parseInt(String(process.env.OB1_REPLAY_SUBK ?? "").trim(), 10);
const SUBK = Number.isFinite(rawSubk) && rawSubk > 0 ? rawSubk : 20;
const KS = [1, 5, 10];

type FixtureQuery = { query: string; relevant: string[]; baseline: string[] };
type Fixture = { queries: FixtureQuery[] };
const fixture: Fixture = JSON.parse(await Bun.file(FIXTURE).text());
// Defensive: a fixture must carry arrays. Coerce a stray Postgres array literal
// ("{a,b}") so a rank lookup never char-scans a string — the one parser every
// reader of the log shares (evals/query-log.ts).
for (const q of fixture.queries ?? []) { q.relevant = parsePgUuidArray(q.relevant); q.baseline = parsePgUuidArray(q.baseline); }
const queries = (fixture.queries ?? []).filter((q) => q.relevant.length);
if (queries.length === 0) {
  process.stderr.write("The fixture has no query with a relevant id to score.\n");
  process.exit(2);
}

const sql = new SQL({ url: URL_, max: 4 });

/** The shipped ranking for a query: search_thoughts_hybrid at threshold −1 (so a
 *  row is returned whenever the corpus has one), top-SUBK, no filter. */
async function rankedIds(query: string): Promise<string[]> {
  const qv = await embed(EMBED_MODEL, query, true);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM search_thoughts_hybrid(${`[${qv.join(",")}]`}::vector, ${query}, ${-1}, ${SUBK}, '{}'::jsonb)`;
  return rows.map((r) => r.id);
}

let mrr = 0;
const recallAtK: Record<number, number> = Object.fromEntries(KS.map((k) => [k, 0]));
let driftSum = 0, driftN = 0;
let reachable = 0, reachableTotal = 0;
const misses: { query: string; rank: number | null }[] = [];
const t0 = Date.now();

for (const q of queries) {
  process.stderr.write(`  … ${q.query.slice(0, 60)}\n`);
  const ranked = await rankedIds(q.query);
  const rankOf = (id: string) => { const i = ranked.indexOf(id); return i < 0 ? null : i + 1; };
  const baseRankOf = (id: string) => { const i = q.baseline.indexOf(id); return i < 0 ? null : i + 1; };

  // How many of this query's relevant ids the current corpus can even return —
  // a fixture from another brain scores 0 not because the ranking regressed but
  // because the thoughts are absent. Reported so a 0 is not misread.
  const present = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM thoughts WHERE id = ANY(${`{${q.relevant.join(",")}}`}::uuid[])`;
  reachable += present[0].n; reachableTotal += q.relevant.length;

  // recall@k over distinct relevant ids; MRR from the best-ranked relevant id.
  let best: number | null = null;
  for (const k of KS) {
    const hit = q.relevant.filter((id) => { const r = rankOf(id); return r !== null && r <= k; }).length;
    recallAtK[k] += hit / q.relevant.length;
  }
  for (const id of q.relevant) {
    const r = rankOf(id);
    if (r !== null && (best === null || r < best)) best = r;
    const b = baseRankOf(id);
    if (r !== null && b !== null) { driftSum += Math.abs(r - b); driftN++; }
  }
  mrr += best ? 1 / best : 0;
  if (best === null || best > 5) misses.push({ query: q.query, rank: best });
}

const n = queries.length;
const seconds = (Date.now() - t0) / 1000;

console.log(`\n  ${n} replayed queries — shipped search_thoughts_hybrid over the live corpus (embed ${EMBED_MODEL}, top-${SUBK})\n`);
console.log("  fixture                         queries   R@1    R@5   R@10    MRR    drift    sec");
console.log("  " + "─".repeat(78));
console.log(
  `  ${FIXTURE.split("/").pop()!.padEnd(30).slice(0, 30)}  ${String(n).padStart(6)}   ` +
  `${((recallAtK[1] / n) * 100).toFixed(0).padStart(3)}%  ${((recallAtK[5] / n) * 100).toFixed(0).padStart(3)}%  ` +
  `${((recallAtK[10] / n) * 100).toFixed(0).padStart(3)}%  ${(mrr / n).toFixed(3)}  ` +
  `${(driftN ? driftSum / driftN : 0).toFixed(2).padStart(6)}  ${seconds.toFixed(1).padStart(6)}`,
);
console.log(
  `\n  reachable: ${reachable}/${reachableTotal} relevant ids exist in this corpus` +
  (reachable < reachableTotal ? " — a low count means the fixture is from a different brain, not a regression." : "") +
  `\n  drift: mean |rank now − rank in baseline| over ${driftN} relevant ids that appear in both.`,
);

if (misses.length) {
  console.log(`\n  ${misses.length} queries with no relevant id in the top 5:`);
  for (const m of misses.slice(0, 8)) console.log(`    ${m.rank === null ? "not returned" : `best rank ${m.rank}`}  "${m.query.slice(0, 56)}"`);
}

await sql.close();
