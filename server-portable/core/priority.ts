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
import { asked, readOnly, unattributedAs, writerScope } from "./caller.ts";
import { endOfDay } from "../priority-scale.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/**
 * set_priority's value: the item named, what was stated, every statement of the maker's it closed (`closed`, newest
 * first: a ticket and its own rows are one item, so there may be more than one, each on its own item; SMD-4238) and
 * the newest of them (`replaced`), and the item's winner. `winnerShown` is false for a capture-only key, which 116
 * never shows the winner (another key's statement): its null says nothing.
 */
export type SetPriorityResult = { outcome: "asserted" | "unchanged"; item: PriorityItem; assertion: PriorityAssertion; replaced: PriorityAssertion | null; closed: PriorityAssertion[]; winner: PriorityAssertion | null; winnerShown: boolean };
export type SetPriorityCode = "ITEM_NOT_FOUND" | "ITEM_NOT_YOURS" | "REFUSED_PRIORITY_INPUT" | "READ_ONLY_KEY" | "PRIORITY_UNATTRIBUTED";
/**
 * clear_priority's value: the item named, every statement of the caller's it closed (`closed`, newest first; none: it
 * had none open) and the newest of them (`assertion`), and the winner after, as set_priority's.
 */
export type ClearPriorityResult = { outcome: "cleared" | "nothing_to_clear"; item: PriorityItem; assertion: PriorityAssertion | null; closed: PriorityAssertion[]; winner: PriorityAssertion | null; winnerShown: boolean };
export type ClearPriorityCode = "REFUSED_PRIORITY_INPUT" | "READ_ONLY_KEY" | "PRIORITY_UNATTRIBUTED";
/** priority_history's value: the item as 116 normalised it, its winner and level (null: unknown, not low), and every statement in the order written. */
export type PriorityHistoryResult = PriorityRecord;
export type PriorityHistoryCode = "REFUSED_PRIORITY_INPUT" | "ITEM_NOT_FOUND";

/**
 * A time as 116 takes it, whatever the database's time zone: a time with its offset is that instant. A date alone is
 * a due time's end of that day — the next day's start in UTC (SMD-3778: due on the 1st is due by the end of the 1st) —
 * and a not_before's start of it.
 */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dueBy = (t: string | undefined) => (t === undefined ? undefined : BARE_DATE.test(t) ? endOfDay(t) : t);
const startOf = (t: string | undefined) => (t === undefined ? undefined : BARE_DATE.test(t) ? `${t}T00:00:00Z` : t);

const inputRefused = (e: PriorityRefused) => refuse({ code: "REFUSED_PRIORITY_INPUT", retryable: false, problem: e.problem, message: e.message });
/** The brain holds no such item, or no such due reference (`which`). */
const notFound = (which: "item" | "due_ref", item: PriorityItem) => refuse({ code: "ITEM_NOT_FOUND", retryable: false, which, item });

/**
 * A capture-only key's own thought is proved by the agent id its envelope carries (082, by id alone): with that id
 * not to hand because the registry did not give it, 116 would refuse the key's own thought as another's. Said as
 * that, never as ITEM_NOT_YOURS: a key told its own thought is not its own does not retry (review pass 1). Said after
 * 116/117 answer (SMD-3665 PR 2 review pass 2): a plugin's call 117 grants goes through. Asked of no item: 116 answers
 * ITEM_NOT_YOURS alike whether one exists, so it tells the key nothing about what exists. Only when the registry was asked and
 * failed (`agentUnresolved`): a principal that has no agent id by design — a plugin hook's, `hook:<plugin>` — is
 * 116's to answer, and its words are not "an operator must act" (review pass 2).
 */
const unattributed = (principal: Principal) => unattributedAs("PRIORITY_UNATTRIBUTED", principal);

/**
 * The item a refusal names and its due reference, as 116 keys them and whether the brain holds each — read with
 * 116's own functions, on the refusal's path alone (review pass 1: a copy of its normalising here drifted from it),
 * at once. A read that fails is the call's fault, not a guess at the key (review pass 2).
 */
async function keyed(ctx: Ctx, input: Input<"set_priority">) {
  const store = await ctx.store();
  return Promise.all([store.priorityItem(input.kind, input.key), input.due_ref ? store.priorityItem(input.due_ref.kind, input.due_ref.key) : null]);
}

/** A refusal 116 answered as a value: by its code, the item it is about named as 116 keys it, read only where named. */
async function refusedBy(ctx: Ctx, a: PriorityAnswer, principal: Principal, input: Input<"set_priority">) {
  switch (a.code) {
    case "ITEM_NOT_FOUND": {
      // 116 checks the item, then the due reference. Which was missing is read from the brain, not 116's words
      // (review pass 1): the due reference when it is not held and the item is — both read, so an item written
      // between 116's check and this read does not turn the item's absence into the reference's (review pass 2).
      const [item, dueRef] = await keyed(ctx, input);
      return dueRef && !dueRef.exists && item.exists ? notFound("due_ref", dueRef.item) : notFound("item", item.item);
    }
    case "ITEM_NOT_YOURS": {
      // A capture-only key whose agent id the registry did not give is told so, after 116/117 answered, never a final
      // "not yours" (SMD-3664 review pass 1). Decided after the call (SMD-3665 PR 2 review pass 2): before it, a
      // plugin's call was refused, which 117 grants for a plugin row's item without an agent id.
      const away = unattributed(principal);
      if (away) return away;
      const [item, dueRef] = await keyed(ctx, input);
      return refuse({ code: "ITEM_NOT_YOURS", retryable: false, item: item.item, dueRef: dueRef?.item ?? null });
    }
    case "READ_ONLY_KEY":
      return readOnly(principal);
  }
  throw new Error("a priority call answered refused without a code this server reads");
}

/**
 * 116 raises the same words for a malformed item and a malformed due reference ("not a thought id: …"): with a due
 * reference given, an item 116 can key means the due reference was the one refused (review pass 1: it was blamed on
 * the item's key).
 */
async function argumentRefused(ctx: Ctx, e: PriorityRefused, input: Input<"set_priority">) {
  if (input.due_ref && (e.problem === "key" || e.problem === "kind")) {
    const item = await asked(PriorityRefused, async () => (await ctx.store()).priorityItem(input.kind, input.key));
    if (!(item instanceof PriorityRefused)) return refuse({ code: "REFUSED_PRIORITY_INPUT", retryable: false, problem: "due_ref", message: e.message });
  }
  return inputRefused(e);
}

export async function setPriority(ctx: Ctx, principal: Principal, input: Input<"set_priority">, opts: { plugin?: string } = {}): Promise<Outcome<SetPriorityResult, SetPriorityCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const a = await asked(PriorityRefused, async () => (await ctx.store()).assertPriority({
    kind: input.kind, key: input.key, level: input.level, dueAt: dueBy(input.due_at), notBefore: startOf(input.not_before),
    dueRef: input.due_ref, reason: input.reason, inferred: input.inferred, actor: actorOf(ctx, principal), scope, plugin: opts.plugin,
  }));
  if (a instanceof PriorityRefused) return argumentRefused(ctx, a, input);
  if ((a.outcome === "asserted" || a.outcome === "unchanged") && a.assertion) {
    // A brain before 138 names neither: the statement is always written on the item named, and it named the newest
    // statement it closed alone.
    return ok({
      outcome: a.outcome, item: a.item ?? a.assertion.item, assertion: a.assertion, replaced: a.replaced,
      closed: a.closed ?? (a.replaced ? [a.replaced] : []), winner: a.winner, winnerShown: scope === "write",
    });
  }
  if (a.outcome === "refused") return refusedBy(ctx, a, principal, input);
  throw new Error("assert_priority answered an outcome this server does not read");
}

