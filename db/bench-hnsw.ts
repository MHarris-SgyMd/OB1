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
 *   L. The load itself, at every scale: rows per second into an unindexed
 *      table, the HNSW build time for each vector index once the rows are in,
 *      and the table and index sizes. 014's header argued the walk's bounds
 *      past 2.5 million rows from arithmetic; SMD-1018 asked for the numbers,
 *      and the build's cost and the index's size are the first two a brain
 *      that large would meet.
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
 *      table, which is the point: the same filter, a growing brain. (A row
 *      count is a nominal size — membership is a coin per row — so the table
 *      prints the count actually planted.)
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
 *      the capped id collection every filtered call runs first — on the 50%
 *      filter, where GIN builds its largest bitmap before the LIMIT can stop
 *      anything, on the thinnest filter with rows, and on the empty one. That
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
 *   OB1_BENCH_SCALES=1000000,10000000 ./with-postgres.sh bun bench-hnsw.ts
 *   ./with-postgres.sh bun bench-hnsw.ts --plans     # print the full plans
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
 * index's own at the default ef_search (section A's control: 8.2 / 4.6 / 1.9
 * of 10 unfiltered at 10k / 100k / 1M random rows). The seeded bounds matter
 * in one band — moderately selective filters at around a million rows, where
 * the walk does walk and pgvector's default MEMORY bound cuts it short — and
 * there the exact branch would have been faster and exact (section E). The
 * routing count grows linearly with the matches, ~250 ms at 50% of ten
 * million rows. FORK.md change 28 has the tables and the three follow-ups
 * (SMD-1463 the routing count, SMD-1464 the threshold and plan mode, SMD-1465
 * the recall floor on real vectors); 014's own header is not edited, because
 * migrations are checksummed and append-only.
 *
 * The before arm — the function as shipped by 001–013 — runs at the published
 * scales only (up to 100,000 rows). Its defect is established there; at a
 * million rows and up it would double the load to show 007 returning nothing
 * at 1% once more, and every question SMD-1018 asks is about the shipped
 * function. Above that the schema is applied whole before the load and the
 * after arm is the only arm.
 *
 * The rows are generated in two passes over one seeded stream — the first
 * only to reach the queries, which the stream yields after the rows, the
 * second to insert — so the corpus at 10,000 and 100,000 rows is byte for byte
 * the one the published tables came from while nothing holds N vectors in
 * memory. Bun's SQL driver has no COPY protocol (a `COPY ... FROM STDIN`
 * hangs), so the rows go in as multi-row INSERTs into a table whose vector
 * indexes have been dropped for the load; the indexes are rebuilt after it,
 * with `maintenance_work_mem` sized for the graph. That is also how a brain
 * that size would be bulk-loaded.
 */

import { SQL } from "bun";
import { applyFunctionSettings, applyMigrations, explainPrepared, extractBody, requireDatabaseUrl, resetSchema, seededRandom } from "./test-support.ts";
import type { Branch } from "./test-support.ts";
import { BOUNDS_IN_FORCE_SQL, DB_LEVEL_SETTINGS_SQL, HNSW_BOUNDS, parseSetConfig } from "./config.mjs";

const URL_ = requireDatabaseUrl("bench-hnsw.ts");
const PRINT_PLANS = process.argv.includes("--plans");

