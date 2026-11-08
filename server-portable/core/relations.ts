// Judged relations, read (SMD-2726; SMD-3306 PR 7a-2b): the `relations` operation, and the relations every read of a
// thought carries.
//
// A relation is the consolidation judge's word on a pair of near neighbours (084, 102's distinct): related, evolves,
// duplicate or distinct, a facet on the newer thought naming the older, with the judge's confidence and a lineage row
// at the two texts judged. Both reads show it from either side, strongest first. The maintainer's decisions
// (2026-11-07) are read here: every word shows, distinct included; a relation whose text moved since it was judged
// shows, marked `stale`, until SMD-2726's rebuild arm closes it; and the judge's alone — a work thread's edges (origin
// `thread`, 120) are the thread read's and fetch's `threads`.

import { thoughtTitle } from "../thoughts.ts";
import { ListCursorRefused, RELATIONS_SHOWN, UUID_RE, type RelationEdge, type RelationsOf, type RelationWord, type ThoughtStore } from "../store.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import { parseRelationsCursor, relationsCursor } from "./list-cursor.ts";
import type { Input } from "./schemas.ts";

/**
 * A relation as the reads show it: its id and word, the other thought — its id, title, time and the thought
 * superseding it — and whether that thought is the older or the newer of the pair, the judge's confidence, when it was
 * judged, and `stale` when either text moved since.
 */
export type RelationShown = {
  id: string; relation: RelationWord; otherIs: "older" | "newer";
  other: { id: string; title: string; created_at: string | null; supersededBy: string | null };
  confidence: number | null; judgedAt: string | null; stale: boolean;
};
/** A result's relations: the first shown, and how many more stand. */
export type RelationsHit = { relations: RelationShown[]; relationsMore: number };
/** The `relations` read: the thought, how many relations stand under the word asked for, the page, and the cursor past it (null at the end). */
export type RelationsResult = { id: string; relation: RelationWord | null; total: number; relations: RelationShown[]; cursor: string | null };

/** The pages as the reads show them: each other thought's title and the thought superseding it, one read for all. */
async function shown(store: Pick<ThoughtStore, "supersededAmong">, pages: readonly RelationsOf[]): Promise<RelationShown[][]> {
  const superseded = await store.supersededAmong([...new Set(pages.flatMap((p) => p.edges.map((e) => e.other.id)))]);
  return pages.map((p) => p.edges.map((e: RelationEdge) => ({
    id: e.id, relation: e.relation, otherIs: e.otherIs,
    other: { id: e.other.id, title: thoughtTitle(e.other.content, e.other.created_at), created_at: e.other.created_at, supersededBy: superseded[e.other.id] ?? null },
    confidence: e.confidence, judgedAt: e.judgedAt, stale: e.stale,
  })));
}

/**
 * The relations label: per result, its standing judged relations, the first `per` strongest and how many more —
 * RELATIONS_SHOWN on a search or list page, RELATIONS_FETCHED on a fetch. One read for the page. Best-effort, as the
 * claimed label is: a brain before 084, a role without thought_facets or derivations, or a read that fails gives null
 * — not read, which the replies say, and the log says why; a result with none, `[]`. It labels and never ranks.
 */
export async function relationsOf(store: Pick<ThoughtStore, "relationsAmong" | "supersededAmong">, hits: readonly { id: string }[], per: number = RELATIONS_SHOWN): Promise<Record<string, RelationsHit> | null> {
  const ids = hits.map((h) => h.id);
  const out: Record<string, RelationsHit> = {};
  if (ids.length === 0) return out;
  let read: Record<string, RelationsOf>;
  try {
    read = await store.relationsAmong(ids, per);
  } catch (e) {
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`relations: the judged relations read failed (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; results carry relations: null`);
    return null;
  }
  const keys = Object.keys(read);
  const pages = await shown(store, keys.map((k) => read[k]));
  keys.forEach((k, i) => { out[k] = { relations: pages[i], relationsMore: Math.max(0, read[k].total - pages[i].length) }; });
  return out;
}

/** A result's relations fields where every read carries them: null when the read failed, else the relations and the rest's count. */
export const relationsLabel = (all: Record<string, RelationsHit> | null, id: string): { relations: RelationShown[] | null; relationsMore: number } =>
  all === null ? { relations: null, relationsMore: 0 } : (all[id] ?? { relations: [], relationsMore: 0 });
/**
 * The compat shapes' relations fields (search, fetch): only where the thought has a relation, as `claimed` is carried,
 * so every other result keeps ChatGPT's shape exactly; `relations: null` on every result when the read failed.
 */
export const relationsResult = (all: Record<string, RelationsHit> | null, id: string): { relations?: RelationShown[] | null; relationsMore?: number } => {
  if (all === null) return { relations: null };
  const r = all[id];
  return r?.relations.length ? { relations: r.relations, ...(r.relationsMore > 0 ? { relationsMore: r.relationsMore } : {}) } : {};
};

export async function relations(ctx: Ctx, _principal: Principal, { id, relation, after, limit }: Input<"relations">): Promise<Outcome<RelationsResult>> {
  const asked = id.trim(), thought = asked.toLowerCase();
  if (!UUID_RE.test(thought)) return refuse({ code: "NOT_FOUND", retryable: false, id: asked });
  const pos = after === undefined ? undefined : parseRelationsCursor(after);
  if (pos === null) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "shape" });
  const store = await ctx.store();
  if (!(await store.getThought(thought))) return refuse({ code: "NOT_FOUND", retryable: false, id: thought });
  let page: RelationsOf;
  try {
    // One past the page says whether more follow it.
    page = await store.relationsPage(thought, { relation, limit: limit + 1, after: pos });
  } catch (e) {
    if (e instanceof ListCursorRefused) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "shape" });
    throw e;
  }
  const edges = page.edges.slice(0, limit), more = page.edges.length > limit;
  const [rows] = await shown(store, [{ total: page.total, edges }]);
  return ok({ id: thought, relation: relation ?? null, total: page.total, relations: rows, cursor: more ? relationsCursor(edges[edges.length - 1].position) : null });
}
