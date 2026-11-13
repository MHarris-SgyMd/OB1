/**
 * live-check.ts — the offline self-check of cut 2c-3's live run (live.ts), with no key and no network. CI runs it
 * (`bun scripts/agent-runner/live-check.ts --self-check`). It drives the whole wiring: a stubbed fetch for claims.ts
 * (the brain check, the claim, the release), a stubbed GraphQL client for board.ts (the In Progress / Backlog moves and
 * the comment), a stub run() that returns each outcome, and a temp runner directory for the token files. It checks the
 * order (claim before the run, hand-back after), the token's life (written at the claim, deleted once the release
 * lands, kept when it can't), the outcome-to-hand-back mapping (a pass or a work failure relabels for a person, an
 * environment failure keeps the label), and that a failed Linear move or release is recorded owed, not fatal. The live
 * run that drives it with the real keys and a model is the step this cut leaves for stable's `/api` route.
 *
 *   bun scripts/agent-runner/live-check.ts --self-check
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsDir } from "./claims.ts";
import type { Config, Fetch } from "./facts.ts";
import type { Gql, GqlResult } from "../../db/linear-api.ts";
import { handbackComment, liveRun, type LiveDeps, type LiveInput } from "./live.ts";
import type { Outcome, RunRecord } from "./record.ts";
import type { RunInput, RunResult } from "./run.ts";

const CFG = { team: "SMD", restUrl: "http://127.0.0.1:8010/api" } as unknown as Config;
const READY = "label-ready";
const HANDED = "label-handed-back";

/** The fetch replies claims.ts reads, by the scenario. */
type FetchScenario = {
  brain?: "stable" | "canary" | "down";
  claim?: "claimed" | "closed" | "held" | "error";
  release?: "released" | "unattributed" | "error";
};

/** A stubbed fetch for claims.ts that records every request, so a test asserts the order and that a step didn't run. */
function stubFetch(s: FetchScenario, seq: string[] = []): { fetch: Fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = (init?.method as string | undefined) ?? "GET";
    calls.push({ url, method });
    seq.push(url.endsWith("/v1/brain") ? "brain" : url.includes("/release") ? "release" : url.endsWith("/v1/claims") ? "claim" : "fetch?");
    const resp = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/v1/brain")) {
      if (s.brain === "down") throw new Error("ECONNREFUSED");
      return resp(200, { tier: s.brain === "canary" ? "canary" : "stable" });
    }
    if (url.includes("/release") && method === "POST") {
      if (s.release === "error") throw new Error("ETIMEDOUT");
      if (s.release === "unattributed") return resp(503, { code: "CLAIM_UNATTRIBUTED", retryable: true, message: "retry shortly" });
      return resp(200, { outcome: "released", claim: null, message: "released" });
    }
    if (url.endsWith("/v1/claims") && method === "POST") {
      if (s.claim === "held") return resp(409, { code: "WORK_CLAIMED", heldBy: [{ id: "c0", holder: "someone-else", holderKind: "agent", ownKey: false, expiresAt: "t" }], message: "held" });
      if (s.claim === "error") return resp(500, { message: "boom" });
      const claim = { id: "claim-1", issue: "SMD-9", piece: null, holder: "agent-runner", holderKind: "agent", label: "l", claimedAt: "t", renewedAt: null, expiresAt: "t2", releasedAt: null, releasedBy: null, releasedByKind: null, releaseReason: null, state: "live" };
      return resp(200, { claim, token: `wc_${"a".repeat(64)}`, ...(s.claim === "closed" ? { ticketClosed: { status: "Done", statusType: "completed" } } : {}) });
    }
    return resp(404, { message: `unrouted: ${url}` });
  };
  return { fetch, calls };
}

/** The GraphQL replies board.ts reads, by the scenario. `updateFail` names the stateId whose issueUpdate returns success=false. */
type GqlScenario = { updateFail?: "st-ip" | "st-bl" | "all"; commentSuccess?: boolean };

