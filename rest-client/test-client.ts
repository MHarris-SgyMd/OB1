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

// server-portable's zod, the one its schemas are built with (this package does not install it), and the plugin SDK beside it.
import { definePlugin, ok as pluginOk, operation, refuse as pluginRefuse, z } from "../server-portable/plugin-sdk.ts";
import { createAssert } from "../db/test-support.ts";
import { hashKey, type Principal } from "../server-portable/auth.ts";
import { SPECS, type Core } from "../server-portable/core/index.ts";
import { ok, refuse } from "../server-portable/core/refusal.ts";
import { ROUTES } from "../server-portable/rest/routes.ts";
import { createRestApp } from "../server-portable/rest/app.ts";
import { loadPlugins } from "../server-portable/core/plugins.ts";
// SMD-3249 review pass 2: a cursor the real core reads, made for the selection beside it (a hand-written one went stale with pass 1).
import { proposalCursor } from "../server-portable/core/list-cursor.ts";
import { TOOL_NAMES, type ToolName } from "../server-portable/tools.ts";
import { renderAll } from "./generate.ts";
import { createRestClient, FORWARDER_HEADER, OPERATIONS, type Answer, type InputOf } from "./index.ts";

const { assert, report } = createAssert();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * A promise raced against a deadline, so a timeout or a signal that never ends
 * a call fails its case rather than hanging the suite (review pass 1).
 */
const within = <T>(p: Promise<T>, ms = 3000): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => { throw Object.assign(new Error(`no end within ${ms} ms`), { name: "Deadline" }); })]);
/** What createRestClient throws for the options given, or null when it takes them. */
const refuses = (o: Parameters<typeof createRestClient>[0]): Error | null => {
  try {
    createRestClient(o);
    return null;
  } catch (e) {
    return e as Error;
  }
};

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
    list_supersession_proposals: { status: "all", lineage: false, limit: 2, judge_key: "consolidate:h2o-lightning-4b+qwen3.8:27b@p4d3", after: proposalCursor({ status: "all", lineage: false, judgeKey: "consolidate:h2o-lightning-4b+qwen3.8:27b@p4d3" }, "0.90", "2026-09-25 00:00:00+00", "22222222-2222-4222-8222-222222222222") },
    thought_stats: {},
    thought_changes: { actions: ["capture", "delete"], others_only: true, limit: 4 },
    worker_status: {},
    task_status: {},
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
  // An access token (SMD-2286: the MCP server's exchanged token) rides Authorization: Bearer; a key beside it wins.
  seen.length = 0;
  await client.call("thought_stats", {}, { token: "tok.en.value" });
  assert(seen[0]?.headers.get("authorization") === "Bearer tok.en.value" && !seen[0]?.headers.has("x-brain-key") && seen[0]?.headers.get(FORWARDER_HEADER) === "fwd-raw",
    `a token in Authorization: Bearer, no x-brain-key, the forwarder beside it (${seen[0]?.headers.get("authorization")})`);
  seen.length = 0;
  await client.call("thought_stats", {}, { key: "write-raw", token: "tok.en.value" });
  assert(seen[0]?.headers.get("x-brain-key") === "write-raw" && !seen[0]?.headers.has("authorization"), "…a key and a token both given: the key alone is sent");
  seen.length = 0;
  const unsafe = await client.call("thought_stats", {}, { token: "tok\nen" });
  const unsafeStream = await client.stream("job-1", { token: " tok" });
  assert(unsafe.status === 401 && !unsafe.sent && unsafeStream.status === 401 && seen.length === 0, `a token no header can carry as given is refused here, nothing sent, by call and by stream (${unsafe.status} ${unsafeStream.status}, ${seen.length} sent)`);
  seen.length = 0;
  await client.stream("job-1", { token: "tok.en.value" });
  assert(seen[0]?.headers.get("authorization") === "Bearer tok.en.value", "…and a job's stream carries the token as a bearer too");
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
  const err = await within(slow.call("thought_stats", {})).then(() => null, (e: unknown) => e as Error);
  const took = performance.now() - t0;
  assert(err?.name === "TimeoutError" && took < 2000, `the timeout ends the call with a TimeoutError (${err?.name} after ${took.toFixed(0)} ms)`);
  const ctl = new AbortController();
  const patient = createRestClient({ baseUrl: "http://api", fetch: never });
  const pending = within(patient.call("thought_stats", {}, { signal: ctl.signal })).then(() => null, (e: unknown) => e as Error);
  ctl.abort();
  assert((await pending)?.name === "AbortError", "the caller's signal ends a call with no timeout");
  // A fetch that never heeds the signal — the REST app's own, in a suite — is still cut at the timeout (review pass 1).
  const deaf = () => new Promise<Response>(() => {});
  const cut = createRestClient({ baseUrl: "http://api", fetch: deaf, timeoutMs: 50 });
  const t1 = performance.now();
  const deafErr = await within(cut.call("thought_stats", {})).then(() => null, (e: unknown) => e as Error);
  const tookDeaf = performance.now() - t1;
  assert(deafErr?.name === "TimeoutError" && tookDeaf < 2000, `…and so is one whose fetch ignores the signal (${deafErr?.name} after ${tookDeaf.toFixed(0)} ms)`);
  // A signal aborted before the call sends nothing: the operation never runs.
  seen.length = 0;
  calls.length = 0;
  const early = new AbortController();
  early.abort();
  const viaAppClient = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  const earlyErr = await within(viaAppClient.call("capture_thought", { content: "x" }, { key: "write-raw", signal: early.signal })).then(() => null, (e: unknown) => e as Error);
  assert(earlyErr?.name === "AbortError" && seen.length === 0 && calls.length === 0, `a signal already aborted sends nothing, and no operation runs (${earlyErr?.name}, ${seen.length} sent, ${calls.length} run)`);
}

