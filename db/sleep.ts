#!/usr/bin/env bun
/**
 * sleep.ts — run the background passes while the brain is quiet, and stop
 * them within --poll seconds of the first live call being recorded: the sleep
 * scheduler, "dolphin sleep" (SMD-1794).
 *
 *   bun db/sleep.ts --url postgres://… --follow     # sleep whenever the brain is quiet, for ever
 *   bun db/sleep.ts --url …                         # wait for quiet, sleep once — until both pools drain or a call wakes it — then exit
 *   bun db/sleep.ts --url … --dry-run               # the idle reading and each pass's pool; writes nothing
 *   await run({ url, follow: true, signal })         # in-process: import { run } from "./sleep.ts" (SMD-2304's engine shape)
 *   --quiet SECONDS (300)   --poll SECONDS (5; at most 60)   --workers N (1, for each pass)
 *   exits 0 done, or --follow stopped by one signal · 1 one sleep woken before both pools drained, a pass that ended by itself with 0, or an uncaught error · 2 usage, configuration (a pass's start checked before the first quiet included), followers running outside sleep, or a pass's refusal (under --follow, all but a model, provider or lookup refusal at the start of a pass that got through its start earlier, which is retried — "Refusals" below) · 130 a signal before one sleep ended, or a second signal (at once)
 *
 * ── Quiet ───────────────────────────────────────────────────────────────────
 * The brain is awake while it is used: a read the server logged (query_log,
 * migration 034) or a write the audit recorded (thought_audit, 008) through a
 * key whose kind is not `ingested` (set_agent_kind, 046). It falls asleep
 * after --quiet seconds with neither, and wakes on the first. Every
 * comparison is on the database's clock, now().
 *  - Reads wake it only under the server's OB1_QUERY_LOG=on, off by default:
 *    with it off nothing logs a search. Nothing in the database says which,
 *    so a log with no row in 24 h is said once at the start. The owner can
 *    read query_log, and so can a role granted the `sleep` group (db/config.mjs,
 *    SMD-2678); any other --grant role is told once, and then only writes wake
 *    the brain.
 *  - "Background" is the key's kind, not the work: board-sync's key is
 *    classified `ingested` on the stable brain, so its sync writes do not
 *    wake it; an unclassified key's do — reembed.ts's, ingest-records.ts's, a
 *    migration's backfill — until set_agent_kind(<name>, 'ingested') says
 *    they are background. The servers' vector mender marks its own writes
 *    background in the audit row (actor_context.background, SMD-2889), and
 *    they do not wake it either.
 *  - The passes it runs write no thought_audit row (extraction writes the
 *    entity tables; consolidation writes proposals and, since 084, relation
 *    facets with their lineage) and call no server, so its own work never
 *    wakes it.
 * The default is from the stable brain's logs over 14 days (2026-09-23 to
 * 10-07), replayed at each quiet — the scheduler did not run there, and
 * stable logs reads: 3,379 live events, the median gap 0.3 s; at 300 s it
 * would have slept 222 times, 93% of the time, a median sleep of 16.6 min
 * (p10 2.4); at 60 s, 98% and 12.6 min; at 900 s, 84% and 25.5 min. Counting
 * board-sync's writes as live halves the median sleep at 300 s (6.5 min).
 *
 * ── Asleep ──────────────────────────────────────────────────────────────────
 * The passes in a fixed order. The extraction follower runs alone until its
 * pool is drained — nothing pending, in flight or not yet in the pool —
 * because consolidation judges a thought against neighbours that must be
 * extracted first (consolidate.ts's header; deploy/README.md's "Start extract
 * alone on a backlog", a rule there until now). The consolidation follower
 * then joins it, beside it as the workers profile runs the two (SMD-2424):
 * safe for what arrives from then on, as a candidate was captured on an
 * earlier UTC date. It joins as well once extraction holds nothing but
 * thoughts that SLEEP_STALLED_JOIN (3) or more long hard stops in a row took
 * with no window saved between, and none saved since (migration 093's
 * `stalled` and `gained`, SMD-2694; long: the thought held a minute,
 * provider pauses aside, so short sleeps count none): a single window longer than
 * every long sleep — or a stop
 * that keeps landing past the last window, in the decider's call or the
 * write — which would otherwise hold consolidation back for as long as the
 * brain keeps waking. The cost is consolidate.ts's for an unextracted
 * neighbour: a newer thought judged meanwhile misses its pair with such a
 * thought, which is reached from its newer side only and not revisited.
 * Once taken, the decision holds for the rest of the sleep. Stalled thoughts
 * go last: every thought a stop has taken moves behind new captures as each
 * sleep begins — dated 30 days ahead, so a capture made during the sleep,
 * which a sync write's is, as it wakes nothing, goes ahead of them too
 * (SMD-3008; claims are taken by that date, which reads no clock). One that
 * lands while extraction has a stalled thought in hand, before consolidation
 * joins, would wait out the window, and the join with it: two polls reading
 * extraction with only stalled thoughts in hand and newer work pending
 * restart it, the stalled thought(s) moved behind that work, at most once a
 * minute. Once consolidation has joined, a stalled thought in hand keeps its
 * turn, and such a capture goes first at the next sleep; nor is a thought
 * still gaining windows, or a stall or two short of the join, stopped for one. When consolidation joins past,
 * extraction is set aside — stopped, if in hand with a stalled thought —
 * until consolidation's pool drains, then resumes, so on a one-slot model the
 * judge is not left waiting behind the window. While consolidation waits for
 * its provider — at its start, or mid-pass (consolidate.ts's providerWait):
 * past its workers' pauses for a 5xx, a minute and more, at once for a model
 * gone missing or a call no probe answers — its pool cannot drain, and
 * extraction is let out for the newer work meanwhile, with one worker, at
 * most once a minute, then set aside again once it holds a stalled thought —
 * its own claims, by worker id, since this run began — or holds nothing and
 * nothing newer is left; the stalled thought(s) wait for consolidation
 * (SMD-3008): the judge model failing while the extraction model serves, as
 * both are on the one chat endpoint. A judge model missing at the start is
 * refused, as before. The thought is tried in every
 * sleep once consolidation's pool drains, and finished by the first sleep
 * long enough for both. A brain before 093, or a role that cannot read it,
 * joins once extraction is drained alone, and the start says so; granted
 * later, the scheduler takes it up once restarted.
 * A failed row stays failed — the operator's --retry-failed.
 * Followers, not one-shot runs: a follower waits out a database restart or a
 * provider outage mid-sleep (SMD-2599), where a one-shot run fails the
 * thought in hand. Without --follow, a sleep that drains both pools stops the
 * followers and exits 0; one whose provider is down at its start waits.
 *
 * ── Waking ──────────────────────────────────────────────────────────────────
 * Every --poll seconds while asleep the logs are read for a live event since
 * the sleep began — and up to 30 s before it, within the quiet just read: an
 * audit row is dated at its transaction's start, so a capture begun before
 * the sleep and committed after it is dated before it (one blocked longer is
 * missed). On one, both passes are hard-stopped (the pass's signal, then its
 * PassStop): every lease returned, the model call in hand aborted —
 * extract's since this ticket's first cut, consolidate's since SMD-2304 — and
 * the claims they held moved to the back of the queue, since a release keeps
 * a claim's place: a thought longer than the sleeps would otherwise be every
 * sleep's first, and the pool behind it would never move. That thought's
 * windows answered so far are kept (extract-entities.ts over migration 093,
 * SMD-2694), so it advances by the windows each sleep finishes and is done
 * once its last is; one whose single window outlasts every sleep is joined
 * past (Asleep), and the row names both (Heartbeat). Waking costs up to
 * --poll seconds of a pass beside the live call, and the calls in flight
 * thrown away. The first live call is not spared: it is recorded after the
 * model work it does, so on a one-slot model it can queue behind the call in
 * hand. Awake, it reads again when the brain could first fall asleep —
 * --quiet seconds after the newest live event — at most a minute apart.
 *
 * ── Refusals ────────────────────────────────────────────────────────────────
 * Before its first quiet the scheduler runs each pass's start once (the
 * engines' `check`, SMD-2752): the banner, the egress gate, the tables, the
 * model's probe, the worker key and extraction's recorded key. A refusal
 * there ends it with 2 at once — a bad worker key, a model not served, the
 * judge's included, which a sleep would meet only once extraction's backlog
 * drained. A provider that does not answer is no refusal: each pass waits for
 * it at its own start. The passes each sleep starts leave their banner to it,
 * and their end-of-run summary out (the counts and graph, scans the
 * scheduler would wait for at a wake).
 * Every sleep starts its passes afresh, so each meets its start's refusals
 * again. Each says which it is (worker-bootstrap.ts's StartRefusal), and one
 * rule reads that and whether the pass got through its start in this process
 * (the check, or onPass):
 *  - one no retry mends — the worker key revoked (the environment is read
 *    once, and the registry does not unrevoke), the extraction key another
 *    process's --switch-key moved, the tables, the egress policy — ends the
 *    scheduler with 2;
 *  - the model not served, the provider refusing the call, or the key's lookup
 *    not naming it under an actor-only egress policy, at the start of
 *    a pass that got through its start earlier, is retried under --follow on
 *    SMD-2599's outage schedule, heartbeat:sleep failed and re-stamped
 *    through the wait, until a pass of a later sleep stamps: a model
 *    re-pulled, a 402 cleared by topping up credit, a gateway's passing
 *    401/403/404;
 *  - the same at a pass's first start, or a refusal mid-pass (the provider
 *    refusing the request itself, a key refused on a real call), is the
 *    configuration's, as it is for a follower: it ends the scheduler with 2.
 *    So the same 402 or 401 ends it when it lands mid-pass, and is retried
 *    when a sleep's start meets it first;
 *  - any other code a pass ends with ends the scheduler.
 *
 * ── Heartbeat ───────────────────────────────────────────────────────────────
 * `heartbeat:sleep` in ob1_config (db/pass-stamp.ts, SMD-2261): running while
 * asleep, re-stamped at least every minute awake or asleep, `failed` while a
 * pass's last word was (a provider still failing mid-pass, a refusal) — kept
 * into the next sleep until one of its passes stamps — ended when the
 * scheduler stops, a second signal included; `slept` carries the current or
 * last sleep's start and, once it is over, its end, on the database's clock
 * (SMD-2678); `waiting` names the passes waiting at their start for a
 * provider that does not answer, while one is, and `refused` the start
 * refusal that ended it, so preflight's `sleep` row says each — not "its
 * passes running", nor "start it again", which would only refuse again
 * (SMD-2752); `held`, the thoughts extraction holds back across the wakes —
 * how many, and the three most stalled with their stops and windows kept,
 * read at the first stamp awake or poll asleep, after each wake, at least
 * every minute and before the row ends — so the row names a thought the
 * sleeps cannot finish (SMD-2694). The passes stamp through it, not their
 * own rows, so a wake does not end a follower's row for preflight to warn
 * about, and preflight's
 * consolidate pass row reads it as the scheduler at work. Only --follow
 * stamps: one sleep leaves no row to go stale, as a one-shot pass does not.
 * Followers run outside sleep (the workers profile) do not yield, so the two
 * profiles are alternatives: a run refuses (2) while any of their heartbeats
 * is fresh — at its start, and at every awake and asleep poll, since a
 * follower brought up beside it stamps only past its own start probe — and
 * --dry-run names them, each with how to stop them and retire their rows
 * (SMD-2678). Under --follow a refusal, at the start too, ends the row on a
 * failure, its last sleep kept, so preflight names the followers keeping it
 * down. Preflight's `sleep` row reads this heartbeat, with its `slept` mark
 * and its `reads` word on the query log, and the compose service
 * (`--profile sleep`) runs `--follow`. The start's reads, like the sleep's,
 * wait out a database not answering yet, and so does each pass's start at
 * every sleep, up to its first claim (SMD-2752).
 *
 * ── Not here ────────────────────────────────────────────────────────────────
 * A budget per pass (statement_timeout, work_mem) and per sleep (a wall
 * clock), and the re-derive pass (rebuild_derived, SMD-1732) (SMD-2679). A
 * pass waiting mid-pass for the provider, after its workers' pauses, reads
 * "running a pass" on the row — the `waiting` word is its start's alone
 * (SMD-2905); the scheduler hears it from consolidation (SMD-3008), and keeps
 * it off the row. The frozen-belief scan, decay relabelling and an HNSW heal are
 * their own tickets' passes (SMD-1722, SMD-1736, SMD-1632), as is the awake
 * latency under a sleep at 1M and 10M rows (SMD-1500's harness).
 */

