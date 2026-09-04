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
 * as shipped by migrations 001–013, applies 014 on top of the SAME rows, and
 * asks again.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *
 *   A. Unfiltered row count at match_count 10 / 20 / 50 / 100 — requested
 *      against returned. The overfetch cap shows up here as "asked 50, got 40".
 *
 *   B. Filtered overlap. For each selectivity (a `tier` key planted at 50%,
 *      10%, 1% and 0.1% of rows) and Q random query vectors: how many rows came
 *      back of the 10 asked for, how many of those the EXACT top-10 within the
 *      filter also contains, and how often the result was empty. The oracle is
 *      the same scoring (MAX over a thought's own vector and its chunks) with
 *      index scans disabled, so it is exact by construction and shares no code
 *      with the function under test.
 *
 *      The queries are RANDOM vectors, not perturbed copies of a target. A
 *      perturbed copy makes the target the global nearest neighbour, which no
 *      filter can lose — the first draft of this bench did exactly that and
 *      reported 50/50 recall for a function that returns nothing at 1%.
 *
 *   C. Plan shape. The live function body is read from the catalog
 *      (`pg_get_functiondef`), its plpgsql variables rewritten as parameters,
 *      and the result PREPAREd and EXPLAINed under both a custom and a generic
 *      plan — plpgsql may use either. That inspects the SQL actually deployed
 *      rather than a copy of it kept here, and it fails loudly if the function
 *      no longer has the shape the rewrite expects.
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *
 *   ./with-postgres.sh bun bench-hnsw.ts
 *   OB1_BENCH_SCALES=1000,10000,100000 ./with-postgres.sh bun bench-hnsw.ts
 *   ./with-postgres.sh bun bench-hnsw.ts --plans     # print the full plans
 *
 * Vectors are 64-wide random unit vectors: wide enough that HNSW behaves like
 * HNSW, narrow enough that a 100,000-row index builds in a minute. Nothing here
 * reads any corpus, so nothing sensitive is involved.
 */

import { SQL } from "bun";
import { applyMigrations, requireDatabaseUrl, resetSchema } from "./test-support.ts";

const URL_ = requireDatabaseUrl("bench-hnsw.ts");
const PRINT_PLANS = process.argv.includes("--plans");

const DIM = 64;
const OPTS = { dim: DIM, model: "stub-embed" };
const SCALES = (process.env.OB1_BENCH_SCALES ?? "1000,10000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** Random queries per selectivity. */
const Q = Number(process.env.OB1_BENCH_QUERIES ?? 100);
/** Result size for the filtered arm. The server's default is 10. */
const K = 10;
/** Share of thoughts that also get chunk rows, so the chunk CTE is exercised. */
const CHUNKED_SHARE = 0.2;
const CHUNKS_PER = 2;

/**
 * Planted selectivities. `tier` is one key so a filter is one containment
 * test, the same shape `search_thoughts` sends for `{"type": "decision"}`.
 * The tiers nest (a row in t01 is also in t1, t10, t50) so every selectivity
 * is a superset of the next and the comparison is between filter sizes only.
 */
const TIERS: { key: string; share: number }[] = [
  { key: "t50", share: 0.5 },
  { key: "t10", share: 0.1 },
  { key: "t1", share: 0.01 },
  { key: "t01", share: 0.001 },
];

// ── Deterministic data ──────────────────────────────────────────────────────

let seed = 20260904;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => {
  const u = rnd() || 1e-9;
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const unitVector = (): number[] => {
  const v = Array.from({ length: DIM }, gauss);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const lit = (v: number[]) => `[${v.join(",")}]`;

type Row = { doc: number; v: number[]; tiers: string[] };

function generate(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const tiers = TIERS.filter((t) => r < t.share).map((t) => t.key);
    rows.push({ doc: i, v: unitVector(), tiers });
  }
  return rows;
}

async function load(sql: SQL, rows: Row[]): Promise<void> {
  const B = 500;
  for (let i = 0; i < rows.length; i += B) {
    const values = rows
      .slice(i, i + B)
      .map((r) => {
        const meta = JSON.stringify({ doc: r.doc, tiers: r.tiers });
        return `('doc ${r.doc}', '${meta}'::jsonb, '${lit(r.v)}'::vector)`;
      })
      .join(",");
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  // Chunk rows for a share of thoughts: perturbed copies of the parent vector,
  // so a chunk can out-score its parent and the merge has something to do.
  await sql.unsafe(`
    INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
    SELECT t.id, g.i, 'chunk ' || g.i, t.embedding
    FROM thoughts t, generate_series(0, ${CHUNKS_PER - 1}) AS g(i)
    WHERE (t.metadata->>'doc')::int % ${Math.round(1 / CHUNKED_SHARE)} = 0`);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
}

// ── The measurements ────────────────────────────────────────────────────────

/** A filter for a tier: `{"tiers": ["t1"]}` — array containment, one key. */
const tierFilter = (key: string) => JSON.stringify({ tiers: [key] });

async function unfilteredCounts(sql: SQL, queries: number[][]): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const count of [10, 20, 50, 100]) {
    let min = Infinity;
    let max = -Infinity;
    for (const q of queries.slice(0, 10)) {
      const [{ c }] = await sql.unsafe(
        `SELECT count(*)::int AS c FROM match_thoughts('${lit(q)}'::vector, -1.0, ${count}, '{}'::jsonb)`
      );
      min = Math.min(min, Number(c));
      max = Math.max(max, Number(c));
    }
    out[count] = min === max ? String(min) : `${min}–${max}`;
  }
  return out;
}

/**
 * Exact top-K within a filter, MAX over the thought's vector and its chunks.
 * Index scans off so this is a full scan and a sort, whatever the planner
 * would otherwise prefer. Correct by construction, slow on purpose.
 */
async function oracle(sql: SQL, q: number[], filter: string): Promise<string[]> {
  const rows = await sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL enable_indexscan = off`);
    await tx.unsafe(`SET LOCAL enable_bitmapscan = off`);
    return tx.unsafe(`
      WITH scored AS (
        SELECT t.id, 1 - (t.embedding <=> '${lit(q)}'::vector) AS sim
        FROM thoughts t WHERE t.embedding IS NOT NULL AND t.metadata @> '${filter}'::jsonb
        UNION ALL
        SELECT c.thought_id, 1 - (c.embedding <=> '${lit(q)}'::vector)
        FROM thought_chunks c JOIN thoughts t ON t.id = c.thought_id
        WHERE t.metadata @> '${filter}'::jsonb
      )
      SELECT id FROM (SELECT id, MAX(sim) AS sim FROM scored GROUP BY id) s
      ORDER BY sim DESC LIMIT ${K}`);
  });
  return rows.map((r: { id: string }) => r.id);
}

type FilteredResult = { returned: number; overlap: number; empty: number; ms: number };

async function filtered(sql: SQL, queries: number[][], filter: string): Promise<FilteredResult> {
  let returned = 0;
  let overlap = 0;
  let empty = 0;
  const times: number[] = [];
  for (const q of queries) {
    const want = new Set(await oracle(sql, q, filter));
    const t0 = performance.now();
    const got = (
      await sql.unsafe(`SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb)`)
    ).map((r: { id: string }) => r.id);
    times.push(performance.now() - t0);
    returned += got.length;
    overlap += got.filter((id) => want.has(id)).length;
    if (got.length === 0) empty++;
  }
  times.sort((a, b) => a - b);
  return {
    returned: returned / queries.length,
    overlap: overlap / queries.length,
    empty,
    ms: times[Math.floor(times.length / 2)],
  };
}

/**
 * The function's own RETURN QUERY, as a parameterised statement. Read from the
 * catalog so it is the deployed text. The rewrite is deliberately narrow — the
 * four parameters and the two DECLAREd locals — and refuses anything it does
 * not recognise rather than explaining a statement that is not the function's.
 */
async function extractBody(sql: SQL): Promise<string> {
  const [{ def }] = await sql.unsafe(
    `SELECT pg_get_functiondef('match_thoughts(vector, float, int, jsonb)'::regprocedure) AS def`
  );
  const m = /RETURN QUERY\s+([\s\S]*?);\s*END;/.exec(def);
  if (!m) throw new Error("match_thoughts has no single RETURN QUERY; the bench's rewrite does not apply");
  let body = m[1];
  const declared = /DECLARE([\s\S]*?)BEGIN/.exec(def)?.[1] ?? "";
  for (const line of declared.split("\n")) {
    const d = /^\s*(\w+)\s+\w+\s*:=\s*(.+);\s*$/.exec(line);
    if (!d) continue;
    const [, name, expr] = d;
    body = body.replace(new RegExp(`\\b${name}\\b`, "g"), `(${expr})`);
  }
  body = body
    .replace(/\bquery_embedding\b/g, `$1::vector(${DIM})`)
    .replace(/\bmatch_threshold\b/g, "$2::float")
    .replace(/\bmatch_count\b/g, "$3::int")
    .replace(/\bfilter\b/g, "$4::jsonb");
  const leftover = /\b(v_\w+)\b/.exec(body);
  if (leftover) throw new Error(`unrewritten local ${leftover[1]} in match_thoughts body`);
  return body;
}

type PlanShape = { thoughts: string; chunks: string; iterative: boolean; ms: number; text: string };

/**
 * How each candidate CTE reached its rows. The vector index names are
 * unambiguous; a GIN bitmap or a sequential scan on `thoughts` could in
 * principle be the outer join instead, which is why only the CURRENT function
 * is explained (its outer join is a primary-key lookup and cannot match these).
 */
function shapeOf(plan: string, ms: number): PlanShape {
  const access = (table: string, vectorIdx: string, ginIdx?: string): string => {
    if (new RegExp(`Index Scan using ${vectorIdx}`).test(plan)) return "HNSW index scan";
    if (ginIdx && new RegExp(`Bitmap Index Scan on ${ginIdx}`).test(plan)) return "GIN bitmap + sort";
    if (new RegExp(`Seq Scan on ${table}`).test(plan)) return "seq scan + sort";
    return "?";
  };
  return {
    thoughts: access("thoughts t", "thoughts_embedding_idx", "thoughts_metadata_idx"),
    chunks: access("thought_chunks c", "thought_chunks_embedding_idx"),
    iterative: /Index Scan using thoughts_embedding_idx|Index Scan using thought_chunks_embedding_idx/.test(plan),
    ms,
    text: plan,
  };
}

async function plans(sql: SQL, q: number[], filter: string): Promise<{ custom: PlanShape; generic: PlanShape }> {
  const body = await extractBody(sql);
  const out: Record<string, PlanShape> = {};
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    const rows = await sql.begin(async (tx: SQL) => {
      // Function-level SET is not in effect outside the function; apply the
      // same setting the function declares so the plan is the one it gets.
      const [{ cfg }] = await tx.unsafe(
        `SELECT array_to_string(proconfig, ',') AS cfg FROM pg_proc WHERE oid = 'match_thoughts(vector, float, int, jsonb)'::regprocedure`
      );
      for (const kv of String(cfg ?? "").split(",").filter(Boolean)) {
        const [k, v] = kv.split("=");
        await tx.unsafe(`SET LOCAL ${k} = ${v}`);
      }
      await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
      await tx.unsafe(`PREPARE bench_mt(vector(${DIM}), float, int, jsonb) AS ${body}`);
      const r = await tx.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) EXECUTE bench_mt('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb)`
      );
      await tx.unsafe(`DEALLOCATE bench_mt`);
      return r;
    });
    const text = rows.map((r: Record<string, string>) => Object.values(r)[0]).join("\n");
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? NaN);
    out[mode === "force_custom_plan" ? "custom" : "generic"] = shapeOf(text, ms);
  }
  return out as { custom: PlanShape; generic: PlanShape };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const sql = new SQL({ url: URL_, max: 1 });

