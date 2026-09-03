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

console.log("\n[1b] The actor reaches the audit trail on THIS store too");
{
  // The gap this suite exists to catch: an earlier version set the audit actor
  // with a transaction-local setting in store-sql only, so every audit row
  // written through PostgREST recorded a NULL actor — present, plausible, wrong.
  const { id } = await store.captureThought({
    content: "a thought captured with an actor",
    payload: { metadata: { source: "postgrest-test" } },
    embedding: vec(5),
    actor: { name: "importer", source: "postgrest-test" },
  });
  const sql = new SQL({ url: URL_, max: 1 });
  const [ev] = await sql`
    SELECT action, actor_name, source FROM thought_audit WHERE thought_id = ${id}`;
  assert(ev?.actor_name === "importer", `attributed to the key name (${ev?.actor_name})`);
  assert(ev?.action === "capture", "recorded as a capture");
  assert(ev?.source === "postgrest-test", `source carried (${ev?.source})`);

  // And the actor must not leak into the thought's own metadata — it rides in
  // the payload envelope, which upsert_thought reads but does not store.
  const [t] = await sql`SELECT metadata FROM thoughts WHERE id = ${id}`;
  assert(t.metadata?.actor === undefined, "the actor is not stored on the thought itself");
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

console.log("\n[3b] keywordThoughts over PostgREST returns the same shape");
{
  // The reason this store has a suite at all: an RPC argument shape that is
  // wrong here type-checks, runs, and silently returns nothing. `total_count`
  // is the specific hazard — PostgREST hands back the function's snake_case
  // column names, and a cast rather than a mapping would deliver
  // `totalCount: undefined` to every caller with no error anywhere.
  await store.captureThought({
    content: "postgrest keyword needle PGRST202 mentioned once",
    payload: { metadata: { kind: "kw" } },
    embedding: vec(9),
  });

  const hits = await store.keywordThoughts({ query: "PGRST202", limit: 10, offset: 0, filter: {} });
  assert(hits.length === 1, `the RPC reaches the function (${hits.length})`);
  assert(hits[0].totalCount === 1, `total_count is mapped to totalCount, not undefined (${hits[0].totalCount})`);
  assert(hits[0].occurrences === 1, `occurrences arrives as a number (${hits[0].occurrences})`);
  assert(typeof hits[0].id === "string" && hits[0].id.length === 36, "…with a uuid id");

  // The p_filter argument, which is the jsonb one and therefore the one that
  // binds wrongly if it is pre-stringified.
  const kept = await store.keywordThoughts({ query: "PGRST202", limit: 10, offset: 0, filter: { kind: "kw" } });
  assert(kept.length === 1, "a matching jsonb filter is passed through as an object, not a scalar string");
  const dropped = await store.keywordThoughts({ query: "PGRST202", limit: 10, offset: 0, filter: { kind: "nope" } });
  assert(dropped.length === 0, "…and a non-matching one actually filters");
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

console.log("\n[7] resolveAgent's RPC argument shape, and the id it produces");
{
  /**
   * The same gap [1b] exists for, one migration later. Every other suite runs
   * OB1_STORE=sql, so `resolve_agent`'s three named arguments on this path —
   * p_key_hash, p_label, p_scope — were unverified. A Workers deployment
   * speaking PostgREST would have silently gone unattributed.
   */
  const hash = "e".repeat(64);
  const first = await store.resolveAgent({ keyHash: hash, label: "connector", scope: "read" });
  assert(first.ok === true, "the RPC resolves through the PostgREST client");
  assert(first.ok === true && /^[0-9a-f-]{36}$/.test(first.agentId), "…returning a uuid");
  assert(first.ok === true && first.created === true, "…and reporting first sight");

  const again = await store.resolveAgent({ keyHash: hash, label: "connector", scope: "read" });
  assert(again.ok === true && first.ok === true && again.agentId === first.agentId,
         "the same pair resolves to the same id on this store");

  // The end-to-end claim, on the path that had no coverage: an id resolved here
  // lands in the audit row when passed as the actor.
  const agentId = first.ok ? first.agentId : "";
  const { id } = await store.captureThought({
    content: "a thought captured by a resolved agent",
    payload: { metadata: { source: "postgrest-test" } },
    embedding: vec(6),
    actor: { name: "connector", source: "postgrest-test", agentId },
  });
  const sql = new SQL({ url: URL_, max: 1 });
  const [ev] = await sql`
    SELECT canonical_agent_id FROM thought_audit WHERE thought_id = ${id}`;
  assert(ev?.canonical_agent_id === agentId,
         `the resolved id reaches canonical_agent_id (${ev?.canonical_agent_id})`);
  await sql.close();
}

await store.close();
report();
