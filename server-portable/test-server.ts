import { createAssert } from "../db/test-support.ts";
import { queryLogEnabled, queryLogRetentionDays, QUERY_LOG } from "../db/config.mjs";
/**
 * test-server.ts
 *
 * Tests the REAL server. Not a mirror of it.
 *
 * ── Why that sentence is the whole point ──────────────────────────────────────
 * `../server/index.ts` cannot be imported by a test runner: it reads `Deno.env`
 * at module scope and imports `jsr:@supabase/functions-js/edge-runtime.d.ts`.
 * So the suites next to it (`server/test-*.mjs`) reimplement the server inline
 * and assert against the copy.
 *
 * That is not a stylistic choice — it is how upstream's auth assertions came to
 * claim HTTP 401 for three months after PR #243 changed the server to HTTP 200.
 * The copy kept passing. The fork's answer was a drift guard that greps
 * index.ts as text, which detects the problem but does not remove it.
 *
 * This file removes it. Because env is read lazily here, `index.ts` imports
 * cleanly under Bun/Node and every assertion below runs against the same code
 * that ships. There is nothing to drift from.
 *
 * Run: bun test-server.ts
 */

const { assert, report } = createAssert();

// Seed env before importing: the module itself no longer reads it at import
// time, but the first request will, and Workers-style bindings are absent here.
process.env.SUPABASE_URL = "https://stub.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role";
process.env.OPENROUTER_API_KEY = "stub-openrouter";
process.env.MCP_ACCESS_KEY = "test-key-xyz";

const KEY = "test-key-xyz";

// The import under test.
const worker = (await import("./index.ts")).default as {
  fetch: (req: Request) => Response | Promise<Response>;
  port?: number;
};

const server = Bun.serve({ port: 0, fetch: worker.fetch });
const PORT = server.port ?? 0;
const BASE = `http://localhost:${PORT}`;

/** Every response the server sends, success or refusal, carries the permissive CORS header. */
const corsOk = (r: Response) => r.headers.get("access-control-allow-origin") === "*";

/** StreamableHTTPTransport answers with raw JSON or an SSE frame. */
async function mcpBody(r: Response): Promise<Record<string, unknown> | null> {
  const text = await r.text();
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : null;
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "portable-test", version: "0.0.1" },
  },
});

const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const AUTH = { ...H, "x-brain-key": KEY };

// ── Tests ────────────────────────────────────────────────────────────────────

console.log("[1] The module is importable at all");
{
  assert(typeof worker.fetch === "function", "default export exposes fetch (Workers + Bun shape)");
  assert(PORT > 0, `serves on an ephemeral port (:${PORT})`);
}

