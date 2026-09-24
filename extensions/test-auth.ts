#!/usr/bin/env bun
/**
 * test-auth.ts — every vendored server authenticates through the core server's
 * auth path: the seven extension servers (SMD-1252, FORK.md change 64) and the
 * recipes and integrations that compared a key the same way — six more MCP
 * servers, two HTTP APIs, four workers and a webhook receiver (SMD-1455,
 * change 67).
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
 * secret has no scope to give and is compared digest to digest. Each MCP
 * server answers three overlapping requests each with its own id (SMD-1497,
 * change 78: a server that outlives the request and is connect()ed to a fresh
 * transport each time answers on the wrong one), the first with no Accept
 * header (change 84: the transport takes either token or none, and the
 * servers' Accept patches are gone). Then the drift
 * guards: every tool a file registers and every route an API mounts is
 * classified here as a read or a write, exactly the writes are gated, each
 * write does write and each read does not, the server is built per request,
 * the key is read through the shared
 * module and nowhere else, every `_shared/auth.ts` is byte-for-byte
 * server-portable/auth.ts (a Supabase function is bundled from
 * supabase/functions/, so the module is copied beside the servers rather than
 * imported across the tree), and the MCP stack is one set of versions across
 * the tree's three installs (this directory's, server-portable's, the Kubernetes
 * image's) — and the pinned `@hono/mcp` lets go of each request once it has
 * answered it (SMD-1607, change 83: 0.1.1 kept every one until close()).
 *
 * The files are imported as modules: each exports Bun's entry shape,
 * `export default { port, fetch }` (SMD-1799), and its `fetch` is the handler
 * driven here — console.error/warn silenced for the length of a request, since
 * a refused port is the proof and not noise — and, for the recipes and
 * integrations, under a loader that resolves their bare package names from
 * this directory's install, since they have none of their own. Nothing stands
 * in for `Deno`: a server that still reached it would throw at import or
 * answer 500, a counted failure either way.
 * No database: nothing here reaches a handler that queries with a key that
 * would let it, or the client refuses at once (a port nothing listens on) —
 * the SQL shim and supabase-js both connect lazily, so a stub URL is never
 * dialled otherwise.
 *
 * Then, for real: every server that imports the SQL shim — which imports
 * `bun` — is what `bun <file>` serves, Bun starting the default export it
 * finds in the entry module (SMD-1480 gave these files a polyfill for the two
 * Deno members they used, change 74; SMD-1799 gave them Bun's own shape). The
 * last section starts each such file as a child process on a port this test
 * chose, with the environment its README documents, asks it over HTTP for the
 * one thing that proves it is that server authenticating, and stops it. Every
 * file in the tree that imports the shim and exports the entry shape is
 * started, or this fails.
 *
 * Run: bun install && bun test-auth.ts   (in extensions/)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "./_shared/auth.ts";
import { createAssert, PACKAGES, STACK } from "../db/test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// ── The servers' handlers ────────────────────────────────────────────────────

type Handler = (req: Request) => Response | Promise<Response>;
/** Each server's handler in SERVERS order, the webhook receiver's after them. */
const handlers: Handler[] = [];
/**
 * A server imported as a module: the handler Bun would serve is its default
 * export's `fetch` (SMD-1799). Nothing stands in for `Deno` — a file that still
 * reached it fails here (module scope) or answers 500 (a request), and either
 * is counted.
 */
async function importServer(file: string): Promise<Handler> {
  const mod = (await import(join(ROOT, file))) as { default?: { fetch?: unknown } };
  if (typeof mod.default?.fetch !== "function") throw new Error(`${file} does not export default { fetch }`);
  return mod.default.fetch as Handler;
}

// ── The vendored servers' packages, from this directory's install ────────────
// A recipe or integration imports STACK's four (hono, zod, @hono/mcp, the SDK) by
// bare name and has no install of its own beside it (kubernetes-deployment's
// package.json is the image's, SMD-1800; run from a checkout, Bun fetches the four
// on demand — SMD-1991), so this loader resolves those names from
// extensions/node_modules, the pinned versions. Until SMD-1800 it also read Deno's specifiers — a `jsr:`
// type-only import dropped, `npm:pkg@version` unprefixed, the deno.land postgres
// driver stubbed for kubernetes-deployment; none is left in the tree (check 11
// refuses them in every shim importer).

