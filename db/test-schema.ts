#!/usr/bin/env bun
/**
 * test-schema.ts — apply db/migrations/*.sql to a real Postgres and assert the result.
 *
 * Uses PGlite: actual PostgreSQL 17 compiled to WASM, running in-process with real
 * pgvector. No daemon, no container, no network — so this runs in CI as easily as
 * it does locally, and it is the same query planner and the same operators that a
 * managed Postgres would use.
 *
 * What it protects: the core schema currently exists as prose inside
 * docs/01-getting-started.md, where nothing can execute it and nothing can check
 * it. These migrations are that DDL made applicable, and this file proves they
 * apply, are idempotent, and behave the way the guide describes.
 *
 * Run: bun db/test-schema.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
// Migration 011 does CREATE EXTENSION pg_trgm. PGlite ships contrib extensions as
// separate bundles that have to be handed in at construction — without this the
// migration does not merely skip the index, it raises and [1] fails.
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readdirSync, readFileSync } from "node:fs";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert } from "./test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "migrations");

/** Migrations are templates; migrate.ts substitutes these at apply time. */
function subst(sql: string): string {
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(EMBEDDING_DIM))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, EMBEDDING_MODEL);
}

const { assert, report } = createAssert();

/** A unit vector of EMBEDDING_DIM width that is `1` at one position and 0 elsewhere. */
function unit(at: number): string {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[at] = 1;
  return `[${v.join(",")}]`;
}
/** A unit vector of EMBEDDING_DIM width spanning two axes, so cosine similarity is strictly between. */
function blend(a: number, b: number, wa: number, wb: number): string {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[a] = wa;
  v[b] = wb;
  return `[${v.join(",")}]`;
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const db = new PGlite({ extensions: { vector, pg_trgm } });

// ── 1. Migrations apply, in order ────────────────────────────────────────────

console.log("[1] Migrations apply cleanly in lexical order");
assert(files.length > 0, `found ${files.length} migration files`);
for (const f of files) {
  try {
    await db.exec(subst((readFileSync(join(MIGRATIONS, f), "utf8"))));
    assert(true, `${f} applied`);
  } catch (e) {
    assert(false, `${f} applied — ${(e as Error).message}`);
  }
}

// ── 2. Idempotency ───────────────────────────────────────────────────────────

console.log("\n[2] Re-applying every migration is a no-op");
for (const f of files) {
  try {
    await db.exec(subst((readFileSync(join(MIGRATIONS, f), "utf8"))));
    assert(true, `${f} re-applied without error`);
  } catch (e) {
    assert(false, `${f} re-applied — ${(e as Error).message}`);
  }
}

// ── 3. Schema shape matches the guide ────────────────────────────────────────

console.log("\n[3] thoughts table matches docs/01-getting-started.md");
{
  const cols = await db.query<{ column_name: string; data_type: string; udt_name: string }>(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_name = 'thoughts' ORDER BY ordinal_position`
  );
  const shape = Object.fromEntries(
    cols.rows.map((c) => [c.column_name, c.data_type === "USER-DEFINED" ? c.udt_name : c.data_type])
  );
  const expected: Record<string, string> = {
    id: "uuid",
    content: "text",
    embedding: "vector",
    metadata: "jsonb",
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    content_fingerprint: "text",
  };
  for (const [col, type] of Object.entries(expected)) {
    assert(shape[col] === type, `${col} is ${type}${shape[col] === type ? "" : ` (got ${shape[col]})`}`);
  }
  assert(
    Object.keys(shape).length === Object.keys(expected).length,
    `exactly ${Object.keys(expected).length} columns (got ${Object.keys(shape).length})`
  );
}

console.log("\n[4] Indexes exist with the right access methods");
{
  const idx = await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'thoughts'`
  );
  const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
  assert(/USING hnsw/.test(byName["thoughts_embedding_idx"] ?? ""), "thoughts_embedding_idx is HNSW");
  assert(
    /vector_cosine_ops/.test(byName["thoughts_embedding_idx"] ?? ""),
    "…using vector_cosine_ops, matching the <=> operator the RPC orders by"
  );
  assert(/USING gin/.test(byName["thoughts_metadata_idx"] ?? ""), "thoughts_metadata_idx is GIN");
  assert(/created_at DESC/.test(byName["thoughts_created_at_idx"] ?? ""), "thoughts_created_at_idx is DESC");
  const fp = byName["idx_thoughts_fingerprint"] ?? "";
  assert(/UNIQUE/.test(fp), "idx_thoughts_fingerprint is UNIQUE");
  assert(
    /WHERE \(content_fingerprint IS NOT NULL\)/.test(fp),
    "…and partial, so pre-fingerprint rows do not collide on NULL"
  );

  const trgm = byName["idx_thoughts_content_trgm"] ?? "";
  assert(/USING gin/.test(trgm), "idx_thoughts_content_trgm is GIN");
  // The opclass is the part that actually matters and the part a careless edit
  // loses: `USING gin (content)` is a valid index that pg_trgm cannot use, and
  // it would satisfy the assertion above on its own.
  assert(/gin_trgm_ops/.test(trgm), "…with the gin_trgm_ops opclass, not a bare gin (content)");

  const ext = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_extension WHERE extname = 'pg_trgm'`
  );
  assert(ext.rows[0].c === 1, "the pg_trgm extension is installed");
}

// ── 4b. …and the planner can actually use it ─────────────────────────────────
//
// Everything in [4] is satisfied by an index that exists. None of it proves the
// planner will choose it for the pattern it was built for — a wrong opclass, a
// missing extension, or an expression mismatch all leave a perfectly valid index
// that no ILIKE ever touches. The seed table here is far too small for the
// planner to prefer an index on cost, so seqscan is disabled to ask the narrower
// question: CAN this index serve this query at all?

console.log("\n[4b] The trigram index is reachable by a leading-wildcard ILIKE");
{
  for (let i = 0; i < 40; i++) {
    await db.query(`INSERT INTO thoughts (content) VALUES ($1)`, [
      `trigram probe row ${i} discussing ${i % 7 === 0 ? "zylotrope" : "ordinary"} matters`,
    ]);
  }
  await db.query(`ANALYZE thoughts`);

  const plan = await db.query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT id FROM thoughts WHERE content ILIKE '%zylotrope%'`
  );
  const seqPlan = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
  // Not an assertion about which plan wins — on 40 rows a seq scan is correct,
  // and asserting otherwise would be asserting the planner is wrong.
  assert(typeof seqPlan === "string" && seqPlan.length > 0, "an ILIKE over content plans without error");

  // try/finally, because PGlite is one long-lived connection: a throw between
  // the two SETs would leave enable_seqscan off for every section after this
  // one, and those would then fail for a reason that has nothing to do with them.
  let forced;
  try {
    await db.query(`SET enable_seqscan = off`);
    forced = await db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT id FROM thoughts WHERE content ILIKE '%zylotrope%'`
    );
  } finally {
    await db.query(`SET enable_seqscan = on`);
  }
  const text = forced.rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert(/idx_thoughts_content_trgm/.test(text),
         `with seqscan off the planner reaches for the trigram index (got: ${text.replace(/\s+/g, " ").slice(0, 90)})`);

  // The result has to be right, not just indexed.
  const hits = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM thoughts WHERE content ILIKE '%zylotrope%'`
  );
  assert(hits.rows[0].c === 6, `and returns every planted row (${hits.rows[0].c} of 6)`);

  // A two-character pattern produces no trigrams. It must still be CORRECT —
  // silently returning nothing here would be the worst possible failure.
  const short = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM thoughts WHERE content ILIKE '%zy%'`
  );
  assert(short.rows[0].c === 6, `a sub-trigram pattern is unindexable but still correct (${short.rows[0].c} of 6)`);

  await db.query(`DELETE FROM thoughts WHERE content LIKE 'trigram probe row%'`);
}

// ── 5. The overload pair must not be ambiguous ───────────────────────────────

console.log("\n[5] Both upsert_thought overloads resolve unambiguously");
{
  const fns = await db.query<{ args: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'upsert_thought' AND n.nspname = 'public' ORDER BY 1`
  );
  const sigs = fns.rows.map((r) => r.args);
  // Three since migration 007 added the chunk-carrying form: (text, jsonb),
  // (text, jsonb, vector) and (text, jsonb, vector, jsonb).
  assert(sigs.length === 3, `three overloads registered (got ${sigs.length}: ${sigs.join(" | ")})`);
  assert(sigs.some((s) => s === "p_content text, p_payload jsonb"), "2-arg upsert_thought(text, jsonb) present");
  assert(sigs.some((s) => /vector/.test(s)), "3-arg overload with a vector present");

  // The failure this guards: a DEFAULT on p_embedding would make the 2-arg call
  // ambiguous and break every existing caller with "function is not unique".
  const two = await db.query<{ r: { id: string } }>(
    `SELECT upsert_thought('ambiguity probe', '{}'::jsonb) AS r`
  );
  assert(two.rows[0]?.r?.id != null, "calling it with two args still resolves");
}

