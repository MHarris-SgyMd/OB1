#!/usr/bin/env bun
/**
 * test-store-sql.ts — the SQL store against a real Postgres server.
 *
 * The point of Phase 2 is that swapping PostgREST for SQL changes *nothing* the
 * tools can observe. That is only credible if the replacement is exercised against
 * a real server with real pgvector, so this suite requires one.
 *
 *   ../db/with-postgres.sh bun test-store-sql.ts
 *   DATABASE_URL=… bun test-store-sql.ts
 *
 * It applies db/migrations first, so the database only needs to exist.
 */

import { SqlStore } from "./store-sql.ts";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { createStore } from "./store.ts";
import { SQL } from "bun";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "db", "migrations");
const URL_ = process.env.DATABASE_URL;

if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-store-sql.ts");
  process.exit(2);
}

/**
 * db/migrations/*.sql are templates — migrate.ts substitutes these at apply time.
 * Applying them raw fails with `syntax error at or near "{"`.
 */
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1536);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
function subst(sql: string): string {
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(EMBEDDING_DIM))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, EMBEDDING_MODEL);
}

const { assert, report } = createAssert();

const unit = (i: number) => {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i] = 1;
  return v;
};
const blend = () => {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 0.9;
  v[1] = 0.44;
  return v;
};

// Fresh schema.
await resetSchema(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

const store = new SqlStore(URL_, { max: 4 });

console.log("[1] The factory selects and validates");
{
  const s = await createStore({ OB1_STORE: "sql", DATABASE_URL: URL_ });
  assert(s.kind === "sql", "OB1_STORE=sql yields the SQL store");
  await s.close();

  let threw = "";
  try {
    await createStore({ OB1_STORE: "sql" });
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/requires DATABASE_URL/.test(threw), "sql without DATABASE_URL is rejected up front");

  threw = "";
  try {
    await createStore({ OB1_STORE: "nonsense" });
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/Unknown OB1_STORE/.test(threw), "an unknown store name is rejected, not defaulted");

  const p = await createStore({ OB1_STORE: "postgrest", SUPABASE_URL: "https://x.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(p.kind === "postgrest", "postgrest remains the other option");
  await p.close();
}

console.log("\n[2] captureThought writes content, metadata and vector atomically");
{
  const r = await store.captureThought({
    content: "exact",
    payload: { metadata: { kind: "a", source: "mcp" } },
    embedding: unit(0),
  });
  assert(typeof r.id === "string" && r.id.length === 36, `returns a uuid (${r.id?.slice(0, 8)}…)`);
  assert(r.embeddingFailed === undefined, "no degraded-write flag on the SQL path");

  const back = await store.getThought(r.id);
  assert(back?.content === "exact", "the row reads back");
  assert(back?.metadata.kind === "a", `metadata survived binding (${JSON.stringify(back?.metadata)})`);
  assert(back?.metadata.source === "mcp", "…including every key, not just the first");
}

console.log("\n[3] Search ranks and filters exactly as the RPC defines");
{
  await store.captureThought({ content: "near", payload: { metadata: { kind: "a" } }, embedding: blend() });
  await store.captureThought({ content: "distant", payload: { metadata: { kind: "b" } }, embedding: unit(1) });

  const all = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 10, filter: {} });
  assert(all.length === 3, `three rows above threshold -1 (got ${all.length})`);
  assert(all[0].content === "exact", `closest first (${all[0].content})`);
  assert(all[1].content === "near", `then the blend (${all[1].content})`);
  assert(Math.abs(all[0].similarity - 1) < 1e-6, "similarity is a number, ~1.0 for the exact match");
  assert(typeof all[0].created_at === "string" && all[0].created_at.endsWith("Z"), "created_at is an ISO string");

  // The strict comparison. An orthogonal row has similarity exactly 0 and must be
  // excluded at threshold 0 — reimplementing this with >= would silently change
  // every result count in the product.
  const strict = await store.matchThoughts({ embedding: unit(0), threshold: 0, limit: 10, filter: {} });
  assert(strict.length === 2, `threshold 0 excludes the exactly-orthogonal row (got ${strict.length})`);

  const filtered = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 10, filter: { kind: "b" } });
  assert(filtered.length === 1 && filtered[0].content === "distant", "jsonb containment filter applies");

  const capped = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 1, filter: {} });
  assert(capped.length === 1, "limit is honoured");
}

