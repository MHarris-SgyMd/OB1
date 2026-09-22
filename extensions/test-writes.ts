#!/usr/bin/env bun
/**
 * test-writes.ts — every vendored writer of a thought's content or vector goes
 * through the functions that own them, and leaves what they leave.
 *
 * SMD-1228 (FORK.md change 69). Nine vendored files wrote `content` or
 * `embedding` on `thoughts` with a raw PostgREST update around update_thought
 * and the 3-argument upsert_thought — two MCP servers, three HTTP APIs, a
 * worker, a recipe's server, a recipe's paste-in snippet and a README's
 * sample — and so
 * left 003/018's fingerprint describing the old text, 021's label describing
 * the old vector and 022's chunk rows of the old vector under the new one.
 * scripts/check-fork-consistency.ts check 10 holds the text; this proves the
 * behaviour: each writer that can run is driven as deployed against a real
 * Postgres carrying the fork's schema, and the row it leaves is compared with
 * the row update_thought leaves for the same edit — the ticket's own verify.
 *
 * SMD-1524 (FORK.md change 71) added the other door: eight vendored files
 * INSERTED a fresh row with content, or content and a vector, around the
 * 3-argument upsert_thought — a webhook receiver, a worker's first run, an
 * auditor's report, a recipe's example capture, two Python recipes and two
 * README samples — and so left 003's fingerprint NULL (016's trigger does not
 * fill it; the row invisible to dedup, a later capture of the text a twin) and
 * 021's label NULL (a vector of unknown model). The receiver and the auditor
 * are driven here; the rest are read. Three more deployments write a raw row
 * into a database of their own, where the functions are not, and say so in
 * their headers and READMEs — they are check 10's counted exceptions, read here.
 * The text guards below are spelling-sensitive by design: a rewrite of a
 * read-only file that keeps the mechanism but respells the call fails one
 * assertion whose message names the mechanism, and the guard is updated with
 * the file — the cost of holding behaviour this suite cannot drive.
 *
 * SMD-1544 (FORK.md change 73) moved the bio worker from the read set to the
 * driven one. Its source and profile queries filter on JSON paths
 * (`metadata->>generated_by`, `->>subject` …), which the SQL shim refused, so
 * on the fork the worker answered 500 at its first query and everything
 * changes 69 and 71 gave its write paths was held by the text guards alone.
 * With the shim rendering the path — and handing a timestamp back as a
 * string, as PostgREST does, which the worker's prompt slices — the worker runs
 * here on both paths: the sources chosen by the filters, the first profile
 * through the 3-argument upsert_thought, the rewrite through update_thought
 * with the previous profile found through three path equalities and the
 * profile's own row kept out of its sources.
 *
 * SMD-1541 (FORK.md change 103) reads 008's row after every driven capture and
 * edit through change 69's five servers. Their headers said "the actor reaches
 * the audit (008)" and none passed one — the functions set `ob1.actor` only
 * from `p_actor` / `p_payload.actor` — so `thought_audit.actor_name` was NULL
 * for every write through them, as for the raw writes they replaced. Each now
 * names the key: `principal.name` where the server authenticates through
 * `_shared/auth.ts` (three), the constant `MCP_ACCESS_KEY` where it holds
 * that one key and compares it in place (`enhanced-mcp`, `rest-api`) — both
 * `MCP_ACCESS_KEY` under this suite's legacy single key — and one write through
 * each of the three runs under a NAMED key too, the arm that tells the
 * principal's name from a constant, while the two refuse that key. No actor carries a
 * source — the trigger (008; its body is 025's now) reads the row's own
 * `metadata.source`, so the column means the thought's origin on every row,
 * and a copy of it in the actor was indistinguishable from that fallback under
 * the mutant run — and every actor names the server as `via`, which the
 * trigger keeps in `actor_context`: the arm that holds the actor object's
 * arrival on every site; the write-back's runtime lands beside it. The
 * `source` column is judged against the thought's own `metadata.source`, which
 * is what the trigger writes when no actor names one: the arm fails for a
 * server that starts naming a source of its own (the first draft's server name
 * on an edit) and tolerates only a copy of the origin, the one case the rule
 * allows; server-portable/test-audit.ts holds the trigger itself.
 *
 * The files are imported under the stand-in extensions/test-auth.ts uses for
 * Deno's two globals and its loader for Deno's specifiers, plus one more
 * rewrite: `@supabase/supabase-js` resolves to compat/supabase-sql, so the two
 * servers still on supabase-js run their PostgREST calls as SQL against the
 * same database the others reach through the shim. The model provider is
 * stubbed — a unit vector keyed off the text, so the vector a writer stored is
 * recognisable — and everything below the tool or route boundary is real. The
 * shim-migrated files import compat/deno-on-bun.ts first (change 74), which
 * installs nothing where `Deno` is already defined, so the stand-in still
 * captures each handler; test-auth.ts is where they start under bun for real.
 *
 * The database is the fork's migrations plus three vendored sidecars the
 * writers assume: schemas/enhanced-thoughts (the columns the APIs write
 * beside the function — type, importance, sensitivity_tier …),
 * schemas/agent-memory (the write-back's own tables) and schemas/readwise-books
 * (the receiver's book cache and its counter) — and the bio worker's log
 * table, `consolidation_log`, from `schemas/entity-extraction/schema.sql`'s
 * definition alone (that sidecar's other tables include a `thought_entities`
 * migration 016 owns). Their tables and
 * functions are dropped before they are applied and again at the end, whether
 * or not the run finished (an aborted run's orphaned agent_memories row made
 * the next run's write-back short-circuit on its idempotency key), because CI
 * shares one Postgres across the job; the three Supabase roles, and the
 * columns and indexes the enhanced sidecar adds to `thoughts`, stay until the
 * next suite's reset drops the table — nothing a later suite reads.
 *
 * A limit of the fixture that change 77 (SMD-1588) removed, said here for the
 * record: until then the SQL shim handed a JS number array to a `vector`
 * column as Bun's `String()` of it, so a vendored write that regressed to a
 * raw `.update({ embedding })` with a `number[]` failed at the shim ("invalid
 * input syntax for type vector") before this suite's column assertions —
 * loudly, but not where the labels say. The shim now binds a value by its
 * column's declared type, a `vector` column's as the JSON text Postgres
 * coerces, so that raw write succeeds here as it would over PostgREST, and
 * the assertions name the stale columns as the labels say.
 *
 *   ../db/with-postgres.sh bun test-writes.ts
 */

