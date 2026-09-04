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
 *      against returned — and the median latency at match_count 10, which is
 *      every first-party caller's path. The overfetch cap shows up as "asked
 *      50, got 40"; the latency column is what 014's extra join costs there.
 *
 *   B. Filtered overlap. For each selectivity (a `tier` key planted at 50%,
 *      10%, 1%, 0.1% and 0.01% of rows) and Q random query vectors: how many
 *      rows came back of the 10 asked for, how many of those the EXACT top-10
 *      within the filter also contains, and how often the result was empty.
 *      The oracle is the same scoring (MAX over a thought's own vector and its
 *      chunks) with index scans disabled, so it is exact by construction and
 *      shares no code with the function under test. It is computed once per
 *      query and tier; both arms are scored against the same answer.
 *
 *      The thinnest tier has fewer matching rows than the candidate budget, so
 *      the iterative scan cannot stop early and must walk until it exhausts
 *      the index or reaches `hnsw.max_scan_tuples`. A filter matching NOTHING
 *      is measured too — a typo'd tag, an empty project — because that is the
 *      case where the scan does the most work to return the least.
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
 *   ./with-postgres.sh bun bench-hnsw.ts             # 10,000 and 100,000 rows, 50 queries
 *   OB1_BENCH_SCALES=1000 OB1_BENCH_QUERIES=20 ./with-postgres.sh bun bench-hnsw.ts
 *   ./with-postgres.sh bun bench-hnsw.ts --plans     # print the full plans
 *
 * Vectors are 64-wide random unit vectors: wide enough that HNSW behaves like
 * HNSW, narrow enough that a 100,000-row index builds in a minute. Nothing here
 * reads any corpus, so nothing sensitive is involved.
 */

import { SQL } from "bun";
import { applyMigrations, requireDatabaseUrl, resetSchema, seededRandom } from "./test-support.ts";

const URL_ = requireDatabaseUrl("bench-hnsw.ts");
const PRINT_PLANS = process.argv.includes("--plans");

const DIM = 64;
const OPTS = { dim: DIM, model: "stub-embed" };
// The defaults are the run every published table came from, so the documented
// command reproduces the documented numbers.
const SCALES = (process.env.OB1_BENCH_SCALES ?? "10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** Random queries per selectivity. Validated: a typo here would surface only after the load. */
const Q = Number(process.env.OB1_BENCH_QUERIES ?? 50);
if (!Number.isInteger(Q) || Q < 1) {
  console.error(`OB1_BENCH_QUERIES must be a positive integer (got ${JSON.stringify(process.env.OB1_BENCH_QUERIES)})`);
  process.exit(2);
}
if (SCALES.length === 0) {
  console.error(`OB1_BENCH_SCALES must name at least one positive row count (got ${JSON.stringify(process.env.OB1_BENCH_SCALES)})`);
  process.exit(2);
}
/** Result size for the filtered arm. The server's default is 10. */
const K = 10;
/** Share of thoughts that also get chunk rows, so the chunk CTE is exercised. */
const CHUNKED_SHARE = 0.2;
const CHUNKS_PER = 2;

/**
 * Planted selectivities. `tiers` is one key so a filter is one containment
 * test — the shape a direct caller sends as `{"type": "decision"}`. (The
 * server's own `search_thoughts` sends no filter; the filter argument is
 * reached by direct SQL, PostgREST RPC callers and community code such as the
 * enhanced-mcp integration's `metadata_filter`.) The tiers nest (a row in t001
 * is also in t01, t1, t10, t50) so every selectivity is a superset of the next
 * and the comparison is between filter sizes only. `none` matches no row.
 */
const TIERS: { key: string; share: number }[] = [
  { key: "t50", share: 0.5 },
  { key: "t10", share: 0.1 },
  { key: "t1", share: 0.01 },
  { key: "t01", share: 0.001 },
  { key: "t001", share: 0.0001 },
  { key: "none", share: 0 },
];

// ── Deterministic data ──────────────────────────────────────────────────────
//
// Re-seeded per scale, so the 100,000-row corpus is the same corpus whether or
// not 10,000 ran first. The generator is test-support's; the copy this file had
// cycled after ~10,000 draws and made most queries exact copies of stored rows,
// which is why `checkConfound` exists below.

const lit = (v: number[]) => `[${v.join(",")}]`;

type Row = { doc: number; v: number[]; tiers: string[] };

function generate(n: number): { rows: Row[]; queries: number[][] } {
  const { rnd, unitVector } = seededRandom(20260904 + n);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const tiers = TIERS.filter((t) => r < t.share).map((t) => t.key);
    rows.push({ doc: i, v: unitVector(DIM), tiers });
  }
  const queries = Array.from({ length: Q }, () => unitVector(DIM));
  return { rows, queries };
}

