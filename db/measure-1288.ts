#!/usr/bin/env bun
/**
 * measure-1288.ts — the "measure first" evidence for SMD-1288.
 *
 * trace_provenance (025) walked the derived_from chain with a per-path recursive
 * CTE; on a dense DAG the UNION ALL materialised ~fanout^depth PATHS before the
 * outer LIMIT could trim. 026 replaces it with a walk-global breadth-first walk
 * that expands each node once (linear in the reachable graph, not fanout^depth).
 * This script builds one dense, cycle-free DAG and times the OLD body against the
 * NEW one on it, so the header's
 * before/after is a measurement, not a claim. It is not part of ci-parity (it
 * needs a real Postgres and deliberately provokes a timeout), the same standing
 * as bench-plan.ts.
 *
 *   ./with-postgres.sh bun measure-1288.ts
 *   DATABASE_URL=... bun measure-1288.ts
 */
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIM } from "./config.mjs";
import { dropSchema, runMigrator } from "./test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Use ./with-postgres.sh bun measure-1288.ts");
  process.exit(2);
}

const subst = (sql: string) => sql.replace(/\{\{EMBEDDING_DIM\}\}/g, String(EMBEDDING_DIM));
const file = (name: string) => subst(readFileSync(join(HERE, "migrations", name), "utf8"));
// The trace_provenance definition out of a migration file, so 025's old body and
// 026's new one can be applied in turn. Anchored (^ / m) like test-schema's
// lastDefinerOf, so a header comment quoting the CREATE line can't be matched.
const traceDef = (name: string) => file(name).match(/^CREATE OR REPLACE FUNCTION trace_provenance[\s\S]*?\$\$;/m)![0];
const unit = (i: number) => { const v = new Array(EMBEDDING_DIM).fill(0); v[i % EMBEDDING_DIM] = 1; return "[" + v.join(",") + "]"; };

await dropSchema(URL_);
await runMigrator(URL_, undefined);
const sql = new SQL({ url: URL_, max: 1 });

// Build a dense, cycle-free DAG: WIDTH nodes per layer for DEPTH layers, each
// node deriving from EVERY node of the next-deeper layer, plus one root deriving
// from all of layer 1. Root→depth-d paths = WIDTH^d; distinct nodes = WIDTH*DEPTH+1.
// Bottom-up, because upsert_thought validates that every derived_from element
// already exists.
async function buildDag(width: number, depth: number): Promise<{ root: string; nodes: number }> {
  await sql`DELETE FROM thoughts`;
  let i = 0;
  const cap = async (content: string, derived?: string[]): Promise<string> => {
    const env: Record<string, unknown> = { metadata: { type: "synthesis" } };
    if (derived) env.derived_from = derived;
    const r = (await sql`SELECT upsert_thought(${content}, ${env}::jsonb, ${unit(i++)}::vector) AS r`)[0].r as { id: string };
    return r.id;
  };
  let deeper: string[] = [];
  for (let layer = depth; layer >= 1; layer--) {
    const here: string[] = [];
    for (let w = 0; w < width; w++) here.push(await cap(`dag L${layer} n${w} (${Math.random()})`, deeper.length ? deeper : undefined));
    deeper = here;
  }
  const root = await cap(`dag root (${Math.random()})`, deeper);
  return { root, nodes: width * depth + 1 };
}

async function timeCall(root: string, depth: number, timeoutMs: number): Promise<{ ms: number; rows: number | null; timedOut: boolean }> {
  const conn = new SQL({ url: URL_, max: 1 });
  try {
    await conn.unsafe(`SET statement_timeout = ${Number(timeoutMs)}`);
    const t0 = performance.now();
    try {
      const rows = await conn`SELECT count(*)::int AS c FROM trace_provenance(${root}::uuid, ${depth}, 250)`;
      return { ms: performance.now() - t0, rows: Number(rows[0].c), timedOut: false };
    } catch (e) {
      if (/statement timeout|canceling statement/i.test((e as Error).message)) return { ms: performance.now() - t0, rows: null, timedOut: true };
      throw e;
    }
  } finally {
    await conn.close();
  }
}

const cases = [
  { width: 4, depth: 8 },   // 4^8   =    65,536 paths / 33 nodes — old completes, slowly
  { width: 6, depth: 10 },  // 6^10  ~ 60,000,000 paths / 61 nodes — old cannot
];

for (const c of cases) {
  const { root, nodes } = await buildDag(c.width, c.depth);
  const paths = Math.pow(c.width, c.depth);
  console.log(`\n=== dense DAG: width ${c.width}, depth ${c.depth} — ${nodes} distinct nodes, ~${paths.toLocaleString()} root→leaf paths ===`);

  // NEW (026 is what migrate applied).
  const neu = await timeCall(root, c.depth, 20000);
  console.log(`NEW (026 walk-global BFS): ${neu.timedOut ? "TIMED OUT" : neu.ms.toFixed(1) + " ms"}, returned ${neu.rows} rows`);

  // OLD: re-apply 025's trace_provenance body (CREATE OR REPLACE) to get the
  // per-path recursive CTE back, measure, then restore 026.
  await sql.unsafe(traceDef("025_thought_provenance.sql"));
  const old = await timeCall(root, c.depth, 20000);
  console.log(`OLD (025 per-path CTE):    ${old.timedOut ? "TIMED OUT (killed at 20 s)" : old.ms.toFixed(1) + " ms"}, returned ${old.rows === null ? "—" : old.rows} rows`);
  await sql.unsafe(traceDef("026_trace_provenance_bounded.sql"));

  if (!neu.timedOut && !old.timedOut && old.rows !== null) {
    console.log(`ratio: OLD/NEW ≈ ${(old.ms / Math.max(neu.ms, 0.01)).toFixed(0)}×; both returned ${neu.rows === old.rows ? "the SAME " + neu.rows + " nodes" : "DIFFERENT counts (" + old.rows + " vs " + neu.rows + ")"}`);
  }
}

await sql.close();
console.log("\ndone.");
