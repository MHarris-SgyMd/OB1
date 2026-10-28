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
import { childPort, createAssert, resetSchema } from "../db/test-support.ts";
import { mcpUnderTest, servedByMcpServer } from "./test-support.ts";
import { authenticate, CLIENT_SCOPES, hashKey } from "./auth.ts";
import { z } from "zod";
import { ok } from "./core/refusal.ts";
import { listCursor } from "./core/list-cursor.ts";
import * as say from "./render.ts";
import { REFUSAL_STATUS } from "./rest/app.ts";
import { TOOL_NAMES } from "./tools.ts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkerOver, subjectHash, tokenSettings } from "./oauth-token.ts";

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
const KEYS = { writer: "writer-raw", reader: "reader-raw", hook: "hook-raw", gone: "gone-raw", forwarder: "forwarder-raw", forwarderGone: "forwarder-gone-raw", fresh: "fresh-raw" } as const;
process.env.MCP_ACCESS_KEYS = [
  `writer:write:${hashKey(KEYS.writer)}`, `reader:read:${hashKey(KEYS.reader)}`,
  `hook:capture:${hashKey(KEYS.hook)}`, `gone:write:${hashKey(KEYS.gone)}`,
  // Forwarders (SMD-2284): grant nothing; read in the REST core's forwarder slot alone.
  `mcp-forwarder:forward:${hashKey(KEYS.forwarder)}`, `old-forwarder:forward:${hashKey(KEYS.forwarderGone)}`,
  `fresh:write:${hashKey(KEYS.fresh)}`, // never used but by [6b]'s refused forwarded request
].join(",");

// Both doors in one process, over the one process root (root.ts): one store. The MCP server is the REST core's
// client (SMD-2287), so its reply is render.ts over the REST answer by construction; [2] holds both to a core of this
// suite's own besides (`directly`).
const mcpServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (await mcpUnderTest()).fetch });
assert(servedByMcpServer(), "the server under test is the MCP server, the REST core behind it");
const apiServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (await import("./api.ts")).default.fetch });
const MCP = `http://127.0.0.1:${mcpServer.port}`;
const API = `http://127.0.0.1:${apiServer.port}`;

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
async function rest(method: string, path: string, body?: unknown, key: string = KEYS.writer, carrier?: string): Promise<Answer> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(key ? { "x-brain-key": key } : {}), ...(carrier ? { "x-brain-forwarder": carrier } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
/** A value's shape: its keys, nested, each leaf its JSON type — what two writes of different rows share, so a field one answer drops, renames or leaves out where the other has a 0 differs (review pass 6a·3). */
const shapeOf = (v: unknown): unknown => Array.isArray(v) ? v.map(shapeOf) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])])) : v === null ? "null" : typeof v;
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
  // SMD-3249: a second, under another pass, so a page of one has a next page to list.
  await sql`SELECT record_supersession_proposal(${ids[1]}::uuid, ${ids[2]}::uuid, 'newer_supersedes_older', 0.6, 'a second seeded reason', 0.9, 'consolidate:stub@p3', NULL)`;
  // Judged ahead of every read, so brain_info's oldest pending age is 0 s at
  // both doors: each door rounds its own read's age, and two reads either side
  // of a half second answered 0 and 1 (SMD-3195 review pass 2, under load).
  await sql`UPDATE supersession_proposals SET judged_at = now() + interval '1 hour' WHERE status = 'pending'`;
  await sql`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at, last_error) VALUES
    (${ids[0]}::uuid, 'extract:rest@p1', 'failed', 'w', now(), 'boom'),
    (${ids[1]}::uuid, 'extract:mcp@p1', 'failed', 'w', now(), 'boom')`;
  await sql`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at) VALUES
    (${ids[0]}::uuid, 'extract:lease@p1', 'claimed', 'w-rest', now() - interval '2 hours', now() - interval '2 hours'),
    (${ids[1]}::uuid, 'extract:lease@p1', 'claimed', 'w-mcp', now() - interval '2 hours', now() - interval '2 hours')`;
}

