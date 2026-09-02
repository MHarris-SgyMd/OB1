#!/usr/bin/env bun
/**
 * test-chunking.ts — a long capture stays findable by its ending.
 *
 * The assertion in [3] is the one that failed before migration 007 existed. A
 * capture longer than the provider's per-request batch was embedded only in part,
 * so `search_thoughts` could not find it by anything said in its second half. The
 * text was stored intact and `fetch` returned it whole — nothing was lost except
 * the ability to find it, which for a memory system is most of the point.
 *
 * The provider stub models the real failure rather than assuming it: it refuses
 * any input over BATCH tokens, the way Ollama silently truncates at 2048. If the
 * server ever stops chunking, [1] fails with a truncated-input error instead of
 * quietly regressing.
 *
 * Embeddings are deterministic and keyed on which sentinel phrase the text
 * contains, so ranking is predictable without a model.
 *
 *   ../db/with-postgres.sh bun test-chunking.ts
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "./chunk.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-chunking.ts");
  process.exit(2);
}

const DIM = 64;
const BATCH = 1200;          // the stub's ceiling, mirroring Ollama's 2048
const EMB_MODEL = "stub-embed";

let passed = 0, failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else { console.error(`  ✗  ${label}`); failed++; }
}

{
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`DROP TABLE IF EXISTS thought_chunks CASCADE`;
  await admin`DROP TABLE IF EXISTS thoughts CASCADE`;
  await admin`DROP TABLE IF EXISTS schema_migrations CASCADE`;
  await admin`DROP TABLE IF EXISTS ob1_config CASCADE`;
  for (const f of readdirSync(join(HERE, "..", "db", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await admin.unsafe(
      readFileSync(join(HERE, "..", "db", "migrations", f), "utf8")
        .replace(/\{\{EMBEDDING_DIM\}\}/g, String(DIM))
        .replace(/\{\{EMBEDDING_MODEL\}\}/g, EMB_MODEL)
    );
  }
  await admin.close();
}

/**
 * Sentinels, each owning one axis of the vector. A text containing a sentinel
 * embeds onto its axis, so a query for that sentinel ranks it first — and only if
 * the sentinel was actually inside the text that got embedded.
 */
const SENTINELS = ["zeppelin", "marzipan", "quicksilver", "harpsichord"];
function axisFor(text: string): number {
  const i = SENTINELS.findIndex((s) => text.toLowerCase().includes(s));
  return i >= 0 ? i : SENTINELS.length;
}

let overBatch = 0;
let embedCalls = 0;
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname.endsWith("/embeddings")) {
      embedCalls++;
      const input = String(body.input ?? "");
      // The whole point: a real provider would silently truncate here. Failing
      // loudly instead turns a silent regression into a red test.
      if (estimateTokens(input) > BATCH) {
        overBatch++;
        return Response.json({ error: { message: `input of ~${estimateTokens(input)} tokens exceeds the ${BATCH}-token batch` } }, { status: 400 });
      }
      const v = new Array(DIM).fill(0);
      v[axisFor(input)] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["long"], type: "reference", people: [] }) } }],
    });
  },
});

process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = `http://localhost:${provider.port}/v1`;
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_CHUNK_TOKENS = String(BATCH - 200);   // headroom, as in production
process.env.OB1_METADATA_MODEL = "stub-meta";
process.env.MCP_ACCESS_KEY = "chunk-key";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;

let rpcId = 1;
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": "chunk-key" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const b = JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  const text = (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (b.error) throw new Error(JSON.stringify(b.error));
  if (b.result?.isError) throw new Error(text);
  return text;
}

/** Filler carrying no sentinel, so only the planted phrases can be matched. */
const FILLER = "We went round the same arguments as last quarter without much new evidence. " +
  "There was a digression about whether the vendor evaluation was still valid, and " +
  "whether anyone had re-run the load tests since the schema change landed. Nobody had. ";

/**
 * Several times the batch, with the payload in the FINAL sentence — the case that
 * was unfindable before chunking.
 */
const LONG = `Opening notes for the review. ${FILLER.repeat(60)} The decision, finally: we are going with the zeppelin option.`;
/** Same length, payload at the START, proving the head is still reachable. */
const LONG_HEAD = `The marzipan proposal was accepted at the top of the meeting. ${FILLER.repeat(60)} Everything after that was routine.`;
/**
 * Payload buried in the MIDDLE, which neither a head-truncating provider nor a
 * naive last-chunk-only scheme would find. This is the assertion that a boundary
 * cannot be gamed.
 */
const LONG_MID = `Routine preamble for the third session. ${FILLER.repeat(30)} ` +
  `Buried in the middle here: the harpsichord budget was signed off. ${FILLER.repeat(30)} Closing remarks.`;

