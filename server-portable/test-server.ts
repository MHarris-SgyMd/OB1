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

/**
 * A probe for the routing blocks ([3], [11], [13]) that cannot hang or crash the
 * suite: one 2 s abort that covers the body read too, a transport error reported
 * by its own name, and the body parsed by the same mcpBody() as [4]–[10] then
 * tested for the jsonrpc marker — a JSON body that is not an envelope must not
 * count. The abort is what turns the failure mode both blocks guard against — a
 * request handed to a stream the per-request transport never closes (SMD-1259)
 * — into a red assertion named `TimeoutError` instead of a stuck CI job.
 */
const PROBE_TIMEOUT_MS = 2000;
type Probe = { status: number | string; cors: boolean; allow: string | null; methods: string | null; envelope: boolean };
const probe = async (path: string, init: RequestInit = {}): Promise<Probe> => {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e) {
    return { status: e instanceof Error ? e.name : String(e), cors: false, allow: null, methods: null, envelope: false };
  }
  // The body parse is outside the transport try: a body that starts with `{`
  // and is not JSON is "not an envelope", not a transport failure that should
  // hide the status and Allow the server did send.
  let envelope = false;
  try {
    envelope = (await mcpBody(r))?.jsonrpc === "2.0";
  } catch {
    /* not JSON → not an envelope */
  }
  return { status: r.status, cors: corsOk(r), allow: r.headers.get("allow"), methods: r.headers.get("access-control-allow-methods"), envelope };
};

/** The per-row refusal triple [11] and [13] share: status, CORS, not an envelope — plus Allow where a 405 must name it. */
const expectRefusal = (label: string, p: Probe, status: number, allow?: string) => {
  assert(p.status === status, `${label} → ${status} (${p.status})`);
  if (allow !== undefined) assert(p.allow === allow, `${label}: Allow names what the endpoint serves (${p.allow})`);
  assert(p.cors, `${label}: CORS present`);
  assert(!p.envelope, `${label}: body is not a JSON-RPC envelope`);
};

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
  const p = await probe("", { method: "OPTIONS" });
  assert(p.status === 200, `OPTIONS → 200 (${p.status})`);
  assert(p.cors, "allow-origin *");
  // The exact list, because it is NOT the served list: the endpoint serves POST
  // only ([13]), but this header says what a browser may send so it can hear
  // our answer, and a browser-hosted SDK client holding a session id sends
  // DELETE and accepts the 405. Hiding GET or DELETE here would turn that 405
  // into a network error. FORK.md change 75.
  assert(p.methods === "GET, POST, OPTIONS, DELETE", `allow-methods advertises GET and DELETE, so a browser hears the 405 (${p.methods})`);
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

  // @hono/mcp 0.1.x wanted both Accept tokens on a POST and the server carried
  // a patch that supplied whichever was missing (change 75 made it test both).
  // 0.3.x takes either token, or none, as enough and the patch is gone (change
  // 81): a Claude Desktop connector's `Accept: application/json`, an SSE-only
  // Accept (the SDK client's GET form; its POSTs name both tokens) and no
  // Accept at all reach the transport as sent.
  for (const [label, headers] of [["text/event-stream alone", { Accept: "text/event-stream" }], ["application/json alone", { Accept: "application/json" }], ["no Accept header", {}]] as [string, Record<string, string>][]) {
    const r = await fetch(BASE, { method: "POST", headers: { ...AUTH, ...headers }, body: INIT });
    assert(r.status === 200 && (await mcpBody(r))?.result != null, `Accept: ${label} reaches the transport unpatched → 200 (${r.status})`);
  }
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

  // Three asserts per row through the shared probe(), always executed, so the
  // count is stable green or red. A deleted route now lands these GETs on
  // notFound's 405 ([13]), not a hang — the status assertion still catches it.
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
  for (const [label, path, init, expect] of rows) expectRefusal(label, await probe(path, init), expect);
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

