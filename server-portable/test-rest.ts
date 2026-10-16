#!/usr/bin/env bun
/**
 * test-rest.ts — the REST core's surface without a database (SMD-2284): the
 * route table against the manifest, the OpenAPI document against both, the
 * query-string reader, and the authorization ladder over a stub core — a
 * wrong key 401, a revoked key 401, a busy registry 503, a key whose scope
 * does not reach the operation 403, a refused input 400 naming the field and
 * never its value, a refusal its code and status, a fault FAILED 500, and
 * one log line per request with no query, key, id or content in it.
 *
 *   bun test-rest.ts
 */

import { createAssert, RuntimeUrl, serveChild } from "../db/test-support.ts";
import { hashKey, type Principal } from "./auth.ts";
import { TOOLS, TOOL_NAMES, READ_TOOL_NAMES, CAPTURE_TOOL_NAMES, type ToolName } from "./tools.ts";
import { SPECS, type Core } from "./core/index.ts";
import { RESERVED_META } from "./core/writes.ts";
import { META_KEYS_MAX, ok, refuse, TICKET_META_KEYS } from "./core/refusal.ts";
import type { AgentOutcome } from "./agents.ts";
import { ROUTES, pathFields } from "./rest/routes.ts";
import { createRestApp, inputFromQuery, headerKeys, REFUSAL_STATUS } from "./rest/app.ts";
import { openApiDocument } from "./rest/openapi.ts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { keyScopeOf as authKeyScopeOf, SCOPES as authScopes } from "../deploy/auth/layout.ts";
import { OAUTH_SCOPES } from "./oauth-edge.ts";
import { AUTH_JWKS_URL, checkerOver, JWKS_CACHE_MAX_AGE_MS, JWKS_COOLDOWN_MS, keyScopeOf, remoteChecker, subjectHash, tokenSettings, type TokenCheck } from "./oauth-token.ts";

const { assert, report } = createAssert();
type Op = { operationId: string; "x-ob1-scope"?: string; parameters?: { name: string; in: string; required?: boolean; schema: { type?: string; items?: { type?: string } } }[]; requestBody?: { content: { "application/json": { schema: { properties?: Record<string, unknown> } } } } };
const doc = openApiDocument() as { openapi: string; paths: Record<string, Record<string, Op>> };

console.log("[1] Every tool in the manifest has one route, and no two routes share a method and path");
{
  const names = Object.keys(ROUTES).sort();
  assert(JSON.stringify(names) === JSON.stringify([...TOOL_NAMES].sort()), `the routes are the manifest's ${TOOL_NAMES.length} tools (${names.length})`);
  const seen = new Set<string>();
  for (const [name, r] of Object.entries(ROUTES)) {
    const k = `${r.method} ${r.path}`;
    assert(!seen.has(k), `${name}: ${k} is its own`);
    seen.add(k);
    for (const f of pathFields(r.path)) assert(f in SPECS[name as ToolName].inputSchema, `${name}: the path's {${f}} is a field of its schema`);
  }
  // A free-text read rides a body, so the query never sits in a URL a log keeps.
  for (const name of ["search", "search_thoughts", "search_thoughts_keyword"] as const) assert(ROUTES[name].method === "POST", `${name} reads its query from a body`);
  // A GET or DELETE reads its input from the query string: every such field is a scalar or a list of scalars.
  for (const [name, r] of Object.entries(ROUTES)) {
    if (r.method !== "GET" && r.method !== "DELETE") continue;
    for (const p of doc.paths[r.path][r.method.toLowerCase()].parameters ?? []) {
      if (p.in !== "query") continue;
      const t = p.schema.type;
      assert(t !== "object" && (t !== "array" || p.schema.items?.type !== "object"), `${name}: its query field ${p.name} is a scalar or a list of scalars (${t})`);
    }
  }
}

