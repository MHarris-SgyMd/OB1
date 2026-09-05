#!/usr/bin/env bun
/**
 * reembed.ts — re-embed every thought, in parallel, and resume where it stopped.
 *
 * The consumer that migration 015 exists for. Changing the embedding model has
 * always meant re-embedding every row — db/config.mjs says so, preflight refuses
 * a model that disagrees with the one ob1_config recorded — and until now there
 * was nothing to do it with but a script written for the occasion. This is that
 * script, kept: it walks the corpus through the claim table so several workers
 * divide the rows without overlap, a worker that dies leaves leases that expire
 * back into the pool, and a run that stops halfway is finished by running it
 * again.
 *
 * It re-embeds exactly as a capture would. The vectors come from
 * server-portable/embed.ts — the same chunking, the same blurb rule, the same
 * prompt template, the same whole-content-then-head-window fallback the server
 * uses — and the write goes through update_thought, which replaces the chunk
 * rows wholesale as an edit does. So it is also the backfill three earlier
 * changes deferred to SMD-946 by name: a long thought captured before change 27
 * gets the whole-content vector instead of its head window, and a corpus
 * captured under one OB1_CHUNK_CONTEXT setting is brought to the current one.
 *
 *   bun db/reembed.ts --url postgres://…                  # run, or resume
 *   bun db/reembed.ts --url … --status                    # where the pass stands
 *   bun db/reembed.ts --url … --dry-run                   # what a run would do; writes nothing
 *   bun db/reembed.ts --url … --switch-model              # required when the model differs from ob1_config
 *   bun db/reembed.ts --url … --job reembed:x@1024:ctx    # a backfill under the same model
 *   bun db/reembed.ts --url … --retry-failed              # put this job's failed rows back in the pool first
 *   --workers N (2)   --batch N (8)   --ttl SECONDS (900)
 *
 * The model, width and provider come from the same variables the server reads —
 * OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM, OB1_EMBEDDING_DIMENSIONS,
 * OB1_LLM_BASE_URL, OB1_LLM_API_KEY, OB1_CHUNK_TOKENS, OB1_CHUNK_OVERLAP,
 * OB1_CHUNK_CONTEXT, OB1_METADATA_MODEL — resolved by the same function.
 *
 * ── Changing model: what this does and does not cover ──────────────────────
 * SAME WIDTH ONLY. `thoughts.embedding` is vector(N) and N is baked into the
 * column, the chunk column, the HNSW indexes and the function signatures. This
 * tool refuses a configured width that differs from the column's, because a
 * width change is a schema migration that does not exist yet, not a re-embed.
 *
 * When the configured model differs from the one ob1_config records, the run
 * needs --switch-model, and the FIRST thing it does is record the new model in
 * ob1_config. From that moment preflight accepts a server configured for the
 * new model, and the server should be switched: a capture made with the old
 * model after the switch is re-embedded by this pass only if it lands in the
 * pool — which a re-run adds — while a capture made with the new model is
 * re-embedded harmlessly. Until the pass finishes, searches mix vectors from
 * two models, and rank accordingly. That is inherent to changing model on a
 * live corpus; the alternative, stopping the server for the duration, is the
 * operator's call. `--status` says how far along the pass is.
 *
 * ── What the audit log sees ─────────────────────────────────────────────────
 * Nothing, for a row that already had a vector. update_thought fires 008's
 * trigger, and that trigger diffs the embedding's PRESENCE rather than its
 * value — a vector replaced by another vector is `{}` and `{}` is not an event
 * — so a full re-embed does not double thought_audit. A row that had NO vector
 * (the 2-argument fallback's shape) gains one and is audited as such, with this
 * tool as the actor. The per-thought record of the pass is the claim row.
 * db/test-live.ts [9] asserts both counts.
 *
 * Every re-embedded row's `updated_at` moves, because the row was updated. A
 * client holding an `if_unchanged_since` from before the pass gets STALE_READ
 * on its next edit, once, and refetches — the behaviour that guard exists for.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * A thought the provider cannot embed is marked failed with the error and the
 * pass continues; the run exits 1 if any row is failed at the end and says
 * which. Failed rows are terminal — a re-run does not retry them — until
 * --retry-failed returns them to the pool. A thought edited between the claim
 * and the write is re-read and re-embedded (update_thought's if_unchanged_since
 * guard reports the race rather than letting the stale vector win); one deleted
 * mid-pass is skipped, its claim row gone with it.
 */

