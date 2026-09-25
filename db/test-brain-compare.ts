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
  /** frame the tools/call reply as an SSE stream rather than raw JSON. */
  sse?: boolean;
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
        const body = (await req.json()) as { id: number; params: { name: string; arguments: { query?: string } } };
        const name = body.params.name;
        let text = "";
        if (name === "thought_stats") {
          if (cfg.newest === null) return replyError(body.id, "thought_stats unavailable", cfg.sse);
          const total = "counts" in cfg.info.database ? (cfg.info.database.counts?.thoughts ?? 0) : 0;
          text = `Total thoughts: ${total}\nDate range: 1/1/2026 → ${cfg.newest}`;
        } else if (name === "search_thoughts_keyword" || name === "search_thoughts") {
          const q = body.params.arguments.query ?? "";
          const ids = cfg.hits[q] ?? [];
          text = ids.length
            ? `${ids.length} result(s):\n\n` + ids.map((id, i) => `${i + 1}. some content\n   ID: ${id}`).join("\n\n")
            : "No matching thoughts found.";
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

// parseResultIds: only `ID:` lines, in order; the superseded marker's "ID <id>" is not a hit.
{
  const uuid = (n: string) => `${n.repeat(8)}-0000-0000-0000-000000000000`.slice(0, 36);
  const a = uuid("a");
  const b = uuid("b");
  const text = `1. hi\n   ID: ${a.toUpperCase()}\n   ⚠ Superseded by a newer thought — ID ${uuid("c")}\n2. yo\n   ID: ${b}`;
  const ids = parseResultIds(text);
  ok(ids.length === 2 && ids[0] === a && ids[1] === b, `parseResultIds reads the two ID: lines in order, lower-cased, and skips the "ID <id>" marker (${JSON.stringify(ids)})`);
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
}

// trimBase: one or many trailing slashes removed.
ok(trimBase("http://h:1///") === "http://h:1" && trimBase("http://h:1") === "http://h:1", "trimBase strips trailing slashes");

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
  } finally { stable.server.stop(true); canary.server.stop(true); }
}

// Two identical brains: no delta on any axis, verdict current.
{
  const mk = () => startFake({ info: baseInfo({}), newest: "9/24/2026", hits: { q: ["aaaaaaaa-0000-0000-0000-000000000000"] } });
  const a = mk();
  const b = mk();
  try {
    const c = await compareBrains(a.ep, b.ep, { queries: ["q"] });
    ok(c.identity.length === 0, "identical brains: no identity delta");
    ok(c.migrationDelta === 0, "identical brains: migrationDelta 0");
    ok(c.retrieval!.rows.every((r) => !r.changed), "identical brains: retrieval unchanged");
    ok(/current with each other/.test(c.verdict), `identical brains: verdict current (${c.verdict})`);
  } finally { a.server.stop(true); b.server.stop(true); }
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
}

console.log(`\ntest-brain-compare: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