export async function clearPriority(ctx: Ctx, principal: Principal, input: Input<"clear_priority">): Promise<Outcome<ClearPriorityResult, ClearPriorityCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const a = await asked(PriorityRefused, async () => (await ctx.store()).clearPriority({ kind: input.kind, key: input.key, actor: actorOf(ctx, principal), scope }));
  if (a instanceof PriorityRefused) return inputRefused(a);
  // Run first: 116 finds a key's statements by the registry's id for its name too (ob1_priority_actor), so a clear may
  // close one without the envelope's id. One that closed nothing then is unattributed: a key renamed since the
  // registry last saw it is found by neither id (review pass 3: "nothing to clear" for a statement still open).
  const away = a.outcome === "nothing_to_clear" ? unattributed(principal) : null;
  if (away) return away;
  if (a.outcome === "cleared" || a.outcome === "nothing_to_clear") {
    // A brain before 138 names neither: the item is keyed by 116's own function, read for it alone, and the newest
    // statement closed was the only one named. That read follows a clear that has landed, so its failure, the
    // store's included, is no fault of the clear's (review passes 1 and 3): the item is then the caller's words as
    // given, the item asked, never the closed statement's, which may stand on the ticket's row.
    const item = a.item ?? await ctx.store().then((s) => s.priorityItem(input.kind, input.key)).then((r) => r.item,
      () => ({ kind: input.kind, key: input.key }));
    return ok({ outcome: a.outcome, item, assertion: a.assertion, closed: a.closed ?? (a.assertion ? [a.assertion] : []), winner: a.winner, winnerShown: scope === "write" });
  }
  if (a.outcome === "refused" && a.code === "READ_ONLY_KEY") return readOnly(principal);
  throw new Error("clear_priority answered an outcome this server does not read");
}

export async function priorityHistory(ctx: Ctx, _principal: Principal, input: Input<"priority_history">): Promise<Outcome<PriorityHistoryResult, PriorityHistoryCode>> {
  const r = await asked(PriorityRefused, async () => (await ctx.store()).priorityRecord(input.kind, input.key));
  if (r instanceof PriorityRefused) return inputRefused(r);
  // An item the brain does not hold, and nobody stated a priority on, is refused by name; one deleted since a
  // statement keeps its record (116's section 8), said with `exists: false`. A read key's: no capture key reads this.
  if (!r.exists && !r.history.length) return notFound("item", r.item);
  return ok(r);
}
