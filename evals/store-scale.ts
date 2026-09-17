#!/usr/bin/env bun
/**
 * store-scale.ts — SMD-1037, the scale arm: at 1M and 10M rows, does an engine's
 * recall-vs-exact or its p95 latency cross pgvector's, and what does each index
 * cost to build and store?
 *
 * This is the row-count question the pre-registered bar (FORK.md, SMD-1038) makes
 * decisive: "a latency gap at a row count within a stated multiple of the largest
 * real deployment ... measured end to end: in the two-store shape every vector
 * read is an external ANN query PLUS a Postgres resolve of the returned ids to
 * rows." So Qdrant's number here is its ANN search *plus* a Postgres primary-key
 * fetch of the ids it returns — the architectural cost that does not shrink with
 * tuning.
 *
 * The corpus is synthetic: deterministic random unit vectors (db/test-support.ts'
 * `seededRandom`, the generator db/bench-hnsw.ts seeds SMD-1018 with), the SAME
 * vectors streamed into every store from the same seed — never held in memory, so
 * 10M × 1024 does not need 40 GB of RAM. Random uniform vectors are HNSW's hardest
 * case (bench-hnsw's header), so the recall floor here is conservative. The width
 * is the product's 1024 by default; the real-corpus fidelity lives in
 * store-compare.ts, and this arm isolates behaviour as N grows.
 *
 *   # 1M and 10M at 64-dim, all engines — the curve the tables report:
 *   OB1_STORE_SCALES=1000000,10000000 OB1_STORE_DIM=64 OB1_STORE_QUERIES=10 \
 *     OB1_STORE_QDRANT_ONDISK=1 OB1_STORE_BUILD_TIMEOUT_MS=600000 \
 *     OB1_STORE_MAINT_MEM=2GB OB1_STORE_PG_SHM=3g bun store-scale.ts
 *   # 1M at the product's 1024 width — a build-cost data point; DiskANN's build
 *   # exceeds a 14 GB VM at 1024, so this pins the pg indexes to the two that fit:
 *   OB1_STORE_SCALES=1000000 OB1_STORE_DIM=1024 OB1_STORE_PG_INDEXES=hnsw,ivfflat \
 *     OB1_STORE_MAINT_MEM=2GB OB1_STORE_PG_SHM=3g bun store-scale.ts
 *
 * The knobs that make scale runnable in a memory-bounded VM, all reflected above:
 * pgvectorscale's PARALLEL DiskANN build crashes the backend at >=1M rows, so its
 * build defaults to serial (`OB1_STORE_BUILD_WORKERS=0` for diskann);
 * `OB1_STORE_BUILD_TIMEOUT_MS` bounds the slow serial build so a run records the
 * failure instead of hanging; `OB1_STORE_QDRANT_ONDISK=1` keeps a 10M Qdrant index
 * mmap'd so it can be searched beside Postgres rather than swapped. Image overrides:
 * `OB1_STORE_PG_IMAGE`, `OB1_STORE_QDRANT_IMAGE`; ingest batch: `OB1_STORE_QDRANT_BATCH`.
 *
 * Starts and tears down its own timescaledb-ha + qdrant containers per scale (a
 * kept database holds one corpus). Touches nothing in the product.
 */

import { seededRandom } from "../db/test-support.ts";
import {
  PgEngine, QdrantEngine, dedupTopK, recallAt, nowMs,
  type Point, type Filter, type Store, type PgIndexKind,
} from "./store-backends.ts";

const DIM = Number(process.env.OB1_STORE_DIM ?? 1024);
const SCALES = (process.env.OB1_STORE_SCALES ?? "1000000")
  .split(",").map((s) => Number(s.trim()));
if (SCALES.some((n) => !Number.isInteger(n) || n <= 0)) {
  console.error(`OB1_STORE_SCALES must be positive integers (got ${JSON.stringify(process.env.OB1_STORE_SCALES)})`);
  process.exit(2);
}
const Q = Number(process.env.OB1_STORE_QUERIES ?? 20);
const K = 10;
const FETCH = Number(process.env.OB1_STORE_FETCH ?? 50);
const EFFORT = Number(process.env.OB1_STORE_EFFORT ?? 200);
// DiskANN last: its build is the one that can crash the backend at scale, and
// the loop records that failure only after the safe indexes have been measured.
const PG_INDEXES = (process.env.OB1_STORE_PG_INDEXES ?? "hnsw,ivfflat,diskann").split(",") as PgIndexKind[];
/** Selectivity tiers planted by share, mirroring db/bench-hnsw.ts. */
const TIERS = [
  { key: "t50", share: 0.5 }, { key: "t10", share: 0.1 }, { key: "t1", share: 0.01 }, { key: "t01", share: 0.001 },
];

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Deterministic point stream — regenerable per store so every store sees identical vectors. */
function* gen(n: number, seed: number): Generator<Point> {
  const { rnd, unitVector } = seededRandom(seed);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const tiers = TIERS.filter((t) => r < t.share).map((t) => t.key);
    yield { ref: `r${i}`, labels: [], tiers, embedding: unitVector(DIM) };
  }
}
function queryVectors(seed: number): number[][] {
  const { unitVector } = seededRandom(seed);
  return Array.from({ length: Q }, () => unitVector(DIM));
}

