/**
 * bundle.ts — verify and import a session's branch bundle (SMD-4087 cut 2b-2b-1; docs/agent-runner.md, "A run, step by
 * step" step 6). The worker session hands its work back as a git bundle it writes into the run's temp directory; the
 * bundle is untrusted, like everything the session produced. The runner checks it is a plain bundle of exactly the run's
 * one branch, then imports that branch into its bare repository, where the gate (gate.ts) reads it as data. No session
 * runs here; the orchestration that produces the bundle and calls this is cut 2b-2b-2.
 *
 * The checks (docs step 6): a regular file, opened without following a link, so a session can't aim the path at
 * something else or block the open on a fifo; `git bundle verify` in the bare repository, so it is a real bundle whose
 * prerequisites the base commit supplies; and exactly one ref, refs/heads/agent/smd-<n>-<slug>, the run's branch, so a
 * second ref can't sneak a commit in. The import fetches that one ref with fetch.fsckObjects, so a malformed or
 * malicious object is refused on the way in.
 */

import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { GitRun } from "./gate.ts";

export type BundleInput = {
  /** The bundle the session wrote, in the run's temp directory. */
  bundlePath: string;
  /** The runner's bare repository, which the branch is imported into. */
  bareRepo: string;
  /** The run's branch without refs/heads/, e.g. `agent/smd-9-x` (record.ts branchFor). */
  branch: string;
  /** git, run with the runner's own config and environment; a test stands in for it. */
  git: GitRun;
};

export type BundleResult = { ok: boolean; problem: string | null };

/** Trim and shorten git's stderr for a problem message. */
const detail = (stderr: string): string => {
  const s = stderr.replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};

/** The run's branch as a fully-qualified ref. */
export const refOf = (branch: string): string => `refs/heads/${branch}`;

/**
 * Whether the bundle is a plain bundle of exactly the run's one branch, or the reason it isn't: a regular file opened
 * without following a link, a valid bundle in the bare repository, and exactly one ref (the run's branch). It reads the
 * bundle and runs git; it changes nothing.
 */
export function verifyBundle(input: BundleInput): BundleResult {
  const { bundlePath, bareRepo, branch, git } = input;

  // A regular file, opened without following a link, and without blocking on a fifo or device (O_NONBLOCK).
  let fd: number;
  try {
    fd = openSync(bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return { ok: false, problem: `the bundle can't be opened as a plain file (no symlink): ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, problem: "the bundle path is not a regular file" };
  } finally {
    closeSync(fd);
  }

  // A valid bundle in the bare repository (its prerequisites present there).
  const verify = git(["-C", bareRepo, "bundle", "verify", bundlePath]);
  if (verify.code !== 0) return { ok: false, problem: `git bundle verify failed: ${detail(verify.stderr)}` };

  // Exactly one ref, the run's branch.
  const heads = git(["-C", bareRepo, "bundle", "list-heads", bundlePath]);
  if (heads.code !== 0) return { ok: false, problem: `git bundle list-heads failed: ${detail(heads.stderr)}` };
  const refs = heads.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => l.split(/\s+/)[1] ?? "");
  if (refs.length !== 1) return { ok: false, problem: `the bundle must hold exactly one ref; it holds ${refs.length}${refs.length ? `: ${refs.join(", ")}` : ""}` };
  if (refs[0] !== refOf(branch)) return { ok: false, problem: `the bundle's ref is ${refs[0]}, not the run's branch ${refOf(branch)}` };

  return { ok: true, problem: null };
}

/**
 * Imports the bundle's one ref into the bare repository, checking every object (fetch.fsckObjects). Call verifyBundle
 * first. The branch then lives in the bare repository for the gate to read.
 */
export function importBundle(input: BundleInput): BundleResult {
  const { bundlePath, bareRepo, branch, git } = input;
  const ref = refOf(branch);
  const fetched = git(["-C", bareRepo, "-c", "fetch.fsckObjects=true", "fetch", "--no-tags", bundlePath, `${ref}:${ref}`]);
  if (fetched.code !== 0) return { ok: false, problem: `git fetch from the bundle failed: ${detail(fetched.stderr)}` };
  return { ok: true, problem: null };
}
