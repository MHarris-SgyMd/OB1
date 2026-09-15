#!/usr/bin/env bun
/**
 * test-auth.ts — every vendored server authenticates through the core server's
 * auth path: the seven extension servers (SMD-1252, FORK.md change 64) and the
 * recipes and integrations that compared a key the same way — six more MCP
 * servers, two HTTP APIs, four workers and a webhook receiver (SMD-1455,
 * change 65).
 *
 * The claim is the one server-portable/test-auth.ts makes for the core server,
 * made here for each vendored server as it is deployed: a wrong key is refused;
 * a key removed from MCP_ACCESS_KEYS stops working while its neighbour keeps
 * working; the hash is not a credential; the legacy single key still
 * authenticates, by digest now; and a read-scoped key does not merely fail to
 * write. For an MCP server the tools that write are not registered for it, so
 * they are absent from tools/list and a call names a tool that does not exist;
 * for an HTTP API the routes that write answer 403 before they parse a body;
 * for a worker anything but a dry run answers 403. The webhook receiver's
 * secret has no scope to give and is compared digest to digest. Then the drift
 * guards: every tool a file registers and every route an API mounts is
 * classified here as a read or a write, exactly the writes are gated, each
 * write does write and each read does not, the key is read through the shared
 * module and nowhere else, every `_shared/auth.ts` is byte-for-byte
 * server-portable/auth.ts (a Supabase function is bundled from
 * supabase/functions/, so the module is copied beside the servers rather than
 * imported across the tree), and each deno.json still pins what package.json
 * installs.
 *
 * The files are imported under a stand-in for the two Deno globals they use —
 * `Deno.env.get` hands the process environment through, `Deno.serve` captures
 * the fetch handler instead of listening — and, for the recipes and
 * integrations, under a loader that reads their Deno specifiers on Bun: a
 * `jsr:` type-only import is dropped, `npm:pkg@version` becomes `pkg`, the
 * Deno postgres driver becomes a stub that never connects, and a bare package
 * name resolves from this directory's install, since theirs is a deno.json.
 * No database: nothing here reaches a handler that queries with a key that
 * would let it, or the client refuses at once (a port nothing listens on) —
 * the SQL shim and supabase-js both connect lazily, so a stub URL is never
 * dialled otherwise.
 *
 * Run: bun install && bun test-auth.ts   (in extensions/)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "./_shared/auth.ts";
import { createAssert } from "../db/test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// ── The stand-in for Deno ────────────────────────────────────────────────────

type Handler = (req: Request) => Response | Promise<Response>;
const served: Handler[] = [];
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: { get: (name: string) => process.env[name] },
  // `Deno.serve(handler)` and `Deno.serve({ port }, handler)` both capture the handler.
  serve: (a: Handler | object, b?: Handler) => { served.push(typeof a === "function" ? a : b!); return { finished: Promise.resolve() }; },
};

// ── Deno's specifiers, on Bun ────────────────────────────────────────────────

/** The packages this directory installs; the recipes' and integrations' deno.json pin the same names. */
const PACKAGES = /^(hono|zod|@hono\/mcp|@modelcontextprotocol\/sdk|@supabase\/supabase-js)(\/|$)/;
const PG_STUB = join(tmpdir(), "ob1-test-auth-deno-postgres-stub.ts");
await Bun.write(PG_STUB, "export class Pool { constructor(..._: unknown[]) {} connect(): never { throw new Error('the test never queries'); } }\n");
Bun.plugin({
  name: "deno-specifiers-on-bun",
  setup(build) {
    build.onLoad({ filter: /\/(recipes|integrations)\/.*\.ts$/ }, async (args) => {
      let src = await Bun.file(args.path).text();
      src = src.replace(/^import\s+"jsr:[^"]+";\s*$/gm, "");
      src = src.replace(/(from\s+|import\s+)"([^"]+)"/g, (whole, lead, spec) => {
        let s = spec as string;
        if (s.startsWith("npm:")) s = s.slice(4).replace(/^(@?[^@/]+(?:\/[^@/]+)?)@[^/]*/, "$1");
        if (s === "postgres") return `${lead}"${PG_STUB}"`;
        if (PACKAGES.test(s)) return `${lead}"${Bun.resolveSync(s, HERE)}"`;
        return whole;
      });
      return { contents: src, loader: "ts" };
    });
  },
});

// ── The servers, and what each tool or route does to the database ───────────

const WRITE_KEY = "w".repeat(64);
const READ_KEY = "r".repeat(64);
const LEGACY_KEY = "old-style-key";
const KEYS = [`laptop:write:${hashKey(WRITE_KEY)}`, `chatgpt:read:${hashKey(READ_KEY)}`].join(",");

