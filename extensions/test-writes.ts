#!/usr/bin/env bun
/**
 * test-writes.ts — every vendored writer of a thought's content or vector goes
 * through the functions that own them, and leaves what they leave.
 *
 * SMD-1228 (FORK.md change 68). Nine vendored files wrote `content` or
 * `embedding` on `thoughts` with a raw PostgREST update around update_thought
 * and the 3-argument upsert_thought — two MCP servers, three HTTP APIs, a
 * worker, a recipe's server, a recipe's paste-in snippet and a README's
 * sample — and so
 * left 003/018's fingerprint describing the old text, 021's label describing
 * the old vector and 022's chunk rows of the old vector under the new one.
 * scripts/check-fork-consistency.mjs check 10 holds the text; this proves the
 * behaviour: each writer that can run is driven as deployed against a real
 * Postgres carrying the fork's schema, and the row it leaves is compared with
 * the row update_thought leaves for the same edit — the ticket's own verify.
 *
 * The files are imported under the stand-in extensions/test-auth.ts uses for
 * Deno's two globals and its loader for Deno's specifiers, plus one more
 * rewrite: `@supabase/supabase-js` resolves to compat/supabase-sql, so the two
 * servers still on supabase-js run their PostgREST calls as SQL against the
 * same database the others reach through the shim. The model provider is
 * stubbed — a unit vector keyed off the text, so the vector a writer stored is
 * recognisable — and everything below the tool or route boundary is real.
 *
 * The database is the fork's migrations plus two vendored sidecars the
 * writers assume: schemas/enhanced-thoughts (the columns the APIs write
 * beside the function — type, importance, sensitivity_tier …) and
 * schemas/agent-memory (the write-back's own tables). Their tables and
 * functions are dropped before they are applied and again at the end, whether
 * or not the run finished (an aborted run's orphaned agent_memories row made
 * the next run's write-back short-circuit on its idempotency key), because CI
 * shares one Postgres across the job; the three Supabase roles, and the
 * columns and indexes the enhanced sidecar adds to `thoughts`, stay until the
 * next suite's reset drops the table — nothing a later suite reads.
 *
 * One limit of the fixture, said here: the SQL shim binds a JS number array
 * as a Postgres array literal, so a vendored write that regressed to a raw
 * `.update({ embedding })` with a `number[]` fails at the shim ("invalid input
 * syntax for type vector"), before this suite's column assertions — loudly,
 * but not where the labels say. Over real PostgREST that raw write would
 * succeed and the assertions would name the stale columns; with the vector
 * as text (`[…]`, update-thought-mcp's old spelling) they do here too.
 *
 *   ../db/with-postgres.sh bun test-writes.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { createAssert, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const URL_ = requireDatabaseUrl("test-writes.ts");
const { assert, report } = createAssert();

// ── The schema, and the model the writers label their vectors with ───────────

// Pinned, as test-e2e-sql.ts pins them: this suite asserts the data layer, not
// the model choice, and every writer here spells the OpenRouter default.
const DIM = 1536;
const MODEL = "openai/text-embedding-3-small";
await resetSchema(URL_, { dim: DIM, model: MODEL });
const sql = new SQL({ url: URL_, max: 2 });

const SIDECARS = ["schemas/enhanced-thoughts/schema.sql", "schemas/agent-memory/schema.sql"];
// Both GRANT to Supabase's roles, which plain Postgres lacks; the sidecar's own header says to create them.
for (const role of ["authenticated", "service_role", "anon"]) {
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $r$`);
}
/** What the sidecars create and the shared reset does not know: dropped before they are applied and at the end. */
async function dropSidecars() {
  for (const file of SIDECARS) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(/CREATE TABLE IF NOT EXISTS (?:public\.)?(\w+)/g)) await sql.unsafe(`DROP TABLE IF EXISTS public.${m[1]} CASCADE`);
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?(\w+)\s*\(/g)) await sql.unsafe(`DROP FUNCTION IF EXISTS public.${m[1]} CASCADE`);
  }
}
await dropSidecars(); // an earlier run that aborted left its tables (CREATE TABLE IF NOT EXISTS keeps their rows)
for (const file of SIDECARS) await sql.unsafe(readFileSync(join(ROOT, file), "utf8"));

