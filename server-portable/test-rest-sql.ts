#!/usr/bin/env bun
/**
 * test-rest-sql.ts — the REST core against real Postgres, beside the MCP
 * server over the same store (SMD-2284).
 *
 * The contract: every operation is run through both doors on the same
 * database, over data that gives each something to say, and the MCP reply to
 * a success is what render.ts makes of the REST answer — text and
 * structuredContent both. So every word and field MCP shows on a success is
 * in the REST answer; the REST answer may carry more (it is the core's whole
 * value, for a key that can read). A refusal is the same code and the same
 * declared facts through both, at the status REST gives it; its MCP text
 * reads facts REST withholds (the caller's input, the store's words), so a
 * refusal's prose is not derivable from REST alone (SMD-2287's to settle). Then test-auth's cases against REST (a read key cannot write, a capture
 * key cannot read, a wrong or revoked key is a 401), the door a REST write
 * records, and a log with no query, key or content in it.
 *
 * The embedding provider is stubbed, as test-e2e-sql's is.
 *
 *   ../db/with-postgres.sh bun test-rest-sql.ts
 */

import { SQL } from "bun";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { hashKey } from "./auth.ts";
import { ok } from "./core/refusal.ts";
import * as say from "./render.ts";
import { REFUSAL_STATUS } from "./rest/app.ts";
import { TOOL_NAMES } from "./tools.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-rest-sql.ts");
  process.exit(2);
}

const EMBEDDING_DIM = 1536;
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;

