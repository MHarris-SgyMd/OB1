/**
 * session.ts — starts one runner session and watches it to its end (SMD-4088; docs/agent-runner.md, decision 3 and
 * layer 5). Before it starts the session it checks the pinned Claude Code against its recorded checksum, writes the
 * session's settings into the run's record and reads them back, and checks that Claude Code's config directory holds
 * no settings file. It starts the binary in a process group of its own, with the environment and command line
 * profile.ts builds and the prompt on stdin, and reads the stream as it comes:
 *
 *   - the init event must show the pinned version, dontAsk, the key helper as the key's source (a settings file that
 *     fails validation is ignored without a word, so this is how a profile that didn't load shows), exactly the
 *     role's tools, no MCP server, the model, and the root as the working directory; else the session is ended;
 *   - each tool result must answer a call the guard logged, else the session is ended: the backstop for a call the
 *     guard never saw;
 *   - at its time limit the session is ended: its process group and every process it started, the sandboxed ones
 *     included.
 *
 * It returns what the stream said, for the run's record: the init and the result (cost, turns, denials), each tool
 * call and result, and why the session ended.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { TOOLS, shownText, type Role } from "./guard.ts";
import { guardLog, pathsProblem, sessionArgs, sessionEnv, settingsFile, type SessionLimits, type SessionPaths } from "./profile.ts";

/** The pinned Claude Code: the runner's copy, its recorded checksum, and the version its init event must show. */
export type Pinned = { path: string; sha256: string; version: string };

export type SessionSpec = {
  role: Role;
  paths: SessionPaths;
  limits: SessionLimits;
  pinned: Pinned;
  /** The session's first message, on stdin. */
  prompt: string;
  /** The settings text to write and start with: profile.ts's template for the role (settingsText), or a probe's variant. */
  settings: string;
  timeLimitMs: number;
  user: string;
  uid: number;
  /** The probes' stand-in for the Messages API; a real run has none. */
  baseUrl?: string;
  /** A session to resume (the worker, with the review's findings). */
  resume?: string;
};

export type InitSummary = { version: unknown; permissionMode: unknown; apiKeySource: unknown; tools: unknown; mcpServers: unknown; model: unknown; cwd: unknown; sessionId: unknown; skills: unknown; slashCommands: unknown };
export type ResultSummary = { subtype: unknown; isError: unknown; numTurns: unknown; totalCostUsd: unknown; permissionDenials: unknown; terminalReason: unknown };
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; isError: boolean; text: string };
/** Why a session ended: its result, its process exiting without one, a failed init check, a tool result the guard never logged, its time limit, or a refusal before it started. */
export type Ended = "result" | "exit" | "init" | "unlogged-call" | "time" | "refused";

export type SessionOutcome = {
  ended: Ended;
  why: string;
  init: InitSummary | null;
  result: ResultSummary | null;
  exitCode: number | null;
  signal: string | null;
  calls: ToolCall[];
  results: ToolResult[];
  stderr: string;
};

/** What the launcher takes from its process, so the self-check can stand in for it. */
export type SessionDeps = {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  sha256: (path: string) => Promise<string>;
  /** The processes a pid started, to the leaves, so a session's sandboxed commands end with it. */
  descendants: (pid: number) => number[];
  kill: (pid: number, signal: NodeJS.Signals) => void;
  graceMs: number;
};

/** A file's sha256, read as a stream: the pinned binary is some hundreds of megabytes. */
export async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Every process under `pid`: the tree as it stands, read before anything is signalled. From `ps` (macOS, where the
 * runner runs), else from Linux's /proc (a slim container without `ps`, where the self-check may run), else none: the
 * process group is still signalled.
 */
export function psDescendants(pid: number): number[] {
  try {
    const r = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) return descendantsOf(pid, r.stdout.toString());
  } catch {
    // no ps here
  }
  try {
    const rows: string[] = [];
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        rows.push(`${d} ${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]}`);
      } catch {
        // gone meanwhile
      }
    }
    return descendantsOf(pid, rows.join("\n"));
  } catch {
    return [];
  }
}

