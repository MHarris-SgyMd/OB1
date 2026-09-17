#!/usr/bin/env bun
/**
 * store-compare.ts — SMD-1037, the real-corpus arm: does the store change the
 * rows retrieval returns, or the time to return them, on the corpus the fork's
 * other numbers come from (the Linear issues, whole-content vector plus bare
 * windows, at the shipped 1024 width)?
 *
 * SMD-1038 (FORK.md, "A second vector store beside Postgres") pre-registered the
 * bar this run is read against: a recall gap at a used filter tier, a latency
 * gap at a reachable row count, or an index build time that makes a re-embed a
 * maintenance window. This arm measures the first and third on real data at
 * product fidelity; store-scale.ts measures the latency/row-count crossover on
 * synthetic 1M/10M corpora.
 *
 * Every store scores against ONE exact-cosine ground truth over the SAME cached
 * vectors (evals/lib.ts `embed`, cached SHA-keyed exactly as eval-filtered.ts
 * caches), never against another store. The bracket is pgvector HNSW (the
 * incumbent `match_thoughts` walks), pgvectorscale StreamingDiskANN and pgvector
 * IVFFlat in the same Postgres, and Qdrant as an external engine — see
 * store-backends.ts for why the unit is a point and how each is forced onto its
 * own vector index.
 *
 *   ../db/with-postgres.sh is NOT used — this harness starts its own
 *   timescale/timescaledb-ha and qdrant containers and tears them down.
 *
 *   bun store-compare.ts
 *   OB1_STORE_EFFORT=200 OB1_STORE_QUERIES=120 bun store-compare.ts
 *
 * Data handling mirrors eval-filtered.ts: the corpus is internal engineering
 * data read from /tmp, embedded by a local Ollama, kept out of the repo.
 */

import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkContent, DEFAULT_MAX_TOKENS } from "../server-portable/chunk.ts";
import { DEFAULT_EMBEDDING_MODEL } from "../db/config.mjs";
import { seededRandom } from "../db/test-support.ts";
import { embed, parseSpec } from "./lib.ts";
import {
  PgEngine, QdrantEngine, dedupTopK, recallAt, nowMs,
  type Point, type Filter, type Store, type PgIndexKind,
} from "./store-backends.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus-full.json";
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? `${DEFAULT_EMBEDDING_MODEL}@1024`;
const CACHE = process.env.OB1_EVAL_EMBED_CACHE ?? "/tmp/ob1-filtered-embed-cache.json";
const K = 10;
/** Points fetched per query before dedup to K distinct refs (a thought may own several). */
const FETCH = Number(process.env.OB1_STORE_FETCH ?? 50);
/** Raised search effort — the ceiling beside each engine's default floor. */
const EFFORT = Number(process.env.OB1_STORE_EFFORT ?? 200);
/** Query sample size (0 = every document's title). */
const NQ = Number(process.env.OB1_STORE_QUERIES ?? 150);
const PG_INDEXES = (process.env.OB1_STORE_PG_INDEXES ?? "hnsw,diskann,ivfflat").split(",") as PgIndexKind[];

for (const [what, p] of [["corpus", CORPUS], ["embedding cache", CACHE]] as const) {
  if (resolve(p).startsWith(REPO_ROOT + "/")) {
    console.error(`Refusing to use a ${what} inside the repository: ${p}. Keep it in /tmp.`);
    process.exit(2);
  }
}

// ── corpus + cached embeddings (eval-filtered.ts's proven scaffolding) ────────

async function readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { ok: false, missing: true, error: "no such file" };
  try {
    return { ok: true, value: JSON.parse(await file.text()) as T };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error).message };
  }
}

type Item = { id: string; title: string; text: string; labels: string[] };
const corpus = await readJson<Item[]>(CORPUS);
if (!corpus.ok) {
  if (corpus.missing) console.error(`No corpus at ${CORPUS}. Build it with \`bun build-linear-corpus.ts\`.`);
  else console.error(`The corpus at ${CORPUS} exists but does not parse: ${corpus.error}`);
  process.exit(2);
}
const ITEMS = corpus.value;

const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM ?? 1024);
const cached = await readJson<Record<string, number[]>>(CACHE);
if (!cached.ok && !cached.missing) {
  console.error(`The embedding cache at ${CACHE} exists but does not parse: ${cached.error}. Move it aside and rerun.`);
  process.exit(2);
}
const cache: Record<string, number[]> = cached.ok ? cached.value : {};
let cacheDirty = false;
async function vec(text: string, isQuery = false): Promise<number[]> {
  const key = `${EMBED_MODEL}|${isQuery ? "q" : "d"}|${createHash("sha256").update(text).digest("hex")}`;
  if (cache[key]) return cache[key];
  const v = await embed(EMBED_MODEL, text, isQuery);
  cache[key] = v;
  cacheDirty = true;
  return v;
}

