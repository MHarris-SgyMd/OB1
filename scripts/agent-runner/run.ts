/**
 * run.ts — the run orchestrator (SMD-4087 cut 2b-2b-2; docs/agent-runner.md, "A run, step by step" steps 4-7 and 10).
 * It ties the pieces the earlier cuts built into one local run on the record: the per-run clone (clone.ts), the worker's
 * brief (brief.ts), the worker session, the bundle's verify and import (bundle.ts), the diff, the review session, the
 * one resume, and the gate (gate.ts) — recording each step as it goes (record.ts).
 *
 * It drives the sessions through a narrow seam (`runWorker`/`runReview`): the caller turns each SessionRequest into a
 * SessionSpec (paths, settings, the pinned binary, the stand-in Messages API) and calls cut 2a's `runSession`, and the
 * self-check stubs the pair. So run.ts holds the orchestration — the order, the bundle gate, the resume decision, the
 * recording, the failure paths and the cleanup — and nothing of the profile's layout, which cut 2a already proves.
 *
 * Cut 2b's scope stops at the gate: no claim (cut 2c), no push or PR (cut 3). A run that passes the gate leaves its
 * branch in the runner's bare repository and its record at step "gate" with the verdict and no outcome — publishing is
 * what's left. A run that fails records "work-failure" or "env-failure" as the design's hand-back says; the hand-back's
 * own claim and Linear writes are cut 2c, so cut 2b only records the outcome.
 */

import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBrief, buildResumeBrief, buildReviewBrief, ticketProblem, type BriefTicket } from "./brief.ts";
import { importBundle, refOf, verifyBundle } from "./bundle.ts";
import { prepareClone } from "./clone.ts";
import { gate, type Commitlint, type GitRun, type ScanSecrets } from "./gate.ts";
import { branchFor, bundleFile, clonePath, diffFile, reviewCheckout, runDir, runId, startRecord, updateRecord, writeNoFollow, type GateSummary, type Outcome, type RunRecord, type Step } from "./record.ts";
import type { SessionOutcome } from "./session.ts";

/** One session run, as the orchestrator asks for it. The caller turns this into a SessionSpec and calls session.ts's `runSession`; the self-check stubs it. */
export type SessionRequest = {
  /** The session's working directory: the clone (worker) or the review checkout (review). */
  root: string;
  /** The brief, delivered on the session's stdin. */
  prompt: string;
  /** `--max-budget-usd` for this session. */
  maxBudgetUsd: number;
  /** The session's time limit, in milliseconds. */
  timeLimitMs: number;
  /** The worker session id to resume (the resume alone), else undefined. */
  resume?: string;
};

export type RunSession = (req: SessionRequest) => Promise<SessionOutcome>;

/** What the orchestrator takes from its environment, so the self-check can stand in for all of it. */
export type RunDeps = {
  /** git, run with the runner's own config and environment: the clone, the bundle import and the diff. */
  git: GitRun;
  /** Runs a worker session — the first run, or the resume when `req.resume` is set. */
  runWorker: RunSession;
  /** Runs the review session. */
  runReview: RunSession;
  /**
   * The worker session's temp directory, where its bundle goes: the brief names a path under it and `verifyBundle` reads
   * it. The runner makes it short (profile.ts); the resume writes to the same path. A test stands in.
   */
  workerTmp: string;
  /** commitlint, for the gate (run from the runner's install with origin/main's config). */
  commitlint: Commitlint;
  /** The secret scanner, for the gate (the session hook's own, `scanForSecrets`). */
  scanSecrets: ScanSecrets;
  /** The clock, for the run id and the record's timestamps; the self-check pins it. */
  now: () => Date;
};

/** The per-run limits the orchestrator applies (docs, "Limits"). */
export type RunLimits = {
  /** The worker's whole budget, over its first run and the resume together ($10). */
  workerBudgetUsd: number;
  /** The review's budget ($3). */
  reviewBudgetUsd: number;
  /** The least of the worker's budget that must be left for the resume to run; below it the findings are listed open ($1). */
  resumeMinUsd: number;
  workerMs: number;
  reviewMs: number;
  resumeMs: number;
};

/** The run's fixed facts: the ticket, the base, and the identities and limits the sessions and the gate need. */
export type RunInput = {
  /** The runner's state directory; the run's own directory is made under it (record.ts). */
  state: string;
  ticket: BriefTicket;
  /** origin/main's head at the tick: the base the clone starts at and the gate measures against. */
  base: string;
  /** The claim the run works under, or null in cut 2b (no claim). It appears in the worker's brief; null reads there as a local run. */
  claimId: string | null;
  /** The runner's bare repository: cloned for the worker, imported into, and read by the gate. */
  bareRepo: string;
  /** The bot the session's commits must be by (the clone's identity and the gate's branch check). */
  bot: { name: string; email: string };
  /** The gate's diff size cap, in bytes. */
  sizeCapBytes: number;
  limits: RunLimits;
  deps: RunDeps;
};