const DIM = 64;
const OPTS = { dim: DIM, model: "stub-embed" };
// The defaults are the run every published table came from, so the documented
// command reproduces the documented numbers — with one caveat since 019: the
// after arm applies every migration from 014 on, so the function it times and
// explains carries `enable_seqscan = off` as well. The recall tables in 014's
// header and FORK.md change 28 were measured under 014 alone; at K = 10 the
// index was the plan either way, so they reproduce, while the asked-500
// latencies in section A and the chunk side of section C's plans (where the
// planner's own choice at 64 dimensions was a seq scan above 200 candidates)
// are now the deployed function's and may differ from the published lines.
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
/** The before arm (001–013) runs up to this scale; see the header. */
const BEFORE_ARM_MAX = 100_000;
/** Result size for the filtered arm. The server's default is 10. */
const K = 10;
/** Share of thoughts that also get chunk rows, so the chunk CTE is exercised. */
const CHUNKED_SHARE = 0.2;
const CHUNKS_PER = 2;
/** Rows per INSERT statement during the load. */
const BATCH = 2000;
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
if (!Number.isInteger(BUILD_WORKERS) || BUILD_WORKERS < 0) {
  console.error(`OB1_BENCH_BUILD_WORKERS must be a non-negative integer (got ${JSON.stringify(process.env.OB1_BENCH_BUILD_WORKERS)})`);
  process.exit(2);
}

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
function tiersAt(n: number): Tier[] {
  const out: Tier[] = [];
  for (const t of TIERS) {
    if ("rows" in t) {
      if (t.rows >= n / 2) continue;
      out.push({ key: t.key, share: t.rows / n, label: `${t.rows.toLocaleString()} rows` });
    } else if (t.share === 0) {
      out.push({ key: t.key, share: 0, label: "nothing" });
    } else if (n * t.share >= 1) {
      out.push({ key: t.key, share: t.share, label: `${t.share * 100}%` });
    }
  }
  return out.sort((a, b) => b.share - a.share);
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

/** The Q queries the stream yields after n rows, without materialising the rows. */
function queriesFor(n: number): number[][] {
  const { rnd, unitVector } = seedFor(n);
  const drawsPerRow = 1 + 2 * DIM;
  for (let i = 0; i < n * drawsPerRow; i++) rnd();
  return Array.from({ length: Q }, () => unitVector(DIM));
}

type Row = { doc: number; v: number[]; tiers: string[] };

/** The n rows, in insertion order, one batch at a time. */
function* rowBatches(n: number, tiers: Tier[]): Generator<Row[]> {
  const { rnd, unitVector } = seedFor(n);
  let batch: Row[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const keys = tiers.filter((t) => r < t.share).map((t) => t.key);
    batch.push({ doc: i, v: unitVector(DIM), tiers: keys });
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
  assert(): number {
    if (this.max > 0.99) {
      throw new Error(`a query vector coincides with a stored row (cosine ${this.max.toFixed(4)}); the generator is not random enough to measure with`);
    }
    return this.max;
  }
}

type LoadStats = {
  scale: number;
  confound: number;
  insertS: number;
  chunkRows: number;
  chunkS: number;
  buildS: Record<string, number>;
  sizes: Record<string, number>;
  maintenanceMem: string;
  workers: number;
};

/**
 * The load: vector indexes dropped, rows streamed in, chunk rows derived
 * server-side, the indexes rebuilt with `maintenance_work_mem` sized for the
 * graph, everything timed and measured. Returns the tier match counts too —
 * counted as the rows are generated, so no pass over the table is needed.
 */
async function load(sql: SQL, n: number, tiers: Tier[], queries: number[][]): Promise<{ stats: LoadStats; matches: Map<string, number> }> {
  const HNSW_INDEXES = ["thoughts_embedding_idx", "thought_chunks_embedding_idx"];
  const defs = new Map<string, string>();
  for (const name of HNSW_INDEXES) {
    const [row] = await sql.unsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
    if (!row) throw new Error(`index ${name} is not defined; the load cannot rebuild it`);
    defs.set(name, row.indexdef);
    await sql.unsafe(`DROP INDEX ${name}`);
  }
  // A bulk load's commit latency is not what is measured; the WAL is still written.
  await sql.unsafe(`SET synchronous_commit = off`);

  const confound = new Confound(queries);
  const matches = new Map<string, number>(tiers.map((t) => [t.key, 0]));
  const t0 = performance.now();
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
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
    done += batch.length;
    if (done % 1_000_000 === 0) process.stdout.write(`${(done / 1e6).toFixed(0)}M `);
  }
  const insertS = (performance.now() - t0) / 1000;

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
  await sql.unsafe(`SET maintenance_work_mem = '${maintenanceMem}'`);
  // pgvector says when the graph stops fitting in maintenance_work_mem with a
  // NOTICE, which this driver does not surface; sent to the server log it can
  // be read after the run (`podman logs`). Superuser-only, so best effort.
  await sql.unsafe(`SET log_min_messages = notice`).catch(() => undefined);
  await sql.unsafe(`SET max_parallel_maintenance_workers = ${BUILD_WORKERS}`);
  const buildS: Record<string, number> = {};
  for (const [name, def] of defs) {
    const t2 = performance.now();
    await sql.unsafe(def);
    buildS[name] = (performance.now() - t2) / 1000;
  }
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
  const sizes: Record<string, number> = {};
  for (const rel of ["thoughts", "thought_chunks"]) sizes[rel] = Number((await sql.unsafe(`SELECT pg_table_size($1::regclass)::bigint AS b`, [rel]))[0].b);
  for (const name of HNSW_INDEXES) sizes[name] = Number((await sql.unsafe(`SELECT pg_relation_size($1::regclass)::bigint AS b`, [name]))[0].b);
  for (const name of ["synchronous_commit", "maintenance_work_mem", "max_parallel_maintenance_workers"]) await sql.unsafe(`RESET ${name}`);
  await sql.unsafe(`RESET log_min_messages`).catch(() => undefined);

  return {
    stats: { scale: n, confound: confound.assert(), insertS, chunkRows: Number(chunkRows), chunkS, buildS, sizes, maintenanceMem, workers: BUILD_WORKERS },
    matches,
  };
}

// ── The measurements ────────────────────────────────────────────────────────

/** A filter for a tier: `{"tiers": ["t1"]}` — array containment, one key. */
const tierFilter = (key: string) => JSON.stringify({ tiers: [key] });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Row counts asked for in section A; the last is the function's own ceiling, timed too. */
const ASKS = [10, 20, 50, 100, 200, 500];

async function unfiltered(sql: SQL, queries: number[][], wants: Set<string>[]): Promise<{ counts: Record<number, string>; ms10: number; msMax: number; overlap: number; ms10Raised: number; overlapRaised: number }> {
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
  let overlap = 0;
  const time = async (count: number) => {
    const times: number[] = [];
    for (const [i, q] of queries.entries()) {
      const t0 = performance.now();
      const got = (await sql.unsafe(`SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${count}, '{}'::jsonb)`)).map((r: { id: string }) => r.id);
      times.push(performance.now() - t0);
      if (count === K) overlap += got.filter((id) => wants[i].has(id)).length;
    }
    return median(times);
  };
  const ms10 = await time(K);
  const msMax = await time(ASKS[ASKS.length - 1]);
  const overlapDefault = overlap / queries.length;
  // The same default-path call with the index asked to look harder: the
  // function does not set ef_search, so a session SET reaches it.
  overlap = 0;
  await sql.unsafe(`SET hnsw.ef_search = ${EF_SEARCH_RAISED}`);
  const ms10Raised = await time(K);
  await sql.unsafe(`RESET hnsw.ef_search`);
  return { counts, ms10, msMax, overlap: overlapDefault, ms10Raised, overlapRaised: overlap / queries.length };
}

/**
 * Exact top-K within a filter, MAX over the thought's vector and its chunks.
 * The vector index is an Index Scan and nothing else, so `enable_indexscan =
 * off` keeps it out of the plan; the GIN index reaches the table through a
 * bitmap and stays available, because a filter's bitmap is exact by
 * construction and a thin filter at ten million rows should not cost a
 * sequential scan per query (an earlier draft disabled bitmap scans too, for
 * no reason exactness needed). Correct by construction, slow on purpose where
 * the filter is broad — which is why it runs once per (tier, query) and not
 * once per arm.
 */
async function oracle(sql: SQL, q: number[], filter: string): Promise<Set<string>> {
  const rows = await sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL enable_indexscan = off`);
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

/** The function call the arms measure; sections D and E substitute extracted statements. */
const viaFunction = (q: number[], filter: string) => `SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb)`;

async function filtered(
  sql: SQL,
  queries: number[][],
  filter: string,
  wants: Set<string>[],
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

async function plans(sql: SQL, q: number[], filter: string, branch: Branch): Promise<{ custom: PlanShape; generic: PlanShape }> {
  const body = await extractBody(sql, branch, DIM);
  const out: Record<string, PlanShape> = {};
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    const { text, ms } = await sql.begin(async (tx: SQL) => {
      // Function-level SETs are not in effect outside the function; apply the
      // same settings the function declares so the plan is the one it gets —
      // all but a plan mode, since this section exists to show both plans.
      await applyFunctionSettings(tx);
      return explainPrepared(tx, { body, dim: DIM, args: `'${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0`, mode: mode as "force_custom_plan" | "force_generic_plan" });
    });
    out[mode === "force_custom_plan" ? "custom" : "generic"] = shapeOf(text, ms);
  }
  return out as { custom: PlanShape; generic: PlanShape };
}

