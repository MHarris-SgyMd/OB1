// list_thoughts' cursor (SMD-2995), and list_supersession_proposals' (SMD-3249),
// on their own: the core makes and reads them, and render.ts's structuredContent
// guard lets one through by the same rule that reads it — tokens, a pass key, a
// timestamp's text and a uuid, so no sentence can ride it (review pass 1: the
// guard took any `cursor` for a uuid and nulled this one, so a program reading
// structuredContent stopped at page one).

import { PASS_KEY_CHARS } from "../pass-key.ts";
import { RELATION_WORDS, UUID_RE, type FindingPosition, type ListSort, type RelationWord } from "../store.ts";
import { isFindingKind, isFindingStatus, type FindingKind, type FindingStatus } from "../priority-kinds.ts";

/**
 * A cursor's text read back to its JSON array of `length` values, or null for anything that is not one: trimmed, at most
 * `max` base64url characters (512 but for the claims cursor's), JSON, an array of that length. Each listing's parser
 * below holds the values to its own shape (SMD-3671 PR 2: the preamble was written six times).
 */
function decodeCursor(raw: string, length: number, max = 512): unknown[] | null {
  const text = raw.trim();
  if (text.length > max || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return Array.isArray(v) && v.length === length ? v : null;
}

/**
 * list_thoughts' cursor (SMD-2995): the sort it was made under and the place
 * the page ended, as base64url of `[sort, at, id]` — opaque to a caller, who
 * passes it back as it came. `at` is Postgres's own text of `created_at`, or
 * null for an undated row (store.ts ListPosition).
 */
export function listCursor(sort: ListSort, at: string | null, id: string): string {
  return Buffer.from(JSON.stringify([sort, at, id])).toString("base64url");
}

/**
 * A list_thoughts cursor read back, or null for anything that is not one: the
 * sort a word of the two, the id a uuid, and `at` null or timestamptz's text
 * as Postgres writes it (a date, a clock to the microsecond, an offset, a BC,
 * or ±infinity), held to a shape and a date that exists before it reaches the
 * SQL. One that still makes Postgres's cast fail — a year 0, past its range,
 * an offset past ±15:59:59 — is the store's to refuse (ListCursorRefused in
 * store.ts, review pass 1): the bounds depend on the offset.
 */
export function parseListCursor(raw: string): { sort: ListSort; at: string | null; id: string } | null {
  const v = decodeCursor(raw, 3);
  if (!v) return null;
  const [sort, at, id] = v;
  if (sort !== "newest" && sort !== "oldest") return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (at === null) return { sort, at: null, id: id.toLowerCase() };
  return pgStamp(at) ? { sort, at, id: id.toLowerCase() } : null;
}

/**
 * thread's cursor (SMD-3306 PR 7a-2a): the last member's position in its thread's order, as base64url of
 * `["thread", at, id]` — `at` Postgres's own text of its created_at, null undated — passed back with the key.
 */
export function threadCursor(at: string | null, id: string): string {
  return Buffer.from(JSON.stringify(["thread", at, id])).toString("base64url");
}

/** A thread cursor read back, or null for anything that is not one, held as parseListCursor holds its own. */
export function parseThreadCursor(raw: string): { at: string | null; id: string } | null {
  const v = decodeCursor(raw, 3);
  if (!v || v[0] !== "thread") return null;
  const [, at, id] = v;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (at === null) return { at: null, id: id.toLowerCase() };
  return pgStamp(at) ? { at, id: id.toLowerCase() } : null;
}

/** What a relations cursor was made under and where its page ended: the thought, the word (null for all four), and the last relation's position. */
export type RelationsCursorAt = { thought: string; relation: RelationWord | null; rank: string; at: string; id: string };

/**
 * relations' cursor (SMD-2726; SMD-3306 PR 7a-2b): the thought and word it was read under, and the last relation's
 * position in that thought's relations, strongest first, as base64url of `["relations", thought, word, rank, at, id]` —
 * `rank` Postgres's text of its confidence rounded to six places as numeric (-1 for none), `at` its text of when the
 * relation was first recorded. It carries its thought and word so a cursor passed with another is refused, not read as
 * a short last page (review pass 1), as list_thoughts' carries its sort.
 */
export function relationsCursor(c: RelationsCursorAt): string {
  return Buffer.from(JSON.stringify(["relations", c.thought, c.relation, c.rank, c.at, c.id])).toString("base64url");
}

/** A relations cursor read back, or null for anything that is not one, held as parseListCursor holds its own. */
export function parseRelationsCursor(raw: string): RelationsCursorAt | null {
  const v = decodeCursor(raw, 6);
  if (!v || v[0] !== "relations") return null;
  const [, thought, relation, rank, at, id] = v;
  if (typeof thought !== "string" || !UUID_RE.test(thought) || typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (relation !== null && !(RELATION_WORDS as readonly unknown[]).includes(relation)) return null;
  // numeric's text of a value rounded to six places: a sign, digits and a fraction, never an exponent; -1 the absent.
  if (typeof rank !== "string" || !/^-?[0-9]{1,20}(?:\.[0-9]{1,6})?$/.test(rank)) return null;
  return pgStamp(at) ? { thought: thought.toLowerCase(), relation: relation as RelationWord | null, rank, at, id: id.toLowerCase() } : null;
}

/**
 * Whether `at` is timestamptz's text as Postgres writes it — a date, a clock to
 * the microsecond, an offset, a BC, or ±infinity — held to a shape and a date
 * that exists before it reaches the SQL. One that still makes Postgres's cast
 * fail is the store's to refuse (ListCursorRefused).
 */
function pgStamp(at: unknown): at is string {
  if (typeof at !== "string") return false;
  if (at === "infinity" || at === "-infinity") return true;
  const m = /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?[+-]\d{2}(?::\d{2}){0,2}( BC)?$/.exec(at);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const day = new Date(Date.UTC(2000, mo - 1, d));
  // The day exists in its month (a leap day checked against a leap year's calendar), the clock is a clock.
  return !(mo < 1 || mo > 12 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || (mo === 2 && d === 29 && !leap(y, Boolean(m[8]))) || h > 23 || mi > 59 || s > 59);
}

/**
 * What a list_supersession_proposals page selected (SMD-3249): its status word (`all` for every state), its lineage
 * filter (null: every pair) and its judge key (null: every pass) — the tool's inputs and the CLI's --list/--key alike.
 */
export type ProposalSelection = { status: (typeof PROPOSAL_STATUSES)[number]; lineage: boolean | null; judgeKey: string | null; list?: undefined };

const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "stale", "all"] as const;
const isProposalStatus = (v: unknown): v is ProposalSelection["status"] => (PROPOSAL_STATUSES as readonly unknown[]).includes(v);

/**
 * list_supersession_proposals' cursor (SMD-3249): the selection the page was
 * listed under, then the last listed row's values on the listing's order — its
 * confidence as numeric(3,2)'s text, judged_at as Postgres's text (to the
 * microsecond) and its id — as base64url of `["proposals", status, lineage,
 * judgeKey, confidence, judgedAt, id]`. The values, not the row: 063's recorder
 * replaces a stale row in place (the same id, judged_at now() and the new
 * verdict's confidence), so a cursor naming the row would read its new place
 * and jump the walk; the values keep the place the page ended at. The
 * selection, so a cursor passed with other filters is refused rather than
 * starting that listing at a place in another (review pass 1: it listed from
 * mid-selection without a word). The tag keeps it apart from list_thoughts'
 * cursor, so one listing's is refused by the other.
 */
export function proposalCursor(sel: ProposalSelection, confidence: string, judgedAt: string, id: string): string {
  return Buffer.from(JSON.stringify(["proposals", sel.status, sel.lineage, sel.judgeKey, confidence, judgedAt, id])).toString("base64url");
}

/** A list_supersession_proposals cursor read back, or null for anything that is not one. */
export function parseProposalCursor(raw: string): { selection: ProposalSelection; confidence: string; judgedAt: string; id: string } | null {
  const v = decodeCursor(raw, 7);
  if (!v) return null;
  const [tag, status, lineage, judgeKey, confidence, judgedAt, id] = v;
  if (tag !== "proposals") return null;
  if (!isProposalStatus(status)) return null;
  if (lineage !== null && typeof lineage !== "boolean") return null;
  // pass-key.ts's one rule, the tool's and --key's input rule, so a cursor carries no key either door refuses.
  if (judgeKey !== null && (typeof judgeKey !== "string" || !PASS_KEY_CHARS.test(judgeKey))) return null;
  // numeric(3,2)'s text, 0 to 1 (029's CHECK): `0.73`, `1.00`.
  if (typeof confidence !== "string" || !/^(?:0\.\d{2}|1\.00)$/.test(confidence)) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const selection = { status, lineage, judgeKey };
  return pgStamp(judgedAt) ? { selection, confidence, judgedAt, id: id.toLowerCase() } : null;
}

/** Whether two selections are the same listing — a cursor's and the call's it is passed with. */
export const sameSelection = (a: ProposalSelection, b: ProposalSelection): boolean => a.status === b.status && a.lineage === b.lineage && a.judgeKey === b.judgeKey;

/**
 * What a list_settled_parts page selected (SMD-4446 PR 3a): its status word (`all` for every state) and its judge key
 * (null: every pass), the CLI's --parts and --key alike. Tagged `list: "parts"`, as a findings selection is tagged, so
 * a refusal's `made` says which listing's it is.
 */
export type PartSelection = { list: "parts"; status: ProposalSelection["status"]; judgeKey: string | null };
/** Whether two selections are the same listing — a cursor's and the call's it is passed with (sameSelection's rule, for parts). */
export const samePartSelection = (a: PartSelection, b: PartSelection): boolean => a.status === b.status && a.judgeKey === b.judgeKey;

/**
 * list_settled_parts' cursor (SMD-4446 PR 3a): the selection the page was listed under, then the last listed row's
 * place on the listing's order, its judged_at as Postgres's text (to the microsecond) and its id, as base64url of
 * `["parts", status, judgeKey, judgedAt, id]`. A part's row is one judgement, and no update moves its judged_at or
 * its id (151's settled_parts_keep_judgement), so the two values are the row's place for as long as it stands. The
 * selection, so a cursor passed with other filters is refused rather than starting that listing at a place in another
 * (the proposals' rule). The tag keeps it apart from the other listings' cursors, so one listing's is refused by
 * another.
 */
export function partsCursor(sel: PartSelection, judgedAt: string, id: string): string {
  return Buffer.from(JSON.stringify(["parts", sel.status, sel.judgeKey, judgedAt, id])).toString("base64url");
}

/** A list_settled_parts cursor read back, or null for anything that is not one. */
export function parsePartsCursor(raw: string): { selection: PartSelection; judgedAt: string; id: string } | null {
  const v = decodeCursor(raw, 5);
  if (!v) return null;
  const [tag, status, judgeKey, judgedAt, id] = v;
  if (tag !== "parts") return null;
  if (!isProposalStatus(status)) return null;
  // pass-key.ts's one rule, the tool's and --key's input rule, so a cursor carries no key either door refuses.
  if (judgeKey !== null && (typeof judgeKey !== "string" || !PASS_KEY_CHARS.test(judgeKey))) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const selection: PartSelection = { list: "parts", status, judgeKey };
  return pgStamp(judgedAt) ? { selection, judgedAt, id: id.toLowerCase() } : null;
}

/**
 * What a list_work_claims page selected (SMD-3606 PR 2): the ticket filter (null: every ticket), the holder filter
 * (null: every holder) and whether ended claims are included — the tool's `ticket`, `holder` and `include_ended`.
 */
export type ClaimSelection = { ticket: string | null; holder: string | null; includeEnded: boolean };

/**
 * list_work_claims' cursor (SMD-3606 PR 2): the selection the page was listed under, then the last listed row's values
 * on the listing's order — its issue (the upper-case ticket key 115 stores), piece_key (the piece folded, '' for a
 * whole-ticket claim), claimed_at as Postgres's text (to the microsecond) and its id — as base64url of `["claims",
 * ticket, holder, includeEnded, issue, pieceKey, claimedAt, id]`. The values, not a row alone: a claim's four order
 * values never change after it is made (143), so the cursor keeps the place the page ended at. The selection, so a
 * cursor passed with other filters is refused rather than starting the listing at a place in another. The tag keeps it
 * apart from the other listings' cursors, so one listing's is refused by another.
 */
export function claimCursor(sel: ClaimSelection, issue: string, pieceKey: string, claimedAt: string, id: string): string {
  return Buffer.from(JSON.stringify(["claims", sel.ticket, sel.holder, sel.includeEnded, issue, pieceKey, claimedAt, id])).toString("base64url");
}

/** A list_work_claims cursor read back, or null for anything that is not one. */
export function parseClaimCursor(raw: string): { selection: ClaimSelection; issue: string; pieceKey: string; claimedAt: string; id: string } | null {
  // 2048, not the other cursors' 512: this one carries ticket, holder, issue and piece_key (each up to 200), so a max-length cursor reaches ~1200 (SMD-3606 PR 2); the schema's `after` admits 2048 too.
  const v = decodeCursor(raw, 8, 2048);
  if (!v) return null;
  const [tag, ticket, holder, includeEnded, issue, pieceKey, claimedAt, id] = v;
  if (tag !== "claims") return null;
  // The selection: the tool's inputs, each null or a bounded string, include_ended a boolean.
  if (ticket !== null && (typeof ticket !== "string" || ticket.length > 200)) return null;
  if (holder !== null && (typeof holder !== "string" || holder.length > 200)) return null;
  if (typeof includeEnded !== "boolean") return null;
  // The position: issue the key 115 stores (non-empty, bounded), piece_key the piece folded ('' for a whole-ticket claim), id a uuid.
  if (typeof issue !== "string" || issue.length < 1 || issue.length > 200) return null;
  // piece is at most 100 (115's CHECK), but piece_key is lower(piece), and lower() can lengthen a few code points, so 200 gives margin; the whole cursor is bounded to 2048 above regardless.
  if (typeof pieceKey !== "string" || pieceKey.length > 200) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const selection: ClaimSelection = { ticket, holder, includeEnded };
  return pgStamp(claimedAt) ? { selection, issue, pieceKey, claimedAt, id: id.toLowerCase() } : null;
}

/** Whether two claim selections are the same listing — a cursor's and the call's it is passed with. */
export const sameClaimSelection = (a: ClaimSelection, b: ClaimSelection): boolean => a.ticket === b.ticket && a.holder === b.holder && a.includeEnded === b.includeEnded;

/** Whether year `y` (BC when `bc`) is a leap year in Postgres's proleptic Gregorian calendar: 1 BC is year 0. */
const leap = (y: number, bc: boolean) => {
  const n = bc ? 1 - y : y;
  return n % 4 === 0 && (n % 100 !== 0 || n % 400 === 0);
};


/**
 * What a list_priority_findings page selected (SMD-3671 PR 2): its status word (`all` for every state) and its kind
 * (null: every kind), tagged `list: "findings"` so a refusal's `made` says which listing's it is (ProposalSelection, the
 * older shape, carries no tag, and keeps none).
 */
export type FindingSelection = { list: "findings"; status: FindingStatus | "all"; kind: FindingKind | null };
/** Whether two selections are the same listing — a cursor's and the call's it is passed with (sameSelection's rule, for findings). */
export const sameFindingSelection = (a: FindingSelection, b: FindingSelection): boolean => a.status === b.status && a.kind === b.kind;

/**
 * list_priority_findings' cursor (SMD-3671 PR 2): the selection the page was listed under and the last listed row's
 * place on the order (FindingPosition), as base64url of `["findings", status, kind, grp, sk, id]`. The place, not a
 * count of rows: deciding a pending finding between pages takes it out of the pending listing, and an offset would then
 * pass over one never shown. The selection, so a cursor passed with other filters is refused (the proposals' rule).
 */
export function findingsCursor(sel: FindingSelection, at: FindingPosition): string {
  return Buffer.from(JSON.stringify(["findings", sel.status, sel.kind, at.grp, at.sk, at.id])).toString("base64url");
}

/** A list_priority_findings cursor read back, or null for anything that is not one: `sk` numeric's text, the id a uuid. */
export function parseFindingsCursor(raw: string): { selection: FindingSelection; at: FindingPosition } | null {
  const v = decodeCursor(raw, 6);
  if (!v) return null;
  const [tag, status, kind, grp, sk, id] = v;
  if (tag !== "findings") return null;
  if (status !== "all" && !isFindingStatus(status)) return null;
  if (kind !== null && !isFindingKind(kind)) return null;
  if (grp !== 0 && grp !== 1) return null;
  // An epoch to the microsecond, negated for the decided: numeric's text, bounded so no cast can fail on it. An infinite
  // found_at or decided_at reads as Infinity or -Infinity, which numeric takes from Postgres 14 (the stack's is 16).
  if (typeof sk !== "string" || !/^(?:-?\d{1,15}(?:\.\d{1,6})?|-?Infinity)$/.test(sk)) return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return { selection: { list: "findings", status, kind }, at: { grp, sk, id: id.toLowerCase() } };
}
