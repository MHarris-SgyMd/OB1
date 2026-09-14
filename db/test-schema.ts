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
  MATCH_THOUGHTS_SIGNATURE,
  UPDATE_THOUGHT_SIGNATURE,
  migrationValues,
  parseSetConfig,
  substituteMigration,
  DEFAULT_CHUNK_CONTEXT,
  resolveBackfillLimit,
} from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, seededRandom } from "./test-support.ts";
import { ENTITY_TYPES, RELATIONS } from "../server-portable/entities.ts";

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
    // backfillLimit pinned: the shell's OB1_BACKFILL_LIMIT must not change what
    // this suite applies ([24] asks for a batch by passing it explicitly).
    migrationValues({ dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, trgm, backfillLimit: null })
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

/** Re-apply one migration by prefix, as [1] applied it. */
async function reapply(prefix: string): Promise<string> {
  const f = files.find((x) => x.startsWith(prefix));
  if (!f) throw new Error(`no migration starts with ${prefix}`);
  await db.exec(subst(readFileSync(join(MIGRATIONS, f), "utf8")));
  return f;
}

/**
 * The migration that last defines a function, by reading the files rather
 * than naming one: a section that re-applies an OLD migration on purpose
 * ([8b] re-applies 014 to test its seeding; [20] re-applies 014 and 012 to
 * prove the bodies did not move) puts that migration's function back, and
 * must restore the shipped one for the sections after it. A hard-coded "019"
 * would keep reinstalling 019's function the day 020 redefines it, and every
 * later section would pass against a superseded body (first review pass).
 */
function lastDefinerOf(fn: string): string {
  // A statement at the start of a line, optionally schema-qualified — not a
  // header comment quoting one (those lines begin with `--`).
  const re = new RegExp(`^\\s*CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?${fn}\\(`, "m");
  const f = [...files].reverse().find((x) => re.test(readFileSync(join(MIGRATIONS, x), "utf8")));
  if (!f) throw new Error(`no migration defines ${fn}`);
  return f;
}
/** 016's rule, asked of the database rather than re-derived here; [19] and [24] each declared it. */
const fpOf = async (content: string) =>
  (await db.query<{ f: string }>(`SELECT content_fingerprint_of($1) AS f`, [content])).rows[0].f;
/** How many functions of this name the schema holds — the overload count, five sections ask it. */
const functionsNamed = async (name: string) =>
  (await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = $1 AND n.nspname = 'public'`, [name])).rows[0].c;
async function restoreShipped(...fns: string[]): Promise<string[]> {
  const latest = [...new Set(fns.map(lastDefinerOf))].sort();
  for (const f of latest) await db.exec(subst(readFileSync(join(MIGRATIONS, f), "utf8")));
  return latest;
}

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
    // 021: the model that produced `embedding`; NULL is unknown. See [22].
    embedding_model: "text",
    // 025: what this thought was derived from (array of source ids) and which
    // thought it replaces (self-FK). Both nullable. SMD-1253. See [25].
    derived_from: "jsonb",
    supersedes: "uuid",
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

  // 025 (SMD-1253): the two provenance indexes. derived_from is searched by
  // containment (find_derivatives, `@>`), so GIN; supersedes is a partial btree
  // over only the rows that point at a predecessor.
  assert(/USING gin/.test(byName["idx_thoughts_derived_from"] ?? ""), "idx_thoughts_derived_from is GIN");
  const sup = byName["idx_thoughts_supersedes"] ?? "";
  assert(sup !== "", "idx_thoughts_supersedes exists");
  assert(/WHERE \(supersedes IS NOT NULL\)/.test(sup), "…and is partial on supersedes IS NOT NULL");

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
  const prosrc = String((await db.query<{ s: string | null }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = '${MATCH_THOUGHTS_SIGNATURE}'::regprocedure`)).rows[0]?.s ?? "");
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
     WHERE oid = '${MATCH_THOUGHTS_SIGNATURE}'::regprocedure`
  );
  assert(
    /(^|,)hnsw\.iterative_scan=relaxed_order(,|$)/.test(cfg.rows[0]?.cfg ?? ""),
    `match_thoughts carries hnsw.iterative_scan=relaxed_order (proconfig: ${cfg.rows[0]?.cfg ?? "none"})`
  );
  // Two function-level SETs and no other: the scan mode (014) and the plan
  // setting 019 added after measuring the unfiltered branch at the shipped
  // width ([20] holds the rest of 019). The two walk bounds are deliberately
  // not on the function, because a function-level value would override the
  // database-level one that is the operator's tuning knob, and the plan mode
  // an earlier draft forced is unnecessary once the filter is a plain
  // predicate in its own branch.
  // Parsed as the array it is (parseSetConfig), not split on commas: a
  // list-valued setting such as search_path would break a split (tenth pass).
  const proconfig = parseSetConfig((await db.query<{ cfg: string[] | null }>(
    `SELECT proconfig AS cfg FROM pg_proc WHERE oid = '${MATCH_THOUGHTS_SIGNATURE}'::regprocedure`)).rows[0]?.cfg);
  assert(proconfig["enable_seqscan"] === "off", `…and enable_seqscan=off, 019's plan setting (proconfig: ${JSON.stringify(proconfig)})`);
  assert(!("hnsw.max_scan_tuples" in proconfig) && !("hnsw.scan_mem_multiplier" in proconfig) && !("plan_cache_mode" in proconfig), "…and nothing else — neither walk bound nor a forced plan mode");

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
  await reapply("014");
  assert((await dbSettings())["hnsw.max_scan_tuples"] === "250000", "re-applying 014 leaves an operator's database-level bound alone");
  // A ROLE-level value is not a reason to skip the seed: it reaches one role,
  // sits ABOVE the database level in precedence (so the seed cannot undo it),
  // and the ninth-pass guard let it suppress the seed for every other role.
  // Session-level SET stands in for ALTER ROLE here — PGlite has one role and
  // one session, and both report a non-shared source — so: clear the database
  // row, set the value in the session, re-apply, and the row must come back.
  await db.exec((await db.query<{ q: string }>(`SELECT format('ALTER DATABASE %I RESET hnsw.max_scan_tuples', current_database()) AS q`)).rows[0].q);
  await db.exec(`SET hnsw.max_scan_tuples = 5000`);
  await reapply("014");
  assert((await dbSettings())["hnsw.max_scan_tuples"] === String(HNSW_SEED_MAX_SCAN_TUPLES),
    "a value set only for this role/session does not stop 014 seeding the database-level default for everyone else");
  await db.exec(`RESET hnsw.max_scan_tuples`);
  await alterDb(`hnsw.max_scan_tuples = ${HNSW_SEED_MAX_SCAN_TUPLES}`);
  // Re-applying 014 also put 014's match_thoughts back — CREATE OR REPLACE
  // rewrites the whole definition, clauses included, which is the trap [20]
  // reproduces on purpose. Restore the shipped function for the sections after.
  const restored = await restoreShipped("match_thoughts");
  assert(restored.length === 1 && restored[0] > "014_", `…and the shipped definition is restored from ${restored.join(", ")}, a migration after 014`);
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

// ── 16. Migration 016 — entities, mentions, edges, and the trigger ───────────
//
// The resolution rule, the atomic write, the human merge, and the trigger that
// feeds the pool — everything except the model call, which db/test-live.ts [10]
// drives through the worker against a stub. The vocabulary in the CHECK
// constraints is compared to the one server-portable/entities.ts parses
// against, so the two cannot disagree about what an entity type is.

