#!/usr/bin/env bun
/**
 * eval-quant.ts — quantised vector indexes for `match_thoughts`, measured on
 * real vectors at the shipped width (SMD-1501).
 *
 * At 1024 dimensions a ten-million-row brain's two HNSW indexes are some
 * twenty gigabytes to build, hold and walk. pgvector 0.7+ indexes `halfvec`
 * (half the bytes) and binary-quantised vectors (a thirty-second), and the
 * published results are build times and footprints cut by large factors with
 * a rerank of the candidates on the full vectors restoring recall. Nothing in
 * this fork had measured either, and the random 64-dimensional bench cannot
 * answer a recall question. This harness does, on the real vectors this
 * machine has at the shipped width: a LongMemEval corpus loaded by
 * eval-longmemeval.ts, whose whole vectors and windows are exactly what
 * `match_thoughts`' two candidate CTEs scan.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *
 * The UNFILTERED path. LongMemEval's own per-question filter matches a few
 * hundred thoughts, which routes every question to the function's exact branch
 * — the harness as run never touches the HNSW index — so the index's recall is
 * measured where the index is used: the default path over the whole corpus,
 * `match_count` 10, no filter. Three arms, each the function's unfiltered
 * statement (014/020/037's two CTEs at `v_fetch`, the MAX merge, the order by
 * score then id) with only the candidate ORDER BY changed:
 *
 *   vector    the index 001 and 007 ship — `hnsw (embedding vector_cosine_ops)`
 *   halfvec   `hnsw ((embedding::halfvec(D)) halfvec_cosine_ops)`, the query
 *             cast to match; the candidates' similarity is recomputed on the
 *             full vector (the heap row is read anyway, so this costs nothing
 *             and keeps the merge on one scale)
 *   binary    `hnsw ((binary_quantize(embedding)::bit(D)) bit_hamming_ops)`;
 *             each CTE takes `v_fetch × R` candidates by Hamming distance and
 *             reranks them by full-vector cosine to `v_fetch` — the rerank sits
 *             between the CTE and the merge, on both sides, where a migration
 *             would have to put it. R sweeps 1, 2, 4 and 10 (400 candidates at
 *             the default count is the ticket's `v_fetch × k`).
 *
 * Every arm runs under the function's own SET clauses (read from the catalog:
 * `hnsw.iterative_scan = relaxed_order`, `enable_seqscan = off`) at
 * `hnsw.ef_search` 40 (pgvector's default, which the function leaves alone),
 * 100 and 400. Each arm's indexes are built alone — timed under one
 * `maintenance_work_mem` and worker count on both tables, sized, and dropped
 * before the next arm's — and the arm the deployed function walks (read from
 * its body: halfvec since 039, vector before) goes last, under the shipped
 * names, so the database ends in the tree's shape. Scored against an exact
 * pass made before any vector index existed: the same statement with nothing
 * for the planner to walk — exact in the function's own shape, the true
 * nearest v_fetch per side merged by MAX, which is what a perfect index would
 * return; the report also says on how many questions that differs from the
 * ten highest MAX scores over every row, which the two-CTE shape does not
 * compute.
 *
 *   recall@10      overlap of the arm's ten ids with the exact ten, mean over
 *                  the questions
 *   gold-hit@10    how often one of the question's gold sessions is among the
 *                  ten, with the whole corpus as the haystack (the exact row is
 *                  the ceiling; a session whose text twins another's shares its
 *                  row, so the ceiling is under 100% by construction)
 *   ms             the call's round trip from this process, median and p95,
 *                  after one untimed pass over the questions
 *
 * CONTROL: that arm's mirrored statement must return exactly what
 * `match_thoughts` returns at the default `ef_search`, question for question;
 * the run fails otherwise, because every other arm's number rests on the
 * mirror being the function. The function's own latency is printed beside it.
 *
 * ── The corpus ───────────────────────────────────────────────────────────────
 * Copied, rows only, from a database eval-longmemeval.ts loaded (whole vectors
 * in `thoughts`, windows in `thought_chunks`) into the throwaway database this
 * script is pointed at, under the tree's schema at the source's width and
 * model; the source is opened read-only and nothing is written to it. Under
 * OB1_PG_KEEP the copy survives the run and a later run whose source counts
 * match reuses it, taking the migrations the tree gained since through
 * migrate.ts — which also refuses the copy when a recorded migration's file
 * has changed since (a branch under review): remove the volume and copy
 * again, a minute. The gold sessions come from the LongMemEval file the load
 * used (the slim M file suffices: only the question fields are read).
 *
 *   OB1_EVAL_QUANT_SOURCE=postgres://postgres:ob1test@127.0.0.1:55440/ob1lme4b \
 *   OB1_EVAL_LME=/path/longmemeval_s.json OB1_EVAL_EMBED=qwen3-embedding:4b@1024 \
 *   OB1_PG_KEEP=quant-s OB1_PG_SHM_SIZE=3g ../db/with-postgres.sh bun eval-quant.ts
 *
 *   OB1_EVAL_QUANT_EF=40,100,400        hnsw.ef_search values, every arm
 *   OB1_EVAL_QUANT_RERANK=1,2,4,10      binary arm's candidate multiples of v_fetch
 *   OB1_EVAL_QUANT_MEM=2GB              maintenance_work_mem for every build (fits /dev/shm: OB1_PG_SHM_SIZE)
 *   OB1_EVAL_QUANT_WORKERS=4            max_parallel_maintenance_workers for every build
 *   OB1_EVAL_MAX_QUESTIONS=50           a smoke run
 *   --plans                             EXPLAIN (ANALYZE, BUFFERS) each arm's statement once
 */

