#!/usr/bin/env bun
/**
 * consolidate.ts — propose which thoughts supersede which, in parallel,
 * resumably, and never apply a proposal unreviewed.
 *
 * The third consumer of migration 015's lease table, and the worker for
 * migration 029's proposal table (Linear SMD-1294). For each thought with
 * extracted entities, `consolidation_candidates()` names the older thoughts
 * that share a subject with it and sit nearest in vector space; each pair goes
 * to the metadata model once (server-portable/consolidate.ts holds the prompt
 * and the parsing rules), and a CONFLICT verdict becomes a pending row in
 * `supersession_proposals`. Nothing here writes `thoughts`. An operator — or a
 * review agent, SMD-950 — reads the queue and accepts or rejects one proposal
 * at a time; acceptance writes `thoughts.supersedes` through
 * `review_supersession_proposal` — which since migration 032 calls
 * `update_thought`, the one edit path — under the audit trigger, with the
 * reviewer as actor.
 *
 *   bun db/consolidate.ts --url postgres://…              # the backlog, then exit
 *   bun db/consolidate.ts --url … --follow [SECONDS]      # …then keep polling for newly extracted thoughts
 *   bun db/consolidate.ts --url … --limit 25              # a trial: this many thoughts, then stop
 *   bun db/consolidate.ts --url … --status                # where the pass stands, and the queue
 *   bun db/consolidate.ts --url … --dry-run               # what a run would do; writes nothing
 *   bun db/consolidate.ts --url … --retry-failed          # failed rows back into the pool first
 *   bun db/consolidate.ts --url … --dump verdicts.jsonl   # also append every verdict, for evals/eval-consolidate.ts
 *   bun db/consolidate.ts --url … --list [pending|accepted|rejected|all]   # the queue, with both thoughts
 *   bun db/consolidate.ts --url … --accept <proposal-id> [--direction newer|older] [--note "…"] [--force]   # --force: a text edited since judged
 *   bun db/consolidate.ts --url … --reject <proposal-id> [--note "…"]
 *   bun db/consolidate.ts --url … --stale [DAYS]          # entities nothing has mentioned within DAYS (90)
 *   --k N (3)   --min-sim F (0.6)   --min-confidence F (0.5)
 *   --workers N (2)   --batch N (1)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)   --timeout SECONDS (120, per model call; this flag, as extract-entities.ts's, not OB1_LLM_TIMEOUT)
 *
 * ── The cost ────────────────────────────────────────────────────────────────
 * One LLM call per candidate PAIR, so up to --k per thought, recurring: every
 * thought extracted after a run is judged against its older neighbours by the
 * next run or a --follow process. On the fork's default — Ollama, `qwen2.5:7b`
 * — that is compute on your own machine and nothing leaves it. Pointed at a
 * hosted provider it is money per pair and both thoughts' text goes to that
 * provider. evals/README.md has the measured calls per thousand thoughts and
 * the wall clock at the shipped --k and --min-sim, which were chosen there.
 *
 * ── The pool ────────────────────────────────────────────────────────────────
 * Thoughts with at least one extracted entity, a vector, that nothing
 * supersedes, and no claim row under this key — migration 029's
 * consolidation_pool(), the one definition this run, --status and preflight
 * read. Built by this run, on every pass — no trigger feeds it, on
 * purpose: a capture has no entities until db/extract-entities.ts reaches it
 * (and no vector while its embedding failed, until reembed.ts does), and a
 * thought judged before that would have no candidates and a terminal claim
 * row, never to be judged. Extract first, then consolidate; --follow polls in
 * that order. What the gate cannot see is the OTHER side of a pair: a newer
 * thought judged while an older neighbour is still unextracted is judged
 * without it, and since a pair is reached from its newer side only, that pair
 * is not revisited — run consolidation after extraction has finished, not
 * beside it. A thought's claim row is terminal once its pairs are judged, so
 * an EDIT does not re-judge it (016's trigger does re-extract it); clear the
 * key's rows to start over, and a pair already proposed is skipped either way.
 *
 * ── The key ─────────────────────────────────────────────────────────────────
 * `consolidate:<model>@p<prompt version>`. A different model or prompt is a
 * different pool over the same pair table: the first pass to judge a pair
 * records it, the second finds it decided. Each proposal carries the key that
 * judged it, so there is no recorded "current key" and no --switch-key.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * As extract-entities.ts: OB1_WORKER_KEY holds a raw access key whose hash is
 * in MCP_ACCESS_KEYS, and the run resolves it through resolve_agent, so
 * proposals carry a stable agent id and an acceptance is audited under the
 * key's name. Without it, proposals carry no agent id and a review is audited
 * as `consolidate` with no id, and the run says so.
 *
 * ── Failures ────────────────────────────────────────────────────────────────
 * A malformed answer for a pair is counted and the pair is skipped; the
 * thought is recorded failed when ANY of its pairs was malformed or timed out,
 * so --retry-failed re-judges its pairs (the ones already proposed are skipped
 * by the candidate rule). A rate limit, a server error or a lost connection is
 * paused and retried three times; if it persists, the thought in hand is
 * recorded failed with the error (so a thought that reliably draws a 500 is
 * visible rather than cycling for ever) and the worker stops, its other
 * leases returning to the pool. A 401/403/404, or a 400 about the request
 * itself, stops every worker at once with nothing marked failed.
 */