type Arm = "before (001–013)" | "after (014)";
type Cell = FilteredResult & { key: string; share: number };
const results: { scale: number; arm: Arm; counts: Record<number, string>; cells: Cell[]; plan?: { custom: PlanShape; generic: PlanShape } }[] = [];

let banner = false;
for (const n of SCALES) {
  console.log(`▸ ${n.toLocaleString()} rows — loading`);
  await resetSchema(URL_, { ...OPTS, only: (f) => f < "014" });
  if (!banner) {
    // The extension exists only once the schema does, so the banner waits.
    const [{ extversion }] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    const [{ v }] = await sql`SELECT version() AS v`;
    console.log(`  ${String(v).split(" on ")[0]}, pgvector ${extversion}`);
    console.log(`  ${DIM}-dimensional random unit vectors, ${Q} random queries per filter, K=${K}`);
    banner = true;
  }
  await load(sql, generate(n));
  const queries = Array.from({ length: Q }, unitVector);

  for (const arm of ["before (001–013)", "after (014)"] as Arm[]) {
    if (arm === "after (014)") await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("014") });
    process.stdout.write(`  ${arm.padEnd(18)}`);
    const counts = await unfilteredCounts(sql, queries);
    const cells: Cell[] = [];
    for (const t of TIERS) {
      // At 1,000 rows the 0.1% tier is one row; skip tiers thinner than K rows.
      if (n * t.share < K) continue;
      const r = await filtered(sql, queries, tierFilter(t.key));
      cells.push({ ...r, key: t.key, share: t.share });
      process.stdout.write(".");
    }
    // Plans only for the function under test: see shapeOf.
    const plan = arm === "after (014)" ? await plans(sql, queries[0], tierFilter("t1")) : undefined;
    results.push({ scale: n, arm, counts, cells, plan });
    console.log(" done");
  }
}