console.log("\n[2] Runtime neutrality");
{
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  assert(!/\bDeno\./.test(src), "no Deno.* references");
  assert(!/\bBun\./.test(src), "no Bun.* references");
  assert(!/jsr:/.test(src), "no jsr: imports");
  assert(/initEnv\(c\.env/.test(src), "seeds env from the request context (Workers path)");
}

console.log("\n[3] CORS preflight");
{
  const r = await fetch(BASE, { method: "OPTIONS" });
  assert(r.status === 200, "OPTIONS → 200");
  assert(corsOk(r), "allow-origin *");
  assert(r.headers.has("access-control-allow-methods"), "allow-methods present");
}

console.log("\n[4] Auth failure — the real unauthorizedResponse(), not a copy of it");
{
  const r = await fetch(BASE, { method: "POST", headers: { ...H, "x-brain-key": "wrong" }, body: INIT });
  // Deliberately 200: a bare 4xx makes strict MCP hosts treat auth failure as a
  // transport fault and drop the connection instead of surfacing it.
  assert(r.status === 200, "wrong key → HTTP 200, not 401");
  assert(corsOk(r), "CORS present on auth failure");
  const b = await r.json();
  assert(b?.jsonrpc === "2.0", "JSON-RPC 2.0 envelope");
  assert(b?.error?.code === -32001, "error.code === -32001");
  assert(typeof b?.error?.message === "string" && b.error.message.length > 0, "carries a message");
  assert(b?.id === 1, "echoes the inbound id");
  assert(b?.result === undefined, "no result alongside error");
}

console.log("\n[5] Auth failure — missing key, and an unparseable body");
{
  const r1 = await fetch(BASE, { method: "POST", headers: H, body: INIT });
  assert((await r1.json())?.error?.code === -32001, "missing key rejected");

  const r2 = await fetch(BASE, { method: "POST", headers: H, body: "not json" });
  assert((await r2.json())?.id === null, "unparseable body → id: null");
}

console.log("\n[6] Auth via ?key= — the documented connector path");
{
  const ok = await fetch(`${BASE}/?key=${KEY}`, { method: "POST", headers: H, body: INIT });
  assert((await mcpBody(ok))?.result != null, "correct ?key= reaches the MCP handler");

  const bad = await fetch(`${BASE}/?key=nope`, { method: "POST", headers: H, body: INIT });
  assert((await bad.json())?.error?.code === -32001, "wrong ?key= rejected");
}

console.log("\n[7] initialize");
{
  const r = await fetch(BASE, { method: "POST", headers: AUTH, body: INIT });
  assert(r.status === 200, "initialize → 200");
  assert(!r.headers.has("mcp-session-id"), "no mcp-session-id (stateless)");
  const b = await mcpBody(r);
  const result = b?.result as Record<string, unknown> | undefined;
  assert(result?.protocolVersion != null, "protocolVersion returned");
  assert(result?.capabilities != null, "capabilities returned");
}

console.log("\n[8] Per-request isolation — a fresh McpServer each time");
{
  for (const n of [1, 2]) {
    const r = await fetch(BASE, { method: "POST", headers: AUTH, body: INIT });
    const b = await mcpBody(r);
    assert((b?.result as Record<string, unknown>)?.protocolVersion != null, `request ${n} initializes cleanly`);
    assert(!r.headers.has("mcp-session-id"), `request ${n} leaks no session id`);
  }
}

console.log("\n[9] tools/list exposes exactly the documented surface");
{
  const r = await fetch(BASE, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const b = await mcpBody(r);
  const tools = ((b?.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "capture_thought",
    "delete_thought",
    "fetch",
    "list_supersession_proposals",
    "list_thoughts",
    "search",
    "search_thoughts",
    "search_thoughts_keyword",
    "thought_stats",
    "update_thought",
  ];
  assert(tools.length === expected.length, `${expected.length} tools registered (got ${tools.length})`);
  for (const t of expected) assert(tools.includes(t), `exposes "${t}"`);
}

console.log("\n[10] Read tools are annotated read-only, capture is not");
{
  const r = await fetch(BASE, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
  });
  const b = await mcpBody(r);
  const tools = (b?.result as { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[] })?.tools ?? [];
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const t of ["search", "fetch", "search_thoughts", "list_thoughts", "list_supersession_proposals", "thought_stats"]) {
    assert(byName[t]?.annotations?.readOnlyHint === true, `"${t}" is readOnlyHint: true`);
  }
  assert(byName["capture_thought"]?.annotations?.readOnlyHint === false, `"capture_thought" is readOnlyHint: false`);
}

console.log("\n[11] OAuth discovery is a 404, not an auth challenge (upstream #340)");
{
  // claude.ai fetches this document at the origin root, path as suffix, no key,
  // and proceeds on the key only on a 404. FORK.md change 42 has the rest.
  const discovery = "/.well-known/oauth-protected-resource";

  // A probe that cannot hang or crash the suite: one 2 s abort that covers the
  // body read too (a regressed route hands an authenticated GET to a stream that
  // never closes — SMD-1259), a transport error reported by its own name, and
  // the body parsed by the same mcpBody() as [4]–[10] then tested for the
  // jsonrpc marker — a JSON body that is not an envelope must not count. Three
  // asserts per row, always executed, so the count is stable green or red.
  const probe = async (path: string, init: RequestInit = {}) => {
    try {
      const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(2000) });
      return { status: r.status as number | string, cors: corsOk(r), envelope: (await mcpBody(r))?.jsonrpc === "2.0" };
    } catch (e) {
      return { status: e instanceof Error ? e.name : String(e), cors: false, envelope: false };
    }
  };

  const rows: [string, string, RequestInit, number][] = [
    ["bare document, no key", discovery, {}, 404],
    ["path-suffixed form (the URL Supabase answered 401)", `${discovery}/functions/v1/open-brain-mcp`, {}, 404],
    ["oauth-authorization-server", "/.well-known/oauth-authorization-server", {}, 404],
    ["openid-configuration", "/.well-known/openid-configuration", {}, 404],
    // The route runs before authenticate(): every caller shape gets the same
    // answer, and a revoked key never reaches the agent registry. The ?key= row
    // is the URL-only connector's shape; before this route it authenticated and
    // was handed to the transport.
    ["wrong key", discovery, { headers: { "x-brain-key": "wrong" } }, 404],
    ["right key in header", discovery, { headers: { "x-brain-key": KEY } }, 404],
    ["right key in ?key=", `${discovery}?key=${KEY}`, {}, 404],
    // Not an MCP endpoint under any verb; the preflight a browser-hosted client
    // sends first is still answered.
    ["POST", discovery, { method: "POST", headers: AUTH, body: INIT }, 404],
    ["OPTIONS preflight", discovery, { method: "OPTIONS" }, 200],
  ];
  for (const [label, path, init, expect] of rows) {
    const p = await probe(path, init);
    assert(p.status === expect, `${label} → ${expect} (${p.status})`);
    assert(p.cors, `${label}: CORS present`);
    assert(!p.envelope, `${label}: body is not a JSON-RPC envelope`);
  }
  // The MCP endpoint at / is untouched — [4] through [10] above.
}