// ── documents → points, with seeded synthetic tiers down to 0.7% ─────────────

const { rnd } = seededRandom(1037);
type Doc = Item & { tiers: string[]; content: string; whole: number[]; windowText: string[]; windows: number[][]; query: number[] };

process.stdout.write(`  embedding ${ITEMS.length} documents with ${EMBED_MODEL} (cached)`);
const DOCS: Doc[] = [];
for (const it of ITEMS) {
  const r = rnd();
  const tiers = [r < 0.1 ? "t10" : null, r < 0.02 ? "t2" : null, r < 0.007 ? "t07" : null].filter((x): x is string => !!x);
  const windowText = chunkContent(it.text, { maxTokens: DEFAULT_MAX_TOKENS }).map((c) => c.content);
  DOCS.push({
    ...it, tiers, content: it.text,
    whole: await vec(it.text),
    windowText,
    windows: await Promise.all(windowText.map((w) => vec(w))),
    query: await vec(it.title, true),
  });
  if (DOCS.length % 50 === 0) process.stdout.write(".");
}
if (cacheDirty) await Bun.write(CACHE, JSON.stringify(cache));
console.log(" done");

// Points: whole vector + each window, all sharing the doc's ref/labels/tiers.
const POINTS: Point[] = [];
for (const d of DOCS) {
  POINTS.push({ ref: d.id, labels: d.labels, tiers: d.tiers, embedding: d.whole });
  for (const w of d.windows) POINTS.push({ ref: d.id, labels: d.labels, tiers: d.tiers, embedding: w });
}

// Filters: the corpus's real labels at four selectivities + synthetic tiers.
const FILTERS: { name: string; f: Filter; share: number }[] = [];
for (const l of ["api", "web", "portal", "design"]) {
  const n = DOCS.filter((d) => d.labels.includes(l)).length;
  FILTERS.push({ name: l, f: { key: "labels", value: l }, share: n / DOCS.length });
}
for (const t of ["t10", "t2", "t07"]) {
  const n = DOCS.filter((d) => d.tiers.includes(t)).length;
  FILTERS.push({ name: t, f: { key: "tiers", value: t }, share: n / DOCS.length });
}
const ARMS: { name: string; f: Filter; share: number }[] = [{ name: "unfiltered", f: null, share: 1 }, ...FILTERS];

