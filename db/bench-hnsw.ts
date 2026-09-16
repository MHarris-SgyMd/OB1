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
 *   L. The load itself, at every scale: rows per second into a table with
 *      every secondary index dropped and its user triggers disabled (the
 *      audit and entity-extraction triggers would otherwise write a row per
 *      row, and the schema under the load differs between the arms), the HNSW
 *      build time for each vector index once the rows are in, the other
 *      indexes' rebuild, and the table and index sizes. Only the INSERT
 *      round-trips are timed; the generator and the confound check run
 *      between them, untimed. 014's header argued the walk's bounds
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
 *      table, which is the point: the same filter, a growing brain. A fixed
 *      count is planted only where it is under half the table (5,000 rows at
 *      the default 10,000 says nothing the 50% tier does not), and where it
 *      lands on a share tier's exact share the two are one tier under both
 *      names; the run says which tiers it dropped or merged. (A row count is
 *      a nominal size — membership is a coin per row — so the table prints
 *      the count actually planted, and a tier goes to section D or E by that
 *      count against the threshold, not by its name: the 0.1% tier at a
 *      million rows plants about 1,000 and lands on either side.)
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
 *   # a million rows and up: one scale per container, with the shared memory
 *   # the parallel build needs — the two commands are in db/README.md
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
 * index's own at the default ef_search (section A's control: 8.3 / 4.7 / 2.2
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
 * only to reach the queries, which the stream yields after the rows (the
 * generator's step is additive, so the skip is one multiply), the second to
 * insert — so at 10,000 and 100,000 rows the vectors, the queries and the
 * share tiers' membership are exactly the published corpus's while nothing
 * holds N vectors in memory. Not byte for byte: each row's metadata now also
 * carries whichever fixed-count tiers it fell into, so the heap and the GIN
 * index are a little wider than the published run's. Bun's SQL driver has no
 * COPY protocol (a `COPY ... FROM STDIN` hangs), so the rows go in as
 * multi-row INSERTs into a table whose secondary indexes have been dropped
 * and whose user triggers are disabled for the load (so 008's audit table
 * stays empty, where the published run's held a row per thought); the indexes
 * are rebuilt after it, with `maintenance_work_mem` sized for the graph. That
 * is also how a brain that size would be bulk-loaded.
 */

import { SQL } from "bun";
import { applyFunctionSettings, applyMigrations, explainPrepared, extractBody, requireDatabaseUrl, resetSchema, routingAt, seededRandom } from "./test-support.ts";
import type { Branch } from "./test-support.ts";
import { BOUNDS_IN_FORCE_SQL, DB_LEVEL_SETTINGS_SQL, HNSW_BOUNDS, HNSW_SEEDS, parseSetConfig } from "./config.mjs";

const URL_ = requireDatabaseUrl("bench-hnsw.ts");
const PRINT_PLANS = process.argv.includes("--plans");

const DIM = 64;
// No trigram index: nothing here reads content, and 011's GIN would otherwise
// be maintained for every row of the load (review pass).
const OPTS = { dim: DIM, model: "stub-embed", trgm: false };
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
  .map((s) => Number(s.trim()));
if (SCALES.some((n) => !Number.isInteger(n) || n <= 0)) {
  // Validated up front like Q: a fraction would pass every step until the
  // generator's skip refused it, after the schema had been rebuilt.
  console.error(`OB1_BENCH_SCALES must be positive integers (got ${JSON.stringify(process.env.OB1_BENCH_SCALES)})`);
  process.exit(2);
}
/** Random queries per selectivity. Validated: a typo here would surface only after the load. */
const Q = Number(process.env.OB1_BENCH_QUERIES ?? 50);
if (!Number.isInteger(Q) || Q < 1) {
  console.error(`OB1_BENCH_QUERIES must be a positive integer (got ${JSON.stringify(process.env.OB1_BENCH_QUERIES)})`);
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
/** The two vector indexes the load drops and rebuilds, timed each; section L reads them by these names. */
const HNSW_INDEXES = ["thoughts_embedding_idx", "thought_chunks_embedding_idx"] as const;
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
function tiersAt(n: number): { tiers: Tier[]; notes: string[] } {
  const out: Tier[] = [];
  const notes: string[] = [];
  // Membership is one draw against the share, so two tiers with the same
  // share are the same rows under two names (5,000 rows at five million is
  // the 0.1% tier, 2,000 at 20,000 the 10% one); they are one tier, labelled
  // with both names, so nothing is measured twice and nothing vanishes.
  const aliases = new Map<string, string[]>();
  const push = (t: Tier) => {
    const twin = out.find((o) => o.share === t.share);
    if (twin) {
      aliases.set(twin.key, [...(aliases.get(twin.key) ?? []), t.label]);
      notes.push(`${t.label} is the ${twin.label} tier at this scale`);
    } else out.push(t);
  };
  for (const t of TIERS) {
    if ("rows" in t) {
      if (t.rows >= n / 2) {
        notes.push(`${t.rows.toLocaleString()} rows is at least half the table; not planted`);
        continue;
      }
      push({ key: t.key, share: t.rows / n, label: `${t.rows.toLocaleString()} rows` });
    } else if (t.share === 0) {
      push({ key: t.key, share: 0, label: "nothing" });
    } else if (n * t.share >= 1) {
      push({ key: t.key, share: t.share, label: `${t.share * 100}%` });
    } else {
      notes.push(`${t.share * 100}% of ${n.toLocaleString()} rows is under one row; not planted`);
    }
  }
  for (const t of out) if (aliases.has(t.key)) t.label = `${t.label} (also the ${aliases.get(t.key)!.join(" and the ")} tier)`;
  return { tiers: out.sort((a, b) => b.share - a.share), notes };
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
  const { skip, unitVector } = seedFor(n);
  skip(n * (1 + 2 * DIM));
  return Array.from({ length: Q }, () => unitVector(DIM));
}

// The skip must equal the draws it stands in for, or the queries are not the
// published ones: checked once against a thousand real draws before anything
// loads.
{
  const a = seedFor(1);
  const b = seedFor(1);
  for (let i = 0; i < 1000; i++) a.rnd();
  b.skip(1000);
  if (a.rnd() !== b.rnd()) throw new Error("seededRandom.skip does not reproduce the stream; the queries would not be the published ones");
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
  schema: string;
  confound: number;
  insertS: number;
  chunkRows: number;
  chunkS: number;
  buildS: Record<string, number>;
  otherIndexesS: number;
  sizes: Record<string, number>;
  maintenanceMem: string;
  workers: number;
};

/**
 * The load: every secondary index on both tables dropped and the user
 * triggers disabled, rows streamed in, chunk rows derived server-side, the
 * indexes rebuilt with `maintenance_work_mem` sized for the graph (the HNSW
 * ones timed each, the rest together), triggers re-enabled, everything
 * measured. Only the INSERT round-trips count towards `insertS`: the
 * generator, the JSON and the confound check run between them on the client
 * and would otherwise scale the "load" with OB1_BENCH_QUERIES. The schema
 * under the load differs between the arms (001–013 or the whole set), which
 * is why the indexes and triggers come off: what remains per row is the heap
 * and the primary key, the same in both. Returns the tier match counts too —
 * counted as the rows are generated, so no pass over the table is needed.
 */
async function load(sql: SQL, n: number, schema: string, tiers: Tier[], queries: number[][]): Promise<{ stats: LoadStats; matches: Map<string, number> }> {
  // Every index on the two tables that a constraint does not own — the
  // primary keys stay, and so would a UNIQUE constraint's index if one were
  // added (none today; 003's unique partial index is a plain index).
  const secondary: { name: string; def: string }[] = await sql.unsafe(
    `SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname = 'public' AND t.relname IN ('thoughts', 'thought_chunks')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
     ORDER BY i.relname`
  );
  for (const name of HNSW_INDEXES) {
    if (!secondary.some((i) => i.name === name)) throw new Error(`index ${name} is not defined; the load cannot rebuild it`);
  }
  for (const i of secondary) await sql.unsafe(`DROP INDEX ${i.name}`);
  // User triggers only (008's audit, 016's entity extraction, the updated_at
  // trigger): ALL would take the FK triggers too and needs a superuser.
  for (const rel of ["thoughts", "thought_chunks"]) await sql.unsafe(`ALTER TABLE ${rel} DISABLE TRIGGER USER`);
  // A bulk load's commit latency is not what is measured; the WAL is still written.
  await sql.unsafe(`SET synchronous_commit = off`);

  const confound = new Confound(queries);
  const matches = new Map<string, number>(tiers.map((t) => [t.key, 0]));
  let insertMs = 0;
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
    const t0 = performance.now();
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
    insertMs += performance.now() - t0;
    done += batch.length;
    if (done % 1_000_000 === 0) process.stdout.write(`${(done / 1e6).toFixed(0)}M `);
  }
  const insertS = insertMs / 1000;
  // Refuse before the builds, not after them: a repeating generator should
  // cost the load, not the load plus twenty minutes of index.
  const nearest = confound.assert();

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
  // The parallel build keeps its graph in dynamic shared memory sized by this
  // setting, and the container's /dev/shm is the ceiling (with-postgres.sh
  // gives 1 GB unless OB1_PG_SHM_SIZE says more). Nothing here can read the
  // ceiling, so say what the build is about to ask for.
  if (BUILD_WORKERS > 0) process.stdout.write(`(parallel build under ${maintenanceMem}: /dev/shm must hold it — OB1_PG_SHM_SIZE) `);
  await sql.unsafe(`SET maintenance_work_mem = '${maintenanceMem}'`);
  // pgvector says when the graph stops fitting in maintenance_work_mem with a
  // NOTICE, which this driver does not surface; sent to the server log it can
  // be read after the run (`podman logs`). Superuser-only, so best effort.
  await sql.unsafe(`SET log_min_messages = notice`).catch(() => undefined);
  await sql.unsafe(`SET max_parallel_maintenance_workers = ${BUILD_WORKERS}`);
  const buildS: Record<string, number> = {};
  let otherIndexesS = 0;
  for (const { name, def } of secondary) {
    const t2 = performance.now();
    await sql.unsafe(def);
    const s = (performance.now() - t2) / 1000;
    if ((HNSW_INDEXES as readonly string[]).includes(name)) buildS[name] = s;
    else otherIndexesS += s;
  }
  for (const rel of ["thoughts", "thought_chunks"]) await sql.unsafe(`ALTER TABLE ${rel} ENABLE TRIGGER USER`);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
  const sizes: Record<string, number> = {};
  for (const rel of ["thoughts", "thought_chunks"]) sizes[rel] = Number((await sql.unsafe(`SELECT pg_table_size($1::regclass)::bigint AS b`, [rel]))[0].b);
  for (const name of HNSW_INDEXES) sizes[name] = Number((await sql.unsafe(`SELECT pg_relation_size($1::regclass)::bigint AS b`, [name]))[0].b);
  for (const name of ["synchronous_commit", "maintenance_work_mem", "max_parallel_maintenance_workers"]) await sql.unsafe(`RESET ${name}`);
  await sql.unsafe(`RESET log_min_messages`).catch(() => undefined);

  return {
    stats: { scale: n, schema, confound: nearest, insertS, chunkRows: Number(chunkRows), chunkS, buildS, otherIndexesS, sizes, maintenanceMem, workers: BUILD_WORKERS },
    matches,
  };
}

// ── The measurements ────────────────────────────────────────────────────────

/** The `wants` key for the exact answer over the whole table (section A's control); no tier is keyed so. */
const WHOLE_TABLE = "whole table";

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
  const time = async (count: number): Promise<{ ms: number; overlap: number }> => {
    const times: number[] = [];
    let overlap = 0;
    for (const [i, q] of queries.entries()) {
      const t0 = performance.now();
      const got = (await sql.unsafe(`SELECT id FROM match_thoughts('${lit(q)}'::vector, -1.0, ${count}, '{}'::jsonb)`)).map((r: { id: string }) => r.id);
      times.push(performance.now() - t0);
      overlap += got.filter((id) => wants[i].has(id)).length;
    }
    return { ms: median(times), overlap: overlap / queries.length };
  };
  const at10 = await time(K);
  const atMax = await time(ASKS[ASKS.length - 1]);
  // The same default-path call with the index asked to look harder: the
  // function does not set ef_search, so a session SET reaches it.
  await sql.unsafe(`SET hnsw.ef_search = ${EF_SEARCH_RAISED}`);
  const raised = await time(K);
  await sql.unsafe(`RESET hnsw.ef_search`);
  return { counts, ms10: at10.ms, msMax: atMax.ms, overlap: at10.overlap, ms10Raised: raised.ms, overlapRaised: raised.overlap };
}

/**
 * Exact top-K within a filter. The function scores MAX over a thought's own
 * vector and its chunks; here every chunk carries its parent's vector (see
 * the load), so that MAX is the parent's score and the thoughts table alone
 * is the exact answer — `chunksCarryParentVectors` holds the bench to that
 * once per scale, loudly, so a future chunk-vector change cannot make this
 * oracle quietly wrong (an earlier draft joined and aggregated the chunk
 * table on every call for no answer it changed). The vector index is an
 * Index Scan and nothing else, so `enable_indexscan = off` keeps it out of
 * the plan; the GIN index reaches the table through a bitmap and stays
 * available, because a filter's bitmap is exact by construction and a thin
 * filter at ten million rows should not cost a sequential scan per query.
 * A null filter is the whole table, with no predicate to evaluate on every
 * row. Correct by construction, slow on purpose where the filter is broad —
 * which is why it runs once per (tier, query) and not once per arm.
 */
async function oracle(sql: SQL, q: number[], filter: string | null): Promise<Set<string>> {
  const rows = await sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL enable_indexscan = off`);
    return tx.unsafe(`
      SELECT t.id FROM thoughts t
      WHERE t.embedding IS NOT NULL${filter === null ? "" : ` AND t.metadata @> '${filter}'::jsonb`}
      ORDER BY t.embedding <=> '${lit(q)}'::vector LIMIT ${K}`);
  });
  return new Set(rows.map((r: { id: string }) => r.id));
}

async function chunksCarryParentVectors(sql: SQL): Promise<void> {
  const [{ c }] = await sql.unsafe(
    `SELECT count(*)::int AS c FROM thought_chunks c JOIN thoughts t ON t.id = c.thought_id WHERE c.embedding IS DISTINCT FROM t.embedding`
  );
  if (Number(c) !== 0) throw new Error(`${c} chunk rows carry a vector other than their parent's; the oracle would no longer be exact`);
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

type Plans = { custom: PlanShape; generic: PlanShape; genericNoJit: PlanShape };

async function plans(sql: SQL, q: number[], filter: string, branch: Branch): Promise<Plans> {
  const body = await extractBody(sql, branch, DIM);
  const arm = async (mode: "force_custom_plan" | "force_generic_plan", jit: boolean): Promise<PlanShape> => {
    const { text, ms } = await sql.begin(async (tx: SQL) => {
      // Function-level SETs are not in effect outside the function; apply the
      // same settings the function declares so the plan is the one it gets —
      // all but a plan mode, since this section exists to show both plans.
      await applyFunctionSettings(tx);
      if (!jit) await tx.unsafe(`SET LOCAL jit = off`);
      return explainPrepared(tx, { body, dim: DIM, args: `'${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0`, mode });
    });
    return shapeOf(text, ms);
  };
  // The generic plan twice: as the function would get it, and with JIT off.
  // At ten million rows every generic plan carried 30–130 ms of startup its
  // custom twin did not, and the flat estimate that makes a plan generic is
  // also what carries its cost past jit_above_cost; the third arm reads that
  // rather than inferring it (SMD-1018 review pass).
  return { custom: await arm("force_custom_plan", true), generic: await arm("force_generic_plan", true), genericNoJit: await arm("force_generic_plan", false) };
}

/**
 * PREPARE an extracted statement under the function's own settings and a
 * plan mode, hand the caller an EXECUTE builder for it, and take everything
 * down afterwards — the bracket sections D and E both open (session scope,
 * since the EXECUTEs run outside a transaction; the caller's plan mode,
 * since the two sections exist to pin different ones).
 */
async function withPrepared<T>(
  name: string,
  body: string,
  mode: "force_custom_plan" | "force_generic_plan",
  run: (via: (q: number[], filter: string) => string) => Promise<T>
): Promise<T> {
  const applied = await applyFunctionSettings(sql, { scope: "session" });
  await sql.unsafe(`SET plan_cache_mode = ${mode}`);
  await sql.unsafe(`PREPARE ${name}(vector(${DIM}), float, int, jsonb, float, float) AS ${body}`);
  const result = await run((q, filter) => `EXECUTE ${name}('${lit(q)}'::vector, -1.0, ${K}, '${filter}'::jsonb, 0.0, 90.0)`);
  await sql.unsafe(`DEALLOCATE ${name}`);
  await sql.unsafe(`RESET plan_cache_mode`);
  for (const setting of applied) await sql.unsafe(`RESET ${setting}`);
  return result;
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
type Cell = FilteredResult & { label: string; matches: number };
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
  plan?: Record<string, { branch: Branch; tier: string; matches: number } & Plans>;
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

/**
 * The deployed function's v_fetch and v_exact at K — read from its own
 * DECLARE block and evaluated by the server once the after arm is in place
 * (test-support's routingAt), so the tiers are routed by the threshold the
 * function actually has, not by a copy of 014's arithmetic.
 */
let routing = { vFetch: NaN, vExact: NaN };
/**
 * pgvector's own defaults for the bounds 014 seeds, read from the server once
 * the library is loaded (`pg_settings.boot_val`) over the same HNSW_BOUNDS
 * list the in-force assertion and the RESETs use — not a second literal map,
 * which a third seeded bound would have left out of the "defaults" arm
 * (third review pass).
 */
let pgvectorDefaults: Record<string, string> = {};
async function readPgvectorDefaults(sql: SQL): Promise<Record<string, string>> {
  // The hnsw.* settings exist in pg_settings only once the library is loaded
  // in THIS session (014's header: they come from vector.so, not the catalog),
  // and this runs right after a reconnect. One cast loads it.
  await sql.unsafe(`SELECT '[1]'::vector`);
  const rows = await sql.unsafe(`SELECT name, boot_val FROM pg_settings WHERE name = ANY($1)`, [sql.array(HNSW_BOUNDS, "TEXT")]);
  const out: Record<string, string> = Object.fromEntries(rows.map((r: { name: string; boot_val: string }) => [r.name, r.boot_val]));
  for (const b of HNSW_BOUNDS) if (!(b in out)) throw new Error(`pg_settings has no boot value for ${b}; is pgvector loaded in this session?`);
  return out;
}
/** The raised `hnsw.ef_search` for the recall controls in sections A and E; pgvector's default is 40, the function leaves it alone. */
const EF_SEARCH_RAISED = 400;
/**
 * Section E measures the exact branch on a walk tier up to this many matching
 * rows: every tier to 1% of a ten-million-row table, so the tiers the walk
 * actually walks at scale have the exact branch measured beside them — the
 * first draft stopped at 50,000 and left the 1% tier at ten million as a
 * dash, which is where the "exact would be faster" claim most needs a number
 * (review pass). With headroom over the nominal 100,000: the planted count
 * is binomial about it, and a ceiling AT the mean would print the dash on
 * half of all seeds. Scoring the 50% tier row by row is still not a candidate.
 */
const EXACT_CEILING = 110_000;

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
  const { tiers, notes } = tiersAt(n);
  for (const note of notes) console.log(`  (${note})`);
  const queries = queriesFor(n);
  process.stdout.write("  inserting         ");
  const { stats, matches } = await load(sql, n, beforeArm ? "001–013" : "whole", tiers, queries);
  await chunksCarryParentVectors(sql);
  loads.push(stats);
  console.log(`done — ${stats.insertS.toFixed(0)} s, nearest query-to-row cosine ${stats.confound.toFixed(3)} (a repeat would read 1.000)`);
  console.log(`  HNSW builds       ${Object.entries(stats.buildS).map(([k, s]) => `${k} ${s.toFixed(0)} s`).join(", ")}, other indexes ${stats.otherIndexesS.toFixed(0)} s (maintenance_work_mem ${stats.maintenanceMem}, up to ${stats.workers} workers)`);

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
  // And over the whole table, for section A's recall control.
  {
    const answers: Set<string>[] = [];
    for (const q of queries) answers.push(await oracle(sql, q, null));
    wants.set(WHOLE_TABLE, answers);
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
      if (beforeArm) {
        await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "014" });
        // 023's apply-time fingerprint backfill UPDATEs every loaded row (none
        // carries a fingerprint), and the column is indexed, so the update is
        // not HOT: every row gets a new heap tuple and a second, identical
        // entry in the HNSW index beside its dead twin. Left there, half the
        // scan's ef_search frontier is dead tuples and the published scales'
        // recall floor is measured on a graph the large scales (schema applied
        // to an empty table) never have (third review pass). VACUUM removes
        // the dead entries; ANALYZE refreshes what 023's rewrite moved.
        await sql.unsafe(`VACUUM ANALYZE thoughts`);
        await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
      }
      await reconnect(); // the database-level bounds 014 seeded are read at connect
      const inForce = Object.fromEntries((await sql.unsafe(BOUNDS_IN_FORCE_SQL)).map((r: { name: string; value: string | null }) => [r.name, r.value]));
      const [row] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
      const cfg = parseSetConfig(row?.cfg);
      if (HNSW_BOUNDS.some((b) => cfg[b] !== inForce[b])) {
        throw new Error(`session did not pick up the database-level bounds (in force ${JSON.stringify(inForce)}; database has ${JSON.stringify(cfg)})`);
      }
      console.log(`  bounds in force: ${HNSW_BOUNDS.map((b) => `${b}=${inForce[b]}`).join(", ")}`);
      routing = await routingAt(sql, K);
      pgvectorDefaults = await readPgvectorDefaults(sql);
      console.log(`  routing at K=${K}: v_fetch ${routing.vFetch}, exact threshold ${routing.vExact} matching thoughts; pgvector defaults ${HNSW_BOUNDS.map((b) => `${b}=${pgvectorDefaults[b]}`).join(", ")}`);
    }
    process.stdout.write(`  ${arm.padEnd(18)}`);
    const { counts, ms10, msMax, overlap, ms10Raised, overlapRaised } = await unfiltered(sql, queries, wants.get(WHOLE_TABLE)!);
    const cells: Cell[] = [];
    for (const t of withCounts) {
      const r = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
      cells.push({ ...r, label: t.label, matches: t.matches });
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
    const walkTier = withRows.find((t) => t.matches > routing.vExact);
    const exactTier = [...withRows].reverse().find((t) => t.matches <= routing.vExact);
    const broadest = withRows[withRows.length - 1];
    const thinnest = withRows[0];
    const plan: Result["plan"] = arm === "after (014 on)" ? {} : undefined;
    if (plan) {
      if (walkTier) plan.walk = { branch: "walk", tier: walkTier.label, matches: walkTier.matches, ...(await plans(sql, queries[0], tierFilter(walkTier.key), "walk")) };
      else console.log(`\n  (no tier above the exact threshold of ${routing.vExact} rows at this scale; the walk branch is not explained)`);
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
  // statement is extracted with `v_exact` overridden to just past the tier,
  // for tiers up to a bound where an exact answer is still conceivable —
  // scoring the 50% tier row by row is not a candidate for anything — and
  // PREPAREd under a forced custom plan: the function's medians above are
  // custom plans' (plpgsql's first five and, in every session here, the rest),
  // and a comparison against them must not drift onto the generic plan and
  // its JIT after the fifth EXECUTE (review pass).
  process.stdout.write("  bounds, via fn    ");
  const walkTiers = withCounts.filter((t) => t.matches > routing.vExact).sort((a, b) => a.matches - b.matches);
  for (const t of walkTiers) {
    const seeded = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    for (const name of HNSW_BOUNDS) await sql.unsafe(`SET ${name} = ${pgvectorDefaults[name]}`);
    const defaults = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    for (const name of HNSW_BOUNDS) await sql.unsafe(`RESET ${name}`);
    await sql.unsafe(`SET hnsw.ef_search = ${EF_SEARCH_RAISED}`);
    const raised = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!);
    await sql.unsafe(`RESET hnsw.ef_search`);
    let exact: FilteredResult | undefined;
    if (t.matches <= EXACT_CEILING) {
      const body = await extractBody(sql, "exact", DIM, { overrides: { v_exact: String(t.matches + 1) } });
      exact = await withPrepared("bench_exact", body, "force_custom_plan", (via) => filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!, via));
    }
    bounds.push({ scale: n, label: t.label, matches: t.matches, tuples: Math.round((routing.vFetch * n) / t.matches), seeded, defaults, raised, exact });
    process.stdout.write(".");
  }
  console.log(" done");

  // D. The walk, forced. The function answers thin filters exactly and never
  // walks for them, so the bounds it seeds are not reached through the
  // function for them at any scale. This section runs the walk branch's own
  // statement — extracted from the catalog as section C does — under the
  // function's scan mode and a forced generic plan (the filter a parameter, so
  // the chunk side, whose filter lives on the parent row, walks its HNSW index
  // and looks each candidate's parent up), on every tier under the threshold
  // — the same count gate section E uses from the other side — and the empty
  // one. It
  // shows what the seeded bounds do when the walk IS reached with next to
  // nothing to find: the cost of a walk that cannot stop early. It runs last
  // for its scale — the next scale resets the schema — so nothing needs
  // restoring.
  process.stdout.write("  the walk, forced  ");
  // Under the function's own SET clauses — under 019 that is the scan mode AND
  // enable_seqscan, and a plan the deployed function cannot produce is not
  // worth timing — and a forced generic plan.
  const walkBody = await extractBody(sql, "walk", DIM);
  const thin = withCounts.filter((t) => t.matches <= routing.vExact);
  await withPrepared("bench_walk", walkBody, "force_generic_plan", async (via) => {
    for (const t of thin) {
      const r = await filtered(sql, queries, tierFilter(t.key), wants.get(t.key)!, via);
      walk.push({ scale: n, label: t.label, matches: t.matches, ...r });
      process.stdout.write(".");
    }
  });
  console.log(" done");
}

