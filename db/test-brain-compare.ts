#!/usr/bin/env bun
/**
 * test-brain-compare.ts — the cross-brain compare (SMD-2109), hermetic.
 *
 * No Postgres and no real server: two fake brains (Bun.serve) answer a keyed GET
 * /health with a BrainInfo body and a keyed tools/call with the read tools'
 * output — one endpoint framing its reply as raw JSON, the other as SSE — so the
 * client's identity/freshness/retrieval diff, its verdict and its key-safety are
 * driven end to end. Runs in the fast portable-server job.
 */

import { createHash } from "node:crypto";
import type { BrainInfo } from "../server-portable/brain-info.ts";
import {
  boardSyncDelta,
  boardSyncOf,
  OLDER_SERVER,
  captureDaysApart,
  compareBrains,
  diffRow,
  fetchLoggedSearches,
  freshnessVerdict,
  getBrainInfo,
  replayPlanFromLog,
  parseResultIds,
  renderComparison,
  resolveBrain,
  runCompare,
  splitKeyFromUrl,
  trimBase,
  unwrapRpc,
  type BrainEndpoint,
  type BrainReading,
} from "./brain-compare.ts";
import { parseCompareArgs } from "./tier.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// A fake brain: a keyed GET /health record and a keyed tools/call.
// ---------------------------------------------------------------------------

const KEY = "test-read-key";

interface FakeConfig {
  info: BrainInfo;
  /** thought_stats' rendered "Date range" newest date, or null to omit the tool. */
  newest: string | null;
  /** query → the ids each search tool returns, in rank order. */
  hits: Record<string, string[]>;
  /** queries this brain refuses (an egress-gated embedding) — the search tool returns isError. */
  refuse?: string[];
  /** the brain's thought-id set for list_thought_ids; omit to make the tool absent (a brain older than SMD-2244). */
  corpus?: { ids: string[]; digest?: string | null; pageCap?: number; fail?: string; failAfter?: boolean; badShape?: boolean; stuckCursor?: boolean; fakeTotal?: number };
  /** the brain's logged searches for list_logged_searches; omit to make the tool absent. */
  log?: { searches: { query: string; arm: "keyword" | "hybrid" | "current" | null }[]; truncated?: boolean };
  /** a gateway/proxy that answers every tools/call POST with a plain 404 body (GET /health still routes). */
  proxy404?: boolean;
  /** frame the tools/call reply as an SSE stream rather than raw JSON. */
  sse?: boolean;
}

/** The SQL store's digest: md5 of all ids joined by ',' in id order. */
function corpusDigest(ids: string[]): string {
  return createHash("md5").update([...ids].sort().join(",")).digest("hex");
}

/** The stable fixture's board-sync watermark (SMD-2261). */
const SYNCED = "2026-09-24T12:00:00.000Z";

function baseInfo(over: Partial<BrainInfo> & { thoughts?: number; highestMigration?: number; boardSync?: string | null | "absent" | "unread" }): BrainInfo {
  const thoughts = over.thoughts ?? 597;
  const highest = over.highestMigration ?? 57;
  const { boardSync = SYNCED, ...rest } = over;
  const info: BrainInfo = {
    version: "1.2.0+upstream.9543c29",
    releaseRange: [52, 57],
    latestMigration: 57,
    commit: "abc1234",
    store: "sql",
    tier: "stable",
    embedding: { model: "nomic-embed-text", dim: 768 },
    unreleased: null,
    ledgerStatus: highest === 57 ? "current" : highest < 57 ? "behind" : "ahead",
    database: {
      postgres: "16.4 (Debian 16.4-1.pgdg120+2)",
      pgvector: { version: "0.8.0", schema: "public" },
      schemaVersion: "057",
      embedding: { model: "nomic-embed-text", dim: 768 },
      highestMigration: highest,
      counts: { thoughts, thought_audit: thoughts * 3, thought_chunks: thoughts, ob1_entities: 40 },
      databaseBytes: 45_200_000,
      boardSync: boardSync === "absent" || boardSync === "unread" ? null : boardSync,
      workers: { heartbeats: [], ignored: 0 },
      hnsw: [],
      unread: {},
      ledger: { present: true, readable: true },
    },
  };
  // A server that did not read it names it in unread, as brain-info.ts does at the deadline.
  if (boardSync === "unread" && !("error" in info.database)) info.database.unread = { boardSync: { reason: "deadline", message: "not read before the deadline" } };
  // A server older than SMD-2261 sends no field at all.
  if (boardSync === "absent" && !("error" in info.database)) delete (info.database as { boardSync?: unknown }).boardSync;
  return { ...info, ...rest };
}