import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { EVAL_BASE, EVAL_HEADERS, applyPrompt, parseSpec } from "./lib.ts";
import { applyFunctionSettings, assertThrowawayDatabase, matchThoughtsOid, migratorEnv, requireDatabaseUrl, routingAt, runMigrator } from "../db/test-support.ts";

loadEnv();

const URL_ = requireDatabaseUrl("eval-quant.ts");
assertThrowawayDatabase(URL_);
const SOURCE = process.env.OB1_EVAL_QUANT_SOURCE;
if (!SOURCE) { console.error("OB1_EVAL_QUANT_SOURCE must name the database eval-longmemeval.ts loaded (read only here)."); process.exit(2); }
{
  // The source is read and the target rebuilt; pointed at one database the
  // "kept" path would drop the source's indexes and build every arm on it.
  const a = new URL(SOURCE), b = new URL(URL_);
  // Loopback under any of its names is one host (the set assertThrowawayDatabase admits).
  const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
  const host = (u: URL) => (LOOPBACK.has(u.hostname) ? "loopback" : u.hostname);
  if (host(a) === host(b) && (a.port || "5432") === (b.port || "5432") && a.pathname === b.pathname) {
    console.error(`eval-quant.ts: OB1_EVAL_QUANT_SOURCE is the database this run would measure in (${a.hostname}:${a.port || "5432"}${a.pathname}). Point DATABASE_URL at a throwaway database; nothing was touched.`);
    process.exit(2);
  }
}
const DATA = process.env.OB1_EVAL_LME;
if (!DATA || !existsSync(DATA)) { console.error("OB1_EVAL_LME must name the LongMemEval file the source was loaded from (the slim M file will do)."); process.exit(2); }
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const PRINT_PLANS = process.argv.includes("--plans");
const KEPT = Boolean(process.env.OB1_PG_KEEP);
const MAXQ = Number(process.env.OB1_EVAL_MAX_QUESTIONS ?? 0);
const MEM = process.env.OB1_EVAL_QUANT_MEM ?? "2GB";
const WORKERS = Number(process.env.OB1_EVAL_QUANT_WORKERS ?? 4);
const list = (name: string, fallback: string): number[] => {
  const xs = (process.env[name] ?? fallback).split(",").map((s) => Number(s.trim()));
  if (!xs.length || xs.some((x) => !Number.isInteger(x) || x <= 0)) { console.error(`${name} must be positive integers (got ${JSON.stringify(process.env[name])})`); process.exit(2); }
  return [...new Set(xs)];
};
const EFS = list("OB1_EVAL_QUANT_EF", "40,100,400");
const RERANKS = list("OB1_EVAL_QUANT_RERANK", "1,2,4,10");
const K = 10;
const BATCH = 200;

type Question = { question_id: string; question_type: string; question: string; answer_session_ids: string[] };
type Arm = "halfvec" | "binary" | "vector";
const ALL_ARMS: Arm[] = ["halfvec", "binary", "vector"];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
const toVector = (v: number[]) => `[${v.join(",")}]`;

// ── The corpus ───────────────────────────────────────────────────────────────

