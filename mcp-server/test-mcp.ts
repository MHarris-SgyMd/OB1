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
import { REVOKED_MESSAGE, BUSY_MESSAGE, MIRROR_WORDS } from "../server-portable/mcp-edge.ts";
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
async function rpc(method: string, params: unknown, key?: string, opts: { notification?: boolean; via?: "header" | "query" | "bearer"; path?: string } = {}): Promise<Rpc> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const via = opts.via ?? "header";
  if (key && via === "header") headers["x-brain-key"] = key;
  if (key && via === "bearer") headers.authorization = `Bearer ${key}`;
  const url = `http://mcp${opts.path ?? "/mcp"}${key && via === "query" ? `?key=${key}` : ""}`;
  const message = opts.notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: rpcId++, method, params };
  const r = await app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify(message) }));
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  return { status: r.status, headers: r.headers, body: line ? JSON.parse(line) : null };
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
  // A value render.ts cannot say is the tool's fault, coded, as index.ts's run catches it — never the SDK's uncoded error.
  answer = (n) => (n === "thoughtStats" ? ok({}) : ok({}));
  const unsayable = await tool("thought_stats", {});
  assert(unsayable.isError && unsayable.sc.code === "FAILED" && unsayable.text.startsWith("Error: "), `a value that does not render: FAILED, coded (${JSON.stringify(unsayable.sc).slice(0, 80)})`);
  answer = () => ok({});
  // tools/list in index.ts's registration order.
  const order = ["search", "fetch", "search_thoughts", "search_thoughts_keyword", "list_thoughts", "list_supersession_proposals", "thought_stats", "thought_changes", "list_thought_ids", "list_logged_searches", "worker_status", "brain_info", "capture_thought", "update_thought", "delete_thought", "reset_capture_stamp", "retry_failed", "release_stale_leases", "run_worker", "job_status", "scan_thoughts"];
  const listed = (((await rpc("tools/list", {}, "write-raw")).body?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);
  assert(same(listed, order), `tools/list in index.ts's order (${listed.slice(0, 4).join(",")}…)`);
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
  const call = (id: number, name: string) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "write-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }) }).then((r) => r.text());
  // The SDK loads after the server answers: its start line, before the calls whose spans are read.
  const said = watchStream(entry.stderr);
  const sdk = await said.until(/ go to \S+ over OTLP\/HTTP/, 10_000);
  let out = "";
  try {
    await call(1, "thought_stats");
    await call(2, "example_recent");
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
  r = await app.fetch(new Request("http://mcp/.well-known/oauth-protected-resource/mcp"));
  assert(r.status === 404, "an unconfigured stack's protected-resource path: 404");
}

console.log("\n[10] The token exchange at the hop (SMD-2286 PR 2): an OAuth token traded for the REST core's, cached by its digest, never sent as a key; its refusals RFC 6750's");
{
  const ORIGIN = "https://brain.example.test";
  const ISSUER = `${ORIGIN}/auth`;
  // ES256 by WebCrypto (its signature is JWS's r||s): the authorization server's key, and a JWT minted with it.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const mint = async (claims: Record<string, unknown>) => {
    const nowS = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "ES256", typ: "at+jwt", kid: "t" })}.${b64({ iss: ISSUER, iat: nowS, exp: nowS + 600, ...claims })}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(head)));
    return `${head}.${Buffer.from(sig).toString("base64url")}`;
  };
  const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()) as Record<string, unknown>;
  // The authorization server's token endpoint, as deploy/auth/server.ts's grant answers: the `mcp` client's secret, the
  // subject's /mcp audience, the same subject and scope, `act: {sub: "mcp"}`, the REST core's audience.
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
    const exchanged = await mint({ sub: subject.sub, scope: subject.scope, aud: form.get("resource"), act: { sub: "mcp" }, exp: subject.exp, client_id: "mcp" });
    // The token's lifetime as issued, not read off the wall clock: the
    // exchanger below runs on `clock`, so a wall-clock answer read 599 when
    // the mint and the trade fell either side of a second, and the "594 s on"
    // row then asked at the entry's last instant and traded again (SMD-3470's
    // review, once in ~14 runs beside the background suites). A real server
    // answers the time left (deploy/auth/server.ts); the two agree for every
    // trade a row asserts on, each within a second of its token's mint.
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
  const write = await mint({ sub: "operator", scope: "brain:write", aud: `${ORIGIN}/mcp` });
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
  assert(p?.name === "oauth:operator" && p.scope === "write" && same(p.act, { name: "oauth:mcp" }), `a capture runs at the REST core as oauth:operator, act the MCP service (${JSON.stringify(p && { name: p.name, scope: p.scope, act: p.act })})`);
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
  // At the entry's last instant exactly, which the stub's fixed lifetime makes
  // a known moment: the entry is gone at its `until`, not after it.
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
