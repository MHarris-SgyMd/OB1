#!/usr/bin/env bun
/**
 * store-backends.ts — the store adapters SMD-1037 measures, behind one
 * interface, so `store-compare.ts` (real corpus) and `store-scale.ts`
 * (synthetic 1M/10M) score pgvector, an in-engine alternate index, and an
 * external engine against the same exact-cosine ground truth from the same
 * vectors.
 *
 * The unit is a *point*: one embedding with a `ref` (the thought it belongs to),
 * its filter payload (`labels`, `tiers`), and its vector. A thought's whole-
 * content vector and each of its chunk vectors are separate points that share a
 * ref, exactly as the server stores them (migration 007). Retrieval returns
 * points; the caller dedups to distinct refs by MAX score — `match_thoughts`'
 * own rule — so what is compared across stores is the index, not the app-side
 * fusion that sits on top of it identically in every store.
 *
 * The bracket SMD-1037 asks for — a different index in the same engine, and a
 * different engine — is four indexes across two engines:
 *   - pgvector HNSW      the incumbent (what `match_thoughts` walks today)
 *   - pgvectorscale      StreamingDiskANN in the SAME Postgres (in-engine rung)
 *   - pgvector IVFFlat   a second in-engine index, kept as a control
 *   - Qdrant             a purpose-built external store, ids out + Postgres rows
 *
 * All four pg-side indexes live in one `timescale/timescaledb-ha:pg16` container
 * (pgvector 0.8.6 + pgvectorscale 0.9.1). Qdrant runs in its own container. Both
 * are started and torn down by the harness; nothing here touches the product.
 *
 * Filtered search is measured at each engine's DEFAULT behaviour, because that
 * is the store question: pgvector HNSW post-filters its candidate list (the
 * SMD-968 hazard migration 014 fixed inside `match_thoughts`, absent from a bare
 * index); Qdrant filters inside its graph against a payload index; DiskANN
 * streams filtered. The harness reports what each returns, not a tuned best.
 */

import { SQL } from "bun";

export type Point = { ref: string; labels: string[]; tiers: string[]; embedding: number[] };
export type Filter = { key: "labels" | "tiers"; value: string } | null;
export type BuildStat = { loadMs: number; buildMs: number; indexBytes: number; note?: string };

/** A built, queryable index. `search` returns refs best-first, points not yet deduped. */
export interface Store {
  readonly name: string;
  readonly kind: "pg" | "external";
  readonly stat: BuildStat;
  /** Median-latency-friendly: returns up to `n` point refs in rank order. */
  search(vec: number[], n: number, filter: Filter): Promise<string[]>;
}

// ── docker helpers ───────────────────────────────────────────────────────────

