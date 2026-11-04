// Open items (SMD-3665 PR 2): migration 117's answers as the store's values.
// The database decides every rule — who may open, change and close an item,
// the same item again, a proposal never accepted by its proposer — and these
// readers hold its jsonb to the shapes the server shows, a row that is not one
// refused by name. In a file of its own, as priority-kinds.ts is, so the
// store's long file gains only its re-exports.

import { isoTimestamp } from "./store.ts";

export const ITEM_STATUSES = ["proposed", "open", "done", "dropped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** One open item as 117's ob1_item_json answers it: its state, where it came from, who opened it. Nothing in it proves a key. */
export type OpenItem = {
  id: string;
  status: ItemStatus;
  text: string;
  owner: string | null;
  dueAt: string | null;
  originThoughtId: string | null;
  plugin: { name: string; row: string } | null;
  notedAt: string;
  openedAt: string;
  openedBy: { name: string; agentId: string | null; trust: string | null; scope: string | null };
  changedAt: string;
  closedAt: string | null;
};
/** One event as 117's ob1_item_event_json answers it: the item's state after it, its maker, its reason. */
export type OpenItemEvent = {
  id: string;
  itemId: string;
  event: "opened" | "updated" | "status";
  status: ItemStatus;
  text: string;
  owner: string | null;
  dueAt: string | null;
  reason: string | null;
  proposalId: string | null;
  maker: { name: string; agentId: string | null; kind: string | null; trust: string | null; scope: string | null };
  at: string;
};
/** One proposed close as 117's ob1_item_proposal_json answers it. */
export type ItemProposal = {
  id: string;
  itemId: string;
  status: "done" | "dropped";
  evidenceThoughtId: string | null;
  label: string | null;
  reason: string | null;
  proposer: { name: string; agentId: string | null; trust: string | null; scope: string | null };
  proposedAt: string;
  decision: "accepted" | "rejected" | "moot" | null;
  decidedAt: string | null;
  decider: { name: string; agentId: string | null } | null;
  decisionReason: string | null;
};
/** The refusal codes 117's writers answer with. */
export const ITEM_REFUSAL_CODES = [
  "READ_ONLY_KEY", "ITEM_NOT_YOURS", "ITEM_NOT_FOUND", "ITEM_UNATTRIBUTED", "ORIGIN_NOT_FOUND", "EVIDENCE_NOT_FOUND",
  "ITEM_SETTLED", "PROPOSAL_NOT_FOUND", "PROPOSAL_DECIDED", "PROPOSAL_YOURS", "CONFIRM_NOT_YOURS",
] as const;
export type ItemRefusalCode = (typeof ITEM_REFUSAL_CODES)[number];
/** One of 117's writers' jsonb answers, read: every writer's outcome shares it, each filling the fields it answers. */
export type ItemAnswer = {
  outcome: "opened" | "updated" | "changed" | "unchanged" | "proposed" | "accepted" | "rejected" | "refused";
  code: ItemRefusalCode | null;
  /** The database's words: a refusal's, or an unchanged open's note that the item stands otherwise than asked. */
  message: string | null;
  item: OpenItem | null;
  event: OpenItemEvent | null;
  proposal: ItemProposal | null;
  replaced: ItemProposal | null;
  mooted: number;
};
/** One item's record (117's open_item_history): the item as it stands (null: the brain holds no such id), every event and proposal in the order written. */
export type ItemRecord = { item: OpenItem | null; events: OpenItemEvent[]; proposals: ItemProposal[] };
/** One row of list_items: the item, whether it is overdue now (open or proposed, due before the read), and how many closes wait on it. */
export type ItemListRow = OpenItem & { overdue: boolean; pendingProposals: number };

/**
 * An argument 117 refused by raising (SQLSTATE 22023: a malformed id, a due time that is not ISO 8601, a text past
 * its length, a status of no kind), told by its message, the database's words. Any other raise stays the store's fault.
 */
export class ItemRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemRefused";
  }
}

const OUTCOMES = new Set(["opened", "updated", "changed", "unchanged", "proposed", "accepted", "rejected", "refused"]);
const CODES = new Set<string>(ITEM_REFUSAL_CODES);
const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const time = (v: unknown): string | null => (v === null || v === undefined ? null : isoTimestamp(v as string | Date));

