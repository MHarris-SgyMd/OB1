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
 * scripts/check-consistency.ts check 10 holds the text; this proves the
 * behaviour: each writer that can run is driven as deployed against a real
 * Postgres carrying Daemonic Brain's schema, and the row it leaves is compared
 * with the row update_thought leaves for the same edit — the ticket's own
 * verify.
 *
 * SMD-1524 (FORK.md change 71) added the other door: eight vendored files
 * INSERTED a fresh row with content, or content and a vector, around the
 * 3-argument upsert_thought — a webhook receiver, a worker's first run, an
 * auditor's report, a recipe's example capture, two Python recipes and two
 * README samples — and so left 003's fingerprint NULL (016's trigger does not
 * fill it; the row invisible to dedup, a later capture of the text a twin) and
 * 021's label NULL (a vector of unknown model). The auditor is driven here
 * (the receiver, readwise-capture, is the readwise plugin's hook since
 * SMD-2690, which captures through the core); the rest are read. Three more deployments write a raw row
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
 * in Daemonic Brain the worker answered 500 at its first query and everything
 * changes 69 and 71 gave its write paths was held by the text guards alone.
 * With the shim rendering the path — and handing a timestamp back as a
 * string, as PostgREST does, which the worker's prompt slices — the worker runs
 * here on both paths: the sources chosen by the filters, the first profile
 * through the 3-argument upsert_thought, the rewrite through update_thought
 * with the previous profile found through three path equalities and the
 * profile's own row kept out of its sources.
 *
 * SMD-1541 (FORK.md change 103) reads 008's row after every driven capture and
 * edit through change 69's servers (five then; one, agent-memory-api, from
 * SMD-1931, which retired the two REST gateways and the two MCP servers, to
 * SMD-2690, which made it a plugin; smart-ingest from SMD-2128 to SMD-2690). Their
 * headers said "the actor reaches
 * the audit (008)" and none passed one — the functions set `ob1.actor` only
 * from `p_actor` / `p_payload.actor` — so `thought_audit.actor_name` was NULL
 * for every write through them, as for the raw writes they replaced. It names
 * the key now: `principal.name`, since it authenticates through
 * `_shared/auth.ts` — `MCP_ACCESS_KEY` under this suite's legacy single key.
 * (A NAMED key's arm, which told the principal's name from a constant that
 * spells the legacy key's, left with agent-memory-api: the plugins name their
 * caller through the core, which their suites hold.) No actor carries a
 * source — the trigger (008; its body is 025's now) reads the row's own
 * `metadata.source`, so the column means the thought's origin on every row,
 * and a copy of it in the actor was indistinguishable from that fallback under
 * the mutant run — and every actor names the server as `via`, which the
 * trigger keeps in `actor_context`: the arm that holds the actor object's
 * arrival on every site. The `source` column is judged against the thought's
 * own `metadata.source`, which
 * is what the trigger writes when no actor names one: the arm fails for a
 * server that starts naming a source of its own (the first draft's server name
 * on an edit) and tolerates only a copy of the origin, the one case the rule
 * allows; server-portable/test-audit.ts holds the trigger itself.
 *
 * SMD-2110 and SMD-2128 drove smart-ingest here: its extraction trigger's
 * address, its write path through the 3-argument upsert_thought, its item
 * columns' uuid retype and its trust. It is the smart-ingest plugin since
 * SMD-2690, which writes through the core (test-plugin-ports.ts holds it).
 *
 * The files are imported as modules — each exports Bun's entry shape, and its
 * default export's `fetch` is the handler driven here (SMD-1799); every server
 * imports compat/supabase-sql itself since SMD-1798, and resolves its packages
 * through the install in integrations/ and the committed recipes/node_modules
 * link (SMD-1991). The model provider is stubbed — a unit vector keyed off the
 * text, so the vector a writer stored is recognisable — and
 * everything below the tool or route boundary is real; test-auth.ts is where
 * the servers start under bun for real.
 *
 * The database is Daemonic Brain's migrations plus a vendored sidecar the
 * writers assume: schemas/enhanced-thoughts (the columns the APIs write
 * beside the function — type, importance, sensitivity_tier …) — and the bio worker's log
 * table, `consolidation_log`, from `schemas/entity-extraction/schema.sql`'s
 * definition alone (that sidecar's other tables include a `thought_entities`
 * migration 016 owns). Their tables and
 * functions are dropped before they are applied and again at the end, whether
 * or not the run finished (an aborted run's orphaned rows would meet the next
 * run's: agent-memory-api's write-back once short-circuited on one), because CI
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
// the brain is built at ITS width. Daemonic Brain's default is
// qwen3-embedding:4b at 1024, where every one of these writers' vectors is
// refused by the function and the capture or edit fails whole; that case is the
// operator's to avoid (each README says so) and is not driven here.
const DIM = 1536;
const MODEL = "openai/text-embedding-3-small";
await resetSchema(URL_, { dim: DIM, model: MODEL });
const sql = new SQL({ url: URL_, max: 2 });

const SIDECARS = ["schemas/enhanced-thoughts/schema.sql"];
// The sidecars grant to no Supabase role since change 93 (SMD-1796), so none is created first — until SMD-1810 this
// suite still created the three, and since CI ran it before test-tools.ts on one Postgres (until SMD-2311 retired
// that suite), test-tools' "no Supabase role" probe met them on every run.
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
/** The user message of each bio prompt the stub answered — what the worker's filters gathered. */
const bioPrompts: string[] = [];
/** Every URL the stub was handed, suite long: none may begin postgres:// (SMD-2110; the tail asserts it). */
const reached: string[] = [];
/** The headers of every call, beside its URL: none may carry the connection string or its password (SMD-3875; the tail). */
const sent: { url: string; headers: Headers }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  reached.push(url);
  sent.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
  if (!/openrouter\.ai|api\.openai\.com/.test(url)) throw new Error(`test-writes.ts: a writer reached ${url}; only the model provider is stubbed`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/embeddings")) {
    return Response.json({ data: [{ embedding: unit(String(body.input)) }] });
  }
  // The bio worker's prompt is answered with a profile — text, not metadata — naming its run, so each run's text is new.
  if (/synthesizing a biographical profile/.test(String(body.messages?.[0]?.content ?? ""))) {
    bioPrompts.push(String(body.messages?.[1]?.content ?? ""));
    return Response.json({ choices: [{ message: { content: `Canonical Profile: Test is a reader of the Stoics (run ${bioPrompts.length}).` } }] });
  }
  // The metadata worker's classifier is answered with a confident, material reclassification (SMD-1798).
  if (/classifier for personal thoughts/.test(String(body.messages?.[0]?.content ?? ""))) {
    return Response.json({ choices: [{ message: { content: JSON.stringify({ type: "decision", importance: 4, topics: ["ledger"], confidence: 0.95, reason: "stub" }) } }] });
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(STUB_METADATA) } }] });
}) as typeof fetch;