console.log("\n[16] entities, mentions and edges: the rule, the write, the merge, the trigger");
{
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_config WHERE key = 'entity_extraction_key'`);
  const KEY = "extract:stub@p1";
  const norm = async (s: string) => (await db.query<{ n: string | null }>(`SELECT normalize_entity_name($1) AS n`, [s])).rows[0].n;
  const record = async (id: string, entities: unknown[], relations: unknown[] = [], fp: string | null = null) =>
    (await db.query<{ r: Record<string, unknown> }>(
      `SELECT record_thought_entities($1::uuid, $2, $3::jsonb, $4::jsonb, $5::text, NULL::uuid) AS r`,
      [id, KEY, JSON.stringify(entities), JSON.stringify(relations), fp])).rows[0].r;
  const thought = async (content: string) =>
    (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, '{}'::jsonb) AS r`, [content])).rows[0].r.id;
  const entities = async () =>
    (await db.query<{ id: string; entity_type: string; name: string; normalized_name: string; aliases: string[] }>(
      `SELECT id, entity_type, name, normalized_name, aliases FROM ob1_entities ORDER BY entity_type, normalized_name`)).rows;
  const count = async (table: string, where = "true", params: unknown[] = []) =>
    (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`, params)).rows[0].c;

  // The rule.
  assert((await norm("  Postgres ")) === "postgres", "the rule lower-cases and trims");
  assert((await norm("PostgreSQL")) === "postgresql", "…and PostgreSQL is a different name — the rule does not guess at abbreviations");
  assert((await norm(`"Anita",`)) === "anita", "…strips surrounding quotes and punctuation");
  assert((await norm("Open   Brain\n")) === "open brain", "…collapses internal whitespace");
  assert((await norm("ﬁle")) === "file", "…and applies NFKC, so a ligature is its letters");
  assert((await norm("Ana Lúcia")) === "ana lúcia", "…without stripping accents, which are part of a name");
  assert((await norm("clinician-portal")) === "clinician portal" && (await norm("state_of_care")) === "state of care",
         "…and reads hyphen and underscore as spaces, which the corpus run found were most of the near-duplicates");
  assert((await norm("siggymd/infrastructure")) === "siggymd infrastructure" && (await norm("platform PR #469")) === "platform pr 469",
         "…and slash likewise, with # stripped");
  assert((await norm("...")) === null, "a name that is only punctuation normalises to NULL and cannot be an entity");

  // The vocabulary, in the constraints and in the module.
  const cons = (await db.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid IN ('ob1_entities'::regclass, 'ob1_entity_edges'::regclass) AND contype = 'c'`)).rows;
  const typeCheck = cons.find((c) => /entity_type/.test(c.def))?.def ?? "";
  const relCheck = cons.find((c) => /relation/.test(c.def))?.def ?? "";
  assert(ENTITY_TYPES.every((t) => typeCheck.includes(`'${t}'`)) && (typeCheck.match(/'[a-z_]+'/g) ?? []).length === ENTITY_TYPES.length,
         `the entity_type CHECK lists exactly the module's ${ENTITY_TYPES.length} types`);
  assert(RELATIONS.every((r) => relCheck.includes(`'${r}'`)) && (relCheck.match(/'[a-z_]+'/g) ?? []).length === RELATIONS.length,
         `the relation CHECK lists exactly the module's ${RELATIONS.length} relations`);

  // The write.
  const a = await thought("Anita migrated Open Brain to PostgreSQL.");
  const r1 = await record(a, [
    { name: "Anita", type: "person", confidence: 0.9 },
    { name: "PostgreSQL", type: "tool", confidence: 0.95, aliases: ["Postgres", "PostgreSQL"] },
    { name: "Open Brain", type: "project", confidence: 0.8 },
    { name: "carrot", type: "vegetable", confidence: 0.9 },
    { name: "", type: "person", confidence: 0.9 },
    { name: "open  brain", type: "project", confidence: 0.4 },
  ], [
    { from: "Anita", to: "PostgreSQL", relation: "uses", confidence: 0.8 },
    { from: "Open Brain", to: "PostgreSQL", relation: "depends_on", confidence: 0.7 },
    { from: "PostgreSQL", to: "Anita", relation: "co_occurs_with", confidence: 0.6 },
    { from: "Anita", to: "Redis", relation: "uses", confidence: 0.9 },
    { from: "Anita", to: "PostgreSQL", relation: "loves", confidence: 0.9 },
  ]);
  assert(r1.ok === true && r1.entities === 3 && r1.new_entities === 3, `three valid entities written, the unknown type and the empty name dropped (${JSON.stringify(r1)})`);
  assert(r1.mentions === 3 && r1.edges === 3, "…three mentions and three edges");
  assert(r1.dropped_relations === 1, "…the relation to an entity the model did not list is dropped and counted; an unknown relation is simply not one");
  const pg = (await entities()).find((e) => e.normalized_name === "postgresql")!;
  assert(pg.name === "PostgreSQL" && pg.aliases.length === 1 && pg.aliases[0] === "Postgres",
         `the entity keeps the name as given and the alias, minus the alias that equals the name (${JSON.stringify(pg.aliases)})`);
  const sym = (await db.query<{ ok: boolean }>(
    `SELECT from_entity_id < to_entity_id AS ok FROM ob1_entity_edges WHERE relation = 'co_occurs_with'`)).rows;
  assert(sym.length === 1 && sym[0].ok === true, "a symmetric relation is stored with from < to");

  // Idempotent.
  const before = await entities();
  const r2 = await record(a, [
    { name: "Anita", type: "person", confidence: 0.9 },
    { name: "PostgreSQL", type: "tool", confidence: 0.95, aliases: ["Postgres"] },
    { name: "Open Brain", type: "project", confidence: 0.8 },
  ], [
    { from: "Anita", to: "PostgreSQL", relation: "uses", confidence: 0.8 },
    { from: "Open Brain", to: "PostgreSQL", relation: "depends_on", confidence: 0.7 },
    { from: "Anita", to: "PostgreSQL", relation: "co_occurs_with", confidence: 0.6 },
  ]);
  assert(r2.new_entities === 0 && r2.mentions === 3 && r2.edges === 3 && r2.pruned_entities === 0, `the same extraction again creates nothing (${JSON.stringify(r2)})`);
  const after = await entities();
  assert(JSON.stringify(after) === JSON.stringify(before), "…and the entities are byte-identical, ids included");
  assert((await count("thought_entities")) === 3 && (await count("ob1_entity_edges")) === 3, "…with the same three mentions and three edges");

  // Two spellings the rule keeps apart, and one it does not.
  const b = await thought("Dev likes postgres, and Postgresql too.");
  const r3 = await record(b, [
    { name: "Dev", type: "person", confidence: 0.9 },
    { name: "postgres", type: "tool", confidence: 0.7 },
    { name: "Postgresql", type: "tool", confidence: 0.7 },
  ]);
  assert(r3.new_entities === 2, `"postgres" is a NEW entity — the rule does not merge abbreviations — while "Postgresql" resolves to the existing one (${r3.new_entities} new)`);
  const pg2 = (await entities()).find((e) => e.normalized_name === "postgresql")!;
  assert(pg2.name === "PostgreSQL" && pg2.aliases.includes("Postgresql") && pg2.aliases.includes("Postgres"),
         `the existing entity keeps its name and gains the new spelling as an alias (${JSON.stringify(pg2.aliases)})`);

  // Re-extraction replaces, and prunes what nothing mentions any more.
  const r4 = await record(a, [{ name: "Anita", type: "person", confidence: 0.9 }]);
  assert(r4.mentions === 1 && r4.edges === 0 && r4.pruned_entities === 1,
         `re-extracting thought A with one entity leaves it one mention, no edges, and prunes "Open Brain", which nothing else mentioned (${JSON.stringify(r4)})`);
  assert((await entities()).some((e) => e.normalized_name === "postgresql"), "…while PostgreSQL survives on thought B's mention");
  assert((await count("ob1_entity_edges", "thought_id = $1", [a])) === 0, "…and A's edges are gone");

  // The content guard.
  const [{ fp }] = (await db.query<{ fp: string }>(`SELECT content_fingerprint AS fp FROM thoughts WHERE id = $1`, [a])).rows;
  const stale = await record(a, [{ name: "Ghost", type: "person", confidence: 0.9 }], [], "0000");
  assert(stale.ok === false && stale.stale === true, "a fingerprint that no longer matches is refused as stale, and nothing is written");
  assert(!(await entities()).some((e) => e.normalized_name === "ghost"), "…so the stale extraction's entity does not exist");
  const fresh = await record(a, [{ name: "Anita", type: "person", confidence: 0.9 }], [], fp);
  assert(fresh.ok === true, "…and the matching fingerprint is accepted");
  const missing = await record("00000000-0000-0000-0000-000000000001", [{ name: "x", type: "person", confidence: 0.9 }]);
  assert(missing.ok === false && missing.error === "NOT_FOUND", "an unknown thought is NOT_FOUND, not an insert");
  // A row with no fingerprint column value — pre-003, or loaded around
  // upsert_thought — must not leave the guard silent: both sides compute it.
  const bare = (await db.query<{ id: string }>(`INSERT INTO thoughts (content) VALUES ('legacy row, no fingerprint') RETURNING id`)).rows[0].id;
  const [{ computed }] = (await db.query<{ computed: string }>(`SELECT content_fingerprint_of('legacy row, no fingerprint') AS computed`)).rows;
  assert((await record(bare, [{ name: "Legacy", type: "topic", confidence: 0.9 }], [], computed)).ok === true, "a NULL-fingerprint row accepts the fingerprint computed from its content");
  await db.query(`UPDATE thoughts SET content = 'legacy row, edited' WHERE id = $1`, [bare]);
  const legacyStale = await record(bare, [{ name: "Legacy", type: "topic", confidence: 0.9 }], [], computed);
  assert(legacyStale.ok === false && legacyStale.stale === true, "…and refuses the old one after an edit, though the column is still NULL");
  // One name under two types: the endpoint choice is deterministic and counted.
  const amb = await thought("Sentry the company and Sentry the tool");
  const rAmb = await record(amb, [
    { name: "Sentry", type: "tool", confidence: 0.9 }, { name: "Sentry", type: "organization", confidence: 0.9 }, { name: "Open Brain", type: "project", confidence: 0.9 },
  ], [{ from: "Open Brain", to: "Sentry", relation: "uses", confidence: 0.8 }]);
  assert(rAmb.edges === 1 && rAmb.ambiguous_relations === 1, `a relation to a name the model listed under two types is stored once and counted ambiguous (${JSON.stringify(rAmb)})`);
  const picked = (await db.query<{ t: string }>(`SELECT e.entity_type AS t FROM ob1_entity_edges g JOIN ob1_entities e ON e.id = g.to_entity_id WHERE g.thought_id = $1`, [amb])).rows[0].t;
  assert(picked === "organization", `…attached to the organization by the fixed type order, not heap order (${picked})`);
  // The entity side of the keys restricts: a referenced entity cannot be
  // deleted out from under its mentions, which is what makes the prune safe.
  let fk = "";
  try { await db.query(`DELETE FROM ob1_entities WHERE normalized_name = 'sentry' AND entity_type = 'organization'`); } catch (e) { fk = (e as Error).message; }
  assert(/foreign key/.test(fk), "deleting an entity that a mention or edge references is refused by the foreign key");
  await db.query(`DELETE FROM thoughts WHERE id IN ($1, $2)`, [bare, amb]);
  await db.query(`SELECT prune_orphan_entities()`);
  let raised = "";
  try { await db.query(`SELECT record_thought_entities($1::uuid, $2, '{"a":1}'::jsonb)`, [a, KEY]); } catch (e) { raised = (e as Error).message; }
  assert(/must be a JSON array/.test(raised), "a non-array p_entities raises rather than writing nothing quietly");

  // The human merge.
  const es = await entities();
  const postgres = es.find((e) => e.normalized_name === "postgres")!;
  const postgresql = es.find((e) => e.normalized_name === "postgresql")!;
  const dev = es.find((e) => e.normalized_name === "dev")!;
  const mismatch = (await db.query<{ r: Record<string, unknown> }>(`SELECT merge_entities($1::uuid, $2::uuid) AS r`, [dev.id, postgres.id])).rows[0].r;
  assert(mismatch.ok === false && mismatch.error === "TYPE_MISMATCH", "merging a tool into a person is refused");
  const same = (await db.query<{ r: Record<string, unknown> }>(`SELECT merge_entities($1::uuid, $1::uuid) AS r`, [postgresql.id])).rows[0].r;
  assert(same.ok === false && same.error === "SAME_ENTITY", "…as is merging an entity into itself");
  const merged = (await db.query<{ r: Record<string, unknown> }>(`SELECT merge_entities($1::uuid, $2::uuid) AS r`, [postgresql.id, postgres.id])).rows[0].r;
  assert(merged.ok === true && merged.mentions_moved === 0, `merging "postgres" into PostgreSQL: thought B already mentions the survivor, so no mention moves (${JSON.stringify(merged)})`);
  const survivor = (await entities()).find((e) => e.normalized_name === "postgresql")!;
  assert(!(await entities()).some((e) => e.normalized_name === "postgres") && survivor.aliases.includes("postgres"),
         `the loser is gone and its name is an alias of the survivor (${JSON.stringify(survivor.aliases)})`);
  assert((await count("thought_entities", "thought_id = $1", [b])) === 2, "thought B now mentions Dev and PostgreSQL, once each");
  // The merge survives the next extraction: the model saying "postgres" again
  // resolves to the survivor instead of re-creating the loser.
  const rAfterMerge = await record(b, [{ name: "Dev", type: "person", confidence: 0.9 }, { name: "postgres", type: "tool", confidence: 0.8 }, { name: "PostgreSQL", type: "tool", confidence: 0.9 }]);
  assert(rAfterMerge.new_entities === 0 && rAfterMerge.mentions === 2, `re-extracting B with "postgres" creates nothing and mentions two entities (${JSON.stringify(rAfterMerge)})`);
  assert(!(await entities()).some((e) => e.normalized_name === "postgres"), "…the merged-away name is not re-created");
  const [{ mf }] = (await db.query<{ mf: string[] }>(`SELECT merged_from AS mf FROM ob1_entities WHERE id = $1`, [survivor.id])).rows;
  assert(mf.includes("postgres"), `…because the survivor remembers it in merged_from (${JSON.stringify(mf)})`);

  // Delete: cascade, and the orphan it leaves.
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [b]);
  assert((await count("thought_entities", "thought_id = $1", [b])) === 0 && (await count("ob1_entity_edges", "thought_id = $1", [b])) === 0,
         "deleting a thought takes its mentions and edges with it");
  assert((await entities()).some((e) => e.normalized_name === "dev"), "…and leaves the entity it alone introduced, orphaned");
  const pruned = (await db.query<{ n: number }>(`SELECT prune_orphan_entities() AS n`)).rows[0].n;
  assert(pruned === 2 && !(await entities()).some((e) => e.normalized_name === "dev"), `prune_orphan_entities removes Dev and PostgreSQL, which nothing mentions now (${pruned})`);

  // The trigger: silent until the key is set, then feeding the pool.
  const c = await thought("captured before anyone asked for extraction");
  assert((await count("thought_work_claims", "thought_id = $1", [c])) === 0, "with no extraction key recorded, a capture enqueues nothing");
  await db.query(`INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', $1)`, [KEY]);
  const d = await thought("captured after the key was set");
  const dRow = async () => (await db.query<{ status: string; worker_id: string | null; attempt_count: number }>(
    `SELECT status, worker_id, attempt_count FROM thought_work_claims WHERE thought_id = $1 AND work_type = $2`, [d, KEY])).rows[0];
  assert((await dRow())?.status === "pending", "with the key set, a capture is enqueued under it");
  assert((await count("thought_work_claims", "thought_id = $1", [c])) === 0, "…and the earlier capture is not — the worker's enqueue_thoughts pools the backlog");
  await db.query(`UPDATE thoughts SET metadata = '{"x":1}'::jsonb WHERE id = $1`, [d]);
  assert((await dRow()).status === "pending" && (await count("thought_work_claims", "thought_id = $1", [d])) === 1, "a metadata-only edit changes nothing in the pool");
  const claimed = (await db.query<{ thought_id: string }>(`SELECT thought_id FROM claim_thoughts($1, 'W', 10)`, [KEY])).rows;
  assert(claimed.length === 1 && (await dRow()).status === "claimed", "a worker takes the lease");
  // Through update_thought, so the fingerprint follows the content: a raw
  // UPDATE would leave the old fingerprint, and the re-capture below would
  // then INSERT a new thought instead of taking the ON CONFLICT branch — and
  // the assertion about that branch would be reading the wrong row.
  await db.query(`SELECT update_thought($1::uuid, 'edited while a worker held it')`, [d]);
  const revoked = await dRow();
  assert(revoked.status === "pending" && revoked.worker_id === null && revoked.attempt_count === 0,
         `a content edit under a live lease sets the claim back to pending and revokes the lease (${JSON.stringify(revoked)})`);
  const late = (await db.query<{ ok: boolean }>(`SELECT release_thought($1::uuid, $2, 'W', 'succeeded') AS ok`, [d, KEY])).rows[0].ok;
  assert(late === false, "…so the worker's release returns false and the new text will be extracted");
  await db.query(`UPDATE thought_work_claims SET status = 'succeeded' WHERE thought_id = $1 AND work_type = $2`, [d, KEY]);
  const thoughtsBefore = await count("thoughts");
  const recaptured = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought('edited while a worker held it', '{"metadata":{"again":true}}'::jsonb) AS r`)).rows[0].r.id;
  assert(recaptured === d && (await count("thoughts")) === thoughtsBefore, "the re-capture took the ON CONFLICT branch onto the same thought");
  assert((await dRow()).status === "succeeded", "…and did not re-enqueue it");
  await db.query(`SELECT update_thought($1::uuid, 'edited again')`, [d]);
  assert((await dRow()).status === "pending", "…while a real content change re-enqueues a succeeded thought");

  await db.exec(`DELETE FROM ob1_config WHERE key = 'entity_extraction_key'`);
  await db.exec(`DELETE FROM thoughts`);
}

// ── 17. Migration 017 — the needle rule, then the fusion ─────────────────────
//
// Two functions. `extract_search_needles` decides what the keyword arm is asked
// for; `search_thoughts_hybrid` fuses that arm with match_thoughts. The header
// makes claims about both that a query can check, and this section checks them
// with rows whose vectors are at known angles, as [8] does.

console.log("\n[17] extract_search_needles picks literals and identifiers, not words");
{
  const needles = async (q: string) =>
    (await db.query<{ n: string[] }>(`SELECT extract_search_needles($1) AS n`, [q])).rows[0].n;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const cases: [string, string[], string][] = [
    ["the scheduler timeout around ERR_POSTGRES_SERVER_ERROR", ["ERR_POSTGRES_SERVER_ERROR"], "an underscored identifier inside a sentence"],
    ["what did we decide about SMD-944?", ["SMD-944"], "a ticket key with its sentence punctuation stripped"],
    ["SMD-944.", ["SMD-944"], "a trailing full stop is not part of the needle"],
    ["edit db/config.mjs and getUserById", ["db/config.mjs", "getUserById"], "a path and an interior capital"],
    ['"App Store" launch in the UI', ["App Store"], "a double-quoted span, as written, ahead of everything else"],
    ["`upsert_thought` overloads", ["upsert_thought"], "a backticked span"],
    ['"connection to server failed with ERR_POSTGRES_SERVER_ERROR after 30 seconds of waiting for it" happened again', ["ERR_POSTGRES_SERVER_ERROR"], "a quoted span too long to be a needle still yields the identifiers inside it"],
    ['"App Store" and "App Store" twice', ["App Store"], "an accepted span is blanked before the identifier pass and de-duplicated"],
    ["released in 2024 for 12 users", [], "bare numbers are not identifiers"],
    ["pgvector 0.8.6 or later", ["0.8.6"], "a dotted version is"],
    ["v2 of the API", [], "two characters cannot reach the trigram index and are not asked for"],
    ["e.g. the scheduler timeout, i.e. the U.S. one at 3 p.m.", [], "abbreviations are not identifiers: a dotted token needs two characters together somewhere"],
    ["read a.b.cd and x/yz", ["a.b.cd", "x/yz"], "…and one with a two-character run is"],
    ["the 1st meeting at 3pm took 24h and was 10x slower than the 2nd", [], "ordinals and units are words, not identifiers"],
    ['what is "the" plan for Q3 and "and so"', [], "a quoted span of stopwords only is not a needle"],
    ['"the plan" for Q3', ["the plan"], "…while a quoted span with a content word is"],
    ["plain english words only here", [], "ordinary words are left to the vector arm"],
    ["SMD-944 and smd-944 again SMD-944", ["SMD-944"], "de-duplicated case-insensitively, first spelling kept"],
    ["a1x b2x c3x d4x e5x f6x g7x h8x i9x j0x", ["a1x", "b2x", "c3x", "d4x", "e5x", "f6x", "g7x", "h8x"], "capped at eight, in order"],
    ["", [], "an empty query yields nothing"],
  ];
  for (const [q, want, why] of cases) {
    const got = await needles(q);
    assert(same(got, want), `${why}: ${JSON.stringify(q)} → ${JSON.stringify(got)}${same(got, want) ? "" : `, wanted ${JSON.stringify(want)}`}`);
  }
  const nul = await db.query<{ n: string[] }>(`SELECT extract_search_needles(NULL) AS n`);
  assert(Array.isArray(nul.rows[0].n) && nul.rows[0].n.length === 0, "a NULL query yields an empty array, not NULL");
}

console.log("\n[17b] search_thoughts_hybrid: exact hits, the vector arm, and the gate between them");
{
  await db.exec(`DELETE FROM thoughts`);
  // Vectors at known angles to the query unit(0). The literal SMD-507 sits in
  // the two rows the embedding ranks LAST — the situation 012 measured — and
  // one of those has no vector at all.
  await db.query(`SELECT upsert_thought('exact match about the scheduler', '{"metadata":{"kind":"a"}}'::jsonb, $1::vector)`, [unit(0)]);
  await db.query(`SELECT upsert_thought('near match about timeouts', '{"metadata":{"kind":"a"}}'::jsonb, $1::vector)`, [blend(0, 1, 0.9, 0.44)]);
  await db.query(`SELECT upsert_thought('distant note that names SMD-507 and getUserById', '{"metadata":{"kind":"b"}}'::jsonb, $1::vector)`, [unit(1)]);
  await db.query(`SELECT upsert_thought('unembedded note that names SMD-507 too', '{"metadata":{"kind":"b"}}'::jsonb)`);
  type Row = { content: string; similarity: number | null; matched_needles: string[]; needles: string[]; needle_counts: number[]; common_needles: string[]; literal_only: boolean; score: number };
  const hybrid = async (q: string, threshold = 0.0, n = 10, filter = "{}") =>
    (await db.query<Row>(`SELECT content, similarity, matched_needles, needles, needle_counts, common_needles, literal_only, score FROM search_thoughts_hybrid($1::vector, $2, $3, $4, $5::jsonb)`, [unit(0), q, threshold, n, filter])).rows;
  const contents = (rows: Row[]) => rows.map((r) => r.content);

  // No needle: match_thoughts, row for row. This is the guarantee the header
  // makes for every query without an identifier, at the threshold too.
  for (const th of [0.0, 0.5, -1.0]) {
    const mt = (await db.query<{ content: string; similarity: number }>(`SELECT content, similarity FROM match_thoughts($1::vector, $2, 10, '{}'::jsonb)`, [unit(0), th])).rows;
    const hy = await hybrid("what happened with the scheduler", th);
    assert(contents(hy).join("|") === mt.map((r) => r.content).join("|"),
           `with no needle the fused result is match_thoughts' result at threshold ${th} (${contents(hy).join(", ")})`);
    assert(hy.every((r, i) => Math.abs((r.similarity ?? -9) - mt[i].similarity) < 1e-9), "…with the same similarities");
    assert(hy.every((r) => r.needles.length === 0 && r.matched_needles.length === 0 && r.literal_only === false), "…and no needles reported");
  }
  const noNeedle = await hybrid("what happened with the scheduler", 0.0);
  assert(noNeedle.length >= 2 && noNeedle[0].score > noNeedle[1].score, "the score is strictly monotone in the vector rank");

  // An identifier alone: the gate. The exact hits come first — the one with a
  // vector before the one without — then the vector arm's rows by similarity.
  const alone = await hybrid("SMD-507", 0.0);
  assert(alone.every((r) => r.literal_only === true), "an identifier alone is literal-only");
  assert(contents(alone).join("|") === "distant note that names SMD-507 and getUserById|unembedded note that names SMD-507 too|exact match about the scheduler|near match about timeouts",
         `exact hits first, the unembedded one second, then the vector arm (${contents(alone).join(" | ")})`);
  assert(alone[0].matched_needles.join() === "SMD-507" && alone[1].similarity === null && alone[2].matched_needles.length === 0, "…each row says why it is there");
  assert(Math.abs(alone[0].score - 1 / 61) < 1e-9 && alone[2].score === 0, "…exact presence is worth a rank-1 hit; the vector arm's rank is not scored");
  // The gate survives a second spelling and a needle that prefixes another:
  // both used to leave fragments in the residual that the parser kept.
  assert((await hybrid("SMD-507 smd-507", 0.0)).every((r) => r.literal_only === true), "a second spelling of the same literal leaves nothing to embed");
  assert((await hybrid("SMD-507 SMD-5070", 0.0)).every((r) => r.literal_only === true), "a literal that is a prefix of another leaves nothing to embed");
  // A needle no thought contains is still a needle — asked for, complete with
  // zero rows — and boosts nothing, so the result is match_thoughts' result.
  const nohit = await hybrid("the scheduler and SMD-999", 0.0);
  assert(nohit.every((r) => r.needles.join() === "SMD-999" && r.common_needles.length === 0 && r.matched_needles.length === 0), "a zero-hit needle is reported as searched for, not as common, and matches no row");
  assert(nohit.every((r) => r.needle_counts.join() === "0"), "…with a count of 0, which is how the tool tells absent from truncated");
  assert(alone.every((r) => r.needle_counts.join() === "2"), "a needle in two thoughts reports 2 on every row");
  // Truncation is not absence: with room for one row, the second exact hit is
  // cut, and the count is what says it exists.
  const one = await hybrid("SMD-507", 0.0, 1);
  assert(one.length === 1 && one[0].matched_needles.join() === "SMD-507" && one[0].needle_counts.join() === "2", `a page of one still reports the needle's count of 2 (${JSON.stringify(one[0]?.needle_counts)})`);
  assert(contents(nohit).join("|") === contents(noNeedle).join("|"), "…and the order is the vector arm's");
  // …and the threshold does not remove an exact hit whatever its similarity.
  const strict = await hybrid("SMD-507", 0.99);
  assert(contents(strict).join("|") === "distant note that names SMD-507 and getUserById|unembedded note that names SMD-507 too|exact match about the scheduler",
         `at threshold 0.99 the two exact hits stay and only the 1.0 vector row joins them (${contents(strict).join(" | ")})`);

  // A mixed query: the row both arms return outranks any row only one returns.
  const mixed = await hybrid("the scheduler problem in SMD-507", 0.0);
  assert(mixed.every((r) => r.literal_only === false), "a query with a content word left is not literal-only");
  assert(mixed[0].content === "distant note that names SMD-507 and getUserById", `the row in both arms comes first (${contents(mixed).join(" | ")})`);
  assert(Math.abs(mixed[0].score - (1 / 61 + 1 / 63)) < 1e-9, "…scored as presence plus its vector rank of 3");
  assert(mixed[1].content === "exact match about the scheduler", "the vector arm's top row is next…");
  assert(mixed[2].content === "unembedded note that names SMD-507 too", "…tied on score with the unembedded exact hit, which its similarity places after it");

  // Two needles beat one.
  const two = await hybrid("the scheduler problem in SMD-507 with getUserById", 0.0);
  assert(two[0].matched_needles.join() === "SMD-507,getUserById" && Math.abs(two[0].score - (2 / 61 + 1 / 63)) < 1e-9, "a row containing both literals scores both");

  // A needle in more than 100 thoughts is a word, and is reported, not used.
  for (let i = 0; i < 101; i++) {
    await db.query(`SELECT upsert_thought($1, '{"metadata":{"kind":"c"}}'::jsonb, $2::vector)`, [`filler ${i} mentions TOKEN_99 in passing`, unit(2)]);
  }
  const common = await hybrid("the scheduler and TOKEN_99", 0.0);
  assert(common.every((r) => r.common_needles.join() === "TOKEN_99" && r.needles.length === 0), `TOKEN_99 is reported as common on every row (${JSON.stringify(common[0]?.common_needles)})`);
  assert(common.every((r) => r.matched_needles.length === 0), "…and boosts nothing");
  assert(common[0].content === "exact match about the scheduler", "…so the vector arm's order stands");
  // The gate counts an extracted-but-common needle as a literal: with nothing
  // else in the query there is still nothing to embed.
  const onlyCommon = await hybrid("TOKEN_99", 0.0);
  assert(onlyCommon.every((r) => r.literal_only === true) && onlyCommon[0].content === "exact match about the scheduler",
         "a query that is only a common literal is literal-only, and falls back to similarity order");
  await db.exec(`DELETE FROM thoughts WHERE content LIKE 'filler %'`);

  // The probe that decides "common" before paging escapes its pattern as 012
  // does: 101 rows carry TOKEN-77, which only an unescaped '%TOKEN_77%' would
  // match, and one row carries TOKEN_77 itself. The needle must be used, with a
  // count of one, not dropped as common.
  for (let i = 0; i < 101; i++) {
    await db.query(`SELECT upsert_thought($1, '{"metadata":{"kind":"c"}}'::jsonb, $2::vector)`, [`decoy ${i} mentions TOKEN-77 in passing`, unit(2)]);
  }
  await db.query(`SELECT upsert_thought('the real TOKEN_77 row', '{"metadata":{"kind":"c"}}'::jsonb, $1::vector)`, [unit(2)]);
  const escaped = await hybrid("the scheduler and TOKEN_77", 0.0);
  assert(escaped.every((r) => r.needles.join() === "TOKEN_77" && r.needle_counts.join() === "1" && r.common_needles.length === 0),
         `the probe's escaped pattern ignores 101 decoys and finds the one real row (${JSON.stringify(escaped[0]?.needles)} ${JSON.stringify(escaped[0]?.needle_counts)} ${JSON.stringify(escaped[0]?.common_needles)})`);
  // Its own vector is orthogonal and 101 decoys tie it there, so it is outside
  // the vector window: keyword-only, tied with the vector's top row on score,
  // second on the similarity tiebreak — present, and the only row matched.
  assert(escaped.filter((r) => r.matched_needles.length).map((r) => r.content).join() === "the real TOKEN_77 row" && escaped.slice(0, 2).some((r) => r.content === "the real TOKEN_77 row"),
         `…and that row is the one exact hit, within the first two (${contents(escaped).slice(0, 3).join(" | ")})`);
  await db.exec(`DELETE FROM thoughts WHERE content LIKE 'decoy %' OR content = 'the real TOKEN_77 row'`);

  // The filter reaches both arms.
  const filtered = await hybrid("SMD-507", 0.0, 10, '{"kind":"a"}');
  assert(contents(filtered).join("|") === "exact match about the scheduler|near match about timeouts", `a filter excluding the exact hits removes them from the keyword arm too (${contents(filtered).join(" | ")})`);
  const filteredB = await hybrid("the scheduler problem in SMD-507", 0.0, 10, '{"kind":"b"}');
  assert(contents(filteredB).join("|") === "distant note that names SMD-507 and getUserById|unembedded note that names SMD-507 too", `…and one keeping them removes the vector-only rows (${contents(filteredB).join(" | ")})`);

  // The clamps: match_count 0 and 1000 land inside 1–100; NULL text is no needle.
  assert((await hybrid("SMD-507", 0.0, 0)).length === 1, "match_count 0 is clamped to 1");
  assert((await hybrid("SMD-507", 0.0, 1000)).length === 4, "match_count 1000 is clamped to 100, which here is every row");
  const nulText = await db.query<{ content: string }>(`SELECT content FROM search_thoughts_hybrid($1::vector, NULL, 0.0, 10, '{}'::jsonb)`, [unit(0)]);
  assert(nulText.rows.length === 2 && nulText.rows[0].content === "exact match about the scheduler", "a NULL query text is match_thoughts' answer");
  const nulThreshold = await db.query<{ content: string }>(`SELECT content FROM search_thoughts_hybrid($1::vector, 'the scheduler', NULL, 10, '{}'::jsonb)`, [unit(0)]);
  assert(nulThreshold.rows.map((r) => r.content).join("|") === contents(await hybrid("the scheduler", 0.7)).join("|"), "a NULL threshold is the default 0.7, not a filter that drops every vector row");

  await db.exec(`DELETE FROM thoughts`);
}