import { SQL } from "bun";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { PROVIDER_ERROR_CHARS, refusesLength, resolveEmbedConfig } from "../server-portable/embed.ts";
import {
  cleanForDisplay, consolidateKey, judgePair, proposalVerdict, DEFAULT_CANDIDATES, DEFAULT_MIN_CONFIDENCE, DEFAULT_MIN_SIMILARITY,
  type Judgement,
} from "../server-portable/consolidate.ts";
import { hashKey, parseKeyRecords } from "../server-portable/auth.ts";
import { isoTimestampOrNull } from "../server-portable/store.ts";
import { DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, heartbeatFor, leaseHolders, leaseRefusal, reportLost, startHeartbeat } from "./lease.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
/** A numeric flag. Present with no value is an error, not the default (extract-entities.ts's rule). */
const numberFlag = (name: string, fallback: number, min: number, opts: { optional?: boolean; integer?: boolean; max?: number } = {}): number => {
  const raw = flag(name);
  const integer = opts.integer ?? true;
  if (raw === undefined || raw.startsWith("--")) {
    if (has(name) && !opts.optional) {
      console.error(`--${name} needs a value (${integer ? "an integer" : "a number"} >= ${min}).`);
      process.exit(2);
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || (opts.max !== undefined && n > opts.max)) {
    console.error(`--${name} must be ${integer ? "an integer" : "a number"} >= ${min}${opts.max !== undefined ? ` and <= ${opts.max}` : ""}, got "${raw}"`);
    process.exit(2);
  }
  return n;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const url = flag("url") ?? process.env.DATABASE_URL;
if (!url) {
  console.error("No database URL. Pass --url or set DATABASE_URL.");
  process.exit(2);
}

const WORKERS = numberFlag("workers", 2, 1);
// One thought per claim: up to --k model calls per thought against a claim of
// half a millisecond, so a bigger batch buys nothing, and a worker that dies
// holds fewer rows. (Until migration 031 the lease was stamped once per batch
// and could not be moved, so a batch of several at a long timeout could
// outlive it; the heartbeat retires that reason.)
const BATCH = numberFlag("batch", 1, 1);
// The lease is renewed on a heartbeat while the worker holds rows, so it has
// to outlast a missed beat, not the batch — db/lease.ts holds the rule the
// three consumers share, and the refusal below is its.
const TTL = numberFlag("ttl", DEFAULT_TTL_S, 1);
const HEARTBEAT = has("heartbeat") ? numberFlag("heartbeat", DEFAULT_HEARTBEAT_S, 1) : heartbeatFor(TTL);
const TIMEOUT_S = numberFlag("timeout", 120, 1);
const K = numberFlag("k", DEFAULT_CANDIDATES, 1, { max: 50 });
const MIN_SIM = numberFlag("min-sim", DEFAULT_MIN_SIMILARITY, -1, { integer: false, max: 1 });
const MIN_CONFIDENCE = numberFlag("min-confidence", DEFAULT_MIN_CONFIDENCE, 0, { integer: false, max: 1 });
{
  const refusal = leaseRefusal(TTL, HEARTBEAT, !has("heartbeat"));
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
}
/** Append every verdict here as JSONL — {newer, older, similarity, shared, verdict, supersedes, confidence, reason, key, proposal} — for evals/eval-consolidate.ts. */
const DUMP = flag("dump");
if (has("dump") && (DUMP === undefined || DUMP.startsWith("--"))) {
  console.error("--dump needs a file path.");
  process.exit(2);
}
const LIMIT = has("limit") ? numberFlag("limit", 0, 1) : 0;
const FOLLOW = has("follow") ? numberFlag("follow", 15, 1, { optional: true }) : 0;
const STATUS_ONLY = has("status");
const DRY_RUN = has("dry-run");
const RETRY_FAILED = has("retry-failed");
const LIST = has("list") ? (flag("list") && !flag("list")!.startsWith("--") ? flag("list")! : "pending") : undefined;
const ACCEPT = flag("accept");
const REJECT = flag("reject");
const STALE_DAYS = has("stale") ? numberFlag("stale", 90, 1, { optional: true }) : 0;
const DIRECTION = flag("direction");
const FORCE = has("force");
const NOTE = flag("note");
if (LIST !== undefined && !["pending", "accepted", "rejected", "all"].includes(LIST)) {
  console.error(`--list takes pending, accepted, rejected or all, got "${LIST}"`);
  process.exit(2);
}
for (const [name, v] of [["accept", ACCEPT], ["reject", REJECT]] as const) {
  if (has(name) && (v === undefined || !UUID_RE.test(v))) {
    console.error(`--${name} needs a proposal id (a UUID from --list or the list_supersession_proposals tool).`);
    process.exit(2);
  }
}
if (ACCEPT && REJECT) {
  console.error("--accept and --reject are one decision each; pass one.");
  process.exit(2);
}
if (DIRECTION !== undefined && (!ACCEPT || !["newer", "older"].includes(DIRECTION))) {
  console.error("--direction takes newer or older, and only with --accept.");
  process.exit(2);
}
if (FORCE && !ACCEPT) {
  console.error("--force goes with --accept: it accepts a proposal whose thought was edited after it was judged.");
  process.exit(2);
}
const REVIEW_ONLY = LIST !== undefined || ACCEPT !== undefined || REJECT !== undefined || STALE_DAYS > 0;

const cfg = resolveEmbedConfig(process.env);
const JOB = consolidateKey(cfg.metadataModel);

console.log(`  job:    ${JOB}`);
if (!REVIEW_ONLY) console.log(`  model:  ${cfg.metadataModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}; up to ${K} older neighbour(s) per thought at cosine >= ${MIN_SIM}, conflicts recorded at confidence >= ${MIN_CONFIDENCE}`);

// One connection per worker and one spare: the heartbeat (db/lease.ts) beats
// through the pool, and a worker parked on a lock or a long statement holds
// its own connection, so the spare is what keeps every worker's leases alive
// then. Tightening this to WORKERS would recreate the lapse 031 removed.
const sql = new SQL({ url, max: WORKERS + 1 });

// ── The database's side ─────────────────────────────────────────────────────

const [{ tables }] = await sql`
  SELECT count(*)::int AS tables FROM pg_class
  WHERE relname IN ('thought_work_claims', 'thought_entities', 'supersession_proposals') AND relkind = 'r'`;
if (Number(tables) < 3) {
  console.error("\n  The lease table, the entity tables or the proposal table are missing. Apply migrations 015, 016 and 029 first:\n    cd db && bun migrate.ts --url …");
  await sql.close();
  process.exit(2);
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * extract-entities.ts's decision, verbatim in intent: the key must be in
 * MCP_ACCESS_KEYS and its record's own name and scope are what get registered.
 * Resolution writes, so --status, --dry-run, --list and --stale do not resolve;
 * a review (--accept/--reject) does, since it is audited under this name.
 */
let agentId: string | null = null;
let actorName = "consolidate";
// A run, or a review: both write and are attributed. --status, --dry-run, --list and --stale only read.
const WRITES = ACCEPT !== undefined || REJECT !== undefined || !(STATUS_ONLY || DRY_RUN || REVIEW_ONLY);
if (WRITES) {
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
        actorName = record.name;
        console.log(`  agent:  ${record.name} (${record.scope}, ${agentId})`);
      } else {
        console.error(`  ⚠  resolve_agent answered ${res.error ?? "without an id"}; rows will carry no agent id`);
      }
    } catch (e) {
      console.error(`  ⚠  could not resolve the worker's identity (${(e as Error).message}); rows will carry no agent id`);
    }
  } else {
    console.error(`  ⚠  OB1_WORKER_KEY is not set: ${ACCEPT || REJECT ? "the review is audited as 'consolidate' with no agent id" : "proposals will carry no agent id"}. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.`);
  }
}

