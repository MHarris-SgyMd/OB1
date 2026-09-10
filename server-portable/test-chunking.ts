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
import { estimateTokens } from "./chunk.ts";
import { SqlStore } from "./store-sql.ts";
import { createEmbedder, resolveEmbedConfig } from "./embed.ts";
import { createAssert, neverAnswers, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";
import { mcpClient } from "./test-support.ts";

const URL_ = requireDatabaseUrl("test-chunking.ts");

const DIM = 64;
const BATCH = 1200;          // the stub's ceiling, mirroring Ollama's 2048
const EMB_MODEL = "stub-embed";

const { assert, report } = createAssert();

await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

/**
 * Sentinels, each owning one axis of the vector. A text containing a sentinel
 * embeds onto its axis, so a query for that sentinel ranks it first — and only if
 * the sentinel was actually inside the text that got embedded.
 */
const SENTINELS = ["zeppelin", "marzipan", "quicksilver", "harpsichord", "gramophone"];
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
      // A request that never returns, for [1b]: the bare word, or a whole
      // content carrying it — never a window, which is under the batch, so a
      // long capture's windows still embed while its whole-content call hangs.
      if (input.includes("tarpit") && (input === "tarpit" || estimateTokens(input) > BATCH)) {
        await neverAnswers();
      }
      // Headers, then a body that never ends — the other way a call can fail to
      // return, and the one a timeout attached to fetch() alone does not name.
      if (input === "slowbody") {
        return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
      }
      // A whole-content call that fails for a reason that says nothing about
      // the next one: the server's embedder must not remember it (nor count it
      // as a probe), and the capture reply must say the head window stands in.
      if (input.includes("flaky") && estimateTokens(input) > BATCH) {
        return Response.json({ error: { message: "stub: briefly unavailable" } }, { status: 503 });
      }
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
    // The chat endpoint — metadata extraction and, under OB1_CHUNK_CONTEXT=on,
    // the blurbs. Two ways not to answer, keyed on the text being processed.
    const asked = JSON.stringify(body.messages ?? "");
    if (asked.includes("slowchat")) {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
    }
    if (asked.includes("blurbtarpit")) {
      await neverAnswers();
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
// One second: [0] captures against a chat body that never ends.
process.env.OB1_LLM_TIMEOUT = "1";
process.env.MCP_ACCESS_KEY = "chunk-key";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;

const { call } = mcpClient(BASE, "chunk-key");

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

console.log("[0] A whole-content call that fails transiently is said in the reply");
{
  // Before [1], because [1]'s 400 latches the server's embedder and no later
  // long capture is asked for its whole content at all. A 503 must not latch,
  // must not count as a probe, and must be said: the head window stands in
  // and there is no claim row on this path to say so later.
  const out = await call("capture_thought", { content: `A flaky start to the notes. ${FILLER.repeat(60)}` });
  assert(/Note: the whole content could not be embedded in one call \(.*503 .*briefly unavailable/.test(out),
    "the capture reply says the head window stands in, with the provider's error");
  assert(/re-capture, or a re-embed pass/.test(out), "…and what would give it the whole-content vector");
  assert(overBatch === 0, `…and the failure was not the refusal [1] counts (${overBatch} probes)`);
  // The metadata call is bounded by the same setting, and a deadline that
  // passes while its body is still arriving is recorded as the timeout it is,
  // not as a body that was not JSON.
  const slow = await call("capture_thought", { content: "A slowchat note about nothing much." });
  assert(/automatic tagging failed \(provider_timeout\)/.test(slow), "a metadata call whose body never ends is recorded as a timeout, and the reply says so");
}

console.log("\n[1] A capture longer than the batch is stored without truncation errors");
{
  await call("capture_thought", { content: LONG });
  await call("capture_thought", { content: LONG_HEAD });
  await call("capture_thought", { content: LONG_MID });
  await call("capture_thought", { content: "A short thought about a quicksilver idea." });
  /**
   * ONE over-batch call is expected, and only one, across all four captures.
   *
   * A chunked capture also asks the provider for a whole-content vector, because
   * on a provider that truncates (Ollama, the default) that vector is measurably
   * better than the head window — see embedCapture. This stub is the other kind:
   * it REFUSES over-batch input with a 400. The first refusal latches, so the
   * attempt is not repeated, and the capture falls back to the head window
   * exactly as it behaved before.
   *
   * Asserting `=== 1` rather than `<= 1` is the point. At `<= 1` this passes
   * whether the latch works or is never reached at all; at `=== 1` it fails if
   * the probe stops happening AND fails if it happens four times.
   */
  assert(overBatch === 1,
    `exactly one over-batch probe, latched after the first refusal (${overBatch} calls exceeded the batch)`);

  const sql = new SQL({ url: URL_, max: 1 });
  const [t] = await sql`SELECT count(*)::int AS c FROM thoughts`;
  assert(t.c === 6, `six thoughts stored, [0]'s two included (${t.c})`);

  const [full] = await sql`SELECT length(content) AS n FROM thoughts WHERE content LIKE 'Opening notes%'`;
  assert(Number(full.n) === LONG.length, `content stored whole, ${full.n} chars, nothing trimmed`);
  await sql.close();
}

console.log("\n[1b] A pass-shaped embedder asks every long capture itself, and no call waits for ever");
{
  // db/reembed.ts builds its embedder with rememberRefusal off: each long row's
  // outcome is recorded on that row, so it has to be that row's own. Against the
  // same refusing stub, three long captures are three probes, not one — and each
  // result carries the provider's answer, which is what the pass writes down.
  const cfg = resolveEmbedConfig({ ...(process.env as Record<string, string>), OB1_LLM_TIMEOUT: "1" });
  const pass = createEmbedder(() => cfg, { rememberRefusal: false });
  const probesBefore = overBatch;
  const results = [];
  for (const text of [LONG, LONG_HEAD, LONG_MID]) results.push(await pass.embedCapture(text));
  assert(overBatch - probesBefore === 3, `three long captures, three over-batch probes — nothing remembered between them (${overBatch - probesBefore})`);
  assert(results.every((r) => r.wholeContentFellBack && r.wholeContentRefused && /400/.test(r.wholeContentError ?? "")),
    "…and each reports its own refusal, with the provider's 400 in the error");
  assert(results.every((r) => r.embedding.every((x, i) => x === r.chunks[0].embedding[i])), "…with the head window's vector standing in");

  // The timeout. A short call that never returns fails with the knob named and
  // no status, in about the configured second rather than never.
  const t0 = Date.now();
  const hung = await pass.getEmbedding("tarpit").then(() => "", (e: Error) => e.message);
  assert(/timed out after 1 s \(OB1_LLM_TIMEOUT\)/.test(hung), `a call that never returns times out, naming the setting (${hung})`);
  assert(Date.now() - t0 < 5_000, `…within the timeout, not the test's patience (${Date.now() - t0} ms)`);
  const stalled = await pass.getEmbedding("slowbody").then(() => "", (e: Error) => e.message);
  assert(/timed out after 1 s \(OB1_LLM_TIMEOUT\)/.test(stalled), `…and so does one whose body never ends after the headers arrived (${stalled})`);
  // The same hang on a whole-content call is a transient fallback: head window,
  // not refused, the timeout in the error — what the pass records as retryable.
  const hungLong = await pass.embedCapture(`tarpit ${FILLER.repeat(60)}`);
  assert(hungLong.wholeContentFellBack && !hungLong.wholeContentRefused && /timed out after 1 s/.test(hungLong.wholeContentError ?? ""),
    "a whole-content call that never returns falls back as transient, with the timeout in the error");
  assert(hungLong.chunks.length >= 3 && hungLong.embedding.every((x, i) => x === hungLong.chunks[0].embedding[i]),
    `…the windows embedded meanwhile (${hungLong.chunks.length}) and the head window stands in`);
  // With context on, a blurb call that never returns is a reason the result
  // carries — so a pass can write "the metadata model timed out" on the row
  // instead of "fix the metadata model".
  const withContext = createEmbedder(() => resolveEmbedConfig({ ...(process.env as Record<string, string>), OB1_LLM_TIMEOUT: "1", OB1_CHUNK_CONTEXT: "on" }), { rememberRefusal: false });
  const bare = await withContext.embedCapture(`blurbtarpit ${FILLER.repeat(60)}`);
  assert(bare.contextFailures === bare.chunks.length && bare.chunks.every((c) => !c.context),
    `every blurb timed out, so every window went in bare (${bare.contextFailures} of ${bare.chunks.length})`);
  assert(bare.contextErrors.length === 1 && /Chat completion request .* timed out after 1 s \(OB1_LLM_TIMEOUT\)/.test(bare.contextErrors[0]),
    `…and the result carries the one distinct reason, naming the setting (${JSON.stringify(bare.contextErrors)})`);
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

console.log("\n[5b] The window grown, the same text makes no windows — and leaves none behind (migration 022)");
{
  // A text over today's window (BATCH - 200) and under the provider's batch:
  // two windows today, one call once OB1_CHUNK_TOKENS covers it — the operator
  // raising the headroom, or a provider with a wider batch. The re-capture
  // then takes the 3-argument form, which until 022 left the two windows of
  // the vector it replaced. The server snapshots its environment on its first
  // request (CI's note on test-chunk-context.ts), so the grown window runs the
  // way [1b] runs a changed setting — the embedding path with the new
  // configuration — and is written through the store index.ts writes through.
  let text = "Notes from the retrospective, in full. ";
  while (estimateTokens(text) < BATCH - 120) text += FILLER;
  text += "The gramophone budget was approved in the final minute.";
  assert(estimateTokens(text) > BATCH - 200 && estimateTokens(text) < BATCH, `≈${estimateTokens(text)} tokens: over the window, under the batch`);
  const sql = new SQL({ url: URL_, max: 1 });
  const windowsOf = async () => Number((await sql`
    SELECT count(*)::int AS c FROM thought_chunks ch JOIN thoughts t ON t.id = ch.thought_id
    WHERE t.content LIKE 'Notes from the retrospective%'`)[0].c);

  await call("capture_thought", { content: text });
  assert((await windowsOf()) === 2, `captured through the server at today's window: two windows (${await windowsOf()})`);
  assert(/gramophone budget/.test(await call("search_thoughts", { query: "gramophone", limit: 5, threshold: 0.1 })), "…and found by its ending, through the second window");

  const grown = createEmbedder(() => resolveEmbedConfig({ ...(process.env as Record<string, string>), OB1_CHUNK_TOKENS: String(BATCH) }), { rememberRefusal: false });
  const embedded = await grown.embedCapture(text);
  assert(embedded.chunks.length === 0, `with the window at the batch the same text makes no windows (${embedded.chunks.length})`);
  const store = new SqlStore(URL_, { max: 1 });
  await store.captureThought({ content: text, payload: { metadata: {} }, embedding: embedded.embedding, chunks: embedded.chunks, embeddingModel: embedded.model });
  await store.close();
  assert((await windowsOf()) === 0, `the re-capture took the 3-argument form and left no stale windows (${await windowsOf()})`);
  assert(/gramophone budget/.test(await call("search_thoughts", { query: "gramophone", limit: 5, threshold: 0.1 })), "…and the thought is still found by its ending — by its whole-content vector now");
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

// Forced: [1b] left two requests the stub will never answer.
server.stop(); provider.stop(true);
console.log(`\n  ${embedCalls} embedding calls`);
report();
