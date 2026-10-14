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
 * test-auth.ts and (PR 3b) test-e2e-sql.ts run against it too, with
 * OB1_MCP_UNDER_TEST=client.
 *
 *   bun test-mcp.ts
 */

import { createAssert } from "../db/test-support.ts";
import { hashKey, type Principal } from "../server-portable/auth.ts";
import type { Core } from "../server-portable/core/index.ts";
import { ok, refuse, type Refusal } from "../server-portable/core/refusal.ts";
import { createRestApp } from "../server-portable/rest/app.ts";
import * as say from "../server-portable/render.ts";
import { visibleToolNames } from "../server-portable/tools.ts";
import { REVOKED_MESSAGE, BUSY_MESSAGE, MIRROR_WORDS } from "../server-portable/mcp-edge.ts";
import type { AgentOutcome } from "../server-portable/agents.ts";
import { createRestClient } from "../rest-client/index.ts";
import { createMcpApp } from "./app.ts";
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
  // A save whose vector did not attach: a 201 with the refusal beside it, said as the refusal.
  const unattached = { code: "EMBEDDING_NOT_ATTACHED", retryable: true, id: "00000000-0000-4000-8000-000000000003", detail: "the vector write failed" } as const;
  answer = (n) => (n === "capture" ? refuse(unattached) : ok({}));
  const saved = await tool("capture_thought", { content: "y" });
  assert(expectReply(saved, say.renderCapture({ ok: false, refusal: unattached } as never)), `capture saved without its vector: the in-process words (${saved.text.slice(0, 60)})`);
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
  // A registry that answers each lookup in 1.5 s: the key's standing and the record's own check, one after the other,
  // would be 3 s; one deadline over both answers `ok` at it, as index.ts's one race does.
  answer = () => ({ version: "1.0.0" });
  resolveDelayMs = 1_500;
  const t0 = performance.now();
  const slow = await app.fetch(new Request("http://mcp/mcp/health", { headers: { "x-brain-key": "read-raw" } }));
  const took = performance.now() - t0;
  const slowText = await slow.text();
  resolveDelayMs = 0;
  answer = () => ok({});
  assert(slowText === "ok" && took < 2_900, `a slow registry: /health answers ok within its one deadline (${Math.round(took)} ms, ${slowText.slice(0, 30)})`);
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
  const brokenNamed = createMcpApp({ rest: createRestClient({ baseUrl: "http://api.ob1.internal", forwarderKey: "fwd-raw", fetch: async () => json(401, { code: "UNAUTHORIZED", credential: "forwarder" }) }), edge: () => ({ configured: false, origin: null }), warn: (l) => named.push(l), restUrl: "http://api.test:8000" });
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
  const withPlugins = createMcpApp({ rest: pluginRest, plugins: () => loadPlugins("probe-kit", [probe]), edge: () => ({ configured: false, origin: null }), warn: () => {} });
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
  assert(same(names, [...names.filter((n) => !n.startsWith("probe_kit_")), "probe_kit_item"]) && names.includes("search"), `a read key: the core's tools, then its plugin operation, as index.ts lists them (${names.slice(-2).join(", ")})`);
  const item = read.find((t) => t.name === "probe_kit_item");
  assert(item?.annotations?.readOnlyHint === true && item.outputSchema?.properties !== undefined && "item_id" in item.outputSchema.properties, "…with the manifest's read-only hint and output schema");
  assert(!names.includes("other_kit_look"), "a plugin the REST core runs and this server was not given: no tool here");
  assert((await listOf("write-raw")).some((t) => t.name === "probe_kit_pin") && !names.includes("probe_kit_pin"), "a write operation: a write key's tool, not a read key's");
  assert(!(await listOf("cap-raw")).some((t) => t.name.startsWith("probe_kit_")), "a capture key: no plugin tool");

  // The reply index.ts gives: renderPlugin over runOperation's own outcome, in process, the input as the SDK parses it.
  const ops = loadPlugins("probe-kit", [probe])[0].operations;
  const inProcess = async (key: string, input: Record<string, unknown>, scope: "read" | "write" = "read") => {
    const op = ops.find((o) => o.key === key)!;
    return say.renderPlugin(await runOperation(op, { core, principal: { name: "chatgpt", scope } as Principal }, op.input.parse(input)));
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
  assert(thrown && got.isError && got.text.startsWith("Error: ") && got.text.includes("the plugin's own fault") && got.sc.code === "FAILED", `a throw: the tool's fault, FAILED, its message (${got.text.slice(0, 80)})`);
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
  const restServer = Bun.serve({ port: 0, fetch: (req) => exampleRest.fetch(req) });
  const portHolder = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const entryPort = portHolder.port;
  portHolder.stop(true);
  const entry = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, PORT: String(entryPort), OB1_FORWARDER_KEY: "fwd-raw", OB1_REST_URL: `http://127.0.0.1:${restServer.port}`, OB1_PLUGINS: "example" }, stdout: "ignore", stderr: "pipe" });
  let entryTools: string[] = [];
  try {
    for (let i = 0; i < 100 && entryTools.length === 0; i++) {
      const r = await fetch(`http://127.0.0.1:${entryPort}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": "read-raw" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).catch(() => null);
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
  assert(entryTools.includes("example_recent") && entryTools.includes("search"), `bun index.ts with OB1_PLUGINS=example: a read key's tools/list holds example_recent (${entryTools.filter((n) => n.startsWith("example")).join() || "none"} of ${entryTools.length})`);
  // The entry: a name that is no plugin stops it in words, as it stops the REST core (PR 4a).
  const noPlugin = Bun.spawn(["bun", "index.ts"], { cwd: import.meta.dir, env: { ...process.env, OB1_FORWARDER_KEY: "x".repeat(64), OB1_PLUGINS: "no-such-plugin" }, stdout: "pipe", stderr: "pipe" });
  const npCode = await noPlugin.exited;
  const npSaid = await new Response(noPlugin.stderr).text();
  assert(npCode === 2 && /OB1_PLUGINS/.test(npSaid) && /no-such-plugin/.test(npSaid) && !/\n\s+at /.test(npSaid), `OB1_PLUGINS naming no plugin: exit 2, in words (${npCode}: ${npSaid.trim().slice(0, 90)})`);
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

report();
