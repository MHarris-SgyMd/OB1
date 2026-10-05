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
 * `outcome` (ok, failed, or stopped by a signal), `passes` this process has
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

/** How a pass ended: it finished (`ok`), it threw or reported errors (`failed`), or a signal stopped the worker (`stopped`). */
export type PassOutcome = "ok" | "failed" | "stopped";

/** The last judged block's answers and malformed ones, and whether they passed SMD-2266's alarm. */
export type MalformedBlock = { answers: number; bad: number; alarm: boolean };

export interface PassStamper {
  /** The row's key. */
  key: string;
  /** Stamp a finished pass (or a stop). Never rejects. */
  stamp(outcome: PassOutcome, malformed?: MalformedBlock | null): Promise<void>;
  /** Run a pass with the row re-stamped as running every `every_s` until it settles. */
  during<T>(pass: Promise<T>): Promise<T>;
}

/**
 * The key for a worker and its job. A job already named for its worker
 * (extract:…, consolidate:…) is not prefixed twice; one that is not (a custom
 * --job) is, so every key names its worker first.
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
  const everyS = Math.max(opts.minEveryS ?? MIN_STAMP_EVERY_S, Math.ceil(opts.intervalS));
  let passes = 0;
  let outcome: PassOutcome | null = null;
  let malformed: MalformedBlock | null = null;
  let failing = false;
  // Writes go one after another, so a timer's "running" stamp in flight when
  // the pass ends cannot land after the pass's own and undo it.
  let queue: Promise<void> = Promise.resolve();
  const send = async (running: boolean) => {
    const value = JSON.stringify({ v: 1, every_s: everyS, running, outcome, passes, ...(malformed ? { malformed } : {}) });
    try {
      await opts.sql`INSERT INTO ob1_config (key, value) VALUES (${key}, ${value})
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      failing = false;
    } catch (e) {
      if (!failing) opts.onError?.(e as Error);
      failing = true;
    }
  };
  const write = (running: boolean) => (queue = queue.then(() => send(running)));
  return {
    key,
    async stamp(o, m) {
      outcome = o;
      if (o !== "stopped") passes++;
      if (m !== undefined) malformed = m;
      await write(false);
    },
    async during(pass) {
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
