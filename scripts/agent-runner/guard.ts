#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * guard.ts — the runner sessions' PreToolUse hook (SMD-4088; docs/agent-runner.md, "How the profile is enforced",
 * layer 3). Claude Code runs it before every tool call of a runner session, with the call on stdin. It answers "deny"
 * (exit 2, its reason on stderr) or nothing (exit 0, no output), never "allow", so the permission rules still apply
 * after it. It lets through only what it recognises:
 *
 *   - the worker's tools Read, Grep, Glob, Edit, Write and Bash, and the review's Read, Grep and Glob (TOOLS);
 *   - each tool's inputs as Claude Code 2.1.319 names them, and no other (INPUTS);
 *   - paths inside the session's root (the worker's clone, the review's checkout) or its temp directory, after
 *     resolving every symlink, and no Edit or Write into a refused path (refusedPart);
 *   - in Bash, one plain command of a listed shape (shapeVerdict): `cd` into the root or temp directory, a local git
 *     subcommand (GIT_LOCAL; `git bundle create` writing into the temp directory alone), `bun` running a file of the
 *     root, `bun test`, `bun run <script>`, or `bunx tsc`. No shell syntax at all (words), and no
 *     `dangerouslyDisableSandbox`, `allowed_domains` or `run_in_background`.
 *
 * Anything else is refused: an input it can't parse, a tool or an input it doesn't know, an error of its own. Each
 * decision is appended to the run's guard log by tool-call id, in the run's record, where the agent can't write; the
 * runner ends the session at the first tool result whose call the log doesn't show. The session's settings register
 * it with `onFailure: "block"` and a timeout, so a guard that can't start, crashes or hangs blocks the call too. It
 * runs from the runner's install after a `cd` there, with the start flags, so no .env or bunfig.toml loads with it:
 *
 *   cd <install> && exec <bun> --no-env-file --config=/dev/null <install>/guard.ts --role worker|review \
 *     --root <real path> --tmp <real path> --log <path>        # as profile.ts writes it into each session's settings
 */