console.log("\n[4] listThoughts reproduces the PostgREST filters");
{
  const all = await store.listThoughts({ limit: 10 });
  assert(all.length === 3, `unfiltered returns everything (got ${all.length})`);
  assert(all[0].created_at >= all[all.length - 1].created_at, "newest first");

  const byType = await store.listThoughts({ limit: 10, type: "note" });
  assert(byType.length === 0, "an unmatched type filter returns nothing");

  await store.captureThought({
    content: "tagged",
    payload: { metadata: { type: "note", topics: ["alpha", "beta"], people: ["Ada"] } },
    embedding: unit(2),
  });

  assert((await store.listThoughts({ limit: 10, type: "note" })).length === 1, "type filter matches");
  assert((await store.listThoughts({ limit: 10, topic: "alpha" })).length === 1, "topic filter matches inside an array");
  assert((await store.listThoughts({ limit: 10, topic: "gamma" })).length === 0, "a topic not present does not match");
  assert((await store.listThoughts({ limit: 10, person: "Ada" })).length === 1, "person filter matches inside an array");
  assert((await store.listThoughts({ limit: 10, days: 1 })).length === 4, "days window includes today's rows");
  assert((await store.listThoughts({ limit: 2 })).length === 2, "limit is honoured");

  const combined = await store.listThoughts({ limit: 10, type: "note", topic: "beta", person: "Ada", days: 1 });
  assert(combined.length === 1, "filters combine with AND");
}

console.log("\n[5] Stats counting and paging");
{
  assert((await store.countThoughts()) === 4, "countThoughts sees the whole corpus");

  const p1 = await store.pageThoughtMeta(0, 2);
  const p2 = await store.pageThoughtMeta(2, 2);
  const p3 = await store.pageThoughtMeta(4, 2);
  assert(p1.length === 2 && p2.length === 2, "pages fill to the requested size");
  assert(p3.length === 0, "a page past the end is empty, which ends the loop");

  const seen = new Set([...p1, ...p2].map((r) => r.created_at + JSON.stringify(r.metadata)));
  assert(seen.size === 4, "pages do not overlap");
  assert(p1[0].created_at >= p2[p2.length - 1].created_at, "ordering is stable across pages");
}

console.log("\n[6] Dedup and merge behave as the tools expect");
{
  const before = await store.countThoughts();
  const again = await store.captureThought({
    content: "  EXACT  ",
    payload: { metadata: { extra: 1 } },
    embedding: unit(0),
  });
  assert((await store.countThoughts()) === before, "a normalised duplicate adds no row");

  const merged = await store.getThought(again.id);
  assert(merged?.metadata.kind === "a" && merged?.metadata.extra === 1, "metadata merged rather than replaced");
}

console.log("\n[7] Missing and malformed ids");
{
  assert((await store.getThought("11111111-2222-3333-4444-555555555555")) === null, "an absent uuid returns null");
  assert((await store.getThought("not-a-uuid")) === null, "a malformed id returns null, not a Postgres cast error");
}

console.log("\n[8] Errors surface rather than being swallowed");
{
  const broken = new SqlStore(URL_, { max: 1 });
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`ALTER FUNCTION match_thoughts(vector, float, int, jsonb) RENAME TO match_thoughts_hidden`;
  let threw = false;
  try {
    await broken.matchThoughts({ embedding: unit(0), threshold: 0, limit: 1, filter: {} });
  } catch {
    threw = true;
  }
  assert(threw, "a missing RPC throws instead of returning an empty result set");
  await admin`ALTER FUNCTION match_thoughts_hidden(vector, float, int, jsonb) RENAME TO match_thoughts`;
  await admin.close();
  await broken.close();
}

await store.close();

report();