/** The descendants of `pid` in `ps -o pid=,ppid=` output. */
export function descendantsOf(pid: number, psOutput: string): number[] {
  const kids = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  const out: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    for (const c of kids.get(stack.pop() as number) ?? []) {
      if (!out.includes(c) && c !== pid) {
        out.push(c);
        stack.push(c);
      }
    }
  }
  return out;
}

export const REAL_DEPS: SessionDeps = {
  spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
  sha256: fileSha256,
  descendants: psDescendants,
  kill: (pid, signal) => process.kill(pid, signal),
  graceMs: 3_000,
};

/** The reason an init event isn't the session the runner started, or null (layer 5). */
export function initProblem(ev: Record<string, unknown>, role: Role, pinned: Pinned, limits: SessionLimits, root: string): string | null {
  const show = (v: unknown) => shownText(JSON.stringify(v) ?? String(v), 120);
  if (ev.claude_code_version !== pinned.version) return `Claude Code ${show(ev.claude_code_version)}, not the pinned ${pinned.version}`;
  if (ev.permissionMode !== "dontAsk") return `permission mode ${show(ev.permissionMode)}, not dontAsk`;
  if (ev.apiKeySource !== "apiKeyHelper") return `the key's source is ${show(ev.apiKeySource)}, not apiKeyHelper: the settings didn't load (a settings file that fails validation is ignored without a word)`;
  const want = [...TOOLS[role]].sort();
  const tools = Array.isArray(ev.tools) && ev.tools.every((t) => typeof t === "string") ? [...(ev.tools as string[])].sort() : null;
  if (tools === null || tools.length !== want.length || tools.some((t, i) => t !== want[i])) return `tools ${show(ev.tools)}, not exactly the ${role}'s (${want.join(", ")})`;
  if (!Array.isArray(ev.mcp_servers) || ev.mcp_servers.length !== 0) return `MCP servers ${show(ev.mcp_servers)}, where the profile has none`;
  if (ev.model !== limits.model) return `model ${show(ev.model)}, not ${limits.model}`;
  if (ev.cwd !== root) return `working directory ${show(ev.cwd)}, not the session's root`;
  return null;
}

/** The tool-call ids a guard log names. An unreadable log names none, so every result ends the session. */
export function loggedIds(path: string): Set<string> {
  const ids = new Set<string>();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return ids;
  }
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line) as { id?: unknown };
      if (typeof entry.id === "string") ids.add(entry.id);
    } catch {
      // a partial last line: the next read sees it whole
    }
  }
  return ids;
}

/** A tool result's content as text, cut at 20,000 characters for the record. */
export function resultText(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
      : "";
  return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text;
}