console.log("\n[2] The OpenAPI document lists every operation the tools expose, with the tool's schema");
{
  assert(doc.openapi === "3.1.0", "OpenAPI 3.1");
  const ops = Object.values(doc.paths).flatMap((m) => Object.values(m)).map((o) => o.operationId);
  for (const t of TOOLS) {
    assert(ops.includes(t.name), `${t.name} is an operation`);
    const r = ROUTES[t.name as ToolName];
    const op = doc.paths[r.path][r.method.toLowerCase()];
    assert(op["x-ob1-scope"] === t.scope, `${t.name}: its scope is the manifest's (${op["x-ob1-scope"]})`);
    const want = Object.keys(SPECS[t.name as ToolName].inputSchema).filter((f) => !pathFields(r.path).includes(f)).sort();
    const got = op.requestBody
      ? Object.keys(op.requestBody.content["application/json"].schema.properties ?? {}).sort()
      : (op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort();
    assert(JSON.stringify(got) === JSON.stringify(want), `${t.name}: its ${op.requestBody ? "body" : "query"} is the schema's fields (${got.join(",")})`);
  }
  assert(ops.includes("whoami") && ops.includes("job_stream"), "whoami and the job stream are operations");
  // The capture body's metadata says what is refused, from the constants the
  // check reads (SMD-2617): the bound, and a capture-only key's ticket keys.
  const capOp = doc.paths[ROUTES.capture_thought.path][ROUTES.capture_thought.method.toLowerCase()];
  const metaDesc = String((capOp.requestBody?.content["application/json"].schema.properties?.metadata as { description?: string } | undefined)?.description ?? "");
  assert(metaDesc.includes(`at most ${META_KEYS_MAX} keys`) && TICKET_META_KEYS.every((k) => metaDesc.includes(`\`${k}\``)) && /for a capture-only key/.test(metaDesc),
    `the capture body's metadata names its bound and every ticket key a capture-only key is refused (${metaDesc.slice(-160)})`);
  assert(!JSON.stringify(doc).includes("GET /jobs/"), "no description sends a REST client to the MCP server's /jobs");
  for (const path of ["/v1/whoami", "/v1/jobs/{job_id}/stream", "/health"]) assert("405" in (doc.paths[path].get as unknown as { responses: Record<string, unknown> }).responses, `${path} documents its 405`);
  // Every status a keyed operation can answer is documented, each refusal's code under its own.
  // 501 is the one status only an operation with a mode not built gives (run_worker's drain).
  const statuses = new Set(["400", "401", "403", "405", "500", "503", ...Object.values(REFUSAL_STATUS).map(String)]);
  const responsesOf = (r: { path: string; method: string }) => (doc.paths[r.path][r.method.toLowerCase()] as unknown as { responses: Record<string, { description: string; headers?: Record<string, unknown> }> }).responses;
  for (const [name, r] of Object.entries(ROUTES)) {
    const responses = responsesOf(r);
    const want = [...statuses].filter((s) => s !== "501" || name === "run_worker");
    const missing = want.filter((s) => !(s in responses));
    assert(missing.length === 0 && ("501" in responses) === (name === "run_worker"), `${r.method} ${r.path} documents every status it can answer, and 501 only on run_worker${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    assert(responses["503"]?.headers?.["Retry-After"] !== undefined, `${r.method} ${r.path}: its 503 declares Retry-After`);
  }
  const codeLines = Object.values(ROUTES).flatMap((r) => Object.values(responsesOf(r)).map((x) => x.description)).join(" ");
  assert(Object.keys(REFUSAL_STATUS).filter((c) => c !== "EMBEDDING_NOT_ATTACHED").every((c) => codeLines.includes(c)), "…and names every refusal code under its status");
}

console.log("\n[3] A query string is read as the schema's types");
{
  const q = (s: string) => inputFromQuery("thought_changes", new URLSearchParams(s));
  assert(JSON.stringify(q("limit=5&others_only=true")) === JSON.stringify({ input: { limit: 5, others_only: true } }), "a number and a boolean are read as such");
  assert(JSON.stringify(q("actions=capture&actions=delete")) === JSON.stringify({ input: { actions: ["capture", "delete"] } }), "an array field takes every value");
  assert(JSON.stringify(q("limit=five")) === JSON.stringify({ input: { limit: "five" } }), "a number that is not one stays text, for the schema to refuse");
  // As JavaScript prints a number (SMD-2287): a client sends String(n), which must read back as n.
  const days = (s: string) => inputFromQuery("list_thoughts", new URLSearchParams(s));
  assert(JSON.stringify(days(`days=${encodeURIComponent(String(1e-7))}`)) === JSON.stringify({ input: { days: 1e-7 } }) && JSON.stringify(days(`days=${encodeURIComponent(String(1e21))}`)) === JSON.stringify({ input: { days: 1e21 } }), `a number in exponent form, as String() prints one, is read as that number (${String(1e-7)}, ${String(1e21)})`);
  assert(JSON.stringify(days("days=1e")) === JSON.stringify({ input: { days: "1e" } }) && JSON.stringify(days("days=0x10")) === JSON.stringify({ input: { days: "0x10" } }), "…and a half-written one, or hex, stays text");
  assert("problem" in q("limit=1&limit=2"), "a scalar given twice is refused");
}

console.log("\n[4] Keys come from the headers alone");
{
  const req = (h: Record<string, string>, url = "http://x/v1/stats") => new Request(url, { headers: h });
  assert(headerKeys(req({ "x-brain-key": "a" })).join() === "a", "x-brain-key");
  assert(headerKeys(req({ "x-access-key": "a2" })).join() === "a2", "x-access-key");
  assert(headerKeys(req({ authorization: "Bearer b" })).join() === "b", "a bearer token");
  assert(headerKeys(req({}, "http://x/v1/stats?key=c")).length === 0, "never ?key=");
}

// ── A stub core: each operation answers what the case below asks of it ──────
const calls: { name: string; principal: Principal; input: unknown }[] = [];
let answer: () => Promise<unknown> = async () => ok({});
const core = new Proxy({}, {
  get: (_t, prop) => async (principal: Principal, input: unknown) => {
    calls.push({ name: String(prop), principal, input });
    return answer();
  },
}) as unknown as Core;
let identity: AgentOutcome = { status: "ok", agentId: "agent-1" };
/** The registry's word on a forwarder key (SMD-2284), apart from the caller's. */
let carrierIdentity: AgentOutcome = { status: "ok", agentId: "agent-f" };
/** Every key the registry was asked about, by name — a refused forwarder must reach it with neither key. */
const resolvedNames: string[] = [];
let resolveThrows = false;
/** Set to hold every registry answer until it resolves (a request in flight at the registry, for a stop to cut). */
let resolveGate: Promise<void> | null = null;
const lines: string[] = [];
const app = createRestApp({
  core,
  init: () => {},
  keys: () => ({ MCP_ACCESS_KEYS: `r:read:${hashKey("read-raw")},w:write:${hashKey("write-raw")},c:capture:${hashKey("cap-raw")},f:forward:${hashKey("fwd-raw")}` }),
  resolve: async (p) => { resolvedNames.push(p.name); if (resolveGate) await resolveGate; if (resolveThrows) throw new Error("the registry threw"); return p.scope === "forward" ? carrierIdentity : identity; },
  track: (run) => run(),
  log: (l) => lines.push(l),
});
const hit = (path: string, init: RequestInit & { key?: string } = {}) =>
  app.fetch(new Request(`http://api${path}`, { ...init, headers: { ...(init.key ? { "x-brain-key": init.key } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } }));
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n[5] The authorization ladder: a wrong key 401, a revoked one 401, a busy registry 503, a scope that does not reach 403");
{
  let r = await json(await hit("/v1/stats"));
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED", `no key → 401 UNAUTHORIZED (${r.status} ${r.body.code})`);
  r = await json(await hit("/v1/stats", { key: "wrong" }));
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED", `a wrong key → 401 (${r.status})`);
  r = await json(await hit("/v1/stats?key=read-raw"));
  assert(r.status === 401, `a key in the query string is no key (${r.status})`);
  // A forwarder key (SMD-2284) grants nothing: alone it is no caller, whatever
  // it asks for, and the operation never runs.
  calls.length = 0;
  for (const [path, init] of [["/v1/stats", {}], ["/v1/whoami", {}], ["/v1/thoughts", { method: "POST", body: JSON.stringify({ content: "x" }) }]] as const) {
    r = await json(await hit(path, { key: "fwd-raw", ...init }));
    assert(r.status === 401 && r.body.code === "UNAUTHORIZED", `a forwarder key alone → 401 UNAUTHORIZED at ${"method" in init ? "POST " : "GET "}${path} (${r.status} ${r.body.code})`);
  }
  assert(calls.length === 0, `…and no operation ran (${calls.length})`);
  // In a caller's slot beside a caller's key, it is passed over, not taken for the caller.
  const beside = await json(await app.fetch(new Request("http://api/v1/whoami", { headers: { "x-brain-key": "fwd-raw", authorization: "Bearer read-raw" } })));
  assert(beside.status === 200 && beside.body.name === "r" && beside.body.scope === "read", `a forwarder key beside a read key: the read key is the caller (${beside.status} ${JSON.stringify(beside.body).slice(0, 60)})`);
  r = await json(await hit("/v1/stats", { key: "read-raw" }));
  assert(r.status === 200, `a read key reads (${r.status})`);
  r = await json(await hit("/v1/thoughts", { key: "read-raw", method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 403 && r.body.code === "FORBIDDEN" && r.body.needs === "capture", `a read key cannot capture (${r.status} ${JSON.stringify(r.body)})`);
  r = await json(await hit("/v1/thoughts/00000000-0000-4000-8000-000000000000", { key: "read-raw", method: "DELETE" }));
  assert(r.status === 403 && r.body.needs === "write", `…nor delete (${r.status})`);
  r = await json(await hit("/v1/stats", { key: "cap-raw" }));
  assert(r.status === 403 && r.body.needs === "read", `a capture key cannot read (${r.status})`);
  const captured = {
    id: "cap-id", reader: false, tags: { type: "idea" }, chunks: 0, contextFailures: 0, headWindow: null, recapture: null,
    embeddings: { allowed: true, reason: "allowed: host ollama:11434" }, chat: { allowed: true, reason: "allowed", base: "http://ollama:11434/v1" },
  };
  answer = async () => ok(captured);
  r = await json(await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 201, `…and can capture (${r.status})`);
  assert(same(r.body, { id: "cap-id", embeddingCall: true, chunks: 0, contextFailures: 0, embeddingAttached: true }),
    `…told what the MCP tool tells it — no provider address, gate reason or tags (${JSON.stringify(r.body)})`);
  r = await json(await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 201 && same(r.body, { ...captured, embeddingAttached: true }), "a key that can read is told the whole value");
  answer = async () => ok({});
  identity = { status: "revoked", agentId: "agent-1", revokedAt: "2026-10-02T00:00:00Z", reason: null };
  r = await json(await hit("/v1/stats", { key: "read-raw" }));
  assert(r.status === 401 && r.body.code === "REVOKED" && !("name" in r.body), `a revoked key → 401 REVOKED, its name told to no one but a forwarder (${JSON.stringify(r.body)})`);
  identity = { status: "busy" } as AgentOutcome;
  const busy = await hit("/v1/stats", { key: "read-raw" });
  const busyBody = await busy.clone().json() as Record<string, unknown>;
  assert(busy.status === 503 && busy.headers.get("retry-after") === "2" && !("name" in busyBody), `a busy registry → 503 with Retry-After, no name (${busy.status} ${JSON.stringify(busyBody)})`);
  identity = { status: "ok", agentId: "agent-1" };
  calls.length = 0;
  await hit("/v1/stats", { key: "write-raw" });
  assert(calls[0]?.principal.agentId === "agent-1" && calls[0]?.principal.name === "w", "the operation runs as the key, its agent id resolved");
  const who = await json(await hit("/v1/whoami", { key: "cap-raw" }));
  assert(who.status === 200 && who.body.scope === "capture" && JSON.stringify(who.body.operations) === JSON.stringify(CAPTURE_TOOL_NAMES), `whoami names the key's scope and its operations (${JSON.stringify(who.body)})`);
  const whoRead = await json(await hit("/v1/whoami", { key: "read-raw" }));
  assert(JSON.stringify(whoRead.body.operations) === JSON.stringify(READ_TOOL_NAMES), "…a read key's are the read group");
}

console.log("\n[5b] Forwarded: a caller's key beside the forwarder slot — the client's key decides, the forwarder is named as act, any other key there refused (SMD-2284)");
{
  const fwd = (path: string, key: string | null, carrier: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://api${path}`, { ...init, headers: { ...(key ? { "x-brain-key": key } : {}), "x-brain-forwarder": carrier, ...(init.body ? { "content-type": "application/json" } : {}) } }));
  identity = { status: "ok", agentId: "agent-1" };
  carrierIdentity = { status: "ok", agentId: "agent-f" };
  let who = await json(await fwd("/v1/whoami", "read-raw", "fwd-raw"));
  assert(who.status === 200 && who.body.name === "r" && who.body.scope === "read" && same(who.body.act, { name: "f", agentId: "agent-f" }),
    `whoami, forwarded: the client's key is the caller, the forwarder its act with its agent id (${JSON.stringify(who.body).slice(0, 120)})`);
  const plain = await json(await hit("/v1/whoami", { key: "read-raw" }));
  assert(plain.status === 200 && !("act" in plain.body), "…and a request not forwarded carries no act");
  calls.length = 0;
  answer = async () => ok({});
  let r = await json(await fwd("/v1/stats", "read-raw", "fwd-raw"));
  assert(r.status === 200 && calls[0]?.principal.name === "r" && same(calls[0]?.principal.act, { name: "f", agentId: "agent-f" }), `the operation runs as the client's key, act set beside it (${r.status} ${JSON.stringify(calls[0]?.principal.act)})`);
  r = await json(await fwd("/v1/thoughts", "read-raw", "fwd-raw", { method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 403 && r.body.needs === "capture", `the forwarder widens nothing: a read key forwarded still cannot capture (${r.status})`);
  answer = async () => ok({ id: "fwd-id", reader: false, tags: {}, chunks: 0, contextFailures: 0, headWindow: null, recapture: null, embeddings: { allowed: true, reason: "allowed" }, chat: { allowed: true, reason: "allowed", base: "http://ollama:11434/v1" } });
  calls.length = 0;
  r = await json(await fwd("/v1/thoughts", "cap-raw", "fwd-raw", { method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 201 && calls[0]?.principal.scope === "capture" && calls[0]?.principal.act?.name === "f", `a capture key forwarded captures, act set (${r.status})`);
  // Forwarded, the value is whole, as a refusal is: the MCP server renders what a capture key is told from it (SMD-2287 PR 3a review pass 1).
  assert((r.body as { tags?: unknown }).tags !== undefined && (r.body as { embeddings?: unknown }).embeddings !== undefined && r.body.embeddingAttached === true,
    `…and is answered the whole capture value for the MCP server to word (${Object.keys(r.body).sort().join(",")})`);
  const direct = await json(await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(direct.status === 201 && !("tags" in direct.body) && !("embeddings" in direct.body), `…while not forwarded, a capture key is told the trimmed value alone (${Object.keys(direct.body).sort().join(",")})`);
  answer = async () => ok({});
  r = await json(await fwd("/v1/stats", "cap-raw", "fwd-raw"));
  assert(r.status === 403 && r.body.needs === "read", `…and still cannot read (${r.status})`);
  // A forwarded refusal carries the refusal whole, the words its facts leave
  // out, for the MCP server to say them (SMD-2287); one not forwarded, the facts alone.
  const filter = { code: "REFUSED_FILTER", retryable: false, message: "said_by must be one of the known writers" } as const;
  answer = async () => refuse(filter);
  r = await json(await fwd("/v1/search", "read-raw", "fwd-raw", { method: "POST", body: JSON.stringify({ query: "q" }) }));
  assert(r.status === 400 && same(r.body, { code: "REFUSED_FILTER", retryable: false, refusal: filter }), `a forwarded refusal: its facts and, beside them, the refusal whole (${JSON.stringify(r.body)})`);
  r = await json(await hit("/v1/search", { key: "read-raw", method: "POST", body: JSON.stringify({ query: "q" }) }));
  assert(r.status === 400 && same(r.body, { code: "REFUSED_FILTER", retryable: false }), `…and not forwarded, the facts alone (${JSON.stringify(r.body)})`);
  const unattached = { code: "EMBEDDING_NOT_ATTACHED", retryable: true, id: "saved-id", detail: "the vector write failed" } as const;
  answer = async () => refuse(unattached);
  r = await json(await fwd("/v1/thoughts", "cap-raw", "fwd-raw", { method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 201 && same(r.body, { id: "saved-id", embeddingAttached: false, refusal: unattached }), `a forwarded save whose vector did not attach: the creation, with its refusal beside it (${JSON.stringify(r.body)})`);
  r = await json(await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 201 && same(r.body, { id: "saved-id", embeddingAttached: false }), `…and not forwarded, the creation alone (${JSON.stringify(r.body)})`);
  answer = async () => ok({});

  // Anything else in the slot is refused, naming the slot, whatever the
  // caller's scope (review pass 1: a capture caller alone left a scope-keyed
  // bypass alive); the operation never runs, and neither key reaches the registry.
  calls.length = 0;
  resolvedNames.length = 0;
  for (const [caller, path, init] of [["read-raw", "/v1/stats", {}], ["write-raw", "/v1/thoughts", { method: "POST", body: JSON.stringify({ content: "x" }) }], ["cap-raw", "/v1/thoughts", { method: "POST", body: JSON.stringify({ content: "x" }) }]] as const) {
    for (const [label, carrier] of [["a read key", "read-raw"], ["a write key", "write-raw"], ["an unknown key", "nope"], ["an empty value", ""], ["the caller's own key", caller]] as const) {
      const x = await fwd(path, caller, carrier, init);
      const b = await json(x);
      assert(b.status === 401 && b.body.code === "UNAUTHORIZED" && b.body.credential === "forwarder" && x.headers.get("www-authenticate") === "Bearer",
        `${caller}: ${label} in the forwarder slot → 401 UNAUTHORIZED, credential forwarder (${b.status} ${JSON.stringify(b.body)})`);
    }
  }
  assert(calls.length === 0 && resolvedNames.length === 0, `…and no operation ran, and no key reached the registry (${calls.length}, ${resolvedNames.join(",")})`);
  // The swap: the forwarder in a caller's slot and a caller's key in the forwarder's.
  r = await json(await fwd("/v1/whoami", "fwd-raw", "read-raw"));
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED" && !("credential" in r.body), `the forwarder as the caller and a client's key as the forwarder → the caller's 401 (${JSON.stringify(r.body)})`);
  // Two forwarder headers: Headers.get joins them, and the joined value is no key.
  const twice = new Headers({ "x-brain-key": "read-raw" });
  twice.append("x-brain-forwarder", "fwd-raw");
  twice.append("x-brain-forwarder", "fwd-raw");
  r = await json(await app.fetch(new Request("http://api/v1/whoami", { headers: twice })));
  assert(r.status === 401 && r.body.credential === "forwarder", `two forwarder headers, even the same sound key twice → 401, credential forwarder (${JSON.stringify(r.body)})`);
  r = await json(await fwd("/v1/whoami", null, "fwd-raw"));
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED" && !("credential" in r.body), `the forwarder slot alone, no caller's key → the caller's 401 (${JSON.stringify(r.body)})`);
  identity = { status: "revoked", agentId: "agent-1", revokedAt: "2026-10-05T00:00:00Z", reason: null };
  r = await json(await fwd("/v1/whoami", "read-raw", "fwd-raw"));
  assert(r.status === 401 && r.body.code === "REVOKED" && !("credential" in r.body) && r.body.name === "r", `a revoked caller beside a sound forwarder → the caller's REVOKED, its key named to the forwarder for its line (SMD-2287 PR 4b) (${JSON.stringify(r.body)})`);
  identity = { status: "busy" } as AgentOutcome;
  r = await json(await fwd("/v1/whoami", "read-raw", "fwd-raw"));
  assert(r.status === 503 && r.body.code === "BUSY" && r.body.name === "r", `a busy caller beside a sound forwarder → BUSY, named too (${JSON.stringify(r.body)})`);
  identity = { status: "ok", agentId: "agent-1" };
  carrierIdentity = { status: "revoked", agentId: "agent-f", revokedAt: "2026-10-05T00:00:00Z", reason: null };
  r = await json(await fwd("/v1/whoami", "read-raw", "fwd-raw"));
  assert(r.status === 401 && r.body.code === "REVOKED" && r.body.credential === "forwarder" && !("name" in r.body), `a revoked forwarder → 401 REVOKED, credential forwarder, no caller named (${JSON.stringify(r.body)})`);
  carrierIdentity = { status: "busy" } as AgentOutcome;
  r = await json(await fwd("/v1/whoami", "read-raw", "fwd-raw"));
  assert(r.status === 503 && r.body.code === "BUSY" && r.body.credential === "forwarder" && r.body.name === "r", `a busy forwarder → 503 BUSY, credential forwarder, the caller named for the forwarder's line (${JSON.stringify(r.body)})`);
  carrierIdentity = { status: "busy" } as AgentOutcome;
  const busy = await fwd("/v1/whoami", "read-raw", "fwd-raw");
  const busyBody = await busy.clone().json() as Record<string, unknown>;
  assert(busy.status === 503 && busy.headers.get("retry-after") === "2" && busyBody.credential === "forwarder", `a busy registry on the forwarder → 503 with Retry-After, naming the slot (${busy.status} ${JSON.stringify(busyBody)})`);
  carrierIdentity = { status: "ok", agentId: undefined, unresolved: "unreachable" };
  who = await json(await fwd("/v1/whoami", "read-raw", "fwd-raw"));
  assert(who.status === 200 && same(who.body.act, { name: "f" }), `an unreachable registry names the forwarder without an id (${JSON.stringify(who.body.act)})`);
  carrierIdentity = { status: "ok", agentId: "agent-f" };
  const doc = await json(await hit("/openapi.json"));
  const schemes = (doc.body.components as { securitySchemes: Record<string, { in?: string; name?: string }> }).securitySchemes;
  const statsSecurity = ((doc.body.paths as Record<string, Record<string, { security?: Record<string, unknown>[] }>>)["/v1/stats"].get.security ?? []).map((x) => Object.keys(x).sort().join("+"));
  assert(schemes.forwarder?.in === "header" && schemes.forwarder?.name === "x-brain-forwarder" && statsSecurity.includes("brainKey+forwarder") && statsSecurity.includes("brainKey") && !statsSecurity.includes("forwarder"),
    `the document names the forwarder slot, beside a caller's key and never alone (${statsSecurity.join(", ")})`);
}

console.log("\n[5c] A keyed /health answers the brain's record on the health surface to a key that may read it, cleared in time; liveness to any other (SMD-2287)");
{
  const record = { version: "1.0.0", database: { reachable: true }, counts: { thoughts: 3 } };
  answer = async () => record;
  identity = { status: "ok", agentId: "agent-1" };
  const health = async (key?: string, method = "GET", extra: Record<string, string> = {}) => {
    const r = await app.fetch(new Request("http://api/health", { method, headers: { ...(key ? { "x-brain-key": key } : {}), ...extra } }));
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
  };
  const live = { status: "ok" };
  calls.length = 0;
  let r = await health();
  assert(r.status === 200 && same(r.body, live) && calls.length === 0, `no key: liveness, nothing read (${JSON.stringify(r.body)})`);
  for (const key of ["read-raw", "write-raw"]) {
    calls.length = 0;
    r = await health(key);
    assert(r.status === 200 && same(r.body, record) && calls[0]?.name === "brainInfo" && calls[0]?.principal === ("health" as never), `${key}: the brain's record, read on the health surface (${JSON.stringify(r.body)} via ${calls[0]?.name}(${String(calls[0]?.principal)}))`);
  }
  for (const [label, key] of [["a capture key", "cap-raw"], ["a wrong key", "nope"], ["a forwarder key alone", "fwd-raw"]] as const) {
    r = await health(key);
    assert(r.status === 200 && same(r.body, live), `${label}: liveness, never a refusal (${JSON.stringify(r.body)})`);
  }
  // Present but the slot ignored: the record is the caller's key's to see, whoever carried it.
  r = await health("read-raw", "GET", { "x-brain-forwarder": "nope" });
  assert(r.status === 200 && same(r.body, record), `a read key with a junk forwarder slot: still the record (${JSON.stringify(r.body)})`);
  r = await health("read-raw", "HEAD");
  assert(r.status === 200 && r.body === null, "a keyed HEAD: 200 with no body, nothing read for it");
  for (const [label, word] of [["revoked", { status: "revoked", agentId: "agent-1", revokedAt: "2026-10-05T00:00:00Z", reason: null }], ["busy", { status: "busy" }]] as const) {
    identity = word as AgentOutcome;
    lines.length = 0;
    r = await health("read-raw");
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert(r.status === 200 && same(r.body, live) && line.outcome === "refused" && line.code === (label === "revoked" ? "REVOKED" : "BUSY"),
      `a ${label} key: liveness, its line refused with ${line.code} (${JSON.stringify(r.body)})`);
  }
  identity = { status: "ok", agentId: "agent-1" };
  resolveThrows = true;
  r = await health("read-raw");
  resolveThrows = false;
  assert(r.status === 200 && same(r.body, live), "a registry that throws: liveness, not a 500");
  // A registry that does not answer within the deadline could still say revoked: liveness, at the deadline.
  let release: () => void = () => {};
  resolveGate = new Promise<void>((done) => { release = done; });
  const t0 = performance.now();
  r = await health("read-raw");
  const took = performance.now() - t0;
  release();
  resolveGate = null;
  assert(r.status === 200 && same(r.body, live) && took >= 2_400 && took < 4_000, `a registry silent past the deadline: liveness, at it (${Math.round(took)} ms)`);
  answer = async () => ok({});
}

console.log("\n[5d] The authorization server's tokens (SMD-2286): issuer, audience, ES256 at+jwt, scopes one to one, `oauth:<sub>`, act; unconfigured none; no keys a 503");
{
  const ORIGIN = "https://brain.example.test";
  const settings = tokenSettings({ COMPOSE_PROFILES: "auth", OB1_PUBLIC_ORIGIN: ORIGIN })!;
  assert(same(settings, { issuer: `${ORIGIN}/auth`, audience: `${ORIGIN}/api` }), `configured: issuer <origin>/auth, audience <origin>/api (${JSON.stringify(settings)})`);
  assert(tokenSettings({ OB1_PUBLIC_ORIGIN: ORIGIN }) === null && tokenSettings({ COMPOSE_PROFILES: "auth", OB1_PUBLIC_ORIGIN: "http://brain.example.test" }) === null,
    "not configured, or an unsound origin: no settings, so no token is accepted");
  for (const [scope, want] of [
    ["brain:write", "write"], ["brain:read brain:write brain:capture", "write"], ["brain:read", "read"], ["brain:capture", "capture"],
    ["openid offline_access brain:read", "read"], ["brain:read brain:capture", null], ["", null], ["openid", null], [undefined, null], [42, null],
  ] as const) assert(keyScopeOf(scope) === want, `keyScopeOf(${JSON.stringify(scope)}) → ${want} (${keyScopeOf(scope)})`);
  // The authorization server issues by the same rule (deploy/auth/layout.ts keyScopeOf): every set of its scopes, read alike.
  const offered = [...authScopes, "openid", "offline_access"];
  const subsets = Array.from({ length: 1 << offered.length }, (_, m) => offered.filter((_, i) => m & (1 << i)));
  const differ = subsets.filter((s) => keyScopeOf(s.join(" ")) !== authKeyScopeOf(s));
  assert(differ.length === 0 && same([...authScopes], [...OAUTH_SCOPES]), `the REST core and the authorization server read all ${subsets.length} sets of scopes alike, over the same three brain scopes${differ.length ? ` (differ: ${differ.map((s) => s.join("+")).join(", ")})` : ""}`);

  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = "ob1-test";
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }] };
  const other = await generateKeyPair("ES256");
  type Claims = Record<string, unknown>;
  const mint = (claims: Claims = {}, opt: { key?: CryptoKey; kid?: string; typ?: string; exp?: string | number } = {}) =>
    new SignJWT({ scope: "brain:write", ...claims })
      .setProtectedHeader({ alg: "ES256", typ: opt.typ ?? "at+jwt", kid: opt.kid ?? kid })
      .setIssuer(String(claims.iss ?? settings.issuer)).setAudience((claims.aud as string | string[]) ?? settings.audience)
      .setSubject(String(claims.sub ?? "operator")).setIssuedAt().setExpirationTime(opt.exp ?? "10m")
      .sign(opt.key ?? privateKey);
  let check: TokenCheck | null = checkerOver(settings, createLocalJWKSet(jwks));
  const tokenApp = createRestApp({
    core,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: `r:read:${hashKey("read-raw")},f:forward:${hashKey("fwd-raw")}` }),
    tokens: () => check,
    resolve: async (p) => { resolvedNames.push(p.name); return p.scope === "forward" ? carrierIdentity : identity; },
    track: (run) => run(),
    log: () => {},
  });
  const call = (path: string, token: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    tokenApp.fetch(new Request(`http://api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } }));
  identity = { status: "ok", agentId: "agent-o" };
  answer = async () => ok({});

  let r = await json(await call("/v1/whoami", await mint()));
  assert(r.status === 200 && r.body.name === "oauth:operator" && r.body.scope === "write" && r.body.agentId === "agent-o" && !("act" in r.body),
    `a write token: the caller is oauth:operator, write scope, its agent id resolved (${JSON.stringify(r.body).slice(0, 120)})`);
  calls.length = 0;
  await call("/v1/stats", await mint());
  const p = calls[0]?.principal;
  assert(p?.name === "oauth:operator" && p.keyHash === subjectHash(settings.issuer, "operator") && /^[0-9a-f]{64}$/.test(p.keyHash),
    `the operation runs as oauth:operator, its keyHash the subject's fixed digest (64 hex, the registry's CHECK) (${p?.name} ${p?.keyHash})`);
  assert(subjectHash(settings.issuer, "operator") !== subjectHash("https://other.example.test/auth", "operator") && subjectHash(settings.issuer, "operator") !== hashKey("operator"),
    "…a digest of issuer and subject: not another issuer's, nor a key's");

  const read = await mint({ scope: "brain:read" });
  r = await json(await call("/v1/stats", read));
  assert(r.status === 200, `a read token reads (${r.status})`);
  calls.length = 0;
  r = await json(await call("/v1/thoughts", read, { method: "POST", body: JSON.stringify({ content: "x" }) }));
  assert(r.status === 403 && r.body.code === "FORBIDDEN" && r.body.needs === "capture" && calls.length === 0, `a read token cannot capture: 403 needs capture, nothing ran (${r.status} ${JSON.stringify(r.body)})`);
  r = await json(await call("/v1/thoughts/00000000-0000-4000-8000-000000000000", read, { method: "DELETE" }));
  assert(r.status === 403 && r.body.needs === "write", `…nor delete (${r.status})`);
  const cap = await mint({ scope: "brain:capture" });
  r = await json(await call("/v1/stats", cap));
  assert(r.status === 403 && r.body.needs === "read", `a capture token cannot read (${r.status})`);
  r = await json(await call("/v1/whoami", cap));
  assert(r.status === 200 && r.body.scope === "capture" && same(r.body.operations, CAPTURE_TOOL_NAMES), `…its operations are a capture key's (${JSON.stringify(r.body.operations)})`);

  // A valid token whose scopes name no key scope reaches no operation: 403 as a token, RFC 6750's insufficient_scope.
  for (const [label, scope] of [["brain:read with brain:capture, no key's scope", "brain:read brain:capture"], ["no brain scope", "openid offline_access"]] as const) {
    calls.length = 0;
    const res = await call("/v1/stats", await mint({ scope }));
    const body = await res.json() as Record<string, unknown>;
    assert(res.status === 403 && body.code === "FORBIDDEN" && body.credential === "token" && res.headers.get("www-authenticate") === 'Bearer error="insufficient_scope"' && calls.length === 0,
      `${label}: 403 FORBIDDEN credential token, insufficient_scope, nothing run (${res.status} ${JSON.stringify(body)} ${res.headers.get("www-authenticate")})`);
  }
  r = await json(await call("/v1/whoami", await mint({ aud: [settings.audience] })));
  assert(r.status === 200, `an audience list holding this REST core alone is accepted (${r.status})`);

  // Every token this server does not accept: 401 as a token, RFC 6750's invalid_token, and nothing runs.
  const refused: [string, Promise<string>][] = [
    ["the /mcp audience (Verify: the MCP-audience token sent straight to the REST core)", mint({ aud: `${ORIGIN}/mcp` })],
    ["an audience list naming this REST core and the /mcp resource", mint({ aud: [settings.audience, `${ORIGIN}/mcp`] })],
    ["another tier's REST core", mint({ aud: `${ORIGIN}/canary/api` })],
    ["another issuer", mint({ iss: "https://elsewhere.example.test/auth" })],
    ["expired", mint({}, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ["no expiry at all", new SignJWT({ scope: "brain:write" }).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid }).setIssuer(settings.issuer).setAudience(settings.audience).setSubject("operator").setIssuedAt().sign(privateKey)],
    ["typ JWT, not at+jwt (an ID token's shape)", mint({}, { typ: "JWT" })],
    ["signed by another key under the server's kid", mint({}, { key: other.privateKey })],
    ["a kid the key set does not hold", mint({}, { kid: "ob1-unknown", key: other.privateKey })],
    ["HS256", new SignJWT({ scope: "brain:write" }).setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid }).setIssuer(settings.issuer).setAudience(settings.audience).setSubject("operator").setIssuedAt().setExpirationTime("10m").sign(new TextEncoder().encode("x".repeat(32)))],
    ["a subject holding a character a log or egress term cannot carry", mint({ sub: "oper ator" })],
    ["an act naming no actor", mint({ act: { client: "mcp" } })],
    ["unsigned (alg none)", Promise.resolve(`${btoa(JSON.stringify({ alg: "none", typ: "at+jwt" })).replace(/=+$/, "")}.${btoa(JSON.stringify({ iss: settings.issuer, aud: settings.audience, sub: "operator", scope: "brain:write", exp: Math.floor(Date.now() / 1000) + 600 })).replace(/=+$/, "")}.`)],
  ];
  for (const [label, made] of refused) {
    calls.length = 0;
    const res = await call("/v1/stats", await made);
    const body = await res.json() as Record<string, unknown>;
    assert(res.status === 401 && body.code === "UNAUTHORIZED" && body.credential === "token" && res.headers.get("www-authenticate") === 'Bearer error="invalid_token"' && calls.length === 0,
      `refused, ${label}: 401 UNAUTHORIZED credential token, invalid_token (${res.status} ${JSON.stringify(body)} ${res.headers.get("www-authenticate")})`);
  }

  // An exchanged token names the MCP service as act, signed; a forwarder slot beside it is checked and does not replace it.
  const exchanged = await mint({ scope: "brain:read", act: { sub: "mcp" } });
  r = await json(await call("/v1/whoami", exchanged));
  assert(r.status === 200 && r.body.name === "oauth:operator" && same(r.body.act, { name: "oauth:mcp" }), `an exchanged token: the subject, act oauth:<the MCP client> (${JSON.stringify(r.body).slice(0, 120)})`);
  r = await json(await call("/v1/whoami", exchanged, { headers: { "x-brain-forwarder": "fwd-raw" } }));
  assert(r.status === 200 && same(r.body.act, { name: "oauth:mcp" }), `…beside a forwarder's key, the token's own act stands (${JSON.stringify(r.body.act)})`);
  r = await json(await call("/v1/whoami", exchanged, { headers: { "x-brain-forwarder": "read-raw" } }));
  assert(r.status === 401 && r.body.credential === "forwarder", `…and a slot holding no forwarder's key is refused all the same (${r.status} ${JSON.stringify(r.body)})`);
  r = await json(await call("/v1/whoami", await mint(), { headers: { "x-brain-forwarder": "fwd-raw" } }));
  assert(r.status === 200 && same(r.body.act, { name: "f", agentId: "agent-f" }), `a token naming no act, carried by a forwarder: the forwarder is act, as for a key (${JSON.stringify(r.body.act)})`);
  // A service's client-credentials token: the authorization server's `sub` is the client id.
  r = await json(await call("/v1/whoami", await mint({ sub: "runner", scope: "brain:capture" })));
  assert(r.status === 200 && r.body.name === "oauth:runner", `a service's token: oauth:<its client id> (${r.body.name})`);

  // The registry's word holds for a token as for a key.
  identity = { status: "revoked", agentId: "agent-o", revokedAt: "2026-10-16T00:00:00Z", reason: null };
  r = await json(await call("/v1/stats", await mint()));
  assert(r.status === 401 && r.body.code === "REVOKED", `a subject the registry revoked → 401 REVOKED (${r.status} ${r.body.code})`);
  identity = { status: "ok", agentId: "agent-o" };

  // A key beside a token is the caller: keys first, as before.
  r = await json(await tokenApp.fetch(new Request("http://api/v1/whoami", { headers: { "x-brain-key": "read-raw", authorization: `Bearer ${await mint()}` } })));
  assert(r.status === 200 && r.body.name === "r", `a key beside a token: the key is the caller (${r.body.name})`);
  // A bearer that is no JWT's shape is a key, never handed to the check.
  let checked = 0;
  const counted = check;
  check = async (t) => { checked++; return counted!(t); };
  r = await json(await call("/v1/whoami", "not-a-jwt"));
  assert(r.status === 401 && !("credential" in r.body) && checked === 0, `a wrong key as Bearer: an unknown key, the token check not asked (${r.status} ${JSON.stringify(r.body)} ${checked})`);
  // A key reader that fails any other way (a bug, a library's own throw) is no keys to check with: 503, never 401.
  check = checkerOver(settings, async () => { throw new Error("a reader's own failure"); });
  r = await json(await call("/v1/whoami", await mint()));
  assert(r.status === 503 && r.body.code === "BUSY" && r.body.credential === "token", `a key reader that throws: 503 BUSY credential token (${r.status} ${JSON.stringify(r.body)})`);
  // Unconfigured (no check): a token is an unknown key, as before SMD-2286.
  check = null;
  r = await json(await call("/v1/whoami", await mint()));
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED" && !("credential" in r.body), `not configured: a valid token is an unknown key (${r.status} ${JSON.stringify(r.body)})`);
  const plainApp = await json(await app.fetch(new Request("http://api/v1/whoami", { headers: { authorization: `Bearer ${await mint()}` } })));
  assert(plainApp.status === 401 && !("credential" in plainApp.body), `…and a REST app given no token check accepts none (${plainApp.status})`);

  // The key set on the network (remoteChecker, cachedKeys), on a clock of the suite's own (ms): read once and kept
  // 600 s; when a read fails, the keys read last serve 600 s from that first failure and no read is tried for 30 s;
  // past that, or never read, a token is a 503 with the 30 s wait, not a 401. A key the set lacks is read for, at
  // most once in 30 s: right after a read it is the token's fault (401), within the 30 s it is a 503.
  let served = 0;
  let failing = false;
  const k2 = await generateKeyPair("ES256", { extractable: true });
  let serving: { keys: unknown[] } = jwks;
  const jwksServer = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/auth/jwks" ? (served++, failing ? new Response("down", { status: 503 }) : Response.json(serving)) : new Response("no", { status: 404 })) });
  const at = `http://127.0.0.1:${jwksServer.port}/auth/jwks`;
  let T = 0;
  const S = 1000;
  const clock = () => T;
  const status = async (token?: string) => (await call("/v1/whoami", token ?? await mint())).status;
  const step = async (label: string, t: number, want: number, reads: number, token?: string) => {
    T = t * S;
    const got = await status(token);
    assert(got === want && served === reads, `${label} (t=${t} s): ${want}, ${reads} read(s) so far (${got}, ${served})`);
  };
  check = remoteChecker(settings, at, clock);
  await step("the remote key set: read at the first token", 0, 200, 1);
  await step("…kept: no read for the next", 100, 200, 1);
  failing = true;
  await step("…the authorization server failing, a set under 600 s old serves without a read", 599, 200, 1);
  await step("a stale set: a read is tried, fails, and the keys read last serve", 601, 200, 2);
  await step("…no read tried again within 30 s of the failure", 610, 200, 2);
  await step("…tried again after 30 s, failing still: the keys read last serve, 600 s from the first failure", 632, 200, 3);
  await step("…past 600 s from the first failure (every token issued before it has expired): 503", 1202, 503, 4);
  failing = false;
  await step("the server back: read again after 30 s, and served", 1240, 200, 5);
  serving = { keys: [...jwks.keys, { ...(await exportJWK(k2.publicKey)), kid: "ob1-k2", alg: "ES256", use: "sig" }] };
  const byK2 = await mint({}, { kid: "ob1-k2", key: k2.privateKey });
  await step("a new signing key 10 s after a read: 503 while the set cannot be read again, not a 401 that would send its client to sign in", 1250, 503, 5, byK2);
  await step("…after 30 s it is read for, and served", 1271, 200, 6, byK2);
  const byNone = await mint({}, { kid: "ob1-nowhere", key: k2.privateKey });
  await step("a kid the authorization server does not hold, read for: 401, the token's fault", 1302, 401, 7, byNone);
  await step("…again within 30 s: 503, no read", 1303, 503, 7, byNone);
  failing = true;
  check = remoteChecker(settings, at, clock);
  T = 2000 * S;
  const down = await call("/v1/whoami", await mint());
  const downBody = await down.json() as Record<string, unknown>;
  assert(down.status === 503 && downBody.code === "BUSY" && downBody.credential === "token" && down.headers.get("retry-after") === "30" && served === 8,
    `a key set never read, the server answering 503: the token is 503 BUSY credential token, Retry-After 30 — not refused (${down.status} ${JSON.stringify(downBody)} ${down.headers.get("retry-after")})`);
  await step("…and no read again within 30 s", 2010, 503, 8);
  jwksServer.stop(true);
  check = remoteChecker(settings, at, clock);
  const gone = await call("/v1/whoami", await mint());
  assert(gone.status === 503 && gone.headers.get("retry-after") === "30", `…nothing listening: 503 all the same (${gone.status})`);
  assert(AUTH_JWKS_URL === "http://auth.ob1.internal.:3000/auth/jwks" && JWKS_CACHE_MAX_AGE_MS === 600_000 && JWKS_COOLDOWN_MS === 30_000,
    "a deploy reads the authorization server's key set on the mesh, kept for the access tokens' 600 s, with 30 s between reads");
  answer = async () => ok({});
}

console.log("\n[6] Inputs are the tool's schema; a refused one names the field, never its value");
{
  calls.length = 0;
  let r = await json(await hit("/v1/changes?limit=5&actions=capture", { key: "read-raw" }));
  const parsed = calls[0]?.input as Record<string, unknown> | undefined;
  assert(r.status === 200 && parsed?.limit === 5 && JSON.stringify(parsed?.actions) === '["capture"]' && parsed?.others_only === false && Object.keys(parsed).length === 3,
    `the query is parsed by the schema, defaults applied (${JSON.stringify(parsed)})`);
  r = await json(await hit("/v1/changes?limit=900", { key: "read-raw" }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT" && (r.body.issues as { path: string }[])[0]?.path === "limit", `an out-of-range limit is refused at its field (${JSON.stringify(r.body)})`);
  r = await json(await hit("/v1/search", { key: "read-raw", method: "POST", body: JSON.stringify({ query: "q", limt: 5 }) }));
  assert(r.status === 400 && JSON.stringify(r.body).includes("limt"), `an unknown field is refused, not ignored (${JSON.stringify(r.body)})`);
  const secret = "a-secret-sentence-from-the-thought";
  r = await json(await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: 5, source: secret }) }));
  assert(r.status === 400 && !JSON.stringify(r.body).includes(secret), `a refused value is not echoed (${JSON.stringify(r.body).slice(0, 160)})`);
  r = await json(await hit("/v1/thoughts/abc", { key: "write-raw", method: "PATCH", body: JSON.stringify({ id: "other", content: "x" }) }));
  assert(r.status === 400 && (r.body.issues as { path: string }[])[0]?.path === "id", "a body that names the path's field is refused");
  r = await json(await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: "{not json" }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT", "a body that is not JSON is refused");
  r = await json(await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: "[1]" }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT", "a body that is not an object is refused");
  calls.length = 0;
  await hit("/v1/thoughts/the-id", { key: "write-raw", method: "PATCH", body: JSON.stringify({ content: "x" }) });
  assert((calls[0]?.input as { id?: string })?.id === "the-id", "the path's field fills the input");
}

console.log("\n[7] A refusal answers its code, its status and its declared facts; a fault FAILED 500");
{
  answer = async () => refuse({ code: "REFUSED_STALE_READ", retryable: false, id: "x", currentUpdatedAt: "2026-10-02T00:00:00.000Z" });
  let r = await json(await hit("/v1/thoughts/x", { key: "write-raw", method: "PATCH", body: JSON.stringify({ content: "y" }) }));
  assert(r.status === 409 && JSON.stringify(r.body) === JSON.stringify({ code: "REFUSED_STALE_READ", retryable: false, currentUpdatedAt: "2026-10-02T00:00:00.000Z" }), `409 with the code and the declared facts (${JSON.stringify(r.body)})`);
  answer = async () => refuse({ code: "REFUSED_SUPERSEDES_SHAPE", retryable: false, value: "x".repeat(10_000), orNull: false });
  r = await json(await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "y" }) }));
  assert(r.status === 400 && JSON.stringify(r.body).length < 100, `the caller's raw input is not echoed (${JSON.stringify(r.body).length} chars)`);
  answer = async () => refuse({ code: "EMBEDDING_NOT_ATTACHED", retryable: true, id: "saved-id", detail: "the store's own words" });
  const created = await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "y" }) });
  const cb = await created.json() as Record<string, unknown>;
  assert(created.status === 201 && JSON.stringify(cb) === JSON.stringify({ id: "saved-id", embeddingAttached: false }) && created.headers.get("location") === "/v1/thoughts/saved-id", `a save whose vector did not attach is a creation, flagged (${created.status} ${JSON.stringify(cb)})`);
  answer = async () => ok({ id: "new-id", reader: true, embeddings: { allowed: true, reason: "allowed" } });
  const made = await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "y" }) });
  const mb = await made.json() as Record<string, unknown>;
  assert(made.status === 201 && mb.embeddingAttached === true && made.headers.get("location") === "/v1/thoughts/new-id", "a capture is 201 with its Location, its vector attached");
  answer = async () => ok({ id: "bare-id", reader: true, embeddings: { allowed: false, reason: "refused: deny" } });
  const bare = await (await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "y" }) })).json() as Record<string, unknown>;
  assert(bare.embeddingAttached === false, `a capture whose embedding the gate refused is saved without a vector, and says so (${bare.embeddingAttached})`);
  // The call allowed and made, and the provider did not answer it (SMD-2888):
  // saved without a vector all the same — a reader told why and where, a
  // capture key the word alone, never the endpoint.
  const awayValue = { id: "away-id", reader: true, tags: { type: "observation" }, chunks: 0, contextFailures: 0, headWindow: null, recapture: null,
    embeddings: { allowed: true, reason: "allowed" }, chat: { allowed: true, reason: "allowed", base: "http://ollama:11434/v1" },
    vectorFailed: { reason: "provider_unreachable", detail: "the connection was refused", base: "http://ollama:11434/v1" } };
  answer = async () => ok(awayValue);
  const away = await (await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "y" }) })).json() as Record<string, unknown>;
  assert(away.embeddingAttached === false && JSON.stringify(away.vectorFailed) === JSON.stringify(awayValue.vectorFailed),
    `a capture whose provider did not answer is saved without a vector: embeddingAttached false, and a reader is told why and where (${JSON.stringify(away)})`);
  const awayHook = await (await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "y" }) })).json() as Record<string, unknown>;
  assert(same(awayHook, { id: "away-id", embeddingCall: true, chunks: 0, contextFailures: 0, vectorFailed: "provider_unreachable", embeddingAttached: false }),
    `…a capture key the word alone, no endpoint (${JSON.stringify(awayHook)})`);
  answer = async () => ok({ jobId: "j1", status: "accepted", poll: "/jobs/j1", stream: "/jobs/j1/stream" });
  r = await json(await hit("/v1/scans", { key: "read-raw", method: "POST", body: "{}" }));
  assert(r.status === 202 && r.body.poll === "/v1/jobs/j1" && r.body.stream === "/v1/jobs/j1/stream", `a job's handle points at this server's routes (${JSON.stringify(r.body)})`);
  // Through the proxy's opt-in /api, the prefix Traefik strips comes back on every link.
  const viaApi = await app.fetch(new Request("http://api/v1/scans", { method: "POST", body: "{}", headers: { "x-brain-key": "read-raw", "content-type": "application/json", "x-forwarded-prefix": "/api" } }));
  const vb = await viaApi.json() as Record<string, unknown>;
  assert(vb.poll === "/api/v1/jobs/j1" && vb.stream === "/api/v1/jobs/j1/stream" && viaApi.headers.get("location") === "/api/v1/jobs/j1", `behind /api the handle and Location carry the prefix (${JSON.stringify(vb)})`);
  for (const bad of ["https://evil.example", "//evil", "/api/../x", "/a b", "/" + "x".repeat(10) + "/1/2/3/4"]) {
    const res = await app.fetch(new Request("http://api/v1/scans", { method: "POST", body: "{}", headers: { "x-brain-key": "read-raw", "content-type": "application/json", "x-forwarded-prefix": bad } }));
    assert(((await res.json()) as Record<string, unknown>).poll === "/v1/jobs/j1", `a prefix that is not a plain path (${bad}) moves no link`);
  }
  answer = async () => { throw new Error("connection refused"); };
  r = await json(await hit("/v1/stats", { key: "read-raw" }));
  assert(r.status === 500 && JSON.stringify(r.body) === JSON.stringify({ code: "FAILED", message: "connection refused" }), `a fault is FAILED 500 with no verdict (${JSON.stringify(r.body)})`);
  answer = async () => ok({});
  assert(Object.values(REFUSAL_STATUS).every((s) => s >= 400 && s < 600), "every refusal answers a 4xx or a 5xx");
}

