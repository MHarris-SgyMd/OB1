/**
 * publish-check.ts — the offline self-check of cut 3a's publish step (publish.ts), with no token and no network. CI runs
 * it (`bun scripts/agent-runner/publish-check.ts --self-check`). It drives both pieces:
 *
 *   - `buildPrBody` / `fenceFor`: the facts section carries the run's computed fields; model text (the worker report,
 *     the open findings) sits in a code block whose fence is longer than any run of backticks inside it, so a report
 *     that itself holds a fence can't break out; a section the scanner flags is withheld, not shown; a claim token in
 *     the text is masked; and a body that would pass GitHub's cap drops the model sections whole, never mid-fence.
 *   - `renewVerdict` / `publish`: the step-8 renewal maps every reply to publish / owed / hand-to-a-person; the sequence
 *     confirms the claim (day lease), pushes, opens the draft PR with the right head/base/body, records its number, sets
 *     the week lease, and comments — and each failure (a throwing precheck or GitHub client, a renew that can't land, a
 *     push or PR failure, a failing week renewal, a failed comment) comes back as the right result, never thrown.
 *
 *   bun scripts/agent-runner/publish-check.ts --self-check
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsDir, readToken, type ClaimReply } from "./claims.ts";
import type { Fetch } from "./facts.ts";
import type { Gql, GqlResult } from "../../db/linear-api.ts";
import { buildPrBody, fenceFor, prLinkComment, publish, renewVerdict, BODY_CAP, type GitHubClient, type PrBodyInput, type PublishDeps, type PublishInput } from "./publish.ts";
import { runDir, startRecord, readRecord, type GateSummary, type SessionCost } from "./record.ts";

const DAY = 86_400;
const WEEK = 604_800;
/** A counter for unique run directory names across the publish scenarios (no clock collisions). */
let runSeq = 0;
const CLEAN_GATE: GateSummary = { pass: true, failed: [], ciCheckFiles: [] };
const SESSIONS: SessionCost[] = [
  { role: "worker", turns: 42, costUsd: 1.84, ended: "result" },
  { role: "review", turns: 9, costUsd: 0.43, ended: "result" },
];

/** A PrBodyInput with the given model text, the rest fixed. */
function body(over: Partial<PrBodyInput>): PrBodyInput {
  return {
    ticket: "SMD-1234",
    branch: "agent/smd-1234-fix-the-thing",
    base: "abc1234",
    diffStat: " foo.ts | 2 +-\n bar.ts | 1 +\n 2 files changed",
    gate: CLEAN_GATE,
    sessions: SESSIONS,
    workerReport: "Did the work. Verify: the grep finds only marked lines.",
    openFindings: [],
    ...over,
  };
}

/** A scanner that flags any text containing the marker, else clean. */
const scanFor = (marker: string): ((t: string) => string[]) => (t) => (t.includes(marker) ? [`matched ${marker}`] : []);
const clean = (): string[] => [];

/** A claim row the stub renews return. */
const CLAIM_ROW = { id: "claim-1", issue: "SMD-1234", piece: null, holder: "agent-runner", holderKind: "agent", label: "l", claimedAt: "t", renewedAt: "t2", expiresAt: "t3", releasedAt: null, releasedBy: null, releasedByKind: null, releaseReason: null, state: "live" };

/**
 * A stubbed fetch for claims.ts's renew, by scenario. The scenario applies to the step-8 (first) renewal — the gating
 * one; the step-9 (week) renewal, reached only after a clean step 8, is always clean.
 */
