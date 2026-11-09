/**
 * profile.ts — the runner sessions' profile (SMD-4088; docs/agent-runner.md, "How the profile is enforced"): each
 * session's settings, environment and command line. The settings are a template per role with the session's paths
 * substituted and nothing else (settingsFor, settingsText). profileProblem checks that a written settings file is
 * exactly that template for its paths (layer 5); the real runner calls it before a session (cut 2b), and the
 * self-check exercises it. runSession itself only reads back the settings it was handed, since the probes hand it
 * deliberate variants. The environment holds only what the runner puts there (sessionEnv, layer 1), and the command
 * line is decision 3's (sessionArgs).
 *
 * Every path a profile names must be plain (PLAIN_PATH): absolute, with no space, quote or shell character, so the
 * guard's command line in the settings can quote it safely and no path can widen a rule.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { START_FLAGS, TOOLS, plainPath, type Role } from "./guard.ts";

/** A session's paths: the runner's install, Bun, the session's root and temp directory, the run's record, Claude Code's config directory, the API key's file and the git config. */
export type SessionPaths = {
  /** The runner's install: a checkout whose scripts/agent-runner/guard.ts the hook runs. */
  install: string;
  /** Bun's binary; `bunx` beside it. */
  bun: string;
  /**
   * git's own binary, in the active developer directory (`xcode-select -p`/usr/bin/git), first on the session's PATH.
   * `/usr/bin/git` is Apple's xcrun shim, which writes a cache into the maintainer's per-user temp directory; in the
   * sandbox every git command would print that failure twice.
   */
  git: string;
  /** The worker's clone or the review's checkout: the session's working directory, as a real path. */
  root: string;
  /** The session's temp directory, as a real path of at most TMP_MAX bytes. */
  tmp: string;
  /** The run's record, where the guard logs: outside the session's reach. */
  record: string;
  /** CLAUDE_CONFIG_DIR: the runner's own, holding the base commit's CLAUDE.md and what Claude Code itself writes. */
  configDir: string;
  /** The file apiKeyHelper prints: the runner's Anthropic key, or a probe's stand-in. */
  keyFile: string;
  /** GIT_CONFIG_GLOBAL: the bot's identity, signing off. */
  gitConfig: string;
  /** The maintainer's home, whose reads the sandbox denies. */
  home: string;
};

/** A path a profile may name: absolute, of characters no shell or rule treats as syntax. */
export const PLAIN_PATH = /^\/[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*$/;

/**
 * The longest temp root Claude Code 2.1.319 keeps child commands in. It puts them in `<CLAUDE_CODE_TMPDIR>/claude-<uid>`
 * only while that path is at most 44 bytes, and otherwise in the shared `/tmp/claude-<uid>`, which the profile denies
 * (the cut 2 spike found it: every command then exits 1). So a session's temp directory is short, such as
 * `/private/tmp/obr-<8 hex>` (25 bytes), never a directory inside the run's record under the home directory.
 */
export const CHILD_TMP_MAX = 44;

/** The longest temp directory a session may have for a user id: CHILD_TMP_MAX less `/claude-<uid>`. */
export const tmpMax = (uid: number): number => CHILD_TMP_MAX - Buffer.byteLength(`/claude-${uid}`);

/** The environment variables the sandbox unsets for every command even if one were inherited: the session's environment holds none of them. */
export const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DATABASE_URL", "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "LINEAR_COMMENT_API_KEY", "MCP_ACCESS_KEYS", "NPM_TOKEN", "OPENAI_API_KEY", "PGPASSWORD", "SSH_AUTH_SOCK",
];

/** Seconds the guard has per call before Claude Code counts it as failed and, with `onFailure: "block"`, blocks the call. */
export const GUARD_TIMEOUT_S = 15;

/**
 * The hook's command line: a `cd` into the install, then Bun with an environment of its own (`env -i`, the home
 * directory, and Bun's transpiler cache off), its start flags, the guard by absolute path, and the session's paths.
 * Claude Code starts a hook with the session's environment, whose XDG directories sit in the temp directory the agent
 * writes; Bun's caches follow them. The guard runs outside the sandbox, so it takes nothing from that environment.
 */