console.log("\n[7b] HEAD answers standing without running the operation; input sent the wrong way is refused; a wrong method is a 405");
{
  calls.length = 0;
  let r = await hit("/v1/thoughts/the-id", { key: "read-raw", method: "HEAD" });
  assert(r.status === 200 && (await r.text()) === "" && calls.length === 0, `HEAD on a GET route is 200 with no body, and the operation does not run (${r.status}, ${calls.length} calls)`);
  assert(r.headers.get("content-type") === "application/json", `…with the GET's content type (${r.headers.get("content-type")})`);
  r = await hit("/v1/thoughts?limit=five", { key: "read-raw", method: "HEAD" });
  assert(r.status === 400 && calls.length === 0, `HEAD checks the input as the GET would (${r.status})`);
  r = await hit("/v1/jobs/j1/stream", { key: "read-raw", method: "HEAD" });
  assert(r.status === 200 && (await r.text()) === "" && r.headers.get("content-type") === "text/event-stream", `HEAD on a job's stream subscribes to nothing (${r.status} ${r.headers.get("content-type")})`);
  // Bun hands a GET's handler no body, whatever was sent; the headers that announced one remain.
  let g = await json(await app.fetch(new Request("http://api/v1/thoughts", { headers: { "x-brain-key": "read-raw", "content-length": "11" } })));
  assert(g.status === 400 && g.body.code === "REFUSED_INPUT", `a GET that announced a body is refused, though the body never arrives (${g.status})`);
  g = await json(await app.fetch(new Request("http://api/v1/thoughts", { headers: { "x-brain-key": "read-raw", "transfer-encoding": "chunked" } })));
  assert(g.status === 400, `…and one sent chunked (${g.status})`);
  g = await json(await app.fetch(new Request("http://api/v1/thoughts", { headers: { "x-brain-key": "read-raw", "content-length": "11, 11" } })));
  assert(g.status === 400, `…and one whose repeated length Bun joined into "11, 11" (${g.status})`);
  g = await json(await app.fetch(new Request("http://api/v1/thoughts", { headers: { "x-brain-key": "read-raw", "content-length": "0" } })));
  assert(g.status === 200, `a GET declaring an empty body is a GET (${g.status})`);
  r = await hit("/v1/stats", { key: "cap-raw", method: "HEAD" });
  assert(r.status === 403, `HEAD keeps the scope's answer (${r.status})`);
  let b = await json(await hit("/v1/search?limit=5", { key: "read-raw", method: "POST", body: JSON.stringify({ query: "q" }) }));
  assert(b.status === 400 && b.body.code === "REFUSED_INPUT", `a POST's query string is refused, not ignored (${b.status})`);
  b = await json(await hit("/v1/thoughts/the-id", { key: "write-raw", method: "DELETE", body: JSON.stringify({ detach_citations: true }) }));
  assert(b.status === 400 && b.body.code === "REFUSED_INPUT", `a DELETE's body is refused, not ignored (${b.status})`);
  b = await json(await hit("/v1/thoughts?__proto__=x", { key: "read-raw" }));
  assert(b.status === 400 && b.body.code === "REFUSED_INPUT", `?__proto__= is refused as an unknown key, not dropped (${b.status})`);
  const put = await hit("/v1/thoughts", { key: "write-raw", method: "PUT" });
  assert(put.status === 405 && put.headers.get("allow") === "GET, HEAD, POST" && (await put.json() as { code: string }).code === "METHOD_NOT_ALLOWED", `PUT on /v1/thoughts is a 405 naming GET, HEAD, POST (${put.status} ${put.headers.get("allow")})`);
  const post = await hit("/v1/jobs/j1", { key: "write-raw", method: "POST" });
  assert(post.status === 405 && post.headers.get("allow") === "GET, HEAD", `POST on a job is a 405 naming GET, HEAD (${post.status} ${post.headers.get("allow")})`);
  b = await json(await hit("/v1/nothing-here", { key: "read-raw" }));
  assert(b.status === 404 && b.body.code === "NO_ROUTE", `a path no route serves is NO_ROUTE (${b.status})`);
}