const src = new SQL({ url: SOURCE, max: 1 });
await src.unsafe(`SET default_transaction_read_only = on`);
const [source] = (await src.unsafe(`
  SELECT (SELECT count(*)::int FROM thoughts) AS thoughts,
         (SELECT count(*)::int FROM thoughts WHERE embedding IS NULL) AS unembedded,
         (SELECT count(*)::int FROM thought_chunks) AS chunks,
         (SELECT max(vector_dims(embedding)) FROM thoughts) AS dim,
         (SELECT array_agg(DISTINCT embedding_model) FROM thoughts) AS models`)) as { thoughts: number; unembedded: number; chunks: number; dim: number; models: string[] | null }[];
const DIM = Number(source.dim);
if (!source.thoughts || !DIM) { console.error(`eval-quant.ts: the source holds no embedded thoughts.`); process.exit(2); }
if (source.unembedded) { console.error(`eval-quant.ts: ${source.unembedded} source thoughts have no vector; the copy would not be the corpus the load made.`); process.exit(2); }
if (!source.models || source.models.length !== 1 || source.models[0] !== spec.name || (spec.dims ?? DIM) !== DIM) {
  console.error(`eval-quant.ts: the source's rows are ${source.models?.join(", ") ?? "unlabelled"} at ${DIM} dims; OB1_EVAL_EMBED says ${EMBED_MODEL}. The questions must be embedded by the model that embedded the rows.`);
  process.exit(2);
}

let sql = new SQL({ url: URL_, max: 1 });
const rel = async (name: string) => Boolean((await sql.unsafe(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]))[0].ok);
const counts = async (): Promise<{ thoughts: number; chunks: number }> => {
  if (!(await rel("thoughts")) || !(await rel("thought_chunks"))) return { thoughts: 0, chunks: 0 };
  const [r] = await sql.unsafe(`SELECT (SELECT count(*)::int FROM thoughts) AS thoughts, (SELECT count(*)::int FROM thought_chunks) AS chunks`);
  return { thoughts: Number(r.thoughts), chunks: Number(r.chunks) };
};

/** Every index on the two tables that a constraint does not own, with its definition — dropped for the load, rebuilt after it (the HNSW ones are the arms'). */
async function secondaryIndexes(): Promise<{ name: string; def: string; hnsw: boolean }[]> {
  return (await sql.unsafe(`
    SELECT i.indexrelid::regclass::text AS name, pg_get_indexdef(i.indexrelid) AS def, am.amname = 'hnsw' AS hnsw
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid IN ('thoughts'::regclass, 'thought_chunks'::regclass)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
    ORDER BY 1`)) as { name: string; def: string; hnsw: boolean }[];
}

type CopyStats = { source: "copied" | "kept"; seconds: number; otherIndexesS: number };

/** 039's staging indexes, built under this run's memory and workers where the shipped name does not already hold a halfvec index. */
async function stageHalfvec(): Promise<void> {
  await sql.unsafe(`SET maintenance_work_mem = '${MEM}'`);
  await sql.unsafe(`SET max_parallel_maintenance_workers = ${WORKERS}`);
  for (const table of ["thoughts", "thought_chunks"]) {
    const [r] = await sql.unsafe(`SELECT pg_get_indexdef(to_regclass($1)) AS shipped, to_regclass($2) IS NOT NULL AS staged`, [`${table}_embedding_idx`, `${table}_embedding_halfvec_idx`]);
    if (r.staged || /halfvec_cosine_ops/.test(String(r.shipped ?? ""))) continue;
    await sql.unsafe(`CREATE INDEX ${table}_embedding_halfvec_idx ON ${table} USING hnsw ((embedding::halfvec(${DIM})) halfvec_cosine_ops)`);
  }
  await sql.unsafe(`RESET maintenance_work_mem`);
  await sql.unsafe(`RESET max_parallel_maintenance_workers`);
}

/**
 * The tree's schema onto the database through migrate.ts — the ledger a
 * deployment has, so a kept copy from an earlier run takes the migrations the
 * tree gained since (a bare apply would re-run every file). The trigram index
 * (011) is off: it indexes content, sits on no path measured here, and would
 * take minutes to build over this much text.
 */
async function migrate(): Promise<void> {
  const run = await runMigrator(URL_, migratorEnv(URL_, { dim: DIM, model: spec.name, trgm: false }));
  if (run.code !== 0) {
    console.error(run.out.trimEnd());
    console.error(`\neval-quant.ts: migrate.ts exited ${run.code} (above); nothing was measured.`);
    process.exit(1);
  }
}

