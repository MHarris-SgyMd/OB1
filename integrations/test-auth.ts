#!/usr/bin/env bun
/**
 * test-auth.ts — every vendored server authenticates through the core server's
 * auth path: the extension servers did (SMD-1252, FORK.md change 64) until
 * SMD-2311 made the six plugins and retired meal-planning's shared server, and
 * the recipes and integrations that compared a key the same way (SMD-1455,
 * change 67) do — an HTTP API, four workers and a webhook receiver. No vendored
 * MCP server is left, so the MCP kind and the keepalive copy every MCP server's
 * reply went through (_shared/sse.ts, SMD-2001) retired with SMD-3747, and this
 * suite moved here from extensions/ with the install it runs on.
 *
 * The claim is the one server-portable/test-auth.ts makes for the core server,
 * made here for each vendored server as it is deployed: a wrong key is refused;
 * a key removed from MCP_ACCESS_KEYS stops working while its neighbour keeps
 * working; the hash is not a credential; the legacy single key still
 * authenticates, by digest now; and a read-scoped key does not merely fail to
 * write. For an HTTP API the routes that write answer 403 before they parse a
 * body; for a worker anything but a dry run answers 403. The webhook
 * receiver's secret has no scope to give and is compared digest to digest.
 * Then the drift guards: every route an API mounts is classified here as a
 * read or a write, exactly the writes are gated, each write does write and
 * each read does not, the key is read through the shared module and nowhere
 * else, every `_shared/auth.ts` is byte-for-byte server-portable/auth.ts (a
 * Supabase function is bundled from supabase/functions/, so the module is
 * copied beside the servers rather than imported across the tree), no file
 * under the three category directories imports an MCP server package or builds
 * an MCP server transport (the Vercel route on its own install aside), and the MCP stack's
 * shared pins agree across the tree's installs (this directory's,
 * server-portable's, mcp-server's).
 *
 * The files are imported as modules: each exports Bun's entry shape,
 * `export default { port, fetch }` (SMD-1799), and its `fetch` is the handler
 * driven here — console.error/warn silenced for the length of a request, since
 * a refused port is the proof and not noise. The integrations resolve their
 * packages from this directory's install, and the recipes through the committed
 * recipes/node_modules link to it (SMD-1991). Nothing stands in for `Deno`: a
 * server that still reached it would throw at import or answer 500, a counted
 * failure either way.
 * No database: nothing here reaches a handler that queries with a key that
 * would let it, or the client refuses at once (a port nothing listens on) —
 * the SQL shim and supabase-js both connect lazily, so a stub URL is never
 * dialled otherwise.
 *
 * Then, for real: every server that imports the SQL shim — which imports
 * `bun` — is what `bun <file>` serves, Bun starting the default export it
 * finds in the entry module (SMD-1480 gave these files a polyfill for the two
 * Deno members they used, change 74; SMD-1799 gave them Bun's own shape). The
 * last section starts each such file as a child process on 127.0.0.1 at a port
 * Bun picks, with the environment its README documents, asks it over HTTP for the
 * one thing that proves it is that server authenticating, and stops it. Every
 * file in the tree that imports the shim and exports the entry shape is
 * started, or this fails.
 *
 * Run: bun install && bun test-auth.ts   (in integrations/)
 */

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey, listenOn } from "./_shared/auth.ts";
import { askRaw, createAssert, leaveMidUpload, pendingSettled, secondLoopback, SERVER_STACK, SERVER_V2_PINS, STACK, childPort } from "../db/test-support.ts";

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
// A recipe or integration imports STACK's packages (hono, zod, and the MCP pair a
// server of that kind would need) by bare name and has no install of its own beside
// it. The integrations sit under this directory's install; recipes/ holds a
// committed `node_modules` link to it, so Bun's own lookup, walking up from the
// importing file, finds the pinned install from either tree, the SDK's `exports`
// subpaths included, which NODE_PATH does not reach (SMD-1991). The servers below
// are imported through it, and started through it under `--no-install`.
{
  let target = "";
  try { target = readlinkSync(join(ROOT, "recipes", "node_modules")); } catch { /* absent, or not a link */ }
  assert(target === "../integrations/node_modules", `recipes/node_modules is a link to ../integrations/node_modules (${target || "not a link"})`);
  let linked = true;
  try { readlinkSync(join(HERE, "node_modules")); } catch { linked = false; }
  assert(!linked && existsSync(join(HERE, "node_modules", "hono")), "integrations/node_modules is the install itself, not a link (bun install here)");
}

// ── The servers, and what each tool or route does to the database ───────────

const WRITE_KEY = "w".repeat(64);
const READ_KEY = "r".repeat(64);
const LEGACY_KEY = "old-style-key";
// A forwarder (SMD-2284): grants nothing; DEFAULT_ADMIT leaves it out, so to a vendored server it is no key at all.
const FORWARD_KEY = "f".repeat(64);
const KEYS = [`laptop:write:${hashKey(WRITE_KEY)}`, `chatgpt:read:${hashKey(READ_KEY)}`].join(",");

