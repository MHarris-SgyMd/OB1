// Settled parts, read (SMD-4446 PR 3c): the accepted parts that stand on a thought, as fetch carries them whole and
// as search_thoughts, search_thoughts_keyword and list_thoughts mark them on a page.
//
// A settled part (151) is a statement of one thought that the other thought of a pair shows no longer holds, or is
// done. A reviewer's accept makes it stand: the thought is not superseded and not demoted, and a read of it says
// which of its statements a later record settled, what settled it, and the thought that did (the ticket's words for
// PR 3). One rule for every read, migration 157's: an accepted part stands on its thought while the thought's text
// still holds the statement, read as the part's identity reads one, so a statement edited out is on no read, and a
// pending, stale or rejected part never is. The parts of a thought come in the order its text says them.
//
// fetch gives each part whole: the statement (the thought's own words), the words that show it and the thought they
// are from, its title marked by its trust where it is outside text, as a relation's other thought is. A search or
// list page gives the statement, which is the result's own text, and names the thought that shows it by its place on
// the page or its id: never its words or its title, as the relations label names another thought (SMD-2726, review
// pass 1: a label must not carry outside text into a read filtered to keep it out). The ChatGPT-shape search carries
// none; fetch has them. It labels and never ranks: nothing here is read by a search's order.

import { thoughtTitle } from "../thoughts.ts";
import type { ThoughtStore } from "../store.ts";
import { PART_GROUP_WORDS, type PartGroup } from "../part-listing.ts";
import { PARTS_ON_PAGE, type PartOn, type PartsOn } from "../parts-on.ts";
import { TRUST, type Trust } from "./filter.ts";

/** The thought that shows a part: its id, time, trust (`ingested` for outside text) and the thought superseding it; and, on fetch alone, its title. */
export type SettledBy = { id: string; title?: string; trust: Trust | null; created_at: string | null; supersededBy: string | null };
/**
 * A part as the reads show it: its id; the group anything that acts on it reads, null for one this server does not
 * know (a brain migrated ahead); the writer's word, kept as data; the statement, the thought's own words; the thought
 * that shows it (`otherIs` older or newer of the pair, by capture order); when it was accepted; `editedSince`, the
 * thought's text has moved since the part was judged, the statement still in it; and `shownByInText`, the other
 * thought's text still holds the words that show it. `shownBy`, those words, on fetch alone.
 */
export type SettledShown = {
  id: string; group: PartGroup | null; word: string; statement: string; shownBy?: string; otherIs: "older" | "newer"; by: SettledBy;
  acceptedAt: string | null; editedSince: boolean; shownByInText: boolean;
};
/** A thought's parts: the first shown, in the order its text says them, and how many more stand. */
export type SettledHit = { settled: SettledShown[]; settledMore: number };

const trustWord = (t: string | null): Trust | null => ((TRUST as readonly string[]).includes(t ?? "") ? t as Trust : null);
const groupWord = (g: string): PartGroup | null => (Object.hasOwn(PART_GROUP_WORDS, g) ? g as PartGroup : null);

/** A part as shown: with the other thought's words and title when `words` (fetch), without them on a page. */
const shown = (p: PartOn, superseded: Record<string, string>, words: boolean): SettledShown => ({
  id: p.id, group: groupWord(p.group), word: p.word, statement: p.statement, ...(words ? { shownBy: p.shownBy } : {}), otherIs: p.otherIs,
  by: { id: p.other.id, ...(words ? { title: thoughtTitle(p.other.head, p.other.created_at) } : {}), trust: trustWord(p.other.trust), created_at: p.other.created_at, supersededBy: superseded[p.other.id] ?? null },
  acceptedAt: p.acceptedAt, editedSince: p.holderEdited, shownByInText: p.shownByInText,
});

/**
 * The settled label: per result, the accepted parts standing on it, the first `per` in its text's order and how many
 * more: PARTS_ON_PAGE on a search or list page (no word of the other thought), PARTS_ON_FETCH on a fetch (`words`).
 * One read for the page, and one for the thoughts superseding the ones that show a part. Best-effort, as the relations
 * label is: a brain before 157, a role without settled_parts, or a read that fails gives null: not read, which the
 * reply says, and the log says why; a result with none is absent. It labels and never ranks.
 */
export async function settledOf(store: Pick<ThoughtStore, "settledPartsAmong" | "supersededAmong">, hits: readonly { id: string }[], per: number = PARTS_ON_PAGE, words = false): Promise<Record<string, SettledHit> | null> {
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
  for (const [id, r] of Object.entries(read)) out[id] = { settled: r.parts.map((p) => shown(p, superseded, words)), settledMore: Math.max(0, r.total - r.parts.length) };
  return out;
}

/** A result's settled fields where every page read carries them: null when the read failed, else the parts and the rest's count. */
export const settledLabel = (all: Record<string, SettledHit> | null, id: string): { settled: SettledShown[] | null; settledMore: number } =>
  all === null ? { settled: null, settledMore: 0 } : (all[id] ?? { settled: [], settledMore: 0 });
/**
 * fetch's settled fields (ChatGPT's shape): only where the thought holds a standing part, as `relations` is carried,
 * so a thought with none keeps the shape exactly; `settled: null` when the read failed.
 */
export const settledResult = (all: Record<string, SettledHit> | null, id: string): { settled?: SettledShown[] | null; settledMore?: number } => {
  if (all === null) return { settled: null };
  const r = all[id];
  return r?.settled.length ? { settled: r.settled, ...(r.settledMore > 0 ? { settledMore: r.settledMore } : {}) } : {};
};
