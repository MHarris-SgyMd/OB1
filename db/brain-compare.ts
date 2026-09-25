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
 * (CLAUDE.md), with a read key, never Postgres. It writes to neither brain and
 * never prints a key.
 *
 * What it reads and why it is HTTP, not SQL:
 *   • Identity — the keyed GET /health body is the whole brain_info record as JSON
 *     (version, commit, tier, releaseRange, the tree's latest migration against the
 *     ledger's highest, schema version, embedding, pgvector, counts, size). version
 *     and commit are the server PROCESS's build facts, in no database — only the
 *     running brain can say them, so identity is an HTTP read by nature.
 *   • Freshness — counts.thoughts and the migration delta come from that same body
 *     (machine-readable); newest capture is read best-effort from thought_stats.
 *   • Retrieval — the two search tools, called against both brains over the same
 *     queries, their returned ids diffed. The VECTOR arm needs no model here: the
 *     brain embeds the query server-side, so search_thoughts (hybrid) replays it.
 *
 * Two signals a compare would ideally carry live only in a brain's Postgres and
 * are NOT reachable over the read surface, so this HTTP-only compare names them as
 * out of reach rather than guessing: the EXACT id-set difference (which thoughts one
 * holds and the other does not — the read tools page prose, they do not enumerate a
 * corpus), and a replay sourced from stable's own query_log (this replays a supplied
 * query set instead). A DB-backed mode can add both (SMD-2109 notes).
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
 * A reference is a URL or a connector name. A URL carries its key in --*-key, the
 * env, or its own ?key= (which is then taken OFF the base — the key travels as a
 * header, and a ?key= on the POST target would be logged by every proxy). A name
 * is resolved by `claude mcp get`, whose output carries the URL and the header;
 * that output also prints the key, so this reads only the two lines it needs and
 * returns the key without ever putting it in a message.
 */
export async function resolveBrain(ref: string, keyArg: string | undefined, envKey: string | undefined): Promise<BrainEndpoint> {
  if (/^https?:\/\//i.test(ref)) {
    let base = ref;
    let urlKey: string | undefined;
    try {
      const u = new URL(ref);
      urlKey = u.searchParams.get("key") ?? undefined;
      u.search = "";
      base = u.toString();
    } catch {
      throw new Error(`--compare: ${JSON.stringify(ref)} is not a valid URL.`);
    }
    const key = keyArg ?? urlKey ?? envKey;
    if (!key) throw new Error(`--compare: no read key for ${new URL(ref).host}. Pass --a-key/--b-key, set OB1_COMPARE_KEY, or put it in the URL as ?key=.`);
    return { label: new URL(ref).host, base: trimBase(base), key };
  }
  // A connector name — resolve it the way canary.sh does, reading only Scope/URL
  // and the x-brain-key header out of `claude mcp get`, and echoing neither back.
  return resolveConnector(ref, keyArg);
}

/** Read a connector's base URL and key from `claude mcp get <name>` — its key is used, never printed. */
export async function resolveConnector(name: string, keyArg: string | undefined): Promise<BrainEndpoint> {
  const proc = Bun.spawn(["claude", "mcp", "get", name], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`--compare: could not resolve the brain named ${JSON.stringify(name)} — \`claude mcp get ${name}\` exited ${code}. Pass an http(s):// URL instead, or register the connector.`);
  }
  // `URL: http://…` and `x-brain-key: …` (a header line). No -L equivalent here:
  // the base is taken verbatim.
  const urlLine = out.split("\n").find((l) => /^\s*URL:/i.test(l));
  const url = urlLine?.replace(/^\s*URL:\s*/i, "").trim();
  if (!url) throw new Error(`--compare: \`claude mcp get ${name}\` named no URL.`);
  const headerLine = out.split("\n").find((l) => /x-brain-key:/i.test(l));
  const headerKey = headerLine?.replace(/^.*x-brain-key:\s*/i, "").trim() || undefined;
  const key = keyArg ?? headerKey ?? process.env.OB1_COMPARE_KEY;
  if (!key) throw new Error(`--compare: the connector ${JSON.stringify(name)} carries no x-brain-key and none was given. Pass --a-key/--b-key or set OB1_COMPARE_KEY.`);
  return { label: name, base: trimBase(url), key };
}

// ---------------------------------------------------------------------------
// The MCP-over-HTTP client — a keyed GET /health and a keyed tools/call.
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 20_000;

/** The brain_info record as the keyed GET /health body carries it — the whole BrainInfo, as JSON. */
export async function getBrainInfo(ep: BrainEndpoint): Promise<BrainInfo> {
  const r = await fetch(`${ep.base}/health`, {
    headers: { "x-brain-key": ep.key, accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
  const r = await fetch(`${ep.base}/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ep.key },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
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
 * The `ID:` lines of a search result, in order. Only `ID:` (with the colon) is a
 * result's own id — a "Superseded by a newer thought — ID <id>" marker prints
 * "ID <id>" without one, so it is not mistaken for a hit.
 */
export function parseResultIds(text: string): string[] {
  const ids: string[] = [];
  const re = /(?:^|\n)\s*ID:\s*([0-9a-fA-F-]{36})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1].toLowerCase());
  return ids;
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
    pgvector: db?.pgvector ? db.pgvector.version : "unread",
  };
}

/** Compose the two readings into a comparison, optionally replaying a query set. */
export async function compareBrains(
  a: BrainEndpoint,
  b: BrainEndpoint,
  opts: { queries?: string[]; hybrid?: boolean } = {},
): Promise<Comparison> {
  const [ra, rb] = await Promise.all([readBrain(a), readBrain(b)]);

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
        const [ida, idb] = await Promise.all([searchIds(a, arm, query), searchIds(b, arm, query)]);
        rows.push(diffRow(query, arm, ida, idb));
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
    const bothMig = migrationDelta !== null;
    return bothMig ? `current with each other — same migration and thought count.` : `no migration/count delta; migration ledger unread on one side, so freshness is not certain.`;
  }
  return parts.join("; ") + ".";
}

/** Whole days between two best-effort capture dates (b − a), or null when either is unparseable. */
export function captureDaysApart(aDate: string | null, bDate: string | null): number | null {
  if (!aDate || !bDate) return null;
  const ta = Date.parse(aDate);
  const tb = Date.parse(bDate);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.trunc((tb - ta) / 86_400_000);
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
  lines.push(`  (board-sync watermark and the exact id-set difference are not on the read surface — a DB-backed compare adds them, SMD-2109.)`);

  lines.push("");
  lines.push("Retrieval:");
  if (!c.retrieval) {
    lines.push("  skipped — pass --replay with --query/--queries-file (query_log is not reachable over HTTP, so the query set is supplied).");
  } else {
    const moved = c.retrieval.rows.filter((r) => r.changed);
    lines.push(`  arms: ${c.retrieval.arms.join(", ")} over ${c.retrieval.queries} quer${c.retrieval.queries === 1 ? "y" : "ies"}${c.retrieval.arms.includes("hybrid") ? " (hybrid = the vector arm, embedded by each brain; until SMD-2037 a hybrid diff can be HNSW-GUC-induced)" : ""}`);
    if (moved.length === 0) {
      lines.push("  no delta — b returns the same ids as a for every query and arm.");
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
  const anyDelta = c.identity.length > 0 || (c.retrieval?.rows.some((r) => r.changed) ?? false) || (c.migrationDelta ?? 0) !== 0;
  return anyDelta ? 1 : 0;
}