export function guardCommand(role: Role, p: Pick<SessionPaths, "install" | "bun" | "root" | "tmp" | "record" | "home">): string {
  const q = (s: string) => `'${s}'`;
  return `cd ${q(p.install)} && exec /usr/bin/env -i HOME=${q(p.home)} BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 ${q(p.bun)} ${START_FLAGS.join(" ")} ${q(`${p.install}/scripts/agent-runner/guard.ts`)} --role ${role} --root ${q(p.root)} --tmp ${q(p.tmp)} --log ${q(guardLog(p.record, role))}`;
}

/** Where a session's guard logs its decisions, in the run's record. */
export const guardLog = (record: string, role: Role): string => `${record}/guard-${role}.log`;

/** Where a session's settings are written, in the run's record. */
export const settingsFile = (record: string, role: Role): string => `${record}/settings-${role}.json`;

/**
 * A role's settings. The worker: the sandbox (writes only in its clone and temp directory; the home directory and the
 * shared temp directories unreadable but for those, the git config, Bun and bunx; no network; credential variables
 * unset), its allow rules for Edit and Write in the clone and temp directory and for the guard's Bash shapes, deny
 * rules for the tools it never has, reads and writes held to the working directories, bypass mode disabled, no auto
 * memory, and the guard. The review: the same with its checkout for a clone, no Edit, Write or Bash rules, and a
 * guard of its own role.
 */
export function settingsFor(role: Role, p: SessionPaths): Record<string, unknown> {
  const bunx = `${dirname(p.bun)}/bunx`;
  // The Edit and Write tools may write the clone alone, not the temp directory: the shell writes the temp directory's
  // scratch and the bundle (sandbox allowWrite below), and the temp directory is also Claude Code's own staging, which
  // the tools run outside the sandbox and must not reach (the guard refuses it too).
  //
  // The rules render with a leading `//` (`p.root` already starts with `/`), and that is required, not a typo: Claude
  // Code's Edit/Write permission matcher does not match a single-slash absolute glob, so `Edit(/abs/**)` denies every
  // write under dontAsk; `Edit(//abs/**)` matches. The cut 2a probes (commit-as-bot, guard-exit-0-nonsense) prove it
  // live, and the self-check pins the exact strings.
  const allow = role === "worker"
    ? [`Edit(/${p.root}/**)`, `Write(/${p.root}/**)`, "Bash(cd *)", "Bash(git *)", "Bash(bun *)", "Bash(bunx tsc)", "Bash(bunx tsc *)"]
    : [];
  return {
    apiKeyHelper: `/bin/cat '${p.keyFile}'`,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowWrite: role === "worker" ? [p.root, p.tmp] : [p.tmp],
        denyRead: [p.home, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
        allowRead: [p.root, p.tmp, p.gitConfig, p.bun, bunx],
      },
      network: { allowedDomains: [] },
      credentials: { envVars: CREDENTIAL_VARS.map((name) => ({ name, mode: "deny" })) },
    },
    permissions: {
      allow,
      deny: ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: "disable",
    },
    autoMemoryEnabled: false,
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCommand(role, p), timeout: GUARD_TIMEOUT_S, onFailure: "block" }] }],
    },
  };
}

/** The reason a session's paths can't make a profile, or null: each plain, the temp directory short enough, and the root, temp directory and record apart. */
export function pathsProblem(p: SessionPaths, uid: number): string | null {
  for (const [name, value] of Object.entries(p)) {
    if (typeof value !== "string" || !PLAIN_PATH.test(value) || plainPath(value) === null) return `${name} isn't a plain absolute path (letters, digits and _ . @ + - alone)`;
  }
  if (Buffer.byteLength(p.tmp) > tmpMax(uid)) return `the temp directory takes more than ${tmpMax(uid)} bytes (${Buffer.byteLength(p.tmp)}), so Claude Code would keep commands in the shared /tmp/claude-${uid}`;
  const apart = (a: string, b: string) => a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
  if (!apart(p.root, p.tmp) || !apart(p.root, p.record) || !apart(p.tmp, p.record) || !apart(p.root, p.configDir) || !apart(p.tmp, p.configDir) || !apart(p.record, p.configDir)) return "the root, the temp directory, the record and the config directory must not hold one another";
  if (!apart(p.root, p.install) || !apart(p.tmp, p.install)) return "the session's root and temp directory must not hold the install, or sit inside it";
  return null;
}

