#!/usr/bin/env bun
/**
 * sleep.ts — run the background passes while the brain is quiet, and hand the
 * model and the database back on the first live call: the sleep scheduler,
 * "dolphin sleep" (SMD-1794).
 *
 *   bun db/sleep.ts --url postgres://… --follow     # sleep whenever the brain is quiet, for ever
 *   bun db/sleep.ts --url …                         # wait for quiet, sleep once — until the passes are done or a call wakes it — then exit
 *   bun db/sleep.ts --url … --dry-run               # the idle reading and each pass's pool; writes nothing
 *   await run({ url, follow: true, signal })         # in-process: import { run } from "./sleep.ts" (SMD-2304's engine shape)
 *   --quiet SECONDS (300)   --poll SECONDS (5)   --workers N (1, for each pass)
 *   exits 0 done, or --follow stopped · 1 woken with work left (one sleep) · 2 usage, configuration or a pass's refusal · 130 a signal before the sleep ended (a second, at once)
 *
 * ── Quiet ───────────────────────────────────────────────────────────────────
 * The brain is awake while it is used: a read the server logged (query_log,
 * migration 034 — written only under OB1_QUERY_LOG=on) or a write the audit
 * recorded (thought_audit, 008) whose actor_kind is not `ingested`. Sync
 * writes — board-sync's, the kind 'ingested' — are background work, as the
 * passes are, and do not wake it. The brain falls asleep after --quiet seconds
 * with neither, and wakes on the first. Every comparison is on the database's
 * clock, now(). Measured on the stable brain over 14 days (2026-09-23 to
 * 10-07): 3,379 live events, the median gap 0.3 s; at 300 s it slept 222
 * times, 93% of the time, a median sleep of 16.6 min (p10 2.4); at 60 s, 98%
 * and 12.6 min; at 900 s, 84% and 25.5 min. Counting board-sync's writes as
 * live halves the median sleep at 300 s (6.5 min). The rule from the schema
 * gave the same numbers as a hand-kept list of background actors.
 *
 * The passes it runs write no thought_audit row (extraction writes the entity
 * tables; consolidation writes proposals) and call no server, so its own work
 * never wakes it. Only the owner can read query_log — no grant group holds
 * SELECT on it — so a role that cannot is told once, and then only writes
 * wake the brain. A query log that is off says nothing either way; --dry-run
 * prints how old its newest row is.
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
 * provider outage (SMD-2599), where a one-shot run fails the thought in hand.
 * Without --follow, a sleep that drains both pools stops the followers and
 * exits 0.
 *
 * ── Waking ──────────────────────────────────────────────────────────────────
 * Every --poll seconds while asleep the logs are read for a live event since
 * the sleep began — and up to 30 s before it, within the quiet just read: an
 * audit row is dated at its transaction's start, so a capture begun before
 * the sleep and committed after it is dated before it. On one, both passes
 * are hard-stopped (the pass's signal, then its PassStop): every lease
 * returned, the model call in hand aborted — extract's since this ticket's
 * first cut, consolidate's since SMD-2304 — and the thoughts in hand
 * abandoned to the next sleep. Waking costs up to --poll seconds of a pass
 * beside the live call, and the calls in flight thrown away. Awake, it reads
 * again when the brain could first fall asleep — the newest live event's age
 * plus --quiet — at most a minute apart.
 *
 * ── Heartbeat ───────────────────────────────────────────────────────────────
 * `heartbeat:sleep` in ob1_config (db/pass-stamp.ts, SMD-2261): running while
 * asleep, re-stamped at least every minute awake or asleep, a pass counted
 * per sleep, and its outcome `failed` while a pass's last word was (a
 * provider still failing). The passes stamp through it, not their own rows,
 * so a wake does not end a follower's row for preflight to warn about.
 * Only --follow stamps: one sleep leaves no row to go stale, as a one-shot
 * pass does not. Followers run outside sleep (the workers profile) do not
 * yield: --dry-run and the start name any whose heartbeat is fresh.
 *
 * ── Not here (SMD-1794's later cuts) ────────────────────────────────────────
 * A budget per pass (statement_timeout, work_mem) and per sleep (wall clock);
 * the re-derive pass (rebuild_derived, SMD-1732); the compose service and
 * preflight's row. The frozen-belief scan, decay relabelling and an HNSW heal
 * are their own tickets' passes (SMD-1722, SMD-1736, SMD-1632), as is the
 * awake latency under a sleep at 1M and 10M rows (SMD-1500's harness).
 */

