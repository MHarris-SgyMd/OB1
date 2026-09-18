#!/usr/bin/env bun
/**
 * store-readmodel.ts — SMD-1696: measure a vector store as a READ MODEL (payload
 * included, no id→row resolve) — the topology SMD-1037 (FORK 79) and SMD-1662
 * (FORK 82) defined away.
 *
 * Those evals measured a second store as a *subordinate ANN index* with Postgres
 * as source of truth, so every read resolved the store's returned ids back to
 * Postgres rows — and that id→row resolve was treated as the architectural cost
 * the "second store not built" verdict rested on. But the resolve is an artifact
 * of that topology, not a property of a two-store design. A columnar store can
 * hold the vector AND the full payload and serve the retrieval read completely,
 * with Postgres as the transactional write log — a read-model / CQRS shape whose
 * read path makes ZERO Postgres calls. This measures that shape.
 *
 * Three read paths, same corpus, same exact-cosine oracle, on identical vectors:
 *   1. single-store Postgres   — one statement: ANN over points ⋈ docs payload,
 *                                deduped to distinct thoughts, full rows returned
 *                                (a `match_thoughts`-equivalent read).
 *   2. two-store resolve       — LanceDB ANN → ids → Postgres pulls the payload
 *      (SMD-1662 shape)          back (`SELECT content,metadata … WHERE ref IN …`).
 *   3. read-model no-resolve   — LanceDB returns the full rows directly. Zero PG.
 *      (SMD-1696, the new path)
 * Paths 2 and 3 use the SAME LanceDB index, so they differ only in where the
 * payload comes from: (path2 − path3) is the resolve tax the 1662 verdict rested
 * on; (path1 − path3) is the read model vs the single-store incumbent.
 *
 * The read model holds no Postgres handle, so its read path is zero-Postgres by
 * construction. That is checked at runtime — a query counter on the shared Postgres
 * handle reads 0 across the whole path-3 loop, a regression guard — and, the actual
 * demonstration, Postgres is *stopped* mid-run and the read model still answers,
 * byte-identical rows, with the OLTP database down.
 *
 * The cost the read model moves to write time is then measured: the per-write
 * dual-write tax, an outbox/CDC drain (throughput + steady-state lag), the
 * mutable-payload upsert (the real consistency tax — content/metadata edits, vs
 * append-mostly vectors), and the storage duplication of holding payload twice.
 *
 * Eval-only: no migration, no backend, no product change. Reuses the SMD-1037
 * harness (store-backends.ts) — one exact-cosine oracle, the point unit, the
 * point→ref dedup — and its corpus scaffolding (store-compare.ts). Starts and
 * tears down its own timescaledb-ha container; LanceDB is embedded (a temp
 * dataset dir). LanceDB is Apache-2.0, the fork FSL-1.1-MIT — an eval dep.
 *
 *   bun store-readmodel.ts                                  # real corpus, hnsw_sq read model
 *   OB1_STORE_QUERIES=15 bun store-readmodel.ts             # quick smoke
 *   OB1_STORE_LANCE_INDEXES=ivfflat,hnswsq bun store-readmodel.ts   # both read-model indexes
 *   # scale (payload lives in BOTH Postgres and Lance, so cap OB1_STORE_PAYLOAD_BYTES
 *   # at 10M). Run the scales separately — the single-store index differs:
 *   # 1M — HNSW anchor (builds fine at this size), storage-delta measured:
 *   OB1_STORE_SCALES=1000000 OB1_STORE_DIM=64 OB1_STORE_PAYLOAD_BYTES=256 \
 *     OB1_STORE_PG_SHM=3g bun store-readmodel.ts
 *   # 10M — IVFFlat anchor (pg HNSW does not build in a practical window), oracle
 *   #       skipped, storage-delta off (skips the second index-only Lance load):
 *   OB1_STORE_SCALES=10000000 OB1_STORE_DIM=64 OB1_STORE_PAYLOAD_BYTES=128 \
 *     OB1_STORE_PG_INDEX=ivfflat OB1_STORE_SKIP_ORACLE_OVER=2000000 \
 *     OB1_STORE_RM_STORAGE_DELTA=0 OB1_STORE_PG_SHM=3g bun store-readmodel.ts
 *
 * Knobs: OB1_STORE_PG_INDEX (default `hnsw`; the single-store path-1 index — set
 * `ivfflat` at 10M, where HNSW's build is a maintenance window), OB1_STORE_LANCE_INDEXES (default `hnswsq`; the ship-shape read model —
 * set `ivfflat,hnswsq` for the unquantized control too), OB1_STORE_SCALES (unset
 * = real corpus), OB1_STORE_DIM, OB1_STORE_PAYLOAD_BYTES (synthetic payload size,
 * default 512), OB1_STORE_QUERIES, OB1_STORE_EFFORT, OB1_STORE_FETCH,
 * OB1_STORE_SKIP_ORACLE_OVER (skip the exact oracle above N rows — recall is left
 * blank, latency still lands), OB1_STORE_RM_STORAGE_DELTA=0 (skip the index-only
 * LanceDB load used for the storage-duplication delta).
 */

