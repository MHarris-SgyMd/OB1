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
  DB_LEVEL_SETTINGS_SQL,
  HNSW_SEEDS,
  HNSW_SEED_MAX_SCAN_TUPLES,
  MATCH_COUNT_CEILING,
  migrationValues,
  parseSetConfig,
  substituteMigration,
  DEFAULT_CHUNK_CONTEXT,
} from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, seededRandom } from "./test-support.ts";

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
  // `'[1]' @> '{}'` is false. The unfiltered branch carries no predicate at
  // all, which is what these rows pin.
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

  // The clamp's edges, named in the header: 0 and negative give 1 row, NULL
  // gives the default 10. 007 gave 0, an error, and the whole candidate set.
  for (const [arg, want, label] of [["0", 1, "match_count 0 returns 1 row"], ["-5", 1, "a negative match_count returns 1 row, not an error"], ["NULL", 10, "a NULL match_count returns the default 10"]] as const) {
    const r = await db.query(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, ${arg}, '{}'::jsonb)`, [unit(0)]);
    assert(r.rows[0].c === want, `${label} (got ${r.rows[0].c})`);
  }
  // The body, read once: the ceiling and the sentinel are both in it.
  const prosrc = String((await db.query<{ s: string | null }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'match_thoughts(vector, float, int, jsonb)'::regprocedure`)).rows[0]?.s ?? "");
  // The ceiling is the one config.mjs defines, templated into the body — so the
  // assertion is built from the constant, not from a literal that would have to
  // be hand-edited when the constant moves (an earlier draft pinned 500 twice).
  // Its value is exercised on a real server in db/test-live.ts [5b]; 62 rows
  // cannot show it here.
  assert(new RegExp(`LEAST\\(GREATEST\\(COALESCE\\(match_count, 10\\), 1\\), ${MATCH_COUNT_CEILING}\\)`).test(prosrc),
    `match_count is clamped to MATCH_COUNT_CEILING (${MATCH_COUNT_CEILING}) inside the function`);

  // The contract sentinel preflight reads — in the BODY, which a replace
  // rewrites, not in the COMMENT, which a replace leaves on the preserved OID.
  assert(/ob1:filter-inside-scan/.test(prosrc), "the function body carries the ob1:filter-inside-scan sentinel a successor must keep");

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
  // The scan mode is the ONLY function-level SET: the two walk bounds are
  // deliberately not on the function, because a function-level value would
  // override the database-level one that is the operator's tuning knob, and
  // the plan mode an earlier draft forced is unnecessary once the filter is a
  // plain predicate in its own branch.
  const proconfig = cfg.rows[0]?.cfg ?? "";
  assert(!/hnsw\.max_scan_tuples|hnsw\.scan_mem_multiplier|plan_cache_mode/.test(proconfig), "…and nothing else — neither walk bound nor a forced plan mode");

  // The branches must be the same function: the filtered answer for kind "a"
  // (58 matching rows — the EXACT branch, under the 1,000-row threshold) must
  // be the unfiltered branch's answer with the non-"a" rows taken out — same
  // rows, same order. By this point crowd 0 and crowd 1 carry NULL and array
  // metadata, so they are excluded along with the two "b" rows. The walk
  // branch is held to the exact answer in [8c], which has enough rows to
  // reach it.
  const viaFilter = await db.query<{ content: string }>(`SELECT content FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"a"}'::jsonb)`, [unit(0)]);
  const viaNone = await db.query<{ content: string }>(`SELECT content FROM match_thoughts($1::vector, -1.0, 20, '{}'::jsonb)`, [unit(0)]);
  const notA = new Set(["crowd 0", "crowd 1", "the one b", "b via chunk"]);
  const expected = viaNone.rows.map((r) => r.content).filter((c) => !notA.has(c)).slice(0, 10);
  assert(
    viaFilter.rows.length === 10 && viaFilter.rows.every((r, i) => r.content === expected[i]),
    "the filtered and unfiltered branches rank the same rows the same way when the filter admits them"
  );

  // The bounds are seeded at database level, once. A value an operator set
  // first is left alone by re-applying 014; the seeded default is restored at
  // the end so later sections see the shipped state.
  const dbSettings = async () => parseSetConfig((await db.query<{ cfg: string[] | null }>(DB_LEVEL_SETTINGS_SQL)).rows[0]?.cfg);
  // The database's name as an identifier, quoted the way the migrator quotes
  // its printed remedy — the value could be `open-brain`.
  const alterDb = async (setting: string) =>
    db.exec((await db.query<{ q: string }>(`SELECT format('ALTER DATABASE %I SET %s', current_database(), $1::text) AS q`, [setting])).rows[0].q);
  const seeded = await dbSettings();
  for (const [name, value] of Object.entries(HNSW_SEEDS)) {
    assert(seeded[name] === String(value), `${name}=${value} is seeded on the database (${JSON.stringify(seeded)})`);
  }
  await alterDb("hnsw.max_scan_tuples = 250000");
  const f014 = files.find((f) => f.startsWith("014"))!;
  await db.exec(subst(readFileSync(join(MIGRATIONS, f014), "utf8")));
  assert((await dbSettings())["hnsw.max_scan_tuples"] === "250000", "re-applying 014 leaves an operator's database-level bound alone");
  // A ROLE-level value is not a reason to skip the seed: it reaches one role,
  // sits ABOVE the database level in precedence (so the seed cannot undo it),
  // and the ninth-pass guard let it suppress the seed for every other role.
  // Session-level SET stands in for ALTER ROLE here — PGlite has one role and
  // one session, and both report a non-shared source — so: clear the database
  // row, set the value in the session, re-apply, and the row must come back.
  await db.exec((await db.query<{ q: string }>(`SELECT format('ALTER DATABASE %I RESET hnsw.max_scan_tuples', current_database()) AS q`)).rows[0].q);
  await db.exec(`SET hnsw.max_scan_tuples = 5000`);
  await db.exec(subst(readFileSync(join(MIGRATIONS, f014), "utf8")));
  assert((await dbSettings())["hnsw.max_scan_tuples"] === String(HNSW_SEED_MAX_SCAN_TUPLES),
    "a value set only for this role/session does not stop 014 seeding the database-level default for everyone else");
  await db.exec(`RESET hnsw.max_scan_tuples`);
  await alterDb(`hnsw.max_scan_tuples = ${HNSW_SEED_MAX_SCAN_TUPLES}`);
}

