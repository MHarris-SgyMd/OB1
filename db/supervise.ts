#!/usr/bin/env bun
/**
 * supervise.ts — the compose services' follower, run again after it ends on its
 * own, so the service can be `restart: unless-stopped` without a crash loop
 * (SMD-3214).
 *
 * Why. `sleep`, `extract`, `consolidate` and `board-sync` were `on-failure:3`:
 * a refusal exits 2, and an unconditional restart made board-sync's a crash
 * loop that filled the log — podman restarts at once, with no backoff, and
 * never resets the count. But neither runtime starts an `on-failure`
 * container at boot (podman-restart.service starts `always` and
 * `unless-stopped` alone, as Docker's daemon does), so every reboot, podman
 * update and Docker restart left a brain serving and not sleeping — on
 * 2026-10-22 both brains' `sleep` and stable's `board-sync` stayed down until
 * someone started them by hand. This process is the service's command
 * instead: the container does not exit when the follower does, so the
 * runtime has nothing to restart, and the follower is run again here, on a
 * clock of minutes.
 *
 * The run. `--run` is the follower's command, as `sh -c` runs it — `exec bun
 * db/sleep.ts --follow …`, its settings expanded from the environment as the
 * compose file's `sh -c` did. It must `exec`, so the process this one signals
 * is the follower's own. A follower that ends on its own — a refusal (2), a
 * throw (1), anything but a stop asked for — is run again after RESTART_MS's
 * first wait, doubled at each end in a row to its cap: 1, 2, 4, 8, then every
 * 15 minutes. One that ran RESTART_MS.reset or longer before it ended starts
 * the count again. A refusal is the configuration's, which a restart at once
 * would not mend; a fix outside the environment — a model pulled, the
 * migrations applied, the workers profile stopped beside `sleep` — is met at
 * the next try, and one in deploy/.env needs the service recreated, which
 * `up -d` does when its environment changes, and which starts it at once.
 *
 * The guards. `--require-key` and `--digits` are the compose file's `sh -c`
 * guards, moved here: no OB1_WORKER_KEY, or a setting named by `--digits`
 * that is not decimal digits (a value starting with a dash would reach the
 * CLI as a flag — `--status` ran once and exited 0). Each is the
 * environment's, which nothing changes without a recreate, so either holds
 * until the service is stopped, the follower never started.
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
 * extractionKey and consolidatePassKey a compose follower runs under, which
 * takes no --job. With no DATABASE_URL, or a database not answering within
 * STAMP_TIMEOUT_MS, the row is left as it is and the log says so; the next
 * follower writes its own.
 *
 * Signals. Its handlers are installed before anything else, so as PID 1
 * without an init it hears the runtime's stop. Each SIGTERM or SIGINT goes on
 * to the follower, whose own rules apply (the first stops it after the work in
 * hand, the second hard); once it has ended, this exits 0. Waiting, it exits
 * 0 at once. The follower is not PID 1, so a signal before its own handlers
 * are in ends it then (143), where as PID 1 it ignored one until the grace
 * ran out (137).
 *
 * Exit codes: 0 once stopped; 2 for its own command line — the compose file's,
 * held to its shape by CI. It never exits on its follower's behalf.
 */

import type { SQL } from "bun";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractionKey } from "../server-portable/entities.ts";
import { consolidatePassKey } from "../server-portable/consolidate-decide.ts";
import { embeddingContract, reembedKey } from "./config.mjs";
import { sleepUnless } from "./lease.ts";
import { MIN_STAMP_EVERY_S, stampKey, STAMPING_WORKERS, type StampingWorker } from "./pass-stamp.ts";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrlIfAny, openSql } from "./connect.ts";

const FLAGS = { worker: "one", run: "one", "require-key": "none", digits: "many" } as const;
const HINTS = { worker: `<${STAMPING_WORKERS.join("|")}>`, run: "<the follower's command, as sh -c runs it, exec'd>", digits: "<SETTING …>" };

/** The waits before a follower that ended on its own runs again: the first, the cap it doubles to, and the run that starts the count again. */
export const RESTART_MS = { first: 60_000, max: 900_000, reset: 900_000 } as const;
/** The longest a heartbeat write may take before it is left: the database may be what is down. */
export const STAMP_TIMEOUT_MS = 10_000;

/** The wait before the follower's next run, after `tries` ends in a row (1 for the first). */
export function restartWait(tries: number, first: number = RESTART_MS.first, max: number = RESTART_MS.max): number {
  return Math.min(max, first * 2 ** Math.min(Math.max(0, tries - 1), 30));
}