async function copyCorpus(): Promise<CopyStats> {
  const have = await counts();
  if (have.thoughts === source.thoughts && have.chunks === source.chunks) {
    const [m] = await sql.unsafe(`SELECT array_agg(DISTINCT embedding_model) AS models, max(vector_dims(embedding)) AS dim FROM thoughts`);
    if ((m.models as string[])?.length === 1 && m.models[0] === spec.name && Number(m.dim) === DIM) {
      // A copy kept under an earlier tree meets 039 here, whose swap would
      // build both halfvec indexes inside migrate.ts under the server's
      // default maintenance_work_mem. Stage them first under this run's
      // settings — the header's own by-hand path — so the migration adopts
      // them; a tree without 039 leaves the staging indexes to dropHnsw().
      await stageHalfvec();
      await migrate();
      return { source: "kept", seconds: 0, otherIndexesS: 0 };
    }
  }
  if (have.thoughts || have.chunks) {
    console.error(`eval-quant.ts: the database already holds ${have.thoughts.toLocaleString()} thoughts and ${have.chunks.toLocaleString()} chunks, not this source's ${source.thoughts.toLocaleString()} / ${source.chunks.toLocaleString()}. ${KEPT ? "One corpus per OB1_PG_KEEP name: use another name, or remove the kept volume." : "Point it at an empty database."} Nothing was touched.`);
    process.exit(2);
  }
  process.stdout.write(`▸ schema at ${DIM} dims for ${spec.name} … `);
  await migrate();
  console.log("applied");

  // Every secondary index off for the load; the HNSW ones are the arms' to
  // build, the rest are rebuilt below.
  const secondary = await secondaryIndexes();
  for (const s of secondary) await sql.unsafe(`DROP INDEX ${s.name}`);
  for (const t of ["thoughts", "thought_chunks"]) await sql.unsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);

  const t0 = performance.now();
  process.stdout.write(`▸ copying ${source.thoughts.toLocaleString()} thoughts `);
  let last = "00000000-0000-0000-0000-000000000000";
  let done = 0;
  for (;;) {
    const rows = (await src.unsafe(
      `SELECT id, content, content_fingerprint, metadata, embedding::text AS embedding, created_at, updated_at, embedding_model
       FROM thoughts WHERE id > $1 ORDER BY id LIMIT ${BATCH}`, [last])) as Record<string, unknown>[];
    if (!rows.length) break;
    const params: unknown[] = [];
    const values = rows.map((r) => {
      const at = params.length;
      params.push(r.id, r.content, r.content_fingerprint, r.metadata, r.embedding, r.created_at, r.updated_at, r.embedding_model);
      return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}::jsonb, $${at + 5}::vector, $${at + 6}, $${at + 7}, $${at + 8})`;
    });
    await sql.unsafe(`INSERT INTO thoughts (id, content, content_fingerprint, metadata, embedding, created_at, updated_at, embedding_model) VALUES ${values.join(",")}`, params);
    last = rows[rows.length - 1].id as string;
    done += rows.length;
    if (done % 10_000 < BATCH) process.stdout.write(".");
  }
  process.stdout.write(` ${done.toLocaleString()}\n▸ copying ${source.chunks.toLocaleString()} chunks `);
  let lastId = "00000000-0000-0000-0000-000000000000";
  let lastIx = -1;
  done = 0;
  for (;;) {
    const rows = (await src.unsafe(
      `SELECT thought_id, chunk_index, content, context, embedding::text AS embedding
       FROM thought_chunks WHERE (thought_id, chunk_index) > ($1, $2::int) ORDER BY thought_id, chunk_index LIMIT ${BATCH}`, [lastId, lastIx])) as Record<string, unknown>[];
    if (!rows.length) break;
    const params: unknown[] = [];
    const values = rows.map((r) => {
      const at = params.length;
      params.push(r.thought_id, r.chunk_index, r.content, r.context, r.embedding);
      return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}::vector)`;
    });
    await sql.unsafe(`INSERT INTO thought_chunks (thought_id, chunk_index, content, context, embedding) VALUES ${values.join(",")}`, params);
    lastId = rows[rows.length - 1].thought_id as string;
    lastIx = rows[rows.length - 1].chunk_index as number;
    done += rows.length;
    if (done % 10_000 < BATCH) process.stdout.write(".");
  }
  const seconds = (performance.now() - t0) / 1000;
  console.log(` ${done.toLocaleString()}`);
  for (const t of ["thoughts", "thought_chunks"]) await sql.unsafe(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  process.stdout.write(`▸ rebuilding the other indexes … `);
  const t1 = performance.now();
  for (const s of secondary) if (!s.hnsw) await sql.unsafe(s.def);
  const otherIndexesS = (performance.now() - t1) / 1000;
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
  console.log(`${otherIndexesS.toFixed(0)} s`);
  const after = await counts();
  if (after.thoughts !== source.thoughts || after.chunks !== source.chunks) throw new Error(`copied ${after.thoughts}/${after.chunks} rows, source has ${source.thoughts}/${source.chunks}`);
  return { source: "copied", seconds, otherIndexesS };
}

