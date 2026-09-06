#!/usr/bin/env bun
/**
 * extract-entities.ts — extract entities and relationships from every thought,
 * in parallel, resumably, and keep doing it for new ones.
 *
 * The second consumer of migration 015's lease table, and the worker for
 * migration 016's tables. Each thought goes to the metadata model once
 * (server-portable/entities.ts holds the prompt and the parsing rules) and the
 * result is written through `record_thought_entities`, which replaces the
 * thought's mentions and edges wholesale — so running this twice over an
 * unchanged corpus writes nothing new, and running it after an edit leaves only
 * what the new text says.
 *
 *   bun db/extract-entities.ts --url postgres://…             # the backlog, then exit
 *   bun db/extract-entities.ts --url … --follow [SECONDS]     # …then keep polling for new captures
 *   bun db/extract-entities.ts --url … --limit 25             # a trial: this many thoughts, then stop
 *   bun db/extract-entities.ts --url … --status               # where the pass stands, and what it has found
 *   bun db/extract-entities.ts --url … --dry-run              # what a run would do; writes nothing
 *   bun db/extract-entities.ts --url … --retry-failed         # failed rows back into the pool first
 *   bun db/extract-entities.ts --url … --dump answers.jsonl   # also append every model answer, for evals/eval-entities.ts --replay
 *   bun db/extract-entities.ts --url … --switch-key           # required when the model or prompt version differs from ob1_config
 *   --workers N (2)   --batch N (1)   --ttl SECONDS (900)   --timeout SECONDS (300, per model call)
 *
 * ── The cost, and the switch ────────────────────────────────────────────────
 * One LLM call per thought, recurring: every new capture is extracted too. On
 * the fork's default — Ollama, `qwen2.5:7b` — that is compute and latency on
 * your own machine and nothing leaves it. Pointed at a hosted provider it is
 * money, per thought, for ever, and the content of every thought goes to that
 * provider rather than only the ones someone searches for. FORK.md change 30
 * has the measured wall clock for a full pass.
 *
 * Two workers by default, and the number was measured twice because the first
 * reading of it was wrong. The 441-issue corpus at two workers: 4,941 s wall
 * clock with 9,870 s of model calls inside it, and 21 thoughts failed a 120 s
 * per-call timeout — read at the time as two calls queueing behind each other
 * on a one-at-a-time Ollama. At one worker with a 300 s timeout: 6,793 s, and
 * 11 thoughts still timed out. So Ollama was serving both calls at once (its
 * default parallelism is above one on a machine with the memory for it), the
 * second worker bought 27% of the wall clock, and the timeouts are long
 * documents whose extraction genuinely takes minutes on a 7B model, not queue
 * time. Raise --timeout for those, or accept the failures and --retry-failed
 * later; --workers beyond two is for a hosted provider.
 *
 * Nothing spends it until this runs. The first run writes the extraction key
 * to `ob1_config.entity_extraction_key`; from then on migration 016's trigger
 * enqueues every new or edited thought, and either the next run or a `--follow`
 * process extracts it. To stop: delete that row and the trigger goes quiet.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * The worker authenticates like any client: OB1_WORKER_KEY holds a raw access
 * key whose hash is in MCP_ACCESS_KEYS, and the run resolves it through
 * `resolve_agent` to a stable agent id, which every mention and edge it writes
 * carries. A revoked key refuses to run. Without a key the rows carry NULL and
 * the run says so once; it does not refuse, because on a single-operator box
 * the attribution is not in doubt.
 *
 * ── What the model is and is not asked ──────────────────────────────────────
 * The model is asked for names and types; deciding whether two names are one
 * entity is the database's (`normalize_entity_name`, migration 016). A
 * malformed answer — not JSON, or not the shape — is a failure for that
 * thought, retryable with --retry-failed; so is a timeout, which the corpus run
 * showed is a property of the longest thoughts rather than of the moment. A
 * rate limit, a server error or a lost connection is neither: the worker
 * pauses and retries, and stops if the provider stays down, leaving its leases
 * to return to the pool rather than marking thoughts failed for it. A content
 * edit that lands while a thought is being extracted makes
 * `record_thought_entities` refuse with stale=true; the trigger has already
 * re-queued the thought, so the worker moves on and the pool redoes it.
 *
 * Changing the model or the prompt version changes the key. A run under a key
 * other than the recorded one needs --switch-key, as a re-embed under another
 * model needs --switch-model: record_thought_entities replaces a thought's rows
 * whatever key wrote them, so a partial run under a second model leaves a
 * per-thought mixture that nothing repairs.
 */

