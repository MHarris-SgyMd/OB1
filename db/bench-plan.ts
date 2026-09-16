#!/usr/bin/env bun
/**
 * bench-plan.ts — does the unfiltered `match_thoughts` reach the HNSW index,
 * at the width this fork actually ships, measured rather than argued.
 *
 * SMD-969 (upstream NateBJones-Projects/OB1#469) reports that even the plain
 * `match_thoughts` shape gets `Seq Scan` + `Sort` at ~9,300 rows, and only
 * `SET LOCAL enable_seqscan = off` makes the planner take the index — 5.9 s
 * and ~30,000 buffers a call against 180 ms and ~3,200. This fork's function
 * has the more indexable shape (the threshold applied after the `ORDER BY <=>
 * LIMIT` candidate CTEs), which is an argument, and the fork's rule is that a
 * plan is measured, not inferred (SMD-925). db/bench-hnsw.ts explains only
 * the filtered branches, and at 64 dimensions; this explains the unfiltered
 * one at the shipped width, where the answer turns out to be different.
 *
 * One note on the filtered `exact` rows: since SMD-1018 the shared rewrite
 * (test-support's extractBody) splices the routing collection into the exact
 * branch as ONE materialized CTE, where it had spliced a scalar subquery per
 * `v_ids` reference — two InitPlans, two GIN collections per call. The exact
 * rows this bench prints therefore read one collection fewer than the lines
 * 019's header publishes ("5.4–6.5 ms for 936 matching rows at 100,000"),
 * and the difference is the harness's, not the function's: the function
 * always ran the collection once.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *
 * Per scale, the unfiltered branch's own statement — read from the catalog and
 * rewritten as a prepared statement, as bench-hnsw.ts section C does — at
 * match_count 10 (every first-party caller), 50 and 500 (the ceiling), under
 * `EXPLAIN (ANALYZE, BUFFERS)`, in four arms:
 *
 *   before      the function as 014 plans it: its one SET clause, the
 *               planner's own choice of scan.
 *   seqscan off the same with `enable_seqscan = off` — the remedy 019 adopts.
 *   rpc 1.1     the same with `random_page_cost = 1.1` — the cost-model remedy
 *               the ticket asked to weigh, shown for what it does and does not
 *               move.
 *   deployed    the deployed function's statement under its own SET clauses —
 *               020's since SMD-945, at weight 0 — custom and generic plan,
 *               which is what a call gets.
 *   deployed (w 0.3)  the same with recency_weight 0.3 — the candidate window
 *               is four times wider (16 * count), so this is what a caller who
 *               opts into the blend pays.
 *
 * For each: which node produced the `thoughts` CTE's rows and the chunk CTE's
 * rows, shared buffers touched, and execution time. The table prints TOAST
 * size beside heap size, because that ratio is the mechanism: at the shipped
 * width a vector is stored out of line, and the planner's seq-scan estimate
 * counts heap pages and never the detoast reads.
 *
 * Then the FILTERED statements, because the setting is function-wide and they
 * never read the vector column where the estimate goes wrong (first review
 * pass): the routing statement on the broadest filter (50%) and on one
 * matching nothing, the exact branch on 1%, and the walk on 50% where the
 * function routes it there — each under 014's settings and under 019's, custom
 * and generic plan, listing every scan node the plan took.
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *
 *   ./with-postgres.sh bun bench-plan.ts                      # 1,000 / 10,000 / 100,000 rows at EMBEDDING_DIM
 *   OB1_BENCH_SCALES=1000,10000 ./with-postgres.sh bun bench-plan.ts
 *   OB1_BENCH_DIM=64 ./with-postgres.sh bun bench-plan.ts    # the width bench-hnsw.ts runs at, for contrast
 *   ./with-postgres.sh bun bench-plan.ts --plans              # print the full plans
 *
 * The HNSW indexes are dropped for the load and built after it, as an operator
 * is told to do after a bulk load; at 1,024 dimensions the 100,000-row build
 * takes a few minutes. Vectors are random unit vectors; nothing here reads any
 * corpus.
 */