type Kind = "mcp" | "rest" | "worker";
type Server = {
  /** Relative to the repository root. */
  file: string;
  kind: Kind;
  /** The env names this server reads its keys from (the shared server and the auditor have their own). */
  keys: string;
  legacy: string;
  /** What SUPABASE_URL must look like: the SQL shim wants postgres://, supabase-js an https:// URL. */
  url: string;
  /** The import that reaches the copy of server-portable/auth.ts beside the file. */
  shared: string;
  /** MCP: tool names. HTTP: "METHOD /path". A worker has one operation, gated by dry_run. */
  reads: string[];
  writes: string[];
  /** HTTP: a read route that answers before any query — proof a read key passes the gate. */
  readProbe?: string;
  /** Worker: where dry_run is said. */
  dryRun?: "query" | "body";
  /** An unauthenticated GET this server answers (a health probe), if any. */
  health?: string;
  /** What no configured key at all answers: 401, or the workers' 503 misconfigured. */
  unconfigured?: number;
};
const PG = "postgres://ob1:stub@stub.invalid:5432/ob1";
/** For a server whose handler queries before it can answer: refused at once, no name to resolve. */
const PG_REFUSED = "postgres://ob1:stub@127.0.0.1:1/ob1";
const HTTPS = "https://stub.invalid";
const ext = (file: string, reads: string[], writes: string[], o: Partial<Server> = {}): Server =>
  ({ file: `extensions/${file}`, kind: "mcp", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG, shared: "../_shared/auth.ts", reads, writes, ...o });
const vendored = (file: string, kind: Kind, reads: string[], writes: string[], o: Partial<Server> = {}): Server =>
  ({ file, kind, keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG, shared: "../_shared/auth.ts", reads, writes, ...o });
const SERVERS: Server[] = [
  // The seven extension servers (change 64).
  ext("family-calendar/index.ts", ["get_week_schedule", "search_activities", "get_upcoming_dates"],
    ["add_family_member", "add_activity", "add_important_date"], { url: HTTPS, health: "/" }),
  ext("home-maintenance/index.ts", ["get_upcoming_maintenance", "search_maintenance_history"],
    ["add_maintenance_task", "log_maintenance"]),
  ext("household-knowledge/index.ts", ["search_household_items", "get_item_details", "list_vendors"],
    ["add_household_item", "add_vendor"]),
  ext("job-hunt/index.ts", ["get_pipeline_overview", "get_upcoming_interviews", "search_job_contacts"],
    ["add_company", "add_job_posting", "add_job_contact", "submit_application", "schedule_interview",
     "log_interview_notes", "link_contact_to_professional_crm"], { url: HTTPS }),
  ext("meal-planning/index.ts", ["search_recipes", "get_meal_plan"],
    ["add_recipe", "update_recipe", "create_meal_plan", "generate_shopping_list"]),
  ext("professional-crm/index.ts", ["crm_search_contacts", "crm_get_contact_history", "crm_get_follow_ups", "crm_prep_context", "crm_stale_contacts"],
    ["crm_add_contact", "crm_log_interaction", "crm_create_opportunity", "crm_update_contact", "crm_link_thought"]),
  ext("meal-planning/shared-server.ts", ["view_meal_plan", "view_recipes", "view_shopping_list"], ["mark_item_purchased"],
    { keys: "MCP_HOUSEHOLD_ACCESS_KEYS", legacy: "MCP_HOUSEHOLD_ACCESS_KEY" }),
  // The recipes and integrations (change 65).
  vendored("recipes/edge-function-cost-optimization/examples/before/per-request-server.ts", "mcp", ["list_vendors"], [],
    { shared: "../../../_shared/auth.ts" }),
  vendored("recipes/ob-graph/index.ts", "mcp", ["search_nodes", "get_neighbors", "traverse_graph", "find_path", "list_edge_types"],
    ["create_node", "create_edge", "update_node", "delete_node", "delete_edge"], { url: HTTPS, health: "/health" }),
  vendored("recipes/work-operating-model-activation/index.ts", "mcp", ["query_operating_model"],
    ["start_operating_model_session", "save_operating_model_layer", "generate_operating_model_exports"], { health: "/health" }),
  vendored("integrations/delete-thought-mcp/index.ts", "mcp", [], ["delete_thought"]),
  vendored("integrations/update-thought-mcp/index.ts", "mcp", [], ["update_thought"]),
  vendored("integrations/kubernetes-deployment/index.ts", "mcp", ["search", "fetch", "search_thoughts", "list_thoughts", "thought_stats"], ["capture_thought"]),
  vendored("integrations/agent-memory-api/index.ts", "rest",
    ["GET /health", "POST /recall", "GET /memories/review", "GET /memories", "GET /memories/:id", "GET /recall-traces/:request_id"],
    ["POST /writeback", "POST /recall/:request_id/usage", "PATCH /memories/:id/review"], { url: HTTPS, readProbe: "POST /recall" }),
  vendored("integrations/open-brain-rest/index.ts", "rest",
    ["GET /health", "GET /stats", "GET /thoughts", "GET /thought/:id", "POST /search", "GET /duplicates", "GET /thought/:id/connections",
     "GET /thought/:id/reflection", "GET /ingestion-jobs", "GET /ingestion-jobs/:id", "POST /ingestion-jobs/:id/execute"],
    ["PUT /thought/:id", "DELETE /thought/:id", "POST /capture", "POST /thought/:id/reflection", "POST /ingest"],
    { url: PG_REFUSED, readProbe: "GET /health" }),
  vendored("recipes/editorial-policy/auditor/index.ts", "worker", [], [],
    { keys: "AUDITOR_ACCESS_KEYS", legacy: "AUDITOR_ACCESS_KEY", url: PG_REFUSED, shared: "../../_shared/auth.ts", dryRun: "body", unconfigured: 401 }),
  vendored("integrations/entity-extraction-worker/index.ts", "worker", [], [], { dryRun: "query", unconfigured: 503 }),
  vendored("integrations/consolidation-workers/bio/index.ts", "worker", [], [], { dryRun: "query", unconfigured: 503 }),
  vendored("integrations/consolidation-workers/metadata-norm/index.ts", "worker", [], [], { url: HTTPS, dryRun: "query", unconfigured: 503 }),
];

