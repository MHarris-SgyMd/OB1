// A thought's state on three axes (SMD-3887 PR 2b): migration 149's thought_validity, read by the store and served by
// the core's `validity` operation over REST and MCP alike. docs/claim-validity.md decides the states, their order and
// the records each is read from; the database reads them, and this file holds its answer to that shape.
//
// The axes' states are checked against the record's words, and an answer naming another throws: the server never
// passes on a state it was not told of. The records behind each state ride as the database wrote them (the record's
// "The shape" names their keys); the server reads none of them.

import { isoTimestamp } from "./store.ts";

/** Validity's states, in precedence order, then unknown, outside it (the record's row 2). */
export const VALIDITY_STATES = ["superseded", "contested", "unresolved", "supported", "unchallenged", "unknown"] as const;
/** Review's states, in precedence order, then unknown (row 5). */
export const REVIEW_STATES = ["pending", "decided", "checked", "unchecked", "none", "unknown"] as const;
/** Freshness's states, worst first, then none and unknown (row 6). */
export const FRESHNESS_STATES = ["stale", "requested", "legacy", "current", "none", "unknown"] as const;
/** The cap on ids a call may ask for: 149's c_cap on distinct ids, held by the operation's schema on the list itself. */
export const VALIDITY_CAP = 100;

export type ValidityState = (typeof VALIDITY_STATES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type FreshnessState = (typeof FRESHNESS_STATES)[number];
/** A record a state was read from, as the database wrote it. */
export type ValidityRecord = Record<string, unknown>;
/** One freshness kind: its worst row's state, its producers, what moved under its stale rows, and whether no pool re-runs it. */
export type FreshnessKind = { kind: string; state: FreshnessState; produced_by: string[]; moved: string[]; no_pool: boolean };

/** A thought the brain holds, on its three axes. */
export type ValidityFound = {
  id: string;
  found: true;
  version: { fingerprint: string; seq: number | null };
  validity: { state: ValidityState; found: Exclude<ValidityState, "unknown">; records: ValidityRecord[] };
  review: { state: ReviewState; records: ValidityRecord[] };
  freshness: { state: FreshnessState; kinds: FreshnessKind[]; records: ValidityRecord[] };
  /** The record kinds the server's role could not read. */
  unread: string[];
};
/** An id that is no thought: forgotten (139's ledger holds it), not (false), or unknown (null: the ledger unread). */
export type ValidityMissing = { id: string; found: false; forgotten: boolean | null; forgottenAt: string | null; unread: string[] };
export type ValidityThought = ValidityFound | ValidityMissing;

/** thought_validity's answer: the thoughts, or its refusal of the call whole. */
export type ValidityAnswer =
  | { ok: true; cap: number; thoughts: ValidityThought[] }
  | { ok: false; error: "TOO_MANY"; cap: number; given: number }
  | { ok: false; error: "NO_IDS"; cap: number }
  | { ok: false; error: "NOT_READABLE"; cap: number; unread: string[] };

const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined);
/** The records as the database wrote them, a record's `at` put in the API's timestamp form (jsonb gives `+00:00` and microseconds; review pass 2). */
const records = (v: unknown): ValidityRecord[] | undefined =>
  Array.isArray(v) && v.every((r) => obj(r))
    ? (v as ValidityRecord[]).map((r) => (typeof r.at === "string" ? { ...r, at: isoTimestamp(r.at) } : r))
    : undefined;
const oneOf = <T extends string>(words: readonly T[], v: unknown): T | undefined => (typeof v === "string" && (words as readonly string[]).includes(v) ? (v as T) : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

function kindOf(v: unknown, what: string): FreshnessKind {
  const o = obj(v);
  const state = oneOf(FRESHNESS_STATES, o?.state);
  const producedBy = strings(o?.produced_by), moved = strings(o?.moved);
  if (!o || typeof o.kind !== "string" || !state || !producedBy || !moved || typeof o.no_pool !== "boolean") {
    throw new Error(`${what} answered a freshness kind this server cannot read`);
  }
  return { kind: o.kind, state, produced_by: producedBy, moved, no_pool: o.no_pool };
}

function thoughtOf(v: unknown, what: string): ValidityThought {
  const o = obj(v);
  const unread = strings(o?.unread);
  if (!o || typeof o.id !== "string" || typeof o.found !== "boolean" || !unread) throw new Error(`${what} answered a thought this server cannot read`);
  if (!o.found) {
    if (o.forgotten !== null && typeof o.forgotten !== "boolean") throw new Error(`${what} answered a missing thought this server cannot read`);
    return { id: o.id, found: false, forgotten: o.forgotten as boolean | null, forgottenAt: o.forgotten_at == null ? null : isoTimestamp(o.forgotten_at as string | Date), unread };
  }
  const version = obj(o.version), validity = obj(o.validity), review = obj(o.review), freshness = obj(o.freshness);
  const vState = oneOf(VALIDITY_STATES, validity?.state);
  const vFound = oneOf(VALIDITY_STATES, validity?.found);
  const rState = oneOf(REVIEW_STATES, review?.state);
  const fState = oneOf(FRESHNESS_STATES, freshness?.state);
  const vRecords = records(validity?.records), rRecords = records(review?.records), fRecords = records(freshness?.records);
  const seq = version?.seq == null ? null : count(version.seq);
  if (!version || typeof version.fingerprint !== "string" || seq === undefined || !vState || !vFound || vFound === "unknown" || !rState || !fState
      || !vRecords || !rRecords || !fRecords || !Array.isArray(freshness?.kinds)) {
    throw new Error(`${what} answered a thought this server cannot read`);
  }
  return {
    id: o.id, found: true,
    version: { fingerprint: version.fingerprint, seq },
    validity: { state: vState, found: vFound, records: vRecords },
    review: { state: rState, records: rRecords },
    freshness: { state: fState, kinds: (freshness.kinds as unknown[]).map((k) => kindOf(k, what)), records: fRecords },
    unread,
  };
}

/** 149's thought_validity answer as the store's ValidityAnswer; a shape or a word it does not name throws, naming the call and nothing of the row. */
export function normaliseValidity(r: unknown, what: string): ValidityAnswer {
  const o = obj(r);
  const cap = count(o?.cap);
  if (!o || cap === undefined) throw new Error(`${what} answered no envelope this server reads`);
  if (o.ok === true) {
    if (!Array.isArray(o.thoughts)) throw new Error(`${what} answered no thoughts this server reads`);
    return { ok: true, cap, thoughts: (o.thoughts as unknown[]).map((t) => thoughtOf(t, what)) };
  }
  if (o.ok === false && o.error === "TOO_MANY" && count(o.given) !== undefined) return { ok: false, error: "TOO_MANY", cap, given: count(o.given)! };
  if (o.ok === false && o.error === "NO_IDS") return { ok: false, error: "NO_IDS", cap };
  if (o.ok === false && o.error === "NOT_READABLE" && strings(o.unread)) return { ok: false, error: "NOT_READABLE", cap, unread: strings(o.unread)! };
  throw new Error(`${what} answered a refusal this server does not read`);
}
