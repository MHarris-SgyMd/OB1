// Deliverables (SMD-1715 PR 2): migration 134's answers as the store's values.
// The database decides every rule — the allowed moves, the deliverable a key
// recorded or wrote not verified by it, the same deliverable again — and these
// readers hold its jsonb to the shapes the server shows, a row that is not one
// refused by name. In a file of its own, as open-items.ts is, so the store's
// long file gains only its re-exports.
//
// One word is renamed on the way in: 134 stores a verification's finding as
// `outcome`, beside every call's own `outcome` (captured, changed, refused).
// Here it is `finding`, so an answer never holds two `outcome`s that mean
// different things (review pass 4 of PR 1).

import { isoTimestamp } from "./store.ts";

export const DELIVERABLE_STATUSES = ["unverified", "verified", "corrected"] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];
/** What a verification may move a deliverable to: never back to unverified (134's ob1_deliverable_transition_ok). */
export const VERIFY_STATUSES = ["verified", "corrected"] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

/** A verification as the deliverable carries it: how it was checked, what was found, by whom and when. */
export type DeliverableVerification = { method: string; finding: string; by: string; at: string };
/** One deliverable as 134's ob1_deliverable_json answers it: the projection of its events. */
export type Deliverable = {
  thoughtId: string;
  specRef: string;
  checkpoint: string;
  status: DeliverableStatus;
  capturedBy: string;
  capturedAt: string;
  /** The newest verification, or null while none has been made. */
  verification: DeliverableVerification | null;
  /** The newest event's seq: one deliverable's order, not a cursor across deliverables (134). */
  seq: number;
};
/** One event as 134's ob1_deliverable_event_json answers it: the state after it and its maker. */
export type DeliverableEvent = {
  id: string;
  seq: number;
  thoughtId: string;
  event: "captured" | "verification";
  status: DeliverableStatus;
  specRef: string;
  checkpoint: string;
  method: string | null;
  finding: string | null;
  maker: { name: string; agentId: string | null; kind: string | null; trust: string | null; scope: string | null };
  at: string;
};
/** The refusal codes 134's writers answer with. */
export const DELIVERABLE_REFUSAL_CODES = [
  "WRITE_SCOPE_REQUIRED", "THOUGHT_NOT_FOUND", "SPEC_NOT_FOUND", "SPEC_IS_SELF", "ALREADY_A_DELIVERABLE",
  "NOT_A_DELIVERABLE", "ILLEGAL_TRANSITION", "VERIFY_NOT_YOURS",
] as const;
export type DeliverableRefusalCode = (typeof DELIVERABLE_REFUSAL_CODES)[number];
/** One of 134's writers' jsonb answers, read: record_deliverable's and verify_deliverable's outcomes share it. */
export type DeliverableAnswer = {
  outcome: "captured" | "unchanged" | "changed" | "refused";
  code: DeliverableRefusalCode | null;
  /** The database's words, for a refusal. */
  message: string | null;
  deliverable: Deliverable | null;
  event: DeliverableEvent | null;
  /** verify_deliverable's move (ILLEGAL_TRANSITION and VERIFY_NOT_YOURS name it too); null elsewhere. */
  from: DeliverableStatus | null;
  to: DeliverableStatus | null;
};
/** One deliverable's record (134's deliverable_history): the deliverable (null: none, or its thought deleted) and every event, in order. */
export type DeliverableRecord = { deliverable: Deliverable | null; events: DeliverableEvent[] };

const OUTCOMES = new Set(["captured", "unchanged", "changed", "refused"]);
const CODES = new Set<string>(DELIVERABLE_REFUSAL_CODES);
const STATUSES = new Set<string>(DELIVERABLE_STATUSES);
const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const time = (v: unknown): string | null => (v === null || v === undefined ? null : isoTimestamp(v as string | Date));
const status = (v: unknown): DeliverableStatus | null => (typeof v === "string" && STATUSES.has(v) ? (v as DeliverableStatus) : null);
const seqOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

/** One deliverable from 134's ob1_deliverable_json; a row that is not one throws, naming the call and nothing of the row. */
export function normaliseDeliverable(r: unknown, what: string): Deliverable {
  const o = obj(r);
  const v = obj(o?.verification);
  const st = status(o?.status), seq = seqOf(o?.seq);
  if (!o || typeof o.thought_id !== "string" || typeof o.spec_ref !== "string" || typeof o.checkpoint !== "string" || !st
      || typeof o.captured_by !== "string" || o.captured_at == null || seq === null
      || (o.verification != null && (!v || typeof v.method !== "string" || typeof v.outcome !== "string" || typeof v.by !== "string" || v.at == null))) {
    throw new Error(`${what} answered a deliverable this server cannot read`);
  }
  return {
    thoughtId: o.thought_id, specRef: o.spec_ref, checkpoint: o.checkpoint, status: st,
    capturedBy: o.captured_by, capturedAt: time(o.captured_at) as string,
    verification: v ? { method: v.method as string, finding: v.outcome as string, by: v.by as string, at: time(v.at) as string } : null,
    seq,
  };
}

/** One event from 134's ob1_deliverable_event_json. */
export function normaliseDeliverableEvent(r: unknown, what: string): DeliverableEvent {
  const o = obj(r);
  const m = obj(o?.by);
  const st = status(o?.status), seq = seqOf(o?.seq);
  if (!o || !m || typeof o.id !== "string" || seq === null || typeof o.thought_id !== "string" || (o.event !== "captured" && o.event !== "verification")
      || !st || typeof o.spec_ref !== "string" || typeof o.checkpoint !== "string" || typeof m.name !== "string" || o.at == null) {
    throw new Error(`${what} answered an event this server cannot read`);
  }
  return {
    id: o.id, seq, thoughtId: o.thought_id, event: o.event, status: st, specRef: o.spec_ref, checkpoint: o.checkpoint,
    method: text(o.method), finding: text(o.outcome),
    maker: { name: m.name, agentId: text(m.agent_id), kind: text(m.kind), trust: text(m.trust), scope: text(m.scope) },
    at: time(o.at) as string,
  };
}

/** One of 134's writers' jsonb answers as the store's DeliverableAnswer; an outcome or code 134 does not name throws. */
export function normaliseDeliverableAnswer(r: unknown, what: string): DeliverableAnswer {
  const o = obj(r);
  if (!o || !OUTCOMES.has(o.outcome as string) || (o.code != null && !CODES.has(o.code as string))
      || (o.outcome === "refused" && o.code == null) || (o.outcome !== "refused" && o.deliverable == null)) {
    throw new Error(`${what} answered no envelope this server reads`);
  }
  return {
    outcome: o.outcome as DeliverableAnswer["outcome"],
    code: (o.code ?? null) as DeliverableRefusalCode | null,
    message: text(o.message),
    deliverable: o.deliverable == null ? null : normaliseDeliverable(o.deliverable, what),
    event: o.event == null ? null : normaliseDeliverableEvent(o.event, what),
    from: status(o.from),
    to: status(o.to),
  };
}

/** 134's deliverable_history: the deliverable (null when the brain holds none for the thought) and its events. */
export function normaliseDeliverableRecord(r: unknown, what: string): DeliverableRecord {
  const o = obj(r);
  if (!o || !Array.isArray(o.events)) throw new Error(`${what} answered no record this server reads`);
  return {
    deliverable: o.deliverable == null ? null : normaliseDeliverable(o.deliverable, what),
    events: (o.events as unknown[]).map((e) => normaliseDeliverableEvent(e, what)),
  };
}