/** The `restart` a held follower's row carries: `in_s` from the row's stamp to the next try, null for none until a recreate. */
export type RestartMark = { in_s: number | null; code: number; tries: number };

/** A guard's refusal: what the log says, and the start refusal's kind the row names. */
export type GuardRefusal = { kind: "identity" | "usage"; line: string };

/**
 * The compose file's guards, by its own words: the worker key first, then each
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
    const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
    return { kind: "usage", line: `${worker}: ${list} ${bad.length === 1 ? "takes" : "take"} digits only` };
  }
  return null;
}

/**
 * The heartbeat key a follower of `worker` stamps when compose runs it: the
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
  /** The follower's command, as `sh -c` runs it. */
  run: string;
  requireKey?: boolean;
  digits?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Where the row goes; null leaves it (no DATABASE_URL). */
  sql: SQL | null;
  /** The waits, RESTART_MS unless a test drives them faster. */
  waits?: { first: number; max: number; reset: number };
  stampTimeoutMs?: number;
  writer?: Writer;
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
  const { err } = opts.writer ?? consoleWriter;
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

  const done = (async (): Promise<number> => {
    const guard = guardRefusal(opts.worker, env, opts);
    if (guard) {
      err(guard.line);
      err(`supervise: ${opts.worker} is held, not started — that is deploy/.env's to mend, and the service's recreate (up -d) to read; it does not exit, so the runtime does not restart it in a loop (SMD-3214)`);
      // Its last word kept — the scheduler's last sleep, its held thoughts — and the guard's kind on it.
      await stamp(new Date(0), { in_s: null, code: 2, tries: 0 }, guard.kind);
      if (!stopped.signal.aborted) await new Promise<void>((resolve) => stopped.signal.addEventListener("abort", () => resolve(), { once: true }));
      return 0;
    }
    let tries = 0;
    while (!stopped.signal.aborted) {
      const began = new Date();
      child = Bun.spawn(["sh", "-c", opts.run], { env: env as Record<string, string>, stdio: ["inherit", "inherit", "inherit"] });
      const code = await child.exited;
      child = null;
      if (stopped.signal.aborted) break;
      const ranMs = Date.now() - began.getTime();
      tries = ranMs >= waits.reset ? 1 : tries + 1;
      const waitMs = restartWait(tries, waits.first, waits.max);
      const next = new Date(Date.now() + waitMs);
      err(`supervise: ${opts.worker} exited ${code} after ${seconds(ranMs)}${code === 2 ? " — a refusal, its lines above say why" : ""}; it runs again at ${next.toISOString()} (in ${seconds(waitMs)}, end ${tries} in a row)${key && opts.sql ? `, ${key} says so` : ""}. A fix in deploy/.env needs the service recreated (up -d), which starts it at once (SMD-3214).`);
      await stamp(began, { in_s: Math.round(waitMs / 1000), code: code ?? 1, tries });
      await sleepUnless(waitMs, stopped.signal);
    }
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

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

if (import.meta.main) {
  // The handlers first: as PID 1 without an init, a stop before them is ignored until the grace runs out.
  const heard: ("SIGTERM" | "SIGINT")[] = [];
  let stop: (signal: "SIGTERM" | "SIGINT") => void = (signal) => void heard.push(signal);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(signal));
  const cli = commandLine("supervise.ts", FLAGS, { hints: HINTS, note: "Runs --run as sh -c does, and again after it ends on its own (SMD-3214)." });
  const worker = cli.value("worker");
  const run = cli.value("run");
  if (worker === undefined || !(STAMPING_WORKERS as readonly string[]).includes(worker) || run === undefined) {
    console.error(`supervise.ts needs --worker (${STAMPING_WORKERS.join(", ")}) and --run`);
    process.exit(2);
  }
  const url = databaseUrlIfAny();
  const begin = (sql: SQL | null): Promise<number> => {
    const s = supervise({ worker: worker as StampingWorker, run, requireKey: cli.has("require-key"), digits: cli.values("digits"), sql });
    stop = s.stop;
    for (const signal of heard) s.stop(signal);
    return s.done;
  };
  if (url === null) {
    console.error("supervise: no DATABASE_URL it can use, so the follower's heartbeat is left as the follower writes it");
    process.exit(await begin(null));
  }
  const sql = openSql(url, { max: 1 });
  await closeThenExit(sql, async () => {
    return begin(sql);
  });
}