type Kind = "rest" | "worker";
type Server = {
  /** Relative to the repository root. */
  file: string;
  kind: Kind;
  /** The env names this server reads its keys from (the auditor has its own). */
  keys: string;
  legacy: string;
  /** What SUPABASE_URL must look like: the SQL shim wants postgres:// (every server is on it since SMD-1798). */
  url: string;
  /** HTTP: "METHOD /path". A worker has one operation, gated by dry_run. */
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
const vendored = (file: string, kind: Kind, reads: string[], writes: string[], o: Partial<Server> = {}): Server =>
  ({ file, kind, keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG, reads, writes, ...o });
// To add a server: one entry below — `url` PG_REFUSED when a handler queries
// before it can answer (every server is on the SQL shim since SMD-1798; the
// HTTPS stubs supabase-js took went with it); `kind` picks the assertions; a REST server
// lists its routes as "METHOD /path" and needs `readProbe`, a worker `dryRun`
// and `unconfigured`. Then, as needed: RPC_READS and LOG_TABLES for what its
// reads may call; STACK (db/test-support.ts) and this directory's package.json for a new
// npm package (the pin guard then holds the other two installs to it); a TEXT_ONLY entry for a file
// that cannot run; COPIES and package.json's sync-auth for a new _shared/. A
// REST server's routes must be mounted `app.<verb>("…", …)` at column 0, or
// the classifier cannot see them.
const SERVERS: Server[] = [
  // The extension servers (change 64) are gone: the six are plugins since SMD-2311, served by the brain itself, and
  // meal-planning's shared server retired with them. The recipes and integrations (change 67): no MCP server among
  // them, so the MCP kind retired with SMD-3747 (the guard below fails a vendored file that builds a transport).
  vendored("integrations/agent-memory-api/index.ts", "rest",
    ["GET /health", "POST /recall", "GET /memories/review", "GET /memories", "GET /memories/:id", "GET /recall-traces/:request_id"],
    ["POST /writeback", "POST /recall/:request_id/usage", "PATCH /memories/:id/review"], { url: PG_REFUSED, readProbe: "POST /recall" }),
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
// (the one command that rewrites them all) must agree. (sse.ts's copy, the
// keepalive every vendored MCP server's reply went through, retired with the
// last of them: SMD-3747.)
const COPIES = ["recipes/editorial-policy/_shared/auth.ts", "integrations/_shared/auth.ts", "integrations/consolidation-workers/_shared/auth.ts"];
{
  const core = readFileSync(join(ROOT, "server-portable", "auth.ts"), "utf8");
  for (const copy of COPIES) {
    assert(existsSync(join(ROOT, copy)) && readFileSync(join(ROOT, copy), "utf8") === core,
      `${copy} is byte-for-byte server-portable/auth.ts — \`bun run sync-auth\` here rewrites every copy`);
  }
  const inTree = [...new Bun.Glob("{extensions,recipes,integrations}/**/_shared/{auth,sse}.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules")).sort();
  assert(inTree.join() === [...COPIES].sort().join(), `every _shared/auth.ts in the tree is listed here and vice versa, and no _shared/sse.ts is left (${inTree.join(", ")})`);
  const sync = (JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).scripts as Record<string, string>)["sync-auth"] ?? "";
  const named = /^for d in ([\w./ -]+); do cp \.\.\/server-portable\/auth\.ts "\$d\/auth\.ts"; done$/.exec(sync);
  const dirs = COPIES.map((copy) => relative(HERE, join(ROOT, dirname(copy))).replace(/\\/g, "/")).sort();
  assert(named !== null && named[1].trim().split(/\s+/).sort().join() === dirs.join(),
    `package.json's sync-auth copies server-portable/auth.ts into exactly the copies' directories (${dirs.join(", ")}), a plain list, and does nothing else (${sync})`);
}

// The workers refuse with 503 before they touch the queue when no LLM key is
// configured — the clean "past the gate" signal this test wants; the shell's
// keys must not reach them. The servers read their access keys per request, so
// they can be set and unset from here; the rest is read once, at import.
for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "EMBEDDING_API_KEY", "CHAT_API_KEY", "SMART_INGEST_URL", "ENTITY_EXTRACTION_WORKER_URL"]) delete process.env[name]; // the two URL knobs (SMD-2110): a shell's non-http value would fail a server's start here for reasons of its own
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.MCP_ACCESS_KEYS = KEYS;
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

/** How long an in-process request may take before it is called a hang — a handler answers in single-digit ms here, and a query is refused at once. */
const REQUEST_MS = 2000;
// The silencer is counted, not saved and restored per call: two requests in
// flight at once (an MCP server's overlapping probe was one, until SMD-3747) would otherwise each save the
// other's no-op and leave the console dark for the rest of the run.
const CONSOLE = { error: console.error, warn: console.warn };
let hushed = 0;
function hush() { if (hushed++ === 0) { console.error = () => {}; console.warn = () => {}; } }
function unhush() { if (--hushed === 0) Object.assign(console, CONSOLE); }

