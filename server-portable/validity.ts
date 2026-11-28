// A thought's state on three axes (SMD-3887 PR 2b): migration 149's thought_validity, read by the store and served by
// the core's `validity` operation over REST and MCP alike. docs/claim-validity.md decides the states, their order and
// the records each is read from; the database reads them, and this file holds its answer to that shape.
//
// The axes' states are checked against the record's words, and an answer naming another throws: the server never
// passes on a state it was not told of. The records behind each state ride as the database wrote them (the record's
// "The shape" names their keys); the server checks only that each
// is an object, and puts a record's `at` in the API's timestamp form (review pass 2).
//
// Since migration 158 (SMD-4446 PR 3c-3) the validity axis carries the partly settled mark beside its state: the
// accepted settled parts standing on the thought, read by the database through the one read fetch and the search and
// list pages make (157's). The mark is checked whole, as a state is, and given under the names those pages give a
// part (core/settled.ts): one shape for a client that reads both. It moves no state.

import { isoTimestamp } from "./store.ts";
import { PART_GROUP_WORDS, type PartGroup } from "./part-listing.ts";

/** Validity's states, in precedence order, then unknown, outside it (the record's row 2). */
export const VALIDITY_STATES = ["superseded", "contested", "unresolved", "supported", "unchallenged", "unknown"] as const;
/** Review's states, in precedence order, then unknown (row 5). */
export const REVIEW_STATES = ["pending", "decided", "checked", "unchecked", "none", "unknown"] as const;
/** Freshness's states, worst first, then none and unknown (row 6). */
export const FRESHNESS_STATES = ["stale", "requested", "legacy", "current", "none", "unknown"] as const;
/**
 * The cap on ids a call may ask for: 149's c_cap on distinct ids, held by the operation's schema on the list itself,
 * since a REST request line carries some 400 ids before Bun refuses it (431), short of 149's raw bound of 1,000
 * (review pass 1).
 */
export const VALIDITY_CAP = 100;
/** How many parts of one thought the mark lists: 158's c_parts, fetch's own count; `settledMore` counts the rest. */
export const VALIDITY_PARTS = 20;

export type ValidityState = (typeof VALIDITY_STATES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type FreshnessState = (typeof FRESHNESS_STATES)[number];
/** A record a state was read from, as the database wrote it, its `at` in the API's form. */
export type ValidityRecord = Record<string, unknown>;
/** One freshness kind: its worst row's state, its producers, what moved under its stale rows, and whether no pool re-runs it. */
export type FreshnessKind = { kind: string; state: FreshnessState; produced_by: string[]; moved: string[]; no_pool: boolean };

/**
 * One accepted settled part standing on a thought, as the validity read marks it (158): its id; the group anything
 * that acts on a part reads, null for one this server does not know (a brain migrated ahead); the writer's word, kept
 * as data; `by`, the other thought of its pair, which holds the words that show it, and `otherIs`, which of the pair
 * that is by capture order; when a reviewer accepted it; `editedSince`, the thought's text has moved since the part
 * was judged, the statement still in it; and `shownByInText`, the other thought still holds those words. No word of
 * either thought: fetch gives the statement and the words that show it.
 */
export type ValidityPart = {
  id: string; group: PartGroup | null; word: string; otherIs: "older" | "newer"; by: { id: string };
  acceptedAt: string | null; editedSince: boolean; shownByInText: boolean;
};

/** A thought the brain holds, on its three axes. */
export type ValidityFound = {
  id: string;
  found: true;
  version: { fingerprint: string; seq: number | null };
  /**
   * `settled` is the partly settled mark: the accepted settled parts standing on the thought, the first
   * VALIDITY_PARTS in the order its text says them, and `settledMore` how many more stand. It sits beside the state
   * and moves none: a partly settled thought stands. Null: the parts were not read, because the server's role may not
   * read them (`unread` names `part`) or the brain's thought_validity is from before migration 158.
   */
  validity: { state: ValidityState; found: Exclude<ValidityState, "unknown">; records: ValidityRecord[]; settled: ValidityPart[] | null; settledMore: number };
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

const groupWord = (g: unknown): PartGroup | null => (typeof g === "string" && Object.hasOwn(PART_GROUP_WORDS, g) ? g as PartGroup : null);

function partOf(v: unknown, what: string): ValidityPart {
  const o = obj(v);
  if (!o || typeof o.part !== "string" || typeof o.other !== "string" || typeof o.word !== "string" || (o.other_is !== "older" && o.other_is !== "newer")
      || typeof o.edited !== "boolean" || typeof o.shown_by_in_text !== "boolean" || (o.accepted_at != null && typeof o.accepted_at !== "string")) {
    throw new Error(`${what} answered a settled part this server cannot read`);
  }
  return {
    id: o.part, group: groupWord(o.group), word: o.word, otherIs: o.other_is, by: { id: o.other },
    acceptedAt: o.accepted_at == null ? null : isoTimestamp(o.accepted_at as string), editedSince: o.edited, shownByInText: o.shown_by_in_text,
  };
}

/**
 * 158's `validity.settled` as the mark's two fields. Absent (a thought_validity from before 158) or null (the role
 * may not read settled_parts): not read. Else {total, parts}, checked whole: a total below the parts listed is no
 * answer this server reads.
 */
function markOf(v: unknown, what: string): { settled: ValidityPart[] | null; settledMore: number } {
  if (v == null) return { settled: null, settledMore: 0 };
  const o = obj(v);
  const total = count(o?.total);
  if (!o || total === undefined || !Array.isArray(o.parts) || total < o.parts.length) throw new Error(`${what} answered a partly settled mark this server cannot read`);
  return { settled: (o.parts as unknown[]).map((p) => partOf(p, what)), settledMore: total - o.parts.length };
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
    validity: { state: vState, found: vFound, records: vRecords, ...markOf(validity?.settled, what) },
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
