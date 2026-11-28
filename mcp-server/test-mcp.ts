#!/usr/bin/env bun
/**
 * test-mcp.ts — the MCP server as a client of the REST core (SMD-2287), with
 * no database: the real REST app over a stub core behind it, in process.
 *
 * It holds that the server says what server-portable says:
 * - the tool list is the caller's operations, as whoami names them;
 * - every reply is what render.ts makes of the outcome the in-process core
 *   would have handed it — a success, a refusal (carried whole through the
 *   forwarder slot), a fault and capture's STORE_UNAVAILABLE;
 * - a scan's links sit under the endpoint;
 * - the key refusals are the edge's envelopes (mcp-edge.ts), a refused
 *   notification's answer bare;
 * - /health, the worker mirrors and the job routes answer as index.ts's;
 * - an enabled plugin's operation is a tool where whoami names it, called by
 *   its route and said by render.ts's renderPlugin (PR 4a).
 * server-portable's suites that drive an MCP server run against it too,
 * through stack.ts (since PR 6a, never index.ts).
 *
 *   bun test-mcp.ts
 */

import { childPort, createAssert, watchStream } from "../db/test-support.ts";
import { hashKey, type Principal } from "../server-portable/auth.ts";
import type { Core } from "../server-portable/core/index.ts";
import { ok, refuse, type Refusal } from "../server-portable/core/refusal.ts";
import { createRestApp } from "../server-portable/rest/app.ts";
import * as say from "../server-portable/render.ts";
import { visibleToolNames } from "../server-portable/tools.ts";
import { REVOKED_MESSAGE, BUSY_MESSAGE, MIRROR_WORDS, revisionOf, parsedBody } from "../server-portable/mcp-edge.ts";
import type { AgentOutcome } from "../server-portable/agents.ts";
import { createRestClient } from "../rest-client/index.ts";
import { argumentsById, createMcpApp } from "./app.ts";
import { createExchanger, exchangeSettings, MAX_ENTRIES } from "./exchange.ts";
import { checkerOver, tokenSettings } from "../server-portable/oauth-token.ts";
import { AuthReachability, useAuthReachability } from "../server-portable/oauth-edge.ts";
import { loadPlugins, runOperation } from "../server-portable/core/plugins.ts";
import { definePlugin, ok as pluginOk, operation, refuse as pluginRefuse, z } from "../server-portable/plugin-sdk.ts";

const { assert, report } = createAssert();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── The REST core over a stub core, and the MCP server in front of it ───────
const calls: { name: string; principal: Principal | string; input: unknown }[] = [];
let answer: (name: string) => unknown = () => ok({});
const core = new Proxy({}, {
  get: (_t, prop) => async (principal: Principal | string, input: unknown) => {
    calls.push({ name: String(prop), principal, input });
    return answer(String(prop));
  },
}) as unknown as Core;
let identity: AgentOutcome = { status: "ok", agentId: "agent-1" };
/** Set to hold the registry's word on a caller's key until it resolves: its tables locked. */
let resolveGate: Promise<void> | null = null;
/** How long each lookup of a caller's key takes: a slow registry, which answers. */
let resolveDelayMs = 0;
const restApp = createRestApp({
  core,
  init: () => {},
  keys: () => ({ MCP_ACCESS_KEYS: [`laptop:write:${hashKey("write-raw")}`, `chatgpt:read:${hashKey("read-raw")}`, `hook:capture:${hashKey("cap-raw")}`, `mcp:forward:${hashKey("fwd-raw")}`].join(",") }),
  resolve: async (p) => {
    if (p.scope === "forward") return { status: "ok", agentId: "agent-f" };
    if (resolveGate) await resolveGate;
    if (resolveDelayMs) await Bun.sleep(resolveDelayMs);
    return identity;
  },
  track: (run) => run(),
  log: () => {},
});
let restDown = false;
/** The REST core away for an operation, whoami still answering: a call that fails past the caller's check. */
let restDownForCalls = false;
const rest = createRestClient({
  baseUrl: "http://api.ob1.internal",
  fetch: async (req) => {
    if (restDown || (restDownForCalls && !new URL(req.url).pathname.endsWith("/whoami"))) throw new TypeError("fetch failed: connection refused");
    return restApp.fetch(req);
  },
  forwarderKey: "fwd-raw",
});
const warned: string[] = [];
const app = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: (l) => warned.push(l) });

let rpcId = 1;
type Rpc = { status: number; headers: Headers; body: Record<string, unknown> | null };
const MODERN = "2026-07-28";
/** The 2026-07-28 revision's per-request envelope, which takes the place of `initialize`: the revision, who the client is, what it can do. */
const ENVELOPE = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "test-mcp", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
type RpcOpts = { notification?: boolean; via?: "header" | "query" | "bearer"; path?: string; modern?: boolean; headers?: Record<string, string>; envelope?: Record<string, unknown>; signal?: AbortSignal };
/**
 * One JSON-RPC request to the endpoint. `modern`: as a 2026-07-28 client sends it — the envelope in `params._meta`, and
 * the revision, the method and a called tool's name as headers. `headers` and `envelope` replace values of those, for
 * a request the SDK's handler must refuse.
 */
function requestFor(method: string, params: unknown, key?: string, opts: RpcOpts = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (opts.modern) {
    headers["mcp-protocol-version"] = MODERN;
    headers["mcp-method"] = method;
    const named = (params as { name?: unknown } | null)?.name;
    if (typeof named === "string") headers["mcp-name"] = named;
    params = { ...(params as object), _meta: { ...ENVELOPE, ...opts.envelope } };
  }
  Object.assign(headers, opts.headers);
  const via = opts.via ?? "header";
  if (key && via === "header") headers["x-brain-key"] = key;
  if (key && via === "bearer") headers.authorization = `Bearer ${key}`;
  const url = `http://mcp${opts.path ?? "/mcp"}${key && via === "query" ? `?key=${key}` : ""}`;
  const message = opts.notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: rpcId++, method, params };
  return new Request(url, { method: "POST", headers, body: JSON.stringify(message), signal: opts.signal });
}
/** The first JSON-RPC message of an answer, a JSON body or an event stream's first `data:` line. */
const firstMessage = (text: string): Record<string, unknown> | null => {
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  return line ? JSON.parse(line) : null;
};
async function rpc(method: string, params: unknown, key?: string, opts: RpcOpts & { app?: { fetch(req: Request): Response | Promise<Response> } } = {}): Promise<Rpc> {
  const r = await (opts.app ?? app).fetch(requestFor(method, params, key, opts));
  return { status: r.status, headers: r.headers, body: firstMessage(await r.text()) };
}
const toolsOf = async (key: string, via?: "header" | "query" | "bearer") =>
  (((await rpc("tools/list", {}, key, { via })).body?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name).sort();
type Reply = { text: string; sc: Record<string, unknown>; isError: boolean };
async function tool(name: string, args: Record<string, unknown>, key = "write-raw", path?: string): Promise<Reply> {
  const r = await rpc("tools/call", { name, arguments: args }, key, { path });
  const result = (r.body?.result ?? {}) as { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  return { text: (result.content ?? []).map((c) => c.text).join("\n"), sc: result.structuredContent ?? {}, isError: result.isError === true };
}
const expectReply = (got: Reply, want: say.Reply) => got.text === want.content[0].text && same(got.sc, want.structuredContent) && got.isError === (want.isError === true);

console.log("[1] The tool list is the caller's operations, as the REST core's whoami names them");
{
  for (const [key, scope] of [["write-raw", "write"], ["read-raw", "read"], ["cap-raw", "capture"]] as const) {
    const tools = await toolsOf(key);
    assert(same(tools, [...visibleToolNames({ scope })].sort()), `${scope} key: its scope's tools (${tools.length})`);
  }
  assert(same(await toolsOf("read-raw", "query"), await toolsOf("read-raw")) && same(await toolsOf("read-raw", "bearer"), await toolsOf("read-raw")), "the key in ?key= or a Bearer token reads the same list");
  // A forwarder key before a client's key is passed over: the client's key is the caller (auth.ts presentedKeys' order).
  const r = await app.fetch(new Request("http://mcp/mcp?key=read-raw", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "fwd-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
  const listed = ((JSON.parse((await r.text()).split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}").result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
  assert(same(listed, [...visibleToolNames({ scope: "read" })].sort()), `a forwarder key in x-brain-key beside a read key in ?key=: the read key's list (${listed.length})`);
}

console.log("\n[2] Each reply is what render.ts makes of the core's outcome, carried over REST");
{
  const thought = { id: "00000000-0000-4000-8000-000000000001", content: "alpha", metadata: { type: "idea" }, created_at: "2026-10-01T00:00:00Z" };
  const stats = { total: 3, oldest: "2026-10-01T00:00:00Z", newest: "2026-10-02T00:00:00Z", types: { idea: 3 }, topics: { rest: 2 }, people: {}, aggregated: 3 };
  const cases: [string, Record<string, unknown>, string, unknown, (o: never) => say.Reply][] = [
    ["thought_stats", {}, "thoughtStats", stats, (o) => say.renderThoughtStats(o)],
    ["fetch", { id: thought.id }, "fetch", { id: thought.id, title: "alpha", text: "alpha", url: "https://x/1", metadata: {} }, (o) => say.renderFetch(o)],
    ["list_thought_ids", { limit: 2 }, "listThoughtIds", { total: 1, digest: null, ids: [thought.id], cursor: null }, (o) => say.renderThoughtIds(o)],
  ];
  for (const [name, args, op, value, render] of cases) {
    answer = (n) => (n === op ? ok(value) : ok({}));
    calls.length = 0;
    const got = await tool(name, args);
    assert(expectReply(got, render(ok(value) as never)) && calls[0]?.name === op, `${name}: the in-process reply, from ${op} over REST (${got.text.slice(0, 60)})`);
  }
  // brain_info's table needs a whole record, which the suites over a real database render (test-auth, test-e2e-sql).
}

console.log("\n[3] A refusal is said as server-portable says it: the refusal whole, carried by the forwarder slot");
{
  const refusals: [string, Record<string, unknown>, string, Refusal, (o: never) => say.Reply][] = [
    ["fetch", { id: "00000000-0000-4000-8000-000000000009" }, "fetch", { code: "NOT_FOUND", retryable: false, id: "00000000-0000-4000-8000-000000000009" }, (o) => say.renderFetch(o)],
    ["search_thoughts", { query: "q", filter: { a: 1 } }, "searchThoughts", { code: "REFUSED_FILTER", retryable: false, message: "filter key a is not one the boundary knows" }, (o) => say.renderSearchThoughts(o, false)],
    ["capture_thought", { content: "x", supersedes: "nope" }, "capture", { code: "REFUSED_SUPERSEDES_SHAPE", retryable: false, value: "nope", orNull: false }, (o) => say.renderCapture(o)],
    ["delete_thought", { id: "00000000-0000-4000-8000-000000000002" }, "deleteThought", { code: "REFUSED_CITED", retryable: false, id: "00000000-0000-4000-8000-000000000002", citedBy: 1 }, (o) => say.renderDelete(o)],
    ["run_worker", { work_type: "w" }, "runWorker", { code: "RUN_WORKER_DRAIN_NOT_AVAILABLE", retryable: false }, (o) => say.renderRunWorker(o)],
  ];
  for (const [name, args, op, refusal, render] of refusals) {
    answer = (n) => (n === op ? refuse(refusal as never) : ok({}));
    const got = await tool(name, args);
    assert(got.isError && expectReply(got, render({ ok: false, refusal } as never)), `${name} ${refusal.code}: the words in-process (${got.text.slice(0, 70)})`);
  }
}

console.log("\n[4] A fault is the tool's fault words: FAILED, capture's STORE_UNAVAILABLE, and the REST core away");
{
  answer = () => { throw new Error("relation \"thoughts\" does not exist"); };
  let got = await tool("thought_stats", {});
  assert(expectReply(got, say.failed(new Error("relation \"thoughts\" does not exist"))), `a read's fault: Error and its message (${got.text})`);
  got = await tool("update_thought", { id: "00000000-0000-4000-8000-000000000001", content: "z" });
  assert(expectReply(got, say.failed(new Error("relation \"thoughts\" does not exist"), { lead: "update_thought failed: " })), `a write's fault: its lead (${got.text})`);
  got = await tool("capture_thought", { content: "z" });
  assert(expectReply(got, say.storeUnavailable(new Error("relation \"thoughts\" does not exist"))) && got.sc.code === "STORE_UNAVAILABLE" && got.sc.retryable === true,
    `capture's fault: STORE_UNAVAILABLE, retryable, the verdict the session hook keys on (${JSON.stringify(got.sc)})`);
  answer = () => ok({});
  // The REST core away: whoami cannot answer, so the request itself fails; a call already past it is the tool's fault.
  restDown = true;
  const away = await app.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "x-brain-key": "write-raw", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
  restDown = false;
  assert(away.status === 500, `the REST core away before the caller is known: a 500 (${away.status})`);
  // Away mid-call: capture's STORE_UNAVAILABLE, so the session hook keeps the capture and retries; a re-capture of the text upserts its row (073).
  restDownForCalls = true;
  got = await tool("capture_thought", { content: "z" });
  const read = await tool("thought_stats", {});
  restDownForCalls = false;
  assert(got.sc.code === "STORE_UNAVAILABLE" && got.sc.retryable === true && /connection refused/.test(got.text), `the REST core away mid-capture: STORE_UNAVAILABLE, retryable (${got.text})`);
  assert(read.isError && /^Error: fetch failed: connection refused/.test(read.text), `…and mid-read: the read's fault words (${read.text})`);
}

console.log("\n[5] A scan's job links sit under the endpoint the call came to, as server-portable's do");
{
  answer = (n) => (n === "scanThoughts" ? ok({ jobId: "job-7", status: "accepted", poll: "/jobs/job-7", stream: "/jobs/job-7/stream" }) : ok({}));
  for (const [path, base] of [["/mcp", "/mcp"], ["/", ""], ["//mcp/", "/mcp"]] as const) {
    const got = await tool("scan_thoughts", { limit: 5 }, "write-raw", path);
    assert(got.sc.poll === `${base}/jobs/job-7` && got.sc.stream === `${base}/jobs/job-7/stream`, `at ${path}: poll ${got.sc.poll}, stream ${got.sc.stream}`);
  }
  answer = () => ok({});
}

console.log("\n[6] The key refusals are the edge's: the JSON-RPC envelope for a request, a bare answer for a notification");
{
  let r = await rpc("tools/list", {});
  assert(r.status === 200 && (r.body?.error as { code?: number } | undefined)?.code === -32001, `no key: the -32001 envelope (${JSON.stringify(r.body)})`);
  r = await rpc("tools/list", {}, "wrong");
  assert(r.status === 200 && (r.body?.error as { code?: number } | undefined)?.code === -32001, "a wrong key: the same");
  r = await rpc("tools/list", {}, "fwd-raw");
  assert(r.status === 200 && (r.body?.error as { code?: number } | undefined)?.code === -32001, "a forwarder key alone: the same, no tool list");
  r = await rpc("notifications/initialized", {}, "wrong", { notification: true });
  assert(r.status === 202 && r.body === null, `a notification with a wrong key: 202, no body (${r.status})`);
  identity = { status: "revoked", agentId: "agent-1", revokedAt: "2026-10-05T00:00:00Z", reason: null };
  r = await rpc("tools/list", {}, "write-raw");
  assert((r.body?.error as { message?: string } | undefined)?.message === REVOKED_MESSAGE, "a revoked key: the revocation's own words");
  identity = { status: "busy" } as AgentOutcome;
  r = await rpc("tools/list", {}, "write-raw");
  assert((r.body?.error as { code?: number; message?: string } | undefined)?.code === -32003 && (r.body?.error as { message?: string }).message === BUSY_MESSAGE && r.headers.get("retry-after") === "2", "a busy registry: -32003, Retry-After 2");
  r = await rpc("notifications/initialized", {}, "write-raw", { notification: true });
  assert(r.status === 503 && r.headers.get("retry-after") === "2", `…and a notification then: 503, Retry-After (${r.status})`);
  identity = { status: "ok", agentId: "agent-1" };
  // This server's own forwarder refused: a misconfiguration, a fault — never a caller's refusal.
  const misconfigured = createMcpApp({ rest: createRestClient({ baseUrl: "http://api.ob1.internal", fetch: (req) => Promise.resolve(restApp.fetch(req)), forwarderKey: "not-a-forwarder" }), edge: () => ({ configured: false, origin: null }) });
  const m = await misconfigured.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "x-brain-key": "write-raw", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }));
  assert(m.status === 500, `a forwarder key the REST core refuses: a 500, not the caller's -32001 (${m.status})`);
}

console.log("\n[7] /health: liveness, and the brain's record for a key that may read it");
{
  const record = { version: "1.0.0", store: "sql" };
  answer = () => record;
  const health = async (key?: string, method = "GET") => {
    const r = await app.fetch(new Request("http://mcp/mcp/health", { method, headers: key ? { "x-brain-key": key } : {} }));
    return { status: r.status, text: await r.text() };
  };
  let h = await health();
  assert(h.status === 200 && h.text === "ok", "no key: ok");
  h = await health("read-raw");
  const body = JSON.parse(h.text) as Record<string, unknown>;
  assert(h.status === 200 && body.version === "1.0.0" && same(body.oauth, { configured: false, origin: null, advertised: false }), `a read key: the record, the edge's view beside it (${h.text})`);
  for (const key of ["cap-raw", "wrong", "fwd-raw"]) {
    h = await health(key);
    assert(h.text === "ok", `${key}: ok`);
  }
  calls.length = 0;
  h = await health("read-raw", "HEAD");
  assert(h.status === 200 && h.text === "" && !calls.some((c) => c.name === "brainInfo"), `a keyed HEAD: 200, no body, nothing read for it (${calls.map((c) => c.name).join(",") || "nothing"})`);
  answer = () => ok({});
}

console.log("\n[8] The keyed mirrors and the job routes answer as index.ts's");
{
  answer = (n) => (n === "workerStatus" ? ok({ pools: [{ workType: "w", pending: 1 }] }) : n === "runWorker" ? refuse({ code: "REFUSED_EMPTY_WORK_TYPE", retryable: false }) : ok({}));
  let r = await app.fetch(new Request("http://mcp/worker-status", { headers: { "x-brain-key": "read-raw" } }));
  assert(r.status === 200 && same(await r.json(), [{ workType: "w", pending: 1 }]), "GET /worker-status: the bare rows");
  r = await app.fetch(new Request("http://mcp/worker-status", { headers: { "x-brain-key": "cap-raw" } }));
  assert(r.status === 200 && (await r.text()) === "ok", "…a capture key is shown ok");
  r = await app.fetch(new Request("http://mcp/worker-run", { method: "POST", headers: { "x-brain-key": "write-raw", "content-type": "application/json" }, body: JSON.stringify({ work_type: 5 }) }));
  const run = await r.json() as Record<string, unknown>;
  assert(r.status === 400 && same(run, { error: MIRROR_WORDS.run_worker.REFUSED_EMPTY_WORK_TYPE, code: "REFUSED_EMPTY_WORK_TYPE" }), `POST /worker-run with a work type that is no string: its words, a 400 (${JSON.stringify(run)})`);
  r = await app.fetch(new Request("http://mcp/worker-run", { method: "POST", headers: { "x-brain-key": "read-raw" }, body: "{}" }));
  assert(r.status === 200 && (await r.text()) === "ok", "…a read key is shown ok");
  answer = (n) => (n === "jobStatus" ? ok({ jobId: "job-7", kind: "scan", status: "succeeded" }) : ok({}));
  r = await app.fetch(new Request("http://mcp/mcp/jobs/job-7", { headers: { "x-brain-key": "read-raw" } }));
  assert(r.status === 200 && same(await r.json(), { jobId: "job-7", kind: "scan", status: "succeeded" }), "GET /mcp/jobs/<id>: the job's state");
  answer = (n) => (n === "jobStatus" ? refuse({ code: "NOT_FOUND", retryable: false, id: "job-8" }) : ok({}));
  r = await app.fetch(new Request("http://mcp/mcp/jobs/job-8", { headers: { "x-brain-key": "read-raw" } }));
  assert(r.status === 404 && same(await r.json(), { error: "not found" }), "an unknown job: 404 not found");
  r = await app.fetch(new Request("http://mcp/mcp/jobs/job-8/stream", { headers: { "x-brain-key": "read-raw" } }));
  assert(r.status === 404, `an unknown job's stream: 404 (${r.status})`);
  answer = () => ok({});
}

console.log("\n[8b] Review pass 1: a capture key's capture, a reply that cannot be said, the tools' order, /health's first key, the mirrors' deadline, a job poll's fault");
{
  // The session hook's own path: a capture key's capture is said as in-process — the REST core hands the forwarder the whole value.
  const captured = {
    id: "00000000-0000-4000-8000-0000000000aa", reader: false, tags: { type: "idea", topics: ["rest"], people: ["Ann"], action_items: ["do x"] }, chunks: 0, contextFailures: 0, headWindow: null, recapture: null,
    embeddings: { allowed: true, reason: "allowed" }, chat: { allowed: true, reason: "allowed", base: "http://ollama:11434/v1" },
  };
  answer = (n) => (n === "capture" ? ok(captured) : ok({}));
  for (const key of ["cap-raw", "write-raw"]) {
    const got = await tool("capture_thought", { content: "Session summary", source: "claude-code" }, key);
    const want = say.renderCapture(ok(captured) as never);
    assert(!got.isError && expectReply(got, want), `${key}: the capture said as in-process (${got.text.slice(0, 70)})`);
  }
  // A capture saved without its vector because the provider did not answer (SMD-2888): the forwarded value says it as in-process, for both keys.
  // Each key with its own value, as the REST core hands it: a capture key's (reader false), a write key's (reader true, existed false).
  const vf = { reason: "provider_unreachable", detail: "the connection was refused", base: "http://ollama:11434/v1" };
  for (const [key, away, words] of [
    ["cap-raw", { ...captured, vectorFailed: vf }, /the embedding provider was unavailable\./],
    ["write-raw", { ...captured, reader: true, existed: false, vectorFailed: vf }, /saved WITHOUT a vector — the embedding provider at http:\/\/ollama:11434\/v1 was unavailable \(the connection was refused\)/],
  ] as const) {
    answer = (n) => (n === "capture" ? ok(away) : ok({}));
    const got = await tool("capture_thought", { content: "Session summary", source: "claude-code" }, key);
    const want = say.renderCapture(ok(away) as never);
    assert(!got.isError && expectReply(got, want) && words.test(got.text) && got.sc.vectorFailed === "provider_unreachable",
      `${key}: a capture saved without its vector said as in-process (${got.text.split("\n\n").find((p) => /vector/.test(p))?.slice(0, 90)})`);
  }
  // A search answered without a vector because the provider did not answer (SMD-2891): the forwarded value says it as in-process — the header and word, and the compat search's note and field.
  const hitless = { query: "plain words", preferCurrent: false, hits: [], facts: { needles: [], needleCounts: [], commonNeedles: [], literalOnly: null }, window: null, vectorFailed: vf };
  answer = (n) => (n === "searchThoughts" ? ok(hitless) : ok({}));
  const st = await tool("search_thoughts", { query: "plain words" }, "write-raw");
  assert(!st.isError && expectReply(st, say.renderSearchThoughts(ok(hitless) as never, false)) && /^No thoughts found matching "plain words"\. Semantic search is unavailable — the embedding provider at http:\/\/ollama:11434\/v1 failed/.test(st.text) && st.sc.vectorFailed === "provider_unreachable",
    `search_thoughts answered without a vector said as in-process (${st.text.slice(0, 120)})`);
  const literal = { results: [{ id: "00000000-0000-4000-8000-0000000000ab", title: "SMD-1 names it", url: "u", trust: undefined }], vectorFailed: vf };
  answer = (n) => (n === "search" ? ok(literal) : ok({}));
  const compat = await tool("search", { query: "SMD-1" }, "write-raw");
  assert(!compat.isError && expectReply(compat, say.renderSearch(ok(literal) as never)) && /"note":"Semantic search is unavailable/.test(compat.text) && compat.text.includes("[exact match — semantic search unavailable] SMD-1 names it") && compat.sc.vectorFailed === "provider_unreachable",
    `search answered without a vector said as in-process, its note and field (${compat.text.slice(0, 160)})`);
  // An empty compat answer without a vector is refused (review pass 4); the forwarder carries the refusal whole and says it as in-process.
  const unavailable = { code: "EMBEDDING_PROVIDER_UNAVAILABLE", retryable: true, ...vf, matched: "literals", needles: [], commonNeedles: ["COMMON-1"] } as const;
  answer = (n) => (n === "search" ? { ok: false, refusal: unavailable } as never : ok({}));
  const emptyCompat = await tool("search", { query: "COMMON-1" }, "write-raw");
  assert(emptyCompat.isError && expectReply(emptyCompat, say.renderSearch({ ok: false, refusal: unavailable } as never)) && emptyCompat.sc.code === "EMBEDDING_PROVIDER_UNAVAILABLE" && /Too common to match exactly .*: COMMON-1/.test(emptyCompat.text),
    `an empty search answered without a vector: refused, said as in-process (${emptyCompat.text.slice(-120)})`);
  // The brain's embedding provider refusing its key (SMD-2892): carried whole and said as in-process, and its line ends
  // as an error, not a refusal, so the fault panels keep a refused key (review pass 1).
  {
    const { useRequestLog } = await import("../server-portable/telemetry.ts");
    const lines: string[] = [];
    const before = useRequestLog((l) => lines.push(l));
    try {
      const keyless = { code: "EMBEDDING_PROVIDER_ERROR", retryable: false, reason: "provider_401", detail: "it answered 401 (its credential was refused)", status: 401, setting: "OB1_LLM_BASE_URL", base: "http://ollama:11434/v1" } as const;
      answer = (n) => (n === "searchThoughts" ? { ok: false, refusal: keyless } as never : ok({}));
      const refusedSt = await tool("search_thoughts", { query: "plain words" }, "write-raw");
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.door === "mcp" && l.tool === "search_thoughts");
      assert(refusedSt.isError && expectReply(refusedSt, say.renderSearchThoughts({ ok: false, refusal: keyless } as never, false)) && refusedSt.sc.code === "EMBEDDING_PROVIDER_ERROR"
        && line?.outcome === "error" && line?.code === "EMBEDDING_PROVIDER_ERROR",
        `an EMBEDDING_PROVIDER_ERROR said as in-process, its line \`error\` (${refusedSt.text.slice(0, 100)}; ${JSON.stringify(line)})`);
    } finally {
      useRequestLog(before);
    }
  }
  // A value render.ts cannot say is the tool's fault, coded, as index.ts's run catches it — never the SDK's uncoded error.
  answer = (n) => (n === "thoughtStats" ? ok({}) : ok({}));
  const unsayable = await tool("thought_stats", {});
  assert(unsayable.isError && unsayable.sc.code === "FAILED" && unsayable.text.startsWith("Error: "), `a value that does not render: FAILED, coded (${JSON.stringify(unsayable.sc).slice(0, 80)})`);
  answer = () => ok({});
  // tools/list in index.ts's registration order.
  const order = ["search", "fetch", "search_thoughts", "search_thoughts_keyword", "list_thoughts", "thread", "relations", "list_supersession_proposals", "list_settled_parts", "thought_stats", "thought_changes", "list_thought_ids", "list_logged_searches", "worker_status", "task_status", "brain_info", "capture_thought", "update_thought", "delete_thought", "forget_thought", "reset_capture_stamp", "append_thought_evidence", "review_supersession_proposal", "retry_failed", "release_stale_leases", "run_worker", "claim_work", "renew_claim", "release_claim", "list_claims", "set_work_claim_cap", "release_holder_claims", "set_priority", "clear_priority", "set_priority_weights", "priority_history", "list_priority_findings", "review_priority_finding", "open_item", "update_item", "set_item_status", "propose_item_close", "decide_item_close", "item_history", "list_items", "capture_deliverable", "verify_deliverable", "deliverable_history", "validity", "agenda", "plan_context", "job_status", "scan_thoughts"];
  type ListedTool = { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean } };
  const tools = ((await rpc("tools/list", {}, "write-raw")).body?.result as { tools?: ListedTool[] } | undefined)?.tools ?? [];
  const listed = tools.map((t) => t.name);
  assert(same(listed, order), `tools/list in index.ts's order (${listed.slice(0, 4).join(",")}…)`);
  // The priority review's findings (SMD-3671 PR 2): the list a read, the decision a write a second call is refused, and a read key sees the list alone.
  const findingTools = Object.fromEntries(tools.filter((t) => /priority_finding/.test(t.name)).map((t) => [t.name, t.annotations]));
  const readerSees = (((await rpc("tools/list", {}, "read-raw")).body?.result as { tools?: ListedTool[] } | undefined)?.tools ?? []).map((t) => t.name).filter((n) => /priority_finding/.test(n));
  assert(findingTools.list_priority_findings?.readOnlyHint === true && findingTools.review_priority_finding?.readOnlyHint === false
      && findingTools.review_priority_finding?.idempotentHint === false && findingTools.review_priority_finding?.destructiveHint === false && same(readerSees, ["list_priority_findings"]),
    `list_priority_findings read-only, review_priority_finding a write neither idempotent nor destructive; a read key lists the first alone (${JSON.stringify(findingTools)} ${readerSees.join(",")})`);
  // /health decided by the first key the REST core knows, as index.ts authenticates the first.
  const record = { version: "1.0.0", store: "sql" };
  answer = () => record;
  const health = async (headers: Record<string, string>, query = "") => (await app.fetch(new Request(`http://mcp/mcp/health${query}`, { headers }))).text();
  assert((await health({ "x-brain-key": "cap-raw" }, "?key=read-raw")) === "ok", "a capture key before a read key: ok, as the first key decides");
  assert(JSON.parse(await health({ "x-brain-key": "read-raw" }, "?key=cap-raw")).version === "1.0.0", "…and a read key first: the record");
  assert(JSON.parse(await health({ "x-brain-key": "wrong" }, "?key=read-raw")).version === "1.0.0", "…and a key the core does not know passes to the next");
  answer = () => ok({});
  // A mirror's key check held to the health deadline: the registry silent, ok at it.
  let release: () => void = () => {};
  resolveGate = new Promise<void>((done) => { release = done; });
  const t0 = performance.now();
  // Raced against a deadline of its own, so a check with no bound fails here rather than hanging the suite.
  const silent = await Promise.race([
    Promise.resolve(app.fetch(new Request("http://mcp/worker-status", { headers: { "x-brain-key": "read-raw" } }))),
    Bun.sleep(6_000).then(() => new Response("no answer within 6 s", { status: 599 })),
  ]);
  const took = performance.now() - t0;
  const silentText = await silent.text();
  release();
  resolveGate = null;
  assert(silent.status === 200 && silentText === "ok" && took >= 2_400 && took < 4_000, `a mirror with the registry silent: ok at the deadline (${Math.round(took)} ms)`);
  // A job poll's fault is a fault, not "not found", which a poller gives up on.
  answer = (n) => { if (n === "jobStatus") throw new Error("the durable job store is away"); return ok({}); };
  const poll = await app.fetch(new Request("http://mcp/mcp/jobs/job-7", { headers: { "x-brain-key": "read-raw" } }));
  assert(poll.status === 500, `a job poll whose read faults: 500, not 404 (${poll.status})`);
  answer = () => ok({});
}

console.log("\n[8c] Review pass 2: /health's one deadline, a job stream's answers, a misconfigured forwarder said once");
{
  // A registry that answers each lookup in 1.5 s: the key's standing and the record asked together, as index.ts starts
  // its read with the registry's check, so the record comes at about 1.5 s, not 3 (PR 4b review pass 3: one after the
  // other, they ran past the deadline together); past the deadline, one deadline over both answers `ok` at it.
  answer = () => ({ version: "1.0.0" });
  resolveDelayMs = 1_500;
  let t0 = performance.now();
  const slow = await app.fetch(new Request("http://mcp/mcp/health", { headers: { "x-brain-key": "read-raw" } }));
  let took = performance.now() - t0;
  const slowText = await slow.text();
  assert(slowText.includes('"version":"1.0.0"') && took < 2_200, `a registry at 1.5 s: /health's record, the key's check and the read together (${Math.round(took)} ms, ${slowText.slice(0, 30)})`);
  // A key the core does not know before the one that decides: its record asked from the start too (review pass 4).
  t0 = performance.now();
  const second = await app.fetch(new Request("http://mcp/mcp/health", { headers: { "x-brain-key": "bogus-raw", "x-access-key": "read-raw" } }));
  took = performance.now() - t0;
  const secondText = await second.text();
  assert(secondText.includes('"version":"1.0.0"') && took < 2_200, `an unknown key before a read key, the registry at 1.5 s: the read key's record, asked from the start (${Math.round(took)} ms, ${secondText.slice(0, 30)})`);
  resolveDelayMs = 2_700;
  t0 = performance.now();
  const past = await app.fetch(new Request("http://mcp/mcp/health", { headers: { "x-brain-key": "read-raw" } }));
  took = performance.now() - t0;
  const pastText = await past.text();
  resolveDelayMs = 0;
  answer = () => ok({});
  assert(pastText === "ok" && took < 2_900, `a registry past the deadline: /health answers ok within its one deadline (${Math.round(took)} ms, ${pastText.slice(0, 30)})`);
  // A job stream's answers from the REST core, each as index.ts answers it.
  const streamApp = (status: number) => createMcpApp({
    rest: createRestClient({
      baseUrl: "http://api.ob1.internal",
      forwarderKey: "fwd-raw",
      fetch: async (req) => new URL(req.url).pathname.endsWith("/whoami")
        ? Response.json({ name: "chatgpt", scope: "read", operations: ["job_status"] })
        : new Response(JSON.stringify({ code: status === 404 ? "NOT_FOUND" : status === 503 ? "BUSY" : "FAILED" }), { status, headers: { "content-type": "application/json" } }),
    }),
    edge: () => ({ configured: false, origin: null }),
  });
  const streamed = async (status: number) => {
    const r = await streamApp(status).fetch(new Request("http://mcp/mcp/jobs/job-7/stream", { headers: { "x-brain-key": "read-raw" } }));
    return { status: r.status, text: await r.text() };
  };
  const [missing, fault, busy] = [await streamed(404), await streamed(500), await streamed(503)];
  assert(missing.status === 404 && JSON.parse(missing.text).error === "not found", "a job not there: its stream 404, not found");
  assert(fault.status === 500, `a job stream the REST core faults on: 500, not "not found" (${fault.status})`);
  assert(busy.status === 200 && busy.text === "ok", `a stream the registry is busy on: ok, as index.ts's busy key is shown (${busy.status} ${busy.text})`);
  // This server's forwarder refused: /health and the mirrors show ok, and the log says why, once.
  const lines: string[] = [];
  const misconfigured = createMcpApp({ rest: createRestClient({ baseUrl: "http://api.ob1.internal", fetch: (req) => Promise.resolve(restApp.fetch(req)), forwarderKey: "not-a-forwarder" }), edge: () => ({ configured: false, origin: null }), warn: (l) => lines.push(l) });
  for (const path of ["/mcp/health", "/worker-status", "/mcp/health"]) await (await misconfigured.fetch(new Request(`http://mcp${path}`, { headers: { "x-brain-key": "read-raw" } }))).text();
  assert(lines.length === 1 && /forwarder/.test(lines[0]), `a forwarder the REST core refuses: one line, naming it, however often asked (${lines.length}: ${lines[0]?.slice(0, 80)})`);
}

console.log("\n[8d] Review pass 3: the forwarder's busy key, the registry busy mid-call, one line for a route's throw, the entry's idle timeout and its refusal of a base");
{
  // A REST core whose answers this test writes: whoami, then the call.
  const scripted = (whoami: () => Response, call: () => Response, lines?: string[]) => createMcpApp({
    rest: createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async (req) => (new URL(req.url).pathname.endsWith("/whoami") ? whoami() : call()) }),
    edge: () => ({ configured: false, origin: null }),
    warn: (l) => lines?.push(l),
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const reader = () => json(200, { name: "chatgpt", scope: "read", operations: ["worker_status", "job_status", "thought_stats"] });
  // The registry busy on this server's own key: busy, -32003 and Retry-After, as on a caller's — not a misconfiguration's 500.
  const fwdBusy = scripted(() => json(503, { code: "BUSY", retryable: true, credential: "forwarder" }), () => json(200, {}));
  const r = await fwdBusy.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "x-brain-key": "read-raw", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
  const rBody = await r.json() as { error?: { code?: number } };
  assert(r.status === 200 && rBody.error?.code === -32003 && r.headers.get("retry-after") === "2", `the forwarder's key busy: -32003 with Retry-After (${r.status} ${JSON.stringify(rBody)})`);
  // The registry busy between the key's check and the call: ok, as index.ts shows a busy key.
  const midBusy = scripted(reader, () => json(503, { code: "BUSY", retryable: true }));
  for (const path of ["/worker-status", "/mcp/jobs/job-7"]) {
    const m = await midBusy.fetch(new Request(`http://mcp${path}`, { headers: { "x-brain-key": "read-raw" } }));
    assert(m.status === 200 && (await m.text()) === "ok", `${path} with the registry busy mid-call: ok (${m.status})`);
  }
  const run = await scripted(() => json(200, { name: "laptop", scope: "write", operations: ["run_worker"] }), () => json(503, { code: "BUSY", retryable: true })).fetch(new Request("http://mcp/worker-run", { method: "POST", headers: { "x-brain-key": "write-raw" }, body: "{}" }));
  assert(run.status === 200 && (await run.text()) === "ok", "…and a worker POST: ok");
  // A route's throw: Hono's 500 and one line, however often, not a stack per request.
  const lines: string[] = [];
  const broken = scripted(() => json(401, { code: "UNAUTHORIZED", credential: "forwarder" }), () => json(200, {}), lines);
  const statuses: number[] = [];
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  for (let i = 0; i < 3; i++) statuses.push((await broken.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "x-brain-key": "read-raw", "content-type": "application/json" }, body: "{}" }))).status);
  console.error = originalError;
  assert(same(statuses, [500, 500, 500]) && lines.length === 1 && /forwarder/.test(lines[0]) && errors.length === 0, `a forwarder refused at the endpoint: three 500s, one line, no stack (${statuses}; ${lines.length} lines, ${errors.length} errors)`);
  // A route's throw is said as a route's, with the REST core's address (review pass 4).
  const named: string[] = [];
  // A REST core that answers whoami 500: a route's throw, said as the route's (a forwarder refused is said as the misconfiguration, review pass 6 of PR 4b).
  const brokenNamed = createMcpApp({ rest: createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async () => json(500, { code: "FAILED", message: "the registry threw" }) }), edge: () => ({ configured: false, origin: null }), warn: (l) => named.push(l), restUrl: "http://api.test:8000" });
  await (await brokenNamed.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "x-brain-key": "read-raw", "content-type": "application/json" }, body: "{}" }))).text();
  assert(named.length === 1 && named[0].includes("POST a route failed") && named[0].includes("(REST core at http://api.test:8000)"), `a route's throw: named as a route's, the REST core's address beside it (${named[0]?.slice(0, 90)})`);
  // A client gone while its key is asked: the abandoned line's, not a fault line (review pass 4).
  const quiet: string[] = [];
  let releaseWhoami: () => void = () => {};
  const held = new Promise<void>((done) => { releaseWhoami = done; });
  const slowWhoami = createMcpApp({
    rest: createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async (req) => { await held; if (req.signal.aborted) throw req.signal.reason; return reader(); } }),
    edge: () => ({ configured: false, origin: null }),
    warn: (l) => quiet.push(l),
  });
  const leaving = new AbortController();
  const pendingAnswer = slowWhoami.fetch(new Request("http://mcp/mcp", { method: "POST", signal: leaving.signal, headers: { "x-brain-key": "read-raw", "content-type": "application/json" }, body: "{}" }));
  await Bun.sleep(20);
  leaving.abort();
  releaseWhoami();
  await Promise.resolve(pendingAnswer).catch(() => null);
  assert(!quiet.some((l) => /failed|could not be found/.test(l)), `a client gone during whoami: no fault line (${quiet.join(" | ") || "none"})`);
  // The entry: Bun's longest idle timeout — its 10 s default cuts a GET whose handler has not answered — and a base it cannot serve refused in words.
  const entry = (await import("./index.ts")).default as { idleTimeout?: number };
  assert(entry.idleTimeout === 255, `the entry's idle timeout is Bun's ceiling (${entry.idleTimeout})`);
  const badBase = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, OB1_FORWARDER_KEY: "x".repeat(64), OB1_REST_URL: "http://api?x=1" }, stdout: "pipe", stderr: "pipe" });
  const code = await badBase.exited;
  const said = await new Response(badBase.stderr).text();
  assert(code === 2 && /OB1_REST_URL/.test(said) && !/\n\s+at /.test(said), `a base the client refuses: exit 2, in words, no stack (${code}: ${said.trim().slice(0, 80)})`);
  const withPassword = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, OB1_FORWARDER_KEY: "x".repeat(64), OB1_REST_URL: "http://svc:hunter2pass@api" }, stdout: "pipe", stderr: "pipe" });
  const pwCode = await withPassword.exited;
  const pwSaid = await new Response(withPassword.stderr).text();
  assert(pwCode === 2 && !pwSaid.includes("hunter2pass") && /credentials/.test(pwSaid), `a base carrying credentials: refused without printing them (${pwSaid.trim().slice(0, 90)})`);
  // Imported, not run, the entry leaves a bad base to its importer: a throw, never the importer's exit 2 (review pass 4).
  const imported = Bun.spawn(["bun", "-e", "await import('./index.ts').catch((e) => { console.log('threw: ' + e.message.slice(0, 40)); process.exit(0); })"], { cwd: import.meta.dir, env: { ...process.env, OB1_FORWARDER_KEY: "x".repeat(64), OB1_REST_URL: "http://api?x=1" }, stdout: "pipe", stderr: "pipe" });
  const impCode = await imported.exited;
  const impSaid = await new Response(imported.stdout).text();
  assert(impCode === 0 && impSaid.startsWith("threw: "), `imported with a bad base: it throws to its importer (${impCode}: ${impSaid.trim()})`);
}

