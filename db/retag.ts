#!/usr/bin/env bun
/**
 * retag.ts — the tags' re-run path: the capture's tag extractor over every
 * thought whose tags are behind its text, written back through the one edit
 * path with the extractor's recipe (SMD-2298).
 *
 *   bun db/retag.ts --url postgres://…             # the backlog, then exit
 *   bun db/retag.ts --url … --status               # the pool and the backlog; writes nothing
 *   bun db/retag.ts --url … --dry-run              # what a run would do; writes nothing
 *   bun db/retag.ts --url … --limit 25             # a trial: this many thoughts, then stop
 *   bun db/retag.ts --url … --retry-failed         # failed rows back into the pool first
 *   bun db/retag.ts --url … --switch-key           # required when the model or prompt version differs from ob1_config's
 *   bun db/retag.ts --url … --follow [SECONDS]     # then poll every SECONDS (15 bare), pooling again at each, until a signal (exit 0), --limit or a refusal
 *   await run({ url, dryRun: true })               # in-process: import { run } from "./retag.ts"
 *   --workers N (1)   --batch N (1)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease)   --timeout SECONDS (per model call; OB1_LLM_TIMEOUT's, as the capture's, when absent)   --job <key> (a retag: key; a writing run's must be its model's and prompt version's, so in practice --status and --dry-run)
 *   exits 0 clean (a follower stopped by a signal too, once past its start wait) · 1 rows failed, leased or pending · 2 usage, configuration or the provider's refusal · 130 a signal (a second, at once)
 *
 * ── What it re-tags ─────────────────────────────────────────────────────────
 * A thought's tags (`metadata`'s people, action_items, dates_mentioned,
 * topics, type and type_raw) are written by the server's extractor at capture
 * and at an edit, and since 061 a row in `derivations` (artifact_kind
 * `metadata`) names the model, prompt version and hash they came from. Until
 * this worker nothing else wrote them: a raw text move left the row behind,
 * rebuild_derived (063) could only mark it (`stale_since`, "the tags have no
 * pool"), and a thought tagged before 061 had no row at all. The backlog is
 * every thought
 *   - tagged (`type` or `topics`) with no tags row and no failure marker —
 *     preflight's lineage row's "tags with no tag lineage", the same predicate;
 *   - whose tags row is marked (`stale_since`), or names a fingerprint other
 *     than the thought's text — the metadata share of preflight's `marked`
 *     and `stale` counts (preflight counts every kind's rows, and reads at
 *     most 10,000 of them; this reads the table whole);
 *   - whose tags row was made under a recipe other than the recorded key's,
 *     another model or prompt version (PR 3b; decided 2026-11-22: every run,
 *     as re-embed's model is). The key is the tags' target: a run records its
 *     own before it pools, so a first run, or a --switch-key to a new model
 *     or prompt version, re-tags the corpus under it, and a switch cut short
 *     finishes with a plain run. Under another key than the recorded one,
 *     --status and --dry-run count the backlog as recording it finds it,
 *     before anything is recorded;
 *   - whose capture fell back (`metadata_extraction_failed` set), the egress
 *     refusal's marker included: nothing else re-tags a thought the policy
 *     kept from the model at capture (an edit through the server writes no
 *     tags), so it is pooled, and while the policy still refuses it the
 *     worker's own gate fails it naming the rule — once the policy changes,
 *     --retry-failed revisits it.
 *
 * Each claimed thought is read again first: one no longer in the backlog —
 * re-tagged meanwhile by another run, board-sync's re-tag of an issue or a
 * re-capture with the extractor's recipe — is released with no call.
 * Otherwise its standing text goes to server-portable/metadata.ts's
 * extractMetadata, the capture's own call (the prompt, the model, the
 * temperature, the people gate), and the answer is written through the
 * 11-argument update_thought: a patch that makes the row's tags the
 * answer's, key by key — the answer's value where it gives one the row does
 * not hold; where it leaves a key out that the row holds, the key cleared (a
 * list to [], as a reader's jsonb_array_length expects, the type keys to
 * null); a failure marker the row holds cleared; nothing else, so a re-tag
 * that came out the same moves nothing (review passes 1 to 3) — the
 * row's stamp as p_if_unchanged_since, the worker as the actor, and
 * `p_lineage = {"metadata": metadataRecipe(…)}`. Migration 148 makes that
 * write record the tags row — at the text, under the recipe, the mark
 * cleared — even when the tags came out the same, with no event (decided
 * 2026-11-19); when they moved, the edit is one audit event naming
 * db/retag.ts. The run is refused on a brain before 148, where a re-tag that
 * came out the same would settle nothing. A thought edited between the read
 * and the write (STALE_READ) is put back in the pool and re-tagged from its
 * new text; the summary counts it "changed while re-tagged".
 *
 * What the model answers decides the rest, as at a capture:
 *   - the egress policy refuses the thought's text (its actor, source, type,
 *     topics or a marker in it — the gate a capture's call meets, kind
 *     `retag`): nothing is sent, the claim is failed naming the policy's
 *     rule, and --retry-failed revisits it once the policy changes;
 *   - the provider does not answer (a 5xx, a 429, a 408, a connection
 *     refused): the claim workers' rule (db/claim-loop.ts) — paused and called
 *     again, and past the pauses recorded failed and the worker stopped, its
 *     other leases back to the pool; a timeout is the thought's, recorded
 *     failed; a 401, 402, 403, 404 or any other 4xx not below is the
 *     request's, every worker stopped, exit 2, nothing marked failed. A
 *     follower reads them by worker-bootstrap.ts's fault, which asks the
 *     probe, the error carrying none of the provider's words: a model gone
 *     missing mid-run, an outage waited out; a key or base URL refused, the
 *     stop. A 402 is the account's and fatal (PR 4a-2 review passes 1-3);
 *   - an answer that is not tags (not JSON, no content), or a 400, 413 or
 *     422, which are this thought's (its length, a filter): the claim is
 *     failed and nothing is written — the tags the thought had stand. A
 *     capture would have written placeholder tags here; a re-tag never writes
 *     a tag set no model produced over one that one did. But a 400 or 422
 *     to three thoughts in a row, none answered between, is the request's
 *     shape (a field the server refuses: reasoning_effort, response_format),
 *     not the thoughts': the run stops, exit 2, those three failed for
 *     --retry-failed once it is fixed (review pass 2). A follower asks first
 *     (SHAPE_NOTE, one more call): only the note refused as the thoughts
 *     were stops it; answered, they were the thoughts'; anything else (an
 *     outage, the gate) stops nothing, and the next refusal asks again;
 *   - a thought whose metadata is null or no JSON object (a raw writer's)
 *     takes no patch through update_thought: it is failed before any call,
 *     nothing sent (review pass 1).
 *
 * ── The cost, and the key ───────────────────────────────────────────────────
 * One chat call per thought in the backlog, the capture's call. On Daemonic
 * Brain's default — Ollama — that is compute on your own machine and nothing
 * leaves it; pointed at a hosted provider it is money per thought, and each
 * thought's text leaves only as the egress policy (OB1_EGRESS_POLICY,
 * OB1_EGRESS_ALLOW, OB1_EGRESS_DENY) lets it, judged per thought. A policy
 * that refuses every thought stops the run before it claims anything. One
 * worker by default: a re-tag is one short call, which a local model server
 * answers one at a time, and extraction's measurements found a second worker
 * bought 4.6% there (extract-entities.ts's header); --workers is for a
 * hosted provider that serves in parallel. Its calls are background calls,
 * held to the background slots' share (installBackgroundSlots).
 *
 * The pool's key is `retag:<metadata model>@p<METADATA_PROMPT_VERSION>`
 * (db/config.mjs's retagKey). The first run that writes records it in
 * `ob1_config.retag_key`; a run under another key — OB1_METADATA_MODEL set
 * differently in this shell, or a new prompt version — is refused without
 * --switch-key, since the tags would then be a mixture of two models'
 * answers. --status and --dry-run record nothing and register no agent.
 *
 * ── The pool, and what is not here ──────────────────────────────────────────
 * rebuild_derived feeds the pool between runs: a tags row it finds stale is
 * requeued under the key this worker recorded (migration 150, SMD-2298 PR 2).
 * Each run pools the rest of the backlog itself, what no rebuild marked (a
 * thought tagged before 061, a capture that fell back, a text moved raw with
 * no rebuild) — the thoughts not in the pool are added (enqueue_thoughts,
 * which skips a pooled one), and a thought re-tagged before and back in the
 * backlog since is put back (requeue_thought_work's reset, on a row still
 * `succeeded` when it is locked: review pass 1); a failed one waits for
 * --retry-failed, and a claimed one is its holder's. Preflight's
 * `retag pass` row counts the pool and the backlog by the same predicate,
 * db/config.mjs's RETAG_DUE_SQL (PR 3a). The engine takes what a caller like
 * the sleep scheduler passes (PR 4a-1, RetagOptions): the abort of a call in
 * hand, the admit gate, session settings, the banner and summary left out, the
 * start told. --follow (PR 4a-2) runs it on the shared follower helpers
 * (SMD-2636): the model probed before any write, a provider that does not
 * answer at start waited for, a pass a database outage does not end, an
 * outage mid-pass waited out on the heartbeat (heartbeat:retag:<job>), the
 * pool again at every pass. Not here (SMD-2298 PR 4b): the sleep pass.
 * recipes/thought-enrichment's enrich-thoughts.mjs, which wrote its own tag
 * set through the SQL shim, is retired for this (decided 2026-11-15: "not a
 * second re-tag path"; SMD-3318 PR 3b): its summary, importance and
 * confidence fields are not the core's.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * OB1_WORKER_KEY, a key MCP_ACCESS_KEYS holds, names the worker as every
 * claim worker's does (db/worker-bootstrap.ts's workerIdentity): its agent id
 * and name ride the edit's actor, and its name is the egress gate's `actor:`.
 * Without one the edits carry the actor `retag` and no agent id, said once.
 */

