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
 *   --workers N (1)   --batch N (4)   --ttl SECONDS (900)   --timeout SECONDS (300, per model call)
 *
 * ── The cost, and the switch ────────────────────────────────────────────────
 * One LLM call per thought, recurring: every new capture is extracted too. On
 * the fork's default — Ollama, `qwen2.5:7b` — that is compute and latency on
 * your own machine and nothing leaves it. Pointed at a hosted provider it is
 * money, per thought, for ever, and the content of every thought goes to that
 * provider rather than only the ones someone searches for. FORK.md change 30
 * has the measured wall clock for a full pass.
 *
 * ONE worker by default, unlike reembed.ts. Ollama serves one request at a
 * time unless told otherwise, so a second worker does not shorten the pass —
 * it doubles the queue each call waits in. Measured on the 441-issue corpus at
 * two workers: 9,870 s of model calls inside a 4,941 s wall clock, and 21
 * thoughts failed on the then-120 s timeout because their wait included
 * another thought's call. Against a hosted provider, or an Ollama with
 * OLLAMA_NUM_PARALLEL raised, more workers do help; pass --workers.
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
 * thought, retryable with --retry-failed; a content edit that lands while the
 * thought is being extracted makes `record_thought_entities` refuse with
 * stale=true and the thought is re-read and extracted again.
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
const numberFlag = (name: string, fallback: number, min: number): number => {
  const raw = flag(name);
  if (raw === undefined || raw.startsWith("--")) return fallback;
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

const WORKERS = numberFlag("workers", 1, 1);
const BATCH = numberFlag("batch", 4, 1);
const TTL = numberFlag("ttl", 900, 1);
const TIMEOUT_S = numberFlag("timeout", 300, 1);
/** Append every model answer here as JSONL — {id, fingerprint, entities, relations} — for evals/eval-entities.ts --replay. */
const DUMP = flag("dump");
const LIMIT = has("limit") ? numberFlag("limit", 0, 1) : 0;
const FOLLOW = has("follow") ? numberFlag("follow", 15, 1) : 0;
const STATUS_ONLY = has("status");
const DRY_RUN = has("dry-run");
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

let agentId: string | null = null;
{
  const rawKey = process.env.OB1_WORKER_KEY;
  if (rawKey) {
    const hash = hashKey(rawKey);
    const records = process.env.MCP_ACCESS_KEYS ? parseKeyRecords(process.env.MCP_ACCESS_KEYS).keys : [];
    const record = records.find((k) => k.sha256 === hash);
    const label = record?.name ?? process.env.OB1_WORKER_NAME ?? "extract-entities";
    if (!record && process.env.MCP_ACCESS_KEYS) {
      console.error("\n  OB1_WORKER_KEY is not one of the keys in MCP_ACCESS_KEYS. The server would refuse it; so does this.");
      await sql.close();
      process.exit(2);
    }
    try {
      const [{ r }] = await sql`SELECT resolve_agent(${hash}::text, ${label}::text, 'write') AS r`;
      const res = r as { ok: boolean; error?: string; agent_id?: string; revoked_at?: string; reason?: string | null };
      if (!res.ok && res.error === "REVOKED") {
        console.error(`\n  The worker's key was revoked at ${res.revoked_at}${res.reason ? ` (${res.reason})` : ""}. Refusing to run.`);
        await sql.close();
        process.exit(2);
      }
      if (res.ok && res.agent_id) {
        agentId = res.agent_id;
        console.log(`  agent:  ${label} (${agentId})`);
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
  console.log(`  ob1_config.entity_extraction_key is ${recordedKey}; this run uses ${JOB} (a different model or prompt version) and will record it`);
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
let malformed = 0;
let llmMs = 0;
const totals = { entities: 0, newEntities: 0, mentions: 0, edges: 0, dropped: 0 };
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
type Outcome = { outcome: "succeeded" } | { outcome: "failed"; error: string } | { outcome: "vanished" };

async function processRow(row: Row): Promise<Outcome> {
  let current = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    let extraction: Extraction;
    try {
      extraction = await extractEntities(current.content, cfg, AbortSignal.timeout(TIMEOUT_S * 1000));
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
      appendFileSync(DUMP, JSON.stringify({ id: current.id, fingerprint: current.fingerprint, entities: extraction.entities, relations: extraction.relations }) + "\n");
    }
    const [r] = await sql`
      SELECT record_thought_entities(
        ${current.id}::uuid, ${JOB}::text,
        ${extraction.entities}::jsonb, ${extraction.relations}::jsonb,
        ${current.fingerprint}::text, ${agentId}::uuid
      ) AS r`;
    const res = r.r as { ok: boolean; stale?: boolean; error?: string; entities?: number; new_entities?: number; mentions?: number; edges?: number; dropped_relations?: number };
    if (res.ok) {
      totals.entities += res.mentions ?? 0;
      totals.newEntities += res.new_entities ?? 0;
      totals.mentions += res.mentions ?? 0;
      totals.edges += res.edges ?? 0;
      totals.dropped += res.dropped_relations ?? 0;
      return { outcome: "succeeded" };
    }
    if (res.error === "NOT_FOUND") return { outcome: "vanished" };
    if (res.stale) {
      // Edited between the claim and the write. What was extracted describes
      // text that is no longer there; read what is, and extract that.
      const [fresh] = (await sql`SELECT id, content, content_fingerprint AS fingerprint FROM thoughts WHERE id = ${current.id}::uuid`) as Row[];
      if (!fresh) return { outcome: "vanished" };
      current = fresh;
      continue;
    }
    return { outcome: "failed", error: `record_thought_entities: ${res.error}` };
  }
  return { outcome: "failed", error: "the thought was edited three times while it was being extracted" };
}

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
        let outcome: Outcome;
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
          vanished++;
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

async function pass(): Promise<Counts> {
  const [{ added }] = await sql`SELECT enqueue_thoughts(${JOB}) AS added`;
  const before = await counts();
  if (Number(added) > 0 || !FOLLOW) console.log(`  pool: ${added} thought(s) added`);
  total += before.pending + before.claimed;
  if (before.pending + before.claimed === 0) return before;
  if (!FOLLOW || Number(added) > 0 || before.pending > 0) {
    printCounts(before, "before");
  }
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  progress(true);
  return counts();
}

console.log(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

let after = await pass();
if (FOLLOW) {
  while (!stopping) {
    await Bun.sleep(FOLLOW * 1000);
    if (stopping) break;
    after = await pass();
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n  ${done} extracted, ${failed} failed, ${vanished} deleted mid-pass, in ${elapsed}s ` +
    `(${(llmMs / 1000).toFixed(1)}s in model calls across ${WORKERS} worker(s))`
);
console.log(`  wrote ${totals.mentions} mentions of ${totals.newEntities} new entities, ${totals.edges} edges; dropped ${totals.dropped} relation(s) naming an unlisted entity`);
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