import { createHash } from "node:crypto";
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
// the model choice, and every writer here spells the OpenRouter default — so
// the brain is built at ITS width. The fork's default is qwen3-embedding:4b at
// 1024, where every one of these writers' vectors is refused by the function
// and the capture or edit fails whole; that case is the operator's to avoid
// (each README says so) and is not driven here.
const DIM = 1536;
const MODEL = "openai/text-embedding-3-small";
await resetSchema(URL_, { dim: DIM, model: MODEL });
const sql = new SQL({ url: URL_, max: 2 });

const SIDECARS = ["schemas/enhanced-thoughts/schema.sql", "schemas/agent-memory/schema.sql", "schemas/readwise-books/schema.sql"];
// All three GRANT to Supabase's roles, which plain Postgres lacks; the sidecars' own headers say to create them.
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
  await sql.unsafe("DROP TABLE IF EXISTS public.consolidation_log CASCADE");
}
await dropSidecars(); // an earlier run that aborted left its tables (CREATE TABLE IF NOT EXISTS keeps their rows)
for (const file of SIDECARS) await sql.unsafe(readFileSync(join(ROOT, file), "utf8"));
// The bio worker logs each run to consolidation_log (non-fatally, so a missing table would hide nothing but the log): the
// table from the entity-extraction sidecar's own definition, alone.
const LOG_TABLE = readFileSync(join(ROOT, "schemas/entity-extraction/schema.sql"), "utf8").match(/CREATE TABLE IF NOT EXISTS public\.consolidation_log \([\s\S]*?\);/)?.[0];
if (!LOG_TABLE) throw new Error("test-writes.ts: schemas/entity-extraction/schema.sql no longer defines consolidation_log");
await sql.unsafe(LOG_TABLE);

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
/** The user message of each bio prompt the stub answered — what the worker's filters gathered. */
const bioPrompts: string[] = [];
/** The book Readwise's API answers for any book id — the receiver's write-through cache reads it once. */
const BOOK = { id: 42, title: "Meditations", author: "Marcus Aurelius", category: "books", source: "kindle", source_url: null, cover_image_url: null, num_highlights: 3, last_highlight_at: null, tags: [] };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/readwise\.io\/api\/v2\/books\//.test(url)) return Response.json(BOOK);
  if (!/openrouter\.ai|api\.openai\.com/.test(url)) throw new Error(`test-writes.ts: a writer reached ${url}; only the model provider and Readwise's book lookup are stubbed`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/embeddings")) {
    if (embeddingsDown) return new Response("stub: embeddings down", { status: 500 });
    return Response.json({ data: [{ embedding: unit(String(body.input)) }] });
  }
  // The bio worker's prompt is answered with a profile — text, not metadata — naming its run, so each run's text is new.
  if (/synthesizing a biographical profile/.test(String(body.messages?.[0]?.content ?? ""))) {
    bioPrompts.push(String(body.messages?.[1]?.content ?? ""));
    return Response.json({ choices: [{ message: { content: `Canonical Profile: Test is a reader of the Stoics (run ${bioPrompts.length}).` } }] });
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
        // Matched by regex, not a quoted literal: scripts/migrate-to-sql-shim.ts rewrites every
        // quoted @supabase/supabase-js it finds, and this loader is not a consumer of it.
        if (/^@supabase\/supabase-js$/.test(s)) return `${lead}${q}${SHIM}${q}`;
        if (PACKAGES.test(s)) return `${lead}${q}${Bun.resolveSync(s, HERE)}${q}`;
        return whole;
      });
      return { contents: src, loader: "ts" };
    });
  },
});

// One key, presented as `x-brain-key`: the older single MCP_ACCESS_KEY, which
// the servers on _shared/auth.ts accept with write scope (compared by digest)
// and the two still on a constant-time compare accept as their only key. And
// a second, NAMED key in MCP_ACCESS_KEYS, which only the servers on the module
// know: one write through each of them runs under it (SMD-1541), the arm that
// tells `principal.name` on the audit row from a constant that happens to
// spell the legacy key's name — every other arm runs under the legacy key,
// whose name the two in-place-compare servers' constant spells too.
const KEY = "one-write-key-for-every-writer";
const NAMED_KEY = "a-second-key-with-a-name-of-its-own";
const NAMED = "named-client";
process.env.SUPABASE_URL = URL_;
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.MCP_ACCESS_KEY = KEY;
process.env.MCP_ACCESS_KEYS = `${NAMED}:write:${createHash("sha256").update(NAMED_KEY, "utf8").digest("hex")}`;
process.env.OPENROUTER_API_KEY = "stub-openrouter-key"; // the writers' first-choice provider; its model name is the label
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"]) delete process.env[name];
// The receiver's secret and token, and the auditor's key and Slack settings (read at import; Slack is never reached).
const READWISE_SECRET = "a-secret-readwise-minted";
process.env.READWISE_WEBHOOK_SECRET = READWISE_SECRET;
process.env.READWISE_ACCESS_TOKEN = "stub-readwise-token";
process.env.AUDITOR_ACCESS_KEY = KEY;
delete process.env.AUDITOR_ACCESS_KEYS;
process.env.SLACK_BOT_TOKEN = "stub";
process.env.SLACK_CAPTURE_CHANNEL = "C0STUB";

async function load(rel: string): Promise<Handler> {
  const before = served.length;
  await import(join(ROOT, rel));
  assert(served.length === before + 1, `${rel} imports as deployed and hands Deno.serve one handler`);
  return served[before];
}