import type { SQL } from "bun";
import { ProviderError, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { installBackgroundSlots } from "../server-portable/slots.ts";
import { localKnob, mayLeaveBox, ROW_UNITS, type EgressSubject } from "../server-portable/egress.ts";
import { extractMetadata, metadataRefused, METADATA_PROMPT_VERSION, TAG_KEYS } from "../server-portable/metadata.ts";
import { metadataRecipe } from "../server-portable/lineage.ts";
import { actorPayload } from "../server-portable/store.ts";
import { asPass, withCallWaits } from "../server-portable/model-call.ts";
import { blanketGate, classifyError, databaseUnavailable, egressDescription, egressRefusal, fault, followedPass, lookupOutage, MAX_CALL_TIMEOUT_S, probeAtStart, probeChat, probeRefusal, ProviderOutage, regateMessage, Unreturned, waitAtStart, waitOutProvider, workerIdentity, type FollowerRefusal, type Probe, type StartRefusal, type StartResult } from "./worker-bootstrap.ts";
import { AbortedInHand, admitted, callWaitsFor, DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, heartbeatFor, inHandCalls, leaseHolders, leaseRefusal, MAX_BATCH, MAX_WORKERS, sleepUnless, stopOnSignals, STOPPED_EARLY, type Admit, type InHandAbort, type PassStop } from "./lease.ts";
import { endOnRefusal, passStamper, stampKey, type PassStamper } from "./pass-stamp.ts";
import { blankProblem, commandLine, consoleWriter, flagList, optionReader, type Writer } from "./cli.ts";
import { claimWorker, recordFailedAndStop, releaseFinished, setBackAborted, thoughtFault, type FaultHost, type ReleaseHost } from "./claim-loop.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql, type SessionSettings } from "./connect.ts";
import { parseRetagKey, RETAG_BACKLOG_AS_KEY_SQL, RETAG_BACKLOG_SQL, RETAG_DUE_SQL, RETAG_TAGS_ROW_SQL, retagKey } from "./config.mjs";

/** Every argument accounted for (db/cli.ts): an unknown flag, or one given twice, is refused before anything is read (SMD-2015). */
const FLAGS = {
  url: "one", workers: "one", batch: "one", ttl: "one", heartbeat: "one", timeout: "one", limit: "one", job: "one", follow: "optional",
  status: "none", "dry-run": "none", "retry-failed": "none", "switch-key": "none",
} as const;
const HINTS = { url: "<postgres://…>", job: "<retag:model@pN>", follow: "[SECONDS]" };

/** The ob1_config row the first writing run records its key in. */
export const RETAG_CONFIG_KEY = "retag_key";

/** The egress refusal's marker (metadata.ts's metadataRefused): an answer carrying it is the gate's refusal, not the provider's. */
const REFUSED_MARK = String(metadataRefused().metadata_extraction_failed);

/** The statuses that are this thought's, not the request's: its length or a content filter (400), its size (413), its content (422). */
const THOUGHT_STATUSES: ReadonlySet<string> = new Set(["400", "413", "422"]);
/** A 400 or 422 to this many thoughts in a row, none answered between, is the request's shape, not theirs (review pass 2). */
const SHAPE_STREAK = 3;
/**
 * The note a follower tags, in the request's own shape, when SHAPE_STREAK is reached (review pass 1): an answer at all
 * (tags, or prose) says the shape is taken, so the streak was the thoughts' (their length, a filter) and the follower
 * carries on, where a stop would leave a follower run by hand down until someone restarted it, and one a supervisor
 * runs restarted only to stop again. Exported for test-live [29], which looks for it among the calls.
 */
export const SHAPE_NOTE = "A short note to tag: the request's shape, checked after three thoughts in a row were refused.";
/** What a follower's shape check found (shapeOf): the request's shape refused, taken, or not known. */
type ShapeVerdict = "refused" | "taken" | "unknown";
/** The tag keys whose value is a list: cleared to [], not null, so a reader's jsonb_array_length or _elements meets a list (review pass 2). */
const LIST_TAGS: ReadonlySet<string> = new Set(["people", "action_items", "dates_mentioned", "topics"]);

/**
 * What one re-tag run is asked to do — the CLI's flags, typed. A number left
 * out takes the CLI's default; `timeout` left out is OB1_LLM_TIMEOUT's, the
 * capture's own. `sql`, when given, is the caller's client, used in place of
 * `url` and never closed here; it needs a connection per worker and a spare
 * for the heartbeat, and a run with OB1_WORKER_KEY set needs `url` beside it
 * (the key resolves on a connection of its own). `env` is what the run reads
 * for the model, the endpoints, the egress policy and the worker key:
 * process.env when absent. `signal` is a first stop (the thought in hand
 * finishes, the rest go back to the pool); `onPass` is handed the pass's stop
 * and its InHandAbort as the pass begins, where the CLI installs its signal
 * handlers.
 */
export interface RetagOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  workers?: number;
  batch?: number;
  ttl?: number;
  heartbeat?: number;
  timeout?: number;
  limit?: number;
  job?: string;
  status?: boolean;
  dryRun?: boolean;
  retryFailed?: boolean;
  switchKey?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  /**
   * Called once as the pass begins, with its stop (db/lease.ts's PassStop) and its InHandAbort (SMD-2298 PR 4a-1): the
   * caller aborts each worker's tags call in hand, and the thought goes to the back of the queue (setBackAborted),
   * the worker going on with its next claim — the sleep scheduler's, while a live call wants the model server.
   */
  onPass?: (stop: PassStop, abortInHand: InHandAbort) => void;
  /**
   * The admit gate (db/lease.ts's Admit, SMD-3379 PR 1b), as the other claim workers take it: awaited before the
   * pool step and before each claim. A worker waiting holds no claim; a stop while it waits ends it there. Unused by
   * --status and --dry-run.
   */
  admit?: Admit;
  /** Postgres settings the run's own client opens every connection with (connect.ts's `session`): the sleep scheduler's per-pass budget (SMD-2679). Refused beside `sql`, a caller's client, which it would not reach. */
  session?: SessionSettings;
  /** False leaves out the start's banner — the job, model and egress lines, the agent line or the no-key warning, and the workers line — for a pass a scheduler drives, which says them once (SMD-2752). */
  banner?: boolean;
  /**
   * False leaves out the end-of-run summary — the counts, the failed rows and the still-leased and still-pending
   * lines — for a pass a scheduler drives (SMD-2752). A stop on the request itself still lists the failed rows its
   * line points at (review pass 1).
   */
  summary?: boolean;
  /** How the start went (worker-bootstrap.ts's StartResult), called once: a refusal by its kind, or through (SMD-2752). */
  onStart?: (r: StartResult) => void;
  /**
   * --follow [SECONDS] (SMD-2298 PR 4a-2): after the first pass, pool again and re-tag every SECONDS (15 bare) until a
   * stop (a signal, the caller's), --limit or a refusal. The pool has no capture trigger — rebuild_derived's requeue
   * (150) feeds it, and a raw move or a capture that fell back does not — so each pass pools the backlog again, as
   * re-embed's follower does. A follower probes the model before it writes, waits out a provider that does not answer
   * and a database that does not (followedPass, waitOutProvider: SMD-2636's helpers), and stamps heartbeat:retag:<job>.
   */
  follow?: number;
  /** A follower's heartbeat in place of its own heartbeat:retag:<job> row (db/pass-stamp.ts): the sleep scheduler's. Null stamps nothing. Unused by a one-shot run. */
  stamper?: PassStamper | null;
  /** A follower's start alone (SMD-2752): the banner, the gates, the tables, the model's probe, the worker key — then 0, before the pass's first write, or the start's refusal (2). Needs `follow`. */
  check?: boolean;
  /** The pauses before a failing provider is an outage (TRANSIENT_PAUSES_MS): a suite's own, to run them without the wall clock. */
  pausesMs?: readonly number[];
}

type Numbers = { workers: number; batch: number; ttl: number; heartbeat: number; timeout: number | null; limit: number; follow: number };