import type { SQL } from "bun";
import { hostname } from "node:os";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractionKey, windowingFor } from "../server-portable/entities.ts";
import { consolidateKey } from "../server-portable/consolidate.ts";
import { heldWords, SLEEP_HELD_NAMED, SLEEP_STALLED_JOIN, STALE_AFTER_INTERVALS, type SleepHeld } from "../server-portable/brain-info.ts";
import { run as runExtract } from "./extract-entities.ts";
import { run as runConsolidate } from "./consolidate.ts";
import { outageWait, PERMANENT_REFUSALS, throughOutage, type StartRefusal, type StartResult } from "./worker-bootstrap.ts";
import { MAX_WORKERS, sleepUnless, stopOnSignals, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { MIN_STAMP_EVERY_S, passStamper, type MalformedBlock, type PassOutcome, type PassStamper, type SleepMark } from "./pass-stamp.ts";
import { startRefusalRemedy } from "./config.mjs";
import { commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

const FLAGS = { url: "one", quiet: "one", poll: "one", workers: "one", follow: "none", "dry-run": "none" } as const;
const HINTS = { url: "<postgres://…>", quiet: "<SECONDS>", poll: "<SECONDS>", workers: "<N>" };

/** The quiet before a sleep, from the stable brain's logs replayed (the header): 93% of the time asleep, a median sleep of 16.6 min. */
const DEFAULT_QUIET_S = 300;
/** How often the logs are read while asleep: the most a pass runs beside a live call. */
const DEFAULT_POLL_S = 5;
/** The followers' own poll for new work, their bare --follow's. */
const PASS_FOLLOW_S = 15;
/** How far ahead the stopped thoughts are dated as a sleep begins (stoppedLast): past any sleep, so every capture made during one is taken first (SMD-3008). */
const FORWARD_DAYS = 30;
/** The least time between two restarts of extraction for work that lands behind a stalled thought in hand (asleep(), SMD-3008). */
const RESTART_EVERY_MS = 60_000;
/** How far before a sleep began its wake reads, for a write committed after it in a transaction begun before (asleep()). */
const WAKE_SLACK_S = 30;
/** The longest --poll: the awake wait is at most a minute, the heartbeat's floor, and a poll past it would break that. */
const MAX_POLL_S = 60;
/** A query log with no row this recent is likely off (OB1_QUERY_LOG unset), and a search does not wake the brain. */
const QUERY_LOG_QUIET_S = 86_400;
/** A pass's own line about the stop the scheduler made it take, not the operator's signal: left out of the scheduler's output. */
const PASS_STOP_LINE = /^\s*(stopping after the current thought|second signal — exiting now|stopped before the pass began)/;

/** The two passes, in their order. */
const PASSES = ["extract", "consolidate"] as const;
type PassName = (typeof PASSES)[number];

/**
 * One sleep scheduler's run — the CLI's flags, typed. `url` is required: each
 * pass opens its own pool from it (a follower's needs a connection per worker
 * and a spare), and the worker key resolves on one of its own. `sql`, when
 * given, is the caller's client for the scheduler's own reads and heartbeat
 * — two connections are enough — and never closed here. `signal` stops it as
 * the CLI's first signal does: the passes after the thought in hand. `onPass`
 * is handed the scheduler's stop as it begins (db/lease.ts's PassStop): the
 * first call is that stop; a second hard-stops the passes and returns the
 * release of their leases. `env` is what the passes read (process.env when
 * absent).
 */
export interface SleepOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  quiet?: number;
  poll?: number;
  workers?: number;
  follow?: boolean;
  dryRun?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
  /** The heartbeat's floor, MIN_STAMP_EVERY_S unless a test drives it faster. */
  minStampEveryS?: number;
  /** Extraction's stall floor (extract-entities.ts STALL_FLOOR_MS) unless a test drives it faster. */
  stallFloorMs?: number;
  /** The least time between two restarts or let-outs of extraction (RESTART_EVERY_MS) unless a test drives it faster. */
  restartEveryMs?: number;
  /** The passes' own poll for new work, in seconds (PASS_FOLLOW_S) unless a test drives it faster (SMD-3048). */
  passFollowS?: number;
}

/**
 * A pass's pool: its claim rows by status, and the thoughts a pass would add
 * to it; for extraction, `stalled` — of its pending and in-flight rows, those
 * SLEEP_STALLED_JOIN or more long hard stops in a row have taken with no
 * window saved between, and none since (migration 093, SMD-2694), 0 where the
 * scheduler cannot read them — and `stalledPending`, those of them pending
 * (SMD-3008); `stalledRead`, whether that read ran. `mine` counts the rows in
 * flight under this process's extraction worker ids (MINE) claimed since this
 * run began, and `stalledMine` those of them stalled: another's claim, or a
 * lease a scheduler gone left — on another host, or this container before a
 * restart — is no thought this one holds.
 */
type Pool = { pending: number; claimed: number; failed: number; unpooled: number; stalled: number; stalledPending: number; stalledRead: boolean; mine: number; stalledMine: number };
/** Nothing for the pass to do: no row pending or in flight, and nothing to add. A failed row is the operator's. */
const drained = (p: Pool): boolean => p.pending + p.claimed + p.unpooled === 0;
/**
 * Extraction holds only thoughts whose single window outlasts every sleep,
 * or whose stops land past their last window:
 * nothing to add, and every row pending or in flight stalled. Consolidation
 * joins past them (SMD-2694), as it would never join behind them.
 */
const joinsPast = (p: Pool): boolean => p.unpooled === 0 && p.pending + p.claimed > 0 && p.pending + p.claimed === p.stalled;
/** Extraction's worker ids in this process (extract-entities.ts's `workerId`, heldHere's prefix). */
const MINE = `extract-${hostname()}-${process.pid}-`;
/** The work extraction has that no stall holds back: rows pending that are not stalled, and thoughts not yet in the pool (none in a claims-only read). */
const newerWork = (p: Pool): number => p.pending - p.stalledPending + p.unpooled;
/**
 * Extraction has only stalled thoughts in hand while newer work waits behind
 * them — a row pending that is not stalled, or a thought not yet in the pool:
 * a capture made during the sleep, which a sync write's is, as nothing wakes
 * the brain for it (SMD-3008). The pool is not all stalled, so consolidation
 * would not join past it either, and both waited out the window in hand.
 * In hand is this process's: a lapsed lease another left is not (review pass 2).
 */
const queuesBehind = (p: Pool): boolean => p.mine > 0 && p.stalledMine === p.mine && newerWork(p) > 0;

/**
 * 093's rows that speak for the thought as it stands and the windowing in
 * force: its fingerprint now (an edit makes a row of other text, which the
 * next claim replaces) and the worker's windowing, as extract-entities.ts
 * reads them before reusing a window.
 */
const currentProgress = (sql: SQL, sig: string) => sql`e.windowing = ${sig} AND e.fingerprint = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))`;

/**
 * A pass's pool, read as its own --status reads it: extraction's universe is
 * every thought (enqueue_thoughts adds those with no row under the key);
 * consolidation's is migration 029's consolidation_pool.
 */
async function poolOf(sql: SQL, pass: PassName, job: string, stalledUnder?: string, unread?: (e: Error) => void, claimsOnly = false, mineSince?: Date): Promise<Pool> {
  // A claim made before this run began is not its own, though it carries this
  // process's worker id: a container restarted in place keeps its hostname and
  // pid, and its last run's lease lives on for its TTL (post-merge review).
  const since = mineSince === undefined ? sql`'-infinity'::timestamptz` : sql`${mineSince}::timestamptz`;
  // One statement, so one snapshot: read apart, a claim made between the two
  // reads counted neither claimed nor unpooled, and a pool just being claimed
  // read drained — extraction resumed 14 ms after consolidation joined, before
  // it had judged (review pass 5).
  // `claimsOnly` skips the thoughts not yet in the pool, a scan of every
  // thought for extraction: read every poll while consolidation waits on its
  // provider, where the capture trigger keeps it near nought (SMD-3008).
  const unpooled = claimsOnly
    ? sql`SELECT 0`
    : pass === "extract"
    ? sql`SELECT count(*)::int FROM thoughts t WHERE NOT EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${job})`
    : sql`SELECT count(*)::int FROM consolidation_pool(${job})`;
  const [by] = (await sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'claimed')::int AS claimed,
           count(*) FILTER (WHERE status = 'failed')::int AS failed, (${unpooled}) AS n,
           count(*) FILTER (WHERE status = 'claimed' AND starts_with(worker_id, ${MINE}) AND claimed_at >= ${since})::int AS mine
      FROM thought_work_claims WHERE work_type = ${job}`) as { pending: number; claimed: number; failed: number; n: number; mine: number }[];
  // Read only where the start found 093's table readable (stalledUnder, the
  // windowing). One gone or refused since reads none stalled, said by the
  // caller, so the scheduler joins once extraction drains rather than ends
  // (review pass 2: the read ran inside reading(), which rethrows it).
  let s = 0, sp = 0, sm = 0, read = false;
  if (pass === "extract" && stalledUnder !== undefined) {
    try {
      [{ s, sp, sm }] = (await sql`
        SELECT count(*)::int AS s, count(*) FILTER (WHERE c.status = 'pending')::int AS sp,
               count(*) FILTER (WHERE c.status = 'claimed' AND starts_with(c.worker_id, ${MINE}) AND c.claimed_at >= ${since})::int AS sm
          FROM thought_work_claims c
          JOIN extraction_progress e USING (thought_id, work_type) JOIN thoughts t ON t.id = c.thought_id
         WHERE c.work_type = ${job} AND c.status IN ('pending', 'claimed') AND e.stalled >= ${SLEEP_STALLED_JOIN} AND e.gained = 0 AND ${currentProgress(sql, stalledUnder)}`) as { s: number; sp: number; sm: number }[];
      read = true;
    } catch (e) {
      const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
      if (code !== "42P01" && code !== "42501") throw e;
      unread?.(e as Error);
    }
  }
  return { pending: Number(by.pending), claimed: Number(by.claimed), failed: Number(by.failed), unpooled: Number(by.n), stalled: Number(s), stalledPending: Number(sp), stalledRead: read, mine: Number(by.mine), stalledMine: Number(sm) };
}

/**
 * The thoughts extraction holds back across the wakes: pending or in flight,
 * a hard stop counted on them (093), of the text and windowing in force —
 * how many, and the SLEEP_HELD_NAMED most stalled, then most stopped.
 */
async function heldBack(sql: SQL, job: string, sig: string): Promise<SleepHeld> {
  const rows = (await sql`
    SELECT e.thought_id::text AS id, e.stops, CASE WHEN e.gained > 0 THEN 0 ELSE e.stalled END AS stalled, (SELECT count(*)::int FROM jsonb_object_keys(e.parts)) AS kept, e.windows, count(*) OVER ()::int AS total
      FROM extraction_progress e JOIN thought_work_claims c USING (thought_id, work_type) JOIN thoughts t ON t.id = c.thought_id
     WHERE e.work_type = ${job} AND c.status IN ('pending', 'claimed') AND e.stops > 0 AND ${currentProgress(sql, sig)}
     ORDER BY 3 DESC, e.stops DESC, e.thought_id LIMIT ${SLEEP_HELD_NAMED}`) as { id: string; stops: number; stalled: number; kept: number; windows: number | null; total: number }[];
  return { total: rows[0]?.total ?? 0, thoughts: rows.map(({ total: _t, ...r }) => ({ ...r, windows: r.windows ?? null })) };
}

/**
 * The newest live event after `after` — a timestamp, or a number of seconds
 * before now() — and the database's now(). A read is a query_log row (when
 * `readsLog`); a write is a thought_audit row whose actor_kind is not
 * 'ingested' (NULL counts as live) and that no server's background work wrote
 * (actor_context.background — the vector mender's, SMD-2889), as these
 * passes' own writes are not live. Bounded below, so a brain whose newest
 * audit rows are all sync writes is not read back to its last live one.
 */
async function newestLive(sql: SQL, after: Date | number, readsLog: boolean): Promise<{ now: Date; read: Date | null; write: Date | null }> {
  const since = typeof after === "number" ? sql`now() - make_interval(secs => ${after})` : sql`${after}::timestamptz`;
  const read = readsLog ? sql`(SELECT max(logged_at) FROM query_log WHERE logged_at > ${since})` : sql`NULL::timestamptz`;
  const [r] = await sql`
    SELECT now() AS now, ${read} AS read,
           (SELECT max(created_at) FROM thought_audit WHERE created_at > ${since} AND actor_kind IS DISTINCT FROM 'ingested'
              AND (actor_context->>'background') IS NULL) AS write`;
  return { now: new Date(r.now), read: r.read ? new Date(r.read) : null, write: r.write ? new Date(r.write) : null };
}

const newer = (a: Date | null, b: Date | null): Date | null => (a && b ? (a > b ? a : b) : a ?? b);

/** Whether this role can read query_log: its owner can, and a role granted the `sleep` group (db/config.mjs). */
async function readsQueryLog(sql: SQL): Promise<"yes" | "denied" | "missing"> {
  try {
    await sql`SELECT 1 FROM query_log LIMIT 0`;
    return "yes";
  } catch (e) {
    const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
    if (code === "42501") return "denied";
    // A brain before migration 034 has no log to read.
    if (code === "42P01") return "missing";
    throw e;
  }
}

/**
 * A claim follower's heartbeat key as pass-stamp.ts writes one (brain-info.ts's
 * alphabet): any other row under the prefix is not counted, and is never
 * pasted into the DELETE the refusal prints (review pass 1). Matched in the
 * query, as Postgres reads the same pattern, so no other row takes a place
 * under the read's bound (review pass 2).
 */
const FOLLOWER_KEY = /^heartbeat:(extract|consolidate):[A-Za-z0-9._:@/+-]{1,120}$/;

/** The claim followers stamping outside this scheduler, fresh as brain-info.ts reads a heartbeat: they do not yield to a live call. Newest first, so stale rows never hide a fresh one past the bound. */
async function followersOutside(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT key, value, extract(epoch FROM now() - updated_at)::float8 AS age_s FROM ob1_config
     WHERE key ~ ${FOLLOWER_KEY.source} ORDER BY updated_at DESC LIMIT 20`) as { key: string; value: string; age_s: number }[];
  return rows.filter((r) => {
    try {
      const v = JSON.parse(r.value) as { every_s?: number; ended?: boolean };
      return !v.ended && typeof v.every_s === "number" && Number(r.age_s) <= v.every_s * STALE_AFTER_INTERVALS;
    } catch { return false; }
  }).map((r) => r.key);
}