import { SQL } from "bun";
import { applyFunctionSettings, applyMigrations, explainPrepared, extractBody, loadChunkRows, matchThoughtsOid, requireDatabaseUrl, resetSchema, routingAt, seededRandom } from "./test-support.ts";
import type { Branch } from "./test-support.ts";
import { EMBEDDING_DIM } from "./config.mjs";

const URL_ = requireDatabaseUrl("bench-plan.ts");
const PRINT_PLANS = process.argv.includes("--plans");

const DIM = Number(process.env.OB1_BENCH_DIM ?? EMBEDDING_DIM);
const OPTS = { dim: DIM, model: "stub-embed" };
const SCALES = (process.env.OB1_BENCH_SCALES ?? "1000,10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
if (!Number.isInteger(DIM) || DIM < 1) {
  console.error(`OB1_BENCH_DIM must be a positive integer (got ${JSON.stringify(process.env.OB1_BENCH_DIM)})`);
  process.exit(2);
}
if (SCALES.length === 0) {
  console.error(`OB1_BENCH_SCALES must name at least one positive row count (got ${JSON.stringify(process.env.OB1_BENCH_SCALES)})`);
  process.exit(2);
}
/** match_count asked for: the default, a page, the function's ceiling. */
const COUNTS = [10, 50, 500];
/** One thought in five carries a chunk row, so the chunk CTE has rows to scan. */
const CHUNK_EVERY = 5;
/** Queries per cell; the median is reported. Plans are read from the last. */
const REPEATS = Number(process.env.OB1_BENCH_REPEATS ?? 5);

const lit = (v: number[]) => `[${v.join(",")}]`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmtMs = (ms: number) => (ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`);

// ── Data ─────────────────────────────────────────────────────────────────────

/** The two HNSW indexes the schema declares, by name; their definitions are read from the catalog. */
const HNSW_INDEXES = ["thoughts_embedding_idx", "thought_chunks_embedding_idx"];

async function load(sql: SQL, n: number): Promise<{ loadMs: number; buildMs: number; queries: number[][] }> {
  const { rnd, unitVector } = seededRandom(20260908 + n);
  // Drop the HNSW indexes for the load and build them after it, with the
  // schema's own definitions. Inserting 1,024-wide vectors into a live HNSW
  // index runs at tens of rows a second by 40,000 rows — the first run of this
  // bench was at 38,000 of 100,000 after ten minutes — where a bulk build takes
  // a few. It is also what db/README.md tells an operator to do after a bulk
  // load, so the index measured is the one a migrated brain has.
  const defs = (await sql.unsafe(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN (${HNSW_INDEXES.map((n) => `'${n}'`).join(", ")})`)) as { indexname: string; indexdef: string }[];
  if (defs.length !== HNSW_INDEXES.length) throw new Error(`expected ${HNSW_INDEXES.join(" and ")} in pg_indexes, found ${defs.map((d) => d.indexname).join(", ") || "none"}`);
  for (const d of defs) await sql.unsafe(`DROP INDEX ${d.indexname}`);
  const t0 = performance.now();
  const B = 200;
  for (let i = 0; i < n; i += B) {
    const values = Array.from({ length: Math.min(B, n - i) }, (_, k) => {
      // Nested tiers, as bench-hnsw.ts plants them: a row in t1 is also in t50.
      const r = rnd();
      const tiers = r < 0.01 ? '["t50","t1"]' : r < 0.5 ? '["t50"]' : "[]";
      return `('row ${i + k}', '{"tiers": ${tiers}}'::jsonb, '${lit(unitVector(DIM))}'::vector)`;
    }).join(",");
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  await loadChunkRows(sql, CHUNK_EVERY);
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  for (const d of defs) await sql.unsafe(d.indexdef);
  const buildMs = performance.now() - t1;
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
  const queries = Array.from({ length: REPEATS }, () => unitVector(DIM));
  return { loadMs, buildMs, queries };
}

