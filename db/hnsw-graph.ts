#!/usr/bin/env bun
/**
 * hnsw-graph.ts — read a pgvector HNSW index page by page and say which live
 * rows its entry point cannot reach.
 *
 * A vector search is a walk over the index's graph from its entry point; a
 * row whose element no reachable element points at is invisible to every
 * `match_thoughts` call that walks (SMD-1632). The walk itself cannot show
 * that: a short answer from an approximate index looks the same whether the
 * graph has a hole or the beam stopped early. This reads the pages the walk
 * reads — pgvector 0.8.x's on-disk layout, through pageinspect's
 * `get_raw_page` — and computes reachability from the graph itself: every
 * element, its heap TIDs, its neighbour lists at every level, the meta page's
 * entry point; then a breadth-first walk over the level-0 lists from the
 * entry, and a join to the table so "live" means a row the session can see.
 *
 *   bun hnsw-graph.ts --url $DATABASE_URL                       # both shipped indexes
 *   bun hnsw-graph.ts --url $DATABASE_URL --index thoughts_embedding_idx --json
 *
 * pageinspect is superuser-only, so this is a diagnostic for a database you
 * administer — the test suites' containers, a local brain — not a check the
 * server can run on a managed database. No production check is built on it: a
 * real corpus does not have the hole (SMD-1632, FORK.md change 79), so one
 * would never fire and would cost every capture a walk. The layout decoded here
 * is pgvector's `HnswMetaPageData`, `HnswElementTupleData` and
 * `HnswNeighborTupleData` (src/hnsw.h at 0.8.6); the magic number and the meta
 * page version are checked, and an index of another layout is refused rather
 * than misread.
 */
import { SQL } from "bun";

/** A `(blkno,offno)` index TID as text — the key every map here uses. */
export type Tid = string;

export type HnswMeta = {
  magic: number;
  version: number;
  dimensions: number;
  m: number;
  efConstruction: number;
  /** null: the index has no entry point (empty, or vacuum found no live element to name). */
  entry: Tid | null;
  entryLevel: number;
  insertPage: number;
};

export type HnswElement = {
  tid: Tid;
  blkno: number;
  offno: number;
  level: number;
  deleted: boolean;
  version: number;
  /** Heap TIDs this element stands for (pgvector merges up to ten identical vectors into one element). */
  heaptids: string[];
  neighborTid: Tid;
  /** Neighbour lists by level, `neighbors[0]` the level-0 list; invalid slots omitted. */
  neighbors: Tid[][];
  /** Slots the level-0 list has, whether or not filled: 2m. */
  level0Slots: number;
};

export type HnswGraph = {
  index: string;
  pages: number;
  meta: HnswMeta;
  elements: Map<Tid, HnswElement>;
};

const HNSW_MAGIC = 0xa953a953;
const HNSW_VERSION = 1; // pgvector's HnswMetaPageData.version; a different one is a layout this decoder was not written for
const HNSW_HEAPTIDS = 10;
const ELEMENT_TUPLE = 1;
const NEIGHBOR_TUPLE = 2;
const PAGE_HEADER = 24; // MAXALIGN(SizeOfPageHeaderData)
const ITEM_POINTER = 6;

/** Bun hands bytea back as a Uint8Array; a text-mode driver as `\x…`. Take both. */
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && v.startsWith("\\x")) return Uint8Array.from(Buffer.from(v.slice(2), "hex"));
  throw new Error(`get_raw_page returned ${typeof v}, not bytea`);
}

function tidAt(b: Uint8Array, o: number): Tid | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hi = view.getUint16(o, true);
  const lo = view.getUint16(o + 2, true);
  const posid = view.getUint16(o + 4, true);
  if (posid === 0) return null; // ItemPointerIsValid: a zero offset is the invalid marker
  return `(${(hi << 16) | lo},${posid})`;
}

