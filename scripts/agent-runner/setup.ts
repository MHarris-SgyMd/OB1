/**
 * setup.ts — place and check the runner's identities (SMD-4089): the agent-kind brain key, the Linear key, the
 * Anthropic API key, the GitHub App's private key, and an optional GitHub read token for the dry run's lookups, each in
 * its own 0600 file under the runner's directory. Creating the accounts and minting the keys is the maintainer's, on
 * the brain host (CLAUDE.md, "Keys"); this tool only writes a minted secret into the right file, by the key's own
 * shape, without ever printing it, and verifies it through the runner's own owner-only read (dry-run.ts) — so a value
 * it accepts is one the runner will read. Rotation is the same two steps: install the new value, then verify. The
 * secret is read from the clipboard (pbpaste) or, with --stdin, from stdin; it never passes on the command line, and
 * no command here echoes it.
 *
 *   bun scripts/agent-runner/setup.ts dirs                       # make the directory (0700), idempotent
 *   bun scripts/agent-runner/setup.ts install linear            # copy the key to the clipboard first; this reads it
 *   bun scripts/agent-runner/setup.ts install brain --stdin     # or read the key from stdin
 *   bun scripts/agent-runner/setup.ts install github-app        # the App's private key (.pem), from the clipboard or --stdin
 *   bun scripts/agent-runner/setup.ts verify                    # each secret present, 0600, right shape,
 *                                                               # and what the probe stamp says of its binary and install
 *   bun scripts/agent-runner/setup.ts claude <path>             # the runner's own copy of that Claude Code (SMD-4491)
 *   bun scripts/agent-runner/setup.ts checkout [--commit <sha>] # the runner's own checkout, made or moved (SMD-4491)
 *   bun scripts/agent-runner/setup.ts check-github-app          # the App as decision 13 needs it, and the rulesets
 *                                                               # its first publish waits on (network; gh for rulesets)
 *   bun scripts/agent-runner/setup.ts --self-check              # offline
 *
 * Run it as the dry run is, reading no ambient config: bun --no-env-file --config=/dev/null scripts/agent-runner/setup.ts …
 */

import { spawnSync } from "node:child_process";
import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_FILES, KEY_SHAPES, noRedirect, parseConfig, privateDirProblem, readKey, readOwnedFile, RUNNER_DIR } from "./dry-run.ts";
import { NOT_JSON, SAFE_REQUEST, TIME_LIMITS, jsonOf, type Config, type Fetch } from "./facts.ts";
import { APP_KEY_FILE, APP_PERMISSIONS, PEM_SHAPE, appJwt, installationRepos, installationToken, revokeToken, said, type App } from "./github.ts";
import { fixtureGit } from "./fixture-git.ts";
import type { GitRun } from "./gate.ts";
import { CLAUDE_DIR, INSTALL_DIR, claudeVersion, copyClaude, hostNow, makeInstall, stampReport } from "./install.ts";
import { STATE_DIR, ensureBareRepo, gitRunner, installDir } from "./live-run.ts";
import { STAMP_FILE, type Host } from "./probes.ts";
import { PROFILE_FILES, sha256Hex } from "./profile.ts";

/** The Anthropic key isn't one the runner reads (Claude Code reads it through apiKeyHelper), so it isn't in KEY_FILES; it lives beside the others. */
const ANTHROPIC = { file: "anthropic.key", shape: /^sk-ant-[A-Za-z0-9_-]{16,}$/ } as const;

/** Which identity: the three keys the runner reads at start, the Anthropic key apiKeyHelper reads, and the App's key the publish reads. */
export type Which = keyof typeof KEY_FILES | "anthropic" | "github-app";
export const WHICHES: Which[] = [...(Object.keys(KEY_FILES) as (keyof typeof KEY_FILES)[]), "anthropic", "github-app"];
/** May be missing: `github.token`, a read token that raises the dry run's GitHub rate limit, nothing more (decision 13, amended 2026-11-24); and the App's key, which nothing reads before the first live publish (check-github-app checks it then). */
export const OPTIONAL: Which[] = ["github", "github-app"];

