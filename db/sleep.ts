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
 *   exits 0 done, or --follow stopped by one signal · 1 one sleep woken before both pools drained, a pass that ended by itself with 0, or an uncaught error · 2 usage, configuration, or a pass's refusal (under --follow, all but a start refusal by a pass that got past its start earlier, which is retried — "Refusals" below) · 130 a signal before one sleep ended, or a second signal (at once)
 *
 * ── Quiet ───────────────────────────────────────────────────────────────────
 * The brain is awake while it is used: a read the server logged (query_log,
 * migration 034) or a write the audit recorded (thought_audit, 008) through a
 * key whose kind is not `ingested` (set_agent_kind, 046). It falls asleep
 * after --quiet seconds with neither, and wakes on the first. Every
 * comparison is on the database's clock, now().
 *  - Reads wake it only under the server's OB1_QUERY_LOG=on, off by default:
 *    with it off nothing logs a search. Nothing in the database says which,
 *    so a log with no row in 24 h is said once at the start. Only the owner
 *    can read query_log (no grant group holds SELECT on it): under a --grant
 *    role it is told once, and then only writes wake the brain.
 *  - "Background" is the key's kind, not the work: board-sync's key is
 *    classified `ingested` on the stable brain, so its sync writes do not
 *    wake it; an unclassified key's do — reembed.ts's, ingest-records.ts's, a
 *    migration's backfill — until set_agent_kind(<name>, 'ingested') says
 *    they are background.
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
 * earlier UTC date. A failed row stays failed — the operator's --retry-failed.
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
 * sleep's first, and the pool behind it would never move. That thought itself
 * is still never finished while every sleep is shorter, and consolidation
 * does not join while it is pending (SMD-2694). Waking costs up to
 * --poll seconds of a pass beside the live call, and the calls in flight
 * thrown away. The first live call is not spared: it is recorded after the
 * model work it does, so on a one-slot model it can queue behind the call in
 * hand. Awake, it reads again when the brain could first fall asleep —
 * --quiet seconds after the newest live event — at most a minute apart.
 *
 * ── Refusals ────────────────────────────────────────────────────────────────
 * Every sleep starts its passes afresh, so each meets its start's refusals
 * again (the model not served, the key refused). One rule, on a fact the
 * scheduler has — whether the pass got past its start (the engines' onPass):
 *  - a refusal at the start of a pass that got past its start earlier in
 *    this process is retried under --follow on SMD-2599's outage schedule,
 *    heartbeat:sleep failed and re-stamped through the wait, until a pass of
 *    a later sleep stamps. What a retry can mend: a model re-pulled, a 402
 *    cleared by topping up credit, a gateway's passing 401/403/404. What it
 *    cannot, retried until the scheduler is restarted: a worker key revoked
 *    (the environment is read once; a revoked key stays so), another
 *    process's --switch-key (this process's job key is fixed);
 *  - a refusal at a pass's first start, or mid-pass (the provider refusing
 *    the request itself, a key refused on a real call), is the
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
 * scheduler stops, a second signal included. A pass waiting at its start for
 * a provider that does not answer stamps nothing: the row reads running with
 * the last word until the wait ends. The passes stamp through it, not their
 * own rows, so a wake does not end a follower's row for preflight to warn
 * about, and preflight's consolidate pass row reads it as the scheduler at
 * work. Only --follow stamps: one sleep leaves no row to go stale, as a
 * one-shot pass does not. Followers run outside sleep (the workers profile)
 * do not yield: --dry-run and the start name any whose heartbeat is fresh,
 * with how to stop them and retire their rows.
 *
 * ── Not here ────────────────────────────────────────────────────────────────
 * The compose service, preflight's own `sleep` row, quieter banners and
 * start-time configuration checks (SMD-2678); a budget per pass
 * (statement_timeout, work_mem) and per sleep (a wall clock), and the
 * re-derive pass (rebuild_derived, SMD-1732) (SMD-2679). The frozen-belief
 * scan, decay relabelling and an HNSW heal are their own tickets' passes
 * (SMD-1722, SMD-1736, SMD-1632), as is the awake latency under a sleep at 1M
 * and 10M rows (SMD-1500's harness).
 */

import type { SQL } from "bun";
import { hostname } from "node:os";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractionKey } from "../server-portable/entities.ts";
import { consolidateKey } from "../server-portable/consolidate.ts";
import { STALE_AFTER_INTERVALS } from "../server-portable/brain-info.ts";
import { run as runExtract } from "./extract-entities.ts";
import { run as runConsolidate } from "./consolidate.ts";
import { databaseUnavailable, outageWait, waitOut } from "./worker-bootstrap.ts";
import { MAX_WORKERS, sleepUnless, stopOnSignals, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { MIN_STAMP_EVERY_S, passStamper, type MalformedBlock, type PassOutcome, type PassStamper } from "./pass-stamp.ts";
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
}