export function decodeMeta(page: Uint8Array): HnswMeta {
  const v = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const o = PAGE_HEADER;
  const magic = v.getUint32(o, true);
  if (magic !== HNSW_MAGIC) throw new Error(`not an hnsw meta page (magic 0x${magic.toString(16)}, expected 0x${HNSW_MAGIC.toString(16)})`);
  const version = v.getUint32(o + 4, true);
  if (version !== HNSW_VERSION) throw new Error(`hnsw meta page version ${version}, expected ${HNSW_VERSION} — this decoder is written for pgvector 0.8.x's layout and refuses another rather than misreading it`);
  const entryBlkno = v.getUint32(o + 16, true);
  const entryOffno = v.getUint16(o + 20, true);
  return {
    magic,
    version,
    dimensions: v.getUint32(o + 8, true),
    m: v.getUint16(o + 12, true),
    efConstruction: v.getUint16(o + 14, true),
    entry: entryBlkno === 0xffffffff || entryOffno === 0 ? null : `(${entryBlkno},${entryOffno})`,
    entryLevel: v.getInt16(o + 22, true),
    insertPage: v.getUint32(o + 24, true),
  };
}

type Item = { offno: number; off: number; len: number; flags: number };

function items(page: Uint8Array): Item[] {
  const v = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const lower = v.getUint16(12, true);
  const out: Item[] = [];
  for (let p = PAGE_HEADER, i = 1; p + 4 <= lower; p += 4, i++) {
    const raw = v.getUint32(p, true);
    const off = raw & 0x7fff;
    const flags = (raw >>> 15) & 3;
    const len = (raw >>> 17) & 0x7fff;
    if (flags === 1 && len > 0) out.push({ offno: i, off, len, flags }); // LP_NORMAL only
  }
  return out;
}

/**
 * Decode one element page: its element tuples, and the neighbour tuples on
 * it keyed by TID so an element's list can be found wherever pgvector put it
 * (the same page, normally; a later one when the element's page was full).
 */
export function decodePage(blkno: number, page: Uint8Array, m: number): { elements: HnswElement[]; neighborTuples: Map<Tid, { version: number; count: number; tids: (Tid | null)[] }> } {
  const v = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const elements: HnswElement[] = [];
  const neighborTuples = new Map<Tid, { version: number; count: number; tids: (Tid | null)[] }>();
  for (const it of items(page)) {
    const type = v.getUint8(it.off);
    if (type === ELEMENT_TUPLE) {
      const heaptids: string[] = [];
      for (let i = 0; i < HNSW_HEAPTIDS; i++) {
        const t = tidAt(page, it.off + 4 + i * ITEM_POINTER);
        if (t === null) break; // pgvector stops at the first unused slot
        heaptids.push(t);
      }
      elements.push({
        tid: `(${blkno},${it.offno})`,
        blkno,
        offno: it.offno,
        level: v.getUint8(it.off + 1),
        deleted: v.getUint8(it.off + 2) !== 0,
        version: v.getUint8(it.off + 3),
        heaptids,
        neighborTid: tidAt(page, it.off + 4 + HNSW_HEAPTIDS * ITEM_POINTER) ?? "(invalid)",
        neighbors: [],
        level0Slots: 2 * m,
      });
    } else if (type === NEIGHBOR_TUPLE) {
      const count = v.getUint16(it.off + 2, true);
      const tids: (Tid | null)[] = [];
      for (let i = 0; i < count; i++) tids.push(tidAt(page, it.off + 4 + i * ITEM_POINTER));
      neighborTuples.set(`(${blkno},${it.offno})`, { version: v.getUint8(it.off + 1), count, tids });
    }
  }
  return { elements, neighborTuples };
}

/**
 * Read the whole index. `maxPages` bounds the read (a 1024-dimension element is
 * a page, so a million-row index is millions of pages): over it, the graph is
 * refused with the count, since a partial read would report every element
 * whose neighbours lie past the bound as unreachable.
 */
