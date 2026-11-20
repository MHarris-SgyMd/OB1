/**
 * install.ts — the two things a probe stamp names and nothing made (SMD-4491): the runner's own copy of the pinned
 * Claude Code, and the runner's own checkout. A run starts only under a stamp that matches both, and both were lost
 * once without a word: the binary lived in Claude Code's versions directory, which its updater prunes, and the
 * checkout was a worktree removed when its branch merged.
 *
 *   - copyClaude puts a Claude Code binary at <state>/claude/<version>, owner-only, and answers its checksum;
 *   - makeInstall makes <state>/install, a clone of the runner's bare repository at one commit of main, or moves it to
 *     a newer commit, and names each probed file the move changed;
 *   - stampReport says, before a run is tried, whether the stamp's binary and install are still there and still as
 *     probed, and whether the host is, and names what isn't. It is not every check a run makes: the flags a run is
 *     given and the stamp's own list of probes are stampProblem's alone (probes.ts).
 *
 * Nothing here is hashed into the probe stamp (profile.ts's PROFILE_FILES), and nothing hashed imports it.
 */

import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GitRun } from "./gate.ts";
import { isObject, shownText } from "./guard.ts";
import { PROFILE_FILES, sha256Hex } from "./profile.ts";
import { STAMP_FILE, developerGit, hostStamp, type Host } from "./probes.ts";

/** Where the runner keeps its copies of Claude Code, under its state directory: one file per version. */
export const CLAUDE_DIR = "claude";
/** The runner's own checkout, under its state directory (docs/agent-runner.md, "Secrets and records"). */
export const INSTALL_DIR = "install";

const VERSION = /^\d+\.\d+\.\d+$/;

/** The version a Claude Code binary names itself, from its `--version` line (`2.1.329 (Claude Code)`), or null. */
export function claudeVersion(output: string): string | null {
  const first = output.trim().split(/\s+/)[0] ?? "";
  return VERSION.test(first) ? first : null;
}

export type ClaudeCopy = { path: string; sha256: string; version: string; copied: boolean };

/**
 * Copies a Claude Code binary to `<state>/claude/<version>`: the directory 0700, the file 0500, never through a link.
 * A copy already there with the same bytes is left as it is (`copied: false`); one with other bytes is refused, since
 * a stamp may name it. Throws with the reason for anything refused.
 */