const { assert, report } = createAssert();
await resetSchema(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

// ── Stub only the model provider (test-e2e-sql.ts's stub) ────────────────────
const STUB_BASE = "https://stub.invalid/v1";
const KNOWN: Record<string, number> = { alpha: 0, beta: 1, gamma: 2 };
const axisFor = (text: string) => KNOWN[Object.keys(KNOWN).find((k) => text.toLowerCase().includes(k)) ?? ""] ?? 3;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(STUB_BASE)) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/embeddings")) {
      const v = new Array(EMBEDDING_DIM).fill(0);
      v[axisFor(String(body.input))] = 1;
      return new Response(JSON.stringify({ data: [{ embedding: v }] }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: ["stubbed"], type: "idea" }) } }] }), { headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

process.env.OB1_LLM_BASE_URL = STUB_BASE;
process.env.OB1_LLM_LOCAL = "1";
process.env.OPENROUTER_API_KEY = "stub";
delete process.env.OB1_STORE;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.MCP_ACCESS_KEY = "legacy-raw"; // the legacy single key: full write, named MCP_ACCESS_KEY
delete process.env.OB1_QUERY_LOG; // off: a read through one door must leave nothing the other door's read would see
process.env.DATABASE_URL = URL_;
process.env.OB1_AGENT_CACHE_TTL_MS = "0"; // a revocation reaches the next request
const KEYS = { writer: "writer-raw", reader: "reader-raw", hook: "hook-raw", gone: "gone-raw" } as const;
process.env.MCP_ACCESS_KEYS = [
  `writer:write:${hashKey(KEYS.writer)}`, `reader:read:${hashKey(KEYS.reader)}`,
  `hook:capture:${hashKey(KEYS.hook)}`, `gone:write:${hashKey(KEYS.gone)}`,
].join(",");

// Both doors in one process, over the one process root (root.ts): one store.
const mcpServer = Bun.serve({ port: 0, fetch: (await import("./index.ts")).default.fetch });
const apiServer = Bun.serve({ port: 0, fetch: (await import("./api.ts")).default.fetch });
const MCP = `http://localhost:${mcpServer.port}`;
const API = `http://localhost:${apiServer.port}`;

type Reply = { text: string; sc: Record<string, unknown>; isError: boolean };
let rpcId = 1;
async function mcp(name: string, args: Record<string, unknown>, key: string = KEYS.writer): Promise<Reply> {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const body = JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  if (body.error) throw new Error(`JSON-RPC error on ${name}: ${JSON.stringify(body.error)}`);
  return { text: (body.result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n"), sc: body.result.structuredContent ?? {}, isError: body.result.isError === true };
}
type Answer = { status: number; body: Record<string, unknown>; headers: Headers };
async function rest(method: string, path: string, body?: unknown, key: string = KEYS.writer): Promise<Answer> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(key ? { "x-brain-key": key } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown>, headers: r.headers };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** render.ts over a REST answer; a value it cannot render reads as an empty reply, so its case fails rather than the suite. */
function rendered(render: (v: never) => say.Reply, v: unknown): say.Reply {
  try {
    return render(v as never);
  } catch (err) {
    return { content: [{ type: "text", text: `(the REST value does not render: ${(err as Error).message})` }], structuredContent: {} };
  }
}
const firstDiff = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].find((k) => !same(a[k], b[k])) ?? "-";

const sql = new SQL({ url: URL_, max: 1 });

console.log("[1] A capture through the REST core is a creation, recorded at its own door");
const ids: string[] = [];
{
  for (const content of ["alpha: the first thought through REST", "beta: the second thought through REST", "gamma: the third thought through REST"]) {
    const r = await rest("POST", "/v1/thoughts", { content });
    assert(r.status === 201 && typeof r.body.id === "string" && r.body.embeddingAttached === true && r.headers.get("location") === `/v1/thoughts/${r.body.id}`,
      `POST /v1/thoughts → 201, its id, its Location, its vector attached (${r.status} ${JSON.stringify(r.body).slice(0, 100)})`);
    ids.push(String(r.body.id));
  }
  const [audit] = await sql`SELECT actor_name, origin FROM thought_audit WHERE thought_id = ${ids[0]}::uuid AND action = 'capture' ORDER BY id LIMIT 1`;
  assert(audit?.origin === "open-brain-api" && audit?.actor_name === "writer", `the audit row names the key and the REST core's door (${JSON.stringify(audit)})`);
}

// Data each comparison has something to say about: two logged searches, a
// pending supersession proposal, failed rows in two pools and two stale leases.
{
  for (const q of ["seeded search one", "seeded search two"]) {
    await sql`INSERT INTO query_log (kind, tool, query, match_count, threshold, recency_weight, filter, result_ids, result_scores, arm)
              VALUES ('search', 'search_thoughts', ${q}, 10, 0, 0, '{}'::jsonb, ARRAY[${ids[0]}::uuid], ARRAY[0.9::real], 'hybrid')`;
  }
  await sql`SELECT record_supersession_proposal(${ids[0]}::uuid, ${ids[1]}::uuid, 'conflict_undirected', 0.7, 'a seeded reason', 0.9, 'consolidate:stub@p2', NULL)`;
  await sql`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at, last_error) VALUES
    (${ids[0]}::uuid, 'extract:rest@p1', 'failed', 'w', now(), 'boom'),
    (${ids[1]}::uuid, 'extract:mcp@p1', 'failed', 'w', now(), 'boom')`;
  await sql`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at) VALUES
    (${ids[0]}::uuid, 'extract:lease@p1', 'claimed', 'w-rest', now() - interval '2 hours', now() - interval '2 hours'),
    (${ids[1]}::uuid, 'extract:lease@p1', 'claimed', 'w-mcp', now() - interval '2 hours', now() - interval '2 hours')`;
}

console.log("\n[2] Every read: the MCP reply is what render.ts makes of the REST answer, text and structuredContent");
{
  // Each case names what makes its page non-empty, so no comparison is two empty pages.
  type Case = [tool: string, args: Record<string, unknown>, method: string, path: string, body: unknown, render: (v: never) => say.Reply, filled: (v: Record<string, unknown>) => boolean];
  const has = (key: string) => (v: Record<string, unknown>) => Array.isArray(v[key]) && (v[key] as unknown[]).length > 0;
  const cases: Case[] = [
    ["search", { query: "alpha" }, "POST", "/v1/search/compat", { query: "alpha" }, (v) => say.renderSearch(ok(v)), has("results")],
    ["fetch", { id: ids[1] }, "GET", `/v1/thoughts/${ids[1]}`, undefined, (v) => say.renderFetch(ok(v)), (v) => v.id === ids[1]],
    ["search_thoughts", { query: "alpha", limit: 5 }, "POST", "/v1/search", { query: "alpha", limit: 5 }, (v) => say.renderSearchThoughts(ok(v), false), has("hits")],
    ["search_thoughts", { query: "beta", prefer_current: true }, "POST", "/v1/search", { query: "beta", prefer_current: true }, (v) => say.renderSearchThoughts(ok(v), true), has("hits")],
    ["search_thoughts_keyword", { query: "thought through" }, "POST", "/v1/search/keyword", { query: "thought through" }, (v) => say.renderSearchThoughtsKeyword(ok(v)), has("hits")],
    ["list_thoughts", { limit: 5 }, "GET", "/v1/thoughts?limit=5", undefined, (v) => say.renderListThoughts(ok(v)), has("thoughts")],
    ["list_thought_ids", { limit: 2 }, "GET", "/v1/thought-ids?limit=2", undefined, (v) => say.renderThoughtIds(ok(v)), has("ids")],
    ["list_logged_searches", {}, "GET", "/v1/logged-searches", undefined, (v) => say.renderLoggedSearches(ok(v)), has("searches")],
    ["list_supersession_proposals", { status: "all" }, "GET", "/v1/proposals?status=all", undefined, (v) => say.renderSupersessionProposals(ok(v)), has("proposals")],
    ["thought_stats", {}, "GET", "/v1/stats", undefined, (v) => say.renderThoughtStats(ok(v)), (v) => typeof v.total === "number" && v.total > 0],
    ["thought_changes", { limit: 10, actions: ["capture"] }, "GET", "/v1/changes?limit=10&actions=capture", undefined, (v) => say.renderThoughtChanges(ok(v)), has("changes")],
    ["worker_status", {}, "GET", "/v1/workers", undefined, (v) => say.renderWorkerStatus(ok(v)), has("pools")],
  ];
  const covered = new Set<string>();
  for (const [tool, args, method, path, body, render, filled] of cases) {
    const r = await rest(method, path, body);
    const m = await mcp(tool, args);
    const out = rendered(render, r.body);
    covered.add(tool);
    assert(r.status === 200 && !m.isError, `${tool}: both doors answer (${r.status}, ${m.isError ? "error" : "ok"})`);
    assert(filled(r.body), `${tool}: …over something, not an empty page (${JSON.stringify(r.body).slice(0, 60)})`);
    assert(out.content[0].text === m.text, `${tool}: the MCP text is the REST value rendered (${out.content[0].text === m.text ? "same" : `REST→ ${out.content[0].text.slice(0, 80)} | MCP ${m.text.slice(0, 60)}`})`);
    assert(same(out.structuredContent, m.sc), `${tool}: …and its structuredContent (first difference: ${firstDiff(out.structuredContent, m.sc)})`);
  }
  // brain_info: the whole record, and the table it renders to.
  const b = await rest("GET", "/v1/brain");
  const m = await mcp("brain_info", {});
  const info = rendered((v) => say.renderBrainInfoReply(v), b.body);
  assert(b.status === 200 && info.content[0].text === m.text && same(info.structuredContent, m.sc), `brain_info: the same record and table (${b.status}; first difference: ${firstDiff(info.structuredContent, m.sc)})`);
  covered.add("brain_info");
  const reads = ["search", "fetch", "search_thoughts", "search_thoughts_keyword", "list_thoughts", "list_thought_ids", "list_logged_searches", "list_supersession_proposals", "thought_stats", "thought_changes", "worker_status", "brain_info"];
  assert(reads.every((t) => covered.has(t)), "every read operation but the job pair is compared here; the job pair is [4]");
}

console.log("\n[3] Every write: the same reply through either door, the ids each made aside");
{
  // Each door writes its own row; the REST answer, given the MCP row's id and
  // times, renders to the MCP reply.
  const swap = (v: Record<string, unknown>, from: Record<string, unknown>, keys: string[] = ["id", "updatedAt"]) =>
    Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.includes(k) && k in from ? from[k] : x]));
  const r = await rest("POST", "/v1/thoughts", { content: "delta: written through REST", source: "rest-suite" });
  const m = await mcp("capture_thought", { content: "delta: written through MCP", source: "rest-suite" });
  const { embeddingAttached: _attached, ...captured } = r.body;
  const cr = rendered((v) => say.renderCapture(ok(v)), swap(captured, m.sc));
  assert(cr.content[0].text === m.text && same(cr.structuredContent, m.sc), `capture_thought: the same reply (first difference: ${firstDiff(cr.structuredContent, m.sc)})`);

  const u = await rest("PATCH", `/v1/thoughts/${ids[0]}`, { metadata_patch: { reviewed: true } });
  assert(u.body.id === ids[0] && typeof u.body.updatedAt === "string", `the REST update answers the thought it changed (${u.body.id})`);
  const um = await mcp("update_thought", { id: ids[1], metadata_patch: { reviewed: true } });
  const ur = rendered((v) => say.renderUpdate(ok(v)), swap(u.body, um.sc));
  assert(u.status === 200 && ur.content[0].text === um.text && same(ur.structuredContent, um.sc), `update_thought: the same reply (${u.status}; first difference: ${firstDiff(ur.structuredContent, um.sc)})`);

  const doomedRest = String(r.body.id), doomedMcp = String(m.sc.id);
  const d = await rest("DELETE", `/v1/thoughts/${doomedRest}`);
  assert(d.body.id === doomedRest && (await rest("GET", `/v1/thoughts/${doomedRest}`)).status === 404, "the REST delete answers the thought it removed, and it is gone");
  const dm = await mcp("delete_thought", { id: doomedMcp });
  const dr = rendered((v) => say.renderDelete(ok(v)), swap(d.body, dm.sc));
  assert(d.status === 200 && dr.content[0].text === dm.text && same(dr.structuredContent, dm.sc), `delete_thought: the same reply (${d.status}; first difference: ${firstDiff(dr.structuredContent, dm.sc)})`);

  // Each door acts on its own seeded pool or holder, so both act on a row.
  const workers: [string, Record<string, unknown>, Record<string, unknown>, string, (v: never) => say.Reply, string[]][] = [
    ["retry_failed", { work_type: "extract:rest@p1" }, { work_type: "extract:mcp@p1" }, "/v1/workers/retry", (v) => say.renderRetryFailed(ok(v)), ["workType", "ids"]],
    ["release_stale_leases", { worker_id: "w-rest" }, { worker_id: "w-mcp" }, "/v1/workers/release-leases", (v) => say.renderReleaseStaleLeases(ok(v)), ["ids", "workers"]],
    ["run_worker", { work_type: "extract:rest@p1", dry_run: true }, { work_type: "extract:rest@p1", dry_run: true }, "/v1/workers/run", (v) => say.renderRunWorker(ok(v)), []],
  ];
  for (const [tool, restArgs, mcpArgs, path, render, own] of workers) {
    const w = await rest("POST", path, restArgs);
    const wm = await mcp(tool, mcpArgs);
    const wr = rendered(render, swap(w.body, wm.sc, own));
    assert(w.status === 200 && JSON.stringify(w.body).match(/"(?:retried|released|pending)":[1-9]/) !== null, `${tool}: REST acted on a row (${JSON.stringify(w.body).slice(0, 90)})`);
    assert(wr.content[0].text === wm.text && same(wr.structuredContent, wm.sc), `${tool}: the same reply (first difference: ${firstDiff(wr.structuredContent, wm.sc)})`);
  }
}