/** One item from 117's ob1_item_json; a row that is not one throws, naming the call and nothing of the row. */
export function normaliseOpenItem(r: unknown, what: string): OpenItem {
  const o = obj(r);
  const by = obj(o?.opened_by);
  const plugin = obj(o?.plugin);
  if (!o || !by || typeof o.id !== "string" || !(ITEM_STATUSES as readonly unknown[]).includes(o.status) || typeof o.text !== "string"
      || typeof by.name !== "string" || o.noted_at == null || o.opened_at == null || o.changed_at == null
      || (o.plugin != null && (!plugin || typeof plugin.name !== "string" || typeof plugin.row !== "string"))) {
    throw new Error(`${what} answered an item this server cannot read`);
  }
  return {
    id: o.id, status: o.status as ItemStatus, text: o.text, owner: text(o.owner), dueAt: time(o.due_at), originThoughtId: text(o.origin_thought_id),
    plugin: plugin ? { name: plugin.name as string, row: plugin.row as string } : null,
    notedAt: time(o.noted_at) as string, openedAt: time(o.opened_at) as string,
    openedBy: { name: by.name, agentId: text(by.agent_id), trust: text(by.trust), scope: text(by.scope) },
    changedAt: time(o.changed_at) as string, closedAt: time(o.closed_at),
  };
}

/** One event from 117's ob1_item_event_json. */
export function normaliseItemEvent(r: unknown, what: string): OpenItemEvent {
  const o = obj(r);
  const m = obj(o?.maker);
  if (!o || !m || typeof o.id !== "string" || typeof o.item_id !== "string" || !["opened", "updated", "status"].includes(o.event as string)
      || !(ITEM_STATUSES as readonly unknown[]).includes(o.status) || typeof o.text !== "string" || typeof m.name !== "string" || o.at == null) {
    throw new Error(`${what} answered an event this server cannot read`);
  }
  return {
    id: o.id, itemId: o.item_id, event: o.event as OpenItemEvent["event"], status: o.status as ItemStatus, text: o.text,
    owner: text(o.owner), dueAt: time(o.due_at), reason: text(o.reason), proposalId: text(o.proposal_id),
    maker: { name: m.name, agentId: text(m.agent_id), kind: text(m.kind), trust: text(m.trust), scope: text(m.scope) },
    at: time(o.at) as string,
  };
}

/** One proposed close from 117's ob1_item_proposal_json. */
export function normaliseItemProposal(r: unknown, what: string): ItemProposal {
  const o = obj(r);
  const p = obj(o?.proposer);
  const d = obj(o?.decider);
  if (!o || !p || typeof o.id !== "string" || typeof o.item_id !== "string" || (o.status !== "done" && o.status !== "dropped")
      || typeof p.name !== "string" || o.proposed_at == null
      || (o.decision != null && !["accepted", "rejected", "moot"].includes(o.decision as string)) || (o.decider != null && (!d || typeof d.name !== "string"))) {
    throw new Error(`${what} answered a proposal this server cannot read`);
  }
  return {
    id: o.id, itemId: o.item_id, status: o.status, evidenceThoughtId: text(o.evidence_thought_id), label: text(o.label), reason: text(o.reason),
    proposer: { name: p.name, agentId: text(p.agent_id), trust: text(p.trust), scope: text(p.scope) },
    proposedAt: time(o.proposed_at) as string, decision: (o.decision ?? null) as ItemProposal["decision"], decidedAt: time(o.decided_at),
    decider: d ? { name: d.name as string, agentId: text(d.agent_id) } : null, decisionReason: text(o.decision_reason),
  };
}

/** One of 117's writers' jsonb answers as the store's ItemAnswer; an outcome or code 117 does not name throws. */
export function normaliseItemAnswer(r: unknown, what: string): ItemAnswer {
  const o = obj(r);
  if (!o || !OUTCOMES.has(o.outcome as string) || (o.code != null && !CODES.has(o.code as string))) {
    throw new Error(`${what} answered no envelope this server reads`);
  }
  return {
    outcome: o.outcome as ItemAnswer["outcome"],
    code: (o.code ?? null) as ItemRefusalCode | null,
    message: text(o.message),
    item: o.item == null ? null : normaliseOpenItem(o.item, what),
    event: o.event == null ? null : normaliseItemEvent(o.event, what),
    proposal: o.proposal == null ? null : normaliseItemProposal(o.proposal, what),
    replaced: o.replaced == null ? null : normaliseItemProposal(o.replaced, what),
    mooted: typeof o.mooted === "number" ? o.mooted : 0,
  };
}

/** 117's open_item_history: the item (null for an id the brain does not hold), its events and its proposals. */
export function normaliseItemRecord(r: unknown, what: string): ItemRecord {
  const o = obj(r);
  if (!o || !Array.isArray(o.events) || !Array.isArray(o.proposals)) throw new Error(`${what} answered no record this server reads`);
  return {
    item: o.item == null ? null : normaliseOpenItem(o.item, what),
    events: (o.events as unknown[]).map((e) => normaliseItemEvent(e, what)),
    proposals: (o.proposals as unknown[]).map((p) => normaliseItemProposal(p, what)),
  };
}
