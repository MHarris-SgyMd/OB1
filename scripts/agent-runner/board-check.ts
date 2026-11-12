/**
 * board-check.ts — the offline self-check of cut 2c-2 (SMD-4087): the runner's Linear moves (board.ts), on a stubbed
 * GraphQL client, with no key and no network. CI runs it (`bun scripts/agent-runner/board-check.ts --self-check`). The
 * stub routes each query and the mutation and records the calls, so every move and every refusal is checked, and the
 * mutation's variables (the state and the relabelling) are asserted exactly. The live run that calls board.ts with the
 * real key is cut 2c-3.
 *
 *   bun scripts/agent-runner/board-check.ts --self-check
 */

import type { Gql, GqlResult } from "../../db/linear-api.ts";
import { BACKLOG, IN_PROGRESS, comment, handBack, moveToInProgress } from "./board.ts";
import type { Config } from "./facts.ts";

const CFG = { team: "SMD" } as unknown as Config;
const READY = "label-ready";
const HANDED = "label-handed-back";

type Scenario = {
  /** The nodes STATES_QUERY answers (default: one In Progress and one Backlog, both the right type). */
  states?: { id: string; name: string; type: string }[];
  /** The issue ISSUE_QUERY answers; `null` for none; omitted for a default issue with no labels. */
  issue?: { id: string; labelIds: string[] } | null;
  /** issueUpdate's `success` (default true). */
  updateSuccess?: boolean;
  /** commentCreate's `success` (default true). */
  commentSuccess?: boolean;
  /** Make every call answer a GraphQL error (so `strict` throws). */
  gqlError?: string;
};