// ── One request ──────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": KEY };
type Reply = { status: number; json: any; text: string };
async function send(handler: Handler, method: string, path: string, body?: unknown, key = KEY): Promise<Reply> {
  const console_ = { error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {}; // a writer logs what it refuses; the status is the assertion
  let r: Response;
  try {
    r = await handler(new Request("http://writer.test" + path, { method, headers: { ...HEADERS, "x-brain-key": key }, body: body === undefined ? undefined : JSON.stringify(body) }));
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
async function call(handler: Handler, name: string, args: Record<string, unknown>, key = KEY) {
  const r = await send(handler, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, key);
  return { ...r, toolText: String(r.json?.result?.content?.[0]?.text ?? ""), structured: r.json?.result?.structuredContent ?? null, isError: r.json?.result?.isError === true };
}

// ── The rows: planted, read, and the oracle ──────────────────────────────────

const BEFORE = "the previous text";
/**
 * A thought as an older write left it: text, its fingerprint, a vector under a
 * label of its own, two chunk rows of that vector, and an origin in its
 * metadata (`source: "planted"`, so an edit's audit arm compares a value and
 * not NULL with NULL) — the state an edit must move whole. Distinct text per
 * row: the fingerprint index is unique.
 */
async function plant(tag: string): Promise<string> {
  const text = `${BEFORE} (${tag})`;
  const [{ id }] = await sql`INSERT INTO thoughts (content, content_fingerprint, embedding, embedding_model, metadata)
    VALUES (${text}, content_fingerprint_of(${text}), ${vec(unit(BEFORE))}::vector, 'model-before', '{"source": "planted"}'::jsonb) RETURNING id`;
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
type Audit = { actor_name: string | null; source: string | null; own_source: string | null; origin: string | null; actor_context: Record<string, unknown> | null };
/**
 * 008's latest row of one action for a thought: who the function was told wrote it, through which door (046's
 * `origin`), and the row's own metadata.source beside the column that copies it. `created_at` is `now()`,
 * transaction-start time, so two rows one transaction wrote would tie and "latest" would be arbitrary: a tie fails
 * here by name rather than passing by luck. Compared as Postgres's text — microseconds — not through a JS Date, whose
 * millisecond grain would call two transactions under a millisecond apart a tie. None of the driven writes makes one
 * today (each call is its own transaction under the shim and over PostgREST alike).
 */
async function auditRow(id: string, action: "capture" | "update"): Promise<Audit | undefined> {
  const rows = await sql`SELECT a.actor_name, a.source, a.origin, a.actor_context, a.created_at::text AS at, t.metadata->>'source' AS own_source
    FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.thought_id = ${id} AND a.action = ${action} ORDER BY a.created_at DESC LIMIT 2`;
  assert(rows.length < 2 || rows[0].at !== rows[1].at, `008's latest ${action} row for the thought is one row, not a tie in created_at`);
  if (!rows[0]) return undefined;
  const { actor_name, source, own_source, origin, actor_context } = rows[0];
  return { actor_name, source, own_source, origin, actor_context };
}
/**
 * The audit row a write through a server holding a key must leave (SMD-1541): the key's name; the server as the door
 * — `via` in the envelope, which migration 046 stamps as the `origin` column (SMD-1730; in actor_context until then)
 * and strips from the blob, so the blob is NULL unless something else rode along — the field no fallback supplies, so
 * the arm that proves the actor arrived; and a `source` equal to the thought's own metadata.source, which since 046 is
 * the only thing the trigger writes there (until then, what the trigger wrote when no actor named one) — so a server
 * that starts naming a source of its own (the first draft's server name on an edit: a third vocabulary in the column)
 * fails here, and only a copy of the origin, the one case the rule allows, passes. Pass 3 had dropped a source arm
 * that compared the column with constants and with itself; this one compares it with the rule.
 */
function judgeActor(label: string, a: Audit | undefined, via: string, name = "MCP_ACCESS_KEY") {
  assert(a !== undefined, `${label}: 008 has a row for the write`);
  if (a === undefined) return; // one missing row is one failure, not four
  assert(a.actor_name === name, `${label}: 008's row names the key, ${name} (SMD-1541) — change 69 passed no actor, so the row named nobody (got ${a.actor_name})`);
  assert(a.origin === via, `${label}: …origin names the door, ${via} (SMD-1730; got ${a.origin})`);
  assert(a.actor_context?.via === undefined, `${label}: …and via is not also left in actor_context (got ${JSON.stringify(a.actor_context)})`);
  assert(a.source === a.own_source, `${label}: …and its source is the thought's own origin, ${a.own_source} — no actor names a source (got ${a.source})`);
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
  judgeActor("update-thought-mcp edit", await auditRow(id, "update"), "update-thought-mcp");

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

  // Under the NAMED key: the row names it — `principal.name`, not a constant that spells the legacy key's name.
  const named = await call(h, "update_thought", { id, metadata_patch: { named: true } }, NAMED_KEY);
  assert(named.status === 200 && !named.isError, `a named write key (MCP_ACCESS_KEYS) edits (${named.toolText.slice(0, 60)})`);
  judgeActor("update-thought-mcp edit under a named key", await auditRow(id, "update"), "update-thought-mcp", NAMED);
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
  judgeActor("enhanced-mcp edit", await auditRow(id, "update"), "enhanced-mcp");
  const [side] = await sql`SELECT type, sensitivity_tier, importance FROM thoughts WHERE id = ${id}`;
  assert(side.type === "idea" && side.sensitivity_tier === "standard" && Number(side.importance) === 3, "the enhanced-thoughts columns are written beside the function, by the raw update that carries neither content nor vector");

  // SMD-1525: the read tools take the row's UUID too — they took upstream's integer id and could reach no row here.
  const got = await call(h, "get_thought", { id });
  assert(!got.isError && got.structured?.thought?.id === id && got.structured?.thought?.content === text, `get_thought takes the thought's UUID and answers the row (${got.toolText.slice(0, 60)})`);
  const gotInt = await call(h, "get_thought", { id: 7 });
  assert(gotInt.isError || gotInt.json?.error, `…and an integer id is refused by the schema, not looked up (${gotInt.isError ? gotInt.toolText.slice(0, 40) : JSON.stringify(gotInt.json?.error).slice(0, 60)})`);
  const gotNone = await call(h, "get_thought", { id: "00000000-0000-4000-8000-000000000000" });
  assert(gotNone.isError && /not found/.test(gotNone.toolText), "…and an unknown UUID is not found");
  const related = await call(h, "related_thoughts", { thought_id: id });
  assert(!related.isError && related.structured?.thought_id === id && Array.isArray(related.structured?.results), `related_thoughts takes the UUID and reaches get_thought_connections (enhanced-thoughts's, p_thought_id UUID) rather than binding an integer (${related.toolText.slice(0, 60)})`);

  const captured = "a fresh thought captured through enhanced-mcp";
  const c = await call(h, "brain_capture_thought", { content: captured });
  assert(!c.isError && /^Captured new thought #/.test(c.toolText) && UUID.test(String(c.structured?.thought_id)) && c.structured?.action === "inserted",
    `brain_capture_thought reads the fork's return — a UUID id, inserted — instead of throwing after the write (${c.toolText.slice(0, 60)})`);
  const cid = String(c.structured?.thought_id);
  if (UUID.test(cid)) {
    judgeCapture("enhanced-mcp capture", await row(cid, captured), captured);
    judgeActor("enhanced-mcp capture", await auditRow(cid, "capture"), "enhanced-mcp");
    assert(typeof c.structured?.content_fingerprint === "string" && c.structured.content_fingerprint.length === 64, "…and reports the fingerprint the function computed");
    const [cside] = await sql`SELECT type, source_type FROM thoughts WHERE id = ${cid}`;
    assert(cside.type === "idea" && cside.source_type === "mcp", "the enhanced-thoughts columns follow the capture");
    // A re-capture of the same text: the tool's own fingerprint check answers before the function
    // does, and either way a hand-set tier stays — the second review pass found this gate undriven.
    await sql`UPDATE thoughts SET sensitivity_tier = 'personal' WHERE id = ${cid}`;
    const again = await call(h, "brain_capture_thought", { content: captured });
    const [kept] = await sql`SELECT sensitivity_tier FROM thoughts WHERE id = ${cid}`;
    assert(!again.isError && String(again.structured?.thought_id) === cid && again.structured?.action !== "inserted" && kept.sensitivity_tier === "personal",
      `a re-capture answers the same id, not as inserted, and leaves a hand-set tier (${again.structured?.action} ${kept.sensitivity_tier})`);
  }
  // One key, compared in place: a named key is refused here, and the name this server records is its constant's (SMD-1798 moves it onto the module).
  const named = await call(h, "brain_capture_thought", { content: "a capture under a named key, refused by enhanced-mcp" }, NAMED_KEY);
  assert(named.status === 401, `a named key (MCP_ACCESS_KEYS) is 401 here — this server knows its one MCP_ACCESS_KEY (${named.status})`);
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
    const audit = await auditRow(id, "capture");
    judgeActor("agent-memory-api writeback", audit, "agent-memory-api");
    assert(audit?.actor_context?.runtime === "test", `…and the runtime that wrote back rides in actor_context (${JSON.stringify(audit?.actor_context)})`);
    const [m] = await sql`SELECT thought_id FROM agent_memories WHERE content = ${decision}`;
    assert(m?.thought_id === id, "the memory row points at the thought");
  }
  // Under the NAMED key: the row names it — `principal.name`, not a constant that spells the legacy key's name.
  const decision2 = "We decided the named key writes back too, and the audit row says so.";
  const named = await send(h, "POST", "/writeback", {
    schema_version: "openbrain.agent_memory.writeback.v1", workspace_id: "ws-test", runtime: { name: "test" },
    memory_payload: { decisions: [decision2] }, provenance: { default_status: "user_confirmed", confidence: 0.9, requires_review: false },
  }, NAMED_KEY);
  assert(named.status === 200, `a named write key (MCP_ACCESS_KEYS) writes back (${named.status})`);
  const nid = await idOf(decision2);
  assert(nid !== null, "…and its thought");
  if (nid) judgeActor("agent-memory-api writeback under a named key", await auditRow(nid, "capture"), "agent-memory-api", NAMED);
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
    judgeActor("open-brain-rest capture", await auditRow(cid, "capture"), "open-brain-rest");
    const [cside] = await sql`SELECT type, source_type, importance FROM thoughts WHERE id = ${cid}`;
    assert(cside.type === "idea" && cside.source_type === "dashboard" && Number(cside.importance) === 4, "the enhanced-thoughts columns follow the capture, without content or vector");
    // A re-capture of the same text: the function refreshes vector and metadata; the enhanced columns are the owner's.
    await sql`UPDATE thoughts SET sensitivity_tier = 'personal', importance = 6 WHERE id = ${cid}`;
    const again = await send(h, "POST", "/capture", { content: captured, importance: 1 });
    const [kept] = await sql`SELECT sensitivity_tier, importance FROM thoughts WHERE id = ${cid}`;
    assert(again.status === 200 && again.json?.thought_id === cid && again.json?.action === "updated", `a re-capture answers the same id as updated (${again.status} ${again.json?.action})`);
    assert(kept.sensitivity_tier === "personal" && Number(kept.importance) === 6, "…and leaves a hand-set tier and importance as they were — a fresh row's columns only");
  }

  // POST /ingest captures through the same createThought with the same actor (the README says so; this holds it).
  const ingested = "a fresh thought ingested through open-brain-rest";
  const ing = await send(h, "POST", "/ingest", { text: ingested });
  assert(ing.status === 200 && UUID.test(String(ing.json?.thought_id)), `POST /ingest answers the thought's id (${ing.status} ${JSON.stringify(ing.json).slice(0, 80)})`);
  if (UUID.test(String(ing.json?.thought_id))) {
    judgeCapture("open-brain-rest ingest", await row(String(ing.json.thought_id), ingested), ingested);
    judgeActor("open-brain-rest ingest", await auditRow(String(ing.json.thought_id), "capture"), "open-brain-rest");
  }

  const id = await plant("open-brain-rest");
  const text = "the text after the edit, through open-brain-rest";
  const r = await send(h, "PUT", `/thought/${id}`, { content: text, importance: 9, metadata: { via: "open-brain-rest" } });
  assert(r.status === 200 && r.json?.action === "updated", `PUT /thought/:id answers updated (${r.status})`);
  const after = await row(id, text);
  judgeEdit("open-brain-rest", after, await oracle("open-brain-rest", text), text);
  assert(after.metadata.via === "open-brain-rest", "the metadata is merged in the function");
  judgeActor("open-brain-rest edit", await auditRow(id, "update"), "open-brain-rest");
  const [side] = await sql`SELECT importance FROM thoughts WHERE id = ${id}`;
  assert(Number(side.importance) === 9, "the enhanced-thoughts column is written beside it");
  const meta = await send(h, "PUT", `/thought/${id}`, { status: "new" });
  const kept = await row(id, text);
  assert(meta.status === 200 && kept.at_axis === true && kept.embedding_model === MODEL && kept.fp_ok, "an edit without content leaves vector, label and fingerprint as they were");
  const gone = await send(h, "PUT", "/thought/00000000-0000-4000-8000-000000000000", { content: "nobody" });
  assert(gone.status === 404, "an unknown id is 404");

  // Under the NAMED key: the row names it — `principal.name`, not a constant that spells the legacy key's name.
  const named = await send(h, "PUT", `/thought/${id}`, { metadata: { named: true } }, NAMED_KEY);
  assert(named.status === 200, `a named write key (MCP_ACCESS_KEYS) edits (${named.status})`);
  judgeActor("open-brain-rest edit under a named key", await auditRow(id, "update"), "open-brain-rest", NAMED);
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
    judgeActor("rest-api capture", await auditRow(cid, "capture"), "rest-api");
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
  judgeActor("rest-api edit", await auditRow(id, "update"), "rest-api");
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
  judgeActor("rest-api enrich", await auditRow(id, "update"), "rest-api");

  // One key, compared in place: a named key is refused here, and the name this server records is its constant's (SMD-1798 moves it onto the module).
  const named = await send(h, "POST", "/capture", { content: "a capture under a named key, refused by rest-api" }, NAMED_KEY);
  assert(named.status === 401, `a named key (MCP_ACCESS_KEYS) is 401 here — this server knows its one MCP_ACCESS_KEY (${named.status})`);
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

// ── integrations/readwise-capture (SMD-1524) ─────────────────────────────────

{
  const F = "integrations/readwise-capture/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const text = "The happiness of your life depends upon the quality of your thoughts.";
  const note = "Book II, on attention";
  const content = `${text}\n\n— ${note}`;
  const event = (id: number) => ({ secret: READWISE_SECRET, event_type: "readwise.highlight.created", id, text, note, location: 12, location_type: "page",
    highlighted_at: "2026-09-01T00:00:00Z", url: null, color: "yellow", updated: "2026-09-01T00:00:00Z", book_id: BOOK.id, tags: [{ id: 1, name: "stoicism" }] });
  const r = await send(h, "POST", "/", event(9001));
  assert(r.status === 200 && r.text === "ok", `a highlight webhook answers ok (${r.status} ${r.text.slice(0, 60)})`);
  const id = await idOf(content);
  assert(id !== null, "…and the highlight, with its note, is a thought");
  if (id) {
    judgeCapture("readwise-capture", await row(id, content), content);
    const [side] = await sql`SELECT type, source_type, metadata FROM thoughts WHERE id = ${id}`;
    assert(side.type === "reference" && side.source_type === "readwise", "the enhanced-thoughts columns follow the capture, by the raw update that carries neither content nor vector");
    assert(side.metadata.readwise_highlight_id === 9001 && side.metadata.book_title === BOOK.title && side.metadata.tags?.[0] === "stoicism", "the highlight's metadata carries the book the receiver resolved");
    const [book] = await sql`SELECT title, num_highlights FROM readwise_books WHERE book_id = ${BOOK.id}`;
    assert(book?.title === BOOK.title && Number(book?.num_highlights) === BOOK.num_highlights + 1, `the book is cached and its count incremented (${book?.num_highlights})`);
    // Readwise retries the same event: the receiver's own dedupe answers before any write.
    const again = await send(h, "POST", "/", event(9001));
    assert(again.status === 200 && again.text === "duplicate", `a retried event is answered duplicate (${again.text})`);
    // A second highlight of the same passage: the function's dedup — one row, metadata merged, the hand-set columns kept.
    await sql`UPDATE thoughts SET sensitivity_tier = 'personal' WHERE id = ${id}`;
    const twin = await send(h, "POST", "/", event(9002));
    const rows = await sql`SELECT id, sensitivity_tier, metadata FROM thoughts WHERE content = ${content}`;
    assert(twin.status === 200 && twin.text === "ok" && rows.length === 1 && rows[0].id === id && rows[0].metadata.readwise_highlight_id === 9002 && rows[0].sensitivity_tier === "personal",
      `the same passage highlighted again is one row, its metadata merged, its hand-set tier kept (${rows.length} row(s), ${rows[0]?.sensitivity_tier})`);
    assert((await row(id, content)).at_axis === true && (await row(id, content)).embedding_model === MODEL, "…its vector and label as the function leaves them");
    const [audit] = await sql`SELECT actor_name, source FROM thought_audit WHERE thought_id = ${id} AND action = 'capture' ORDER BY created_at LIMIT 1`;
    assert(audit?.actor_name === null && audit?.source === "readwise", `008's audit row names no actor for a receiver without a key, and the source from metadata (${audit?.actor_name} ${audit?.source})`);
    // A first write interrupted between the function and the sidecar: the row lacks source_type, the
    // receiver's dedupe cannot see it, the function answers existed — and the sidecar heals it now.
    await sql`UPDATE thoughts SET source_type = NULL, type = NULL WHERE id = ${id}`;
    const healed = await send(h, "POST", "/", event(9004));
    const [shape] = await sql`SELECT source_type, type FROM thoughts WHERE id = ${id}`;
    assert(healed.status === 200 && healed.text === "ok" && shape.source_type === "readwise" && shape.type === "reference",
      `a re-capture of a row whose first write was interrupted completes its columns (${shape.source_type} ${shape.type})`);
    // A row another path captured first, typed by hand, with no source_type: the heal is per column.
    await sql`UPDATE thoughts SET source_type = NULL, type = 'idea' WHERE id = ${id}`;
    await send(h, "POST", "/", event(9005));
    const [kept] = await sql`SELECT source_type, type FROM thoughts WHERE id = ${id}`;
    assert(kept.source_type === "readwise" && kept.type === "idea", `…filling source_type while a hand-set type stays (${kept.source_type} ${kept.type})`);
  }
  // An event whose secret is wrong writes nothing: test-auth.ts holds the refusals; here, the row count.
  const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM thoughts`;
  await send(h, "POST", "/", { ...event(9003), secret: "not-the-secret" });
  const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM thoughts`;
  assert(before === after, "a request with the wrong secret writes no row");
}

// ── recipes/editorial-policy/auditor (SMD-1524) ──────────────────────────────

{
  const F = "recipes/editorial-policy/auditor/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  // The stubbed model answers metadata, not findings: the auditor reads no findings and stores an empty report — no Slack.
  const r = await send(h, "POST", "/", { days: 30, post_to_slack: false });
  assert(r.status === 200 && r.json?.ok === true && UUID.test(String(r.json?.stored_id)) && r.json?.finding_count === 0,
    `an audit stores its report and answers its id (${r.status} ${JSON.stringify(r.json).slice(0, 100)})`);
  const sid = String(r.json?.stored_id);
  if (UUID.test(sid)) {
    const [{ content }] = await sql`SELECT content FROM thoughts WHERE id = ${sid}`;
    const report = await row(sid, content);
    assert(report.fp_set && report.fp_ok, "the report's content_fingerprint is its text's (003) — the raw insert left NULL");
    assert(!report.has_vec && report.embedding_model === null, "the report carries no vector and so no label — the 2-argument form, said in the file");
    assert(report.metadata.type === "audit_report" && report.metadata.finding_count === 0 && Array.isArray(report.metadata.findings), "the structured findings ride in metadata");
    const [audit] = await sql`SELECT actor_name, source FROM thought_audit WHERE thought_id = ${sid} AND action = 'capture'`;
    assert(audit?.actor_name === "MCP_ACCESS_KEY" && audit?.source === "auditor-function", `008's audit row names the key that ran the audit (${audit?.actor_name} ${audit?.source})`);
    assert(/Audit/i.test(content) && report.chunks === 0, "the text is the rendered report; no chunk rows");
  }
}

// ── integrations/consolidation-workers/bio (SMD-1544) ────────────────────────

{
  const F = "integrations/consolidation-workers/bio/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  // The sources the worker gathers, planted through the function with their enhanced columns set beside it: two
  // person notes and a decision it should read; a restricted note, a minor decision and a note an earlier bio run
  // generated that it should not — the last kept out by `.is("metadata->>generated_by", null)`, the filter the shim refused.
  async function note(content: string, cols: { type: string; importance?: number; tier?: string; generated_by?: string }): Promise<string> {
    const [{ r }] = await sql`SELECT upsert_thought(${content}::text, ${{ metadata: cols.generated_by ? { generated_by: cols.generated_by } : {}, embedding_model: MODEL }}::jsonb, ${vec(unit(content))}::vector) AS r`;
    const id = String((r as { id: string }).id);
    await sql`UPDATE thoughts SET type = ${cols.type}, importance = ${cols.importance ?? 3}, sensitivity_tier = ${cols.tier ?? "standard"} WHERE id = ${id}`;
    return id;
  }
  await note("Test keeps a commonplace book of Stoic passages.", { type: "person_note" });
  await note("Test reads Marcus Aurelius every morning.", { type: "person_note" });
  await note("Decided that Test will lead the reading group.", { type: "decision", importance: 5 });
  await note("Test's medical history, in confidence.", { type: "person_note", tier: "restricted" });
  await note("Decided that Test brings the biscuits.", { type: "decision", importance: 2 });
  await note("An earlier profile of Test, written by a bio run.", { type: "person_note", generated_by: "consolidation-bio" });
  await note("Other collects fountain pens.", { type: "person_note" });
  const [{ n: logsBefore }] = await sql`SELECT count(*)::int AS n FROM consolidation_log`;

  // First run: the sources through the JSON-path filter, the profile through the 3-argument upsert_thought.
  const r = await send(h, "POST", "/?name=Test");
  assert(r.status === 200 && r.json?.action === "created" && r.json?.previous_profile_existed === false && UUID.test(String(r.json?.thought_id)),
    `POST /?name=Test answers 200 created with the profile's id — the shim renders the JSON-path filter the worker 500ed on (${r.status} ${JSON.stringify(r.json).slice(0, 120)})`);
  assert(r.json?.source_thought_count === 3 && r.json?.source_types?.person_notes === 2 && r.json?.source_types?.decisions === 1,
    `three sources, two person notes and a decision — the restricted note, the minor decision and the generated note excluded (${JSON.stringify(r.json?.source_types)})`);
  const prompt1 = bioPrompts[bioPrompts.length - 1] ?? "";
  assert(/commonplace book/.test(prompt1) && /reading group/.test(prompt1) && !/medical history/.test(prompt1) && !/earlier profile/.test(prompt1) && !/biscuits/.test(prompt1),
    "…and the prompt carries exactly those — the generated note kept out by `metadata->>generated_by IS NULL`");
  assert(/\(\d{4}-\d\d-\d\d, importance: \d+\)/.test(prompt1), "the prompt dates each source from created_at — the string PostgREST hands back, which the shim now does too");
  const id = String(r.json?.thought_id);
  const text1 = String(r.json?.profile);
  if (UUID.test(id)) {
    judgeCapture("consolidation-bio first run", await row(id, text1), text1);
    const [side] = await sql`SELECT type, importance, source_type, metadata FROM thoughts WHERE id = ${id}`;
    assert(side.type === "person_note" && Number(side.importance) === 5 && side.source_type === "system_profile", "the enhanced-thoughts columns follow, by the raw update that carries neither content nor vector");
    assert(side.metadata.generated_by === "consolidation-bio" && side.metadata.subject === "Test" && side.metadata.artifact_type === "biographical_profile" && side.metadata.source_thought_count === 3,
      "the profile's metadata names its generator, subject, kind and source count");
    const [audit] = await sql`SELECT actor_name, source, origin FROM thought_audit WHERE thought_id = ${id} AND action = 'capture'`;
    assert(audit?.actor_name === "MCP_ACCESS_KEY" && audit?.origin === "consolidation-bio" && audit?.source === null,
      `008's capture row names the key and the worker as the door (046's origin — SMD-1730; the worker's name was in source until then), and no source: the profile's metadata declares none (${audit?.actor_name} ${audit?.origin} ${audit?.source})`);
    const [log] = await sql`SELECT operation, survivor_id, details FROM consolidation_log ORDER BY id DESC LIMIT 1`;
    assert(log?.operation === "biographical_profile" && log?.survivor_id === id && log?.details?.action === "created", "the run is logged to consolidation_log as created");

    // Second run, same subject: the profile row — a person note naming Test — is kept out of the sources by its
    // generated_by, found as the existing profile by three path equalities, fed to the prompt, and rewritten
    // through update_thought — change 69's path on this worker, driven for the first time.
    await plantWindows(id);
    await sql`UPDATE thoughts SET embedding_model = 'model-before' WHERE id = ${id}`;
    const again = await send(h, "POST", "/?name=Test");
    assert(again.status === 200 && again.json?.action === "updated" && again.json?.thought_id === id && again.json?.previous_profile_existed === true,
      `a second run answers updated with the same id (${again.status} ${again.json?.action} ${again.json?.previous_profile_existed})`);
    assert(again.json?.source_thought_count === 3, `…its own profile not among the sources (${again.json?.source_thought_count})`);
    const prompt2 = bioPrompts[bioPrompts.length - 1] ?? "";
    assert(prompt2.includes(`<previous_profile>\n${text1}\n</previous_profile>`), "…and the previous profile in the prompt, found through `metadata->>subject`");
    const text2 = String(again.json?.profile);
    assert(text2 !== text1 && text2.startsWith("Canonical Profile:"), "the model answered a new profile, so the rewrite moves the text");
    judgeEdit("consolidation-bio rewrite", await row(id, text2), await oracle("consolidation-bio", text2), text2);
    const [side2] = await sql`SELECT type, importance, source_type, metadata FROM thoughts WHERE id = ${id}`;
    assert(side2.type === "person_note" && Number(side2.importance) === 5 && side2.source_type === "system_profile" && side2.metadata.source_thought_count === 3 && side2.metadata.subject === "Test",
      "the enhanced columns and the metadata are rewritten");
    const [audit2] = await sql`SELECT actor_name, source, origin FROM thought_audit WHERE thought_id = ${id} AND action = 'update' ORDER BY created_at DESC LIMIT 1`;
    assert(audit2?.actor_name === "MCP_ACCESS_KEY" && audit2?.origin === "consolidation-bio", `008's update row names the key and the worker as the door (${audit2?.actor_name} ${audit2?.origin})`);
    const [log2] = await sql`SELECT details FROM consolidation_log ORDER BY id DESC LIMIT 1`;
    assert(log2?.details?.action === "updated", "the run is logged as updated");

    // Another subject: a profile of its own, the first untouched.
    const other = await send(h, "POST", "/?name=Other");
    assert(other.status === 200 && other.json?.action === "created" && UUID.test(String(other.json?.thought_id)) && other.json?.thought_id !== id && other.json?.source_thought_count === 1,
      `a run for another name creates that subject's profile from its one note (${other.status} ${other.json?.action} ${other.json?.source_thought_count})`);
    assert((await row(id, text2)).content === text2, "…and leaves the first subject's profile as it was");
    const [{ n: logsMid }] = await sql`SELECT count(*)::int AS n FROM consolidation_log`;
    assert(logsMid === logsBefore + 3, `three runs, three log rows (${logsMid - logsBefore})`);
    // A dry run: the profile answered, nothing written, nothing logged.
    const [{ n: rowsBefore }] = await sql`SELECT count(*)::int AS n FROM thoughts`;
    const dry = await send(h, "POST", "/?name=Test&dry_run=true");
    const [{ n: rowsAfter }] = await sql`SELECT count(*)::int AS n FROM thoughts`;
    const [{ n: logsAfter }] = await sql`SELECT count(*)::int AS n FROM consolidation_log`;
    assert(dry.status === 200 && dry.json?.action === "preview" && dry.json?.thought_id === null && /^Canonical Profile:/.test(String(dry.json?.profile)) && rowsAfter === rowsBefore && logsAfter === logsMid,
      `a dry run previews the profile and writes no row and no log (${dry.status} ${dry.json?.action} ${rowsAfter - rowsBefore} ${logsAfter - logsMid})`);
    assert((await row(id, text2)).content === text2, "…the stored profile untouched");

    // A first run whose text the brain already holds — a concurrent run's row, or a hand-captured one: the function
    // answers `existed`, and the worker reports that row as not created and leaves its columns. The stub's next
    // profile text is predictable, so the row is planted first, typed by hand.
    const held = `Canonical Profile: Test is a reader of the Stoics (run ${bioPrompts.length + 1}).`;
    const heldId = await note(held, { type: "idea", importance: 2 });
    await note("Third annotates the margins.", { type: "person_note" });
    const third = await send(h, "POST", "/?name=Third");
    const [heldRow] = await sql`SELECT type, importance, metadata FROM thoughts WHERE id = ${heldId}`;
    assert(third.status === 200 && third.json?.action === "updated" && third.json?.previous_profile_existed === false && third.json?.thought_id === heldId,
      `a first run whose text a row already holds answers that row's id as updated, not created (${third.status} ${third.json?.action} ${third.json?.thought_id === heldId})`);
    assert(heldRow.type === "idea" && Number(heldRow.importance) === 2 && heldRow.metadata.generated_by === "consolidation-bio" && heldRow.metadata.subject === "Third",
      `…leaving its hand-set columns, the profile's metadata merged by the function (${heldRow.type} ${heldRow.importance} ${heldRow.metadata.subject})`);
  }
  const none = await send(h, "POST", "/?name=Nobody");
  assert(none.status === 404 && /No source thoughts/.test(String(none.json?.error)), `a name with no sources is 404 (${none.status})`);
}

// ── The files that cannot run here say what this test assumes ────────────────

console.log("\n[the files say what this test assumes]");
const spells = (rel: string, re: RegExp, what: string) => assert(re.test(readFileSync(join(ROOT, rel), "utf8")), `${rel} ${what}`);
// A paste-in snippet with free variables; a README's sample.
spells("recipes/provenance-chains/mcp-tools.ts", /"upsert_thought",\s*\{\s*p_content: content,\s*p_payload: \{[^}]*embedding_model: EMBEDDING_MODEL/s, "captures content, vector and label in one 3-argument upsert_thought");
spells("recipes/provenance-chains/mcp-tools.ts", /p_embedding: embedding,/, "…passing the vector as p_embedding");
spells("recipes/provenance-chains/mcp-tools.ts", /\.select\("id"\)\s*\.in\("id", wellFormed\)/s, "…and resolves each well-formed ref before the call, so a ghost parent is unresolved, not a refusal");
// The bio worker is driven above (SMD-1544); it reads its keys at import, so the one configuration it refuses is read here.
spells("integrations/consolidation-workers/bio/index.ts", /if \(!OPENROUTER_API_KEY && !OPENAI_API_KEY\) \{\s*return json\(\{ error: "An embedding key is required/s, " refuses an Anthropic-only configuration before it pays for the profile it could not store");
spells("integrations/telegram-capture/README.md", /rpc\("update_thought", \{\s*p_id: existing\[0\]\.id,\s*p_content: messageText,/s, "'s sample edits through update_thought");
spells("integrations/telegram-capture/README.md", /p_embedding_model: EMBEDDING_MODEL,/, "…with the label beside the vector");
// SMD-1524: the example capture, the two Python recipes and the two README samples capture through the function.
spells("integrations/readwise-capture/index.ts", /\.update\(\{ \[column\]: value \}\)\s*\.eq\("id", result\.id\)\s*\.is\(column, null\)/s, " writes each column where it is NULL — a fresh row, or one an interrupted first write left half-shaped");
spells("recipes/readwise-import/import-readwise.py", /for column in \("source_type", "type"\):\s*supabase\.table\("thoughts"\)\.update\(\s*\{column: thoughts\[0\]\[column\]\}\s*\)\.in_\("id", ids\)\.is_\(column, "null"\)\.execute\(\)/s, " writes each column over the batch's rows where it is NULL");
spells("recipes/adaptive-capture-classification/capture-with-gating.ts", /db\.rpc\("upsert_thought", \{\s*p_content: classified\.title,\s*p_payload: \{\s*metadata: \{/s, " captures through upsert_thought, the classifier's fields in metadata");
spells("recipes/local-ollama-embeddings/embed-local.py", /\/rest\/v1\/rpc\/upsert_thought/, " posts to the function, not the table");
spells("recipes/local-ollama-embeddings/embed-local.py", /"p_payload": \{"metadata": metadata_dict, "embedding_model": model\},\s*"p_embedding": embedding,/s, "…with the vector and the Ollama model's name as its label");
spells("recipes/readwise-import/import-readwise.py", /supabase\.rpc\(\s*"upsert_thought",\s*\{\s*"p_content": thought\["content"\],\s*"p_payload": \{\s*"metadata": thought\["metadata"\],\s*"embedding_model": EMBEDDING_MODEL,\s*\},\s*"p_embedding": thought\["embedding"\],/s, " stores each highlight through the 3-argument upsert_thought with its label");
spells("recipes/readwise-import/import-readwise.py", /ids\.append\(str\(data\["id"\]\)\)\s*if not data\.get\("existed"\):\s*fresh \+= 1\s*except BaseException as e:\s*loop_error = e\s*raise\s*finally:[\s\S]{0,1200}?if ids:\s*try:\s*for column in \("source_type", "type"\):\s*supabase\.table\("thoughts"\)\.update\(/s, "…and writes the enhanced columns once per column per batch, in a finally, so a refused reply leaves no half-shaped row behind it — the loop's own error staying the one raised");
spells("recipes/readwise-import/import-readwise.py", /if not data\.get\("id"\):[\s\S]{0,400}?raise RuntimeError\(/, "…and refuses a reply that names no id instead of skipping the row");
for (const sample of ["integrations/telegram-capture/README.md", "integrations/slack-capture/README.md"]) {
  spells(sample, /rpc\("upsert_thought", \{\s*p_content: messageText,\s*p_payload: \{\s*metadata: \{[^}]*\},\s*embedding_model: EMBEDDING_MODEL,\s*\},\s*p_embedding: embedding,/s, "'s sample captures through the 3-argument upsert_thought with the label beside the vector");
}
// SMD-1541: the two servers that compare one key in place spell the legacy key's name themselves. The name is the one
// auth.ts gives the same key, so one physical key reads the same in `actor_name` whichever module compared it; the
// arms above assert the one literal for all five, and these hold the spelling at its sources — the auth.ts copy the
// three principal servers import (test-auth.ts holds the six copies byte-identical) and the two constants.
spells("integrations/_shared/auth.ts", /found = \{ name: "MCP_ACCESS_KEY", scope: "write"/, " names the legacy single key MCP_ACCESS_KEY");
for (const f of ["integrations/enhanced-mcp/index.ts", "integrations/rest-api/index.ts"]) spells(f, /^const ACTOR_NAME = "MCP_ACCESS_KEY";$/m, " spells the same name as its ACTOR_NAME");
// The three that own their database say they bypass the functions, in the file and in the README.
for (const [file, readme] of [["integrations/kubernetes-deployment/index.ts", "integrations/kubernetes-deployment/README.md"], ["recipes/vercel-neon-telegram/src/lib/db.ts", "recipes/vercel-neon-telegram/README.md"], ["recipes/schema-aware-routing/index.ts", "recipes/schema-aware-routing/README.md"]]) {
  spells(file, /ob1-fork \(SMD-1524\):[^\n]*raw (?:INSERT|insert), by design/, " says its raw insert is by design — a database of its own");
  spells(readme, /no content fingerprint/, " says what its rows lack");
}
// Every runnable file the three changes touched is driven above, or read: the headers name them.
const BIO = "integrations/consolidation-workers/bio/index.ts";
const DRIVEN = ["integrations/update-thought-mcp/index.ts", "integrations/enhanced-mcp/index.ts", "integrations/agent-memory-api/index.ts",
  "integrations/open-brain-rest/index.ts", "integrations/rest-api/index.ts", "recipes/repo-learning-coach/server/brain.ts", BIO];
const TEXT_ONLY = ["recipes/provenance-chains/mcp-tools.ts"];
const DRIVEN_1524 = ["integrations/readwise-capture/index.ts", "recipes/editorial-policy/auditor/index.ts", BIO];
const TEXT_ONLY_1524 = ["recipes/adaptive-capture-classification/capture-with-gating.ts"];
const BYPASS_1524 = ["integrations/kubernetes-deployment/index.ts", "recipes/vercel-neon-telegram/src/lib/db.ts", "recipes/schema-aware-routing/index.ts"];
const DRIVEN_1544 = [BIO];
const DRIVEN_1541 = ["integrations/update-thought-mcp/index.ts", "integrations/enhanced-mcp/index.ts", "integrations/agent-memory-api/index.ts",
  "integrations/open-brain-rest/index.ts", "integrations/rest-api/index.ts"]; // change 69's five servers: the ones that hold a key
// Every vendored .ts, read once; each ticket's rule tests the same texts.
const HEADED = [...new Bun.Glob("{recipes,integrations}/**/*.ts").scanSync({ cwd: ROOT })]
  .filter((f) => !f.includes("node_modules")).map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const);
for (const [ticket, files] of [["SMD-1228", [...DRIVEN, ...TEXT_ONLY]], ["SMD-1524", [...DRIVEN_1524, ...TEXT_ONLY_1524, ...BYPASS_1524]], ["SMD-1544", DRIVEN_1544], ["SMD-1541", DRIVEN_1541]] as const) {
  const headed = HEADED.filter(([, text]) => new RegExp(ticket).test(text)).map(([f]) => f).sort();
  assert(headed.join() === [...files].sort().join(), `every .ts file that names ${ticket} is driven here or read here, and vice versa (${headed.join(", ")})`);
}
{
  assert(existsSync(join(ROOT, "scripts/check-fork-consistency.ts")) && /function thoughtWritesAroundIn\(/.test(readFileSync(join(ROOT, "scripts/check-fork-consistency.ts"), "utf8")),
    "scripts/check-fork-consistency.ts check 10 holds the text of every file: no raw write of content or vector on thoughts");
}

} catch (e) {
  // A throw is a failure with a tally, not a stack trace in place of one.
  assert(false, `the suite threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  try {
    await dropSidecars();
  } catch (e) {
    console.error(`test-writes.ts: dropping the sidecars failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  await sql.close();
}
report();