type RenewScenario = "clean" | "closed" | "taken-over" | "unattributed-retry" | "unattributed-final" | "error" | "week-error";
function stubFetch(s: RenewScenario, seq: string[] = []): { fetch: Fetch; calls: string[]; leases: number[] } {
  const calls: string[] = [];
  const leases: number[] = [];
  let renewN = 0;
  const resp = (status: number, b: unknown): Response => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch: Fetch = async (url, init) => {
    calls.push(url);
    try {
      const parsed = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}"));
      if (typeof parsed.lease_seconds === "number") leases.push(parsed.lease_seconds);
    } catch {
      // not a JSON body
    }
    seq.push("renew");
    renewN += 1;
    if (renewN >= 2) {
      if (s === "week-error") throw new Error("ETIMEDOUT on the week renewal");
      return resp(200, { claim: CLAIM_ROW }); // step 9's week renewal
    }
    if (s === "error") throw new Error("ETIMEDOUT");
    if (s === "unattributed-retry") return resp(503, { code: "CLAIM_UNATTRIBUTED", retryable: true, message: "retry shortly" });
    if (s === "unattributed-final") return resp(503, { code: "CLAIM_UNATTRIBUTED", retryable: false, message: "an operator must act" });
    if (s === "closed") return resp(200, { claim: CLAIM_ROW, ticketClosed: { status: "Done", statusType: "completed" } });
    if (s === "taken-over") return resp(200, { claim: CLAIM_ROW, lapsed: { at: "t0", claimedSince: [{ id: "c2", holder: "someone", holderKind: "agent", ownKey: false, expiresAt: "t9" }], moreSince: 0 } });
    return resp(200, { claim: CLAIM_ROW });
  };
  return { fetch, calls, leases };
}

/** A stubbed Linear client for the PR-link comment (board.comment reads the issue then creates the comment). */
function stubGql(commentSuccess = true, seq: string[] = []): { gql: Gql; calls: string[] } {
  const calls: string[] = [];
  const gql: Gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> => {
    calls.push(query.includes("commentCreate") ? "comment" : query.includes("issue(id") ? "issue" : "other");
    if (query.includes("commentCreate")) seq.push("comment");
    const data = (v: unknown): GqlResult<T> => ({ data: v as T, errors: [] });
    if (query.includes("issue(id")) return data({ issue: { id: "uuid-1", labelIds: ["l"] } });
    if (query.includes("commentCreate")) return data({ commentCreate: { success: commentSuccess } });
    return { data: null, errors: [{ message: "unrouted" }] };
  };
  return { gql, calls };
}

/** A GitHub client stub that records its arguments, so the test asserts publish passes the right head/base/body/branch. */
type PushArg = { branch: string };
type PrArg = { title: string; head: string; base: string; body: string };
function stubGithub(opts: { push?: boolean; pr?: boolean; pushThrows?: boolean; prThrows?: boolean; pushDetail?: string } = {}, seq: string[] = []): { client: GitHubClient; pushes: PushArg[]; prs: PrArg[] } {
  const pushes: PushArg[] = [];
  const prs: PrArg[] = [];
  const client: GitHubClient = {
    pushBranch: async (o) => {
      seq.push("push");
      pushes.push(o);
      if (opts.pushThrows) throw new Error("git push: connection reset");
      return opts.push === false ? { ok: false, detail: opts.pushDetail ?? "remote rejected" } : { ok: true };
    },
    openDraftPr: async (o) => {
      seq.push("pr");
      prs.push(o);
      if (opts.prThrows) throw new Error("fetch failed: the network is down");
      return opts.pr === false ? { ok: false, detail: "GitHub 422" } : { ok: true, number: 777, url: "https://github.com/owner/repo/pull/777" };
    },
  };
  return { client, pushes, prs };
}