console.log("\n[18] Migration 017 left upsert_thought, match_thoughts and search_thoughts_keyword alone");
{
  assert((await functionsNamed("upsert_thought")) === 3, "all three upsert_thought overloads survive");
  assert((await functionsNamed("match_thoughts")) === 1, "match_thoughts is untouched and unduplicated");
  assert((await functionsNamed("search_thoughts_keyword")) === 1, "search_thoughts_keyword is untouched and unduplicated");
  assert((await functionsNamed("search_thoughts_hybrid")) === 1 && (await functionsNamed("extract_search_needles")) === 1, "017 adds exactly its two functions");
  const vol = await db.query<{ p: string; v: string }>(
    `SELECT p.proname AS p, p.provolatile AS v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname IN ('search_thoughts_hybrid', 'extract_search_needles') AND n.nspname = 'public'`);
  const byName = Object.fromEntries(vol.rows.map((r) => [r.p, r.v]));
  assert(byName.search_thoughts_hybrid === "s", "search_thoughts_hybrid is STABLE, so PostgREST's read-only RPC transaction may run it");
  assert(byName.extract_search_needles === "i", "extract_search_needles is IMMUTABLE");
}

// ── 19. Migration 018 — an unchanged edit is never a duplicate ───────────────
//
// Two rows from before migration 003 that normalise to the same text coexist
// with NULL fingerprints. Re-embedding passes each its own content through
// update_thought; the first gains a fingerprint, and 013's body then refused
// the second as DUPLICATE_CONTENT for ever. Here: the second is accepted, told
// which row it duplicates, and left without a fingerprint so the partial index
// is never violated — while editing a thought INTO another's text is still
// refused. No chunks are passed in this file: writing chunk rows crashes the
// WASM build (see [14]); chunk replacement through update_thought is held by
// db/test-live.ts [9] and server-portable/test-update-delete.ts [4]. The
// concurrent half — two twins fingerprinted at the same moment — is
// db/test-live.ts [6b], which PGlite's single session cannot run.