// A third pipeline (SMD-2287 PR 6a): a core of this suite's own over the one store, called in process with the
// writer's principal and the tool's input as the MCP SDK parses it, its value rendered — what index.ts's tools were.
// The MCP reply is render.ts over the REST answer, so this is what holds the REST answer to the core's own value, in
// [2]'s reads and [3]'s writes: a field the REST answer loses or renames passes the REST-to-MCP comparisons (review
// passes 1 and 2's mutants).
const { createCore } = await import("./core/index.ts");
const { SPECS } = await import("./core/schemas.ts");
const { db, env } = await import("./root.ts");
const direct = createCore({ env, store: db, door: "open-brain-direct" });
const writer = authenticate(KEYS.writer, { MCP_ACCESS_KEYS: process.env.MCP_ACCESS_KEYS }, { admit: CLIENT_SCOPES });
assert(writer !== null, "the writer's key authenticates in process");
const CORE_OP: Record<string, keyof typeof direct> = {
  search: "search", fetch: "fetch", search_thoughts: "searchThoughts", search_thoughts_keyword: "searchThoughtsKeyword", list_thoughts: "listThoughts",
  list_thought_ids: "listThoughtIds", list_logged_searches: "listLoggedSearches", list_supersession_proposals: "listSupersessionProposals",
  thought_stats: "thoughtStats", thought_changes: "thoughtChanges", worker_status: "workerStatus",
  capture_thought: "capture", update_thought: "updateThought", delete_thought: "deleteThought",
};
const directly = async (tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown }> => {
  const input = z.object(SPECS[tool as keyof typeof SPECS].inputSchema as z.ZodRawShape).parse(args);
  return (direct[CORE_OP[tool]] as unknown as (p: unknown, i: unknown) => Promise<{ ok: boolean; value?: unknown }>)(writer, input);
};

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
    // SMD-3248: one pass's proposals by its judge key (109), the key echoed in the value beside each row's.
    ["list_supersession_proposals", { status: "all", judge_key: "consolidate:stub@p2" }, "GET", "/v1/proposals?status=all&judge_key=consolidate%3Astub%40p2", undefined, (v) => say.renderSupersessionProposals(ok(v)),
      (v) => v.judgeKey === "consolidate:stub@p2" && Array.isArray(v.proposals) && v.proposals.length > 0 && (v.proposals as { judgeKey: string }[]).every((p) => p.judgeKey === "consolidate:stub@p2")],
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
    const d = await directly(tool, args);
    const own = rendered(render, d.value);
    const whole = JSON.parse(JSON.stringify(d.value ?? null)) as Record<string, unknown>;
    assert(d.ok && own.content[0].text === m.text && same(own.structuredContent, m.sc) && same(r.body, whole),
      `${tool}: …and a core of this suite's own says the same: rendered in process, and its whole value the REST answer (${d.ok ? `${firstDiff(own.structuredContent, m.sc)} / ${firstDiff(r.body, whole)}` : "refused"})`);
  }
  // brain_info: the whole record, and the table it renders to.
  const b = await rest("GET", "/v1/brain");
  const m = await mcp("brain_info", {});
  const info = rendered((v) => say.renderBrainInfoReply(v), b.body);
  // The provider's state is the REST core's (SMD-2890), read by each door at
  // its own moment (until SMD-2287 PR 6a the MCP door was a core of its own).
  // Only the times set aside (review pass 4: the whole state set aside hid any
  // other difference) — the status, `by`, the re-probe and the row's words
  // stay under the comparison. A core of this suite's own (`directly`, above)
  // is left out here: its provider state is its own, and it has probed nothing.
  const STAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
  const noTimes = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v), (k, x) => (k === "at" || k === "since" ? "<t>" : typeof x === "string" ? x.replace(STAMP, "<t>") : x));
  assert(b.status === 200 && info.content[0].text.replace(STAMP, "<t>") === m.text.replace(STAMP, "<t>") && same(noTimes(info.structuredContent), noTimes(m.sc)), `brain_info: the same record and table, the times aside (${b.status}; first difference: ${firstDiff(noTimes(info.structuredContent), noTimes(m.sc))})`);
  const providerOf = (v: unknown) => (((v as { value?: unknown })?.value ?? v) as { provider?: { status?: string; by?: string } }).provider;
  assert(providerOf(b.body)?.status === "answering" && providerOf(b.body)?.by === "call" && providerOf(m.sc)?.status === "answering" && /^Provider:\s+answering \(an embedding call answered /m.test(m.text),
    `…and the REST core's provider state answering, by a call, after the searches above, through either door (${JSON.stringify(providerOf(b.body))} | ${JSON.stringify(providerOf(m.sc))})`);
  covered.add("brain_info");
  // SMD-2995: list_thoughts a page at a time. The first page's cursor, from
  // REST, takes either door to the same next page — text, structuredContent
  // and cursor — in each sort; and a cursor that is no cursor, or one made
  // under the other sort, is refused alike: REST's 400 with the facts, the
  // MCP reply what render.ts words of that refusal.
  for (const sort of ["newest", "oldest"] as const) {
    const first = await rest("GET", `/v1/thoughts?limit=1&sort=${sort}`);
    const cursor = first.body.cursor;
    assert(first.status === 200 && typeof cursor === "string" && first.body.sort === sort && (first.body.thoughts as unknown[]).length === 1, `list_thoughts ${sort}: a first page of one carries a cursor and its sort (${first.status}, ${typeof cursor})`);
    const r = await rest("GET", `/v1/thoughts?limit=1&sort=${sort}&after=${encodeURIComponent(String(cursor))}`);
    const m = await mcp("list_thoughts", { limit: 1, sort, after: cursor });
    const out = rendered((v) => say.renderListThoughts(ok(v)), r.body);
    const firstId = (first.body.thoughts as { id: string }[])[0].id;
    const nextId = ((r.body.thoughts ?? []) as { id: string }[])[0]?.id;
    assert(r.status === 200 && !m.isError && nextId !== undefined && nextId !== firstId, `list_thoughts ${sort}: the cursor takes both doors on to the next thought (${r.status}, ${nextId !== firstId ? "another" : "the same"})`);
    assert(out.content[0].text === m.text && same(out.structuredContent, m.sc), `…the same page through either door, its cursor among it (first difference: ${firstDiff(out.structuredContent, m.sc)})`);
    // The cursor itself in structuredContent, as REST gives it — not a value the guard nulled on both sides alike (review pass 1).
    const m1 = await mcp("list_thoughts", { limit: 1, sort });
    assert(typeof m1.sc.cursor === "string" && m1.sc.cursor === cursor, `…and MCP's structuredContent carries the first page's cursor as REST does, a string (${typeof m1.sc.cursor})`);
    const other = sort === "newest" ? "oldest" : "newest";
    // A cursor of the right shape whose time Postgres's cast cannot read (an offset past ±15:59:59): refused alike, not a fault quoting it (review pass 1).
    const unreadable = listCursor(sort, "2026-01-01 00:00:00+16", "00000000-0000-4000-8000-000000000000");
    for (const [why, after, s2, facts] of [["a cursor that is none", "not-a-cursor", sort, { reason: "shape" }], ["a cursor whose time Postgres cannot read", unreadable, sort, { reason: "shape" }], ["a cursor made under the other sort", String(cursor), other, { reason: "sort", sort }]] as const) {
      const rr = await rest("GET", `/v1/thoughts?limit=1&sort=${s2}&after=${encodeURIComponent(after)}`);
      const mm = await mcp("list_thoughts", { limit: 1, sort: s2, after });
      const refusal = { code: "REFUSED_CURSOR" as const, retryable: false as const, value: after, ...facts };
      const said = say.renderListThoughts({ ok: false, refusal } as never);
      assert(rr.status === 400 && rr.body.code === "REFUSED_CURSOR" && same({ reason: rr.body.reason, sort: rr.body.sort }, { reason: facts.reason, sort: "sort" in facts ? facts.sort : undefined }) && !JSON.stringify(rr.body).includes(after.slice(0, 20)),
        `list_thoughts ${sort}, ${why}: REST refuses it 400 REFUSED_CURSOR with its reason${"sort" in facts ? " and the sort it was made under" : ""}, never echoing it (${rr.status} ${String(rr.body.code)} ${String(rr.body.reason)})`);
      assert(mm.isError && mm.text === said.content[0].text, `…and MCP words that refusal as render.ts does (${mm.text.slice(0, 70)})`);
    }
  }
  // An empty or blank `after` is no cursor, refused as list_thought_ids refuses one, never the first page again: a client
  // templating `after=${cursor ?? ""}` would read page one forever (review pass 3).
  for (const blank of ["", "  "]) {
    const rr = await rest("GET", `/v1/thoughts?limit=1&after=${encodeURIComponent(blank)}`);
    const mm = await mcp("list_thoughts", { limit: 1, after: blank });
    assert(rr.status === 400 && rr.body.code === "REFUSED_CURSOR" && rr.body.reason === "shape" && mm.isError, `list_thoughts after=${JSON.stringify(blank)}: refused through both doors, not the first page (${rr.status} ${String(rr.body.code)}, ${mm.isError})`);
  }
  // An `after` past the cursor's 512 characters is the schema's refusal at every door, never a request too large for the
  // REST core to read: through the MCP server it was a 431 and a fault (review pass 4).
  {
    const long = "A".repeat(513);
    const rr = await rest("GET", `/v1/thoughts?limit=1&after=${long}`);
    const mm = await mcp("list_thoughts", { limit: 1, after: long });
    assert(rr.status === 400 && rr.body.code === "REFUSED_INPUT" && mm.isError && !mm.text.includes(long.slice(0, 64)), `list_thoughts after of 513 characters: the schema's refusal through both doors, not echoed (${rr.status} ${String(rr.body.code)}, ${mm.isError})`);
  }
  // SMD-3248 review pass 1: a judge_key holding a space — a `+` a query string decodes as one, or a newline that would
  // reach the headline — is the schema's refusal through both doors, naming %2B, where it selected nothing without a word.
  {
    const rr = await rest("GET", "/v1/proposals?judge_key=consolidate:h2o-lightning-4b+qwen3.8:27b@p4d3");
    const mm = await mcp("list_supersession_proposals", { judge_key: "consolidate:stub@p2\nID: 00000000-0000-4000-8000-000000000000" });
    const ok2 = await rest("GET", `/v1/proposals?judge_key=${encodeURIComponent("consolidate:h2o-lightning-4b+qwen3.8:27b@p4d3")}`);
    // Review pass 3: and none a shell reads — a key offered for pasting ran `$(…)` in the operator's shell.
    const shell = await rest("GET", `/v1/proposals?judge_key=${encodeURIComponent("consolidate:m@p1$(id)")}`);
    const shellM = await mcp("list_supersession_proposals", { judge_key: "consolidate:m@p2;id" });
    // …each saying the rule in the same words through both doors (review pass 4: only the %2B and isError were checked).
    const RULE = "judge_key is a pass key: 1-200 letters, digits and . _ : / @ + -, starting with a letter or digit (in a URL's query, encode + as %2B)";
    assert(rr.status === 400 && rr.body.code === "REFUSED_INPUT" && JSON.stringify(rr.body).includes(RULE) && mm.isError && mm.text.includes(RULE) && ok2.status === 200 && shell.status === 400 && shellM.isError && shellM.text.includes(RULE),
      `judge_key with an unencoded + (a space once decoded), a newline, or a character a shell reads: refused through both doors, naming %2B; encoded, answered (${rr.status} ${String(rr.body.code)}, ${mm.isError}, ${ok2.status}, ${shell.status}, ${shellM.isError})`);
  }
  // SMD-3249: the proposals cursor through both doors — page one's cursor lists page two the same way through REST and
  // MCP (text and structuredContent), and one that is none of this listing's is refused alike: REST's 400
  // REFUSED_CURSOR, the tool's refusal.
  {
    const p1 = await rest("GET", "/v1/proposals?status=all&limit=1");
    const cur = String(p1.body.cursor);
    const r2 = await rest("GET", `/v1/proposals?status=all&limit=1&after=${encodeURIComponent(cur)}`);
    const m2 = await mcp("list_supersession_proposals", { status: "all", limit: 1, after: cur });
    const out2 = rendered((v) => say.renderSupersessionProposals(ok(v as never)), r2.body);
    const badR = await rest("GET", "/v1/proposals?after=not-a-cursor");
    const badM = await mcp("list_supersession_proposals", { after: "not-a-cursor" });
    assert(p1.status === 200 && typeof p1.body.cursor === "string" && r2.status === 200 && out2.content[0].text === m2.text && same(out2.structuredContent, m2.sc)
        && badR.status === 400 && badR.body.code === "REFUSED_CURSOR" && badM.isError,
      `proposals' page two by page one's cursor, the same through REST and MCP; a cursor none of this listing's refused alike (${r2.status}, ${badR.status} ${String(badR.body.code)}, ${badM.isError})`);
    // Review pass 1: a cursor passed with other filters — here pending, page one's being all — refused alike, the
    // filters it was made under in REST's body and the tool's value.
    const selR = await rest("GET", `/v1/proposals?limit=1&after=${encodeURIComponent(cur)}`);
    const selM = await mcp("list_supersession_proposals", { limit: 1, after: cur });
    const made = { status: "all", lineage: null, judgeKey: null };
    assert(selR.status === 400 && selR.body.code === "REFUSED_CURSOR" && selR.body.reason === "filters" && same(selR.body.made, made)
        && selM.isError && selM.sc?.reason === "filters" && same(selM.sc?.made, made) && selM.text.startsWith("Refused: that cursor was made with `status: all` and no other filter"),
      `a cursor passed with other filters: REST's 400 REFUSED_CURSOR and the tool's refusal, each naming the filters it was made under (${selR.status} ${String(selR.body.reason)}, ${selM.text.slice(0, 80)})`);
  }
  // A limit is a whole number of thoughts, 1 to 1000: 0, -1, 1.5 and 1001 are the schema's refusal, not an empty page (review pass 1).
  // A `days` past a thousand years is the schema's refusal (review pass 2: a larger one put `since` past timestamptz's
  // range, a 500); below the schema, the store keeps such a cast error from reading as the cursor's (test-store-sql [4b]).
  {
    const first = await rest("GET", "/v1/thoughts?limit=1");
    const r = await rest("GET", `/v1/thoughts?limit=1&days=1000000&after=${encodeURIComponent(String(first.body.cursor))}`);
    assert(r.status === 400 && r.body.code === "REFUSED_INPUT", `list_thoughts days=1000000 beside a cursor: REST's 400 REFUSED_INPUT, not REFUSED_CURSOR (${r.status} ${String(r.body.code)})`);
  }
  for (const bad of ["0", "-1", "1.5", "1001"]) {
    const r = await rest("GET", `/v1/thoughts?limit=${bad}`);
    assert(r.status === 400 && r.body.code === "REFUSED_INPUT", `list_thoughts limit=${bad}: REST's 400 REFUSED_INPUT (${r.status} ${String(r.body.code)})`);
  }
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
  // Each write through a core of this suite's own as well (`directly`), on a row of its own (review pass 2: a value
  // REST dropped from update_thought's answer passed the comparison of the REST answer with its own rendering).
  const cdo = await directly("capture_thought", { content: "delta: written in process", source: "rest-suite" });
  const cd = rendered((v) => say.renderCapture(ok(v)), swap(cdo.value as Record<string, unknown>, m.sc));
  const cWhole = shapeOf(JSON.parse(JSON.stringify(cdo.value ?? null))) as Record<string, unknown>;
  // A capture as the MCP server sends it, forwarded: REST answers a carrier the whole value (rest/app.ts), which is
  // what the MCP server words, so its shape is held too (review pass 6a·3: a field dropped there alone passed).
  const fwd = await rest("POST", "/v1/thoughts", { content: "delta: written through REST as the MCP server sends it", source: "rest-suite" }, KEYS.writer, KEYS.forwarder);
  const { embeddingAttached: _fwdAttached, ...forwarded } = fwd.body;
  assert(fwd.status === 201 && same(shapeOf(forwarded), cWhole), `capture_thought forwarded: the REST answer is the core's value's whole shape (${fwd.status}; ${firstDiff(shapeOf(forwarded) as Record<string, unknown>, cWhole)})`);
  assert(cdo.ok && cd.content[0].text === m.text && same(cd.structuredContent, m.sc) && same(shapeOf(captured), cWhole),
    `capture_thought: …and a core of this suite's own says the same, the REST answer its value's whole shape (${cdo.ok ? `${firstDiff(cd.structuredContent, m.sc)} / ${firstDiff(shapeOf(captured) as Record<string, unknown>, cWhole)}` : "refused"})`);

  const u = await rest("PATCH", `/v1/thoughts/${ids[0]}`, { metadata_patch: { reviewed: true } });
  assert(u.body.id === ids[0] && typeof u.body.updatedAt === "string", `the REST update answers the thought it changed (${u.body.id})`);
  const um = await mcp("update_thought", { id: ids[1], metadata_patch: { reviewed: true } });
  const ur = rendered((v) => say.renderUpdate(ok(v)), swap(u.body, um.sc));
  assert(u.status === 200 && ur.content[0].text === um.text && same(ur.structuredContent, um.sc), `update_thought: the same reply (${u.status}; first difference: ${firstDiff(ur.structuredContent, um.sc)})`);
  const udo = await directly("update_thought", { id: ids[2], metadata_patch: { reviewed: true } });
  const ud = rendered((v) => say.renderUpdate(ok(v)), swap(udo.value as Record<string, unknown>, um.sc));
  const uWhole = shapeOf(JSON.parse(JSON.stringify(udo.value ?? null))) as Record<string, unknown>;
  assert(udo.ok && ud.content[0].text === um.text && same(ud.structuredContent, um.sc) && same(shapeOf(u.body), uWhole),
    `update_thought: …and a core of this suite's own says the same, the REST answer its value's whole shape (${udo.ok ? `${firstDiff(ud.structuredContent, um.sc)} / ${firstDiff(shapeOf(u.body) as Record<string, unknown>, uWhole)}` : "refused"})`);

  // A patch naming a stamp key (SMD-2744): REST carries `kept` with the
  // values, MCP the keys and the note, one render of the other; an echo
  // carries none (review pass 1 of PR 2: nothing held REST's).
  const stampRest = String((await rest("POST", "/v1/thoughts", { content: "theta: a note REST relabels", source: "rest-suite" })).body.id);
  const stampMcp = String((await mcp("capture_thought", { content: "theta: a note MCP relabels", source: "rest-suite" })).sc.id);
  const k = await rest("PATCH", `/v1/thoughts/${stampRest}`, { metadata_patch: { trust: "ingested", topic: "theta" } });
  const km = await mcp("update_thought", { id: stampMcp, metadata_patch: { trust: "ingested", topic: "theta" } });
  const kr = rendered((v) => say.renderUpdate(ok(v)), swap(k.body, km.sc));
  const echo = await rest("PATCH", `/v1/thoughts/${stampRest}`, { metadata_patch: { trust: null, topic: "theta, again" } });
  assert(k.status === 200 && JSON.stringify(k.body.kept) === '[{"key":"trust","value":null,"present":false}]' && JSON.stringify(km.sc.kept) === '["trust"]'
      && kr.content[0].text === km.text && same(kr.structuredContent, km.sc) && echo.status === 200 && !("kept" in echo.body),
    `a stamp-key patch: REST's kept with its values, MCP's the same reply; an echo none (${JSON.stringify(k.body.kept)} | first difference: ${firstDiff(kr.structuredContent, km.sc)})`);

  const doomedRest = String(r.body.id), doomedMcp = String(m.sc.id);
  const d = await rest("DELETE", `/v1/thoughts/${doomedRest}`);
  assert(d.body.id === doomedRest && (await rest("GET", `/v1/thoughts/${doomedRest}`)).status === 404, "the REST delete answers the thought it removed, and it is gone");
  const dm = await mcp("delete_thought", { id: doomedMcp });
  const dr = rendered((v) => say.renderDelete(ok(v)), swap(d.body, dm.sc));
  assert(d.status === 200 && dr.content[0].text === dm.text && same(dr.structuredContent, dm.sc), `delete_thought: the same reply (${d.status}; first difference: ${firstDiff(dr.structuredContent, dm.sc)})`);
  const doomedDirect = String(cdo.value && (cdo.value as { id?: unknown }).id);
  const ddo = await directly("delete_thought", { id: doomedDirect });
  const dd = rendered((v) => say.renderDelete(ok(v)), swap(ddo.value as Record<string, unknown>, dm.sc));
  const dWhole = shapeOf(JSON.parse(JSON.stringify(ddo.value ?? null))) as Record<string, unknown>;
  assert(ddo.ok && dd.content[0].text === dm.text && same(dd.structuredContent, dm.sc) && same(shapeOf(d.body), dWhole),
    `delete_thought: …and a core of this suite's own says the same, the REST answer its value's whole shape (${ddo.ok ? `${firstDiff(dd.structuredContent, dm.sc)} / ${firstDiff(shapeOf(d.body) as Record<string, unknown>, dWhole)}` : "refused"})`);

  // reset_capture_stamp (SMD-2744): the operator's alone, so the writer is
  // classified for it here and unclassified after. Each door resets the
  // hook's own row, which nothing settled: the same "nothing to reset".
  await sql`SELECT set_agent_kind('writer', 'operator')`;
  const hookRest = await rest("POST", "/v1/thoughts", { content: "omega: the hook's outside text, for REST's reset", trust: "ingested" }, KEYS.hook);
  const hookMcp = await rest("POST", "/v1/thoughts", { content: "omega: the hook's outside text, for MCP's reset", trust: "ingested" }, KEYS.hook);
  const rs = await rest("POST", `/v1/thoughts/${hookRest.body.id}/reset-capture-stamp`, {});
  const rsm = await mcp("reset_capture_stamp", { id: String(hookMcp.body.id) });
  const rsr = rendered((v) => say.renderResetCaptureStamp(ok(v)), swap(rs.body, rsm.sc));
  // Its refusals at their statuses, as numbers — [5] reads the status table
  // against itself, which a swapped entry passes (review pass 1).
  const ownRow = await rest("POST", `/v1/thoughts/${ids[0]}/reset-capture-stamp`, {});
  const noRow = await rest("POST", "/v1/thoughts/00000000-0000-4000-8000-0000000027a4/reset-capture-stamp", {});
  // What a re-capture did to the hook's label (090, SMD-2898), while the
  // writer is the operator: REST's body carries the label, the MCP tool's
  // structured content its outcome and its text the note.
  const liftRest = "omega: the hook's outside text the writer lifts through REST", liftMcp = "omega: the hook's outside text the writer lifts through MCP";
  await rest("POST", "/v1/thoughts", { content: liftRest, trust: "ingested" }, KEYS.hook);
  await rest("POST", "/v1/thoughts", { content: liftMcp, trust: "ingested" }, KEYS.hook);
  const lifted = await rest("POST", "/v1/thoughts", { content: liftRest });
  const liftedMcp = await mcp("capture_thought", { content: liftMcp });
  const liftedLabel = lifted.body.label as { outcome?: string; stamp?: { actorName?: string; trust?: string }; before?: { trust?: string } } | undefined;
  assert(lifted.body.existed === true && liftedLabel?.outcome === "moved" && liftedLabel.stamp?.actorName === "writer" && liftedLabel.stamp?.trust === "operator" && liftedLabel.before?.trust === "ingested"
      && liftedMcp.sc.label === "moved" && /Its label moved to your key: writer — kind operator, trust operator\./.test(liftedMcp.text),
    `a re-capture over the hook's label: REST's body carries the label, the MCP tool its outcome and the note (${JSON.stringify(liftedLabel)} | ${liftedMcp.sc.label})`);
  await sql`UPDATE ob1_agents SET kind = NULL WHERE label = 'writer'`;
  const notOperator = await rest("POST", `/v1/thoughts/${hookRest.body.id}/reset-capture-stamp`, {});
  assert(ownRow.status === 409 && ownRow.body.code === "REFUSED_NOT_CAPTURE_STAMP" && noRow.status === 404 && noRow.body.code === "NOT_FOUND"
      && notOperator.status === 403 && notOperator.body.code === "REFUSED_NOT_OPERATOR",
    `reset_capture_stamp's refusals: another key's row 409, no row 404, a key not the operator 403 (${ownRow.status} ${noRow.status} ${notOperator.status})`);
  assert(rs.status === 200 && rs.body.reset === false && rsr.content[0].text === rsm.text && same(rsr.structuredContent, rsm.sc),
    `reset_capture_stamp: the same reply (${rs.status} ${JSON.stringify(rs.body).slice(0, 90)}; first difference: ${firstDiff(rsr.structuredContent, rsm.sc)})`);

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
    // The writer is unclassified: the database refuses it the reset (SMD-2744).
    ["reset_capture_stamp", { id: ids[0] }, "POST", `/v1/thoughts/${ids[0]}/reset-capture-stamp`, {}],
    ["reset_capture_stamp", { id: "not-a-uuid" }, "POST", "/v1/thoughts/not-a-uuid/reset-capture-stamp", {}],
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

  // Carried by the forwarder (SMD-2287): the REST answer holds the refusal
  // whole beside its facts, and render.ts makes of it exactly the MCP reply,
  // text and structuredContent — the words the facts leave out included (the
  // filter's message, the value quoted back, the key's kind) — so the MCP
  // server as a REST client says every refusal as server-portable does.
  const renderOf: Record<string, (o: never) => say.Reply> = {
    fetch: say.renderFetch, thought_changes: say.renderThoughtChanges, list_thought_ids: say.renderThoughtIds, list_logged_searches: say.renderLoggedSearches,
    search_thoughts: (o) => say.renderSearchThoughts(o, false), capture_thought: say.renderCapture, update_thought: say.renderUpdate, delete_thought: say.renderDelete,
    reset_capture_stamp: say.renderResetCaptureStamp, retry_failed: say.renderRetryFailed, release_stale_leases: say.renderReleaseStaleLeases, run_worker: say.renderRunWorker,
  };
  // A capture-only key's refusals too (review pass 1), the words its facts
  // leave out included — the value quoted back, a malformed key named — as
  // the MCP reply says them to that key. (Its missing `derived_from` ids are
  // trimmed before the write, not refused: the existence-oracle rule.)
  const hookCases: [tool: string, args: Record<string, unknown>, method: string, path: string, body: unknown, key: string][] = [
    ["capture_thought", { content: "lambda", supersedes: "not-an-id" }, "POST", "/v1/thoughts", { content: "lambda", supersedes: "not-an-id" }, KEYS.hook],
    ["capture_thought", { content: "lambda", metadata: { "Bad Key": 1 } }, "POST", "/v1/thoughts", { content: "lambda", metadata: { "Bad Key": 1 } }, KEYS.hook],
    ["capture_thought", { content: "lambda", metadata: { status: "done" } }, "POST", "/v1/thoughts", { content: "lambda", metadata: { status: "done" } }, KEYS.hook],
  ];
  for (const [tool, args, method, path, body, key] of [...cases.map((c) => [...c, KEYS.writer] as const), ...withFacts.map(([t, a, m, p, b]) => [t, a, m, p, b, KEYS.writer] as const), ...hookCases]) {
    const r = await rest(method, path, body, key, KEYS.forwarder);
    const m = await mcp(tool, args, key);
    const { refusal, ...facts } = r.body;
    const out = rendered(renderOf[tool], { ok: false, refusal });
    const { text: _text, ...mcpFacts } = m.sc;
    const who = key === KEYS.hook ? " (a capture-only key)" : "";
    assert(refusal !== undefined && same(facts, mcpFacts), `${tool} ${r.body.code}${who}, forwarded: its facts as before, the refusal whole beside them (${JSON.stringify(refusal)?.slice(0, 100)})`);
    assert(out.content[0].text === m.text && same(out.structuredContent, m.sc) && out.isError === m.isError,
      `…and render.ts makes of it the MCP reply (${out.content[0].text === m.text ? "same text" : `REST→ ${out.content[0].text.slice(0, 80)} | MCP ${m.text.slice(0, 80)}`}; first difference: ${firstDiff(out.structuredContent, m.sc)})`);
  }
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
  // A ticket's lifecycle key is refused a capture key at this door too, the
  // key named in the value (SMD-2617); a write key states it.
  const forged = await rest("POST", "/v1/thoughts", { content: "eta: a capture key's ticket claim", metadata: { status_type: "completed" } }, KEYS.hook);
  assert(forged.status === 400 && forged.body.code === "REFUSED_METADATA_SHAPE" && forged.body.problem === "ticket_key" && forged.body.key === "status_type",
    `a capture key's ticket key is a 400 naming the rule and the key (${forged.status} ${JSON.stringify(forged.body)})`);
  // …`ticket` among them, which files a thought under a ticket (SMD-2657).
  const filed = await rest("POST", "/v1/thoughts", { content: "eta: a capture key's note filed under a ticket", metadata: { ticket: "TKT-2657" } }, KEYS.hook);
  assert(filed.status === 400 && filed.body.code === "REFUSED_METADATA_SHAPE" && filed.body.problem === "ticket_key" && filed.body.key === "ticket",
    `…and so is its \`ticket\` (${filed.status} ${JSON.stringify(filed.body)})`);
  const stated = await rest("POST", "/v1/thoughts", { content: "eta: a write key's ticket row", metadata: { issue: "TKT-2617", status_type: "started" } }, KEYS.writer);
  assert(stated.status === 201, `…and a write key's is a creation (${stated.status})`);
  // The key is in the value unless it is itself malformed: a reserved key's
  // and an over-long value's are, a badly shaped key (the caller's raw input) is not.
  const reserved = await rest("POST", "/v1/thoughts", { content: "eta: a reserved key", metadata: { type: "task" } }, KEYS.writer);
  const badKey = await rest("POST", "/v1/thoughts", { content: "eta: a badly shaped key", metadata: { "Bad Key": 1 } }, KEYS.writer);
  const longValue = await rest("POST", "/v1/thoughts", { content: "eta: an over-long value", metadata: { long_note: "x".repeat(201) } }, KEYS.writer);
  assert(reserved.status === 400 && reserved.body.problem === "reserved_key" && reserved.body.key === "type" && badKey.status === 400 && badKey.body.problem === "bad_key" && !("key" in badKey.body)
      && longValue.status === 400 && longValue.body.problem === "value_too_long" && longValue.body.key === "long_note",
    `a reserved key's and an over-long value's refusals name the key; a bad key's carries the rule alone (${JSON.stringify(reserved.body)} | ${JSON.stringify(badKey.body)} | ${JSON.stringify(longValue.body)})`);
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

console.log("\n[6b] Forwarded through REST: the client's key is the subject, the forwarder recorded as act on the audit row, registered with no scope; a revoked or wrong forwarder refused (SMD-2284)");
{
  const forwarded = async (method: string, path: string, key: string, carrier: string, body?: unknown): Promise<Answer> => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { "x-brain-key": key, "x-brain-forwarder": carrier, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown>, headers: r.headers };
  };
  const agentOf = async (label: string) => (await sql`SELECT canonical_agent_id::text AS id FROM ob1_agents WHERE label = ${label}`)[0]?.id as string | undefined;
  type Row = { actor_name: string; canonical_agent_id: string | null; origin: string; act: { name?: string; agent_id?: string } | null };
  const auditOf = async (id: string, action: string) =>
    (await sql`SELECT actor_name, canonical_agent_id::text AS canonical_agent_id, origin, actor_context->'act' AS act FROM thought_audit WHERE thought_id = ${id}::uuid AND action = ${action} ORDER BY id DESC LIMIT 1`)[0] as Row | undefined;

  const cap = await forwarded("POST", "/v1/thoughts", KEYS.hook, KEYS.forwarder, { content: "iota: a hook's thought, carried by the MCP server" });
  assert(cap.status === 201 && typeof cap.body.id === "string", `a capture key forwarded captures (${cap.status} ${JSON.stringify(cap.body).slice(0, 80)})`);
  // …as the capture key it is: refused the ticket keys (SMD-2617).
  const capTicket = await forwarded("POST", "/v1/thoughts", KEYS.hook, KEYS.forwarder, { content: "iota: a forwarded ticket claim", metadata: { status_type: "completed" } });
  assert(capTicket.status === 400 && capTicket.body.problem === "ticket_key" && capTicket.body.key === "status_type",
    `…and is refused a ticket key, as the capture key it carries (${capTicket.status} ${JSON.stringify(capTicket.body)})`);
  const fwdId = await agentOf("mcp-forwarder");
  const capRow = await auditOf(String(cap.body.id), "capture");
  assert(capRow?.actor_name === "hook" && capRow?.canonical_agent_id === (await agentOf("hook")) && capRow?.origin === "open-brain-api",
    `the audit row's subject is the client's key and its door the REST core (${JSON.stringify(capRow)})`);
  assert(typeof fwdId === "string" && same(capRow?.act, { name: "mcp-forwarder", agent_id: fwdId }), `…and its act the forwarder, by name and agent id (${JSON.stringify(capRow?.act)})`);
  const [fwdKey] = await sql`SELECT scope FROM ob1_agent_keys WHERE key_hash = ${hashKey(KEYS.forwarder)}`;
  assert(fwdKey !== undefined && fwdKey.scope === null, `the forwarder is registered with no scope recorded — 049's CHECK holds none for it (${JSON.stringify(fwdKey)})`);
  const edit = await forwarded("PATCH", `/v1/thoughts/${cap.body.id}`, KEYS.writer, KEYS.forwarder, { content: "iota: a hook's thought, carried and then edited" });
  const editRow = await auditOf(String(cap.body.id), "update");
  assert(edit.status === 200 && editRow?.actor_name === "writer" && same(editRow?.act, { name: "mcp-forwarder", agent_id: fwdId }), `a forwarded edit records the forwarder as act too (${edit.status} ${JSON.stringify(editRow)})`);
  const del = await forwarded("DELETE", `/v1/thoughts/${cap.body.id}`, KEYS.writer, KEYS.forwarder);
  const delRow = await auditOf(String(cap.body.id), "delete");
  assert(del.status === 200 && delRow?.actor_name === "writer" && same(delRow?.act, { name: "mcp-forwarder", agent_id: fwdId }), `a forwarded delete records the forwarder as act too (${del.status} ${JSON.stringify(delRow)})`);
  const direct = await rest("POST", "/v1/thoughts", { content: "kappa: a hook's thought, not forwarded" }, KEYS.hook);
  const directRow = await auditOf(String(direct.body.id), "capture");
  assert(direct.status === 201 && directRow?.act === null, `a write not forwarded records no act (${JSON.stringify(directRow)})`);
  const who = await forwarded("GET", "/v1/whoami", KEYS.reader, KEYS.forwarder);
  assert(who.status === 200 && who.body.name === "reader" && same(who.body.act, { name: "mcp-forwarder", agentId: fwdId }), `whoami, forwarded, names the act (${JSON.stringify(who.body).slice(0, 140)})`);
  const read = await forwarded("GET", "/v1/stats", KEYS.hook, KEYS.forwarder);
  assert(read.status === 403 && read.body.code === "FORBIDDEN", `the forwarder widens nothing: a capture key forwarded still cannot read (${read.status})`);

  const before = Number((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c);
  const wrong = await forwarded("POST", "/v1/thoughts", KEYS.hook, KEYS.reader, { content: "lambda: carried by a client's key" });
  assert(wrong.status === 401 && wrong.body.code === "UNAUTHORIZED" && wrong.body.credential === "forwarder", `a client's key in the forwarder slot → 401, credential forwarder (${JSON.stringify(wrong.body)})`);
  const fresh = await forwarded("GET", "/v1/whoami", KEYS.fresh, "not-a-forwarder");
  const [freshRow] = await sql`SELECT count(*)::int AS c FROM ob1_agent_keys WHERE key_hash = ${hashKey(KEYS.fresh)}`;
  assert(fresh.status === 401 && fresh.body.credential === "forwarder" && Number(freshRow.c) === 0, `a never-seen caller refused for its forwarder is not registered: the forwarder is checked before either key reaches the registry (${fresh.status}, ${freshRow.c} row)`);
  assert((await forwarded("GET", "/v1/whoami", KEYS.reader, KEYS.forwarderGone)).status === 200, "the forwarder to be revoked carries first");
  await sql`SELECT revoke_agent_key(${hashKey(KEYS.forwarderGone)}, ${"rest suite"})`;
  const revoked = await forwarded("POST", "/v1/thoughts", KEYS.hook, KEYS.forwarderGone, { content: "mu: carried by a revoked forwarder" });
  assert(revoked.status === 401 && revoked.body.code === "REVOKED" && revoked.body.credential === "forwarder", `a revoked forwarder → 401 REVOKED, credential forwarder (${JSON.stringify(revoked.body)})`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c) === before, "…and neither refused request wrote a thought");
}