/** The run's numbers from its options, or the refusal of the first that breaks its flag's rule, in the CLI's order. */
function numbers(opts: RetagOptions): Numbers | string {
  const read = optionReader(FLAGS, HINTS);
  const workers = read("--workers", opts.workers, 1, { min: 1, max: MAX_WORKERS });
  if (typeof workers === "string") return workers;
  const batch = read("--batch", opts.batch, 1, { min: 1, max: MAX_BATCH });
  if (typeof batch === "string") return batch;
  const ttl = read("--ttl", opts.ttl, DEFAULT_TTL_S);
  if (typeof ttl === "string") return ttl;
  const heartbeat = read("--heartbeat", opts.heartbeat, heartbeatFor(ttl));
  if (typeof heartbeat === "string") return heartbeat;
  const timeout = opts.timeout == null ? null : read("--timeout", opts.timeout, 0, { min: 1, max: MAX_CALL_TIMEOUT_S });
  if (typeof timeout === "string") return timeout;
  const lease = leaseRefusal(ttl, heartbeat, opts.heartbeat == null);
  if (lease) return lease;
  const limit = read("--limit", opts.limit, 0);
  if (typeof limit === "string") return limit;
  const follow = read("--follow", opts.follow, 0);
  if (typeof follow === "string") return follow;
  return { workers, batch, ttl, heartbeat, timeout, limit, follow };
}

/** The re-tag pass, callable: the CLI's run, returning the code the CLI exits with. Nothing happens at import. */
export async function run(opts: RetagOptions): Promise<number> {
  // Its model calls labelled with the pass, for the model-call seam's hook (SMD-3379 PR 2a).
  return asPass("retag", () => runPass(opts));
}

