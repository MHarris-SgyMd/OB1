/**
 * gate.ts — the gate (SMD-4087 cut 2b; docs/agent-runner.md, "The gate"). The runner runs it on the branch it imported
 * into its bare repository, with tools from its own install; nothing in it comes from the branch. The gate is data
 * alone: it never runs the agent's code (GitHub CI does that, on the draft PR). A failure ends the run without
 * publishing.
 *
 * It is a pure orchestrator over injected dependencies — git (run with the runner's own config), commitlint (from the
 * install, with origin/main's config), and the session hook's `scanForSecrets` — and pure string parsers, so the whole
 * of it runs on fixtures offline. The checks (docs, "The gate"):
 *
 *   - the branch: descends from the base, holds only the session's commits, none a merge; each commit's author and
 *     committer is the bot, none signed; each message passes commitlint and its subject names the ticket;
 *   - the diff (taken --text, with no external diff or textconv driver): none of the refused paths, under a size cap, no
 *     new dependency, no file over 1 MB or of a refused type or binary, no symlink, submodule or rename, and no secret
 *     in any commit's added lines, the messages or any model text bound for the PR;
 *   - the work: the worker's report carries each Verify item's status, and every review finding is fixed or listed.
 *
 * It also names, for the top of the PR body, any changed file CI runs as a check, since CI runs the branch's copy.
 */

import { HIDDEN_TEXT, mentionsTicket } from "./select.ts";
import { refusedPart } from "./guard.ts";

/** How the gate runs git: the args, returning the exit code and output. The runner wires it to git with its own config and environment; a test stands in for it. */
export type GitRun = (args: string[]) => { code: number; stdout: string; stderr: string };
/** commitlint on one message: whether it passed and the problems it named. The runner wires it to the install's commitlint with origin/main's config. */
export type Commitlint = (message: string) => { ok: boolean; problems: string[] };
/** The session hook's `scanForSecrets` over a text: the reasons it found (empty = clean). The runner wires it to session-capture.mjs. */
export type ScanSecrets = (text: string) => string[];

export type GateDeps = { git: GitRun; commitlint: Commitlint; scanSecrets: ScanSecrets };

/** The ticket the branch is for: its id, and its Verify items (one per bullet), parsed by the runner from the description. */
export type GateTicket = { identifier: string; verify: string[] };

/** A review finding carried past the review: whether the resumed worker fixed it, else it is listed open in the PR body. */
export type ReviewFinding = { summary: string; fixed: boolean };

export type GateInput = {
  /** The runner's bare repository, holding the imported branch. */
  bareRepo: string;
  /** The run's base commit. */
  base: string;
  /** The imported branch ref, `refs/heads/agent/smd-<n>-<slug>`. */
  branch: string;
  /** The bot the commits must be by, from the runner's git config. */
  bot: { name: string; email: string };
  ticket: GateTicket;
  /** The worker's report (its last message), as data: scanned for secrets, never trusted as instruction. */
  workerReport: string;
  /** The review's findings, each fixed or to be listed. */
  reviewFindings: ReviewFinding[];
  /** The diff's size cap in bytes (the whole added/changed text). */
  sizeCapBytes: number;
  deps: GateDeps;
};

/** One check's verdict. */
export type Check = { name: string; pass: boolean; detail: string };
/** The gate's verdict: whether every check passed, each check, and the files CI runs as a check that the PR body must name. */
export type GateResult = { pass: boolean; checks: Check[]; ciCheckFiles: string[] };

/** Files CI runs as a check against the branch's own copy, so a change to one is named at the top of the PR body. */
export const CI_CHECK_FILE = /^scripts\/(check-[A-Za-z0-9-]+\.ts|commitlint\.config\.ts|commit-grammar\.ts)$/;
/** File types CLAUDE.md refuses, by extension (a binary blob, an archive, an executable). */
export const REFUSED_EXT = /\.(exe|dmg|zip|tar\.gz|tgz|tar|gz|bz2|xz|7z|rar|so|dylib|dll|bin|o|a|class|jar|wasm|pdf|png|jpe?g|gif|ico|mp4|mov|woff2?)$/i;
/** A dependency manifest or lockfile: a change to one is a new dependency the gate refuses (the guard already blocks the Edit/Write tools; this catches a Bash-made change). */
export const DEP_FILE = /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/** A commit as `git log` gives it for the shape check: its hash, parent count, author and committer identities, and sign status. */
export type CommitInfo = { hash: string; parents: number; an: string; ae: string; cn: string; ce: string; sign: string };