console.log("\n[6b] An input a URL cannot carry is answered here, nothing sent: the REST core's REFUSED_INPUT, naming the field");
{
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  const cases: [string, () => Promise<Answer>, string][] = [
    ["an empty id", () => client.call("fetch", { id: "" }, { key: "write-raw" }), "id"],
    ["a dot segment", () => client.call("reset_capture_stamp", { id: "." }, { key: "write-raw" }), "id"],
    ["two dots", () => client.call("update_thought", { id: "..", content: "x" }, { key: "write-raw" }), "id"],
    ["a job id of one dot", () => client.call("job_status", { job_id: "." }, { key: "write-raw" }), "job_id"],
    ["no id at all", () => client.call("fetch", {} as never, { key: "write-raw" }), "id"],
    ["a null id", () => client.call("delete_thought", { id: null } as never, { key: "write-raw" }), "id"],
    ["a number for an id", () => client.call("fetch", { id: 5 } as never, { key: "write-raw" }), "id"],
    ["a lone surrogate in an id", () => client.call("fetch", { id: "\uD800x" }, { key: "write-raw" }), "id"],
    ["a lone surrogate in a query field", () => client.call("list_thoughts", { topic: "a\uDC00" }, { key: "write-raw" }), "topic"],
    ["…and in a query list", () => client.call("thought_changes", { actions: ["capture", "\uD800"] as never }, { key: "write-raw" }), "actions"],
  ];
  for (const [label, run, field] of cases) {
    seen.length = 0;
    calls.length = 0;
    const r = await run();
    const issue = (r.body as { issues?: { path: string }[] }).issues?.[0];
    assert(r.status === 400 && !r.ok && !r.sent && (r.body as { code?: string }).code === "REFUSED_INPUT" && issue?.path === field && seen.length === 0 && calls.length === 0,
      `${label}: 400 REFUSED_INPUT naming ${field}, sent nowhere (${r.status} ${JSON.stringify(r.body)}, ${seen.length} sent)`);
  }
  // A body carries what a URL cannot: a lone surrogate in a capture's content travels as JSON's escape.
  calls.length = 0;
  const body = await client.call("capture_thought", { content: "half \uD800 a pair" }, { key: "write-raw" });
  assert(body.status === 201 && body.sent && (calls[0]?.input as { content?: string } | undefined)?.content === "half \uD800 a pair", `a lone surrogate in a body arrives as sent (${body.status})`);
  const fine = await client.call("fetch", { id: "..." }, { key: "write-raw" });
  assert(fine.status === 200 && fine.sent, `three dots are no dot segment, and are sent (${fine.status})`);
}