console.log("\n[13] The MCP endpoint answers GET with 405, not an SSE stream nothing closes (SMD-1259, upstream #424)");
{
  // The MCP handler is registered for POST only and app.notFound answers
  // everything else with 405 before authenticate(); FORK.md change 75 has the
  // mechanism this closes (an authenticated GET opened an SSE stream the
  // per-request transport never closed). Drilled by registering the handler
  // with app.all and removing app.notFound — the pre-change shape: every
  // GET row holding a valid key fails as `TimeoutError`; the raw-socket row
  // below sees a `200 OK` status line and no end; HEAD, PUT and PATCH get the
  // transport's own 405, after auth, with an `Allow` that names GET; the keyed
  // DELETE gets the transport's 200; /health keeps passing (it is its own route).
  const ALLOW = "POST, OPTIONS";
  const rows: [string, string, RequestInit][] = [
    // Every key shape, because the answer is about the method, not the caller:
    // no key never reaches authenticate(), and a right key never reaches the
    // agent registry or the transport.
    ["GET, no key", "/", {}],
    ["GET, wrong key", "/", { headers: { "x-brain-key": "wrong" } }],
    ["GET, right key in header", "/", { headers: { "x-brain-key": KEY } }],
    ["GET, right key in ?key= (the connector URL opened in a browser)", `/?key=${KEY}`, {}],
    ["GET, the SDK client's own headers", "/", { headers: { "x-brain-key": KEY, Accept: "text/event-stream" } }],
    ["HEAD, right key", `/?key=${KEY}`, { method: "HEAD" }],
    ["PUT, right key", "/", { method: "PUT", headers: AUTH, body: INIT }],
    ["PATCH, right key", "/", { method: "PATCH", headers: AUTH, body: INIT }],
    // DELETE too: there is no session here for it to end, and the SDK client
    // accepts 405 from terminateSession() by spec (change 75 has the rest).
    ["DELETE, right key", "/", { method: "DELETE", headers: AUTH }],
    ["DELETE, no key", "/", { method: "DELETE", headers: H }],
    // One of the two shapes SMD-1246's review found falling past the
    // /.well-known/ route to the catch-all: Hono matches paths case-sensitively.
    // It used to hang; it is a GET. The other shape is the raw-socket row below.
    ["GET, differently-cased discovery path with the key", `/.Well-Known/oauth-protected-resource?key=${KEY}`, {}],
  ];
  for (const [label, path, init] of rows) expectRefusal(label, await probe(path, init), 405, ALLOW);

  // The other shape: a base URL with a trailing slash doubles the slash, and
  // `//.well-known/…` is not `/.well-known/*` to Hono, so it fell to the
  // catch-all and hung. Bun's fetch() collapses `//` to `/` on the wire — a
  // fetch row would probe the 404 route — but a Request object keeps it and
  // worker.fetch hands it to the router as is, which is the routing question
  // this row asks. The status is read before any body, so under the pre-change
  // shape this reports the 200 the stream flushes at once, not a hang.
  const doubled = await worker.fetch(new Request(`${BASE}//.well-known/oauth-protected-resource?key=${KEY}`));
  assert(doubled.status === 405 && corsOk(doubled), `GET, doubled-slash discovery path with the key → 405 (${doubled.status})`);

  // The CORS preflight still advertises GET and DELETE — asserted in [3], where
  // the preflight is probed. POST reaching the transport is [7].

  // /health is the probe target for platforms that can only GET and want 2xx:
  // before authenticate(), so it needs no key and a key changes nothing. The
  // match rule is the HEALTH_PATH comment in index.ts; these rows pin it.
  for (const [label, path, init] of [
    ["GET /health", "/health", {}],
    ["GET /health with a key in the URL", `/health?key=${KEY}`, {}],
    ["HEAD /health", "/health", { method: "HEAD" }],
    ["GET /health/ (trailing slash)", "/health/", {}],
    ["GET /mcp/health (one-segment proxy prefix)", "/mcp/health", {}],
    ["GET /functions/v1/open-brain-mcp/health (the Supabase-shaped prefix)", "/functions/v1/open-brain-mcp/health", {}],
  ] as [string, string, RequestInit][]) {
    const p = await probe(path, init);
    assert(p.status === 200, `${label} → 200 (${p.status})`);
    assert(p.cors && !p.envelope, `${label}: CORS present, body is not a JSON-RPC envelope`);
  }
  // Route exactness, not a status contract: what a stray GET gets is the
  // path-axis decision FORK.md change 42 defers (405 today, 404 under a mount).
  // Either refusal, and nothing else — `!== 200` alone would pass the abort
  // marker, i.e. a hang, which is the one outcome this whole block exists to
  // refuse.
  for (const near of ["/healthz", "/Health", "/health/x", "/a/healthz"]) {
    const p = await probe(near, {});
    assert(p.status === 405 || p.status === 404, `GET ${near} is not /health, and does not hang (${p.status})`);
  }
  // Under /.well-known/ the discovery route owns the prefix and answers first.
  assert((await probe("/.well-known/health", {})).status === 404, "GET /.well-known/health → 404 (the discovery route owns that prefix)");
  // At a health path the refusal's Allow names the health resource's methods:
  // GET and HEAD from the health route, POST because the MCP handler serves
  // every path — `POST /health` IS the endpoint.
  const putHealth = await probe("/health", { method: "PUT" });
  assert(putHealth.status === 405 && putHealth.allow === "GET, HEAD, POST, OPTIONS", `PUT /health → 405 with Allow: GET, HEAD, POST, OPTIONS (${putHealth.status}, ${putHealth.allow})`);
  // With the key, so the 200 is the transport's initialize result and not the
  // JSON-RPC refusal a keyless POST gets anywhere.
  const postHealth = await fetch(`${BASE}/health`, { method: "POST", headers: AUTH, body: INIT, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  assert(postHealth.status === 200 && (await mcpBody(postHealth))?.result != null, `POST /health with the key is the MCP endpoint (${postHealth.status})`);
}

server.stop();

report();