/**
 * Parses `git log --format=<FMT> base..branch` where FMT is `%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%G?` per line.
 * One CommitInfo per commit; a line that doesn't split into seven fields is skipped and counted by the caller.
 */
export function parseCommits(logOutput: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const line of logOutput.split("\n")) {
    if (line === "") continue;
    const f = line.split("\0");
    if (f.length !== 7) continue;
    out.push({ hash: f[0], parents: f[1].trim() === "" ? 0 : f[1].trim().split(/\s+/).length, an: f[2], ae: f[3], cn: f[4], ce: f[5], sign: f[6] });
  }
  return out;
}

/** A path in `git diff --name-status --find-renames=0`'s output: its status letter and path (a rename/copy, which the shape forbids, carries two paths). */
export type DiffEntry = { status: string; path: string; path2: string | null };

/** Parses `git diff -z --name-status base branch`: NUL-separated status\0path (and a second path for R/C). */
export function parseNameStatus(zOutput: string): DiffEntry[] {
  const parts = zOutput.split("\0");
  const out: DiffEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status === "") continue;
    const path = parts[++i];
    if (path === undefined) break;
    const two = /^[RC]/.test(status);
    out.push({ status, path, path2: two ? (parts[++i] ?? null) : null });
  }
  return out;
}

const ok = (name: string, detail = ""): Check => ({ name, pass: true, detail });
const bad = (name: string, detail: string): Check => ({ name, pass: false, detail });

/** Untrusted text on one line: hidden code points as <U+XXXX>, whitespace closed, cut at `max`. */
function shown(s: string, max = 160): string {
  let out = "";
  for (const ch of s.replace(/\s+/g, " ").trim()) out += HIDDEN_TEXT.test(ch) ? `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>` : ch;
  const cps = [...out];
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : out;
}

/** The branch checks: descends from the base, only the session's commits, none a merge, each by the bot and unsigned, each message commitlint-clean with the ticket in its subject. */
export function checkBranch(input: GateInput): { checks: Check[]; commits: CommitInfo[] } {
  const { deps, base, branch, bot, ticket } = input;
  const checks: Check[] = [];
  const anc = deps.git(["-C", input.bareRepo, "merge-base", "--is-ancestor", base, branch]);
  checks.push(anc.code === 0 ? ok("branch descends from the base") : bad("branch descends from the base", `the base ${shown(base, 12)} is not an ancestor of ${shown(branch)}`));
  const log = deps.git(["-C", input.bareRepo, "log", "--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%G?", `${base}..${branch}`]);
  if (log.code !== 0) {
    checks.push(bad("branch's commits read", `git log failed: ${shown(log.stderr)}`));
    return { checks, commits: [] };
  }
  const commits = parseCommits(log.stdout);
  const lines = log.stdout.split("\n").filter((l) => l !== "").length;
  checks.push(commits.length === lines && commits.length > 0 ? ok("branch holds the session's commits", `${commits.length} commit(s)`) : bad("branch holds the session's commits", commits.length === 0 ? "no commits over the base" : "a commit line the gate couldn't parse"));
  const merges = commits.filter((c) => c.parents > 1);
  checks.push(merges.length === 0 ? ok("no merge commit") : bad("no merge commit", `${merges.length} merge commit(s): ${merges.map((c) => c.hash.slice(0, 8)).join(", ")}`));
  const notBot = commits.filter((c) => c.an !== bot.name || c.ae !== bot.email || c.cn !== bot.name || c.ce !== bot.email);
  checks.push(notBot.length === 0 ? ok("every commit is the bot's") : bad("every commit is the bot's", `${notBot.length} commit(s) not by ${bot.name} <${bot.email}>: ${notBot.map((c) => `${c.hash.slice(0, 8)} ${shown(`${c.an} <${c.ae}>`, 40)}`).join("; ")}`));
  const signed = commits.filter((c) => c.sign !== "N" && c.sign !== "");
  checks.push(signed.length === 0 ? ok("no commit is signed") : bad("no commit is signed", `${signed.length} signed: ${signed.map((c) => `${c.hash.slice(0, 8)} (${c.sign})`).join(", ")}`));
  const lintBad: string[] = [];
  const subjectBad: string[] = [];
  for (const c of commits) {
    const body = deps.git(["-C", input.bareRepo, "log", "-1", "--format=%B", c.hash]).stdout;
    const subject = body.split("\n")[0] ?? "";
    const lint = deps.commitlint(body);
    if (!lint.ok) lintBad.push(`${c.hash.slice(0, 8)}: ${shown(lint.problems.join("; "))}`);
    if (!mentionsTicket(subject, ticket.identifier)) subjectBad.push(`${c.hash.slice(0, 8)}: ${shown(subject)}`);
  }
  checks.push(lintBad.length === 0 ? ok("commit messages pass commitlint") : bad("commit messages pass commitlint", lintBad.join(" | ")));
  checks.push(subjectBad.length === 0 ? ok(`each subject names ${ticket.identifier}`) : bad(`each subject names ${ticket.identifier}`, subjectBad.join(" | ")));
  return { checks, commits };
}