import type { SQL } from "bun";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractionKey } from "../server-portable/entities.ts";
import { consolidateKey } from "../server-portable/consolidate.ts";
import { run as runExtract } from "./extract-entities.ts";
import { run as runConsolidate } from "./consolidate.ts";
import { databaseUnavailable, waitOut } from "./worker-bootstrap.ts";
import { MAX_WORKERS, sleepUnless, stopOnSignals, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { MIN_STAMP_EVERY_S, passStamper, type MalformedBlock, type PassOutcome, type PassStamper } from "./pass-stamp.ts";
import { commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

const FLAGS = { url: "one", quiet: "one", poll: "one", workers: "one", follow: "none", "dry-run": "none" } as const;
const HINTS = { url: "<postgres://…>", quiet: "<SECONDS>", poll: "<SECONDS>", workers: "<N>" };

/** The quiet before a sleep, measured on the stable brain (the header): 93% of the time asleep, a median sleep of 16.6 min. */
export const DEFAULT_QUIET_S = 300;
/** How often the logs are read while asleep: the most a pass runs beside a live call. */
export const DEFAULT_POLL_S = 5;
/** The followers' own poll for new work, their bare --follow's. */
export const PASS_FOLLOW_S = 15;
/** How far before a sleep began its wake reads, for a write committed after it in a transaction begun before (asleep()). */
export const WAKE_SLACK_S = 30;

/** The two passes, in their order. */
export const PASSES = ["extract", "consolidate"] as const;
export type PassName = (typeof PASSES)[number];

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
export type Pool = { pending: number; claimed: number; failed: number; unpooled: number };
/** Nothing for the pass to do: no row pending or in flight, and nothing to add. A failed row is the operator's. */
export const drained = (p: Pool): boolean => p.pending + p.claimed + p.unpooled === 0;

/**
 * A pass's pool, read as its own --status reads it: extraction's universe is
 * every thought (enqueue_thoughts adds those with no row under the key);
 * consolidation's is migration 029's consolidation_pool.
 */
export async function poolOf(sql: SQL, pass: PassName, job: string): Promise<Pool> {
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
export async function newestLive(sql: SQL, after: Date | number, readsLog: boolean): Promise<{ now: Date; read: Date | null; write: Date | null }> {
  const since = typeof after === "number" ? sql`now() - make_interval(secs => ${after})` : sql`${after}::timestamptz`;
  const read = readsLog ? sql`(SELECT max(logged_at) FROM query_log WHERE logged_at > ${since})` : sql`NULL::timestamptz`;
  const [r] = await sql`
    SELECT now() AS now, ${read} AS read,
           (SELECT max(created_at) FROM thought_audit WHERE created_at > ${since} AND actor_kind IS DISTINCT FROM 'ingested') AS write`;
  return { now: new Date(r.now), read: r.read ? new Date(r.read) : null, write: r.write ? new Date(r.write) : null };
}

const newer = (a: Date | null, b: Date | null): Date | null => (a && b ? (a > b ? a : b) : a ?? b);

/** Whether this role can read query_log: only its owner can (no grant group holds SELECT, db/config.mjs). */
async function readsQueryLog(sql: SQL): Promise<boolean> {
  try {
    await sql`SELECT 1 FROM query_log LIMIT 0`;
    return true;
  } catch (e) {
    const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
    if (code === "42501" || code === "42P01") return false;
    throw e;
  }
}

/** The claim followers stamping outside this scheduler, fresh: they do not yield to a live call. */
async function followersOutside(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT key, value, extract(epoch FROM now() - updated_at)::float8 AS age_s FROM ob1_config
     WHERE key LIKE 'heartbeat:extract%' OR key LIKE 'heartbeat:consolidate%' ORDER BY key LIMIT 20`) as { key: string; value: string; age_s: number }[];
  return rows.filter((r) => {
    try {
      const v = JSON.parse(r.value) as { every_s?: number; ended?: boolean };
      return !v.ended && typeof v.every_s === "number" && Number(r.age_s) < v.every_s * 3;
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
  const poll = read("--poll", opts.poll, DEFAULT_POLL_S, { min: 1, max: 3_600 });
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
type Running = { name: PassName; done: Promise<number>; settled: boolean; code: number | null; stop: PassStop | null; abort: AbortController };

async function sleepWith(sql: SQL, url: string, opts: SleepOptions, n: { quiet: number; poll: number; workers: number }, out: Writer["out"], err: Writer["err"]): Promise<number> {
  const { quiet: QUIET, poll: POLL, workers: WORKERS } = n;
  const FOLLOW = opts.follow === true;
  const env = opts.env ?? process.env;
  const cfg = resolveEmbedConfig(env as EmbedEnv);
  const JOBS: Record<PassName, string> = { extract: extractionKey(cfg.metadataModel), consolidate: consolidateKey(cfg.judgeModel) };

  const readsLog = await readsQueryLog(sql);
  out(`  quiet:  ${QUIET} s with no read logged in query_log and no write in thought_audit but sync's (actor_kind 'ingested')`);
  if (!readsLog) err("  query_log: this role cannot read it (only its owner can) — only writes wake the brain");
  const outside = await followersOutside(sql);
  if (outside.length) err(`  followers running outside sleep, which do not yield to a live call: ${outside.join(", ")} — stop them (the workers profile) to let sleep run the passes`);

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
  // stops it before it claims.
  const softStop = (p: Running): void => {
    if (!p.settled) p.abort.abort();
  };
  const hardStop = async (p: Running): Promise<void> => {
    if (p.settled) return;
    p.abort.abort();
    await p.stop?.();
  };
  const stop: PassStop = () => {
    if (finished) return null;
    if (stopping) {
      hardStopped = true;
      err("\n  second signal — the passes stop now, their leases returned");
      return Promise.all(running.map(hardStop));
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
  /** What a pass stamps goes to the sleep's row: its outcome, never a pass of the sleep's, nor an end. */
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
    const p: Running = { name, done: Promise.resolve(0), settled: false, code: null, stop: null, abort };
    const common = {
      url, env, workers: WORKERS, follow: PASS_FOLLOW_S, signal: abort.signal, stamper: through(name),
      onPass: (s: PassStop) => { p.stop = s; },
      writer: { out: (l: string) => out(tag(l)), err: (l: string) => err(tag(l)) },
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
   * consolidation beside it. "woken" on a live event, "done" when one sleep
   * (no --follow) drained both, "stopped" on a stop, or the code of a pass
   * that ended by itself (a refusal).
   */
  const asleep = async (since: Date): Promise<"woken" | "done" | "stopped" | { code: number }> => {
    for (const k of PASSES) delete words[k];
    passEnded = new AbortController();
    const wake = AbortSignal.any([onStop.signal, passEnded.signal]);
    out(`  asleep: no live call for ${QUIET} s — extracting${FOLLOW ? "" : ", then consolidating, until both pools are drained"}`);
    start("extract");
    let consolidating = false;
    // An audit row carries its transaction's start: a capture begun before the
    // sleep and committed after it was not visible when the brain fell asleep,
    // and is dated before. The wake reads that far back — within the quiet
    // just read, where nothing visible then can stand.
    const from = new Date(since.getTime() - Math.min(QUIET, WAKE_SLACK_S) * 1000);
    for (;;) {
      if (stopping) return "stopped";
      const live = await reading(() => newestLive(sql, from, readsLog));
      if (live === null) return "stopped";
      const woke = newer(live.read, live.write);
      if (woke !== null) {
        out(`  awake: a live ${live.read && woke === live.read ? "read" : "write"} at ${woke.toISOString()} — the passes stop now, their leases returned`);
        await stopPasses(true);
        return "woken";
      }
      const ended = running.find((p) => p.settled);
      if (ended) {
        err(`  ${ended.name} ended by itself (exit ${ended.code}) — the sleep stops`);
        await stopPasses(true);
        return { code: ended.code === 0 || ended.code === null ? 1 : ended.code };
      }
      // The pools decide two things only — when consolidation joins, and when
      // one sleep is done — so a --follow consolidating reads neither: the
      // extraction pool's count is a scan of every thought.
      if (!consolidating || !FOLLOW) {
        const pools = await reading(async () => ({ extract: await poolOf(sql, "extract", JOBS.extract), consolidate: consolidating ? await poolOf(sql, "consolidate", JOBS.consolidate) : null }));
        if (pools === null) return "stopped";
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
    for (;;) {
      const since = await awaitQuiet();
      if (since === null) break;
      const r = await stamper.during(asleep(since));
      if (r === "stopped") {
        await stopPasses(hardStopped);
        await stamper.end("stopped", malformed ?? undefined);
        return FOLLOW && !hardStopped ? 0 : 130;
      }
      if (typeof r === "object") {
        await stamper.end("failed", malformed ?? undefined);
        return r.code;
      }
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
  const poll = cli.int("poll", { absent: DEFAULT_POLL_S, min: 1, max: 3_600 });
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