/** A role's settings as the file the runner writes: two-space JSON and a newline, so the comparison is of text. */
export function settingsText(role: Role, p: SessionPaths): string {
  return `${JSON.stringify(settingsFor(role, p), null, 2)}\n`;
}

/** The reason a written profile isn't its template with the session's paths substituted, or null. */
export function profileProblem(written: string, role: Role, p: SessionPaths, uid: number): string | null {
  const problem = pathsProblem(p, uid);
  if (problem) return problem;
  return written === settingsText(role, p) ? null : `the ${role}'s settings file isn't its template with this session's paths: it changed after the runner wrote it`;
}

/**
 * The environment a session starts with, and nothing else: no credential, no SSH agent, Claude Code's temp directory
 * the session's own, Bun's transpiler cache off, Bun and git's own binary first on the PATH (the sandboxed shell is
 * no login shell, so the PATH stays as given), and the XDG directories inside the temp directory, so no tool reaches
 * for the maintainer's ~/.config and warns that the sandbox refused it.
 */
export function sessionEnv(p: SessionPaths, user: string, baseUrl?: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: p.home,
    PATH: `${dirname(p.bun)}:${dirname(p.git)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    XDG_CONFIG_HOME: `${p.tmp}/xdg/config`,
    XDG_CACHE_HOME: `${p.tmp}/xdg/cache`,
    XDG_DATA_HOME: `${p.tmp}/xdg/data`,
    XDG_STATE_HOME: `${p.tmp}/xdg/state`,
    USER: user,
    LOGNAME: user,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TMPDIR: p.tmp,
    CLAUDE_CODE_TMPDIR: p.tmp,
    CLAUDE_CONFIG_DIR: p.configDir,
    GIT_CONFIG_GLOBAL: p.gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  if (baseUrl !== undefined) env.ANTHROPIC_BASE_URL = baseUrl;
  return env;
}

/** A session's limits and model, from the runner's config (decisions 4 and 11). */
export type SessionLimits = { model: string; effort: string; maxTurns: number; maxBudgetUsd: number };

/** Decision 3's command line, after the binary: print mode, the stream, dontAsk with nobody to approve, the profile alone, no MCP server, the role's tools, the limits and the model. The prompt goes on stdin. */
export function sessionArgs(role: Role, p: SessionPaths, limits: SessionLimits, resume?: string): string[] {
  return [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--settings", settingsFile(p.record, role), "--setting-sources", "user",
    "--strict-mcp-config",
    "--tools", TOOLS[role].join(","),
    "--max-turns", String(limits.maxTurns),
    "--max-budget-usd", String(limits.maxBudgetUsd),
    "--model", limits.model,
    "--effort", limits.effort,
    ...(resume === undefined ? [] : ["--resume", resume]),
  ];
}

/**
 * The files whose text defines how a session is held or how a probe tests it, hashed into a probe stamp: change one
 * and the probes must run again before a real session. The session's own layers (guard, profile, session, and
 * select.ts for HIDDEN_TEXT), and the probes themselves (probes.ts, mock-api.ts) — so a change to what a probe
 * asserts, or to the fake API it asserts against, also voids the stamp.
 */
export const PROFILE_FILES = [
  "scripts/agent-runner/guard.ts",
  "scripts/agent-runner/profile.ts",
  "scripts/agent-runner/session.ts",
  "scripts/agent-runner/select.ts",
  "scripts/agent-runner/probes.ts",
  "scripts/agent-runner/mock-api.ts",
];

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Each profile file's hash in an install, by its path. */
export function profileHashes(install: string, read: (path: string) => string | Uint8Array = (path) => readFileSync(path)): Record<string, string> {
  return Object.fromEntries(PROFILE_FILES.map((f) => [f, sha256Hex(read(`${install}/${f}`))]));
}
