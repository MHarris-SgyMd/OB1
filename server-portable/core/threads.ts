// Work threads, read (SMD-3306 PR 7a-2a): the `thread` operation, and the threads fetch says a thought continues.
//
// A thread is the thoughts holding one standing subject key (111), in 120's order — created_at, ties by id, an undated
// thought last. Both reads find it from the subjects, not from 120's edges: the subjects define it, so a read is right
// on a brain db/threads.ts has not linked yet. The maintainer's decisions (2026-11-06) are read here: a superseded
// member stays in its thread and is labelled; a ticket's own row, rewritten in place, keeps its first place and shows
// its status now; a ticket's thread names the threads its board links reach, and no thread runs across one.

import { thoughtTitle } from "../thoughts.ts";
import { subjectKeyValid } from "../subject.ts";
import { ListCursorRefused, UUID_RE, type ThoughtStore, type ThreadLink, type ThreadPage, type ThreadTicket } from "../store.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import { parseThreadCursor, threadCursor } from "./list-cursor.ts";
import type { Input } from "./schemas.ts";

/** A member as the thread read shows it: its id, title, time and place, the thought superseding it, and a ticket row's ticket. */
export type ThreadMemberShown = { id: string; title: string; created_at: string | null; place: number; supersededBy: string | null; ticket: ThreadTicket | null };
/**
 * One thread as the read shows it: its key and size, the thought's place in it (an `id` read's, else null), the page
 * of members, whether members come before the page (`earlier`), the cursor past it (null at the thread's end), and a
 * ticket's linked threads.
 */
export type ThreadShown = { key: string; total: number; place: number | null; members: ThreadMemberShown[]; earlier: boolean; cursor: string | null; linked: ThreadLink[]; linkedMore: boolean };
/** The read: the thought it was asked about (null for a key's), and each thread — one for a key, one per subject for an id, none when it stands in no thread. */
export type ThreadResult = { id: string | null; threads: ThreadShown[] };

/**
 * A key as the caller wrote it, as 111 holds it: a ticket alone (`SMD-3306`) or with its prefix in any case is
 * `ticket:SMD-3306`; any other key is taken as written, trimmed. Null for what is no subject key (111's
 * subject_key_valid, mirrored by subjectKeyValid).
 */
export function threadKey(raw: string): string | null {
  const k = raw.trim();
  const ticket = /^(?:ticket:)?([A-Za-z][A-Za-z0-9]*-[0-9]+)$/i.exec(k);
  const key = ticket ? `ticket:${ticket[1].toUpperCase()}` : k;
  return subjectKeyValid(key) ? key : null;
}

/** The pages as the read shows them: each member's title and the thought superseding it (one read for all), the cursors, the places. */
async function shown(store: Pick<ThoughtStore, "supersededAmong">, pages: readonly ThreadPage[], placeOf: (key: string) => number | null): Promise<ThreadShown[]> {
  const superseded = await store.supersededAmong([...new Set(pages.flatMap((p) => p.members.map((m) => m.id)))]);
  return pages.map((p) => {
    const last = p.members[p.members.length - 1];
    return {
      key: p.key, total: p.total, place: placeOf(p.key),
      members: p.members.map((m) => ({ id: m.id, title: thoughtTitle(m.content, m.created_at), created_at: m.created_at, place: m.place, supersededBy: superseded[m.id] ?? null, ticket: m.ticket })),
      earlier: (p.members[0]?.place ?? 1) > 1,
      cursor: last && last.place < p.total ? threadCursor(last.at, last.id) : null,
      linked: p.links, linkedMore: p.linksMore,
    };
  });
}

export async function thread(ctx: Ctx, _principal: Principal, { key, id, after, limit }: Input<"thread">): Promise<Outcome<ThreadResult>> {
  const byKey = key !== undefined && key.trim() !== "", byId = id !== undefined && id.trim() !== "";
  if (byKey === byId) return refuse({ code: "REFUSED_THREAD_INPUT", retryable: false, problem: "key_or_id" });
  // A cursor continues one key's thread: an id's read has one per thread, each passed back with its key.
  if (after !== undefined && !byKey) return refuse({ code: "REFUSED_THREAD_INPUT", retryable: false, problem: "after_needs_key" });
  const store = await ctx.store();
  if (byKey) {
    const k = threadKey(key);
    if (k === null) return refuse({ code: "REFUSED_THREAD_INPUT", retryable: false, problem: "key_shape", value: key });
    const pos = after === undefined ? undefined : parseThreadCursor(after);
    if (pos === null) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "shape" });
    let page: ThreadPage;
    try {
      page = await store.threadPage(k, { limit, after: pos });
    } catch (e) {
      if (e instanceof ListCursorRefused) return refuse({ code: "REFUSED_CURSOR", retryable: false, value: after ?? "", reason: "shape" });
      throw e;
    }
    return ok({ id: null, threads: await shown(store, [page], () => null) });
  }
  const asked = (id ?? "").trim(), thought = asked.toLowerCase();
  if (!UUID_RE.test(thought)) return refuse({ code: "NOT_FOUND", retryable: false, id: asked });
  const places = await store.threadPlaces(thought);
  if (places.length === 0) return (await store.getThought(thought)) ? ok({ id: thought, threads: [] }) : refuse({ code: "NOT_FOUND", retryable: false, id: thought });
  // Around the thought: up to half the page before it, then it and the rest.
  const before = Math.ceil((limit - 1) / 2);
  const pages = await Promise.all(places.map((p) => store.threadPage(p.key, { limit, around: thought, before })));
  const at = new Map(places.map((p) => [p.key, p.place]));
  return ok({ id: thought, threads: await shown(store, pages, (k) => at.get(k) ?? null) });
}

/** A neighbour as fetch names it: its id and title, and the thought superseding it. */
export type ThreadNeighbourShown = { id: string; title: string; supersededBy: string | null };
/** A thread a fetched thought stands in: its key, the thought's place and the thread's size, the member it continues and the one continuing it. */
export type FetchedThread = { key: string; place: number; total: number; continues: ThreadNeighbourShown | null; continuedBy: ThreadNeighbourShown | null };

/**
 * fetch's threads: each thread the thought stands in, and its neighbours there. Null when they could not be read —
 * a role without thought_facets, a brain before 111 — said in the log, as the claimed label's failed read is; the
 * fetch goes on.
 */
export async function fetchedThreads(store: Pick<ThoughtStore, "threadPlaces" | "supersededAmong">, id: string): Promise<FetchedThread[] | null> {
  let places;
  try {
    places = await store.threadPlaces(id);
  } catch (e) {
    const err = e as { errno?: unknown; code?: unknown; message?: unknown };
    console.error(`threads: the work threads read failed (${String(err.errno ?? err.code ?? "no code")}): ${String(err.message ?? e).slice(0, 200)}; fetch carries threads: null`);
    return null;
  }
  if (places.length === 0) return [];
  const sides = places.flatMap((p) => [p.previous, p.next]).filter((n) => n !== null);
  const superseded = await store.supersededAmong([...new Set(sides.map((n) => n.id))]);
  const side = (n: (typeof sides)[number] | null): ThreadNeighbourShown | null =>
    n === null ? null : { id: n.id, title: thoughtTitle(n.content, n.created_at), supersededBy: superseded[n.id] ?? null };
  return places.map((p) => ({ key: p.key, place: p.place, total: p.total, continues: side(p.previous), continuedBy: side(p.next) }));
}