// ── The questions ────────────────────────────────────────────────────────────

const all = (JSON.parse(readFileSync(DATA, "utf8")) as Question[]).filter((q) => !q.question_id.endsWith("_abs"));
const questions = MAXQ ? all.slice(0, MAXQ) : all;

/** Batched embeddings under the server's own query prompt, as eval-longmemeval.ts embeds its questions. */
async function embedQuestions(texts: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const slice = texts.slice(i, i + 32).map((t) => applyPrompt(spec, t, true));
    const r = await fetch(`${EVAL_BASE}/embeddings`, {
      method: "POST",
      headers: EVAL_HEADERS,
      body: JSON.stringify({ model: spec.name, input: slice, ...(spec.dims ? { dimensions: spec.dims } : {}) }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    for (const d of [...data.data].sort((a, b) => a.index - b.index)) {
      if (d.embedding.length !== DIM) throw new Error(`provider returned ${d.embedding.length}-wide vectors for a vector(${DIM}) column`);
      out.push(toVector(d.embedding));
    }
  }
  return out;
}

// ── The statements ───────────────────────────────────────────────────────────

/**
 * The function's unfiltered statement (migration 037's, threshold −1 so no row
 * is cut, weight 0 so the score is the similarity), with the candidate ORDER
 * BY of the arm. `$1` is the query vector's literal. Written once here and
 * held to the function by the CONTROL below.
 */
function statement(arm: Arm, vFetch: number, depth: number): string {
  const sim = (col: string) => `1 - (${col} <=> $1::vector)`;
  const candidates = (table: string, idCol: string, alias: string): string => {
    switch (arm) {
      case "vector":
        return `SELECT ${alias}.${idCol} AS tid, ${sim(`${alias}.embedding`)} AS sim FROM ${table} ${alias}
          ${table === "thoughts" ? `WHERE ${alias}.embedding IS NOT NULL` : ""}
          ORDER BY ${alias}.embedding <=> $1::vector LIMIT ${vFetch}`;
      case "halfvec":
        return `SELECT ${alias}.${idCol} AS tid, ${sim(`${alias}.embedding`)} AS sim FROM ${table} ${alias}
          ${table === "thoughts" ? `WHERE ${alias}.embedding IS NOT NULL` : ""}
          ORDER BY ${alias}.embedding::halfvec(${DIM}) <=> $1::vector::halfvec(${DIM}) LIMIT ${vFetch}`;
      case "binary":
        return `SELECT c.tid, ${sim("c.embedding")} AS sim FROM (
            SELECT ${alias}.${idCol} AS tid, ${alias}.embedding FROM ${table} ${alias}
            ${table === "thoughts" ? `WHERE ${alias}.embedding IS NOT NULL` : ""}
            ORDER BY binary_quantize(${alias}.embedding)::bit(${DIM}) <~> binary_quantize($1::vector)::bit(${DIM}) LIMIT ${depth}
          ) c ORDER BY c.embedding <=> $1::vector LIMIT ${vFetch}`;
    }
  };
  return `
    WITH direct AS (${candidates("thoughts", "id", "t")}),
    chunked AS (${candidates("thought_chunks", "thought_id", "k")}),
    best AS (SELECT u.tid, MAX(u.sim) AS sim FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u GROUP BY u.tid)
    SELECT t.id FROM best b JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > -1.0
    ORDER BY b.sim DESC, t.id
    LIMIT ${K}`;
}

/** Each arm's index on a table, under the name given: the shipped name for the arm the function walks, so the database ends in the tree's shape; an arm's own name otherwise. */
const INDEX_DEFS: Record<Arm, (table: string, name: string) => string> = {
  vector: (table, name) => `CREATE INDEX ${name} ON ${table} USING hnsw (embedding vector_cosine_ops)`,
  halfvec: (table, name) => `CREATE INDEX ${name} ON ${table} USING hnsw ((embedding::halfvec(${DIM})) halfvec_cosine_ops)`,
  binary: (table, name) => `CREATE INDEX ${name} ON ${table} USING hnsw ((binary_quantize(embedding)::bit(${DIM})) bit_hamming_ops)`,
};

type Build = { arm: Arm; table: string; seconds: number; bytes: number };
async function buildArm(arm: Arm, functionArm: Arm): Promise<Build[]> {
  const present = await secondaryIndexes();
  if (present.some((s) => s.hnsw)) throw new Error(`an HNSW index is present before the ${arm} build: ${present.filter((s) => s.hnsw).map((s) => s.name).join(", ")}`);
  await sql.unsafe(`SET maintenance_work_mem = '${MEM}'`);
  await sql.unsafe(`SET max_parallel_maintenance_workers = ${WORKERS}`);
  const out: Build[] = [];
  for (const table of ["thoughts", "thought_chunks"]) {
    const name = arm === functionArm ? `${table}_embedding_idx` : `${table}_embedding_${arm}_idx`;
    const t0 = performance.now();
    await sql.unsafe(INDEX_DEFS[arm](table, name));
    const seconds = (performance.now() - t0) / 1000;
    const bytes = Number((await sql.unsafe(`SELECT pg_relation_size($1::regclass)::bigint AS b`, [name]))[0].b);
    out.push({ arm, table, seconds, bytes });
  }
  await sql.unsafe(`RESET maintenance_work_mem`);
  await sql.unsafe(`RESET max_parallel_maintenance_workers`);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
  return out;
}
async function dropHnsw(): Promise<void> {
  for (const s of await secondaryIndexes()) if (s.hnsw) await sql.unsafe(`DROP INDEX ${s.name}`);
}

// ── The run ──────────────────────────────────────────────────────────────────

console.log(`eval-quant.ts — ${spec.name} at ${DIM} dims; ${source.thoughts.toLocaleString()} thoughts + ${source.chunks.toLocaleString()} chunks = ${(source.thoughts + source.chunks).toLocaleString()} vectors; ${questions.length} questions; ef_search ${EFS.join("/")}; binary rerank ×${RERANKS.join("/")}; builds under ${MEM}, ${WORKERS} workers`);
const copy = await copyCorpus();
// After the schema: migration 001 creates the extension.
const [{ pgvector }] = await sql.unsafe(`SELECT extversion AS pgvector FROM pg_extension WHERE extname = 'vector'`);
console.log(copy.source === "kept" ? `▸ corpus kept from an earlier run (counts match the source)` : `▸ copied in ${copy.seconds.toFixed(0)} s`);
await dropHnsw(); // a kept copy ends each run in the shipped shape; every arm starts from none

// The arm the deployed function walks, read from its body: since 039 the two
// walk branches order by the halfvec cast; before it, by the vector. That arm
// is measured last, under the shipped index names, and is the CONTROL's.
const FUNCTION_ARM: Arm = /::halfvec\(/.test(String((await sql.unsafe(`SELECT prosrc FROM pg_proc WHERE oid = $1::oid`, [await matchThoughtsOid(sql)]))[0].prosrc)) ? "halfvec" : "vector";
const ARMS: Arm[] = [...ALL_ARMS.filter((a) => a !== FUNCTION_ARM), FUNCTION_ARM];
console.log(`▸ match_thoughts walks the ${FUNCTION_ARM} index: it is the control's arm and goes last`);

const { vFetch } = await routingAt(sql, K);
process.stdout.write(`▸ embedding ${questions.length} questions … `);
const qvs = await embedQuestions(questions.map((q) => q.question));
console.log("done");

// Gold sessions → the rows that hold them. A row's metadata names the one
// session it was written for; a twin session (identical text, 003's
// fingerprint) shares that row and is not named, so its gold is unreachable
// under every arm alike — the exact row below is the ceiling.
const rowSid = new Map<string, string>();
for (const r of (await sql.unsafe(`SELECT id, metadata->>'lme_sid' AS sid FROM thoughts WHERE metadata ? 'lme_sid'`)) as { id: string; sid: string }[]) rowSid.set(r.id, r.sid);
const goldHit = (i: number, ids: string[]): boolean => {
  const gold = new Set(questions[i].answer_session_ids);
  return ids.some((id) => gold.has(rowSid.get(id) ?? ""));
};

// The exact pass: the same statement with no vector index in existence — the
// planner has nothing to walk, so the top-N is over every row.
process.stdout.write(`▸ exact pass over ${questions.length} questions … `);
{
  const present = await secondaryIndexes();
  if (present.some((s) => s.hnsw)) throw new Error("an HNSW index exists during the exact pass");
}
// "Exact" is the function's own candidate shape under an exact scan: the true
// nearest v_fetch on each side, merged by MAX — what a perfect index would
// return, and the right reference for measuring the walk. It is not the ten
// highest MAX scores over every row, which the two-CTE shape does not
// compute: a thought whose best window ranks past v_fetch on the chunk side
// can be absent, or scored by a weaker direct row. The second statement below
// has no LIMIT inside the CTEs and computes that true top-10; the report says
// on how many questions the shape differs from it (review pass 2).
const exactStmt = statement("vector", vFetch, vFetch);
const trueStmt = exactStmt.split(`LIMIT ${vFetch}`).join("");
const exact: string[][] = [];
let shapeDiffers = 0;
{
  const pool = new SQL({ url: URL_, max: 4 });
  const t0 = performance.now();
  const results: string[][] = new Array(questions.length);
  const truth: string[][] = new Array(questions.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= questions.length) return;
      results[i] = ((await pool.unsafe(exactStmt, [qvs[i]])) as { id: string }[]).map((r) => r.id);
      truth[i] = ((await pool.unsafe(trueStmt, [qvs[i]])) as { id: string }[]).map((r) => r.id);
    }
  }));
  await pool.close();
  exact.push(...results);
  shapeDiffers = results.filter((ids, i) => ids.join() !== truth[i].join()).length;
  console.log(`${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
const exactGold = questions.filter((_, i) => goldHit(i, exact[i])).length;

type Row = { arm: Arm; ef: number; depth: number; recall: number; gold: number; returned: number; ms: number; p95: number };
const rows: Row[] = [];
/** Every arm's ten ids per question, keyed `arm|ef|depth`, so the report can say how many questions an arm answers exactly as the vector arm does at the same ef_search — the rows a migration would move. */
const lists = new Map<string, string[][]>();
const builds: Build[] = [];
const plans: string[] = [];
const control: { value: { mismatches: number; ms: number } | null } = { value: null };

async function measure(arm: Arm, ef: number, depth: number): Promise<Row> {
  const stmt = statement(arm, vFetch, depth);
  await sql.unsafe(`SET hnsw.ef_search = ${ef}`);
  for (const qv of qvs) await sql.unsafe(stmt, [qv]); // warm
  const times: number[] = [];
  let overlap = 0, gold = 0, returned = 0;
  const got: string[][] = [];
  for (const [i, qv] of qvs.entries()) {
    const t0 = performance.now();
    const ids = ((await sql.unsafe(stmt, [qv])) as { id: string }[]).map((r) => r.id);
    times.push(performance.now() - t0);
    got.push(ids);
    overlap += ids.filter((id) => exact[i].includes(id)).length;
    if (goldHit(i, ids)) gold++;
    returned += ids.length;
  }
  lists.set(`${arm}|${ef}|${depth}`, got);
  if (arm === FUNCTION_ARM && ef === 40) {
    // CONTROL: the function itself, same ids question for question.
    let mismatches = 0;
    const ftimes: number[] = [];
    for (const [i, qv] of qvs.entries()) {
      const t0 = performance.now();
      const ids = ((await sql.unsafe(`SELECT id FROM match_thoughts($1::vector, -1.0, ${K}, '{}'::jsonb)`, [qv])) as { id: string }[]).map((r) => r.id);
      ftimes.push(performance.now() - t0);
      if (ids.join() !== got[i].join()) mismatches++;
    }
    control.value = { mismatches, ms: median(ftimes) };
  }
  if (PRINT_PLANS && ef === 40) {
    const text = (await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, COSTS) ${stmt.replace(/\$1/g, `'${qvs[0]}'`)}`)).map((r: Record<string, string>) => Object.values(r)[0]).join("\n");
    plans.push(`── ${arm} ef_search ${ef}${arm === "binary" ? ` depth ${depth}` : ""} ──\n${text}`);
  }
  await sql.unsafe(`RESET hnsw.ef_search`);
  return { arm, ef, depth, recall: overlap / (questions.length * K), gold: gold / questions.length, returned: returned / questions.length, ms: median(times), p95: p95(times) };
}