// ── Review: --list, --accept, --reject, --stale ─────────────────────────────

type Listed = {
  id: string; status: string; verdict: string; confidence: string; reason: string | null; similarity: number | null;
  judge_key: string; judged_at: string; reviewed_at: string | null; review_note: string | null; superseding_id: string | null;
  older_id: string; older_content: string; older_created_at: string | null; newer_id: string; newer_content: string; newer_created_at: string | null;
  older_edited: boolean; newer_edited: boolean;
};
// Thought content and entity names are untrusted; cleanForDisplay strips what
// would move the cursor or rewrite the ID: line a reviewer is about to paste.
const snippet = (s: string, n = 160) => { const t = cleanForDisplay(s).replace(/\s+/g, " ").trim(); return t.slice(0, n) + (t.length > n ? "…" : ""); };
// SMD-1803: the CLI twin of the server's proposal renderer. Through the store's
// canonical rule (isoTimestampOrNull), not new Date().toISOString(), which
// fabricated 1970-01-01 on a NULL created_at and THREW on an infinity-dated one,
// taking the whole listing down. A sentinel ("infinity") or no-ISO-form value
// has no "T", so it prints whole rather than being sliced to a stub.
const day = (d: string | null) => {
  const iso = isoTimestampOrNull(d);
  return iso == null ? "undated" : iso.includes("T") ? iso.slice(0, 10) : iso;
};
const verdictPhrase = (v: string) =>
  v === "newer_supersedes_older" ? "the NEWER thought supersedes the older"
  : v === "older_supersedes_newer" ? "the OLDER thought supersedes the newer"
  : "conflict, direction not stated";