/** A stubbed Gql that routes by the query text and records every call, so a test asserts the mutation's variables. */
function stub(s: Scenario): { gql: Gql; calls: { query: string; variables: Record<string, unknown> }[] } {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const defaultStates = [{ id: "st-ip", name: "In Progress", type: "started" }, { id: "st-bl", name: "Backlog", type: "backlog" }];
  const gql: Gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> => {
    calls.push({ query, variables });
    const data = (v: unknown): GqlResult<T> => ({ data: v as T, errors: [] });
    if (s.gqlError) return { data: null, errors: [{ message: s.gqlError }] };
    if (query.includes("workflowStates")) {
      const name = variables.name as string;
      const nodes = (s.states ?? defaultStates).filter((st) => st.name === name);
      return data({ workflowStates: { nodes } });
    }
    if (query.includes("issue(id")) return data({ issue: s.issue === undefined ? { id: "u1", labelIds: [] } : s.issue });
    if (query.includes("issueUpdate")) return data({ issueUpdate: { success: s.updateSuccess ?? true } });
    if (query.includes("commentCreate")) return data({ commentCreate: { success: s.commentSuccess ?? true } });
    return { data: null, errors: [{ message: `unrouted query: ${query.slice(0, 40)}` }] };
  };
  return { gql, calls };
}

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = (cond: unknown, what: string): void => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const section = async (name: string, body: () => void | Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: it threw (${String((e as Error)?.stack ?? (e as Error)?.message ?? e).slice(0, 200)})`);
    }
  };
  /** The one issueUpdate call's `input`, or null if none ran. */
  const mutationInput = (calls: { query: string; variables: Record<string, unknown> }[]): Record<string, unknown> | null => {
    const m = calls.find((c) => c.query.includes("issueUpdate"));
    return m ? (m.variables.input as Record<string, unknown>) : null;
  };

  await section("the targeted states are named and typed as Linear's defaults", () => {
    ok(IN_PROGRESS.name === "In Progress" && IN_PROGRESS.type === "started", "In Progress is a started state");
    ok(BACKLOG.name === "Backlog" && BACKLOG.type === "backlog", "Backlog is a backlog state");
  });

  await section("moveToInProgress sets the state on the issue's uuid", async () => {
    const s = stub({ issue: { id: "uuid-1", labelIds: [READY] } });
    const r = await moveToInProgress(s.gql, CFG, "SMD-9");
    ok(r.ok === true, `the move succeeds${r.ok ? "" : `: ${r.detail}`}`);
    const statesCall = s.calls.find((c) => c.query.includes("workflowStates"));
    ok(statesCall?.variables.team === "SMD" && statesCall?.variables.name === "In Progress", "the state is resolved by the config's team and the In Progress name");
    const issueCall = s.calls.find((c) => c.query.includes("issue(id"));
    ok(issueCall?.variables.id === "SMD-9", "the issue is resolved by its identifier");
    const mut = s.calls.find((c) => c.query.includes("issueUpdate"));
    ok(mut?.variables.id === "uuid-1", "the mutation targets the issue's uuid, not its identifier");
    ok(JSON.stringify(mutationInput(s.calls)) === JSON.stringify({ stateId: "st-ip" }), "the input sets the In Progress state and nothing else");
  });

  await section("handBack on a work failure relabels for a person and moves to Backlog", async () => {
    const s = stub({ issue: { id: "uuid-1", labelIds: [READY, "other-label"] } });
    const r = await handBack(s.gql, CFG, { identifier: "SMD-9", kind: "work", readyLabelId: READY, handedBackLabelId: HANDED });
    ok(r.ok === true, `the hand-back succeeds${r.ok ? "" : `: ${r.detail}`}`);
    ok(s.calls.find((c) => c.query.includes("workflowStates"))?.variables.name === "Backlog", "the state is resolved by the Backlog name");
    const input = mutationInput(s.calls);
    const labels = (input?.labelIds as string[]) ?? [];
    ok(input?.stateId === "st-bl", "the state becomes Backlog");
    ok(!labels.includes(READY) && labels.includes(HANDED) && labels.includes("other-label"), "agent-ready is off, agent-handed-back is on, the other label kept");
  });

  await section("handBack on an environment failure keeps the label and moves state alone", async () => {
    const s = stub({ issue: { id: "uuid-1", labelIds: [READY] } });
    const r = await handBack(s.gql, CFG, { identifier: "SMD-9", kind: "env", readyLabelId: READY, handedBackLabelId: HANDED });
    ok(r.ok === true, "the hand-back succeeds");
    ok(JSON.stringify(mutationInput(s.calls)) === JSON.stringify({ stateId: "st-bl" }), "the input sets Backlog and does not touch the labels (agent-ready kept)");
  });

  await section("handBack does not add agent-handed-back twice or keep agent-ready", async () => {
    const s = stub({ issue: { id: "uuid-1", labelIds: [READY, HANDED] } });
    await handBack(s.gql, CFG, { identifier: "SMD-9", kind: "work", readyLabelId: READY, handedBackLabelId: HANDED });
    const labels = (mutationInput(s.calls)?.labelIds as string[]) ?? [];
    ok(labels.filter((l) => l === HANDED).length === 1 && !labels.includes(READY), "agent-handed-back appears once, agent-ready removed");
  });

  await section("a state that isn't exactly one is refused, and no mutation runs", async () => {
    const none = stub({ states: [] });
    const rNone = await moveToInProgress(none.gql, CFG, "SMD-9");
    ok(rNone.ok === false && !none.calls.some((c) => c.query.includes("issueUpdate")), "no In Progress state: refused, nothing updated");
    const two = stub({ states: [{ id: "a", name: "Backlog", type: "backlog" }, { id: "b", name: "Backlog", type: "backlog" }] });
    const rTwo = await handBack(two.gql, CFG, { identifier: "SMD-9", kind: "env", readyLabelId: READY, handedBackLabelId: HANDED });
    ok(rTwo.ok === false, "two Backlog states: refused");
    const wrongType = stub({ states: [{ id: "x", name: "Backlog", type: "unstarted" }] });
    const rType = await handBack(wrongType.gql, CFG, { identifier: "SMD-9", kind: "env", readyLabelId: READY, handedBackLabelId: HANDED });
    ok(rType.ok === false && !wrongType.calls.some((c) => c.query.includes("issueUpdate")), "a Backlog of the wrong type is not taken as the state");
  });

  await section("a missing issue, a refused update, and a Linear outage are results, not throws", async () => {
    const noIssue = stub({ issue: null });
    const rNo = await moveToInProgress(noIssue.gql, CFG, "SMD-404");
    ok(rNo.ok === false && !noIssue.calls.some((c) => c.query.includes("issueUpdate")), "a missing issue is refused, nothing updated");
    const refused = stub({ issue: { id: "uuid-1", labelIds: [] }, updateSuccess: false });
    const rRef = await moveToInProgress(refused.gql, CFG, "SMD-9");
    ok(rRef.ok === false, "issueUpdate success=false is a failed move");
    const outage = stub({ gqlError: "rate limited" });
    const rOut = await handBack(outage.gql, CFG, { identifier: "SMD-9", kind: "work", readyLabelId: READY, handedBackLabelId: HANDED });
    ok(rOut.ok === false && rOut.detail.includes("failed"), "a GraphQL error is caught as a failed move, not thrown");
  });

  await section("comment posts one commentCreate on the issue's uuid, and refusals are results, not throws", async () => {
    const s = stub({ issue: { id: "uuid-1", labelIds: [] } });
    const r = await comment(s.gql, "SMD-9", "the hand-back note");
    ok(r.ok === true, `the comment posts${r.ok ? "" : `: ${r.detail}`}`);
    const cc = s.calls.find((c) => c.query.includes("commentCreate"));
    const input = cc?.variables.input as { issueId?: string; body?: string } | undefined;
    ok(input?.issueId === "uuid-1", "the comment targets the issue's uuid, not its identifier");
    ok(input?.body === "the hand-back note", "the body is the runner's text, passed through");
    const refused = stub({ issue: { id: "uuid-1", labelIds: [] }, commentSuccess: false });
    ok((await comment(refused.gql, "SMD-9", "x")).ok === false, "commentCreate success=false is a failed comment");
    const noIssue = stub({ issue: null });
    const rNo = await comment(noIssue.gql, "SMD-404", "x");
    ok(rNo.ok === false && !noIssue.calls.some((c) => c.query.includes("commentCreate")), "a missing issue is refused, nothing posted");
    const outage = stub({ gqlError: "rate limited" });
    const rOut = await comment(outage.gql, "SMD-9", "x");
    ok(rOut.ok === false && rOut.detail.includes("failed"), "a GraphQL error is caught as a failed comment, not thrown");
  });

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  if (!process.argv.slice(2).includes("--self-check")) {
    console.error("usage: bun scripts/agent-runner/board-check.ts --self-check");
    process.exit(2);
  }
  process.exit(await selfCheck());
}
