/**
 * setup.ts — place and check the runner's identities (SMD-4089): the agent-kind brain key, the Linear key, the bot's
 * GitHub token and the Anthropic API key, each in its own 0600 file under the runner's directory. Creating the accounts
 * and minting the keys is the maintainer's, on the brain host (CLAUDE.md, "Keys"); this tool only writes a minted
 * secret into the right file, by the key's own shape, without ever printing it, and verifies it through the runner's own
 * owner-only read (dry-run.ts) — so a value it accepts is one the runner will read. Rotation is the same two steps:
 * install the new value, then verify. The secret is read from the clipboard (pbpaste) or, with --stdin, from stdin; it
 * never passes on the command line, and no command here echoes it.
 *
 *   bun scripts/agent-runner/setup.ts dirs                       # make the directory (0700), idempotent
 *   bun scripts/agent-runner/setup.ts install linear            # copy the key to the clipboard first; this reads it
 *   bun scripts/agent-runner/setup.ts install brain --stdin     # or read the key from stdin
 *   bun scripts/agent-runner/setup.ts verify [--bot <login>]    # each secret present, 0600, right shape (+ the fork),
 *                                                               # and what the probe stamp says of its binary and install
 *   bun scripts/agent-runner/setup.ts claude <path>             # the runner's own copy of that Claude Code (SMD-4491)
 *   bun scripts/agent-runner/setup.ts checkout [--commit <sha>] # the runner's own checkout, made or moved (SMD-4491)
 *   bun scripts/agent-runner/setup.ts check-github <bot-login>  # the fork exists and the bot can't push here (needs gh)
 *   bun scripts/agent-runner/setup.ts --self-check              # offline
 *
 * Run it as the dry run is, reading no ambient config: bun --no-env-file --config=/dev/null scripts/agent-runner/setup.ts …
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_FILES, KEY_SHAPES, parseConfig, privateDirProblem, readKey, readOwnedFile, RUNNER_DIR } from "./dry-run.ts";
import { fixtureGit } from "./fixture-git.ts";
import type { GitRun } from "./gate.ts";
import { CLAUDE_DIR, INSTALL_DIR, claudeVersion, copyClaude, hostNow, makeInstall, stampReport } from "./install.ts";
import { STATE_DIR, ensureBareRepo, gitRunner, installDir } from "./live-run.ts";
import { STAMP_FILE, type Host } from "./probes.ts";
import { PROFILE_FILES, sha256Hex } from "./profile.ts";

/** This repo, as the config's `repo` defaults to it: the upstream the bot forks and must not be able to push to. */
const OWNER_REPO = "MHarris-SgyMd/OB1";

/** The Anthropic key isn't one the runner reads (Claude Code reads it through apiKeyHelper), so it isn't in KEY_FILES; it lives beside the others. */
const ANTHROPIC = { file: "anthropic.key", shape: /^sk-ant-[A-Za-z0-9_-]{16,}$/ } as const;

/** Which identity: the three keys the runner reads, and the Anthropic key apiKeyHelper reads. */
export type Which = keyof typeof KEY_FILES | "anthropic";
export const WHICHES: Which[] = [...(Object.keys(KEY_FILES) as (keyof typeof KEY_FILES)[]), "anthropic"];

/** A key's file, its shape, and how to describe the shape in a message (never a value). */
export function spec(which: Which): { file: string; shape: RegExp; label: string } {
  if (which === "anthropic") return { file: ANTHROPIC.file, shape: ANTHROPIC.shape, label: "sk-ant-…" };
  const label = which === "linear" ? "lin_api_… or lin_oauth_…" : which === "brain" ? "64 hex (keygen.ts)" : "ghp_… or github_pat_…";
  return { file: KEY_FILES[which], shape: KEY_SHAPES[which], label };
}