// ── The servers' handlers; their packages from this directory's install ──────

type Handler = (req: Request) => Response | Promise<Response>;
// A recipe or integration imports STACK's packages (hono and zod) by bare name and has no install of its own beside it; they resolve
// from integrations/node_modules, the integrations from under it and the recipes through the committed
// recipes/node_modules link, which test-auth.ts holds (SMD-1991; this directory's since SMD-3747).

// One key, presented as `x-brain-key`: the older single MCP_ACCESS_KEY, which
// the servers on _shared/auth.ts accept with write scope (compared by digest).
// No named key: its one witness here,
// agent-memory-api's write-back (SMD-1541), is the agent-memory plugin since
// SMD-2690, which names its caller through the core.
const KEY = "one-write-key-for-every-writer";
process.env.SUPABASE_URL = URL_;
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.MCP_ACCESS_KEY = KEY;
delete process.env.MCP_ACCESS_KEYS;
process.env.OPENROUTER_API_KEY = "stub-openrouter-key"; // the writers' first-choice provider; its model name is the label
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"]) delete process.env[name];
// The auditor's key and Slack settings (read at import; Slack is never reached).
process.env.AUDITOR_ACCESS_KEY = KEY;
delete process.env.AUDITOR_ACCESS_KEYS;
process.env.SLACK_BOT_TOKEN = "stub";
process.env.SLACK_CAPTURE_CHANNEL = "C0STUB";

async function load(rel: string): Promise<Handler> {
  // The handler Bun would serve: the module's default export's `fetch` (SMD-1799); nothing stands in for `Deno`.
  const mod = (await import(join(ROOT, rel))) as { default?: { fetch?: unknown } };
  assert(typeof mod.default?.fetch === "function", `${rel} imports as a module and exports default { fetch }`);
  return mod.default!.fetch as Handler;
}