async function runPass(opts: RetagOptions): Promise<number> {
  const { err } = opts.writer ?? consoleWriter;
  /** A refusal of the run's input: said, reported to `onStart` as usage (SMD-2752), 2. */
  const usage = (line: string): number => {
    err(line);
    opts.onStart?.({ ok: false, refused: "usage" });
    return 2;
  };
  const blank = blankProblem(FLAGS, { job: opts.job });
  if (blank !== null) {
    return usage(`${blank}\n${flagList(FLAGS, HINTS)}`);
  }
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    return usage(urlProblem);
  }
  const settled = numbers(opts);
  if (typeof settled === "string") {
    return usage(settled);
  }
  if (opts.job != null && parseRetagKey(opts.job) === null) {
    return usage(`retag.ts: --job names a re-tag pool, retag:<metadata model>@p<prompt version>; this one is of another shape (nothing of it is printed).\n${flagList(FLAGS, HINTS)}`);
  }
  if (opts.sql != null) {
    const handle = opts.sql as { release?: unknown; savepoint?: unknown };
    if (typeof handle.release === "function" || typeof handle.savepoint === "function") {
      return usage("retag.ts needs a pool, not a reserved connection or a transaction's handle. Pass the client itself, or a URL.");
    }
    const max = Number((opts.sql as { options?: { max?: number } }).options?.max ?? 10);
    if (max < settled.workers + 1) {
      return usage(`retag.ts needs a client of at least ${settled.workers + 1} connections for ${settled.workers} worker(s): one each and a spare the heartbeat beats through (db/lease.ts).`);
    }
    if (noUrl && (opts.env ?? process.env).OB1_WORKER_KEY && !opts.status && !opts.dryRun) {
      return usage("retag.ts resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
    }
  }
  if (opts.check && (!settled.follow || opts.status || opts.dryRun)) return usage("retag.ts: check is a follower run's start — pass follow beside it, and no --status or --dry-run.");
  if (opts.session != null && opts.sql != null) return usage("retag.ts: session settings reach the run's own client only: pass url without sql beside them.");
  if (opts.signal?.aborted && !opts.status && !opts.dryRun) {
    err(STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: settled.workers + 1, ...(opts.session ? { session: opts.session } : {}) });
  const detach = new AbortController();
  // The start's refusal ends a follower's own row with its kind, as the other followers' run() does (SMD-3214); never a
  // caller's stamper's.
  let refusedAt: StartRefusal | null = null;
  const heard: RetagOptions = { ...opts, onStart: (r) => { if (!r.ok) refusedAt = r.refused; opts.onStart?.(r); } };
  try {
    const code = await retagWith(sql, heard, settled, detach.signal);
    if (code === 2 && refusedAt !== null && settled.follow && opts.stamper === undefined && !opts.check && !opts.status && !opts.dryRun) {
      const job = opts.job ?? retagKey(resolveEmbedConfig((opts.env ?? process.env) as EmbedEnv).metadataModel, METADATA_PROMPT_VERSION);
      await endOnRefusal({ sql, worker: "retag", job, intervalS: settled.follow, kind: refusedAt, onError: (e) => err(`  heartbeat ${stampKey("retag", job)} not ended on the refusal: ${e.message.split("\n")[0]}`) });
    }
    return code;
  } finally {
    detach.abort();
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** A row the pass works on: the thought as claimed, and whether it is still in the backlog. */
type Row = { id: string; content: string; metadata: Record<string, unknown> | null; stamp: Date; due: boolean };

type Outcome =
  /** Re-tagged: `changed`, whether the write moved the tags (update_thought's metadata_merged); the row settled either way (148). */
  | { outcome: "retagged"; changed: boolean }
  /** No longer in the backlog when claimed: released with no call. */
  | { outcome: "current" }
  /** Failed for the thought; `refused`, by the egress policy. */
  | { outcome: "failed"; error: string; refused?: true }
  | { outcome: "vanished" }
  /** Edited between the read and the write: back in the pool for its new text. */
  | { outcome: "changed" }
  /** Edited meanwhile, and the claim no longer this worker's (its lease lapsed and another run holds it): left to that run. */
  | { outcome: "lostClaim" }
  /** In hand at the hard stop: nothing written, no longer this worker's. */
  | { outcome: "abandoned" }
  /** Its call aborted by the pass's caller (abortInHand), or by the first stop as it waited for a slot (abortWaiting): to the back of the queue, nothing written (setBackAborted); `gone`, not this worker's to set back. */
  | { outcome: "setBack"; gone?: "deleted" | "lost" };

type Counts = { pending: number; claimed: number; succeeded: number; failed: number };
type Backlog = { missing: number; marked: number; stale: number; recipe: number; fallback: number; unpooled: number; due: number };

async function retagWith(sql: SQL, opts: RetagOptions, settled: Numbers, detach: AbortSignal): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const { workers: WORKERS, batch: BATCH, ttl: TTL, heartbeat: HEARTBEAT, limit: LIMIT, follow: FOLLOW } = settled;
  const CHECK = opts.check === true;
  const env = opts.env ?? process.env;
  const STATUS_ONLY = opts.status === true;
  const DRY_RUN = opts.dryRun === true;
  const READ_ONLY = STATUS_ONLY || DRY_RUN;
  const stoppedEarly = (): boolean => {
    if (opts.signal?.aborted !== true) return false;
    err(STOPPED_EARLY);
    return true;
  };

  /** The start's banner, which a pass a scheduler drives leaves to its own start (SMD-2752). */
  const say: Writer["out"] = opts.banner === false ? () => {} : out;
  /** The end-of-run summary, which a pass a scheduler drives leaves out (SMD-2752). */
  const SUMMARY = opts.summary !== false;
  const ADMIT = opts.admit;
  /** A start refusal: said, reported to `onStart` as which it is (SMD-2752), 2. */
  const refuse = (kind: StartRefusal, line: string): number => {
    err(line);
    opts.onStart?.({ ok: false, refused: kind });
    return 2;
  };
  const resolved = resolveEmbedConfig(env as EmbedEnv);
  // --timeout bounds each call as OB1_LLM_TIMEOUT does the capture's (embed.ts's providerCall reads timeoutMs).
  const cfg = settled.timeout === null ? resolved : { ...resolved, timeoutMs: settled.timeout * 1000 };
  const writes = retagKey(cfg.metadataModel, METADATA_PROMPT_VERSION);
  const JOB = opts.job ?? writes;
  // The key is the tags' target recipe (PR 3b): a writing run under a key whose model or prompt version is not the one
  // its tags carry would leave every row it wrote behind the key it records, and the next run would re-tag them again.
  if (JOB !== writes && !READ_ONLY) {
    return refuse("usage", `retag.ts: --job ${JOB} names a recipe this run does not write: its tags carry ${writes}'s (OB1_METADATA_MODEL and this tree's prompt version ${METADATA_PROMPT_VERSION}), so every row it wrote would stay behind ${JOB}. Run under the model and prompt version it names instead — OB1_METADATA_MODEL for the model, the tree whose tag prompt is that version — and leave --job out.`);
  }
  say(`  job:    ${JOB}`);
  say(`  model:  ${cfg.metadataModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}, ${cfg.timeoutMs / 1000} s per call, prompt version ${METADATA_PROMPT_VERSION}`);
  say(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
  {
    // A policy that refuses whatever the thought (SMD-1903): stop before claiming, not one failed row at a time.
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "re-tagged", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !READ_ONLY) return refuse("egress", `\n  ${blanket}`);
  }

  // ── The database's side ─────────────────────────────────────────────────────

  // The lease table, the lineage table with 063's mark, and 148's update_thought, whose same-tags write settles the row.
  const [schema] = (await sql`
    SELECT to_regclass('thought_work_claims') IS NOT NULL AS claims,
           EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('derivations') AND attname = 'stale_since' AND NOT attisdropped) AS marks,
           COALESCE((SELECT p.prosrc LIKE '%ob1:tags-row-settled-by-its-recipe%' FROM pg_proc p
                      WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb, jsonb)')), false) AS settles`) as { claims: boolean; marks: boolean; settles: boolean }[];
  if (!schema.claims || !schema.marks || !schema.settles) {
    return refuse("tables", `\n  ${!schema.claims ? "The lease table (migration 015) is missing" : !schema.marks ? "The lineage table's mark (migration 063) is missing" : "update_thought is older than migration 148: a re-tag that came out the same would leave its row marked"}. Apply the migrations first:\n    cd db && bun migrate.ts --url …`);
  }

  // ── The follower's start probe ──────────────────────────────────────────────

  /** A one-token call to the tags' model (probeChat), bounded by the call's timeout, at most a minute. */
  const probe = (wake?: AbortSignal): Promise<Probe> => probeChat(cfg.chat, cfg.metadataModel, Math.min(cfg.timeoutMs, 60_000), wake);
  /** The start's refusal of what a probe found — the model unserved, or the endpoint refusing — or null (the other followers' words, SMD-2599). */
  function startRefusal(p: Probe): string | null {
    if (p.state === "missing") {
      return `\n  ${cfg.chat.base} does not serve ${cfg.metadataModel} at start (${p.why.slice(0, 300)}).\n` +
        "  A --follow worker refuses this before it claims anything (SMD-2599): pull the model, or set OB1_METADATA_MODEL to one the provider serves. Once running, a model that goes missing is waited for.";
    }
    if (p.state === "refused") {
      return `\n  ${cfg.chat.base} refuses a one-token call at start (${p.why.slice(0, 300)}).\n` +
        "  A --follow worker refuses this before it claims anything (SMD-2599): check the chat endpoint's key (OB1_CHAT_API_KEY, else OB1_LLM_API_KEY) and its base URL (OB1_CHAT_BASE_URL, else OB1_LLM_BASE_URL — an OpenAI-compatible one ends in /v1).";
    }
    return null;
  }
  const refusalAtStart = async (p: Probe): Promise<FollowerRefusal | null> => {
    const line = startRefusal(p);
    return line ? { kind: probeRefusal(p), line } : null;
  };
  /** Why the provider did not answer at start, when it did not: waited for as the run's first step, before the pool. */
  let startOut: string | null = null;
  if (FOLLOW && !READ_ONLY) {
    if (stoppedEarly()) return 130;
    const first = await probeAtStart({ probe, refusal: refusalAtStart, wake: opts.signal });
    if ("refused" in first) return refuse(first.refused.kind, first.refused.line);
    startOut = first.out;
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  let agentId: string | null = null;
  let actorName: string | undefined;
  if (!READ_ONLY) {
    if (stoppedEarly()) return 130;
    // The agent line and the no-key warning are the banner's; a lookup that could not resolve is warned of whatever
    // the banner (SMD-2752, as consolidate's; PR 4a-1 review pass 1).
    const id = await workerIdentity(opts.url ?? "", env, {
      noKeyWarning: opts.banner === false ? "" : "  ⚠  OB1_WORKER_KEY is not set: the re-tags carry the actor `retag` and no agent id. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.",
      write: say,
      warn: (l) => { if (l) err(l); },
      // A follower's lookup outlasts the database going away, as the other followers' does (SMD-2752).
      outage: FOLLOW ? lookupOutage : undefined,
    });
    if (!id.ok) return refuse("identity", id.message);
    agentId = id.identity.agentId;
    actorName = id.identity.keyName;
    // A key that was set but did not resolve is no actor: the gate credited one, so it is asked again without.
    if (env.OB1_WORKER_KEY && actorName === undefined) {
      const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
      if (again) return refuse("lookup", `\n  ${regateMessage("re-tagged", again)}`);
    }
  }
  const actor = actorPayload({ name: actorName ?? "retag", via: "db/retag.ts", session: JOB, ...(agentId ? { agentId } : {}) });

  // ── The backlog ─────────────────────────────────────────────────────────────

  /**
   * Whether thought `t`, beside its tags row `d`, is in the backlog: the
   * header's five kinds, db/config.mjs's RETAG_DUE_SQL over its
   * RETAG_TAGS_ROW_SQL — the definition preflight's `retag pass` row counts by
   * (SMD-2298 PR 3a).
   */
  const due = () => sql.unsafe(RETAG_DUE_SQL);
  const tagsRow = () => sql.unsafe(RETAG_TAGS_ROW_SQL);
  /** The backlog's ids, for the pool's two statements. */
  const backlogIds = () => sql`SELECT t.id FROM thoughts t ${tagsRow()} WHERE ${due()}`;

  async function counts(): Promise<Counts> {
    const rows = (await sql`SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number }[];
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
    return { pending: by.pending ?? 0, claimed: by.claimed ?? 0, succeeded: by.succeeded ?? 0, failed: by.failed ?? 0 };
  }

  const toBacklog = (b: Backlog): Backlog =>
    ({ missing: Number(b.missing), marked: Number(b.marked), stale: Number(b.stale), recipe: Number(b.recipe), fallback: Number(b.fallback), unpooled: Number(b.unpooled), due: Number(b.due) });
  /** The backlog by kind — the first that applies, in the order the header lists them from the row's side — and what the pool step would do with it. */
  async function backlog(): Promise<Backlog> {
    return toBacklog(((await sql.unsafe(RETAG_BACKLOG_SQL, [JOB])) as Backlog[])[0]);
  }
  /** The backlog as a run recording JOB finds it, its recipe the target (PR 3b review pass 2): counted before JOB is recorded. */
  async function backlogAsJob(): Promise<Backlog> {
    return toBacklog(((await sql.unsafe(RETAG_BACKLOG_AS_KEY_SQL, [JOB])) as Backlog[])[0]);
  }
  const behindOf = (b: Backlog): number => b.missing + b.marked + b.stale + b.recipe + b.fallback;

  const printCounts = (c: Counts, label: string): void =>
    out(`  ${label}: ${c.succeeded} re-tagged, ${c.failed} failed, ${c.claimed} in flight, ${c.pending} pending`);
  const printBacklog = (b: Backlog, asKey: string | null = null): void => {
    const total = behindOf(b);
    out(`  backlog: ${total} thought(s) — ${b.missing} tagged with no tags row (before 061), ${b.marked} with the row marked stale, ${b.stale} with the row at other text, ${b.recipe} with the row under another model or prompt version, ${b.fallback} whose capture fell back; ` +
      `${b.unpooled} not yet in the pool, ${b.due} re-tagged before and due again${asKey ? ` — as a run recording ${asKey} finds it` : ""}`);
  };
  async function printFailures(limit = 10): Promise<void> {
    const rows = (await sql`
      SELECT thought_id, attempt_count, last_error FROM thought_work_claims
       WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; attempt_count: number; last_error: string | null }[];
    for (const r of rows) err(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
  }

  const [rec] = (await sql`SELECT value AS key FROM ob1_config WHERE key = ${RETAG_CONFIG_KEY}`) as { key: string }[];
  const recordedKey: string | undefined = rec?.key;
  // Recording JOB moves the target (PR 3b): the backlog as a run recording it finds it, counted before it is recorded.
  const asJob: Backlog | null = recordedKey === JOB ? null : await backlogAsJob();
  const asWords = asJob ? `${behindOf(asJob)} thought(s) behind ${JOB}, ${asJob.recipe} of them by their tags' recipe alone (another model or prompt version)` : "";
  if (recordedKey && recordedKey !== JOB) {
    out(`  ob1_config.${RETAG_CONFIG_KEY} is ${recordedKey}; this run uses ${JOB} — a different model or prompt version; recording it finds ${asWords}`);
    if (opts.switchKey !== true && !READ_ONLY) {
      return refuse("key", `\n  Refusing to re-tag under a key other than the one ob1_config records without --switch-key.\n` +
        `  The thoughts this run touches would carry ${JOB}'s tags beside others' ${recordedKey}'s. If that is the intent,\n` +
        `  pass --switch-key: it records ${JOB} and re-tags what it finds behind it (${asWords});\n` +
        `  if OB1_METADATA_MODEL is simply set differently in this shell, fix it instead.`);
    }
  } else if (!recordedKey) {
    out(`  ob1_config.${RETAG_CONFIG_KEY} is not set: ${READ_ONLY ? "a run sets it" : "this run sets it"}, and finds ${asWords}`);
  }

  // The check ends here, before the pass's first write — the key's record, --retry-failed's, the pool's — and without
  // waiting for a provider that does not answer: each pass waits for it at its own start (SMD-2752).
  if (CHECK) {
    if (startOut !== null) err(`  the provider is not answering at start (${startOut.slice(0, 200)}) — each pass waits for it at its own start`);
    opts.onStart?.({ ok: true, provider: startOut === null ? "up" : "out" });
    return 0;
  }

  if (READ_ONLY) {
    const c = await counts();
    // Under another key than the recorded one, the backlog as recording it finds it: what the run would take.
    const b = asJob ?? await backlog();
    printCounts(c, STATUS_ONLY ? "status" : "before");
    printBacklog(b, asJob ? JOB : null);
    if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) out(describeHolder(h));
    if (c.failed > 0) {
      err(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}) — --retry-failed returns them to the pool:`);
      await printFailures();
    }
    if (DRY_RUN) {
      const todo = c.pending + b.unpooled + b.due + (opts.retryFailed ? c.failed : 0);
      // The refusals a writing run meets, said first (PR 3b review passes 1 and 2: the line said what a refused run
      // would do): a --job recipe this run does not write ends it; another key recorded wants --switch-key, and what
      // follows is what the run does with it.
      if (JOB !== writes) {
        out(`\n  would: refuse this run: --job ${JOB} names a recipe it does not write (its tags carry ${writes}'s). Nothing was written.`);
        return 0;
      }
      const refused = !!recordedKey && recordedKey !== JOB && opts.switchKey !== true;
      out(`\n  would: ${refused ? "refuse this run without --switch-key; with it, " : ""}${recordedKey === JOB ? "" : `record ${JOB} in ob1_config.${RETAG_CONFIG_KEY}; `}` +
        `${opts.retryFailed ? `return ${c.failed} failed row(s) to the pool; ` : ""}add ${b.unpooled} thought(s) to the pool and put ${b.due} back; ` +
        `send up to ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) to ${cfg.metadataModel} with ${WORKERS} worker(s), ${TTL} s leases renewed every ${HEARTBEAT} s. Nothing was written.`);
    }
    return 0;
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  if (stoppedEarly()) return 130;
  if (startOut !== null) {
    // A follower whose first probe got no answer waits for the provider here, before it writes the key, the failed rows'
    // return or the pool; said through a caller's stamper while it lasts (the sleep scheduler's, SMD-2752).
    const waited = await waitAtStart({
      who: "the provider",
      why: startOut,
      meanwhile: `claims nothing until it does; it calls ${cfg.metadataModel} at ${cfg.chat.base} for one token`,
      probe,
      refusal: refusalAtStart,
      wake: opts.signal ?? new AbortController().signal,
      writer: { out, err },
      stamper: opts.stamper ?? null,
    });
    if (waited === null) {
      err(STOPPED_EARLY);
      return 130;
    }
    if (waited !== "up") return refuse(waited.refused.kind, waited.refused.line);
  }
  if (recordedKey !== JOB) {
    await sql`INSERT INTO ob1_config (key, value) VALUES (${RETAG_CONFIG_KEY}, ${JOB})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    out(`  ob1_config.${RETAG_CONFIG_KEY} = ${JOB}`);
  }
  if (stoppedEarly()) return 130;
  if (opts.retryFailed) {
    const [{ n }] = await sql`
      WITH retried AS (
        UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
         WHERE work_type = ${JOB} AND status = 'failed' RETURNING 1)
      SELECT count(*)::int AS n FROM retried`;
    out(`  --retry-failed: ${n} failed row(s) returned to the pool`);
  }
  if (stoppedEarly()) return 130;

  let stopping = false;
  let hardStopped = false;
  let hardRelease: Promise<unknown> | null = null;
  const onStop = new AbortController();
  /**
   * Wakes a worker pausing on the provider, or waiting at the admit gate: the run stopping (the first stop, the
   * provider's refusal, the shape streak, a throw), or under --follow a worker's outage ending the pass. Made again at
   * each pass, as consolidate's is (PR 4a-1 review pass 2): an outage's abort would otherwise end every later pass's gate.
   */
  let halt = new AbortController();
  /** A pass's end of its own — a worker's fatal refusal or its throw — beside the run's stop and halt, for the gate. */
  let passEnds = new AbortController();
  /** The admit gate's signal for the pass (made with halt). */
  let gate: AbortSignal = AbortSignal.any([onStop.signal, halt.signal, passEnds.signal]);
  /** Thoughts pooled across the passes, for the progress line. */
  let total = 0;
  /** Workers that stopped on the provider still failing after its pauses: a pass with one is "failed" on the heartbeat. */
  let providerStops = 0;
  /** The last outage's suspects are retried one at a time, one worker (SMD-2641), as the other followers'. */
  let isolated = false;
  /** The provider answered after a wait: the next pass runs at once, not after an interval (re-embed's rule, SMD-2636 PR 2). */
  let pollNow = false;
  /** The first pass's counts, which the closing remedy reads. */
  let before0: Counts = { pending: 0, claimed: 0, succeeded: 0, failed: 0 };
  let retagged = 0, changedTags = 0, current = 0, failed = 0, refused = 0, changedMeanwhile = 0, vanished = 0, lost = 0, beats = 0, calls = 0;
  let configError = null as string | null;
  /** 400s and 422s to thoughts in a row, none answered between; at SHAPE_STREAK the run stops (configError), a follower once its shape check agrees (shapeOf). */
  let shapeStreak = 0;
  let shapeStopped = false;
  /** A follower's shape check in flight, which every worker reaching the streak meanwhile awaits (review pass 1). */
  let shapeCheck: Promise<ShapeVerdict> | null = null;
  /** A one-shot run stopped at the admit gate before its pass: it ends as it did before the gate joined the pass. */
  let gateStopped = false;
  const activeWorkers = new Set<string>();
  const taken = new Set<string>();
  const claiming = { n: 0 };
  const limitReached = (): boolean => LIMIT > 0 && taken.size + claiming.n >= LIMIT;
  const outage = new ProviderOutage(undefined, undefined, true);
  const unreturned = new Unreturned((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`);
  /** Each worker's tags call for the thought it holds, behind abortInHand (db/lease.ts's inHandCalls, SMD-3379 PR 1b-2; SMD-2298 PR 4a-1). */
  const inCall = inHandCalls(() => detach.aborted || stopping);
  // At the first stop a call waiting for a slot goes back to the pool rather than the stop waiting out others' calls
  // (SMD-3379 PR 2b-1).
  onStop.signal.addEventListener("abort", () => inCall.abortWaiting(), { once: true });
  /** The hard stop's abort for the calls in hand: nothing written, the thought abandoned. */
  const onHardStop = new AbortController();
  const errAside = (line: string): void => {
    try {
      err(line);
    } catch {
      // Nothing awaits this line.
    }
  };
  const started = Date.now();
  const lastReport = { at: 0, line: "" };
  function progress(force = false): void {
    const now = Date.now();
    if (!force && now - lastReport.at < 3000) return;
    const of = LIMIT ? Math.min(LIMIT, total) : total;
    const line = `  ${retagged + current + failed}/${of}  ${retagged} re-tagged${failed ? `, ${failed} failed` : ""}`;
    // The closing line once: not again when the last report already said it.
    if (force && line === lastReport.line) return;
    lastReport.at = now;
    lastReport.line = line;
    out(line);
  }

  /**
   * The shape check (SHAPE_NOTE), read three ways (review pass 2: one way, anything but tags read as the shape, so an
   * outage, an abort or the gate stopped the follower):
   * - "refused": the note met a 400 or 422, as the thoughts did — the request's shape;
   * - "taken": it was answered at all — tags, or prose, as a thought's prose answer resets the streak;
   * - "unknown": anything else — an outage, a timeout, another status, a throw, an abort (a stop, or another worker's
   *   outage halting the pass) — which stops nothing and leaves the streak, so the next refusal asks again. It is
   *   said, and the pass stamped failed: a follower whose every note goes unanswered fails each refused thought, and
   *   its row says so (review pass 3).
   * The gate judges it as the call it stands for — the thought's subject, its text included, which a `marker:` term
   * reads (review pass 3: under the note's own text such an allow list refused every note, and the follower never
   * stopped); only the note's own text is sent.
   */
  async function shapeOf(row: Row, workerId: string): Promise<ShapeVerdict> {
    const subject: EgressSubject = { kind: "retag", ...(actorName ? { actor: actorName } : {}), metadata: row.metadata as Record<string, unknown>, content: row.content };
    const unknown = (why: string): ShapeVerdict => {
      // A stop that aborted the note is the stop's: nothing to say, no pass to mark (review pass 4).
      if (!stopping) {
        providerStops++;
        err(`  the shape check's note was not answered (${why}): nothing known, so nothing stops — the next refusal asks again`);
      }
      return "unknown";
    };
    // The gate first, as a thought's call meets it: a note it refuses is no model call.
    const gate = mayLeaveBox(subject, cfg.chat, cfg.egress);
    if (!gate.allowed) return unknown(`the egress policy refused it: ${gate.reason}`);
    calls++;
    // A call in hand as a thought's is (SMD-2298 PR 4b-1, from PR 4a-2's review pass 2): abortInHand counts and aborts it,
    // as the hard stop and the pass's halt do. An abort is the caller's, said nowhere and marking no pass: nothing known.
    const call = inCall.begin(workerId);
    let answer: Record<string, unknown> | Error;
    try {
      answer = await extractMetadata(SHAPE_NOTE, subject, cfg, AbortSignal.any([halt.signal, onHardStop.signal, call.abort.signal]))
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    } finally {
      inCall.end(workerId);
    }
    if (call.aborted) return "unknown";
    if (answer instanceof Error) return unknown(answer.message.split("\n")[0]);
    const mark = answer.metadata_extraction_failed;
    if (typeof mark !== "string") return "taken";
    if (mark === "provider_400" || mark === "provider_422") return "refused";
    return mark.startsWith("provider_") || mark === REFUSED_MARK ? unknown(mark) : "taken";
  }

  /** One attempt at a thought: the call, then the write. A provider's error is thrown, for thoughtFault to read; a call aborted in hand, as AbortedInHand. */
  async function retagRow(row: Row, workerId: string): Promise<Outcome> {
    if (!row.due) return { outcome: "current" };
    // update_thought merges no patch into SQL NULL (NULL || patch) and grows a non-object into an array (review pass 1):
    // nothing is sent for a thought whose tags could not be written.
    if (row.metadata === null || typeof row.metadata !== "object" || Array.isArray(row.metadata)) {
      return { outcome: "failed", error: `its metadata is ${row.metadata === null ? "null" : "no JSON object"} (a raw writer's): update_thought writes no tags there, so nothing was sent` };
    }
    const subject: EgressSubject = { kind: "retag", ...(actorName ? { actor: actorName } : {}), metadata: row.metadata, content: row.content };
    // The gate the call meets, asked first so a refusal names its rule: nothing is sent for this thought.
    const gate = mayLeaveBox(subject, cfg.chat, cfg.egress);
    if (!gate.allowed) return { outcome: "failed", refused: true, error: `the egress policy refused it: ${gate.reason}; --retry-failed revisits it` };
    calls++;
    // The call in hand is the model call alone: begun here and ended as it returns, so abortInHand counts and aborts no
    // worker that is writing, probing or recording a failure — those it could not set back (review pass 1). Nothing
    // awaits between the answer and the finally, so no abort lands in between.
    const call = inCall.begin(workerId);
    let answer: Record<string, unknown>;
    try {
      answer = await extractMetadata(row.content, subject, cfg, AbortSignal.any([onHardStop.signal, call.abort.signal]));
    } catch (e) {
      // The hard stop aborted it: abandoned, not failed. The pass's caller did (abortInHand), or the first stop as it
      // waited for a slot (abortWaiting): the worker sets it back.
      if (hardStopped) return { outcome: "abandoned" };
      if (call.aborted) throw new AbortedInHand();
      throw e;
    } finally {
      inCall.end(workerId);
    }
    const mark = answer.metadata_extraction_failed;
    if (typeof mark === "string") {
      // What a capture would have recorded, read back as what it was (metadata.ts's markers).
      if (mark === REFUSED_MARK) return { outcome: "failed", refused: true, error: "the egress gate refused the call; --retry-failed revisits it" };
      if (mark === "provider_timeout") throw new ProviderError(`the tags' call timed out after ${cfg.timeoutMs / 1000} s (--timeout, else OB1_LLM_TIMEOUT)`, "timeout");
      const status = /^provider_(\d{3})$/.exec(mark);
      const noTags: Outcome = { outcome: "failed", error: `the answer was no tags (${mark}); nothing was written, the tags the thought had stand — --retry-failed revisits it` };
      // Any other marker is an answer (prose, a shape that is no tags): the request's shape was taken (review pass 3).
      if (!status) shapeStreak = 0;
      // A 400, 413 or 422 is this thought's (its length, a filter); any other status the claim workers' rule reads.
      if (status && !THOUGHT_STATUSES.has(status[1])) throw new ProviderError(`the tags' call answered ${status[1]}`, "http", Number(status[1]));
      if (status && status[1] !== "413" && ++shapeStreak >= SHAPE_STREAK && !configError) {
        // A follower asks the shape first (SHAPE_NOTE): three long thoughts in a row are no reason to hold it down. A
        // one-shot run stops, as before: the operator re-runs it (review pass 1).
        if (FOLLOW) {
          const verdict = await (shapeCheck ??= shapeOf(row, workerId).finally(() => { shapeCheck = null; }));
          if (verdict === "taken") shapeStreak = 0;
          // Stopped only where the note was refused as the thoughts were and the streak still stands when it comes back:
          // a thought answered meanwhile reset it (review pass 2), and a stop or another worker's stop reads first.
          if (verdict !== "refused" || shapeStreak < SHAPE_STREAK || stopping || configError) return noTags;
        }
        configError = `the provider answered ${status[1]} to ${SHAPE_STREAK} thoughts in a row, none answered between — the request's shape, not the thoughts' (often a field the server refuses: reasoning_effort, which OB1_METADATA_REASONING sets, or response_format)`;
        shapeStopped = true;
        stopping = true;
        halt.abort();
      }
      return noTags;
    }
    if (hardStopped) return { outcome: "abandoned" };
    const recipe = metadataRecipe(cfg, answer);
    if (!recipe) return { outcome: "failed", error: "the answer carried none of the extractor's keys; nothing was written" };
    shapeStreak = 0;
    // The answer is the thought's tags, key by key (review pass 3: three passes of filtering tagsOverExisting's nulls
    // each left a seam — a [] dropped over a JSON null, an old tag kept). The answer's value where it gives one the row
    // does not hold; where it leaves out a key the row holds, the key cleared, a list to [] (a reader's
    // jsonb_array_length refuses JSON null) and the type keys to null; a failure marker the row holds, cleared. Nothing
    // else: a re-tag that came out the same sends no change, and 148 settles its row with no event.
    const held = row.metadata as Record<string, unknown>;
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const patch: Record<string, unknown> = {};
    for (const k of TAG_KEYS) {
      const empty = LIST_TAGS.has(k) ? [] : null;
      if (k in answer) {
        if (!same(held[k], answer[k])) patch[k] = answer[k];
      } else if (k in held && !same(held[k], empty)) {
        patch[k] = empty;
      }
    }
    if (!same(held.metadata_extraction_failed, null)) patch.metadata_extraction_failed = null;
    const [r] = (await sql`
      SELECT update_thought(
        ${row.id}::uuid, NULL::text, ${patch}::jsonb, NULL::vector, NULL::jsonb,
        ${row.stamp}::timestamptz, ${actor}::jsonb, NULL::text, NULL::jsonb, NULL::jsonb,
        ${{ metadata: recipe }}::jsonb) AS r`) as { r: { ok: boolean; error?: string; metadata_merged?: boolean } }[];
    if (r.r.ok) return { outcome: "retagged", changed: r.r.metadata_merged === true };
    if (r.r.error === "NOT_FOUND") return { outcome: "vanished" };
    if (r.r.error === "STALE_READ") {
      // Past the hard stop the row may be another worker's: a requeue would take it from its holder.
      if (hardStopped) return { outcome: "abandoned" };
      // requeue_thought_work's reset, on this worker's own claim alone: a lease that lapsed and was taken since is the
      // new holder's (review pass 2, as the pool's requeue).
      const requeued = (await sql`
        UPDATE thought_work_claims
           SET status = 'pending', ttl_expires_at = NULL, attempt_count = 0, last_error = NULL, finished_at = NULL, enqueued_at = now(), worker_id = NULL
         WHERE work_type = ${JOB} AND thought_id = ${row.id}::uuid AND status = 'claimed' AND worker_id = ${workerId}
        RETURNING 1`) as unknown[];
      if (requeued.length > 0) return { outcome: "changed" };
      // No row: pending with no holder is a rebuild's requeue (migration 150 revokes the lease when the text moves), the
      // same as this worker's own; claimed by another worker is a lease that lapsed and was taken since, which that
      // run re-tags (review pass 3; SMD-2298 PR 2 review pass 1: the rebuild's case read as a lapse, and under --limit
      // the thought went unre-tagged).
      const [now] = (await sql`SELECT status FROM thought_work_claims WHERE work_type = ${JOB} AND thought_id = ${row.id}::uuid`) as { status: string }[];
      return now?.status === "pending" ? { outcome: "changed" } : { outcome: "lostClaim" };
    }
    return { outcome: "failed", error: `update_thought: ${r.r.error}` };
  }

  async function worker(n: number): Promise<void> {
    const faults: FaultHost & ReleaseHost = {
      sql, job: JOB, follow: !!FOLLOW, err, outage, inCall, halt: () => halt, limit: LIMIT, taken, progress,
      stopping: () => stopping, hardStopped: () => hardStopped,
      // Under --follow, worker-bootstrap.ts's `fault`, as the other followers read it (SMD-2636 PR 3a): paused for, then an
      // outage; an outage at once (the model missing); the probe's to decide; the thought's; or the request's. A
      // one-shot run keeps classifyError's rules: paused for, the thought's, or the request's.
      read: (e) => {
        // A 402 is the account's: fatal, as classifyError reads it. fault() reads one so only by the provider's words
        // ("can only afford"), which the marker extractMetadata answers with does not carry — it would ask the probe,
        // which one token affords, and fail every thought row by row (review pass 1).
        if (e instanceof ProviderError && e.kind === "http" && e.status === 402) return { act: "fatal", suspect: true };
        if (FOLLOW) return fault(e);
        // A 408 is the provider's moment, as providerDown reads it, not the request's (classifyError's 4xx): paused
        // for, like a 429 (review pass 1: it stopped the run, exit 2).
        if (e instanceof ProviderError && e.kind === "http" && e.status === 408) return { act: "pause", suspect: true };
        const kind = classifyError(e);
        return { act: kind === "transient" ? "pause" : kind, suspect: true };
      },
      ...(opts.pausesMs ? { pausesMs: opts.pausesMs } : {}),
      probe: () => probe(halt.signal),
      fatal: (_e, why) => {
        // The first refusal names the cause; a later one, after the run began to stop, does not overwrite it (review pass 3).
        if (!configError) configError = why;
        stopping = true;
        halt.abort();
        passEnds.abort();
      },
      count: { providerStop: () => { providerStops++; }, failed: () => { failed++; }, lost: () => { lost++; }, vanished: () => { vanished++; } },
    };
    await claimWorker<Row>({
      sql, job: JOB, prefix: "retag", n, ttlS: TTL, heartbeatS: HEARTBEAT, batch: BATCH, limit: LIMIT, follow: !!FOLLOW, admit: ADMIT,
      // The pass's gate (onStop, halt, passEnds): a worker waiting at the admit gate is woken by the run stopping for a
      // reason of its own — another worker's fatal refusal, the shape streak, a throw — not only a stop from outside
      // (PR 4a-1 review pass 1: it waited for the gate to open, and the run with it).
      gate: () => gate, err, errAside, outage, taken, claiming, limitReached, activeWorkers, unreturned, inCall,
      stopping: () => stopping, hardStopped: () => hardStopped, isolated: () => isolated, pollNow: () => { pollNow = true; },
      count: { lost: () => { lost++; }, vanished: () => { vanished++; }, beats: (k) => { beats += k; } },
      readRows: async (ids) => (await sql`
        SELECT t.id, t.content, t.metadata, COALESCE(t.updated_at, t.created_at) AS stamp, ${due()} AS due
          FROM thoughts t ${tagsRow()} WHERE t.id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[],
      row: async (b, row, { workerId, hb, backFirst }) => {
        if (b.attempt > 1) err(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
        let outcome: Outcome | null = null;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          let stopAfter = false;
          const streak = { suspect: false };
          for (let attempt = 0; outcome === null; attempt++) {
            try {
              // A wait for a slot on the model-call seam is no call to abort (SMD-3379 PR 2a, review pass 3).
              outcome = await withCallWaits(callWaitsFor(() => inCall.get(workerId)), () => retagRow(row, workerId));
            } catch (e) {
              if (hardStopped) return "stop";
              // The pass's caller aborted the call in hand (or the first stop its wait for a slot): the thought to the
              // back of the queue, nothing written, and the worker goes on with its next claim; a set-back the database
              // refuses leaves the claim for the finally's release (SMD-3379 PR 1b-2's rule; SMD-2298 PR 4a-1).
              if (e instanceof AbortedInHand) {
                const back = await setBackAborted(faults, { id: b.thought_id, workerId, hb }, "tags call");
                if (back === "stop") return "stop";
                outcome = { outcome: "setBack", ...back };
                continue;
              }
              const turn = await thoughtFault(faults, { id: b.thought_id, workerId, attempt, streak, backFirst }, e);
              if (turn.then === "stop") return "stop";
              if (turn.then === "failed") {
                outcome = { outcome: "failed", error: turn.error };
                stopAfter = turn.stopAfter;
              }
            }
          }
          if (hardStopped) return "stop";
          if (stopAfter && outcome.outcome === "failed") {
            await recordFailedAndStop(faults, { id: b.thought_id, workerId, hb, error: outcome.error });
            return "stop";
          }
        }
        if (outcome.outcome === "abandoned") return "stop";
        // Set back by its call's abort; one deleted or no longer this worker's meanwhile is counted so (review pass 1).
        if (outcome.outcome === "setBack") {
          if (outcome.gone === "deleted") vanished++;
          else if (outcome.gone === "lost") lost++;
          return "next";
        }
        hb.held.delete(b.thought_id);
        if (outcome.outcome === "vanished") {
          vanished++;
          return "next";
        }
        if (outcome.outcome === "lostClaim") {
          lost++;
          err(`  ${b.thought_id}: edited while it was being re-tagged, and its lease lapsed meanwhile — another run holds it now and re-tags it`);
          return "next";
        }
        if (outcome.outcome === "changed") {
          // Pending again with no holder (the requeue): nothing to release. Out of --limit's count, so a claim of it
          // again counts (review pass 1: --limit 1 met STALE_READ, re-tagged nothing and exited 0).
          if (LIMIT > 0) taken.delete(b.thought_id);
          changedMeanwhile++;
          err(`  ${b.thought_id}: edited while it was being re-tagged; it is pending again and will be re-tagged from its new text`);
          return "next";
        }
        const finished = outcome;
        let released = false;
        const next = await releaseFinished(faults, { id: b.thought_id, workerId, hb }, {
          release: async () => {
            const [{ ok }] = (await sql`SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                ${finished.outcome === "failed" ? "failed" : "succeeded"}, ${finished.outcome === "failed" ? finished.error : null}) AS ok`) as { ok: boolean }[];
            released = ok;
            return ok;
          },
          failed: finished.outcome === "failed" ? finished.error : null,
          doing: "re-tagged",
          // A rebuild's requeue (150) that left the text as this worker read it — --force, or a raw move read before the
          // rebuild — lets the write through and takes the claim: the row settled, its next claim finds it current and
          // calls no model (SMD-2298 PR 2 review passes 2 and 3: the line named only a lapse or a hand).
          lapsedWhy: `a rebuild requeued it (db/rebuild.ts, migration 150), its lease lapsed (no beat reached the database for ${TTL} s), or it was returned by hand with release_claims_for_worker`,
          succeeded: () => {
            if (finished.outcome === "retagged") {
              retagged++;
              if (finished.changed) changedTags++;
            } else current++;
          },
        });
        if (released && finished.outcome === "failed" && finished.refused) refused++;
        return next;
      },
    });
  }

  // The pass's stop: a first lets each worker finish the thought in hand; a second returns every lease at once.
  const stop: PassStop = () => {
    if (detach.aborted) return null;
    if (stopping) {
      if (hardRelease) return hardRelease;
      hardStopped = true;
      onHardStop.abort();
      onStop.abort();
      halt.abort();
      hardRelease = Promise.all([...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null)));
      err(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
      return hardRelease;
    }
    stopping = true;
    onStop.abort();
    halt.abort();
    err("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
    return null;
  };
  const abort = () => {
    if (stopping) return;
    stopping = true;
    onStop.abort();
    halt.abort();
    errAside("\n  stopping after the current thought; unfinished claims go back to the pool");
  };
  if (stoppedEarly()) return 130;
  opts.signal?.addEventListener("abort", abort, { once: true, signal: detach });
  opts.onPass?.(stop, inCall.abortInHand);
  opts.onStart?.({ ok: true, provider: "up" });

  // A follower's heartbeat (db/pass-stamp.ts, SMD-2261): stamped after every pass and re-stamped while one runs. A
  // one-shot run stamps nothing. A caller's stamper stands in for the row (the sleep scheduler's).
  const stamper = opts.stamper !== undefined ? (FOLLOW ? opts.stamper : null) : FOLLOW
    ? passStamper({
        sql, worker: "retag", job: JOB, intervalS: FOLLOW,
        // The database gone is said as such, as reembed.ts says it (review pass 2, walkthrough: a grant was blamed).
        onError: (e) => err(`  heartbeat ${stampKey("retag", JOB)} not written: ${e.message.split("\n")[0]} — ${databaseUnavailable(e) ? "the database is not answering" : "a role needs the worker grant group (INSERT, UPDATE on ob1_config)"}${stopping || limitReached() ? "" : "; the follower goes on"}`),
      })
    : null;
  /**
   * Probe until the provider answers (waitOutProvider, SMD-2636 PR 2), said on the row it stamps. The schedule carries
   * on waitOutProvider's rules, counting thoughts settled — re-tagged, already current (no call), failed; an answer
   * polls again at once; a refusal ends the follower, exit 2.
   */
  async function waitForProvider(wake: AbortSignal): Promise<void> {
    const back = await waitOutProvider({
      who: "the provider",
      calls: `${cfg.metadataModel} at ${cfg.chat.base} for one token`,
      outage,
      probe,
      settled: () => retagged + current + failed,
      pollS: FOLLOW,
      pausesBefore: true,
      wake,
      writer: { out, err },
      stamper,
    });
    if (back === "answered") pollNow = true;
    else if (back !== null) {
      if (!configError) configError = back.refused;
      stopping = true;
    }
  }

  let firstPass = true;
  /** A poll that found nothing to do keeps the last pass's word on the heartbeat. */
  let lastPassIdle = false;
  const workersLine = `\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`;
  /**
   * One pass: the leases a worker could not return, the admit gate, the pool — every pass, the backlog having no
   * capture trigger (the header) — and the workers until the pool is empty, a stop or --limit.
   */
  async function pass(): Promise<Counts> {
    halt = new AbortController();
    passEnds = new AbortController();
    gate = AbortSignal.any([onStop.signal, halt.signal, passEnds.signal]);
    await unreturned.returnAll();
    // The admit gate before the pool's writes, as the other claim workers' passes take it (SMD-3379 PR 1b).
    if (ADMIT && !(await admitted(ADMIT, gate))) {
      // A stop while it waits (SMD-2298 PR 4a-1): a one-shot run's ends it with nothing pooled, as before the gate
      // joined the pass — the stop's line, 130, no summary (review pass 1); a follower's ends its loop, and its summary
      // is read as at any stop.
      if (!FOLLOW) {
        gateStopped = true;
        return before0;
      }
      return SUMMARY ? counts() : before0;
    }
    // The pool, every pass, beside rebuild_derived's requeue (150): the backlog not pooled, and a re-tagged one due again.
    const [{ added }] = (await sql`SELECT enqueue_thoughts(${JOB}, ARRAY(${backlogIds()})) AS added`) as { added: number }[];
    // requeue_thought_work's reset, guarded: the UPDATE checks `succeeded` again on the row it locks (READ COMMITTED's
    // recheck), so a thought another run requeued and claimed since this statement began keeps its lease (review pass 1:
    // requeue_thought_work resets whatever the state, a live lease included).
    const requeued = ((await sql`
      UPDATE thought_work_claims c
         SET status = 'pending', ttl_expires_at = NULL, attempt_count = 0, last_error = NULL, finished_at = NULL, enqueued_at = now(), worker_id = NULL
       WHERE c.work_type = ${JOB} AND c.status = 'succeeded' AND c.thought_id IN (${backlogIds()})
      RETURNING 1`) as unknown[]).length;
    const before = await counts();
    if (firstPass) before0 = before;
    if (!FOLLOW || Number(added) > 0 || requeued > 0) {
      out(`  pool: ${Number(added)} thought(s) added, ${requeued} re-tagged before and put back`);
      printCounts(before, "before");
    }
    total += before.pending + before.claimed;
    lastPassIdle = before.pending + before.claimed === 0;
    isolated = !!FOLLOW && outage.isolating();
    if (lastPassIdle) {
      firstPass = false;
      return before;
    }
    if (firstPass && !FOLLOW) say(workersLine);
    firstPass = false;
    if (isolated) err(`  retrying the last outage's ${outage.suspected} suspect thought(s) one at a time${WORKERS > 1 ? `, one worker, before the pass goes back to ${WORKERS}` : ""}; one that errs again alone is blamed only on a one-token call made at once`);
    // A worker that throws stops the rest after the thought in hand, and the pass rejects with its error once they have
    // stopped, not while they still hold rows and the client.
    const ends = await Promise.allSettled(Array.from({ length: isolated ? 1 : WORKERS }, (_, i) => worker(i).catch((e: unknown) => {
      stopping = true;
      halt.abort();
      passEnds.abort();
      throw e;
    })));
    const thrown = ends.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (thrown) throw thrown.reason;
    progress(true);
    return stopping && !SUMMARY ? before : counts();
  }
  // A pass that throws ends the run; its heartbeat says so first, as the worker's end. A pass is "failed" when a worker
  // stopped on the provider still failing after its pauses; one with work "ok" otherwise; an idle poll keeps the word.
  let passOutcome: "ok" | "failed" = "ok";
  const stampedPass = async (): Promise<Counts> => {
    const at = providerStops;
    try {
      const counted = await (stamper ? stamper.during(pass()) : pass());
      if (providerStops > at) passOutcome = "failed";
      else if (!lastPassIdle) passOutcome = "ok";
      return counted;
    } catch (e) {
      // A database outage is no end under --follow: followedPass waits it out (SMD-2599).
      if (!(FOLLOW && databaseUnavailable(e))) await stamper?.end("failed");
      throw e;
    }
  };
  /** A pass a database outage does not end (followedPass, SMD-2599): the counts, or null when a stop ended its wait. */
  const followed = () => followedPass({
    pass: stampedPass,
    // A worker found the provider not answering and ended the pass: the heartbeat says so, and stays a running
    // follower's while it probes (SMD-2261).
    afterPass: async () => {
      if (outage.reason === null || stopping) return;
      await stamper?.stamp("failed");
      await (stamper ? stamper.during(waitForProvider(onStop.signal)) : waitForProvider(onStop.signal));
    },
    follow: !!FOLLOW,
    check: () => sql`SELECT 1`,
    wake: onStop.signal,
    writer: { out, err },
  });

  // A follower says its workers and its polling once, before a first pass that may find nothing (review pass 2,
  // walkthrough: on a brain caught up it never said it was polling); a one-shot run, before the workers start.
  if (FOLLOW) say(workersLine);
  let passed = await followed();
  if (gateStopped) {
    err(STOPPED_EARLY);
    return 130;
  }
  if (FOLLOW) {
    await stamper?.stamp(passOutcome);
    while (!stopping && !limitReached()) {
      if (!pollNow) await sleepUnless(FOLLOW * 1000, onStop.signal);
      pollNow = false;
      if (stopping) break;
      passed = await followed();
      await stamper?.stamp(passOutcome);
    }
    // The follower ends — a signal, its --limit, or the provider refusing the request itself — and the row says so.
    if (configError && opts.stamper === undefined) stamper?.refused?.("provider");
    await stamper?.end(configError ? "failed" : "stopped");
  }
  // Leases a worker could not return as it ended, returned before the run ends where the database answers.
  if (passed !== null) await unreturned.returnAtEnd(TTL, { err });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  // The summary's lines, which a pass a scheduler drives leaves out; its counts are read all the same, for the code.
  const tell: Writer["out"] = SUMMARY ? out : () => {};
  const tellErr: Writer["err"] = SUMMARY ? err : () => {};
  tell(`\n  ${retagged} re-tagged (${changedTags} with the tags changed, ${retagged - changedTags} the same — the row settled), ${current} already current, ` +
    `${failed} failed${refused ? ` (${refused} refused by the egress policy, nothing sent)` : ""}, ${changedMeanwhile} changed while re-tagged and re-queued, ${vanished} deleted mid-pass` +
    `${lost ? `, ${lost} no longer this worker's when checked` : ""}, in ${elapsed}s (${calls} model call(s), ${beats} heartbeat(s))`);
  // A follower stopped while it waited for the database: the counts cannot be read, and are not guessed (SMD-2599). One
  // stopped as it slept between polls holds the last pass's counts, not a database that still answers: one gone
  // meanwhile reads as a stop while it waited (review pass 1: the read threw, exit 1 with a stack).
  const after = passed === null ? null : await counts().catch((e: unknown) => {
    if (FOLLOW && databaseUnavailable(e)) return null;
    throw e;
  });
  if (after === null) {
    if (SUMMARY) err(`\n  stopped while the database was not answering: the pool's counts are not read — --status reads them once it answers`);
    if (configError) err(`\n  The provider refused the request itself: ${configError.slice(0, 300)}`);
    return configError ? 2 : hardStopped ? 130 : 0;
  }
  if (SUMMARY) printCounts(after, "after");
  if (after.failed > 0 && SUMMARY) {
    err(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
    await printFailures();
  }
  if (after.claimed > 0 && !stopping) {
    tellErr(`\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed. They return to the pool within ${TTL} s of the holder's last heartbeat.`);
  }
  if (after.pending > 0 && !stopping && !limitReached()) {
    tellErr(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
  }
  if (configError) {
    if (!SUMMARY && after.failed > before0.failed) {
      err(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}):`);
      await printFailures();
    }
    err(`\n  The provider refused the request itself: ${configError.slice(0, 400)}\n` +
      "  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_METADATA_MODEL against the provider. " +
      (shapeStopped ? "The thoughts it answered so are failed (listed above): once it is fixed, re-run with --retry-failed."
        : after.failed > before0.failed ? "The rows failed before it are listed above." : "Nothing was marked failed."));
    return 2;
  }
  if (stopping) return FOLLOW && !hardStopped ? 0 : 130;
  const incomplete = after.failed > 0 || after.claimed > 0 || (after.pending > 0 && !limitReached());
  return incomplete ? 1 : 0;
}

if (import.meta.main) {
  const cli = commandLine("retag.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  // Background calls held to their share, once for the process (SMD-3379 PR 2b-1).
  installBackgroundSlots({ url, raw: process.env.OB1_BACKGROUND_SLOTS, modelSlots: process.env.OB1_MODEL_SLOTS });
  const workers = cli.int("workers", { absent: 1, min: 1, max: MAX_WORKERS });
  const batch = cli.int("batch", { absent: 1, min: 1, max: MAX_BATCH });
  const ttl = cli.int("ttl", { absent: DEFAULT_TTL_S, min: 1 });
  const heartbeat = cli.has("heartbeat") ? cli.int("heartbeat", { absent: DEFAULT_HEARTBEAT_S, min: 1 }) : undefined;
  const timeout = cli.has("timeout") ? cli.int("timeout", { absent: 0, min: 1, max: MAX_CALL_TIMEOUT_S }) : undefined;
  const lease = leaseRefusal(ttl, heartbeat ?? heartbeatFor(ttl), heartbeat === undefined);
  if (lease) {
    console.error(lease);
    process.exit(2);
  }
  const limit = cli.has("limit") ? cli.int("limit", { absent: 0, min: 1 }) : undefined;
  const follow = cli.has("follow") ? cli.int("follow", { absent: 0, bare: 15, min: 1 }) : undefined;
  const sql = openSql(url, { max: workers + 1 });
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, workers, batch, ttl, heartbeat, timeout, limit, follow,
      job: cli.value("job"),
      status: cli.has("status"),
      dryRun: cli.has("dry-run"),
      retryFailed: cli.has("retry-failed"),
      switchKey: cli.has("switch-key"),
      onPass: (stop) => { uninstall = stopOnSignals(stop); },
    }).finally(() => uninstall());
  });
}
