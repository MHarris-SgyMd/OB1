#!/usr/bin/env bun
/**
 * brain-compare.ts — one "how do these two brains differ" call (SMD-2109).
 *
 * SMD-1806 runs the fork as three brains (stable :8010, canary :8011, working)
 * over one corpus. That only pays off if you can answer, in one step, "are these
 * two telling me the same thing, and if not, why?" — version, migration, corpus
 * freshness, retrieval. The pieces existed and nothing composed them: brain_info
 * (SMD-2041) reports ONE brain; tier.ts --diff (slice 2) is the merge-time replay
 * path, not "point these two live brains at each other now". A 2026-09-24 grooming
 * session built the comparison by hand — two searches, a stats compare, manual
 * staleness reasoning — and only then noticed the canary's corpus was frozen a day
 * behind (407 vs 597 thoughts) and still calling two started tickets Backlog.
 *
 *   bun db/tier.ts --compare <a> <b> [--replay --queries-file <path>] [--json]
 *
 * A brain reference <a>/<b> is either an http(s):// base URL (its read key from
 * --a-key/--b-key, OB1_COMPARE_KEY, or the URL's own ?key=), or a Claude Code MCP
 * connector NAME (open-brain, open-brain-canary) resolved through `claude mcp get`
 * — the same base URL and x-brain-key an operator already registered. Either way
 * the compare reaches each brain the way a client does: as ONE HTTP process by URL
 * (CLAUDE.md), with a read key, never Postgres, and never prints a key. The default
 * compare writes nothing (a keyed GET /health and the read-only thought_stats).
 * `--replay` issues REAL searches, which a brain running with OB1_QUERY_LOG=on
 * records in query_log — telemetry (migration 034), never the thoughts corpus —
 * exactly as any client's search does; the retrieval section says so.
 *
 * What it reads and why it is HTTP, not SQL:
 *   • Identity — the keyed GET /health body is the whole brain_info record as JSON
 *     (version, commit, tier, releaseRange, the tree's latest migration against the
 *     ledger's highest, schema version, embedding, pgvector, counts, size). version
 *     and commit are the server PROCESS's build facts, in no database — only the
 *     running brain can say them, so identity is an HTTP read by nature.
 *   • Freshness — counts.thoughts and the migration delta come from that same body
 *     (machine-readable); newest capture is read best-effort from thought_stats.
 *   • Id set — list_thought_ids (SMD-2244) enumerates each corpus's ids, id-only,
 *     with a first-page md5 digest that lets an identical pair skip enumeration;
 *     the two sets are diffed for the EXACT "which thoughts one holds and the other
 *     does not", not the thought-count stand-in the count line still shows.
 *   • Retrieval — the two search tools, called against both brains over the same
 *     queries, their returned ids diffed. The VECTOR arm needs no model here: the
 *     brain embeds the query server-side, so search_thoughts (hybrid) replays it.
 *
 * One signal a compare would ideally carry lives only in a brain's Postgres and is
 * NOT reachable over the read surface, so this HTTP-only compare names it as out of
 * reach rather than guessing: a replay sourced from stable's own query_log (this
 * replays a supplied query set instead; SMD-2245 adds the surface). The board-sync
 * watermark is likewise deferred (SMD-2109 notes). The EXACT id-set difference,
 * once deferred here too, now rides list_thought_ids (SMD-2244).
 *
 * Until SMD-2037 lands, a refreshed brain runs at pgvector's default HNSW scan
 * settings, so a hybrid-arm difference here can be GUC-induced rather than a real
 * corpus delta; the retrieval section says so.
 */

import type { BrainInfo } from "../server-portable/brain-info.ts";

// ---------------------------------------------------------------------------
// Reaching a brain — a reference resolves to a base URL and a read key.
// ---------------------------------------------------------------------------

/** A brain the caller can reach: where it is, the key to read it, and the name to print (never the key). */
export interface BrainEndpoint {
  /** The label shown in the report — the connector name, or the URL's host. */
  label: string;
  /** The MCP base URL, no trailing slash and no ?key= (the key rides a header). */
  base: string;
  /** The read key sent as x-brain-key; never printed. */
  key: string;
}

