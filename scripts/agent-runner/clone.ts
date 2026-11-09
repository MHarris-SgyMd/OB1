/**
 * clone.ts — the per-run clone (SMD-4087 cut 2b-2a; docs/agent-runner.md, "A run, step by step" step 4). The runner
 * gives each run a fresh clone of its bare repository, at the base commit, on the run's branch, so a session writes
 * only inside its own clone and can't reach the bare repository's objects.
 *
 * `--no-hardlinks`: a local clone hard-links the bare repository's object files by default, so the clone and the bare
 * repository share objects on disk. Copying them instead makes the clone independent — a session can't corrupt the
 * bare repository through a shared object, and the gate later reads the branch from the untouched bare repository.
 *
 * The clone's git identity is set to the bot, with signing off, so the session's commits are the bot's and unsigned —
 * the two the gate checks (gate.ts checkBranch). The runner installs dependencies, writes the profiles and starts the
 * session on this clone; those are cut 2b-2. Pure over an injected git (gate.ts's GitRun), so it runs on fixtures.
 */

import { GitRun } from "./gate.ts";

export type CloneInput = {
  /** The runner's bare repository to clone from. */
  bareRepo: string;
  /** The base commit the clone is placed at. */
  base: string;
  /** The branch the session commits on, `agent/smd-<n>-<slug>` (record.ts branchFor). */
  branch: string;
  /** Where the clone is made: the run directory's clone path (record.ts clonePath). Must not already exist. */
  dest: string;
  /** The bot the session's commits must be by (gate.ts checkBranch). */
  bot: { name: string; email: string };
  /** git, run with the runner's own config and environment; a test stands in for it. */
  git: GitRun;
};

export type CloneResult = { ok: boolean; problem: string | null };

/** Trim and shorten git's stderr for a problem message. */
const detail = (stderr: string): string => {
  const s = stderr.replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};

/**
 * Clones the bare repository into `dest`, copies the objects (no hard links), puts the clone at `base` on `branch`, and
 * sets the bot identity with signing off. Returns the first step that failed, or ok. It writes nothing but through git.
 */
export function prepareClone(input: CloneInput): CloneResult {
  const { bareRepo, base, branch, dest, bot, git } = input;
  const fail = (what: string, stderr: string): CloneResult => ({ ok: false, problem: `${what} failed: ${detail(stderr)}` });

  const clone = git(["clone", "--no-hardlinks", "--quiet", bareRepo, dest]);
  if (clone.code !== 0) return fail("git clone", clone.stderr);

  // Place the clone at the base commit on the run's branch. The clone holds every object, so the base is present.
  const sw = git(["-C", dest, "switch", "--quiet", "--create", branch, base]);
  if (sw.code !== 0) return fail(`switch to ${branch} at the base`, sw.stderr);

  // The session's commits must be the bot's and unsigned (gate.ts checkBranch).
  const settings: [string, string][] = [["user.name", bot.name], ["user.email", bot.email], ["commit.gpgsign", "false"]];
  for (const [key, value] of settings) {
    const c = git(["-C", dest, "config", key, value]);
    if (c.code !== 0) return fail(`set ${key}`, c.stderr);
  }
  return { ok: true, problem: null };
}
