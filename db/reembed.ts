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
 *   bun db/reembed.ts --url … --retry-fallbacks           # …and the rows stored with a head window (see Failure policy)
 *   --workers N (2)   --batch N (8)   --ttl SECONDS (900, or --batch × OB1_LLM_TIMEOUT when that is longer)
 *
 * The model, width and provider come from the same variables the server reads —
 * OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM, OB1_EMBEDDING_DIMENSIONS,
 * OB1_LLM_BASE_URL, OB1_LLM_API_KEY, OB1_LLM_TIMEOUT, OB1_CHUNK_TOKENS,
 * OB1_CHUNK_OVERLAP, OB1_CHUNK_CONTEXT, OB1_METADATA_MODEL — resolved by the
 * same function.
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
 * ── Duplicates from before the fingerprint ──────────────────────────────────
 * Migration 003 added content_fingerprint without a backfill, so a brain that
 * predates it can hold two rows that normalise to the same text, both with
 * NULL fingerprints; a load that inserted into `thoughts` directly leaves the
 * same state. Re-embedding the first of such a pair gives it a fingerprint,
 * and until migration 018 update_thought then refused the second's own text as
 * DUPLICATE_CONTENT — failed, exit 1, and --retry-failed reproduced it for
 * ever (SMD-1022). 018 accepts an edit whose text normalises to what the row
 * holds, leaves that row's fingerprint NULL so the unique index is never
 * violated, and names the other row in its result. A run requires 018 (the
 * read-only --status and --dry-run do not), says per row when it found a pair,
 * and prints every group of thoughts sharing one normalised text at the end
 * and under --status — one query over the corpus hashing only the rows without
 * a fingerprint, so it stays cheap for a probe that is asked repeatedly (it
 * needs 016's function and says so on an older schema). --dry-run reports the
 * 018 refusal a run would make instead of the worker plan. Whether a pair should be one thought is the
 * operator's call; nothing is written to the claim row about it. 018's lock
 * serialises edits only: a capture of the same text committing while a worker
 * fingerprints a legacy row still raises the unique violation, which lands as
 * a failed claim naming the constraint, and --retry-failed resolves it.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * A thought the provider cannot embed is marked failed with the error and the
 * pass continues; the run exits 1 if any row is failed, still leased or still
 * pending at the end, and says which. Failed rows are terminal — a re-run does
 * not retry them — until --retry-failed returns them to the pool. A thought
 * edited between the claim and the write is re-read and re-embedded
 * (update_thought's if_unchanged_since guard reports the race rather than
 * letting the stale vector win); one deleted mid-pass is skipped, its claim row
 * gone with it.
 *
 * Whatever was embedded is always written before the outcome is decided, since
 * under --switch-model the vector already in the row is another model's. Then:
 * a long thought whose whole-content call failed transiently (429, 5xx, a lost
 * connection, the timeout) has its head window stored and its claim marked
 * failed, so --retry-failed tries the whole content again; a window whose blurb
 * failed under OB1_CHUNK_CONTEXT=on is stored bare and the claim marked failed.
 *
 * ── The head window, recorded ───────────────────────────────────────────────
 * A long thought the provider REFUSED to embed whole (400 or 413 — hosted APIs
 * refuse over-length input where Ollama truncates it) has the head window's
 * vector stored, as a capture would have stored it, and its claim is succeeded:
 * the write happened and that vector is the provider's final answer. It is not
 * silent. The claim row's last_error carries the caveat, and the rule is
 * general: A SUCCEEDED ROW'S last_error, WHEN SET, IS WHAT THE WORKER COULD
 * NOT DO — the write stands, and this is what it fell short of. --status and
 * the end of a run count and list them; --retry-fallbacks returns them to the
 * pool, for the day the provider or its input limit changes (against the same
 * provider each is refused again and re-recorded, harmless). Until SMD-1021
 * such a row was indistinguishable from any other succeeded row, one line in a
 * summary was the only trace, and a terminal claim meant no re-run would ever
 * look at it again.
 *
 * For that to be a fact about THE ROW, the pass asks every long thought itself:
 * its embedder does not remember a refusal the way the server's does (one
 * probe per process on the interactive path), because a 413 is about that
 * input's length and a shorter long thought may well be accepted. One refused
 * round trip per long row, answered before any embedding is computed.
 *
 * Every provider call is bounded by OB1_LLM_TIMEOUT (120 s by default). A call
 * that never returns fails the row with the timeout named — or, on the
 * whole-content call, falls back as transient — instead of parking the worker
 * until the second signal. The lease is stamped per batch and has to outlast
 * the batch's worst case, every call running to the timeout: one phase of
 * concurrent calls per row with context off, two (blurbs, then embeddings)
 * with it on. The defaults alone do not fit (8 rows × 120 s > 900 s), so the
 * default lease grows to that product plus one row's worth of slack — for the
 * re-read a concurrent edit costs — when that is longer, and an explicit --ttl
 * below the product is refused (a run or --dry-run; --status never claims and
 * answers regardless) — a batch that outlives its lease is reaped mid-way and
 * handed to another worker, and three such expiries mark a row failed although
 * every write succeeded. The arithmetic is a stand-in for per-row lease
 * renewal (SMD-1023).
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
import { createEmbedder, PROVIDER_ERROR_CHARS, resolveEmbedConfig } from "../server-portable/embed.ts";

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
const STATUS_ONLY = has("status");
const DRY_RUN = has("dry-run");
const SWITCH_MODEL = has("switch-model");
const RETRY_FAILED = has("retry-failed");
const RETRY_FALLBACKS = has("retry-fallbacks");
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
// Not remembering a refusal: see "The head window, recorded" in the header.
const embedder = createEmbedder(() => embedConfig, { rememberRefusal: false });

