#!/usr/bin/env bun
/**
 * bench-hybrid.ts — does `search_thoughts_hybrid` reach both indexes, and what
 * does the fusion cost over its two arms called on their own?
 *
 *   ./with-postgres.sh bun bench-hybrid.ts
 *   OB1_BENCH_SCALES=10000,100000 ./with-postgres.sh bun bench-hybrid.ts
 *
 * Migration 017's function calls `match_thoughts` and `search_thoughts_keyword`
 * rather than inlining either, and its header claims their access paths — HNSW
 * with the filter inside the scan, the trigram bitmap through an escaped
 * pattern — are inherited. That is an argument about plpgsql calling plpgsql,
 * and the ticket (SMD-958) asks for the regression it would hide to be checked
 * directly: either arm degrading into a full scan when reached through the
 * wrapper.
 *
 * ── How the access path is established ───────────────────────────────────────
 * Not by EXPLAIN. As bench-keyword.ts explains, EXPLAIN of a plpgsql function
 * shows a Function Scan and nothing inside it. `pg_stat_user_indexes.idx_scan`
 * for each index is read before and after the calls; a delta of one per call is
 * direct evidence that the index served the query THE FUNCTION ran. Thirteen
 * calls rather than one, because plpgsql may switch a statement to a generic
 * plan after five executions and a generic plan built without the pattern could
 * choose differently — the probe 012's benchmark established.
 *
 * ── The control ──────────────────────────────────────────────────────────────
 * Five rows carry the identifier, five carry a decoy that only an UNESCAPED
 * pattern matches (`resolve-agent-zylotrope` for `resolve_agent_zylotrope`).
 * The fused result must put exactly the five marked rows first, each saying
 * which needle it matched, and no decoy row may claim a match. If that fails the
 * script refuses to print timings, because a faster wrong query is not a result.
 *
 * ── What is timed ────────────────────────────────────────────────────────────
 * Median wall clock including the client round trip, first call discarded:
 * the fused function; each arm as the function calls it; and the fused
 * function on a query with NO needle, which is what every ordinary semantic
 * search now pays — the needle rule, the stopword test, and the wrapper around
 * match_thoughts — against match_thoughts called directly.
 *
 * The first run of this bench found the wrapper cost 15 ms where its arms cost
 * 1.3 together: the planner's estimate for the fused query was three orders of
 * magnitude high (it cannot see into a plpgsql function and assumes 1,000 rows
 * from each), which crossed `jit_above_cost`, and PostgreSQL JIT-compiled 112
 * expressions on every call. auto_explain with nested statements showed it —
 * "Functions: 112" under the RETURN QUERY — and nothing at the SQL level did.
 * The function no longer joins `thoughts` and runs with `jit = off`; the
 * migration header records the finding, and this bench is what would catch it
 * coming back.
 */

import { SQL } from "bun";
import { requireDatabaseUrl, resetSchema, seededRandom } from "./test-support.ts";

const URL_ = requireDatabaseUrl("bench-hybrid.ts");
const DIM = 64;
const SCALES = (process.env.OB1_BENCH_SCALES ?? "10000").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
if (!SCALES.length) { console.error("OB1_BENCH_SCALES must name at least one positive row count"); process.exit(2); }
const REPEATS = 7;
const PROBE_CALLS = 13;
const IDENT = "resolve_agent_zylotrope";
const DECOY = "resolve-agent-zylotrope";
const MARKED = 5;

const WORDS = (
  "the a of to and in that for on with as by from at an is was are were be been " +
  "migration schema index query planner vector embedding thought capture retrieval " +
  "postgres cluster deploy runtime provider chunk audit agent identity keyword"
).split(" ");

const lit = (v: number[]) => `[${v.join(",")}]`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (ms: number) => (ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`);

async function load(sql: SQL, n: number): Promise<number[]> {
  const { rnd, unitVector } = seededRandom(20260907 + n);
  const B = 500;
  for (let i = 0; i < n; i += B) {
    const values: string[] = [];
    for (let j = i; j < Math.min(i + B, n); j++) {
      const words: string[] = [];
      for (let w = 0; w < 40; w++) words.push(WORDS[Math.floor(rnd() * WORDS.length)]);
      if (j < MARKED) words.splice(10, 0, IDENT);
      else if (j < MARKED * 2) words.splice(10, 0, DECOY);
      values.push(`('${words.join(" ")}', '{"doc":${j}}'::jsonb, '${lit(unitVector(DIM))}'::vector)`);
    }
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values.join(",")}`);
  }
  await sql.unsafe("VACUUM ANALYZE thoughts");
  return unitVector(DIM); // the query vector: drawn after every row, so it coincides with none
}

