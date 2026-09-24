#!/usr/bin/env bun
/**
 * eval-projection-replay.ts — can the read model be rebuilt from the log
 * without re-embedding what has not changed? (Linear SMD-1998, Spike 1 of the
 * event-sourcing ADR SMD-1997; the number the ADR's go/no-go rests on.)
 *
 * Under CQRS-lite (SMD-1997) the thoughts row, the chunk rows, the entity
 * graph, the proposals and the capture-time metadata are projections folded
 * from thought_audit, and a projection can be thrown away and replayed. The
 * largest projection is the embedding index, and re-embedding the corpus is
 * the single most expensive operation in the system — so the ADR stands or
 * falls on one question: does a replay REUSE a stored vector whenever the
 * `(content_fingerprint, embedding_model)` key the schema already records
 * (003/023, 021) is unchanged, and recompute only what changed?
 *
 * This is a measurement, not a projector. It reads a live brain through
 * DATABASE_URL in ONE transaction — repeatable read, read only, on one
 * connection — so every count and every stored vector it compares come from
 * one snapshot and nothing can be written; then, unless --no-provider, embeds
 * a stratified sample of rows through the REAL embedder
 * (server-portable/embed.ts, the same windows, template and fallback a capture
 * takes) against the configured provider, to price a recompute in wall-clock
 * and to check that the cached value is what a fresh one would be (cosine,
 * fresh against stored, parents and window vectors both, over the rows the
 * replay would reuse, at the column's width). The provider is called only for
 * the sample.
 *
 * What the no-op scenario measures, said plainly: each row's payload is read
 * from the thoughts row itself — content_fingerprint_of(content) against the
 * row's content_fingerprint — so it is the row's key against its own text, a
 * self-consistency the replay rule rests on. A rebuild whose payload is the
 * LOG cannot be measured here: a capture row in thought_audit carries
 * metadata and not content (008), and the report counts how many live
 * thoughts the log holds text for. The edit and comprehension-only scenarios
 * are derived from the contract (the edit is simulated; the vector's key
 * carries no extraction key), not observed, and the verdict says so.
 *
 * The contract was pre-registered on the ticket before the first run and is
 * projection-replay.ts's PROJECTIONS and decideEmbedding; the scenarios are
 * the ticket's five (a no-op rebuild, N edits, a model bump, a comprehension-
 * only change, a window-recipe change); the bar is projection-replay.ts's
 * verdict. What the schema cannot say is said, not guessed: a head-window
 * fallback parent is not recorded on the row (034 records it on a re-embed
 * claim row), the chunk rows carry no recipe (022), the graph rows carry no
 * fingerprint (016).
 *
 *   DATABASE_URL=… bun eval-projection-replay.ts                 # the report over the live brain, the sample through the provider
 *   DATABASE_URL=… bun eval-projection-replay.ts --no-provider   # the counts only; no provider call
 *   DATABASE_URL=… bun eval-projection-replay.ts --sample 21 --edit 10 --json out.json
 *   bun eval-projection-replay.ts --self-check                   # the rules, probed with hand-known rows; no database, no provider (CI, portable-server)
 *   ../db/with-postgres.sh bun eval-projection-replay.ts --fixture-check   # DROPS the schema at DATABASE_URL and seeds one row per branch; refuses a database holding thoughts unless OB1_FIXTURE_RESET=1 (CI, data-layer)
 *
 * The provider is the server's own: OB1_LLM_BASE_URL, OB1_EMBEDDING_MODEL and
 * the rest resolved by resolveEmbedConfig, the egress gate included — a
 * provider not declared local (OB1_LLM_LOCAL=1) refuses the text, as it would
 * refuse a capture. The configured model and width must be the brain's
 * recorded ones, or the cosine would compare two models or two widths; the
 * run says so and stops.
 */

import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import { DEFAULT_EMBEDDING_MODEL } from "../db/config.mjs";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { chunkContent } from "../server-portable/chunk.ts";
import { createEmbedder, ProviderError, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { loadEnv } from "./env.ts";
import { cosine, median } from "./lib.ts";
import {
  BUMPED_MODEL, KEY_VERDICTS, MIN_REUSE, MIN_TRIM_ROWS, MISSES, PROJECTIONS, REPRO_COSINE, buildScenarios, bumpedName, comprehensionOnlyRebuild, costModel, decideEmbedding, describeMisses, editedRebuild, fmtChars, fmtGap, fmtSeconds, graphCost, isGraphPass, modelBumpRebuild, noOpRebuild, parsePool, poolState, recipeChangeRebuild, recomputed, renderReport, staleGraph, stratifiedSample, tally, trimNote, verdict,
  type Census, type ClaimStat, type CostModel, type Decision, type Observation, type Sample, type Scenarios, type ThoughtRow,
} from "./projection-replay.ts";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string): string | undefined => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

export const DEFAULT_SAMPLE = 21;
export const DEFAULT_EDITS = 10;

/** The argument rules, pure, so the self-check probes every shape (SMD-1713's lesson: a flag read once, a stray word admitted). */
export function argumentProblem(argv: readonly string[]): string | null {
  const known = new Set(["--self-check", "--fixture-check", "--no-provider", "--sample", "--edit", "--json"]);
  const valued = new Set(["--sample", "--edit", "--json"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) return `unknown argument ${a}`;
    if (valued.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      if (a !== "--json" && !(/^\d+$/.test(v) && Number(v) > 0)) return `${a} takes a positive integer, not "${v}"`;
      i++;
    }
  }
  const counts = new Map<string, number>();
  for (const a of argv) if (known.has(a)) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const [a, n] of counts) if (n > 1) return `${a} given ${n} times; a flag given twice would be read once`;
  for (const alone of ["--self-check", "--fixture-check"]) if (argv.includes(alone) && argv.length > 1) return `${alone} takes no other argument`;
  return null;
}

// ── The live brain ───────────────────────────────────────────────────────────

type RawRow = {
  id: string; content: string; chars: number; stored_fp: string | null; payload_fp: string; model: string | null; has_vector: boolean;
  chunk_rows: number; mentions: number; content_moved_after_extraction: boolean; pool: string | null; recorded_finished_before_move: boolean | null;
};

export function toRow(r: RawRow, recordedKey: string | undefined): ThoughtRow & { content: string } {
  return {
    id: r.id, content: r.content, chars: Number(r.chars), storedFingerprint: r.stored_fp, payloadFingerprint: r.payload_fp, model: r.model, hasVector: r.has_vector,
    chunkRows: Number(r.chunk_rows), mentions: Number(r.mentions),
    contentMovedAfterExtraction: r.content_moved_after_extraction,
    pool: poolState(parsePool(r.pool), recordedKey, r.recorded_finished_before_move),
  };
}

/** One connection; every read below runs inside `snapshot`. */
function openOne(url: string): SQL {
  return new SQL({ url, max: 1 });
}

/**
 * One transaction for every read: repeatable read, so the census, the rows
 * and the stored vectors describe one instant of a brain that is being written
 * to; read only, so a bug in here cannot write. Postgres refuses any write
 * inside it, which the fixture check probes.
 */
export const SNAPSHOT = "isolation level repeatable read read only";
function snapshot<T>(sql: SQL, fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(SNAPSHOT, fn);
}

