#!/usr/bin/env bun
/**
 * extract-entities.ts — extract entities and relationships from every thought,
 * in parallel, resumably, and keep doing it for new ones.
 *
 * The second consumer of migration 015's lease table, and the worker for
 * migration 016's tables. Each thought goes to the metadata model — once when
 * it fits the extraction window, once per window when it does not
 * (server-portable/entities.ts holds the prompt, the parsing rules, the
 * windowing and the merge; SMD-1879) — and the result is written through
 * `record_thought_entities`, which replaces the thought's mentions and edges
 * wholesale — so running this twice over an unchanged corpus writes nothing
 * new, and running it after an edit leaves only what the new text says.
 *
 *   bun db/extract-entities.ts --url postgres://…             # the backlog, then exit
 *   bun db/extract-entities.ts --url … --follow [SECONDS]     # …then keep polling for new captures
 *   bun db/extract-entities.ts --url … --limit 25             # a trial: this many thoughts, then stop
 *   bun db/extract-entities.ts --url … --status               # where the pass stands, and what it has found
 *   bun db/extract-entities.ts --url … --dry-run              # what a run would do; writes nothing
 *   bun db/extract-entities.ts --url … --retry-failed         # failed rows back into the pool first
 *   bun db/extract-entities.ts --url … --retry-partial        # rows extracted in part back into the pool — after raising OB1_EXTRACT_MAX_WINDOWS
 *   bun db/extract-entities.ts --url … --retry-left-out       # …only those with windows left out as malformed — after a change of model, kept to this pool with --job (below)
 *   OB1_METADATA_MODEL=<larger> bun db/extract-entities.ts --url … --job <the recorded key> --retry-left-out --limit N   # a larger model over those N rows, the key and trigger left as they are (--status prints it)
 *   bun db/extract-entities.ts --url … --dump answers.jsonl   # also append every model answer, for evals/eval-entities.ts --replay
 *   bun db/extract-entities.ts --url … --switch-key           # required when the model or prompt version differs from ob1_config
 *   bun db/extract-entities.ts --url … --subjects [rules]     # each thought's own subject, where none is current (db/subject-sweep.ts; its --timeout is 900 s with the judge model's reasoning on, 300 off)
 *   await run({ url, dryRun: true })                          # a dry run, in-process: import { run } from "./extract-entities.ts" (SMD-2304)
 *   --workers N (2; at most 2147483647: a connection each and a spare, Bun's pool max of 2^31)   --batch N (1; at most 2147483647, claim_thoughts' int)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)   --timeout SECONDS (300, per model call — per window of a long thought; at most 9007199254740, a call signal's range)
 *   exits 0 clean (partial rows included) · 1 rows failed, leased or pending · 2 usage, configuration or the provider's refusal · 3 the model likely at fault (SMD-2266, ahead of 1) · 130 a signal (a second, at once); --follow stopped by one signal exits 0
 *
 * ── The cost, and the switch ────────────────────────────────────────────────
 * One LLM call per thought — per window of a thought over the extraction
 * window, so a 13,000-character thought is four or five smaller calls rather
 * than one that never ends (SMD-1879) — recurring: every new capture is extracted too. On
 * the fork's default — Ollama, `qwen2.5:7b` — that is compute and latency on
 * your own machine and nothing leaves it. Pointed at a hosted provider it is
 * money, per thought, for ever, and the content of every thought goes to that
 * provider rather than only the ones someone searches for. FORK.md change 30
 * has the measured wall clock for a full pass.
 *
 * Two workers by default, and the number was measured three times because the
 * first two readings disagreed and both were partly wrong. The 441-issue corpus
 * at two workers and a 120 s per-call timeout: 4,941 s. One worker at 300 s:
 * 6,793 s — read at the time as the second worker buying a third of the wall
 * clock. Two workers at 300 s, the like-for-like pair: 6,480 s, 4.6% faster
 * than one. The earlier gap was the timeout budget, not concurrency; per
 * completed document the two-worker passes spent about twice the worker-seconds,
 * which is what a serialising local Ollama looks like. Two stays the default
 * because it costs nothing and recovers a little; do not expect more. The
 * timeouts (21, 11, 19 across the three passes) were read as long documents
 * whose extraction genuinely takes minutes on a 7B model; measured again for
 * SMD-1879 they were answers that did not end — the model repeating one
 * relation until the context ran out — and the windows plus the per-call
 * answer budget (entities.ts) turn them into fast, visible failures or, for
 * the long ones, into extractions. --workers beyond two is for a hosted
 * provider that really does serve calls in parallel.
 *
 * One thought is extracted in at most OB1_EXTRACT_MAX_WINDOWS windows (24
 * unset), and runs chunk.ts cannot split are cut where the thought's text
 * reaches that many windows' worth (server-portable/entities.ts,
 * boundedWindows). A
 * longer one — an ingested PDF, a page, a long
 * session summary — is extracted over its first windows and its claim is
 * released succeeded with a caveat: migration 028's rule, last_error on a
 * succeeded row, here beginning "partial: " and naming how many windows of how
 * many (SMD-2240). Until SMD-2240 such a thought was failed before any call
 * and contributed nothing to the graph. A thought some of whose windows the
 * model answered malformed is the second kind of partial row, its caveat
 * naming those windows (SMD-2260, below). The run's summary and --status count
 * the partial rows apart from the full ones and from the failures, each kind
 * apart, and list them; raise OB1_EXTRACT_MAX_WINDOWS and --retry-partial
 * returns them to the pool, where record_thought_entities replaces the
 * prefix's rows with the longer reading's. A row failed by the old rule ("over EXTRACT_MAX_WINDOWS
 * (24); not extracted") comes back with --retry-failed and is extracted so.
 *
 * A windowed thought's windows are kept as they parse (migration 093's
 * extraction_progress, SMD-2694), so a claim that does not finish — a hard
 * stop, a lapsed lease, a failed release — leaves them to the next claim of
 * the same text, which sends only the windows still to do: a document longer
 * than every sleep of the sleep scheduler (db/sleep.ts) advances by its
 * windows at each, where it started again at its first. A window is reused
 * only for the request it answered (the text's fingerprint, the windowing,
 * the request's hash), a malformed one never; the hard stop counts itself on
 * the thought in hand before its lease goes back, a stall only when it had
 * held the thought at least STALL_FLOOR_MS, provider pauses aside — the sleep
 * scheduler's own cut (PassStop's `cut`) as a cut, apart from the stops and
 * stalling nothing (migration 101, SMD-3060). A first
 * stop ends a windowed thought at its next window, those answered kept, not
 * after its last. Each run prunes the rows no reader can use. --status lists
 * them.
 *
 * Nothing spends it until this runs. The first run writes the extraction key
 * to `ob1_config.entity_extraction_key`; from then on migration 016's trigger
 * enqueues every new or edited thought, and either the next run or a `--follow`
 * process extracts it. To stop: delete that row and the trigger goes quiet.
 *
 * A `--follow` process outlasts the database going away (SMD-2599): an error
 * that says it is not answering — refused, closed, starting up — is said once
 * and waited out, checking after 5 s and twice as long each time up to 5 min
 * (worker-bootstrap.ts, waitOut), and polling resumes when it answers. A
 * thought in hand is recorded nothing; its lease is returned when the
 * database is back. Its start waits the same way, every statement up to the
 * first claim but an operator's --retry-* — the worker key's lookup too,
 * which would otherwise go on unattributed — since the sleep scheduler starts
 * a follower at every sleep (SMD-2752). A run without --follow still exits 1
 * on it.
 *
 * It outlasts the provider going away too. Three things are outages:
 *   - a rate limit, a server error or a lost connection still failing after
 *     the pauses;
 *   - the model missing, as while Ollama pulls it;
 *   - a timeout after which a one-token probe gets no answer either.
 * In each case the thought in hand goes back to the pool, not failed, the
 * other workers stop after theirs, and the follower probes the model on the
 * same schedule until it answers. A thought that draws the error again right
 * after a probe answered is its own fault, and is recorded failed. Before it
 * writes anything, the worker key's registration included, a follower probes
 * once. A model the provider does not serve, a key it refuses or a wrong
 * base URL exits 2 there, and an unreachable provider is waited for.
 * OB1_EXTRACT_ESCALATE_MODEL is checked by GET /models, which loads nothing:
 * refused where the list plainly leaves it out, waited for by name if the
 * start saw it and it goes missing, and a refusal at its first 404 if the
 * start could not confirm it. A run without --follow keeps the pauses, then
 * records the thought failed and stops, as before.
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
 * showed is a property of the longest thoughts rather than of the moment.
 * A windowed thought's malformed window is not (SMD-2260): the windows that
 * parsed are written and the claim is released succeeded with a caveat naming
 * the windows left out, a second kind of partial row, counted and listed
 * apart from a prefix, whenever at least one other window parsed; a thought
 * none of whose windows parsed is failed as malformed. So a model that
 * answers a large share of windows malformed writes partial rows, not failed
 * ones, and the run watches the share instead (SMD-2266, db/config.mjs's
 * malformedAlarm): when more than a fifth of at least 48 answers — one per
 * window of each thought that returned — were malformed, it says on stderr
 * that the model is likely at fault and exits 3, ahead of the 1 of rows
 * failed, leased or pending. A --follow process judges blocks of 48 or more
 * after each pass drains the pool, so one started on a backlog says nothing
 * until the backlog is done (try a new model with --limit 48 first); stopped
 * by a signal it exits 0, and at its --limit with a block tripped, 3. A
 * thought's own share is not judged: a reference list is its text's fault,
 * not the model's. A
 * rate limit, a server error or a lost connection is neither: the worker
 * pauses and retries — a stop wakes the pause, and the thought goes back to
 * the pool (SMD-2401) — and stops if the provider stays down, leaving its
 * leases to return to the pool rather than marking thoughts failed for it. A content
 * edit that lands while a thought is being extracted makes
 * `record_thought_entities` refuse with stale=true; the trigger has already
 * re-queued the thought, so the worker moves on and the pool redoes it.
 *
 * Changing the model or the prompt version changes the key. A run under a key
 * other than the recorded one needs --switch-key, as a re-embed under another
 * model needs --switch-model: record_thought_entities replaces a thought's rows
 * whatever key wrote them, so a partial run under a second model leaves a
 * per-thought mixture that nothing repairs.
 *
 * ── A thought's own subject (SMD-3306) ──────────────────────────────────────
 * With its entities, each thought's own subject is recorded when a rule finds
 * it: the ticket it is filed under, else a session summary's header ticket
 * its prompts name (server-portable/subject.ts), through migration 111's
 * record_thought_subject at the text the claim read. No model is asked for
 * it here. `--subjects` is the sweep for the rest (db/subject-sweep.ts):
 * thoughts extracted before 111, those no rule keys, which it asks the judge
 * model about, those whose text moved, those whose subject an older rule or
 * question found, and, while the question is asked with the judge model's
 * reasoning on (OB1_SUBJECT_REASONING), those a model found with it off. A
 * brain before 111, or a role
 * without the grants 111's door needs, records no subject and says so once;
 * the entities stand either way.
 */

import type { SQL } from "bun";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { PROVIDER_ERROR_CHARS, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, ROW_UNITS } from "../server-portable/egress.ts";
import { blanketGate, classifyError, databasePermanent, databaseUnavailable, egressDescription, egressRefusal, isOut, lookupOutage, MAX_CALL_TIMEOUT_S, missingModelIs, modelListed, modelMissing, OUTAGE_MS, probeChat, probeRefusal, probeUntil, ProviderOutage, regateMessage, throughOutage, timedOut, TRANSIENT_PAUSES_MS, waitOut, workerIdentity, type Probe, type StartRefusal, type StartResult } from "./worker-bootstrap.ts";
import { callsMadeBy, callsOf, describeExtractWindow, extractEntities, extractionKey, MALFORMED_WINDOWS_MARK, OVER_BOUND_MARK, PARTIAL_CAVEAT_PREFIX, partialCaveat, StoppedBetweenWindows, windowingFor, windowList, type AbortedBy, type Extraction, type ExtractionWindow, type ExtractProgress } from "../server-portable/entities.ts";
import { entityRecipe, subjectRecipe } from "../server-portable/lineage.ts";
import { ruleSubject, subjectRuleKey } from "../server-portable/subject.ts";
import { DOOR_GRANTS, recordSubject, sweepSubjects } from "./subject-sweep.ts";
import { decideEntities } from "../server-portable/hybrid-extract.ts";
import { resolveJevConfig, type JevEnv } from "../server-portable/jev.ts";
import { DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, heartbeatFor, leaseHolders, leaseRefusal, MAX_BATCH, MAX_WORKERS, reportLost, sleepUnless, startHeartbeat, stopOnSignals, STOPPED_EARLY, AdmitThrow, admitted, claimAfterWait, ClaimGoneAtGate, type Admit, type PassStop } from "./lease.ts";
import { blankProblem, commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql, type SessionSettings } from "./connect.ts";
import { EXTRACT_MALFORMED_ALARM_MIN, EXTRACT_MALFORMED_ALARM_SHARE, malformedAlarm } from "./config.mjs";
import { endOnRefusal, passStamper, stampKey, type MalformedBlock, type PassStamper } from "./pass-stamp.ts";

/**
 * Every argument accounted for (db/cli.ts): a flag this worker does not have,
 * or one given twice, is refused before anything is claimed — a mistyped
 * `--workers` ran the default and exited 0 (SMD-2015). A numeric flag present
 * with no value is an error, not the default: `--limit` typed alone meant "no
 * limit" once, and sent the whole backlog to the model. --follow's value is
 * optional: a poll interval with a sensible default. run()'s refusals of a
 * number end with the same flag list the CLI's do.
 */
