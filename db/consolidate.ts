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
 *   bun db/consolidate.ts --url … --list [pending|accepted|rejected|stale|lineage|all]   # the queue, with both thoughts; lineage: the unreviewed rows standing on a lineage pair (070)
 *   bun db/consolidate.ts --url … --accept <proposal-id> [--direction newer|older] [--note "…"] [--force]   # --force: a text edited since judged, a stale row, or a lineage pair (070)
 *   bun db/consolidate.ts --url … --reject <proposal-id> [--note "…"]
 *   await run({ url, dryRun: true })                      # a dry run, in-process: import { run } from "./consolidate.ts" (SMD-2304)
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
 * ── Stale proposals ─────────────────────────────────────────────────────────
 * A pending proposal whose text moved under the verdict is set `stale` by
 * migration 063's rebuild_derived (a text edit, a supersession, a forget) and
 * its newer thought requeued under the key that judged it. A stale row is
 * THIS pass's work, whatever key wrote it (migration 067, SMD-2297): every
 * run first re-pools each stale row's newer thought under its own key (a pair
 * both sides of which have a vector, with no live or failed claim here — a
 * failed claim is --retry-failed's, 015's rule), then judges the thought's
 * pairs again — up to --k model calls per re-pooled thought, since its
 * agree/unrelated pairs left no record, plus one per stale pair the top-k
 * left out that still meets the candidate rule, judged anyway. A conflict at the
 * floor REPLACES the row in place (063:
 * record_supersession_proposal, back to pending under this key); agree,
 * unrelated or a conflict under the floor SETTLES it — the row is rejected
 * with a note beginning `settled by the pass:` (the marker rebuild_derived
 * reads: a later text move under a pass-settled row sets it stale again,
 * where a person's rejection stands for ever) and its lineage row rewritten
 * at the texts judged, through settle_supersession_proposal. A stale pair the
 * rule no longer admits for a reason that means "no conflict" — no shared
 * entity, under the similarity floor, a side superseded — is settled with a
 * note saying so; one a side of which has no vector yet waits for the reembed
 * pool and the run after its write. A stale pair whose call timed out, was
 * refused by the egress gate or drew a malformed answer leaves the row stale
 * and the thought failed, as any such pair does — --retry-failed revisits it.
 * 029's posture stands: the pass proposes and never applies — a rejection
 * applies nothing. --status and --list stale say where each stale row stands
 * against THIS pass's pool (in it, waiting for a vector, failed in this pass
 * — --retry-failed, waiting for the next run — a claim under another judge's
 * key named beside it); db/rebuild.ts --status reads the same rows keyless
 * and names the keys.
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