async function docker(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) throw new Error(`docker ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return out.trim();
}

/** Random loopback host port a container published for `containerPort`. */
async function publishedPort(name: string, containerPort: number): Promise<number> {
  const line = await docker(["port", name, String(containerPort)]);
  // "127.0.0.1:54999" (may list several lines; take the first)
  const m = line.split("\n")[0].match(/:(\d+)\s*$/);
  if (!m) throw new Error(`could not read published port for ${name}:${containerPort} from ${JSON.stringify(line)}`);
  return Number(m[1]);
}

export function nowMs(): number {
  return performance.now();
}

// ── Postgres engine (pgvector HNSW / IVFFlat + pgvectorscale DiskANN) ─────────

export type PgIndexKind = "hnsw" | "diskann" | "ivfflat";

const PG_IMAGE = process.env.OB1_STORE_PG_IMAGE ?? "timescale/timescaledb-ha:pg16";

/**
 * One Postgres holding one `points` table. Points are loaded once; each index
 * kind is built, measured and searched, then dropped, so build time and
 * footprint are per index on identical rows. `synchronous_commit = off` and
 * dropped-then-rebuilt indexes mirror db/bench-hnsw.ts' load.
 */
export class PgEngine {
  private sql!: SQL;
  private readonly name: string;
  private loadMs = 0;
  private rows = 0;
  constructor(private readonly dim: number, private readonly tag = String(process.pid)) {
    this.name = `ob1-store-pg-${this.tag}`;
  }

  async start(): Promise<void> {
    await docker(["rm", "-f", this.name], { allowFail: true });
    await docker([
      "run", "-d", "--name", this.name,
      "-e", "POSTGRES_PASSWORD=ob1store", "-e", "POSTGRES_DB=ob1store",
      "--shm-size", process.env.OB1_STORE_PG_SHM ?? "2g",
      "-p", "127.0.0.1::5432", PG_IMAGE,
    ]);
    const port = await publishedPort(this.name, 5432);
    const url = `postgres://postgres:ob1store@127.0.0.1:${port}/ob1store`;
    // timescaledb-ha initdb's, then RESTARTS to load its extensions: a query
    // that succeeds once can still be the pre-restart cluster. Wait for three
    // successes in a row before trusting it.
    let streak = 0;
    for (let i = 0; i < 120; i++) {
      try {
        const probe = new SQL({ url, max: 1 });
        await probe.unsafe("SELECT 1");
        await probe.close();
        streak++;
        if (streak >= 3) break;
      } catch {
        streak = 0;
      }
      await Bun.sleep(500);
    }
    if (streak < 3) throw new Error(`Postgres ${this.name} never became stable`);
    this.sql = new SQL({ url, max: 1 });
    await this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    await this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE");
    await this.sql.unsafe(
      `CREATE TABLE points (id bigint PRIMARY KEY, ref text NOT NULL, labels jsonb NOT NULL, tiers jsonb NOT NULL, embedding vector(${this.dim}) NOT NULL)`,
    );
    await this.sql.unsafe("SET synchronous_commit = off");
  }

  /** Bulk-load points with multi-row INSERTs (Bun's driver has no COPY). */
  async load(points: Iterable<Point>, batchSize = 2000): Promise<number> {
    const t0 = nowMs();
    let batch: { id: number; p: Point }[] = [];
    let id = 0;
    const flush = async () => {
      if (!batch.length) return;
      const values = batch
        .map(({ id, p }) => `(${id},'${p.ref.replace(/'/g, "''")}','${JSON.stringify(p.labels)}','${JSON.stringify(p.tiers)}','[${p.embedding.join(",")}]')`)
        .join(",");
      await this.sql.unsafe(`INSERT INTO points (id, ref, labels, tiers, embedding) VALUES ${values}`);
      batch = [];
    };
    for (const p of points) {
      id++;
      batch.push({ id, p });
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    this.rows = id;
    // A btree on ref so the two-store id→row resolve (store-scale.ts) is an
    // indexed lookup, as it would be against the row store's primary key — not
    // a seq scan that would fabricate the resolve cost.
    await this.sql.unsafe("CREATE INDEX points_ref_idx ON points(ref)");
    await this.sql.unsafe("ANALYZE points");
    this.loadMs = nowMs() - t0;
    return this.loadMs;
  }

  /**
   * Force the vector index to be the plan for `search`, so the filtered arm
   * measures the vector index post-filtering its own candidates (pgvector's
   * SMD-968 behaviour) and never the planner falling back to an exact scan that
   * would flatter recall. Call AFTER the exact oracle is computed — `exact`
   * re-enables a seq scan locally, so the two do not collide.
   */
  async forcePlanVectorIndex(): Promise<void> {
    await this.sql.unsafe("SET enable_seqscan = off");
    await this.sql.unsafe("SET enable_bitmapscan = off");
  }

  /** The plan `search` actually runs for one query+filter — reported once per store. */
  async explain(vec: number[], n: number, filter: Filter): Promise<string> {
    const lit = `[${vec.join(",")}]`;
    const where = filter ? `WHERE ${filter.key} @> '${JSON.stringify([filter.value])}'::jsonb` : "";
    const rows = await this.sql.unsafe(
      `EXPLAIN SELECT ref FROM points ${where} ORDER BY embedding <=> '${lit}'::vector LIMIT ${n}`,
    );
    return rows.map((r: Record<string, string>) => Object.values(r)[0]).join(" | ");
  }

  private indexName(kind: PgIndexKind): string {
    return `points_vec_${kind}`;
  }

  private ddl(kind: PgIndexKind): string {
    const name = this.indexName(kind);
    if (kind === "hnsw") return `CREATE INDEX ${name} ON points USING hnsw (embedding vector_cosine_ops)`;
    if (kind === "ivfflat") {
      const lists = Math.max(1, Math.min(32768, Math.round(Math.sqrt(this.rows))));
      return `CREATE INDEX ${name} ON points USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`;
    }
    return `CREATE INDEX ${name} ON points USING diskann (embedding vector_cosine_ops)`;
  }

  /** Build one index kind, timed, and return a Store bound to it. */
  async buildIndex(kind: PgIndexKind, maintenanceMem = process.env.OB1_STORE_MAINT_MEM ?? "1GB"): Promise<PgStore> {
    await this.sql.unsafe(`SET maintenance_work_mem = '${maintenanceMem}'`);
    // pgvectorscale's parallel DiskANN build is the one that crashed the backend
    // at 1M rows; default the worker count low and let it be raised per run.
    const workers = Number(process.env.OB1_STORE_BUILD_WORKERS ?? (kind === "diskann" ? 0 : 4));
    await this.sql.unsafe(`SET max_parallel_maintenance_workers = ${workers}`);
    // Bound the DiskANN build so it aborts and is recorded rather than hanging
    // the run for hours at 10M; 0 disables. Only DiskANN is bounded — HNSW and
    // IVFFlat build in a predictable time and must not be cut off.
    const timeoutMs = kind === "diskann" ? Number(process.env.OB1_STORE_BUILD_TIMEOUT_MS ?? 0) : 0;
    await this.sql.unsafe(`SET statement_timeout = ${timeoutMs}`);
    const t0 = nowMs();
    await this.sql.unsafe(this.ddl(kind));
    await this.sql.unsafe("SET statement_timeout = 0");
    const buildMs = nowMs() - t0;
    const bytes = Number(
      (await this.sql.unsafe(`SELECT pg_relation_size('${this.indexName(kind)}') AS b`))[0].b,
    );
    return new PgStore(this.sql, kind, { loadMs: this.loadMs, buildMs, indexBytes: bytes });
  }

  async dropIndex(kind: PgIndexKind): Promise<void> {
    await this.sql.unsafe(`DROP INDEX IF EXISTS ${this.indexName(kind)}`);
  }

  async tableBytes(): Promise<number> {
    return Number((await this.sql.unsafe("SELECT pg_total_relation_size('points') AS b"))[0].b);
  }

  /** Escape hatch for the hybrid arm, which needs content-side SQL on this same
   *  Postgres (a keyword index over thought text) beside the vector points. */
  async raw(text: string): Promise<any[]> {
    return this.sql.unsafe(text);
  }

  /** Exact top-`n` refs by cosine, index kept out of the plan — the ground truth. */
  async exact(vec: number[], n: number, filter: Filter): Promise<string[]> {
    const lit = `[${vec.join(",")}]`;
    const where = filter ? `WHERE ${filter.key} @> '${JSON.stringify([filter.value])}'::jsonb` : "";
    const rows = await this.sql.begin(async (tx: SQL) => {
      await tx.unsafe("SET LOCAL enable_seqscan = on");
      await tx.unsafe("SET LOCAL enable_indexscan = off");
      await tx.unsafe("SET LOCAL enable_bitmapscan = off");
      return tx.unsafe(
        `SELECT ref FROM points ${where} ORDER BY embedding <=> '${lit}'::vector LIMIT ${n}`,
      );
    });
    return rows.map((r: { ref: string }) => String(r.ref));
  }

  async stop(): Promise<void> {
    try {
      await this.sql?.close();
    } catch {}
    await docker(["rm", "-f", this.name], { allowFail: true });
  }
}