async function printList(status: string | undefined, limit = 50): Promise<number> {
  const rows = (await sql`SELECT * FROM list_supersession_proposals(${status ?? null}::text, ${limit}::int)`) as Listed[];
  if (rows.length === 0) {
    console.log(`  no ${status ?? ""} proposals`);
    return 0;
  }
  console.log(`  ${rows.length} ${status ?? ""} proposal(s), most confident first:\n`);
  rows.forEach((p, i) => {
    console.log(`  ${i + 1}. [${Number(p.confidence).toFixed(2)}] ${verdictPhrase(p.verdict)}${p.status !== "pending" ? `  (${p.status}${p.reviewed_at ? ` ${day(p.reviewed_at)}` : ""}${p.review_note ? `: ${cleanForDisplay(p.review_note).replace(/\s+/g, " ")}` : ""})` : ""}`);
    if (p.reason) console.log(`     ${cleanForDisplay(p.reason)}`);
    console.log(`     newer [${day(p.newer_created_at)}]${p.newer_edited ? " EDITED SINCE JUDGED" : ""} ${snippet(p.newer_content)}\n        ID: ${p.newer_id}`);
    console.log(`     older [${day(p.older_created_at)}]${p.older_edited ? " EDITED SINCE JUDGED" : ""} ${snippet(p.older_content)}\n        ID: ${p.older_id}`);
    console.log(`     proposal ${p.id}  cosine ${p.similarity === null ? "?" : Number(p.similarity).toFixed(3)}  judged by ${p.judge_key} on ${day(p.judged_at)}`);
    if (p.status === "pending") {
      // Commands as they run: a placeholder the shell cannot parse rather
      // than `newer|older`, which it would read as a pipe (review pass 3).
      const dir = p.verdict === "conflict_undirected" ? " --direction <newer|older>" : "";
      const force = p.older_edited || p.newer_edited ? " --force" : "";
      console.log(`     --accept ${p.id}${dir}${force}    --reject ${p.id}`);
    }
    console.log("");
  });
  return rows.length;
}

async function printStale(days: number): Promise<void> {
  const rows = (await sql`SELECT * FROM stale_entities(make_interval(days => ${days}), 50)`) as
    { entity_id: string; entity_type: string; name: string; thoughts: number; newest_at: string }[];
  if (rows.length === 0) {
    console.log(`  stale: no entity has gone ${days} days without a mention`);
    return;
  }
  console.log(`  stale: ${rows.length} entit${rows.length === 1 ? "y" : "ies"} nothing has mentioned in ${days} days (oldest first; reported, not acted on):`);
  // Names are one line each: control characters stripped and whitespace
  // collapsed, so a name cannot start a forged row (review pass 4).
  for (const r of rows) console.log(`    ${r.entity_type.padEnd(12)} ${cleanForDisplay(r.name).replace(/\s+/g, " ").slice(0, 50).padEnd(50)} ${r.thoughts} thought(s), last ${day(r.newest_at)}`);
}

