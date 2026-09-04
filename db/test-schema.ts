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
import {
  DEFAULT_TRGM_INDEX,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HNSW_MAX_SCAN_TUPLES,
  HNSW_SCAN_MEM_MULTIPLIER,
  migrationValues,
  substituteMigration,
  DEFAULT_CHUNK_CONTEXT,
} from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert } from "./test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "migrations");

/**
 * Migrations are templates; migrate.ts substitutes these at apply time. The
 * values come from config.mjs so this file cannot disagree with the runner about
 * what a placeholder means, or quietly ignore one it has not heard of.
 *
 * `trgm` defaults to DEFAULT_TRGM_INDEX rather than to a literal, so this file
 * exercises the schema a stock deployment gets and cannot drift from it. SMD-944
 * flipped that default from off to on; a hardcoded `false` here would have kept
 * asserting the old schema and passed. [4] asserts what the default produces and
 * [4b] proves the flag genuinely gates it, in both directions.
 */
function subst(sql: string, trgm = DEFAULT_TRGM_INDEX): string {
  return substituteMigration(
    sql,
    migrationValues({ dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, trgm })
  );
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

  // Present by default since SMD-944, because search_thoughts_keyword is a core
  // query that reaches it. Before that this assertion was its exact inverse, and
  // the flip is the whole substance of the default change — a schema test that
  // did not move with it would have kept passing against the old shape.
  const trgm = byName["idx_thoughts_content_trgm"] ?? "";
  assert(trgm !== "", "idx_thoughts_content_trgm is present by default (OB1_TRGM_INDEX unset)");
  // The opclass, not merely "is GIN": `USING gin (content)` is a valid index
  // that pg_trgm cannot use, and it satisfies a bare access-method check.
  assert(/gin_trgm_ops/.test(trgm), "…with the gin_trgm_ops opclass, not a bare gin (content)");

  // The extension is created regardless of the flag, so enabling the index on a
  // deployment that applied 011 with it off is one statement rather than one
  // statement plus a privilege grant.
  const ext = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_extension WHERE extname = 'pg_trgm'`
  );
  assert(ext.rows[0].c === 1, "…but the pg_trgm extension is installed either way");
}

// ── 4b. The flag gates the index, in both directions, and it is reachable ───
//
// Three things, because each is meaningless without the others.
//
// That the flag WORKS: [4] proved the default builds it. A flag whose two states
// produce the same schema is not a flag, so this drops the index and re-applies
// 011 with OB1_TRGM_INDEX off — it must stay gone — then with it on, and it must
// come back. Only asserting the on-direction would pass against a migration that
// ignored the flag entirely and always built the index.
//
// That the index is USABLE: existing is not the same as reachable. A wrong
// opclass, a missing extension, or an expression mismatch all leave a perfectly
// valid index that no ILIKE ever touches. The seed table is far too small for
// the planner to prefer an index on cost, so seqscan is disabled to ask the
// narrower question — CAN this index serve this query at all?
//
// That the RESULTS are right with and without it, including the two-character
// pattern the index structurally cannot serve.

console.log("\n[4b] The OB1_TRGM_INDEX flag gates the index in both directions");
{
  const file = readdirSync(MIGRATIONS).filter((f) => f.startsWith("011")).sort()[0];
  const sql011 = readFileSync(join(MIGRATIONS, file), "utf8");
  const indexExists = async () =>
    (await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_indexes WHERE indexname = 'idx_thoughts_content_trgm'`
    )).rows[0].c === 1;

  await db.exec(`DROP INDEX IF EXISTS idx_thoughts_content_trgm`);
  await db.exec(subst(sql011, false));
  assert(!(await indexExists()), "OB1_TRGM_INDEX off leaves the index unbuilt");

  await db.exec(subst(sql011, true));
  assert(await indexExists(), "…and on builds it again");

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

// ── 8b. The filter reaches the candidate scan (migration 014) ────────────────
//
// 007 took each CTE's top-40 by distance and applied the metadata filter to
// those 40. So a filtered search whose matches were not among the 40 globally
// nearest rows returned nothing, silently. These rows are arranged so that the
// crowd fills the candidate budget before the filtered row can appear: sixty
// near-copies of the query in kind "a", and one orthogonal row in kind "b".
// Plan-independent — the LIMIT sat before the filter whatever the planner did.

