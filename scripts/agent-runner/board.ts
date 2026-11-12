/**
 * board.ts — the runner's Linear moves (SMD-4087 cut 2c-2; docs/agent-runner.md, decision 12, "A run, step by step"
 * step 4 and the hand-back). The runner — not the agent session — moves the ticket: to In Progress when it claims, and
 * back to Backlog when it hands the ticket back. On a hand-back it relabels for a person when the work failed (the
 * runner's `agent-ready` off, `agent-handed-back` on) and keeps the label for the runner when the environment did, so a
 * later tick can take it. Each move is one `issueUpdate` over the runner's own Linear key.
 *
 * The GraphQL client is injected, as cut 1's `readBoard` takes it (`strict`/`Gql` from db/linear-api.ts), so the
 * self-check drives every reply offline with no key and no network. The live run that calls these with the real key is
 * cut 2c-3.
 *
 * A move never throws: a Linear outage or refusal is a `{ ok: false }` result, which the orchestrator records as a step
 * still owed (step 0 retries it), so it never leaves the ticket half-moved without a record.
 */

import { strict, type Gql } from "../../db/linear-api.ts";
import type { Config } from "./facts.ts";

/** A move's result: done, or the reason it couldn't be — never a thrown error. */
export type MoveResult = { ok: true } | { ok: false; detail: string };

/** The workflow states a move targets, each resolved by the team and its exact name, its type checked so a rename or a second state of the name is caught. */
export const IN_PROGRESS = { name: "In Progress", type: "started" } as const;
export const BACKLOG = { name: "Backlog", type: "backlog" } as const;

/** The team's states of a name: resolved by team and name, the type checked here. */
export const STATES_QUERY = `query($team: String!, $name: String!) {
  workflowStates(first: 10, filter: { team: { key: { eq: $team } }, name: { eq: $name } }) { nodes { id name type } }
}`;
/** An issue's uuid and current labels, from its identifier (Linear's `issue(id:)` takes the identifier too). */
export const ISSUE_QUERY = `query($id: String!) { issue(id: $id) { id labelIds } }`;
/** One move: set the state, and the labels when they change. `labelIds` replaces the issue's whole set. */
export const ISSUE_UPDATE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
/** One comment on the issue, by its uuid: the runner's computed hand-back text (decision 12). */
export const COMMENT_CREATE = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;

/** A one-line, shortened fragment of an error, for a result's detail. */
const oneLine = (v: unknown): string => {
  const t = String((v as Error)?.message ?? v).replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

/** The id of the team's one state of the wanted name and type, or the reason it isn't exactly one. */
async function stateId(gql: Gql, cfg: Config, want: { name: string; type: string }): Promise<{ ok: true; id: string } | { ok: false; detail: string }> {
  const data = await strict<{ workflowStates: { nodes: { id: string; name: string; type: string }[] } }>(gql, STATES_QUERY, { team: cfg.team, name: want.name });
  const hits = data.workflowStates.nodes.filter((s) => s.name === want.name && s.type === want.type);
  if (hits.length !== 1) return { ok: false, detail: `team ${cfg.team} has ${hits.length} states named ${JSON.stringify(want.name)} of type ${want.type}, not one` };
  return { ok: true, id: hits[0].id };
}

/** The issue's uuid (for the mutation) and its current label ids, or the reason it couldn't be read. */
async function issueFacts(gql: Gql, identifier: string): Promise<{ ok: true; uuid: string; labelIds: string[] } | { ok: false; detail: string }> {
  const data = await strict<{ issue: { id: string; labelIds: string[] } | null }>(gql, ISSUE_QUERY, { id: identifier });
  if (!data.issue || typeof data.issue.id !== "string") return { ok: false, detail: `Linear has no issue ${identifier}` };
  return { ok: true, uuid: data.issue.id, labelIds: Array.isArray(data.issue.labelIds) ? data.issue.labelIds : [] };
}

/** Run the one update, reading Linear's `success`. */
async function update(gql: Gql, uuid: string, input: Record<string, unknown>): Promise<MoveResult> {
  const data = await strict<{ issueUpdate: { success: boolean } | null }>(gql, ISSUE_UPDATE, { id: uuid, input });
  return data.issueUpdate?.success === true ? { ok: true } : { ok: false, detail: `Linear refused the update to issue ${uuid}` };
}

/** Move a claimed ticket to In Progress (docs step 4), so a person reading Linear sees the runner took it. */
export async function moveToInProgress(gql: Gql, cfg: Config, identifier: string): Promise<MoveResult> {
  try {
    const state = await stateId(gql, cfg, IN_PROGRESS);
    if (!state.ok) return state;
    const issue = await issueFacts(gql, identifier);
    if (!issue.ok) return issue;
    return await update(gql, issue.uuid, { stateId: state.id });
  } catch (e) {
    return { ok: false, detail: `moving ${identifier} to In Progress failed: ${oneLine(e)}` };
  }
}

/**
 * Hand a ticket back, moving it to Backlog (docs, "On a failure"; decision 12). A work failure takes the runner's
 * `agent-ready` off and puts `agent-handed-back` on, so a person takes it next and the runner won't; an environment
 * failure keeps the label and moves only the state, so a later tick can take it. One `issueUpdate` either way.
 */
export async function handBack(gql: Gql, cfg: Config, input: { identifier: string; kind: "work" | "env"; readyLabelId: string; handedBackLabelId: string }): Promise<MoveResult> {
  try {
    const state = await stateId(gql, cfg, BACKLOG);
    if (!state.ok) return state;
    const issue = await issueFacts(gql, input.identifier);
    if (!issue.ok) return issue;
    const relabelled = [...new Set([...issue.labelIds.filter((l) => l !== input.readyLabelId), input.handedBackLabelId])];
    const mutation = input.kind === "work" ? { stateId: state.id, labelIds: relabelled } : { stateId: state.id };
    return await update(gql, issue.uuid, mutation);
  } catch (e) {
    return { ok: false, detail: `handing ${input.identifier} back (${input.kind}) failed: ${oneLine(e)}` };
  }
}

/**
 * Comment on the ticket on a hand-back (docs, "On a failure"; decision 12): the runner's computed text, no model text,
 * one `commentCreate` over the runner's key. Resolves the issue's uuid first (`CommentCreateInput.issueId` is the uuid,
 * as the update's `id` is). Never throws — a Linear outage is a `{ ok: false }` the orchestrator records as owed. The
 * caller (cut 2c-3) computes the body from the run's own fields and applies the secret scan before it reaches here.
 */
export async function comment(gql: Gql, identifier: string, body: string): Promise<MoveResult> {
  try {
    const issue = await issueFacts(gql, identifier);
    if (!issue.ok) return issue;
    const data = await strict<{ commentCreate: { success: boolean } | null }>(gql, COMMENT_CREATE, { input: { issueId: issue.uuid, body } });
    return data.commentCreate?.success === true ? { ok: true } : { ok: false, detail: `Linear refused the comment on ${identifier}` };
  } catch (e) {
    return { ok: false, detail: `commenting on ${identifier} failed: ${oneLine(e)}` };
  }
}