import { SQL } from "bun";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolveEmbedConfig } from "../server-portable/embed.ts";
import { extractEntities, extractionKey, type Extraction } from "../server-portable/entities.ts";
import { hashKey, parseKeyRecords } from "../server-portable/auth.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
/**
 * A numeric flag. A flag that is present with no value is an error, not the
 * default: `--limit` typed alone meant "no limit" once, and sent the whole
 * backlog to the model. `optional` is for --follow, whose value is a poll
 * interval with a sensible default.
 */
const numberFlag = (name: string, fallback: number, min: number, optional = false): number => {
  const raw = flag(name);
  if (raw === undefined || raw.startsWith("--")) {
    if (has(name) && !optional) {
      console.error(`--${name} needs a value (an integer >= ${min}).`);
      process.exit(2);
    }
    return fallback;
  }
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
// One thought per claim. A claim costs half a millisecond against a model call
// of ten seconds or more, and the lease is stamped per claim: a batch of four
// at a 300 s timeout could outlive a 900 s lease, be reaped, and be extracted
// twice.
const BATCH = numberFlag("batch", 1, 1);
const TTL = numberFlag("ttl", 900, 1);
const TIMEOUT_S = numberFlag("timeout", 300, 1);
if (BATCH * TIMEOUT_S > TTL) {
  console.error(
    `--batch ${BATCH} × --timeout ${TIMEOUT_S} s can exceed the --ttl ${TTL} s lease, which is stamped once per batch.\n` +
      `A batch that outlives its lease is reaped and extracted again by another worker. Lower --batch or raise --ttl.`
  );
  process.exit(2);
}
/** Append every model answer here as JSONL — {id, fingerprint, entities, relations} — for evals/eval-entities.ts --replay. */
const DUMP = flag("dump");
if (DUMP !== undefined && DUMP.startsWith("--")) {
  console.error("--dump needs a file path.");
  process.exit(2);
}
const LIMIT = has("limit") ? numberFlag("limit", 0, 1) : 0;
const FOLLOW = has("follow") ? numberFlag("follow", 15, 1, true) : 0;
const STATUS_ONLY = has("status");
const DRY_RUN = has("dry-run");
const SWITCH_KEY = has("switch-key");
const RETRY_FAILED = has("retry-failed");

const cfg = resolveEmbedConfig(process.env);
const JOB = flag("job") ?? extractionKey(cfg.metadataModel);

console.log(`  job:    ${JOB}`);
console.log(`  model:  ${cfg.metadataModel} via ${cfg.llmBase}, temperature ${cfg.metadataTemperature}`);

const sql = new SQL({ url, max: WORKERS + 1 });

// ── The database's side ─────────────────────────────────────────────────────

const [{ tables }] = await sql`
  SELECT count(*)::int AS tables FROM pg_class
  WHERE relname IN ('thought_work_claims', 'ob1_entities', 'thought_entities', 'ob1_entity_edges') AND relkind = 'r'`;
if (Number(tables) < 4) {
  console.error("\n  The entity tables or the lease table are missing. Apply migrations 015 and 016 first:\n    cd db && bun migrate.ts --url …");
  await sql.close();
  process.exit(2);
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The same decision the server makes: MCP_ACCESS_KEYS says whether a key is
 * valid and what it is called and may do; resolve_agent says who it belongs to.
 * So the key must be in MCP_ACCESS_KEYS — a key the server would refuse is not
 * an identity here either — and the record's own name and scope are what get
 * registered, not a guessed label and a hardcoded 'write' that the server's
 * next request would flip back. Resolution writes (first sight registers, every
 * call touches last_used_at), so --status and --dry-run do not resolve.
 */
let agentId: string | null = null;
if (!STATUS_ONLY && !DRY_RUN) {
  const rawKey = process.env.OB1_WORKER_KEY;
  if (rawKey) {
    if (!process.env.MCP_ACCESS_KEYS) {
      console.error("\n  OB1_WORKER_KEY is set but MCP_ACCESS_KEYS is not, so the key cannot be checked or named. Set both, as the server has them.");
      await sql.close();
      process.exit(2);
    }
    const hash = hashKey(rawKey);
    const record = parseKeyRecords(process.env.MCP_ACCESS_KEYS).keys.find((k) => k.sha256 === hash);
    if (!record) {
      console.error("\n  OB1_WORKER_KEY is not one of the keys in MCP_ACCESS_KEYS. The server would refuse it; so does this.");
      await sql.close();
      process.exit(2);
    }
    try {
      const [{ r }] = await sql`SELECT resolve_agent(${hash}::text, ${record.name}::text, ${record.scope}::text) AS r`;
      const res = r as { ok: boolean; error?: string; agent_id?: string; revoked_at?: string; reason?: string | null };
      if (!res.ok && res.error === "REVOKED") {
        console.error(`\n  The worker's key was revoked at ${res.revoked_at}${res.reason ? ` (${res.reason})` : ""}. Refusing to run.`);
        await sql.close();
        process.exit(2);
      }
      if (res.ok && res.agent_id) {
        agentId = res.agent_id;
        console.log(`  agent:  ${record.name} (${record.scope}, ${agentId})`);
      } else {
        console.error(`  ⚠  resolve_agent answered ${res.error ?? "without an id"}; rows will carry no agent id`);
      }
    } catch (e) {
      console.error(`  ⚠  could not resolve the worker's identity (${(e as Error).message}); rows will carry no agent id`);
    }
  } else {
    console.error("  ⚠  OB1_WORKER_KEY is not set: mentions and edges will carry no agent id. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.");
  }
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
  return { pending: by.pending ?? 0, claimed: by.claimed ?? 0, succeeded: by.succeeded ?? 0, failed: by.failed ?? 0, unpooled: Number(unpooled), thoughts: Number(thoughts) };
}

function printCounts(c: Counts, label: string): void {
  console.log(
    `  ${label}: ${c.thoughts} thoughts — ${c.succeeded} extracted, ${c.failed} failed, ` +
      `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool`
  );
}

async function printGraph(): Promise<void> {
  const [g] = await sql`
    SELECT (SELECT count(*)::int FROM ob1_entities) AS entities,
           (SELECT count(*)::int FROM thought_entities) AS mentions,
           (SELECT count(*)::int FROM ob1_entity_edges) AS edges,
           (SELECT count(DISTINCT thought_id)::int FROM thought_entities) AS thoughts_with_entities`;
  const byType = (await sql`SELECT entity_type, count(*)::int AS c FROM ob1_entities GROUP BY entity_type ORDER BY c DESC`) as { entity_type: string; c: number }[];
  console.log(
    `  graph: ${g.entities} entities (${byType.map((t) => `${t.c} ${t.entity_type}`).join(", ") || "none"}), ` +
      `${g.mentions} mentions across ${g.thoughts_with_entities} thoughts, ${g.edges} edges`
  );
}

async function printFailures(limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, attempt_count, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
    { thought_id: string; attempt_count: number; last_error: string | null }[];
  for (const r of rows) console.error(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
}

const recordedKey: string | undefined = ((await sql`SELECT value AS key FROM ob1_config WHERE key = 'entity_extraction_key'`) as { key: string }[])[0]?.key;
if (recordedKey && recordedKey !== JOB) {
  console.log(`  ob1_config.entity_extraction_key is ${recordedKey}; this run uses ${JOB} — a different model or prompt version`);
  if (!SWITCH_KEY && !STATUS_ONLY && !DRY_RUN) {
    // The same gate reembed.ts has. record_thought_entities replaces a
    // thought's rows whatever key wrote them, so a run under another model —
    // a --limit trial with OB1_METADATA_MODEL changed in the shell — would
    // leave a per-thought mixture of two models' extractions and re-point the
    // trigger at the new key. Make the operator say so.
    console.error(
      `\n  Refusing to extract under a key other than the one ob1_config records without --switch-key.\n` +
        `  Every thought this run touches would carry ${JOB}'s extraction in place of ${recordedKey}'s, and new captures\n` +
        `  would enqueue under ${JOB}. If that is the intent, pass --switch-key and run the whole backlog; if\n` +
        `  OB1_METADATA_MODEL is simply set differently in this shell, fix it instead.`
    );
    await sql.close();
    process.exit(2);
  }
} else if (!recordedKey) {
  console.log(`  ob1_config.entity_extraction_key is not set: the trigger has enqueued nothing yet; this run sets it`);
}

if (STATUS_ONLY || DRY_RUN) {
  const c = await counts();
  printCounts(c, STATUS_ONLY ? "status" : "before");
  await printGraph();
  if (c.failed > 0) {
    console.error(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
    await printFailures();
  }
  if (DRY_RUN) {
    const todo = c.pending + c.unpooled + (RETRY_FAILED ? c.failed : 0);
    console.log(
      `\n  would: ${recordedKey === JOB ? "" : `record ${JOB} in ob1_config so new captures enqueue; `}` +
        `${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
        `add ${c.unpooled} thoughts to the pool; send ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) to ${cfg.metadataModel} ` +
        `with ${WORKERS} worker(s). Nothing was written.`
    );
  }
  await sql.close();
  process.exit(0);
}

// ── The run ─────────────────────────────────────────────────────────────────

if (recordedKey !== JOB) {
  await sql`
    INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', ${JOB})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  console.log(`  ob1_config.entity_extraction_key = ${JOB} — new and edited thoughts now enqueue for extraction`);
}

if (RETRY_FAILED) {
  const [{ n }] = await sql`
    WITH retried AS (
      UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
      WHERE work_type = ${JOB} AND status = 'failed' RETURNING 1)
    SELECT count(*)::int AS n FROM retried`;
  console.log(`  --retry-failed: ${n} failed row(s) returned to the pool`);
}

let stopping = false;
let done = 0;
let failed = 0;
let vanished = 0;
let superseded = 0;
let malformed = 0;
let llmMs = 0;
const totals = { entities: 0, newEntities: 0, mentions: 0, edges: 0, dropped: 0, ambiguous: 0 };
const activeWorkers = new Set<string>();
const started = Date.now();
let total = 0;
const lastReport = { at: 0 };

function progress(force = false): void {
  const now = Date.now();
  if (!force && now - lastReport.at < 3000) return;
  lastReport.at = now;
  const elapsed = (now - started) / 1000;
  const rate = done / Math.max(elapsed, 0.001);
  const remaining = Math.max((LIMIT ? Math.min(LIMIT, total) : total) - done - failed, 0);
  const eta = rate > 0 ? Math.round(remaining / rate) : null;
  console.log(
    `  ${done + failed}/${LIMIT ? Math.min(LIMIT, total) : total}  ${rate.toFixed(2)}/s  ` +
      `${totals.entities} entity mentions, ${totals.edges} edges` +
      (failed ? `  ${failed} failed` : "") +
      (eta !== null ? `  ~${eta}s left` : "")
  );
}

type Row = { id: string; content: string; fingerprint: string | null };
type Outcome =
  | { outcome: "succeeded" }
  | { outcome: "failed"; error: string }
  | { outcome: "vanished" }
  /** Edited while it was being extracted; the trigger has already re-queued it and the pool will redo it. */
  | { outcome: "superseded" };

async function processRow(row: Row): Promise<Outcome> {
  const t0 = Date.now();
  let extraction: Extraction;
  try {
    extraction = await extractEntities(row.content, cfg, AbortSignal.timeout(TIMEOUT_S * 1000));
  } finally {
    llmMs += Date.now() - t0;
  }
  if (extraction.malformed) {
    malformed++;
    return { outcome: "failed", error: "the model's answer was not JSON of the expected shape" };
  }
  if (DUMP) {
    // The model's answer as parsed, before the database applies the rule —
    // what a replay needs to re-score a rule change without the model.
    appendFileSync(DUMP, JSON.stringify({ id: row.id, fingerprint: row.fingerprint, entities: extraction.entities, relations: extraction.relations }) + "\n");
  }
  const [r] = await sql`
    SELECT record_thought_entities(
      ${row.id}::uuid, ${JOB}::text,
      ${extraction.entities}::jsonb, ${extraction.relations}::jsonb,
      ${row.fingerprint}::text, ${agentId}::uuid
    ) AS r`;
  const res = r.r as { ok: boolean; stale?: boolean; error?: string; entities?: number; new_entities?: number; mentions?: number; edges?: number; dropped_relations?: number; ambiguous_relations?: number };
  if (res.ok) {
    totals.entities += res.mentions ?? 0;
    totals.newEntities += res.new_entities ?? 0;
    totals.mentions += res.mentions ?? 0;
    totals.edges += res.edges ?? 0;
    totals.dropped += res.dropped_relations ?? 0;
    totals.ambiguous += res.ambiguous_relations ?? 0;
    return { outcome: "succeeded" };
  }
  if (res.error === "NOT_FOUND") return { outcome: "vanished" };
  // Edited between the claim and the write. What was extracted describes text
  // that is no longer there — and migration 016's trigger has already put the
  // thought back in the pool for the new text, so re-extracting it here would
  // be a second model call for work the pool is about to do. One mechanism.
  if (res.stale) return { outcome: "superseded" };
  return { outcome: "failed", error: `record_thought_entities: ${res.error}` };
}

/**
 * Whether an error from the provider says nothing about the thought: a rate
 * limit, a server error, a dropped connection. Those are retried with a pause
 * and, if they persist, stop this worker so the pool is not burnt through
 * marking every thought failed in seconds. A timeout is NOT transient here: the
 * corpus run showed the same long documents exceed the limit every time, so it
 * is a fact about the thought, recorded failed and revisited with a longer
 * --timeout.
 */
function isTransient(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  const msg = (e as Error).message ?? "";
  const name = (e as Error).name ?? "";
  if (name === "TimeoutError" || /timed out/i.test(msg)) return false;
  return /ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|Unable to connect|socket/i.test(msg);
}
const TRANSIENT_PAUSES_MS = [5_000, 15_000, 45_000];

function limitReached(): boolean {
  return LIMIT > 0 && done + failed >= LIMIT;
}

async function worker(n: number): Promise<void> {
  const workerId = `extract-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
  activeWorkers.add(workerId);
  try {
    while (!stopping && !limitReached()) {
      let batch: { thought_id: string; attempt: number }[];
      let byId: Map<string, Row>;
      try {
        const want = LIMIT > 0 ? Math.max(1, Math.min(BATCH, LIMIT - done - failed)) : BATCH;
        batch = (await sql`
          SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${want}, ${TTL})`) as { thought_id: string; attempt: number }[];
        if (batch.length === 0) return;
        const ids = batch.map((b) => b.thought_id);
        const rows = (await sql`
          SELECT id, content, content_fingerprint AS fingerprint FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
        byId = new Map(rows.map((r) => [r.id, r]));
      } catch (e) {
        console.error(`  ${workerId}: ${(e as Error).message} — this worker stops`);
        return;
      }
      for (const b of batch) {
        if (stopping || limitReached()) return;
        const row = byId.get(b.thought_id);
        if (b.attempt > 1) console.error(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
        let outcome: Outcome | null = null;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          for (let attempt = 0; outcome === null; attempt++) {
            try {
              outcome = await processRow(row);
            } catch (e) {
              if (!isTransient(e)) {
                outcome = { outcome: "failed", error: (e as Error).message.slice(0, 500) };
              } else if (attempt < TRANSIENT_PAUSES_MS.length && !stopping) {
                console.error(`  ${workerId}: provider unavailable (${(e as Error).message.slice(0, 120)}); pausing ${TRANSIENT_PAUSES_MS[attempt] / 1000} s`);
                await Bun.sleep(TRANSIENT_PAUSES_MS[attempt]);
              } else {
                // Still failing after the pauses. Stop this worker; the finally
                // below returns its leases, this thought's included, so nothing
                // is marked failed for a provider that was merely down.
                console.error(`  ${workerId}: provider still unavailable — this worker stops; re-run when it is back`);
                return;
              }
            }
          }
        }
        if (outcome.outcome === "vanished") {
          vanished++;
          continue;
        }
        if (outcome.outcome === "superseded") {
          // The claim is already pending again with no holder — the trigger
          // did that — so there is nothing to release.
          superseded++;
          console.error(`  ${b.thought_id}: edited while it was being extracted; it is pending again and will be extracted from the new text`);
          continue;
        }
        let ok: boolean;
        let gone = false;
        try {
          [{ ok }] = await sql`
            SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                   ${outcome.outcome}, ${outcome.outcome === "failed" ? outcome.error : null}) AS ok`;
          if (!ok) {
            const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM thoughts WHERE id = ${b.thought_id}::uuid) AS exists`;
            gone = !exists;
          }
        } catch (e) {
          console.error(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
          return;
        }
        if (gone) {
          vanished++;
          console.error(`  ${b.thought_id}: deleted while it was being extracted`);
          continue;
        }
        if (!ok) {
          // Either the lease expired, or the content was edited and migration
          // 016's trigger put the row back in the pool: it is pending again and
          // will be extracted from the new text.
          console.error(`  ${b.thought_id}: the claim was no longer this worker's at release — edited meanwhile or the lease expired; it is pending again`);
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
    try {
      const [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      if (freed > 0 && !FOLLOW) console.error(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    } catch (e) {
      console.error(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s`);
    }
    activeWorkers.delete(workerId);
  }
}

const stop = () => {
  if (stopping) {
    console.error(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
    const hardStop = setTimeout(() => process.exit(130), 3000);
    void Promise.all([...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null)))
      .finally(() => { clearTimeout(hardStop); process.exit(130); });
    return;
  }
  stopping = true;
  console.error("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

let firstPass = true;
async function pass(): Promise<Counts> {
  // The backlog is pooled once. While following, the trigger enqueues every
  // new capture, so re-running enqueue_thoughts — a scan of every thought —
  // each poll would find nothing and cost the table.
  const added = firstPass ? Number((await sql`SELECT enqueue_thoughts(${JOB}) AS added`)[0].added) : 0;
  firstPass = false;
  const before = await counts();
  if (added > 0 || !FOLLOW) console.log(`  pool: ${added} thought(s) added`);
  total += before.pending + before.claimed;
  if (before.pending + before.claimed === 0) return before;
  if (!FOLLOW || added > 0 || before.pending > 0) {
    printCounts(before, "before");
  }
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  progress(true);
  return counts();
}

console.log(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

let after = await pass();
if (FOLLOW) {
  // "This many thoughts, then stop" holds while following too.
  while (!stopping && !limitReached()) {
    await Bun.sleep(FOLLOW * 1000);
    if (stopping) break;
    after = await pass();
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n  ${done} extracted, ${failed} failed, ${superseded} edited mid-extraction and re-queued, ${vanished} deleted mid-pass, in ${elapsed}s ` +
    `(${(llmMs / 1000).toFixed(1)}s in model calls across ${WORKERS} worker(s))`
);
console.log(
  `  wrote ${totals.mentions} mentions of ${totals.newEntities} new entities, ${totals.edges} edges; ` +
    `dropped ${totals.dropped} relation(s) naming an unlisted entity; ${totals.ambiguous} attached to a name listed under two types`
);
if (malformed > 0) console.error(`  ${malformed} answer(s) were not JSON of the expected shape — recorded failed`);
printCounts(after, "after");
await printGraph();
if (after.failed > 0) {
  console.error(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
  await printFailures();
}
if (after.claimed > 0 && !stopping) {
  console.error(`\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed. They return to the pool within ${TTL} s.`);
}
if (after.pending > 0 && !stopping && !limitReached()) {
  console.error(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
}
await sql.close();
const incomplete = after.failed > 0 || after.claimed > 0 || (after.pending > 0 && !limitReached());
process.exit(stopping ? (FOLLOW ? 0 : 130) : incomplete ? 1 : 0);