/** The webhook receiver: a secret the caller echoes, compared through the module's secretMatches(). */
const WEBHOOK = { file: "integrations/readwise-capture/index.ts", secretEnv: "READWISE_WEBHOOK_SECRET", secret: "a-secret-readwise-minted" };

const COPIES = ["extensions/_shared/auth.ts", "recipes/_shared/auth.ts", "integrations/_shared/auth.ts", "integrations/consolidation-workers/_shared/auth.ts"];
const CORE = readFileSync(join(ROOT, "server-portable", "auth.ts"), "utf8");
for (const copy of COPIES) {
  assert(readFileSync(join(ROOT, copy), "utf8") === CORE,
    `${copy} is byte-for-byte server-portable/auth.ts — copy it again after editing either`);
}

// The workers refuse with 503 before they touch the queue when no LLM key is
// configured — the clean "past the gate" signal this test wants; the shell's
// keys must not reach them. The servers read their access keys per request, so
// they can be set and unset from here; the rest is read once, at import.
for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "EMBEDDING_API_KEY", "CHAT_API_KEY"]) delete process.env[name];
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.SUPABASE_HOUSEHOLD_KEY = "stub";
process.env.DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000001";
process.env.DB_PASSWORD = "stub";
process.env.MCP_ACCESS_KEYS = KEYS; // work-operating-model-activation refuses to start without a key configured
process.env[WEBHOOK.secretEnv] = WEBHOOK.secret;
for (const s of SERVERS) {
  process.env.SUPABASE_URL = s.url;
  await import(join(ROOT, s.file));
  assert(served.length === SERVERS.indexOf(s) + 1, `${s.file} imports as deployed and hands Deno.serve one handler`);
}
process.env.SUPABASE_URL = PG;
await import(join(ROOT, WEBHOOK.file));
assert(served.length === SERVERS.length + 1, `${WEBHOOK.file} imports as deployed and hands Deno.serve one handler`);

// ── One request ──────────────────────────────────────────────────────────────

type Via = "x-access-key" | "x-brain-key" | "bearer" | "query";
const RPC = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
type Reply = { status: number; json: any; text: string };

