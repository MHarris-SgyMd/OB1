/**
 * subject-sweep.ts — the extraction worker's `--subjects` sweep (SMD-3306): each thought in the subject pool (migration
 * 113) is given its own subjects, the rules' or, for the rest, the judge model's (server-portable/subject.ts), through
 * migration 130's record_thought_subjects: a set of at most three, one rule's or the model's, which the header rule and
 * the question find since their versions 3 (SMD-3306 PR 7a-3b-2). A subject is current when it
 * stands at the thought's text and was found under the current rules and question, a model's with its reasoning on when
 * the question is asked with it on (subjectCurrent), and the ticket the thought is filed under agrees with it
 * (filedTicketSql).
 *
 *   bun db/extract-entities.ts --url … --subjects                # the rules, then the judge model for the rest
 *   bun db/extract-entities.ts --url … --subjects rules          # the rules alone: no model call
 *   bun db/extract-entities.ts --url … --subjects --dry-run      # how many each would find; writes, pools and asks nothing
 *   bun db/extract-entities.ts --url … --subjects --limit 50     # at most this many thoughts
 *   bun db/extract-entities.ts --url … --subjects --retry-failed # the pool's failed claims back in it first
 *   bun db/extract-entities.ts --url … --subjects --switch-key   # required when another pool is named
 *   bun db/extract-entities.ts --url … --subjects --judge-checked # the alarm off, a trip's hold on its model lifted
 *   --timeout SECONDS (per model call: 900 with the judge model's reasoning on, 300 off)
 *   OB1_SUBJECT_REASONING=off                                    # the judge model without its reasoning (on unset)
 *   exits 0 clean · 1 claims failed (unanswered, a following run's thought the provider erred on again right after
 *   answering a probe, or that hung it again, its claim marked, unread or refused, a write past a scheduler's
 *   statement_timeout, or a lease run out at its last attempt while it claimed), its naming or pooling broke off, a
 *   poll lost to that timeout in a run not following, the provider stopped answering a run by hand, or the database a
 *   run by hand or a following run past its start · 2 usage, configuration, another pool named without --switch-key, or
 *   by another run while this one ran, a capturing role a pool would fail, a role without the door's or the pool's
 *   grants, or the provider's refusal, a following run's start probe of its judge model among them · 3 the judge model
 *   likely at fault: 10 of its last 48 answers, across runs, gave no subject, or another run's alarm tripped after this
 *   run began (JUDGE_ALARM; ahead of 1, and of a first signal's 130 when the claim it let finish trips it), or a
 *   following run a trip holds (judgeHeld), or a --judge-checked run whose model a trip named after it began, before
 *   its lift · 130 a signal (the first after the call in hand, which can run to the limit a call; a second at once, the
 *   claim in hand handed back, unjudged, unless its finish holds the window's lock: that lands, judged, a trip it made
 *   said or not), or a caller's stop during the naming's waits or at the admit gate; a following run, a scheduler's,
 *   stopped by its first exits 0, unless the thought in hand it lets finish ends the run as 1, 2 or 3 do
 *
 * The pool (113, PR 5). The sweep claims from thought_work_claims under its pool's key (subject.ts's subjectPoolKey:
 * the rules' versions and, when it asks the model, the question's with its reasoning), as the extraction pass claims
 * under its own, so a run costs what is in the pool, not the brain's size: until PR 5 every run read every thought, its
 * count and its pages, and a PGlite run timed the count alone at 5.9 s over a million synthetic thoughts. 113's trigger
 * puts each new or edited thought (back) in the pool ob1_config.subject_pool_key names. The first sweep names its own
 * and pools every thought with no current subject; after a rule's, the question's or the reasoning's change, or for
 * `--subjects rules`, whose pool is its own, a sweep under another key does so only with --switch-key, as the pass's
 * own key change is refused without it (review pass 1: a rules run renamed the model's pool unasked). They are
 * requeued, not only added, since a pool used before keeps its finished claims and a thought edited since must be asked
 * again; a claim records no fingerprint, so a switch to another key and back asks again, too, those the model named
 * nothing for. The pooling is marked finished in ob1_config.subject_pool_filled once it commits, so one that broke off
 * (a thought deleted under it, a lost connection) is pooled again by the next run (review pass 1: the pool stood named
 * and its backlog was never pooled). The naming's write of the name waits for each write in flight under the pool
 * named; before it pools, a naming waits for the transactions writing thoughts as it named the pool, whose triggers may
 * have read the pool before, so the pooling sees what they capture; and the pooling waits for whatever holds a lock it
 * needs, a claim an edit's trigger wrote among them. No wait has an end of its own: each says which pids it waits on —
 * the writers it read, or for a statement those the server says hold it up — again every NAMING_WAIT.sayMs, until they
 * end (review passes 7 and 8: past a bound, every run pooled again and asked again what the model had named nothing
 * for, for as long as the writer stayed open). A signal during the naming and pooling ends the CLI at once, the stop
 * not yet handed out, and the server ends the statement in hand within a second of the CLI going
 * (client_connection_check_interval): the name left as it was, or named and its pooling unmarked. A caller's stop ends
 * an in-process run's waits, 130 (0 for a following run): a statement among them cancelled from the run's own second
 * connection, opened on its url, or, without one, heard once the statement ends, said. Either way the next run pools
 * again. The first naming is refused while a login role that can capture (it reads ob1_config, without which 016's
 * trigger refuses it already) cannot write the claims 113's trigger writes as it, which would fail its every capture.
 *
 * Each claim is one thought, leased for the limit a call and LEASE_MARGIN_S more, renewed as a following run's probe
 * after a timeout begins, so a worker that dies hands it back within that, and a provider's transient error puts it
 * back first in the pool for the claim after the pause to take again; a run that stops hands back what it holds, and a
 * second signal hands back the claim in hand before the CLI exits. A thought the provider stopped answering on, a run
 * by hand's, goes back to the end of the pool, so the next run starts with another (review pass 1: it came first again,
 * and ended every run), but a --judge-checked run's, which stays where it stood, the trip's hand-back first. A thought
 * the extraction pass gave a current subject after it was pooled is finished unasked, so long as the rules agree now (a
 * ticket filed, moved or taken away is read again). A claim finished records that the thought was asked at its text
 * under the pool's key: one the model named nothing for is not asked again until its text, the ticket it is filed under
 * or the key changes ("asked, got nothing"), and the out-of-date subjects standing on it are closed through
 * close_thought_subjects (130), which closes them only while they are still the set read at the text read, so a subject
 * a pass wrote since stands. An answer that is not JSON with subjects, a timeout (a following run's when a one-token
 * call answers after it, or a stopping run's) or the provider refusing the thought's length, a row the egress gate
 * refuses, and a key the door refuses each fail the claim, counted, the subject standing; `--retry-failed` puts them
 * back in the pool. A judge model 10 of whose last 48 answers gave no subject — unread, or naming nothing — stops the
 * run, exit 3, the window the pool's, kept across runs in ob1_config (JUDGE_ALARM, PR 5b): the claims among those
 * answers finished as named nothing, by whichever run, go back to the pool, since nothing else would ask them again,
 * and those it could not read stay failed. Each answer counts when it is asked again as when it was new, and a judge
 * checked and found right runs with --judge-checked, the alarm off. A rate limit, a server error or a lost connection
 * is paused for, the thought back in the pool, first, and claimed again (TRANSIENT_PAUSES_MS, the pauses counting the
 * provider's errors since its last answer, across thoughts, a timeout or an egress refusal no answer, a following run's
 * probe answering after a timeout an answer), then ends the sweep; a following run, a scheduler's, waits the provider
 * out past them instead, as a claim pass's follower does (PR 6b-1, below). Any other refusal of the request ends it,
 * exit 2, as it ends the pass; a model being pulled is a following run's outage, waited out. A dry run writes, pools
 * and asks nothing, counts what a run would take (the pool's, or every thought with no current subject when its pool is
 * not named yet or its pooling broke off), reads on through a signal as the pass's does, and names the refusals a run
 * would meet. Its pages go in thought id order, so with --limit it counts the first by id, which a run, taking the
 * oldest pooled first, need not.
 *
 * The extraction pass records the rules' subjects with each thought's entities (extract-entities.ts's processRow), so
 * a thought filed under a ticket, or a session summary whose prompts name its header's tickets, has its subjects once
 * it is extracted, and the sweep finishes it unasked. 111's door replaces a subject found under another pass key, so a
 * changed rule finds again the subjects it found, and those alone; version 1's one key for both rules is taken whole,
 * once, its filed tickets found again unchanged under the metadata rule's own key (review pass 5). Two sweeps, or a
 * sweep beside the pass, write each text's subject once: under one key the claims are disjoint while their leases
 * hold (a naming leaves a live lease to its run; an edit pools its thought again), and whatever the claims, the door
 * locks the thought and checks the text's fingerprint and, since 113, the ticket it is filed under (PR 5's review
 * pass 5: a subject read before the ticket moved landed after another pass recorded the ticket's, and stood). A run
 * whose pool another run names away from it records and closes no subject more: each write and close first locks the
 * pool's name FOR SHARE and reads it, so a naming waits for one in flight, and the run reads the name before each
 * claim; it stops, exit 2, at the first that finds it moved, the claim in hand at most asked first (review pass 7: a
 * run under the key before a switch replaced the subject the new pool's run had recorded and finished).
 * `--subjects rules` stops at the rules, for a brain whose judge model has not been measured on the question.
 *
 * A scheduler drives the sweep much as it drives the claim passes (PRs 6a and 6b-1; sleep runs it since PR 6b-2):
 * following, an empty pool polled until its stop, a follower's end (0); the admit gate before the pool and each claim,
 * a thought a provider error put back claimed again through it; the call in hand's own abort beside the stop, its
 * thought set back unanswered, a following run's next claim after a one-token call, the call left unanswered that
 * thought's hang; its word through the scheduler's row, and its waits for the provider, at its start and through an
 * outage past its pauses, or hung; the scheduler's session settings on its connections, a statement past its
 * statement_timeout thrown at its start or its naming, the pooling exempt while watched (PR 6b-1: a scan of every
 * thought, it can outlast the budget on a large brain, the pool never filled), and over a thought failing the thought
 * on its own write, else costing the run its poll, as a claim pass's did until SMD-2636 PR 4 (a claim pass's holds its
 * pass now); its start's lines left out; its start reported
 * (onStart), each refusal by its kind, and its start check (check), the pool's name read and the judge model probed. As
 * a claim pass's follower does (PR 6b-1, the maintainer's choice), it waits out the provider's outage past its pauses,
 * or hung, a call timed out and a probe out too, the thought in hand back in the pool, a thought that errs so again
 * right after a probe answered failed as its own (ProviderOutage, in a window of 15 minutes past its next streak at the
 * run's limit: a suspect when its streak's first error could be its own, a 5xx but 503 or a lost connection, put back
 * first, or when its call hung, put back behind the rest, its hang marked on its claim (HUNG_MARK), so its next hang in
 * any following run is its own whatever outages came between, the run waiting the provider out before its next claim; a
 * 429 or 503 holds calls back and makes none, nor does a model being pulled, that thought put back behind the rest;
 * behind the rest is 30 days ahead, as sleep.ts places its stopped extraction thoughts, so the thoughts pooled since
 * are asked first), and its start, to its first claim, waits out the database, the worker key's lookup but at too many
 * connections, as a claim pass's does. Unlike a claim pass, the database lost past its start ends it (1), for the
 * scheduler to start it again; and the stop and the call's abort are its caller's from its first claim, the gate before
 * the pool hearing the caller's signal (review passes 1 and 2, cold read). No one is there to pass --judge-checked, so
 * a trip holds the pool's following runs of each judge model it names, beside an earlier trip's not lifted: one does
 * not start while a trip's hold on its model stands (judgeHeld), exit 3, until a run of that model with --judge-checked
 * --limit 1, once it is checked, lifts the hold it read as it began (heldSince, namedSince), or with --limit the count
 * of the last trip's hand-back still pending, which the held line offers the models that trip named when its answers
 * naming nothing tripped it alone; a trip naming the model since the run began refuses the lift, exit 3, nothing
 * claimed. A run of another judge model is not held, and lifts nothing; the pool's key changing starts a window of the
 * new pool's at its first answer judged with the alarm on, so a switch back finds no hold. Every answer counts as in a
 * hand run (the maintainer's choice, 2026-10-31): a pooling again — a rules version changed, the reasoning turned off,
 * a pooling broken off or its mark blanked by hand — asks again together each thought the judge named nothing for, and
 * ten of them trip a judge that is right, a trip whose hold waits for that hand run.
 *
 * The question is asked with the judge model's reasoning on unless OB1_SUBJECT_REASONING says off (PR 4: Verify item 1
 * was met that way and missed without, though the difference alone was not significant), at about 8x the time a call,
 * and the default --timeout follows it. A subject a model found with its reasoning off is pooled again while it is on
 * (`@p2` under `@p2r`); turning it off pools none of those found with it on.
 */

import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ProviderError, resolveEmbedConfig, type EmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, ROW_UNITS } from "../server-portable/egress.ts";
import { actorKindOf, cleanForDisplay } from "../server-portable/consolidate.ts";
import { askOwnSubject, ruleSubject, SUBJECT_KEY_PREFIX, subjectModelKey, subjectModelSuffix, subjectPoolKey, subjectReasoning, subjectReasoningOn, subjectRuleKey, type SubjectBy } from "../server-portable/subject.ts";
import { subjectRecipe, type Recipe } from "../server-portable/lineage.ts";
import { blanketGate, classifyError, databaseUnavailable, egressDescription, egressRefusal, followClassify, isOut, lookupOutage, MAX_CALL_TIMEOUT_S, modelMissing, OUTAGE_MS, outageWait, probeChat, probeRefusal, probeUntil, ProviderDown, ProviderOutage, regateMessage, SUSPECT_WINDOW, throughOutage, timedOut, TRANSIENT_PAUSES_MS, workerIdentity, type Probe, type StartRefusal, type StartResult } from "./worker-bootstrap.ts";
import { asPass, withCallWaits } from "../server-portable/model-call.ts";
import { admitted, AbortedInHand, inHandCalls, callWaitsFor, setBack, sleepUnless, STOPPED_EARLY, type Admit, type InHandAbort, type PassStop } from "./lease.ts";
import type { PassStamper } from "./pass-stamp.ts";
import { andList, consoleWriter, numberProblem, type Writer } from "./cli.ts";
import { databaseUrlProblem, NO_DATABASE_URL, openSql, type SessionSettings } from "./connect.ts";
import { HUNG_MARK } from "./config.mjs";

/** 130's door for a set, by its signature: the sweep's one write (SMD-3306 PR 7a-3b-1). */
const DOOR = "record_thought_subjects(uuid, text[], text, text, uuid, text, jsonb)";

/** 130's close of a set, by its signature: the sweep's close of out-of-date subjects the model names nothing for. */
const CLOSE = "close_thought_subjects(uuid, uuid[], text)";

/**
 * What the door needs of the role that calls it (111's and 130's comments), and where each grant comes from: the
 * sweep's refusals and the pass's say this.
 */
export const DOOR_GRANTS = "INSERT and UPDATE on thought_facets (INSERT is the structure group's), UPDATE on thoughts (its row lock), and INSERT, UPDATE and SELECT on derivations (the capture group's)";

/** What the pool needs of the role (113): the claims' reads and writes, and the pool's name in ob1_config. */
export const POOL_GRANTS = "SELECT, INSERT and UPDATE on thought_work_claims, and INSERT and UPDATE on ob1_config";

/** A claim's lease past the limit a call: the door's write and the reads beside the call. */
export const LEASE_MARGIN_S = 300;

/**
 * The naming's waits: how often a wait says again which pids it waits on (`sayMs`), how long a statement is held up
 * before it first says so (`quietMs`), and how often a held-up statement's watcher asks who holds it up (`pollMs`).
 * None ends a wait: the transactions' ends do, or the caller's stop (review passes 7 and 8). Read as the run goes, so a
 * test shortens them, as OUTAGE_MS is.
 */
export const NAMING_WAIT = { sayMs: 30_000, quietMs: 1_000, pollMs: 250 };

/**
 * The garbage-judge alarm (PR 5b): a run stops, exit 3, once more than `share` of `window` — 10 of 48 — of the judge
 * model's last `window` answers gave no subject: not JSON of the expected shape, or a subject naming nothing a key
 * holds (an empty one, or only a ticket, release or PR the thought does not name), since a judge answering so, not the
 * thoughts, is likely at fault. The window is the pool's, kept across runs in ob1_config (JUDGE_WINDOW_KEY), so the
 * answers of small runs add up: a judge answering garbage stops at its 10th answer however the runs fall (review pass
 * 2: a window of each run's own left every run of fewer than 10 answers unjudged, most runs after a pool's first
 * naming, its claims named nothing finished for good). Every answer counts, on a thought asked again as on a new one,
 * so a judge left broken trips again at each run and what it named nothing for goes back each time; one checked and
 * found right, which thoughts that truly have no subject, asked together, tripped, runs with --judge-checked, which the
 * trip line offers with --limit, the count it handed back (review pass 3, run-it: answers on handed-back thoughts taken
 * as given let a judge left broken finish all 30, exit 0; cold read: a pooling again brings up together what the model
 * named nothing for, which that rule did not cover). The pass's fifth of 48 (db/config.mjs's malformedAlarm): the 27B
 * named nothing for 1 of the 63 it was asked in the canary's first naming run. It reads an answer's shape, not its
 * truth: qwen2.5:7b, the metadata model's default, which judges when OB1_JUDGE_MODEL is unset, answered 100 canary
 * thoughts in shape, naming nothing for one, and gave the 27B's key for 60 of the other 99 (db/README.md). Read as the
 * run goes, so a test shortens `window`, as NAMING_WAIT is.
 */
export const JUDGE_ALARM = { window: 48, share: 1 / 5 };
/**
 * The tries a thought's own write transaction gets when the server rolls it back to break a deadlock (40P01), as the
 * pooling and db/threads.ts retry theirs three times: past them the thought fails, for --retry-failed.
 */
const DEADLOCK_TRIES = 3;

/** Whether `noSubject` answers of a window trip the alarm: more than its share of the whole window. */
export const judgeTrips = (noSubject: number, alarm: { window: number; share: number } = JUDGE_ALARM): boolean =>
  noSubject > alarm.share * Math.max(1, alarm.window);

/**
 * ob1_config's key for the judge's window, kept across runs (JudgeWindow as JSON, written under the row's lock): the
 * answers of the pool it names, and its last trip.
 */
export const JUDGE_WINDOW_KEY = "subject_judge_window";

/**
 * One of the judge's answers in the window: what it gave (`n` naming nothing, `u` unread, `k` a key), on which thought
 * (`t`) and from which judge model (`m`); whether its claim was finished as named nothing (`f`) and an out-of-date
 * subject closed then (`c`).
 */
export type WindowAnswer = { g: "n" | "u" | "k"; t: string; m: string; f: boolean; c: boolean };

/**
 * The judge's window as ob1_config keeps it: the pool it is of, its answers oldest first, and its last trip: when
 * (`tripped`, the server's clock as text, compared as written) and the models whose answers gave no subject then
 * (`by`). A run that finds it moved since the run began stops: one beside the trip would ask with the same judge
 * (review pass 3, cold read and run-it: compared as a time, a run that began between the trip's clock and its commit
 * never stopped, and a stamp ahead of the clock stopped every run). `held`: the judge models whose following runs, a
 * scheduler's, which no one is there to pass --judge-checked to, the trip holds (judgeHeld, PR 6a): its models, beside
 * an earlier trip's not lifted, each held until a run of it with --judge-checked lifts its own hold, the trip's stamp
 * and models kept (review pass 1: one flag, lifted by either of a trip's two models, let the other's runs start again
 * unchecked, cold read; another model's trip replaced the list, and the first model's runs started again, run-it).
 * `namedAt`: the stamp of the last trip that named each model, kept after its hold is lifted (namedSince, heldSince),
 * so a run with --judge-checked lifts the hold it read as it began and not one a trip naming its model put there since,
 * whatever trips naming others came after, nor goes on past one another run has lifted since (review pass 3, cold
 * read: read off the last trip's models alone, a trip naming it, then one naming others, was lifted unseen, and the
 * lift line named the last trip for a hold another had put there; review pass 4, cold read: a stamp gone with its hold
 * let a run go on, the alarm off, past a trip on its model another run had lifted). `back` and `nothing`:
 * the thoughts the last trip handed back, and whether the answers naming nothing tripped it by themselves, so the held
 * line offers what the trip line did, --judge-checked with --limit the count of them still pending, to each model that
 * trip named (review pass 2, cold read: the held line's one thought lifted the hold, and the next run, asking the rest
 * with the alarm on, tripped again; review pass 3, cold read: a count kept as at the trip went stale as the thoughts
 * were asked, and was offered to a model an earlier trip held).
 */
export type JudgeWindow = { pool: string; answers: WindowAnswer[]; tripped: string | null; by: string[]; held: string[]; namedAt: Record<string, string>; back: string[]; nothing: boolean };

/**
 * Whether a trip's hold on a following run of `judgeModel` stands (PR 6a): the model is among those held, not yet
 * lifted. Another judge model is not held: a trip is its judge's, and the pool's key does not name the model. Nor is
 * a run under another pool's key, whose window is its own (readJudgeWindow).
 */
export const judgeHeld = (w: JudgeWindow, judgeModel: string): boolean => w.held.includes(judgeModel);

/**
 * The stamp of the last trip that named `judgeModel`, its hold standing or lifted, null when none did (PR 6a, review
 * passes 3 and 4): kept in `namedAt`, read as its own member alone (review pass 4, run-it: a model named toString read
 * Object.prototype's), or the last trip's for a model held in a window that keeps no stamp for it.
 */
export const namedSince = (w: JudgeWindow, judgeModel: string): string | null =>
  Object.hasOwn(w.namedAt, judgeModel) ? w.namedAt[judgeModel] : judgeHeld(w, judgeModel) ? w.tripped : null;

/** The stamp of the trip whose hold on `judgeModel` stands, null when none does (PR 6a, review pass 3). */
export const heldSince = (w: JudgeWindow, judgeModel: string): string | null => (judgeHeld(w, judgeModel) ? namedSince(w, judgeModel) : null);

/** A thought id as the window keeps it: the hand-back casts each to uuid. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The window ob1_config's `value` keeps for `pool`: a fresh one when it keeps none, another pool's, or text that is not
 * a window, and any entry that is not an answer dropped, so a value edited by hand neither stops a run nor fails a trip
 * (review pass 3, cold read and run-it: one that was not JSON, or a stamp that was not a time, stopped every run at
 * its first claim with a trace, `--subjects rules` among them; an entry that was not an answer failed the count).
 */
export function readJudgeWindow(value: string | null | undefined, pool: string): JudgeWindow {
  let kept: unknown = null;
  try {
    kept = JSON.parse(value ?? "");
  } catch {
    // None kept yet, or not a window.
  }
  const k = (typeof kept === "object" && kept !== null && !Array.isArray(kept) ? kept : {}) as Record<string, unknown>;
  if (k.pool !== pool) return { pool, answers: [], tripped: null, by: [], held: [], namedAt: {}, back: [], nothing: false };
  const answers = (Array.isArray(k.answers) ? k.answers : []).flatMap((a): WindowAnswer[] => {
    const e = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
    return (e.g === "n" || e.g === "u" || e.g === "k") && typeof e.t === "string" && UUID_TEXT.test(e.t)
      ? [{ g: e.g, t: e.t, m: typeof e.m === "string" ? e.m : "", f: e.f === true, c: e.c === true }]
      : [];
  });
  const by = Array.isArray(k.by) ? k.by.filter((b): b is string => typeof b === "string") : [];
  const tripped = typeof k.tripped === "string" && k.tripped !== "" ? k.tripped : null;
  // Held only with a trip to hold by: models beside no stamp are a hand edit's.
  const held = tripped !== null && Array.isArray(k.held) ? [...new Set(k.held.filter((m): m is string => typeof m === "string" && m !== ""))] : [];
  // Each model's last trip, text, held or lifted, and the thoughts handed back, ids: beside a trip's stamp only, as
  // `held` is.
  const at = tripped !== null && typeof k.namedAt === "object" && k.namedAt !== null && !Array.isArray(k.namedAt) ? (k.namedAt as Record<string, unknown>) : {};
  const namedAt = Object.fromEntries(Object.entries(at).flatMap(([m, v]): [string, string][] => (m !== "" && typeof v === "string" && v !== "" ? [[m, v]] : [])));
  const back = tripped !== null && Array.isArray(k.back) ? [...new Set(k.back.filter((t): t is string => typeof t === "string" && UUID_TEXT.test(t)))] : [];
  return { pool, answers, tripped, by, held, namedAt, back, nothing: tripped !== null && k.nothing === true };
}