// ── 8c. The walk branch, held to the exact answer ────────────────────────────
//
// Filters matching at most 1,000 thoughts are answered exactly, from the rows
// themselves; [8b] covers that and the never-matching case. Above 1,000 the
// function walks the HNSW index with the predicate inside the scan, and that
// branch needs more rows than [8b] has to be reached at all.

console.log("\n[8c] above the exact threshold, the walk branch agrees with an exact scan");
{
  await db.exec(`DELETE FROM thoughts`);
  const { unitVector } = seededRandom(968);
  const N = 1200;
  for (let i = 0; i < N; i += 100) {
    const values = Array.from({ length: 100 }, (_, k) => `('walk ${i + k}', '{"kind":"c"}'::jsonb, '[${unitVector(EMBEDDING_DIM).join(",")}]'::vector)`).join(",");
    await db.exec(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  // Two that must not be found: a different kind, nearest to the query.
  const q = unitVector(EMBEDDING_DIM);
  await db.query(`INSERT INTO thoughts (content, metadata, embedding) VALUES ('near but d', '{"kind":"d"}'::jsonb, $1::vector)`, [`[${q.join(",")}]`]);
  const matches = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts WHERE metadata @> '{"kind":"c"}'`);
  assert(matches.rows[0].c > 1000, `${matches.rows[0].c} matching rows, above the 1,000-row exact threshold — the walk branch`);

  let overlap = 0;
  let wrongKind = 0;
  let returned = 0;
  const QUERIES = 3;
  for (let i = 0; i < QUERIES; i++) {
    const qv = `[${(i === 0 ? q : unitVector(EMBEDDING_DIM)).join(",")}]`;
    await db.exec(`SET enable_indexscan = off`);
    await db.exec(`SET enable_bitmapscan = off`);
    const exact = await db.query<{ id: string }>(`SELECT id FROM thoughts WHERE metadata @> '{"kind":"c"}' ORDER BY embedding <=> $1::vector LIMIT 10`, [qv]);
    await db.exec(`RESET enable_indexscan`);
    await db.exec(`RESET enable_bitmapscan`);
    const want = new Set(exact.rows.map((r) => r.id));
    const got = await db.query<{ id: string; metadata: { kind: string } }>(`SELECT id, metadata FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"c"}'::jsonb)`, [qv]);
    returned += got.rows.length;
    overlap += got.rows.filter((r) => want.has(r.id)).length;
    wrongKind += got.rows.filter((r) => r.metadata.kind !== "c").length;
  }
  assert(returned === 10 * QUERIES, `the walk returns 10 rows for each of ${QUERIES} queries (got ${returned})`);
  assert(wrongKind === 0, "…every one of them matching the filter");
  // HNSW is approximate; the iterative scan keeps it honest under the filter
  // but does not make it exact. Random vectors are its hardest case.
  assert(overlap >= 27, `…and at least 27 of the 30 are the exact top-10 (got ${overlap})`);
}