// STACK and PACKAGES — the four packages this directory installs, and a specifier of one — come from
// db/test-support.ts, so test-writes.ts's loader reads the same list.
/** Only this checkout's recipes/ and integrations/ — not a checkout that happens to sit under a directory so named. */
const VENDORED = new RegExp("^" + ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(recipes|integrations)/.*\\.ts$");
Bun.plugin({
  name: "vendored-packages-from-extensions",
  setup(build) {
    build.onLoad({ filter: VENDORED }, async (args) => {
      const src = (await Bun.file(args.path).text()).replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (whole, lead, q, spec) =>
        PACKAGES.test(spec as string) ? `${lead}${q}${Bun.resolveSync(spec as string, HERE)}${q}` : whole);
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
  /** What SUPABASE_URL must look like: the SQL shim wants postgres:// (every server is on it since SMD-1798). */
  url: string;
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
const ext = (file: string, reads: string[], writes: string[], o: Partial<Server> = {}): Server =>
  ({ file: `extensions/${file}`, kind: "mcp", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG, reads, writes, ...o });
const vendored = (file: string, kind: Kind, reads: string[], writes: string[], o: Partial<Server> = {}): Server =>
  ({ file, kind, keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG, reads, writes, ...o });
// To add a server: one entry below — `url` PG_REFUSED when a handler queries
// before it can answer (every server is on the SQL shim since SMD-1798; the
// HTTPS stubs supabase-js took went with it); `kind` picks the assertions; a REST server
// lists its routes as "METHOD /path" and needs `readProbe`, a worker `dryRun`
// and `unconfigured`. Then, as needed: RPC_READS and LOG_TABLES for what its
// reads may call; STACK (db/test-support.ts) and extensions/package.json for a new
// npm package (the pin guard then holds the other two installs to it); a TEXT_ONLY entry for a file
// that cannot run; COPIES and package.json's sync-auth for a new _shared/. A
// REST server's routes must be mounted `app.<verb>("…", …)` at column 0, or
// the classifier cannot see them.
const SERVERS: Server[] = [
  // The seven extension servers (change 64).
  ext("family-calendar/index.ts", ["get_week_schedule", "search_activities", "get_upcoming_dates"],
    ["add_family_member", "add_activity", "add_important_date"], { health: "/" }),
  ext("home-maintenance/index.ts", ["get_upcoming_maintenance", "search_maintenance_history"],
    ["add_maintenance_task", "log_maintenance"]),
  ext("household-knowledge/index.ts", ["search_household_items", "get_item_details", "list_vendors"],
    ["add_household_item", "add_vendor"]),
  ext("job-hunt/index.ts", ["get_pipeline_overview", "get_upcoming_interviews", "search_job_contacts"],
    ["add_company", "add_job_posting", "add_job_contact", "submit_application", "schedule_interview",
     "log_interview_notes", "link_contact_to_professional_crm"]),
  ext("meal-planning/index.ts", ["search_recipes", "get_meal_plan"],
    ["add_recipe", "update_recipe", "create_meal_plan", "generate_shopping_list"]),
  ext("professional-crm/index.ts", ["crm_search_contacts", "crm_get_contact_history", "crm_get_follow_ups", "crm_prep_context", "crm_stale_contacts"],
    ["crm_add_contact", "crm_log_interaction", "crm_create_opportunity", "crm_update_contact", "crm_link_thought"]),
  ext("meal-planning/shared-server.ts", ["view_meal_plan", "view_recipes", "view_shopping_list"], ["mark_item_purchased"],
    { keys: "MCP_HOUSEHOLD_ACCESS_KEYS", legacy: "MCP_HOUSEHOLD_ACCESS_KEY" }),
  // The recipes and integrations (change 67).
  vendored("recipes/ob-graph/index.ts", "mcp", ["search_nodes", "get_neighbors", "traverse_graph", "find_path", "list_edge_types"],
    ["create_node", "create_edge", "update_node", "delete_node", "delete_edge"], { health: "/health" }),
  vendored("recipes/work-operating-model-activation/index.ts", "mcp", ["query_operating_model"],
    ["start_operating_model_session", "save_operating_model_layer", "generate_operating_model_exports"], { health: "/health" }),
  vendored("integrations/delete-thought-mcp/index.ts", "mcp", [], ["delete_thought"]),
  vendored("integrations/update-thought-mcp/index.ts", "mcp", [], ["update_thought"]),
  vendored("integrations/kubernetes-deployment/index.ts", "mcp", ["search", "fetch", "search_thoughts", "list_thoughts", "thought_stats"], ["capture_thought"]),
  vendored("integrations/agent-memory-api/index.ts", "rest",
    ["GET /health", "POST /recall", "GET /memories/review", "GET /memories", "GET /memories/:id", "GET /recall-traces/:request_id"],
    ["POST /writeback", "POST /recall/:request_id/usage", "PATCH /memories/:id/review"], { url: PG_REFUSED, readProbe: "POST /recall" }),
  vendored("integrations/open-brain-rest/index.ts", "rest",
    ["GET /health", "GET /stats", "GET /thoughts", "GET /thought/:id", "POST /search", "GET /duplicates", "GET /thought/:id/connections",
     "GET /thought/:id/reflection", "GET /ingestion-jobs", "GET /ingestion-jobs/:id", "POST /ingestion-jobs/:id/execute"],
    ["PUT /thought/:id", "DELETE /thought/:id", "POST /capture", "POST /thought/:id/reflection", "POST /ingest"],
    { url: PG_REFUSED, readProbe: "GET /health" }),
  vendored("recipes/editorial-policy/auditor/index.ts", "worker", [], [],
    { keys: "AUDITOR_ACCESS_KEYS", legacy: "AUDITOR_ACCESS_KEY", url: PG_REFUSED, dryRun: "body", unconfigured: 401 }),
  vendored("integrations/entity-extraction-worker/index.ts", "worker", [], [], { dryRun: "query", unconfigured: 503 }),
  vendored("integrations/consolidation-workers/bio/index.ts", "worker", [], [], { dryRun: "query", unconfigured: 503 }),
  vendored("integrations/consolidation-workers/metadata-norm/index.ts", "worker", [], [], { dryRun: "query", unconfigured: 503 }),
];

/** The webhook receiver: a secret the caller echoes, compared through the module's secretMatches(). */
const WEBHOOK = { file: "integrations/readwise-capture/index.ts", secretEnv: "READWISE_WEBHOOK_SECRET", secret: "a-secret-readwise-minted" };

// Every function deploys one level under supabase/functions/, so every server
// imports `../_shared/auth.ts` and a copy sits in each directory that holds a
// function directory. The list here, the tree, and package.json's sync-auth
// (the one command that rewrites them all) must agree.
const COPIES = ["extensions/_shared/auth.ts", "recipes/_shared/auth.ts", "recipes/editorial-policy/_shared/auth.ts",
  "integrations/_shared/auth.ts", "integrations/consolidation-workers/_shared/auth.ts"];
const CORE = readFileSync(join(ROOT, "server-portable", "auth.ts"), "utf8");
for (const copy of COPIES) {
  assert(existsSync(join(ROOT, copy)) && readFileSync(join(ROOT, copy), "utf8") === CORE,
    `${copy} is byte-for-byte server-portable/auth.ts — \`bun run sync-auth\` here rewrites every copy`);
}
{
  const inTree = [...new Bun.Glob("{extensions,recipes,integrations}/**/_shared/auth.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules")).sort();
  assert(inTree.join() === [...COPIES].sort().join(), `every _shared/auth.ts in the tree is in COPIES and vice versa (${inTree.join(", ")})`);
  const sync = (JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).scripts as Record<string, string>)["sync-auth"] ?? "";
  for (const copy of COPIES) {
    const dir = relative(HERE, join(ROOT, dirname(copy))).replace(/\\/g, "/");
    assert(sync.split(/[\s;]+/).includes(dir), `package.json's sync-auth names ${dir}`);
  }
}

// The workers refuse with 503 before they touch the queue when no LLM key is
// configured — the clean "past the gate" signal this test wants; the shell's
// keys must not reach them. The servers read their access keys per request, so
// they can be set and unset from here; the rest is read once, at import.
for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "EMBEDDING_API_KEY", "CHAT_API_KEY", "SMART_INGEST_URL", "ENTITY_EXTRACTION_WORKER_URL"]) delete process.env[name]; // the two URL knobs (SMD-2110): a shell's non-http value would fail a server's start here for reasons of its own
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.SUPABASE_HOUSEHOLD_KEY = "stub";
process.env.DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000001";
process.env.DB_PASSWORD = "stub";
process.env.MCP_ACCESS_KEYS = KEYS; // work-operating-model-activation refuses to start without a key configured
process.env[WEBHOOK.secretEnv] = WEBHOOK.secret;
try {
  for (const s of SERVERS) {
    process.env.SUPABASE_URL = s.url;
    handlers.push(await importServer(s.file));
    assert(handlers.length === SERVERS.indexOf(s) + 1, `${s.file} imports as a module and exports default { fetch }`);
  }
  process.env.SUPABASE_URL = PG;
  handlers.push(await importServer(WEBHOOK.file));
  assert(handlers.length === SERVERS.length + 1, `${WEBHOOK.file} imports as a module and exports default { fetch }`);
} catch (e) {
  // A server that listens or connects at import, or reaches a `Deno` nothing installs, is a
  // counted failure with a tally, not a stack trace in place of one; nothing below could run.
  assert(false, `a server threw at import — as a module nothing should listen, connect or reach \`Deno\`: ${e instanceof Error ? e.message : String(e)}`);
  report();
}
assert(!("Deno" in globalThis), "no import installed a `Deno` global — every server is Bun-native (SMD-1799)");

// ── One request ──────────────────────────────────────────────────────────────

type Via = "x-access-key" | "x-brain-key" | "bearer" | "query";
const RPC = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
type Reply = { status: number; json: any; text: string };

/** How long an in-process request may take before it is called a hang — a handler answers a listing in single-digit ms here, and a query is refused at once. */
const REQUEST_MS = 2000;
// The silencer is counted, not saved and restored per call: two requests in
// flight at once (the overlapping probe below) would otherwise each save the
// other's no-op and leave the console dark for the rest of the run.
const CONSOLE = { error: console.error, warn: console.warn };
let hushed = 0;
function hush() { if (hushed++ === 0) { console.error = () => {}; console.warn = () => {}; } }
function unhush() { if (--hushed === 0) Object.assign(console, CONSOLE); }

/** One request to server `s`; `also` carries further presented forms beside the one under test. */
async function request(s: Server, key: string | null, via: Via, also: Partial<Record<Via, string>>,
  init: { method: string; path: string; body?: unknown; rawBody?: string | ReadableStream<Uint8Array>; accept?: boolean }): Promise<Reply> {
  const handler = handlers[SERVERS.indexOf(s)];
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
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  // @ts-ignore -- duplex is required for a streaming body, and is not in the lib's RequestInit
  return answer(handler, new Request(url, { method: init.method, headers, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) }));
}
/** One request to one handler, in process, with a deadline. */
async function answer(handler: Handler, req: Request): Promise<Reply> {
  // A handler that queries a refused port logs the refusal; the status is the assertion, the log is noise on a green run.
  hush();
  // Every request has a deadline: a handler that never answers (SMD-1497's
  // crossed transports parked one) is reported as a timeout with status 0, not
  // waited on — and the silencer above is released either way, which a
  // `finally` on the bare handler promise could not promise.
  const timeout: Reply = { status: 0, json: null, text: `timed out after ${REQUEST_MS} ms` };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(handler(req)).then(parse),
      new Promise<Reply>((res) => { timer = setTimeout(() => res(timeout), REQUEST_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
    unhush();
  }
}
/** A server's answer: its status, its text, and the JSON in it — direct, or the first SSE data line. */
async function parse(r: Response): Promise<Reply> {
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  let json: any = null;
  try { json = line ? JSON.parse(line) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
/** An MCP request: JSON-RPC, POST /mcp. */
const call = (s: Server, key: string | null, body: unknown, via: Via = "x-access-key", also: Partial<Record<Via, string>> = {}, accept = true) =>
  request(s, key, via, also, { method: "POST", path: "/mcp", body, accept });
/** An HTTP API request, `route` as "METHOD /path" with any `:param` filled in; an empty JSON object as the body unless `rawBody` says otherwise. */
const http = (s: Server, key: string | null, route: string, via: Via = "x-access-key", rawBody?: string) => {
  const [method, path] = route.split(" ");
  return request(s, key, via, {}, { method, path: path.replace(/:[a-z_]+/g, "test-id"), body: method === "GET" ? undefined : {}, rawBody });
};
/** A worker run, dry or not. */
const run = (s: Server, key: string | null, dryRun: boolean) =>
  request(s, key, "x-access-key", {}, s.dryRun === "body"
    ? { method: "POST", path: "/", body: { dry_run: dryRun } }
    : { method: "POST", path: dryRun ? "/?dry_run=true" : "/", body: undefined });
/** Past the gate: whatever the handler answers once the key and the scope let it through — not a refusal by another status. */
const passed = (r: Reply) => r.status !== 401 && r.status !== 403 && !/access key|read-scoped/i.test(r.text);

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

// ── Overlapping requests ─────────────────────────────────────────────────────
//
// Three tools/list at one server under one key, overlapping two ways
// (SMD-1497, FORK.md change 78). The first request starts alone, its headers
// in and its body still on the wire for LATE_BODY_MS; the other two start
// STAGGER_MS later with their bodies complete. So the first sits inside the
// server between connect() and the arrival of its message while the second
// and third connect — the window a server that outlives the request gets
// wrong. A same-tick burst would catch main's shape (its connect() overwrite
// does not depend on timing) but never opens that window: every handler in a
// burst reaches its first await before any body is parsed. The stagger is
// what catches a server per request that first close()s the previous
// request's server — in a burst that server has always finished; staggered,
// the first request's answer is sent to a transport the SDK has forgotten,
// and it fails here as the lone timeout. Change 78 records the mutants run,
// and the one shape the probe passes yet is worse than a build per request
// (a per-scope server behind a serialising lock). The margin: the first
// request reaches its body await within microseconds and the other two
// connect at the 5 ms timer, so the body's 20 ms leaves 15 ms; a longer
// event-loop stall degrades the probe to one request then a burst of two —
// detection weakens, the fix cannot fail. The first request also carries no
// Accept header: @hono/mcp 0.3.x takes none as `*/*` and either token as
// enough, so the Accept patches are gone and every server answers the bare
// request (change 84).
const STAGGER_MS = 5;
const LATE_BODY_MS = 20;
/** A JSON-RPC body that arrives `ms` after the request does. */
const lateBody = (body: unknown, ms: number) => new ReadableStream<Uint8Array>({
  start(ctrl) { setTimeout(() => { ctrl.enqueue(new TextEncoder().encode(JSON.stringify(body))); ctrl.close(); }, ms); },
});
/** The three answers, in the order of `ids`; `send` gets a late body for the first id and none (build its own) for the rest. */
async function overlapping(ids: number[], send: (id: number, late?: ReadableStream<Uint8Array>) => Promise<Reply>): Promise<Reply[]> {
  const first = send(ids[0], lateBody({ ...LIST, id: ids[0] }, LATE_BODY_MS));
  await new Promise((r) => setTimeout(r, STAGGER_MS));
  return Promise.all([first, ...ids.slice(1).map((id) => send(id))]);
}
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
  // update-thought-mcp) lists an empty set but has no tools/call handler, so a
  // call is told the method does not exist: nothing to call, either way.
  if (s.writes.length > 0) {
    const attempt = await call(s, READ_KEY, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: s.writes[0], arguments: {} } });
    const err = attempt.json?.error ?? attempt.json?.result;
    const code = attempt.json?.error?.code;
    assert(attempt.status === 200 && (code === -32602 || attempt.json?.result?.isError === true || (s.reads.length === 0 && code === -32601))
      && /not found|unknown tool/i.test(JSON.stringify(err)),
      `a read-scoped key calling ${s.writes[0]} is told the tool does not exist (${JSON.stringify(err).slice(0, 80)})`);
    if (s.reads.length === 0) assert(Array.isArray(read.json?.result?.tools) && read.json.result.tools.length === 0,
      "…and its listing is an empty list under a declared tools capability, not a failed method");
  }

  // Three overlapping requests under one key (see `overlapping` above), each
  // answered with its own id and the full list. Any two overlapping requests
  // are the trigger, not a burst; three of these servers were main's shape.
  // A hang is request()'s deadline as status 0, not a slow server. Explicit
  // statuses: a `!== 200` would pass the timeout.
  {
    const ids = [11, 12, 13];
    const answers = await overlapping(ids, (id, late) =>
      late ? request(s, WRITE_KEY, "x-access-key", {}, { method: "POST", path: "/mcp", rawBody: late, accept: false }) : call(s, WRITE_KEY, { ...LIST, id }));
    for (const [i, r] of answers.entries()) {
      assert(r.status === 200 && r.json?.id === ids[i] && toolsOf(r).join() === all.join(),
        `${ids.length} concurrent tools/list under one key: request ${ids[i]} is answered with its own id and every tool (${r.status === 0 ? r.text : `${r.status}, id ${r.json?.id ?? "none"}, ${toolsOf(r).length} tools`})`);
    }
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

// ── The MCP server outside the shared auth path ──────────────────────────────
//
// enhanced-mcp keeps its own single-key compare (change 67 left it there, and
// check 8 passes it), so it is not in SERVERS and none of the claims above are
// made for it. It was, though, the fourth module-level McpServer connect()ed
// to a fresh transport on every request — SMD-1497 named three — so the
// concurrency probe runs against it too, imported the same way, under the one
// key it reads.
{
  const file = "integrations/enhanced-mcp/index.ts";
  console.log(`\n[${file}]`);
  process.env.SUPABASE_URL = PG;
  process.env.MCP_ACCESS_KEY = LEGACY_KEY;
  const before = handlers.length;
  try {
    handlers.push(await importServer(file));
  } catch (e) {
    assert(false, `${file} threw at import: ${e instanceof Error ? e.message : String(e)}`);
  }
  assert(handlers.length === before + 1, `${file} imports as a module and exports default { fetch }`);
  const handler = handlers[before];
  const ids = [11, 12, 13];
  // No handler (the import failed above) is already a counted failure; the probe is skipped rather than thrown from.
  const answers = handler ? await overlapping(ids, (id, late) => answer(handler, new Request("http://extension.test/mcp",
    // @ts-ignore -- duplex is required for a streaming body, and is not in the lib's RequestInit
    // The late request carries no Accept, as in the table probe: the transport takes none as */* (change 84).
    { method: "POST", headers: late ? { "Content-Type": RPC["Content-Type"], "x-brain-key": LEGACY_KEY } : { ...RPC, "x-brain-key": LEGACY_KEY }, body: late ?? JSON.stringify({ ...LIST, id }), ...(late ? { duplex: "half" } : {}) }))) : [];
  // The reference list is the first answer that carries one — not answers[0], which under the defect is the timeout.
  const tools = answers.map(toolsOf).find((t) => t.length > 0) ?? [];
  assert(tools.length > 0, `its tools/list under the key names its tools (${tools.length})`);
  for (const [i, r] of answers.entries()) {
    assert(r.status === 200 && r.json?.id === ids[i] && toolsOf(r).join() === tools.join(),
      `${ids.length} concurrent tools/list under one key: request ${ids[i]} is answered with its own id and the same tools (${r.status === 0 ? r.text : `${r.status}, id ${r.json?.id ?? "none"}, ${toolsOf(r).length} tools`})`);
  }
  delete process.env.MCP_ACCESS_KEY;
}

// ── The HTTP APIs ────────────────────────────────────────────────────────────

for (const s of SERVERS.filter((s) => s.kind === "rest")) {
  console.log(`\n[${s.file}]`);
  env(s, KEYS);

  assert(passed(await http(s, READ_KEY, s.readProbe!)), `a read-scoped key passes the gate on ${s.readProbe}`);
  for (const w of s.writes) {
    // A body no route could parse: the 403 has to come from the gate, before parsing.
    const r = await http(s, READ_KEY, w, "x-access-key", "{not json");
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
  const handler = handlers[SERVERS.length];
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

// ── Under bun, for real ──────────────────────────────────────────────────────
//
// Everything above drove each server's `fetch` in this process. `bun <file>`
// serves the same export: Bun starts the entry module's default export on
// PORT (SMD-1799; until then compat/deno-on-bun.ts stood in for Deno's `serve`,
// SMD-1480, FORK.md change 74). Each server on the SQL shim (which imports
// `bun`) is started here as a child process: `bun <file>` with the
// environment its README documents — PORT a port this test bound for a
// moment and released, then polled until the child answers on it; NODE_PATH,
// since a recipe or integration has no node_modules on its own path and
// resolves hono, zod and @hono/mcp from this directory's pinned install (the
// MCP SDK's subpaths it does not: Bun fetches those into its cache, SMD-1991), as its
// README says — then asked over the port for the one thing that proves it is
// that server, authenticating: an MCP server's tools/list under a write key
// is its full tool list, an API's read probe passes under a read key, a
// worker dry-runs under one, the receiver admits its secret; each refuses a
// wrong key; each is still running afterwards; then stopped. The two APIs on
// their own constant-time compare of a single key (rest-api, smart-ingest;
// not consumers of _shared/auth.ts, and check 8 passes them) are started too,
// with a probe of their own. Every file in the tree that imports the shim and
// exports the entry shape is in the list, or the guard below fails.
console.log("\n[each server on the SQL shim starts under bun and answers over the port]");
type Live = { file: string; env: Record<string, string>; probe: (base: string) => Promise<void> };
const onShim = (file: string) => /["'][^"'\n]*compat\/supabase-sql\/index\.ts["']/.test(readFileSync(join(ROOT, file), "utf8"));
const rpcHeaders = (key: string) => ({ ...RPC, "x-access-key": key });
const fill = (path: string) => path.replace(/:[a-z_]+/g, "test-id");
const LIVE: Live[] = [
  ...SERVERS.filter((s) => onShim(s.file)).map((s): Live => ({
    file: s.file,
    // work-operating-model-activation refuses to start without SUPABASE_SERVICE_ROLE_KEY (its README says to set any value); the rest read it and ignore it.
    env: { [s.keys]: KEYS, SUPABASE_URL: s.url, ...(s.file === "recipes/work-operating-model-activation/index.ts" ? { SUPABASE_SERVICE_ROLE_KEY: "unused-by-the-shim" } : {}) },
    probe: async (base) => {
      if (s.kind === "mcp") {
        const all = [...s.reads, ...s.writes].sort();
        const r = await parse(await fetch(`${base}/mcp`, { method: "POST", headers: rpcHeaders(WRITE_KEY), body: JSON.stringify(LIST) }));
        assert(r.status === 200 && toolsOf(r).join() === all.join(), `${s.file}: under bun, a write key's tools/list is its ${all.length} tool(s) (${r.status}: ${toolsOf(r).length})`);
        assert((await fetch(`${base}/mcp`, { method: "POST", headers: rpcHeaders("not-a-key"), body: JSON.stringify(LIST) })).status === 401, "…and a wrong key is refused with 401");
      } else if (s.kind === "rest") {
        const [method, path] = s.readProbe!.split(" ");
        const body = method === "GET" ? undefined : "{}";
        const r = await parse(await fetch(base + fill(path), { method, headers: rpcHeaders(READ_KEY), body }));
        assert(passed(r), `${s.file}: under bun, a read key passes the gate on ${s.readProbe} (${r.status})`);
        assert((await fetch(base + fill(path), { method, headers: rpcHeaders("not-a-key"), body })).status === 401, "…and a wrong key is refused with 401");
      } else {
        const dry = s.dryRun === "body" ? { path: "/", body: JSON.stringify({ dry_run: true }) } : { path: "/?dry_run=true", body: undefined };
        const r = await parse(await fetch(base + dry.path, { method: "POST", headers: rpcHeaders(READ_KEY), body: dry.body }));
        assert(passed(r), `${s.file}: under bun, a read key may dry-run (${r.status})`);
        assert((await fetch(base + dry.path, { method: "POST", headers: rpcHeaders("not-a-key"), body: dry.body })).status === 401, "…and a wrong key is refused with 401");
      }
    },
  })),
  { file: WEBHOOK.file, env: { [WEBHOOK.secretEnv]: WEBHOOK.secret, SUPABASE_URL: PG }, probe: async (base) => {
    const post = (body: unknown) => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const right = await post({ secret: WEBHOOK.secret, event_type: "readwise.other" });
    assert(right.status === 200 && (await right.text()) === "ignored", `${WEBHOOK.file}: under bun, the echoed secret admits the request (${right.status})`);
    assert((await post({ secret: "not-the-secret", event_type: "readwise.other" })).status === 401, "…and a wrong secret is refused with 401");
  } },
  ...([["integrations/rest-api/index.ts", "GET", "/health"], ["integrations/smart-ingest/index.ts", "POST", "/"]] as const).map(([file, method, path]): Live => ({
    file, env: { MCP_ACCESS_KEY: LEGACY_KEY, SUPABASE_URL: PG },
    probe: async (base) => {
      const body = method === "GET" ? undefined : "{}";
      const r = await fetch(base + path, { method, headers: { "x-brain-key": LEGACY_KEY, "Content-Type": "application/json" }, body });
      assert(r.status !== 401 && r.status !== 503, `${file}: under bun, the configured key passes the gate on ${method} ${path} (${r.status})`);
      assert((await fetch(base + path, { method, headers: { "x-brain-key": "not-a-key", "Content-Type": "application/json" }, body })).status === 401, "…and a wrong key is refused with 401");
    },
  })),
  // The MCP server on its own single-key compare (the section above): on the shim since SMD-1798, so started here too.
  { file: "integrations/enhanced-mcp/index.ts", env: { MCP_ACCESS_KEY: LEGACY_KEY, SUPABASE_URL: PG }, probe: async (base) => {
    const r = await parse(await fetch(`${base}/mcp`, { method: "POST", headers: { ...RPC, "x-brain-key": LEGACY_KEY }, body: JSON.stringify(LIST) }));
    assert(r.status === 200 && toolsOf(r).length === 13, `integrations/enhanced-mcp/index.ts: under bun, the configured key's tools/list is its 13 tools (${r.status}: ${toolsOf(r).length})`);
    assert((await fetch(`${base}/mcp`, { method: "POST", headers: { ...RPC, "x-brain-key": "not-a-key" }, body: JSON.stringify(LIST) })).status === 401, "…and a wrong key is refused with 401");
  } },
];
/** Bun's entry shape as the servers spell it — the tail server-portable/index.ts has — held to the letter (SMD-1799). */
const ENTRY_SHAPE = /^export default \{\n  port: Number\(process\.env\.PORT \|\| 8000\),\n  fetch: (?:app\.fetch|handler),\n\};\n/m;
{
  const inTree = [...new Bun.Glob("{extensions,recipes,integrations}/**/*.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules") && onShim(f) && ENTRY_SHAPE.test(readFileSync(join(ROOT, f), "utf8"))).sort();
  assert(inTree.join() === LIVE.map((l) => l.file).sort().join(), `every file that imports the shim and exports Bun's entry shape is started here (${inTree.length}: ${inTree.join(", ")})`);
}
const DEADLINE_MS = 30_000;
/**
 * A port nothing holds: bound for a moment and released, then handed to the child as PORT. Another process
 * may take it in between (a container publishing a port on the same host did, once, while the suite ran);
 * the child then fails to bind — Bun refuses a held port, exit 1 — or a stranger answers the poll and the
 * probe's assertions name the file. A counted failure either way, within the deadline; rerun.
 */
function freePort(): number {
  const held = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = held.port!;
  held.stop(true);
  return port;
}
for (const live of LIVE) {
  const port = freePort();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), NODE_PATH: join(HERE, "node_modules"), ...live.env };
  // The READMEs say the Supabase key variables may be left unset with the shim (the credentials are in the
  // URL); the process above set them, so they are removed here and the claim is what the start proves.
  for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "EMBEDDING_API_KEY", "CHAT_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_HOUSEHOLD_KEY", "SMART_INGEST_URL", "ENTITY_EXTRACTION_WORKER_URL"]) delete env[name];
  Object.assign(env, live.env);
  // Bun's own start line (`Started development server:`, or `Started server:` in production) goes unread: the port is known, so stdout is dropped and the
  // child is up when the port answers at all (SMD-1799).
  const proc = Bun.spawn([process.execPath, join(ROOT, live.file)], { env, cwd: ROOT, stdout: "ignore", stderr: "pipe" });
  // Up when the port answers — any status: Bun serves the file's default export on PORT, so a refused
  // connection is "not yet" — or the child exited (`exitCode` is set only when `exited` settles, and a
  // loop that polled it spun for the whole deadline; change 74's pass 1), or the deadline passed.
  const base = `http://127.0.0.1:${port}`;
  const exited = proc.exited.then(() => "exited" as const);
  const deadline = Date.now() + DEADLINE_MS;
  let up = false;
  while (!up && Date.now() < deadline) {
    const r = await Promise.race([exited, fetch(base, { signal: AbortSignal.timeout(2000) }).then(() => "up" as const, () => "down" as const)]);
    if (r === "exited") break;
    if (r === "up") { up = true; break; }
    if (await Promise.race([exited, new Promise<"tick">((res) => setTimeout(() => res("tick"), 100))]) === "exited") break;
  }
  if (up) {
    // A child that answered the port and then died fails the probe's fetch: a counted failure, not a crash of the suite.
    try { await live.probe(base); }
    catch (e) { assert(false, `${live.file}: answers over the port it was given (${e instanceof Error ? e.message : String(e)})`); }
    assert(proc.exitCode === null, "…and is still running after the probes");
  }
  // Stop the child BEFORE reading its stderr: a server alive without a port would
  // otherwise hold stderr open and the read below would hang the test (pass 1).
  const alive = proc.exitCode === null;
  proc.kill();
  await proc.exited;
  if (!up) {
    // The error line — `error: …`, `TypeError: …` — not the code frame Bun prints above it (`throw new Error(` is a frame line).
    const lines = (await new Response(proc.stderr).text()).trim().split("\n");
    const stderr = (lines.filter((l) => /^\s*(?:\w*Error|error)\b\s*:/.test(l)).slice(0, 2).concat(lines.slice(0, 2))).slice(0, 3).join(" | ");
    assert(false, `${live.file}: \`bun ${live.file}\` starts and listens on PORT (${alive ? `alive after ${DEADLINE_MS / 1000} s, port ${port} never answered` : `exit ${proc.exitCode}`}: ${stderr || "no stderr"})`);
  } else {
    assert(true, `${live.file}: \`bun ${live.file}\` starts and listens on PORT`);
  }
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
  // Claude Desktop's connectors may send no Accept header. Until change 84 the
  // servers patched one in by replacing c.req.raw before the key was read from
  // it; now the transport takes none as */* and the key is read from the request
  // as it came — either way, ?key= on a bare request authenticates.
  assert(toolsOf(await call(s, READ_KEY, LIST, "query", {}, false)).join() === [...s.reads].sort().join(),
    "a request without an Accept header still authenticates from ?key=");
  assert((await call(s, "not-a-key", LIST, "x-access-key", {}, false)).status === 401,
    "…and is still refused with a wrong key");
}
for (const s of SERVERS.filter((s) => s.health)) {
  const health = await handlers[SERVERS.indexOf(s)](new Request(`http://extension.test${s.health}`, { method: "GET" }));
  assert(health.status === 200 && (await health.json()).status === "ok", `${s.file}: the unauthenticated GET ${s.health} health check still answers`);
}

// ── Drift guards ─────────────────────────────────────────────────────────────

/** Stored functions a tool or route may call and still be a read; any other `.rpc(` is a write. */
const RPC_READS = ["crm_search_contacts_fts", "traverse_graph", "find_shortest_path", "match_thoughts", "search_thoughts_text", "brain_stats_aggregate", "get_thought_connections"];
/** Tables a READ may insert into: a recall records itself (for a write-scoped key). An update or delete on them, or an insert anywhere else, is a write. */
const LOG_TABLES = ["agent_memory_recall_traces", "agent_memory_recall_items", "agent_memory_audit_events"];
const LOG_INSERT = new RegExp(String.raw`\.from\("(?:${LOG_TABLES.join("|")})"\)\s*\.insert\(`);
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
/**
 * No McpServer that outlives a request: such a server is connect()ed to a
 * fresh transport each time, and the SDK answers on whichever transport it
 * holds when the message arrives (SMD-1497). Textually: no module-level
 * declaration (exported or not, typed or not) that names McpServer — a server,
 * a lazy `let server: McpServer | undefined`, a `Map<…, McpServer>` cache — and
 * none that holds what buildServer() returns or a Map (a cache under any name;
 * no MCP server here keeps one at module scope), and no module-level
 * StreamableHTTPTransport either — one shared across requests routes by
 * JSON-RPC id, which distinct ids would pass. A spelling check: an untyped
 * `let cached;` filled later passes it. The concurrency probe above is the
 * proof; this catches the shape before it reaches a run. The after sample's
 * per-session server is checked in TEXT_ONLY.
 */
const builtPerRequest = (text: string) =>
  !/^(?:export )?(?:const|let|var) [^\n]*(?:\bMcpServer\b|\bStreamableHTTPTransport\b|= buildServer\(|= new Map[<(])/m.test(text);
/** The Accept patch by its mechanism — every one re-wrapped the request over `c.req.raw` — not by the header it set, which an outgoing fetch may set too. */
const ACCEPT_PATCH = /Object\.defineProperty\(\s*c\.req,\s*['"]raw['"]/;
/** A published CORS allow-list, the one shape these servers use (none takes hono's cors() middleware). */
const ALLOW_HEADERS = /"Access-Control-Allow-Headers":\s*\n?\s*"([^"]+)"/;
/**
 * SMD-1668: an MCP server that publishes an allow-list names the two headers the
 * Streamable HTTP spec has a client send after initialize — a browser-hosted
 * client asks for them at preflight, and a list without them refuses the request
 * before it arrives; since @hono/mcp 0.3.x the server reads mcp-protocol-version
 * on every non-initialize POST, so that client was the one it could never see. A
 * server with no list at all is not a browser's to reach and is not held.
 */
const HELD_ALLOW_LISTS: string[] = [];
const holdsBrowserHeaders = (file: string, text: string) => {
  const list = text.match(ALLOW_HEADERS);
  if (!list) return;
  HELD_ALLOW_LISTS.push(file);
  const names = list[1].split(",").map((h) => h.trim().toLowerCase());
  for (const h of ["mcp-protocol-version", "last-event-id"]) {
    assert(names.includes(h), `${file}: Access-Control-Allow-Headers names ${h} — a browser client's preflight is refused without it (SMD-1668)`);
  }
};

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
    assert(builtPerRequest(text), "…the McpServer is built inside a function, per request: no module-level declaration names McpServer, holds what buildServer() returns, or is a `new Map` (a server that outlives the request is connect()ed to a fresh transport each time and answers on the wrong one — SMD-1497, change 78)");
    assert(!ACCEPT_PATCH.test(text),
      "…and no Accept patch: the transport at @hono/mcp 0.3.x takes a missing Accept as */* and either token as enough, so the re-wrap of every request for Claude Desktop connectors is gone (change 84)");
    holdsBrowserHeaders(s.file, text);
  } else if (s.kind === "rest") {
    const mounted = [...text.matchAll(/^app\.(get|post|put|patch|delete)\("([^"]+)",\s*(requireWrite,\s*)?/gm)]
      .map((m) => ({ route: `${m[1].toUpperCase()} ${m[2]}`, gated: Boolean(m[3]), at: m.index! }));
    assert(mounted.map((m) => m.route).sort().join() === [...s.reads, ...s.writes].sort().join(),
      `${s.file}: every mounted route is classified above (${mounted.length})`);
    assert(mounted.filter((m) => m.gated).map((m) => m.route).sort().join() === [...s.writes].sort().join(),
      `…and exactly the writes take requireWrite (${mounted.filter((m) => m.gated).length})`);
    // The last route's block ends where the entry shape begins: the wrapper that strips the Edge Function
    // path prefix (`const handler = …`), then the export (SMD-1799).
    const starts = mounted.map((m) => m.at).concat(text.search(/^(?:const handler = |export default \{)/m));
    for (const m of mounted) {
      const end = Math.min(...starts.filter((a) => a > m.at));
      const block = text.slice(m.at, end);
      const reach = withCallees(text, block);
      if (s.writes.includes(m.route)) assert(writes(reach), `…${m.route} does write (the route or a function it calls inserts, updates, upserts or deletes, or calls an RPC not listed as a read)`);
      else {
        assert(!writes(reach), `…${m.route} does not write (a read may insert its own trace; any RPC it calls is in RPC_READS)`);
        // A read that records itself does so only for a principal that could write anyway.
        if (LOG_INSERT.test(reach)) {
          // Not merely present: the check returns, and it sits before the insert (a no-op body was let through once).
          const gate = block.search(/if \(!canWrite\(c\.get\("principal"\)\)\) \{\s*return /);
          assert(gate >= 0 && gate < block.search(LOG_INSERT), `…${m.route} returns for a read-scoped key before it records its trace — the check precedes the insert and returns`);
        }
      }
    }
    assert(text.includes("authenticateRequest(c.req.raw,") && text.includes('c.set("principal", principal)'),
      "…the key is read and resolved from the request in one middleware, the principal handed to the routes");
  } else {
    assert(text.includes("authenticateRequest(req,") && text.includes("if (!canWrite(principal) && !dryRun)"),
      `${s.file}: the key is resolved from the request through the module, and a read-scoped key may only dry-run`);
  }
  assert(text.includes('from "../_shared/auth.ts"'), "…the module is ../_shared/auth.ts — the one import a function one level under supabase/functions/ resolves");
  assert(!OLD_SPELLINGS.test(text), "…and the key is compared nowhere else");
}
{
  const text = readFileSync(join(ROOT, WEBHOOK.file), "utf8");
  assert(text.includes('from "../_shared/auth.ts"') && text.includes("secretMatches(") && !/[!=]== ?READWISE_WEBHOOK_SECRET\b/.test(text),
    `${WEBHOOK.file}: the echoed secret is compared through the module's secretMatches(), digest to digest, and with no operator`);
}
{
  const file = "integrations/enhanced-mcp/index.ts";
  const text = readFileSync(join(ROOT, file), "utf8");
  assert(builtPerRequest(text) && text.includes("await buildServer().connect(transport)"),
    `${file}: the McpServer is built per request by buildServer() and connected to that request's transport (SMD-1497, change 78)`);
  assert(!ACCEPT_PATCH.test(text), `${file}: the Accept patch is gone (change 84)`);
  holdsBrowserHeaders(file, text);
}
// The rule reached the four lists the tree publishes — a list respelled (a template literal, hono's cors())
// would drop out of the regex's reach silently otherwise (first review pass).
assert(HELD_ALLOW_LISTS.length === 4,
  `the allow-list rule read four lists — delete-thought, update-thought, kubernetes-deployment, enhanced-mcp (${HELD_ALLOW_LISTS.length}: ${HELD_ALLOW_LISTS.join(", ")})`);

// The files this test cannot import — a Next.js route, a README's code block, a
// Node stub — say the same thing in their text. (The cost recipe's per-session
// sample, read here for SMD-1497's and SMD-1607's shapes, left with the recipe —
// SMD-1800.)
console.log("\n[the files this test reads but cannot run]");
const TEXT_ONLY: { file: string; must: RegExp[]; mustNot: RegExp[] }[] = [
  { file: "recipes/vercel-neon-telegram/src/app/api/telegram/route.ts",
    must: [/import \{ secretMatches \} from "@\/lib\/auth"/, /secretMatches\(req\.headers\.get\("x-telegram-bot-api-secret-token"\), expectedSecret\)/],
    mustNot: [/secret !== expectedSecret/] },
  { file: "recipes/vercel-neon-telegram/src/lib/auth.ts",
    must: [/export function secretMatches\(/, /createHash\("sha256"\)/, /timingSafeEqual\(digest\(presented\), digest\(expected\)\)/], mustNot: [] },
  { file: "integrations/telegram-capture/README.md",
    must: [/import \{ createHash, timingSafeEqual \} from "node:crypto"/, /function secretMatches\(/, /timingSafeEqual\(digest\(presented\), digest\(expected\)\)/, /if \(!secretMatches\(secret, TELEGRAM_WEBHOOK_SECRET\)\)/],
    // Deno 2 removed crypto.subtle.timingSafeEqual; a sample that calls it fails every webhook on Supabase.
    mustNot: [/secret !== TELEGRAM_WEBHOOK_SECRET/, /crypto\.subtle\.timingSafeEqual/] },
  { file: "docs/walkthroughs/ob1-agent-dashboard/demo-rest-server.mjs",
    must: [/function secretMatches\(/, /timingSafeEqual\(digest\(presented\), digest\(expected\)\)/, /secretMatches\(provided, accessKey\)/],
    mustNot: [/provided === accessKey/] },
];
for (const t of TEXT_ONLY) {
  const text = readFileSync(join(ROOT, t.file), "utf8");
  for (const re of t.must) assert(re.test(text), `${t.file} says ${re}`);
  for (const re of t.mustNot) assert(!re.test(text), `${t.file} no longer says ${re}`);
}

// One MCP stack across the tree's three installs (the recurring defect this fork
// guards against is a value defined twice): what this directory installs is what
// the vendored servers run under here and what `bun <file>` resolves for the
// extensions; server-portable/package.json is the core server's and the
// container's; integrations/kubernetes-deployment/package.json is that image's
// (SMD-1800 — until then each server carried a deno.json import map, held here to
// this file, and server/deno.json anchored the set). Every pin equal, or this
// names the package and the two versions.
{
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).devDependencies as Record<string, string>;
  // The stack is STACK's names: a test-only devDependency added here (a fixture library, say) is not
  // demanded of the image or the core server.
  const stack = Object.entries(pkg).filter(([name]) => PACKAGES.test(name));
  assert(stack.map(([n]) => n).sort().join() === [...STACK].sort().join(), `extensions/package.json installs the ${STACK.length} packages of the MCP stack (${stack.map(([n]) => n).join(", ") || "none"})`);
  const hold = (file: string, deps: Record<string, string>, exact: boolean) => {
    const drift = stack.filter(([name, version]) => deps[name] !== version);
    const extra = exact ? Object.keys(deps).filter((name) => !PACKAGES.test(name)) : [];
    assert(drift.length === 0 && extra.length === 0, `${file} pins ${exact ? "exactly " : ""}the MCP stack extensions/package.json installs${drift.length || extra.length ? ` (${[...drift.map(([n, v]) => `${n}: ${deps[n] ?? "absent"} vs ${v}`), ...extra.map((n) => `${n}: not one of the stack`)].join(", ")})` : ""}`);
  };
  // The core server installs supabase-js beside the stack for its Workers store (SMD-1847), so its set is a superset.
  hold("server-portable/package.json", JSON.parse(readFileSync(join(ROOT, "server-portable/package.json"), "utf8")).dependencies as Record<string, string>, false);
  hold("integrations/kubernetes-deployment/package.json", JSON.parse(readFileSync(join(ROOT, "integrations/kubernetes-deployment/package.json"), "utf8")).dependencies as Record<string, string>, true);
}

// ── The pinned transport, across a session ──────────────────────────────────
// A transport reused across a session (the after sample's shape) must let go
// of each POST it answers; @hono/mcp 0.1.1 kept every one until close()
// (SMD-1607; change 83, and the pin moved on with change 84). Read through
// WeakRefs after a forced GC — a FinalizationRegistry's callbacks arrive on
// the runtime's schedule — and asked for most of N, not all: one or two can
// stay reachable from the frames that answered them, and at 0.1.1 none is
// released (change 83's measurement).
// ── The pinned SDK, one server and two transports ───────────────────────────
// A second connect() on one server: SDK 1.24.3 overwrote the transport
// silently (change 78's defect; GHSA-345p-7cg4-v4c7), 1.26.0 made it throw,
// so the shape the drift guard above refuses is refused at the runtime too,
// on the first overlap (change 84).
console.log("\n[the pinned SDK, a second connect() on one server]");
{
  const { StreamableHTTPTransport } = await import("@hono/mcp");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "shared", version: "0" });
  await server.connect(new StreamableHTTPTransport());
  const second = await server.connect(new StreamableHTTPTransport()).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  assert(second !== null && /Already connected to a transport/.test(second),
    `a second connect() on one server throws rather than overwriting the transport (${second === null ? "accepted silently" : JSON.stringify(second.slice(0, 60))})`);
}

console.log("\n[the pinned @hono/mcp, one transport across a session]");
{
  const { Hono } = await import("hono");
  const { StreamableHTTPTransport } = await import("@hono/mcp");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const N = 100;
  const server = new McpServer({ name: "session", version: "0" });
  server.registerTool("ping", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const app = new Hono();
  app.post("/mcp", (c) => transport.handleRequest(c));
  const refs: WeakRef<Request>[] = [];
  const answered = await (async () => {
    let ok = 0;
    for (let id = 1; id <= N; id++) {
      const req = new Request("http://session.test/mcp", { method: "POST", headers: RPC, body: JSON.stringify({ ...LIST, id }) });
      refs.push(new WeakRef(req));
      const r = await answer((rq) => app.fetch(rq), req);
      if (r.status === 200 && r.json?.id === id && toolsOf(r).join() === "ping") ok++;
    }
    return ok;
  })();
  assert(answered === N, `${N} sequential tools/list on one transport are each answered with their own id (${answered}/${N})`);
  for (let k = 0; k < 5; k++) { Bun.gc(true); await new Promise((r) => setTimeout(r, 5)); }
  const released = refs.filter((w) => w.deref() === undefined).length;
  assert(released >= N - 10, `…and the transport has let go of them: ${released}/${N} Request objects collected after GC, ${N - 10} or more wanted (0.1.1 kept every one until close())`);

  // New at 0.3.x: every non-initialize POST is checked for `mcp-protocol-version`
  // — absent it reads as 2025-03-26; a version the SDK does not list is refused
  // 404. A client sends the version it negotiated, so no known client meets
  // it; held so a bump that moves the rule is seen here first (change 84).
  const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/sdk/types.js");
  const versioned = (v: string) => answer((rq) => app.fetch(rq), new Request("http://session.test/mcp", { method: "POST", headers: { ...RPC, "mcp-protocol-version": v }, body: JSON.stringify({ ...LIST, id: N + 1 }) }));
  const known = await versioned(LATEST_PROTOCOL_VERSION);
  const unknown = await versioned("1999-01-01");
  assert(known.status === 200 && known.json?.id === N + 1, `a POST naming the newest protocol version the SDK supports (${LATEST_PROTOCOL_VERSION}) is answered (${known.status})`);
  assert(unknown.status === 404 && /Unsupported protocol version/.test(unknown.text), `…and one naming a version it does not is refused: 404, "Unsupported protocol version" (${unknown.status})`);
}

report();
