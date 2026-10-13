#!/usr/bin/env bun
/**
 * test-client.ts — the REST core's client (SMD-2287), with no database: the
 * generated files against what generate.ts renders from the REST core's own
 * document, every operation's method and path against the route table, and
 * every operation called through the client into the real REST app over a
 * stub core — its input arriving as the tool's schema parses it, the key,
 * the forwarder slot and the extra headers sent, any status an answer, and
 * the timeout ending a call that never answers.
 *
 *   bun test-client.ts
 */

// server-portable's zod, the one its schemas are built with (this package does not install it).
import { z } from "../server-portable/plugin-sdk.ts";
import { createAssert } from "../db/test-support.ts";
import { hashKey, type Principal } from "../server-portable/auth.ts";
import { SPECS, type Core } from "../server-portable/core/index.ts";
import { ok, refuse } from "../server-portable/core/refusal.ts";
import { ROUTES } from "../server-portable/rest/routes.ts";
import { createRestApp } from "../server-portable/rest/app.ts";
import { TOOL_NAMES, type ToolName } from "../server-portable/tools.ts";
import { renderAll } from "./generate.ts";
import { createRestClient, FORWARDER_HEADER, OPERATIONS, type InputOf } from "./index.ts";

const { assert, report } = createAssert();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("[1] The committed files are what generate.ts renders from the REST core's document");
{
  for (const [name, text] of Object.entries(await renderAll())) {
    const have = await Bun.file(new URL(`./${name}`, import.meta.url)).text().catch(() => "");
    assert(have === text, `${name} is current${have === text ? "" : " — run `bun generate.ts` in rest-client/ and commit what it writes"}`);
  }
}

console.log("\n[2] Every operation's method and path is its route's");
{
  for (const name of TOOL_NAMES) {
    const op = OPERATIONS[name];
    assert(op.method === ROUTES[name].method && op.path === ROUTES[name].path, `${name}: ${op.method} ${op.path}`);
  }
  const extra = Object.keys(OPERATIONS).filter((k) => !(TOOL_NAMES as readonly string[]).includes(k)).sort();
  assert(same(extra, ["health", "job_stream", "plugins", "whoami"]), `beside the tools: the REST core's own operations (${extra.join(", ")})`);
}

// ── The real REST app over a stub core that records what each operation got ──
const calls: { name: string; principal: Principal | string; input: unknown }[] = [];
const ID = "00000000-0000-4000-8000-000000000001";
const captured = { id: ID, reader: true, tags: {}, chunks: 0, contextFailures: 0, headWindow: null, recapture: null, embeddings: { allowed: true, reason: "allowed" }, chat: { allowed: true, reason: "allowed", base: "http://x/v1" } };
let answer: (name: string) => unknown = (name) => (name === "capture" ? ok(captured) : name === "scanThoughts" ? ok({ jobId: "job-1", status: "accepted" }) : ok({}));
const core = new Proxy({}, {
  get: (_t, prop) => async (principal: Principal | string, input: unknown) => {
    calls.push({ name: String(prop), principal, input });
    return answer(String(prop));
  },
}) as unknown as Core;
const seen: Request[] = [];
const app = createRestApp({
  core,
  init: () => {},
  keys: () => ({ MCP_ACCESS_KEYS: `w:write:${hashKey("write-raw")},f:forward:${hashKey("fwd-raw")}` }),
  resolve: async (p) => ({ status: "ok", agentId: p.scope === "forward" ? "agent-f" : "agent-w" }),
  track: (run) => run(),
  log: () => {},
});
const viaApp = async (req: Request) => {
  seen.push(req.clone());
  return app.fetch(req);
};

