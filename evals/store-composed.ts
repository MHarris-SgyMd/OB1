#!/usr/bin/env bun
/**
 * store-composed.ts — SMD-1707: measure a COMPOSED multi-store match (coarse
 * recall + exact rerank/fuse), not a store race — the axis SMD-1037 (FORK 79),
 * SMD-1662 (FORK 82) and SMD-1696 (FORK 86) all defined away.
 *
 * Those three measured a second store as a SUBSTITUTE: each store doing the whole
 * match (vector ANN top-k + return the rows), racing on latency, answering "which
 * single store serves the read?" The tell is the id→row hop — SMD-1662 treated it
 * as pure cost; SMD-1696 eliminated it (a zero-Postgres read model). But that hop
 * is the PRECISION stage where a multi-store match earns its keep: exact metadata
 * predicates, recency (SMD-945), keyword/FTS fusion (SMD-958). This measures the
 * stores as COMPLEMENTS.
 *
 *   Stage 1 — coarse recall: a scalable ANN engine (LanceDB, the SMD-1662 store)
 *             returns a large candidate set (K′ ≫ k), cheap and shardable.
 *   Stage 2 — exact rerank / fuse in Postgres over that SMALL candidate set: exact
 *             cosine (the ANN's approximate ordering corrected), exact metadata
 *             filter, recency blend (SMD-945), keyword RRF (SMD-958). The "resolve"
 *             reframed as the rerank join.
 *
 * The K′ sweep answers two things at once:
 *   quality — a shallow ANN (substitute, depth k) leaves recall/nDCG on the table;
 *             coarse recall at depth K′ + exact rerank recovers it, rising toward
 *             the exact-cosine oracle as K′ grows, and adds precision (recency,
 *             keyword) the ANN cannot express.
 *   scale   — the stage-2 rerank reads K′ rows, not N, but its wall-clock is NOT
 *             N-independent: at 10M the K′ heap fetches hit a heap past RAM, so it is
 *             cache-bound and run-to-run volatile (K′=1000 measured 36.5 and 108.5 ms
 *             across two runs). What is stable: the exact full scan is ~O(N) (≈30 ms
 *             → ≈380 ms), and the composed TOTAL stays under it, by more at 10M
 *             (~1.4× cheaper at 1M → 2.5–5.1× at 10M). ANN-only recall at fixed depth
 *             degrades with N, so the coarse stage must go deeper (larger K′).
 *
 * Every strategy scores against ONE exact-cosine oracle (Postgres seq scan, index
 * forced out) via recall@10 / nDCG@10 / MRR. Comparators: vector-only ANN@k (the
 * substitute) and single-store Postgres hybrid (vector ⋈ FTS RRF over the whole
 * table, the SMD-1037 hybrid).
 *
 * Eval-only: no migration, no backend, no product change. Reuses the SMD-1037
 * harness (store-backends.ts) — the exact oracle, the point unit, the point→ref
 * dedup, the metric helpers — and its corpus scaffolding (store-compare.ts /
 * store-readmodel.ts). Self-contained: it starts and tears down its own
 * timescaledb-ha container and builds its own `points`/`docs` tables (NOT the
 * product `thoughts`/`match_thoughts`); LanceDB is embedded (a temp dataset dir).
 * LanceDB is Apache-2.0, the fork FSL-1.1-MIT — an eval dep.
 *
 *   bun store-composed.ts                                  # real corpus, full quality sweep
 *   OB1_STORE_QUERIES=15 bun store-composed.ts             # quick smoke
 *   OB1_STORE_KPRIME=10,50,200,1000 bun store-composed.ts  # custom coarse-depth sweep
 *   # scale — latency + the bounded-rerank claim (recall skipped above the oracle cap):
 *   OB1_STORE_SCALES=1000000 OB1_STORE_DIM=64 OB1_STORE_PAYLOAD_BYTES=256 \
 *     OB1_STORE_PG_SHM=3g bun store-composed.ts
 *   OB1_STORE_SCALES=10000000 OB1_STORE_DIM=64 OB1_STORE_PAYLOAD_BYTES=128 \
 *     OB1_STORE_PG_INDEX=ivfflat OB1_STORE_SKIP_ORACLE_OVER=2000000 \
 *     OB1_STORE_MAINT_MEM=3GB OB1_STORE_PG_SHM=3g bun store-composed.ts
 *
 * Knobs: OB1_STORE_KPRIME (coarse-depth sweep, default `10,25,50,100,200,500,1000`),
 * OB1_STORE_KPRIME_HEADLINE (the K′ used in the per-strategy tables, default 200),
 * OB1_STORE_RECENCY_W / OB1_STORE_HALF_LIFE (stage-2 recency blend, default 0.3 /
 * 90 days on the real corpus, off on synthetic), OB1_STORE_KW_FUSE=0 (disable the
 * keyword-RRF fusion arm), OB1_STORE_LANCE_INDEX (coarse store kind, default
 * `hnswsq`), OB1_STORE_PG_INDEX (the coarse-pg control + hybrid vector arm, default
 * `hnsw`; `ivfflat` at 10M), OB1_STORE_FETCH (the substitute's shallow depth,
 * default 50), OB1_STORE_EFFORT (coarse ANN ef/nprobes, default 200),
 * OB1_STORE_SCALES (unset = real corpus), OB1_STORE_DIM, OB1_STORE_PAYLOAD_BYTES,
 * OB1_STORE_QUERIES, OB1_STORE_SKIP_ORACLE_OVER (skip the oracle above N rows —
 * recall/nDCG/MRR left blank, latency + the K′ curve still land).
 */