if (REVIEW_ONLY) {
  let code = 0;
  if (ACCEPT || REJECT) {
    const decision = ACCEPT ? "accept" : "reject";
    const id = (ACCEPT ?? REJECT)!;
    const actor = { name: actorName, source: "consolidate", session: JOB, ...(agentId ? { agent_id: agentId } : {}) };
    const [{ r }] = await sql`
      SELECT review_supersession_proposal(${id}::uuid, ${decision}::text, ${NOTE ?? null}::text, ${DIRECTION ?? null}::text, ${actor}::jsonb, ${FORCE}::boolean) AS r`;
    const res = r as { ok: boolean; error?: string; status?: string; superseding_id?: string; superseded_id?: string; written?: boolean; cleared?: boolean; current?: string; verdict?: string; older_edited?: boolean; newer_edited?: boolean };
    if (res.ok) {
      if (decision === "accept") {
        console.log(`  accepted ${id}: ${res.superseding_id} now supersedes ${res.superseded_id}${res.written ? "" : " (the pointer already held that value)"}; the change is in thought_audit under ${actorName}`);
      } else {
        console.log(`  rejected ${id}${res.cleared ? `: the supersedes pointer this proposal had set is cleared` : ""}`);
      }
    } else {
      code = 1;
      const why: Record<string, string> = {
        NOT_FOUND: "no such proposal (or the thought it names is gone)",
        DIRECTION_REQUIRED: `the judge did not say which is current (${res.verdict}); pass --direction newer or --direction older`,
        ALREADY_ACCEPTED: `already accepted (${res.superseding_id} carries the pointer); --reject it first to undo`,
        EDITED_SINCE: `the ${res.older_edited && res.newer_edited ? "older and newer thoughts have" : res.older_edited ? "older thought has" : "newer thought has"} been edited since the pair was judged, so the verdict is about a text that is gone; read both with --list and pass --force if it still holds`,
        ALREADY_SUPERSEDES: `${res.superseding_id} already supersedes a third thought, ${res.current}; the column holds one predecessor, so decide which — edit that thought, or --reject this`,
        WOULD_CYCLE: `writing this pointer would close a loop through ${res.superseded_id}; refused`,
        // 032: update_thought's answer when the thought to be superseded was
        // deleted between the proposal and the acceptance.
        SUPERSEDES_NOT_FOUND: `${res.superseded_id} no longer exists, so there is nothing to supersede; --reject this`,
      };
      console.error(`  ${decision} refused: ${why[res.error ?? ""] ?? res.error}`);
    }
  }
  if (LIST !== undefined) await printList(LIST === "all" ? undefined : LIST);
  if (STALE_DAYS > 0) await printStale(STALE_DAYS);
  await sql.close();
  process.exit(code);
}

// ── Where the pass stands ───────────────────────────────────────────────────