import type { SQL } from "bun";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { PROVIDER_ERROR_CHARS, ProviderError, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, ROW_UNITS } from "../server-portable/egress.ts";
import { blanketGate, classifyError, egressDescription, egressRefusal, regateMessage, TRANSIENT_PAUSES_MS, workerIdentity } from "./worker-bootstrap.ts";
import {
  actorKindOf, cleanForDisplay, consolidateKey, judgePair, passSettledNote, proposalVerdict, staleStandings, staleStandingsText, staleStandingText,
  DEFAULT_CANDIDATES, DEFAULT_MIN_CONFIDENCE, DEFAULT_MIN_SIMILARITY, PASS_SETTLED_PREFIX, STALE_STANDING_ROWS_SQL,
  type Judgement, type StaleStandingRow,
} from "../server-portable/consolidate.ts";
import { actorPayload, isoDay } from "../server-portable/store.ts";
import { proposalRecipe } from "../server-portable/lineage.ts";
import { DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, heartbeatFor, leaseHolders, leaseRefusal, reportLost, sleepUnless, startHeartbeat, stopOnSignals, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

/**
 * Every argument accounted for (db/cli.ts): a flag this worker does not have
 * is refused — `--K 10` for `--k 10` ran the default and exited 0, so a trial
 * measured something other than what was asked (SMD-2015). A numeric flag
 * present with no value is an error, not the default (extract-entities.ts's
 * rule); --follow, --stale and --list take theirs optionally. run()'s
 * refusals of a number end with the same flag list the CLI's do.
 */
const FLAGS = {
  url: "one", workers: "one", batch: "one", ttl: "one", heartbeat: "one", timeout: "one",
  k: "one", "min-sim": "one", "min-confidence": "one", limit: "one", follow: "optional", stale: "optional", dump: "one",
  list: "optional", accept: "one", reject: "one", direction: "one", note: "one", force: "none",
  status: "none", "dry-run": "none", "retry-failed": "none",
} as const;
const HINTS = { url: "<postgres://…>", follow: "[SECONDS]", stale: "[DAYS]", dump: "<verdicts.jsonl>", list: "[pending|accepted|rejected|stale|lineage|all]", accept: "<proposal id>", reject: "<proposal id>", direction: "<newer|older>", note: "<text>", force: "(with --accept)" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_STATUSES = ["pending", "accepted", "rejected", "stale", "lineage", "all"];

/**
 * What one consolidation run is asked to do — the CLI's flags, typed
 * (SMD-2304). A number left out takes the CLI's default, and one given is
 * held to its flag's rule and refused in the CLI's words; `follow` is
 * --follow's poll interval in seconds (the bare flag's is 15), `stale` the
 * days of --stale (the bare flag's is 90), and `list` the status --list
 * shows ("pending" for the bare flag). An absent option may also be null.
 *
 * `sql`, when given, is the caller's client — used in place of `url`, and
 * never closed here. It needs a connection per worker and a spare the
 * heartbeat beats through (db/lease.ts), so at least workers + 1 (the `max`
 * option), free for the run: a pool another run or caller is using at the
 * same time takes the spare. A reserved connection or a transaction's handle
 * is refused. The worker key resolves on a connection of its own
 * (db/worker-bootstrap.ts), so a run or a decision with OB1_WORKER_KEY set
 * needs `url` beside `sql`. `env` is what the run reads for the judge model,
 * the endpoints, the egress policy and the worker key: process.env when
 * absent.
 *
 * `signal` stops the pass as the CLI's first signal does: every worker after
 * the thought in hand, its unfinished claims back to the pool, and wakes a
 * follower's sleep. Aborted before the pass begins, it stops the run before
 * its next write — the agent's registration, a --retry-failed statement, the
 * pool — and run() returns 130 (a statement already committed stays so); a
 * decision (--accept, --reject) stops the same way, before the key resolves
 * and before the decision is written, saying so. --status, --dry-run, --list
 * and --stale only read, and do not read it.
 * `onPass` is called once, as a run's pass begins — a decision has none — where the CLI installs its
 * signal handlers (stopOnSignals) — with the pass's stop (db/lease.ts's
 * PassStop). Its hard stop returns the leases at once, aborts the judge's
 * call in hand and wakes a worker pausing on a provider error, and run()
 * returns 130 (2 after the provider's refusal), writing and releasing nothing
 * more for the thought in hand; a call after run() has returned does nothing.
 */
export interface ConsolidateOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  workers?: number;
  batch?: number;
  ttl?: number;
  heartbeat?: number;
  timeout?: number;
  k?: number;
  minSim?: number;
  minConfidence?: number;
  limit?: number;
  follow?: number;
  stale?: number;
  /** --dump <file>: append every verdict as JSONL (below). */
  dump?: string;
  list?: string;
  accept?: string;
  reject?: string;
  direction?: string;
  note?: string;
  force?: boolean;
  status?: boolean;
  dryRun?: boolean;
  retryFailed?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
}

/** What run() says when a caller's signal stopped a decision before it was written — a decision has no pass (review pass 2). */
const DECISION_STOPPED = "\n  stopped before the decision was written: the caller's signal was aborted";

/** The run's numbers, each the option given or the CLI's default. */
type Numbers = { workers: number; batch: number; ttl: number; heartbeat: number; timeout: number; k: number; minSim: number; minConfidence: number; limit: number; follow: number; stale: number };

/**
 * The run's numbers from its options, or the refusal of the first that breaks
 * its flag's rule, in the order the CLI reads them — the lease pair checked
 * between them, where the CLI checks it — so run() and the CLI refuse the same
 * input first.
 */
function numbers(opts: ConsolidateOptions): Numbers | string {
  const read = (flag: string, v: number | null | undefined, absent: number, rule: { min: number; max?: number; fraction?: boolean } = { min: 1 }): number | string => {
    if (v == null) return absent;
    const problem = numberProblem(flag, v, rule);
    return problem === null ? v : `${problem}\n${flagList(FLAGS, HINTS)}`;
  };
  const workers = read("--workers", opts.workers, 2);
  if (typeof workers === "string") return workers;
  // One thought per claim: up to --k model calls per thought against a claim of
  // half a millisecond, so a bigger batch buys nothing, and a worker that dies
  // holds fewer rows. (Until migration 031 the lease was stamped once per batch
  // and could not be moved, so a batch of several at a long timeout could
  // outlive it; the heartbeat retires that reason.)
  const batch = read("--batch", opts.batch, 1);
  if (typeof batch === "string") return batch;
  // The lease is renewed on a heartbeat while the worker holds rows, so it has
  // to outlast a missed beat, not the batch — db/lease.ts holds the rule the
  // three consumers share, and the refusal below is its.
  const ttl = read("--ttl", opts.ttl, DEFAULT_TTL_S);
  if (typeof ttl === "string") return ttl;
  const heartbeat = read("--heartbeat", opts.heartbeat, heartbeatFor(ttl));
  if (typeof heartbeat === "string") return heartbeat;
  const timeout = read("--timeout", opts.timeout, 120);
  if (typeof timeout === "string") return timeout;
  const k = read("--k", opts.k, DEFAULT_CANDIDATES, { min: 1, max: 50 });
  if (typeof k === "string") return k;
  const minSim = read("--min-sim", opts.minSim, DEFAULT_MIN_SIMILARITY, { min: -1, max: 1, fraction: true });
  if (typeof minSim === "string") return minSim;
  const minConfidence = read("--min-confidence", opts.minConfidence, DEFAULT_MIN_CONFIDENCE, { min: 0, max: 1, fraction: true });
  if (typeof minConfidence === "string") return minConfidence;
  const lease = leaseRefusal(ttl, heartbeat, opts.heartbeat == null);
  if (lease) return lease;
  const limit = read("--limit", opts.limit, 0);
  if (typeof limit === "string") return limit;
  const follow = read("--follow", opts.follow, 0);
  if (typeof follow === "string") return follow;
  const stale = read("--stale", opts.stale, 0);
  if (typeof stale === "string") return stale;
  return { workers, batch, ttl, heartbeat, timeout, k, minSim, minConfidence, limit, follow, stale };
}

/**
 * The review flags' own rules — which combine, what a --list word may be, a
 * proposal id's shape, a note's marker — as the refusal of the first broken,
 * in the CLI's order and words, or null. Pure: no database, no output; run()
 * and the CLI both refuse through it (SMD-2304).
 */
export function reviewProblem(opts: Pick<ConsolidateOptions, "list" | "accept" | "reject" | "direction" | "force" | "note" | "limit">): string | null {
  const { list, accept, reject, direction, note } = { list: opts.list ?? undefined, accept: opts.accept ?? undefined, reject: opts.reject ?? undefined, direction: opts.direction ?? undefined, note: opts.note ?? undefined };
  if (list !== undefined && !LIST_STATUSES.includes(list)) return "--list takes pending, accepted, rejected, stale, lineage or all (or nothing, for pending).";
  for (const [name, v] of [["accept", accept], ["reject", reject]] as const) {
    if (v !== undefined && !UUID_RE.test(v)) return `--${name} needs a proposal id (a UUID from --list or the list_supersession_proposals tool).`;
  }
  if (accept && reject) return "--accept and --reject are one decision each; pass one.";
  if (direction !== undefined && (!accept || !["newer", "older"].includes(direction))) return "--direction takes newer or older, and only with --accept.";
  if (opts.force === true && !accept) return "--force goes with --accept: it accepts a proposal whose thought was edited after it was judged, one gone stale, or one standing on a lineage pair (070).";
  // The pass's thought cap: beside --list it would be dropped without a word (SMD-2015's kind) — the
  // listing prints up to 50 of a status and --status counts them all (adversarial re-run, third review pass).
  if (opts.limit != null && list !== undefined) return "--limit is the pass's thought cap and goes with a run; --list prints up to 50 of a status (--status counts them all).";
  // Read only by the decision: beside anything else it would be dropped without a word (SMD-2015's kind).
  if (note !== undefined && !accept && !reject) return "--note goes with --accept or --reject: it is recorded with the decision.";
  // 067: the marker is the pass's own — a person's note beginning with it would
  // be read by rebuild_derived as the pass's decision and reopened on a text
  // move (second review pass's brief, cold read: the door admitted it).
  if (note !== undefined && note.trimStart().startsWith(PASS_SETTLED_PREFIX)) {
    return `--note may not begin with "${PASS_SETTLED_PREFIX}": that marker is the pass's own (migration 067) — rebuild_derived reads a rejection carrying it as the pass's and sets it stale again when a text moves.`;
  }
  return null;
}

/**
 * The consolidation pass and the review, callable: the CLI's run, returning
 * the code the CLI exits with — 0 clean, 1 rows failed, leased or pending (or
 * a review refused), 2 usage, configuration or the provider's refusal, 130 a
 * signal; --follow stopped by a first signal, 0. Nothing happens at import. A
 * database error outside a thought's own handling rejects, as the CLI's stack
 * dump always showed; run()'s own client is closed first.
 */
export async function run(opts: ConsolidateOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  // databaseUrl's two refusals without its exit, then the numbers and the
  // review flags. A URL beside a caller's client is the worker key's (above),
  // so it is held to the rule too.
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  const settled = numbers(opts);
  if (typeof settled === "string") {
    err(settled);
    return 2;
  }
  const review = reviewProblem(opts);
  if (review !== null) {
    err(review);
    return 2;
  }
  const reviewing = opts.list != null || opts.accept != null || opts.reject != null || settled.stale > 0;
  const deciding = opts.accept != null || opts.reject != null;
  // A run and a decision write — resolve the key, and stop under an aborted
  // signal; --status, --dry-run, --list and --stale only read (review pass 2:
  // the two rules had drifted apart for a decision beside --dry-run).
  const writes = deciding || !(opts.status || opts.dryRun || reviewing);
  if (opts.sql != null) {
    // A reserved connection or a transaction's handle reports its pool's max
    // but is one connection, and a transaction keeps the run's claims from the
    // other workers — and a rollback from the database.
    const handle = opts.sql as { release?: unknown; savepoint?: unknown };
    if (typeof handle.release === "function" || typeof handle.savepoint === "function") {
      err("consolidate.ts needs a pool, not a reserved connection or a transaction's handle: either is one connection whatever max it reports, and a transaction's claims are no other worker's until it commits. Pass the client itself, or a URL.");
      return 2;
    }
    // One connection per worker and one spare: the heartbeat (db/lease.ts)
    // beats through the pool, and a worker parked on a lock or a long statement
    // holds its own connection, so the spare is what keeps every worker's
    // leases alive then. Tightening this to the workers would recreate the
    // lapse 031 removed. Bun's default pool is ten.
    const max = Number((opts.sql as { options?: { max?: number } }).options?.max ?? 10);
    if (max < settled.workers + 1) {
      err(`consolidate.ts needs a client of at least ${settled.workers + 1} connections for ${settled.workers} worker(s): one each and a spare the heartbeat beats through (db/lease.ts). Pass a client opened with a larger max option, or a URL.`);
      return 2;
    }
    if (noUrl && (opts.env ?? process.env).OB1_WORKER_KEY && writes) {
      err("consolidate.ts resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
      return 2;
    }
  }
  // A signal aborted before the call: nothing opened, nothing written. --status,
  // --dry-run, --list and --stale only read, and read on; a decision writes, and
  // stops as a run does (review pass 1).
  if (opts.signal?.aborted && writes) {
    err(deciding ? DECISION_STOPPED : STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: settled.workers + 1 });
  // Aborted when the run returns, taking its listener off the caller's signal.
  const detach = new AbortController();
  try {
    return await consolidateWith(sql, opts, settled, out, err, detach.signal);
  } finally {
    detach.abort();
    // A failing close must not mask the run's own error.
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** The run once its options are settled: the script's body as it was, printing through the Writer and returning where it exited. */
async function consolidateWith(sql: SQL, opts: ConsolidateOptions, settled: Numbers, out: Writer["out"], err: Writer["err"], detach: AbortSignal): Promise<number> {
  const { workers: WORKERS, batch: BATCH, ttl: TTL, heartbeat: HEARTBEAT, timeout: TIMEOUT_S, k: K, minSim: MIN_SIM, minConfidence: MIN_CONFIDENCE, limit: LIMIT, follow: FOLLOW, stale: STALE_DAYS } = settled;
  const env = opts.env ?? process.env;
  /** Append every verdict here as JSONL — {newer, older, similarity, shared, verdict, supersedes, confidence, reason, key, proposal} — for evals/eval-consolidate.ts. */
  const DUMP = opts.dump ?? undefined;
  const STATUS_ONLY = opts.status === true;
  const DRY_RUN = opts.dryRun === true;
  const RETRY_FAILED = opts.retryFailed === true;
  const LIST = opts.list ?? undefined;
  const ACCEPT = opts.accept ?? undefined;
  const REJECT = opts.reject ?? undefined;
  const DIRECTION = opts.direction ?? undefined;
  const FORCE = opts.force === true;
  const NOTE = opts.note ?? undefined;
  /**
   * A caller's signal aborted before the pass began stops the run before its
   * next write — the agent's registration, the --retry-failed statement, the
   * pool — returning 130, as a signal before the CLI's handlers ends the
   * process where it stands.
   */
  const stoppedEarly = (): boolean => {
    if (opts.signal?.aborted !== true) return false;
    err(ACCEPT !== undefined || REJECT !== undefined ? DECISION_STOPPED : STOPPED_EARLY);
    return true;
  };
  const REVIEW_ONLY = LIST !== undefined || ACCEPT !== undefined || REJECT !== undefined || STALE_DAYS > 0;

  const cfg = resolveEmbedConfig(env as EmbedEnv);
  // The judge's model, not the extractor's: OB1_JUDGE_MODEL, else the metadata
  // model (SMD-1901). The key carries it, so a pass under another judge is
  // another pass — --status and preflight report each by name.
  const JOB = consolidateKey(cfg.judgeModel);

  out(`  job:    ${JOB}`);
  // Which knob named it is read off the resolved pair, not the raw variable: a
  // value the resolver treats as unset (empty, or the metadata model's own name)
  // is the metadata model here too, however it was spelled.
  if (!REVIEW_ONLY) out(`  model:  ${cfg.judgeModel}${cfg.judgeModel !== cfg.metadataModel ? " (OB1_JUDGE_MODEL)" : " (the metadata model; OB1_JUDGE_MODEL gives the judge its own)"} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}; up to ${K} older neighbour(s) per thought at cosine >= ${MIN_SIM}, conflicts recorded at confidence >= ${MIN_CONFIDENCE}`);
  // What may leave the box (SMD-1903): a pair either row of which the gate
  // refuses is not judged, and the thought's claim fails naming the rule.
  if (!REVIEW_ONLY) out(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
  {
    // A policy that refuses whatever the row (SMD-1903): stop before claiming,
    // rather than fail every row in the pool one at a time. A dry run and
    // --status still report — the banner's egress line says why a run would not.
    // The units a row of this pass carries: its metadata and text, and the
    // worker key's name as the actor when one is set — re-checked below once
    // the key has, or has not, resolved (third review pass).
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "judged", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !STATUS_ONLY && !DRY_RUN && !REVIEW_ONLY) {
      err(`\n  ${blanket}`);
      return 2;
    }
  }

  // ── The database's side ─────────────────────────────────────────────────────

  const [{ tables }] = await sql`
    SELECT count(*)::int AS tables FROM pg_class
    WHERE relname IN ('thought_work_claims', 'thought_entities', 'supersession_proposals') AND relkind = 'r'`;
  if (Number(tables) < 3) {
    err("\n  The lease table, the entity tables or the proposal table are missing. Apply migrations 015, 016 and 029 first:\n    cd db && bun migrate.ts --url …");
    return 2;
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
  /** The worker key's name when it RESOLVED — the egress gate's `actor:` unit; the audit label above is not an actor (third review pass). */
  let keyName: string | undefined;
  // A run, or a review: both write and are attributed. --status, --dry-run, --list and --stale only read.
  const WRITES = ACCEPT !== undefined || REJECT !== undefined || !(STATUS_ONLY || DRY_RUN || REVIEW_ONLY);
  if (WRITES) {
    if (stoppedEarly()) return 130;
    // Without a key the URL is not read; with one, run() refused a missing URL.
    const id = await workerIdentity(opts.url ?? "", env, {
      noKeyWarning: `  ⚠  OB1_WORKER_KEY is not set: ${ACCEPT || REJECT ? "the review is audited as 'consolidate' with no agent id" : "proposals will carry no agent id"}. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.`,
      write: out,
      warn: err,
    });
    if (!id.ok) {
      err(id.message);
      return 2;
    }
    agentId = id.identity.agentId;
    keyName = id.identity.keyName;
    // The audit label above is not an actor; the resolved key's name, when there
    // is one, is (third review pass).
    if (keyName) actorName = keyName;
    // A key that was set but did not resolve to a name is no actor: the blanket
    // check above credited one, so it is asked again without (third review pass).
    if (env.OB1_WORKER_KEY && keyName === undefined && !REVIEW_ONLY) {
      const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
      if (again) {
        err(`\n  ${regateMessage("judged", again)}`);
        return 2;
      }
    }
  }

  /**
   * The pass as an actor for review_supersession_proposal — a person's review
   * through --accept/--reject, or the pass's own settle of a stale row (067).
   * `via`, the door (046's origin column) — `source` until SMD-1730, when the
   * trigger stopped reading an actor's source.
   */
  const passActor = () => actorPayload({ name: actorName, via: "consolidate", session: JOB, agentId: agentId ?? undefined });

  /** 067: the stale rows' standings against the pools under THIS key, as --status prints them (server-portable/consolidate.ts holds the one read, the rank and the words; db/rebuild.ts reads the same, keyless). */
  const readStaleStandings = async () => staleStandings((await sql.unsafe(STALE_STANDING_ROWS_SQL)) as StaleStandingRow[], JOB);
  /** 070: --status's clause for the unreviewed rows standing on a lineage pair — the listing named, or the file it needs first (its own SQL reads on a brain at 068). */
  const lineageClause = (n: number, has069: boolean): string =>
    `${n} unreviewed standing on a lineage pair (${has069 ? "--list lineage shows them" : "apply migration 070 first — cd db && bun migrate.ts --url <url> — then --list lineage shows them"}; the reviewer rejects each — the pass never replaces a pending one)`;
  const staleClause = (st: ReturnType<typeof staleStandings>): string =>
    `${st.total} stale (a text moved under the verdict: ${staleStandingsText(st, JOB)}; the pass replaces one it finds in conflict again and settles one it does not)`;

  // ── Review: --list, --accept, --reject, --stale ─────────────────────────────

  // A timestamptz as Bun's driver hands it over on these raw reads: a Date, the
  // number ±Infinity for infinity, null — not the store's ISO string (SMD-1842).
  type Stamp = Date | number | string | null;
  type Listed = {
    id: string; status: string; verdict: string; confidence: string; reason: string | null; similarity: number | null;
    judge_key: string; judged_at: Stamp; reviewed_at: Stamp; review_note: string | null; superseding_id: string | null;
    older_id: string; older_content: string; older_created_at: Stamp; newer_id: string; newer_content: string; newer_created_at: Stamp;
    older_edited: boolean; newer_edited: boolean;
    /** 070 (SMD-2313): one side's derived_from names the other — a pair 066's candidate filter never proposes; a standing row is the reviewer's to reject. */
    lineage: boolean;
  };
  /** The reject a reviewer runs on a lineage pair, as --list prints it beside the row and preflight names it. */
  const rejectLineage = (id: string) => `--reject ${id} --note "lineage pair (066)"`;
  /** 070: the row's lineage line — the reject while the row is the reviewer's, the repair once a pointer was written, the fact alone on a rejected row. */
  const lineageLine = (p: Listed) =>
    `     lineage pair: one side's derived_from names the other (a derivation and its input) — never proposed since 066${p.status === "pending" || p.status === "stale" ? `; reject it: ${rejectLineage(p.id)}` : p.status === "accepted" ? `; accepted while the derivation names its input — --reject ${p.id} clears the pointer (029)` : ""}`;
  /** review_supersession_proposal's answer (029/036), plus the CLI's own LINEAGE_PAIR refusal (070). */
  type ReviewResult = { ok: boolean; error?: string; status?: string; superseding_id?: string; superseded_id?: string; written?: boolean; cleared?: boolean; current?: string; verdict?: string; older_edited?: boolean; newer_edited?: boolean };
  // Thought content and entity names are untrusted; cleanForDisplay strips what
  // would move the cursor or rewrite the ID: line a reviewer is about to paste.
  const snippet = (s: string, n = 160) => { const t = cleanForDisplay(s).replace(/\s+/g, " ").trim(); return t.slice(0, n) + (t.length > n ? "…" : ""); };
  // SMD-1803: the CLI twin of the server's proposal renderer. Through the store's
  // canonical rule (isoDay), not new Date().toISOString(), which fabricated
  // 1970-01-01 on a NULL created_at and THREW on an infinity-dated one, taking
  // the whole listing down.
  const day = (d: Stamp) => isoDay(d) ?? "undated";
  const verdictPhrase = (v: string) =>
    v === "newer_supersedes_older" ? "the NEWER thought supersedes the older"
    : v === "older_supersedes_newer" ? "the OLDER thought supersedes the newer"
    : "conflict, direction not stated";

  async function printList(status: string | undefined, limit = 50): Promise<number> {
    // 070's three-argument form, always: 029 re-applied by hand lands its
    // two-argument form beside 070's, and a call short of three is then
    // ambiguous (not unique) and fails; three resolve (preflight's lineage
    // check names the leftover).
    const listed = async (st: string | null, lineage: boolean | null) =>
      (await sql`SELECT * FROM list_supersession_proposals(${st}::text, ${limit}::int, ${lineage}::boolean)`) as Listed[];
    // --list lineage: the unreviewed rows standing on a lineage pair — the
    // reviewer's alone (a pending row holds its pair, 066 never re-finds it;
    // a stale one waits for the pass's settle, 067) — pending first, then
    // stale, each most confident first.
    const lineageMode = status === "lineage";
    const rows = lineageMode ? [...await listed("pending", true), ...await listed("stale", true)] : await listed(status ?? null, null);
    const what = lineageMode ? "unreviewed proposals standing on a lineage pair" : `${status ? `${status} ` : ""}proposals`;
    if (rows.length === 0) {
      out(`  no ${what}`);
      return 0;
    }
    // A list that hits its cap says so: --status counts every row (definitions
    // probe, second review pass: 61 rows, 50 printed, the header counted 50).
    const hit = (st: string) => rows.filter((r) => r.status === st).length === limit;
    const capped = lineageMode ? hit("pending") || hit("stale") : rows.length === limit;
    out(`  ${rows.length} ${what.replace("proposals", "proposal(s)")}${lineageMode ? " (pending, then stale)" : ""}, most confident first${capped ? ` — ${lineageMode ? `pending and stale capped at ${limit} each` : `the first ${limit}`}; --status counts them all` : ""}:\n`);
    // 067: a stale row's standing against the pools, beside its status. (A
    // row the pass settled needs no tag: its note begins with the marker.)
    const standing = rows.some((p) => p.status === "stale") ? (await readStaleStandings()).byId : new Map<string, never>();
    rows.forEach((p, i) => {
      out(`  ${i + 1}. [${Number(p.confidence).toFixed(2)}] ${verdictPhrase(p.verdict)}${p.lineage ? "  LINEAGE PAIR" : ""}${p.status !== "pending" ? `  (${p.status}${p.status === "stale" ? ` — ${staleStandingText(standing.get(p.id) ?? { s: "waiting", keys: [] }, JOB)}` : ""}${p.reviewed_at ? ` ${day(p.reviewed_at)}` : ""}${p.review_note ? `: ${cleanForDisplay(p.review_note).replace(/\s+/g, " ")}` : ""})` : ""}`);
      if (p.reason) out(`     ${cleanForDisplay(p.reason)}`);
      out(`     newer [${day(p.newer_created_at)}]${p.newer_edited ? " EDITED SINCE JUDGED" : ""} ${snippet(p.newer_content)}\n        ID: ${p.newer_id}`);
      out(`     older [${day(p.older_created_at)}]${p.older_edited ? " EDITED SINCE JUDGED" : ""} ${snippet(p.older_content)}\n        ID: ${p.older_id}`);
      out(`     proposal ${p.id}  cosine ${p.similarity === null ? "?" : Number(p.similarity).toFixed(3)}  judged by ${p.judge_key} on ${day(p.judged_at)}`);
      // 070: a lineage pair — one side derived from the other — is never
      // proposed since 066; a row standing on one is said so, with the reject
      // while the row is the reviewer's.
      if (p.lineage) out(lineageLine(p));
      if (p.status === "pending" || p.status === "stale") {
        // Commands as they run: a placeholder the shell cannot parse rather
        // than `newer|older`, which it would read as a pipe (review pass 3).
        // A stale row (063: a text moved under the verdict) is the next pass's
        // to replace or settle (067), and a reviewer's to decide sooner — its
        // texts moved, so an accept takes --force.
        const dir = p.verdict === "conflict_undirected" ? " --direction <newer|older>" : "";
        const force = p.older_edited || p.newer_edited || p.status === "stale" || p.lineage ? " --force" : "";
        out(`     --accept ${p.id}${dir}${force}    --reject ${p.id}`);
      }
      out("");
    });
    return rows.length;
  }

  async function printStale(days: number): Promise<void> {
    const rows = (await sql`SELECT * FROM stale_entities(make_interval(days => ${days}), 50)`) as
      { entity_id: string; entity_type: string; name: string; thoughts: number; newest_at: Stamp }[];
    if (rows.length === 0) {
      out(`  stale: no entity has gone ${days} days without a mention`);
      return;
    }
    out(`  stale: ${rows.length} entit${rows.length === 1 ? "y" : "ies"} nothing has mentioned in ${days} days (oldest first; reported, not acted on):`);
    // Names are one line each: control characters stripped and whitespace
    // collapsed, so a name cannot start a forged row (review pass 4).
    for (const r of rows) out(`    ${r.entity_type.padEnd(12)} ${cleanForDisplay(r.name).replace(/\s+/g, " ").slice(0, 50).padEnd(50)} ${r.thoughts} thought(s), last ${day(r.newest_at)}`);
  }

  if (REVIEW_ONLY) {
    let code = 0;
    if (ACCEPT || REJECT) {
      // The key resolved; the decision is the next write (review pass 1).
      if (stoppedEarly()) return 130;
      const decision = ACCEPT ? "accept" : "reject";
      const id = (ACCEPT ?? REJECT)!;
      // 070 (SMD-2313): an accept on a lineage pair — one side's derived_from
      // names the other — is the harm 066 exists to prevent (the derivation
      // archives its input while still naming it), so it is refused here
      // unless --force says the reviewer has read both texts and means it —
      // 029's rule for a text edited since judged, applied CLI-side (this is
      // the one accept door; the stores and the tool have none). Read from the
      // row's own predicate, not the 200-capped listing, and only while the
      // row is unreviewed — a decided row is 029's to answer (ALREADY_ACCEPTED
      // on an accepted one; fourth review pass: the guard described a pointer
      // as not yet written). A guard, not a verdict — nothing is written
      // (definitions probe, second review pass: the accept went through under
      // the reject's own advice).
      const lineageRow = decision === "accept" && !FORCE
        ? (await sql`SELECT (COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false) OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false)) AS lineage
                       FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts n ON n.id = p.newer_id
                      WHERE p.id = ${id}::uuid AND p.status IN ('pending', 'stale')`) as { lineage: boolean }[]
        : [];
      const res: ReviewResult = lineageRow[0]?.lineage === true
        ? { ok: false, error: "LINEAGE_PAIR" }
        : (await sql`
        SELECT review_supersession_proposal(${id}::uuid, ${decision}::text, ${NOTE ?? null}::text, ${DIRECTION ?? null}::text, ${passActor()}::jsonb, ${FORCE}::boolean) AS r`)[0].r as ReviewResult;
      if (res.ok) {
        if (decision === "accept") {
          out(`  accepted ${id}: ${res.superseding_id} now supersedes ${res.superseded_id}${res.written ? "" : " (the pointer already held that value)"}; the change is in thought_audit under ${actorName}`);
        } else {
          out(`  rejected ${id}${res.cleared ? `: the supersedes pointer this proposal had set is cleared` : ""}`);
        }
      } else {
        code = 1;
        const why: Record<string, string> = {
          NOT_FOUND: "no such proposal (or the thought it names is gone)",
          LINEAGE_PAIR: `one side's derived_from names the other — a derivation and its input, a pair the pass never proposes since 066; accepting archives the input while the derivation still names it. ${rejectLineage(id)} is the expected decision; pass --force (with --direction on an undirected verdict) if the pointer is what you mean`,
          DIRECTION_REQUIRED: `the judge did not say which is current (${res.verdict}); pass --direction newer or --direction older`,
          ALREADY_ACCEPTED: `already accepted (${res.superseding_id} carries the pointer); --reject it first to undo`,
          EDITED_SINCE: `the ${res.older_edited && res.newer_edited ? "older and newer thoughts have" : res.older_edited ? "older thought has" : "newer thought has"} been edited since the pair was judged, so the verdict is about a text that is gone; read both with --list and pass --force if it still holds`,
          ALREADY_SUPERSEDES: `${res.superseding_id} already supersedes a third thought, ${res.current}; the column holds one predecessor, so decide which — edit that thought, or --reject this`,
          WOULD_CYCLE: `writing this pointer would close a loop through ${res.superseded_id}; refused`,
          // 032: update_thought's answer when the thought to be superseded was
          // deleted between the proposal and the acceptance.
          SUPERSEDES_NOT_FOUND: `${res.superseded_id} no longer exists, so there is nothing to supersede; --reject this`,
        };
        err(`  ${decision} refused: ${why[res.error ?? ""] ?? res.error}`);
      }
    }
    if (LIST !== undefined) {
      // 070 (SMD-2313): a brain at 068 under this tree has no three-argument
      // listing — the one error every --list meets there, named with its file
      // rather than a driver stack (definitions probe, second review pass).
      try { await printList(LIST === "all" ? undefined : LIST); } catch (e) {
        if (!/list_supersession_proposals\(text, ?integer, ?boolean\) does not exist/.test((e as Error).message)) throw e;
        err("  --list needs migration 070 (db/migrations/070_listing_flags_lineage_pair.sql), which this brain has not applied: cd db && bun migrate.ts --url <url>");
        code = 1;
      }
    }
    if (STALE_DAYS > 0) await printStale(STALE_DAYS);
    return code;
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
    out(
      `  ${label}: ${c.thoughts} thoughts with entities — ${c.succeeded} judged, ${c.failed} failed, ` +
        `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool; ${c.proposals} proposal(s) pending review`
    );
  }

  async function printQueue(): Promise<void> {
    // 063 (SMD-1732): a stale row is a pending verdict whose texts moved under
    // it; 067 (SMD-2297): the next pass judges the pair again and REPLACES the
    // row when it finds the conflict again, and SETTLES it — a rejection with
    // the pass's note — when it does not. The rejected count says how many are
    // the pass's; each stale row is placed against the pools (see the header).
    const [q] = await sql`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
             count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
             count(*) FILTER (WHERE status = 'rejected' AND review_note LIKE ${`${PASS_SETTLED_PREFIX}%`})::int AS settled,
             count(*) FILTER (WHERE status = 'pending' AND verdict = 'conflict_undirected')::int AS undirected,
             -- 070 (SMD-2313): the unreviewed rows standing on a lineage pair — 066's predicate, as the stale read above spells it — the reviewer's alone.
             (SELECT count(*)::int FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts n ON n.id = p.newer_id
               WHERE p.status IN ('pending', 'stale')
                 AND (COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false) OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false))) AS lineage,
             -- The count above is this file's own SQL and reads on a brain at 068; the listing it points at is 070's, so its absence is
             -- said here rather than one command later (operator walkthrough, fourth review pass).
             to_regprocedure('list_supersession_proposals(text, int, boolean)') IS NOT NULL AS has_070
      FROM supersession_proposals`;
    const stale = await readStaleStandings();
    out(`  queue: ${q.pending} pending (${q.undirected} without a direction), ${q.accepted} accepted, ${q.rejected} rejected${q.settled ? ` (${q.settled} by the pass)` : ""}${stale.total ? `, ${staleClause(stale)}` : ""}${q.lineage ? `, ${lineageClause(q.lineage, q.has_070)}` : ""} — --list shows them; --accept / --reject decides one`);
  }

  /**
   * 067: the newer thoughts of stale proposals this run must re-pool under its
   * own key — those of a pair BOTH sides of which have a vector (without one
   * the pair cannot be judged; the reembed pool writes it, and the run after
   * sees the thought here — the older side too, or a row whose older thought
   * lost its vector re-pooled the newer on every run and re-judged its other
   * pairs each time, first review pass, run-it) and no live or failed claim
   * here: a pass under another key never had them, a pass under this key
   * finished them before the row went stale (a claim 063's rebuild requeued
   * under the ROW's key sits pending there — the operator's hint, not this
   * pass's pool), and a failed claim is --retry-failed's (015). A thought the
   * pool rule itself would add (no claim row under this key at all) is left to
   * `enqueue_thoughts`, so --dry-run's count and the run agree (first review
   * pass, run-it: the dry run counted such a thought twice).
   */
  const STALE_REPOOL_SQL = `SELECT DISTINCT p.newer_id AS id
      FROM supersession_proposals p
      JOIN thoughts t ON t.id = p.newer_id AND t.embedding IS NOT NULL
      JOIN thoughts o ON o.id = p.older_id AND o.embedding IS NOT NULL
      LEFT JOIN thought_work_claims c ON c.thought_id = p.newer_id AND c.work_type = $1
     WHERE p.status = 'stale' AND (c.thought_id IS NULL OR c.status = 'succeeded')
       AND p.newer_id NOT IN (SELECT consolidation_pool($1))`;
  async function staleToRepool(): Promise<number> {
    return Number(((await sql.unsafe(`SELECT count(*)::int AS n FROM (${STALE_REPOOL_SQL}) s`, [JOB])) as { n: number }[])[0].n);
  }
  async function repoolStale(): Promise<number> {
    return Number(((await sql.unsafe(`SELECT count(*)::int AS n FROM (SELECT requeue_thought_work($1, s.id) FROM (${STALE_REPOOL_SQL}) s) r`, [JOB])) as { n: number }[])[0].n);
  }

  async function printFailures(limit = 10): Promise<void> {
    const rows = (await sql`
      SELECT thought_id, attempt_count, last_error FROM thought_work_claims
      WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
      { thought_id: string; attempt_count: number; last_error: string | null }[];
    for (const r of rows) err(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
  }

  if (STATUS_ONLY || DRY_RUN) {
    const c = await counts();
    printCounts(c, STATUS_ONLY ? "status" : "before");
    if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) out(describeHolder(h));
    await printQueue();
    if (c.thoughts === 0) out("  no thought has extracted entities yet — run db/extract-entities.ts first; this pass pairs thoughts by the entities they share");
    if (c.failed > 0) {
      err(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
      await printFailures();
    }
    if (DRY_RUN) {
      const restale = await staleToRepool();
      const todo = c.pending + c.unpooled + restale + (RETRY_FAILED ? c.failed : 0);
      out(
        `\n  would: ${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
          `add ${c.unpooled} thoughts to the pool${restale ? ` and re-pool ${restale} for stale proposals` : ""}; judge ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) against up to ${K} older neighbour(s) each with ${cfg.judgeModel} ` +
          `and ${WORKERS} worker(s), ${TTL} s leases renewed every ${HEARTBEAT} s. Nothing was written.`
      );
    }
    return 0;
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  if (stoppedEarly()) return 130;
  if (RETRY_FAILED) {
    const [{ n }] = await sql`
      WITH retried AS (
        UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
        WHERE work_type = ${JOB} AND status = 'failed' RETURNING 1)
      SELECT count(*)::int AS n FROM retried`;
    out(`  --retry-failed: ${n} failed row(s) returned to the pool`);
  }

  let stopping = false;
  /**
   * Set by the hard stop, which has returned every worker's leases: a worker
   * writes and releases nothing more — the thought in hand is the pool's
   * again, and may already be another worker's.
   */
  let hardStopped = false;
  /**
   * Aborted by the first stop and by the hard stop: a follower's sleep wakes
   * on the first; the judge's call in hand and a transient pause on the hard,
   * so neither holds run() nor sends a pair again after the leases are gone
   * (db/lease.ts's sleepUnless keeps nothing per sleep).
   */
  const onStop = new AbortController();
  const onHardStop = new AbortController();
  let done = 0;
  let failed = 0;
  let vanished = 0;
  let lost = 0;
  let beats = 0;
  /** Rows that went to the judge — finished or not — so the pairs-per-thought ratio divides by the rows that cost pairs. */
  let judged = 0;
  let llmMs = 0;
  const totals = { pairs: 0, agree: 0, unrelated: 0, conflict: 0, proposed: 0, alreadyProposed: 0, underConfidence: 0, undirected: 0, malformed: 0, noCandidates: 0,
    // 067: the stale rows this run met — replaced in place (a conflict found
    // again), settled after a judgement of no conflict, settled because the
    // pair no longer meets the candidate rule, left waiting for a vector, or
    // decided by a reviewer or another pass between the read and the write.
  };
  /** 067: the stale rows this run met, by proposal id — a row met on several polls of --follow (waiting, then settled) counts once per outcome (second review pass, cold read). */
  const staleMet = { replaced: new Set<string>(), settled: new Set<string>(), settledOut: new Set<string>(), wait: new Set<string>(), raced: new Set<string>(), gone: new Set<string>() };
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
    out(
      `  ${done + failed}/${LIMIT ? Math.min(LIMIT, total) : total}  ${rate.toFixed(2)}/s  ` +
        `${totals.pairs} pairs judged, ${totals.proposed} proposed` +
        (failed ? `  ${failed} failed` : "") +
        (eta !== null ? `  ~${eta}s left` : "")
    );
  }

  /** A thought as read for judging: the text and 016's hash of it, taken together, so the proposal records what the judge saw. */
  type Row = { id: string; content: string; created_at: string | null; fingerprint: string; metadata: Record<string, unknown> | null; has_vector: boolean };
  type Candidate = { older_id: string; similarity: number; shared_entities: number };
  type Outcome = { outcome: "succeeded" } | { outcome: "failed"; error: string } | { outcome: "vanished" }
    /** In hand at the hard stop: nothing more written, and no longer this worker's to release. */
    | { outcome: "abandoned" };
  /** 067: a stale proposal on the thought in hand (its newer side), with what the leftover rule needs of the older side. */
  type StaleRow = { id: string; older_id: string; older_fingerprint: string; older_vectorless: boolean; newer_vectorless: boolean; similarity: number | null; shared: number; superseded: boolean; lineage_pair: boolean };

  /**
   * 067: the pass settles a stale row — rejected with the marker note, its
   * lineage re-recorded at the texts judged under this key — through
   * settle_supersession_proposal. NOT_STALE and NOT_FOUND are facts about the
   * row (a reviewer decided it, another pass replaced it, its thought is gone
   * between the read and this write), counted and not failed.
   */
  /**
   * A Writer's throw from inside processRow, marked so the worker's catch
   * rethrows it — the Writer's error rejects run() — rather than classifying
   * it as the thought's failure and recording it on the claim (review pass 1:
   * a throw on the "not settled" line became last_error = "writer boom").
   */
  class WriterThrow {
    constructor(readonly error: unknown) {}
  }
  const errInRow = (line: string): void => {
    try {
      err(line);
    } catch (e) {
      throw new WriterThrow(e);
    }
  };

  async function settleStale(s: StaleRow, why: string, olderFp: string, newerFp: string, settled: string, reason?: string): Promise<boolean> {
    const recipe = { ...proposalRecipe(cfg, { similarity: s.similarity ?? NaN, candidates: K, minSimilarity: MIN_SIM }), settled, ...(reason ? { reason } : {}) };
    if (s.similarity === null) delete (recipe as { similarity?: number }).similarity;
    const [{ r }] = await sql`
      SELECT settle_supersession_proposal(${s.id}::uuid, ${passSettledNote(why, JOB)}::text, ${passActor()}::jsonb, ${JOB}::text,
                                          ${olderFp}::text, ${newerFp}::text, ${recipe}::jsonb, ${agentId}::uuid) AS r`;
    const res = r as { ok: boolean; error?: string; status?: string };
    if (res.ok) return true;
    if (res.error === "NOT_FOUND") {
      // The pair's thought was deleted between the stale read and this write:
      // 029's cascade took the row (first review pass, cold read: counted as a
      // decision before).
      staleMet.gone.add(s.id);
      errInRow(`  ${s.id}: not settled — the row is gone with a deleted thought`);
    } else {
      staleMet.raced.add(s.id);
      errInRow(`  ${s.id}: not settled — ${res.error === "NOT_STALE" ? `the row is ${res.status} now (a reviewer or another pass reached it first)` : res.error}`);
    }
    return false;
  }

  async function processRow(row: Row): Promise<Outcome> {
    // 067: the stale rows on this thought — 063's rebuild set them stale when
    // a text moved under the verdict, and this pass replaces or settles each
    // (see the header). Read before the candidates so a stale pair the top-k
    // leaves out is judged anyway when it still meets the candidate rule.
    const stale = (await sql`
      SELECT p.id, p.older_id, content_fingerprint_of(o.content) AS older_fingerprint, (o.embedding IS NULL) AS older_vectorless, (me.embedding IS NULL) AS newer_vectorless,
             CASE WHEN o.embedding IS NOT NULL AND me.embedding IS NOT NULL THEN 1 - (o.embedding <=> me.embedding) END AS similarity,
             -- The candidate rule's other terms, so a pair it no longer admits is settled with the reason named
             -- (second review pass, cold read: the note listed three reasons with "or").
             (SELECT count(DISTINCT a.entity_id)::int FROM thought_entities a JOIN thought_entities b ON b.entity_id = a.entity_id
               WHERE a.thought_id = p.older_id AND b.thought_id = p.newer_id) AS shared,
             (o.supersedes = p.newer_id OR me.supersedes = p.older_id
              OR EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes IN (p.older_id, p.newer_id))) AS superseded,
             -- 066 (SMD-2292): a derivation and its input are never paired — the rule's own predicate, NULL-safe.
             (COALESCE(me.derived_from @> jsonb_build_array(o.id::text), false) OR COALESCE(o.derived_from @> jsonb_build_array(me.id::text), false)) AS lineage_pair
        FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts me ON me.id = p.newer_id
       WHERE p.newer_id = ${row.id}::uuid AND p.status = 'stale'`) as StaleRow[];
    const staleByOlder = new Map(stale.map((s) => [s.older_id, s]));
    let candidates = (await sql`SELECT older_id, similarity, shared_entities FROM consolidation_candidates(${row.id}::uuid, ${K}::int, ${MIN_SIM}::float)`) as Candidate[];
    const leftOut = stale.filter((s) => !candidates.some((c) => c.older_id === s.older_id)).map((s) => s.older_id);
    if (leftOut.length) {
      const more = (await sql`
        SELECT older_id, similarity, shared_entities FROM consolidation_candidates(${row.id}::uuid, 2147483647, ${MIN_SIM}::float)
        WHERE older_id = ANY(${sql.array(leftOut, "TEXT")}::uuid[])`) as Candidate[];
      candidates = candidates.concat(more);
    }
    if (candidates.length === 0) {
      totals.noCandidates++;
      if (stale.length === 0) return { outcome: "succeeded" };
    }
    const olders = candidates.length === 0 ? [] : (await sql`
      SELECT id, content, created_at, content_fingerprint_of(content) AS fingerprint, metadata, (embedding IS NOT NULL) AS has_vector FROM thoughts
      WHERE id = ANY(${sql.array(candidates.map((c) => c.older_id), "TEXT")}::uuid[])`) as Row[];
    const byId = new Map(olders.map((o) => [o.id, o]));
    const problems: string[] = [];
    // 067: every candidate the loop REACHED — judged, or attempted and left in
    // `problems` (a timeout, an egress refusal, a malformed answer). A stale
    // row on a reached pair is never a leftover: the leftover rule below reads
    // "the candidate rule no longer admits the pair", and a pair the judge was
    // asked about was admitted (first review pass, run-it: a stale pair whose
    // call timed out was settled as "no longer a candidate").
    const reachedOlders = new Set<string>();
    // No early exit on `stopping` here: a thought is at most --k calls, bounded
    // by the lease arithmetic above, and a thought released succeeded with pairs
    // unjudged would be terminal with the pairs never judged (review pass 1).
    for (const c of candidates) {
      if (hardStopped) return { outcome: "abandoned" };
      const older = byId.get(c.older_id);
      if (!older) continue; // deleted between the candidate query and the read
      reachedOlders.add(c.older_id);
      const staleRow = staleByOlder.get(c.older_id);
      const t0 = Date.now();
      let j: Judgement;
      try {
        // SMD-1726: the judge hears who wrote each side — the database's mark
        // (050), never a payload field — so "an agent's summary supersedes what
        // the operator typed" is a proposal it can decline on that ground.
        j = await judgePair({ content: older.content, createdAt: older.created_at, metadata: older.metadata ?? undefined, writer: actorKindOf(older.metadata) },
                            { content: row.content, createdAt: row.created_at, metadata: row.metadata ?? undefined, writer: actorKindOf(row.metadata) },
                            cfg, AbortSignal.any([AbortSignal.timeout(TIMEOUT_S * 1000), onHardStop.signal]), keyName);
      } catch (e) {
        llmMs += Date.now() - t0;
        // The hard stop aborted the call: the thought is abandoned, not failed.
        if (hardStopped) return { outcome: "abandoned" };
        // A timeout is a fact about this pair (the longest thoughts); anything
        // else is the provider's and is classified by the caller.
        if ((e as Error).name === "TimeoutError" || /timed out/i.test((e as Error).message)) {
          problems.push(`pair with ${c.older_id}: timed out after ${TIMEOUT_S} s`);
          continue;
        }
        // The egress gate refused a side of this pair (SMD-1903): a fact about
        // these rows under this policy, recorded on the claim like a timeout,
        // so the next pair is still judged and --retry-failed revisits the row.
        if (e instanceof ProviderError && e.kind === "egress") {
          problems.push(`pair with ${c.older_id}: ${e.message}`);
          continue;
        }
        throw e;
      }
      llmMs += Date.now() - t0;
      if (hardStopped) return { outcome: "abandoned" };
      totals.pairs++;
      if (j.malformed) {
        totals.malformed++;
        problems.push(`pair with ${c.older_id}: the model's answer was not JSON of the expected shape${staleRow ? " (its stale proposal stands)" : ""}`);
        continue;
      }
      totals[j.verdict]++;
      const verdict = proposalVerdict(j);
      let proposalId: string | null = null;
      let recorded: "proposed" | "under-confidence" | "already" | "replaced" | "settled" | null = null;
      if (verdict === null || j.confidence < MIN_CONFIDENCE) {
        if (verdict !== null) {
          totals.underConfidence++;
          recorded = "under-confidence";
        }
        // 067: no conflict at the floor on a pair whose proposal is stale — the
        // pass settles it, at the fingerprints the judge was sent.
        // (The older's fingerprint from the read the judge was sent, not the
        // stale read before the candidates — a move between the two would
        // record a text the judge did not see; first review pass, cold read.)
        if (staleRow && await settleStale(staleRow, verdict === null ? `judged again after a text moved — ${j.verdict}` : `judged again after a text moved — a conflict at confidence ${j.confidence.toFixed(2)}, under the floor ${MIN_CONFIDENCE}`, older.fingerprint, row.fingerprint, verdict === null ? j.verdict : "under-confidence")) {
          staleMet.settled.add(staleRow.id);
          recorded = "settled";
        }
      } else {
        // The fingerprints of the texts the judge was sent, not of the rows as
        // they are at this write: an edit that landed during the call is then
        // visible to the reviewer (review pass 4).
        // 061: the judge's recipe — model, prompt version and hash, the
        // candidate parameters this pair was found under — recorded in
        // `derivations` with the proposal, beside both fingerprints (SMD-1731).
        const [{ id }] = await sql`
          SELECT record_supersession_proposal(${c.older_id}::uuid, ${row.id}::uuid, ${verdict}::text,
                                              ${j.confidence}::numeric, ${j.reason || null}::text, ${c.similarity}::float,
                                              ${JOB}::text, ${agentId}::uuid, ${older.fingerprint}::text, ${row.fingerprint}::text,
                                              ${proposalRecipe(cfg, { similarity: c.similarity, candidates: K, minSimilarity: MIN_SIM })}::jsonb) AS id`;
        proposalId = (id as string | null) ?? null;
        // 067: the same id back on a stale pair is 063's replacement in place.
        if (proposalId && staleRow && proposalId === staleRow.id) { staleMet.replaced.add(staleRow.id); recorded = "replaced"; if (verdict === "conflict_undirected") totals.undirected++; }
        else if (proposalId) { totals.proposed++; recorded = "proposed"; if (verdict === "conflict_undirected") totals.undirected++; }
        else { totals.alreadyProposed++; recorded = "already"; }
      }
      if (DUMP) {
        appendFileSync(DUMP, JSON.stringify({
          newer: row.id, older: c.older_id, similarity: c.similarity, shared: c.shared_entities, key: JOB,
          verdict: j.verdict, supersedes: j.supersedes, confidence: j.confidence, reason: j.reason,
          proposal: proposalId, recorded,
        }) + "\n");
      }
    }
    // 067: the stale rows no candidate reached — pairs the candidate rule no
    // longer admits. A side without a vector is "not yet" (the reembed pool
    // writes it; the run after that re-pools this thought); the rest — no
    // shared entity, under the similarity floor, a side superseded — mean no
    // conflict and are settled at the current texts. A pair whose call timed
    // out, was refused by the egress gate or drew a malformed answer is in
    // `problems` above and was reached: its row stays stale, the thought is
    // recorded failed, and --retry-failed revisits it.
    for (const s of stale) {
      if (hardStopped) return { outcome: "abandoned" };
      if (reachedOlders.has(s.older_id)) continue;
      // (Both sides' vectors as the stale read saw them, one statement — not
      // the newer's from the claim-time batch read; third review pass.)
      if (s.newer_vectorless || s.older_vectorless) { staleMet.wait.add(s.id); continue; }
      // The reason, from the rule's own terms: a side superseded, no shared
      // entity, or under this run's similarity floor (a stricter --min-sim
      // than the one the pair was proposed under settles it, for good until
      // a text moves — the flag is the rule); the day rule and a raw change
      // no write function makes are the remainder.
      const why = s.superseded ? "a side superseded"
        : s.lineage_pair ? "a lineage pair — one side derived from the other (066's rule)"
        : s.shared === 0 ? "no shared entity"
        : s.similarity !== null && s.similarity < MIN_SIM ? `under the similarity floor ${MIN_SIM} (cosine ${s.similarity.toFixed(3)})`
        : "outside the candidate rule (the day rule, or a change no write function makes)";
      if (await settleStale(s, `no longer a candidate pair — ${why}`, s.older_fingerprint, row.fingerprint, "not-a-candidate", why)) staleMet.settledOut.add(s.id);
    }
    if (problems.length) return { outcome: "failed", error: `${problems.length} of ${candidates.length} pair(s) not judged: ${problems.join("; ").slice(0, 400)}` };
    return { outcome: "succeeded" };
  }

  // Written inside the worker closures below, which control-flow analysis does
  // not follow: declared `: string | null = null`, the read at the end of the
  // run is narrowed to `never`. The cast keeps the declared type as the initial
  // one (SMD-1932).
  let configError = null as string | null;

  /** --limit counts thoughts CLAIMED, reserved at claim time, so two workers cannot each take one on a limit of one. */
  let reserved = 0;
  function limitReached(): boolean {
    return LIMIT > 0 && reserved >= LIMIT;
  }

  /**
   * The Writer's err for lines written on a timer or an event — the heartbeat's,
   * the caller's signal's — where a throw has no caller to reject and would be
   * the host's unhandled error: it is dropped there.
   */
  const errAside = (line: string): void => {
    try {
      err(line);
    } catch {
      // Nothing awaits this line.
    }
  };

  async function worker(n: number): Promise<void> {
    const workerId = `consolidate-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
    activeWorkers.add(workerId);
    const hb = startHeartbeat({
      sql, job: JOB, workerId, ttlS: TTL, everyS: HEARTBEAT,
      onLost: (ids) => { if (!hardStopped) errAside(`  ${workerId}: ${ids.length} row(s) no longer this worker's at the last beat — reaped, requeued by an edit, or deleted; each is named as the loop reaches it, or at its release if it was the row in hand`); },
      onError: (e, consecutive) => { if (consecutive === 1) errAside(`  ${workerId}: heartbeat failed (${e.message}); the leases hold ${TTL} s from the last beat that reached the database`); },
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
            SELECT id, content, created_at, content_fingerprint_of(content) AS fingerprint, metadata, (embedding IS NOT NULL) AS has_vector
              FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
          byId = new Map(rows.map((r) => [r.id, r]));
        } catch (e) {
          err(`  ${workerId}: ${(e as Error).message} — this worker stops`);
          return;
        }
        for (const b of batch) {
          if (stopping) return;
          if (hb.lost.has(b.thought_id)) {
            // A beat found this row no longer ours. Nothing to release, and
            // repeating the provider's work would only race the holder; the row
            // says why (db/lease.ts reportLost), and which count it joins.
            if ((await reportLost(sql, JOB, workerId, b.thought_id, err)) === "deleted") vanished++;
            else lost++;
            continue;
          }
          const row = byId.get(b.thought_id);
          if (b.attempt > 1) err(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
          let outcome: Outcome | null = null;
          if (!row) {
            outcome = { outcome: "vanished" };
          } else {
            let stopAfter = false;
            for (let attempt = 0; outcome === null; attempt++) {
              try {
                outcome = await processRow(row);
              } catch (e) {
                if (e instanceof WriterThrow) throw e.error;
                const kind = classifyError(e);
                const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
                if (kind === "thought") {
                  outcome = { outcome: "failed", error: msg };
                } else if (kind === "fatal") {
                  configError = msg;
                  stopping = true;
                  err(`  ${workerId}: the provider refuses the request itself (${msg.slice(0, 160)}) — stopping every worker; nothing is marked failed`);
                  return;
                } else if (attempt < TRANSIENT_PAUSES_MS.length && !stopping) {
                  err(`  ${workerId}: provider unavailable (${msg.slice(0, 120)}); pausing ${TRANSIENT_PAUSES_MS[attempt] / 1000} s`);
                  await sleepUnless(TRANSIENT_PAUSES_MS[attempt], onHardStop.signal);
                  if (hardStopped) return;
                } else {
                  outcome = { outcome: "failed", error: `provider error after ${TRANSIENT_PAUSES_MS.length} retries: ${msg}` };
                  stopAfter = true;
                }
              }
            }
            if (hardStopped) return;
            judged++;
            if (stopAfter) err(`  ${workerId}: provider still failing — this worker stops after recording this thought; re-run when it is back`);
            if (stopAfter && outcome.outcome === "failed") {
              hb.held.delete(b.thought_id);
              let recorded = false;
              try {
                const rows = (await sql`SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId}, 'failed', ${outcome.error}) AS ok`) as { ok: boolean }[];
                recorded = rows[0]?.ok === true;
              } catch (e) {
                err(`  ${b.thought_id}: could not record the failure (${(e as Error).message})`);
              }
              if (recorded) failed++;
              else {
                // Not ours to record: the lease lapsed during the pauses, or the
                // row was returned by hand. Counted with the rows this worker lost.
                lost++;
                err(`  ${b.thought_id}: the claim was no longer this worker's at release; the failure below was not recorded`);
              }
              err(`  ${b.thought_id}: ${outcome.error}`);
              return;
            }
          }
          // Never true here (the hard stop returned above); it narrows `outcome` for the release below.
          if (outcome.outcome === "abandoned") return;
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
            err(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
            return;
          }
          if (gone) {
            vanished++;
            err(`  ${b.thought_id}: deleted while it was being judged`);
            continue;
          }
          if (!ok) {
            // Not ours to finish: counted with the rows this worker lost, not
            // the ones it finished, so the workers' summaries add up.
            err(`  ${b.thought_id}: the claim was no longer this worker's at release — its lease lapsed (no beat reached the database for ${TTL} s) or it was returned by hand with release_claims_for_worker; the row is the pool's or another worker's now`);
            if (outcome.outcome === "failed") err(`  ${b.thought_id}: ${outcome.error} (not recorded — the row was not this worker's)`);
            lost++;
            progress();
            continue;
          }
          if (outcome.outcome === "failed") {
            failed++;
            err(`  ${b.thought_id}: ${outcome.error}`);
          } else {
            done++;
          }
          progress();
        }
      }
    } finally {
      hb.stop();
      beats += hb.beats;
      let freed = 0;
      try {
        [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      } catch (e) {
        err(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s`);
      }
      activeWorkers.delete(workerId);
      // Outside the release's try: a Writer's throw here is the Writer's, not a
      // lease left unreturned.
      if (freed > 0 && !FOLLOW) err(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    }
  }

  // The pass's stop (db/lease.ts's PassStop), handed to the caller here, where
  // the script installed its signal handlers — before this a signal ends the
  // CLI at once. One while already stopping — a second, or the first after the
  // provider's refusal stopped the workers — is the hard stop: the release of
  // every worker's leases, the CLI exiting 130 when it settles.
  const stop: PassStop = () => {
    // After the run has returned there is no pass to stop.
    if (detach.aborted) return null;
    if (stopping) {
      hardStopped = true;
      onHardStop.abort();
      onStop.abort();
      // Started before the line is written: a Writer that throws does not keep the leases.
      const release = Promise.all([...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null)));
      err(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
      return release;
    }
    stopping = true;
    onStop.abort();
    err("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
    return null;
  };
  // A caller's signal is a first stop, in words that promise no second; its
  // listener goes when the run returns (`detach`, run()'s).
  const abort = () => {
    if (stopping) return;
    stopping = true;
    onStop.abort();
    errAside("\n  stopping after the current thought; unfinished claims go back to the pool");
  };
  if (stoppedEarly()) return 130;
  opts.signal?.addEventListener("abort", abort, { once: true, signal: detach });
  opts.onPass?.(stop);

  let firstPass = true;
  async function pass(): Promise<Counts> {
    // The pool rule, every pass, from migration 029's consolidation_pool (one
    // definition for this, --status and preflight). No trigger feeds it (see
    // the header), so a --follow poll re-runs the query — a scan of thoughts
    // against the entity table, which is what it costs to be sure a thought is
    // judged only once extraction has reached it.
    const added = Number((await sql`SELECT enqueue_thoughts(${JOB}, ARRAY(SELECT consolidation_pool(${JOB}))) AS added`)[0].added);
    // 067: a stale proposal is this pass's work whatever key wrote it — its
    // newer thought re-pooled here where the pool rule above could not add it
    // (a terminal claim under this key, or a claim 063 left under the row's
    // key, which is another pool).
    const restaled = await repoolStale();
    const before = await counts();
    if (added > 0 || restaled > 0 || !FOLLOW) out(`  pool: ${added} thought(s) added${restaled ? ` (${restaled} more re-pooled for stale proposals)` : ""}`);
    if (firstPass && before.thoughts === 0) out("  no thought has extracted entities and a vector — run db/extract-entities.ts first; this pass pairs thoughts by the entities they share" + (FOLLOW ? ", and will poll until some do" : ""));
    firstPass = false;
    total += before.pending + before.claimed;
    if (before.pending + before.claimed === 0) return before;
    if (!FOLLOW || added > 0 || before.pending > 0) printCounts(before, "before");
    // A worker that throws — a Writer that throws, in practice; each catches
    // its own database errors — stops the rest after the thought in hand, and
    // the pass rejects with its error once they have stopped, not while they
    // still hold rows and the client.
    const ends = await Promise.allSettled(Array.from({ length: WORKERS }, (_, i) => worker(i).catch((e: unknown) => {
      stopping = true;
      throw e;
    })));
    const thrown = ends.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (thrown) throw thrown.reason;
    progress(true);
    return counts();
  }

  out(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

  let after = await pass();
  if (FOLLOW) {
    while (!stopping && !limitReached()) {
      await sleepUnless(FOLLOW * 1000, onStop.signal);
      if (stopping) break;
      after = await pass();
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  out(
    `\n  ${done} thought(s) judged, ${failed} failed, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed.toFixed(1)}s ` +
      `(${(llmMs / 1000).toFixed(1)}s in model calls across ${WORKERS} worker(s), ${beats} heartbeat(s))`
  );
  out(
    `  ${totals.pairs} pair(s) judged${judged ? ` — ${(totals.pairs / judged).toFixed(2)} per thought judged, ${Math.round((totals.pairs / judged) * 1000)} calls per thousand thoughts` : ""}; ` +
      `${totals.noCandidates} thought(s) had no candidate; verdicts: ${totals.agree} agree, ${totals.unrelated} unrelated, ${totals.conflict} conflict`
  );
  out(
    `  ${totals.proposed} proposal(s) recorded (${totals.undirected} without a direction)` +
      `${totals.underConfidence ? `, ${totals.underConfidence} conflict(s) under confidence ${MIN_CONFIDENCE} not recorded` : ""}` +
      `${totals.alreadyProposed ? `, ${totals.alreadyProposed} pair(s) already had a proposal` : ""}` +
      `${totals.malformed ? `, ${totals.malformed} answer(s) not JSON of the expected shape` : ""}`
  );
  if (totals.pairs > 0) out(`  model time per pair: ${(llmMs / totals.pairs / 1000).toFixed(1)}s`);
  // 067: what became of the stale proposals this run met (a line only when it met one).
  {
    // A row that waited on one poll and was settled, replaced, decided or deleted on a later one waits no more.
    const decided = (id: string) => staleMet.settled.has(id) || staleMet.settledOut.has(id) || staleMet.replaced.has(id) || staleMet.raced.has(id) || staleMet.gone.has(id);
    const m = { replaced: staleMet.replaced.size, settled: staleMet.settled.size, settledOut: staleMet.settledOut.size, wait: [...staleMet.wait].filter((id) => !decided(id)).length, raced: staleMet.raced.size, gone: staleMet.gone.size };
    if (m.replaced + m.settled + m.settledOut + m.wait + m.raced + m.gone > 0) {
      out(
        `  stale proposals: ` + [
          m.settled + m.settledOut ? `${m.settled + m.settledOut} settled by the pass (${[m.settled ? `${m.settled} judged again with no conflict at the floor` : "", m.settledOut ? `${m.settledOut} no longer a candidate pair` : ""].filter(Boolean).join(", ")})` : "",
          m.replaced ? `${m.replaced} replaced in place — the conflict found again` : "",
          m.wait ? `${m.wait} wait on a vector the reembed pool writes (re-pooled by the run after it lands)` : "",
          m.raced ? `${m.raced} decided by a reviewer or another pass meanwhile` : "",
          m.gone ? `${m.gone} gone with a deleted thought` : "",
        ].filter(Boolean).join("; ") + (FOLLOW ? " — distinct rows across the polls" : "")
      );
    }
  }
  printCounts(after, "after");
  await printQueue();
  if (after.failed > 0) {
    err(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
    await printFailures();
  }
  if (after.claimed > 0 && !stopping) {
    err(`\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed. They return to the pool within ${TTL} s of the holder's last heartbeat; --status names each holder, and a dead one's rows return at once with SELECT release_claims_for_worker(job, worker_id).`);
  }
  if (after.pending > 0 && !stopping && !limitReached()) {
    err(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
  }
  if (configError) {
    err(
      `\n  The provider refused the request itself: ${configError.slice(0, 300)}\n` +
        `  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and the judge model (OB1_JUDGE_MODEL, else OB1_METADATA_MODEL) against the provider; a 400 about a request field\n` +
        `  is usually reasoning_effort or response_format not being supported by this model. Nothing was marked failed.`
    );
    return 2;
  }
  const incomplete = after.failed > 0 || after.claimed > 0 || (after.pending > 0 && !limitReached());
  // A follower stopped exits 0 — unless hard-stopped, which is a signal's 130.
  return stopping ? (FOLLOW && !hardStopped ? 0 : 130) : incomplete ? 1 : 0;
}

if (import.meta.main) {
  const cli = commandLine("consolidate.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  // The numbers by the scanner's rules, in run()'s order — the lease pair
  // between them, as run() checks it — so a command breaking two rules is
  // refused for the same one it always was. The review flags' rules are
  // run()'s (reviewProblem), after every number, where they always were.
  const workers = cli.int("workers", { absent: 2, min: 1 });
  const batch = cli.int("batch", { absent: 1, min: 1 });
  const ttl = cli.int("ttl", { absent: DEFAULT_TTL_S, min: 1 });
  const heartbeat = cli.has("heartbeat") ? cli.int("heartbeat", { absent: DEFAULT_HEARTBEAT_S, min: 1 }) : undefined;
  const timeout = cli.int("timeout", { absent: 120, min: 1 });
  const k = cli.int("k", { absent: DEFAULT_CANDIDATES, min: 1, max: 50 });
  const minSim = cli.number("min-sim", { absent: DEFAULT_MIN_SIMILARITY, min: -1, max: 1, fraction: true });
  const minConfidence = cli.number("min-confidence", { absent: DEFAULT_MIN_CONFIDENCE, min: 0, max: 1, fraction: true });
  const lease = leaseRefusal(ttl, heartbeat ?? heartbeatFor(ttl), heartbeat === undefined);
  if (lease) {
    console.error(lease);
    process.exit(2);
  }
  const limit = cli.has("limit") ? cli.int("limit", { absent: 0, min: 1 }) : undefined;
  const follow = cli.has("follow") ? cli.int("follow", { absent: 0, bare: 15, min: 1 }) : undefined;
  const stale = cli.has("stale") ? cli.int("stale", { absent: 0, bare: 90, min: 1 }) : undefined;
  // One connection per worker and a spare (run()'s rule), opened lazily: a
  // refusal before the first query opens none.
  const sql = openSql(url, { max: workers + 1 });
  // The signal handlers go when run() settles: a signal while the door closes
  // the pool and flushes ends the process, as one before the pass does.
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, workers, batch, ttl, heartbeat, timeout, k, minSim, minConfidence, limit, follow, stale,
      dump: cli.value("dump"),
      list: cli.has("list") ? (cli.value("list") ?? "pending") : undefined,
      accept: cli.value("accept"),
      reject: cli.value("reject"),
      direction: cli.value("direction"),
      note: cli.value("note"),
      force: cli.has("force"),
      status: cli.has("status"),
      dryRun: cli.has("dry-run"),
      retryFailed: cli.has("retry-failed"),
      onPass: (stop) => { uninstall = stopOnSignals(stop); },
    }).finally(() => uninstall());
  });
}