import { SQL } from "bun";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embeddingConfigWarnings,
  validateEmbeddingConfig,
} from "./config.mjs";
import { createEmbedder, resolveEmbedConfig } from "../server-portable/embed.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const numberFlag = (name: string, fallback: number, min: number): number => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name} must be an integer >= ${min}, got "${raw}"`);
    process.exit(2);
  }
  return n;
};

const url = flag("url") ?? process.env.DATABASE_URL;
if (!url) {
  console.error("No database URL. Pass --url or set DATABASE_URL.");
  process.exit(2);
}

const WORKERS = numberFlag("workers", 2, 1);
const BATCH = numberFlag("batch", 8, 1);
const TTL = numberFlag("ttl", 900, 1);
const STATUS_ONLY = has("status");
const DRY_RUN = has("dry-run");
const SWITCH_MODEL = has("switch-model");
const RETRY_FAILED = has("retry-failed");
/** The pass and its target. See migration 015's header on why the target is in the key. */
const JOB = flag("job") ?? `reembed:${EMBEDDING_MODEL}@${EMBEDDING_DIM}`;

// ── Configuration ───────────────────────────────────────────────────────────

const problems = validateEmbeddingConfig();
if (problems.length > 0) {
  console.error("Embedding configuration is not usable:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(2);
}
for (const w of embeddingConfigWarnings()) console.error(`  ⚠  ${w}`);

const embedConfig = resolveEmbedConfig(process.env);
const embedder = createEmbedder(() => embedConfig);

console.log(`  job:       ${JOB}`);
console.log(`  embedding: ${embedConfig.embeddingModel} @ ${embedConfig.embeddingDim} dimensions, via ${embedConfig.llmBase}`);
console.log(`  chunks:    ${embedConfig.chunkTokens} tokens, overlap ${embedConfig.chunkOverlap}, context ${embedConfig.chunkContext ? "on" : "off"}`);

const sql = new SQL({ url, max: WORKERS + 1 });

// ── The database's side of the contract ─────────────────────────────────────

const [claims] = await sql`SELECT to_regclass('thought_work_claims') IS NOT NULL AS present`;
if (!claims.present) {
  console.error("\n  thought_work_claims does not exist. Apply migration 015 first:\n    cd db && bun migrate.ts --url …");
  await sql.close();
  process.exit(2);
}

const [col] = await sql`
  SELECT atttypmod AS width FROM pg_attribute
  WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding'`;
if (Number(col?.width) !== embedConfig.embeddingDim) {
  console.error(
    `\n  thoughts.embedding is vector(${col?.width}) but OB1_EMBEDDING_DIM=${embedConfig.embeddingDim}.\n` +
      `  This tool re-embeds at the column's width. A width change is a schema migration —\n` +
      `  the column, thought_chunks.embedding, both HNSW indexes and every function that\n` +
      `  names vector(${col?.width}) — and no migration for it exists yet. Set OB1_EMBEDDING_DIM=${col?.width}\n` +
      `  (with OB1_EMBEDDING_DIMENSIONS=on for a model that is wider natively) or stop here.`
  );
  await sql.close();
  process.exit(2);
}

const recorded = Object.fromEntries(
  ((await sql`SELECT key, value FROM ob1_config WHERE key IN ('embedding_model', 'embedding_dim')`) as { key: string; value: string }[])
    .map((r) => [r.key, r.value])
);
const modelChange = recorded.embedding_model !== undefined && recorded.embedding_model !== embedConfig.embeddingModel;
if (recorded.embedding_model === undefined) {
  console.log(`  ob1_config records no embedding model (migration 006 not applied?); the pass will record ${embedConfig.embeddingModel}`);
} else if (modelChange) {
  console.log(`  model change: ob1_config records ${recorded.embedding_model}; this pass embeds with ${embedConfig.embeddingModel}`);
} else {
  console.log(`  same model as ob1_config records — a backfill, not a model change`);
}
if (modelChange && !SWITCH_MODEL && !STATUS_ONLY && !DRY_RUN) {
  console.error(
    `\n  Refusing to re-embed with a model other than the one ob1_config records without --switch-model.\n` +
      `  Every vector in the corpus would be replaced by ${embedConfig.embeddingModel}'s, and ob1_config\n` +
      `  would be updated so preflight accepts a server configured for it. If that is the intent:\n` +
      `    OB1_EMBEDDING_MODEL=${embedConfig.embeddingModel} bun db/reembed.ts --url … --switch-model\n` +
      `  If OB1_EMBEDDING_MODEL is simply set wrong in this shell, fix it instead.`
  );
  await sql.close();
  process.exit(2);
}

// ── Where the pass stands ───────────────────────────────────────────────────

type Counts = { pending: number; claimed: number; succeeded: number; failed: number; unpooled: number; thoughts: number };
async function counts(): Promise<Counts> {
  const rows = (await sql`
    SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const [{ unpooled, thoughts }] = await sql`
    SELECT count(*)::int AS thoughts,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}))::int AS unpooled
    FROM thoughts t`;
  return {
    pending: by.pending ?? 0,
    claimed: by.claimed ?? 0,
    succeeded: by.succeeded ?? 0,
    failed: by.failed ?? 0,
    unpooled: Number(unpooled),
    thoughts: Number(thoughts),
  };
}

function printCounts(c: Counts, label: string): void {
  console.log(
    `  ${label}: ${c.thoughts} thoughts — ${c.succeeded} succeeded, ${c.failed} failed, ` +
      `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool`
  );
}

async function printFailures(limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, attempt_count, worker_id, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
    { thought_id: string; attempt_count: number; worker_id: string | null; last_error: string | null }[];
  for (const r of rows) {
    console.error(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
  }
}

if (STATUS_ONLY || DRY_RUN) {
  const c = await counts();
  printCounts(c, STATUS_ONLY ? "status" : "before");
  if (c.claimed > 0) {
    const leases = (await sql`
      SELECT worker_id, count(*)::int AS c, min(ttl_expires_at)::text AS first_expiry
      FROM thought_work_claims WHERE work_type = ${JOB} AND status = 'claimed' GROUP BY worker_id`) as
      { worker_id: string; c: number; first_expiry: string }[];
    for (const l of leases) console.log(`    held by ${l.worker_id}: ${l.c} rows, earliest lease expiry ${l.first_expiry}`);
  }
  if (c.failed > 0) {
    console.error(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
    await printFailures();
  }
  if (DRY_RUN) {
    console.log(
      `\n  would: ${modelChange ? `record ${embedConfig.embeddingModel} in ob1_config; ` : ""}` +
        `${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
        `add ${c.unpooled} thoughts to the pool; run ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases, ` +
        `over ${c.pending + c.unpooled + (RETRY_FAILED ? c.failed : 0)} rows. Nothing was written.`
    );
  }
  await sql.close();
  process.exit(0);
}