/** A stubbed, recording GraphQL client for board.ts. */
function stubGql(s: GqlScenario, seq: string[] = []): { gql: Gql; calls: { query: string; variables: Record<string, unknown> }[] } {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const gql: Gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> => {
    calls.push({ query, variables });
    if (query.includes("issueUpdate")) seq.push(`update:${(variables.input as { stateId?: string })?.stateId ?? "?"}`);
    else if (query.includes("commentCreate")) seq.push("comment");
    const data = (v: unknown): GqlResult<T> => ({ data: v as T, errors: [] });
    if (query.includes("workflowStates")) {
      const name = variables.name as string;
      const nodes = [{ id: "st-ip", name: "In Progress", type: "started" }, { id: "st-bl", name: "Backlog", type: "backlog" }].filter((n) => n.name === name);
      return data({ workflowStates: { nodes } });
    }
    if (query.includes("issue(id")) return data({ issue: { id: "uuid-1", labelIds: [READY, "other"] } });
    if (query.includes("issueUpdate")) {
      const stateId = (variables.input as { stateId?: string })?.stateId;
      const ok = !(s.updateFail === "all" || s.updateFail === stateId);
      return data({ issueUpdate: { success: ok } });
    }
    if (query.includes("commentCreate")) return data({ commentCreate: { success: s.commentSuccess ?? true } });
    return { data: null, errors: [{ message: `unrouted: ${query.slice(0, 40)}` }] };
  };
  return { gql, calls };
}

/** A RunResult the stub run() returns for a given outcome, with the record fields the hand-back comment reads. */
function fakeResult(outcome: Outcome | null): RunResult {
  const record: RunRecord = {
    run: "2026-01-02T03-04-05-000Z", ticket: "SMD-9", base: "base0", branch: "agent/smd-9-x", claimId: "claim-1", pr: null, pgid: null,
    step: outcome === null ? "gate" : outcome === "env-failure" ? "prepare" : "work", outcome,
    owed: [], startedAt: "t0", endedAt: outcome === null ? null : "t1",
    sessions: [{ role: "worker", turns: 3, costUsd: 1.5, ended: "result" }, { role: "review", turns: 1, costUsd: 0.2, ended: "result" }],
    gate: outcome === null ? { pass: true, failed: [], ciCheckFiles: [] } : outcome === "work-failure" ? { pass: false, failed: ["branch"], ciCheckFiles: [] } : null,
    notes: [],
  };
  return { outcome, gatePassed: outcome === null, record, dir: "/tmp/run" };
}