// ── 8d. Unscoreable rows do not count towards the walk threshold ─────────────
//
// A thought captured through the 2-arg fallback has no vector and no chunks. It
// matches a metadata filter but can never be a candidate on either side, so it
// must not push a filter over the exact threshold: routed to the walk, a filter
// whose scoreable matches are fewer than v_fetch runs to the scan bound and
// returns short (twelfth review pass). The walk is made to fail here on
// purpose — hnsw.max_scan_tuples clamped to its minimum for the session — so
// only the exact branch can return every scoreable row.

console.log("\n[8d] rows without a vector or chunks do not count towards the walk threshold");
{
  await db.exec(`DELETE FROM thoughts`);
  const { unitVector } = seededRandom(1018);
  // Enough indexed rows of another kind that a bounded walk cannot stumble on
  // the wanted ones by luck.
  for (let i = 0; i < 300; i += 100) {
    const values = Array.from({ length: 100 }, (_, k) => `('other ${i + k}', '{"kind":"o"}'::jsonb, '[${unitVector(EMBEDDING_DIM).join(",")}]'::vector)`).join(",");
    await db.exec(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  // 1,200 kind "u" rows with no vector (the fallback's shape), plus five with one.
  for (let i = 0; i < 1200; i += 200) {
    const values = Array.from({ length: 200 }, (_, k) => `('unscoreable ${i + k}', '{"kind":"u"}'::jsonb, NULL)`).join(",");
    await db.exec(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  for (let i = 0; i < 5; i++) {
    await db.query(`INSERT INTO thoughts (content, metadata, embedding) VALUES ($1, '{"kind":"u"}'::jsonb, $2::vector)`, [`scoreable ${i}`, `[${unitVector(EMBEDDING_DIM).join(",")}]`]);
  }
  const matching = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts WHERE metadata @> '{"kind":"u"}'`);
  assert(matching.rows[0].c === 1205, `1,205 rows match the filter, 1,200 of them unscoreable (got ${matching.rows[0].c})`);
  await db.exec(`SET hnsw.max_scan_tuples = 1`);
  const got = await db.query<{ content: string }>(`SELECT content FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"u"}'::jsonb)`, [`[${unitVector(EMBEDDING_DIM).join(",")}]`]);
  await db.exec(`RESET hnsw.max_scan_tuples`);
  assert(got.rows.length === 5, `all five scoreable rows come back through the exact branch (got ${got.rows.length}; a walk clamped to one tuple could not have found them)`);
  assert(got.rows.every((r) => r.content.startsWith("scoreable")), "…and only those");
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

// ── 15. Migration 015 — thought_work_claims ──────────────────────────────────
//
// The pool, the lease and the release, on one connection. PGlite has one
// session, so nothing here can be concurrent: two claims made in a row are
// disjoint whether or not FOR UPDATE SKIP LOCKED does anything, which is the
// exact false pass the ticket's Verify section names. The concurrent proof —
// workers overlapping in time, a lease held open across another worker's claim
// — is db/test-live.ts [8]. This section owns the state machine: expiry back to
// the pool, the attempt cap, who may release, the cascade.

console.log("\n[15] thought_work_claims: the pool, the lease, the release");
{
  await db.exec(`DELETE FROM thoughts`);
  for (let i = 0; i < 10; i++) {
    await db.query(`INSERT INTO thoughts (content) VALUES ($1)`, [`claim probe ${i}`]);
  }
  const JOB = "test:probe";
  const claim = async (worker: string, batch: number, ttl = 900, maxAttempts = 3) =>
    (await db.query<{ thought_id: string; attempt: number }>(
      `SELECT thought_id, attempt FROM claim_thoughts($1, $2, $3, $4, $5)`, [JOB, worker, batch, ttl, maxAttempts])).rows;
  const statusOf = async (id: string) =>
    (await db.query<{ status: string; attempt_count: number; worker_id: string | null; ttl: string | null; last_error: string | null }>(
      `SELECT status, attempt_count, worker_id, ttl_expires_at::text AS ttl, last_error FROM thought_work_claims WHERE thought_id = $1 AND work_type = $2`,
      [id, JOB])).rows[0];
  const raises = async (q: string, params: unknown[] = []): Promise<string> => {
    try { await db.query(q, params); return ""; } catch (e) { return (e as Error).message; }
  };

  // The pool.
  const first = await db.query<{ n: number }>(`SELECT enqueue_thoughts($1) AS n`, [JOB]);
  assert(first.rows[0].n === 10, `enqueue_thoughts with no ids pools every thought (got ${first.rows[0].n} of 10)`);
  const again = await db.query<{ n: number }>(`SELECT enqueue_thoughts($1) AS n`, [JOB]);
  assert(again.rows[0].n === 0, `…and a second call adds nothing (got ${again.rows[0].n})`);
  const ids = (await db.query<{ id: string }>(`SELECT id FROM thoughts ORDER BY created_at, id`)).rows.map((r) => r.id);
  const subset = await db.query<{ n: number }>(`SELECT enqueue_thoughts($1, $2::uuid[]) AS n`, ["test:subset", [ids[0], ids[1], ids[1]]]);
  assert(subset.rows[0].n === 2, `an explicit id list pools those ids once each under its own key (got ${subset.rows[0].n} of 2)`);
  assert(/violates foreign key/.test(await raises(`SELECT enqueue_thoughts($1, $2::uuid[])`, ["test:subset", ["00000000-0000-0000-0000-000000000001"]])),
         "an id that names no thought fails the foreign key rather than being skipped");
  assert(/must name the pass/.test(await raises(`SELECT enqueue_thoughts('')`)), "an empty work_type is refused");
  const pooled = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = $1 AND status = 'pending'`, [JOB])).rows[0].c;
  assert(pooled === 10, `ten pending rows under the key, none under the other key's count (got ${pooled})`);

  // The lease. Sequential here — see the section comment.
  const a = await claim("A", 4);
  assert(a.length === 4 && a.every((r) => r.attempt === 1), `A claims 4 rows on their first attempt (got ${a.length})`);
  const b = await claim("B", 4);
  const aIds = new Set(a.map((r) => r.thought_id));
  assert(b.length === 4 && b.every((r) => !aIds.has(r.thought_id)), "B's 4 rows are none of A's");
  const c = await claim("C", 4);
  assert(c.length === 2, `C gets the 2 that remain, not 4 (got ${c.length})`);
  assert((await claim("C", 4)).length === 0, "…and the pool is then empty");
  const held = await statusOf(a[0].thought_id);
  assert(held.status === "claimed" && held.worker_id === "A" && held.ttl !== null && held.attempt_count === 1,
         `a claimed row records status, holder, lease and attempt (${JSON.stringify(held)})`);
  assert(/must be positive/.test(await raises(`SELECT * FROM claim_thoughts($1, 'Z', 1, 0)`, [JOB])), "a non-positive TTL is refused, not stamped as already expired");
  assert(/must identify the worker/.test(await raises(`SELECT * FROM claim_thoughts($1, '', 1)`, [JOB])), "an empty worker id is refused");

  // Who may release.
  const notHolder = await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'B', 'succeeded') AS ok`, [a[0].thought_id, JOB]);
  assert(notHolder.rows[0].ok === false, "a worker that does not hold the lease cannot release it");
  assert((await statusOf(a[0].thought_id)).status === "claimed", "…and the row is still A's");
  assert(/must be succeeded or failed/.test(await raises(`SELECT release_thought($1, $2, 'A', 'done')`, [a[0].thought_id, JOB])), "a status outside the two terminal ones is refused");
  const holder = await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'A', 'succeeded') AS ok`, [a[0].thought_id, JOB]);
  assert(holder.rows[0].ok === true, "the holder releases it");
  const done = await statusOf(a[0].thought_id);
  assert(done.status === "succeeded" && done.ttl === null, "…to succeeded, with the lease cleared");
  const twice = await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'A', 'succeeded') AS ok`, [a[0].thought_id, JOB]);
  assert(twice.rows[0].ok === false, "…and a second release of the same row is false, not a second success");
  const failed = await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'A', 'failed', 'provider 500') AS ok`, [a[1].thought_id, JOB]);
  assert(failed.rows[0].ok === true && (await statusOf(a[1].thought_id)).last_error === "provider 500", "a failed release records the error");

  // Clean shutdown: B hands its four back, and they did not count as attempts.
  const freed = await db.query<{ n: number }>(`SELECT release_claims_for_worker($1, 'B') AS n`, [JOB]);
  assert(freed.rows[0].n === 4, `release_claims_for_worker returns B's 4 rows to the pool (got ${freed.rows[0].n})`);
  const bBack = await statusOf(b[0].thought_id);
  assert(bBack.status === "pending" && bBack.attempt_count === 0 && bBack.ttl === null, `…pending again at attempt 0 with no lease (${JSON.stringify(bBack)})`);
  assert((await db.query<{ n: number }>(`SELECT release_claims_for_worker($1, 'B') AS n`, [JOB])).rows[0].n === 0, "…and a second shutdown call finds nothing to return");

  // Expiry is enforced by the next claim, not merely recorded.
  const aRest = a.slice(2).map((r) => r.thought_id);   // A's two still-held rows
  await db.query(`UPDATE thought_work_claims SET ttl_expires_at = now() - interval '1 second' WHERE thought_id = ANY($1::uuid[]) AND work_type = $2`, [aRest, JOB]);
  const d = await claim("D", 10);
  const dById = new Map(d.map((r) => [r.thought_id, r.attempt]));
  assert(d.length === 6, `D receives A's 2 expired rows and B's 4 returned rows (got ${d.length})`);
  assert(aRest.every((id) => dById.get(id) === 2), "…A's expired rows on their second attempt");
  assert(b.every((r) => dById.get(r.thought_id) === 1), "…B's returned rows on their first");
  const aLate = await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'A', 'succeeded') AS ok`, [aRest[0], JOB]);
  assert(aLate.rows[0].ok === false, "A, finishing late, can no longer release a row D now holds");

  // The attempt cap: expired three times means failed, not a fourth lease.
  await db.query(`UPDATE thought_work_claims SET ttl_expires_at = now() - interval '1 second' WHERE thought_id = ANY($1::uuid[]) AND work_type = $2`, [aRest, JOB]);
  const e = await claim("E", 10);
  assert(e.length === 2 && e.every((r) => r.attempt === 3 && aRest.includes(r.thought_id)), `E gets the same 2 rows on their third attempt (got ${JSON.stringify(e)})`);
  await db.query(`UPDATE thought_work_claims SET ttl_expires_at = now() - interval '1 second' WHERE thought_id = ANY($1::uuid[]) AND work_type = $2`, [aRest, JOB]);
  const f = await claim("F", 10);
  assert(f.length === 0, `F gets nothing: the two rows have used their attempts and the rest are held (got ${f.length})`);
  const capped = await statusOf(aRest[0]);
  assert(capped.status === "failed" && /expired 3 times; last held by E/.test(capped.last_error ?? ""),
         `…they are failed, and the error names the count and the last holder (${JSON.stringify(capped)})`);
  // A looser cap is the caller's to choose.
  await db.query(`UPDATE thought_work_claims SET status = 'claimed', ttl_expires_at = now() - interval '1 second' WHERE thought_id = $1 AND work_type = $2`, [aRest[0], JOB]);
  const g = await claim("G", 10, 900, 10);
  assert(g.length === 1 && g[0].attempt === 4, "with p_max_attempts raised the same row is leased a fourth time");

  // The cascade, and the constraint that keeps status and lease in step.
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [c[0].thought_id]);
  const gone = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM thought_work_claims WHERE thought_id = $1`, [c[0].thought_id]);
  assert(gone.rows[0].n === 0, "deleting a thought takes its claim rows with it");
  const cLate = await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'C', 'succeeded') AS ok`, [c[0].thought_id, JOB]);
  assert(cLate.rows[0].ok === false, "…and the holder's release returns false rather than raising");
  assert(/check constraint/.test(await raises(`UPDATE thought_work_claims SET status = 'claimed', ttl_expires_at = NULL WHERE thought_id = $1 AND work_type = $2`, [c[1].thought_id, JOB])),
         "a claimed row without a lease is refused by the CHECK, so expiry cannot be lost by a stray write");

  const idx = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'thought_work_claims' ORDER BY 1`);
  const names = idx.rows.map((r) => r.indexname);
  assert(names.includes("thought_work_claims_status_idx") && names.includes("thought_work_claims_worker_idx"),
         `the reaper index and the per-worker partial index exist (${names.join(", ")})`);
  const pendingIdx = (await db.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'thought_work_claims_pending_idx'`)).rows[0]?.def ?? "";
  assert(/\(work_type, enqueued_at\)/.test(pendingIdx) && /WHERE \(status = 'pending'::text\)/.test(pendingIdx),
         `the claim's index is partial on pending rows and ordered by enqueued_at (${pendingIdx.replace(/^.*USING /, "")})`);
  // 015 must be the fork's shape: no DELETE anywhere, since expiry and clean
  // shutdown are UPDATEs and the record of a pass is meant to survive.
  const f015 = files.find((f) => f.startsWith("015"))!;
  const src015 = readFileSync(join(MIGRATIONS, f015), "utf8").replace(/--[^\n]*/g, "");
  // `ON DELETE CASCADE` on the foreign key is a clause, not a statement.
  assert(!/\bDELETE\s+FROM\b/i.test(src015), "015 contains no DELETE statement");

  await db.exec(`DELETE FROM thoughts`);
}

report();