console.log("\n[8e] An enabled plugin's operation: a tool where whoami names it, called on the REST core by its route, said as index.ts says it");
{
  // A plugin of the suite's own: a value, a value with a field named `refusal`, a refusal, a throw, and a write.
  let thrown = false;
  const probe = definePlugin({
    name: "probe-kit", title: "Probe", description: "The suite's own plugin.",
    operations: {
      item: operation({
        title: "An item", description: "Echoes its path field.", scope: "read", method: "GET", path: "/items/{item_id}",
        input: { item_id: z.string(), verbose: z.boolean().default(false) }, output: { item_id: z.string(), verbose: z.boolean(), refusal: z.object({ note: z.string() }).optional() },
        async handler(_ctx, input) {
          if (input.item_id === "boom") { thrown = true; throw new Error("the plugin's own fault"); }
          if (input.item_id === "gone") return pluginRefuse(404, "ITEM_GONE", { item_id: input.item_id, message: "no such item" });
          return pluginOk({ item_id: input.item_id, verbose: input.verbose, ...(input.item_id === "odd" ? { refusal: { note: "a field of its own" } } : {}) });
        },
      }),
      pin: operation({
        title: "Pin", description: "A write.", scope: "write", method: "POST", path: "/pins",
        input: { text: z.string() }, output: { pinned: z.string() },
        async handler(_ctx, input) { return pluginOk({ pinned: input.text }); },
      }),
      // Steps that would not give the same value parsed twice, or refuse their own output (review pass 2).
      shape: operation({
        title: "Shape", description: "Echoes what its steps made.", scope: "read", method: "POST", path: "/shape",
        input: { n: z.preprocess((v) => Number(v) + 1, z.number()), flag: z.stringbool(), word: z.string().overwrite((w) => `${w}!`) }, output: { n: z.number(), flag: z.boolean(), word: z.string() },
        async handler(_ctx, input) { return pluginOk({ n: input.n, flag: input.flag, word: input.word }); },
      }),
      vet: operation({
        title: "Vet", description: "An async refinement.", scope: "read", method: "POST", path: "/vet",
        input: { s: z.string().refine(async (v) => v.length > 0, "empty") }, output: { s: z.string() },
        async handler(_ctx, input) { return pluginOk({ s: input.s }); },
      }),
      tally: operation({
        title: "Tally", description: "A default a step changes.", scope: "read", method: "POST", path: "/tally",
        input: { n: z.number().default(1).transform((x) => x + 1) }, output: { n: z.number() },
        async handler(_ctx, input) { return pluginOk({ n: input.n }); },
      }),
      seek: operation({
        title: "Seek", description: "A GET's steps.", scope: "read", method: "GET", path: "/seek",
        input: { n: z.number().transform((x) => x + 1), flag: z.stringbool() }, output: { n: z.number(), flag: z.boolean() },
        async handler(_ctx, input) { return pluginOk({ n: input.n, flag: input.flag }); },
      }),
    },
  });
  const other = definePlugin({
    name: "other-kit", title: "Other", description: "A plugin the REST core runs and the MCP server was not given.",
    operations: { look: operation({ title: "Look", description: "d", scope: "read", method: "GET", path: "/look", input: {}, output: {}, async handler() { return pluginOk({}); } }) },
  });
  const restWithPlugins = createRestApp({
    core,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: [`laptop:write:${hashKey("write-raw")}`, `chatgpt:read:${hashKey("read-raw")}`, `hook:capture:${hashKey("cap-raw")}`, `mcp:forward:${hashKey("fwd-raw")}`].join(",") }),
    resolve: async (p) => ({ status: "ok", agentId: p.scope === "forward" ? "agent-f" : "agent-1" }),
    track: (run) => run(),
    log: () => {},
    plugins: () => loadPlugins("probe-kit, other-kit", [probe, other]),
  });
  const sentPaths: string[] = [];
  const pluginRest = createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async (req) => { sentPaths.push(`${req.method} ${new URL(req.url).pathname}`); return restWithPlugins.fetch(req); } });
  const pluginWarned: string[] = [];
  const withPlugins = createMcpApp({ rest: pluginRest, plugins: () => loadPlugins("probe-kit", [probe]), edge: () => ({ configured: false, origin: null }), warn: (l) => pluginWarned.push(l) });
  const ask = async (method: string, params: unknown, key: string) => {
    const r = await withPlugins.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    const text = await r.text();
    return JSON.parse(text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6)) as { result?: Record<string, unknown>; error?: { message: string } };
  };
  const callTool = async (name: string, args: Record<string, unknown>, key = "read-raw"): Promise<Reply> => {
    const result = ((await ask("tools/call", { name, arguments: args }, key)).result ?? {}) as { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { text: (result.content ?? []).map((c) => c.text).join("\n"), sc: result.structuredContent ?? {}, isError: result.isError === true };
  };

  type Listed = { name: string; annotations?: { readOnlyHint?: boolean }; outputSchema?: { properties?: Record<string, unknown> } };
  const listOf = async (key: string) => ((await ask("tools/list", {}, key)).result?.tools ?? []) as Listed[];
  const read = await listOf("read-raw");
  const names = read.map((t) => t.name);
  assert(same(names, [...names.filter((n) => !n.startsWith("probe_kit_")), "probe_kit_item", "probe_kit_shape", "probe_kit_vet", "probe_kit_tally", "probe_kit_seek"]) && names.includes("search"), `a read key: the core's tools, then its plugin operations in the manifest's order, as index.ts lists them (${names.slice(-3).join(", ")})`);
  const item = read.find((t) => t.name === "probe_kit_item");
  assert(item?.annotations?.readOnlyHint === true && item.outputSchema?.properties !== undefined && "item_id" in item.outputSchema.properties, "…with the manifest's read-only hint and output schema");
  assert(!names.includes("other_kit_look"), "a plugin the REST core runs and this server was not given: no tool here");
  await listOf("read-raw");
  assert(pluginWarned.length === 1 && pluginWarned[0].includes("other_kit_look") && pluginWarned[0].includes("OB1_PLUGINS"), `…said once in the log, naming the operation and OB1_PLUGINS (${pluginWarned.join(" | ")})`);
  assert((await listOf("write-raw")).some((t) => t.name === "probe_kit_pin") && !names.includes("probe_kit_pin"), "a write operation: a write key's tool, not a read key's");
  assert(!(await listOf("cap-raw")).some((t) => t.name.startsWith("probe_kit_")), "a capture key: no plugin tool");

  // The reply index.ts gives: renderPlugin over runOperation's own outcome, in process, the input as the SDK parses it.
  const ops = loadPlugins("probe-kit", [probe])[0].operations;
  const inProcess = async (key: string, input: Record<string, unknown>, scope: "read" | "write" = "read") => {
    const op = ops.find((o) => o.key === key)!;
    return say.renderPlugin(await runOperation(op, { core, principal: { name: "chatgpt", scope } as Principal }, await op.input.parseAsync(input)));
  };
  sentPaths.length = 0;
  let got = await callTool("probe_kit_item", { item_id: "a b", verbose: true });
  assert(expectReply(got, await inProcess("item", { item_id: "a b", verbose: true })) && sentPaths.includes("GET /v1/plugins/probe-kit/items/a%20b"),
    `a value: renderPlugin's reply, the operation called by its route (${got.text} via ${sentPaths.join(", ")})`);
  got = await callTool("probe_kit_item", { item_id: "odd" });
  assert(expectReply(got, await inProcess("item", { item_id: "odd" })) && got.sc.refusal !== undefined && !got.isError, `a value with a field named refusal: a value still (${got.text.slice(0, 80)})`);
  got = await callTool("probe_kit_item", { item_id: "gone" });
  assert(expectReply(got, await inProcess("item", { item_id: "gone" })) && got.isError,
    `a refusal: renderPlugin's, from the refusal the forwarder slot carried whole (${got.text})`);
  got = await callTool("probe_kit_item", { item_id: "boom" });
  // index.ts says a plugin's throw as say.failed of the error it caught.
  assert(thrown && expectReply(got, say.failed(new Error("the plugin's own fault"))), `a throw: the tool's fault as index.ts says it (${got.text.slice(0, 80)})`);
  // A body behind two byte-order marks, over HTTP as a client sends it, which the SDK's decoder reads: its arguments
  // read too, the steps' value once, never the SDK's parse in their place (review pass 4: it was parsed again).
  const bomJson = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe_kit_shape", arguments: { n: 1, flag: "yes", word: "a" } } });
  assert(argumentsById(`\uFEFF\uFEFF${bomJson}`).get("1") !== undefined && argumentsById(`\uFEFF${bomJson}`).get("1") !== undefined, "argumentsById reads a body behind one or two byte-order marks");
  const served = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => withPlugins.fetch(req) });
  let bomText = "";
  try {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...new TextEncoder().encode(bomJson)]);
    bomText = await (await fetch(`http://127.0.0.1:${served.port}/mcp`, { method: "POST", signal: AbortSignal.timeout(5_000), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw" }, body: bytes })).text();
  } finally {
    served.stop(true);
  }
  const bomLine = bomText.startsWith("{") ? bomText : (bomText.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const bomResult = ((bomLine ? JSON.parse(bomLine) : {}).result ?? {}) as { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  assert(!bomResult.content || expectReply({ text: bomResult.content.map((c) => c.text).join("\n"), sc: bomResult.structuredContent ?? {}, isError: bomResult.isError === true }, await inProcess("shape", { n: 1, flag: "yes", word: "a" })),
    `over HTTP behind two byte-order marks: refused as a body, or the client's arguments with the steps' value once — never their value twice (${bomText.replace(/\s+/g, " ").slice(0, 160)})`);
  for (const [key, args] of [["shape", { n: 1, flag: "yes", word: "a", stray: "an argument the schema does not name" }], ["seek", { n: 1, flag: "true" }]] as const) {
    got = await callTool(`probe_kit_${key}`, args);
    assert(expectReply(got, await inProcess(key, args)) && !got.isError, `${key}: a preprocess, a codec and an overwrite run once, as in process; a stray argument dropped as the SDK drops it (${got.text})`);
  }
  got = await callTool("probe_kit_vet", { s: "ok" });
  assert(expectReply(got, await inProcess("vet", { s: "ok" })) && !got.isError, `an async refinement: parsed and run, as in process (review pass 3: the REST core's sync parse threw) (${got.text})`);
  // No arguments at all: read as {}, as the SDK reads them, the step run once (review pass 3: it fell back to the SDK's parse).
  const bare = ((await ask("tools/call", { name: "probe_kit_tally" }, "read-raw")).result ?? {}) as { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  assert(expectReply({ text: (bare.content ?? []).map((c) => c.text).join("\n"), sc: bare.structuredContent ?? {}, isError: bare.isError === true }, await inProcess("tally", {})), `a call with no arguments: the default's step run once, as in process (${bare.content?.[0]?.text})`);
  // Two calls of one batch under one id: refused, never run with the other's arguments (review pass 3).
  sentPaths.length = 0;
  const batch = await withPlugins.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "write-raw" }, body: JSON.stringify([
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "probe_kit_pin", arguments: { text: "A" } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "probe_kit_pin", arguments: { text: "B" } } },
  ]) }));
  const batchText = await batch.text();
  assert(!sentPaths.some((path) => path.includes("/pins")) && /share the JSON-RPC id 9/.test(batchText) && !batchText.includes('"pinned"'), `a batch whose two calls share an id: both refused, neither sent (${batchText.replace(/\s+/g, " ").slice(0, 120)})`);
  got = await callTool("probe_kit_pin", { text: "hello" }, "write-raw");
  assert(expectReply(got, await inProcess("pin", { text: "hello" }, "write")) && sentPaths.includes("POST /v1/plugins/probe-kit/pins"), `a write: its body sent, its value said (${got.text})`);
  const refusedCall = await ask("tools/call", { name: "probe_kit_pin", arguments: { text: "x" } }, "read-raw");
  assert(JSON.stringify(refusedCall).includes("probe_kit_pin") && (refusedCall.error !== undefined || (refusedCall.result as { isError?: boolean })?.isError === true), "a read key calling a write operation: not its tool, refused before any call");
  {
    // The same plugin tool for a 2026-07-28 client (SMD-4345): its list and its reply, as a 2025-era client's.
    const listed = ((await rpc("tools/list", {}, "read-raw", { modern: true, app: withPlugins })).body?.result as { tools?: Listed[] } | undefined)?.tools ?? [];
    assert(same(listed, read), `a 2026-07-28 client's list holds the plugin's operations as a 2025-era client's does, each definition the same (${listed.filter((t) => t.name.startsWith("probe_kit_")).length} of the plugin's)`);
    const legacyItem = await callTool("probe_kit_item", { item_id: "a b", verbose: true });
    const modernItem = ((await rpc("tools/call", { name: "probe_kit_item", arguments: { item_id: "a b", verbose: true } }, "read-raw", { modern: true, app: withPlugins })).body?.result ?? {}) as { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; resultType?: unknown };
    assert(modernItem.content?.[0]?.text === legacyItem.text && same(modernItem.structuredContent, legacyItem.sc) && modernItem.isError !== true && modernItem.resultType === "complete" && legacyItem.text !== "",
      `…and a call of one answers a 2026-07-28 client as a 2025-era one, its raw arguments read by the call's id (${modernItem.content?.[0]?.text?.slice(0, 60)})`);
  }
  const bad = await ask("tools/call", { name: "probe_kit_item", arguments: { item_id: 7 } }, "read-raw");
  assert(JSON.stringify(bad).includes("item_id") && (bad.error !== undefined || (bad.result as { isError?: boolean })?.isError === true), "an argument its schema refuses: refused by the SDK, before any call");
  // The entry: the plugins OB1_PLUGINS names are its tools, over a REST core that runs them (PR 4a).
  const exampleRest = createRestApp({
    core,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: [`chatgpt:read:${hashKey("read-raw")}`, `mcp:forward:${hashKey("fwd-raw")}`].join(",") }),
    resolve: async (p) => ({ status: "ok", agentId: p.scope === "forward" ? "agent-f" : "agent-1" }),
    track: (run) => run(),
    log: () => {},
    plugins: () => loadPlugins("example"),
  });
  const restServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => exampleRest.fetch(req) });
  // PORT 0: the entry binds a port no one holds and says which (SMD-3296).
  const entry = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, PORT: "0", OB1_LISTEN_HOST: "127.0.0.1", OB1_FORWARDER_KEY: "fwd-raw", OB1_REST_URL: `http://127.0.0.1:${restServer.port}`, OB1_PLUGINS: "example" }, stdout: "pipe", stderr: "pipe" });
  const { port: entryPort } = await childPort(entry, 20_000);
  let entryTools: string[] = [];
  try {
    for (let i = 0; i < 100 && entryTools.length === 0; i++) {
      const r = await fetch(`http://127.0.0.1:${entryPort}/mcp`, { method: "POST", signal: AbortSignal.timeout(2_000), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).catch(() => null);
      if (r?.ok) {
        const text = await r.text();
        entryTools = ((JSON.parse(text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6)).result?.tools ?? []) as { name: string }[]).map((t) => t.name);
      } else await Bun.sleep(50);
    }
  } finally {
    entry.kill();
    await entry.exited;
    restServer.stop(true);
  }
  // What the entry said, when it served no list (review pass 1: a failed start read only "none of 0").
  if (entryTools.length === 0) console.log((await new Response(entry.stderr).text()).split("\n").slice(-10).map((l) => `      ${l}`).join("\n"));
  assert(entryTools.includes("example_recent") && entryTools.includes("search"), `bun index.ts with OB1_PLUGINS=example: a read key's tools/list holds example_recent (${entryTools.filter((n) => n.startsWith("example")).join() || "none"} of ${entryTools.length})`);
  // The entry: a name that is no plugin stops it in words, as it stops the REST core (PR 4a).
  const noPlugin = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, OB1_FORWARDER_KEY: "x".repeat(64), OB1_PLUGINS: "no-such-plugin" }, stdout: "pipe", stderr: "pipe" });
  const npCode = await noPlugin.exited;
  const npSaid = await new Response(noPlugin.stderr).text();
  assert(npCode === 2 && /OB1_PLUGINS/.test(npSaid) && /no-such-plugin/.test(npSaid) && !/\n\s+at /.test(npSaid), `OB1_PLUGINS naming no plugin: exit 2, in words (${npCode}: ${npSaid.trim().slice(0, 90)})`);
}