import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkContent, DEFAULT_MAX_TOKENS } from "../server-portable/chunk.ts";
import { DEFAULT_EMBEDDING_MODEL } from "../db/config.mjs";
import { seededRandom } from "../db/test-support.ts";
import { embed, parseSpec } from "./lib.ts";
import {
  PgEngine, PgStore, LanceEngine, dedupTopK, recallAt, nDCG, mrr, nowMs,
  type Point, type Filter, type LanceIndexKind, type PgIndexKind,
} from "./store-backends.ts";

const K = 10;
const FETCH = Number(process.env.OB1_STORE_FETCH ?? 50);
const EFFORT = Number(process.env.OB1_STORE_EFFORT ?? 200);
const PAYLOAD_BYTES = Number(process.env.OB1_STORE_PAYLOAD_BYTES ?? 512);
const KPRIMES = (process.env.OB1_STORE_KPRIME ?? "10,25,50,100,200,500,1000")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const KPRIME_HEADLINE = Number(process.env.OB1_STORE_KPRIME_HEADLINE ?? 200);
const LANCE_KIND = (process.env.OB1_STORE_LANCE_INDEX ?? "hnswsq") as LanceIndexKind;
const PG_INDEX = (process.env.OB1_STORE_PG_INDEX ?? "hnsw") as PgIndexKind;
const SKIP_ORACLE_OVER = Number(process.env.OB1_STORE_SKIP_ORACLE_OVER ?? Infinity);

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const esc = (s: string) => s.replace(/'/g, "''");

// A query carries both the vector (every arm) and a keyword string drawn from the
// title (the keyword-RRF fusion arm + the single-store hybrid comparator).
type Query = { vec: number[]; kw: string };

// A corpus: everything a run needs, source-agnostic (real docs or synthetic).
// pointStream yields several points per ref (whole + windows); docStream yields one
// payload per distinct ref plus a deterministic created_at for the recency blend.
type Corpus = {
  label: string;
  dim: number;
  nPoints: number;
  nRefs: number;
  hasText: boolean; // real corpus has real content (keyword arm + hybrid); synthetic does not
  arms: { name: string; f: Filter; share: number }[];
  queries: Query[];
  pointStream: () => Iterable<Point>;
  docStream: () => Iterable<{ ref: string; content: string; createdAtDaysAgo: number }>;
};

async function readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  const f = Bun.file(path);
  if (!(await f.exists())) return { ok: false, missing: true, error: "missing" };
  try {
    return { ok: true, value: JSON.parse(await f.text()) as T };
  } catch (e) {
    return { ok: false, missing: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A keyword string from a title: the first few word-shaped tokens (store-compare.ts:288). */
function keywordOf(title: string): string {
  return (title.match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? []).slice(0, 3).join(" ") || title;
}

// ── real corpus (store-readmodel.ts scaffolding: cached embeddings, whole+windows) ─

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
  type Doc = { id: string; labels: string[]; tiers: string[]; content: string; createdAtDaysAgo: number; whole: number[]; windows: number[][]; query: number[]; kw: string };
  process.stdout.write(`  embedding ${ITEMS.length} documents with ${EMBED_MODEL} (cached)`);
  const DOCS: Doc[] = [];
  for (const it of ITEMS) {
    const r = rnd();
    const tiers = [r < 0.1 ? "t10" : null, r < 0.02 ? "t2" : null, r < 0.007 ? "t07" : null].filter((x): x is string => !!x);
    const windowText = chunkContent(it.text, { maxTokens: DEFAULT_MAX_TOKENS }).map((c) => c.content);
    DOCS.push({
      id: it.id, labels: it.labels, tiers, content: it.text,
      // A deterministic recency spread over ~2 years, drawn from the same seeded
      // stream — the corpus carries no timestamp, so recency is seeded (the blend
      // is what is under test, not the corpus's real dates).
      createdAtDaysAgo: Math.floor(rnd() * 730),
      whole: await vec(it.text),
      windows: await Promise.all(windowText.map((w) => vec(w))),
      query: await vec(it.title, true),
      kw: keywordOf(it.title),
    });
    if (DOCS.length % 50 === 0) process.stdout.write(".");
  }
  if (cacheDirty) await Bun.write(CACHE, JSON.stringify(cache));
  console.log(" done");

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
  const queries = sample(DOCS, NQ).map((d) => ({ vec: d.query, kw: d.kw }));

  let nPoints = 0;
  for (const d of DOCS) nPoints += 1 + d.windows.length;

  return {
    label: "real corpus",
    dim: DIM,
    nPoints,
    nRefs: DOCS.length,
    hasText: true,
    arms,
    queries,
    *pointStream() {
      for (const d of DOCS) {
        yield { ref: d.id, labels: d.labels, tiers: d.tiers, embedding: d.whole };
        for (const w of d.windows) yield { ref: d.id, labels: d.labels, tiers: d.tiers, embedding: w };
      }
    },
    *docStream() {
      for (const d of DOCS) yield { ref: d.id, content: d.content, createdAtDaysAgo: d.createdAtDaysAgo };
    },
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
  const queries = Array.from({ length: Q }, () => ({ vec: unitVector(dim), kw: "" }));
  return {
    label: `${n.toLocaleString()} synthetic`,
    dim,
    nPoints: n,
    nRefs: n,
    hasText: false,
    arms,
    queries,
    *pointStream() {
      const { rnd, unitVector } = seededRandom(SEED);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        const tiers = TIERS.filter((t) => r < t.share).map((t) => t.key);
        yield { ref: `r${i}`, labels: [], tiers, embedding: unitVector(dim) };
      }
    },
    *docStream() {
      for (let i = 0; i < n; i++) yield { ref: `r${i}`, content: synthContent(i, PAYLOAD_BYTES), createdAtDaysAgo: (i * 7919) % 730 };
    },
  };
}

// ── the composed match: stage 1 (coarse ANN) + stage 2 (exact rerank/fuse in PG) ─

const litOf = (v: number[]) => `[${v.join(",")}]`;

/** A coarse ANN store the composed match drives: search + an effort (ef/nprobes) knob. */
type CoarseStore = { search(v: number[], n: number, f: Filter): Promise<string[]>; setEffort(ef: number): Promise<void> };
const setEffort = (s: CoarseStore, ef: number) => s.setEffort(ef);

type Fuse = { recencyW: number; halfLife: number; keyword: boolean };

/**
 * Stage 2: the exact rerank/fuse over a candidate ref set, in one of three modes:
 *
 *   pure    — ORDER BY exact cosine (MIN over a ref's window points, the
 *             match_thoughts MAX-similarity rule).
 *   recency — blend the cosine similarity with a recency decay: migration 020's
 *             `recency_score` inlined verbatim, `sim*(1-w) + power(0.5,
 *             GREATEST(age,0)/half_life)*w` (SMD-945). Both terms are on [0,1], so
 *             the blend is well-scaled.
 *   keyword — symmetric reciprocal-rank fusion of the vector RANK and the keyword
 *             RANK within the candidate set, `1/(60+vr) + 1/(60+kr)`. Both terms are
 *             on the RRF scale (~0.016), reproducing search_thoughts_hybrid's
 *             rank fusion over the bounded candidate set (SMD-958). (Fusing a raw
 *             cosine ~1.0 with a rank-RRF ~0.016 keyword term would let the cosine
 *             dominate ~60× and make keyword a no-op — so the vector side is ranked
 *             here too, exactly as the hybrid ranks it.)
 *
 * No ORDER BY over the vector index anywhere — the distance is computed per candidate
 * row, so the rerank is exact within the candidate set by construction, and it reads
 * |cand| = K′ rows, not N. (Rows read is bounded by K′, but wall-clock is not: at a
 * heap past RAM the K′ heap fetches are cache-misses, so the 10M rerank is cache-bound
 * and volatile — see the header's `scale` note.)
 */
function rerankSql(candRefs: string[], vecLit: string, filter: Filter, q: Query, fuse: Fuse): string {
  const values = candRefs.length ? candRefs.map((r) => `('${esc(r)}')`).join(",") : "('__none__')";
  const where = filter ? `WHERE p.${filter.key} @> '${JSON.stringify([filter.value])}'::jsonb` : "";
  const w = fuse.recencyW;
  const useKw = fuse.keyword && q.kw.trim().length > 0;
  const kwCte = useKw
    ? `, kw AS (
         SELECT dc.ref, row_number() OVER (ORDER BY ts_rank(dc.tsv, plainto_tsquery('english','${esc(q.kw)}')) DESC) AS kr
         FROM docs dc JOIN cand USING (ref)
         WHERE dc.tsv @@ plainto_tsquery('english','${esc(q.kw)}'))`
    : "";
  // ORDER BY expression, one per mode (keyword and recency are never combined).
  const order = useKw
    ? "1.0/(60 + v.vr) + COALESCE(1.0/(60 + kw.kr), 0)"                        // symmetric rank RRF
    : w > 0
      ? `(1 - v.d) * (1 - ${w}) + power(0.5, GREATEST(EXTRACT(EPOCH FROM (now() - dc.created_at)), 0) / 86400.0 / ${fuse.halfLife}) * ${w}` // recency blend
      : "(1 - v.d)";                                                          // pure cosine
  return `
    WITH cand(ref) AS (VALUES ${values}),
    vec AS (
      SELECT p.ref, MIN(p.embedding <=> '${vecLit}'::vector) AS d,
             row_number() OVER (ORDER BY MIN(p.embedding <=> '${vecLit}'::vector)) AS vr
      FROM points p JOIN cand USING (ref)
      ${where}
      GROUP BY p.ref
    )${kwCte}
    SELECT v.ref
    FROM vec v JOIN docs dc USING (ref) ${useKw ? "LEFT JOIN kw USING (ref)" : ""}
    ORDER BY (${order}) DESC
    LIMIT ${K}`;
}

/** One composed query: coarse ANN@K′ (timed) → exact rerank/fuse in PG (timed). */
async function composed(
  coarse: CoarseStore,
  pg: PgEngine, q: Query, filter: Filter, kprime: number, fuse: Fuse,
): Promise<{ refs: string[]; t1: number; t2: number }> {
  const t0 = nowMs();
  const cand = dedupTopK(await coarse.search(q.vec, kprime, filter), kprime);
  const t1 = nowMs() - t0;
  const t0b = nowMs();
  const rows = await pg.raw(rerankSql(cand, litOf(q.vec), filter, q, fuse));
  const t2 = nowMs() - t0b;
  return { refs: rows.map((r: { ref: string }) => String(r.ref)), t1, t2 };
}

/** The single-store Postgres hybrid: vector top-N ⋈ keyword over docs, RRF-fused,
 *  over the WHOLE table (store-compare.ts:326-348). The incumbent-hybrid comparator. */
async function pgHybrid(pg: PgEngine, q: Query): Promise<string[]> {
  const lit = litOf(q.vec);
  const kw = esc(q.kw);
  const rows = await pg.raw(`
    WITH vec AS (
      SELECT ref, row_number() OVER (ORDER BY d) AS r FROM (
        SELECT ref, MIN(embedding <=> '${lit}'::vector) AS d
        FROM (SELECT ref, embedding FROM points ORDER BY embedding <=> '${lit}'::vector LIMIT ${FETCH * 4}) c
        GROUP BY ref
      ) g LIMIT ${FETCH}
    ),
    kw AS (
      SELECT ref, row_number() OVER (ORDER BY ts_rank(tsv, plainto_tsquery('english','${kw}')) DESC) AS r
      FROM docs WHERE tsv @@ plainto_tsquery('english','${kw}') LIMIT ${FETCH}
    )
    SELECT ref FROM (
      SELECT ref, SUM(1.0/(60+r)) AS s FROM (
        SELECT ref, r FROM vec UNION ALL SELECT ref, r FROM kw
      ) u GROUP BY ref ORDER BY s DESC LIMIT ${K}
    ) f`);
  return rows.map((r: { ref: string }) => String(r.ref));
}

/**
 * Exact recency-blended top-K over ALL rows — the ground truth for the recency
 * OBJECTIVE (the analogue of pg.exact for the blend, eval-recency.ts:158-161). The
 * +recency composed arm cannot be judged against the pure-cosine oracle: it
 * deliberately optimizes this instead. Must run before forcePlanVectorIndex (it is
 * a full scan; seqscan is still on), like the cosine oracle.
 */
async function recencyOracle(pg: PgEngine, q: Query, filter: Filter, w: number, hl: number): Promise<string[]> {
  const lit = litOf(q.vec);
  const where = filter ? `WHERE p.${filter.key} @> '${JSON.stringify([filter.value])}'::jsonb` : "";
  const rows = await pg.raw(`
    SELECT g.ref FROM (
      SELECT p.ref, MIN(p.embedding <=> '${lit}'::vector) AS d
      FROM points p ${where} GROUP BY p.ref
    ) g JOIN docs dc USING (ref)
    ORDER BY (1 - g.d) * (1 - ${w}) + power(0.5, GREATEST(EXTRACT(EPOCH FROM (now() - dc.created_at)), 0) / 86400.0 / ${hl}) * ${w} DESC
    LIMIT ${K}`);
  return rows.map((r: { ref: string }) => String(r.ref));
}

/** |A ∩ B| / k — how much two top-k rankings agree (the keyword arm vs the full hybrid). */
function overlapAt(a: string[], b: string[], k: number): number {
  const want = new Set(b.slice(0, k));
  return a.slice(0, k).filter((r) => want.has(r)).length / k;
}

// ── measurement ────────────────────────────────────────────────────────────────

type Cell = { recall: number; ndcg: number; mrr: number; p50: number; p95: number };
type StratRow = { strat: string; cells: Map<string, Cell> };
// The fusion measurement (unfiltered): recall vs the recency-blended exact oracle for
// the recency arm, top-k overlap with the whole-table hybrid for the keyword arm.
type FusionResult = {
  recencyW: number; halfLife: number;
  recSubstitute: number; recPure: number; recRecency: number; recP50: number;
  kwPureOverlap: number; kwOverlap: number; kwP50: number;
};

/** Score one strategy (a runOne closure) over every arm, against the oracle. */
async function measure(
  runOne: (q: Query, f: Filter) => Promise<string[]>,
  c: Corpus,
  exact: Map<string, string[]> | null,
): Promise<Map<string, Cell>> {
  await runOne(c.queries[0], null); // warmup
  const cells = new Map<string, Cell>();
  for (const arm of c.arms) {
    const rec: number[] = [], nd: number[] = [], rr: number[] = [], lat: number[] = [];
    for (let qi = 0; qi < c.queries.length; qi++) {
      const t0 = nowMs();
      const refs = await runOne(c.queries[qi], arm.f);
      lat.push(nowMs() - t0);
      if (exact) {
        const gold = exact.get(`${qi}|${arm.name}`)!;
        rec.push(recallAt(refs, gold, K));
        nd.push(nDCG(refs, gold, K));
        rr.push(mrr(refs, gold));
      }
    }
    cells.set(arm.name, {
      recall: exact ? 100 * mean(rec) : NaN,
      ndcg: exact ? mean(nd) : NaN,
      mrr: exact ? mean(rr) : NaN,
      p50: pct(lat, 50), p95: pct(lat, 95),
    });
  }
  return cells;
}

type SweepRow = { kprime: number; recall: number; ndcg: number; mrr: number; t1p50: number; t2p50: number; totalp50: number };

/** The K′ sweep on the unfiltered arm: quality and stage-1/stage-2 latency vs coarse
 *  depth — the composition curve and the bounded-rerank evidence in one table. */
async function sweepKprime(
  coarse: CoarseStore,
  pg: PgEngine, c: Corpus, exact: Map<string, string[]> | null, fuse: Fuse,
): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  for (const kprime of KPRIMES) {
    // The ANN's search breadth must be >= the requested depth (LanceDB/pgvector both
    // require ef >= k); coarse recall wants it high anyway.
    await setEffort(coarse, Math.max(kprime, EFFORT));
    const rec: number[] = [], nd: number[] = [], rr: number[] = [], t1s: number[] = [], t2s: number[] = [], tot: number[] = [];
    await composed(coarse, pg, c.queries[0], null, kprime, fuse); // warmup
    for (let qi = 0; qi < c.queries.length; qi++) {
      const { refs, t1, t2 } = await composed(coarse, pg, c.queries[qi], null, kprime, fuse);
      t1s.push(t1); t2s.push(t2); tot.push(t1 + t2);
      if (exact) {
        const gold = exact.get(`${qi}|unfiltered`)!;
        rec.push(recallAt(refs, gold, K)); nd.push(nDCG(refs, gold, K)); rr.push(mrr(refs, gold));
      }
    }
    rows.push({
      kprime,
      recall: exact ? 100 * mean(rec) : NaN, ndcg: exact ? mean(nd) : NaN, mrr: exact ? mean(rr) : NaN,
      t1p50: pct(t1s, 50), t2p50: pct(t2s, 50), totalp50: pct(tot, 50),
    });
  }
  return rows;
}

// ── one corpus, end to end ─────────────────────────────────────────────────────

async function runCorpus(c: Corpus): Promise<void> {
  console.log(`\n══════ ${c.label}: ${c.nRefs.toLocaleString()} rows / ${c.nPoints.toLocaleString()} points, ${c.dim}-dim ══════`);
  const RECENCY_W = Number(process.env.OB1_STORE_RECENCY_W ?? (c.hasText ? 0.3 : 0));
  const HALF_LIFE = Number(process.env.OB1_STORE_HALF_LIFE ?? 90);
  const KW_FUSE = process.env.OB1_STORE_KW_FUSE !== "0" && c.hasText;
  const purefuse: Fuse = { recencyW: 0, halfLife: HALF_LIFE, keyword: false };

  const pg = new PgEngine(c.dim, `cmp-${c.nRefs}`);
  const coarse = new LanceEngine(c.dim, LANCE_KIND, `cmp-${c.nRefs}`);

  try {
    await Promise.all([pg.start(), coarse.start()]);
    console.log(`  loading ${c.nPoints.toLocaleString()} points into Postgres + ${coarse.name}…`);
    await pg.load(c.pointStream());
    await coarse.load(c.pointStream());
    console.log(`  ${coarse.name}: load ${(coarse.stat.loadMs / 1000).toFixed(1)}s, index ${(coarse.stat.buildMs / 1000).toFixed(1)}s`);
    await coarse.setEffort(EFFORT);
    await loadDocs(pg, c);

    // Exact oracle (skippable at scale) — one full scan per (query, arm), computed
    // before the vector plan is forced.
    let exact: Map<string, string[]> | null = null;
    if (c.nRefs <= SKIP_ORACLE_OVER) {
      console.log(`  exact ground truth: ${c.queries.length} queries × ${c.arms.length} arms`);
      exact = new Map<string, string[]>();
      for (let qi = 0; qi < c.queries.length; qi++)
        for (const arm of c.arms) exact.set(`${qi}|${arm.name}`, dedupTopK(await pg.exact(c.queries[qi].vec, FETCH, arm.f), K));
    } else {
      console.log(`  skipping exact oracle (${c.nRefs.toLocaleString()} > ${SKIP_ORACLE_OVER.toLocaleString()}); recall/nDCG/MRR left blank, latency still measured`);
    }

    // The recency OBJECTIVE's exact ground truth (unfiltered) — computed here, while
    // seqscan is still on, so the +recency arm is judged against what it optimizes.
    let recencyExact: Map<number, string[]> | null = null;
    if (exact && RECENCY_W > 0) {
      recencyExact = new Map<number, string[]>();
      for (let qi = 0; qi < c.queries.length; qi++)
        recencyExact.set(qi, await recencyOracle(pg, c.queries[qi], null, RECENCY_W, HALF_LIFE));
    }

    // Force the vector index for the coarse-pg control + the hybrid vector arm, and
    // build it. The exact rerank does not use the vector index (it computes the
    // distance per candidate row over the ref btree), so this does not affect it.
    await pg.forcePlanVectorIndex();
    const pgStore = await pg.buildIndex(PG_INDEX);
    const plan = await pg.explain(c.queries[0].vec, FETCH, null);
    console.log(`  pg ${PG_INDEX}: build ${(pgStore.stat.buildMs / 1000).toFixed(1)}s, plan ${/Index Scan using points_vec_/.test(plan) ? "vector-index" : "NOT vector-index — " + plan.slice(0, 60)}`);

    // The per-strategy tables (quality + latency) at the headline K′.
    const strat: StratRow[] = [];
    // Substitute first, at the shallow-search effort (ef=EFFORT set after load).
    strat.push({ strat: `vector-only ANN@k (substitute, depth ${FETCH})`, cells: await measure((q, f) => coarse.search(q.vec, FETCH, f).then((r) => dedupTopK(r, K)), c, exact) });
    // The composed arms search to depth K′; the ANN's search breadth must be ≥ that.
    await setEffort(coarse, Math.max(KPRIME_HEADLINE, EFFORT));
    strat.push({ strat: `composed C(${KPRIME_HEADLINE}) — coarse→exact rerank`, cells: await measure((q, f) => composed(coarse, pg, q, f, KPRIME_HEADLINE, purefuse).then((r) => r.refs), c, exact) });
    await setEffort(pgStore, Math.max(KPRIME_HEADLINE, EFFORT));
    strat.push({ strat: `composed C(${KPRIME_HEADLINE}) via pg HNSW coarse (control)`, cells: await measure((q, f) => composed(pgStore, pg, q, f, KPRIME_HEADLINE, purefuse).then((r) => r.refs), c, exact) });
    // NOTE the recency/keyword fusion arms are NOT scored here: they optimize a
    // different objective than the pure-cosine oracle, so scoring them against it
    // would understate them as pure loss. They get the `fusionSection` below, each
    // against the objective it actually serves (a recency-blended exact oracle; the
    // whole-table hybrid as gold).

    // The K′ sweep on the unfiltered arm (pure exact rerank).
    const sweep = await sweepKprime(coarse, pg, c, exact, purefuse);

    // The single-store hybrid comparator (real corpus only — needs real text). It
    // needs the planner free (GIN bitmap for the keyword arm), so it runs last with
    // seq/bitmap scans re-enabled.
    if (c.hasText) {
      await pg.raw("SET enable_seqscan = on");
      await pg.raw("SET enable_bitmapscan = on");
      strat.push({ strat: "single-store PG hybrid (vector ⋈ FTS RRF, whole table)", cells: await measure((q) => pgHybrid(pg, q), c, exact) });
    }

    // The oracle ceiling row: recall 100 by definition where the oracle ran; its
    // latency (the exact full scan) is measured ALWAYS — even at scale where recall
    // is skipped — because the full-scan p50 is the ~O(N) baseline the bounded
    // stage-2 rerank is contrasted against (the scale claim). When the oracle was
    // skipped, time a small sample of full scans just for that anchor.
    {
      const nAnchor = exact ? c.queries.length : Math.min(5, c.queries.length);
      const lat: number[] = [];
      await pg.exact(c.queries[0].vec, K, null); // warmup
      for (let i = 0; i < nAnchor; i++) { const t = nowMs(); await pg.exact(c.queries[i].vec, K, null); lat.push(nowMs() - t); }
      const cells = new Map<string, Cell>();
      for (const arm of c.arms) cells.set(arm.name, { recall: exact ? 100 : NaN, ndcg: exact ? 1 : NaN, mrr: NaN, p50: pct(lat, 50), p95: pct(lat, 95) });
      strat.push({ strat: `exact oracle (full scan, ceiling${exact ? "" : `, ${nAnchor}-query latency anchor`})`, cells });
    }

    // Fusion in the rerank — the precision the ANN can't express, each judged
    // against the objective it serves (unfiltered): recency vs the recency-blended
    // exact oracle; keyword-RRF vs the whole-table hybrid it reproduces at bounded
    // cost. Runs with the planner free (seqscan re-enabled above).
    let fusion: FusionResult | null = null;
    if (exact && c.hasText && (recencyExact || KW_FUSE)) {
      await setEffort(coarse, Math.max(KPRIME_HEADLINE, EFFORT));
      const recSub: number[] = [], recPure: number[] = [], recRec: number[] = [], recLat: number[] = [];
      const kwOv: number[] = [], pureOv: number[] = [], kwLat: number[] = [];
      for (let qi = 0; qi < c.queries.length; qi++) {
        const q = c.queries[qi];
        const pure = (await composed(coarse, pg, q, null, KPRIME_HEADLINE, purefuse)).refs;
        if (recencyExact) {
          const gold = recencyExact.get(qi)!;
          const sub = dedupTopK(await coarse.search(q.vec, FETCH, null), K);
          const t = nowMs();
          const rec = (await composed(coarse, pg, q, null, KPRIME_HEADLINE, { recencyW: RECENCY_W, halfLife: HALF_LIFE, keyword: false })).refs;
          recLat.push(nowMs() - t);
          recSub.push(recallAt(sub, gold, K)); recPure.push(recallAt(pure, gold, K)); recRec.push(recallAt(rec, gold, K));
        }
        if (KW_FUSE) {
          const hy = await pgHybrid(pg, q);
          const t = nowMs();
          const kw = (await composed(coarse, pg, q, null, KPRIME_HEADLINE, { recencyW: 0, halfLife: HALF_LIFE, keyword: true })).refs;
          kwLat.push(nowMs() - t);
          kwOv.push(overlapAt(kw, hy, K)); pureOv.push(overlapAt(pure, hy, K));
        }
      }
      fusion = {
        recencyW: RECENCY_W, halfLife: HALF_LIFE,
        recSubstitute: recencyExact ? 100 * mean(recSub) : NaN,
        recPure: recencyExact ? 100 * mean(recPure) : NaN,
        recRecency: recencyExact ? 100 * mean(recRec) : NaN,
        recP50: pct(recLat, 50),
        kwPureOverlap: KW_FUSE ? 100 * mean(pureOv) : NaN,
        kwOverlap: KW_FUSE ? 100 * mean(kwOv) : NaN,
        kwP50: pct(kwLat, 50),
      };
    }

    report(c, strat, sweep, fusion, { kprimeHeadline: KPRIME_HEADLINE });
  } finally {
    await Promise.allSettled([pg.stop(), coarse.stop()]);
  }
}

/** The docs side-table: content + a tsvector (keyword arm) + a seeded created_at
 *  (recency blend). Built over the harness's own tables, self-contained. */
async function loadDocs(pg: PgEngine, c: Corpus): Promise<void> {
  await pg.raw("CREATE TABLE docs (ref text PRIMARY KEY, content text NOT NULL, tsv tsvector, created_at timestamptz NOT NULL)");
  const nowIso = Date.now();
  let batch: string[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await pg.raw(`INSERT INTO docs (ref, content, tsv, created_at) VALUES ${batch.join(",")} ON CONFLICT (ref) DO NOTHING`);
    batch = [];
  };
  for (const d of c.docStream()) {
    const cts = esc(d.content);
    const created = new Date(nowIso - d.createdAtDaysAgo * 86400e3).toISOString();
    batch.push(`('${esc(d.ref)}','${cts}',to_tsvector('english','${cts}'),'${created}')`);
    if (batch.length >= 2000) await flush();
  }
  await flush();
  await pg.raw("CREATE INDEX docs_tsv_gin ON docs USING gin (tsv)");
  await pg.raw("ANALYZE docs");
}

// ── report ─────────────────────────────────────────────────────────────────────

function report(c: Corpus, strat: StratRow[], sweep: SweepRow[], fusion: FusionResult | null, s: { kprimeHeadline: number }): void {
  const num = (x: number, d = 0) => (isNaN(x) ? "—" : x.toFixed(d));
  const ms = (x: number) => (isNaN(x) ? "—" : x.toFixed(2));

  console.log(`\n### Match quality vs the exact oracle — ${c.label} (recall@${K}%)\n`);
  const head = ["strategy", ...c.arms.map((a) => `${a.name}${a.share < 1 ? ` (${(100 * a.share).toFixed(1)}%)` : ""}`)];
  console.log("| " + head.join(" | ") + " |");
  console.log("| " + head.map(() => "---").join(" | ") + " |");
  for (const r of strat) {
    const cells = c.arms.map((a) => { const cell = r.cells.get(a.name)!; return isNaN(cell.recall) ? "—" : cell.recall.toFixed(0) + "%"; });
    console.log(`| ${r.strat} | ${cells.join(" | ")} |`);
  }

  console.log(`\n### nDCG@${K} / MRR (unfiltered) — ${c.label}\n`);
  console.log("| strategy | nDCG@10 | MRR |");
  console.log("| --- | ---: | ---: |");
  for (const r of strat) { const u = r.cells.get("unfiltered")!; console.log(`| ${r.strat} | ${num(u.ndcg, 3)} | ${num(u.mrr, 3)} |`); }

  console.log(`\n### K′ sweep — coarse depth vs quality and stage cost (unfiltered, pure exact rerank) — ${c.label}\n`);
  console.log("| K′ | recall@10 | nDCG@10 | MRR | stage-1 coarse p50 (ms) | stage-2 rerank p50 (ms) | total p50 (ms) |");
  console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of sweep)
    console.log(`| ${r.kprime} | ${isNaN(r.recall) ? "—" : r.recall.toFixed(0) + "%"} | ${num(r.ndcg, 3)} | ${num(r.mrr, 3)} | ${ms(r.t1p50)} | ${ms(r.t2p50)} | ${ms(r.totalp50)} |`);

  console.log(`\n### Read latency by strategy (ms) — ${c.label}, match_count ${K}\n`);
  console.log("| strategy | unfiltered p50 | p95 | filtered p50 (mean) | p95 |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  const filtered = c.arms.filter((a) => a.f);
  for (const r of strat) {
    const un = r.cells.get("unfiltered")!;
    const fp50 = mean(filtered.map((a) => r.cells.get(a.name)!.p50));
    const fp95 = mean(filtered.map((a) => r.cells.get(a.name)!.p95));
    console.log(`| ${r.strat} | ${ms(un.p50)} | ${ms(un.p95)} | ${ms(fp50)} | ${ms(fp95)} |`);
  }

  // The headline deltas the ticket asks for (unfiltered).
  const sub = strat.find((r) => r.strat.startsWith("vector-only"))?.cells.get("unfiltered");
  const comp = strat.find((r) => r.strat.startsWith(`composed C(${s.kprimeHeadline}) —`))?.cells.get("unfiltered");
  const orc = strat.find((r) => r.strat.startsWith("exact oracle"))?.cells.get("unfiltered");
  console.log();
  if (sub && comp && !isNaN(sub.recall))
    console.log(`  composed C(${s.kprimeHeadline}) − vector-only ANN@k (unfiltered recall@${K}): ${comp.recall.toFixed(0)}% − ${sub.recall.toFixed(0)}% = ${(comp.recall - sub.recall).toFixed(0)} pts — at this K′ the exact rerank only re-orders the SAME candidate set, so recall@k moves only once K′ is deep enough to pull in the missing true neighbours (see the sweep).`);
  // The sweep's deepest K′ is where recall is actually recovered — the composition's headline.
  const deep = [...sweep].reverse().find((r) => !isNaN(r.recall));
  if (sub && deep && !isNaN(sub.recall))
    console.log(`  deep coarse recall recovers it: at K′=${deep.kprime}, recall ${deep.recall.toFixed(0)}% (+${(deep.recall - sub.recall).toFixed(0)} pts over the substitute), total p50 ${ms(deep.totalp50)} ms of which stage-2 rerank ${ms(deep.t2p50)} ms.`);
  if (deep && orc && !isNaN(deep.recall))
    console.log(`  composed C(${deep.kprime}) vs the exact oracle: ${deep.recall.toFixed(0)}% of the exact-scan ceiling at total p50 ${ms(deep.totalp50)} ms vs full-scan ${ms(orc.p50)} ms.`);
  console.log(`  stage-2 rerank reads K′ rows, not N (see the sweep) — its wall-clock still grows with N (index depth + K′ heap fetches leaving cache), but far slower than the ~O(N) full scan, so the gap widens with N.`);
  const deepest = sweep.length ? sweep[sweep.length - 1] : null;
  if (orc && deepest)
    console.log(`  concretely: stage-2 rerank p50 at K′=${deepest.kprime} is ${ms(deepest.t2p50)} ms, vs the exact full scan's ${ms(orc.p50)} ms p50 (${(orc.p50 / deepest.t2p50).toFixed(1)}× the rerank) — compare the ratio across corpus sizes to see it widen.`);
  console.log();

  // Fusion in the rerank — the precision the ANN cannot express, each vs its own
  // objective (not the pure-cosine oracle, which does not capture it).
  if (fusion) {
    console.log(`### Fusion in the rerank — precision the ANN can't express (unfiltered) — ${c.label}\n`);
    if (!isNaN(fusion.recRecency)) {
      console.log(`Recency objective — recall@${K} vs the exact recency-blended oracle (w=${fusion.recencyW}, ${fusion.halfLife}d half-life):\n`);
      console.log("| strategy | recall@10 vs recency oracle |");
      console.log("| --- | ---: |");
      console.log(`| vector-only ANN@k (ignores recency) | ${fusion.recSubstitute.toFixed(0)}% |`);
      console.log(`| composed C(${s.kprimeHeadline}), pure cosine (ignores recency) | ${fusion.recPure.toFixed(0)}% |`);
      console.log(`| composed C(${s.kprimeHeadline}) + recency blend | ${fusion.recRecency.toFixed(0)}% |`);
      console.log(`\n  The exact rerank stage can serve the recency-blended objective (${fusion.recRecency.toFixed(0)}% vs the recency oracle at ${ms(fusion.recP50)} ms p50); the ANN alone cannot express it (${fusion.recSubstitute.toFixed(0)}%). This is the "precision the vector store can't do", quantified — not a recall loss.`);
    }
    if (!isNaN(fusion.kwOverlap)) {
      console.log(`\nKeyword objective — top-${K} overlap with the whole-table PG hybrid (vector ⋈ FTS RRF) it reproduces:\n`);
      console.log("| strategy | top-10 overlap with full hybrid |");
      console.log("| --- | ---: |");
      console.log(`| composed C(${s.kprimeHeadline}), pure cosine (no keyword) | ${fusion.kwPureOverlap.toFixed(0)}% |`);
      console.log(`| composed C(${s.kprimeHeadline}) + keyword RRF | ${fusion.kwOverlap.toFixed(0)}% |`);
      console.log(`\n  Fusing the keyword signal into the rerank over the K′ candidate set moves the composed top-k toward the full-table hybrid (${fusion.kwPureOverlap.toFixed(0)}% → ${fusion.kwOverlap.toFixed(0)}% overlap) at ${ms(fusion.kwP50)} ms p50 — the whole-table hybrid's precision reproduced over a bounded candidate set.`);
    }
    console.log();
  }
}

// ── main ────────────────────────────────────────────────────────────────────────

const DIM = Number(process.env.OB1_STORE_DIM ?? 1024);
const SCALES = process.env.OB1_STORE_SCALES
  ? process.env.OB1_STORE_SCALES.split(",").map((s) => Number(s.trim()))
  : null;

if (!KPRIMES.length) {
  console.error(`OB1_STORE_KPRIME must be a comma list of positive integers (got ${JSON.stringify(process.env.OB1_STORE_KPRIME)})`);
  process.exit(2);
}
if (SCALES) {
  if (SCALES.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error(`OB1_STORE_SCALES must be positive integers (got ${JSON.stringify(process.env.OB1_STORE_SCALES)})`);
    process.exit(2);
  }
  for (const n of SCALES) await runCorpus(syntheticCorpus(n, DIM));
} else {
  await runCorpus(await realCorpus());
}
