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
 * and a JSON value: the version, the claim `job` as given, `every_s` (the
 * longest the worker lets pass between two stamps), `running` (a pass is under
 * way), the last pass's `outcome` (PassOutcome below), `ended` once the
 * worker's process is gone, and for extraction the last judged block's
 * malformed answers (SMD-2266's alarm, which a follower otherwise says only on
 * stderr), and for the sleep scheduler `slept`, its current or last sleep's
 * `from` and `to` (SleepMark), and `held`, the thoughts its wakes hold back
 * (SleepHeld, SMD-2694), and `budget`, its budget in force and the sleeps
 * stopped on it (SleepBudget, SMD-2679; `slept.budget` says which stopped); and `waitingMidPass`, the passes waiting mid-pass for a
 * provider that stopped answering — the sleep scheduler's by name, a
 * follower's its own (SMD-2905); and `restart`, on a row ended by db/supervise.ts, the compose
 * services' command, which runs the follower again on its own (SMD-3214) — written there, not
 * here. Each stamp writes the whole value: a restarted follower's first
 * stamp carries no block until it judges one. The time is the row's
 * updated_at — now() on the database, so a worker's clock is not read.
 * ob1_config is key/value, so no migration: the `worker` grant group already
 * holds INSERT and UPDATE on it (db/config.mjs ROLE_GRANTS), and a
 * role without them is told once and the pass goes on — a heartbeat is
 * reporting, never a reason to stop the work.
 *
 * When. As a pass starts, every `every_s` while it runs, and at its end; and
 * once more, `ended`, when the worker ends. A follower's first pass over a
 * backlog can run for an hour, far past three of its 15-second polls. The
 * timer says the process is alive, as lease renewal does (lease.ts); a model
 * call hung inside a live process is not what it catches. Only the
 * long-running modes stamp — sync-linear.ts --trigger (a pass at each of the coordinator's triggers, SMD-3476), the --follow of
 * extract-entities.ts, consolidate.ts and reembed.ts (SMD-2679), and sleep.ts --follow, through whose
 * row its followers stamp (SMD-1794) — so a one-shot run never leaves a row
 * that goes stale behind it.
 *
 * "Heartbeat" in lease.ts is the lease's renewal; this is the worker's own, so
 * the code calls it a pass stamp and only the key keeps the ticket's word.
 */

import type { SQL } from "bun";
import { MAX_TIMER_MS } from "./lease.ts";
import type { BudgetStop, SleepAside, SleepBudget, SleepHeld } from "../server-portable/brain-info.ts";

/** The workers that stamp, as the key and preflight's row name them. */
export const STAMPING_WORKERS = ["board-sync", "extract", "consolidate", "sleep", "reembed"] as const;
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

/**
 * The sleep scheduler's current or last sleep: when it began and, once it is
 * over, when it ended — the database's instants, ISO strings (SMD-2678) — and
 * `budget` when it stopped on its budget, with `limit`, the bound it stopped
 * at: the clock's minutes, or statement_timeout's seconds (0: the role's or
 * the database's own) (SMD-2679).
 */
export type SleepMark = { from: string; to: string | null; budget?: BudgetStop; limit?: number };

export interface PassStamper {
  /** The row's key. */
  key: string;
  /** Stamp a finished pass. Never rejects. */
  stamp(outcome: Exclude<PassOutcome, "stopped">, malformed?: MalformedBlock | null): Promise<void>;
  /**
   * Stamp the worker's end — `stopped`, or `failed` when the provider refused
   * the request or a pass threw — as `ended`, so the row reads a gone process
   * as one, not as alive with a failed pass (review pass 2).
   */
  end(outcome: "stopped" | "failed", malformed?: MalformedBlock | null): Promise<void>;
  /** Run a pass with the row re-stamped as running every `every_s` until it settles. */
  during<T>(pass: Promise<T>): Promise<T>;
  /**
   * Re-stamp the row as it stands — running if inside `during`, where stamp()
   * would say a pass ended — the outcome and block replaced when given: the
   * sleep scheduler's beat while awake, and a pass's word mid-sleep (SMD-1794).
   */
  alive(outcome?: Exclude<PassOutcome, "stopped">, malformed?: MalformedBlock | null): Promise<void>;
  /**
   * The sleep scheduler's mark of its current or last sleep, carried by the
   * row's next write (`slept` in the value): preflight's `sleep` row and keyed
   * /health show it (SMD-2678). Only the scheduler sets it.
   */
  slept?(mark: SleepMark): void;
  /**
   * The sleep scheduler's mark of the passes waiting at their start for a
   * provider that does not answer (`waiting` in the value, left out while
   * none is), carried by the row's next write: preflight's `sleep` row says
   * so, where "its passes running" was all it had (SMD-2752). Only the
   * scheduler sets it.
   */
  waiting?(passes: readonly string[]): void;
  /**
   * The sleep scheduler's mark of the passes waiting mid-pass for a provider
   * that stopped answering (`waitingMidPass` in the value, left out while none
   * is), as `waiting` is the start's: preflight's rows say the provider, not
   * "running a pass" (SMD-2905). Only the scheduler sets it; a follower's own
   * stamper writes its own name through providerWait.
   */
  waitingMidPass?(passes: readonly string[]): void;
  /**
   * Which start refusal ended the row (`refused` in the value): one of
   * worker-bootstrap.ts's StartRefusal, set before the end that writes it, so
   * preflight names the cause and its remedy rather than "start it again",
   * which would only refuse again (SMD-2752). The scheduler sets it, and since
   * SMD-3214 a follower refused at its start, through endOnRefusal.
   */
  refused?(kind: string): void;
  /**
   * A pass's word that it is waiting at its start for a provider that does
   * not answer (true), or no longer is (false): the engines say it through a
   * caller's stamper, which the scheduler's per-pass one records and stamps
   * (SMD-2752). A follower's own stamper has none — it does not exist until
   * its pass begins.
   */
  startWait?(on: boolean): Promise<void>;
  /**
   * A pass's word that it is waiting mid-pass for a provider that stopped
   * answering (true) — past its workers' pauses for a 5xx, at once for a
   * model gone missing or a call no probe answers — or no longer is (false):
   * both engines say it through the stamper they stamp with — the sleep
   * scheduler's per-pass one, which records it (extraction set to the newer
   * work while the judge waits, SMD-3008) and stamps it on the sleep's row,
   * or a follower's own, which writes `waitingMidPass` with its own name on
   * its row — so preflight says the provider, not "running a pass" (SMD-2905).
   */
  providerWait?(on: boolean): Promise<void>;
  /**
   * The thoughts extraction holds back across the scheduler's wakes (`held`
   * in the value, left out while none is), carried by the row's next write —
   * kept on its end, as a stopped scheduler's held thought is still held:
   * preflight's `sleep` row names them (SMD-2694). Only the scheduler sets it.
   */
  held?(held: SleepHeld | null): void;
  /**
   * The sleep scheduler's budget in force and the sleeps it has stopped on it
   * since its process began (`budget` in the value), carried by the row's next
   * write and kept on its end: preflight's `sleep` row says them (SMD-2679).
   * Only the scheduler sets it.
   */
  budget?(budget: SleepBudget): void;
  /**
   * The sleep scheduler waiting for a live call before its next sleep, its
   * last stopped on its budget (`resting` in the value, left out while not):
   * preflight's `sleep` row says the next begins after one only then — a
   * restarted scheduler sleeps after the quiet alone (SMD-2679, review pass 1).
   * Cleared by the row's end.
   */
  resting?(on: boolean): void;
  /**
   * The sleep scheduler's re-embed pass set aside on a model switch it will
   * not make, or down for the sleep with what set it down (`aside` in the
   * value, left out while neither is), carried by the row's next write and
   * kept on its end — a set-down's word then speaks of the last sleep, not
   * the next: preflight's `sleep` row says it, as of the row's last word
   * (SMD-2679 PR 4b). Only the scheduler sets it.
   */
  aside?(aside: SleepAside | null): void;
}

/** The longest endOnRefusal waits for its write: the refusal's exit must not wait on a database that does not answer. */
export const REFUSAL_STAMP_TIMEOUT_MS = 10_000;

/**
 * A follower's row ended on its start's refusal, the kind on it (SMD-3214):
 * the claim workers' under `--follow`, board-sync's under `--trigger`, so
 * preflight gives the kind's remedy — and, under db/supervise.ts, which keeps
 * the follower's own word, says it is held for that cause — where the row
 * said only "ended on a failure". Bounded by REFUSAL_STAMP_TIMEOUT_MS; a
 * write that fails or does not land in time leaves the row as it was, and
 * `onError` hears it.
 */
export async function endOnRefusal(opts: { sql: SQL; worker: StampingWorker; job?: string; intervalS: number; kind: string; onError?: (e: Error) => void; timeoutMs?: number }): Promise<void> {
  const st = passStamper({ sql: opts.sql, worker: opts.worker, job: opts.job, intervalS: opts.intervalS, onError: opts.onError });
  st.refused?.(opts.kind);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => { timer = setTimeout(() => { try { opts.onError?.(new Error(`no answer in ${(opts.timeoutMs ?? REFUSAL_STAMP_TIMEOUT_MS) / 1000} s`)); } catch { /* reporting only */ } resolve(); }, opts.timeoutMs ?? REFUSAL_STAMP_TIMEOUT_MS); });
  try {
    await Promise.race([st.end("failed"), late]);
  } finally {
    clearTimeout(timer);
  }
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
  /**
   * The sleep scheduler's re-embed key, on its row: preflight reads whose key
   * it is from it, not from its own environment, which a checkout may set
   * otherwise (SMD-2679 PR 4b-2, review pass 5). Only the scheduler sets it.
   */
  reembedJob?: string;
}): PassStamper {
  const key = stampKey(opts.worker, opts.job);
  const everyS = Math.min(MAX_STAMP_EVERY_S, Math.max(opts.minEveryS ?? MIN_STAMP_EVERY_S, Math.ceil(opts.intervalS)));
  let outcome: PassOutcome | null = null;
  let ended = false;
  let malformed: MalformedBlock | null = null;
  let slept: SleepMark | null = null;
  let waiting: readonly string[] = [];
  let waitingMidPass: readonly string[] = [];
  let refused: string | null = null;
  let held: SleepHeld | null = null;
  let budget: SleepBudget | null = null;
  let resting = false;
  let aside: SleepAside | null = null;
  let failing = false;
  // Writes go one after another, so a timer's "running" stamp in flight when
  // the pass ends cannot land after the pass's own and undo it.
  let queue: Promise<void> = Promise.resolve();
  const send = async (running: boolean) => {
    const value = JSON.stringify({ v: 1, ...(opts.job === undefined ? {} : { job: opts.job }), every_s: everyS, running, outcome, ...(ended ? { ended } : {}), ...(malformed ? { malformed } : {}), ...(slept ? { slept } : {}), ...(waiting.length ? { waiting } : {}), ...(waitingMidPass.length ? { waitingMidPass } : {}), ...(refused ? { refused } : {}), ...(held ? { held } : {}), ...(budget ? { budget } : {}), ...(resting ? { resting } : {}), ...(aside ? { aside } : {}), ...(opts.reembedJob === undefined ? {} : { reembedJob: opts.reembedJob }) });
    try {
      await opts.sql`INSERT INTO ob1_config (key, value) VALUES (${key}, ${value})
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      failing = false;
    } catch (e) {
      // A reporter that throws (a Writer on a closed stream) must not leave
      // the queue rejected for every later stamp (review pass 1).
      if (!failing) try { opts.onError?.(e as Error); } catch { /* reporting only */ }
      failing = true;
    }
  };
  const write = (running: boolean) => (queue = queue.then(() => send(running)));
  /**
   * A row once ended takes no stamp but another end: a pass still finishing
   * after the sleep scheduler's hard stop stamped its word through the
   * scheduler's stamper after the row was ended, which then read running —
   * ended and running at once — until it went stale (SMD-2752 review pass 1).
   */
  const live = (running: boolean) => (ended ? queue : write(running));
  /** Inside `during`: what alive() stamps `running` as. */
  let inside = false;
  return {
    key,
    async stamp(o, m) {
      if (ended) return;
      outcome = o;
      if (m !== undefined) malformed = m;
      await write(false);
    },
    async end(o, m) {
      outcome = o;
      ended = true;
      // An ended row waits on nothing (SMD-2752 PR 3, review pass 1), mid-pass included (SMD-2905).
      waiting = [];
      waitingMidPass = [];
      resting = false;
      if (m !== undefined) malformed = m;
      await write(false);
    },
    async during(pass) {
      // Stamped as it starts, so a restarted worker's first long pass is not
      // read as the stopped one's stale row until the timer's first tick.
      inside = true;
      void live(true);
      // Unref'd, as lease.ts's beat is: the timer never holds the process open.
      const timer = setInterval(() => void live(true), Math.min(everyS * 1000, MAX_TIMER_MS));
      timer.unref?.();
      try {
        return await pass;
      } finally {
        clearInterval(timer);
        inside = false;
      }
    },
    async alive(o, m) {
      if (ended) return;
      if (o !== undefined) outcome = o;
      if (m !== undefined) malformed = m;
      await write(inside);
    },
    slept(mark) {
      slept = mark;
    },
    waiting(passes) {
      waiting = [...passes];
    },
    waitingMidPass(passes) {
      waitingMidPass = [...passes];
    },
    // A follower's own: its row says it waits mid-pass for the provider, at
    // once — inside `during`, so running (SMD-2905). The scheduler's per-pass
    // stamper is its own and sets the sleep's row through waitingMidPass.
    async providerWait(on) {
      waitingMidPass = on ? [opts.worker] : [];
      await live(inside);
    },
    refused(kind) {
      refused = kind;
    },
    held(h) {
      held = h && h.total > 0 ? h : null;
    },
    budget(b) {
      budget = { ...b };
    },
    resting(on) {
      resting = on;
    },
    aside(a) {
      aside = a;
    },
  };
}
