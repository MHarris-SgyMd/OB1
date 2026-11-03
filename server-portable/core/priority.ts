// Priority assertions (SMD-3664): migration 116's calls (SMD-3663) as operations
// of the core, so the REST core and the MCP server answer them alike. The
// database decides every rule — the maker and its tier from the key, who may
// state a priority on what, the winner — and this file passes the caller's
// envelope, its scope stated, and turns 116's answers into values and
// refusals. A capture-only key reaches set_priority and clear_priority (the
// capture group, decision 10: on a thought it captured) and never
// priority_history, a read: 116's reads take no actor and show every key's
// statements, reasons included.

import type { Principal } from "../auth.ts";
import { PriorityRefused, type PriorityAnswer, type PriorityAssertion, type PriorityItem, type PriorityRecord } from "../store.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/**
 * set_priority's value: what was stated, the maker's statement it replaced, and the item's winner. `winnerShown` is
 * false for a capture-only key, which 116 never shows the winner (another key's statement): its null says nothing.
 */
export type SetPriorityResult = { outcome: "asserted" | "unchanged"; assertion: PriorityAssertion; replaced: PriorityAssertion | null; winner: PriorityAssertion | null; winnerShown: boolean };
export type SetPriorityCode = "ITEM_NOT_FOUND" | "ITEM_NOT_YOURS" | "REFUSED_PRIORITY_INPUT" | "READ_ONLY_KEY";
/** clear_priority's value: the caller's statement it closed (none: it had none open), and the winner after, as set_priority's. */
export type ClearPriorityResult = { outcome: "cleared" | "nothing_to_clear"; assertion: PriorityAssertion | null; winner: PriorityAssertion | null; winnerShown: boolean };
export type ClearPriorityCode = "REFUSED_PRIORITY_INPUT" | "READ_ONLY_KEY";
/** priority_history's value: the item as 116 normalised it, its winner and level (null: unknown, not low), and every statement in the order written. */
export type PriorityHistoryResult = PriorityRecord;
export type PriorityHistoryCode = "REFUSED_PRIORITY_INPUT" | "ITEM_NOT_FOUND";

/**
 * The scope 116 reads off the envelope: `write` for a write key, `capture` for a capture-only key. A read key states
 * none, and 116 refuses it (READ_ONLY_KEY); the manifest gives a read key neither writer, so that is a caller of the
 * core's own (a plugin's ctx.call under a read key's principal) meeting the database's rule.
 */
const scopeOf = (principal: Principal): "write" | "capture" | undefined =>
  principal.scope === "write" ? "write" : principal.scope === "capture" ? "capture" : undefined;

/**
 * A date alone is the start of that day in UTC, so `2027-03-01` means one instant whatever the database's time
 * zone; a time with its offset is that instant.
 */
const instant = (t: string | undefined) => (t === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);

/** A store call, or the argument 116 refused by raising; any other throw stays a fault. */
async function asked<T>(run: () => Promise<T>): Promise<T | PriorityRefused> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PriorityRefused) return e;
    throw e;
  }
}
const inputRefused = (e: PriorityRefused) => refuse({ code: "REFUSED_PRIORITY_INPUT", retryable: false, problem: e.problem, message: e.message });

/**
 * The item a refusal names: as the caller gave it, its kind lower-cased and a ticket's key upper-cased, as 116 keys
 * them — 116's refusal carries its words, not the item. The caller's own input, so it tells a capture-only key
 * nothing about what exists.
 */
const itemOf = (kind: string, key: string): PriorityItem => {
  const k = kind.trim().toLowerCase() as PriorityItem["kind"];
  return { kind: k, key: k === "ticket" ? key.trim().toUpperCase() : key.trim().toLowerCase() };
};

/** A refusal 116 answered as a value: by its code, the item it is about named. */
function refusedBy(a: PriorityAnswer, principal: Principal, item: PriorityItem, dueRef: PriorityItem | undefined) {
  switch (a.code) {
    case "ITEM_NOT_FOUND": {
      // 116 checks the item, then the due reference, and words which it was.
      const which = /^the due reference\b/.test(a.message ?? "") && dueRef ? "due_ref" : "item";
      return refuse({ code: "ITEM_NOT_FOUND", retryable: false, which, item: which === "due_ref" ? dueRef! : item, openItem: (which === "due_ref" ? dueRef! : item).kind === "item" });
    }
    case "ITEM_NOT_YOURS":
      return refuse({ code: "ITEM_NOT_YOURS", retryable: false, item, dueRef: dueRef ?? null });
    case "READ_ONLY_KEY":
      return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  }
  throw new Error("a priority call answered refused without a code this server reads");
}

export async function setPriority(ctx: Ctx, principal: Principal, input: Input<"set_priority">): Promise<Outcome<SetPriorityResult, SetPriorityCode>> {
  const item = itemOf(input.kind, input.key);
  const dueRef = input.due_ref ? itemOf(input.due_ref.kind, input.due_ref.key) : undefined;
  const scope = scopeOf(principal);
  if (!scope) return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  const a = await asked(async () => (await ctx.store()).assertPriority({
    kind: input.kind, key: input.key, level: input.level, dueAt: instant(input.due_at), notBefore: instant(input.not_before),
    dueRef: input.due_ref, reason: input.reason, inferred: input.inferred, actor: actorOf(ctx, principal), scope,
  }));
  if (a instanceof PriorityRefused) return inputRefused(a);
  if ((a.outcome === "asserted" || a.outcome === "unchanged") && a.assertion) {
    return ok({ outcome: a.outcome, assertion: a.assertion, replaced: a.replaced, winner: a.winner, winnerShown: scope === "write" });
  }
  if (a.outcome === "refused") return refusedBy(a, principal, item, dueRef);
  throw new Error("assert_priority answered an outcome this server does not read");
}

export async function clearPriority(ctx: Ctx, principal: Principal, input: Input<"clear_priority">): Promise<Outcome<ClearPriorityResult, ClearPriorityCode>> {
  const scope = scopeOf(principal);
  if (!scope) return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  const a = await asked(async () => (await ctx.store()).clearPriority({ kind: input.kind, key: input.key, actor: actorOf(ctx, principal), scope }));
  if (a instanceof PriorityRefused) return inputRefused(a);
  if (a.outcome === "cleared" || a.outcome === "nothing_to_clear") return ok({ outcome: a.outcome, assertion: a.assertion, winner: a.winner, winnerShown: scope === "write" });
  if (a.outcome === "refused" && a.code === "READ_ONLY_KEY") return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  throw new Error("clear_priority answered an outcome this server does not read");
}

export async function priorityHistory(ctx: Ctx, _principal: Principal, input: Input<"priority_history">): Promise<Outcome<PriorityHistoryResult, PriorityHistoryCode>> {
  const r = await asked(async () => (await ctx.store()).priorityRecord(input.kind, input.key));
  if (r instanceof PriorityRefused) return inputRefused(r);
  // An item the brain does not hold, and nobody stated a priority on, is refused by name; one deleted since a
  // statement keeps its record (116's section 8), said with `exists: false`. A read key's: no capture key reads this.
  if (!r.exists && !r.history.length) return refuse({ code: "ITEM_NOT_FOUND", retryable: false, which: "item", item: r.item, openItem: r.item.kind === "item" });
  return ok(r);
}
