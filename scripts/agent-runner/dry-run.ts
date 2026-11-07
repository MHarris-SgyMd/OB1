#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * dry-run.ts — the agent runner's selection, as a dry run (SMD-4087 cut 1): which labelled ticket a run would take
 * now, and why it skips each other one. It reads the board from Linear, branches and worktrees from git, open pull
 * requests from GitHub, and claims from the stable brain's REST core; it claims nothing and writes nothing. The rule
 * is select.ts's; the readers are facts.ts's; the README beside this file has the config and the criteria.
 *
 *   bun --no-env-file --config=/dev/null scripts/agent-runner/dry-run.ts   # the config in ~/.config/open-brain/agent-runner/
 *     … --config <path> reads another config, and … --json prints the verdicts as JSON
 *   bun scripts/agent-runner/dry-run.ts --self-check                       # every rule and reader on fixtures, offline
 *
 * Bun otherwise reads a .env and a bunfig.toml from the working directory: a .env can set a proxy, TLS or logging
 * setting that reaches every request, and a bunfig.toml can preload code before this file runs. The two flags keep
 * both out, and the dry run refuses to start without them, or with any setting in its environment that could reroute
 * a request, change what TLS trusts, log headers or load code (RISKY_ENV). Until the stable brain answers claims over
 * its REST core (v2.0.0, with its proxy's /api route), every ticket's claims can't be read: the dry run says so and
 * takes nothing. It reads the runner's own keys alone, at fixed paths in ~/.config/open-brain/agent-runner/ (0700):
 * linear.key always, brain.key and github.token when they are there. Each must be a regular file its owner alone can
 * read, of a key's shape; every key is read before any request, and none is ever printed. Exit 0 once it has
 * printed its verdicts, 1 when a read fails, 2 for a refused option, start, environment, config or key.
 */

import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { linearClient, type Gql } from "../../db/linear-api.ts";
import {
  BOARD_QUERY,
  GIT_SAFE,
  INITIATIVE_QUERY,
  LABELS_QUERY,
  SAFE_REQUEST,
  gitEnv,
  parseLocalBranches,
  parseLsRemote,
  parseWorktrees,
  readBoard,
  readBranchPrs,
  readBranches,
  readClaims,
  readOpenPrs,
  toTicket,
  type Config,
  type Fetch,
  type Runner,
} from "./facts.ts";
import {
  HIDDEN_TEXT,
  boardReasons,
  branchOfLabel,
  byPriorityThenAge,
  firstReasons,
  labelReasons,
  mentionsTicket,
  select,
  workReasons,
  type BranchPrs,
  type Claim,
  type ClaimsRead,
  type Facts,
  type HistoryEntry,
  type Rules,
  type Ticket,
  type Verdict,
} from "./select.ts";

const KNOWN: Record<string, "value" | "flag"> = { "--config": "value", "--json": "flag", "--self-check": "flag", "--help": "flag" };
type Opts = { error?: string; [name: string]: string | true | undefined };

/** `--name value` or `--name=value`; a flag takes none; anything unknown is refused. */
export function parseArgs(argv: string[]): Opts {
  const out: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.indexOf("=");
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const kind = Object.hasOwn(KNOWN, name) ? KNOWN[name] : undefined;
    if (!kind) return { error: `unknown option ${tok}; known: ${Object.keys(KNOWN).join(" ")}` };
    if (kind === "flag") {
      if (eq > 0) return { error: `${name} takes no value` };
      out[name] = true;
      continue;
    }
    const value = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value` };
    out[name] = value;
  }
  return out;
}

/** The runner's directory, its config, and its keys: fixed paths, so no config can point a key read elsewhere. */
export const RUNNER_DIR = join(homedir(), ".config", "open-brain", "agent-runner");
export const KEY_FILES = { linear: "linear.key", brain: "brain.key", github: "github.token" } as const;
/** Each key's shape: a value that isn't one is never sent. Linear's personal or OAuth key; keygen.ts's 64 hex; a GitHub token. */
export const KEY_SHAPES = {
  linear: /^lin_(api|oauth)_[A-Za-z0-9_]{16,}$/,
  brain: /^[0-9a-f]{64}$/,
  github: /^(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$/,
} as const;
/** The flags the dry run must be started with, so Bun reads no .env and no bunfig.toml from the working directory. */
export const START_FLAGS = ["--no-env-file", "--config=/dev/null"];
const START = `bun ${START_FLAGS.join(" ")} scripts/agent-runner/dry-run.ts`;

/**
 * The environment's families that can reroute a request, change what TLS trusts, log a request's headers (the keys
 * among them) or load code into the process: Bun's, Node's and OpenSSL's settings, the dynamic loader's, and every
 * proxy. A family, not a list, so a setting no one listed is caught too.
 */
export const RISKY_ENV = /^(BUN_|NODE_|SSL_|DYLD_|LD_)|_PROXY$/i;
/** The few of those the dry run starts with all the same: where Bun is installed, where no proxy is used, and Bun's transpiler cache turned off. */
const ENV_ALLOWED: Record<string, (value: string) => boolean> = {
  BUN_INSTALL: () => true,
  NO_PROXY: () => true,
  no_proxy: () => true,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: (value) => value === "0",
};

/** The risky settings present in `env`, by name; an empty one sets nothing. */
export function riskyEnv(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => RISKY_ENV.test(k) && env[k] !== undefined && env[k] !== "" && !(Object.hasOwn(ENV_ALLOWED, k) && ENV_ALLOWED[k](env[k] as string)))
    .sort();
}

/** The config's keys: a value the file must give (required), or its default. */
const CONFIG_KEYS: Record<keyof Config, { required: true } | { default: string | null }> = {
  team: { default: "SMD" },
  initiative: { required: true },
  maintainerLinearId: { required: true },
  repo: { default: "MHarris-SgyMd/OB1" },
  botRepo: { default: null },
  mainCheckout: { required: true },
  restUrl: { default: null },
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A Linear user id: a UUID. A placeholder left in the config is refused, not read as a user no add can match. */
const LINEAR_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A REST URL the brain key may go to: http or https, no credentials, query or fragment, and plain http on loopback alone. */
export function checkRestUrl(value: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { error: "restUrl is not a URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "restUrl must be http or https" };
  if (u.username || u.password) return { error: "restUrl must carry no credentials: the key goes in a header" };
  if (u.search || u.hash) return { error: "restUrl must carry no query or fragment: the key goes in a header, never the URL" };
  if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) return { error: "restUrl over plain http must be a loopback address" };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

/** The config file's JSON: every key a string (or null where it may be), the required ones given, no unknown key; `~/` expanded. */
export function parseConfig(text: string, home: string): Config | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the text it choked on, which could be a key: say only that it isn't JSON.
    return { error: "the config is not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the config must be a JSON object" };
  const given = raw as Record<string, unknown>;
  const unknown = Object.keys(given).filter((k) => !Object.hasOwn(CONFIG_KEYS, k));
  if (unknown.length) return { error: `the config has ${unknown.length} key(s) the runner doesn't know (it knows ${Object.keys(CONFIG_KEYS).join(", ")})` };
  const out: Record<string, string | null> = {};
  for (const [key, rule] of Object.entries(CONFIG_KEYS)) {
    const v = given[key];
    if (v === undefined) {
      if ("required" in rule) return { error: `the config must give ${key}` };
      out[key] = rule.default;
      continue;
    }
    if (v === null && "default" in rule && rule.default === null) {
      out[key] = null;
      continue;
    }
    if (typeof v !== "string" || !v.trim()) return { error: `${key} must be a non-empty string` };
    out[key] = v;
  }
  if (!LINEAR_USER_ID.test(String(out.maintainerLinearId))) return { error: "maintainerLinearId must be a Linear user id, a UUID: the README beside this script says how to find yours" };
  if (typeof out.mainCheckout === "string" && out.mainCheckout.startsWith("~/")) out.mainCheckout = join(home, out.mainCheckout.slice(2));
  for (const key of ["repo", "botRepo"] as const) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const parts = v.split("/");
    if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === "." || p === "..")) return { error: `${key} must be owner/name` };
  }
  if (typeof out.restUrl === "string") {
    const checked = checkRestUrl(out.restUrl);
    if ("error" in checked) return checked;
    out.restUrl = checked.url;
  }
  return out as unknown as Config;
}

/** Why `dir` can't hold the runner's keys, or null when it can: a real directory, its owner's, no group or other bits. */
export function privateDirProblem(dir: string): string | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return `there is no runner directory at ${dir} (SMD-4089 makes it)`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} must be a directory, not a link`;
  if (st.uid !== process.getuid?.()) return `${dir} must be yours`;
  if ((st.mode & 0o077) !== 0) return `${dir} must be its owner's alone: chmod 700 it`;
  return null;
}

/** How the runner's files are opened: read-only, never through a link, and never waiting on a pipe. */
export const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * A file's text, opened by OPEN_FLAGS, and read only when it is a regular file of this user's, no larger than 64 KiB.
 * `secret` (a key): also one link, and no group or other bits at all; otherwise (the config) no group or other write
 * bit. Null when there is no file.
 */