type Cell = { recall: number; p50: number; p95: number };
type Row = { store: string; effort: string; buildS: string; bytes: number; cells: Map<string, Cell>; e2e95?: number; note?: string };

async function measure(store: Store, queries: number[][], exact: Map<string, string[]>, arms: { name: string; f: Filter }[], effort?: number): Promise<Map<string, Cell>> {
  if (effort !== undefined && "setEffort" in store) await (store as any).setEffort(effort);
  await store.search(queries[0], FETCH, null); // warmup
  const cells = new Map<string, Cell>();
  for (const arm of arms) {
    const rec: number[] = [], lat: number[] = [];
    for (let qi = 0; qi < queries.length; qi++) {
      const t0 = nowMs();
      const raw = await store.search(queries[qi], FETCH, arm.f);
      lat.push(nowMs() - t0);
      rec.push(recallAt(dedupTopK(raw, K), exact.get(`${qi}|${arm.name}`)!, K));
    }
    cells.set(arm.name, { recall: 100 * mean(rec), p50: pct(lat, 50), p95: pct(lat, 95) });
  }
  return cells;
}

for (const N of SCALES) {
  const SEED = 20260916 + N;
  const QSEED = 777 + N;
  const arms: { name: string; f: Filter }[] = [{ name: "unfiltered", f: null }, ...TIERS.map((t) => ({ name: t.key, f: { key: "tiers" as const, value: t.key } }))];
  const queries = queryVectors(QSEED);
  const pg = new PgEngine(DIM, `scale${N}`);
  const qd = new QdrantEngine(DIM, `scale${N}`);
  const rows: Row[] = [];
  console.log(`\n══════ scale ${N.toLocaleString()} rows, ${DIM}-dim ══════`);
  try {
    await Promise.all([pg.start(), qd.start()]);
    console.log("  loading (streamed, identical vectors into both stores)…");
    const pgLoad = await pg.load(gen(N, SEED));
    console.log(`  pg load ${(pgLoad / 1000).toFixed(1)}s`);
    const qdLoad = await qd.load(gen(N, SEED));
    console.log(`  qdrant load ${(qdLoad / 1000).toFixed(1)}s, index ${(qd.stat.buildMs / 1000).toFixed(1)}s, ${(qd.stat.indexBytes / 1e6).toFixed(0)}MB`);

    // Exact oracle: unfiltered is one full scan per query; each tier scans only
    // its own (far smaller) rows. Computed before the vector plan is forced.
    console.log(`  exact ground truth: ${Q} queries × ${arms.length} arms (seq scans; the unfiltered scan is the slow one)`);
    const exact = new Map<string, string[]>();
    for (let qi = 0; qi < queries.length; qi++) {
      for (const arm of arms) exact.set(`${qi}|${arm.name}`, dedupTopK(await pg.exact(queries[qi], FETCH, arm.f), K));
      if ((qi + 1) % 5 === 0) process.stdout.write(`  …${qi + 1}/${Q} queries oracled\n`);
    }
    await pg.forcePlanVectorIndex();
    const tableBytes = await pg.tableBytes();
    const failures: string[] = [];

    // Qdrant first (external), while the Postgres backend is healthy for the
    // id→row resolve. pgvectorscale's DiskANN build crashed the backend at 1M
    // rows; measuring the external engine before the risky in-engine build means
    // that crash costs only DiskANN's row, not Qdrant's.
    try {
      const qcells = await measure(qd, queries, exact, arms);
      const e2e: number[] = [];
      for (let qi = 0; qi < queries.length; qi++) {
        const t0 = nowMs();
        const refs = dedupTopK(await qd.search(queries[qi], FETCH, null), K);
        const list = refs.map((r) => `'${r.replace(/'/g, "''")}'`).join(",") || "''";
        await pg.raw(`SELECT ref FROM points WHERE ref IN (${list})`);
        e2e.push(nowMs() - t0);
      }
      rows.push({ store: qd.name, effort: "default", buildS: (qd.stat.buildMs / 1000).toFixed(1) + "s", bytes: qd.stat.indexBytes, cells: qcells, e2e95: pct(e2e, 95), note: qd.stat.note });
    } catch (e) {
      // Qdrant's search timed out at 10M in the 14 GB VM: keep its build/footprint
      // (already measured) and let the pg-side numbers still land.
      const msg = (e as Error).message.slice(0, 90);
      console.log(`  qdrant measure FAILED at ${N.toLocaleString()} — ${msg}`);
      failures.push(`qdrant search: ${msg}`);
      const nanCells = new Map(arms.map((a) => [a.name, { recall: NaN, p50: NaN, p95: NaN }]));
      rows.push({ store: qd.name, effort: "default", buildS: (qd.stat.buildMs / 1000).toFixed(1) + "s", bytes: qd.stat.indexBytes, cells: nanCells, note: qd.stat.note });
    }

    // Postgres indexes, DiskANN last. A backend crash during a build poisons the
    // single connection (and may restart Postgres), so a failure is recorded and
    // the loop stops rather than reporting later stores as if they had run.
    for (const kind of PG_INDEXES) {
      try {
        const store = await pg.buildIndex(kind);
        const plan = await pg.explain(queries[0], FETCH, arms[1].f);
        const usesIndex = /Index Scan using points_vec_/.test(plan);
        console.log(`  ${store.name}: build ${(store.stat.buildMs / 1000).toFixed(1)}s, ${(store.stat.indexBytes / 1e6).toFixed(0)}MB, plan ${usesIndex ? "vector-index" : "NOT vector-index: " + plan.slice(0, 70)}`);
        // Fail this store if the planner escaped the forced vector index — the
        // catch below records it rather than reporting flattered recall.
        if (!usesIndex) throw new Error(`${store.name}: planner did not use the vector index`);
        for (const [label, eff] of [["default", undefined], [`effort=${EFFORT}`, EFFORT]] as const)
          rows.push({ store: store.name, effort: label, buildS: (store.stat.buildMs / 1000).toFixed(1) + "s", bytes: store.stat.indexBytes, cells: await measure(store, queries, exact, arms, eff) });
        await pg.dropIndex(kind);
      } catch (e) {
        const msg = (e as Error).message;
        console.log(`  pgvector-${kind}: BUILD/MEASURE FAILED — ${msg}`);
        failures.push(`pgvector-${kind}: ${msg}`);
        break;
      }
    }

    report(N, rows, arms, tableBytes, pgLoad, qdLoad, failures);
  } finally {
    await Promise.all([pg.stop(), qd.stop()]);
  }
}