// The function's SET clauses for the session: every arm's statement runs as
// the function's body would, and the arm the function walks is held to it by the control.
const applied = await applyFunctionSettings(sql, { scope: "session" });
for (const arm of ARMS) {
  process.stdout.write(`▸ ${arm}: building … `);
  const b = await buildArm(arm, FUNCTION_ARM);
  builds.push(...b);
  console.log(b.map((x) => `${x.table} ${x.seconds.toFixed(1)} s, ${mb(x.bytes)}`).join("; "));
  const depths = arm === "binary" ? RERANKS.map((r) => r * vFetch) : [vFetch];
  for (const depth of depths) {
    for (const ef of EFS) {
      process.stdout.write(`  ef_search ${ef}${arm === "binary" ? `, ${depth} candidates` : ""} … `);
      const r = await measure(arm, ef, depth);
      rows.push(r);
      console.log(`recall@${K} ${r.recall.toFixed(3)}, gold-hit ${(100 * r.gold).toFixed(1)}%, ${r.ms.toFixed(2)} ms median`);
    }
  }
  if (arm !== FUNCTION_ARM) await dropHnsw();
}
for (const name of applied) await sql.unsafe(`RESET ${name}`);
await src.close();

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n## eval-quant.ts — ${spec.name}@${DIM}, ${(source.thoughts + source.chunks).toLocaleString()} vectors (${source.thoughts.toLocaleString()} thoughts + ${source.chunks.toLocaleString()} chunks), ${questions.length} questions, pgvector ${pgvector}`);
console.log(`\ncorpus: ${copy.source === "kept" ? "kept copy" : `copied in ${copy.seconds.toFixed(0)} s (other indexes ${copy.otherIndexesS.toFixed(0)} s)`}; v_fetch ${vFetch} (match_count ${K}); builds under maintenance_work_mem ${MEM}, ${WORKERS} workers`);
if (!control.value) throw new Error("the control did not run");
const c = control.value;
console.log(`control: match_thoughts vs the mirrored ${FUNCTION_ARM} statement at ef_search 40 — ${c.mismatches} of ${questions.length} questions differ; the function's median ${c.ms.toFixed(2)} ms`);

