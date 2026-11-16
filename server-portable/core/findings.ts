// The priority review's findings (SMD-3671 PR 2): migration 142's list and its
// operator's decision as operations of the core, so the REST core and the MCP
// server answer them alike. Sleep's scan (ob1_priority_review, PR 1) proposes
// each finding; nothing changes a priority until an operator decides one. The
// database decides every rule of the decision — who may (a key the registry
// classifies operator, by its agent id, with write scope), which arguments go
// together, what an accept states, what holds the same finding back — and this
// file passes the caller's envelope, its scope stated, and turns 142's answers
// into values and refusals.

import type { Principal } from "../auth.ts";
import { PriorityRefused, type FindingKind, type FindingStatus, type PriorityAssertion, type PriorityFinding, type PriorityItem } from "../store.ts";
import { dueBy } from "../priority-scale.ts";
import type { Ctx } from "./context.ts";
import { asked, unattributedAs, writerScope } from "./caller.ts";
import { ok, refuse, type FindingInputProblem, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/** list_priority_findings' value: the filters it read under, how many findings match, and the page of them from `offset`. */
export type FindingsListed = { status: FindingStatus | "all"; kind: FindingKind | null; total: number; offset: number; findings: PriorityFinding[] };

export async function listPriorityFindings(ctx: Ctx, _principal: Principal, { status, kind, limit, offset }: Input<"list_priority_findings">): Promise<Outcome<FindingsListed, never>> {
  // A brain before 142 holds no table: the read faults naming priority_findings, and the fault's hint says so
  // (render.ts findingsHint), as a listing before its migration does.
  const page = await (await ctx.store()).listPriorityFindings({ status: status === "all" ? null : status, kind: kind ?? null, limit, offset });
  return ok({ status, kind: kind ?? null, total: page.total, offset, findings: page.findings });
}

/**
 * What an operator's decision did: the finding, its status now, what the accept's writer did (`outcome`: the operator's
 * statement asserted, the same one re-confirmed unchanged, or the operator's own cleared; null for a reject), the
 * statement it wrote or the newest it closed (`assertion`), every one it closed, the item's winner after, and until
 * when the decision holds the same finding back.
 */
export type FindingReviewed = {
  id: string; kind: FindingKind; item: PriorityItem; status: "accepted" | "rejected";
  outcome: "asserted" | "unchanged" | "cleared" | null; assertion: PriorityAssertion | null; closed: PriorityAssertion[]; winner: PriorityAssertion | null;
  suppressedUntil: string | null; caller: string;
};
export type FindingReviewCode = "REFUSED_NOT_OPERATOR" | "PRIORITY_UNATTRIBUTED" | "WRITE_SCOPE_REQUIRED" | "NOT_FOUND" | "REFUSED_FINDING_INPUT" | "REFUSED_FINDING_DECISION" | "REFUSED_PRIORITY_INPUT";
const inputRefused = (problem: FindingInputProblem, message: string) => refuse({ code: "REFUSED_FINDING_INPUT", retryable: false, problem, message });

export async function reviewPriorityFinding(ctx: Ctx, principal: Principal, input: Input<"review_priority_finding">): Promise<Outcome<FindingReviewed, FindingReviewCode>> {
  // 142 asks who first (an operator, then write scope), then whether the arguments go together, so a key that may never
  // decide is told that and not how to mend a call it cannot make; the schema takes each field alone, and the rules that
  // join them are 142's alone. One exception: a due time Postgres cannot read is refused binding the call, before 142
  // runs, so any key is told so (REFUSED_PRIORITY_INPUT, naming nothing about the finding).
  // Who may is the database's to say, as for set_priority_weights: the key's registry kind by its agent id, which the
  // server does not hold. Without the agent id the database can tell no operator (a name lends no kind): the
  // registry's absence is said as set_priority says it, and a principal that has none by design is named so.
  const away = unattributedAs("PRIORITY_UNATTRIBUTED", principal);
  if (away) return away;
  if (principal.agentId === undefined) return refuse({ code: "REFUSED_NOT_OPERATOR", retryable: false, key: principal.name, kind: null, unidentified: true });
  const id = input.id.toLowerCase();
  // A date alone is due by the end of that day, as set_priority reads one (SMD-3778). A due time Postgres cannot read,
  // or a 22023 of the writer 142 calls, is set_priority's refusal, the same input answered the same.
  const r = await asked(PriorityRefused, async () => (await ctx.store()).reviewPriorityFinding({
    id, decision: input.decision, level: input.level, dueAt: dueBy(input.due_at),
    clear: input.clear, note: input.note, actor: actorOf(ctx, principal), scope: writerScope(principal),
  }));
  if (r instanceof PriorityRefused) return refuse({ code: "REFUSED_PRIORITY_INPUT", retryable: false, problem: r.problem, message: r.message });
  if (!r.ok) {
    switch (r.error) {
      case "NOT_OPERATOR": return refuse({ code: "REFUSED_NOT_OPERATOR", retryable: false, key: principal.name, kind: r.kind });
      case "NOT_WRITE_SCOPE": return refuse({ code: "WRITE_SCOPE_REQUIRED", retryable: false, key: principal.name });
      case "NOT_FOUND": return refuse({ code: "NOT_FOUND", retryable: false, id });
      case "NOT_PENDING": return refuse({ code: "REFUSED_FINDING_DECISION", retryable: false, id, problem: "NOT_PENDING", message: r.message, ...(r.status === "pending" ? {} : { status: r.status }) });
      case "NOTHING_TO_CLEAR":
      case "WRITER_REFUSED":
        return refuse({ code: "REFUSED_FINDING_DECISION", retryable: false, id, problem: r.error, message: r.message, ...(r.writerCode ? { writerCode: r.writerCode } : {}) });
      default: return inputRefused(r.error, r.message);
    }
  }
  const a = r.answer;
  // A reject reaches no writer; an accept's writer answered asserted, unchanged or cleared (142 refuses the rest).
  if (a && a.outcome !== "asserted" && a.outcome !== "unchanged" && a.outcome !== "cleared") throw new Error(`review_priority_finding decided on a writer's ${a.outcome}`);
  // No action-log row, as set_priority_weights: a decision is no search.
  return ok({
    id: r.id, kind: r.kind, item: r.item, status: r.status, outcome: a ? a.outcome as FindingReviewed["outcome"] : null, assertion: a?.assertion ?? null,
    closed: a ? a.closed ?? (a.outcome === "cleared" ? (a.assertion ? [a.assertion] : []) : a.replaced ? [a.replaced] : []) : [], winner: a?.winner ?? null,
    suppressedUntil: r.suppressedUntil, caller: principal.name,
  });
}