console.log("\n[3b] A GET sent with a body, as curl or n8n may send it: Bun drops the body, the REST core refuses the request rather than answer without it");
{
  // Bun's fetch will not send a GET body, so a raw request on a socket.
  const { connect } = await import("node:net");
  const raw = (request: string) => new Promise<string>((resolve, reject) => {
    const sock = connect(apiServer.port!, "127.0.0.1", () => sock.write(request));
    let got = "";
    sock.on("data", (d) => { got += d.toString(); if (got.includes("\r\n\r\n")) { sock.destroy(); resolve(got); } });
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); resolve(got); }, 3_000);
  });
  const body = JSON.stringify({ limit: 1 });
  const withBody = await raw(`GET /v1/thoughts HTTP/1.1\r\nHost: api\r\nx-brain-key: ${KEYS.writer}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
  assert(/^HTTP\/1\.1 400 /.test(withBody), `a GET carrying {"limit":1} is a 400, not every row (${withBody.split("\r\n")[0]})`);
  const plain = await raw(`GET /v1/thoughts?limit=1 HTTP/1.1\r\nHost: api\r\nx-brain-key: ${KEYS.writer}\r\nConnection: close\r\n\r\n`);
  assert(/^HTTP\/1\.1 200 /.test(plain), `…while the same GET with its input in the query is a 200 (${plain.split("\r\n")[0]})`);
}

console.log("\n[4] A job through REST: a handle on this server's routes, its poll the job_status tool's answer, its stream");
{
  const s = await rest("POST", "/v1/scans", { limit: 10 }, KEYS.reader);
  const jobId = String(s.body.jobId);
  const sm = await mcp("scan_thoughts", { limit: 10 }, KEYS.reader);
  assert(same(Object.keys(s.body).sort(), Object.keys(sm.sc).sort()) && s.body.status === sm.sc.status && sm.sc.poll === `/jobs/${sm.sc.jobId}`,
    `scan_thoughts: the same handle through both doors, each on its own server's routes (MCP ${JSON.stringify(sm.sc).slice(0, 90)})`);
  assert(s.status === 202 && s.body.poll === `/v1/jobs/${jobId}` && s.body.stream === `/v1/jobs/${jobId}/stream` && s.headers.get("location") === `/v1/jobs/${jobId}`, `POST /v1/scans → 202 and a handle on /v1/jobs (${s.status} ${JSON.stringify(s.body)})`);
  let poll: Answer = { status: 0, body: {}, headers: new Headers() };
  for (let i = 0; i < 50; i++) {
    poll = await rest("GET", `/v1/jobs/${jobId}`, undefined, KEYS.reader);
    if (poll.body.status === "succeeded" || poll.body.status === "failed") break;
    await Bun.sleep(50);
  }
  const pm = await mcp("job_status", { job_id: jobId }, KEYS.reader);
  const pr = rendered((v) => say.renderJobStatus(ok(v)), poll.body);
  assert(poll.status === 200 && poll.body.status === "succeeded" && pr.content[0].text === pm.text && same(pr.structuredContent, pm.sc), `job_status: the poll is the tool's answer (${poll.body.status})`);
  const other = await rest("GET", `/v1/jobs/${jobId}`, undefined, KEYS.writer);
  assert(other.status === 404 && other.body.code === "NOT_FOUND", `another key's poll is NOT_FOUND (${other.status})`);
  const stream = await fetch(`${API}/v1/jobs/${jobId}/stream`, { headers: { "x-brain-key": KEYS.reader } });
  const events = await stream.text();
  assert(stream.status === 200 && /text\/event-stream/.test(stream.headers.get("content-type") ?? "") && /succeeded/.test(events), `its stream replays the job's end (${stream.status})`);
}