/** The secret to install: the clipboard by default, or stdin with --stdin. Never echoed. */
export function readSecret(source: "clipboard" | "stdin"): string {
  if (source === "stdin") {
    try {
      return readFileSync(0, "utf8");
    } catch (e) {
      throw new Error(`couldn't read the key from stdin (${(e as Error).message})`);
    }
  }
  const r = spawnSync("pbpaste", { encoding: "utf8", maxBuffer: 1 << 20 });
  if (r.error || r.status !== 0) {
    throw new Error(`couldn't read the clipboard with pbpaste (${r.error?.message ?? `exit ${r.status}`}); copy the key and retry, or pass --stdin`);
  }
  return r.stdout ?? "";
}

/** Verify one identity through the runner's own owner-only read: present, 0600, one link, of the key's shape. Never throws, never shows the value. */
export function verifyOne(dir: string, which: Which): { ok: boolean; detail: string } {
  try {
    if (which === "anthropic") {
      const text = readOwnedFile(join(dir, ANTHROPIC.file), true);
      if (text === null) return { ok: false, detail: "missing" };
      if (!ANTHROPIC.shape.test(text.trim())) return { ok: false, detail: "present but not an sk-ant-… key (value not shown)" };
      return { ok: true, detail: "present · 0600 · owner-only · sk-ant-… shape" };
    }
    const value = readKey(dir, which);
    if (value === null) return { ok: false, detail: "missing" };
    return { ok: true, detail: `present · 0600 · owner-only · ${spec(which).label}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** Install a secret value into its 0600 file, by its shape, read back through the runner's own check. The value is never printed. */
export function installValue(dir: string, which: Which, value: string): { file: string; bytes: number } {
  const s = spec(which);
  const v = value.trim();
  if (!v) throw new Error(`there was nothing to write for the ${which} key (clipboard or stdin was empty)`);
  if (!s.shape.test(v)) throw new Error(`that value isn't shaped like a ${which} key (expected ${s.label}); nothing written, and the value is not shown`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, s.file);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`${path} is a symlink; refusing to write a secret through it`);
    throw new Error(`${path} can't be written (${code})`);
  }
  try {
    writeSync(fd, `${v}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  const back = verifyOne(dir, which);
  if (!back.ok) throw new Error(`stored ${s.file}, but it didn't read back cleanly: ${back.detail}`);
  return { file: s.file, bytes: v.length };
}

/** Install from the clipboard or stdin. */
export function install(dir: string, which: Which, source: "clipboard" | "stdin"): { file: string; bytes: number } {
  return installValue(dir, which, readSecret(source));
}

/** With gh: the bot's fork exists and the bot can't push to this repo. Needs network and gh auth; not in the offline self-check. */
export function checkGithub(bot: string): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const col = spawnSync("gh", ["api", "-i", `repos/${OWNER_REPO}/collaborators/${bot}`], { encoding: "utf8", timeout: 20_000 });
  if (col.error) return { ok: false, lines: [`gh isn't available (${col.error.message})`] };
  const status = (col.stdout ?? "").match(/^HTTP\/[\d.]+ (\d{3})/m)?.[1] ?? "?";
  if (status === "404") lines.push(`✓ ${bot} is not a collaborator on ${OWNER_REPO} (it can't push here)`);
  else if (status === "204") {
    ok = false;
    lines.push(`✗ ${bot} is a collaborator on ${OWNER_REPO} — it should have no write access here`);
  } else {
    ok = false;
    lines.push(`✗ the collaborator check returned HTTP ${status}, not 404 — could not confirm ${bot} has no write access to ${OWNER_REPO}`);
  }
  const fork = spawnSync("gh", ["api", `repos/${bot}/OB1`, "--jq", "[.fork, .parent.full_name] | @tsv"], { encoding: "utf8", timeout: 20_000 });
  if (fork.status !== 0) {
    ok = false;
    lines.push(`✗ no readable fork ${bot}/OB1 (gh exit ${fork.status})`);
  } else {
    const [isFork, parent] = (fork.stdout ?? "").trim().split("\t");
    if (isFork === "true" && parent === OWNER_REPO) lines.push(`✓ ${bot}/OB1 is a fork of ${OWNER_REPO}`);
    else {
      ok = false;
      lines.push(`✗ ${bot}/OB1 is fork=${isFork || "?"} parent=${parent || "none"} (expected a fork of ${OWNER_REPO})`);
    }
  }
  return { ok, lines };
}

/**
 * `setup.ts checkout`: reads the runner's config for the main checkout, brings the runner's bare repository to its
 * origin/main (the one source the install clones), and makes or moves the install: to `commit`, or to that main.
 * Every path is the caller's, so the self-check runs it whole on a temp directory.
 */
export function checkout(io: { runnerDir: string; state: string; home: string; git: GitRun; commit: string | null }): { ok: boolean; lines: string[] } {
  const no = (why: string): { ok: boolean; lines: string[] } => ({ ok: false, lines: [`✗ ${why}`] });
  const configPath = join(io.runnerDir, "config.json");
  let text: string | null;
  try {
    text = readOwnedFile(configPath, false);
  } catch (e) {
    return no((e as Error).message);
  }
  if (text === null) return no(`no config at ${configPath}`);
  const cfg = parseConfig(text, io.home);
  if ("error" in cfg) return no(`${configPath}: ${cfg.error}`);
  const bareRepo = join(io.state, "repo.git");
  const bare = ensureBareRepo(io.git, bareRepo, cfg.mainCheckout);
  if (!bare.ok) return no(bare.problem);
  const made = makeInstall(io.git, io.state, bareRepo, io.commit ?? bare.base);
  if (!made.ok) return no(made.problem);
  const lines = [`✓ ${made.path} is at ${made.commit}${made.from === null ? " (made)" : made.from === made.commit ? " (as it was)" : ` (moved from ${made.from})`}`];
  if (made.from === null) lines.push("  Run the probes from it before a run: no stamp names it yet.");
  else if (made.changed.length) lines.push(`  The move changed ${made.changed.length} probed file(s): ${made.changed.join(", ")}. Run the probes again from it.`);
  else if (made.from !== made.commit) lines.push("  The move changed no probed file: a stamp made from it still holds.");
  return { ok: true, lines };
}

/** Offline self-check: the shape gate, the 0600 write, the no-symlink write, the owner-only read, and the directory check — on a temp directory, no clipboard, no network. */
export function selfCheck(): number {
  let passed = 0;
  let failed = 0;
  const ok = (cond: unknown, what: string): void => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const section = (name: string, body: () => void): void => {
    console.log(name);
    try {
      body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: it threw (${String((e as Error)?.message ?? e).slice(0, 160)})`);
    }
  };
  /** The message a call throws, or "" when it doesn't. */
  const refuses = (body: () => unknown): string => {
    try {
      body();
      return "";
    } catch (e) {
      return String((e as Error)?.message ?? e);
    }
  };
  const FAKE: Record<Which, string> = {
    linear: `lin_api_${"a".repeat(24)}`,
    brain: "0123456789abcdef".repeat(4),
    github: `ghp_${"A".repeat(36)}`,
    anthropic: `sk-ant-${"A".repeat(28)}`,
  };
  const root = mkdtempSync(join(tmpdir(), "obr-setup-"));
  try {
    section("a valid value of each shape installs 0600 and reads back", () => {
      const dir = join(root, "ok");
      for (const which of WHICHES) {
        const r = installValue(dir, which, FAKE[which]);
        ok((statSync(join(dir, r.file)).mode & 0o777) === 0o600, `${which}: ${r.file} is mode 0600`);
        ok(verifyOne(dir, which).ok, `${which}: verify says present and of the right shape`);
      }
    });

    section("a value of the wrong shape is refused, nothing written, the value never shown", () => {
      const dir = join(root, "bad");
      const sentinel = "NOT-A-KEY-SECRETSENTINEL-0000";
      let message = "";
      try {
        installValue(dir, "github", sentinel);
      } catch (e) {
        message = (e as Error).message;
      }
      ok(message !== "" && !message.includes("SECRETSENTINEL"), "the refusal names the shape, not the value");
      ok(!existsSync(join(dir, "github.token")), "the refused write created no file");
    });

    section("re-installing overwrites the old value (rotation)", () => {
      const dir = join(root, "rotate");
      installValue(dir, "brain", "a".repeat(64));
      installValue(dir, "brain", "f".repeat(64));
      ok(readKey(dir, "brain") === "f".repeat(64), "the second value replaced the first");
    });

    section("a symlink at the target is refused, its target left alone (O_NOFOLLOW)", () => {
      const dir = join(root, "sym");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "untouched");
      symlinkSync(outside, join(dir, "linear.key"));
      let message = "";
      try {
        installValue(dir, "linear", FAKE.linear);
      } catch (e) {
        message = (e as Error).message;
      }
      ok(/symlink|link/.test(message), "writing through a symlink is refused");
      ok(readFileSync(outside, "utf8") === "untouched", "the symlink's target was not written");
    });

    section("verify catches a world-readable key and a missing one", () => {
      const dir = join(root, "perm");
      installValue(dir, "linear", FAKE.linear);
      chmodSync(join(dir, "linear.key"), 0o644);
      const bad = verifyOne(dir, "linear");
      ok(!bad.ok && !bad.detail.includes(FAKE.linear), "a 0644 key fails verify, value not shown");
      chmodSync(join(dir, "linear.key"), 0o600);
      ok(verifyOne(dir, "linear").ok, "back at 0600 it passes");
      ok(verifyOne(dir, "brain").detail === "missing", "an absent key reads as missing");
    });

    section("the directory check wants 0700 and yours", () => {
      const dir = join(root, "dir");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      ok(privateDirProblem(dir) === null, "a 0700 directory passes");
      chmodSync(dir, 0o755);
      ok(privateDirProblem(dir) !== null, "a 0755 directory is flagged");
      chmodSync(dir, 0o700);
    });

    section("the version a Claude Code binary names", () => {
      ok(claudeVersion("2.1.329 (Claude Code)\n") === "2.1.329", "the first word of its --version line");
      ok(claudeVersion("claude 2.1.329") === null && claudeVersion("") === null && claudeVersion("2.1 (Claude Code)") === null, "anything else is no version");
    });

    section("the runner's own copy of Claude Code (SMD-4491)", () => {
      const state = join(root, "state-claude");
      const bin = join(root, "claude-bin");
      writeFileSync(bin, "#!/bin/sh\necho one\n", { mode: 0o755 });
      const first = copyClaude(state, bin, "2.1.329");
      ok(first.copied && first.path === join(state, CLAUDE_DIR, "2.1.329") && first.sha256 === sha256Hex(readFileSync(bin)) && readFileSync(first.path, "utf8") === readFileSync(bin, "utf8"), "the binary is copied to <state>/claude/<version>, and its checksum answered");
      ok((statSync(first.path).mode & 0o777) === 0o500 && (statSync(join(state, CLAUDE_DIR)).mode & 0o777) === 0o700, "the copy is 0500 in a 0700 directory");
      const again = copyClaude(state, bin, "2.1.329");
      ok(!again.copied && again.sha256 === first.sha256, "the same bytes again are left as they are");
      const other = join(root, "claude-other");
      writeFileSync(other, "#!/bin/sh\necho two\n", { mode: 0o755 });
      const refusedOther = refuses(() => copyClaude(state, other, "2.1.329"));
      ok(refusedOther.includes("other bytes") && readFileSync(first.path, "utf8").includes("one"), "other bytes under a version already there are refused, the copy a stamp may name left alone");
      symlinkSync(join(root, "elsewhere-claude"), join(state, CLAUDE_DIR, "2.1.330"));
      const refusedLink = refuses(() => copyClaude(state, bin, "2.1.330"));
      ok(refusedLink !== "" && !existsSync(join(root, "elsewhere-claude")), "a symlink where the copy would go is refused, its target not written");
      ok(refuses(() => copyClaude(state, bin, "latest")).includes("not a version") && refuses(() => copyClaude(state, join(root, "no-such-binary"), "2.1.331")).includes("not a file"), "a version that isn't x.y.z, and a source that isn't a file, are refused");
    });

    section("the runner's own checkout, made and moved (SMD-4491)", () => {
      const GIT = fixtureGit();
      const git: GitRun = (args) => {
        const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
        return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      };
      const src = join(root, "src");
      mkdirSync(join(src, "scripts", "agent-runner"), { recursive: true });
      git(["init", "--quiet", src]);
      for (const f of PROFILE_FILES) writeFileSync(join(src, f), `// ${f}\n`);
      writeFileSync(join(src, "notes.txt"), "one\n");
      git(["-C", src, "add", "-A"]);
      git(["-C", src, "commit", "--quiet", "-m", "one"]);
      const c1 = git(["-C", src, "rev-parse", "HEAD"]).stdout.trim();
      writeFileSync(join(src, "notes.txt"), "two\n");
      git(["-C", src, "commit", "--quiet", "-am", "two"]);
      const c2 = git(["-C", src, "rev-parse", "HEAD"]).stdout.trim();
      writeFileSync(join(src, PROFILE_FILES[0]), "// a probed file, changed\n");
      git(["-C", src, "commit", "--quiet", "-am", "three"]);
      const c3 = git(["-C", src, "rev-parse", "HEAD"]).stdout.trim();
      const state = join(root, "state-install");
      const made = makeInstall(git, state, src, c1);
      const path = join(state, INSTALL_DIR);
      ok(made.ok && made.from === null && made.changed.length === 0 && made.path === path && readFileSync(join(path, "notes.txt"), "utf8") === "one\n", "a checkout is made at the commit asked for");
      ok(git(["-C", path, "symbolic-ref", "-q", "HEAD"]).code !== 0, "on a detached HEAD: no branch to drift");
      const moved = makeInstall(git, state, src, c2);
      ok(moved.ok && moved.from === c1 && moved.changed.length === 0 && readFileSync(join(path, "notes.txt"), "utf8") === "two\n", "a move that changes no probed file says so");
      const probed = makeInstall(git, state, src, c3);
      ok(probed.ok && probed.from === c2 && probed.changed.length === 1 && probed.changed[0] === PROFILE_FILES[0], "a move that changes a probed file names it");
      const same = makeInstall(git, state, src, c3);
      ok(same.ok && same.from === c3 && same.changed.length === 0, "the commit it is on already is no move");
      writeFileSync(join(path, "notes.txt"), "edited in place\n");
      const dirty = makeInstall(git, state, src, c1);
      ok(!dirty.ok && dirty.problem.includes("changes of its own") && readFileSync(join(path, "notes.txt"), "utf8") === "edited in place\n", "a checkout with changes of its own is refused and left as it is");
      const notRepo = join(root, "state-not-a-repo");
      mkdirSync(join(notRepo, INSTALL_DIR), { recursive: true });
      const refusedDir = makeInstall(git, notRepo, src, c1);
      ok(!refusedDir.ok && refusedDir.problem.includes("not a checkout"), "a directory there that is no checkout is refused");
      const short = makeInstall(git, join(root, "state-short"), src, c1.slice(0, 12));
      ok(!short.ok && short.problem.includes("full commit id") && !existsSync(join(root, "state-short")), "a commit id that isn't whole is refused before anything is made");
      // A first make whose commit the source doesn't have: the clone it made is removed, so the next try is a first make again.
      const unknown = makeInstall(git, join(root, "state-unknown"), src, "f".repeat(40));
      ok(!unknown.ok && unknown.problem.includes("couldn't be put at") && !existsSync(join(root, "state-unknown", INSTALL_DIR)), "a commit the source doesn't have is refused, and the clone just made is removed");
      const retry = makeInstall(git, join(root, "state-unknown"), src, c1);
      ok(retry.ok && retry.from === null, "so the next try makes it, where a clone left behind would be refused for its changes");
      const kept = makeInstall(git, state, src, "f".repeat(40));
      ok(!kept.ok && existsSync(join(path, "notes.txt")), "a checkout that was there before a failed move stays as it was");

      // The command whole (SMD-4491 review pass 1): the config's main checkout, the bare repository brought to its origin/main, the install made and moved.
      // The fixture as a main checkout: its own main behind its origin/main, which then moves on, as a maintainer's does.
      git(["-C", src, "checkout", "--quiet", "--detach"]);
      git(["-C", src, "branch", "--quiet", "-f", "main", c1]);
      git(["-C", src, "update-ref", "refs/remotes/origin/main", c2]);
      const runnerDir = join(root, "runner-config");
      mkdirSync(runnerDir, { mode: 0o700 });
      writeFileSync(join(runnerDir, "config.json"), JSON.stringify({ initiative: "I", maintainerLinearId: "00000000-0000-4000-8000-000000000000", mainCheckout: src }), { mode: 0o600 });
      const cmdState = join(root, "state-command");
      const io = { runnerDir, state: cmdState, home: root, git };
      const first = checkout({ ...io, commit: null });
      ok(first.ok && first.lines[0].includes(`${join(cmdState, INSTALL_DIR)} is at ${c2} (made)`) && first.lines[1].includes("no stamp names it yet") && existsSync(join(cmdState, "repo.git", "HEAD")), "`checkout` with no commit makes the bare repository and the install at the main checkout's origin/main");
      git(["-C", src, "update-ref", "refs/remotes/origin/main", c3]);
      const second = checkout({ ...io, commit: null });
      ok(second.ok && second.lines[0].includes(`(moved from ${c2})`) && second.lines[1].includes(PROFILE_FILES[0]) && second.lines[1].includes("Run the probes again"), "run again after main moved, it moves the install and names the probed file to sweep for");
      const back = checkout({ ...io, commit: c1 });
      ok(back.ok && back.lines[0].includes(`is at ${c1}`), "`--commit` puts it at that commit of main");
      const noConfig = checkout({ ...io, runnerDir: join(root, "no-runner-dir"), commit: null });
      ok(!noConfig.ok && noConfig.lines[0].startsWith("✗"), "with no config it says so and makes nothing");
    });

    section("what the probe stamp says of its binary and its install (SMD-4491)", () => {
      const state = join(root, "state-stamp");
      const install = join(root, "an-install");
      mkdirSync(join(install, "scripts", "agent-runner"), { recursive: true });
      for (const f of PROFILE_FILES) writeFileSync(join(install, f), `// ${f}\n`);
      const bin = join(root, "probed-bin");
      writeFileSync(bin, "the probed binary\n", { mode: 0o755 });
      const claude = copyClaude(state, bin, "2.1.329");
      const host: Host = { bunSha: "b".repeat(64), gitSha: "c".repeat(64), osBuild: "26A1" };
      const write = (over: Record<string, unknown> = {}): void => {
        const profile = Object.fromEntries(PROFILE_FILES.map((f) => [f, sha256Hex(readFileSync(join(install, f)))]));
        writeFileSync(join(state, STAMP_FILE), JSON.stringify({ at: "t", claude: { path: claude.path, sha256: claude.sha256, version: claude.version }, host, install, profile, probes: [], ...over }));
      };
      const texts = (r: { lines: { ok: boolean; text: string }[] }): string => r.lines.filter((l) => !l.ok).map((l) => l.text).join(" | ");
      ok(!stampReport(join(root, "state-none"), install, host).ok && texts(stampReport(join(root, "state-none"), install, host)).includes("no probe stamp"), "no stamp is said");
      write();
      const good = stampReport(state, install, host);
      ok(good.ok && good.lines.length === 3 && good.lines[0].text.includes("as probed") && !good.lines[0].text.includes("outside"), "a stamp whose binary, install and host are as probed: three lines, all good");
      ok(stampReport(state, install, null).lines.length === 2 && stampReport(state, install, null).ok, "with no host to read, Bun, git and the macOS build are left unread");
      const elsewhere = stampReport(state, join(root, "another-checkout"), host);
      ok(!elsewhere.ok && texts(elsewhere).includes("not the stamp's install") && texts(elsewhere).includes(install), "from another checkout it says a run starts from the install");
      const bunMoved = stampReport(state, install, { ...host, bunSha: "d".repeat(64) });
      ok(!bunMoved.ok && texts(bunMoved).startsWith("Bun changed"), "a new Bun is named, alone");
      writeFileSync(join(install, PROFILE_FILES[2]), "// edited since the probes\n");
      const edited = stampReport(state, install, host);
      ok(!edited.ok && texts(edited).includes(`1 of the install's probed files differ`) && texts(edited).includes(PROFILE_FILES[2]) && !texts(edited).includes(PROFILE_FILES[0]), "a probed file edited since is named, and only it");
      write();
      rmSync(join(install, PROFILE_FILES[1]));
      ok(texts(stampReport(state, install, host)).includes(PROFILE_FILES[1]), "a probed file gone from the install is named as differing");
      writeFileSync(join(install, PROFILE_FILES[1]), `// ${PROFILE_FILES[1]}\n`);
      write({ install: join(root, "removed-install") });
      ok(texts(stampReport(state, join(root, "removed-install"), host)).includes("install is gone"), "an install that is gone is said");
      write({ claude: { path: bin, sha256: sha256Hex(readFileSync(bin)), version: "2.1.329" } });
      const outside = stampReport(state, install, host);
      ok(outside.ok && outside.lines[0].text.includes("outside the runner's directory"), "a binary outside the runner's directory is as probed, with a word that an updater can remove it");
      rmSync(bin);
      ok(texts(stampReport(state, install, host)).includes("is gone") && texts(stampReport(state, install, host)).includes("setup.ts claude"), "a binary that is gone is said, with the step that copies it again");
      write({ claude: { path: claude.path, sha256: "0".repeat(64), version: "2.1.329" } });
      ok(texts(stampReport(state, install, host)).includes("its bytes changed"), "a binary whose bytes are not the probed ones is said");
    });

    section("install rewrites the mode of an existing world-readable file to 0600", () => {
      const dir = join(root, "fix-mode");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "linear.key"), "stale\n", { mode: 0o644 });
      chmodSync(join(dir, "linear.key"), 0o644);
      installValue(dir, "linear", FAKE.linear);
      ok((statSync(join(dir, "linear.key")).mode & 0o777) === 0o600, "an existing 0644 key is rewritten 0600");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fail = (msg: string): never => {
    console.error(msg);
    process.exit(2);
  };

  if (cmd === "--self-check") process.exit(selfCheck());

  if (cmd === "dirs") {
    mkdirSync(join(RUNNER_DIR, "claims"), { recursive: true, mode: 0o700 });
    chmodSync(RUNNER_DIR, 0o700);
    chmodSync(join(RUNNER_DIR, "claims"), 0o700);
    const problem = privateDirProblem(RUNNER_DIR);
    console.log(problem ? `✗ ${problem}` : `✓ ${RUNNER_DIR} is yours alone (0700), with claims/`);
    process.exit(problem ? 1 : 0);
  }

  if (cmd === "install") {
    const which = rest[0];
    if (!which || !WHICHES.includes(which as Which)) fail(`usage: install <${WHICHES.join("|")}> [--stdin]`);
    const source = rest.includes("--stdin") ? "stdin" : "clipboard";
    try {
      const r = install(RUNNER_DIR, which as Which, source);
      console.log(`✓ stored ${join(RUNNER_DIR, r.file)} (${spec(which as Which).label}, ${r.bytes} bytes) at 0600 — value not shown`);
      process.exit(0);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
  }

  if (cmd === "verify") {
    const botIdx = rest.indexOf("--bot");
    const problem = privateDirProblem(RUNNER_DIR);
    console.log(problem ? `✗ dir: ${problem}` : `✓ dir: ${RUNNER_DIR} (0700, yours)`);
    let failed = problem ? 1 : 0;
    for (const which of WHICHES) {
      const r = verifyOne(RUNNER_DIR, which);
      const mark = r.ok ? "✓" : r.detail === "missing" ? "·" : "✗";
      console.log(`${mark} ${spec(which).file}: ${r.detail}`);
      if (!r.ok) failed++;
    }
    if (botIdx >= 0) {
      const bot = rest[botIdx + 1];
      if (!bot) fail("--bot needs a github login");
      const g = checkGithub(bot as string);
      for (const line of g.lines) console.log(line);
      if (!g.ok) failed++;
    }
    // The probe stamp's binary and install, as they are now: what a run from this checkout would be refused for (SMD-4491).
    const report = stampReport(STATE_DIR, installDir(), await hostNow());
    for (const line of report.lines) console.log(`${line.ok ? "✓" : "✗"} stamp: ${line.text}`);
    failed += report.lines.filter((l) => !l.ok).length;
    console.log(failed ? `${failed} not ready` : "all four identities present and valid, and the probe stamp covers a run from this checkout");
    process.exit(failed ? 1 : 0);
  }

  if (cmd === "claude") {
    const source = rest[0];
    if (!source || rest.length !== 1) fail("usage: claude <path to a Claude Code binary>");
    try {
      const said = spawnSync(source as string, ["--version"], { encoding: "utf8", timeout: 20_000 });
      const version = claudeVersion(said.stdout ?? "");
      if (said.status !== 0 || version === null) throw new Error(`${source} --version did not answer a version (x.y.z)`);
      const copy = copyClaude(STATE_DIR, source as string, version);
      console.log(`✓ ${copy.copied ? "copied to" : "already at"} ${copy.path} (0500), Claude Code ${copy.version}`);
      console.log(`  --claude ${copy.path} --sha256 ${copy.sha256} --version ${copy.version}`);
      console.log("  Give the probes and a run these three; a stamp made on another path does not cover this copy.");
      process.exit(0);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
  }

  if (cmd === "checkout") {
    const at = rest.indexOf("--commit");
    if (rest.length !== (at >= 0 ? 2 : 0) || (at >= 0 && at !== 0)) fail("usage: checkout [--commit <full commit id>]");
    const done = checkout({ runnerDir: RUNNER_DIR, state: STATE_DIR, home: homedir(), git: gitRunner(homedir()), commit: at >= 0 ? (rest[1] as string) : null });
    for (const line of done.lines) (done.ok ? console.log : console.error)(line);
    process.exit(done.ok ? 0 : 1);
  }

  if (cmd === "check-github") {
    const bot = rest[0];
    if (!bot) fail("usage: check-github <bot-login>");
    const g = checkGithub(bot);
    for (const line of g.lines) console.log(line);
    process.exit(g.ok ? 0 : 1);
  }

  fail(`usage:
  bun scripts/agent-runner/setup.ts dirs
  bun scripts/agent-runner/setup.ts install <${WHICHES.join("|")}> [--stdin]
  bun scripts/agent-runner/setup.ts verify [--bot <login>]
  bun scripts/agent-runner/setup.ts claude <path to a Claude Code binary>
  bun scripts/agent-runner/setup.ts checkout [--commit <full commit id>]
  bun scripts/agent-runner/setup.ts check-github <bot-login>
  bun scripts/agent-runner/setup.ts --self-check`);
}
