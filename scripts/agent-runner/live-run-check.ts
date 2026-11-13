/**
 * live-run-check.ts — the offline self-check of the executor's new logic (SMD-4087 cut 2c-3): the Verify and named-id
 * parsers, the brief-ticket builder on a stubbed Linear client, and the bare-repo provisioning on a stubbed git. No
 * network, no session, no spend, so CI runs it (`bun scripts/agent-runner/live-run.ts --self-check`). The execute layer's
 * own coverage is added with it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BARE_REPO, STATE_DIR, ensureBareRepo, parseCommitlint, parseNamed, parseVerify, sessionPaths, ticketFor, type ExecCtx } from "./live-run.ts";
import { pathsProblem } from "./profile.ts";
import type { Gql, GqlResult } from "../../db/linear-api.ts";
import type { GitRun } from "./gate.ts";
import type { Ticket } from "./select.ts";

/** A stub board row: ticketFor reads only its identifier. */
const row = (identifier: string): Ticket => ({ identifier }) as unknown as Ticket;

/** A stub Linear client that answers the one ISSUE query with a fixed issue, or an error. */
function stubGql(issue: { identifier: string; title: string; description: string | null } | null, errors: GqlResult<unknown>["errors"] = []): Gql {
  return (async () => ({ data: { issue }, errors })) as unknown as Gql;
}