function report(N: number, rows: Row[], arms: { name: string; f: Filter }[], tableBytes: number, pgLoad: number, qdLoad: number, failures: string[] = []): void {
  console.log(`\n### Recall@${K} vs exact — ${N.toLocaleString()} rows, ${DIM}-dim\n`);
  const head = ["store", "effort", ...arms.map((a) => a.name)];
  console.log("| " + head.join(" | ") + " |\n| " + head.map(() => "---").join(" | ") + " |");
  for (const r of rows) console.log(`| ${r.store} | ${r.effort} | ${arms.map((a) => { const c = r.cells.get(a.name)!; return isNaN(c.recall) ? "—" : c.recall.toFixed(0) + "%"; }).join(" | ")} |`);

  console.log(`\n### Latency p95 (ms) — ${N.toLocaleString()} rows\n`);
  console.log("| store | effort | unfiltered p95 | filtered p95 (mean of tiers) | end-to-end p95 (incl. pg id→row) |");
  console.log("| --- | --- | ---: | ---: | ---: |");
  const ms = (x: number) => (isNaN(x) ? "—" : x.toFixed(2));
  for (const r of rows) {
    const un = r.cells.get("unfiltered")!;
    const fp95 = mean(TIERS.map((t) => r.cells.get(t.key)!.p95));
    console.log(`| ${r.store} | ${r.effort} | ${ms(un.p95)} | ${ms(fp95)} | ${r.e2e95 !== undefined ? ms(r.e2e95) : "n/a (single store)"} |`);
  }

  console.log(`\n### Build time and footprint — ${N.toLocaleString()} rows, ${DIM}-dim\n`);
  console.log("| store | index build | index size |");
  console.log("| --- | ---: | ---: |");
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.store)) continue; seen.add(r.store); console.log(`| ${r.store} | ${r.buildS} | ${(r.bytes / 1e6).toFixed(0)} MB |`); }
  console.log(`\n  points table (no vector index): ${(tableBytes / 1e6).toFixed(0)} MB · pg load ${(pgLoad / 1000).toFixed(1)}s · qdrant load ${(qdLoad / 1000).toFixed(1)}s`);
  if (failures.length) console.log(`  build failures: ${failures.join("; ")}`);
  for (const r of rows) if (r.note) console.log(`  note (${r.store}): ${r.note}`);
  console.log();
}