console.log("\n[12] Query log flag — off by default, so the guard writes nothing (SMD-1295)");
{
  // The whole OFF guarantee rests on this predicate: the handlers' only log call
  // sites are behind `if (!queryLogEnabled(env())) return;`, so anything that is
  // not "on" means no store method is ever reached — no table write, no read.
  // Only the exact "on" idiom (case-insensitive, trimmed) turns it on.
  assert(queryLogEnabled({}) === false, "unset → off (the default)");
  assert(queryLogEnabled({ OB1_QUERY_LOG: "" }) === false, "empty → off");
  assert(queryLogEnabled({ OB1_QUERY_LOG: "off" }) === false, "\"off\" → off");
  assert(queryLogEnabled({ OB1_QUERY_LOG: "1" }) === false, "\"1\" → off (only \"on\" enables it)");
  assert(queryLogEnabled({ OB1_QUERY_LOG: "true" }) === false, "\"true\" → off");
  assert(queryLogEnabled({ OB1_QUERY_LOG: "on" }) === true, "\"on\" → on");
  assert(queryLogEnabled({ OB1_QUERY_LOG: "  ON  " }) === true, "\"  ON  \" → on (trimmed, case-insensitive)");
  assert(queryLogEnabled(undefined) === false && queryLogEnabled(null) === false, "undefined/null env → off");

  // The retention window prune_query_log uses, from the env or the default.
  assert(queryLogRetentionDays({}) === QUERY_LOG.retentionDaysDefault, `unset → the default ${QUERY_LOG.retentionDaysDefault} days`);
  assert(queryLogRetentionDays({ OB1_QUERY_LOG_RETENTION_DAYS: "7" }) === 7, "a valid number is honoured");
  assert(queryLogRetentionDays({ OB1_QUERY_LOG_RETENTION_DAYS: "0" }) === 0, "0 is honoured (prune everything older than now)");
  assert(queryLogRetentionDays({ OB1_QUERY_LOG_RETENTION_DAYS: "-3" }) === QUERY_LOG.retentionDaysDefault, "a negative falls back to the default");
  assert(queryLogRetentionDays({ OB1_QUERY_LOG_RETENTION_DAYS: "abc" }) === QUERY_LOG.retentionDaysDefault, "a non-number falls back to the default");
}

server.stop();

report();