await sql.close();

// ── Report ──────────────────────────────────────────────────────────────────

const mb = (b: number) => (b / 1048576).toFixed(0);

console.log("\n### L. The load: insert rate, HNSW build time and relation sizes\n");
console.log("Rows go in as multi-row INSERTs with every secondary index dropped and user triggers disabled (\"schema\" is what the table carried: 001–013 where the before arm runs, the whole set above); only the INSERT round-trips are timed. The indexes are built afterwards with the maintenance_work_mem shown — the two HNSW builds timed each, the others together. Sizes are pg_table_size (heap + TOAST) and pg_relation_size (index), in MB. \"workers\" is the cap given to max_parallel_maintenance_workers, not the count launched.\n");
console.log("| rows | schema | insert s | rows/s | chunk rows | chunk s | thoughts MB | thoughts HNSW MB | build s | chunks MB | chunks HNSW MB | build s | other indexes s | maintenance_work_mem | workers |");
console.log("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
for (const l of loads) {
  console.log(
    `| ${l.scale.toLocaleString()} | ${l.schema} | ${l.insertS.toFixed(0)} | ${Math.round(l.scale / l.insertS).toLocaleString()} | ${l.chunkRows.toLocaleString()} | ${l.chunkS.toFixed(0)} | ${mb(l.sizes.thoughts)} | ${mb(l.sizes.thoughts_embedding_idx)} | ${l.buildS.thoughts_embedding_idx.toFixed(0)} | ${mb(l.sizes.thought_chunks)} | ${mb(l.sizes.thought_chunks_embedding_idx)} | ${l.buildS.thought_chunks_embedding_idx.toFixed(0)} | ${l.otherIndexesS.toFixed(0)} | ${l.maintenanceMem} | ${l.workers} |`
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
console.log("plpgsql runs custom plans for the first five calls, then generic if it is not costlier; both are shown, and the generic plan once more with `jit = off` — the flat estimate that makes a plan generic can also carry its cost past jit_above_cost, and the difference between the last two columns is what JIT costs the call.\n");
console.log("`route` is the capped id collection that runs on every filtered call and decides between the other two; it has no chunk side.\n");
console.log("| rows | branch | filter | matching rows | thoughts side | chunk side | exec ms: custom / generic / generic, jit off |");
console.log("| ---: | --- | ---: | ---: | --- | --- | ---: |");
for (const r of results) {
  if (!r.plan) continue;
  for (const { branch, tier, matches, custom, generic, genericNoJit } of Object.values(r.plan)) {
    const chunks = branch === "route" ? "—" : `${custom.chunks} / ${generic.chunks}`;
    console.log(
      `| ${r.scale.toLocaleString()} | ${branch} | ${tier} | ${matches.toLocaleString()} | ${custom.thoughts} / ${generic.thoughts} | ${chunks} | ${custom.ms.toFixed(2)} / ${generic.ms.toFixed(2)} / ${genericNoJit.ms.toFixed(2)} |`
    );
  }
}
if (PRINT_PLANS) {
  for (const r of results) {
    if (!r.plan) continue;
    for (const [key, { branch, tier, custom, generic, genericNoJit }] of Object.entries(r.plan)) {
      for (const [mode, shape] of [["custom", custom], ["generic", generic], ["generic, jit off", genericNoJit]] as const) {
        console.log(`\n#### ${r.scale.toLocaleString()} rows, ${branch} branch (${key}, ${tier}), ${mode} plan\n`);
        console.log(shape.text.replace(/\[[-\d.,e]+\]'::vector/g, "[…]'::vector"));
      }
    }
  }
}

console.log("\n### D. The walk branch, forced onto thin and empty filters (generic plan)\n");
console.log("Every tier under the exact threshold, and the empty filter. The function answers these exactly and never walks for them; this runs the walk's own statement on them to show what the two scan bounds do when the walk is reached with next to nothing to find.\n");
console.log("| rows | filter matches | matching rows | returned | in exact top-10 | exact has | median ms |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const g of walk) {
  console.log(
    `| ${g.scale.toLocaleString()} | ${g.label} | ${g.matches.toLocaleString()} | ${g.returned.toFixed(1)} | ${g.overlap.toFixed(1)} | ${g.exact.toFixed(1)} | ${g.ms.toFixed(2)} |`
  );
}

console.log(`\n### E. The walk through the function, under the seeded bounds (${HNSW_BOUNDS.map((b) => `${b.replace("hnsw.", "")}=${HNSW_SEEDS[b as keyof typeof HNSW_SEEDS]}`).join(", ")}), under pgvector's defaults (${HNSW_BOUNDS.map((b) => `${b.replace("hnsw.", "")}=${pgvectorDefaults[b]}`).join(", ")}), and under the seeded bounds with hnsw.ef_search = ${EF_SEARCH_RAISED}, beside the exact branch with its threshold lifted to the same tier\n`);
console.log(`"walk visits" is the header's arithmetic, v_fetch × N / matching rows (${routing.vFetch} × N / matches): the tuples the walk must pass to fill its candidate budget, against the seeded cap of ${Number(HNSW_SEEDS["hnsw.max_scan_tuples"]).toLocaleString()} and pgvector's ${Number(pgvectorDefaults["hnsw.max_scan_tuples"]).toLocaleString()}. The exact column is the exact branch's own statement with v_exact lifted past the tier, under a forced custom plan (the plan the function's medians are), measured only where an exact answer is conceivable (at most ${EXACT_CEILING.toLocaleString()} matching rows).\n`);
console.log(`| rows | filter matches | matching rows | walk visits | seeded: returned | in exact top-10 | median ms | defaults: returned | in exact top-10 | median ms | ef_search ${EF_SEARCH_RAISED}: returned | in exact top-10 | median ms | exact branch: returned | in exact top-10 | median ms |`);
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
const cell = (r: FilteredResult) => `${r.returned.toFixed(1)} | ${r.overlap.toFixed(1)} | ${r.ms.toFixed(2)}`;
for (const b of bounds) {
  console.log(
    `| ${b.scale.toLocaleString()} | ${b.label} | ${b.matches.toLocaleString()} | ${b.tuples.toLocaleString()} | ${cell(b.seeded)} | ${cell(b.defaults)} | ${cell(b.raised)} | ${b.exact ? cell(b.exact) : "— | — | —"} |`
  );
}
console.log();