/** How the run ended: the outcome (null = it reached and passed the gate, publishing left to cut 3), the gate's pass, the record, and the run's directory. */
export type RunResult = {
  outcome: Outcome | null;
  gatePassed: boolean;
  record: RunRecord;
  dir: string;
};

/** A lone "nothing found" review report, in the one line the review brief asks for. */
const NOTHING_FOUND = /^(no (findings|issues|problems|concerns)|nothing (found|to report|of note|wrong)|looks good|lgtm|all (good|clear))\b/i;

/**
 * The review's findings from its report: each non-blank line is one finding, unless the whole report is a single
 * "nothing found" line. Best-effort over free text — the review brief asks for one finding per line, and the gate only
 * needs each listed finding to carry text (a fenced summary for the PR body). A structured findings format is a later
 * refinement (SMD-4087 follow-up).
 */
export function parseFindings(report: string): string[] {
  const lines = report.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return [];
  if (lines.length === 1 && NOTHING_FOUND.test(lines[0])) return [];
  return lines;
}

/** Whether to resume the worker, and with what budget: only with findings to address and at least `resumeMinUsd` of the worker's budget left after its first run (docs, "Limits"). */
export function resumeDecision(findings: string[], firstRunCostUsd: number | null, limits: RunLimits): { resume: boolean; budgetUsd: number; leftover: number } {
  const spent = typeof firstRunCostUsd === "number" && firstRunCostUsd >= 0 ? firstRunCostUsd : limits.workerBudgetUsd;
  const leftover = Math.max(0, limits.workerBudgetUsd - spent);
  return { resume: findings.length > 0 && leftover >= limits.resumeMinUsd, budgetUsd: leftover, leftover };
}

/** A reported figure as a number, or null: the result summary's fields are untyped (unknown) off the stream. */
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** A clean one-line fragment of git's or an error's output, for a note. */
const trunc = (s: string, n = 200): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Delete the clone and the review checkout (docs step 10); the bundle, the diff, the transcripts, the logs and the record stay. */
function cleanup(dir: string): void {
  rmSync(clonePath(dir), { recursive: true, force: true });
  rmSync(reviewCheckout(dir), { recursive: true, force: true });
}

/** Record a session's cost and turns. A resumed worker reports its cost cumulatively since its first run (docs, "Limits"), so `priorCostUsd` is subtracted to record only this session's own increment. */
function recordSession(dir: string, role: "worker" | "review", out: SessionOutcome, priorCostUsd: number | null): void {
  const raw = typeof out.result?.totalCostUsd === "number" ? out.result.totalCostUsd : null;
  const costUsd = raw === null ? null : priorCostUsd === null ? raw : Math.max(0, raw - priorCostUsd);
  const turns = typeof out.result?.numTurns === "number" ? out.result.numTurns : null;
  updateRecord(dir, (r) => { r.sessions.push({ role, turns, costUsd, ended: out.ended }); });
}

/** Verify the bundle, import its one ref into the bare repository, and keep a copy beside the record (docs step 6/10). Returns the first failure, or ok. */
function verifyImportKeep(dir: string, bundlePath: string, bareRepo: string, branch: string, git: GitRun): { ok: boolean; problem: string | null } {
  const v = verifyBundle({ bundlePath, bareRepo, branch, git });
  if (!v.ok) return v;
  const imp = importBundle({ bundlePath, bareRepo, branch, git });
  if (!imp.ok) return imp;
  try {
    cpSync(bundlePath, bundleFile(dir));
  } catch (e) {
    return { ok: false, problem: `the bundle couldn't be kept: ${trunc((e as Error)?.message ?? String(e))}` };
  }
  return { ok: true, problem: null };
}

/** The textual diff of the imported branch over the base, with the gate's own flags (gate.ts checkDiff): --text, no external diff, no textconv. */
function takeDiff(git: GitRun, bareRepo: string, base: string, branch: string): { ok: boolean; text: string; problem: string | null } {
  const d = git(["-C", bareRepo, "diff", "--text", "--no-ext-diff", "--no-textconv", base, branch]);
  if (d.code !== 0) return { ok: false, text: "", problem: trunc(d.stderr) };
  return { ok: true, text: d.stdout, problem: null };
}

/** Write the diff beside the record, owner-only and never through a link. */
function writeDiff(dir: string, text: string): void {
  writeNoFollow(diffFile(dir), text);
}