function startFake(cfg: FakeConfig): { server: ReturnType<typeof Bun.serve>; ep: BrainEndpoint } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = req.headers.get("x-brain-key");
      if (req.method === "GET" && /\/health$/.test(url.pathname)) {
        if (key !== KEY) return new Response("ok", { status: 200 });
        return Response.json(cfg.info);
      }
      if (req.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
        if (key !== KEY) return new Response("ok", { status: 200 });
        // A gateway that 404s the MCP POST while /health still routes.
        if (cfg.proxy404) return new Response("404 page not found", { status: 404 });
        const body = (await req.json()) as { id: number; params: { name: string; arguments: { query?: string; limit?: number; after?: string; prefer_current?: boolean } } };
        const name = body.params.name;
        let text = "";
        if (name === "list_thought_ids") {
          if (!cfg.corpus) return replyError(body.id, "unknown tool list_thought_ids", cfg.sse);
          const after = body.params.arguments.after;
          const isFirst = after === undefined || after === null;
          // fail: a NON-unknown-tool error on the first page (a refusal/timeout, not
          // an older brain). failAfter: succeed on page 1, error on a later page (a
          // mid-enumeration failure).
          if (cfg.corpus.fail && isFirst) return replyError(body.id, cfg.corpus.fail, cfg.sse);
          if (cfg.corpus.failAfter && !isFirst) return replyError(body.id, "page read timed out", cfg.sse);
          const all = [...cfg.corpus.ids].sort();
          // A valid-JSON page whose ids is not an array (a broken server).
          if (cfg.corpus.badShape) { text = JSON.stringify({ total: all.length, digest: null, ids: "not-an-array", cursor: null }); return replyOk(body.id, text, cfg.sse); }
          const cap = cfg.corpus.pageCap ?? 1000;
          const limit = Math.min(Number(body.params.arguments.limit ?? 1000), cap);
          const start = after ? all.findIndex((id) => id > after) : 0;
          const slice = start < 0 ? [] : all.slice(start, start + limit);
          let cursor = slice.length === limit && slice.length > 0 ? slice[slice.length - 1] : null;
          // A cursor that never advances (a buggy server) — always the same value.
          if (cfg.corpus.stuckCursor) cursor = "ffffffff-0000-0000-0000-000000000000";
          const digest = isFirst ? (cfg.corpus.digest !== undefined ? cfg.corpus.digest : corpusDigest(all)) : null;
          const total = isFirst ? (cfg.corpus.fakeTotal ?? all.length) : 0;
          text = JSON.stringify({ total, digest, ids: slice, cursor });
        } else if (name === "thought_stats") {
          if (cfg.newest === null) return replyError(body.id, "thought_stats unavailable", cfg.sse);
          const total = "counts" in cfg.info.database ? (cfg.info.database.counts?.thoughts ?? 0) : 0;
          text = `Total thoughts: ${total}\nDate range: 1/1/2026 → ${cfg.newest}`;
        } else if (name === "list_logged_searches") {
          if (!cfg.log) return replyError(body.id, "unknown tool list_logged_searches", cfg.sse);
          text = JSON.stringify({ searches: cfg.log.searches, truncated: cfg.log.truncated === true });
        } else if (name === "search_thoughts_keyword" || name === "search_thoughts") {
          const q = body.params.arguments.query ?? "";
          if (cfg.refuse?.includes(q)) return replyError(body.id, `Refused: the query may not leave the box`, cfg.sse);
          // prefer_current (059, SMD-2255) answers from `<q>#current` when given,
          // so a test can see the flag was sent.
          const ids = (body.params.arguments.prefer_current === true ? cfg.hits[`${q}#current`] : undefined) ?? cfg.hits[q] ?? [];
          // The real result format: a "--- Result N ---" header, ID: as the first
          // field, then the hit's content, fenced (SMD-2483) — which here itself
          // quotes a header and an ID: line, so a content-blind parse would
          // over-count (the parseResultIds tooth).
          text = ids.length
            ? ids
                .map((id, i) => `--- Result ${i + 1} (1 occurrence) ---\nID: ${id}\nType: reference\n\n│ A note that mentions\n│ --- Result 9 (1 occurrence) ---\n│ ID: 00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`)
                .join("\n\n")
            : `No thoughts contain "${q}".`;
        } else {
          return replyError(body.id, `unknown tool ${name}`, cfg.sse);
        }
        return replyOk(body.id, text, cfg.sse);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const ep: BrainEndpoint = { label: `fake:${server.port}`, base: `http://localhost:${server.port}`, key: KEY };
  return { server, ep };
}