const FLAGS = {
  url: "one", workers: "one", batch: "one", ttl: "one", heartbeat: "one", timeout: "one", limit: "one",
  follow: "optional", dump: "one", job: "one",
  status: "none", "dry-run": "none", "switch-key": "none", "retry-failed": "none", "retry-partial": "none", "retry-left-out": "none", decide: "none",
  subjects: "optional",
} as const;
const HINTS = { url: "<postgres://…>", follow: "[SECONDS]", dump: "<answers.jsonl>", job: "<the recorded key>", subjects: "[rules] (the subject sweep: with --url, --limit, --timeout, --dry-run)" };
/** The flags the subject sweep reads (db/subject-sweep.ts): any other beside --subjects is the pass's, refused rather than dropped. */
const SUBJECT_FLAGS: ReadonlySet<string> = new Set(["subjects", "url", "limit", "timeout", "dry-run"]);

/**
 * What one extraction run is asked to do — the CLI's flags, typed (SMD-2304).
 * A number left out takes the CLI's default, and one given is held to its
 * flag's rule and refused in the CLI's words; `follow` is --follow's poll
 * interval in seconds (the bare flag's is 15). An absent option may also be
 * null.
 *
 * `sql`, when given, is the caller's client — used in place of `url` for the
 * pass, and never closed here. It needs a connection per worker and a spare
 * the heartbeat beats through (db/lease.ts), so at least workers + 1 (the
 * `max` option), free for the run: a pool another run or caller is using at
 * the same time takes the spare. A reserved connection or a transaction's
 * handle is refused. The worker key resolves on a connection of its own
 * (db/worker-bootstrap.ts), so a run with OB1_WORKER_KEY set needs `url`
 * beside `sql`, the URL of the database `sql` is connected to. Nothing checks
 * that the two name one database; a URL for another registers the agent
 * there, and the rows here carry its id. `env` is what the run reads for the
 * model, the endpoints, the egress policy and the worker key: process.env
 * when absent.
 *
 * `signal` stops the pass as the CLI's first signal does: every worker after
 * the thought in hand, its unfinished claims back to the pool, and wakes a
 * follower's sleep. Aborted before the pass begins, it stops the run before
 * its next write — the agent's registration, the key, a --retry-* statement,
 * the pool — and run() returns 130 (a statement already committed stays so).
 * `onPass` is called once, as the pass begins — where the CLI installs its
 * signal handlers (stopOnSignals) — with the pass's stop (db/lease.ts's
 * PassStop). Its hard stop returns the leases at once, aborts the model call
 * in hand — no further window or retry is sent (SMD-1794) — and wakes a
 * worker pausing on a provider error, and run() returns 130 (2 after the
 * provider's refusal), writing and releasing nothing for the thought in hand
 * but its stop, counted while the claim is still the worker's (SMD-2694) — its
 * windows answered so far were kept as each parsed; a --decide decider call
 * in hand is waited for. A call after run() has
 * returned does nothing. Neither is used by --status or --dry-run, which have no pass.
 */
export interface ExtractOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  workers?: number;
  batch?: number;
  ttl?: number;
  heartbeat?: number;
  timeout?: number;
  limit?: number;
  follow?: number;
  /** --dump <file>: append every model answer as JSONL (below). */
  dump?: string;
  job?: string;
  status?: boolean;
  dryRun?: boolean;
  switchKey?: boolean;
  retryFailed?: boolean;
  retryPartial?: boolean;
  retryLeftOut?: boolean;
  decide?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
  /**
   * A follower's heartbeat in place of its own `heartbeat:extract:<job>` row
   * (db/pass-stamp.ts): sleep.ts's, so a wake does not end a row (SMD-1794).
   * Null stamps nothing. Unused by a one-shot run, which stamps nothing.
   */
  stamper?: PassStamper | null;
  /**
   * A follower's start alone (SMD-2752): the banner, the egress gate, the
   * tables, the provider's probe and the escalation model's listing, the
   * worker key and the recorded extraction key — then 0, before the pass's
   * first write (the key's, a --retry-*, the pool), without waiting for a
   * provider that does not answer; or the start's refusal (2). The worker
   * key's lookup writes, as at every start (resolve_agent registers the agent
   * and stamps its last use): it is how a revoked key is found. Needs
   * `follow`, and no `status` or `dryRun`. The
   * sleep scheduler's check at its own start, so a misconfiguration is
   * refused there rather than at the first quiet.
   */
  check?: boolean;
  /**
   * False leaves out the start's banner — the job, model, window and egress
   * lines, the worker key's agent line or its no-key warning and the key's
   * note, which the sleep scheduler's check says once, and the workers line,
   * which the check returns before and a driven pass leaves out — for a pass
   * the scheduler drives at every sleep (SMD-2752). A refusal still says
   * what it refuses.
   */
  banner?: boolean;
  /**
   * False leaves out the end-of-run summary — the counts, the graph, the
   * partial and failed rows — and the pass's last count of the pool when it
   * is stopping: queries over the whole graph that the sleep scheduler waits
   * for at a wake, when the brain is live again (SMD-2752).
   */
  summary?: boolean;
  /** How the start went (worker-bootstrap.ts's StartResult): through, or refused and why — called once, as the pass begins or as the start refuses (SMD-2752). */
  onStart?: (r: StartResult) => void;
  /**
   * How long a hard stop must find the thought in hand, with no window saved
   * since the last stop, to count as a stall (093's p_long): STALL_FLOOR_MS
   * unless a test drives it faster (review pass 2 of SMD-2694).
   */
  stallFloorMs?: number;
  /**
   * Postgres settings the run's own client opens every connection with
   * (connect.ts's `session`): the sleep scheduler's per-pass budget —
   * statement_timeout, work_mem, maintenance_work_mem (SMD-2679). Refused
   * beside `sql`, a caller's client, which it would not reach.
   */
  session?: SessionSettings;
  /**
   * The admit gate (db/lease.ts's Admit, SMD-3379 PR 1b): awaited before each
   * claim, at the start of each pass — before its pool and its counts — and
   * before each window of a windowed thought that is sent. A worker waiting
   * between thoughts holds no claim; one waiting between windows keeps its
   * claim and lease, and the wait moves the thought's time held on, as a
   * provider pause does, and is not counted as the model's (a hard stop
   * counts the thought's time up to the wait). A stop while it waits ends the
   * worker there, as does the pass ending for a reason of its own (another
   * worker's outage, the provider's refusal, a worker's throw): between
   * windows as a first stop ends a thought there, its windows answered so far
   * kept (or, with no kept windows, its claim back in the pool). When the
   * gate held it, the claim is read again before a window is sent: a thought
   * deleted or no longer this worker's has nothing more sent, one edited goes
   * back to the pool for its new text. Unused by --status and --dry-run.
   */
  admit?: Admit;
}

/**
 * A hard stop that finds a thought in hand for less than this, no window
 * saved since the last, counts as a stop and not a stall (SMD-2694, review
 * pass 2): on a busy day the sleep scheduler's sleeps can be seconds long, and
 * three of them would mark a document advancing by its windows as stalled —
 * what the scheduler acts on (SMD-2694). A minute is past the median single-window
 * extraction on the stable brain (32 s, 2026-10-13), so a stop that long with
 * nothing saved is a slow window, not a short sleep.
 */
const STALL_FLOOR_MS = 60_000;
/** How long the hard stop waits for its count before it returns the lease anyway: the CLI exits 3 s after a second signal, and the release must be sent (review pass 2). 093's note gives up a lock wait after a second, so a count blocked on a lock drops its own and the release is not queued behind it (review pass 3). */
const STOP_NOTE_WAIT_MS = 1_500;
/** Resolves after `ms`, holding no host open: the stop's bound, which a fast count leaves pending (review pass 3). */
const unrefSleep = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** The run's numbers, each the option given or the CLI's default. */
type Numbers = { workers: number; batch: number; ttl: number; heartbeat: number; timeout: number; limit: number; follow: number };

/**
 * The run's numbers from its options, or the refusal of the first that breaks
 * its flag's rule, in the order the CLI reads them — the lease pair checked
 * between them, where the CLI checks it — so run() and the CLI refuse the same
 * input first.
 */
function numbers(opts: ExtractOptions): Numbers | string {
  const read = (flag: string, v: number | null | undefined, absent: number, rule: { min: number; max?: number } = { min: 1 }): number | string => {
    if (v == null) return absent;
    const problem = numberProblem(flag, v, rule);
    return problem === null ? v : `${problem}\n${flagList(FLAGS, HINTS)}`;
  };
  const workers = read("--workers", opts.workers, 2, { min: 1, max: MAX_WORKERS });
  if (typeof workers === "string") return workers;
  // One thought per claim. A claim costs half a millisecond against a model call
  // of ten seconds or more, so a bigger batch buys nothing, and a worker that
  // dies holds fewer rows. (Until migration 031 there was a second reason: the
  // lease was stamped per claim and could not be moved, so a batch of four at a
  // 300 s timeout could outlive a 900 s lease and be extracted twice. The
  // heartbeat retires it.)
  const batch = read("--batch", opts.batch, 1, { min: 1, max: MAX_BATCH });
  if (typeof batch === "string") return batch;
  // The lease is renewed on a heartbeat while the worker holds rows, so it has
  // to outlast a missed beat, not the batch — db/lease.ts holds the rule the
  // three consumers share, and the refusal below is its.
  const ttl = read("--ttl", opts.ttl, DEFAULT_TTL_S);
  if (typeof ttl === "string") return ttl;
  const heartbeat = read("--heartbeat", opts.heartbeat, heartbeatFor(ttl));
  if (typeof heartbeat === "string") return heartbeat;
  const timeout = read("--timeout", opts.timeout, 300, { min: 1, max: MAX_CALL_TIMEOUT_S });
  if (typeof timeout === "string") return timeout;
  const lease = leaseRefusal(ttl, heartbeat, opts.heartbeat == null);
  if (lease) return lease;
  const limit = read("--limit", opts.limit, 0);
  if (typeof limit === "string") return limit;
  const follow = read("--follow", opts.follow, 0);
  if (typeof follow === "string") return follow;
  return { workers, batch, ttl, heartbeat, timeout, limit, follow };
}

/**
 * What a failed row's error adds about a runaway aborted on the stream, or ""
 * when no malformed window's first call was. A runaway aborted on the stream
 * is named in the failed row's error, so an operator sorting the failed rows —
 * for SMD-2000's larger model, say — can tell a loop the retry did not rescue
 * from an answer that was never JSON. The MALFORMED window's own abort, not the
 * thought's longest (one the retry may have rescued), and "the retry did not
 * converge" only when a retry was made (review passes one to four of SMD-1960).
 * Only a first call is ever aborted — the retry is read whole — so the note
 * names it. "No retry was made" is reachable only with EXTRACT_RETRY_RUNAWAY
 * off and the stream abort on — a constant flipped — and stays for that truth.
 */
export function abortedNote(extraction: Extraction): string {
  const abortedParts: { abortedMs?: number; abortedBy?: AbortedBy; retried?: true; escalated?: string }[] = extraction.parts ? extraction.parts.filter((p) => p.malformed && p.abortedMs !== undefined) : extraction.malformed && extraction.abortedMs !== undefined ? [extraction] : [];
  if (abortedParts.length === 0) return "";
  const abortedMs = Math.max(...abortedParts.map((p) => p.abortedMs as number));
  // What the runaway was, by each aborted window's own reason (SMD-2449): a
  // third copy of one item, or one short unit repeated — the loop Ollama's
  // repeat limit cuts, which read as a closed socket before.
  const why = [...new Set(abortedParts.map((p) => p.abortedBy === "token" ? "the answer repeated one short unit (a word, a number, punctuation, an emoji or whitespace) over and over" : "the answer went on past a third copy of one item"))].join(", or ");
  // When the second call was an escalation (SMD-2000), name the model that
  // still could not answer — the operator sorting the failed rows for a larger
  // model is told the larger model already ran.
  const escalatedTo = abortedParts.map((p) => p.escalated).find(Boolean);
  const secondNote = escalatedTo ? `and the escalation to ${escalatedTo}, read whole, did not converge either` : "and the penalised retry, read whole, did not converge either";
  // A token runaway may have been ended by the provider (Ollama's repeat
  // limit) rather than by this reader; an item runaway is always ours.
  const ended = abortedParts.some((p) => p.abortedBy === "token") ? "was aborted, or cut by the provider's repeat limit," : "was aborted";
  return `; the first call ${ended} on the stream ${(abortedMs / 1000).toFixed(1)} s in — ${why} — ${abortedParts.some((p) => p.retried) ? secondNote : "and no retry was made"}`;
}

/**
 * The extraction pass, callable: the CLI's run, returning the code the CLI
 * exits with (the header's list). Nothing happens at import. A database error
 * outside a thought's own handling — the tables' check refused, say — rejects,
 * as the CLI's stack dump always showed; run()'s own client is closed first.
 */