console.log("\n[5] A refusal is the same code and facts through both doors, at the status REST gives it");
{
  const missing = "00000000-0000-4000-8000-000000000000";
  const filter = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
  const cases: [tool: string, args: Record<string, unknown>, method: string, path: string, body: unknown][] = [
    ["fetch", { id: missing }, "GET", `/v1/thoughts/${missing}`, undefined],
    ["thought_changes", { since: "not-a-time" }, "GET", "/v1/changes?since=not-a-time", undefined],
    ["list_thought_ids", { after: "not-a-uuid" }, "GET", "/v1/thought-ids?after=not-a-uuid", undefined],
    ["list_logged_searches", { since: "not-a-time" }, "GET", "/v1/logged-searches?since=not-a-time", undefined],
    ["search_thoughts", { query: "alpha", filter }, "POST", "/v1/search", { query: "alpha", filter }],
    ["capture_thought", { content: "epsilon", supersedes: "not-a-uuid" }, "POST", "/v1/thoughts", { content: "epsilon", supersedes: "not-a-uuid" }],
    ["capture_thought", { content: "epsilon", metadata: { source: "spoofed" } }, "POST", "/v1/thoughts", { content: "epsilon", metadata: { source: "spoofed" } }],
    ["update_thought", { id: ids[2] }, "PATCH", `/v1/thoughts/${ids[2]}`, {}],
    ["update_thought", { id: missing, content: "zeta" }, "PATCH", `/v1/thoughts/${missing}`, { content: "zeta" }],
    ["delete_thought", { id: missing }, "DELETE", `/v1/thoughts/${missing}`, undefined],
    ["retry_failed", { work_type: "  " }, "POST", "/v1/workers/retry", { work_type: "  " }],
    ["release_stale_leases", { include_live: true }, "POST", "/v1/workers/release-leases", { include_live: true }],
    ["run_worker", { work_type: "extract:none@p1" }, "POST", "/v1/workers/run", { work_type: "extract:none@p1" }],
  ];
  const codes = new Set<string>();
  for (const [tool, args, method, path, body] of cases) {
    const r = await rest(method, path, body);
    const m = await mcp(tool, args);
    const { text: _text, ...facts } = m.sc;
    const code = String(r.body.code);
    codes.add(code);
    assert(m.isError && same(r.body, facts), `${tool} ${code}: the same code and facts (REST ${JSON.stringify(r.body)} | MCP ${JSON.stringify(facts)})`);
    assert(r.status === REFUSAL_STATUS[code as keyof typeof REFUSAL_STATUS], `…at its status (${r.status})`);
  }
  // Refusals that carry facts beside the code: the positions to drop and the
  // row's current time. REFUSED_CITED's count needs an extracted statement
  // citing the thought (042), which db/test-schema.ts and test-live.ts build.
  const withFacts: [tool: string, args: Record<string, unknown>, method: string, path: string, body: unknown, fact: string][] = [
    ["capture_thought", { content: "kappa", derived_from: [ids[0], missing] }, "POST", "/v1/thoughts", { content: "kappa", derived_from: [ids[0], missing] }, "positions"],
    ["update_thought", { id: ids[0], content: "alpha, edited", if_unchanged_since: "2020-01-01T00:00:00Z" }, "PATCH", `/v1/thoughts/${ids[0]}`, { content: "alpha, edited", if_unchanged_since: "2020-01-01T00:00:00Z" }, "currentUpdatedAt"],
  ];
  for (const [tool, args, method, path, body, fact] of withFacts) {
    const r = await rest(method, path, body);
    const m = await mcp(tool, args);
    const { text: _text, ...facts } = m.sc;
    const code = String(r.body.code);
    codes.add(code);
    assert(m.isError && fact in r.body && same(r.body, facts), `${tool} ${code}: the same code and its ${fact} (REST ${JSON.stringify(r.body)} | MCP ${JSON.stringify(facts)})`);
    assert(r.status === REFUSAL_STATUS[code as keyof typeof REFUSAL_STATUS], `…at its status (${r.status})`);
  }
  assert(codes.size >= 12, `${codes.size} distinct codes compared`);
}

