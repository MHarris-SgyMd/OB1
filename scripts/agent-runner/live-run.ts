#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * live-run.ts — the real-deps executor (SMD-4087 cut 2c-3): the thing that actually runs `liveRun` (live.ts) on one
 * ticket, with the real clients the earlier cuts built against stubs. It is the capstone of cut 2c — selection and the
 * claim (cut 1 / 2c-1), the Linear moves (2c-2), the local run (2b) and the live wiring (2c-3) brought together behind
 * the runner's own keys, the pinned Claude Code and a real model.
 *
 * Two modes, so the money path is never the default:
 *   --plan     load the config and keys, take the ticket (its full fields fetched from Linear and checked), provision
 *              the runner's bare repository, and print what a run WOULD do. No session, no claim, no Linear write, no spend.
 *   --execute  the real run: `liveRun` claims on stable over REST, moves the ticket to In Progress, runs the worker and
 *              review sessions on the pinned Claude Code, gates the result, releases the claim and hands the ticket back.
 *              It spends (about $13) and writes to stable and Linear. It does NOT push or open a PR — that is cut 3.
 *
 *   bun --no-env-file --config=/dev/null scripts/agent-runner/live-run.ts --ticket SMD-NNNN \
 *     --claude <path> --sha256 <hex> --version <x.y.z> [--plan | --execute]
 *   bun scripts/agent-runner/live-run.ts --self-check     # the brief-ticket builder and the plan on fixtures, offline
 *
 * It reuses dry-run.ts's loaders (the config, the keys, the hermetic fetch, the Linear client) and facts.ts's hermetic
 * git, so the one thing new here is the glue: the ticket's full fields from Linear, the bare repository, and (in the
 * execute layer) the real RunDeps and LiveDeps. The GitHub identity is cut 3, so a run commits as a placeholder bot and
 * never publishes; its branch stays in the bare repository for the maintainer.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { KEY_FILES, RUNNER_DIR, START_FLAGS, masker, noRedirect, parseConfig, privateDirProblem, readKey, readOwnedFile, riskyEnv } from "./dry-run.ts";
import { READY_LABEL, TIME_LIMITS, gitEnv, readBoard, type Config, type Fetch } from "./facts.ts";
import { linearClient, type Gql } from "../../db/linear-api.ts";
import { ticketProblem, type BriefTicket } from "./brief.ts";
import { TICKET_ID, type Ticket } from "./select.ts";
import { branchFor } from "./record.ts";
import { run, type RunDeps, type RunInput, type RunLimits, type RunSession, type SessionRequest } from "./run.ts";
import { liveRun, type LiveDeps, type LiveInput, type LiveResult } from "./live.ts";
import { REAL_DEPS, runSession, type Pinned } from "./session.ts";
import { profileHashes, settingsText, type SessionLimits, type SessionPaths } from "./profile.ts";
import { PROBES, STAMP_FILE, developerGit, hostStamp, stampProblem } from "./probes.ts";
import type { Commitlint, GitRun, ScanSecrets } from "./gate.ts";

/** The commit identity a run's sessions use. The real bot (SMD-4089's GitHub machine account) is cut 3; until then a run commits as this placeholder and never publishes, so no real identity is needed. */
export const BOT = { name: "Agent Runner", email: "agent-runner@runner.invalid" } as const;

/** The runner's state, outside every checkout: the bare repository it clones per run, and the run records (docs, "Records"). */
export const STATE_DIR = join(homedir(), ".local", "share", "open-brain", "agent-runner");
/** The runner's own bare repository — a mirror of the repo it works, cloned from the maintainer's main checkout and fetched each run (decision 8). */
export const BARE_REPO = join(STATE_DIR, "repo.git");