async function readBrain(sql: SQL): Promise<{ rows: (ThoughtRow & { content: string })[]; census: Census; claims: ClaimStat[] }> {
  const config: Record<string, string> = {};
  for (const r of (await sql`SELECT key, value FROM ob1_config WHERE key IN ('embedding_model', 'embedding_dim', 'chunk_context', 'entity_extraction_key')`) as { key: string; value: string }[]) config[r.key] = r.value;
  // 016 treats an empty key as none; so does the pool.
  const recordedKey = config.entity_extraction_key || undefined;

  // The stale-graph comparison, the pool rows and the recorded pass's
  // finished_at against the move are decided in SQL at full precision; the
  // pool pairs come out as `key=status,…` for parsePool. The graph is the
  // MODEL passes' rows: 053's structured pass writes `source:` keys with no
  // model call, and its own SQL spells "an extracted pass" as NOT LIKE
  // 'source:%' — a structured row re-ingested after an edit would otherwise
  // mask a stale model extraction.
  const raw = (await sql`
    WITH moved AS (
      SELECT a.thought_id, max(a.created_at) AS at FROM thought_audit a
      WHERE a.action = 'update' AND a.diff ? 'content'
        AND content_fingerprint_of(a.diff->'content'->>'before') <> content_fingerprint_of(a.diff->'content'->>'after')
      GROUP BY 1),
    ext AS (SELECT e.thought_id, max(e.extracted_at) AS at, count(*)::int AS n FROM thought_entities e WHERE e.extraction_key NOT LIKE 'source:%' GROUP BY 1),
    pool AS (SELECT w.thought_id, string_agg(w.work_type || '=' || w.status, ',' ORDER BY w.work_type) AS pairs FROM thought_work_claims w WHERE w.work_type LIKE 'extract:%' GROUP BY 1),
    own AS (SELECT w.thought_id, w.finished_at FROM thought_work_claims w WHERE w.work_type = ${recordedKey ?? ""})
    SELECT t.id::text AS id, t.content, length(t.content) AS chars, t.content_fingerprint AS stored_fp,
           content_fingerprint_of(t.content) AS payload_fp, t.embedding_model AS model, (t.embedding IS NOT NULL) AS has_vector,
           (SELECT count(*) FROM thought_chunks c WHERE c.thought_id = t.id)::int AS chunk_rows,
           coalesce(ext.n, 0) AS mentions,
           coalesce(moved.at > ext.at, false) AS content_moved_after_extraction,
           pool.pairs AS pool,
           (own.finished_at < moved.at) AS recorded_finished_before_move
    FROM thoughts t
    LEFT JOIN moved ON moved.thought_id = t.id
    LEFT JOIN ext ON ext.thought_id = t.id
    LEFT JOIN pool ON pool.thought_id = t.id
    LEFT JOIN own ON own.thought_id = t.id
    ORDER BY t.created_at, t.id`) as RawRow[];
  const rows = raw.map((r) => toRow(r, recordedKey));

  const audit = (await sql`
    SELECT count(*) FILTER (WHERE action = 'capture')::int AS capture, count(*) FILTER (WHERE action = 'update')::int AS update,
           count(*) FILTER (WHERE action = 'delete')::int AS delete, count(*) FILTER (WHERE action = 'update' AND diff ? 'content')::int AS content_updates,
           count(*) FILTER (WHERE action = 'update' AND diff ? 'content' AND content_fingerprint_of(diff->'content'->>'before') <> content_fingerprint_of(diff->'content'->>'after'))::int AS key_updates,
           pg_table_size('thought_audit')::bigint AS bytes FROM thought_audit`)[0] as { capture: number; update: number; delete: number; content_updates: number; key_updates: number; bytes: number | string };
  const liveWithContentEvent = Number(((await sql`SELECT count(*)::int AS n FROM thoughts t WHERE EXISTS (SELECT 1 FROM thought_audit a WHERE a.thought_id = t.id AND a.action = 'update' AND a.diff ? 'content')`)[0] as { n: number }).n);
  const edges = Number(((await sql`SELECT count(*)::int AS n FROM ob1_entity_edges`)[0] as { n: number }).n);
  const proposals = Number(((await sql`SELECT count(*)::int AS n FROM supersession_proposals`)[0] as { n: number }).n);
  const claims = ((await sql`
    SELECT work_type AS key, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - claimed_at))::float AS median_s,
           avg(extract(epoch FROM finished_at - claimed_at))::float AS mean_s
    FROM thought_work_claims WHERE status = 'succeeded' AND finished_at IS NOT NULL AND claimed_at IS NOT NULL GROUP BY 1 ORDER BY 1`) as { key: string; n: number; median_s: number; mean_s: number }[])
    .map((r) => ({ key: r.key, n: Number(r.n), medianS: Number(r.median_s), meanS: Number(r.mean_s) }));

  const byModel = new Map<string | null, number>();
  for (const r of rows) if (r.hasVector) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
  const census: Census = {
    thoughts: rows.length,
    chars: rows.reduce((n, r) => n + r.chars, 0),
    withVector: rows.filter((r) => r.hasVector).length,
    byModel: [...byModel].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n),
    fingerprintAgrees: rows.filter((r) => r.storedFingerprint !== null && r.storedFingerprint === r.payloadFingerprint).length,
    fingerprintNull: rows.filter((r) => r.storedFingerprint === null).length,
    chunkedThoughts: rows.filter((r) => r.chunkRows > 0).length,
    chunkRows: rows.reduce((n, r) => n + r.chunkRows, 0),
    mentions: rows.reduce((n, r) => n + r.mentions, 0),
    edges,
    proposals,
    audit: { capture: Number(audit.capture), update: Number(audit.update), delete: Number(audit.delete), contentUpdates: Number(audit.content_updates), keyUpdates: Number(audit.key_updates), liveWithContentEvent, bytes: Number(audit.bytes) },
    config,
  };
  return { rows, census, claims };
}

type Stored = { parents: Map<string, number[]>; windows: Map<string, number[][]> };

/** The stored vectors of the sampled rows, parents and windows, as pgvector prints them (`[a,b,…]`, JSON). */
async function storedVectors(sql: SQL, ids: string[]): Promise<Stored> {
  if (!ids.length) return { parents: new Map(), windows: new Map() };
  // `id::text IN (…)` rather than `= ANY($1::uuid[])`: Bun binds a JS array to ANY as one text value (SMD-1803's trap).
  const rows = (await sql`SELECT id::text AS id, embedding::text AS v FROM thoughts WHERE embedding IS NOT NULL AND id::text IN ${sql(ids)}`) as { id: string; v: string }[];
  const chunks = (await sql`SELECT thought_id::text AS id, chunk_index AS i, embedding::text AS v FROM thought_chunks WHERE thought_id::text IN ${sql(ids)} ORDER BY thought_id, chunk_index`) as { id: string; i: number; v: string }[];
  const windows = new Map<string, number[][]>();
  for (const c of chunks) {
    const list = windows.get(c.id) ?? [];
    list[Number(c.i)] = JSON.parse(c.v) as number[];
    windows.set(c.id, list);
  }
  return { parents: new Map(rows.map((r) => [r.id, JSON.parse(r.v) as number[]])), windows };
}

// ── The run ──────────────────────────────────────────────────────────────────

type LiveRow = ThoughtRow & { content: string };

function scenariosOf(rows: readonly LiveRow[], target: string, editN: number, wouldChunk: (r: LiveRow) => boolean): Scenarios {
  const edited = new Set(stratifiedSample(rows, editN).map((r) => r.id));
  return buildScenarios(rows, target, edited, bumpedName(target), wouldChunk);
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set — the report reads the live brain; --self-check needs no database."); process.exit(2); }
  const sampleN = Number(valueOf("--sample") ?? DEFAULT_SAMPLE);
  const editN = Number(valueOf("--edit") ?? DEFAULT_EDITS);
  const withProvider = !has("--no-provider");

  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const sql = openOne(url);
  // One snapshot: the rows, the census, the claims and the sampled rows' stored vectors.
  const { rows, census, claims, picked, stored } = await snapshot(sql, async (tx) => {
    const brain = await readBrain(tx);
    const picked = withProvider ? stratifiedSample(brain.rows, sampleN) : [];
    const stored = await storedVectors(tx, picked.map((r) => r.id));
    return { ...brain, picked, stored };
  });
  await sql.end();
  const target = census.config.embedding_model;
  if (!target) { console.error("ob1_config records no embedding_model (migration 006): nothing to replay against."); process.exit(2); }
  // The server's own windowing rule decides which thoughts the current recipe writes chunk rows for.
  const wouldChunk = (r: { content: string }) => chunkContent(r.content, { maxTokens: cfg.chunkTokens, threshold: cfg.chunkThreshold, overlapTokens: cfg.chunkOverlap }).length > 0;
  const scenarios = scenariosOf(rows, target, editN, wouldChunk);
  const stale = staleGraph(rows);

  let samples: Sample[] | null = null;
  let cost: CostModel | null = null;
  let provider: string | null = null;
  if (withProvider) {
    if (cfg.embeddingModel !== target) {
      console.error(`OB1_EMBEDDING_MODEL is ${cfg.embeddingModel} and the brain is recorded at ${target}: the fresh vector would be another model's, so the cosine would say nothing. Set the model, or --no-provider for the counts alone.`);
      process.exit(2);
    }
    const width = Number(census.config.embedding_dim);
    if (Number.isFinite(width) && width !== cfg.embeddingDim) {
      console.error(`OB1_EMBEDDING_DIM is ${cfg.embeddingDim} and the brain's column is ${width} wide (ob1_config.embedding_dim): the fresh vector would be another width, so the cosine would compare a prefix. Set the width, or --no-provider for the counts alone.`);
      process.exit(2);
    }
    // rememberRefusal off, as reembed.ts runs it: each row's fallback is its own.
    const embedder = createEmbedder(() => cfg, { rememberRefusal: false });
    samples = [];
    process.stderr.write(`embedding ${picked.length} sampled rows through ${cfg.embeddings.base} (${cfg.embeddingModel}@${cfg.embeddingDim}), one at a time\n`);
    for (const r of picked) {
      const t0 = performance.now();
      try {
        const e = await embedder.embedCapture(r.content, { kind: "re-embed", content: r.content });
        const ms = performance.now() - t0;
        const was = stored.parents.get(r.id);
        const widthMismatch = was !== undefined && was.length !== e.embedding.length;
        const storedWindows = stored.windows.get(r.id) ?? [];
        const storedCount = storedWindows.filter((w) => w !== undefined).length;
        // A different count means the recipe moved: nothing lines up by index, and the rows compared would be a coincidence.
        const windowCountMismatch = storedCount !== e.chunks.length;
        const windowCos = windowCountMismatch ? [] : e.chunks.map((w, i) => (storedWindows[i] ? (storedWindows[i].length === w.embedding.length ? cosine(w.embedding, storedWindows[i]) : NaN) : null)).filter((c): c is number => c !== null);
        samples.push({
          id: r.id, chars: r.chars, decision: decideEmbedding(r, target), windows: e.chunks.length, calls: 1 + e.chunks.length, ms,
          cosineToStored: was && !widthMismatch ? cosine(e.embedding, was) : null, widthMismatch,
          windowCosineMin: windowCos.length ? Math.min(...windowCos) : null, windowsCompared: windowCos.length, windowCountMismatch,
          fellBack: e.wholeContentFellBack,
        });
        process.stderr.write(`  ${r.id} ${r.chars} chars ${(ms / 1000).toFixed(2)} s${e.chunks.length ? ` (${e.chunks.length} windows, ${windowCos.length} compared)` : ""}${widthMismatch ? " WIDTH MISMATCH" : ""}${windowCountMismatch ? ` WINDOW COUNT ${e.chunks.length} vs ${storedCount} stored` : ""}\n`);
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "egress") {
          console.error(`the egress gate refused the sample's text: ${e.message}\n  Declare the provider local (OB1_LLM_LOCAL=1) as the server does, or --no-provider for the counts alone.`);
          process.exit(2);
        }
        throw e;
      }
    }
    cost = costModel(samples, { rows: census.thoughts, chars: census.chars, windowed: census.chunkedThoughts }, scenarios.edited.n);
    provider = `${cfg.embeddings.base} ${cfg.embeddingModel}@${cfg.embeddingDim}`;
  }

  const o: Observation = { at: new Date().toISOString(), census, scenarios, stale, claims, samples, cost, provider, verdict: verdict(scenarios, cost) };
  console.log(renderReport(o));
  const out = valueOf("--json");
  if (out) { writeFileSync(out, JSON.stringify(o, null, 2) + "\n"); console.error(`\nwritten: ${out}`); }
  process.exit(o.verdict.go ? 0 : 1);
}