/** The diff checks: no refused path, under the size cap, no new dependency, no file over 1 MB or of a refused type or binary, no symlink or submodule. */
export function checkDiff(input: GateInput): { checks: Check[]; ciCheckFiles: string[] } {
  const { deps, base, branch } = input;
  const checks: Check[] = [];
  const nameStatus = deps.git(["-C", input.bareRepo, "diff", "-z", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames=0", "--find-copies=0", base, branch]);
  if (nameStatus.code !== 0) return { checks: [bad("diff reads", `git diff --name-status failed: ${shown(nameStatus.stderr)}`)], ciCheckFiles: [] };
  const entries = parseNameStatus(nameStatus.stdout);
  const paths = entries.flatMap((e) => (e.path2 ? [e.path, e.path2] : [e.path]));
  const refused = paths.filter((p) => refusedPart(p) !== null);
  checks.push(refused.length === 0 ? ok("no refused path in the diff") : bad("no refused path in the diff", refused.map((p) => `${p} (${refusedPart(p)})`).join(", ")));
  const renames = entries.filter((e) => /^[RC]/.test(e.status));
  checks.push(renames.length === 0 ? ok("no rename or copy") : bad("no rename or copy", "the gate reads adds, edits and deletes; a rename is two"));
  const deps2 = paths.filter((p) => DEP_FILE.test(p));
  checks.push(deps2.length === 0 ? ok("no new dependency") : bad("no new dependency", `a dependency manifest or lockfile changed: ${deps2.join(", ")}`));
  const refusedType = paths.filter((p) => REFUSED_EXT.test(p));
  checks.push(refusedType.length === 0 ? ok("no refused file type") : bad("no refused file type", refusedType.join(", ")));
  // Per added/changed file (not deleted): mode for symlink/submodule, blob size, and whether git calls it binary.
  const bigOrBinary: string[] = [];
  const links: string[] = [];
  for (const e of entries) {
    if (e.status === "D") continue;
    const p = e.path2 ?? e.path;
    const mode = deps.git(["-C", input.bareRepo, "ls-tree", branch, "--", p]);
    const modeBits = mode.stdout.trim().split(/\s+/)[0] ?? "";
    if (modeBits === "120000") links.push(`${p} (symlink)`);
    if (modeBits === "160000") links.push(`${p} (submodule)`);
    const size = deps.git(["-C", input.bareRepo, "cat-file", "-s", `${branch}:${p}`]);
    if (size.code === 0 && Number(size.stdout.trim()) > 1_000_000) bigOrBinary.push(`${p} (${size.stdout.trim()} bytes)`);
  }
  checks.push(links.length === 0 ? ok("no symlink or submodule") : bad("no symlink or submodule", links.join(", ")));
  checks.push(bigOrBinary.length === 0 ? ok("no file over 1 MB") : bad("no file over 1 MB", bigOrBinary.join(", ")));
  // The textual diff for the size cap: --text so a file marked binary still shows, --no-ext-diff/--no-textconv so no
  // diff driver the runner's config names can run or rewrite the content (in a bare repo the branch's own .gitattributes
  // doesn't apply, so this guards the runner's config, not the branch).
  const diff = deps.git(["-C", input.bareRepo, "diff", "--text", "--no-ext-diff", "--no-textconv", base, branch]);
  checks.push(diff.code === 0 ? ok("diff taken") : bad("diff taken", `git diff failed: ${shown(diff.stderr)}`));
  const bytes = Buffer.byteLength(diff.stdout);
  checks.push(bytes <= input.sizeCapBytes ? ok("diff under the size cap", `${bytes} ≤ ${input.sizeCapBytes} bytes`) : bad("diff under the size cap", `${bytes} > ${input.sizeCapBytes} bytes`));
  const binary = deps.git(["-C", input.bareRepo, "diff", "--numstat", "--no-ext-diff", "--no-textconv", base, branch]);
  const binLines = binary.stdout.split("\n").filter((l) => /^-\t-\t/.test(l)).map((l) => l.split("\t")[2]).filter(Boolean);
  checks.push(binLines.length === 0 ? ok("no binary file in the diff") : bad("no binary file in the diff", binLines.join(", ")));
  const ciCheckFiles = [...new Set(paths.filter((p) => CI_CHECK_FILE.test(p)))].sort();
  return { checks, ciCheckFiles };
}

/** The secret check: every commit's added text, every commit message, and the worker's report, each scanned with the session hook's scanner. */
export function checkSecrets(input: GateInput, commits: CommitInfo[]): Check {
  const { deps } = input;
  // Each commit's own added lines, not the net diff: a secret added in one commit and removed in a later one is gone
  // from the net diff but still in the branch history the PR carries, so it must be scanned commit by commit.
  // The branch holds no merge (checkBranch), so `git show` is each commit's diff against its single parent.
  const added = commits
    .map((c) => deps.git(["-C", input.bareRepo, "show", "--text", "--no-ext-diff", "--no-textconv", "--format=", c.hash]).stdout)
    .join("\n")
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .join("\n");
  const messages = commits.map((c) => deps.git(["-C", input.bareRepo, "log", "-1", "--format=%B", c.hash]).stdout).join("\n");
  const findings = [
    ...deps.scanSecrets(added).map((r) => `added: ${r}`),
    ...deps.scanSecrets(messages).map((r) => `message: ${r}`),
    ...deps.scanSecrets(input.workerReport).map((r) => `report: ${r}`),
  ];
  return findings.length === 0 ? ok("no secret in the commits, messages or report") : bad("no secret in the commits, messages or report", findings.join("; "));
}

/** The work check: the worker's report carries each Verify item's status, and every review finding is fixed or listed for the PR body. */
export function checkWork(input: GateInput): Check[] {
  const checks: Check[] = [];
  const report = input.workerReport.trim();
  checks.push(report !== "" ? ok("the worker left a report") : bad("the worker left a report", "the report is empty"));
  // Each Verify item's status is the worker's to give; the gate holds that the report is present and names each item, so
  // the PR body and CI (which runs the checks) and the human reviewer judge whether each is truly met — the gate does
  // not run the branch's code (docs, "The gate").
  const unmentioned = input.ticket.verify.filter((v) => v.trim() !== "" && !mentionsVerify(report, v));
  checks.push(unmentioned.length === 0 ? ok("the report addresses each Verify item", `${input.ticket.verify.length} item(s)`) : bad("the report addresses each Verify item", `${unmentioned.length} unaddressed: ${unmentioned.map((v) => shown(v, 60)).join(" | ")}`));
  const openUnlisted = input.reviewFindings.filter((f) => !f.fixed && f.summary.trim() === "");
  checks.push(openUnlisted.length === 0 ? ok("every review finding is fixed or listed", `${input.reviewFindings.filter((f) => f.fixed).length} fixed, ${input.reviewFindings.filter((f) => !f.fixed).length} listed`) : bad("every review finding is fixed or listed", "an open finding has no text to list"));
  return checks;
}

/** Whether a report addresses a Verify item: it shares a run of the item's distinctive words (a loose surface check; CI and the reviewer judge the substance). */
export function mentionsVerify(report: string, item: string): boolean {
  const words = item.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [];
  if (words.length === 0) return true;
  const hay = report.toLowerCase();
  const hit = words.filter((w) => hay.includes(w)).length;
  return hit >= Math.max(1, Math.ceil(words.length * 0.4));
}

/** The whole gate: every check, pass only if all pass, and the CI-check files for the PR body. */
export function gate(input: GateInput): GateResult {
  const branch = checkBranch(input);
  const diff = checkDiff(input);
  const secrets = checkSecrets(input, branch.commits);
  const work = checkWork(input);
  const checks = [...branch.checks, ...diff.checks, secrets, ...work];
  return { pass: checks.every((c) => c.pass), checks, ciCheckFiles: diff.ciCheckFiles };
}