/** Writes a file whole, never through a link, owner-only. */
export function writeNoFollow(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Reads a file whole, never through a link. */
export function readNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Claude Code's settings files, which the runner's config directory must not hold: only the profile configures a session. */
export const CONFIG_SETTINGS = ["settings.json", "settings.local.json"];

/** Appends to a record file, never through a link. */
function appendNoFollow(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Starts the session, watches its stream, and returns how it went. It never throws for the session's sake: a refusal or failure is an outcome. */
export async function runSession(spec: SessionSpec, deps: SessionDeps = REAL_DEPS): Promise<SessionOutcome> {
  const outcome: SessionOutcome = { ended: "refused", why: "", init: null, result: null, exitCode: null, signal: null, calls: [], results: [], stderr: "" };
  const refuse = (why: string): SessionOutcome => ({ ...outcome, ended: "refused", why });
  const problem = pathsProblem(spec.paths, spec.uid);
  if (problem) return refuse(problem);
  const sha = await deps.sha256(spec.pinned.path).catch(() => null);
  if (sha !== spec.pinned.sha256) return refuse(`the binary at ${spec.pinned.path} ${sha === null ? "can't be read" : `has checksum ${sha}`}, not the pinned ${spec.pinned.sha256}`);
  const file = settingsFile(spec.paths.record, spec.role);
  try {
    writeNoFollow(file, spec.settings);
    if (readNoFollow(file) !== spec.settings) return refuse("the settings file read back isn't what the runner wrote");
  } catch (e) {
    return refuse(`the settings file can't be written and read back (${shownText((e as Error)?.message ?? e)})`);
  }
  const stray = CONFIG_SETTINGS.find((f) => existsSync(`${spec.paths.configDir}/${f}`));
  if (stray) return refuse(`the config directory holds ${stray}, which would configure the session beside its profile`);

  const streamFile = `${spec.paths.record}/stream-${spec.role}.jsonl`;
  const log = guardLog(spec.paths.record, spec.role);
  let child: ChildProcess;
  try {
    child = deps.spawn(spec.pinned.path, sessionArgs(spec.role, spec.paths, spec.limits, spec.resume), {
      cwd: spec.paths.root,
      env: sessionEnv(spec.paths, spec.user, spec.baseUrl),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return refuse(`Claude Code didn't start (${shownText((e as Error)?.message ?? e)})`);
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
  let ending: Promise<void> | null = null;
  const end = (kind: Ended, why: string): Promise<void> => {
    if (ending) return ending;
    outcome.ended = kind;
    outcome.why = why;
    ending = (async () => {
      const pid = child.pid;
      if (pid === undefined) return;
      let tree: number[] = [];
      try {
        tree = deps.descendants(pid);
      } catch {
        // the group is still signalled
      }
      const signal = (sig: NodeJS.Signals) => {
        for (const p of [-pid, ...tree]) {
          try {
            deps.kill(p, sig);
          } catch {
            // already gone
          }
        }
      };
      signal("SIGTERM");
      await Promise.race([exited, Bun.sleep(deps.graceMs)]);
      signal("SIGKILL");
    })();
    return ending;
  };
  const timer = setTimeout(() => void end("time", `its time limit of ${spec.timeLimitMs} ms ran out`), spec.timeLimitMs);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 20_000) stderr += d.toString();
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(spec.prompt);

  let buffered = "";
  const take = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    try {
      appendNoFollow(streamFile, `${line}\n`);
    } catch {
      // the record is the runner's own; a failed append doesn't stop the watch
    }
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(ev)) return;
    if (ev.type === "system" && ev.subtype === "init") {
      outcome.init = { version: ev.claude_code_version, permissionMode: ev.permissionMode, apiKeySource: ev.apiKeySource, tools: ev.tools, mcpServers: ev.mcp_servers, model: ev.model, cwd: ev.cwd, sessionId: ev.session_id, skills: ev.skills, slashCommands: ev.slash_commands };
      const p = initProblem(ev, spec.role, spec.pinned, spec.limits, spec.paths.root);
      if (p) await end("init", p);
      return;
    }
    const message = isObject(ev.message) ? ev.message : null;
    const blocks = message && Array.isArray(message.content) ? message.content.filter(isObject) : [];
    if ((ev.type === "assistant" || ev.type === "user") && outcome.init === null) {
      await end("init", "a turn came before the init event");
      return;
    }
    if (ev.type === "assistant") {
      for (const b of blocks) if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") outcome.calls.push({ id: b.id, name: b.name, input: b.input });
    } else if (ev.type === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        outcome.results.push({ id: b.tool_use_id, isError: b.is_error === true, text: resultText(b.content) });
        if (!loggedIds(log).has(b.tool_use_id)) await end("unlogged-call", `a result came for call ${shownText(b.tool_use_id, 80)}, which the guard never logged`);
      }
    } else if (ev.type === "result") {
      outcome.result = { subtype: ev.subtype, isError: ev.is_error, numTurns: ev.num_turns, totalCostUsd: ev.total_cost_usd, permissionDenials: ev.permission_denials, terminalReason: ev.terminal_reason };
    }
  };
  if (child.stdout) {
    for await (const chunk of child.stdout) {
      buffered += (chunk as Buffer).toString();
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        await take(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf("\n");
      }
    }
  }
  await take(buffered);
  const { code, signal } = await exited;
  clearTimeout(timer);
  if (ending) await ending;
  outcome.exitCode = code;
  outcome.signal = signal;
  outcome.stderr = stderr;
  try {
    if (stderr) appendNoFollow(`${spec.paths.record}/stderr-${spec.role}.log`, stderr);
  } catch {
    // as above
  }
  if (outcome.ended === "refused" && outcome.why === "") {
    outcome.ended = outcome.result ? "result" : "exit";
    outcome.why = outcome.result ? `its result: ${shownText(String(outcome.result.subtype), 80)}` : `it exited ${code ?? signal} without a result`;
  }
  return outcome;
}
