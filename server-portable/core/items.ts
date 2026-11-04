// Open items (SMD-3665 PR 2): migration 117's calls as operations of the core,
// so the REST core and the MCP server answer them alike, and a plugin reaches
// them through ctx.call as its caller. The database decides every rule — the
// maker from the key, who may open and change which item, the same item again,
// a proposed close never accepted by its proposer — and this file passes the
// caller's envelope (its scope stated, and the plugin a ctx.call came through),
// and turns 117's answers into values and refusals. The writers are the
// capture group's, as set_priority is (a capture-only key on its own items,
// and a plugin hook on its rows'); item_history and list_items are reads.

import type { Principal } from "../auth.ts";
import { ItemRefused, ITEM_STATUSES, type ItemAnswer, type ItemListRow, type ItemProposal, type ItemRecord, type ItemStatus, type OpenItem, type OpenItemEvent } from "../open-items.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import { actorOf } from "./writes.ts";

/** What a call needs beyond the principal and its input: the plugin a ctx.call came through, which 117 reads off the envelope alone. */
export type ItemCallOptions = { plugin?: string };

type WriteCode = "READ_ONLY_KEY" | "ITEM_NOT_YOURS" | "ITEM_NOT_FOUND" | "ITEM_UNATTRIBUTED" | "REFUSED_ITEM_INPUT";

/** open_item's value: the item opened, or the one that is there (null: a capture-only key may not be shown it), and a note when it stands otherwise than asked. */
export type OpenItemResult = { outcome: "opened" | "unchanged"; item: OpenItem | null; event: OpenItemEvent | null; note: string | null };
export type OpenItemCode = Exclude<WriteCode, "ITEM_NOT_FOUND"> | "ORIGIN_NOT_FOUND" | "ITEM_UNOWNABLE";
export type UpdateItemResult = { outcome: "updated" | "unchanged"; item: OpenItem; event: OpenItemEvent | null };
export type UpdateItemCode = WriteCode;
/** set_item_status's value, and how many pending proposals settling the item mooted. */
export type SetItemStatusResult = { outcome: "changed" | "unchanged"; item: OpenItem; event: OpenItemEvent | null; mooted: number };
export type SetItemStatusCode = WriteCode | "CONFIRM_NOT_YOURS";
/** propose_item_close's value: the proposal, the proposer's earlier one it withdrew, and the item it is on. */
export type ProposeItemCloseResult = { outcome: "proposed" | "unchanged"; proposal: ItemProposal; replaced: ItemProposal | null; item: OpenItem };
export type ProposeItemCloseCode = WriteCode | "EVIDENCE_NOT_FOUND" | "ITEM_SETTLED";
export type DecideItemCloseResult = { outcome: "accepted" | "rejected"; proposal: ItemProposal; item: OpenItem; event: OpenItemEvent | null };
export type DecideItemCloseCode = Exclude<WriteCode, "ITEM_NOT_FOUND"> | "PROPOSAL_NOT_FOUND" | "PROPOSAL_DECIDED" | "PROPOSAL_YOURS" | "ITEM_NOT_FOUND";
/** item_history's value: the item as it stands, every event and every proposed close, in the order written. */
export type ItemHistoryResult = ItemRecord & { item: OpenItem };
export type ItemHistoryCode = "ITEM_NOT_FOUND" | "REFUSED_ITEM_INPUT";
export type ListItemsResult = { items: ItemListRow[]; truncated: boolean };
export type ListItemsCode = "REFUSED_ITEM_INPUT";

/** The scope 117 reads off the envelope, as 116's: `write`, `capture`, or none (a read key's, which 117 refuses). */
const writerScope = (principal: Principal): "write" | "capture" | undefined =>
  principal.scope === "write" ? "write" : principal.scope === "capture" ? "capture" : undefined;

/** A store call, or the argument 117 refused by raising; any other throw stays a fault. */
async function asked<T>(run: () => Promise<T>): Promise<T | ItemRefused> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ItemRefused) return e;
    throw e;
  }
}
const inputRefused = (e: ItemRefused) => refuse({ code: "REFUSED_ITEM_INPUT", retryable: false, problem: e.problem, message: e.message });
const readOnly = (principal: Principal) => refuse({ code: "READ_ONLY_KEY", retryable: false, key: principal.name });
const itemRef = (id: string) => ({ kind: "item" as const, key: id.trim().toLowerCase() });

/**
 * A capture-only key's own items are proved by the agent id its envelope carries: with that id not to hand because
 * the registry did not give it, 117 would refuse the key's own item as another's, or refuse to open one. Said as that,
 * before the call (set_priority's rule, SMD-3664 review pass 1); a principal with no agent id by design — a plugin
 * hook's — is 117's to answer, and so is any call through a plugin (review pass 1: a plugin row's item is the
 * plugin's, which 117 grants without an agent id, and this refused it first).
 */