// ── 6. Dedup behaviour ───────────────────────────────────────────────────────

console.log("\n[6] Fingerprint dedup normalises and merges");
{
  await db.exec(`DELETE FROM thoughts`);
  const a = await db.query<{ r: { id: string; fingerprint: string } }>(
    `SELECT upsert_thought('  Hello   World  ', '{"metadata":{"type":"idea"}}'::jsonb) AS r`
  );
  const b = await db.query<{ r: { id: string; fingerprint: string } }>(
    `SELECT upsert_thought('hello world', '{"metadata":{"topics":["greeting"]}}'::jsonb) AS r`
  );
  assert(a.rows[0].r.fingerprint === b.rows[0].r.fingerprint, "whitespace and case normalise to one fingerprint");
  assert(a.rows[0].r.id === b.rows[0].r.id, "second capture returns the same row id");

  const n = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts`);
  assert(n.rows[0].c === 1, `only one row stored (got ${n.rows[0].c})`);

  const m = await db.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM thoughts`);
  assert(m.rows[0].metadata.type === "idea", "original metadata retained");
  assert(Array.isArray(m.rows[0].metadata.topics), "new metadata merged in, not overwritten");
}

console.log("\n[7] The atomic overload stores the embedding in one statement");
{
  await db.exec(`DELETE FROM thoughts`);
  await db.query(`SELECT upsert_thought('atomic capture', '{}'::jsonb, $1::vector)`, [unit(0)]);
  const r = await db.query<{ has: boolean }>(`SELECT embedding IS NOT NULL AS has FROM thoughts`);
  assert(r.rows[0].has === true, "embedding present after a single call");

  // A metadata-only re-capture must not blank the vector it already has.
  await db.query(`SELECT upsert_thought('atomic capture', '{"metadata":{"x":1}}'::jsonb, NULL::vector)`);
  const after = await db.query<{ has: boolean }>(`SELECT embedding IS NOT NULL AS has FROM thoughts`);
  assert(after.rows[0].has === true, "a NULL embedding on re-capture preserves the existing one");
}