console.log("\n[8e2] A keyed route's line (review passes 1 to 3 of PR 4b): a fault is `error` FAILED, not a key refused; a keyed HEAD asks the REST core nothing, a keyless one at a mirror is `refused`");
{
  const { useRequestLog } = await import("../server-portable/telemetry.ts");
  const said: string[] = [];
  const before = useRequestLog((l) => said.push(l));
  let sent = 0;
  let healthDown = false;
  let turnedAfterWhoami = false;
  let afterWhoami: Record<string, unknown> | null = null;
  let healthBody: string | null = null;
  const healthAsked: string[] = [];
  const countingWarned: string[] = [];
  const counting = createMcpApp({
    rest: createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async (req) => {
      sent++;
      const path = new URL(req.url).pathname;
      if (path === "/health") healthAsked.push(req.headers.get("x-brain-key") ?? "?");
      if (restDown || (healthDown && path === "/health")) throw new TypeError("fetch failed: connection refused");
      // A streamed body, as a socket's is: one a cancel disturbs, where a string's survives it.
      const streamed = (body: unknown) => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(JSON.stringify(body))); ctl.close(); } }), { status: 401, headers: { "content-type": "application/json" } });
      if (turnedAfterWhoami && path !== "/v1/whoami") return streamed({ code: "REVOKED" });
      if (afterWhoami && path !== "/v1/whoami") return streamed(afterWhoami);
      if (healthBody !== null && path === "/health") return new Response(healthBody, { status: 200, headers: { "content-type": "application/json" } });
      return restApp.fetch(req);
    } }),
    edge: () => ({ configured: false, origin: null }),
    warn: (l) => countingWarned.push(l),
  });
  try {
    restDown = true;
    const r = await counting.fetch(new Request("http://mcp/worker-status", { headers: { "x-brain-key": "read-raw" } }));
    const answered = await r.text();
    restDown = false;
    const line = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    assert(r.status === 200 && answered === "ok" && line.outcome === "error" && line.code === "FAILED" && line.route === "/worker-status",
      `the REST core away at a mirror: shown \`ok\`, its line \`error\` FAILED, not \`refused\` (${said.at(-1)})`);
    sent = 0;
    const head = await counting.fetch(new Request("http://mcp/health", { method: "HEAD", headers: { "x-brain-key": "read-raw" } }));
    const headLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    assert(head.status === 200 && sent === 0 && headLine.method === "HEAD" && headLine.outcome === "ok" && headLine.route === "/health",
      `a keyed HEAD at /health: liveness at once, nothing sent to the REST core, its line \`ok\` (${sent} sent; ${said.at(-1)})`);
    // The mirrors' keyed HEADs the same, as index.ts answers them before the key's check (review pass 2).
    for (const [path, route] of [["/worker-status", "/worker-status"], ["/jobs/00000000-0000-4000-8000-000000000009", "/jobs/:id"], ["/jobs/00000000-0000-4000-8000-000000000009/stream", "/jobs/:id/stream"]] as const) {
      sent = 0;
      const r = await counting.fetch(new Request(`http://mcp${path}`, { method: "HEAD", headers: { "x-brain-key": "read-raw" } }));
      const l = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
      assert(r.status === 200 && sent === 0 && l.outcome === "ok" && l.route === route, `a keyed HEAD at ${route}: liveness at once, nothing sent (${sent} sent; ${said.at(-1)})`);
    }
    // A keyless HEAD at a mirror is a caller shown nothing, `refused`, as index.ts's (review pass 3: no test held it).
    for (const [path, route] of [["/worker-status", "/worker-status"], ["/jobs/00000000-0000-4000-8000-000000000009", "/jobs/:id"], ["/jobs/00000000-0000-4000-8000-000000000009/stream", "/jobs/:id/stream"]] as const) {
      sent = 0;
      const r = await counting.fetch(new Request(`http://mcp${path}`, { method: "HEAD" }));
      const l = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
      assert(r.status === 200 && sent === 0 && l.outcome === "refused" && l.route === route && !("agent" in l), `a keyless HEAD at ${route}: shown nothing, \`refused\`, no key named (${said.at(-1)})`);
    }
    // A key the registry revoked between its check and the call: `refused` REVOKED, shown `ok`, as index.ts reads it — never a fault, nor a poll's 500 (review pass 3).
    turnedAfterWhoami = true;
    for (const [path, route, method, key] of [
      ["/worker-status", "/worker-status", "GET", "read-raw"],
      ["/jobs/00000000-0000-4000-8000-000000000009", "/jobs/:id", "GET", "read-raw"],
      ["/jobs/00000000-0000-4000-8000-000000000009/stream", "/jobs/:id/stream", "GET", "read-raw"],
      ["/worker-retry-failed", "/worker-retry-failed", "POST", "write-raw"],
    ] as const) {
      const r = await counting.fetch(new Request(`http://mcp${path}`, { method, headers: { "x-brain-key": key, ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) }));
      const text = await r.text();
      const l = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
      assert(r.status === 200 && text === "ok" && l.outcome === "refused" && l.code === "REVOKED" && l.route === route, `a key revoked after whoami at ${route}: \`refused\` REVOKED, shown \`ok\` (${r.status} ${said.at(-1)})`);
    }
    turnedAfterWhoami = false;
    // The stream's other 401s: an unknown key `refused` with no code, never the 500 a body read after its cancel gave (review pass 4).
    afterWhoami = { code: "UNAUTHORIZED" };
    const unknownAt = await counting.fetch(new Request("http://mcp/jobs/00000000-0000-4000-8000-000000000009/stream", { headers: { "x-brain-key": "read-raw" } }));
    await unknownAt.text();
    const unknownLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    assert(unknownAt.status === 200 && unknownLine.outcome === "refused" && !("code" in unknownLine), `a 401 UNAUTHORIZED at the stream after whoami: \`refused\`, no code, no 500 (${unknownAt.status} ${said.at(-1)})`);
    // This server's forwarder revoked mid-call is its misconfiguration, as standingOf reads it — not the caller's key (review pass 4).
    afterWhoami = { code: "REVOKED", credential: "forwarder" };
    countingWarned.length = 0;
    // A tool call first: its fault said in the log too (review pass 6: a tool's was never said).
    const fwdTool = await counting.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "thought_stats", arguments: {} } }) }));
    const toolText = await fwdTool.text();
    const toolSaid = [...countingWarned];
    const fwdAt = await counting.fetch(new Request("http://mcp/worker-status", { headers: { "x-brain-key": "read-raw" } }));
    await fwdAt.text();
    const fwdLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    const fwdSaid = [...countingWarned];
    const fwdPoll = await counting.fetch(new Request("http://mcp/jobs/00000000-0000-4000-8000-000000000009", { headers: { "x-brain-key": "read-raw" } }));
    await fwdPoll.text();
    const fwdPollLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    const fwdStream = await counting.fetch(new Request("http://mcp/jobs/00000000-0000-4000-8000-000000000009/stream", { headers: { "x-brain-key": "read-raw" } }));
    await fwdStream.text();
    const fwdStreamLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    afterWhoami = null;
    assert(toolSaid.length === 1 && /this server is misconfigured.*forwarder key.*OB1_FORWARDER_KEY/.test(toolSaid[0]), `a forwarder revoked during a tool call: said in the log as this server's misconfiguration, the fix beside it (review pass 6) (${toolSaid.join(" | ")})`);
    assert(toolText.includes("forwarder key") && !toolText.includes("OB1_FORWARDER_KEY") && !toolText.includes("MCP_ACCESS_KEYS"), `…the client told the forwarder was refused, never this server's settings (${toolText.replace(/\s+/g, " ").slice(0, 160)})`);
    assert(fwdLine.outcome === "error" && fwdLine.code === "FAILED" && fwdSaid.length === 1, `…at a mirror \`error\` FAILED, and no second line: one misconfiguration, one line (${fwdSaid.join(" | ")})`);
    assert(countingWarned.length === 1, `…the poll and the stream adding none, every route saying it in the one line (${countingWarned.join(" | ")})`);
    assert(fwdPoll.status === 500 && fwdPollLine.outcome === "error", `…a 500 \`error\` at the job poll (${fwdPoll.status} ${JSON.stringify(fwdPollLine)})`);
    assert(fwdStreamLine.outcome === "error" && fwdStreamLine.status === 500, `…and at the stream, a 500 \`error\` as at the poll, not the caller's key refused (review pass 5) (${JSON.stringify(fwdStreamLine)})`);
    // A record asked for the first key that could decide alone, as index.ts reads the first key that matches (review pass 5):
    // two valid keys, one read; an unknown key first, its read and the next key's.
    healthAsked.length = 0;
    await (await counting.fetch(new Request("http://mcp/health", { headers: { "x-brain-key": "read-raw", "x-access-key": "write-raw" } }))).text();
    const twoValid = [...healthAsked];
    healthAsked.length = 0;
    await (await counting.fetch(new Request("http://mcp/health", { headers: { "x-brain-key": "bogus-raw", "x-access-key": "read-raw" } }))).text();
    const unknownFirst = [...healthAsked];
    assert(same(twoValid, ["read-raw"]) && same(unknownFirst, ["bogus-raw", "read-raw"]), `/health's record asked for the first key that could decide alone (two valid: ${twoValid.join()}; unknown first: ${unknownFirst.join()})`);
    // /health answered with no record: `error` FAILED, not a string's characters served as fields (review pass 3).
    healthBody = JSON.stringify("garbage");
    const junk = await counting.fetch(new Request("http://mcp/health", { headers: { "x-brain-key": "read-raw" } }));
    const junkText = await junk.text();
    healthBody = null;
    const junkLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    assert(junkText === "ok" && junkLine.outcome === "error" && junkLine.code === "FAILED", `/health answered with no record: liveness, its line \`error\` FAILED (${junkText.slice(0, 30)}; ${said.at(-1)})`);
    // /health's record call after the key cleared: the REST core gone between the two is `error` FAILED, not the key refused (review pass 2).
    healthDown = true;
    const torn = await counting.fetch(new Request("http://mcp/health", { headers: { "x-brain-key": "read-raw" } }));
    const tornText = await torn.text();
    healthDown = false;
    const tornLine = JSON.parse(said.at(-1) ?? "{}") as Record<string, unknown>;
    assert(torn.status === 200 && tornText === "ok" && tornLine.outcome === "error" && tornLine.code === "FAILED" && tornLine.agent === "chatgpt",
      `/health's record call faulting after whoami cleared the key: liveness, its line \`error\` FAILED, the key named (${said.at(-1)})`);
  } finally {
    restDown = false;
    healthDown = false;
    turnedAfterWhoami = false;
    afterWhoami = null;
    healthBody = null;
    useRequestLog(before);
  }
}

console.log("\n[8f] The entry's stop: it waits for a tool call past its client's request, then cuts it, its line `cut` (SMD-2287 PR 4b)");
{
  // A REST core whose every operation hangs, and the entry in front of it with a short grace: the stop finds a tool call running.
  const hangingCore = new Proxy({}, { get: () => () => new Promise(() => {}) }) as unknown as Core;
  const hangingRest = createRestApp({
    core: hangingCore,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: [`laptop:write:${hashKey("write-raw")}`, `mcp:forward:${hashKey("fwd-raw")}`].join(",") }),
    resolve: async (p) => ({ status: "ok", agentId: p.scope === "forward" ? "agent-f" : "agent-1" }),
    track: (run) => run(),
    log: () => {},
  });
  const restServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => hangingRest.fetch(req) });
  // PORT 0: the entry binds a port no one holds and says which (SMD-3296).
  const entry = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, PORT: "0", OB1_LISTEN_HOST: "127.0.0.1", OB1_FORWARDER_KEY: "fwd-raw", OB1_REST_URL: `http://127.0.0.1:${restServer.port}`, OB1_STOP_GRACE: "3", OB1_PLUGINS: "" }, stdout: "pipe", stderr: "pipe" });
  const { port, stdout: entryOut } = await childPort(entry, 20_000);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false);
    if (!up) await Bun.sleep(50);
  }
  const pending = fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "write-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "thought_stats", arguments: {} } }) }).then((r) => r.text()).catch(() => "gone");
  await Bun.sleep(300);
  entry.kill("SIGTERM");
  const hung = setTimeout(() => entry.kill("SIGKILL"), 10_000);
  const code = await entry.exited;
  clearTimeout(hung);
  await pending;
  restServer.stop(true);
  const out = await entryOut.rest();
  const err = await new Response(entry.stderr).text();
  const lines = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
  const cut = lines.filter((l) => l.door === "mcp" && l.tool === "thought_stats");
  assert(up && cut.length === 1 && cut[0].outcome === "cut" && cut[0].agent === "laptop" && /SIGTERM: no longer accepting; .*1 tool call running/.test(out) && /cut off by the server's stop/.test(err),
    `SIGTERM with a tool call running: the stop waits on it, then cuts it, one \`cut\` line naming its key (exit ${code}; ${JSON.stringify(cut)}; ${err.split("\n").filter(Boolean).slice(0, 2).join(" | ").slice(0, 200)})`);
}