console.log("\n[6c] The authorization server's token through REST (SMD-2286, SMD-3064): a principal per client, oauth:<sub>+<client>, an exchanged token's act on the audit row, the registry's row with no scope, a trust per client, a read token refused a capture, one client revoked alone");
{
  // The REST core of api.ts over this store, given a token check over a key set this suite signs with (a deploy reads the authorization server's on the mesh).
  const settings = tokenSettings({ COMPOSE_PROFILES: "auth", OB1_PUBLIC_ORIGIN: "https://brain.example.test" })!;
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "ob1-suite", alg: "ES256", use: "sig" }] };
  const tokenApi = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (await import("./api.ts")).restApp(() => {}, () => checkerOver(settings, createLocalJWKSet(jwks))).fetch });
  // A token as the authorization server signs one: the GUI's own (client_id gui); one the MCP service exchanged for
  // a connector (client_id mcp, the connector nested in act); a service's, whose subject is its client id.
  const mint = (scope: string, as: { gui: true } | { connector: string } | { service: string }) => {
    const claims = "gui" in as ? { client_id: "gui" } : "connector" in as ? { client_id: "mcp", act: { sub: "mcp", act: { sub: as.connector } } } : { client_id: as.service };
    return new SignJWT({ scope, ...claims }).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "ob1-suite" })
      .setIssuer(settings.issuer).setAudience(settings.audience).setSubject("service" in as ? as.service : "operator").setIssuedAt().setExpirationTime("10m").sign(privateKey);
  };
  const asToken = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${tokenApi.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const audited = async (id: unknown) => (await sql`SELECT actor_name, actor_kind, trust, canonical_agent_id::text AS agent, origin, actor_context->'act' AS act FROM thought_audit WHERE thought_id = ${String(id)}::uuid AND action = 'capture'`)[0];
  // Classified before their first request, as an operator may (set_agent_kind upserts by label): connector A an agent, the GUI the operator. Connector B is left unclassified.
  await sql`SELECT set_agent_kind(${"oauth:operator+connector-a"}, ${"agent"}), set_agent_kind(${"oauth:operator+gui"}, ${"operator"})`;
  const caps: Record<string, { status: number; body: Record<string, unknown> }> = {};
  for (const [who, as] of [["a", { connector: "connector-a" }], ["b", { connector: "connector-b" }], ["gui", { gui: true }]] as const) {
    caps[who] = await asToken("POST", "/v1/thoughts", await mint("brain:write", as), { content: `lambda: captured through ${who}` });
  }
  assert(Object.values(caps).every((c) => c.status === 201 && typeof c.body.id === "string"), `two connectors' exchanged write tokens and the GUI's capture (${Object.values(caps).map((c) => c.status).join(" ")})`);
  const [ra, rb, rg] = [await audited(caps.a.body.id), await audited(caps.b.body.id), await audited(caps.gui.body.id)];
  const agents: { label: string; id: string; scope: string | null }[] = await sql`SELECT a.label, a.canonical_agent_id::text AS id, k.scope FROM ob1_agents a JOIN ob1_agent_keys k ON k.canonical_agent_id = a.canonical_agent_id WHERE a.label LIKE 'oauth:operator%' ORDER BY a.label`;
  const idOf = (label: string) => agents.find((x) => x.label === label)?.id;
  assert(ra?.actor_name === "oauth:operator+connector-a" && rb?.actor_name === "oauth:operator+connector-b" && rg?.actor_name === "oauth:operator+gui",
    `Verify 1: each audit row names its own client — the two connectors and the GUI (${ra?.actor_name}, ${rb?.actor_name}, ${rg?.actor_name})`);
  assert(ra?.agent === idOf("oauth:operator+connector-a") && rb?.agent === idOf("oauth:operator+connector-b") && rg?.agent === idOf("oauth:operator+gui") && new Set([ra?.agent, rb?.agent, rg?.agent]).size === 3 && ra?.origin === "open-brain-api",
    `…each its own registry row, its agent the registry's for its label, its door the REST core (${JSON.stringify(agents.map((x) => x.label))})`);
  assert(!agents.some((x) => x.label === "oauth:operator"), "…and no one row for the subject alone");
  assert(same(ra?.act, { name: "oauth:mcp" }) && same(rb?.act, { name: "oauth:mcp" }) && rg?.act === null, `a connector's act is the MCP service that carried it, from the token's signed act, by name alone; the GUI's own token has none (${JSON.stringify([ra?.act, rb?.act, rg?.act])})`);
  assert(ra?.actor_kind === "agent" && ra?.trust === "agent" && rg?.actor_kind === "operator" && rg?.trust === "operator" && rb?.actor_kind === null,
    `Verify 3: the connector classified agent writes at agent trust while the GUI writes at operator trust; the unclassified one is unknown (${JSON.stringify([ra?.actor_kind, ra?.trust, rg?.actor_kind, rg?.trust, rb?.actor_kind])})`);
  assert(agents.every((x) => x.scope === null), `the registry records no scope for an oauth: principal, whatever its tokens hold (${JSON.stringify(agents.map((x) => x.scope))})`);
  const read = await mint("brain:read", { connector: "connector-a" });
  const readCap = await asToken("POST", "/v1/thoughts", read, { content: "lambda: a read token may not capture" });
  assert(readCap.status === 403 && readCap.body.needs === "capture", `a read token cannot capture (${readCap.status} ${JSON.stringify(readCap.body)})`);
  const [still] = await sql`SELECT scope FROM ob1_agent_keys WHERE key_hash = ${subjectHash(settings.issuer, "operator", "connector-a")}`;
  assert(still?.scope === null, `…and a token of another scope from the same client leaves the row's scope as it was (${JSON.stringify(still)})`);
  const direct = await asToken("POST", "/v1/thoughts", await mint("brain:capture", { service: "runner" }), { content: "lambda: a service's capture" });
  const svc = await audited(direct.body.id);
  assert(direct.status === 201 && svc?.actor_name === "oauth:runner" && svc?.act === null, `a service's client-credentials token: its subject alone, oauth:runner, no act (${direct.status} ${JSON.stringify(svc)})`);
  await sql`SELECT revoke_agent_key(${subjectHash(settings.issuer, "operator", "connector-a")}, ${"rest suite"})`;
  const revoked = await asToken("GET", "/v1/whoami", await mint("brain:write", { connector: "connector-a" }));
  assert(revoked.status === 401 && revoked.body.code === "REVOKED" && revoked.body.credential === "token", `connector A revoked in the registry: its next token 401 REVOKED, credential token (${revoked.status} ${JSON.stringify(revoked.body)})`);
  const [other, gui] = [await asToken("GET", "/v1/whoami", await mint("brain:write", { connector: "connector-b" })), await asToken("GET", "/v1/whoami", await mint("brain:write", { gui: true }))];
  assert(other.status === 200 && other.body.name === "oauth:operator+connector-b" && gui.status === 200 && gui.body.name === "oauth:operator+gui",
    `…while connector B and the GUI, signed in as the same operator, go on (${other.status} ${gui.status})`);
  tokenApi.stop(true);
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
  const api = lines.filter((l) => l.startsWith('{"ts":') && (JSON.parse(l) as { door?: string }).door === "api");
  assert(api.length === 4, `four requests, four lines (${api.length}: ${api.join(" / ")})`);
  const all = lines.join("\n");
  for (const s of ["private words", ids[2], "trace=1", "someone-named", "must not be logged", KEYS.writer]) assert(!all.includes(s), `no ${s.slice(0, 20)} in the log`);
}

