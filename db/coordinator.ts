#!/usr/bin/env bun
/**
 * coordinator.ts — the brain's coordinator, first form (SMD-3476, the first
 * step of docs/brain-coordinator.md's "Order"): one process that runs the
 * core passes OB1_PASSES names, each a child of its own, run again after it
 * ends on its own by db/supervise.ts.
 *
 * Why. Each pass was its own compose service — `sleep`, the workers
 * profile's `extract` and `consolidate`, and `board-sync` — with its own
 * profile, restart and status, and `sleep` and the workers' followers were
 * kept apart by the scheduler's refusal and the docs. Now one owner starts
 * them, so the two never run together by construction (the record's rows 9
 * and 10, option a of SMD-3215).
 *
 * What runs. OB1_PASSES, a list of `sleep`, `workers` and `board-sync`
 * (commas or spaces). `workers` is the two followers, `extract` and
 * `consolidate`. Named beside `sleep`, it is left out and the log says so:
 * the scheduler runs extraction and consolidation itself. A name that is no
 * pass is left out the same way, the rest still run. None named, none run,
 * and the coordinator waits for its stop. A change needs the coordinator
 * recreated (`up -d coordinator`), which `up -d` does when its environment
 * changes. Each pass's settings are the ones its own service took, its
 * command line the one that service ran.
 *
 * Users. Run as root (the container), each child runs as a user of its own —
 * CHILDREN's uid, gid the same — with its own HOME, and with only its own
 * settings: the shared environment, less every setting another child owns,
 * plus its own (childEnv). So a child reads neither another's settings nor,
 * by /proc/<pid>/environ, another's environment. The coordinator itself
 * holds them all (the record's "Credentials" names that cost). Run as anyone
 * else, from a checkout, each child runs as that user, and the log says so.
 * The `sleep-dumps` volume (OB1_SLEEP_DUMP_DIR under /var/lib/ob1) is handed
 * to sleep's user, the dumps a root-run scheduler left there included.
 *
 * Output. Each child's lines go to this process's, after `[<name>] `.
 *
 * Signals. Its handlers are installed before anything else. Each SIGTERM or
 * SIGINT goes on to every child, whose own rules apply (the first stops it
 * after the work in hand, the second hard), and a SIGHUP (a checkout run's
 * terminal closed) goes on as a SIGTERM; once all have ended, it exits 0.
 * Each child is in a process group of its own, so a terminal's Ctrl-C is one
 * signal to it, not two.
 *
 * Exit codes: 0 once stopped. It never exits on a child's behalf: a child it
 * cannot start (a uid the runtime does not map, say) is said and tried again
 * on supervise's clock.
 *
 * The code. In the stack it runs from the server image (deploy/compose.yaml,
 * .dockerignore's allow-list), so the passes are the release's own and no
 * checkout is mounted; from a checkout, the checkout's.
 *
 * A one-off. `coordinator.ts run <extract|consolidate|sleep|board-sync>
 * [args…]` runs that pass's script once with `args` in place of the pass's
 * own, as its user with only its settings, as the coordinator would — a
 * `--status`, a `--switch-key`, a backlog, a `--accept` — and exits with its
 * code (`compose run --rm --no-deps coordinator db/coordinator.ts run extract
 * --status`). A key given to that one run (`-e OB1_WORKER_KEY`) is the one it
 * names itself by.
 */