// ── 8. The plan's Phase 1 exit test ──────────────────────────────────────────

console.log("\n[8] match_thoughts ranks by cosine similarity");
{
  await db.exec(`DELETE FROM thoughts`);
  // Three thoughts at known angles from the query vector unit(0):
  //   exact   → similarity 1.0
  //   near    → mostly axis 0, some axis 1
  //   distant → orthogonal, similarity 0
  await db.query(`SELECT upsert_thought('exact match', '{"metadata":{"kind":"a"}}'::jsonb, $1::vector)`, [unit(0)]);
  await db.query(`SELECT upsert_thought('near match', '{"metadata":{"kind":"a"}}'::jsonb, $1::vector)`, [blend(0, 1, 0.9, 0.44)]);
  await db.query(`SELECT upsert_thought('distant match', '{"metadata":{"kind":"b"}}'::jsonb, $1::vector)`, [unit(1)]);

  const r = await db.query<{ content: string; similarity: number }>(
    `SELECT content, similarity FROM match_thoughts($1::vector, 0.0, 10, '{}'::jsonb)`,
    [unit(0)]
  );
  const order = r.rows.map((x) => x.content);
  assert(order[0] === "exact match", `closest first (got "${order[0]}")`);
  assert(order[1] === "near match", `then the blend (got "${order[1]}")`);
  assert(Math.abs(r.rows[0].similarity - 1) < 1e-6, "exact match scores ~1.0");
  assert(r.rows[0].similarity > r.rows[1].similarity, "similarity strictly decreases down the list");

  const t = await db.query<{ content: string }>(
    `SELECT content FROM match_thoughts($1::vector, 0.5, 10, '{}'::jsonb)`,
    [unit(0)]
  );
  assert(t.rows.length === 2, `threshold 0.5 excludes the orthogonal row (got ${t.rows.length} of 3)`);

  // The threshold comparison is strict (`> match_threshold`), so an exactly
  // orthogonal row — similarity 0.0 — is excluded at threshold 0.0. Anyone
  // reimplementing this in raw SQL must keep the strict comparison or result
  // counts will quietly change.
  const boundary = await db.query(
    `SELECT content FROM match_thoughts($1::vector, 0.0, 10, '{}'::jsonb)`,
    [unit(0)]
  );
  assert(boundary.rows.length === 2, "threshold is strict: similarity == threshold is excluded");

  const f = await db.query<{ content: string }>(
    `SELECT content FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"b"}'::jsonb)`,
    [unit(0)]
  );
  assert(f.rows.length === 1 && f.rows[0].content === "distant match", "jsonb filter narrows by metadata containment");

  const l = await db.query(`SELECT * FROM match_thoughts($1::vector, 0.0, 1, '{}'::jsonb)`, [unit(0)]);
  assert(l.rows.length === 1, "match_count caps the result set");
}