/**
 * A clean checkout of the base commit for the review session: a clone of the bare repository, detached at the base. It
 * never commits, so it needs no branch or identity (unlike the worker's clone). It writes nothing but through git.
 */
export function prepareReviewCheckout(git: GitRun, bareRepo: string, base: string, dest: string): { ok: boolean; problem: string | null } {
  const clone = git(["clone", "--no-hardlinks", "--quiet", bareRepo, dest]);
  if (clone.code !== 0) return { ok: false, problem: `git clone failed: ${trunc(clone.stderr)}` };
  const sw = git(["-C", dest, "switch", "--quiet", "--detach", base]);
  if (sw.code !== 0) return { ok: false, problem: `switch --detach to the base failed: ${trunc(sw.stderr)}` };
  return { ok: true, problem: null };
}

/**
 * One whole local run (cut 2b): prepare, work, review (verify/import, diff, review session, the one resume) and gate, on
 * the record. A session, git or bundle failure is recorded as an outcome and the clone and review checkout cleaned up,
 * never thrown; only a catastrophic I/O error (the record itself unwritable) propagates, leaving a run that step 0's
 * reconcile recovers (cut 3). Returns how it ended.
 */
export async function run(input: RunInput): Promise<RunResult> {
  const { state, ticket, base, bareRepo, bot, sizeCapBytes, limits, deps } = input;
  const { git } = deps;
  const branch = branchFor(ticket.identifier, ticket.title);
  const runName = runId(deps.now());
  startRecord(state, { run: runName, ticket: ticket.identifier, base, branch });
  const dir = runDir(state, runName);

  /** Set the terminal state, clean up the clone and review checkout, and return. endedAt is set only with an outcome: a gate pass leaves the run open for publishing (cut 3). */
  const finish = (step: Step, outcome: Outcome | null, note: string, gatePassed: boolean): RunResult => {
    const record = updateRecord(dir, (r) => {
      r.step = step;
      r.outcome = outcome;
      if (outcome !== null) r.endedAt = deps.now().toISOString();
      if (note) r.notes.push(note);
    });
    cleanup(dir);
    return { outcome, gatePassed, record, dir };
  };

  // The ticket must be briefable: a malformed id or a character that doesn't show is a work failure before any session (brief.ts).
  const tp = ticketProblem(ticket);
  if (tp) return finish("prepare", "work-failure", `the ticket can't be briefed: ${tp}`, false);

  // Step 4 — prepare: clone the bare repository at the base on the run's branch, as the bot.
  updateRecord(dir, (r) => { r.step = "prepare"; });
  const clone = clonePath(dir);
  const cr = prepareClone({ bareRepo, base, branch, dest: clone, bot, git });
  if (!cr.ok) return finish("prepare", "env-failure", `prepare failed: ${cr.problem}`, false);

  // Step 5 — work: the worker session in the clone, with the brief. Its bundle goes to the worker's temp directory.
  updateRecord(dir, (r) => { r.step = "work"; });
  const bundlePath = join(deps.workerTmp, "branch.bundle");
  const claimForBrief = input.claimId ?? "(none yet — a local run; the claim is cut 2c)";
  const workerBrief = buildBrief({ ticket, clonePath: clone, branch, base, claimId: claimForBrief, bundlePath });
  const w = await deps.runWorker({ root: clone, prompt: workerBrief, maxBudgetUsd: limits.workerBudgetUsd, timeLimitMs: limits.workerMs });
  recordSession(dir, "worker", w, null);
  if (w.ended !== "result") return finish("work", "work-failure", `the worker session ended ${w.ended}: ${trunc(w.why)}`, false);

  // Step 6 — review: verify and import the worker's bundle, take the diff, run the review, then resume once if there is budget.
  updateRecord(dir, (r) => { r.step = "review"; });
  // Keep git from launching background maintenance on the bare repo: an auto-gc or `git maintenance run --auto` after the
  // import's fetch would repack objects while the review checkout's --no-hardlinks clone copies them, failing it
  // intermittently (the bare repo is persistent and crosses the thresholds as runs accumulate). Clear any ref this
  // ticket's branch left from an earlier run too (the branch name is deterministic), so this run's bundle imports cleanly
  // rather than as a non-fast-forward of the stale branch; the earlier run's bundle is kept, so nothing is lost, and the
  // resume's import is a fast-forward.
  git(["-C", bareRepo, "config", "gc.auto", "0"]);
  git(["-C", bareRepo, "config", "maintenance.auto", "false"]);
  git(["-C", bareRepo, "update-ref", "-d", refOf(branch)]);
  const imported = verifyImportKeep(dir, bundlePath, bareRepo, branch, git);
  // A missing or bad bundle ends the run (a way-out worker writes none). The note carries only the runner's own words:
  // the worker's report is model text, which the record keeps in the session's stream, never in a note (record.ts).
  if (!imported.ok) return finish("review", "work-failure", `the worker's bundle: ${imported.problem}`, false);
  const diff1 = takeDiff(git, bareRepo, base, branch);
  if (!diff1.ok) return finish("review", "work-failure", `the diff couldn't be taken: ${diff1.problem}`, false);
  writeDiff(dir, diff1.text);

  const review = reviewCheckout(dir);
  const rc = prepareReviewCheckout(git, bareRepo, base, review);
  if (!rc.ok) return finish("review", "work-failure", `the review checkout failed: ${rc.problem}`, false);
  const reviewBrief = buildReviewBrief({ ticket, diff: diff1.text, reviewCheckout: review });
  const rev = await deps.runReview({ root: review, prompt: reviewBrief, maxBudgetUsd: limits.reviewBudgetUsd, timeLimitMs: limits.reviewMs });
  recordSession(dir, "review", rev, null);
  const findings = rev.ended === "result" ? parseFindings(rev.report) : [];
  if (rev.ended !== "result") updateRecord(dir, (r) => { r.notes.push(`the review session ended ${rev.ended}: ${trunc(rev.why)}; no findings taken`); });

  // The one resume (docs step 6): with findings and at least resumeMinUsd of the worker's budget left, resume to address
  // them, and the findings count as fixed. Otherwise they are listed open — in the gate now, and the PR body in cut 3.
  let workerReport = w.report;
  let findingsFixed = false;
  const decision = resumeDecision(findings, num(w.result?.totalCostUsd), limits);
  if (decision.resume && w.init && typeof w.init.sessionId === "string") {
    updateRecord(dir, (r) => { r.notes.push(`review: ${findings.length} finding(s); resuming the worker to address them ($${decision.budgetUsd.toFixed(2)} left)`); });
    const resumeBrief = buildResumeBrief({ findings, branch, bundlePath });
    // Clear the first run's bundle so the resume must write a fresh one: a resume that writes none (e.g. it takes the way
    // out) then fails verify and falls back, instead of the stale bundle passing and the findings counting as fixed.
    rmSync(bundlePath, { force: true });
    const r2 = await deps.runWorker({ root: clone, prompt: resumeBrief, maxBudgetUsd: decision.budgetUsd, timeLimitMs: limits.resumeMs, resume: w.init.sessionId });
    recordSession(dir, "worker", r2, num(w.result?.totalCostUsd));
    if (r2.ended === "result") {
      const re = verifyImportKeep(dir, bundlePath, bareRepo, branch, git);
      if (re.ok) {
        const diff2 = takeDiff(git, bareRepo, base, branch);
        if (diff2.ok) writeDiff(dir, diff2.text);
        workerReport = r2.report || w.report;
        findingsFixed = true;
      } else {
        updateRecord(dir, (r) => { r.notes.push(`the resume's bundle was unusable (${trunc(re.problem ?? "")}); keeping the pre-resume branch, findings listed open`); });
      }
    } else {
      updateRecord(dir, (r) => { r.notes.push(`the resumed worker ended ${r2.ended}: ${trunc(r2.why)}; keeping the pre-resume branch, findings listed open`); });
    }
  } else if (findings.length > 0) {
    updateRecord(dir, (r) => { r.notes.push(`review: ${findings.length} finding(s) listed open (no budget to resume: $${decision.leftover.toFixed(2)} left)`); });
  } else {
    updateRecord(dir, (r) => { r.notes.push("review: no findings"); });
  }
  const reviewFindings = findings.map((summary) => ({ summary, fixed: findingsFixed }));

  // Step 7 — gate: on the imported branch, with the runner's own tools; nothing in it comes from the branch.
  updateRecord(dir, (r) => { r.step = "gate"; });
  const result = gate({
    bareRepo,
    base,
    branch,
    bot,
    ticket: { identifier: ticket.identifier, verify: ticket.verify },
    workerReport,
    reviewFindings,
    sizeCapBytes,
    deps: { git, commitlint: deps.commitlint, scanSecrets: deps.scanSecrets },
  });
  const summary: GateSummary = { pass: result.pass, failed: result.checks.filter((c) => !c.pass).map((c) => c.name), ciCheckFiles: result.ciCheckFiles };
  updateRecord(dir, (r) => { r.gate = summary; });
  if (!result.pass) return finish("gate", "work-failure", `the gate failed: ${summary.failed.join(", ")}`, false);

  // The gate passed. Cut 2b stops here: the branch is in the bare repository; publishing (→ "published") is cut 3.
  return finish("gate", null, `the gate passed (${result.checks.length} checks); the branch is in the bare repository. Publishing is cut 3.`, true);
}
