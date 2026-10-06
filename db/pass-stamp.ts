/**
 * pass-stamp.ts — a long-running worker's heartbeat: one ob1_config row per
 * worker and job, stamped at the end of every pass whether or not it found
 * work, so preflight and the keyed /health can tell a worker that is alive
 * from one that stopped (SMD-2261).
 *
 * Why. board-sync was down for four days (2026-09-27 to 10-01) and nothing
 * noticed: its container had gone, and preflight's `tier` row printed the
 * last ingest as passing. The board-sync watermark (PR 1) cannot be the alarm
 * — it stops moving on a quiet board too — so liveness needs a signal every
 * pass writes. SMD-2424's extraction and consolidation followers can stop the
 * same way.
 *
 * The row. Key `heartbeat:<worker>[:<job>]` — `heartbeat:board-sync`,
 * `heartbeat:extract:qwen2.5:7b@p2`, `heartbeat:consolidate:qwen2.5:7b@p3` —
 * and a JSON value: the version, `every_s` (the longest the worker lets pass
 * between two stamps), `running` (a pass is under way), the last pass's
 * `outcome` (ok, failed, or stopped — PassOutcome below), `passes` this process has
 * finished, and for extraction the last judged block's malformed answers
 * (SMD-2266's alarm, which a follower otherwise says only on stderr). The time
 * is the row's updated_at — now() on the database, so a worker's clock is not
 * read. ob1_config is key/value, so no migration: the `worker` grant group
 * already holds INSERT and UPDATE on it (db/config.mjs ROLE_GRANTS), and a
 * role without them is told once and the pass goes on — a heartbeat is
 * reporting, never a reason to stop the work.
 *
 * When. At the end of every pass, and on a timer while a pass runs, every
 * `every_s`: a follower's first pass over a backlog can run for an hour, far
 * past three of its 15-second polls. The timer says the process is alive, as
 * lease renewal does (lease.ts); a model call hung inside a live process is
 * not what it catches. Only the long-running modes stamp — sync-linear.ts
 * --loop and the --follow of extract-entities.ts and consolidate.ts — so a
 * one-shot run never leaves a row that goes stale behind it.
 *
 * "Heartbeat" in lease.ts is the lease's renewal; this is the worker's own, so
 * the code calls it a pass stamp and only the key keeps the ticket's word.
 */

import type { SQL } from "bun";
import { MAX_TIMER_MS } from "./lease.ts";

/** The workers that stamp, as the key and preflight's row name them. */
export const STAMPING_WORKERS = ["board-sync", "extract", "consolidate"] as const;
export type StampingWorker = (typeof STAMPING_WORKERS)[number];

/** The shortest gap a worker promises between stamps: a 15-second follower stamps every pass, and is judged against a minute. */
export const MIN_STAMP_EVERY_S = 60;
/** The longest a row records: what a timer holds in seconds, and what the reader takes (brain-info.ts). */
export const MAX_STAMP_EVERY_S = Math.floor(MAX_TIMER_MS / 1000);

/**
 * How a pass ended. `ok`: it ran — whatever its rows came to, a document the
 * model cannot read included. `failed`: a worker of the pass stopped because the
 * provider kept failing after its pauses (the claim workers' "provider still
 * failing"), board-sync's pass reported errors, or a pass threw. `stopped`: the
 * worker ended cleanly — a signal, a follower's --limit. A pass with no work
 * keeps the last word (the engines say so). Counting rows done against rows
 * failed was the first rule and did not hold: consolidation finishes a thought
 * with no candidates without calling the model, so a pass read `ok` with its
 * judge down (review pass 2).
 */
export type PassOutcome = "ok" | "failed" | "stopped";

/** The last judged block's answers and malformed ones, and whether they passed SMD-2266's alarm. */
export type MalformedBlock = { answers: number; bad: number; alarm: boolean };

export interface PassStamper {
  /** The row's key. */
  key: string;
  /** Stamp a finished pass. Never rejects. */
  stamp(outcome: Exclude<PassOutcome, "stopped">, malformed?: MalformedBlock | null): Promise<void>;
  /**
   * Stamp the worker's end — `stopped`, or `failed` when the provider refused
   * the request or a pass threw — as `ended`, so the row reads a gone process
   * as one, not as alive with a failed pass (review pass 2). No pass is counted.
   */
  end(outcome: "stopped" | "failed", malformed?: MalformedBlock | null): Promise<void>;
  /** Run a pass with the row re-stamped as running every `every_s` until it settles. */
  during<T>(pass: Promise<T>): Promise<T>;
}