function unattributed(principal: Principal) {
  if (principal.agentId !== undefined || principal.agentUnresolved === undefined) return null;
  return principal.agentUnresolved === "unreachable"
    ? refuse({ code: "ITEM_UNATTRIBUTED", retryable: true, cause: "registry_away" })
    : refuse({ code: "ITEM_UNATTRIBUTED", retryable: false, cause: principal.agentUnresolved === "misconfigured" ? "registry_misconfigured" : "registry_refused" });
}

/**
 * A refusal 117 answered as a value, by its code, named by what the caller passed: the item's id, the thought, the
 * proposal. `named` is the item (or, for open_item, the origin thought) ITEM_NOT_YOURS speaks of; null for a proposal
 * a capture-only key may not decide, which names no item it may be told of.
 */
function refusedBy(a: ItemAnswer, principal: Principal, named: { kind: "item" | "thought"; key: string } | null, ids: { item?: string; thought?: string; proposal?: string }) {
  switch (a.code) {
    case "READ_ONLY_KEY": return readOnly(principal);
    case "ITEM_NOT_YOURS": return refuse({ code: "ITEM_NOT_YOURS", retryable: false, item: named, dueRef: null });
    // decide_item_close names a proposal, not an item: a proposal whose item the brain no longer holds is said as
    // not found by its own id (review pass 1: it named an empty key).
    case "ITEM_NOT_FOUND": return ids.item ? refuse({ code: "ITEM_NOT_FOUND", retryable: false, which: "item", item: itemRef(ids.item) }) : refuse({ code: "PROPOSAL_NOT_FOUND", retryable: false, proposal: ids.proposal ?? "" });
    // A caller with no agent id by design is told so as final (403), not as a registry's outage (review pass 1).
    case "ITEM_UNATTRIBUTED": return unattributed(principal) ?? refuse({ code: "ITEM_UNOWNABLE", retryable: false });
    case "ORIGIN_NOT_FOUND": return refuse({ code: "ORIGIN_NOT_FOUND", retryable: false, thought: ids.thought ?? "" });
    case "EVIDENCE_NOT_FOUND": return refuse({ code: "EVIDENCE_NOT_FOUND", retryable: false, thought: ids.thought ?? "" });
    case "ITEM_SETTLED": return refuse({ code: "ITEM_SETTLED", retryable: false, item: a.item?.id ?? ids.item ?? "", status: a.item?.status === "dropped" ? "dropped" : "done" });
    case "PROPOSAL_NOT_FOUND": return refuse({ code: "PROPOSAL_NOT_FOUND", retryable: false, proposal: ids.proposal ?? "" });
    case "PROPOSAL_DECIDED": return refuse({ code: "PROPOSAL_DECIDED", retryable: false, proposal: ids.proposal ?? "", decision: a.proposal?.decision ?? "moot" });
    case "PROPOSAL_YOURS": return refuse({ code: "PROPOSAL_YOURS", retryable: false, proposal: ids.proposal ?? "" });
    case "CONFIRM_NOT_YOURS": return refuse({ code: "CONFIRM_NOT_YOURS", retryable: false, item: a.item?.id ?? ids.item ?? "" });
  }
  throw new Error("an item call answered refused without a code this server reads");
}

export async function openItem(ctx: Ctx, principal: Principal, input: Input<"open_item">, opts: ItemCallOptions = {}): Promise<Outcome<OpenItemResult, OpenItemCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const away = scope === "capture" && opts.plugin === undefined ? unattributed(principal) : null;
  if (away) return away;
  const a = await asked(async () => (await ctx.store()).openItem({
    text: input.text, owner: input.owner, dueAt: input.due_at, originThought: input.origin_thought, pluginRow: input.plugin_row, proposed: input.proposed,
    actor: actorOf(ctx, principal), scope, plugin: opts.plugin,
  }));
  if (a instanceof ItemRefused) return inputRefused(a);
  if (a.outcome === "opened" || a.outcome === "unchanged") return ok({ outcome: a.outcome, item: a.item, event: a.event, note: a.message });
  if (a.outcome === "refused") return refusedBy(a, principal, input.origin_thought ? { kind: "thought", key: input.origin_thought.toLowerCase() } : null, { thought: input.origin_thought }) as Outcome<OpenItemResult, OpenItemCode>;
  throw new Error("open_item answered an outcome this server does not read");
}

export async function updateItem(ctx: Ctx, principal: Principal, input: Input<"update_item">, opts: ItemCallOptions = {}): Promise<Outcome<UpdateItemResult, UpdateItemCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const away = scope === "capture" && opts.plugin === undefined ? unattributed(principal) : null;
  if (away) return away;
  const a = await asked(async () => (await ctx.store()).updateItem({
    id: input.id, changes: { text: input.text, owner: input.owner, dueAt: input.due_at }, actor: actorOf(ctx, principal), scope, plugin: opts.plugin,
  }));
  if (a instanceof ItemRefused) return inputRefused(a);
  if ((a.outcome === "updated" || a.outcome === "unchanged") && a.item) return ok({ outcome: a.outcome, item: a.item, event: a.event });
  if (a.outcome === "refused") return refusedBy(a, principal, itemRef(input.id), { item: input.id }) as Outcome<UpdateItemResult, UpdateItemCode>;
  throw new Error("update_item answered an outcome this server does not read");
}