console.log("\n[6] test-auth's cases against REST: a read key cannot write, a capture key cannot read, a wrong or revoked key is a 401");
{
  let r = await rest("POST", "/v1/thoughts", { content: "a read key's capture" }, KEYS.reader);
  assert(r.status === 403 && r.body.code === "FORBIDDEN", `a read key cannot capture (${r.status})`);
  r = await rest("DELETE", `/v1/thoughts/${ids[2]}`, undefined, KEYS.reader);
  assert(r.status === 403, `…nor delete (${r.status})`);
  r = await rest("PATCH", `/v1/thoughts/${ids[2]}`, { content: "changed" }, KEYS.hook);
  assert(r.status === 403, `a capture key cannot update (${r.status})`);
  for (const path of ["/v1/stats", "/v1/thoughts", `/v1/thoughts/${ids[2]}`, "/v1/changes", "/v1/workers"]) {
    r = await rest("GET", path, undefined, KEYS.hook);
    assert(r.status === 403 && r.body.code === "FORBIDDEN", `a capture key cannot read ${path} (${r.status})`);
  }
  r = await rest("POST", "/v1/search", { query: "alpha" }, KEYS.hook);
  assert(r.status === 403, `…nor search (${r.status})`);
  r = await rest("POST", "/v1/thoughts", { content: "eta: a capture key's thought" }, KEYS.hook);
  assert(r.status === 201 && r.body.embeddingAttached === true, `a capture key captures (${r.status})`);
  assert(r.body.existed === undefined, "…and is not told whether the text was already a thought (the existence-oracle rule)");
  const hm = await mcp("capture_thought", { content: "theta: a capture key's thought" }, KEYS.hook);
  const { text: _t, ...hookFacts } = hm.sc;
  const { embeddingAttached: _a, ...hookRest } = r.body;
  assert(same({ ...hookRest, id: hookFacts.id }, hookFacts), `…and told exactly the fields the MCP tool gives it — no provider address or gate reasons (REST ${JSON.stringify(hookRest)} | MCP ${JSON.stringify(hookFacts)})`);
  r = await rest("GET", "/v1/stats", undefined, "not-a-key");
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED", `a wrong key is a 401 (${r.status})`);
  r = await rest("GET", "/v1/stats", undefined, "");
  assert(r.status === 401, `no key is a 401 (${r.status})`);
  const viaQuery = await fetch(`${API}/v1/stats?key=${KEYS.reader}`);
  assert(viaQuery.status === 401, `a key in the query string is no key (${viaQuery.status})`);
  r = await rest("GET", "/v1/stats", undefined, KEYS.gone);
  assert(r.status === 200, `the key to be revoked reads first (${r.status})`);
  await sql`SELECT revoke_agent_key(${hashKey(KEYS.gone)}, ${"rest suite"})`;
  r = await rest("GET", "/v1/stats", undefined, KEYS.gone);
  assert(r.status === 401 && r.body.code === "REVOKED", `a revoked key is a 401 REVOKED (${r.status} ${r.body.code})`);
  const legacy = await rest("GET", "/v1/whoami", undefined, "legacy-raw");
  assert(legacy.status === 200 && legacy.body.name === "MCP_ACCESS_KEY" && legacy.body.scope === "write", `the legacy single key is a write key named MCP_ACCESS_KEY (${JSON.stringify(legacy.body).slice(0, 80)})`);
  const who = await rest("GET", "/v1/whoami", undefined, KEYS.reader);
  assert(who.status === 200 && who.body.name === "reader" && who.body.scope === "read" && typeof who.body.agentId === "string", `whoami names the key, its scope and its agent id (${JSON.stringify(who.body).slice(0, 120)})`);
}