import type { SQL } from "bun";
import { lchownSync, lstatSync, mkdtempSync, readdirSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { StampingWorker } from "./pass-stamp.ts";
import { supervise, type Supervisor } from "./supervise.ts";
import { closeThenExit, databaseUrlIfAny, openSql } from "./connect.ts";

const HERE = import.meta.dir;

/** The names OB1_PASSES takes. */
export const PASSES = ["sleep", "workers", "board-sync"] as const;
export type Pass = (typeof PASSES)[number];

export type ChildName = "board-sync" | "extract" | "consolidate" | "sleep";

/** What the coordinator knows of a child: who it runs as, what it owns, its guards and its command line. */
export type Child = {
  name: ChildName;
  worker: StampingWorker;
  /** Its user and group, when the coordinator runs as root. */
  uid: number;
  /** The settings it alone is handed — with any other child naming the same. */
  own: readonly string[];
  requireKey: boolean;
  /** Settings that must be decimal digits (empty: the pass's default). */
  digits: readonly string[];
  /** Its argv after `bun <script>`, from its own environment. */
  args(env: Record<string, string | undefined>): string[];
  script: string;
};

/** The settings the claim workers and the scheduler share: the key a follower names itself by, and the list it is found in. */
const WORKER_OWN = ["OB1_WORKER_KEY", "MCP_ACCESS_KEYS"] as const;

/** A setting, or the pass's default when it is unset or empty. */
const or = (env: Record<string, string | undefined>, name: string, fallback: string): string => env[name] || fallback;

const SLEEP_DIGITS = [
  "OB1_SLEEP_QUIET", "OB1_SLEEP_POLL", "OB1_SLEEP_WORKERS", "OB1_SLEEP_BUDGET",
  "OB1_SLEEP_STATEMENT_TIMEOUT", "OB1_SLEEP_WORK_MEM", "OB1_SLEEP_MAINTENANCE_WORK_MEM",
] as const;

/** The children, by name: uids from 1101, clear of the CI runner's 1001 (a checkout's files' owner there). */
export const CHILDREN: Record<ChildName, Child> = {
  "board-sync": {
    name: "board-sync", worker: "board-sync", uid: 1101, script: "sync-linear.ts",
    own: ["LINEAR_API_KEY", "OB1_LINEAR_INITIATIVE", "OB1_BOARD_SYNC_INTERVAL", "LINEAR_COMMENT_API_KEY", "OB1_FINDINGS_POST_CAP"],
    requireKey: false, digits: [],
    // The interval and the findings cap are read and refused by the tool itself.
    args: () => ["--loop"],
  },
  extract: {
    name: "extract", worker: "extract", uid: 1102, script: "extract-entities.ts",
    own: [...WORKER_OWN, "OB1_EXTRACT_FOLLOW", "OB1_EXTRACT_WORKERS"],
    requireKey: true, digits: ["OB1_EXTRACT_FOLLOW", "OB1_EXTRACT_WORKERS"],
    args: (env) => ["--follow", ...(env.OB1_EXTRACT_FOLLOW ? [env.OB1_EXTRACT_FOLLOW] : []), "--workers", or(env, "OB1_EXTRACT_WORKERS", "1")],
  },
  consolidate: {
    name: "consolidate", worker: "consolidate", uid: 1103, script: "consolidate.ts",
    own: [...WORKER_OWN, "OB1_CONSOLIDATE_FOLLOW", "OB1_CONSOLIDATE_WORKERS"],
    requireKey: true, digits: ["OB1_CONSOLIDATE_FOLLOW", "OB1_CONSOLIDATE_WORKERS"],
    args: (env) => ["--follow", ...(env.OB1_CONSOLIDATE_FOLLOW ? [env.OB1_CONSOLIDATE_FOLLOW] : []), "--workers", or(env, "OB1_CONSOLIDATE_WORKERS", "1")],
  },
  sleep: {
    name: "sleep", worker: "sleep", uid: 1104, script: "sleep.ts",
    own: [...WORKER_OWN, ...SLEEP_DIGITS, "OB1_SLEEP_DUMP_DIR"],
    requireKey: true, digits: SLEEP_DIGITS,
    args: (env) => [
      "--follow",
      "--quiet", or(env, "OB1_SLEEP_QUIET", "300"),
      "--poll", or(env, "OB1_SLEEP_POLL", "5"),
      "--workers", or(env, "OB1_SLEEP_WORKERS", "1"),
      "--budget", or(env, "OB1_SLEEP_BUDGET", "60"),
      "--statement-timeout", or(env, "OB1_SLEEP_STATEMENT_TIMEOUT", "300"),
      "--work-mem", or(env, "OB1_SLEEP_WORK_MEM", "4"),
      "--maintenance-work-mem", or(env, "OB1_SLEEP_MAINTENANCE_WORK_MEM", "64"),
      ...(env.OB1_SLEEP_DUMP_DIR ? ["--dump-dir", env.OB1_SLEEP_DUMP_DIR] : []),
    ],
  },
};

/** Every setting some child owns: handed to no child that does not. */
export const OWNED: ReadonlySet<string> = new Set(Object.values(CHILDREN).flatMap((c) => c.own));
/** The coordinator's own settings, handed to no child. PORT is the server's, which no pass reads. */
export const COORDINATOR_OWN: readonly string[] = ["OB1_PASSES", "PORT"];

export type Plan = {
  /** The children to run, in the order they start. */
  children: Child[];
  /** What the log says of the list: names left out, and why. */
  lines: string[];
};

/** Read OB1_PASSES: the children it names, each once, `sleep` winning over `workers`. Pure. */
export function planPasses(raw: string | undefined): Plan {
  const named = [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean))];
  const lines: string[] = [];
  for (const name of named.filter((n) => !(PASSES as readonly string[]).includes(n))) {
    lines.push(`coordinator: OB1_PASSES names '${name}', which is no pass (${PASSES.join(", ")}) — it is left out, the rest run`);
  }
  const has = (p: Pass) => named.includes(p);
  if (has("sleep") && has("workers")) {
    lines.push("coordinator: OB1_PASSES names both sleep and workers, which never run together — sleep runs, and it runs extraction and consolidation itself; take workers out of OB1_PASSES to say so");
  }
  const children: Child[] = [];
  if (has("board-sync")) children.push(CHILDREN["board-sync"]);
  if (has("sleep")) children.push(CHILDREN.sleep);
  else if (has("workers")) children.push(CHILDREN.extract, CHILDREN.consolidate);
  if (children.length === 0) {
    lines.push(`coordinator: OB1_PASSES names no pass, so none runs — name them in deploy/.env (${PASSES.join(", ")}) and recreate the coordinator (up -d coordinator)`);
  }
  return { children, lines };
}