// ── The fixture check: the SQL held to the contract on a seeded brain ────────

/** The seeded brain's width and model: small, and not a name any provider serves. */
export const FIXTURE_DIM = 8;
export const FIXTURE_MODEL = "fixture-model";
export const FIXTURE_KEY = "extract:fixture@p1";
export const FIXTURE_OTHER_KEY = "extract:other@p1";
const fid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * One row per branch of the replay rule, the stale-graph rule and the pool
 * rule, seeded through raw SQL around the writers (the audit and requeue
 * triggers fire as they would for any writer), so readBrain's SQL — the
 * derivations the pure rules take as given — is held to the contract on a
 * database, in the data-layer job. The live brain cannot show this: every
 * row there reuses.
 *
 * It DROPS the schema at DATABASE_URL. test-support's guard refuses a
 * non-loopback host; on top of it, a database that already holds thoughts is
 * refused unless OB1_FIXTURE_RESET=1 says so — a live brain on a published
 * loopback port is one flag away from the documented report run.
 */
async function fixtureCheck(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun eval-projection-replay.ts --fixture-check"); process.exit(2); }
  const probe = new SQL({ url, max: 1 });
  // Two statements: a subquery over a table that does not exist fails at parse time, CASE or no CASE.
  const exists = ((await probe`SELECT (to_regclass('thoughts') IS NOT NULL) AS present`)[0] as { present: boolean }).present;
  const held = exists ? Number(((await probe`SELECT count(*)::int AS n FROM thoughts`)[0] as { n: number }).n) : 0;
  await probe.end();
  if (held > 0 && process.env.OB1_FIXTURE_RESET !== "1") {
    console.error(`the database at DATABASE_URL holds ${held} thought(s) and --fixture-check DROPS the schema. Point it at a throwaway (../db/with-postgres.sh), or set OB1_FIXTURE_RESET=1 if you mean it.`);
    process.exit(2);
  }
  // resetSchema refuses a non-loopback database unless OB1_ALLOW_REMOTE_DB=1 (test-support's guard).
  await resetSchema(url, { dim: FIXTURE_DIM, model: FIXTURE_MODEL });
  const sql = new SQL({ url, max: 1 });
  const vec = `[${Array.from({ length: FIXTURE_DIM }, (_, i) => ((i + 1) / 10).toFixed(1)).join(",")}]`;
  const text = (tag: string, n: number) => `${tag}: ` + "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);
  const insert = (n: number, content: string, o: { fp?: boolean; vector?: boolean; model?: string | null } = {}) =>
    sql`INSERT INTO thoughts (id, content, content_fingerprint, embedding, embedding_model)
        VALUES (${fid(n)}::uuid, ${content}, ${o.fp === false ? null : sql`content_fingerprint_of(${content})`}, ${o.vector === false ? null : sql`${vec}::vector`}, ${o.model === undefined ? FIXTURE_MODEL : o.model})`;
  let entities = 0;
  const mention = async (n: number, key = FIXTURE_KEY) => {
    entities++;
    const [{ id }] = (await sql`INSERT INTO ob1_entities (entity_type, name, normalized_name) VALUES ('tool', ${`Tool${entities}`}, ${`tool${entities}`}) RETURNING id::text AS id`) as { id: string }[];
    await sql`INSERT INTO thought_entities (thought_id, entity_id, confidence, extraction_key) VALUES (${fid(n)}::uuid, ${id}::uuid, 1.00, ${key})`;
  };
  // A raw content update around the writers leaves the key as it was (018's stale-key case); a writer refreshes it.
  const moveContent = (n: number, content: string, refreshKey: boolean) =>
    refreshKey
      ? sql`UPDATE thoughts SET content = ${content}, content_fingerprint = content_fingerprint_of(${content}) WHERE id = ${fid(n)}::uuid`
      : sql`UPDATE thoughts SET content = ${content} WHERE id = ${fid(n)}::uuid`;
  const recordKey = (key: string) => sql`INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', ${key}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

  // The recorded extraction key, so 016's trigger enqueues every insert and re-enqueues every content move under it.
  await recordKey(FIXTURE_KEY);
  // Lengths ascending with the row's part, row 1 the shortest and row 6 the longest, so the two-edit sample is a reuse and a row already a miss.
  await insert(1, text("one reuse", 60));
  await insert(2, text("two unlabelled", 100), { model: null });
  await insert(3, text("three no vector", 150), { vector: false, model: null });
  await insert(4, text("four no fingerprint", 200), { fp: false });
  await insert(5, text("five other model", 250), { model: "other-model@8" });
  await insert(7, text("seven graph re-read after the move", 300));
  await insert(8, text("eight graph stale, the retry failed", 350));
  await insert(9, text("nine graph stale, succeeded before the move", 400));
  await insert(11, text("eleven graph, a whitespace-only edit", 450));
  await insert(10, text("ten windowed", 500));
  await insert(12, text("twelve graph stale, queued", 550));
  await insert(6, text("six stale key", 900));
  // Row 1: a metadata-only edit (an update row with no content), then a whitespace-only content edit (content moved, the fingerprint did not).
  await sql`UPDATE thoughts SET metadata = metadata || '{"fixture": 1}'::jsonb WHERE id = ${fid(1)}::uuid`;
  await moveContent(1, text("one reuse", 60) + "   ", true);
  // Row 6: the text moved around the writers and the key was left as it was (018's stale-key case).
  await moveContent(6, text("six stale key, moved", 920), false);
  // Row 7: extracted, the text moved through a writer, then extracted AGAIN — the graph is fresh.
  await mention(7); await moveContent(7, text("seven moved", 310), true); await mention(7);
  // Row 8: extracted, moved, and the re-read under the recorded key failed.
  await mention(8); await moveContent(8, text("eight moved", 360), true);
  await sql`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), attempt_count = 3, last_error = 'fixture' WHERE thought_id = ${fid(8)}::uuid AND work_type = ${FIXTURE_KEY}`;
  // Row 9: extracted and the pass finished under the recorded key; then the recorded key moved to another pass, the text
  // moved (016 re-enqueued under the key of the moment), and the key moved back — succeeded BEFORE the move, pending elsewhere.
  await mention(9);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', claimed_at = now() - interval '30 seconds', finished_at = now() WHERE thought_id = ${fid(9)}::uuid AND work_type = ${FIXTURE_KEY}`;
  await recordKey(FIXTURE_OTHER_KEY);
  await moveContent(9, text("nine moved", 410), true);
  await recordKey(FIXTURE_KEY);
  // Row 11: extracted, then a whitespace-only edit through a writer — content moved, the key did not, the graph is fresh.
  await mention(11); await moveContent(11, text("eleven graph, a whitespace-only edit", 450) + "  ", true);
  // Row 12: extracted, moved, re-enqueued under the recorded key and still waiting — and a structured `source:` row
  // (053's ingester, no model) written after the move, which is not the graph projection and must not read it fresh.
  await mention(12); await moveContent(12, text("twelve moved", 560), true); await mention(12, "source:fixture");
  // Row 10: two chunk rows.
  await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES (${fid(10)}::uuid, 0, 'w0', ${vec}::vector), (${fid(10)}::uuid, 1, 'w1', ${vec}::vector)`;

  const { rows, census, claims } = await snapshot(sql, readBrain);
  // The snapshot refuses a write: the guard the live run rests on, held here.
  let refused: string | null = null;
  try { await snapshot(sql, async (tx) => { await tx`UPDATE thoughts SET metadata = metadata || '{"probe": 1}'::jsonb WHERE id = ${fid(1)}::uuid`; }); } catch (e) { refused = (e as Error).message; }
  await sql.end();
  const target = census.config.embedding_model;
  const s = scenariosOf(rows, target, 2, () => false);
  const st = staleGraph(rows);
  const v = verdict(s, null);
  console.log(renderReport({ at: new Date().toISOString(), census, scenarios: s, stale: st, claims, samples: null, cost: null, provider: null, verdict: v }));
  console.log("");

  const { assert, report } = createAssert();
  const by = new Map(rows.map((r) => [r.id, r]));
  const decision = (n: number): Decision => decideEmbedding(by.get(fid(n))!, target);
  console.log("[fixture] the replay rule on the seeded rows");
  assert(target === FIXTURE_MODEL && census.config.embedding_dim === String(FIXTURE_DIM), `ob1_config records the fixture's model and width (${target}@${census.config.embedding_dim})`);
  assert(rows.length === 12 && census.thoughts === 12, "twelve rows read back");
  assert([1, 7, 8, 9, 10, 11, 12].every((n) => decision(n) === "reuse"), "the rows with the key, a vector and the label reuse — a whitespace-only edit moves no key");
  assert(decision(2) === "recompute:unlabelled", "a NULL label recomputes as unlabelled");
  assert(decision(3) === "recompute:no-vector", "no vector recomputes as no-vector, before its label is read");
  assert(decision(4) === "recompute:no-fingerprint", "a NULL fingerprint recomputes as no-fingerprint, apart from a moved key");
  assert(decision(5) === "recompute:model", "another model's label recomputes as model");
  assert(decision(6) === "recompute:content", "a key left stale by a raw content update recomputes as content");
  assert(census.fingerprintAgrees === 10 && census.fingerprintNull === 1 && census.withVector === 11, `the census: fingerprint agrees ${census.fingerprintAgrees}, NULL ${census.fingerprintNull}, with a vector ${census.withVector}`);

  console.log("[fixture] the scenarios and the verdict");
  assert(s.noOp.reuse === 7 && recomputed(s.noOp) === 5 && describeMisses(s.noOp) === "no-fingerprint 1, content 1, no-vector 1, unlabelled 1, model 1", `A: 7 reused, every miss reason once (${describeMisses(s.noOp)})`);
  assert(s.edited.n === 2 && s.edited.ids.join() === `${fid(1)},${fid(6)}` && s.edited.alreadyMissed === 1, `B: the two-edit sample is the shortest and the longest, one already a miss (${s.edited.ids.join()})`);
  assert(recomputed(s.edited.tally) === 6 && s.edited.tally.recompute.content === 2, "B: six recomputed — one beyond the no-op's five");
  assert(s.modelBump.other === BUMPED_MODEL && s.modelBump.tally.reuse === 0 && s.modelBump.tally.recompute.model === 8, "C: nothing reused; the eight labelled rows recompute for the model, the others for their own reason");
  assert(s.recipe.chunkedNow === 1 && s.recipe.chunkRowsNow === 2 && s.recipe.parentsReused === 12, "E: one windowed thought, two chunk rows, every parent kept");
  assert(!v.go && v.reasons.some((r) => /^NO-GO: the no-op rebuild reuses 7\/12 \(58\.3%\)/.test(r)), "the verdict is NO-GO on the reuse share, the misses named");
  assert(v.reasons.some((r) => /^B \(simulated\): 2 edits \(1 already a miss in A\) recompute exactly 1 beyond the no-op's 5/.test(r)), "B's line states the overlap rather than a contradiction");

  console.log("[fixture] the log, the graph and the pool as the SQL derives them");
  assert(census.audit.capture === 12 && census.audit.update === 8, `the audit: 12 captures, 8 updates (${census.audit.update})`);
  assert(census.audit.contentUpdates === 7 && census.audit.keyUpdates === 5, `7 updates moved content, 5 of them the fingerprint (${census.audit.contentUpdates}/${census.audit.keyUpdates}) — the two whitespace edits moved no key`);
  assert(census.audit.liveWithContentEvent === 7, `the log holds content for the 7 edited rows (${census.audit.liveWithContentEvent})`);
  assert(census.mentions === 6 && census.chunkedThoughts === 1 && census.chunkRows === 2, `six model mentions (row 7 twice; row 12's source: row not among them), one windowed thought (${census.mentions})`);
  assert(st.thoughts === 3 && st.mentions === 3, `three thoughts extracted before their key moved (${st.thoughts}, ${st.mentions} mentions)`);
  assert(by.get(fid(7))!.contentMovedAfterExtraction === false, "a thought re-extracted after its move is fresh: the comparison is the latest extraction against the latest key move");
  assert(by.get(fid(11))!.contentMovedAfterExtraction === false, "a whitespace-only edit after extraction moves no key: fresh — the fingerprint condition, not the content one");
  assert(by.get(fid(12))!.contentMovedAfterExtraction === true && by.get(fid(12))!.mentions === 1, "a structured source: row written after the move does not make a stale model extraction fresh, and is not counted as a mention");
  assert(by.get(fid(6))!.contentMovedAfterExtraction === false && by.get(fid(1))!.contentMovedAfterExtraction === false, "a thought with no graph rows is not stale");
  assert(st.queued === 1 && st.failed === 1 && st.succeededBefore === 1 && st.succeededAfter === 0 && st.succeededUnplaced === 0 && st.none === 0 && st.elsewhere === 1, `under the recorded key: queued ${st.queued}, failed ${st.failed}, succeeded before ${st.succeededBefore}, after ${st.succeededAfter}, unplaced ${st.succeededUnplaced}, none ${st.none}; pending elsewhere ${st.elsewhere}`);
  const nine = by.get(fid(9))!;
  assert(nine.pool.recorded === "succeeded" && nine.pool.finished === "before" && nine.pool.elsewhere === true, `row 9: succeeded under the recorded key before the move, pending under the other key (${JSON.stringify(nine.pool)})`);
  assert(by.get(fid(12))!.pool.recorded === "pending" && by.get(fid(12))!.pool.elsewhere === false && by.get(fid(8))!.pool.recorded === "failed", "row 12 pending here and nowhere else; row 8 failed");
  assert(claims.length === 1 && claims[0].key === FIXTURE_KEY && claims[0].n === 1 && claims[0].medianS >= 29 && claims[0].medianS <= 31, `the claim log's one succeeded row prices the fixture key at its claimed-to-finished span (${claims.map((c) => `${c.key} n ${c.n} ${c.medianS.toFixed(1)} s`).join(", ")})`);

  console.log("[fixture] the snapshot");
  assert(refused !== null && /read-only transaction/.test(refused), `a write inside the snapshot is refused by Postgres (${refused?.slice(0, 80)})`);
  report();
}

// ── The self-check ───────────────────────────────────────────────────────────

const row = (id: string, o: Partial<ThoughtRow> = {}): ThoughtRow => ({
  id, chars: 1000, storedFingerprint: `fp-${id}`, payloadFingerprint: `fp-${id}`, model: "m1", hasVector: true, chunkRows: 0, mentions: 3, contentMovedAfterExtraction: false, pool: { recorded: "none", elsewhere: false, finished: null }, ...o,
});
const sample = (id: string, o: Partial<Sample> = {}): Sample => ({ id, chars: 1000, decision: "reuse", windows: 0, calls: 1, ms: 1000, cosineToStored: 1, widthMismatch: false, windowCosineMin: null, windowsCompared: 0, windowCountMismatch: false, fellBack: false, ...o });

function selfCheck(): void {
  const { assert, report } = createAssert();

  console.log("[1] The contract names every projection once, with a verdict from the list");
  assert(PROJECTIONS.length === 6 && new Set(PROJECTIONS.map((p) => p.name)).size === 6, "six projections, six names");
  assert(PROJECTIONS.every((p) => KEY_VERDICTS.includes(p.verdict) && p.derived.length > 0 && p.recorded.length > 0), "each carries a derived key, a recorded key and a verdict from KEY_VERDICTS");
  assert(PROJECTIONS.find((p) => p.name === "embedding")!.verdict === "recorded" && PROJECTIONS.find((p) => p.name === "metadata")!.verdict === "unkeyed" && PROJECTIONS.find((p) => p.name === "graph")!.verdict === "half recorded" && PROJECTIONS.find((p) => p.name === "chunks")!.verdict === "recipe not recorded", "the embedding's key is recorded, the graph's half, the chunks' recipe not, the capture-time metadata's not at all");
  assert(/template/.test(PROJECTIONS[0].derived) && /nullable/.test(PROJECTIONS[3].recorded) && PROJECTIONS.find((p) => p.name === "sources")!.verdict === "recorded" && /source:/.test(PROJECTIONS.find((p) => p.name === "sources")!.recorded), "the embedding's entry says the template rides on the name by convention; the proposals' that the fingerprints are nullable; 053's sources are recorded and their rows carry a source: key");

  console.log("[2] The replay rule, branch by branch, in order");
  assert(decideEmbedding(row("a"), "m1") === "reuse", "the key, a vector, the target's label: reuse");
  assert(decideEmbedding(row("a", { storedFingerprint: null }), "m1") === "recompute:no-fingerprint", "no key on the row: recompute, and not as a moved key");
  assert(decideEmbedding(row("a", { storedFingerprint: "stale" }), "m1") === "recompute:content", "the row's key is not the payload's: recompute for content (an edit, or a stale key)");
  assert(decideEmbedding(row("a", { hasVector: false }), "m1") === "recompute:no-vector", "no vector: recompute");
  assert(decideEmbedding(row("a", { model: null }), "m1") === "recompute:unlabelled", "a NULL label is unknown, and unknown is not the target (021)");
  assert(decideEmbedding(row("a", { model: "m0" }), "m1") === "recompute:model", "another model's label: recompute");
  assert(decideEmbedding(row("a", { storedFingerprint: null, hasVector: false, model: null }), "m1") === "recompute:no-fingerprint", "no key is judged before the vector and the label");
  assert(decideEmbedding(row("a", { hasVector: false, model: null, storedFingerprint: "x" }), "m1") === "recompute:content", "…then the moved key, before the vector and the label");
  assert(decideEmbedding(row("a", { hasVector: false, model: null }), "m1") === "recompute:no-vector", "…and the vector before the label");
  assert(decideEmbedding(row("a"), "m1", "other") === "recompute:content", "a payload fingerprint given explicitly overrides the row's own (how an edit is simulated)");
  assert(bumpedName("m1") === BUMPED_MODEL && bumpedName(BUMPED_MODEL) !== BUMPED_MODEL && bumpedName(BUMPED_MODEL) !== "m1", "the bumped name is never the brain's own label, even on a brain recorded at the first choice");

  console.log("[3] The pool state from the aggregated claim rows");
  assert(parsePool(null).length === 0 && parsePool("").length === 0, "no claim rows parse to nothing");
  assert(JSON.stringify(parsePool("extract:a@p1=pending,extract:b@p2=failed")) === JSON.stringify([{ key: "extract:a@p1", status: "pending" }, { key: "extract:b@p2", status: "failed" }]), "key=status pairs parse, a key with @ and : intact");
  assert(JSON.stringify(parsePool("extract:a=b@p1=pending")) === JSON.stringify([{ key: "extract:a=b@p1", status: "pending" }]), "a key carrying = keeps it: the split is on the last =");
  let threw = false; try { parsePool("extract:a@p1=bogus"); } catch { threw = true; }
  assert(threw, "a status outside the four is refused");
  threw = false; try { parsePool("=pending"); } catch { threw = true; }
  assert(threw, "…and so is an empty key");
  const pairs = parsePool("extract:a@p1=succeeded,extract:b@p2=pending,reembed:x@8=pending");
  assert(poolState(pairs, "extract:a@p1").recorded === "succeeded" && poolState(pairs, "extract:a@p1").elsewhere === true, "under the recorded key succeeded; pending under another extract key counts as elsewhere");
  assert(poolState(pairs, "extract:b@p2").recorded === "pending" && poolState(pairs, "extract:b@p2").elsewhere === false, "under the other key pending, and a succeeded row elsewhere is not a pending one");
  assert(poolState(pairs, "extract:c@p3").recorded === "none" && poolState(pairs, undefined).recorded === "none" && poolState(pairs, "").recorded === "none", "no row under the recorded key, no recorded key, or an empty one, is none");
  assert(poolState(parsePool("reembed:x@8=pending"), "extract:a@p1").elsewhere === false, "a re-embed row is not an extraction pool");
  assert(poolState(pairs, "extract:a@p1", true).finished === "before" && poolState(pairs, "extract:a@p1", false).finished === "after" && poolState(pairs, "extract:a@p1", null).finished === null, "a succeeded row is placed before or after the move by the stamp the SQL compared, or not at all");
  assert(poolState(pairs, "extract:b@p2", true).finished === null, "a pending row is placed nowhere: the move is what queued it");

  console.log("[4] The scenarios on a hand-known corpus");
  const corpus = [row("a"), row("b", { chars: 500 }), row("c", { chars: 9000, chunkRows: 4 }), row("d", { chars: 200, mentions: 0 }), row("e", { chars: 3000, contentMovedAfterExtraction: true }), row("f", { chars: 7000 })];
  const a = noOpRebuild(corpus, "m1");
  assert(a.total === 6 && a.reuse === 6 && recomputed(a) === 0 && a.recomputed.length === 0, "A: a no-op rebuild reuses every row");
  const staleKey = corpus.map((r) => (r.id === "b" ? { ...r, storedFingerprint: "held-by-another-text" } : r));
  const a2 = noOpRebuild(staleKey, "m1");
  assert(a2.reuse === 5 && a2.recompute.content === 1 && a2.recomputed.join() === "b", "A: a row whose key went stale is one recompute for content, named");
  const unkeyed = corpus.map((r) => (r.id === "b" ? { ...r, storedFingerprint: null } : r));
  assert(noOpRebuild(unkeyed, "m1").recompute["no-fingerprint"] === 1 && describeMisses(noOpRebuild(unkeyed, "m1")) === "no-fingerprint 1", "A: a row with no key is one recompute for no-fingerprint, described apart");
  const vectorless = corpus.map((r) => (r.id === "d" ? { ...r, hasVector: false, model: null } : r));
  assert(noOpRebuild(vectorless, "m1").recompute["no-vector"] === 1 && describeMisses(noOpRebuild(vectorless, "m1")) === "no-vector 1", "A: a capture that landed vectorless is one recompute, described");
  const b = editedRebuild(corpus, "m1", new Set(["a", "f"]));
  assert(b.reuse === 4 && b.recompute.content === 2 && recomputed(b) === 2 && b.recomputed.join() === "a,f", "B: two edits recompute exactly two, for content, by id");
  assert(editedRebuild(corpus, "m1", new Set(["zzz"])).reuse === 6, "B: an edit naming no row changes nothing");
  const c = modelBumpRebuild(corpus, "m2");
  assert(c.reuse === 0 && c.recompute.model === 6, "C: a model bump recomputes every row, for the model");
  const mixed = corpus.map((r) => (r.id === "a" ? { ...r, model: "m2" } : r));
  assert(modelBumpRebuild(mixed, "m2").reuse === 1 && modelBumpRebuild(mixed, "m2").recompute.model === 5, "C: a row already at the new model is reused — a switch back re-embeds nothing twice (021)");
  const d = comprehensionOnlyRebuild(corpus, "m1");
  assert(recomputed(d.embedding) === recomputed(a) && d.graph.thoughts === 6 && d.graph.mentionsReplaced === 15, "D: the embedding tally is the no-op's (derived, by construction); the graph re-reads every thought and replaces its mention rows");
  const e = recipeChangeRebuild(corpus, (r) => r.chars > 5000);
  assert(e.parentsReused === 6 && e.chunkedNow === 1 && e.chunkRowsNow === 4 && e.wouldChunk === 2 && e.fallbackParentsUnknowable === true, "E: parents stay, the chunked thought's rows go, the current recipe's own count is separate, the fallback is unknowable");
  assert(tally([], "m1").total === 0 && recomputed(tally([], "m1")) === 0, "an empty corpus tallies to nothing");

  console.log("[5] The stale graph and the pool it sits in");
  assert(staleGraph(corpus).thoughts === 1 && staleGraph(corpus).mentions === 3 && staleGraph(corpus).none === 1, "the thought whose key moved after extraction is stale, its mention rows counted, no pool row under the recorded key");
  assert(staleGraph([row("x", { contentMovedAfterExtraction: true, mentions: 0 })]).thoughts === 0, "…and not a thought with no graph rows to be stale");
  const pooled = [
    row("q", { contentMovedAfterExtraction: true, pool: { recorded: "pending", elsewhere: false, finished: null } }),
    row("c", { contentMovedAfterExtraction: true, pool: { recorded: "claimed", elsewhere: true, finished: null } }),
    row("f", { contentMovedAfterExtraction: true, pool: { recorded: "failed", elsewhere: true, finished: null } }),
    row("sb", { contentMovedAfterExtraction: true, pool: { recorded: "succeeded", elsewhere: false, finished: "before" } }),
    row("sa", { contentMovedAfterExtraction: true, pool: { recorded: "succeeded", elsewhere: false, finished: "after" } }),
    row("su", { contentMovedAfterExtraction: true, pool: { recorded: "succeeded", elsewhere: false, finished: null } }),
    row("n", { contentMovedAfterExtraction: true }),
    row("ok", { pool: { recorded: "failed", elsewhere: false, finished: null } }),
  ];
  const sg = staleGraph(pooled);
  assert(sg.thoughts === 7 && sg.queued === 2 && sg.failed === 1 && sg.succeededBefore === 1 && sg.succeededAfter === 1 && sg.succeededUnplaced === 1 && sg.none === 1 && sg.elsewhere === 1, `pending and claimed are queued; failed, succeeded-before, succeeded-after, succeeded-unplaced and none apart; elsewhere over the unqueued only (${JSON.stringify(sg)})`);

  console.log("[6] The sample is deterministic and spread by length");
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `id-${String(i).padStart(2, "0")}`, chars: (i * 37) % 50 * 100 + 100 }));
  const s1 = stratifiedSample(many, 7);
  const s2 = stratifiedSample([...many].reverse(), 7);
  assert(s1.length === 7 && s1.map((r) => r.id).join() === s2.map((r) => r.id).join(), "seven rows, the same seven whatever the input order");
  const sortedChars = [...many].sort((x, y) => x.chars - y.chars);
  assert(s1[0].chars === sortedChars[0].chars && s1[6].chars === sortedChars[49].chars, "the shortest and the longest are always in the sample");
  assert(s1.every((r, i) => i === 0 || r.chars >= s1[i - 1].chars), "…in length order");
  assert(stratifiedSample(many, 100).length === 50 && stratifiedSample(many, 1).length === 1 && stratifiedSample(many, 0).length === 0 && stratifiedSample([], 5).length === 0, "n over the corpus is the corpus; one is the shortest; zero and an empty corpus are empty");
  const ties = [{ id: "b", chars: 5 }, { id: "a", chars: 5 }, { id: "c", chars: 5 }];
  assert(stratifiedSample(ties, 2).map((r) => r.id).join() === "a,c", "equal lengths fall to the id, so the sample is total-ordered");

  console.log("[7] The cost model's arithmetic");
  assert(median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 && Number.isNaN(median([])), "median, odd and even and empty");
  const samples: Sample[] = [
    sample("a", { chars: 1000, ms: 1000, cosineToStored: 1 }),
    sample("b", { chars: 3000, ms: 3000, cosineToStored: 0.9995, windowCosineMin: 0.998, windowsCompared: 2 }),
    sample("c", { chars: 8000, ms: 8000, windows: 6, calls: 7, cosineToStored: null, fellBack: true }),
  ];
  const k = costModel(samples, { rows: 400, chars: 1_200_000, windowed: 3 }, 10);
  assert(k.sampled === 3 && k.sampledChars === 12000 && k.medianMsPerRow === 3000 && k.meanMsPerRow === 4000, "per-row median and mean");
  assert(k.meanMsPerRowTrimmed === 4000 && k.trimmedRows === 3 && trimNote(k) === `untrimmed: under ${MIN_TRIM_ROWS} rows`, "under five rows nothing is trimmed, and the note says so");
  assert(Math.abs(k.longestShare - 8000 / 12000) < 1e-12, "the longest row's share of the sample's wall-clock");
  assert(k.msPerKChar === 1000, "one second per thousand characters here");
  assert(k.modelBumpSecondsByRows === 1600 && k.modelBumpSecondsTrimmed === 1600 && k.modelBumpSecondsByChars === 1200 && k.editSeconds === 40, "the model bump priced by rows, trimmed and by characters; the edits by rows");
  assert(k.reusedCompared === 2 && k.minCosine === 0.9995 && k.medianCosine === 0.99975 && k.maxGap !== null && Math.abs(k.maxGap - 0.0005) < 1e-12 && k.fellBack === 1, "the cosine over reused rows that had a vector, the gap beside it; the fallbacks counted");
  assert(k.windowsCompared === 2 && k.windowMinCosine === 0.998 && k.windowMaxGap !== null && Math.abs(k.windowMaxGap - 0.002) < 1e-12 && k.windowCountMismatches === 0 && k.sampledWindowed === 1 && Math.abs(k.corpusWindowedShare - 0.0075) < 1e-12, "the window vectors' least cosine, its gap and count; the sample's windowed share beside the corpus's");
  const recut = costModel([sample("a", { windows: 3, windowCountMismatch: true })], { rows: 2, chars: 2000, windowed: 1 }, 1);
  assert(recut.windowCountMismatches === 1 && recut.windowMinCosine === null, "a reused row cut to another number of windows is counted and compared to nothing");
  const five = [1, 2, 3, 4, 5].map((i) => sample(`s${i}`, { chars: i * 1000, ms: i === 5 ? 10000 : 1000 }));
  const k5 = costModel(five, { rows: 100, chars: 100_000, windowed: 0 }, 2);
  assert(k5.meanMsPerRow === 2800 && k5.meanMsPerRowTrimmed === 1000 && k5.trimmedRows === 3 && trimNote(k5) === "over the 3 rows between the extremes" && Math.abs(k5.longestShare - 10000 / 14000) < 1e-12, "at five rows the two extreme ranks are dropped and the longest row's leverage shows");
  const recomputedOnly = costModel([sample("a", { decision: "recompute:content", cosineToStored: 0.3 }), sample("b", { decision: "reuse", cosineToStored: 0.9999 })], { rows: 2, chars: 2000, windowed: 0 }, 1);
  assert(recomputedOnly.reusedCompared === 1 && recomputedOnly.minCosine === 0.9999, "a recomputed row's stored vector is of other text: it is not compared");
  const mismatched = costModel([sample("a", { cosineToStored: null, widthMismatch: true })], { rows: 2, chars: 2000, windowed: 0 }, 1);
  assert(mismatched.widthMismatches === 1 && mismatched.reusedCompared === 0 && mismatched.minCosine === null, "a reused row at another width is counted as a mismatch and compared to nothing");
  const none = costModel([], { rows: 400, chars: 1, windowed: 0 }, 10);
  assert(Number.isNaN(none.meanMsPerRow) && none.minCosine === null && none.reusedCompared === 0 && Number.isNaN(none.longestShare), "no sample: no numbers, no cosine, no share");
  assert(fmtSeconds(30) === "30.0 s" && fmtSeconds(600) === "10.0 min" && fmtSeconds(7200) === "2.00 h" && fmtSeconds(NaN) === "?", "seconds are printed at the unit that reads");
  assert(fmtGap(0) === "0" && fmtGap(1.1e-16) === "1.1e-16" && fmtGap(0.0005) === "5.0e-4" && fmtGap(-2e-16) === "0" && fmtGap(null) === "?" && fmtGap(NaN) === "?", "1 − cos in exponential form, zero and a rounding above one as zero, nothing as ?");
  assert(fmtChars(500) === "500 chars" && fmtChars(20700) === "20.7 k chars" && fmtChars(1_751_616) === "1.75 M chars", "characters at the unit that reads");
  const g = graphCost([{ key: "extract:x@p2", n: 10, medianS: 36, meanS: 40 }], 400);
  assert(g.length === 1 && g[0].rebuildHoursSequential === 4, "the graph's rebuild priced from the log's own seconds per row");
  assert(isGraphPass("extract:qwen2.5:7b@p2") && !isGraphPass("consolidate:qwen2.5:7b@p2") && !isGraphPass("reembed:x@1024"), "the graph's passes are the extract: keys; the judge's and a re-embed's are not");

  console.log("[8] The verdict against the pre-registered bar");
  const ideal: Scenarios = buildScenarios(corpus, "m1", new Set(["a", "f"]), "m2", (r) => r.chars > 5000);
  assert(ideal.noOp.reuse === a.reuse && ideal.edited.n === 2 && ideal.edited.alreadyMissed === 0 && ideal.edited.ids.join() === "a,f" && recomputed(ideal.edited.tally) === recomputed(b) && ideal.modelBump.tally.recompute.model === c.recompute.model && ideal.recipe.chunkRowsNow === e.chunkRowsNow, "buildScenarios assembles the five from one corpus, as the runner does");
  const goodCost = costModel([sample("a", { cosineToStored: 0.9999, windowCosineMin: 0.9998, windowsCompared: 3 })], { rows: 6, chars: 20700, windowed: 1 }, 2);
  const v = verdict(ideal, goodCost);
  assert(v.go && !v.provisional && ["A:", "B (simulated)", "C:", "D (derived", "E:"].every((h) => v.reasons.some((r) => r.startsWith(h))), "the ideal corpus is GO with a line per scenario, B marked simulated and D derived");
  assert(v.reasons.some((r) => /^A: .*each row against its own text; the log as the payload is out of scope/.test(r)), "A's line says what it measured: the row against its own text, not the log");
  assert(v.reasons.some((r) => /over 1 reused rows, min cosine 0\.9999 \(1−cos 1\.0e-4\)/.test(r)) && v.reasons.some((r) => /^window vectors: 3 compared against the stored chunk rows, min cosine 0\.9998 \(1−cos 2\.0e-4\)/.test(r)), "the cosine lines name the reused rows covered, the gap, and the windows with their own gap on their own line");
  const recutVerdict = verdict(ideal, costModel([sample("a", { cosineToStored: 1, windows: 3, windowCountMismatch: true })], { rows: 6, chars: 20700, windowed: 1 }, 2));
  assert(!recutVerdict.go && recutVerdict.reasons.some((r) => /NO-GO: 1 reused row\(s\) cut to a different number of windows/.test(r)), "a reused row cut to another number of windows than its stored chunk rows: NO-GO — the recipe moved without the key moving");
  assert(verdict(ideal, null).go && verdict(ideal, null).provisional && verdict(ideal, null).reasons.some((r) => /provisional: no provider/.test(r)), "no provider: GO but provisional, said so");
  const poor = buildScenarios(corpus.map((r, i) => (i < 2 ? { ...r, storedFingerprint: "stale" } : r)), "m1", new Set(["c"]), "m2", () => false);
  const pv = verdict(poor, goodCost);
  assert(!pv.go && pv.reasons.some((r) => /NO-GO: the no-op rebuild reuses 4\/6 \(66.7%\).*content 2/.test(r)), "two stale keys in six is under the bar: NO-GO, the misses named");
  assert(MIN_REUSE === 0.99 && REPRO_COSINE === 0.99, "the bars are the pre-registered ones");
  const twoHundred = Array.from({ length: 200 }, (_, i) => row(`r${i}`, i === 0 ? { storedFingerprint: "stale" } : i === 1 ? { hasVector: false } : {}));
  const ov = verdict(buildScenarios(twoHundred, "m1", new Set(["r1", "r5"]), "m2", () => false), goodCost);
  assert(ov.go && ov.reasons.some((r) => /^A: the no-op rebuild reuses 198\/200 — misses the key states: content 1, no-vector 1/.test(r)), "two misses in two hundred is over the bar: GO, the misses stated");
  assert(ov.reasons.some((r) => /^B \(simulated\): 2 edits \(1 already a miss in A\) recompute exactly 1 beyond the no-op's 2; 197 reused/.test(r)), "B: an edited row the no-op already recomputed is counted once — the overlap stated, no contradiction");
  const overRecompute = { ...ideal, edited: { ...ideal.edited, n: 1, ids: ["a"] } };
  assert(!verdict(overRecompute, goodCost).go && verdict(overRecompute, goodCost).reasons.some((r) => /NO-GO: 1 edits \(0 already a miss\) recompute 2, not exactly 1 — a row the edits did not touch moved/.test(r)), "more recomputed than the edits explain: NO-GO (a projector re-embedding what it should not)");
  const underRecompute = { ...ideal, edited: { ...ideal.edited, tally: editedRebuild(corpus, "m1", new Set(["a"])) } };
  assert(!verdict(underRecompute, goodCost).go && verdict(underRecompute, goodCost).reasons.some((r) => /NO-GO: 2 edits \(0 already a miss\) recompute 1, not exactly 2 — an edited row was not recomputed/.test(r)), "an edited row not recomputed: NO-GO, named as such");
  const swapped = { ...ideal, edited: { ...ideal.edited, tally: editedRebuild(corpus, "m1", new Set(["b", "c"])) } };
  assert(!verdict(swapped, goodCost).go && verdict(swapped, goodCost).reasons.some((r) => /an edited row was not recomputed/.test(r)), "the right count over the wrong rows: NO-GO — every edited id must be among the recomputed");
  const leakyC = { ...ideal, modelBump: { other: "m2", tally: modelBumpRebuild(mixed, "m2") } };
  assert(!verdict(leakyC, goodCost).go && verdict(leakyC, goodCost).reasons.some((r) => /NO-GO: a model bump reuses 1/.test(r)), "a model bump that reuses a vector under another label: NO-GO");
  const touchyD = { ...ideal, comprehensionOnly: { embedding: b, graph: d.graph } };
  assert(!verdict(touchyD, goodCost).go && verdict(touchyD, goodCost).reasons.some((r) => /NO-GO: a comprehension-only change recomputes 2 embeddings where the no-op recomputes 0/.test(r)), "a comprehension-only change that touches a vector: NO-GO");
  const drifted = costModel([sample("a", { cosineToStored: 0.97 })], { rows: 6, chars: 20700, windowed: 0 }, 2);
  assert(!verdict(ideal, drifted).go && verdict(ideal, drifted).reasons.some((r) => /NO-GO: a reused row's fresh vector sits at cosine 0.9700/.test(r)), "a cached vector a fresh one does not reproduce: NO-GO — the vector is not a function of its key");
  const driftedRecompute = costModel([sample("a", { decision: "recompute:model", cosineToStored: 0.3 }), sample("b", { cosineToStored: 0.9999 })], { rows: 6, chars: 20700, windowed: 0 }, 2);
  assert(verdict(ideal, driftedRecompute).go, "a low cosine on a row the replay recomputes anyway is not a defect of the key");
  const noReused = costModel([sample("a", { decision: "recompute:model", cosineToStored: 0.3 })], { rows: 6, chars: 20700, windowed: 0 }, 2);
  assert(verdict(ideal, noReused).go && verdict(ideal, noReused).provisional && verdict(ideal, noReused).reasons.some((r) => /provisional: no reused row with a stored vector/.test(r)), "no reused row in the sample: the bar was not applied, so GO is provisional and says why");
  const nan = costModel([sample("a", { cosineToStored: NaN })], { rows: 6, chars: 20700, windowed: 0 }, 2);
  assert(!verdict(ideal, nan).go && verdict(ideal, nan).reasons.some((r) => /NO-GO: a reused row's fresh vector has no cosine/.test(r)), "a cosine that is not a number (a zero or mismatched vector) is a NO-GO, not a pass");
  const width = costModel([sample("a", { cosineToStored: null, widthMismatch: true })], { rows: 6, chars: 20700, windowed: 0 }, 2);
  assert(!verdict(ideal, width).go && !verdict(ideal, width).provisional && verdict(ideal, width).reasons.some((r) => /NO-GO: 1 reused row\(s\) came back at another width/.test(r)), "a fresh vector at another width than the stored one: NO-GO, not provisional — nothing was compared and that is the defect");
  const windowDrift = costModel([sample("a", { cosineToStored: 1, windowCosineMin: 0.2, windowsCompared: 2 })], { rows: 6, chars: 20700, windowed: 1 }, 2);
  assert(!verdict(ideal, windowDrift).go && verdict(ideal, windowDrift).reasons.some((r) => /NO-GO: a reused row's fresh window vector sits at cosine 0\.2000/.test(r)), "a window vector a fresh one does not reproduce: NO-GO — the window recipe moved without the key moving");
  const windowNaN = costModel([sample("a", { cosineToStored: 1, windowCosineMin: NaN, windowsCompared: 1 })], { rows: 6, chars: 20700, windowed: 1 }, 2);
  assert(!verdict(ideal, windowNaN).go && verdict(ideal, windowNaN).reasons.some((r) => /NO-GO: a reused row's fresh window vector has no cosine/.test(r)), "a window cosine that is not a number is a NO-GO");
  const noWindows = verdict(ideal, costModel([sample("a", { cosineToStored: 1 })], { rows: 6, chars: 20700, windowed: 0 }, 2));
  assert(noWindows.go && noWindows.reasons.some((r) => /^window vectors: none compared \(no windowed thought in the sample\) — the bar over the chunk rows was not applied/.test(r)), "no window in the sample: the window bar is stated as not applied, the parent bar stands");
  assert(!verdict(buildScenarios([], "m1", new Set(), "m2", () => false), goodCost).go, "an empty brain is NO-GO");

  console.log("[9] The report carries the contract, the scenarios and the verdict");
  const o: Observation = {
    at: "2026-09-24T00:00:00.000Z",
    census: { thoughts: 6, chars: 20700, withVector: 6, byModel: [{ model: "m1", n: 6 }], fingerprintAgrees: 6, fingerprintNull: 0, chunkedThoughts: 1, chunkRows: 4, mentions: 15, edges: 9, proposals: 2, audit: { capture: 6, update: 3, delete: 0, contentUpdates: 2, keyUpdates: 1, liveWithContentEvent: 1, bytes: 400000 }, config: { embedding_model: "m1", embedding_dim: "8", chunk_context: "false", entity_extraction_key: "extract:x@p1" } },
    scenarios: ideal, stale: staleGraph(corpus), claims: [{ key: "extract:x@p1", n: 6, medianS: 30, meanS: 31 }, { key: "consolidate:x@p1", n: 2, medianS: 18, meanS: 18 }], samples, cost: costModel(samples, { rows: 6, chars: 20700, windowed: 1 }, 2), provider: "http://p m1@8", verdict: v,
  };
  const text = renderReport(o);
  for (const p of PROJECTIONS) assert(text.includes(p.table) && text.includes(p.verdict), `the report names ${p.table} and its verdict`);
  assert(/A no-op rebuild\s+6\s+100\.0%\s+0\s+none/.test(text) && /B 2 edits\s+4\s+66\.7%\s+2\s+content 2/.test(text) && /C model bump → m2\s+0\s+0\.0%\s+6\s+model 6/.test(text), "the scenario rows carry reuse, share, recompute and reasons");
  assert(/2 updates moved content, 1 of them the fingerprint; the log holds content for 1\/6 live thoughts/.test(text) && /1 thought\(s\) with 3 mention rows extracted before their fingerprint last moved — under the recorded key extract:x@p1: 0 queued for a re-read, 0 failed \(terminal until --retry-failed\), 0 succeeded before the move \(re-enqueued under another key\), 0 succeeded after it with the rows still older, 0 succeeded with no stamp to place, 1 never asked; 0 of the unqueued pending under another key/.test(text) && /graph: 15 model mentions \(a source: pass's rows apart\)/.test(text), "the log's completeness and the stale graph, pool state under the recorded key with the succeeded rows placed or unplaced, are stated; the mentions are the model passes'");
  assert(/corpus: 6 thoughts, 20\.7 k chars/.test(text) && /NULL on 0/.test(text) && /target m1@8/.test(text) && /MB table and TOAST/.test(text), "characters at their unit, the NULL keys counted, the target with its width, the audit's size named for what it measures");
  assert(/per row: median 3\.00 s, mean 4\.00 s, mean untrimmed: under 5 rows 4\.00 s \(the longest row is 66\.7% of the sample's wall-clock\); 1\.000 s per 1k chars; 1 fell back/.test(text) && /worst \(C, 6 rows\): 24\.0 s by rows, 24\.0 s trimmed, 20\.7 s by characters/.test(text), "the cost lines carry the sample's numbers, the trim note, the longest row's share and the three extrapolations");
  assert(/over the 2 reused rows: min cosine 0\.9995 \(1−cos 5\.0e-4\), median 0\.9998; 0 at another width; window vectors: 2 compared, min cosine 0\.9980 \(1−cos 2\.0e-3\), 0 row\(s\) cut to another count/.test(text), "the reproducibility line names the reused rows, the gap, the width mismatches, the windows with their gap and the recut rows");
  assert(/^  id\s+decision\s+chars/m.test(text) && /\brecompute:/.test(text) === false && /  c\s+reuse\s+8000\s+6\s+7\s+8\.00\s+—\s+—\s+—  head window$/m.test(text), "the per-row table carries the decision, the gap and the window column; a fallback is marked");
  assert(/--workers 2 by default, so under its own contention/.test(text) && /extract:x@p1\s+n\s+6\s+median\s+30\.0 s\/row\s+→ 6 thoughts ≈ 0\.1 h/.test(text), "the graph's own cost says what concurrency the log recorded it under");
  assert(/other passes' rows in the claim log, for scale[\s\S]*consolidate:x@p1\s+n\s+2/.test(text) && text.indexOf("the graph's own cost") < text.indexOf("other passes' rows"), "the judge's rows are shown apart from the graph's, after them");
  assert(/^verdict: GO$/m.test(text), "the verdict line");
  const noCost = renderReport({ ...o, samples: null, cost: null, provider: null, verdict: verdict(ideal, null) });
  assert(/cost — not measured this run/.test(noCost) && /verdict: GO \(provisional\)/.test(noCost), "without a provider the report says the cost is unmeasured and the verdict provisional");
  const emptyKey = renderReport({ ...o, census: { ...o.census, config: { ...o.census.config, entity_extraction_key: "" } } });
  assert(/under the recorded key \(none\):/.test(emptyKey), "an empty recorded key prints as none");

  console.log("[10] The rows as the SQL hands them over");
  const rawRow = { id: "x", content: "t", chars: 1, stored_fp: "f", payload_fp: "f", model: "m1", has_vector: true, chunk_rows: 0, mentions: 2, content_moved_after_extraction: true, pool: "extract:a@p1=succeeded,extract:b@p2=pending", recorded_finished_before_move: true };
  const t = toRow(rawRow, "extract:a@p1");
  assert(t.contentMovedAfterExtraction === true && t.pool.recorded === "succeeded" && t.pool.finished === "before" && t.pool.elsewhere === true && t.mentions === 2, "toRow keeps the SQL's stale boolean, places the succeeded row by the SQL's comparison, and classifies the pool under the recorded key");
  assert(toRow({ ...rawRow, recorded_finished_before_move: false }, "extract:a@p1").pool.finished === "after" && toRow({ ...rawRow, recorded_finished_before_move: null }, "extract:a@p1").pool.finished === null, "…after, or unplaced when a stamp is missing");
  assert(toRow({ ...rawRow, pool: null, content_moved_after_extraction: false, recorded_finished_before_move: null }, "extract:a@p1").pool.recorded === "none", "no claim rows: none");
  assert(SNAPSHOT === "isolation level repeatable read read only", "the snapshot is repeatable read and read only");

  console.log("[11] The argument rules");
  assert(argumentProblem([]) === null && argumentProblem(["--self-check"]) === null && argumentProblem(["--fixture-check"]) === null && argumentProblem(["--no-provider", "--sample", "7", "--edit", "3", "--json", "o.json"]) === null, "the shapes that run");
  assert(/^unknown argument bogus/.test(argumentProblem(["bogus"]) ?? "") && /^unknown argument --gate/.test(argumentProblem(["--gate"]) ?? ""), "a stray word and a flag from another eval are refused by name");
  assert(/needs a value/.test(argumentProblem(["--sample"]) ?? "") && /needs a value/.test(argumentProblem(["--sample", "--edit", "3"]) ?? ""), "a valued flag with no value, or another flag where the value should be");
  assert(/positive integer, not "x"/.test(argumentProblem(["--sample", "x"]) ?? "") && /positive integer, not "0"/.test(argumentProblem(["--edit", "0"]) ?? ""), "a count that is not a positive integer");
  assert(/given 2 times; a flag given twice would be read once/.test(argumentProblem(["--sample", "3", "--sample", "4"]) ?? ""), "a flag given twice is refused, not read once (SMD-1713 pass 3)");
  assert(/--self-check takes no other argument/.test(argumentProblem(["--self-check", "--no-provider"]) ?? "") && /--fixture-check takes no other argument/.test(argumentProblem(["--fixture-check", "--sample", "3"]) ?? "") && /takes no other argument/.test(argumentProblem(["--self-check", "--fixture-check"]) ?? ""), "the two checks stand alone");
  assert(MISSES.length === 5 && DEFAULT_SAMPLE === 21 && DEFAULT_EDITS === 10 && BUMPED_MODEL !== DEFAULT_EMBEDDING_MODEL && FIXTURE_MODEL !== DEFAULT_EMBEDDING_MODEL && (FIXTURE_OTHER_KEY as string) !== FIXTURE_KEY, "the defaults; neither the bumped name nor the fixture's is the shipped model's; the fixture's two keys differ");

  report();
}

if (import.meta.main) {
  loadEnv();
  const problem = argumentProblem(args);
  if (problem) { console.error(problem); process.exit(2); }
  if (has("--self-check")) selfCheck();
  else if (has("--fixture-check")) await fixtureCheck();
  else await run();
}