export async function readHnswGraph(sql: SQL, index: string, opts: { maxPages?: number } = {}): Promise<HnswGraph> {
  const maxPages = opts.maxPages ?? 20_000;
  const [{ pages }] = (await sql`SELECT (pg_relation_size(${index}::regclass) / current_setting('block_size')::int)::int AS pages`) as { pages: number }[];
  if (pages > maxPages) throw new Error(`${index} has ${pages} pages, over the ${maxPages}-page bound of this reader — pass a larger maxPages, or judge reachability from the walk instead (a search of a live row's own vector that does not return it)`);
  const [metaRow] = (await sql`SELECT get_raw_page(${index}, 0) AS p`) as { p: unknown }[];
  const meta = decodeMeta(bytes(metaRow.p));
  const elements = new Map<Tid, HnswElement>();
  const neighborTuples = new Map<Tid, { version: number; count: number; tids: (Tid | null)[] }>();
  // Every page in one statement: pageinspect reads each with a share lock and
  // releases it, so this is a snapshot page by page, not of the index — a
  // concurrent insert can appear on a later page with its neighbours' lists
  // not yet pointing back, and reads as unreachable until the next read.
  const rows = (await sql`SELECT b AS blkno, get_raw_page(${index}, b) AS p FROM generate_series(1, ${pages - 1}) AS b`) as { blkno: number; p: unknown }[];
  for (const r of rows) {
    const d = decodePage(Number(r.blkno), bytes(r.p), meta.m);
    for (const e of d.elements) elements.set(e.tid, e);
    for (const [k, n] of d.neighborTuples) neighborTuples.set(k, n);
  }
  for (const e of elements.values()) {
    const n = neighborTuples.get(e.neighborTid);
    if (!n) continue; // a deleted element's list may have been reused; a half-written insert
    // pgvector lays the levels out top-down: m slots per level above 0, then
    // 2m for level 0 — `start = (level - lc) * m`, `lm = lc == 0 ? 2m : m`.
    const lists: Tid[][] = [];
    for (let lc = e.level; lc >= 0; lc--) {
      const start = (e.level - lc) * meta.m;
      const lm = lc === 0 ? 2 * meta.m : meta.m;
      lists[lc] = n.tids.slice(start, start + lm).filter((t): t is Tid => t !== null);
    }
    e.neighbors = lists;
  }
  return { index, pages, meta, elements };
}

/**
 * A SOUND over-approximation of the elements a query walk can reach from the
 * entry point: BFS following each element's neighbour lists at EVERY level.
 *
 * A search does not walk level 0 from the meta entry point. It starts at the
 * entry on the top level, descends the upper lists greedily to a level-0 node
 * near the query, and searches level 0 from THERE — a start node that varies
 * by query. So the elements reachable over level 0 from the entry alone
 * under-count: they miss everything a query reaches through a different
 * level-0 start (a false "unreachable", which the soundness check in
 * `test-live.ts` [17] caught). Every node a query can reach is reachable from
 * the entry by following edges of the appropriate level — the descent's upper
 * edges, then the level-0 edges out of any node it lands on — so following ALL
 * levels' edges from the entry is a superset of any query's reached set, and
 * an element outside it is unreachable by every walk. Deleted elements are not
 * followed, which is exact rather than an approximation: pgvector's vacuum sets
 * an element's `deleted` flag and invalidates its neighbour tuple's TIDs in the
 * same pass (`hnswvacuum.c` MarkDeleted), so a `deleted` element has no outbound
 * edges to follow; a heap-dead element the vacuum has not reached is not marked
 * `deleted`, still carries valid edges, and IS followed, as the live search
 * follows it.
 *
 * Soundness assumes a QUIESCENT index. `readHnswGraph` reads the pages one at a
 * time under a share lock, not in one snapshot, so under a concurrent insert or
 * vacuum the picture is inconsistent and a row can read as unreachable while a
 * live search reaches it — fine for a diagnostic on a database you administer
 * and for [17]'s freshly built corpus, not a check to run against a brain
 * taking writes.
 */