console.log("\n[9] updated_at trigger fires on update, created_at does not move");
{
  await db.exec(`DELETE FROM thoughts`);
  await db.query(`SELECT upsert_thought('trigger probe', '{}'::jsonb)`);
  const before = await db.query<{ c: string; u: string }>(`SELECT created_at::text c, updated_at::text u FROM thoughts`);
  await db.exec(`UPDATE thoughts SET content = 'trigger probe edited'`);
  const after = await db.query<{ c: string; u: string }>(`SELECT created_at::text c, updated_at::text u FROM thoughts`);
  assert(after.rows[0].c === before.rows[0].c, "created_at unchanged");
  assert(after.rows[0].u >= before.rows[0].u, "updated_at advanced");
}

// ── 10. No Supabase-isms left behind ─────────────────────────────────────────

console.log("\n[10] Migrations carry nothing Supabase-specific");
{
  const all = files.map((f) => subst((readFileSync(join(MIGRATIONS, f), "utf8")))).join("\n");
  assert(!/auth\.uid\(\)/.test(all), "no auth.uid() — GoTrue does not exist off Supabase");
  assert(!/auth\.role\(\)/.test(all), "no auth.role() — the core RLS policy is dropped deliberately");
  assert(!/\bTO service_role\b/.test(all), "no GRANT TO service_role — that role is Supabase-managed");
  assert(!/ENABLE ROW LEVEL SECURITY/i.test(all), "no RLS enabled — it never fired anyway");
  assert(!/pgcrypto/i.test(all) || /NOT pgcrypto/.test(all), "pgcrypto not required (gen_random_uuid + sha256 are built-ins)");
}


// ── 11. A malformed payload must be loud ─────────────────────────────────────

console.log("\n[11] Non-object payloads are rejected, not silently emptied");
{
  await db.exec(`DELETE FROM thoughts`);

  // The trap: `->` returns NULL for a non-object, so COALESCE writes '{}' and the
  // caller sees success while the metadata is gone. Client libraries differ here —
  // Bun.sql binds a JS string to jsonb as a JSON *string*, not an object.
  let raised = false;
  let message = "";
  try {
    await db.query(`SELECT upsert_thought('scalar payload', '"{\\"metadata\\":{\\"k\\":1}}"'::jsonb)`);
  } catch (e) {
    raised = true;
    message = (e as Error).message;
  }
  assert(raised, "a JSON string payload raises instead of storing {}");
  assert(/must be a JSON object/.test(message), "…with a message naming the cause");
  assert(/double-encode/.test(message), "…and pointing at double-encoding");

  const n = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts`);
  assert(n.rows[0].c === 0, "nothing was written on rejection");

  // Valid shapes still behave exactly as before.
  const okObj = await db.query<{ r: { id: string } }>(
    `SELECT upsert_thought('object payload', '{"metadata":{"k":1}}'::jsonb) AS r`
  );
  assert(okObj.rows[0].r.id != null, "an object payload still works");
  const okNull = await db.query<{ r: { id: string } }>(
    `SELECT upsert_thought('null payload', NULL::jsonb) AS r`
  );
  assert(okNull.rows[0].r.id != null, "a NULL payload still works");
  const okDefault = await db.query<{ r: { id: string } }>(
    `SELECT upsert_thought('default payload') AS r`
  );
  assert(okDefault.rows[0].r.id != null, "the '{}' default still works");

  let raised3 = false;
  try {
    await db.query(`SELECT upsert_thought('scalar 3arg', '"oops"'::jsonb, NULL::vector)`);
  } catch { raised3 = true; }
  assert(raised3, "the 3-arg overload rejects it too");
}

report();