/** A key's file, its shape, and how to describe the shape in a message (never a value). */
export function spec(which: Which): { file: string; shape: RegExp; label: string } {
  if (which === "anthropic") return { file: ANTHROPIC.file, shape: ANTHROPIC.shape, label: "sk-ant-…" };
  if (which === "github-app") return { file: APP_KEY_FILE, shape: PEM_SHAPE, label: "the App's PEM private key" };
  const label = which === "linear" ? "lin_api_… or lin_oauth_…" : which === "brain" ? "64 hex (keygen.ts)" : "a read token, ghp_… or github_pat_…";
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
    if (which === "anthropic" || which === "github-app") {
      const s = spec(which);
      const text = readOwnedFile(join(dir, s.file), true);
      if (text === null) return { ok: false, detail: "missing" };
      if (!s.shape.test(text.trim())) return { ok: false, detail: `present but not ${which === "anthropic" ? "an sk-ant-… key" : "a PEM private key"} (value not shown)` };
      if (which === "github-app" && !canSign(text.trim())) return { ok: false, detail: "present and PEM-shaped, but not a private key that can sign (value not shown)" };
      return { ok: true, detail: `present · 0600 · owner-only · ${s.label}` };
    }
    const value = readKey(dir, which);
    if (value === null) return { ok: false, detail: "missing" };
    return { ok: true, detail: `present · 0600 · owner-only · ${spec(which).label}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** A PEM as GitHub's download or a clipboard may carry it: a BOM, CRLF line ends and trailing spaces taken out. */
export function normalizePem(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
}

/** Whether a PEM is an RSA private key of 2048 bits or more that can sign a JWT (RS256), so a key that fits the shape but not the maths, isn't RSA, or is short, is caught at install. Whether it is this App's key, only check-github-app can tell. */
export function canSign(pem: string): boolean {
  try {
    const key = createPrivateKey(pem);
    // GitHub's App keys are RSA, and the JWT is RS256: an EC key would sign, and GitHub would refuse what it signed.
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
    createSign("RSA-SHA256").update("probe").sign(key);
    return true;
  } catch {
    return false;
  }
}

/** Install a secret value into its 0600 file, by its shape, read back through the runner's own check. The value is never printed. */
export function installValue(dir: string, which: Which, value: string): { file: string; bytes: number } {
  const s = spec(which);
  const v = which === "github-app" ? normalizePem(value) : value.trim();
  if (!v) throw new Error(`there was nothing to write for the ${which} key (clipboard or stdin was empty)`);
  if (!s.shape.test(v)) throw new Error(`that value isn't shaped like a ${which} key (expected ${s.label}); nothing written, and the value is not shown`);
  // Checked before the write, so a key that can't sign never replaces one that can (a rotation's old key is then intact).
  if (which === "github-app" && !canSign(v)) throw new Error("that PEM isn't an RSA private key that can sign the App's JWT; nothing written, and the value is not shown");
  writeSecretFile(dir, s.file, `${v}\n`);
  const back = verifyOne(dir, which);
  if (!back.ok) throw new Error(`stored ${s.file}, but it didn't read back cleanly: ${back.detail}`);
  return { file: s.file, bytes: v.length };
}

/**
 * Write a secret to `<dir>/<file>` whole or not at all: to a new file beside it (0600, opened exclusively, never
 * through a link), synced, renamed over the old, and the directory synced. A link or anything but a plain file at the
 * path is refused, never written through or over. A write or a rename that fails removes the new file and leaves the old
 * in place; a hard link to the old file keeps its content. Temp files an interrupted install left (`.<file>.<pid>.<hex>.tmp`,
 * each holding a secret) are removed first. `rename` is injected so the self-check can fail it.
 */
export function writeSecretFile(dir: string, file: string, data: string, rename: (from: string, to: string) => void = renameSync): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, file);
  const tempName = new RegExp(`^\\.${file.replace(/[.]/g, "\\.")}\\.\\d+\\.[0-9a-f]{12}\\.tmp$`);
  for (const name of readdirSync(dir)) if (tempName.test(name)) rmSync(join(dir, name), { force: true });
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path} can't be read (${(e as NodeJS.ErrnoException).code})`);
  }
  if (st?.isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to write a secret through it`);
  if (st && !st.isFile()) throw new Error(`${path} is not a regular file; refusing to write a secret over it`);
  const tmp = join(dir, `.${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    throw new Error(`${dir} can't take a new file (${(e as NodeJS.ErrnoException).code}); nothing written, the old ${file} in place`);
  }
  try {
    const buf = Buffer.from(data);
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw new Error(`the new ${file} couldn't be written (${(e as NodeJS.ErrnoException).code ?? "error"}); the old one is in place`);
  }
  closeSync(fd);
  try {
    rename(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`the new ${file} couldn't take the old one's place (${(e as NodeJS.ErrnoException).code ?? "error"}); the old one is in place`);
  }
  chmodSync(path, 0o600);
  // The rename reaches the disk with the directory's own sync (best effort: macOS's fsync doesn't flush the drive's cache).
  try {
    const dfd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // A filesystem that can't sync a directory still has the file renamed.
  }
}

/** Install from the clipboard or stdin. */
export function install(dir: string, which: Which, source: "clipboard" | "stdin"): { file: string; bytes: number } {
  return installValue(dir, which, readSecret(source));
}

/** What `check-github-app` reads, gathered first so `appFindings` judges it offline. Each field null when it couldn't be read. */
export type AppFacts = {
  /** GET /app, with the App's JWT: its slug and the permissions it was given. */
  app: { slug?: unknown; permissions?: unknown } | null;
  /** GET /app/installations/<id>, with the JWT: which repositories it was installed on. */
  installation: { repository_selection?: unknown } | null;
  /** GET /installation/repositories, with an installation token: the repositories it reaches. */
  repos: string[] | null;
  /** The repo's rulesets, each read whole (with the maintainer's gh, which sees their bypass lists). */
  rulesets: { name?: unknown; target?: unknown; enforcement?: unknown; conditions?: unknown; rules?: unknown; bypass_actors?: unknown }[] | null;
  /** Why a field above is null, when the reader knows: GitHub's status, the transport's words, gh's. */
  why?: { app?: string; installation?: string; repos?: string; rulesets?: string };
};

/**
 * The refs a fence must cover, by the ruleset patterns that cover the whole of them. Read as a fixed list, not by
 * translating GitHub's fnmatch (its `**`, its leading-dot rule and its unsupported `[^...]` differ from any regex this
 * code would write, review pass 3): a ruleset counts as covering only if it includes one of these.
 */
export const COVERS = {
  /** Every tag `release.yml` starts on (`v[0-9]*`). */
  releaseTags: ["~ALL", "refs/tags/*", "refs/tags/**", "refs/tags/v*", "refs/tags/v[0-9]*"],
  /** main, this repo's default branch. */
  main: ["~ALL", "~DEFAULT_BRANCH", "refs/heads/main", "refs/heads/*", "refs/heads/**"],
} as const;

/**
 * Whether an exclude pattern might take out some of the refs a fence covers, read with suspicion: `~ALL`, a pattern of
 * GitHub's own form for them, one not under `refs/`, or one whose literal start (to its first `*`, `?`, `[` or `\\`)
 * could begin one of those refs. Only an exclude that plainly can't reach them (`refs/tags/nightly-*` for the release
 * tags) is let pass, so a misread exclude fails the check rather than passing it.
 */