/**
 * The exact branch's statement with its threshold floor lifted, so a filter
 * the function routes to the walk can be answered the way the exact branch
 * would answer it if the threshold were raised to cover it. The extracted
 * text carries the DECLARE expression inline wherever the branch read
 * `v_exact` — `GREATEST((...) * 4, 1000)`, nested through v_base and v_count,
 * once per spliced routing subquery — and the floor is the one place the
 * literal 1000 occurs. The rewrite insists that every `1000` in the text is
 * that floor, so a redefinition that moves or reuses the literal fails here
 * rather than measuring something else.
 */
async function exactBodyWithFloor(sql: SQL, floor: number): Promise<string> {
  const body = await extractBody(sql, "exact", DIM);
  const marker = "* 4, 1000)";
  const asFloor = body.split(marker).length - 1;
  const anywhere = (body.match(/\b1000\b/g) ?? []).length;
  if (asFloor === 0 || asFloor !== anywhere) throw new Error(`expected the exact branch's threshold floor (${marker}) to be the only 1000 in its text; found it ${asFloor} time(s) among ${anywhere}`);
  return body.split(marker).join(`* 4, ${floor})`);
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

type Arm = "before (001–013)" | "after (014 on)";
type Cell = FilteredResult & { key: string; label: string; matches: number };
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
  plan?: Record<string, { branch: Branch; tier: string; matches: number; custom: PlanShape; generic: PlanShape }>;
};
type WalkRow = FilteredResult & { scale: number; label: string; matches: number };
type BoundsRow = { scale: number; label: string; matches: number; tuples: number; seeded: FilteredResult; defaults: FilteredResult; raised: FilteredResult; exact?: FilteredResult };
const results: Result[] = [];
const loads: LoadStats[] = [];
const walk: WalkRow[] = [];
const bounds: BoundsRow[] = [];

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