console.log("\n[7c] A 503 says when to retry; capture's fault is the transient the hook retries; a throw outside an operation is JSON");
{
  answer = async () => refuse({ code: "SUPERSEDES_UNJUDGED", retryable: true, cause: "registry_away" });
  let r = await hit("/v1/thoughts", { key: "write-raw", method: "POST", body: JSON.stringify({ content: "y" }) });
  assert(r.status === 503 && r.headers.get("retry-after") === "2", `a retryable refusal at 503 carries Retry-After (${r.status} ${r.headers.get("retry-after")})`);
  answer = async () => { throw new Error("connection refused"); };
  r = await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "y" }) });
  const cb = await r.json() as Record<string, unknown>;
  assert(r.status === 503 && r.headers.get("retry-after") === "2" && same(cb, { code: "STORE_UNAVAILABLE", retryable: true, message: "connection refused" }), `capture's fault is STORE_UNAVAILABLE, retryable, as the MCP tool says it (${r.status} ${JSON.stringify(cb)})`);
  const other = await json(await hit("/v1/stats", { key: "read-raw" }));
  assert(other.status === 500 && other.body.code === "FAILED" && !("retryable" in other.body), "…while another operation's fault stays FAILED with no verdict");
  answer = async () => ok({});
  resolveThrows = true;
  const thrown = await hit("/v1/stats", { key: "read-raw" });
  resolveThrows = false;
  assert(thrown.status === 500 && /application\/json/.test(thrown.headers.get("content-type") ?? "") && (await thrown.json() as { code: string }).code === "FAILED", `a throw outside an operation is a JSON FAILED (${thrown.status} ${thrown.headers.get("content-type")})`);
}