export async function run(opts: ExtractOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  /** A refusal of the options themselves: said, reported as the start's `usage`, 2. */
  const usage = (line: string): number => {
    err(line);
    opts.onStart?.({ ok: false, refused: "usage" });
    return 2;
  };
  // A blank value where the CLI's scanner refuses one first, in its words and
  // with its flag list: `--job ""` reaches no run (SMD-2425, as reembed's).
  const blank = blankProblem(FLAGS, { dump: opts.dump, job: opts.job });
  if (blank !== null) return usage(`${blank}\n${flagList(FLAGS, HINTS)}`);
  // databaseUrl's two refusals without its exit, then the numbers. A URL beside
  // a caller's client is the worker key's (above), so it is held to the rule too.
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) return usage(urlProblem);
  const settled = numbers(opts);
  if (typeof settled === "string") return usage(settled);
  // The check is a follower's start, its probe included (SMD-2752).
  // Beside --status or --dry-run the probe and the key are skipped, and a
  // start reported through would be none (review pass 1).
  if (opts.check && (!settled.follow || opts.status === true || opts.dryRun === true)) return usage("extract-entities.ts: check is a follower's start — pass follow beside it, and no --status or --dry-run.");
  if (opts.sql != null && opts.session != null) return usage("extract-entities.ts applies session settings to a client of its own: pass url without sql, or no session.");
  if (opts.sql != null) {
    // A reserved connection or a transaction's handle reports its pool's max
    // but is one connection, and a transaction keeps the run's claims from the
    // other workers — and a rollback from the database (review pass 1).
    const handle = opts.sql as { release?: unknown; savepoint?: unknown };
    if (typeof handle.release === "function" || typeof handle.savepoint === "function") {
      return usage("extract-entities.ts needs a pool, not a reserved connection or a transaction's handle: either is one connection whatever max it reports, and a transaction's claims are no other worker's until it commits. Pass the client itself, or a URL.");
    }
    // One connection per worker and one spare: the heartbeat (db/lease.ts)
    // beats through the pool, and a worker parked on a lock or a long statement
    // holds its own connection, so the spare is what keeps every worker's
    // leases alive then. Tightening this to the workers would recreate the
    // lapse 031 removed. Bun's default pool is ten.
    const max = Number((opts.sql as { options?: { max?: number } }).options?.max ?? 10);
    if (max < settled.workers + 1) {
      return usage(`extract-entities.ts needs a client of at least ${settled.workers + 1} connections for ${settled.workers} worker(s): one each and a spare the heartbeat beats through (db/lease.ts). Pass a client opened with a larger max option, or a URL.`);
    }
    if (noUrl && (opts.env ?? process.env).OB1_WORKER_KEY && !opts.status && !opts.dryRun) {
      return usage("extract-entities.ts resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
    }
  }
  // A signal aborted before the call: nothing opened, nothing written. --status
  // and --dry-run have no pass to stop, and read on (review pass 2).
  if (opts.signal?.aborted && !opts.status && !opts.dryRun) {
    err(STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: settled.workers + 1, session: opts.session ?? undefined });
  // Aborted when the run returns, taking its listener off the caller's signal.
  const detach = new AbortController();
  // The start's refusal, as onStart hears it: a follower of its own ends its
  // row on it, the kind named, so preflight gives the remedy — and the compose
  // service's supervisor, which keeps the follower's word, says it is held for
  // that cause (SMD-3214). Not the scheduler's check, nor a pass it drives,
  // whose row is the scheduler's.
  let refusedAt: StartRefusal | null = null;
  const heard: ExtractOptions = { ...opts, onStart: (r) => { if (!r.ok) refusedAt = r.refused; opts.onStart?.(r); } };
  try {
    const code = await extractWith(sql, heard, settled, out, err, detach.signal);
    if (code === 2 && refusedAt !== null && settled.follow && opts.stamper === undefined && !opts.check && !opts.status && !opts.dryRun) {
      const job = opts.job ?? extractionKey(resolveEmbedConfig((opts.env ?? process.env) as EmbedEnv).metadataModel);
      await endOnRefusal({ sql, worker: "extract", job, intervalS: settled.follow, kind: refusedAt, onError: (e) => err(`  heartbeat ${stampKey("extract", job)} not ended on the refusal: ${e.message.split("\n")[0]}`) });
    }
    return code;
  } finally {
    detach.abort();
    // A failing close must not mask the run's own error.
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** The run once its options are settled: the script's body as it was, printing through the Writer and returning where it exited. */
async function extractWith(sql: SQL, opts: ExtractOptions, settled: Numbers, out: Writer["out"], err: Writer["err"], detach: AbortSignal): Promise<number> {
  const { workers: WORKERS, batch: BATCH, ttl: TTL, heartbeat: HEARTBEAT, timeout: TIMEOUT_S, limit: LIMIT, follow: FOLLOW } = settled;
  const env = opts.env ?? process.env;
  /**
   * Append every model answer here as JSONL — {id, fingerprint, entities,
   * relations}, and `windows` (the windows SENT), `coverage` when that was a
   * prefix of the thought (SMD-2240) or some windows' answers were malformed
   * and left out (SMD-2260) — for evals/eval-entities.ts --replay.
   */
  const DUMP = opts.dump ?? undefined;
  const STATUS_ONLY = opts.status === true;
  const DRY_RUN = opts.dryRun === true;
  const SWITCH_KEY = opts.switchKey === true;
  const RETRY_FAILED = opts.retryFailed === true;
  const RETRY_PARTIAL = opts.retryPartial === true;
  /** --retry-partial's rows with windows left out alone: a change of model re-reads them without re-reading every prefix to the place it already reached (review pass 1). */
  const RETRY_LEFT_OUT = opts.retryLeftOut === true;
  // SMD-2321: `--decide` re-types the 7B's entities with the Jev decider (validity +
  // type), storing p_true as confidence. Opt-in and only with the tier configured.
  const DECIDE = opts.decide === true;
  /**
   * A caller's signal aborted before the pass began stops the run before its
   * next write — the agent's registration, the key, a --retry-* statement,
   * the pool — returning 130, as a signal before the CLI's handlers ends the
   * process where it stands; a retry's rows are not returned to a pool nothing
   * will drain (review pass 1).
   */
  const stoppedEarly = (): boolean => {
    if (opts.signal?.aborted !== true) return false;
    err(STOPPED_EARLY);
    return true;
  };
  /**
   * A statement of the start, before the first claim: a follower's outlasts
   * the database going away (worker-bootstrap.ts's throughOutage), since the
   * sleep scheduler starts a pass at every sleep and meets a restarting
   * database there, where a follower meets it once (SMD-2752). Null when the
   * caller's signal ends the wait. The CLI has no handlers yet: a signal
   * ends the process outside a container, and inside one bun as PID 1
   * ignores it until compose's grace runs out (SMD-2666, the provider's
   * start wait's too). A run without --follow, and --status or --dry-run
   * beside it, still rejects on the error (review pass 3).
   */
  const startSaid = { down: false };
  const atStart = <T>(run: () => Promise<T>): Promise<T | null> =>
    FOLLOW && !STATUS_ONLY && !DRY_RUN ? throughOutage(run, { wake: opts.signal ?? new AbortController().signal, said: startSaid, out, err }) : run();
  /** An atStart wait the caller's signal ended (its null): a stop before the pass began. */
  const stoppedWaiting = (): number => {
    stoppedEarly();
    return 130;
  };
  /** The start alone, for the sleep scheduler's check (SMD-2752): run() refused it without follow. */
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
  const jevCfg = DECIDE ? resolveJevConfig(env as unknown as JevEnv) : null;
  if (DECIDE && !jevCfg) return refused("usage", "  --decide needs the Jev tier: set OB1_JEV_BASE_URL (and OB1_JEV_LOCAL for a loopback endpoint)");
  /** The windowing every row is extracted under — its bound is what a partial row's caveat names. */
  const WINDOWING = windowingFor(cfg);
  const JOB = opts.job ?? extractionKey(cfg.metadataModel);

  say(`  job:    ${JOB}`);
  say(`  model:  ${cfg.metadataModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}`);
  // The window a thought is extracted in, and where the number came from
  // (SMD-1879) — the same rule preflight prints, so the banner says what the
  // pass will do rather than a second opinion of it.
  say(`  window: ${describeExtractWindow(cfg)}`);
  // What may leave the box (SMD-1903): a row the gate refuses is a failed claim
  // naming the rule; its text never went anywhere, and --retry-failed revisits it.
  say(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
  {
    // A policy that refuses whatever the row (SMD-1903): stop before claiming,
    // rather than fail every row in the pool one at a time. A dry run and
    // --status still report — the banner's egress line says why a run would not.
    // The units a row of this pass carries: its metadata and text, and the
    // worker key's name as the actor when one is set (second review pass).
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "extracted", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !STATUS_ONLY && !DRY_RUN) return refused("egress", `\n  ${blanket}`);
  }

  // ── The database's side ─────────────────────────────────────────────────────

  const tables = await atStart(async () => Number((await sql`
    SELECT count(*)::int AS tables FROM pg_class
    WHERE relname IN ('thought_work_claims', 'ob1_entities', 'thought_entities', 'ob1_entity_edges') AND relkind = 'r'`)[0].tables));
  if (tables === null) return stoppedWaiting();
  if (tables < 4) return refused("tables", "\n  The entity tables or the lease table are missing. Apply migrations 015 and 016 first:\n    cd db && bun migrate.ts --url …");

  // ── The provider, for a follower (SMD-2599) ─────────────────────────────────

  /**
   * A follower waits a provider outage out rather than failing the thoughts
   * it claims meanwhile: one-token chat calls to the model (probeChat, not
   * GET /models, which Ollama answers while chat does not), bounded by a
   * minute — the call's own timeout after a timeout, which a busy local
   * model may need to get to the probe at all — and ended by the pass's stop.
   * It asks once before it writes anything, the worker key's registration
   * included: a model the provider does not serve, a key it refuses or a
   * base URL that is no API is a refusal at start, exit 2, as preflight's
   * would be (the escalation model is checked by GET /models: below); once
   * a model has answered, its going missing (Ollama pulling it again) is an
   * outage. A
   * provider that does not answer at start is waited for as the run's last
   * step before it writes the pool, so a refusal of the key or the
   * configuration is not held behind the wait (review pass 2), and what it
   * answers then is held to the same refusals.
   */
  const probe = (ms = Math.min(TIMEOUT_S, 60) * 1000, wake?: AbortSignal, model = cfg.metadataModel) => probeChat(cfg.chat, model, ms, wake);
  const outage = new ProviderOutage();
  /** The model an outage probes: the metadata model, or the escalation model when its 404 began the outage (review pass 2). */
  let outageModel = cfg.metadataModel;
  /**
   * Whether the start saw the escalation model listed. Its 404 later is an
   * outage only then — a model seen that goes missing is being pulled again,
   * and is waited for by name; one never confirmed may be a typo the list
   * could not show, and its 404 is the provider's refusal, exit 2, as before
   * this ticket (review pass 4: it stalled the follower for good).
   */
  let escalationSeen = false;
  /** Probe until the provider answers, saying when it stopped and when it answered; a stop ends the wait. */
  async function waitForProvider(wake: AbortSignal): Promise<void> {
    const down = Date.now();
    err(`  the provider is not answering (${(outage.reason ?? "").slice(0, 200)}) — unfinished thoughts are back in the pool, recorded nothing; the follower calls ${outageModel} at ${cfg.chat.base} for one token after ${OUTAGE_MS.first / 1000} s and then twice as long each time, up to ${OUTAGE_MS.max / 60_000} min`);
    // Said on the row it stamps — the sleep scheduler's, or this follower's
    // own — so preflight names the provider, not "running a pass"; a stop
    // wakes the probes, so the end is said before the pass settles (SMD-2905).
    await stamper?.providerWait?.(true);
    try {
      if (await probeUntil(() => probe(undefined, wake, outageModel), wake, (p) => !isOut(p))) {
        outage.end();
        outageModel = cfg.metadataModel;
        out(`  the provider answers again after ${Math.round((Date.now() - down) / 1000)} s; polling resumes`);
      }
    } finally {
      await stamper?.providerWait?.(false);
    }
  }
  /** The start's refusal of what a probe found — a model unserved, or the endpoint refusing — or null. */
  function startRefusal(p: Probe, model: string, knob: string): string | null {
    if (p.state === "missing") {
      return `\n  ${cfg.chat.base} does not serve ${model}, ${knob}, at start (${p.why.slice(0, 300)}).\n` +
        `  A --follow worker refuses this before it claims anything (SMD-2599): pull the model, or set ${knob} to one the provider serves${knob === "OB1_EXTRACT_ESCALATE_MODEL" ? ", or unset it for the penalised retry" : ""}. Once running, a model that goes missing is waited for.`;
    }
    if (p.state === "refused") {
      return `\n  ${cfg.chat.base} refuses a one-token call at start (${p.why.slice(0, 300)}).\n` +
        "  A --follow worker refuses this before it claims anything (SMD-2599): check the chat endpoint's key (OB1_CHAT_API_KEY, else OB1_LLM_API_KEY) and its base URL (OB1_CHAT_BASE_URL, else OB1_LLM_BASE_URL — an OpenAI-compatible one ends in /v1).";
    }
    return null;
  }
  /**
   * The escalation model's refusal, or null. Asked at start only (review
   * pass 1: unasked, a missing one failed every runaway thought, where the
   * run had exited 2 naming it), and by GET /models, which loads nothing: a
   * one-token call to it loaded the larger model at every start and evicted
   * the model the first call needs (review pass 3). A provider whose list
   * does not answer, or is of another shape, refuses nothing here; the
   * model's first 404 is then the outage's, probing it by name.
   */
  async function escalationRefusal(wake?: AbortSignal): Promise<string | null> {
    if (!WINDOWING.escalateModel || wake?.aborted) return null;
    const listed = await modelListed(cfg.chat, WINDOWING.escalateModel, cfg.metadataModel, Math.min(TIMEOUT_S, 60) * 1000, wake);
    escalationSeen = listed === "listed";
    if (listed !== "unlisted") return null;
    return `\n  ${cfg.chat.base} does not serve ${WINDOWING.escalateModel}, OB1_EXTRACT_ESCALATE_MODEL, at start: GET /models does not list it.\n` +
      "  A --follow worker refuses this before it claims anything (SMD-2599): pull the model, set OB1_EXTRACT_ESCALATE_MODEL to one the provider serves, or unset it for the penalised retry. Once running, a model that goes missing is waited for.";
  }
  /** Why the provider did not answer at start, when it did not: waited for below, before the pool. */
  let startOut: string | null = null;
  if (FOLLOW && !STATUS_ONLY && !DRY_RUN) {
    if (stoppedEarly()) return 130;
    const first = await probe(undefined, opts.signal);
    const own = startRefusal(first, cfg.metadataModel, "OB1_METADATA_MODEL");
    if (own) return refused(probeRefusal(first), own);
    const escalation = first.state === "out" ? null : await escalationRefusal(opts.signal);
    if (escalation) return refused("model", escalation);
    if (first.state === "out") startOut = first.why;
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  /**
   * The same decision the server makes: MCP_ACCESS_KEYS says whether a key is
   * valid and what it is called and may do; resolve_agent says who it belongs to.
   * So the key must be in MCP_ACCESS_KEYS — a key the server would refuse is not
   * an identity here either — and the record's own name and scope are what get
   * registered, not a guessed label and a hardcoded 'write' that the server's
   * next request would flip back. Resolution writes (first sight registers, and
   * since 054 a stale last_used_at or a changed scope is written), so --status
   * and --dry-run do not resolve.
   */
  let agentId: string | null = null;
  /** The worker key's name, for the egress gate's `actor:` unit (SMD-1903); undefined without a key. */
  let actorName: string | undefined;
  if (!STATUS_ONLY && !DRY_RUN) {
    if (stoppedEarly()) return 130;
    // Without a key the URL is not read; with one, run() refused a missing URL.
    // A follower's lookup waits a database outage out, rather than writing its rows unattributed.
    // The agent line and the no-key warning are the banner's; a lookup that
    // could not resolve is warned of whatever the banner (SMD-2752).
    const id = await atStart(() => workerIdentity(opts.url ?? "", env, {
      noKeyWarning: opts.banner === false ? "" : "  ⚠  OB1_WORKER_KEY is not set: mentions and edges will carry no agent id. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.",
      write: say,
      warn: (l) => { if (l) err(l); },
      outage: FOLLOW ? lookupOutage : undefined,
    }));
    if (id === null) return stoppedWaiting();
    if (!id.ok) return refused("identity", id.message);
    agentId = id.identity.agentId;
    actorName = id.identity.keyName;
    // A key that was set but did not resolve to a name is no actor: the blanket
    // check above credited one, so it is asked again without (third review pass).
    // A lookup that did not name the key may name it next time (a database
    // refusing connections), so the refusal is `lookup`, not `egress` (SMD-2752).
    if (env.OB1_WORKER_KEY && id.identity.keyName === undefined) {
      const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
      if (again) return refused("lookup", `\n  ${regateMessage("extracted", again)}`);
    }
  }

  // ── Where the pass stands ───────────────────────────────────────────────────

  /**
   * A succeeded row extracted in part: 028's caveat rule, the caveat this
   * worker writes for it — over a prefix (SMD-2240), or with windows left out
   * as malformed (SMD-2260), or both. One predicate for the counts, the lists
   * and --retry-partial, so they cannot disagree about which rows are partial.
   */
  const partialRow = () => sql`status = 'succeeded' AND last_error IS NOT NULL AND starts_with(last_error, ${PARTIAL_CAVEAT_PREFIX})`;
  /**
   * Of the partial rows, those with windows left out as malformed — a row that
   * is also a prefix included, since a model or budget change is what retries
   * it — and those extracted over a prefix only: the two kinds, apart.
   */
  const leftOutRow = () => sql`${partialRow()} AND strpos(last_error, ${MALFORMED_WINDOWS_MARK}) > 0`;
  const prefixOnlyRow = () => sql`${partialRow()} AND strpos(last_error, ${MALFORMED_WINDOWS_MARK}) = 0`;

  /**
   * `partial` is a subset of `succeeded`: the rows extracted in part; `leftOut`
   * is the subset of those with windows left out as malformed, and `leftOutOver`
   * the subset of THOSE over the bound too — a retry reads them to the bound.
   */
  type Counts = { pending: number; claimed: number; succeeded: number; partial: number; leftOut: number; leftOutOver: number; failed: number; unpooled: number; thoughts: number };
  async function counts(): Promise<Counts> {
    const rows = (await sql`
      SELECT status, count(*)::int AS c, count(*) FILTER (WHERE ${partialRow()})::int AS partial, count(*) FILTER (WHERE ${leftOutRow()})::int AS left_out,
             count(*) FILTER (WHERE ${leftOutRow()} AND strpos(last_error, ${OVER_BOUND_MARK}) > 0)::int AS left_out_over
      FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number; partial: number; left_out: number; left_out_over: number }[];
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
    const partial = rows.reduce((n, r) => n + Number(r.partial), 0);
    const leftOut = rows.reduce((n, r) => n + Number(r.left_out), 0);
    const leftOutOver = rows.reduce((n, r) => n + Number(r.left_out_over), 0);
    const [{ unpooled, thoughts }] = await sql`
      SELECT count(*)::int AS thoughts,
             count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}))::int AS unpooled
      FROM thoughts t`;
    return { pending: by.pending ?? 0, claimed: by.claimed ?? 0, succeeded: by.succeeded ?? 0, partial, leftOut, leftOutOver, failed: by.failed ?? 0, unpooled: Number(unpooled), thoughts: Number(thoughts) };
  }

  /** The two kinds of partial row in words, a kind with no rows omitted, and how many of the second are over the bound too: "1 over a prefix only, 2 with windows left out as malformed, 1 of those also over the bound". */
  function partialKinds(partial: number, leftOut: number, leftOutOver = 0): string {
    return [
      partial - leftOut ? `${partial - leftOut} over a prefix only` : "",
      leftOut ? `${leftOut} with windows left out as malformed` : "",
      leftOutOver ? `${leftOutOver} of those also over the bound` : "",
    ].filter(Boolean).join(", ");
  }

  function printCounts(c: Counts, label: string): void {
    out(
      `  ${label}: ${c.thoughts} thoughts — ${c.succeeded} extracted${c.partial ? ` (${partialKinds(c.partial, c.leftOut, c.leftOutOver)})` : ""}, ${c.failed} failed, ` +
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
    out(
      `  graph: ${g.entities} entities (${byType.map((t) => `${t.c} ${t.entity_type}`).join(", ") || "none"}), ` +
        `${g.mentions} mentions across ${g.thoughts_with_entities} thoughts, ${g.edges} edges`
    );
  }

  async function printFailures(limit = 10): Promise<void> {
    const rows = (await sql`
      SELECT thought_id, attempt_count, last_error FROM thought_work_claims
      WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
      { thought_id: string; attempt_count: number; last_error: string | null }[];
    for (const r of rows) err(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
  }

  /** The rows extracted in part, each with its caveat, one list per kind — succeeded, so on stdout, not among the failures. */
  async function printPartials(c: Counts, limit = 10): Promise<void> {
    const prefixOnly = c.partial - c.leftOut;
    if (prefixOnly > 0) {
      const rows = (await sql`
        SELECT thought_id, last_error FROM thought_work_claims
        WHERE work_type = ${JOB} AND ${prefixOnlyRow()} ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; last_error: string }[];
      // Each caveat names the bound its row was read under; the bound in force may
      // already be wider, so the advice names it rather than saying "raise" (review pass 1).
      out(`  extracted over a prefix only (${Math.min(prefixOnly, limit)} of ${prefixOnly}) — the rest of each is not in the graph; --retry-partial re-extracts them over at most ${cfg.extractMaxWindows} windows (OB1_EXTRACT_MAX_WINDOWS${cfg.extractMaxWindowsFrom === "default" ? " unset" : ""}), more than a row read under a smaller bound got; raise it for more:`);
      for (const r of rows) out(`    ${r.thought_id}  ${r.last_error}`);
    }
    if (c.leftOut > 0) {
      const rows = (await sql`
        SELECT thought_id, last_error FROM thought_work_claims
        WHERE work_type = ${JOB} AND ${leftOutRow()} ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; last_error: string }[];
      // Closer to a failure than a prefix is: the bound decided a prefix, the
      // model's answers decided these (SMD-2260).
      // The model is the lever, and a changed OB1_METADATA_MODEL is another
      // key: --job keeps the retry on this pool's rows (review pass 2 — the
      // advice without it was refused, or with --switch-key found no rows).
      // --limit holds the larger model to these rows: the workers claim pending
      // rows by enqueued_at, and a returned row keeps its own, so a pending row
      // older than it is claimed in its place (review passes 3 and 4) — and a
      // worker of this pool running beside it takes returned rows as they land.
      const backlog = c.pending ? `; ${c.pending} pending row(s) of this pool may be claimed by that model in place of some of these — drain them first` : "";
      out(`  extracted with windows left out (${Math.min(c.leftOut, limit)} of ${c.leftOut}) — the model's answers for them were ${MALFORMED_WINDOWS_MARK}, and their text is not in the graph; --retry-left-out re-extracts them, and another model kept to this pool may be worth trying (OB1_METADATA_MODEL=<model> … --job ${JOB} --retry-left-out --limit ${c.leftOut}, no other worker of this pool running${backlog}); each over the bound is read to the bound in force, OB1_EXTRACT_MAX_WINDOWS (${cfg.extractMaxWindows}):`);
      for (const r of rows) out(`    ${r.thought_id}  ${r.last_error}`);
    }
  }

  /**
   * The thoughts with windows kept from a claim that did not finish, or with
   * stops counted (093, SMD-2694) — pending, in flight or failed, the newest
   * first, each row of the text and windowing in force (one of earlier text is
   * replaced at the next claim, review pass 1) — each with how many windows
   * are kept and how many stops took it, the latest of them in a row with
   * none gained, and how many of the sleep scheduler's own cuts (101,
   * SMD-3060; none before it). Nothing on a brain before 093, or under a role
   * that cannot read it.
   */
  async function printKept(limit = 10): Promise<void> {
    let rows: { thought_id: string; status: string; windows: number | null; kept: number; stops: number; stalled: number; cuts: number; total: number }[];
    try {
      // A brain before 101 has no cuts to read: none said. Probed as the read
      // below resolves the table, unqualified (review pass 3).
      const [{ cuts }] = (await sql`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('extraction_progress') AND attname = 'cuts' AND NOT attisdropped) AS cuts`) as { cuts: boolean }[];
      rows = (await sql`
        SELECT e.thought_id, c.status, e.windows, (SELECT count(*)::int FROM jsonb_object_keys(e.parts)) AS kept, e.stops, CASE WHEN e.gained > 0 THEN 0 ELSE e.stalled END AS stalled,
               ${cuts ? sql`e.cuts` : sql`0`} AS cuts, count(*) OVER ()::int AS total
          FROM extraction_progress e JOIN thought_work_claims c USING (thought_id, work_type) JOIN thoughts t ON t.id = e.thought_id
         WHERE e.work_type = ${JOB} AND c.status IN ('pending', 'claimed', 'failed') AND e.windowing = ${JSON.stringify(WINDOWING)}
           AND e.fingerprint = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))
         ORDER BY e.updated_at DESC LIMIT ${limit}`) as typeof rows;
    } catch (e) {
      const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
      if (code === "42P01" || code === "42501") return;
      throw e;
    }
    if (rows.length === 0) return;
    out(`  windows kept, or stops or the scheduler's cuts counted, on a claim that did not finish (${rows.length} of ${rows[0].total}) — the next claim of the same text sends only the windows still to do (SMD-2694):`);
    for (const r of rows) {
      const kept = r.kept ? `${r.kept}${r.windows ? ` of ${r.windows}` : ""} window(s) kept` : "no window kept";
      out(`    ${r.thought_id}  ${r.status}, ${kept}, ${r.stops} stop(s)${r.stalled ? `, the last ${r.stalled} with none gained` : ""}${r.cuts ? `, and ${r.cuts} cut(s) of the scheduler's own` : ""}`);
    }
  }

  const recorded = await atStart(async () => ({ key: ((await sql`SELECT value AS key FROM ob1_config WHERE key = 'entity_extraction_key'`) as { key: string }[])[0]?.key }));
  if (recorded === null) return stoppedWaiting();
  const recordedKey: string | undefined = recorded.key;
  if (recordedKey && recordedKey !== JOB) {
    say(`  ob1_config.entity_extraction_key is ${recordedKey}; this run uses ${JOB} — a different model or prompt version`);
    if (!SWITCH_KEY && !STATUS_ONLY && !DRY_RUN) {
      // The same gate reembed.ts has. record_thought_entities replaces a
      // thought's rows whatever key wrote them, so a run under another model —
      // a --limit trial with OB1_METADATA_MODEL changed in the shell — would
      // leave a per-thought mixture of two models' extractions and re-point the
      // trigger at the new key. Make the operator say so.
      return refused("key",
        `\n  Refusing to extract under a key other than the one ob1_config records without --switch-key.\n` +
          `  Every thought this run touches would carry ${JOB}'s extraction in place of ${recordedKey}'s, and new captures\n` +
          `  would enqueue under ${JOB}. If that is the intent, pass --switch-key and run the whole backlog; if\n` +
          `  OB1_METADATA_MODEL is simply set differently in this shell, fix it instead.`
      );
    }
  } else if (!recordedKey) {
    say(`  ob1_config.entity_extraction_key is not set: the trigger has enqueued nothing yet; ${CHECK ? "the first pass sets it" : "this run sets it"}`);
  }

  // The check ends here, before the pass's first write — the key's, a
  // --retry-*'s, the pool's; the worker key's lookup wrote, as at every start —
  // and without waiting for a provider that does not answer: each pass waits
  // for it at its own start (SMD-2752).
  if (CHECK) {
    if (startOut !== null) err(`  the provider is not answering at start (${startOut.slice(0, 200)}) — each pass waits for it at its own start`);
    opts.onStart?.({ ok: true, provider: startOut === null ? "up" : "out" });
    return 0;
  }

  if (STATUS_ONLY || DRY_RUN) {
    const c = await counts();
    printCounts(c, STATUS_ONLY ? "status" : "before");
    if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) out(describeHolder(h));
    await printGraph();
    if (c.partial > 0) await printPartials(c);
    if (c.failed > 0) {
      err(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
      await printFailures();
    }
    await printKept();
    if (DRY_RUN) {
      const todo = c.pending + c.unpooled + (RETRY_FAILED ? c.failed : 0) + (RETRY_PARTIAL ? c.partial : RETRY_LEFT_OUT ? c.leftOut : 0);
      out(
        `\n  would: ${recordedKey === JOB ? "" : `record ${JOB} in ob1_config so new captures enqueue; `}` +
          `${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
          `${RETRY_PARTIAL ? `return ${c.partial} row(s) extracted in part to the pool${c.partial ? ` (${partialKinds(c.partial, c.leftOut, c.leftOutOver)})` : ""}; ` : RETRY_LEFT_OUT ? `return ${c.leftOut} row(s) with windows left out to the pool${c.leftOut ? ` (${partialKinds(c.leftOut, c.leftOut, c.leftOutOver)})` : ""}; ` : ""}` +
          `add ${c.unpooled} thoughts to the pool; send ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) to ${cfg.metadataModel} ` +
          `with ${WORKERS} worker(s), ${TTL} s leases renewed every ${HEARTBEAT} s. Nothing was written.`
      );
    }
    return 0;
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  if (startOut !== null) {
    // Before the CLI installs its handlers a signal ends the process; a caller's signal ends the wait.
    const wake = opts.signal ?? new AbortController().signal;
    const down = Date.now();
    err(`  the provider is not answering at start (${startOut.slice(0, 200)}) — the follower claims nothing until it does; it calls ${cfg.metadataModel} at ${cfg.chat.base} for one token after ${OUTAGE_MS.first / 1000} s and then twice as long each time, up to ${OUTAGE_MS.max / 60_000} min`);
    // Said through a caller's stamper while it lasts — the sleep scheduler's,
    // so heartbeat:sleep and preflight's row say a pass waits at its start for
    // the provider, not that its passes run (SMD-2752).
    await opts.stamper?.startWait?.(true);
    const answered = await probeUntil(() => probe(undefined, wake), wake, (p) => p.state !== "out").finally(() => opts.stamper?.startWait?.(false));
    if (answered) {
      const own = startRefusal(answered, cfg.metadataModel, "OB1_METADATA_MODEL");
      if (own) return refused(probeRefusal(answered), own);
      const escalation = await escalationRefusal(wake);
      if (escalation) return refused("model", escalation);
      out(`  the provider answers after ${Math.round((Date.now() - down) / 1000)} s`);
    }
  }
  if (stoppedEarly()) return 130;
  if (recordedKey !== JOB) {
    const set = await atStart(() => sql`
      INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', ${JOB})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    if (set === null) return stoppedWaiting();
    out(`  ob1_config.entity_extraction_key = ${JOB} — new and edited thoughts now enqueue for extraction`);
  }

  /** Rows a --retry-* flag returned to the pool: the run's first judgement is of rows chosen for failing (SMD-2266, review pass 2). */
  let returned = 0;
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
    returned += n;
    out(`  --retry-failed: ${n} failed row(s) returned to the pool`);
  }

  if (stoppedEarly()) return 130;
  if (RETRY_PARTIAL || RETRY_LEFT_OUT) {
    // --retry-failed's statement over the partial rows — every one, or those
    // with windows left out: pending, the caveat cleared, so the row is
    // extracted afresh under the bound and the model in force now, and the new
    // reading replaces the old one's rows (record_thought_entities). Each row's
    // kinds are read before the caveat is cleared, so the message can say what
    // each gets — a row of both kinds is a prefix too (review pass 1).
    const [{ n, left_out: leftOut, left_out_over: both }] = await sql`
      WITH old AS (
        SELECT thought_id, strpos(last_error, ${MALFORMED_WINDOWS_MARK}) > 0 AS left_out, strpos(last_error, ${OVER_BOUND_MARK}) > 0 AS over FROM thought_work_claims
        WHERE work_type = ${JOB} AND ${RETRY_PARTIAL ? partialRow() : leftOutRow()} FOR UPDATE),
      retried AS (
        UPDATE thought_work_claims w SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
        FROM old WHERE w.work_type = ${JOB} AND w.thought_id = old.thought_id RETURNING old.left_out, old.over)
      SELECT count(*)::int AS n, count(*) FILTER (WHERE left_out)::int AS left_out, count(*) FILTER (WHERE left_out AND over)::int AS left_out_over FROM retried`;
    // A prefix is read afresh under the bound in force, which may be smaller
    // than the one it was read under: say both directions (review pass 1).
    // Counted, not inferred: a prefix-only row is every partial row without the
    // malformed mark, and a row of both carries both marks (review pass 2).
    const prefix = n - leftOut + both > 0 ? `; a prefix is extracted over at most ${cfg.extractMaxWindows} window(s) (OB1_EXTRACT_MAX_WINDOWS${cfg.extractMaxWindowsFrom === "default" ? " unset" : ""}) — a row read under a smaller bound gains coverage, one read under this bound is read to the same place again, and one read under a larger bound keeps less than it had` : "";
    // A fresh reading can fail outright — a window timing out, or none parsing —
    // and a failure writes nothing, so the row is failed while the earlier
    // reading's rows stay in the graph (review pass 3).
    const again = leftOut > 0 ? `; a row with windows left out is sent again to ${cfg.metadataModel}, and a window it answers malformed again is left out again` : "";
    // Any row, a prefix too: a failure writes nothing (review pass 4).
    const fails = n > 0 ? `; a reading that fails (a window timing out, or none parsing) records its row failed, the earlier reading's entities left in the graph until a later one succeeds` : "";
    returned += n;
    const what = RETRY_PARTIAL ? `--retry-partial: ${n} row(s) extracted in part` : `--retry-left-out: ${n} row(s) with windows left out`;
    out(`  ${what} returned to the pool${n ? ` (${partialKinds(n, leftOut, both)})` : ""}${prefix}${again}${fails}`);
  }

  let stopping = false;
  /**
   * Set by the hard stop, which has returned every worker's leases: a worker
   * writes and releases nothing more — the thought in hand is the pool's
   * again, and may already be another worker's (review pass 1).
   */
  let hardStopped = false;
  /** The hard stop's release, returned again to a second hard call. */
  let hardRelease: Promise<unknown> | null = null;
  /**
   * Aborted by the first stop (the hard stop finds it aborted, or aborts it):
   * a follower's sleep and a transient pause wake on it, so neither holds
   * run() — nor sends the thought again on a stopping pass (review pass 2,
   * SMD-2401) — through db/lease.ts's sleepUnless, which keeps nothing per
   * sleep (pass 3).
   */
  const onStop = new AbortController();
  /** Aborted by the hard stop: the model call in hand, and any window or retry after it (SMD-1794). */
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
  /** Of `done`, the thoughts extracted over a prefix only (SMD-2240), and those with windows left out as malformed, a prefix of one included, with how many windows (SMD-2260). */
  let partial = 0;
  let leftOut = 0;
  let leftOutWindows = 0;
  let failed = 0;
  /** Workers that began or joined a provider outage — the heartbeat's "failed" (SMD-2261): the provider, not a document. */
  let providerStops = 0;
  /** Whether the last pass found nothing to do: its stamp keeps the word before it. */
  let lastPassIdle = false;
  let vanished = 0;
  let superseded = 0;
  let lost = 0;
  let beats = 0;
  let malformed = 0;
  let llmMs = 0;
  /** Thoughts extracted in more than one window, thoughts a runaway call was retried for, and model calls made in all (SMD-1879). */
  let windowed = 0;
  let retried = 0;
  /** Thoughts a runaway was escalated to OB1_EXTRACT_ESCALATE_MODEL for, rather than retried under the penalty (SMD-2000). */
  let escalated = 0;
  /** Thoughts a runaway was aborted on the stream for, before its budget (SMD-1960). */
  let aborted = 0;
  let calls = 0;
  /**
   * The answers the model gave this run — one a window sent, a one-window
   * thought's one — and how many were not JSON of the expected shape, in a
   * thought failed as malformed or left out of a partial one: the run's signal
   * that the model, not the documents, is at fault (SMD-2266, malformedAlarm).
   */
  let answers = 0;
  let answersMalformed = 0;
  /**
   * The answers judged so far, and how many judgements tripped. A run that
   * exits is judged once, at its end; a follower judges its answers in blocks of
   * at least EXTRACT_MALFORMED_ALARM_MIN after each poll, so it says so while it
   * runs — a stopped follower exits 0 — and a breakage that starts late is not
   * diluted by the good polls before it (review pass 1).
   */
  const judged = { answers: 0, malformed: 0, escalated: 0 };
  let alarms = 0;
  const totals = { entities: 0, newEntities: 0, mentions: 0, edges: 0, dropped: 0, ambiguous: 0, refused: 0, retyped: 0, gated: false };
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
        `${totals.entities} entity mentions, ${totals.edges} edges` +
        (failed ? `  ${failed} failed` : "") +
        (eta !== null ? `  ~${eta}s left` : "")
    );
  }

  type Row = { id: string; content: string; fingerprint: string | null; metadata: Record<string, unknown> | null };
  type Outcome =
    /** `caveat` is set for a thought extracted in part: 028's caveat, released on the succeeded row (SMD-2240); `leftOut`, how many of its windows were left out as malformed (SMD-2260). */
    | { outcome: "succeeded"; caveat?: string; leftOut?: number }
    | { outcome: "failed"; error: string }
    | { outcome: "vanished" }
    /** Edited while it was being extracted; the trigger has already re-queued it and the pool will redo it. */
    | { outcome: "superseded" }
    /** In hand at the hard stop: nothing written, and no longer this worker's to release. */
    | { outcome: "abandoned" }
    /** Requeued or reaped while its worker waited at the admit gate: nothing more sent, and not this worker's to release (review pass 4). */
    | { outcome: "lost" };

  /**
   * A long thought's answered windows, kept across a claim that does not
   * finish (migration 093, SMD-2694): a hard stop — the sleep scheduler's
   * wake, the operator's second signal — no longer throws them away, so the
   * next claim of the same text sends only the windows still to do, and the
   * stop is counted on the row. A courtesy, as the scheduler's tail move is: a
   * brain before 093, or a role without the extraction group's grant on it,
   * keeps nothing and says so once; another error is said once, and the
   * thought goes on unkept.
   */
  const WINDOWING_SIG = JSON.stringify(WINDOWING);
  let keeping = true;
  /** Each kind said once: a passing error first does not hide the one that ends keeping (review pass 1). */
  const saidKeeping = { passing: false, ended: false };
  const keepingFailed = (e: unknown, what: string): void => {
    const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
    // The table or a function missing, or the grant: no later write would land.
    const ends = code === "42P01" || code === "42883" || code === "42501";
    if (ends) keeping = false;
    const kind = ends ? "ended" : "passing";
    if (saidKeeping[kind]) return;
    saidKeeping[kind] = true;
    errAside(`  could not ${what} a long thought's kept windows (${(e as Error).message}) — ${ends ? "no window is kept across a stop this run: that needs migration 093 and the extraction group's grant on extraction_progress, which a running follower takes up once restarted" : "the thought goes on, its windows unkept"}`);
  };
  const hashOf = (sent: string): string => createHash("sha256").update(sent).digest("hex").slice(0, 32);
  /**
   * The thought each worker has in hand, for the hard stop's count (noteStop):
   * set while processRow runs, with when it was taken up — moved on past a
   * provider pause, which is the provider's time and not the window's
   * (review pass 3) — which says whether the stop was long. A wait at the
   * admit gate moves it on too, and `pausedAt` marks one in progress, so a
   * hard stop during it counts up to the wait (SMD-3379 PR 1b-1).
   */
  const inHand = new Map<string, { id: string; fingerprint: string; since: number; pausedAt?: number }>();
  const STALL_FLOOR = opts.stallFloorMs ?? STALL_FLOOR_MS;
  /**
   * The hard stop's count for each worker, which the worker's own release
   * waits for: the stop aborts the call in hand, and the worker unwinding to
   * its finally released the claim first on another connection, so the count
   * found it no longer held (review pass 1 — 26 of 40 stops lost at four
   * workers, and every one with an idle second worker, the scheduler's shape).
   */
  const stopNotes = new Map<string, Promise<void>>();

  /** The windows an earlier claim of this text kept, and where this claim keeps its own: none for a thought with no fingerprint. */
  async function progressFor(row: Row, workerId: string): Promise<ExtractProgress | undefined> {
    if (!keeping || row.fingerprint === null) return undefined;
    const fingerprint = row.fingerprint;
    type Kept = ExtractionWindow & { h?: string };
    const kept = new Map<number, Kept>();
    try {
      const [r] = (await sql`SELECT fingerprint, windowing, parts FROM extraction_progress WHERE thought_id = ${row.id}::uuid AND work_type = ${JOB}`) as { fingerprint: string; windowing: string; parts: Record<string, Kept> }[];
      // Windows of other text, or that fell under another windowing, are of no use: the first save replaces them.
      if (r && r.fingerprint === fingerprint && r.windowing === WINDOWING_SIG) for (const [k, v] of Object.entries(r.parts)) kept.set(Number(k), v);
    } catch (e) {
      keepingFailed(e, "read");
      if (!keeping) return undefined;
    }
    return {
      // The first stop: a windowed thought ends at its next window, not its last (review pass 5).
      between: onStop.signal,
      kept(index, sent) {
        const p = kept.get(index);
        if (!p || p.h !== hashOf(sent)) return undefined;
        // An answer of another shape — kept before a change to what a window
        // returns — is asked again rather than merged (review pass 1). The
        // containers only: an element of another shape still reaches the
        // merge, which a changed prompt's new request hash usually prevents.
        if (!Array.isArray(p.entities) || !Array.isArray(p.relations) || p.rejected === null || typeof p.rejected !== "object") return undefined;
        const { h: _h, ...part } = p;
        return part;
      },
      async save(part, sent, windows) {
        // Past the hard stop too: a window saved before the stop's release
        // lands is kept, and the function keeps nothing after (review pass 1
        // — a window answered as the stop came was dropped).
        if (!keeping) return;
        try {
          await sql`SELECT save_extraction_window(${row.id}::uuid, ${JOB}, ${workerId}, ${fingerprint}, ${WINDOWING_SIG}, ${windows}::int, ${part.index}::int, ${{ ...part, h: hashOf(sent) }}::jsonb)`;
        } catch (e) {
          keepingFailed(e, "keep");
        }
      },
    };
  }

  /** The hard stop's count on the thought a worker has in hand (093's note_extraction_stop), before its lease goes back: the function counts only for the holder. */
  async function noteStop(workerId: string): Promise<void> {
    const t = inHand.get(workerId);
    if (!t || !keeping) return;
    // Long: held at least the floor. Not the thought's slowest window, which
    // took a kept 280 s window's document out of the stall for good (review
    // pass 3).
    // Up to a wait at the admit gate it is in, which is not the thought's time
    // held: the hard stop reads it before the wait has ended (review pass 1).
    const long = (t.pausedAt ?? Date.now()) - t.since >= STALL_FLOOR;
    try {
      await sql`SELECT note_extraction_stop(${t.id}::uuid, ${JOB}, ${workerId}, ${t.fingerprint}, ${WINDOWING_SIG}, ${long})`;
    } catch (e) {
      keepingFailed(e, "count the stop of");
    }
  }

  /** Whether the scheduler's cuts are counted: not on a brain before 101, said once a run — each set-aside's run its own — the windows still kept. */
  let cutting = true;
  /** The sleep scheduler's own cut of the thought in hand (101's note_extraction_cut), counted apart from its stops: no wake, so it stalls nothing. */
  async function noteCut(workerId: string): Promise<void> {
    const t = inHand.get(workerId);
    if (!t || !keeping || !cutting) return;
    try {
      await sql`SELECT note_extraction_cut(${t.id}::uuid, ${JOB}, ${workerId}, ${t.fingerprint}, ${WINDOWING_SIG})`;
    } catch (e) {
      const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
      if (code !== "42883") return keepingFailed(e, "count the scheduler's cut of");
      // Never counted as a stop instead: that is the count it would inflate.
      // Read after the call: every worker in hand tries at once (run-it review).
      if (!cutting) return;
      cutting = false;
      errAside(`  could not count the scheduler's cut of a long thought (${(e as Error).message}) — its cuts go uncounted this run, its stops and kept windows as before: that needs migration 101, which the scheduler's next extraction run takes up, and its held word once the scheduler is restarted`);
    }
  }

  /**
   * The thought's own subject by the rules (SMD-3306), recorded once its
   * entities are: the ticket it is filed under, else a session summary's
   * header ticket its prompts name (subject.ts's ruleSubject), each under its
   * rule's key, at the text the claim read; record_thought_subject refuses a
   * text that moved since. No model is asked here: a thought no rule keys is
   * --subjects' (db/subject-sweep.ts). A courtesy, as the kept windows are: a
   * brain before 111, or a role without its door's grants, records none and
   * says so once; another error is said once, and the thought's entities stand.
   */
  let subjecting = true;
  const subjects = { recorded: 0, kept: 0 };
  const saidSubject = { passing: false };
  async function recordRuleSubject(row: Row): Promise<void> {
    if (!subjecting || hardStopped || row.fingerprint === null) return;
    const found = ruleSubject(row);
    if (!found) return;
    try {
      const w = await recordSubject(sql, { id: row.id, fingerprint: row.fingerprint }, found.key, found.by, subjectRuleKey(found.by), subjectRecipe(found), agentId);
      if (w.action === "added" || w.action === "replaced") subjects.recorded++;
      else if (w.action === "kept") subjects.kept++;
    } catch (e) {
      const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
      if (code === "42883" || code === "42501" || code === "42P01") {
        // Read after the call: every worker in hand may try at once.
        if (!subjecting) return;
        subjecting = false;
        errAside(`  could not record a thought's own subject (${(e as Error).message}) — no subject is recorded with this run's entities: that needs migration 111, and for a role of its own ${DOOR_GRANTS}; a running follower takes it up once restarted`);
        return;
      }
      if (saidSubject.passing) return;
      saidSubject.passing = true;
      errAside(`  could not record a thought's own subject (${(e as Error).message}) — the thought's entities stand, and --subjects records its subject later`);
    }
  }

  async function processRow(row: Row, workerId: string): Promise<Outcome> {
    const t0 = Date.now();
    // The admit gate between windows (SMD-3379 PR 1b): its wait is neither
    // the model's time nor the thought's held, and a stop while it waits ends
    // the thought there as a first stop does, its windows kept.
    let paused = 0;
    const admitWindow = ADMIT ? async (): Promise<void> => {
      const at = Date.now();
      const held = inHand.get(workerId);
      if (held) held.pausedAt = at;
      let through: false | "open" | "waited" = false;
      try {
        through = await admitted(ADMIT, gate);
      } catch (e) {
        throw new AdmitThrow(e);
      } finally {
        const waited = Date.now() - at;
        paused += waited;
        if (held) {
          held.since += waited;
          held.pausedAt = undefined;
        }
      }
      if (!through) throw new StoppedBetweenWindows();
      // After the gate held it the claim is read again: the live write that
      // closed the gate may be a delete or an edit of this thought, whose text
      // must not go to the provider after it (review passes 3 and 4). A read
      // that fails goes on, as before.
      if (through === "waited") {
        const claim = await claimAfterWait(sql, JOB, workerId, row.id, row.fingerprint, true).catch(() => "ours" as const);
        if (claim !== "ours") throw new ClaimGoneAtGate(claim);
      }
    } : undefined;
    let extraction: Extraction;
    try {
      const progress = await progressFor(row, workerId);
      // The row's own metadata is what the gate reads (SMD-1903); a refusal
      // throws out of here as a failed claim naming the rule. The timeout is per
      // call — per window of a long thought (SMD-1879).
      extraction = await extractEntities(row.content, cfg, TIMEOUT_S * 1000, { kind: "extraction", actor: actorName, metadata: row.metadata ?? undefined }, undefined, onHardStop.signal, progress, admitWindow);
    } finally {
      llmMs += Date.now() - t0 - paused;
    }
    // Every call the thought cost: one per window, and one more per window
    // that was retried (first review pass: the retries went uncounted) — a
    // window kept from an earlier claim cost none in this one (SMD-2694).
    calls += callsOf(extraction);
    // The windows this claim sent, the kept ones out: their answers, retries
    // and aborts were counted by the claim that made them.
    const sent = extraction.parts?.filter((p) => !p.resumed);
    // Every answer counts, whatever the write then does: the signal is the
    // model's, not the rows'. A malformed window is never kept, so every
    // malformed answer is this claim's.
    answers += sent ? sent.length : extraction.windows;
    answersMalformed += extraction.malformed ? extraction.windows : extraction.coverage?.malformed?.length ?? 0;
    // A per-window record, not a count over one: a prefix of one window of a
    // longer thought is windowed — sent "Part 1 of N" (review pass 2).
    if (extraction.parts) windowed++;
    // A runaway escalated to the larger model is counted as an escalation, not a
    // penalised retry, though it is both a runaway and a second call (SMD-2000).
    if (sent ? sent.some((p) => p.escalated) : extraction.escalated) escalated++;
    else if (sent ? sent.some((p) => p.retried) : extraction.retried) retried++;
    if (sent ? sent.some((p) => p.abortedMs !== undefined) : extraction.abortedMs !== undefined) aborted++;
    if (hardStopped) return { outcome: "abandoned" };
    if (extraction.malformed) {
      malformed++;
      const where = extraction.parts ? ` (window ${windowList(extraction.parts.filter((p) => p.malformed).map((p) => p.index))} of ${extraction.windows}${extraction.coverage ? ` sent, a prefix of ${extraction.coverage.of}` : ""})` : "";
      return { outcome: "failed", error: `the model's answer was not JSON of the expected shape${where}${abortedNote(extraction)}` };
    }
    if (DUMP) {
      // The model's answer as parsed, before the database applies the rule —
      // what a replay needs to re-score a rule change without the model — and,
      // for a windowed thought, each window's own answer beside the merged one:
      // the derivation record (SMD-1731) until a lineage table holds it.
      // `escalated: <model>` where a runaway went to the larger model, `retried:
      // true` where it took the penalised same-model retry — the derivation
      // record of which model produced the answer (SMD-2000), the pass key on the
      // row itself staying the first model's.
      appendFileSync(DUMP, JSON.stringify({ id: row.id, fingerprint: row.fingerprint, key: JOB, entities: extraction.entities, relations: extraction.relations, windows: extraction.windows, ...(extraction.escalated ? { escalated: extraction.escalated } : extraction.retried ? { retried: true } : {}), ...(extraction.abortedMs !== undefined ? { abortedMs: extraction.abortedMs, ...(extraction.abortedBy ? { abortedBy: extraction.abortedBy } : {}) } : {}), ...(extraction.coverage ? { coverage: extraction.coverage } : {}), ...(extraction.parts ? { parts: extraction.parts } : {}) }) + "\n");
    }
    // SMD-2321: the hybrid mode re-types the 7B's entities with the decider —
    // identifier shapes carved by rule, the rest validity-gated and typed, p_true
    // the confidence. After the dump above, so the dump keeps the raw generative
    // answer for replay; a decider outage falls back to the 7B's entities inside
    // decideEntities. The row's metadata is the egress subject, as extraction's.
    if (jevCfg && extraction.entities.length) {
      const decided = await decideEntities(row.content, extraction.entities, jevCfg, { kind: "extraction", actor: actorName, metadata: row.metadata ?? undefined });
      extraction = { ...extraction, entities: decided.entities };
    }
    if (hardStopped) return { outcome: "abandoned" };
    // 061: the pass's recipe — the model, the prompt's version and hash, the
    // windows sent and what was cut — recorded in `derivations` with the rows,
    // beside the input's fingerprint the function checks and now stores
    // (SMD-1731); the per-window answers stay in the dump above.
    const [r] = await sql`
      SELECT record_thought_entities(
        ${row.id}::uuid, ${JOB}::text,
        ${extraction.entities}::jsonb, ${extraction.relations}::jsonb,
        ${row.fingerprint}::text, ${agentId}::uuid,
        ${entityRecipe(cfg, extraction)}::jsonb
      ) AS r`;
    const res = r.r as { ok: boolean; stale?: boolean; error?: string; entities?: number; new_entities?: number; mentions?: number; edges?: number; dropped_relations?: number; ambiguous_relations?: number; refused_entities?: number; retyped_entities?: number };
    if (res.ok) {
      totals.entities += res.mentions ?? 0;
      totals.newEntities += res.new_entities ?? 0;
      totals.mentions += res.mentions ?? 0;
      totals.edges += res.edges ?? 0;
      totals.dropped += res.dropped_relations ?? 0;
      totals.ambiguous += res.ambiguous_relations ?? 0;
      // A brain before 056 returns no gate counts: say nothing rather than a gate's zeros (third review pass).
      if (res.refused_entities !== undefined) totals.gated = true;
      totals.refused += res.refused_entities ?? 0;
      totals.retyped += res.retyped_entities ?? 0;
      await recordRuleSubject(row);
      // A prefix's rows stand, and the claim says they are a prefix (SMD-2240);
      // so do the parsed windows' rows, the claim naming those left out (SMD-2260).
      const c = extraction.coverage;
      return c ? { outcome: "succeeded", caveat: partialCaveat(c, WINDOWING), ...(c.malformed ? { leftOut: c.malformed.length } : {}) } : { outcome: "succeeded" };
    }
    if (res.error === "NOT_FOUND") return { outcome: "vanished" };
    // Edited between the claim and the write. What was extracted describes text
    // that is no longer there, so re-extracting it here would be a second model
    // call for work the pool should do. The trigger has usually re-queued the
    // thought already — but only under the key ob1_config records, and only if
    // that key is set, so re-queue under THIS job explicitly (idempotent) rather
    // than leave a lease held on a promise.
    if (res.stale) {
      // Past the hard stop the row may be another worker's: 016's requeue would
      // take it from its holder (review pass 2).
      if (hardStopped) return { outcome: "abandoned" };
      await sql`SELECT requeue_thought_work(${JOB}, ${row.id}::uuid)`;
      return { outcome: "superseded" };
    }
    return { outcome: "failed", error: `record_thought_entities: ${res.error}` };
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
   * the host's unhandled error: it is dropped there (review pass 1).
   */
  const errAside = (line: string): void => {
    try {
      err(line);
    } catch {
      // Nothing awaits this line.
    }
  };

  async function worker(n: number): Promise<void> {
    const workerId = `extract-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
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
            SELECT id, content, COALESCE(content_fingerprint, content_fingerprint_of(content)) AS fingerprint, metadata
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
            if (row.fingerprint !== null) inHand.set(workerId, { id: row.id, fingerprint: row.fingerprint, since: Date.now() });
            for (let attempt = 0; outcome === null; attempt++) {
              try {
                outcome = await processRow(row, workerId);
              } catch (e) {
                // The calls a thrown thought made — its fourth window timing out
                // is four calls — count too (second review pass).
                calls += callsMadeBy(e);
                // The admit gate's own error, not the thought's: the pass ends with it.
                if (e instanceof AdmitThrow) throw e.error;
                // The hard stop aborted the call: the thought is abandoned, not failed.
                if (hardStopped) return;
                // A first stop ended it between windows, those answered kept: it
                // goes back to the pool with the leases the finally returns, its
                // attempt refunded, no stop counted (review pass 5).
                if (e instanceof StoppedBetweenWindows) return;
                // Deleted or edited while the worker waited at the gate: not ours to finish (review pass 3).
                if (e instanceof ClaimGoneAtGate) {
                  if (hardStopped) return;
                  // Still ours, its text moved under a key nothing requeues: back to the
                  // pool for the new text, as a stale write is; if that fails, the finally
                  // returns it with this worker's leases (review pass 4).
                  if (e.claim === "moved" && !(await sql`SELECT requeue_thought_work(${JOB}, ${b.thought_id}::uuid)`.then(() => true, () => false))) return;
                  outcome = e.claim === "deleted" ? { outcome: "vanished" } : e.claim === "moved" ? { outcome: "superseded" } : { outcome: "lost" };
                  continue;
                }
                // The database went away under the write: not the thought's, so
                // nothing is recorded; the worker ends, and the follower waits
                // for the database before its next pass (SMD-2599).
                if (FOLLOW && databaseUnavailable(e)) {
                  err(`  ${workerId}: the database is not answering (${(e as Error).message}) — this worker stops, recording nothing for ${b.thought_id}`);
                  return;
                }
                const kind = classifyError(e, { maxTokensFatal: true });
                const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
                // Under --follow, the provider's state rather than the thought's
                // or the request's (SMD-2599): a transient error past the pauses,
                // the model missing (Ollama pulling it; the start probe saw it
                // answer), or a timeout the probe cannot get an answer past
                // either — given the call's whole timeout, as a model busy with
                // another worker's call may need it, and ended by a stop or
                // another worker's outage, which it joins unprobed (review pass 1).
                const escalationGone = !!WINDOWING.escalateModel && missingModelIs(e, WINDOWING.escalateModel) && !missingModelIs(e, cfg.metadataModel);
                const down = FOLLOW && (
                  (kind === "transient" && attempt >= TRANSIENT_PAUSES_MS.length) ||
                  (kind === "fatal" && modelMissing(e) && (!escalationGone || escalationSeen)) ||
                  (kind === "thought" && timedOut(e) && !stopping && (outage.reason !== null || isOut(await probe(TIMEOUT_S * 1000, halt.signal)))));
                if (down) {
                  // On a stopping pass the thought goes back to the pool, as a transient's does.
                  if (stopping) return;
                  const begins = outage.reason === null;
                  if (outage.begin(msg, b.thought_id) === "outage") {
                    providerStops++;
                    // The escalation model gone since the start: the outage probes it (review pass 2).
                    if (begins && escalationGone && WINDOWING.escalateModel) outageModel = WINDOWING.escalateModel;
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
                  // Every thought would fail the same way. Stop everyone, mark
                  // nothing, and say what to fix; this row goes back with the
                  // leases the finally returns.
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
                  // The pause was the provider's: the thought's clock starts again (review pass 3).
                  const paused = inHand.get(workerId);
                  if (paused) paused.since = Date.now();
                  if (stopping || outage.reason !== null) return;
                } else {
                  // Still failing after the pauses. This row is recorded failed
                  // with the error — if the provider is down it is one row per
                  // worker, and if this thought is what draws the error every
                  // time it is now visible instead of cycling for ever — and the
                  // worker stops, its other leases going back to the pool.
                  outcome = { outcome: "failed", error: `provider error after ${attempt} retries: ${msg}` };
                  stopAfter = true;
                }
              }
            }
            // Its extraction is over: a stop from here on took no window from it.
            inHand.delete(workerId);
            if (hardStopped) return;
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
            err(`  ${b.thought_id}: no longer this worker's after it waited at the admit gate — requeued or reaped; nothing more of it was sent`);
            continue;
          }
          if (outcome.outcome === "superseded") {
            // The claim is already pending again with no holder — the trigger
            // did that — so there is nothing to release.
            superseded++;
            err(`  ${b.thought_id}: edited while it was being extracted; it is pending again and will be extracted from the new text`);
            continue;
          }
          let ok: boolean;
          let gone = false;
          try {
            const release = () => sql`SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                     ${outcome.outcome}, ${outcome.outcome === "failed" ? outcome.error : outcome.caveat ?? null}) AS ok`;
            // A succeeded release spends the thought's kept windows (093), in
            // the same statement: a delete after it, failed or cut short by an
            // exit, left the row's stops beside a finished claim, which a later
            // requeue of the same text revived (review pass 2). Of any text: a
            // release that went through proves the claim still this worker's,
            // and a row of earlier text kept would revive as well on a revert
            // (review pass 4). A failed release keeps them, so --retry-failed resumes.
            const spend = keeping && outcome.outcome === "succeeded";
            if (spend) {
              try {
                [{ ok }] = await sql`
                  WITH r AS (${release()}),
                       d AS (DELETE FROM extraction_progress WHERE thought_id = ${b.thought_id}::uuid AND work_type = ${JOB} AND (SELECT ok FROM r))
                  SELECT ok FROM r`;
              } catch (e) {
                // The table or its grant gone since the start: the release alone, said once.
                const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
                // Only 093's table's: a refusal on the claims themselves is the release's own (review pass 3).
                if ((code !== "42P01" && code !== "42501") || !/extraction_progress/.test((e as Error).message)) throw e;
                keepingFailed(e, "clear");
                [{ ok }] = await release();
              }
            } else {
              [{ ok }] = await release();
            }
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
            err(`  ${b.thought_id}: deleted while it was being extracted`);
            continue;
          }
          if (!ok) {
            // The hard stop's release beat this one to the row: not a lapse to
            // report, the caller's own stop; a release that went through first
            // is counted below as any is — as reembed's (SMD-2425).
            if (hardStopped) return;
            // Either the lease expired, or the content was edited and migration
            // 016's trigger put the row back in the pool to be extracted from the
            // new text. Not ours to finish either way: counted with the rows this
            // worker lost, not the ones it finished.
            err(`  ${b.thought_id}: the claim was no longer this worker's at release — an edit requeued it, its lease lapsed (no beat reached the database for ${TTL} s), or it was returned by hand with release_claims_for_worker; the row is the pool's or another worker's now`);
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
            if (outcome.leftOut) { leftOut++; leftOutWindows += outcome.leftOut; } else if (outcome.caveat) partial++;
          }
          outage.settled(b.thought_id);
          progress();
        }
      }
    } finally {
      inHand.delete(workerId);
      hb.stop();
      beats += hb.beats;
      // Rows still held are handed back unfinished: out of --limit's count
      // before the release goes out, so another worker's claim of one counts it.
      for (const id of hb.held) taken.delete(id);
      let freed = 0;
      // The hard stop's count first, while the claim is still this worker's.
      await stopNotes.get(workerId);
      try {
        [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      } catch (e) {
        // A follower returns them once the database answers again (SMD-2599).
        if (FOLLOW) unreturned.add(workerId);
        err(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s${FOLLOW ? ", or return when the database answers again" : ""}`);
      }
      activeWorkers.delete(workerId);
      // Outside the release's try: a Writer's throw here is the Writer's, not a
      // lease left unreturned (review pass 2).
      if (freed > 0 && !FOLLOW) err(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    }
  }

  // The pass's stop (db/lease.ts's PassStop), handed to the caller here, where
  // the script installed its signal handlers — before this a signal ends the
  // CLI at once. One while already stopping — a second, or the first after the
  // provider's refusal stopped the workers — is the hard stop: the release of
  // every worker's leases, the CLI exiting 130 when it settles.
  const stop: PassStop = (how) => {
    // After the run has returned there is no pass to stop (review pass 1).
    if (detach.aborted) return null;
    if (stopping) {
      // Once: a second hard call — a wake and the operator's signal on one
      // pass — counted the stop again (review pass 2).
      if (hardRelease) return hardRelease;
      hardStopped = true;
      onStop.abort();
      onHardStop.abort();
      halt.abort();
      // Started before the line is written: a Writer that throws does not keep
      // the leases. Each thought in hand has its stop counted first, while its
      // claim is still the worker's (093, SMD-2694) — the scheduler's own cut
      // as a cut, apart from its stops (101, SMD-3060).
      const note = how?.cut ? noteCut : noteStop;
      const release = Promise.all([...activeWorkers].map((w) => {
        // Bounded: a count waiting on a lock held the release past the CLI's
        // exit, and the lease for its whole TTL (review pass 2).
        const noted = Promise.race([note(w), unrefSleep(STOP_NOTE_WAIT_MS)]);
        stopNotes.set(w, noted);
        return noted.then(() => sql`SELECT release_claims_for_worker(${JOB}, ${w})`).catch(() => null);
      }));
      hardRelease = release;
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
   * The alarm's lines for the answers since the last judgement, when there are
   * at least EXTRACT_MALFORMED_ALARM_MIN of them and more than the share were
   * malformed (SMD-2266, db/config.mjs's malformedAlarm): the verdict, then what
   * to check and retry. Undefined otherwise. Either way they are judged, and the
   * next judgement starts after them. The first judgement of a run that returned
   * rows for failing (--retry-*) is of documents chosen for it, so it is not told
   * they are not at fault, and a follower's later blocks, new captures, are
   * (review passes 1 and 2). The models named are those that answered the
   * block, the escalation's when it took a runaway (SMD-2000); the retries named
   * are for the kinds of row the run left.
   */
  function judge(): string | undefined {
    const n = answers - judged.answers;
    const bad = answersMalformed - judged.malformed;
    if (n < EXTRACT_MALFORMED_ALARM_MIN) return undefined;
    const chosen = returned > 0 && judged.answers === 0;
    const esc = escalated - judged.escalated;
    judged.answers = answers;
    judged.malformed = answersMalformed;
    judged.escalated = escalated;
    // The block the heartbeat carries, so an unattended follower's alarm
    // reaches preflight's row and not stderr alone (SMD-2261).
    lastBlock = { answers: n, bad, alarm: malformedAlarm(n, bad) };
    if (!lastBlock.alarm) return undefined;
    alarms++;
    const models = esc ? `OB1_METADATA_MODEL (${cfg.metadataModel}) and OB1_EXTRACT_ESCALATE_MODEL (${WINDOWING.escalateModel}), which answered the runaways of ${esc} thought(s)` : `OB1_METADATA_MODEL (${cfg.metadataModel})`;
    const retries = [leftOut ? "--retry-left-out re-reads the partial rows" : "", failed ? "--retry-failed re-reads the failed ones" : ""].filter(Boolean).join(" and ");
    return `  ${bad} of ${FOLLOW ? `the follower's last ${n} answers` : `the ${n} answers this run`} were ${MALFORMED_WINDOWS_MARK} — more than ${Math.round(EXTRACT_MALFORMED_ALARM_SHARE * 100)}% of at least ${EXTRACT_MALFORMED_ALARM_MIN} (db/config.mjs, EXTRACT_MALFORMED_ALARM_SHARE): ` +
      (chosen
        ? `the ${returned} row(s) this run returned were chosen for failing or leaving windows out, so their documents may be at fault; if not, the model is.`
        : "the model, not the documents, is likely at fault — documents it can answer only in part, such as reference lists, leave out far fewer.") +
      `\n    Check ${models}, the endpoint and the prompt. ${done ? `The rows written stand${leftOut ? ", each partial one naming its windows left out" : ""}` : "No row was written"}` +
      `${retries ? `; once the model is right, ${retries}, with --job ${JOB} if OB1_METADATA_MODEL changes` : ""}.`;
  }

  /**
   * Workers whose leases could not be returned as they ended — the database
   * was not answering — returned at the start of the next pass rather than
   * left to expire a lease later (SMD-2599). A follower's only.
   */
  const unreturned = new Set<string>();

  /** The last judged block, for the heartbeat; null until one is judged. */
  let lastBlock: MalformedBlock | null = null;
  // A follower's heartbeat (db/pass-stamp.ts, SMD-2261): stamped after every
  // pass and re-stamped while one runs. A one-shot run stamps nothing. A
  // caller's stamper stands in for the row (sleep.ts's, SMD-1794).
  const stamper = opts.stamper !== undefined ? (FOLLOW ? opts.stamper : null) : FOLLOW
    ? passStamper({
        sql, worker: "extract", job: JOB, intervalS: FOLLOW,
        onError: (e) => err(`  heartbeat ${stampKey("extract", JOB)} not written: ${e.message.split("\n")[0]} — a role needs the worker grant group (INSERT, UPDATE on ob1_config); the follower goes on`),
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
    // The admit gate before the pass's pool and counts (SMD-3379 PR 1b). A
    // stop while it waits ends the run with no pass: the summary's counts are
    // read only for a summary.
    if (ADMIT && !(await admitted(ADMIT, gate))) {
      return SUMMARY ? counts() : { pending: 0, claimed: 0, succeeded: 0, partial: 0, leftOut: 0, leftOutOver: 0, failed: 0, unpooled: 0, thoughts: 0 };
    }
    for (const w of unreturned) {
      await sql`SELECT release_claims_for_worker(${JOB}, ${w})`;
      unreturned.delete(w);
    }
    // The backlog is pooled once. While following, the trigger enqueues every
    // new capture, so re-running enqueue_thoughts — a scan of every thought —
    // each poll would find nothing and cost the table.
    const added = firstPass ? Number((await sql`SELECT enqueue_thoughts(${JOB}) AS added`)[0].added) : 0;
    // Once a run, 093's rows no reader can use (review pass 5): beside a
    // claim released succeeded — left only when the table was out of reach at
    // the release — or of this pool's thoughts at text they no longer hold.
    // A row beside a failed claim at the text it holds stays, for
    // --retry-failed.
    if (firstPass && keeping) {
      await sql`
        DELETE FROM extraction_progress e
         USING thought_work_claims c, thoughts t
         WHERE c.thought_id = e.thought_id AND c.work_type = e.work_type AND t.id = e.thought_id
           AND (c.status = 'succeeded' OR (e.work_type = ${JOB} AND e.fingerprint <> COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))))`
        .catch((e: unknown) => keepingFailed(e, "prune"));
    }
    firstPass = false;
    const before = await counts();
    if (added > 0 || !FOLLOW) out(`  pool: ${added} thought(s) added`);
    total += before.pending + before.claimed;
    lastPassIdle = before.pending + before.claimed === 0;
    if (lastPassIdle) return before;
    if (!FOLLOW || added > 0 || before.pending > 0) {
      printCounts(before, "before");
    }
    // A worker that throws — a Writer that throws, in practice; each catches
    // its own database errors — stops the rest after the thought in hand, and
    // the pass rejects with its error once they have stopped, not while they
    // still hold rows and the client (review pass 1).
    const ends = await Promise.allSettled(Array.from({ length: WORKERS }, (_, i) => worker(i).catch((e: unknown) => {
      stopping = true;
      passEnds.abort();
      throw e;
    })));
    const thrown = ends.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (thrown) throw thrown.reason;
    progress(true);
    // A stopping pass's count is read only for the summary: without one, the
    // scan of every thought is not made at a wake (SMD-2752). A stopped run's
    // exit reads none of it.
    return stopping && !SUMMARY ? before : counts();
  }

  say(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

  /**
   * A follower's pass, which a database outage does not end (SMD-2599): an
   * error that says the database is not answering is said once and waited
   * out on outageWait's schedule, until a SELECT 1 answers — and the pass
   * runs again at once, so its counts are read — or a stop wakes the wait,
   * and the counts are null. Bun's pool reconnects on the next query. Any
   * other error ends the run, as before; a run without --follow is unchanged.
   */
  async function followedPass(): Promise<Counts | null> {
    for (;;) {
      try {
        const c = await stampedPass();
        // A worker found the provider not answering and ended the pass
        // (SMD-2599): the heartbeat says so, and stays a running follower's
        // while it probes, so preflight reads it alive, not stale (SMD-2261).
        if (outage.reason !== null && !stopping) {
          await stamper?.stamp("failed", lastBlock);
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

  let after = await followedPass();
  if (FOLLOW) {
    // Only a block it will poll after: the last pass's — the limit reached, or
    // stopped — is the final judgement's, which says the exit the run takes
    // (review pass 2: a follower at its --limit said "exits 0" and exited 3).
    const say = () => {
      if (stopping || limitReached()) return;
      const line = judge();
      if (line) err(`${line} The follower keeps polling; stopped by a signal, it exits 0${LIMIT ? ", and at its --limit, 3" : ""}.`);
    };
    say();
    await stamper?.stamp(passOutcome, lastBlock);
    // "This many thoughts, then stop" holds while following too.
    while (!stopping && !limitReached()) {
      await sleepUnless(FOLLOW * 1000, onStop.signal);
      if (stopping) break;
      after = await followedPass();
      say();
      await stamper?.stamp(passOutcome, lastBlock);
    }
  }

  // Leases a worker could not return as it ended, returned before the run
  // ends where the database answers; else they expire within --ttl (review pass 3).
  // All at once, and not when the run ended waiting for the database; one
  // line when they could not go (review pass 4).
  if (after !== null && unreturned.size > 0) {
    const kept = (await Promise.all([...unreturned].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.then(() => 0, () => 1)))).reduce((a: number, b: number) => a + b, 0);
    if (kept > 0) err(`  ${kept} worker(s)' leases could not be returned as the run ended; they expire within ${TTL} s`);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  // How the runaways were handled: a penalised same-model retry, an escalation to
  // the larger model (SMD-2000), or both. A count is named only when it happened,
  // so an escalation pass does not read "0 retried … , N escalated".
  const runawayNote = escalated
    ? `${retried ? `${retried} retried and ` : ""}${escalated} escalated to ${WINDOWING.escalateModel} after a runaway answer`
    : `${retried} retried after a runaway answer`;
  out(
    `\n  ${done} extracted${partial || leftOut ? ` (${[
      partial ? `${partial} over a prefix only — past the per-thought bound, OB1_EXTRACT_MAX_WINDOWS (${cfg.extractMaxWindows}); each row's caveat says how much` : "",
      leftOut ? `${leftOut} with ${leftOutWindows} window(s) left out, the model's answers for them ${MALFORMED_WINDOWS_MARK}; each row's caveat names them` : "",
    ].filter(Boolean).join("; ")})` : ""}, ${failed} failed, ${superseded} edited mid-extraction and re-queued, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed}s ` +
      `(${(llmMs / 1000).toFixed(1)}s in ${calls} model call(s) across ${WORKERS} worker(s), ${windowed} thought(s) in windows, ${runawayNote} (${aborted} aborted on the stream before the budget), ${beats} heartbeat(s))`
  );
  out(
    `  wrote ${totals.mentions} mentions of ${totals.newEntities} new entities, ${totals.edges} edges; ` +
      `dropped ${totals.dropped} relation(s) naming an unlisted entity; ${totals.ambiguous} attached to a name listed under two types` +
      (totals.gated ? `; the name gate (056) refused ${totals.refused} entity name(s) and retyped ${totals.retyped}` : "") +
      // SMD-3306: said when a rule found any, so a brain whose thoughts name no ticket reads as before.
      (subjects.recorded || subjects.kept ? `; recorded ${subjects.recorded} thought(s)' own subject by its ticket${subjects.kept ? `, ${subjects.kept} kept at the text read now` : ""}` : "")
  );
  // Thoughts none of whose windows parsed; a window left out beside parsed ones
  // is in the summary's partial clause instead (SMD-2260, review pass 2).
  if (malformed > 0) err(`  ${malformed} thought(s) whose every answer was not JSON of the expected shape — recorded failed`);
  // A run whose model answers a large share of windows malformed writes partial
  // rows, each succeeded, where one malformed window used to fail its thought:
  // say so, and exit 3 below, rather than let the exit code pass it (SMD-2266).
  // The exit code is settled first, so the line says the one the run exits with
  // (review pass 1: a signal or the provider's refusal exits otherwise).
  const alarmLine = judge();
  // The follower ends — a signal, its --limit, or the provider refusing the
  // request itself — and the row says so, with the final judgement's block: a
  // follower stopped at its --limit on a tripped block exits 3, and its row
  // carries the alarm too. Its age then warns, as it should. The provider's
  // refusal is named on its own row, `provider`, as a start's is (SMD-3214):
  // a revoked key or spent credit mid-pass, which the supervisor holds; the
  // scheduler's row, which a driven pass stamps through, names its own.
  if (configError && opts.stamper === undefined) stamper?.refused?.("provider");
  await stamper?.end(configError ? "failed" : "stopped", lastBlock);
  if (after === null) {
    // A follower stopped while it waited for the database: the counts
    // cannot be read, and are not guessed (SMD-2599).
    if (alarmLine) err(alarmLine);
    if (SUMMARY) err(`\n  stopped while the database was not answering: the pool's counts and the graph are not read — --status reads them once it answers`);
    if (configError) err(`\n  The provider refused the request itself: ${configError.slice(0, 300)}`);
    return configError ? 2 : hardStopped ? 130 : 0;
  }
  const incomplete = after.failed > 0 || after.claimed > 0 || (after.pending > 0 && !limitReached());
  // The alarm before the failures: a model at fault explains them, and
  // --retry-failed under it would fail them again. Leased and pending rows keep
  // their own lines below.
  // A follower stopped exits 0 — unless hard-stopped, which is a signal's 130 (review pass 2).
  const exitCode = configError ? 2 : stopping ? (FOLLOW && !hardStopped ? 0 : 130) : alarms > 0 ? 3 : incomplete ? 1 : 0;
  if (alarmLine) err(`${alarmLine} ${exitCode === 3 ? "Exiting 3." : `Exiting ${exitCode}, not 3: ${exitCode === 2 ? "the provider refused the request itself (below)" : "stopped by a signal"}.`}`);
  // The summary's queries — the graph's counts over every entity and mention,
  // the partial and failed rows — are the run's report, not a pass the
  // scheduler drives: it waits for them at a wake (SMD-2752).
  if (SUMMARY) {
    printCounts(after, "after");
    await printGraph();
    if (after.partial > 0) await printPartials(after);
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
        `  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_METADATA_MODEL against the provider; a 400 about a request field\n` +
        `  is usually reasoning_effort, response_format, max_tokens (the answer budget) or frequency_penalty (the runaway retry) not being supported by this model or endpoint. Nothing was marked failed.`
    );
    return 2;
  }
  return exitCode;
}