/** A child's environment: the shared one, less every setting another child owns and the coordinator's own, plus `extra`. Pure. */
export function childEnv(child: Child, env: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const mine = new Set(child.own);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || COORDINATOR_OWN.includes(name) || (OWNED.has(name) && !mine.has(name))) continue;
    out[name] = value;
  }
  return { ...out, ...extra };
}

/** The prefix of a child's HOME: each start makes a fresh one beneath it (makeHome), when the coordinator runs as root. */
export function childHome(child: Child): string {
  return `/tmp/ob1-${child.name}-`;
}

/** The dump volume's root: OB1_SLEEP_DUMP_DIR is handed to sleep's user only beneath it. */
const DUMP_ROOT = "/var/lib/ob1/";

/** What is at `path`, its own kind and not a link's target's; null when nothing is. */
function kindAt(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

/**
 * Hand a directory, and the regular files in it, to `uid`: OB1_SLEEP_DUMP_DIR,
 * beneath DUMP_ROOT only. Never through a link: root following one a child
 * planted there would hand that child any file in the container. Said, never
 * thrown.
 */
function handDumpDir(dir: string | undefined, uid: number, err: (line: string) => void): void {
  if (!dir) return;
  const path = resolve(dir);
  const at = kindAt(path);
  if (!path.startsWith(DUMP_ROOT) || at === null || !at.isDirectory()) return;
  try {
    lchownSync(path, uid, uid);
    for (const entry of readdirSync(path)) {
      const file = join(path, entry);
      if (kindAt(file)?.isFile()) lchownSync(file, uid, uid);
    }
  } catch (e) {
    err(`coordinator: could not hand ${path} to sleep's user ${uid} (${(e as Error).message}) — the scheduler says if it cannot write there`);
  }
}

/**
 * A HOME of the child's own: a directory made afresh at each start beneath
 * childHome's prefix — by root, mode 0700, then handed to its uid — so
 * nothing another child set up in the shared /tmp (a directory at a path it
 * guessed, a .bunfig.toml in it) is ever a pass's HOME. "/tmp", said, when it
 * cannot be made.
 */
function makeHome(child: Child, err: (line: string) => void): string {
  try {
    const home = mkdtempSync(childHome(child));
    lchownSync(home, child.uid, child.uid);
    return home;
  } catch (e) {
    err(`coordinator: could not make a HOME of uid ${child.uid}'s own (${(e as Error).message}) — the pass runs with HOME=/tmp`);
    return "/tmp";
  }
}

export type CoordinatorOptions = {
  env?: Record<string, string | undefined>;
  sql: SQL | null;
  /** Run each child as its own user: true as root. */
  asOwnUsers?: boolean;
  /** The children to run in place of OB1_PASSES's: db/test-coordinator.ts's planted pair. */
  children?: readonly Child[];
  writer?: { out: (line: string) => void; err: (line: string) => void };
};

/** Start the children OB1_PASSES names; `done` settles with 0 once a stop has ended them all. */
export function coordinate(opts: CoordinatorOptions): Supervisor {
  const env = opts.env ?? process.env;
  const writer = opts.writer ?? { out: (l: string) => console.log(l), err: (l: string) => console.error(l) };
  const plan: Plan = opts.children ? { children: [...opts.children], lines: [] } : planPasses(env.OB1_PASSES);
  for (const line of plan.lines) writer.err(line);
  const own = opts.asOwnUsers ?? false;
  if (plan.children.length) {
    const who = plan.children.map((c) => (own ? `${c.name} (uid ${c.uid})` : c.name));
    writer.err(`coordinator: runs ${who.length === 1 ? who[0] : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`}${own ? "" : " — not root, so each as this process's user, not its own"}`);
  }
  const children = plan.children.map((child) => {
    const extra: Record<string, string> = {};
    if (own) {
      extra.HOME = makeHome(child, writer.err);
      if (child.name === "sleep") handDumpDir(env.OB1_SLEEP_DUMP_DIR, child.uid, writer.err);
    }
    const cenv = childEnv(child, env, extra);
    return supervise({
      worker: child.worker,
      cmd: [process.execPath, "--no-install", "--no-env-file", resolve(HERE, child.script), ...child.args(cenv)],
      ...(own ? { uid: child.uid, gid: child.uid } : {}),
      label: `[${child.name}] `,
      requireKey: child.requireKey,
      digits: child.digits,
      env: cenv,
      sql: opts.sql,
      writer,
    });
  });
  const stopped = new AbortController();
  const done = children.length
    ? Promise.all(children.map((c) => c.done)).then(() => 0)
    : new Promise<number>((settle) => stopped.signal.addEventListener("abort", () => settle(0), { once: true }));
  return {
    done,
    stop(signal) {
      stopped.abort();
      for (const c of children) c.stop(signal);
    },
  };
}

const USAGE = `coordinator.ts takes no arguments — OB1_PASSES names the passes it runs (${PASSES.join(", ")}) — or \`run <${Object.keys(CHILDREN).join("|")}> [args…]\`, one run of that pass's script as its user`;

/**
 * One run of a pass's script, `args` in place of its own, as its user with its
 * settings; settles with its exit code, 127 when it cannot be started (said).
 * Sleep's dump directory — OB1_SLEEP_DUMP_DIR, or the run's own --dump-dir — is
 * handed to its user first, as the coordinator does.
 */
export async function runOnce(child: Child, args: string[], opts: { env?: Record<string, string | undefined>; onSignal?: (stop: (signal: "SIGTERM" | "SIGINT") => void) => void } = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const own = process.getuid?.() === 0;
  const say = (l: string) => console.error(l);
  const extra: Record<string, string> = own ? { HOME: makeHome(child, say) } : {};
  if (own && child.name === "sleep") {
    handDumpDir(env.OB1_SLEEP_DUMP_DIR, child.uid, say);
    const flag = args.indexOf("--dump-dir");
    if (flag >= 0) handDumpDir(args[flag + 1], child.uid, say);
  }
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([process.execPath, "--no-install", "--no-env-file", resolve(HERE, child.script), ...args], {
      env: childEnv(child, env, extra),
      ...(own ? { uid: child.uid, gid: child.uid } : {}),
      stdio: ["inherit", "inherit", "inherit"],
      // Its own process group, as a coordinator's child: a terminal's Ctrl-C is the one signal passed on.
      detached: true,
    });
  } catch (e) {
    say(`coordinator: ${child.name} could not be started${own ? ` as uid ${child.uid}` : ""} (${(e as Error).message})`);
    return 127;
  }
  opts.onSignal?.((signal) => { if (p.exitCode === null && p.signalCode === null) p.kill(signal); });
  return (await p.exited) ?? 1;
}

if (import.meta.main) {
  // The handlers first: as a container's first process, a stop before them is ignored until the grace runs out.
  const heard: ("SIGTERM" | "SIGINT")[] = [];
  let stop: (signal: "SIGTERM" | "SIGINT") => void = (signal) => void heard.push(signal);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(signal));
  // A checkout run's terminal closed: its children, in groups of their own, would not hear the hangup.
  process.on("SIGHUP", () => stop("SIGTERM"));
  const [verb, name, ...rest] = process.argv.slice(2);
  if (verb === "run") {
    const child = name !== undefined && Object.hasOwn(CHILDREN, name) ? CHILDREN[name as ChildName] : undefined;
    if (child === undefined) {
      console.error(USAGE);
      process.exit(2);
    }
    process.exit(await runOnce(child, rest, { onSignal: (s) => { stop = s; for (const signal of heard) s(signal); } }));
  }
  if (verb !== undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const begin = (sql: SQL | null): Promise<number> => {
    const c = coordinate({ sql, asOwnUsers: process.getuid?.() === 0 });
    stop = c.stop;
    for (const signal of heard) c.stop(signal);
    return c.done;
  };
  const url = databaseUrlIfAny();
  if (url === null) {
    console.error("coordinator: no DATABASE_URL it can use, so each pass's heartbeat is left as the pass writes it");
    process.exit(await begin(null));
  }
  const sql = openSql(url, { max: 1 });
  await closeThenExit(sql, async () => begin(sql));
}