export async function setItemStatus(ctx: Ctx, principal: Principal, input: Input<"set_item_status">, opts: ItemCallOptions = {}): Promise<Outcome<SetItemStatusResult, SetItemStatusCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const away = scope === "capture" && opts.plugin === undefined ? unattributed(principal) : null;
  if (away) return away;
  const a = await asked(async () => (await ctx.store()).setItemStatus({ id: input.id, status: input.status, reason: input.reason, actor: actorOf(ctx, principal), scope, plugin: opts.plugin }));
  if (a instanceof ItemRefused) return inputRefused(a);
  if ((a.outcome === "changed" || a.outcome === "unchanged") && a.item) return ok({ outcome: a.outcome, item: a.item, event: a.event, mooted: a.mooted });
  if (a.outcome === "refused") return refusedBy(a, principal, itemRef(input.id), { item: input.id }) as Outcome<SetItemStatusResult, SetItemStatusCode>;
  throw new Error("set_item_status answered an outcome this server does not read");
}

export async function proposeItemClose(ctx: Ctx, principal: Principal, input: Input<"propose_item_close">, opts: ItemCallOptions = {}): Promise<Outcome<ProposeItemCloseResult, ProposeItemCloseCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const away = scope === "capture" && opts.plugin === undefined ? unattributed(principal) : null;
  if (away) return away;
  const a = await asked(async () => (await ctx.store()).proposeItemClose({
    id: input.id, status: input.status, evidenceThought: input.evidence_thought, label: input.label, reason: input.reason, actor: actorOf(ctx, principal), scope, plugin: opts.plugin,
  }));
  if (a instanceof ItemRefused) return inputRefused(a);
  if ((a.outcome === "proposed" || a.outcome === "unchanged") && a.proposal && a.item) return ok({ outcome: a.outcome, proposal: a.proposal, replaced: a.replaced, item: a.item });
  if (a.outcome === "refused") return refusedBy(a, principal, itemRef(input.id), { item: input.id, thought: input.evidence_thought }) as Outcome<ProposeItemCloseResult, ProposeItemCloseCode>;
  throw new Error("propose_item_close answered an outcome this server does not read");
}

export async function decideItemClose(ctx: Ctx, principal: Principal, input: Input<"decide_item_close">, opts: ItemCallOptions = {}): Promise<Outcome<DecideItemCloseResult, DecideItemCloseCode>> {
  const scope = writerScope(principal);
  if (!scope) return readOnly(principal);
  const away = scope === "capture" && opts.plugin === undefined ? unattributed(principal) : null;
  if (away) return away;
  const a = await asked(async () => (await ctx.store()).decideItemClose({ proposal: input.id, accept: input.accept, reason: input.reason, actor: actorOf(ctx, principal), scope, plugin: opts.plugin }));
  if (a instanceof ItemRefused) return inputRefused(a);
  if ((a.outcome === "accepted" || a.outcome === "rejected") && a.proposal && a.item) return ok({ outcome: a.outcome, proposal: a.proposal, item: a.item, event: a.event });
  if (a.outcome === "refused") return refusedBy(a, principal, null, { proposal: input.id }) as Outcome<DecideItemCloseResult, DecideItemCloseCode>;
  throw new Error("decide_item_close answered an outcome this server does not read");
}

export async function itemHistory(ctx: Ctx, _principal: Principal, input: Input<"item_history">): Promise<Outcome<ItemHistoryResult, ItemHistoryCode>> {
  const r = await asked(async () => (await ctx.store()).itemHistory(input.id));
  if (r instanceof ItemRefused) return inputRefused(r);
  if (!r.item) return refuse({ code: "ITEM_NOT_FOUND", retryable: false, which: "item", item: itemRef(input.id) });
  return ok({ ...r, item: r.item });
}

/** list_items' `status` word as the statuses it reads. */
const STATUS_WORDS: Record<NonNullable<Input<"list_items">["status"]>, ItemStatus[]> = {
  open: ["open"], proposed: ["proposed"], done: ["done"], dropped: ["dropped"],
  unsettled: ["proposed", "open"], settled: ["done", "dropped"], all: [...ITEM_STATUSES],
};

export async function listItems(ctx: Ctx, _principal: Principal, input: Input<"list_items">): Promise<Outcome<ListItemsResult, ListItemsCode>> {
  // No status given: open, or with overdue alone unsettled — an overdue item may be a proposed one (review pass 1).
  const status = input.status ?? (input.overdue === true ? "unsettled" : "open");
  const r = await asked(async () => (await ctx.store()).listItems({
    statuses: STATUS_WORDS[status], overdue: input.overdue === true, originThought: input.origin_thought, plugin: input.plugin, limit: input.limit,
  }));
  if (r instanceof ItemRefused) return inputRefused(r);
  return ok(r);
}