console.log("\n[7d] The served OpenAPI document names its base as the caller reached it");
{
  const served = async (prefix?: string) => (await (await app.fetch(new Request("http://api/openapi.json", { headers: prefix ? { "x-forwarded-prefix": prefix } : {} }))).json() as { servers?: { url: string }[] }).servers;
  assert(same(await served(), [{ url: "/" }]) && same(await served("/api"), [{ url: "/api" }]), "the served document names its base: the root on the mesh, /api behind the proxy's route");
}

console.log("\n[7e] The door hands the core why a key has no agent id, which a capture key's supersedes reads (SMD-2473)");
{
  // capture() offers the retry only to `unreachable` and drops the pointer
  // otherwise; a door that lost the reason would drop it while the registry
  // may still answer (review pass 4: no test held the REST door's).
  answer = async () => ok({});
  for (const unresolved of ["unreachable", "misconfigured", "refused"] as const) {
    identity = { status: "ok", unresolved };
    calls.length = 0;
    await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "z", supersedes: "00000000-0000-4000-8000-000000000001" }) });
    const got = calls.at(-1)?.principal;
    assert(got?.agentId === undefined && got?.agentUnresolved === unresolved, `a registry ${unresolved} reaches the core on the principal (${got?.agentUnresolved})`);
  }
  identity = { status: "ok", agentId: "agent-1" };
}

console.log("\n[8] One JSON line per request (telemetry.ts, SMD-1849): method, route, operation, key name, status, time — no query, key, id or content");
{
  lines.length = 0;
  await hit("/v1/thoughts/9f0c1e2a-0000-4000-8000-00000000abcd?x=1", { key: "read-raw" });
  await hit("/v1/changes?agent=someone-secret", { key: "read-raw" });
  await hit("/v1/search", { key: "write-raw", method: "POST", body: JSON.stringify({ query: "the private query" }) });
  await hit("/nope");
  await hit("/health");
  await hit("/v1/thoughts", { key: "not-a-key" });
  assert(lines.length === 5, `five requests, five lines — the liveness probe's 200 is not one (${lines.length})`);
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const [fetched, , searched, unrouted, unkeyed] = parsed;
  assert(fetched?.door === "api" && fetched.method === "GET" && fetched.route === "/v1/thoughts/:id" && fetched.tool === "fetch" && fetched.agent === "r"
    && typeof fetched.status === "number" && typeof fetched.ms === "number" && typeof fetched.ts === "string",
    `the route's template, not its id, with its operation and the key's name (${lines[0]})`);
  assert(same(Object.keys(fetched ?? {}), ["ts", "door", "method", "route", "tool", "agent", "status", "outcome", "code", "ms"]) && fetched?.status === 400 && fetched.outcome === "refused" && fetched.code === "REFUSED_INPUT",
    `those keys and no other, in order, a 4xx \`refused\` with its answer's code (${lines[0]})`);
  assert(!("code" in (parsed[1] ?? {})) && parsed[1]?.status === 200 && parsed[1].outcome === "ok", `a success is \`ok\` and carries no code (${lines[1]})`);
  assert(searched?.tool === "search_thoughts" && searched.agent === "w", `the search is its operation and its key's name (${lines[2]})`);
  const all = lines.join("\n");
  for (const s of ["9f0c1e2a", "someone-secret", "private query", "read-raw", "write-raw", "not-a-key", "x=1"]) assert(!all.includes(s), `no ${s} in the log`);
  assert(unrouted?.status === 404 && unrouted.code === "NO_ROUTE" && !("route" in unrouted) && !("tool" in unrouted) && !("agent" in unrouted), `an unrouted request is logged without its path (${lines[3]})`);
  assert(unkeyed?.status === 401 && unkeyed.code === "UNAUTHORIZED" && unkeyed.tool === "list_thoughts" && !("agent" in unkeyed), `a key that does not authenticate names no one, and says why (${lines[4]})`);
  // A revoked key is a 401 too: the code tells the two apart, and the key's name is said.
  lines.length = 0;
  identity = { status: "revoked", agentId: "agent-1", revokedAt: "2026-10-08T00:00:00.000Z", reason: null };
  await hit("/v1/thoughts", { key: "read-raw" });
  identity = { status: "ok", agentId: "agent-1" };
  const revoked = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(revoked.status === 401 && revoked.code === "REVOKED" && revoked.agent === "r", `a revoked key: 401 REVOKED, by its name (${lines[0]})`);
  // A 503 that refuses for now is `refused`, as the MCP server says it — not a fault.
  lines.length = 0;
  identity = { status: "busy" };
  await hit("/v1/thoughts", { key: "read-raw" });
  identity = { status: "ok", agentId: "agent-1" };
  const busy = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(busy.status === 503 && busy.code === "BUSY" && busy.outcome === "refused", `a busy registry: 503 BUSY \`refused\`, not \`error\` (${lines[0]})`);

  // A fault is `error`; a client that hangs up mid-body is `abandoned`, not the
  // 500 its cut-off read becomes — no one received it, and it is no fault.
  lines.length = 0;
  const realAnswer = answer;
  answer = async () => { throw new Error("the store fell over"); };
  await hit("/v1/stats", { key: "read-raw" });
  answer = realAnswer;
  const faulted = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(faulted.status === 500 && faulted.outcome === "error" && faulted.code === "FAILED", `a fault: 500 \`error\` FAILED (${lines[0]})`);
  // Each error answer's code is on its line, set where it is answered (SMD-1849 PR 2c review pass 1: errorCode read
  // every one back from the answer before, and nothing held the sites that now set it): a capture's fault, a job
  // stream's refusal as a value, and onError's.
  lines.length = 0;
  answer = async () => { throw new Error("connection refused"); };
  await hit("/v1/thoughts", { key: "cap-raw", method: "POST", body: JSON.stringify({ content: "y" }) });
  answer = realAnswer;
  await hit(`/v1/jobs/${crypto.randomUUID()}/stream`, { key: "read-raw" });
  const onErrorLines: string[] = [];
  const keysUnread = createRestApp({ core, init: () => {}, keys: () => { throw new Error("the keys are unreadable"); }, resolve: async () => identity, track: (run) => run(), log: (l) => onErrorLines.push(l) });
  const onErrorAnswer = await keysUnread.fetch(new Request("http://api/v1/whoami", { headers: { "x-brain-key": "read-raw" } }));
  const [storeDown, noJob] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const onErrorLine = JSON.parse(onErrorLines[0] ?? "{}") as Record<string, unknown>;
  assert(storeDown?.status === 503 && storeDown.code === "STORE_UNAVAILABLE" && noJob?.status === 404 && noJob.code === "NOT_FOUND"
    && onErrorAnswer.status === 500 && onErrorLine.status === 500 && onErrorLine.code === "FAILED" && onErrorLine.outcome === "error",
    `each answer's code on its line: a capture's fault STORE_UNAVAILABLE, no such job NOT_FOUND, onError's FAILED (${[...lines, ...onErrorLines].join(" / ")})`);
  lines.length = 0;
  const hangUp = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{\"query\":\"cut")); setTimeout(() => { hangUp.abort(); c.error(new Error("the client hung up")); }, 20); } });
  await app.fetch(new Request("http://api/v1/search", { method: "POST", body, signal: hangUp.signal, headers: { "x-brain-key": "write-raw", "content-type": "application/json" }, duplex: "half" } as RequestInit));
  const hungUp = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(hungUp.outcome === "abandoned" && !("code" in hungUp) && hungUp.tool === "search_thoughts" && hungUp.agent === "w",
    `a client that hangs up mid-body: \`abandoned\`, no code, not a fault (${lines[0]})`);

  // A job's stream is timed to its end, not its opening (SMD-1849 PR 2a): its
  // line waits for the stream to close, and carries the bytes it sent.
  lines.length = 0;
  const { startJob } = await import("./jobs.ts");
  const handle = startJob({ keyHash: hashKey("read-raw"), name: "r", scope: "read" } as Principal, "scan_thoughts", async () => { await Bun.sleep(120); return { done: true }; });
  const streamed = await app.fetch(new Request(`http://api/v1/jobs/${handle.jobId}/stream`, { headers: { "x-brain-key": "read-raw" } }));
  const linesWhileOpen = lines.length;
  const streamText = await streamed.text();
  await Bun.sleep(20);
  const jobLine = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(linesWhileOpen === 0 && lines.length === 1 && jobLine.route === "/v1/jobs/:job_id/stream" && jobLine.tool === "job_status" && jobLine.agent === "r" && jobLine.outcome === "ok"
    && (jobLine.ms as number) >= 60 && jobLine.bytes === new TextEncoder().encode(streamText).byteLength,
    `a job stream's one line is written at its end, with its time and bytes, not as it opens (${linesWhileOpen} while open; ${lines[0]})`);

  // A job stream whose client is gone — before the route listens, mid-stream,
  // or by letting go of the body with no abort (a runtime whose signal never aborts) — is one
  // `abandoned` line, and leaves no record open (review pass 1: two of these
  // stayed open until a stop wrote them `cut`, or forever).
  const { openRequestCount, cutOpenRequests } = await import("./telemetry.ts");
  const openBefore = openRequestCount();
  const slowJob = () => startJob({ keyHash: hashKey("read-raw"), name: "r", scope: "read" } as Principal, "scan_thoughts", async () => { await Bun.sleep(400); return { done: true }; });
  const streamOf = (id: string, signal?: AbortSignal) => Promise.resolve(app.fetch(new Request(`http://api/v1/jobs/${id}/stream`, { headers: { "x-brain-key": "read-raw" }, signal })));
  // Each way alone: the line is read right after its own trigger, before the
  // body's cancel (which would end the record too) comes, outside the count.
  const lineAfter = async (trigger: () => Promise<unknown>) => {
    lines.length = 0;
    await trigger();
    await Bun.sleep(20);
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const preGone = new AbortController();
  preGone.abort();
  let preBody: ReadableStream | null = null;
  const pre = await lineAfter(async () => { preBody = (await streamOf(slowJob().jobId, preGone.signal)).body; });
  const midGone = new AbortController();
  let midReader: ReadableStreamDefaultReader | null = null;
  const mid = await lineAfter(async () => {
    midReader = (await streamOf(slowJob().jobId, midGone.signal)).body!.getReader();
    await midReader.read();
    midGone.abort();
  });
  const letGo = await lineAfter(async () => {
    const reader = (await streamOf(slowJob().jobId)).body!.getReader();
    await reader.read();
    await reader.cancel();
  });
  const late = await lineAfter(async () => {
    await (preBody as ReadableStream | null)?.cancel().catch(() => {});
    await (midReader as ReadableStreamDefaultReader | null)?.cancel().catch(() => {});
    await Bun.sleep(600); // past every job's end
  });
  const each = [pre, mid, letGo];
  assert(each.every((g) => g.length === 1 && g[0]?.outcome === "abandoned" && g[0].route === "/v1/jobs/:job_id/stream" && g[0].tool === "job_status") && late.length === 0 && openRequestCount() === openBefore,
    `a job stream left before it listens, by its abort mid-stream, or by its body alone: one \`abandoned\` line each, written then, none later, none left open (${openRequestCount() - openBefore} open; ${JSON.stringify(each.map((g) => g.map((l) => l.outcome)))}; ${late.length} late)`);

  // A request held at the registry when the stop cuts it carries the route its
  // handler named as it started — whoami's, and the job stream's with its
  // operation (the middleware's own naming comes only after the answer, so a
  // refusal's line could not show this: review pass 5).
  lines.length = 0;
  let release = () => {};
  resolveGate = new Promise<void>((r) => { release = r; });
  try {
    const held = [
      app.fetch(new Request("http://api/v1/whoami", { headers: { "x-brain-key": "read-raw" } })),
      app.fetch(new Request(`http://api/v1/jobs/${crypto.randomUUID()}/stream`, { headers: { "x-brain-key": "read-raw" } })),
    ];
    await Bun.sleep(20);
    cutOpenRequests();
    release();
    await Promise.all(held.map((h) => Promise.resolve(h).then((r) => r.text())));
  } finally {
    release();
    resolveGate = null;
  }
  const heldCut = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.outcome === "cut");
  const cutWhoami = heldCut.find((l) => l.route === "/v1/whoami");
  const cutStream = heldCut.find((l) => l.route === "/v1/jobs/:job_id/stream");
  assert(heldCut.length === 2 && cutWhoami !== undefined && cutStream?.tool === "job_status" && lines.length === 2,
    `whoami and a job stream cut at the registry: one \`cut\` line each with the route its handler named (the stream's operation too), and none when they later answer (${lines.join(" / ")})`);
  // A client that left while its request waited is `abandoned` at the cut, as
  // the MCP endpoint says of its own (review pass 7: it read `cut`, status 0).
  lines.length = 0;
  resolveGate = new Promise<void>((r) => { release = r; });
  try {
    const leaving = new AbortController();
    const left = app.fetch(new Request("http://api/v1/whoami", { headers: { "x-brain-key": "read-raw" }, signal: leaving.signal }));
    await Bun.sleep(20);
    leaving.abort();
    cutOpenRequests();
    release();
    await Promise.resolve(left).then((r) => r.text()).catch(() => {});
  } finally {
    release();
    resolveGate = null;
  }
  const leftCut = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(lines.length === 1 && leftCut.outcome === "abandoned" && leftCut.status === 0 && leftCut.route === "/v1/whoami",
    `a client gone while its request waited at the registry, then the stop's cut: one \`abandoned\` line, status 0 (${lines.join(" / ")})`);

  // An environment that will not seed is a 500 with its line, not a silent one.
  const initFails: string[] = [];
  const brokenInit = createRestApp({ core, init: () => { throw new Error("OB1_TIER is not a tier"); }, keys: () => ({}), resolve: async () => identity, track: (run) => run(), log: (l) => initFails.push(l) });
  const initAnswer = await brokenInit.fetch(new Request("http://api/openapi.json"));
  const initLine = JSON.parse(initFails[0] ?? "{}") as Record<string, unknown>;
  assert(initAnswer.status === 500 && initFails.length === 1 && initLine.status === 500 && initLine.outcome === "error" && initLine.code === "FAILED", `an init that throws: the 500 has its line, FAILED as its answer says (${initFails[0]})`);

  // A path the `*` middleware never matches (an encoded line break) still has its line, from notFound (review pass 3).
  lines.length = 0;
  const unmatched = await app.fetch(new Request("http://api/health%0A"));
  const unmatchedLine = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(unmatched.status === 404 && lines.length === 1 && unmatchedLine.status === 404 && unmatchedLine.outcome === "refused" && unmatchedLine.code === "NO_ROUTE",
    `a path with an encoded line break: one 404 NO_ROUTE line (${lines.join(" / ")})`);
  // The liveness probe — no key — has no record at all; a keyed /health is a
  // request like any other, its line naming the route and the tool (SMD-2287).
  lines.length = 0;
  const probesBefore = openRequestCount();
  await app.fetch(new Request("http://api/health"));
  await app.fetch(new Request("http://api/health", { method: "HEAD" }));
  assert(lines.length === 0 && openRequestCount() === probesBefore, `keyless GET and HEAD /health: no line, no record (${lines.length} lines)`);
  await app.fetch(new Request("http://api/health", { headers: { "x-brain-key": "cap-raw" } }));
  const keyedHealth = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(lines.length === 1 && keyedHealth.route === "/health" && keyedHealth.tool === "brain_info" && keyedHealth.outcome === "refused",
    `a keyed /health its key may not read: one line, refused (${lines.join(" / ")})`);
  lines.length = 0;
  // Any other method there is no probe: its 405 is logged (review pass 4).
  await app.fetch(new Request("http://api/health", { method: "POST" }));
  const postHealth = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert(lines.length === 1 && postHealth.status === 405 && postHealth.code === "METHOD_NOT_ALLOWED", `a POST to /health: its 405 logged (${lines.join(" / ")})`);
}