/** One request to server `s`; `also` carries further presented forms beside the one under test. */
async function request(s: Server, key: string | null, via: Via, also: Partial<Record<Via, string>>,
  init: { method: string; path: string; body?: unknown; accept?: boolean }): Promise<Reply> {
  const handler = served[SERVERS.indexOf(s)];
  // Where createClient runs per request, the URL shape must be the one THIS server's client accepts.
  process.env.SUPABASE_URL = s.url;
  const headers: Record<string, string> = init.accept === false ? { "Content-Type": RPC["Content-Type"] } : { ...RPC };
  const query: string[] = [];
  const present = (form: Via, value: string) => {
    if (form === "query") query.push(`key=${encodeURIComponent(value)}`);
    else if (form === "bearer") headers.Authorization = `Bearer ${value}`;
    else headers[form] = value;
  };
  if (key !== null) present(via, key);
  for (const [form, value] of Object.entries(also) as [Via, string][]) present(form, value);
  const [path, own] = init.path.split("?");
  if (own) query.push(own);
  const url = "http://extension.test" + path + (query.length ? `?${query.join("&")}` : "");
  const r = await handler(new Request(url, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  let json: any = null;
  try { json = line ? JSON.parse(line) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
/** An MCP request: JSON-RPC, POST /mcp. */
const call = (s: Server, key: string | null, body: unknown, via: Via = "x-access-key", also: Partial<Record<Via, string>> = {}, accept = true) =>
  request(s, key, via, also, { method: "POST", path: "/mcp", body, accept });
/** An HTTP API request, `route` as "METHOD /path" with any `:param` filled in; an empty JSON object as the body. */
const http = (s: Server, key: string | null, route: string, via: Via = "x-access-key") => {
  const [method, path] = route.split(" ");
  return request(s, key, via, {}, { method, path: path.replace(/:[a-z_]+/g, "test-id"), body: method === "GET" ? undefined : {} });
};
/** A worker run, dry or not. */
const run = (s: Server, key: string | null, dryRun: boolean, via: Via = "x-access-key") =>
  request(s, key, via, {}, s.dryRun === "body"
    ? { method: "POST", path: "/", body: { dry_run: dryRun } }
    : { method: "POST", path: dryRun ? "/?dry_run=true" : "/", body: undefined });
/** Past the gate: whatever the handler answers once the key and the scope let it through. */
const passed = (r: Reply) => r.status !== 401 && r.status !== 403;

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const toolsOf = (r: { json: any }) => ((r.json?.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
const env = (s: Server, keys: string | undefined, legacy?: string) => {
  if (keys === undefined) delete process.env[s.keys]; else process.env[s.keys] = keys;
  if (legacy === undefined) delete process.env[s.legacy]; else process.env[s.legacy] = legacy;
};

// ── The MCP servers ──────────────────────────────────────────────────────────

for (const s of SERVERS.filter((s) => s.kind === "mcp")) {
  const all = [...s.reads, ...s.writes].sort();
  console.log(`\n[${s.file}]`);
  env(s, KEYS);

  const write = await call(s, WRITE_KEY, LIST);
  assert(write.status === 200 && toolsOf(write).join() === all.join(),
    `a write-scoped key sees every tool (${toolsOf(write).length}/${all.length})`);

  const read = await call(s, READ_KEY, LIST);
  assert(read.status === 200 && toolsOf(read).join() === [...s.reads].sort().join(),
    `a read-scoped key sees the ${s.reads.length} read tool(s) and none of the ${s.writes.length} that write`);
  for (const w of s.writes) assert(!toolsOf(read).includes(w), `…${w} is absent, not merely refused`);

  // A call, not only a listing: the tool is not registered for this principal,
  // so the server answers "not found" before any handler — or any query — runs.
  // A server with no tool at all for this principal (delete-thought-mcp,
  // update-thought-mcp) declares no tools capability, so the SDK answers a call
  // — or a listing — with "method not found" instead: nothing to call, either way.
  if (s.writes.length > 0) {
    const attempt = await call(s, READ_KEY, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: s.writes[0], arguments: {} } });
    const err = attempt.json?.error ?? attempt.json?.result;
    const code = attempt.json?.error?.code;
    assert(attempt.status === 200 && (code === -32602 || attempt.json?.result?.isError === true || (s.reads.length === 0 && code === -32601))
      && /not found|unknown tool/i.test(JSON.stringify(err)),
      `a read-scoped key calling ${s.writes[0]} is told the tool does not exist (${JSON.stringify(err).slice(0, 80)})`);
    if (s.reads.length === 0) assert(read.json?.error?.code === -32601 || Array.isArray(read.json?.result?.tools),
      "…and its listing says there is nothing: no tools capability at all, or an empty list");
  }

  assert((await call(s, "not-a-key", LIST)).status === 401, "a wrong key is refused with 401");
  assert((await call(s, null, LIST)).status === 401, "no key is refused with 401");
  assert((await call(s, hashKey(WRITE_KEY), LIST)).status === 401,
    "presenting the HASH does not authenticate — a leaked config is not a credential");

  // Independent revocation: the write key removed from the config, the read key kept.
  env(s, `chatgpt:read:${hashKey(READ_KEY)}`);
  assert((await call(s, WRITE_KEY, LIST)).status === 401, "the removed key stops working");
  assert(toolsOf(await call(s, READ_KEY, LIST)).join() === [...s.reads].sort().join(), "…and the other keeps working");

  // The legacy single key: still accepted, with write scope, compared by digest now.
  env(s, undefined, LEGACY_KEY);
  assert(toolsOf(await call(s, LEGACY_KEY, LIST)).join() === all.join(), `the legacy single ${s.legacy} still authenticates, as write`);
  assert((await call(s, "nope", LIST)).status === 401, "…and a wrong legacy key is refused");
  env(s, undefined, undefined);
  assert((await call(s, LEGACY_KEY, LIST)).status === 401, "no keys configured at all refuses everything");
  env(s, KEYS);
}

// ── The HTTP APIs ────────────────────────────────────────────────────────────

for (const s of SERVERS.filter((s) => s.kind === "rest")) {
  console.log(`\n[${s.file}]`);
  env(s, KEYS);

  assert(passed(await http(s, READ_KEY, s.readProbe!)), `a read-scoped key passes the gate on ${s.readProbe}`);
  for (const w of s.writes) {
    const r = await http(s, READ_KEY, w);
    assert(r.status === 403 && /read-scoped/.test(r.text), `a read-scoped key is told ${w} writes (403), before the route parses anything`);
  }
  for (const w of s.writes) assert(passed(await http(s, WRITE_KEY, w)), `a write-scoped key passes the gate on ${w}`);

  assert((await http(s, "not-a-key", s.readProbe!)).status === 401, "a wrong key is refused with 401");
  assert((await http(s, null, s.readProbe!)).status === 401, "no key is refused with 401");
  assert((await http(s, hashKey(WRITE_KEY), s.readProbe!)).status === 401,
    "presenting the HASH does not authenticate — a leaked config is not a credential");

  env(s, `chatgpt:read:${hashKey(READ_KEY)}`);
  assert((await http(s, WRITE_KEY, s.readProbe!)).status === 401, "the removed key stops working");
  assert(passed(await http(s, READ_KEY, s.readProbe!)), "…and the other keeps working");

  env(s, undefined, LEGACY_KEY);
  assert(passed(await http(s, LEGACY_KEY, s.writes[0])), `the legacy single ${s.legacy} still authenticates, as write`);
  assert((await http(s, "nope", s.readProbe!)).status === 401, "…and a wrong legacy key is refused");
  env(s, undefined, undefined);
  assert((await http(s, LEGACY_KEY, s.readProbe!)).status === 401, "no keys configured at all refuses everything");
  env(s, KEYS);
}

// ── The workers ──────────────────────────────────────────────────────────────

for (const s of SERVERS.filter((s) => s.kind === "worker")) {
  console.log(`\n[${s.file}]`);
  env(s, KEYS);

  const refused = await run(s, READ_KEY, false);
  assert(refused.status === 403 && /read-scoped/.test(refused.text), "a read-scoped key asking for a real run is told so (403)");
  assert(passed(await run(s, READ_KEY, true)), "…and may dry-run: it passes the gate");
  assert(passed(await run(s, WRITE_KEY, false)), "a write-scoped key passes the gate for a real run");

  assert((await run(s, "not-a-key", false)).status === 401, "a wrong key is refused with 401");
  assert((await run(s, null, false)).status === 401, "no key is refused with 401");
  assert((await run(s, hashKey(WRITE_KEY), false)).status === 401,
    "presenting the HASH does not authenticate — a leaked config is not a credential");

  env(s, `chatgpt:read:${hashKey(READ_KEY)}`);
  assert((await run(s, WRITE_KEY, false)).status === 401, "the removed key stops working");
  assert(passed(await run(s, READ_KEY, true)), "…and the other keeps working");

  env(s, undefined, LEGACY_KEY);
  assert(passed(await run(s, LEGACY_KEY, false)), `the legacy single ${s.legacy} still authenticates, as write`);
  assert((await run(s, "nope", false)).status === 401, "…and a wrong legacy key is refused");
  env(s, undefined, undefined);
  assert((await run(s, LEGACY_KEY, false)).status === s.unconfigured, `no keys configured at all answers ${s.unconfigured} to everything`);
  env(s, KEYS);
}

// ── The webhook receiver ─────────────────────────────────────────────────────

console.log(`\n[${WEBHOOK.file}]`);
{
  const handler = served[SERVERS.length];
  const post = async (body: unknown) => {
    const r = await handler(new Request("http://extension.test/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, text: await r.text() };
  };
  const right = await post({ secret: WEBHOOK.secret, event_type: "readwise.other" });
  assert(right.status === 200 && right.text === "ignored", "the echoed secret admits the request (an event type it ignores, so nothing is written)");
  assert((await post({ secret: "not-the-secret", event_type: "readwise.other" })).status === 401, "a wrong secret is refused with 401");
  assert((await post({ event_type: "readwise.other" })).status === 401, "no secret is refused with 401");
  assert((await post({ secret: 12345, event_type: "readwise.other" })).status === 401, "a secret that is not a string is refused, not hashed");
  assert((await post({ secret: hashKey(WEBHOOK.secret), event_type: "readwise.other" })).status === 401, "the secret's digest is not the secret");
}

// ── Where the key may travel ─────────────────────────────────────────────────

console.log("\n[where the key may travel]");
for (const s of SERVERS.filter((s) => s.kind === "mcp" && s.writes.length > 0)) {
  env(s, KEYS);
  for (const via of ["x-access-key", "x-brain-key", "bearer", "query"] as Via[]) {
    assert(toolsOf(await call(s, READ_KEY, LIST, via)).join() === [...s.reads].sort().join(),
      `${s.file}: the ${via} form authenticates, and scope applies through it`);
  }
}
{
  const s = SERVERS[0];
  env(s, KEYS);
  // Every form presented is tried: a gateway's own token in Authorization, or a
  // stale header a client keeps sending, does not shadow the key the client means.
  assert(toolsOf(await call(s, READ_KEY, LIST, "query", { bearer: "eyJ.a.gateway-jwt" })).join() === [...s.reads].sort().join(),
    "a gateway's bearer token beside a right ?key= does not shadow it");
  assert(toolsOf(await call(s, WRITE_KEY, LIST, "x-access-key", { "x-brain-key": "stale" })).join() === [...s.reads, ...s.writes].sort().join(),
    "a wrong x-brain-key beside a right x-access-key does not shadow it");
  assert((await call(s, "wrong-one", LIST, "query", { bearer: "wrong-two", "x-brain-key": "wrong-three" })).status === 401,
    "three wrong forms are three refusals, not one acceptance");
  // Claude Desktop's connectors send no Accept header; the servers patch one in
  // by replacing c.req.raw before the key is read from it.
  assert(toolsOf(await call(s, READ_KEY, LIST, "query", {}, false)).join() === [...s.reads].sort().join(),
    "a request without an Accept header (the patched c.req.raw) still authenticates from ?key=");
  assert((await call(s, "not-a-key", LIST, "x-access-key", {}, false)).status === 401,
    "…and is still refused with a wrong key");
}
for (const s of SERVERS.filter((s) => s.health)) {
  const health = await served[SERVERS.indexOf(s)](new Request(`http://extension.test${s.health}`, { method: "GET" }));
  assert(health.status === 200 && (await health.json()).status === "ok", `${s.file}: the unauthenticated GET ${s.health} health check still answers`);
}

// ── Drift guards ─────────────────────────────────────────────────────────────

/** Stored functions a tool or route may call and still be a read; any other `.rpc(` is a write. */
const RPC_READS = ["crm_search_contacts_fts", "traverse_graph", "find_shortest_path", "match_thoughts", "search_thoughts_text", "brain_stats_aggregate", "get_thought_connections"];
/** Tables a READ may insert into: a recall records itself. An update or delete on them, or an insert anywhere else, is a write. */
const LOG_TABLES = ["agent_memory_recall_traces", "agent_memory_recall_items", "agent_memory_audit_events"];
/**
 * Whether a body writes: a table verb (not a read's own log insert; `.delete()`
 * with no argument or an options object — `searchParams.delete("page")` and a
 * Map's `.delete(id)` are not table verbs), an SQL write, or an RPC not named
 * by a literal in RPC_READS (a variable name is a write).
 */
const writes = (reach: string) => {
  const rest = reach.replace(new RegExp(String.raw`\.from\("(?:${LOG_TABLES.join("|")})"\)\s*\.insert\(`, "g"), ".from(LOG).logged(");
  return /\.(insert|update|upsert)\(|\.delete\(\s*[){]/.test(rest)
    || /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/.test(rest)
    || [...rest.matchAll(/\.rpc\(\s*(?:(["'`])([^"'`]+)\1)?/g)].some((m) => !m[2] || !RPC_READS.includes(m[2]));
};
/** `reach` plus the bodies of the file-level functions it calls, one level down — where a route's work often lives. */
const withCallees = (text: string, reach: string) => {
  let out = reach;
  for (const name of new Set([...reach.matchAll(/\b([a-zA-Z_]\w*)\(/g)].map((m) => m[1]))) {
    const at = text.search(new RegExp(String.raw`^(?:async )?function ${name}\(`, "m"));
    if (at >= 0) out += text.slice(at, text.indexOf("\n}", at));
  }
  return out;
};
/** A tool's registration block, from `server.tool(` (or `registerTool(`) naming it to its closing `);` — not the first place its name is quoted. */
const blockOf = (text: string, name: string) => {
  const at = Math.max(text.indexOf(`server.tool(\n    "${name}"`), text.indexOf(`server.registerTool(\n    "${name}"`));
  assert(at >= 0, `…${name} is registered as server.tool(\\n    "${name}") or registerTool`);
  return text.slice(at, text.indexOf("\n  );", at));
};
const OLD_SPELLINGS = /c\.req\.query\("key"\)|c\.req\.header\("x-access-key"\)|[!=]== ?(?:MCP|AUDITOR)_ACCESS_KEY\b|isAuthorized\(|\bauth\(c\)/;

console.log("\n[the files say what this test assumes]");
for (const s of SERVERS) {
  const text = readFileSync(join(ROOT, s.file), "utf8");
  if (s.kind === "mcp") {
    // `server.tool(` and `server.registerTool(`, the SDK's current name and the template's.
    const registered = [...text.matchAll(/server\.(?:tool|registerTool)\(\n\s+"([a-z_]+)"/g)].map((m) => m[1]).sort();
    const gated = [...text.matchAll(/if \(canWrite\(principal\)\) server\.(?:tool|registerTool)\(\n\s+"([a-z_]+)"/g)].map((m) => m[1]).sort();
    assert(registered.join() === [...s.reads, ...s.writes].sort().join(),
      `${s.file}: every registered tool is classified above (${registered.length})`);
    assert(gated.join() === [...s.writes].sort().join(), `…and exactly the writes are gated (${gated.length})`);
    for (const w of s.writes) {
      const body = blockOf(text, w);
      const handler = body.match(/wrap\(\(\) => (handle\w+)\(/)?.[1];
      const reach = handler ? text.slice(text.indexOf(`async function ${handler}`), text.indexOf("\n}", text.indexOf(`async function ${handler}`))) : body;
      assert(writes(reach), `…${w} does write (its body or handler inserts, updates, upserts, deletes, or calls an RPC not listed as a read)`);
    }
    for (const r of s.reads) {
      const body = blockOf(text, r);
      const handler = body.match(/wrap\(\(\) => (handle\w+)\(/)?.[1];
      const reach = handler ? text.slice(text.indexOf(`async function ${handler}`), text.indexOf("\n}", text.indexOf(`async function ${handler}`))) : body;
      assert(!writes(reach), `…${r} does not write (no table verb; any RPC it calls is in RPC_READS)`);
    }
    assert(text.includes("authenticateRequest(c.req.raw,"), "…the key is read and resolved from the request, every presented form tried");
  } else if (s.kind === "rest") {
    const mounted = [...text.matchAll(/^app\.(get|post|put|patch|delete)\("([^"]+)",\s*(requireWrite,\s*)?/gm)]
      .map((m) => ({ route: `${m[1].toUpperCase()} ${m[2]}`, gated: Boolean(m[3]), at: m.index! }));
    assert(mounted.map((m) => m.route).sort().join() === [...s.reads, ...s.writes].sort().join(),
      `${s.file}: every mounted route is classified above (${mounted.length})`);
    assert(mounted.filter((m) => m.gated).map((m) => m.route).sort().join() === [...s.writes].sort().join(),
      `…and exactly the writes take requireWrite (${mounted.filter((m) => m.gated).length})`);
    const starts = mounted.map((m) => m.at).concat(text.indexOf("\nDeno.serve("));
    for (const m of mounted) {
      const end = Math.min(...starts.filter((a) => a > m.at));
      const reach = withCallees(text, text.slice(m.at, end));
      if (s.writes.includes(m.route)) assert(writes(reach), `…${m.route} does write (the route or a function it calls inserts, updates, upserts or deletes, or calls an RPC not listed as a read)`);
      else assert(!writes(reach), `…${m.route} does not write (a read may insert its own trace; any RPC it calls is in RPC_READS)`);
    }
    assert(text.includes("authenticateRequest(c.req.raw,") && text.includes('c.set("principal", principal)'),
      "…the key is read and resolved from the request in one middleware, the principal handed to the routes");
  } else {
    assert(text.includes("authenticateRequest(req,") && text.includes("if (!canWrite(principal) && !dryRun)"),
      `${s.file}: the key is resolved from the request through the module, and a read-scoped key may only dry-run`);
  }
  assert(text.includes(`from "${s.shared}"`), `…the module is the _shared/auth.ts beside the file (${s.shared})`);
  assert(!OLD_SPELLINGS.test(text), "…and the key is compared nowhere else");
}
{
  const text = readFileSync(join(ROOT, WEBHOOK.file), "utf8");
  assert(text.includes('from "../_shared/auth.ts"') && text.includes("secretMatches(") && !/[!=]== ?READWISE_WEBHOOK_SECRET\b/.test(text),
    `${WEBHOOK.file}: the echoed secret is compared through the module's secretMatches(), digest to digest, and with no operator`);
}

// The files this test cannot import — a sample whose tool modules are not in
// the repository, a Next.js route, a README's code block, a Node stub — say the
// same thing in their text.
console.log("\n[the files this test reads but cannot run]");
const TEXT_ONLY: { file: string; must: RegExp[]; mustNot: RegExp[] }[] = [
  { file: "recipes/edge-function-cost-optimization/examples/after/index.ts",
    must: [/from "\.\.\/\.\.\/\.\.\/_shared\/auth\.ts"/, /authenticateRequest\(c\.req\.raw,/, /serverFor\(principal\)/, /session\.scope !== principal\.scope/],
    mustNot: [/[!=]== ?MCP_ACCESS_KEY\b/, /c\.req\.header\("x-access-key"\)/] },
  { file: "recipes/edge-function-cost-optimization/examples/after/server.ts",
    must: [/from "\.\.\/\.\.\/\.\.\/_shared\/auth\.ts"/, /export function serverFor\(principal: Principal\)/, /register\w+\(server, principal\)/],
    mustNot: [/export const server\b/] },
  { file: "recipes/vercel-neon-telegram/src/app/api/telegram/route.ts",
    must: [/import \{ secretMatches \} from "@\/lib\/auth"/, /secretMatches\(req\.headers\.get\("x-telegram-bot-api-secret-token"\), expectedSecret\)/],
    mustNot: [/secret !== expectedSecret/] },
  { file: "recipes/vercel-neon-telegram/src/lib/auth.ts",
    must: [/export function secretMatches\(/, /createHash\("sha256"\)/, /timingSafeEqual\(digest\(presented\), digest\(expected\)\)/], mustNot: [] },
  { file: "integrations/telegram-capture/README.md",
    must: [/async function secretMatches\(/, /crypto\.subtle\.timingSafeEqual\(/, /if \(!\(await secretMatches\(secret, TELEGRAM_WEBHOOK_SECRET\)\)\)/],
    mustNot: [/secret !== TELEGRAM_WEBHOOK_SECRET/] },
  { file: "docs/walkthroughs/ob1-agent-dashboard/demo-rest-server.mjs",
    must: [/function secretMatches\(/, /timingSafeEqual\(digest\(presented\), digest\(expected\)\)/, /secretMatches\(provided, accessKey\)/],
    mustNot: [/provided === accessKey/] },
];
for (const t of TEXT_ONLY) {
  const text = readFileSync(join(ROOT, t.file), "utf8");
  for (const re of t.must) assert(re.test(text), `${t.file} says ${re}`);
  for (const re of t.mustNot) assert(!re.test(text), `${t.file} no longer says ${re}`);
}

// Each deno.json pins what package.json installs, so this test exercises the
// libraries the functions deploy with: every import of an extension exactly;
// for a recipe or integration, every npm pin of a package installed here.
{
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).devDependencies as Record<string, string>;
  const dirs = readdirSync(HERE, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "node_modules").map((d) => d.name);
  for (const dir of dirs) {
    if (!existsSync(join(HERE, dir, "deno.json"))) { assert(false, `${dir}/deno.json exists — every extension pins its imports`); continue; }
    const imports = JSON.parse(readFileSync(join(HERE, dir, "deno.json"), "utf8")).imports as Record<string, string>;
    const drift = Object.entries(imports).filter(([name, spec]) => spec !== `npm:${name}@${pkg[name]}`);
    assert(drift.length === 0, `extensions/${dir}/deno.json pins what package.json installs${drift.length ? ` (${drift.map(([n, s]) => `${n}: ${s}`).join(", ")})` : ""}`);
  }
  const seen = new Set<string>();
  for (const s of SERVERS.filter((s) => !s.file.startsWith("extensions/"))) {
    let dir = dirname(s.file);
    while (dir.includes("/") && !existsSync(join(ROOT, dir, "deno.json"))) dir = dirname(dir);
    const file = join(dir, "deno.json");
    if (!existsSync(join(ROOT, file)) || seen.has(file)) continue;
    seen.add(file);
    const imports = JSON.parse(readFileSync(join(ROOT, file), "utf8")).imports as Record<string, string>;
    const drift = Object.entries(imports).filter(([name, spec]) => name in pkg && /^npm:[^@]+(?:@[^@]+)?@\d/.test(spec) && spec !== `npm:${name}@${pkg[name]}`);
    assert(drift.length === 0, `${file} pins what package.json installs${drift.length ? ` (${drift.map(([n, s]) => `${n}: ${s}`).join(", ")})` : ""}`);
  }
}

report();
