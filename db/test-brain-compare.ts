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
  captureDaysApart,
  compareBrains,
  diffRow,
  freshnessVerdict,
  getBrainInfo,
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
  corpus?: { ids: string[]; digest?: string | null; pageCap?: number; fail?: string; failAfter?: boolean };
  /** frame the tools/call reply as an SSE stream rather than raw JSON. */
  sse?: boolean;
}

/** The SQL store's digest: md5 of all ids joined by ',' in id order. */
function corpusDigest(ids: string[]): string {
  return createHash("md5").update([...ids].sort().join(",")).digest("hex");
}

function baseInfo(over: Partial<BrainInfo> & { thoughts?: number; highestMigration?: number }): BrainInfo {
  const thoughts = over.thoughts ?? 597;
  const highest = over.highestMigration ?? 57;
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
      hnsw: [],
      unread: {},
      ledger: { present: true, readable: true },
    },
  };
  return { ...info, ...over };
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
        const body = (await req.json()) as { id: number; params: { name: string; arguments: { query?: string; limit?: number; after?: string } } };
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
          const cap = cfg.corpus.pageCap ?? 1000;
          const limit = Math.min(Number(body.params.arguments.limit ?? 1000), cap);
          const start = after ? all.findIndex((id) => id > after) : 0;
          const slice = start < 0 ? [] : all.slice(start, start + limit);
          const cursor = slice.length === limit && slice.length > 0 ? slice[slice.length - 1] : null;
          const digest = isFirst ? (cfg.corpus.digest !== undefined ? cfg.corpus.digest : corpusDigest(all)) : null;
          text = JSON.stringify({ total: isFirst ? all.length : 0, digest, ids: slice, cursor });
        } else if (name === "thought_stats") {
          if (cfg.newest === null) return replyError(body.id, "thought_stats unavailable", cfg.sse);
          const total = "counts" in cfg.info.database ? (cfg.info.database.counts?.thoughts ?? 0) : 0;
          text = `Total thoughts: ${total}\nDate range: 1/1/2026 → ${cfg.newest}`;
        } else if (name === "search_thoughts_keyword" || name === "search_thoughts") {
          const q = body.params.arguments.query ?? "";
          if (cfg.refuse?.includes(q)) return replyError(body.id, `Refused: the query may not leave the box`, cfg.sse);
          const ids = cfg.hits[q] ?? [];
          // The real result format: a "--- Result N ---" header, ID: as the first
          // field, then the hit's raw content — which here itself quotes an ID: line,
          // so a content-blind parse would over-count (the parseResultIds tooth).
          text = ids.length
            ? ids
                .map((id, i) => `--- Result ${i + 1} (1 occurrence) ---\nID: ${id}\nType: reference\n\nA note that mentions\nID: 00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`)
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
    label: "x", info: baseInfo({}), thoughts: 597, highestMigration: 57, latestMigration: 57, newestCapture: "2026-09-24", ...over,
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
    ok(/nothing compared — all 1 query/.test(out) && !/no delta — b returns/.test(out), `all-skipped retrieval reads "nothing compared", not "no delta"`);
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
  ok(child.exitCode === 2 && /needs a query set/.test(child.stderr.toString()), `parseCompareArgs: --replay with no query set is refused with exit 2 (${child.exitCode})`);
  // An empty --query value is refused before any network, not sent to the brain.
  const emptyQ = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--replay", "--query", ""], { cwd: import.meta.dir });
  ok(emptyQ.exitCode === 2 && /--query is empty/.test(emptyQ.stderr.toString()), `parseCompareArgs: an empty --query is refused with exit 2 (${emptyQ.exitCode})`);
  // A query set with no --replay is refused rather than silently ignored.
  const noReplay = Bun.spawnSync(["bun", "tier.ts", "--compare", "a", "b", "--query", "x"], { cwd: import.meta.dir });
  ok(noReplay.exitCode === 2 && /only apply with --replay/.test(noReplay.stderr.toString()), `parseCompareArgs: --query without --replay is refused with exit 2 (${noReplay.exitCode})`);
}

console.log(`\ntest-brain-compare: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