export function copyClaude(state: string, source: string, version: string): ClaudeCopy {
  if (!VERSION.test(version)) throw new Error(`${shownText(version, 40)} is not a version (x.y.z)`);
  let isFile = false;
  try {
    isFile = statSync(source).isFile();
  } catch {
    // reported below
  }
  if (!isFile) throw new Error(`${shownText(source)} is not a file`);
  const sha256 = sha256Hex(readFileSync(source));
  const dir = join(state, CLAUDE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink`);
  chmodSync(dir, 0o700);
  const path = join(dir, version);
  let there: ReturnType<typeof lstatSync> | null = null;
  try {
    there = lstatSync(path);
  } catch {
    // not there yet
  }
  if (there) {
    if (!there.isFile()) throw new Error(`${path} is there and is not a plain file`);
    if (sha256Hex(readFileSync(path)) !== sha256) throw new Error(`${path} holds other bytes than ${shownText(source)}: a stamp may name it, so it is left alone (remove it yourself to replace it)`);
    chmodSync(path, 0o500);
    return { path, sha256, version, copied: false };
  }
  // COPYFILE_EXCL: never over a file or a link that appeared since the look above.
  copyFileSync(source, path, constants.COPYFILE_EXCL);
  chmodSync(path, 0o500);
  if (sha256Hex(readFileSync(path)) !== sha256) throw new Error(`${path} does not read back as ${shownText(source)}`);
  return { path, sha256, version, copied: true };
}

export type InstallResult =
  | { ok: true; path: string; commit: string; from: string | null; changed: string[] }
  | { ok: false; problem: string };

/**
 * Makes the runner's checkout, `<state>/install`, at `commit`, or moves the one there to it. It is a clone of the
 * runner's bare repository (`source`), which objects are copied into, on a detached HEAD: no branch to drift, and
 * nothing shared with a worktree a task works in. `commit` must be a commit of the source's main. A checkout with
 * changes of its own is refused, not overwritten.
 * `changed` names each probed file that differs between the commit it was on and the one it is on now: any there
 * means the probe sweep must run again from it. `from` is null for a checkout just made.
 */
export function makeInstall(git: GitRun, state: string, source: string, commit: string): InstallResult {
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, problem: `${shownText(commit, 60)} is not a full commit id` };
  const path = join(state, INSTALL_DIR);
  const fail = (what: string, stderr: string): InstallResult => ({ ok: false, problem: `${what}: ${shownText(stderr, 300)}` });
  let from: string | null = null;
  if (existsSync(path)) {
    const head = git(["-C", path, "rev-parse", "HEAD"]);
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) return fail(`${path} is there and is not a checkout`, head.stderr);
    from = head.stdout.trim();
    const status = git(["-C", path, "status", "--porcelain"]);
    if (status.code !== 0) return fail(`${path}'s status couldn't be read`, status.stderr);
    if (status.stdout.trim() !== "") return { ok: false, problem: `${path} has changes of its own (${status.stdout.trim().split("\n").length} path(s)): it is left as it is` };
    const fetched = git(["-C", path, "fetch", "--quiet", "--no-tags", source, "+refs/heads/main:refs/remotes/origin/main"]);
    if (fetched.code !== 0) return fail(`fetching ${source} into ${path} failed`, fetched.stderr);
  } else {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const cloned = git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", source, path]);
    if (cloned.code !== 0) return fail(`cloning ${source} to ${path} failed`, cloned.stderr);
  }
  // A clone just made and not put at its commit is removed: left there, it has HEAD and no files, which the next try
  // would read as a checkout with changes of its own and refuse for good. One that was there before stays as it was.
  const undo = (r: InstallResult): InstallResult => {
    if (from === null) rmSync(path, { recursive: true, force: true });
    return r;
  };
  // Only a commit of main: the bare repository also holds the branches agent sessions wrote, and the clone copies
  // them. The install is the code that holds a session, so it is never put at one of those.
  const onMain = git(["-C", path, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
  if (onMain.code !== 0) return undo({ ok: false, problem: `${commit} is not a commit of main in ${source}: the install is put only at one` });
  const out = git(["-C", path, "checkout", "--quiet", "--detach", commit]);
  if (out.code !== 0) return undo(fail(`${path} couldn't be put at ${commit}`, out.stderr));
  const now = git(["-C", path, "rev-parse", "HEAD"]);
  if (now.code !== 0 || now.stdout.trim() !== commit) return undo(fail(`${path} is not at ${commit} after the checkout`, now.stderr));
  let changed: string[] = [];
  if (from !== null && from !== commit) {
    const diff = git(["-C", path, "diff", "--name-only", from, commit, "--", ...PROFILE_FILES]);
    if (diff.code !== 0) return fail("the probed files' changes couldn't be read", diff.stderr);
    changed = diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  }
  return { ok: true, path, commit, from, changed };
}

export type StampLine = { ok: boolean; text: string };

/** The host as it is now, for stampReport, or null where there is no developer git to read (off macOS, where no stamp is made). */
export async function hostNow(): Promise<Host | null> {
  let git: string | null = null;
  try {
    git = developerGit();
  } catch {
    // no xcode-select
  }
  return git === null ? null : hostStamp(process.execPath, git);
}

const fileSha = (path: string): string | null => {
  try {
    return statSync(path).isFile() ? sha256Hex(readFileSync(path)) : null;
  } catch {
    return null;
  }
};

/**
 * What the probe stamp in `state` says of its binary and its install, as they are now: one line each, `ok: false` for
 * anything a run would be refused for. `here` is the checkout a run would start from (the one this script is in).
 * `host` is the host as it is now, or null to leave Bun, git and the macOS build unread (off macOS). It reads, and
 * changes nothing; stampProblem in probes.ts stays the check a run makes.
 */
export function stampReport(state: string, here: string, host: Host | null): { ok: boolean; lines: StampLine[] } {
  const stampPath = join(state, STAMP_FILE);
  let stamp: unknown;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    stamp = null;
  }
  if (!isObject(stamp)) return { ok: false, lines: [{ ok: false, text: `no probe stamp at ${stampPath}: run the probes from the install, on the runner's copy of Claude Code` }] };
  const lines: StampLine[] = [];
  const say = (ok: boolean, text: string): void => {
    lines.push({ ok, text });
  };

  const claude = isObject(stamp.claude) ? stamp.claude : {};
  const claudePath = typeof claude.path === "string" ? claude.path : null;
  const version = typeof claude.version === "string" ? shownText(claude.version, 40) : "?";
  if (claudePath === null) say(false, "the stamp names no Claude Code: run the probes again");
  else {
    const sha = fileSha(claudePath);
    if (sha === null) say(false, `the stamp's Claude Code ${version} is gone: ${shownText(claudePath)} (copy it again with setup.ts claude, then run the probes)`);
    else if (sha !== claude.sha256) say(false, `${shownText(claudePath)} is not the Claude Code ${version} the probes ran on: its bytes changed`);
    else {
      const own = claudePath.startsWith(`${join(state, CLAUDE_DIR)}/`);
      say(true, `Claude Code ${version} at ${shownText(claudePath)}, as probed${own ? "" : " — outside the runner's directory, where an updater can remove it (setup.ts claude makes the runner's copy)"}`);
    }
  }

  const install = typeof stamp.install === "string" ? stamp.install : null;
  const profile = isObject(stamp.profile) ? stamp.profile : {};
  if (install === null) say(false, "the stamp names no install: run the probes again");
  else if (!existsSync(install)) say(false, `the stamp's install is gone: ${shownText(install)} (make it with setup.ts checkout, then run the probes from it)`);
  else {
    const differ = PROFILE_FILES.filter((f) => fileSha(join(install, f)) !== profile[f]);
    if (differ.length) say(false, `${differ.length} of the install's probed files differ from the stamp (${differ.join(", ")}): run the probes again from ${shownText(install)}`);
    else say(true, `the install ${shownText(install)}, its ${PROFILE_FILES.length} probed files as probed`);
    if (install !== here) say(false, `this checkout (${shownText(here)}) is not the stamp's install: a run starts from ${shownText(install)}`);
  }

  if (host !== null) {
    const was = isObject(stamp.host) ? stamp.host : {};
    const moved = [["Bun", "bunSha"], ["git", "gitSha"], ["the macOS build", "osBuild"]].filter(([, k]) => was[k] !== host[k as keyof Host]).map(([name]) => name);
    if (moved.length) say(false, `${moved.join(", ")} changed since the probes ran: run them again`);
    else say(true, "Bun, git and the macOS build, as probed");
  }
  return { ok: lines.every((l) => l.ok), lines };
}