console.log("\n[8b] match_thoughts applies the metadata filter inside the candidate scan");
{
  await db.exec(`DELETE FROM thoughts`);
  for (let i = 0; i < 60; i++) {
    await db.query(`SELECT upsert_thought($1, '{"metadata":{"kind":"a"}}'::jsonb, $2::vector)`, [
      `crowd ${i}`,
      blend(0, 1, 1, 0.001 * (i + 1)),
    ]);
  }
  await db.query(`SELECT upsert_thought('the one b', '{"metadata":{"kind":"b"}}'::jsonb, $1::vector)`, [unit(1)]);
  // A second kind "b" row whose ONLY evidence is a chunk: no whole-content
  // vector, so the direct CTE cannot see it and the chunk CTE must.
  //
  // The chunk is inserted directly rather than through upsert_thought's jsonb
  // path. Observed, not explained: under PGlite a chunk stored through that
  // path prints its vector correctly but returns NULL from every distance
  // operator (`vector_norm`, `<=>`, `<->`), so the row is silently unrankable
  // and the HNSW scan never yields it. Real Postgres does not do this — the
  // live suite, test-chunking.ts and evals/eval-filtered.ts all store chunks
  // through upsert_thought there and search them. This section is about
  // match_thoughts, so it takes the path PGlite gets right.
  const b2 = await db.query<{ r: { id: string } }>(
    `SELECT upsert_thought('b via chunk', '{"metadata":{"kind":"b"}}'::jsonb, NULL::vector) AS r`
  );
  await db.query(`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES ($1, 0, 'window', $2::vector)`, [
    b2.rows[0].r.id,
    unit(1),
  ]);

  const f = await db.query<{ content: string }>(
    `SELECT content FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"b"}'::jsonb)`,
    [unit(0)]
  );
  const got = f.rows.map((r) => r.content).sort();
  assert(got.length === 2, `both kind "b" rows come back past sixty nearer kind "a" rows (got ${got.length})`);
  assert(got[0] === "b via chunk", "…including the one reachable only through its chunk");
  assert(got[1] === "the one b", "…and the one reachable through its own vector");

  const none = await db.query(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"z"}'::jsonb)`, [unit(0)]);
  assert(none.rows[0].c === 0, "a filter nothing matches still returns nothing");

  // The unfiltered path must not depend on metadata being an object, or on it
  // being present at all. 001 declares the column nullable with no type check,
  // and the `||` merges in 005 and 013 can turn an object into an array. A
  // "simplification" to `metadata @> COALESCE(filter, '{}')` would drop these
  // rows from every unfiltered search: `NULL @> '{}'` is NULL and
  // `'[1]' @> '{}'` is false. The boolean local in 014's body is load-bearing.
  await db.exec(`UPDATE thoughts SET metadata = NULL WHERE content = 'crowd 0'`);
  await db.exec(`UPDATE thoughts SET metadata = '[1]'::jsonb WHERE content = 'crowd 1'`);
  const odd = await db.query<{ content: string }>(`SELECT content FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [unit(0)]);
  const oddNames = odd.rows.map((r) => r.content);
  assert(oddNames.includes("crowd 0"), "a row with NULL metadata is returned by an unfiltered search");
  assert(oddNames.includes("crowd 1"), "a row with array metadata is returned by an unfiltered search");
  const oddFiltered = await db.query(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"a"}'::jsonb)`, [unit(0)]);
  assert(oddFiltered.rows[0].c === 10, `…and a filter simply does not match them, without error (got ${oddFiltered.rows[0].c} of the 58 remaining kind "a")`);

  // 007 evaluated `NULL = '{}' OR metadata @> NULL` → NULL → every row excluded.
  const nul = await db.query(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, NULL::jsonb)`, [unit(0)]);
  assert(nul.rows[0].c === 10, `a NULL filter is unfiltered (got ${nul.rows[0].c} rows, 007 gave 0)`);

  // The overfetch is honoured above the default: 62 rows stored, 50 asked, 50 back.
  // Under 007 each CTE stopped at hnsw.ef_search (40) candidates.
  const big = await db.query(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 50, '{}'::jsonb)`, [unit(0)]);
  assert(big.rows[0].c === 50, `match_count 50 returns 50 of 62 rows (got ${big.rows[0].c})`);

  // The setting that makes the in-scan filter correct lives on the function.
  // Asserted by name so a later CREATE OR REPLACE that forgets the SET clause —
  // the defined-twice class FORK.md keeps finding — fails here, not in search.
  const cfg = await db.query<{ cfg: string | null }>(
    `SELECT array_to_string(proconfig, ',') AS cfg FROM pg_proc
     WHERE oid = 'match_thoughts(vector, float, int, jsonb)'::regprocedure`
  );
  assert(
    /(^|,)hnsw\.iterative_scan=relaxed_order(,|$)/.test(cfg.rows[0]?.cfg ?? ""),
    `match_thoughts carries hnsw.iterative_scan=relaxed_order (proconfig: ${cfg.rows[0]?.cfg ?? "none"})`
  );
  // The bounds travel with the scan mode. Their values come from config.mjs
  // (OB1_HNSW_*), so the assertion reads the same constants the migrator
  // substitutes rather than a literal that could drift from them.
  const proconfig = cfg.rows[0]?.cfg ?? "";
  assert(
    new RegExp(`(^|,)hnsw\\.max_scan_tuples=${HNSW_MAX_SCAN_TUPLES}(,|$)`).test(proconfig),
    `…and hnsw.max_scan_tuples=${HNSW_MAX_SCAN_TUPLES}, the tuple bound on the walk`
  );
  assert(
    new RegExp(`(^|,)hnsw\\.scan_mem_multiplier=${HNSW_SCAN_MEM_MULTIPLIER}(,|$)`).test(proconfig),
    `…and hnsw.scan_mem_multiplier=${HNSW_SCAN_MEM_MULTIPLIER}, without which the memory bound stops the walk near 19,000 tuples`
  );
  assert(/(^|,)plan_cache_mode=force_custom_plan(,|$)/.test(proconfig), "…and plan_cache_mode=force_custom_plan, so a filter is a constant the planner can route to the GIN index");

  // The placeholder is live: 014 applied with a different bound carries it into
  // proconfig, which is how an operator's OB1_HNSW_MAX_SCAN_TUPLES survives a
  // later redefinition through the migrator. Then the default is restored.
  const f014 = files.find((f) => f.startsWith("014"))!;
  const tuned = substituteMigration(
    readFileSync(join(MIGRATIONS, f014), "utf8"),
    migrationValues({ dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, trgm: DEFAULT_TRGM_INDEX, hnswMaxScanTuples: 250000 })
  );
  await db.exec(tuned);
  const tunedCfg = await db.query<{ cfg: string | null }>(
    `SELECT array_to_string(proconfig, ',') AS cfg FROM pg_proc WHERE oid = 'match_thoughts(vector, float, int, jsonb)'::regprocedure`
  );
  assert(/(^|,)hnsw\.max_scan_tuples=250000(,|$)/.test(tunedCfg.rows[0]?.cfg ?? ""), "OB1_HNSW_MAX_SCAN_TUPLES reaches the function through the template");
  await db.exec(subst(readFileSync(join(MIGRATIONS, f014), "utf8")));
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
  /**
   * Comments are stripped before scanning, and that is not a convenience.
   *
   * These are text searches over the migration files, so they cannot tell a
   * statement from prose ABOUT a statement. Migration 012's header quotes the
   * `GRANT EXECUTE ... TO authenticated, service_role` that upstream's version
   * ends with, in order to explain why this fork does not have it — and that
   * quotation failed this assertion. A guard that forbids DISCUSSING the thing
   * it forbids pushes the explanation out of the file, which is the opposite of
   * what these headers are for.
   *
   * Stripping first makes the check strictly sharper, not laxer: it still sees
   * every executable statement, and it stops seeing text that only describes
   * one. `--` to end of line, and `/* *\/` blocks; no migration here puts either
   * sequence inside a string literal, and one that did would be a reason to
   * parse rather than to widen this.
   */
  const executable = (sql: string) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const all = files
    .map((f) => executable(subst(readFileSync(join(MIGRATIONS, f), "utf8"))))
    .join("\n");
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