/** The `slept` mark heartbeat:sleep carries now, when of the shape: what a refusal's stamp keeps (review pass 4). */
async function lastSlept(sql: SQL): Promise<SleepMark | null> {
  const [r] = (await sql`SELECT value, updated_at FROM ob1_config WHERE key = 'heartbeat:sleep'`) as { value: string; updated_at: Date | string }[];
  if (!r) return null;
  try {
    const s = (JSON.parse(r.value) as { slept?: { from?: unknown; to?: unknown } }).slept;
    if (!(s && typeof s.from === "string" && (s.to === null || typeof s.to === "string"))) return null;
    // A sleep the last process never ended — killed mid-sleep, most likely,
    // as it is asleep most of the time — ends at its row's last stamp, within
    // a minute of the truth (it stamped at least that often asleep): a mark
    // with no end reads "no sleep yet" to preflight's awake row (SMD-2752 PR 3,
    // review pass 2).
    return { from: s.from, to: s.to ?? new Date(r.updated_at).toISOString() };
  } catch {
    return null;
  }
}

/**
 * The line naming followers outside the scheduler: the dry run's, or a run's
 * refusal — at its start, or found later in an awake or asleep poll (review
 * pass 1: a follower started with this, as `COMPOSE_PROFILES=workers,sleep`
 * does, stamps only after its start probe, past the start's check). The keys
 * are FOLLOWER_KEY's alphabet, so the DELETE it prints is safe to paste.
 */