type Counts = { pending: number; claimed: number; succeeded: number; failed: number; unpooled: number; thoughts: number; proposals: number };
async function counts(): Promise<Counts> {
  const rows = (await sql`
    SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  // The pass's universe and its pool, from the one definition (migration
  // 029's consolidation_pool): entities, a vector, not superseded; the pool
  // is those with no row under this key.
  const [{ unpooled, thoughts }] = await sql`
    SELECT (SELECT count(*)::int FROM consolidation_pool(NULL)) AS thoughts,
           (SELECT count(*)::int FROM consolidation_pool(${JOB})) AS unpooled`;
  const [{ proposals }] = await sql`SELECT count(*)::int AS proposals FROM supersession_proposals WHERE status = 'pending'`;
  return { pending: by.pending ?? 0, claimed: by.claimed ?? 0, succeeded: by.succeeded ?? 0, failed: by.failed ?? 0, unpooled: Number(unpooled), thoughts: Number(thoughts), proposals: Number(proposals) };
}

function printCounts(c: Counts, label: string): void {
  console.log(
    `  ${label}: ${c.thoughts} thoughts with entities — ${c.succeeded} judged, ${c.failed} failed, ` +
      `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool; ${c.proposals} proposal(s) pending review`
  );
}

async function printQueue(): Promise<void> {
  const [q] = await sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
           count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
           count(*) FILTER (WHERE status = 'pending' AND verdict = 'conflict_undirected')::int AS undirected
    FROM supersession_proposals`;
  console.log(`  queue: ${q.pending} pending (${q.undirected} without a direction), ${q.accepted} accepted, ${q.rejected} rejected — --list shows them; --accept / --reject decides one`);
}

async function printFailures(limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, attempt_count, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
    { thought_id: string; attempt_count: number; last_error: string | null }[];
  for (const r of rows) console.error(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
}

if (STATUS_ONLY || DRY_RUN) {
  const c = await counts();
  printCounts(c, STATUS_ONLY ? "status" : "before");
  if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) console.log(describeHolder(h));
  await printQueue();
  if (c.thoughts === 0) console.log("  no thought has extracted entities yet — run db/extract-entities.ts first; this pass pairs thoughts by the entities they share");
  if (c.failed > 0) {
    console.error(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
    await printFailures();
  }
  if (DRY_RUN) {
    const todo = c.pending + c.unpooled + (RETRY_FAILED ? c.failed : 0);
    console.log(
      `\n  would: ${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
        `add ${c.unpooled} thoughts to the pool; judge ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) against up to ${K} older neighbour(s) each with ${cfg.metadataModel} ` +
        `and ${WORKERS} worker(s), ${TTL} s leases renewed every ${HEARTBEAT} s. Nothing was written.`
    );
  }
  await sql.close();
  process.exit(0);
}

// ── The run ─────────────────────────────────────────────────────────────────

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
let lost = 0;
let beats = 0;
/** Rows that went to the judge — finished or not — so the pairs-per-thought ratio divides by the rows that cost pairs. */
let judged = 0;
let llmMs = 0;
const totals = { pairs: 0, agree: 0, unrelated: 0, conflict: 0, proposed: 0, alreadyProposed: 0, underConfidence: 0, undirected: 0, malformed: 0, noCandidates: 0 };
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
      `${totals.pairs} pairs judged, ${totals.proposed} proposed` +
      (failed ? `  ${failed} failed` : "") +
      (eta !== null ? `  ~${eta}s left` : "")
  );
}

/** A thought as read for judging: the text and 016's hash of it, taken together, so the proposal records what the judge saw. */
type Row = { id: string; content: string; created_at: string | null; fingerprint: string };
type Candidate = { older_id: string; similarity: number; shared_entities: number };
type Outcome = { outcome: "succeeded" } | { outcome: "failed"; error: string } | { outcome: "vanished" };

async function processRow(row: Row): Promise<Outcome> {
  const candidates = (await sql`SELECT older_id, similarity, shared_entities FROM consolidation_candidates(${row.id}::uuid, ${K}::int, ${MIN_SIM}::float)`) as Candidate[];
  if (candidates.length === 0) {
    totals.noCandidates++;
    return { outcome: "succeeded" };
  }
  const olders = (await sql`
    SELECT id, content, created_at, content_fingerprint_of(content) AS fingerprint FROM thoughts
    WHERE id = ANY(${sql.array(candidates.map((c) => c.older_id), "TEXT")}::uuid[])`) as Row[];
  const byId = new Map(olders.map((o) => [o.id, o]));
  const problems: string[] = [];
  // No early exit on `stopping` here: a thought is at most --k calls, bounded
  // by the lease arithmetic above, and a thought released succeeded with pairs
  // unjudged would be terminal with the pairs never judged (review pass 1).
  for (const c of candidates) {
    const older = byId.get(c.older_id);
    if (!older) continue; // deleted between the candidate query and the read
    const t0 = Date.now();
    let j: Judgement;
    try {
      j = await judgePair({ content: older.content, createdAt: older.created_at },
                          { content: row.content, createdAt: row.created_at },
                          cfg, AbortSignal.timeout(TIMEOUT_S * 1000));
    } catch (e) {
      llmMs += Date.now() - t0;
      // A timeout is a fact about this pair (the longest thoughts); anything
      // else is the provider's and is classified by the caller.
      if ((e as Error).name === "TimeoutError" || /timed out/i.test((e as Error).message)) {
        problems.push(`pair with ${c.older_id}: timed out after ${TIMEOUT_S} s`);
        continue;
      }
      throw e;
    }
    llmMs += Date.now() - t0;
    totals.pairs++;
    if (j.malformed) {
      totals.malformed++;
      problems.push(`pair with ${c.older_id}: the model's answer was not JSON of the expected shape`);
      continue;
    }
    totals[j.verdict]++;
    const verdict = proposalVerdict(j);
    let proposalId: string | null = null;
    let recorded: "proposed" | "under-confidence" | "already" | null = null;
    if (verdict !== null) {
      if (j.confidence < MIN_CONFIDENCE) {
        totals.underConfidence++;
        recorded = "under-confidence";
      } else {
        // The fingerprints of the texts the judge was sent, not of the rows as
        // they are at this write: an edit that landed during the call is then
        // visible to the reviewer (review pass 4).
        const [{ id }] = await sql`
          SELECT record_supersession_proposal(${c.older_id}::uuid, ${row.id}::uuid, ${verdict}::text,
                                              ${j.confidence}::numeric, ${j.reason || null}::text, ${c.similarity}::float,
                                              ${JOB}::text, ${agentId}::uuid, ${older.fingerprint}::text, ${row.fingerprint}::text) AS id`;
        proposalId = (id as string | null) ?? null;
        if (proposalId) { totals.proposed++; recorded = "proposed"; if (verdict === "conflict_undirected") totals.undirected++; }
        else { totals.alreadyProposed++; recorded = "already"; }
      }
    }
    if (DUMP) {
      appendFileSync(DUMP, JSON.stringify({
        newer: row.id, older: c.older_id, similarity: c.similarity, shared: c.shared_entities, key: JOB,
        verdict: j.verdict, supersedes: j.supersedes, confidence: j.confidence, reason: j.reason,
        proposal: proposalId, recorded,
      }) + "\n");
    }
  }
  if (problems.length) return { outcome: "failed", error: `${problems.length} of ${candidates.length} pair(s) not judged: ${problems.join("; ").slice(0, 400)}` };
  return { outcome: "succeeded" };
}

/** What an error from the provider is about — extract-entities.ts's classifier, the same three kinds. */
type ErrorKind = "thought" | "transient" | "fatal";
function classifyError(e: unknown): ErrorKind {
  const status = (e as { status?: number }).status;
  const msg = (e as Error).message ?? "";
  const name = (e as Error).name ?? "";
  if (name === "TimeoutError" || /timed out/i.test(msg)) return "thought";
  if (status === 429 || (status !== undefined && status >= 500)) return "transient";
  if (status === 400 && refusesLength(status, msg)) return "thought";
  if (status !== undefined && status >= 400 && status < 500) return "fatal";
  if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|Unable to connect|socket/i.test(msg)) return "transient";
  return "thought";
}
const TRANSIENT_PAUSES_MS = [5_000, 15_000, 45_000];
let configError: string | null = null;