if (import.meta.main) {
  const cli = commandLine("extract-entities.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  if (cli.has("subjects")) {
    // The subject sweep (db/subject-sweep.ts, SMD-3306) takes its own flags: a
    // pass's beside it would be read as asked and do nothing (SMD-2015's kind).
    const value = cli.value("subjects");
    const others = Object.keys(FLAGS).filter((f) => !SUBJECT_FLAGS.has(f) && cli.has(f as keyof typeof FLAGS));
    if ((value !== undefined && value !== "rules") || others.length > 0) {
      console.error(`extract-entities.ts: --subjects takes "rules" or no value, and goes with --url, --limit, --timeout and --dry-run alone${others.length ? `, not ${others.map((f) => `--${f}`).join(", ")}` : ""}.\n${flagList(FLAGS, HINTS)}`);
      process.exit(2);
    }
    const limit = cli.has("limit") ? cli.int("limit", { absent: 0, min: 1 }) : undefined;
    // Absent, the sweep's own default, which follows the question's reasoning (SMD-3306 PR 4).
    const timeout = cli.has("timeout") ? cli.int("timeout", { absent: 0, min: 1, max: MAX_CALL_TIMEOUT_S }) : undefined;
    const sql = openSql(url, { max: 2 });
    let uninstall = () => {};
    await closeThenExit(sql, async () => {
      return sweepSubjects({ sql, url, model: value !== "rules", limit, timeout, dryRun: cli.has("dry-run"), onPass: (stop) => { uninstall = stopOnSignals(stop); } }).finally(() => uninstall());
    });
  }
  // The numbers by the scanner's rules, in run()'s order — the lease pair
  // between them, as run() checks it — so a command breaking two rules is
  // refused for the same one it always was.
  const workers = cli.int("workers", { absent: 2, min: 1, max: MAX_WORKERS });
  const batch = cli.int("batch", { absent: 1, min: 1, max: MAX_BATCH });
  const ttl = cli.int("ttl", { absent: DEFAULT_TTL_S, min: 1 });
  const heartbeat = cli.has("heartbeat") ? cli.int("heartbeat", { absent: DEFAULT_HEARTBEAT_S, min: 1 }) : undefined;
  const timeout = cli.int("timeout", { absent: 300, min: 1, max: MAX_CALL_TIMEOUT_S });
  const lease = leaseRefusal(ttl, heartbeat ?? heartbeatFor(ttl), heartbeat === undefined);
  if (lease) {
    console.error(lease);
    process.exit(2);
  }
  const limit = cli.has("limit") ? cli.int("limit", { absent: 0, min: 1 }) : undefined;
  const follow = cli.has("follow") ? cli.int("follow", { absent: 0, bare: 15, min: 1 }) : undefined;
  // One connection per worker and a spare (run()'s rule), opened lazily: a
  // refusal before the first query opens none — and the first opens them all,
  // Bun's pool connecting every one it may hold.
  const sql = openSql(url, { max: workers + 1 });
  // The signal handlers go when run() settles: a signal while the door closes
  // the pool and flushes ends the process, as one before the pass does,
  // rather than reaching a stop with no pass left (review pass 2).
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, workers, batch, ttl, heartbeat, timeout, limit, follow,
      dump: cli.value("dump"),
      job: cli.value("job"),
      status: cli.has("status"),
      dryRun: cli.has("dry-run"),
      switchKey: cli.has("switch-key"),
      retryFailed: cli.has("retry-failed"),
      retryPartial: cli.has("retry-partial"),
      retryLeftOut: cli.has("retry-left-out"),
      decide: cli.has("decide"),
      onPass: (stop) => { uninstall = stopOnSignals(stop); },
    }).finally(() => uninstall());
  });
}