// The lease must outlast a batch whose every call runs to the timeout — see
// the header. Seconds, as the flag is, and whole ones: claim_thoughts takes an
// int, and OB1_LLM_TIMEOUT=120.3 is legal. The floor is the certain worst case
// for one embed per row; the default adds one row's worth of slack for the
// re-read a concurrent edit costs (processRow retries up to three times), and
// says so. Per-row lease renewal (SMD-1023) would retire this arithmetic.
const PHASES = embedConfig.chunkContext ? 2 : 1;
const PER_ROW_S = PHASES * (embedConfig.timeoutMs / 1000);
const LEASE_FLOOR = Math.ceil(BATCH * PER_ROW_S);
const TTL = flag("ttl") === undefined ? Math.max(900, Math.ceil(LEASE_FLOOR + PER_ROW_S)) : numberFlag("ttl", 900, 1);
// Read-only modes never claim, so they answer whatever the lease; --dry-run
// reports the refusal a run would make, alongside the 018 check below.
const refusalTtl: string | null = TTL >= LEASE_FLOOR
  ? null
  : ` --ttl ${TTL} s cannot cover --batch ${BATCH} × ${embedConfig.chunkContext ? "two phases × " : ""}${embedConfig.timeoutMs / 1000} s per call (${LEASE_FLOOR} s), which is what a batch\n` +
    `  takes when every call runs to OB1_LLM_TIMEOUT. A batch that outlives its lease is reaped mid-way and repeated by another\n` +
    `  worker, and three expiries mark a row failed although every write succeeded. Raise --ttl or lower --batch.`;

console.log(`  job:       ${JOB}`);
console.log(`  embedding: ${embedConfig.embeddingModel} @ ${embedConfig.embeddingDim} dimensions, via ${embedConfig.llmBase}, ${embedConfig.timeoutMs / 1000} s per call`);
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

