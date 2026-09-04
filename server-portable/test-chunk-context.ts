#!/usr/bin/env bun
/**
 * test-chunk-context.ts — OB1_CHUNK_CONTEXT actually changes what gets embedded.
 *
 * Its own file rather than a section of test-chunking.ts because the server
 * snapshots its environment at the first request, so the flag cannot be flipped
 * inside a process — a second setting needs a second process. The same reason
 * `evals/eval-chunking-e2e.ts` spawns a child.
 *
 * ── The assertion that matters ───────────────────────────────────────────────
 *
 * Checking that `thought_chunks.context` holds a string proves the column is
 * wired up and nothing about the feature: the whole point is that the blurb goes
 * into the VECTOR. So the stub's blurb carries a sentinel that appears nowhere in
 * the document, and the test searches for it. A hit is only possible if the
 * blurb was prepended before the window was embedded. Writing the column while
 * embedding the bare window — the plausible bug, and the one a column check
 * cannot see — fails here.
 *
 * The stub distinguishes a contextualization request from a metadata extraction
 * by looking for the prompt's own `<chunk>` marker, so the two paths cannot be
 * confused for each other the way a single canned response would allow.
 *
 *   ../db/with-postgres.sh bun test-chunk-context.ts
 */

import { SQL } from "bun";
import { createAssert, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";
import { mcpClient } from "./test-support.ts";
import { composeChunkForEmbedding } from "../db/config.mjs";

const URL_ = requireDatabaseUrl("test-chunk-context.ts");

const DIM = 64;
const BATCH = 1200;
const EMB_MODEL = "stub-embed";

const { assert, report } = createAssert();

await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

/**
 * `nightingale` is the sentinel the STUB puts in every blurb. It appears in no
 * document, so any document that ranks for it was embedded with its blurb.
 */
const CONTEXT_SENTINEL = "nightingale";
const SENTINELS = [CONTEXT_SENTINEL, "zeppelin", "marzipan"];
function axisFor(text: string): number {
  const i = SENTINELS.findIndex((s) => text.toLowerCase().includes(s));
  return i >= 0 ? i : SENTINELS.length;
}

/** Set for the run that exercises a provider which cannot produce a blurb. */
let failContext = false;
let contextCalls = 0;
const embedded: string[] = [];

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname.endsWith("/embeddings")) {
      const input = String(body.input ?? "");
      embedded.push(input);
      // The whole-content probe. This stub is the refusing kind, as in
      // test-chunking.ts, so the head-window fallback is exercised here too.
      if (input.length > BATCH * 4) {
        return Response.json({ error: { message: "input exceeds the batch" } }, { status: 400 });
      }
      const v = new Array(DIM).fill(0);
      v[axisFor(input)] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    const prompt = String(
      ((body.messages as { content?: string }[] | undefined) ?? [])[0]?.content ?? ""
    );
    if (prompt.includes("<chunk>")) {
      contextCalls++;
      if (failContext) return Response.json({ error: { message: "no" } }, { status: 503 });
      return Response.json({
        choices: [{ message: { content: `Notes about the ${CONTEXT_SENTINEL} programme.` } }],
      });
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
process.env.OB1_CHUNK_TOKENS = String(BATCH - 200);
process.env.OB1_METADATA_MODEL = "stub-meta";
process.env.OB1_CHUNK_CONTEXT = "on";
process.env.MCP_ACCESS_KEY = "ctx-key";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const { call } = mcpClient(BASE, "ctx-key");
const sql = new SQL({ url: URL_, max: 2 });

/** Long enough to chunk, and containing none of the sentinels. */
const FILLER =
  "We went round the same arguments as last quarter without much new evidence. " +
  "There was a digression about whether the vendor evaluation was still valid, and " +
  "whether anyone had re-run the load tests since the schema change landed. Nobody had. ";
const LONG = `Opening notes for the review. ${FILLER.repeat(60)} Closing remarks, as ever.`;
const SHORT = "A short thought that is nowhere near the chunking threshold.";

console.log("\n[1] With the flag on, a blurb is generated per window and stored");
{
  await call("capture_thought", { content: LONG });
  const rows = await sql`SELECT chunk_index, context FROM thought_chunks ORDER BY chunk_index`;
  assert(rows.length > 1, `the capture chunked (${rows.length} windows)`);
  assert(contextCalls === rows.length,
         `one contextualization call per window (${contextCalls} calls, ${rows.length} windows)`);
  assert(rows.every((r: { context: string | null }) => r.context?.includes(CONTEXT_SENTINEL)),
         "every window stored the blurb it was given");
}

/**
 * Snapshotted before anything searches. A query embedding also contains the
 * sentinel — it IS the sentinel — and folding it in with the document calls
 * would make the composition assertion below fail for a reason that has nothing
 * to do with composition.
 */
const capturedEmbeds = [...embedded];

console.log("\n[2] The blurb reaches the VECTOR, not just the column");
{
  /**
   * The sentinel is in no document, so a search for it can only match through a
   * chunk whose embedded text included the blurb. This is the assertion that
   * separates a working feature from one that writes the column and embeds the
   * bare window anyway.
   */
  const res = await call("search_thoughts", { query: CONTEXT_SENTINEL, threshold: 0.5 });
  const text = JSON.stringify(res);
  assert(text.includes("Opening notes for the review"),
         "a query for a word that appears only in the blurb finds the thought");

  const withCtx = capturedEmbeds.filter((e) => e.includes(CONTEXT_SENTINEL));
  assert(withCtx.length > 0, `the blurb was sent to the embedding provider (${withCtx.length} calls)`);
  assert(
    withCtx.every((e) => e.startsWith(`Notes about the ${CONTEXT_SENTINEL} programme.\n\n`)),
    "…composed as composeChunkForEmbedding defines it: context, blank line, window"
  );
  assert(
    composeChunkForEmbedding("ctx", "chunk") === "ctx\n\nchunk" &&
      composeChunkForEmbedding("", "chunk") === "chunk" &&
      composeChunkForEmbedding(null, "chunk") === "chunk",
    "…and that rule is the one shared with the benchmark and any backfill"
  );
}

console.log("\n[3] A short capture is untouched by the flag");
{
  contextCalls = 0;
  await call("capture_thought", { content: SHORT });
  assert(contextCalls === 0, `no contextualization call for content that does not chunk (${contextCalls})`);
  const [n] = await sql`
    SELECT count(*)::int AS c FROM thought_chunks c
    JOIN thoughts t ON t.id = c.thought_id WHERE t.content = ${SHORT}`;
  assert(n.c === 0, "and no chunk rows either");
}

console.log("\n[4] A provider that cannot produce a blurb degrades, and says so");
{
  failContext = true;
  contextCalls = 0;
  const res = await call("capture_thought", {
    content: `${LONG} An entirely different closing sentence, so this is a separate thought.`,
  });
  const text = JSON.stringify(res);

  assert(!/"isError":true/.test(text), "the capture still succeeds — a flaky blurb must not lose a thought");
  assert(/embedded without their situating context/.test(text),
         "…and the response says how many windows went in bare");

  const [row] = await sql`SELECT id FROM thoughts WHERE content LIKE ${"%entirely different closing%"}`;
  const rows = await sql`
    SELECT context FROM thought_chunks WHERE thought_id = ${row.id} ORDER BY chunk_index`;
  assert(rows.length > 1, `the capture still chunked (${rows.length} windows)`);
  assert(rows.every((r: { context: string | null }) => r.context === null),
         "every window is recorded as NULL rather than as an empty string");

  /**
   * The state this leaves behind is exactly the one preflight reports: some
   * chunks with context, some without. Asserting it here means the two halves
   * of the design — degrade rather than fail, and make the degradation
   * visible — are checked against each other rather than separately.
   */
  const [split] = await sql`
    SELECT count(*) FILTER (WHERE context IS NOT NULL)::int AS with_ctx,
           count(*) FILTER (WHERE context IS NULL)::int AS bare
    FROM thought_chunks`;
  assert(split.with_ctx > 0 && split.bare > 0,
         `the corpus is now mixed, which is what preflight reports (${split.with_ctx} with, ${split.bare} without)`);
}

await sql.close();
server.stop(true);
provider.stop(true);

report();
