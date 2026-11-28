// The settled parts' listing (SMD-4446 PR 3a): migration 156's list_settled_parts read as a value. One read for
// db/consolidate.ts --parts and for the server's store, as proposal-review.ts is one decision for both: the columns
// are named here once, so the CLI and the server cannot list by different ones.

import type { SQL } from "bun";
import { isoTimestamp, isoTimestampOrNull, ListCursorRefused, timeCastFailed, type ListedReviewer } from "./store.ts";

/** The statuses a settled part's row can have (151's CHECK). */
export const PART_STATUSES = ["pending", "accepted", "rejected", "stale"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

/** The two groups a part's word falls in (151's word_group; docs/subject-anchored-claims.md, row 9), in the words a reader meets. */
export const PART_GROUP_WORDS = { no_longer_holds: "no longer holds", done_or_settled: "done or settled" } as const;
export type PartGroup = keyof typeof PART_GROUP_WORDS;

/**
 * How many characters of a text the listing gives either side of a quote (156's p_context, which admits 0 to 500).
 * The readers pass it and print by it: a context shorter than this reached its text's edge, and is not marked as cut.
 */
export const PART_CONTEXT = 120;

/**
 * One of a part's two quotes, as its thought holds it now. `text` is the row's own: its thought's characters as the
 * pass read them. `inText`: the thought's text still holds it, read as the part's identity reads a statement (case
 * and white space folded). `before` and `after`: up to PART_CONTEXT characters either side of its first place in the
 * text, where the text holds the row's characters exactly; null where it holds them only as the fold reads them, or
 * not at all.
 */
export type PartQuote = { text: string; inText: boolean; before: string | null; after: string | null };

/** One thought of a part's pair as it is now: `head` its first 200 characters, `edited` whether its text has moved since the part was judged. */
export type PartSide = { id: string; created_at: string | null; head: string; edited: boolean };

/** The whole-thought proposal on a part's pair (029 holds one a pair): `supersedingId` the thought an accept made stand, null unless accepted. */
export type PartWhole = { id: string; status: string; verdict: string; supersedingId: string | null };

/**
 * One row of migration 156's listing: a settled part (151), with its two quotes as its thoughts hold them now. The
 * holder's thought holds the statement, and the pair's other thought the words that show it.
 */
export type SettledPart = {
  id: string;
  status: PartStatus;
  holder: "older" | "newer";
  /** One of SMD-3116's eight settling labels, kept as data; anything that acts on a part reads `group`. */
  word: string;
  group: PartGroup;
  reason: string;
  judgeKey: string;
  judgedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Who decided an accepted or rejected row; null on an undecided row and on a decided one whose decision named nobody. */
  reviewer: ListedReviewer | null;
  statement: PartQuote;
  shownBy: PartQuote;
  older: PartSide;
  newer: PartSide;
  whole: PartWhole | null;
};

/** Where a page ended on the listing's order: `judgedAt` Postgres's own text of the time, to the microsecond. */
export type PartPosition = { judgedAt: string; id: string };

/** A page of the listing: `next` the place the next page starts after, null when none follows; `remaining` how many follow this page. */
export type PartPage = { parts: SettledPart[]; next: PartPosition | null; remaining: number };

const text = (v: unknown): string | null => (v == null ? null : String(v));

/** list_settled_parts's row → SettledPart. */
export function normalisePart(r: Record<string, unknown>): SettledPart {
  const quote = (name: "statement" | "shown_by"): PartQuote =>
    ({ text: String(r[name]), inText: r[`${name}_in_text`] === true, before: text(r[`${name}_before`]), after: text(r[`${name}_after`]) });
  const side = (name: "older" | "newer"): PartSide =>
    ({ id: String(r[`${name}_id`]), created_at: isoTimestampOrNull(r[`${name}_created_at`]), head: String(r[`${name}_head`] ?? ""), edited: r[`${name}_edited`] === true });
  const name = text(r.reviewed_by);
  const agentRecorded = r.reviewed_by_agent === true;
  return {
    id: String(r.id),
    status: String(r.status) as PartStatus,
    holder: r.holder === "newer" ? "newer" : "older",
    word: String(r.word),
    group: String(r.word_group) as PartGroup,
    reason: String(r.reason),
    judgeKey: String(r.judge_key),
    judgedAt: isoTimestamp(r.judged_at),
    reviewedAt: isoTimestampOrNull(r.reviewed_at),
    reviewNote: text(r.review_note),
    // An empty name is none, as the proposals' listing reads one; the agent's id stays out (ListedReviewer).
    reviewer: name || agentRecorded ? { name, agentRecorded, kind: text(r.reviewed_by_kind), kindNow: text(r.reviewed_by_kind_now) } : null,
    statement: quote("statement"),
    shownBy: quote("shown_by"),
    older: side("older"),
    newer: side("newer"),
    whole: r.whole_id == null ? null : { id: String(r.whole_id), status: String(r.whole_status), verdict: String(r.whole_verdict), supersedingId: text(r.whole_superseding_id) },
  };
}

/** The error a brain short of migration 156 answers the listing with. */
export const PARTS_LISTING_MISSING = /list_settled_parts\(.*\) does not exist/;
/** What a reader says then: the file to apply. */
export const PARTS_LISTING_HINT = "the settled parts' listing needs migration 156 (db/migrations/156_parts_listing.sql), which this brain has not applied: cd db && bun migrate.ts --url <url>";

/**
 * A page of the settled parts in one status (null: every status), oldest judged first: migration 156's listing, its
 * six arguments always given and its columns by name, never `*`, as the proposals' listing is read (SMD-3302: a
 * later file that adds a column leaves this statement's result type as it was). `after` starts past that place. A
 * cursor whose time Postgres cannot read is the caller's (ListCursorRefused), as list_thoughts' is.
 */
export async function listParts(sql: SQL, opts: { status?: PartStatus | null; limit?: number; judgeKey?: string; after?: PartPosition }): Promise<PartPage> {
  const a = opts.after;
  let rows: Record<string, unknown>[];
  try {
    rows = (await sql`
      SELECT id, status, holder, statement, shown_by, word, word_group, reason, judge_key, judged_at, reviewed_at, review_note,
             reviewed_by, reviewed_by_agent, reviewed_by_kind, reviewed_by_kind_now,
             older_id, older_created_at, older_head, older_edited, newer_id, newer_created_at, newer_head, newer_edited,
             statement_in_text, statement_before, statement_after, shown_by_in_text, shown_by_before, shown_by_after,
             whole_id, whole_status, whole_verdict, whole_superseding_id, page_key, remaining
        FROM list_settled_parts(${opts.status === undefined ? "pending" : opts.status}::text, ${opts.limit ?? null}::int, ${opts.judgeKey ?? null}::text,
                                ${a?.judgedAt ?? null}::timestamptz, ${a?.id ?? null}::uuid, ${PART_CONTEXT}::int)`) as Record<string, unknown>[];
  } catch (e) {
    if (!a || !timeCastFailed(e)) throw e;
    const unread = await sql`SELECT ${a.judgedAt}::timestamptz`.then(() => false, (p: unknown) => (timeCastFailed(p) ? true : Promise.reject(p)));
    if (unread) throw new ListCursorRefused();
    throw e;
  }
  // Each row's page_key is its place for the next call; remaining counts the selection from this page's first on,
  // so what follows the page is that less the rows listed (110's shape).
  const remaining = rows.length ? Math.max(0, Number(rows[0].remaining) - rows.length) : 0;
  const lastKey = remaining > 0 ? JSON.parse(String(rows[rows.length - 1].page_key)) as string[] : null;
  return { parts: rows.map(normalisePart), next: lastKey ? { judgedAt: lastKey[0], id: lastKey[1] } : null, remaining };
}
