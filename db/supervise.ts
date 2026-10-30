#!/usr/bin/env bun
/**
 * supervise.ts — one core pass, run again after it ends on its own, so the
 * coordinator that runs it (db/coordinator.ts, SMD-3476) can be `restart:
 * unless-stopped` without a crash loop (SMD-3214).
 *
 * Why. `sleep`, `extract`, `consolidate` and `board-sync` were `on-failure:3`
 * services: a refusal exits 2, and an unconditional restart made board-sync's
 * a crash loop that filled the log — podman restarts at once, with no
 * backoff, and never resets the count. But neither runtime starts an
 * `on-failure` container at boot (podman-restart.service starts `always` and
 * `unless-stopped` alone, as Docker's daemon does), so every reboot, podman
 * update and Docker restart left a brain serving and not sleeping — on
 * 2026-10-22 both brains' `sleep` and stable's `board-sync` stayed down until
 * someone started them by hand. So the follower is a child that ends without
 * its container ending: the runtime has nothing to restart, and the follower
 * is run again here, on a clock of minutes. Since SMD-3476 one coordinator
 * holds every such child, one supervise() each.
 *
 * The run. `cmd` is the follower's argv, run with no shell — its settings
 * already read by the coordinator, so nothing in them is parsed again — as
 * `uid`/`gid` when given (the coordinator runs each pass as its own user, so
 * none reads another's environment), in a process group of its own, and its
 * output said line by line under `label`. A spawn that throws is an end of
 * the follower (127), never this process's exit. A follower that ends on its
 * own — a refusal (2), a throw (1),
 * anything but a stop asked for — is run again after RESTART_MS's first wait,
 * doubled at each end in a row to its cap: 1, 2, 4, 8, then every 15
 * minutes. One that ran RESTART_MS.reset or longer before it ended starts the
 * count again. A refusal is the configuration's, which a restart at once
 * would not mend; a fix outside the environment — a model pulled, the
 * migrations applied, a follower run by hand stopped — is met at the next
 * try, and one in deploy/.env needs the coordinator recreated, which `up -d`
 * does when its environment changes, and which starts it at once.
 *
 * The guards. `requireKey` and `digits`: no OB1_WORKER_KEY, or a setting
 * named by `digits` that is not decimal digits (a value starting with a dash
 * would reach the CLI as a flag — `--status` ran once and exited 0). Each is
 * the environment's, which nothing changes without a recreate, so either
 * holds until the stop, the follower never started.
 *
 * A trigger (`every`, SMD-3476): while the follower runs it is sent
 * TRIGGER_SIGNAL every `every` ms, a pass each — board-sync's clock, which its
 * --loop kept before. Nothing else about it changes.
 *
 * The row. When the follower ends, its heartbeat (db/pass-stamp.ts) is ended
 * with `restart` — `in_s`, the seconds from the row's own stamp to the next
 * try (null: none until a recreate), `code`, the follower's exit status, and
 * `tries`, the ends in a row — so preflight says "tries again on its own"
 * with the cause, not "start it again". What the follower wrote last is kept
 * (its `refused`, the scheduler's `slept`, `held`, `budget`); its waits are
 * not, an ended row waiting on nothing. The row stays ended, so a held
 * follower is not one the sleep scheduler or preflight counts as running. A
 * follower that wrote no row of its own gets one here: `heartbeat:<worker>`,
 * the claim workers' under the job their configuration names — the same
 * extractionKey and consolidatePassKey a coordinator's follower runs under,
 * which takes no --job. With no database, or one not answering within
 * STAMP_TIMEOUT_MS, the row is left as it is and the log says so; the next
 * follower writes its own.
 *
 * A stop. Each stop() goes on to the follower, whose own rules apply (the
 * first SIGTERM stops it after the work in hand, the second hard); once it
 * has ended, `done` settles with 0. Waiting or held, it settles at once.
 *
 * Its state (`onState`, SMD-3476 PR 3): running from each start, waiting
 * after each end of its own with the next try's time, held by a guard, and
 * stopped — what the coordinator's own row says of each child.
 *
 * As a command it is retired (its foot): a container from before SMD-3476
 * that runs it holds, running nothing, rather than restart in a loop.
 */

import type { SQL } from "bun";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractionKey } from "../server-portable/entities.ts";
import { consolidatePassKey } from "../server-portable/consolidate-decide.ts";
import { embeddingContract, reembedKey } from "./config.mjs";
import { sleepUnless } from "./lease.ts";
import { MIN_STAMP_EVERY_S, stampKey, TRIGGER_SIGNAL, type StampingWorker } from "./pass-stamp.ts";
import { andList, commandLine, consoleWriter, type Writer } from "./cli.ts";