console.log("\n[3] Every operation through the client: its input arrives as the tool's schema parses it");
{
  // One input per tool, each held to the generated type at compile time: a
  // field the document does not give a tool, or a required one missing, is a
  // type error here.
  const inputs = {
    search: { query: "alpha beta" },
    fetch: { id: ID },
    search_thoughts: { query: "a needle & more", limit: 5, prefer_current: true, threshold: 0.25 },
    search_thoughts_keyword: { query: "exact text", limit: 3, offset: 1 },
    list_thoughts: { limit: 5, days: 1e-7, type: "idea", topic: "a topic with spaces & symbols?" },
    list_thought_ids: { limit: 2, after: ID },
    list_logged_searches: { since: "2026-10-01T00:00:00+02:00", limit: 3 },
    list_supersession_proposals: { status: "all", lineage: false, limit: 2 },
    thought_stats: {},
    thought_changes: { actions: ["capture", "delete"], others_only: true, limit: 4 },
    worker_status: {},
    brain_info: {},
    job_status: { job_id: "job/with?odd chars" },
    scan_thoughts: { limit: 10 },
    capture_thought: { content: "c", derived_from: [ID], metadata: { k: "v", n: 2, b: true } },
    update_thought: { id: ID, content: "new text", supersedes: null },
    delete_thought: { id: ID, detach_citations: true },
    reset_capture_stamp: { id: ID },
    retry_failed: { work_type: "extract:x@p1" },
    release_stale_leases: { work_type: "extract:x@p1", include_live: false },
    run_worker: { work_type: "extract:x@p1", dry_run: true, limit: 3 },
  } satisfies { [K in ToolName]: InputOf<K> };
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  for (const name of TOOL_NAMES) {
    calls.length = 0;
    const input = inputs[name];
    const r = await client.call(name, input as never, { key: "write-raw" });
    const want = z.object(SPECS[name].inputSchema).strict().parse(input);
    const got = calls[0]?.input;
    // brain_info's operation takes no input (the core reads it for "tool").
    assert(r.ok && (name === "brain_info" ? calls.length === 1 : same(got, want)), `${name}: ${r.status}, the operation got ${name === "brain_info" ? "its call" : `its input as parsed (${JSON.stringify(got)?.slice(0, 90)})`}`);
  }
  // A path field the client fills is encoded, and arrives as given.
  calls.length = 0;
  await client.call("job_status", { job_id: "a/b?c d" }, { key: "write-raw" });
  assert(same(calls[0]?.input, { job_id: "a/b?c d" }), `a path field with a slash, a question mark and a space arrives whole (${JSON.stringify(calls[0]?.input)})`);
}

console.log("\n[4] The caller's key, the forwarder slot and the extra headers ride every call");
{
  seen.length = 0;
  calls.length = 0;
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp, forwarderKey: "fwd-raw", headers: () => ({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }) });
  const who = await client.call("whoami" as never, {} as never, { key: "write-raw" });
  const sent = seen[0];
  assert(sent?.headers.get("x-brain-key") === "write-raw" && sent?.headers.get(FORWARDER_HEADER) === "fwd-raw" && sent?.headers.get("traceparent")?.startsWith("00-0af7"),
    `the key in x-brain-key, the forwarder in ${FORWARDER_HEADER}, the traceparent as given (${[...(sent?.headers.keys() ?? [])].join(",")})`);
  assert(who.status === 200 && same((who.body as { act?: unknown }).act, { name: "f", agentId: "agent-f" }), `the REST core reads the carrier as act (${JSON.stringify(who.body)})`);
  await client.call("thought_stats", {}, { key: "write-raw" });
  assert(calls[0] && typeof calls[0].principal === "object" && calls[0].principal.act?.name === "f", "an operation runs with the carrier as act");
  const bare = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  seen.length = 0;
  await bare.call("thought_stats", {}, { key: "write-raw" });
  assert(seen[0] && !seen[0].headers.has(FORWARDER_HEADER) && !seen[0].headers.has("traceparent"), "a client with no forwarder key sends no forwarder slot, and no header it was not given");
  seen.length = 0;
  await bare.call("thought_stats", {});
  assert(seen[0] && !seen[0].headers.has("x-brain-key"), "…and a call with no key sends none");
}