// ── 12. search_thoughts_keyword ──────────────────────────────────────────────
//
// Migration 012. The five properties that make it a keyword search rather than
// an ILIKE with extra steps: exactness (wildcards escaped), a stable page
// boundary, a true total_count, correctness below the trigram floor, and leaving
// the semantic path alone.

console.log("\n[12] search_thoughts_keyword matches exactly and pages stably");
{
  await db.query(`DELETE FROM thoughts`);
  const seed: [string, string, string][] = [
    ["call upsert_thought here",                                 '{"type":"note"}',  "2024-01-01"],
    ["call upsert-thought here",                                 '{"type":"note"}',  "2024-01-02"],
    ["call upsertXthought here",                                 '{"type":"other"}', "2024-01-03"],
    ["upsert_thought, upsert_thought and upsert_thought again",  '{"type":"note"}',  "2024-01-04"],
    ["UPSERT_THOUGHT shouted",                                   '{}',               "2024-01-05"],
    ["100% certain about PGRST202 from the client",              '{}',               "2024-01-06"],
    // Present so the `%` test can fail: unescaped, '%100%%' matches this too.
    ["1000 units certain",                                       '{}',               "2024-01-07"],
  ];
  for (const [content, meta, at] of seed) {
    await db.query(
      `INSERT INTO thoughts (content, metadata, created_at) VALUES ($1, $2::jsonb, $3::timestamptz)`,
      [content, meta, at]
    );
  }

  type Hit = { content: string; occurrences: number; total_count: string | number };
  const search = async (q: string, limit = 25, offset = 0, filter = "{}") =>
    (await db.query<Hit>(
      `SELECT content, occurrences, total_count
       FROM search_thoughts_keyword($1, $2, $3, $4::jsonb)`,
      [q, limit, offset, filter]
    )).rows;

  // Exactness. `_` is an ILIKE wildcard and the single most common character in
  // the identifiers this tool exists to find; unescaped, this query also matches
  // "upsert-thought" and "upsertXthought", which is a keyword search that is not
  // exact. Both wrong rows are in the seed on purpose.
  const ident = await search("upsert_thought");
  assert(ident.length === 3, `an underscored identifier matches only its 3 literal rows (got ${ident.length})`);
  assert(!ident.some((r) => /upsert-thought|upsertXthought/.test(r.content)),
         "…and _ did not behave as a single-character wildcard");
  assert(ident[0].occurrences === 3, `ordered by occurrence count first (got ${ident[0].occurrences})`);
  assert(ident.some((r) => /UPSERT_THOUGHT/.test(r.content)), "…and the match is case-insensitive");

  // `%` likewise. "100%" must not be "1", "0", "0", anything.
  const pct = await search("100%");
  assert(pct.length === 1 && /100% certain/.test(pct[0].content),
         `% in a query is a literal, not a wildcard (got ${pct.length}, "1000 units certain" is seeded to catch it)`);

  // The capability tsvector cannot offer: a fragment inside a token. This is the
  // reason migration 012 is substring-based, so it is asserted rather than
  // assumed — see the measured table in the migration header.
  const frag = await search("PGRST");
  assert(frag.length === 1, "a fragment inside an alphanumeric token is found (PGRST in PGRST202)");

  // Sub-trigram. The index cannot serve it; the answer must still be right.
  const two = await search("0%");
  assert(two.length === 1 && /100% certain/.test(two[0].content),
         "a two-character needle is unindexable but still correct");

  // An empty needle is zero rows, not the whole table. The failure mode being
  // excluded is a caller bug reading as a very slow success.
  for (const empty of ["", "   "]) {
    assert((await search(empty)).length === 0, `an ${empty === "" ? "empty" : "all-whitespace"} query returns nothing`);
  }

  // …but whitespace AROUND something is part of the needle. An earlier version
  // trimmed, and "call " then matched rows where "call" is followed by anything.
  // Trimming a keyword search is silently widening it.
  // "certain" is in two seeded rows; "certain " with the space is in one, because
  // the other ends on it.
  assert((await search("certain")).length === 2, "the bare word is in two rows");
  const trailing = await search("certain ");
  assert(trailing.length === 1, `a trailing space is matched literally, not trimmed away (got ${trailing.length} of 1)`);
  assert(/100% certain/.test(trailing[0].content),
         "…so it excludes the row where the word ends the text");

  // total_count is the whole match set, not the page.
  const page = await search("call", 2, 0);
  assert(page.length === 2, "limit bounds the page");
  assert(Number(page[0].total_count) === 3, `…and total_count reports all 3 matches, not the 2 returned`);
  const independent = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM thoughts WHERE content ILIKE '%call%'`
  );
  assert(independent.rows[0].c === Number(page[0].total_count),
         "…and agrees with an independent count(*)");

  // The page boundary. Every seeded row has occurrences = 1 for this needle, so
  // the first two sort keys are tied for all six and only the `id` tiebreak makes
  // the order total. Without it Postgres may order the ties differently between
  // the two executions, silently repeating one row and dropping another.
  // Offsets past the end are empty, not an error.
  assert((await search("t", 2, 99)).length === 0, "an offset past the end is empty, not an error");

  // The limit is clamped rather than trusted, and total_count is how a caller
  // sees that it was.
  assert((await search("t", 1000)).length === 7, "an over-large limit is clamped without erroring");

  // Same containment semantics as match_thoughts.
  const filtered = await search("call", 25, 0, '{"type":"note"}');
  assert(filtered.length === 2, `the metadata filter is jsonb containment (got ${filtered.length} of 2)`);
  assert(Number(filtered[0].total_count) === 2, "…and total_count counts the filtered set");

  // NULL query, which a driver can produce from an absent argument.
  const nulls = await db.query(`SELECT * FROM search_thoughts_keyword(NULL)`);
  assert(nulls.rows.length === 0, "a NULL query returns nothing rather than raising");

  await db.query(`DELETE FROM thoughts`);
}

// ── 12b. The page boundary is stable across plan changes ─────────────────────
//
// This is a separate section because the obvious version of it does not work,
// and the reason is worth writing down. Paging six tied rows two at a time and
// checking for repeats passes whether or not the ORDER BY has a unique final
// key: at that size Postgres picks one plan and returns ties in the same
// physical order every time, so the test confirms what you hoped rather than
// excluding the failure. Deleting `h.hit_id` from the migration's ORDER BY was
// measured to leave that version green.
//
// What actually discriminates is varying the PLAN between pages. With a total
// sort order the result is plan-independent; without one, a bitmap heap scan and
// a sequential scan visit tied rows in different orders, and a row moves across
// the boundary while another is skipped. Measured with the tiebreak removed:
// 2 repeats, 398 of 400 rows covered. With it: 0 and 400.

console.log("\n[12b] Paging is stable when the plan changes underneath it");
{
  await db.query(`DELETE FROM thoughts`);
  // Every row ties on occurrences AND created_at, so `id` is the only thing
  // that can make the sort total.
  for (let i = 0; i < 400; i++) {
    await db.query(
      `INSERT INTO thoughts (content, created_at) VALUES ($1, '2024-01-01'::timestamptz)`,
      [`row ${i} zylotrope filler`]
    );
  }
  await db.query(`ANALYZE thoughts`);

  const seen = new Set<string>();
  let repeats = 0;
  try {
    for (let off = 0; off < 400; off += 50) {
      // Alternating, so consecutive pages are produced by different plans.
      await db.query(`SET enable_seqscan = ${off % 100 === 0 ? "on" : "off"}`);
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM search_thoughts_keyword('zylotrope', 50, $1)`,
        [off]
      );
      for (const r of rows.rows) {
        if (seen.has(r.id)) repeats++;
        seen.add(r.id);
      }
    }
  } finally {
    await db.query(`SET enable_seqscan = on`);
  }
  assert(repeats === 0, `no row appears on two pages (${repeats} repeats)`);
  assert(seen.size === 400, `and every row appears on one (${seen.size} of 400)`);

  await db.query(`DELETE FROM thoughts`);
}