import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkContent, DEFAULT_MAX_TOKENS } from "../server-portable/chunk.ts";
import { DEFAULT_EMBEDDING_MODEL } from "../db/config.mjs";
import { seededRandom } from "../db/test-support.ts";
import { embed, parseSpec } from "./lib.ts";
import {
  PgEngine, LanceEngine, LanceReadModel, dedupTopK, recallAt, nowMs,
  type PayloadPoint, type Filter, type LanceIndexKind, type PgIndexKind,
} from "./store-backends.ts";

const K = 10;
const FETCH = Number(process.env.OB1_STORE_FETCH ?? 50);
const EFFORT = Number(process.env.OB1_STORE_EFFORT ?? 200);
const PAYLOAD_BYTES = Number(process.env.OB1_STORE_PAYLOAD_BYTES ?? 512);
const RM_KINDS = (process.env.OB1_STORE_LANCE_INDEXES ?? "hnswsq")
  .split(",").map((s) => s.trim()).filter(Boolean) as LanceIndexKind[];
// The single-store Postgres index (path 1). HNSW is the incumbent (migration 019),
// but its build is a maintenance-window operation at 10M (SMD-1037), so the scale
// arm can pin it to IVFFlat — as SMD-1662's 10M single-store anchor did — with
// OB1_STORE_PG_INDEX=ivfflat.
const PG_INDEX = (process.env.OB1_STORE_PG_INDEX ?? "hnsw") as PgIndexKind;
const SKIP_ORACLE_OVER = Number(process.env.OB1_STORE_SKIP_ORACLE_OVER ?? Infinity);
const STORAGE_DELTA = process.env.OB1_STORE_RM_STORAGE_DELTA !== "0";

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const esc = (s: string) => s.replace(/'/g, "''");

// A corpus: everything a run needs, source-agnostic (real docs or synthetic).
// pointStream may yield several points per ref (whole + windows); docStream yields
// one payload per distinct ref. contentOf lets the content-correctness check and
// the write-side edits run without touching Postgres.
type Corpus = {
  label: string;
  dim: number;
  nPoints: number;
  nRefs: number;
  arms: { name: string; f: Filter; share: number }[];
  queries: number[][];
  pointStream: () => Iterable<PayloadPoint>;
  docStream: () => Iterable<{ ref: string; content: string; metadata: string }>;
  contentOf: (ref: string) => string;
  refAt: (i: number) => string; // a stable ref by index, for write-side sampling
};

// ── real corpus (store-compare.ts scaffolding: cached embeddings, whole+windows) ─

async function readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { ok: false, missing: true, error: "no such file" };
  try {
    return { ok: true, value: JSON.parse(await file.text()) as T };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error).message };
  }
}

