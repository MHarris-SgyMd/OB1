#!/usr/bin/env bun
/**
 * test-store-postgrest.ts — the PostgREST store against a real database.
 *
 * This path had no test at all. Everything else in the suite exercises
 * OB1_STORE=sql, so `PostgrestStore`'s RPC argument shapes were only ever verified
 * by running against a live PostgREST, which nothing in CI does. That went
 * unnoticed until chunking added a fourth argument to `upsert_thought` and there
 * was no way to check it arrived.
 *
 * The fixture is `compat/supabase-sql`, this fork's supabase-js-shaped client over
 * Bun.sql. It is not a mock: it builds real SQL and runs it against real Postgres,
 * so an argument name the function does not have, or a value the wrong shape,
 * fails here exactly as it would against PostgREST.
 *
 * What this does NOT prove: PostgREST's own HTTP layer, its type coercion, or its
 * error codes. Those differ from Bun's, which is why `toPostgrestError` exists.
 * This covers the argument shapes and the round trip, which is where the untested
 * risk actually was.
 *
 *   ../db/with-postgres.sh bun test-store-postgrest.ts
 */

import { SQL } from "bun";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../compat/supabase-sql/index.ts";
import { PostgrestStore } from "./store-postgrest.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-store-postgrest.ts");
  process.exit(2);
}

const DIM = 8;
const { assert, report } = createAssert();

await resetSchema(URL_, { dim: DIM, model: "stub" });

/** One-hot vectors, so similarity is exact and ranking is predictable. */
const vec = (axis: number): number[] => Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0));

// The seam: a supabase-js-shaped client that is really SQL.
const client = createClient(URL_);
const store = new PostgrestStore("unused", "unused", client as never);

console.log("\n  PostgrestStore over compat/supabase-sql, against real Postgres\n");

console.log("[1] captureThought without chunks — the 3-arg RPC, unchanged");
{
  const { id } = await store.captureThought({
    content: "a short thought that needs no chunking",
    payload: { metadata: { type: "idea", topics: ["short"] } },
    embedding: vec(0),
  });
  assert(/^[0-9a-f-]{36}$/.test(id), `returns a uuid (${id.slice(0, 8)}…)`);

  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT metadata, vector_dims(embedding) AS d FROM thoughts WHERE id = ${id}`;
  assert(Number(row.d) === DIM, "the embedding was stored, not dropped");
  assert(row.metadata?.type === "idea", `metadata survived the RPC (${JSON.stringify(row.metadata)})`);
  const [c] = await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${id}`;
  assert(c.c === 0, "no chunk rows for short content");
  await sql.close();
}

console.log("\n[2] captureThought WITH chunks — the 4-arg RPC arrives intact");
{
  // This is the argument shape that shipped unverified: p_chunks as a jsonb array
  // whose embeddings are pgvector text literals.
  const { id } = await store.captureThought({
    content: "a long thought split into windows",
    payload: { metadata: { type: "reference" } },
    embedding: vec(1),
    chunks: [
      { content: "window one, the opening", embedding: vec(1) },
      { content: "window two, the middle", embedding: vec(2) },
      { content: "window three, the conclusion", embedding: vec(3) },
    ],
  });

  const sql = new SQL({ url: URL_, max: 1 });
  const rows = await sql`
    SELECT chunk_index, content, vector_dims(embedding) AS d
    FROM thought_chunks WHERE thought_id = ${id} ORDER BY chunk_index`;
  assert(rows.length === 3, `three chunk rows written (${rows.length})`);
  type ChunkRow = { chunk_index: number; content: string; d: number };
  assert(rows.every((r: ChunkRow, i: number) => Number(r.chunk_index) === i), "indices are dense and ordered");
  assert(rows.every((r: ChunkRow) => Number(r.d) === DIM), "every chunk embedding is a real vector, not a string");
  assert(rows[2].content === "window three, the conclusion", "chunk content round-trips");
  await sql.close();
}

console.log("\n[3] matchThoughts finds a thought by a CHUNK, through the RPC");
{
  // vec(3) matches only the third window. Before chunking this thought would have
  // been unreachable by anything in its conclusion.
  const hits = await store.matchThoughts({ embedding: vec(3), threshold: 0.5, limit: 5, filter: {} });
  assert(hits.length === 1, `one thought returned (${hits.length})`);
  assert(hits[0]?.content === "a long thought split into windows",
         "…retrieved by its final window, not its opening");
  assert(Math.abs((hits[0]?.similarity ?? 0) - 1) < 1e-6,
         `scored by the matching chunk (${hits[0]?.similarity?.toFixed(4)})`);
}

console.log("\n[4] A thought is deduplicated across its own chunks");
{
  await store.captureThought({
    content: "a thought whose windows all look alike",
    payload: { metadata: {} },
    embedding: vec(4),
    chunks: [
      { content: "alike one", embedding: vec(4) },
      { content: "alike two", embedding: vec(4) },
      { content: "alike three", embedding: vec(4) },
    ],
  });
  const hits = await store.matchThoughts({ embedding: vec(4), threshold: 0.5, limit: 10, filter: {} });
  const mine = hits.filter((h) => h.content === "a thought whose windows all look alike");
  assert(mine.length === 1, `three matching chunks yield one row (${mine.length})`);
}

console.log("\n[5] The metadata filter still applies to chunk-sourced hits");
{
  const match = await store.matchThoughts({
    embedding: vec(3), threshold: 0.5, limit: 5, filter: { type: "reference" },
  });
  assert(match.length === 1, "a matching filter keeps the chunk-sourced hit");

  const miss = await store.matchThoughts({
    embedding: vec(3), threshold: 0.5, limit: 5, filter: { type: "person_note" },
  });
  assert(miss.length === 0, "a non-matching filter excludes it, rather than leaking it through the chunk path");
}

console.log("\n[6] Re-capture replaces chunks instead of accumulating them");
{
  await store.captureThought({
    content: "a long thought split into windows",     // same content → dedup path
    payload: { metadata: { type: "reference" } },
    embedding: vec(1),
    chunks: [{ content: "now a single window", embedding: vec(1) }],
  });
  const sql = new SQL({ url: URL_, max: 1 });
  const [c] = await sql`
    SELECT count(*)::int AS c FROM thought_chunks ch
    JOIN thoughts t ON t.id = ch.thought_id
    WHERE t.content = 'a long thought split into windows'`;
  assert(c.c === 1, `three windows replaced by one, not appended (${c.c})`);
  await sql.close();
}

await store.close();
report();
