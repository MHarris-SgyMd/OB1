// The unreviewed marks' pure helpers (SMD-3671 PR 3, review pass 2): the items a priority's marks are about — the item
// itself, the open item its level is read from, the item it inherits from — keyed as 142 keys a finding's item. One
// place for the core's reads (reads.ts), plan_context's budget (plan.ts) and the words (render.ts), which each worked
// them out on their own; a leaf, so the renderer reaches no read.

import type { UnreviewedMark } from "../store.ts";

/** An item as a finding keys it: its kind and key. */
export type MarkItem = { kind: string; key: string };
/** Anything that carries marks: a search result's priority, an agenda item, a board ticket. */
export type Markable = MarkItem & {
  unreviewed?: UnreviewedMark;
  fromItem?: { key: string; unreviewed?: UnreviewedMark } | null;
  inheritedFrom?: { kind: string; key: string; unreviewed?: UnreviewedMark } | null;
};

export const itemKey = (i: MarkItem) => `${i.kind}:${i.key}`;

/** A priority's marks with the items they are about: its own, then its level's sources. */
export const marksOn = (p: Markable): { item: MarkItem; mark: UnreviewedMark | undefined }[] => [
  { item: { kind: p.kind, key: p.key }, mark: p.unreviewed },
  ...(p.fromItem ? [{ item: { kind: "item", key: p.fromItem.key }, mark: p.fromItem.unreviewed }] : []),
  ...(p.inheritedFrom ? [{ item: { kind: p.inheritedFrom.kind, key: p.inheritedFrom.key }, mark: p.inheritedFrom.unreviewed }] : []),
];

/** The distinct items, by `kind:key`, whose marks among these were not checked (null). */
const unreadItems = (ps: readonly Markable[]): Set<string> =>
  new Set(ps.flatMap(marksOn).filter((m) => m.mark === null).map((m) => itemKey(m.item)));

/**
 * Whether these marks show a read that failed (review passes 3 and 5): a null mark on an item not among those past the
 * read's reach. One rule for the words and for plan_context's note, so the value and the text agree.
 */
export const showsFailure = (marks: readonly Markable[], unchecked: readonly MarkItem[] = []): boolean => {
  const past = new Set(unchecked.map(itemKey));
  return [...unreadItems(marks)].some((k) => !past.has(k));
};