/** Strip a trailing slash (or several) so `${base}/` is exactly one — the shape the POST route wants. */
export function trimBase(url: string): string {
  let u = url;
  while (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

/**
 * Split a `?key=` off a URL: the base with the query cleared and trailing slashes
 * trimmed, and the key it carried. Null for an unparseable URL. The key travels as
 * a header, never on the POST/GET target a proxy would log — the one normalization
 * both the URL and the connector paths use (boyscout: it was inline in each).
 */
export function splitKeyFromUrl(url: string): { base: string; urlKey: string | undefined } | null {
  try {
    const u = new URL(url);
    const urlKey = u.searchParams.get("key") ?? undefined;
    u.search = "";
    return { base: trimBase(u.toString()), urlKey };
  } catch {
    return null;
  }
}

/**
 * A reference is a URL or a connector name. A URL carries its key in --*-key, the
 * env, or its own ?key= (which is then taken OFF the base — the key travels as a
 * header, and a ?key= on the POST target would be logged by every proxy). A name
 * is resolved by `claude mcp get`, whose output carries the URL and the header;
 * that output also prints the key, so this reads only the two lines it needs and
 * returns the key without ever putting it in a message.
 */
export async function resolveBrain(ref: string, keyArg: string | undefined, envKey: string | undefined): Promise<BrainEndpoint> {
  if (/^https?:\/\//i.test(ref)) {
    const parsed = splitKeyFromUrl(ref);
    if (!parsed) throw new Error(`--compare: ${JSON.stringify(ref)} is not a valid URL.`);
    const host = new URL(ref).host;
    const key = keyArg ?? parsed.urlKey ?? envKey;
    if (!key) throw new Error(`--compare: no read key for ${host}. Pass --a-key/--b-key, set OB1_COMPARE_KEY, or put it in the URL as ?key=.`);
    return { label: host, base: parsed.base, key };
  }
  // A connector name — resolve it the way canary.sh does, reading the URL and the
  // x-brain-key header out of `claude mcp get`, and echoing neither back.
  return resolveConnector(ref, keyArg, envKey);
}

/** Read a connector's base URL and key from `claude mcp get <name>` — its key is used, never printed. */
export async function resolveConnector(name: string, keyArg: string | undefined, envKey: string | undefined): Promise<BrainEndpoint> {
  let out: string;
  let code: number;
  try {
    const proc = Bun.spawn(["claude", "mcp", "get", name], { stdout: "pipe", stderr: "pipe" });
    [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  } catch (e) {
    // The binary is not on PATH (ENOENT) — say so, rather than surface a raw spawn
    // error, and point at the URL path that needs no CLI (review pass 3).
    throw new Error(`--compare: the connector-name path needs the Claude CLI (\`claude\`) on PATH to resolve ${JSON.stringify(name)} — pass an http(s):// URL instead. (${(e as Error).message})`);
  }
  if (code !== 0) {
    throw new Error(`--compare: could not resolve the brain named ${JSON.stringify(name)} — \`claude mcp get ${name}\` exited ${code}. Pass an http(s):// URL instead, or register the connector.`);
  }
  // Read the `URL: http://…` line and the `x-brain-key: …` header line; the URL is
  // normalized below (a ?key= split off), never followed or rewritten otherwise.
  const urlLine = out.split("\n").find((l) => /^\s*URL:/i.test(l));
  const url = urlLine?.replace(/^\s*URL:\s*/i, "").trim();
  if (!url) throw new Error(`--compare: \`claude mcp get ${name}\` named no URL.`);
  const headerLine = out.split("\n").find((l) => /x-brain-key:/i.test(l));
  const headerKey = headerLine?.replace(/^.*x-brain-key:\s*/i, "").trim() || undefined;
  // A connector may hold its key as ?key= on the URL rather than a header; split it
  // off the base (which then has /health appended) so the key never rides the POST
  // target a proxy logs — the same normalization the URL path does (review pass 1).
  const parsed = splitKeyFromUrl(url);
  if (!parsed) throw new Error(`--compare: the connector ${JSON.stringify(name)} named an invalid URL.`);
  const key = keyArg ?? headerKey ?? parsed.urlKey ?? envKey;
  if (!key) throw new Error(`--compare: the connector ${JSON.stringify(name)} carries no x-brain-key and none was given. Pass --a-key/--b-key or set OB1_COMPARE_KEY.`);
  return { label: name, base: parsed.base, key };
}

// ---------------------------------------------------------------------------
// The MCP-over-HTTP client — a keyed GET /health and a keyed tools/call.
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 20_000;

/**
 * fetch with the compare's timeout, rewrapping a network/timeout rejection as the
 * brain's label rather than leaving Bun's raw message (which can name the base URL)
 * to surface (review pass 2). The key rides a header, never the URL, so a rewrapped
 * message carries no key.
 */
async function fetchOrThrow(ep: BrainEndpoint, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `no reply within ${HTTP_TIMEOUT_MS} ms` : (e as Error).message;
    throw new Error(`${ep.label}: could not be reached — ${why}`);
  }
}

/** The brain_info record as the keyed GET /health body carries it — the whole BrainInfo, as JSON. */
export async function getBrainInfo(ep: BrainEndpoint): Promise<BrainInfo> {
  const r = await fetchOrThrow(ep, `${ep.base}/health`, {
    headers: { "x-brain-key": ep.key, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${ep.label}: GET /health → ${r.status} (a read key whose hash is in MCP_ACCESS_KEYS gets the record; without one /health is the bare body "ok").`);
  const text = await r.text();
  if (text.trim() === "ok") throw new Error(`${ep.label}: GET /health returned "ok", not the record — the key was not admitted as a reader (revoked, or hash not in MCP_ACCESS_KEYS).`);
  try {
    return JSON.parse(text) as BrainInfo;
  } catch {
    throw new Error(`${ep.label}: GET /health did not return JSON (${text.slice(0, 80)}).`);
  }
}

/**
 * Call one read tool over MCP. The server answers a POST to the base with either
 * raw JSON or an SSE frame (a `data: {…}` line); no initialize handshake is needed
 * for a keyed tools/call. Returns the concatenated text content, or throws the
 * tool's own error text.
 */
export async function callTool(ep: BrainEndpoint, name: string, args: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const r = await fetchOrThrow(ep, `${ep.base}/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ep.key },
    body,
  });
  // A non-2xx is infrastructure (a gateway/proxy 404, a 502), not the protocol —
  // classify it as HTTP status, never the body, so a "404 page not found" page can't
  // be read downstream as an absent tool (review pass 2).
  if (!r.ok) throw new Error(`${ep.label}: ${name} → HTTP ${r.status}`);
  const raw = await r.text();
  const msg = unwrapRpc(raw);
  if (!msg) throw new Error(`${ep.label}: ${name} returned no JSON-RPC reply (${raw.slice(0, 80)}).`);
  if (msg.error) throw new Error(`${ep.label}: ${name} refused — ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const result = msg.result;
  if (result?.isError) throw new Error(`${ep.label}: ${name} — ${textOf(result)}`);
  return textOf(result);
}

interface RpcReply { error?: { message?: string }; result?: { isError?: boolean; content?: { type: string; text?: string }[] } }

/** A reply is raw JSON or an SSE stream; take the last `data:`-prefixed (or bare) JSON object. */
export function unwrapRpc(raw: string): RpcReply | null {
  const lines = raw.split("\n").map((l) => l.replace(/^data:\s?/, "").trim()).filter((l) => l.startsWith("{"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as RpcReply;
  } catch {
    return null;
  }
}

/** The text content of a tool result, joined. */
function textOf(result: RpcReply["result"]): string {
  return (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

// ---------------------------------------------------------------------------
// Reading each brain: identity, freshness, and (opt-in) retrieval.
// ---------------------------------------------------------------------------

/** What a brain reports about itself, distilled to what the compare diffs. */
export interface BrainReading {
  label: string;
  info: BrainInfo;
  /** thoughts count from brain_info's database counts, or null when the database did not answer. */
  thoughts: number | null;
  /** The ledger's highest applied migration, or null when unread. */
  highestMigration: number | null;
  /** The tree's last migration the server was built from. */
  latestMigration: number;
  /** Newest capture, best-effort from thought_stats' date range; null when unavailable. */
  newestCapture: string | null;
}

/** The database summary shape brain_info carries when the database answered. */
type DbSummary = Extract<BrainInfo["database"], { counts: unknown }>;
const dbOf = (info: BrainInfo): DbSummary | null => ("error" in info.database ? null : info.database);

/** Read a brain's identity and freshness signals over HTTP. */
export async function readBrain(ep: BrainEndpoint): Promise<BrainReading> {
  const info = await getBrainInfo(ep);
  const db = dbOf(info);
  return {
    label: ep.label,
    info,
    thoughts: db?.counts?.thoughts ?? null,
    highestMigration: db?.highestMigration ?? null,
    latestMigration: info.latestMigration,
    newestCapture: await newestCapture(ep),
  };
}

/**
 * Newest capture, read from thought_stats — the one machine-unfriendly read here.
 * The tool renders prose ("Date range: <oldest> → <newest>"), so this is a
 * best-effort parse of the second date and returns null when it cannot, rather
 * than let a format change break the whole compare. The count and migration
 * deltas — the signals the verdict rests on — come from brain_info, not this.
 */
export async function newestCapture(ep: BrainEndpoint): Promise<string | null> {
  try {
    const text = await callTool(ep, "thought_stats", {});
    const m = /Date range:\s*.+?\s*→\s*(.+)/.exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** The ids a brain returns for one query on one arm, in rank order (parsed from the `ID:` lines). */
export async function searchIds(ep: BrainEndpoint, arm: "keyword" | "hybrid", query: string): Promise<string[]> {
  const tool = arm === "keyword" ? "search_thoughts_keyword" : "search_thoughts";
  const text = await callTool(ep, tool, { query });
  return parseResultIds(text);
}

/**
 * The result ids of a search reply, in rank order. Each hit is a block that opens
 * `--- Result N (…) ---` and carries `ID: <uuid>` as its FIRST field line (both
 * search tools, SMD-1248). Anchoring to that header is what makes this content-safe:
 * the hit's own text is appended raw after the fields, so a thought whose content
 * holds its own `ID: <uuid>` line (a memory quoting a search result) would be
 * counted as an extra id by a bare `ID:` match — the header-anchored match never
 * sees it, because content lines are not preceded by a Result header (review pass 1).
 * A "Superseded … ID <id>" marker has no colon and is excluded regardless.
 */
export function parseResultIds(text: string): string[] {
  const ids: string[] = [];
  const re = /--- Result[^\n]*---\r?\n\s*ID:\s*([0-9a-fA-F-]{36})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1].toLowerCase());
  return ids;
}

// ---------------------------------------------------------------------------
// The corpus id set — the exact id-set difference (SMD-2244).
// ---------------------------------------------------------------------------

/** One page of `list_thought_ids`. */
interface ThoughtIdPage {
  ids: string[];
  total: number;
  /** md5 of all ids (first page, SQL store); null on the PostgREST shim or an empty corpus. */
  digest: string | null;
  cursor: string | null;
}

/** The exact id-set difference between two corpora, or `unavailable` when a brain predates the surface. */
export interface IdDiff {
  equal: boolean;
  /** ids A holds that B does not. */
  onlyA: string[];
  /** ids B holds that A does not. */
  onlyB: string[];
  /** the whole-corpus totals, from each first page. */
  totalA: number;
  totalB: number;
  /** set when a brain does not expose list_thought_ids (older than SMD-2244) — the count stand-in still stands. */
  unavailable?: boolean;
  /** set when the id-set read FAILED for another reason (a timeout, a refusal, a mid-walk error) — the reason. Distinct from `unavailable`: the tool is there, the read did not finish; the rest of the compare still prints. */
  failed?: string;
}

/** A safety bound on the enumeration walk — 10M ids at the 1000-default page. */
const MAX_ID_PAGES = 10_000;

/** Fetch one page of a brain's thought ids. */
async function fetchIdPage(ep: BrainEndpoint, after: string | null): Promise<ThoughtIdPage> {
  const text = await callTool(ep, "list_thought_ids", after ? { after } : {});
  let page: Partial<ThoughtIdPage>;
  try {
    page = JSON.parse(text) as Partial<ThoughtIdPage>;
  } catch {
    throw new Error(`${ep.label}: list_thought_ids did not return JSON (${text.slice(0, 80)}).`);
  }
  // A valid-JSON page whose `ids` is not an array is a broken page, not an empty
  // corpus — throw so it reads as a failure, never a silent "this brain holds
  // nothing" that would report the peer's whole corpus as a difference (review pass 2).
  if (!Array.isArray(page.ids)) throw new Error(`${ep.label}: list_thought_ids returned no ids array.`);
  return {
    ids: page.ids.map(String),
    total: Number(page.total ?? 0),
    digest: page.digest ?? null,
    cursor: page.cursor ?? null,
  };
}

/** Page a brain's whole id set into a Set, starting from an already-read first page. */
async function collectIds(ep: BrainEndpoint, first: ThoughtIdPage): Promise<Set<string>> {
  const set = new Set(first.ids);
  let cursor = first.cursor;
  for (let guard = 0; cursor && guard < MAX_ID_PAGES; guard++) {
    const page = await fetchIdPage(ep, cursor);
    // A cursor that does not advance would page the same rows until the guard and
    // return a partial set read as a real diff — throw so a buggy server reads as a
    // failure, not a wrong answer (review pass 2).
    if (page.cursor === cursor) throw new Error(`${ep.label}: list_thought_ids cursor did not advance past ${cursor.slice(0, 8)}.`);
    for (const id of page.ids) set.add(id);
    cursor = page.cursor;
  }
  return set;
}

/**
 * The exact id-set difference. Reads each brain's first page; when both carry a
 * digest and the two match, the corpora are identical and neither is enumerated
 * (the fast path). Otherwise both are paged in full and the sets are diffed. A
 * brain that does not expose `list_thought_ids` (older than SMD-2244) degrades to
 * `unavailable` rather than aborting the compare — the thought-count stand-in holds.
 */
export async function corpusIdDiff(a: BrainEndpoint, b: BrainEndpoint): Promise<IdDiff> {
  const blank = (patch: Partial<IdDiff>): IdDiff => ({ equal: false, onlyA: [], onlyB: [], totalA: 0, totalB: 0, ...patch });
  // An unknown tool is an older brain (degrade to unavailable, the count stands in);
  // anything else is a real failure of the read, kept distinct so the wrong cause
  // is never asserted and — crucially — so the rest of the compare still prints
  // (review pass 1). The MCP SDK answers an unregistered tool with `Tool <name> not
  // found` (server/mcp.js); others say "unknown tool"/"method not found". Match those
  // phrasings, NOT a bare "not found" — a proxy's "404 page not found" body is a read
  // failure, not an absent tool, and callTool's r.ok check keeps it out of here (review pass 2).
  const isAbsent = (e: unknown) => /\bunknown tool\b|\btool\b[^]*?\bnot found\b|\bmethod not found\b|\bno such tool\b/i.test((e as Error).message);
  let pa: ThoughtIdPage;
  let pb: ThoughtIdPage;
  try {
    [pa, pb] = await Promise.all([fetchIdPage(a, null), fetchIdPage(b, null)]);
  } catch (e) {
    return isAbsent(e) ? blank({ unavailable: true }) : blank({ failed: (e as Error).message });
  }
  // Equal NON-null digests only: two null digests (the shim, or two empty corpora)
  // must be enumerated, not read as a match.
  if (pa.digest != null && pa.digest === pb.digest) {
    return { equal: true, onlyA: [], onlyB: [], totalA: pa.total, totalB: pb.total };
  }
  // The full walk fails soft too: a mid-enumeration error (a timeout on page 2 of a
  // corpus with hundreds of differing ids) marks the id-set failed rather than
  // aborting the whole compare over its one optional axis (review pass 1).
  try {
    const [setA, setB] = await Promise.all([collectIds(a, pa), collectIds(b, pb)]);
    // The walk must account for the whole corpus the first page counted. Fewer ids
    // than `total` means an incomplete enumeration — a PostgREST db-max-rows below
    // the page size (a short page reads as the last), or a concurrent delete — so
    // fail rather than report a partial set as a real difference (review pass 3).
    if (setA.size < pa.total || setB.size < pb.total) {
      return blank({ failed: `the id enumeration returned fewer ids than the corpus total (${setA.size}/${pa.total}, ${setB.size}/${pb.total}) — a paging limit or a concurrent change; not comparing a partial set`, totalA: pa.total, totalB: pb.total });
    }
    const onlyA = [...setA].filter((id) => !setB.has(id));
    const onlyB = [...setB].filter((id) => !setA.has(id));
    return { equal: onlyA.length === 0 && onlyB.length === 0, onlyA, onlyB, totalA: pa.total, totalB: pb.total };
  } catch (e) {
    return blank({ failed: (e as Error).message, totalA: pa.total, totalB: pb.total });
  }
}

// ---------------------------------------------------------------------------
// The comparison.
// ---------------------------------------------------------------------------

export interface FieldDelta {
  field: string;
  a: string;
  b: string;
}

export interface RetrievalRow {
  query: string;
  arm: "keyword" | "hybrid";
  a: string[];
  b: string[];
  /** ids b returned that a did not. */
  onlyB: string[];
  /** ids a returned that b did not. */
  onlyA: string[];
  reordered: boolean;
  changed: boolean;
  /** Set when the row could not be replayed (one brain refused or failed the query); the reason. A skipped row never counts as changed. */
  skipped?: string;
}

export interface Comparison {
  a: BrainReading;
  b: BrainReading;
  /** The identity fields that differ, named. */
  identity: FieldDelta[];
  /** b's ledger highest minus a's — positive means b is ahead, negative behind; null when either is unread. */
  migrationDelta: number | null;
  /** a and b thoughts counts. */
  counts: { a: number | null; b: number | null };
  /** The exact id-set difference (SMD-2244), or unavailable on a brain that predates list_thought_ids. */
  idDiff: IdDiff;
  /** The retrieval rows, when --replay ran; the arms that ran. */
  retrieval: { rows: RetrievalRow[]; arms: string[]; queries: number } | null;
  /** The one-line verdict. */
  verdict: string;
}

/** How a brain names a field for the identity diff. */
function identityFields(r: BrainReading): Record<string, string> {
  const info = r.info;
  const db = dbOf(info);
  const range = info.releaseRange ? `${info.releaseRange[0]}–${info.releaseRange[1]}` : "none";
  return {
    version: info.version,
    commit: info.commit,
    tier: info.tier ?? "(none)",
    releaseRange: range,
    latestMigration: String(info.latestMigration),
    highestMigration: r.highestMigration === null ? "unread" : String(r.highestMigration),
    schemaVersion: db?.schemaVersion ?? "none",
    "embedding.model": info.embedding.model,
    "embedding.dim": String(info.embedding.dim),
    postgres: db ? db.postgres.split(" ")[0] : "unread",
    // db present but pgvector null is "none" (not installed — the fact the record
    // carries); only a database that did not answer at all is "unread" (review pass 2).
    pgvector: db ? (db.pgvector ? db.pgvector.version : "none") : "unread",
  };
}

/** Compose the two readings into a comparison, optionally replaying a query set. */
export async function compareBrains(
  a: BrainEndpoint,
  b: BrainEndpoint,
  opts: { queries?: string[]; hybrid?: boolean } = {},
): Promise<Comparison> {
  const [ra, rb, idDiff] = await Promise.all([readBrain(a), readBrain(b), corpusIdDiff(a, b)]);

  const fa = identityFields(ra);
  const fb = identityFields(rb);
  const identity: FieldDelta[] = [];
  for (const field of Object.keys(fa)) {
    if (fa[field] !== fb[field]) identity.push({ field, a: fa[field], b: fb[field] });
  }

  const migrationDelta =
    ra.highestMigration === null || rb.highestMigration === null ? null : rb.highestMigration - ra.highestMigration;

  let retrieval: Comparison["retrieval"] = null;
  if (opts.queries && opts.queries.length) {
    const arms: ("keyword" | "hybrid")[] = opts.hybrid ? ["keyword", "hybrid"] : ["keyword"];
    const rows: RetrievalRow[] = [];
    for (const query of opts.queries) {
      for (const arm of arms) {
        // One query one brain refuses (an egress-gated embedding) or a hybrid arm a
        // peer has no provider for must not abort the whole compare — mark the row
        // skipped-with-reason and go on, the way newestCapture degrades (review pass 1).
        try {
          const [ida, idb] = await Promise.all([searchIds(a, arm, query), searchIds(b, arm, query)]);
          rows.push(diffRow(query, arm, ida, idb));
        } catch (e) {
          rows.push({ query, arm, a: [], b: [], onlyA: [], onlyB: [], reordered: false, changed: false, skipped: (e as Error).message });
        }
      }
    }
    retrieval = { rows, arms, queries: opts.queries.length };
  }

  return {
    a: ra,
    b: rb,
    identity,
    migrationDelta,
    counts: { a: ra.thoughts, b: rb.thoughts },
    idDiff,
    retrieval,
    verdict: freshnessVerdict(ra, rb, migrationDelta),
  };
}

/** One retrieval row: what b returned against what a returned for the same query and arm. */
export function diffRow(query: string, arm: "keyword" | "hybrid", a: string[], b: string[]): RetrievalRow {
  const aSet = new Set(a);
  const bSet = new Set(b);
  const onlyB = b.filter((id) => !aSet.has(id));
  const onlyA = a.filter((id) => !bSet.has(id));
  const sameSet = onlyA.length === 0 && onlyB.length === 0;
  const reordered = sameSet && a.join(",") !== b.join(",");
  return { query, arm, a, b, onlyB, onlyA, reordered, changed: onlyA.length > 0 || onlyB.length > 0 || reordered };
}

/**
 * The one-line verdict: current when the two are in lockstep on migration and
 * count, else how far b trails or leads a — the "trust or distrust this tier's
 * answer at a glance" line a grooming session reads.
 */
export function freshnessVerdict(a: BrainReading, b: BrainReading, migrationDelta: number | null): string {
  const parts: string[] = [];
  if (migrationDelta !== null && migrationDelta !== 0) {
    const n = Math.abs(migrationDelta);
    parts.push(`${b.label} is ${n} migration${n === 1 ? "" : "s"} ${migrationDelta < 0 ? "behind" : "ahead of"} ${a.label}`);
  }
  const days = captureDaysApart(a.newestCapture, b.newestCapture);
  if (days !== null && Math.abs(days) >= 1) {
    parts.push(`${b.label}'s newest capture is ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days < 0 ? "older" : "newer"}`);
  }
  const ca = a.thoughts;
  const cb = b.thoughts;
  if (ca !== null && cb !== null && ca !== cb) {
    parts.push(`${cb.toLocaleString("en-US")} vs ${ca.toLocaleString("en-US")} thoughts`);
  }
  if (parts.length === 0) {
    // "current" is a claim about what was compared: assert it only for the signals
    // that actually answered. A ledger or a count unread on a side is not "same"
    // (review pass 1: it read "same migration and thought count" over two nulls).
    const migKnown = migrationDelta !== null;
    const countsKnown = a.thoughts !== null && b.thoughts !== null;
    if (migKnown && countsKnown) return `current with each other — same migration and thought count.`;
    const unread = [migKnown ? null : "migration ledger", countsKnown ? null : "thought count"].filter(Boolean).join(" and ");
    return `no delta on what could be read; ${unread} unread on one side, so freshness is not certain.`;
  }
  return parts.join("; ") + ".";
}

/**
 * Whole days between two best-effort capture dates (b − a), or null when either is
 * unparseable. Rounded, not truncated: newestCapture is a local-midnight date
 * (thought_stats' displayDate), and a day that crosses a DST change is 23 or 25
 * hours — `trunc(23h)` would read a real one-day drift as zero (review pass 2).
 */
export function captureDaysApart(aDate: string | null, bDate: string | null): number | null {
  if (!aDate || !bDate) return null;
  const ta = Date.parse(aDate);
  const tb = Date.parse(bDate);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

const shortId = (id: string) => id.slice(0, 8);

/** The report as a human table; --json prints the Comparison instead. */
export function renderComparison(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`comparing ${c.a.label} (a) vs ${c.b.label} (b)`);
  lines.push("");

  lines.push("Identity:");
  if (c.identity.length === 0) {
    lines.push("  no delta — version, commit, tier, migrations, schema, embedding and Postgres all match.");
  } else {
    for (const d of c.identity) lines.push(`  ${d.field}: a=${d.a}  b=${d.b}`);
  }

  lines.push("");
  lines.push("Freshness:");
  const ca = c.counts.a;
  const cb = c.counts.b;
  lines.push(`  thoughts: a=${ca === null ? "unread" : ca.toLocaleString("en-US")}  b=${cb === null ? "unread" : cb.toLocaleString("en-US")}`);
  lines.push(`  newest capture: a=${c.a.newestCapture ?? "n/a"}  b=${c.b.newestCapture ?? "n/a"}`);
  lines.push(`  migration ledger: a=${c.a.highestMigration ?? "unread"}  b=${c.b.highestMigration ?? "unread"}`);
  // The exact id-set difference (SMD-2244): which thoughts one holds and the other does not.
  const d = c.idDiff;
  if (d.unavailable) {
    lines.push(`  id-set: unavailable — a brain does not expose list_thought_ids (older than SMD-2244); the thought count above stands in.`);
  } else if (d.failed) {
    lines.push(`  id-set: could not be read — ${d.failed}; the thought count above stands in.`);
  } else if (d.equal) {
    lines.push(`  id-set: identical — both brains hold the same ${d.totalA.toLocaleString("en-US")} thought ids.`);
  } else {
    const ex = (ids: string[]) => (ids.length ? ` (e.g. ${ids.slice(0, 3).map(shortId).join(", ")}${ids.length > 3 ? ", …" : ""})` : "");
    lines.push(`  id-set: ${d.onlyA.length.toLocaleString("en-US")} only in a${ex(d.onlyA)}; ${d.onlyB.length.toLocaleString("en-US")} only in b${ex(d.onlyB)}.`);
  }
  lines.push(`  (board-sync watermark is not on the read surface — a DB-backed compare adds it, SMD-2109.)`);

  lines.push("");
  lines.push("Retrieval:");
  if (!c.retrieval) {
    lines.push("  skipped — pass --replay with --query/--queries-file (query_log is not reachable over HTTP, so the query set is supplied).");
  } else {
    const moved = c.retrieval.rows.filter((r) => r.changed);
    const skipped = c.retrieval.rows.filter((r) => r.skipped);
    lines.push(`  arms: ${c.retrieval.arms.join(", ")} over ${c.retrieval.queries} quer${c.retrieval.queries === 1 ? "y" : "ies"}${c.retrieval.arms.includes("hybrid") ? " (hybrid = the vector arm, embedded by each brain; until SMD-2037 a hybrid diff can be HNSW-GUC-induced)" : ""}`);
    lines.push(`  (these are real searches — a brain running OB1_QUERY_LOG=on records them in query_log, telemetry, not the thoughts corpus.)`);
    for (const r of skipped) lines.push(`  ~ [${r.arm}] ${JSON.stringify(r.query.slice(0, 60))}: skipped — ${r.skipped}`);
    if (moved.length === 0) {
      // All rows skipped is not "no delta" — nothing was compared (review pass 3).
      const allSkipped = skipped.length > 0 && skipped.length === c.retrieval.rows.length;
      lines.push(allSkipped
        ? `  nothing compared — all ${skipped.length} quer${skipped.length === 1 ? "y" : "ies"} were skipped.`
        : `  no delta — b returns the same ids as a for every query and arm${skipped.length ? ` (${skipped.length} skipped)` : ""}.`);
    } else {
      for (const r of moved) {
        const bits: string[] = [];
        if (r.onlyA.length) bits.push(`only-a ${r.onlyA.map(shortId).join(",")}`);
        if (r.onlyB.length) bits.push(`only-b ${r.onlyB.map(shortId).join(",")}`);
        if (r.reordered) bits.push("reordered");
        lines.push(`  • [${r.arm}] ${JSON.stringify(r.query.slice(0, 60))}: ${bits.join("; ")}`);
      }
    }
  }

  lines.push("");
  lines.push(`Verdict: ${c.verdict}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI — the --compare verb of db/tier.ts dispatches here.
// ---------------------------------------------------------------------------

export interface CompareArgs {
  a: string;
  b: string;
  aKey?: string;
  bKey?: string;
  replay: boolean;
  hybrid: boolean;
  queries: string[];
  json: boolean;
}

/** Run --compare end to end: resolve both brains, compare, print. Returns the exit code (1 when anything differs). */
export async function runCompare(args: CompareArgs): Promise<number> {
  const envKey = process.env.OB1_COMPARE_KEY;
  const [a, b] = await Promise.all([
    resolveBrain(args.a, args.aKey, envKey),
    resolveBrain(args.b, args.bKey, envKey),
  ]);
  const c = await compareBrains(a, b, { queries: args.replay ? args.queries : undefined, hybrid: args.hybrid });
  if (args.json) {
    // The endpoints (and their keys) are never in the Comparison — only labels.
    console.log(JSON.stringify(c, null, 2));
  } else {
    console.log(renderComparison(c));
  }
  // The exit code is the gate a script keys on, so every axis the report calls a
  // delta must move it — identity, migration, retrieval AND freshness (a count or a
  // newest-capture difference). A same-migration corpus drift (597 vs 407 thoughts,
  // no new migration — the confidently-stale case this tool exists to catch) has an
  // empty identity and a zero migration delta, and must still exit non-zero
  // (review pass 1: it exited 0 while the verdict printed the count delta).
  const countDelta = c.counts.a !== null && c.counts.b !== null && c.counts.a !== c.counts.b;
  const captureDelta = captureDaysApart(c.a.newestCapture, c.b.newestCapture);
  // An id-set difference is a delta too (a same-count corpus that drifted, SMD-2244).
  // A read that could not be had — `unavailable` (older brain) or `failed` — is not a
  // delta: the count stand-in already spoke and we do not force the gate on an unread axis.
  const idSetDelta = !c.idDiff.unavailable && !c.idDiff.failed && !c.idDiff.equal;
  const freshDelta = countDelta || (captureDelta !== null && captureDelta !== 0) || idSetDelta;
  const anyDelta =
    c.identity.length > 0 ||
    (c.migrationDelta ?? 0) !== 0 ||
    freshDelta ||
    (c.retrieval?.rows.some((r) => r.changed) ?? false);
  return anyDelta ? 1 : 0;
}