/** A queryable pg index. Only one vector index exists at a time, and the engine's
 *  forced plan (seq/bitmap scans off) makes it the scan `search` runs. */
export class PgStore implements Store {
  readonly kind = "pg" as const;
  constructor(
    private readonly sql: SQL,
    private readonly indexKind: PgIndexKind,
    readonly stat: BuildStat,
  ) {}
  get name(): string {
    return `pgvector-${this.indexKind}`;
  }
  /**
   * Raise the engine's search-effort knob (ceiling vs floor, section A of the
   * bench). HNSW (`ef_search`) and IVFFlat (`probes`) respond sharply. DiskANN
   * takes both of pgvectorscale's query GUCs: `query_rescore` is the lever that
   * moves its recall on real embeddings (setting only `query_search_list_size`
   * left it flat), while on the random-vector scale floor even that barely helps.
   */
  async setEffort(ef: number): Promise<void> {
    if (this.indexKind === "hnsw") await this.sql.unsafe(`SET hnsw.ef_search = ${ef}`);
    else if (this.indexKind === "ivfflat") await this.sql.unsafe(`SET ivfflat.probes = ${ef}`);
    else {
      await this.sql.unsafe(`SET diskann.query_search_list_size = ${ef}`);
      await this.sql.unsafe(`SET diskann.query_rescore = ${ef}`);
    }
  }
  async search(vec: number[], n: number, filter: Filter): Promise<string[]> {
    const lit = `[${vec.join(",")}]`;
    const where = filter ? `WHERE ${filter.key} @> '${JSON.stringify([filter.value])}'::jsonb` : "";
    const rows = await this.sql.unsafe(
      `SELECT ref FROM points ${where} ORDER BY embedding <=> '${lit}'::vector LIMIT ${n}`,
    );
    return rows.map((r: { ref: string }) => String(r.ref));
  }
}