/** What a watched statement answers when the caller's stop cancelled it. */
const STOPPED = Symbol("stopped");

/** Thrown in a transaction to end it rolled back: a second signal before a finish's judgement had the window's lock. */
const ROLLED_BACK = Symbol("rolled back");

/** The least thought id: a cursor before every page. */
const NIL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Leases a thought may take and lose, its worker gone, before its claim fails (claim_thoughts's p_max_attempts): a
 * lease run out at it is failed by the next claim's reaping, no work (sleep.ts reads it so, SMD-3306 PR 6b-2).
 */
export const MAX_ATTEMPTS = 3;

/**
 * A judge model's call limit when --timeout says none, in seconds: a reasoning call runs long — of 200 the 27B answered
 * with its reasoning on, two took over 300 s, the slowest 369 s, where the slowest of 160 without it took 133 s
 * (SMD-3306 PR 4) — so 900 with the reasoning on and 300 off, each about 2.4x and 2.3x the slowest. sleep.ts reads it
 * for consolidation's limit beside the sweep (PR 6b-2, review pass 2).
 */
export function subjectsTimeoutS(reasoningOn: boolean): number {
  return reasoningOn ? 900 : 300;
}

/**
 * How long a run's hand-back of its claims waits under a scheduler's session (releaseHeld), whatever the budget: past a
 * short one, and bounded, the scheduler's stop awaiting it (review pass 3). Read as the run goes, so a test shortens
 * it, as NAMING_WAIT is.
 */
export const RELEASE_WAIT = { ms: 30_000 };

/**
 * How long after a probe answered a suspect's next errors are "right after" it (ProviderOutage's window): the claim
 * passes' 15 minutes (worker-bootstrap.ts's SUSPECT_WINDOW) past the suspect's next streak at its longest — three calls
 * paused for, a fourth timed out and its probe, each at the run's limit, and the pauses — since a call here can run
 * 900 s, the window's whole length, and a timeout's outage, its probe past it, came too late ever to be its own
 * (PR 6b-1's review pass 3, cold read and the consumer's prototype: a thought hanging the provider looped at the pool's
 * head, failed never).
 */
export function suspectWindowMs(timeoutMs: number): number {
  return SUSPECT_WINDOW.ms + 5 * timeoutMs + TRANSIENT_PAUSES_MS.reduce((a, b) => a + b, 0);
}

/**
 * The longest a probe at a following run's start or in its outage's wait takes: a minute, or the run's limit if
 * shorter. The probe after a timeout takes the call's own limit instead, as a claim pass's does (ask). Read as the run
 * goes, so a test shortens it, as RELEASE_WAIT is.
 */
export const PROBE_CAP = { ms: 60_000 };

/**
 * How far past now a following run places a thought it sets back after an outage (backTo): 30 days, as sleep.ts dates
 * its stopped extraction thoughts (FORWARD_DAYS, SMD-3008) — an order, not a delay, since claim_thoughts reads no
 * clock: behind every capture pooled in the next 30 days, and claimed at once when nothing else is pending (PR 6b-1's
 * review pass 6, the maintainer's choice: one window ahead, a capture made later than that came after it, and a thought
 * hanging the provider led each later period again, captured into 100 minutes after a sleep).
 */
export const SET_BACK_AHEAD_MS = 30 * 86_400_000;

/**
 * What a following run writes in a hung thought's claim (last_error; db/config.mjs's HUNG_MARK, where the store's retry
 * reads it too) as it sets it back (backTo), and the probe after a call aborted in hand going unanswered
 * (hangAborted), the words after it the hang's: the claim, the set-back, a put-back and a run's hand-back keep it, so
 * the thought's next hang in any following run, any period, is its own, whatever outages came between, which
 * ProviderOutage's suspects do not outlast — a hand run reads it, and clears it at an answer, but judges no hang by it.
 * Its answer clears it (ask), the claim still its run's (one another run took keeps it), and so do an edit of its text
 * or ticket (016's requeue_thought_work through 113's trigger, or the sweep's own hand-back of a moved text), a pooling
 * again under its key, and --retry-failed or the API's retry_failed, which clear the pool's standing marks. A false
 * verdict needs two such hangs of one thought with no answer between to a run holding its claim, each a call that timed
 * out with the provider out after it, or was aborted with the one-token call after it unanswered, for whatever cause
 * (PR 6b-1's review passes 5 to 7, the maintainer's choices: forgotten at another's outage, two thoughts that hang the
 * provider, or one beside a thought whose own error makes no suspect, were failed never; kept for a window, thoughts
 * that each hold a one-slot provider for many limits kept each other's next hangs past it, 10 of 25 failed as their
 * own; kept for the run, a scheduler that ends its period on set-backs alone, each period a new run, failed none). A
 * pending or claimed claim's last_error, which no reader shows (review pass 8, cold read and claims audit:
 * --retry-failed cleared none, a failure having replaced each mark it met, and a pooling again went unsaid).
 */
export { HUNG_MARK };

/**
 * A following run's call timed out and a one-token call, given the call's own limit, found the provider out — hung, the
 * thought its suspect — or holding calls back, a 429 or 503, or its judge model missing, pulled again, neither making
 * one (ask; one() waits it out).
 */
class TimedOutDown extends ProviderDown {
  constructor(message: string, readonly hung: boolean) {
    super(message);
  }
}

/**
 * What record_thought_subjects answers (130): `added` when it wrote and closed nothing, `closed` when it closed and
 * wrote nothing (a set narrowed), `replaced` when it did both, `kept` when it did neither.
 */
export type SubjectWrite = { ok: boolean; action: "added" | "kept" | "replaced" | "closed" | "none"; ids?: string[]; added?: number; stale?: boolean; gone?: boolean };

/**
 * One thought's subjects through 130's door, one way's set (SMD-3306 PR 7a-3b-1: a set of one until PR 7a-3b-2's rules
 * and question find more), at the fingerprint of the text they were found in.
 */
export async function recordSubject(sql: SQL, row: { id: string; fingerprint: string }, keys: string[], by: SubjectBy, judgeKey: string, recipe: Recipe, agentId: string | null): Promise<SubjectWrite> {
  const [r] = await sql`SELECT record_thought_subjects(${row.id}::uuid, ${sql.array(keys, "TEXT")}::text[], ${by}, ${judgeKey}, ${agentId}::uuid, ${row.fingerprint}, ${recipe}::jsonb) AS r`;
  return r.r as SubjectWrite;
}

/** Whether two sets of keys are the same set, in any order; null (none standing) is the empty set. */
export function sameKeys(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const x = new Set(a ?? []), y = new Set(b ?? []);
  return x.size === y.size && [...x].every((k) => y.has(k));
}

/**
 * subject.ts's subjectCurrent in SQL, over a standing subject facet `f`: a rule's under that rule's key now, a model's
 * under the current question by any model, with its reasoning on while `reasoningOn`. False or NULL where the payload
 * lacks `by` or `judge_key`, either of which the sweep's NOT EXISTS reads as not current. test-live [10h] holds it to
 * subjectCurrent row by row under both settings.
 */
export function currentSubjectSql(sql: SQL, reasoningOn: boolean) {
  const [withReasoning, without] = [subjectModelSuffix(true), subjectModelSuffix(false)];
  return sql`CASE f.payload->>'by'
               WHEN 'metadata' THEN f.payload->>'judge_key' = ${subjectRuleKey("metadata")}
               WHEN 'first_line' THEN f.payload->>'judge_key' = ${subjectRuleKey("first_line")}
               WHEN 'model' THEN starts_with(f.payload->>'judge_key', ${SUBJECT_KEY_PREFIX})
                             AND (right(f.payload->>'judge_key', ${withReasoning.length}::int) = ${withReasoning}
                                  OR (${!reasoningOn}::boolean AND right(f.payload->>'judge_key', ${without.length}::int) = ${without}))
               ELSE false END`;
}

/**
 * The ticket a thought `t` is filed under: 113's ob1_filed_ticket, subject.ts's metadataTicket in SQL, which the door
 * reads too, under its lock (review pass 5: two copies, the sweep's and the door's, would have to agree). test-live
 * [10h] holds it to metadataTicket value by value.
 */
export function filedTicketSql(sql: SQL) {
  return sql`ob1_filed_ticket(t.metadata)`;
}

/** A database error's SQLSTATE. */
const sqlState = (e: unknown): string | undefined => {
  const { errno, code } = (e ?? {}) as { errno?: unknown; code?: unknown };
  return typeof errno === "string" ? errno : typeof code === "string" ? code : undefined;
};

/**
 * The line a database that stopped answering ends the sweep with, `left` what a --judge-checked run left of its limit
 * (leftOfLimit).
 */
const databaseDown = (e: unknown, left = "") => `\n  The database stopped answering (${String((e as Error)?.message ?? e).slice(0, 300)}): the sweep stops here; run it again${left}.`;

/**
 * What one sweep is asked: `model` false for the rules alone; `limit` left out for no limit; `timeout` in seconds, per
 * model call (left out, 900 with the judge model's reasoning on and 300 off); `switchKey` to name this run's pool in
 * place of another named; `retryFailed` to put the pool's failed claims back in it first; `judgeChecked` for a judge
 * model checked and found right, the garbage-judge alarm off for the run (JUDGE_ALARM), a trip's hold on its judge
 * model's following runs lifted, or the run ended, exit 3, when a trip named the model since it began, before its lift
 * (heldSince, namedSince). `sql` is the caller's client in place of `url`, never closed here; `env` what the run reads,
 * process.env when absent; `url` and `sql` name one database. `signal` stops the sweep after the thought in hand, as
 * the CLI's first signal does, and ends a wait of the naming's at once, 130 (0 for a following run), its pooling left
 * to the next run (a statement's once it ends when the run has no url to watch it from), where the CLI's signal ends
 * the process; `onPass` is handed the sweep's stop as its thoughts begin, whose second call aborts the model call in
 * hand too, and beside it the call's own abort (db/lease.ts's InHandAbort). A dry run hears neither: it reads on.
 *
 * The options a scheduler drives the sweep with, as it drives the claim passes (PRs 6a and 6b-1, sleep's since PR 6b-2):
 * `follow`, `admit`, the abort beside the stop, `stamper`, `session`, `banner`, `onStart` and `check`, each below. None
 * is the CLI's.
 */
export interface SubjectSweepOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  model?: boolean;
  limit?: number;
  timeout?: number;
  switchKey?: boolean;
  retryFailed?: boolean;
  judgeChecked?: boolean;
  dryRun?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  /**
   * The sweep's stop as its thoughts begin, and the call's own abort: abortInHand(olderThanMs) aborts the judge's call
   * in hand once it has run that long, each call's age from its own start — a thought the rules key, a provider pause,
   * a wait for a slot on the model-call seam's hook (SMD-3379 PR 2a) and the writes after an answer hold no call — and
   * its thought goes back to the pool, dated now, a later date a set-back gave it kept, by a following run once the
   * probe after the abort finds no hang (db/lease.ts's setBack), unanswered and so unjudged, its place under --limit
   * given back when it went back (one edited and pooled again, taken by another run or deleted meanwhile gives none
   * back), and the run goes on to its next claim, a following run's past its gate after a one-token call, given the
   * call's own limit, a provider not answering it waited out (PR 6b-1's review pass 6, the maintainer's choice),
   * unanswered past it, a hang of that thought, its claim marked or, marked already, failed as its own (review pass 7,
   * the maintainer's choice); one whose answer comes as it is aborted stands, answered. The sleep scheduler calls it
   * while its gate is closed (SMD-3379's N12), at most three of the sweep's calls aborted a period's hour since PR
   * 6b-2, as consolidation's.
   */
  onPass?: (stop: PassStop, abortInHand: InHandAbort) => void;
  /**
   * Whole seconds between a following run's claims at an empty pool: it waits that long and claims again, until its
   * stop or its --limit, where a run without it ends at the empty pool. A following run is a scheduler's: it is stopped
   * as a follower is, exit 0 (130 at once on the second stop; the thought in hand a first stop lets finish can end it
   * as 1, 2 or 3 do), and it does not start while a trip's hold on its judge model stands (judgeHeld): exit 3. Neither
   * a dry run's nor beside --judge-checked or --retry-failed, which no scheduler passes. It waits out the provider's
   * outage past its pauses, or hung, as a claim pass's follower does, a suspect that errs so again right after a probe
   * answered failed as its own, a hung one at its next hang in any following run, its claim marked (PR 6b-1), and its
   * start, to its first claim, waits out the database; the database lost past its start ends it, exit 1, for its caller
   * to start it again.
   */
  follow?: number;
  /**
   * The admit gate (db/lease.ts's Admit, SMD-3379 PR 1b): awaited before the pool's lock and naming, with the caller's
   * signal, which it needs, and before each claim, with the sweep's stop, so a run waiting at it holds no claim. A
   * thought a provider error put back is claimed again through it, as any is, the pool's name, another run's trip and
   * the thought's own edits read at its claim (review pass 3, cold read: a gate of its own before the call asked again
   * held the claim, which needed its lease kept, the claim read again and its losses counted apart, a seam in each
   * pass). A stop while it waits, or a gate answering after the stop, ends the run there, nothing more named, pooled or
   * claimed. A run the trip's hold keeps from starting is refused before any gate. Unused by a dry run.
   */
  admit?: Admit;
  /**
   * A following run's word through its caller's row (db/pass-stamp.ts; sleep.ts's `through`): `ok` at each poll that
   * finds the pool empty, and as the run ends, `failed` for an end of its own — a refusal, its own options' among them,
   * its naming or pooling broken off, the pool named away, the provider's refusal, the database lost past its start,
   * the judge's alarm, a throw — else `stopped`. It beats no row while it works through a pool: a scheduler's row is
   * the scheduler's to keep stamped. It hears the run's waits for the provider too, as a claim pass's caller does
   * (PR 6b-1): `startWait` while the run waits at its start for a judge model its probe found not answering,
   * `providerWait` while it waits out the provider's outage past its pauses, or hung, not through the pauses themselves
   * (review pass 1, the consumer's prototype). Its outage stamps no `failed` as it begins, where extraction's follower
   * does: sleep's row says that wait by the sweep's name, as it says re-embed's (PR 6b-2). Unused without `follow`.
   */
  stamper?: PassStamper | null;
  /**
   * Postgres settings the run's own client and its watching connection open with (connect.ts's `session`): a
   * scheduler's per-pass budget; the worker key's lookup opens its one connection without them, as the claim passes'
   * does. A statement past its statement_timeout at the run's start is thrown, as a claim pass's start-of-pass scan's
   * is, for the scheduler to read as its budget's: the naming's write too, whose wait has no end of its own but the
   * timeout, where the wait for writers polls and goes on, and one in the count of spent leases at the end of a run
   * that ends by itself, which a scheduler's follower does not reach. The pooling, a scan of every thought with no
   * current subject, runs exempt while watched (PR 6b-1, the maintainer's choice: on a large brain it can outlast the
   * budget, the pool then never filled and every sleep ending on it), its waits said and a stop cancelling it as
   * before, the budget set back after it; unwatched — its watching connection refused, as at a role's connection limit
   * — it keeps the budget, nothing else bounding it (review pass 1, run-it). One over a thought is the thought's or the
   * poll's, as a claim pass's was until SMD-2636 PR 4 (now its follower ends), not the run's (review pass 6, run-it: thrown, it ended the scheduler's sleep on its
   * budget): its own write's fails it (overBudget); its claim's, its read's, a put-back's or set-back's or the claim's
   * state read after one, its release's or its answer's window's costs the run its poll (lostPoll). Only the budget's:
   * another error there, an operator's cancel among them, is thrown as before. The run's hand-back of what it holds, at
   * its end, a lost poll or a second stop, waits up to RELEASE_WAIT whatever the budget, so a row held past a short
   * budget leaves no claim leased to its end, and one held longer holds the scheduler's stop no longer than
   * RELEASE_WAIT, or twice it when the stop lands during a lost poll's hand-back. An answer judged after its claim's
   * release (unread, or keyed) whose window write passes it is not in the window, the claim as released. Refused beside
   * `sql`, a caller's client, which it would not reach.
   */
  session?: SessionSettings;
  /**
   * False leaves out the start's lines — the rules and the judge, the egress line, the worker key's agent line or its
   * no-key warning, another judge model's held line — for a run a scheduler starts at every period, which says them
   * once. A refusal still says what it refuses.
   */
  banner?: boolean;
  /**
   * Hears the run's start, as a claim pass's caller does (db/worker-bootstrap.ts's StartResult, PR 6b-1): refused, and
   * which way, at each refusal of its start — its options' (`usage`), the egress gate's (`egress`), the tables' and the
   * grants' (`tables`), the worker key's (`identity`, `lookup`), another pool named (`key`), a following run's judge
   * model unserved or its endpoint refusing the probe (`model`, `provider`) — so a scheduler tells them apart; or
   * through, as the thoughts begin, unless a stop came first. A dry run's refusals are said, not heard: its options', a
   * migration missing and the pool's name unreadable end it, 2, the egress gate's, the grants', another pool's and the
   * capturers' it names as what a run would meet, reading on, reaching neither the worker key's lookup nor the probe. A
   * trip's hold is no start refusal, its 3 unheard: the scheduler reads the hold itself (judgeHeld).
   */
  onStart?: (r: StartResult) => void;
  /**
   * A following run's start alone, the sleep scheduler's check at its own start, as the claim passes take it (PR 6b-1):
   * the run's refusals, heard by onStart — the pool's name read and refused as the run would refuse it (`key`,
   * `tables`; review pass 1) — and its probe of the judge model, a model unserved or an endpoint refusing it refused
   * (`model`, `provider`), one not answering not waited for (`provider: "out"`), each pass waiting at its own start;
   * the database not answering waited out, as a following run's start does. It ends before the trip's hold is read and
   * before the run's first write but the worker key's lookup's, 0; a stop ends it 130, as a claim pass's check. With
   * `follow`, and not a dry run's.
   */
  check?: boolean;
  /**
   * A following run's claims bounded by date (SMD-3306 PR 6b-2): an instant on the database's clock, as text, past
   * which the run claims nothing — a claim pending, or a lease run out under its attempts, dated later is left, and with
   * none at or before it the run waits as at an empty pool. Sleep's bound is its period's start plus SET_BACK_AHEAD_MS,
   * so each thought set back before the period is asked once in it and one set back in it waits for the next (the
   * maintainer's choice, 2026-11-05), and the scheduler never stops the run mid-thought. One claimed past it, another
   * run having taken those before it between the read and the claim, goes back unasked, its date and attempt kept.
   * With `follow` alone.
   */
  claimsBy?: string;
}

/** A dry run's pages, of the pool's claims or of the thoughts with no current subject. */
const PAGE = 100;

/**
 * A thought the sweep takes: its text and the fingerprint read, the ticket it is filed under, its standing subjects'
 * facets and keys (by key; null when none stands) and their way and pass when they stand (at another text, or out of
 * date), and whether they are current at this text. Since 130 a thought's subjects are a set, one way's and one pass's
 * as every writer writes them (SMD-3306 PR 7a-3b-1); a raw writer's mix reads as the least way and pass by name, and
 * counts as current while any of its subjects is, so an out-of-date member a raw write left beside a current one stands
 * (no door writes such a mix, and before 130 none could stand: 111 allowed one standing subject a thought).
 */
type Candidate = {
  id: string; content: string; created_at: string | Date | null; metadata: Record<string, unknown> | null; fingerprint: string; filed: string | null;
  standing_ids: string[] | null; standing_keys: string[] | null; standing_by: string | null; standing_judge: string | null; current: boolean;
  /** A run's claim, not a dry run's: whether it carries a hang (HUNG_MARK), read as it is taken. */
  hung_before?: boolean;
};

/**
 * What the loop does with a claimed thought's claim: finish it, fail it (with why, and its line, `say`, said once the
 * failure lands: PR 6b-1's review pass 8, run-it, an edit's requeue took a claim as its call hung again, and the run
 * had said it failed as its own), or nothing — the pool has it again, it is gone, the finish ended it already (a
 * model's empty answer), or a dry run claimed none.
 */
type Done = { release: "succeeded" } | { release: "failed"; error: string; say: () => void } | { release: "none" } | { release: "none"; again: true };

/** The sweep, callable: the code the CLI exits with (the header's list). */
export async function sweepSubjects(opts: SubjectSweepOptions): Promise<number> {
  // Its model calls labelled with the pass, sleep's name for it, for the model-call seam's hook (SMD-3379 PR 2a, which
  // left the sweep's to whichever merged second: SMD-3306 PR 6b-2).
  return asPass("subjects", () => sweepPass(opts));
}

/** sweepSubjects' body, inside its pass's label. */
async function sweepPass(opts: SubjectSweepOptions): Promise<number> {
  /**
   * A following run's word through its caller's row (`stamper`): none without `follow`. Read first, so a refusal of the
   * run's own options says failed too (review pass 1, cold read: the refusals before the run's start said nothing).
   */
  const stamper = typeof opts.follow === "number" && opts.follow > 0 ? opts.stamper ?? null : null;
  /** Set as the run ends on claims it failed: its exit 1 is no end of its own. */
  const claimsEnd = { v: false };
  /** Whether the run is waiting on the provider, said through the row (providerWait): unsaid as it ends (PR 6b-1). */
  const waits = { provider: false };
  let code = 1;
  try {
    code = await sweepWith(opts, stamper, claimsEnd, waits);
    return code;
  } finally {
    if (waits.provider) await stamper?.providerWait?.(false).catch(() => {});
    // As it ends: failed for an end of its own — a refusal, its naming or pooling broken off, the pool named away, the
    // provider's refusal, the database lost, the judge's alarm, a throw — and stopped otherwise, claims it failed among
    // them, its last poll having said ok: a pass fails on its provider, not on a thought (extract-entities.ts's word).
    await stamper?.end(code === 2 || code === 3 || (code === 1 && !claimsEnd.v) ? "failed" : "stopped").catch(() => {});
  }
}