// Query set: a deterministic sample of document titles.
function sample<T>(xs: T[], n: number): T[] {
  if (!n || xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
}
const QUERIES = sample(DOCS, NQ).map((d) => d.query);

// ── run ──────────────────────────────────────────────────────────────────────

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

type Cell = { recall: number; p50: number; p95: number; short: number };
type Result = { store: string; effort: string; build: string; bytes: number; cells: Map<string, Cell> };

const pg = new PgEngine(DIM);
const qd = new QdrantEngine(DIM);
const results: Result[] = [];

/** recall@K + latency for one store across every arm, at one effort. */
async function measure(store: Store, exact: Map<string, string[]>, effort?: number): Promise<Map<string, Cell>> {
  if (effort !== undefined && "setEffort" in store) await (store as any).setEffort(effort);
  const cells = new Map<string, Cell>();
  // warmup
  await store.search(QUERIES[0], FETCH, null);
  for (const arm of ARMS) {
    const recalls: number[] = [], lat: number[] = [];
    let short = 0;
    for (let qi = 0; qi < QUERIES.length; qi++) {
      const t0 = nowMs();
      const raw = await store.search(QUERIES[qi], FETCH, arm.f);
      lat.push(nowMs() - t0);
      const got = dedupTopK(raw, K);
      if (got.length < K) short++;
      recalls.push(recallAt(got, exact.get(`${qi}|${arm.name}`)!, K));
    }
    cells.set(arm.name, { recall: 100 * mean(recalls), p50: pct(lat, 50), p95: pct(lat, 95), short });
  }
  return cells;
}

try {
  console.log(`  starting containers (pg ${DIM}-dim + qdrant), loading ${POINTS.length} points from ${DOCS.length} docs`);
  await Promise.all([pg.start(), qd.start()]);
  const [pgLoad, qdLoad] = await Promise.all([pg.load(POINTS), qd.load(POINTS)]);
  console.log(`  loaded: pg ${(pgLoad / 1000).toFixed(1)}s, qdrant ${(qdLoad / 1000).toFixed(1)}s`);

  // Exact ground truth per (query, arm), computed BEFORE the vector plan is forced.
  console.log("  computing exact-cosine ground truth (index kept out of the plan)");
  const exact = new Map<string, string[]>();
  for (let qi = 0; qi < QUERIES.length; qi++)
    for (const arm of ARMS) exact.set(`${qi}|${arm.name}`, dedupTopK(await pg.exact(QUERIES[qi], FETCH, arm.f), K));
  await pg.forcePlanVectorIndex();

  const tableBytes = await pg.tableBytes();

  for (const kind of PG_INDEXES) {
    const store = await pg.buildIndex(kind);
    const plan = await pg.explain(QUERIES[0], FETCH, FILTERS[0].f);
    const usesIndex = /Index Scan using points_vec_/.test(plan);
    console.log(`  ${store.name}: build ${(store.stat.buildMs / 1000).toFixed(1)}s, index ${(store.stat.indexBytes / 1e6).toFixed(1)}MB, vector-index plan: ${usesIndex ? "yes" : "NO — " + plan.slice(0, 80)}`);
    // The filtered arm only measures the vector index's post-filter behaviour if
    // the planner actually used it; a plan that escaped the force would report
    // flattered recall silently, so fail loud instead.
    if (!usesIndex) throw new Error(`${store.name}: planner did not use the vector index — ${plan.slice(0, 120)}`);
    for (const [label, eff] of [["default", undefined], [`effort=${EFFORT}`, EFFORT]] as const) {
      results.push({ store: store.name, effort: label, build: (store.stat.buildMs / 1000).toFixed(1) + "s", bytes: store.stat.indexBytes, cells: await measure(store, exact, eff) });
    }
    await pg.dropIndex(kind);
  }
  results.push({ store: qd.name, effort: "default", build: (qd.stat.buildMs / 1000).toFixed(1) + "s", bytes: qd.stat.indexBytes, cells: await measure(qd, exact) });

  // ── hybrid shape: one statement vs two round trips + a merge ────────────────
  await hybrid();

  // ── report ─────────────────────────────────────────────────────────────────
  report(tableBytes, pgLoad, qdLoad);
} finally {
  await Promise.all([pg.stop(), qd.stop()]);
}

// ── hybrid arm ────────────────────────────────────────────────────────────────

async function hybrid(): Promise<void> {
  console.log("\n  hybrid: loading a keyword side-table and comparing one statement vs two stores");
  // Content-side table on the same Postgres — the keyword arm hybrid needs.
  await pg.raw("CREATE TABLE docs (ref text PRIMARY KEY, content text, tsv tsvector)");
  for (const d of DOCS) {
    const c = d.content.replace(/'/g, "''");
    await pg.raw(`INSERT INTO docs (ref, content, tsv) VALUES ('${d.id.replace(/'/g, "''")}', '${c}', to_tsvector('english', '${c}')) ON CONFLICT (ref) DO NOTHING`);
  }
  await pg.raw("CREATE INDEX docs_tsv_gin ON docs USING gin (tsv)");
  await pg.raw("ANALYZE docs");
  // The recall arm forced the vector index by disabling seq/bitmap scans; the
  // hybrid arm measures REALISTIC wall clock, so let the planner choose (the
  // keyword arm needs the GIN via a bitmap scan).
  await pg.raw("SET enable_seqscan = on");
  await pg.raw("SET enable_bitmapscan = on");
  // rebuild HNSW for the vector arm of the pg one-statement hybrid
  const store = await pg.buildIndex("hnsw");

  // Hybrid queries: title vector + a keyword drawn from the title.
  const hq = sample(DOCS, Math.min(60, NQ)).map((d) => ({
    vec: d.query,
    kw: (d.title.match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? []).slice(0, 3).join(" ") || d.title,
  }));

  const onePg: number[] = [], twoStore: number[] = [];
  // warmup
  await pgHybridOneStatement(store, hq[0].vec, hq[0].kw);
  await twoStoreHybrid(hq[0].vec, hq[0].kw);
  for (const { vec, kw } of hq) {
    let t = nowMs();
    await pgHybridOneStatement(store, vec, kw);
    onePg.push(nowMs() - t);
    t = nowMs();
    await twoStoreHybrid(vec, kw);
    twoStore.push(nowMs() - t);
  }
  await pg.dropIndex("hnsw");
  console.log(`\n### Hybrid: vector ⋈ keyword, ${hq.length} queries`);
  console.log("| shape | round trips | mean ms | p50 | p95 |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  console.log(`| Postgres, one statement | 1 | ${mean(onePg).toFixed(1)} | ${pct(onePg, 50).toFixed(1)} | ${pct(onePg, 95).toFixed(1)} |`);
  console.log(`| Qdrant + Postgres keyword + merge | 2 | ${mean(twoStore).toFixed(1)} | ${pct(twoStore, 50).toFixed(1)} | ${pct(twoStore, 95).toFixed(1)} |`);
}

/** One SQL statement: vector top-N over points ⋈ keyword over docs, RRF-fused. */
async function pgHybridOneStatement(store: Store, v: number[], kw: string): Promise<string[]> {
  const lit = `[${v.join(",")}]`;
  const q = kw.replace(/'/g, "''");
  const rows = await pg.raw(`
    WITH vec AS (
      SELECT ref, row_number() OVER (ORDER BY d) AS r FROM (
        SELECT ref, MIN(embedding <=> '${lit}'::vector) AS d
        FROM (SELECT ref, embedding FROM points ORDER BY embedding <=> '${lit}'::vector LIMIT ${FETCH * 4}) cand
        GROUP BY ref
      ) g LIMIT ${FETCH}
    ),
    kw AS (
      SELECT ref, row_number() OVER (ORDER BY ts_rank(tsv, plainto_tsquery('english','${q}')) DESC) AS r
      FROM docs WHERE tsv @@ plainto_tsquery('english','${q}') LIMIT ${FETCH}
    )
    SELECT ref FROM (
      SELECT ref, SUM(1.0/(60+r)) AS s FROM (
        SELECT ref, r FROM vec UNION ALL SELECT ref, r FROM kw
      ) u GROUP BY ref ORDER BY s DESC LIMIT ${K}
    ) f`);
  return rows.map((r: { ref: string }) => String(r.ref));
}

/** Two stores: a Qdrant vector round trip, a Postgres keyword round trip, merged here. */
async function twoStoreHybrid(v: number[], kw: string): Promise<string[]> {
  const q = kw.replace(/'/g, "''");
  const [vhits, khits] = await Promise.all([
    qd.search(v, FETCH, null),
    pg.raw(`SELECT ref FROM docs WHERE tsv @@ plainto_tsquery('english','${q}') ORDER BY ts_rank(tsv, plainto_tsquery('english','${q}')) DESC LIMIT ${FETCH}`).then((rs) => rs.map((r: { ref: string }) => String(r.ref))),
  ]);
  const score = new Map<string, number>();
  dedupTopK(vhits, FETCH).forEach((ref, i) => score.set(ref, (score.get(ref) ?? 0) + 1 / (60 + i + 1)));
  khits.forEach((ref: string, i: number) => score.set(ref, (score.get(ref) ?? 0) + 1 / (60 + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map(([ref]) => ref);
}

// ── report ────────────────────────────────────────────────────────────────────

function report(tableBytes: number, pgLoad: number, qdLoad: number): void {
  console.log(`\n### Recall@${K} vs exact, by filter arm (share of corpus in parentheses)\n`);
  const header = ["store", "effort", ...ARMS.map((a) => `${a.name}${a.share < 1 ? ` (${(100 * a.share).toFixed(1)}%)` : ""}`)];
  console.log("| " + header.join(" | ") + " |");
  console.log("| " + header.map(() => "---").join(" | ") + " |");
  for (const r of results) {
    const cells = ARMS.map((a) => {
      const c = r.cells.get(a.name)!;
      return isNaN(c.recall) ? "—" : c.recall.toFixed(0) + "%";
    });
    console.log(`| ${r.store} | ${r.effort} | ${cells.join(" | ")} |`);
  }

  console.log(`\n### Latency p50 / p95 (ms) at match_count ${K}, default effort\n`);
  console.log("| store | unfiltered p50 | p95 | filtered p50 (mean of tiers) | p95 |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const r of results.filter((x) => x.effort === "default")) {
    const un = r.cells.get("unfiltered")!;
    const fp50 = mean(FILTERS.map((f) => r.cells.get(f.name)!.p50));
    const fp95 = mean(FILTERS.map((f) => r.cells.get(f.name)!.p95));
    console.log(`| ${r.store} | ${un.p50.toFixed(2)} | ${un.p95.toFixed(2)} | ${fp50.toFixed(2)} | ${fp95.toFixed(2)} |`);
  }

  console.log(`\n### Index build time and footprint (${POINTS.length} points, ${DIM}-dim)\n`);
  console.log("| store | build | index size | note |");
  console.log("| --- | ---: | ---: | --- |");
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.store)) continue;
    seen.add(r.store);
    console.log(`| ${r.store} | ${r.build} | ${(r.bytes / 1e6).toFixed(1)} MB | ${r.store === "qdrant" ? "on-disk collection" : "index only"} |`);
  }
  console.log(`\n  points table (no vector index): ${(tableBytes / 1e6).toFixed(1)} MB · pg load ${(pgLoad / 1000).toFixed(1)}s · qdrant load ${(qdLoad / 1000).toFixed(1)}s`);
  console.log(`  short returns (fewer than ${K} after dedup) flag the filtered post-LIMIT loss; see per-arm recall.\n`);
}