console.log("\n[7] A job's stream: the response itself, unread, keyed");
{
  seen.length = 0;
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  const r = await client.stream("no-such-job", { key: "write-raw" });
  assert(r.status === 404 && seen[0]?.url === "http://api/v1/jobs/no-such-job/stream" && seen[0]?.headers.get("x-brain-key") === "write-raw", `GET /v1/jobs/<id>/stream with the key; an unknown job is its 404 (${r.status} ${seen[0]?.url})`);
  // A refusal's response is handed back unread, so its caller can read it or pass it on (review pass 1: it came back already read).
  const refusalText = await r.text().catch((e: Error) => `(unreadable: ${e.message})`);
  assert(refusalText.startsWith("{") && same(JSON.parse(refusalText), { code: "NOT_FOUND", retryable: false }), `…its refusal still readable (${refusalText})`);
  seen.length = 0;
  const carrier = createRestClient({ baseUrl: "http://api", fetch: viaApp, forwarderKey: "fwd-raw", headers: () => ({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }) });
  const fwd = await carrier.stream("no-such-job", { key: "write-raw" });
  assert(fwd.status === 404 && seen[0]?.headers.get(FORWARDER_HEADER) === "fwd-raw" && seen[0]?.headers.get("traceparent") !== null
      && same(await fwd.json(), { code: "NOT_FOUND", retryable: false, refusal: { code: "NOT_FOUND", retryable: false, id: "no-such-job" } }),
    "a stream carries the forwarder slot and the extra headers, and its forwarded refusal holds itself whole");
  seen.length = 0;
  const dot = await client.stream(".", { key: "write-raw" });
  assert(dot.status === 400 && seen.length === 0 && (await dot.json() as { code?: string }).code === "REFUSED_INPUT", `a job id of one dot is refused here, not read as GET /v1/jobs/stream (${dot.status}, ${seen.length} sent)`);
  const events = createRestClient({ baseUrl: "http://api", fetch: async () => new Response("event: end\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }) });
  const s = await events.stream("j");
  assert(s.headers.get("content-type") === "text/event-stream" && (await s.text()).startsWith("event: end"), "an open stream is handed back unread");
}

console.log("\n[8] What a header cannot carry, the configuration, an empty body, and what the abort leaves behind");
{
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  // A key no header carries as presented is the core's 401, given here, nothing sent: an emoji or a NUL threw,
  // and a key with spaces at its ends arrived trimmed, as another key than the one presented (review pass 2).
  for (const [label, key] of [["an emoji", "😀"], ["a NUL", "a\u0000b"], ["a line break", "write-raw\r\nx-evil: 1"], ["spaces at its ends", " write-raw "]] as const) {
    seen.length = 0;
    calls.length = 0;
    const r = await client.call("thought_stats", {}, { key });
    const s = await client.stream("j", { key });
    assert(r.status === 401 && !r.sent && same(r.body, { code: "UNAUTHORIZED" }) && s.status === 401 && seen.length === 0 && calls.length === 0,
      `a key holding ${label}: 401 UNAUTHORIZED from call and stream, sent nowhere (${r.status}, ${s.status}, ${seen.length} sent)`);
  }
  // The local refusal's message is zod's shape, after its path, not the field named twice.
  const dot = await client.call("fetch", { id: "." }, { key: "write-raw" });
  const issue = (dot.body as { issues: { path: string; message: string }[] }).issues[0];
  assert(issue.path === "id" && !issue.message.startsWith("id "), `the local refusal's message does not repeat its path (${JSON.stringify(issue)})`);

  // The configuration is held at the start.
  assert(refuses({ baseUrl: "http://x?a=1" })?.name === "TypeError" && refuses({ baseUrl: "http://x#f" })?.name === "TypeError" && refuses({ baseUrl: "not a url" })?.name === "TypeError",
    "a base with a query or a fragment, or no URL at all, is refused at the start");
  assert(refuses({ baseUrl: "http://x", forwarderKey: "fwd\r\nx-evil: 1" })?.name === "TypeError" && refuses({ baseUrl: "http://x", forwarderKey: " fwd" })?.name === "TypeError" && refuses({ baseUrl: "http://x", forwarderKey: "fwd-raw" }) === null,
    "a forwarder key no header carries as written is refused at the start; a sound one is taken");
  // call() and stream() build the same URL under a base with a path and a trailing slash.
  const urls: string[] = [];
  const spy = createRestClient({ baseUrl: "http://x/api/", fetch: async (req) => { urls.push(req.url); return new Response("{}", { status: 404 }); } });
  await spy.call("job_status", { job_id: "j" });
  await spy.stream("j");
  assert(same(urls, ["http://x/api/v1/jobs/j", "http://x/api/v1/jobs/j/stream"]), `a base with a path and a trailing slash: call and stream under the same root (${urls.join(" ")})`);

  // An error with an empty body has none: null, not "" (review pass 2).
  for (const [label, make] of [["empty text", () => new Response("", { status: 431 })], ["no body", () => new Response(null, { status: 502 })]] as const) {
    const empty = createRestClient({ baseUrl: "http://api", fetch: async () => make() });
    const r = await empty.call("thought_stats", {});
    assert(r.body === null, `an error answered with ${label}: its body null (${JSON.stringify(r.body)})`);
  }

  // A fetch that throws at once rejects the call with its error and leaves no listener on the caller's signal.
  const ctl = new AbortController();
  let added = 0;
  let removed = 0;
  const addListener = ctl.signal.addEventListener.bind(ctl.signal);
  const removeListener = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = ((...a: Parameters<AbortSignal["addEventListener"]>) => { added++; addListener(...a); }) as AbortSignal["addEventListener"];
  ctl.signal.removeEventListener = ((...a: Parameters<AbortSignal["removeEventListener"]>) => { removed++; removeListener(...a); }) as AbortSignal["removeEventListener"];
  const throwing = createRestClient({ baseUrl: "http://api", fetch: () => { throw new Error("thrown at once"); } });
  const thrown = await within(throwing.call("thought_stats", {}, { signal: ctl.signal })).then(() => null, (e: unknown) => e as Error);
  assert(thrown?.message === "thrown at once" && added > 0 && added === removed, `a fetch that throws at once: the call rejects with its error, every listener taken off (${thrown?.message}; ${added} added, ${removed} removed)`);

  // An answer that comes after the timeout is cancelled unread, not left to the collector.
  let cancelled = false;
  const late = createRestClient({
    baseUrl: "http://api", timeoutMs: 10,
    // A body that closes itself at 500 ms, so a client that read it rather than cancel it ends rather than hangs.
    fetch: () => Bun.sleep(60).then(() => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("x")); setTimeout(() => { try { c.close(); } catch {} }, 500); },
      cancel() { cancelled = true; },
    }))),
  });
  const lateErr = await within(late.call("thought_stats", {})).then(() => null, (e: unknown) => e as Error);
  await Bun.sleep(120);
  assert(lateErr?.name === "TimeoutError" && cancelled, `an answer after the timeout: the call a TimeoutError, the late body cancelled (${lateErr?.name}, cancelled ${cancelled})`);

  // stream()'s timeout holds until the headers arrive, and not after (review pass 2: it had none).
  const deaf = createRestClient({ baseUrl: "http://api", timeoutMs: 50, fetch: () => new Promise<Response>(() => {}) });
  const t0 = performance.now();
  const streamErr = await within(deaf.stream("j")).then(() => null, (e: unknown) => e as Error);
  const took = performance.now() - t0;
  assert(streamErr?.name === "TimeoutError" && took < 2000, `a stream whose headers never come ends at the timeout (${streamErr?.name} after ${took.toFixed(0)} ms)`);
  let signalOf: AbortSignal | undefined;
  const slowBody = createRestClient({
    baseUrl: "http://api", timeoutMs: 50,
    fetch: async (req) => {
      signalOf = req.signal;
      return new Response(new ReadableStream({ async start(c) { await Bun.sleep(150); c.enqueue(new TextEncoder().encode("event: end\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const open = await within(slowBody.stream("j"));
  const events = await within(open.text());
  assert(events === "event: end\n\n" && signalOf?.aborted === false, `an open stream runs past the timeout: its events read whole, its request not aborted (${JSON.stringify(events)}, aborted ${signalOf?.aborted})`);
  const caller = new AbortController();
  const ended = createRestClient({ baseUrl: "http://api", fetch: (req) => new Promise<Response>((_r, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })) });
  const pending = within(ended.stream("j", { signal: caller.signal })).then(() => null, (e: unknown) => e as Error);
  caller.abort();
  assert((await pending)?.name === "AbortError", "…and the caller's signal still ends a stream");
}

console.log("\n[9] A key a header carries is sent, a bare ? is a query, no extra header is a key, a redirect is an answer, an open stream ends on the caller's signal");
{
  // `é` or a tab inside a key rides a header and is the core's to judge, not refused here (review pass 3).
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  for (const [label, key] of [["an é", "café-key"], ["a tab inside", "a\tb"]] as const) {
    seen.length = 0;
    const r = await client.call("thought_stats", {}, { key });
    assert(r.status === 401 && r.sent && seen.length === 1 && seen[0].headers.get("x-brain-key") === key, `a key holding ${label} is sent as presented, and the core answers it (${r.status}, sent ${r.sent})`);
  }
  assert(["http://x?", "http://x#", "http://x/api?#"].every((b) => refuses({ baseUrl: b })?.name === "TypeError"), "a base ending in a bare ? or # is refused: URL reads it as empty, and every path would follow it");
  const urls: string[] = [];
  const spy = createRestClient({ baseUrl: "http://x//", fetch: async (req) => { urls.push(req.url); return new Response("{}", { status: 404 }); } });
  await spy.call("job_status", { job_id: "j" });
  await spy.stream("j");
  assert(same(urls, ["http://x/v1/jobs/j", "http://x/v1/jobs/j/stream"]), `a base with two trailing slashes: call and stream under one root (${urls.join(" ")})`);
  // An extra header is never a key: headers() cannot put a key, or the forwarder slot, beside or over the call's.
  seen.length = 0;
  const sly = createRestClient({ baseUrl: "http://api", fetch: viaApp, forwarderKey: "fwd-raw", headers: () => ({ "X-Brain-Key": "other", "x-access-key": "other", authorization: "Bearer other", "x-brain-forwarder": "other", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }) });
  await sly.call("thought_stats", {}, { key: "write-raw" });
  await sly.stream("j", { key: "write-raw" });
  assert(seen.length === 2 && seen.every((q) => q.headers.get("x-brain-key") === "write-raw" && q.headers.get(FORWARDER_HEADER) === "fwd-raw" && !q.headers.has("x-access-key") && !q.headers.has("authorization") && q.headers.has("traceparent")),
    "headers() adds what it may (a traceparent) and no key: the call's key and the client's forwarder stand, from call and stream");
  // A redirect is an answer: fetch would carry the key and the forwarder to the next origin (review pass 3).
  const elsewhere: string[] = [];
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { elsewhere.push(req.headers.get("x-brain-key") ?? "-"); return new Response("{}"); } });
  const redirecting = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}${new URL(req.url).pathname}` } }) });
  const real = createRestClient({ baseUrl: `http://127.0.0.1:${redirecting.port}`, forwarderKey: "fwd-raw" });
  const moved = await within(real.call("thought_stats", {}, { key: "write-raw" }));
  const movedStream = await within(real.stream("j", { key: "write-raw" }));
  assert(moved.status === 307 && moved.sent && movedStream.status === 307 && elsewhere.length === 0, `a 307 to another origin is the answer, from call and stream; the key went nowhere else (${moved.status}, ${movedStream.status}, ${elsewhere.length} at the other origin)`);
  redirecting.stop(true);
  other.stop(true);
  // stream() holds no listener on the caller's signal past its request (review pass 3: one stayed per stream).
  const ctl = new AbortController();
  let added = 0;
  let removed = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const remove = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = ((...a: Parameters<AbortSignal["addEventListener"]>) => { added++; add(...a); }) as AbortSignal["addEventListener"];
  ctl.signal.removeEventListener = ((...a: Parameters<AbortSignal["removeEventListener"]>) => { removed++; remove(...a); }) as AbortSignal["removeEventListener"];
  const quick = createRestClient({ baseUrl: "http://api", fetch: async () => new Response("event: end\n\n", { headers: { "content-type": "text/event-stream" } }) });
  for (let i = 0; i < 20; i++) await (await quick.stream("j", { signal: ctl.signal })).text();
  await within(quick.stream("j", { signal: ctl.signal, key: "bad\u0000" }));
  assert(added === removed, `twenty streams on one caller's signal leave no listener on it (${added} added, ${removed} removed)`);
  // The caller's signal ends an open stream too, through a fetch whose body heeds the request's signal.
  const caller = new AbortController();
  const heedful = createRestClient({
    baseUrl: "http://api",
    fetch: async (req) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: tick\n\n")); req.signal.addEventListener("abort", () => c.error(req.signal.reason), { once: true }); } }), { headers: { "content-type": "text/event-stream" } }),
  });
  const open = await within(heedful.stream("j", { signal: caller.signal }));
  const reading = within(open.text()).then(() => null, (e: unknown) => e as Error);
  caller.abort();
  assert((await reading)?.name === "AbortError", "the caller's signal ends an open stream, its body read to an AbortError");
}

console.log("\n[10] A key is sent byte for byte or not at all; a base is http, credential-free and as written; an object rides no query string");
{
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  // Headers strips a CR or LF at a value's ends (`\rwrite-raw` arrived as write-raw and authenticated), and passes the
  // other control characters, which Bun's server answers with a bare 400 (review pass 4): each is the core's 401, unsent.
  for (const [label, key] of [["a CR before it", "\rwrite-raw"], ["an LF after it", "write-raw\n"], ["a CR LF around it", "\nwrite-raw\r\n"], ["a 0x01 inside", "write\x01raw"], ["a vertical tab after it", "write-raw\x0b"]] as const) {
    seen.length = 0;
    const r = await client.call("thought_stats", {}, { key });
    assert(r.status === 401 && !r.sent && seen.length === 0, `a key with ${label}: 401, sent nowhere — never another key's 200 (${r.status}, ${seen.length} sent)`);
  }
  seen.length = 0;
  const latin = await client.call("thought_stats", {}, { key: "wr\xa0it\xffe" });
  assert(latin.sent && seen[0]?.headers.get("x-brain-key") === "wr\xa0it\xffe", `a key with U+00A0 and U+00FF inside rides the header byte for byte, the core's to judge (${latin.status}, sent ${latin.sent})`);
  // DEL is no field-vchar: a Go server (Traefik, on the /api route) refuses it with a bare 400 (review pass 5).
  seen.length = 0;
  const del = await client.call("thought_stats", {}, { key: "wr\x7fite" });
  assert(del.status === 401 && !del.sent && seen.length === 0, `a DEL inside a key is the core's 401, sent nowhere (${del.status}, sent ${del.sent})`);
  assert(["\rfwd-raw", "fwd-raw\n", "fwd\x01raw"].every((forwarderKey) => refuses({ baseUrl: "http://x", forwarderKey })?.name === "TypeError"), "a forwarder key with a CR, an LF or a control character is refused at the start, not a bare 400 on every call");
  const badBases = ["http://u:p@x", "http://write-raw@x", "file:///tmp/x", "data:text/plain,hi", "api.ob1.internal:8000", "http://x/api/..", "http://x/api/%2e%2e", " http://x/x", "http://x/x ", "http://x/a\tb"];
  const slipped = badBases.filter((baseUrl) => refuses({ baseUrl })?.name !== "TypeError");
  assert(slipped.length === 0, `a base that is not http, carries credentials, or has a path the parser rewrites is refused at the start (let through: ${JSON.stringify(slipped)})`);
  const goodBases = ["http://[::1]:8000", "HTTP://LOCALHOST", "http://x/api%3F", "https://brain.example/api/", "http://x//"];
  const turned = goodBases.filter((baseUrl) => refuses({ baseUrl }) !== null);
  assert(turned.length === 0, `…and an IPv6 host, an upper-case scheme, an encoded ? in the path, a path and trailing slashes are taken (refused: ${JSON.stringify(turned)})`);
  // An object has no form in a query string; openapi-fetch's serializer threw on one (review pass 4).
  for (const [label, run, field] of [
    ["an object for a GET's field", () => client.call("list_thoughts", { topic: { a: 1 } } as never, { key: "write-raw" }), "topic"],
    ["an object in a GET's list", () => client.call("thought_changes", { actions: [{ a: 1 }] } as never, { key: "write-raw" }), "actions"],
    ["a lone surrogate inside an object in a GET", () => client.call("list_thoughts", { topic: { a: "\uD800" } } as never, { key: "write-raw" }), "topic"],
    ["a list inside a GET's list", () => client.call("thought_changes", { actions: [["capture"]] } as never, { key: "write-raw" }), "actions"],
  ] as const) {
    seen.length = 0;
    const r = await run();
    const issue = (r.body as { issues?: { path: string }[] }).issues?.[0];
    assert(r.status === 400 && !r.sent && issue?.path === field && seen.length === 0, `${label}: 400 REFUSED_INPUT naming ${field}, sent nowhere (${r.status} ${JSON.stringify(r.body)})`);
  }
}

console.log("\n[11] A timeout a timer can hold, a query name a URL carries, a null key no key, a base with no control character anywhere");
{
  // setTimeout fires at once past 2^31 - 1 and AbortSignal.timeout throws on Infinity (review pass 5): refused at the start.
  const badTimeouts = [3_000_000_000, 2 ** 31, Infinity, NaN, -1, 0, 1.5];
  const slipped = badTimeouts.filter((timeoutMs) => refuses({ baseUrl: "http://x", timeoutMs })?.name !== "TypeError");
  assert(slipped.length === 0, `a timeout no timer holds is refused at the start (let through: ${slipped.map(String).join(", ")})`);
  assert([1, 2 ** 31 - 1, undefined].every((timeoutMs) => refuses({ baseUrl: "http://x", timeoutMs }) === null) && refuses({ baseUrl: "http://x", timeoutMs: null as never }) === null, "…and 1 ms, the longest a timer holds, or none, is taken");
  // A query name rides the URL as it is: a `#` made the rest a fragment, and the core ran without it (review pass 5).
  const client = createRestClient({ baseUrl: "http://api", fetch: viaApp });
  for (const name of ["#", "a&b", "a=b", "\uD800", "a b"]) {
    seen.length = 0;
    const r = await client.call("list_thoughts", { [name]: "x", limit: 5 } as never, { key: "write-raw" });
    const issue = (r.body as { issues?: { path: string }[] }).issues?.[0];
    assert(r.status === 400 && !r.sent && issue?.path === name && seen.length === 0, `a query field named ${JSON.stringify(name)}: 400 REFUSED_INPUT naming it, sent nowhere (${r.status}, ${seen.length} sent)`);
  }
  // A null key is no key: stream() sent the text "null" (review pass 5).
  seen.length = 0;
  await client.call("thought_stats", {}, { key: null as never });
  await client.stream("j", { key: null as never });
  assert(seen.length === 2 && seen.every((q) => !q.headers.has("x-brain-key")), "a null key sends no key, from call and stream");
  seen.length = 0;
  const unforwarded = createRestClient({ baseUrl: "http://api", fetch: viaApp, forwarderKey: null as never });
  await unforwarded.call("thought_stats", {}, { key: "write-raw" });
  assert(seen.length === 1 && !seen[0].headers.has(FORWARDER_HEADER), "a null forwarder key is none: no forwarder slot");
  assert(refuses({ baseUrl: "http://x", forwarderKey: 5 as never })?.name === "TypeError", "a forwarder key that is not text is refused at the start");
  // The parser drops a tab or a line break from a host silently: `http://ev\til.com` reached evil.com (review pass 5).
  const hostBases = ["http://x\t/api", "http://ev\til.com/api", "http://x\n/api", "http://x:80\t80/api"];
  assert(hostBases.every((baseUrl) => refuses({ baseUrl })?.name === "TypeError"), "a base with a tab or a line break in its host is refused");
  const asUrl = refuses({ baseUrl: new URL("http://x") as never });
  assert(asUrl?.name === "TypeError" && /not a string/.test(asUrl.message), `a URL object for the base is refused in words (${asUrl?.message})`);
}

console.log("\n[12] A plugin's operation by its route (callPath): its path filled, the rest in the query or the body, its answer as call's");
{
  // A plugin of the suite's own, served by the real REST app: what each operation was handed is kept.
  const handed: { key: string; input: unknown }[] = [];
  const probe = definePlugin({
    name: "probe-kit", title: "Probe", description: "The suite's own plugin.",
    operations: {
      item: operation({
        title: "An item", description: "Echoes its fields.", scope: "read", method: "GET", path: "/items/{item_id}",
        input: { item_id: z.string(), verbose: z.boolean().default(false), limit: z.number().optional() }, output: { item_id: z.string(), verbose: z.boolean() },
        async handler(_ctx, input) { handed.push({ key: "item", input }); return input.item_id === "gone" ? pluginRefuse(404, "ITEM_GONE", { item_id: input.item_id }) : pluginOk({ item_id: input.item_id, verbose: input.verbose }); },
      }),
      note: operation({
        title: "Note", description: "Takes a body.", scope: "write", method: "POST", path: "/notes/{note_id}",
        input: { note_id: z.string(), text: z.string(), tags: z.array(z.string()).default([]) }, output: { saved: z.boolean() },
        async handler(_ctx, input) { handed.push({ key: "note", input }); return pluginOk({ saved: true }); },
      }),
    },
  });
  const pluginApp = createRestApp({
    core,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: `w:write:${hashKey("write-raw")},f:forward:${hashKey("fwd-raw")}` }),
    resolve: async (p) => ({ status: "ok", agentId: p.scope === "forward" ? "agent-f" : "agent-w" }),
    track: (run) => run(),
    log: () => {},
    plugins: () => loadPlugins("probe-kit", [probe]),
  });
  const sent: Request[] = [];
  const viaPlugins = async (req: Request) => { sent.push(req.clone()); return pluginApp.fetch(req); };
  const client = createRestClient({ baseUrl: "http://api", fetch: viaPlugins });
  const forwarded = createRestClient({ baseUrl: "http://api", fetch: viaPlugins, forwarderKey: "fwd-raw" });

  let a = await client.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: "a b/c", verbose: true, limit: 3 }, { key: "write-raw" });
  const url = new URL(sent.at(-1)!.url);
  assert(a.status === 200 && same(a.body, { item_id: "a b/c", verbose: true }) && same(handed.at(-1), { key: "item", input: { item_id: "a b/c", verbose: true, limit: 3 } }),
    `a GET: the path field filled and decoded, the rest read from the query by the operation's schema (${a.status} ${JSON.stringify(a.body)})`);
  assert(url.pathname === "/v1/plugins/probe-kit/items/a%20b%2Fc" && url.searchParams.get("verbose") === "true" && url.searchParams.get("limit") === "3" && !url.searchParams.has("item_id"),
    `…sent as the route with the field encoded, the rest as the query (${url.pathname}${url.search})`);
  for (const brk of ["\n", "\r", "\u2028", "\u2029"]) {
    a = await client.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: `a${brk}b` }, { key: "write-raw" });
    assert(a.status === 200 && (a.body as { item_id?: string }).item_id === `a${brk}b`, `a path field holding ${JSON.stringify(brk)}: routed and answered, not the 405 naming its own method (review pass 2) (${a.status})`);
  }
  a = await client.callPath("POST", "/v1/plugins/probe-kit/notes/{note_id}", { note_id: "n1", text: "hello", tags: ["x"] }, { key: "write-raw" });
  const body = await sent.at(-1)!.text();
  assert(a.status === 200 && same(a.body, { saved: true }) && same(JSON.parse(body), { text: "hello", tags: ["x"] }) && new URL(sent.at(-1)!.url).pathname === "/v1/plugins/probe-kit/notes/n1",
    `a POST: the path field filled, the rest a JSON body (${a.status} ${body})`);
  a = await forwarded.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: "x" }, { key: "write-raw" });
  assert(sent.at(-1)!.headers.get("x-brain-key") === "write-raw" && sent.at(-1)!.headers.get("x-brain-forwarder") === "fwd-raw", "the caller's key and the forwarder slot ride it, as on call");

  a = await client.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: "gone" }, { key: "write-raw" });
  assert(a.status === 404 && same(a.body, { item_id: "gone", code: "ITEM_GONE", retryable: false }), `a plugin's refusal: its status, its code and facts (${a.status} ${JSON.stringify(a.body)})`);
  a = await forwarded.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: "gone" }, { key: "write-raw" });
  assert(a.status === 404 && same((a.body as { refusal?: unknown }).refusal, { item_id: "gone", status: 404, code: "ITEM_GONE", retryable: false }),
    `…forwarded, it carries itself whole, as a core refusal does (${JSON.stringify(a.body)})`);
  a = await client.callPath("POST", "/v1/plugins/probe-kit/notes/{note_id}", { note_id: "n1", text: "hello" }, { key: "nobody" });
  assert(a.status === 401 && a.sent, `a key the core does not know: its 401, sent (${a.status})`);
  a = await client.callPath("GET", "/v1/plugins/probe-kit/nothing/{x}", { x: "1" }, { key: "write-raw" });
  assert(a.status === 404 && (a.body as { code?: string }).code === "NO_ROUTE", `a route no operation takes: the core's 404 (${JSON.stringify(a.body)})`);

  const before = sent.length;
  a = await client.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: ".." }, { key: "write-raw" });
  assert(a.status === 400 && !a.sent && (a.body as { issues?: { path: string }[] }).issues?.[0]?.path === "item_id" && sent.length === before, `a path field a URL cannot carry: answered here, nothing sent (${JSON.stringify(a.body)})`);
  a = await client.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: "x", nested: { a: 1 } }, { key: "write-raw" });
  assert(a.status === 400 && !a.sent && sent.length === before, "an object in a GET's query: answered here, nothing sent");
  a = await client.callPath("GET", "/v1/plugins/probe-kit/items/{item_id}", { item_id: "x" }, { key: "k\nbad" });
  assert(a.status === 401 && !a.sent && sent.length === before, "a key no header carries: answered here, nothing sent");
  for (const [method, path] of [["GET", "/v1/thoughts"], ["GET", "/v1/plugins/probe-kit/../../v1/thoughts"], ["GET", "/v1/plugins/Probe/items"], ["GET", "http://elsewhere/v1/plugins/p/x"], ["PUT", "/v1/plugins/probe-kit/items/{item_id}"]] as const) {
    let threw = "";
    const pending = client.callPath(method as never, path, {}, { key: "write-raw" });
    await pending.catch((e: Error) => { threw = e.message; });
    assert(/callPath's (route|method)/.test(threw) && sent.length === before, `${method} ${path}: no plugin operation's route or method — a rejection, not a throw, nothing sent`);
  }
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
  // @ts-expect-error the job's event stream is stream()'s, not call()'s
  void c.call("job_stream", { job_id: "j" });
}

report();