console.log(`\n  long capture ≈ ${estimateTokens(LONG)} tokens, provider batch ${BATCH}\n`);

console.log("[1] A capture longer than the batch is stored without truncation errors");
{
  await call("capture_thought", { content: LONG });
  await call("capture_thought", { content: LONG_HEAD });
  await call("capture_thought", { content: LONG_MID });
  await call("capture_thought", { content: "A short thought about a quicksilver idea." });
  assert(overBatch === 0, `no provider call exceeded the batch (${overBatch} did)`);

  const sql = new SQL({ url: URL_, max: 1 });
  const [t] = await sql`SELECT count(*)::int AS c FROM thoughts`;
  assert(t.c === 4, `four thoughts stored (${t.c})`);

  const [full] = await sql`SELECT length(content) AS n FROM thoughts WHERE content LIKE 'Opening notes%'`;
  assert(Number(full.n) === LONG.length, `content stored whole, ${full.n} chars, nothing trimmed`);
  await sql.close();
}

console.log("\n[2] Chunks are written only for content that needs them");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const rows = await sql`
    SELECT t.content LIKE 'Opening notes%' AS is_long, count(c.*)::int AS chunks
    FROM thoughts t LEFT JOIN thought_chunks c ON c.thought_id = t.id
    GROUP BY 1, t.id ORDER BY 1 DESC`;
  const longRow = rows.find((r: { is_long: boolean }) => r.is_long);
  assert(Number(longRow?.chunks) >= 3, `the long thought is split into ${longRow?.chunks} chunks`);

  const idx = await sql`
    SELECT c.chunk_index FROM thought_chunks c
    JOIN thoughts t ON t.id = c.thought_id
    WHERE t.content LIKE 'Opening notes%' ORDER BY c.chunk_index`;
  type Idx = { chunk_index: number };
  assert(idx.every((r: Idx, i: number) => Number(r.chunk_index) === i),
         `chunk indices are dense and ordered (${idx.map((r: Idx) => r.chunk_index).join(",")})`);

  const [short] = await sql`
    SELECT count(c.*)::int AS chunks FROM thoughts t
    LEFT JOIN thought_chunks c ON c.thought_id = t.id
    WHERE t.content LIKE 'A short thought%'`;
  assert(Number(short.chunks) === 0, "the short thought has no chunk rows — the common case pays nothing");
  await sql.close();
}

console.log("\n[3] The long capture is findable by its FINAL sentence");
{
  // This is the assertion that failed before chunking existed.
  const out = await call("search_thoughts", { query: "zeppelin", limit: 5, threshold: 0.5 });
  assert(/Found \d+ thought/.test(out), "search returns results");
  assert(/Opening notes for the review/.test(out), "the long note is retrieved by a phrase in its last sentence");

  const head = await call("search_thoughts", { query: "marzipan", limit: 5, threshold: 0.5 });
  assert(/The marzipan proposal/.test(head), "…and one with the phrase at the start is still retrieved too");

  const mid = await call("search_thoughts", { query: "harpsichord", limit: 5, threshold: 0.5 });
  assert(/Routine preamble for the third session/.test(mid),
         "…and one with the phrase buried in the middle, which no boundary trick would find");
}

console.log("\n[4] A thought appears once, however many chunks matched");
{
  const out = await call("search_thoughts", { query: "zeppelin", limit: 10, threshold: 0.1 });
  const hits = (out.match(/Opening notes for the review/g) ?? []).length;
  assert(hits === 1, `deduplicated to a single row (appeared ${hits} times)`);
}

console.log("\n[5] Re-capturing replaces chunks rather than accumulating them");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const before = Number((await sql`SELECT count(*)::int AS c FROM thought_chunks`)[0].c);
  await call("capture_thought", { content: LONG });          // same content, dedup path
  const after = Number((await sql`SELECT count(*)::int AS c FROM thought_chunks`)[0].c);
  assert(before === after, `chunk count unchanged after re-capture (${before} → ${after})`);
  await sql.close();
}

console.log("\n[6] Deleting a thought removes its chunks");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT id FROM thoughts WHERE content LIKE 'Opening notes%'`;
  await sql`DELETE FROM thoughts WHERE id = ${row.id}`;
  const [orphans] = await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${row.id}`;
  assert(orphans.c === 0, "no orphaned chunk vectors left answering searches");
  await sql.close();
}

server.stop(); provider.stop();
console.log(`\n${"─".repeat(52)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed  (${embedCalls} embedding calls)`);
console.log(failed > 0 ? "FAIL\n" : "PASS\n");
process.exit(failed > 0 ? 1 : 0);