console.log(`\n### Builds\n\n| arm | table | build s | size | of vector |\n| --- | --- | --- | --- | --- |`);
const vectorBytes = (table: string) => builds.find((b) => b.arm === "vector" && b.table === table)!.bytes;
for (const b of builds) console.log(`| ${b.arm} | ${b.table} | ${b.seconds.toFixed(1)} | ${mb(b.bytes)} | ${(100 * b.bytes / vectorBytes(b.table)).toFixed(0)}% |`);
const total = (arm: Arm) => builds.filter((b) => b.arm === arm).reduce((a, b) => ({ s: a.s + b.seconds, bytes: a.bytes + b.bytes }), { s: 0, bytes: 0 });
for (const arm of ARMS) { const t = total(arm); console.log(`| ${arm} | both | ${t.s.toFixed(1)} | ${mb(t.bytes)} | ${(100 * t.bytes / total("vector").bytes).toFixed(0)}% |`); }

const sameAsVector = (r: Row): string => {
  const mine = lists.get(`${r.arm}|${r.ef}|${r.depth}`)!;
  const vec = lists.get(`vector|${r.ef}|${vFetch}`)!;
  return `${(100 * mine.filter((ids, i) => ids.join() === vec[i].join()).length / questions.length).toFixed(1)}%`;
};
console.log(`\n### Recall and latency, unfiltered path, match_count ${K}\n\nexact pass: gold-hit@${K} ${(100 * exactGold / questions.length).toFixed(1)}% (the ceiling); the function's candidate shape (the true nearest ${vFetch} per side, merged by MAX) differs from the ten highest MAX scores over every row on ${shapeDiffers} of ${questions.length} questions\n\n| arm | candidates per CTE | ef_search | recall@${K} vs exact | gold-hit@${K} | same list as vector | rows | median ms | p95 ms |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const r of rows) console.log(`| ${r.arm} | ${r.depth === vFetch ? vFetch : `${r.depth} → ${vFetch}`} | ${r.ef} | ${r.recall.toFixed(3)} | ${(100 * r.gold).toFixed(1)}% | ${sameAsVector(r)} | ${r.returned.toFixed(1)} | ${r.ms.toFixed(2)} | ${r.p95.toFixed(2)} |`);

if (c.mismatches) {
  console.error(`\nCONTROL FAILED: match_thoughts and the mirrored ${FUNCTION_ARM} statement disagreed on ${c.mismatches} questions; the arms above were not measured on the function's shape.`);
  process.exit(1);
}
if (PRINT_PLANS) console.log(`\n### Plans (first question)\n\n${plans.join("\n\n")}`);
await sql.close();