function outsideLine(outside: string[], dryRun: boolean): string {
  return `  ${dryRun ? "followers running outside sleep, which do not yield to a live call" : "refused: followers are running outside sleep, and they do not yield to a live call"}: ${outside.join(", ")} — the workers profile's, or a --follow run by hand. The sleep and workers profiles are alternatives: stop them (podman compose -f deploy/compose.yaml --profile workers stop extract consolidate, with the -f files and -p the stack was started with; and take workers out of COMPOSE_PROFILES in deploy/.env), then delete their rows (DELETE FROM ob1_config WHERE key IN (${outside.map((k) => `'${k}'`).join(", ")})) so preflight does not ask for them back. A follower stopped cleanly marks its row ended at once; one killed past its grace leaves it fresh for up to three of its intervals`;
}

const ago = (now: Date, t: Date | null): string => (t ? `${Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000))} s ago` : "none");

/**
 * The scheduler's line for a pass's start refusal that ends it — at the
 * check, a permanent one at a later sleep, or one at a pass's first start in
 * this process — with what to do beyond the pass's own words: those name the
 * cause, but the key's name a --switch-key this script does not take, and a
 * revoked key's no way back (review pass 6, an operator's walk through each
 * refusal).
 */
function refusedLine(pass: PassName, kind: StartRefusal | undefined, ends: string): string {
  // The other kinds' own words name their fix; preflight's row gives every kind's (db/config.mjs, SMD-2752).
  const remedy = kind === "key" || kind === "identity" ? `; ${startRefusalRemedy(kind)}` : "";
  return `  ${pass}'s start is refused${kind ? ` (${kind})` : ""} — ${ends}: fix what it names, then start the service again${remedy}`;
}

/** The scheduler's numbers from its options, or the refusal of the first that breaks its flag's rule. */
function numbers(opts: SleepOptions): { quiet: number; poll: number; workers: number } | string {
  const read = (flag: string, v: number | null | undefined, absent: number, rule: { min: number; max?: number }): number | string => {
    if (v == null) return absent;
    const problem = numberProblem(flag, v, rule);
    return problem === null ? v : `${problem}\n${flagList(FLAGS, HINTS)}`;
  };
  const quiet = read("--quiet", opts.quiet, DEFAULT_QUIET_S, { min: 1, max: 86_400 });
  if (typeof quiet === "string") return quiet;
  const poll = read("--poll", opts.poll, DEFAULT_POLL_S, { min: 1, max: MAX_POLL_S });
  if (typeof poll === "string") return poll;
  const workers = read("--workers", opts.workers, 1, { min: 1, max: MAX_WORKERS });
  if (typeof workers === "string") return workers;
  return { quiet, poll, workers };
}

/**
 * The scheduler, callable: the CLI's run, returning the code the CLI exits
 * with (the header's list). Nothing happens at import.
 */