/** Make a PublishInput over a fresh record, and the deps, for a scenario. */
function makePublish(
  state: string,
  opts: { renew?: RenewScenario; push?: boolean; pr?: boolean; pushThrows?: boolean; prThrows?: boolean; pushDetail?: string; comment?: boolean; precheck?: boolean | "throw" } = {},
): { input: PublishInput; deps: PublishDeps; dir: string; seq: string[]; pushes: PushArg[]; prs: PrArg[]; fetchCalls: string[]; gqlCalls: string[]; leases: number[] } {
  const n = runSeq++;
  const run = `2026-01-02T03-04-05-${String(n).padStart(3, "0")}Z`;
  startRecord(state, { run, ticket: "SMD-1234", base: "abc1234", branch: "agent/smd-1234-fix-the-thing" });
  const dir = runDir(state, run);
  const seq: string[] = [];
  const f = stubFetch(opts.renew ?? "clean", seq);
  const g = stubGql(opts.comment ?? true, seq);
  const gh = stubGithub({ push: opts.push, pr: opts.pr, pushThrows: opts.pushThrows, prThrows: opts.prThrows, pushDetail: opts.pushDetail }, seq);
  const deps: PublishDeps = { github: gh.client, fetch: f.fetch, base: "http://127.0.0.1:8010/api", brainKey: `bk${"0".repeat(60)}`, runnerDir: state, gql: g.gql, now: () => new Date("2026-01-02T03:04:05Z") };
  const precheck: PublishInput["precheck"] =
    opts.precheck === "throw"
      ? async () => { throw new Error("Linear 500 during the re-read"); }
      : async () => (opts.precheck === false ? { ok: false, reason: "the description changed since the brief" } : { ok: true });
  const input: PublishInput = {
    dir,
    ticket: "SMD-1234",
    claimId: `claim-${n}`,
    token: `wc_${"a".repeat(64)}`,
    piece: null,
    leaseDaySeconds: DAY,
    leaseWeekSeconds: WEEK,
    branch: "agent/smd-1234-fix-the-thing",
    head: "ob1-agent-runner:agent/smd-1234-fix-the-thing",
    baseBranch: "main",
    title: "[core] Fix the thing (SMD-1234)",
    body: "the pre-built body",
    precheck,
  };
  return { input, deps, dir, seq, pushes: gh.pushes, prs: gh.prs, fetchCalls: f.calls, gqlCalls: g.calls, leases: f.leases };
}

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = (cond: unknown, what: string): void => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const section = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await fn();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: it threw (${String((e as Error)?.stack ?? (e as Error)?.message ?? e).slice(0, 200)})`);
    }
  };

  await section("fenceFor: a fence longer than any run of backticks inside", () => {
    ok(fenceFor("no backticks here") === "```", "no backticks → three");
    ok(fenceFor("a ``` b") === "````", "a run of 3 → four");
    ok(fenceFor("```` and `````") === "``````", "the longest run (5) → six");
    ok(fenceFor("`") === "```", "a single backtick → still three (the minimum)");
  });

  await section("buildPrBody: the facts section carries the run's computed fields", () => {
    const b = buildPrBody(body({ gate: { pass: true, failed: [], ciCheckFiles: ["scripts/check-consistency.ts"] } }), clean);
    ok(b.includes("**Ticket:** SMD-1234"), "names the ticket");
    ok(b.includes("`abc1234`") && b.includes("agent/smd-1234-fix-the-thing"), "names the base and branch");
    ok(b.includes("**Gate:** passed"), "names the gate result");
    ok(b.includes("scripts/check-consistency.ts") && b.includes("CI runs the branch's own copy"), "names CI-relevant files");
    ok(b.includes("worker: 42 turns, $1.84"), "lists the sessions");
    ok(b.includes("2 files changed"), "includes the diff stat");
  });

  await section("buildPrBody: ciCheckFiles are capped so the facts block can't dominate", () => {
    const many = Array.from({ length: 70 }, (_, i) => `scripts/check-${i}.ts`);
    const b = buildPrBody(body({ gate: { pass: true, failed: [], ciCheckFiles: many } }), clean);
    ok(b.includes("and 20 more"), "names the first 50 and counts the rest");
    ok(!b.includes("scripts/check-69.ts"), "a file past the cap is not listed");
  });

  await section("buildPrBody: model text sits in a fence it can't break out of", () => {
    const report = "I did it.\n```\n### not a real heading\n```\nand more";
    const b = buildPrBody(body({ workerReport: report }), clean);
    ok(b.includes("Unverified model output"), "the report is marked unverified");
    ok(b.includes("````\n"), "the report's run of 3 backticks forces a 4-backtick fence");
    const idx = b.indexOf("I did it.");
    ok(idx > 0 && b.slice(idx).startsWith(report), "the whole report (its inner fences included) is inside one block");
  });

  await section("buildPrBody: a mention in model text is inside the code block (won't notify)", () => {
    const b = buildPrBody(body({ workerReport: "cc @someone please look" }), clean);
    const f = b.indexOf("```", b.indexOf("Unverified"));
    const close = b.indexOf("```", f + 3);
    const at = b.indexOf("@someone");
    ok(at > f && at < close, "the @mention falls between the opening and closing fence");
  });

  await section("buildPrBody: a flagged section is withheld, not shown", () => {
    const b = buildPrBody(body({ workerReport: "here is the SECRET value sk-xyz" }), scanFor("SECRET"));
    ok(b.includes("Withheld") && b.includes("secret scanner"), "the worker report is withheld with a note");
    ok(!b.includes("sk-xyz"), "the flagged text itself is not in the body");
  });

  await section("buildPrBody: open findings are fenced; a flagged finding withholds the section", () => {
    const b = buildPrBody(body({ openFindings: ["finding one", "finding two"] }), clean);
    ok(b.includes("Open review findings") && b.includes("finding one") && b.includes("finding two"), "open findings are listed in their section");
    const flagged = buildPrBody(body({ openFindings: ["ok one", "has a SECRET"] }), scanFor("SECRET"));
    ok(flagged.includes("Open review findings") && flagged.includes("Withheld") && !flagged.includes("has a SECRET"), "a finding that trips the scanner withholds the whole findings section");
    const none = buildPrBody(body({ openFindings: [] }), clean);
    ok(!none.includes("Open review findings"), "no findings section when there are none");
  });

  await section("buildPrBody: a claim token in model text is masked (plain and markdown-escaped)", () => {
    const b = buildPrBody(body({ workerReport: `token is wc_${"d".repeat(64)} oops` }), clean);
    ok(b.includes("wc_…") && !b.includes("d".repeat(64)), "the plain token is masked to wc_…");
    const esc = buildPrBody(body({ workerReport: `escaped wc\\_${"e".repeat(64)} oops` }), clean);
    ok(!esc.includes("e".repeat(64)), "the markdown-escaped wc\\_ form is masked too");
  });

  await section("buildPrBody: one oversized section is truncated per section and kept, under cap", () => {
    const huge = "x".repeat(BODY_CAP * 2);
    const b = buildPrBody(body({ workerReport: huge }), clean);
    ok(b.length <= BODY_CAP, `the body is under the ${BODY_CAP} cap (${b.length})`);
    ok(b.includes("[truncated at") && !b.includes("Model output omitted"), "the section is truncated, not dropped");
    ok(!b.includes(huge), "the full oversized report text is not in the body");
  });

  await section("buildPrBody: when model sections together exceed the cap, they're dropped whole (never mid-fence)", () => {
    const huge = "y".repeat(BODY_CAP);
    const b = buildPrBody(body({ workerReport: huge, openFindings: [huge, huge] }), clean);
    ok(b.length <= BODY_CAP, `the body is under the ${BODY_CAP} cap (${b.length})`);
    ok(b.includes("Model output omitted"), "the model sections are replaced by a note");
    ok(!b.includes("Unverified model output"), "neither model section is included");
    ok(b.includes("## Agent runner") && b.includes("2 files changed"), "the facts section is kept");
    const fences = (b.match(/^```+$/gm) ?? []).length;
    ok(fences % 2 === 0, `fence lines are balanced (${fences})`);
  });

  await section("renewVerdict: maps each renew reply to publish / owed / hand-to-a-person", () => {
    const renewed = (over: Partial<Extract<ClaimReply, { kind: "renewed" }>>): ClaimReply => ({ kind: "renewed", claim: {} as never, revived: null, ticketClosed: null, ...over });
    ok(renewVerdict(renewed({})).ok, "a clean renewal publishes");

    const closed = renewVerdict(renewed({ ticketClosed: { status: "Done", statusType: "completed" } }));
    ok(!closed.ok && (closed as { handToPerson: boolean }).handToPerson, "a closed ticket hands to a person");

    const taken = renewVerdict(renewed({ revived: { lapsedAt: "t", others: [{ id: "c2", holder: "x", holderKind: "agent", ownKey: false, expiresAt: null }], unreadable: false, more: 0 } }));
    ok(!taken.ok && (taken as { handToPerson: boolean }).handToPerson, "a lapse another claim took over hands to a person");

    const more = renewVerdict(renewed({ revived: { lapsedAt: "t", others: [], unreadable: false, more: 1 } }));
    ok(!more.ok && (more as { handToPerson: boolean }).handToPerson, "a lapse with unnamed 'more' claims hands to a person");

    const lapsedAlone = renewVerdict(renewed({ revived: { lapsedAt: "t", others: [], unreadable: false, more: 0 } }));
    ok(lapsedAlone.ok, "a lapse with nothing else on the work still publishes");

    const retry = renewVerdict({ kind: "unattributed", retryable: true, lapsedAt: null, detail: "away" });
    ok(!retry.ok && (retry as { retryable: boolean; handToPerson: boolean }).retryable && !(retry as { handToPerson: boolean }).handToPerson, "a retryable unattributed is owed, not a person's");

    const final = renewVerdict({ kind: "unattributed", retryable: false, lapsedAt: null, detail: "operator" });
    ok(!final.ok && (final as { handToPerson: boolean }).handToPerson && !(final as { retryable: boolean }).retryable, "a final unattributed hands to a person");

    const err = renewVerdict({ kind: "error", detail: "timeout" });
    ok(!err.ok && (err as { retryable: boolean }).retryable, "a transport error is retryable (owed)");

    const ended = renewVerdict({ kind: "ended", ticketClosed: false, detail: "gone" });
    ok(!ended.ok && (ended as { handToPerson: boolean }).handToPerson, "an ended claim hands to a person");

    const held = renewVerdict({ kind: "work-claimed", heldBy: [], detail: "held" });
    ok(!held.ok && (held as { handToPerson: boolean }).handToPerson, "a work-claimed hands to a person");

    const refused = renewVerdict({ kind: "refused", code: "CLAIM_NOT_YOURS", detail: "nope" });
    ok(!refused.ok && (refused as { handToPerson: boolean }).handToPerson, "a refused (CLAIM_NOT_YOURS) hands to a person");

    const asClaimed = renewVerdict({ kind: "claimed", claim: {} as never, token: "wc_x", ticketClosed: null });
    ok(!asClaimed.ok && (asClaimed as { handToPerson: boolean }).handToPerson, "an unexpected 'claimed' reply to a renew hands to a person");

    const asReleased = renewVerdict({ kind: "released", claim: null, alreadyEnded: false, detail: "rel" });
    ok(!asReleased.ok && (asReleased as { handToPerson: boolean }).handToPerson, "an unexpected 'released' reply to a renew hands to a person");
  });

  await section("prLinkComment: names the PR, no model text", () => {
    const c = prLinkComment("SMD-1234", { number: 777, url: "https://github.com/owner/repo/pull/777" });
    ok(c.includes("#777") && c.includes("https://github.com/owner/repo/pull/777"), "the comment links the PR");
    ok(c.includes("does not merge"), "it says the runner doesn't merge");
  });

  const root = mkdtempSync(join(tmpdir(), "obr-publish-"));
  try {
    await section("publish: the happy path — confirm (day), push, draft PR with the right args, record, week lease, comment", async () => {
      const m = makePublish(root, {});
      const r = await publish(m.input, m.deps);
      ok(r.published && r.prNumber === 777 && r.prUrl?.includes("/777"), "published, with the PR number and URL");
      ok(r.pushed && r.leaseRenewed && r.commented && r.owed.length === 0 && !r.handToPerson, "pushed, lease renewed, commented, nothing owed, not a person's");
      ok(m.pushes[0]?.branch === "agent/smd-1234-fix-the-thing", "pushBranch got the run's branch");
      ok(m.prs[0]?.head === m.input.head && m.prs[0]?.base === "main" && m.prs[0]?.body === m.input.body, "openDraftPr got the right head, base and body");
      ok(readRecord(m.dir).pr === 777, "the record holds the PR number");
      ok(readToken(claimsDir(root), m.input.claimId).lease_seconds === WEEK, "the token file's lease is bumped to a week after the PR opens");
      ok(m.seq.filter((s) => s === "renew").length === 2, "two renewals: the day-lease confirm, then the week lease after the PR");
      ok(m.leases.length === 2 && m.leases[0] === DAY && m.leases[1] === WEEK, "step 8 renews with the day lease, step 9 with the week lease");
      ok(m.seq.indexOf("renew") < m.seq.indexOf("push") && m.seq.indexOf("push") < m.seq.indexOf("pr") && m.seq.indexOf("pr") < m.seq.indexOf("comment"), "the order is renew, push, PR, comment");
    });

    await section("publish: the PR title is masked of tokens before it reaches GitHub", async () => {
      const m = makePublish(root, {});
      m.input.title = `[core] oops wc_${"f".repeat(64)} (SMD-1234)`;
      const r = await publish(m.input, m.deps);
      ok(r.published, "published");
      ok(m.prs[0]?.title.includes("wc_…") && !m.prs[0]?.title.includes("f".repeat(64)), "the token in the title is masked before the PR opens");
    });

    await section("publish: the precheck fails — hand to a person, nothing pushed", async () => {
      const m = makePublish(root, { precheck: false });
      const r = await publish(m.input, m.deps);
      ok(!r.published && r.handToPerson, "not published, handed to a person");
      ok(!m.seq.includes("renew") && !m.seq.includes("push"), "no renew, no push");
    });

    await section("publish: the precheck THROWS — owed, not thrown (never-throws contract)", async () => {
      const m = makePublish(root, { precheck: "throw" });
      let threw = false;
      let r;
      try {
        r = await publish(m.input, m.deps);
      } catch {
        threw = true;
      }
      ok(!threw && r, "publish returned a result instead of throwing");
      ok(r && !r.published && !r.handToPerson && r.owed.some((o) => o.kind === "publish"), "a throwing precheck leaves the publish owed to retry");
    });

    await section("publish: a closed ticket at renew — hand to a person, not pushed", async () => {
      const m = makePublish(root, { renew: "closed" });
      const r = await publish(m.input, m.deps);
      ok(!r.published && r.handToPerson && !r.pushed, "not published, handed to a person, not pushed");
    });

    await section("publish: the claim taken over at renew — hand to a person", async () => {
      const m = makePublish(root, { renew: "taken-over" });
      const r = await publish(m.input, m.deps);
      ok(!r.published && r.handToPerson && !r.pushed, "not published, handed to a person, not pushed");
    });

    await section("publish: a final unattributed at renew — hand to a person", async () => {
      const m = makePublish(root, { renew: "unattributed-final" });
      const r = await publish(m.input, m.deps);
      ok(!r.published && r.handToPerson && r.owed.length === 0, "not published, handed to a person, nothing owed");
    });

    await section("publish: a retryable renew — owed (publish), not a person's, not pushed", async () => {
      const m = makePublish(root, { renew: "unattributed-retry" });
      const r = await publish(m.input, m.deps);
      ok(!r.published && !r.handToPerson, "not published, not handed to a person");
      ok(r.owed.some((o) => o.kind === "publish"), "the publish is left owed to retry");
      ok(!m.seq.includes("push"), "it did not push");
    });

    await section("publish: a renew transport error — owed (publish), not thrown", async () => {
      const m = makePublish(root, { renew: "error" });
      const r = await publish(m.input, m.deps);
      ok(!r.published && !r.handToPerson && r.owed.some((o) => o.kind === "publish"), "a transport error leaves the publish owed");
      ok(!m.seq.includes("push"), "it did not push");
    });

    await section("publish: a push failure — owed (publish), lease confirmed, not a person's", async () => {
      const m = makePublish(root, { push: false });
      const r = await publish(m.input, m.deps);
      ok(!r.published && !r.pushed && r.leaseRenewed, "not published, not pushed, but the claim was confirmed");
      ok(r.owed.some((o) => o.kind === "publish") && !r.handToPerson, "the push failure is owed to retry, not a person's");
      ok(!m.seq.includes("pr"), "it did not open a PR");
    });

    await section("publish: a GitHub token in a push error is scrubbed from the record strings", async () => {
      const token = `ghp_${"A".repeat(36)}`;
      const m = makePublish(root, { push: false, pushDetail: `remote: https://x-access-token:${token}@github.com/bot/fork rejected` });
      const r = await publish(m.input, m.deps);
      const combined = `${r.owed.map((o) => o.why).join(" ")} ${r.reason}`;
      ok(!combined.includes(token) && combined.includes("gh_…"), "the GitHub token is masked in owed.why and reason");
    });

    await section("publish: a PR-open failure — owed (publish), pushed but not published", async () => {
      const m = makePublish(root, { pr: false });
      const r = await publish(m.input, m.deps);
      ok(!r.published && r.pushed && r.prNumber === null, "pushed, but no PR and not published");
      ok(r.owed.some((o) => o.kind === "publish") && !r.handToPerson, "the PR-open failure is owed to retry, not a person's");
      ok(readRecord(m.dir).pr === null, "the record has no PR number");
    });

    await section("publish: a throwing push — owed, not thrown (never-throws contract)", async () => {
      const m = makePublish(root, { pushThrows: true });
      let threw = false;
      let r;
      try {
        r = await publish(m.input, m.deps);
      } catch {
        threw = true;
      }
      ok(!threw && r, "publish returned a result instead of throwing");
      ok(r && !r.published && r.owed.some((o) => o.kind === "publish") && !r.handToPerson, "a throwing push leaves the publish owed to retry");
      ok(!m.seq.includes("pr"), "it did not open a PR");
    });

    await section("publish: a throwing openDraftPr — owed (pushed), not thrown", async () => {
      const m = makePublish(root, { prThrows: true });
      let threw = false;
      let r;
      try {
        r = await publish(m.input, m.deps);
      } catch {
        threw = true;
      }
      ok(!threw && r, "publish returned a result instead of throwing");
      ok(r && !r.published && r.pushed && r.owed.some((o) => o.kind === "publish") && !r.handToPerson, "a throwing PR-open leaves the publish owed, pushed");
      ok(readRecord(m.dir).pr === null, "no PR number recorded");
    });

    await section("publish: a failing week renewal — still published; the token still targets the week lease", async () => {
      const m = makePublish(root, { renew: "week-error" });
      const r = await publish(m.input, m.deps);
      ok(r.published && r.prNumber === 777, "published despite the week renewal failing");
      ok(readToken(claimsDir(root), m.input.claimId).lease_seconds === WEEK, "the token targets the week lease, so step 0 bumps the brain to it (no weekend lapse)");
    });

    await section("publish: a failed comment is owed; the PR is still published", async () => {
      const m = makePublish(root, { comment: false });
      const r = await publish(m.input, m.deps);
      ok(r.published && r.prNumber === 777 && !r.commented, "published but the comment didn't land");
      ok(r.owed.some((o) => o.kind === "comment") && !r.owed.some((o) => o.kind === "publish"), "only the comment is owed");
      ok(readRecord(m.dir).pr === 777, "the PR number is still recorded");
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
    console.error("usage: bun scripts/agent-runner/publish-check.ts --self-check");
    process.exit(2);
  }
  process.exit(await selfCheck());
}
