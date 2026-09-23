import { createAssert } from "../db/test-support.ts";
import { DEFAULT_EMBEDDING_DIM, queryLogEnabled, queryLogRetentionDays, QUERY_LOG, trimmedEnv } from "../db/config.mjs";
import { visibleToolNames, READ_TOOL_NAMES } from "./tools.ts";
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
// No store configuration, on purpose (change 97, SMD-1797): nothing below calls
// a tool, so the server never builds a store — [14] exercises the factory
// directly — and a section that did reach one would surface the SQL store's
// own "DATABASE_URL is not set" refusal inside a tool error, not a request to
// a stub PostgREST that no SETUP.md deployment runs.
delete process.env.OB1_STORE;
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.OPENROUTER_API_KEY = "stub-openrouter";
process.env.MCP_ACCESS_KEY = "test-key-xyz";

const KEY = "test-key-xyz";

// The one provider call this suite makes is [17]'s, against a stub that can be
// told to answer an embedding slowly — the server's env is read once, at the
// first request, so the stub's address is set before it. Declared local to the
// egress gate (SMD-1903), as every suite that boots the server against a stub
// does. One-hot, like test-local-provider's, at the width the server expects.
let embedDelayMs = 0;
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as { input?: string };
    if (embedDelayMs > 0) await Bun.sleep(embedDelayMs);
    if (url.pathname.endsWith("/embeddings")) {
      const v = new Array(DEFAULT_EMBEDDING_DIM).fill(0);
      v[String(body.input ?? "").length % DEFAULT_EMBEDDING_DIM] = 1;
      return Response.json({ data: [{ embedding: v }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ topics: [], type: "idea", people: [] }) } }] });
  },
});
process.env.OB1_LLM_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
process.env.OB1_LLM_LOCAL = "1";

// The import under test.
const worker = (await import("./index.ts")).default as {
  fetch: (req: Request) => Response | Promise<Response>;
  port?: number;
};