// A pass against 013's update_thought fails every legacy twin for ever (see the
// header). The body the pass will CALL — the exact 7-argument signature, as
// preflight resolves match_thoughts, not any function of that name — is asked
// for 018's contract sentinel: a marker in pg_proc.prosrc, which every CREATE
// OR REPLACE rewrites, rather than a field name a comment could carry. The
// ledger decides the remedy: a brain adopted with --baseline records 018 as
// applied while the body is 013's, and "apply 018" would be a no-op there.
// Read here so --dry-run can report the refusal a run would make; --status is
// answered whatever the body, since it never calls update_thought.
const [fn] = await sql`
  SELECT
    EXISTS (SELECT 1 FROM pg_proc
            WHERE oid = to_regprocedure('public.update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')
              AND prosrc LIKE '%ob1:unchanged-edit-not-duplicate%') AS present,
    (to_regclass('schema_migrations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM schema_migrations WHERE name LIKE '018%')) AS ledgered`;
const refusal018: string | null = fn.present
  ? null
  : " update_thought predates migration 018: a thought whose text another thought also holds — a pair from before\n" +
    "  the fingerprint — would fail this pass on every run. " +
    (fn.ledgered
      ? "schema_migrations records 018 as applied (--baseline?) but the body\n  installed is older: re-run the body of db/migrations/018_update_thought_unchanged_content.sql (the migrator will\n  skip it as applied), substituting {{EMBEDDING_DIM}}."
      : "Apply migration 018 first:\n    cd db && bun migrate.ts --url …");

// ── Where the pass stands ───────────────────────────────────────────────────

/**
 * The caveat rule as a predicate — see "The head window, recorded" in the
 * header. One definition for the count, the list and --retry-fallbacks, so the
 * three cannot disagree about which rows carry a caveat.
 */
const withCaveat = () => sql`status = 'succeeded' AND last_error IS NOT NULL`;

type Counts = { pending: number; claimed: number; succeeded: number; fellBack: number; failed: number; unpooled: number; thoughts: number };
async function counts(): Promise<Counts> {
  // One statement, so the caveat count is a subset of the succeeded count it
  // qualifies — --status is asked while workers release rows.
  const rows = (await sql`
    SELECT status, count(*)::int AS c, count(*) FILTER (WHERE last_error IS NOT NULL)::int AS noted
    FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number; noted: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const fellBack = Number(rows.find((r) => r.status === "succeeded")?.noted ?? 0);
  const [{ unpooled, thoughts }] = await sql`
    SELECT count(*)::int AS thoughts,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}))::int AS unpooled
    FROM thoughts t`;
  return {
    pending: by.pending ?? 0,
    claimed: by.claimed ?? 0,
    succeeded: by.succeeded ?? 0,
    fellBack: Number(fellBack),
    failed: by.failed ?? 0,
    unpooled: Number(unpooled),
    thoughts: Number(thoughts),
  };
}

function printCounts(c: Counts, label: string): void {
  console.log(
    `  ${label}: ${c.thoughts} thoughts — ${c.succeeded} succeeded${c.fellBack ? ` (${c.fellBack} with the head window)` : ""}, ${c.failed} failed, ` +
      `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool`
  );
}

/**
 * The succeeded rows that carry a caveat: long thoughts stored with the head
 * window's vector because the provider refused the whole content. Listed from
 * the record, not from a counter, so --status and the end of a run agree
 * whichever process did the work.
 */
async function printFallbacks(total: number, limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND ${withCaveat()}
    ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; last_error: string }[];
  console.error(
    `\n  ${total} long thought(s) stored with the head window's vector (${Math.min(total, limit)} of ${total} listed): the provider refused\n` +
      `  to embed them whole, so this is the vector a capture would have stored too. They are succeeded, with the refusal on the\n` +
      `  claim row. --retry-fallbacks returns them to the pool once the provider, or its input limit, has changed.`
  );
  for (const r of rows) console.error(`    ${r.thought_id}  ${r.last_error}`);
}

