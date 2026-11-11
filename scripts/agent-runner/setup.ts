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
 *   bun scripts/agent-runner/setup.ts verify [--bot <login>]    # each secret present, 0600, right shape (+ the fork)
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_FILES, KEY_SHAPES, privateDirProblem, readKey, readOwnedFile, RUNNER_DIR } from "./dry-run.ts";

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
    console.log(failed ? `${failed} not ready` : "all four identities present and valid");
    process.exit(failed ? 1 : 0);
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
  bun scripts/agent-runner/setup.ts check-github <bot-login>
  bun scripts/agent-runner/setup.ts --self-check`);
}