console.log("\n[9] A request URL that will not parse — Bun builds it from the Host header unchecked — still has its query read: a refusal, not a 500 (SMD-2535)");
{
  // api.ts rebuilds such a request before routing (auth.ts routable); the
  // app reads its query without parsing the URL all the same, with a path
  // Hono reads from the string as it would.
  for (const host of ["x:99999", "[::1", "brain.example.test:abc"]) {
    const r = await json(await app.fetch(new RuntimeUrl(`http://${host}/v1/thoughts?limit=x`, { headers: { "x-brain-key": "read-raw" } })));
    const issues = (r.body.issues ?? []) as { path: string }[];
    assert(r.status === 400 && r.body.code === "REFUSED_INPUT" && issues[0]?.path === "limit", `Host ${host}: GET /v1/thoughts?limit=x → 400 naming limit (${r.status} ${JSON.stringify(r.body).slice(0, 80)})`);
  }
}

console.log("\n[10] The Chrome capture extension's client speaks this server: the key check, the capture, a queued payload of the retired gateway's shape (SMD-1931)");
{
  // The extension's own files, run as its service worker runs them (classic
  // scripts on one global), with fetch routed to this app — so its requests
  // are parsed by the same schema and ladder as any caller's.
  const dir = new URL("../integrations/chrome-capture-extension/lib/", import.meta.url);
  // chrome.storage, as an install that saved its settings before the REST core left them.
  const area = (data: Record<string, unknown>) => ({
    data,
    get: async (defaults: Record<string, unknown>) => Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, k in data ? data[k] : d])),
    set: async (items: Record<string, unknown>) => { Object.assign(data, items); },
    remove: async (key: string) => { delete data[key]; },
  });
  const storage = {
    sync: area({ ob_capture_settings: { apiEndpoint: "https://brain.example.com/functions/v1", enabledPlatforms: { claude: true } } }),
    local: area({ ob_capture_api_key: "cap-raw", ob_capture_api_endpoint: "https://brain.example.com" }),
  };
  const sandbox: Record<string, unknown> = {
    fetch: (url: string, init: RequestInit) => new URL(url).host === "mcp"
      // The MCP endpoint answers a non-JSON-RPC POST with a JSON-RPC error — no REST refusal code.
      ? Promise.resolve(Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, { status: 400 }))
      : app.fetch(new Request(url, init)),
    setTimeout, clearTimeout, AbortController, console,
    chrome: { storage },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const { createContext, runInContext } = await import("node:vm");
  const ctx = createContext(sandbox);
  for (const f of ["config.js", "api-client.js"]) runInContext(await Bun.file(new URL(f, dir)).text(), ctx, { filename: f });
  type Client = {
    apiFetch: (path: string, o: { apiKey: string; endpoint: string; method?: string; body?: unknown }) => Promise<unknown>;
    failureKind: (e: unknown) => string;
    retryPlan: (attempts: number, kind: string, max: number) => { attempts: number; delayMinutes: number; deadLetter: boolean };
    describeFailure: (e: unknown, atSave?: boolean) => string;
    verifyForSave: (current: Record<string, string>, next: Record<string, string>) => Promise<{ warning?: string }>;
    healthCheck: (o: { apiKey: string; endpoint: string }) => Promise<Record<string, unknown>>;
    ingestDocument: (payload: unknown, o: { apiKey: string; endpoint: string }) => Promise<Record<string, unknown>>;
    toCapture: (payload: unknown) => { content: string; source: string; trust: string; metadata: Record<string, unknown> };
  };
  const client = sandbox.OBApiClient as Client;
  const at = { endpoint: "http://api/" };

  identity = { status: "ok", agentId: "agent-1" };
  const who = await client.healthCheck({ apiKey: "cap-raw", ...at });
  assert(who.scope === "capture" && (who.operations as string[]).includes("capture_thought"), `a capture key passes the key check through GET /v1/whoami (${JSON.stringify(who)})`);
  let readRefused = "";
  try { await client.healthCheck({ apiKey: "read-raw", ...at }); } catch (e) { readRefused = (e as Error).message; }
  assert(/cannot capture/.test(readRefused), `a read key is told it cannot capture (${readRefused})`);
  let wrongRefused = "";
  try { await client.healthCheck({ apiKey: "wrong", ...at }); } catch (e) { wrongRefused = (e as Error).message; }
  assert(/HTTP 401: UNAUTHORIZED/.test(wrongRefused), `a wrong key is the server's 401, with its code (${wrongRefused})`);

  // A payload as the extension has always queued it — a retry queued before
  // this release is sent the same way.
  const longUrl = `https://claude.ai/chat/${"x".repeat(300)}`;
  const queued = {
    text: "Decided to keep the capture key scoped to capture.",
    source_label: "claude:sync",
    source_type: "claude_import",
    auto_execute: true,
    source_metadata: { conversation_id: "c-1", conversation_title: "T".repeat(250), page_url: longUrl, capture_mode: "sync", export_tool: "open_brain_capture_extension_sync", extension_platform: "claude", content_fingerprint: "f".repeat(64), nested: { a: 1 } },
  };
  calls.length = 0;
  answer = async () => ok({ id: "11111111-1111-4111-8111-111111111111", existed: false, embeddings: { allowed: true }, chunks: 0, contextFailures: 0 });
  const sent = await client.ingestDocument(queued, { apiKey: "cap-raw", ...at });
  const input = calls[0]?.input as { content: string; source: string; trust: string; metadata: Record<string, unknown> } | undefined;
  assert(calls.length === 1 && calls[0].name === "capture" && sent.status === "captured" && sent.id === "11111111-1111-4111-8111-111111111111",
    `the queued payload is one capture through POST /v1/thoughts, and the answer says captured (${JSON.stringify(sent)})`);
  assert(input?.content === queued.text && input.source === "chrome-claude" && input.trust === "ingested", `content, source and trust as capture_thought takes them (${JSON.stringify({ source: input?.source, trust: input?.trust })})`);
  const meta = input?.metadata ?? {};
  assert(Object.keys(meta).length <= META_KEYS_MAX && Object.values(meta).every((v) => typeof v !== "object") && !("page_url" in meta) && !("nested" in meta) && String(meta.conversation_title).length === 200 && meta.source_type === "claude_import" && meta.extension_platform === "claude",
    `metadata within capture_thought's bounds: a long URL left out, not cut; a long title cut; nothing nested (${JSON.stringify(Object.keys(meta))})`);
  // The core tells only a key that can read whether the text existed
  // (core/writes.ts: `existed` is the reader's), so the stub answers as it does.
  answer = async () => ok({ id: "11111111-1111-4111-8111-111111111111", ...(calls.at(-1)?.principal.scope === "write" ? { existed: true } : {}), embeddings: { allowed: false }, chunks: 0, contextFailures: 0 });
  const againCap = await client.ingestDocument(queued, { apiKey: "cap-raw", ...at });
  assert(againCap.status === "captured" && !("existed" in againCap), `a capture key's re-capture is reported captured — the brain does not tell it the text existed (${againCap.status})`);
  const againWrite = await client.ingestDocument(queued, { apiKey: "write-raw", ...at });
  assert(againWrite.status === "existing", `a write key's re-capture answers existing, as the extension counts a skip (${againWrite.status})`);
  // A platform the label alone names, and none at all.
  assert(client.toCapture({ text: "x", source_label: "gemini:manual" }).source === "chrome-gemini", "a payload without a platform takes it from its label");
  assert(client.toCapture({ text: "x" }).source === "chrome-extension", "…and with neither, the extension's own label");
  // An install upgraded from the gateway's release starts unconfigured: the
  // URL it saved named the retired gateway, so it is not read, the legacy
  // sync copy is cleared, and the retry queue waits for the new URL instead
  // of dead-lettering on a 404.
  const config = sandbox.OBConfig as { getConfig: () => Promise<{ apiEndpoint: string; apiKey: string }>; isConfigured: (c: unknown) => boolean };
  const upgraded = await config.getConfig();
  assert(upgraded.apiEndpoint === "" && upgraded.apiKey === "cap-raw" && !config.isConfigured(upgraded), `an upgraded install keeps its key and reads no endpoint, so it is unconfigured (${JSON.stringify(upgraded)})`);
  assert((storage.sync.data.ob_capture_settings as { apiEndpoint?: string }).apiEndpoint === "" && !("ob_capture_rest_core_endpoint" in storage.local.data), "…the legacy sync endpoint is cleared, never carried into the new key");
  assert(!("ob_capture_api_endpoint" in storage.local.data), "…and the old local key is removed");
  const kind = (e: unknown) => client.failureKind(e);
  assert(kind({ status: 400, code: "REFUSED_METADATA_SHAPE" }) === "refused" && kind({ status: 409, code: "REFUSED_STALE_READ" }) === "refused" && kind({ status: 413 }) === "refused",
    "the REST core's refusal of the capture, or its size, is refused: rejected, not retried");
  assert(["", "NO_ROUTE", "METHOD_NOT_ALLOWED"].every((code) => kind({ status: 404, code }) === "setup") && kind({ status: 406 }) === "setup" && kind({ status: 401, code: "UNAUTHORIZED" }) === "setup" && kind({ status: 403, code: "FORBIDDEN" }) === "setup",
    "an answer that is not the REST core's, a path it does not serve, or a refused key is setup: the capture waits");
  assert(kind({ status: 429 }) === "transient" && kind({ status: 503, code: "BUSY" }) === "transient" && kind({ message: "Request timed out" }) === "transient", "a 429, a 5xx or a timeout is transient");
  assert(kind({ status: 403, code: "REFUSED_EGRESS" }) === "refused" && kind({ status: 404, code: "NOT_FOUND" }) === "setup" && kind({ status: 405, code: "SOMETHING" }) === "setup",
    "the egress gate's 403 refuses the capture; a 404 or 405 is the path's fault whatever code another server puts on it");
  let noKey: unknown = null;
  try { await client.ingestDocument(queued, { apiKey: "", ...at }); } catch (e) { noKey = e; }
  let noUrl: unknown = null;
  try { await client.ingestDocument(queued, { apiKey: "cap-raw", endpoint: "" }); } catch (e) { noUrl = e; }
  assert(kind(noKey) === "setup" && kind(noUrl) === "setup", "a missing key or URL is setup: the capture waits for it");
  // A bare origin reaches the MCP server's root: its JSON-RPC 400 is setup, not a refusal of the capture.
  let bare: unknown = null;
  try { await client.ingestDocument(queued, { apiKey: "cap-raw", endpoint: "http://mcp/" }); } catch (e) { bare = e; }
  assert(bare !== null && kind(bare) === "setup" && /did not answer as the brain's REST core \(HTTP 400\)/.test(client.describeFailure(bare)),
    `a capture sent to the MCP endpoint's origin is a setup failure, told so (${bare ? client.describeFailure(bare) : "no error"})`);
  const setup = client.retryPlan(4, "setup", 5), transient = client.retryPlan(3, "transient", 5), last = client.retryPlan(4, "transient", 5);
  assert(setup.attempts === 4 && !setup.deadLetter && transient.attempts === 4 && transient.delayMinutes === 8 && !transient.deadLetter && last.deadLetter,
    `a setup failure waits without spending an attempt; a transient one backs off and is dead-lettered at the limit (${JSON.stringify({ setup, transient, last })})`);
  // A new URL or key is checked before it is saved; a toggle-only save is not.
  const good = { apiEndpoint: "http://api/", apiKey: "cap-raw" };
  const notSaved = async (next: Record<string, string>, current: Record<string, string> = { apiEndpoint: "", apiKey: "" }) => { try { await client.verifyForSave(current, next); return ""; } catch (e) { return (e as Error).message; } };
  assert(await notSaved(good) === "", "a URL and key that reach the REST core and can capture are saved");
  const atSave = client.describeFailure(bare, true);
  assert(!/captures wait/.test(atSave) && /captures wait/.test(client.describeFailure(bare)) && /HTTP 400: Invalid Request/.test(atSave), `at save the words promise no wait, and the server's answer is kept (${atSave})`);
  answer = async () => { throw new Error("unused"); };
  identity = { status: "busy" } as unknown as AgentOutcome;
  const busy = await client.verifyForSave({ apiEndpoint: "", apiKey: "" }, good);
  assert(/^Saved, but the brain did not answer/.test(busy.warning ?? ""), `a brain that is busy at the check lets the setting save, with a warning (${JSON.stringify(busy)})`);
  identity = { status: "ok", agentId: "agent-1" };
  assert(/^Not saved: This URL did not answer as the brain's REST core \(HTTP 400\)/.test(await notSaved({ apiEndpoint: "http://mcp/", apiKey: "cap-raw" })), "a bare origin (the MCP endpoint's) is not saved, and the user is told why");
  assert(/^Not saved: .*cannot capture/.test(await notSaved({ apiEndpoint: "http://api/", apiKey: "read-raw" })), "a key that cannot capture is not saved");
  calls.length = 0;
  assert(await notSaved({ apiEndpoint: "http://mcp/", apiKey: "cap-raw" }, { apiEndpoint: "http://mcp/", apiKey: "cap-raw" }) === "", "a save that changes neither URL nor key (a platform toggle) is not checked");

  // Metadata: the brain's own keys are dropped, every one the server refuses
  // (RESERVED_META, and a capture key's ticket keys); a manual capture's mode
  // is kept; a platform's own keys fill the room left; a cut never splits a
  // surrogate pair; the eight-key bound holds.
  const reservedAll = [...RESERVED_META, ...TICKET_META_KEYS];
  const dropped = client.toCapture({ text: "x", source_metadata: Object.fromEntries(reservedAll.map((k) => [k, "v"])) }).metadata;
  assert(reservedAll.every((k) => !(k in dropped)), `none of the server's ${reservedAll.length} reserved keys is sent (${JSON.stringify(Object.keys(dropped))})`);
  const gemini = client.toCapture({ text: "x", source_type: "gemini_manual", source_metadata: { extension_capture_mode: "manual", extension_platform: "gemini", content_fingerprint: "f", gemini_conversation_id: "g-1", gemini_response_id: "r-1", gemini_model: "m", page_title: "a".repeat(199) + "\u{1F600}" } }).metadata;
  assert(gemini.capture_mode === "manual" && !("extension_capture_mode" in gemini) && gemini.gemini_conversation_id === "g-1" && gemini.gemini_response_id === "r-1" && gemini.gemini_model === "m",
    `a manual capture keeps its mode, and Gemini's own ids are kept (${JSON.stringify(Object.keys(gemini))})`);
  const title = String(gemini.page_title);
  assert(title.length === 199 && !/[\uD800-\uDBFF]$/.test(title), `a value cut at the bound never ends in half a surrogate pair (${title.length})`);
  const many = client.toCapture({ text: "x", source_metadata: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`extra_${i}`, i])) }).metadata;
  assert(Object.keys(many).length === META_KEYS_MAX, `at most ${META_KEYS_MAX} keys (${Object.keys(many).length})`);

  // A refusal is told with the facts that say why.
  const told = async (run: () => Promise<unknown>) => { try { await run(); return ""; } catch (e) { return (e as Error).message; } };
  answer = async () => refuse({ code: "REFUSED_METADATA_SHAPE", retryable: false, problem: "reserved_key", key: "type" });
  const shape = await told(() => client.ingestDocument(queued, { apiKey: "cap-raw", ...at }));
  assert(/HTTP 400: REFUSED_METADATA_SHAPE — reserved_key \(type\)/.test(shape), `a metadata refusal names its problem and key (${shape})`);
  let refusedErr: unknown = null;
  try { await client.ingestDocument(queued, { apiKey: "cap-raw", ...at }); } catch (e) { refusedErr = e; }
  assert(refusedErr !== null && client.failureKind(refusedErr) === "refused", "…and, read from the REST core's answer, it is a refusal of the capture: rejected, not queued");
  const scope = await told(() => client.apiFetch("/v1/stats", { apiKey: "cap-raw", ...at }));
  assert(/HTTP 403: FORBIDDEN — needs a read key/.test(scope), `a scope refusal names the scope it needs (${scope})`);
  const inputTold = await told(() => client.apiFetch("/v1/thoughts", { apiKey: "cap-raw", ...at, method: "POST", body: {} }));
  assert(/HTTP 400: REFUSED_INPUT — content: /.test(inputTold), `an input refusal names its field (${inputTold})`);
  answer = async () => ok({});
}