/** 014's GREATEST(v_fetch * 4, 1000) at K: the most matching thoughts the exact branch takes. */
const V_EXACT = Math.max(Math.max(K * 4, 20) * 4, 1000);
const V_FETCH = Math.max(K * 4, 20);
/** pgvector's own defaults for the two bounds 014 seeds. */
const PGVECTOR_DEFAULTS: Record<string, string> = { "hnsw.max_scan_tuples": "20000", "hnsw.scan_mem_multiplier": "1" };
/** The raised `hnsw.ef_search` for the recall controls in sections A and E; pgvector's default is 40, the function leaves it alone. */
const EF_SEARCH_RAISED = 400;
/** Section E measures the exact branch on a walk tier only up to this many matching rows. */
const EXACT_CEILING = 50_000;

let banner = false;
for (const n of SCALES) {
  const beforeArm = n <= BEFORE_ARM_MAX;
  console.log(`▸ ${n.toLocaleString()} rows — loading${beforeArm ? "" : " (schema applied whole; the before arm runs up to " + BEFORE_ARM_MAX.toLocaleString() + " rows)"}`);
  await resetSchema(URL_, { ...OPTS, only: beforeArm ? (f) => f < "014" : undefined });
  await reconnect();
  if (!banner) {
    // The extension exists only once the schema does, so the banner waits.
    const [{ extversion }] = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    const [{ v }] = await sql`SELECT version() AS v`;
    const [{ shared_buffers, work_mem }] = await sql`SELECT current_setting('shared_buffers') AS shared_buffers, current_setting('work_mem') AS work_mem`;
    console.log(`  ${String(v).split(" on ")[0]}, pgvector ${extversion}, shared_buffers ${shared_buffers}, work_mem ${work_mem}`);
    console.log(`  ${DIM}-dimensional random unit vectors, ${Q} random queries per filter, K=${K}`);
    banner = true;
  }
  const tiers = tiersAt(n);
  const queries = queriesFor(n);
  process.stdout.write("  inserting         ");
  const { stats, matches } = await load(sql, n, tiers, queries);
  loads.push(stats);
  console.log(`done — ${stats.insertS.toFixed(0)} s, nearest query-to-row cosine ${stats.confound.toFixed(3)} (a repeat would read 1.000)`);
  console.log(`  HNSW builds       ${Object.entries(stats.buildS).map(([k, s]) => `${k} ${s.toFixed(0)} s`).join(", ")} (maintenance_work_mem ${stats.maintenanceMem}, ${stats.workers} workers)`);

  // The exact answer for each (tier, query) once — shared by both arms.
  const withCounts = tiers.map((t) => ({ ...t, matches: matches.get(t.key)! }));
  process.stdout.write("  exact oracle      ");
  const wants = new Map<string, Set<string>[]>();
  for (const t of withCounts) {
    const answers: Set<string>[] = [];
    for (const q of queries) answers.push(await oracle(sql, q, tierFilter(t.key)));
    wants.set(t.key, answers);
    process.stdout.write(".");
  }
  // And over the whole table, for section A's recall control: `{}` is
  // contained by every row, so the same oracle answers it.
  {
    const answers: Set<string>[] = [];
    for (const q of queries) answers.push(await oracle(sql, q, "{}"));
    wants.set("", answers);
    process.stdout.write(".");
  }
  console.log(" done");

  const arms: Arm[] = beforeArm ? ["before (001–013)", "after (014 on)"] : ["after (014 on)"];
  for (const arm of arms) {
    if (arm === "after (014 on)") {
      // 014 and everything after it: 019 redefines match_thoughts, and the
      // plans below are read from the catalog, so the arm holds the function
      // a deployment actually has rather than a superseded one. Above the
      // before arm's scales the schema was applied whole before the load.
      if (beforeArm) await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "014" });
      await reconnect(); // the database-level bounds 014 seeded are read at connect
      const inForce = Object.fromEntries((await sql.unsafe(BOUNDS_IN_FORCE_SQL)).map((r: { name: string; value: string | null }) => [r.name, r.value]));
      const [row] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
      const cfg = parseSetConfig(row?.cfg);
      if (HNSW_BOUNDS.some((b) => cfg[b] !== inForce[b])) {
        throw new Error(`session did not pick up the database-level bounds (in force ${JSON.stringify(inForce)}; database has ${JSON.stringify(cfg)})`);
      }
      console.log(`  bounds in force: ${HNSW_BOUNDS.map((b) => `${b}=${inForce[b]}`).join(", ")}`);
    }
    process.stdout.write(`  ${arm.padEnd(18)}`);
    const { counts, ms10, msMax, overlap, ms10Raised, overlapRaised } = await unfiltered(sql, queries, wants.get("")!);
    const cells: Cell[] = [];
    for (const t of withCounts) {
      const r = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
      cells.push({ ...r, key: t.key, label: t.label, matches: t.matches });
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
    const walkTier = withRows.find((t) => t.matches > V_EXACT);
    const exactTier = [...withRows].reverse().find((t) => t.matches <= V_EXACT);
    const broadest = withRows[withRows.length - 1];
    const thinnest = withRows[0];
    const plan: Result["plan"] = arm === "after (014 on)" ? {} : undefined;
    if (plan) {
      if (walkTier) plan.walk = { branch: "walk", tier: walkTier.label, matches: walkTier.matches, ...(await plans(sql, queries[0], tierFilter(walkTier.key), "walk")) };
      else console.log(`\n  (no tier above the exact threshold of ${V_EXACT} rows at this scale; the walk branch is not explained)`);
      if (walkTier && broadest && broadest !== walkTier) plan.walkBroad = { branch: "walk", tier: broadest.label, matches: broadest.matches, ...(await plans(sql, queries[0], tierFilter(broadest.key), "walk")) };
      if (exactTier) plan.exact = { branch: "exact", tier: exactTier.label, matches: exactTier.matches, ...(await plans(sql, queries[0], tierFilter(exactTier.key), "exact")) };
      if (broadest) plan.routeBroad = { branch: "route", tier: broadest.label, matches: broadest.matches, ...(await plans(sql, queries[0], tierFilter(broadest.key), "route")) };
      if (thinnest && thinnest !== broadest) plan.routeThin = { branch: "route", tier: thinnest.label, matches: thinnest.matches, ...(await plans(sql, queries[0], tierFilter(thinnest.key), "route")) };
      plan.routeNone = { branch: "route", tier: "nothing", matches: 0, ...(await plans(sql, queries[0], tierFilter("none"), "route")) };
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
  // statement is extracted with its floor lifted just past the tier, for
  // tiers up to a bound where an exact answer is still conceivable — scoring
  // the 50% tier row by row is not a candidate for anything.
  process.stdout.write("  bounds, via fn    ");
  const walkTiers = withCounts.filter((t) => t.matches > V_EXACT).sort((a, b) => a.matches - b.matches);
  for (const t of walkTiers) {
    const seeded = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    for (const [name, value] of Object.entries(PGVECTOR_DEFAULTS)) await sql.unsafe(`SET ${name} = ${value}`);
    const defaults = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    for (const name of Object.keys(PGVECTOR_DEFAULTS)) await sql.unsafe(`RESET ${name}`);
    await sql.unsafe(`SET hnsw.ef_search = ${EF_SEARCH_RAISED}`);
    const raised = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    await sql.unsafe(`RESET hnsw.ef_search`);
    let exact: FilteredResult | undefined;
    if (t.matches <= EXACT_CEILING) {
      const body = await exactBodyWithFloor(sql, t.matches + 1);
      const applied = await applyFunctionSettings(sql, { scope: "session" });
      await sql.unsafe(`PREPARE bench_exact(vector(${DIM}), float, int, jsonb, float, float) AS ${body}`);
      const viaExact = (q: number[], filter: string) => `EXECUTE bench_exact('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0)`;
      exact = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!, viaExact);
      await sql.unsafe(`DEALLOCATE bench_exact`);
      for (const name of applied) await sql.unsafe(`RESET ${name}`);
    }
    bounds.push({ scale: n, label: t.label, matches: t.matches, tuples: Math.round((V_FETCH * n) / t.matches), seeded, defaults, raised, exact });
    process.stdout.write(".");
  }
  console.log(" done");

  // D. The walk, forced. The function answers thin filters exactly and never
  // walks for them, so the bounds it seeds are not reached through the
  // function for them at any scale. This section runs the walk branch's own
  // statement — extracted from the catalog as section C does — under the
  // function's scan mode and a forced generic plan (the filter a parameter, so
  // the chunk side, whose filter lives on the parent row, walks its HNSW index
  // and looks each candidate's parent up), on the thin and empty filters. It
  // shows what the seeded bounds do when the walk IS reached with next to
  // nothing to find: the cost of a walk that cannot stop early. It runs last
  // for its scale — the next scale resets the schema — so nothing needs
  // restoring.
  process.stdout.write("  the walk, forced  ");
  const walkBody = await extractBody(sql, "walk", DIM);
  // The function's own SET clauses, session-scoped since the EXECUTEs below run
  // outside a transaction — under 019 that is the scan mode AND enable_seqscan,
  // and a plan the deployed function cannot produce is not worth timing.
  const applied = await applyFunctionSettings(sql, { scope: "session" });
  await sql.unsafe(`SET plan_cache_mode = force_generic_plan`);
  await sql.unsafe(`PREPARE bench_walk(vector(${DIM}), float, int, jsonb, float, float) AS ${walkBody}`);
  const viaWalk = (q: number[], filter: string) => `EXECUTE bench_walk('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0)`;
  const thin = withCounts.filter((t) => t.matches <= V_EXACT && (t.share <= 0.001 || t.key === "none"));
  for (const t of thin) {
    const r = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!, viaWalk);
    walk.push({ scale: n, label: t.label, matches: t.matches, ...r });
    process.stdout.write(".");
  }
  await sql.unsafe(`DEALLOCATE bench_walk`);
  await sql.unsafe(`RESET plan_cache_mode`);
  for (const name of applied) await sql.unsafe(`RESET ${name}`);
  console.log(" done");
}