/** The waits before a follower that ended on its own runs again: the first, the cap it doubles to, and the run that starts the count again. */
export const RESTART_MS = { first: 60_000, max: 900_000, reset: 900_000 } as const;
/** The longest a heartbeat write may take before it is left: the database may be what is down. */
export const STAMP_TIMEOUT_MS = 10_000;
/** The longest a follower's last output is waited for once it has exited. */
const DRAIN_MS = 2_000;
/** The longest partial line held before it is written anyway: a pass that never ends a line holds no memory past it. */
const LINE_CAP = 64 * 1024;

/** The wait before the follower's next run, after `tries` ends in a row (1 for the first). */
export function restartWait(tries: number, first: number = RESTART_MS.first, max: number = RESTART_MS.max): number {
  return Math.min(max, first * 2 ** Math.min(Math.max(0, tries - 1), 30));
}

/** The `restart` a held follower's row carries: `in_s` from the row's stamp to the next try, null for none until a recreate. */
export type RestartMark = { in_s: number | null; code: number; tries: number };

/** A guard's refusal: what the log says, and the start refusal's kind the row names. */
export type GuardRefusal = { kind: "identity" | "usage"; line: string };

/** What a supervisor says of its follower (`onState`), its times this process's Date.now(): running, waiting to run again, held by a guard, or stopped. */
export type FollowerState =
  | { state: "running"; since: number }
  | { state: "waiting"; since: number; next: number; code: number; tries: number }
  | { state: "held"; since: number; refused: GuardRefusal["kind"] }
  | { state: "stopped"; since: number };

/**
 * The guards, in the words of the compose file before SMD-3476: the worker key first, then each
 * setting `--digits` names that is not decimal digits (empty is unset, and
 * the follower's default). Null when both hold. Pure.
 */
export function guardRefusal(worker: string, env: Record<string, string | undefined>, opts: { requireKey?: boolean; digits?: readonly string[] }): GuardRefusal | null {
  if (opts.requireKey && !env.OB1_WORKER_KEY) {
    return { kind: "identity", line: `${worker}: OB1_WORKER_KEY is not set in deploy/.env — mint a key (cd server-portable && bun keygen.ts --name workers --scope capture), add its line to MCP_ACCESS_KEYS and the raw key as OB1_WORKER_KEY` };
  }
  const bad = (opts.digits ?? []).filter((name) => /[^0-9]/.test(env[name] ?? ""));
  if (bad.length) {
    const named = bad.map((name) => `${name} ('${env[name]}')`);
    const list = andList(named);
    return { kind: "usage", line: `${worker}: ${list} ${bad.length === 1 ? "takes" : "take"} digits only` };
  }
  return null;
}

/**
 * The heartbeat key a follower of `worker` stamps when the coordinator runs it: the
 * scheduler's and board-sync's own, the claim workers' under the job their
 * configuration names (they take no --job there). Null when the configuration
 * does not resolve — the follower then refuses in its own words.
 */
export function followerKey(worker: StampingWorker, env: Record<string, string | undefined>): string | null {
  if (worker === "sleep" || worker === "board-sync") return stampKey(worker);
  try {
    const cfg = resolveEmbedConfig(env as EmbedEnv);
    if (worker === "extract") return stampKey("extract", extractionKey(cfg.metadataModel));
    // The model's own key, as a re-embed follower without --job pools under (SMD-2679).
    if (worker === "reembed") {
      const { model, dim } = embeddingContract(env);
      return stampKey("reembed", reembedKey(model, dim));
    }
    return stampKey("consolidate", consolidatePassKey(cfg));
  } catch {
    return null;
  }
}

/** The job a key names, as pass-stamp.ts writes it in the value: none for the scheduler's and board-sync's. */
function jobOf(worker: StampingWorker, key: string): string | undefined {
  return worker === "sleep" || worker === "board-sync" ? undefined : key.slice("heartbeat:".length);
}

/**
 * End the follower's row with `restart`: its own last word kept when it wrote
 * one since `since`, else a row of its own here. The waits go — an ended row
 * waits on nothing — and a follower that did not exit 0 failed. One
 * statement, the row read and written under its own lock.
 */