await sql.close();

// ── Report ──────────────────────────────────────────────────────────────────

console.log("\n### A. Unfiltered: rows returned for rows requested\n");
console.log("| rows | arm | asked 10 | asked 20 | asked 50 | asked 100 |");
console.log("| ---: | --- | ---: | ---: | ---: | ---: |");
for (const r of results) {
  console.log(`| ${r.scale.toLocaleString()} | ${r.arm} | ${r.counts[10]} | ${r.counts[20]} | ${r.counts[50]} | ${r.counts[100]} |`);
}

console.log(`\n### B. Filtered: of ${K} asked, mean returned and mean overlap with the exact top-${K}\n`);
console.log("| rows | filter matches | arm | returned | in exact top-10 | empty results | median ms |");
console.log("| ---: | ---: | --- | ---: | ---: | ---: | ---: |");
for (const r of results) {
  for (const c of r.cells) {
    const share = c.share >= 0.01 ? `${c.share * 100}%` : `${c.share * 100}%`;
    console.log(
      `| ${r.scale.toLocaleString()} | ${share} | ${r.arm} | ${c.returned.toFixed(1)} | ${c.overlap.toFixed(1)} | ${c.empty}/${Q} | ${c.ms.toFixed(2)} |`
    );
  }
}

console.log("\n### C. Plan shape of the current function for a 1% filter (custom plan / generic plan)\n");
console.log("plpgsql may run either: custom for the first five calls, then generic if it is not costlier.\n");
console.log("| rows | thoughts candidates | chunk candidates | exec ms |");
console.log("| ---: | --- | --- | ---: |");
for (const r of results) {
  if (!r.plan) continue;
  const { custom, generic } = r.plan;
  console.log(
    `| ${r.scale.toLocaleString()} | ${custom.thoughts} / ${generic.thoughts} | ${custom.chunks} / ${generic.chunks} | ${custom.ms.toFixed(2)} / ${generic.ms.toFixed(2)} |`
  );
}
if (PRINT_PLANS) {
  for (const r of results) {
    if (!r.plan) continue;
    console.log(`\n#### ${r.scale.toLocaleString()} rows, ${r.arm}, generic plan\n`);
    console.log(r.plan.generic.text.replace(/\[[-\d.,e]+\]'::vector/g, "[…]'::vector"));
  }
}
console.log();