async function sizes(sql: SQL): Promise<{ storage: string; heap: string; toast: string; index: string; chunkHeap: string; chunkToast: string }> {
  const [r] = await sql.unsafe(`
    SELECT (SELECT typstorage FROM pg_type WHERE typname = 'vector') AS storage,
           pg_size_pretty(pg_relation_size('thoughts')) AS heap,
           pg_size_pretty(pg_total_relation_size('thoughts') - pg_relation_size('thoughts') - pg_indexes_size('thoughts')) AS toast,
           pg_size_pretty(pg_relation_size('thoughts_embedding_idx')) AS index,
           pg_size_pretty(pg_relation_size('thought_chunks')) AS chunk_heap,
           pg_size_pretty(pg_total_relation_size('thought_chunks') - pg_relation_size('thought_chunks') - pg_indexes_size('thought_chunks')) AS chunk_toast`);
  return { storage: r.storage, heap: r.heap, toast: r.toast, index: r.index, chunkHeap: r.chunk_heap, chunkToast: r.chunk_toast };
}

// ── The measurement ──────────────────────────────────────────────────────────

type Arm = "before (014)" | "seqscan off" | "rpc 1.1" | "deployed (w 0) custom" | "deployed (w 0) generic" | "deployed (w 0.3)";
/**
 * What each arm sets before the statement is explained. The "before" arms
 * carry 014's one SET clause — the function before 019 — plus the arm's own
 * variable; the "after" arms carry whatever the deployed function declares.
 * The recency arm (020) is the same statement with a weight, which widens the
 * candidate window fourfold: what an opted-in caller pays, at each scale.
 */
const ARMS: Record<Arm, { settings: "014" | "function"; extra?: string; mode: "force_custom_plan" | "force_generic_plan"; weight?: number }> = {
  "before (014)": { settings: "014", mode: "force_custom_plan" },
  "seqscan off": { settings: "014", extra: "SET LOCAL enable_seqscan = off", mode: "force_custom_plan" },
  "rpc 1.1": { settings: "014", extra: "SET LOCAL random_page_cost = 1.1", mode: "force_custom_plan" },
  "deployed (w 0) custom": { settings: "function", mode: "force_custom_plan" },
  "deployed (w 0) generic": { settings: "function", mode: "force_generic_plan" },
  "deployed (w 0.3)": { settings: "function", mode: "force_custom_plan", weight: 0.3 },
};
type Cell = { scale: number; count: number; arm: Arm; thoughts: string; chunks: string; buffers: number; ms: number; text: string };

/** Which node produced a CTE's rows, by table. The chunk CTE's alias is `c`, the direct one's `t`. */
function nodeFor(plan: string, table: "thoughts" | "thought_chunks"): string {
  const alias = table === "thoughts" ? "t" : "c";
  const idx = table === "thoughts" ? "thoughts_embedding_idx" : "thought_chunks_embedding_idx";
  if (new RegExp(`Index Scan using ${idx} on ${table} ${alias}(?:_\\d+)?\\b`).test(plan)) return "Index Scan";
  if (new RegExp(`Seq Scan on ${table} ${alias}(?:_\\d+)?\\b`).test(plan)) return "Seq Scan";
  return "?";
}

async function explain(sql: SQL, body: string, q: number[], count: number, arm: Arm, scale: number): Promise<Cell> {
  const a = ARMS[arm];
  const r = await sql.begin(async (tx: SQL) => {
    if (a.settings === "function") await applyFunctionSettings(tx);
    else await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    if (a.extra) await tx.unsafe(a.extra);
    return explainPrepared(tx, { body, dim: DIM, args: `'${lit(q)}'::vector, -1.0, ${count}, '{}'::jsonb, ${a.weight ?? 0}, 90.0`, mode: a.mode, warm: true });
  });
  return { scale, count, arm, thoughts: nodeFor(r.text, "thoughts"), chunks: nodeFor(r.text, "thought_chunks"), buffers: r.buffers, ms: r.ms, text: r.text };
}

