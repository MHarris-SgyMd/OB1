#!/usr/bin/env bun
/**
 * test-embedding-dimensions.ts — OB1_EMBEDDING_DIMENSIONS, the opt-in path.
 *
 * Its own file because the server snapshots the environment once at boot, so
 * Workers bindings behave — which means the flag cannot be flipped mid-process.
 * test-local-provider.ts covers the default (the parameter is not sent).
 *
 * What the flag is for: a model whose native width exceeds pgvector's
 * 2000-dimension HNSW ceiling is unusable, because the column works but no index
 * can be built. qwen3-embedding:4b emits 2560 and scored the best retrieval
 * result measured on real data once truncated to 1024 — better than every model
 * that fits natively (evals/README.md). Without this, that model is unreachable.
 *
 * Why it is off by default, and why the failure case below matters: providers
 * apply `dimensions` to any model, including ones never trained for Matryoshka
 * truncation. Ollama returns 256 numbers for all-minilm as happily as for
 * embeddinggemma, with no error either way. Measured on 97 real documents,
 * truncating a non-MRL model cost roughly twice the MRR of truncating an MRL one.
 * A provider that instead IGNORES the parameter yields a wrong-width vector, and
 * that has to fail loudly rather than reach Postgres as an opaque cast error.
 *
 *   ../db/with-postgres.sh bun test-embedding-dimensions.ts
 */

import { SQL } from "bun";
import { resetSchema } from "../db/test-support.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-embedding-dimensions.ts");
  process.exit(2);
}

const DIM = 1024;                        // the indexable width we ask for
const NATIVE = 2560;                     // what the model emits unasked
const EMB_MODEL = "qwen3-embedding:4b";
const META_MODEL = "qwen2.5:7b";

let passed = 0, failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else { console.error(`  ✗  ${label}`); failed++; }
}

// Fresh schema at the truncated width.
await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

/** A provider that honours `dimensions`, until told to ignore it. */
let ignoreDimensions = false;
let lastBody: Record<string, unknown> = {};
let lastInput = "";
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname.endsWith("/embeddings")) {
      lastBody = body;
      lastInput = String(body.input ?? "");
      const asked = Number(body.dimensions);
      const width = !ignoreDimensions && asked ? asked : NATIVE;
      // Keyed off the text with any query instruction stripped, so a prompted
      // query and its document still land on the same axis. Without this the stub
      // would report a miss for what is actually correct behaviour.
      const bare = String(body.input ?? "").replace(/^Instruct:[^\n]*\nQuery: /, "");
      const v = new Array(width).fill(0);
      v[bare.length % width] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["mrl"], type: "idea", people: [] }) } }],
    });
  },
});

process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = `http://localhost:${provider.port}/v1`;
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_EMBEDDING_DIMENSIONS = "on";
process.env.OB1_METADATA_MODEL = META_MODEL;
process.env.MCP_ACCESS_KEY = "dim-key";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;

let id = 1;
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": "dim-key" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const b = JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  const text = (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (b.error) throw new Error(JSON.stringify(b.error));
  if (b.result?.isError) throw new Error(text);
  return text;
}

console.log(`\n  ${EMB_MODEL}: ${NATIVE} native, asking for ${DIM}\n`);

console.log("[1] The server asks the provider to truncate");
{
  await call("capture_thought", { content: "a thought needing a narrow vector" });
  assert(lastBody.dimensions === DIM, `the request carries dimensions=${DIM} (${lastBody.dimensions})`);
  assert(lastBody.model === EMB_MODEL, "…for the configured model");
}

console.log("\n[2] The narrowed vector is stored, and is indexable");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT vector_dims(embedding) AS dims FROM thoughts`;
  assert(Number(row?.dims) === DIM, `stored at ${DIM} dimensions, not ${NATIVE} (${row?.dims})`);

  // The point of the whole feature: 2560 could not be HNSW-indexed, 1024 can.
  const [idx] = await sql`SELECT count(*)::int AS c FROM pg_indexes
                          WHERE tablename = 'thoughts' AND indexdef ILIKE '%hnsw%'`;
  assert(idx.c > 0, "an HNSW index exists on the column, which 2560 dimensions would forbid");
  await sql.close();
}

console.log("\n[3] Search still works end to end at the truncated width");
{
  const out = await call("search_thoughts", { query: "a thought needing a narrow vector", limit: 3, threshold: 0.1 });
  assert(/Found \d+ thought/.test(out), "search returns results over the narrowed vectors");
}

console.log("\n[4] Queries carry the model's instruction, documents do not");
{
  // qwen3-embedding is trained for asymmetric prompting: on 97 real issues it
  // scores 0.933 MRR instructed and 0.860 bare — worse, unprompted, than a model a
  // quarter its size. So this is correctness, not tuning.
  await call("capture_thought", { content: "a document that must be embedded bare" });
  const captured = lastInput;
  assert(!/^Instruct:/.test(captured), `the document is sent bare (${captured.slice(0, 40)}…)`);

  await call("search_thoughts", { query: "a question", limit: 1, threshold: 0.1 });
  assert(/^Instruct: /.test(lastInput) && /\nQuery: a question$/.test(lastInput),
         `the query is wrapped (${JSON.stringify(lastInput.slice(0, 56))})`);
}

console.log("\n[5] A provider that ignores `dimensions` fails loudly");
{
  ignoreDimensions = true;
  let msg = "";
  try { await call("capture_thought", { content: "provider ignored the request" }); }
  catch (e) { msg = (e as Error).message; }

  assert(/width mismatch/i.test(msg), "the wrong-width vector is refused");
  assert(/ignored it/.test(msg), `…and names the provider as the cause (…${msg.slice(-64)})`);

  const sql = new SQL({ url: URL_, max: 1 });
  assert((await sql`SELECT count(*)::int AS c FROM thoughts
                    WHERE content = 'provider ignored the request'`)[0].c === 0,
         "no row was written");
  await sql.close();
  ignoreDimensions = false;
}

server.stop(); provider.stop();
console.log(`\n${"─".repeat(52)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);
console.log(failed > 0 ? "FAIL\n" : "PASS\n");
process.exit(failed > 0 ? 1 : 0);