/** A stub git: each call's reply by the subcommand it runs, so ensureBareRepo runs with no real git. */
function stubGit(opts: { cloneCode?: number; fetchCode?: number; rev?: string } = {}): { git: GitRun; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRun = (args) => {
    calls.push(args);
    if (args.includes("clone")) return { code: opts.cloneCode ?? 0, stdout: "", stderr: opts.cloneCode ? "clone boom" : "" };
    if (args.includes("fetch")) return { code: opts.fetchCode ?? 0, stdout: "", stderr: opts.fetchCode ? "fetch boom" : "" };
    if (args.includes("rev-parse")) return { code: 0, stdout: `${opts.rev ?? "a".repeat(40)}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
}

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = async (check: () => unknown, what: string): Promise<void> => {
    let pass = false;
    let note = "";
    try {
      pass = Boolean(await check());
    } catch (e) {
      note = ` (it threw: ${String((e as Error)?.message ?? e).slice(0, 160)})`;
    }
    if (pass) passed++;
    else failed++;
    console.log(`  ${pass ? "✓" : "✗"} ${what}${note}`);
  };

  console.log("the Verify parser");
  await ok(() => JSON.stringify(parseVerify("## Problem\nx\n\n## Verify\n* a\n* b\n\n## Notes\nignore")) === JSON.stringify(["a", "b"]), "bullets under a ## Verify heading, stopping at the next heading");
  await ok(() => JSON.stringify(parseVerify("## Verify\n1. one\n2) two\n- three")) === JSON.stringify(["one", "two", "three"]), "numbered (1. and 2)) and dash items all count");
  await ok(() => parseVerify("## Problem\nno verify here\n## Work\ndo it").length === 0, "no Verify section → no items");
  await ok(() => JSON.stringify(parseVerify("Verify:\n- only one\nnot a bullet")) === JSON.stringify(["only one"]), "a plain 'Verify:' line heads a section; a non-bullet line is skipped");
  await ok(() => parseVerify("## Verify\n\n## Next").length === 0, "an empty Verify section → no items");

  console.log("the named-id parser");
  await ok(() => JSON.stringify(parseNamed("relates to SMD-100 and SMD-200, and SMD-100 again", "SMD-9")) === JSON.stringify(["SMD-100", "SMD-200"]), "same-team ids are deduped and kept in order");
  await ok(() => parseNamed("this is SMD-9 itself, plus ENG-42", "SMD-9").length === 0, "the ticket's own id is excluded, and another team's id (ENG-42) is not captured (the runner works one team)");
  await ok(() => parseNamed("no ids, just smd-100 lowercase and 100-200", "SMD-9").length === 0, "lowercase and number-first strings are not team keys");
  await ok(() => parseNamed("uses UTF-8 and SHA-256 but names SMD-50", "SMD-9").join() === "SMD-50", "tokens shaped like a team key (UTF-8, SHA-256) are not taken for ticket ids; a same-team id is");

  console.log("the brief-ticket builder");
  await ok(async () => {
    const r = await ticketFor(stubGql({ identifier: "SMD-9", title: "Fix it", description: "## Problem\nbroken\n## Verify\n- it works\nrelates to SMD-5" }), row("SMD-9"));
    return r.ok && r.ticket.title === "Fix it" && JSON.stringify(r.ticket.verify) === JSON.stringify(["it works"]) && JSON.stringify(r.ticket.named) === JSON.stringify(["SMD-5"]);
  }, "fetches the description, and parses Verify and the named ids into the BriefTicket");
  await ok(async () => {
    const r = await ticketFor(stubGql(null, [{ message: "not authorized" }]), row("SMD-9"));
    return !r.ok && r.problem.includes("not authorized");
  }, "a Linear error is a problem, not a ticket");
  await ok(async () => {
    const r = await ticketFor(stubGql(null), row("SMD-9"));
    return !r.ok && r.problem.includes("no issue");
  }, "a missing issue is a problem");
  await ok(async () => {
    const r = await ticketFor(stubGql({ identifier: "SMD-9", title: "Fix​it", description: "ok" }), row("SMD-9"));
    return !r.ok && r.problem.includes("can't be briefed");
  }, "a title with a character that doesn't show is refused (ticketProblem)");
  await ok(async () => {
    const r = await ticketFor(stubGql({ identifier: "SMD-9", title: "T", description: null }), row("SMD-9"));
    return r.ok && r.ticket.description === "" && r.ticket.verify.length === 0;
  }, "a null description reads as empty, with no Verify");

  console.log("the bare-repo provisioning");
  const tmp = mkdtempSync(join(tmpdir(), "obr-live-run-"));
  try {
    await ok(() => {
      const { git, calls } = stubGit({ rev: "b".repeat(40) });
      const r = ensureBareRepo(git, join(tmp, "a.git"), "/some/checkout");
      return r.ok && r.base === "b".repeat(40) && calls.some((c) => c.includes("clone")) && calls.some((c) => c.includes("fetch"));
    }, "a missing bare repo is cloned, then fetched, and the base is its main");
    await ok(() => {
      const { git } = stubGit({ cloneCode: 1 });
      const r = ensureBareRepo(git, join(tmp, "b.git"), "/some/checkout");
      return !r.ok && r.problem.includes("bare clone");
    }, "a failed clone is a problem");
    await ok(() => {
      const { git } = stubGit({ fetchCode: 1 });
      const r = ensureBareRepo(git, join(tmp, "c.git"), "/some/checkout");
      return !r.ok && r.problem.includes("fetch main");
    }, "a failed fetch is a problem");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log("the runner's fixed paths");
  await ok(() => STATE_DIR.endsWith("/open-brain/agent-runner") && BARE_REPO.endsWith("/open-brain/agent-runner/repo.git"), "the state dir and bare repo are under ~/.local/share/open-brain/agent-runner");

  console.log("the commitlint parser");
  await ok(() => { const r = parseCommitlint(0, ""); return r.ok && r.problems.length === 0; }, "exit 0 is a pass with no problems");
  await ok(() => { const r = parseCommitlint(1, "⧗   input: bad\n✖   type may not be empty [type-empty]\n\n✖   found 1 problems, 0 warnings\n"); return !r.ok && r.problems.length === 1 && r.problems[0] === "type may not be empty [type-empty]"; }, "exit 1 returns the ✖ problem lines, not the 'found N problems' summary");
  await ok(() => { const r = parseCommitlint(2, "no markers here"); return !r.ok && r.problems.length === 1 && r.problems[0].includes("exited 2"); }, "a non-zero exit with no ✖ lines still fails, naming the exit code");

  console.log("the session paths (the layout that passes pathsProblem)");
  const ctx: ExecCtx = {
    install: "/Users/x/install", bun: "/Users/x/bun", devGit: "/usr/bin/git", runnerGit: (() => ({ code: 0, stdout: "", stderr: "" })) as GitRun,
    pinned: { path: "/Users/x/claude", sha256: "a".repeat(64), version: "2.1.319" }, gitConfig: "/Users/x/bot.gitconfig", keyFile: "/Users/x/anthropic.key", home: "/Users/x",
    user: "x", uid: 501, bareRepo: "/Users/x/repo.git", base: "a".repeat(40), workerTmp: "/private/tmp/obr-aabbccdd", reviewTmp: "/private/tmp/obr-eeff0011",
  };
  await ok(() => pathsProblem(sessionPaths(ctx, "/Users/x/runs/R/clone", "worker"), 501) === null, "the worker's paths (record and config in subdirs, siblings of the clone) pass pathsProblem");
  await ok(() => pathsProblem(sessionPaths(ctx, "/Users/x/runs/R/review", "review"), 501) === null, "the review's paths pass pathsProblem");
  await ok(() => { const p = sessionPaths(ctx, "/Users/x/runs/R/clone", "worker"); return p.record === "/Users/x/runs/R/record" && p.configDir === "/Users/x/runs/R/config" && p.tmp === "/private/tmp/obr-aabbccdd"; }, "record and config are subdirs of the run dir; the worker's tmp is the workerTmp");
  await ok(() => pathsProblem({ ...sessionPaths(ctx, "/Users/x/runs/R/clone", "worker"), record: "/Users/x/runs/R" }, 501) !== null, "the naive layout (record = the run dir, which holds the clone) is REJECTED by pathsProblem — why the subdirs are needed");

  console.log(`${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}
