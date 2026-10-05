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

import { createAssert } from "../db/test-support.ts";
import { hashKey, type Principal } from "./auth.ts";
import { TOOLS, TOOL_NAMES, READ_TOOL_NAMES, CAPTURE_TOOL_NAMES, type ToolName } from "./tools.ts";
import { SPECS, type Core } from "./core/index.ts";
import { ok, refuse } from "./core/refusal.ts";
import type { AgentOutcome } from "./agents.ts";
import { ROUTES, pathFields } from "./rest/routes.ts";
import { createRestApp, inputFromQuery, headerKeys, REFUSAL_STATUS } from "./rest/app.ts";
import { openApiDocument } from "./rest/openapi.ts";

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
let resolveThrows = false;
const lines: string[] = [];
const app = createRestApp({
  core,
  init: () => {},
  keys: () => ({ MCP_ACCESS_KEYS: `r:read:${hashKey("read-raw")},w:write:${hashKey("write-raw")},c:capture:${hashKey("cap-raw")},f:forward:${hashKey("fwd-raw")}` }),
  resolve: async () => { if (resolveThrows) throw new Error("the registry threw"); return identity; },
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
  assert(r.status === 401 && r.body.code === "REVOKED", `a revoked key → 401 REVOKED (${r.status} ${r.body.code})`);
  identity = { status: "busy" } as AgentOutcome;
  const busy = await hit("/v1/stats", { key: "read-raw" });
  assert(busy.status === 503 && busy.headers.get("retry-after") === "2", `a busy registry → 503 with Retry-After (${busy.status})`);
  identity = { status: "ok", agentId: "agent-1" };
  calls.length = 0;
  await hit("/v1/stats", { key: "write-raw" });
  assert(calls[0]?.principal.agentId === "agent-1" && calls[0]?.principal.name === "w", "the operation runs as the key, its agent id resolved");
  const who = await json(await hit("/v1/whoami", { key: "cap-raw" }));
  assert(who.status === 200 && who.body.scope === "capture" && JSON.stringify(who.body.operations) === JSON.stringify(CAPTURE_TOOL_NAMES), `whoami names the key's scope and its operations (${JSON.stringify(who.body)})`);
  const whoRead = await json(await hit("/v1/whoami", { key: "read-raw" }));
  assert(JSON.stringify(whoRead.body.operations) === JSON.stringify(READ_TOOL_NAMES), "…a read key's are the read group");
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

console.log("\n[8] One log line per request: method, route, status, time — no query, key, id or content");
{
  lines.length = 0;
  await hit("/v1/thoughts/9f0c1e2a-0000-4000-8000-00000000abcd?x=1", { key: "read-raw" });
  await hit("/v1/changes?agent=someone-secret", { key: "read-raw" });
  await hit("/v1/search", { key: "write-raw", method: "POST", body: JSON.stringify({ query: "the private query" }) });
  await hit("/nope");
  await hit("/health");
  assert(lines.length === 4, `four requests, four lines — the liveness probe's 200 is not one (${lines.length})`);
  assert(/^api GET \/v1\/thoughts\/:id \d{3} \d+ms$/.test(lines[0] ?? ""), `the route's template, not its id (${lines[0]})`);
  const all = lines.join("\n");
  for (const s of ["9f0c1e2a", "someone-secret", "private query", "read-raw", "write-raw", "x=1"]) assert(!all.includes(s), `no ${s} in the log`);
  assert(/^api GET - 404 /.test(lines[3] ?? ""), `an unrouted request is logged without its path (${lines[3]})`);
}

report();