console.log("\n[11] `bun api.ts` stopped with a search in flight: the stop's bound cuts it, and its line is written as `cut` before the exit (SMD-1849 PR 2a)");
{
  // A provider that answers no embedding for 5 s, so the search is in flight
  // when the stop's bound (OB1_STOP_GRACE=3: 1 s) cuts it.
  const slow = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(5_000); return Response.json({ data: [{ embedding: [0] }] }); } });
  const api = await serveChild(import.meta.dir, "api.ts", {
    OB1_STOP_GRACE: "3", MCP_ACCESS_KEYS: `w:write:${hashKey("write-raw")}`, OPENROUTER_API_KEY: "stub",
    OB1_LLM_BASE_URL: `http://127.0.0.1:${slow.port}/v1`, OB1_LLM_LOCAL: "1",
  });
  let out = "";
  try {
    const inFlight = fetch(`http://127.0.0.1:${api.port}/v1/search`, { method: "POST", headers: { "x-brain-key": "write-raw", "content-type": "application/json" }, body: JSON.stringify({ query: "a search the stop cuts" }) })
      .then((r) => `answered ${r.status}`, () => "cut off");
    await Bun.sleep(400);
    out = await api.stop();
    await inFlight;
  } finally {
    api.kill();
    slow.stop(true);
  }
  const up = api.up;
  assert(up, `bun api.ts came up (${out.slice(-400)})`);
  const cut = out.split("\n").filter((l) => l.startsWith('{"ts"')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.outcome === "cut");
  assert(cut.length === 1 && cut[0]?.route === "/v1/search" && cut[0]?.tool === "search_thoughts" && cut[0]?.agent === "w" && cut[0]?.door === "api",
    `the search the stop cut has one line, \`cut\`, by its route, operation and key (${JSON.stringify(cut)}; ${out.slice(-400)})`);
}

