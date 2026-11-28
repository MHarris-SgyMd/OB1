// The settled parts that stand on a thought (SMD-4446 PR 3c): migration 157's settled_parts_on read as a value. One
// read for every surface that shows a thought with its accepted parts, as part-listing.ts is one read for the
// listing: the columns are named here once.

import type { SQL } from "bun";
import { isoTimestampOrNull } from "./store.ts";
import type { PartGroup } from "./part-listing.ts";

/** How many parts of one thought fetch shows; the rest are counted (157's p_per admits 1 to 50). */
export const PARTS_ON_FETCH = 20;
/** How many parts of one result a search or list page shows; the rest are counted, and fetch shows them. */
export const PARTS_ON_PAGE = 3;

/**
 * The other thought of a part's pair, which holds the words that show the part: its id, capture time, trust
 * (`ingested` for outside text) and `head`, its first 200 characters as they are now.
 */
export type PartOther = { id: string; created_at: string | null; trust: string | null; head: string };

/**
 * One accepted part standing on a thought: a statement of the thought that the other thought of a pair shows no
 * longer holds, or is done, as a reviewer accepted it. `statement` is the thought's own words, and `shownBy` the
 * other thought's, each as the part's row keeps them. `group` is what anything that acts on a part reads (151's
 * word_group), `word` the writer's label, kept as data. `otherIs`: which of the pair the other thought is, by capture
 * order. `holderEdited`: the thought's text has moved since the part was judged, the statement still in it.
 * `shownByInText`: the other thought's text still holds the words that show it, read as the fold reads them.
 */
export type PartOn = {
  id: string;
  statement: string;
  shownBy: string;
  word: string;
  group: PartGroup;
  otherIs: "older" | "newer";
  other: PartOther;
  judgedAt: string | null;
  acceptedAt: string | null;
  holderEdited: boolean;
  shownByInText: boolean;
};

/** A thought's standing parts as one read gives them: the first few in the order its text says them, and how many stand in all. */
export type PartsOn = { total: number; parts: PartOn[] };

const text = (v: unknown): string | null => (v == null ? null : String(v));

/** settled_parts_on's row → PartOn. */
export function normalisePartOn(r: Record<string, unknown>): PartOn {
  return {
    id: String(r.id),
    statement: String(r.statement),
    shownBy: String(r.shown_by),
    word: String(r.word),
    group: String(r.word_group) as PartGroup,
    otherIs: r.other_is === "older" ? "older" : "newer",
    other: { id: String(r.other_id), created_at: isoTimestampOrNull(r.other_created_at), trust: text(r.other_trust), head: String(r.other_head ?? "") },
    judgedAt: isoTimestampOrNull(r.judged_at),
    acceptedAt: isoTimestampOrNull(r.accepted_at),
    holderEdited: r.holder_edited === true,
    shownByInText: r.shown_by_in_text === true,
  };
}

/**
 * The accepted parts standing on each of `ids`, at most `per` of each in the order its text says them: migration
 * 157's read, its two arguments always given and its columns by name, never `*` (SMD-3302: a later file that adds a
 * column leaves this statement's result type as it was). A thought with none is absent. The rows come grouped by
 * thought and in order, as the function returns them.
 */
export async function partsOn(sql: SQL, ids: readonly string[], per: number): Promise<Record<string, PartsOn>> {
  const out: Record<string, PartsOn> = {};
  if (ids.length === 0) return out;
  const rows = (await sql`
    SELECT holder_id, id, statement, shown_by, word, word_group, other_is, other_id, other_created_at, other_trust, other_head,
           judged_at, accepted_at, holder_edited, shown_by_in_text, place, total
      FROM settled_parts_on(${sql.array([...ids], "UUID")}::uuid[], ${per}::int)`) as Record<string, unknown>[];
  for (const r of rows) {
    const holder = String(r.holder_id);
    (out[holder] ??= { total: Number(r.total), parts: [] }).parts.push(normalisePartOn(r));
  }
  return out;
}