export function excludeMayReach(pattern: string, fence: keyof typeof COVERS): boolean {
  if (pattern === "~ALL") return true;
  if (pattern.startsWith("~")) return fence === "main" ? pattern === "~DEFAULT_BRANCH" : false;
  if (!pattern.startsWith("refs/")) return true;
  const literal = pattern.slice(0, pattern.search(/[*?[\\]/) < 0 ? pattern.length : pattern.search(/[*?[\\]/));
  const wild = literal.length < pattern.length;
  if (fence === "main") return wild ? "refs/heads/main".startsWith(literal) : literal === "refs/heads/main";
  // A release tag is refs/tags/v<digit>…: the literal reaches one if it starts one, or one could start with it.
  if ("refs/tags/v".startsWith(literal)) return true;
  return /^refs\/tags\/v[0-9]/.test(literal);
}

/**
 * Judge the App and the repo's rulesets against decision 13 as amended: the lines `check-github-app` prints, each
 * ✓ or ✗, and whether all the required ones hold. Pure, so the self-check covers every verdict offline.
 *   - the App is the configured one, holds contents and pull_requests write and nothing more (no `workflows`, no
 *     `administration`), and is installed on this repo alone;
 *   - every `v*` tag's creation, update and deletion is restricted by an active tag ruleset the App can't bypass,
 *     so the App can't start a release (a moved tag is a push, as a new one is): `.github/rulesets/tags.json`;
 *   - main's update is restricted by an active ruleset the App can't bypass, so it can't merge whatever
 *     approvals it holds (its `pull_requests: write` could approve a PR, and an approval counts):
 *     `.github/rulesets/main-merge.json`, beside `main.json`, which it leaves as it is.
 * Rules stack across rulesets, as GitHub applies them. A ruleset covers a fence's refs only by an include from `COVERS`
 * and no exclude `excludeMayReach` suspects. A ruleset whose bypass list the reader couldn't see (GitHub shows it only
 * to a caller with write access to the ruleset) is not taken as one the App can't bypass; nor is one that a repository
 * role short of admin may bypass, since whether that reaches an App's installation isn't documented.
 */
export function appFindings(facts: AppFacts, cfg: { repo: string; githubAppId: string; githubAppSlug: string }): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const say = (good: boolean, text: string): void => {
    if (!good) ok = false;
    lines.push(`${good ? "✓" : "✗"} ${text}`);
  };
  const because = (k: keyof NonNullable<AppFacts["why"]>): string => (facts.why?.[k] ? ` (${facts.why[k]})` : "");
  if (facts.app === null) say(false, `the App couldn't be read with its JWT (GET /app)${because("app")}: a 401 means githubAppId or github-app.pem is wrong`);
  else {
    say(facts.app.slug === cfg.githubAppSlug, `the App's slug is ${said(JSON.stringify(facts.app.slug ?? null), 80)} (the config says ${cfg.githubAppSlug})`);
    const perms = facts.app.permissions && typeof facts.app.permissions === "object" ? (facts.app.permissions as Record<string, unknown>) : {};
    // Each permission that differs from decision 13's, said once: one the App shouldn't hold, or one at the wrong level.
    const off = [...new Set([...Object.keys(perms), ...Object.keys(APP_PERMISSIONS)])]
      .filter((k) => perms[k] !== APP_PERMISSIONS[k] && !(k === "metadata" && perms[k] === undefined))
      .map((k) => (Object.hasOwn(APP_PERMISSIONS, k) ? `${k}: ${perms[k] === undefined ? "none" : said(perms[k], 40)} (needs ${APP_PERMISSIONS[k]})` : `${said(k, 40)}: ${said(perms[k], 40)} (allowed: none)`));
    say(off.length === 0, off.length ? `the App's permissions are not decision 13's: ${off.join(", ")}` : "the App holds contents and pull_requests write, metadata read, and nothing else (no workflows, no administration)");
  }
  if (facts.installation === null) say(false, `the installation couldn't be read (GET /app/installations/<id>)${because("installation")}: a 404 means githubAppInstallationId is wrong`);
  else say(facts.installation.repository_selection === "selected", `the App is installed on selected repositories (it says ${said(JSON.stringify(facts.installation.repository_selection ?? null), 40)})`);
  if (facts.repos === null) say(false, `the installation's repositories couldn't be read with an installation token${because("repos")}`);
  else {
    const alone = facts.repos.length === 1 && facts.repos[0].toLowerCase() === cfg.repo.toLowerCase();
    say(alone, `the installation reaches ${alone ? `${cfg.repo} alone` : `${facts.repos.slice(0, 10).map((r) => said(r, 100)).join(", ") || "nothing"}${facts.repos.length > 10 ? ` and ${facts.repos.length - 10} more` : ""}, not ${cfg.repo} alone`}`);
  }

  if (facts.rulesets === null) {
    say(false, `the repo's rulesets couldn't be read with gh${because("rulesets")}`);
    return { ok, lines };
  }
  const active = facts.rulesets.filter((r) => r.enforcement === "active");
  type Rs = (typeof active)[number];
  const bypassSeen = (r: Rs): boolean => Array.isArray(r.bypass_actors);
  // The App itself, or a repository role short of admin (5), which might take in its installation: either counts as the App's bypass.
  const appBypasses = (r: Rs): boolean =>
    bypassSeen(r) &&
    (r.bypass_actors as { actor_type?: unknown; actor_id?: unknown }[]).some(
      (a) => (a?.actor_type === "Integration" && said(a?.actor_id) === cfg.githubAppId) || (a?.actor_type === "RepositoryRole" && said(a?.actor_id) !== "5"),
    );
  const ruleTypes = (r: Rs): string[] => (Array.isArray(r.rules) ? (r.rules as { type?: unknown }[]).map((x) => (typeof x?.type === "string" ? x.type : "")) : []);
  const patterns = (r: Rs, key: "include" | "exclude"): string[] => {
    const c = r.conditions as { ref_name?: Record<string, unknown> } | undefined;
    const v = c?.ref_name?.[key];
    return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : said(x))) : [];
  };
  const covers = (r: Rs, fence: keyof typeof COVERS): boolean =>
    patterns(r, "include").some((p) => (COVERS[fence] as readonly string[]).includes(p)) && !patterns(r, "exclude").some((p) => excludeMayReach(p, fence));
  /**
   * Whether each rule in `types` holds over the whole fence from some active ruleset of `target` that covers it and
   * that the App can't bypass. "unseen" when the only rulesets that would hold a rule hide their bypass lists from the
   * reader.
   */
  const fenced = (target: string, fence: keyof typeof COVERS, types: string[]): "yes" | "no" | "unseen" => {
    let unseen = false;
    for (const t of types) {
      const holding = active.filter((r) => r.target === target && covers(r, fence) && ruleTypes(r).includes(t));
      if (holding.some((r) => bypassSeen(r) && !appBypasses(r))) continue;
      if (holding.some((r) => !bypassSeen(r))) unseen = true;
      else return "no";
    }
    return unseen ? "unseen" : "yes";
  };

  // The tag fence: every v* tag release.yml starts on, its creation, update and deletion restricted, past the App's reach.
  const tags = fenced("tag", "releaseTags", ["creation", "update", "deletion"]);
  if (tags === "yes") say(true, "the v<digit> tags a release starts from: their creation, update and deletion are restricted by a tag ruleset the App can't bypass");
  else if (tags === "unseen") say(false, "a tag ruleset restricts v* tags, but its bypass list couldn't be read (gh must have write access to it): the App may be on it");
  else say(false, "no active tag ruleset the App can't bypass restricts creating, moving and deleting every v* tag: the App could push or move one and start a release (.github/rulesets/tags.json)");

  // The merge fence: main's update restricted by a ruleset the App can't bypass, so no approval it holds lets it merge.
  // (Deleting main is main.json's to refuse: its deletion rule binds everyone, with no bypass actor, check 20.)
  const main = fenced("branch", "main", ["update"]);
  if (main === "yes") say(true, "main's update is restricted by a ruleset the App can't bypass: it can't merge, whatever approvals it holds");
  else if (main === "unseen") say(false, "a ruleset restricts updating main, but its bypass list couldn't be read (gh must have write access to it): the App may be on it");
  else say(false, "no active ruleset the App can't bypass restricts updating main: the App could merge its own green PR (.github/rulesets/main-merge.json)");
  return { ok, lines };
}

