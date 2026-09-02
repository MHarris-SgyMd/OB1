#!/usr/bin/env bun
/**
 * test-local-provider.ts — the fully local path: no OpenRouter, no API key.
 *
 * Proves the provider is a configuration choice rather than a hard dependency:
 * the server sends both calls to OB1_LLM_BASE_URL, uses OB1_EMBEDDING_MODEL and
 * OB1_METADATA_MODEL, and sends NO Authorization header when no key is set.
 *
 * The stub speaks the OpenAI-compatible shapes Ollama exposes at /v1. It asserts
 * on what the server SENDS as much as what it does with the reply, because that is
 * the part a real Ollama would judge.
 *
 * What this does not prove: that Ollama itself honours `response_format:
 * {type:"json_object"}` on your version. `preflight.ts --deep` checks that against
 * the real endpoint — run it after pointing at a live Ollama.
 *
 *   ../db/with-postgres.sh bun test-local-provider.ts
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-local-provider.ts");
  process.exit(2);
}

const DIM = 768;                        // nomic-embed-text
const EMB_MODEL = "nomic-embed-text";
const META_MODEL = "llama3.2";

function subst(sql: string): string {
  return sql.replace(/\{\{EMBEDDING_DIM\}\}/g, String(DIM)).replace(/\{\{EMBEDDING_MODEL\}\}/g, EMB_MODEL);
}

let passed = 0, failed = 0;
const assert = (c: unknown, l: string) =>
  c ? (console.log(`  ✓  ${l}`), passed++) : (console.error(`  ✗  ${l}`), failed++);

// Schema at 768.
{
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`DROP TABLE IF EXISTS thoughts CASCADE`;
  await admin`DROP TABLE IF EXISTS schema_migrations CASCADE`;
  await admin`DROP TABLE IF EXISTS ob1_config CASCADE`;
  for (const f of readdirSync(join(HERE, "..", "db", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await admin.unsafe(subst(readFileSync(join(HERE, "..", "db", "migrations", f), "utf8")));
  }
  await admin.close();
}

// ── A stand-in for Ollama's /v1 surface ─────────────────────────────────────
type Seen = { path: string; auth: string | null; model: string; jsonMode: boolean };
const seen: Seen[] = [];

/**
 * Width the stub replies with. Mutable so the mismatch case can be exercised
 * without changing OB1_LLM_BASE_URL — env() caches on first use (that is what
 * makes the file Workers-compatible), so a mid-run URL change does nothing.
 */
let replyDim = DIM;

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as { model: string; input?: string; response_format?: { type: string } };
    seen.push({
      path: url.pathname,
      auth: req.headers.get("authorization"),
      model: body.model,
      jsonMode: body.response_format?.type === "json_object",
    });

    if (url.pathname.endsWith("/embeddings")) {
      const v = new Array(replyDim).fill(0);
      v[String(body.input ?? "").length % replyDim] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["local"], type: "idea", people: [] }) } }],
    });
  },
});
const PROVIDER = `http://127.0.0.1:${provider.port}/v1`;

// ── Boot the server pointed at it, with NO credential anywhere ──────────────
process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = PROVIDER;
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_METADATA_MODEL = META_MODEL;
process.env.MCP_ACCESS_KEY = "local-key";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OB1_LLM_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": "local-key" };

let id = 1;
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(BASE, { method: "POST", headers: H,
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const b = JSON.parse(line);
  const text = (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (b.error) throw new Error(JSON.stringify(b.error));
  if (b.result?.isError) throw new Error(text);
  return text;
}

console.log(`  provider: ${PROVIDER}  (no OPENROUTER_API_KEY, no OB1_LLM_API_KEY)\n`);

console.log("[1] No OpenRouter credential is present");
{
  assert(process.env.OPENROUTER_API_KEY === undefined, "OPENROUTER_API_KEY is unset");
  assert(process.env.OB1_LLM_API_KEY === undefined, "OB1_LLM_API_KEY is unset");
}

console.log("\n[2] A capture reaches the configured provider, not openrouter.ai");
{
  const out = await call("capture_thought", { content: "a locally embedded thought" });
  assert(/Captured as/.test(out), "capture succeeds against the local provider");
  assert(seen.length === 2, `two provider calls were made (${seen.length})`);

  const emb = seen.find((s) => s.path.endsWith("/embeddings"));
  const chat = seen.find((s) => s.path.endsWith("/chat/completions"));
  assert(emb !== undefined, "an /embeddings call was made");
  assert(chat !== undefined, "a /chat/completions call was made");
  assert(emb!.model === EMB_MODEL, `embeddings used OB1_EMBEDDING_MODEL (${emb!.model})`);
  assert(chat!.model === META_MODEL, `metadata used OB1_METADATA_MODEL (${chat!.model})`);
  assert(chat!.jsonMode, "metadata extraction still requests JSON mode");
}

console.log("\n[3] No Authorization header is sent to a keyless provider");
{
  // Sending `Bearer undefined` would be harmless to Ollama but misleading in
  // logs, and would leak the fact that the server thinks it has a credential.
  for (const s of seen) assert(s.auth === null, `${s.path} carried no Authorization header`);
}

console.log("\n[4] The 768-dimension vector really landed in Postgres");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT metadata, embedding IS NOT NULL AS has,
    vector_dims(embedding) AS dims FROM thoughts`;
  assert(row.has === true, "the embedding was stored");
  assert(Number(row.dims) === DIM, `stored vector is ${row.dims} dimensions`);
  assert(row.metadata?.topics?.[0] === "local", `metadata came from the local model (${JSON.stringify(row.metadata?.topics)})`);
  const [cfg] = await sql`SELECT value FROM ob1_config WHERE key = 'embedding_dim'`;
  assert(cfg.value === String(DIM), `ob1_config records ${cfg.value}`);
  await sql.close();
}

console.log("\n[5] Search works end to end with no external service");
{
  await call("capture_thought", { content: "another locally embedded thought entirely" });
  const out = await call("search_thoughts", { query: "a locally embedded thought", threshold: 0.1, limit: 5 });
  assert(/Found \d+ thought/.test(out), "search returns results");
  assert(/locally embedded/.test(out), "…including a captured thought");
  const stats = await call("thought_stats");
  assert(/Total thoughts: 2/.test(stats), "stats agree");
  assert(/local: 2/.test(stats), "the local model's topics are tallied");
}

console.log("\n[6] A width mismatch from the provider is refused, not stored");
{
  // Swapping the embedding model for a same-name-different-width one is the
  // realistic version of this: `ollama pull` a different model, or a provider
  // changing a default. The column cannot hold it and the row must not be written.
  replyDim = 1536;

  let msg = "";
  try { await call("capture_thought", { content: "wrong width" }); } catch (e) { msg = (e as Error).message; }
  assert(/width mismatch/i.test(msg), `capture refuses a 1536-wide vector for a 768 column (${msg.slice(0, 60)})`);
  assert(/re-embedding/.test(msg), "…and says what changing the model would cost");

  const sql = new SQL({ url: URL_, max: 1 });
  assert((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c === 2, "no row was written");
  await sql.close();
  replyDim = DIM;
}

server.stop();
provider.stop();

console.log(`\n${"─".repeat(52)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);
console.log(failed > 0 ? "FAIL\n" : "PASS\n");
process.exit(failed > 0 ? 1 : 0);