function replyOk(id: number, text: string, sse?: boolean): Response {
  const msg = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
  return frame(msg, sse);
}
function replyError(id: number, message: string, sse?: boolean): Response {
  const msg = { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Error: ${message}` }] } };
  return frame(msg, sse);
}
function frame(msg: unknown, sse?: boolean): Response {
  if (sse) {
    return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json(msg);
}

// ---------------------------------------------------------------------------
// Pure-function teeth (no server).
// ---------------------------------------------------------------------------

// parseResultIds: the first ID: of each "--- Result ---" block, in order, lower-cased;
// a content ID: line (raw hit text) and a "Superseded … ID <id>" marker are both excluded.
{
  const uuid = (n: string) => `${n.repeat(8)}-0000-0000-0000-000000000000`.slice(0, 36);
  const a = uuid("a");
  const b = uuid("b");
  const contentId = uuid("c");
  const supersededId = uuid("d");
  const text = [
    `--- Result 1 (2 occurrences) ---`,
    `ID: ${a.toUpperCase()}`,
    `Type: reference`,
    ``,
    `a memory that quotes a search result:`,
    `ID: ${contentId}`,
    `--- Result 2 (1 occurrence) ---`,
    `ID: ${b}`,
    `⚠ Superseded by a newer thought — ID ${supersededId}`,
  ].join("\n");
  const ids = parseResultIds(text);
  ok(ids.length === 2 && ids[0] === a && ids[1] === b, `parseResultIds reads the first ID: of each Result block, in order, lower-cased (${JSON.stringify(ids)})`);
  ok(!ids.includes(contentId), "parseResultIds excludes an ID: line inside a hit's own content (content-injection tooth)");
  ok(!ids.includes(supersededId), "parseResultIds excludes the \"Superseded … ID <id>\" marker (no colon)");
  // A whole header and its ID: line quoted by a hit's text: fenced, as the
  // server renders it (SMD-2483), it is content; even raw, a header that does
  // not start its line is not one.
  const forgedId = uuid("e");
  const quoted = parseResultIds(`--- Result 1 (1 occurrence) ---\nID: ${a}\nType: reference\n\n│ quoting a search:\n│ --- Result 9 (1 occurrence) ---\n│ ID: ${forgedId}\n--- Result 2 (1 occurrence) ---\nID: ${b}\n\nsee --- Result 8 (1 occurrence) ---\nID: ${forgedId}`);
  ok(quoted.length === 2 && quoted[0] === a && quoted[1] === b, `parseResultIds excludes a header quoted inside a hit's text, fenced or mid-line (${JSON.stringify(quoted)})`);
}

// unwrapRpc: raw JSON and an SSE data: frame both parse; a keepalive comment is ignored.
{
  const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x" }] } });
  ok(unwrapRpc(raw)?.result?.content?.[0].text === "x", "unwrapRpc reads a raw-JSON reply");
  const sse = `: keepalive\nevent: message\ndata: ${raw}\n\n`;
  ok(unwrapRpc(sse)?.result?.content?.[0].text === "x", "unwrapRpc reads an SSE data: frame past a keepalive comment");
  ok(unwrapRpc("not json at all") === null, "unwrapRpc returns null on a non-JSON body");
}

// diffRow: set difference and reorder.
{
  const r1 = diffRow("q", "keyword", ["a", "b", "c"], ["a", "b", "c"]);
  ok(!r1.changed, "diffRow: identical id lists do not change");
  const r2 = diffRow("q", "keyword", ["a", "b"], ["a", "c"]);
  ok(r2.changed && r2.onlyA.join() === "b" && r2.onlyB.join() === "c", "diffRow: names only-a and only-b");
  const r3 = diffRow("q", "keyword", ["a", "b"], ["b", "a"]);
  ok(r3.changed && r3.reordered && r3.onlyA.length === 0 && r3.onlyB.length === 0, "diffRow: same set, new order = reordered");
}

// captureDaysApart: whole days; unparseable → null.
{
  ok(captureDaysApart("2026-09-23", "2026-09-24") === 1, "captureDaysApart: one day newer = +1");
  ok(captureDaysApart("2026-09-24", "2026-09-23") === -1, "captureDaysApart: one day older = -1");
  ok(captureDaysApart("not a date", "2026-09-24") === null, "captureDaysApart: unparseable = null");
  // A 23-hour gap (a DST spring-forward day between two local-midnight dates)
  // rounds to one day; Math.trunc would read it as zero (review pass 2).
  ok(captureDaysApart("2026-03-08T00:00:00Z", "2026-03-08T23:00:00Z") === 1, "captureDaysApart: a 23h gap rounds to 1 day, not 0 (DST tooth)");
}

// freshnessVerdict: names a stale peer; current in lockstep.
{
  const mk = (over: Partial<BrainReading>): BrainReading => ({
    label: "x", info: baseInfo({}), thoughts: 597, highestMigration: 57, latestMigration: 57, newestCapture: "2026-09-24", boardSync: SYNCED, boardSyncUnread: null, ...over,
  });
  const a = mk({ label: "open-brain", thoughts: 597, highestMigration: 57, newestCapture: "2026-09-24" });
  const b = mk({ label: "open-brain-canary", thoughts: 407, highestMigration: 56, newestCapture: "2026-09-23" });
  const stale = freshnessVerdict(a, b, 56 - 57);
  ok(/open-brain-canary is 1 migration behind/.test(stale), `verdict names the migration-behind peer (${stale})`);
  ok(/1 day older/.test(stale) && /407 vs 597 thoughts/.test(stale), `verdict names the capture and count deltas (${stale})`);
  const lock = freshnessVerdict(a, mk({ label: "peer", thoughts: 597, highestMigration: 57, newestCapture: "2026-09-24" }), 0);
  ok(/current with each other/.test(lock), `verdict is "current" in lockstep (${lock})`);
  // Counts unread on both sides: never assert "same thought count" over two nulls.
  const unread = freshnessVerdict(mk({ thoughts: null, newestCapture: null }), mk({ thoughts: null, newestCapture: null }), 0);
  ok(/not certain/.test(unread) && !/same migration and thought count/.test(unread), `verdict does not claim same count when both counts unread (${unread})`);

  // The board-sync watermark (SMD-2261): the incident — same count, same newest
  // capture, same migration, but a day of the board's status moves missed.
  const behind = freshnessVerdict(a, mk({ label: "open-brain-canary", boardSync: "2026-09-23T11:00:00.000Z" }), 0);
  ok(behind === "open-brain-canary's board-sync watermark is 1 day older.", `verdict names a board-stale peer on the watermark alone (${behind})`);
  const ahead = freshnessVerdict(a, mk({ label: "peer", boardSync: "2026-09-27T12:00:00.000Z" }), 0);
  ok(/peer's board-sync watermark is 3 days newer/.test(ahead), `verdict names a peer ahead on board sync (${ahead})`);
  // Under half a day apart is lockstep, and the claim says the watermark was compared.
  const near = freshnessVerdict(a, mk({ label: "peer", boardSync: "2026-09-24T01:00:00.000Z" }), 0);
  ok(near === "current with each other — same migration and thought count, board-sync watermarks under half a day apart.", `watermarks under half a day apart read current (${near})`);
  // Neither brain holds a watermark: no delta, and no claim about watermarks that do not exist.
  const neither = freshnessVerdict(mk({ boardSync: null }), mk({ label: "peer", boardSync: null }), 0);
  ok(neither === "current with each other — same migration and thought count.", `two brains with no watermark claim nothing about one (${neither})`);
  // By magnitude: the standing does not depend on which brain is a.
  const at = (h: number) => mk({ boardSync: new Date(Date.parse(SYNCED) + h * 3_600_000).toISOString() });
  const days = [12, -12, 36, -36, 11, -11].map((h) => { const d = boardSyncDelta(mk({}), at(h)); return d && "days" in d ? d.days : "x"; });
  ok(days.join(",") === "1,-1,2,-2,0,0", `whole days by magnitude, symmetric in a and b (${days.join(",")})`);
  const none = freshnessVerdict(a, mk({ label: "fresh", boardSync: null }), 0);
  ok(/fresh holds no usable board-sync watermark/.test(none), `a peer with no watermark is named (${none})`);
  // Either side: a's none named as a's, a's unread no delta (review pass 1: only b's side was driven).
  const aNone = freshnessVerdict(mk({ label: "bare", boardSync: null }), mk({ label: "peer" }), 0);
  ok(/bare holds no usable board-sync watermark/.test(aNone), `a's missing watermark is named as a's (${aNone})`);
  const aUnread = freshnessVerdict(mk({ boardSync: null, boardSyncUnread: OLDER_SERVER }), mk({ label: "peer", boardSync: "2026-09-20T12:00:00.000Z" }), 0);
  ok(aUnread === "current with each other — same migration and thought count.", `a's unread watermark is no delta and no claim (${aUnread})`);
  // An unread side is not a delta, and "current" does not claim the watermark.
  // A new server that did not read it (the /health deadline) is not "current" — on
  // either side; an older server's absence stays quiet (review pass 2).
  for (const [side, x, y] of [["b", a, mk({ label: "peer", boardSync: null, boardSyncUnread: "the brain did not read it" })], ["a", mk({ boardSync: null, boardSyncUnread: "the brain did not read it" }), mk({ label: "peer" })]] as const) {
    const v = freshnessVerdict(x, y, 0);
    ok(v === "no delta on what could be read; board-sync watermark unread, so freshness is not certain.", `a watermark the ${side} side did not read is not "current" (${v})`);
  }
  // A malformed value from a peer is a watermark not given too (review pass 3).
  const bad = freshnessVerdict(a, mk({ label: "peer", boardSync: null, boardSyncUnread: "the record's value is not an ISO instant" }), 0);
  ok(/board-sync watermark unread, so freshness is not certain/.test(bad), `a malformed peer watermark is "not certain" (${bad})`);
  // A database that did not answer: the ledger and the count say so, named as a list; the watermark is not named for it.
  const down = freshnessVerdict(a, mk({ label: "down", thoughts: null, boardSync: null, boardSyncUnread: "the database did not answer" }), null);
  ok(down === "no delta on what could be read; migration ledger and thought count unread, so freshness is not certain.", `a database that did not answer names the ledger and count only (${down})`);
  const three = freshnessVerdict(a, mk({ label: "x", thoughts: null, boardSync: null, boardSyncUnread: "the brain did not read it" }), null);
  ok(three === "no delta on what could be read; migration ledger, thought count and board-sync watermark unread, so freshness is not certain.", `three unread axes read as one list (${three})`);
  const older = freshnessVerdict(a, mk({ label: "old", boardSync: null, boardSyncUnread: OLDER_SERVER }), 0);
  ok(older === "current with each other — same migration and thought count.", `an unread watermark is no delta and no claim (${older})`);
  ok(boardSyncDelta(a, mk({ boardSync: null, boardSyncUnread: "x" })) === null && boardSyncDelta(mk({ boardSync: null }), mk({ boardSync: null })) === null, "boardSyncDelta: unread or none on both sides is no delta");
}

// boardSyncOf: the record's watermark, or why it is not there.
{
  ok(boardSyncOf(baseInfo({})).boardSync === SYNCED && boardSyncOf(baseInfo({})).boardSyncUnread === null, "boardSyncOf reads the record's watermark");
  const none = boardSyncOf(baseInfo({ boardSync: null }));
  ok(none.boardSync === null && none.boardSyncUnread === null, "boardSyncOf: a null watermark is no Linear rows, read");
  ok(boardSyncOf(baseInfo({ boardSync: "absent" })).boardSyncUnread === OLDER_SERVER, "boardSyncOf: no field is an older server, unread — the reason the verdict stays quiet for");
  const unreadInfo = baseInfo({ boardSync: null });
  if (!("error" in unreadInfo.database)) unreadInfo.database.unread = { boardSync: { reason: "timeout", message: "canceling statement due to statement timeout" } };
  ok(/did not read/.test(boardSyncOf(unreadInfo).boardSyncUnread ?? ""), "boardSyncOf: a read named in unread is unread, not no rows");
  ok(/did not answer/.test(boardSyncOf(baseInfo({ database: { error: "down" } })).boardSyncUnread ?? ""), "boardSyncOf: a database that did not answer is unread");
  // A value that is not the server's ISO instant is unread, not "no watermark".
  const odd = ["2026-09-24", "yesterday", "2026-13-40T00:00:00.000Z"].map((w) => boardSyncOf(baseInfo({ boardSync: w })));
  const num = baseInfo({});
  if (!("error" in num.database)) (num.database as { boardSync: unknown }).boardSync = 1727179200000;
  ok([...odd, boardSyncOf(num)].every((r) => r.boardSync === null && /not an ISO instant/.test(r.boardSyncUnread ?? "")), "boardSyncOf: a malformed or non-string value is unread, not no watermark");
}

// trimBase: one or many trailing slashes removed.
ok(trimBase("http://h:1///") === "http://h:1" && trimBase("http://h:1") === "http://h:1", "trimBase strips trailing slashes");

// splitKeyFromUrl: the ?key= comes off the base (trailing slash trimmed); invalid → null.
{
  const s = splitKeyFromUrl("http://h:1/mcp/?key=SEKRIT");
  ok(s?.base === "http://h:1/mcp" && s.urlKey === "SEKRIT", `splitKeyFromUrl lifts ?key= off a trimmed base (${JSON.stringify(s)})`);
  ok(splitKeyFromUrl("http://h:1/")?.urlKey === undefined, "splitKeyFromUrl: no ?key= → undefined key");
  ok(splitKeyFromUrl("not a url") === null, "splitKeyFromUrl: an invalid URL → null");
}

// ---------------------------------------------------------------------------
// resolveBrain — a URL, its ?key=, a missing key.
// ---------------------------------------------------------------------------
{
  const withKey = await resolveBrain("http://localhost:9/mcp?key=SEKRIT", undefined, undefined);
  ok(withKey.base === "http://localhost:9/mcp" && withKey.key === "SEKRIT", "resolveBrain lifts ?key= off the base into the key");
  const argKey = await resolveBrain("http://localhost:9/", "argkey", "envkey");
  ok(argKey.key === "argkey", "resolveBrain: --a-key wins over the env");
  const envKey = await resolveBrain("http://localhost:9/", undefined, "envkey");
  ok(envKey.key === "envkey", "resolveBrain: OB1_COMPARE_KEY used when no arg/URL key");
  let threw = "";
  try { await resolveBrain("http://localhost:9/", undefined, undefined); } catch (e) { threw = (e as Error).message; }
  ok(/no read key/.test(threw), "resolveBrain refuses a URL with no key anywhere");
  // An invalid URL's ?key= is not echoed in the error (review pass 2 key-safety tidy).
  let badUrl = "";
  try { await resolveBrain("http://[oops?key=SEKRIT", undefined, undefined); } catch (e) { badUrl = (e as Error).message; }
  ok(/is not a valid URL/.test(badUrl) && !/SEKRIT/.test(badUrl), `an invalid URL's ?key= is not echoed (${badUrl})`);
}

// ---------------------------------------------------------------------------
// getBrainInfo — a record for a reader, "ok" for a non-reader.
// ---------------------------------------------------------------------------
{
  const { server, ep } = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  try {
    const info = await getBrainInfo(ep);
    ok(info.version === "1.2.0+upstream.9543c29", "getBrainInfo parses the /health record");
    let threw = "";
    try { await getBrainInfo({ ...ep, key: "wrong" }); } catch (e) { threw = (e as Error).message; }
    ok(/not the record|not admitted/.test(threw), "getBrainInfo: a non-reader key gets \"ok\", read as not-admitted");
  } finally { server.stop(true); }
}

// ---------------------------------------------------------------------------
// compareBrains — the two live cases.
// ---------------------------------------------------------------------------

// A day-stale canary: a migration behind, fewer thoughts — the motivating incident.
{
  const stable = startFake({
    info: baseInfo({ tier: "stable", thoughts: 597, highestMigration: 57 }),
    newest: "9/24/2026",
    hits: { "highest value ticket": ["11111111-0000-0000-0000-000000000000", "22222222-0000-0000-0000-000000000000"] },
  });
  const canary = startFake({
    info: baseInfo({ tier: "canary", commit: "def5678", thoughts: 407, highestMigration: 56 }),
    newest: "9/23/2026",
    sse: true,
    hits: { "highest value ticket": ["11111111-0000-0000-0000-000000000000", "33333333-0000-0000-0000-000000000000"] },
  });
  try {
    const c = await compareBrains(stable.ep, canary.ep, { queries: ["highest value ticket"], hybrid: false });
    const fields = c.identity.map((d) => d.field);
    ok(fields.includes("tier") && fields.includes("commit") && fields.includes("highestMigration"), `identity delta names tier, commit and highestMigration (${fields.join(",")})`);
    ok(c.migrationDelta === -1, `migrationDelta = -1 (canary one behind) (${c.migrationDelta})`);
    ok(c.counts.a === 597 && c.counts.b === 407, "counts carried from brain_info");
    ok(/1 migration behind/.test(c.verdict) && /407 vs 597/.test(c.verdict), `verdict flags the stale canary (${c.verdict})`);
    const row = c.retrieval?.rows[0];
    ok(row?.arm === "keyword" && row.changed && row.onlyB.length === 1 && row.onlyA.length === 1, "retrieval: the keyword arm diff names the moved ids over SSE framing");
    // Key never printed.
    const out = renderComparison(c);
    ok(!out.includes(KEY) && !JSON.stringify(c).includes(KEY), "neither the report nor the Comparison JSON carries the read key");
    ok(/query_log/.test(out), "the retrieval section discloses that --replay's searches are logged on a query-logging brain");
  } finally { stable.server.stop(true); canary.server.stop(true); }
}

// identity labels an absent pgvector "none", not "unread" (a database that answered).
{
  const noVec = baseInfo({});
  (noVec.database as { pgvector: unknown }).pgvector = null;
  const a = startFake({ info: noVec, newest: "9/24/2026", hits: {} });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    const pg = c.identity.find((d) => d.field === "pgvector");
    ok(pg?.a === "none" && pg.b === "0.8.0", `an absent pgvector reads "none" (not "unread") against a brain that has it (${JSON.stringify(pg)})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// Two identical brains: no delta on any axis, verdict current.
{
  const mk = () => startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q: ["aaaaaaaa-0000-0000-0000-000000000000"] }, corpus: { ids: ["aaaaaaaa-0000-0000-0000-000000000000"] } });
  const a = mk();
  const b = mk();
  try {
    const c = await compareBrains(a.ep, b.ep, { queries: ["q"] });
    ok(c.identity.length === 0, "identical brains: no identity delta");
    ok(c.migrationDelta === 0, "identical brains: migrationDelta 0");
    ok(c.idDiff.equal, "identical brains: id-set equal");
    ok(c.retrieval!.rows.every((r) => !r.changed), "identical brains: retrieval unchanged");
    ok(/current with each other/.test(c.verdict), `identical brains: verdict current (${c.verdict})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// ---------------------------------------------------------------------------
// The exact id-set difference (SMD-2244).
// ---------------------------------------------------------------------------
const uid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`;

// Differing corpora, same count (drifted): the exact only-a / only-b, enumerated because digests differ.
{
  const a = startFake({ info: baseInfo({ thoughts: 3 }), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2), uid(3)] } });
  const b = startFake({ info: baseInfo({ thoughts: 3 }), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2), uid(9)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!c.idDiff.equal && c.idDiff.onlyA.join() === uid(3) && c.idDiff.onlyB.join() === uid(9), `same-count corpus drift caught exactly (onlyA=${c.idDiff.onlyA}, onlyB=${c.idDiff.onlyB})`);
    ok(/id-set: 1 only in a.*1 only in b/.test(renderComparison(c)), "render names the exact id-set difference");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// Paging: a corpus larger than a page is enumerated via the cursor and still diffs fully.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2), uid(3), uid(4), uid(5)], pageCap: 2 } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2), uid(3), uid(4)], pageCap: 2 } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!c.idDiff.equal && c.idDiff.onlyA.join() === uid(5) && c.idDiff.onlyB.length === 0, `paged enumeration (cap 2) finds the one missing id (onlyA=${c.idDiff.onlyA})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// The digest fast path: equal digests report the corpora equal WITHOUT enumerating —
// forced here by giving two different id sets the same digest, so a match proves no paging.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2)], digest: "SAMEDIGEST" } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(7), uid(8)], digest: "SAMEDIGEST" } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(c.idDiff.equal && c.idDiff.onlyA.length === 0 && c.idDiff.onlyB.length === 0, "equal digests short-circuit enumeration (fast path taken, sets never compared)");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// Null digests (the PostgREST shim) are NOT read as a match (null === null): with
// DIFFERING sets, dropping the `!= null` guard would wrongly report equal, so the
// diff must be enumerated and find the difference (review pass 1 tooth).
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2)], digest: null } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)], digest: null } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!c.idDiff.equal && c.idDiff.onlyA.join() === uid(2) && c.idDiff.onlyB.length === 0, `two null digests are enumerated, not matched — the difference is found (onlyA=${c.idDiff.onlyA})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A real (non-unknown-tool) failure on the FIRST page → id-set `failed`, not
// `unavailable`, and the rest of the compare still prints.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)], fail: "Refused: the id set may not leave the box" } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!c.idDiff.unavailable && /may not leave the box/.test(c.idDiff.failed ?? ""), `a non-unknown-tool error is failed-with-reason, not "unavailable" (${c.idDiff.failed})`);
    ok(/current with each other/.test(c.verdict), "the rest of the compare still produced a verdict");
    ok(/id-set: could not be read/.test(renderComparison(c)), "render says the id-set could not be read");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A mid-enumeration failure (page 2 errors) → `failed`, the whole compare does NOT abort.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2), uid(3)], pageCap: 1, failAfter: true } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(4), uid(5)], pageCap: 1, failAfter: true } });
  let c: Awaited<ReturnType<typeof compareBrains>> | null = null;
  try {
    try { c = await compareBrains(a.ep, b.ep, {}); } catch { c = null; }
    ok(c !== null, "a page-2 failure does not abort the whole compare (it returned)");
    ok(!!c && !!c.idDiff.failed && !c.idDiff.unavailable, `a mid-walk failure is failed-with-reason (${c?.idDiff.failed})`);
    ok(!!c && /current with each other/.test(c.verdict), "the verdict still printed");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A gateway 404 on the MCP POST (while /health still routes) is a read FAILURE, not
// "an older brain" — the r.ok check + tightened isAbsent keep a "404 page not found"
// body from being misread as an absent tool (review pass 2).
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)] }, proxy404: true });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!c.idDiff.unavailable && /HTTP 404/.test(c.idDiff.failed ?? ""), `a proxy 404 is failed (HTTP status), not "unavailable" (${c.idDiff.failed})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A valid-JSON page whose ids is not an array is a failure, not a silent empty corpus.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)], badShape: true } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!!c.idDiff.failed && /no ids array/.test(c.idDiff.failed) && !c.idDiff.equal, `a malformed ids page fails, not a silent empty read (${c.idDiff.failed})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A short enumeration (fewer ids than the reported total — a PostgREST db-max-rows
// below the page size) fails, not a partial diff read as real (review pass 3).
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)], digest: null, fakeTotal: 5 } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)], digest: null } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!!c.idDiff.failed && /fewer ids than the corpus total/.test(c.idDiff.failed) && !c.idDiff.equal, `a short enumeration fails, not a partial diff (${c.idDiff.failed})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A non-advancing cursor is a failure, not a partial diff read as real.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2)], digest: null, stuckCursor: true } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(3), uid(4)], digest: null, stuckCursor: true } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(!!c.idDiff.failed && /did not advance/.test(c.idDiff.failed) && !c.idDiff.equal, `a stuck cursor fails, not a partial diff (${c.idDiff.failed})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A brain that predates the tool → unavailable; the count stand-in holds, no crash.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} }); // no corpus → list_thought_ids absent
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, {});
    ok(c.idDiff.unavailable === true && c.idDiff.onlyA.length === 0, "a brain lacking list_thought_ids → id-set unavailable, not a crash");
    ok(/id-set: unavailable/.test(renderComparison(c)), "render discloses the id-set is unavailable");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// runCompare exit code: a same-count, same-migration corpus drift still exits 1 via the id-set delta.
{
  const a = startFake({ info: baseInfo({ thoughts: 2 }), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(2)] } });
  const b = startFake({ info: baseInfo({ thoughts: 2 }), newest: "9/24/2026", hits: {}, corpus: { ids: [uid(1), uid(3)] } });
  const log = console.log;
  console.log = () => {};
  let code = -1;
  try {
    code = await runCompare({ a: a.ep.base, b: b.ep.base, aKey: KEY, bKey: KEY, replay: false, hybrid: false, queries: [], json: false });
  } finally { console.log = log; a.server.stop(true); b.server.stop(true); }
  ok(code === 1, `runCompare exits 1 on a same-count id-set drift (${code})`);
}

// A refused query is skipped-with-reason and does not abort the compare.
{
  const cfg = () => ({ info: baseInfo({}), newest: "9/24/2026", hits: { good: ["aaaaaaaa-0000-0000-0000-000000000000"] }, refuse: ["bad"] });
  const a = startFake(cfg());
  const b = startFake(cfg());
  try {
    // Guarded: without the per-row catch this rejects, and the mutant must fail an
    // arm here rather than crash the suite.
    let c: Awaited<ReturnType<typeof compareBrains>> | null = null;
    try { c = await compareBrains(a.ep, b.ep, { queries: ["good", "bad"] }); } catch { c = null; }
    ok(c !== null, "a refused query does not abort the whole compare (it returned)");
    const rows = c?.retrieval?.rows ?? [];
    const bad = rows.find((r) => r.query === "bad");
    const good = rows.find((r) => r.query === "good");
    ok(rows.length === 2 && !!bad?.skipped && !bad.changed, "a refused query is a skipped row, not a change");
    ok(!!good && !good.changed, "the other query still ran despite the refusal (no whole-compare abort)");
    ok(!!c && /current with each other/.test(c.verdict), `the compare still produced a verdict (${c?.verdict})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// When every query is skipped, the retrieval section says "nothing compared", not "no delta".
{
  const cfg = () => ({ info: baseInfo({}), newest: "9/24/2026", hits: {}, refuse: ["only"] });
  const a = startFake(cfg());
  const b = startFake(cfg());
  try {
    const c = await compareBrains(a.ep, b.ep, { queries: ["only"] });
    const out = renderComparison(c);
    ok(/nothing compared — all 1 replay/.test(out) && !/no delta — b returns/.test(out), `all-skipped retrieval reads "nothing compared", not "no delta"`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// runCompare exit code: the gate. A same-migration count drift still exits 1;
// identical brains exit 0.
{
  const drift = async (over: Partial<Parameters<typeof baseInfo>[0]>) => {
    const a = startFake({ info: baseInfo({ thoughts: 597, highestMigration: 57 }), newest: "9/24/2026", hits: {} });
    const b = startFake({ info: baseInfo({ thoughts: 597, highestMigration: 57, ...over }), newest: "9/24/2026", hits: {} });
    const log = console.log;
    console.log = () => {};
    try {
      return await runCompare({ a: a.ep.base, b: b.ep.base, aKey: KEY, bKey: KEY, replay: false, hybrid: false, queries: [], json: false });
    } finally { console.log = log; a.server.stop(true); b.server.stop(true); }
  };
  ok((await drift({ thoughts: 407 })) === 1, "runCompare exits 1 on a same-migration thought-count drift (the confidently-stale case)");
  ok((await drift({})) === 0, "runCompare exits 0 when the two brains are identical");
  // SMD-2261: the watermark alone moves the gate — same count, capture and ledger.
  ok((await drift({ boardSync: "2026-09-23T12:00:00.000Z" })) === 1, "runCompare exits 1 on a board-sync watermark a day behind, nothing else differing");
  ok((await drift({ boardSync: null })) === 1, "runCompare exits 1 when one brain holds no board-sync watermark");
  ok((await drift({ boardSync: "2026-09-24T08:00:00.000Z" })) === 0, "runCompare exits 0 on watermarks under half a day apart");
  ok((await drift({ boardSync: "absent" })) === 0, "runCompare exits 0 when a brain older than SMD-2261 sends no watermark");
  ok((await drift({ boardSync: "unread" })) === 0, "runCompare exits 0 when a brain did not read its watermark — an unread axis, not a delta");
}

// The report's Freshness line: each brain's watermark, and no out-of-reach note.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  const b = startFake({ info: baseInfo({ boardSync: "absent" }), newest: "9/24/2026", hits: {} });
  try {
    const out = renderComparison(await compareBrains(a.ep, b.ep, {}));
    ok(out.includes(`  board sync: a=${SYNCED}  b=unread`), `the Freshness section prints each watermark, an older brain's as unread (${out.split("\n").find((l) => l.includes("board sync"))})`);
    ok(!/not on the read surface/.test(out), "the board-sync out-of-reach note is gone");
  } finally { a.server.stop(true); b.server.stop(true); }
  const c = startFake({ info: baseInfo({ boardSync: null }), newest: "9/24/2026", hits: {} });
  const d = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  try {
    const out = renderComparison(await compareBrains(c.ep, d.ep, {}));
    ok(out.includes(`  board sync: a=none  b=${SYNCED}`), `a brain with no watermark prints none, not unread (${out.split("\n").find((l) => l.includes("board sync"))})`);
  } finally { c.server.stop(true); d.server.stop(true); }
  const e = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  const f = startFake({ info: baseInfo({ boardSync: "unread" }), newest: "9/24/2026", hits: {} });
  try {
    const out = renderComparison(await compareBrains(e.ep, f.ep, {}));
    ok(out.includes(`  board sync: a=${SYNCED}  b=unread (the brain did not read it: deadline)`), `a watermark a new server did not read says why (${out.split("\n").find((l) => l.includes("board sync"))})`);
  } finally { e.server.stop(true); f.server.stop(true); }
}

// ---------------------------------------------------------------------------
// The log-sourced replay (SMD-2245).
// ---------------------------------------------------------------------------

// replayPlanFromLog: each search on its arm, null-arm and empty-query skipped, dedup.
{
  const plan = replayPlanFromLog([
    { query: "a", arm: "keyword" },
    { query: "a", arm: "keyword" }, // dup
    { query: "b", arm: null }, // null arm (pre-045) — skipped
    { query: "", arm: "hybrid" }, // empty — skipped
    { query: "c", arm: "hybrid" },
  ]);
  ok(plan.length === 2 && plan[0].query === "a" && plan[0].arm === "keyword" && plan[1].query === "c" && plan[1].arm === "hybrid", `replayPlanFromLog dedups, skips null-arm and empty (${JSON.stringify(plan)})`);
  // 059's arm (SMD-2255): a prefer_current search is replayed as one, not dropped.
  const withCurrent = replayPlanFromLog([{ query: "d", arm: "current" }, { query: "d", arm: "hybrid" }]);
  ok(withCurrent.length === 2 && withCurrent[0].arm === "current" && withCurrent[1].arm === "hybrid", `a logged current search is its own replay entry beside the hybrid one (${JSON.stringify(withCurrent)})`);
}

// A current-arm row replays as search_thoughts with prefer_current: the fake
// answers from `<q>#current` only when the flag is sent, so a replay that dropped
// it would read q's plain hits on both brains and see no change.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q3: [uid(1)], "q3#current": [uid(3)] } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q3: [uid(1)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, { fromLog: replayPlanFromLog([{ query: "q3", arm: "current" }]), source: "the log of open-brain" });
    const row = c.retrieval!.rows[0];
    ok(row?.arm === "current" && row.changed && row.a.join() === uid(3) && row.b.join() === uid(1), `a current-arm row replays with prefer_current on both brains (${JSON.stringify(row && [row.a, row.b])})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// fetchLoggedSearches + a from-log plan: each logged search replays on ITS arm, the
// diff names what moved; the report says the source and the count.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q1: [uid(1)], q2: [uid(2)] } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q1: [uid(1)], q2: [uid(9)] } });
  try {
    const plan = replayPlanFromLog([{ query: "q1", arm: "keyword" }, { query: "q2", arm: "hybrid" }]);
    const c = await compareBrains(a.ep, b.ep, { fromLog: plan, source: "the log of open-brain", truncated: true });
    ok(c.retrieval!.queries === 2 && c.retrieval!.arms.includes("keyword") && c.retrieval!.arms.includes("hybrid"), "both arms of the log plan run");
    const moved = c.retrieval!.rows.filter((r) => r.changed);
    ok(moved.length === 1 && moved[0].arm === "hybrid" && moved[0].onlyA.join() === uid(2) && moved[0].onlyB.join() === uid(9), "q2 (hybrid) moved; q1 (keyword) matched");
    const out = renderComparison(c);
    ok(/from the log of open-brain/.test(out) && /window truncated/.test(out), `render names the log source and the truncation (${out.split("\n").find((l) => l.includes("arms:"))})`);
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A --from-log source with an empty log: the report says so, does not silently skip.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  try {
    const c = await compareBrains(a.ep, b.ep, { fromLog: [], source: "the log of open-brain-canary" });
    ok(c.retrieval !== null && c.retrieval.queries === 0, "an empty log still reports a retrieval section");
    ok(/logged no searches/.test(renderComparison(c)), "render says the source logged no searches");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// fetchLoggedSearches over the fake: parses {searches, truncated}; an absent tool throws.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {}, log: { searches: [{ query: "x", arm: "keyword" }], truncated: true } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} }); // no log → tool absent
  try {
    const page = await fetchLoggedSearches(a.ep, null);
    ok(page.searches.length === 1 && page.searches[0].query === "x" && page.truncated === true, "fetchLoggedSearches parses the page");
    let threw = "";
    try { await fetchLoggedSearches(b.ep, null); } catch (e) { threw = (e as Error).message; }
    ok(/unknown tool|not found/i.test(threw), "a brain without list_logged_searches throws (the caller surfaces it)");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// A --from-log source that resolves but LACKS the tool (older brain) degrades — the
// compare still prints identity/freshness, and the retrieval says it could not read.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} }); // no `log` → tool absent
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  const logFn = console.log;
  console.log = () => {};
  let code = -1;
  let c: Awaited<ReturnType<typeof compareBrains>> | null = null;
  try {
    // runCompare degrades a fetch failure; capture the Comparison via a spy on render.
    code = await runCompare({ a: a.ep.base, b: b.ep.base, aKey: KEY, bKey: KEY, replay: true, hybrid: false, queries: [], fromLog: `${a.ep.base}?key=${KEY}`, json: false });
  } catch { code = -2; } finally { console.log = logFn; }
  ok(code === 0 || code === 1, `runCompare --from-log with a tool-absent source does NOT abort (returned ${code}, not a throw)`);
  // And the degradation shows in the report (drive compareBrains directly for the assert).
  const a2 = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  const b2 = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: {} });
  try {
    c = await compareBrains(a2.ep, b2.ep, { fromLog: [], source: "the log of open-brain", sourceError: "open-brain: list_logged_searches — Tool list_logged_searches not found" });
    ok(/could not read the log of open-brain/.test(renderComparison(c!)) && /identity and freshness above still compare/.test(renderComparison(c!)), "the report degrades the log-source failure and keeps the rest");
  } finally { a2.server.stop(true); b2.server.stop(true); a.server.stop(true); b.server.stop(true); }
}

// The supplied+hybrid path reports "replays" (query-arm pairs), not "queries".
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q: [uid(1)] } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q: [uid(1)] } });
  try {
    const c = await compareBrains(a.ep, b.ep, { queries: ["q"], hybrid: true, source: "the supplied queries" });
    ok(c.retrieval!.queries === 2, "one query on two arms is two replays");
    ok(/over 2 replays from the supplied queries/.test(renderComparison(c)), "render says '2 replays', not '2 queries'");
  } finally { a.server.stop(true); b.server.stop(true); }
}

// runCompare --from-log end to end: resolves the source, replays its log, exits 1 on a delta.
{
  const a = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q: [uid(1)] }, log: { searches: [{ query: "q", arm: "keyword" }] } });
  const b = startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q: [uid(2)] } });
  const logFn = console.log;
  console.log = () => {};
  let code = -1;
  try {
    code = await runCompare({ a: a.ep.base, b: b.ep.base, aKey: KEY, bKey: KEY, replay: true, hybrid: false, queries: [], fromLog: `${a.ep.base}?key=${KEY}`, json: false });
  } finally { console.log = logFn; a.server.stop(true); b.server.stop(true); }
  ok(code === 1, `runCompare --from-log replays the log and exits 1 on a retrieval delta (${code})`);
}

// ---------------------------------------------------------------------------
// parseCompareArgs (in tier.ts) — grammar teeth.
// ---------------------------------------------------------------------------
{
  const p = parseCompareArgs(["--compare", "open-brain", "open-brain-canary", "--replay", "--query", "one", "--query", "two", "--json"]);
  ok(p.a === "open-brain" && p.b === "open-brain-canary", "parseCompareArgs: two positional brains");
  ok(p.replay && p.json && p.queries.length === 2, "parseCompareArgs: --replay, --json and a repeatable --query");
  // --replay with no queries is refused. parseCompareArgs exits the process, so
  // drive it through the real CLI in a child (it refuses before any network).
  const child = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay"], { cwd: import.meta.dir });
  ok(child.exitCode === 2 && /needs a query source/.test(child.stderr.toString()), `parseCompareArgs: --replay with no query source is refused with exit 2 (${child.exitCode})`);
  // An empty --query value is refused before any network, not sent to the brain.
  const emptyQ = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--query", ""], { cwd: import.meta.dir });
  ok(emptyQ.exitCode === 2 && /--query is empty/.test(emptyQ.stderr.toString()), `parseCompareArgs: an empty --query is refused with exit 2 (${emptyQ.exitCode})`);
  // A query set with no --replay is refused rather than silently ignored.
  const noReplay = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--query", "x"], { cwd: import.meta.dir });
  ok(noReplay.exitCode === 2 && /only apply with --replay/.test(noReplay.stderr.toString()), `parseCompareArgs: --query without --replay is refused with exit 2 (${noReplay.exitCode})`);
  // --from-log's grammar: two sources, --hybrid, and missing --replay each refused.
  const twoSrc = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--from-log", "z", "--query", "q"], { cwd: import.meta.dir });
  ok(twoSrc.exitCode === 2 && /two query sources/.test(twoSrc.stderr.toString()), `parseCompareArgs: --from-log with --query is refused (${twoSrc.exitCode})`);
  const logHybrid = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--from-log", "z", "--hybrid"], { cwd: import.meta.dir });
  ok(logHybrid.exitCode === 2 && /--hybrid does not apply to --from-log/.test(logHybrid.stderr.toString()), `parseCompareArgs: --from-log with --hybrid is refused (${logHybrid.exitCode})`);
  const sinceNoLog = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--since", "2026-01-01"], { cwd: import.meta.dir });
  ok(sinceNoLog.exitCode === 2 && /--since only applies with --from-log/.test(sinceNoLog.stderr.toString()), `parseCompareArgs: --since without --from-log is refused (${sinceNoLog.exitCode})`);
  const emptyLog = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--from-log", ""], { cwd: import.meta.dir });
  ok(emptyLog.exitCode === 2 && /--from-log is empty/.test(emptyLog.stderr.toString()), `parseCompareArgs: an empty --from-log is refused (${emptyLog.exitCode})`);
  const badSince = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--from-log", "z", "--since", "not-a-time"], { cwd: import.meta.dir });
  ok(badSince.exitCode === 2 && /--since must be an ISO-8601 time/.test(badSince.stderr.toString()), `parseCompareArgs: a malformed --since is refused (${badSince.exitCode})`);
  const dupLog = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--from-log", "z", "--from-log", "w"], { cwd: import.meta.dir });
  ok(dupLog.exitCode === 2 && /--from-log given twice/.test(dupLog.stderr.toString()), `parseCompareArgs: a duplicate single-value flag is refused (${dupLog.exitCode})`);
}

console.log(`\ntest-brain-compare: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