/** One request to server `s`; `also` carries further presented forms beside the one under test. */
async function request(s: Server, key: string | null, via: Via, also: Partial<Record<Via, string>>,
  init: { method: string; path: string; body?: unknown; rawBody?: string; accept?: boolean }): Promise<Reply> {
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
  return answer(handler, new Request(url, { method: init.method, headers, body }));
}
/** One request to one handler, in process, with a deadline. */
async function answer(handler: Handler, req: Request): Promise<Reply> {
  // A handler that queries a refused port logs the refusal; the status is the assertion, the log is noise on a green run.
  hush();
  // Every request has a deadline: a handler that never answers (an MCP server's
  // crossed transports parked one, SMD-1497) is reported as a timeout with status 0, not
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
/** An HTTP API request, `route` as "METHOD /path" with any `:param` filled in; an empty JSON object as the body unless `rawBody` says otherwise. */
const http = (s: Server, key: string | null, route: string, via: Via = "x-access-key", rawBody?: string) => {
  const [method, path] = route.split(" ");
  return request(s, key, via, {}, { method, path: path.replace(/:[a-z_]+/g, "test-id"), body: method === "GET" ? undefined : {}, rawBody });
};
/** A worker run, dry or not, the key in the form given. */
const run = (s: Server, key: string | null, dryRun: boolean, via: Via = "x-access-key") =>
  request(s, key, via, {}, s.dryRun === "body"
    ? { method: "POST", path: "/", body: { dry_run: dryRun } }
    : { method: "POST", path: dryRun ? "/?dry_run=true" : "/", body: undefined });
/** Past the gate: whatever the handler answers once the key and the scope let it through — not a refusal by another status. */
const passed = (r: Reply) => r.status !== 401 && r.status !== 403 && !/access key|read-scoped/i.test(r.text);

const env = (s: Server, keys: string | undefined, legacy?: string) => {
  if (keys === undefined) delete process.env[s.keys]; else process.env[s.keys] = keys;
  if (legacy === undefined) delete process.env[s.legacy]; else process.env[s.legacy] = legacy;
};

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

  env(s, `${KEYS},mcp-forwarder:forward:${hashKey(FORWARD_KEY)}`);
  assert((await http(s, FORWARD_KEY, s.readProbe!)).status === 401, "a configured forwarder key is refused with 401 — it grants nothing, and no vendored server admits it (SMD-2284)");
  env(s, `chatgpt:read:${hashKey(READ_KEY)}`);

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

  env(s, `${KEYS},mcp-forwarder:forward:${hashKey(FORWARD_KEY)}`);
  assert((await run(s, FORWARD_KEY, true)).status === 401, "a configured forwarder key is refused with 401, even for a dry run — it grants nothing, and no vendored worker admits it (SMD-2284)");

  env(s, undefined, LEGACY_KEY);
  assert(passed(await run(s, LEGACY_KEY, false)), `the legacy single ${s.legacy} still authenticates, as write`);
  assert((await run(s, "nope", false)).status === 401, "…and a wrong legacy key is refused");
  env(s, undefined, undefined);
  assert((await run(s, LEGACY_KEY, false)).status === s.unconfigured, `no keys configured at all answers ${s.unconfigured} to everything`);
  env(s, KEYS);
}

// The auditor reads AUDITOR_ACCESS_KEYS alone: the brain's MCP_ACCESS_KEYS, set for the other servers, is no key to it.
{
  const auditor = SERVERS.find((x) => x.keys === "AUDITOR_ACCESS_KEYS")!;
  env(auditor, undefined, undefined);
  process.env.MCP_ACCESS_KEYS = KEYS;
  const borrowed = await run(auditor, WRITE_KEY, true);
  assert(borrowed.status === 401, `${auditor.file}: with its own keys unset, a key in the brain's MCP_ACCESS_KEYS is refused (${borrowed.status})`);
  env(auditor, KEYS);
}