/**
 * The key for a worker and its job. A job already named for its worker
 * (extract:…, consolidate:…) is not prefixed twice; one that is not (a custom
 * --job) is, so every key names its worker first. The job itself goes in the
 * value, so the restart preflight names works the same pool (review pass 1).
 * One row per job, not per process: two followers of one job share it, the
 * last to stamp written.
 */
export function stampKey(worker: StampingWorker, job?: string): string {
  if (job === undefined) return `heartbeat:${worker}`;
  return `heartbeat:${job.startsWith(`${worker}:`) ? job : `${worker}:${job}`}`;
}

/**
 * A stamper for one worker. `intervalS` is the worker's own (its poll, or
 * board-sync's pass interval); the row records max(interval, a minute).
 * `onError` hears the first failed write, and the first after one succeeds —
 * not every pass of a role that cannot write.
 */
export function passStamper(opts: {
  sql: SQL;
  worker: StampingWorker;
  job?: string;
  intervalS: number;
  onError?: (e: Error) => void;
  /** The floor under the interval, MIN_STAMP_EVERY_S unless a test drives the timer faster. */
  minEveryS?: number;
}): PassStamper {
  const key = stampKey(opts.worker, opts.job);
  const everyS = Math.min(MAX_STAMP_EVERY_S, Math.max(opts.minEveryS ?? MIN_STAMP_EVERY_S, Math.ceil(opts.intervalS)));
  let passes = 0;
  let outcome: PassOutcome | null = null;
  let ended = false;
  let malformed: MalformedBlock | null = null;
  let failing = false;
  // Writes go one after another, so a timer's "running" stamp in flight when
  // the pass ends cannot land after the pass's own and undo it.
  let queue: Promise<void> = Promise.resolve();
  // A stamp with no judged block of its own keeps the row's: a follower
  // restarted on the same broken model would otherwise clear its alarm with
  // its first stamp (review pass 1). Its own block, once judged, replaces it.
  // Only a block of the shape this module writes is kept — another would make
  // the reader refuse the whole row, hiding a live worker (review pass 2). The
  // inner CASE reads the old value as JSON only once it is known to be.
  const send = async (running: boolean) => {
    const value = JSON.stringify({ v: 1, ...(opts.job === undefined ? {} : { job: opts.job }), every_s: everyS, running, outcome, ...(ended ? { ended } : {}), passes, ...(malformed ? { malformed } : {}) });
    try {
      await opts.sql`INSERT INTO ob1_config (key, value) VALUES (${key}, ${value})
                     ON CONFLICT (key) DO UPDATE SET
                       value = CASE WHEN NOT (EXCLUDED.value::jsonb ? 'malformed') AND pg_input_is_valid(ob1_config.value, 'jsonb')
                                    THEN CASE WHEN jsonb_typeof(ob1_config.value::jsonb -> 'malformed' -> 'answers') = 'number'
                                                   AND jsonb_typeof(ob1_config.value::jsonb -> 'malformed' -> 'bad') = 'number'
                                                   AND jsonb_typeof(ob1_config.value::jsonb -> 'malformed' -> 'alarm') = 'boolean'
                                              THEN (EXCLUDED.value::jsonb || jsonb_build_object('malformed', ob1_config.value::jsonb -> 'malformed'))::text
                                              ELSE EXCLUDED.value END
                                    ELSE EXCLUDED.value END,
                       updated_at = now()`;
      failing = false;
    } catch (e) {
      // A reporter that throws (a Writer on a closed stream) must not leave
      // the queue rejected for every later stamp (review pass 1).
      if (!failing) try { opts.onError?.(e as Error); } catch { /* reporting only */ }
      failing = true;
    }
  };
  const write = (running: boolean) => (queue = queue.then(() => send(running)));
  return {
    key,
    async stamp(o, m) {
      outcome = o;
      passes++;
      if (m !== undefined) malformed = m;
      await write(false);
    },
    async end(o, m) {
      outcome = o;
      ended = true;
      if (m !== undefined) malformed = m;
      await write(false);
    },
    async during(pass) {
      // Stamped as it starts, so a restarted worker's first long pass is not
      // read as the stopped one's stale row until the timer's first tick.
      void write(true);
      // Unref'd, as lease.ts's beat is: the timer never holds the process open.
      const timer = setInterval(() => void write(true), Math.min(everyS * 1000, MAX_TIMER_MS));
      timer.unref?.();
      try {
        return await pass;
      } finally {
        clearInterval(timer);
      }
    },
  };
}
