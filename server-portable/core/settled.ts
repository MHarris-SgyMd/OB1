// Settled parts, read (SMD-4446 PR 3c): the accepted parts that stand on a thought, as fetch carries them.
//
// A settled part (151) is a statement of one thought that the other thought of a pair shows no longer holds, or is
// done. A reviewer's accept makes it stand: the thought is not superseded and not demoted, and a read of it says
// which of its statements a later record settled, what settled it, and the thought that did (the ticket's words for
// PR 3). One rule for every read, migration 157's: an accepted part stands on its thought while the thought's text
// still holds the statement, read as the part's identity reads one, so a statement edited out is on no read, and a
// pending, stale or rejected part never is. The parts of a thought come in the order its text says them.
//
// fetch gives each part whole: the statement (the thought's own words), the words that show it and the thought they
// are from, its title marked by its trust where it is outside text, as a relation's other thought is. It labels and
// never ranks: nothing here is read by a search's order.

import { thoughtTitle } from "../thoughts.ts";
import type { ThoughtStore } from "../store.ts";
import { PART_GROUP_WORDS, type PartGroup } from "../part-listing.ts";
import { PARTS_ON_FETCH, type PartOn, type PartsOn } from "../parts-on.ts";
import { TRUST, type Trust } from "./filter.ts";

/** The thought that shows a part: its id, title, time, trust (`ingested` for outside text) and the thought superseding it. */
export type SettledBy = { id: string; title: string; trust: Trust | null; created_at: string | null; supersededBy: string | null };
/**
 * A part as fetch shows it: its id; the group anything that acts on it reads, null for one this server does not
 * know (a brain migrated ahead); the writer's word, kept as data; the statement, the thought's own words; the words
 * that show it, the other thought's, and that thought (`otherIs` older or newer of the pair, by capture order); when
 * it was accepted; `editedSince`, the thought's text has moved since the part was judged, the statement still in it;
 * and `shownByInText`, the other thought's text still holds the words that show it.
 */
export type SettledShown = {
  id: string; group: PartGroup | null; word: string; statement: string; shownBy: string; otherIs: "older" | "newer"; by: SettledBy;
  acceptedAt: string | null; editedSince: boolean; shownByInText: boolean;
};
/** A thought's parts: the first shown, in the order its text says them, and how many more stand. */
export type SettledHit = { settled: SettledShown[]; settledMore: number };

const trustWord = (t: string | null): Trust | null => ((TRUST as readonly string[]).includes(t ?? "") ? t as Trust : null);
const groupWord = (g: string): PartGroup | null => (Object.hasOwn(PART_GROUP_WORDS, g) ? g as PartGroup : null);

const shown = (p: PartOn, superseded: Record<string, string>): SettledShown => ({
  id: p.id, group: groupWord(p.group), word: p.word, statement: p.statement, shownBy: p.shownBy, otherIs: p.otherIs,
  by: { id: p.other.id, title: thoughtTitle(p.other.head, p.other.created_at), trust: trustWord(p.other.trust), created_at: p.other.created_at, supersededBy: superseded[p.other.id] ?? null },
  acceptedAt: p.acceptedAt, editedSince: p.holderEdited, shownByInText: p.shownByInText,
});

/**
 * The settled label: per result, the accepted parts standing on it, the first `per` in its text's order and how many
 * more. One read for the page, and one for the thoughts superseding the ones that show them. Best-effort, as the
 * relations label is: a brain before 157, a role without settled_parts, or a read that fails gives null: not read,
 * which the reply says, and the log says why; a result with none is absent. It labels and never ranks.
 */
export async function settledOf(store: Pick<ThoughtStore, "settledPartsAmong" | "supersededAmong">, hits: readonly { id: string }[], per: number = PARTS_ON_FETCH): Promise<Record<string, SettledHit> | null> {
  const ids = hits.map((h) => h.id);
  const out: Record<string, SettledHit> = {};
  if (ids.length === 0) return out;
  let read: Record<string, PartsOn>, superseded: Record<string, string>;
  try {
    read = await store.settledPartsAmong(ids, per);
    const others = [...new Set(Object.values(read).flatMap((r) => r.parts.map((p) => p.other.id)))];
    superseded = others.length ? await store.supersededAmong(others) : {};
  } catch (e) {
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`settled: the settled parts read failed (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; results carry settled: null`);
    return null;
  }
  for (const [id, r] of Object.entries(read)) out[id] = { settled: r.parts.map((p) => shown(p, superseded)), settledMore: Math.max(0, r.total - r.parts.length) };
  return out;
}

/**
 * fetch's settled fields (ChatGPT's shape): only where the thought holds a standing part, as `relations` is carried,
 * so a thought with none keeps the shape exactly; `settled: null` when the read failed.
 */
export const settledResult = (all: Record<string, SettledHit> | null, id: string): { settled?: SettledShown[] | null; settledMore?: number } => {
  if (all === null) return { settled: null };
  const r = all[id];
  return r?.settled.length ? { settled: r.settled, ...(r.settledMore > 0 ? { settledMore: r.settledMore } : {}) } : {};
};