/**
 * git args for the runner's own LOCAL operations: no credential helper, and no background gc (an auto-gc mid-run races
 * the review checkout's clone — run.ts). Every repo the runner's own git touches is local — the main checkout, its own
 * bare repo, the per-run clone — never a remote, so the file transport stays at git's default. facts.ts's GIT_SAFE
 * (https only, no redirect) is for the GitHub `ls-remote` alone, and would wrongly refuse a local clone.
 */
export const LOCAL_GIT = ["-c", "credential.helper=", "-c", "gc.auto=0"] as const;

/** git for the runner's own steps (the bare repo, the clone), hermetic (gitEnv: no maintainer config, no prompt) and local-only (LOCAL_GIT). */
export function gitRunner(home: string): GitRun {
  const env = gitEnv(home);
  return (args: string[]) => {
    const r = Bun.spawnSync(["/usr/bin/git", ...LOCAL_GIT, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
}

/**
 * Provision the runner's bare repository and read the base the run builds on. First run: a bare clone of the
 * maintainer's main checkout (a local path, no network). Every run: fetch `main` from it, so the base is the checkout's
 * current `origin/main`. Returns the base commit, or a problem.
 */
export function ensureBareRepo(git: GitRun, bareRepo: string, mainCheckout: string): { ok: true; base: string } | { ok: false; problem: string } {
  if (!existsSync(join(bareRepo, "HEAD"))) {
    mkdirSync(bareRepo, { recursive: true, mode: 0o700 });
    const cloned = git(["clone", "--bare", "--quiet", mainCheckout, bareRepo]);
    if (cloned.code !== 0) return { ok: false, problem: `bare clone of ${mainCheckout} failed: ${cloned.stderr.trim()}` };
  }
  // Fetch the checkout's main into the bare repo's own main, so the base is the maintainer's current origin/main.
  const fetched = git(["-C", bareRepo, "fetch", "--quiet", "--no-tags", mainCheckout, "refs/remotes/origin/main:refs/heads/main"]);
  if (fetched.code !== 0) return { ok: false, problem: `fetch main into the bare repo failed: ${fetched.stderr.trim()}` };
  const rev = git(["-C", bareRepo, "rev-parse", "main"]);
  if (rev.code !== 0 || !/^[0-9a-f]{40}$/.test(rev.stdout.trim())) return { ok: false, problem: `the bare repo has no main to build on: ${rev.stderr.trim()}` };
  return { ok: true, base: rev.stdout.trim() };
}

/** A Linear description's "Verify" section, one item per entry. The repo's tickets write Problem / Work / Verify; the Verify items are the bullets or numbered lines under the Verify heading, up to the next heading. Empty when there is none. */
export function parseVerify(description: string): string[] {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+verify\b/i.test(l) || /^\s*\*{0,2}verify\*{0,2}\s*:?\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) break; // the next heading ends the section
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    if (m) items.push(m[1].trim());
  }
  return items;
}

/**
 * The other ticket ids a description names, by id only, deduped and without the ticket's own id. Restricted to the
 * ticket's own team key (the runner works one team), so a token shaped like a team key but no ticket — `UTF-8`,
 * `SHA-256`, `ISO-8601` — is not taken for one. A cross-team mention is not captured; the brief lists these as context,
 * not vouched for, so precision matters more than catching every reference.
 */
export function parseNamed(description: string, ownId: string): string[] {
  const teamKey = ownId.split("-")[0];
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(teamKey)) return []; // a plain team key, safe to put in the RegExp
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of description.matchAll(new RegExp(`\\b${teamKey}-\\d+\\b`, "g"))) {
    const id = m[0];
    if (id === ownId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** One ticket's full fields from Linear, for the brief: the id and title from the board row, the description fetched, and Verify and the named ids parsed from it. */
const TICKET_QUERY = `query($id: String!) { issue(id: $id) { identifier title description } }`;

/**
 * Build the BriefTicket for `identifier`: fetch its description (the board row carries only the title), parse Verify and
 * the named ids, and check the whole with `ticketProblem` (a malformed id or a character that doesn't show is refused
 * before any of it reaches a session, as the runner's design requires). Returns the ticket or a problem.
 */
export async function ticketFor(gql: Gql, row: Ticket): Promise<{ ok: true; ticket: BriefTicket } | { ok: false; problem: string }> {
  const r = await gql<{ issue: { identifier: string; title: string; description: string | null } | null }>(TICKET_QUERY, { id: row.identifier });
  if (r.errors.length) return { ok: false, problem: `Linear errored reading ${row.identifier}: ${r.errors.map((e) => e.message).join("; ")}` };
  const issue = r.data?.issue;
  if (!issue) return { ok: false, problem: `Linear has no issue ${row.identifier}` };
  const description = issue.description ?? "";
  const ticket: BriefTicket = { identifier: issue.identifier, title: issue.title, description, verify: parseVerify(description), named: parseNamed(description, issue.identifier) };
  const problem = ticketProblem(ticket);
  if (problem) return { ok: false, problem: `${row.identifier} can't be briefed: ${problem}` };
  return { ok: true, ticket };
}

/** The install: the checkout this script lives in (its guard.ts runs the sessions' hook, its profile templates configure them). A real deploy keeps it at ~/.local/share/open-brain/agent-runner/install; for a hand-run it is the working tree. */
export function installDir(): string {
  return realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
}

// ── The execute layer: the real RunDeps/LiveDeps and the run ──────────────────────────────────────────────

/** The per-run limits (docs, "Limits"): the worker's $10 over both its runs, the review's $3, the $1 the resume needs, and the session time caps (about an hour a run, split worker/review/resume). */
export const RUN_LIMITS: RunLimits = {
  workerBudgetUsd: 10, reviewBudgetUsd: 3, resumeMinUsd: 1,
  workerMs: 30 * 60_000, reviewMs: 15 * 60_000, resumeMs: 15 * 60_000,
};
/** The sessions' model and effort (decision 4: claude-opus-5-5 at xhigh); run.ts sets each session's budget, and the turns are bounded. */
const SESSION_LIMITS: Omit<SessionLimits, "maxBudgetUsd"> = { model: "claude-opus-5-5", effort: "xhigh", maxTurns: 200 };
/** The gate's diff size cap, in bytes (run-check uses the same). */
const SIZE_CAP = 1_000_000;

const randomHex = (n: number): string => randomBytes(n).toString("hex");
/** A short temp directory (`/private/tmp/obr-<hex>`, profile.ts CHILD_TMP_MAX), for a session or a scratch. */
function shortTmp(): string {
  const dir = `/private/tmp/obr-${randomHex(4)}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Parse @commitlint/cli's result: exit 0 is a pass; otherwise each ✖ line (but the "found N problems" summary) is a problem. */
export function parseCommitlint(exitCode: number, output: string): { ok: boolean; problems: string[] } {
  if (exitCode === 0) return { ok: true, problems: [] };
  const problems = output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("✖") && !/found \d+ problem/i.test(l)).map((l) => l.replace(/^✖\s*/, "").trim()).filter(Boolean);
  return { ok: false, problems: problems.length ? problems : [`commitlint exited ${exitCode}`] };
}

/** The gate's commitlint: the house grammar via @commitlint/cli, from the install's config, in a private bunx cache (the ajv-cache gotcha — the shared cache can lose a dependency). One message at a time, on a temp file. */
function commitlintFor(install: string): Commitlint {
  const config = join(install, "scripts", "commitlint.config.ts");
  const bunDir = dirname(process.execPath);
  const env = { PATH: `${bunDir}:/usr/bin:/bin`, HOME: homedir(), BUN_INSTALL_CACHE_DIR: join(homedir(), ".cache", "ob1-commitlint-run") };
  return (message: string) => {
    const dir = shortTmp();
    try {
      const file = join(dir, "msg");
      writeFileSync(file, message);
      const r = Bun.spawnSync([join(bunDir, "bunx"), "--bun", "@commitlint/cli@19.6.1", "--config", config, "--edit", file], { cwd: install, env, stdout: "pipe", stderr: "pipe" });
      return parseCommitlint(r.exitCode ?? -1, `${r.stdout.toString()}\n${r.stderr.toString()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Everything a run's sessions take from the run, closed over by the runWorker/runReview seams. */
export type ExecCtx = {
  install: string; bun: string; devGit: string; runnerGit: GitRun; pinned: Pinned;
  gitConfig: string; keyFile: string; home: string; user: string; uid: number;
  bareRepo: string; base: string; workerTmp: string; reviewTmp: string;
};

/** The run's config directory holds the base commit's CLAUDE.md, loaded as the session's user memory (profile.ts decision 3). Written once per run, from the bare repo; an empty file if the base has none. */
function ensureConfigDir(ctx: ExecCtx, configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const claude = join(configDir, "CLAUDE.md");
  if (existsSync(claude)) return;
  const show = ctx.runnerGit(["-C", ctx.bareRepo, "show", `${ctx.base}:CLAUDE.md`]);
  writeFileSync(claude, show.code === 0 ? show.stdout : "");
}

/** The session's paths for a run step. The record and config are SUBDIRS of the run directory (`dirname(root)`), siblings of the clone — not the run directory itself, which holds the clone and would fail profile.ts's pathsProblem (the root must be apart from the record). run.ts clones to `<dir>/clone` and checks the review out at `<dir>/review`. */
export function sessionPaths(ctx: ExecCtx, root: string, role: "worker" | "review"): SessionPaths {
  const dir = dirname(root);
  return {
    install: ctx.install, bun: ctx.bun, git: ctx.devGit, root,
    tmp: role === "worker" ? ctx.workerTmp : ctx.reviewTmp,
    record: join(dir, "record"), configDir: join(dir, "config"),
    keyFile: ctx.keyFile, gitConfig: ctx.gitConfig, home: ctx.home,
  };
}

/** One session seam (run.ts's runWorker/runReview): build the SessionSpec (via sessionPaths), make its record and config directories, and run it on the pinned Claude Code. */
function makeRunSession(ctx: ExecCtx, role: "worker" | "review"): RunSession {
  return async (req: SessionRequest) => {
    const paths = sessionPaths(ctx, req.root, role);
    mkdirSync(paths.record, { recursive: true, mode: 0o700 });
    ensureConfigDir(ctx, paths.configDir);
    const limits: SessionLimits = { ...SESSION_LIMITS, maxBudgetUsd: req.maxBudgetUsd };
    return runSession({
      role, paths, limits, pinned: ctx.pinned, prompt: req.prompt,
      settings: settingsText(role, paths), timeLimitMs: req.timeLimitMs,
      user: ctx.user, uid: ctx.uid, ...(req.resume === undefined ? {} : { resume: req.resume }),
    }, REAL_DEPS);
  };
}

/** Assemble the real RunDeps for a run: the runner's own git for the bare repo, the two session seams, the worker's temp directory, the house commitlint, the session hook's secret scanner, and the clock. */
function runDepsFor(ctx: ExecCtx, scanSecrets: ScanSecrets): RunDeps {
  return {
    git: ctx.runnerGit,
    runWorker: makeRunSession(ctx, "worker"),
    runReview: makeRunSession(ctx, "review"),
    workerTmp: ctx.workerTmp,
    commitlint: commitlintFor(ctx.install),
    scanSecrets,
    now: () => new Date(),
  };
}

/** `--name value` or `--name=value`; a flag takes none; anything unknown is refused. Mirrors probes.ts/dry-run.ts. */
const KNOWN: Record<string, "value" | "flag"> = { "--ticket": "value", "--claude": "value", "--sha256": "value", "--version": "value", "--plan": "flag", "--execute": "flag", "--self-check": "flag", "--help": "flag" };
export function parseArgs(argv: string[]): Record<string, string | true> | { error: string } {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.indexOf("=");
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const kind = Object.hasOwn(KNOWN, name) ? KNOWN[name] : undefined;
    if (!kind) return { error: `unknown option ${tok}; known: ${Object.keys(KNOWN).join(" ")}` };
    if (kind === "flag") {
      if (eq > 0) return { error: `${name} takes no value` };
      out[name] = true;
      continue;
    }
    const value = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value` };
    out[name] = value;
  }
  return out;
}

/** What `main` takes from its process, so a test drives it on stubs. The Linear client is built inside `main` from the key it reads, over this `fetch` (as dry-run.ts does), so a test stubs `fetch`, not the client. */
export type Io = {
  argv: string[];
  env: Record<string, string | undefined>;
  runnerDir: string;
  execArgv: string[];
  cwd: string;
  fetch: Fetch;
  git: GitRun;
  out: (s: string) => void;
  err: (s: string) => void;
};

/**
 * The executor from its arguments to an exit code. The checks are dry-run.ts's (Bun's start, the risky environment, the
 * runner's private directory, the config and the keys), then the ticket is taken and the bare repo provisioned. --plan
 * prints and stops; --execute checks the probe stamp, assembles the real deps, and runs liveRun. 0 on a plan or a run that
 * started, 1 on a read failure or a run that couldn't start, 2 for anything refused.
 */
export async function main(io: Io): Promise<number> {
  const refuse = (m: string): number => { io.err(`live-run: ${m}`); return 2; };
  const opts = parseArgs(io.argv);
  if ("error" in opts) return refuse(String(opts.error));
  if (opts["--self-check"]) return (await import("./live-run-check.ts")).selfCheck();
  if (opts["--help"]) {
    io.out("bun --no-env-file --config=/dev/null scripts/agent-runner/live-run.ts --ticket SMD-NNNN --claude <path> --sha256 <hex> --version <x.y.z> [--plan | --execute]");
    return 0;
  }
  if (!START_FLAGS.every((f) => io.execArgv.includes(f))) return refuse(`start it with ${START_FLAGS.join(" ")}, so Bun reads no .env or bunfig.toml`);
  if (opts["--plan"] && opts["--execute"]) return refuse("--plan and --execute are exclusive");
  const mode = opts["--execute"] ? "execute" : "plan";
  const ticketId = opts["--ticket"];
  if (typeof ticketId !== "string") return refuse("--ticket SMD-NNNN is required (a team key and a number)");
  if (!TICKET_ID.test(ticketId)) return refuse(`--ticket ${ticketId} is not a team key and a number`);

  const risky = riskyEnv(io.env);
  if (risky.length) return refuse(`the environment sets ${risky.join(", ")}: unset it for the run`);
  const dirProblem = privateDirProblem(io.runnerDir);
  if (dirProblem) return refuse(dirProblem);
  const configPath = join(io.runnerDir, "config.json");
  let cfg: Config;
  let brainKey: string | null;
  let linearKey: string | null;
  try {
    const text = readOwnedFile(configPath, false);
    if (text === null) return refuse(`no config at ${configPath}`);
    const parsed = parseConfig(text, homedir());
    if ("error" in parsed) return refuse(`${configPath}: ${parsed.error}`);
    cfg = parsed;
    brainKey = readKey(io.runnerDir, "brain");
    linearKey = readKey(io.runnerDir, "linear");
  } catch (e) {
    return refuse((e as Error).message);
  }
  if (!cfg.restUrl) return refuse("config has no restUrl: stable's /api must be reachable for a claim");
  if (!brainKey) return refuse(`there is no brain key at ${join(io.runnerDir, KEY_FILES.brain)}`);
  if (!linearKey) return refuse(`there is no Linear key at ${join(io.runnerDir, KEY_FILES.linear)}`);
  const safeFetch = noRedirect(io.fetch);
  const gql = linearClient(linearKey, safeFetch, { timeoutMs: TIME_LIMITS.linear });
  // A read's answer or a reader's error must never carry a key, as dry-run.ts guards: mask every value the keys could take.
  const mask = masker([linearKey, brainKey]);

  // Take the ticket: it must be on the board, and its full fields must brief cleanly.
  let board: Awaited<ReturnType<typeof readBoard>>;
  try {
    board = await readBoard(gql, cfg);
  } catch (e) {
    io.err(`live-run: reading the board failed: ${mask((e as Error).message)}`);
    return 1;
  }
  const row = board.tickets.find((t) => t.identifier === ticketId);
  if (!row) return refuse(`${ticketId} is not on the board (team ${cfg.team}, initiative, open states). Only a labelled, open ticket can be taken.`);
  const agentReady = row.labelIds.includes(board.readyLabelId);
  if (mode === "execute" && !agentReady) return refuse(`${ticketId} is not labelled ${READY_LABEL}; the runner takes only tickets the maintainer marked for it`);
  const built = await ticketFor(gql, row);
  if (!built.ok) return refuse(mask(built.problem));

  const bare = ensureBareRepo(io.git, BARE_REPO, cfg.mainCheckout);
  if (!bare.ok) { io.err(`live-run: ${mask(bare.problem)}`); return 1; }
  const branch = branchFor(built.ticket.identifier, built.ticket.title);

  if (mode === "plan") {
    const t = built.ticket;
    io.out(mask([
      `A run would take ${t.identifier} — "${t.title}"`,
      `  agent-ready label: ${agentReady ? "yes" : "NO (not labelled for the runner)"}`,
      `  branch:   ${branch}`,
      `  base:     ${bare.base} (the main checkout's origin/main, mirrored into ${BARE_REPO})`,
      `  bot:      ${BOT.name} <${BOT.email}> (placeholder; GitHub identity is cut 3, so no PR)`,
      `  Verify:   ${t.verify.length} item(s)${t.verify.length ? `\n${t.verify.map((v, i) => `    ${i + 1}. ${v}`).join("\n")}` : ""}`,
      `  names:    ${t.named.length ? t.named.join(", ") : "(none)"}`,
      `  stable:   ${cfg.restUrl}`,
      "",
      "--plan only: no session, no claim, no Linear write, no spend. --execute claims, runs the sessions (~$13) and hands back; no PR.",
    ].join("\n")));
    return 0;
  }

  // --execute: the real run (the ticket is agent-ready, checked above), only with the pinned Claude Code.
  const claudeOpt = opts["--claude"], sha256 = opts["--sha256"], version = opts["--version"];
  if (typeof claudeOpt !== "string" || typeof sha256 !== "string" || typeof version !== "string") return refuse("--execute needs --claude <path> --sha256 <hex> --version <x.y.z> (the pinned Claude Code)");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return refuse("--sha256 must be 64 hex characters");
  let claudePath: string;
  try { claudePath = realpathSync(claudeOpt); } catch { return refuse(`--claude ${claudeOpt} doesn't resolve to a file`); }
  const keyFile = join(io.runnerDir, "anthropic.key");
  let keyMode: number;
  try { keyMode = statSync(keyFile).mode; } catch { return refuse(`no Anthropic key at ${keyFile}`); }
  if ((keyMode & 0o077) !== 0) return refuse(`the Anthropic key must be owner-only (chmod 600): ${keyFile}`);
  const devGit = developerGit();
  if (devGit === null) return refuse("no git in the active developer directory (xcode-select -p)");

  // Layer 5: a real session starts only under a probe stamp that covers this Claude Code, host and install — the profile
  // is as-probed. Any change to a profile file (probes.ts included) voids it, so the maintainer re-runs the mock probes.
  const install = installDir();
  const pinned: Pinned = { path: claudePath, sha256, version };
  let stamp: unknown;
  try { stamp = JSON.parse(readFileSync(join(STATE_DIR, STAMP_FILE), "utf8")); }
  catch { return refuse(`no probe stamp at ${join(STATE_DIR, STAMP_FILE)}: run the mock probes on this Claude Code first (bun --no-env-file --config=/dev/null scripts/agent-runner/probes.ts --claude ${claudePath} --sha256 ${sha256} --version ${version})`); }
  const stampProb = stampProblem(stamp, pinned, await hostStamp(process.execPath, devGit), install, profileHashes(install), PROBES.map((p) => p.name));
  if (stampProb) return refuse(`the probe stamp doesn't cover this run: ${stampProb}`);

  // The hook's secret scanner, loaded before any temp directory is made (so an import failure leaks nothing).
  // @ts-expect-error — session-capture.mjs is plain JavaScript with no type declarations; its scanForSecrets shape is asserted here.
  const hook = (await import("../../recipes/session-capture-hook/session-capture.mjs")) as { scanForSecrets: (t: string) => { reason: string }[] };
  const scanSecrets: ScanSecrets = (text) => hook.scanForSecrets(text).map((f) => f.reason);

  // The bot identity the sessions commit with (GIT_CONFIG_GLOBAL), a fixed file; prepareClone also sets the clone's own.
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const gitConfig = join(STATE_DIR, "bot.gitconfig");
  writeFileSync(gitConfig, `[user]\n\tname = ${BOT.name}\n\temail = ${BOT.email}\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n`, { mode: 0o644 });

  const ctx: ExecCtx = {
    install, bun: process.execPath, devGit, runnerGit: io.git,
    pinned, gitConfig, keyFile, home: homedir(),
    user: userInfo().username, uid: process.getuid?.() ?? 0,
    bareRepo: BARE_REPO, base: bare.base, workerTmp: shortTmp(), reviewTmp: shortTmp(),
  };
  const deps = runDepsFor(ctx, scanSecrets);
  const runInput: Omit<RunInput, "claimId"> = { state: STATE_DIR, ticket: built.ticket, base: bare.base, bareRepo: BARE_REPO, bot: BOT, sizeCapBytes: SIZE_CAP, limits: RUN_LIMITS, deps };
  const liveDeps: LiveDeps = { fetch: safeFetch, gql, brainKey, runnerDir: io.runnerDir, readyLabelId: board.readyLabelId, handedBackLabelId: board.handedBackLabelId, run };

  io.out(mask(`live-run: executing ${built.ticket.identifier} on ${branch}, base ${bare.base}. Claiming on ${cfg.restUrl}, then the worker and review sessions (up to ~$13). No PR — cut 3 publishes.`));
  let result: LiveResult;
  try {
    result = await liveRun({ leaseSeconds: 86400, claimLabel: `agent-runner@${ctx.user} ${branch}`, runInput, cfg, deps: liveDeps });
  } finally {
    rmSync(ctx.workerTmp, { recursive: true, force: true });
    rmSync(ctx.reviewTmp, { recursive: true, force: true });
  }
  io.out(mask(`live-run: ${result.stage} — outcome ${result.outcome ?? "gate passed"}, claim ${result.claimId ?? "none"}, released ${result.released}, handed-back ${result.handedBack}, commented ${result.commented}. ${result.detail}`));
  if (result.owed.length) io.out(mask(`owed (step 0 would retry): ${result.owed.join("; ")}`));
  if (result.notes.length) io.out(mask(`notes: ${result.notes.join("; ")}`));
  return result.stage === "ran" || result.stage === "closed" ? 0 : 1;
}

if (import.meta.main) {
  const { stdout, stderr } = process;
  process.exit(await main({
    argv: process.argv.slice(2),
    env: process.env,
    runnerDir: RUNNER_DIR,
    execArgv: process.execArgv,
    cwd: process.cwd(),
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    git: gitRunner(homedir()),
    out: (s) => stdout.write(`${s}\n`),
    err: (s) => stderr.write(`${s}\n`),
  }));
}
