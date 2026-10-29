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
 * and the parsing rules), and an OUTDATES verdict (prompt 4, SMD-1873; p3's
 * CONFLICT) becomes a pending row in
 * `supersession_proposals`; a related, evolves or duplicate verdict is a
 * `relation` facet on the newer thought (084, SMD-1873 PR 2), and since 102
 * an unrelated one is too, as `distinct`: two near neighbours judged apart
 * (SMD-3117; under decide mode only when H2O's own top was unrelated, not a
 * fallback from its outdates). Nothing here
 * writes `thoughts`. An operator — or a
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
 *                                                                                         # each side's writer, and WRITER on a capture-only key's or lower-trust side to stand (094)
 *   bun db/consolidate.ts --url … --list relations   # the judged relations standing (084): related, evolves, duplicate (a distinct, 102, is counted by --status, not listed)
 *   bun db/consolidate.ts --url … --list [<status>|relations] --key <judge key>   # one pass's alone: its judge key exactly, as each row names it (109, SMD-3248)
 *   bun db/consolidate.ts --url … --list <status> [--key <judge key>] --after <cursor>   # the next page: the line a capped page printed, its --list and --key with its cursor (110, SMD-3249)
 *   bun db/consolidate.ts --url … --accept <proposal-id> [--direction newer|older] [--note "…"] [--force]   # --force: a text edited since judged, a stale row, a lineage pair (070), or a WRITER flag (094)
 *   bun db/consolidate.ts --url … --reject <proposal-id> [--note "…"]
 *   bun db/consolidate.ts --url … --stale [DAYS]          # entities nothing has mentioned within DAYS (90; at most 2000000, inside Postgres's timestamp range)
 *   await run({ url, dryRun: true })                      # a dry run, in-process: import { run } from "./consolidate.ts" (SMD-2304)
 *   --k N (3)   --min-sim F (0.6)   --min-confidence F (0.5)
 *   --workers N (2; at most 2147483647: a connection each and a spare, Bun's pool max of 2^31)   --batch N (1; at most 2147483647, claim_thoughts' int)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)   --timeout SECONDS (120, per model call; this flag, as extract-entities.ts's, not OB1_LLM_TIMEOUT; at most 9007199254740, a call signal's range)
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
 * is not revisited. A candidate was captured on an earlier UTC date (029),
 * so beside an extract follower a capture's neighbours were almost always
 * extracted long before it. The exceptions:
 *  - two captures either side of 00:00 UTC, the earlier still in hand when
 *    the later is judged — one extract worker claims in queue order and
 *    finishes the earlier first, but two can hold it;
 *  - a backlog (a first run or a --switch-key pools every thought at one
 *    instant, claimed in no order: drain it before consolidating);
 *  - a failed extraction or embedding (a candidate needs a vector), or an
 *    import dated older than thoughts already judged, which miss their
 *    pairs with thoughts judged before they were repaired, however this runs.
 * (The `workers` compose profile, SMD-2424, deploy/README.md.) A thought's
 * claim row is terminal once its pairs are judged, so an EDIT does not
 * re-judge it (016's trigger does re-extract it); clear the key's rows to
 * start over, and a pair already proposed is skipped either way.
 *
 * A --follow process outlasts the database going away (SMD-2599), as
 * extract-entities.ts's does: an error that says it is not answering is said
 * once and waited out on worker-bootstrap.ts's schedule (5 s, doubling, at
 * most 5 min), the thought in hand recorded nothing and its lease returned
 * when the database is back. Its start waits the same way, every statement
 * up to the first claim but --retry-failed's, the worker key's lookup
 * included (SMD-2752). A run
 * without --follow still exits 1 on it.
 * It outlasts the provider going away too, by extract-entities.ts's rules.
 * Three things are outages:
 *   - a transient error past the pauses;
 *   - the model missing;
 *   - a pair's timeout after which a one-token probe gets no answer either.
 * In each case the thought goes back to the pool unrecorded and the follower
 * probes the judge model until it answers. A thought that fails the same way
 * right after a probe answered is recorded failed. A follower probes once
 * before it writes anything, and refuses an unserved model, a refused key or
 * a wrong base URL with exit 2.
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
 * pairs again — up to --k model calls per re-pooled thought, since nothing
 * lets it skip a pair it judged before (a standing relation or, since 102, a
 * distinct is kept or replaced by the new verdict, not consulted), plus one per stale
 * pair the top-k left out that still meets the candidate rule, judged anyway.
 * An outdates at the floor REPLACES the row in place (063:
 * record_supersession_proposal, back to pending under this key); unrelated,
 * related, evolves, duplicate, or an outdates under the floor SETTLES it — the row is rejected
 * with a note beginning `settled by the pass:` (the marker rebuild_derived
 * reads: a later text move under a pass-settled row sets it stale again,
 * where a person's rejection stands for ever) and its lineage row rewritten
 * at the texts judged, through settle_supersession_proposal. A stale pair the
 * rule no longer admits for a reason that means "nothing to propose" — no shared
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
 * paused and retried three times — a stop wakes the pause, and the thought
 * goes back to the pool (SMD-2401); if it persists, the thought in hand is
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
import { consolidatePassKey, decidePair, type DecideNote } from "../server-portable/consolidate-decide.ts";
import { resolveJevConfig, type JevConfig, type JevEnv } from "../server-portable/jev.ts";
import { blanketGate, classifyError, databasePermanent, databaseUnavailable, egressDescription, egressRefusal, isOut, lookupOutage, MAX_CALL_TIMEOUT_S, modelMissing, OUTAGE_MS, probeChat, probeRefusal, probeTier, probeUntil, ProviderDown, ProviderOutage, regateMessage, throughOutage, timedOut, TRANSIENT_PAUSES_MS, waitOut, workerIdentity, type Probe, type StartRefusal, type StartResult } from "./worker-bootstrap.ts";
import {
  actorKindOf, judgedRecipe, CONSOLIDATE_PROMPT_VERSION, VERDICTS, judgePair, passSettledNote, proposalConfidence, proposalVerdict, relationConfidence, relationVerdict, JUDGE_LOGPROBS, staleStandings, staleStandingsText, staleStandingText,
  DEFAULT_CANDIDATES, DEFAULT_MIN_CONFIDENCE, DEFAULT_MIN_SIMILARITY, PASS_SETTLED_PREFIX, STALE_STANDING_ROWS_SQL,
  type Judgement, type StaleStandingRow,
} from "../server-portable/consolidate.ts";
import { actorPayload, isoDay, normaliseProposal, timeCastFailed, withWriters, WRITERS_MISSING, type ProposalSide, type ProposalWriter } from "../server-portable/store.ts";
import { proposalRecipe } from "../server-portable/lineage.ts";
import { judgeKeyText, selectableKey } from "../server-portable/pass-key.ts";
import { parseProposalCursor, proposalCursor, sameSelection, type ProposalSelection } from "../server-portable/core/list-cursor.ts";
import { ingestedNotice, lapsesLine, PROPOSAL_TEXT_MAX, proposalWriterLine, snipText, standingFlags, standingFlagText, stoodSide, supersededLine, walkCappedLine, writerFlagAdvice, writerFlagsText, WRITERS_UNREAD, type StandingFlag } from "../server-portable/render.ts";
import { DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, heartbeatFor, leaseHolders, leaseRefusal, MAX_BATCH, MAX_WORKERS, reportLost, sleepUnless, startHeartbeat, stopOnSignals, STOPPED_EARLY, AdmitThrow, admitted, claimAfterWait, type Admit, type PassStop } from "./lease.ts";
import { endOnRefusal, passStamper, stampKey, type PassStamper } from "./pass-stamp.ts";
import { blankProblem, commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql, type SessionSettings } from "./connect.ts";

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
  list: "optional", key: "one", after: "one", accept: "one", reject: "one", direction: "one", note: "one", force: "none",
  status: "none", "dry-run": "none", "retry-failed": "none",
} as const;
const HINTS = { url: "<postgres://…>", follow: "[SECONDS]", stale: "[DAYS]", dump: "<verdicts.jsonl>", list: "[pending|accepted|rejected|stale|lineage|all|relations]", key: "<judge key> (with --list)", after: "<cursor> (with the --list and --key of the page that printed it)", accept: "<proposal id>", reject: "<proposal id>", direction: "<newer|older>", note: "<text>", force: "(with --accept)" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_STATUSES = ["pending", "accepted", "rejected", "stale", "lineage", "all", "relations"];
/** A --list page's selection (SMD-3249): its status word (`all` for --list all), no lineage filter, its --key. */
const cliSelection = (list: string, key: string | undefined): ProposalSelection =>
  ({ status: list as ProposalSelection["status"], lineage: null, judgeKey: key ?? null });

/** The flags that list a selection — what a next page line prints beside the cursor, and a refused --after names. */
function selectionFlags(sel: ProposalSelection): string {
  return `--list ${sel.status}${sel.judgeKey === null ? "" : ` --key ${sel.judgeKey}`}`;
}

/**
 * What a capped --list page says of the rows past it (SMD-3248, SMD-3249). Any one-status page goes on with --after
 * and the cursor printed below it (110). Unselected, --status counts them all. Under --key, --status counts the
 * pending by pass, not this selection's rows, and a pending page also drains as it is decided — a decided row leaves
 * `pending`, so listing again shows the next. A lineage page is two listings (pending, then stale) and takes no
 * cursor. `status` is printList's: undefined for --list all; `key` is --key's, named in a lineage page's tool hint.
 */
export function capNote(status: string | undefined, key: string | undefined): string {
  // SMD-3249: any one-status page goes on with --after; under --key a pending page also drains as it is decided.
  // Review pass 1: --list pending or stale pages every pair, not the lineage ones — the tool's `lineage: true` pages
  // those; review pass 3: under --key, that pass's alone.
  if (status === "lineage") return `the rest are not listed — reject these and list again, or page them with the list_supersession_proposals tool (status: pending, then stale, each with lineage: true${key === undefined ? "" : `, judge_key: ${key}`} and after: its cursor)`;
  if (key === undefined) return "--after <the cursor below> lists the next page; --status counts them all";
  return status === "pending" ? "decide these and list again for the rest, or --after <the cursor below> for the next page; --status counts each pass's pending" : "--after <the cursor below> lists the next page";
}


/**
 * --status's pending-by-pass line (SMD-3248): ten passes at most, most first,
 * the rest counted. A key is anyone's to record (029's door takes any non-empty
 * text): one --key cannot take is shown escaped and said so, unfiltered --list
 * its only listing (review passes 2–4).
 */
export function pendingByPassLine(byPass: { judge_key: string; n: number }[]): string {
  const shown = byPass.slice(0, 10), rest = byPass.slice(10);
  const one = (b: { judge_key: string; n: number }) => `${b.n} judged by ${judgeKeyText(b.judge_key)}${selectableKey(b.judge_key) ? "" : " (not a key --key takes; listed by --list alone)"}`;
  return `  pending by pass: ${shown.map(one).join(", ")}${rest.length ? `, and ${rest.length} more pass(es) with ${rest.reduce((a, b) => a + b.n, 0)} pending` : ""} — --list --key <key> lists one pass's`;
}

/**
 * The longest --stale: stale_entities is given `make_interval(days => n)`
 * subtracted from now(), and a timestamp before 4714 BC is out of range — at
 * about 2.46 million days today, so 3,000,000 ended the listing in a stack
 * trace, and past an int the function matched no signature. 2,000,000 days
 * (some 5,475 years) is under that floor and stays so as now() moves on
 * (SMD-2304).
 */
export const MAX_STALE_DAYS = 2_000_000;

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
 * needs `url` beside `sql`, the URL of the database `sql` is connected to.
 * Nothing checks that the two name one database; a URL for another registers
 * the agent there, and the rows here carry its id. `env` is what the run
 * reads for the judge model, the endpoints, the egress policy and the worker
 * key: process.env when absent.
 *
 * `signal` stops the pass as the CLI's first signal does: every worker after
 * the thought in hand, its unfinished claims back to the pool, and wakes a
 * follower's sleep. Aborted before the pass begins, it stops the run before
 * its next write — the agent's registration, a --retry-failed statement, the
 * pool — and run() returns 130 (a statement already committed stays so); a
 * decision (--accept, --reject) stops the same way, before the key resolves
 * and before the decision is written, saying so. --status, --dry-run, --list
 * and --stale only read, and do not read it.
 * `onPass` is called once, as a run's pass begins (a decision has none) — where the CLI installs its
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
  /** --key <judge key>, with --list: one pass's proposals or relations alone, by its judge key exactly (109, SMD-3248). */
  key?: string;
  /** --after <cursor>, with the --list <status> and --key that page had: the page after the one that printed the cursor (110, SMD-3249). */
  after?: string;
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
  /**
   * A follower's heartbeat in place of its own `heartbeat:consolidate:<job>`
   * row (db/pass-stamp.ts): sleep.ts's, so a wake does not end a row
   * (SMD-1794). Null stamps nothing. Unused by a one-shot run.
   */
  stamper?: PassStamper | null;
  /**
   * A follower's start alone (SMD-2752), as extract-entities.ts's: the
   * banner, the egress gate, the tables, the judge model's probe, the worker
   * key — then 0, before the pass's first write, without waiting for a
   * provider that does not answer; or the start's refusal (2). The worker
   * key's lookup writes, as at every start (resolve_agent): it is how a
   * revoked key is found. Needs `follow`, and is a run's, not a review's.
   */
  check?: boolean;
  /** False leaves out the start's banner — the job, model and egress lines and the agent line or the no-key warning, which the sleep scheduler's check says once, and the workers line, which the check returns before — for a pass the scheduler drives (SMD-2752). */
  banner?: boolean;
  /** False leaves out the end-of-run summary — the counts and the queue — and a stopping pass's last count of the pool, which the scheduler waits for at a wake (SMD-2752). */
  summary?: boolean;
  /** How the start went (worker-bootstrap.ts's StartResult), called once (SMD-2752). */
  onStart?: (r: StartResult) => void;
  /**
   * Postgres settings the run's own client opens every connection with
   * (connect.ts's `session`): the sleep scheduler's per-pass budget —
   * statement_timeout, work_mem, maintenance_work_mem (SMD-2679). Refused
   * beside `sql`, a caller's client, which it would not reach.
   */
  session?: SessionSettings;
  /**
   * The admit gate (db/lease.ts's Admit, SMD-3379 PR 1b): awaited before each
   * claim, at the start of each pass — before its pool, the stale re-pool and
   * its counts — and before each pair of a thought. A worker waiting between
   * thoughts holds no claim; one waiting between pairs keeps its claim and
   * lease. A stop while it waits ends the worker there, as does the pass
   * ending for a reason of its own (another worker's outage, the provider's
   * refusal, a worker's throw): between pairs the thought goes back to the
   * pool unrecorded, the proposals written so far standing, and every pair
   * judged again at its next claim but those it proposed. When the gate held
   * it, the thought and every older side still to judge are read again: a
   * thought deleted or no longer this worker's has nothing more judged, one
   * edited goes back to the pool for its new text. Unused by --status,
   * --dry-run and a decision.
   */
  admit?: Admit;
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
  const workers = read("--workers", opts.workers, 2, { min: 1, max: MAX_WORKERS });
  if (typeof workers === "string") return workers;
  // One thought per claim: up to --k model calls per thought against a claim of
  // half a millisecond, so a bigger batch buys nothing, and a worker that dies
  // holds fewer rows. (Until migration 031 the lease was stamped once per batch
  // and could not be moved, so a batch of several at a long timeout could
  // outlive it; the heartbeat retires that reason.)
  const batch = read("--batch", opts.batch, 1, { min: 1, max: MAX_BATCH });
  if (typeof batch === "string") return batch;
  // The lease is renewed on a heartbeat while the worker holds rows, so it has
  // to outlast a missed beat, not the batch — db/lease.ts holds the rule the
  // three consumers share, and the refusal below is its.
  const ttl = read("--ttl", opts.ttl, DEFAULT_TTL_S);
  if (typeof ttl === "string") return ttl;
  const heartbeat = read("--heartbeat", opts.heartbeat, heartbeatFor(ttl));
  if (typeof heartbeat === "string") return heartbeat;
  const timeout = read("--timeout", opts.timeout, 120, { min: 1, max: MAX_CALL_TIMEOUT_S });
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
  const stale = read("--stale", opts.stale, 0, { min: 1, max: MAX_STALE_DAYS });
  if (typeof stale === "string") return stale;
  return { workers, batch, ttl, heartbeat, timeout, k, minSim, minConfidence, limit, follow, stale };
}