console.log("\n[7] The OpenAPI document and the internal liveness answer with no key");
{
  const doc = await fetch(`${API}/openapi.json`);
  const body = await doc.json() as { paths: Record<string, Record<string, { operationId: string }>> };
  const ops = Object.values(body.paths).flatMap((m) => Object.values(m)).map((o) => o.operationId);
  assert(doc.status === 200 && TOOL_NAMES.every((t) => ops.includes(t)), `GET /openapi.json lists all ${TOOL_NAMES.length} tools' operations`);
  const live = await fetch(`${API}/health`);
  assert(live.status === 200 && same(await live.json(), { status: "ok" }), "GET /health is liveness, saying nothing about the brain");
}

console.log("\n[8] The log: one line per request, with no query, key, id or content in it, on any console channel");
{
  const lines: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await rest("POST", "/v1/search", { query: "the private words searched" });
    await rest("GET", `/v1/thoughts/${ids[2]}?trace=1`);
    await rest("GET", "/v1/changes?agent=someone-named");
    await rest("POST", "/v1/thoughts", { content: "theta: content that must not be logged" });
  } finally {
    Object.assign(console, real);
  }
  const api = lines.filter((l) => l.startsWith("api "));
  assert(api.length === 4, `four requests, four lines (${api.length}: ${api.join(" / ")})`);
  const all = lines.join("\n");
  for (const s of ["private words", ids[2], "trace=1", "someone-named", "must not be logged", KEYS.writer]) assert(!all.includes(s), `no ${s.slice(0, 20)} in the log`);
}