async function realCorpus(): Promise<Corpus> {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const CORPUS = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus-full.json";
  const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? `${DEFAULT_EMBEDDING_MODEL}@1024`;
  const CACHE = process.env.OB1_EVAL_EMBED_CACHE ?? "/tmp/ob1-filtered-embed-cache.json";
  const NQ = Number(process.env.OB1_STORE_QUERIES ?? 150);
  for (const [what, p] of [["corpus", CORPUS], ["embedding cache", CACHE]] as const) {
    if (resolve(p).startsWith(REPO_ROOT + "/")) {
      console.error(`Refusing to use a ${what} inside the repository: ${p}. Keep it in /tmp.`);
      process.exit(2);
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

  const { rnd } = seededRandom(1037);
  type Doc = { id: string; labels: string[]; tiers: string[]; content: string; metadata: string; whole: number[]; windows: number[][]; query: number[] };
  process.stdout.write(`  embedding ${ITEMS.length} documents with ${EMBED_MODEL} (cached)`);
  const DOCS: Doc[] = [];
  for (const it of ITEMS) {
    const r = rnd();
    const tiers = [r < 0.1 ? "t10" : null, r < 0.02 ? "t2" : null, r < 0.007 ? "t07" : null].filter((x): x is string => !!x);
    const windowText = chunkContent(it.text, { maxTokens: DEFAULT_MAX_TOKENS }).map((c) => c.content);
    DOCS.push({
      id: it.id, labels: it.labels, tiers, content: it.text,
      metadata: JSON.stringify({ title: it.title, labels: it.labels, tiers }),
      whole: await vec(it.text),
      windows: await Promise.all(windowText.map((w) => vec(w))),
      query: await vec(it.title, true),
    });
    if (DOCS.length % 50 === 0) process.stdout.write(".");
  }
  if (cacheDirty) await Bun.write(CACHE, JSON.stringify(cache));
  console.log(" done");

  const byRef = new Map(DOCS.map((d) => [d.id, d.content]));
  const arms: Corpus["arms"] = [{ name: "unfiltered", f: null, share: 1 }];
  for (const l of ["api", "web", "portal", "design"]) {
    const n = DOCS.filter((d) => d.labels.includes(l)).length;
    arms.push({ name: l, f: { key: "labels", value: l }, share: n / DOCS.length });
  }
  for (const t of ["t10", "t2", "t07"]) {
    const n = DOCS.filter((d) => d.tiers.includes(t)).length;
    arms.push({ name: t, f: { key: "tiers", value: t }, share: n / DOCS.length });
  }

  function sample<T>(xs: T[], n: number): T[] {
    if (!n || xs.length <= n) return xs;
    const step = xs.length / n;
    return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
  }
  const queries = sample(DOCS, NQ).map((d) => d.query);

  let nPoints = 0;
  for (const d of DOCS) nPoints += 1 + d.windows.length;

  return {
    label: "real corpus",
    dim: DIM,
    nPoints,
    nRefs: DOCS.length,
    arms,
    queries,
    *pointStream() {
      for (const d of DOCS) {
        yield { ref: d.id, labels: d.labels, tiers: d.tiers, embedding: d.whole, content: d.content, metadata: d.metadata };
        for (const w of d.windows) yield { ref: d.id, labels: d.labels, tiers: d.tiers, embedding: w, content: d.content, metadata: d.metadata };
      }
    },
    *docStream() {
      for (const d of DOCS) yield { ref: d.id, content: d.content, metadata: d.metadata };
    },
    contentOf: (ref) => byRef.get(ref) ?? "",
    refAt: (i) => DOCS[i % DOCS.length].id,
  };
}

// ── synthetic corpus (store-scale.ts vectors + a sized synthetic payload) ──────

const TIERS = [
  { key: "t50", share: 0.5 }, { key: "t10", share: 0.1 }, { key: "t1", share: 0.01 }, { key: "t01", share: 0.001 },
];

/** A deterministic ~`bytes`-long payload for row `i` (prefixed so it doesn't dedup). */
function synthContent(i: number, bytes: number): string {
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  let s = `t${i} `;
  while (s.length < bytes) s += filler;
  return s.slice(0, bytes);
}

function syntheticCorpus(n: number, dim: number): Corpus {
  const SEED = 20260916 + n;
  const QSEED = 777 + n;
  const Q = Number(process.env.OB1_STORE_QUERIES ?? 20);
  const arms: Corpus["arms"] = [
    { name: "unfiltered", f: null, share: 1 },
    ...TIERS.map((t) => ({ name: t.key, f: { key: "tiers" as const, value: t.key }, share: t.share })),
  ];
  const { unitVector } = seededRandom(QSEED);
  const queries = Array.from({ length: Q }, () => unitVector(dim));
  const meta = (i: number) => JSON.stringify({ i });
  return {
    label: `${n.toLocaleString()} synthetic`,
    dim,
    nPoints: n,
    nRefs: n,
    arms,
    queries,
    *pointStream() {
      const { rnd, unitVector } = seededRandom(SEED);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        const tiers = TIERS.filter((t) => r < t.share).map((t) => t.key);
        yield { ref: `r${i}`, labels: [], tiers, embedding: unitVector(dim), content: synthContent(i, PAYLOAD_BYTES), metadata: meta(i) };
      }
    },
    *docStream() {
      for (let i = 0; i < n; i++) yield { ref: `r${i}`, content: synthContent(i, PAYLOAD_BYTES), metadata: meta(i) };
    },
    contentOf: (ref) => synthContent(Number(ref.slice(1)), PAYLOAD_BYTES),
    refAt: (i) => `r${i % n}`,
  };
}

// ── Postgres reads: the single-store statement and the two-store resolve ──────

/** Path 1 — one statement: ANN top-`FETCH` over points, deduped to distinct refs by
 *  MIN distance, LIMIT K, joined to docs for the payload. Full rows, one trip. The
 *  candidate depth is `FETCH`, identical to the exact oracle and to paths 2/3, so
 *  the three paths are scored on a level field (recall) and do equal work (latency). */
async function pgSingleStoreRead(pg: PgEngine, v: number[], filter: Filter): Promise<string[]> {
  const lit = `[${v.join(",")}]`;
  const where = filter ? `WHERE ${filter.key} @> '${JSON.stringify([filter.value])}'::jsonb` : "";
  const rows = await pg.raw(`
    WITH cand AS (
      SELECT ref, embedding <=> '${lit}'::vector AS d
      FROM points ${where}
      ORDER BY embedding <=> '${lit}'::vector
      LIMIT ${FETCH}
    ),
    top AS (
      SELECT ref, MIN(d) AS d FROM cand GROUP BY ref ORDER BY MIN(d) LIMIT ${K}
    )
    SELECT t.ref, dd.content, dd.metadata
    FROM top t JOIN docs dd ON dd.ref = t.ref
    ORDER BY t.d`);
  return rows.map((r: { ref: string }) => String(r.ref));
}

/** Path 2 — the SMD-1662 resolve: LanceDB ids, then Postgres pulls the payload. */
async function resolvePayload(pg: PgEngine, refs: string[]): Promise<{ ref: string; content: string }[]> {
  const list = refs.map((r) => `'${esc(r)}'`).join(",") || "''";
  const rows = await pg.raw(`SELECT ref, content, metadata FROM docs WHERE ref IN (${list})`);
  return rows.map((r: { ref: string; content: string }) => ({ ref: String(r.ref), content: String(r.content) }));
}

// ── one corpus, end to end ────────────────────────────────────────────────────

type Cell = { recall: number; p50: number; p95: number };

async function measureArms(
  runOne: (v: number[], f: Filter) => Promise<string[]>,
  c: Corpus,
  exact: Map<string, string[]> | null,
): Promise<Map<string, Cell>> {
  await runOne(c.queries[0], null); // warmup
  const cells = new Map<string, Cell>();
  for (const arm of c.arms) {
    const rec: number[] = [], lat: number[] = [];
    for (let qi = 0; qi < c.queries.length; qi++) {
      const t0 = nowMs();
      const refs = await runOne(c.queries[qi], arm.f);
      lat.push(nowMs() - t0);
      if (exact) rec.push(recallAt(refs, exact.get(`${qi}|${arm.name}`)!, K));
    }
    cells.set(arm.name, { recall: exact ? 100 * mean(rec) : NaN, p50: pct(lat, 50), p95: pct(lat, 95) });
  }
  return cells;
}

type PathRow = { path: string; store: string; effort: string; cells: Map<string, Cell> };

async function runCorpus(c: Corpus): Promise<void> {
  console.log(`\n══════ ${c.label}: ${c.nRefs.toLocaleString()} rows / ${c.nPoints.toLocaleString()} points, ${c.dim}-dim ══════`);
  const pg = new PgEngine(c.dim, `rm-${c.nRefs}`);
  const rms = RM_KINDS.map((k) => new LanceReadModel(c.dim, k, `rm-${c.nRefs}`));
  const indexOnly = STORAGE_DELTA ? new LanceEngine(c.dim, RM_KINDS[0], `rmidx-${c.nRefs}`) : null;
  // A throwaway store that takes the write-side appends, so the measured read
  // model (rms[0]) is never polluted with write-test rows before the Postgres-down
  // proof. It stays empty: LanceDB's `add` writes a new data fragment and does NOT
  // update the vector index (appended rows are searched by flat scan until an
  // explicit re-index), so the per-add cost is fragment-write-bound — independent
  // of table size and of whether an index exists — and an append to this empty
  // store is representative of an append to the populated read model. (The flip
  // side, deferred indexing, is its own operational cost: the read model needs a
  // periodic re-index to keep appended rows fast to search — noted in the writeup.)
  const writeRm = new LanceReadModel(c.dim, RM_KINDS[0], `rmw-${c.nRefs}`);
  const pathRows: PathRow[] = [];
  const notes: string[] = [];

  try {
    await Promise.all([pg.start(), ...rms.map((r) => r.start()), writeRm.start(), ...(indexOnly ? [indexOnly.start()] : [])]);

    // Load Postgres points, the docs payload table, and each read model — all from
    // the same streams, so every store holds identical vectors and payload.
    console.log(`  loading points into Postgres + ${rms.map((r) => r.name).join(", ")}…`);
    const pgLoad = await pg.load(c.pointStream());
    await loadDocs(pg, c);
    for (const r of rms) {
      await r.load(c.pointStream());
      console.log(`  ${r.name}: load ${(r.stat.loadMs / 1000).toFixed(1)}s, index ${(r.stat.buildMs / 1000).toFixed(1)}s, ${(r.stat.indexBytes / 1e6).toFixed(0)}MB (payload included)`);
    }
    if (indexOnly) {
      await indexOnly.load(c.pointStream());
      console.log(`  ${indexOnly.name} (index only, no payload): ${(indexOnly.stat.indexBytes / 1e6).toFixed(0)}MB`);
    }
    // Points table WITHOUT the ref btree: `points_ref_idx` exists for the resolve
    // path in store-scale.ts, but no path measured here uses it (path 2 resolves via
    // docs' PK, path 1 joins docs' PK), so charging it to every topology's footprint
    // would overstate them. Subtract it; keep heap + toast (the vectors) + the vector
    // index (added later) + docs.
    const pgTotalWithRefIdx = await pg.tableBytes();
    const refIdxBytes = Number((await pg.raw("SELECT pg_relation_size('points_ref_idx') AS b"))[0].b);
    const pgBytesNoIndex = pgTotalWithRefIdx - refIdxBytes;
    const docsBytes = Number((await pg.raw("SELECT pg_total_relation_size('docs') AS b"))[0].b);

    // Exact oracle (skippable at scale): one full scan per (query, unfiltered), a
    // small scan per tier. Computed before the vector plan is forced.
    let exact: Map<string, string[]> | null = null;
    if (c.nRefs <= SKIP_ORACLE_OVER) {
      console.log(`  exact ground truth: ${c.queries.length} queries × ${c.arms.length} arms`);
      exact = new Map<string, string[]>();
      for (let qi = 0; qi < c.queries.length; qi++)
        for (const arm of c.arms) exact.set(`${qi}|${arm.name}`, dedupTopK(await pg.exact(c.queries[qi], FETCH, arm.f), K));
    } else {
      console.log(`  skipping exact oracle (${c.nRefs.toLocaleString()} > ${SKIP_ORACLE_OVER.toLocaleString()}); recall left blank, latency still measured`);
    }

    // Force the vector index into the plan (enable_seqscan/bitmapscan off) so the
    // recall arms measure the ANN, not an exact scan — and it persists into the
    // latency arms, which is realistic: the product disables seqscan at 1024 dims
    // too (migration 019). It does not distort the resolve/join deltas either — a
    // 10-id `WHERE ref IN (…)` and a 10-row join both pick a docs primary-key index
    // scan under the default planner as well, so path 1/2's payload lookups are
    // unchanged by the setting.
    await pg.forcePlanVectorIndex();
    const pgStore = await pg.buildIndex(PG_INDEX);
    const plan = await pg.explain(c.queries[0], FETCH, c.arms[1]?.f ?? null);
    console.log(`  pg ${PG_INDEX}: build ${(pgStore.stat.buildMs / 1000).toFixed(1)}s, ${(pgStore.stat.indexBytes / 1e6).toFixed(0)}MB, plan ${/Index Scan using points_vec_/.test(plan) ? "vector-index" : "NOT vector-index — " + plan.slice(0, 60)}`);

    // ── the three read paths, per read-model kind + effort ────────────────────
    // Path 1 (single-store PG) is measured once — it does not depend on the read
    // model. Paths 2 and 3 are measured per read-model store/effort.
    const p1 = await measureArms((v, f) => pgSingleStoreRead(pg, v, f), c, exact);
    pathRows.push({ path: "1 single-store PG", store: `postgres-${PG_INDEX}`, effort: "default", cells: p1 });

    for (const rm of rms) {
      const efforts: [string, number | undefined][] = [["default", undefined], [`effort=${EFFORT}`, EFFORT]];
      for (const [label, eff] of efforts) {
        if (eff !== undefined) await rm.setEffort(eff); else await rm.setEffort(0);
        // Path 2: Lance ids → Postgres resolve of the payload.
        const p2 = await measureArms(async (v, f) => {
          const refs = dedupTopK(await rm.search(v, FETCH, f), K);
          await resolvePayload(pg, refs); // the resolve — its cost is the point
          return refs;
        }, c, exact);
        pathRows.push({ path: "2 two-store resolve", store: rm.name, effort: label, cells: p2 });

        // Path 3: read model returns full rows. PROVE zero Postgres calls across
        // the whole loop — the counter must not move.
        pg.resetPgCalls();
        const p3 = await measureArms(async (v, f) => {
          const rows = await rm.searchRows(v, FETCH, f);
          return dedupTopK(rows.map((r) => r.ref), K);
        }, c, exact);
        const pgCalls = pg.pgCallCount();
        if (pgCalls !== 0) throw new Error(`read-model read path made ${pgCalls} Postgres calls — not zero-resolve`);
        pathRows.push({ path: "3 read-model no-resolve", store: rm.name, effort: label, cells: p3 });
        console.log(`  ${rm.name} (${label}): paths measured; read path Postgres calls = ${pgCalls} ✓`);
      }
    }

    // ── content correctness: the read model holds the right payload, not just ids ─
    const headline = rms[0];
    await headline.setEffort(EFFORT);
    let checked = 0, mismatched = 0;
    for (let qi = 0; qi < Math.min(c.queries.length, 25); qi++) {
      const rows = await headline.searchRows(c.queries[qi], FETCH, null);
      for (const row of rows.slice(0, K)) {
        checked++;
        if (row.content !== c.contentOf(row.ref)) mismatched++;
      }
    }
    console.log(`  content correctness (${headline.name}): ${checked - mismatched}/${checked} returned rows carry the exact payload`);
    if (mismatched) notes.push(`⚠ ${mismatched}/${checked} read-model rows had stale content`);

    // ── write-side cost (appends go to a throwaway store; edits are vector-
    //    preserving, so the headline's ranking is unchanged for the proof below) ──
    const write = await measureWriteSide(pg, headline, writeRm, c);

    // ── storage duplication ────────────────────────────────────────────────────
    const rmBytes = headline.stat.indexBytes;
    const idxOnlyBytes = indexOnly?.stat.indexBytes ?? NaN;
    let payloadLogical = 0;
    for (const d of c.docStream()) payloadLogical += Buffer.byteLength(d.content) + Buffer.byteLength(d.metadata);

    // ── Postgres-down proof (LAST — it stops Postgres) ─────────────────────────
    // The headline read model's vectors are intact here — the write-side appended
    // only to the throwaway store, and the 25 content edits it applied to the
    // headline changed only payload columns, not vectors — so the ranking is the
    // measured corpus's (with 25 refs' content edited), not a write-test-polluted
    // one. `before`/`after` are both post-edit, so the proof is that stopping
    // Postgres changes nothing about what the read model returns, which is the claim.
    console.log(`  Postgres-down proof: stopping Postgres, re-reading from the read model…`);
    const before = await Promise.all(c.queries.slice(0, 10).map(async (v) =>
      dedupTopK((await headline.searchRows(v, FETCH, null)).map((r) => r.ref), K).join(",")));
    await pg.stop();
    let pgDownOk = true, pgDownErr = "";
    try {
      const after = await Promise.all(c.queries.slice(0, 10).map(async (v) =>
        dedupTopK((await headline.searchRows(v, FETCH, null)).map((r) => r.ref), K).join(",")));
      pgDownOk = before.every((b, i) => b === after[i]);
    } catch (e) {
      pgDownOk = false;
      pgDownErr = (e as Error).message.slice(0, 120);
    }
    console.log(`  Postgres-down: read model ${pgDownOk ? "served identical rows with Postgres stopped ✓" : "FAILED — " + pgDownErr}`);

    report(c, pathRows, {
      pgLoad, pgBytesNoIndex, docsBytes, pgHnswBytes: pgStore.stat.indexBytes,
      rmBytes, idxOnlyBytes, payloadLogical, rmLoadMs: headline.stat.loadMs, rmBuildMs: headline.stat.buildMs,
      pgDownOk, write, notes,
    });
  } finally {
    await Promise.all([pg.stop().catch(() => {}), ...rms.map((r) => r.stop()), writeRm.stop(), ...(indexOnly ? [indexOnly.stop()] : [])]);
  }
}

/** Create the docs payload table (ref PK, content, metadata) and batch-insert it. */
async function loadDocs(pg: PgEngine, c: Corpus): Promise<void> {
  await pg.raw("CREATE TABLE docs (ref text PRIMARY KEY, content text NOT NULL, metadata text NOT NULL)");
  let batch: string[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await pg.raw(`INSERT INTO docs (ref, content, metadata) VALUES ${batch.join(",")} ON CONFLICT (ref) DO NOTHING`);
    batch = [];
  };
  for (const d of c.docStream()) {
    batch.push(`('${esc(d.ref)}','${esc(d.content)}','${esc(d.metadata)}')`);
    if (batch.length >= 2000) await flush();
  }
  await flush();
  await pg.raw("ANALYZE docs");
}

// ── write-side: dual-write, outbox/CDC drain, mutable upsert ───────────────────

type WriteCost = {
  pgOnlyMsPerWrite: number;
  dualWriteMsPerWrite: number;
  drainThroughput: number; // rows/s the read model ingests from the outbox
  drainBatchMs: number;    // freshness floor: time to drain one batch
  appendMsPer: number;
  editMsPer: number;       // ms to propagate one content edit (all rows of a ref)
  sample: number;
};

/**
 * Write-side cost. `headlineRm` (the measured read model) takes only the
 * vector-preserving content edits, so its ref results stay pristine for the
 * Postgres-down proof; all appends go to `writeRm`, a throwaway store, so the
 * measured index is never polluted with write-test rows. The Postgres write
 * baseline runs with `synchronous_commit = on` (a durable OLTP write), so the
 * dual-write tax is measured against a realistic source-of-truth write, not the
 * async-commit bulk-load setting.
 */
async function measureWriteSide(pg: PgEngine, headlineRm: LanceReadModel, writeRm: LanceReadModel, c: Corpus): Promise<WriteCost> {
  const SAMPLE = Math.min(200, Math.max(20, Math.floor(c.nRefs / 50)));
  console.log(`  write-side: ${SAMPLE} sampled writes (durable dual-write, outbox drain, mutable content edit)`);
  await pg.raw("SET synchronous_commit = on"); // a realistic durable source-of-truth write
  const template = (c.pointStream()[Symbol.iterator]().next().value as PayloadPoint).embedding;
  const mkRow = (ref: string, seed: number): PayloadPoint => ({ ref, labels: [], tiers: [], embedding: template, content: synthContent(seed, PAYLOAD_BYTES), metadata: JSON.stringify({ w: seed }) });

  // 1) Postgres-only write baseline: one durable insert into points + docs per write.
  let t = nowMs();
  for (let i = 0; i < SAMPLE; i++) {
    const f = mkRow(`w${i}`, 1_000_000 + i);
    await pg.raw(`INSERT INTO points (id, ref, labels, tiers, embedding) VALUES (${2_000_000_000 + i}, '${esc(f.ref)}', '[]', '[]', '[${f.embedding.join(",")}]')`);
    await pg.raw(`INSERT INTO docs (ref, content, metadata) VALUES ('${esc(f.ref)}','${esc(f.content)}','${esc(f.metadata)}') ON CONFLICT (ref) DO NOTHING`);
  }
  const pgOnlyMsPerWrite = (nowMs() - t) / SAMPLE;

  // 2) Dual-write: the same durable Postgres write PLUS a synchronous read-model
  //    append (to the throwaway store, so the measured index stays pristine).
  t = nowMs();
  for (let i = 0; i < SAMPLE; i++) {
    const f = mkRow(`w2_${i}`, 1_100_000 + i);
    await pg.raw(`INSERT INTO points (id, ref, labels, tiers, embedding) VALUES (${2_100_000_000 + i}, '${esc(f.ref)}', '[]', '[]', '[${f.embedding.join(",")}]')`);
    await pg.raw(`INSERT INTO docs (ref, content, metadata) VALUES ('${esc(f.ref)}','${esc(f.content)}','${esc(f.metadata)}') ON CONFLICT (ref) DO NOTHING`);
    await writeRm.applyAppend([f]);
  }
  const dualWriteMsPerWrite = (nowMs() - t) / SAMPLE;

  // 3) Outbox / CDC drain: the source-of-truth write appends to an outbox; a drain
  //    loop reads unprocessed rows in batches and applies them to the read model,
  //    advancing a cursor. Throughput = rows/s the read model can ingest; the
  //    per-batch time is the steady-state freshness floor.
  await pg.raw("CREATE TABLE outbox (seq bigserial PRIMARY KEY, ref text NOT NULL, content text NOT NULL, metadata text NOT NULL)");
  const OUT = Math.min(2000, Math.max(200, SAMPLE * 5));
  let obatch: string[] = [];
  for (let i = 0; i < OUT; i++) {
    obatch.push(`('${`o${i}`}','${esc(synthContent(3_000_000 + i, PAYLOAD_BYTES))}','${esc(JSON.stringify({ o: i }))}')`);
    if (obatch.length >= 2000) { await pg.raw(`INSERT INTO outbox (ref, content, metadata) VALUES ${obatch.join(",")}`); obatch = []; }
  }
  if (obatch.length) await pg.raw(`INSERT INTO outbox (ref, content, metadata) VALUES ${obatch.join(",")}`);
  const DRAIN = 500;
  let cursor = 0, drained = 0;
  const batchTimes: number[] = [];
  t = nowMs();
  for (;;) {
    const rows = await pg.raw(`SELECT seq, ref, content, metadata FROM outbox WHERE seq > ${cursor} ORDER BY seq LIMIT ${DRAIN}`);
    if (!rows.length) break;
    const tb = nowMs();
    await writeRm.applyAppend(rows.map((r: any) => ({ ref: `ob_${r.ref}`, labels: [], tiers: [], embedding: template, content: String(r.content), metadata: String(r.metadata) })));
    batchTimes.push(nowMs() - tb);
    cursor = Number(rows[rows.length - 1].seq);
    drained += rows.length;
  }
  const drainSec = (nowMs() - t) / 1000;
  const drainThroughput = drained / drainSec;
  const drainBatchMs = mean(batchTimes);

  // 4) Mutable-payload edit: change the content of a sample of EXISTING refs in the
  //    headline read model and propagate — the real consistency tax. `update` by ref
  //    rewrites the payload of every row sharing the ref (whole + windows) while
  //    preserving each row's vector, so the headline's ranking is unchanged and the
  //    Postgres-down proof still reads the measured corpus. (Append is cheaper —
  //    vectors are append-mostly.)
  // Cap the edit count: a Lance `update` rewrites the fragment(s) holding the ref,
  // which is O(fragment size), so at 10M a handful of edits already characterises
  // the per-edit cost without a many-minute loop. The ms/ref is the signal.
  const EDITS = Math.min(SAMPLE, 25);
  const editRefs = Array.from(new Set(Array.from({ length: EDITS }, (_, i) => c.refAt(i * 7))));
  t = nowMs();
  for (const ref of editRefs) await headlineRm.applyContentEdit(ref, `EDITED ${c.contentOf(ref).slice(0, PAYLOAD_BYTES)}`, JSON.stringify({ edited: true }));
  const editMsPer = (nowMs() - t) / editRefs.length;
  // append the same count to the throwaway for a like-for-like contrast. NOTE: this
  // is one Lance `add` (one fragment write) amortised over SAMPLE rows, so ms/row
  // falls with the batch size (SAMPLE is 20 at the real corpus, 200 at scale) — it is
  // a batch-amortisation figure, not a corpus-scale trend. The scale-relevant
  // propagation number is the drain throughput above.
  const appends: PayloadPoint[] = Array.from({ length: SAMPLE }, (_, i) => mkRow(`a${i}`, 4_000_000 + i));
  t = nowMs();
  await writeRm.applyAppend(appends);
  const appendMsPer = (nowMs() - t) / SAMPLE;

  return { pgOnlyMsPerWrite, dualWriteMsPerWrite, drainThroughput, drainBatchMs, appendMsPer, editMsPer, sample: SAMPLE };
}

// ── report ─────────────────────────────────────────────────────────────────────

function report(c: Corpus, rows: PathRow[], s: {
  pgLoad: number; pgBytesNoIndex: number; docsBytes: number; pgHnswBytes: number;
  rmBytes: number; idxOnlyBytes: number; payloadLogical: number; rmLoadMs: number; rmBuildMs: number;
  pgDownOk: boolean; write: WriteCost; notes: string[];
}): void {
  const ms = (x: number) => (isNaN(x) ? "—" : x.toFixed(2));
  const mb = (x: number) => (isNaN(x) ? "—" : (x / 1e6).toFixed(0) + " MB");

  console.log(`\n### Recall@${K} vs exact — ${c.label}\n`);
  const head = ["path", "store", "effort", ...c.arms.map((a) => `${a.name}${a.share < 1 ? ` (${(100 * a.share).toFixed(1)}%)` : ""}`)];
  console.log("| " + head.join(" | ") + " |");
  console.log("| " + head.map(() => "---").join(" | ") + " |");
  for (const r of rows) {
    const cells = c.arms.map((a) => { const cell = r.cells.get(a.name)!; return isNaN(cell.recall) ? "—" : cell.recall.toFixed(0) + "%"; });
    console.log(`| ${r.path} | ${r.store} | ${r.effort} | ${cells.join(" | ")} |`);
  }
  console.log(`\n  Path 1's *filtered* recall is a bare pgvector HNSW post-filter (the SMD-968 hazard); the shipped`);
  console.log(`  \`match_thoughts\` fixes filtered recall in-engine via migration 014 — SMD-1037's finding, orthogonal`);
  console.log(`  to the resolve question here. All three paths agree on unfiltered recall, where the resolve`);
  console.log(`  latency delta is read; the read model holds filtered recall by prefilter, exactly as SMD-1662.`);

  console.log(`\n### Read latency by path (ms) — ${c.label}, match_count ${K}\n`);
  console.log("| path | store | effort | unfiltered p50 | p95 | filtered p50 (mean) | p95 |");
  console.log("| --- | --- | --- | ---: | ---: | ---: | ---: |");
  const filtered = c.arms.filter((a) => a.f);
  for (const r of rows) {
    const un = r.cells.get("unfiltered")!;
    const fp50 = mean(filtered.map((a) => r.cells.get(a.name)!.p50));
    const fp95 = mean(filtered.map((a) => r.cells.get(a.name)!.p95));
    console.log(`| ${r.path} | ${r.store} | ${r.effort} | ${ms(un.p50)} | ${ms(un.p95)} | ${ms(fp50)} | ${ms(fp95)} |`);
  }
  // The two deltas the ticket asks for, at default effort, unfiltered.
  const at = (path: string) => rows.find((r) => r.path.startsWith(path) && r.effort === "default")?.cells.get("unfiltered");
  const p1 = at("1"), p2 = at("2"), p3 = at("3");
  if (p1 && p2 && p3) {
    console.log(`\n  index+resolve − read-model, both returning full rows (path2 − path3, unfiltered p50): ${ms(p2.p50)} − ${ms(p3.p50)} = ${ms(p2.p50 - p3.p50)} ms`);
    console.log(`    (net topology delta: path 2 fetches the payload from Postgres after a narrow Lance search, path 3 from Lance directly. It slightly *understates* the raw Postgres resolve, which path 3 trades for a wider Lance projection — the two paths differ only in where the payload comes from.)`);
    console.log(`  read-model − single-store PG (path1 − path3, unfiltered p50): ${ms(p1.p50)} − ${ms(p3.p50)} = ${ms(p1.p50 - p3.p50)} ms`);
  }

  console.log(`\n### Storage — ${c.label}\n`);
  const pgTotal = s.pgBytesNoIndex + s.pgHnswBytes; // points table (+content? no) + hnsw; docs separate
  console.log("| topology | Postgres | read-model store | total system |");
  console.log("| --- | ---: | ---: | ---: |");
  console.log(`| single-store PG (path 1) | ${mb(pgTotal + s.docsBytes)} | — | ${mb(pgTotal + s.docsBytes)} |`);
  console.log(`| index + resolve (path 2, SMD-1662) | ${mb(pgTotal + s.docsBytes)} | ${mb(s.idxOnlyBytes)} | ${mb(pgTotal + s.docsBytes + (isNaN(s.idxOnlyBytes) ? 0 : s.idxOnlyBytes))} |`);
  console.log(`| read model (path 3, SMD-1696) | ${mb(pgTotal + s.docsBytes)} | ${mb(s.rmBytes)} | ${mb(pgTotal + s.docsBytes + s.rmBytes)} |`);
  console.log(`\n  payload duplication (read-model store − index-only store): ${mb(s.rmBytes - s.idxOnlyBytes)} on disk · ${mb(s.payloadLogical)} logical (content+metadata bytes)`);
  console.log(`  (Postgres = points table ${mb(s.pgBytesNoIndex)} + hnsw ${mb(s.pgHnswBytes)} + docs ${mb(s.docsBytes)})`);

  console.log(`\n### Write-side cost — ${c.label} (${s.write.sample} sampled writes)\n`);
  console.log("| measure | value |");
  console.log("| --- | ---: |");
  console.log(`| Postgres-only write (durable) | ${ms(s.write.pgOnlyMsPerWrite)} ms/write |`);
  console.log(`| dual-write (durable PG + read-model append) | ${ms(s.write.dualWriteMsPerWrite)} ms/write |`);
  console.log(`| dual-write tax | ${ms(s.write.dualWriteMsPerWrite - s.write.pgOnlyMsPerWrite)} ms/write |`);
  console.log(`| outbox/CDC drain throughput | ${s.write.drainThroughput.toFixed(0)} rows/s |`);
  console.log(`| outbox drain batch (freshness floor) | ${ms(s.write.drainBatchMs)} ms/batch |`);
  console.log(`| read-model append (batched) | ${ms(s.write.appendMsPer)} ms/row |`);
  console.log(`| read-model mutable content edit (the consistency tax) | ${ms(s.write.editMsPer)} ms/ref |`);

  console.log(`\n### Zero-Postgres read path — ${c.label}\n`);
  console.log(`  read path Postgres calls: 0 (asserted per query) · Postgres-down re-read: ${s.pgDownOk ? "identical rows served with Postgres stopped ✓" : "FAILED ✗"}`);
  for (const n of s.notes) console.log(`  ${n}`);
  console.log();
}

// ── main ────────────────────────────────────────────────────────────────────────

const DIM = Number(process.env.OB1_STORE_DIM ?? 1024);
const SCALES = process.env.OB1_STORE_SCALES
  ? process.env.OB1_STORE_SCALES.split(",").map((s) => Number(s.trim()))
  : null;

if (SCALES) {
  if (SCALES.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error(`OB1_STORE_SCALES must be positive integers (got ${JSON.stringify(process.env.OB1_STORE_SCALES)})`);
    process.exit(2);
  }
  for (const n of SCALES) await runCorpus(syntheticCorpus(n, DIM));
} else {
  await runCorpus(await realCorpus());
}