export function readOwnedFile(path: string, secret: boolean): string | null {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(`${path} is a link: the runner reads only a regular file`);
    throw new Error(`${path} can't be opened (${code})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.uid !== process.getuid?.()) throw new Error(`${path} must be yours`);
    if (secret && st.nlink !== 1) throw new Error(`${path} has other links to it`);
    if (secret && (st.mode & 0o077) !== 0) throw new Error(`${path} can be read by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
    if (!secret && (st.mode & 0o022) !== 0) throw new Error(`${path} can be written by others (mode ${(st.mode & 0o777).toString(8)}): chmod go-w it`);
    if (st.size > 65_536) throw new Error(`${path} is too large to be what it should be`);
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** One of the runner's keys from its fixed file, or null when there is none; a value not of the key's shape is refused, never shown. */
export function readKey(dir: string, which: keyof typeof KEY_FILES): string | null {
  const path = join(dir, KEY_FILES[which]);
  const text = readOwnedFile(path, true);
  const value = text?.trim() ?? "";
  if (!value) return null;
  if (!KEY_SHAPES[which].test(value)) throw new Error(`${path} doesn't hold a ${which} key of the right shape (its value is not shown)`);
  return value;
}

/** Whether `ls -lde` output lists an access control entry (macOS): a line starting with a number and a colon. Modes alone miss one. */
export function hasAclEntry(lsOutput: string): boolean {
  return /^\s*\d+: /m.test(lsOutput);
}

const BACKSLASH = String.fromCharCode(92);

/** Untrusted text for a terminal: each code point that doesn't show, or changes how text shows, as <U+XXXX>. */
export function printable(s: string): string {
  let out = "";
  for (const ch of s) out += HIDDEN_TEXT.test(ch) ? `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>` : ch;
  return out;
}

/** Untrusted text on one line: printable, every whitespace run closed to one space, and cut at `max` code points, so it can't wrap into a line of its own. */
export function shown(s: string, max: number): string {
  const flat = [...printable(s.replace(/\s+/g, " ").trim())];
  return flat.length > max ? `${flat.slice(0, max - 1).join("")}…` : flat.join("");
}

/** A function that writes "<a key>" for each of `secrets` wherever it appears in a text. */
export function masker(secrets: (string | null)[]): (text: string) => string {
  const present = secrets.filter((k): k is string => !!k);
  return (text) => present.reduce((out, k) => out.split(k).join("<a key>"), text);
}

/** JSON whose strings carry no hidden code point raw: JSON.stringify escapes C0 controls, and this escapes the rest, astral ones as surrogate pairs. */
export function safeJson(value: unknown): string {
  let out = "";
  for (const ch of JSON.stringify(value, null, 2)) {
    if (HIDDEN_TEXT.test(ch) && (ch.codePointAt(0) ?? 0) > 0x1f) {
      for (let i = 0; i < ch.length; i++) out += `${BACKSLASH}u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

/** What the dry run reads through: Linear, a command runner, fetch, and the keys it already read. */
export type Deps = { gql: Gql; run: Runner; fetch: Fetch; keys: { brain: string | null; github: string | null } };
/** The dry run's answer: every verdict, why claims couldn't be read (when they couldn't), and the ticket a run would take. */
export type DryRun = { tickets: number; claimsNote: string | null; taken: string | null; verdicts: Verdict[] };

/**
 * Gathers the facts and applies the rule. Reads only: every request is a GET or a GraphQL query, and none follows a
 * redirect. Claims and pull requests are read only for the tickets that pass the label and board checks, and a
 * branch's PRs only once claims can be read, since a run takes nothing before then and each lookup spends GitHub's
 * limit.
 */
export async function dryRun(cfg: Config, deps: Deps): Promise<DryRun> {
  const board = await readBoard(deps.gql, cfg);
  const rules: Rules = { readyLabelId: board.readyLabelId, handedBackLabelId: board.handedBackLabelId, maintainerId: cfg.maintainerLinearId };
  const candidates = board.tickets.filter((t) => firstReasons(t, rules).length === 0).map((t) => t.identifier);
  const { branches, worktrees } = await readBranches(deps.run, cfg);
  const claimsRead = await readClaims(deps.fetch, cfg, deps.keys.brain, candidates);
  const lookups = new Set<string>();
  if (!("unreadable" in claimsRead)) {
    for (const id of candidates) {
      for (const b of branches) if (mentionsTicket(b.name, id)) lookups.add(b.name);
      for (const w of worktrees) if (w.branch && (mentionsTicket(w.branch, id) || mentionsTicket(w.path, id))) lookups.add(w.branch);
      const read = claimsRead.get(id);
      if (!read || "unreadable" in read) continue;
      for (const c of read.claims) {
        const b = c.state === "released" || c.piece ? null : branchOfLabel(c.label, id);
        if (b) lookups.add(b);
      }
    }
  }
  const prs = new Map<string, BranchPrs | null>();
  for (const b of lookups) prs.set(b, await readBranchPrs(deps.fetch, cfg, deps.keys.github, b));
  const openPrs = candidates.length ? await readOpenPrs(deps.fetch, cfg, deps.keys.github) : [];
  const facts: Facts = {
    branches,
    worktrees,
    openPrs,
    trustedAuthors: [cfg.repo.split("/")[0], ...(cfg.botRepo ? [cfg.botRepo.split("/")[0]] : [])],
    claims: (id) => ("unreadable" in claimsRead ? { unreadable: claimsRead.unreadable } : (claimsRead.get(id) ?? { unreadable: "not read" })),
    prsOfBranch: (b) => (prs.has(b) ? (prs.get(b) ?? null) : undefined),
  };
  const verdicts = select(board.tickets, facts, rules);
  return { tickets: board.tickets.length, claimsNote: "unreadable" in claimsRead ? claimsRead.unreadable : null, taken: verdicts.find((v) => v.take)?.identifier ?? null, verdicts };
}

/** The dry run as text: a line per ticket, its reasons under it, and what a run would take. Untrusted text is shown on one line, made printable. */
export function render(r: DryRun, cfg: Config): string {
  const lines = [
    "Agent runner, dry run (SMD-4087 cut 1): reads only, claims nothing, writes nothing.",
    `${r.tickets} open ticket(s) labelled agent-ready in ${shown(cfg.team, 40)}'s projects of the initiative "${shown(cfg.initiative, 120)}".`,
  ];
  if (r.claimsNote) lines.push(`Claims can't be read: ${shown(r.claimsNote, 300)}.`);
  for (const v of r.verdicts) {
    lines.push(`  ${shown(v.identifier, 20).padEnd(10)} ${v.take ? "take" : "skip"}  ${shown(v.title, 120)}`);
    for (const why of v.reasons) lines.push(`      - ${shown(why, 300)}`);
  }
  lines.push(r.taken ? `A run would take ${shown(r.taken, 20)}.` : `A run would take nothing${r.claimsNote ? ", since claims can't be read" : r.tickets ? ": every ticket has a reason above" : ""}.`);
  return lines.join("\n");
}

/** Bun.spawn's shape, the part used: a stub stands in for it in the self-check. */
export type SpawnImpl = (cmd: string[], opts: { stdout: "pipe"; stderr: "pipe"; env: Record<string, string>; cwd?: string }) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };

/** Runs a command with gitEnv's environment (never the caller's), in the directory given, and ends it after `timeoutMs`. */
export function spawner(home: string, spawnImpl: SpawnImpl, timeoutMs = 60_000): Runner {
  return async (cmd, opts) => {
    const p = spawnImpl(cmd, { stdout: "pipe", stderr: "pipe", env: gitEnv(home), ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** fetch with SAFE_REQUEST's options over whatever a caller passes: Linear's client, and every reader, are handed this. */
export function noRedirect(fetchImpl: Fetch): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => fetchImpl(String(url), { ...init, ...SAFE_REQUEST })) as typeof fetch;
}

/** Everything the dry run takes from its process, so the self-check can run the whole of it on stubs. */
export type Io = {
  argv: string[];
  env: Record<string, string | undefined>;
  runnerDir: string;
  /** The home a `~/` in the config means. */
  home: string;
  /** Where the temporary home git runs with is made, and removed again. */
  tmpRoot: string;
  platform: string;
  /** The flags Bun was started with (process.execArgv): START_FLAGS must be among them. */
  execArgv: string[];
  /** The working directory a relative --config is read from. */
  cwd: string;
  fetch: Fetch;
  spawnImpl: SpawnImpl;
  out: (s: string) => void;
  err: (s: string) => void;
};

/**
 * The dry run from its arguments to its exit code. Bun's start, the environment, the runner's directory, the config
 * and every key are checked before any request; then the facts are read and the verdicts printed, with "<a key>" in
 * place of any key's value an answer carried. 0 once printed, 1 when a read fails, 2 for anything refused.
 */
export async function main(io: Io): Promise<number> {
  const refuse = (message: string): number => {
    io.err(`dry-run: ${shown(message, 400)}`);
    return 2;
  };
  const opts = parseArgs(io.argv);
  if (opts.error) return refuse(opts.error);
  if (opts["--self-check"]) return selfCheck();
  if (opts["--help"]) {
    io.out(`${START} [--config <path>] [--json] | bun scripts/agent-runner/dry-run.ts --self-check   (the README beside this script has the config)`);
    return 0;
  }
  if (!START_FLAGS.every((f) => io.execArgv.includes(f))) return refuse(`start it as ${START}: Bun otherwise reads a .env and a bunfig.toml, which can load code, from the working directory`);
  const risky = riskyEnv(io.env);
  if (risky.length) return refuse(`the environment sets ${risky.join(", ")}, which could reroute a request, change what TLS trusts, log headers or load code: unset it for the run`);
  const dirProblem = privateDirProblem(io.runnerDir);
  if (dirProblem) return refuse(dirProblem);
  const configPath = resolve(io.cwd, typeof opts["--config"] === "string" ? opts["--config"] : join(io.runnerDir, "config.json"));
  let cfg: Config;
  let keys: { linear: string | null; brain: string | null; github: string | null };
  try {
    const text = readOwnedFile(configPath, false);
    if (text === null) return refuse(`no config at ${configPath}: the README beside this script says what it holds`);
    const parsed = parseConfig(text, io.home);
    if ("error" in parsed) return refuse(`${configPath}: ${parsed.error}`);
    cfg = parsed;
    keys = { linear: readKey(io.runnerDir, "linear"), brain: readKey(io.runnerDir, "brain"), github: readKey(io.runnerDir, "github") };
  } catch (e) {
    return refuse((e as Error).message);
  }
  if (!keys.linear) return refuse(`there is no Linear key at ${join(io.runnerDir, KEY_FILES.linear)} (SMD-4089 gives the runner its own)`);
  const mask = masker([keys.linear, keys.brain, keys.github]);
  const home = mkdtempSync(join(io.tmpRoot, "agent-runner-git-"));
  try {
    const run = spawner(home, io.spawnImpl);
    if (io.platform === "darwin") {
      const paths = [io.runnerDir, configPath, ...Object.values(KEY_FILES).map((f) => join(io.runnerDir, f))].filter((p) => {
        try {
          lstatSync(p);
          return true;
        } catch {
          return false;
        }
      });
      const ls = await run(["/bin/ls", "-lde", ...paths], { cwd: "/" });
      if (ls.code !== 0) return refuse(`the access control lists of the runner's files can't be read (ls exited ${ls.code})`);
      if (hasAclEntry(ls.stdout)) return refuse("an access control list is on the runner's directory, config or a key, and one can grant what the mode doesn't: remove it (chmod -N)");
    }
    const safeFetch = noRedirect(io.fetch);
    const result = await dryRun(cfg, { gql: linearClient(keys.linear, safeFetch, { timeoutMs: 30_000 }), run, fetch: safeFetch, keys: { brain: keys.brain, github: keys.github } });
    const masked = JSON.parse(mask(JSON.stringify(result))) as DryRun;
    io.out(opts["--json"] ? safeJson(masked) : render(masked, cfg));
    return 0;
  } catch (e) {
    io.err(`dry-run: a read failed: ${shown(mask((e as Error).message), 400)}`);
    return 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── Self-check: every rule and reader on fixtures, offline ─────────────────────────────────────────────────────

const MAINTAINER = "0f0e0d0c-0b0a-4908-8706-050403020100";
const RULES: Rules = { readyLabelId: "L-ready", handedBackLabelId: "L-back", maintainerId: MAINTAINER };
const T0 = "2026-11-02T00:00:00.000Z";
const at = (iso: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  createdAt: iso, updatedAt: iso, actorId: MAINTAINER, botActor: null, addedLabelIds: [], updatedDescription: false, titleChanged: false, ...over,
});
const add = (iso = T0, over: Partial<HistoryEntry> = {}): HistoryEntry => at(iso, { addedLabelIds: ["L-ready"], ...over });
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  identifier: "SMD-100", title: "A low-level ticket", priority: 3, createdAt: "2026-11-01T00:00:00.000Z", stateType: "backlog", stateName: "Backlog",
  assigneeId: null, delegateId: null, labelIds: ["L-ready"], history: [add()], historyComplete: true, blockers: [], blockersComplete: true, ...over,
});
const claim = (over: Partial<Claim> = {}): Claim => ({ id: "c1", issue: "SMD-100", piece: null, holder: "codex", label: "codex@laptop michaelharris/smd-100-x", state: "live", expiresAt: "2026-11-07T00:00:00.000Z", ...over });
const facts = (over: Partial<Facts> = {}, claims: ClaimsRead = { claims: [], truncated: false }, prs: Record<string, BranchPrs> = {}): Facts => ({
  branches: [], worktrees: [], openPrs: [], trustedAuthors: ["mharris-sgymd"], claims: () => claims, prsOfBranch: (b) => prs[b] ?? null, ...over,
});
const merged = (head: string): BranchPrs => ({ open: false, merged: true, closedHeads: [head] });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const throws = async (f: () => unknown, has: string, hasNot?: string): Promise<boolean> => {
  try {
    await f();
    return false;
  } catch (e) {
    const m = (e as Error).message;
    return m.includes(has) && (hasNot === undefined || !m.includes(hasNot));
  }
};
const stream = (s: string) => new Response(s).body as ReadableStream<Uint8Array>;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** The three queries as last reviewed. A stub can't tell a field the query no longer selects, so a change to a query must change its hash here. */
const QUERY_HASHES = {
  board: "d3e265a89c25922684e69f7d7772d5d12a9856cf6b78a15eb8afe8b4b2ae63f2",
  initiative: "99b069c290b70b50aa83a40d0c104e3e97f5e8579685c8894777e3bc39148901",
  labels: "1ea985ef8b6ff599efda4133e00676ad274582dceaab500c2219dceb821f3460",
};

async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  /** One case. Its check runs inside, so a throw fails this case by name and the cases after it still run. */
  const ok = async (check: () => unknown, what: string): Promise<boolean> => {
    let pass = false;
    let note = "";
    try {
      pass = Boolean(await check());
    } catch (e) {
      note = ` (it threw: ${shown(String((e as Error)?.message ?? e), 160)})`;
    }
    if (pass) passed++;
    else failed++;
    console.log(`  ${pass ? "✓" : "✗"} ${what}${note}`);
    return pass;
  };
  /** A group of cases. A throw in its setup fails the group by name, and the next group still runs. */
  const section = async (name: string, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: its setup threw (${shown(String((e as Error)?.message ?? e), 160)})`);
    }
  };
  const chr = (cp: number) => String.fromCodePoint(cp);
  const esc = chr(0x1b);
  const head = "aaaa1111";
  const base = { initiative: "Initiative", maintainerLinearId: MAINTAINER, mainCheckout: "~/src/repo" };
  const conf = (over: Record<string, unknown>) => parseConfig(JSON.stringify({ ...base, ...over }), "/home/x");
  const cfg = conf({ restUrl: "http://127.0.0.1:8010/api", botRepo: "bot-user/OB1" }) as Config;
  const noUrl = conf({}) as Config;
  const issue = (over: Record<string, unknown> = {}) => ({
    identifier: "SMD-9", title: "t", priority: 2, createdAt: "2026-11-01T00:00:00.000Z", state: { name: "Backlog", type: "backlog" }, assignee: null, delegate: null, labelIds: ["L-ready"],
    inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] as unknown[] },
    history: { pageInfo: { hasNextPage: false }, nodes: [{ createdAt: T0, updatedAt: T0, actorId: MAINTAINER, botActor: null, addedLabelIds: ["L-ready"], updatedDescription: false, toTitle: null }] as unknown[] },
    ...over,
  });

  await section("options and config", async () => {
    await ok(() => parseArgs(["--config", "a.json", "--json"])["--config"] === "a.json" && parseArgs(["--config=b.json"])["--config"] === "b.json", "values by space and by =");
    await ok(() => !!parseArgs(["--configs", "x"]).error && !!parseArgs(["--config"]).error && !!parseArgs(["--json=1"]).error && !!parseArgs(["constructor"]).error && !!parseArgs(["constructor", "x"]).error && !!parseArgs(["toString"]).error, "an unknown option, a missing value, a flag with a value and a prototype name, with a value or without, are refused");
    const good = conf({});
    await ok(() => !("error" in good) && good.mainCheckout === "/home/x/src/repo" && good.team === "SMD" && good.repo === "MHarris-SgyMd/OB1" && good.restUrl === null && good.botRepo === null && good.initiative === "Initiative" && good.maintainerLinearId === MAINTAINER, "a config fills its defaults and expands a ~/ path");
    await ok(() => ["initiative", "maintainerLinearId", "mainCheckout"].every((k) => {
      const c: Record<string, unknown> = { ...base };
      delete c[k];
      const r = parseConfig(JSON.stringify(c), "/h");
      return "error" in r && r.error.includes(k);
    }) && "error" in conf({ extra: 1 }) && "error" in conf({ readyLabel: "Bug" }) && "error" in conf({ linearKeyFile: "/x" }), "each required key is required, and unknown ones are refused: the labels and key paths are not config");
    const minimal = `"initiative": "I", "maintainerLinearId": "${MAINTAINER}", "mainCheckout": "/r"`;
    await ok(() => "error" in parseConfig(`{"constructor": "x", ${minimal}}`, "/h") && "error" in parseConfig(`{"__proto__": {"x": 1}, ${minimal}}`, "/h") && "error" in parseConfig(`{"toString": "x", ${minimal}}`, "/h") && !("error" in parseConfig(`{${minimal}}`, "/h")), "a prototype name is no config key");
    const secretName = parseConfig(`{"lin_api_${"s".repeat(20)}": 1, ${minimal}}`, "/h");
    await ok(() => "error" in secretName && !secretName.error.includes("lin_api_") && secretName.error.includes("1 key(s)"), "an unknown key is counted, not named");
    const notJson = parseConfig("lin_api_" + "s".repeat(20), "/h");
    await ok(() => "error" in notJson && notJson.error === "the config is not JSON", "a config that is no JSON is refused without echoing what it held");
    await ok(() => ["not a repo", "../..", "a b/c", "a/b/c", "a/", "/b"].every((r) => "error" in conf({ repo: r })) && "error" in conf({ botRepo: "a/." }) && "error" in conf({ team: 7 }) && "error" in conf({ mainCheckout: "  " }) && !("error" in conf({ repo: "a-b.c_d/e-f.g_h" })), "a bad repo, a dot segment, a non-string and a blank value are refused, and a repo of the allowed characters is taken");
    const badRepo = conf({ repo: "evil/../x" });
    await ok(() => "error" in badRepo && !badRepo.error.includes("evil"), "a refused repo isn't echoed");
    await ok(() => "error" in conf({ maintainerLinearId: "<the maintainer's Linear user id>" }) && "error" in conf({ maintainerLinearId: "u1" }) && !("error" in conf({ maintainerLinearId: MAINTAINER.toUpperCase() })), "the maintainer's id must be a Linear user id, a UUID");
    const url = (u: string) => conf({ restUrl: u });
    const okUrl = url("http://127.0.0.1:8010/api/");
    await ok(() => !("error" in okUrl) && okUrl.restUrl === "http://127.0.0.1:8010/api" && !("error" in url("https://brain.example.com/api")) && !("error" in url("http://localhost:8010/api")) && !("error" in url("http://[::1]:8010/api")), "a loopback http URL and an https one are taken, the trailing slash dropped");
    await ok(() => ["http://127.0.0.1:8010/api?key=x", "http://u:p@127.0.0.1/api", "http://127.0.0.1/api#f", "file:///etc", "ftp://127.0.0.1/api", "http://10.0.0.5:8010/api", "not a url"].every((u) => "error" in url(u)), "a URL with a query, credentials or a fragment, a non-http URL, plain http off loopback, and no URL are refused");
  });

  await section("the environment and access lists", async () => {
    const mustCatch = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "SOCKS_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_OPTIONS", "SSL_CERT_FILE", "SSL_CERT_DIR", "BUN_CONFIG_VERBOSE_FETCH", "BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_PRELOAD", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"];
    await ok(() => mustCatch.every((k) => riskyEnv({ [k]: "x" }).join() === k), "each proxy, TLS, logging and code-loading setting is caught: Bun's, Node's, OpenSSL's, the loader's and every proxy");
    await ok(() => riskyEnv({ PATH: "/bin", HOME: "/h", LANG: "C", NO_PROXY: "*", no_proxy: "*", BUN_INSTALL: "/b", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HTTP_PROXY: "" }).length === 0 && riskyEnv({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/tmp/c" }).join() === "BUN_RUNTIME_TRANSPILER_CACHE_PATH" && riskyEnv({ SSL_CERT_FILE: "/x", BUN_OPTIONS: "y" }).join() === "BUN_OPTIONS,SSL_CERT_FILE", "Bun's install path, the no-proxy list, the transpiler cache turned off and empty values pass, and the rest are named in order");
    await ok(() => hasAclEntry("drwx------+ 2 me staff 64 Nov 6 /d\n 0: group:everyone allow list,search\n") && hasAclEntry("-rw-------+ 1 me staff 65 /k\n 12: user:x deny read\n") && !hasAclEntry("drwx------  2 me staff 64 Nov 6 /d\n-rw-------  1 me staff 65 Nov 6 /d/brain.key\n"), "an access list entry in ls -lde's output is found, whatever it allows or denies, and plain modes aren't one");
  });

  await section("files and keys", async () => {
    const flagsOk = (OPEN_FLAGS & constants.O_NOFOLLOW) !== 0 && (OPEN_FLAGS & constants.O_NONBLOCK) !== 0 && (OPEN_FLAGS & (constants.O_WRONLY | constants.O_RDWR)) === 0;
    await ok(() => flagsOk, "the runner's files are opened read-only, never through a link and never waiting on a pipe");
    const dir = mkdtempSync(join(tmpdir(), "agent-runner-check-"));
    try {
      chmodSync(dir, 0o700);
      await ok(() => privateDirProblem(dir) === null, "a private directory of the user's holds keys");
      const open = join(dir, "open");
      mkdirSync(open, { mode: 0o755 });
      chmodSync(open, 0o755);
      const groupDir = join(dir, "group");
      mkdirSync(groupDir, { mode: 0o750 });
      chmodSync(groupDir, 0o750);
      const linkedDir = join(dir, "linked");
      symlinkSync(dir, linkedDir);
      const plainFile = join(dir, "plain-file");
      writeFileSync(plainFile, "x");
      await ok(() => (privateDirProblem(open) ?? "").includes("chmod 700") && (privateDirProblem(groupDir) ?? "").includes("chmod 700") && (privateDirProblem(linkedDir) ?? "").includes("not a link") && (privateDirProblem(plainFile) ?? "").includes("not a link") && (privateDirProblem(join(dir, "none")) ?? "").includes("no runner directory"), "an open directory, one its group can read, a link, a file and a missing one hold none");
      const brain = "ab".repeat(32);
      writeFileSync(join(dir, "brain.key"), `${brain}\n`, { mode: 0o600 });
      chmodSync(join(dir, "brain.key"), 0o600);
      await ok(() => readKey(dir, "brain") === brain && readKey(dir, "linear") === null, "a key of its shape is read, and a missing one is no key");
      writeFileSync(join(dir, "linear.key"), "not-a-linear-key-but-a-secret\n", { mode: 0o600 });
      await ok(() => throws(() => readKey(dir, "linear"), "right shape", "not-a-linear-key"), "a value not of the key's shape is refused, and the message doesn't show it");
      rmSync(join(dir, "linear.key"));
      chmodSync(join(dir, "brain.key"), 0o644);
      await ok(() => throws(() => readKey(dir, "brain"), "chmod 600"), "a key others can read is refused");
      chmodSync(join(dir, "brain.key"), 0o640);
      await ok(() => throws(() => readKey(dir, "brain"), "chmod 600"), "a key its group can read is refused");
      chmodSync(join(dir, "brain.key"), 0o400);
      await ok(() => readKey(dir, "brain") === brain, "a key only its owner can read, read-only, is read");
      chmodSync(join(dir, "brain.key"), 0o600);
      linkSync(join(dir, "brain.key"), join(dir, "brain.hard"));
      await ok(() => throws(() => readKey(dir, "brain"), "other links"), "a key with another hard link is refused");
      rmSync(join(dir, "brain.hard"));
      writeFileSync(join(dir, "big.key"), "x".repeat(70_000), { mode: 0o600 });
      await ok(() => throws(() => readOwnedFile(join(dir, "big.key"), true), "too large"), "a file larger than a key or a config can be is refused");
      const elsewhere = join(dir, "elsewhere");
      writeFileSync(elsewhere, `${brain}\n`, { mode: 0o600 });
      rmSync(join(dir, "brain.key"));
      symlinkSync(elsewhere, join(dir, "brain.key"));
      await ok(() => throws(() => readKey(dir, "brain"), "is a link"), "a key that is a link is refused, not followed");
      rmSync(join(dir, "brain.key"));
      mkdirSync(join(dir, "brain.key"));
      await ok(() => throws(() => readKey(dir, "brain"), "not a regular file"), "a key that is a directory is refused");
      rmSync(join(dir, "brain.key"), { recursive: true });
      if (flagsOk) {
        const fifo = Bun.spawnSync(["/usr/bin/mkfifo", join(dir, "brain.key")]);
        await ok(async () => fifo.exitCode === 0 && (await throws(() => readKey(dir, "brain"), "not a regular file")), "a key that is a pipe is refused without waiting on it");
      } else await ok(() => false, "a key that is a pipe is refused without waiting on it (not run: the open flags would wait on it)");
      const cfgFile = join(dir, "config.json");
      writeFileSync(cfgFile, "{}", { mode: 0o644 });
      chmodSync(cfgFile, 0o644);
      await ok(() => readOwnedFile(cfgFile, false) === "{}", "a config others can read, but not write, is read");
      chmodSync(cfgFile, 0o664);
      await ok(() => throws(() => readOwnedFile(cfgFile, false), "written by others"), "a config its group can write is refused");
      chmodSync(cfgFile, 0o666);
      await ok(() => throws(() => readOwnedFile(cfgFile, false), "written by others"), "a config others can write is refused");
      chmodSync(cfgFile, 0o644);
      linkSync(cfgFile, join(dir, "config.hard"));
      await ok(() => readOwnedFile(cfgFile, false) === "{}", "a config with another hard link is read: only a key must have one link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await ok(() => KEY_SHAPES.linear.test("lin_api_" + "A1b2".repeat(10)) && KEY_SHAPES.linear.test("lin_oauth_" + "c".repeat(20)) && KEY_SHAPES.github.test("ghp_" + "a".repeat(36)) && KEY_SHAPES.github.test("github_pat_" + "b_".repeat(20)) && !KEY_SHAPES.brain.test("AB".repeat(32)) && !KEY_SHAPES.linear.test("lin_api_short") && !KEY_SHAPES.linear.test(`lin_api_${"a".repeat(20)}\nX-Evil: 1`), "the key shapes: Linear's, GitHub's, and the brain's lowercase hex, with no room for a second header line");
  });

  await section("untrusted text on a terminal and in the JSON", async () => {
    const hidden = [0x1b, 0x07, 0x7f, 0x9b, 0x202e, 0x2066, 0x2028, 0x2029, 0x200b, 0xfeff, 0x00ad, 0x3164, 0x115f, 0xffa0, 0xfe0f, 0x2800, 0xe000, 0x0378, 0xe0041, 0xf0000];
    const hostile = `ok ${hidden.map(chr).join("x")}\n  SMD-999    take  forged`;
    const shownText = printable(hostile);
    await ok(() => hidden.every((cp) => !shownText.includes(chr(cp)) && shownText.includes(`<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`)) && !shownText.includes("\n"), "printable shows controls, DEL, C1, bidi, isolates, separators, zero-width, fillers, variation selectors, the braille blank, private-use, unassigned and tag characters as <U+XXXX>");
    await ok(() => printable("Plain — text, ✓ é 漢字 😀") === "Plain — text, ✓ é 漢字 😀", "ordinary text, dashes, marks, accents, CJK and emoji pass printable unchanged");
    await ok(() => shown(`a${" ".repeat(61)}b`, 120) === "a b" && shown("a\t\n\r b", 120) === "a b" && shown("x".repeat(200), 120).length === 120 && shown("x".repeat(200), 120).endsWith("…") && [...shown("😀".repeat(200), 120)].length === 120, "shown closes whitespace runs and cuts long text by code points");
    const js = safeJson({ t: hostile });
    await ok(() => JSON.parse(js).t === hostile && hidden.filter((cp) => cp > 0x1f).every((cp) => !js.includes(chr(cp))) && !js.includes(esc) && js.includes(`${BACKSLASH}udb80${BACKSLASH}udc00`), "the JSON escapes every hidden code point, astral ones as surrogate pairs, and reads back the same");
    const forged = render({ tickets: 1, claimsNote: `tier ${esc}[2J`, taken: null, verdicts: [{ identifier: "SMD-1", title: `t${" ".repeat(61)}  SMD-999    take  x\n  SMD-998    take  y`, take: false, reasons: [`r${esc}[1A`, `pad${chr(0x2800).repeat(70)}SMD-997 take z`] }] }, cfg);
    await ok(() => !forged.split("\n").some((l) => /^\s*SMD-99[789]/.test(l)) && !forged.includes(esc) && !forged.includes(chr(0x2800)) && forged.includes("<U+001B>[2J"), "a title, reason or claims note can't forge a line, pad itself out to wrap into one, or reach the terminal raw");
    const masked = masker(["lin_api_" + "m".repeat(20), null, "ab".repeat(32)]);
    await ok(() => masked(`x lin_api_${"m".repeat(20)} y ${"ab".repeat(32)}${"ab".repeat(32)}`) === "x <a key> y <a key><a key>" && masker([null])("plain") === "plain", "a key's value, wherever it appears, is masked");
  });

  await section("ticket ids and labels' branches", async () => {
    await ok(() => mentionsTicket("michaelharris/smd-4087-cut1", "SMD-4087") && mentionsTicket("SMD-4087: the runner", "SMD-4087") && mentionsTicket("fix (smd-4087)", "SMD-4087") && mentionsTicket("ab2-12-x", "AB2-12") && mentionsTicket("fix_smd-4087", "SMD-4087") && mentionsTicket("smd-4087fix", "SMD-4087"), "a branch, a title, a parenthesis, an underscore before it, letters after it and a team key with a digit name the ticket");
    await ok(() => !mentionsTicket("smd-40871-x", "SMD-4087") && !mentionsTicket("xsmd-4087", "SMD-4087") && !mentionsTicket("1smd-4087", "SMD-4087") && !mentionsTicket("smd-4087", "SMD-408") && !mentionsTicket("smd-3336-3173-x", "SMD-3173"), "a longer id, a glued prefix, a shorter id and a joint branch's second number do not");
    await ok(() => branchOfLabel("codex@laptop a/b michaelharris/smd-1-x", "SMD-1") === "michaelharris/smd-1-x" && branchOfLabel("codex@laptop michaelharris/smd-1-old michaelharris/smd-1-x", "SMD-1") === "michaelharris/smd-1-x" && branchOfLabel("codex@laptop michaelharris/smd-1-x (in ~/w/y)", "SMD-1") === "michaelharris/smd-1-x" && branchOfLabel("codex@laptop (michaelharris/smd-1-x),", "SMD-1") === "michaelharris/smd-1-x" && branchOfLabel("codex@laptop michaelharris/smd-2-x", "SMD-1") === null && branchOfLabel(null, "SMD-1") === null && branchOfLabel("no branch here", "SMD-1") === null, "a claim label's branch is its last word with a slash that names the ticket, without the punctuation around it");
  });

  await section("the label rule", async () => {
    const lr = (history: HistoryEntry[], over: Partial<Ticket> = {}) => labelReasons(ticket({ history, ...over }), RULES);
    const T1 = "2026-11-03T00:00:00.000Z";
    const T2 = "2026-11-04T00:00:00.000Z";
    await ok(() => lr([add()]).length === 0, "the label, added by the maintainer directly with nothing written since, passes");
    await ok(() => lr([add()], { labelIds: [] }).includes("not labelled agent-ready") && lr([add()], { labelIds: ["L-other"] }).includes("not labelled agent-ready"), "a ticket without the label is refused, whatever its history");
    await ok(() => lr([add(T0, { actorId: "someone" })]).some((r) => r.includes("added by someone, not the maintainer")), "a label someone else added is refused");
    await ok(() => lr([add(T0, { actorId: null, botActor: "Linear" })]).some((r) => r.includes("integration or automation")) && lr([add(T0, { botActor: "an assistant" })]).some((r) => r.includes("through an assistant, not by the maintainer directly")), "a label an automation added, or a bot on the maintainer's behalf, is refused");
    await ok(() => lr([add(), at(T1, { actorId: "someone", updatedDescription: true })]).some((r) => r.includes("description changed")), "a description edited after the label is refused");
    await ok(() => lr([add(), at(T1, { updatedDescription: true })]).some((r) => r.includes("description changed")), "the maintainer's own later edit voids the label too");
    await ok(() => lr([add(), at("2026-11-01T12:00:00.000Z", { updatedAt: T1, actorId: "someone", updatedDescription: true })]).some((r) => r.includes("description changed")), "an edit entry made before the label but updated after it is refused");
    await ok(() => lr([add(T0, { updatedAt: T2 }), at(T1, { actorId: "someone", updatedDescription: true })]).some((r) => r.includes("description changed")), "an edit between an add's entry and Linear's later update of that entry still counts as after the add");
    await ok(() => lr([add(), at(T1, { titleChanged: true })]).some((r) => r.includes("title changed")), "a title changed after the label is refused");
    await ok(() => lr([add(T0, { updatedDescription: true })]).some((r) => r.includes("description changed in the entry of agent-ready's last add")) && lr([add(T0, { titleChanged: true })]).some((r) => r.includes("title changed")), "one entry that adds the label and changes the text is refused, the maintainer's own included");
    await ok(() => lr([add(), at(T0, { updatedDescription: true })]).some((r) => r.includes("description changed")), "an edit at the very time of the add counts as after it");
    await ok(() => lr([add(), at(T1, { actorId: "someone" }), at(T1, { actorId: null, botActor: "GitHub" })]).length === 0, "a later change to anything but the text and the label, by anyone, leaves the label standing");
    await ok(() => lr([add("2026-11-02T00:02:00.000Z"), add("2026-11-02T00:00:00.000Z", { updatedAt: "2026-11-02T00:05:00.000Z", actorId: "someone" })]).some((r) => r.includes("not the maintainer")), "an older entry updated with someone else's add after the maintainer's is refused");
    const tieA = add(T0, { actorId: "someone" });
    const tieB = add(T0);
    await ok(() => lr([tieA, tieB]).some((r) => r.includes("not the maintainer")) && lr([tieB, tieA]).some((r) => r.includes("not the maintainer")), "two adds at one time are both checked, whatever their order");
    await ok(() => lr([add(), at(T1, { updatedDescription: true }), add(T2)]).length === 0, "the label added again after the edit passes");
    await ok(() => lr([]).some((r) => r.includes("shows no one adding")) && lr([at(T0)]).some((r) => r.includes("shows no one adding")), "a label no history entry added is refused");
    await ok(() => lr([add()], { historyComplete: false }).some((r) => r.includes("runs past")), "a history read only in part is refused");
    await ok(() => lr([add(T0), at(T1, { createdAt: "not a time" })]).some((r) => r.includes("time the dry run can't read")) && lr([add(T0), at(T1, { updatedAt: "not a time" })]).some((r) => r.includes("time the dry run can't read")) && lr([add("not a time", { updatedAt: T0 })]).some((r) => r.includes("time the dry run can't read")), "a history time that can't be read is refused, created or updated, on an add or another entry");
    await ok(() => lr([add()], { labelIds: ["L-ready", "L-back"] }).some((r) => r.includes("handed back")), "a ticket handed back to a person is refused");
  });

  await section("the board", async () => {
    await ok(() => boardReasons(ticket()).length === 0, "Backlog, unassigned, undelegated, unblocked and plain passes");
    await ok(() => boardReasons(ticket({ stateType: "unstarted", stateName: "Todo" })).includes("in Todo, not Backlog") && boardReasons(ticket({ stateType: "triage", stateName: "Triage" })).length === 1 && boardReasons(ticket({ stateName: "Icebox" })).some((r) => r.includes("Icebox")) && boardReasons(ticket({ stateType: "unstarted", stateName: "Backlog" })).length === 1, "Todo, Triage, a backlog state not named Backlog, and a state named Backlog of another type are refused");
    await ok(() => boardReasons(ticket({ assigneeId: "u" })).includes("assigned to someone") && boardReasons(ticket({ delegateId: "a" })).includes("delegated to an agent"), "an assignee and a delegate are refused");
    await ok(() => boardReasons(ticket({ blockers: [{ identifier: "SMD-1", stateType: "completed" }, { identifier: "SMD-2", stateType: "canceled" }, { identifier: "SMD-3", stateType: "duplicate" }] })).length === 0, "blockers Done, Canceled or a Duplicate no longer block");
    await ok(() => ["started", "unstarted", "backlog", "triage", "something-new"].every((s) => boardReasons(ticket({ blockers: [{ identifier: "SMD-2", stateType: s }] })).includes("blocked by SMD-2")), "a blocker in any other state blocks: started, Todo, Backlog, Triage or one the rule doesn't know");
    await ok(() => boardReasons(ticket({ blockersComplete: false })).some((r) => r.includes("more relations")), "relations read only in part are refused");
    await ok(() => [0xe0041, 0x200b, 0x3164, 0x2800, 0xe000, 0x202e].every((cp) => boardReasons(ticket({ title: `Fix a typo${chr(cp)}` })).some((r) => r.includes("don't show"))), "a title holding a tag, zero-width, filler, blank, private-use or bidi character is refused");
  });

  await section("nobody's work", async () => {
    const w = workReasons;
    await ok(() => w("SMD-100", facts()).length === 0, "no branch, worktree, PR or claim passes");
    await ok(() => w("SMD-100", facts({ branches: [{ name: "michaelharris/smd-100-x", sha: head }, { name: "main", sha: "b" }] })).join() === "branch michaelharris/smd-100-x (no PR)", "a branch naming the ticket, with no PR, holds it, and says so");
    await ok(() => w("SMD-100", facts({ branches: [{ name: "smd-100-x", sha: head }] }, undefined, { "smd-100-x": merged(head) })).length === 0 && w("SMD-100", facts({ branches: [{ name: "smd-100-x", sha: head }] }, undefined, { "smd-100-x": { open: false, merged: false, closedHeads: [head] } })).length === 0, "a branch whose PR merged, or closed, at its current commit is done with");
    await ok(() => w("SMD-100", facts({ branches: [{ name: "smd-100-x", sha: "bbbb2222" }] }, undefined, { "smd-100-x": merged(head) })).join() === "branch smd-100-x (no PR of it merged or closed into main at its commit)", "a branch with commits past its merged PR holds it, and says why");
    await ok(() => w("SMD-100", facts({ branches: [{ name: "smd-100-x", sha: head }] }, undefined, { "smd-100-x": { open: true, merged: true, closedHeads: [head] } })).join() === "branch smd-100-x (a PR open)", "a branch with an open PR still holds it");
    await ok(() => w("SMD-100", facts({ branches: [{ name: "smd-100-x", sha: head }], prsOfBranch: () => undefined })).join() === "branch smd-100-x (its PRs not looked up)", "a branch whose PRs weren't looked up says so, not that it is unmerged");
    await ok(() => w("SMD-100", facts({ branches: [{ name: "smd-100-x", sha: head }, { name: "smd-100-x", sha: "bbbb2222" }, { name: "smd-100-y", sha: head }] }, undefined, { "smd-100-x": merged(head) })).join() === "branches smd-100-x (no PR of it merged or closed into main at its commit), smd-100-y (no PR)", "a branch read twice holds it if one copy isn't done, and two branches are named together");
    await ok(() => w("SMD-100", facts({ worktrees: [{ path: "/w/smd-100-x", branch: null, sha: head }] })).join() === "worktree /w/smd-100-x (detached)" && w("SMD-100", facts({ worktrees: [{ path: "/w/x", branch: "smd-100-y", sha: head }] })).join() === "worktree /w/x (on smd-100-y: no PR)", "a worktree naming it by path or branch holds it, and says why");
    await ok(() => w("SMD-100", facts({ worktrees: [{ path: "/w/x", branch: "smd-100-y", sha: head }] }, undefined, { "smd-100-y": merged(head) })).length === 0, "a worktree on a branch done with at its commit is done with");
    await ok(() => w("SMD-100", facts({ worktrees: [{ path: "/w/x", branch: "smd-100-y", sha: "bbbb2222" }] }, undefined, { "smd-100-y": merged(head) })).length === 1 && w("SMD-100", facts({ worktrees: [{ path: "/w/x", branch: "smd-100-y", sha: null }] }, undefined, { "smd-100-y": merged(head) })).length === 1, "a worktree with commits past its branch's merged PR, or whose commit can't be read, holds it");
    const pr = (over: Partial<Facts["openPrs"][number]>) => facts({ openPrs: [{ number: 7, title: "x", body: "", head: "y", author: "someone", ...over }] });
    await ok(() => w("SMD-100", pr({ head: "fix/smd-100" })).join() === "open PR 7 by someone" && w("SMD-100", pr({ title: "SMD-100: fix" })).length === 1, "an open PR naming it in its head branch or title holds it, whoever wrote it");
    await ok(() => w("SMD-100", pr({ body: "Fixes SMD-100.", author: "MHarris-SgyMd" })).length === 1 && w("SMD-100", pr({ body: "Fixes SMD-100 and SMD-101." })).length === 0, "a PR body naming it holds it only when the maintainer or the bot wrote the PR");
    await ok(() => w("SMD 100", facts()).some((r) => r.includes("no ticket id")), "an id the rule can't match holds the ticket");
    await ok(() => w("SMD-100", facts({}, { unreadable: "no key" })).join() === "claims can't be read: no key", "claims that can't be read are a reason");
    await ok(() => w("SMD-100", facts({}, { claims: [], truncated: true })).some((r) => r.includes("cut at 1000")), "a claim list cut at the cap holds it");
    await ok(() => w("SMD-100", facts({}, { claims: [claim({ piece: "PR 2", state: "lapsed" })], truncated: false })).join() === `a lapsed claim on its piece "PR 2" by codex (codex@laptop michaelharris/smd-100-x)` && w("SMD-100", facts({}, { claims: [claim({ piece: "PR 2", state: "released" })], truncated: false })).length === 0, "an unreleased piece claim holds it, and a released one doesn't");
    await ok(() => w("SMD-100", facts({}, { claims: [claim()], truncated: false })).join() === "a live claim by codex (codex@laptop michaelharris/smd-100-x), until 2026-11-07T00:00:00.000Z", "a live claim holds it, with its holder, label and lease end");
    await ok(() => w("SMD-100", facts({}, { claims: [claim()], truncated: false }, { "michaelharris/smd-100-x": merged(head) })).join() === "a stale live claim by codex (codex@laptop michaelharris/smd-100-x), its PR merged: tell the maintainer" && w("SMD-100", facts({}, { claims: [claim()], truncated: false }, { "michaelharris/smd-100-x": { open: false, merged: false, closedHeads: [head] } })).some((r) => r.includes("its PR closed")), "a live claim whose PR merged or closed still holds it, named stale, with which");
    await ok(() => w("SMD-100", facts({}, { claims: [claim({ state: "lapsed" })], truncated: false })).join() === "a lapsed claim by codex (codex@laptop michaelharris/smd-100-x), never released, with no merged or closed PR found: maybe work paused on another machine" && w("SMD-100", facts({}, { claims: [claim({ state: "lapsed" })], truncated: false }, { "michaelharris/smd-100-x": { open: true, merged: false, closedHeads: [] } })).some((r) => r.includes("its PR open")), "a lapsed claim with no PR, or an open one, holds it");
    await ok(() => w("SMD-100", facts({}, { claims: [claim({ state: "lapsed" })], truncated: false }, { "michaelharris/smd-100-x": { open: true, merged: true, closedHeads: [head] } })).some((r) => r.includes("its PR open")), "a lapsed claim with an open PR beside a merged one still holds it");
    await ok(() => w("SMD-100", facts({}, { claims: [claim({ state: "lapsed" })], truncated: false }, { "michaelharris/smd-100-x": { open: false, merged: false, closedHeads: ["c"] } })).length === 0 && w("SMD-100", facts({}, { claims: [claim({ state: "released" })], truncated: false })).length === 0, "a lapsed claim whose PR closed, and a released one, hold nothing");
    await ok(() => w("SMD-100", facts({}, { claims: [claim({ state: "lapsed", label: "codex@laptop michaelharris/smd-99-x" })], truncated: false }, { "michaelharris/smd-99-x": merged(head) })).length === 1, "a claim whose label names another ticket's branch isn't freed by that branch's PR");
    await ok(() => w("SMD-100", facts({}, { claims: [claim({ state: "paused" })], truncated: false })).join() === "a claim by codex (codex@laptop michaelharris/smd-100-x) in a state the rule doesn't know (paused)", "a claim in an unknown state holds it, and names the state");
  });

  await section("order and the one take", async () => {
    const older = ticket({ identifier: "SMD-1", createdAt: "2026-10-01T00:00:00.000Z" });
    const urgent = ticket({ identifier: "SMD-2", priority: 1, createdAt: "2026-11-05T00:00:00.000Z" });
    const none = ticket({ identifier: "SMD-3", priority: 0, createdAt: "2026-09-01T00:00:00.000Z" });
    const low = ticket({ identifier: "SMD-4", priority: 4, createdAt: "2026-11-06T00:00:00.000Z" });
    const odd = ticket({ identifier: "SMD-5", priority: 7, createdAt: "2026-08-01T00:00:00.000Z" });
    await ok(() => [none, low, ticket(), odd, older, urgent].sort(byPriorityThenAge).map((t) => t.identifier).join() === "SMD-2,SMD-1,SMD-100,SMD-4,SMD-5,SMD-3", "urgent first, low before none, an unknown priority as none, then the oldest first");
    const picked = select([ticket(), older, urgent], facts(), RULES);
    await ok(() => picked.map((v) => `${v.identifier}:${v.take}`).join() === "SMD-2:true,SMD-1:false,SMD-100:false", "only the first ticket that passes is taken, and the verdicts come in the order a run considers them");
    await ok(() => picked.filter((v) => !v.take).every((v) => v.reasons.join() === "a run takes one ticket, and SMD-2 comes first"), "each later ticket that passes is skipped with that reason alone");
    await ok(() => select([ticket()], facts({}, { unreadable: "x" }), RULES).every((v) => !v.take && v.reasons.join() === "claims can't be read: x"), "nothing is taken while claims can't be read");
    const assigned = select([ticket({ assigneeId: "u" })], facts({}, { unreadable: "x" }), RULES)[0];
    await ok(() => assigned.reasons.join() === "assigned to someone" && firstReasons(ticket(), RULES).length === 0, "a ticket failing the label or board checks is skipped for those alone");
    await ok(() => select([ticket({ identifier: "SMD-7", title: "Seven" })], facts(), RULES)[0].title === "Seven", "a verdict carries its ticket's title");
  });

  await section("Linear's issue as the rule reads it, and the queries", async () => {
    const t9 = toTicket(issue({
      title: "Nine", priority: 4, createdAt: "2026-10-09T00:00:00.000Z", state: { name: "Icebox", type: "backlog" }, assignee: { id: "u9" }, delegate: { id: "agent" },
      inverseRelations: { pageInfo: { hasNextPage: true }, nodes: [{ type: "blocks", issue: { identifier: "SMD-8", state: { type: "started" } } }, { type: "related", issue: { identifier: "SMD-7", state: { type: "started" } } }] },
      history: { pageInfo: { hasNextPage: true }, nodes: [
        { createdAt: T0, updatedAt: "2026-11-02T00:00:01.000Z", actorId: null, botActor: { name: null, type: "workflow" }, addedLabelIds: null, updatedDescription: true, toTitle: "New" },
        { createdAt: T0, updatedAt: T0, actorId: "x", botActor: null, addedLabelIds: null, updatedDescription: null, toTitle: null },
        { createdAt: T0, updatedAt: null, actorId: "y", botActor: { name: null, type: null }, addedLabelIds: ["L-ready"], updatedDescription: false, toTitle: null },
      ] },
    }) as never);
    await ok(() => t9.identifier === "SMD-9" && t9.title === "Nine" && t9.priority === 4 && t9.createdAt === "2026-10-09T00:00:00.000Z" && t9.stateName === "Icebox" && t9.stateType === "backlog" && t9.assigneeId === "u9" && t9.delegateId === "agent" && t9.labelIds.join() === "L-ready", "a Linear issue's id, title, priority, age, state, assignee, delegate and labels are read as they are");
    await ok(() => t9.blockers.length === 1 && t9.blockers[0].identifier === "SMD-8" && t9.blockers[0].stateType === "started" && !t9.historyComplete && !t9.blockersComplete, "its blockers are its \"blocks\" relations with their state, and paged connections read as incomplete");
    const [h1, h2, h3] = t9.history;
    await ok(() => h1.updatedDescription && h1.titleChanged && h1.botActor === "workflow" && h1.updatedAt === "2026-11-02T00:00:01.000Z" && h1.actorId === null && !h2.updatedDescription && !h2.titleChanged && h2.addedLabelIds.length === 0 && h2.botActor === null && h2.actorId === "x" && h3.botActor === "a bot" && h3.updatedAt === T0 && h3.addedLabelIds.join() === "L-ready", "a history entry's edit, title change, actor, bot (named or not), labels and later update are read, and empty fields read as none");
    await ok(() => ["team: { key: { eq: $team } }", "labels: { some: { name: { eq: $label } } }", "initiatives: { some: { id: { eq: $initiative } } }", 'state: { type: { nin: ["completed", "canceled", "duplicate"] } }', "after: $after", "inverseRelations(", "labelIds", "botActor", "updatedDescription", "updatedAt", "toTitle", "actorId", "addedLabelIds", "issue { identifier state { type } }"].every((s) => BOARD_QUERY.includes(s)), "the board query filters by team, label, the initiative's id and open states, pages on, and reads what the rule needs");
    await ok(() => sha256(BOARD_QUERY) === QUERY_HASHES.board && sha256(INITIATIVE_QUERY) === QUERY_HASHES.initiative && sha256(LABELS_QUERY) === QUERY_HASHES.labels, "the three queries are exactly the ones reviewed: a field dropped would read as null, so as unassigned or unblocked (change a query, then its hash here)");
  });

  await section("git's output", async () => {
    await ok(() => JSON.stringify(parseLsRemote("abc123\trefs/heads/main\ndef456\trefs/heads/michaelharris/smd-1-x\n\n")) === JSON.stringify([{ name: "main", sha: "abc123" }, { name: "michaelharris/smd-1-x", sha: "def456" }]), "ls-remote's branches and their commits");
    await ok(async () => (await throws(() => parseLsRemote("abc123\trefs/heads/main\nbad line\n"), "can't read")) && (await throws(() => parseLocalBranches("zz main\n"), "can't read")) && (await throws(() => parseWorktrees("HEAD a1\nbranch refs/heads/main\n"), "can't read")), "a line or block git answered that can't be read is an error, not a branch or worktree dropped");
    await ok(() => JSON.stringify(parseLocalBranches("abc123 main\ndef456 smd-1-x\n")) === JSON.stringify([{ name: "main", sha: "abc123" }, { name: "smd-1-x", sha: "def456" }]), "the main checkout's branches and their commits");
    await ok(() => JSON.stringify(parseWorktrees("worktree /r\nHEAD a1\nbranch refs/heads/main\n\nworktree /r/w\nHEAD b2\ndetached\n\nworktree /r/l\nHEAD c3\nbranch refs/heads/smd-1-x\nlocked\n\n")) === JSON.stringify([{ path: "/r", branch: "main", sha: "a1" }, { path: "/r/w", branch: null, sha: "b2" }, { path: "/r/l", branch: "smd-1-x", sha: "c3" }]), "worktrees and their commits, a detached one without a branch, a locked one as any other");
  });

  await section("git's environment, arguments and process", async () => {
    await ok(() => JSON.stringify(gitEnv("/empty")) === JSON.stringify({ PATH: "/usr/bin:/bin", HOME: "/empty", LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }), "git's environment is built from nothing: no credential, agent socket, prompt or config of the maintainer's");
    await ok(() => GIT_SAFE.join(" ") === "-c credential.helper= -c protocol.allow=never -c protocol.https.allow=always -c http.followRedirects=false -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20", "every git call drops the credential helpers, allows https alone, follows no redirect and gives up a stalled transfer");
    const spawned: { cmd: string[]; opts: Parameters<SpawnImpl>[1] }[] = [];
    let killed = false;
    const recorder: SpawnImpl = (cmd, opts) => {
      spawned.push({ cmd, opts });
      return { stdout: stream("out"), stderr: stream("err"), exited: Promise.resolve(3), kill() {} };
    };
    const ran = await spawner("/h", recorder)(["git", "status"], { cwd: "/" });
    await ok(() => ran.stdout === "out" && ran.stderr === "err" && ran.code === 3 && JSON.stringify(spawned[0].opts.env) === JSON.stringify(gitEnv("/h")) && spawned[0].opts.cwd === "/" && spawned[0].cmd.join(" ") === "git status", "the spawner runs the command with gitEnv's environment and the directory given, and answers its output and exit code");
    const hung: SpawnImpl = () => {
      let end: (n: number) => void = () => {};
      const exited = new Promise<number>((r) => (end = r));
      return { stdout: stream(""), stderr: stream(""), exited, kill() { killed = true; end(143); } };
    };
    const timedOut = await Promise.race([spawner("/h", hung, 30)(["git", "ls-remote"]), Bun.sleep(2_000).then(() => null)]);
    await ok(() => killed && timedOut?.code === 143, "the spawner ends a command that runs past its time");
    const realHome = mkdtempSync(join(tmpdir(), "agent-runner-env-"));
    try {
      const shownEnv = await spawner(realHome, Bun.spawn as unknown as SpawnImpl)(["/usr/bin/env"]);
      const names = shownEnv.stdout.split("\n").filter(Boolean).map((l) => l.split("=")[0]).sort();
      await ok(() => names.join() === Object.keys(gitEnv(realHome)).sort().join(), "a real child of the spawner sees gitEnv's settings and nothing else");
    } finally {
      rmSync(realHome, { recursive: true, force: true });
    }
    const passedOn: { url: string; init?: RequestInit }[] = [];
    await noRedirect(async (u, init) => {
      passedOn.push({ url: u, init });
      return json({});
    })("https://api.linear.app/graphql", { method: "POST", body: "{}", redirect: "follow", headers: { A: "b" } });
    const pinit = passedOn[0].init as RequestInit & { verbose?: boolean; tls?: { rejectUnauthorized?: boolean } };
    await ok(() => passedOn[0].url === "https://api.linear.app/graphql" && pinit.redirect === "manual" && pinit.verbose === false && pinit.tls?.rejectUnauthorized === true && pinit.method === "POST" && pinit.body === "{}" && JSON.stringify(pinit.headers) === '{"A":"b"}', "the no-redirect fetch forces no redirect, no logging and checked TLS, and keeps the request");
  });

  await section("the readers, on stubs", async () => {
    const asked: string[] = [];
    const recordAll: Fetch = async (u) => {
      asked.push(u);
      return json({ tier: "stable", claims: [], truncated: false });
    };
    await ok(async () => {
      const noUrlRead = await readClaims(recordAll, noUrl, "k", ["SMD-1"]);
      const noKeyRead = await readClaims(recordAll, cfg, null, ["SMD-1"]);
      return "unreadable" in noUrlRead && noUrlRead.unreadable.includes("no REST URL") && "unreadable" in noKeyRead && noKeyRead.unreadable.includes("no brain key") && asked.length === 0;
    }, "claims can't be read without a REST URL or a key, and nothing is sent");
    const answering = (body: Response): Fetch => async () => body;
    await ok(async () => "unreadable" in (await readClaims(answering(json({ tier: "canary" })), cfg, "k", ["SMD-1"])) && "unreadable" in (await readClaims(answering(json({ tier: null })), cfg, "k", ["SMD-1"])) && "unreadable" in (await readClaims(answering(json({})), cfg, "k", ["SMD-1"])), "a brain whose tier is another, unset or missing is refused");
    await ok(async () => {
      const reflected = await readClaims(answering(new Response("k-reflected not json", { status: 200 })), cfg, "k", ["SMD-1"]);
      return "unreadable" in reflected && !reflected.unreadable.includes("k-reflected");
    }, "a brain answer that isn't JSON is a reason that doesn't quote it");
    const stable = (claims: Response): Fetch => async (u) => {
      asked.push(u);
      return u === "http://127.0.0.1:8010/api/v1/brain" ? json({ tier: "stable" }) : claims;
    };
    await ok(async () => "unreadable" in (await readClaims(stable(new Response("", { status: 404 })), cfg, "k", ["SMD-1"])), "a brain with no claim operations is said so");
    asked.length = 0;
    await ok(async () => {
      const readOk = await readClaims(stable(json({ claims: [claim()], truncated: true })), cfg, "k", ["SMD-1"]);
      return !("unreadable" in readOk) && (readOk.get("SMD-1") as { claims: Claim[] }).claims.length === 1 && (readOk.get("SMD-1") as { truncated: boolean }).truncated === true;
    }, "a stable brain's claims are read, truncation and all");
    await ok(() => asked.join() === "http://127.0.0.1:8010/api/v1/brain,http://127.0.0.1:8010/api/v1/claims?ticket=SMD-1&include_ended=true&limit=1000", "the configured brain alone is asked, its tier first, then each ticket's claims with include_ended and limit 1000");
    await ok(async () => {
      const failedRead = await readClaims(stable(new Response("", { status: 500 })), cfg, "k", ["SMD-1"]);
      return !("unreadable" in failedRead) && "unreadable" in (failedRead.get("SMD-1") as ClaimsRead);
    }, "a failed list is a reason for that ticket, not an empty list");
    await ok(async () => {
      const shapes = await Promise.all([json({ rows: [] }), json({ claims: [] }), new Response("not json", { status: 200 })].map((r) => readClaims(stable(r), cfg, "k", ["SMD-1"])));
      return shapes.every((s) => !("unreadable" in s) && "unreadable" in (s.get("SMD-1") as ClaimsRead));
    }, "an answer in an unknown shape, without its truncated flag, or no JSON at all, is a reason, not claims");
    const redirecting: Fetch = async (u, init) => (init?.redirect === "manual" ? new Response("", { status: 307, headers: { Location: "http://elsewhere/" } }) : json(u.endsWith("/v1/brain") ? { tier: "stable" } : { claims: [], truncated: false }));
    const redirectingClaims: Fetch = async (u, init) => (u.endsWith("/v1/brain") ? json({ tier: "stable" }) : init?.redirect === "manual" ? new Response("", { status: 307, headers: { Location: "http://elsewhere/" } }) : json({ claims: [], truncated: false }));
    await ok(async () => {
      const viaRedirect = await readClaims(redirectingClaims, cfg, "k", ["SMD-1"]);
      return "unreadable" in (await readClaims(redirecting, cfg, "k", ["SMD-1"])) && !("unreadable" in viaRedirect) && "unreadable" in (viaRedirect.get("SMD-1") as ClaimsRead);
    }, "every brain request asks fetch not to follow a redirect, and a redirect is a reason");
    const prUrls: string[] = [];
    const prAnswer = (rows: unknown, status = 200, headers: Record<string, string> = {}): Fetch => async (u) => {
      prUrls.push(u);
      return json(rows, status, headers);
    };
    const into = (state: string, merged_at: string | null, sha: string, baseRef = "main") => ({ state, merged_at, head: { sha }, base: { ref: baseRef } });
    await ok(async () => (await readBranchPrs(prAnswer([]), cfg, null, "b")) === null && JSON.stringify(await readBranchPrs(prAnswer([into("closed", "x", "h1"), into("open", null, "h2"), into("closed", null, "h3")]), cfg, null, "b")) === JSON.stringify({ open: true, merged: true, closedHeads: ["h1", "h3"] }), "a branch's PRs: none, or whether any is open or merged, with the merged and closed ones' heads");
    await ok(async () => JSON.stringify(await readBranchPrs(prAnswer([into("closed", "x", "h1", "smd-1-base"), into("closed", null, "h2", "smd-1-base")]), cfg, null, "b")) === JSON.stringify({ open: false, merged: false, closedHeads: [] }), "a PR merged or closed into another branch, a stacked one, frees nothing");
    await ok(() => prUrls.length === 3 && prUrls.every((u) => u === `https://api.github.com/repos/MHarris-SgyMd/OB1/pulls?state=all&per_page=100&head=${encodeURIComponent("MHarris-SgyMd:b")}`), "a branch's PRs are looked up in this repo, state=all, 100 a page, with the owner in the head filter");
    await ok(async () => (await throws(() => readBranchPrs(prAnswer({}, 403, { "x-ratelimit-remaining": "0" }), cfg, null, "b"), "rate limit is spent")) && (await throws(() => readBranchPrs(prAnswer({}, 429, { "x-ratelimit-remaining": "0" }), cfg, null, "b"), "rate limit is spent")) && (await throws(() => readBranchPrs(prAnswer({}, 403), cfg, null, "b"), "answered 403")), "a spent rate limit is named as such, and another refusal by its status");
    await ok(() => throws(() => readBranchPrs(answering(new Response("reflected-secret <html>", { status: 200 })), cfg, null, "b"), "isn't JSON", "reflected-secret"), "a GitHub body that isn't JSON is an error that doesn't quote it");
    await ok(() => throws(() => readOpenPrs(prAnswer({}, 500), cfg, null), "answered 500"), "a failed open-PR list is an error, not an empty list");
    const openUrls: string[] = [];
    const openHeaders: unknown[] = [];
    const openRows = [{ number: 5, title: "T", body: null, head: { ref: "h-5" }, user: { login: "L" } }, { number: 6, title: "U", body: "B", head: { ref: "h-6" }, user: null }];
    const token = `ghp_${"t".repeat(36)}`;
    const listed = await readOpenPrs(async (u, init) => {
      openUrls.push(u);
      openHeaders.push((init?.headers as Record<string, string>).Authorization);
      return json(openRows);
    }, cfg, token);
    await readOpenPrs(async (_u, init) => {
      openHeaders.push((init?.headers as Record<string, string>).Authorization);
      return json([]);
    }, cfg, null);
    await ok(() => JSON.stringify(listed) === JSON.stringify([{ number: 5, title: "T", body: "", head: "h-5", author: "L" }, { number: 6, title: "U", body: "B", head: "h-6", author: "" }]) && openUrls.join() === "https://api.github.com/repos/MHarris-SgyMd/OB1/pulls?state=open&per_page=100&page=1", "the open PRs are read with their number, title, body, head branch and author, 100 a page");
    await ok(() => openHeaders[0] === `Bearer ${token}` && openHeaders[1] === undefined, "a GitHub token goes in GitHub's Authorization header, and no token sends none");
    const gitStub = (fail = ""): Runner => async (cmd) => {
      if (fail && cmd.includes(fail)) return { code: 128, stdout: "", stderr: "fatal: no" };
      return { code: 0, stderr: "", stdout: cmd.includes("ls-remote") ? "a1\trefs/heads/main\n" : cmd.includes("worktree") ? "worktree /r\nHEAD a1\nbranch refs/heads/main\n" : "a1 main\n" };
    };
    await ok(() => throws(() => readBranches(gitStub("ls-remote"), cfg), "exited 128"), "a git read that fails is an error, not no branches");
    await ok(async () => (await throws(() => readBranches(gitStub("for-each-ref"), cfg), "exited 128")) && (await throws(() => readBranches(gitStub("worktree"), cfg), "exited 128")), "a failed read of the main checkout's branches or worktrees is an error too");
    const pages: unknown[] = [];
    const vars: Record<string, unknown>[] = [];
    const boardGql = (initiatives: number, labelCopies = 1, errors: { message: string }[] = []): Gql => async <T>(query: string, variables: Record<string, unknown> = {}) => {
      vars.push({ query: query.includes("initiatives(") ? "initiatives" : query.includes("issueLabels") ? "labels" : "board", ...variables });
      if (query.includes("initiatives(")) return { data: { initiatives: { nodes: Array.from({ length: initiatives }, (_, i) => ({ id: `i${i}`, name: "I" })) } } as T, errors: [] };
      if (query.includes("issueLabels")) return { data: { issueLabels: { nodes: [...Array.from({ length: labelCopies }, () => ({ id: "L-ready", name: "agent-ready" })), { id: "L-back", name: "agent-handed-back" }] } } as T, errors: [] };
      pages.push(variables.after);
      const first = variables.after === null;
      return { data: { issues: { pageInfo: { hasNextPage: first, endCursor: first ? "cursor-1" : null }, nodes: [issue({ identifier: first ? "SMD-1" : "SMD-2" })] } } as T, errors };
    };
    const two = await readBoard(boardGql(1), { ...cfg, team: "QA" }).catch(() => null);
    await ok(() => two?.tickets.map((t) => t.identifier).join() === "SMD-1,SMD-2" && JSON.stringify(pages) === JSON.stringify([null, "cursor-1"]) && two.readyLabelId === "L-ready" && two.handedBackLabelId === "L-back", "the board reads every page, each from the last one's cursor, with both labels' ids");
    await ok(() => {
      const [ini, lab, firstPage] = vars;
      return ini.query === "initiatives" && ini.name === "Initiative" && lab.query === "labels" && lab.team === "QA" && JSON.stringify(lab.names) === JSON.stringify(["agent-ready", "agent-handed-back"]) && firstPage.query === "board" && firstPage.team === "QA" && firstPage.label === "agent-ready" && firstPage.initiative === "i0";
    }, "the queries ask for the configured initiative by name, both labels on the team, and the board by team, ready label and the initiative's id");
    await ok(async () => (await throws(() => readBoard(boardGql(0), cfg), "0 initiatives")) && (await throws(() => readBoard(boardGql(2), cfg), "2 initiatives")) && (await throws(() => readBoard(boardGql(1, 2), cfg), "2 labels named agent-ready")), "no initiative, two of one name, or two labels of one name is an error");
    await ok(() => throws(() => readBoard(boardGql(1, 1, [{ message: "assignee: not authorized" }]), cfg), "GraphQL error"), "a board answered with an error, partial data and all, is an error, not a board");
  });

  await section("the whole dry run on stubs", async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const commands: { cmd: string[]; cwd?: string }[] = [];
    const queries: string[] = [];
    const SENTINEL = "sentinel-brain-key";
    const GH_TOKEN = `ghp_${"g".repeat(36)}`;
    const boardNodes = [
      issue({ identifier: "SMD-10" }),
      issue({ identifier: "SMD-11", priority: 1 }),
      issue({ identifier: "SMD-12", priority: 4 }),
      issue({ identifier: "SMD-13", priority: 4 }),
      issue({ identifier: "SMD-14", priority: 4 }),
      issue({ identifier: "SMD-15", priority: 4, assignee: { id: "u" } }),
      issue({ identifier: "SMD-16", priority: 4 }),
    ];
    const gql: Gql = async <T>(query: string) => {
      queries.push(query);
      const data = query.includes("initiatives(")
        ? { initiatives: { nodes: [{ id: "init-1", name: "Initiative" }] } }
        : query.includes("issueLabels")
          ? { issueLabels: { nodes: [{ id: "L-ready", name: "agent-ready" }, { id: "L-back", name: "agent-handed-back" }] } }
          : { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: boardNodes } };
      return { data: data as T, errors: [] };
    };
    const run: Runner = async (cmd, opts) => {
      commands.push({ cmd, cwd: opts?.cwd });
      const out = cmd.includes("ls-remote") ? "a1a1\trefs/heads/main\nb12b\trefs/heads/smd-12-merged\nc15c\trefs/heads/smd-15-x\n" : cmd.includes("worktree") ? "worktree /r\nHEAD e11e\nbranch refs/heads/smd-11-wip\n" : "a1a1 main\nd13d smd-13-local\n";
      return { code: 0, stderr: "", stdout: out };
    };
    const GH = "https://api.github.com/repos/MHarris-SgyMd/OB1/pulls";
    const lookup = (b: string) => `${GH}?state=all&per_page=100&head=${encodeURIComponent(`MHarris-SgyMd:${b}`)}`;
    const fullPage = Array.from({ length: 100 }, (_, i) => (i === 0 ? { number: 999, title: "work", body: "Closes SMD-16.", head: { ref: "feature" }, user: { login: "MHarris-SgyMd" } } : { number: 1000 + i, title: "other", body: "Mentions SMD-10 in passing.", head: { ref: `other-${i}` }, user: { login: "someone" } }));
    const fetchStub: Fetch = async (u, init) => {
      sent.push({ url: u, init });
      if (u === `${GH}?state=open&per_page=100&page=1`) return json(fullPage);
      if (u === `${GH}?state=open&per_page=100&page=2`) return json([]);
      if (u === lookup("smd-12-merged")) return json([{ state: "closed", merged_at: "2026-11-01T00:00:00Z", head: { sha: "b12b" }, base: { ref: "main" } }]);
      if (u === lookup("michaelharris/smd-14-x")) return json([{ state: "closed", merged_at: null, head: { sha: "c14" }, base: { ref: "main" } }]);
      if (u.startsWith(`${GH}?state=all&per_page=100&head=`)) return json([]);
      if (u === "http://127.0.0.1:8010/api/v1/brain") return json({ tier: "stable" });
      if (u.startsWith("http://127.0.0.1:8010/api/v1/claims?ticket=")) return json({ claims: u.includes("ticket=SMD-14&") ? [claim({ issue: "SMD-14", state: "lapsed", label: "codex@laptop michaelharris/smd-14-x" })] : [], truncated: false });
      return json({ message: "the stub doesn't know this URL" }, 404);
    };
    const result = await dryRun({ ...cfg, maintainerLinearId: MAINTAINER }, { gql, run, fetch: fetchStub, keys: { brain: SENTINEL, github: GH_TOKEN } });
    const verdict = (id: string) => result.verdicts.find((v) => v.identifier === id) as Verdict;
    const hdr = (s: { init?: RequestInit }) => (s.init?.headers ?? {}) as Record<string, string>;
    await ok(() => result.taken === "SMD-10" && result.verdicts[0].identifier === "SMD-11" && verdict("SMD-11").reasons.join() === "worktree /r (on smd-11-wip: no PR)", "the dry run skips the urgent ticket a worktree holds, and takes the next");
    await ok(() => verdict("SMD-12").reasons.join() === "a run takes one ticket, and SMD-10 comes first" && verdict("SMD-14").reasons.join() === "a run takes one ticket, and SMD-10 comes first", "a branch merged into main at its head, and a lapsed claim whose labelled branch's PR closed, free their tickets");
    await ok(() => verdict("SMD-13").reasons.join() === "branch smd-13-local (no PR)", "a local branch of the main checkout, with no PR, holds its ticket");
    await ok(() => verdict("SMD-15").reasons.join() === "assigned to someone" && !sent.some((s) => s.url.includes("smd-15") || s.url.includes("SMD-15")), "a ticket failing the board checks gets no claim or PR lookup");
    await ok(() => verdict("SMD-16").reasons.join() === "open PR 999 by MHarris-SgyMd" && verdict("SMD-10").reasons.length === 0, "a PR body of the maintainer's holds its ticket, and other people's bodies hold none");
    await ok(() => sent.length > 0 && sent.every((s) => (s.init?.method ?? "GET") === "GET" && s.init?.redirect === "manual" && (s.init as { verbose?: boolean }).verbose === false && (s.init as { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized === true) && queries.every((q) => !/^\s*mutation\b/.test(q)), "every request is a GET or a GraphQL query, follows no redirect, logs nothing and checks TLS: it writes nothing");
    const claimUrls = sent.filter((s) => s.url.includes("/v1/claims"));
    await ok(() => claimUrls.length === 6 && claimUrls.every((s) => /^http:\/\/127\.0\.0\.1:8010\/api\/v1\/claims[?]ticket=SMD-1[0-46]&include_ended=true&limit=1000$/.test(s.url) && hdr(s)["x-brain-key"] === SENTINEL) && sent.every((s) => !s.url.includes(SENTINEL)), "each candidate's claims are asked of the configured brain by ticket, with include_ended and limit 1000, the key in a header and in no URL");
    await ok(() => sent.filter((s) => s.url.startsWith("https://api.github.com/")).every((s) => hdr(s).Authorization === `Bearer ${GH_TOKEN}` && !JSON.stringify(hdr(s)).includes(SENTINEL)) && sent.filter((s) => !s.url.startsWith("https://api.github.com/")).every((s) => !JSON.stringify(hdr(s)).includes(GH_TOKEN)), "the GitHub token goes to GitHub alone, and the brain key to the brain alone");
    await ok(() => ["smd-12-merged", "smd-13-local", "smd-11-wip", "michaelharris/smd-14-x"].every((b) => sent.some((s) => s.url === lookup(b))), "each branch naming a candidate, and each claim's labelled branch, is looked up with state=all and the owner");
    await ok(() => sent.filter((s) => s.url.includes("pulls?state=open")).map((s) => s.url).join() === `${GH}?state=open&per_page=100&page=1,${GH}?state=open&per_page=100&page=2`, "the open PRs are listed with state=open, 100 a page, and a full first page brings the second");
    const lsRemotes = commands.filter((c) => c.cmd.includes("ls-remote"));
    await ok(() => lsRemotes.length === 2 && lsRemotes.some((c) => c.cmd.includes("https://github.com/MHarris-SgyMd/OB1.git")) && lsRemotes.some((c) => c.cmd.includes("https://github.com/bot-user/OB1.git")) && lsRemotes.every((c) => c.cwd === "/"), "ls-remote reads this repo and the bot's copy, from outside any repository");
    const local = (verb: string) => commands.find((c) => c.cmd.includes(verb));
    await ok(() => commands.every((c) => c.cmd[0] === "git" && c.cmd.slice(1, 1 + GIT_SAFE.length).join(" ") === GIT_SAFE.join(" ")) && local("for-each-ref")?.cmd.slice(1 + GIT_SAFE.length).join(" ") === "-C /home/x/src/repo for-each-ref --format=%(objectname) %(refname:lstrip=2) refs/heads" && local("worktree")?.cmd.slice(1 + GIT_SAFE.length).join(" ") === "-C /home/x/src/repo worktree list --porcelain", "every git call starts with the safe arguments, and the main checkout's branches, named whole, and worktrees are read there");
    const text = render(result, cfg);
    await ok(() => text.includes("A run would take SMD-10.") && text.includes("  SMD-13     skip  t\n      - branch smd-13-local (no PR)") && text.includes("reads only"), "the text names the ticket a run would take, and lists each skip with its reasons");
    const before = sent.length;
    const blind = await dryRun({ ...noUrl, maintainerLinearId: MAINTAINER }, { gql, run, fetch: fetchStub, keys: { brain: SENTINEL, github: null } });
    await ok(() => blind.taken === null && blind.claimsNote !== null && render(blind, noUrl).includes("would take nothing, since claims can't be read") && !sent.slice(before).some((s) => s.url.includes("pulls?state=all")), "with claims unreadable it takes nothing, says why, and looks up no branch's PRs");
    await ok(() => blind.verdicts.find((v) => v.identifier === "SMD-13")?.reasons.includes("branch smd-13-local (its PRs not looked up)") === true, "with claims unreadable, a branch's reason says its PRs weren't looked up, not that it is unmerged");
  });

  await section("the whole of main, on a temporary runner directory and stubs", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-runner-main-"));
    try {
      const runnerDir = join(root, "runner");
      const tmpRoot = join(root, "tmp");
      mkdirSync(runnerDir, { mode: 0o700 });
      chmodSync(runnerDir, 0o700);
      mkdirSync(tmpRoot);
      const configBody = JSON.stringify({ initiative: "Initiative", maintainerLinearId: MAINTAINER, mainCheckout: "/m", restUrl: "http://127.0.0.1:8010/api" });
      const configPath = join(runnerDir, "config.json");
      writeFileSync(configPath, configBody, { mode: 0o600 });
      const linearKey = "lin_api_" + "k".repeat(40);
      const brainKey = "ab".repeat(32);
      const ghToken = `ghp_${"h".repeat(36)}`;
      writeFileSync(join(runnerDir, "linear.key"), `${linearKey}\n`, { mode: 0o600 });
      const mainSent: { url: string; init?: RequestInit }[] = [];
      const lines: string[] = [];
      const errs: string[] = [];
      let title = "t";
      let claimsFor20: Claim[] = [];
      const mainFetch: Fetch = async (u, init) => {
        mainSent.push({ url: u, init });
        if (u === "https://api.linear.app/graphql") {
          const q = String(JSON.parse(String(init?.body)).query);
          const data = q.includes("initiatives(") ? { initiatives: { nodes: [{ id: "i", name: "Initiative" }] } } : q.includes("issueLabels") ? { issueLabels: { nodes: [{ id: "L-ready", name: "agent-ready" }, { id: "L-back", name: "agent-handed-back" }] } } : { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue({ identifier: "SMD-20", title })] } };
          return json({ data });
        }
        if (u === "https://api.github.com/repos/MHarris-SgyMd/OB1/pulls?state=open&per_page=100&page=1") return json([]);
        if (u.startsWith("https://api.github.com/repos/MHarris-SgyMd/OB1/pulls?state=all&per_page=100&head=")) return json([]);
        if (u === "http://127.0.0.1:8010/api/v1/brain") return json({ tier: "stable" });
        if (u === "http://127.0.0.1:8010/api/v1/claims?ticket=SMD-20&include_ended=true&limit=1000") return json({ claims: claimsFor20, truncated: false });
        return json({ message: "the stub doesn't know this URL" }, 404);
      };
      const spawned: string[][] = [];
      const mainSpawn: SpawnImpl = (cmd) => {
        spawned.push(cmd);
        const out = cmd[0] === "/bin/ls" ? "drwx------  2 me staff 64 /r\n" : cmd.includes("ls-remote") ? "a1a1\trefs/heads/main\n" : cmd.includes("worktree") ? "worktree /m\nHEAD a1a1\nbranch refs/heads/main\n" : "a1a1 main\n";
        return { stdout: stream(out), stderr: stream(""), exited: Promise.resolve(0), kill() {} };
      };
      const io = (over: Partial<Io> = {}): Io => ({ argv: [], env: {}, runnerDir, home: root, tmpRoot, platform: "darwin", execArgv: [...START_FLAGS], cwd: root, fetch: mainFetch, spawnImpl: mainSpawn, out: (s) => lines.push(s), err: (s) => errs.push(s), ...over });
      const nothingSent = () => mainSent.length === 0;
      await ok(async () => (await main(io({ execArgv: ["--no-env-file"] }))) === 2 && nothingSent() && errs.at(-1)?.includes("bun --no-env-file --config=/dev/null") === true, "a start without --no-env-file and --config=/dev/null is refused before anything is read");
      await ok(async () => (await main(io({ argv: ["--bogus"] }))) === 2 && nothingSent() && errs.at(-1)?.includes("unknown option") === true, "an unknown option is refused before anything is read");
      await ok(async () => (await main(io({ argv: ["--help"] }))) === 0 && lines.at(-1)?.startsWith("bun --no-env-file --config=/dev/null scripts/agent-runner/dry-run.ts") === true && nothingSent(), "--help prints how to start it, and sends nothing");
      writeFileSync(join(runnerDir, "brain.key"), "not-a-brain-key\n", { mode: 0o600 });
      await ok(async () => (await main(io({ env: { HTTP_PROXY: "http://proxy:8080" } }))) === 2 && nothingSent() && errs.at(-1)?.includes("HTTP_PROXY") === true, "a proxy setting in the environment is refused before any key is read or request sent");
      await ok(async () => (await main(io({ env: { SSL_CERT_FILE: "/x.pem", BUN_OPTIONS: "--preload=x" } }))) === 2 && errs.at(-1)?.includes("BUN_OPTIONS, SSL_CERT_FILE") === true, "a TLS trust or code-loading setting is refused, each named");
      await ok(async () => (await main(io({ runnerDir: join(root, "missing") }))) === 2 && nothingSent() && errs.at(-1)?.includes("no runner directory") === true, "a missing runner directory is refused");
      await ok(async () => (await main(io())) === 2 && nothingSent() && errs.at(-1)?.includes("right shape") === true && !errs.at(-1)?.includes("not-a-brain-key"), "a key of the wrong shape is refused before any request, its value unshown");
      rmSync(join(runnerDir, "brain.key"));
      writeFileSync(join(runnerDir, "brain.key"), `${brainKey}\n`, { mode: 0o600 });
      writeFileSync(join(root, "bad.json"), "{ not json", { mode: 0o600 });
      await ok(async () => (await main(io({ argv: ["--config", "bad.json"] }))) === 2 && nothingSent() && errs.at(-1)?.includes("not JSON") === true, "a config that isn't JSON is refused before any request");
      await ok(async () => (await main(io({ argv: ["--config", "absent.json"] }))) === 2 && nothingSent() && errs.at(-1)?.includes(`no config at ${join(root, "absent.json")}`) === true, "a missing config is refused, named by its whole path");
      const aclSpawn: SpawnImpl = (cmd) => ({ stdout: stream(cmd[0] === "/bin/ls" ? "-rw-------+ 1 me staff 65 /r/linear.key\n 0: group:everyone allow read\n" : ""), stderr: stream(""), exited: Promise.resolve(0), kill() {} });
      await ok(async () => (await main(io({ spawnImpl: aclSpawn }))) === 2 && nothingSent() && errs.at(-1)?.includes("access control list is on") === true, "an access list on the runner's files is refused before any request");
      const lsFails: SpawnImpl = (cmd) => ({ stdout: stream(""), stderr: stream("ls: no"), exited: Promise.resolve(cmd[0] === "/bin/ls" ? 1 : 0), kill() {} });
      await ok(async () => (await main(io({ spawnImpl: lsFails }))) === 2 && nothingSent() && errs.at(-1)?.includes("can't be read (ls exited 1)") === true, "access lists that can't be read are refused too");
      spawned.length = 0;
      await ok(async () => (await main(io())) === 0 && lines.at(-1)?.includes("A run would take SMD-20.") === true, "the dry run runs whole from main, and prints what a run would take");
      await ok(() => JSON.stringify(spawned.find((c) => c[0] === "/bin/ls")) === JSON.stringify(["/bin/ls", "-lde", runnerDir, configPath, join(runnerDir, "linear.key"), join(runnerDir, "brain.key")]), "the access lists are read with ls -lde, of the directory, the config and each key there is");
      await ok(async () => (await main(io({ platform: "linux", spawnImpl: aclSpawn }))) === 0, "off macOS, no ls -lde is run");
      const linearCall = mainSent.find((s) => s.url === "https://api.linear.app/graphql");
      await ok(() => linearCall?.init?.redirect === "manual" && (linearCall?.init as { verbose?: boolean }).verbose === false && (linearCall?.init as { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized === true && JSON.stringify(linearCall?.init?.headers).includes(linearKey), "main hands Linear's client the no-redirect fetch, with the runner's own key");
      await ok(() => readdirSync(tmpRoot).length === 0, "main removes the temporary home git ran with");
      title = `Fix ${chr(0x202e)}gnp.exe`;
      await ok(async () => (await main(io({ argv: ["--json"] }))) === 0 && JSON.parse(lines.at(-1) ?? "{}").verdicts?.[0]?.title === title && !(lines.at(-1) ?? "").includes(chr(0x202e)), "--json prints the verdicts as JSON, a bidi character escaped");
      title = "t";
      mkdirSync(join(root, "alt"));
      writeFileSync(join(root, "alt", "conf.json"), configBody, { mode: 0o600 });
      spawned.length = 0;
      await ok(async () => (await main(io({ argv: ["--config", "alt/conf.json"] }))) === 0 && spawned.find((c) => c[0] === "/bin/ls")?.[3] === join(root, "alt", "conf.json"), "a relative --config is read from the working directory, and its access list checked at that same path");
      writeFileSync(join(runnerDir, "github.token"), `${ghToken}\n`, { mode: 0o600 });
      mainSent.length = 0;
      await ok(async () => (await main(io())) === 0 && mainSent.some((s) => s.url.startsWith("https://api.github.com/")) && mainSent.every((s) => s.url.startsWith("https://api.github.com/") === JSON.stringify(s.init?.headers ?? {}).includes(ghToken)), "the runner's GitHub token is read, and sent to GitHub alone");
      rmSync(join(runnerDir, "github.token"));
      claimsFor20 = [claim({ issue: "SMD-20", label: `codex@laptop ${brainKey}` })];
      await ok(async () => (await main(io())) === 0 && (lines.at(-1) ?? "").includes("<a key>") && !(lines.at(-1) ?? "").includes(brainKey), "a key an answer carries back is printed as <a key>");
      claimsFor20 = [];
      const failing: Fetch = async (u, init) => (u.includes("api.github.com") ? Promise.reject(new Error(`boom ${esc}[2J ${linearKey}`)) : mainFetch(u, init));
      await ok(async () => (await main(io({ fetch: failing }))) === 1 && errs.at(-1)?.includes("<U+001B>") === true && !errs.at(-1)?.includes(esc) && errs.at(-1)?.includes("<a key>") === true && !errs.at(-1)?.includes(linearKey), "a failed read exits 1, its message printable and any key in it masked");
      await ok(() => readdirSync(tmpRoot).length === 0, "the temporary home is removed after a failed read too");
      rmSync(join(runnerDir, "linear.key"));
      await ok(async () => (await main(io())) === 2 && errs.at(-1)?.includes("no Linear key") === true && readdirSync(tmpRoot).length === 0, "a missing Linear key is refused, before any temporary home is made");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(
    await main({
      argv: process.argv.slice(2),
      env: process.env,
      runnerDir: RUNNER_DIR,
      home: homedir(),
      tmpRoot: tmpdir(),
      platform: process.platform,
      execArgv: process.execArgv,
      cwd: process.cwd(),
      fetch,
      spawnImpl: Bun.spawn as unknown as SpawnImpl,
      out: (s) => console.log(s),
      err: (s) => console.error(s),
    }),
  );
}