/**
 * A query that IS a stored row is its own global nearest neighbour, which no
 * post-filter can lose — the confound this bench exists to avoid. Random unit
 * vectors in 64 dimensions sit near cosine 0 of each other; anything close to
 * 1 means the generator repeated itself. Refuse to publish numbers on that.
 */
function checkConfound(rows: Row[], queries: number[][]): number {
  let max = -1;
  for (const q of queries) {
    for (const r of rows) {
      let dot = 0;
      for (let i = 0; i < DIM; i++) dot += q[i] * r.v[i];
      if (dot > max) max = dot;
    }
  }
  if (max > 0.99) {
    throw new Error(`a query vector coincides with a stored row (cosine ${max.toFixed(4)}); the generator is not random enough to measure with`);
  }
  return max;
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
  // Chunk rows for a share of thoughts, carrying the parent's own vector: the
  // point is that the chunk CTE has rows to scan and the merge has duplicates
  // to collapse, not that a chunk out-scores its parent.
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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function unfiltered(sql: SQL, queries: number[][]): Promise<{ counts: Record<number, string>; ms10: number }> {
  const counts: Record<number, string> = {};
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
    counts[count] = min === max ? String(min) : `${min}–${max}`;
  }
  // The default path's latency, over every query so the median means something.
  const times: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    await sql.unsafe(`SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${K}, '{}'::jsonb)`);
    times.push(performance.now() - t0);
  }
  return { counts, ms10: median(times) };
}

/**
 * Exact top-K within a filter, MAX over the thought's vector and its chunks.
 * Index scans off so this is a full scan and a sort, whatever the planner
 * would otherwise prefer. Correct by construction, slow on purpose — which is
 * why it runs once per (tier, query) and not once per arm.
 */
async function oracle(sql: SQL, q: number[], filter: string): Promise<Set<string>> {
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
  return new Set(rows.map((r: { id: string }) => r.id));
}

type FilteredResult = { returned: number; overlap: number; empty: number; ms: number; exact: number };