/** A pass's pool: its claim rows by status, and the thoughts a pass would add to it. */
type Pool = { pending: number; claimed: number; failed: number; unpooled: number };
/** Nothing for the pass to do: no row pending or in flight, and nothing to add. A failed row is the operator's. */
const drained = (p: Pool): boolean => p.pending + p.claimed + p.unpooled === 0;

/**
 * A pass's pool, read as its own --status reads it: extraction's universe is
 * every thought (enqueue_thoughts adds those with no row under the key);
 * consolidation's is migration 029's consolidation_pool.
 */
async function poolOf(sql: SQL, pass: PassName, job: string): Promise<Pool> {
  const rows = (await sql`SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${job} GROUP BY status`) as { status: string; c: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const [{ n }] = pass === "extract"
    ? await sql`SELECT count(*)::int AS n FROM thoughts t WHERE NOT EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${job})`
    : await sql`SELECT count(*)::int AS n FROM consolidation_pool(${job})`;
  return { pending: by.pending ?? 0, claimed: by.claimed ?? 0, failed: by.failed ?? 0, unpooled: Number(n) };
}

/**
 * The newest live event after `after` — a timestamp, or a number of seconds
 * before now() — and the database's now(). A read is a query_log row (when
 * `readsLog`); a write is a thought_audit row whose actor_kind is not
 * 'ingested' (NULL counts as live). Bounded below, so a brain whose newest
 * audit rows are all sync writes is not read back to its last live one.
 */
async function newestLive(sql: SQL, after: Date | number, readsLog: boolean): Promise<{ now: Date; read: Date | null; write: Date | null }> {
  const since = typeof after === "number" ? sql`now() - make_interval(secs => ${after})` : sql`${after}::timestamptz`;
  const read = readsLog ? sql`(SELECT max(logged_at) FROM query_log WHERE logged_at > ${since})` : sql`NULL::timestamptz`;
  const [r] = await sql`
    SELECT now() AS now, ${read} AS read,
           (SELECT max(created_at) FROM thought_audit WHERE created_at > ${since} AND actor_kind IS DISTINCT FROM 'ingested') AS write`;
  return { now: new Date(r.now), read: r.read ? new Date(r.read) : null, write: r.write ? new Date(r.write) : null };
}

const newer = (a: Date | null, b: Date | null): Date | null => (a && b ? (a > b ? a : b) : a ?? b);

/** Whether this role can read query_log: only its owner can (no grant group holds SELECT, db/config.mjs). */
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

/** The claim followers stamping outside this scheduler, fresh as brain-info.ts reads a heartbeat: they do not yield to a live call. */
async function followersOutside(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT key, value, extract(epoch FROM now() - updated_at)::float8 AS age_s FROM ob1_config
     WHERE key LIKE 'heartbeat:extract%' OR key LIKE 'heartbeat:consolidate%' ORDER BY key LIMIT 20`) as { key: string; value: string; age_s: number }[];
  return rows.filter((r) => {
    try {
      const v = JSON.parse(r.value) as { every_s?: number; ended?: boolean };
      return !v.ended && typeof v.every_s === "number" && Number(r.age_s) <= v.every_s * STALE_AFTER_INTERVALS;
    } catch { return false; }
  }).map((r) => r.key);
}

const ago = (now: Date, t: Date | null): string => (t ? `${Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000))} s ago` : "none");

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
type Running = { name: PassName; done: Promise<number>; settled: boolean; code: number | null; stop: PassStop | null; abort: AbortController; hushed: boolean };

async function sleepWith(sql: SQL, url: string, opts: SleepOptions, n: { quiet: number; poll: number; workers: number }, out: Writer["out"], err: Writer["err"]): Promise<number> {
  const { quiet: QUIET, poll: POLL, workers: WORKERS } = n;
  const FOLLOW = opts.follow === true;
  const env = opts.env ?? process.env;
  const cfg = resolveEmbedConfig(env as EmbedEnv);
  const JOBS: Record<PassName, string> = { extract: extractionKey(cfg.metadataModel), consolidate: consolidateKey(cfg.judgeModel) };

  const logState = await readsQueryLog(sql);
  const readsLog = logState === "yes";
  out(`  quiet:  ${QUIET} s with no write in thought_audit but sync's (actor_kind 'ingested')${readsLog ? " and no read logged in query_log" : " — reads are not watched"}`);
  if (logState === "denied") err("  query_log: this role cannot read it (only its owner can) — only writes wake the brain; run as the owner for reads to wake it");
  else if (logState === "missing") err("  query_log: no such table (migration 034 not applied) — only writes wake the brain");
  // The log is written only under the server's OB1_QUERY_LOG=on, off by
  // default, and nothing in the database says which: a log with no recent row
  // is said once, since a search then never wakes the brain.
  else if ((await sql`SELECT EXISTS (SELECT 1 FROM query_log WHERE logged_at > now() - make_interval(secs => ${QUERY_LOG_QUIET_S})) AS recent`)[0].recent !== true) {
    err("  query_log: no row in the last 24 h — either nothing was searched, or OB1_QUERY_LOG is off on the server (its default), and then a search is not logged and does not wake the brain; only writes do");
  }
  const outside = await followersOutside(sql);
  if (outside.length) err(`  followers running outside sleep, which do not yield to a live call: ${outside.join(", ")} — the workers profile's, or a --follow run by hand. Stop them (podman compose -f deploy/compose.yaml --profile workers stop extract consolidate, and take workers out of COMPOSE_PROFILES in deploy/.env), then delete their rows (DELETE FROM ob1_config WHERE key IN (${outside.map((k) => `'${k}'`).join(", ")})) so preflight does not ask for them back`);

  if (opts.dryRun) {
    const [{ now }] = await sql`SELECT now() AS now`;
    const at = new Date(now);
    const [last] = await sql`
      SELECT ${readsLog ? sql`(SELECT max(logged_at) FROM query_log)` : sql`NULL::timestamptz`} AS read,
             (SELECT created_at FROM thought_audit WHERE actor_kind IS DISTINCT FROM 'ingested' ORDER BY created_at DESC LIMIT 1) AS write`;
    const read = last.read ? new Date(last.read) : null;
    const write = last.write ? new Date(last.write) : null;
    const newest = newer(read, write);
    const left = newest ? QUIET - (at.getTime() - newest.getTime()) / 1000 : 0;
    out(`  last read: ${readsLog ? ago(at, read) : "not readable"}; last write: ${ago(at, write)}`);
    out(left <= 0 ? "  a sleep would begin now" : `  awake: a sleep would begin in ${Math.ceil(left)} s with no live call`);
    for (const pass of PASSES) {
      const p = await poolOf(sql, pass, JOBS[pass]);
      out(`  ${pass} (${JOBS[pass]}): ${p.claimed} in flight, ${p.pending} pending, ${p.unpooled} not yet in the pool, ${p.failed} failed${drained(p) ? " — drained" : ""}`);
    }
    return 0;
  }

  // ── The heartbeat ────────────────────────────────────────────────────────
  // Only --follow stamps, as only a follower does: one sleep leaves no row to go stale.
  const stamper: PassStamper = FOLLOW
    ? passStamper({ sql, worker: "sleep", intervalS: POLL, minEveryS: opts.minStampEveryS, onError: (e) => err(`  heartbeat: could not stamp heartbeat:sleep (${e.message}) — the passes go on`) })
    : { key: "", stamp: async () => {}, end: async () => {}, during: (p) => p, alive: async () => {} };
  const everyMs = Math.max(opts.minStampEveryS ?? MIN_STAMP_EVERY_S, POLL) * 1000;
  /** Each pass's last word in this sleep, and extraction's last judged block. */
  const words: Partial<Record<PassName, PassOutcome>> = {};
  let malformed: MalformedBlock | null | undefined;
  const sleepOutcome = (): "ok" | "failed" => (Object.values(words).includes("failed") ? "failed" : "ok");
  /**
   * The passes that have got past their start in this process (onPass): the
   * provider answered their probe and the key resolved, at least once. A
   * refusal at a later start — before onPass — is then one a restart could
   * meet as well, and is retried (review pass 3, replacing passes 1 and 2's
   * "has run").
   */
  const begun = new Set<PassName>();
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
  opts.onPass?.(stop);

  /** A database read that outlasts the database going away (SMD-2599's rule): null when a stop ended the wait. */
  let saidDown = false;
  const reading = async <T>(read: () => Promise<T>): Promise<T | null> => {
    for (;;) {
      try {
        const r = await read();
        if (saidDown) { out("  the database answers again"); saidDown = false; }
        return r;
      } catch (e) {
        if (!databaseUnavailable(e)) throw e;
        if (!saidDown) { err(`  the database is not answering (${(e as Error).message}) — waiting for it`); saidDown = true; }
        if (!(await waitOut({ check: () => sql`SELECT 1`, outage: databaseUnavailable, wake: onStop.signal }))) return null;
      }
    }
  };

  /** Aborted when a pass of the current sleep settles, so its poll wakes to read why. */
  let passEnded = new AbortController();
  const start = (name: PassName): Running => {
    const abort = new AbortController();
    const tag = (line: string) => line.split("\n").map((l) => (l.trim() ? `  [${name}]${l}` : l)).join("\n");
    const p: Running = { name, done: Promise.resolve(0), settled: false, code: null, stop: null, abort, hushed: false };
    const say = (write: Writer["out"]) => (l: string) => { if (!(p.hushed && PASS_STOP_LINE.test(l))) write(tag(l)); };
    const common = {
      url, env, workers: WORKERS, follow: PASS_FOLLOW_S, signal: abort.signal, stamper: through(name),
      onPass: (s: PassStop) => { p.stop = s; begun.add(name); },
      writer: { out: say(out), err: say(err) },
    };
    const ended = passEnded;
    p.done = (name === "extract" ? runExtract(common) : runConsolidate(common)).then((code) => {
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
         AND (starts_with(worker_id, ${`extract-${hostname()}-${process.pid}-`}) OR starts_with(worker_id, ${`consolidate-${hostname()}-${process.pid}-`}))`) as { id: string; job: string }[];
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

  /** Awake: wait until the brain has been quiet --quiet seconds. The database's now() when it fell asleep, or null on a stop. */
  const awaitQuiet = async (): Promise<Date | null> => {
    let stampedAt = 0;
    while (!stopping) {
      const r = await reading(() => newestLive(sql, QUIET, readsLog));
      if (r === null) return null;
      const newest = newer(r.read, r.write);
      if (newest === null) return r.now;
      if (Date.now() - stampedAt >= everyMs) { await stamper.alive(); stampedAt = Date.now(); }
      const left = QUIET * 1000 - (r.now.getTime() - newest.getTime());
      await sleepUnless(Math.min(everyMs, Math.max(POLL * 1000, left)), onStop.signal);
    }
    return null;
  };

  /**
   * Asleep from `since`: extraction alone until its pool drains, then
   * consolidation beside it. Returns one of: "woken" on a live event; "done"
   * when one sleep (no --follow) drained both; "stopped" on a stop, the passes
   * stopped before it returns, inside the heartbeat's `during`; or, for a pass
   * that ended by itself (a refusal), its name, its code and whether it had
   * got past its start in this sleep.
   */
  const asleep = async (since: Date): Promise<"woken" | "done" | "stopped" | { pass: PassName; code: number; started: boolean }> => {
    for (const k of PASSES) delete words[k];
    passEnded = new AbortController();
    const wake = AbortSignal.any([onStop.signal, passEnded.signal]);
    const stopped = async (): Promise<"stopped"> => {
      await stopPasses(hardStopped);
      return "stopped";
    };
    out(`  asleep: no live call for ${QUIET} s — extracting${FOLLOW ? "" : ", then consolidating, until both pools are drained"}`);
    start("extract");
    let consolidating = false;
    // An audit row carries its transaction's start: a capture begun before the
    // sleep and committed after it was not visible when the brain fell asleep,
    // and is dated before. The wake reads that far back — within the quiet
    // just read, where nothing visible then can stand.
    const from = new Date(since.getTime() - Math.min(QUIET, WAKE_SLACK_S) * 1000);
    for (;;) {
      if (stopping) return stopped();
      const live = await reading(() => newestLive(sql, from, readsLog));
      if (live === null) return stopped();
      // A pass that ended by itself before the wake is read first: a refusal
      // and a live call in one poll would otherwise read as the wake alone.
      const ended = running.find((p) => p.settled);
      if (ended) {
        // A pass that threw rejects out of stopPasses, after the others stop,
        // so past it the pass returned a code; a 0 unasked is no success.
        await stopPasses(true);
        const code = ended.code || 1;
        err(`  ${ended.name} ended by itself (exit ${ended.code}) — the sleep stops`);
        return { pass: ended.name, code, started: ended.stop !== null };
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
        return "woken";
      }
      // The pools decide two things only — when consolidation joins, and when
      // one sleep is done — so a --follow consolidating reads neither: the
      // extraction pool's count is a scan of every thought.
      if (!consolidating || !FOLLOW) {
        const pools = await reading(async () => ({ extract: await poolOf(sql, "extract", JOBS.extract), consolidate: consolidating ? await poolOf(sql, "consolidate", JOBS.consolidate) : null }));
        if (pools === null) return stopped();
        if (!consolidating && drained(pools.extract)) {
          out("  extraction drained — consolidating beside it");
          start("consolidate");
          consolidating = true;
        } else if (!FOLLOW && pools.consolidate && drained(pools.extract) && drained(pools.consolidate)) {
          out("  both pools drained — the sleep ends");
          await stopPasses(false);
          return "done";
        }
      }
      await sleepUnless(POLL * 1000, wake);
    }
  };

  try {
    /** Refusals in a row, reset by a sleep that ends without one: the next is tried on SMD-2599's outage schedule. */
    let refusals = 0;
    for (;;) {
      const since = await awaitQuiet();
      // A stop during the last read: no pass is started for it.
      if (since === null || stopping) break;
      const r = await stamper.during(asleep(since));
      if (r === "stopped") {
        await stamper.end("stopped", malformed ?? undefined);
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
        if (!FOLLOW || r.code !== 2 || r.started || !begun.has(r.pass)) {
          await stamper.end("failed", malformed ?? undefined);
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
          if (!stopping) await stamper.alive("failed", malformed ?? undefined);
        }
        continue;
      }
      refusals = 0;
      await stamper.stamp(sleepOutcome(), malformed ?? undefined);
      if (!FOLLOW) return r === "done" ? 0 : 1;
    }
    await stamper.end("stopped", malformed ?? undefined);
    return FOLLOW && !hardStopped ? 0 : 130;
  } catch (e) {
    await stopPasses(true).catch(() => {});
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