console.log("\n[12] The REST core's spans (SMD-1849 PR 2b): the request's, named for its route, and the operation's under it; a fault an ERROR, a refusal its code; no key or query text in any; a real `bun api.ts` sends its spans to a collector at its stop");
{
  const { SpanKind, SpanStatusCode } = await import("@opentelemetry/api");
  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-base");
  const { setUpTelemetry } = await import("./otel-setup.ts");
  const TID = "0af7651916cd43dd8448eb211c80319c";
  const PARENT = "b7ad6b7169203331";
  const PLANTED = "planted-rest-span-91c2";
  const exporter = new InMemorySpanExporter();
  const { AggregationTemporality, InMemoryMetricExporter } = await import("@opentelemetry/sdk-metrics");
  const measured = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const tracing = setUpTelemetry("open-brain-api-test", { exporter, metrics: measured });
  type Span = ReturnType<typeof exporter.getFinishedSpans>[number];
  const attrs = (sp: Span | undefined) => (sp?.attributes ?? {}) as Record<string, unknown>;
  const send = (path: string, headers: Record<string, string> = {}) =>
    Promise.resolve(app.fetch(new Request(`http://api${path}`, { headers: { "x-brain-key": "read-raw", ...headers } }))).then((r) => r.text());
  const realAnswer = answer;
  try {
    exporter.reset();
    lines.length = 0;
    await send(`/v1/thoughts?limit=3&topic=${PLANTED}`, { traceparent: `00-${TID}-${PARENT}-01` });
    let spans = exporter.getFinishedSpans();
    const listed = spans.find((sp) => sp.kind === SpanKind.SERVER);
    const listedOp = spans.find((sp) => sp.name === "execute_tool list_thoughts");
    const listedLine = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert(listed?.name === "GET /v1/thoughts" && attrs(listed)["http.route"] === "/v1/thoughts" && attrs(listed)["ob1.tool"] === "list_thoughts" && attrs(listed)["ob1.agent"] === "r"
      && attrs(listed)["http.response.status_code"] === 200 && listed.spanContext().traceId !== TID && listed.parentSpanContext === undefined
      && listed.links[0]?.context.traceId === TID && listed.links[0]?.context.spanId === PARENT && listedLine.trace === listed.spanContext().traceId,
      `the request's span: its route's template, its operation, the key's name, its 200; its own trace, on the line, the caller's linked (${listed?.name} ${JSON.stringify(attrs(listed))} ${listedLine.trace})`);
    assert(listedOp?.parentSpanContext?.spanId === listed?.spanContext().spanId && attrs(listedOp)["ob1.outcome"] === "ok" && listedOp?.status.code === SpanStatusCode.UNSET,
      `the operation's span is its child, \`ok\` (${listedOp?.name} ${JSON.stringify(attrs(listedOp))})`);
    // A request its forwarder carried continues the forwarder's traceparent: the MCP server's tool call, of which it is
    // the operation, one trace (SMD-2287 PR 4c). Only a forward-scope key in the slot does: another key there, a key
    // that is none, or keys that cannot be read, and the caller's trace is linked as any caller's is.
    const parentage = async (forwarder: string | null, on = app) => {
      exporter.reset();
      const headers: Record<string, string> = { "x-brain-key": "read-raw", traceparent: `00-${TID}-${PARENT}-01`, ...(forwarder === null ? {} : { "x-brain-forwarder": forwarder }) };
      await Promise.resolve(on.fetch(new Request("http://api/v1/whoami", { headers }))).then((r) => r.text());
      const sp = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER);
      return sp?.spanContext().traceId === TID && sp.parentSpanContext?.spanId === PARENT && sp.links.length === 0 ? "continued"
        : sp?.spanContext().traceId !== TID && sp?.parentSpanContext === undefined && sp?.links[0]?.context.traceId === TID ? "linked" : `neither (${sp?.name})`;
    };
    const keysUnread = createRestApp({ core, init: () => {}, keys: () => { throw new TypeError("the keys are unreadable"); }, resolve: async () => identity, track: (run) => run(), log: () => {} });
    // Keys read only once the environment is seeded, as api.ts's are: the slot is checked after its init, so a REST core
    // in process trusts its first forwarded request too (review pass 2).
    let seeded = false;
    const seededLate = createRestApp({ core, init: () => { seeded = true; }, keys: () => { if (!seeded) throw new Error("env accessed before initEnv()"); return { MCP_ACCESS_KEYS: `r:read:${hashKey("read-raw")},f:forward:${hashKey("fwd-raw")}` }; }, resolve: async (p) => (p.scope === "forward" ? carrierIdentity : identity), track: (run) => run(), log: () => {} });
    const trusts = [await parentage("fwd-raw"), await parentage("write-raw"), await parentage("not-a-key"), await parentage(""), await parentage(null), await parentage("fwd-raw", keysUnread), await parentage("fwd-raw", seededLate)];
    assert(JSON.stringify(trusts) === JSON.stringify(["continued", "linked", "linked", "linked", "linked", "linked", "continued"]),
      `a forward-scope key in the forwarder slot continues the caller's traceparent, the first request to a core whose keys need its init included; another key, none, an empty slot, no slot or unread keys link it (${JSON.stringify(trusts)})`);

    exporter.reset();
    answer = async () => { throw new Error(`the store fell over near ${PLANTED}`); };
    await send("/v1/thoughts");
    spans = exporter.getFinishedSpans();
    const fault = spans.find((sp) => sp.kind === SpanKind.SERVER);
    const faultOp = spans.find((sp) => sp.name === "execute_tool list_thoughts");
    assert(fault?.status.code === SpanStatusCode.ERROR && attrs(fault)["error.type"] === "FAILED" && attrs(fault)["http.response.status_code"] === 500 && faultOp?.status.code === SpanStatusCode.ERROR && attrs(faultOp)["error.type"] === "FAILED",
      `a fault: the request's span and the operation's are ERROR, FAILED, with no message of its own (${JSON.stringify([attrs(fault), attrs(faultOp)])})`);
    // The operation's span has the throw's kind (PR 2c); the request's, whose call has a span of its own, none.
    assert(JSON.stringify(faultOp?.events.map((e) => [e.name, e.attributes])) === JSON.stringify([["exception", { "exception.type": "Error" }]]) && fault?.events.length === 0,
      `the throw's kind on the operation's span alone (${JSON.stringify([faultOp?.events, fault?.events])})`);
    // An environment that will not seed throws in the middleware itself: its kind on the request's span too (review pass 3).
    exporter.reset();
    const unseeded = createRestApp({ core, init: () => { throw new SyntaxError(`OB1_TIER is not a tier near ${PLANTED}`); }, keys: () => ({}), resolve: async () => identity, track: (run) => run(), log: () => {} });
    await (await unseeded.fetch(new Request("http://api/openapi.json"))).text();
    const unseededSpan = exporter.getFinishedSpans().find((sp) => sp.kind === SpanKind.SERVER);
    assert(unseededSpan?.events.some((e) => e.name === "exception" && e.attributes?.["exception.type"] === "SyntaxError") === true && !JSON.stringify(unseededSpan?.events).includes(PLANTED),
      `an init that throws: its kind on the request's span, no message (${JSON.stringify(unseededSpan?.events)})`);
    // A throw that escapes to onError has no operation span: its kind goes on the request's (review pass 1).
    exporter.reset();
    const unread = createRestApp({ core, init: () => {}, keys: () => { throw new TypeError(`the keys are unreadable near ${PLANTED}`); }, resolve: async () => identity, track: (run) => run(), log: () => {} });
    await (await unread.fetch(new Request("http://api/v1/whoami", { headers: { "x-brain-key": "read-raw" } }))).text();
    const escaped = exporter.getFinishedSpans().find((sp) => sp.kind === SpanKind.SERVER);
    assert(JSON.stringify(escaped?.events.map((e) => [e.name, e.attributes])) === JSON.stringify([["exception", { "exception.type": "TypeError" }]]) && attrs(escaped)["error.type"] === "FAILED",
      `onError's throw: its kind on the request's span, FAILED, no message (${JSON.stringify(escaped?.events)})`);
    // Nothing of the fault's message, which carries planted text, in any of its spans (review pass 5: the scan ran only after a reset).
    const faultTold = JSON.stringify(spans.map((sp) => ({ name: sp.name, attributes: sp.attributes, events: sp.events, status: sp.status, links: sp.links })));
    assert(spans.length === 2 && !faultTold.includes(PLANTED) && !faultTold.includes("fell over"), `a fault's message reaches none of its spans: name, attributes, events, status (${faultTold.length} chars)`);
    // Capture's fault is answered with its route's code; its operation's span says that code too.
    exporter.reset();
    await Promise.resolve(app.fetch(new Request("http://api/v1/thoughts", { method: "POST", headers: { "x-brain-key": "write-raw", "content-type": "application/json" }, body: JSON.stringify({ content: "a capture that faults" }) }))).then((r) => r.text());
    const captureOp = exporter.getFinishedSpans().find((sp) => sp.name === "execute_tool capture_thought");
    assert(attrs(captureOp)["ob1.code"] === "STORE_UNAVAILABLE" && attrs(captureOp)["error.type"] === "STORE_UNAVAILABLE", `a capture's fault: its operation's span says its route's code, STORE_UNAVAILABLE (${JSON.stringify(attrs(captureOp))})`);

    exporter.reset();
    answer = async () => refuse({ code: "NOT_FOUND", retryable: false, id: "nope" });
    await send(`/v1/thoughts/${crypto.randomUUID()}`);
    spans = exporter.getFinishedSpans();
    const missing = spans.find((sp) => sp.kind === SpanKind.SERVER);
    const missingOp = spans.find((sp) => sp.name.startsWith("execute_tool "));
    assert(missing?.status.code === SpanStatusCode.UNSET && attrs(missing)["ob1.code"] === "NOT_FOUND" && attrs(missing)["ob1.outcome"] === "refused" && attrs(missing)["http.response.status_code"] === 404
      && attrs(missingOp)["ob1.outcome"] === "refused" && attrs(missingOp)["ob1.code"] === "NOT_FOUND" && missingOp?.status.code === SpanStatusCode.UNSET,
      `a refusal: its code on both spans, not an ERROR (${JSON.stringify([attrs(missing), attrs(missingOp)])})`);
    // On the histogram: the operation's own refusal is the tool's, and keeps it; a refusal of the key is the key's, and
    // labels no tool, so a keyless caller raises no tool's refusal rate (PR 2c review pass 4).
    await send("/v1/stats", { "x-brain-key": "not-a-key" });
    await tracing.flush();
    const restPoints = ((measured.getMetrics().at(-1)?.scopeMetrics ?? []).flatMap((sm) => sm.metrics).filter((m) => m.descriptor.name === "http.server.request.duration").flatMap((m) => m.dataPoints as unknown[]) as { attributes: Record<string, unknown> }[]);
    const missingPoint = restPoints.find((pt) => pt.attributes["http.response.status_code"] === 404 && pt.attributes["http.route"] === "/v1/thoughts/:id");
    const keyPoint = restPoints.find((pt) => pt.attributes["http.response.status_code"] === 401 && pt.attributes["http.route"] === "/v1/stats");
    assert(missingPoint?.attributes["ob1.tool"] === "fetch" && keyPoint !== undefined && !("ob1.tool" in keyPoint.attributes),
      `the operation's refusal keeps its tool on its point; a key's refusal labels none (${JSON.stringify([missingPoint?.attributes, keyPoint?.attributes])})`);

    exporter.reset();
    await Promise.resolve(app.fetch(new Request("http://api/v1/thoughts")));
    const keyless = exporter.getFinishedSpans();
    assert(keyless.length === 1 && attrs(keyless[0])["ob1.code"] === "UNAUTHORIZED", `refused at its key, a request runs no operation, so has no operation's span (${keyless.map((sp) => sp.name).join(", ")})`);

    exporter.reset();
    answer = realAnswer;
    await send(`/v1/thoughts?topic=${PLANTED}`, { authorization: `Bearer read-raw` });
    await send(`/v1/search?query=${PLANTED}`);
    const told = JSON.stringify(exporter.getFinishedSpans().map((sp) => ({ name: sp.name, attributes: sp.attributes, events: sp.events, status: sp.status })));
    assert(told.length > 100 && !told.includes("read-raw") && !told.includes(PLANTED) && !told.includes("topic=") && !told.includes("?"),
      `no key, query string or planted text in any span (${told.length} chars)`);
  } finally {
    answer = realAnswer;
    await tracing.shutdown();
  }

  // A real `bun api.ts` with a collector named: it says where its signals go, by
  // origin alone, and its stop sends what is batched (the batch's own delay is
  // 5 s), before it exits.
  const received: string[] = [];
  const collector = Bun.serve({ port: 0, fetch: async (req) => { if (new URL(req.url).pathname === "/v1/traces") received.push(await req.text()); return Response.json({}); } });
  const collectorPort = collector.port;
  const STUB = { OB1_STOP_GRACE: "3", MCP_ACCESS_KEYS: `w:write:${hashKey("write-raw")}`, OPENROUTER_API_KEY: "stub" };
  const api = await serveChild(import.meta.dir, "api.ts", { ...STUB, OTEL_EXPORTER_OTLP_ENDPOINT: `http://otel-user:otel-secret@127.0.0.1:${collectorPort}` }, { waitForSdk: true });
  let out = "";
  try {
    await fetch(`http://127.0.0.1:${api.port}/v1/whoami?note=${PLANTED}`).then((r) => r.text());
    out = await api.stop();
  } finally {
    api.kill();
    collector.stop(true);
  }
  assert(api.up && api.sdk, `bun api.ts came up and loaded its SDK (${out.slice(-400)})`);
  const sent = received.join("\n");
  assert(sent.includes("GET /v1/whoami") && sent.includes("open-brain-api") && !sent.includes(PLANTED),
    `its stop sent the whoami's span to the collector, named for its service, the query left out (${received.length} exports; ${sent.slice(0, 160)})`);
  assert(out.includes(`telemetry: open-brain-api's spans, metrics and log records go to http://127.0.0.1:${collectorPort} over OTLP/HTTP`) && !out.includes("otel-secret"),
    `it says where its signals go, by origin, the endpoint's credentials left out (${out.split("\n").filter((l) => l.includes("telemetry")).join(" / ")})`);

  // With a collector that fails: the stop says the telemetry was not all sent — not
  // that the pool did not close — and the failed export says so, by origin and
  // kind, neither the endpoint's credentials nor its headers in any line (review pass 1).
  const gone = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 500 }) });
  const gonePort = gone.port;
  const lone = await serveChild(import.meta.dir, "api.ts", {
    ...STUB, OTEL_EXPORTER_OTLP_ENDPOINT: `http://otel-user:otel-secret@127.0.0.1:${gonePort}`, OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer s3cr3t-header",
  }, { waitForSdk: true });
  let loneOut = "";
  try {
    await fetch(`http://127.0.0.1:${lone.port}/v1/whoami`).then((r) => r.text());
    loneOut = await lone.stop();
  } finally {
    lone.kill();
    gone.stop(true);
  }
  const loneUp = lone.up && lone.sdk;
  const stopLine = loneOut.split("\n").find((l) => l.startsWith("SIGTERM: stopped")) ?? "";
  assert(loneUp && /; no database pool was opened; telemetry not all sent; exit 0$/.test(stopLine) && loneOut.includes(`telemetry: 1 span not sent to http://127.0.0.1:${gonePort} (HTTP 500)`)
    && !loneOut.includes("otel-secret") && !loneOut.includes("s3cr3t-header"),
    `its collector failing, the stop says the telemetry was not all sent, the pool's clause its own; the failure is said by origin and kind, no credential (${stopLine} / ${loneOut.split("\n").filter((l) => l.includes("not sent to")).join(" / ")})`);

  // A child a signal kills (an OOM kill, a panic) is seen as gone at once, not waited on 15 s (review pass 5).
  const { tmpdir } = await import("node:os");
  const suicide = `${tmpdir()}/smd1849-kills-itself-${process.pid}.ts`;
  await Bun.write(suicide, "process.kill(process.pid, 'SIGKILL');\n");
  const k0 = performance.now();
  const killed = await serveChild(tmpdir(), suicide, {});
  const killedMs = performance.now() - k0;
  killed.kill();
  await Bun.file(suicide).delete();
  assert(!killed.up && killedMs < 3_000, `a child killed by a signal: not up, seen in ${Math.round(killedMs)} ms`);

  // An export already on its way when the stop comes: the flush waits for it,
  // and a collector slower than the bound is said as such — not read as sent
  // because nothing was left in the batch (review pass 2).
  const slowCollector = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(3_000); return Response.json({}); } });
  const slowPort = slowCollector.port;
  // The batch's delay at 200 ms (OTEL_BSP_SCHEDULE_DELAY), so its export is on its way well before the stop.
  const late = await serveChild(import.meta.dir, "api.ts", { ...STUB, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${slowPort}`, OTEL_BSP_SCHEDULE_DELAY: "200" }, { waitForSdk: true });
  let lateOut = "";
  try {
    await fetch(`http://127.0.0.1:${late.port}/v1/whoami`).then((r) => r.text());
    await Bun.sleep(700); // past the batch's delay: its export is on its way, the batch empty
    lateOut = await late.stop();
  } finally {
    late.kill();
    slowCollector.stop(true);
  }
  const lateStop = lateOut.split("\n").find((l) => l.startsWith("SIGTERM: stopped")) ?? "";
  assert(late.up && late.sdk && /; telemetry not all sent within \d+ ms; exit 0$/.test(lateStop), `an export on its way at the stop is waited for, not read as sent (${lateStop})`);
}

console.log("\n[16] The served idle timeout is Bun's ceiling: its 10 s default cuts a GET whose handler has not answered (SMD-2287 PR 3a review pass 3)");
{
  const api = await import("./api.ts");
  assert(api.IDLE_TIMEOUT_S === 255 && (api.default as { idleTimeout?: number }).idleTimeout === 255, `bun api.ts serves with idleTimeout 255 (${(api.default as { idleTimeout?: number }).idleTimeout})`);
  // What the setting is for, measured on this runtime: a GET whose handler answers after 14 s (Bun cuts at its 10 s default plus its sweep, about 12 s).
  const probe = (idleTimeout?: number) => {
    const server = Bun.serve({ port: 0, ...(idleTimeout ? { idleTimeout } : {}), fetch: async () => { await Bun.sleep(14_000); return new Response("done"); } });
    return fetch(`http://127.0.0.1:${server.port}/v1/stats`).then(async (r) => `${r.status} ${await r.text()}`, (e: Error) => `cut: ${e.message.slice(0, 40)}`).finally(() => server.stop(true));
  };
  const [held, cut] = await Promise.all([probe(255), probe()]);
  assert(held === "200 done", `at 255, a 14-second GET is answered (${held})`);
  // A tripwire: when a Bun bump stops cutting, this fails — revisit IDLE_TIMEOUT_S here and in mcp-server/index.ts, and sse.ts's comment (SMD-2931).
  assert(/^cut: .*ECONNRESET|^cut: .*closed/i.test(cut), `…where Bun's default cuts it, the connection reset — the setting's reason, still true on this runtime; if this fails after a Bun bump, revisit IDLE_TIMEOUT_S (api.ts, mcp-server/index.ts) and sse.ts's comment (${cut})`);
}

report();