// ── One request ──────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": KEY };
type Reply = { status: number; json: any; text: string; headers: Headers };
// The writers log what they refuse, and the status is the assertion, so a request runs with console.error and
// console.warn silenced. Counted, not saved-and-restored per call: two requests in flight at once (a Promise.all of
// sends, SMD-2054) each saved what they found, and the second saved the first's silence and restored THAT — every
// later failure of the suite, which assert() prints through console.error, vanished from the log while the tally
// counted it. The console is restored when the last request in flight returns.
const CONSOLE = { error: console.error, warn: console.warn };
let inFlight = 0;
async function send(handler: Handler, method: string, path: string, body?: unknown, key = KEY): Promise<Reply> {
  if (inFlight++ === 0) { console.error = () => {}; console.warn = () => {}; }
  let r: Response;
  try {
    const headers = { ...HEADERS, "x-brain-key": key };
    r = await handler(new Request("http://writer.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  } finally {
    if (--inFlight === 0) Object.assign(console, CONSOLE);
  }
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  let json: any = null;
  try { json = line ? JSON.parse(line) : null; } catch { json = null; }
  return { status: r.status, json, text, headers: r.headers };
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
// The audit arms of SMD-1541 (008's row naming the key and the door) left with the last server that held a key, smart-ingest,
// a plugin since SMD-2690: the plugins name their caller through the core, which test-plugin-ports.ts holds.
// Everything below runs inside one try so the sidecars are dropped however it ends.
try {

// ── integrations/consolidation-workers/metadata-norm (SMD-1798) ──────────────

{
  const F = "integrations/consolidation-workers/metadata-norm/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  // A candidate — a reference of weak confidence, unreviewed — beside one the worker's two and() groups over JSON
  // paths must leave alone: the .or() the shim reads since SMD-1798.
  // Planted as the other rows are, then given the enhanced columns and the metadata the worker's filters read (a
  // write of neither content nor vector, so not one check 10 counts). One row for each and() group — an idea of
  // default importance, a reference of another importance — so each arm selects a row the other does not (the
  // fourth review pass's mutant: with both rows reference/3, either arm alone found them), beside a confident one.
  const weak = await plant("metadata-norm weak");
  await sql`UPDATE thoughts SET type = 'idea', importance = 3, metadata = metadata || '{"confidence": 0.5, "topics": ["old"]}'::jsonb WHERE id = ${weak}`;
  const weakRef = await plant("metadata-norm weak reference");
  await sql`UPDATE thoughts SET type = 'reference', importance = 2, metadata = metadata || '{"confidence": 0.5}'::jsonb WHERE id = ${weakRef}`;
  const strong = await plant("metadata-norm strong");
  await sql`UPDATE thoughts SET type = 'reference', importance = 3, metadata = metadata || '{"confidence": 0.95}'::jsonb WHERE id = ${strong}`;
  const dry = await send(h, "POST", "/?dry_run=true&limit=10");
  const dryIds = ((dry.json?.changes ?? []) as { thought_id: string }[]).map((c) => c.thought_id).sort();
  assert(dry.status === 200 && dry.json?.candidates_found === 2 && dry.json?.changed === 2 && dry.json?.dry_run === true && dryIds.join() === [weak, weakRef].sort().join(),
    `a dry run finds the two weak rows, one through each and() group on the JSON path, not the confident one — through the shim — and says what it would change (${dry.status}: ${JSON.stringify(dry.json).slice(0, 140)})`);
  const [before] = await sql`SELECT type, importance, metadata FROM thoughts WHERE id = ${weak}`;
  assert(before.type === "idea" && before.metadata.consolidation_reviewed === undefined, "…and writes nothing");
  const run = await send(h, "POST", "/?limit=10");
  assert(run.status === 200 && run.json?.changed === 2 && run.json?.errors === 0 && run.json?.llm_calls === 2, `a live run reclassifies both through the stubbed classifier (${run.status}: ${JSON.stringify(run.json).slice(0, 140)})`);
  const [after] = await sql`SELECT type, importance, metadata FROM thoughts WHERE id = ${weak}`;
  assert(after.type === "decision" && Number(after.importance) === 4 && after.metadata.consolidation_reviewed === true && JSON.stringify(after.metadata.topics) === JSON.stringify(["old", "ledger"]),
    `…the type and importance from the answer, the topics merged, the row marked reviewed (${JSON.stringify({ type: after.type, importance: after.importance, topics: after.metadata.topics, reviewed: after.metadata.consolidation_reviewed })})`);
  const [{ n: logged }] = await sql`SELECT count(*)::int AS n FROM consolidation_log WHERE operation = 'metadata_quality' AND survivor_id = ${weak}`;
  assert(logged === 1, `…and one consolidation_log row for it (${logged})`);
  const again = await send(h, "POST", "/?limit=10");
  assert(again.status === 200 && again.json?.candidates_found === 0, `a second run finds no candidate — the reviewed marker excludes it (${again.json?.candidates_found})`);
}

// ── recipes/editorial-policy/auditor (SMD-1524) ──────────────────────────────

{
  const F = "recipes/editorial-policy/auditor/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  // The stubbed model answers metadata, not findings: the auditor reads no findings and stores an empty report — no Slack.
  const mark = sent.length;
  const r = await send(h, "POST", "/", { days: 30, post_to_slack: false });
  // SMD-3875: the model call's Referer is the fixed one, where it was SUPABASE_URL — the connection string, password and all.
  // The message says the Referer only when it is the fixed one: any other value may be the password itself.
  const REFERER = "https://github.com/NateBJones-Projects/OB1";
  const asked = sent.slice(mark).filter((c) => c.url.endsWith("/chat/completions"));
  assert(asked.length === 1 && asked[0].headers.get("http-referer") === REFERER,
    `the audit's one model call sends the fixed Referer, never the connection string (${asked.length} calls; ${asked.map((c) => { const v = c.headers.get("http-referer"); return v === REFERER ? v : v === null ? "no Referer" : /postgres(ql)?:/.test(v) ? "a postgres:// URL" : "another value, withheld"; }).join(" ")})`);
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
// SMD-1524: the example capture, the Python recipe and the two README samples capture through the function (the second
// Python recipe, local-ollama-embeddings' embed-local.py, retired with SMD-2138).
spells("recipes/readwise-import/import-readwise.py", /for column in \("source_type", "type"\):\s*supabase\.table\("thoughts"\)\.update\(\s*\{column: thoughts\[0\]\[column\]\}\s*\)\.in_\("id", ids\)\.is_\(column, "null"\)\.execute\(\)/s, " writes each column over the batch's rows where it is NULL");
spells("recipes/adaptive-capture-classification/capture-with-gating.ts", /db\.rpc\("upsert_thought", \{\s*p_content: classified\.title,\s*p_payload: \{\s*metadata: \{/s, " captures through upsert_thought, the classifier's fields in metadata");
spells("recipes/readwise-import/import-readwise.py", /supabase\.rpc\(\s*"upsert_thought",\s*\{\s*"p_content": thought\["content"\],\s*"p_payload": \{\s*"metadata": thought\["metadata"\],\s*"embedding_model": EMBEDDING_MODEL,\s*(?:#[^\n]*\s*)*"event": \{"trust": "ingested"\},\s*\},\s*"p_embedding": thought\["embedding"\],/s, " stores each highlight through the 3-argument upsert_thought with its label");
spells("recipes/readwise-import/import-readwise.py", /ids\.append\(str\(data\["id"\]\)\)\s*if not data\.get\("existed"\):\s*fresh \+= 1\s*except BaseException as e:\s*loop_error = e\s*raise\s*finally:[\s\S]{0,1200}?if ids:\s*try:\s*for column in \("source_type", "type"\):\s*supabase\.table\("thoughts"\)\.update\(/s, "…and writes the enhanced columns once per column per batch, in a finally, so a refused reply leaves no half-shaped row behind it — the loop's own error staying the one raised");
spells("recipes/readwise-import/import-readwise.py", /if not data\.get\("id"\):[\s\S]{0,400}?raise RuntimeError\(/, "…and refuses a reply that names no id instead of skipping the row");
for (const sample of ["integrations/telegram-capture/README.md", "integrations/slack-capture/README.md"]) {
  spells(sample, /rpc\("upsert_thought", \{\s*p_content: messageText,\s*p_payload: \{\s*metadata: \{[^}]*\},\s*embedding_model: EMBEDDING_MODEL,\s*\},\s*p_embedding: embedding,/s, "'s sample captures through the 3-argument upsert_thought with the label beside the vector");
}
// SMD-1541: the legacy key's name is the one auth.ts gives it, so one physical key reads the same in `actor_name`
// whichever server compared it; the arms above assert the one literal for every server driven, and this holds the
// spelling at its source — the auth.ts copy the principal servers import (test-auth.ts holds the copies byte-identical).
spells("integrations/_shared/auth.ts", /found = \{ name: "MCP_ACCESS_KEY", scope: "write"/, " names the legacy single key MCP_ACCESS_KEY");
// The two that own their database say they bypass the functions, in the file and in the README.
for (const [file, readme] of [["recipes/vercel-neon-telegram/src/lib/db.ts", "recipes/vercel-neon-telegram/README.md"], ["recipes/schema-aware-routing/index.ts", "recipes/schema-aware-routing/README.md"]]) {
  spells(file, /ob1-fork \(SMD-1524\):[^\n]*raw (?:INSERT|insert), by design/, " says its raw insert is by design — a database of its own");
  spells(readme, /no content fingerprint/, " says what its rows lack");
}
// Every runnable file the three changes touched is driven above, or read: the headers name them.
const BIO = "integrations/consolidation-workers/bio/index.ts";
const DRIVEN = [BIO]; // repo-learning-coach's brain.ts retired (SMD-2923); agent-memory-api and smart-ingest are plugins (SMD-2690)
const TEXT_ONLY = ["recipes/provenance-chains/mcp-tools.ts"];
const DRIVEN_1524 = ["recipes/editorial-policy/auditor/index.ts", BIO]; // readwise-capture is the readwise plugin since SMD-2690
const TEXT_ONLY_1524 = ["recipes/adaptive-capture-classification/capture-with-gating.ts"];
const BYPASS_1524 = ["recipes/vercel-neon-telegram/src/lib/db.ts", "recipes/schema-aware-routing/index.ts"];
const DRIVEN_1544 = [BIO];
const DRIVEN_1541: string[] = []; // change 69's servers that held a key, agent-memory-api and smart-ingest, are plugins since SMD-2690, naming their caller through the core
// Every vendored .ts, read once; each ticket's rule tests the same texts. The suites beside the install in
// integrations/ (here since SMD-3747) are not vendored servers: they name the tickets they test.
const HEADED = [...new Bun.Glob("{recipes,integrations}/**/*.ts").scanSync({ cwd: ROOT })]
  .filter((f) => !f.includes("node_modules") && f !== "integrations/test-auth.ts" && f !== "integrations/test-writes.ts").map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const);
for (const [ticket, files] of [["SMD-1228", [...DRIVEN, ...TEXT_ONLY]], ["SMD-1524", [...DRIVEN_1524, ...TEXT_ONLY_1524, ...BYPASS_1524]], ["SMD-1544", DRIVEN_1544], ["SMD-1541", DRIVEN_1541]] as const) {
  const headed = HEADED.filter(([, text]) => new RegExp(ticket).test(text)).map(([f]) => f).sort();
  assert(headed.join() === [...files].sort().join(), `every .ts file that names ${ticket} is driven here or read here, and vice versa (${headed.join(", ")})`);
}
{
  assert(existsSync(join(ROOT, "scripts/check-consistency.ts")) && /function thoughtWritesAroundIn\(/.test(readFileSync(join(ROOT, "scripts/check-consistency.ts"), "utf8")),
    "scripts/check-consistency.ts check 10 holds the text of every file: no raw write of content or vector on thoughts");
}
// SMD-2110: an HTTP target comes from its own variable, never from SUPABASE_URL — the connection string in Daemonic Brain. Every
// URL the stub was handed, by every writer this suite drove: no URL built on that variable.
assert(reached.length > 0 && !reached.some((u) => /^postgres(ql)?:/.test(u) || u.includes("/functions/v1/")),
  `no writer handed fetch() a postgres:// URL or a /functions/v1/ path, suite long (${reached.length} calls; ${reached.filter((u) => /^postgres(ql)?:/.test(u) || u.includes("/functions/v1/")).slice(0, 3).map((u) => u.replace(/\/\/[^/@]*@/, "//…@")).join(" ")})`); // userinfo redacted: it is the password
// SMD-3875: nor a header. The auditor sent SUPABASE_URL to OpenRouter as its Referer. No header of any call, by any writer
// this suite drove, carries the connection string, a postgres:// URL or the password. CI's DSN has a password of 7
// characters; one shorter than PASSWORD_MIN ("stub", "key") is skipped, as the suite's own header values hold such words.
{
  const PASSWORD_MIN = 6;
  const password = decodeURIComponent(new URL(URL_).password);
  const checked = password.length >= PASSWORD_MIN;
  const leaks = sent.flatMap((c) => [...c.headers].filter(([, v]) => v.includes(URL_) || /postgres(ql)?:\/\//.test(v) || (checked && v.includes(password))).map(([k]) => `${k} to ${new URL(c.url).host}`));
  assert(sent.length > 0 && leaks.length === 0,
    `no writer sent the connection string or its password in a header, suite long (${sent.length} calls${checked ? "" : `; this DSN's password is ${password === "" ? "empty" : `under ${PASSWORD_MIN} characters`}, so only its URL is checked`}; ${leaks.slice(0, 3).join(", ") || "none"})`); // names the header, never its value
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