import { closeSync, constants, lstatSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { HIDDEN_TEXT } from "./select.ts";

export type Role = "worker" | "review";
/** Where a session may reach: its root and its temp directory, both real paths, and the log the guard appends to. */
export type GuardConfig = { role: Role; root: string; tmp: string; log: string };
/** One decision: the call's id and tool when the call carried them, whether it is denied, and why. */
export type Decision = { id: string | null; tool: string | null; deny: boolean; why: string };
/** The file-system calls the guard makes, so the self-check can stand in for them. */
export type Fs = { realpath: (p: string) => string; lstat: (p: string) => unknown; isDir: (p: string) => boolean };

export const REAL_FS: Fs = {
  realpath: (p) => realpathSync.native(p),
  lstat: (p) => lstatSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/** The flags the guard must be started with, as the dry run is, so Bun reads no .env and no bunfig.toml where it starts. */
export const START_FLAGS = ["--no-env-file", "--config=/dev/null"];

export const TOOLS: Record<Role, readonly string[]> = {
  worker: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  review: ["Read", "Grep", "Glob"],
};

/**
 * Each tool's inputs as Claude Code 2.1.319 names them (its tool schemas, as a probe session sent them). Any other is
 * refused, so an input a later version adds, which might change what a call does, is refused until the profile is
 * probed on that version.
 */
export const INPUTS: Record<string, readonly string[]> = {
  Read: ["file_path", "offset", "limit", "pages", "allow_large"],
  Grep: ["pattern", "path", "glob", "output_mode", "-B", "-A", "-C", "context", "-n", "-i", "-o", "type", "head_limit", "offset", "multiline"],
  Glob: ["pattern", "path"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
  Write: ["file_path", "content"],
  Bash: ["command", "timeout", "description", "run_in_background", "dangerouslyDisableSandbox", "allowed_domains"],
};

/** git's subcommands that act on the clone alone. Nothing that reaches a remote, changes git's config, or adds a worktree or submodule. */
export const GIT_LOCAL = new Set([
  "add", "apply", "blame", "branch", "bundle", "cat-file", "checkout", "cherry-pick", "clean", "commit", "describe", "diff", "diff-tree", "grep",
  "log", "ls-files", "merge-base", "mv", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "stash",
  "status", "switch",
]);

/** A file `bun` may run: a script of the root, by its extension. */
const SCRIPT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
/** A package script's name, for `bun run <name>`: no path, no option. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

/** Untrusted text on one line for a reason or a log: each hidden code point as <U+XXXX>, whitespace closed, cut at `max`. */
export function shownText(value: unknown, max = 200): string {
  const s = typeof value === "string" ? value : String(value);
  let out = "";
  for (const ch of s.replace(/\s+/g, " ").trim()) out += HIDDEN_TEXT.test(ch) ? `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>` : ch;
  const cps = [...out];
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errnoOf = (e: unknown): string | undefined => (isObject(e) && typeof e.code === "string" ? e.code : undefined);

/** A path as written: absolute, with at least one part, no empty, `.` or `..` part, and no character that doesn't show. */
export function plainPath(p: unknown): string | null {
  if (typeof p !== "string" || !p.startsWith("/") || HIDDEN_TEXT.test(p)) return null;
  const parts = p.slice(1).split("/");
  return parts.some((s) => s === "" || s === "." || s === "..") ? null : p;
}

/**
 * Where a plain path really is: the deepest part of it that exists, through every symlink, then the rest as written
 * (a part that doesn't exist holds no link). Null for a path that isn't plain, for a part that exists but can't be
 * followed (a dangling link, or one the guard can't read), and for a path none of which exists.
 */
export function realOf(p: string, fs: Fs = REAL_FS): string | null {
  if (plainPath(p) === null) return null;
  let head = p;
  let rest = "";
  for (;;) {
    try {
      const real = fs.realpath(head);
      return rest === "" ? real : `${real === "/" ? "" : real}/${rest}`;
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") return null;
      try {
        fs.lstat(head);
        return null; // something is there that realpath can't follow: a dangling link
      } catch (e2) {
        if (errnoOf(e2) !== "ENOENT") return null;
      }
    }
    const cut = head.lastIndexOf("/");
    if (cut <= 0) return null;
    rest = rest === "" ? head.slice(cut + 1) : `${head.slice(cut + 1)}/${rest}`;
    head = head.slice(0, cut);
  }
}

/** Whether a real path is `base` or inside it. */
export const within = (real: string, base: string): boolean => real === base || real.startsWith(`${base}/`);

/** A path an input gives, absolute or relative to the session's working directory, as a plain path; null if it isn't one. */
export function joined(arg: unknown, cwd: string): string | null {
  if (typeof arg !== "string" || arg === "") return null;
  return plainPath(arg.startsWith("/") ? arg : `${cwd}/${arg}`);
}

/**
 * The refused path a root-relative path falls in, or null: docs/agent-runner.md layer 3's list, which SMD-4086's
 * criteria rule out too. Compared without case, since macOS's file system ignores it: `.git`, `.claude` and any `auth`
 * directory at any depth; `.github/`, `deploy/`, `scripts/agent-runner/` and `db/migrations/` at the top; the key
 * code of server-portable (`keygen.ts`, `pass-key.ts`, `oauth-*.ts`, `core/caller.ts`); and any `auth.ts`,
 * `.mcp.json`, CLAUDE.md, AGENTS.md, `bunfig.toml`, `package.json` or lockfile.
 */
export function refusedPart(rel: string): string | null {
  const parts = rel.toLowerCase().split("/");
  const name = parts[parts.length - 1];
  const dir = parts.find((p) => p === ".git" || p === ".claude" || p === "auth");
  if (dir) return dir === "auth" ? "an auth directory" : `${dir}/`;
  if (parts[0] === ".github" || parts[0] === "deploy") return `${parts[0]}/`;
  if (parts[0] === "scripts" && parts[1] === "agent-runner") return "scripts/agent-runner/";
  if (parts[0] === "db" && parts[1] === "migrations") return "db/migrations/";
  if (parts[0] === "server-portable") {
    const sub = parts.slice(1).join("/");
    if (sub === "keygen.ts" || sub === "pass-key.ts" || sub === "core/caller.ts" || (parts.length === 2 && /^oauth-.*\.ts$/.test(name))) return `server-portable/${sub}`;
  }
  if (/^(claude|agents)(\.local)?\.md$/.test(name)) return name;
  if (["auth.ts", ".mcp.json", "bunfig.toml", "package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(name)) return name;
  return null;
}

/** Characters a word may hold outside quotes: none the shell expands or treats as syntax in sh, bash or zsh. */
const PLAIN = /^[A-Za-z0-9_./:=@%+,-]$/;

/**
 * A command's words when it has no shell syntax at all: words separated by spaces, each made of plain characters,
 * text in single quotes, or text in double quotes holding nothing the shell expands there. Anything else refuses the
 * command whole: a newline or tab (hidden characters), `;`, `&`, `|`, a redirection, `$`, a backtick, a glob, `~`, a
 * backslash, `#`, braces or parentheses outside quotes, and a word starting `=` outside quotes (zsh expands it).
 */
export function words(command: string): string[] | { refused: string } {
  if (HIDDEN_TEXT.test(command)) return { refused: "the command holds a newline, tab or other character that doesn't show" };
  const out: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === " ") {
      i++;
      continue;
    }
    let word = "";
    while (i < command.length && command[i] !== " ") {
      const c = command[i];
      if (c === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) return { refused: "an unclosed single quote" };
        word += command.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        const end = command.indexOf('"', i + 1);
        if (end < 0) return { refused: "an unclosed double quote" };
        const inner = command.slice(i + 1, end);
        if (/[$`\\!]/.test(inner)) return { refused: "a $, backtick, backslash or ! inside double quotes, which the shell expands" };
        word += inner;
        i = end + 1;
      } else if (PLAIN.test(c)) {
        // An unquoted `=` with nothing non-empty before it in the word is zsh's EQUALS expansion (`=cmd` → the command's
        // path), even after an empty quote (`""=foo`): refuse it. A `=` later in the word (`--x=y`) or inside quotes is fine.
        if (c === "=" && word === "") return { refused: "a word beginning with = outside quotes, which zsh expands to a command's path" };
        word += c;
        i++;
      } else {
        return { refused: `shell syntax (${shownText(c)}): the guard takes one plain command` };
      }
    }
    out.push(word);
  }
  return out.length === 0 ? { refused: "an empty command" } : out;
}

/** Where a session may reach at all: its root or its temp directory. */
const reachable = (real: string, cfg: GuardConfig): boolean => within(real, cfg.root) || within(real, cfg.tmp);

/**
 * A path an input names, checked for reading (`read`) or writing (`write`). A read may be inside the root or the temp
 * directory. A write (Edit, Write) may be inside the root alone, outside every refused path, both as written and where
 * it really is (a link can lead into a refused path, and a refused name can be a link out of one). The Edit and Write
 * tools never write the temp directory: the shell writes its scratch and the bundle there, and the temp directory is
 * also Claude Code's own staging (`claude-<uid>/`), which the tools, running outside the sandbox, must not reach. The
 * reason it fails, or null.
 */
export function pathProblem(given: unknown, cwd: string, mode: "read" | "write", cfg: GuardConfig, fs: Fs, relativeOk: boolean): string | null {
  if (typeof given !== "string") return "a path that isn't a string";
  if (!relativeOk && !given.startsWith("/")) return `a relative path (${shownText(given)}); this tool takes absolute paths`;
  const plain = joined(given, cwd);
  if (plain === null) return `a path that isn't plain (${shownText(given)}): no empty, . or .. part, and no character that doesn't show`;
  const real = realOf(plain, fs);
  if (real === null) return `a path that can't be resolved (${shownText(given)}): a dangling link, or one the guard can't follow`;
  if (!reachable(real, cfg)) return `a path outside the session's root and temp directory (${shownText(given)}${real === plain ? "" : `, really ${shownText(real)}`})`;
  if (mode === "write") {
    if (!within(real, cfg.root)) return `a write to the temp directory (${shownText(given)}), which only the shell writes (its scratch, the bundle, and Claude Code's staging); the Edit and Write tools write the clone`;
    const asWritten = within(plain, cfg.root) && plain !== cfg.root ? refusedPart(plain.slice(cfg.root.length + 1)) : null;
    const really = real !== cfg.root ? refusedPart(real.slice(cfg.root.length + 1)) : null;
    const hit = asWritten ?? really;
    if (hit) return `a write into a refused path (${hit}), which the runner's sessions never change`;
    if (real === cfg.root) return "a write to the root directory itself";
  }
  return null;
}

/** A glob an input gives (Glob's pattern, Grep's glob): relative, with no `..` part, no `~` and nothing hidden. */
export function globProblem(glob: unknown): string | null {
  if (glob === undefined) return null;
  if (typeof glob !== "string" || glob === "") return "a glob that isn't a non-empty string";
  if (glob.startsWith("/") || glob.startsWith("~") || HIDDEN_TEXT.test(glob)) return `a glob that is absolute, starts with ~, or hides a character (${shownText(glob)})`;
  if (glob.split(/[/\\]/).some((s) => s === "..")) return `a glob with a .. part (${shownText(glob)})`;
  return null;
}

/**
 * Whether a Bash command's words are one of the listed shapes. `cd` into the root or temp directory; a local git
 * subcommand, given first (so no `-c`, `-C` or `--git-dir` comes before it), with `git bundle create` writing into the
 * temp directory alone; `bun` running a script of the root (after at most the two start flags), `bun test`,
 * `bun run <script or file>`; `bunx tsc` or `bun x tsc`.
 */
export function shapeVerdict(argv: string[], cwd: string, cfg: GuardConfig, fs: Fs): { deny: boolean; why: string } {
  const no = (why: string) => ({ deny: true, why });
  const pass = (why: string) => ({ deny: false, why });
  const [cmd, ...args] = argv;
  if (cmd === "cd") {
    if (args.length !== 1) return no("cd takes exactly one directory");
    const problem = pathProblem(args[0], cwd, "read", cfg, fs, true);
    if (problem) return no(`cd to ${problem}`);
    const real = realOf(joined(args[0], cwd) as string, fs) as string;
    return fs.isDir(real) ? pass("cd within the session's reach") : no("cd to something that isn't a directory");
  }
  if (cmd === "git") {
    const sub = args[0];
    if (sub === undefined || !GIT_LOCAL.has(sub)) return no(`git ${shownText(sub ?? "")}: only git's local subcommands, given first (${[...GIT_LOCAL].join(", ")})`);
    if (sub === "bundle") {
      if (args[1] !== "create" || args.length < 4) return no("git bundle: only `git bundle create <file in the temp directory> <revs>`");
      const file = args[2];
      const plain = joined(file, cwd);
      const real = plain === null ? null : realOf(plain, fs);
      if (real === null || !within(real, cfg.tmp) || real === cfg.tmp) return no(`git bundle create writes only into the session's temp directory (not ${shownText(file)})`);
      return pass("git bundle create into the temp directory");
    }
    return pass(`git ${sub}`);
  }
  if (cmd === "bunx" || (cmd === "bun" && args[0] === "x")) {
    const rest = cmd === "bunx" ? args : args.slice(1);
    return rest[0] === "tsc" ? pass("a typecheck (tsc)") : no(`${cmd === "bunx" ? "bunx" : "bun x"} runs tsc alone`);
  }
  if (cmd === "bun") {
    let rest = args;
    while (rest.length > 0 && START_FLAGS.includes(rest[0])) rest = rest.slice(1);
    const first = rest[0];
    if (first === undefined) return no("bun with nothing to run");
    if (first === "test") return pass("bun test");
    if (first === "run") {
      const target = rest[1];
      if (target === undefined) return no("bun run with nothing to run");
      if (SCRIPT_NAME.test(target) && !SCRIPT.test(target)) return pass(`bun run ${target}`);
      return scriptVerdict(target, cwd, cfg, fs, "bun run");
    }
    if (first.startsWith("-")) return no(`bun ${shownText(first)}: no option but the start flags comes before the file it runs`);
    return scriptVerdict(first, cwd, cfg, fs, "bun");
  }
  return no(`${shownText(cmd)}: the only commands are cd, git's local subcommands, bun and bunx tsc`);
}

function scriptVerdict(file: string, cwd: string, cfg: GuardConfig, fs: Fs, how: string): { deny: boolean; why: string } {
  if (!SCRIPT.test(file)) return { deny: true, why: `${how} ${shownText(file)}: it runs a script (${SCRIPT.source}) of the root, a suite, typecheck or self-check` };
  const plain = joined(file, cwd);
  const real = plain === null ? null : realOf(plain, fs);
  if (real === null || !within(real, cfg.root)) return { deny: true, why: `${how} runs only a script inside the root (not ${shownText(file)})` };
  return { deny: false, why: `${how} a script of the root` };
}

/** The decision on one call, as Claude Code passes it on stdin. Never throws for any input; an error of its own is a deny by its caller. */
export function decide(raw: unknown, cfg: GuardConfig, fs: Fs = REAL_FS): Decision {
  if (!isObject(raw)) return { id: null, tool: null, deny: true, why: "the call isn't a JSON object" };
  const id = typeof raw.tool_use_id === "string" && raw.tool_use_id !== "" && !HIDDEN_TEXT.test(raw.tool_use_id) ? raw.tool_use_id : null;
  const tool = typeof raw.tool_name === "string" ? raw.tool_name : null;
  const no = (why: string): Decision => ({ id, tool, deny: true, why });
  const pass = (why: string): Decision => ({ id, tool, deny: false, why });
  if (raw.hook_event_name !== "PreToolUse") return no(`an event the guard doesn't take (${shownText(raw.hook_event_name)})`);
  if (id === null) return no("the call has no plain tool_use_id, so its decision can't be logged by it");
  if (tool === null || !Object.hasOwn(INPUTS, tool) || !TOOLS[cfg.role].includes(tool)) return no(`${shownText(tool ?? "a nameless tool")} isn't one of the ${cfg.role}'s tools (${TOOLS[cfg.role].join(", ")})`);
  const input = raw.tool_input;
  if (!isObject(input)) return no("its input isn't an object");
  const unknown = Object.keys(input).filter((k) => !INPUTS[tool].includes(k));
  if (unknown.length > 0) return no(`an input the guard doesn't know for ${tool}: ${unknown.map((k) => shownText(k, 40)).join(", ")}`);
  const cwdPlain = plainPath(raw.cwd);
  const cwd = cwdPlain === null ? null : realOf(cwdPlain, fs);
  if (cwd === null || !reachable(cwd, cfg)) return no("the session's working directory isn't inside its root or temp directory");
  switch (tool) {
    case "Read": {
      const problem = pathProblem(input.file_path, cwd, "read", cfg, fs, false);
      return problem ? no(`Read of ${problem}`) : pass("Read within the session's reach");
    }
    case "Edit":
    case "Write": {
      const problem = pathProblem(input.file_path, cwd, "write", cfg, fs, false);
      return problem ? no(`${tool} of ${problem}`) : pass(`${tool} within the session's reach`);
    }
    case "Grep":
    case "Glob": {
      if (input.path !== undefined) {
        const problem = pathProblem(input.path, cwd, "read", cfg, fs, true);
        if (problem) return no(`${tool} in ${problem}`);
      }
      const problem = globProblem(tool === "Glob" ? input.pattern : input.glob);
      if (problem) return no(`${tool} with ${problem}`);
      return pass(`${tool} within the session's reach`);
    }
    case "Bash": {
      if (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false) return no("dangerouslyDisableSandbox: every command runs in the sandbox");
      if (input.allowed_domains !== undefined && !(Array.isArray(input.allowed_domains) && input.allowed_domains.length === 0)) return no("allowed_domains: no command reaches the network");
      if (input.run_in_background !== undefined && input.run_in_background !== false) return no("run_in_background: each command runs in the foreground, where the session's limits reach it");
      if (typeof input.command !== "string") return no("a command that isn't a string");
      const argv = words(input.command);
      if (!Array.isArray(argv)) return no(argv.refused);
      const v = shapeVerdict(argv, cwd, cfg, fs);
      return v.deny ? no(v.why) : pass(v.why);
    }
  }
  return no(`${tool} has no rule`);
}

/** The guard's options, each required: the role, the root and temp directory as real paths, and the log's path. */
export function parseGuardArgs(argv: string[], fs: Fs = REAL_FS): GuardConfig | { error: string } {
  const known = ["--role", "--root", "--tmp", "--log"];
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!known.includes(name) || Object.hasOwn(got, name)) return { error: `an unknown or repeated option (${shownText(name)})` };
    if (value === undefined) return { error: `${name} needs a value` };
    got[name] = value;
  }
  const missing = known.filter((k) => !Object.hasOwn(got, k));
  if (missing.length > 0) return { error: `missing ${missing.join(", ")}` };
  const role = got["--role"];
  if (role !== "worker" && role !== "review") return { error: `--role is worker or review, not ${shownText(role)}` };
  for (const name of ["--root", "--tmp"]) {
    const p = got[name];
    let real: string | null = null;
    try {
      real = plainPath(p) === null ? null : fs.realpath(p);
    } catch {
      real = null;
    }
    if (real !== p || !fs.isDir(p)) return { error: `${name} must be a directory's real path (${shownText(p)})` };
  }
  if (within(got["--root"], got["--tmp"]) || within(got["--tmp"], got["--root"])) return { error: "the root and the temp directory must not hold one another" };
  const log = got["--log"];
  const cut = log.lastIndexOf("/");
  if (plainPath(log) === null || cut <= 0 || !fs.isDir(log.slice(0, cut))) return { error: `--log must be a plain path in a directory that exists (${shownText(log)})` };
  const cfg: GuardConfig = { role, root: got["--root"], tmp: got["--tmp"], log };
  const logReal = realOf(log, fs);
  if (logReal === null || reachable(logReal, cfg)) return { error: "the log must sit outside the session's reach, where the agent can't write it" };
  return cfg;
}

/** One line of the guard's log: when, the call's id and tool, the decision, and why. */
export function logLine(at: string, d: Decision): string {
  return `${JSON.stringify({ at, id: d.id, tool: d.tool, decision: d.deny ? "deny" : "pass", why: d.why })}\n`;
}

/** Appends a line to the log: never through a link, created owner-only. */
export function appendLog(path: string, line: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export type GuardIo = { argv: string[]; execArgv: string[]; stdin: () => Promise<string>; err: (s: string) => void; now: () => string; fs?: Fs; append?: (path: string, line: string) => void };

/** The hook: 0 with no output lets the call go on to the permission rules; 2, its reason on stderr, denies it. */
export async function main(io: GuardIo): Promise<number> {
  const fs = io.fs ?? REAL_FS;
  const append = io.append ?? appendLog;
  const deny = (why: string): number => {
    io.err(`The agent runner's guard refused this call: ${why}`);
    return 2;
  };
  try {
    if (!START_FLAGS.every((f) => io.execArgv.includes(f))) return deny(`the guard must be started with ${START_FLAGS.join(" ")}`);
    const cfg = parseGuardArgs(io.argv, fs);
    if ("error" in cfg) return deny(`its own options are wrong: ${cfg.error}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await io.stdin());
    } catch {
      raw = undefined;
    }
    let d: Decision;
    try {
      d = raw === undefined ? { id: null, tool: null, deny: true, why: "the call isn't JSON" } : decide(raw, cfg, fs);
    } catch (e) {
      d = { id: null, tool: null, deny: true, why: `the guard's own error (${shownText((e as Error)?.message ?? e)})` };
    }
    try {
      append(cfg.log, logLine(io.now(), d));
    } catch (e) {
      return deny(`it couldn't log its decision (${shownText((e as Error)?.message ?? e)})`);
    }
    return d.deny ? deny(d.why) : 0;
  } catch (e) {
    return deny(`the guard's own error (${shownText((e as Error)?.message ?? e)})`);
  }
}

if (import.meta.main) {
  process.exit(
    await main({
      argv: process.argv.slice(2),
      execArgv: process.execArgv,
      stdin: () => Bun.stdin.text(),
      err: (s) => console.error(s),
      now: () => new Date().toISOString(),
    }),
  );
}