/** Build a LiveInput over the stubs, recording the claimId run() is called with (null if it isn't). */
function makeInput(dir: string, fetchS: FetchScenario, gqlS: GqlScenario, outcome: Outcome | null, seen: { claimId: string | null | undefined }): { input: LiveInput; fetchCalls: { url: string; method: string }[]; gqlCalls: { query: string; variables: Record<string, unknown> }[]; seq: string[] } {
  const seq: string[] = [];
  const f = stubFetch(fetchS, seq);
  const g = stubGql(gqlS, seq);
  const run = async (ri: RunInput): Promise<RunResult> => {
    seen.claimId = ri.claimId;
    seq.push("run");
    return fakeResult(outcome);
  };
  const deps: LiveDeps = { fetch: f.fetch, gql: g.gql, brainKey: `bk${"0".repeat(60)}`, runnerDir: dir, readyLabelId: READY, handedBackLabelId: HANDED, run };
  const runInput = { ticket: { identifier: "SMD-9", title: "t", description: "", verify: [] } } as unknown as Omit<RunInput, "claimId">;
  return { input: { leaseSeconds: 86400, claimLabel: "runner", runInput, cfg: CFG, deps }, fetchCalls: f.calls, gqlCalls: g.calls, seq };
}

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = (cond: unknown, what: string): void => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const section = async (name: string, body: () => Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: it threw (${String((e as Error)?.stack ?? (e as Error)?.message ?? e).slice(0, 200)})`);
    }
  };
  const tokenPath = (dir: string): string => join(claimsDir(dir), "claim-1.json");
  /** The issueUpdate mutation inputs, in call order (the In Progress move, then the Backlog hand-back). */
  const updates = (calls: { query: string; variables: Record<string, unknown> }[]): Record<string, unknown>[] =>
    calls.filter((c) => c.query.includes("issueUpdate")).map((c) => c.variables.input as Record<string, unknown>);

  const root = mkdtempSync(join(tmpdir(), "obr-live-"));
  try {
    await section("a passing run: claim, In Progress, run, hand-back (relabel), comment, release, token deleted", async () => {
      const dir = join(root, "pass");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "released" }, {}, null, seen);
      const r = await liveRun(m.input);
      ok(r.stage === "ran" && r.outcome === null, `it ran to a pass${r.stage === "ran" ? "" : `: ${r.stage} ${r.detail}`}`);
      ok(seen.claimId === "claim-1", "run() was called with the real claim id");
      ok(r.handedBack && r.commented && r.released === "released", "handed back, commented, and the claim released");
      ok(r.owed.length === 0, `nothing left owed${r.owed.length ? `: ${r.owed.join("; ")}` : ""}`);
      ok(!existsSync(tokenPath(dir)), "the token file is deleted once the release lands");
      const ups = updates(m.gqlCalls);
      ok(ups[0]?.stateId === "st-ip", "the first move sets In Progress");
      const relabel = (ups[1]?.labelIds as string[]) ?? [];
      ok(ups[1]?.stateId === "st-bl" && !relabel.includes(READY) && relabel.includes(HANDED), "the hand-back moves to Backlog and relabels for a person");
      ok(m.gqlCalls.some((c) => c.query.includes("commentCreate")), "a comment was posted");
      const urls = m.fetchCalls.map((c) => `${c.method} ${c.url.replace(CFG.restUrl ?? "", "")}`);
      ok(urls[0] === "GET /v1/brain" && urls[1] === "POST /v1/claims" && urls.some((u) => u.includes("/release")), "the order was brain, claim, …, release");
      const at = (t: string): number => m.seq.indexOf(t);
      ok(at("update:st-ip") >= 0 && at("update:st-ip") < at("run") && at("run") < at("release") && at("release") < at("update:st-bl") && at("update:st-bl") < at("comment"), "the sequence is In Progress, run, release first, then the Backlog hand-back and comment");
    });

    await section("a work failure relabels for a person and releases", async () => {
      const dir = join(root, "work");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "released" }, {}, "work-failure", seen);
      const r = await liveRun(m.input);
      ok(r.stage === "ran" && r.outcome === "work-failure", "it ran to a work failure");
      const ups = updates(m.gqlCalls);
      const relabel = (ups[1]?.labelIds as string[]) ?? [];
      ok(ups[1]?.stateId === "st-bl" && relabel.includes(HANDED) && !relabel.includes(READY), "the hand-back relabels agent-handed-back on, agent-ready off");
      ok(r.released === "released" && !existsSync(tokenPath(dir)), "released, token gone");
    });

    await section("an environment failure keeps the label (state only), and releases", async () => {
      const dir = join(root, "env");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "released" }, {}, "env-failure", seen);
      const r = await liveRun(m.input);
      ok(r.stage === "ran" && r.outcome === "env-failure", "it ran to an environment failure");
      const ups = updates(m.gqlCalls);
      ok(ups[1]?.stateId === "st-bl" && !("labelIds" in (ups[1] ?? {})), "the hand-back moves to Backlog and does NOT touch the labels");
      ok(r.released === "released", "the claim is released");
    });

    await section("stable not ready: no claim, no move, no token", async () => {
      const dir = join(root, "braindown");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "down" }, {}, null, seen);
      const r = await liveRun(m.input);
      ok(r.stage === "brain" && r.outcome === "env-failure" && !r.ran, "it stopped at the brain check as an env failure");
      ok(seen.claimId === undefined, "run() was not called");
      ok(!m.fetchCalls.some((c) => c.url.endsWith("/v1/claims")), "no claim was attempted");
      ok(!existsSync(tokenPath(dir)) && m.gqlCalls.length === 0, "no token written, no Linear move");
    });

    await section("the work is held by another claim: stop, nothing moved", async () => {
      const dir = join(root, "held");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "held" }, {}, null, seen);
      const r = await liveRun(m.input);
      ok(r.stage === "claim" && !r.ran && r.claimId === null, "it stopped at the claim");
      ok(seen.claimId === undefined && m.gqlCalls.length === 0 && !existsSync(tokenPath(dir)), "run() not called, no move, no token");
    });

    await section("a closed ticket: claimed then released at once, never run", async () => {
      const dir = join(root, "closed");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "closed", release: "released" }, {}, null, seen);
      const r = await liveRun(m.input);
      ok(r.stage === "closed" && !r.ran, "it stopped as closed without running");
      ok(seen.claimId === undefined, "run() was not called");
      ok(m.fetchCalls.some((c) => c.url.includes("/release")) && r.released === "released" && !existsSync(tokenPath(dir)), "the minted token was released and deleted");
      ok(m.gqlCalls.length === 0, "the ticket was not moved to In Progress");
    });

    await section("a failed In Progress move is owed, not fatal — the run still proceeds", async () => {
      const dir = join(root, "ipfail");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "released" }, { updateFail: "st-ip" }, null, seen);
      const r = await liveRun(m.input);
      ok(seen.claimId === "claim-1" && r.ran, "run() still ran after the In Progress move failed");
      ok(r.notes.some((o) => o.includes("In Progress")) && !r.owed.some((o) => o.includes("In Progress")), "the failed In Progress move is noted, not owed (step 0 must not re-move it)");
      ok(r.released === "released", "the run still handed back and released");
    });

    await section("a failed comment is owed; the release still happens", async () => {
      const dir = join(root, "commentfail");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "released" }, { commentSuccess: false }, null, seen);
      const r = await liveRun(m.input);
      ok(!r.commented && r.owed.some((o) => o.includes("comment")), "the failed comment is recorded owed");
      ok(r.released === "released" && !existsSync(tokenPath(dir)), "the claim was still released and the token deleted");
    });

    await section("a failed Backlog hand-back move is owed; the release (first) still lands", async () => {
      const dir = join(root, "backfail");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "released" }, { updateFail: "st-bl" }, null, seen);
      const r = await liveRun(m.input);
      ok(!r.handedBack && r.owed.some((o) => o.includes("hand")), "the failed Backlog hand-back is recorded owed");
      ok(r.released === "released" && !existsSync(tokenPath(dir)), "the claim was still released first and the token deleted");
    });

    await section("a release that can't land keeps the token and is owed", async () => {
      const dir = join(root, "relowed");
      const seen = { claimId: undefined as string | null | undefined };
      const m = makeInput(dir, { brain: "stable", claim: "claimed", release: "unattributed" }, {}, null, seen);
      const r = await liveRun(m.input);
      ok(r.released === "owed" && r.owed.some((o) => o.includes("release")), "the release is recorded owed");
      ok(existsSync(tokenPath(dir)), "the token file is KEPT until the release lands");
    });

    await section("a catastrophic run() error is caught: the claim is released, not orphaned", async () => {
      const dir = join(root, "throw");
      const f = stubFetch({ brain: "stable", claim: "claimed", release: "released" });
      const g = stubGql({});
      const run = async (): Promise<RunResult> => {
        throw new Error("record unwritable");
      };
      const deps: LiveDeps = { fetch: f.fetch, gql: g.gql, brainKey: `bk${"0".repeat(60)}`, runnerDir: dir, readyLabelId: READY, handedBackLabelId: HANDED, run };
      const runInput = { ticket: { identifier: "SMD-9", title: "t", description: "", verify: [] } } as unknown as Omit<RunInput, "claimId">;
      const r = await liveRun({ leaseSeconds: 86400, claimLabel: "runner", runInput, cfg: CFG, deps });
      ok(r.ran && r.outcome === "work-failure", "a run() throw is handled as a work failure");
      ok(r.handedBack && r.released === "released", "the ticket is handed back and the claim released");
      ok(!existsSync(tokenPath(dir)), "the token is deleted — the claim is not orphaned");
    });

    await section("the hand-back comment is computed and carries no token", () => {
      const body = handbackComment(fakeResult(null));
      ok(body.includes("passed the gate") && body.includes("agent/smd-9-x") && body.includes("not pushed"), "the pass comment names the outcome, branch and no-push");
      const worky = handbackComment(fakeResult("work-failure"));
      ok(worky.includes("work failure") && worky.includes("branch"), "the work-failure comment names the failed gate check");
      return Promise.resolve();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  if (!process.argv.slice(2).includes("--self-check")) {
    console.error("usage: bun scripts/agent-runner/live-check.ts --self-check");
    process.exit(2);
  }
  process.exit(await selfCheck());
}