console.log("\n[8h] The entry's stop with listen streams held (SMD-4347 PR 2a): it waits for the rest and closes each stream itself, with its closing frame, after its flush or at its cut; a server that holds none stops as before; each stream's end recorded (SMD-4459)");
{
  const counted = { total: 3, oldest: "2026-10-01T00:00:00Z", newest: "2026-10-02T00:00:00Z", types: { idea: 3 }, topics: { rest: 2 }, people: {}, aggregated: 3 };
  const restServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => restApp.fetch(req) });
  // An entry given this collector sends its spans here: today's entry, first below, and the second and third holding
  // entries, the one whose drain finishes, with its flush before its streams are closed, and the one that is cut. The
  // first holding entry has none, and the three after them a collector that never answers.
  // The environment's own OTEL_* is set aside, as [8g] does.
  const exported: string[] = [];
  // …and its metric exports, for the count of open streams (SMD-4458).
  const metered: string[] = [];
  /** When each of those arrived, by the suite's clock. */
  const meteredAt: number[] = [];
  // …and its log records, for a stream's end (SMD-4459).
  const logged: string[] = [];
  const collector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/traces") exported.push(await req.text());
    else if (path === "/v1/logs") logged.push(await req.text());
    else if (path === "/v1/metrics") {
      metered.push(await req.text());
      meteredAt.push(performance.now());
    }
    return Response.json({});
  } });
  type OtlpValue = { stringValue?: string; intValue?: number | string; doubleValue?: number };
  type OtlpPairs = { key: string; value: OtlpValue }[];
  const pairsOf = (pairs: OtlpPairs | undefined) => Object.fromEntries((pairs ?? []).map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue ?? value.doubleValue)]));
  /** The log records the collector has had since the `from`th export, each with its name and its body's fields. */
  const recordsOf = (from: number) => logged.slice(from).flatMap((t) => (JSON.parse(t) as { resourceLogs: { scopeLogs: { logRecords: { eventName?: string; severityText?: string; traceId?: string; spanId?: string; body?: { kvlistValue?: { values: OtlpPairs } } }[] }[] }[] }).resourceLogs)
    .flatMap((r) => r.scopeLogs).flatMap((x) => x.logRecords).map((r) => ({ name: r.eventName, severity: r.severityText, body: pairsOf(r.body?.kvlistValue?.values), under: `${r.traceId ?? ""}${r.spanId ?? ""}` }));
  /** A histogram's points in the last export since the `from`th that carries it (its counts are cumulative): each one's labels, count and sum. */
  const histogramOf = (name: string, from: number) => (metered.slice(from).map((t) => (JSON.parse(t) as { resourceMetrics: { scopeMetrics: { metrics: { name: string; histogram?: { dataPoints: { attributes?: OtlpPairs; count: number | string; sum?: number }[] } }[] }[] }[] }).resourceMetrics
    .flatMap((r) => r.scopeMetrics).flatMap((x) => x.metrics).filter((m) => m.name === name).flatMap((m) => m.histogram?.dataPoints ?? [])).filter((points) => points.length > 0).at(-1) ?? [])
    .map((pt) => ({ labels: pairsOf(pt.attributes), count: Number(pt.count), sum: pt.sum ?? 0 }));
  type Point = { asDouble?: number; asInt?: number | string };
  /** The points of one metric, a gauge's or a sum's, among the exports the collector has had since the `from`th, each export's in turn; where times are given, those that arrived between them. */
  const pointsOf = (name: string, from: number, after = -Infinity, before = Infinity) => metered.slice(from).filter((_, i) => meteredAt[from + i] > after && meteredAt[from + i] < before).flatMap((t) => (JSON.parse(t) as { resourceMetrics: { scopeMetrics: { metrics: { name: string; gauge?: { dataPoints: Point[] }; sum?: { dataPoints: Point[] } }[] }[] }[] }).resourceMetrics)
    .flatMap((r) => r.scopeMetrics).flatMap((x) => x.metrics).filter((m) => m.name === name).flatMap((m) => m.gauge?.dataPoints ?? m.sum?.dataPoints ?? []).map((pt) => Number(pt.asDouble ?? pt.asInt));
  /** The spans the collector has been sent for listen requests, by count. */
  const listenSpans = () => exported.flatMap((t) => (JSON.parse(t) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans).flatMap((r) => r.scopeSpans).flatMap((x) => x.spans).filter((x) => /subscriptions\/listen/.test(x.name)).length;
  const envOf = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OTEL_"))), PORT: "0", OB1_LISTEN_HOST: "127.0.0.1", OB1_FORWARDER_KEY: "fwd-raw", OB1_REST_URL: `http://127.0.0.1:${restServer.port}`, OB1_STOP_GRACE: "3", OB1_PLUGINS: "" };
  /** The entry in a process of its own: as it is, or as it will be once it holds listen streams (test-listen-on.ts). */
  const start = async (holding: boolean, collectorPort: number | null = holding ? collector.port! : null, warmed = true, more: Record<string, string> = {}) => {
    const entry = Bun.spawn(holding ? ["bun", "--preload", "./test-listen-on.ts", "index.ts"] : ["bun", "index.ts"], { cwd: import.meta.dir, env: { ...envOf, ...(collectorPort !== null ? { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}` } : {}), ...more }, stdout: "pipe", stderr: "pipe" });
    const { port, stdout } = await childPort(entry, 20_000);
    const errs = watchStream(entry.stderr);
    // Not warmed: no request is sent it, its health probe neither, so it has yet to learn its server (it does from its first request).
    let up = !warmed && port > 0;
    for (let i = 0; warmed && i < 100 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false);
      if (!up) await Bun.sleep(50);
    }
    // The SDK loads after the server answers: its start line, before the requests whose spans are read.
    if (collectorPort !== null) up = (await errs.until(/ go to \S+ over OTLP\/HTTP/, 10_000)) && up;
    const url = `http://127.0.0.1:${port}/mcp`;
    /** A 2026-07-28 request to it, as requestFor builds one. */
    const send = async (method: string, params: unknown, key = "write-raw") => {
      const made = requestFor(method, params, key, { modern: true });
      // An entry that never came up answers nothing: said as an answer of its own, so its rows fail and the suite goes on.
      return fetch(url, { method: "POST", headers: made.headers, body: await made.text(), signal: AbortSignal.timeout(15_000) }).catch((e: Error) => new Response(`(unsent: ${e.message})`, { status: 599 }));
    };
    /** The stop: SIGTERM, and what the entry said and how it left, with how long it took. */
    const stop = async () => {
      const t0 = performance.now();
      entry.kill("SIGTERM");
      const hung = setTimeout(() => entry.kill("SIGKILL"), 10_000);
      const code = await entry.exited;
      clearTimeout(hung);
      const ms = performance.now() - t0;
      const out = await stdout.rest();
      const err = await errs.rest();
      const lines = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
      return { code, ms, out, err, lines };
    };
    return { up, send, stop, url, port };
  };
  /** A stream read to its end, with when it ended; "(still open)" if it had not by the deadline. */
  const toEnd = (r: Response) => {
    let endedAt = 0;
    const text = Promise.race([r.text().then((t) => { endedAt = performance.now(); return t; }, (e: Error) => { endedAt = performance.now(); return `(dropped: ${e.message})`; }), Bun.sleep(8_000).then(() => "(still open)")]);
    return { text, endedAt: () => endedAt };
  };
  const listenParams = { notifications: { toolsListChanged: true } };
  const capabilityOf = async (e: Awaited<ReturnType<typeof start>>) =>
    ((firstMessage(await (await e.send("server/discover", {}, "read-raw")).text())?.result ?? {}) as { capabilities?: { tools?: { listChanged?: unknown } } }).capabilities?.tools?.listChanged;

  // A collector that never answers: a stop's flush then holds the process for its whole bound: 1.8 s of a grace of 3 after a finished drain, a second after a cut.
  const silent = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  try {
    // The entry as it is: it says it holds no stream, and its stop says nothing of one.
    answer = () => ok({});
    const plain = await start(false, collector.port!);
    const plainSays = await capabilityOf(plain);
    // A listen, which it acknowledges honouring nothing and ends: no stream held, so no end to say (below).
    const plainListened = await (await plain.send("subscriptions/listen", listenParams)).text();
    const plainStopped = await plain.stop();
    /** The listen spans today's entry sent this collector, which the holding entries' counts below leave out. */
    const plainListenSpans = listenSpans();
    assert(plain.up && plainSays === false && plainStopped.code === 0 && !/held open/.test(plainStopped.out), `the entry as it is holds no listen stream, and stops as before (listChanged ${plainSays}; exit ${plainStopped.code}; ${plainStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);
    // …and it sends no count of streams (SMD-4458): its metrics reached the collector, the uptime gauge among them, and no such series.
    assert(pointsOf("process.uptime", 0).length >= 1 && pointsOf("ob1.mcp.listen_streams", 0).length === 0,
      `…and its metrics, sent at its stop, hold no count of listen streams (${pointsOf("process.uptime", 0).length} uptime point(s); ${JSON.stringify(pointsOf("ob1.mcp.listen_streams", 0))})`);
    // …and nothing of a stream's end (SMD-4459): no such line, no such record, no such series.
    assert(plainListened.includes('"resultType":"complete"') && plainStopped.lines.filter((l) => l.rpc === "subscriptions/listen" && l.outcome === "ok").length === 1 && plainListenSpans === 1
      && !plainStopped.lines.some((l) => "event" in l) && recordsOf(0).length >= 1 && recordsOf(0).every((r) => r.name === "ob1.request") && histogramOf("ob1.mcp.listen_stream.duration", 0).length === 0 && histogramOf("http.server.request.duration", 0).length >= 1,
      `…and of a listen it answers and ends at once it says no end: one request's line, no \`listen_end\` line, its log records all requests', and no histogram of time held beside the requests' own (${plainStopped.lines.filter((l) => l.rpc === "subscriptions/listen").length} listen line(s), ${plainStopped.lines.filter((l) => "event" in l).length} end line(s); ${JSON.stringify([...new Set(recordsOf(0).map((r) => r.name))])}; ${histogramOf("ob1.mcp.listen_stream.duration", 0).length} point(s) of time held, ${histogramOf("http.server.request.duration", 0).length} of requests; ${plainListenSpans} listen span(s))`);
    // …and its cut is the one it had: the connections go at the bound. A call of each revision whose work ends 300 ms
    // after it is not answered then, though a silent collector holds the process a second longer.
    answer = (n) => (n === "thoughtStats" ? Bun.sleep(1_500).then(() => ok(counted)) : ok({}));
    const plainCutting = await start(false, silent.port!);
    const plainAnswers = [true, false].map((modern) => fetch(plainCutting.url, { method: "POST", headers: requestFor("tools/call", { name: "thought_stats", arguments: {} }, "write-raw", { modern }).headers, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "thought_stats", arguments: {}, ...(modern ? { _meta: ENVELOPE } : {}) } }) })
      .then((r) => r.text().then((t) => (/Total thoughts/.test(t) ? "answered in full" : `ended with ${t.length} bytes`), () => "dropped"), () => "dropped"));
    await Bun.sleep(200);
    const plainCut = await plainCutting.stop();
    const plainGot = await Promise.all(plainAnswers);
    answer = () => ok({});
    assert(plainCutting.up && plainCut.code === 1 && plainGot.every((x) => x === "dropped") && plainCut.lines.filter((l) => l.outcome === "cut").length === 2 && /2 requests still in flight.*closed unfinished/.test(plainCut.out) && !/held open/.test(plainCut.out),
      `…and it cuts as before: two calls whose work ends after the bound are dropped at it, not answered in the second its flush then takes (${plainGot.join(", ")}; exit ${plainCut.code} in ${Math.round(plainCut.ms)} ms; ${plainCut.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);

    // The entry holding streams, with one open and nothing else in flight: no wait, the stream's closing frame, exit 0. No collector here; the next two stops have one.
    const alone = await start(true, null);
    const aloneSays = await capabilityOf(alone);
    const stream = await alone.send("subscriptions/listen", listenParams);
    const streamEnd = toEnd(stream);
    await Bun.sleep(200);
    const stopped = await alone.stop();
    const streamText = await streamEnd.text;
    const listenLines = stopped.lines.filter((l) => l.rpc === "subscriptions/listen");
    assert(alone.up && aloneSays === true && stream.status === 200 && stopped.code === 0 && stopped.ms < 500
      && /SIGTERM: no longer accepting; 0 requests in flight.*; 1 stream held open, not waited on \(SMD-4347\)/.test(stopped.out) && /SIGTERM: stopped in .*; 1 held stream closed; exit 0/.test(stopped.out),
      `a stop with one listen stream open and nothing else: not waited on, closed, exit 0 in under half its bound of a second (listChanged ${aloneSays}; exit ${stopped.code} in ${Math.round(stopped.ms)} ms; ${stopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);
    assert(streamText.includes("notifications/subscriptions/acknowledged") && streamText.includes('"resultType":"complete"') && !streamText.startsWith("(") && !streamText.includes("(dropped"),
      `…its client reads the stream's closing frame before the connection goes (${JSON.stringify(streamText.slice(-160))})`);
    assert(listenLines.length === 1 && listenLines[0].outcome === "ok" && listenLines[0].status === 200 && listenLines[0].agent === "laptop" && !stopped.lines.some((l) => l.outcome === "cut" || l.outcome === "abandoned" || l.outcome === "stalled") && !/abandoned|cut off/.test(stopped.err),
      `…and the log has one line for the stream, \`ok\`, and nothing cut, abandoned or stalled (${JSON.stringify(listenLines)}; ${stopped.err.split("\n").filter((l) => /abandoned|cut off/.test(l)).join(" | ").slice(0, 200)})`);
    // Its end (SMD-4459): one line more, the stop's, written as the drain ends: after the stop's first line and before its last.
    const aloneEnds = stopped.lines.filter((l) => l.event === "listen_end");
    const aloneOut = stopped.out.split("\n");
    const endAt = aloneOut.findIndex((l) => l.includes('"event":"listen_end"'));
    assert(aloneEnds.length === 1 && Object.keys(aloneEnds[0]).join() === "ts,door,event,agent,end,held_ms" && aloneEnds[0].door === "mcp" && aloneEnds[0].agent === "laptop" && aloneEnds[0].end === "stop"
      && (aloneEnds[0].held_ms as number) >= 190 && (aloneEnds[0].held_ms as number) < 2_000 && endAt > aloneOut.findIndex((l) => /SIGTERM: no longer accepting/.test(l)) && endAt < aloneOut.findIndex((l) => /SIGTERM: stopped in/.test(l)),
      `…and one line for its end: \`listen_end\`, the stop's, with about the 200 ms it was held, between the stop's two lines; no outcome, no status (${JSON.stringify(aloneEnds)})`);

    // A stream open and a call that ends inside the bound: the call is waited on and answered in full, and the stream closed after it.
    answer = (n) => (n === "thoughtStats" ? Bun.sleep(600).then(() => ok(counted)) : ok({}));
    const meteredBefore = metered.length;
    // Its metrics every second, the shortest the server allows, so that one export reads the stream while it is open.
    const both = await start(true, collector.port!, true, { OTEL_METRIC_EXPORT_INTERVAL: "1000" });
    const heldStream = toEnd(await both.send("subscriptions/listen", listenParams));
    for (let waited = 0; !pointsOf("ob1.mcp.listen_streams", meteredBefore).includes(1) && waited < 5_000; waited += 50) await Bun.sleep(50);
    let callEndedAt = 0;
    const slowCall = both.send("tools/call", { name: "thought_stats", arguments: {} }).then(async (r) => { const t = await r.text(); callEndedAt = performance.now(); return { status: r.status, message: firstMessage(t) }; }, (e: Error) => ({ status: 0, message: { error: e.message } as Record<string, unknown> }));
    await Bun.sleep(200);
    const stopping = both.stop();
    // A connection attempted once the stop has begun is refused: not served, and not answered 500 by a handler closing under it.
    await Bun.sleep(150);
    const late = await fetch(both.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "write-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }), signal: AbortSignal.timeout(2_000) }).then((r) => `answered ${r.status}`, (e: Error) => (e.name === "TimeoutError" ? "timed out" : "refused"));
    const bothStopped = await stopping;
    const answered = await slowCall;
    const heldText = await heldStream.text;
    const total = ((answered.message?.result as { structuredContent?: { total?: unknown } } | undefined)?.structuredContent ?? {}).total;
    assert(bothStopped.code === 0 && answered.status === 200 && total === 3 && heldText.includes('"resultType":"complete"') && callEndedAt > 0 && heldStream.endedAt() >= callEndedAt
      && /1 request in flight.*; 1 stream held open, not waited on/.test(bothStopped.out) && bothStopped.lines.some((l) => l.tool === "thought_stats" && l.outcome === "ok"),
      `a stop with a stream open and a call running: the call is waited on and answered in full, then the stream is closed with its frame, exit 0 (exit ${bothStopped.code} in ${Math.round(bothStopped.ms)} ms; call ${answered.status}, total ${total}; the stream ended ${Math.round(heldStream.endedAt() - callEndedAt)} ms after the call; ${bothStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);
    const spansBoth = listenSpans() - plainListenSpans;
    assert(spansBoth === 1 && /; telemetry sent; 1 held stream closed; exit 0/.test(bothStopped.out), `…and with a collector, the stream's span has been sent by the stop's end (${spansBoth} span(s) in all; ${bothStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM: stopped")).join(" | ")})`);
    // The count of open streams (SMD-4458): 1 while the stream was open, and 0 as the stop's flush read it, though the stream is closed only after that flush.
    // With a collector that answers, the flush's is the last point this server sends: left at 1, a panel that sums the servers would count the stream beside the next server's.
    // And the entry says nothing of a count it could not make: it made it.
    const openSeen = pointsOf("ob1.mcp.listen_streams", meteredBefore);
    assert(openSeen.includes(1) && openSeen.at(-1) === 0 && !/could not be made/.test(bothStopped.err), `…and its metrics hold the count of listen streams: 1 while the stream was open, and 0 at the stop's flush, its last point, with no word at its start of a count not made (${JSON.stringify(openSeen)} in ${metered.length - meteredBefore} export(s))`);
    assert(both.up && late === "refused", `…and a connection attempted after the signal is refused, not served and not answered by a handler that is closing (${late})`);

    // Streams open and a call cut at the bound: the call's line is `cut`, every stream still gets its closing frame, exit 1.
    // Twenty-four of them, under the one name's bound of 32: the frames of many must all have left before the connections are cut.
    answer = (n) => (n === "thoughtStats" ? new Promise(() => {}) : ok({}));
    const meteredAtCut = metered.length;
    // Its metrics every second, and a grace of 4 s, so a drain of 2: at least one export is read during the drain.
    const cutting = await start(true, collector.port!, true, { OTEL_METRIC_EXPORT_INTERVAL: "1000", OB1_STOP_GRACE: "4" });
    const cutStreams = await Promise.all(Array.from({ length: 24 }, async () => toEnd(await cutting.send("subscriptions/listen", listenParams))));
    for (let waited = 0; !pointsOf("ob1.mcp.listen_streams", meteredAtCut).includes(24) && waited < 5_000; waited += 50) await Bun.sleep(50);
    const hungCall = cutting.send("tools/call", { name: "thought_stats", arguments: {} }).then(async (r) => (r.status === 599 ? "no answer: dropped" : `${r.status} ` + (await r.text().then((t) => `ended whole (${t.length} bytes)`, () => "dropped"))));
    // A 2025-era call beside it, which the SDK's handler knows nothing of: cut by the connections' close alone.
    const hungLegacy = fetch(cutting.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "write-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "thought_stats", arguments: {} } }) })
      .then((r) => r.text().then((t) => `${r.status} ended whole (${t.length} bytes)`, () => "dropped"), () => "no answer: dropped");
    await Bun.sleep(200);
    const cutAt = performance.now();
    const cutStopped = await cutting.stop();
    const hung = [await hungCall, await hungLegacy];
    const cutTexts = await Promise.all(cutStreams.map((x) => x.text));
    const framed = cutTexts.filter((t) => t.includes('"resultType":"complete"') && !t.includes("(dropped")).length;
    const cutCall = cutStopped.lines.filter((l) => l.tool === "thought_stats");
    const cutListen = cutStopped.lines.filter((l) => l.rpc === "subscriptions/listen");
    const cutEnds = cutStopped.lines.filter((l) => l.event === "listen_end");
    // By the stop's word and not by its close: the word is said as the drain ends, before the stop's line for what it
    // cut, and the close comes after that line. A close after the drain's end says `stop` too, and would follow it.
    const cutOut = cutStopped.out.split("\n");
    const wordBeforeClose = cutOut.map((l) => l.includes('"event":"listen_end"')).lastIndexOf(true) < cutOut.findIndex((l) => /closed unfinished/.test(l));
    assert(cutStopped.code === 1 && cutCall.length === 2 && cutCall.every((l) => l.outcome === "cut") && cutListen.length === 24 && cutListen.every((l) => l.outcome === "ok") && framed === 24
      && cutEnds.length === 24 && cutEnds.every((l) => l.end === "stop") && new Set(cutEnds.map((l) => l.trace)).size === 24 && cutEnds.every((l) => cutListen.some((o) => o.trace === l.trace)) && wordBeforeClose
      && /2 requests still in flight.*closed unfinished/.test(cutStopped.out) && /24 held streams closed; exit 1/.test(cutStopped.out) && /cut off by the server's stop/.test(cutStopped.err),
      `a stop with 24 streams open and two calls that never end, one of each revision: the calls cut at the bound and counted alone, each line \`cut\`; each stream's line \`ok\`, its closing frame read all the same and its end said once, the stop's, with its opening's trace id, by the stop's word before the stop's line for what it cut (SMD-4459; ${cutEnds.length} end(s) ${JSON.stringify([...new Set(cutEnds.map((l) => l.end))])}, ${new Set(cutEnds.map((l) => l.trace)).size} trace id(s), all before that line ${wordBeforeClose}); exit 1 (exit ${cutStopped.code} in ${Math.round(cutStopped.ms)} ms; ${JSON.stringify(cutCall.map((l) => l.outcome))}; ${cutListen.filter((l) => l.outcome === "ok").length} lines ok; ${framed} of 24 frames read; ${cutStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")}; ${cutStopped.err.split("\n").filter(Boolean).join(" | ").slice(0, 240)})`);
    const spansCut = listenSpans() - plainListenSpans;
    assert(spansCut === 25 && /; telemetry sent; 24 held streams closed; exit 1/.test(cutStopped.out), `…their spans sent too by the stop's end (${spansCut} span(s) in all; ${cutStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM: stopped")).join(" | ")})`);
    // The count of open streams was 24 while they were open, the entry's own count and not a 1 for any; at this stop's flush it is 0 too.
    const openSeenAtCut = pointsOf("ob1.mcp.listen_streams", meteredAtCut);
    assert(openSeenAtCut.includes(24) && openSeenAtCut.at(-1) === 0, `…and the count of open streams its metrics hold: 24 while they were open, and 0 at this stop's flush (${JSON.stringify(openSeenAtCut)})`);
    // During the drain it is still the count: the stop serves its streams until the drain ends, 2 s on here, and only then does the count read 0.
    const openSeenInDrain = pointsOf("ob1.mcp.listen_streams", meteredAtCut, cutAt, cutAt + 1_800);
    assert(openSeenInDrain.length >= 1 && openSeenInDrain.every((n) => n === 24), `…and through the drain the count is the streams still open, 24 in each export the collector had between the signal and 1.8 s on, not the 0 the drain's end brings (${JSON.stringify(openSeenInDrain)})`);
    assert(hung.every((x) => x.endsWith("dropped")) && cutStopped.err.split("\n").filter((l) => /cut off by the server's stop/.test(l)).length === 2,
      `…and each cut call's own answer is dropped with its connection, not ended as a whole answer of nothing; one warning for each (${hung.join(", ")}; ${cutStopped.err.split("\n").filter((l) => /cut off/.test(l)).length} warning(s))`);

    // The end of a stream (SMD-4459), on the entry with a collector. One stream its client closes after 400 ms, one
    // the server ends itself (a listen that asks for nothing), and one held to the stop. Each end is a line, a log
    // record and a point of its own; the stop's is recorded as its drain ends, so its flush sends it, and the
    // request-duration histogram has the three openings and nothing more.
    answer = () => ok({});
    const loggedAtEnds = logged.length;
    const meteredAtEnds = metered.length;
    const ending = await start(true, collector.port!, true, { OTEL_METRIC_EXPORT_INTERVAL: "1000" });
    const leaving = new AbortController();
    const leavingAsk = requestFor("subscriptions/listen", listenParams, "read-raw", { modern: true });
    const askedAt = performance.now();
    const leavingStream = await fetch(ending.url, { method: "POST", headers: leavingAsk.headers, body: await leavingAsk.text(), signal: leaving.signal });
    const openedAt = performance.now();
    void leavingStream.text().catch(() => {});
    await Bun.sleep(400);
    const leftAt = performance.now();
    leaving.abort();
    // Read to its end inside its request, as the server ends it there: its record must be under no span all the same.
    const askedNothing = await (await ending.send("subscriptions/listen", { notifications: {} })).text();
    const staying = toEnd(await ending.send("subscriptions/listen", listenParams));
    await Bun.sleep(250);
    const endingStopped = await ending.stop();
    const stayingText = await staying.text;
    const ends = endingStopped.lines.filter((l) => l.event === "listen_end");
    const opens = endingStopped.lines.filter((l) => l.rpc === "subscriptions/listen");
    const [clientEnd, stopEnd] = [ends.find((l) => l.end === "client"), ends.find((l) => l.end === "stop")];
    assert(ending.up && leavingStream.status === 200 && ends.length === 3 && opens.length === 3 && clientEnd !== undefined && Object.keys(clientEnd).join() === "ts,door,event,agent,end,held_ms,trace" && clientEnd.agent === "chatgpt"
      && (clientEnd.held_ms as number) >= leftAt - openedAt - 1 && (clientEnd.held_ms as number) <= leftAt - askedAt + 250 && clientEnd.trace === opens.find((l) => l.agent === "chatgpt")?.trace && typeof clientEnd.trace === "string",
      `a stream its client closes after 400 ms: one line for its end, \`client\`, under its caller's name, held about as long, with the trace id of the line that opened it (${JSON.stringify(clientEnd)}; closed ${Math.round(leftAt - openedAt)} ms after it opened; ${ends.length} end(s), ${opens.length} opening(s))`);
    assert(endingStopped.code === 0 && stopEnd !== undefined && stopEnd.agent === "laptop" && (stopEnd.held_ms as number) >= 240 && typeof stopEnd.trace === "string" && stopEnd.trace === opens.filter((l) => l.agent === "laptop").at(-1)?.trace && stayingText.includes('"resultType":"complete"')
      && /; telemetry sent; 1 held stream closed; exit 0/.test(endingStopped.out) && endingStopped.ms < 1_000 && !ends.some((l) => "outcome" in l || "status" in l || "method" in l || "rpc" in l)
      && askedNothing.includes('"resultType":"complete"') && ends.filter((l) => l.end === "server" && l.agent === "laptop" && (l.held_ms as number) < 500 && l.trace === opens.filter((o) => o.agent === "laptop")[0]?.trace && l.trace !== stopEnd.trace).length === 1,
      `…and the one held to the stop: one line, \`stop\`, with its own opening's trace id and not the other's under its name, the stream still closed with its frame after the flush, and the stop no longer for it; the one that asked for nothing, \`server\`, with its own; no end's line has anything a request's has (${JSON.stringify(stopEnd)}; exit ${endingStopped.code} in ${Math.round(endingStopped.ms)} ms; ${endingStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM: stopped")).join(" | ")})`);
    const endRecords = recordsOf(loggedAtEnds).filter((r) => r.name === "ob1.listen_end");
    const heldPoints = histogramOf("ob1.mcp.listen_stream.duration", meteredAtEnds);
    const listenRequests = histogramOf("http.server.request.duration", meteredAtEnds).filter((pt) => pt.labels["mcp.method.name"] === "subscriptions/listen");
    const without = (l: Record<string, unknown>) => { const { ts: _ts, ...rest } = l; return JSON.stringify(rest); };
    const listenRecords = recordsOf(loggedAtEnds).filter((r) => r.name === "ob1.request" && r.body.rpc === "subscriptions/listen");
    assert(endRecords.length === 3 && endRecords.every((r) => r.severity === "INFO" && r.under === "") && endRecords.map((r) => JSON.stringify(r.body)).sort().join() === ends.map(without).sort().join()
      && listenRecords.length === 3 && listenRecords.every((r) => r.under.length === 48),
      `…and the collector has each end as a log record of its own name, the stop's among them by the stop's end, its body the line's fields, under no span, the server's own end too, which is said inside its request; the three openings are the requests' records, each under its span (${JSON.stringify(endRecords)})`);
    assert(heldPoints.length === 3 && heldPoints.map((pt) => `${JSON.stringify(pt.labels)} ${pt.count}`).sort().join() === '{"ob1.end":"client"} 1,{"ob1.end":"server"} 1,{"ob1.end":"stop"} 1'
      && Math.abs((heldPoints.find((pt) => pt.labels["ob1.end"] === "client")?.sum ?? 0) - (clientEnd?.held_ms as number) / 1000) < 0.002
      && listenRequests.reduce((n, pt) => n + pt.count, 0) === 3 && listenRequests.every((pt) => pt.labels["ob1.outcome"] === "ok" && pt.sum < 1),
      `…and one point each on the histogram of time held, by how it ended, the stop's sent by its flush; the request-duration histogram has the three openings, \`ok\` and a request's length, and no end (${JSON.stringify(heldPoints)}; ${JSON.stringify(listenRequests.map((pt) => [pt.labels["ob1.outcome"], pt.count, pt.sum]))})`);

    // The holding entry cut with a collector that never answers. Its streams are closed at the bound, each with its
    // frame, and its connections after them, as a server that holds none closes its own: a call's work and a job
    // poll's that come back 300 ms later are answered to no one. The flush then runs out its bound, a second.
    let windowEnded = 0;
    answer = (n) => (n === "thoughtStats" || n === "jobStatus" ? Bun.sleep(1_500).then(() => { windowEnded++; return ok(n === "jobStatus" ? { jobId: "job-7", kind: "scan", status: "succeeded" } : counted); }) : ok({}));
    const windowed = await start(true, silent.port!);
    const windowStreams = await Promise.all([1, 2, 3].map(async () => toEnd(await windowed.send("subscriptions/listen", listenParams))));
    const dropped = (asking: Promise<Response>) => asking.then((r) => (r.status === 599 ? "dropped" : r.text().then((t) => `${r.status} answered with ${t.length} bytes`, () => "dropped")), () => "dropped");
    const windowCall = dropped(windowed.send("tools/call", { name: "thought_stats", arguments: {} }));
    const windowPoll = dropped(fetch(`http://127.0.0.1:${windowed.port}/mcp/jobs/job-7`, { headers: { "x-brain-key": "read-raw" } }));
    await Bun.sleep(200);
    const windowAt = performance.now();
    const windowStopped = await windowed.stop();
    const windowGot = [await windowCall, await windowPoll];
    const windowFramed = (await Promise.all(windowStreams.map((x) => x.text))).filter((t) => t.includes('"resultType":"complete"')).length;
    assert(windowed.up && windowStopped.code === 1 && windowStopped.ms > 1_500 && windowGot.every((x) => x === "dropped") && windowEnded === 2 && windowFramed === 3 && windowStreams.every((x) => x.endedAt() - windowAt < 1_400) && windowStopped.lines.filter((l) => l.outcome === "cut").length === 2
      && /2 requests still in flight.*closed unfinished/.test(windowStopped.out) && /3 held streams closed; exit 1/.test(windowStopped.out),
      `a holding entry cut, its collector silent: the three streams are closed at the bound, their frames read before the flush runs out its bound (${Math.round(Math.max(...windowStreams.map((x) => x.endedAt())) - windowAt)} ms), and the connections after them, so a call and a job poll whose work ends 300 ms on (both seen to end) are not answered, each line \`cut\`; exit 1 (${windowGot.join(", ")}; ${windowFramed} of 3 frames; exit ${windowStopped.code} in ${Math.round(windowStopped.ms)} ms; ${windowStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);

    // A signal before the entry's first request. It has no server to stop accepting, so its listener stays open, as
    // it always has; what is sent it then, through the flush a silent collector holds, is not served: no stream is
    // held, no call run, nothing answered by a handler the stop then closes. (Left serving, it answered a tool call
    // 200 and empty, and a client asking again 500: found in review.)
    let coldAsked = 0;
    answer = (n) => { if (n === "thoughtStats") coldAsked++; return ok(counted); };
    const cold = await start(true, silent.port!, false);
    const coldStopping = cold.stop();
    await Bun.sleep(300);
    const coldGot = await Promise.all([cold.send("subscriptions/listen", listenParams), cold.send("tools/call", { name: "thought_stats", arguments: {} }), cold.send("tools/list", {})].map((asking) => asking.then((r) => (r.status === 599 ? "dropped" : `answered ${r.status}`))));
    const coldStopped = await coldStopping;
    answer = () => ok({});
    assert(cold.up && coldStopped.code === 0 && coldGot.every((x) => x === "dropped") && coldAsked === 0 && coldStopped.lines.length === 3 && coldStopped.lines.every((l) => l.outcome === "cut" && l.status === 0)
      && !/held|has been closed|route failed/.test(coldStopped.out + coldStopped.err),
      `a holding entry signalled before its first request serves nothing sent it after: a listen, a call and a list each dropped with its connection, the core not asked, three lines \`cut\`, no stream held and no handler's 500; exit 0 (${coldGot.join(", ")}; asked ${coldAsked}; ${JSON.stringify(coldStopped.lines.map((l) => [l.outcome, l.status]))}; ${coldStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")}; ${coldStopped.err.split("\n").filter((l) => /closed|failed/.test(l)).join(" | ").slice(0, 160)})`);

    // A request whose headers are half sent at the signal, the rest of it sent after the drain has ended. Bun keeps
    // such a connection through its stop and serves the request once it is whole, without counting it meanwhile
    // (measured on macOS and on Linux; a connection opened and never used it keeps on macOS alone). The
    // collector here never answers, so the flush holds the process for more than a second: time for the rest to arrive.
    // It is not served, by the transport of either revision: no answer, the core not asked, a line `cut`, nothing
    // from a handler already closed; and the stream beside it still gets its closing frame, the exit still 0.
    const net = await import("node:net");
    let lateAsked = 0;
    answer = (n) => { if (n === "thoughtStats") lateAsked++; return ok(counted); };
    const lateEntry = await start(true, silent.port!);
    const lateStream = toEnd(await lateEntry.send("subscriptions/listen", listenParams));
    /** A bare connection, opened now, its request line and first header written; the rest written when told, and what came back by its close. */
    const early = (port: number, modern: boolean, method = "tools/call", params: unknown = { name: "thought_stats", arguments: {} }) => new Promise<{ send: () => void; got: Promise<string> }>((opened) => {
      let got = "";
      let done: (text: string) => void = () => {};
      const gotAll = new Promise<string>((resolve) => { done = resolve; });
      const socket = net.connect(port, "127.0.0.1", () => socket.write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n", () => opened({
        send: () => {
          const made = requestFor(method, params, "write-raw", { modern });
          void made.text().then((body) => socket.write(`${[...made.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
        },
        got: gotAll,
      })));
      socket.on("data", (d) => { got += d.toString(); });
      socket.on("close", () => done(got));
      socket.on("error", () => {
        done(got);
        // An entry that never came up: no connection, said as one that got nothing, so its rows fail and the suite goes on.
        opened({ send: () => {}, got: gotAll });
      });
    });
    const earlyModern = await early(lateEntry.port, true);
    const earlyLegacy = await early(lateEntry.port, false);
    await Bun.sleep(200);
    const lateAt = performance.now();
    const lateStopping = lateEntry.stop();
    await Bun.sleep(250);
    earlyModern.send();
    earlyLegacy.send();
    const lateStopped = await lateStopping;
    const lateGot = [await earlyModern.got, await earlyLegacy.got];
    const lateText = await lateStream.text;
    const lateCut = lateStopped.lines.filter((l) => l.outcome === "cut");
    assert(lateEntry.up && lateStopped.code === 0 && lateStopped.ms > 1_500 && lateStream.endedAt() - lateAt > 1_500 && Number(/telemetry not all sent within (\d+) ms/.exec(lateStopped.out)?.[1]) > 1_700 && Number(/telemetry not all sent within (\d+) ms/.exec(lateStopped.out)?.[1]) <= 1_800 && /telemetry not all sent within \d+ ms; 1 held stream closed; exit 0/.test(lateStopped.out) && lateText.includes('"resultType":"complete"'),
      `a stop whose flush a silent collector holds for its whole bound of 1.8 s: the stream is closed after the flush has run it out, not before, its frame read, exit 0 (exit ${lateStopped.code} in ${Math.round(lateStopped.ms)} ms, the stream ended at ${Math.round(lateStream.endedAt() - lateAt)} ms; ${lateStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM: stopped")).join(" | ")})`);
    assert(lateGot.every((x) => x === "") && lateAsked === 0 && lateCut.length === 2 && lateCut.every((l) => l.status === 0) && !lateStopped.lines.some((l) => l.status === 500 || l.outcome === "error" || l.outcome === "unrun") && !/has been closed|route failed/.test(lateStopped.err),
      `…and a request that is whole only then, its headers half sent at the signal, in either revision: not served and not answered, the core not asked, its line \`cut\`, and no 500 from a handler already closed (${JSON.stringify(lateGot.map((x) => x.slice(0, 40)))}; asked ${lateAsked}; ${JSON.stringify(lateStopped.lines.filter((l) => l.rpc !== "subscriptions/listen").map((l) => [l.outcome, l.status]))}; ${lateStopped.err.split("\n").filter((l) => /closed|failed/.test(l)).join(" | ").slice(0, 200)})`);
    // A listen made whole during the drain, on an entry that held no stream at its signal: its headers half sent
    // then, the rest 150 ms on, while the drain waits on a call. It is served, and is then a stream the server's own
    // end would wait on to the bound, a second: the drain looks for the call all the same, ends with it, and the
    // stream is closed after it with its frame.
    answer = (n) => (n === "thoughtStats" ? Bun.sleep(600).then(() => ok(counted)) : ok({}));
    const opening = await start(true, null);
    const openingCall = opening.send("tools/call", { name: "thought_stats", arguments: {} }).then(async (r) => (r.status === 200 && /Total thoughts: 3/.test(await r.text()) ? "answered in full" : `answered ${r.status}`));
    const earlyListen = await early(opening.port, true, "subscriptions/listen", listenParams);
    await Bun.sleep(200);
    const openingStopping = opening.stop();
    await Bun.sleep(150);
    earlyListen.send();
    const openingStopped = await openingStopping;
    const openingGot = [await openingCall, await earlyListen.got];
    answer = () => ok({});
    assert(opening.up && openingStopped.code === 0 && openingStopped.ms < 900 && openingGot[0] === "answered in full" && /^HTTP\/1\.1 200/.test(openingGot[1]) && openingGot[1].includes('"resultType":"complete"')
      && /SIGTERM: no longer accepting; 1 request in flight/.test(openingStopped.out) && !/held open/.test(openingStopped.out) && /; 1 held stream closed; exit 0/.test(openingStopped.out) && openingStopped.lines.some((l) => l.rpc === "subscriptions/listen" && l.outcome === "ok"),
      `a listen made whole during the drain of an entry that held none at its signal: held, the drain ended with the call and not at its bound of a second, the stream closed after it with its frame, exit 0 (exit ${openingStopped.code} in ${Math.round(openingStopped.ms)} ms; the call ${openingGot[0]}; the listen ${JSON.stringify(openingGot[1].slice(0, 15))}, frame ${openingGot[1].includes('"resultType":"complete"')}; ${openingStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);
    // Today's entry and such a request: its stop waits on that connection, as it always has (Bun's own end does),
    // and serves the request once it is whole. Where the holding stop differs from it most, and what holds it apart.
    answer = (n) => (n === "thoughtStats" ? ok(counted) : ok({}));
    const waiting = await start(false);
    const earlyPlain = await early(waiting.port, true);
    await Bun.sleep(100);
    const waitingStopping = waiting.stop();
    await Bun.sleep(250);
    earlyPlain.send();
    const waitingStopped = await waitingStopping;
    const waitingGot = await earlyPlain.got;
    answer = () => ok({});
    assert(waiting.up && waitingStopped.code === 0 && waitingStopped.ms >= 240 && /^HTTP\/1\.1 200/.test(waitingGot) && /Total thoughts: 3/.test(waitingGot) && waitingStopped.lines.some((l) => l.tool === "thought_stats" && l.outcome === "ok"),
      `today's entry, a request's headers half sent at its signal: the stop waits on it and serves it once whole, as before (exit ${waitingStopped.code} in ${Math.round(waitingStopped.ms)} ms; ${JSON.stringify(waitingGot.slice(0, 15))}, result ${/Total thoughts: 3/.test(waitingGot)}; ${waitingStopped.out.split("\n").filter((l) => l.startsWith("SIGTERM")).join(" | ")})`);
  } finally {
    answer = () => ok({});
    restServer.stop(true);
    collector.stop(true);
    silent.stop(true);
  }
}

console.log("\n[8g] The entry's telemetry (SMD-2287 PR 4c): its spans to a collector as open-brain-mcp, sent at its stop; the REST core's span the child of its tool call's, across two processes; a plugin tool named on its line");
{
  const { setUpTelemetry } = await import("../server-portable/otel-setup.ts");
  // The environment's own OTEL_* set aside for the section — a service name, a sampler, an exporter turned off — in this
  // process and the entry's, so each sends under its own name (review pass 2: OTEL_SERVICE_NAME failed it).
  const otelSaved = Object.entries(process.env).filter(([k]) => k.startsWith("OTEL_"));
  for (const [k] of otelSaved) delete process.env[k];
  // The entry in a process of its own and the REST core in this one, each sending its spans to one collector here.
  const received: Record<string, string[]> = {};
  const collector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { (received[new URL(req.url).pathname] ??= []).push(await req.text()); return Response.json({}); } });
  const tracing = setUpTelemetry("open-brain-api-test", { report: { warn: () => {} }, urls: { traces: `http://127.0.0.1:${collector.port}/v1/traces` } });
  const tracedRest = createRestApp({
    core,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: [`laptop:write:${hashKey("write-raw")}`, `mcp:forward:${hashKey("fwd-raw")}`].join(",") }),
    resolve: async (p) => ({ status: "ok", agentId: p.scope === "forward" ? "agent-f" : "agent-1" }),
    track: (run) => run(),
    log: () => {},
    plugins: () => loadPlugins("example"),
  });
  const restServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => tracedRest.fetch(req) });
  // PORT 0: the entry binds a port no one holds and says which (SMD-3296).
  const entry = Bun.spawn(["bun", "index.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: "0", OB1_LISTEN_HOST: "127.0.0.1", OB1_FORWARDER_KEY: "fwd-raw", OB1_REST_URL: `http://127.0.0.1:${restServer.port}`, OB1_STOP_GRACE: "3", OB1_PLUGINS: "example", OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const { port, stdout: entryOut } = await childPort(entry, 20_000);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false);
    if (!up) await Bun.sleep(50);
  }
  const call = (id: number, name: string, args: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "write-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.text());
  // The SDK loads after the server answers: its start line, before the calls whose spans are read.
  const said = watchStream(entry.stderr);
  const sdk = await said.until(/ go to \S+ over OTLP\/HTTP/, 10_000);
  let out = "";
  try {
    await call(1, "thought_stats");
    await call(2, "example_recent");
    // The brain's own embedding provider failing (SMD-2892): its tool span ends as an error, not a refusal (review pass 2).
    answer = (n) => (n === "searchThoughts" ? { ok: false, refusal: { code: "EMBEDDING_PROVIDER_ERROR", retryable: false, reason: "provider_401", detail: "it answered 401", status: 401, setting: "OB1_LLM_BASE_URL" } } as never : ok({}));
    await call(3, "search_thoughts", { query: "q" });
    answer = () => ok({});
    entry.kill("SIGTERM");
    const hung = setTimeout(() => entry.kill("SIGKILL"), 10_000);
    await entry.exited;
    clearTimeout(hung);
    out = await entryOut.rest();
    await tracing.flush();
  } finally {
    entry.kill();
    restServer.stop(true);
    await tracing.shutdown().catch(() => {});
    collector.stop(true);
    for (const [k, v] of otelSaved) process.env[k] = v;
  }
  // OTLP/JSON: each export's spans under their resource; a SERVER span is kind 2, and an attribute a key and a typed value.
  type OtlpAttributes = { key: string; value: { stringValue?: string } }[];
  type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; attributes?: OtlpAttributes };
  type OtlpResource = { resource: { attributes: OtlpAttributes }; scopeSpans: { spans: OtlpSpan[] }[] };
  const sent = (received["/v1/traces"] ?? []).flatMap((t) => (JSON.parse(t) as { resourceSpans: OtlpResource[] }).resourceSpans);
  const valueOf = (attributes: OtlpAttributes | undefined, key: string) => attributes?.find((a) => a.key === key)?.value.stringValue;
  const spansOf = (rs: OtlpResource[]) => rs.flatMap((r) => r.scopeSpans).flatMap((sc) => sc.spans);
  // The entry's spans and the REST core's, told apart by their service — not by a door, which an export holding only a
  // call's tool span would lack (review pass 1: the batch's timer firing between a call's two spans).
  const serviceOf = (r: OtlpResource) => valueOf(r.resource.attributes, "service.name");
  const entrySent = sent.filter((r) => serviceOf(r) !== tracing.serviceName);
  const service = entrySent[0] && serviceOf(entrySent[0]);
  const mcpSpans = spansOf(entrySent);
  const statsCall = mcpSpans.find((sp) => sp.name === "execute_tool thought_stats");
  const statsRequest = mcpSpans.find((sp) => sp.name === "tools/call thought_stats" && sp.kind === 2);
  const restStats = spansOf(sent.filter((r) => serviceOf(r) === tracing.serviceName)).find((sp) => sp.kind === 2 && valueOf(sp.attributes, "ob1.tool") === "thought_stats");
  assert(up && sdk && service === "open-brain-mcp" && statsRequest !== undefined && statsCall?.parentSpanId === statsRequest.spanId && statsCall.traceId === statsRequest.traceId,
    `the entry sends its spans at its stop as open-brain-mcp: a tool call's span under its request's (${service}; ${mcpSpans.map((sp) => sp.name).join(", ")})`);
  assert(statsCall !== undefined && restStats?.traceId === statsCall.traceId && restStats.parentSpanId === statsCall.spanId,
    `the REST core's request continues the tool call's traceparent: one trace across two processes (${restStats?.traceId} ${restStats?.parentSpanId} under ${statsCall?.traceId} ${statsCall?.spanId})`);
  // The plugin call's line: the second tools/call, the calls made one after the other.
  const pluginLine = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.door === "mcp" && l.rpc === "tools/call")[1];
  const keylessCall = mcpSpans.find((sp) => sp.name === "execute_tool search_thoughts");
  assert(valueOf(keylessCall?.attributes, "ob1.outcome") === "error" && valueOf(keylessCall?.attributes, "ob1.code") === "EMBEDDING_PROVIDER_ERROR",
    `an EMBEDDING_PROVIDER_ERROR's tool span at the MCP door ends \`error\` (${JSON.stringify(keylessCall?.attributes)})`);
  assert(pluginLine?.tool === "example_recent" && mcpSpans.some((sp) => sp.name === "execute_tool example_recent"),
    `a plugin tool is named on the entry's line and its span, the REST core in another process (${JSON.stringify(pluginLine)})`);
}

console.log("\n[9] The method guard, the preflight and discovery, as index.ts answers them");
{
  let r = await app.fetch(new Request("http://mcp/mcp"));
  assert(r.status === 405 && r.headers.get("allow") === "POST, OPTIONS", `GET /mcp: 405, Allow POST, OPTIONS (${r.headers.get("allow")})`);
  r = await app.fetch(new Request("http://mcp/mcp/health", { method: "PUT" }));
  assert(r.status === 405 && r.headers.get("allow") === "GET, HEAD, POST, OPTIONS", "PUT at a health path: 405 naming its GET and HEAD");
  r = await app.fetch(new Request("http://mcp/mcp", { method: "OPTIONS" }));
  assert(r.status === 200 && r.headers.get("access-control-allow-origin") === "*", "OPTIONS: the CORS preflight");
  const allowed = (r.headers.get("access-control-allow-headers") ?? "").split(", ");
  assert(["mcp-protocol-version", "mcp-method", "mcp-name"].every((h) => allowed.includes(h)), `…its allow-headers name what a 2026-07-28 POST must carry, so a browser-hosted client's preflight passes (SMD-4345: ${allowed.filter((h) => h.startsWith("mcp-")).join(", ")})`);
  r = await app.fetch(new Request("http://mcp/.well-known/oauth-protected-resource/mcp"));
  assert(r.status === 404, "an unconfigured stack's protected-resource path: 404");
}

console.log("\n[9b] The 2026-07-28 revision beside the 2025-era ones (SMD-4345 PR 2): the same caller, tools, replies, refusals and lines, with no initialize and no stream held open");
{
  const { useRequestLog } = await import("../server-portable/telemetry.ts");
  const lines: Record<string, unknown>[] = [];
  const before = useRequestLog((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  const last = () => lines.at(-1) ?? {};
  type Result = Record<string, unknown> & { _meta?: Record<string, unknown> };
  const resultOf = (r: Rpc) => (r.body?.result ?? {}) as Result;
  const errorOf = (r: Rpc) => (r.body?.error ?? {}) as { code?: number; message?: string; data?: { supported?: unknown } };
  const replyOf = (r: Rpc): Reply => {
    const result = resultOf(r) as { content?: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { text: (result.content ?? []).map((c) => c.text).join("\n"), sc: result.structuredContent ?? {}, isError: result.isError === true };
  };

  // server/discover, a 2026-07-28 client's first request: this server's revisions and what it can do, in place of initialize.
  const found = await rpc("server/discover", {}, "read-raw", { modern: true });
  const d = resultOf(found);
  assert(found.status === 200 && same(d.supportedVersions, [MODERN]) && (d._meta?.["io.modelcontextprotocol/serverInfo"] as { name?: unknown } | undefined)?.name === "open-brain",
    `server/discover with a key: 200, the 2026-07-28 revision, this server by name (${found.status} ${JSON.stringify(d).slice(0, 160)})`);
  assert((d.capabilities as { tools?: { listChanged?: unknown } } | undefined)?.tools?.listChanged === false, `…and it says it sends no list-changed notification, so a client opens no stream for one (${JSON.stringify(d.capabilities)})`);
  assert(last().rpc === "server/discover" && last().status === 200 && last().outcome === "ok" && last().agent === "chatgpt", `…its line: the method, the key's name, ok (${JSON.stringify(last())})`);
  assert(found.headers.get("access-control-allow-origin") === "*" && !found.headers.has("mcp-session-id") && /^text\/event-stream/.test(found.headers.get("content-type") ?? ""), "…answered as an event stream with the CORS headers, as a 2025-era request is, and no session id");
  const keyless = await rpc("server/discover", {}, undefined, { modern: true });
  assert(keyless.status === 200 && errorOf(keyless).code === -32001 && last().rpc === "server/discover" && last().outcome === "refused" && last().code === "UNAUTHORIZED",
    `…and with no key it is refused at the key as a 2025-era request is, the -32001 envelope, before the SDK is asked which revision it is (${keyless.status} ${JSON.stringify(keyless.body)}; ${JSON.stringify(last())})`);

  // tools/list: the caller's tools, each definition as a 2025-era client reads it, with the revision's cache fields.
  for (const key of ["write-raw", "read-raw", "cap-raw"]) {
    const legacyTools = resultOf(await rpc("tools/list", {}, key)).tools as unknown[];
    const listed = resultOf(await rpc("tools/list", {}, key, { modern: true }));
    assert(same(listed.tools, legacyTools) && legacyTools.length > 0 && listed.ttlMs === 0 && listed.cacheScope === "private" && listed.resultType === "complete",
      `tools/list for ${key}: the ${legacyTools.length} definitions a 2025-era client is given, ttlMs 0 and private (ttlMs ${listed.ttlMs}, ${listed.cacheScope})`);
  }

  // tools/call with no initialize before it: a reply and a refusal, each as a 2025-era client is given it.
  const counted = { total: 3, oldest: "2026-10-01T00:00:00Z", newest: "2026-10-02T00:00:00Z", types: { idea: 3 }, topics: { rest: 2 }, people: {}, aggregated: 3 };
  const absent = { code: "NOT_FOUND", retryable: false, id: "00000000-0000-4000-8000-000000000009" };
  answer = (n) => (n === "thoughtStats" ? ok(counted) : n === "fetch" ? refuse(absent as never) : ok({}));
  const stats = await rpc("tools/call", { name: "thought_stats", arguments: {} }, "write-raw", { modern: true });
  const legacyStats = await tool("thought_stats", {});
  assert(same(replyOf(stats), legacyStats) && expectReply(legacyStats, say.renderThoughtStats(ok(counted) as never)) && resultOf(stats).resultType === "complete", `a core tool called with no initialize: the 2025-era reply, render.ts's (${replyOf(stats).text.slice(0, 50)})`);
  const gone = { name: "fetch", arguments: { id: absent.id } };
  const refusedCall = await rpc("tools/call", gone, "write-raw", { modern: true });
  const refusedLine = last();
  const legacyRefused = await tool("fetch", gone.arguments);
  assert(same(replyOf(refusedCall), legacyRefused) && legacyRefused.isError && refusedLine.rpc === "tools/call" && refusedLine.tool === "fetch" && refusedLine.outcome === "refused" && refusedLine.code === "NOT_FOUND"
    && last().outcome === "refused" && last().code === "NOT_FOUND" && typeof refusedLine.bytes === "number",
    `a refusal: the 2025-era reply, and its line \`refused\` NOT_FOUND as that one's is (${JSON.stringify(refusedLine)})`);
  answer = () => ok({});

  // The key's refusals: the edge's, before the SDK is asked which revision a request is, so one answer for both.
  const refusals: [string, AgentOutcome | null, string][] = [["a wrong key", null, "wrong"], ["a revoked key", { status: "revoked", agentId: "agent-1", revokedAt: "2026-10-05T00:00:00Z", reason: null }, "write-raw"], ["a busy registry", { status: "busy" } as AgentOutcome, "write-raw"]];
  for (const [what, as, key] of refusals) {
    if (as) identity = as;
    const legacy = await rpc("tools/list", {}, key);
    const legacyRev = last().rev;
    const modern = await rpc("tools/list", {}, key, { modern: true });
    assert(modern.status === legacy.status && same(errorOf(modern), errorOf(legacy)) && errorOf(modern).code !== undefined && modern.headers.get("retry-after") === legacy.headers.get("retry-after"),
      `${what}: the 2025-era refusal, status, code, words and Retry-After (${modern.status} ${errorOf(modern).code})`);
    assert(legacyRev === "unnamed" && last().rev === MODERN && last().outcome === "refused", `${what}: each refusal's line says the revision its request named (SMD-4363: ${legacyRev}, ${last().rev})`);
    identity = { status: "ok", agentId: "agent-1" };
  }
  const note = await rpc("notifications/cancelled", { requestId: 1 }, "write-raw", { modern: true, notification: true });
  assert(note.status === 202 && note.body === null && last().rpc === "notifications/cancelled", `a notification: 202 and no body (${note.status})`);

  // subscriptions/listen: acknowledged honouring nothing, then ended. No stream is held open: the entry holds none until SMD-4347's PR 2b, and [9c] has an app that does.
  // Read with a deadline: a server that honoured the subscription would hold this stream open for good, and the row must fail then, not wait.
  const listening = await app.fetch(requestFor("subscriptions/listen", { notifications: { toolsListChanged: true } }, "read-raw", { modern: true }));
  const listened = await Promise.race([listening.text(), Bun.sleep(3_000).then(() => { void listening.body?.cancel().catch(() => {}); return "(still open after 3 s)"; })]);
  const frames = listened.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { method?: string; params?: { notifications?: unknown }; result?: { resultType?: unknown } });
  assert(frames.length === 2 && frames[0].method === "notifications/subscriptions/acknowledged" && same(frames[0].params?.notifications, {}) && frames[1].result?.resultType === "complete",
    `subscriptions/listen: acknowledged with nothing honoured, then its result, and the stream ends (${frames.length} frames; ${JSON.stringify(frames[0]?.params?.notifications)}${frames.length === 0 ? `; ${listened}` : ""})`);
  assert(last().rpc === "subscriptions/listen" && last().outcome === "ok" && !lines.some((l) => "event" in l), `…its line written at once, not when a client leaves, and no line for an end: no stream was held (SMD-4459; ${JSON.stringify(last())}; ${lines.filter((l) => "event" in l).length} end line(s))`);

  // What the SDK's handler refuses, it refuses in its own words; the line says so by its status.
  const crossed = await rpc("tools/list", {}, "read-raw", { modern: true, headers: { "mcp-method": "tools/call" } });
  assert(crossed.status === 400 && errorOf(crossed).code === -32020 && crossed.headers.get("access-control-allow-origin") === "*" && last().status === 400 && last().outcome === "refused",
    `a header that disagrees with the body: 400, -32020, with the CORS headers (${crossed.status} ${errorOf(crossed).code}; ${JSON.stringify(last())})`);
  const future = await rpc("tools/list", {}, "read-raw", { modern: true, headers: { "mcp-protocol-version": "2027-01-01" }, envelope: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" } });
  assert(future.status === 400 && errorOf(future).code === -32022 && same(errorOf(future).data?.supported, [MODERN]), `a revision this server does not serve: 400, -32022, naming the one it does (${future.status} ${JSON.stringify(errorOf(future).data)})`);
  const stale = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } }, "read-raw");
  assert(stale.status === 200 && resultOf(stale).protocolVersion === "2025-06-18" && (resultOf(stale).capabilities as { tools?: { listChanged?: unknown } } | undefined)?.tools?.listChanged === true,
    `and initialize is still answered: a 2025-era client is served as it was, its server declaring what the SDK declares (${stale.status} ${resultOf(stale).protocolVersion} ${JSON.stringify(resultOf(stale).capabilities)})`);

  // A body past the SDK's 4 MiB bound: refused 413 in the same words whichever revision it speaks, as the
  // 2025-era transport always refused one. Just under it, each is answered by its tool.
  const calling = (bytes: number) => ({ name: "capture_thought", arguments: { content: "x".repeat(bytes) } });
  const longLegacy = await rpc("tools/call", calling(5 * 1024 * 1024), "write-raw");
  const longModern = await rpc("tools/call", calling(5 * 1024 * 1024), "write-raw", { modern: true });
  assert(longLegacy.status === 413 && /must not exceed 4194304 bytes/.test(errorOf(longLegacy).message ?? ""), `a 5 MiB 2025-era call: 413 by the SDK's bound (${longLegacy.status} ${errorOf(longLegacy).message})`);
  assert(longModern.status === 413 && same(longModern.body, longLegacy.body), `…and a 5 MiB 2026-07-28 call the same, word for word: one bound for both (${longModern.status})`);
  const nearLegacy = await rpc("tools/call", calling(3 * 1024 * 1024), "write-raw");
  const nearModern = await rpc("tools/call", calling(3 * 1024 * 1024), "write-raw", { modern: true });
  assert(nearLegacy.status === 200 && nearLegacy.body?.result !== undefined && same(replyOf(nearModern), replyOf(nearLegacy)) && nearModern.status === 200, `a 3 MiB call, either revision: answered by its tool (${nearLegacy.status}, ${nearModern.status})`);

  // The line says which revision each request named (SMD-4363), read in revisionOf's order: a 2026-07-28 request's
  // envelope; what an initialize offers; a 2025-era request's header once it has one; `unnamed` with none; `other` for
  // a string that is no revision this server serves. Read for a request refused at the key too. Never the caller's own text.
  {
    const revOf = async (method: string, params: unknown, key: string | undefined, opts: RpcOpts = {}) => { await rpc(method, params, key, opts); return last().rev; };
    const offered = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } };
    const got = {
      modern: await revOf("tools/list", {}, "read-raw", { modern: true }),
      modernKeyless: await revOf("server/discover", {}, undefined, { modern: true }),
      legacyBare: await revOf("tools/list", {}, "read-raw"),
      legacyHeader: await revOf("tools/list", {}, "read-raw", { headers: { "mcp-protocol-version": "2025-06-18" } }),
      initialize: await revOf("initialize", offered, "read-raw"),
      notServed: await revOf("tools/list", {}, "read-raw", { modern: true, headers: { "mcp-protocol-version": "2027-01-01" }, envelope: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" } }),
      madeUp: await revOf("tools/list", {}, "read-raw", { headers: { "mcp-protocol-version": "the private thought" } }),
      // The envelope against a header that disagrees (the handler refuses the request): the body is the request's word on itself.
      crossed: await revOf("tools/list", {}, "read-raw", { modern: true, headers: { "mcp-protocol-version": "2025-06-18" } }),
      // An initialize under a header: the offer, which is what the transport acts on.
      initializeUnderHeader: await revOf("initialize", { ...offered, protocolVersion: "2025-11-25" }, "read-raw", { headers: { "mcp-protocol-version": "2025-03-26" } }),
      // An initialize that carries the envelope is a 2026-07-28 request to the SDK, whatever it offers: the envelope's.
      initializeEnveloped: await revOf("initialize", { ...offered }, "read-raw", { modern: true }),
      // A caller's own `unnamed` is not the route's word.
      saysUnnamed: await revOf("tools/list", {}, "read-raw", { headers: { "mcp-protocol-version": "unnamed" } }),
      // An envelope whose revision is no string is no envelope: the header's stands.
      oddEnvelope: await revOf("tools/list", {}, "read-raw", { modern: true, headers: { "mcp-protocol-version": "2026-07-28" }, envelope: { "io.modelcontextprotocol/protocolVersion": 7 } }),
    };
    // A batch, which only 2025-03-26 has and which carries no header: none named.
    await (await app.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]) }))).text();
    const batchLine = last();
    assert(batchLine.rpc === "batch" && batchLine.rev === "unnamed", `a batch with no header: \`unnamed\` (${JSON.stringify(batchLine)})`);
    // Under a header a batch is the header's: an array is read by its header alone.
    await (await app.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw", "mcp-protocol-version": "2025-03-26" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]) }))).text();
    assert(last().rpc === "batch" && last().rev === "2025-03-26", `a batch under a header: the header's (${JSON.stringify(last())})`);
    // An initialize whose envelope is not whole is a 2025-era handshake to the SDK, and answered as one; its line says what the envelope claimed.
    const half = await rpc("initialize", { ...offered, protocolVersion: "2025-11-25", _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } }, "read-raw");
    assert(half.status === 200 && resultOf(half).protocolVersion === "2025-11-25" && last().rev === MODERN,
      `an initialize claiming 2026-07-28 in an envelope that is not whole: answered as a 2025-era handshake, and the line says the claim (${half.status} ${JSON.stringify(half.body)}; ${last().rev})`);
    const { initializeUnderHeader, initializeEnveloped, saysUnnamed, oddEnvelope, ...plain } = got;
    assert(initializeUnderHeader === "2025-11-25" && initializeEnveloped === MODERN && saysUnnamed === "other" && oddEnvelope === MODERN,
      `an initialize under a 2025-era header is its offer, and one carrying the envelope is the envelope's; a header that says \`unnamed\` is \`other\`; an envelope whose revision is no string leaves the header's (${initializeUnderHeader}, ${initializeEnveloped}, ${saysUnnamed}, ${oddEnvelope})`);
    assert(same(plain, { modern: MODERN, modernKeyless: MODERN, legacyBare: "unnamed", legacyHeader: "2025-06-18", initialize: "2025-06-18", notServed: "other", madeUp: "other", crossed: MODERN }),
      `each line's \`rev\`: the envelope's, a keyless request's too, and over a header that disagrees; a 2025-era header's, an initialize's offer, \`unnamed\` with none, \`other\` for a revision not served and for a made-up string (${JSON.stringify(got)})`);
    // Every field but the clock's: `ts` holds the year, and this row must not start failing on a date.
    const said = lines.map(({ ts: _ts, ...rest }) => JSON.stringify(rest));
    assert(!said.some((l) => l.includes("private") || l.includes("2027-01-01")), "…and nothing of a caller's own text on any line");
    // The list telemetry.ts holds is what this server serves, read from the installed SDK both ways: its 2025-era
    // list by its export, and its 2026-07-28 family by what server/discover answers here (the SDK keeps that list
    // apart and exports none of it). A bump that serves another revision of either family fails this row.
    const { MCP_REVISIONS } = await import("../server-portable/telemetry.ts");
    const { SUPPORTED_PROTOCOL_VERSIONS } = await import("@modelcontextprotocol/server");
    const discovered = (resultOf(await rpc("server/discover", {}, "read-raw", { modern: true })).supportedVersions ?? []) as string[];
    const served = [...discovered, ...SUPPORTED_PROTOCOL_VERSIONS, "unnamed"].sort();
    assert(discovered.length > 0 && same([...MCP_REVISIONS].sort(), served), `the revisions a line may name are what server/discover answers, the SDK's 2025-era list and \`unnamed\` (${[...MCP_REVISIONS].sort().join(", ")} against ${served.join(", ")})`);
    // A body that is no JSON, and one that is no request, still have a line: the header's word, or `unnamed`.
    const raw = async (body: string, headers: Record<string, string> = {}) => {
      await (await app.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw", ...headers }, body }))).text();
      return last();
    };
    const notJson = await raw("{not json", { "mcp-protocol-version": "2025-06-18" });
    const noRequest = await raw("{}");
    assert(notJson.rev === "2025-06-18" && notJson.rpc === undefined && noRequest.rev === "unnamed" && noRequest.rpc === undefined,
      `a body that is no JSON under a header: the header's; a body that is no request: \`unnamed\`; neither a method (${JSON.stringify(notJson)}; ${JSON.stringify(noRequest)})`);
    // revisionOf by itself, one guard at a time, on what no request above sends. What it returns, before the line holds it:
    // the empty string is its word for "named, and no revision", which the line writes `other`.
    const V = "io.modelcontextprotocol/protocolVersion";
    const names = (headers: Record<string, string>, body: unknown): string => {
      try { return revisionOf(new Headers(headers), body === undefined ? null : parsedBody(JSON.stringify(body))); } catch (err) { return `threw: ${err}`; }
    };
    const alone = {
      offerElsewhere: names({}, { method: "tools/list", params: { protocolVersion: "2025-06-18" } }),
      offerNoString: names({}, { method: "initialize", params: { protocolVersion: 20250618 } }),
      emptyEnvelope: names({ "mcp-protocol-version": "2025-06-18" }, { method: "tools/list", params: { _meta: { [V]: "" } } }),
      oddEnvelopeOffer: names({}, { method: "initialize", params: { protocolVersion: "2025-06-18", _meta: { [V]: 7 } } }),
      arrayOfOne: names({}, [{ method: "initialize", params: { protocolVersion: "2025-03-26" } }]),
      emptyHeader: names({ "mcp-protocol-version": "" }, { method: "tools/list" }),
      saysUnnamed: names({ "mcp-protocol-version": "unnamed" }, { method: "tools/list" }),
      unread: names({ "mcp-protocol-version": "2025-06-18" }, undefined),
      unreadBare: names({}, undefined),
    };
    assert(same(alone, { offerElsewhere: "unnamed", offerNoString: "unnamed", emptyEnvelope: "", oddEnvelopeOffer: "2025-06-18", arrayOfOne: "unnamed", emptyHeader: "", saysUnnamed: "", unread: "2025-06-18", unreadBare: "unnamed" }),
      `revisionOf alone: an offer is an initialize's and a string; an empty envelope or header named something, no revision; an envelope that is no string leaves the offer; an array of one is read by its header; a caller's \`unnamed\` is not its word; a body unread leaves the header's (${JSON.stringify(alone)})`);
  }

  // A request the SDK's rule cannot place goes to the handler, which refuses it in its own words: a 2025-era
  // `initialize` under a 2026-07-28 header was served before this, and is a 400 now.
  const mixed = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } }, "read-raw", { headers: { "mcp-protocol-version": MODERN } });
  assert(mixed.status === 400 && errorOf(mixed).code === -32020 && last().status === 400, `a 2025-era initialize under a 2026-07-28 header: the handler's 400, -32020, not served (${mixed.status} ${errorOf(mixed).code})`);

  // Two callers at once through the one handler: each its own server, by the function its own request handed over.
  // Each key's own count, asked one at a time of the 2025-era path first: three different numbers, so a crossed list shows.
  const own = new Map<string, number>();
  for (const key of ["write-raw", "read-raw", "cap-raw"]) own.set(key, ((resultOf(await rpc("tools/list", {}, key)).tools as unknown[] | undefined) ?? []).length);
  const together = await Promise.all(["write-raw", "read-raw", "cap-raw", "write-raw", "read-raw", "cap-raw"].map(async (key) => [key, ((resultOf(await rpc("tools/list", {}, key, { modern: true })).tools as unknown[] | undefined) ?? []).length] as const));
  assert(new Set(own.values()).size === 3 && together.every(([key, n]) => n === own.get(key) && n > 0), `six 2026-07-28 requests at once under three keys: each its own key's list (${together.map(([k, n]) => `${k} ${n}`).join(", ")})`);

  // A fault building the server (here a plugin's tool named as a core tool is): this server's 500, said once in
  // the log as a route's throw, for both. The SDK's handler catches it and would say it nowhere.
  const clash = definePlugin({ name: "clash-kit", title: "C", description: "A plugin whose one operation is given a core tool's name below.", operations: { look: operation({ title: "L", description: "d", scope: "read", method: "GET", path: "/look", input: {}, output: {}, async handler() { return pluginOk({}); } }) } });
  // Loaded as a manifest must be, then its operation renamed past the manifest's own check, which refuses the name.
  const clashed = loadPlugins("clash-kit", [clash]).map((pl) => ({ ...pl, operations: pl.operations.map((o) => ({ ...o, tool: "thought_stats" })) }));
  for (const modern of [false, true]) {
    const era = modern ? "2026-07-28" : "2025-era";
    const said: string[] = [];
    const clashing = createMcpApp({ rest, plugins: () => clashed, edge: () => ({ configured: false, origin: null }), warn: (l) => said.push(l) });
    const failed = await clashing.fetch(requestFor("tools/list", {}, "write-raw", { modern }));
    const text = await failed.text();
    assert(failed.status === 500 && text === "Internal Server Error" && said.length === 1 && /POST a route failed/.test(said[0]) && /thought_stats is already registered/.test(said[0]) && last().status === 500 && last().outcome === "error",
      `a ${era} request whose server cannot be built: 500 in this server's words, one line naming the fault, its line \`error\` (${failed.status} ${text.slice(0, 60)}; ${said.join(" | ").slice(0, 110)})`);
  }

  // A slow call: comment frames keep its stream open, and a client that lets go of the answer mid-call is `abandoned`, for both.
  const slowWarned: string[] = [];
  const slow = createMcpApp({
    rest: createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async (req) => { if (!new URL(req.url).pathname.endsWith("/whoami")) await Bun.sleep(400); return restApp.fetch(req); } }),
    edge: () => ({ configured: false, origin: null }), warn: (l) => slowWarned.push(l), keepalive: { intervalMs: 25, maxMs: 60_000 },
  });
  for (const modern of [false, true]) {
    const era = modern ? "2026-07-28" : "2025-era";
    const text = await (await slow.fetch(requestFor("tools/call", { name: "thought_stats", arguments: {} }, "write-raw", { modern }))).text();
    const comments = text.split("\n").filter((l) => l.startsWith(":"));
    assert(comments.length >= 1 && firstMessage(text)?.result !== undefined, `a slow ${era} call: kept open by comment frames, then answered (${comments.length} frames)`);
    // The answer let go of at once, as a runtime does when its client leaves: the stream's cancel, not the request's signal.
    const linesBefore = lines.length;
    const answer = await slow.fetch(requestFor("tools/call", { name: "thought_stats", arguments: {} }, "write-raw", { modern }));
    await answer.body?.cancel();
    for (let waited = 0; lines.length === linesBefore && waited < 5_000; waited += 20) await Bun.sleep(20);
    assert(lines.length === linesBefore + 1 && last().rpc === "tools/call" && last().tool === "thought_stats" && last().outcome === "abandoned", `a ${era} call whose client lets go of the answer: its line \`abandoned\` (${JSON.stringify(last())})`);
  }
  useRequestLog(before);
}

console.log("\n[9c] A listen stream held open (SMD-4347 PR 2a): its line as it opens, no stall and no abandonment, a place under two bounds, a line of its own at its end (SMD-4459); the entry holds none yet");
{
  const { useRequestLog } = await import("../server-portable/telemetry.ts");
  const { createListenStreams, HOLD_LISTEN_STREAMS, LISTEN_STREAMS_MAX, LISTEN_STREAMS_PER_CALLER } = await import("./listen-streams.ts");
  const lines: Record<string, unknown>[] = [];
  const before = useRequestLog((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  const last = () => lines.at(-1) ?? {};
  /** The lines for a stream's end (SMD-4459), which are no request's. */
  const endsSaid = () => lines.filter((l) => l.event === "listen_end");
  // The app's own warnings, and the keepalive wrapper's, which goes to console.warn: both are read for what a held stream must not say.
  const said: string[] = [];
  const warnBefore = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  // An app that holds listen streams: three at most, two under one name, and a stall bound of 200 ms, so a row can outlast it.
  const streams = createListenStreams(true, 3, 2);
  const holding = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: (l) => said.push(l), listen: streams, keepalive: { intervalMs: 20, maxMs: 200 } });
  const listenParams = { notifications: { toolsListChanged: true } };
  const ask = (key: string, params: unknown = listenParams, opts: RpcOpts = {}) =>
    Promise.race([Promise.resolve(holding.fetch(requestFor("subscriptions/listen", params, key, { modern: true, ...opts }))), Bun.sleep(5_000).then(() => new Response("(never answered)", { status: 599 }))]);
  /** An answer's stream, read a while at a time and never past its deadline, so a stream that stays open is said to. */
  const reading = (r: Response) => {
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let pending: ReturnType<typeof reader.read> | null = null;
    return {
      status: r.status,
      type: r.headers.get("content-type") ?? "",
      async read(ms: number): Promise<{ text: string; ended: boolean }> {
        let text = "";
        const deadline = Bun.sleep(ms).then(() => null);
        for (;;) {
          pending ??= reader.read();
          const next = await Promise.race([pending, deadline]);
          if (next === null) return { text, ended: false };
          pending = null;
          if (next.done) return { text, ended: true };
          text += decoder.decode(next.value);
        }
      },
      close: () => reader.cancel().catch(() => {}),
    };
  };
  const framesOf = (text: string) => text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { method?: string; params?: { notifications?: unknown }; result?: { resultType?: unknown } });
  const until = async (ok: () => boolean) => { for (let waited = 0; !ok() && waited < 2_000; waited += 10) await Bun.sleep(10); return ok(); };
  /** An answer's text, read under a deadline: a stream held open where an answer in one piece was due is said, and holds the suite up no longer. */
  const textUnder = (r: Response): Promise<string> => Promise.race([r.text().catch((e: Error) => `(unread: ${e.message})`), Bun.sleep(500).then(() => "(still open)")]);
  /** A refusal's body, read under a deadline: a stream held open where a refusal was due is said, and holds the suite up no longer. */
  const refusalOf = async (r: Response): Promise<{ id?: unknown; error?: { code?: number; message?: string } }> => {
    const text = await textUnder(r);
    if (text === "(still open)") return { error: { message: "(no refusal: a stream, held open)" } };
    try {
      return JSON.parse(text);
    } catch {
      return { error: { message: `(no refusal: ${text.slice(0, 80)})` } };
    }
  };

  // The entry holds none yet, and its bounds are the ones the page gives.
  assert(HOLD_LISTEN_STREAMS === false && createListenStreams().hold === false && LISTEN_STREAMS_MAX === 256 && LISTEN_STREAMS_PER_CALLER === 32,
    `the entry's own setting: no stream held until PR 2b, and the bounds 256 and 32 (${HOLD_LISTEN_STREAMS}, ${LISTEN_STREAMS_MAX}, ${LISTEN_STREAMS_PER_CALLER})`);

  // What a client is told: the capability, which is what makes it open a stream.
  const told = ((await rpc("server/discover", {}, "read-raw", { modern: true, app: holding })).body?.result ?? {}) as { capabilities?: { tools?: { listChanged?: unknown } } };
  assert(told.capabilities?.tools?.listChanged === true, `an app that holds streams says so: tools.listChanged true (${JSON.stringify(told.capabilities)})`);

  // One stream, held: acknowledged with what it asked for, not ended, counted, and its line written as it opened.
  const linesBefore = lines.length;
  const firstAsked = performance.now();
  const first = reading(await ask("write-raw"));
  const firstOpened = performance.now();
  const opened = await first.read(300);
  const ack = framesOf(opened.text);
  assert(first.status === 200 && /^text\/event-stream/.test(first.type) && ack.length === 1 && ack[0].method === "notifications/subscriptions/acknowledged" && same(ack[0].params?.notifications, { toolsListChanged: true }) && !opened.ended && streams.count === 1,
    `a listen stream: acknowledged with what it asked for, and held open, one counted (${first.status} ${first.type}; ${JSON.stringify(ack)}; ended ${opened.ended}; open ${streams.count})`);
  assert(lines.length === linesBefore + 1 && last().rpc === "subscriptions/listen" && last().rev === "2026-07-28" && last().agent === "laptop" && last().status === 200 && last().outcome === "ok" && typeof last().ms === "number" && (last().ms as number) < 250 && !("code" in last()),
    `…its line written as it opened, ok, its ms the time to open it (${JSON.stringify(last())})`);

  // Past the stall bound: still open, no second line, no word of a stall, and no frame of the wrapper's own.
  const later = await first.read(500);
  assert(!later.ended && lines.length === linesBefore + 1 && !said.some((l) => /still running|stalled/.test(l)) && !later.text.includes(": keepalive"),
    `…and past the stall bound it is still open: no \`stalled\` line, no warning, no keepalive frame of this server's own (ended ${later.ended}; ${lines.length - linesBefore} line(s); ${JSON.stringify(said)}; ${JSON.stringify(later.text)})`);

  // Its client lets it go: the place given back, and one line more, for its end (SMD-4459): a record of its own
  // kind, with how it ended and how long it was held. A client that closes its stream has abandoned no call.
  const firstClosing = performance.now();
  await first.close();
  const gone = await until(() => streams.count === 0 && endsSaid().length === 1);
  const firstGone = performance.now();
  const firstEnd = endsSaid()[0] ?? {};
  assert(gone && lines.length === linesBefore + 2 && last() === firstEnd && Object.keys(firstEnd).join() === "ts,door,event,agent,end,held_ms" && firstEnd.door === "mcp" && firstEnd.agent === "laptop" && firstEnd.end === "client"
    && (firstEnd.held_ms as number) >= firstClosing - firstOpened - 1 && (firstEnd.held_ms as number) <= firstGone - firstAsked + 1 && !said.some((l) => /abandoned/.test(l)),
    `…and when its client closes it the place is given back, and one line says its end: \`listen_end\`, \`client\`, held as long as it was, with no outcome and no word of abandonment (open ${streams.count}; ${JSON.stringify(firstEnd)}; closed ${Math.round(firstClosing - firstOpened)} to ${Math.round(firstGone - firstAsked)} ms on; ${JSON.stringify(said)})`);

  // A client gone by its request's signal, as a dropped connection is: the same.
  const dropped = new AbortController();
  const second = reading(await ask("write-raw", undefined, { signal: dropped.signal }));
  await second.read(100);
  const heldTwo = streams.count;
  dropped.abort();
  const goneTwo = await until(() => streams.count === 0);
  // Said by the abort alone, before anything lets go of the stream: in process nothing cancels it as a runtime would.
  const saidAtAbort = await until(() => endsSaid().length === 2);
  await second.close();
  await Bun.sleep(30);
  assert(heldTwo === 1 && goneTwo && saidAtAbort && endsSaid().length === 2 && endsSaid()[1].end === "client" && !said.some((l) => /abandoned|cut off/.test(l)),
    `a held stream whose connection drops: its place given back, and its end said at the request's abort, once, \`client\` as a stream its client closed is, the server being told one thing for both (held ${heldTwo}, open ${streams.count}; said at the abort ${saidAtAbort}; ${JSON.stringify(endsSaid().slice(1))}; ${JSON.stringify(said)})`);

  // The two bounds. Two under one name, and a third is refused in the SDK's own shape, its line `refused` with a code.
  const a1 = reading(await ask("write-raw"));
  const a2 = reading(await ask("write-raw"));
  await a1.read(100);
  await a2.read(100);
  const overCaller = await ask("write-raw");
  const overCallerBody = await refusalOf(overCaller);
  assert(overCaller.status === 200 && overCallerBody.error?.code === -32603 && /this caller holds as many/.test(overCallerBody.error?.message ?? "") && overCallerBody.id !== undefined && overCallerBody.id !== null && streams.count === 2
    && last().rpc === "subscriptions/listen" && last().outcome === "refused" && last().code === "LISTEN_CALLER_FULL" && last().agent === "laptop" && last().status === 200 && overCaller.headers.get("access-control-allow-origin") === "*",
    `a third stream under a name that may hold two: refused, a 200 carrying -32603 and the request's id, its line \`refused\` LISTEN_CALLER_FULL (${overCaller.status} ${JSON.stringify(overCallerBody)}; open ${streams.count}; ${JSON.stringify(last())})`);
  // A refusal is the end of its request: its client going afterwards writes nothing more.
  const refusedThenGone = new AbortController();
  await refusalOf(await ask("write-raw", undefined, { signal: refusedThenGone.signal }));
  const linesAtRefusal = lines.length;
  refusedThenGone.abort();
  await Bun.sleep(30);
  assert(lines.length === linesAtRefusal && !said.some((l) => /abandoned/.test(l)), `…and a client that goes after its refusal has abandoned nothing: no line, no warning (${lines.length - linesAtRefusal} line(s); ${JSON.stringify(said)})`);
  // Another name has its own share, up to the server's bound; past that, any name is refused.
  const b1 = reading(await ask("read-raw"));
  await b1.read(100);
  const overServer = await ask("cap-raw");
  const overServerBody = await refusalOf(overServer);
  assert(streams.count === 3 && overServer.status === 200 && overServerBody.error?.code === -32603 && /this server holds no more/.test(overServerBody.error?.message ?? "") && last().outcome === "refused" && last().code === "LISTEN_SERVER_FULL",
    `another name has its own share, to the server's bound of three; a fourth, under a third name, is refused (open ${streams.count}; ${overServer.status} ${JSON.stringify(overServerBody)}; ${JSON.stringify(last())})`);
  // What keyed /health says of them (SMD-4458): how many are open, the two bounds a refusal is read against, and each
  // caller's share, the most first. The two refusals above took nothing.
  const healthOf = async (from: { fetch: (r: Request) => Response | Promise<Response> } = holding) => {
    answer = () => ({ version: "1.0.0" });
    try {
      const r = await from.fetch(new Request("http://mcp/mcp/health", { headers: { "x-brain-key": "read-raw" } }));
      const text = await r.text();
      try {
        return JSON.parse(text) as { version?: unknown; oauth?: unknown; listen?: unknown };
      } catch {
        // Liveness, or anything that is no record: said, so its row fails and the section goes on.
        return { version: `(no record: ${text.slice(0, 40)})` };
      }
    } finally {
      answer = () => ok({});
    }
  };
  const atBound = await healthOf();
  assert(atBound.version === "1.0.0" && atBound.oauth !== undefined && same(atBound.listen, { open: 3, max: 3, perCaller: 2, callers: [{ name: "laptop", open: 2 }, { name: "chatgpt", open: 1 }] }),
    `keyed /health on a server that holds streams: beside the record, three open of three, two a caller, and each caller's share, the most first; a refusal at either bound left the count where it was (${JSON.stringify(atBound.listen)})`);
  // The streams whose end is still to be said are the streams open (SMD-4459): those ended above are not kept.
  assert(endsSaid().length === 2 && streams.unsaid() === 3, `…and the streams whose end is unsaid are those three: one whose end was said is kept no longer (${streams.unsaid()} unsaid; ${endsSaid().length} end(s) said so far)`);
  // A place given back is a place to take: one stream closed, and the name refused a moment ago is held.
  await a1.close();
  await until(() => streams.count === 2);
  const afterOne = await healthOf();
  assert(same(afterOne.listen, { open: 2, max: 3, perCaller: 2, callers: [{ name: "chatgpt", open: 1 }, { name: "laptop", open: 1 }] }),
    `…and after one stream's client closes it the count has fallen by one, its caller's with it; equal shares are in name order (${JSON.stringify(afterOne.listen)})`);
  const c1 = reading(await ask("cap-raw"));
  const c1Opened = await c1.read(100);
  assert(streams.count === 3 && c1.status === 200 && framesOf(c1Opened.text)[0]?.method === "notifications/subscriptions/acknowledged" && !c1Opened.ended, `a place given back is taken by the next to ask (open ${streams.count}; ${c1.status})`);
  for (const r of [a2, b1, c1]) await r.close();
  const emptied = await until(() => streams.count === 0);
  assert(emptied && streams.unsaid() === 0, `every stream closed, none counted and none kept for an end unsaid (open ${streams.count}; ${streams.unsaid()} unsaid)`);
  // With none open the field is still there, the bounds with it; an app that holds none says nothing of streams,
  // given its streams' settings as the entry gives them or given none.
  const noneOpen = await healthOf();
  const givenAndOff = await healthOf(createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: (l) => said.push(l), listen: createListenStreams() }));
  const holdsNone = await healthOf(app);
  assert(same(noneOpen.listen, { open: 0, max: 3, perCaller: 2, callers: [] }) && holdsNone.version === "1.0.0" && holdsNone.oauth !== undefined && !("listen" in holdsNone) && givenAndOff.version === "1.0.0" && !("listen" in givenAndOff),
    `keyed /health with no stream open says none, and its bounds; an app that holds none has no such field, as the entry is today or with no streams' settings at all (${JSON.stringify(noneOpen.listen)}; ${JSON.stringify(Object.keys(givenAndOff))}; ${JSON.stringify(Object.keys(holdsNone))})`);

  // A name's count is its streams still open: with one of its two closed it may open one more, and not two.
  const n1 = reading(await ask("write-raw"));
  const n2 = reading(await ask("write-raw"));
  await n1.read(50);
  await n2.read(50);
  await n1.close();
  await until(() => streams.count === 1);
  const n3 = reading(await ask("write-raw"));
  await n3.read(50);
  const n4Body = await refusalOf(await ask("write-raw"));
  assert(n3.status === 200 && streams.count === 2 && n4Body.error?.code === -32603 && /this caller holds as many/.test(n4Body.error?.message ?? ""), `a name with one of its two streams closed may open one more, and is refused a second (open ${streams.count}; ${JSON.stringify(n4Body)})`);
  await n2.close();
  await n3.close();
  await until(() => streams.count === 0);

  // A listen that asks for nothing this server sends is acknowledged and ended by the SDK, and holds no place after.
  const nothing = reading(await ask("write-raw", { notifications: {} }));
  const nothingRead = await nothing.read(1_000);
  const nothingFrames = framesOf(nothingRead.text);
  assert(nothingRead.ended && nothingFrames.at(-1)?.result?.resultType === "complete" && (await until(() => streams.count === 0)), `a listen that asks for nothing: acknowledged, ended, and no place held (ended ${nothingRead.ended}; open ${streams.count})`);
  // Its end is the server's own (SMD-4459): no client left it and no stop closed it.
  const nothingEnd = (await until(() => last().event === "listen_end")) ? last() : {};
  assert(nothingEnd.end === "server" && nothingEnd.agent === "laptop" && (nothingEnd.held_ms as number) < 1_000 && streams.unsaid() === 0, `…and its end is said as the server's own, \`server\`, and the stream kept no longer for an end unsaid (${JSON.stringify(nothingEnd)}; ${streams.unsaid()} unsaid)`);
  // One the SDK refuses in one piece, or with a 4xx, was never held: no end is said of it.
  const endsBeforeRefusals = endsSaid().length;
  // One the SDK refuses in one piece (no filter at all) is no stream, and holds no place.
  const refusedBySdk = await ask("write-raw", {});
  await textUnder(refusedBySdk);
  assert(!/^text\/event-stream/.test(refusedBySdk.headers.get("content-type") ?? "") && streams.count === 0, `a listen the SDK refuses in one piece: no stream, no place held (${refusedBySdk.status} ${refusedBySdk.headers.get("content-type")}; open ${streams.count})`);
  // One it refuses outright (its method header and its body disagree) is a 4xx: its line reads by its status, never the `ok` of a stream opened.
  // The route knows a listen by that header alone, and this is what lets it: the handler serves none the header does not name.
  const mismatched = await ask("write-raw", undefined, { headers: { "mcp-method": "tools/list" } });
  await textUnder(mismatched);
  assert(mismatched.status >= 400 && mismatched.status < 500 && streams.count === 0 && last().rpc === "subscriptions/listen" && last().status === mismatched.status && last().outcome !== "ok",
    `a listen the SDK refuses with a 4xx: no place held, and its line says the refusal (${mismatched.status}; open ${streams.count}; ${JSON.stringify(last())})`);
  await Bun.sleep(30);
  assert(endsSaid().length === endsBeforeRefusals, `…and neither refusal, never a stream held, has an end said of it (${endsSaid().length - endsBeforeRefusals} end line(s))`);
  // A listen the handler reads and this route's parse does not: a byte-order mark before its body (over HTTP, two;
  // a string body keeps its one). Known by its method header, it holds a place like any other, under both bounds.
  const markedAsk = async () => {
    const plain = requestFor("subscriptions/listen", listenParams, "write-raw", { modern: true });
    return holding.fetch(new Request(plain.url, { method: "POST", headers: plain.headers, body: String.fromCharCode(0xfeff) + (await plain.text()) }));
  };
  const marked = reading(await markedAsk());
  const markedOpened = await marked.read(100);
  const markedLine = last();
  const beside = reading(await ask("write-raw"));
  await beside.read(100);
  const markedOver = await markedAsk();
  const markedOverBody = await refusalOf(markedOver);
  assert(marked.status === 200 && !markedOpened.ended && framesOf(markedOpened.text)[0]?.method === "notifications/subscriptions/acknowledged" && markedLine.rpc === "subscriptions/listen" && markedLine.outcome === "ok"
    && streams.count === 2 && markedOverBody.error?.code === -32603 && last().outcome === "refused" && last().code === "LISTEN_CALLER_FULL" && last().rpc === "subscriptions/listen",
    `a listen whose body this route cannot read and the handler can (a byte-order mark): held, counted, its line naming it; and a third such under the name refused (${marked.status}, ended ${markedOpened.ended}; ${JSON.stringify({ rpc: markedLine.rpc, outcome: markedLine.outcome })}; open ${streams.count}; ${JSON.stringify(markedOverBody)}; ${JSON.stringify(last())})`);
  // A notification by that name, at the bound: no stream and no answer owed, so refused bare, as this route's other refusals are.
  const notedOver = await ask("write-raw", undefined, { notification: true });
  const notedOverText = await textUnder(notedOver);
  assert(notedOver.status === 202 && notedOverText === "" && last().outcome === "refused" && last().code === "LISTEN_CALLER_FULL" && last().status === 202 && streams.count === 2,
    `a notification by that name from a name at its bound: refused bare, 202 and no body (${notedOver.status} ${JSON.stringify(notedOverText)}; ${JSON.stringify(last())})`);
  await marked.close();
  await beside.close();
  await until(() => streams.count === 0);
  const noted = await ask("write-raw", undefined, { notification: true });
  await textUnder(noted);
  assert(noted.status === 202 && streams.count === 0 && last().outcome === "ok", `…and under it, the handler's own 202, and no place kept (${noted.status}; open ${streams.count}; ${JSON.stringify(last())})`);

  // A throw on the way: each gives the place back. The caller's server cannot be built (the handler's 500, thrown
  // here); the handler is closed (its fetch throws); and the log's own sink throws once the stream is open.
  {
    let unreadable = true;
    const faultyStreams = createListenStreams(true, 3, 2);
    // The plugins are read once and kept, so the throw has to be the first reading.
    const faulty = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: () => {}, listen: faultyStreams, plugins: () => { if (unreadable) throw new Error("plugins unreadable"); return []; } });
    const askFaulty = async () => faulty.fetch(requestFor("subscriptions/listen", listenParams, "write-raw", { modern: true }));
    const unbuilt: number[] = [];
    for (let i = 0; i < 3; i++) unbuilt.push(await askFaulty().then(async (r) => { await textUnder(r); return r.status; }));
    const unbuiltOpen = faultyStreams.count;
    const unbuiltLine = last();
    unreadable = false;
    const built = reading(await askFaulty());
    const builtOpened = await built.read(100);
    assert(unbuilt.join() === "500,500,500" && unbuiltOpen === 0 && unbuiltLine.outcome === "error" && built.status === 200 && !builtOpened.ended && faultyStreams.count === 1,
      `a listen whose server cannot be built, three times under a name that may hold two: a 500 each, its line \`error\`, and no place kept, so the next is held (${unbuilt.join()}; open ${unbuiltOpen}, then ${faultyStreams.count}; ${JSON.stringify(unbuiltLine)})`);
    await faultyStreams.close();
    const closedRead = await built.read(500);
    const afterClose: number[] = [];
    for (let i = 0; i < 3; i++) afterClose.push(await askFaulty().then(async (r) => { await textUnder(r); return r.status; }));
    assert(closedRead.ended && closedRead.text.includes('"resultType":"complete"') && (await until(() => faultyStreams.count === 0)) && afterClose.every((x) => x >= 500),
      `the app's close ends its stream with the closing frame, and a listen after it is a 500 that keeps no place (ended ${closedRead.ended}; ${afterClose.join()}; open ${faultyStreams.count})`);

    const collecting = useRequestLog(() => { throw new Error("the sink threw"); });
    const unsaid: number[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ask("write-raw");
        void r.body?.cancel().catch(() => {});
        unsaid.push(r.status);
      }
    } finally {
      useRequestLog(collecting);
    }
    const unsaidOpen = streams.count;
    const afterSink = reading(await ask("write-raw"));
    const afterSinkOpened = await afterSink.read(100);
    assert(unsaid.join() === "500,500,500" && unsaidOpen === 0 && afterSink.status === 200 && !afterSinkOpened.ended && streams.count === 1,
      `a throw once the stream is open and handed to no one (the log's sink): a 500, and the place given back, so the name is not shut out (${unsaid.join()}; open ${unsaidOpen}, then ${streams.count})`);
    await afterSink.close();
    await until(() => streams.count === 0);
  }

  // A held stream keeps nothing of its request: a body of two megabytes is let go once the stream is open. Over a
  // real connection, each client a bare socket, so nothing on this side keeps the body either.
  {
    const { heapStats } = await import("bun:jsc");
    const net = await import("node:net");
    const roomyStreams = createListenStreams(true, 64, 64);
    const roomy = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: () => {}, listen: roomyStreams });
    const served = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 255, fetch: (req) => roomy.fetch(req) });
    const asHeaders = [...requestFor("subscriptions/listen", {}, "write-raw", { modern: true }).headers].map(([k, v]) => `${k}: ${v}`).join("\r\n");
    const settledHeap = async () => { for (let i = 0; i < 6; i++) { Bun.gc(true); await Bun.sleep(30); } return heapStats().heapSize / 1048576; };
    const sockets: { destroy: () => void }[] = [];
    const openWith = (pad: number) => new Promise<boolean>((resolve) => {
      const socket = net.connect(served.port!, "127.0.0.1", () => {
        let body: string | null = JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "subscriptions/listen", params: { ...listenParams, pad: "x".repeat(pad), _meta: ENVELOPE } });
        socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n${asHeaders}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
        socket.write(body);
        body = null;
      });
      sockets.push(socket);
      let seen = "";
      socket.on("data", (d) => { if (seen.length < 600) { seen += d.toString(); if (/acknowledged/.test(seen)) resolve(true); else if (/"error"/.test(seen)) resolve(false); } });
      socket.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5_000);
    });
    try {
      for (let i = 0; i < 4; i++) await openWith(0);
      const heapBefore = await settledHeap();
      let opened = 0;
      for (let i = 0; i < 12; i++) if (await openWith(2 * 1024 * 1024)) opened++;
      const heapHeld = await settledHeap();
      assert(opened === 12 && roomyStreams.count === 16 && heapHeld - heapBefore < 8,
        `twelve streams opened with a body of two megabytes each, and held: the heap has not kept the bodies (${opened} opened, ${roomyStreams.count} held; ${Math.round(heapBefore)} MiB before, ${Math.round(heapHeld)} MiB with them held, 24 MiB sent)`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await until(() => roomyStreams.count === 0);
      served.stop(true);
    }
  }

  // A 2025-era request of that name never reaches the handler, and takes no place.
  const legacyListen = await rpc("subscriptions/listen", listenParams, "write-raw", { app: holding });
  assert(streams.count === 0 && legacyListen.body?.error !== undefined, `a 2025-era request by that name: the transport's own refusal, and no place taken (open ${streams.count}; ${JSON.stringify(legacyListen.body?.error)})`);

  // Everything else on such an app is as it was: a tool call, its line written at its end.
  const stats = { total: 3, oldest: "2026-10-01T00:00:00Z", newest: "2026-10-02T00:00:00Z", types: { idea: 3 }, topics: { rest: 2 }, people: {}, aggregated: 3 };
  answer = (n) => (n === "thoughtStats" ? ok(stats) : ok({}));
  const called = await rpc("tools/call", { name: "thought_stats", arguments: {} }, "write-raw", { modern: true, app: holding });
  answer = () => ok({});
  assert(called.status === 200 && called.body?.result !== undefined && last().rpc === "tools/call" && last().tool === "thought_stats" && last().outcome === "ok", `a tool call on an app that holds streams: served and said as ever (${called.status}; ${JSON.stringify(last())})`);

  // The stop, as an app that holds streams sees it. Such a stop closes its streams through the handler a moment
  // before it closes the connections, and the handler's close ends the tool calls in flight too: in that moment a
  // call's answer goes no further and does not end, and no request is begun. And once the drain has ended, finished
  // or cut, nothing that arrives is served.
  {
    const stopping = { cut: false, drainEnded: false };
    const stoppable = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: (l) => said.push(l), listen: createListenStreams(true, 3, 2), stop: stopping });
    const callOn = (app: typeof stoppable, modern: boolean) => app.fetch(requestFor("tools/call", { name: "thought_stats", arguments: {} }, "write-raw", { modern }));
    const unanswered = async (asked: Response | Promise<Response>) => Promise.race([Promise.resolve(asked).then((r) => `answered ${r.status}`), Bun.sleep(300).then(() => "unanswered")]);
    for (const modern of [true, false]) {
      // A call cut by the stop, its answer still open: nothing more of it goes out and it does not end, whether its own work ends it (here, 110 ms on) or the handler's close does.
      answer = (n) => (n === "thoughtStats" ? Bun.sleep(150).then(() => ok(stats)) : ok({}));
      stopping.cut = false;
      const linesAt = lines.length;
      const saidAt = said.length;
      const asking = callOn(stoppable, modern);
      await Bun.sleep(40);
      stopping.cut = true;
      // Under a deadline: a request the cut found before its transport is never answered at all.
      const cutRead = await reading(await Promise.race([Promise.resolve(asking), Bun.sleep(1_000).then(() => new Response("(never answered)"))])).read(400);
      const cutLines = lines.slice(linesAt);
      const cutWarned = said.slice(saidAt).filter((l) => /cut off by the server's stop/.test(l));
      assert(!cutRead.ended && !/Total thoughts/.test(cutRead.text) && !cutRead.text.includes('"result"') && cutLines.length === 1 && cutLines[0].outcome === "cut" && cutLines[0].tool === "thought_stats" && cutWarned.length === 1,
        `a ${modern ? "2026-07-28" : "2025-era"} call whose work ends after the stop's cut: nothing of its result goes out and its answer does not end; one line, \`cut\`, one warning (ended ${cutRead.ended}; ${JSON.stringify(cutRead.text.slice(0, 80))}; ${JSON.stringify(cutLines.map((l) => l.outcome))}; ${cutWarned.length} warning(s))`);
    }
    // A request the cut found before it reached a transport: not begun.
    let asked = 0;
    answer = (n) => { if (n === "thoughtStats") asked++; return ok(stats); };
    const linesAtCut = lines.length;
    const begunLate = await unanswered(callOn(stoppable, true));
    assert(begunLate === "unanswered" && asked === 0 && lines.length === linesAtCut + 1 && last().outcome === "cut", `a request the cut finds not yet at its transport is not begun: no answer, the core not asked, its line \`cut\` (${begunLate}; asked ${asked}; ${JSON.stringify(last())})`);
    // After the drain's end, whatever arrives: not served, a keyed request's line `cut` with the status of one never answered, a liveness probe's none.
    // With the cut's flag down, so that what holds each request back is this gate and not the guard before a transport.
    stopping.cut = false;
    stopping.drainEnded = true;
    const linesAtDrainEnd = lines.length;
    const lateCall = await unanswered(callOn(stoppable, false));
    const lateList = await unanswered(stoppable.fetch(requestFor("tools/list", {}, "write-raw", { modern: true })));
    const lateLines = lines.slice(linesAtDrainEnd);
    const lateProbe = await unanswered(stoppable.fetch(new Request("http://mcp/health")));
    assert(lateCall === "unanswered" && lateList === "unanswered" && lateProbe === "unanswered" && asked === 0 && lateLines.length === 2 && lateLines.every((l) => l.outcome === "cut" && l.status === 0) && lines.length === linesAtDrainEnd + 2,
      `a request that arrives after the stop's drain has ended is not served and not answered: its line \`cut\`, its status 0; a probe the same, with no line (${lateCall}, ${lateList}, ${lateProbe}; asked ${asked}; ${JSON.stringify(lateLines.map((l) => [l.outcome, l.status]))})`);
    // A listen whose client goes after its place is taken and before its stream is handed over (here as the caller's
    // server is built, which only a suite can time): its place is given back at once, though nothing in process
    // reads or cancels the answer, as the runtime would for a client that has gone.
    const goneEarly = new AbortController();
    const goneStreams = createListenStreams(true, 3, 2);
    const goneApp = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: () => {}, listen: goneStreams, plugins: () => { goneEarly.abort(); return []; } });
    const goneAnswered = await Promise.race([Promise.resolve(goneApp.fetch(requestFor("subscriptions/listen", listenParams, "write-raw", { modern: true, signal: goneEarly.signal }))).then((r) => r.status, () => 0), Bun.sleep(1_000).then(() => -1)]);
    await Bun.sleep(50);
    assert(goneEarly.signal.aborted && goneAnswered === 200 && goneStreams.count === 0, `a listen whose client goes between its place and its stream holds no place (answered ${goneAnswered}; open ${goneStreams.count})`);
    void goneStreams.close();

    // An app that holds none has neither gate: its stop closes its connections at the cut and has no handler to close first, so a call that ends after the flag is whatever it was, and what arrives after the drain's end is served.
    const plainStop = { cut: false, drainEnded: false };
    const plainApp = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: (l) => said.push(l), stop: plainStop });
    answer = (n) => (n === "thoughtStats" ? Bun.sleep(100).then(() => ok(stats)) : ok({}));
    const plainAsking = callOn(plainApp, true);
    await Bun.sleep(30);
    plainStop.cut = true;
    const plainRead = await reading(await plainAsking).read(500);
    assert(plainRead.ended && /Total thoughts: 3/.test(plainRead.text), `an app that holds no stream cuts nothing itself: a call that ends after the flag is answered as it was (ended ${plainRead.ended}; ${plainRead.text.length} bytes)`);
    plainStop.cut = false;
    plainStop.drainEnded = true;
    answer = () => ok({});
    const plainLate = await unanswered(plainApp.fetch(requestFor("tools/list", {}, "write-raw", { modern: true })));
    const plainProbe = await unanswered(plainApp.fetch(new Request("http://mcp/health")));
    assert(plainLate === "answered 200" && plainProbe === "answered 200", `…and with the drain's end flagged it still serves what arrives (${plainLate}, ${plainProbe})`);
    answer = () => ok({});

    // The end of a stream at the stop (SMD-4459). As the drain ends, each stream still open is recorded as the
    // stop's, and keeps its place: the stop counts its streams by their places until they are closed. The close that
    // follows gives the places back and records nothing more. One whose client went before the stop was said then.
    // Twenty-four are open, twelve under each of two names: the word is every stream's, not the first few's.
    const endStop = { cut: false, drainEnded: false };
    const endStreams = createListenStreams(true, 32, 16);
    const endApp = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: () => {}, listen: endStreams, stop: endStop });
    const askEnd = async (key: string) => reading(await endApp.fetch(requestFor("subscriptions/listen", listenParams, key, { modern: true })));
    const [e1, e2, e3] = [await askEnd("write-raw"), await askEnd("read-raw"), await askEnd("write-raw")];
    for (const r of [e1, e2, e3]) await r.read(50);
    await e3.close();
    await until(() => endStreams.count === 2);
    await Bun.sleep(30);
    const e4 = await askEnd("write-raw");
    await e4.read(50);
    const more = await Promise.all(Array.from({ length: 21 }, (_, i) => askEnd(i % 2 ? "write-raw" : "read-raw")));
    await Promise.all(more.map((r) => r.read(50)));
    const endsAtStop = endsSaid().length;
    endStop.drainEnded = true;
    endStreams.stopped();
    const atDrain = endsSaid().slice(endsAtStop);
    const placesAtDrain = endStreams.count;
    const unsaidAtDrain = endStreams.unsaid();
    await endStreams.close();
    const [e1Read, e2Read] = [await e1.read(500), await e2.read(500)];
    const placesBack = await until(() => endStreams.count === 0);
    await Bun.sleep(30);
    const afterClose = endsSaid().slice(endsAtStop);
    const moreEnded = (await Promise.all(more.map((r) => r.read(500)))).filter((r) => r.ended).length;
    assert(atDrain.length === 24 && atDrain.every((l) => l.end === "stop") && atDrain.filter((l) => l.agent === "laptop").length === 12 && atDrain.filter((l) => l.agent === "chatgpt").length === 12 && placesAtDrain === 24 && unsaidAtDrain === 0
      && e1Read.ended && e2Read.ended && e1Read.text.includes('"resultType":"complete"') && (await e4.read(500)).ended && moreEnded === 21 && placesBack && afterClose.length === 24,
      `the stop's drain ended with twenty-four streams open, one more closed by its client before it: each of the twenty-four is recorded then, \`stop\`, its place kept and its end no longer unsaid; the close that follows gives the places back and records nothing more (${atDrain.length} end(s) at the drain's end, ${atDrain.filter((l) => l.agent === "laptop").length} and ${atDrain.filter((l) => l.agent === "chatgpt").length} by name; ${placesAtDrain} place(s) and ${unsaidAtDrain} unsaid then, ${endStreams.count} place(s) after the close; ${afterClose.length} end(s) in all)`);
    // A close after the drain's end that the app was not told of as above is the stop's all the same, said at the close.
    const flaggedStop = { cut: false, drainEnded: false };
    const flaggedStreams = createListenStreams(true, 3, 2);
    const flaggedApp = createMcpApp({ rest, edge: () => ({ configured: false, origin: null }), warn: () => {}, listen: flaggedStreams, stop: flaggedStop });
    const f1 = reading(await flaggedApp.fetch(requestFor("subscriptions/listen", listenParams, "write-raw", { modern: true })));
    await f1.read(50);
    const endsAtFlag = endsSaid().length;
    flaggedStop.drainEnded = true;
    await flaggedStreams.close();
    await f1.read(500);
    await until(() => endsSaid().length === endsAtFlag + 1);
    assert(endsSaid().length === endsAtFlag + 1 && endsSaid().at(-1)?.end === "stop" && flaggedStreams.count === 0 && flaggedStreams.unsaid() === 0, `a stream closed once the drain's end is flagged, with no word to the app first: its end is the stop's, said at its close, and it is kept no longer (${JSON.stringify(endsSaid().slice(endsAtFlag).map((l) => l.end))}; open ${flaggedStreams.count}, ${flaggedStreams.unsaid()} unsaid)`);
  }

  console.warn = warnBefore;
  useRequestLog(before);
}