async function measure(sql: SQL, body: string, queries: number[][], count: number, arm: Arm, scale: number): Promise<Cell> {
  const cells: Cell[] = [];
  for (const q of queries) cells.push(await explain(sql, body, q, count, arm, scale));
  const ms = median(cells.map((c) => c.ms));
  const last = cells[cells.length - 1];
  // Plans are read from every repeat; a cell whose node changed between
  // queries is reported as such rather than as whichever came last.
  const same = (k: "thoughts" | "chunks") => (cells.every((c) => c[k] === last[k]) ? last[k] : `${cells.map((c) => c[k]).join("/")}`);
  return { ...last, ms, thoughts: same("thoughts"), chunks: same("chunks"), buffers: Math.round(median(cells.map((c) => c.buffers))) };
}

// ── The filtered statements ──────────────────────────────────────────────────

type FilteredCell = { scale: number; branch: Branch; filter: string; matches: number; arm: "before (014)" | "deployed"; mode: "custom" | "generic"; scans: string; buffers: number; ms: number };

/** Every scan node in the plan, in order, deduplicated — the answer to "what did the setting change". */
function scansOf(plan: string): string {
  const seen = new Set<string>();
  for (const m of plan.matchAll(/(Seq Scan|Index Scan using \w+|Index Only Scan using \w+|Bitmap Heap Scan|Bitmap Index Scan on \w+) (?:on (\w+) (\w+)\b)?/g)) {
    seen.add(m[2] ? `${m[1]} on ${m[2]} ${m[3]}` : m[1]);
  }
  return [...seen].map((x) => x.replace("Index Scan using ", "").replace("Index Only Scan using ", "only ").replace("Bitmap Index Scan on ", "bitmap ").replace("Bitmap Heap Scan on", "bitmap heap").replace("Seq Scan on", "SEQ")).join("; ");
}

