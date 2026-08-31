/**
 * test-stateless.mjs
 *
 * Validates the per-request McpServer pattern without any infra (no Supabase, no DB).
 * MCP initialize is a pure protocol handshake — no tools are called, no database touched.
 *
 * Setup (from server/ directory):
 *   npm install
 *   node test-stateless.mjs   # or: npm test
 *
 * ── Why this file mirrors index.ts instead of importing it ────────────────────
 * index.ts is deployed as a SINGLE file (the setup guide curls exactly one file
 * into supabase/functions/open-brain-mcp/index.ts). Splitting the auth helpers
 * into an importable module would break that install path. It also imports
 * `jsr:@supabase/functions-js/edge-runtime.d.ts` and reads Deno.env at module
 * scope, so it cannot be imported under Node at all.
 *
 * The mirror is therefore deliberate — but a silent mirror is how this file
 * drifted before. Section [0] below reads index.ts as text and fails if the
 * auth contract encoded here no longer matches the real one. Any future change
 * to the auth response shape breaks the test loudly instead of quietly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

// ── [0] Drift guard — the mirror below must match the real index.ts ───────────
//
// Read the deployed server as text and pull out the auth contract it actually
// implements. Every constant this test asserts against is sourced from here, so
// the mirror cannot silently diverge from production the way it did between
// 2026-03 (this file was written) and 2026-05 (PR #243 changed 401 → 200).

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = readFileSync(join(HERE, "index.ts"), "utf8");

console.log("[0] Drift guard — auth contract matches server/index.ts");

function extract(pattern, label) {
  const m = INDEX_TS.match(pattern);
  assert(m !== null, `index.ts still defines ${label}`);
  return m?.[1];
}

const REAL_UNAUTHORIZED_CODE = Number(
  extract(/const JSON_RPC_UNAUTHORIZED_CODE = (-?\d+);/, "JSON_RPC_UNAUTHORIZED_CODE")
);
const REAL_UNAUTHORIZED_MESSAGE = extract(
  /const UNAUTHORIZED_MESSAGE = "([^"]+)";/,
  "UNAUTHORIZED_MESSAGE"
);

// unauthorizedResponse() must still answer HTTP 200 with a JSON-RPC envelope.
// A bare 4xx makes strict MCP hosts (Codex CLI, Claude Code) treat the auth
// failure as a transport fault and tear the connection down.
const unauthorizedFn = INDEX_TS.match(
  /function unauthorizedResponse\([\s\S]*?\n}/
)?.[0];
assert(unauthorizedFn != null, "index.ts still defines unauthorizedResponse()");
assert(
  /status:\s*200/.test(unauthorizedFn ?? ""),
  "unauthorizedResponse() returns HTTP 200 (not a bare 401)"
);
assert(
  /jsonrpc:\s*"2\.0"/.test(unauthorizedFn ?? ""),
  "unauthorizedResponse() returns a JSON-RPC 2.0 envelope"
);

// Auth must accept the key from either the header or the ?key= query param.
assert(
  /c\.req\.header\("x-brain-key"\)\s*\|\|\s*new URL\(c\.req\.url\)\.searchParams\.get\("key"\)/.test(
    INDEX_TS
  ),
  "auth reads x-brain-key header OR ?key= query param"
);

assert(
  Number.isInteger(REAL_UNAUTHORIZED_CODE) && REAL_UNAUTHORIZED_CODE === -32001,
  `unauthorized code is -32001 (found ${REAL_UNAUTHORIZED_CODE})`
);

// ── Minimal server mirroring the real pattern ─────────────────────────────────

const MCP_ACCESS_KEY = "test-key-xyz";

function buildServer() {
  const server = new McpServer({ name: "ob1-test", version: "1.0.0" });
  server.registerTool(
    "ping",
    { title: "Ping", description: "No-op for testing", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] })
  );
  return server;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// Mirrors index.ts — see the drift guard above.
async function readBodyText(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return null;
  try {
    return await req.text();
  } catch {
    return null;
  }
}

function extractJsonRpcId(bodyText) {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = parsed.id;
      if (typeof id === "string" || typeof id === "number" || id === null) return id;
    }
  } catch {
    // fall through — malformed body
  }
  return null;
}

function unauthorizedResponse(id) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: REAL_UNAUTHORIZED_CODE, message: REAL_UNAUTHORIZED_MESSAGE },
      id,
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
  );
}

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  const provided =
    c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    const bodyText = await readBodyText(c.req.raw);
    return unauthorizedResponse(extractJsonRpcId(bodyText));
  }

  const server = buildServer(); // per-request: fresh instance every time
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id"); // stateless: strip any session hint
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

// ── Start server on a random port ─────────────────────────────────────────────

const httpServer = serve({ fetch: app.fetch, port: 0 });
await new Promise((r) => httpServer.on("listening", r));
const { port } = httpServer.address();
const BASE = `http://localhost:${port}`;

// StreamableHTTPTransport may return raw JSON or SSE ("event: message\ndata: {...}").
async function readMcpBody(r) {
  const text = await r.text();
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) return JSON.parse(dataLine.slice(6));
  return null;
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  },
});

const authHeaders = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
  "x-brain-key": MCP_ACCESS_KEY,
};

const noKeyHeaders = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n[1] CORS preflight");
{
  const r = await fetch(BASE, { method: "OPTIONS" });
  assert(r.status === 200, "OPTIONS → 200");
  assert(r.headers.get("access-control-allow-origin") === "*", "CORS origin *");
  assert(r.headers.has("access-control-allow-methods"), "CORS methods present");
}

console.log("\n[2] Auth rejection — wrong key");
{
  const r = await fetch(BASE, {
    method: "POST",
    headers: { ...noKeyHeaders, "x-brain-key": "wrong-key" },
    body: INIT,
  });
  // Deliberately HTTP 200: strict MCP hosts treat a bare 4xx as a transport
  // fault and drop the connection instead of surfacing the error.
  assert(r.status === 200, "wrong key → 200 (JSON-RPC envelope, not transport error)");
  assert(r.headers.get("access-control-allow-origin") === "*", "CORS on auth failure");
  const body = await r.json();
  assert(body?.jsonrpc === "2.0", "JSON-RPC 2.0 envelope");
  assert(body?.error?.code === REAL_UNAUTHORIZED_CODE, `error.code === ${REAL_UNAUTHORIZED_CODE}`);
  assert(body?.error?.message === REAL_UNAUTHORIZED_MESSAGE, "error.message matches index.ts");
  assert(body?.id === 1, "echoes the inbound JSON-RPC id");
  assert(body?.result === undefined, "no result alongside error");
}

console.log("\n[3] Auth rejection — no key");
{
  const r = await fetch(BASE, { method: "POST", headers: noKeyHeaders, body: INIT });
  assert(r.status === 200, "missing key → 200 (JSON-RPC envelope)");
  const body = await r.json();
  assert(body?.error?.code === REAL_UNAUTHORIZED_CODE, "unauthorized error code");
  assert(body?.id === 1, "echoes the inbound JSON-RPC id");
}

console.log("\n[4] Auth rejection — malformed body falls back to id: null");
{
  const r = await fetch(BASE, {
    method: "POST",
    headers: noKeyHeaders,
    body: "not json at all",
  });
  assert(r.status === 200, "malformed body → 200");
  const body = await r.json();
  assert(body?.error?.code === REAL_UNAUTHORIZED_CODE, "unauthorized error code");
  assert(body?.id === null, "id falls back to null on unparseable body");
}

console.log("\n[5] Auth via ?key= query param — the documented connector path");
{
  // Claude Desktop custom connectors and the ChatGPT connector are URL-only,
  // so this path is what most users actually run on. It was previously untested.
  const r = await fetch(`${BASE}/?key=${MCP_ACCESS_KEY}`, {
    method: "POST",
    headers: noKeyHeaders,
    body: INIT,
  });
  assert(r.status === 200, "?key= with correct key → 200");
  const body = await readMcpBody(r);
  assert(body?.result?.protocolVersion != null, "?key= auth reaches the MCP handler");
}

console.log("\n[6] Auth via ?key= — wrong key still rejected");
{
  const r = await fetch(`${BASE}/?key=nope`, {
    method: "POST",
    headers: noKeyHeaders,
    body: INIT,
  });
  const body = await r.json();
  assert(r.status === 200, "wrong ?key= → 200 envelope");
  assert(body?.error?.code === REAL_UNAUTHORIZED_CODE, "wrong ?key= rejected");
}

console.log("\n[7] MCP initialize — response shape + no mcp-session-id");
{
  const r = await fetch(BASE, { method: "POST", headers: authHeaders, body: INIT });
  assert(r.status === 200, "initialize → 200");
  assert(!r.headers.has("mcp-session-id"), "mcp-session-id absent (stateless)");
  assert(r.headers.get("access-control-allow-origin") === "*", "CORS on success");
  const body = await readMcpBody(r);
  assert(body?.result?.protocolVersion != null, "protocolVersion in response");
  assert(body?.result?.capabilities != null, "capabilities in response");
}

console.log("\n[8] Per-request isolation — two sequential initializes");
{
  const r1 = await fetch(BASE, { method: "POST", headers: authHeaders, body: INIT });
  assert(r1.status === 200, "r1 → 200");
  assert(!r1.headers.has("mcp-session-id"), "r1 no mcp-session-id");
  const b1 = await readMcpBody(r1);
  assert(b1?.result?.protocolVersion != null, "r1 valid initialize response");

  const r2 = await fetch(BASE, { method: "POST", headers: authHeaders, body: INIT });
  assert(r2.status === 200, "r2 → 200");
  assert(!r2.headers.has("mcp-session-id"), "r2 no mcp-session-id");
  const b2 = await readMcpBody(r2);
  assert(b2?.result?.protocolVersion != null, "r2 valid initialize response (no singleton corruption)");
}

console.log("\n[9] tools/list — verifies buildServer() registers tools each time");
{
  const r = await fetch(BASE, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert(r.status === 200, "tools/list → 200");
  assert(!r.headers.has("mcp-session-id"), "no mcp-session-id on tools/list");
  const body = await readMcpBody(r);
  assert(body !== null, "got a parseable response");
}

console.log("\n[10] Real server registers the documented tool surface");
{
  // Guards against a tool being dropped from index.ts without anyone noticing.
  for (const tool of [
    "search",
    "fetch",
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "capture_thought",
  ]) {
    assert(
      INDEX_TS.includes(`registerTool(\n    "${tool}"`),
      `index.ts registers "${tool}"`
    );
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);

httpServer.close();

if (failed > 0) {
  console.error("FAIL\n");
  process.exit(1);
} else {
  console.log("PASS\n");
}