/**
 * The review flags' own rules — which combine, what a --list word may be, a
 * proposal id's shape, a note's marker — as the refusal of the first broken,
 * in the CLI's order and words, or null. Pure: no database, no output; run()
 * and the CLI both refuse through it (SMD-2304). A review takes the pass's
 * place, so --status and --dry-run, which report on the pass, are refused
 * beside one: beside a decision the decision was written anyway, and beside
 * --list or --stale they were dropped without a word (SMD-2405). --list and
 * --stale do combine with a decision: they only read, after it is written.
 */
export function reviewProblem(opts: Pick<ConsolidateOptions, "list" | "key" | "after" | "accept" | "reject" | "direction" | "force" | "note" | "limit" | "stale" | "status" | "dryRun">): string | null {
  const { list, accept, reject, direction, note } = { list: opts.list ?? undefined, accept: opts.accept ?? undefined, reject: opts.reject ?? undefined, direction: opts.direction ?? undefined, note: opts.note ?? undefined };
  if (list !== undefined && !LIST_STATUSES.includes(list)) return "--list takes pending, accepted, rejected, stale, lineage, all or relations (or nothing, for pending).";
  // SMD-3248: read only by a listing — beside anything else it would be dropped without a word (SMD-2015's kind). The
  // tool's bounds (pass-key.ts's PASS_KEY_CHARS), so the two doors take the same keys.
  const key = opts.key ?? undefined;
  if (key !== undefined && list === undefined) return "--key goes with --list: it lists one pass's proposals or relations alone, by its judge key.";
  if (key !== undefined && (key.length < 1 || key.length > 200)) return "--key takes a judge key of 1 to 200 characters, as each listed row names it (judged by consolidate:…).";
  // A pass key's own characters (pass-key.ts; review passes 1 and 3): one outside them is a typo that would select
  // nothing, or a key no selection takes, said instead.
  if (key !== undefined && !selectableKey(key)) return "--key takes a judge key of letters, digits and . _ : / @ + -, starting with a letter or digit, as each listed row names it (judged by consolidate:…).";
  // SMD-3249: --after is a proposal listing's — not relations' (another listing) nor lineage's (two listings, pending
  // then stale) — and one of its own cursors, refused here rather than read as a cast error.
  const after = opts.after ?? undefined;
  if (after !== undefined && (list === undefined || list === "relations" || list === "lineage")) return "--after goes with --list <pending|accepted|rejected|stale|all>: it lists the page after the one that printed the cursor.";
  const cursor = after === undefined ? undefined : parseProposalCursor(after);
  if (cursor === null) return "--after takes the cursor a --list page printed (next page: … --after <cursor>), as it was given.";
  // Review pass 1: a cursor carries the selection it was made under, and another selection's is refused rather than
  // listed from a place in the wrong one — rows above that place skipped without a word.
  if (cursor && list !== undefined && cursor.selection.lineage !== null) return `--after's cursor was made by the list_supersession_proposals tool under lineage: ${cursor.selection.lineage}, which --list does not select: page it there, or leave out --after for the first page.`;
  if (cursor && list !== undefined && !sameSelection(cursor.selection, cliSelection(list, key))) return `--after's cursor was made for ${selectionFlags(cursor.selection)}: pass those with it, as its next page line printed them, or leave out --after for the first page.`;
  for (const [name, v] of [["accept", accept], ["reject", reject]] as const) {
    if (v !== undefined && !UUID_RE.test(v)) return `--${name} needs a proposal id (a UUID from --list or the list_supersession_proposals tool).`;
  }
  if (accept && reject) return "--accept and --reject are one decision each; pass one.";
  const report = opts.dryRun === true ? "--dry-run" : opts.status === true ? "--status" : undefined;
  // A decision writes whatever else is asked: `--accept <id> --dry-run` accepted the proposal (SMD-2405).
  if (report !== undefined && (accept !== undefined || reject !== undefined)) {
    return `${report} writes nothing, and ${accept !== undefined ? "--accept" : "--reject"} writes a decision; pass one (--list shows the proposal without deciding it).`;
  }
  // A listing takes the pass's place: the pass's report beside it was dropped without a word (SMD-2015's kind, SMD-2405).
  if (report !== undefined && (list !== undefined || (opts.stale ?? 0) > 0)) {
    return `${report} reports on the pass, and ${list !== undefined ? "--list" : "--stale"} takes the pass's place, so ${report} would be dropped without a word; pass one.`;
  }
  if (direction !== undefined && (!accept || !["newer", "older"].includes(direction))) return "--direction takes newer or older, and only with --accept.";
  if (opts.force === true && !accept) return "--force goes with --accept: it accepts a proposal whose thought was edited after it was judged, one gone stale, one standing on a lineage pair (070), or one flagged WRITER (094).";
  // The pass's thought cap: beside --list it would be dropped without a word (SMD-2015's kind) — the
  // listing prints up to 50 of a status and --status counts each status (adversarial re-run, third review pass), and,
  // since SMD-3248, the pending by pass.
  if (opts.limit != null && list !== undefined) return "--limit is the pass's thought cap and goes with a run; --list prints up to 50 of a status (--status counts each status, and the pending by pass).";
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
  /** A refusal of the options themselves: said, reported as the start's `usage`, 2. */
  const usage = (line: string): number => {
    err(line);
    opts.onStart?.({ ok: false, refused: "usage" });
    return 2;
  };
  // A blank value where the CLI's scanner refuses one first, in its words and
  // with its flag list: `--job ""` reaches no run (SMD-2425, as reembed's).
  const blank = blankProblem(FLAGS, { dump: opts.dump, list: opts.list, accept: opts.accept, reject: opts.reject, direction: opts.direction, note: opts.note });
  if (blank !== null) return usage(`${blank}\n${flagList(FLAGS, HINTS)}`);
  // databaseUrl's two refusals without its exit, then the numbers and the
  // review flags. A URL beside a caller's client is the worker key's (above),
  // so it is held to the rule too.
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) return usage(urlProblem);
  const settled = numbers(opts);
  if (typeof settled === "string") return usage(settled);
  const review = reviewProblem(opts);
  if (review !== null) return usage(review);
  const reviewing = opts.list != null || opts.accept != null || opts.reject != null || settled.stale > 0;
  // The check is a follower run's start, its probe included (SMD-2752).
  if (opts.check && (!settled.follow || reviewing || opts.status === true || opts.dryRun === true)) return usage("consolidate.ts: check is a follower run's start — pass follow beside it, and no review, --status or --dry-run.");
  const deciding = opts.accept != null || opts.reject != null;
  // A run and a decision write — resolve the key, and stop under an aborted
  // signal; --status, --dry-run, --list and --stale only read (review pass 2:
  // the two rules had drifted apart for a decision beside --dry-run).
  const writes = deciding || !(opts.status === true || opts.dryRun === true || reviewing);
  if (opts.sql != null && opts.session != null) return usage("consolidate.ts applies session settings to a client of its own: pass url without sql, or no session.");
  if (opts.sql != null) {
    // A reserved connection or a transaction's handle reports its pool's max
    // but is one connection, and a transaction keeps the run's claims from the
    // other workers — and a rollback from the database.
    const handle = opts.sql as { release?: unknown; savepoint?: unknown };
    if (typeof handle.release === "function" || typeof handle.savepoint === "function") {
      return usage("consolidate.ts needs a pool, not a reserved connection or a transaction's handle: either is one connection whatever max it reports, and a transaction's claims are no other worker's until it commits. Pass the client itself, or a URL.");
    }
    // One connection per worker and one spare: the heartbeat (db/lease.ts)
    // beats through the pool, and a worker parked on a lock or a long statement
    // holds its own connection, so the spare is what keeps every worker's
    // leases alive then. Tightening this to the workers would recreate the
    // lapse 031 removed. Bun's default pool is ten.
    const max = Number((opts.sql as { options?: { max?: number } }).options?.max ?? 10);
    if (max < settled.workers + 1) {
      return usage(`consolidate.ts needs a client of at least ${settled.workers + 1} connections for ${settled.workers} worker(s): one each and a spare the heartbeat beats through (db/lease.ts). Pass a client opened with a larger max option, or a URL.`);
    }
    if (noUrl && (opts.env ?? process.env).OB1_WORKER_KEY && writes) {
      return usage("consolidate.ts resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
    }
  }
  // A signal aborted before the call: nothing opened, nothing written. --status,
  // --dry-run, --list and --stale only read, and read on; a decision writes, and
  // stops as a run does (review pass 1).
  if (opts.signal?.aborted && writes) {
    err(deciding ? DECISION_STOPPED : STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: settled.workers + 1, session: opts.session ?? undefined });
  // Aborted when the run returns, taking its listener off the caller's signal.
  const detach = new AbortController();
  // The start's refusal ends a follower's own row with its kind, as
  // extract-entities.ts's run() does (SMD-3214); never the scheduler's.
  let refusedAt: StartRefusal | null = null;
  const heard: ConsolidateOptions = { ...opts, onStart: (r) => { if (!r.ok) refusedAt = r.refused; opts.onStart?.(r); } };
  try {
    const code = await consolidateWith(sql, heard, settled, writes, out, err, detach.signal);
    if (code === 2 && refusedAt !== null && settled.follow && opts.stamper === undefined && !opts.check && !opts.status && !opts.dryRun) {
      const job = consolidatePassKey(resolveEmbedConfig((opts.env ?? process.env) as EmbedEnv));
      await endOnRefusal({ sql, worker: "consolidate", job, intervalS: settled.follow, kind: refusedAt, onError: (e) => err(`  heartbeat ${stampKey("consolidate", job)} not ended on the refusal: ${e.message.split("\n")[0]}`) });
    }
    return code;
  } finally {
    detach.abort();
    // A failing close must not mask the run's own error.
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** The run once its options are settled: the script's body as it was, printing through the Writer and returning where it exited. */
async function consolidateWith(sql: SQL, opts: ConsolidateOptions, settled: Numbers, writes: boolean, out: Writer["out"], err: Writer["err"], detach: AbortSignal): Promise<number> {
  const { workers: WORKERS, batch: BATCH, ttl: TTL, heartbeat: HEARTBEAT, timeout: TIMEOUT_S, k: K, minSim: MIN_SIM, minConfidence: MIN_CONFIDENCE, limit: LIMIT, follow: FOLLOW, stale: STALE_DAYS } = settled;
  const env = opts.env ?? process.env;
  /** Append every verdict here as JSONL — {newer, older, similarity, shared, verdict, supersedes, confidence, reason, evidence, evidence_found, key, proposal} — for evals/eval-consolidate.ts. */
  const DUMP = opts.dump ?? undefined;
  const STATUS_ONLY = opts.status === true;
  const DRY_RUN = opts.dryRun === true;
  const RETRY_FAILED = opts.retryFailed === true;
  const LIST = opts.list ?? undefined;
  const KEY = opts.key ?? undefined;
  const AFTER = opts.after === undefined ? undefined : parseProposalCursor(opts.after) ?? undefined;
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
  /**
   * A statement of the start, before the first claim: a follower's outlasts
   * the database going away, as extract-entities.ts's does (SMD-2752) — the
   * sleep scheduler starts a pass at every sleep. Null when the caller's
   * signal ends the wait (the CLI's, before its handlers: SMD-2666). A run
   * without --follow, and a read or review beside it, still rejects on the
   * error (review pass 3).
   */
  const REVIEW_ONLY = LIST !== undefined || ACCEPT !== undefined || REJECT !== undefined || STALE_DAYS > 0;
  const startSaid = { down: false };
  const atStart = <T>(run: () => Promise<T>): Promise<T | null> =>
    FOLLOW && !STATUS_ONLY && !DRY_RUN && !REVIEW_ONLY ? throughOutage(run, { wake: opts.signal ?? new AbortController().signal, said: startSaid, out, err }) : run();
  /** An atStart wait the caller's signal ended (its null): a stop before the pass began. */
  const stoppedWaiting = (): number => {
    stoppedEarly();
    return 130;
  };
  /** The start alone, for the sleep scheduler's check (SMD-2752): run() refused it beside anything but a follower run. */
  const CHECK = opts.check === true;
  /** The start's banner, which a pass the scheduler drives leaves to its check (SMD-2752). */
  const say: Writer["out"] = opts.banner === false ? () => {} : out;
  /** The end-of-run summary's queries, which a pass the scheduler drives leaves out (SMD-2752). */
  const SUMMARY = opts.summary !== false;
  const ADMIT = opts.admit;
  /** A start refusal: said, reported to `onStart` as which it is (SMD-2752), 2. */
  const refused = (kind: StartRefusal, line: string): number => {
    err(line);
    opts.onStart?.({ ok: false, refused: kind });
    return 2;
  };

  const cfg = resolveEmbedConfig(env as EmbedEnv);
  // Decide mode (SMD-3115): the typed-decision tier's model gives each verdict, and the judge's model writes only
  // the proposals it calls. It needs the tier, at OB1_JEV_BASE_URL, and the model the tier is held to is the
  // decider, so an answer from any other is refused (the pass key names the decider).
  // A review (--accept/--reject) judges nothing, so it needs no tier.
  let jev: JevConfig | null = null;
  if (cfg.decider && !REVIEW_ONLY) {
    const tier = resolveJevConfig(env as JevEnv);
    if (!tier) return refused("usage", `\n  OB1_CONSOLIDATE_DECIDER is ${cfg.decider} and OB1_JEV_BASE_URL is unset: decide mode asks the typed-decision tier for every verdict (SMD-3115). Point OB1_JEV_BASE_URL at the tier serving ${cfg.decider}, or unset OB1_CONSOLIDATE_DECIDER for the judge.`);
    if (tier.model && tier.model !== cfg.decider) return refused("usage", `\n  OB1_JEV_MODEL is ${tier.model} and OB1_CONSOLIDATE_DECIDER is ${cfg.decider}: the tier's verdicts would come from a model the pass key does not name. Set the two to the same model.`);
    jev = { ...tier, model: cfg.decider };
  }
  // The judge's model, not the extractor's: OB1_JUDGE_MODEL, else the metadata
  // model (SMD-1901). The key carries it, so a pass under another judge is
  // another pass — --status and preflight report each by name. In decide mode
  // the key names the decider and the writer (consolidatePassKey).
  const JOB = consolidatePassKey(cfg);

  say(`  job:    ${JOB}`);
  // Which knob named it is read off the resolved pair, not the raw variable: a
  // value the resolver treats as unset (empty, or the metadata model's own name)
  // is the metadata model here too, however it was spelled.
  if (!REVIEW_ONLY) say(`  model:  ${cfg.judgeModel}${cfg.judgeModel !== cfg.metadataModel ? " (OB1_JUDGE_MODEL)" : " (the metadata model; OB1_JUDGE_MODEL gives the judge its own)"} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}; up to ${K} older neighbour(s) per thought at cosine >= ${MIN_SIM}; outdates recorded at confidence >= ${MIN_CONFIDENCE}, the token probability where the endpoint returns one`);
  if (jev) say(`  decide: ${cfg.decider} through the typed-decision tier at ${jev.endpoint.base} gives each verdict, its P(outdates) the confidence; ${cfg.judgeModel} only writes the proposals it calls at >= ${MIN_CONFIDENCE}, two-sided with the part rule, its quotes read without markdown; it is first asked the mediated-pair test's link step of those pairs and of an evolves the pass would store, and an H or F link caps the pair at related with no proposal (OB1_CONSOLIDATE_DECIDER, SMD-3115, SMD-3151, SMD-3203)`);
  // What may leave the box (SMD-1903): a pair either row of which the gate
  // refuses is not judged, and the thought's claim fails naming the rule.
  if (!REVIEW_ONLY) say(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
  if (jev) say(`  tier:   ${egressDescription(jev.endpoint, jev.egress, "OB1_JEV_LOCAL")}`);
  if (jev) {
    // The tier's gate, as the chat endpoint's below: a policy that refuses every row stops the run before it claims.
    const blanket = blanketGate({ endpoint: jev.endpoint, policy: jev.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "decided", localKnobKey: "OB1_JEV_LOCAL" });
    if (blanket && !STATUS_ONLY && !DRY_RUN) return refused("egress", `\n  ${blanket}`);
  }
  {
    // A policy that refuses whatever the row (SMD-1903): stop before claiming,
    // rather than fail every row in the pool one at a time. A dry run and
    // --status still report — the banner's egress line says why a run would not.
    // The units a row of this pass carries: its metadata and text, and the
    // worker key's name as the actor when one is set — re-checked below once
    // the key has, or has not, resolved (third review pass).
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "judged", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !STATUS_ONLY && !DRY_RUN && !REVIEW_ONLY) return refused("egress", `\n  ${blanket}`);
  }

  // ── The database's side ─────────────────────────────────────────────────────

  const tables = await atStart(async () => Number((await sql`
    SELECT count(*)::int AS tables FROM pg_class
    WHERE relname IN ('thought_work_claims', 'thought_entities', 'supersession_proposals') AND relkind = 'r'`)[0].tables));
  if (tables === null) return stoppedWaiting();
  if (tables < 3) return refused("tables", "\n  The lease table, the entity tables or the proposal table are missing. Apply migrations 015, 016 and 029 first:\n    cd db && bun migrate.ts --url …");

  // ── The provider, for a follower (SMD-2599) ─────────────────────────────────

  /**
   * As extract-entities.ts's: a follower probes the judge model with a
   * one-token call before it writes anything, the worker key's registration
   * included — a model the provider does not serve, a key it refuses or a
   * wrong base URL exits 2 there — and while it waits an outage out. A
   * provider that does not answer at start is waited for as the run's last
   * step before it writes the pool, held to the same refusals when it
   * answers (review pass 2). After a pair's timeout the probe has the call's
   * whole timeout, and the pass's stop ends it.
   */
  // In decide mode both must answer: the writer's chat endpoint, then the tier serving the decider (SMD-3115) — a
  // tier that is down while the chat endpoint answers is still an outage, not a pass to go on with.
  const probe = async (ms = Math.min(TIMEOUT_S, 60) * 1000, wake?: AbortSignal): Promise<Probe> => {
    const chat = await probeChat(cfg.chat, cfg.judgeModel, ms, wake);
    return jev && chat.state === "up" ? probeTier(jev, cfg.decider, ms, wake) : chat;
  };
  const outage = new ProviderOutage();
  /** Probe until the provider answers, saying when it stopped and when it answered; a stop ends the wait. */
  async function waitForProvider(wake: AbortSignal): Promise<void> {
    const down = Date.now();
    err(`  the provider is not answering (${(outage.reason ?? "").slice(0, 200)}) — unfinished thoughts are back in the pool, recorded nothing; the follower calls ${cfg.judgeModel} at ${cfg.chat.base} for one token${jev ? `, then reads the tier's /info at ${jev.endpoint.base},` : ""} after ${OUTAGE_MS.first / 1000} s and then twice as long each time, up to ${OUTAGE_MS.max / 60_000} min`);
    // Said on the row it stamps: the sleep scheduler's, which also sets
    // extraction to the newer work while the judge waits (SMD-3008), or this
    // follower's own (SMD-2905); a stop wakes the probes, so the end is said
    // before the pass settles.
    await stamper?.providerWait?.(true);
    try {
      if (await probeUntil(() => probe(undefined, wake), wake, (p) => !isOut(p))) {
        outage.end();
        out(`  the provider answers again after ${Math.round((Date.now() - down) / 1000)} s; polling resumes`);
      }
    } finally {
      await stamper?.providerWait?.(false);
    }
  }
  /** The start's refusal of what a probe found — the judge model unserved, or the endpoint refusing — or null. */
  function startRefusal(p: Probe): string | null {
    if (p.state !== "up" && p.tier && p.state !== "out") {
      return `\n  ${p.why.slice(0, 300)} at start.\n` +
        `  A --follow worker refuses this before it claims anything (SMD-2599, SMD-3115): ${p.state === "missing" ? `serve ${cfg.decider} at OB1_JEV_BASE_URL, or set OB1_CONSOLIDATE_DECIDER to the model the tier serves (a new pass key). Once running, a decider that goes missing is waited for.` : "check OB1_JEV_BASE_URL: it must be an ob1-jev/1 tier (jev/README.md)."}`;
    }
    if (p.state === "missing") {
      return `\n  ${cfg.chat.base} does not serve ${cfg.judgeModel} at start (${p.why.slice(0, 300)}).\n` +
        "  A --follow worker refuses this before it claims anything (SMD-2599): pull the model, or set OB1_JUDGE_MODEL (else OB1_METADATA_MODEL) to one the provider serves. Once running, a model that goes missing is waited for.";
    }
    if (p.state === "refused") {
      return `\n  ${cfg.chat.base} refuses a one-token call at start (${p.why.slice(0, 300)}).\n` +
        "  A --follow worker refuses this before it claims anything (SMD-2599): check the chat endpoint's key (OB1_CHAT_API_KEY, else OB1_LLM_API_KEY) and its base URL (OB1_CHAT_BASE_URL, else OB1_LLM_BASE_URL — an OpenAI-compatible one ends in /v1).";
    }
    return null;
  }
  /** Why the provider did not answer at start, when it did not: waited for below, before the pool. */
  let startOut: string | null = null;
  if (FOLLOW && !REVIEW_ONLY && !STATUS_ONLY && !DRY_RUN) {
    if (stoppedEarly()) return 130;
    const first = await probe(undefined, opts.signal);
    const refusal = startRefusal(first);
    if (refusal) return refused(probeRefusal(first), refusal);
    if (first.state === "out") startOut = first.why;
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
  // A run, or a decision: both write and are attributed (run()'s `writes`, the one rule). --status, --dry-run, --list and --stale only read.
  if (writes) {
    if (stoppedEarly()) return 130;
    // Without a key the URL is not read; with one, run() refused a missing URL.
    // A follower's lookup waits a database outage out, rather than writing its proposals unattributed.
    // The agent line and the no-key warning are the banner's; a lookup that
    // could not resolve is warned of whatever the banner (SMD-2752).
    const id = await atStart(() => workerIdentity(opts.url ?? "", env, {
      noKeyWarning: opts.banner === false ? "" : `  ⚠  OB1_WORKER_KEY is not set: ${ACCEPT || REJECT ? "the review is audited as 'consolidate' with no agent id" : "proposals will carry no agent id"}. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.`,
      write: say,
      warn: (l) => { if (l) err(l); },
      outage: FOLLOW ? lookupOutage : undefined,
    }));
    if (id === null) return stoppedWaiting();
    if (!id.ok) return refused("identity", id.message);
    agentId = id.identity.agentId;
    keyName = id.identity.keyName;
    // The audit label above is not an actor; the resolved key's name, when there
    // is one, is (third review pass).
    if (keyName) actorName = keyName;
    // A key that was set but did not resolve to a name is no actor: the blanket
    // check above credited one, so it is asked again without (third review pass).
    // A lookup that did not name the key may name it next time (a database
    // refusing connections), so the refusal is `lookup`, not `egress` (SMD-2752).
    if (env.OB1_WORKER_KEY && keyName === undefined && !REVIEW_ONLY) {
      const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
      if (again) return refused("lookup", `\n  ${regateMessage("judged", again)}`);
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
  /** 070: --status's clause for the unreviewed rows standing on a lineage pair — the listing named, or the file it needs first (its own SQL reads on a brain at 068); the listing is 110's since SMD-3249 (109's, 070's before). */
  const lineageClause = (n: number, has110: boolean): string =>
    `${n} unreviewed standing on a lineage pair (${has110 ? "--list lineage shows them" : "apply migration 110 first — cd db && bun migrate.ts --url <url> — then --list lineage shows them"}; the reviewer rejects each — the pass never replaces a pending one)`;
  const staleClause = (st: ReturnType<typeof staleStandings>): string =>
    `${st.total} stale (a text moved under the verdict: ${staleStandingsText(st, JOB)}; the pass replaces one it proposes again and settles one it does not)`;

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
  /**
   * SMD-2707: one side of a row — its text, the ID line, then who wrote it
   * (094) and what supersedes it, as the tool's reply prints them. An ingested
   * side's notice goes before its text, the text then behind a label of its
   * own (SMD-1724's rule).
   */
  const sideLines = (label: "newer" | "older", s: ProposalSide, at: Stamp) => {
    const notice = s.writer ? ingestedNotice({ trust: s.writer.trust }) : null;
    const head = `     ${label} [${day(at)}]${s.edited ? " EDITED SINCE JUDGED" : ""}`;
    return `${notice ? `${head} ${notice}\n        text: ${snippet(s.content)}` : `${head} ${snippet(s.content)}`}\n        ID: ${s.id}` +
      (s.writer ? `\n        ${proposalWriterLine(s.writer)}` : "") +
      (s.supersededBy ? `\n        ${supersededLine(s.supersededBy)}` : "") +
      (s.lapses.length ? `\n        ${lapsesLine(s.lapses, s.id)}` : "") +
      (s.walkCapped ? `\n        ${walkCappedLine()}` : "");
  };
  /** SMD-2707: the row's WRITER line — the flags, and while the row is the reviewer's, the accept it takes (the reply's words). */
  const writerFlagLine = (status: string, flags: StandingFlag[], p: { older: ProposalSide; newer: ProposalSide }) =>
    `     writer: ${writerFlagsText(flags, p)}${status === "pending" || status === "stale" ? writerFlagAdvice(flags) : ""}`;
  /** review_supersession_proposal's answer (029/036), plus the CLI's own LINEAGE_PAIR (070) and WRITER (SMD-2707) refusals. */
  type ReviewResult = { ok: boolean; error?: string; status?: string; superseding_id?: string; superseded_id?: string; written?: boolean; cleared?: boolean; current?: string; verdict?: string; older_edited?: boolean; newer_edited?: boolean; flags?: StandingFlag[]; lapsed?: { id: string; onto: string }[] };
  // Thought content, the judge's reason, a review note and entity names are
  // untrusted; snipText (the MCP replies' cleaner) puts each on one line —
  // every break a reader may take, NEL among them, a space — and strips what
  // would move the cursor or rewrite the ID: line a reviewer is about to paste
  // (SMD-2533).
  const snippet = (s: string, n = 160) => snipText(s, n);
  // SMD-1803: the CLI twin of the server's proposal renderer. Through the store's
  // canonical rule (isoDay), not new Date().toISOString(), which fabricated
  // 1970-01-01 on a NULL created_at and THREW on an infinity-dated one, taking
  // the whole listing down.
  const day = (d: Stamp) => isoDay(d) ?? "undated";
  const verdictPhrase = (v: string) =>
    v === "newer_supersedes_older" ? "the NEWER thought supersedes the older"
    : v === "older_supersedes_newer" ? "the OLDER thought supersedes the newer"
    : "one is out of date, which not stated";

  /**
   * SMD-2707: a row's writers and its WRITER flags for this accept, read as
   * the listing reads them (list_proposal_writers, 094), its takes and
   * lapses in full past the listing's cap (107, SMD-3036) — pending, stale or
   * rejected, each of which 029 accepts (review pass 1: a rejected flagged
   * row was accepted without --force); null on an accepted row (029 answers
   * it); "no-094" on a brain short of the file. On an undirected verdict
   * with no --direction the flags are each open side's (`how: "if"`): the
   * WRITER refusal defers to 029's request for a direction, and a lineage
   * refusal still names them (review pass 3). `edited`: a text moved since
   * judged, the other check a --force would also waive; `sides`: what each
   * side's accept would lapse, for the refusal's words.
   */
  async function writersOf(id: string): Promise<{ flags: StandingFlag[]; older: ProposalWriter; newer: ProposalWriter; edited: boolean; status: string; sides: { older: { lapses: unknown[] }; newer: { lapses: unknown[] } } } | "no-094" | null> {
    let rows: Record<string, unknown>[];
    try {
      rows = (await sql`
        SELECT p.verdict, p.status AS proposal_status,
               p.older_fingerprint IS NOT NULL AND p.older_fingerprint IS DISTINCT FROM content_fingerprint_of(o.content) AS older_moved,
               p.newer_fingerprint IS NOT NULL AND p.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(n.content) AS newer_moved,
               w.older_actor_name, w.older_actor_kind, w.older_trust, w.older_capture_only,
               w.newer_actor_name, w.newer_actor_kind, w.newer_trust, w.newer_capture_only, w.same_capturer,
               -- 107 (SMD-3036): the listing caps its walks; the guard reads its
               -- one row's in full, so its refusal and the pointers it names are
               -- never the cap's.
               ob1_accept_takes(p.older_id, p.newer_id) AS older_takes, ob1_accept_lapses(p.older_id, p.newer_id) AS older_lapses,
               ob1_accept_takes(p.newer_id, p.older_id) AS newer_takes, ob1_accept_lapses(p.newer_id, p.older_id) AS newer_lapses
          FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts n ON n.id = p.newer_id
          CROSS JOIN LATERAL list_proposal_writers(ARRAY[p.id]) w
         WHERE p.id = ${id}::uuid AND p.status IN ('pending', 'stale', 'rejected')`) as Record<string, unknown>[];
    } catch (e) {
      if (WRITERS_MISSING.test((e as Error).message)) return "no-094";
      throw e;
    }
    if (!rows.length) return null;
    const r = rows[0];
    const text = (v: unknown) => (v == null ? null : String(v));
    const w = (side: "older" | "newer"): ProposalWriter =>
      ({ name: text(r[`${side}_actor_name`]), kind: text(r[`${side}_actor_kind`]), trust: text(r[`${side}_trust`]), captureOnly: r[`${side}_capture_only`] === true });
    const older = w("older"), newer = w("newer");
    const flags = standingFlags({ verdict: String(r.verdict), sameCapturer: r.same_capturer === true, older: { writer: older, takes: r.older_takes === true }, newer: { writer: newer, takes: r.newer_takes === true } },
      DIRECTION === "newer" || DIRECTION === "older" ? DIRECTION : undefined);
    // A row goes stale when a text moved under its verdict (063), and what a
    // --force waives there is that move, 029's edit check (review pass 2).
    const arr = (v: unknown): unknown[] => { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; };
    return { flags, older, newer, edited: r.older_moved === true || r.newer_moved === true, status: String(r.proposal_status),
      sides: { older: { lapses: arr(r.older_lapses) }, newer: { lapses: arr(r.newer_lapses) } } };
  }

  async function printList(status: string | undefined, limit = 50): Promise<number> {
    // 110's seven-argument form, always: 029, 070 or 109 re-applied by hand
    // lands its form beside 110's, and a call both forms take (under three
    // arguments beside 029's, four beside 070's, five beside 109's) is then
    // ambiguous (not unique) and fails; seven resolve (preflight's lineage
    // check names the leftover). --key selects one pass in the SQL, before the
    // cap (SMD-3248); --after starts past the cursor's row (SMD-3249). Each
    // read here names its columns, never `*`, as the store's do (SMD-3302).
    const listed = async (st: string | null, lineage: boolean | null) =>
      (await sql`SELECT id, status, verdict, confidence, reason, similarity, judge_key, judged_at, reviewed_at, review_note, superseding_id,
                        older_id, older_content, older_created_at, newer_id, newer_content, newer_created_at, older_edited, newer_edited,
                        lineage, page_key, remaining
                   FROM list_supersession_proposals(${st}::text, ${limit}::int, ${lineage}::boolean, ${KEY ?? null}::text,
                                                    ${AFTER?.confidence ?? null}::numeric, ${AFTER?.judgedAt ?? null}::timestamptz, ${AFTER?.id ?? null}::uuid)`) as Listed[];
    // --list lineage: the unreviewed rows standing on a lineage pair — the
    // reviewer's alone (a pending row holds its pair, 066 never re-finds it;
    // a stale one waits for the pass's settle, 067) — pending first, then
    // stale, each most confident first.
    const lineageMode = status === "lineage";
    // An --after time Postgres cannot read was refused before any decision (review pass 2).
    const listedRows = lineageMode ? [...await listed("pending", true), ...await listed("stale", true)] : await listed(status ?? null, null);
    // 094 (SMD-2707): each side's writer, its superseder, what an accept
    // would lapse, and whether one agent captured both, by the page's ids —
    // none on a brain short of 094, said once; a row the read did not return
    // is a proposal gone in between, dropped (review pass 4).
    let writers: Record<string, unknown>[] = [];
    let read = false;
    if (listedRows.length) {
      try {
        writers = (await sql`SELECT id, older_actor_name, older_actor_kind, older_trust, older_capture_only, older_superseded_by, older_lapses, older_takes,
                                    newer_actor_name, newer_actor_kind, newer_trust, newer_capture_only, newer_superseded_by, newer_lapses, newer_takes,
                                    same_capturer
                               FROM list_proposal_writers(${sql.array(listedRows.map((p) => p.id), "UUID")}::uuid[])`) as Record<string, unknown>[];
        read = true;
      } catch (e) {
        if (!WRITERS_MISSING.test((e as Error).message)) throw e;
      }
    }
    const writerIds = new Set(writers.map((w) => String(w.id)));
    const rows = read ? listedRows.filter((p) => writerIds.has(p.id)) : listedRows;
    // SMD-3248: the pass selected is said with the rest of the selection.
    // Review pass 1: a page after a cursor says so — its rows are not the selection's first.
    const what = (lineageMode ? "unreviewed proposals standing on a lineage pair" : `${status ? `${status} ` : ""}proposals`) + (KEY === undefined ? "" : ` judged by ${KEY}`) + (AFTER ? " past the cursor" : "");
    // A list that hits its cap says so: --status counts every row (definitions
    // probe, second review pass: 61 rows, 50 printed, the header counted 50).
    // Read off the listing as it came back: a row dropped since is no sign
    // the queue ended (review pass 5).
    const hit = (st: string) => listedRows.filter((r) => r.status === st).length === limit;
    // 110 (SMD-3249): a one-status page knows whether more follow — the listing's remaining, counted before the cap,
    // beyond the rows it gave — and where the next page starts, its last row's page_key: the selection's flags and the
    // cursor, the line to run (review pass 1: the cursor alone, and a page listed with other flags started mid-way).
    const remaining = listedRows.length ? Number((listedRows[0] as unknown as { remaining: unknown }).remaining) : 0;
    const capped = lineageMode ? hit("pending") || hit("stale") : remaining > listedRows.length;
    const lastKey = !lineageMode && capped ? JSON.parse(String((listedRows[listedRows.length - 1] as unknown as { page_key: unknown }).page_key)) as string[] : null;
    const sel = lastKey ? cliSelection(status ?? "all", KEY) : null;
    const nextPage = lastKey && sel ? `  next page: ${selectionFlags(sel)} --after ${proposalCursor(sel, lastKey[0], lastKey[1], lastKey[2])}` : null;
    if (rows.length === 0) {
      // Review pass 1: past a cursor, none is the listing's end, not an empty queue; and a page whose rows all went
      // before the writers' read still prints the line past them.
      out(nextPage ? `  no ${what} on this page: the ones it listed went before they were read\n${nextPage}` : AFTER ? `  no more ${what.replace(" past the cursor", "")} past this cursor — the listing ends here` : `  no ${what}`);
      return 0;
    }
    // Under --key, --status counts the pending by pass, not this status's rows; only a pending page drains as it is decided (review passes 1 and 2).
    const more = capNote(status, KEY);
    out(`  ${rows.length} ${what.replace("proposals", "proposal(s)")}${lineageMode ? " (pending, then stale)" : ""}, most confident first${capped ? ` — ${lineageMode ? `pending and stale capped at ${limit} each` : `the first ${listedRows.length} of ${remaining}`}; ${more}` : ""}:\n`);
    // 067: a stale row's standing against the pools, beside its status. (A
    // row the pass settled needs no tag: its note begins with the marker.)
    const standing = rows.some((p) => p.status === "stale") ? (await readStaleStandings()).byId : new Map<string, never>();
    const proposals = withWriters(rows as unknown as Record<string, unknown>[], writers, read).map(normaliseProposal);
    if (!read) out(`  ${WRITERS_UNREAD}\n`);
    rows.forEach((p, i) => {
      const np = proposals[i];
      const flags = standingFlags(np);
      // SMD-2533: a note cleaned to nothing prints nothing, as the reply's does.
      const note = p.review_note ? snippet(p.review_note, PROPOSAL_TEXT_MAX) : "";
      out(`  ${i + 1}. [${Number(p.confidence).toFixed(2)}] ${verdictPhrase(p.verdict)}${p.lineage ? "  LINEAGE PAIR" : ""}${flags.length ? "  WRITER" : ""}${p.status !== "pending" ? `  (${p.status}${p.status === "stale" ? ` — ${staleStandingText(standing.get(p.id) ?? { s: "waiting", keys: [] }, JOB)}` : ""}${p.reviewed_at ? ` ${day(p.reviewed_at)}` : ""}${stoodSide(np) ? `, the ${stoodSide(np)} side standing` : ""}${note ? `: ${note}` : ""})` : ""}`);
      // SMD-2533: behind its label, so a reason reading `ID: <uuid>` starts no line of its own.
      const reason = p.reason ? snippet(p.reason, PROPOSAL_TEXT_MAX) : "";
      if (reason) out(`     reason: ${reason}`);
      out(sideLines("newer", np.newer, p.newer_created_at));
      out(sideLines("older", np.older, p.older_created_at));
      // The key through the replies' cleaner: a recorded one holding a newline starts no line of its own (review pass 2).
      out(`     proposal ${p.id}  cosine ${p.similarity === null ? "?" : Number(p.similarity).toFixed(3)}  judged by ${judgeKeyText(p.judge_key)} on ${day(p.judged_at)}`);
      // 070: a lineage pair — one side derived from the other — is never
      // proposed since 066; a row standing on one is said so, with the reject
      // while the row is the reviewer's.
      if (p.lineage) out(lineageLine(p));
      // SMD-2707: the side to stand is a capture-only key's text or of lower
      // trust; an accept takes --force, as on a lineage pair.
      if (flags.length) out(writerFlagLine(p.status, flags, np));
      if (p.status === "pending" || p.status === "stale") {
        // Commands as they run: a placeholder the shell cannot parse rather
        // than `newer|older`, which it would read as a pipe (review pass 3).
        // A stale row (063: a text moved under the verdict) is the next pass's
        // to replace or settle (067), and a reviewer's to decide sooner — its
        // texts moved, so an accept takes --force.
        const dir = p.verdict === "conflict_undirected" ? " --direction <newer|older>" : "";
        // SMD-2707: an undirected verdict a flag splits gets one accept per
        // direction, --force on the one that needs it (review pass 1).
        const force = (d?: "newer" | "older") => (p.older_edited || p.newer_edited || p.status === "stale" || p.lineage || flags.some((f) => !d || f.stands === d) ? " --force" : "");
        out(p.verdict === "conflict_undirected" && flags.length
          ? `     --accept ${p.id} --direction newer${force("newer")}    --accept ${p.id} --direction older${force("older")}    --reject ${p.id}`
          : `     --accept ${p.id}${dir}${force()}    --reject ${p.id}`);
      }
      out("");
    });
    // SMD-3249: where the next page starts, the cursor the tool's reply carries too.
    if (nextPage) out(nextPage);
    return rows.length;
  }

  async function printStale(days: number): Promise<void> {
    const rows = (await sql`SELECT entity_id, entity_type, name, thoughts, newest_at FROM stale_entities(make_interval(days => ${days}), 50)`) as
      { entity_id: string; entity_type: string; name: string; thoughts: number; newest_at: Stamp }[];
    if (rows.length === 0) {
      out(`  stale: no entity has gone ${days} days without a mention`);
      return;
    }
    out(`  stale: ${rows.length} entit${rows.length === 1 ? "y" : "ies"} nothing has mentioned in ${days} days (oldest first; reported, not acted on):`);
    // Names are one line each: control characters stripped and whitespace
    // collapsed, so a name cannot start a forged row (review pass 4) — NEL
    // among the breaks (SMD-2533). Cut as before, at 50 UTF-16 units with no
    // ellipsis, so the column keeps its width.
    for (const r of rows) out(`    ${r.entity_type.padEnd(12)} ${snippet(r.name, Infinity).slice(0, 50).padEnd(50)} ${r.thoughts} thought(s), last ${day(r.newest_at)}`);
  }

  if (REVIEW_ONLY) {
    let code = 0;
    // A --after time Postgres cannot read — a year 0, past its range, which the cursor's shape admits — is the caller's,
    // refused in --after's words before anything is written (review pass 2: refused at the listing, it came after a
    // --reject beside it had written, and its exit 2 replaced the decision's). Only a hand-made cursor reaches here.
    if (AFTER) {
      if (!(await sql`SELECT ${AFTER.judgedAt}::timestamptz`.then(() => true, (e: unknown) => (timeCastFailed(e) ? false : Promise.reject(e))))) {
        err("--after takes the cursor a --list page printed (next page: … --after <cursor>), as it was given: this one's time is not one Postgres reads.");
        return 2;
      }
    }
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
                      WHERE p.id = ${id}::uuid AND p.status IN ('pending', 'stale', 'rejected')`) as { lineage: boolean }[]
        : [];
      // SMD-2707: an accept whose standing side is a capture-only key's text,
      // or of lower trust than the other, is refused unless --force — the
      // maintainer's choice, 070's rule for a lineage pair: the reviewer reads
      // both writers first. The same rule the listing flags by (standingFlags),
      // with --direction as the review takes it; read on a lineage pair too,
      // so its refusal names a flag the --force would also waive (pass 2).
      const writers = decision === "accept" && !FORCE ? await writersOf(id) : null;
      const review = async (q: typeof sql) => (await q`
        SELECT review_supersession_proposal(${id}::uuid, ${decision}::text, ${NOTE ?? null}::text, ${DIRECTION ?? null}::text, ${passActor()}::jsonb, ${FORCE}::boolean) AS r`)[0].r as ReviewResult;
      // A brain short of 094: said, and the other checks answer as before.
      if (writers === "no-094") err(`  ${WRITERS_UNREAD} The writer check did not run: cd db && bun migrate.ts --url <url>`);
      const res: ReviewResult = lineageRow[0]?.lineage === true
        ? { ok: false, error: "LINEAGE_PAIR" }
        : writers !== "no-094" && writers?.flags.some((f) => f.how !== "if")
            ? { ok: false, error: "WRITER", flags: writers.flags }
            : decision === "accept"
              // SMD-2707: the accept and a read of what its lapse cleared, in one
              // transaction — 082's lapse writes each cleared pointer as an update
              // event of this transaction's, under this actor.
              ? await sql.begin(async (tx) => {
                  const r = await review(tx as unknown as typeof sql);
                  if (r.ok) {
                    // This transaction's own events (xmin, review pass 4: two
                    // accepts under one actor name sharing now() each read the
                    // other's); the write path writes nothing inside a
                    // subtransaction, and test-live's lapse cell fails if it
                    // ever does. In the order the lapse cleared them, which is
                    // the order --list named them (SMD-3035's one walk).
                    r.lapsed = (await tx`
                      SELECT thought_id::text AS id, diff->'supersedes'->>'before' AS onto FROM thought_audit
                       WHERE created_at = now() AND action = 'update' AND actor_name = ${actorName}
                         AND xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text
                         AND diff ? 'supersedes' AND diff->'supersedes'->>'after' IS NULL
                       ORDER BY seq`) as { id: string; onto: string }[];
                  }
                  return r;
                })
              : await review(sql);
      if (res.ok) {
        if (decision === "accept") {
          out(`  accepted ${id}: ${res.superseding_id} now supersedes ${res.superseded_id}${res.written ? "" : " (the pointer already held that value)"}; the change is in thought_audit under ${actorName}`);
          // SMD-2707: a second write the reviewer did not ask for, onto a third
          // thought — said, with the thought it named.
          for (const l of res.lapsed ?? []) {
            out(`  lapsed: ${l.id} no longer supersedes ${l.onto} — its capturer's capture-only pointer, cleared by this accept`);
          }
        } else {
          out(`  rejected ${id}${res.cleared ? `: the supersedes pointer this proposal had set is cleared` : ""}`);
        }
      } else {
        code = 1;
        const why: Record<string, string> = {
          NOT_FOUND: "no such proposal (or the thought it names is gone)",
          // The flags with the pointers the accept would also clear: the last
          // text read before --force (review pass 5).
          WRITER: `${writers && writers !== "no-094" ? writerFlagsText(res.flags ?? [], writers.sides) : (res.flags ?? []).map(standingFlagText).join("; ")}. ${writers && writers !== "no-094" ? `newer ${proposalWriterLine(writers.newer)}; older ${proposalWriterLine(writers.older)}. ` : ""}Read both with --list ${writers && writers !== "no-094" ? writers.status : "pending"} and pass --force if that side should stand${writers && writers !== "no-094" && writers.edited ? " (--force also accepts over a text edited since judged)" : ""}${writers && writers !== "no-094" && writers.status === "rejected" ? "; left as it is, it stays rejected" : `, or --reject ${id}`}`,
          LINEAGE_PAIR: `one side's derived_from names the other — a derivation and its input, a pair the pass never proposes since 066; accepting archives the input while the derivation still names it. ${writers && writers !== "no-094" && writers.status === "rejected" ? "Left as it is, it stays rejected, the expected decision" : `${rejectLineage(id)} is the expected decision`}; pass --force (with --direction on an undirected verdict) if the pointer is what you mean${writers && writers !== "no-094" && writers.flags.length ? ` — it also accepts over its WRITER flag: ${writers.flags.map(standingFlagText).join("; ")}` : ""}`,
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
    if (LIST === "relations") {
      if (!(await has084())) {
        err("  --list relations needs migration 084 (db/migrations/084_judged_relations.sql), which this brain has not applied: cd db && bun migrate.ts --url <url>");
        code = 1;
      } else await printRelations();
    } else if (LIST !== undefined) {
      // 070 (SMD-2313), 109 (SMD-3248), then 110 (SMD-3249): a brain at 109 or
      // before under this tree has no seven-argument listing — the one error every --list
      // meets there, named with its file rather than a driver stack
      // (definitions probe, SMD-2313's second review pass).
      try { await printList(LIST === "all" ? undefined : LIST); } catch (e) {
        if (!/list_supersession_proposals\(text, ?integer, ?boolean, ?text, ?numeric, ?timestamp with time zone, ?uuid\) does not exist/.test((e as Error).message)) throw e;
        err("  --list needs migration 110 (db/migrations/110_listing_pages.sql), which this brain has not applied: cd db && bun migrate.ts --url <url>");
        code = 1;
      }
    }
    if (STALE_DAYS > 0) await printStale(STALE_DAYS);
    return code;
  }

  // ── Judged relations (084, SMD-1873 PR 2) ────────────────────────────────────

  /** Whether this brain stores judged relations: migration 084's write. */
  async function has084(): Promise<boolean> {
    const [r] = (await sql`SELECT to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)') IS NOT NULL AS h`) as { h: boolean }[];
    return r.h === true;
  }

  /**
   * --list relations: the relations standing, newest first, with both
   * thoughts. An edge whose lineage fingerprint is no longer a side's text
   * was judged on a text that has since moved — said beside it (SMD-2726
   * closes such an edge through rebuild_derived; until then the next judging
   * of the pair replaces or closes it).
   */
  async function printRelations(limit = 50): Promise<number> {
    const rows = (await sql`
      SELECT f.id, f.payload->>'relation' AS relation, (f.payload->>'confidence')::float AS confidence, f.payload->>'judge_key' AS judge_key, f.created_at,
             n.id::text AS newer_id, n.content AS newer_content, n.created_at AS newer_created_at,
             o.id::text AS older_id, o.content AS older_content, o.created_at AS older_created_at,
             (d.id IS NOT NULL AND (content_fingerprint_of(o.content) IS DISTINCT FROM d.input_fingerprints[1]
                                    OR content_fingerprint_of(n.content) IS DISTINCT FROM d.input_fingerprints[2])) AS edited,
             -- A superseded side leaves the candidate rule, so the pass never judges the pair again (review pass 3).
             EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = o.id) AS older_superseded,
             EXISTS (SELECT 1 FROM thoughts s WHERE s.supersedes = n.id) AS newer_superseded
        FROM thought_facets f
        JOIN thoughts n ON n.id = f.thought_id
        JOIN thoughts o ON o.id = (f.payload->>'target')::uuid
        LEFT JOIN derivations d ON d.artifact_kind = 'relation' AND d.artifact_id = f.id AND d.produced_by = f.payload->>'judge_key'
       -- A distinct (102) is a pair judged apart, not a relation to review: --status counts it (SMD-3117).
       WHERE f.kind = 'relation' AND f.valid_until IS NULL AND f.payload->>'relation' IS DISTINCT FROM 'distinct'
         -- --key (SMD-3248): one pass's relations alone, by the key its facet names.
         AND (${KEY ?? null}::text IS NULL OR f.payload->>'judge_key' = ${KEY ?? null}::text)
       ORDER BY f.created_at DESC, f.id
       LIMIT ${limit}`) as {
        id: string; relation: string; confidence: number | null; judge_key: string; created_at: Stamp;
        newer_id: string; newer_content: string; newer_created_at: Stamp; older_id: string; older_content: string; older_created_at: Stamp; edited: boolean;
        older_superseded: boolean; newer_superseded: boolean }[];
    if (rows.length === 0) {
      out(`  no relations${KEY === undefined ? "" : ` judged by ${KEY}`}`);
      return 0;
    }
    const phrase: Record<string, string> = { related: "related", evolves: "the NEWER evolves from the older", duplicate: "duplicates" };
    out(`  ${rows.length} relation(s)${KEY === undefined ? "" : ` judged by ${KEY}`}, newest first${rows.length === limit ? ` — the first ${limit}; ${KEY === undefined ? "--status counts them all" : "the rest are not listed"}` : ""}:\n`);
    rows.forEach((r, i) => {
      const marks = [r.edited && "EDITED SINCE JUDGED", r.older_superseded && "OLDER SUPERSEDED", r.newer_superseded && "NEWER SUPERSEDED", r.judge_key !== JOB && KEY === undefined && "ANOTHER JUDGE KEY"].filter(Boolean);
      out(`  ${i + 1}. [${r.confidence === null ? "—" : Number(r.confidence).toFixed(2)}] ${phrase[r.relation] ?? r.relation}${marks.length ? `  ${marks.join("  ")}` : ""}`);
      out(`     newer [${day(r.newer_created_at)}] ${snippet(r.newer_content)}\n        ID: ${r.newer_id}`);
      out(`     older [${day(r.older_created_at)}] ${snippet(r.older_content)}\n        ID: ${r.older_id}`);
      out(`     relation ${r.id}  judged by ${judgeKeyText(r.judge_key)} on ${day(r.created_at)}\n`);
    });
    return rows.length;
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
    // row when it proposes the pair again, and SETTLES it — a rejection with
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
             -- The count above is this file's own SQL and reads on a brain at 068; the listing it points at is 110's (109's, 070's
             -- before SMD-3249), so its absence is said here rather than one command later (operator walkthrough, SMD-2313's fourth review pass).
             to_regprocedure('list_supersession_proposals(text, int, boolean, text, numeric, timestamptz, uuid)') IS NOT NULL AS has_110
      FROM supersession_proposals`;
    const stale = await readStaleStandings();
    // SMD-3248: the pending queue by the pass that judged it — the keys --list --key takes, most first. A reviewer grading
    // one pass (SMD-3115's per-decide-version precision) learns which passes the total holds without reading a listing.
    const byPass = (await sql`
      SELECT judge_key, count(*)::int AS n FROM supersession_proposals WHERE status = 'pending' GROUP BY judge_key ORDER BY n DESC, judge_key`) as { judge_key: string; n: number }[];
    out(`  queue: ${q.pending} pending (${q.undirected} without a direction), ${q.accepted} accepted, ${q.rejected} rejected${q.settled ? ` (${q.settled} by the pass)` : ""}${stale.total ? `, ${staleClause(stale)}` : ""}${q.lineage ? `, ${lineageClause(q.lineage, q.has_110)}` : ""} — --list shows them; --accept / --reject decides one`);
    if (byPass.length) out(pendingByPassLine(byPass));
    // 084 (SMD-1873 PR 2): the relations the pass judged, standing.
    if (await has084()) {
      const [r] = (await sql`
        SELECT count(*) FILTER (WHERE f.payload->>'relation' = 'related')::int AS related,
               count(*) FILTER (WHERE f.payload->>'relation' = 'evolves')::int AS evolves,
               count(*) FILTER (WHERE f.payload->>'relation' = 'duplicate')::int AS duplicate,
               -- 102 (SMD-3117): a pair judged apart, counted on its own; the clauses after it are about the three.
               count(*) FILTER (WHERE f.payload->>'relation' = 'distinct')::int AS distinct_pairs,
               count(*) FILTER (WHERE f.payload->>'relation' IS DISTINCT FROM 'distinct' AND f.payload->>'judge_key' IS DISTINCT FROM ${JOB})::int AS other_key,
               -- --list relations' EDITED SINCE JUDGED, counted, over the listing's joins (review pass 4).
               count(*) FILTER (WHERE f.payload->>'relation' IS DISTINCT FROM 'distinct'
                                  AND d.id IS NOT NULL AND (content_fingerprint_of(o.content) IS DISTINCT FROM d.input_fingerprints[1]
                                                            OR content_fingerprint_of(n.content) IS DISTINCT FROM d.input_fingerprints[2]))::int AS edited
          FROM thought_facets f
          JOIN thoughts n ON n.id = f.thought_id
          JOIN thoughts o ON o.id = (f.payload->>'target')::uuid
          LEFT JOIN derivations d ON d.artifact_kind = 'relation' AND d.artifact_id = f.id AND d.produced_by = f.payload->>'judge_key'
         WHERE f.kind = 'relation' AND f.valid_until IS NULL`) as { related: number; evolves: number; duplicate: number; distinct_pairs: number; other_key: number; edited: number }[];
      // A pair this key no longer reaches keeps the relation another key judged (review pass 3).
      out(`  relations: ${r.related + r.evolves + r.duplicate} standing (${r.related} related, ${r.evolves} evolves, ${r.duplicate} duplicate${r.other_key ? `; ${r.other_key} judged under another key, which this pass replaces only for the pairs it judges again` : ""}${r.edited ? `; ${r.edited} on a text edited since judged` : ""}) — --list relations shows them` +
        (r.distinct_pairs ? `; ${r.distinct_pairs} pair(s) judged distinct — near neighbours the judge called unrelated, kept apart (102)` : ""));
      // 102 (SMD-3117): a brain short of it stores no distinct, which the next run says at its start; --status says it too (review pass 1).
      // Not in a run's own summary: the run says it at its start, and its relations line counts what it lost (review pass 2).
      if (!HAS_102 && (STATUS_ONLY || DRY_RUN)) out(`  distinct: not stored — ${NO_102}`);
      // A thought this key judged before 084 was applied has no relations, and
      // nothing re-judges it on its own: said here, with the statement that
      // puts exactly those back in the pool (review pass 4). The ledger is
      // the owner's; a role that cannot read it is not told.
      const before = (await sql`
        SELECT count(*)::int AS n, min(m.applied_at) AS at
          FROM thought_work_claims c, (SELECT applied_at FROM schema_migrations WHERE name LIKE '084%' ORDER BY applied_at LIMIT 1) m
         WHERE c.work_type = ${JOB} AND c.status = 'succeeded' AND c.finished_at < m.applied_at`.catch(() => [])) as { n: number; at: Date | null }[];
      if (before[0]?.n && before[0].at) {
        out(`  relations: ${before[0].n} thought(s) judged under this key before 084 was applied have none — to judge them again: ` +
          `DELETE FROM thought_work_claims WHERE work_type = '${JOB.replaceAll("'", "''")}' AND status = 'succeeded' AND finished_at < '${new Date(before[0].at).toISOString()}'`);
      }
    } else {
      out("  relations: not stored — this brain lacks migration 084, so related, evolves, duplicate and unrelated verdicts are counted only (cd db && bun migrate.ts --url <owner's url>)");
    }
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

  /**
   * 079 (SMD-2448): the candidate rule leaves out pairs of two tickets
   * Linear links — where the body carries 079's sentinel, not merely where its
   * count stands: 063 or 066 re-applied by hand over 079 keeps the count and
   * puts back a body that judges such pairs (preflight warns of that state).
   * What is reported is judge calls fewer: per thought, the --k cut over
   * 066's list less the cut over 079's — least(k, kept + left out) − kept,
   * kept already cut at k. A lower bound: a stale proposal beyond the cut,
   * which 067 has the pass judge anyway, cost a call under 066 and is settled
   * without one under 079 — not counted (rare: it needs a stale row on two
   * linked tickets past the k nearest). The run reports it as well as
   * --status and --dry-run because the ticket asked that a run say how many
   * pairs it skipped (SMD-2448's second Work item).
   */
  const has079 = await atStart(async () => ((await sql`
    SELECT COALESCE((SELECT prosrc LIKE '%ob1:linked-tickets-not-paired%' FROM pg_proc WHERE oid = to_regprocedure('consolidation_candidates(uuid, int, float)')), false)
           AND to_regprocedure('consolidation_linked_ticket_pairs_left_out(uuid, float)') IS NOT NULL AS has_079`) as { has_079: boolean }[])[0].has_079);
  if (has079 === null) return stoppedWaiting();
  const HAS_079 = has079;
  /**
   * 102 (SMD-3117): whether record_thought_relation takes distinct. 084's door
   * refuses the word, so a pass that sent it to a brain short of 102 would
   * fail every thought with an unrelated pair at the floor. Without it an
   * unrelated verdict at the floor closes the pair's edge, as before 102 —
   * unless that edge is a distinct, which stands (review pass 2) — the run
   * says so at its start, and the summary counts what was not stored. 102
   * keeps 084's signature, so its sentinel in the door's body is read (the
   * 014 convention): at start, again on every poll of a follower, as
   * relationsOff is (review pass 1: a follower started at 099 never stored a
   * distinct once 102 was applied), when the door refuses the word mid-pass
   * (084 re-applied by hand under a running pass), before a distinct is given
   * up, and for the summary's remedy (review pass 3: a one-shot run read it
   * only at its start).
   */
  const readHas102 = async (): Promise<boolean> => ((await sql`
    SELECT COALESCE((SELECT prosrc LIKE '%ob1:relation-distinct%' FROM pg_proc
                      WHERE oid = to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)')), false) AS has_102`) as { has_102: boolean }[])[0].has_102;
  const has102 = await atStart(readHas102);
  if (has102 === null) return stoppedWaiting();
  let HAS_102 = has102;
  /** What a run short of 102 says: both remedies, as 079's does — the ledger may already record 102 under a hand re-apply of 084 (review pass 1). */
  const NO_102 = "this brain lacks migration 102: apply it (cd db && bun migrate.ts --url <owner's url>), or, where the ledger already records 102 and 084 was re-applied by hand over it, re-apply (add --reapply)";
  /**
   * 084 (SMD-1873 PR 2): whether the pass stores its related, evolves and
   * duplicate verdicts as relations — the migration applied, and this role
   * able to write them: INSERT on thought_facets is the structure group's,
   * UPDATE on it and on thoughts (the row locks) and the derivations writes
   * the capture group's. Without either, the verdicts are counted and the run
   * says why, rather than failing every thought on a permission error.
   */
  async function relationsOff(): Promise<string | null> {
    if (!(await has084())) return "this brain lacks migration 084 (cd db && bun migrate.ts --url <owner's url>)";
    // ob1_record_derivation upserts (INSERT … ON CONFLICT DO UPDATE … RETURNING),
    // so derivations needs all three (review pass 3). An UPDATE granted on a
    // column is enough for the row locks and the close, so the UPDATE terms
    // read any column (review pass 4: a column grant read as none).
    const [g] = (await sql`
      SELECT current_user AS role, has_table_privilege('thought_facets', 'INSERT') AS fi, has_any_column_privilege('thought_facets', 'UPDATE') AS fu,
             has_any_column_privilege('thoughts', 'UPDATE') AS tu, has_table_privilege('derivations', 'INSERT') AS di,
             has_any_column_privilege('derivations', 'UPDATE') AS du, has_table_privilege('derivations', 'SELECT') AS ds`) as ({ role: string } & Record<string, boolean>)[];
    // Each group named for what this role lacks of it, and only that (review pass 4).
    const lackOn = (table: string, privs: [string, boolean][]) => {
      const lacked = privs.filter(([, has]) => !has).map(([p]) => p);
      return lacked.length ? `${lacked.length > 1 ? `${lacked.slice(0, -1).join(", ")} and ${lacked.at(-1)}` : lacked[0]} on ${table}` : "";
    };
    const structure = !g.fi;
    const captureLacks = [lackOn("thought_facets", [["UPDATE", g.fu]]), lackOn("thoughts", [["UPDATE", g.tu]]), lackOn("derivations", [["INSERT", g.di], ["UPDATE", g.du], ["SELECT", g.ds]])].filter(Boolean);
    const capture = captureLacks.length > 0;
    if (!structure && !capture) return null;
    const what = [structure && "INSERT on thought_facets (the structure group)", capture && `${captureLacks.join(", ")} (the capture group)`].filter(Boolean).join(" and ");
    const groups = [capture && "capture", structure && "structure"].filter(Boolean).join(",");
    return `this role lacks ${what} — cd db && bun migrate.ts --url <owner's url> --grant ${g.role} --groups ${groups}${structure ? " (the structure group also writes source rows, links and citations: Postgres grants INSERT on thought_facets per table)" : ""}`;
  }
  // Whether 084's door exists rides the same start read, which waits out an outage (SMD-2752; review pass 4).
  const relations = await atStart(async () => {
    const off = await relationsOff();
    return { off, door: off === null || (await has084()) };
  });
  if (relations === null) return stoppedWaiting();
  let RELATIONS_OFF: string | null = relations.off;
  /** Whether relations were stored at any point of this run — the summary's counts are then real, beside what was counted only (review pass 4). */
  let RELATIONS_EVER_ON = RELATIONS_OFF === null;
  /**
   * What the run has said about what it stores: relations (084 and this
   * role's grants) and, with them, distinct (102). The start says each part
   * that is missing; storesNow takes both parts as a poll or a refusal finds
   * them, and says the change from what was last said, whichever worker or
   * poll sees it first. Distinct's line is said only while relations are
   * stored — including as they come back, when it differs from the last one
   * said — so a poll that sees both parts move says where they ended (review
   * pass 3: two functions, each saying its own part, read each other's stale
   * state, printing a false "distinct: stored" and leaving a stale "not stored").
   * While relations are off nothing is stored, so a change in distinct waits
   * for them: the start's "not stored either" stands until relations come
   * back, and is corrected then if 102 landed meanwhile (review pass 4).
   */
  let saidOff = RELATIONS_OFF;
  // The start says distinct is missing unless the door is too: without 084 relations' note names it, and 102 needs 084 first.
  let saidMissing = !HAS_102 && relations.door;
  function storesNow(off: string | null, has: boolean, when: string): void {
    RELATIONS_OFF = off;
    HAS_102 = has;
    if (off === null) RELATIONS_EVER_ON = true;
    if (off !== saidOff) {
      out(off === null ? `  relations: stored ${when}` : `  relations: not stored ${when} — ${off}`);
      saidOff = off;
    }
    if (off === null && saidMissing === has) {
      out(has ? `  distinct: stored ${when}` : `  distinct: not stored ${when} — ${NO_102}`);
      saidMissing = !has;
    }
  }
  /** The judge calls 079 saves over a set of thoughts (`ids` selects one `id` column; $1 is its parameter), and the set's size. */
  async function ticketCallsSaved(ids: string, param: string): Promise<{ n: number; t: number }> {
    const [r] = (await sql.unsafe(`
      SELECT coalesce(sum(least($2::int, k.n + consolidation_linked_ticket_pairs_left_out(s.id, $3::float)) - k.n), 0)::int AS n, count(*)::int AS t
        FROM (${ids}) s CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM consolidation_candidates(s.id, $2::int, $3::float)) k`, [param, K, MIN_SIM])) as { n: number; t: number }[];
    return { n: Number(r.n), t: Number(r.t) };
  }
  /** 079's predicate on two thoughts by id — the reason a stale proposal no longer meets the candidate rule. */
  async function linkedTickets(olderId: string, newerId: string): Promise<boolean> {
    const [r] = (await sql`SELECT consolidation_tickets_linked(o.metadata, n.metadata) AS l FROM thoughts o, thoughts n WHERE o.id = ${olderId}::uuid AND n.id = ${newerId}::uuid`) as { l: boolean }[];
    return r?.l === true;
  }
  /** --status and --dry-run: over the thoughts the next run judges — pending, not yet pooled, re-pooled for a stale proposal, and failed under --retry-failed. */
  async function printTicketCalls(): Promise<void> {
    if (!HAS_079) {
      out("  tickets: pairs of two tickets Linear links are still judged — consolidation_candidates is from before migration 079: apply it (cd db && bun migrate.ts --url <url>), or, where the ledger already records 079 and 063 or 066 was re-applied by hand over it, re-apply (add --reapply)");
      return;
    }
    const { n, t } = await ticketCallsSaved(
      `SELECT thought_id AS id FROM thought_work_claims WHERE work_type = $1 AND status IN ('pending'${RETRY_FAILED ? ", 'failed'" : ""})
       UNION SELECT consolidation_pool($1) UNION SELECT id FROM (${STALE_REPOOL_SQL}) r`, JOB);
    out(`  tickets: ${n} judge call(s) fewer over the ${t} thought(s) still to judge${DRY_RUN && LIMIT ? " (before --limit)" : ""} — pairs of two tickets Linear links left out at --k ${K} (079)`);
  }

  // The check ends here, before the pass's first write — --retry-failed's,
  // the pool's; the key's lookup wrote, as at every start — and without waiting for a provider that does not answer: each
  // pass waits for it at its own start (SMD-2752).
  if (CHECK) {
    // The relations note at the start too; each pass says it again whatever its banner, since grants or 084 may change between sleeps (review pass 1).
    if (RELATIONS_OFF) say(`  relations: not stored — ${RELATIONS_OFF}; a pass stores no relations then, counting its related, evolves, duplicate and unrelated verdicts only`);
    // Each missing part, so fixing the role does not reveal the migration only then (review pass 3).
    if (saidMissing) say(RELATIONS_OFF ? `  distinct: not stored either — ${NO_102}` : `  distinct: not stored — ${NO_102}; a pass closes the edge of a pair it calls unrelated at the floor then, as before 102, unless that edge is a distinct`);
    if (startOut !== null) err(`  the provider is not answering at start (${startOut.slice(0, 200)}) — each pass waits for it at its own start`);
    opts.onStart?.({ ok: true, provider: startOut === null ? "up" : "out" });
    return 0;
  }

  if (STATUS_ONLY || DRY_RUN) {
    const c = await counts();
    printCounts(c, STATUS_ONLY ? "status" : "before");
    if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) out(describeHolder(h));
    await printQueue();
    // 084 present but this role cannot write relations: say so before a run drops them (review pass 3).
    if (RELATIONS_OFF && (await has084())) out(`  relations: a run under this role would store none — ${RELATIONS_OFF}`);
    if (c.thoughts > 0) await printTicketCalls();
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
          `add ${c.unpooled} thoughts to the pool${restale ? ` and re-pool ${restale} for stale proposals` : ""}; judge ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) against up to ${K} older neighbour(s) each with ${jev ? `${cfg.decider} through the tier, ${cfg.judgeModel} writing the proposals it calls at >= ${MIN_CONFIDENCE},` : cfg.judgeModel} ` +
          `and ${WORKERS} worker(s), ${TTL} s leases renewed every ${HEARTBEAT} s. Nothing was written.`
      );
    }
    return 0;
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  if (startOut !== null) {
    // Before the CLI installs its handlers a signal ends the process; a caller's signal ends the wait.
    const wake = opts.signal ?? new AbortController().signal;
    const down = Date.now();
    err(`  the provider is not answering at start (${startOut.slice(0, 200)}) — the follower claims nothing until it does; it calls ${cfg.judgeModel} at ${cfg.chat.base} for one token after ${OUTAGE_MS.first / 1000} s and then twice as long each time, up to ${OUTAGE_MS.max / 60_000} min`);
    // Said through a caller's stamper while it lasts — the sleep scheduler's,
    // so heartbeat:sleep and preflight's row say a pass waits at its start for
    // the provider, not that its passes run (SMD-2752).
    await opts.stamper?.startWait?.(true);
    const answered = await probeUntil(() => probe(undefined, wake), wake, (p) => p.state !== "out").finally(() => opts.stamper?.startWait?.(false));
    if (answered) {
      const refusal = startRefusal(answered);
      if (refusal) return refused(probeRefusal(answered), refusal);
      out(`  the provider answers after ${Math.round((Date.now() - down) / 1000)} s`);
    }
  }
  if (stoppedEarly()) return 130;
  if (RETRY_FAILED) {
    // An operator's flag, never the scheduler's: not under the start's wait,
    // since a count committed and then lost with its connection would be
    // retried into a false 0 (review pass 1).
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
   * Aborted by the first stop and by the hard stop: a follower's sleep and a
   * transient pause wake on the first (SMD-2401), the judge's call in hand on
   * the hard, so none holds run() nor sends a pair again on a stopping pass
   * (db/lease.ts's sleepUnless keeps nothing per sleep).
   */
  const onStop = new AbortController();
  const onHardStop = new AbortController();
  /**
   * The pass's own wake, a new one for each pass: a transient pause wakes on
   * the first stop and on another worker's provider outage, which ends the
   * pass after the thought in hand (SMD-2599).
   */
  let halt = new AbortController();
  /**
   * Aborted when the pass ends for a reason of its own — the provider's
   * refusal, a worker's throw — so a worker waiting at the admit gate wakes to
   * it, as one pausing on a provider error wakes on `halt`. `gate`, the signal
   * the gate waits on, is the first stop, `halt` and this, made new with each
   * pass (SMD-3379 PR 1b-1, review pass 1).
   */
  let passEnds = new AbortController();
  let gate: AbortSignal = onStop.signal;
  let done = 0;
  let failed = 0;
  /** Workers that began or joined a provider outage — the heartbeat's "failed" (SMD-2261): the provider, not a document. */
  let providerStops = 0;
  /** Whether the last pass found nothing to do: its stamp keeps the word before it. */
  let lastPassIdle = false;
  let vanished = 0;
  let lost = 0;
  let beats = 0;
  /** Rows that went to the judge — finished or not — so the pairs-per-thought ratio divides by the rows that cost pairs. */
  let judged = 0;
  let llmMs = 0;
  const totals = { pairs: 0, unrelated: 0, related: 0, evolves: 0, duplicate: 0, outdates: 0, tokenScored: 0, statedScored: 0, relationsAdded: 0, relationsKept: 0, relationsReplaced: 0, relationsClosed: 0, relationsGone: 0, relationsUnstored: 0, distinctAdded: 0, distinctKept: 0, distinctReplaced: 0, distinctNo102: 0, distinctStands: 0, distinctUnstored: 0, proposed: 0, alreadyProposed: 0, underConfidence: 0, undirected: 0, malformed: 0, noCandidates: 0,
    // 079 (SMD-2448): the judge calls fewer than 066's list would have cost at --k, and the claims whose read failed (counted 0).
    ticketCalls: 0, ticketCallsUnread: 0,
    // Decide mode (SMD-3151): the writer's calls by what came back, and the tier's outdates under the floor it was not asked about.
    writerAsked: 0, writerStood: 0, writerDeclined: 0, writerQuotesFailed: 0, writerUnparsed: 0, gated: 0, linkAsked: 0, linkCapped: 0, linkUnparsed: 0,
    // 067: the stale rows this run met — replaced in place (proposed again),
    // settled after a judgement that proposes nothing, settled because the
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
  /** `metadata_hash`, `md5(metadata::text)`, is read for the thought a worker claims (claimAfterWait), not for an older side. */
  type Row = { id: string; content: string; created_at: string | null; fingerprint: string; metadata: Record<string, unknown> | null; has_vector: boolean; metadata_hash?: string | null };
  type Candidate = { older_id: string; similarity: number; shared_entities: number };
  type Outcome = { outcome: "succeeded" } | { outcome: "failed"; error: string } | { outcome: "vanished" }
    /** In hand at the hard stop: nothing more written, and no longer this worker's to release. */
    | { outcome: "abandoned" }
    /** Requeued or reaped while its worker waited at the admit gate: nothing more judged, and not this worker's to release (review passes 3 and 4). */
    | { outcome: "lost" }
    /** Edited while its worker waited at the admit gate, still its claim: the worker puts it back in the pool for the new text, nothing more judged (review passes 4 and 5). */
    | { outcome: "moved" };
  /** 067: a stale proposal on the thought in hand (its newer side), with what the leftover rule needs of the older side. */
  type StaleRow = { id: string; older_id: string; older_fingerprint: string; older_vectorless: boolean; newer_vectorless: boolean; similarity: number | null; shared: number; superseded: boolean; lineage_pair: boolean };

  /**
   * A Writer's throw from inside processRow, marked so the worker's catch
   * rethrows it — the Writer's error rejects run() — rather than classifying
   * it as the thought's failure and recording it on the claim (review pass 1:
   * a throw on the "not settled" line became last_error = "writer boom").
   */
  class WriterThrow {
    constructor(readonly error: unknown) {}
  }
  /**
   * A stop that reached a worker waiting at the admit gate between a thought's
   * pairs (SMD-3379 PR 1b): the thought goes back to the pool unrecorded, as a
   * provider outage sends it, its proposals written so far standing.
   */
  class StoppedBetweenPairs extends Error {
    constructor() {
      super("stopped between pairs at the admit gate: the thought goes back to the pool unrecorded");
      this.name = "StoppedBetweenPairs";
    }
  }
  const errInRow = (line: string): void => {
    try {
      err(line);
    } catch (e) {
      throw new WriterThrow(e);
    }
  };

  /**
   * 067: the pass settles a stale row — rejected with the marker note, its
   * lineage re-recorded at the texts judged under this key — through
   * settle_supersession_proposal. NOT_STALE and NOT_FOUND are facts about the
   * row (a reviewer decided it, another pass replaced it, its thought is gone
   * between the read and this write), counted and not failed.
   */
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

  async function processRow(row: Row, workerId: string): Promise<Outcome> {
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
    for (const [at, c] of candidates.entries()) {
      if (hardStopped) return { outcome: "abandoned" };
      // The admit gate before each pair (SMD-3379 PR 1b): the worker waits
      // here, its claim and lease kept.
      if (ADMIT) {
        let through: false | "open" | "waited";
        try {
          through = await admitted(ADMIT, gate);
        } catch (e) {
          throw new AdmitThrow(e);
        }
        if (!through) throw new StoppedBetweenPairs();
        // After the gate held it both sides are read again: the live write
        // that closed the gate may be a delete or an edit of the thought or of
        // any older side still to judge, whose text must not go to the judge
        // after it (review passes 3 and 4). A read that fails goes on, as before.
        if (through === "waited") {
          const claim = await claimAfterWait(sql, JOB, workerId, row.id, row.fingerprint, false, row.metadata_hash ?? null).catch(() => "ours" as const);
          if (claim === "deleted") return { outcome: "vanished" };
          if (claim === "lost" || claim === "requeued") return { outcome: "lost" };
          // Still ours, its text moved (063 requeues a judged thought only
          // through its proposals) or its metadata, which the egress gate reads
          // (review pass 6): the worker puts it back in the pool.
          if (claim === "moved") return { outcome: "moved" };
          const rest = candidates.slice(at).map((x) => x.older_id);
          const fresh = (await sql`
            SELECT id, content, created_at, content_fingerprint_of(content) AS fingerprint, metadata, (embedding IS NOT NULL) AS has_vector FROM thoughts
            WHERE id = ANY(${sql.array(rest, "TEXT")}::uuid[])`.catch(() => null)) as Row[] | null;
          if (fresh !== null) {
            const now = new Map(fresh.map((o) => [o.id, o]));
            for (const id of rest) {
              const o = now.get(id);
              if (o) byId.set(id, o);
              else byId.delete(id);
            }
          }
        }
      }
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
        const olderSide = { content: older.content, createdAt: older.created_at, metadata: older.metadata ?? undefined, writer: actorKindOf(older.metadata) };
        const newerSide = { content: row.content, createdAt: row.created_at, metadata: row.metadata ?? undefined, writer: actorKindOf(row.metadata) };
        const callSignal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_S * 1000), onHardStop.signal]);
        // Decide mode (SMD-3115): the tier's verdict, the judge's model writing only a proposal it calls at this
        // pass's floor, which it would record (SMD-3151), after the link step that may cap the pair (SMD-3203); one
        // deadline for all three calls, as for the judge's one.
        j = jev ? await decidePair(olderSide, newerSide, cfg, jev, MIN_CONFIDENCE, callSignal, keyName)
                : await judgePair(olderSide, newerSide, cfg, callSignal, keyName, { logprobs: JUDGE_LOGPROBS });
      } catch (e) {
        llmMs += Date.now() - t0;
        // The hard stop aborted the call: the thought is abandoned, not failed.
        if (hardStopped) return { outcome: "abandoned" };
        // A timeout is a fact about this pair (the longest thoughts); anything
        // else is the provider's and is classified by the caller.
        if (timedOut(e)) {
          // Under --follow, a timeout the probe gets no answer past either is
          // the provider hung, not this pair (SMD-2599): the thought goes back
          // to the pool unrecorded, its proposals written so far standing.
          if (FOLLOW && !stopping && (outage.reason !== null || isOut(await probe(TIMEOUT_S * 1000, halt.signal)))) throw new ProviderDown(`the judge call timed out after ${TIMEOUT_S} s, and a one-token call got no answer either`);
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
        problems.push(`pair with ${c.older_id}: ${j.unknownVerdict !== undefined ? `the model answered the verdict "${j.unknownVerdict}", not one of prompt ${CONSOLIDATE_PROMPT_VERSION}'s five (${VERDICTS.join(", ")}) — a model keeping to an older prompt's words` : "the model's answer was not JSON of the expected shape"}${staleRow ? " (its stale proposal stands)" : ""}`);
        continue;
      }
      totals[j.verdict]++;
      const verdict = proposalVerdict(j);
      // Decide version 3 (SMD-3151): the tier's outdates under the floor asked no writer. It is an outdates under the
      // floor here, as a standing proposal under it was, though the pair takes the relation H2O's distribution gives at
      // the floor, else its edge is closed, as a quote that fails does.
      const gated = j.decide?.floor !== undefined;
      // A proposing verdict: the writer's standing outdates, or the tier's outdates the gate left.
      const proposing = verdict !== null || gated;
      // Decide version 4 (SMD-3203): the writer's link step, when it was asked, and whether it capped the pair.
      const link = j.decide?.link as DecideNote["link"];
      const cappedBy = link?.capped ? `, capped by the writer's link step (${link.link === "unparsed" ? "no link read" : `an ${link.link} link`}, SMD-3203)` : "";
      if (j.decide) {
        const writer = j.decide.writer as DecideNote["writer"];
        if (gated) totals.gated++;
        else if (writer) {
          totals.writerAsked++;
          if (j.verdict === "outdates") totals.writerStood++;
          else if (writer.current === "none") totals.writerDeclined++;
          else if (writer.current === "unparsed") totals.writerUnparsed++;
          else totals.writerQuotesFailed++;
        }
        if (link) {
          totals.linkAsked++;
          if (link.capped) totals.linkCapped++;
          if (link.link === "unparsed") totals.linkUnparsed++;
        }
      }
      // SMD-1873: the token probability of a proposing verdict when the
      // endpoint returned one, else the number the model wrote.
      const scored = proposalConfidence(j);
      if (proposing) totals[scored.source === "token" ? "tokenScored" : "statedScored"]++;
      let proposalId: string | null = null;
      let recorded: "proposed" | "under-confidence" | "already" | "replaced" | "settled" | null = null;
      if (verdict === null || scored.confidence < MIN_CONFIDENCE) {
        if (proposing) {
          totals.underConfidence++;
          recorded = "under-confidence";
        }
        // 067: nothing proposed at the floor on a pair whose proposal is stale — the
        // pass settles it, at the fingerprints the judge was sent.
        // (The older's fingerprint from the read the judge was sent, not the
        // stale read before the candidates — a move between the two would
        // record a text the judge did not see; first review pass, cold read.)
        if (staleRow && await settleStale(staleRow, !proposing ? `judged again after a text moved — ${j.verdict}${cappedBy}` : `judged again after a text moved — ${gated ? "outdates" : j.verdict} at confidence ${scored.confidence.toFixed(2)} (${scored.source === "token" ? "token probability" : "the number the model wrote"}), under the floor ${MIN_CONFIDENCE}${gated ? ", the writer not asked" : ""}${cappedBy}`, older.fingerprint, row.fingerprint, proposing ? "under-confidence" : j.verdict)) {
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
                                              ${scored.confidence}::numeric, ${j.reason || null}::text, ${c.similarity}::float,
                                              ${JOB}::text, ${agentId}::uuid, ${older.fingerprint}::text, ${row.fingerprint}::text,
                                              ${proposalRecipe(cfg, { similarity: c.similarity, candidates: K, minSimilarity: MIN_SIM }, judgedRecipe(j, scored.source))}::jsonb) AS id`;
        proposalId = (id as string | null) ?? null;
        // 067: the same id back on a stale pair is 063's replacement in place.
        if (proposalId && staleRow && proposalId === staleRow.id) { staleMet.replaced.add(staleRow.id); recorded = "replaced"; if (verdict === "conflict_undirected") totals.undirected++; }
        else if (proposalId) { totals.proposed++; recorded = "proposed"; if (verdict === "conflict_undirected") totals.undirected++; }
        else { totals.alreadyProposed++; recorded = "already"; }
      }
      // 084 (SMD-1873 PR 2): a related, evolves or duplicate verdict at the
      // floor is a relation on the newer thought, at the fingerprints the
      // judge was sent, and since 102 an unrelated one is a distinct
      // (SMD-3117); any other answer closes the pair's relation, so a
      // re-judge that no longer sees one retracts it. Nothing when the pair
      // has none and none is due — record_thought_relation answers "none".
      let relation: string | null = null;
      const rv = relationVerdict(j);
      if (RELATIONS_OFF === null) {
        const rs = relationConfidence(j);
        // The floor on the mass of the three relation words (a distinct's on its own probability); the word's own probability is what the relation stores.
        const due = rv !== null && rs.mass >= MIN_CONFIDENCE ? rv : null;
        // A brain short of 102 refuses distinct: there the verdict closes the edge, as it did before 102, and is counted.
        // The sentinel is read again before a distinct is given up, so 102 applied under a running pass — a
        // one-shot run reads it nowhere else — is taken at the first pair that would lose one (review pass 3).
        if (due === "distinct" && !HAS_102 && (await readHas102().catch(() => false))) storesNow(RELATIONS_OFF, true, "from this pair on");
        let write = due === "distinct" && !HAS_102 ? null : due;
        let apartLost = due === "distinct" && write === null;
        const writeRelation = async (w: string | null) => ((await sql`
            SELECT record_thought_relation(${row.id}::uuid, ${c.older_id}::uuid, ${w}::text, ${w === null ? null : rs.confidence}::numeric,
                                           ${JOB}::text, ${agentId}::uuid, ${older.fingerprint}::text, ${row.fingerprint}::text,
                                           ${proposalRecipe(cfg, { similarity: c.similarity, candidates: K, minSimilarity: MIN_SIM }, judgedRecipe(j, rs.source))}::jsonb) AS r`) as { r: { action: string } }[])[0].r;
        // …unless the edge standing is a distinct, which the verdict agrees
        // with: a brain that had 102 and lost the word to a hand re-apply of
        // 084 keeps it, since the claim ends succeeded and re-applying 102
        // would not bring a closed one back (review pass 2). The sentinel was
        // just read (above, or by the refusal below): a door that refuses
        // distinct writes none, so none appears between this read and the
        // close unless 102 lands in that instant.
        const closeUnlessApart = async () => ((await sql`
            SELECT EXISTS (SELECT 1 FROM thought_facets
                            WHERE thought_id = ${row.id}::uuid AND kind = 'relation' AND valid_until IS NULL
                              AND payload->>'target' = ${c.older_id}::uuid::text AND payload->>'relation' = 'distinct') AS apart`) as { apart: boolean }[])[0].apart
          ? { action: "none", apartStands: true } : await writeRelation(null);
        let r: { action: string; gone?: boolean; unstored?: boolean; apartStands?: boolean };
        try {
          try {
            r = apartLost ? await closeUnlessApart() : await writeRelation(write);
          } catch (e) {
            // 084's door under a running pass (084 re-applied by hand since the
            // sentinel was read): it refuses distinct by name. Read the sentinel
            // again; where it is gone, distinct stops here and the pair's edge is
            // closed, as before 102 — not a failed thought (review pass 1).
            const code = (e as { code?: string; errno?: string }).errno ?? (e as { code?: string }).code;
            if (!(write === "distinct" && code === "22023" && /relation must be related, evolves, duplicate or NULL/.test((e as Error).message))) throw e;
            if (await readHas102().catch(() => true)) throw e;
            storesNow(RELATIONS_OFF, false, "from this pair on");
            write = null;
            apartLost = true;
            r = await closeUnlessApart();
          }
        } catch (e) {
          // A side deleted between the judgement and this write (the target
          // check, or the foreign key) is that pair's, not the thought's: the
          // write answers nothing and the rest of the thought's pairs go on
          // (review pass 1: a racing delete failed the newer thought).
          // Only a side gone — the target check's message, or the foreign key;
          // any other refusal is a defect to see, not a pair to skip (review pass 2).
          const code = (e as { code?: string; errno?: string }).errno ?? (e as { code?: string }).code;
          if (code === "42501") {
            // A grant revoked while the pass runs: relations stop here, as
            // the next poll would say, rather than every later thought
            // failing on the write (review pass 4). A refusal relationsOff
            // does not explain is still the thought's.
            const off = await relationsOff().catch(() => null);
            if (off === null) throw e;
            storesNow(off, HAS_102, "from this pair on");
            r = { action: "none", unstored: true };
          } else if (code === "23503" || (code === "23514" && /is not a thought/.test((e as Error).message))) r = { action: "none", gone: true };
          else throw e;
        }
        if (r.gone) totals.relationsGone++;
        // A distinct counts apart from the three words: the summary names each (SMD-3117).
        if (r.unstored && rv !== null) totals[rv === "distinct" ? "distinctUnstored" : "relationsUnstored"]++;
        // One at the floor that a brain short of 102 could not take — not one under the floor, nor a pair a delete took (review pass 1).
        else if (apartLost && !r.gone) {
          totals.distinctNo102++;
          if (r.apartStands) totals.distinctStands++;
        }
        relation = r.action;
        // Each action counts the pair's one standing edge, and says how many of its writes were a distinct (review pass 1).
        const apart = write === "distinct" ? 1 : 0;
        if (r.action === "added") { totals.relationsAdded++; totals.distinctAdded += apart; }
        else if (r.action === "kept") { totals.relationsKept++; totals.distinctKept += apart; }
        else if (r.action === "replaced") { totals.relationsReplaced++; totals.distinctReplaced += apart; }
        else if (r.action === "closed") totals.relationsClosed++;
      } else if (rv !== null) totals[rv === "distinct" ? "distinctUnstored" : "relationsUnstored"]++;
      if (DUMP) {
        // The judge's reason and quotes are the brain's text: a file this creates is the owner's alone (SMD-3203).
        appendFileSync(DUMP, JSON.stringify({
          newer: row.id, older: c.older_id, similarity: c.similarity, shared: c.shared_entities, key: JOB,
          verdict: j.verdict, supersedes: j.supersedes, confidence: j.confidence, score: scored.confidence, score_source: scored.source, reason: j.reason, evidence: j.evidence, evidence_found: j.evidenceFound ?? null,
          proposal: proposalId, recorded, relation,
          // Decide mode: the tier's top and, when it asked no writer, the floor it was held to (SMD-3151); the writer's
          // link step's answer, when it was asked (first, before a proposal; after, on an evolves to store) and whether
          // it capped the pair (SMD-3203).
          ...(j.decide ? { top: j.decide.top ?? null, floor: j.decide.floor ?? null, link: link?.link ?? null, asked: link?.asked ?? null, capped: link?.capped ?? null } : {}),
        }) + "\n", { mode: 0o600 });
      }
    }
    // 067: the stale rows no candidate reached — pairs the candidate rule no
    // longer admits. A side without a vector is "not yet" (the reembed pool
    // writes it; the run after that re-pools this thought); the rest — no
    // shared entity, under the similarity floor, a side superseded — mean
    // nothing to propose and are settled at the current texts. A pair whose call timed
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
        // 079 (SMD-2448): read through its own predicate, only where 079 stands — the function exists nowhere else.
        : HAS_079 && await linkedTickets(s.older_id, row.id) ? "two tickets Linear links — each its own record (079's rule)"
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

  /**
   * --limit counts the thoughts this run has TAKEN — claimed and not handed
   * back unfinished — and the claims in flight, so two workers cannot each
   * take one on a limit of one. A row a worker hands back unfinished as it
   * ends (an outage, a stop) leaves `taken`, and counts again only if it is
   * claimed again; a claim that never answered took nothing; a dead worker's
   * leases are not this run's until a claim returns them (review pass 3: a
   * reserved count patched at three sites, each with its own edge).
   */
  const taken = new Set<string>();
  let claiming = 0;
  function limitReached(): boolean {
    return LIMIT > 0 && taken.size + claiming >= LIMIT;
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
      while (!stopping && outage.reason === null && !limitReached()) {
        // The admit gate before each claim (SMD-3379 PR 1b): a worker waits
        // here holding no claim, and a stop while it waits ends it.
        if (ADMIT) {
          if (!(await admitted(ADMIT, gate))) return;
          if (stopping || outage.reason !== null || limitReached()) return;
        }
        let batch: { thought_id: string; attempt: number }[];
        let byId: Map<string, Row>;
        try {
          const room = LIMIT > 0 ? LIMIT - taken.size - claiming : BATCH;
          if (room <= 0) return;
          const want = Math.min(BATCH, room);
          claiming += want;
          try {
            batch = (await sql`
              SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${want}, ${TTL})`) as { thought_id: string; attempt: number }[];
          } finally {
            claiming -= want;
          }
          // Tracked under --limit only: a follower without one runs for months (review pass 4).
          if (LIMIT > 0) for (const b of batch) taken.add(b.thought_id);
          if (batch.length === 0) return;
          const ids = batch.map((b) => b.thought_id);
          hb.claimed(ids);
          const rows = (await sql`
            SELECT id, content, created_at, content_fingerprint_of(content) AS fingerprint, metadata, (embedding IS NOT NULL) AS has_vector, md5(metadata::text) AS metadata_hash
              FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
          byId = new Map(rows.map((r) => [r.id, r]));
        } catch (e) {
          // A follower outlasts the database going away; an error no wait
          // mends — a function missing, a grant revoked — ends the run, as the
          // pass's own errors do (review pass 3); a passing one — a timeout, a
          // serialization failure — costs this worker its poll (review pass 4).
          if (FOLLOW && databasePermanent(e)) throw e;
          err(`  ${workerId}: ${(e as Error).message} — this worker stops`);
          return;
        }
        for (const b of batch) {
          if (stopping || outage.reason !== null) return;
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
            // 079: read once per claim, before the judge writes anything (a proposal it records holds its pair out of the list),
            // and added when the thought is finished — not again for a retry after a pause, nor for one the hard stop abandons.
            // A report, never the pass's: a failed read counts 0 and is said, where a throw here would stop every worker (second review pass).
            const ticketCalls = HAS_079 ? await ticketCallsSaved("SELECT $1::uuid AS id", row.id).then((r) => r.n, () => null) : 0;
            for (let attempt = 0; outcome === null; attempt++) {
              try {
                outcome = await processRow(row, workerId);
              } catch (e) {
                if (e instanceof WriterThrow) throw e.error;
                // The admit gate's own error, not the thought's: the pass ends with it.
                if (e instanceof AdmitThrow) throw e.error;
                // A stop at the gate between pairs: back to the pool with the leases the finally returns.
                if (e instanceof StoppedBetweenPairs) return;
                // The database went away under the pairs: not the thought's, so
                // nothing is recorded; the worker ends, and the follower waits
                // for the database before its next pass (SMD-2599).
                if (FOLLOW && databaseUnavailable(e)) {
                  err(`  ${workerId}: the database is not answering (${(e as Error).message}) — this worker stops, recording nothing for ${b.thought_id}`);
                  return;
                }
                const kind = classifyError(e);
                const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
                // Under --follow, the provider's state rather than the thought's
                // or the request's (SMD-2599), as extract-entities.ts reads it: a
                // transient error past the pauses, the model missing, or a pair's
                // timeout the probe got no answer past either (processRow).
                const down = FOLLOW && (
                  e instanceof ProviderDown ||
                  (kind === "transient" && attempt >= TRANSIENT_PAUSES_MS.length) ||
                  (kind === "fatal" && modelMissing(e)));
                if (down) {
                  // On a stopping pass the thought goes back to the pool, as a transient's does.
                  if (stopping) return;
                  if (outage.begin(msg, b.thought_id) === "outage") {
                    providerStops++;
                    halt.abort();
                    err(`  ${workerId}: the provider is not answering (${msg.slice(0, 160)}) — ${b.thought_id} goes back to the pool unrecorded, and the follower waits for the provider`);
                    return;
                  }
                  // Again, right after the provider answered a probe: this
                  // thought's own, recorded failed so it is visible rather than
                  // cycling through the pool for ever.
                  outcome = { outcome: "failed", error: `provider error again right after the provider answered a probe, so this thought's: ${msg}` };
                  stopAfter = true;
                } else if (kind === "thought") {
                  outcome = { outcome: "failed", error: msg };
                } else if (kind === "fatal") {
                  configError = msg;
                  stopping = true;
                  passEnds.abort();
                  err(`  ${workerId}: the provider refuses the request itself (${msg.slice(0, 160)}) — stopping every worker; nothing is marked failed`);
                  return;
                } else if (stopping || outage.reason !== null) {
                  // A transient error on a stopping pass, or one another worker's
                  // outage has halted: neither called again nor recorded failed —
                  // the thought goes back to the pool with the leases the finally
                  // returns (SMD-2401, SMD-2599).
                  return;
                } else if (attempt < TRANSIENT_PAUSES_MS.length) {
                  err(`  ${workerId}: provider unavailable (${msg.slice(0, 120)}); pausing ${TRANSIENT_PAUSES_MS[attempt] / 1000} s`);
                  // A first stop wakes the pause too, and the thought goes back
                  // the same way: main slept the pause out, called again, and
                  // recorded the thought failed "after 3 retries" after one (SMD-2401).
                  // So does another worker's outage (SMD-2599).
                  await sleepUnless(TRANSIENT_PAUSES_MS[attempt], halt.signal);
                  if (stopping || outage.reason !== null) return;
                } else {
                  outcome = { outcome: "failed", error: `provider error after ${attempt} retries: ${msg}` };
                  stopAfter = true;
                }
              }
            }
            if (hardStopped) return;
            // Not judged: another holds it, or it goes back for its new text (review pass 5).
            if (outcome.outcome !== "lost" && outcome.outcome !== "moved") {
              judged++;
              if (ticketCalls === null) totals.ticketCallsUnread++;
              else totals.ticketCalls += ticketCalls;
            }
            if (stopAfter && outcome.outcome === "failed") {
              hb.held.delete(b.thought_id);
              let recorded = false;
              try {
                const rows = (await sql`SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId}, 'failed', ${outcome.error}) AS ok`) as { ok: boolean }[];
                recorded = rows[0]?.ok === true;
              } catch (e) {
                // The database went away under the failure's record: nothing is
                // recorded, the row is this worker's again for the finally to
                // return, and it is not counted lost (review pass 3).
                if (FOLLOW && databaseUnavailable(e)) {
                  hb.held.add(b.thought_id);
                  // Not judged after all: the claim judges it again (review pass 4).
                  judged--;
                  if (ticketCalls === null) totals.ticketCallsUnread--;
                  else totals.ticketCalls -= ticketCalls;
                  err(`  ${workerId}: the database is not answering (${(e as Error).message}) — recording nothing for ${b.thought_id}; it returns to the pool when the database answers`);
                  return;
                }
                err(`  ${b.thought_id}: could not record the failure (${(e as Error).message})`);
              }
              if (recorded) {
                failed++;
                // A suspect no longer once its failure is recorded — not before,
                // so one the database kept from its record stays one (review pass 4).
                outage.settled(b.thought_id);
              }
              // The hard stop's release beat this one: the caller's own stop, not a lapse (SMD-2425).
              else if (hardStopped) return;
              else {
                // Not ours to record: the lease lapsed during the pauses, or the
                // row was returned by hand. Counted with the rows this worker lost.
                lost++;
                err(`  ${b.thought_id}: the claim was no longer this worker's at release; the failure below was not recorded`);
              }
              // Said once the record is settled, not before (review pass 4).
              err(`  ${workerId}: provider still failing — this worker stops after this thought; ${FOLLOW ? "the next poll goes on" : "re-run when it is back"}`);
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
          if (outcome.outcome === "lost") {
            lost++;
            err(`  ${b.thought_id}: no longer this worker's after it waited at the admit gate — requeued or reaped; nothing more of it was judged`);
            continue;
          }
          if (outcome.outcome === "moved") {
            // Back to the pool for its new text, out of the heartbeat's set first;
            // if that fails, the worker stops and its finally returns it (review pass 5).
            const requeued = await sql`SELECT requeue_thought_work(${JOB}, ${b.thought_id}::uuid)`.then(() => null, (re: Error) => re.message);
            if (requeued !== null) {
              hb.held.add(b.thought_id);
              err(`  ${workerId}: could not put ${b.thought_id}, edited while this worker waited at the admit gate, back in the pool (${requeued}) — this worker stops, returning it with its leases`);
              return;
            }
            lost++;
            err(`  ${b.thought_id}: edited while its worker waited at the admit gate — nothing more of it was judged; it is pending again, to be judged at its new text`);
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
            // The database went away under the release: the row is this
            // worker's again, for the finally to return and --limit to give
            // back (review pass 4).
            if (FOLLOW && databaseUnavailable(e)) hb.held.add(b.thought_id);
            err(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
            return;
          }
          if (gone) {
            vanished++;
            err(`  ${b.thought_id}: deleted while it was being judged`);
            continue;
          }
          if (!ok) {
            // The hard stop's release beat this one to the row: not a lapse to
            // report, the caller's own stop; a release that went through first
            // is counted below as any is — as reembed's (SMD-2425).
            if (hardStopped) return;
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
          outage.settled(b.thought_id);
          progress();
        }
      }
    } finally {
      hb.stop();
      beats += hb.beats;
      // Rows still held are handed back unfinished: out of --limit's count
      // before the release goes out, so another worker's claim of one counts it.
      for (const id of hb.held) taken.delete(id);
      let freed = 0;
      try {
        [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      } catch (e) {
        // A follower returns them once the database answers again (SMD-2599).
        if (FOLLOW) unreturned.add(workerId);
        err(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s${FOLLOW ? ", or return when the database answers again" : ""}`);
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
      halt.abort();
      // Started before the line is written: a Writer that throws does not keep the leases.
      const release = Promise.all([...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null)));
      err(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
      return release;
    }
    stopping = true;
    onStop.abort();
    halt.abort();
    err("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
    return null;
  };
  // A caller's signal is a first stop, in words that promise no second; its
  // listener goes when the run returns (`detach`, run()'s).
  const abort = () => {
    if (stopping) return;
    stopping = true;
    onStop.abort();
    halt.abort();
    errAside("\n  stopping after the current thought; unfinished claims go back to the pool");
  };
  if (stoppedEarly()) return 130;
  opts.signal?.addEventListener("abort", abort, { once: true, signal: detach });
  // Through the start: the provider answered its probe, at once or after the wait (SMD-2752).
  opts.onStart?.({ ok: true, provider: "up" });
  opts.onPass?.(stop);

  /**
   * Workers whose leases could not be returned as they ended — the database
   * was not answering — returned at the start of the next pass rather than
   * left to expire a lease later (SMD-2599). A follower's only.
   */
  const unreturned = new Set<string>();

  // A follower's heartbeat (db/pass-stamp.ts, SMD-2261): stamped after every
  // pass and re-stamped while one runs. A one-shot run stamps nothing. A
  // caller's stamper stands in for the row (sleep.ts's, SMD-1794).
  const stamper = opts.stamper !== undefined ? (FOLLOW ? opts.stamper : null) : FOLLOW
    ? passStamper({
        sql, worker: "consolidate", job: JOB, intervalS: FOLLOW,
        onError: (e) => err(`  heartbeat ${stampKey("consolidate", JOB)} not written: ${e.message.split("\n")[0]} — a role needs the worker grant group (INSERT, UPDATE on ob1_config); the follower goes on`),
      })
    : null;
  // A pass that throws ends the run; its heartbeat says so first, as the
  // worker's end. A pass is "failed" when a worker of it stopped on the
  // provider still failing after its pauses — the provider down, not a
  // document it cannot read (review pass 2: counting rows done against rows
  // failed read a down judge as ok); a pass with work is "ok" otherwise, and a
  // poll with nothing to do keeps the last pass's word.
  let passOutcome: "ok" | "failed" = "ok";
  const stampedPass = async () => {
    const at = providerStops;
    try {
      const counted = await (stamper ? stamper.during(pass()) : pass());
      if (providerStops > at) passOutcome = "failed";
      else if (!lastPassIdle) passOutcome = "ok";
      return counted;
    } catch (e) {
      // A database outage is no end under --follow: followedPass waits it out
      // (SMD-2599), and an ended stamp would say so for every pass after it.
      if (!(FOLLOW && databaseUnavailable(e))) await stamper?.end("failed");
      throw e;
    }
  };

  let firstPass = true;
  async function pass(): Promise<Counts> {
    halt = new AbortController();
    if (ADMIT) {
      passEnds = new AbortController();
      gate = AbortSignal.any([onStop.signal, halt.signal, passEnds.signal]);
    }
    for (const w of unreturned) {
      await sql`SELECT release_claims_for_worker(${JOB}, ${w})`;
      unreturned.delete(w);
    }
    // After the leases a worker could not return, a small write and no new
    // work (review pass 6): the admit gate before the pass's pool, re-pool and counts (SMD-3379 PR
    // 1b). A stop while it waits ends the run with no pass: the summary's
    // counts are read only for a summary.
    if (ADMIT && !(await admitted(ADMIT, gate))) {
      return SUMMARY ? counts() : { pending: 0, claimed: 0, succeeded: 0, failed: 0, unpooled: 0, thoughts: 0, proposals: 0 };
    }
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
    lastPassIdle = before.pending + before.claimed === 0;
    if (lastPassIdle) return before;
    if (!FOLLOW || added > 0 || before.pending > 0) printCounts(before, "before");
    // A worker that throws — a Writer that throws, in practice; each catches
    // its own database errors — stops the rest after the thought in hand, and
    // the pass rejects with its error once they have stopped, not while they
    // still hold rows and the client.
    const ends = await Promise.allSettled(Array.from({ length: WORKERS }, (_, i) => worker(i).catch((e: unknown) => {
      stopping = true;
      passEnds.abort();
      throw e;
    })));
    const thrown = ends.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (thrown) throw thrown.reason;
    progress(true);
    // A stopping pass's count is read only for the summary (SMD-2752), as extract-entities.ts's.
    return stopping && !SUMMARY ? before : counts();
  }

  say(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

  /**
   * A follower's pass, which a database outage does not end (SMD-2599), as
   * extract-entities.ts's: said once, waited out until a SELECT 1 answers —
   * and the pass runs again at once, so its counts are read — or a stop wakes
   * the wait, and the counts are null. Any other error ends the run, as
   * before; a run without --follow is unchanged.
   */
  async function followedPass(): Promise<Counts | null> {
    for (;;) {
      try {
        const c = await stampedPass();
        // A worker found the provider not answering and ended the pass
        // (SMD-2599): the heartbeat says so, and stays a running follower's
        // while it probes, so preflight reads it alive, not stale (SMD-2261).
        if (outage.reason !== null && !stopping) {
          await stamper?.stamp("failed");
          await (stamper ? stamper.during(waitForProvider(onStop.signal)) : waitForProvider(onStop.signal));
        }
        return c;
      } catch (e) {
        if (!FOLLOW || !databaseUnavailable(e)) throw e;
        const down = Date.now();
        err(`  the database is not answering (${(e as Error).message}) — the follower waits for it, checking after ${OUTAGE_MS.first / 1000} s and then twice as long each time, up to ${OUTAGE_MS.max / 60_000} min`);
        if (!(await waitOut({ check: () => sql`SELECT 1`, outage: databaseUnavailable, wake: onStop.signal }))) return null;
        out(`  the database answers again after ${Math.round((Date.now() - down) / 1000)} s; polling resumes`);
      }
    }
  }

  // A verdict counted but not stored is lost to this key — its claim ends
  // succeeded — so the run says so first, not only in its summary (review pass 3).
  if (RELATIONS_OFF) out(`  relations: not stored this run — ${RELATIONS_OFF}; related, evolves, duplicate and unrelated verdicts are counted only, and a pair judged now gets no relation until its claim is cleared`);
  // 102 (SMD-3117): the same for a distinct, whose verdict is lost to the key as well (review pass 1) — said
  // beside relations' note too, so fixing the role does not reveal the migration only then (review pass 3).
  if (saidMissing) out(RELATIONS_OFF ? `  distinct: not stored either — ${NO_102}` : `  distinct: not stored this run — ${NO_102}; a pair judged unrelated at the floor now has its edge closed, as before 102, unless that edge is a distinct, and gets no new distinct until its claim is cleared`);
  let after = await followedPass();
  if (FOLLOW) {
    await stamper?.stamp(passOutcome);
    while (!stopping && !limitReached()) {
      await sleepUnless(FOLLOW * 1000, onStop.signal);
      if (stopping) break;
      // A follower sees a migration or a grant applied while it runs — 102's sentinel too (SMD-3117),
      // both read before either is said (review pass 3).
      storesNow(await relationsOff().catch(() => RELATIONS_OFF), await readHas102().catch(() => HAS_102), "from this poll on");
      after = await followedPass();
      await stamper?.stamp(passOutcome);
    }
    // The follower ends — a signal, its --limit, or the provider refusing the
    // request itself — and the row says so: its age then warns, as it should.
    // The provider's refusal is named on its own row, as extract's is (SMD-3214).
    if (configError && opts.stamper === undefined) stamper?.refused?.("provider");
    await stamper?.end(configError ? "failed" : "stopped");
  }

  // Leases a worker could not return as it ended, returned before the run
  // ends where the database answers; else they expire within --ttl (review pass 3).
  // All at once, and not when the run ended waiting for the database; one
  // line when they could not go (review pass 4).
  if (after !== null && unreturned.size > 0) {
    const kept = (await Promise.all([...unreturned].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.then(() => 0, () => 1)))).reduce((a: number, b: number) => a + b, 0);
    if (kept > 0) err(`  ${kept} worker(s)' leases could not be returned as the run ended; they expire within ${TTL} s`);
  }
  const elapsed = (Date.now() - started) / 1000;
  out(
    `\n  ${done} thought(s) judged, ${failed} failed, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed.toFixed(1)}s ` +
      `(${(llmMs / 1000).toFixed(1)}s in model calls across ${WORKERS} worker(s), ${beats} heartbeat(s))`
  );
  out(
    `  ${totals.pairs} pair(s) judged${judged ? ` — ${(totals.pairs / judged).toFixed(2)} per thought judged, ${Math.round((totals.pairs / judged) * 1000)} calls per thousand thoughts` : ""}; ` +
      `${totals.noCandidates} thought(s) had no candidate; verdicts: ${totals.unrelated} unrelated, ${totals.related} related, ${totals.evolves} evolves, ${totals.duplicate} duplicate, ${totals.outdates} outdates` +
      (HAS_079 ? `; ${totals.ticketCalls} judge call(s) fewer — pairs of two tickets Linear links left out at --k ${K} (079${totals.ticketCallsUnread ? `; ${totals.ticketCallsUnread} thought(s) not counted, the read failed` : ""})` : "")
  );
  out(
    `  ${totals.proposed} proposal(s) recorded (${totals.undirected} without a direction)` +
      `${totals.underConfidence ? `, ${totals.underConfidence} under confidence ${MIN_CONFIDENCE} not recorded` : ""}` +
      `${totals.alreadyProposed ? `, ${totals.alreadyProposed} pair(s) already had a proposal` : ""}` +
      `${totals.malformed ? `, ${totals.malformed} answer(s) not JSON of the expected shape` : ""}` +
      // SMD-1873: which scale the floor cut on — the model's token probability or the number it wrote.
      `${totals.tokenScored + totals.statedScored ? `; of ${totals.tokenScored + totals.statedScored} proposing verdict(s), confidence from token probabilities on ${totals.tokenScored}, from the number the model wrote on ${totals.statedScored}` : ""}`
  );
  // Decide mode (SMD-3151): what the writer was asked and what came back, and the tier's outdates under the floor it
  // was not asked about, so a run's writer calls are read from its summary.
  if (jev) {
    out(
      `  decide: the writer asked on ${totals.writerAsked} pair(s) — ${totals.writerStood} stood, ${totals.writerDeclined} declined, ${totals.writerQuotesFailed} with quotes that did not check out, ` +
        `${totals.writerUnparsed} unparsed; ${totals.gated} outdates under the floor ${MIN_CONFIDENCE}, the writer not asked`
    );
    // Decide version 4 (SMD-3203): the link step's calls, and the pairs it capped at related with no proposal.
    out(`  decide: the writer's link step asked on ${totals.linkAsked} pair(s) — ${totals.linkCapped} capped at related with no proposal (${totals.linkUnparsed} of them unparsed), ${totals.linkAsked - totals.linkCapped} direct or unlinked`);
  }
  // 084 (SMD-1873 PR 2): what the pass did to the relations it judged.
  // A run that stored relations for any part of it reports what it stored,
  // and the verdicts judged while it could not beside them (review pass 4:
  // the summary read only the last state, hiding a relation the run added).
  const unstored = totals.relationsUnstored ? `${totals.relationsUnstored} related, evolves or duplicate verdict(s) counted only` : "";
  // 102 (SMD-3117): how many of each action's writes were a distinct — part of
  // the action's count, said beside it, never added again (review pass 1) —
  // and the unrelated verdicts not stored: at the floor on a brain short of
  // 102, a distinct standing left as it was and any other edge in the closed
  // count, or counted while relations were not stored. The remedy only while
  // the brain still lacks 102 (review pass 2: a follower that saw it applied
  // gave it at its stop), read again here, since 102 may have landed — or
  // gone again — after the run's last reading (review passes 3–4); not while
  // the database is not answering, nor for a pass that makes no summary
  // queries (the scheduler's, SMD-2752).
  const ofThem = (n: number) => (n ? ` (${n} distinct)` : "");
  const lacks102 = totals.distinctNo102 > 0 && SUMMARY && after !== null ? !(await readHas102().catch(() => HAS_102)) : !HAS_102;
  const distinctTail =
    (totals.distinctNo102 ? `; ${totals.distinctNo102} unrelated verdict(s) at the floor not stored as distinct${totals.distinctStands ? ` (${totals.distinctStands} on a pair whose distinct stands, left as it was)` : ""} — ${lacks102 ? NO_102 : "judged while this brain lacked migration 102"}` : "") +
    (totals.distinctUnstored ? `; ${totals.distinctUnstored} unrelated verdict(s) counted only, judged while relations were not stored` : "");
  out(RELATIONS_EVER_ON
    ? `  relations: ${totals.relationsAdded} added${ofThem(totals.distinctAdded)}, ${totals.relationsKept} kept${ofThem(totals.distinctKept)}, ${totals.relationsReplaced} replaced${ofThem(totals.distinctReplaced)}, ${totals.relationsClosed} closed${totals.relationsGone ? `, ${totals.relationsGone} skipped — a side deleted mid-pass` : ""}` +
        `${unstored ? `; ${unstored}, judged while relations were not stored${RELATIONS_OFF ? ` — ${RELATIONS_OFF}` : ""}` : ""}` + distinctTail
    : `  relations: not stored — ${RELATIONS_OFF} — ${unstored || "0 related, evolves or duplicate verdict(s) counted only"}` + distinctTail);
  if (totals.pairs > 0) out(`  model time per pair: ${(llmMs / totals.pairs / 1000).toFixed(1)}s`);
  // 067: what became of the stale proposals this run met (a line only when it met one).
  {
    // A row that waited on one poll and was settled, replaced, decided or deleted on a later one waits no more.
    const decided = (id: string) => staleMet.settled.has(id) || staleMet.settledOut.has(id) || staleMet.replaced.has(id) || staleMet.raced.has(id) || staleMet.gone.has(id);
    const m = { replaced: staleMet.replaced.size, settled: staleMet.settled.size, settledOut: staleMet.settledOut.size, wait: [...staleMet.wait].filter((id) => !decided(id)).length, raced: staleMet.raced.size, gone: staleMet.gone.size };
    if (m.replaced + m.settled + m.settledOut + m.wait + m.raced + m.gone > 0) {
      out(
        `  stale proposals: ` + [
          m.settled + m.settledOut ? `${m.settled + m.settledOut} settled by the pass (${[m.settled ? `${m.settled} judged again with no proposal at the floor` : "", m.settledOut ? `${m.settledOut} no longer a candidate pair` : ""].filter(Boolean).join(", ")})` : "",
          m.replaced ? `${m.replaced} replaced in place — proposed again` : "",
          m.wait ? `${m.wait} wait on a vector the reembed pool writes (re-pooled by the run after it lands)` : "",
          m.raced ? `${m.raced} decided by a reviewer or another pass meanwhile` : "",
          m.gone ? `${m.gone} gone with a deleted thought` : "",
        ].filter(Boolean).join("; ") + (FOLLOW ? " — distinct rows across the polls" : "")
      );
    }
  }
  if (after === null) {
    // A follower stopped while it waited for the database: the counts
    // cannot be read, and are not guessed (SMD-2599).
    if (SUMMARY) err(`\n  stopped while the database was not answering: the pool's counts and the queue are not read — --status reads them once it answers`);
    if (configError) err(`\n  The provider refused the request itself: ${configError.slice(0, 300)}`);
    return configError ? 2 : hardStopped ? 130 : 0;
  }
  // The summary's queries are the run's report, not a pass the scheduler
  // drives: it waits for them at a wake (SMD-2752).
  if (SUMMARY) {
    printCounts(after, "after");
    await printQueue();
    if (after.failed > 0) {
      err(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
      await printFailures();
    }
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
  // refused for the same one it always was.
  const workers = cli.int("workers", { absent: 2, min: 1, max: MAX_WORKERS });
  const batch = cli.int("batch", { absent: 1, min: 1, max: MAX_BATCH });
  const ttl = cli.int("ttl", { absent: DEFAULT_TTL_S, min: 1 });
  const heartbeat = cli.has("heartbeat") ? cli.int("heartbeat", { absent: DEFAULT_HEARTBEAT_S, min: 1 }) : undefined;
  const timeout = cli.int("timeout", { absent: 120, min: 1, max: MAX_CALL_TIMEOUT_S });
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
  const stale = cli.has("stale") ? cli.int("stale", { absent: 0, bare: 90, min: 1, max: MAX_STALE_DAYS }) : undefined;
  const list = cli.has("list") ? (cli.value("list") ?? "pending") : undefined;
  // The review flags' rules before the client, where the script refused them:
  // a URL Bun's client rejects then still meets a bad --list word first, as on
  // main (review pass 3). run() refuses through the same function.
  const review = reviewProblem({ list, key: cli.value("key"), after: cli.value("after"), accept: cli.value("accept"), reject: cli.value("reject"), direction: cli.value("direction"), force: cli.has("force"), note: cli.value("note"), limit, stale, status: cli.has("status"), dryRun: cli.has("dry-run") });
  if (review !== null) {
    console.error(review);
    process.exit(2);
  }
  // One connection per worker and a spare (run()'s rule), opened lazily: a
  // refusal before the first query opens none — and the first opens them all,
  // Bun's pool connecting every one it may hold.
  const sql = openSql(url, { max: workers + 1 });
  // The signal handlers go when run() settles: a signal while the door closes
  // the pool and flushes ends the process, as one before the pass does.
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, workers, batch, ttl, heartbeat, timeout, k, minSim, minConfidence, limit, follow, stale,
      dump: cli.value("dump"),
      list,
      key: cli.value("key"),
      after: cli.value("after"),
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