// ── Qdrant engine (external) ─────────────────────────────────────────────────

const QDRANT_IMAGE = process.env.OB1_STORE_QDRANT_IMAGE ?? "qdrant/qdrant:latest";

export class QdrantEngine implements Store {
  readonly kind = "external" as const;
  readonly name = "qdrant";
  stat: BuildStat = { loadMs: 0, buildMs: 0, indexBytes: 0 };
  private base = "";
  private containerName: string;
  private readonly collection = "points";
  constructor(private readonly dim: number, private readonly tag = String(process.pid)) {
    this.containerName = `ob1-store-qdrant-${this.tag}`;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`qdrant ${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async start(): Promise<void> {
    await docker(["rm", "-f", this.containerName], { allowFail: true });
    await docker([
      "run", "-d", "--name", this.containerName,
      "-p", "127.0.0.1::6333", QDRANT_IMAGE,
    ]);
    const port = await publishedPort(this.containerName, 6333);
    this.base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`${this.base}/readyz`);
        if (res.ok) break;
      } catch {}
      await Bun.sleep(500);
    }
    // Cosine so scores match the JS oracle. on_disk keeps the vectors mmap'd so
    // a 10M collection can be searched beside Postgres in the 14 GB test VM
    // rather than being swapped (a 60 s search timeout) — set by env at scale.
    const onDisk = process.env.OB1_STORE_QDRANT_ONDISK === "1";
    await this.api("PUT", `/collections/${this.collection}`, {
      vectors: { size: this.dim, distance: "Cosine", on_disk: onDisk },
    });
    await this.api("PUT", `/collections/${this.collection}/index`, { field_name: "labels", field_schema: "keyword" });
    await this.api("PUT", `/collections/${this.collection}/index`, { field_name: "tiers", field_schema: "keyword" });
  }

  async load(points: Iterable<Point>, batchSize = Number(process.env.OB1_STORE_QDRANT_BATCH ?? 2000)): Promise<number> {
    const t0 = nowMs();
    let batch: { id: number; vector: number[]; payload: { ref: string; labels: string[]; tiers: string[] } }[] = [];
    let id = 0;
    // wait=false during the bulk load (async ingest); the green-status wait below
    // is the single barrier that the whole collection is indexed. Per-batch
    // wait=true would serialise a synchronous round trip on every batch.
    const flush = async () => {
      if (!batch.length) return;
      await this.api("PUT", `/collections/${this.collection}/points?wait=false`, { points: batch });
      batch = [];
    };
    for (const p of points) {
      id++;
      batch.push({ id, vector: p.embedding, payload: { ref: p.ref, labels: p.labels, tiers: p.tiers } });
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    // wait=false ingest is async: the load is done when every point has landed.
    for (let i = 0; i < 7200; i++) {
      const info = await this.api("GET", `/collections/${this.collection}`);
      if (Number(info.result.points_count ?? 0) >= id) break;
      await Bun.sleep(500);
    }
    this.stat.loadMs = nowMs() - t0;
    // Build time: force optimizers to index the whole collection, then wait green.
    // If the wait exhausts without green (seen at 10M on-disk in a small VM), the
    // build time is only a floor and any recall measured next is brute-forced over
    // the unindexed majority — exact, so inflated. Record that so a future run's
    // Qdrant row is self-flagging rather than silently trusted.
    const tb = nowMs();
    await this.api("PATCH", `/collections/${this.collection}`, { optimizers_config: { indexing_threshold: 1 } });
    let reachedGreen = false;
    for (let i = 0; i < 3600; i++) {
      const info = await this.api("GET", `/collections/${this.collection}`);
      if (info.result.status === "green" && Number(info.result.indexed_vectors_count ?? 0) > 0) { reachedGreen = true; break; }
      await Bun.sleep(500);
    }
    this.stat.buildMs = nowMs() - tb;
    if (!reachedGreen) {
      this.stat.note = "indexing did not reach green — build time is a floor and recall is brute-force-inflated";
      console.warn(`  ⚠ qdrant: ${this.stat.note}`);
    }
    // Footprint: Qdrant's on-disk storage for this collection.
    try {
      const du = await docker(["exec", this.containerName, "du", "-sb", "/qdrant/storage/collections/" + this.collection]);
      this.stat.indexBytes = Number(du.split(/\s+/)[0]) || 0;
    } catch {}
    return this.stat.loadMs;
  }

  async search(vec: number[], n: number, filter: Filter): Promise<string[]> {
    const body: Record<string, unknown> = { vector: vec, limit: n, with_payload: true };
    if (filter) body.filter = { must: [{ key: filter.key, match: { value: filter.value } }] };
    const res = await this.api("POST", `/collections/${this.collection}/points/search`, body);
    return res.result.map((r: { payload: { ref: string } }) => String(r.payload.ref));
  }

  async stop(): Promise<void> {
    await docker(["rm", "-f", this.containerName], { allowFail: true });
  }
}

// ── point → ref dedup (match_thoughts' MAX rule, applied to any store's output) ─

/** Collapse ranked point refs to the first `k` distinct refs, best rank kept. */
export function dedupTopK(refsRanked: string[], k: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refsRanked) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
    if (out.length >= k) break;
  }
  return out;
}

/** recall@k of a candidate ref list against the exact ref set (both already deduped). */
export function recallAt(got: string[], exact: string[], k: number): number {
  if (!exact.length) return NaN;
  const want = new Set(exact.slice(0, k));
  const hit = got.slice(0, k).filter((r) => want.has(r)).length;
  return hit / Math.min(k, want.size);
}