console.log("\n[5] Any status is an answer: a refusal's JSON, a key's 401, a fault; a forwarded refusal carries itself whole");
{
  const forwarded = createRestClient({ baseUrl: "http://api", fetch: viaApp, forwarderKey: "fwd-raw" });
  const bare = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  const notFound = { code: "NOT_FOUND", retryable: false, id: ID } as const;
  answer = () => refuse(notFound);
  let r = await forwarded.call("fetch", { id: ID }, { key: "write-raw" });
  assert(r.status === 404 && !r.ok && same(r.body, { code: "NOT_FOUND", retryable: false, refusal: notFound }), `a forwarded refusal: its status, its facts and the refusal whole (${r.status} ${JSON.stringify(r.body)})`);
  r = await bare.call("fetch", { id: ID }, { key: "write-raw" });
  assert(r.status === 404 && same(r.body, { code: "NOT_FOUND", retryable: false }), `…not forwarded, the facts alone (${JSON.stringify(r.body)})`);
  r = await bare.call("fetch", { id: ID }, { key: "wrong" });
  assert(r.status === 401 && (r.body as { code?: string }).code === "UNAUTHORIZED", `a wrong key: the 401, answered not thrown (${r.status})`);
  answer = () => { throw new Error("the store is away"); };
  r = await bare.call("thought_stats", {}, { key: "write-raw" });
  assert(r.status === 500 && same(r.body, { code: "FAILED", message: "the store is away" }), `a fault: the 500 and its message (${JSON.stringify(r.body)})`);
  answer = (name) => (name === "capture" ? ok(captured) : ok({}));
  const text = createRestClient({ baseUrl: "http://api", fetch: async () => new Response("not json", { status: 502 }) });
  r = await text.call("thought_stats", {});
  assert(r.status === 502 && r.body === "not json", `a body that is not JSON is the text as sent (${JSON.stringify(r.body)})`);
  const created = await bare.call("capture_thought", { content: "x" }, { key: "write-raw" });
  assert(created.status === 201 && created.headers.get("location") === `/v1/thoughts/${ID}` && (created.body as { id?: string }).id === ID, `a creation: 201, its Location and its value (${created.status})`);
}

console.log("\n[6] A call past the timeout is aborted; the caller's own signal ends one too");
{
  // Answers nothing, ever; rejects as fetch does once the request's signal aborts — at once for one already aborted.
  const never = (req: Request) => new Promise<Response>((_resolve, reject) => {
    if (req.signal.aborted) return reject(req.signal.reason);
    req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
  });
  const slow = createRestClient({ baseUrl: "http://api", fetch: never, timeoutMs: 50 });
  const t0 = performance.now();
  const err = await slow.call("thought_stats", {}).then(() => null, (e: unknown) => e as Error);
  const took = performance.now() - t0;
  assert(err?.name === "TimeoutError" && took < 2000, `the timeout ends the call with a TimeoutError (${err?.name} after ${took.toFixed(0)} ms)`);
  const ctl = new AbortController();
  const patient = createRestClient({ baseUrl: "http://api", fetch: never });
  const pending = patient.call("thought_stats", {}, { signal: ctl.signal }).then(() => null, (e: unknown) => e as Error);
  ctl.abort();
  assert((await pending)?.name === "AbortError", "the caller's signal ends a call with no timeout");
}

console.log("\n[7] A job's stream: the response itself, keyed");
{
  seen.length = 0;
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  const r = await client.stream("no-such-job", { key: "write-raw" });
  assert(r.status === 404 && seen[0]?.url === "http://api/v1/jobs/no-such-job/stream" && seen[0]?.headers.get("x-brain-key") === "write-raw", `GET /v1/jobs/<id>/stream with the key; an unknown job is its 404 (${r.status} ${seen[0]?.url})`);
  const events = createRestClient({ baseUrl: "http://api", fetch: async () => new Response("event: end\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }) });
  const s = await events.stream("j");
  assert(s.headers.get("content-type") === "text/event-stream" && (await s.text()).startsWith("event: end"), "an open stream is handed back unread");
}

// Compile-time only: the generated types hold a call to its operation's input.
if (false as boolean) {
  const c = createRestClient({ baseUrl: "http://api" });
  // @ts-expect-error update_thought's id is required
  void c.call("update_thought", { content: "x" });
  // @ts-expect-error capture_thought takes no `id`
  void c.call("capture_thought", { content: "x", id: ID });
  // @ts-expect-error list_thoughts' limit is a number
  void c.call("list_thoughts", { limit: "5" });
}

report();