console.log("\n[9] `bun api.ts` as the entry wires the durable job store for the REST core: its own job left running is reconciled to lost, the MCP server's is left alone, and a job it starts is recorded as its own (migration 078, SMD-2284)");
{
  const mine = crypto.randomUUID(), theirs = crypto.randomUUID();
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, started_at, door) VALUES (${mine}::uuid, 'scan_thoughts', ${hashKey(KEYS.reader)}, 'reader', 'running', now(), 'open-brain-api')`;
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, started_at, door) VALUES (${theirs}::uuid, 'scan_thoughts', ${hashKey(KEYS.reader)}, 'reader', 'running', now(), 'open-brain')`;
  const free = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = free.port;
  free.stop(true);
  const child = Bun.spawn([process.execPath, "api.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore", stderr: "pipe",
  });
  const status = async (id: string) => String((await sql`SELECT status FROM jobs WHERE id = ${id}::uuid`)[0]?.status);
  let mineStatus = "running";
  try {
    const deadline = Date.now() + 15_000;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      answered = await realFetch(`http://127.0.0.1:${port}/v1/whoami`, { headers: { "x-brain-key": KEYS.reader }, signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
      if (!answered) await Bun.sleep(100);
    }
    assert(answered, "the REST core answers a keyed request as Bun's entry, which builds its store");
    while (mineStatus === "running" && Date.now() < deadline) {
      mineStatus = await status(mine);
      if (mineStatus === "running") await Bun.sleep(100);
    }
    assert(mineStatus === "lost", `the REST core's own job left running is reconciled to lost (${mineStatus})`);
    assert((await status(theirs)) === "running", "…and the MCP server's live job on the same database is not");
    const scan = await realFetch(`http://127.0.0.1:${port}/v1/scans`, { method: "POST", headers: { "x-brain-key": KEYS.reader, "content-type": "application/json" }, body: JSON.stringify({ limit: 5 }) });
    const { jobId } = await scan.json() as { jobId: string };
    let door: string | undefined;
    for (let i = 0; i < 50 && door === undefined; i++) {
      door = (await sql`SELECT door FROM jobs WHERE id = ${jobId}::uuid`)[0]?.door;
      if (door === undefined) await Bun.sleep(100);
    }
    assert(scan.status === 202 && door === "open-brain-api", `a scan the REST core starts is recorded as its own (${scan.status}, door ${door})`);
  } finally {
    child.kill();
    const hung = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await child.exited;
    clearTimeout(hung);
    if (mineStatus !== "lost") console.log((await new Response(child.stderr).text()).split("\n").slice(-10).map((l) => `      ${l}`).join("\n"));
    await sql`DELETE FROM jobs WHERE id IN (${mine}::uuid, ${theirs}::uuid)`;
  }
}

apiServer.stop();
mcpServer.stop();
await sql.close();
globalThis.fetch = realFetch;
report();