/** --limit counts thoughts CLAIMED, reserved at claim time, so two workers cannot each take one on a limit of one. */
let reserved = 0;
function limitReached(): boolean {
  return LIMIT > 0 && reserved >= LIMIT;
}

async function worker(n: number): Promise<void> {
  const workerId = `consolidate-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
  activeWorkers.add(workerId);
  const hb = startHeartbeat({
    sql, job: JOB, workerId, ttlS: TTL, everyS: HEARTBEAT,
    onLost: (ids) => console.error(`  ${workerId}: ${ids.length} row(s) no longer this worker's at the last beat — reaped, requeued by an edit, or deleted; each is named as the loop reaches it, or at its release if it was the row in hand`),
    onError: (e, consecutive) => { if (consecutive === 1) console.error(`  ${workerId}: heartbeat failed (${e.message}); the leases hold ${TTL} s from the last beat that reached the database`); },
  });
  try {
    while (!stopping && !limitReached()) {
      let batch: { thought_id: string; attempt: number }[];
      let byId: Map<string, Row>;
      try {
        const room = LIMIT > 0 ? LIMIT - reserved : BATCH;
        if (room <= 0) return;
        const want = Math.min(BATCH, room);
        reserved += want;
        batch = (await sql`
          SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${want}, ${TTL})`) as { thought_id: string; attempt: number }[];
        reserved -= want - batch.length;
        if (batch.length === 0) return;
        const ids = batch.map((b) => b.thought_id);
        hb.claimed(ids);
        const rows = (await sql`
          SELECT id, content, created_at, content_fingerprint_of(content) AS fingerprint
            FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
        byId = new Map(rows.map((r) => [r.id, r]));
      } catch (e) {
        console.error(`  ${workerId}: ${(e as Error).message} — this worker stops`);
        return;
      }
      for (const b of batch) {
        if (stopping) return;
        if (hb.lost.has(b.thought_id)) {
          // A beat found this row no longer ours. Nothing to release, and
          // repeating the provider's work would only race the holder; the row
          // says why (db/lease.ts reportLost), and which count it joins.
          if ((await reportLost(sql, JOB, workerId, b.thought_id)) === "deleted") vanished++;
          else lost++;
          continue;
        }
        const row = byId.get(b.thought_id);
        if (b.attempt > 1) console.error(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
        let outcome: Outcome | null = null;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          let stopAfter = false;
          for (let attempt = 0; outcome === null; attempt++) {
            try {
              outcome = await processRow(row);
            } catch (e) {
              const kind = classifyError(e);
              const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
              if (kind === "thought") {
                outcome = { outcome: "failed", error: msg };
              } else if (kind === "fatal") {
                configError = msg;
                stopping = true;
                console.error(`  ${workerId}: the provider refuses the request itself (${msg.slice(0, 160)}) — stopping every worker; nothing is marked failed`);
                return;
              } else if (attempt < TRANSIENT_PAUSES_MS.length && !stopping) {
                console.error(`  ${workerId}: provider unavailable (${msg.slice(0, 120)}); pausing ${TRANSIENT_PAUSES_MS[attempt] / 1000} s`);
                await Bun.sleep(TRANSIENT_PAUSES_MS[attempt]);
              } else {
                outcome = { outcome: "failed", error: `provider error after ${TRANSIENT_PAUSES_MS.length} retries: ${msg}` };
                stopAfter = true;
              }
            }
          }
          judged++;
          if (stopAfter) console.error(`  ${workerId}: provider still failing — this worker stops after recording this thought; re-run when it is back`);
          if (stopAfter && outcome.outcome === "failed") {
            hb.held.delete(b.thought_id);
            let recorded = false;
            try {
              const rows = (await sql`SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId}, 'failed', ${outcome.error}) AS ok`) as { ok: boolean }[];
              recorded = rows[0]?.ok === true;
            } catch (e) {
              console.error(`  ${b.thought_id}: could not record the failure (${(e as Error).message})`);
            }
            if (recorded) failed++;
            else {
              // Not ours to record: the lease lapsed during the pauses, or the
              // row was returned by hand. Counted with the rows this worker lost.
              lost++;
              console.error(`  ${b.thought_id}: the claim was no longer this worker's at release; the failure below was not recorded`);
            }
            console.error(`  ${b.thought_id}: ${outcome.error}`);
            return;
          }
        }
        // Out of the heartbeat's set before the release goes out, so a beat in
        // flight across the release does not read the released row as lost.
        hb.held.delete(b.thought_id);
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
          console.error(`  ${b.thought_id}: deleted while it was being judged`);
          continue;
        }
        if (!ok) {
          // Not ours to finish: counted with the rows this worker lost, not
          // the ones it finished, so the workers' summaries add up.
          console.error(`  ${b.thought_id}: the claim was no longer this worker's at release — its lease lapsed (no beat reached the database for ${TTL} s) or it was returned by hand with release_claims_for_worker; the row is the pool's or another worker's now`);
          if (outcome.outcome === "failed") console.error(`  ${b.thought_id}: ${outcome.error} (not recorded — the row was not this worker's)`);
          lost++;
          progress();
          continue;
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
    hb.stop();
    beats += hb.beats;
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
  // The pool rule, every pass, from migration 029's consolidation_pool (one
  // definition for this, --status and preflight). No trigger feeds it (see
  // the header), so a --follow poll re-runs the query — a scan of thoughts
  // against the entity table, which is what it costs to be sure a thought is
  // judged only once extraction has reached it.
  const added = Number((await sql`SELECT enqueue_thoughts(${JOB}, ARRAY(SELECT consolidation_pool(${JOB}))) AS added`)[0].added);
  const before = await counts();
  if (added > 0 || !FOLLOW) console.log(`  pool: ${added} thought(s) added`);
  if (firstPass && before.thoughts === 0) console.log("  no thought has extracted entities and a vector — run db/extract-entities.ts first; this pass pairs thoughts by the entities they share" + (FOLLOW ? ", and will poll until some do" : ""));
  firstPass = false;
  total += before.pending + before.claimed;
  if (before.pending + before.claimed === 0) return before;
  if (!FOLLOW || added > 0 || before.pending > 0) printCounts(before, "before");
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  progress(true);
  return counts();
}

