// Judged relations, read (SMD-2726; SMD-3306 PR 7a-2b): the `relations` operation, and the relations every read of a
// thought carries.
//
// A relation is the consolidation judge's word on a pair of near neighbours (084, 102's distinct): related, evolves,
// duplicate or distinct, a facet on the newer thought naming the older, with the judge's confidence and a lineage row
// at the two texts judged. Both reads show it from either side, strongest first. The maintainer's decisions are read
// here. From 2026-11-07: every word shows, distinct included; a relation whose text moved since it was judged shows,
// marked `stale`, until SMD-2726's rebuild arm closes it; and the judge's alone — a work thread's edges (origin
// `thread`, 120) are the thread read's and fetch's `threads`. From review pass 1: a search or list page's labels name
// the other thought by its id alone, never its title — its words crowded the page (most of a page's relations name
// another hit on it) and carried outside text into reads filtered to keep it out — and the ChatGPT-shape search carries
// none; fetch and the `relations` read give the titles, an outside text's marked by its trust.

import { thoughtTitle } from "../thoughts.ts";
import { ListCursorRefused, RELATIONS_SHOWN, UUID_RE, type RelationEdge, type RelationsOf, type RelationWord, type ThoughtStore } from "../store.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { TRUST, type Trust } from "./filter.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import { parseRelationsCursor, relationsCursor } from "./list-cursor.ts";
import type { Input } from "./schemas.ts";

/** The other thought of a relation: its id, time, trust (`ingested` for outside text) and the thought superseding it — and, on fetch and the `relations` read alone, its title. */
export type RelatedThought = { id: string; title?: string; trust: Trust | null; created_at: string | null; supersededBy: string | null };
/**
 * A relation as the reads show it: its id and word, the other thought, whether that thought is the older or the newer
 * of the pair, the judge's confidence, when it was last judged, and `stale` when either text moved since.
 */
export type RelationShown = { id: string; relation: RelationWord; otherIs: "older" | "newer"; other: RelatedThought; confidence: number | null; judgedAt: string | null; stale: boolean };
/** A result's relations: the first shown, and how many more stand. */
export type RelationsHit = { relations: RelationShown[]; relationsMore: number };
/** The `relations` read: the thought, how many relations stand under the word asked for, the page, and the cursor past it (null at the end). */
export type RelationsResult = { id: string; relation: RelationWord | null; total: number; relations: RelationShown[]; cursor: string | null };

const trustWord = (t: string | null): Trust | null => ((TRUST as readonly string[]).includes(t ?? "") ? t as Trust : null);

/** The pages as the reads show them: each other thought's trust and the thought superseding it (one read for all), and its title when `titles`. */
async function shown(store: Pick<ThoughtStore, "supersededAmong">, pages: readonly RelationsOf[], titles: boolean): Promise<RelationShown[][]> {
  const superseded = await store.supersededAmong([...new Set(pages.flatMap((p) => p.edges.map((e) => e.other.id)))]);
  return pages.map((p) => p.edges.map((e: RelationEdge) => ({
    id: e.id, relation: e.relation, otherIs: e.otherIs,
    other: {
      id: e.other.id, ...(titles ? { title: thoughtTitle(e.other.content, e.other.created_at) } : {}), trust: trustWord(e.other.trust),
      created_at: e.other.created_at, supersededBy: superseded[e.other.id] ?? null,
    },
    confidence: e.confidence, judgedAt: e.judgedAt, stale: e.stale,
  })));
}

/**
 * The relations label: per result, its standing judged relations, the first `per` strongest and how many more —
 * RELATIONS_SHOWN on a search or list page (no titles), RELATIONS_FETCHED on a fetch (`titles`). One read for the
 * page. Best-effort, as the claimed label is: a brain before 084, a role without thought_facets or derivations, or a
 * read that fails — the superseding read among it (review pass 1) — gives null: not read, which the replies say, and
 * the log says why; a result with none, `[]`. It labels and never ranks.
 */
export async function relationsOf(store: Pick<ThoughtStore, "relationsAmong" | "supersededAmong">, hits: readonly { id: string }[], per: number = RELATIONS_SHOWN, titles = false): Promise<Record<string, RelationsHit> | null> {
  const ids = hits.map((h) => h.id);
  const out: Record<string, RelationsHit> = {};
  if (ids.length === 0) return out;
  let read: Record<string, RelationsOf>, pages: RelationShown[][];
  const keys: string[] = [];
  try {
    read = await store.relationsAmong(ids, per);
    keys.push(...Object.keys(read));
    pages = await shown(store, keys.map((k) => read[k]), titles);
  } catch (e) {
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`relations: the judged relations read failed (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; results carry relations: null`);
    return null;
  }
  keys.forEach((k, i) => { out[k] = { relations: pages[i], relationsMore: Math.max(0, read[k].total - pages[i].length) }; });
  return out;
}

/** A result's relations fields where every read carries them: null when the read failed, else the relations and the rest's count. */
export const relationsLabel = (all: Record<string, RelationsHit> | null, id: string): { relations: RelationShown[] | null; relationsMore: number } =>
  all === null ? { relations: null, relationsMore: 0 } : (all[id] ?? { relations: [], relationsMore: 0 });
/**
 * fetch's relations fields (ChatGPT's shape): only where the thought has a relation, as `claimed` is carried, so a
 * thought with none keeps the shape exactly; `relations: null` when the read failed.
 */
export const relationsResult = (all: Record<string, RelationsHit> | null, id: string): { relations?: RelationShown[] | null; relationsMore?: number } => {
  if (all === null) return { relations: null };
  const r = all[id];
  return r?.relations.length ? { relations: r.relations, ...(r.relationsMore > 0 ? { relationsMore: r.relationsMore } : {}) } : {};
};

export async function relations(ctx: Ctx, _principal: Principal, { id, relation, after, limit }: Input<"relations">): Promise<Outcome<RelationsResult>> {
  const asked = id.trim(), thought = asked.toLowerCase();
  if (!UUID_RE.test(thought)) return refuse({ code: "NOT_FOUND", retryable: false, id: asked });
  const cur = after === undefined ? undefined : parseRelationsCursor(after);
  if (cur === null) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "shape" });
  // A cursor read under another thought or word would page this one from a position in another order (review pass 1).
  if (cur && (cur.thought !== thought || cur.relation !== (relation ?? null))) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "filters" });
  const store = await ctx.store();
  if (!(await store.getThought(thought))) return refuse({ code: "NOT_FOUND", retryable: false, id: thought });
  let page: RelationsOf;
  try {
    // One past the page says whether more follow it.
    page = await store.relationsPage(thought, { relation, limit: limit + 1, after: cur && { rank: cur.rank, at: cur.at, id: cur.id } });
  } catch (e) {
    if (e instanceof ListCursorRefused) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "shape" });
    throw e;
  }
  const edges = page.edges.slice(0, limit), more = page.edges.length > limit;
  const [rows] = await shown(store, [{ total: page.total, edges }], true);
  const last = edges[edges.length - 1];
  return ok({ id: thought, relation: relation ?? null, total: page.total, relations: rows, cursor: more ? relationsCursor({ thought, relation: relation ?? null, ...last.position }) : null });
}