async function explainFiltered(sql: SQL, body: string, branch: Branch, filter: string, matches: number, q: number[], arm: FilteredCell["arm"], mode: FilteredCell["mode"], scale: number): Promise<FilteredCell> {
  const r = await sql.begin(async (tx: SQL) => {
    if (arm === "deployed") await applyFunctionSettings(tx);
    else await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return explainPrepared(tx, { body, dim: DIM, args: `'${lit(q)}'::vector, -1.0, 10, '${filter}'::jsonb, 0.0, 90.0`, mode: `force_${mode}_plan`, warm: true });
  });
  return { scale, branch, filter, matches, arm, mode, scans: scansOf(r.text), buffers: r.buffers, ms: r.ms };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const results: Cell[] = [];
const filteredResults: FilteredCell[] = [];
const loads: { scale: number; loadMs: number; buildMs: number; sizes: Awaited<ReturnType<typeof sizes>> }[] = [];
let banner = false;

for (const n of SCALES) {
  console.log(`▸ ${n.toLocaleString()} rows at ${DIM} dimensions — loading`);
  await resetSchema(URL_, { ...OPTS, only: (f) => f < "019" });
  let sql = new SQL({ url: URL_, max: 1 });
  if (!banner) {
    const [{ extversion }] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    const [{ v }] = await sql`SELECT version() AS v`;
    const [{ rpc }] = await sql`SELECT current_setting('random_page_cost') AS rpc`;
    console.log(`  ${String(v).split(" on ")[0]}, pgvector ${extversion}, random_page_cost ${rpc}, ${REPEATS} queries per cell`);
    banner = true;
  }
  const { loadMs, buildMs, queries } = await load(sql, n);
  const sz = await sizes(sql);
  loads.push({ scale: n, loadMs, buildMs, sizes: sz });
  console.log(`  loaded in ${fmtMs(loadMs)}, HNSW built in ${fmtMs(buildMs)}; thoughts heap ${sz.heap}, TOAST ${sz.toast}, HNSW ${sz.index}; chunk heap ${sz.chunkHeap}, TOAST ${sz.chunkToast}; vector storage '${sz.storage}'`);

  // The function 014 shipped, explained as it plans, then the two remedies.
  const body014 = await extractBody(sql, "unfiltered", DIM);
  // The candidate CTEs, from prosrc BEFORE the locals are inlined: 020 widens
  // v_fetch under a weight and changed the final SELECT, so the substituted
  // statements differ where the scan does not. What must be the same text is
  // the three `WITH direct … GROUP BY u.tid` blocks (db/test-schema.ts [20]
  // holds the same comparison).
  const cteBlocks = async () => {
    const [{ src }] = await sql.unsafe(`SELECT prosrc AS src FROM pg_proc WHERE oid = $1::oid`, [await matchThoughtsOid(sql)]);
    return [...String(src).matchAll(/WITH direct AS \([\s\S]*?GROUP BY u\.tid\s*\)/g)].map((m) => m[0]).join("\n---\n");
  };
  const ctes014 = await cteBlocks();
  for (const arm of ["before (014)", "seqscan off", "rpc 1.1"] as Arm[]) {
    process.stdout.write(`  ${arm.padEnd(24)}`);
    for (const count of COUNTS) {
      results.push(await measure(sql, body014, queries, count, arm, n));
      process.stdout.write(".");
    }
    console.log(" done");
  }

  // The filtered statements, on the filters the function routes to each:
  // the routing statement on the broadest filter and on one matching nothing,
  // the exact branch on 1% where that is under the 1,000-row threshold, the
  // walk on 50% where that exceeds it — each gated on the count the function
  // itself would route on, so a scale where 1% is 1,100 rows does not explain
  // a branch the function never takes for that filter (second review pass).
  // Under 014's settings now, under 019's after it is applied.
  const [{ m50, m1 }] = await sql.unsafe(`SELECT count(*) FILTER (WHERE metadata @> '{"tiers": ["t50"]}')::int AS m50, count(*) FILTER (WHERE metadata @> '{"tiers": ["t1"]}')::int AS m1 FROM thoughts`);
  // The threshold is the deployed function's at the default count, evaluated
  // by the server (test-support's routingAt) — read per ARM, since the arms
  // hold different bodies and a redefinition that moves the floor (SMD-1464)
  // must route the deployed arm by its own (third review pass of SMD-1018).
  const casesFor = async (): Promise<{ branch: Branch; filter: string; matches: number }[]> => {
    const { vExact } = await routingAt(sql, 10);
    return [
      { branch: "route", filter: '{"tiers": ["t50"]}', matches: Number(m50) },
      { branch: "route", filter: '{"tiers": ["none"]}', matches: 0 },
      ...(Number(m1) <= vExact ? [{ branch: "exact" as Branch, filter: '{"tiers": ["t1"]}', matches: Number(m1) }] : []),
      ...(Number(m50) > vExact ? [{ branch: "walk" as Branch, filter: '{"tiers": ["t50"]}', matches: Number(m50) }] : []),
    ];
  };
  const runFiltered = async (arm: FilteredCell["arm"]) => {
    const filteredCases = await casesFor();
    process.stdout.write(`  filtered, ${arm.padEnd(12)}`);
    // The statements change only when the function does — once, between the
    // arms — so each branch is read from the catalog once per arm.
    const bodies = new Map<Branch, string>();
    for (const c of filteredCases) if (!bodies.has(c.branch)) bodies.set(c.branch, await extractBody(sql, c.branch, DIM));
    for (const c of filteredCases) {
      for (const mode of ["custom", "generic"] as const) {
        const cells: FilteredCell[] = [];
        for (const q of queries) cells.push(await explainFiltered(sql, bodies.get(c.branch)!, c.branch, c.filter, c.matches, q, arm, mode, n));
        const last = cells[cells.length - 1];
        const scans = cells.every((x) => x.scans === last.scans) ? last.scans : cells.map((x) => x.scans).join(" | ");
        filteredResults.push({ ...last, scans, ms: median(cells.map((x) => x.ms)), buffers: Math.round(median(cells.map((x) => x.buffers))) });
        process.stdout.write(".");
      }
    }
    console.log(" done");
  };
  await runFiltered("before (014)");

  // 019, onto the same rows. Its statement is read from the catalog again: it
  // candidate CTEs should be 014's byte for byte (db/test-schema.ts [20]
  // asserts it), and the bench refuses to assume so; the final SELECT differs
  // since 020 (the blend, the id tiebreak), which is not what this bench times
  // the cost of.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "019" });
  await sql.close();
  sql = new SQL({ url: URL_, max: 1 });
  const body019 = await extractBody(sql, "unfiltered", DIM);
  if (!ctes014 || (await cteBlocks()) !== ctes014) throw new Error("the deployed candidate CTEs differ from 014's; the before/after comparison is not of the same scan");
  for (const arm of ["deployed (w 0) custom", "deployed (w 0) generic", "deployed (w 0.3)"] as Arm[]) {
    process.stdout.write(`  ${arm.padEnd(24)}`);
    for (const count of COUNTS) {
      results.push(await measure(sql, body019, queries, count, arm, n));
      process.stdout.write(".");
    }
    console.log(" done");
  }
  await runFiltered("deployed");
  await sql.close();
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n### The unfiltered branch of match_thoughts, ${DIM} dimensions, ${REPEATS} random queries per cell (median)\n`);
console.log("Node is the one that produced each candidate CTE's rows. Buffers are shared buffers read by the whole statement, warm.\n");
console.log("| rows | heap / TOAST | count | arm | thoughts CTE | chunk CTE | buffers | exec |");
console.log("| ---: | --- | ---: | --- | --- | --- | ---: | ---: |");
for (const r of results) {
  const l = loads.find((x) => x.scale === r.scale)!;
  console.log(`| ${r.scale.toLocaleString()} | ${l.sizes.heap} / ${l.sizes.toast} | ${r.count} | ${r.arm} | ${r.thoughts} | ${r.chunks} | ${r.buffers.toLocaleString()} | ${fmtMs(r.ms)} |`);
}
console.log(`\n### The filtered statements under 014's settings and under 019's (custom / generic plan)\n`);
console.log("Every scan node the plan took, in order. `route` is the capped id collection every filtered call runs first; `exact` scores the collected ids; `walk` is the HNSW scan with the predicate inside it.\n");
console.log("| rows | statement | filter | matching | arm | plan | scans | buffers | exec |");
console.log("| ---: | --- | --- | ---: | --- | --- | --- | ---: | ---: |");
for (const f of filteredResults) {
  console.log(`| ${f.scale.toLocaleString()} | ${f.branch} | ${f.filter.replace(/.*\["(\w+)"\].*/, "$1")} | ${f.matches.toLocaleString()} | ${f.arm} | ${f.mode} | ${f.scans} | ${f.buffers.toLocaleString()} | ${fmtMs(f.ms)} |`);
}

console.log("\n| rows | load | HNSW build | thoughts heap | thoughts TOAST | HNSW | chunk heap | chunk TOAST |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const l of loads) {
  console.log(`| ${l.scale.toLocaleString()} | ${fmtMs(l.loadMs)} | ${fmtMs(l.buildMs)} | ${l.sizes.heap} | ${l.sizes.toast} | ${l.sizes.index} | ${l.sizes.chunkHeap} | ${l.sizes.chunkToast} |`);
}

if (PRINT_PLANS) {
  for (const r of results) {
    console.log(`\n#### ${r.scale.toLocaleString()} rows, count ${r.count}, ${r.arm}\n`);
    console.log(r.text.replace(/\[[-\d.,e]+\]'::vector/g, "[…]'::vector"));
  }
}
console.log();