// ── 13. 012 did not disturb the semantic path ────────────────────────────────
//
// The specific regression SMD-944 warns about: schemas/enhanced-thoughts ships
// its keyword search in a file that also does `CREATE OR REPLACE FUNCTION
// upsert_thought(...)` with no actor handling, which silently destroys migration
// 008's audit attribution. Porting the idea without porting the file is only
// worth anything if that is checked rather than asserted in a comment.

console.log("\n[13] Migration 012 left upsert_thought and match_thoughts alone");
{
  const overloads = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'upsert_thought' AND n.nspname = 'public'`
  );
  assert(overloads.rows[0].c === 3, `all three upsert_thought overloads survive (got ${overloads.rows[0].c})`);

  const src = await db.query<{ prosrc: string }>(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'upsert_thought' AND n.nspname = 'public'`
  );
  assert(src.rows.some((r) => /ob1\.actor/.test(r.prosrc)),
         "…and at least one still sets ob1.actor, so the audit trigger is still attributed");

  const mt = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'match_thoughts' AND n.nspname = 'public'`
  );
  assert(mt.rows[0].c === 1, "match_thoughts is untouched and unduplicated");

  // The name collision 012's header explains: a deployment carrying upstream's
  // search_thoughts_text must not have it replaced or shadowed.
  const upstreamName = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'search_thoughts_text' AND n.nspname = 'public'`
  );
  assert(upstreamName.rows[0].c === 0, "012 defines no search_thoughts_text, so it cannot clash with upstream's");
}