async function indexScans(sql: SQL, index: string): Promise<number> {
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const r = await sql`SELECT coalesce(sum(idx_scan), 0)::bigint AS n FROM pg_stat_user_indexes WHERE indexrelname = ${index}`;
  return Number(r[0].n);
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const ms: number[] = [];
  for (let i = 0; i < REPEATS; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return median(ms);
}

for (const n of SCALES) {
  console.log(`\n  ${n.toLocaleString()} rows, ${DIM} dimensions, ${MARKED} rows carry ${IDENT}, ${MARKED} carry the decoy ${DECOY}`);
  await resetSchema(URL_, { dim: DIM, model: "stub-embed", trgm: true });
  const sql = new SQL({ url: URL_, max: 1 });
  const q = lit(await load(sql, n));
  const text = `the scheduler timeout around ${IDENT}`;
  const hybrid = () => sql`SELECT content, matched_needles FROM search_thoughts_hybrid(${q}::vector, ${text}, 0.0, 10, '{}'::jsonb)`;

  // ── Control ────────────────────────────────────────────────────────────────
  // The query has content words, so the vector arm keeps its vote: its rank-1
  // row ties the exact hits on score and wins the tie on similarity (017's
  // header). The five marked rows therefore occupy positions 1–6 with at most
  // one vector-only row among them, every one of them names the needle, and no
  // decoy row claims a match — anything else and the timings are not printed.
  const rows = (await hybrid()) as { content: string; matched_needles: string[] }[];
  const shape = rows.map((r) => (r.content.includes(IDENT) ? "marked" : r.content.includes(DECOY) ? "DECOY" : "other"));
  const marked = rows.filter((r) => r.content.includes(IDENT));
  const claimed = rows.filter((r) => r.matched_needles.length);
  const ok = marked.length === MARKED && claimed.length === MARKED
    && marked.every((r) => r.matched_needles.join() === IDENT)
    && shape.slice(0, MARKED + 1).filter((s) => s === "marked").length === MARKED
    && !shape.includes("DECOY");
  if (!ok) {
    console.error(`  the fused result is wrong: ${marked.length} marked rows returned, ${claimed.length} rows claim a match, order ${shape.join(", ")} — refusing to time it`);
    await sql.close();
    process.exit(1);
  }
  console.log(`  control: the ${MARKED} marked rows are within the first ${MARKED + 1} (order ${shape.slice(0, MARKED + 1).join(", ")}), each matched on the needle; no decoy row claims a match`);

  // ── Index reach ────────────────────────────────────────────────────────────
  const before = { hnsw: await indexScans(sql, "thoughts_embedding_idx"), trgm: await indexScans(sql, "idx_thoughts_content_trgm") };
  for (let i = 0; i < PROBE_CALLS; i++) await hybrid();
  const after = { hnsw: await indexScans(sql, "thoughts_embedding_idx"), trgm: await indexScans(sql, "idx_thoughts_content_trgm") };
  const dh = after.hnsw - before.hnsw, dt = after.trgm - before.trgm;
  console.log(`  index reach over ${PROBE_CALLS} calls (idx_scan deltas): HNSW ${dh}, trigram ${dt}${dh >= PROBE_CALLS ? "" : "  ← the vector arm did not use its index on every call"}${dt >= PROBE_CALLS ? "" : "  ← the keyword arm did not use its index on every call"}`);

  // ── Cost ───────────────────────────────────────────────────────────────────
  const tHybrid = await time(hybrid);
  // The arms exactly as the function calls them: the vector arm at N with no
  // threshold, the keyword arm's full page.
  const tVector = await time(() => sql`SELECT id FROM match_thoughts(${q}::vector, -1.0, 10, '{}'::jsonb)`);
  const tKeyword = await time(() => sql`SELECT id FROM search_thoughts_keyword(${IDENT}, 100, 0, '{}'::jsonb)`);
  const plain = "what happened with the scheduler";
  const tHybridPlain = await time(() => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 10, '{}'::jsonb)`);
  const tVectorPlain = await time(() => sql`SELECT id FROM match_thoughts(${q}::vector, 0.5, 10, '{}'::jsonb)`);
  console.log(`\n  median of ${REPEATS}, wall clock with the round trip:\n`);
  console.log(`    fused, one needle                       ${fmt(tHybrid).padStart(9)}`);
  console.log(`      match_thoughts(-1, 10) on its own     ${fmt(tVector).padStart(9)}`);
  console.log(`      search_thoughts_keyword(needle, 100)  ${fmt(tKeyword).padStart(9)}`);
  console.log(`      fusion overhead over the two arms     ${fmt(tHybrid - tVector - tKeyword).padStart(9)}`);
  console.log(`    fused, no needle (every ordinary query) ${fmt(tHybridPlain).padStart(9)}`);
  console.log(`      match_thoughts(0.5, 10) on its own    ${fmt(tVectorPlain).padStart(9)}`);
  console.log(`      wrapper overhead                      ${fmt(tHybridPlain - tVectorPlain).padStart(9)}`);
  await sql.close();
}
console.log("");