console.log(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

let after = await pass();
if (FOLLOW) {
  while (!stopping && !limitReached()) {
    await Bun.sleep(FOLLOW * 1000);
    if (stopping) break;
    after = await pass();
  }
}

const elapsed = (Date.now() - started) / 1000;
console.log(
  `\n  ${done} thought(s) judged, ${failed} failed, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed.toFixed(1)}s ` +
    `(${(llmMs / 1000).toFixed(1)}s in model calls across ${WORKERS} worker(s), ${beats} heartbeat(s))`
);
console.log(
  `  ${totals.pairs} pair(s) judged${judged ? ` — ${(totals.pairs / judged).toFixed(2)} per thought judged, ${Math.round((totals.pairs / judged) * 1000)} calls per thousand thoughts` : ""}; ` +
    `${totals.noCandidates} thought(s) had no candidate; verdicts: ${totals.agree} agree, ${totals.unrelated} unrelated, ${totals.conflict} conflict`
);
console.log(
  `  ${totals.proposed} proposal(s) recorded (${totals.undirected} without a direction)` +
    `${totals.underConfidence ? `, ${totals.underConfidence} conflict(s) under confidence ${MIN_CONFIDENCE} not recorded` : ""}` +
    `${totals.alreadyProposed ? `, ${totals.alreadyProposed} pair(s) already had a proposal` : ""}` +
    `${totals.malformed ? `, ${totals.malformed} answer(s) not JSON of the expected shape` : ""}`
);
if (totals.pairs > 0) console.log(`  model time per pair: ${(llmMs / totals.pairs / 1000).toFixed(1)}s`);
printCounts(after, "after");
await printQueue();
if (after.failed > 0) {
  console.error(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
  await printFailures();
}
if (after.claimed > 0 && !stopping) {
  console.error(`\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed. They return to the pool within ${TTL} s of the holder's last heartbeat; --status names each holder, and a dead one's rows return at once with SELECT release_claims_for_worker(job, worker_id).`);
}
if (after.pending > 0 && !stopping && !limitReached()) {
  console.error(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
}
await sql.close();
if (configError) {
  console.error(
    `\n  The provider refused the request itself: ${configError.slice(0, 300)}\n` +
      `  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_METADATA_MODEL against the provider; a 400 about a request field\n` +
      `  is usually reasoning_effort or response_format not being supported by this model. Nothing was marked failed.`
  );
  await Promise.resolve();
  process.exit(2);
}
const incomplete = after.failed > 0 || after.claimed > 0 || (after.pending > 0 && !limitReached());
process.exit(stopping ? (FOLLOW ? 0 : 130) : incomplete ? 1 : 0);