console.log("\n[9] `bun api.ts` as the entry wires the durable job store for the REST core: its own job left running is reconciled to lost, another door's is left alone (the retired MCP server's is test-e2e-sql [18]'s), and a job it starts is recorded as its own (migration 078, SMD-2284)");
{
  const mine = crypto.randomUUID(), theirs = crypto.randomUUID();
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, started_at, door) VALUES (${mine}::uuid, 'scan_thoughts', ${hashKey(KEYS.reader)}, 'reader', 'running', now(), 'open-brain-api')`;
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, started_at, door) VALUES (${theirs}::uuid, 'scan_thoughts', ${hashKey(KEYS.reader)}, 'reader', 'running', now(), 'open-brain-elsewhere')`;
  // PORT 0: the child binds a port no one holds and says which (SMD-3296).
  const child = Bun.spawn([process.execPath, "api.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: "0", OB1_LISTEN_HOST: "127.0.0.1" },
    stdout: "pipe", stderr: "pipe",
  });
  const { port } = await childPort(child, 20_000);
  const status = async (id: string) => String((await sql`SELECT status FROM jobs WHERE id = ${id}::uuid`)[0]?.status);
  let mineStatus = "running";
  try {
    const deadline = Date.now() + 15_000;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      // Keyless liveness reads no store: the reconcile is the start-up's (review pass 1).
      answered = await realFetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
      if (!answered) await Bun.sleep(100);
    }
    assert(answered, "the REST core answers its keyless /health as Bun's entry, which builds no store");
    while (mineStatus === "running" && Date.now() < deadline) {
      mineStatus = await status(mine);
      if (mineStatus === "running") await Bun.sleep(100);
    }
    assert(mineStatus === "lost", `the REST core's own job left running is reconciled to lost at start-up, before any keyed request (${mineStatus})`);
    assert((await status(theirs)) === "running", "…and a live job of a door it does not name, on the same database, is not");
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