/** sweepSubjects, its row's word aside. */
async function sweepWith(opts: SubjectSweepOptions, stamper: PassStamper | null, claimsEnd: { v: boolean }, waits: { provider: boolean }): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  /**
   * A refusal of the run's start: said, heard by onStart as which it is (PR 6b-1, extract-entities.ts's way), 2; a dry
   * run's said alone (review pass 1, cold read and run-it: its usage refusals were heard).
   */
  const refused = (kind: StartRefusal, line: string): number => {
    err(line);
    if (opts.dryRun !== true) opts.onStart?.({ ok: false, refused: kind });
    return 2;
  };
  const env = opts.env ?? process.env;
  const MODEL = opts.model !== false;
  const DRY_RUN = opts.dryRun === true;
  const RETRY_FAILED = opts.retryFailed === true;
  const SWITCH_KEY = opts.switchKey === true;
  const JUDGE_CHECKED = opts.judgeChecked === true;
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) return refused("usage", urlProblem);
  // Refused rather than dropped (review pass 4, cold read: `--subjects rules --judge-checked` was taken in silence).
  if (JUDGE_CHECKED && !MODEL) return refused("usage", "--judge-checked turns off the judge model's garbage-judge alarm, and --subjects rules asks no judge model: drop one of them.");
  for (const [flag, v, rule] of [["--limit", opts.limit, { min: 1 }], ["--timeout", opts.timeout, { min: 1, max: MAX_CALL_TIMEOUT_S }], ["follow", opts.follow, { min: 0 }]] as const) {
    const problem = v == null ? null : numberProblem(flag, v, rule);
    if (problem !== null) return refused("usage", problem);
  }
  const FOLLOW_S = opts.follow ?? 0;
  // A following run is a scheduler's: it reads nothing on as a dry run does, and no one is there to have checked its
  // judge (PR 6a).
  // Nor --retry-failed, an operator's word that the failures' cause is mended, whose count a start begun again would
  // read as 0 (PR 6b-1's review pass 3, cold read).
  if (FOLLOW_S > 0 && (DRY_RUN || JUDGE_CHECKED || RETRY_FAILED)) {
    return refused("usage", `follow is a scheduler's run of the sweep, and ${DRY_RUN ? "a dry run writes, pools and asks nothing to follow" : JUDGE_CHECKED ? "--judge-checked is a hand run's word that the judge was checked, which no scheduler can give" : "--retry-failed is an operator's word that the failures' cause is mended, which no scheduler can give"}: drop one of them.`);
  }
  // A following run's start alone, as the claim passes take it (PR 6b-1).
  if (opts.check === true && (FOLLOW_S <= 0 || DRY_RUN)) return refused("usage", "check is a following run's start: pass follow beside it, and no dry run.");
  // A scheduler's bound on the claims, a following run's alone (PR 6b-2).
  if (opts.claimsBy !== undefined && (FOLLOW_S <= 0 || DRY_RUN)) return refused("usage", "claimsBy bounds a following run's claims: pass follow beside it, and no dry run.");
  if (opts.session !== undefined && opts.sql != null) return refused("usage", "session settings reach a client the sweep opens itself: pass url without sql, or set them on your client.");
  // The gate before the pool hears the caller's signal alone, the run's stop not handed out yet (review pass 1, cold
  // read: without one it waited on a signal that never aborts).
  if (opts.admit !== undefined && opts.signal === undefined && !DRY_RUN) {
    return refused("usage", "admit needs signal: the gate is awaited before the pool, and only the caller's signal stops a run waiting there.");
  }
  const LIMIT = opts.limit ?? 0;
  const resolved = resolveEmbedConfig(env as EmbedEnv);
  const TIMEOUT_S = opts.timeout ?? subjectsTimeoutS(subjectReasoningOn(resolved));
  if (opts.sql != null && noUrl && env.OB1_WORKER_KEY && !DRY_RUN) {
    // The pass's rule (extract-entities.ts's run): the key resolves on a connection of its own.
    return refused("usage", "extract-entities.ts --subjects resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
  }
  if (opts.signal?.aborted && !DRY_RUN) {
    err(STOPPED_EARLY);
    // A following run's stop is its end, wherever it lands (review pass 1, cold read and run-it: before the pool, 130);
    // a check's is a claim pass's check's, 130 (PR 6b-1's review pass 1).
    return FOLLOW_S > 0 && opts.check !== true ? 0 : 130;
  }
  const cfg: EmbedConfig = { ...resolved, timeoutMs: TIMEOUT_S * 1000 };
  const sql = opts.sql ?? openSql(opts.url as string, { max: 2, session: opts.session });
  /**
   * Set as the run's thoughts begin: a database lost before then, a following run's start begins again (below);
   * `pinned`, as a beginning reaches the pool's pin, the database answering it a moment ago.
   */
  const through = { v: false, pinned: false };
  /** Whether the start's wait for the database has said it is not answering, across the start's beginnings. */
  const startSaid = { down: false };
  /**
   * The worker key as a beginning of the start resolved it, kept by each beginning after it (sweep); `unresolved` once
   * a beginning's lookup could not, so the one that does says its agent line whatever the banner (PR 6b-1's review pass
   * 5, cold read: resolved unsaid, under the first beginning's warning that rows would carry no agent id).
   */
  const keyFound = { v: null as { agentId: string | null; actor: string | undefined } | null, unresolved: false };
  try {
    for (let step = 0, first = true; ; first = false) {
      try {
        return await sweep(sql, cfg, {
          MODEL, DRY_RUN, LIMIT, RETRY_FAILED, SWITCH_KEY, JUDGE_CHECKED, FOLLOW_S, env, url: opts.url ?? "", session: opts.session, signal: opts.signal,
          onPass: opts.onPass, admit: opts.admit, stamper, banner: opts.banner !== false && first, claimsEnd, waits, onStart: opts.onStart, claimsBy: opts.claimsBy,
          check: opts.check === true, through, startSaid, keyFound, refused, out, err,
        });
      } catch (e) {
        // A database that stops answering before the pages, or between them, ends the sweep in words, not a trace
        // (review pass 2).
        if (!databaseUnavailable(e)) throw e;
        // A following run's start, its thoughts not begun, begins again once the database answers — the pool's lock,
        // its name, naming and pooling, and the pool's count, past the reads it waits out itself (atStart) — as a claim
        // pass's start waits up to its first claim (PR 6b-1's review pass 2, run-it and the consumer's prototype: lost
        // there, the database ended the run 1, which a scheduler reads as the pass ending by itself). Each is the same
        // again: the lock went with its connection, a naming or pooling not committed is not there, a naming committed
        // is found named, and a pooling whose mark was lost is pooled again, as the next run would pool it. A stop
        // during the wait ends the run, as at its start; its start's lines are not said again, nor a worker key it
        // resolved looked up again. The wait starts again from its first step once a beginning reached the pool's pin,
        // the database there a moment ago (review pass 3, cold read: grown with every loss, it slept minutes with the
        // database back).
        if (FOLLOW_S > 0 && !through.v) {
          if (!startSaid.down) {
            err(`  the database is not answering (${String((e as Error)?.message ?? e).slice(0, 300)}) — waiting for it, then the run's start begins again`);
            startSaid.down = true;
          }
          if (through.pinned) step = 0;
          through.pinned = false;
          await sleepUnless(outageWait(step++), opts.signal ?? new AbortController().signal);
          if (opts.signal?.aborted) {
            err(STOPPED_EARLY);
            return opts.check === true ? 130 : 0;
          }
          continue;
        }
        err(databaseDown(e));
        return 1;
      }
    }
  } finally {
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

async function sweep(
  sql: SQL,
  cfg: EmbedConfig,
  o: {
    MODEL: boolean; DRY_RUN: boolean; LIMIT: number; RETRY_FAILED: boolean; SWITCH_KEY: boolean; JUDGE_CHECKED: boolean; FOLLOW_S: number;
    env: Record<string, string | undefined>; url: string; session?: SessionSettings; signal?: AbortSignal; onPass?: (stop: PassStop, abortInHand: InHandAbort) => void;
    admit?: Admit; stamper: PassStamper | null; banner: boolean; claimsEnd: { v: boolean }; waits: { provider: boolean }; onStart?: (r: StartResult) => void; check: boolean; claimsBy?: string;
    through: { v: boolean; pinned: boolean }; startSaid: { down: boolean }; keyFound: { v: { agentId: string | null; actor: string | undefined } | null; unresolved: boolean };
    refused: (kind: StartRefusal, line: string) => number; out: Writer["out"]; err: Writer["err"];
  },
): Promise<number> {
  const { MODEL, DRY_RUN, LIMIT, RETRY_FAILED, SWITCH_KEY, JUDGE_CHECKED, FOLLOW_S, env, refused, out, err } = o;
  /** Whether the garbage-judge alarm reads this run's answers: a run that asks the model, unless --judge-checked. */
  const ALARM = MODEL && !DRY_RUN && !JUDGE_CHECKED;
  const reasoning = subjectReasoning(cfg);
  const reasoningOn = subjectReasoningOn(cfg);
  /** The effort each question sends, which a refusal names (review pass 2): nothing at the default, with reasoning on. */
  const sentEffort = cfg.subjectReasoning.reasoning_effort;
  const judgeKey = subjectModelKey(cfg.judgeModel, reasoningOn);
  const POOL = subjectPoolKey(MODEL, reasoningOn);
  /** What a run would be refused, said by a dry run, which goes on to count (review pass 2). */
  const wouldRefuse: string[] = [];
  /** The start's lines, which a scheduler starting the run at every period leaves out (`banner`). */
  const say = o.banner ? out : () => {};
  say(`  subjects: the rules (${subjectRuleKey("metadata")}, ${subjectRuleKey("first_line")})${MODEL ? `, then ${cfg.judgeModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}, reasoning ${reasoning}, at most ${cfg.timeoutMs / 1000} s a call (${judgeKey})${JUDGE_CHECKED ? "; the garbage-judge alarm off (--judge-checked)" : ""}` : ", no model (--subjects rules)"}${FOLLOW_S ? `; following, polling an empty pool every ${FOLLOW_S} s` : ""}`);
  if (MODEL) {
    say(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
    // A policy that refuses whatever the row: stop before the first call, as the pass does (SMD-1903).
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "asked for its subject", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !DRY_RUN) return refused("egress", `\n  ${blanket} Or run --subjects rules, which asks no model, from a pool of its own (with --switch-key while another is named).`);
    if (blanket) wouldRefuse.push("the egress gate refuses every row (the egress line above)");
  }
  /**
   * A read of the start's, before the admit gate: a following run's, and so `check`'s, outlasts the database going away
   * (worker-bootstrap.ts's throughOutage), as a claim pass's start does (PR 6b-1, the maintainer's choice: sleep starts
   * the sweep at every period and meets a restarting database there, and its start check would end the scheduler on a
   * check ending otherwise); past the gate, a following run's start begins again once the database answers
   * (sweepWith). Null when the caller's stop ends the wait. A run by hand meets the error.
   */
  const atStart = <T,>(read: () => Promise<T>): Promise<T | null> =>
    FOLLOW_S > 0 ? throughOutage(read, { wake: o.signal ?? new AbortController().signal, said: o.startSaid, out, err }) : read();
  /** A stop in the start's waits, said: 130 under `check`, as a claim pass's check's, else a following run's end, 0. */
  const startStopped = (): number => {
    err(STOPPED_EARLY);
    return o.check ? 130 : 0;
  };
  // A following run's probe of its judge model, one token, before any claim (PR 6b-1, a claim pass's rule, SMD-2599): a
  // model the provider does not serve, or an endpoint refusing the call, refuses the start; one not answering is waited
  // for at the run's start, past the trip's hold (review pass 1, the consumer's prototype: a held run probed first), or
  // under `check` said and not waited for. A run by hand, a dry run and the rules alone probe nothing.
  const probe = (wake?: AbortSignal) => probeChat(cfg.chat, cfg.judgeModel, Math.min(cfg.timeoutMs, PROBE_CAP.ms), wake);
  /**
   * The start's refusal of what a probe found — the judge model unserved, or the endpoint refusing the call — or null.
   */
  const probeRefused = (p: Probe): string | null => p.state === "missing"
    ? `\n  ${cfg.chat.base} does not serve ${cfg.judgeModel}, OB1_JUDGE_MODEL, at start (${p.why.slice(0, 300)}).\n` +
      "  A following run refuses this before it claims anything: pull the model, or set OB1_JUDGE_MODEL to one the provider serves."
    : p.state === "refused"
      ? `\n  ${cfg.chat.base} refuses a one-token call at start (${p.why.slice(0, 300)}).\n` +
        "  A following run refuses this before it claims anything: check the chat endpoint's key (OB1_CHAT_API_KEY, else OB1_LLM_API_KEY) and its base URL (OB1_CHAT_BASE_URL, else OB1_LLM_BASE_URL)."
      : null;
  const doorRows = await atStart(() => sql`SELECT to_regprocedure(${DOOR}) IS NOT NULL AS door, to_regprocedure(${CLOSE}) IS NOT NULL AS close`);
  if (doorRows === null) return startStopped();
  const [{ door, close }] = doorRows as { door: boolean; close: boolean }[];
  if (!door || !close) {
    return refused("tables", `\n  ${door ? "close_thought_subjects is missing" : "record_thought_subjects is missing"}: a thought's subjects as a set are migration 130's. Apply it first:\n    cd db && bun migrate.ts --url …`);
  }
  // The door's and the pool's grants, asked before any model call: a role that cannot write a subject is refused here,
  // not at its first write with a question already spent (review pass 1). A dry run says it instead.
  const grantRows = await atStart(() => sql`
    SELECT has_any_column_privilege('thought_facets', 'INSERT') AND has_any_column_privilege('thought_facets', 'UPDATE')
       AND has_any_column_privilege('thoughts', 'UPDATE')
       AND has_any_column_privilege('derivations', 'INSERT') AND has_any_column_privilege('derivations', 'UPDATE') AS can,
           has_table_privilege('thought_work_claims', 'SELECT') AND has_table_privilege('thought_work_claims', 'INSERT')
       AND has_table_privilege('thought_work_claims', 'UPDATE')
       AND has_any_column_privilege('ob1_config', 'INSERT') AND has_any_column_privilege('ob1_config', 'UPDATE') AS pools`);
  if (grantRows === null) return startStopped();
  const [{ can, pools }] = grantRows as { can: boolean; pools: boolean }[];
  if ((!can || !pools) && !DRY_RUN) {
    return refused("tables", `\n  This role cannot ${can ? "claim from the subject pool: it needs" : "write a thought's subject: record_thought_subjects needs"} ${can ? POOL_GRANTS : DOOR_GRANTS}. Grant them, or run the sweep as a role that holds them.`);
  }
  if (!can) wouldRefuse.push("this role cannot write a thought's subject");
  if (!pools) wouldRefuse.push("this role cannot claim from the subject pool");

  let agentId: string | null = null;
  let actor: string | undefined;
  if (!DRY_RUN && o.keyFound.v !== null) {
    // A start begun again keeps the worker key an earlier beginning resolved: looked up again, a database just back
    // could refuse the lookup its connection (too many connections), the rows then unattributed, or under a policy
    // admitting the actor alone the run refused (PR 6b-1's review pass 3, run-it).
    ({ agentId, actor } = o.keyFound.v);
  } else if (!DRY_RUN) {
    // The agent line and the no-key warning are the start's, left out with it; a key that could not resolve is warned
    // of whatever the banner (extract-entities.ts's rule), and so is its agent line once a later beginning resolves it.
    // The lookup's own outage thrown for a following run to wait out, as a claim pass's start does (lookupOutage).
    const id = await atStart(() => workerIdentity(o.url, env, {
      noKeyWarning: o.banner ? "  ⚠  OB1_WORKER_KEY is not set: the subjects' lineage rows will carry no agent id. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS." : "",
      write: o.keyFound.unresolved ? out : say,
      warn: (l) => { if (l) err(l); },
      outage: FOLLOW_S > 0 ? lookupOutage : undefined,
    }));
    if (id === null) return startStopped();
    if (!id.ok) return refused("identity", id.message);
    agentId = id.identity.agentId;
    actor = id.identity.keyName;
    if (MODEL && env.OB1_WORKER_KEY && actor === undefined) {
      const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
      if (again) return refused("lookup", `\n  ${regateMessage("asked for its subject", again)}`);
    }
    // Kept once resolved, or with no key to resolve: a lookup the database refused, at too many connections, is tried
    // again at the next beginning (review pass 4, cold read: kept unresolved, the whole run went unattributed).
    if (!env.OB1_WORKER_KEY || actor !== undefined) o.keyFound.v = { agentId, actor };
    else o.keyFound.unresolved = true;
  }

  /**
   * The pool's name and its pooling's mark as `c` reads them, and the refusals they bring, a dry run's said as what a
   * run would meet: a role that cannot read them (`tables`), another pool named without --switch-key (`key`), and while
   * none is named, a capturing role the first naming would fail (`tables`). A run reads them under the pool's lock;
   * `check` reads them plain (PR 6b-1's review pass 1, cold read and the consumer's prototype: the check ended before
   * them, and a scheduler's start passed a run its first sleep refused for good). A number is the refusal's exit.
   */
  const readPool = async (c: SQL): Promise<{ named: string | null; filled: string | null } | number> => {
    let named: string | null, filled: string | null;
    try {
      const keys = (await c`SELECT key, value FROM ob1_config WHERE key IN ('subject_pool_key', 'subject_pool_filled')`) as { key: string; value: string }[];
      named = keys.find((k) => k.key === "subject_pool_key")?.value || null;
      filled = keys.find((k) => k.key === "subject_pool_filled")?.value || null;
    } catch (e) {
      if (sqlState(e) !== "42501") throw e;
      return refused("tables", `\n  This role cannot read the subject pool's name (${(e as Error).message}): the sweep reads ob1_config, thoughts, thought_facets and derivations.`);
    }
    // Another pool named: a run under this key would move the trigger's thoughts to it and pool every thought with no
    // current subject again, and a run under the other after it would pool them all again — asked for, as the pass's own
    // key change is (review pass 1: a rules run, or a trial with OB1_SUBJECT_REASONING off, renamed the pool unasked).
    if (named !== null && named !== POOL && !SWITCH_KEY) {
      const why = `the subject pool is ${named}; this run's is ${POOL} (another rule, question or reasoning, or --subjects rules)`;
      if (!DRY_RUN) {
        return refused("key", `\n  Refusing to sweep under a pool other than the one ob1_config names without --switch-key: ${why}.\n` +
          `  A run under it would name it, so new and edited thoughts join it, and pool every thought with no current subject\n` +
          `  again, those the model named nothing for among them, as a run under ${named} after it would. If that is the\n` +
          `  intent, pass --switch-key; if OB1_SUBJECT_REASONING or --subjects rules is simply set otherwise here, fix that instead.`);
      }
      wouldRefuse.push(`${why}, and it needs --switch-key`);
    }
    // The first pool named: 113's trigger writes a work claim as the role that captures or edits, so a login role that
    // can fire it — INSERT on thoughts, or UPDATE of their content or metadata — but cannot make that claim would fail
    // its every capture (review pass 1). requeue_thought_work's upsert reads the conflict and sets seven columns: SELECT,
    // INSERT and UPDATE on the table (review pass 2: INSERT and UPDATE alone failed too). Once a pool is named,
    // preflight holds a capturing role to them. A role that cannot read ob1_config is not asked about: 016's trigger
    // already refuses its every capture and text edit, and 113's its ticket edits, pool or no (review pass 4: the
    // enrichment recipe's role, SELECT and UPDATE on thoughts alone, was refused for a failure it already has). Read by
    // column, the two the triggers read, so a role granted those alone is asked about too (review pass 5). Nor is a
    // role reached only through SET ROLE.
    if (named === null) {
      const [{ failing }] = (await c`
        SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) AS failing
          FROM pg_roles r
         WHERE r.rolcanlogin AND has_column_privilege(r.oid, 'ob1_config', 'key', 'SELECT') AND has_column_privilege(r.oid, 'ob1_config', 'value', 'SELECT')
           AND (has_any_column_privilege(r.oid, 'thoughts', 'INSERT')
                OR has_column_privilege(r.oid, 'thoughts', 'content', 'UPDATE') OR has_column_privilege(r.oid, 'thoughts', 'metadata', 'UPDATE'))
           AND NOT (has_table_privilege(r.oid, 'thought_work_claims', 'SELECT') AND has_table_privilege(r.oid, 'thought_work_claims', 'INSERT')
                    AND has_table_privilege(r.oid, 'thought_work_claims', 'UPDATE'))`) as { failing: string | null }[];
      if (failing !== null) {
        const line = `naming the pool would fail the captures of ${failing}: 113's trigger writes a work claim as the role that captures, and they cannot SELECT, INSERT and UPDATE thought_work_claims`;
        if (!DRY_RUN) {
          return refused("tables", `\n  Refusing to name a subject pool: ${line}. Grant them that (GRANT SELECT, INSERT, UPDATE ON thought_work_claims TO <role>, or the worker group: cd db && bun migrate.ts --url … --grant <role> --groups worker), then run again.`);
        }
        wouldRefuse.push(line);
      }
    }
    return { named, filled };
  };

  // The start check ends here (PR 6b-1, the claim passes' rule): the pool's name read and refused as the run would
  // refuse it, the judge model probed, before the trip's hold, which the scheduler reads itself (judgeHeld), and before
  // the run's first write but the worker key's lookup's, a judge model not answering not waited for: a following run
  // waits for it at its own start.
  if (o.check) {
    const checked = await atStart(() => readPool(sql));
    if (checked === null) return startStopped();
    if (typeof checked === "number") return checked;
    let checkOut: string | null = null;
    if (MODEL) {
      const first = await probe(o.signal);
      if (o.signal?.aborted) return startStopped();
      const own = probeRefused(first);
      if (own) return refused(probeRefusal(first), own);
      if (first.state === "out") checkOut = first.why;
    }
    if (checkOut !== null) err(`  ${cfg.judgeModel} is not answering at start (${checkOut.slice(0, 200)}) — a following run waits for it at its own start`);
    o.onStart?.({ ok: true, provider: checkOut === null ? "up" : "out" });
    return 0;
  }

  // No current subject: none standing at the thought's text, or one found under another rule's key or an older
  // question's, or a model's found with its reasoning off when the question is asked with it on, or one the ticket the
  // thought is filed under disagrees with — a metadata rule's whose ticket moved or went, or another way's on a thought
  // filed since — which the fingerprint, the text's alone, does not see (review pass 4: a ticket moved before 113, or
  // under another pool, was never pooled at a naming). `after`, a page's cursor, bounds the facets read too, so a dry
  // run's pages each read from their cursor, not from the first facet (review pass 5: its pages read every facet before
  // them, a dry run before a naming quadratic in the thoughts). A rule's set is current here whatever that rule now
  // finds at the same text, where a claim's rulesAgree asks for the rule's keys exactly and narrows it: a set wider
  // than its rule finds is not pooled, so a rule that comes to find another set has its version bumped
  // (SUBJECT_RULE_VERSIONS) to be asked again (SMD-3306 PR 7a-3b-1's review pass 3, run-it), as the header rule's r3
  // was when it came to find sets (PR 7a-3b-2).
  const noCurrentSubject = (c: SQL, after = NIL_ID) => c`
    NOT EXISTS (
      SELECT 1 FROM thought_facets f JOIN derivations d ON d.artifact_kind = 'subject' AND d.artifact_id = f.id
       WHERE f.thought_id = t.id AND f.thought_id >= ${after}::uuid AND f.kind = 'subject' AND f.valid_until IS NULL
         AND d.input_fingerprints[1] = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))
         AND ${currentSubjectSql(c, reasoningOn)}
         AND (CASE WHEN f.payload->>'by' = 'metadata' THEN f.payload->>'key' = 'ticket:' || ${filedTicketSql(c)}
                   ELSE ${filedTicketSql(c)} IS NULL END) IS TRUE)`;
  const NO_CURRENT_SUBJECT = noCurrentSubject(sql);
  /**
   * A thought's standing subjects, one row however many stand (`s`, joined beside `t`): their facets and keys by key,
   * and their way and pass. A plain join gave a row a subject (SMD-3306 PR 7a-3b-1: a set's thought taken once for
   * each, its dry run counting it so).
   */
  const STANDING = sql`LEFT JOIN LATERAL (
      SELECT array_agg(f.id::text ORDER BY f.payload->>'key', f.id) AS ids, array_agg(f.payload->>'key' ORDER BY f.payload->>'key', f.id) AS keys,
             min(f.payload->>'by') AS way, min(f.payload->>'judge_key') AS judge
        FROM thought_facets f
       WHERE f.thought_id = t.id AND f.kind = 'subject' AND f.valid_until IS NULL) s ON true`;
  /** A thought's columns for the sweep, its standing subjects beside it (`t` and STANDING's `s`). */
  const CANDIDATE = sql`t.id, t.content, t.created_at, t.metadata, COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) AS fingerprint, ${filedTicketSql(sql)} AS filed,
           s.ids AS standing_ids, s.keys AS standing_keys, s.way AS standing_by, s.judge AS standing_judge,
           NOT ${NO_CURRENT_SUBJECT} AS current`;

  // The pool's name, its naming and its pooling, one run at a time: a run takes the pool's lock, a session advisory lock
  // on a connection of its own, before it reads the name, so two runs at a key's change do not both pool, the second
  // requeueing what the first had claimed or finished (review pass 1). A dry run takes none. Each statement here runs
  // on that connection, which a caller's client of one connection lends whole. Each wait here hears the caller's stop
  // and says what it waits on (review pass 7: the stop, handed out as the thoughts begin, waited out each one): the
  // pool's lock and the writers' transactions are polled, and a statement that waits on the server — the naming's
  // write of the name, the pooling — is watched from a connection of the run's own, which names the pids the server says
  // hold it up and cancels it on a stop (review pass 8: a lock timeout's retry read its holders off pg_locks, which
  // missed a request queued ahead of it and a prepared transaction, spinning without a word or the stop, and counted
  // transactions that held nothing up; the naming's write waited on writes in flight unsaid; Bun's client does not
  // cancel a query waiting on the server).
  /** The pool's window as ob1_config keeps it now, read whole (readJudgeWindow); none for a role that cannot read it. */
  const windowNow = async (c: SQL): Promise<JudgeWindow> => {
    try {
      const [row] = (await c`SELECT value FROM ob1_config WHERE key = ${JUDGE_WINDOW_KEY}`) as { value: string }[];
      return readJudgeWindow(row?.value, POOL);
    } catch (e) {
      // Refused for the name too, said there.
      if (sqlState(e) !== "42501") throw e;
      return readJudgeWindow(null, POOL);
    }
  };
  /**
   * The window's last trip as the run began, before the pool's lock and the naming's waits: one written since, by a run
   * beside this one, stops this one (review pass 3, cold read: read at the first claim, a trip during the waits went
   * unseen).
   */
  let tripBase: string | null = null;
  let named: string | null = null, filled: string | null = null, newPool = false;
  /**
   * What the window's trips hold, in words (judgeHeld): each model held with the trip that holds it, its lift a run of
   * one thought, never the pool asked with the alarm off (review pass 1, cold read: "a run with --judge-checked",
   * followed, asked the whole pool unguarded, after a trip on unread answers too, which PR 5b's review pass 4 had
   * closed). `left`, how many of the last trip's hand-back are still pending, is offered to the models that trip named,
   * when its answers naming nothing tripped it alone (review pass 3, cold read: kept as at the trip, the count went
   * stale as they were asked, and was offered to a model an earlier trip of unread answers held).
   */
  const heldLine = (w: JudgeWindow, left: number) => {
    const offered = w.nothing && left > 0 ? w.held.filter((m) => heldSince(w, m) === w.tripped) : [];
    return `The garbage-judge alarm holds the pool's following runs, a scheduler's, of ${andList(w.held.map((m) => `${cleanForDisplay(m)} (tripped at ${cleanForDisplay(heldSince(w, m))})`))}: once the model is checked, a run of it with --judge-checked --limit 1 lifts its hold (a run of another judge model is not held, and lifts nothing)` +
      (offered.length ? `; if ${offered.length === 1 ? cleanForDisplay(offered[0]) : `one of ${andList(offered.map(cleanForDisplay))}`} is right already, thoughts that truly have no subject tripped it, and a run of it with --judge-checked --limit ${left} asks the ${left} the trip handed back still pending, first in the pool, with the alarm off, lifting its hold too` : "");
  };
  /** How many of the last trip's hand-back are still pending, for heldLine: none offered on a trip unread answers made. */
  const leftOf = async (w: JudgeWindow): Promise<number> => {
    if (!w.nothing || w.back.length === 0) return 0;
    try {
      const [{ n }] = (await sql`SELECT count(*)::int AS n FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'pending' AND thought_id = ANY(${sql.array(w.back, "TEXT")}::uuid[])`) as { n: number }[];
      return n;
    } catch (e) {
      // Refused for the pool too, said there.
      if (sqlState(e) !== "42501") throw e;
      return 0;
    }
  };
  /**
   * The stamps of the trip that held the run's judge model as it began, and of the last trip that named it, held or
   * lifted, null when none did: its lift is of that hold alone, and a trip naming the model since refuses it (review
   * passes 2 to 4).
   */
  let heldAtStart: string | null = null, namedAtStart: string | null = null;
  /**
   * A stop's code, before the thoughts begin as after: a following run's stop is its end, 0 (review pass 1, cold read
   * and run-it: 130 in the naming's waits).
   */
  const stoppedCode = FOLLOW_S > 0 ? 0 : 130;
  /**
   * A statement past a scheduler's statement_timeout (`session`; sleep.ts's statementTimedOut, its rule): at the run's
   * start thrown, as a claim pass's start-of-pass scan's is, for the scheduler to read as its budget's; over a thought,
   * the thought's or the poll's (overBudget, lostPoll; review pass 6). One under a role's or the database's own
   * timeout, a hand run's, ends the naming's write and the pooling in words (review pass 1, cold read: they ended 1,
   * which a scheduler reads as a pass ending by itself, where every other statement's was thrown), and is thrown
   * elsewhere, as an operator's cancel ("user request") is.
   */
  const budgetTimedOut = (e: unknown): boolean =>
    o.session !== undefined && sqlState(e) === "57014" && /statement timeout/i.test(String((e as Error)?.message ?? ""));
  // The trip's hold (PR 6a), read before the pool's gate, so a held run waits at no gate first (review pass 2, cold
  // read): a following run, a scheduler's, does not start under it, exit 3, since no one is there to pass
  // --judge-checked; a hand run is told, and asks; --judge-checked lifts it once the pool is settled below; a run of a
  // model it does not hold is told whose it is, with its start's lines.
  if (MODEL) {
    const w = await atStart(() => windowNow(sql));
    if (w === null) return startStopped();
    heldAtStart = heldSince(w, cfg.judgeModel);
    namedAtStart = namedSince(w, cfg.judgeModel);
    if (ALARM) tripBase = w.tripped;
    if (heldAtStart !== null) {
      const left = await atStart(() => leftOf(w));
      if (left === null) return startStopped();
      if (FOLLOW_S > 0) {
        err(`\n  ${heldLine(w, left)}; this run follows with ${cfg.judgeModel}, so it does not start (db/subject-sweep.ts, JUDGE_ALARM).` +
          `\n    Check OB1_JUDGE_MODEL (${cfg.judgeModel}), the chat endpoint and OB1_SUBJECT_REASONING; once the model is right, a hand run with --judge-checked --limit 1 lifts its hold.`);
        return 3;
      }
      // A run with --judge-checked says its lift as it lifts it.
      // Said so (review pass 5, run-it: told of the hold, a hand run that went on to answer well read as lifting it).
      if (!JUDGE_CHECKED || DRY_RUN) out(`  ${heldLine(w, left)}; this run, by hand, is not held, and lifts nothing`);
    } else if (w.held.length > 0 && o.banner) {
      // Another model's hold: said, so a run of another judge model, one with --judge-checked among them, is not read
      // as lifting it (review pass 1, run-it: such a run said nothing, the hold standing).
      const left = await atStart(() => leftOf(w));
      if (left === null) return startStopped();
      say(`  ${heldLine(w, left)}; this run's judge model, ${cfg.judgeModel}, is not held${JUDGE_CHECKED && !DRY_RUN ? ", so --judge-checked lifts none of it" : ""}`);
    }
  }
  /** Why the judge model did not answer the start's probe, when it did not. */
  let startOut: string | null = null;
  if (MODEL && FOLLOW_S > 0) {
    const first = await probe(o.signal);
    // A stop during the probe is the run's end, a following run's: nothing named, pooled or claimed.
    if (o.signal?.aborted) return startStopped();
    const own = probeRefused(first);
    if (own) return refused(probeRefusal(first), own);
    if (first.state === "out") startOut = first.why;
  }
  // A following run whose judge model did not answer the start's probe waits for it here, claiming nothing, before the
  // pool's gate, naming and pooling, said through the caller's row while it lasts (startWait, PR 6b-1: as a claim pass
  // waits at its start); a stop ends the wait, the run's end. A model that answers unserved, or an endpoint that
  // answers refusing, refuses the start then.
  if (startOut !== null) {
    const wake = o.signal ?? new AbortController().signal;
    const down = Date.now();
    err(`  ${cfg.judgeModel} is not answering at start (${startOut.slice(0, 200)}) — the run claims nothing until it does; it calls ${cfg.judgeModel} at ${cfg.chat.base} for one token after ${OUTAGE_MS.first / 1000} s, then doubling, every ${OUTAGE_MS.max / 60_000} min at most`);
    await o.stamper?.startWait?.(true);
    const answered = await probeUntil(() => probe(wake), wake, (p) => p.state !== "out").finally(() => o.stamper?.startWait?.(false));
    if (answered === null) return startStopped();
    const own = probeRefused(answered);
    if (own) return refused(probeRefusal(answered), own);
    out(`  ${cfg.judgeModel} answers after ${Math.round((Date.now() - down) / 1000)} s`);
  }
  // The admit gate before the pool (SMD-3379 PR 1b's rule for a pass's pool and counts, PR 6a): the naming and the
  // pooling are the run's first writes after its start. A stop while it waits ends the run, nothing named, pooled or
  // claimed: a following run as a follower stopped, 0.
  if (o.admit && !DRY_RUN && !(await admitted(o.admit, o.signal as AbortSignal))) {
    err("\n  stopped at the admit gate: the caller's signal was aborted; nothing was named, pooled or claimed");
    return stoppedCode;
  }
  const pin = DRY_RUN ? null : await sql.reserve();
  o.through.pinned = true;
  const db: SQL = pin ?? sql;
  let locked = false;
  /**
   * The connection a watched statement is watched from, opened and tried at the first on the run's url; "none" when
   * there is no url or it could not be opened, said, the statements then unwatched.
   */
  let second: SQL | "none" | null = null;
  /** The pin's client_connection_check_interval as it was, set back as the pin goes back to the caller. */
  let checkWas: string | null = null;
  /**
   * The pin's statement_timeout as the session set it, while the pooling runs exempt: set back as it ends, or as the
   * pin goes back.
   */
  let budgetWas: string | null = null;
  /** The line a stop ends the naming with: at the pool's lock, before the name is written, or before the pooling. */
  const stopLine = (stage: "lock" | "naming" | "pooling") => stage === "lock"
    ? "\n  stopped at the subject pool's lock: the caller's signal was aborted; nothing was named, pooled or claimed"
    : stage === "naming"
      ? `\n  stopped before pool ${POOL} was named: the caller's signal was aborted; nothing was named, pooled or claimed`
      : `\n  stopped before pool ${POOL} was pooled: the caller's signal was aborted; the pool is named, its pooling unfinished, nothing claimed, and the next run pools it`;
  /** A wait's line: "waiting", then "still waiting, after N s," (N from `since`), for `n` transaction(s) `rest`. */
  const sayWaiting = (saidAt: number, since: number, n: number, rest: string) =>
    out(`  ${saidAt === 0 ? "waiting" : `still waiting, after ${Math.round((Date.now() - since) / 1000)} s,`} for ${n} transaction(s) ${rest}`);
  /** A wait's pause; true, said, when the caller's stop came. */
  const stopped = async (ms: number, stage: "lock" | "pooling") => {
    if (o.signal) await sleepUnless(ms, o.signal);
    else await Bun.sleep(ms);
    if (!o.signal?.aborted) return false;
    err(stopLine(stage));
    return true;
  };
  /**
   * Runs `q`, a statement on the pin that can wait on a lock, watched from the run's own connection: held up past
   * NAMING_WAIT.quietMs, it says which pids hold it up — pg_blocking_pids, those whose locks it waits on and those
   * queued ahead of it, a prepared transaction as 0 — and again every NAMING_WAIT.sayMs; the caller's stop cancels it,
   * STOPPED, said, the cancel sent again at each poll the statement outlives (one that reaches it before its first
   * message is dropped), and its refusal said. Nothing more is sent on the pin until the last cancel has been: a cancel
   * reaching it idle is dropped, so none lands on a later statement. The watching connection is opened and tried
   * before the first statement; with no url, or one that cannot be opened, said, the statements run unwatched, a stop
   * heard between them (review pass 9: a connection refused at the role's limit, or a cancel refused, left the run deaf
   * to the stop without a word, and it named and pooled).
   */
  const watched = async <T>(stage: "naming" | "pooling", q: () => Promise<T>): Promise<T | typeof STOPPED> => {
    // A stop already come: the statement is not sent, where a cancel in the same tick could reach it before its first
    // message and be dropped (review pass 9, run-it: 8 runs of 400 deaf so).
    if (o.signal?.aborted) {
      err(stopLine(stage));
      return STOPPED;
    }
    if (second === null) {
      second = "none";
      if (o.url) {
        const tried = openSql(o.url, { max: 1, session: o.session });
        try {
          await tried`SELECT 1`;
          second = tried;
        } catch (e) {
          await tried.close().catch(() => {});
          out(`  the naming's waits go unwatched: a second connection could not be opened (${String((e as Error)?.message ?? e).slice(0, 200)}); a wait is not named, and a stop is heard between its statements`);
        }
      } else {
        out("  the naming's waits go unwatched: the run was lent a client and no url; a wait is not named, and a stop is heard between its statements");
      }
    }
    const watcher = second;
    if (watcher === "none") return await q();
    const [{ pid }] = (await db`SELECT pg_backend_pid() AS pid`) as { pid: number }[];
    const done = new AbortController();
    const wake = o.signal ? AbortSignal.any([done.signal, o.signal]) : done.signal;
    let cancelled = false, refused = false, pollFailed = false;
    const watching = (async () => {
      let blockedSince = 0, saidAt = 0;
      for (;;) {
        await sleepUnless(NAMING_WAIT.pollMs, wake);
        if (done.signal.aborted) return;
        if (o.signal?.aborted) {
          // Sent again at each poll the statement outlives, until it ends or the server refuses it.
          if (!refused) {
            // Set before the cancel's answer: the statement's 57014 can come first (review pass 9, run-it, mutant).
            cancelled = true;
            try {
              await watcher`SELECT pg_cancel_backend(${pid}::int)`;
            } catch (e) {
              cancelled = false;
              refused = true;
              out(`  the stop could not cancel the ${stage === "naming" ? "naming's write" : "pooling"} (${String((e as Error)?.message ?? e).slice(0, 200)}): it is heard once that ends`);
            }
          }
          await sleepUnless(NAMING_WAIT.pollMs, done.signal);
          if (done.signal.aborted) return;
          continue;
        }
        // Rows, not the int4[]: a bound query's comes back an Int32Array, whose map coerces. DISTINCT: a parallel
        // query's workers are its leader's pid again.
        let by: number[];
        try {
          by = ((await watcher`SELECT DISTINCT p FROM unnest(pg_blocking_pids(${pid}::int)) AS p ORDER BY p`) as { p: number }[]).map((r) => r.p);
        } catch (e) {
          if (!pollFailed) out(`  the ${stage === "naming" ? "naming's write" : "pooling"} could not be watched (${String((e as Error)?.message ?? e).slice(0, 200)}): its wait goes unnamed while that lasts`);
          pollFailed = true;
          continue;
        }
        if (by.length === 0) {
          blockedSince = 0;
          saidAt = 0;
          continue;
        }
        blockedSince ||= Date.now();
        if (Date.now() - blockedSince >= NAMING_WAIT.quietMs && Date.now() - saidAt >= NAMING_WAIT.sayMs) {
          const who = by.map((p) => (p === 0 ? "a prepared transaction" : `pid ${p}`)).join(", ");
          sayWaiting(saidAt, blockedSince, by.length, `the ${stage === "naming" ? `naming of pool ${POOL} waits on (${who}): writes in flight under the pool named lock its name, as may a transaction editing ob1_config; a stop leaves it named as it was` : `pooling waits on (${who}); a stop leaves the pooling to the next run`}`);
          saidAt = Date.now();
        }
      }
    })();
    // Cancelled before it ended: said, STOPPED. One that ended first ran whole, and the next check hears the stop.
    let r: T | typeof STOPPED = STOPPED;
    try {
      r = await q();
    } catch (e) {
      if (!cancelled || sqlState(e) !== "57014") throw e;
    } finally {
      done.abort();
      await watching;
    }
    if (r === STOPPED) err(stopLine(stage));
    return r;
  };
  /**
   * Waits until none of the virtual transactions `vxids` is open, saying which pids hold them, at once and again
   * every NAMING_WAIT.sayMs: false when the caller's stop came first.
   */
  const waitForWriters = async (vxids: string[], what: string): Promise<boolean> => {
    let saidAt = 0;
    for (const since = Date.now(); vxids.length > 0;) {
      const open = (await db`
        SELECT DISTINCT pid FROM pg_locks WHERE locktype = 'virtualxid' AND granted AND virtualxid = ANY(${`{${vxids.join(",")}}`}::text[]) ORDER BY pid`) as { pid: number }[];
      if (open.length === 0) return true;
      if (Date.now() - saidAt >= NAMING_WAIT.sayMs) {
        sayWaiting(saidAt, since, open.length, `${what} (pid ${open.map((r) => r.pid).join(", ")}); a stop leaves the pooling to the next run`);
        saidAt = Date.now();
      }
      if (await stopped(100, "pooling")) return false;
    }
    return true;
  };
  try {
    if (pin) {
      // The server ends the pin's statement in hand within a second of its client going, so a CLI a signal ended leaves
      // no write of the name, nor a pooling, running on, holding the pool's lock, to land later (review pass 9, cold
      // read: after Ctrl-C the naming's write, waiting on a write in flight, renamed the pool once that ended).
      [{ checkWas }] = (await pin`SELECT current_setting('client_connection_check_interval') AS "checkWas"`) as { checkWas: string }[];
      await pin`SELECT set_config('client_connection_check_interval', '1s', false)`;
      for (let told = false; ; told = true) {
        [{ locked }] = (await pin`SELECT pg_try_advisory_lock(hashtextextended('ob1:subject-pool', 0)) AS locked`) as { locked: boolean }[];
        if (locked) break;
        // Said when another run holds it, naming and pooling (review pass 2: the run waited without a word).
        if (!told) out("  waiting for another run holding the subject pool's lock (reading its name, or naming and pooling it)");
        if (await stopped(250, "lock")) return stoppedCode;
      }
      // A stop that came as the lock was won names nothing.
      if (o.signal?.aborted) {
        err(stopLine("lock"));
        return stoppedCode;
      }
    }
    // The pool: the one ob1_config.subject_pool_key names, into which 113's trigger puts new and edited thoughts, and
    // subject_pool_filled, the one whose pooling last finished. A sweep under another key names its own, with --switch-key
    // once another is named, and pools every thought with no current subject — requeued, since a pool used before keeps
    // its finished claims and a thought edited since must be asked again — once, at the change.
    const pooledBy = await readPool(db);
    if (typeof pooledBy === "number") return pooledBy;
    ({ named, filled } = pooledBy);
    newPool = named !== POOL || filled !== POOL;
    const unnamed = named === null ? "none was named" : `${named} was`;
    if (newPool && DRY_RUN) {
      const [{ n }] = (await db`SELECT count(*)::int AS n FROM thoughts t WHERE ${noCurrentSubject(db)}`) as { n: number }[];
      out(named === POOL
        ? `  pool ${POOL}: named, its pooling unfinished: a run pools the ${n} thought(s) with no current subject`
        : `  pool ${POOL}: not named (${unnamed}): a run names it and pools the ${n} thought(s) with no current subject`);
    } else if (newPool) {
      // Named first, its pooling marked unfinished, so a thought captured from here on joins it by the trigger; then the
      // thoughts with no current subject, each requeued (MATERIALIZED: every row's call is made, whatever the count reads
      // of it); then the pooling marked finished, so one that broke off is pooled again by the next run (review pass 1:
      // the pool stood named and its backlog was never pooled).
      // Watched: it waits for each write in flight under the pool named, which locks the name FOR SHARE. One that fails
      // otherwise ends the run in words, as the pooling does (review pass 9: a statement_timeout escaped as a trace).
      let naming: unknown;
      try {
        naming = await watched("naming", () => db`INSERT INTO ob1_config (key, value) VALUES ('subject_pool_key', ${POOL}), ('subject_pool_filled', '')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
      } catch (e) {
        if (databaseUnavailable(e) || budgetTimedOut(e)) throw e;
        const why = String((e as Error)?.message ?? e).slice(0, 300);
        const where = named === null ? "no pool is named" : `pool ${named} is named as it was`;
        // A privilege the start's check could not see, the tables', which a grant mends and running again does not
        // (review pass 4, claims audit: it said to run it again).
        if (sqlState(e) === "42501") return refused("tables", `\n  This role cannot name the subject pool (${why}): ${where}; naming it needs ${POOL_GRANTS}. Grant them, or run the sweep as a role that holds them.`);
        err(`\n  Naming pool ${POOL} broke off (${why}): ${where}; run it again.`);
        return 1;
      }
      if (naming === STOPPED) return stoppedCode;
      // A capture whose transaction was open as the pool was named may have read no pool, or the one before, in its
      // trigger, and the pooling cannot see it until it commits: each transaction holding a write lock on thoughts in
      // this database as the pool was named is waited for first, by its virtual transaction id (review pass 5: such a
      // capture was never pooled). One that takes the lock after this read fires its trigger after the naming
      // committed, and the trigger's read of the name, a statement of its own under READ COMMITTED, takes a snapshot
      // that sees it; the xids pg_snapshot_xip lists missed a capture whose xid followed the naming's, and counted
      // writers of any table in any database (review pass 6, run-it). One that holds no xid yet has written nothing, and
      // fires its triggers after this read (review pass 7, run-it: an empty UPDATE, or a COPY yet to write a row, was
      // waited for, and with no end to the wait would hold every naming up). The wait has no end of its own: it says which
      // pids it waits on, and a stop leaves the pooling to the next run (review pass 7: past a 30 s bound the pooling
      // was left unfinished, and while the writer stayed open every run waited, pooled again and asked again each
      // thought the model had named nothing for and each failed one). A capture under REPEATABLE READ or
      // SERIALIZABLE, whose trigger reads its transaction's snapshot, can predate the naming and is not waited for:
      // preflight refuses the first as the writers' default and warns of the second (068), and sees neither a client
      // opens itself (review pass 8, run-it: every such capture in flight missed). Blanking subject_pool_filled has the
      // next run pool again.
      const [{ vxids }] = (await db`
        SELECT COALESCE(array_agg(DISTINCT l.virtualtransaction), '{}')::text[] AS vxids FROM pg_locks l
         WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND l.relation = 'thoughts'::regclass AND l.mode = 'RowExclusiveLock' AND l.granted AND l.pid IS DISTINCT FROM pg_backend_pid()
           AND EXISTS (SELECT 1 FROM pg_locks x WHERE x.locktype = 'transactionid' AND x.granted AND x.virtualtransaction = l.virtualtransaction)`) as { vxids: string[] }[];
      if (!(await waitForWriters(vxids, "writing thoughts as the pool was named, so the pooling sees what they capture"))) return stoppedCode;
      // A stop since the naming, with no writer to wait for, is heard as the pooling is watched, before it is sent
      // (review pass 9: nothing heard it before the pooling, which ran whole). The pooling runs exempt from a
      // scheduler's statement_timeout (PR 6b-1, the maintainer's choice): a scan of every thought with no current
      // subject, it can outlast the budget on a large brain, the pool then never filled and every sleep ending on it.
      // Its waits are said and a stop cancels it as before; the budget is set back as it ends, or as the pin goes back
      // when it ended the run, for the claims after it. Only while watched: unwatched, nothing cancels it on a stop,
      // and the budget is all that bounds it (review pass 1, run-it: a role at its connection limit left the exempt
      // pooling deaf to its stop until its blocker let go).
      const watching = second as SQL | "none" | null;
      if (o.session?.statement_timeout !== undefined && watching !== null && watching !== "none") {
        const [{ v }] = (await db`SELECT current_setting('statement_timeout') AS v`) as { v: string }[];
        await db`SELECT set_config('statement_timeout', '0', false)`;
        budgetWas = v;
      }
      let pooled = -1;
      for (let retries = 0; pooled < 0;) {
        try {
          // A thought whose claim under the key a live run holds is left to it, its lease running (review pass 5: the
          // pooling set it pending, and another run asked the same text again while the first still had it). Watched:
          // an edit since the naming holds the claim its trigger wrote, a delete its thought, until it ends. Its
          // condition built on the run's client, not the pin, whose connection lost rejects each fragment built on it,
          // never sent, unhandled (PR 6b-1's review pass 2, run-it).
          const r = await watched("pooling", () => db`
            WITH pooled AS MATERIALIZED (
              SELECT requeue_thought_work(${POOL}, t.id) FROM thoughts t
               WHERE ${noCurrentSubject(sql)}
                 AND NOT EXISTS (SELECT 1 FROM thought_work_claims c
                                  WHERE c.thought_id = t.id AND c.work_type = ${POOL} AND c.status = 'claimed' AND c.ttl_expires_at >= now()))
            SELECT count(*)::int AS n FROM pooled`);
          if (r === STOPPED) return stoppedCode;
          [{ n: pooled }] = r as { n: number }[];
        } catch (e) {
          // A thought deleted under the pooling fails its claim's key (23503), and a deadlock is the server's to break:
          // each pooled again, three times at most. A deadlock with a transaction editing two thoughts the pooling
          // requeues fails the one whose own deadlock check finds the cycle, a check each makes deadlock_timeout after
          // it starts to wait: usually the later to wait, an edit joining the pooling's wait, 40P01, the caller's to
          // retry (review passes 8 and 9, run-it). Anything else ends the run, the pool named and its pooling unfinished.
          const state = sqlState(e);
          if ((state === "23503" || state === "40P01") && ++retries < 3) continue;
          if (databaseUnavailable(e) || budgetTimedOut(e)) throw e;
          if (state === "42501") {
            return refused("tables", `\n  This role cannot pool the thoughts (${String((e as Error)?.message ?? e).slice(0, 300)}): the pool needs ${POOL_GRANTS}. Pool ${POOL} is named, and a run as a role that holds them pools them.`);
          }
          err(`\n  Pooling the thoughts with no current subject broke off (${String((e as Error)?.message ?? e).slice(0, 300)}): pool ${POOL} is named, and the next run pools them; run it again.`);
          return 1;
        }
      }
      // The budget back as the pooling ends: the mark after it keeps it, as every statement but the pooling does.
      if (budgetWas !== null) {
        await db`SELECT set_config('statement_timeout', ${budgetWas}, false)`;
        budgetWas = null;
      }
      await db`INSERT INTO ob1_config (key, value) VALUES ('subject_pool_filled', ${POOL})
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      out(named === POOL
        ? `  pool ${POOL}: named, its pooling broken off before: the ${pooled} thought(s) with no current subject pooled now`
        : `  pool ${POOL}: named (${unnamed}), and the ${pooled} thought(s) with no current subject pooled; new and edited thoughts join it from here on`);
    }
  } finally {
    if (pin) {
      if (locked) await pin`SELECT pg_advisory_unlock(hashtextextended('ob1:subject-pool', 0))`.catch(() => {});
      if (checkWas !== null) await pin`SELECT set_config('client_connection_check_interval', ${checkWas}, false)`.catch(() => {});
      if (budgetWas !== null) await pin`SELECT set_config('statement_timeout', ${budgetWas}, false)`.catch(() => {});
      pin.release();
    }
    // Set inside `watched`, which control-flow analysis does not follow: the cast keeps the declared type.
    const watcher = second as SQL | "none" | null;
    if (watcher !== null && watcher !== "none") await watcher.close().catch(() => {});
  }
  // --judge-checked, the operator's word that the judge was checked and found right, lifts the trip's hold on the pool's
  // following runs of this run's judge model (PR 6a), under the window's lock, the trip's stamp and models kept, so no
  // run beside it reads a trip of its own in the write: another model's hold is that model's to be checked, and a trip
  // naming this model since the run began, which no one has seen, is not lifted, and ends the run, nothing claimed
  // (review pass 1, cold read: one flag let a trip's other model start again unchecked; run-it: a trip landing during
  // the naming's waits was lifted unseen; review pass 3, cold read: refused, the run went on, asking with the alarm off
  // the thoughts that trip had just handed back first in the pool).
  if (JUDGE_CHECKED && !DRY_RUN) {
    try {
      const lift = await sql.begin(async (tx: SQL) => {
        const [row] = (await tx`SELECT value FROM ob1_config WHERE key = ${JUDGE_WINDOW_KEY} FOR UPDATE`) as { value: string }[];
        const w = readJudgeWindow(row?.value, POOL);
        // Its own last trip moved: one naming this model since the run began, whatever trips naming others came after,
        // its hold standing or lifted by another run since (review pass 2, cold read: any later trip refused it; review
        // pass 3, cold read: read off the last trip's models, a trip naming it, then one naming others alone, was lifted
        // unseen; review pass 4, cold read: lifted by another run, its stamp gone with it, the run went on).
        const lastTrip = namedSince(w, cfg.judgeModel);
        // No stamp now where one stood: the window reset since the run began — deleted or edited by hand, another pool's,
        // or rewritten by a sweep before PR 6a — keeps no hold to lift nor trip to refuse: said, and the run goes on, as
        // a window edited by hand stops no run (review pass 5, cold read: refused, with an empty stamp).
        if (lastTrip === null && namedAtStart !== null) return { w, at: namedAtStart, lifted: false, held: false, elsewhere: false, reset: true };
        if (lastTrip !== namedAtStart) return { w, at: lastTrip ?? "", lifted: false, held: judgeHeld(w, cfg.judgeModel), elsewhere: false, reset: false };
        const at = heldSince(w, cfg.judgeModel);
        // Lifted by another run since this one began, on the trip it read: said, the run going on (review pass 4, run-it:
        // it said nothing, and asked with the alarm off as though it had lifted it).
        if (at === null) return heldAtStart === null ? null : { w, at: heldAtStart, lifted: false, held: false, elsewhere: true, reset: false };
        // The hand-back of the trip that held it, when its answers naming nothing tripped it alone, first in the pool
        // again, so --limit with the held line's count asks those (review pass 3, cold read: a claim pooled before them
        // and released since came first).
        // One another transaction holds is passed over, an edit pooling it again, as the hand-back passes it (review pass
        // 4, cold read: waiting on it under the window's lock, the lift could close a cycle with an edit of two of them,
        // and every judgement waited meanwhile).
        if (w.nothing && at === w.tripped && w.back.length > 0) {
          await tx`
            UPDATE thought_work_claims c SET enqueued_at = (SELECT LEAST(COALESCE(min(p.enqueued_at), now()), now()) - interval '1 second' FROM thought_work_claims p WHERE p.work_type = ${POOL} AND p.status = 'pending')
              FROM (SELECT w.thought_id FROM thought_work_claims w
                     WHERE w.work_type = ${POOL} AND w.status = 'pending' AND w.thought_id = ANY(${sql.array(w.back, "TEXT")}::uuid[])
                     FOR UPDATE OF w SKIP LOCKED) s
             WHERE c.work_type = ${POOL} AND c.thought_id = s.thought_id`;
        }
        // Its last trip's stamp kept, so a run that began before that trip and lifts after this one is refused.
        await tx`UPDATE ob1_config SET value = ${JSON.stringify({ ...w, held: w.held.filter((m) => m !== cfg.judgeModel) })} WHERE key = ${JUDGE_WINDOW_KEY}`;
        return { w, at, lifted: true, held: true, elsewhere: false, reset: false };
      });
      if (lift?.lifted) {
        const rest = lift.w.held.filter((m) => m !== cfg.judgeModel);
        out(`  --judge-checked: the hold the garbage-judge alarm's trip at ${cleanForDisplay(lift.at)} put on the pool's following runs of ${cfg.judgeModel} is lifted${rest.length ? `; its hold on ${andList(rest.map(cleanForDisplay))} stands, each that model's to check` : ""}`);
      } else if (lift?.elsewhere) {
        out(`  --judge-checked: the hold the garbage-judge alarm's trip at ${cleanForDisplay(lift.at)} put on the pool's following runs of ${cfg.judgeModel} was lifted by another run since this run began`);
      } else if (lift?.reset) {
        out(`  --judge-checked: the garbage-judge alarm's window keeps no trip on ${cfg.judgeModel} now, reset since this run began (deleted or edited by hand, or rewritten by an older sweep), so there is no hold to lift`);
      } else if (lift) {
        err(`\n  --judge-checked lifts no hold: the garbage-judge alarm tripped${namedAtStart === null ? "" : " again"} at ${cleanForDisplay(lift.at)}, after this run began, on answers from ${cfg.judgeModel}, and ${lift.held ? "its hold on the pool's following runs of it stands" : "another run with --judge-checked has lifted that hold since"}; nothing was claimed: check the judge again, then run again (db/subject-sweep.ts, JUDGE_ALARM).`);
        return 3;
      }
    } catch (e) {
      if (sqlState(e) !== "42501") throw e;
      err(`  --judge-checked could not lift the trip's hold on the pool's following runs (${(e as Error).message.slice(0, 200)}): the window is ob1_config's, which the pool's grants cover (${POOL_GRANTS}); the run goes on, the alarm off`);
    }
  }
  /**
   * How many failed claims --retry-failed returned: chosen for failing, which the alarm says of a run that returned
   * any, as the pass does of its first judgement after a --retry-* (review pass 2: a set of their ids grew with the
   * pool's failures, a million at about 160 MB).
   */
  let retried = 0;
  if (RETRY_FAILED && !DRY_RUN) {
    // extract-entities.ts's --retry-failed statement, under the pool's key, a forward date a set-back gave made the
    // pool's head, a second before the first claim pending, no later than now, an earlier date kept (review pass 6,
    // run-it: a hung thought failed as its own kept it, and --retry-failed --limit 1 asked a capture in its place;
    // review pass 7, run-it: dated now, it came after the captures pooled before the retry, still asked in its place),
    // and the pool's standing hang marks cleared, a fresh start with the provider (review pass 8, cold read: a failure
    // having replaced each mark it met, the retry cleared none).
    const [retry] = (await sql`
      WITH unmarked AS (
        UPDATE thought_work_claims SET last_error = NULL
         WHERE work_type = ${POOL} AND status IN ('pending', 'claimed') AND starts_with(last_error, ${HUNG_MARK}) RETURNING 1),
      retried AS (
        UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0,
               enqueued_at = CASE WHEN enqueued_at > now()
                                  THEN LEAST(now(), (SELECT min(p.enqueued_at) FROM thought_work_claims p WHERE p.work_type = ${POOL} AND p.status = 'pending') - interval '1 second')
                                  ELSE enqueued_at END
        WHERE work_type = ${POOL} AND status = 'failed' RETURNING 1)
      SELECT (SELECT count(*) FROM retried)::int AS n, (SELECT count(*) FROM unmarked)::int AS m`) as { n: number; m: number }[];
    retried = retry.n;
    out(`  --retry-failed: ${retried} failed claim(s) returned to the pool${retry.m ? `, ${retry.m} hang mark(s) cleared` : ""}`);
  }
  // Each count by the index on (work_type, status): the pool's rows still to do, not its history. A lease run out
  // under its attempts is a gone worker's, which a run's claim takes again (claim_thoughts' reaping): counted with what
  // is still to do (review pass 1: a run took one its pool line and progress had not counted, "1/0").
  const [pool] = (await sql`
    SELECT (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'pending')::int AS pending,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed')::int AS claimed,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed' AND ttl_expires_at < now() AND attempt_count < ${MAX_ATTEMPTS})::int AS expired,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed' AND ttl_expires_at < now() AND attempt_count >= ${MAX_ATTEMPTS})::int AS spent,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'failed')::int AS failed`) as { pending: number; claimed: number; expired: number; spent: number; failed: number }[];
  if (!(newPool && DRY_RUN && named !== POOL)) {
    // A lease run out at its last attempt is failed by the next claim's reaping: said here, and by a run that claims
    // (review pass 2: the run failed it without a word, and exited 0).
    const runOut = [pool.expired ? `${pool.expired} run out, taken again` : "", pool.spent ? `${pool.spent} run out at their last attempt, failed by the next claim` : ""].filter(Boolean).join("; ");
    out(`  pool ${POOL}: ${pool.pending} pending${pool.claimed ? `, ${pool.claimed} leased${runOut ? ` (${runOut})` : ""}` : ""}${pool.failed ? `, ${pool.failed} failed${RETRY_FAILED ? "" : " (--retry-failed asks them again)"}` : ""}${LIMIT ? `; this run takes at most ${LIMIT}` : ""}`);
  }

  /**
   * `seen`: the claims taken and finished, each in one of the buckets after it, so the summary's counts add up to it
   * (review pass 2: a thought the sweep ended at was counted and in none); a thought edited mid-sweep, or given a
   * subject elsewhere while the model was asked and handed back, is taken twice, so, and then its outcome, as --limit
   * counts it. `taken`, for --limit, counts that one too. `setBack`: those whose call the caller aborted (abortInHand),
   * put back unanswered, taken again when they come up. `overBudget`: those whose own write passed a scheduler's
   * statement_timeout, failed; `deadlocked`, those whose own write the server rolled back to break a deadlock, failed.
   * `ownError`: those the provider erred on again right after answering a probe, failed. `hungOwn`: those that hung the
   * provider again, their claims marked hung (HUNG_MARK), failed — one whose call was aborted in hand counted there,
   * out of setBack, as the probe after the abort finds it so, its place under --limit taken again. `pollsLost`, no
   * thoughts' count: the polls lost to it (lostPoll), a thought whose release one handed back taken twice, as an edited
   * one is. `subjects`, no thoughts' count either: the subjects written on the recorded ones, each of a set, one kept
   * standing not counted (SMD-3306 PR 7a-3b-2). `replaced` and `newKey` count within the recorded ones, `closed` the subjects closed on those the model
   * named nothing for (a set's each), `leftOutOfDate` within the rest, and `lost`, the claims no longer this worker's
   * when it released them, across them all: no bucket of their own; `lostFailed` the failed ones among the lost, and
   * those whose failure's release a lost poll handed back, which the failure count leaves out.
   */
  const n = { seen: 0, current: 0, metadata: 0, first_line: 0, model: 0, subjects: 0, replaced: 0, newKey: 0, kept: 0, named: 0, closed: 0, unread: 0, unanswered: 0, left: 0, leftOutOfDate: 0, stale: 0, rewritten: 0, gone: 0, refusedKey: 0, egress: 0, setBack: 0, lost: 0, lostFailed: 0, overBudget: 0, deadlocked: 0, pollsLost: 0, ownError: 0, hungOwn: 0 };
  let taken = 0;
  /**
   * The server's clock as the run first claims, null while it has not: its claims reap the pool's run-out leases, those
   * at their last attempt failed, so one failed since then failed while it claimed.
   */
  let claimedSince: string | null = null;
  let llmMs = 0;
  let calls = 0;
  /**
   * The provider's transient errors since its last answer, and the pause before the next claim: the thought such an
   * error failed goes back to the pool, first, and the run pauses holding no claim (TRANSIENT_PAUSES_MS), ending once
   * the provider has not answered after the last pause, where a following run waits it out (waitForProvider); a lost
   * poll's pause too (lostPoll).
   */
  let transients = 0, pauseMs = 0;
  /**
   * The thought whose streak began with an error that could be its own (followClassify's maybe-poison: a 5xx but 503, a
   * lost connection), the first since the provider last answered, a probe after a timeout among its answers, null else,
   * and that error's words: the outage's suspect whatever its streak's later errors, so a thought whose call crashes
   * the provider, which answers 503 as it comes back, is one (PR 6b-1's review pass 2, cold read: its last error a 503,
   * it made no suspect, and crashed the provider again at each outage's end, failed never), and a 500 among a storm's
   * 429s and 503s is not (review pass 3, run-it: read anywhere in the streak, it failed 21 good thoughts in 20 of 72
   * storm runs, 12 of them in a 429's or 503's words).
   */
  let streakPoison: string | null = null, streakPoisonWhy = "";
  /**
   * The streak's suspect a following run's outage put back first, for the claim after its wait to take: another thought
   * claimed in its place — it was edited in the wait and pooled again at the tail, another run took it, a hand-back came
   * first — and it is a suspect no longer, its next errors not right after the probe (PR 6b-1's review pass 4, run-it:
   * an edited suspect stayed one for the window, failed as its own when the provider next crashed as it was asked).
   */
  let suspectFirst: string | null = null;
  /**
   * A following run's outage of the provider (worker-bootstrap.ts's ProviderOutage, PR 6b-1, the maintainer's choice:
   * the claim passes' rule): past the pauses, or its model gone missing as it is pulled again, or a call timed out and
   * a probe out too, the thought goes back to the pool and the run waits for the provider (waitForProvider); the
   * thought in hand at the outage, a suspect when its streak's first error could be its own — a 5xx but 503, a lost
   * connection, not a 429 or 503, the provider holding calls back, nor a model being pulled (followClassify) — or when
   * its call hung, the probe after it out, not holding calls back, that errs so again right after a probe answered,
   * within suspectWindowMs, is its own. A streak's suspect goes back first, so, while the run is alone on its pool, it
   * is the thought claimed after each pause and after the wait, a streak one thought's, as a claim pass's retries in
   * place are (review pass 2, cold read and run-it: put back where it stood, after a pooling it went behind its ties,
   * and the suspect was whichever thought took the streak's last error, a good one failed, poisoned ones never); one
   * that made none goes behind the rest, its next errors no verdict's (review pass 3, cold read), and so does a hung
   * one, its hang marked on its claim (HUNG_MARK); behind the rest is 30 days ahead (SET_BACK_AHEAD_MS, backTo).
   */
  const suspectWindow = suspectWindowMs(cfg.timeoutMs);
  const outage = new ProviderOutage(Date.now, suspectWindow);
  /** Why the provider is down, when a following run is to wait for it before its next claim; null else. */
  let outageWhy: string | null = null;
  /**
   * What that wait follows: an outage begun (ProviderOutage's), or, none begun nor any suspect made, a hung thought
   * failed as its own, the probe after its timeout finding the provider out (`verdict`, PR 6b-1's review pass 6, cold
   * read), or a call aborted in hand by the caller, the probe after it finding the provider out (`abort`, review pass
   * 6, the consumer's prototype and the maintainer's choice) — unanswered past it (Probe's `unanswered`; review pass
   * 8: not refused nor erring), its thought marked hung (`abortHung`), or failed as its own, marked before
   * (`abortOwn`; review pass 7, the maintainer's choice).
   */
  let outageAfter: "outage" | "verdict" | "abort" | "abortHung" | "abortOwn" = "outage";
  /**
   * The thought whose call a following run's caller aborted in hand since its last claim, null else: the next claim
   * waits for a one-token call, given the call's own limit, sent past the gate, so no thought is asked into the
   * abandoned call on a provider that does not cancel, the provider out waited out, no outage begun nor any suspect
   * made (PR 6b-1's review pass 6, the consumer's prototype and the maintainer's choice: asked at once, the next
   * thought timed out behind it, failed unanswered or hung, and the thought holding it escaped, 16 of 34 innocents so
   * under sleep's N12); unanswered past it (Probe's `unanswered`: not refused nor erring), that thought hung it
   * (hangAborted), judged only when its set-back landed (`back`): one no longer this run's, or handed back by a lost
   * poll, leaves its hang unremembered, and dated now meanwhile, its claim work in its period, put back at the later
   * date it had (`was`) once the probe finds no hang (review pass 8, cold read and claims audit: judged so, a set-back
   * the budget cut went to a count of −1, and one taken from the run was counted under --limit twice). Sent past the
   * gate, so not while a live write holds the passes, though in flight as one begins, and the wait after it probes as
   * an outage's does (review pass 7, run-it). Written inside `one`, which control-flow analysis does not follow: the
   * cast keeps the declared type.
   */
  let probeAfterAbort = null as { row: Candidate; back: boolean; was: Date | null } | null;
  /**
   * The run's wait for the provider, said through the caller's row as a claim pass's is (providerWait, PR 6b-1): while
   * a following run waits out an outage, not through the pauses before one (review pass 1, the consumer's prototype:
   * said from the first error, a scheduler reading it as a claim pass's would set the sweep down on one 503), and
   * unsaid as the run ends (sweepSubjects).
   */
  const waitOnProvider = async (on: boolean): Promise<void> => {
    if (o.waits.provider === on) return;
    o.waits.provider = on;
    await o.stamper?.providerWait?.(on);
  };
  /** Whether the run's last hand-back of what it held landed (releaseHeld), for the stop line. */
  let handedBack = true;
  /**
   * Why the sweep ended early, the provider, the database or the role, with its code; null when it ran out of
   * thoughts, reached its limit or was stopped. Written inside `one`, which control-flow analysis does not follow: the
   * cast keeps the declared type (SMD-1932's way, as extract-entities.ts's configError).
   */
  let endedBy = null as { code: number; line: string } | null;
  const said = { unread: false, unanswered: false, refusedKey: false, egress: false, overBudget: false, deadlocked: false, pollsLost: false, ownError: false, hungOwn: false };
  /**
   * The judge's answer on the claim in hand, null until it answers (PR 5b): appended to the pool's window once the
   * claim is released (`judgedAlone`), or, for a claim this run finishes as named nothing, in the finish's own
   * transaction (`judgedIn`), then null again. A call that timed out or a row the egress gate refused is no answer, and
   * leaves it null; a key the door refused is one that gave a key.
   */
  let answered: WindowAnswer | null = null;
  /** The run's end the finish of the claim in hand wrote with it: the alarm's trip, or another run's found there. */
  let alarmed = null as { code: number; line: string } | null;
  /** A trip's counts once judgedIn decides it, for the line a database lost before it is written says. */
  let tripping = null as { bad: number; seen: number } | null;
  const started = Date.now();
  let reported = started;

  const workerId = `subjects-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const TTL_S = Math.ceil(cfg.timeoutMs / 1000) + LEASE_MARGIN_S;

  /**
   * Null while ob1_config names this run's pool; else the line the run stops with, exit 2. Read before each claim,
   * and, its row locked FOR SHARE, first in the transaction of each write, which a naming's update of it waits for: a
   * run under a key no longer named records and closes no subject more, so a subject recorded under the pool named stands
   * (review pass 7: a run under the key before a switch replaced, its call later, the subject the new pool's run had
   * recorded, whose claim was finished).
   */
  const poolMoved = async (c: SQL, lock: boolean): Promise<string | null> => {
    const [k] = (lock
      ? await c`SELECT value FROM ob1_config WHERE key = 'subject_pool_key' FOR SHARE`
      : await c`SELECT value FROM ob1_config WHERE key = 'subject_pool_key'`) as { value: string }[];
    if (k?.value === POOL) return null;
    const now = k?.value ? `now ${k.value}: another run named it while this one ran` : "no longer named: ob1_config.subject_pool_key was removed or blanked while this run ran";
    return `\n  The subject pool is ${now}, so this run, under ${POOL}, records no subject more and stops here; what it holds goes back to its pool.`;
  };

  /** The claims this run failed, its leases spent while it ran aside: what --retry-failed would put back of its own. */
  const failedHere = () => n.unanswered + n.unread + n.egress + n.refusedKey + n.overBudget + n.deadlocked + n.ownError + n.hungOwn - n.lostFailed;
  /** What to run once the model is right, the claims this run failed named. */
  const runAgain = (lead: string) => {
    const failed = failedHere();
    return failed > 0 ? `${lead} run again with --retry-failed, which puts back the pool's failed claims, the ${failed} this run failed among them.` : `${lead} run it again.`;
  };
  /**
   * What a --judge-checked run ending before its limit left of it, for the run again, so the backlog is not asked with
   * the alarm off (PR 6b-1's review pass 4, cold read: its --limit stale once part was done): named on each end that
   * says to run it again, the database's and a hand run's lost poll's beside the provider's, unless a scheduler's run,
   * which the lift lets run, has asked those thoughts since (review pass 5, cold read: those two ends said "run it
   * again", and a scheduler's run since took the hand-back, the line offering the backlog with the alarm off). `back`
   * the thought in hand counted already and handed back, at the release; none named when none is left, or in a dry run,
   * where nothing was asked (review pass 6, cold read and mutant: --limit 0, which the CLI and the API refuse, at the
   * limit's last release lost; one short there).
   */
  const leftOfLimit = (back = 0) => JUDGE_CHECKED && LIMIT && !DRY_RUN && LIMIT - n.seen + back > 0 ? `, with --judge-checked --limit ${LIMIT - n.seen + back}, what it left of its limit, unless a scheduler's run has asked those thoughts since, so the backlog is not asked with the alarm off` : "";

  /**
   * The claims of `ids` a trip hands back: each still finished with no subject standing — one asked again since and
   * keyed, failed or claimed is not — set pending again, at the pool's head, no later than now, so the next run asks
   * them first — though every claim pending is a set-back placed ahead (review pass 6, cold read: dated past captures
   * pooled since) — and --judge-checked with --limit their count asks them alone (review pass 4, run-it: at its tail, a
   * run with --judge-checked asked the pool's whole backlog first, the alarm off); one another transaction holds is
   * passed over, its end that one's, one that rolls back leaving it finished (review pass 3, cold read: waiting on it,
   * the hand-back could close a cycle with a pooling, or an edit of two thoughts, whose claims it locks in another
   * order). The thoughts handed back.
   */
  const handBack = async (tx: SQL, ids: string[]): Promise<string[]> => ((await tx`
    UPDATE thought_work_claims c SET status = 'pending', ttl_expires_at = NULL, attempt_count = 0, last_error = NULL, finished_at = NULL, worker_id = NULL,
           enqueued_at = (SELECT LEAST(COALESCE(min(p.enqueued_at), now()), now()) - interval '1 second' FROM thought_work_claims p WHERE p.work_type = ${POOL} AND p.status = 'pending')
      FROM (SELECT w.thought_id FROM thought_work_claims w
             WHERE w.work_type = ${POOL} AND w.status = 'succeeded' AND w.thought_id = ANY(${sql.array(ids, "TEXT")}::uuid[])
               AND NOT EXISTS (SELECT 1 FROM thought_facets f WHERE f.thought_id = w.thought_id AND f.kind = 'subject' AND f.valid_until IS NULL)
             FOR UPDATE OF w SKIP LOCKED) s
     WHERE c.work_type = ${POOL} AND c.thought_id = s.thought_id
    RETURNING c.thought_id::text AS id`) as { id: string }[]).map((r) => r.id);

  /**
   * The line of a run another run's trip stops: when, on whose answers, and the claim in hand handed back with them. The
   * window's strings shown clean, as the held line's are (review pass 8, cold read: printed raw, as the trip line's
   * models were).
   */
  const stampLine = (w: JudgeWindow, inHand: WindowAnswer | null) =>
    `\n  Another run's garbage-judge alarm tripped at ${cleanForDisplay(w.tripped)}${w.by.length ? `, on answers from ${andList(w.by.map(cleanForDisplay))}` : ""}, after this run began (db/subject-sweep.ts, JUDGE_ALARM), so this run, ${w.by.length === 0 || w.by.includes(cfg.judgeModel) ? "whose judge model is likely the same" : `of the same pool though its judge model, ${cfg.judgeModel}, gave none of those answers`}, stops here too` +
    (inHand ? `, the claim in hand, which it named nothing for, back in the pool with that run's${inHand.c ? ` (the out-of-date subject(s) it closed stay closed until it is asked again)` : ""}` : "") + "." +
    `\n    Check OB1_JUDGE_MODEL (${cfg.judgeModel}), the chat endpoint and OB1_SUBJECT_REASONING; ${runAgain("once the model is right,")}`;

  /** The line a database lost as a trip was written says: none of it, so the window still holds what tripped it. */
  const lostTrip = (e: unknown, inFinish: boolean) =>
    `\n  The database stopped answering (${String((e as Error)?.message ?? e).slice(0, 300)}) as the garbage-judge alarm tripped: ${tripping?.bad} of the judge model's last ${tripping?.seen} answers, across runs, gave no subject (db/subject-sweep.ts, JUDGE_ALARM).` +
    ` None of the trip was written, unless its commit landed as the connection went${inFinish ? `, nor the finish of the claim in hand, which goes back to the pool, at the latest when its lease runs out` : ""}: the window still holds the answers before this one, so the next answer giving no subject while they stand trips it again.` +
    `\n    Check OB1_JUDGE_MODEL (${cfg.judgeModel}), the chat endpoint and OB1_SUBJECT_REASONING; once the database answers, run it again.`;

  /**
   * The garbage-judge alarm (PR 5b), in the caller's transaction: the judge's answer appended to the pool's window,
   * kept across runs in ob1_config (JUDGE_WINDOW_KEY) and written under the row's lock, so the runs of a pool, side by
   * side or one after another, add to one window. Null while no more than JUDGE_ALARM.share of the whole window gave no
   * subject (10 of 48); else the run stops, exit 3, ahead of the 1 of claims failed and of a first signal's 130, the
   * claim it let finish having tripped it. In the same transaction the window's claims finished as named nothing go
   * back to the pool, by thought, whichever run finished them, while still finished with no subject standing, and the
   * window starts again, stamped with the trip and the models whose answers tripped it. Nothing else asks them again,
   * since a changed judge model leaves them finished (the pool's key names whether a model is asked, not which); when
   * they are, their answers count as any do. An out-of-date subject one of them had closed stays closed until it is
   * asked again, said. Those it could not read stay failed, for --retry-failed, as the pass leaves its malformed rows
   * failed. An answer that finds the window tripped by another run since this one began is that window's: its claim,
   * finished as named nothing, goes back too, uncounted, and the run stops (review pass 3, run-it: a run beside the
   * trip finished the claim in hand and counted it in the window after, which slid it out for good). `inFinish`: called
   * from the finish of a claim named nothing, which a second signal before the window's lock is had takes back.
   */
  const judgedIn = async (tx: SQL, entry: WindowAnswer, inFinish: boolean): Promise<{ code: number; line: string } | null> => {
    const window = Math.max(1, JUDGE_ALARM.window);
    // The row inserted if absent, then locked; one deleted between the two, the window reset by hand, is inserted
    // again (review pass 4, cold read: the lock found no row, and the run ended in a trace).
    let value: string | undefined;
    for (let tries = 0; tries < 3 && value === undefined; tries++) {
      await tx`INSERT INTO ob1_config (key, value) VALUES (${JUDGE_WINDOW_KEY}, '') ON CONFLICT (key) DO NOTHING`;
      value = ((await tx`SELECT value FROM ob1_config WHERE key = ${JUDGE_WINDOW_KEY} FOR UPDATE`) as { value: string }[])[0]?.value;
    }
    // A second signal during a finish, up to the window's lock, runs beside it queued there, takes the finish back, the
    // claim the stop's to hand back, unjudged: checked once the lock is had (review pass 4, cold read: checked before
    // the wait, one during it let the finish land judged, and a trip it made went unsaid).
    if (inFinish && hardStop.signal.aborted) throw ROLLED_BACK;
    const w = readJudgeWindow(value, POOL);
    if (w.tripped !== null && w.tripped !== tripBase) {
      const back = entry.f ? await handBack(tx, [entry.t]) : [];
      // Back with that trip's own, so the held line counts it among them (review pass 3, run-it: the line offered the
      // trip's ten, eleven back, and the second model's lift asked a thought of the backlog with the alarm off).
      if (back.length > 0) await tx`UPDATE ob1_config SET value = ${JSON.stringify({ ...w, back: [...new Set([...w.back, ...back])] })} WHERE key = ${JUDGE_WINDOW_KEY}`;
      return { code: 3, line: stampLine(w, back.length > 0 ? entry : null) };
    }
    w.answers.push(entry);
    while (w.answers.length > window) w.answers.shift();
    const unread = w.answers.filter((a) => a.g === "u").length;
    const nothing = w.answers.filter((a) => a.g === "n").length;
    const save = (next: JudgeWindow) => tx`UPDATE ob1_config SET value = ${JSON.stringify(next)} WHERE key = ${JUDGE_WINDOW_KEY}`;
    if (!judgeTrips(unread + nothing)) {
      await save(w);
      return null;
    }
    tripping = { bad: unread + nothing, seen: w.answers.length };
    const by = [...new Set(w.answers.filter((a) => a.g !== "k" && a.m !== "").map((a) => a.m))];
    const ids = [...new Set(w.answers.filter((a) => a.f).map((a) => a.t))];
    const back = new Set(ids.length === 0 ? [] : await handBack(tx, ids));
    const closed = new Set(w.answers.filter((a) => a.c && back.has(a.t)).map((a) => a.t)).size;
    const [{ stamp }] = (await tx`SELECT clock_timestamp()::text AS stamp`) as { stamp: string }[];
    // Held (PR 6a): the pool's following runs, a scheduler's, of each of the trip's models do not start under it until
    // a run of that model with --judge-checked; a window whose answers name no model holds this run's. An earlier trip's
    // holds not lifted stand beside them (review pass 1, run-it: another model's trip replaced the list, and the first
    // model's runs started again unchecked, to trip again).
    const tripModels = by.length ? by : [cfg.judgeModel];
    const heldNow = [...new Set([...w.held, ...tripModels])];
    // Each model the trip names stamped with it, an earlier trip's kept for the rest, held or lifted (review passes 3 and
    // 4, cold read).
    const namedAt = { ...Object.fromEntries(w.held.map((m): [string, string] => [m, heldSince(w, m) ?? stamp])), ...w.namedAt, ...Object.fromEntries(tripModels.map((m): [string, string] => [m, stamp])) };
    const earlier = w.held.filter((m) => !tripModels.includes(m));
    await save({ pool: POOL, answers: [], tripped: stamp, by, held: heldNow, namedAt, back: [...back], nothing: judgeTrips(nothing) });
    const gave = [unread ? `${unread} not JSON of the expected shape` : "", nothing ? `${nothing} naming nothing a key holds` : ""].filter(Boolean).join(", ");
    const models = by.length === 0 || (by.length === 1 && by[0] === cfg.judgeModel) ? cfg.judgeModel : `the answers giving no subject came from ${andList(by.map(cleanForDisplay))}; this run's is ${cfg.judgeModel}`;
    return {
      code: 3,
      line: `\n  ${unread + nothing} of the judge model's last ${w.answers.length} answers, across runs, gave no subject (${gave}), more than ${Math.round(JUDGE_ALARM.share * 100)}% of the ${window} the alarm reads (db/subject-sweep.ts, JUDGE_ALARM): the model, not the thoughts, is likely at fault, so the sweep stops here.` +
        `\n    Check OB1_JUDGE_MODEL (${models}), the chat endpoint and OB1_SUBJECT_REASONING. ` +
        (back.size > 0 ? `The ${back.size} thought(s) it named nothing for are back in the pool${closed ? `, and the out-of-date subject(s) it closed on ${closed} of them stay closed until each is asked again` : ""}. ` : "") +
        (retried > 0 ? `This run's --retry-failed returned ${retried} claim(s) chosen for failing: some of these thoughts may be at fault. ` : "") +
        runAgain("Once the model is right,") +
        // The hold's two ways out, whatever tripped it: a judge fixed but kept, a run of one thought checks it in, the
        // pool's backlog never asked with the alarm off (PR 6a, review pass 1). The way past a false alarm is the offer
        // after, made only on answers naming nothing.
        ` The trip holds the pool's following runs, a scheduler's, of ${andList(tripModels.map(cleanForDisplay))}${earlier.length ? ` (an earlier trip's hold on ${andList(earlier.map(cleanForDisplay))} stands)` : ""}: once the model is checked, a run of it with --judge-checked --limit 1 lifts its hold (a run of another judge model is not held, and lifts nothing).` +
        // Offered only when the answers naming nothing trip it by themselves, an unread answer being the judge's
        // failure whatever the thought, and with a limit, the thoughts handed back first in the pool (review pass 4:
        // offered after unread answers alone, cold read, or with no limit, run-it, it ran a judge through the pool's
        // backlog with the alarm off).
        (judgeTrips(nothing) && back.size > 0 ? ` If it is right already, thoughts that truly have no subject, asked together as a hand-back or a pooling again brings them, tripped it: --judge-checked --limit ${back.size} asks the ${back.size} handed back, first in the pool, with the alarm off, lifting its hold too.` : ""),
    };
  };

  /**
   * judgedIn for an answer whose claim this run did not finish as named nothing, in a transaction of its own once the
   * claim is released, the pool's name read first under its lock: the window is a pool named away's no more (review
   * pass 3, cold read: an old pool's answer after a switch overwrote the new pool's window). A database lost before a
   * trip ends the run as elsewhere, exit 1; lost at it, said, exit 3.
   */
  const judgedAlone = async (entry: WindowAnswer): Promise<{ code: number; line: string } | null> => {
    tripping = null;
    try {
      return await sql.begin(async (tx: SQL) => {
        const moved = await poolMoved(tx, true);
        return moved !== null ? { code: 2, line: moved } : await judgedIn(tx, entry, false);
      });
    } catch (e) {
      if (!databaseUnavailable(e)) throw e;
      return tripping === null ? { code: 1, line: databaseDown(e, leftOfLimit()) } : { code: 3, line: lostTrip(e, false) };
    }
  };

  /**
   * What this worker holds, back in the pool, its attempt not counted: under a scheduler's session it waits up to
   * RELEASE_WAIT whatever the budget, where a claim's row held by another transaction past a short budget left the claim
   * leased to its end, unsaid (review pass 2, run-it), and an unbounded wait held the scheduler's stop, which awaits it
   * (review pass 3, cold read). It returns how many went back.
   */
  const releaseHeld = () => sql.begin(async (tx: SQL) => {
    if (o.session !== undefined) await tx`SELECT set_config('statement_timeout', ${String(RELEASE_WAIT.ms)}, true)`;
    return ((await tx`SELECT release_claims_for_worker(${POOL}, ${workerId}) AS n`) as { n: number }[])[0].n;
  });
  /**
   * The thought in hand back in the pool, its attempt and its place under --limit given back: first (putBack) for a
   * pause or a following run's outage whose streak made it the suspect, last (lease.ts's setBack) for an outage it made
   * no suspect of, or hung, `aheadMs` past now (SET_BACK_AHEAD_MS, 30 days), behind every capture pooled in the next
   * 30 days, so the thoughts pooled since are asked before it, a hung one's claim marked so (`mark`, HUNG_MARK) (review
   * pass 5, the consumer's prototype and the maintainer's choice: placed at its set-back, which a budget's stop keeps,
   * a thought that hangs the provider led each later period, ahead of its live captures; review pass 6, the
   * maintainer's choice: one window ahead, a capture made later than that came after it, captured 100 minutes after a
   * sleep); counted by its claim when it is no longer this worker's (the one transient path's, review passes 3 and 4).
   */
  const backTo = async (row: Candidate, first: boolean, aheadMs = 0, mark: string | null = null): Promise<Done | false> => {
    try {
      if (first ? await putBack(row.id) : await setBack(sql, POOL, workerId, row.id, aheadMs, false, mark)) {
        taken--;
        return { release: "none", again: true };
      }
      if (hardStop.signal.aborted) return false;
      const [claim] = (await sql`
        SELECT c.status FROM thoughts t LEFT JOIN thought_work_claims c ON c.thought_id = t.id AND c.work_type = ${POOL}
         WHERE t.id = ${row.id}::uuid`) as { status: string | null }[];
      if (claim === undefined) n.gone++;
      else if (claim.status !== "claimed" && claim.status !== "succeeded" && claim.status !== "failed") n.stale++;
      else {
        n.unanswered++;
        n.lost++;
        n.lostFailed++;
      }
    } catch (x) {
      if (!databaseUnavailable(x)) throw x;
      endedBy = { code: 1, line: databaseDown(x, leftOfLimit()) };
      return false;
    }
    return { release: "none" };
  };
  /**
   * The thought whose call its caller aborted in hand, the probe after it unanswered (Probe's `unanswered`: no answer
   * within its limit, or the answer's body never arriving) — hung (the loop's probe after an abort): its claim,
   * pending since the abort's set-back and still this worker's, marked hung and placed 30 days ahead as a hung
   * thought's set-back is (backTo), or, marked already, failed as its own as a second hang is (one), counted and said
   * so (PR 6b-1's review pass 7, the maintainer's choice). What became of it: marked (`abortHung`), failed
   * (`abortOwn`), or null — no longer this worker's to mark, or the write refused, the hang unremembered.
   */
  const hangAborted = async (row: Candidate, why: string): Promise<"abortHung" | "abortOwn" | null> => {
    const [r] = (await sql`
      UPDATE thought_work_claims c
         SET status = CASE WHEN starts_with(c.last_error, ${HUNG_MARK}) THEN 'failed' ELSE c.status END,
             finished_at = CASE WHEN starts_with(c.last_error, ${HUNG_MARK}) THEN now() ELSE c.finished_at END,
             enqueued_at = CASE WHEN starts_with(c.last_error, ${HUNG_MARK}) THEN c.enqueued_at
                                ELSE GREATEST(c.enqueued_at, now() + make_interval(secs => ${SET_BACK_AHEAD_MS / 1000})) END,
             last_error = CASE WHEN starts_with(c.last_error, ${HUNG_MARK}) THEN ${`hung the provider again, so this thought's: ${why}`}
                               ELSE ${HUNG_MARK + why} END
       WHERE c.thought_id = ${row.id}::uuid AND c.work_type = ${POOL} AND c.worker_id = ${workerId} AND c.status = 'pending'
      RETURNING c.status`.catch(() => [])) as { status: string }[];
    if (r === undefined) return null;
    if (r.status !== "failed") return "abortHung";
    n.setBack--;
    n.hungOwn++;
    taken++;
    if (row.standing_keys !== null) n.leftOutOfDate++;
    sayOnce("hungOwn", `  ${row.id}: it hung the provider again (${why}): its claim fails as the thought's own; --retry-failed asks it again`);
    return "abortOwn";
  };
  /**
   * A following run's wait for the provider past its pauses, or hung (PR 6b-1, extract-entities.ts's waitForProvider as
   * it was before SMD-2636 PR 2 moved that onto re-embed's rules: no carry here, and a refusal left to the next call),
   * or after a hung thought failed as its own or a call aborted in hand, its thought marked hung or failed so
   * (outageAfter, no outage begun, so none ended): said through the caller's row while it lasts (providerWait), the
   * judge model probed on outageWait's schedule until it answers, or refuses, which the next call meets; false when the
   * run's stop ended it. No claim is held as it waits.
   */
  const waitForProvider = async (why: string): Promise<boolean> => {
    const down = Date.now();
    const after = outageAfter;
    outageAfter = "outage";
    const afterSaid = {
      outage: "the thought in hand is back in the pool, recorded nothing",
      verdict: "the thought in hand failed as its own, its call hung",
      abort: "the call in hand aborted by its caller",
      abortHung: "the call in hand aborted by its caller held it past a limit, its thought marked hung, 30 days ahead",
      abortOwn: "the call in hand aborted by its caller held it past a limit, its thought, marked hung before, failed as its own",
    }[after];
    err(`  the provider is not answering (${why.slice(0, 200)}) — ${afterSaid}; the run calls ${cfg.judgeModel} at ${cfg.chat.base} for one token after ${OUTAGE_MS.first / 1000} s, then doubling, every ${OUTAGE_MS.max / 60_000} min at most`);
    await waitOnProvider(true);
    try {
      if ((await probeUntil(() => probe(stop.signal), stop.signal, (p) => !isOut(p))) === null) return false;
      if (after === "outage") outage.end();
      transients = 0;
      streakPoison = null;
      streakPoisonWhy = "";
      out(`  the provider answers again after ${Math.round((Date.now() - down) / 1000)} s; the run claims again`);
      return true;
    } finally {
      await waitOnProvider(false);
    }
  };
  /**
   * The claim in hand back in the pool, its attempt not counted (release_claims_for_worker's rule, for one thought), at
   * the pool's head, as a trip's hand-back puts its claims: a provider's transient error's, so the claim after the
   * pause, or after a following run's outage, takes it again, and --limit and the held line's offer count what was
   * asked (review pass 4, cold read: at the pool's tail, the offered lift asked a backlog thought in its place, the
   * alarm off, and --limit 1 sent up to four). Not where it stood: a pooling's claims share one enqueued_at, and one
   * put back went behind its ties (PR 6b-1's review pass 2, run-it; pass 1 measured it, 10 of 10). False when the claim
   * is no longer this worker's. No later than a second before now, so a capture landing in its pause comes after it,
   * though it and every claim pending were set back far ahead before (review pass 6, run-it: a poison set back once was
   * never failed while captures landed in its pauses, each answer resetting its streak).
   */
  const putBack = async (id: string): Promise<boolean> => ((await sql`
    UPDATE thought_work_claims SET status = 'pending', ttl_expires_at = NULL, attempt_count = GREATEST(attempt_count - 1, 0),
           enqueued_at = LEAST(enqueued_at, now() - interval '1 second', (SELECT COALESCE(min(p.enqueued_at), now()) - interval '1 second' FROM thought_work_claims p WHERE p.work_type = ${POOL} AND p.status = 'pending'))
     WHERE thought_id = ${id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed'
    RETURNING 1 AS ok`) as { ok: number }[]).length > 0;
  // The stop, as the pass's (db/lease.ts's PassStop): the first after the thought in hand; the second the call in hand
  // too, returning the release of the claim in hand, which the CLI exits on (review pass 1: it returned at once, and
  // the CLI exited with the claim leased for its whole lease). A dry run writes nothing and asks nothing, and reads
  // on, as the pass's does.
  const stop = new AbortController();
  const hardStop = new AbortController();
  let ended = false;
  let hardRelease: Promise<unknown> | null = null;
  /**
   * Whether a claim landed after the second stop, its statement having waited through it: the stop's hand-back may have
   * run past it, so that hand-back's landing says nothing of what this run still holds (review pass 7, run-it).
   */
  let claimedPastHard = false;
  const passStop: PassStop = () => {
    if (ended) return null;
    if (!stop.signal.aborted) {
      stop.abort();
      return null;
    }
    hardStop.abort();
    hardRelease ??= releaseHeld().catch(() => null);
    return hardRelease;
  };
  /**
   * The judge's call in hand, for the caller's abortInHand beside the stop (db/lease.ts's inHandCalls, PR 6a): the run's
   * one worker, its entry waiting but while the call runs, so a thought the rules key, a provider pause and the writes
   * after an answer are passed over; inert once the run stops or ends.
   */
  const inCall = inHandCalls(() => stop.signal.aborted || ended);
  /**
   * The judge model's subject for a row, one call: the answer, an egress refusal, the thought left unanswered, or the
   * provider's transient error with a pause left, for one() to put the thought back; throws to end the sweep, or past
   * the pauses, or a call timed out with the probe after it out, the provider hung, holding calls back or its model
   * being pulled (TimedOutDown), for a following run to wait the provider out.
   */
  async function ask(row: Candidate): Promise<{ keys: string[]; answers: string[] | null } | { egress: string } | { unanswered: string } | { transient: true }> {
    const side = { content: row.content, createdAt: row.created_at, metadata: row.metadata ?? {}, writer: actorKindOf(row.metadata) };
    const subject = { kind: "extraction" as const, actor, metadata: row.metadata ?? undefined, content: row.content };
    const call = inCall.get(workerId);
    const t0 = Date.now();
    /** Whether a request was made (providerCall's gate refuses before any), and when its answer or error came. */
    let made = true, came = 0;
    // The call's age for abortInHand runs from its own start; the entry waits again once it settles (inCall).
    if (call) {
      call.waiting = false;
      call.since = t0;
    }
    try {
      // A wait for a slot on the model-call seam is not the call's time: the entry waits through it (SMD-3379 PR 2a).
      const a = await withCallWaits(callWaitsFor(() => inCall.get(workerId)),
        () => askOwnSubject(cfg, side, subject, call ? AbortSignal.any([hardStop.signal, call.abort.signal]) : hardStop.signal));
      came = Date.now();
      transients = 0;
      streakPoison = null;
      streakPoisonWhy = "";
      // Answered, a suspect no longer and its hang forgotten, its claim's mark cleared — this run's claim's alone, one
      // another run took keeping it (review pass 8, mutant) — whatever becomes of its write (PR 6b-1's review pass 3,
      // cold read: one whose write found its text moved stayed a suspect, and was failed as its own at an outage it
      // began), the call no longer in hand as it is, so sleep's N12 aborts nothing then (review pass 8, cold read); a
      // clear refused leaves the mark to the answer's write, so an end before that write lands — a hard stop, the pool
      // named away, a lost poll at the release, the database lost — leaves it.
      outage.settled(row.id);
      if (row.hung_before) {
        if (call) call.waiting = true;
        await sql`UPDATE thought_work_claims SET last_error = NULL WHERE thought_id = ${row.id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed' AND starts_with(last_error, ${HUNG_MARK})`.catch(() => {});
      }
      return { keys: a.keys, answers: a.answers };
    } catch (e) {
      came = Date.now();
      if (hardStop.signal.aborted) throw e;
      // The caller aborted the call in hand (abortInHand): told apart from a timeout or the provider's error.
      if (call?.aborted) throw new AbortedInHand();
      if (e instanceof ProviderError && e.kind === "egress") {
        made = false;
        return { egress: e.message };
      }
      const kind = classifyError(e);
      // A following run's call timed out, and a one-token call finds the provider out too: the provider hung, not the
      // thought, an outage, its thought a suspect (ProviderDown, which one() waits out), as a claim pass reads it
      // (PR 6b-1's review pass 2, cold read, run-it and the consumer's prototype: each timeout failed its thought
      // unprobed, so a hung provider failed the pool a thought a timeout as the scheduler's row read ok). One the probe
      // answers past is the thought's, as before; a stop during the probe ends the run, the thought dated 30 days ahead
      // as the probe began. As a claim pass's, a stopping run's timeout is the thought's, unprobed, and the probe is
      // given the call's own limit, a model busy with another pass's call answering it late, not read as hung; one
      // finding the model missing waits it out as pulled, no suspect (review pass 3, cold read: probed on a stop, the
      // thought was handed back each time, never failed; at 60 s a model busy with consolidation's 71 s call read as
      // hung). The claim's lease is renewed first, so it outlasts that probe, as the claim passes' heartbeats renew
      // theirs, a renewal refused leaving it as it was; a probe answered 5xx but 503 is the provider out too, and one
      // answered 429 or 503 the provider holding calls back, which makes no suspect, as its own errors' do (the
      // maintainer's rule; the claim passes make every thought in hand a suspect); and a probe that answers ends the
      // provider's streak, its next error the first since an answer (review pass 4, cold read: given the call's limit,
      // the probe outran the lease, another run reaping the claim and asking the thought too; a 503 answering it made a
      // suspect, twice failed as its own in the 503's words (run-it), and was recorded as no answer; a 500 after the
      // probe's answer was no streak's first).
      if (FOLLOW_S > 0 && kind === "thought" && timedOut(e) && !stop.signal.aborted) {
        if (call) call.waiting = true;
        await sql`SELECT renew_claims(${POOL}, ${workerId}, ${TTL_S})`.catch(() => {});
        // Dated 30 days ahead as the probe begins, where every end after it but a failure or a put-back first sets it,
        // so a stop of any kind during the probe, or a kill, leaves it behind the captures pooled since (review pass 7,
        // the consumer's prototype: a hard stop returned before pass 6's set-back of a cut probe, and the thought,
        // handed back at its pooled place, led the next period); a write refused leaves it as it was.
        await sql`UPDATE thought_work_claims SET enqueued_at = now() + make_interval(secs => ${SET_BACK_AHEAD_MS / 1000}) WHERE thought_id = ${row.id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed'`.catch(() => {});
        const p = await probeChat(cfg.chat, cfg.judgeModel, cfg.timeoutMs, stop.signal);
        if (stop.signal.aborted) throw e;
        if (isOut(p)) {
          const heldBack = p.state === "out" && /^(429|503)( |$)/.test(p.why);
          throw new TimedOutDown(`the call timed out after ${cfg.timeoutMs / 1000} s, and a one-token call ${p.state === "missing" ? "found the judge model missing" : heldBack ? "was held back" : "found the provider out too"} (${p.why.slice(0, 200)})`, p.state === "out" && !heldBack);
        }
        transients = 0;
        streakPoison = null;
        streakPoisonWhy = "";
      }
      if (kind === "thought") {
        // A timeout names the sweep's limit, which --timeout sets over the provider's knob the message names (review
        // pass 2).
        const atLimit = e instanceof ProviderError && e.kind === "timeout";
        return { unanswered: atLimit ? `timed out after ${cfg.timeoutMs / 1000} s, the sweep's limit a call, which --timeout sets` : (e as Error).message };
      }
      if (kind === "transient" && transients === 0 && followClassify(e) === "maybe-poison") {
        streakPoison = row.id;
        streakPoisonWhy = String((e as Error)?.message ?? e).slice(0, 300);
      }
      // The provider's transient error with a pause left: the thought goes back to the pool and the run pauses, holding
      // no claim and so no call (review pass 1, cold read: a pause counted as the call's was aborted by abortInHand);
      // past the last pause it ends the sweep.
      if (kind === "transient" && transients < TRANSIENT_PAUSES_MS.length) return { transient: true };
      throw e;
    } finally {
      if (call) call.waiting = true;
      if (made) {
        calls++;
        llmMs += (came || Date.now()) - t0;
      }
    }
  }

  /** Each kind said once, with the first thought it took: the summary counts the rest. */
  function sayOnce(kind: keyof typeof said, line: string): void {
    if (!said[kind]) err(line);
    said[kind] = true;
  }

  /**
   * A thought's own write transaction — the door's, or the finish of one named nothing — run again when the server
   * rolls it back to break a deadlock (40P01), up to DEADLOCK_TRIES in all: nothing of it landed, its checks read again
   * under the door's lock, and the answer in hand needs no new call (SMD-3306 PR 7a-3b-1's review pass 4, cold read and
   * run-it: failed at once, a one-off deadlock left the set standing under a scheduler, which never runs
   * --retry-failed). `again` resets what an attempt set outside its transaction. Past the hard stop, not run again.
   */
  const beginRetried = async <T>(fn: (tx: SQL) => Promise<T>, again: () => void = () => {}): Promise<T> => {
    for (let tries = 1; ; tries++) {
      try {
        return (await sql.begin(fn)) as T;
      } catch (e) {
        if (sqlState(e) !== "40P01" || tries >= DEADLOCK_TRIES || hardStop.signal.aborted) throw e;
        again();
      }
    }
  };

  /**
   * A thought's own write — the door's, or the finish of one named nothing — the server rolled back to break a deadlock
   * (40P01) each of DEADLOCK_TRIES times: since 130 a set's close or write moves several keys' threads, and a move
   * across two keys can still deadlock at its commit (130's NOT HERE). The thought failed, for --retry-failed, said
   * once and counted, as one past the budget is, and the run goes on, in any run (SMD-3306 PR 7a-3b-1's review pass 3,
   * cold read: rethrown, it ended the run, a scheduler's sleep with it).
   */
  const deadlocked = (row: Candidate, e: unknown): Done | false => {
    if (hardStop.signal.aborted) return false;
    n.deadlocked++;
    if (row.standing_keys !== null) n.leftOutOfDate++;
    const why = `the server rolled its write's transaction back to break a deadlock, ${DEADLOCK_TRIES} times (${String((e as Error)?.message ?? e).slice(0, 200)})`;
    return { release: "failed", error: why, say: () => sayOnce("deadlocked", `  ${row.id}: ${why}; --retry-failed returns it to the pool`) };
  };

  /**
   * A thought's own write — the door's, or the finish of one named nothing — past a scheduler's statement_timeout: the
   * thought failed, for --retry-failed, as a claim pass failed one on its own write until SMD-2636 PR 4 (now its pass
   * is held, sleep.ts), said once and counted,
   * and the run goes on, an answer it was asked judged as a failed one's is (review pass 6, run-it: thrown, it ended
   * the scheduler's sleep on its budget, cutting the other passes); past the hard stop, the stop's to hand back.
   */
  const overBudget = (row: Candidate, e: unknown): Done | false => {
    if (hardStop.signal.aborted) return false;
    n.overBudget++;
    if (row.standing_keys !== null) n.leftOutOfDate++;
    const why = `its write passed the scheduler's statement_timeout (${String((e as Error)?.message ?? e).slice(0, 200)})`;
    return { release: "failed", error: why, say: () => sayOnce("overBudget", `  ${row.id}: ${why}; --retry-failed returns it to the pool`) };
  };

  /**
   * A statement past a scheduler's statement_timeout over a thought but its own write — `what`: its claim, its read, a
   * put-back or set-back or the claim's state read after one, its release, its answer's window — costs the run its
   * poll, not its end, as one on a claim cost a claim pass's worker its until SMD-2636 PR 4 (sleep.ts; review pass 6, run-it: thrown, it
   * ended the scheduler's sleep on its budget, cutting the other passes): counted, and said once, naming the first.
   * What the run holds goes back, its attempt not counted, and the claim in hand not yet counted gives back its place
   * under --limit; a following run claims again through the gate after its follow or the provider's pause, the longer,
   * or ends at its limit, and one not following ends there, 1, its end's hand-back saying where it leaves the claims. A
   * stop, before the hand-back or during it, ends the run there, said so (review pass 7, cold read and run-it: one
   * during it was said as a poll to come, or ended 1; one before it, after a failure was said, left the claim pending
   * with nothing said of why). A release's lost poll (`counted`) names its thought among what the run left unless the
   * hand-back found no claim held, its count unknown when the hand-back failed too (review pass 7, cold read: one short
   * there). False ends the run.
   */
  const lostPoll = async (e: unknown, what: string, inHand: boolean, counted = false): Promise<boolean> => {
    n.pollsLost++;
    const why = `${what} passed the scheduler's statement_timeout (${String((e as Error)?.message ?? e).slice(0, 200)})`;
    const endAtStop = () => {
      sayOnce("pollsLost", `  ${why}: the run loses this poll, and its stop ends it there`);
      return false;
    };
    if (stop.signal.aborted) return endAtStop();
    let back: number | null = null;
    try {
      back = await releaseHeld();
    } catch (x) {
      if (databaseUnavailable(x)) {
        endedBy = { code: 1, line: databaseDown(x, leftOfLimit(counted ? 1 : 0)) };
        return false;
      }
    }
    if (inHand && back) taken--;
    if (stop.signal.aborted) return endAtStop();
    if (!FOLLOW_S) {
      endedBy = { code: 1, line: `\n  The sweep stops here: ${why}. Run it again${leftOfLimit(counted && back !== 0 ? 1 : 0)}.` };
      return false;
    }
    pauseMs = Math.max(pauseMs, FOLLOW_S * 1000);
    const held = back === null ? "what it held goes back as each lease runs out, or as the run ends" : back ? "what it held is back in the pool" : "it held no claim";
    sayOnce("pollsLost", `  ${why}: the run loses this poll, not its end; ${held}, and ${LIMIT && taken >= LIMIT ? "it ends at its limit" : `it claims again in ${Math.round(pauseMs / 1000)} s`}`);
    return true;
  };

  /**
   * One thought: current already, else the rules, else the model; what the door answered, counted, and what becomes of
   * its claim. False ends the sweep, the thought unfinished and its claim handed back. A dry run counts as a run would.
   */
  async function one(row: Candidate): Promise<Done | false> {
    // Current — the extraction pass gave it a current subject after it was pooled — finished, unasked: so long as the
    // rules agree now. A ticket it is filed under since a model keyed it, or another ticket than the one a rule
    // read, or none where one was, is read again (review pass 2: 113's trigger pooled it, and it was finished as
    // current, its fingerprint the text's alone).
    const found = ruleSubject(row);
    const rulesAgree = row.standing_by === "model" ? found === null : found !== null && sameKeys(found.keys, row.standing_keys) && found.by === row.standing_by;
    if (row.current && rulesAgree) {
      n.current++;
      return { release: "succeeded" };
    }
    let keys: string[], by: SubjectBy, judge: string, recipe: Recipe;
    if (found && DRY_RUN) {
      // The door keeps a subject found the same way by the same pass at a moved text, and replaces any other standing
      // one: counted as a run would count it.
      if (sameKeys(found.keys, row.standing_keys) && row.standing_by === found.by && row.standing_judge === subjectRuleKey(found.by)) n.kept++;
      else {
        n[found.by]++;
        if (row.standing_keys !== null) {
          n.replaced++;
          // A key the set did not hold (review pass 1: a set narrowed to one of its keys was counted a new key).
          if (found.keys.some((k) => !row.standing_keys!.includes(k))) n.newKey++;
        }
      }
      return { release: "none" };
    }
    if (found) {
      ({ keys, by } = found);
      judge = subjectRuleKey(found.by);
      recipe = subjectRecipe({ by: found.by });
    } else if (!MODEL || DRY_RUN) {
      n.left++;
      // One holding a subject found at another text or under an older rule or question: it stands until a model's
      // answer replaces it. Under --subjects rules the claim is finished: the rules' pool is done with the thought, and
      // a run with the model pools it again.
      if (row.standing_keys !== null) n.leftOutOfDate++;
      return DRY_RUN ? { release: "none" } : { release: "succeeded" };
    } else {
      let a: Awaited<ReturnType<typeof ask>>;
      try {
        a = await ask(row);
      } catch (e) {
        if (hardStop.signal.aborted) return false;
        // The caller aborted the call in hand (abortInHand, PR 6a): the thought goes back to the pool, dated now, its
        // attempt not counted, unanswered and so unjudged, and the run goes on; one no longer this run's — an edit
        // pooled it again, or its lease ran out and another run took it — is counted lost too. A date a set-back after
        // an outage gave it, past now, is kept (PR 6b-1's review pass 7, cold read: dated now, a thought set back
        // 30 days ahead and aborted in hand led again, sleep's N12 aborting the sweep's calls often) — a following
        // run's put back at it once the probe after the abort finds no hang, dated now until then, so the claim is
        // work in its period while the probe runs (review pass 8, the consumer's prototype: dated ahead, it was none,
        // and a forward drain ended the period under the probe, the hang never judged) — and a following run's next
        // claim waits for a one-token call past its gate (probeAfterAbort), which marks it hung should that call go
        // unanswered, set first, so a set-back that loses its poll still has it (review pass 7, cold read).
        if (e instanceof AbortedInHand) {
          const aborted = { row, back: false, was: null as Date | null };
          if (FOLLOW_S > 0) probeAfterAbort = aborted;
          try {
            if (FOLLOW_S > 0) aborted.was = ((await sql`SELECT enqueued_at FROM thought_work_claims WHERE thought_id = ${row.id}::uuid AND work_type = ${POOL}`) as { enqueued_at: Date }[])[0]?.enqueued_at ?? null;
            // Its place under --limit given back when it went back, as the pass's is: the limit counts thoughts done
            // (review pass 1), and one found deleted or taken by another run is done here (review pass 2, cold read).
            if (await setBack(sql, POOL, workerId, row.id, 0, FOLLOW_S === 0)) {
              n.setBack++;
              taken--;
              aborted.back = true;
            } else if (((await sql`SELECT EXISTS (SELECT 1 FROM thoughts WHERE id = ${row.id}::uuid) AS there`) as { there: boolean }[])[0].there) {
              n.setBack++;
              n.lost++;
            } else n.gone++;
          } catch (x) {
            if (!databaseUnavailable(x)) throw x;
            endedBy = { code: 1, line: databaseDown(x, leftOfLimit()) };
            return false;
          }
          return { release: "none" };
        }
        if (stop.signal.aborted) return false;
        const kind = classifyError(e);
        // A following run waits the provider out as a claim pass's follower does (PR 6b-1, the maintainer's choice):
        // past the pauses, or its model gone missing as it is pulled again, or hung, a call timed out and a probe out
        // too (TimedOutDown), the thought goes back to the pool unrecorded — first when its streak made it the suspect,
        // behind the rest when it made none or hung — and the run probes until the provider answers. A thought that
        // errs so again right after a probe answered is its own (ProviderOutage, in suspectWindowMs), a suspect when
        // its streak's first error could be its own — a 5xx but 503, a lost connection — or its call hung; a 429 or 503
        // holds calls back, and a model being pulled, neither making one — and its claim fails, seen, where each run
        // had asked the rest and ended on it, every period an outage to a scheduler; the words recorded are the error
        // that made it the suspect. A streak's suspect goes back first, its next streak its own, for the verdict; one
        // that made none goes behind the rest, so a thought whose own error makes no suspect — a 429 for a request too
        // large for the account's limit — holds no wait's head (review pass 3, cold read: put back first, it was
        // claimed after every wait, 89 times in 3 s, the rest of the pool never asked). Behind the rest is 30 days
        // ahead (SET_BACK_AHEAD_MS), each thought set back so ordered among them as it went back, so a scheduler's next
        // period asks the thoughts pooled since first (review pass 5, the consumer's prototype and the maintainer's
        // choice for a hung thought, the author's for the rest: placed at its set-back, which a budget's stop keeps, a
        // hung thought led each later period, and one whose own error makes no suspect, placed at now, came before a
        // hung one again and again; review pass 6, the maintainer's choice: one window ahead, a capture made later than
        // that came after it). A hung suspect goes behind the rest too, so a thought that keeps the provider hung comes
        // after every thought pooled since, its hang marked on its claim (HUNG_MARK), so its next hang in any following
        // run is its own, whatever outages came between (review passes 5 to 7, the maintainer's choices: another's
        // outage first, ProviderOutage's suspects cleared, two hung thoughts were failed never; kept for a window,
        // thoughts each holding a one-slot provider for many limits kept each other's next hangs past it; kept for the
        // run, a scheduler ending its period on set-backs alone failed none), its failure said as a hang's; under
        // SMD-3379's drain, which counted a claim at any date as work, it was asked again in its period (review pass 4,
        // the consumer's prototype and the maintainer's choice: put back first, it led every period, the rest of the
        // pool never asked) — since PR 6b-2, dated past the period's bound, it waits for the next.
        if (FOLLOW_S > 0 && (e instanceof ProviderDown || kind === "transient" || (kind === "fatal" && modelMissing(e)))) {
          const msg = String((e as Error)?.message ?? e).slice(0, 300);
          const hung = e instanceof TimedOutDown && e.hung;
          const suspect = hung || streakPoison === row.id;
          const again = hung && row.hung_before === true;
          // A hang its claim carries no mark for — its first, or one an edit, a pooling or a retry cleared — is no
          // verdict's: ProviderOutage's suspect from an earlier hang in this run is dropped first, so only the mark
          // judges a hang (review pass 8, the consumer's prototype: an edit cleared the mark, and the run's suspect
          // failed the edited thought at its next hang, within the window).
          if (hung && !again) outage.settled(row.id);
          if (again || outage.begin(msg, suspect ? row.id : undefined) === "thought") {
            const why = hung || streakPoison !== row.id ? msg : streakPoisonWhy;
            transients = 0;
            streakPoison = null;
            streakPoisonWhy = "";
            if (row.standing_keys !== null) n.leftOutOfDate++;
            let say: () => void;
            if (again) {
              n.hungOwn++;
              say = () => sayOnce("hungOwn", `  ${row.id}: it hung the provider again (${why}): its claim fails as the thought's own; --retry-failed asks it again`);
            } else {
              n.ownError++;
              say = () => sayOnce("ownError", `  ${row.id}: the provider erred on it again right after answering a probe (${why}): its claim fails as the thought's own; --retry-failed asks it again`);
            }
            // The probe after its timeout found the provider out: the run waits it out before its next claim, as after
            // an outage, none begun nor any suspect made, so the next thought is not asked into the abandoned call
            // (review pass 6, cold read: asked at once, it timed out behind that call on a one-slot provider and failed
            // unanswered, or hung itself).
            if (hung) {
              outageWhy = msg;
              outageAfter = "verdict";
            }
            return { release: "failed", error: again ? `hung the provider again, so this thought's: ${why}` : `provider error again right after the provider answered a probe, so this thought's: ${why}`, say };
          }
          outageWhy = msg;
          if (suspect && !hung) suspectFirst = row.id;
          return backTo(row, suspect && !hung, SET_BACK_AHEAD_MS, hung ? HUNG_MARK + msg : null);
        }
        // Not answering: the thought goes back to the end of the pool, so a thought the provider fails on whenever it
        // is asked does not come first again and end every run (review pass 1), behind every set-back too, a date ahead
        // kept (review pass 7, cold read: placed at now, it came before every thought a following run had set back
        // 30 days ahead, and a set-back of its own was lost). Its claim is handed back as the run ends. A
        // --judge-checked run's stays where it stood, the trip's hand-back first, so the lift run again asks it, not
        // the backlog with the alarm off (PR 6b-1's review pass 3, run-it), its end line naming what it left of its
        // limit for that run (review pass 4, cold read: its --limit, the trip's count, stale once part was done, the
        // run again asked past the hand-back).
        if (kind !== "fatal" && !JUDGE_CHECKED) {
          await sql`
            UPDATE thought_work_claims SET enqueued_at = GREATEST(enqueued_at, now(), (SELECT max(p.enqueued_at) + interval '1 millisecond' FROM thought_work_claims p WHERE p.work_type = ${POOL} AND p.status = 'pending'))
             WHERE thought_id = ${row.id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed'`.catch(() => {});
        }
        endedBy = kind === "fatal"
          ? { code: 2, line: `\n  The provider refused the request itself: ${(e as Error).message.slice(0, 300)}\n  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_JUDGE_MODEL against the provider${sentEffort === undefined ? "" : `, and OB1_SUBJECT_REASONING, which sent reasoning_effort ${JSON.stringify(sentEffort)}`}. Nothing was recorded for this thought.` }
          : { code: 1, line: `\n  The provider is not answering after ${TRANSIENT_PAUSES_MS.length} pauses (${(e as Error).message.slice(0, 300)}): the sweep stops here; run it again${leftOfLimit()}.` };
        return false;
      }
      // The provider's transient error (ask): the thought goes back to the pool, first, its attempt not counted
      // and its place under --limit given back, and the run pauses before its next claim, which takes it again through
      // the admit gate, the pool's name, another run's trip and its own edits read as at any claim (review pass 3, cold
      // read: held through the pause and a gate of its own, the claim needed its lease kept, read again and its losses
      // counted apart). One no longer this worker's is the second stop's to hand back, uncounted (review pass 4, cold
      // read: counted edited and seen); else it is counted by its claim: deleted; the pool's again, edited or requeued by
      // hand, as edited mid-sweep; another run's, or ended by hand, as unanswered here and lost, no failure of this run's
      // (review pass 4, run-it: each read edited).
      if ("transient" in a) {
        pauseMs = TRANSIENT_PAUSES_MS[transients++];
        return backTo(row, true);
      }
      // Each outcome below but a closed subject writes nothing: a subject out of date stands, counted.
      if ("egress" in a) {
        n.egress++;
        if (row.standing_keys !== null) n.leftOutOfDate++;
        return { release: "failed", error: a.egress.slice(0, 500), say: () => sayOnce("egress", `  ${row.id}: ${a.egress.slice(0, 300)}`) };
      }
      if ("unanswered" in a) {
        n.unanswered++;
        if (row.standing_keys !== null) n.leftOutOfDate++;
        return { release: "failed", error: a.unanswered.slice(0, 500), say: () => sayOnce("unanswered", `  ${row.id}: no answer (${a.unanswered.slice(0, 300)}); --retry-failed asks it again`) };
      }
      // The judge's answer, for the alarm's window, whatever becomes of its claim (PR 5b).
      const answer: WindowAnswer = { g: a.answers === null ? "u" : a.keys.length === 0 ? "n" : "k", t: row.id, m: cfg.judgeModel, f: false, c: false };
      answered = answer;
      // Not JSON with subjects: the model's failure for this thought, as the pass reads a malformed answer.
      if (a.answers === null) {
        n.unread++;
        if (row.standing_keys !== null) n.leftOutOfDate++;
        return { release: "failed", error: `${cfg.judgeModel}'s answer was not JSON of the expected shape`, say: () => sayOnce("unread", `  ${row.id}: ${cfg.judgeModel}'s answer was not JSON of the expected shape; --retry-failed asks it again`) };
      }
      if (a.keys.length === 0) {
        // Asked, got nothing: the claim finished is the record, so it is not asked again until its text, the ticket it
        // is filed under or the pool changes; the out-of-date subjects standing on it close, if they are still the set
        // read at the text read. Counted once the finish has answered: a text moved since is edited mid-sweep, a thought
        // deleted is gone, and past the hard stop nothing is closed nor finished (review pass 1: each was counted as
        // named nothing). A subject written since the read, by another pass or another key's run, is one the answer
        // said nothing of: the thought goes back in the pool and the run reads what stands when it comes up (review
        // pass 6: across a switch to another question and back, a subject the other key's run wrote stood out of date,
        // its claim finished here). The check and the claim's end are one transaction under the door's lock on the
        // thought, so a subject written after the check waits for it (review pass 7: one landing between them was
        // finished over), and the claim is handed back only while this run holds it (review pass 7, run-it:
        // requeue_thought_work set pending a claim another run had finished, or took the live lease another run held,
        // which asked again). The thought is read first, locked as the door locks it: a text or a filed ticket moved
        // since the read is edited mid-sweep, its claim handed back while this run holds it, and a thought gone is gone
        // (review pass 8: with no subject standing the finish read neither, and across a switch to another pool and
        // back during the call, an edit made while the other was named left this run's claim, which finished at the old
        // text).
        if (hardStop.signal.aborted) return false;
        type Close = { action: string; stale?: boolean; moved?: boolean; ids?: string[] };
        let fin: string | { c: Close | null; stale: boolean; gone: boolean; written: boolean; held: boolean; judged: boolean; alarm: { code: number; line: string } | null };
        tripping = null;
        try {
          fin = await beginRetried(async (tx: SQL) => {
            const moved = await poolMoved(tx, true);
            if (moved !== null) return moved;
            await tx`SELECT pg_advisory_xact_lock(hashtextextended('ob1:subject:' || ${row.id}::uuid::text, 0))`;
            const back = async () => ((await tx`
              WITH back AS (
                UPDATE thought_work_claims SET status = 'pending', ttl_expires_at = NULL, attempt_count = 0, last_error = NULL,
                                               finished_at = NULL, enqueued_at = now(), worker_id = NULL
                 WHERE thought_id = ${row.id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed' RETURNING 1)
              SELECT EXISTS (SELECT 1 FROM back) AS held`) as { held: boolean }[])[0].held;
            const [now] = (await tx`
              SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) = ${row.fingerprint}
                     AND ob1_filed_ticket(t.metadata) IS NOT DISTINCT FROM ${row.filed}::text AS same
                FROM thoughts t WHERE t.id = ${row.id}::uuid FOR KEY SHARE`) as { same: boolean }[];
            if (now === undefined) return { c: null, stale: false, gone: true, written: false, held: false, judged: false, alarm: null };
            if (!now.same) return { c: null, stale: true, gone: false, written: false, held: await back(), judged: false, alarm: null };
            let c: Close | null = null, written: boolean;
            if (row.standing_ids !== null) {
              // Every subject read, the set closed whole or not at all (SMD-3306 PR 7a-3b-1: one facet of a set
              // answered moved, closing none, and the thought went back to the pool to be asked again within the run).
              [{ c }] = (await tx`SELECT close_thought_subjects(${row.id}::uuid, ${tx.array(row.standing_ids, "UUID")}::uuid[], ${row.fingerprint}) AS c`) as { c: Close }[];
              // A text moved between that read and the close's own: the claim handed back as above. Never gone: a
              // delete waits on that read's FOR KEY SHARE until this transaction ends.
              if (c.stale) return { c, stale: true, gone: false, written: false, held: await back(), judged: false, alarm: null };
              written = c.moved === true;
            } else {
              [{ written }] = (await tx`
                SELECT EXISTS (SELECT 1 FROM thought_facets WHERE thought_id = ${row.id}::uuid AND kind = 'subject' AND valid_until IS NULL) AS written`) as { written: boolean }[];
            }
            const held = written
              ? await back()
              : ((await tx`SELECT release_thought(${row.id}::uuid, ${POOL}, ${workerId}, 'succeeded', NULL) AS held`) as { held: boolean }[])[0].held;
            if (!held || written || !ALARM) return { c, stale: false, gone: false, written, held, judged: false, alarm: null };
            // Finished by this run, the record that it was asked: judged in this transaction, so the claim is in the
            // window, for the alarm to hand back should it trip on it, or not finished at all, whatever ends the run
            // between the two (review pass 3, run-it: a database lost after the finish, or a second signal at the trip,
            // left it finished outside the window, for good). A second signal before judgedIn has the window's lock
            // takes the finish back too, the claim the stop's to hand back, unjudged; one once it is had lets the
            // finish land, judged, a trip it made said to a caller in process, and through the CLI, which exits 130 as
            // the stop's release settles, said or not.
            answer.f = true;
            answer.c = c?.action === "closed";
            return { c, stale: false, gone: false, written, held, judged: true, alarm: await judgedIn(tx, answer, true) };
          }, () => {
            tripping = null;
            answer.f = answer.c = false;
          });
        } catch (e) {
          if (e === ROLLED_BACK) return false;
          if (sqlState(e) === "42501") {
            endedBy = { code: 2, line: `\n  This role cannot close a thought's subject (${(e as Error).message.slice(0, 300)}): close_thought_subjects needs UPDATE on thought_facets and on thoughts, and since a close re-links its thread (120) what the door does: ${DOOR_GRANTS}.` };
            return false;
          }
          if (databaseUnavailable(e)) {
            endedBy = tripping === null ? { code: 1, line: databaseDown(e, leftOfLimit()) } : { code: 3, line: lostTrip(e, true) };
            return false;
          }
          // Rolled back, the claim neither finished nor its subject closed, as the window is told (overBudget).
          if (budgetTimedOut(e)) {
            answer.f = answer.c = false;
            return overBudget(row, e);
          }
          if (sqlState(e) === "40P01") {
            answer.f = answer.c = false;
            return deadlocked(row, e);
          }
          throw e;
        }
        if (typeof fin === "string") {
          endedBy = { code: 2, line: fin };
          return false;
        }
        if (fin.judged) {
          answered = null;
          alarmed = fin.alarm;
        }
        if (fin.stale) n.stale++;
        else if (fin.gone) n.gone++;
        else {
          // Its end is this transaction's: the claim no longer this run's is counted as a release that found it so.
          if (!fin.held) n.lost++;
          if (fin.written) n.rewritten++;
          else {
            // Each subject of the set closed, the tally's words (review pass 1: a set counted as one).
            if (fin.c?.action === "closed") n.closed += fin.c.ids?.length ?? 1;
            n.named++;
          }
        }
        return { release: "none" };
      }
      keys = a.keys;
      by = "model";
      judge = judgeKey;
      recipe = subjectRecipe({ by: "model", model: cfg.judgeModel, temperature: cfg.metadataTemperature, reasoning, answers: a.answers });
    }
    // Past the hard stop nothing more is written; nor once the pool named is not this run's.
    if (hardStop.signal.aborted) return false;
    let w: SubjectWrite | string;
    try {
      w = await beginRetried(async (tx: SQL) => (await poolMoved(tx, true)) ?? (await recordSubject(tx, row, keys, by, judge, recipe, agentId)));
    } catch (e) {
      const state = sqlState(e);
      if (state === "22023") {
        n.refusedKey++;
        if (row.standing_keys !== null) n.leftOutOfDate++;
        return { release: "failed", error: `record_thought_subjects refused the key: ${(e as Error).message.slice(0, 400)}`, say: () => sayOnce("refusedKey", `  ${row.id}: record_thought_subjects refused the key (${(e as Error).message.slice(0, 300)})`) };
      }
      if (state === "42501") {
        endedBy = { code: 2, line: `\n  This role cannot write a thought's subject (${(e as Error).message.slice(0, 300)}): record_thought_subjects needs ${DOOR_GRANTS}.` };
        return false;
      }
      if (databaseUnavailable(e)) {
        endedBy = { code: 1, line: databaseDown(e, leftOfLimit()) };
        return false;
      }
      if (budgetTimedOut(e)) return overBudget(row, e);
      if (state === "40P01") return deadlocked(row, e);
      throw e;
    }
    if (typeof w === "string") {
      endedBy = { code: 2, line: w };
      return false;
    }
    if (w.stale) {
      // The text, or since 113's door the ticket the thought is filed under, moved mid-sweep (review passes 4 and 5): the
      // pool's trigger has the thought again, so its claim is not this worker's to finish, and this run takes it again
      // when it comes up.
      n.stale++;
      return { release: "none" };
    }
    if (w.gone) {
      n.gone++;
      return { release: "none" };
    }
    if (w.action === "kept") n.kept++;
    else if (w.action === "added" || w.action === "replaced" || w.action === "closed") {
      // `closed`: a set narrowed to the keys found, the rest closed — a replacement, as a one-key door's answer said.
      // `added` beside a standing set is one widened, its keys kept and more written: a replacement too, as the dry run
      // counts one, and of the subjects only those written count (PR 7a-3b-2's review pass 1, cold read and run-it: a
      // widened set read as new, and a set's kept keys as recorded).
      n[by]++;
      n.subjects += w.added ?? keys.length;
      if (row.standing_keys !== null) {
        n.replaced++;
        // Review pass 3: the replacements of a version's bump mostly keep their key; how many changed is what a
        // reader wants: a key the set did not hold (this PR's review pass 1: a narrowed set counted a new key).
        if (keys.some((k) => !(row.standing_keys ?? []).includes(k))) n.newKey++;
      }
    }
    return { release: "succeeded" };
  }

  const todo = LIMIT ? Math.min(LIMIT, pool.pending + pool.expired) : pool.pending + pool.expired;
  /**
   * A progress line, at most every 10 s, for a run: of the claims pending at its start, which an edit can add to; a
   * following run's, which the trigger adds to as it waits, counts what it has taken.
   */
  const progress = () => {
    if (DRY_RUN || Date.now() - reported < 10_000) return;
    reported = Date.now();
    out(`  ${n.seen}${FOLLOW_S ? " taken" : `/${todo}`}  ${n.metadata + n.first_line + n.model} recorded, ${n.named} named nothing${n.unanswered + n.unread + n.ownError + n.hungOwn ? `, ${n.unanswered + n.unread + n.ownError + n.hungOwn} unanswered, unread or failed by the provider` : ""}`);
  };

  // The stop is handed out, and the caller's signal heard, while the thoughts are taken, then let go: a signal a
  // caller keeps holds no listener. A dry run hears neither.
  const detach = new AbortController();
  // The start through: from here a database lost ends a following run, 1, its start not begun again (sweepWith).
  o.through.v = true;
  if (!DRY_RUN) {
    o.signal?.addEventListener("abort", () => passStop(), { once: true, signal: detach.signal });
    if (o.signal?.aborted) passStop();
    // Through, as the thoughts begin (PR 6b-1, extract-entities.ts's word), unless a stop came first (review pass 1,
    // run-it: one during the pool-filled mark's write was heard through).
    if (!stop.signal.aborted) o.onStart?.({ ok: true, provider: "up" });
    o.onPass?.(passStop, inCall.abortInHand);
  }
  try {
    if (DRY_RUN) {
      // The thoughts a run would take: every one with no current subject when the pool is not named yet or its
      // pooling broke off, else the pool's pending claims, its failed ones under --retry-failed and a gone worker's
      // run-out leases under their attempts, a page at a time by thought id (review pass 1: by when each was pooled, a
      // key's whole pooling one instant, each page sorted every claim tied with it; and a Date's milliseconds had paged
      // it without end).
      let afterId = NIL_ID;
      pages: for (;;) {
        let rows: Candidate[];
        try {
          rows = (newPool
            ? await sql`
                SELECT ${CANDIDATE} FROM thoughts t
                  ${STANDING}
                 WHERE t.id > ${afterId}::uuid AND ${noCurrentSubject(sql, afterId)}
                 ORDER BY t.id LIMIT ${PAGE}`
            : await sql`
                SELECT ${CANDIDATE} FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id
                  ${STANDING}
                 WHERE c.work_type = ${POOL} AND c.thought_id > ${afterId}::uuid
                   AND (c.status = 'pending' OR (${RETRY_FAILED}::boolean AND c.status = 'failed')
                        OR (c.status = 'claimed' AND c.ttl_expires_at < now() AND c.attempt_count < ${MAX_ATTEMPTS}))
                 ORDER BY c.thought_id LIMIT ${PAGE}`) as Candidate[];
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e, leftOfLimit()) };
          break;
        }
        if (rows.length === 0) break;
        for (const row of rows) {
          afterId = row.id;
          if (LIMIT && taken >= LIMIT) break pages;
          taken++;
          await one(row);
          n.seen++;
        }
      }
    } else {
      for (;;) {
        if (stop.signal.aborted || (LIMIT && taken >= LIMIT)) break;
        // A following run's wait for the provider past its pauses, or hung, or after a hung thought failed as its own
        // or a call aborted in hand (waitForProvider): no claim held, a stop ending the run there.
        if (outageWhy !== null) {
          const why = outageWhy;
          outageWhy = null;
          if (!(await waitForProvider(why)) || stop.signal.aborted) break;
        }
        // The pause after the provider's transient error (TRANSIENT_PAUSES_MS), the thought it failed back in the pool,
        // or after a poll lost to the statement_timeout (lostPoll): no claim held but one a failed hand-back left
        // leased, a stop heard at once.
        if (pauseMs > 0) {
          await sleepUnless(pauseMs, stop.signal);
          pauseMs = 0;
          if (stop.signal.aborted) break;
        }
        // The admit gate before each claim (SMD-3379 PR 1b, PR 6a): the run waits here holding no claim, and a stop
        // while it waits ends it there.
        if (o.admit && (!(await admitted(o.admit, stop.signal)) || stop.signal.aborted)) break;
        // The one-token call after a call aborted in hand (probeAfterAbort), the provider out waited out from the
        // loop's head: unanswered past it, no answer within its limit or the answer's body never arriving (Probe's
        // `unanswered`), the abandoned call held it past a limit, and its thought is marked hung or, marked already,
        // failed as its own (hangAborted; PR 6b-1's review pass 7, the maintainer's choice: a thought whose every call
        // sleep's N12 aborted was never failed, its period never ending, 11 asks all aborted); refused or erring, a
        // provider's restart or a 5xx, the provider is out all the same, but no hang is judged, where a timeout's probe
        // reads any out but a held-back one as a hang, the call itself past its limit (review pass 8, run-it: a
        // restart's refusals and a loading model's 500s marked innocents, a second such abort failing them). Answered,
        // it ends the provider's streak, as the probe after a timeout does, and the claim after it passes the gate
        // again (review pass 7, cold read: a poison claimed next took the streak another thought's error opened, one
        // pause fewer and no suspect made; run-it: a live write begun as the probe waited out the abandoned call met
        // the next thought on the provider).
        if (probeAfterAbort !== null) {
          const aborted = probeAfterAbort;
          probeAfterAbort = null;
          // No hang found: the claim back at the later date it had (`was`), as before the probe, a refusal leaving it.
          const putAhead = () => aborted.back && aborted.was !== null
            ? sql`UPDATE thought_work_claims SET enqueued_at = GREATEST(enqueued_at, ${aborted.was}::timestamptz) WHERE thought_id = ${aborted.row.id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'pending'`.catch(() => {})
            : Promise.resolve();
          const p = await probeChat(cfg.chat, cfg.judgeModel, cfg.timeoutMs, stop.signal);
          if (stop.signal.aborted) {
            await putAhead();
            break;
          }
          if (isOut(p)) {
            const heldBack = p.state === "out" && /^(429|503)( |$)/.test(p.why);
            outageWhy = `the call in hand was aborted by the caller, and a one-token call ${p.state === "missing" ? "found the judge model missing" : heldBack ? "was held back" : "found the provider out"} (${p.why.slice(0, 200)})`;
            outageAfter = "abort";
            const hang = p.unanswered && aborted.back ? await hangAborted(aborted.row, outageWhy) : null;
            if (hang === null) await putAhead();
            else outageAfter = hang;
            continue;
          }
          await putAhead();
          transients = 0;
          streakPoison = null;
          streakPoisonWhy = "";
          continue;
        }
        let got: { thought_id: string }[];
        let moved: string | null;
        let tripped: JudgeWindow | null = null;
        try {
          if (claimedSince === null) claimedSince = ((await sql`SELECT clock_timestamp()::text AS at`)[0] as { at: string }).at;
          moved = await poolMoved(sql, false);
          // A scheduler's bound (claimsBy, PR 6b-2): nothing at or before it to take, no claim, the run waiting as at an
          // empty pool; one claimed past it — another run took those before it between the read and the claim — goes
          // back unasked, its later date, its attempt and any hang's mark kept (setBack).
          const inBound = moved !== null || o.claimsBy === undefined ? true
            : ((await sql`SELECT EXISTS (SELECT 1 FROM thought_work_claims WHERE work_type = ${POOL} AND enqueued_at <= ${o.claimsBy}::timestamptz
                 AND (status = 'pending' OR (status = 'claimed' AND ttl_expires_at < now() AND attempt_count < ${MAX_ATTEMPTS}))) AS any`)[0] as { any: boolean }).any;
          got = moved === null && inBound ? (await sql`SELECT thought_id FROM claim_thoughts(${POOL}, ${workerId}, 1, ${TTL_S}, ${MAX_ATTEMPTS})`) as { thought_id: string }[] : [];
          if (got.length > 0 && o.claimsBy !== undefined) {
            const [past] = (await sql`SELECT enqueued_at > ${o.claimsBy}::timestamptz AS later FROM thought_work_claims
                                       WHERE thought_id = ${got[0].thought_id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed'`) as { later: boolean }[];
            if (past?.later) {
              await setBack(sql, POOL, workerId, got[0].thought_id, 0, true);
              got = [];
            }
          }
          if (got.length > 0 && hardStop.signal.aborted) claimedPastHard = true;
          // Another run's trip since this run began, read once the claim is taken, so one that landed before the claim
          // is seen and the thought goes back unasked, as the run ends (review pass 3, cold read: read before the
          // claim, a trip between the two went unseen, and the run asked a thought it had handed back).
          if (moved === null && ALARM) {
            const w = await windowNow(sql);
            if (w.tripped !== null && w.tripped !== tripBase) tripped = w;
          }
        } catch (e) {
          if (budgetTimedOut(e)) {
            if (await lostPoll(e, "the claim", false)) continue;
            break;
          }
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e, leftOfLimit()) };
          break;
        }
        if (moved !== null) {
          endedBy = { code: 2, line: moved };
          break;
        }
        if (tripped !== null) {
          endedBy = { code: 3, line: stampLine(tripped, null) };
          break;
        }
        if (got.length === 0) {
          if (!FOLLOW_S) break;
          // A following run (PR 6a): the pool empty, its word said through its caller's row, it waits for the trigger to
          // pool more and claims again, the pool's name and another run's trip read at each claim; its stop wakes it.
          await o.stamper?.stamp("ok");
          await sleepUnless(FOLLOW_S * 1000, stop.signal);
          continue;
        }
        taken++;
        const id = got[0].thought_id;
        let row: Candidate | undefined;
        try {
          [row] = (await sql`
            SELECT ${CANDIDATE},
                   COALESCE((SELECT starts_with(c.last_error, ${HUNG_MARK}) FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${POOL}), false) AS hung_before
              FROM thoughts t
              ${STANDING}
             WHERE t.id = ${id}::uuid`) as Candidate[];
        } catch (e) {
          if (budgetTimedOut(e)) {
            if (await lostPoll(e, `${id}'s read`, true)) continue;
            break;
          }
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e, leftOfLimit()) };
          break;
        }
        if (row === undefined) {
          // Deleted after the claim: its claim went with it.
          n.gone++;
          n.seen++;
          continue;
        }
        if (suspectFirst !== null) {
          if (row.id !== suspectFirst) outage.settled(suspectFirst);
          suspectFirst = null;
        }
        answered = null;
        alarmed = null;
        // The thought's entry for abortInHand while it is in hand: waiting, but while the judge's call runs (ask).
        inCall.begin(workerId).waiting = true;
        let done: Done | false;
        try {
          done = await one(row).finally(() => inCall.end(workerId));
        } catch (e) {
          // A put-back or set-back past the budget, or the claim's state read after one found it gone; one()'s own
          // writes fail their thought (overBudget).
          if (!budgetTimedOut(e)) throw e;
          if (await lostPoll(e, `${row.id}'s put-back, set-back or claim read`, true)) continue;
          break;
        }
        if (done === false) break;
        // Back in the pool after the provider's transient error: seen when it is taken again.
        if ("again" in done) continue;
        // Counted before its release, so a database lost there leaves the counts adding up (review pass 1); past the
        // hard stop the claim is the stop's release's, not this worker's to finish (review pass 2: counted in its
        // bucket and not seen). A trip the finish wrote with its claim is said all the same.
        n.seen++;
        if (alarmed !== null) {
          endedBy = alarmed;
          break;
        }
        if (hardStop.signal.aborted) break;
        if (done.release !== "none") {
          try {
            // False: no longer this worker's — an edit put it back in the pool (the trigger), at its new text, or its
            // lease ran out and another run took it — counted and said (review pass 1: nothing said so); a failure's
            // own line said once it lands (Done's `say`).
            const [{ ok }] = (await sql`SELECT release_thought(${id}::uuid, ${POOL}, ${workerId}, ${done.release}, ${done.release === "failed" ? done.error : null}) AS ok`) as { ok: boolean }[];
            // Finished, a suspect no longer (ProviderOutage's settled), as the claim passes say it (PR 6b-1's review
            // pass 2, cold read, run-it and mutant): a failure the provider never answered too, its answer's settling
            // aside; the release's last_error replaces a hang's mark.
            outage.settled(id);
            if (!ok) {
              n.lost++;
              if (done.release === "failed") n.lostFailed++;
            } else if (done.release === "failed") done.say();
          } catch (e) {
            // Its outcome unrecorded: the claim handed back, taken again by a following run, its answer unjudged, a
            // failure left out of the failure count (lostPoll).
            if (budgetTimedOut(e)) {
              if (done.release === "failed") n.lostFailed++;
              if (await lostPoll(e, `${id}'s release`, false, true)) continue;
              break;
            }
            if (!databaseUnavailable(e)) throw e;
            endedBy = { code: 1, line: databaseDown(e, leftOfLimit(1)) };
            break;
          }
        }
        // Judged once the claim is released, so a failed one is recorded failed before the run stops on it; a claim the
        // judge did not answer leaves the window as it was, and one this run finished as named nothing was judged in
        // its finish.
        if (answered !== null && ALARM) {
          let alarm: { code: number; line: string } | null;
          try {
            alarm = await judgedAlone(answered);
          } catch (e) {
            // Its window write past the budget: the answer not in the window, the claim as released (lostPoll).
            if (!budgetTimedOut(e)) throw e;
            if (await lostPoll(e, `${id}'s answer's window`, false)) continue;
            break;
          }
          answered = null;
          if (alarm !== null) {
            endedBy = alarm;
            break;
          }
        }
        progress();
      }
    }
  } finally {
    ended = true;
    detach.abort();
    // What this worker still holds goes back to the pool, its attempt not counted: a stop, an error, a database lost
    // (said there); any other failure is said here, the claims returning as their leases run out.
    if (!DRY_RUN) {
      await releaseHeld().catch(async (e) => {
        // The second stop's hand-back, landed, left this one nothing to hand back (review pass 4, cold read: this one's
        // failure said the claims would go back as their leases ran out, though they were back), but a claim landing
        // after that stop, which its hand-back may have run past (review pass 7, run-it: one was left leased, unsaid,
        // the stop line saying it was back).
        if (!claimedPastHard && hardRelease !== null && (await hardRelease) !== null) return;
        handedBack = false;
        // Said, but when the run's end says the database already (review pass 4, run-it: after the provider's end, a
        // hand-back the database cut off went unsaid, the claim leased to its end).
        if (!databaseUnavailable(e) || !endedBy?.line.startsWith("\n  The database stopped answering")) err(`  the claims this run holds could not go back to the pool (${String((e as Error)?.message ?? e).slice(0, 200)}): each returns as its lease runs out`);
        // The database's own line says where they went (PR 6b-1's review pass 2, run-it: left leased, unsaid).
        else if (endedBy !== null) endedBy = { code: endedBy.code, line: `${endedBy.line}\n  What it holds goes back to the pool as each lease runs out.` };
      });
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const clauses = (parts: [number, string][]) => parts.filter(([k]) => k > 0).map(([k, s]) => `${k} ${s}`).join(", ");
  if (DRY_RUN) {
    // Ended early (the database, at a page), it counted part of the thoughts: say why, not a would-line of a part.
    if (endedBy) {
      err(endedBy.line);
      return endedBy.code;
    }
    out(`\n  would: of ${n.seen} thought(s), record ${clauses([[n.metadata, "by the ticket each is filed under"], [n.first_line, "by its session header's tickets"]]) || "none by the rules"}` +
      (n.replaced ? ` (${n.replaced} in place of a standing subject, ${n.newKey} with a new key)` : "") +
      (n.kept ? `, keep ${n.kept} found the same way at the text read now` : "") +
      (n.current ? `, finish ${n.current} already current` : "") + "; " +
      (MODEL ? `ask ${cfg.judgeModel} about ${n.left}` : `leave ${n.left} keyed by no rule, no model asked (--subjects rules)`) +
      (n.leftOutOfDate ? ` (${n.leftOutOfDate} with an out-of-date subject)` : "") + ". Nothing was written, pooled or asked." +
      (wouldRefuse.length ? ` A run would be refused: ${wouldRefuse.join("; ")}.` : ""));
    return 0;
  }
  const recorded = n.metadata + n.first_line + n.model;
  const by = clauses([[n.metadata, "by the ticket filed under"], [n.first_line, "by the session header's tickets"], [n.model, `by ${cfg.judgeModel}`]]);
  // The thoughts recorded, and the subjects written on them where those differ, as a set's can (SMD-3306 PR 7a-3b-2):
  // the words of one-key sets as before.
  const recordedWords = n.subjects === recorded ? `${recorded} subject(s) recorded${by ? ` (${by})` : ""}`
    : `${recorded} thought(s)' subjects recorded (${by ? `${by}; ` : ""}${n.subjects} subject(s) written)`;
  const rest = clauses([[n.current, "already current"], [n.kept, "kept, at the text read now"], [n.named, `the model named nothing for${n.closed ? ` (${n.closed} out-of-date subject(s) closed)` : ""}`], [n.left, "keyed by no rule, no model asked (--subjects rules)"], [n.unread, "answered not as JSON of the expected shape"], [n.unanswered, "unanswered"], [n.ownError, "failed by the provider again right after it answered a probe"], [n.hungOwn, "failed on hanging the provider again"], [n.stale, "edited mid-sweep"], [n.rewritten, "given a subject elsewhere mid-sweep"], [n.gone, "deleted mid-sweep"], [n.egress, "refused by the egress gate"], [n.refusedKey, "keys refused"], [n.overBudget, "failed on a write past the statement_timeout"], [n.deadlocked, "failed on a write the server rolled back to break a deadlock"], [n.setBack, "set back unanswered, the call in hand aborted by the caller"]]);
  const outOfDate = n.leftOutOfDate ? ` — among them, ${n.leftOutOfDate} with an out-of-date subject still standing` : "";
  const pollsLost = n.pollsLost ? `; ${n.pollsLost} poll(s) lost to the scheduler's statement_timeout` : "";
  const lost = n.lost ? `; ${n.lost} claim(s) no longer this run's when released (the thought edited, deleted or pooled again, its lease run out and taken by another run, or handed back by hand)` : "";
  out(`\n  ${n.seen} thought(s) in ${elapsed}s${calls ? ` (${(llmMs / 1000).toFixed(1)}s in ${calls} model call(s))` : ""}: ${recordedWords}${n.replaced ? `, ${n.replaced} in place of a standing one (${n.newKey} with a new key)` : ""}${rest ? `; ${rest}${outOfDate}` : ""}${lost}${pollsLost}`);
  if (endedBy) {
    err(endedBy.line);
    return endedBy.code;
  }
  if (stop.signal.aborted) {
    // Where the hand-back left what it held (review pass 3, run-it: back in the pool, said after it could not go back).
    err(`\n  stopped after ${n.seen} thought(s): what it held ${handedBack ? "is back in the pool" : "goes back as each lease runs out"}, and the next sweep takes up the rest`);
    // A following run's stop is its end, as a follower's is: 0, and 130 at once on the second (PR 6a).
    return FOLLOW_S > 0 && !hardStop.signal.aborted ? 0 : 130;
  }
  // A failed claim no longer this run's when released is the pool's again, or gone: no failure for --retry-failed. A
  // lease run out at its last attempt and failed while this run claimed — by its claims' reaping, or a run's beside it —
  // is one, counted over the run's own window, not from the start's count (review pass 4: one spent mid-run went
  // unsaid, exit 0).
  let spent = 0;
  if (claimedSince !== null) {
    try {
      [{ spent }] = (await sql`
        SELECT count(*)::int AS spent FROM thought_work_claims
         WHERE work_type = ${POOL} AND status = 'failed' AND finished_at >= ${claimedSince}::timestamptz AND last_error LIKE 'lease expired %'`) as { spent: number }[];
    } catch (e) {
      // The database lost here leaves the count unknown: said as the run's end, not read as none (review pass 5: exit 0).
      // Its work done, nothing of its limit is left to name (review pass 6, cold read).
      if (!databaseUnavailable(e)) throw e;
      err(databaseDown(e));
      return 1;
    }
  }
  if (spent) err(`\n  ${spent} claim(s) whose lease ran out at its last attempt failed while this run claimed: a worker held each ${MAX_ATTEMPTS} times and did not finish it`);
  const failedNow = failedHere() + spent;
  if (failedNow > 0) err(`\n  ${failedNow} claim(s) failed: fix the cause and run again with --retry-failed`);
  o.claimsEnd.v = true;
  return failedNow > 0 ? 1 : 0;
}
