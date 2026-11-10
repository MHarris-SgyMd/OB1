// The agenda (SMD-3669, SMD-4162): what matters now, as one read of migration
// 124's agenda — open, startable, unclaimed, unstarted tickets and open items
// in a scope, ranked by 122's effective priority, each with the terms behind
// its place, and what was left out and why. A read: the database decides the
// candidates, the filters and the order; this file turns the caller's
// arguments into the call, passes the calling key for `mine`, answers the
// agenda's refusal of `mine` (123's words, kept by 124) as CLAIMS_UNREADABLE, and writes the call's query_log row.

import type { Principal } from "../auth.ts";
import type { AgendaResult } from "../store.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";

export type { AgendaResult };
export type AgendaCode = "CLAIMS_UNREADABLE";

export async function agenda(ctx: Ctx, principal: Principal, input: Input<"agenda">): Promise<Outcome<AgendaResult, AgendaCode>> {
  const scope: { source?: string; project?: string; label?: string } = {};
  if (input.source !== undefined) scope.source = input.source;
  if (input.project !== undefined) scope.project = input.project;
  if (input.label !== undefined) scope.label = input.label;
  // `mine`: the calling key, by its agent id when the registry gave one, else its name (115's holder rule).
  const holder = input.holder === "mine" ? { name: principal.name, agentId: principal.agentId } : undefined;
  let r: AgendaResult;
  try {
    r = await (await ctx.store()).agenda({
      scope, holder, limit: input.limit,
      includeBlocked: input.include_blocked, includeClaimed: input.include_claimed, includeProposed: input.include_proposed,
      includeStarted: input.include_started, order: input.order,
    });
  } catch (e) {
    // mine on a role without the claims group (123 raises 42501): designed, so a refusal, not a fault (review pass 2).
    // Only 123's own refusal, by its words: another table's 42501 is a fault naming that table (review pass 3).
    if (holder && String((e as { errno?: unknown }).errno ?? "") === "42501" && /holder mine reads work_claims/.test(String((e as Error).message ?? ""))) {
      return refuse({ code: "CLAIMS_UNREADABLE", retryable: false });
    }
    throw e;
  }
  await ctx.logAgenda(principal, { ...scope, ...(input.holder ? { holder: input.holder } : {}), include_blocked: input.include_blocked, include_claimed: input.include_claimed, include_proposed: input.include_proposed, include_started: input.include_started, order: input.order },
    input.limit, r.items.map((i) => ({ kind: i.kind, key: i.key, effective: i.effective })));
  return ok(r);
}