// Served with every field the export declares, so what the export says about
// the runtime — and what it leaves at the default — is what [17] measures.
const server = Bun.serve({ ...worker, port: 0 });
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

  // @hono/mcp 0.1.x wanted both Accept tokens on a POST and the server patched
  // whichever was missing; 0.3.x takes either, or none, and the patch is gone
  // (change 84) — a connector's `application/json`, an SSE-only Accept (the SDK
  // client's GET form) and no Accept at all reach the transport as sent.
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
  // The live drift guard (SMD-1805): the surface a write key must see is
  // derived from the typed manifest (tools.ts) for this scope — AUTH is a write
  // key — so a tool added to or removed from index.ts without a matching
  // manifest entry shows up here as a mismatch, and a gated tool later just
  // changes what visibleToolNames() returns.
  const expected = visibleToolNames({ scope: "write" });
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
  // Every read-scoped tool from the manifest (SMD-1805), so a read tool added
  // without the read-only annotation fails here.
  for (const t of READ_TOOL_NAMES) {
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
  // deploy/compose.yaml forwards both knobs as `${VAR:-}` since SMD-1843, so a
  // composed server sees "" wherever deploy/.env set nothing.
  assert(queryLogRetentionDays({ OB1_QUERY_LOG_RETENTION_DAYS: "" }) === QUERY_LOG.retentionDaysDefault,
         "OB1_QUERY_LOG_RETENTION_DAYS='' — what compose forwards for an unset variable — is the default window, not 0 days");
  // The boundary rule index.ts's initEnv and preflight apply to the whole environment (SMD-1843).
  const trimmed = trimmedEnv({ OB1_LLM_API_KEY: " sk-abc ", OB1_EMBEDDING_DIM: " ", MCP_ACCESS_KEYS: "a:write:h1\nb:read:h2\n", PORT: "8000", n: 3, u: undefined });
  assert(trimmed.OB1_LLM_API_KEY === "sk-abc" && trimmed.OB1_EMBEDDING_DIM === "" && trimmed.MCP_ACCESS_KEYS === "a:write:h1\nb:read:h2" && trimmed.PORT === "8000" && trimmed.n === 3 && trimmed.u === undefined,
         "trimmedEnv trims every string value (a quoted key's trailing space, a dimension of spaces to ''), keeps inner newlines, and passes non-strings through");

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

console.log("\n[14] OB1_STORE unset selects the SQL store; PostgREST stays selectable and is said to be retired here (SMD-1797)");
{
  const { createStore, databaseUrl, DEFAULT_STORE, isPostgresUrl, maskUrl, missingDatabaseUrl, postgrestOnBunNotice, postgrestOverPostgresUrl, storeKind } = await import("./store.ts");
  assert(DEFAULT_STORE === "sql" && storeKind({}) === "sql", "an empty env selects sql");
  assert(storeKind({ OB1_STORE: "PostgREST" }) === "postgrest", "the name is read case-insensitively");

  // No connection string at all: refused as the SQL store, naming DATABASE_URL —
  // not as the PostgREST store asking for SUPABASE_URL, which the old default did.
  /** The factory's refusal for an env, or "" when it builds — every case below is a refusal. */
  const refusal = async (env: Parameters<typeof createStore>[0]) => { try { await createStore(env); return ""; } catch (e) { return (e as Error).message; } };
  let msg = await refusal({});
  assert(/OB1_STORE is unset, which selects the SQL store, and DATABASE_URL is not set/.test(msg) && /Set DATABASE_URL to the brain's postgres:\/\/ connection string/.test(msg),
         `…and without DATABASE_URL is refused as the SQL store, with the fix (${msg.slice(0, 48)}…)`);
  assert(!/requires SUPABASE_URL/.test(msg), "…not as the PostgREST store");

  // The deployment the old default served — an https:// SUPABASE_URL and no
  // OB1_STORE — is told both ways out: a connection string, or the explicit selection.
  msg = await refusal({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(/SUPABASE_URL holds a non-postgres:\/\/ URL, the PostgREST store's base URL/.test(msg) && /set OB1_STORE=postgrest/.test(msg),
         "an https:// SUPABASE_URL under the default names OB1_STORE=postgrest as the way to keep it");
  msg = await refusal({ SUPABASE_URL: "http://localhost:3000", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(/non-postgres:\/\/ URL/.test(msg) && !/https:\/\/ URL/.test(msg), "…and a self-hosted http:// one is not called https");

  // The mirror slip: the PostgREST store selected while SUPABASE_URL holds a
  // connection string. Refused by name before supabase-js sees the string.
  msg = await refusal({ OB1_STORE: "postgrest", SUPABASE_URL: "postgres://u:p@127.0.0.1:1/x", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(/SUPABASE_URL holds a postgres:\/\/ connection string, which PostgREST cannot dial/.test(msg) && /Unset OB1_STORE/.test(msg),
         "OB1_STORE=postgrest with a postgres:// SUPABASE_URL is refused naming the SQL store as the reader of that URL");
  assert(postgrestOverPostgresUrl({ OB1_STORE: "postgrest", SUPABASE_URL: "https://x.supabase.co" }) === null && postgrestOverPostgresUrl({ SUPABASE_URL: "postgres://u:p@h/x" }) === null,
         "…and neither a PostgREST base URL under postgrest nor a postgres:// URL under the default is a mismatch");
  assert(maskUrl("postgres://u:hunter2@h:5432/x") === "postgres://***@h:5432/x" && maskUrl("https://x.supabase.co") === "https://x.supabase.co", "maskUrl blanks the credentials of a URL that has them and leaves one without alone");
  assert(maskUrl("postgres://u:p@ss@h/x") === "postgres://***@h/x" && maskUrl("postgres://u:p@[::1]:5432/x") === "postgres://***@[::1]:5432/x" && maskUrl("postgres://u:p@h") === "postgres://***@h",
         "…a raw @ inside the password goes with it, an IPv6 host and a path-less URL are kept");
  assert(maskUrl("postgres://h/db?application_name=a@b") === "postgres://h/db?application_name=a@b" && maskUrl("postgres://u:p%40w@h/db?x=a@b") === "postgres://***@h/db?x=a@b",
         "…and an @ past the first slash is not taken for credentials, while real credentials before it still are");

  // SUPABASE_URL holding a postgres:// URL IS the connection string — the SQL
  // shim's spelling — read after DATABASE_URL.
  assert(isPostgresUrl("postgres://u:p@h/db") && isPostgresUrl(" postgresql://h/db") && !isPostgresUrl("https://x.supabase.co") && !isPostgresUrl(undefined),
         "isPostgresUrl: both schemes, trimmed; neither https nor unset");
  assert(databaseUrl({ SUPABASE_URL: "postgres://u:p@127.0.0.1:1/x" })?.from === "SUPABASE_URL", "a postgres:// SUPABASE_URL is read as the connection string…");
  assert(databaseUrl({ DATABASE_URL: "postgres://a/1", SUPABASE_URL: "postgres://b/2" })?.url === "postgres://a/1", "…after DATABASE_URL");
  assert(databaseUrl({ SUPABASE_URL: "https://x.supabase.co" }) === null, "…and an https:// one is not a connection string");
  const viaAlias = await createStore({ SUPABASE_URL: "postgres://u:p@127.0.0.1:1/x" });
  assert(viaAlias.kind === "sql", "createStore builds the SQL store from it (Bun's client connects on first use; nothing is dialled here)");
  await viaAlias.close();

  // PostgREST is still selectable, explicitly — the Workers path.
  const pg = await createStore({ OB1_STORE: "postgrest", SUPABASE_URL: "https://stub.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(pg.kind === "postgrest", "OB1_STORE=postgrest still builds the PostgREST store");
  await pg.close();

  // The retired notice: for postgrest, on a runtime that has Bun, and nowhere else.
  const notice = postgrestOnBunNotice("postgrest");
  assert(typeof notice === "string" && /Cloudflare Workers only/.test(notice) && /runs on Bun/.test(notice), "selecting postgrest on Bun earns the notice, naming Workers and Bun");
  assert(postgrestOnBunNotice("postgrest", false) === null, "…not on a runtime without Bun (Workers)");
  assert(postgrestOnBunNotice("sql") === null && postgrestOnBunNotice("sql", true) === null, "…and sql never does");

  // An unknown name is refused naming the default; an explicit sql selection is named as such.
  msg = await refusal({ OB1_STORE: "typo" });
  assert(/"sql" \(the default\)/.test(msg) && /"postgrest" \(Cloudflare Workers\)/.test(msg), "an unknown OB1_STORE is refused naming sql as the default and postgrest as the Workers store");
  const { problem, fix } = missingDatabaseUrl({ OB1_STORE: "sql" });
  assert(/^OB1_STORE=sql selects the SQL store, and DATABASE_URL is not set$/.test(problem) && /^Set DATABASE_URL/.test(fix), "an explicit sql selection without DATABASE_URL is named as such, problem and fix apart");
}

console.log("\n[15] The server says once, when it builds the store, that PostgREST is retired on Bun (SMD-1797)");
{
  // A second instance of the server: index.ts seeds its env once, on the first
  // request, and builds its store once, so the instance above — which never
  // built one — cannot be re-pointed. Bun keys its module cache on the full
  // specifier, so a query string yields a fresh module with its own env and
  // store, and the process env it copies is the one set here.
  process.env.OB1_STORE = "postgrest";
  process.env.SUPABASE_URL = "https://stub.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  const freshSpecifier = "./index.ts?postgrest-notice"; // a variable, so tsc does not try to resolve the query string as a module
  const second = (await import(freshSpecifier)).default as { fetch: (req: Request) => Response | Promise<Response> };
  const srv2 = Bun.serve({ port: 0, fetch: second.fetch });
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    // A tool that reaches the store before any provider call: two calls, one build.
    for (let i = 0; i < 2; i++) {
      await fetch(`http://localhost:${srv2.port}`, {
        method: "POST", headers: AUTH, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 5),
        body: JSON.stringify({ jsonrpc: "2.0", id: 40 + i, method: "tools/call", params: { name: "thought_stats", arguments: {} } }),
      }).then((r) => r.text()).catch(() => "");
    }
  } finally {
    console.warn = realWarn;
    srv2.stop(true);
    delete process.env.OB1_STORE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  const notices = warned.filter((w) => /keeps for Cloudflare Workers only/.test(w));
  assert(notices.length === 1, `the retired notice is logged exactly once across two tool calls (${notices.length} of ${warned.length} warnings)`);
  const { postgrestOnBunNotice: noticeOf } = await import("./store.ts");
  assert(notices[0] === noticeOf("postgrest"), "…and it is store.ts's line itself, byte for byte — not a copy carrying the same phrases");
}

console.log("\n[16] parseFilter bounds and normalises a metadata filter at the tool boundary (SMD-1490)");
{
  // The validator the search tools run a caller's `filter` through before it
  // reaches jsonb. Shallow by design (scalars or arrays of scalars) so
  // `metadata @> filter` stays GIN-indexable; a nested object, a non-object, or
  // a filter over the caps is refused here rather than handed to the store.
  const { parseFilter } = await import("./index.ts") as { parseFilter: (raw: unknown) => Record<string, unknown> };
  assert(JSON.stringify(parseFilter(undefined)) === "{}" && JSON.stringify(parseFilter(null)) === "{}" && JSON.stringify(parseFilter({})) === "{}",
    "absent, null or empty normalises to the unfiltered {}");
  const shallow = { type: "idea", count: 3, flagged: true };
  assert(JSON.stringify(parseFilter(shallow)) === JSON.stringify(shallow), "a shallow scalar object passes through unchanged");
  assert(JSON.stringify(parseFilter({ topics: ["ob1", "smd"] })) === JSON.stringify({ topics: ["ob1", "smd"] }), "an array of scalars passes");
  const throws = (raw: unknown): boolean => { try { parseFilter(raw); return false; } catch { return true; } };
  assert(throws({ type: { nested: "no" } }), "a nested object is refused");
  assert(throws("not an object") && throws([1, 2, 3]), "a non-object (string or array) is refused");
  assert(throws({ topics: [{ x: 1 }] }), "an array holding a non-scalar is refused");
  const manyKeys = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
  assert(throws(manyKeys), "a filter over the key cap is refused");
  assert(throws({ blob: "x".repeat(5000) }), "a filter over the size cap is refused");
}

console.log("\n[17] A tool call outlives the runtime's idle timeout, and a client that leaves is logged (SMD-1864)");
{
  const { withSseKeepalive, requestLabel, abandonedRequestLine, stalledRequestLine, SSE_KEEPALIVE_MS } = await import("./index.ts") as {
    withSseKeepalive: (r: Response, opts?: { intervalMs?: number; maxMs?: number; signal?: AbortSignal; onEnd?: () => void; label?: string }) => Response;
    requestLabel: (body: string | null) => string;
    abandonedRequestLine: (label: string, elapsedMs: number) => string;
    stalledRequestLine: (label: string, elapsedMs: number) => string;
    SSE_KEEPALIVE_MS: number;
  };
  // The premise is measured, not assumed: Bun closes a streaming response that
  // has been silent for its default idle timeout (10 s) at the next of its
  // 4-second sweeps — between 8 and 12 s of silence, by phase — while a handler
  // that has not returned yet is left alone. So the case is the transport's
  // shape, an SSE stream opened at once and written to when the tool returns,
  // and the silence is 13 s: past the last sweep that can catch it, so the
  // control is reset every run and not by the luck of the phase (11.5 s slipped
  // under it once). Four requests run at once; the section costs the longest.
  const SILENT_MS = 13_000;
  const SLOW_EMBED_MS = 13_000;
  const silentSse = (silentMs = SILENT_MS): Response => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await Bun.sleep(silentMs);
        try {
          controller.enqueue(new TextEncoder().encode("event: message\ndata: {\"late\":true}\n\n"));
          controller.close();
        } catch { /* reset under us — the bare case */ }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  // The mechanism dropped (bare) beside the mechanism (kept), on the runtime's
  // defaults. The bare server's kill is what prints Bun's own `warn: Bun.serve()
  // timed out a request after 10 seconds` after the suite's report: expected.
  const bare = Bun.serve({ port: 0, fetch: () => silentSse() });
  const kept = Bun.serve({ port: 0, fetch: (req) => withSseKeepalive(silentSse(), { signal: req.signal }) });
  // The ceiling, at a small scale: a stream silent for 400 ms with a 40 ms
  // frame and a 150 ms ceiling stops pinging at the ceiling and says so once.
  const capped = Bun.serve({ port: 0, fetch: (req) => withSseKeepalive(silentSse(400), { intervalMs: 40, maxMs: 150, signal: req.signal, label: "tools/call slow_one" }) });
  type Read = { ok: boolean; text: string; error: string; ms: number };
  const read = async (url: string, init: RequestInit = {}): Promise<Read> => {
    const t0 = performance.now();
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      return { ok: true, text, error: "", ms: performance.now() - t0 };
    } catch (e) {
      const code = (e as { code?: string }).code;
      return { ok: false, text: "", error: e instanceof Error ? `${e.name}${code ? ` ${code}` : ""}` : String(e), ms: performance.now() - t0 };
    }
  };
  const call = (id: number, query: string, init: RequestInit = {}) =>
    read(BASE, { method: "POST", headers: AUTH, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_thoughts", arguments: { query } } }), ...init });
  const frames = (t: string) => t.split(": keepalive\n\n").length - 1;
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  embedDelayMs = SLOW_EMBED_MS;
  let bareRun: Read, keptRun: Read, cappedRun: Read, slow: Read, gone: Read;
  try {
    [bareRun, keptRun, cappedRun, slow, gone] = await Promise.all([
      read(`http://127.0.0.1:${bare.port}/`),
      read(`http://127.0.0.1:${kept.port}/`),
      read(`http://127.0.0.1:${capped.port}/`),
      call(50, "a query whose embedding outlives the idle timeout"),
      // A client that gives up: the stream's headers arrive at once, so it is the body read that its 1.5 s signal ends.
      call(51, "needle-the-line-must-not-carry", { signal: AbortSignal.timeout(1500) }),
    ]);
    await Bun.sleep(500); // the abandoned call's line, and the stub's sleep behind it, settle
  } finally {
    console.warn = realWarn;
    embedDelayMs = 0;
    bare.stop(true);
    kept.stop(true);
    capped.stop(true);
  }
  // The kill lands at a sweep between 8 and 12 s of silence; the bound is the
  // 13 s answer, so a late sweep on a loaded runner is not read as a pass.
  assert(!bareRun.ok && bareRun.ms > 7_500 && bareRun.ms < SILENT_MS,
    `the premise: a streamed response silent past the default is reset at a sweep, before its 13 s event (${bareRun.ok ? "answered" : bareRun.error} after ${Math.round(bareRun.ms)} ms)`);
  assert(keptRun.ok && /"late":true/.test(keptRun.text), `the same stream through withSseKeepalive reaches its event (${keptRun.ok ? `${Math.round(keptRun.ms)} ms` : keptRun.error})`);
  assert(frames(keptRun.text) >= 2, `…carrying comment frames on the way (${frames(keptRun.text)} in ${SILENT_MS} ms at one per ${SSE_KEEPALIVE_MS} ms)`);
  assert(cappedRun.ok && /"late":true/.test(cappedRun.text) && frames(cappedRun.text) >= 2 && frames(cappedRun.text) <= 4,
    `the ceiling: frames stop at maxMs and the event still arrives (${frames(cappedRun.text)} frames in 400 ms at 40 ms with a 150 ms ceiling)`);
  const stalled = warned.filter((w) => /request still running/.test(w));
  const sm = /after (\d+) s/.exec(stalled[0] ?? "");
  assert(stalled.length === 1 && sm !== null && stalled[0] === stalledRequestLine("tools/call slow_one", Number(sm[1]) * 1000),
    `…and says so once, in index.ts's own line naming the call (${stalled.length} line)`);
  assert(slow.ok && slow.ms >= SLOW_EMBED_MS, `the real server answers search_thoughts after a ${SLOW_EMBED_MS} ms embedding, past the last sweep (${slow.ok ? `${Math.round(slow.ms)} ms` : `${slow.error} at ${Math.round(slow.ms)} ms`})`);
  const dataLine = slow.text.split("\n").find((l) => l.startsWith("data: "));
  let envelope: { jsonrpc?: string; id?: unknown } | null = null;
  try { envelope = dataLine ? JSON.parse(dataLine.slice(6)) : null; } catch { /* not an envelope */ }
  assert(envelope?.jsonrpc === "2.0" && envelope.id === 50, "…with the call's JSON-RPC envelope (no store is configured here, so the tool's answer is its refusal — the point is that it arrived)");
  assert(frames(slow.text) >= 2, `…kept alive by comment frames the client never sees as events (${frames(slow.text)})`);
  assert(!gone.ok, `a client that gives up at 1.5 s is gone (${gone.ok ? "answered" : gone.error})`);
  const lines = warned.filter((w) => /request abandoned/.test(w));
  assert(lines.length === 1, `…and the server logs it once, for that request alone (${lines.length} of ${warned.length} warnings)`);
  const m = /after (\d+\.\d) s/.exec(lines[0] ?? "");
  assert(m !== null && lines[0] === abandonedRequestLine("tools/call search_thoughts", Number(m[1]) * 1000), "…the line is index.ts's own, naming the method and the tool");
  assert(m !== null && Number(m[1]) >= 1.4 && Number(m[1]) < 3, `…at the moment the client left (${m?.[1] ?? "?"} s)`);
  assert(!/needle-the-line-must-not-carry/.test(lines[0] ?? ""), "…and never the query");
  assert(
    requestLabel(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture_thought", arguments: { content: "the thought" } } })) === "tools/call capture_thought"
      && requestLabel("[{\"method\":\"initialize\"}]") === "initialize" && requestLabel("not json") === "?" && requestLabel(null) === "?",
    "requestLabel: the method and the tool's name, a batch by its first message, `?` for the unreadable, never the arguments",
  );
  const forged = requestLabel(JSON.stringify({ method: "tools/call", params: { name: `x\nrequest abandoned by the client after 0.1 s: tools/call delete_thought${"y".repeat(500)}` } }));
  assert(!/\n/.test(forged) && forged.length <= "tools/call ".length + 64 && forged.startsWith("tools/call x?request"),
    `…a caller's name cannot forge a second line or flood one: control characters become ?, each part is capped (${forged.length} chars)`);
  let ended = false;
  const plain = new Response("{}", { headers: { "content-type": "application/json" } });
  assert(withSseKeepalive(plain, { onEnd: () => { ended = true; } }) === plain && ended, "a response that is not an event stream passes through untouched, complete at once");
}

server.stop();
provider.stop(true);

report();