// ── The model provider, stubbed ──────────────────────────────────────────────

/** A unit vector on an axis chosen by the text — the same text, the same vector, so a stored one is recognisable. */
function unit(text: string): number[] {
  const v = new Array(DIM).fill(0);
  v[[...text].reduce((n, ch) => (n + ch.charCodeAt(0)) % DIM, 0)] = 1;
  return v;
}
const vec = (v: number[]) => `[${v.join(",")}]`;
const STUB_METADATA = { type: "idea", summary: "stubbed", topics: ["stubbed"], tags: [], people: [], action_items: [], dates_mentioned: [], confidence: 0.9 };
/** When set, the embeddings endpoint answers 500 — the provider outage a writer must survive visibly. */
let embeddingsDown = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/openrouter\.ai|api\.openai\.com/.test(url)) throw new Error(`test-writes.ts: a writer reached ${url}; only the model provider is stubbed`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/embeddings")) {
    if (embeddingsDown) return new Response("stub: embeddings down", { status: 500 });
    return Response.json({ data: [{ embedding: unit(String(body.input)) }] });
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(STUB_METADATA) } }] });
}) as typeof fetch;

// ── Deno's globals and specifiers, on Bun ────────────────────────────────────

type Handler = (req: Request) => Response | Promise<Response>;
const served: Handler[] = [];
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: { get: (name: string) => process.env[name] },
  serve: (a: Handler | object, b?: Handler) => {
    served.push(typeof a === "function" ? a : b!);
    return { finished: Promise.resolve() };
  },
};
const SHIM = join(ROOT, "compat", "supabase-sql", "index.ts");
const PACKAGES = /^(hono|zod|@hono\/mcp|@modelcontextprotocol\/sdk)(\/|$)/;
const VENDORED = new RegExp("^" + ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(recipes|integrations)/.*\\.ts$");
Bun.plugin({
  name: "deno-specifiers-on-bun, supabase-js as the sql shim",
  setup(build) {
    build.onLoad({ filter: VENDORED }, async (args) => {
      let src = await Bun.file(args.path).text();
      src = src.replace(/^import\s+"jsr:[^"]+";\s*$/gm, "");
      src = src.replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (whole, lead, q, spec) => {
        let s = spec as string;
        if (s.startsWith("npm:")) s = s.slice(4).replace(/^(@?[^@/]+(?:\/[^@/]+)?)@[^/]*/, "$1");
        if (s === "@supabase/supabase-js") return `${lead}${q}${SHIM}${q}`;
        if (PACKAGES.test(s)) return `${lead}${q}${Bun.resolveSync(s, HERE)}${q}`;
        return whole;
      });
      return { contents: src, loader: "ts" };
    });
  },
});

// One key, presented as `x-brain-key`: the older single MCP_ACCESS_KEY, which
// the servers on _shared/auth.ts accept with write scope (compared by digest)
// and the two still on a constant-time compare accept as their only key.
const KEY = "one-write-key-for-every-writer";
process.env.SUPABASE_URL = URL_;
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.MCP_ACCESS_KEY = KEY;
delete process.env.MCP_ACCESS_KEYS;
process.env.OPENROUTER_API_KEY = "stub-openrouter-key"; // the writers' first-choice provider; its model name is the label
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"]) delete process.env[name];

async function load(rel: string): Promise<Handler> {
  const before = served.length;
  await import(join(ROOT, rel));
  assert(served.length === before + 1, `${rel} imports as deployed and hands Deno.serve one handler`);
  return served[before];
}

