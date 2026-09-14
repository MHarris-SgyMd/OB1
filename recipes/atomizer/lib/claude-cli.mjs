/**
 * Shared Claude CLI spawn utilities for the atomizer recipe.
 *
 * We run the `claude` CLI as an argv array with NO shell (SMD-1251), pipe the
 * prompt via stdin so it never touches a command line, and strip the
 * environment variables that Claude CLI uses to detect a nested session —
 * otherwise it refuses to run.
 */

import { spawn } from "node:child_process";

/**
 * Environment variable keys that must be stripped from child processes
 * to prevent Claude CLI from detecting it's inside a Claude Code session.
 */
export const STRIP_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
]);

/**
 * Build a clean child environment with session-detection vars stripped.
 */
export function buildCleanEnv() {
  const childEnv = { ...process.env };
  for (const key of STRIP_KEYS) {
    delete childEnv[key];
  }
  return childEnv;
}

/**
 * Spawn Claude CLI as a child process.
 *
 * @param {string[]} args - full command args (first element is the executable)
 * @param {object} env - environment variables
 * @param {number} timeoutMs - timeout in ms (default 180s)
 * @param {string} [stdinData] - optional data to pipe to stdin
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
/**
 * One shape for every way the spawn can fail, with the hint that fits. The
 * same table as recipes/gmail-smart-pull/scripts/lib/atomize-text.mjs (SMD-1317
 * will give it one home); `safeToLog` tells a slicing caller the message holds
 * no memory text.
 */
export function describeSpawnError(err) {
  const configured = Boolean(process.env.CLAUDE_CLI_PATH);
  const notFound = configured
    ? "CLAUDE_CLI_PATH names a file that does not exist — check the path; it must be a bare executable path (no ~, no $VAR, no flags), since this spawn uses no shell"
    : "`claude` was not found on PATH — install the Claude CLI, or set CLAUDE_CLI_PATH to its executable";
  const notRunnable = "CLAUDE_CLI_PATH is not an executable file (a directory, or a file without the exec bit)";
  const notDir = "a component of CLAUDE_CLI_PATH is not a directory (a trailing slash on the executable, or a file where a directory should be)";
  const win = "on Windows the npm install's claude.cmd shim cannot be run without a shell; use Anthropic's native Windows installer, which provides claude.exe, and point CLAUDE_CLI_PATH at it — or use an HTTP provider";
  // Branch on the code first: EINVAL is Node refusing a .cmd/.bat by name (the
  // file exists), ENOTDIR is a bad path component, EACCES a non-executable —
  // each gets its own remedy, and ENOENT on Windows also names the shim.
  const hint =
    err.code === "EINVAL" && process.platform === "win32" ? ` — ${win}` :
    err.code === "ENOENT" ? ` — ${notFound}${process.platform === "win32" ? `; ${win}` : ""}` :
    err.code === "ENOTDIR" ? ` — ${notDir}` :
    err.code === "EACCES" || err.code === "EPERM" ? ` — ${notRunnable}` :
    "";
  const e = new Error(`Claude CLI spawn error: ${err.message}${hint}`);
  // Spawn failures carry paths and errno text, never model output or memory
  // text, so a caller that slices other errors may log these whole.
  e.safeToLog = true;
  return e;
}

export function spawnClaudeCli(args, env, timeoutMs = 180_000, stdinData = null) {
  return new Promise((resolve, reject) => {
    // No shell (SMD-1251): args is an argv array and the prompt travels on
    // stdin, so nothing here is interpreted. A shell would read metacharacters
    // in CLAUDE_CLI_PATH. The cost: args[0] must be a bare executable path (no
    // ~, no $VAR, no flags), and on Windows the native claude.exe — the bare
    // name is not found through an npm .cmd shim (ENOENT) and a .cmd/.bat the
    // path names is refused (EINVAL, thrown synchronously by spawn()).
    let child;
    try {
      child = spawn(args[0], args.slice(1), {
        stdio: [stdinData ? "pipe" : "ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      reject(describeSpawnError(err));
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    if (stdinData && child.stdin) {
      // A spawn that fails (ENOENT) leaves stdin with no handle, and a CLI that
      // exits before draining a long prompt closes it (EPIPE); either way the
      // write emits 'error' on stdin, which with no listener is an uncaught
      // exception. The child's own 'error'/'close' below report the cause.
      child.stdin.on("error", () => {});
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      killed = true;
      child.kill();
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(describeSpawnError(err));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        // Don't leak stdout/stderr into the error message by default — the
        // Claude CLI often echoes the input prompt, which for this recipe
        // contains arbitrary user memory / email text. Set ATOMIZE_DEBUG=1
        // to include the raw snippets when actively debugging.
        const debug = process.env.ATOMIZE_DEBUG === "1";
        const detail = debug
          ? `\nStderr: ${stderr.substring(0, 500)}\nStdout: ${stdout.substring(0, 200)}`
          : ` (stderr ${stderr.length}B, stdout ${stdout.length}B — set ATOMIZE_DEBUG=1 to see)`;
        reject(new Error(`Claude CLI exited with code ${code}.${detail}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