/**
 * Groups of thoughts that normalise to one text: pairs from before migration
 * 003's fingerprint, or a load that bypassed upsert_thought. One query over
 * the corpus that hashes only the rows whose fingerprint column is NULL and
 * groups them with the fingerprinted rows through the column — so it finds
 * NULL/NULL pairs before a pass and NULL/fingerprinted pairs after, and costs
 * little once a pass has fingerprinted the corpus. It runs under --status,
 * which is asked repeatedly during a pass, so it must stay cheap: hashing
 * every row's text would catch a row whose column carries a STALE key as well,
 * but that row is reported by the pass itself (fingerprint_held_by) when it
 * blocks another row, and nothing here needs to find it twice. Prints nothing
 * when there are none. Needs 016's content_fingerprint_of; on an older schema
 * it says so and returns.
 */
async function printDuplicateGroups(limit = 10): Promise<number> {
  const [{ present }] = await sql`SELECT to_regprocedure('content_fingerprint_of(text)') IS NOT NULL AS present`;
  if (!present) {
    console.error("  (the duplicate report needs migration 016's content_fingerprint_of — not applied here)");
    return 0;
  }
  const rows = (await sql`
    SELECT count(*) OVER ()::int AS total, array_agg(id ORDER BY created_at, id)::text[] AS ids
    FROM thoughts
    GROUP BY COALESCE(content_fingerprint, content_fingerprint_of(content))
    HAVING count(*) > 1
    ORDER BY min(created_at)
    LIMIT ${limit}`) as { total: number; ids: string[] }[];
  if (!rows.length) return 0;
  const total = Number(rows[0].total);
  console.error(
    `\n  ${total} group(s) of thoughts share one normalised text — pairs from before migration 003's fingerprint, or a load that\n` +
      `  bypassed upsert_thought. Every row in a group is re-embedded; only one carries the fingerprint, so a later capture of that\n` +
      `  text merges into it and not into the others. Whether they should be one thought is the operator's call — delete_thought\n` +
      `  on the extra keeps its text in the audit row. ${total > limit ? `First ${limit}:` : ""}`
  );
  for (const r of rows) console.error(`    ${r.ids.join("  =  ")}`);
  return total;
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
  if (c.fellBack > 0) await printFallbacks(c.fellBack);
  await printDuplicateGroups();
  if (DRY_RUN) {
    const refusal = refusalTtl ?? refusal018;
    if (refusal) {
      console.error(`\n  would: refuse.${refusal}`);
      await sql.close();
      process.exit(2);
    }
    console.log(
      `\n  would: ${modelChange ? `record ${embedConfig.embeddingModel} in ob1_config; ` : ""}` +
        `${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
        `${RETRY_FALLBACKS ? `return ${c.fellBack} rows stored with the head window to the pool; ` : ""}` +
        `add ${c.unpooled} thoughts to the pool; run ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases, ` +
        `over ${c.pending + c.unpooled + (RETRY_FAILED ? c.failed : 0) + (RETRY_FALLBACKS ? c.fellBack : 0)} rows. Nothing was written.`
    );
  }
  await sql.close();
  process.exit(0);
}

// ── The run ─────────────────────────────────────────────────────────────────

{
  const refusal = refusalTtl ?? refusal018;
  if (refusal) {
    console.error(`\n ${refusal}`);
    await sql.close();
    process.exit(2);
  }
}

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

/**
 * Return the rows a predicate selects to the pool as if never tried: pending,
 * nothing known about them, attempt count reset — the next worker writes what
 * it finds. A terminal row's error or caveat goes with its status.
 */
async function requeue(where: ReturnType<typeof withCaveat>, label: string, what: string): Promise<void> {
  const [{ n }] = await sql`
    WITH retried AS (
      UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
      WHERE work_type = ${JOB} AND ${where} RETURNING 1)
    SELECT count(*)::int AS n FROM retried`;
  console.log(`  --${label}: ${n} ${what} returned to the pool`);
}
if (RETRY_FAILED) await requeue(sql`status = 'failed'`, "retry-failed", "failed row(s)");
if (RETRY_FALLBACKS) await requeue(withCaveat(), "retry-fallbacks", "row(s) stored with the head window");

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

/**
 * `updated_at` is `COALESCE(updated_at, created_at)` — the expression
 * update_thought's guard compares against. Migration 001 leaves the column
 * nullable, and a row loaded around upsert_thought can carry NULL there; passing
 * that NULL as `p_if_unchanged_since` would disable the guard and let this pass
 * write a concurrent edit back to its old text.
 */
type Row = { id: string; content: string; updated_at: Date };

/**
 * Embed and write one thought. Returns "succeeded" — with a caveat when the
 * write fell short of what was asked and the row should say so — "failed" with
 * an error, or "vanished" when the thought was deleted after it was claimed.
 */
type Outcome = { outcome: "succeeded"; caveat?: string } | { outcome: "failed"; error: string } | { outcome: "vanished" };
async function processRow(row: Row): Promise<Outcome> {
  let current = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const embedded = await embedder.embedCapture(current.content);
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
    const result = r.r as { ok: boolean; error?: string; duplicate_of?: string; fingerprint_held_by?: string };
    if (result.ok) {
      // The write is done in every case below: whatever was embedded is better
      // than the vector the row had, and under --switch-model the old one is
      // from another model. What differs is whether the claim may go terminal.
      // Two things 018 reports are not outcomes — nothing about this row's
      // vectors is in doubt — and are said once per row here.
      if (result.duplicate_of) {
        // The row's own text is also another thought's — a pair from before the
        // fingerprint. The summary lists the groups from the corpus, so that
        // count is the authoritative one (a pair's first row is never reported
        // here — nothing owned its text yet).
        console.error(`  ${current.id}: duplicates ${result.duplicate_of} — the same text, which deduplication could not see because this row had no fingerprint; re-embedded, see the summary`);
      } else if (result.fingerprint_held_by) {
        // Another row carries this text's key under DIFFERENT text — a stale
        // fingerprint from a raw update around update_thought — so this row
        // could not take the fingerprint it should have. The key is the other
        // row's problem, and re-saving its own text fixes it.
        console.error(`  ${current.id}: could not take its fingerprint — ${result.fingerprint_held_by} holds that key under other text (a stale fingerprint; re-saving that thought's own text corrects it)`);
      }
      // Everything the row should say about itself is collected before the
      // outcome is chosen, so a row with two things wrong records both: a
      // refusal is not lost behind a blurb failure, nor a blurb failure behind
      // a transient fallback.
      //
      // Refused outright: the head window is the provider's final answer for
      // this input, as it would be for a capture, and the row says so — as a
      // caveat on success, or appended to a failure. See "The head window,
      // recorded" in the header.
      const refused = embedded.wholeContentFellBack && embedded.wholeContentRefused
        ? `whole-content embedding refused by the provider (${embedded.wholeContentError ?? "no detail"}); the head window's vector is stored, as a capture would have stored it — --retry-fallbacks once the provider or its input limit changes`
        : null;
      const failures: string[] = [];
      if (embedded.wholeContentFellBack && !embedded.wholeContentRefused) {
        // The whole-content call failed for a reason that says nothing about
        // the next attempt — a 429, a 5xx, a dropped connection, the timeout —
        // so the head window is in the row and the claim is retryable rather
        // than final.
        failures.push(`whole-content embedding failed transiently (${embedded.wholeContentError ?? "no detail"}) and the head window's vector was stored — --retry-failed will try the whole content again`);
      }
      // The server stores a bare window and tells the caller; here there is no
      // caller, and a terminal claim cannot be re-run. So the new vectors are
      // written, bare, and the claim is a failure --retry-failed can revisit
      // once the metadata model behaves.
      if (embedConfig.chunkContext && embedded.contextFailures > 0) {
        // With the reasons, distinct: a metadata model slower than
        // OB1_LLM_TIMEOUT is told apart from one that answers badly.
        failures.push(`${embedded.contextFailures} of ${embedded.chunks.length} windows were embedded without context (${embedded.contextErrors.join("; ") || "no detail"}); the bare vectors are stored; fix the cause, then --retry-failed`);
      }
      if (failures.length) return { outcome: "failed", error: [...failures, ...(refused ? [refused] : [])].join("; also: ") };
      return refused ? { outcome: "succeeded", caveat: refused } : { outcome: "succeeded" };
    }
    if (result.error === "NOT_FOUND") return { outcome: "vanished" };
    if (result.error === "STALE_READ" || result.error === "DUPLICATE_CONTENT") {
      // Edited between the claim and the write. Re-read and embed what is there
      // now; the guard exists so the stale vector never wins. DUPLICATE_CONTENT
      // is the same event seen through a gap in the guard: updated_at is the
      // editing transaction's start time at millisecond precision, so an edit
      // that began before this worker's read and committed after it passes
      // if_unchanged_since — and the text this worker holds is then no longer
      // the row's, so 018 judges it as a change into another row's text. The
      // re-read carries the current text and the next call is unchanged.
      const [fresh] = (await sql`SELECT id, content, COALESCE(updated_at, created_at) AS updated_at FROM thoughts WHERE id = ${current.id}::uuid`) as Row[];
      if (!fresh) return { outcome: "vanished" };
      current = fresh;
      continue;
    }
    // Anything else is reported as what it is. Not an error code at all: a
    // capture of the same text committing while this row is fingerprinted
    // (018's lock covers edits, not upsert_thought — SMD-1043) raises a unique
    // violation into the catch in worker(): failed with the constraint named,
    // and --retry-failed then finds the other row and reports duplicate_of.
    return { outcome: "failed", error: `update_thought: ${result.error}` };
  }
  return { outcome: "failed", error: "update_thought: STALE_READ or DUPLICATE_CONTENT three times in a row — the thought is being edited faster than it can be re-embedded; --retry-failed once it settles" };
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
          SELECT id, content, COALESCE(updated_at, created_at) AS updated_at FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
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
        let outcome: Outcome;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          try {
            outcome = await processRow(row);
          } catch (e) {
            outcome = { outcome: "failed", error: (e as Error).message.slice(0, PROVIDER_ERROR_CHARS) };
          }
        }
        if (outcome.outcome === "vanished") {
          // The claim row cascaded away with the thought; there is nothing to
          // release. Count it so the summary adds up.
          vanished++;
          continue;
        }
        let ok: boolean;
        let gone = false;
        try {
          // A succeeded row's last_error is its caveat — see the header.
          [{ ok }] = await sql`
            SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                   ${outcome.outcome}, ${outcome.outcome === "failed" ? outcome.error : outcome.caveat ?? null}) AS ok`;
          // False has two causes and only one of them is about the lease: the
          // thought may have been deleted between the write and this call, its
          // claim row cascading away with it.
          if (!ok) {
            const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM thoughts WHERE id = ${b.thought_id}::uuid) AS exists`;
            gone = !exists;
          }
        } catch (e) {
          // The write to `thoughts`, if there was one, stands. The claim stays
          // this worker's until the finally below returns it to the pool, and
          // the row is then done again — the same vector twice, harmless.
          console.error(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
          return;
        }
        if (gone) {
          vanished++;
          console.error(`  ${b.thought_id}: deleted while it was being re-embedded`);
          progress();
          continue;
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
          if (outcome.caveat) console.error(`  ${b.thought_id}: ${outcome.caveat}`);
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
    // A second signal while a worker is inside a call it cannot leave — a
    // provider call has OB1_LLM_TIMEOUT to answer, but a database call has
    // nothing — so the workers may not reach their own finally: return their
    // leases from here, best effort and bounded, then leave.
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
await printDuplicateGroups();
if (after.fellBack > 0) await printFallbacks(after.fellBack);
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
if (after.pending > 0 && !stopping) {
  // Every worker stopped before the pool was empty — a database error each
  // (their messages are above) — and handed its leases back. Not done.
  console.error(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
}
await sql.close();
process.exit(stopping ? 130 : after.failed > 0 || after.claimed > 0 || after.pending > 0 ? 1 : 0);