/**
 * `check-github-app`: read what `appFindings` judges — the App and its installation with the App's own key, the
 * installation's repositories with a metadata-only token minted for the whole installation, and the rulesets with the
 * maintainer's gh — then judge it, and mint the publish's own token once to see it minted. Needs the network; not in
 * the offline self-check. Both tokens are revoked once read; nothing else is written.
 */
export async function checkGithubApp(cfg: Config, pem: string, fetchImpl: Fetch): Promise<{ ok: boolean; lines: string[] }> {
  if (!cfg.githubAppId || !cfg.githubAppInstallationId || !cfg.githubAppSlug) return { ok: false, lines: ["✗ the config names no GitHub App (githubAppId, githubAppInstallationId, githubAppSlug)"] };
  const app: App = { appId: cfg.githubAppId, installationId: cfg.githubAppInstallationId, repo: cfg.repo };
  // A GET that says why it failed: GitHub's status, or the transport's words, never a bare null.
  const get = async (path: string, bearer: string): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> => {
    try {
      const res = await fetchImpl(`https://api.github.com${path}`, { ...SAFE_REQUEST, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agent-runner-setup", Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(TIME_LIMITS.request) });
      if (!res.ok) return { ok: false, why: `GitHub answered ${res.status}` };
      const body = await jsonOf(res);
      return body === NOT_JSON ? { ok: false, why: "GitHub answered with something that isn't JSON" } : { ok: true, body };
    } catch (e) {
      return { ok: false, why: `the request failed: ${said((e as Error)?.message ?? e, 120)}` };
    }
  };
  let jwt: string | null = null;
  try {
    jwt = appJwt(app.appId, pem, Date.now());
  } catch {
    // Left null: the App and its installation are then said unread, the key unable to sign.
  }
  const why: NonNullable<AppFacts["why"]> = {};
  const facts: AppFacts = { app: null, installation: null, repos: null, rulesets: null, why };
  if (!jwt) why.app = why.installation = "the App's key couldn't sign a JWT";
  else {
    const a = await get("/app", jwt);
    if (a.ok) facts.app = a.body as AppFacts["app"];
    else why.app = a.why;
    const i = await get(`/app/installations/${app.installationId}`, jwt);
    if (i.ok) facts.installation = i.body as AppFacts["installation"];
    else why.installation = i.why;
  }
  // What the installation reaches, read with a token NOT narrowed to this repo (a narrowed one lists only its own).
  const reach = await installationRepos(fetchImpl, app, pem, Date.now());
  if (reach.ok) facts.repos = reach.repos;
  else why.repos = reach.detail;
  // The rulesets, each read whole with the maintainer's gh (GitHub shows a bypass list only to a caller with write access).
  const gh = (args: string[]): { ok: true; out: string } | { ok: false; why: string } => {
    // SIGKILL at the limit: a gh that ignores SIGTERM would otherwise outlive it.
    const r = spawnSync("gh", ["api", ...args], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 8 << 20 });
    if (r.error) return { ok: false, why: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "gh isn't installed" : `gh couldn't run (${(r.error as NodeJS.ErrnoException).code ?? said(r.error.message, 80)})` };
    if (r.status !== 0) return { ok: false, why: `gh api exited ${r.status}: ${said(r.stderr || r.stdout || "", 160) || "no words"} (is gh logged in?)` };
    return { ok: true, out: r.stdout ?? "" };
  };
  const list = gh(["--paginate", `repos/${cfg.repo}/rulesets?includes_parents=true&per_page=100`, "--jq", ".[].id"]);
  if (!list.ok) why.rulesets = `listing them: ${list.why}`;
  else {
    const ids = list.out.split("\n").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
    const read: NonNullable<AppFacts["rulesets"]> = [];
    for (const id of ids) {
      const one = gh([`repos/${cfg.repo}/rulesets/${id}`]);
      if (!one.ok) {
        why.rulesets = `ruleset ${id}: ${one.why}`;
        break;
      }
      try {
        const parsed = JSON.parse(one.out);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        read.push(parsed);
      } catch {
        why.rulesets = `ruleset ${id} came back as something that isn't a JSON object`;
        break;
      }
    }
    if (read.length === ids.length) facts.rulesets = read;
  }
  const judged = appFindings(facts, { repo: cfg.repo, githubAppId: cfg.githubAppId, githubAppSlug: cfg.githubAppSlug });
  const lines = [...judged.lines];
  // Last, the publish's own token, minted as a run mints it, then revoked; a revoke that didn't land is said (it
  // expires within the hour).
  const minted = await installationToken(fetchImpl, app, pem, Date.now());
  let revokedAll = reach.ok ? reach.revoked : true;
  if (minted.ok) revokedAll = (await revokeToken(fetchImpl, minted.token)) && revokedAll;
  lines.push(minted.ok ? "✓ the publish's installation token was minted, for this repo and the two permissions alone" : `✗ the publish's installation token couldn't be minted: ${minted.detail}`);
  if (!revokedAll) lines.push("✗ a token this check minted couldn't be revoked: it stays live until it expires, within the hour");
  return { ok: judged.ok && minted.ok && revokedAll, lines };
}

/**
 * `setup.ts checkout`: reads the runner's config for the main checkout, brings the runner's bare repository to its
 * origin/main (the one source the install clones), and makes or moves the install: to `commit`, or to that main.
 * It then says what the probe stamp makes of the install as it now is.
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
  if (made.changed.length) lines.push(`  The move changed ${made.changed.length} probed file(s): ${made.changed.join(", ")}.`);
  // Whether the stamp still covers it is read from the files, not from this one move: an earlier move may have gone unswept.
  const report = stampReport(io.state, made.path, null);
  for (const l of report.lines) lines.push(`  ${l.ok ? "✓" : "✗"} stamp: ${l.text}`);
  if (!report.ok) lines.push(`  Run the probes from ${made.path} before a run.`);
  return { ok: true, lines };
}

/**
 * Offline self-check, on a temp directory, with no clipboard and no network. The identities: the shape gate, the 0600
 * write, the no-symlink write, the owner-only read and the directory check. The install (SMD-4491): the copy of a
 * Claude Code binary, the checkout made and moved on git fixtures and the `checkout` command whole, and the probe
 * stamp's report.
 */
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
  // A real key of the shape GitHub hands out (PKCS#1), since install and verify sign with it.
  const APP_PEM = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const FAKE: Record<Which, string> = {
    linear: `lin_api_${"a".repeat(24)}`,
    brain: "0123456789abcdef".repeat(4),
    github: `ghp_${"A".repeat(36)}`,
    anthropic: `sk-ant-${"A".repeat(28)}`,
    "github-app": APP_PEM,
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
      writeFileSync(join(src, "notes.txt"), "four\n");
      git(["-C", src, "commit", "--quiet", "-am", "four"]);
      const c4 = git(["-C", src, "rev-parse", "HEAD"]).stdout.trim();
      // A commit the source holds on a branch that is not main, as the bare repository holds a session's.
      const side = git(["-C", src, "commit-tree", `${c1}^{tree}`, "-p", c1, "-m", "a session's commit"]).stdout.trim();
      git(["-C", src, "update-ref", "refs/heads/agent/side", side]);
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
      ok(!unknown.ok && unknown.problem.includes("not a commit of main") && !existsSync(join(root, "state-unknown", INSTALL_DIR)), "a commit the source doesn't have is refused, and the clone just made is removed");
      const offMain = makeInstall(git, join(root, "state-unknown"), src, side);
      ok(/^[0-9a-f]{40}$/.test(side) && !offMain.ok && offMain.problem.includes("not a commit of main") && !existsSync(join(root, "state-unknown", INSTALL_DIR)), "a commit the source holds on another branch, as a session's is, is refused: the install is put only at a commit of main");
      const retry = makeInstall(git, join(root, "state-unknown"), src, c1);
      ok(retry.ok && retry.from === null, "so the next try makes it, where a clone left behind would be refused for its changes");

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
      const said = (r: { lines: string[] }): string => r.lines.join(" | ");
      ok(first.ok && first.lines[0].includes(`${join(cmdState, INSTALL_DIR)} is at ${c2} (made)`) && said(first).includes("no probe stamp") && said(first).includes("Run the probes from") && existsSync(join(cmdState, "repo.git", "HEAD")), "`checkout` with no commit makes the bare repository and the install at the main checkout's origin/main, and says no stamp names it");
      // A stamp for the install as it is at c2, as a sweep from it would leave.
      const cmdInstall = join(cmdState, INSTALL_DIR);
      const cmdBin = join(root, "command-bin");
      writeFileSync(cmdBin, "a binary\n", { mode: 0o755 });
      const cmdClaude = copyClaude(cmdState, cmdBin, "2.1.329");
      writeFileSync(join(cmdState, STAMP_FILE), JSON.stringify({ at: "t", claude: { path: cmdClaude.path, sha256: cmdClaude.sha256, version: cmdClaude.version }, host: {}, install: cmdInstall, profile: Object.fromEntries(PROFILE_FILES.map((f) => [f, sha256Hex(readFileSync(join(cmdInstall, f)))])), probes: [] }));
      const still = checkout({ ...io, commit: null });
      ok(still.ok && still.lines[0].includes("(as it was)") && said(still).includes("probed files as probed") && !said(still).includes("Run the probes"), "under a stamp made from it, it says the install is as probed");
      git(["-C", src, "update-ref", "refs/remotes/origin/main", c3]);
      const second = checkout({ ...io, commit: null });
      ok(second.ok && second.lines[0].includes(`(moved from ${c2})`) && second.lines[1].includes("The move changed 1 probed file(s)") && second.lines[1].includes(PROFILE_FILES[0]) && said(second).includes("1 of the install's probed files differ") && said(second).includes("Run the probes from"), "run again after main moved, it moves the install, names the probed file the move changed, and says the stamp no longer covers it");
      // The next move changes no probed file, and the sweep was never run: the stamp is still stale, and it says so from the files.
      git(["-C", src, "update-ref", "refs/remotes/origin/main", c4]);
      const third = checkout({ ...io, commit: null });
      ok(third.ok && third.lines[0].includes(`(moved from ${c3})`) && !said(third).includes("The move changed") && said(third).includes("1 of the install's probed files differ") && said(third).includes("Run the probes from"), "a later move that changes no probed file still says the stamp is stale: it reads the files, not the one move");
      const back = checkout({ ...io, commit: c1 });
      ok(back.ok && back.lines[0].includes(`is at ${c1}`) && said(back).includes("probed files as probed"), "`--commit` puts it at that commit of main, here one the stamp's files match again");
      const kept = makeInstall(git, cmdState, join(cmdState, "repo.git"), side);
      ok(!kept.ok && kept.problem.includes("not a commit of main") && git(["-C", cmdInstall, "rev-parse", "HEAD"]).stdout.trim() === c1 && existsSync(join(cmdInstall, "notes.txt")), "a refused move leaves a checkout that was there, clean, as it was");
      const noConfig = checkout({ ...io, runnerDir: join(root, "no-runner-dir"), commit: null });
      ok(!noConfig.ok && noConfig.lines[0].startsWith("✗"), "with no config it says so and makes nothing");
    });

    section("the App's key: installed as GitHub's download carries it, refused when it can't sign, and written whole or not at all", () => {
      const dir = join(root, "app-key");
      const crlf = APP_PEM.trim().replace(/\n/g, "  \r\n");
      installValue(dir, "github-app", `\uFEFF${crlf}\r\n`);
      const stored = readFileSync(join(dir, APP_KEY_FILE), "utf8");
      ok(stored === `${APP_PEM.trim()}\n` && verifyOne(dir, "github-app").ok, "a key with a BOM, CRLF line ends and trailing spaces is stored as plain PEM, and verifies");
      const pkcs8 = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
      installValue(dir, "github-app", pkcs8);
      ok(verifyOne(dir, "github-app").ok, "a PKCS#8 key is taken too");
      const lines = APP_PEM.trim().split("\n");
      const garbled = [lines[0], ...lines.slice(1, -1).map((l) => l.replace(/[A-Za-z]/g, "A")), lines.at(-1)].join("\n");
      ok(PEM_SHAPE.test(garbled) && refuses(() => installValue(join(root, "app-key-bad"), "github-app", garbled)).includes("can sign"), "a PEM-shaped key that can't sign is refused at install");
      const before = readFileSync(join(dir, APP_KEY_FILE), "utf8");
      ok(refuses(() => installValue(dir, "github-app", garbled)).includes("nothing written") && readFileSync(join(dir, APP_KEY_FILE), "utf8") === before && verifyOne(dir, "github-app").ok, "a rotation to a key that can't sign is refused before the write: the key in place is kept, and still verifies");
      const ec = generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
      ok(PEM_SHAPE.test(ec.trim()) && refuses(() => installValue(join(root, "app-key-ec"), "github-app", ec)).includes("can sign"), "an EC key, PEM-shaped and able to sign, is refused: the JWT is RS256");
      const short = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
      ok(refuses(() => installValue(join(root, "app-key-short"), "github-app", short)).includes("nothing written"), "an RSA key under 2048 bits is refused");
      // A key placed by hand, PEM-shaped but unable to sign: verify says so.
      const handDir = join(root, "app-key-hand");
      mkdirSync(handDir, { mode: 0o700 });
      writeFileSync(join(handDir, APP_KEY_FILE), `${garbled}\n`, { mode: 0o600 });
      ok(!verifyOne(handDir, "github-app").ok && verifyOne(handDir, "github-app").detail.includes("can sign"), "verify finds a hand-placed key that can't sign");
      // The write is whole or not at all: a write that fails (a size limit) leaves the old key, and no temp file.
      const limited = join(root, "app-key-limited");
      installValue(limited, "github-app", APP_PEM);
      const kept = readFileSync(join(limited, APP_KEY_FILE), "utf8");
      const keyFile = join(root, "next-key.pem");
      writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 4096, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
      const child = Bun.spawnSync(["/bin/sh", "-c", `ulimit -f 1; trap '' XFSZ; exec "$0" -e "$1"`, process.execPath, `import { installValue } from ${JSON.stringify(join(import.meta.dir, "setup.ts"))}; import { readFileSync } from "node:fs"; try { installValue(${JSON.stringify(limited)}, "github-app", readFileSync(${JSON.stringify(keyFile)}, "utf8")); console.log("WROTE"); } catch (e) { console.log("REFUSED " + e.message); }`], { stdout: "pipe", stderr: "pipe" });
      const childSaid = child.stdout.toString();
      ok(childSaid.includes("REFUSED") && childSaid.includes("the old one is in place") && readFileSync(join(limited, APP_KEY_FILE), "utf8") === kept && readdirSync(limited).every((f) => !f.endsWith(".tmp")), `a write that fails under a size limit leaves the old key whole and no temp file (child exit ${child.exitCode}, signal ${child.signalCode ?? "none"}, said ${JSON.stringify(childSaid.trim().slice(0, 120))}${child.stderr.length ? `, stderr ${JSON.stringify(child.stderr.toString().trim().slice(0, 200))}` : ""})`);
      // A hard link at the key path: the rename replaces the name, and the linked file keeps its content.
      const linked = join(root, "app-key-linked");
      mkdirSync(linked, { mode: 0o700 });
      const other = join(root, "other-file");
      writeFileSync(other, "someone else's content\n", { mode: 0o600 });
      linkSync(other, join(linked, APP_KEY_FILE));
      installValue(linked, "github-app", APP_PEM);
      ok(readFileSync(other, "utf8") === "someone else's content\n" && verifyOne(linked, "github-app").ok, "a hard link at the key path: the other file keeps its content, and the key is in place");
      // A FIFO at the key path is refused at once, never opened (an open for writing would wait for a reader).
      const fifoDir = join(root, "app-key-fifo");
      mkdirSync(fifoDir, { mode: 0o700 });
      Bun.spawnSync(["mkfifo", join(fifoDir, APP_KEY_FILE)]);
      ok(refuses(() => installValue(fifoDir, "github-app", APP_PEM)).includes("not a regular file"), "a FIFO at the key path is refused, not opened");
      // A rename that fails: the new file is removed, the old key in place, and the message says so.
      const renameDir = join(root, "rename-fails");
      installValue(renameDir, "brain", "a".repeat(64));
      const renameErr = refuses(() => writeSecretFile(renameDir, KEY_FILES.brain, `${"b".repeat(64)}\n`, () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); }));
      ok(renameErr.includes("couldn't take the old one's place") && renameErr.includes("EPERM") && readKey(renameDir, "brain") === "a".repeat(64) && readdirSync(renameDir).every((f) => !f.endsWith(".tmp")), "a rename that fails leaves the old key and no temp file holding the new one");
      // Temp files an interrupted install left are swept; another file is left alone.
      writeFileSync(join(renameDir, `.${KEY_FILES.brain}.4242.abcdef012345.tmp`), "c".repeat(64), { mode: 0o600 });
      writeFileSync(join(renameDir, ".notes.tmp"), "mine", { mode: 0o600 });
      writeFileSync(join(renameDir, `.${KEY_FILES.brain}.4242.abcdef012345.tmp.keep`), "mine too", { mode: 0o600 });
      installValue(renameDir, "brain", "d".repeat(64));
      ok(!existsSync(join(renameDir, `.${KEY_FILES.brain}.4242.abcdef012345.tmp`)) && existsSync(join(renameDir, ".notes.tmp")) && existsSync(join(renameDir, `.${KEY_FILES.brain}.4242.abcdef012345.tmp.keep`)) && readKey(renameDir, "brain") === "d".repeat(64), "an interrupted install's temp file is swept at the next install, and nothing else");
      const mismatched = APP_PEM.trim().replace("-----END RSA PRIVATE KEY-----", "-----END PRIVATE KEY-----");
      ok(refuses(() => installValue(join(root, "app-key-bad2"), "github-app", mismatched)) !== "", "a key whose BEGIN and END lines disagree is refused");
    });

    section("check-github-app's verdicts: the App as decision 13 needs it, and its fence (appFindings)", () => {
      const cfgA = { repo: "MHarris-SgyMd/OB1", githubAppId: "123456", githubAppSlug: "ob1-agent-runner" };
      // The two rulesets as the repo records them, read back from their files.
      const tagRs = JSON.parse(readFileSync(join(import.meta.dir, "../../.github/rulesets/tags.json"), "utf8")) as Record<string, unknown>;
      const lockRs = JSON.parse(readFileSync(join(import.meta.dir, "../../.github/rulesets/main-merge.json"), "utf8")) as Record<string, unknown>;
      const mainJson = JSON.parse(readFileSync(join(import.meta.dir, "../../.github/rulesets/main.json"), "utf8")) as Record<string, unknown>;
      const APP_BYPASS = [{ actor_type: "Integration", actor_id: 123456, bypass_mode: "always" }];
      const with_ = (r: Record<string, unknown>, over: Record<string, unknown>) => ({ ...r, ...over });
      const refs = (include: string[], exclude: string[] = []) => ({ conditions: { ref_name: { include, exclude } } });
      const rules = (...types: string[]) => ({ rules: types.map((type) => ({ type })) });
      const good: AppFacts = {
        app: { slug: "ob1-agent-runner", permissions: { contents: "write", pull_requests: "write", metadata: "read" } },
        installation: { repository_selection: "selected" },
        repos: ["MHarris-SgyMd/OB1"],
        rulesets: [mainJson, lockRs, tagRs],
      };
      const judged = (over: Partial<AppFacts>) => appFindings({ ...good, ...over }, cfgA);
      const all = judged({});
      ok(all.ok && all.lines.length === 6 && all.lines.every((l) => l.startsWith("✓")), "main.json, main-merge.json and tags.json as recorded, and the App as decision 13's: six ✓");
      const says = (over: Partial<AppFacts>, text: string): boolean => {
        const r = judged(over);
        return !r.ok && r.lines.some((l) => l.startsWith("✗") && l.includes(text));
      };
      ok(says({ app: { slug: "other", permissions: good.app?.permissions } }, "slug"), "another App's slug is ✗");
      ok(says({ app: { slug: "ob1-agent-runner", permissions: { contents: "write", pull_requests: "write", metadata: "read", workflows: "write" } } }, "workflows: write (allowed: none)"), "a workflows permission is ✗");
      ok(says({ app: { slug: "ob1-agent-runner", permissions: { contents: "write", pull_requests: "write", metadata: "read", administration: "read" } } }, "administration: read (allowed: none)"), "an administration read is ✗");
      ok(says({ app: { slug: "ob1-agent-runner", permissions: { contents: "write", metadata: "read" } } }, "pull_requests: none (needs write)"), "no pull_requests write is ✗");
      ok(says({ app: { slug: "ob1-agent-runner", permissions: { contents: "read", pull_requests: "write", metadata: "read" } } }, "contents: read (needs write)"), "contents read alone is ✗, said once");
      ok(says({ app: null }, "GET /app"), "an App that can't be read is ✗");
      ok(says({ installation: { repository_selection: "all" } }, "selected"), "an App installed on every repository is ✗");
      const hostile = { toString: () => { throw new Error("No default value"); } };
      let threw = false;
      try {
        judged({ app: { slug: "ob1-agent-runner", permissions: { contents: "write", pull_requests: "write", metadata: "read", admin: hostile } }, rulesets: [mainJson, lockRs, { ...tagRs, rules: [{ type: hostile }] }] });
        judged({ rulesets: [mainJson, { ...lockRs, conditions: { ref_name: { include: [hostile], exclude: [hostile] } } }, tagRs] });
      } catch {
        threw = true;
      }
      ok(!threw && says({ app: { slug: "ob1-agent-runner", permissions: { contents: "write", pull_requests: "write", metadata: "read", admin: hostile } } }, "admin: (a value that can't be shown)"), "values whose String() throws are said as such, never thrown");
      const forged = judged({ repos: ["MHarris-SgyMd/OB1", "o/r\n✓ every check passed\x1b[2J"] });
      ok(!forged.ok && forged.lines.every((l) => !l.includes("\n") && !l.includes("\x1b")) && forged.lines.some((l) => l.includes("<U+001B>")), "a repository name can't start a line of its own or carry an escape to the terminal");
      ok(says({ repos: ["MHarris-SgyMd/OB1", "MHarris-SgyMd/other"] }, "not MHarris-SgyMd/OB1 alone"), "an installation reaching two repositories is ✗");

      // The tag fence.
      ok(says({ rulesets: [mainJson, lockRs] }, "tags.json"), "no tag ruleset (today's repo) is ✗");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, { bypass_actors: [...APP_BYPASS] })] }, "start a release"), "a tag ruleset the App can bypass is ✗");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, { enforcement: "evaluate" })] }, "start a release"), "a tag ruleset only evaluating is ✗");
      ok(says({ rulesets: [mainJson, lockRs, { ...tagRs, target: "branch", ...refs(["~ALL"]) }] }, "start a release"), "a branch ruleset on ~ALL with the tag rules is ✗: it fences no tag");
      ok(says({ rulesets: [mainJson, tagRs, { ...lockRs, target: "tag", ...refs(["~ALL"]) }] }, "could merge"), "a tag ruleset restricting updates is ✗ as main's lock");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, rules("creation"))] }, "start a release"), "a tag ruleset restricting creation alone is ✗: a moved tag starts a release too");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, rules("creation", "update"))] }, "start a release"), "a tag ruleset that lets a v* tag be deleted is ✗: deleted and pushed again, it starts a release");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, rules("creation", "deletion"))] }, "start a release"), "a tag ruleset that lets a v* tag be moved is ✗: a forced move is a push, and starts a release");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, refs(["refs/tags/v*"], ["refs/tags/v[0-9]*"]))] }, "start a release"), "a tag ruleset excluding the v[0-9]* tags is ✗");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, refs(["refs/tags/v2*"]))] }, "start a release"), "a tag ruleset on some v* tags alone is ✗");
      ok(judged({ rulesets: [mainJson, lockRs, with_(tagRs, refs(["~ALL"], ["refs/tags/nightly-*"]))] }).ok, "every tag but nightly-* is ✓: the excluded tags start no release");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, refs(["refs/tags/v*"], ["refs/tags/v3*"]))] }, "start a release"), "a tag ruleset excluding v3* is ✗: every v3 tag would be open");
      ok(says({ rulesets: [mainJson, lockRs, with_(tagRs, refs(["refs/tags/v[0-24-9]*"]))] }, "start a release"), "a tag ruleset on an include this code doesn't know is ✗, not guessed at");
      ok(judged({ rulesets: [mainJson, lockRs, with_(tagRs, rules("creation")), with_(tagRs, { name: "b", ...rules("update", "deletion") })] }).ok, "creation in one tag ruleset and update and deletion in another is ✓: rules stack");
      const unseenTag = { ...tagRs };
      delete unseenTag.bypass_actors;
      ok(says({ rulesets: [mainJson, lockRs, unseenTag] }, "bypass list couldn't be read"), "a tag ruleset whose bypass list wasn't shown is ✗, not taken as safe");

      // The merge fence.
      ok(says({ rulesets: [mainJson, tagRs] }, "main-merge.json"), "main.json alone (today's repo) is ✗: the App could merge its own green PR");
      ok(says({ rulesets: [mainJson, with_(lockRs, { bypass_actors: [...APP_BYPASS] }), tagRs] }, "could merge"), "a lock the App can bypass is ✗");
      ok(says({ rulesets: [mainJson, with_(lockRs, rules("deletion")), tagRs] }, "could merge"), "a lock without the update rule is ✗");
      ok(judged({ rulesets: [mainJson, with_(lockRs, rules("update")), tagRs] }).ok, "a lock on update alone is ✓: main.json refuses deleting main to everyone");
      ok(says({ rulesets: [mainJson, with_(lockRs, refs(["~ALL"], ["~DEFAULT_BRANCH"])), tagRs] }, "could merge"), "a lock on every branch but main is ✗");
      ok(says({ rulesets: [mainJson, with_(lockRs, refs(["refs/heads/main"], ["refs/heads/main"])), tagRs] }, "could merge"), "a lock that includes and excludes main is ✗");
      ok(judged({ rulesets: [mainJson, with_(lockRs, refs(["refs/heads/**"], ["refs/heads/agent/**"])), tagRs] }).ok, "a lock on every branch but agent/** is ✓");
      ok(says({ rulesets: [mainJson, with_(lockRs, refs(["~ALL"], ["refs/heads/**/main"])), tagRs] }, "could merge"), "a lock excluding refs/heads/**/main is ✗: GitHub's ** matches no directory there, taking main out");
      ok(says({ rulesets: [mainJson, with_(lockRs, { bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 4, bypass_mode: "always" }] }), tagRs] }, "could merge"), "a lock the write role may bypass is ✗: it may take in the App");
      ok(judged({ rulesets: [mainJson, with_(lockRs, { bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "exempt" }] }), tagRs] }).ok, "a lock the admin role is exempt from is ✓");
      ok(says({ rulesets: [mainJson, with_(lockRs, { enforcement: "disabled" }), tagRs] }, "could merge"), "a disabled lock is ✗");
      const unseenLock = { ...lockRs };
      delete unseenLock.bypass_actors;
      ok(says({ rulesets: [mainJson, unseenLock, tagRs] }, "bypass list couldn't be read"), "a lock whose bypass list wasn't shown is ✗");
      ok(judged({ rulesets: [mainJson, lockRs, with_(lockRs, { name: "x", bypass_actors: [...APP_BYPASS] }), tagRs] }).ok, "a second lock the App can bypass beside one it can't is ✓: the one it can't still holds");
      ok(says({ rulesets: null }, "rulesets couldn't be read"), "rulesets that can't be read are ✗");
    });

    section("excludeMayReach: an exclude passes only when it plainly can't reach the fence's refs", () => {
      ok(["~ALL", "refs/tags/*", "refs/tags/v*", "refs/tags/v3*", "refs/tags/v1.0.0", "refs/tags/**/*", "refs/tags/[v]*", "refs/tags/?*", "v*", "refs/tags/v\\*"].every((p) => excludeMayReach(p, "releaseTags")), "every exclude that could take out a v<digit> tag, or that this code can't read for sure, is suspected");
      ok(["refs/tags/nightly-*", "refs/tags/vx*", "refs/tags/latest", "refs/heads/main", "~DEFAULT_BRANCH"].every((p) => !excludeMayReach(p, "releaseTags")), "an exclude that can't reach one (another prefix, a branch) passes");
      ok(["~ALL", "~DEFAULT_BRANCH", "refs/heads/main", "refs/heads/**/main", "refs/heads/m*", "refs/heads/*", "main", "refs/heads/[m]ain"].every((p) => excludeMayReach(p, "main")), "every exclude that could take out main is suspected");
      ok(["refs/heads/agent/**", "refs/heads/mainline", "refs/heads/release-*", "refs/tags/*"].every((p) => !excludeMayReach(p, "main")), "an exclude that can't reach main passes");
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
    const problem = privateDirProblem(RUNNER_DIR);
    console.log(problem ? `✗ dir: ${problem}` : `✓ dir: ${RUNNER_DIR} (0700, yours)`);
    let failed = problem ? 1 : 0;
    for (const which of WHICHES) {
      const r = verifyOne(RUNNER_DIR, which);
      const mark = r.ok ? "✓" : r.detail === "missing" ? "·" : "✗";
      const optionalMissing = OPTIONAL.includes(which) && r.detail === "missing";
      console.log(`${mark} ${spec(which).file}: ${r.detail}${optionalMissing ? " (optional)" : ""}`);
      if (!r.ok && !optionalMissing) failed++;
    }
    // The probe stamp's binary and install, as they are now: what a run from this checkout would be refused for (SMD-4491).
    const report = stampReport(STATE_DIR, installDir(), await hostNow());
    for (const line of report.lines) console.log(`${line.ok ? "✓" : "✗"} stamp: ${line.text}`);
    failed += report.lines.filter((l) => !l.ok).length;
    console.log(failed ? `${failed} not ready` : "every identity a run needs present and valid (the optional ones as shown), and the probe stamp covers a run from this checkout");
    process.exit(failed ? 1 : 0);
  }

  if (cmd === "claude") {
    const source = rest[0];
    if (!source || rest.length !== 1) fail("usage: claude <path to a Claude Code binary>");
    try {
      const answered = spawnSync(source as string, ["--version"], { encoding: "utf8", timeout: 20_000 });
      const version = claudeVersion(answered.stdout ?? "");
      if (answered.status !== 0 || version === null) throw new Error(`${source} --version did not answer a version (x.y.z)`);
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

  if (cmd === "check-github-app") {
    if (rest.length) fail("usage: check-github-app");
    try {
      const configPath = join(RUNNER_DIR, "config.json");
      const keyPath = join(RUNNER_DIR, APP_KEY_FILE);
      const text = readOwnedFile(configPath, false);
      if (text === null) fail(`no config at ${configPath}`);
      const cfg = parseConfig(text as string, homedir());
      if ("error" in cfg) fail(`the config: ${cfg.error}`);
      const pem = readOwnedFile(keyPath, true);
      if (pem === null) fail(`no App key at ${keyPath} (setup.ts install github-app)`);
      if (!PEM_SHAPE.test((pem as string).trim())) fail(`${keyPath} isn't a PEM private key as install writes one: install it again (setup.ts install github-app)`);
      const g = await checkGithubApp(cfg as Config, (pem as string).trim(), noRedirect(fetch));
      for (const line of g.lines) console.log(line);
      process.exit(g.ok ? 0 : 1);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
  }

  fail(`usage:
  bun scripts/agent-runner/setup.ts dirs
  bun scripts/agent-runner/setup.ts install <${WHICHES.join("|")}> [--stdin]
  bun scripts/agent-runner/setup.ts verify
  bun scripts/agent-runner/setup.ts claude <path to a Claude Code binary>
  bun scripts/agent-runner/setup.ts checkout [--commit <full commit id>]
  bun scripts/agent-runner/setup.ts check-github-app
  bun scripts/agent-runner/setup.ts --self-check`);
}