await sql.close();

// ── Report ──────────────────────────────────────────────────────────────────

const mb = (b: number) => (b / 1048576).toFixed(0);

console.log("\n### L. The load: insert rate, HNSW build time and relation sizes\n");
console.log("Rows go in as multi-row INSERTs with the vector indexes dropped; the indexes are built afterwards with the maintenance_work_mem shown. Sizes are pg_table_size (heap + TOAST) and pg_relation_size (index), in MB.\n");
console.log("| rows | insert s | rows/s | chunk rows | chunk s | thoughts MB | thoughts HNSW MB | build s | chunks MB | chunks HNSW MB | build s | maintenance_work_mem | workers |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
for (const l of loads) {
  console.log(
    `| ${l.scale.toLocaleString()} | ${l.insertS.toFixed(0)} | ${Math.round(l.scale / l.insertS).toLocaleString()} | ${l.chunkRows.toLocaleString()} | ${l.chunkS.toFixed(0)} | ${mb(l.sizes.thoughts)} | ${mb(l.sizes.thoughts_embedding_idx)} | ${l.buildS.thoughts_embedding_idx.toFixed(0)} | ${mb(l.sizes.thought_chunks)} | ${mb(l.sizes.thought_chunks_embedding_idx)} | ${l.buildS.thought_chunks_embedding_idx.toFixed(0)} | ${l.maintenanceMem} | ${l.workers} |`
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
console.log("plpgsql runs custom plans for the first five calls, then generic if it is not costlier; both are shown.\n");
console.log("`route` is the capped id collection that runs on every filtered call and decides between the other two; it has no chunk side.\n");
console.log("| rows | branch | filter | matching rows | thoughts side | chunk side | exec ms |");
console.log("| ---: | --- | ---: | ---: | --- | --- | ---: |");
for (const r of results) {
  if (!r.plan) continue;
  for (const { branch, tier, matches, custom, generic } of Object.values(r.plan)) {
    const chunks = branch === "route" ? "—" : `${custom.chunks} / ${generic.chunks}`;
    console.log(
      `| ${r.scale.toLocaleString()} | ${branch} | ${tier} | ${matches.toLocaleString()} | ${custom.thoughts} / ${generic.thoughts} | ${chunks} | ${custom.ms.toFixed(2)} / ${generic.ms.toFixed(2)} |`
    );
  }
}
if (PRINT_PLANS) {
  for (const r of results) {
    if (!r.plan) continue;
    for (const [key, { branch, tier, custom, generic }] of Object.entries(r.plan)) {
      for (const [mode, shape] of [["custom", custom], ["generic", generic]] as const) {
        console.log(`\n#### ${r.scale.toLocaleString()} rows, ${branch} branch (${key}, ${tier}), ${mode} plan\n`);
        console.log(shape.text.replace(/\[[-\d.,e]+\]'::vector/g, "[…]'::vector"));
      }
    }
  }
}

console.log("\n### D. The walk branch, forced onto thin and empty filters (generic plan)\n");
console.log("The function answers these exactly and never walks for them; this runs the walk's own statement on them to show what the two scan bounds do when the walk is reached with next to nothing to find.\n");
console.log("| rows | filter matches | matching rows | returned | in exact top-10 | exact has | median ms |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const g of walk) {
  console.log(
    `| ${g.scale.toLocaleString()} | ${g.label} | ${g.matches.toLocaleString()} | ${g.returned.toFixed(1)} | ${g.overlap.toFixed(1)} | ${g.exact.toFixed(1)} | ${g.ms.toFixed(2)} |`
  );
}

console.log(`\n### E. The walk through the function, under the seeded bounds (${HNSW_BOUNDS.map((b) => b.replace("hnsw.", "")).join(" / ")} as in force), under pgvector's defaults (${Object.values(PGVECTOR_DEFAULTS).join(" / ")}), and under the seeded bounds with hnsw.ef_search = ${EF_SEARCH_RAISED}, beside the exact branch with its threshold lifted to the same tier\n`);
console.log(`"walk visits" is the header's arithmetic, v_fetch × N / matching rows (${V_FETCH} × N / matches): the tuples the walk must pass to fill its candidate budget, against the seeded cap of 100,000 and pgvector's 20,000. The exact column is measured only where an exact answer is conceivable (at most ${EXACT_CEILING.toLocaleString()} matching rows).\n`);
console.log(`| rows | filter matches | matching rows | walk visits | seeded: returned | in exact top-10 | median ms | defaults: returned | in exact top-10 | median ms | ef_search ${EF_SEARCH_RAISED}: returned | in exact top-10 | median ms | exact branch: returned | in exact top-10 | median ms |`);
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
const cell = (r: FilteredResult) => `${r.returned.toFixed(1)} | ${r.overlap.toFixed(1)} | ${r.ms.toFixed(2)}`;
for (const b of bounds) {
  console.log(
    `| ${b.scale.toLocaleString()} | ${b.label} | ${b.matches.toLocaleString()} | ${b.tuples.toLocaleString()} | ${cell(b.seeded)} | ${cell(b.defaults)} | ${cell(b.raised)} | ${b.exact ? cell(b.exact) : "— | — | —"} |`
  );
}
console.log();