export function reachableFromEntry(g: HnswGraph): Set<Tid> {
  const seen = new Set<Tid>();
  if (g.meta.entry === null) return seen;
  const queue: Tid[] = [g.meta.entry];
  seen.add(g.meta.entry);
  while (queue.length > 0) {
    const e = g.elements.get(queue.shift()!);
    if (!e || e.deleted) continue;
    for (const list of e.neighbors) {
      for (const n of list ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
  }
  return seen;
}

/** How many neighbour lists (any level) name each element: an element nobody names is reachable only as the entry point. */
export function inboundCounts(g: HnswGraph): Map<Tid, number> {
  const counts = new Map<Tid, number>();
  for (const e of g.elements.values()) {
    if (e.deleted) continue;
    for (const list of e.neighbors) for (const n of list ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

export type ReachabilityReport = {
  index: string;
  table: string;
  pages: number;
  entry: Tid | null;
  entryLevel: number;
  elements: number;
  deleted: number;
  /** Elements with at least one heap TID (pgvector's "live": vacuum has not emptied them). */
  withHeapTids: number;
  /** Elements one of whose heap TIDs is a row this session can see. */
  visible: number;
  reachable: number;
  /** Visible elements the entry point's level-0 component does not contain. */
  unreachableVisible: { tid: Tid; level: number; inbound: number; outbound: number; heaptids: string[] }[];
  /** Rows with a vector that no element stands for at all (an index missing entries — not a graph hole). */
  rowsWithoutElement: number;
};

/**
 * The report: the graph read, joined to the table's visible rows by ctid.
 * `column` is the indexed vector column (the shipped indexes are on
 * `embedding`); a row whose vector is NULL has no element and is not counted.
 */
export async function reachabilityReport(sql: SQL, index: string, table: string, column = "embedding", opts: { maxPages?: number } = {}): Promise<ReachabilityReport> {
  const g = await readHnswGraph(sql, index, opts);
  const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = (await sql.unsafe(`SELECT ctid::text AS ctid FROM ${ident(table)} WHERE ${ident(column)} IS NOT NULL`)) as { ctid: string }[];
  const visibleTids = new Set(rows.map((r) => r.ctid));
  const reach = reachableFromEntry(g);
  const inbound = inboundCounts(g);
  const covered = new Set<string>();
  let deleted = 0, withHeapTids = 0, visible = 0, reachableVisible = 0;
  const unreachableVisible: ReachabilityReport["unreachableVisible"] = [];
  for (const e of g.elements.values()) {
    if (e.deleted) { deleted++; continue; }
    if (e.heaptids.length > 0) withHeapTids++;
    const mine = e.heaptids.filter((t) => visibleTids.has(t));
    if (mine.length === 0) continue;
    visible++;
    for (const t of mine) covered.add(t);
    if (reach.has(e.tid)) reachableVisible++;
    else unreachableVisible.push({ tid: e.tid, level: e.level, inbound: inbound.get(e.tid) ?? 0, outbound: (e.neighbors[0] ?? []).length, heaptids: mine });
  }
  return {
    index, table, pages: g.pages, entry: g.meta.entry, entryLevel: g.meta.entryLevel,
    elements: g.elements.size, deleted, withHeapTids, visible, reachable: reachableVisible,
    unreachableVisible, rowsWithoutElement: rows.length - covered.size,
  };
}

/** The shipped indexes and the tables they are on. */
export const SHIPPED_INDEXES: { index: string; table: string }[] = [
  { index: "thoughts_embedding_idx", table: "thoughts" },
  { index: "thought_chunks_embedding_idx", table: "thought_chunks" },
];

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const url = flag("--url") ?? process.env.DATABASE_URL;
  if (!url) { console.error("usage: bun hnsw-graph.ts --url postgres://… [--index name --table name] [--json]"); process.exit(2); }
  const only = flag("--index");
  const targets = only ? [{ index: only, table: flag("--table") ?? (SHIPPED_INDEXES.find((s) => s.index === only)?.table ?? "thoughts") }] : SHIPPED_INDEXES;
  const sql = new SQL({ url, max: 1 });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pageinspect`;
    const reports: ReachabilityReport[] = [];
    for (const t of targets) reports.push(await reachabilityReport(sql, t.index, t.table));
    if (args.includes("--json")) console.log(JSON.stringify(reports, null, 2));
    else {
      for (const r of reports) {
        const hole = r.unreachableVisible.length;
        console.log(`${r.index}: ${r.pages} pages, ${r.elements} elements (${r.deleted} deleted, ${r.withHeapTids} with heap TIDs), entry ${r.entry ?? "none"} at level ${r.entryLevel}`);
        console.log(`  ${r.visible} element(s) stand for visible rows of ${r.table}; ${r.reachable} reachable from the entry point${hole ? `, ${hole} NOT:` : ""}${r.rowsWithoutElement ? ` — ${r.rowsWithoutElement} row(s) with a vector have no element` : ""}`);
        for (const u of r.unreachableVisible) console.log(`    ${u.tid} level ${u.level}: ${u.inbound} inbound, ${u.outbound} outbound; heap ${u.heaptids.join(" ")}`);
      }
    }
    process.exit(reports.some((r) => r.unreachableVisible.length > 0 || r.rowsWithoutElement > 0) ? 1 : 0);
  } finally {
    await sql.close();
  }
}