// ── The run ─────────────────────────────────────────────────────────────────

// The provider first, so a wrong URL or a wrong width fails before any row is
// touched — the width check inside getEmbedding names the model and both widths.
try {
  await embedder.getEmbedding("reembed.ts provider probe");
} catch (e) {
  console.error(`\n  The embedding provider is not usable: ${(e as Error).message}`);
  await sql.close();
  process.exit(2);
}

if (modelChange || recorded.embedding_model === undefined) {
  await sql`
    INSERT INTO ob1_config (key, value) VALUES ('embedding_model', ${embedConfig.embeddingModel})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  console.log(`  ob1_config.embedding_model = ${embedConfig.embeddingModel} — a server configured for it now passes preflight; switch it.`);
}

if (RETRY_FAILED) {
  const [{ n }] = await sql`
    WITH retried AS (
      UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
      WHERE work_type = ${JOB} AND status = 'failed' RETURNING 1)
    SELECT count(*)::int AS n FROM retried`;
  console.log(`  --retry-failed: ${n} failed row(s) returned to the pool`);
}

const [{ added }] = await sql`SELECT enqueue_thoughts(${JOB}) AS added`;
const before = await counts();
console.log(`  pool: ${added} thought(s) added`);
printCounts(before, "before");

const total = before.pending + before.claimed;
if (total === 0) {
  console.log("\n  Nothing to do.");
  if (before.failed > 0) {
    console.error(`  ${before.failed} failed row(s) remain from an earlier run — pass --retry-failed to try them again:`);
    await printFailures();
    await sql.close();
    process.exit(1);
  }
  await sql.close();
  process.exit(0);
}

const toVector = (v: number[]) => `[${v.join(",")}]`;
const actor = { name: "reembed", source: "db/reembed.ts", session: JOB };

let stopping = false;
let done = 0;
let failed = 0;
let vanished = 0;
/** Long thoughts stored with the head window's vector because the whole-content call failed. */
let headWindow = 0;
/** Worker ids with leases possibly outstanding, for a forced exit. */
const activeWorkers = new Set<string>();
const started = Date.now();
const lastReport = { at: 0 };

function progress(force = false): void {
  const now = Date.now();
  if (!force && now - lastReport.at < 2000) return;
  lastReport.at = now;
  const elapsed = (now - started) / 1000;
  const rate = done / Math.max(elapsed, 0.001);
  const remaining = Math.max(total - done - failed, 0);
  const eta = rate > 0 ? Math.round(remaining / rate) : null;
  console.log(
    `  ${done + failed}/${total}  ${rate.toFixed(1)}/s` +
      (failed ? `  ${failed} failed` : "") +
      (eta !== null ? `  ~${eta}s left` : "")
  );
}

type Row = { id: string; content: string; updated_at: Date };

/**
 * Embed and write one thought. Returns "succeeded", "failed" with an error, or
 * "vanished" when the thought was deleted after it was claimed.
 */
async function processRow(row: Row): Promise<{ outcome: "succeeded" } | { outcome: "failed"; error: string } | { outcome: "vanished" }> {
  let current = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const embedded = await embedder.embedCapture(current.content);
    if (embedded.wholeContentFellBack) headWindow++;
    // The server stores a bare window and tells the caller; here there is no
    // caller, and a terminal claim cannot be re-run. So it is a failure, which
    // --retry-failed can revisit once the metadata model behaves.
    if (embedConfig.chunkContext && embedded.contextFailures > 0) {
      return {
        outcome: "failed",
        error: `${embedded.contextFailures} of ${embedded.chunks.length} windows embedded without context — the blurb call failed or its answer was unusable; fix the metadata model, then --retry-failed`,
      };
    }
    const chunks = embedded.chunks.map((c) => ({ content: c.content, embedding: toVector(c.embedding), context: c.context ?? null }));
    const [r] = await sql`
      SELECT update_thought(
        ${current.id}::uuid,
        ${current.content}::text,
        NULL::jsonb,
        ${toVector(embedded.embedding)}::vector,
        ${chunks.length ? chunks : null}::jsonb,
        ${current.updated_at}::timestamptz,
        ${actor}::jsonb
      ) AS r`;
    const result = r.r as { ok: boolean; error?: string };
    if (result.ok) return { outcome: "succeeded" };
    if (result.error === "NOT_FOUND") return { outcome: "vanished" };
    if (result.error === "STALE_READ") {
      // Edited between the claim and the write. Re-read and embed what is there
      // now; the guard exists so the stale vector never wins.
      const [fresh] = (await sql`SELECT id, content, updated_at FROM thoughts WHERE id = ${current.id}::uuid`) as Row[];
      if (!fresh) return { outcome: "vanished" };
      current = fresh;
      continue;
    }
    if (result.error === "DUPLICATE_CONTENT") {
      // The content is unchanged, so this can only be another thought that
      // normalises to the same text: a duplicate from before migration 003's
      // fingerprint, or a bulk load that bypassed upsert_thought. Re-embedding
      // the first of the pair gave it a fingerprint; the second now collides.
      return {
        outcome: "failed",
        error: "update_thought: DUPLICATE_CONTENT — another thought normalises to the same text (a duplicate that predates the fingerprint, or was loaded around upsert_thought); remove one of the pair, then --retry-failed",
      };
    }
    return { outcome: "failed", error: `update_thought: ${result.error}` };
  }
  return { outcome: "failed", error: "update_thought: STALE_READ three times in a row — the thought is being edited faster than it can be re-embedded" };
}

async function worker(n: number): Promise<void> {
  // Globally unique: release_claims_for_worker matches on this alone, and a
  // bare pid collides across containers.
  const workerId = `reembed-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
  activeWorkers.add(workerId);
  try {
    while (!stopping) {
      let batch: { thought_id: string; attempt: number }[];
      let byId: Map<string, Row>;
      try {
        batch = (await sql`
          SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${BATCH}, ${TTL})`) as { thought_id: string; attempt: number }[];
        if (batch.length === 0) return;
        const ids = batch.map((b) => b.thought_id);
        const rows = (await sql`
          SELECT id, content, updated_at FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
        byId = new Map(rows.map((r) => [r.id, r]));
      } catch (e) {
        // A database error here is not about one thought. This worker stops;
        // the others carry on, and the finally below hands back what it holds.
        console.error(`  ${workerId}: ${(e as Error).message} — this worker stops`);
        return;
      }
      for (const b of batch) {
        if (stopping) return;
        const row = byId.get(b.thought_id);
        if (b.attempt > 1) console.error(`  ${b.thought_id}: attempt ${b.attempt} — an earlier worker's lease expired on it`);
        let outcome: Awaited<ReturnType<typeof processRow>>;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          try {
            outcome = await processRow(row);
          } catch (e) {
            outcome = { outcome: "failed", error: (e as Error).message.slice(0, 500) };
          }
        }
        if (outcome.outcome === "vanished") {
          // The claim row cascaded away with the thought; there is nothing to
          // release. Count it so the summary adds up.
          vanished++;
          continue;
        }
        let ok: boolean;
        try {
          [{ ok }] = await sql`
            SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                   ${outcome.outcome}, ${outcome.outcome === "failed" ? outcome.error : null}) AS ok`;
        } catch (e) {
          // The write to `thoughts`, if there was one, stands. The claim stays
          // this worker's until the finally below returns it to the pool, and
          // the row is then done again — the same vector twice, harmless.
          console.error(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
          return;
        }
        if (!ok) {
          // The lease expired and another worker holds the row now; its write
          // will stand and ours already did — the same vector twice, harmless.
          console.error(`  ${b.thought_id}: lease expired before release — another worker will repeat it (raise --ttl or lower --batch)`);
        }
        if (outcome.outcome === "failed") {
          failed++;
          console.error(`  ${b.thought_id}: ${outcome.error}`);
        } else {
          done++;
        }
        progress();
      }
    }
  } finally {
    // Unconditionally: a worker that stops for any reason — an empty pool, a
    // signal, a database error — must not leave its leases to expire. Normally
    // there is nothing to return and this is one cheap statement.
    try {
      const [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      if (freed > 0) console.error(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    } catch (e) {
      console.error(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s`);
    }
    activeWorkers.delete(workerId);
  }
}

const stop = () => {
  if (stopping) {
    // A second signal while a provider call hangs: the workers cannot reach
    // their own finally, so return their leases from here, best effort and
    // bounded, then leave.
    console.error(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
    const hardStop = setTimeout(() => process.exit(130), 3000);
    void Promise.all(
      [...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null))
    ).finally(() => {
      clearTimeout(hardStop);
      process.exit(130);
    });
    return;
  }
  stopping = true;
  console.error("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases\n`);
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
progress(true);

const after = await counts();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n  ${done} re-embedded, ${failed} failed, ${vanished} deleted mid-pass, in ${elapsed}s`);
printCounts(after, "after");
if (headWindow > 0) {
  console.error(
    `\n  ${headWindow} long thought(s) stored with the head window's vector: the whole-content embedding was refused or\n` +
      `  failed (see above). They are recorded succeeded, as the server would record them; to try again, clear their\n` +
      `  claim rows or re-capture them.`
  );
}
if (after.failed > 0) {
  console.error(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
  await printFailures();
}
if (after.claimed > 0) {
  console.error(
    `\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed.\n` +
      `  They return to the pool when their leases expire (within ${TTL} s of being taken); re-run then, or watch --status.`
  );
}
await sql.close();
process.exit(stopping ? 130 : after.failed > 0 || after.claimed > 0 ? 1 : 0);
