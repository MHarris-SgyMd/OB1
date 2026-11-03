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
export type SetPriorityCode = "ITEM_NOT_FOUND" | "ITEM_NOT_YOURS" | "REFUSED_PRIORITY_INPUT" | "READ_ONLY_KEY" | "PRIORITY_UNATTRIBUTED";
/** clear_priority's value: the caller's statement it closed (none: it had none open), and the winner after, as set_priority's. */
export type ClearPriorityResult = { outcome: "cleared" | "nothing_to_clear"; assertion: PriorityAssertion | null; winner: PriorityAssertion | null; winnerShown: boolean };
export type ClearPriorityCode = "REFUSED_PRIORITY_INPUT" | "READ_ONLY_KEY" | "PRIORITY_UNATTRIBUTED";
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
 * A capture-only key's own thought is proved by the agent id its envelope carries (082, by id alone): with that id
 * not to hand — the registry away or set up wrong — 116 would refuse the key's own thought as another's, and clear
 * nothing it made under the id. Said as that, before the call, never as ITEM_NOT_YOURS: a key told its own thought
 * is not its own does not retry (review pass 1). Asked of no item, so it tells the key nothing about what exists.
 */
const unattributed = (principal: Principal) =>
  principal.agentUnresolved === "unreachable"
    ? refuse({ code: "PRIORITY_UNATTRIBUTED", retryable: true, cause: "registry_away" })
    : refuse({ code: "PRIORITY_UNATTRIBUTED", retryable: false, cause: principal.agentUnresolved === "misconfigured" ? "registry_misconfigured" : principal.agentUnresolved === "refused" ? "registry_refused" : "registry_unknown" });

/**
 * The item a refusal names, as 116 keys it and whether the brain holds it — read with 116's own functions, on the
 * refusal's path alone (review pass 1: a copy of its normalising here drifted from it). Null when it cannot be read.
 */
async function keyed(ctx: Ctx, kind: string, key: string): Promise<{ item: PriorityItem; exists: boolean } | null> {
  try { return await (await ctx.store()).priorityItem(kind, key); } catch { return null; }
}

/** A refusal 116 answered as a value: by its code, the item it is about named as 116 keys it. */
async function refusedBy(ctx: Ctx, a: PriorityAnswer, principal: Principal, input: Input<"set_priority">) {
  const item = await keyed(ctx, input.kind, input.key);
  const dueRef = input.due_ref ? await keyed(ctx, input.due_ref.kind, input.due_ref.key) : null;
  // Read unkeyed (a fault on the refusal's path): the caller's own words, trimmed, rather than a fault for the refusal.
  const asGiven = (k: string, key: string): PriorityItem => ({ kind: k.trim().toLowerCase() as PriorityItem["kind"], key: key.trim() });
  const itemNamed = item?.item ?? asGiven(input.kind, input.key);
  switch (a.code) {
    case "ITEM_NOT_FOUND": {
      // 116 checks the item, then the due reference: a held item means the due reference was the one missing — read
      // from the brain, not from 116's words (review pass 1).
      const which = input.due_ref && item?.exists === true ? "due_ref" : "item";
      const named = which === "due_ref" ? dueRef?.item ?? asGiven(input.due_ref!.kind, input.due_ref!.key) : itemNamed;
      return refuse({ code: "ITEM_NOT_FOUND", retryable: false, which, item: named, openItem: named.kind === "item" });
    }
    case "ITEM_NOT_YOURS":
      return refuse({ code: "ITEM_NOT_YOURS", retryable: false, item: itemNamed, dueRef: input.due_ref ? dueRef?.item ?? asGiven(input.due_ref.kind, input.due_ref.key) : null });
    case "READ_ONLY_KEY":
      return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  }
  throw new Error("a priority call answered refused without a code this server reads");
}

/**
 * 116 raises the same words for a malformed item and a malformed due reference ("not a thought id: …"): with a due
 * reference given, an item 116 can key means the due reference was the one refused (review pass 1: it was blamed on
 * the item's key).
 */
async function argumentRefused(ctx: Ctx, e: PriorityRefused, input: Input<"set_priority">) {
  if (input.due_ref && (e.problem === "key" || e.problem === "kind") && (await keyed(ctx, input.kind, input.key)) !== null) {
    return refuse({ code: "REFUSED_PRIORITY_INPUT", retryable: false, problem: "due_ref", message: e.message });
  }
  return inputRefused(e);
}

export async function setPriority(ctx: Ctx, principal: Principal, input: Input<"set_priority">): Promise<Outcome<SetPriorityResult, SetPriorityCode>> {
  const scope = scopeOf(principal);
  if (!scope) return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  if (scope === "capture" && principal.agentId === undefined) return unattributed(principal);
  const a = await asked(async () => (await ctx.store()).assertPriority({
    kind: input.kind, key: input.key, level: input.level, dueAt: instant(input.due_at), notBefore: instant(input.not_before),
    dueRef: input.due_ref, reason: input.reason, inferred: input.inferred, actor: actorOf(ctx, principal), scope,
  }));
  if (a instanceof PriorityRefused) return argumentRefused(ctx, a, input);
  if ((a.outcome === "asserted" || a.outcome === "unchanged") && a.assertion) {
    return ok({ outcome: a.outcome, assertion: a.assertion, replaced: a.replaced, winner: a.winner, winnerShown: scope === "write" });
  }
  if (a.outcome === "refused") return refusedBy(ctx, a, principal, input);
  throw new Error("assert_priority answered an outcome this server does not read");
}

export async function clearPriority(ctx: Ctx, principal: Principal, input: Input<"clear_priority">): Promise<Outcome<ClearPriorityResult, ClearPriorityCode>> {
  const scope = scopeOf(principal);
  if (!scope) return refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
  // Its statements were made under its agent id: without it, 116 would answer nothing to clear.
  if (scope === "capture" && principal.agentId === undefined) return unattributed(principal);
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