// ── 14. Migration 013 — chunk context ────────────────────────────────────────

console.log("\n[14] Migration 013 declares chunk context without disturbing anything");
{
  /**
   * Static assertions only. The behavioural half — that a context survives a
   * capture, an edit and a bare payload — lives in `db/test-live.ts` [7],
   * against real Postgres, because PGlite cannot run it: writing chunk rows
   * through the 4-argument `upsert_thought` crashes the WASM build in this
   * process, with "received invalid response: 0" when the payload is bound as
   * a parameter and "Out of bounds memory access" when it is inlined or built
   * server-side with array_fill.
   *
   * It reproduces with migrations 001-012 applied and no 013, at any position
   * in this file, on the shared instance and on a second one — so it is the
   * harness rather than the migration, and moving the assertions to the suite
   * that runs against a real server is the fix rather than a workaround. The
   * split is not a loss of coverage: the same functions are exercised through
   * a container in test-live.ts [7] and in server-portable/test-chunking.ts.
   */
  const col = await db.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_name = 'thought_chunks' AND column_name = 'context'`
  );
  assert(col.rows.length === 1, "thought_chunks.context exists");
  assert(col.rows[0]?.data_type === "text", `…as text (got ${col.rows[0]?.data_type})`);
  assert(col.rows[0]?.is_nullable === "YES",
         "…and nullable, so a window embedded bare is representable");

  /**
   * Both writers, read out of pg_proc rather than out of the file. A migration
   * that added the column and updated only `upsert_thought` would pass every
   * capture test and silently strip context on the first edit — so the source
   * of each function is checked for the column by name.
   */
  const src = await db.query<{ proname: string; prosrc: string }>(
    `SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname IN ('upsert_thought', 'update_thought')`
  );
  const writes = src.rows.filter((r) => /INSERT INTO thought_chunks/i.test(r.prosrc));
  assert(writes.length === 2, `two functions write chunk rows (got ${writes.length})`);
  assert(writes.every((r) => /elem->>'context'/.test(r.prosrc)),
         "…and both carry context through, so an edit cannot strip it");

  // 013 REPLACES those functions rather than adding overloads. A signature that
  // drifted by one default or one type would leave a fourth upsert_thought or a
  // second update_thought behind, and every existing caller would start failing
  // with "function is not unique".
  const counts = await db.query<{ n: number; u: number }>(
    `SELECT
       count(*) FILTER (WHERE p.proname = 'upsert_thought')::int AS n,
       count(*) FILTER (WHERE p.proname = 'update_thought')::int AS u
     FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'`
  );
  assert(counts.rows[0].n === 3, `still exactly three upsert_thought overloads (got ${counts.rows[0].n})`);
  assert(counts.rows[0].u === 1, `still exactly one update_thought (got ${counts.rows[0].u})`);

  const cfg = await db.query<{ value: string }>(
    `SELECT value FROM ob1_config WHERE key = 'chunk_context'`
  );
  assert(cfg.rows[0]?.value === String(DEFAULT_CHUNK_CONTEXT),
         `ob1_config records the configured setting (got ${cfg.rows[0]?.value})`);
}

report();