async function filtered(sql: SQL, queries: number[][], filter: string, wants: Set<string>[]): Promise<FilteredResult> {
  let returned = 0;
  let overlap = 0;
  let empty = 0;
  let exact = 0;
  const times: number[] = [];
  for (const [i, q] of queries.entries()) {
    const want = wants[i];
    const t0 = performance.now();
    const got = (
      await sql.unsafe(`SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb)`)
    ).map((r: { id: string }) => r.id);
    times.push(performance.now() - t0);
    returned += got.length;
    overlap += got.filter((id) => want.has(id)).length;
    exact += want.size;
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
  const locals: [string, string][] = [];
  for (const line of declared.split("\n")) {
    const d = /^\s*(\w+)\s+\w+\s*:=\s*(.+);\s*$/.exec(line);
    if (d) locals.push([d[1], d[2]]);
  }
  // Locals may reference earlier locals (v_fetch is built from v_count), so
  // substitute until none remain rather than in one pass over the list.
  for (let pass = 0; pass < locals.length + 1; pass++) {
    for (const [name, expr] of locals) body = body.replace(new RegExp(`\\b${name}\\b`, "g"), `(${expr})`);
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

type PlanShape = { thoughts: string; chunks: string; ms: number; text: string };

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
    ms,
    text: plan,
  };
}

async function plans(sql: SQL, q: number[], filter: string): Promise<{ custom: PlanShape; generic: PlanShape }> {
  const body = await extractBody(sql);
  const out: Record<string, PlanShape> = {};
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    const rows = await sql.begin(async (tx: SQL) => {
      // Function-level SETs are not in effect outside the function; apply the
      // same settings the function declares so the plan is the one it gets.
      // proconfig is read as an array and applied through set_config with bound
      // parameters: a joined string split on commas would break the first time
      // a list-valued setting such as `search_path = public, extensions` is
      // added to the function, and it would break after the full load.
      const entries = await tx.unsafe(
        `SELECT unnest(proconfig) AS kv FROM pg_proc WHERE oid = 'match_thoughts(vector, float, int, jsonb)'::regprocedure`
      );
      for (const { kv } of entries as { kv: string }[]) {
        const eq = kv.indexOf("=");
        if (eq < 0) throw new Error(`unexpected proconfig entry ${JSON.stringify(kv)}`);
        // plan_cache_mode is the one setting the bench must NOT inherit here:
        // this section exists to show both plans.
        if (kv.slice(0, eq) === "plan_cache_mode") continue;
        await tx.unsafe(`SELECT set_config($1, $2, true)`, [kv.slice(0, eq), kv.slice(eq + 1)]);
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

type Arm = "before (001–013)" | "after (014)";
type Cell = FilteredResult & { key: string; share: number; matches: number };
type Result = {
  scale: number;
  arm: Arm;
  counts: Record<number, string>;
  ms10: number;
  cells: Cell[];
  plan?: { custom: PlanShape; generic: PlanShape };
};
const results: Result[] = [];
const generic: (FilteredResult & { scale: number; key: string; share: number; matches: number })[] = [];

let banner = false;
for (const n of SCALES) {
  console.log(`▸ ${n.toLocaleString()} rows — loading`);
  await resetSchema(URL_, { ...OPTS, only: (f) => f < "014" });
  await reconnect();
  if (!banner) {
    // The extension exists only once the schema does, so the banner waits.
    const [{ extversion }] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    const [{ v }] = await sql`SELECT version() AS v`;
    console.log(`  ${String(v).split(" on ")[0]}, pgvector ${extversion}`);
    console.log(`  ${DIM}-dimensional random unit vectors, ${Q} random queries per filter, K=${K}`);
    banner = true;
  }
  const { rows, queries } = generate(n);
  console.log(`  nearest query-to-row cosine ${checkConfound(rows, queries).toFixed(3)} (a repeat would read 1.000)`);
  await load(sql, rows);

  // Tiers with at least one matching row, and the exact answer for each
  // (tier, query) once — shared by both arms.
  const tiers = TIERS.filter((t) => t.key === "none" || n * t.share >= 1).map((t) => ({
    ...t,
    matches: rows.filter((r) => r.tiers.includes(t.key)).length,
  }));
  process.stdout.write("  exact oracle      ");
  const wants = new Map<string, Set<string>[]>();
  for (const t of tiers) {
    wants.set(t.key, await Promise.all(queries.map((q) => oracle(sql, q, tierFilter(t.key)))));
    process.stdout.write(".");
  }
  console.log(" done");

  for (const arm of ["before (001–013)", "after (014)"] as Arm[]) {
    if (arm === "after (014)") {
      await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("014") });
      await reconnect(); // the database-level bounds 014 just seeded are read at connect
      const [{ t, m }] = await sql`SELECT current_setting('hnsw.max_scan_tuples', true) AS t, current_setting('hnsw.scan_mem_multiplier', true) AS m`;
      const [row] = await sql`
        SELECT s.setconfig AS cfg FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = current_database() AND s.setrole = 0`;
      const cfg: string[] = row?.cfg ?? [];
      const has = (k: string, v: string) => cfg.includes(`${k}=${v}`);
      if (!has("hnsw.max_scan_tuples", t) || !has("hnsw.scan_mem_multiplier", m)) {
        throw new Error(`session did not pick up the database-level bounds (max_scan_tuples=${t}, scan_mem_multiplier=${m}; database has ${cfg.join(", ") || "none"})`);
      }
      console.log(`  bounds in force: max_scan_tuples=${t}, scan_mem_multiplier=${m}`);
    }
    process.stdout.write(`  ${arm.padEnd(18)}`);
    const { counts, ms10 } = await unfiltered(sql, queries);
    const cells: Cell[] = [];
    for (const t of tiers) {
      const r = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
      cells.push({ ...r, key: t.key, share: t.share, matches: t.matches });
      process.stdout.write(".");
    }
    // Plans only for the function under test: see shapeOf.
    const plan = arm === "after (014)" ? await plans(sql, queries[0], tierFilter("t1")) : undefined;
    results.push({ scale: n, arm, counts, ms10, cells, plan });
    console.log(" done");
  }

  // D. The generic plan, which 014 forbids the function from using. Under it
  // the filter is a parameter, the GIN index is unavailable, and the iterative
  // HNSW scan does all the work, bounded by hnsw.max_scan_tuples and by
  // work_mem * hnsw.scan_mem_multiplier. This arm strips the function's own
  // plan_cache_mode so the session can force the generic plan and measures the
  // thin and empty filters through it. It runs last for its scale — the next
  // scale resets the schema — so nothing needs restoring. It exists to show
  // what the forced custom plan buys, and to show the bounds doing their job
  // when the walk does happen.
  process.stdout.write("  generic plan      ");
  await sql.unsafe(`ALTER FUNCTION match_thoughts(vector, float, int, jsonb) RESET plan_cache_mode`);
  await sql.unsafe(`SET plan_cache_mode = force_generic_plan`);
  const thin = tiers.filter((t) => t.share <= 0.001);
  for (const t of thin) {
    const r = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    generic.push({ scale: n, key: t.key, share: t.share, matches: t.matches, ...r });
    process.stdout.write(".");
  }
  await sql.unsafe(`SET plan_cache_mode = auto`);
  console.log(" done");
}

await sql.close();

// ── Report ──────────────────────────────────────────────────────────────────

console.log("\n### A. Unfiltered: rows returned for rows requested, and the default path's latency\n");
console.log("| rows | arm | asked 10 | asked 20 | asked 50 | asked 100 | median ms, asked 10 |");
console.log("| ---: | --- | ---: | ---: | ---: | ---: | ---: |");
for (const r of results) {
  console.log(
    `| ${r.scale.toLocaleString()} | ${r.arm} | ${r.counts[10]} | ${r.counts[20]} | ${r.counts[50]} | ${r.counts[100]} | ${r.ms10.toFixed(2)} |`
  );
}

console.log(`\n### B. Filtered: of ${K} asked, mean returned and mean overlap with the exact top-${K}\n`);
console.log("\"exact has\" is the oracle's own size: a tier thinner than K rows cannot fill the list.\n");
console.log("| rows | filter matches | matching rows | arm | returned | in exact top-10 | exact has | empty results | median ms |");
console.log("| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
for (const r of results) {
  for (const c of r.cells) {
    const share = c.key === "none" ? "nothing" : `${c.share * 100}%`;
    console.log(
      `| ${r.scale.toLocaleString()} | ${share} | ${c.matches} | ${r.arm} | ${c.returned.toFixed(1)} | ${c.overlap.toFixed(1)} | ${c.exact.toFixed(1)} | ${c.empty}/${Q} | ${c.ms.toFixed(2)} |`
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

console.log("\n### D. The generic plan the function forbids, forced anyway: thin and empty filters through the iterative scan\n");
console.log("What plan_cache_mode = force_custom_plan on the function avoids, and what the two scan bounds do when the walk happens.\n");
console.log("| rows | filter matches | matching rows | returned | in exact top-10 | exact has | median ms |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const g of generic) {
  const share = g.key === "none" ? "nothing" : `${g.share * 100}%`;
  console.log(
    `| ${g.scale.toLocaleString()} | ${share} | ${g.matches} | ${g.returned.toFixed(1)} | ${g.overlap.toFixed(1)} | ${g.exact.toFixed(1)} | ${g.ms.toFixed(2)} |`
  );
}
console.log();