// ── One request ──────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": KEY };
type Reply = { status: number; json: any; text: string };
async function send(handler: Handler, method: string, path: string, body?: unknown): Promise<Reply> {
  const console_ = { error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {}; // a writer logs what it refuses; the status is the assertion
  let r: Response;
  try {
    r = await handler(new Request("http://writer.test" + path, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) }));
  } finally {
    Object.assign(console, console_);
  }
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  let json: any = null;
  try { json = line ? JSON.parse(line) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
/** An MCP tools/call, JSON-RPC over POST /mcp; the tool's first text block and structured content. */
async function call(handler: Handler, name: string, args: Record<string, unknown>) {
  const r = await send(handler, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { ...r, toolText: String(r.json?.result?.content?.[0]?.text ?? ""), structured: r.json?.result?.structuredContent ?? null, isError: r.json?.result?.isError === true };
}

// ── The rows: planted, read, and the oracle ──────────────────────────────────

const BEFORE = "the previous text";
/**
 * A thought as an older write left it: text, its fingerprint, a vector under a
 * label of its own, and two chunk rows of that vector — the state an edit
 * must move whole. Distinct text per row: the fingerprint index is unique.
 */
async function plant(tag: string): Promise<string> {
  const text = `${BEFORE} (${tag})`;
  const [{ id }] = await sql`INSERT INTO thoughts (content, content_fingerprint, embedding, embedding_model, metadata)
    VALUES (${text}, content_fingerprint_of(${text}), ${vec(unit(BEFORE))}::vector, 'model-before', '{}'::jsonb) RETURNING id`;
  await plantWindows(id);
  return id as string;
}
/** Two chunk rows of the previous vector — 022's stale set, if an edit leaves them. */
async function plantWindows(id: string) {
  await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
    VALUES (${id}, 0, 'window 0', ${vec(unit(BEFORE))}::vector), (${id}, 1, 'window 1', ${vec(unit(BEFORE))}::vector)`;
}
type Row = { content: string; fp_ok: boolean; fp_set: boolean; embedding_model: string | null; has_vec: boolean; at_axis: boolean | null; chunks: number; metadata: Record<string, unknown>; updated_at: string };
/** The row, with the three columns the ticket names judged: fingerprint of its own text, label, chunk count — and whether the vector is the text's. */
async function row(id: string, text: string): Promise<Row> {
  const [r] = await sql`SELECT content, content_fingerprint = content_fingerprint_of(content) AS fp_ok, content_fingerprint IS NOT NULL AS fp_set,
      embedding_model, embedding IS NOT NULL AS has_vec, embedding = ${vec(unit(text))}::vector AS at_axis,
      (SELECT count(*)::int FROM thought_chunks WHERE thought_id = t.id) AS chunks, metadata, updated_at
    FROM thoughts t WHERE id = ${id}`;
  return r as Row;
}
async function idOf(text: string): Promise<string | null> {
  const rows = await sql`SELECT id FROM thoughts WHERE content = ${text}`;
  return (rows[0]?.id as string) ?? null;
}
/** The same edit through update_thought itself, on a twin row: what the ticket says each writer must leave. */
async function oracle(tag: string, text: string): Promise<Row> {
  const id = await plant(`${tag} oracle`);
  // Its own text: the writer's row holds `text`, and an edit into another row's text is DUPLICATE_CONTENT.
  const own = `${text} (oracle)`;
  const [{ r }] = await sql`SELECT update_thought(${id}::uuid, ${own}::text, ${{ via: "oracle" }}::jsonb, ${vec(unit(own))}::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, ${MODEL}::text) AS r`;
  assert((r as { ok?: boolean }).ok === true, `${tag}: the oracle edit through update_thought itself succeeds`);
  return row(id, own);
}
/** The columns an edit leaves, compared: fingerprint state, label, whether the vector is the text's, chunk count. */
const asOracle = (a: Row, b: Row) => a.fp_ok === b.fp_ok && a.fp_set === b.fp_set && a.embedding_model === b.embedding_model && a.at_axis === b.at_axis && a.chunks === b.chunks;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An edit's row, judged: what update_thought leaves, named column by column. */
function judgeEdit(label: string, r: Row, o: Row, text: string) {
  assert(r.content === text, `${label}: the text is the new text`);
  assert(r.fp_set && r.fp_ok, `${label}: content_fingerprint is the new text's (003/018) — a raw update left the old one`);
  assert(r.embedding_model === MODEL, `${label}: embedding_model is the model that made the vector (021) — a raw update left "model-before" (got ${r.embedding_model})`);
  assert(r.has_vec && r.at_axis === true, `${label}: the vector is the new text's`);
  assert(r.chunks === 0, `${label}: the previous vector's chunk rows are gone (022) — a raw update left ${2} (got ${r.chunks})`);
  assert(asOracle(r, o), `${label}: fingerprint, label, vector and chunk rows are as update_thought leaves them for the same edit`);
}
/** A capture's row, judged: the 3-argument form's work — vector, label and fingerprint in one write. */
function judgeCapture(label: string, r: Row, text: string) {
  assert(r.content === text, `${label}: the text is stored`);
  assert(r.fp_set && r.fp_ok, `${label}: content_fingerprint is the text's (003)`);
  assert(r.has_vec && r.at_axis === true, `${label}: the vector is stored — the 2-argument form never took one`);
  assert(r.embedding_model === MODEL, `${label}: embedding_model is the model that made it (021) — the raw update after the 2-argument form left NULL (got ${r.embedding_model})`);
  assert(r.chunks === 0, `${label}: no chunk rows (the writer made none; nothing here plants any under a capture)`);
}

// Everything below runs inside one try so the sidecars are dropped however it ends.
try {

// ── integrations/update-thought-mcp ──────────────────────────────────────────

{
  const F = "integrations/update-thought-mcp/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const id = await plant("update-thought-mcp");
  const text = "the text after the edit, through update-thought-mcp";
  const r = await call(h, "update_thought", { id, content: text, metadata_patch: { via: "update-thought-mcp" } });
  assert(r.status === 200 && !r.isError && /^Updated thought /.test(r.toolText), `update_thought answers Updated (${r.toolText.split("\n")[0]})`);
  assert(/content replaced and re-embedded/.test(r.toolText) && /metadata merged/.test(r.toolText) && /updated_at: \d{4}-/.test(r.toolText), "…naming what moved and the function's updated_at");
  const after = await row(id, text);
  judgeEdit("update-thought-mcp", after, await oracle("update-thought-mcp", text), text);
  assert(after.metadata.via === "update-thought-mcp", "the patch is shallow-merged into metadata, in the function");

  // The concurrency check is the function's now, decided under the row's lock.
  const stale = await call(h, "update_thought", { id, content: "a lost update", if_unchanged_since: "2000-01-01T00:00:00Z" });
  assert(stale.isError && /^STALE_READ:/.test(stale.toolText) && /Current updated_at: \d{4}-/.test(stale.toolText), `an old if_unchanged_since is refused as STALE_READ with the row's updated_at (${stale.toolText.slice(0, 60)})`);
  assert((await row(id, text)).content === text, "…and the row is untouched");
  const gone = await call(h, "update_thought", { id: "00000000-0000-4000-8000-000000000000", content: "nobody" });
  assert(gone.isError && /^Thought not found/.test(gone.toolText), "an unknown id is Thought not found");

  // A metadata-only edit leaves the vector, its label and the fingerprint alone (018/021).
  const meta = await call(h, "update_thought", { id, metadata_patch: { pinned: true } });
  const kept = await row(id, text);
  assert(!meta.isError && kept.metadata.pinned === true && kept.at_axis === true && kept.embedding_model === MODEL && kept.fp_ok, "a metadata-only edit merges the patch and leaves vector, label and fingerprint as they were");

  // Editing INTO another row's text is refused by name, not as a constraint error.
  const other = await plant("update-thought-mcp twin");
  const dup = await call(h, "update_thought", { id: other, content: text });
  assert(dup.isError && /^DUPLICATE_CONTENT:/.test(dup.toolText), "an edit into text another thought holds is refused as DUPLICATE_CONTENT");
}

// ── integrations/enhanced-mcp ────────────────────────────────────────────────

{
  const F = "integrations/enhanced-mcp/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const id = await plant("enhanced-mcp");
  const text = "the text after the edit, through enhanced-mcp";
  const r = await call(h, "update_thought", { id, content: text });
  assert(r.status === 200 && !r.isError && /^Updated thought #/.test(r.toolText), `update_thought takes the row's UUID and answers Updated (${r.toolText.slice(0, 70)})`);
  const after = await row(id, text);
  judgeEdit("enhanced-mcp", after, await oracle("enhanced-mcp", text), text);
  assert(after.metadata.type === "idea" && after.metadata.summary === "stubbed", "the re-classified metadata is merged in");
  const [side] = await sql`SELECT type, sensitivity_tier, importance FROM thoughts WHERE id = ${id}`;
  assert(side.type === "idea" && side.sensitivity_tier === "standard" && Number(side.importance) === 3, "the enhanced-thoughts columns are written beside the function, by the raw update that carries neither content nor vector");

  const captured = "a fresh thought captured through enhanced-mcp";
  const c = await call(h, "brain_capture_thought", { content: captured });
  assert(!c.isError && /^Captured new thought #/.test(c.toolText) && UUID.test(String(c.structured?.thought_id)) && c.structured?.action === "inserted",
    `brain_capture_thought reads the fork's return — a UUID id, inserted — instead of throwing after the write (${c.toolText.slice(0, 60)})`);
  const cid = String(c.structured?.thought_id);
  if (UUID.test(cid)) {
    judgeCapture("enhanced-mcp capture", await row(cid, captured), captured);
    assert(typeof c.structured?.content_fingerprint === "string" && c.structured.content_fingerprint.length === 64, "…and reports the fingerprint the function computed");
    const [cside] = await sql`SELECT type, source_type FROM thoughts WHERE id = ${cid}`;
    assert(cside.type === "idea" && cside.source_type === "mcp", "the enhanced-thoughts columns follow the capture");
  }
}

// ── integrations/agent-memory-api ────────────────────────────────────────────

{
  const F = "integrations/agent-memory-api/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const decision = "We decided to keep the ledger in Postgres and replay it nightly.";
  const r = await send(h, "POST", "/writeback", {
    schema_version: "openbrain.agent_memory.writeback.v1", workspace_id: "ws-test", runtime: { name: "test" },
    memory_payload: { decisions: [decision] }, provenance: { default_status: "user_confirmed", confidence: 0.9, requires_review: false },
  });
  assert(r.status === 200 && Array.isArray(r.json?.memories) && r.json.memories.length === 1, `POST /writeback stores one memory (${r.status})`);
  const id = await idOf(decision);
  assert(id !== null, "…and its thought");
  if (id) {
    judgeCapture("agent-memory-api writeback", await row(id, decision), decision);
    const [m] = await sql`SELECT thought_id FROM agent_memories WHERE content = ${decision}`;
    assert(m?.thought_id === id, "the memory row points at the thought");
  }
}

// ── integrations/open-brain-rest ─────────────────────────────────────────────

{
  const F = "integrations/open-brain-rest/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const captured = "a fresh thought captured through open-brain-rest";
  const c = await send(h, "POST", "/capture", { content: captured, importance: 4 });
  assert(c.status === 200 && UUID.test(String(c.json?.thought_id)), `POST /capture answers the thought's id (${c.status} ${JSON.stringify(c.json).slice(0, 80)})`);
  const cid = String(c.json?.thought_id);
  if (UUID.test(cid)) {
    judgeCapture("open-brain-rest capture", await row(cid, captured), captured);
    const [cside] = await sql`SELECT type, source_type, importance FROM thoughts WHERE id = ${cid}`;
    assert(cside.type === "idea" && cside.source_type === "dashboard" && Number(cside.importance) === 4, "the enhanced-thoughts columns follow the capture, without content or vector");
    // A re-capture of the same text: the function refreshes vector and metadata; the enhanced columns are the owner's.
    await sql`UPDATE thoughts SET sensitivity_tier = 'personal', importance = 6 WHERE id = ${cid}`;
    const again = await send(h, "POST", "/capture", { content: captured, importance: 1 });
    const [kept] = await sql`SELECT sensitivity_tier, importance FROM thoughts WHERE id = ${cid}`;
    assert(again.status === 200 && again.json?.thought_id === cid && again.json?.action === "updated", `a re-capture answers the same id as updated (${again.status} ${again.json?.action})`);
    assert(kept.sensitivity_tier === "personal" && Number(kept.importance) === 6, "…and leaves a hand-set tier and importance as they were — a fresh row's columns only");
  }

  const id = await plant("open-brain-rest");
  const text = "the text after the edit, through open-brain-rest";
  const r = await send(h, "PUT", `/thought/${id}`, { content: text, importance: 9, metadata: { via: "open-brain-rest" } });
  assert(r.status === 200 && r.json?.action === "updated", `PUT /thought/:id answers updated (${r.status})`);
  const after = await row(id, text);
  judgeEdit("open-brain-rest", after, await oracle("open-brain-rest", text), text);
  assert(after.metadata.via === "open-brain-rest", "the metadata is merged in the function");
  const [side] = await sql`SELECT importance FROM thoughts WHERE id = ${id}`;
  assert(Number(side.importance) === 9, "the enhanced-thoughts column is written beside it");
  const meta = await send(h, "PUT", `/thought/${id}`, { status: "new" });
  const kept = await row(id, text);
  assert(meta.status === 200 && kept.at_axis === true && kept.embedding_model === MODEL && kept.fp_ok, "an edit without content leaves vector, label and fingerprint as they were");
  const gone = await send(h, "PUT", "/thought/00000000-0000-4000-8000-000000000000", { content: "nobody" });
  assert(gone.status === 404, "an unknown id is 404");
}

// ── integrations/rest-api ────────────────────────────────────────────────────

{
  const F = "integrations/rest-api/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const captured = "a fresh thought captured through rest-api";
  const c = await send(h, "POST", "/capture", { content: captured });
  assert(c.status === 200 && UUID.test(String(c.json?.thought_id)) && c.json?.action === "inserted",
    `POST /capture reads the fork's return — a UUID id, inserted — instead of throwing after the write (${c.status} ${JSON.stringify(c.json).slice(0, 80)})`);
  const cid = String(c.json?.thought_id);
  if (UUID.test(cid)) {
    judgeCapture("rest-api capture", await row(cid, captured), captured);
    assert(typeof c.json?.content_fingerprint === "string" && c.json.content_fingerprint.length === 64, "…and reports the fingerprint the function computed");
    await sql`UPDATE thoughts SET sensitivity_tier = 'personal' WHERE id = ${cid}`;
    const again = await send(h, "POST", "/capture", { content: captured });
    const [kept] = await sql`SELECT sensitivity_tier FROM thoughts WHERE id = ${cid}`;
    assert(again.status === 200 && again.json?.thought_id === cid && again.json?.action === "updated" && kept.sensitivity_tier === "personal",
      `a re-capture answers the same id as updated and leaves a hand-set tier — escalation-only holds for captures too (${again.status} ${again.json?.action} ${kept.sensitivity_tier})`);
  }

  const id = await plant("rest-api");
  const text = "the text after the edit, through rest-api";
  const r = await send(h, "PUT", `/thought/${id}`, { content: text, importance: 5 });
  assert(r.status === 200 && r.json?.action === "updated", `PUT /thought/:id reaches a UUID row and answers updated (${r.status} ${JSON.stringify(r.json).slice(0, 80)})`);
  judgeEdit("rest-api", await row(id, text), await oracle("rest-api", text), text);
  const [side] = await sql`SELECT importance FROM thoughts WHERE id = ${id}`;
  assert(Number(side.importance) === 5, "the enhanced-thoughts column is written beside it");

  // The provider is down during an edit: the function is told no vector, so the
  // row has none — 021's rule, not the old vector under the new text — and the
  // response says so instead of a bare 200.
  embeddingsDown = true;
  const down = await send(h, "PUT", `/thought/${id}`, { content: `${text}, edited while the provider was down` });
  embeddingsDown = false;
  const unembedded = await row(id, text);
  assert(down.status === 200 && down.json?.embedding_updated === false && /no vector until PATCH/.test(String(down.json?.message)),
    `a PUT whose embedding call failed answers 200 with embedding_updated: false and says how to refill (${down.status} ${JSON.stringify(down.json).slice(0, 90)})`);
  assert(!unembedded.has_vec && unembedded.embedding_model === null && unembedded.fp_ok && unembedded.content.endsWith("provider was down"),
    "…and the row holds the new text and fingerprint with no vector and no label — not the previous vector");
  assert((await send(h, "PUT", `/thought/${id}`, { content: text })).json?.embedding_updated === true, "the next PUT, provider back, re-embeds and says so");

  // Enrich: the same text, a new vector — an unchanged edit that relabels and replaces the windows.
  await plantWindows(id);
  await sql`UPDATE thoughts SET embedding_model = 'model-before' WHERE id = ${id}`;
  const e = await send(h, "PATCH", `/thought/${id}/enrich?fill=embedding`);
  assert(e.status === 200 && e.json?.action === "enriched" && (e.json?.fills ?? []).includes("embedding"), `PATCH /thought/:id/enrich?fill=embedding answers enriched (${e.status})`);
  const after = await row(id, text);
  assert(after.embedding_model === MODEL && after.at_axis === true, "the new vector carries its label (021) — a raw update left model-before");
  assert(after.chunks === 0, "the previous vector's windows are gone (022)");
  assert(after.fp_ok && after.content === text, "the text and its fingerprint are untouched");
  assert(after.metadata.enrichment_fills?.toString() === "embedding", "the enrichment record is merged into metadata");
}

// ── recipes/repo-learning-coach ──────────────────────────────────────────────

{
  const F = "recipes/repo-learning-coach/server/brain.ts";
  console.log(`\n[${F}]`);
  const { captureLearningArtifact } = await import(join(ROOT, F));
  const result = await captureLearningArtifact({
    kind: "takeaway", content: "The runner heals its own search_path before the first migration.",
    lesson: { slug: "runner", title: "The runner", summary: "How migrate.ts applies", goals: [], status: "complete", confidence: 0.9 },
  });
  assert(UUID.test(String(result.thoughtId)), `captureLearningArtifact returns the thought's id (${String(result.thoughtId).slice(0, 8)}…)`);
  const [{ content }] = await sql`SELECT content FROM thoughts WHERE id = ${result.thoughtId}`;
  judgeCapture("repo-learning-coach capture", await row(result.thoughtId, content), content);
}

// ── The files that cannot run here say what this test assumes ────────────────

console.log("\n[the files say what this test assumes]");
const spells = (rel: string, re: RegExp, what: string) => assert(re.test(readFileSync(join(ROOT, rel), "utf8")), `${rel} ${what}`);
// A paste-in snippet with free variables; a README's sample; a worker whose run needs an LLM pass over person notes.
spells("recipes/provenance-chains/mcp-tools.ts", /"upsert_thought",\s*\{\s*p_content: content,\s*p_payload: \{[^}]*embedding_model: EMBEDDING_MODEL/s, "captures content, vector and label in one 3-argument upsert_thought");
spells("recipes/provenance-chains/mcp-tools.ts", /p_embedding: embedding,/, "…passing the vector as p_embedding");
spells("recipes/provenance-chains/mcp-tools.ts", /\.select\("id"\)\s*\.in\("id", wellFormed\)/s, "…and resolves each well-formed ref before the call, so a ghost parent is unresolved, not a refusal");
spells("integrations/consolidation-workers/bio/index.ts", /p_embedding: embedding,\s*p_embedding_model: embeddingModelUsed\(\),/s, "…with the vector it embedded and its label, so a re-embedded profile is replaced, not blanked");
spells("integrations/telegram-capture/README.md", /rpc\("update_thought", \{\s*p_id: existing\[0\]\.id,\s*p_content: messageText,/s, "'s sample edits through update_thought");
spells("integrations/telegram-capture/README.md", /p_embedding_model: EMBEDDING_MODEL,/, "…with the label beside the vector");
spells("integrations/consolidation-workers/bio/index.ts", /rpc\("update_thought", \{\s*p_id: existingId,\s*p_content: profileContent,/s, " rewrites the profile through update_thought");
// Every runnable file this change touched is driven above: the header names them.
const DRIVEN = ["integrations/update-thought-mcp/index.ts", "integrations/enhanced-mcp/index.ts", "integrations/agent-memory-api/index.ts",
  "integrations/open-brain-rest/index.ts", "integrations/rest-api/index.ts", "recipes/repo-learning-coach/server/brain.ts"];
const TEXT_ONLY = ["integrations/consolidation-workers/bio/index.ts", "recipes/provenance-chains/mcp-tools.ts"];
{
  const headed = [...new Bun.Glob("{recipes,integrations}/**/*.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules") && /SMD-1228/.test(readFileSync(join(ROOT, f), "utf8"))).sort();
  assert(headed.join() === [...DRIVEN, ...TEXT_ONLY].sort().join(), `every .ts file that names SMD-1228 is driven here or read here, and vice versa (${headed.join(", ")})`);
  assert(existsSync(join(ROOT, "scripts/check-fork-consistency.mjs")) && /function thoughtWritesAroundIn\(/.test(readFileSync(join(ROOT, "scripts/check-fork-consistency.mjs"), "utf8")),
    "scripts/check-fork-consistency.mjs check 10 holds the text of every file: no raw write of content or vector on thoughts");
}

} finally {
  await dropSidecars();
  await sql.close();
}
report();
