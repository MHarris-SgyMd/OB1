#!/usr/bin/env bun
/**
 * test-e2e-sql.ts — the whole server, over MCP, backed by SQL, against real Postgres.
 *
 * test-store-sql.ts proves the store's methods behave. This proves the thing that
 * actually matters for Phase 2: an MCP client calling the documented tools gets the
 * same answers with PostgREST removed entirely. It drives the real server through
 * real JSON-RPC, with OB1_STORE=sql and no Supabase anywhere.
 *
 * The embedding provider is stubbed — the point is the data layer, and hitting
 * OpenRouter would make the suite non-hermetic and cost money. Everything below
 * the tool boundary is real.
 *
 *   ../db/with-postgres.sh bun test-e2e-sql.ts
 */

import { SQL } from "bun";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-e2e-sql.ts");
  process.exit(2);
}

/**
 * db/migrations/*.sql are templates — migrate.ts substitutes these at apply time.
 * Applying them raw fails with `syntax error at or near "{"`.
 */
// Pinned, not inherited from the shipped defaults. This suite asserts the data
// layer, not the model choice, and reading the default meant the schema it built
// and the width the server expected drifted apart the moment the default changed.
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1536);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;
function subst(sql: string): string {
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(EMBEDDING_DIM))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, EMBEDDING_MODEL);
}

const { assert, report } = createAssert();

// Fresh schema.
await resetSchema(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

// ── Stub only the model provider ─────────────────────────────────────────────
// A deterministic embedding keyed off the text, so search ordering is predictable.
const KNOWN: Record<string, number> = { alpha: 0, beta: 1, gamma: 2 };
function axisFor(text: string): number {
  const key = Object.keys(KNOWN).find((k) => text.toLowerCase().includes(k));
  return key ? KNOWN[key] : 3;
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(STUB_BASE)) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/embeddings")) {
      const v = new Array(EMBEDDING_DIM).fill(0);
      v[axisFor(String(body.input))] = 1;
      return new Response(JSON.stringify({ data: [{ embedding: v }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: ["stubbed"], type: "idea" }) } }] }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// ── Boot the real server with the SQL store ──────────────────────────────────
// A provider host this suite owns, so the stub matches on something it controls
// rather than on whatever the shipped default happens to be. Matching the literal
// "openrouter.ai" meant the stub stopped intercepting the moment the default base
// URL moved to Ollama, and the test hit the real provider.
const STUB_BASE = "https://stub.invalid/v1";
process.env.OB1_LLM_BASE_URL = STUB_BASE;

process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OPENROUTER_API_KEY = "stub";
process.env.MCP_ACCESS_KEY = "e2e-key";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const H = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "x-brain-key": "e2e-key",
};

let rpcId = 1;
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const body = JSON.parse(line);
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  const content = body.result?.content ?? [];
  const joined = content.map((c: { text?: string }) => c.text ?? "").join("\n");
  if (body.result?.isError) throw new Error(`tool error: ${joined}`);
  return joined;
}

console.log(`  store: OB1_STORE=${process.env.OB1_STORE}, SUPABASE_URL unset\n`);

console.log("[1] The server runs with no Supabase configuration at all");
{
  assert(process.env.SUPABASE_URL === undefined, "SUPABASE_URL is not set");
  const r = await fetch(BASE, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const b = JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  assert(b.result?.tools?.length === 8, `all eight tools still registered (${b.result?.tools?.length})`);
}

console.log("\n[2] capture_thought writes through SQL");
{
  const out = await call("capture_thought", { content: "alpha thought about migrations" });
  assert(/Captured as/.test(out), `capture reports success (${out.split("\n")[0].slice(0, 50)}…)`);
  assert(!/NOT appear in semantic search/.test(out), "no degraded-write warning");

  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT content, metadata, embedding IS NOT NULL AS has FROM thoughts`;
  assert(row.content === "alpha thought about migrations", "the row is in Postgres");
  assert(row.has === true, "the embedding was stored in the same write");
  assert(row.metadata?.source === "mcp", `metadata survived the jsonb binding (${JSON.stringify(row.metadata)})`);
  assert(row.metadata?.type === "idea", "…including the extracted fields");
  await sql.close();
}

console.log("\n[3] search_thoughts ranks over real pgvector");
{
  await call("capture_thought", { content: "beta thought about databases" });
  await call("capture_thought", { content: "gamma thought about runtimes" });

  const out = await call("search_thoughts", { query: "alpha", limit: 5, threshold: 0.5 });
  assert(/Found \d+ thought/.test(out), "search returns a result block");
  assert(/alpha thought about migrations/.test(out), "the matching thought is present");
  assert(/100\.0% match/.test(out), "the exact match scores 100%");
  assert(!/beta thought/.test(out), "an orthogonal thought is excluded by the threshold");
}

console.log("\n[4] search + fetch, the ChatGPT-compatible pair");
{
  const found = JSON.parse(await call("search", { query: "beta" }));
  assert(Array.isArray(found.results) && found.results.length > 0, "search returns a results array");
  const id = found.results[0].id;
  assert(/^[0-9a-f-]{36}$/.test(id), `…with a uuid id (${id.slice(0, 8)}…)`);

  const doc = JSON.parse(await call("fetch", { id }));
  assert(doc.id === id, "fetch round-trips the id");
  assert(/beta thought/.test(doc.text), "fetch returns the full text");
  assert(typeof doc.metadata?.created_at === "string", "fetch includes created_at metadata");

  let missingHandled = false;
  try {
    await call("fetch", { id: "11111111-2222-3333-4444-555555555555" });
  } catch (e) {
    missingHandled = /no thought with id/.test((e as Error).message);
  }
  assert(missingHandled, "fetching an absent id is a clean error, not a crash");
}

console.log("\n[5] list_thoughts filters");
{
  const all = await call("list_thoughts", { limit: 10 });
  assert(/3 recent thought/.test(all), `lists all three (${all.split("\n")[0]})`);

  const byType = await call("list_thoughts", { limit: 10, type: "idea" });
  assert(/3 recent thought/.test(byType), "type filter matches the stubbed metadata");

  const byTopic = await call("list_thoughts", { limit: 10, topic: "stubbed" });
  assert(/3 recent thought/.test(byTopic), "topic filter matches inside the array");

  const none = await call("list_thoughts", { limit: 10, topic: "absent-topic" });
  assert(/No thoughts found/.test(none), "an unmatched filter says so");

  const windowed = await call("list_thoughts", { limit: 10, days: 1 });
  assert(/3 recent thought/.test(windowed), "days window includes today");
}

console.log("\n[6] thought_stats aggregates the whole corpus");
{
  const out = await call("thought_stats");
  assert(/Total thoughts: 3/.test(out), `total is exact (${out.split("\n")[0]})`);
  assert(/Types:/.test(out) && /idea: 3/.test(out), "type tally is present and correct");
  assert(/stubbed: 3/.test(out), "topic tally is present");
  assert(!/Note: breakdowns below cover/.test(out), "no truncation note below the cap");
  assert(/Date range:/.test(out), "date range is reported");
}

console.log("\n[7] Dedup through the tool surface");
{
  const before = await call("thought_stats");
  await call("capture_thought", { content: "  ALPHA THOUGHT ABOUT MIGRATIONS  " });
  const after = await call("thought_stats");
  assert(/Total thoughts: 3/.test(after), "a normalised duplicate did not add a row");
  assert(before.split("\n")[0] === after.split("\n")[0], "the total is unchanged");
}

server.stop();
globalThis.fetch = realFetch;

report();