export async function endRow(sql: SQL, opts: { worker: StampingWorker; key: string; since: Date; restart: RestartMark; refused?: string }): Promise<void> {
  // Objects, not JSON text: Bun binds a string to jsonb as a JSON string (test-live [3]).
  const fresh = { v: 1, ...(jobOf(opts.worker, opts.key) === undefined ? {} : { job: jobOf(opts.worker, opts.key) }), every_s: MIN_STAMP_EVERY_S, running: false, outcome: "failed" };
  const set = { running: false, ended: true, restart: opts.restart, ...(opts.restart.code === 0 ? {} : { outcome: "failed" }), ...(opts.refused ? { refused: opts.refused } : {}) };
  await sql`
    INSERT INTO ob1_config (key, value)
    SELECT ${opts.key}, ((CASE WHEN c.updated_at >= ${opts.since} AND c.value IS JSON OBJECT THEN c.value::jsonb ELSE ${fresh}::jsonb END
                         - 'waiting' - 'waitingMidPass' - 'resting') || ${set}::jsonb)::text
      FROM (SELECT 1) one LEFT JOIN ob1_config c ON c.key = ${opts.key}
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export type SuperviseOptions = {
  worker: StampingWorker;
  /** The follower's argv, run with no shell. */
  cmd: readonly string[];
  /** The user and group it runs as; unset, this process's own. */
  uid?: number;
  gid?: number;
  /** Put before each line it writes, which then goes to the writer; unset, its output is this process's. */
  label?: string;
  requireKey?: boolean;
  digits?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Where the row goes; null leaves it (no DATABASE_URL). */
  sql: SQL | null;
  /** The waits, RESTART_MS unless a test drives them faster. */
  waits?: { first: number; max: number; reset: number };
  /**
   * A trigger's period, in ms (SMD-3476): while the follower runs, it is sent
   * TRIGGER_SIGNAL this often, one pass each — board-sync's clock, the
   * coordinator's since its --loop retired. Its ends, refusals and rows are a
   * follower's as ever. Unset, it is sent nothing.
   */
  every?: number;
  stampTimeoutMs?: number;
  writer?: Writer;
  /** Told each change of the follower's state; a throw from it is said, never the follower's end. */
  onState?: (state: FollowerState) => void;
};

export type Supervisor = {
  /** Settles with the exit code: 0 once stopped. */
  done: Promise<number>;
  /** A signal the process heard: passed to the follower, or the end of a wait or a hold. */
  stop(signal: "SIGTERM" | "SIGINT"): void;
};

/** Run the follower, and again after each end of its own, until a stop. */
export function supervise(opts: SuperviseOptions): Supervisor {
  const env = opts.env ?? process.env;
  const waits = opts.waits ?? RESTART_MS;
  const { out, err } = opts.writer ?? consoleWriter;
  const key = followerKey(opts.worker, env);
  const stopped = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | null = null;

  /** The row's end, bounded: a database not answering is said once and left. */
  let unwritten = false;
  const stamp = async (since: Date, restart: RestartMark, refused?: string): Promise<void> => {
    if (opts.sql === null || key === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        endRow(opts.sql, { worker: opts.worker, key, since, restart, refused }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${(opts.stampTimeoutMs ?? STAMP_TIMEOUT_MS) / 1000} s`)), opts.stampTimeoutMs ?? STAMP_TIMEOUT_MS); }),
      ]);
      unwritten = false;
    } catch (e) {
      if (!unwritten) err(`supervise: could not end ${key} (${(e as Error).message}) — the row keeps its last word until the follower stamps again`);
      unwritten = true;
    } finally {
      clearTimeout(timer);
    }
  };

  const tell = (state: FollowerState): void => {
    try {
      opts.onState?.(state);
    } catch (e) {
      err(`supervise: ${opts.worker}'s state could not be told (${(e as Error).message})`);
    }
  };

  const done = (async (): Promise<number> => {
    const guard = guardRefusal(opts.worker, env, opts);
    if (guard) {
      err(guard.line);
      err(`supervise: ${opts.worker} is held, not started — that is deploy/.env's to mend, and the coordinator's recreate (up -d coordinator) to read; it does not exit, so the runtime does not restart it in a loop (SMD-3214)`);
      tell({ state: "held", since: Date.now(), refused: guard.kind });
      // Its last word kept — the scheduler's last sleep, its held thoughts — and the guard's kind on it.
      await stamp(new Date(0), { in_s: null, code: 2, tries: 0 }, guard.kind);
      if (!stopped.signal.aborted) await new Promise<void>((resolve) => stopped.signal.addEventListener("abort", () => resolve(), { once: true }));
      tell({ state: "stopped", since: Date.now() });
      return 0;
    }
    let tries = 0;
    while (!stopped.signal.aborted) {
      const began = new Date();
      const piped = opts.label !== undefined;
      let code: number | null;
      try {
        // Its own process group: a terminal's Ctrl-C reaches this process alone, which passes one signal on, not a second.
        child = Bun.spawn([...opts.cmd], {
          env: env as Record<string, string>,
          ...(opts.uid === undefined ? {} : { uid: opts.uid }),
          ...(opts.gid === undefined ? {} : { gid: opts.gid }),
          stdio: ["ignore", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit"],
          detached: true,
        });
        tell({ state: "running", since: began.getTime() });
        const drained = piped
          ? Promise.all([labelled(child.stdout as ReadableStream<Uint8Array>, opts.label!, out), labelled(child.stderr as ReadableStream<Uint8Array>, opts.label!, err)])
          : Promise.resolve();
        // The trigger's clock, from the follower's start: its first pass is its own, at start.
        const running = child;
        // A signal that cannot be sent (the child gone between the check and the kill, a user it may not signal) is
        // said once and the clock goes on: a throw on the timer would end this process, every pass with it.
        let unsent = false;
        const tick = opts.every === undefined ? undefined : setInterval(() => {
          if (running.exitCode !== null || running.signalCode !== null) return;
          try {
            running.kill(TRIGGER_SIGNAL);
            unsent = false;
          } catch (e) {
            if (!unsent) err(`supervise: ${opts.worker}'s trigger could not be sent (${(e as Error).message}); the clock goes on`);
            unsent = true;
          }
        }, opts.every);
        try {
          code = await child.exited;
        } finally {
          clearInterval(tick);
        }
        // The pumps never reject (labelled), so a drain cut short by the timer leaves nothing unhandled.
        await Promise.race([drained, Bun.sleep(DRAIN_MS)]);
      } catch (e) {
        // Never this process's exit: under `unless-stopped` that is the crash loop again (SMD-3214). An end of the child, run again on the clock.
        err(`supervise: ${opts.worker} could not be started (${(e as Error).message})${opts.uid === undefined ? "" : ` as uid ${opts.uid}`}`);
        code = 127;
      }
      child = null;
      if (stopped.signal.aborted) break;
      const ranMs = Date.now() - began.getTime();
      tries = ranMs >= waits.reset ? 1 : tries + 1;
      const waitMs = restartWait(tries, waits.first, waits.max);
      const next = new Date(Date.now() + waitMs);
      tell({ state: "waiting", since: Date.now(), next: next.getTime(), code: code ?? 1, tries });
      err(`supervise: ${opts.worker} exited ${code} after ${seconds(ranMs)}${code === 2 ? " — a refusal, its lines above say why" : ""}; it runs again at ${next.toISOString()} (in ${seconds(waitMs)}, end ${tries} in a row)${key && opts.sql ? `, ${key} says so` : ""}. A fix in deploy/.env needs the coordinator recreated (up -d coordinator), which starts it at once (SMD-3214).`);
      await stamp(began, { in_s: Math.round(waitMs / 1000), code: code ?? 1, tries });
      await sleepUnless(waitMs, stopped.signal);
    }
    tell({ state: "stopped", since: Date.now() });
    return 0;
  })();

  return {
    done,
    stop(signal) {
      stopped.abort();
      if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
}

/**
 * Each line of `stream` to `write`, after `label`: a line ends at a newline or
 * a carriage return (a progress line rewritten in place), a partial line past
 * LINE_CAP is written as it is, and a last line with no end too. It never
 * rejects: a stream or a writer that fails ends the pump, said once, and the
 * child is still waited for on its own.
 */
async function labelled(stream: ReadableStream<Uint8Array>, label: string, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let held = "";
  try {
    for await (const chunk of stream) {
      // Split once per chunk: the last piece is the partial line held for the next, a
      // closing carriage return with it, whose newline may open the next chunk.
      let text = held + decoder.decode(chunk, { stream: true });
      const cr = text.endsWith("\r") ? "\r" : "";
      if (cr) text = text.slice(0, -1);
      const lines = text.split(/\n|\r(?!\n)/);
      held = (lines.pop() ?? "") + cr;
      for (const line of lines) write(`${label}${line.endsWith("\r") ? line.slice(0, -1) : line}`);
      for (; held.length > LINE_CAP; held = held.slice(LINE_CAP)) write(`${label}${held.slice(0, LINE_CAP)}`);
    }
    held += decoder.decode();
    if (held) write(`${label}${held.endsWith("\r") ? held.slice(0, -1) : held}`);
  } catch (e) {
    try { write(`${label}(its output could not be read on: ${(e as Error).message})`); } catch { /* the writer itself failed */ }
  }
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

if (import.meta.main) {
  // A container from before SMD-3476 runs `bun db/supervise.ts --worker … --run …`
  // from a checkout it mounts. Exiting would have `unless-stopped` restart it
  // in a loop (SMD-3214), so it says why it runs nothing and holds until its stop.
  // Its old flags are still scanned, so anything else is refused (2) as before.
  commandLine("supervise.ts", { worker: "one", run: "one", "require-key": "none", digits: "many" } as const, { note: "Retired as a command (SMD-3476): run as the old services did, it holds, running nothing, until its stop." });
  console.error("supervise.ts: retired as a command (SMD-3476) — the coordinator runs every pass now; remove this container: compose up -d --remove-orphans, with the -f files and -p the stack was started with");
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => resolve());
  });
  process.exit(0);
}
