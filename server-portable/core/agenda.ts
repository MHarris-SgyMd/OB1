// The agenda (SMD-3669, SMD-4162, SMD-4192): what matters now, as one read of
// migration 129's agenda — open, startable, unclaimed, unstarted tickets and
// open items in a scope, ranked by 122's effective priority or, with order
// due, by due time, each with the terms behind its place, and what was left
// out and why. A read: the database decides the candidates, the filters and
// the order; this file turns the caller's arguments into the call, passes the
// calling key for `mine`, answers the agenda's refusal of `mine` (123's words,
// kept by 124) as CLAIMS_UNREADABLE, a due order on a brain before 129 as
// ORDER_UNAVAILABLE and 122's refusal of the call's weights (SMD-4193) as
// REFUSED_WEIGHTS, and writes the call's query_log row.

import type { Principal } from "../auth.ts";
import type { AgendaResult, PriorityWeights } from "../store.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { weightsRefused } from "./weights.ts";

export type { AgendaResult };
/** The agenda's answer: the store's, and the weights the call passed (SMD-4193), null for the defaults. */
export type AgendaAnswer = AgendaResult & { weights: Partial<PriorityWeights> | null };
export type AgendaCode = "CLAIMS_UNREADABLE" | "ORDER_UNAVAILABLE" | "REFUSED_WEIGHTS";

export async function agenda(ctx: Ctx, principal: Principal, input: Input<"agenda">): Promise<Outcome<AgendaAnswer, AgendaCode>> {
  const scope: { source?: string; project?: string; label?: string } = {};
  if (input.source !== undefined) scope.source = input.source;
  if (input.project !== undefined) scope.project = input.project;
  if (input.label !== undefined) scope.label = input.label;
  // `mine`: the calling key, by its agent id when the registry gave one, else its name (115's holder rule).
  const holder = input.holder === "mine" ? { name: principal.name, agentId: principal.agentId } : undefined;
  // The call's own weights (SMD-4193): none given, or an empty set, is the defaults.
  const weights = input.weights && Object.keys(input.weights).length ? input.weights : undefined;
  let r: AgendaResult;
  try {
    r = await (await ctx.store()).agenda({
      scope, holder, limit: input.limit,
      includeBlocked: input.include_blocked, includeClaimed: input.include_claimed, includeProposed: input.include_proposed,
      includeStarted: input.include_started, order: input.order, ...(weights ? { weights } : {}),
    });
  } catch (e) {
    // mine on a role without the claims group (123 raises 42501): designed, so a refusal, not a fault (review pass 2).
    // Only 123's own refusal, by its words: another table's 42501 is a fault naming that table (review pass 3).
    if (holder && String((e as { errno?: unknown }).errno ?? "") === "42501" && /holder mine reads work_claims/.test(String((e as Error).message ?? ""))) {
      return refuse({ code: "CLAIMS_UNREADABLE", retryable: false });
    }
    // order due on a brain before 129, whose agendas take no tenth argument (42883): its schema's gap, refused alike
    // over both doors, not a fault (review pass 2). Only the agenda's own: another missing function stays a fault. By
    // the name alone, which lc_messages never translates, not the words around it (review pass 3).
    if (input.order === "due" && String((e as { errno?: unknown }).errno ?? "") === "42883" && /\bagenda\(/.test(String((e as Error).message ?? ""))) {
      return refuse({ code: "ORDER_UNAVAILABLE", retryable: false });
    }
    // The weights 122 refused (22023, its words naming the weight): the caller's to mend, 400, not a fault.
    const bad = weightsRefused(e, weights);
    if (bad) return refuse(bad);
    throw e;
  }
  await ctx.logAgenda(principal, { ...scope, ...(input.holder ? { holder: input.holder } : {}), include_blocked: input.include_blocked, include_claimed: input.include_claimed, include_proposed: input.include_proposed, include_started: input.include_started, order: input.order, ...(weights ? { weights } : {}) },
    input.limit, r.items.map((i) => ({ kind: i.kind, key: i.key, effective: i.effective })));
  return ok({ ...r, weights: weights ?? null });
}