console.log("\n[10] The token exchange at the hop (SMD-2286 PR 2): an OAuth token traded for the REST core's, cached by its digest, never sent as a key; its refusals RFC 6750's");
{
  const ORIGIN = "https://brain.example.test";
  const ISSUER = `${ORIGIN}/auth`;
  // ES256 by WebCrypto (its signature is JWS's r||s): the authorization server's key, and a JWT minted with it.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const mint = async (claims: Record<string, unknown>) => {
    // Every token the authorization server signs names its client (RFC 9068): a connector's, unless the claims say otherwise.
    const nowS = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "ES256", typ: "at+jwt", kid: "t" })}.${b64({ iss: ISSUER, iat: nowS, exp: nowS + 600, client_id: "connector", ...claims })}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(head)));
    return `${head}.${Buffer.from(sig).toString("base64url")}`;
  };
  const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()) as Record<string, unknown>;
  // The authorization server's token endpoint, as deploy/auth/server.ts's grant answers: the `mcp` client's secret, the
  // subject's /mcp audience, the same subject and scope, `act: {sub: "mcp", act: {sub: <the subject token's client>}}`
  // (SMD-3064), the REST core's audience.
  let asMode: "ok" | "down" | "busy" | "limited" | "truncated" | "stalled" | "echo" | "echo-hex" | "slow" | "invalid_grant" | "invalid_scope" | "invalid_client" = "ok";
  // A bare 64-hex value, the shape of OB1_AUTH_SECRET_MCP and of a keygen key, starting with a letter.
  const HEX64 = `f${"0123456789abcdef".repeat(4).slice(1)}`;
  // The authorization server's health, as the edge's probe reads it: asked every time (no TTL), so a step flips it.
  let asUp = true;
  useAuthReachability(new AuthReachability("http://auth.test/healthz", 0, 500, (async () => new Response(null, { status: asUp ? 200 : 503 })) as unknown as typeof fetch));
  let trades = 0;
  let lastForm: URLSearchParams | null = null;
  const asFetch = async (req: Request): Promise<Response> => {
    trades++;
    if (asMode === "down") throw new TypeError("fetch failed: connection refused");
    // Slower than the keyed routes' 2.5 s deadline, within the trade's 5 s.
    if (asMode === "slow") await new Promise((done) => setTimeout(done, 3_000));
    if (asMode === "busy") return new Response("busy", { status: 503 });
    if (asMode === "limited") return Response.json({ error: "slow_down" }, { status: 429 });
    // A 200 cut short, as a body that stalled past the timeout reads.
    if (asMode === "truncated") return new Response('{"access_token":"ey', { status: 200, headers: { "content-type": "application/json" } });
    // A refusal whose body stalls past the timeout, as the fetch's signal ends it.
    if (asMode === "stalled") return new Response(new ReadableStream({ start(c) { c.error(new DOMException("The operation timed out.", "TimeoutError")); } }), { status: 400, headers: { "content-type": "application/json" } });
    const form = new URLSearchParams(await req.text());
    lastForm = form;
    const okClient = req.headers.get("authorization") === `Basic ${Buffer.from("mcp:mcp-secret").toString("base64")}`;
    if (asMode === "invalid_client" || !okClient) return Response.json({ error: "invalid_client" }, { status: 401 });
    // An authorization server that echoes what it was sent in `error`: none of it may reach the log.
    if (asMode === "echo-hex") return Response.json({ error: HEX64 }, { status: 400 });
    if (asMode === "echo") return Response.json({ error: `invalid_request ${form.get("subject_token")} ${req.headers.get("authorization")}` }, { status: 400 });
    if (asMode !== "ok") return Response.json({ error: asMode }, { status: 400 });
    const subject = claimsOf(form.get("subject_token") ?? "");
    const exchanged = await mint({ sub: subject.sub, scope: subject.scope, aud: form.get("resource"), act: { sub: "mcp", act: { sub: subject.client_id } }, exp: subject.exp, client_id: "mcp" });
    // The token's lifetime as issued, not read off the wall clock: the
    // exchanger below runs on `clock`, so a wall-clock answer read 599 when
    // the mint and the trade fell either side of a second, and the "594 s on"
    // row then asked at the entry's `until`, the first instant it is gone, and
    // traded again (SMD-3470's review, once in ~14 runs beside the background
    // suites). A real server answers the time left (deploy/auth/server.ts);
    // the two agree when the mint and the trade fall in one wall-clock second,
    // and the stub answers the lifetime so that a straddle can't move the entry.
    return Response.json({ access_token: exchanged, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: (subject.exp as number) - (subject.iat as number), scope: subject.scope });
  };
  let clock = Date.now();
  let keysDown = false;
  const exchanger = createExchanger(exchangeSettings(ORIGIN, "mcp-secret")!, { fetch: asFetch, now: () => clock });
  // The REST core checking its own tokens (server-portable/oauth-token.ts), over the stub core above.
  const restWithTokens = createRestApp({
    core, init: () => {}, track: (run) => run(), log: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: [`laptop:write:${hashKey("write-raw")}`, `mcp:forward:${hashKey("fwd-raw")}`, `legacy:read:${hashKey("team.alice.k2026")}`].join(",") }),
    tokens: () => checkerOver(tokenSettings({ COMPOSE_PROFILES: "auth", OB1_PUBLIC_ORIGIN: ORIGIN })!, async () => {
      if (keysDown) throw new TypeError("fetch failed: the key set could not be read");
      return pair.publicKey;
    }),
    resolve: async (p) => (p.scope === "forward" ? { status: "ok", agentId: "agent-f" } : identity),
  });
  const restCalls: { key: string | null; bearer: string | null }[] = [];
  // A REST core echoing a secret in its code — at whoami, as the forwarder's refusal, at an operation: never printed whole.
  let whoamiEcho = false;
  let forwarderEcho = false;
  let opEcho = false;
  const tokenRest = createRestClient({
    baseUrl: "http://api.ob1.internal",
    fetch: async (req) => {
      restCalls.push({ key: req.headers.get("x-brain-key"), bearer: req.headers.get("authorization") });
      const atWhoami = new URL(req.url).pathname.endsWith("/whoami");
      if (whoamiEcho && atWhoami) return Response.json({ code: HEX64 }, { status: 500 });
      if (forwarderEcho && atWhoami) return Response.json({ code: HEX64, credential: "forwarder" }, { status: 401 });
      if (opEcho && !atWhoami) return Response.json({ code: HEX64 }, { status: 409 });
      return restWithTokens.fetch(req);
    },
    forwarderKey: "fwd-raw",
  });
  let trading: boolean = true;
  const tokenApp = createMcpApp({ rest: tokenRest, edge: () => ({ configured: true, origin: ORIGIN }), exchanger: () => (trading ? exchanger : null), warn: (line) => warned.push(line) });
  const warned: string[] = [];
  const ask = async (token: string | null, opts: { method?: string; params?: unknown; host?: string; key?: string; access?: string; path?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.key) headers["x-brain-key"] = opts.key;
    if (opts.access) headers["x-access-key"] = opts.access;
    const r = await tokenApp.fetch(new Request(`${opts.host ?? ORIGIN}${opts.path ?? "/mcp"}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: opts.method ?? "tools/list", params: opts.params ?? {} }) }));
    const text = await r.text();
    const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
    return { status: r.status, headers: r.headers, body: line ? JSON.parse(line) as Record<string, unknown> : null };
  };
  const www = (r: { headers: Headers }) => r.headers.get("www-authenticate") ?? "";
  const toolNames = (r: { body: Record<string, unknown> | null }) => (((r.body?.result as { tools?: { name: string }[] } | undefined)?.tools) ?? []).map((t) => t.name).sort();
  identity = { status: "ok", agentId: "agent-o" };

  // A write connector: traded once, then from the cache; its calls carry the exchanged token, never the client's.
  const write = await mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp`, client_id: "connector-w" });
  trades = 0;
  restCalls.length = 0;
  let r = await ask(write);
  assert(r.status === 200 && same(toolNames(r), [...visibleToolNames({ scope: "write" })].sort()) && trades === 1, `a write token: traded once, a write key's tools (${r.status}, ${toolNames(r).length} tools, ${trades} trade)`);
  const sent = lastForm as URLSearchParams | null;
  assert(sent?.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange" && sent?.get("resource") === `${ORIGIN}/api` && sent?.get("subject_token") === write, "…by RFC 8693, for the REST core's resource, as the `mcp` client");
  assert(restCalls.every((c) => c.key === null && c.bearer !== `Bearer ${write}` && c.bearer?.startsWith("Bearer ")), "…and the REST core is sent the exchanged token as a bearer, never the client's token, never as a key");
  r = await ask(write);
  assert(r.status === 200 && trades === 1, `the same token again: from the cache, no second trade (${trades})`);
  calls.length = 0;
  answer = () => ok({ id: "t1", reader: false, tags: {}, chunks: 0, contextFailures: 0, headWindow: null, recapture: null, embeddings: { allowed: true, reason: "allowed" }, chat: { allowed: true, reason: "allowed", base: "http://x/v1" } });
  r = await ask(write, { method: "tools/call", params: { name: "capture_thought", arguments: { content: "a token's thought" } } });
  const p = calls.find((c) => c.name === "capture")?.principal as Principal | undefined;
  assert(p?.name === "oauth:operator+connector-w" && p.scope === "write" && same(p.act, { name: "oauth:mcp" }), `a capture runs at the REST core as the operator through its connector, oauth:operator+connector-w, act the MCP service (${JSON.stringify(p && { name: p.name, scope: p.scope, act: p.act })})`);
  answer = () => ok({});

  // Verify: a read connector and a write connector of the same subject — the read one's calls never carry write.
  const read = await mint({ sub: "operator", scope: "brain:read", aud: `${ORIGIN}/mcp` });
  r = await ask(read);
  assert(same(toolNames(r), [...visibleToolNames({ scope: "read" })].sort()), `a read token of the same subject, the write one cached: a read key's tools (${toolNames(r).length})`);
  calls.length = 0;
  r = await ask(read, { method: "tools/call", params: { name: "capture_thought", arguments: { content: "x" } } });
  const readCapture = (r.body?.result as { isError?: boolean } | undefined)?.isError === true || (r.body?.error !== undefined);
  assert(readCapture && !calls.some((c) => c.name === "capture"), "…and its capture is refused, the core never asked: the cache keys by the token, not the subject");
  const both = await Promise.all([ask(write), ask(read)]);
  assert(same(toolNames(both[0]), [...visibleToolNames({ scope: "write" })].sort()) && same(toolNames(both[1]), [...visibleToolNames({ scope: "read" })].sort()), "…both at once: each its own scope");

  // One trade at a time per token; the entry lives until 5 s before the exchanged token's expiry.
  const fresh = await mint({ sub: "operator", scope: "brain:read", aud: `${ORIGIN}/mcp` });
  trades = 0;
  await Promise.all(Array.from({ length: 10 }, () => ask(fresh)));
  assert(trades === 1, `ten requests at once with a new token: one trade (${trades})`);
  clock += (600 - 6) * 1000;
  await ask(fresh);
  assert(trades === 1, `594 s on: still from the cache (${trades})`);
  // At the entry's `until` exactly, a known moment since the stub's lifetime
  // is fixed: the first instant the entry is gone.
  clock += 1000;
  await ask(fresh);
  assert(trades === 2, `595 s on, at the 5 s margin: traded again (${trades})`);
  clock = Date.now();

  // Refused before any trade, on the claims: expired, another audience, another issuer, more audiences than /mcp, no expiry.
  trades = 0;
  for (const [label, made] of [
    ["expired", mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp`, exp: Math.floor(Date.now() / 1000) - 5 })],
    ["the REST core's audience", mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/api` })],
    ["another issuer", mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp`, iss: "https://elsewhere.example.test/auth" })],
    ["an audience list naming /mcp and the REST core", mint({ sub: "operator", scope: "brain:write", aud: [`${ORIGIN}/mcp`, `${ORIGIN}/api`] })],
    ["no expiry", mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp`, exp: undefined })],
  ] as const) {
    r = await ask(await made);
    assert(r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes('error="invalid_token"') && (r.headers.get("www-authenticate") ?? "").includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`), `${label}: 401 invalid_token naming the document (${r.status} ${r.headers.get("www-authenticate")})`);
  }
  assert(trades === 0, `…none of them traded (${trades})`);
  // The authorization server away: an expired token's refresh cannot finish, so 503, never a 401 that sends the client to an interactive sign-in.
  asUp = false;
  const lapsed = await mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp`, exp: Math.floor(Date.now() / 1000) - 5 });
  r = await ask(lapsed);
  assert(r.status === 503 && r.headers.get("retry-after") === "30", `an expired token with the authorization server away: 503, retry in 30 s (${r.status} ${r.headers.get("retry-after")})`);
  asUp = true;

  // The authorization server's answers to a trade.
  const live = async () => mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp`, jti: crypto.randomUUID() });
  asMode = "invalid_grant";
  r = await ask(await live());
  assert(r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'), `the authorization server refuses the subject token (invalid_grant): 401 invalid_token, so the client refreshes (${r.status})`);
  asMode = "invalid_scope";
  r = await ask(await live());
  assert(r.status === 403 && www(r).includes('error="insufficient_scope"') && www(r).includes('scope="brain:read"'), `its scopes name no key scope (invalid_scope): 403 insufficient_scope, naming brain:read to step up to (${r.status} ${www(r)})`);
  warned.length = 0;
  for (const [mode, label] of [["down", "away"], ["busy", "answering 503"], ["limited", "limiting this server (429)"], ["truncated", "answering a 200 cut short"], ["stalled", "stalling a refusal's body"]] as const) {
    asMode = mode;
    r = await ask(await live());
    assert(r.status === 503 && r.headers.get("retry-after") === "30", `the authorization server ${label}: 503, retry in 30 s — not a 401 that restarts a sign-in (${r.status} ${r.headers.get("retry-after")})`);
  }
  assert(warned.some((l) => l.includes("an OAuth token could not be checked") && l.includes("it could not be reached")) && warned.some((l) => l.includes("rate-limited")), `…each said in the log, why in this server's own words (${warned.length} lines: ${warned.join(" | ").slice(0, 160)})`);
  asMode = "invalid_client";
  warned.length = 0;
  r = await ask(await live());
  assert(r.status === 500, `this server's own client refused (invalid_client): a fault, not the caller's refusal (${r.status})`);
  assert(warned.some((l) => l.includes("this server is misconfigured") && l.includes("OB1_AUTH_SECRET_MCP")), `…said as this server's misconfiguration, with its fix (${warned.join(" | ")})`);
  asMode = "echo";
  warned.length = 0;
  const echoed = await live();
  r = await ask(echoed);
  assert(r.status === 500 && warned.length === 1 && !warned[0].includes(echoed.slice(-20)) && !warned[0].includes("Basic") && warned[0].includes("no error code"), `an error code echoing the token and the client's secret: a fault, neither printed (${warned.join(" | ").slice(0, 160)})`);
  // Asked of the exchange itself: the log says a line once a minute, and the echo above said this one.
  asMode = "echo-hex";
  const hexSaid = await exchanger.exchange(await live()).then((x) => `no throw: ${x.status}`, (e: Error) => e.message);
  assert(hexSaid.includes("no error code") && !hexSaid.includes(HEX64), `an error that is a bare 64-hex value, a secret's shape: never printed (${hexSaid.slice(0, 120)})`);
  asMode = "ok";
  whoamiEcho = true;
  warned.length = 0;
  await ask(await live());
  await ask(null, { key: "write-raw" });
  whoamiEcho = false;
  assert(warned.length === 2 && warned.every((l) => !l.includes(HEX64)), `a whoami code echoing a secret, for a token and for a key: never printed (${warned.join(" | ").slice(0, 160)})`);
  forwarderEcho = true;
  warned.length = 0;
  await ask(null, { key: "write-raw" });
  forwarderEcho = false;
  assert(warned.length === 1 && warned[0].includes("forwarder key") && !warned[0].includes(HEX64), `…as the forwarder's refusal: never printed (${warned.join(" | ").slice(0, 120)})`);
  opEcho = true;
  r = await ask(null, { key: "write-raw", method: "tools/call", params: { name: "thought_stats", arguments: {} } });
  opEcho = false;
  const opText = JSON.stringify(r.body ?? {});
  assert(opText.includes("the REST core answered 409") && !opText.includes(HEX64), `…at an operation: the tool's fault names the status, never the code (${opText.slice(0, 120)})`);

  // The REST core's word on the exchanged token: a revoked subject is refused as a revoked key is (no sign-in loop).
  identity = { status: "revoked", agentId: "agent-o", revokedAt: "2026-10-19T00:00:00Z", reason: null };
  r = await ask(await live());
  const revokedMessage = ((r.body?.error as { message?: string } | undefined)?.message ?? "");
  assert(r.status !== 401 && revokedMessage === REVOKED_MESSAGE, `the subject revoked in the registry: the revoked key's refusal, not a 401 challenge (${r.status} ${revokedMessage.slice(0, 40)})`);
  identity = { status: "ok", agentId: "agent-o" };
  // Its scopes reaching no operation there (brain:read with brain:capture): 403, as the authorization server's invalid_scope.
  const narrow = await mint({ sub: "operator", scope: "brain:read brain:capture", aud: `${ORIGIN}/mcp`, jti: crypto.randomUUID() });
  r = await ask(narrow);
  assert(r.status === 403 && www(r).includes('error="insufficient_scope"'), `the REST core finds the exchanged token's scopes reach nothing: 403 insufficient_scope (${r.status} ${www(r)})`);
  // Its trade kept, the authorization server away: still 403, a scope no retry mends — only a refused token waits on the server.
  asUp = false;
  r = await ask(narrow);
  asUp = true;
  assert(r.status === 403, `…and with the authorization server away, from its kept trade: 403 still, not 503 (${r.status})`);
  // Its key set unreadable there: 503, retry — never a 401 sign-in, never a busy registry's JSON-RPC refusal.
  keysDown = true;
  r = await ask(await live());
  keysDown = false;
  assert(r.status === 503 && r.headers.get("retry-after") === "30", `the REST core cannot read the authorization server's keys: 503, retry in 30 s (${r.status} ${r.headers.get("retry-after")})`);

  // The keyed routes at the origin's Host take a token as they take a key: a scan's job links, the mirrors; /health's record is a key's.
  answer = (n) => (n === "workerStatus" ? ok({ pools: [{ workType: "w", pending: 1 }] }) : n === "jobStatus" ? ok({ jobId: "job-7", kind: "scan", status: "succeeded" }) : { version: "1.0.0", store: "sql" });
  const keyedGet = async (path: string, token: string, host = ORIGIN) => {
    const k = await tokenApp.fetch(new Request(`${host}${path}`, { headers: { authorization: `Bearer ${token}` } }));
    return { status: k.status, text: await k.text() };
  };
  restCalls.length = 0;
  let k = await keyedGet("/mcp/jobs/job-7", read);
  assert(k.status === 200 && k.text.includes('"status":"succeeded"'), `a read token at a job link under the origin: the job (${k.status} ${k.text.slice(0, 60)})`);
  k = await keyedGet("/mcp/worker-status", read);
  assert(k.status === 200 && k.text === JSON.stringify([{ workType: "w", pending: 1 }]), `…at a keyed mirror: the rows (${k.text.slice(0, 60)})`);
  assert(restCalls.length > 0 && restCalls.every((c) => c.key === null && c.bearer?.startsWith("Bearer ") && c.bearer !== `Bearer ${read}`), "…each read with the exchanged token, the client's never sent");
  trades = 0;
  restCalls.length = 0;
  k = await keyedGet("/mcp/health", read);
  assert(k.text === "ok" && trades === 0 && restCalls.length === 0, `…at /health: liveness, no trade, nothing sent (the REST core's record is a key's) (${k.text.slice(0, 40)}, ${trades}, ${restCalls.length})`);
  k = await keyedGet("/mcp/worker-status", read, "http://127.0.0.1:8000");
  assert(k.text === "ok", `…and at a loopback Host, no trade: shown nothing (${k.text.slice(0, 40)})`);
  const keyedHead = async (path: string, token: string) => {
    const h = await tokenApp.fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }));
    await h.text();
    return { status: h.status, www: h.headers.get("www-authenticate") ?? "", retry: h.headers.get("retry-after") };
  };
  let kh = await keyedHead("/mcp/jobs/job-7", lapsed);
  assert(kh.status === 401 && kh.www.includes('error="invalid_token"'), `an expired token at a job link: 401 invalid_token, so the poller refreshes — never \`ok\` for ever (${kh.status} ${kh.www.slice(0, 60)})`);
  kh = await keyedHead("/mcp/jobs/job-7/stream", await mint({ sub: "operator", scope: "brain:read", aud: `${ORIGIN}/api` }));
  assert(kh.status === 401 && kh.www.includes('error="invalid_token"'), `…a token for another audience at a job stream: 401 (${kh.status})`);
  asMode = "invalid_scope";
  kh = await keyedHead("/mcp/worker-status", await live());
  asMode = "ok";
  assert(kh.status === 403 && kh.www.includes('error="insufficient_scope"'), `…scopes reaching nothing at a mirror: 403 insufficient_scope (${kh.status})`);
  asUp = false;
  kh = await keyedHead("/mcp/jobs/job-7", lapsed);
  asUp = true;
  assert(kh.status === 503 && kh.retry === "30", `…an expired token at a job link with the authorization server away: 503, retry in 30 s (${kh.status} ${kh.retry})`);
  {
    const { useRequestLog } = await import("../server-portable/telemetry.ts");
    const lines: Record<string, unknown>[] = [];
    const before = useRequestLog((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
    await keyedHead("/mcp/jobs/job-7", lapsed);
    asUp = false;
    await keyedHead("/mcp/jobs/job-7", lapsed);
    asUp = true;
    useRequestLog(before);
    const ours = lines.filter((l) => l.door === "mcp" && l.route === "/jobs/:id");
    assert(ours.length === 2 && ours[0].outcome === "refused" && ours[0].code === "UNAUTHORIZED" && ours[0].status === 401 && ours[1].outcome === "refused" && ours[1].code === "AUTH_UNREACHABLE" && ours[1].status === 503, `…its line \`refused\`, the code beside it (${JSON.stringify(ours.map((l) => [l.status, l.outcome, l.code]))})`);
  }
  // A trade slower than the keyed routes' deadline: 503, retry, never \`ok\`; the next poll is answered from the kept trade.
  asMode = "slow";
  warned.length = 0;
  const slowToken = await live();
  kh = await keyedHead("/mcp/jobs/job-7", slowToken);
  assert(kh.status === 503 && kh.retry === "30" && warned.some((l) => l.includes("an OAuth token could not be checked")), `a trade past a job link's deadline: 503, retry in 30 s, said in the log (${kh.status} ${kh.retry})`);
  await new Promise((done) => setTimeout(done, 700));
  asMode = "ok";
  const after = await keyedGet("/mcp/jobs/job-7", slowToken);
  assert(after.status === 200 && after.text.includes('"status":"succeeded"'), `…and the next poll, the trade kept: the job (${after.status} ${after.text.slice(0, 40)})`);
  answer = () => ok({});

  // A token beside a key form is a key client's, and is still never sent on as a key.
  restCalls.length = 0;
  await ask(write, { key: "unknown-raw" });
  await ask(write, { path: "/mcp?key=" });
  await tokenApp.fetch(new Request(`${ORIGIN}/mcp/health`, { headers: { authorization: `Bearer ${write}`, "x-brain-key": "unknown-raw" } }));
  assert(restCalls.length > 0 && restCalls.every((c) => c.key !== write && c.bearer !== `Bearer ${write}`), `a token beside an unknown key or an empty ?key=: never sent to the REST core (${restCalls.length} calls)`);

  // A raw key with dots in a key form is a key, as the REST core reads it: only the bearer slot's JWT shape is passed over.
  r = await ask(null, { key: "team.alice.k2026" });
  assert(r.status === 200 && same(toolNames(r), [...visibleToolNames({ scope: "read" })].sort()), `a dotted raw key as x-brain-key: a read key's tools (${r.status}, ${toolNames(r).length})`);
  r = await ask(null, { path: "/mcp?key=team.alice.k2026" });
  assert(r.status === 200 && same(toolNames(r), [...visibleToolNames({ scope: "read" })].sort()), `…as ?key=: the same (${r.status}, ${toolNames(r).length})`);
  for (const [form, opts] of [["x-brain-key", { key: "team.alice.k2026" }], ["x-access-key", { access: "team.alice.k2026" }], ["?key=", { path: "/mcp?key=team.alice.k2026" }]] as const) {
    r = await ask("team.alice.k2026", opts);
    assert(r.status === 200 && same(toolNames(r), [...visibleToolNames({ scope: "read" })].sort()), `…as ${form} and the bearer both: the same (${r.status}, ${toolNames(r).length})`);
  }
  // A keygen key (hex, no dots) as a bearer on a stack with OAuth: a key, as ever.
  r = await ask("write-raw");
  assert(r.status === 200 && same(toolNames(r), [...visibleToolNames({ scope: "write" })].sort()), `a key with no dots as a bearer on a stack with OAuth: a key's tools (${r.status}, ${toolNames(r).length})`);
  /** tools/list to another app of this section, with a bearer: its status and its text. */
  const listWith = async (app: ReturnType<typeof createMcpApp>, bearer: string) => {
    const res = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} }) }));
    return { status: res.status, text: await res.text() };
  };
  // A stack with no public origin has no OAuth: a bearer of any shape is a key there, as server-portable reads it.
  const noOAuth = createMcpApp({ rest: tokenRest, edge: () => ({ configured: false, origin: null }), exchanger: () => exchanger, warn: () => {} });
  const lone = await listWith(noOAuth, "team.alice.k2026");
  assert(lone.status === 200 && lone.text.includes('"name":"search"') && !lone.text.includes("capture_thought"), `…as a lone bearer on a stack with no OAuth: a read key's tools (${lone.status} ${lone.text.slice(0, 50)})`);
  answer = (n) => (n === "workerStatus" ? ok({ pools: [{ workType: "w", pending: 1 }] }) : { version: "1.0.0", store: "sql" });
  const dotted = await tokenApp.fetch(new Request(`${ORIGIN}/mcp/worker-status`, { headers: { "x-brain-key": "team.alice.k2026" } }));
  const dottedHealth = await tokenApp.fetch(new Request(`${ORIGIN}/mcp/health`, { headers: { "x-brain-key": "team.alice.k2026" } }));
  const dottedRecord = await dottedHealth.text();
  assert((await dotted.text()) === JSON.stringify([{ workType: "w", pending: 1 }]) && dottedRecord.includes('"version":"1.0.0"'), `…at a mirror and /health: the rows and the record (${dottedRecord.slice(0, 40)})`);
  answer = () => ok({});

  /** This section's MCP app at ORIGIN, trading, over a REST core of its own (the forwarder's key alone) checking tokens with `tokens`, its log kept in `warned`. */
  const appOverRest = (tokens: (() => ReturnType<typeof checkerOver>) | undefined, warned: string[]) => {
    const rest = createRestApp({
      core, init: () => {}, track: (run) => run(), log: () => {},
      keys: () => ({ MCP_ACCESS_KEYS: `mcp:forward:${hashKey("fwd-raw")}` }),
      ...(tokens ? { tokens } : {}),
      resolve: async (p) => (p.scope === "forward" ? { status: "ok", agentId: "agent-f" } : identity),
    });
    return createMcpApp({ rest: createRestClient({ baseUrl: "http://api.ob1.internal", fetch: async (req) => rest.fetch(req), forwarderKey: "fwd-raw" }), edge: () => ({ configured: true, origin: ORIGIN }), exchanger: () => exchanger, warn: (line) => warned.push(line) });
  };
  // A REST core that checks no token: an exchanged token's 401 is this stack's misconfiguration, a fault with its fix, never invalid_token.
  const plainWarned: string[] = [];
  const plain = await listWith(appOverRest(undefined, plainWarned), await live());
  assert(plain.status === 500 && plainWarned.some((l) => l.includes("refused a token traded for it") && l.includes("checking no token") && l.includes("auth profile")), `a REST core that checks no token: a fault, logged with its fix (${plain.status} ${plainWarned.join(" | ").slice(0, 120)})`);
  // One checking another origin's tokens refuses this one on its claims, credential token: the same misconfiguration, never invalid_token.
  const elsewhereWarned: string[] = [];
  const elsewhere = await listWith(appOverRest(() => checkerOver(tokenSettings({ COMPOSE_PROFILES: "auth", OB1_PUBLIC_ORIGIN: "https://elsewhere.example.test" })!, async () => pair.publicKey), elsewhereWarned), await live());
  assert(elsewhere.status === 500 && elsewhereWarned.some((l) => l.includes("refused a token traded for it") && !l.includes("checking no token") && l.includes("OB1_PUBLIC_ORIGIN")), `a REST core on another origin: a fault, logged with its fix, never a sign-in loop (${elsewhere.status} ${elsewhereWarned.join(" | ").slice(0, 120)})`);

  // Where no token is traded: at another Host, or a server given no exchange — and a token is never sent as a key.
  trades = 0;
  restCalls.length = 0;
  r = await ask(write, { host: "http://127.0.0.1:8000" });
  assert(trades === 0 && r.status === 200 && (r.body?.error as { code?: number } | undefined)?.code === -32001, `a token at a loopback Host: today's refusal, no trade (${r.status}, ${trades})`);
  trading = false;
  asUp = false;
  r = await ask(write);
  // No caller, so the edge answers a token as before: its challenge while the authorization server answers its probe, 503 while it does not (as here).
  assert(trades === 0 && r.status === 503 && r.headers.get("retry-after") === "30", `a server given no exchange (no secret): the token is no caller, the edge's answer as before (${r.status})`);
  assert(restCalls.every((c) => c.key !== write && c.bearer !== `Bearer ${write}`), "…and in neither case is the client's token sent to the REST core, as a key or a bearer");
  trading = true;
  asUp = true;

  // Verify (step 4's half): a key client goes on working with the authorization server away.
  asMode = "down";
  r = await ask(null, { key: "write-raw" });
  assert(r.status === 200 && same(toolNames(r), [...visibleToolNames({ scope: "write" })].sort()), `a key client with the authorization server away: served as ever (${r.status})`);
  asMode = "ok";

  // The cache is bounded.
  const bounded = createExchanger(exchangeSettings(ORIGIN, "mcp-secret")!, { fetch: asFetch });
  for (let i = 0; i < MAX_ENTRIES + 20; i++) await bounded.exchange(await mint({ sub: "operator", scope: "brain:read", aud: `${ORIGIN}/mcp`, jti: `j${i}` }));
  assert(bounded.size() === MAX_ENTRIES, `${MAX_ENTRIES + 20} distinct tokens: the cache holds ${MAX_ENTRIES} (${bounded.size()})`);
  // A token that lapses inside the margin is used once and never kept.
  const brief = createExchanger(exchangeSettings(ORIGIN, "mcp-secret")!, { fetch: asFetch });
  const once = await brief.exchange(await mint({ sub: "operator", scope: "brain:read", aud: `${ORIGIN}/mcp`, exp: Math.floor(Date.now() / 1000) + 3 }));
  assert(once.status === "ok" && brief.size() === 0, `a token 3 s from expiry: traded, not kept (${once.status}, ${brief.size()})`);
  useAuthReachability(null);
}

report();