export async function run(opts: SleepOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? NO_DATABASE_URL : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  const settled = numbers(opts);
  if (typeof settled === "string") {
    err(settled);
    return 2;
  }
  // A caller's, not an operator's, so thrown: 0 would hand the passes no
  // --follow at all. The rule the flags' numbers keep (SMD-3048).
  const followProblem = opts.passFollowS === undefined ? null : numberProblem("passFollowS", opts.passFollowS, { min: 1 });
  if (followProblem !== null) throw new RangeError(followProblem);
  if (opts.signal?.aborted && !opts.dryRun) {
    err(STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: 2 });
  try {
    return await sleepWith(sql, opts.url as string, opts, settled, out, err);
  } finally {
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** A pass the scheduler started: its run, its stop once the pass began, and the signal that stops it before. */
type Running = { name: PassName; done: Promise<number>; settled: boolean; code: number | null; stop: PassStop | null; abort: AbortController; hushed: boolean; start: StartResult | null };

async function sleepWith(sql: SQL, url: string, opts: SleepOptions, n: { quiet: number; poll: number; workers: number }, out: Writer["out"], err: Writer["err"]): Promise<number> {
  const { quiet: QUIET, poll: POLL, workers: WORKERS } = n;
  const FOLLOW = opts.follow === true;
  const env = opts.env ?? process.env;
  const cfg = resolveEmbedConfig(env as EmbedEnv);
  const JOBS: Record<PassName, string> = { extract: extractionKey(cfg.metadataModel), consolidate: consolidateKey(cfg.judgeModel) };

  // The start's reads wait out a database not answering yet, as the sleep's
  // own do (reading, below): the compose service starts beside a Postgres that
  // may be restarting, and an exit here would spend one of its three restarts
  // (SMD-2678). A stop during the wait ends the run as a stop before it began.
  const startSaid = { down: false };
  /** The CLI passes no signal (its handlers come after these reads): a wait then ends only with the database. */
  const startWake = opts.signal ?? new AbortController().signal;
  const atStart = <T>(read: () => Promise<T>) => throughOutage(read, { wake: startWake, said: startSaid, out, err });
  const logState = await atStart(() => readsQueryLog(sql));
  if (logState === null) { err(STOPPED_EARLY); return 130; }
  /** The database's clock as this run began: a claim older than it is no pass of this run's (poolOf's `mineSince`). */
  const startedAt = await atStart(async () => new Date((await sql`SELECT now() AS now`)[0].now));
  if (startedAt === null) { err(STOPPED_EARLY); return 130; }
  const readsLog = logState === "yes";
  out(`  quiet:  ${QUIET} s with no write in thought_audit but sync's (actor_kind 'ingested') and the vector mender's (marked background)${readsLog ? " and no read logged in query_log" : " — reads are not watched"}`);
  if (logState === "denied") err("  query_log: this role cannot read it — only writes wake the brain; grant it the sleep group (bun db/migrate.ts --grant <role> --groups sleep) or run as the owner for reads to wake it");
  else if (logState === "missing") err("  query_log: no such table (migration 034 not applied) — only writes wake the brain");
  else {
    // The log is written only under the server's OB1_QUERY_LOG=on, off by
    // default, and nothing in the database says which: a log with no recent
    // row is said once, since a search then never wakes the brain.
    const recent = await atStart(async () => (await sql`SELECT EXISTS (SELECT 1 FROM query_log WHERE logged_at > now() - make_interval(secs => ${QUERY_LOG_QUIET_S})) AS recent`)[0].recent === true);
    if (recent === null) { err(STOPPED_EARLY); return 130; }
    if (!recent) err("  query_log: no row in the last 24 h — either nothing was searched, or OB1_QUERY_LOG is off on the server (its default), and then a search is not logged and does not wake the brain; only writes do");
  }
  const outside = await atStart(() => followersOutside(sql));
  if (outside === null) { err(STOPPED_EARLY); return 130; }
  // Followers outside the scheduler do not yield to a live call, so a sleep
  // beside them is no sleep: a run refuses (2) rather than start one, and the
  // dry run names them (SMD-2678). The workers and sleep profiles are
  // alternatives.
  // A signal aborted during the start's reads — one that did not wait on an
  // outage, where the wait returns 130 itself — is a stop before the run
  // began, and wins over what the reads found, a follower included: 130 and
  // no row, one rule (review passes 2 and 4).
  if (opts.signal?.aborted && !opts.dryRun) {
    err(STOPPED_EARLY);
    return 130;
  }
  /**
   * A pass's lines, each tagged with its name, and its own words for a stop
   * the scheduler made it take left out once `hushed` says so.
   */
  const tagged = (name: PassName, hushed: () => boolean): Writer => {
    const tag = (line: string) => line.split("\n").map((l) => (l.trim() ? `  [${name}]${l}` : l)).join("\n");
    const say = (write: Writer["out"]) => (l: string) => { if (!(hushed() && PASS_STOP_LINE.test(l))) write(tag(l)); };
    return { out: say(out), err: say(err) };
  };
  /**
   * A refusal at the start, under --follow said on the row too, ended on a
   * failure, so preflight's `sleep` row names what keeps the service down
   * rather than reading it as never run, or as one to start again (review
   * pass 3). The row's last sleep is carried over, since a stamp writes the
   * whole value (review pass 4).
   */
  const endAtStart = async (refused?: StartRefusal): Promise<void> => {
    if (!FOLLOW) return;
    const once = passStamper({ sql, worker: "sleep", intervalS: POLL, minEveryS: opts.minStampEveryS, onError: (e) => err(`  heartbeat: could not stamp heartbeat:sleep (${e.message})`) });
    once.watching?.(logState);
    const last = await lastSlept(sql).catch(() => null);
    if (last) once.slept?.(last);
    // The start refusal that ended it, when a pass's start was the cause:
    // preflight's row names it and its remedy (SMD-2752).
    if (refused) once.refused?.(refused);
    await once.end("failed");
  };
  if (outside.length) {
    err(outsideLine(outside, opts.dryRun === true));
    if (!opts.dryRun) {
      await endAtStart();
      return 2;
    }
  }
  // Whether this role reads 093's kept windows (SMD-2694): consolidation joins
  // past a thought extraction holds only when it can tell one, and the row
  // names the held thoughts only then. Read once, as the query log's state is;
  // a brain before 093, or a role without the extraction group's grant on it,
  // joins once extraction is drained, as before, and is told so once.
  const progressState = await atStart(async () => (await sql`
    SELECT CASE WHEN to_regclass('public.extraction_progress') IS NULL THEN 'missing'
                WHEN has_table_privilege('public.extraction_progress', 'SELECT') THEN 'yes' ELSE 'denied' END AS s`)[0].s as "yes" | "missing" | "denied");
  if (progressState === null) { err(STOPPED_EARLY); return 130; }
  /** The windowing extraction runs under, which a kept row must match to speak for the thought: set only when the rows are readable. */
  const SIG = progressState === "yes" ? JSON.stringify(windowingFor(cfg)) : undefined;
  if (progressState !== "yes") err(`  extraction_progress: ${progressState === "missing" ? "no such table (migration 093 not applied)" : "this role cannot read it (the extraction group's grant)"} — consolidation joins only once extraction is drained, and a thought the wakes hold back goes unnamed; a running scheduler takes it up once restarted`);

  if (opts.dryRun) {
    const [{ now }] = await sql`SELECT now() AS now`;
    const at = new Date(now);
    const [last] = await sql`
      SELECT ${readsLog ? sql`(SELECT max(logged_at) FROM query_log)` : sql`NULL::timestamptz`} AS read,
             (SELECT created_at FROM thought_audit WHERE actor_kind IS DISTINCT FROM 'ingested' AND (actor_context->>'background') IS NULL ORDER BY created_at DESC LIMIT 1) AS write`;
    const read = last.read ? new Date(last.read) : null;
    const write = last.write ? new Date(last.write) : null;
    const newest = newer(read, write);
    const left = newest ? QUIET - (at.getTime() - newest.getTime()) / 1000 : 0;
    out(`  last read: ${readsLog ? ago(at, read) : "not readable"}; last write: ${ago(at, write)}`);
    out(left <= 0 ? "  a sleep would begin now" : `  awake: a sleep would begin in ${Math.ceil(left)} s with no live call`);
    for (const pass of PASSES) {
      const p = await poolOf(sql, pass, JOBS[pass], SIG);
      out(`  ${pass} (${JOBS[pass]}): ${p.claimed} in flight, ${p.pending} pending, ${p.unpooled} not yet in the pool, ${p.failed} failed${drained(p) ? " — drained" : joinsPast(p) ? ` — only ${p.stalled} stalled thought(s), which consolidation would join past` : ""}`);
    }
    if (SIG !== undefined) {
      const held = await heldBack(sql, JOBS.extract, SIG);
      if (held.total) out(`  held back across wakes (${held.thoughts.length} of ${held.total}): ${held.thoughts.map(heldWords).join("; ")}`);
    }
    return 0;
  }

  // ── The passes' starts, checked once (SMD-2752) ──────────────────────────
  // Each pass's own start — its banner, the egress gate, the tables, the
  // model's probe, the worker key, extraction's recorded key — run once here
  // (the engines' `check`), so a misconfiguration ends the service at its
  // start rather than at the first quiet, or after extraction's backlog for
  // consolidation's judge. The passes each sleep starts leave their banner to
  // this. A provider that does not answer is no refusal: each pass waits for
  // it at its own start, as before. The check runs before this process's
  // heartbeat exists — its probes up to a minute each, a database outage as
  // long as it lasts — so preflight reads the last process's row meanwhile,
  // as during the start's reads above; a refusal, or an error the check
  // throws, ends the row failed (review passes 1 and 3). Its probes are model
  // calls at the service's start whatever the brain's traffic — one token to
  // each model, which on a tight GPU may swap a model in once per start.
  /**
   * The passes whose start got through in this process — the provider
   * answered their probe, the keys resolved — at this check or at a sleep's
   * start (onPass). A model or provider refusal at a later start is then one
   * a re-pull or a top-up can mend, and is retried (review pass 3 of
   * SMD-1794; the check feeds it since SMD-2752).
   */
  const begun = new Set<PassName>();
  for (const pass of PASSES) {
    // Written in the callback, which control-flow analysis does not follow:
    // the cast keeps the declared type (SMD-1932's idiom).
    let result = null as StartResult | null;
    // A check that throws — a grant refused on a read, say — ends the row
    // failed before it propagates, as a pass that throws at a sleep does in
    // the loop below, rather than leave the last process's row (review pass 3).
    const code = await (pass === "extract" ? runExtract : runConsolidate)({
      url, env, workers: WORKERS, follow: opts.passFollowS ?? PASS_FOLLOW_S, signal: opts.signal, check: true,
      onStart: (r) => { result = r; }, writer: tagged(pass, () => false),
    }).catch(async (e: unknown) => {
      await endAtStart().catch(() => {});
      throw e;
    });
    // The engine said its own "stopped before the pass began".
    if (code === 130) return 130;
    if (code !== 0) {
      const kind = result && !result.ok ? result.refused : undefined;
      err(refusedLine(pass, kind, "the scheduler does not start"));
      await endAtStart(kind);
      return code;
    }
    if (result?.ok && result.provider === "up") begun.add(pass);
  }
  // A stop during the checks, landed after the last of them returned: a stop before the run began.
  if (opts.signal?.aborted) {
    err(STOPPED_EARLY);
    return 130;
  }

  // ── The heartbeat ────────────────────────────────────────────────────────
  // Only --follow stamps, as only a follower does: one sleep leaves no row to go stale.
  const stamper: PassStamper = FOLLOW
    ? passStamper({ sql, worker: "sleep", intervalS: POLL, minEveryS: opts.minStampEveryS, onError: (e) => err(`  heartbeat: could not stamp heartbeat:sleep (${e.message}) — the scheduler goes on as it was; the row keeps its last word until a stamp lands`) })
    : { key: "", stamp: async () => {}, end: async () => {}, during: (p) => p, alive: async () => {} };
  // What wakes it, on its own row: preflight's `sleep` row reads this, not its
  // own role's privileges (SMD-2678, review pass 1).
  stamper.watching?.(logState);
  // The last process's sleep, carried until this one sleeps: a stamp writes
  // the whole value, and a restarted scheduler's first row read "no sleep
  // yet" in preflight (review pass 1 of SMD-2752 PR 3; SMD-2678's mark).
  if (FOLLOW) {
    // Through the start's outage wait, as the other start reads: a blip here
    // would drop the mark (review pass 2). A stop during the wait, or another
    // error, leaves it to the first sleep.
    const last = await atStart(() => lastSlept(sql)).catch(() => null);
    if (last) stamper.slept?.(last);
  }
  /**
   * The thoughts extraction holds back across the wakes, on the row for
   * preflight's `sleep` row (SMD-2694): read at the first stamp awake or the
   * first poll asleep, after each wake, at least every minute after — a thought held back is most
   * often finished in a long sleep, which ends at the next live call, hours
   * later (review pass 1) — and before the row ends; carried by the next
   * write. A courtesy, as the tail move is: a read that fails is said once and
   * leaves the row's last word on them.
   */
  let saidHeld = false;
  let heldAt = 0;
  const sayHeld = async (): Promise<void> => {
    if (SIG === undefined || !FOLLOW) return;
    heldAt = Date.now();
    try {
      stamper.held?.(await heldBack(sql, JOBS.extract, SIG));
      // A later failure is said again (review pass 2).
      saidHeld = false;
    } catch (e) {
      if (!saidHeld) err(`  could not read the thoughts the wakes hold back (${(e as Error).message}) — the row keeps its last word on them`);
      saidHeld = true;
    }
  };
  // No read here: the first awake stamp reads them, as does the first asleep poll.
  let saidStalled = false;
  const stalledUnread = (e: Error): void => {
    if (!saidStalled) err(`  could not read the stalled thoughts (${e.message}) — consolidation joins only once extraction is drained while it stays unreadable; every poll reads it again`);
    saidStalled = true;
  };
  /** The row's end, the held thoughts read first: an operator's hand run since may have finished one. */
  const endRow = async (o: "stopped" | "failed", m?: MalformedBlock): Promise<void> => {
    await sayHeld();
    await stamper.end(o, m);
  };
  const everyMs = Math.max(opts.minStampEveryS ?? MIN_STAMP_EVERY_S, POLL) * 1000;
  /** Each pass's last word in this sleep, and extraction's last judged block. */
  const words: Partial<Record<PassName, PassOutcome>> = {};
  let malformed: MalformedBlock | null | undefined;
  const sleepOutcome = (): "ok" | "failed" => (Object.values(words).includes("failed") ? "failed" : "ok");
  /**
   * The passes waiting at their start for a provider that does not answer,
   * as each says through its stamper: heartbeat:sleep carries them, so
   * preflight's row says the sleep waits on the provider rather than that its
   * passes run (SMD-2752).
   */
  const waitingAtStart = new Set<PassName>();
  /** The passes waiting mid-pass for a provider that stopped answering (consolidate.ts's providerWait): kept off the row (SMD-2905), read by the poll (SMD-3008). */
  const waitingMidPass = new Set<PassName>();
  const sayWaiting = async (): Promise<void> => {
    stamper.waiting?.(PASSES.filter((p) => waitingAtStart.has(p)));
    await stamper.alive();
  };
  /** What a pass stamps goes to the sleep's row: its outcome mid-sleep, never an end, which is the scheduler's. */
  const through = (pass: PassName): PassStamper => ({
    key: stamper.key,
    async stamp(o, m) {
      words[pass] = o;
      if (m !== undefined) malformed = m;
      await stamper.alive(sleepOutcome(), malformed ?? undefined);
    },
    async end(o, m) {
      if (o === "failed") words[pass] = o;
      if (m !== undefined) malformed = m;
    },
    during: (p) => p,
    alive: async () => {},
    async startWait(on) {
      if (on) waitingAtStart.add(pass);
      else waitingAtStart.delete(pass);
      await sayWaiting();
    },
    async providerWait(on) {
      if (on) waitingMidPass.add(pass);
      else waitingMidPass.delete(pass);
    },
  });

  // ── The scheduler's stop ─────────────────────────────────────────────────
  let stopping = false;
  let hardStopped = false;
  let finished = false;
  /** Aborted by the first stop: the awake wait and the sleep's poll wake on it. */
  const onStop = new AbortController();
  const running: Running[] = [];
  // A pass's signal is its first stop, and aborting it again does nothing; its
  // PassStop called after that is the hard stop — the leases returned and the
  // call in hand aborted. A pass not yet begun has no PassStop: the signal
  // stops it before it claims. Either way the pass's own words for the stop
  // (a "signal" the operator did not send) are left out (`hushed`).
  const softStop = (p: Running): void => {
    p.hushed = true;
    if (!p.settled) p.abort.abort();
  };
  const hardStop = async (p: Running): Promise<void> => {
    p.hushed = true;
    if (p.settled) return;
    p.abort.abort();
    await p.stop?.();
  };
  const stop: PassStop = () => {
    if (finished) return null;
    if (stopping) {
      hardStopped = true;
      err("\n  second signal — the passes stop now, their leases returned");
      // The row ends before the CLI exits on the release (stopOnSignals), so
      // it reads stopped rather than running until it goes stale.
      // The row's end directly: the CLI exits 3 s after this signal, and the
      // held read would spend that (review pass 2); the row reads stopped,
      // and preflight names a stopped scheduler's held thoughts at its last word.
      return Promise.all(running.map(hardStop)).then(() => stamper.end("stopped", malformed ?? undefined));
    }
    stopping = true;
    onStop.abort();
    for (const p of running) softStop(p);
    err("\n  stopping: the passes after the thought in hand (again to stop them now)");
    return null;
  };
  const abort = () => {
    if (stopping) return;
    stopping = true;
    onStop.abort();
    for (const p of running) softStop(p);
    err("\n  stopping: the passes after the thought in hand");
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  // A signal aborted during the start's reads has already fired, and a listener
  // added now never would (review pass 1).
  if (opts.signal?.aborted) abort();
  opts.onPass?.(stop);

  /** A database read that outlasts the database going away (worker-bootstrap.ts's throughOutage): null when a stop ended the wait. */
  const said = { down: false };
  const reading = <T>(read: () => Promise<T>): Promise<T | null> => throughOutage(read, { wake: onStop.signal, said, out, err });

  /** Aborted when a pass of the current sleep settles, so its poll wakes to read why. */
  let passEnded = new AbortController();
  const start = (name: PassName, workers = WORKERS): Running => {
    const abort = new AbortController();
    const p: Running = { name, done: Promise.resolve(0), settled: false, code: null, stop: null, abort, hushed: false, start: null };
    // Its banner and its summary's queries are left out: the check said the
    // one at the scheduler's start, and the other is a scan the scheduler
    // would wait for at a wake (SMD-2752). Its start is reported, so a
    // refusal is told apart.
    const common = {
      url, env, workers, follow: opts.passFollowS ?? PASS_FOLLOW_S, signal: abort.signal, stamper: through(name),
      banner: false, summary: false,
      onStart: (r: StartResult) => { p.start = r; },
      onPass: (s: PassStop) => { p.stop = s; begun.add(name); },
      writer: tagged(name, () => p.hushed),
    };
    const ended = passEnded;
    // Extraction's stall floor is its own (consolidation counts no stall).
    p.done = (name === "extract" ? runExtract({ ...common, stallFloorMs: opts.stallFloorMs }) : runConsolidate(common)).then((code) => {
      p.settled = true;
      p.code = code;
      ended.abort();
      return code;
    }, (e) => {
      p.settled = true;
      ended.abort();
      throw e;
    });
    // Handled now, read later: a pass that throws is rejected out of
    // stopPasses at the next poll, and until then the runtime would report it
    // unhandled — printed twice, and an in-process host's exit forced to 1
    // (review pass 4). allSettled still sees the rejection.
    p.done.catch(() => {});
    running.push(p);
    return p;
  };

  /** Stop every pass — hard, a wake; soft, a sleep done — and wait for each to return. A pass that threw rejects here, once the others have stopped. */
  const stopPasses = async (hard: boolean): Promise<void> => {
    if (hard) await Promise.all(running.map(hardStop));
    else for (const p of running) softStop(p);
    const results = await Promise.allSettled(running.map((p) => p.done));
    running.length = 0;
    // A stopped pass waits for nothing, and each says so as its wait ends (the
    // engines' finally): defensive only, the set is empty here (review pass 1).
    if (waitingAtStart.size) {
      waitingAtStart.clear();
      stamper.waiting?.([]);
    }
    waitingMidPass.clear();
    const thrown = results.find((r) => r.status === "rejected");
    if (thrown) throw (thrown as PromiseRejectedResult).reason;
  };

  /**
   * The claims this process's passes hold — their worker ids carry the host
   * and pid (extract-entities.ts's and consolidate.ts's `workerId`) — read
   * before a wake's hard stop returns them.
   */
  const heldHere = async (): Promise<{ id: string; job: string }[]> =>
    (await sql`
      SELECT thought_id::text AS id, work_type AS job FROM thought_work_claims
       WHERE work_type IN (${JOBS.extract}, ${JOBS.consolidate}) AND status = 'claimed'
         AND (starts_with(worker_id, ${MINE}) OR starts_with(worker_id, ${`consolidate-${hostname()}-${process.pid}-`}))`) as { id: string; job: string }[];
  /**
   * A wake's abandoned claims to the back of the queue. The release keeps
   * enqueued_at and counts no attempt (015), and claims are taken oldest
   * first, so a thought longer than the sleeps would be taken first by every
   * sleep and the pool behind it would never move (review pass 1, run).
   */
  let saidTail = false;
  const toTail = async (held: { id: string; job: string }[]): Promise<void> => {
    if (held.length === 0) return;
    try {
      await sql`
        UPDATE thought_work_claims c SET enqueued_at = now()
          FROM unnest(${sql.array(held.map((h) => h.id), "TEXT")}::uuid[], ${sql.array(held.map((h) => h.job), "TEXT")}::text[]) AS u(id, job)
         WHERE c.thought_id = u.id AND c.work_type = u.job AND c.status = 'pending'`;
    } catch (e) {
      if (!saidTail) err(`  could not move the thought(s) the wake left to the back of the queue (${(e as Error).message}) — the next sleep takes them first again`);
      saidTail = true;
    }
  };

  /**
   * The thoughts a stop has taken, to the back of the queue as each sleep
   * begins (093's stops, at the text and windowing in force; review pass 5):
   * a wake's tail move dates them at the wake, so every capture of the awake
   * period after it queued behind them — a stalled thought then held the one
   * worker each sleep until the next wake, those captures unextracted all day
   * and the pool never all stalled. New work first, the long thoughts last,
   * and among them the least stalled first, then the order they had: dated
   * alike, claim_thoughts' tie fell the same way every sleep, so a stalled
   * thought could hold the worker ahead of a document still gaining windows,
   * or of one stall short of the join, and neither advanced (review pass 6).
   * Dated FORWARD_DAYS ahead, not now: a capture made during the sleep —
   * a sync write's, which wakes nothing — is enqueued at its own now(), and
   * behind a stalled thought dated at the sleep's start it waited out the
   * window in hand (SMD-3008). claim_thoughts orders by enqueued_at and reads
   * no clock (015), so the date is an order, not a delay; a wake's tail move
   * dates the thought(s) in hand now, and the next sleep dates every stopped
   * thought forward again. A courtesy, as the
   * wake's tail move is: one that fails is said once, and returns false.
   * A lapsed lease is moved too: a scheduler gone left it claimed, and the
   * next claim reaps it with its old date, ahead of the sleep's captures
   * (review pass 2).
   */
  let saidRetail = false;
  const stoppedLast = async (): Promise<boolean> => {
    if (SIG === undefined) return false;
    try {
      // A forward date outlives its stop record: a thought finished since (its
      // row deleted) and put back by a --retry-* flag or retry_failed keeps the
      // date and went behind every capture for up to 30 days. Dated now, then
      // moved forward again below if it is still a stopped thought (post-merge review).
      await sql`
        UPDATE thought_work_claims c SET enqueued_at = now()
         WHERE c.work_type = ${JOBS.extract} AND c.status = 'pending' AND c.enqueued_at > now()
           AND NOT EXISTS (SELECT 1 FROM extraction_progress e JOIN thoughts t ON t.id = e.thought_id
                            WHERE e.thought_id = c.thought_id AND e.work_type = c.work_type AND e.stops > 0 AND ${currentProgress(sql, SIG)})`;
      await sql`
        UPDATE thought_work_claims c SET enqueued_at = now() + make_interval(days => ${FORWARD_DAYS}) + o.rn * interval '1 microsecond'
          FROM (SELECT c2.thought_id, row_number() OVER (ORDER BY CASE WHEN e.gained > 0 THEN 0 ELSE e.stalled END, c2.enqueued_at, c2.thought_id) AS rn
                  FROM thought_work_claims c2 JOIN extraction_progress e USING (thought_id, work_type) JOIN thoughts t ON t.id = c2.thought_id
                 WHERE c2.work_type = ${JOBS.extract} AND (c2.status = 'pending' OR (c2.status = 'claimed' AND c2.ttl_expires_at < now()))
                   AND e.stops > 0 AND ${currentProgress(sql, SIG)}) o
         WHERE c.thought_id = o.thought_id AND c.work_type = ${JOBS.extract}`;
      return true;
    } catch (e) {
      if (!saidRetail) err(`  could not move the stopped thoughts behind new captures (${(e as Error).message}) — they are taken in queue order this sleep`);
      saidRetail = true;
      return false;
    }
  };

  /**
   * Followers found outside the scheduler after its start: a follower started
   * with it (both profiles at once) stamps only past its start probe. Each
   * awake and asleep poll reads them, and one found ends the run as the
   * start's refusal does (2).
   */
  let foreign: string[] = [];
  const outsideNow = async (): Promise<boolean> => {
    const found = await reading(() => followersOutside(sql));
    if (found && found.length) foreign = found;
    return foreign.length > 0;
  };

  /** Awake: wait until the brain has been quiet --quiet seconds. The database's now() when it fell asleep, or null on a stop or followers found outside. */
  const awaitQuiet = async (): Promise<Date | null> => {
    let stampedAt = 0;
    while (!stopping) {
      if (await outsideNow()) return null;
      const r = await reading(() => newestLive(sql, QUIET, readsLog));
      if (r === null) return null;
      const newest = newer(r.read, r.write);
      if (newest === null) return r.now;
      if (Date.now() - stampedAt >= everyMs) {
        // On heldAt, not this wait's stamp: a wake's own read is a moment old (review pass 2).
        if (Date.now() - heldAt >= everyMs) await sayHeld();
        await stamper.alive();
        stampedAt = Date.now();
      }
      const left = QUIET * 1000 - (r.now.getTime() - newest.getTime());
      await sleepUnless(Math.min(everyMs, Math.max(POLL * 1000, left)), onStop.signal);
    }
    return null;
  };

  /** The database's now() at the sleep's last read: the end of its `slept` mark (SMD-2678). */
  let sleptUntil = new Date(0);
  /**
   * Asleep from `since`: extraction alone until its pool drains, then
   * consolidation beside it. Returns one of: "woken" on a live event; "done"
   * when one sleep (no --follow) drained both; "stopped" on a stop, the passes
   * stopped before it returns, inside the heartbeat's `during`; or, for a pass
   * that ended by itself (a refusal), its name, its code and whether it had
   * got past its start in this sleep; or "outside" when a poll found a
   * follower running outside it, the passes stopped (hard) first.
   */
  const asleep = async (since: Date): Promise<"woken" | "done" | "stopped" | "outside" | { pass: PassName; code: number; started: boolean; refused?: StartRefusal }> => {
    for (const k of PASSES) delete words[k];
    passEnded = new AbortController();
    let wake = AbortSignal.any([onStop.signal, passEnded.signal]);
    const stopped = async (): Promise<"stopped"> => {
      await stopPasses(hardStopped);
      return "stopped";
    };
    out(`  asleep: no live call for ${QUIET} s — extracting${FOLLOW ? "" : ", then consolidating, until both pools are drained"}`);
    sleptUntil = since;
    /** Whether the stopped thoughts can be moved behind newer work: a restart for it is no use otherwise. */
    let reorders = await stoppedLast();
    let consolidating = false;
    /**
     * Extraction set aside while consolidation goes first (review pass 5):
     * when extraction holds only stalled thoughts, starting it would claim one
     * at once, and on a one-slot model its window held the slot the judge
     * waited for until the wake aborted it — joining past judged nothing. It
     * starts once consolidation's pool drains, so a long sleep still reaches
     * the stalled thought.
     */
    let parked = false;
    /**
     * Extraction restarted for work that landed behind a stalled thought in
     * hand (SMD-3008): the polls in a row that read it so — two, so a second
     * worker between its claims, or a capture racing the join, is not one —
     * and when it last was, at most once a minute.
     */
    let behindPolls = 0;
    let restartedAt = 0;
    const restartEvery = opts.restartEveryMs ?? RESTART_EVERY_MS;
    /** Extraction's pool as this sleep reads it: 093's stalled read, this run's claims, the claims alone when asked. */
    const extractPool = (claimsOnly = false) => poolOf(sql, "extract", JOBS.extract, SIG, stalledUnread, claimsOnly, startedAt);
    /**
     * Extraction let out of the set-aside while consolidation waits for its
     * provider — at its start, or mid-pass (providerWait) — for the
     * newer work only: its pool would not drain until the judge answered, and
     * extraction got nothing for the sleep (SMD-3008). Set aside again once it
     * reaches the stalled thought(s), which wait for consolidation as before,
     * so the judge, on the same chat endpoint, never queues behind their
     * window when it answers. Let out at most once a minute, the restart's bound.
     */
    let aside = false;
    const judgeWaits = (): boolean => waitingAtStart.has("consolidate") || waitingMidPass.has("consolidate");
    /**
     * Extraction stopped hard and taken out of the sleep's passes, for the
     * join, the restart, the let-out's set-aside and the drain's alike. True
     * when a stop landed while it settled: no
     * pass starts after it, nor stamps a row a second signal has ended (review
     * pass 6).
     */
    const setAside = async (): Promise<boolean> => {
      const ex = running.find((r) => r.name === "extract");
      if (ex) {
        await hardStop(ex);
        await ex.done.catch(() => {});
        running.splice(running.indexOf(ex), 1);
        // Its settling aborted the sleep's pass-ended signal, which the poll
        // waits on: re-armed, or every poll after returned at once and the
        // rest of the sleep read the database without pause (review pass 5).
        passEnded = new AbortController();
        wake = AbortSignal.any([onStop.signal, passEnded.signal]);
      }
      return stopping;
    };
    const firstPool = SIG === undefined ? null : await reading(() => extractPool());
    if (SIG !== undefined && firstPool === null) return stopped();
    if (firstPool && joinsPast(firstPool)) {
      out(`  extraction holds only ${firstPool.stalled} thought(s) that ${SLEEP_STALLED_JOIN} or more long hard stops in a row took with no window gained — consolidating first; extraction resumes once its pool drains`);
      start("consolidate");
      consolidating = true;
      parked = true;
    } else {
      start("extract");
    }
    // An audit row carries its transaction's start: a capture begun before the
    // sleep and committed after it was not visible when the brain fell asleep,
    // and is dated before. The wake reads that far back — within the quiet
    // just read, where nothing visible then can stand.
    const from = new Date(since.getTime() - Math.min(QUIET, WAKE_SLACK_S) * 1000);
    for (;;) {
      if (stopping) return stopped();
      const live = await reading(() => newestLive(sql, from, readsLog));
      if (live === null) return stopped();
      sleptUntil = live.now;
      // A thought held back finished in this sleep is not named until the next wake otherwise.
      if (Date.now() - heldAt >= everyMs) await sayHeld();
      if (await outsideNow()) {
        // A soft stop that landed during the reads keeps its own: the thought
        // in hand finished, not abandoned (review pass 2).
        await stopPasses(hardStopped || !stopping);
        return "outside";
      }
      // A stop that landed during the reads wins: the passes it stopped have
      // settled, one waiting at its start at once (130), and would read as
      // ended by themselves — the row failed, not stopped (review pass 1). A
      // pass that throws still rejects out of the stop, the row ended failed.
      if (stopping) return stopped();
      // A pass that ended by itself before the wake is read first: a refusal
      // and a live call in one poll would otherwise read as the wake alone.
      const ended = running.find((p) => p.settled);
      if (ended) {
        // A pass that threw rejects out of stopPasses, after the others stop,
        // so past it the pass returned a code; a 0 unasked is no success.
        await stopPasses(true);
        const code = ended.code || 1;
        err(`  ${ended.name} ended by itself (exit ${ended.code}) — the sleep stops`);
        return { pass: ended.name, code, started: ended.stop !== null, refused: ended.start && !ended.start.ok ? ended.start.refused : undefined };
      }
      const woke = newer(live.read, live.write);
      if (woke !== null) {
        out(`  awake: a live ${live.read && woke === live.read ? "read" : "write"} at ${woke.toISOString()} — the passes stop now, their leases returned`);
        // The tail move is a courtesy to the next sleep: a read that fails
        // (a statement timeout) leaves the claims where they are, and the
        // wake goes on.
        const held = await reading(heldHere).catch((e: Error) => {
          err(`  could not read the claims the wake leaves (${e.message}) — the next sleep takes them first again`);
          return [];
        });
        await stopPasses(true);
        if (held) await toTail(held);
        // The stops just counted (093): the row names what the wakes hold back.
        await sayHeld();
        return "woken";
      }
      // The pools decide when consolidation joins, when extraction resumes
      // after it, and when one sleep is done — so a --follow consolidating
      // with extraction running reads none: the extraction pool's count is a
      // scan of every thought.
      if (parked) {
        const co = await reading(() => poolOf(sql, "consolidate", JOBS.consolidate));
        if (co === null) return stopped();
        if (drained(co)) {
          // Captures made while it was set aside (a sync write wakes nothing)
          // go ahead of the stalled thoughts, as the sleep's own did (review
          // pass 6: one waited out the stuck window first).
          await stoppedLast();
          // A stop that landed during the move: no pass starts after it (review pass 1).
          if (stopping) return stopped();
          out("  consolidation drained — extracting beside it, the stalled thought(s) last");
          start("extract");
          parked = false;
        } else if (judgeWaits() && reorders && Date.now() - restartedAt >= restartEvery) {
          const ex = await reading(() => extractPool(true));
          if (ex === null) return stopped();
          // Only where the stalled thoughts can be told and moved behind the
          // newer work: otherwise one is claimed first, set aside at the next
          // poll, and let out again a minute on (review pass 1).
          if (ex.stalledRead && newerWork(ex) > 0 && (reorders = await stoppedLast())) {
            if (stopping) return stopped();
            out(`  consolidation waits for its provider — extracting the ${newerWork(ex)} newer thought(s) meanwhile; the stalled thought(s) wait for consolidation`);
            // One worker, so the stalled thought is not claimed beside the
            // newer work, whose call it would hold on a one-slot model (review pass 1).
            start("extract", 1);
            parked = false;
            aside = true;
            restartedAt = Date.now();
          }
        }
      } else if (aside) {
        // Let out for the newer work while the judge waits: set aside again
        // once only stalled thoughts are in hand, or nothing is left to do;
        // once the judge answers and consolidation drains, extraction stays
        // out, as after any drain.
        const ex = await reading(() => extractPool(true));
        if (ex === null) return stopped();
        // Any stalled thought this process holds, or one it can no longer tell
        // (093 gone or refused since): a lease another left is not its own,
        // and would re-park it every minute (review pass 1).
        const stalledInHand = !ex.stalledRead || ex.stalledMine > 0;
        // (Two statements: a claim reaped between them reads more stalled
        // pending than pending, so `<=`: review pass 2.)
        if (stalledInHand || (ex.mine === 0 && newerWork(ex) <= 0)) {
          out(`  extraction ${!ex.stalledRead ? "cannot tell the stalled thought(s) now" : stalledInHand ? "has reached the stalled thought(s)" : "has done the newer work"} — set aside again until consolidation drains`);
          if (await setAside()) return stopped();
          aside = false;
          parked = true;
        } else if (!judgeWaits()) {
          const co = await reading(() => poolOf(sql, "consolidate", JOBS.consolidate));
          if (co === null) return stopped();
          // The let-out ran one worker: with more, it ends through the
          // set-aside once it holds nothing, so the drain's resume starts them
          // all, where it ran one for the rest of the sleep (review pass 2).
          if (drained(co)) {
            if (WORKERS === 1) aside = false;
            else if (ex.mine === 0) {
              if (await setAside()) return stopped();
              aside = false;
              parked = true;
            }
          }
        }
      } else if (!consolidating || !FOLLOW) {
        const pools = await reading(async () => ({ extract: await extractPool(), consolidate: consolidating ? await poolOf(sql, "consolidate", JOBS.consolidate) : null }));
        if (pools === null) return stopped();
        behindPolls = !consolidating && queuesBehind(pools.extract) ? behindPolls + 1 : 0;
        if (!consolidating && drained(pools.extract)) {
          out("  extraction drained — consolidating beside it");
          start("consolidate");
          consolidating = true;
        } else if (!consolidating && joinsPast(pools.extract) && !running.some((r) => r.name === "extract" && r.settled)) {
          // (An extraction that ended by itself during the reads is the next
          // poll's to report, not the join's to swallow: review pass 6.)
          // Only thoughts no stop has gained a window on lately are left:
          // waiting for them would hold consolidation back for as long as the
          // brain keeps waking (SMD-2694). A newer thought judged meanwhile
          // misses its pair with one of them, as consolidate.ts's header says
          // of an unextracted neighbour. Extraction, in hand with one of them,
          // is stopped and set aside until consolidation drains (review pass
          // 5); the stop counts on the thought as any hard stop does.
          out(`  extraction holds only ${pools.extract.stalled} thought(s) that ${SLEEP_STALLED_JOIN} or more long hard stops in a row took with no window gained — consolidating first; extraction resumes once its pool drains`);
          if (await setAside()) return stopped();
          start("consolidate");
          consolidating = true;
          parked = true;
        } else if (behindPolls >= 2 && reorders && Date.now() - restartedAt >= restartEvery && !running.some((r) => r.name === "extract" && r.settled)) {
          // Work landed behind the stalled thought(s) in hand — a capture made
          // during the sleep, dated after the move at its start — and neither
          // it nor consolidation, which joins past only an all-stalled pool,
          // would move before the window in hand ends or the brain wakes
          // (SMD-3008). Not once consolidation has joined: the stalled thought
          // has its turn then, and such a capture goes first next sleep. The
          // stop counts on the thought as any hard stop does — a stall only
          // past the floor (093), and this one is stalled already.
          out(`  extraction has only stalled thought(s) in hand, and ${newerWork(pools.extract)} newer thought(s) wait behind — extraction restarts, the stalled thought(s) after them`);
          if (await setAside()) return stopped();
          behindPolls = 0;
          restartedAt = Date.now();
          // The release keeps the stalled thought's date, this sleep's forward
          // one, so the newer work is claimed first; the move covers one dated
          // before it — a lease another process left, reclaimed with its old
          // date — and a move that fails ends the restarts, as such a thought
          // would be claimed first again (review pass 1).
          reorders = await stoppedLast();
          if (stopping) return stopped();
          start("extract");
        } else if (!FOLLOW && pools.consolidate && drained(pools.extract) && drained(pools.consolidate)) {
          out("  both pools drained — the sleep ends");
          await stopPasses(false);
          return "done";
        }
      }
      await sleepUnless(POLL * 1000, wake);
    }
  };

  /** A follower found outside, awake or asleep: the start's refusal, now, the row ended on a failure. */
  const refuseOutside = async (): Promise<number> => {
    err(outsideLine(foreign, false));
    await endRow("failed", malformed ?? undefined);
    return 2;
  };

  try {
    /** Refusals in a row, reset by a sleep that ends without one: the next is tried on SMD-2599's outage schedule. */
    let refusals = 0;
    for (;;) {
      const since = await awaitQuiet();
      if (foreign.length && !stopping) return refuseOutside();
      // A stop during the last read: no pass is started for it.
      if (since === null || stopping) break;
      // The row says when this sleep began, and once it is over when it ended,
      // on the database's clock (preflight's `sleep` row, SMD-2678).
      stamper.slept?.({ from: since.toISOString(), to: null });
      const r = await stamper.during(asleep(since));
      stamper.slept?.({ from: since.toISOString(), to: sleptUntil.toISOString() });
      // A stop that landed while the follower was found wins, as it does awake (review pass 2).
      if (r === "outside" && !stopping) return refuseOutside();
      if (r === "outside") {
        await endRow("stopped", malformed ?? undefined);
        return FOLLOW && !hardStopped ? 0 : 130;
      }
      if (r === "stopped") {
        await endRow("stopped", malformed ?? undefined);
        return FOLLOW && !hardStopped ? 0 : 130;
      }
      if (typeof r === "object") {
        // Every sleep starts its passes afresh, so each meets its start's
        // refusals again. One at the start (2 before onPass: the probe, the
        // key) by a pass that got past its start in an earlier sleep is one a
        // restart could meet as well — a model re-pulled, a 402 cleared — and
        // under --follow it is retried, the row failed meanwhile, rather than
        // ending a scheduler nothing restarts. A pass refusing at its first
        // start, or mid-pass (the provider refusing the request itself, a key
        // refused on a real call), is the configuration's, as for a follower;
        // any other code is no refusal: each ends the run (review pass 3).
        // A refusal the pass names as one no retry mends — the worker key
        // revoked, the extraction key another run switched, the tables, the
        // egress policy — ends it too, where it was retried until a restart:
        // the environment is read once, and the registry does not unrevoke
        // (SMD-2752).
        const permanent = r.refused !== undefined && PERMANENT_REFUSALS.has(r.refused);
        if (FOLLOW && r.code === 2 && !r.started && permanent) err(refusedLine(r.pass, r.refused, "no retry mends that, so the scheduler ends"));
        // One of the kinds a retry can mend, at a pass's first start in this
        // process: the configuration's, said as such (review pass 1 of PR 3 — the
        // log had only the pass's own lines).
        else if (FOLLOW && r.code === 2 && !r.started && r.refused && !begun.has(r.pass)) err(refusedLine(r.pass, r.refused, "it had not got through its start in this process, so the scheduler ends"));
        if (!FOLLOW || r.code !== 2 || r.started || permanent || !begun.has(r.pass)) {
          // A start refusal that ends it is said on the row by its kind, so
          // preflight gives its remedy, not "start it again" (SMD-2752).
          if (r.code === 2 && !r.started && r.refused) stamper.refused?.(r.refused);
          await endRow("failed", malformed ?? undefined);
          return r.code;
        }
        words[r.pass] = "failed";
        await stamper.stamp("failed", malformed ?? undefined);
        const waitMs = outageWait(refusals++);
        err(`  ${r.pass} refused at its start, which it passed earlier in this process, so the next sleep tries it again in ${waitMs / 1000} s; heartbeat:sleep reads failed meanwhile`);
        // Re-stamped through the wait, at most a minute apart: a wait of up to
        // 5 min would otherwise read stale, and preflight would ask for a
        // second scheduler beside this one (review pass 2).
        for (let left = waitMs; left > 0 && !stopping; left -= everyMs) {
          await sleepUnless(Math.min(everyMs, left), onStop.signal);
          if (!stopping) {
            await sayHeld();
            await stamper.alive("failed", malformed ?? undefined);
          }
        }
        continue;
      }
      refusals = 0;
      // A sleep none of whose passes stamped (each waited at its start for the
      // provider until the wake) says nothing of how they went: the row keeps
      // its last word — a retried refusal's failed included — rather than read
      // ok (SMD-2752 PR 3, review pass 3).
      if (Object.keys(words).length) await stamper.stamp(sleepOutcome(), malformed ?? undefined);
      else await stamper.alive();
      if (!FOLLOW) return r === "done" ? 0 : 1;
    }
    await endRow("stopped", malformed ?? undefined);
    return FOLLOW && !hardStopped ? 0 : 130;
  } catch (e) {
    await stopPasses(true).catch(() => {});
    // Directly: the database may be what threw, and the held read would wait
    // out its connect timeout before the end did again (review pass 4).
    await stamper.end("failed", malformed ?? undefined);
    throw e;
  } finally {
    finished = true;
    opts.signal?.removeEventListener("abort", abort);
  }
}

if (import.meta.main) {
  const cli = commandLine("sleep.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  const quiet = cli.int("quiet", { absent: DEFAULT_QUIET_S, min: 1, max: 86_400 });
  const poll = cli.int("poll", { absent: DEFAULT_POLL_S, min: 1, max: MAX_POLL_S });
  const workers = cli.int("workers", { absent: 1, min: 1, max: MAX_WORKERS });
  const sql = openSql(url, { max: 2 });
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, quiet, poll, workers,
      follow: cli.has("follow"),
      dryRun: cli.has("dry-run"),
      onPass: (stop) => { uninstall = stopOnSignals(stop); },
    }).finally(() => uninstall());
  });
}