// Each form a key may travel in, at each worker: a read key's dry run passes, its real run is refused, and a wrong key
// in it is refused even for a dry run, through every form (the auditor's own schedule sends ?key=). Asked of an MCP server's tools/list until the last left (SMD-3747).
for (const s of SERVERS.filter((s) => s.kind === "worker")) {
  env(s, KEYS);
  for (const via of ["x-access-key", "x-brain-key", "bearer", "query"] as Via[]) {
    const dry = await run(s, READ_KEY, true, via);
    const real = await run(s, READ_KEY, false, via);
    const wrong = await run(s, "not-a-key", true, via);
    assert(passed(dry) && real.status === 403 && wrong.status === 401,
      `${s.file}: the ${via} form authenticates, scope applies through it, and a wrong key in it is refused even for a dry run (dry ${dry.status}, real ${real.status}, wrong ${wrong.status})`);
  }
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
// environment its README documents, and PORT 0 and OB1_LISTEN_HOST 127.0.0.1 beside it,
// the port read from Bun's start line and polled until the child answers on it; with
// `--no-install` and no NODE_PATH, so a recipe or integration finds its packages
// through the install and link above or fails to start, rather than having Bun
// fetch them from npm (SMD-1991) — then asked over the port for the one thing that proves it is
// that server, authenticating: an API's read probe passes under a read key, a
// worker dry-runs under one, the receiver admits its secret; each refuses a
// wrong key; each is still running afterwards and not reached at a second loopback address; then stopped. The API on its
// own constant-time compare of a single key (smart-ingest; its key is not
// _shared/auth.ts's — it takes only routable and listenOn from it — and check 8 passes
// it) is started too, with a probe of its own. Every file
// in the tree that imports the shim and exports the entry shape is in the
// list, or the guard below fails.
console.log("\n[each server on the SQL shim starts under bun and answers over the port]");
type Live = { file: string; env: Record<string, string>; probe: (base: string) => Promise<void> };
const onShim = (file: string) => /["'][^"'\n]*compat\/supabase-sql\/index\.ts["']/.test(readFileSync(join(ROOT, file), "utf8"));
const rpcHeaders = (key: string) => ({ ...RPC, "x-access-key": key });
const fill = (path: string) => path.replace(/:[a-z_]+/g, "test-id");
const LIVE: Live[] = [
  ...SERVERS.filter((s) => onShim(s.file)).map((s): Live => ({
    file: s.file,
    env: { [s.keys]: KEYS, SUPABASE_URL: s.url },
    probe: async (base) => {
      if (s.kind === "rest") {
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
  ...([["integrations/smart-ingest/index.ts", "POST", "/"]] as const).map(([file, method, path]): Live => ({
    file, env: { MCP_ACCESS_KEY: LEGACY_KEY, SUPABASE_URL: PG },
    probe: async (base) => {
      const body = method === "GET" ? undefined : "{}";
      const r = await fetch(base + path, { method, headers: { "x-brain-key": LEGACY_KEY, "Content-Type": "application/json" }, body });
      assert(r.status !== 401 && r.status !== 503, `${file}: under bun, the configured key passes the gate on ${method} ${path} (${r.status})`);
      assert((await fetch(base + path, { method, headers: { "x-brain-key": "not-a-key", "Content-Type": "application/json" }, body })).status === 401, "…and a wrong key is refused with 401");
      assert((await fetch(base + path, { method, headers: { "x-brain-key": "x".repeat(LEGACY_KEY.length), "Content-Type": "application/json" }, body })).status === 401,
        "…and so is a wrong key of the right length: its compare is of the key, not of its length");
    },
  })),
];
/**
 * Bun's entry shape as the servers spell it, held to the letter (SMD-1799), found with the listen line or without it,
 * so a server written from an older tail is still listed here and failed for the line, not passed over (SMD-3323 PR 2b).
 */
const ENTRY_SHAPE = /^export default \{\n  port: Number\(process\.env\.PORT \|\| 8000\),\n(  \.\.\.listenOn\(process\.env\.OB1_LISTEN_HOST\),\n)?  fetch: (?:app\.fetch|handler),\n\};\n/m;
{
  const tails = [...new Bun.Glob("{extensions,recipes,integrations}/**/*.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules") && onShim(f)).sort()
    .flatMap((f) => { const m = ENTRY_SHAPE.exec(readFileSync(join(ROOT, f), "utf8")); return m ? [{ f, held: m[1] !== undefined }] : []; });
  const inTree = tails.map((t) => t.f);
  assert(inTree.join() === LIVE.map((l) => l.file).sort().join(), `every file that imports the shim and exports Bun's entry shape is started here (${inTree.length}: ${inTree.join(", ")})`);
  const unheld = tails.filter((t) => !t.held).map((t) => t.f);
  assert(unheld.length === 0, `…and each spreads listenOn(process.env.OB1_LISTEN_HOST) between port and fetch (${unheld.join(", ") || "all do"})`);
}
// The vendored servers' listen options (SMD-3323 PR 2b): unset or blank every address, an IP address the one, anything
// else thrown in words, the value never said.
{
  const planted = "Zq9XwVk7Jp4RmT";
  const thrown = (raw: string) => { try { listenOn(raw); return ""; } catch (e) { return (e as Error).message; } };
  const said = thrown(planted);
  assert(JSON.stringify([listenOn(undefined), listenOn("  "), listenOn(" 127.0.0.1 "), listenOn("::1")]) === JSON.stringify([{}, {}, { hostname: "127.0.0.1" }, { hostname: "::1" }])
    && said.startsWith("OB1_LISTEN_HOST (a value not shown) is not an IP address") && !said.includes("Zq9X") && thrown("fe80::1").includes("link-local"),
    `listenOn: blank every address, an IP address the one, a name or a link-local address thrown in words (${said})`);
}
// Each server started here is off the dual-stack wildcard, the bind macOS can put on a port another app holds on
// 127.0.0.1: a second loopback address, probed, does not reach it (SMD-3323 PR 2b). An IPv4 wildcard escapes the row
// where that address is [::1], and is no hazard: a bind there skips a port held on 127.0.0.1.
const second = await secondLoopback();
const answeredElsewhere: string[] = [];
let askedElsewhere = 0;
let metElsewhere = 0;
const DEADLINE_MS = 30_000;
for (const live of LIVE) {
  // PORT 0: the child binds a port no one holds and says which in Bun's start line. A port bound here for a moment
  // and freed for it could be taken in between (a container publishing a port on the same host did, once, while the
  // suite ran), and a stranger would answer the poll (SMD-3296).
  // On 127.0.0.1, where it is dialled: on every address, macOS can give it a port another app holds on 127.0.0.1, which
  // then answers the poll (SMD-3323 PR 2b).
  const env: Record<string, string | undefined> = { ...process.env, PORT: "0", ...live.env, OB1_LISTEN_HOST: "127.0.0.1" };
  // The READMEs say the Supabase key variables may be left unset with the shim (the credentials are in the
  // URL); the process above set them, so they are removed here and the claim is what the start proves.
  // A NODE_PATH from the shell goes too: an integration's packages resolve from the install above it, a recipe's through the committed link, or not at all (SMD-1991).
  for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "EMBEDDING_API_KEY", "CHAT_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SMART_INGEST_URL", "ENTITY_EXTRACTION_WORKER_URL", "NODE_PATH"]) delete env[name];
  Object.assign(env, live.env);
  // Bun's own start line (`Started development server:`, or `Started server:` in production) gives the port, 0 if
  // the child exits first; the child is up when that port answers at all (SMD-1799). `--no-install`: a package that
  // does not resolve fails the start, where Bun would otherwise fetch the latest from npm into its cache (SMD-1991).
  const proc = Bun.spawn([process.execPath, "--no-install", join(ROOT, live.file)], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + DEADLINE_MS;
  const { port } = await childPort(proc, DEADLINE_MS);
  // Up when the port answers — any status: Bun serves the file's default export on PORT, so a refused
  // connection is "not yet" — or the child exited (`exitCode` is set only when `exited` settles, and a
  // loop that polled it spun for the whole deadline; change 74's pass 1), or the deadline passed.
  const base = `http://127.0.0.1:${port}`;
  const exited = proc.exited.then(() => "exited" as const);
  const askSecond = () => fetch(`http://${second}:${port}/`, { signal: AbortSignal.timeout(2_000) }).then(() => "answered", (e: Error) => (e.name === "TimeoutError" ? "timed out" : "refused"));
  let at2 = "refused";
  let up = false;
  while (port > 0 && !up && Date.now() < deadline) {
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
    if (second !== null) { at2 = await askSecond(); askedElsewhere++; }
  }
  // Stop the child BEFORE reading its stderr: a server alive without a port would
  // otherwise hold stderr open and the read below would hang the test (pass 1).
  // A child with no start line has usually just exited, its stdout ended a moment before its exit code is set: waited
  // for, so it is said as an exit, not as alive (SMD-3296).
  if (port === 0) await Promise.race([exited, Bun.sleep(1_000)]);
  const alive = proc.exitCode === null;
  proc.kill();
  await proc.exited;
  // An answer there is the child's only if it stops with the child: a bind on 127.0.0.1 skips no port another app
  // holds on [::1] alone, and that app's listener still answers, as PR 2a's rows accept (healthAt). A holder that
  // exits between the two asks would be blamed on the child: rare, and a failure, never a pass.
  if (at2 !== "refused") {
    if ((await askSecond()) === "refused") answeredElsewhere.push(`${live.file}: ${at2}`);
    else { metElsewhere++; console.log(`  ·  ${live.file}: another app's listener holds ${second} at port ${port} (${at2}), not the child`); }
  }
  if (!up) {
    // The error line — `error: …`, `TypeError: …` — not the code frame Bun prints above it (`throw new Error(` is a frame line).
    const lines = (await new Response(proc.stderr).text()).trim().split("\n");
    const stderr = (lines.filter((l) => /^\s*(?:\w*Error|error)\b\s*:/.test(l)).slice(0, 2).concat(lines.slice(0, 2))).slice(0, 3).join(" | ");
    assert(false, `${live.file}: \`bun ${live.file}\` starts and listens on PORT (${alive ? `alive after ${DEADLINE_MS / 1000} s, ${port ? `port ${port} never answered` : "no start line"}` : `exit ${proc.exitCode}`}: ${stderr || "no stderr"})`);
  } else {
    assert(true, `${live.file}: \`bun ${live.file}\` starts and listens on PORT`);
  }
}

assert(second !== null && askedElsewhere > 0 && answeredElsewhere.length === 0, `every vendored server started here is off the dual-stack wildcard: ${second === null ? "no second loopback address answered a probe, so none was asked" : askedElsewhere === 0 ? "no child came up to be asked" : `${second} reaches none (${askedElsewhere} asked, ${metElsewhere} met another app's listener there; ${answeredElsewhere.join("; ") || "no child answered"})`}`);

// ── Where the key may travel ─────────────────────────────────────────────────

console.log("\n[where the key may travel]");
for (const s of SERVERS.filter((s) => s.kind === "rest" && s.writes.length > 0)) {
  // Each form a key may travel in authenticates, and the scope applies through it: a read key passes the read probe
  // and is told a write route writes, and a wrong key in it is refused. (An MCP server's tools/list asked this until the last left: SMD-3747.)
  env(s, KEYS);
  for (const via of ["x-access-key", "x-brain-key", "bearer", "query"] as Via[]) {
    const read = await http(s, READ_KEY, s.readProbe!, via);
    const write = await http(s, READ_KEY, s.writes[0], via, "{not json");
    const wrong = await http(s, "not-a-key", s.readProbe!, via);
    assert(passed(read) && write.status === 403 && /read-scoped/.test(write.text) && wrong.status === 401,
      `${s.file}: the ${via} form authenticates, scope applies through it, and a wrong key in it is refused (${read.status}, ${write.status}, ${wrong.status})`);
  }
}
{
  // Every form presented is tried: a gateway's own token in Authorization, or a
  // stale header a client keeps sending, does not shadow the key the client means.
  // Asked of the first HTTP API, at its read probe and its first write route: the
  // auth module is the same byte copy behind every vendored server. Past the gate is the assertion: the handler's own answer
  // after it (a refused database here) is no refusal of the key.
  const s = SERVERS.find((x) => x.kind === "rest")!;
  env(s, KEYS);
  const at = (route: string, key: string | null, via: Via, also: Partial<Record<Via, string>>, accept = true) => {
    const [method, path] = route.split(" ");
    return request(s, key, via, also, { method, path: fill(path), body: method === "GET" ? undefined : {}, accept });
  };
  assert(passed(await at(s.readProbe!, READ_KEY, "query", { bearer: "eyJ.a.gateway-jwt" })),
    `${s.file}: a gateway's bearer token beside a right ?key= does not shadow it`);
  assert(passed(await at(s.writes[0], WRITE_KEY, "x-access-key", { "x-brain-key": "stale" })),
    `${s.file}: a wrong x-brain-key beside a right x-access-key does not shadow it (${s.writes[0]}, a write, passes the gate)`);
  assert((await at(s.readProbe!, "wrong-one", "query", { bearer: "wrong-two", "x-brain-key": "wrong-three" })).status === 401,
    "three wrong forms are three refusals, not one acceptance");
  // Claude Desktop's connectors may send no Accept header (change 84): the key is
  // read from the request as it came, so ?key= on a bare request authenticates.
  assert(passed(await at(s.readProbe!, READ_KEY, "query", {}, false)), "a request without an Accept header still authenticates from ?key=");
  assert((await at(s.readProbe!, "not-a-key", "x-access-key", {}, false)).status === 401, "…and is still refused with a wrong key");
}
for (const s of SERVERS.filter((s) => s.health)) {
  const health = await handlers[SERVERS.indexOf(s)](new Request(`http://extension.test${s.health}`, { method: "GET" }));
  assert(health.status === 200 && (await health.json()).status === "ok", `${s.file}: the unauthenticated GET ${s.health} health check still answers`);
}

// ── A request URL that will not parse ────────────────────────────────────────

console.log("\n[a Host the URL parser refuses, none, userinfo or a path: each server that reads its URL answers as at localhost, never a 500 (SMD-2595)]");
{
  // Bun builds req.url from the Host header unchecked: `x:99999`, `[::1`,
  // `brain.example.test:abc` and `::1:8000` leave a URL that will not parse;
  // no Host (HTTP/1.0), userinfo or a path leave the bare request target. Each
  // server that reads its URL is served here and asked over a raw socket,
  // since fetch sends a Host of its own: at Host localhost, the control, and at
  // each of those, every answer with the control's status and the word that
  // names the route the control reached. No row reaches a store or a model.
  // smart-ingest reads its one key at import, so it is imported here with
  // it set, and the environment put back after.
  const saved = { key: process.env.MCP_ACCESS_KEY, url: process.env.SUPABASE_URL };
  const singleKey: Record<string, Handler> = {};
  let importFailed: unknown = null;
  process.env.MCP_ACCESS_KEY = LEGACY_KEY;
  process.env.SUPABASE_URL = PG_REFUSED;
  hush(); // smart-ingest warns at import that no extraction worker is set
  try {
    for (const file of ["integrations/smart-ingest/index.ts"]) singleKey[file] = await importServer(file);
  } catch (e) {
    importFailed = e;
  } finally {
    unhush();
    if (saved.key === undefined) delete process.env.MCP_ACCESS_KEY; else process.env.MCP_ACCESS_KEY = saved.key;
    process.env.SUPABASE_URL = saved.url;
  }
  const handlerOf = (file: string): Handler | undefined => singleKey[file] ?? handlers[SERVERS.findIndex((s) => s.file === file)];
  const ask = (port: number, method: string, target: string, host: string | null, headers: string[], body: string) =>
    askRaw(port, method, target, host, ["content-type: application/json", ...headers], body);
  const HOSTS = ["x:99999", "[::1", "brain.example.test:abc", "::1:8000", null, "a@brain.example.test", "brain.example.test/x"];
  const read = [`x-brain-key: ${READ_KEY}`], legacy = [`x-brain-key: ${LEGACY_KEY}`];
  /** A request, the status it gets at localhost and a word its body holds at every Host: each row names the route it reached. */
  type Row = [method: string, target: string, headers: string[], status: number, says: string];
  const worker: Row[] = [["POST", "/", [], 401, "Unauthorized"], ["POST", "/", read, 403, "dry_run=true"], ["POST", `/?dry_run=true&key=${READ_KEY}`, [], 503, "API key"]];
  const ROWS: [string, Row[]][] = [
    // The prefix stripped from a URL that parses: the route is reached under it.
    ["integrations/agent-memory-api/index.ts", [["GET", "/health", [], 401, "access key"], ["POST", "/agent-memory-api/writeback", read, 403, "write"], ["GET", "/agent-memory-api/none", read, 404, "Not Found"]]],
    ["integrations/consolidation-workers/bio/index.ts", worker],
    ["integrations/consolidation-workers/metadata-norm/index.ts", worker],
    ["integrations/entity-extraction-worker/index.ts", worker],
    ["integrations/smart-ingest/index.ts", [["POST", "/smart-ingest", legacy, 400, "text"], ["POST", "/smart-ingest/execute", legacy, 400, "job_id"], ["POST", "/", [], 401, "Unauthorized"]]],
  ];
  const why = importFailed instanceof Error ? importFailed.message : String(importFailed);
  for (const [file] of ROWS) if (!handlerOf(file)) assert(false, `${file}: has a handler to serve — it is in neither SERVERS nor the single-key imports above, or it failed to import${importFailed ? ` (${why})` : ""}`);
  const servers = new Map(ROWS.filter(([file]) => handlerOf(file)).map(([file]) => [file, Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handlerOf(file)! })]));
  for (const s of SERVERS) if (servers.has(s.file)) env(s, KEYS);
  // A server logs what it refuses (a URL, a body cut short) on console.error:
  // silenced while asked, the verdicts kept and asserted after, since a
  // failure is said there too.
  const verdicts: [boolean, string][] = [];
  hush();
  try {
    for (const [file, rows] of ROWS) {
      const port = servers.get(file)?.port;
      if (port === undefined) continue;
      for (const [method, target, headers, status, says] of rows) {
        const body = method === "GET" ? "" : "{}";
        const control = await ask(port, method, target, "localhost", headers, body);
        const at: { host: string; status: number; says: boolean }[] = [];
        for (const host of HOSTS) {
          const r = await ask(port, method, target, host, headers, body);
          at.push({ host: host ?? "none", status: r.status, says: r.body.includes(says) });
        }
        const name = `${method} ${target.replace(READ_KEY, "<key>")}${headers.length ? " keyed" : ""}`;
        verdicts.push([control.status === status && control.body.includes(says) && at.every((a) => a.status === status && a.says),
          `${file}: ${name} → ${status}, saying ${JSON.stringify(says)}, at every Host as at localhost (localhost ${control.status} ${JSON.stringify(control.body.slice(0, 60))}; ${at.map((a) => `${a.host} ${a.status}${a.says ? "" : " not saying it"}`).join(", ")})`]);
      }
    }
    // A client that leaves mid-upload leaves no request behind: the body a
    // server is handed throws when the client leaves, as the request's own
    // does, where a copy made by `new Request(url, req)` never settles and its
    // handler waits forever. Each server that reads a body, at a route that
    // reads it.
    const write = [`x-brain-key: ${WRITE_KEY}`];
    for (const [file, target, headers] of [["integrations/agent-memory-api/index.ts", "/writeback", write], ["integrations/smart-ingest/index.ts", "/", legacy]] as const) {
      const server = servers.get(file);
      if (!server) continue;
      for (const host of ["localhost", "x:99999", null]) {
        const held = await leaveMidUpload(server, target, host, [...headers], '{"text":"part');
        const left = await pendingSettled(server);
        verdicts.push([held === 1 && left === 0, `${file}: POST ${target} at ${host === null ? "no Host" : `Host ${host}`}, the client leaving mid-upload, leaves no request pending (as it left ${held}, after ${left})`]);
      }
    }
  } finally {
    unhush();
    for (const server of servers.values()) server.stop(true);
  }
  for (const [ok, said] of verdicts) assert(ok, said);
}

// ── Drift guards ─────────────────────────────────────────────────────────────

/** Stored functions a tool or route may call and still be a read; any other `.rpc(` is a write. */
const RPC_READS = ["match_thoughts", "search_thoughts_text", "brain_stats_aggregate", "get_thought_connections"];
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
const OLD_SPELLINGS = /c\.req\.query\("key"\)|c\.req\.header\("x-access-key"\)|[!=]== ?(?:process\.env\.)?(?:MCP|AUDITOR)_ACCESS_KEY\b|isAuthorized\(|\bauth\(c\)/;

console.log("\n[the files say what this test assumes]");
for (const s of SERVERS) {
  const text = readFileSync(join(ROOT, s.file), "utf8");
  if (s.kind === "rest") {
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
  // No vendored file builds @hono/mcp's transport: the MCP kind that held such a server (built per request, its
  // reply kept alive, its allow-list naming the browser headers) retired with the last of them (SMD-3747). A new
  // vendored MCP server brings that kind back first. (The Next.js route on Vercel builds the SDK's own transport, on
  // Node, from its own install; it is not a Bun server.)
  // An MCP server, by what it imports (@hono/mcp, the v1 SDK's server, the v2 server or node packages) or by a
  // server transport it builds (the spellings probed below: spaced, namespaced, generic; Streamable HTTP, SSE or stdio).
  const IMPORTS = /\b(?:from\s*|(?:import|require)\s*\(\s*)["'`][^"'`]*(?:@hono\/mcp|@modelcontextprotocol\/(?:sdk\/server|server|node))\b/;
  const BUILDS = /\bnew\s+(?:[\w$]+\.)?\w*(?:StreamableHTTP(?!Client)|SSEServer|StdioServer)\w*Transport\b/;
  const TRANSPORT = { test: (text: string) => IMPORTS.test(text) || BUILDS.test(text) };
  const VERCEL_ROUTE = "recipes/vercel-neon-telegram/src/app/api/mcp/route.ts";
  const scripts = [...new Bun.Glob("{extensions,recipes,integrations}/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}").scanSync({ cwd: ROOT })]
    .filter((f) => !f.split("/").includes("node_modules") && f !== "integrations/test-auth.ts" && f !== "integrations/test-writes.ts");
  const building = scripts.filter((f) => TRANSPORT.test(readFileSync(join(ROOT, f), "utf8"))).sort();
  assert(building.join() === VERCEL_ROUTE, `no vendored script imports an MCP server package or builds an MCP server transport, so none needs the retired MCP kind; the Vercel route alone, on Node from its own install (${building.join(", ") || "none"})`);
  const caught = ["new WebStandardStreamableHTTPServerTransport(", "new StreamableHTTPTransport(", "new  StreamableHTTPTransport (", "new\nStreamableHTTPTransport(",
    "new mcp.StreamableHTTPTransport(", "new StreamableHTTPTransport<X>(", "new SSEServerTransport(", "new StdioServerTransport(", "new NodeStreamableHTTPServerTransport(",
    'import { StreamableHTTPTransport } from "@hono/mcp";', 'import { StreamableHTTPTransport } from "../node_modules/@hono/mcp/dist/index.js";', "const m = await import(`@hono/mcp`);", 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";', 'const m = await import("@modelcontextprotocol/server");'];
  const missed = caught.filter((t) => !TRANSPORT.test(t));
  assert(missed.length === 0 && !TRANSPORT.test('import { Client } from "@modelcontextprotocol/sdk/client/index.js";') && !TRANSPORT.test("new StreamableHTTPClientTransport("),
    `…and the rule reads each import and spelling of a server probed here, and no client (its own probe; missed: ${missed.join(" | ") || "none"})`);
}

// The files this test cannot import — a Next.js route, a README's code block —
// say the same thing in their text. (The cost recipe's per-session sample, read
// here for SMD-1497's and SMD-1607's shapes, left with the recipe — SMD-1800;
// the Agent Dashboard walkthrough's Node stub left with the Next dashboards —
// SMD-3309.)
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
];
for (const t of TEXT_ONLY) {
  const text = readFileSync(join(ROOT, t.file), "utf8");
  for (const re of t.must) assert(re.test(text), `${t.file} says ${re}`);
  for (const re of t.mustNot) assert(!re.test(text), `${t.file} no longer says ${re}`);
}

// One MCP stack per install (the recurring defect this fork guards against is a
// value defined twice): what this directory installs is what the vendored servers
// run under here and what `bun <file>` resolves for them (SMD-1800 —
// until then each server carried a deno.json import map, held here to this file,
// and server/deno.json anchored the set). It stays on STACK's v1 stack.
// server-portable moved to the v2 scoped packages in SMD-2278 (stage 1 of the SDK
// v2 migration), so during the window it is held to SERVER_STACK while this
// install is held to STACK; stages 2 and 3 (SMD-2279, SMD-2281) fold the vendored
// servers onto v2 and the split closes. (The Kubernetes image's install, held here
// exactly to STACK, retired with it: SMD-2288.)
// Every pin equal, or this names the package and the two versions.
{
  const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
  // The integrations sit under this install, so a `bun add` run in one with no package.json of its own writes here,
  // into `dependencies`; the install keeps devDependencies alone, so that lands as a failure, not as a pin.
  assert(manifest.dependencies === undefined, `integrations/package.json has no dependencies, only the test install's devDependencies: a \`bun add\` in an integration folder with no package.json of its own writes here (${Object.keys(manifest.dependencies ?? {}).join(", ")})`);
  const pkg = manifest.devDependencies as Record<string, string>;
  // The stack is STACK's names: a test-only devDependency added here (a fixture library, say) is not
  // demanded of the core server.
  const stack = Object.entries(pkg).filter(([name]) => STACK.includes(name));
  assert(stack.map(([n]) => n).sort().join() === [...STACK].sort().join(), `integrations/package.json installs the ${STACK.length} packages of the MCP stack (${stack.map(([n]) => n).join(", ") || "none"})`);
  // server-portable is on the v2 stack (SMD-2278). It shares hono+zod with the
  // vendored servers — held to this install's versions — pins the v2 MCP packages to
  // SERVER_V2_PINS (the independent truth while server-portable and mcp-server are the v2 installs), and the
  // v1 MCP packages must be gone. It installs packages beside the stack, so its set
  // is a superset (no exact check). The
  // MCP server as a REST client (mcp-server/, SMD-2287) installs the same
  // stack, so a tool's schema built with server-portable's zod and the SDK
  // that validates it agree: held the same way.
  for (const file of ["server-portable/package.json", "mcp-server/package.json"]) {
    const deps = JSON.parse(readFileSync(join(ROOT, file), "utf8")).dependencies as Record<string, string>;
    const shared = stack.filter(([name]) => SERVER_STACK.includes(name)); // hono, zod
    const sharedDrift = shared.filter(([name, version]) => deps[name] !== version);
    const v2Drift = Object.entries(SERVER_V2_PINS).filter(([name, version]) => deps[name] !== version);
    const stale = STACK.filter((name) => !SERVER_STACK.includes(name) && deps[name] !== undefined); // @hono/mcp, @modelcontextprotocol/sdk
    const detail = [
      ...sharedDrift.map(([n, v]) => `${n}: ${deps[n] ?? "absent"} vs ${v}`),
      ...v2Drift.map(([n, v]) => `${n}: ${deps[n] ?? "absent"} vs ${v}`),
      ...stale.map((n) => `${n}: still v1, must be gone`),
    ];
    assert(sharedDrift.length === 0 && v2Drift.length === 0 && stale.length === 0, `${file} is on the v2 MCP stack (SMD-2278): hono+zod match integrations, ${Object.keys(SERVER_V2_PINS).join("+")} pinned, ${STACK.filter((n) => !SERVER_STACK.includes(n)).join("+")} gone${detail.length ? ` (${detail.join(", ")})` : ""}`);
  }
}



report();