console.log("\n[19] Migration 018: an unchanged edit is never a duplicate, and names the pair");
{
  await db.exec(`DELETE FROM thoughts`);
  const legacy = async (content: string) =>
    (await db.query<{ id: string }>(
      `INSERT INTO thoughts (content, content_fingerprint, embedding) VALUES ($1, NULL, $2::vector) RETURNING id`,
      [content, unit(0)])).rows[0].id;
  const twin1 = await legacy("Same Text");
  const twin2 = await legacy("same   text");
  const other = await legacy("an unrelated note");
  const captured = (await db.query<{ r: { id: string } }>(
    `SELECT upsert_thought('a fingerprinted note', '{}'::jsonb) AS r`)).rows[0].r.id;
  const rowOf = async (id: string) =>
    (await db.query<{ content: string; fp: string | null; axis: number | null; metadata: Record<string, unknown> }>(
      `SELECT content, content_fingerprint AS fp,
              array_position(embedding::real[], 1::real) - 1 AS axis, metadata
       FROM thoughts WHERE id = $1`, [id])).rows[0];
  const update = async (...args: unknown[]) =>
    (await db.query<{ r: { ok: boolean; error?: string; duplicate_of?: string } }>(
      `SELECT update_thought($1::uuid, $2::text, $3::jsonb, $4::vector, NULL::jsonb, $5::timestamptz) AS r`,
      args)).rows[0].r;

  // The first twin: its own text back, a new vector. It gains the fingerprint
  // 003 never backfilled.
  const r1 = await update(twin1, "Same Text", null, unit(3), null);
  assert(r1.ok === true && r1.duplicate_of === undefined, `re-embedding the first twin with its own text succeeds, no duplicate named (${JSON.stringify(r1)})`);
  let row = await rowOf(twin1);
  assert(row.fp === (await fpOf("Same Text")), "…and it gains the fingerprint it never had");
  assert(row.axis === 3, `…with the new vector stored (axis ${row.axis})`);

  // The second twin: the same normalised text, now held by a fingerprinted
  // row. 013 refused this; 018 accepts it, names the other row, and leaves
  // this row's fingerprint NULL.
  const r2 = await update(twin2, "same   text", null, unit(4), null);
  assert(r2.ok === true, `re-embedding the second twin succeeds rather than DUPLICATE_CONTENT (${JSON.stringify(r2)})`);
  assert(r2.duplicate_of === twin1, `…and names the row it duplicates (${r2.duplicate_of})`);
  row = await rowOf(twin2);
  assert(row.fp === null, "…its fingerprint stays NULL, so the partial unique index is never violated");
  assert(row.axis === 4 && row.content === "same   text", `…the vector is replaced and the text is untouched (axis ${row.axis})`);

  // The check still works for what 009 wrote it for.
  const r3 = await update(other, "Same Text", null, unit(5), null);
  assert(r3.ok === false && r3.error === "DUPLICATE_CONTENT", `editing a thought INTO another thought's text is still refused (${JSON.stringify(r3)})`);
  row = await rowOf(other);
  assert(row.content === "an unrelated note" && row.axis === 0, "…and nothing about it changed");

  // A whitespace-only edit normalises to the same fingerprint: not a
  // duplicate of anything, the text moves, the fingerprint does not.
  const r4 = await update(twin1, "Same    Text", null, unit(6), null);
  assert(r4.ok === true && r4.duplicate_of === undefined, `a whitespace-only edit of a fingerprinted row succeeds, no duplicate named (${JSON.stringify(r4)})`);
  row = await rowOf(twin1);
  assert(row.content === "Same    Text" && row.fp === (await fpOf("Same Text")) && row.axis === 6, "…the text and the vector move, the fingerprint is unchanged");

  // A legacy row with no twin is simply backfilled.
  const r5 = await update(other, "an unrelated note", null, unit(7), null);
  assert(r5.ok === true && r5.duplicate_of === undefined, "a legacy row with no twin re-embeds with no duplicate named");
  assert((await rowOf(other)).fp === (await fpOf("an unrelated note")), "…and gains its fingerprint");

  // A row captured through upsert_thought is the ordinary case: unchanged.
  // Axes stay below 8 so the CI run at OB1_EMBEDDING_DIM=8 fits.
  const r6 = await update(captured, "a fingerprinted note", null, unit(2), null);
  assert(r6.ok === true && r6.duplicate_of === undefined && (await rowOf(captured)).fp === (await fpOf("a fingerprinted note")),
         "a fingerprinted row re-embedded with its own text keeps its fingerprint, no duplicate named");

  // Metadata-only: nothing about content, fingerprint or vector is touched.
  const r7 = await update(twin2, null, { k: 1 }, null, null);
  row = await rowOf(twin2);
  assert(r7.ok === true && row.fp === null && row.axis === 4 && row.metadata.k === 1, "a metadata-only edit of the unfingerprinted twin leaves fingerprint and vector alone");

  // 009's guard survives the redefinition.
  const r8 = await update(twin1, "Same Text", null, unit(3), "2000-01-01T00:00:00Z");
  assert(r8.ok === false && r8.error === "STALE_READ", `if_unchanged_since still refuses a stale write (${JSON.stringify(r8)})`);

  // A stale fingerprint — a raw UPDATE of content around update_thought, which
  // upstream's pre-009 path never recomputed — describing text the row no
  // longer holds, on a row whose text another row owns. The edit is unchanged
  // and reported as a duplicate; the stale hash must not survive it.
  const stale = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, content_fingerprint, embedding) VALUES ('same text', content_fingerprint_of('what it used to say'), $1::vector) RETURNING id`,
    [unit(0)])).rows[0].id;
  const r9 = await update(stale, "same text", null, unit(5), null);
  assert(r9.ok === true && r9.duplicate_of === twin1, `a row with a stale fingerprint re-saved as its own text is accepted and named a duplicate (${JSON.stringify(r9)})`);
  assert((await rowOf(stale)).fp === null, "…and the stale fingerprint is cleared rather than kept under text it does not describe");

  // The stale key on the OTHER side: a row whose column still says hash('foo')
  // while its text is 'bar'. Re-saving a legacy 'foo' row must not call that
  // row its twin — the texts differ — but cannot take the key either.
  const holder = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, content_fingerprint, embedding) VALUES ('bar', content_fingerprint_of('foo'), $1::vector) RETURNING id`,
    [unit(0)])).rows[0].id;
  const foo = await legacy("foo");
  const r10 = await update(foo, "foo", null, unit(5), null) as { ok: boolean; duplicate_of?: string; fingerprint_held_by?: string };
  assert(r10.ok === true && r10.duplicate_of === undefined, `a legacy row whose key another row holds under OTHER text is not told it has a twin (${JSON.stringify(r10)})`);
  assert(r10.fingerprint_held_by === holder, `…but which row holds the key under a stale fingerprint (${r10.fingerprint_held_by})`);
  assert((await rowOf(foo)).fp === null && (await rowOf(foo)).axis === 5, "…its fingerprint stays NULL and its vector is replaced");
  const r11 = await update(other, "foo", null, unit(6), null);
  assert(r11.ok === false && r11.error === "DUPLICATE_CONTENT", `editing a third row INTO a key a stale holder occupies is still refused — the key is taken (${JSON.stringify(r11)})`);
  const r12 = await update(holder, "bar", null, unit(6), null) as { ok: boolean; duplicate_of?: string; fingerprint_held_by?: string };
  assert(r12.ok === true && r12.duplicate_of === undefined && r12.fingerprint_held_by === undefined && (await rowOf(holder)).fp === (await fpOf("bar")),
         "re-saving the holder's own text corrects its stale key");
  const r13 = await update(foo, "foo", null, unit(7), null) as { ok: boolean; fingerprint_held_by?: string };
  assert(r13.ok === true && r13.fingerprint_held_by === undefined && (await rowOf(foo)).fp === (await fpOf("foo")), "…after which the legacy row takes its fingerprint");

  // The carry-forward, read out of pg_proc: one function, and every earlier
  // migration's piece still in its body by name.
  const proc = await db.query<{ prosrc: string }>(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'update_thought' AND n.nspname = 'public'`);
  assert(proc.rows.length === 1, `still exactly one update_thought (got ${proc.rows.length})`);
  const src = proc.rows[0]?.prosrc ?? "";
  assert(/ob1\.actor/.test(src), "…carrying 008's actor for the audit trigger");
  assert(/date_trunc\('milliseconds'/.test(src) && /p_if_unchanged_since IS NULL\s+OR/.test(src), "…009's millisecond-truncated guard as a predicate in the UPDATE");
  assert(/elem->>'context'/.test(src), "…013's context in the chunk insert");
  assert(/content_fingerprint_of\(/.test(src) && !/regexp_replace/.test(src), "…016's fingerprint function rather than a third inline copy of the rule");
  assert(/FROM thoughts WHERE id = p_id FOR UPDATE/.test(src), "…the row read FOR UPDATE, so \"unchanged\" is decided against a row that cannot change under the call");
  assert(/pg_advisory_xact_lock/.test(src), "…and the advisory lock that serialises edits to one fingerprint (db/test-live.ts [6b] proves it)");
  assert(/ob1:unchanged-edit-not-duplicate/.test(src), "…and the ob1:unchanged-edit-not-duplicate sentinel reembed.ts asks for, which a successor must keep");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 20. Migration 019 — the plan setting, and the row estimates ──────────────
//
// Two things the planner could not know. At the shipped width a vector is
// TOASTed and the sequential-scan estimate never counts the detoast reads, so
// the planner chose a seq scan of the chunk table at every size measured and
// of `thoughts` above the default count; and a plpgsql set-returning function
// is assumed to yield 1,000 rows, which is how 017's fused query came to be
// JIT-compiled on every call. 019 redefines match_thoughts with `SET
// enable_seqscan = off` and `ROWS 10`, and search_thoughts_keyword with `ROWS
// 25`, with both bodies carried verbatim. The plan itself is a real-server
// question (db/test-live.ts [5c]); this section holds what the catalog says,
// that the bodies did not move, and the trap that put the clauses in the
// defining statements rather than an ALTER.

console.log("\n[20] Migration 019: the row estimates and the plan setting — carried by 020, and the trap either re-apply springs");
{
  const proc = async (sig: string) => {
    const r = (await db.query<{ prorows: number; provolatile: string; prosrc: string; cfg: string[] | null }>(
      `SELECT prorows, provolatile, prosrc, proconfig AS cfg FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0];
    return { ...r, settings: parseSetConfig(r.cfg) };
  };
  const MT = MATCH_THOUGHTS_SIGNATURE;
  const MT_4 = "match_thoughts(vector, float, int, jsonb)"; // the form 020 dropped; 014 and 019 re-create it
  const KW = "search_thoughts_keyword(text, int, int, jsonb)";

  const mt = await proc(MT);
  const kw = await proc(KW);
  assert(Number(mt.prorows) === 10, `match_thoughts declares ROWS 10 (prorows ${mt.prorows})`);
  assert(Number(kw.prorows) === 25, `search_thoughts_keyword declares ROWS 25 (prorows ${kw.prorows})`);
  assert(mt.provolatile === "s" && kw.provolatile === "s", "both are still STABLE");
  assert(Object.keys(mt.settings).sort().join(",") === "enable_seqscan,hnsw.iterative_scan" && mt.settings["enable_seqscan"] === "off" && mt.settings["hnsw.iterative_scan"] === "relaxed_order",
         `match_thoughts carries exactly the scan mode and the plan setting (${JSON.stringify(mt.settings)})`);
  assert(Object.keys(kw.settings).length === 0, `search_thoughts_keyword carries no SET clause (${JSON.stringify(kw.settings)})`);
  assert(/ob1:filter-inside-scan/.test(mt.prosrc), "the ob1:filter-inside-scan sentinel is in the shipped body");

  // The estimate the clause exists for: a query composing either function is
  // planned against the declared count, not PostgreSQL's 1,000.
  const plan = async (q: string) =>
    (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${q}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  const mtPlan = await plan(`SELECT * FROM match_thoughts('${unit(0)}'::vector, 0.0, 10, '{}'::jsonb)`);
  assert(/Function Scan on match_thoughts\s+\(cost=[^)]*rows=10\b/.test(mtPlan), `a caller's plan estimates 10 rows from match_thoughts (${mtPlan.split("\n")[0]})`);
  const kwPlan = await plan(`SELECT * FROM search_thoughts_keyword('zylotrope', 25, 0, '{}'::jsonb)`);
  assert(/Function Scan on search_thoughts_keyword\s+\(cost=[^)]*rows=25\b/.test(kwPlan), `…and 25 from search_thoughts_keyword (${kwPlan.split("\n")[0]})`);

  // The candidate scan is 014's, byte for byte, through 019 and 020: the three
  // RETURN QUERY blocks' CTEs (direct, chunked, best) and the routing statement.
  // 020 changed each branch's final SELECT and nothing above it; this holds
  // "carried verbatim" for the part that decides the plan. Re-applying 014
  // gives 014's text to compare against — as a SECOND function, since 014's
  // signature is the 4-argument one 020 dropped.
  const cteBlocks = (src: string) => [...src.matchAll(/WITH direct AS \([\s\S]*?GROUP BY u\.tid\s*\)/g)].map((m) => m[0]);
  const routing = (src: string) => /SELECT array_agg\(s\.id\) INTO v_ids[\s\S]*?\) s;/.exec(src)?.[0] ?? "";
  await reapply("014");
  assert((await functionsNamed("match_thoughts")) === 2, "re-applying 014 puts the 4-argument function back BESIDE 020's — the overload 020's header names");
  const mt014 = await proc(MT_4);
  assert(cteBlocks(mt.prosrc).length === 3 && cteBlocks(mt.prosrc).join("\n---\n") === cteBlocks(mt014.prosrc).join("\n---\n"),
         "the three candidate CTEs of the shipped body are 014's, byte for byte");
  assert(routing(mt.prosrc).length > 0 && routing(mt.prosrc) === routing(mt014.prosrc), "…and so is the routing statement");
  assert(Number(mt014.prorows) === 1000 && !("enable_seqscan" in mt014.settings),
         `014's function has the estimate 1,000 and no plan setting (prorows ${mt014.prorows}, proconfig ${JSON.stringify(mt014.settings)}) — the trap that puts both in the defining statement`);
  // And the trap 020 adds: with both forms present, every 4-argument call —
  // the stores' before 020, search_thoughts_hybrid's before 020, PostgREST — is
  // ambiguous. preflight reports this state as a failure with the DROP remedy.
  let ambiguous = "";
  try {
    await db.query(`SELECT count(*) FROM match_thoughts($1::vector, 0.0, 10, '{}'::jsonb)`, [unit(0)]);
  } catch (e) {
    ambiguous = (e as Error).message;
  }
  assert(/not unique/.test(ambiguous), `with two match_thoughts a 4-argument call is ambiguous (${ambiguous.split("\n")[0] || "it succeeded"})`);
  await reapply("012");
  const kw012 = await proc(KW);
  assert(kw012.prosrc === kw.prosrc, "019's search_thoughts_keyword body is 012's, byte for byte");
  assert(Number(kw012.prorows) === 1000, `…and re-applying 012 alone resets its estimate to 1,000 (prorows ${kw012.prorows})`);
  const restored = await restoreShipped("match_thoughts", "search_thoughts_keyword");
  const back = await proc(MT);
  assert(Number(back.prorows) === 10 && back.settings["enable_seqscan"] === "off" && Number((await proc(KW)).prorows) === 25,
         `re-applying the migrations that last define each (${restored.join(", ")}) restores both — the shipped state, for whatever runs after`);
  assert((await functionsNamed("match_thoughts")) === 1 && (await functionsNamed("search_thoughts_keyword")) === 1, "…and 020's DROP removed the 4-argument function again: one match_thoughts, one search_thoughts_keyword");
  // Deliberately pinned, as [20] pinned 019 before 020 landed: 019 last defines
  // the keyword function, 020 match_thoughts. A successor that redefines either
  // fails here on purpose, and the expectations move with the clauses it must carry.
  assert(restored.length === 2 && restored[0].startsWith("019") && restored[1].startsWith("020"),
         `019 is the last definer of search_thoughts_keyword and 020 of match_thoughts (${restored.join(", ")})`);

  // The migrator's floor line, since whichever file last defines the function
  // redefines it with the hnsw.* clause 014 needed pgvector 0.8 for.
  const definer = readFileSync(join(MIGRATIONS, lastDefinerOf("match_thoughts")), "utf8");
  assert(/^--\s*requires:\s*pgvector\s*>=\s*0\.8\.0\s*$/m.test(definer), `${lastDefinerOf("match_thoughts")} declares \`requires: pgvector >= 0.8.0\` for migrate.ts`);
}

// ── 21. Migration 020 — the recency blend ────────────────────────────────────
//
// match_thoughts ranks on similarity alone; 020 lets a caller blend in age:
// score = similarity * (1 - w) + exp(-age_days / half_life) * w, over the
// candidates the scan already produced, with the threshold still on the raw
// similarity. What this section holds, in the ticket's words: backward
// compatibility EXACTLY (at w = 0 the rows and their order are 019's, on a
// fixed corpus, against 019's own function installed under another name);
// chunks still work through the recency path; the blend does something, and
// the half-life moves the crossover where the formula says; the widened
// candidate window is observable; the hybrid inherits the order and keeps the
// raw similarity. The plan is db/test-live.ts [5c]'s to hold.

console.log("\n[21] Migration 020: the recency blend — identical at weight 0, and the formula above it");
{
  const MT = MATCH_THOUGHTS_SIGNATURE;
  const proc = (await db.query<{ prorows: number; cfg: string[] | null; prosrc: string }>(
    `SELECT prorows, proconfig AS cfg, prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [MT])).rows[0];
  assert((await functionsNamed("match_thoughts")) === 1 && (await functionsNamed("search_thoughts_hybrid")) === 1, "one match_thoughts, one search_thoughts_hybrid: 020 replaced both signatures rather than adding overloads");
  const settings = parseSetConfig(proc.cfg);
  assert(Number(proc.prorows) === 10 && settings["enable_seqscan"] === "off" && settings["hnsw.iterative_scan"] === "relaxed_order" && Object.keys(settings).length === 2 && /ob1:filter-inside-scan/.test(proc.prosrc),
         "020 carries what 019 handed over: ROWS 10, exactly the two settings, the sentinel");
  const cols = (await db.query<{ n: string }>(
    `SELECT a.attname AS n FROM pg_proc p, unnest(p.proallargtypes, p.proargmodes, p.proargnames) WITH ORDINALITY AS a(t, m, attname, o)
     WHERE p.oid = $1::regprocedure AND a.m = 't' ORDER BY a.o`, [MT])).rows.map((r) => r.n);
  assert(cols.join(",") === "id,content,metadata,similarity,created_at,score", `the return shape is 019's five columns plus score (${cols.join(",")})`);

  // ── The fixture: 200 thoughts at known similarities, all old, plus the
  // special rows below. Row i sits at cosine 0.95 - 0.003 i to the query
  // unit(0) — a second axis carries the rest of the unit length — so the
  // ranking by similarity is known exactly, and the candidate window's edge
  // (40 at count 10 without a weight, 160 with one) falls between rows.
  await db.exec(`DELETE FROM thoughts`);
  const Q = unit(0);
  const at = (cos: number, axis: number) => blend(0, axis, cos, Math.sqrt(1 - cos * cos));
  const axisOf = (i: number) => 1 + (i % (EMBEDDING_DIM - 1));
  for (let i = 0; i < 200; i += 50) {
    const values = Array.from({ length: 50 }, (_, k) => {
      const n = i + k;
      return `('row ${n}', '{"kind":"${n % 3 === 0 ? "a" : "b"}"}'::jsonb, '${at(0.95 - 0.003 * n, axisOf(n))}'::vector, now() - interval '400 days' - (${n} || ' hours')::interval)`;
    }).join(",");
    await db.exec(`INSERT INTO thoughts (content, metadata, embedding, created_at) VALUES ${values}`);
  }
  // Chunk rows for one row in five, carrying the parent's own vector (the
  // shape db/test-live.ts [5b] loads), and one thought findable ONLY through a
  // chunk: its own vector is far from the query, its chunk is the nearest
  // thing in the table.
  await db.exec(`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
                 SELECT id, 0, 'chunk', embedding FROM thoughts WHERE substr(content, 5)::int % 5 = 0`);
  const chunkOnly = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, metadata, embedding, created_at) VALUES ('chunk-only', '{"kind":"b"}'::jsonb, $1::vector, now() - interval '400 days') RETURNING id`,
    [at(0.10, 2)])).rows[0].id;
  await db.query(`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES ($1::uuid, 0, 'the near chunk', $2::vector)`, [chunkOnly, at(0.99, 3)]);
  // The recent row: 61st by similarity — outside the 40-candidate window an
  // unweighted default call has, inside the 160 a weighted one has.
  const recent = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, metadata, embedding, created_at) VALUES ('recent', '{"kind":"b"}'::jsonb, $1::vector, now()) RETURNING id`,
    [at(0.95 - 0.003 * 60 + 0.001, 4)])).rows[0].id;
  const rankOf = async (id: string) =>
    (await db.query<{ r: number }>(`SELECT (SELECT count(*)::int FROM thoughts o WHERE o.embedding <=> $1::vector < t.embedding <=> $1::vector) + 1 AS r FROM thoughts t WHERE t.id = $2::uuid`, [Q, id])).rows[0].r;
  const recentRank = await rankOf(recent);
  assert(recentRank > 40 && recentRank <= 160, `the recent row ranks ${recentRank} by similarity alone: outside the unweighted window of 40, inside the weighted one of 160`);

  // ── Backward compatibility, exactly. 019's own function, installed from its
  // file under another name, answers the same calls; rows and order must match
  // and `score` must equal `similarity` on every row. Filters reach the
  // unfiltered and the exact branch here; [8c] holds the walk against an exact
  // scan on 1,200 rows, and its final SELECT is the same edit.
  const m019 = files.find((f) => f.startsWith("019"))!;
  const text019 = subst(readFileSync(join(MIGRATIONS, m019), "utf8"));
  assert(text019.split("FUNCTION match_thoughts(").length === 2, "019's file defines match_thoughts once, so it can be installed under another name");
  await db.exec(text019.replace("FUNCTION match_thoughts(", "FUNCTION match_thoughts_019("));
  type Row = { id: string; similarity: number; score: number | null };
  let compared = 0;
  let same = true;
  let scoreIsSim = true;
  for (const [th, n, filter] of [[-1.0, 10, "{}"], [0.0, 50, "{}"], [0.5, 10, "{}"], [-1.0, 10, '{"kind":"a"}'], [0.3, 50, '{"kind":"b"}'], [-1.0, 500, "{}"]] as const) {
    // Three queries whose similarities are distinct over the fixture: `unit(3)`
    // would tie every row off axis 3 at 0, and 020 breaks ties by id where
    // 019 left them to the plan — a difference in the tiebreak, not the ranking,
    // and one [21] asserts separately below.
    for (const q of [Q, at(0.5, 5), at(0.3, 2)]) {
      const now = (await db.query<Row>(`SELECT id, similarity, score FROM match_thoughts($1::vector, $2, $3, $4::jsonb)`, [q, th, n, filter])).rows;
      const was = (await db.query<Row>(`SELECT id, similarity FROM match_thoughts_019($1::vector, $2, $3, $4::jsonb)`, [q, th, n, filter])).rows;
      compared++;
      if (JSON.stringify(now.map((r) => [r.id, r.similarity])) !== JSON.stringify(was.map((r) => [r.id, r.similarity]))) same = false;
      if (!now.every((r) => r.score === r.similarity)) scoreIsSim = false;
    }
  }
  assert(same, `at weight 0 the rows and their order are 019's, row for row, over ${compared} calls (thresholds, counts, the unfiltered and the exact branch)`);
  assert(scoreIsSim, "…and score equals similarity on every row, exactly");
  const plain = (await db.query<Row>(`SELECT id, similarity, score FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [Q])).rows;
  assert(plain[0].id === chunkOnly && Math.abs(plain[0].similarity - 0.99) < 1e-6, `the chunk-only thought is first at weight 0, scored by its chunk (${plain[0].similarity})`);
  const fourArg = await db.query(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [Q]);
  assert(fourArg.rows[0].c === 10, "a 4-argument call still resolves — the defaults, not a second overload");
  await db.exec(`DROP FUNCTION match_thoughts_019(vector, float, int, jsonb)`);
  assert((await functionsNamed("match_thoughts")) === 1, "the comparison function is gone again");

  // ── The blend does something: with a weight the recent row comes first,
  // which needs the widened window — by similarity alone it is 61st.
  const weighted = (await db.query<Row & { content: string }>(`SELECT id, content, similarity, score FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb, 0.5, 90.0)`, [Q])).rows;
  assert(weighted[0].id === recent, `at weight 0.5 the recent row is first (${weighted[0].content}, score ${weighted[0].score})`);
  assert(Math.abs(weighted[0].similarity - (0.95 - 0.003 * 60 + 0.001)) < 1e-6, `…and its similarity is still the raw cosine (${weighted[0].similarity})`);
  assert(weighted.every((r, i) => i === 0 || (r.score as number) <= (weighted[i - 1].score as number)), "…and score is monotone down the list");
  const chunkRow = weighted.find((r) => r.id === chunkOnly);
  assert(chunkRow !== undefined && Math.abs(chunkRow.similarity - 0.99) < 1e-6, `the chunk-only thought is still found through the recency path, scored by its chunk (${chunkRow?.similarity})`);
  // Every score is the formula, from the raw similarity and the row's age.
  const ages = new Map((await db.query<{ id: string; d: number }>(`SELECT id, extract(epoch FROM (now() - created_at)) / 86400.0 AS d FROM thoughts`)).rows.map((r) => [r.id, Number(r.d)]));
  // Written out here, independently of recency_score(): a true half-life, so
  // the factor at age = half_life is 0.5 (the first draft — and upstream's
  // schema — wrote exp(-age / half_life), an e-folding time, 0.37 at the
  // half-life; first review pass).
  const formula = (sim: number, days: number, w: number, h: number) => sim * (1 - w) + Math.pow(0.5, Math.max(days, 0) / h) * w;
  assert(weighted.every((r) => Math.abs((r.score as number) - formula(r.similarity, ages.get(r.id)!, 0.5, 90)) < 1e-6), "every score is similarity * (1 - w) + 0.5 ^ (age_days / half_life) * w");
  const [{ half }] = (await db.query<{ half: number }>(`SELECT recency_score(0.0, now() - interval '90 days', 1.0, 90.0) AS half`)).rows;
  assert(Math.abs(Number(half) - 0.5) < 1e-6, `at age = half_life the recency factor is 0.5 — the name is true (${half})`);

  // ── The crossover. Two rows: A older and more similar by δ, B newer. The
  // formula says they swap at w* = δ / (δ + r_B - r_A); asserted on both sides
  // of w*, and a shorter half-life moves w* — at one weight, the two
  // half-lives give opposite orders.
  await db.exec(`DELETE FROM thoughts`);
  const A = (await db.query<{ id: string }>(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('A: older, closer', $1::vector, now() - interval '365 days') RETURNING id`, [at(0.90, 1)])).rows[0].id;
  const B = (await db.query<{ id: string }>(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('B: newer, farther', $1::vector, now() - interval '40 days') RETURNING id`, [at(0.80, 2)])).rows[0].id;
  await db.query(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('C: orthogonal, brand new', $1::vector, now())`, [unit(3)]);
  const order = async (w: number | null, h: number | null, th = -1.0) =>
    (await db.query<{ content: string; score: number }>(`SELECT content, score FROM match_thoughts($1::vector, $2, 10, '{}'::jsonb, $3, $4)`, [Q, th, w, h])).rows;
  const sims = Object.fromEntries((await db.query<{ id: string; s: number }>(`SELECT id, 1 - (embedding <=> $1::vector) AS s FROM thoughts`, [Q])).rows.map((r) => [r.id, Number(r.s)]));
  const wStar = (h: number) => {
    const delta = sims[A] - sims[B];
    const rA = Math.pow(0.5, 365 / h), rB = Math.pow(0.5, 40 / h);
    return delta / (delta + rB - rA);
  };
  const w90 = wStar(90), w30 = wStar(30);
  assert((await order(0, 90))[0].content.startsWith("A"), "at weight 0 the closer row A leads");
  assert((await order(w90 - 0.02, 90))[0].content.startsWith("A"), `just below w* = ${w90.toFixed(4)} (half-life 90) A still leads`);
  assert((await order(w90 + 0.02, 90))[0].content.startsWith("B"), `just above it the newer row B leads`);
  assert(w30 > w90 + 0.005, `a 30-day half-life moves the crossover to w* = ${w30.toFixed(4)}, later than ${w90.toFixed(4)}: with a short half-life B's forty days already cost it something`);
  const between = (w90 + w30) / 2;
  assert((await order(between, 90))[0].content.startsWith("B") && (await order(between, 30))[0].content.startsWith("A"),
         `at weight ${between.toFixed(4)} the two half-lives give opposite orders — the half-life moves the crossover where the formula says`);
  // The threshold gates the RAW similarity: the brand-new orthogonal row cannot
  // be surfaced by any weight — and at weight 1 with no threshold it leads.
  assert(!(await order(1, 90, 0.5)).some((r) => r.content.startsWith("C")), "at weight 1 a recent row with similarity 0 is still excluded by threshold 0.5 — the threshold gates raw similarity");
  assert((await order(1, 90, -1))[0].content.startsWith("C"), "…and with no threshold, weight 1 ranks by age alone: the brand-new row first");
  // Inputs: clamped weights, NULLs as defaults, a non-positive half-life refused.
  // Two calls see two now()s a few milliseconds apart, so scores are compared
  // to a tolerance and the order exactly.
  const sameAs = async (a: [number | null, number | null], b: [number | null, number | null]) => {
    const x = await order(...a), y = await order(...b);
    return x.length === y.length && x.every((r, i) => r.content === y[i].content && Math.abs(r.score - y[i].score) < 1e-6);
  };
  assert(await sameAs([5, 90], [1, 90]), "a weight above 1 is clamped to 1");
  assert(await sameAs([-1, 90], [0, 90]), "a weight below 0 is clamped to 0");
  assert(await sameAs([null, null], [0, 90]), "NULL weight and half-life are the defaults, 0 and 90");
  assert(await sameAs([0.3, null], [0.3, 90]), "…a NULL half-life alone is 90");
  let refused = "";
  try { await order(0.3, 0); } catch (e) { refused = (e as Error).message; }
  assert(/half_life_days must be positive/.test(refused), `a non-positive half-life is refused (${refused.split("\n")[0] || "it was accepted"})`);
  const nullAge = (await db.query<{ id: string }>(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('no date', $1::vector, NULL) RETURNING id`, [at(0.85, 4)])).rows[0].id;
  const dated = (await db.query<{ id: string; similarity: number; score: number }>(`SELECT id, similarity, score FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb, 0.5, 90.0)`, [Q])).rows.find((r) => r.id === nullAge)!;
  assert(dated !== undefined && Math.abs(dated.score - dated.similarity * 0.5) < 1e-9, `a row with no created_at scores as infinitely old (${dated?.score} = ${dated?.similarity} * 0.5)`);
  // Infinite timestamps (the column accepts them): -infinity is infinitely old,
  // +infinity brand new — and at weight 0 the age is never computed, which is
  // what keeps PostgreSQL 16 (the pinned server; PGlite here is 17) from
  // raising "cannot subtract infinite timestamps" on a call 019 answered fine.
  const [past, future] = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, embedding, created_at) VALUES ('from -infinity', $1::vector, '-infinity'), ('from +infinity', $2::vector, 'infinity') RETURNING id`,
    [at(0.84, 5), at(0.83, 6)])).rows.map((r) => r.id);
  const inf0 = (await db.query<Row>(`SELECT id, similarity, score FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [Q])).rows;
  assert(inf0.some((r) => r.id === past && r.score === r.similarity) && inf0.some((r) => r.id === future && r.score === r.similarity), "rows with infinite created_at are returned at weight 0 with score = similarity");
  const inf1 = (await db.query<Row>(`SELECT id, similarity, score FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb, 0.5, 90.0)`, [Q])).rows;
  const pastRow = inf1.find((r) => r.id === past)!, futureRow = inf1.find((r) => r.id === future)!;
  assert(Math.abs((pastRow.score as number) - pastRow.similarity * 0.5) < 1e-9 && Math.abs((futureRow.score as number) - (futureRow.similarity * 0.5 + 0.5)) < 1e-9,
         `-infinity scores as infinitely old and +infinity as brand new (${pastRow.score}, ${futureRow.score})`);
  // Ties are broken by id: three rows captured in one statement share a
  // created_at and a similarity, so at weight 1 their scores are equal and
  // 019's ORDER BY would have left their order — and which survive a LIMIT —
  // to the plan (first review pass).
  const tied = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, embedding) VALUES ('tie a', $1::vector), ('tie b', $1::vector), ('tie c', $1::vector) RETURNING id`, [at(0.7, 7)])).rows.map((r) => r.id).sort();
  const tiedOut = (await db.query<Row>(`SELECT id, similarity, score FROM match_thoughts($1::vector, -1.0, 20, '{}'::jsonb, 1.0, 90.0)`, [Q])).rows.filter((r) => tied.includes(r.id));
  assert(tiedOut.length === 3 && new Set(tiedOut.map((r) => r.score)).size === 1 && tiedOut.map((r) => r.id).join() === tied.join(), `three rows with equal scores come back in id order (${tiedOut.map((r) => r.id.slice(0, 8)).join(", ")})`);
  const tiedTwo = (await db.query<Row>(`SELECT id FROM match_thoughts($1::vector, 0.65, 2, '{}'::jsonb, 1.0, 90.0)`, [Q])).rows.map((r) => r.id).filter((id) => tied.includes(id));
  assert(tiedTwo.length <= 2 && tiedTwo.every((id, i) => id === tied[i]), "…and a LIMIT that cuts through the tie keeps the lowest ids, not whichever the sort emitted");

  // ── The hybrid inherits the order through the vector arm and keeps the raw
  // similarity (017's probe compares like with like — 020's header says why
  // `similarity` did not change).
  const hy = (await db.query<{ id: string; content: string; similarity: number; score: number }>(
    `SELECT id, content, similarity, score FROM search_thoughts_hybrid($1::vector, 'what was I doing lately', -1.0, 10, '{}'::jsonb, 1.0, 90.0)`, [Q])).rows;
  const mt1 = await order(1, 90, -1);
  assert(hy.map((r) => r.content).join("|") === mt1.map((r) => r.content).join("|"), `with a weight and no needle the fused order is match_thoughts' weighted order (${hy.map((r) => r.content.split(":")[0]).join(", ")})`);
  const rawSims = Object.fromEntries((await db.query<{ id: string; s: number }>(`SELECT id, 1 - (embedding <=> $1::vector) AS s FROM thoughts`, [Q])).rows.map((r) => [r.id, Number(r.s)]));
  assert(hy.every((r) => Math.abs(r.similarity - rawSims[r.id]) < 1e-9), "…and every fused row's similarity is its raw cosine, not the blended score");
  const hy0 = (await db.query<{ content: string }>(`SELECT content FROM search_thoughts_hybrid($1::vector, 'what was I doing lately', -1.0, 10, '{}'::jsonb)`, [Q])).rows;
  assert(hy0.map((r) => r.content).join("|") === (await order(0, 90)).map((r) => r.content).join("|"), "…and the 5-argument hybrid call — every caller before 020 — still resolves, to the unweighted order");
  // Under a weight the hybrid passes the caller's threshold to match_thoughts.
  // With -1 (017's call) the one slot here would go to the newest row — C,
  // orthogonal, brand new — which the threshold then drops, and the fused
  // search would answer "nothing" for a query the unweighted call answers
  // (first review pass). The slot must go to the newest row ABOVE 0.5.
  const one = (await db.query<{ content: string; similarity: number }>(
    `SELECT content, similarity FROM search_thoughts_hybrid($1::vector, 'what was I doing lately', 0.5, 1, '{}'::jsonb, 1.0, 90.0)`, [Q])).rows;
  assert(one.length === 1 && one[0].similarity > 0.5, `with a weight, threshold 0.5 and one slot, the fused search returns one row above the threshold (${one.map((r) => `${r.content} ${r.similarity.toFixed(2)}`).join(", ") || "none"})`);
  const mtOne = await order(1, 90, 0.5);
  assert(one[0].content === mtOne[0].content, `…the newest row above the threshold, as the weighted semantic tool would show it (${one[0].content})`);
  // With the threshold passed, a keyword hit BELOW the threshold is not in the
  // window at any rank. It must still come first — "exact hits first" — so it
  // carries the rank just past the window; without that it tied a rank-1
  // vector-only row at exactly 1/(k + 1) and lost on similarity (second review
  // pass). Row N: contains the needle, similarity 0.45, brand new.
  await db.query(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('N: names SMD-9450, below the threshold', $1::vector, now())`, [at(0.45, 5)]);
  const needleBelow = (await db.query<{ content: string; similarity: number; matched_needles: string[] }>(
    `SELECT content, similarity, matched_needles FROM search_thoughts_hybrid($1::vector, 'the scheduler work on SMD-9450', 0.5, 10, '{}'::jsonb, 0.5, 90.0)`, [Q])).rows;
  assert(needleBelow[0].content.startsWith("N:") && needleBelow[0].matched_needles.join() === "SMD-9450" && needleBelow[0].similarity < 0.5,
         `under a weight and a threshold, a keyword hit below the threshold is still first (${needleBelow.map((r) => r.content.split(":")[0]).join(", ")})`);
  const needleBelow0 = (await db.query<{ content: string }>(
    `SELECT content FROM search_thoughts_hybrid($1::vector, 'the scheduler work on SMD-9450', 0.5, 10, '{}'::jsonb)`, [Q])).rows;
  assert(needleBelow0[0].content.startsWith("N:"), "…as it is at weight 0, where the window held it with a rank of its own");
  // A hit with no vector and no chunks: at weight 1 a thought captured today
  // through the 2-arg fallback outranks a three-year-old embedded hit — its
  // NULL similarity is scored as 0 into the same formula under a weight, where
  // the first draft sorted its NULL blend last (second review pass).
  await db.query(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('O: old embedded, names SMD-9450', $1::vector, now() - interval '3 years'), ('P: unembedded today, names SMD-9450', NULL, now())`, [at(0.9, 6)]);
  const byAge = (await db.query<{ content: string; similarity: number | null }>(
    `SELECT content, similarity FROM search_thoughts_hybrid($1::vector, 'SMD-9450', -1.0, 10, '{}'::jsonb, 1.0, 90.0)`, [Q])).rows;
  const posP = byAge.findIndex((r) => r.content.startsWith("P:")), posO = byAge.findIndex((r) => r.content.startsWith("O:"));
  assert(posP >= 0 && posO >= 0 && posP < posO && byAge[posP].similarity === null, `at weight 1 an unembedded hit captured today ranks above a three-year-old embedded hit, its similarity still NULL (${byAge.map((r) => r.content.split(":")[0]).join(", ")})`);
  const byAge0 = (await db.query<{ content: string }>(`SELECT content FROM search_thoughts_hybrid($1::vector, 'SMD-9450', -1.0, 10, '{}'::jsonb)`, [Q])).rows;
  const p0 = byAge0.findIndex((r) => r.content.startsWith("P:")), o0 = byAge0.findIndex((r) => r.content.startsWith("O:"));
  assert(p0 > o0, "…and at weight 0 the unembedded hit still sorts after it, as 017 had it");
  await db.exec(`DELETE FROM thoughts WHERE content LIKE 'N:%' OR content LIKE 'O:%' OR content LIKE 'P:%'`);
  // The exact/walk boundary does not move with the weight: v_exact is sized
  // from the unweighted window (second review pass).
  assert(/v_exact\s+int\s+:= GREATEST\(v_base \* 4, 1000\);/.test(proc.prosrc) && /v_fetch\s+int\s+:= v_base \* CASE WHEN v_weight > 0 THEN 4 ELSE 1 END;/.test(proc.prosrc),
         "v_exact is sized from the unweighted window, v_fetch widens from it");
  // A literal-only query gives the vector arm no vote (017's gate), so the
  // fused score is 0 for every row not containing the needle and the tiebreak
  // is the whole order. It is the blended score, not the raw similarity, so the
  // weight the caller sent orders the rows it chose (first review pass).
  const literal = (await db.query<{ content: string }>(
    `SELECT content FROM search_thoughts_hybrid($1::vector, 'ZZQX_9450', -1.0, 10, '{}'::jsonb, 1.0, 90.0)`, [Q])).rows;
  // Compared where the blend decides: the rows scoring 0 (no date, -infinity)
  // tie, and 017's tiebreak after the blend is created_at then id where
  // match_thoughts' is id alone.
  const decided = mt1.filter((r) => r.score > 0).map((r) => r.content);
  assert(literal.slice(0, decided.length).map((r) => r.content).join("|") === decided.join("|"), `a literal-only query under a weight is ordered by the blend, not by raw similarity (${literal.map((r) => r.content.split(":")[0]).join(", ")})`);

  // ── The ACL survives the DROP. 020 drops the 4-argument function and a
  // CREATE gives the new one default privileges — on Supabase, EXECUTE for
  // anon and authenticated — so an operator's REVOKE on the old form would
  // have been silently undone (first review pass). 020 reads the old ACL
  // before the DROP and replays it. Here: 019's 4-argument form back beside
  // 020's, PUBLIC revoked on it, 020 re-applied, the new form's ACL read.
  const acl = async (sig: string) => String((await db.query<{ a: string | null }>(`SELECT proacl::text AS a FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0]?.a ?? "");
  const MT_4 = "match_thoughts(vector, float, int, jsonb)";
  const hasPublic = (a: string) => /(^\{|,)=X\//.test(a);
  assert((await acl(MT)) === "", "the shipped function has default privileges — a NULL ACL");
  // A database from before 020: the 6-argument form dropped, 019's 4-argument
  // form installed and hardened, then 020 applied for the first time.
  const pre020 = async () => { await db.exec(`DROP FUNCTION ${MT}`); await reapply("019"); };
  await pre020();
  await db.exec(`REVOKE ALL ON FUNCTION ${MT_4} FROM PUBLIC`);
  await restoreShipped("match_thoughts");
  const revoked = await acl(MT);
  assert(revoked !== "" && !hasPublic(revoked) && (await functionsNamed("match_thoughts")) === 1, `a REVOKE FROM PUBLIC on the 4-argument form is carried to the new one (${revoked})`);
  // The other direction, and a grant that is not PUBLIC's: an explicit grant on
  // the old form appears on the new one — the second review pass found the
  // first draft of this case observing its own GRANT on the 6-argument form.
  await db.exec(`CREATE ROLE ob1_test_reader`);
  await pre020();
  await db.exec(`REVOKE ALL ON FUNCTION ${MT_4} FROM PUBLIC`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${MT_4} TO ob1_test_reader WITH GRANT OPTION`);
  await restoreShipped("match_thoughts");
  const granted = await acl(MT);
  assert(!hasPublic(granted) && /ob1_test_reader=X\*\//.test(granted), `a grant on the old form — here to a role, with grant option — is carried to the new one, PUBLIC still revoked (${granted})`);
  // Default privileges: what a Supabase project gives every new function (anon,
  // authenticated, service_role). Revoking PUBLIC alone would leave them, and
  // an operator's REVOKE on such a role would come back with the CREATE. The
  // replay revokes every grantee the CREATE handed out before it grants.
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ob1_test_reader`);
  await pre020();
  const fresh4 = await acl(MT_4);
  assert(/ob1_test_reader=X\//.test(fresh4), `default privileges give a re-created 4-argument form EXECUTE for the role (${fresh4})`);
  await db.exec(`REVOKE ALL ON FUNCTION ${MT_4} FROM ob1_test_reader`);
  await restoreShipped("match_thoughts");
  const stripped = await acl(MT);
  assert(!/ob1_test_reader/.test(stripped) && hasPublic(stripped), `a role the defaults grant to but the old form had revoked is revoked on the new form too, PUBLIC kept as the old form had it (${stripped})`);
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ob1_test_reader`);
  // A re-run over a database that already has the 6-argument form — the
  // hand-re-apply state, the 4-argument form back beside it — must not stamp
  // the 4-argument form's ACL over a hardened 6-argument one.
  await db.exec(`REVOKE ALL ON FUNCTION ${MT} FROM PUBLIC`);
  await reapply("019");
  assert(hasPublic(await acl(MT_4)) || (await acl(MT_4)) === "", "the re-created 4-argument form has the defaults");
  await restoreShipped("match_thoughts");
  const kept = await acl(MT);
  assert(!hasPublic(kept) && (await functionsNamed("match_thoughts")) === 1, `a re-run of 020 over the two-form state drops the 4-argument form and leaves the hardened 6-argument form's ACL alone (${kept})`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${MT} TO PUBLIC`);
  await db.exec(`DROP ROLE ob1_test_reader`);
}

// ── 22. Migration 021 — the vector's model rides with the vector ─────────────
//
// One nullable column, written by the same statement as the vector: the label
// follows the vector through both writers, NULL is "unknown", and nothing else
// moved — 018's body by name, 010's audit trigger, the ACL across the DROP of
// the 7-argument update_thought.

console.log("\n[22] Migration 021: the vector's model rides with the vector");
{
  await db.exec(`DELETE FROM thoughts`);
  const UT = UPDATE_THOUGHT_SIGNATURE;
  const UT_7 = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)"; // the form 021 dropped; 018 re-creates it
  const rowOf = async (id: string) =>
    (await db.query<{ model: string | null; axis: number | null; metadata: Record<string, unknown> }>(
      `SELECT embedding_model AS model, array_position(embedding::real[], 1::real) - 1 AS axis, metadata FROM thoughts WHERE id = $1`, [id])).rows[0];
  const capture = async (content: string, payload: Record<string, unknown>, vec: string | null) =>
    (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(payload), vec])).rows[0].r.id;
  const update = async (...args: unknown[]) =>
    (await db.query<{ r: { ok: boolean; error?: string } }>(
      `SELECT update_thought($1::uuid, $2::text, $3::jsonb, $4::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, $5::text) AS r`, args)).rows[0].r;
  const audits = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).rows[0].c;

  const col = (await db.query<{ data_type: string; is_nullable: string; comment: string | null }>(
    `SELECT c.data_type, c.is_nullable, col_description('thoughts'::regclass, a.attnum) AS comment
     FROM information_schema.columns c JOIN pg_attribute a ON a.attrelid = 'thoughts'::regclass AND a.attname = c.column_name
     WHERE c.table_name = 'thoughts' AND c.column_name = 'embedding_model'`)).rows[0];
  assert(col?.data_type === "text" && col?.is_nullable === "YES", `thoughts.embedding_model exists, text, nullable (${JSON.stringify(col)})`);
  assert(/Unknown, not the default/.test(col?.comment ?? ""), "…and its comment says what NULL means");

  // Capture: the label rides in the envelope, beside the actor.
  const labelled = await capture("a labelled capture", { metadata: {}, embedding_model: "model-a" }, unit(1));
  assert((await rowOf(labelled)).model === "model-a", "upsert_thought writes p_payload.embedding_model beside the vector");
  const unlabelled = await capture("an unlabelled capture", { metadata: {} }, unit(2));
  assert((await rowOf(unlabelled)).model === null, "…a payload without the key writes NULL — a vector of unknown model");
  const bare = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought('a two-argument capture', '{"metadata":{},"embedding_model":"model-a"}'::jsonb) AS r`)).rows[0].r.id;
  assert((await rowOf(bare)).model === null && (await rowOf(bare)).axis === null, "…the 2-argument form writes no vector and no label, whatever the envelope says");
  const vectorless = await capture("a first capture with no vector", { metadata: {}, embedding_model: "model-a" }, null);
  assert((await rowOf(vectorless)).model === null && (await rowOf(vectorless)).axis === null, "…and a first capture through the 3-argument form with a NULL vector takes no label either — nothing for it to be the model of");
  // Re-capture: the label follows the vector.
  await capture("a labelled capture", { metadata: { k: 1 }, embedding_model: "model-b" }, unit(3));
  let row = await rowOf(labelled);
  assert(row.model === "model-b" && row.axis === 3 && row.metadata.k === 1, `a re-capture with a vector takes the caller's label with it (${row.model}, axis ${row.axis})`);
  await capture("a labelled capture", { metadata: { k: 2 } }, unit(4));
  row = await rowOf(labelled);
  assert(row.model === null && row.axis === 4, `…and an older caller's re-capture — a vector, no label — leaves the vector of unknown model (${row.model})`);
  await capture("a labelled capture", { metadata: { k: 3 }, embedding_model: "model-c" }, unit(5));
  await capture("a labelled capture", { metadata: { k: 4 }, embedding_model: "model-z" }, null);
  row = await rowOf(labelled);
  assert(row.model === "model-c" && row.axis === 5 && row.metadata.k === 4, `a re-capture with NO vector keeps the vector and its label, whatever label it names (${row.model}, axis ${row.axis})`);
  await db.query(`SELECT upsert_thought('a labelled capture', '{"metadata":{"k":5}}'::jsonb)`);
  row = await rowOf(labelled);
  assert(row.model === "model-c" && row.axis === 5 && row.metadata.k === 5, "…as does a metadata-only 2-argument re-capture");

  // Edit: the eighth parameter.
  const before = await audits();
  let r = await update(labelled, "a labelled capture", null, unit(6), "model-d");
  row = await rowOf(labelled);
  assert(r.ok === true && row.model === "model-d" && row.axis === 6, `update_thought with content, a vector and a model relabels (${row.model}, axis ${row.axis})`);
  assert((await audits()) === before, "…and a re-embed — same text, new vector, new label — writes no audit row: 008's trigger diffs the vector's presence, not the label");
  r = await update(labelled, null, { k: 6 }, null, "model-e");
  row = await rowOf(labelled);
  assert(r.ok === true && row.model === "model-d" && row.axis === 6 && row.metadata.k === 6, `a metadata-only edit leaves the vector and its label, whatever model it names (${row.model})`);
  r = await update(labelled, "a labelled capture, edited", null, null, "model-e");
  row = await rowOf(labelled);
  assert(r.ok === true && row.model === null && row.axis === null, `content with no vector: the vector is NULL and so is the label, whatever model was named (${row.model})`);
  const r7 = (await db.query<{ r: { ok: boolean } }>(
    `SELECT update_thought($1::uuid, 'a labelled capture, edited', NULL::jsonb, $2::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb) AS r`, [labelled, unit(7)])).rows[0].r;
  row = await rowOf(labelled);
  assert(r7.ok === true && row.axis === 7 && row.model === null, "a 7-argument call — every caller before this change — resolves through the default and labels the vector unknown");
  const beforeLabel = await audits();
  await db.exec(`UPDATE thoughts SET embedding_model = 'model-f' WHERE id = '${labelled}'`);
  assert((await audits()) === beforeLabel, "a label-only change is not an audit event either");

  // One function, eight parameters, 018's body by name; 010's trigger untouched.
  assert((await functionsNamed("update_thought")) === 1, "exactly one update_thought: 021 replaced the signature rather than adding an overload");
  const proc = (await db.query<{ n: number; src: string }>(`SELECT pronargs AS n, prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure`, [UT])).rows[0];
  assert(Number(proc?.n) === 8, `…of eight parameters (${proc?.n})`);
  for (const [re, what] of [
    [/ob1:unchanged-edit-not-duplicate/, "018's sentinel"], [/ob1\.actor/, "008's actor"], [/FROM thoughts WHERE id = p_id FOR UPDATE/, "018's FOR UPDATE"],
    [/pg_advisory_xact_lock/, "018's advisory lock"], [/content_fingerprint_of\(/, "016's fingerprint function"], [/elem->>'context'/, "013's context"],
    [/date_trunc\('milliseconds'/, "009's guard"], [/jsonb_typeof\(p_payload\) <> 'object'/, null],
  ] as [RegExp, string | null][]) {
    if (what) assert(re.test(proc.src), `…carrying ${what}`);
  }
  const up = (await db.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE oid = 'upsert_thought(text, jsonb, vector)'::regprocedure`)).rows[0].src;
  assert(/jsonb_typeof\(p_payload\) <> 'object'/.test(up) && /set_config\('ob1\.actor'/.test(up) && /p_payload->>'embedding_model'/.test(up), "the 3-argument upsert_thought carries 005's guard and 008's actor beside the label");
  assert((await functionsNamed("upsert_thought")) === 3, "still exactly three upsert_thought overloads");
  assert(lastDefinerOf("update_thought").startsWith("021") && lastDefinerOf("upsert_thought").startsWith("025") && lastDefinerOf("thoughts_write_audit").startsWith("025"),
         `021 is the last definer of update_thought, 025 of upsert_thought (its 3-argument body carries 022's chunk rule and 021's label) and 025 of the audit trigger (it carries 010's body and diffs provenance) (${lastDefinerOf("update_thought")}, ${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("thoughts_write_audit")})`);

  // The trap: 018 re-applied by hand puts the 7-argument form back BESIDE the
  // eight-argument one, and a 7-argument call is ambiguous. 021 re-applied
  // drops it again.
  await reapply("018");
  assert((await functionsNamed("update_thought")) === 2, "re-applying 018 over 021 creates a second update_thought");
  let ambiguous = "";
  try { await db.query(`SELECT update_thought($1::uuid, 'x', NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb)`, [labelled]); }
  catch (e) { ambiguous = (e as Error).message; }
  assert(/not unique/.test(ambiguous), `…after which a 7-argument call is "function is not unique" (${ambiguous.slice(0, 60)})`);
  await restoreShipped("update_thought", "upsert_thought");
  assert((await functionsNamed("update_thought")) === 1, "…and re-applying 021 drops the 7-argument form again");

  // The ACL survives the DROP, as 020's does ([21]): 018's form back and
  // hardened, 021 applied for the first time, the new form's ACL read.
  const acl = async (sig: string) => String((await db.query<{ a: string | null }>(`SELECT proacl::text AS a FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0]?.a ?? "");
  const hasPublic = (a: string) => /(^\{|,)=X\//.test(a);
  assert((await acl(UT)) === "", "the shipped function has default privileges — a NULL ACL");
  const pre021 = async () => { await db.exec(`DROP FUNCTION ${UT}`); await reapply("018"); };
  await db.exec(`CREATE ROLE ob1_test_editor`);
  await pre021();
  await db.exec(`REVOKE ALL ON FUNCTION ${UT_7} FROM PUBLIC`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${UT_7} TO ob1_test_editor WITH GRANT OPTION`);
  await restoreShipped("update_thought", "upsert_thought");
  const granted = await acl(UT);
  assert(!hasPublic(granted) && /ob1_test_editor=X\*\//.test(granted), `a revoke and a grant with grant option on the 7-argument form are carried to the eight-argument one (${granted})`);
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ob1_test_editor`);
  await pre021();
  assert(/ob1_test_editor=X\//.test(await acl(UT_7)), "default privileges give a re-created 7-argument form EXECUTE for the role");
  await db.exec(`REVOKE ALL ON FUNCTION ${UT_7} FROM ob1_test_editor`);
  await restoreShipped("update_thought", "upsert_thought");
  const stripped = await acl(UT);
  assert(!/ob1_test_editor/.test(stripped) && hasPublic(stripped), `a role the defaults grant to but the old form had revoked is revoked on the new form too (${stripped})`);
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ob1_test_editor`);
  await db.exec(`REVOKE ALL ON FUNCTION ${UT} FROM PUBLIC`);
  await reapply("018");
  // Both names: restoring update_thought re-runs 021 whole, and 021's CREATE
  // OR REPLACE puts its 3-argument upsert_thought back over 022's.
  await restoreShipped("update_thought", "upsert_thought");
  const kept = await acl(UT);
  assert(!hasPublic(kept) && (await functionsNamed("update_thought")) === 1, `a re-run of 021 over the two-form state drops the 7-argument form and leaves the hardened eight-argument form's ACL alone (${kept})`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${UT} TO PUBLIC`);
  await db.exec(`DROP ROLE ob1_test_editor`);
  await db.exec(`DELETE FROM thoughts`);
}

// ── 23. Migration 022 — the windows stay while the label vouches for them ────
//
// The 3-argument upsert_thought replaced the parent's vector and label on a
// re-capture and left 007's chunk rows as they were: a thought captured with
// windows and re-captured at another model through a path that made none
// (the Edge server, a window that grew) was found by windows of a vector it no
// longer had — and since 021 under a label that said it was at the new model.
// The same re-capture at the SAME model leaves windows that are still that
// model's vectors of this text, and 022 keeps those. The chunk row is planted
// directly, as [8b] does: PGlite cannot run the 4-argument insert.

console.log("\n[23] Migration 022: a re-capture's windows stay while the label vouches for them, and go when it does not");
{
  await db.exec(`DELETE FROM thoughts`);
  const UP3 = "upsert_thought(text, jsonb, vector)";
  const bodyOf = async (sig: string) => (await db.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0].src;
  const capture = async (content: string, payload: Record<string, unknown>, vec: string | null) =>
    (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(payload), vec])).rows[0].r.id;
  const rowOf = async (id: string) =>
    (await db.query<{ model: string | null; axis: number | null; metadata: Record<string, unknown>; windows: number }>(
      `SELECT embedding_model AS model, array_position(embedding::real[], 1::real) - 1 AS axis, metadata,
              (SELECT count(*)::int FROM thought_chunks c WHERE c.thought_id = t.id) AS windows
       FROM thoughts t WHERE id = $1`, [id])).rows[0];
  const plant = (id: string) =>
    db.query(`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES ($1, 0, 'window', $2::vector)`, [id, unit(1)]);

  const id = await capture("a long capture", { metadata: {}, embedding_model: "model-a" }, unit(0));
  await plant(id);
  let row = await rowOf(id);
  assert(row.windows === 1 && row.model === "model-a" && row.axis === 0, `a thought at model-a with one window (${row.windows} window, ${row.model})`);

  await capture("a long capture", { metadata: {}, embedding_model: "model-a" }, unit(1));
  row = await rowOf(id);
  assert(row.windows === 1 && row.model === "model-a" && row.axis === 1,
         `a re-capture with a vector and no chunks at the SAME model moves the vector and keeps the windows — still that model's vectors of this text (${row.windows} window, axis ${row.axis})`);

  await capture("a long capture", { metadata: {}, embedding_model: "model-b" }, unit(2));
  row = await rowOf(id);
  assert(row.windows === 0 && row.model === "model-b" && row.axis === 2,
         `…at ANOTHER model it removes the windows as it moves the vector and label (${row.windows} windows, ${row.model}, axis ${row.axis})`);

  await plant(id);
  await capture("a long capture", { metadata: {} }, unit(3));
  row = await rowOf(id);
  assert(row.windows === 0 && row.model === null && row.axis === 3, `…and one naming no model removes them too: an unknown model vouches for nothing (${row.windows} windows, ${row.model})`);
  await plant(id);
  await capture("a long capture", { metadata: {}, embedding_model: "model-c" }, unit(4));
  row = await rowOf(id);
  assert(row.windows === 0 && row.model === "model-c", `…as does one arriving over a row whose label is unknown (${row.windows} windows)`);

  await plant(id);
  await capture("a long capture", { metadata: { k: 1 }, embedding_model: "model-z" }, null);
  row = await rowOf(id);
  assert(row.windows === 1 && row.model === "model-c" && row.axis === 4 && row.metadata.k === 1,
         `a re-capture with NO vector keeps the windows with the vector and its label, whatever label it names (${row.windows} window, ${row.model})`);
  await db.query(`SELECT upsert_thought('a long capture', '{"metadata":{"k":2}}'::jsonb)`);
  row = await rowOf(id);
  assert(row.windows === 1 && row.metadata.k === 2, "…as does a metadata-only 2-argument re-capture");

  const fresh = await capture("a fresh capture", { metadata: {} }, unit(5));
  row = await rowOf(fresh);
  assert(row.windows === 0 && row.axis === 5, "a first capture with a vector has nothing to remove and stores as before");

  // The body: 021's, plus the locked read and the block. The rule itself is
  // proved by the cases above; asserted here are the sentinel a successor must
  // keep and the one fact behaviour cannot show — that the label is read from
  // the row LOCKED, so the INSERT lands on the row whose label was read.
  const up = await bodyOf(UP3);
  assert(/ob1:vector-replaces-chunks/.test(up), "the 3-argument body carries the ob1:vector-replaces-chunks sentinel");
  assert(/content_fingerprint = v_fingerprint FOR NO KEY UPDATE/.test(up) && !/WITH before AS/.test(up), "…and reads the row's label FOR NO KEY UPDATE — locked against update_thought, not against the foreign keys' KEY SHARE — not at the statement's snapshot");
  assert(/jsonb_typeof\(p_payload\) <> 'object'/.test(up) && /set_config\('ob1\.actor'/.test(up) && /p_payload->>'embedding_model'/.test(up) && /ELSE EXCLUDED\.embedding_model END/.test(up),
         "…carrying 005's guard, 008's actor and 021's label in the INSERT and the ON CONFLICT clause");
  const up4 = await bodyOf("upsert_thought(text, jsonb, vector, jsonb)");
  assert(!/ob1:vector-replaces-chunks/.test(up4) && /elem->>'context'/.test(up4) && /DELETE FROM thought_chunks WHERE thought_id = v_id/.test(up4),
         "the 4-argument form is 013's, untouched: it delegates here and replaces the windows with the caller's");
  assert((await functionsNamed("upsert_thought")) === 3, "still exactly three upsert_thought overloads");
  assert(lastDefinerOf("upsert_thought").startsWith("025"), `025 is the last definer of upsert_thought (it carries 022's body and adds the provenance envelope) (${lastDefinerOf("upsert_thought")})`);

  // The trap: 021 re-applied by hand puts 021's 3-argument body back, and the
  // defect with it — which is what preflight's `atomic capture` reads the
  // sentinel for.
  await reapply("021");
  assert(!/ob1:vector-replaces-chunks/.test(await bodyOf(UP3)), "021 re-applied over 022 puts 021's body back — the sentinel is gone");
  // The window the vectorless re-captures kept is still there.
  await capture("a long capture", { metadata: {}, embedding_model: "model-d" }, unit(6));
  row = await rowOf(id);
  assert(row.windows === 1 && row.model === "model-d" && row.axis === 6, `…and a re-capture at another model leaves the windows under the moved vector again (${row.windows} window at model-d)`);
  await restoreShipped("upsert_thought");
  assert(/ob1:vector-replaces-chunks/.test(await bodyOf(UP3)), "022 re-applied: the sentinel is back");
  await capture("a long capture", { metadata: {}, embedding_model: "model-e" }, unit(7));
  row = await rowOf(id);
  assert(row.windows === 0 && row.model === "model-e", `…and the next re-capture at another model removes them (${row.windows} windows)`);
  assert((await functionsNamed("upsert_thought")) === 3, "…with three overloads throughout");
  await db.exec(`DELETE FROM thoughts`);
}

// Migration 023 — 003's missing backfill. Rows planted around upsert_thought
// with NULL fingerprints, as a pre-003 brain or a raw load leaves them; then
// the one call, and the rule: a singleton takes its key, the oldest of a twin
// group takes it (created_at then id, NULL created_at last), a row whose key
// another row holds — the same text under a fingerprint, or a stale key —
// stays NULL. The concurrent half — a capture and an edit waiting on the
// table lock — is db/test-live.ts [6c], which PGlite's single session
// cannot run.
console.log("\n[24] Migration 023: every legacy singleton, and the oldest of each twin group, takes its fingerprint once");
{
  await db.exec(`DELETE FROM thoughts`);
  const legacy = async (content: string, createdAt: string | null) =>
    (await db.query<{ id: string }>(
      `INSERT INTO thoughts (content, content_fingerprint, embedding, created_at) VALUES ($1, NULL, $2::vector, $3::timestamptz) RETURNING id`,
      [content, unit(0), createdAt])).rows[0].id;
  const fp = async (id: string) =>
    (await db.query<{ fp: string | null }>(`SELECT content_fingerprint AS fp FROM thoughts WHERE id = $1`, [id])).rows[0].fp;
  const stamps = async () =>
    JSON.stringify((await db.query<{ id: string; u: string }>(`SELECT id, updated_at::text AS u FROM thoughts ORDER BY id`)).rows);
  const rows = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts`)).rows[0].c;
  const audit = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).rows[0].c;
  const backfill = async (limit: number | null = null) =>
    (await db.query<{ n: number }>(`SELECT backfill_content_fingerprints($1) AS n`, [limit])).rows[0].n;

  const singleton = await legacy("Only Once", "2024-01-01");
  const twinOld = await legacy("Same Text", "2024-01-01");
  const twinNew = await legacy("same   text", "2024-06-01");
  const rawUndated = await legacy("Raw Load", null);
  const rawDated = await legacy("raw  load", "2024-03-01");
  const captured = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought('a fingerprinted note', '{}'::jsonb) AS r`)).rows[0].r.id;
  const owned = await legacy("A Fingerprinted Note", "2020-01-01");
  const holder = await legacy("what it used to say", "2024-01-01");
  await db.query(`UPDATE thoughts SET content_fingerprint = content_fingerprint_of('held key text') WHERE id = $1`, [holder]);
  const blocked = await legacy("held key text", "2024-01-01");
  const total = await rows();
  const stampsBefore = await stamps();
  const auditBefore = await audit();

  const found = await backfill();
  assert(found === 3, `the call finds and writes the singleton, the oldest twin and the oldest dated raw row — three rows (${found})`);
  assert((await fp(singleton)) === (await fpOf("Only Once")), "a legacy singleton takes its fingerprint");
  assert((await fp(twinOld)) === (await fpOf("Same Text")) && (await fp(twinNew)) === null, "of two legacy twins the older takes the key and the newer stays NULL — the state 018 leaves after a pass");
  assert((await fp(rawDated)) === (await fpOf("Raw Load")) && (await fp(rawUndated)) === null, "a row with no created_at sorts last: the dated twin takes the key");
  assert((await fp(owned)) === null && (await fp(captured)) === (await fpOf("a fingerprinted note")), "a NULL row whose text a fingerprinted row already holds stays NULL, however old — the key is taken");
  assert((await fp(blocked)) === null && (await fp(holder)) === (await fpOf("held key text")), "a NULL row whose key a STALE holder carries stays NULL, and the stale key is not touched — 018's fingerprint_held_by case, not re-decided here");
  assert((await stamps()) === stampsBefore, "no row's updated_at moves — the fingerprint is not an edit");
  assert((await audit()) === auditBefore, "…and no audit row is written: 008 diffs content, metadata and the vector's presence");
  const [trg] = (await db.query<{ e: string }>(`SELECT tgenabled AS e FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_updated_at'`)).rows;
  assert(trg.e === "O", `…and the updated_at trigger is enabled again afterwards (${trg.e})`);

  // The defect, gone: a capture of the former singleton's text merges into it.
  const merged = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought('only  once', '{"metadata":{"k":1}}'::jsonb) AS r`)).rows[0].r.id;
  assert(merged === singleton && (await rows()) === total, `a capture of a former singleton's text merges into it instead of inserting a second row (${await rows()} rows)`);
  // 018 still agrees about the twins.
  const edit = (await db.query<{ r: { ok: boolean; duplicate_of?: string } }>(
    `SELECT update_thought($1::uuid, 'same   text', NULL::jsonb, $2::vector, NULL::jsonb, NULL::timestamptz) AS r`, [twinNew, unit(1)])).rows[0].r;
  assert(edit.ok === true && edit.duplicate_of === twinOld, `an unchanged edit of the newer twin reports duplicate_of the older — the row this migration gave the key to (${JSON.stringify(edit)})`);
  assert((await backfill()) === 0, "a second call writes nothing: only NULL rows whose key is free qualify");

  // p_limit: batches for the by-hand path, and 0 means none remain — the
  // NOT EXISTS is inside the limited set, so blocked rows never fill a batch.
  await legacy("batch one", "2024-01-01");
  await legacy("batch two", "2024-01-02");
  assert((await backfill(1)) === 1 && (await backfill(1)) === 1 && (await backfill(1)) === 0, "p_limit bounds each call, and the third returns 0 with the rows another row blocks still NULL");
  let refused = "";
  try { await backfill(0); } catch (e) { refused = (e as Error).message; }
  assert(/p_limit must be at least 1/.test(refused), `p_limit 0 is refused before anything is locked — 0 is the answer, never the question (${refused.slice(0, 60)})`);
  assert((await functionsNamed("backfill_content_fingerprints")) === 1, "one backfill_content_fingerprints");
  // The file's own call takes {{BACKFILL_LIMIT}}: NULL unless OB1_BACKFILL_LIMIT
  // is set for the migrator's run — the same channel as {{TRGM_INDEX}}, run-
  // scoped and validated in config.mjs.
  await legacy("batch three", "2024-01-03");
  await legacy("batch four", "2024-01-04");
  const file023 = readFileSync(join(MIGRATIONS, files.find((x) => x.startsWith("023"))!), "utf8");
  assert(/\{\{BACKFILL_LIMIT\}\}/.test(file023) && /backfill_content_fingerprints\(NULL\);/.test(subst(file023)), "the file's call is the template variable, NULL by default");
  await db.exec(substituteMigration(file023, migrationValues({ dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, trgm: DEFAULT_TRGM_INDEX, backfillLimit: 1 })));
  const nullBatches = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts WHERE content LIKE 'batch %' AND content_fingerprint IS NULL`)).rows[0].c;
  assert((await nullBatches()) === 1, "023 applied with OB1_BACKFILL_LIMIT=1 writes one batch of one and leaves the other waiting");
  let badLimit = "";
  try { resolveBackfillLimit("10k"); } catch (e) { badLimit = (e as Error).message; }
  let bigLimit = "";
  try { resolveBackfillLimit("3000000000"); } catch (e) { bigLimit = (e as Error).message; }
  assert(/OB1_BACKFILL_LIMIT must be a whole number/.test(badLimit) && /at most 2147483647/.test(bigLimit) && resolveBackfillLimit("") === null && resolveBackfillLimit("25") === 25,
         "a limit that is not a whole number, or past int4, is refused naming the variable; unset is every row");
  const idx = (await db.query<{ d: string }>(`SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'ob1_fp_backfill_idx'`)).rows[0]?.d ?? "";
  assert(/content_fingerprint_of\(content\)/.test(idx) && /WHERE \(content_fingerprint IS NULL\)/.test(idx), `the partial expression index over the rows without a key is built (${idx.slice(0, 80)})`);
  const stampsNow = await stamps();
  await reapply("023");
  assert((await nullBatches()) === 0 && (await stamps()) === stampsNow && (await backfill()) === 0,
         "023 re-applied with the variable unset takes the rest, and a further call writes nothing and moves nothing");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 25. Migration 025: derivation and supersession are recorded, and the self-FK clears not cascades ──

console.log("\n[25] Migration 025: derived_from / supersedes, their constraints, and the read-back functions");
{
  // The self-FK's delete action. confdeltype 'n' = SET NULL — the one that keeps
  // a superseded thought hard-deletable (009) while its successor survives. 'c'
  // (CASCADE) would delete the successor; 'r'/'a' (RESTRICT/NO ACTION) would
  // refuse the delete. See migration 025 departure 4.
  const fk = (await db.query<{ deltype: string; deltype_full: string }>(
    `SELECT confdeltype AS deltype FROM pg_constraint WHERE conname = 'thoughts_supersedes_fkey'`)).rows[0];
  assert(fk?.deltype === "n", `supersedes is a self-FK ON DELETE SET NULL (confdeltype ${fk?.deltype})`);

  // The array-shape CHECK. Element-level UUID + existence is upsert_thought's,
  // not a constraint (departure 3).
  const chk = (await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_constraint WHERE conname = 'thoughts_derived_from_is_array' AND contype = 'c'`)).rows[0].c;
  assert(chk === 1, "derived_from carries the array-shape CHECK");

  // The read-back functions exist, one of each, at their shipped arity.
  assert((await functionsNamed("trace_provenance")) === 1, "trace_provenance is defined");
  assert((await functionsNamed("find_derivatives")) === 1, "find_derivatives is defined");
  const tp = (await db.query<{ n: number }>(`SELECT pronargs AS n FROM pg_proc WHERE oid = 'trace_provenance(uuid, int, int)'::regprocedure`)).rows[0];
  assert(Number(tp?.n) === 3, `…trace_provenance takes (uuid, int, int) (${tp?.n} args)`);
  const fd = (await db.query<{ n: number }>(`SELECT pronargs AS n FROM pg_proc WHERE oid = 'find_derivatives(uuid, int)'::regprocedure`)).rows[0];
  assert(Number(fd?.n) === 2, `…find_derivatives takes (uuid, int) (${fd?.n} args)`);

  // 026 (SMD-1288) redefines trace_provenance to bound its WORK: the per-path
  // recursive CTE (whose visited guard bounds cycles and whose outer LIMIT
  // bounds output, but neither the intermediate work) becomes an iterative,
  // walk-global breadth-first walk that expands each node once. The shape must
  // actually have changed — no `WITH RECURSIVE` — and the body must carry the
  // ob1:provenance-walk-bounded sentinel a successor has to keep.
  assert(lastDefinerOf("trace_provenance").startsWith("026"),
    `026 is the last definer of trace_provenance (it bounds the walk's work) (${lastDefinerOf("trace_provenance")})`);
  // An earlier section's restoreShipped("upsert_thought") re-ran the whole 025
  // file (025 is upsert_thought's last definer), and 025 still carries the OLD
  // trace_provenance body — so re-applying it reverted 026's here. Restore the
  // shipped (026) body before inspecting it. This is the fork's own trap in
  // miniature: CREATE OR REPLACE takes the whole file, so re-applying an earlier
  // migration out of order clobbers a later redefinition (production applies
  // 001→026 in order and is unaffected).
  await restoreShipped("trace_provenance");
  const tpBody = (await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'trace_provenance(uuid, int, int)'::regprocedure`)).rows[0].s;
  assert(/ob1:provenance-walk-bounded/.test(tpBody), "trace_provenance carries the ob1:provenance-walk-bounded sentinel");
  assert(!/WITH\s+RECURSIVE/i.test(tpBody), "…and no longer uses a recursive CTE — the walk-global shape SMD-1288 required");

  // The write path validates derived_from — the choke point, or an untrusted
  // hole (departure 3). A non-UUID element is refused; an array of existing ids
  // is accepted and read back both ways. The capture path always carries a
  // vector, so this uses the 3-argument form; the 2-argument legacy overload
  // (003) is not a capture path and is left as it was.
  const cap = async (content: string, env: Record<string, unknown>, at: number) =>
    (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`,
      [content, JSON.stringify(env), unit(at)])).rows[0].r.id;
  const parent = await cap("a source observation", { metadata: { type: "observation" } }, 0);
  let bad = "";
  try { await cap("a synthesis of nonsense", { metadata: {}, derived_from: ["not-a-uuid"] }, 1); }
  catch (e) { bad = (e as Error).message; }
  assert(/derived_from must contain only thought UUID strings/.test(bad), "a non-UUID derived_from element is refused at the write");
  let missing = "";
  try { await cap("a synthesis of a ghost", { metadata: {}, derived_from: ["11111111-1111-1111-1111-111111111111"] }, 2); }
  catch (e) { missing = (e as Error).message; }
  assert(/derived_from references a thought that does not exist/.test(missing), "…and a derived_from that names no existing thought is refused");

  const child = await cap("a synthesis of the source",
    { metadata: { type: "synthesis", derivation_method: "synthesis" }, derived_from: [parent], supersedes: parent }, 3);
  const up = (await db.query<{ df: unknown; s: string }>(`SELECT derived_from AS df, supersedes AS s FROM thoughts WHERE id = $1`, [child])).rows[0];
  assert(Array.isArray(up.df) && (up.df as string[])[0] === parent && up.s === parent, "a validated capture writes derived_from and supersedes");
  const anc = await db.query<{ thought_id: string; depth: number }>(`SELECT thought_id, depth FROM trace_provenance($1::uuid)`, [child]);
  assert(anc.rows.some((r) => r.thought_id === child && r.depth === 0) && anc.rows.some((r) => r.thought_id === parent && r.depth === 1),
         "trace_provenance walks UP to the source");
  const der = await db.query<{ id: string }>(`SELECT id FROM find_derivatives($1::uuid)`, [parent]);
  assert(der.rows.some((r) => r.id === child), "find_derivatives walks DOWN to the synthesis");

  // The self-FK's SET NULL: deleting the source clears the successor's pointer,
  // the successor survives, and the derived_from GIN row is left as-is (the
  // ancestor id lingers there deliberately — derived_from is a historical
  // record, not a live FK; only supersedes is enforced). Full delete behaviour
  // (the audit row) is db/test-live.ts's, against a real Postgres.
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [parent]);
  const after = (await db.query<{ c: number; s: string | null }>(
    `SELECT count(*)::int AS c, max(supersedes::text) AS s FROM thoughts WHERE id = $1`, [child])).rows[0];
  assert(after.c === 1 && after.s === null, "deleting the superseded source nulls the successor's supersedes and leaves it standing");

  await db.exec(`DELETE FROM thoughts`);
}

// ── 26. Migration 027: admission relative to the top match (SMD-1300) ─────────

console.log("\n[26] Migration 027: search_thoughts_hybrid admits relative to the top match (SMD-1300)");
{
  await db.exec(`DELETE FROM thoughts`);
  // 027 replaces 020's absolute 0.5 cosine floor — which drops the right answer
  // on a long capture, whose short-question cosine is 0.2–0.4 — with a cutoff
  // RELATIVE to the top candidate: admit the strongest match and every row
  // within half of it. The shape must actually have changed (the ob1:relative-
  // floor sentinel, the v_relfloor * top comparison), and 027 must be the last
  // definer.
  assert(lastDefinerOf("search_thoughts_hybrid").startsWith("027"),
    `027 is the last definer of search_thoughts_hybrid (${lastDefinerOf("search_thoughts_hybrid")})`);
  // [20] re-applied 020's file to test the recency blend, and 020 defines
  // search_thoughts_hybrid too — so the shipped (027) body was reverted here.
  // Restore it before inspecting or exercising it. Same trap SMD-1299 tracks:
  // restoreShipped re-runs a whole file, and re-applying an earlier migration
  // out of order clobbers a later redefinition (production applies 001→027 in
  // order and is unaffected).
  await restoreShipped("search_thoughts_hybrid");
  const body = (await db.query<{ s: string }>(
    `SELECT prosrc AS s FROM pg_proc WHERE oid = 'search_thoughts_hybrid(vector, text, float, int, jsonb, float, float)'::regprocedure`)).rows[0].s;
  assert(/ob1:relative-floor/.test(body), "search_thoughts_hybrid carries the ob1:relative-floor sentinel a successor must keep");
  assert(/v_relfloor\s*\*\s*GREATEST\(ts\.top, 0\.0\)/.test(body),
    "…and admits relative to the top candidate's similarity (v_relfloor * GREATEST(top, 0))");
  assert((await functionsNamed("search_thoughts_hybrid")) === 1,
    "one search_thoughts_hybrid — 027 replaced the same signature, it did not overload");

  // A query whose whole candidate set scores BELOW the old 0.5 floor — the long-
  // capture case. Three rows at known cosines to the query unit(0):
  //   top 0.30 · near 0.18 (≥ 0.5×top, kept) · far 0.10 (< 0.5×top, trimmed).
  await db.query(`SELECT upsert_thought('the strongest but still low match', '{"metadata":{}}'::jsonb, $1::vector)`, [blend(0, 1, 0.30, 0.9539)]);
  await db.query(`SELECT upsert_thought('within half of the top', '{"metadata":{}}'::jsonb, $1::vector)`, [blend(0, 1, 0.18, 0.9837)]);
  await db.query(`SELECT upsert_thought('far below the top', '{"metadata":{}}'::jsonb, $1::vector)`, [blend(0, 1, 0.10, 0.9950)]);

  // The tools now send threshold 0, so the relative cutoff governs: the top two
  // are admitted and the far row trimmed — where the old 0.5 floor dropped all
  // three. A plain question carries no needle, so nothing is rescued by the
  // keyword arm; this is the pure vector path.
  const rel = (await db.query<{ content: string; similarity: number }>(
    `SELECT content, similarity FROM search_thoughts_hybrid($1::vector, 'a plain question with no identifiers', 0.0, 10, '{}'::jsonb)`, [unit(0)])).rows;
  assert(rel.length === 2, `threshold 0 admits the top and its near neighbour, not the far row (got ${rel.length})`);
  assert(rel.some((r) => r.content === "the strongest but still low match") && rel.some((r) => r.content === "within half of the top"),
    "the top match and the row within half of it are both returned — the long-capture fix");
  assert(!rel.some((r) => r.content === "far below the top"), "the row below half the top's similarity is trimmed");
  assert(Math.abs(rel[0].similarity - 0.30) < 0.02, `the % match stays the raw cosine (~0.30, got ${rel[0].similarity})`);

  // The absolute floor is still available as an explicit tightening: at 0.5 none
  // of these clear it, so the set is empty — what a caller who really wants a
  // hard floor still gets.
  const abs = (await db.query(
    `SELECT content FROM search_thoughts_hybrid($1::vector, 'a plain question with no identifiers', 0.5, 10, '{}'::jsonb)`, [unit(0)])).rows;
  assert(abs.length === 0, `a caller can still impose a hard absolute floor (0.5 excludes every sub-floor row here, got ${abs.length})`);

  // A mixed query (a needle + words). The keyword arm is floor-exempt, but the
  // yardstick for the vector rows is the vector arm's top, so an incidental
  // keyword hit does not raise the bar and trim a genuine low-cosine vector row.
  // Here the needle hit and the top vector row are the same row at 0.30; a
  // needle-free vector row at 0.18 (≥ 0.5×0.30) is still admitted, and a 0.08
  // row is trimmed.
  await db.exec(`DELETE FROM thoughts`);
  await db.query(`SELECT upsert_thought('SMD-100 the honda note', '{"metadata":{}}'::jsonb, $1::vector)`, [blend(0, 1, 0.30, 0.9539)]);
  await db.query(`SELECT upsert_thought('a long transcript about the car', '{"metadata":{}}'::jsonb, $1::vector)`, [blend(0, 1, 0.18, 0.9837)]);
  await db.query(`SELECT upsert_thought('an unrelated note', '{"metadata":{}}'::jsonb, $1::vector)`, [blend(0, 1, 0.08, 0.9968)]);
  const mixed = (await db.query<{ content: string; matched_needles: string[] }>(
    `SELECT content, matched_needles FROM search_thoughts_hybrid($1::vector, 'which car did I buy SMD-100', 0.0, 10, '{}'::jsonb)`, [unit(0)])).rows;
  const mnames = mixed.map((r) => r.content);
  assert(mnames.includes("SMD-100 the honda note") && mnames.includes("a long transcript about the car") && !mnames.includes("an unrelated note"),
    `a keyword hit does not raise the bar: the needle row and the low-cosine vector row within half of the vector top are both kept, the 0.08 row trimmed (${mnames.join(" | ")})`);
  assert(mixed.find((r) => r.content === "SMD-100 the honda note")?.matched_needles.join() === "SMD-100",
    "the needle row reports its matched needle");
  assert(mixed.find((r) => r.content === "a long transcript about the car")?.matched_needles.length === 0,
    "the low-cosine vector row is admitted by the relative cutoff, not by any needle");

  await db.exec(`DELETE FROM thoughts`);
}

// ── 27. Migration 028: the caveat rule is stated at the table (SMD-1052) ──────

console.log("\n[27] Migration 028: thought_work_claims.last_error and release_thought carry the caveat rule (SMD-1052)");
{
  // SMD-1021 gave last_error a second meaning — on a succeeded row, when set, a
  // caveat: the write stands, and this is what the worker could not do — and
  // reembed.ts reads every such row through one predicate (withCaveat) for the
  // count, the list and --retry-fallbacks. Until 028 the schema said nothing:
  // 015 commented work_type, worker_id and attempt_count and not this column,
  // and release_thought's comment did not mention p_error at all. A reader of
  // the table (\d+, a future consumer) must be able to learn the rule from the
  // table, so both comments are asserted here rather than trusted to prose.
  const colComment = (await db.query<{ c: string | null }>(
    `SELECT col_description('thought_work_claims'::regclass, a.attnum) AS c
       FROM pg_attribute a WHERE a.attrelid = 'thought_work_claims'::regclass AND a.attname = 'last_error'`)).rows[0]?.c ?? "";
  assert(colComment.length > 0, "thought_work_claims.last_error carries a comment");
  assert(/failed row:\s*why it failed/i.test(colComment), "…that gives the failed-row meaning (why it failed)");
  assert(/succeeded row, when set:.*caveat.*the write stands.*what the worker could not do/is.test(colComment),
    "…and the succeeded-row meaning: when set, a caveat — the write stands, and this is what the worker could not do");
  assert(/NULL on a succeeded row is a clean success/.test(colComment), "…and what NULL means on a succeeded row");
  assert(/--retry-fallbacks returns it to the pool/.test(colComment) && /must not store any other note here on success/.test(colComment),
    "…and the consequence for a consumer: every non-NULL note on a succeeded row is read as a caveat and returned by --retry-fallbacks");

  const fnComment = (await db.query<{ c: string | null }>(
    `SELECT obj_description('release_thought(uuid, text, text, text, text)'::regprocedure, 'pg_proc') AS c`)).rows[0]?.c ?? "";
  assert(/Only the holder of a still-claimed row may; returns false otherwise/.test(fnComment), "release_thought's comment keeps 015's sentence (the holder rule)");
  assert(/p_error is stored in last_error whatever p_status is/.test(fnComment), "…and says p_error is stored whatever the status");
  assert(/on succeeded, when given, a caveat.*the write stands/is.test(fnComment) && /Pass NULL for a clean success/.test(fnComment),
    "…what it means on success, and what to pass for a clean one");

  // The last migration to comment release_thought must carry the p_error
  // sentence: CREATE OR REPLACE keeps a comment, but a redefinition that
  // re-issues 015's one-sentence COMMENT (SMD-1043 is the candidate) would
  // silently drop it — the trap 028's header names.
  const commentRe = /^\s*COMMENT ON FUNCTION (?:public\.)?release_thought\(/m;
  const lastCommenter = [...files].reverse().find((x) => commentRe.test(readFileSync(join(MIGRATIONS, x), "utf8")))!;
  assert(lastCommenter.startsWith("028"), `028 is the last migration to comment release_thought (${lastCommenter})`);
  const colRe = /^\s*COMMENT ON COLUMN (?:public\.)?thought_work_claims\.last_error\s/m;
  const lastColCommenter = [...files].reverse().find((x) => colRe.test(readFileSync(join(MIGRATIONS, x), "utf8")))!;
  assert(lastColCommenter.startsWith("028"), `028 is the last migration to comment thought_work_claims.last_error (${lastColCommenter})`);

  // The fact the comments state, exercised: a release with p_error on a
  // SUCCEEDED row stores it (the caveat), on a failed row stores it (the
  // error), and a NULL leaves the column NULL — the shape withCaveat() reads.
  await db.exec(`DELETE FROM thoughts`);
  const JOB = "test:caveat";
  const [a, b, c] = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content) VALUES ('caveat probe a'), ('caveat probe b'), ('caveat probe c') RETURNING id`)).rows.map((r) => r.id);
  await db.query(`SELECT enqueue_thoughts($1, $2::uuid[])`, [JOB, [a, b, c]]);
  const leased = (await db.query<{ thought_id: string }>(`SELECT thought_id FROM claim_thoughts($1, 'W', 3, 900, 3)`, [JOB])).rows.map((r) => r.thought_id);
  assert(leased.length === 3, `the probe rows are leased (${leased.length} of 3)`);
  await db.query(`SELECT release_thought($1::uuid, $2, 'W', 'succeeded', 'stored the head window: provider refused the whole content (413)')`, [a, JOB]);
  await db.query(`SELECT release_thought($1::uuid, $2, 'W', 'succeeded', NULL)`, [b, JOB]);
  await db.query(`SELECT release_thought($1::uuid, $2, 'W', 'failed', 'provider 500')`, [c, JOB]);
  const rows = (await db.query<{ thought_id: string; status: string; last_error: string | null }>(
    `SELECT thought_id, status, last_error FROM thought_work_claims WHERE work_type = $1`, [JOB])).rows;
  const of = (id: string) => rows.find((r) => r.thought_id === id)!;
  assert(of(a).status === "succeeded" && /refused the whole content/.test(of(a).last_error ?? ""), "a succeeded release with p_error stores it: the row is succeeded AND carries the caveat");
  assert(of(b).status === "succeeded" && of(b).last_error === null, "a succeeded release with NULL is a clean success — last_error NULL");
  assert(of(c).status === "failed" && of(c).last_error === "provider 500", "a failed release stores the error, as 015 always did");
  const caveats = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM thought_work_claims WHERE work_type = $1 AND status = 'succeeded' AND last_error IS NOT NULL`, [JOB])).rows[0].n;
  assert(caveats === 1, `reembed.ts's withCaveat() predicate (succeeded AND last_error IS NOT NULL) finds exactly the caveat row (${caveats})`);
  await db.exec(`DELETE FROM thoughts`);
}

report();
