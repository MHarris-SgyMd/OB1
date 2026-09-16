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
  QUERY_LOG,
  UPDATE_THOUGHT_SIGNATURE,
  migrationValues,
  parseSetConfig,
  substituteMigration,
  DEFAULT_CHUNK_CONTEXT,
  resolveBackfillLimit,
  ACCEPTED_CAVEAT_PREFIX,
  CLAIM_EVIDENCE_ROWS_SQL,
  REEMBED_KEY_MODEL_SQL_RE,
  REEMBED_OWN_KEY_SQL_RE,
  RELEASE_SHIPPED_RE,
  THOUGHT_STATS_SHIPPED_RE,
  UPSERT_THREE_ARG_SHIPPED_RE,
  UPSERT_TWO_ARG_SHIPPED_RE,
  coreColumnCommentStatement,
  coreFunctionStatement,
  ownedColumnCommentsIn,
  ownedFunctionsIn,
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
  const stamps = () => db.query<{ c: string; u: number }>(`SELECT created_at::text c, extract(epoch FROM updated_at)::float8 u FROM thoughts`);
  const before = await stamps();
  // now() is read from a clock that under PGlite has millisecond grain
  // (SMD-1498); adjacent statements share it 96 of 100 times, and the two
  // stamps here are two statements apart. Without the sleep, review mutants
  // (SMD-1514) had a `>=` compare pass with the trigger dropped and a `>`
  // fail 1 run in 5. The row cannot be aged by an UPDATE while the trigger
  // under test is armed, so a sleep: pg_sleep is a wall-clock lower bound and
  // each statement its own transaction, so the UPDATE's now() is at least
  // 2 ms past the capture's — past the millisecond boundary.
  await db.exec(`SELECT pg_sleep(0.002)`);
  await db.exec(`UPDATE thoughts SET content = 'trigger probe edited'`);
  const after = await stamps();
  assert(after.rows[0].c === before.rows[0].c, "created_at unchanged");
  assert(after.rows[0].u > before.rows[0].u, `updated_at advanced (${before.rows[0].u.toFixed(3)} -> ${after.rows[0].u.toFixed(3)})`);
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
  assert(/FROM thoughts WHERE id = p_id FOR NO KEY UPDATE/.test(src), "…the row read FOR NO KEY UPDATE (018's FOR UPDATE, weakened by 032 for the FK's KEY SHARE), so \"unchanged\" is decided against a row that cannot change under the call");
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
  assert((await functionsNamed("update_thought")) === 1, "exactly one update_thought: 021 replaced the signature rather than adding an overload, and 032 again");
  const proc = (await db.query<{ n: number; src: string }>(`SELECT pronargs AS n, prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure`, [UT])).rows[0];
  assert(Number(proc?.n) === 9, `…of nine parameters since 032 (${proc?.n})`);
  for (const [re, what] of [
    [/ob1:unchanged-edit-not-duplicate/, "018's sentinel"], [/ob1\.actor/, "008's actor"], [/FROM thoughts WHERE id = p_id FOR NO KEY UPDATE/, "018's row lock, FOR NO KEY UPDATE since 032"],
    [/pg_advisory_xact_lock/, "018's advisory lock"], [/content_fingerprint_of\(/, "016's fingerprint function"], [/elem->>'context'/, "013's context"],
    [/date_trunc\('milliseconds'/, "009's guard"], [/jsonb_typeof\(p_payload\) <> 'object'/, null],
  ] as [RegExp, string | null][]) {
    if (what) assert(re.test(proc.src), `…carrying ${what}`);
  }
  const up = (await db.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE oid = 'upsert_thought(text, jsonb, vector)'::regprocedure`)).rows[0].src;
  assert(/jsonb_typeof\(p_payload\) <> 'object'/.test(up) && /set_config\('ob1\.actor'/.test(up) && /p_payload->>'embedding_model'/.test(up), "the 3-argument upsert_thought carries 005's guard and 008's actor beside the label");
  assert((await functionsNamed("upsert_thought")) === 3, "still exactly three upsert_thought overloads");
  assert(lastDefinerOf("update_thought").startsWith("033") && lastDefinerOf("upsert_thought").startsWith("035") && lastDefinerOf("thoughts_write_audit").startsWith("025"),
         `033 is the last definer of update_thought (it carries 032's body — 021's and the provenance envelope — with the fingerprint lock before the row), 035 of upsert_thought (its 3-argument body carries 022's chunk rule, 021's label and 025's envelope, takes the fingerprint lock and writes provenance on a first capture only), 025 of the audit trigger (it carries 010's body and diffs provenance) (${lastDefinerOf("update_thought")}, ${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("thoughts_write_audit")})`);

  // The trap: 018 re-applied by hand puts the 7-argument form back BESIDE the
  // current one, and a 7-argument call is ambiguous. The last definer (032)
  // re-applied drops it again — 021's file drops it too, but leaves its own
  // 8-argument form beside 032's; [32] holds that case.
  await reapply("018");
  assert((await functionsNamed("update_thought")) === 2, "re-applying 018 over the shipped form creates a second update_thought");
  let ambiguous = "";
  try { await db.query(`SELECT update_thought($1::uuid, 'x', NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb)`, [labelled]); }
  catch (e) { ambiguous = (e as Error).message; }
  assert(/not unique/.test(ambiguous), `…after which a 7-argument call is "function is not unique" (${ambiguous.slice(0, 60)})`);
  await restoreShipped("update_thought", "upsert_thought");
  assert((await functionsNamed("update_thought")) === 1, "…and re-applying the last definer drops the 7-argument form again");

  // The ACL survives the DROP, as 020's does ([21]): 018's form back and
  // hardened, the current form applied for the first time, its ACL read.
  // 032 reads the 7-argument form's ACL when no 8-argument one is there —
  // the fallback for exactly this state.
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
  assert(!hasPublic(granted) && /ob1_test_editor=X\*\//.test(granted), `a revoke and a grant with grant option on the 7-argument form are carried to the current one (${granted})`);
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
  // Both names, from when restoring update_thought re-ran 021 whole and 021's
  // CREATE OR REPLACE put its 3-argument upsert_thought back over 022's; the
  // last definer is 032 now, which touches no upsert_thought, and the pair is
  // kept so the section stays right if that changes again.
  await restoreShipped("update_thought", "upsert_thought");
  const kept = await acl(UT);
  assert(!hasPublic(kept) && (await functionsNamed("update_thought")) === 1, `a re-run of the last definer over the two-form state drops the 7-argument form and leaves the hardened current form's ACL alone (${kept})`);
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
  assert(lastDefinerOf("upsert_thought").startsWith("035"), `035 is the last definer of upsert_thought (it carries 033's body — 022's rule, 025's envelope, the fingerprint lock — and writes provenance on a first capture only) (${lastDefinerOf("upsert_thought")})`);

  // The trap: 021 re-applied by hand puts 021's 3-argument body back, and the
  // defect with it — which is what preflight's `atomic capture` reads the
  // sentinel for.
  await reapply("021");
  assert(!/ob1:vector-replaces-chunks/.test(await bodyOf(UP3)), "021 re-applied over 022 puts 021's body back — the sentinel is gone");
  // The window the vectorless re-captures kept is still there.
  await capture("a long capture", { metadata: {}, embedding_model: "model-d" }, unit(6));
  row = await rowOf(id);
  assert(row.windows === 1 && row.model === "model-d" && row.axis === 6, `…and a re-capture at another model leaves the windows under the moved vector again (${row.windows} window at model-d)`);
  // 021 re-applied also put its 8-argument update_thought back BESIDE 032's
  // (021 drops only the 7-argument form), so every call with eight arguments
  // or fewer is ambiguous until the last definer drops it again — [32] asserts
  // that state; here it is restored so the sections after this one can edit.
  assert((await functionsNamed("update_thought")) === 2, "…and 021's 8-argument update_thought is back beside 032's");
  await restoreShipped("update_thought", "upsert_thought");
  assert((await functionsNamed("update_thought")) === 1, "…until 032 is re-applied");
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
  // Until 033, an earlier section's restoreShipped("upsert_thought") re-ran
  // the whole 025 file (025 was upsert_thought's last definer), and 025 still
  // carries the OLD trace_provenance body — so re-applying it reverted 026's
  // here. 033 is the last definer now and touches no trace_provenance, but the
  // restore stays: it is cheap, and the trap comes back the day 025 is the
  // last definer of anything a section restores. The fork's own trap in
  // miniature: CREATE OR REPLACE takes the whole file, so re-applying an
  // earlier migration out of order clobbers a later redefinition (production
  // applies 001→026 in order and is unaffected).
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
  // reembed.ts reads every such row as one shape (withCaveat for the list and
  // --retry-fallbacks, a FILTER in counts()). Until 028 the schema said nothing:
  // 015 commented work_type, worker_id and attempt_count and not this column,
  // and release_thought's comment did not mention p_error at all. A reader of
  // the table (\d+, a future consumer) must be able to learn the rule from the
  // table, so both comments are asserted here rather than trusted to prose.
  //
  // The comment carries the DATA contract and points at reembed.ts's header for
  // reader behaviour — which readers, under which keys, what bounds an
  // acceptance, when a row returns — because that is the tools' contract and
  // changes with them (SMD-1311 already would); three review passes each
  // mis-stated one such detail in the literal before the fourth chose this
  // shape. So the anchors below are the rule's words, not reader mechanics
  // (SMD-1313 is the generic form of the live-text check).
  const colComment = (await db.query<{ c: string | null }>(
    `SELECT col_description('thought_work_claims'::regclass, a.attnum) AS c
       FROM pg_attribute a WHERE a.attrelid = 'thought_work_claims'::regclass AND a.attname = 'last_error'`)).rows[0]?.c ?? "";
  assert(colComment.length > 0, "thought_work_claims.last_error carries a comment");
  assert(/failed row:.*why it failed/is.test(colComment), "…that gives the failed-row meaning (why it failed)");
  assert(/succeeded row, when set:.*caveat/is.test(colComment) && /the write stands/.test(colComment) && /what the worker could not do/.test(colComment),
    "…and the succeeded-row meaning: when set, a caveat — the write stands, and this is what the worker could not do");
  assert(/NULL on a succeeded row is a clean success/.test(colComment), "…and what NULL means on a succeeded row");
  assert(/stores nothing else here on success/.test(colComment), "…and the rule as the column's: a consumer stores nothing else here on success");
  assert(/the tools'?'? contract, not the column'?'?s/.test(colComment) && /reembed\.ts'?'?s header/.test(colComment) && /db\/README\.md/.test(colComment),
    "…and sends a reader to reembed.ts's header and db/README.md for reader behaviour rather than restating it");
  assert(/021'?'?s evidence backfill/.test(colComment), "…and names the one consumer of succeeded rows that does not read it: 021's evidence backfill");
  // The accepted-row caveat is named by the constant that spells it, not by a
  // second copy of its text: the applied comment cannot follow a rewording of
  // ACCEPTED_CAVEAT_PREFIX, so the comment must not quote it.
  assert(/ACCEPTED_CAVEAT_PREFIX/.test(colComment) && !colComment.includes(ACCEPTED_CAVEAT_PREFIX.trim()),
    "…and names the acceptance prefix by its constant rather than quoting a second spelling of it");

  const fnComment = (await db.query<{ c: string | null }>(
    `SELECT obj_description('release_thought(uuid, text, text, text, text)'::regprocedure, 'pg_proc') AS c`)).rows[0]?.c ?? "";
  // 015's comment, whole — purpose, holder rule and the three-case enumeration —
  // so a successor that keeps only the middle clause is caught.
  assert(fnComment.includes("Mark one claim succeeded or failed. Only the holder of a still-claimed row may; returns false otherwise (expired and re-leased, deleted, or never held)."),
    "release_thought's comment keeps 015's text whole (purpose, holder rule, the three cases)");
  assert(/p_error is stored in last_error whatever p_status is/.test(fnComment), "…and says p_error is stored whatever the status");
  assert(/on succeeded, when given, a caveat/.test(fnComment) && /the write stands/.test(fnComment) && /Pass NULL for a clean success/.test(fnComment),
    "…what it means on success, and what to pass for a clean one");
  // [10] strips `--` to end of line before scanning the migrations, on the
  // stated assumption that no migration puts that sequence in a string literal
  // (SMD-1316 would make that strip literal-aware). Asserted of the LIVE text,
  // so it holds whichever file wrote the comment.
  assert(!/--/.test(colComment) && !/--/.test(fnComment), "neither comment carries `--`, so [10]'s comment-stripping scan reads every literal whole");
  // Those are checks of the LIVE text after every file has applied, so a later
  // migration that redefines release_thought and re-issues 015's one-sentence
  // COMMENT — CREATE OR REPLACE keeps a comment, a re-issued COMMENT replaces
  // it — fails here whichever file it is; no migration number is pinned.

  // The two facts the comments add, exercised — [15] covers the failed release
  // and the holder rule already. A release with p_error on a SUCCEEDED row
  // stores it (the caveat); a NULL leaves the column NULL (a clean success).
  await db.exec(`DELETE FROM thoughts`);
  const JOB = "test:caveat";
  const [a, b] = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content) VALUES ('caveat probe a'), ('caveat probe b') RETURNING id`)).rows.map((r) => r.id);
  await db.query(`SELECT enqueue_thoughts($1, $2::uuid[])`, [JOB, [a, b]]);
  const leased = (await db.query<{ thought_id: string }>(`SELECT thought_id FROM claim_thoughts($1, 'W', 2, 900, 3)`, [JOB])).rows.length;
  assert(leased === 2, `the probe rows are leased (${leased} of 2)`);
  await db.query(`SELECT release_thought($1::uuid, $2, 'W', 'succeeded', 'stored the head window: provider refused the whole content (413)')`, [a, JOB]);
  await db.query(`SELECT release_thought($1::uuid, $2, 'W', 'succeeded', NULL)`, [b, JOB]);
  const rowOf = async (id: string) =>
    (await db.query<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM thought_work_claims WHERE thought_id = $1 AND work_type = $2`, [id, JOB])).rows[0];
  const ra = await rowOf(a), rb = await rowOf(b);
  assert(ra.status === "succeeded" && /refused the whole content/.test(ra.last_error ?? ""), "a succeeded release with p_error stores it: the row is succeeded AND carries the caveat");
  assert(rb.status === "succeeded" && rb.last_error === null, "a succeeded release with NULL is a clean success — last_error NULL");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 28. Migration 029: supersession proposals — the candidate rule, the one
// write, the review path, the queue, and staleness (SMD-1294) ────────────────
//
// Everything except the model call, which db/test-live.ts [16] drives through
// the worker against a stub. The state machine here is what the ticket's
// Verify names: a proposal's states, the accept path writing supersedes with
// an audit row, a reject leaving thoughts untouched, and a decided pair never
// proposed again.

console.log("\n[28] Migration 029: supersession proposals — candidates, the one write, the review path, the queue, staleness (SMD-1294)");
{
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_entities`);
  const KEY = "consolidate:stub@p1";
  const EXTRACT = "extract:stub@p1";
  const cols = (await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'supersession_proposals' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  assert(cols.join(",") === "id,older_id,newer_id,verdict,confidence,reason,similarity,older_fingerprint,newer_fingerprint,judge_key,judged_at,canonical_agent_id,status,reviewed_at,review_note,superseding_id,pointer_written",
    `supersession_proposals has the seventeen columns, in order (${cols.join(",")})`);
  for (const fn of ["consolidation_candidates", "record_supersession_proposal", "review_supersession_proposal", "list_supersession_proposals", "consolidation_pool", "stale_entities"]) {
    assert((await functionsNamed(fn)) === 1, `${fn} is defined once`);
  }
  const fks = (await db.query<{ conname: string; deltype: string }>(
    `SELECT conname, confdeltype AS deltype FROM pg_constraint WHERE conrelid = 'supersession_proposals'::regclass AND contype = 'f' ORDER BY conname`)).rows;
  assert(fks.length === 2 && fks.every((f) => f.deltype === "c"), `both thought references cascade on delete (${fks.map((f) => `${f.conname}:${f.deltype}`).join(", ")})`);
  const src029 = readFileSync(join(MIGRATIONS, files.find((f) => f.startsWith("029"))!), "utf8").replace(/--[^\n]*/g, "");
  assert(!/\bDELETE\s+FROM\b/i.test(src029), "029 contains no DELETE statement — rejection is an UPDATE, and the pass never writes thoughts");
  const setsOnThoughts = [...src029.matchAll(/\bUPDATE\s+thoughts\s+SET\s+(\w+)/gi)].map((m) => m[1]);
  assert(setsOnThoughts.length === 2 && setsOnThoughts.every((c) => c === "supersedes"),
    `…and the only column of thoughts it ever sets is supersedes (${setsOnThoughts.join(", ")})`);

  // A small corpus, dated. upsert_thought stamps now(); the candidate rule is
  // about capture DAYS, so created_at is moved afterwards by hand (an UPDATE
  // the audit trigger records as nothing — created_at is not diffed).
  const seed = async (content: string, at: number, daysAgo: number, meta: Record<string, unknown> = {}) => {
    const id = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`,
      [content, JSON.stringify({ metadata: meta }), unit(at)])).rows[0].r.id;
    await db.query(`UPDATE thoughts SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [id, daysAgo]);
    return id;
  };
  const mention = async (id: string, names: string[]) =>
    db.query(`SELECT record_thought_entities($1::uuid, $2, $3::jsonb, '[]'::jsonb, NULL, NULL)`,
      [id, EXTRACT, JSON.stringify(names.map((n) => ({ name: n, type: "topic", confidence: 0.9 })))]);
  const candidates = async (id: string, k = 5, minSim = 0) =>
    (await db.query<{ older_id: string; similarity: number; shared_entities: number }>(
      `SELECT older_id, similarity, shared_entities FROM consolidation_candidates($1::uuid, $2, $3)`, [id, k, minSim])).rows;
  const supersedesOf = async (id: string) => (await db.query<{ s: string | null }>(`SELECT supersedes AS s FROM thoughts WHERE id = $1`, [id])).rows[0].s;

  // Ten days ago: the decision. Today: its reversal, on the same axis (cosine
  // 1), sharing "billing". A same-day sibling, an unrelated-subject neighbour
  // and a far one on another axis test each exclusion.
  const decision = await seed("we bill monthly, decided", 0, 10, { source: "meeting" });
  const reversal = await seed("we bill annually now; the monthly plan is withdrawn", 0, 0, { source: "meeting" });
  const sameDay = await seed("billing note from the same day", 0, 0);
  const noShare = await seed("a note about deployments, near in vector space", 0, 10);
  const farAxis = await seed("billing mentioned in passing, far in vector space", 1, 10);
  await mention(decision, ["billing"]);
  await mention(reversal, ["billing", "pricing"]);
  await mention(sameDay, ["billing"]);
  await mention(noShare, ["deployments"]);
  await mention(farAxis, ["billing"]);

  // The pool rule, one definition: entities AND a vector AND not superseded,
  // minus the rows under a key. A thought with entities and no vector, and a
  // superseded thought, are out (the first review pass's gate, pinned here).
  const pool = async (key: string | null) => (await db.query<{ id: string }>(`SELECT consolidation_pool($1) AS id`, [key])).rows.map((r) => r.id);
  const vectorless = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, '{"metadata":{}}'::jsonb, NULL::vector) AS r`, ["billing note whose embedding failed"])).rows[0].r.id;
  await mention(vectorless, ["billing"]);
  const universe = await pool(null);
  assert(universe.length === 5 && !universe.includes(vectorless), `the universe is the five thoughts with entities and a vector; the vectorless one is out (${universe.length})`);
  await db.query(`UPDATE thoughts SET supersedes = $2 WHERE id = $1`, [sameDay, farAxis]);
  assert(!(await pool(null)).includes(farAxis) && (await pool(null)).includes(sameDay), "a thought some thought supersedes is out of the pool; the superseding one stays");
  await db.query(`UPDATE thoughts SET supersedes = NULL WHERE id = $1`, [sameDay]);
  assert((await pool(null)).includes(farAxis), "…and re-enters it when the pointer is cleared");
  await db.query(`SELECT enqueue_thoughts($1, $2::uuid[])`, [KEY, [decision]]);
  const pooled = await pool(KEY);
  assert(pooled.length === 4 && !pooled.includes(decision), `under a key, a thought with a claim row is not pooled again (${pooled.length})`);
  await db.query(`DELETE FROM thought_work_claims WHERE work_type = $1`, [KEY]);
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [vectorless]);

  const c1 = await candidates(reversal);
  assert(c1.length === 2 && c1[0].older_id === decision && Math.abs(Number(c1[0].similarity) - 1) < 1e-6 && c1[1].older_id === farAxis,
    `the reversal's candidates are the older thoughts sharing an entity, nearest first: the decision (cosine 1) then the far one (${c1.map((c) => `${c.older_id === decision ? "decision" : c.older_id === farAxis ? "far" : "?"}@${Number(c.similarity).toFixed(2)}`).join(", ")})`);
  assert(!c1.some((c) => c.older_id === sameDay), "…a thought captured the same day is not a candidate");
  assert(!c1.some((c) => c.older_id === noShare), "…nor one sharing no entity, however near");
  assert(Number(c1[0].shared_entities) === 1, "…and the count of shared entities rides along");
  assert((await candidates(reversal, 5, 0.5)).length === 1, "a similarity floor drops the far one");
  assert((await candidates(reversal, 1)).length === 1 && (await candidates(reversal, 1))[0].older_id === decision, "k bounds the list, nearest kept");
  assert((await candidates(decision)).length === 0, "the OLDER thought has no candidates: a pair is reached from its newer side only");
  assert(!(await candidates(sameDay)).some((c) => c.older_id === reversal) && (await candidates(sameDay)).some((c) => c.older_id === decision),
    "the same-day sibling reaches the decision but not the reversal captured on its own day");

  // The one write. A second judge of the pair records nothing.
  const propose = async (older: string, newer: string, verdict: string, conf = 0.9, reason = "monthly versus annual") =>
    (await db.query<{ id: string | null }>(
      `SELECT record_supersession_proposal($1::uuid, $2::uuid, $3, $4, $5, 0.99, $6, NULL) AS id`,
      [older, newer, verdict, conf, reason, KEY])).rows[0].id;
  const pid = await propose(decision, reversal, "newer_supersedes_older");
  assert(typeof pid === "string", "a conflict is recorded as a pending proposal");
  assert((await propose(decision, reversal, "older_supersedes_newer", 0.2)) === null, "…and the pair recorded again returns NULL, the first verdict standing");
  let badVerdict = "";
  try { await propose(decision, reversal, "agree"); } catch (e) { badVerdict = (e as Error).message; }
  assert(/p_verdict must be/.test(badVerdict), "a verdict outside the three is refused, not stored");
  const clampOld = await seed("clamp: earlier", 6, 3); const clampNew = await seed("clamp: later", 6, 0);
  const clamped = await propose(clampOld, clampNew, "conflict_undirected", 1.7);
  assert(Number((await db.query<{ c: string }>(`SELECT confidence AS c FROM supersession_proposals WHERE id = $1`, [clamped])).rows[0].c) === 1, "a confidence over 1 is clamped to 1, not refused");
  await db.query(`DELETE FROM supersession_proposals WHERE id = $1`, [clamped]);
  const row = (await db.query<{ status: string; confidence: string; judge_key: string; similarity: number }>(
    `SELECT status, confidence, judge_key, similarity FROM supersession_proposals WHERE id = $1`, [pid])).rows[0];
  assert(row.status === "pending" && Number(row.confidence) === 0.9 && row.judge_key === KEY && Math.abs(Number(row.similarity) - 0.99) < 1e-5,
    `the row is pending, carries confidence, the judge key and the cosine (${JSON.stringify(row)})`);
  assert((await candidates(reversal)).every((c) => c.older_id !== decision), "a proposed pair is not a candidate again, in any state");

  // The review path. accept writes supersedes on the NEWER thought — the
  // verdict's direction — through the audit trigger with the reviewer as actor.
  const review = async (id: string, decision: string, extra: { note?: string; direction?: string; actor?: unknown; force?: boolean } = {}) =>
    (await db.query<{ r: Record<string, unknown> }>(
      `SELECT review_supersession_proposal($1::uuid, $2, $3, $4, $5::jsonb, $6::boolean) AS r`,
      [id, decision, extra.note ?? null, extra.direction ?? null, extra.actor === undefined ? null : JSON.stringify(extra.actor), extra.force ?? false])).rows[0].r;
  const auditBefore = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).rows[0].c;
  const acc = await review(pid, "accept", { note: "confirmed in the June minutes", actor: { name: "reviewer", source: "test" } });
  assert(acc.ok === true && acc.status === "accepted" && acc.superseding_id === reversal && acc.superseded_id === decision && acc.written === true,
    `accept answers with the pair it wrote (${JSON.stringify(acc)})`);
  assert((await supersedesOf(reversal)) === decision, "…and the reversal now supersedes the decision");
  const accRow = (await db.query<{ status: string; superseding_id: string; review_note: string; reviewed_at: string | null }>(
    `SELECT status, superseding_id, review_note, reviewed_at FROM supersession_proposals WHERE id = $1`, [pid])).rows[0];
  assert(accRow.status === "accepted" && accRow.superseding_id === reversal && accRow.review_note === "confirmed in the June minutes" && accRow.reviewed_at !== null,
    "…the row is accepted, names the thought it wrote, and keeps the note");
  // Not ordered: neither `id` (a uuid — this read ordered by it until
  // SMD-1323's twin exposed the flake) nor `created_at` (separate transactions
  // can share now(), SMD-1514) picks the newest row. What makes the read safe
  // is that the reversal has exactly one update row here — its capture wrote
  // a capture row, and seed()'s created_at UPDATE an empty diff, which 008's
  // guard in the audit trigger (025's body is the last definer) records as
  // nothing — and that is asserted.
  const auditRows = (await db.query<{ actor_name: string | null; diff: Record<string, unknown> }>(
    `SELECT actor_name, diff FROM thought_audit WHERE thought_id = $1 AND action = 'update'`, [reversal])).rows;
  const audit = auditRows[0];
  const auditAfter = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).rows[0].c;
  const supDiff = (audit?.diff as { supersedes?: { before?: unknown; after?: unknown } } | undefined)?.supersedes;
  assert(auditAfter === auditBefore + 1 && auditRows.length === 1 && audit?.actor_name === "reviewer" && supDiff?.before === null && supDiff?.after === decision,
    `the write is one audit row — the reversal's only update row — with the reviewer as actor and the supersedes diff (${auditRows.length}; ${audit?.actor_name}: ${JSON.stringify(audit?.diff)})`);
  const again = await review(pid, "accept");
  assert(again.ok === false && again.error === "ALREADY_ACCEPTED", "accepting an accepted proposal is refused, not re-written");
  assert((await candidates(reversal)).length === 1 && (await candidates(reversal))[0].older_id === farAxis, "a thought already superseded is not a candidate on either side");

  // reject of an ACCEPTED proposal undoes its write while it still stands.
  const rej = await review(pid, "reject", { note: "the June minutes were misread" });
  assert(rej.ok === true && rej.status === "rejected" && rej.cleared === true, `rejecting an accepted proposal clears the pointer it set (${JSON.stringify(rej)})`);
  assert((await supersedesOf(reversal)) === null, "…and thoughts.supersedes is NULL again");
  assert((await db.query<{ s: string | null }>(`SELECT superseding_id AS s FROM supersession_proposals WHERE id = $1`, [pid])).rows[0].s === null, "…with superseding_id cleared");
  assert((await candidates(reversal)).every((c) => c.older_id !== decision), "a rejected pair is never a candidate again");
  // A pointer a later edit moved elsewhere is not this proposal's to clear
  // either: accept (written), move the pointer by hand, reject → untouched.
  const moved = await review(pid, "accept");
  assert(moved.ok === true && moved.written === true, "(re-accepted, the pointer written again)");
  await db.query(`UPDATE thoughts SET supersedes = $2 WHERE id = $1`, [reversal, farAxis]);
  const rejMoved = await review(pid, "reject");
  assert(rejMoved.ok === true && rejMoved.cleared === false && (await supersedesOf(reversal)) === farAxis,
    "rejecting after a later edit repointed the thought clears nothing: the pointer is no longer this proposal's");
  await db.query(`UPDATE thoughts SET supersedes = NULL WHERE id = $1`, [reversal]);
  const rejAgain = await review(pid, "reject");
  assert(rejAgain.ok === true && rejAgain.cleared === false, "rejecting a rejected proposal is idempotent and clears nothing");
  // ...and a reviewer may change their mind: a rejected proposal can be accepted.
  const reacc = await review(pid, "accept", { direction: "older" });
  assert(reacc.ok === true && reacc.superseding_id === decision && (await supersedesOf(decision)) === reversal,
    "a rejected proposal can be accepted, and --direction overrides the verdict's direction");
  await review(pid, "reject");
  assert((await supersedesOf(decision)) === null, "…and rejecting that undoes the overridden write too");

  // An undirected verdict needs the reviewer to say which is current.
  const undirected = await propose(farAxis, reversal, "conflict_undirected", 0.6, "both name billing terms; neither says it replaces the other");
  const needDir = await review(undirected!, "accept");
  assert(needDir.ok === false && needDir.error === "DIRECTION_REQUIRED", "accepting an undirected verdict without --direction is refused");
  const directed = await review(undirected!, "accept", { direction: "newer" });
  assert(directed.ok === true && (await supersedesOf(reversal)) === farAxis, "…and with a direction it writes on the thought named");

  // The column holds one predecessor: a second acceptance pointing the same
  // thought elsewhere is refused with the current pointer named.
  const third = await propose(decision, reversal, "newer_supersedes_older");
  assert(third === null, "(the decision/reversal pair still has its row)");
  const clash = await review(pid, "accept");
  assert(clash.ok === false && clash.error === "ALREADY_SUPERSEDES" && clash.current === farAxis,
    `a pointer at a third thought is refused, naming it (${JSON.stringify(clash)})`);
  await review(undirected!, "reject");

  // A loop is refused: A supersedes B, so B may not be made to supersede A.
  const loopOlder = await seed("loop: the first version", 2, 20);
  const loopNewer = await seed("loop: the second version", 2, 5);
  await mention(loopOlder, ["loops"]); await mention(loopNewer, ["loops"]);
  await db.query(`UPDATE thoughts SET supersedes = $2 WHERE id = $1`, [loopOlder, loopNewer]);
  const loopPid = await propose(loopOlder, loopNewer, "newer_supersedes_older");
  const loop = await review(loopPid!, "accept");
  assert(loop.ok === false && loop.error === "WOULD_CYCLE", `a pointer that would close a loop is refused (${loop.error})`);
  assert((await supersedesOf(loopNewer)) === null, "…and nothing was written");
  // A pointer the acceptance finds already there — set at capture through the
  // envelope — is not the acceptance's write, and a rejection leaves it
  // (review pass 1). accept answers written:false and records pointer_written
  // false; reject clears nothing and says so.
  const capOld = await seed("capture-set: the earlier note", 5, 9);
  const capNew = await seed("capture-set: the later note, pointing at the earlier at capture", 5, 0);
  await mention(capOld, ["capture"]); await mention(capNew, ["capture"]);
  await db.query(`UPDATE thoughts SET supersedes = $2 WHERE id = $1`, [capNew, capOld]);
  const capPid = await propose(capOld, capNew, "newer_supersedes_older");
  const capAcc = await review(capPid!, "accept");
  assert(capAcc.ok === true && capAcc.written === false, `accepting a proposal whose pointer is already there writes nothing and says so (${JSON.stringify(capAcc)})`);
  assert((await db.query<{ w: boolean }>(`SELECT pointer_written AS w FROM supersession_proposals WHERE id = $1`, [capPid])).rows[0].w === false, "…and the row records that it wrote nothing");
  const capRej = await review(capPid!, "reject");
  assert(capRej.ok === true && capRej.cleared === false && (await supersedesOf(capNew)) === capOld, "rejecting it clears nothing: the capture-time pointer was not this proposal's to clear");
  const chk = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_constraint WHERE conrelid = 'supersession_proposals'::regclass AND contype = 'c'`)).rows[0].c;
  assert(chk === 9, `the table carries nine CHECK constraints, the state machine's among them (${chk})`);

  // The verdict is about the texts as judged. Edit the newer thought after
  // the proposal: the queue says so, accept refuses EDITED_SINCE, --force
  // accepts (review pass 3). The fingerprints were taken at judging.
  const edOld = await seed("edited: the first plan", 7, 8); const edNew = await seed("edited: the second plan, replacing the first", 7, 0);
  await mention(edOld, ["plans"]); await mention(edNew, ["plans"]);
  const edPid = await propose(edOld, edNew, "newer_supersedes_older");
  const fps = (await db.query<{ o: string | null; n: string | null }>(`SELECT older_fingerprint AS o, newer_fingerprint AS n FROM supersession_proposals WHERE id = $1`, [edPid])).rows[0];
  assert(fps.o === (await fpOf("edited: the first plan")) && fps.n === (await fpOf("edited: the second plan, replacing the first")), "a proposal records both texts' fingerprints as judged");
  const [beforeEdit] = (await db.query<{ older_edited: boolean; newer_edited: boolean }>(`SELECT older_edited, newer_edited FROM list_supersession_proposals('pending', 50) WHERE id = $1`, [edPid])).rows;
  assert(beforeEdit.older_edited === false && beforeEdit.newer_edited === false, "…and the queue says neither has changed");
  await db.query(`SELECT update_thought($1::uuid, $2, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text)`, [edNew, "edited: the second plan, withdrawn; the first stands"]);
  const [afterEdit] = (await db.query<{ older_edited: boolean; newer_edited: boolean }>(`SELECT older_edited, newer_edited FROM list_supersession_proposals('pending', 50) WHERE id = $1`, [edPid])).rows;
  assert(afterEdit.older_edited === false && afterEdit.newer_edited === true, "after an edit through update_thought the queue flags the newer thought as edited since judged");
  const edRefused = await review(edPid!, "accept");
  assert(edRefused.ok === false && edRefused.error === "EDITED_SINCE" && edRefused.newer_edited === true && edRefused.older_edited === false, `accepting a pair whose text moved is refused, naming which side (${JSON.stringify(edRefused)})`);
  assert((await supersedesOf(edNew)) === null, "…and nothing was written");
  const edForced = await review(edPid!, "accept", { force: true });
  assert(edForced.ok === true && (await supersedesOf(edNew)) === edOld, "…and p_force accepts it, the reviewer having read both texts as they are now");
  await review(edPid!, "reject");
  // The older side, a whitespace-only edit, and force on an unedited pair.
  await db.query(`UPDATE thoughts SET content = $2 WHERE id = $1`, [edOld, "edited:   the first   plan"]);
  const [wsEdit] = (await db.query<{ older_edited: boolean; newer_edited: boolean }>(`SELECT older_edited, newer_edited FROM list_supersession_proposals(NULL, 50) WHERE id = $1`, [edPid])).rows;
  assert(wsEdit.older_edited === false, "a whitespace-only edit normalises to the same fingerprint (016's rule) and is not flagged");
  await db.query(`UPDATE thoughts SET content = $2 WHERE id = $1`, [edOld, "edited: the first plan, now with a caveat"]);
  const [oldEdit] = (await db.query<{ older_edited: boolean; newer_edited: boolean }>(`SELECT older_edited, newer_edited FROM list_supersession_proposals(NULL, 50) WHERE id = $1`, [edPid])).rows;
  assert(oldEdit.older_edited === true && oldEdit.newer_edited === true, "an edit to the older side is flagged on that side");
  const bothRefused = await review(edPid!, "accept");
  assert(bothRefused.ok === false && bothRefused.error === "EDITED_SINCE" && bothRefused.older_edited === true, "…and refused naming it");
  const plainForce = await review(pid, "accept", { force: true });
  assert(plainForce.ok === true && plainForce.written === true, "p_force on an unedited pair is a plain accept");
  await review(pid, "reject");
  // The fingerprint recorded is the caller's — the text the judge was sent —
  // so an edit that landed during the judge call already reads as edited.
  const raceOld = await seed("race: the text the judge read", 8, 6); const raceNew = await seed("race: the later text", 8, 0);
  await mention(raceOld, ["race"]); await mention(raceNew, ["race"]);
  const racePid = (await db.query<{ id: string }>(
    `SELECT record_supersession_proposal($1::uuid, $2::uuid, 'newer_supersedes_older', 0.9, NULL, 0.9, $3, NULL, $4, $5) AS id`,
    [raceOld, raceNew, KEY, await fpOf("race: what the judge actually read, since edited"), await fpOf("race: the later text")])).rows[0].id;
  const [raceRow] = (await db.query<{ older_edited: boolean; newer_edited: boolean }>(`SELECT older_edited, newer_edited FROM list_supersession_proposals('pending', 50) WHERE id = $1`, [racePid])).rows;
  assert(raceRow.older_edited === true && raceRow.newer_edited === false, "a proposal recorded with the judged text's fingerprint reads as edited when the row moved during the call");
  await review(racePid, "reject");

  const missing = await review("00000000-0000-4000-8000-000000000000", "accept");
  assert(missing.ok === false && missing.error === "NOT_FOUND", "an unknown proposal id is NOT_FOUND");
  let badDecision = "";
  try { await review(loopPid!, "maybe"); } catch (e) { badDecision = (e as Error).message; }
  assert(/must be accept or reject/.test(badDecision), "a decision outside accept/reject is refused");

  // The queue: most confident first, one status or all, both thoughts inline.
  const list = async (status: string | null, limit = 20) =>
    (await db.query<Record<string, unknown>>(`SELECT * FROM list_supersession_proposals($1, $2)`, [status, limit])).rows;
  const pendingList = await list("pending");
  assert(pendingList.length === 1 && pendingList[0].id === loopPid, `one proposal is pending — the loop one (${pendingList.length})`);
  const all = await list(null);
  assert(all.length === 6 && all.every((r, i) => i === 0 || Number(all[i - 1].confidence) >= Number(r.confidence)),
    `NULL lists every state, most confident first (${all.map((r) => `${r.status}@${r.confidence}`).join(", ")})`);
  const shown = all.find((r) => r.id === pid)!;
  assert(shown.older_id === decision && shown.newer_id === reversal && /bill monthly/.test(String(shown.older_content)) && /annually/.test(String(shown.newer_content)) && shown.status === "rejected",
    "each row carries both thoughts' content and capture time beside the verdict");
  assert((await list(null, 1)).length === 1 && (await list("accepted")).length === 0, "limit and status filter apply");

  // Staleness: an entity whose newest mention is 100 days old is stale at 90, not at 200.
  const quiet = await seed("the archive migration, long finished", 3, 100);
  await mention(quiet, ["archive migration"]);
  const stale90 = (await db.query<{ name: string; thoughts: number }>(`SELECT name, thoughts FROM stale_entities(interval '90 days', 20)`)).rows;
  assert(stale90.length === 1 && stale90[0].name === "archive migration" && Number(stale90[0].thoughts) === 1,
    `stale_entities at 90 days names the one quiet subject (${stale90.map((r) => r.name).join(", ")})`);
  assert((await db.query(`SELECT * FROM stale_entities(interval '200 days', 20)`)).rows.length === 0, "…and none at 200");

  // A deleted thought takes its proposals with it; the other thought stands.
  await db.query(`SELECT delete_thought($1::uuid, NULL::jsonb)`, [loopOlder]);
  assert((await db.query(`SELECT 1 FROM supersession_proposals WHERE id = $1`, [loopPid])).rows.length === 0, "deleting a thought cascades to its proposals");
  assert((await db.query(`SELECT 1 FROM thoughts WHERE id = $1`, [loopNewer])).rows.length === 1, "…and the other thought of the pair stands");

  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_entities`);
}

console.log("\n[29] Migration 030's substituted literals are pinned — 021's grammar, the caveat prefix, the own-key spelling, the evidence rows (SMD-1193)");
{
  // 030 is hashed as a template: what it DOES on a brain where it is still
  // pending, and what every --reapply does, comes from these config.mjs values
  // at run time, with no drift signal from the ledger. Changing one is a data
  // migration and gets a new file; this pins the spellings applied brains ran.
  const file021 = readFileSync(join(MIGRATIONS, "021_embedding_model_per_row.sql"), "utf8");
  assert(file021.includes(`'${REEMBED_KEY_MODEL_SQL_RE}'`), "REEMBED_KEY_MODEL_SQL_RE is 021's inline regex, byte for byte — 021 decides what is evidence");
  assert(REEMBED_OWN_KEY_SQL_RE === "^reembed:.+@(0|[1-9][0-9]*)$", "the own-key regex is the canonical spelling poolModelFor compares");
  assert(ACCEPTED_CAVEAT_PREFIX === "kept the vector it had; accepted by the operator: ", "the caveat prefix is the spelling accepted rows carry");
  const substituted030 = subst(readFileSync(join(MIGRATIONS, "030_label_from_claims_excludes_accepted.sql"), "utf8"));
  // Twice in the statements, once more where the header names the template.
  assert(substituted030.split(CLAIM_EVIDENCE_ROWS_SQL).length >= 3 && !/\{\{/.test(substituted030), "030's substituted text carries the shared evidence rows in both statements and no unresolved template");
}

// ── 30. Migration 031 — renew_claims ─────────────────────────────────────────
//
// The heartbeat, on one connection: which rows a beat moves (the holder's,
// while claimed), which it leaves (another worker's, pending, terminal), that
// it never brings a deadline forward, that a lease past its deadline no claim
// has reaped is still the holder's, and that a reaped one is not. The timing —
// a worker that beats across its deadline keeps its rows; one that stops loses
// them on the RENEWED deadline — needs real time and is db/test-live.ts [8e];
// the workers end to end are [9], [10] and [16] there.

console.log("\n[30] Migration 031: renew_claims moves every lease the worker holds, and nothing else (SMD-1023)");
{
  await db.exec(`DELETE FROM thoughts`);
  for (let i = 0; i < 6; i++) await db.query(`INSERT INTO thoughts (content) VALUES ($1)`, [`renew probe ${i}`]);
  const JOB = "test:renew";
  await db.query(`SELECT enqueue_thoughts($1)`, [JOB]);
  const raises = async (q: string, params: unknown[] = []): Promise<string> => {
    try { await db.query(q, params); return ""; } catch (e) { return (e as Error).message; }
  };
  const claim = async (worker: string, batch: number, ttl = 900) =>
    (await db.query<{ thought_id: string }>(`SELECT thought_id FROM claim_thoughts($1, $2, $3, $4)`, [JOB, worker, batch, ttl])).rows.map((r) => r.thought_id);
  const renew = async (worker: string, ttl: number) =>
    (await db.query<{ thought_id: string }>(`SELECT thought_id FROM renew_claims($1, $2, $3)`, [JOB, worker, ttl])).rows.map((r) => r.thought_id).sort();
  const deadlines = async (ids: string[]) =>
    Object.fromEntries((await db.query<{ id: string; d: string | null }>(
      `SELECT thought_id::text AS id, ttl_expires_at::text AS d FROM thought_work_claims WHERE work_type = $1 AND thought_id = ANY($2::uuid[])`, [JOB, ids])).rows.map((r) => [r.id, r.d])) as Record<string, string | null>;
  const later = (a: string | null, b: string | null) => a !== null && b !== null && new Date(a).getTime() > new Date(b).getTime();

  assert((await functionsNamed("renew_claims")) === 1, "renew_claims is defined once");
  assert(lastDefinerOf("claim_thoughts") === "015_thought_work_claims.sql" && lastDefinerOf("release_thought") === "015_thought_work_claims.sql",
    "…and 015 is still the last file to define claim_thoughts and release_thought: the renewal does not touch the claim statement");
  const a = await claim("A", 3);
  const b = await claim("B", 2);
  const pending = (await db.query<{ id: string }>(`SELECT thought_id::text AS id FROM thought_work_claims WHERE work_type = $1 AND status = 'pending'`, [JOB])).rows.map((r) => r.id);
  assert(a.length === 3 && b.length === 2 && pending.length === 1, `A holds three, B two, one row is pending (${a.length}/${b.length}/${pending.length})`);
  const before = await deadlines([...a, ...b, ...pending]);
  const renewed = await renew("A", 1800);
  assert(renewed.join() === [...a].sort().join(), `A's beat returns exactly A's three rows (${renewed.length})`);
  const after = await deadlines([...a, ...b, ...pending]);
  assert(a.every((id) => later(after[id], before[id])), "…each moved to a later deadline");
  assert(b.every((id) => after[id] === before[id]), "…B's rows untouched");
  assert(after[pending[0]] === null && before[pending[0]] === null, "…and the pending row still has no lease");
  // Never backward.
  const shorter = await renew("A", 1);
  const held = await deadlines(a);
  assert(shorter.length === 3 && a.every((id) => held[id] === after[id]), "a beat with a shorter lease than the claim's returns the rows and moves no deadline backward");
  // Who a beat is for.
  assert((await renew("nobody", 900)).length === 0, "a worker id that holds nothing renews nothing, without error");
  assert(/must identify the worker/.test(await raises(`SELECT * FROM renew_claims($1, '', 900)`, [JOB])), "an empty worker id is refused");
  assert(/must be positive/.test(await raises(`SELECT * FROM renew_claims($1, 'A', 0)`, [JOB])), "a non-positive lease is refused, not stamped as already expired");
  // A released row leaves the beat.
  await db.query(`SELECT release_thought($1, $2, 'A', 'succeeded')`, [a[0], JOB]);
  const afterRelease = await renew("A", 900);
  assert(afterRelease.length === 2 && !afterRelease.includes(a[0]), "after A releases a row its beat returns the two it still holds");
  assert((await deadlines([a[0]]))[a[0]] === null, "…and the succeeded row keeps no lease");
  // Past its deadline but not yet reaped: still the holder's.
  await db.query(`UPDATE thought_work_claims SET ttl_expires_at = now() - interval '1 second' WHERE thought_id = ANY($1::uuid[]) AND work_type = $2`, [a.slice(1), JOB]);
  const revived = await renew("A", 900);
  const revivedDeadlines = await deadlines(a.slice(1));
  assert(revived.length === 2 && a.slice(1).every((id) => new Date(revivedDeadlines[id]!).getTime() > Date.now()),
    "a lease past its deadline that no claim has reaped is still the holder's, and a beat brings it back to the future");
  // Reaped: not the holder's any more.
  await db.query(`UPDATE thought_work_claims SET ttl_expires_at = now() - interval '1 second' WHERE thought_id = ANY($1::uuid[]) AND work_type = $2`, [a.slice(1), JOB]);
  const c = await claim("C", 10);
  assert(c.length === 3 && a.slice(1).every((id) => c.includes(id)) && c.includes(pending[0]), `C's claim reaps A's two expired rows and takes them with the pending one (${c.length})`);
  assert((await renew("A", 900)).length === 0, "…and A's beat now returns nothing: the rows are C's");
  assert((await renew("C", 900)).join() === [...c].sort().join(), "…while C's beat returns all three");
  const late = (await db.query<{ ok: boolean }>(`SELECT release_thought($1, $2, 'A', 'succeeded') AS ok`, [a[1], JOB])).rows[0].ok;
  assert(late === false, "…and A, finishing late, cannot release a row C holds, as 015 says");
  assert(/check constraint/.test(await raises(`UPDATE thought_work_claims SET ttl_expires_at = NULL WHERE thought_id = $1 AND work_type = $2`, [c[0], JOB])),
    "015's CHECK still keeps status and lease in step — asserted here so a later writer of ttl_expires_at is held to it");
  // The two comments 031 writes, and the literal shape [10] requires of them.
  const colComment = (await db.query<{ c: string | null }>(
    `SELECT col_description('thought_work_claims'::regclass, attnum) AS c FROM pg_attribute WHERE attrelid = 'thought_work_claims'::regclass AND attname = 'ttl_expires_at'`)).rows[0].c ?? "";
  assert(/renew_claims/.test(colComment) && /missed heartbeat/.test(colComment), "ttl_expires_at's comment names the heartbeat and what the lease now means");
  const fnComment = (await db.query<{ c: string | null }>(`SELECT obj_description('renew_claims(text, text, int)'::regprocedure, 'pg_proc') AS c`)).rows[0].c ?? "";
  assert(/never backward/.test(fnComment) && !/--/.test(fnComment) && !/--/.test(colComment), "renew_claims's comment states the rule, and neither literal spells a flag with its dashes");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 31. A vendored schema on a migrated brain ────────────────────────────────

console.log("\n[31] A vendored schema applied to a migrated brain replaces no function a migration owns — and what upstream's did (SMD-1250)");
{
  // The owned set, read from the files as scripts/check-fork-consistency.mjs
  // check 7 reads it. Three names preflight's remedies spell as the last
  // definer are pinned here: when one moves, so must the remedy.
  const owned = ownedFunctionsIn(files.map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")] as const));
  // 37 at migration 032; the set can only grow, so a smaller one means the
  // reader lost definitions (a comment or body it failed to strip), not that
  // a migration went away.
  assert(owned.size >= 37 && [...owned.keys()].every((n) => /^[a-z][a-z0-9_]*$/.test(n)) && !owned.has("and") && !owned.has("keeps"),
    `the owned set is read from the migrations: ${owned.size} functions (37 at 032, never fewer), names only — no word from a header comment quoting a statement`);
  assert(owned.get("upsert_thought") === "035_recapture_writes_no_provenance.sql" && owned.get("trace_provenance") === "026_trace_provenance_bounded.sql" && owned.get("release_thought") === "015_thought_work_claims.sql",
    "…and the last definers preflight's remedies name: upsert_thought 035, trace_provenance 026, release_thought 015");
  const ownedCols = ownedColumnCommentsIn(files.map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")] as const));
  assert(ownedCols.get("embedding_model") === "021_embedding_model_per_row.sql" && ownedCols.get("derived_from") === "025_thought_provenance.sql" && ownedCols.get("supersedes") === "025_thought_provenance.sql" && ownedCols.size >= 3,
    `the thoughts columns whose comments a migration writes are read the same way (${ownedCols.size}): embedding_model 021, derived_from and supersedes 025`);
  const bodies = async (): Promise<Record<string, string>> => Object.fromEntries((await db.query<{ sig: string; h: string }>(
    `SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`, [[...owned.keys()]])).rows.map((r) => [r.sig, r.h]));
  const srcOf = async (sig: string) => String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0].s);
  const TWO = "upsert_thought(text,jsonb)";
  const THREE = "upsert_thought(text,jsonb,vector)";
  const scalarAccepted = async (): Promise<boolean> => {
    try { await db.query(`SELECT upsert_thought('scalar payload 31', '"{\\"metadata\\":{\\"k\\":1}}"'::jsonb)`); return true; } catch { return false; }
  };
  const shipped = await bodies();
  assert(TWO in shipped && THREE in shipped, `the two capture forms are among the ${Object.keys(shipped).length} owned bodies`);
  assert(UPSERT_TWO_ARG_SHIPPED_RE.test(await srcOf(TWO)) && UPSERT_THREE_ARG_SHIPPED_RE.test(await srcOf(THREE)) && /ob1:vector-replaces-chunks/.test(await srcOf(THREE))
      && /ob1:capture-takes-fingerprint-lock/.test(await srcOf(TWO)) && /ob1:capture-takes-fingerprint-lock/.test(await srcOf(THREE)),
    "preflight's recognisers hold for the shipped bodies: 005's guard in the 2-argument form, 025's envelope and 022's sentinel in the 3-argument form, 033's sentinel in both");
  assert(RELEASE_SHIPPED_RE.test(await srcOf("release_thought(uuid,text,text,text,text)")) && RELEASE_SHIPPED_RE.test(await srcOf("release_claims_for_worker(text,text)")) && THOUGHT_STATS_SHIPPED_RE.test(await srcOf("thought_stats_summary()")),
    "…and for 015's two release bodies (the lease cleared) and 024's thought_stats_summary (topics guarded by type)");

  // The vendored file as fixed — its section 6 gone — applied whole. The
  // Supabase roles its GRANTs name do not exist in PGlite.
  const vendored = readFileSync(join(HERE, "..", "schemas", "enhanced-thoughts", "schema.sql"), "utf8");
  assert(![...owned.keys()].some((fn) => coreFunctionStatement(fn).test(vendored)) && ![...ownedCols.keys()].some((col) => coreColumnCommentStatement(col).test(vendored)),
    "schemas/enhanced-thoughts/schema.sql names no owned function or column comment in a statement, by check 7's own rules");
  for (const role of ["authenticated", "service_role", "anon"]) {
    await db.exec(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $r$`);
  }
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(vendored);
  assert(JSON.stringify(await bodies()) === JSON.stringify(shipped), "applied to a migrated brain, it leaves every owned function's body and overload set exactly as the migrations left them");
  const cols = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name IN ('importance', 'quality_score', 'source_type')`)).rows.length;
  assert(cols === 3 && (await functionsNamed("search_thoughts_text")) === 1, "…while its own columns and functions arrive");
  assert(!(await scalarAccepted()), "…and a double-encoded payload is still refused: 005's body is the one that runs");

  // What upstream's section 6 did — and the fingerprint recipe's Step 2, and
  // the guide pasted again: a body from before 005 over 005's. 003's is that
  // body, byte for byte in what matters.
  await reapply("003");
  const clobbered = await bodies();
  const changed = Object.keys(shipped).filter((sig) => shipped[sig] !== clobbered[sig]);
  assert(changed.length === 1 && changed[0] === TWO, `the earlier body over the 2-argument form raised nothing and changed exactly one owned body (${changed.join(", ")})`);
  assert(!UPSERT_TWO_ARG_SHIPPED_RE.test(await srcOf(TWO)), "…which preflight's recogniser tells from 005's");
  assert(await scalarAccepted(), "…and a double-encoded payload is emptied silently again — the defect 005 removed, back without an error");
  // 025 over 033: 022's sentinel and 025's envelope stay, 033's sentinel goes
  // — an unlocked body preflight tells by that alone.
  await reapply("025");
  const three025 = await srcOf(THREE);
  assert(/ob1:vector-replaces-chunks/.test(three025) && UPSERT_THREE_ARG_SHIPPED_RE.test(three025) && !/ob1:capture-takes-fingerprint-lock/.test(three025),
    "025 re-applied over 033 keeps 022's sentinel and 025's envelope and drops 033's sentinel — the one clause that says the body takes the lock");
  // 022 over 025: the sentinel stays, the envelope goes — why 025's body is
  // recognised by more than the sentinel.
  await reapply("022");
  const three022 = await srcOf(THREE);
  assert(/ob1:vector-replaces-chunks/.test(three022) && !UPSERT_THREE_ARG_SHIPPED_RE.test(three022), "022 re-applied over 025 keeps 022's sentinel and drops 025's envelope, which the second recogniser sees");
  // 005 re-applied: both forms from before 022, and the 2-argument one 005's
  // — the guard, no lock. The way back is the migrations in order — what
  // --reapply runs — and 035 is the last definer of both forms, so one file
  // is the remedy for either.
  await reapply("005");
  assert(!/ob1:vector-replaces-chunks/.test(await srcOf(THREE)) && UPSERT_TWO_ARG_SHIPPED_RE.test(await srcOf(TWO)) && !/ob1:capture-takes-fingerprint-lock/.test(await srcOf(TWO)),
    "005 re-applied puts a pre-022 3-argument body back too (its file defines both forms) and a 2-argument body with the guard and no lock");
  await restoreShipped("upsert_thought", "trace_provenance");
  assert(JSON.stringify(await bodies()) === JSON.stringify(shipped), "…and the last definers re-applied put every owned body back, byte for byte");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 32. Migration 032 — provenance through the edit path ─────────────────────
//
// update_thought's ninth parameter is the envelope capture reads: an absent
// key leaves the column, a JSON null clears it, a value sets it after the
// checks 025 makes at capture plus 029's cycle walk. The review path writes
// through it. [28] drives 029's outcomes and still passes over the new body;
// this section is the envelope itself and what the redefinition must hold.

console.log("\n[32] Migration 032: update_thought takes provenance — set, clear, a ghost and a loop refused, audited; the review path writes through it (SMD-1323)");
{
  await db.exec(`DELETE FROM thoughts`);
  const UT = UPDATE_THOUGHT_SIGNATURE;
  const UT_8 = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)"; // the form 032 dropped; 021 re-creates it
  const UT_7 = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)";
  const GHOST = "00000000-0000-4000-8000-000000000000";
  const cap = async (content: string, at: number) =>
    (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, '{"metadata":{"k":1}}'::jsonb, $2::vector) AS r`, [content, unit(at)])).rows[0].r.id;
  type R = { ok: boolean; error?: string; supersedes?: string; detail?: string; current_updated_at?: string };
  /** A provenance-only edit: nothing but the envelope, the actor and the guard. */
  const edit = async (id: string, prov: unknown, extra: { actor?: unknown; since?: string } = {}) =>
    (await db.query<{ r: R }>(
      `SELECT update_thought($1::uuid, NULL::text, NULL::jsonb, NULL::vector, NULL::jsonb, $3::timestamptz, $4::jsonb, NULL::text, $2::jsonb) AS r`,
      [id, prov === undefined ? null : JSON.stringify(prov), extra.since ?? null, extra.actor === undefined ? null : JSON.stringify(extra.actor)])).rows[0].r;
  const rowOf = async (id: string) =>
    (await db.query<{ s: string | null; d: unknown; content: string; fp: string | null; axis: number | null; m: string | null; k: number; u: number }>(
      `SELECT supersedes AS s, derived_from AS d, content, content_fingerprint AS fp, array_position(embedding::real[], 1::real) - 1 AS axis,
              embedding_model AS m, (metadata->>'k')::int AS k, extract(epoch FROM updated_at)::float8 AS u FROM thoughts WHERE id = $1`, [id])).rows[0];
  type Audit = { actor_name: string | null; diff: Record<string, { before?: unknown; after?: unknown }> };
  // The update row one write added: the thought's audit ids before the write,
  // excluded after it; `audit` is undefined when the write added none. Not
  // `ORDER BY created_at DESC, id`: separate transactions do not promise
  // distinct created_at — now() is read from a clock that under PGlite has
  // millisecond grain (SMD-1498), so two edits a few statements apart can
  // share it — and the tiebreak `id` is a uuid, a coin toss between them (two
  // rows sharing created_at: the read picked the older 51 of 100 times,
  // SMD-1514).
  const auditOfWrite = async <T>(id: string, write: () => Promise<T>): Promise<{ r: T; audit: Audit | undefined; added: number }> => {
    const seen = (await db.query<{ id: string }>(`SELECT id FROM thought_audit WHERE thought_id = $1`, [id])).rows.map((x) => x.id);
    const r = await write();
    const rows = (await db.query<Audit>(
      `SELECT actor_name, diff FROM thought_audit WHERE thought_id = $1 AND action = 'update' AND NOT (id = ANY($2::uuid[]))`, [id, seen])).rows;
    return { r, audit: rows[0] as Audit | undefined, added: rows.length };
  };
  const audits = async () => (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).rows[0].c;
  const srcOf = async (sig: string) => String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0].s);
  const exists = async (sig: string) => (await db.query<{ e: boolean }>(`SELECT to_regprocedure($1) IS NOT NULL AS e`, [sig])).rows[0].e;

  // The shape: one function of nine parameters, neither older form beside it,
  // 032 the last definer of the three names it touches.
  assert((await functionsNamed("update_thought")) === 1 && Number((await db.query<{ n: number }>(`SELECT pronargs AS n FROM pg_proc WHERE oid = $1::regprocedure`, [UT])).rows[0].n) === 9,
    "one update_thought, of nine parameters");
  assert(!(await exists(UT_8)) && !(await exists(UT_7)), "…neither the 8- nor the 7-argument form beside it");
  assert(lastDefinerOf("update_thought").startsWith("033") && lastDefinerOf("review_supersession_proposal").startsWith("036") && lastDefinerOf("validate_derived_from").startsWith("032"),
    `033 is the last definer of update_thought, 036 of review_supersession_proposal (its lock moved before the proposal row, SMD-1462 [36]), 032 of validate_derived_from (${lastDefinerOf("update_thought")}, ${lastDefinerOf("review_supersession_proposal")})`);
  const src = await srcOf(UT);
  for (const [re, what] of [
    [/ob1:unchanged-edit-not-duplicate/, "018's sentinel"], [/ob1\.actor/, "008's actor"], [/FROM thoughts WHERE id = p_id FOR NO KEY UPDATE/, "018's row lock, FOR NO KEY UPDATE since 032"],
    [/pg_advisory_xact_lock\(hashtextextended/, "018's fingerprint lock"], [/content_fingerprint_of\(/, "016's fingerprint function"], [/elem->>'context'/, "013's context"],
    [/date_trunc\('milliseconds'/, "009's guard"], [/p_embedding IS NULL THEN NULL/, "021's label CASE"],
    [/validate_derived_from\(p_provenance->'derived_from'\)/, "032's one derived_from rule"], [/hashtext\('ob1:supersession-review'\)/, "029's supersession lock, taken here too"],
    [/'SUPERSEDES_NOT_FOUND'/, "the ghost refusal"], [/'WOULD_CYCLE'/, "the loop refusal"],
  ] as [RegExp, string][]) assert(re.test(src), `…carrying ${what}`);
  const review = await srcOf("review_supersession_proposal(uuid, text, text, text, jsonb, boolean)");
  assert(!/UPDATE\s+thoughts\b/i.test(review) && /update_thought\(/.test(review) && (review.match(/update_thought\(/g) ?? []).length === 2 && !/v_walk/.test(review),
    "review_supersession_proposal writes thoughts through update_thought — two calls, no UPDATE of its own, no walk of its own");

  // Set, leave, replace, clear — and what does not move.
  const a = await cap("v1: the plan is A", 0);
  const b = await cap("v2: the plan is B", 1);
  const c = await cap("a source note", 2);
  const before = await rowOf(b);
  const auditsBefore = await audits();
  // The capture a few statements back can share the edit's now(): PGlite's
  // clock has millisecond grain (SMD-1498), and adjacent statements read the
  // same value 96 of 100 times — at this site, with a capture between, 0 of
  // 20 runs did (SMD-1514's probes), so the sleep turns odds into a proof
  // rather than closing a seen flake. The row cannot be aged by an UPDATE
  // while 001's trigger is armed (it re-stamps updated_at = now()), and
  // disabling the trigger would disarm what [9] tests; so a sleep, the one
  // place it is honest here. pg_sleep is a wall-clock lower bound and each
  // statement its own transaction, so the edit's now() is at least 2 ms past
  // the capture's — past the millisecond boundary (measured 200 of 200).
  await db.exec(`SELECT pg_sleep(0.002)`);
  let r: R, audit: Audit | undefined, added: number;
  ({ r, audit, added } = await auditOfWrite(b, () => edit(b, { supersedes: a }, { actor: { name: "editor", source: "test" } })));
  let row = await rowOf(b);
  assert(r.ok === true && row.s === a, `an edit naming supersedes sets the pointer (${JSON.stringify(r)})`);
  assert(row.content === before.content && row.fp === before.fp && row.axis === 1 && row.m === before.m && row.k === 1, "…and touches neither content, fingerprint, vector, label nor metadata");
  assert(row.u > before.u, `…while updated_at moves: a provenance edit is an edit (${before.u.toFixed(3)} -> ${row.u.toFixed(3)})`);
  assert((await audits()) === auditsBefore + 1 && added === 1 && audit?.actor_name === "editor" && audit?.diff.supersedes?.before === null && audit?.diff.supersedes?.after === a && !("content" in (audit?.diff ?? {})) && !("metadata" in (audit?.diff ?? {})),
    `…one audit row, the actor and the supersedes diff and nothing else (${added}; ${audit?.actor_name}: ${JSON.stringify(audit?.diff)})`);
  r = await edit(b, {});
  assert(r.ok === true && (await rowOf(b)).s === a, "an envelope without the key leaves the pointer");
  r = await edit(b, undefined);
  assert(r.ok === true && (await rowOf(b)).s === a, "…as does no envelope — what every 8-argument caller sends");
  assert((await audits()) === auditsBefore + 1, "…and neither writes an audit row: nothing changed");
  r = await edit(b, { derived_from: [c, c.toUpperCase()] });
  row = await rowOf(b);
  assert(r.ok === true && JSON.stringify(row.d) === JSON.stringify([c]) && row.s === a, `derived_from is set canonical — lowercased, de-duplicated — and the pointer is left (${JSON.stringify(row.d)})`);
  ({ r, audit, added } = await auditOfWrite(b, () => edit(b, { supersedes: null })));
  row = await rowOf(b);
  assert(r.ok === true && row.s === null && JSON.stringify(row.d) === JSON.stringify([c]), "a JSON null clears the pointer and leaves derived_from");
  assert(added === 1 && audit?.diff.supersedes?.before === a && audit?.diff.supersedes?.after === null, "…audited as before a, after null");
  r = await edit(b, { derived_from: [] });
  assert(r.ok === true && (await rowOf(b)).d === null, "an empty derived_from array clears the column — [] and null are one spelling");
  ({ r, audit, added } = await auditOfWrite(b, () => edit(b, { derived_from: [c], supersedes: a })));
  row = await rowOf(b);
  assert(r.ok === true && row.s === a && JSON.stringify(row.d) === JSON.stringify([c]), "both keys set in one envelope");
  assert(added === 1 && audit?.diff.supersedes?.after === a && JSON.stringify(audit?.diff.derived_from?.after) === JSON.stringify([c]), `…one audit row carrying both diffs (${added}; ${JSON.stringify(audit?.diff)})`);
  r = await edit(b, { derived_from: null, supersedes: null });
  row = await rowOf(b);
  assert(r.ok === true && row.s === null && row.d === null, "…both cleared in one envelope");

  // Refusals: a ghost, a self-pointer, a loop direct and through a chain; the
  // row and the audit untouched by each.
  const auditsAtRefusals = await audits();
  r = await edit(b, { supersedes: GHOST });
  assert(r.ok === false && r.error === "SUPERSEDES_NOT_FOUND" && r.supersedes === GHOST, `a supersedes naming no thought is refused by name, not by the foreign key (${JSON.stringify(r)})`);
  r = await edit(b, { supersedes: b });
  assert(r.ok === false && r.error === "WOULD_CYCLE", `a thought cannot supersede itself (${r.error})`);
  assert((await edit(b, { supersedes: a })).ok === true, "(b supersedes a)");
  r = await edit(a, { supersedes: b });
  assert(r.ok === false && r.error === "WOULD_CYCLE" && r.supersedes === b, `a pointer closing a direct loop is refused (${r.error})`);
  assert((await edit(c, { supersedes: b })).ok === true, "(c supersedes b, which supersedes a)");
  r = await edit(a, { supersedes: c });
  assert(r.ok === false && r.error === "WOULD_CYCLE", `…and one closing a loop through a chain (${r.error})`);
  assert((await rowOf(a)).s === null && (await rowOf(b)).s === a && (await rowOf(c)).s === b, "…the three pointers as they were");
  assert((await audits()) === auditsAtRefusals + 2, "…two audit rows for the two writes among them, none for a refusal");
  let raised = "";
  try { await edit(a, { supersedes: "nope" }); } catch (e) { raised = (e as Error).message; }
  assert(/supersedes must be a thought UUID string or null/.test(raised), "a supersedes that is not a UUID string raises, as capture does");
  try { await edit(a, { derived_from: ["nope"] }); } catch (e) { raised = (e as Error).message; }
  assert(/derived_from must contain only thought UUID strings/.test(raised), "a non-UUID derived_from element raises 025's message");
  try { await edit(a, { derived_from: [GHOST] }); } catch (e) { raised = (e as Error).message; }
  assert(/derived_from references a thought that does not exist/.test(raised), "…a ghost element too");
  try { await edit(a, { derived_from: "x" }); } catch (e) { raised = (e as Error).message; }
  assert(/derived_from must be a JSON array/.test(raised), "…and a non-array");
  try { await db.query(`SELECT update_thought($1::uuid, NULL::text, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text, '"{\\"supersedes\\":null}"'::jsonb)`, [a]); } catch (e) { raised = (e as Error).message; }
  assert(/p_provenance must be a JSON object, got string/.test(raised), "a double-encoded envelope is refused as 005 refuses a double-encoded payload");
  r = await edit(c, { supersedes: null }, { since: "2000-01-01T00:00:00Z" });
  assert(r.ok === false && r.error === "STALE_READ" && (await rowOf(c)).s === b, "if_unchanged_since guards a provenance edit as it guards every edit");

  // The one rule: validate_derived_from answers as the capture path does —
  // same canonical form, same three messages. One copy since 033 (the
  // 3-argument upsert_thought calls it; [33] asserts the inline copy is
  // gone), so this is the capture routing through it rather than two copies
  // agreeing.
  const vdf = async (v: string | null) => (await db.query<{ r: unknown }>(`SELECT validate_derived_from($1::jsonb) AS r`, [v])).rows[0].r;
  assert((await vdf(null)) === null && (await vdf("null")) === null && (await vdf("[]")) === null, "validate_derived_from: SQL NULL, JSON null and [] are NULL");
  assert(JSON.stringify(await vdf(JSON.stringify([c.toUpperCase(), a, c]))) === JSON.stringify([a, c].sort()), "…a list comes back lowercased, de-duplicated, sorted");
  const capRaise = async (v: unknown) => { try { await db.query(`SELECT upsert_thought('a synthesis 32', $1::jsonb, $2::vector)`, [JSON.stringify({ metadata: {}, derived_from: v }), unit(3)]); return ""; } catch (e) { return (e as Error).message; } };
  const vdfRaise = async (v: unknown) => { try { await vdf(JSON.stringify(v)); return ""; } catch (e) { return (e as Error).message; } };
  const tail = (m: string) => m.replace(/^[^:]*: /, "");
  for (const bad of [["nope"], [GHOST], "x", [1]]) {
    assert(tail(await capRaise(bad)) === tail(await vdfRaise(bad)) && (await vdfRaise(bad)) !== "", `…and refuses ${JSON.stringify(bad)} with the message the capture path gives (${tail(await vdfRaise(bad)).slice(0, 50)}…)`);
  }

  // The review path writes through it: the acceptance's audit row is an
  // update_thought row — the reviewer as actor, the supersedes diff — and a
  // loop update_thought refuses comes back through the proposal with the
  // pair named, as db/consolidate.ts reads it.
  const p = await cap("review: the earlier note", 4);
  const q = await cap("review: the later note", 4);
  await db.query(`UPDATE thoughts SET created_at = now() - interval '5 days' WHERE id = $1`, [p]);
  const propose = async (older: string, newer: string) =>
    (await db.query<{ id: string }>(`SELECT record_supersession_proposal($1::uuid, $2::uuid, 'newer_supersedes_older', 0.9, 'test', 0.99, 'consolidate:stub@p1', NULL) AS id`, [older, newer])).rows[0].id;
  const reviewCall = async (id: string, decision: string) =>
    (await db.query<{ r: Record<string, unknown> }>(`SELECT review_supersession_proposal($1::uuid, $2, NULL, NULL, '{"name":"reviewer","source":"test"}'::jsonb, false) AS r`, [id, decision])).rows[0].r;
  const pid = await propose(p, q);
  const auditsAtReview = await audits();
  const accepted = await auditOfWrite(q, () => reviewCall(pid, "accept"));
  const acc = accepted.r;
  assert(acc.ok === true && acc.written === true && (await rowOf(q)).s === p, `accept writes the pointer through update_thought (${JSON.stringify(acc)})`);
  audit = accepted.audit;
  assert((await audits()) === auditsAtReview + 1 && accepted.added === 1 && audit?.actor_name === "reviewer" && audit?.diff.supersedes?.before === null && audit?.diff.supersedes?.after === p,
    `…one audit row, the reviewer as actor, the supersedes diff — update_thought's row (${accepted.added}; ${audit?.actor_name}: ${JSON.stringify(audit?.diff)})`);
  const rejected = await auditOfWrite(q, () => reviewCall(pid, "reject"));
  const rej = rejected.r;
  assert(rej.ok === true && rej.cleared === true && (await rowOf(q)).s === null && rejected.added === 1 && rejected.audit?.diff.supersedes?.after === null, "reject clears it through update_thought, audited the same way");
  const x = await cap("loop: the earlier note", 5);
  const y = await cap("loop: the later note", 5);
  await db.query(`UPDATE thoughts SET created_at = now() - interval '5 days' WHERE id = $1`, [x]);
  assert((await edit(x, { supersedes: y })).ok === true, "(x, the older, supersedes y by hand)");
  const loopPid = await propose(x, y);
  const loop = await reviewCall(loopPid, "accept");
  assert(loop.ok === false && loop.error === "WOULD_CYCLE" && loop.id === loopPid && loop.superseding_id === y && loop.superseded_id === x,
    `accepting a pointer that closes a loop is refused by update_thought's walk, and the proposal answers with the pair named (${JSON.stringify(loop)})`);
  assert((await rowOf(y)).s === null && (await db.query<{ s: string }>(`SELECT status AS s FROM supersession_proposals WHERE id = $1`, [loopPid])).rows[0].s === "pending", "…nothing written, the proposal still pending");

  // The trap this migration's DROP exists for: 021 re-applied by hand puts
  // the 8-argument form back BESIDE 032's (021 drops only the 7-argument
  // one), and every call with eight arguments or fewer — reembed.ts's, every
  // PostgREST caller by name from before this change — is ambiguous. The
  // last definer (033, carrying 032's DROP block) re-applied drops it again.
  // And the ACL crosses the DROP from the 8-argument form, as 021 carried it
  // from the 7-argument one.
  await reapply("021");
  assert((await functionsNamed("update_thought")) === 2 && (await exists(UT_8)), "021 re-applied over 032 leaves its 8-argument form beside the 9-argument one");
  let ambiguous = "";
  try { await db.query(`SELECT update_thought($1::uuid, 'x', NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text)`, [a]); }
  catch (e) { ambiguous = (e as Error).message; }
  assert(/not unique/.test(ambiguous), `…after which an 8-argument call — reembed.ts's — is "function is not unique" (${ambiguous.slice(0, 40)})`);
  await restoreShipped("update_thought", "upsert_thought");
  assert((await functionsNamed("update_thought")) === 1 && !(await exists(UT_8)), "…and the last definer re-applied drops it (032's DROP block, carried by 033)");
  const acl = async (sig: string) => String((await db.query<{ a: string | null }>(`SELECT proacl::text AS a FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0]?.a ?? "");
  const hasPublic = (s: string) => /(^\{|,)=X\//.test(s);
  await db.exec(`CREATE ROLE ob1_test_editor32`);
  await db.exec(`DROP FUNCTION ${UT}`);
  await reapply("021");
  assert((await exists(UT_8)) && !(await exists(UT)), "(a pre-032 brain: 021's form alone)");
  await db.exec(`REVOKE ALL ON FUNCTION ${UT_8} FROM PUBLIC`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${UT_8} TO ob1_test_editor32 WITH GRANT OPTION`);
  await restoreShipped("update_thought", "upsert_thought");
  const granted = await acl(UT);
  assert(!hasPublic(granted) && /ob1_test_editor32=X\*\//.test(granted) && !(await exists(UT_8)), `a revoke and a grant with grant option on the 8-argument form are carried to the 9-argument one across the DROP (${granted})`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${UT} TO PUBLIC`);
  await db.exec(`REVOKE ALL ON FUNCTION ${UT} FROM ob1_test_editor32`);
  await db.exec(`DROP ROLE ob1_test_editor32`);
  // Read from the catalog, not the files: whether restoring upsert_thought
  // above put 025's per-path trace_provenance back (it did while 025 was the
  // last definer; 033 touches no trace_provenance). Restored either way.
  assert(/ob1:provenance-walk-bounded/.test(await srcOf("trace_provenance(uuid, int, int)")), "(restoring upsert_thought left 026's trace_provenance in place — its last definer touches no trace_provenance)");
  await restoreShipped("trace_provenance");
  await db.exec(`DELETE FROM supersession_proposals`);
  await db.exec(`DELETE FROM thoughts`);
}

// ── 33. Migration 033 — the capture takes the fingerprint lock ───────────────
//
// Both inserting upsert_thought overloads take 018's advisory lock before
// they read or write the row the text lands on; the 3-argument form takes
// 029/032's supersession lock first when the envelope names a pointer, hashes
// through 016 and validates derived_from through 032. The concurrency itself
// — a capture and an edit of one text serialised, the two races 022 named
// closed — is db/test-live.ts [6e], which PGlite's single session cannot run.
// This section is the bodies, the behaviour that must not have moved, the
// one addition (the 2-argument form attributes), the residue the header
// states, and the trap.

console.log("\n[33] Migration 033: both capture forms take the fingerprint lock, spelled as 018 spells it, and carry everything before them (SMD-1043)");
{
  await db.exec(`DELETE FROM thoughts`);
  const TWO = "upsert_thought(text, jsonb)";
  const THREE = "upsert_thought(text, jsonb, vector)";
  const FOUR = "upsert_thought(text, jsonb, vector, jsonb)";
  const srcOf = async (sig: string) => String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0].s);
  const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));";
  const two = await srcOf(TWO), three = await srcOf(THREE), four = await srcOf(FOUR), edit = await srcOf(UPDATE_THOUGHT_SIGNATURE);

  // The shape: three overloads and one update_thought, 033 the last definer
  // of update_thought and 035 of upsert_thought (035 carries 033's bodies
  // with the fill and the supersession lock gone — [35]), the lock spelled
  // once.
  assert((await functionsNamed("upsert_thought")) === 3 && (await functionsNamed("update_thought")) === 1 && lastDefinerOf("upsert_thought").startsWith("035") && lastDefinerOf("update_thought").startsWith("033"),
    `three upsert_thought overloads and one update_thought, 033 the last definer of update_thought and 035 of upsert_thought (${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("update_thought")})`);
  assert(two.includes(LOCK) && three.includes(LOCK) && edit.includes(LOCK), "the 2- and 3-argument bodies and update_thought spell the fingerprint lock identically — the same key is the same lock");
  // update_thought's order since 033: the fingerprint lock BEFORE the row
  // read, whenever content arrives — one order for every writer, so the
  // four-transaction cycle the first review pass reproduced (two edits
  // swapping two rows' texts while both are re-captured; db/test-live.ts
  // [6f]) has no crossing left. 018's shortcut — no second hash, no lookup,
  // when the row owns the key — stays; 018's sentinel stays.
  const iEditFp = edit.indexOf(LOCK), iEditRow = edit.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE"), iEditSup = edit.indexOf("hashtext('ob1:supersession-review')");
  assert(iEditSup > 0 && iEditSup < iEditFp && iEditFp < iEditRow, `update_thought acquires supersession lock, then fingerprint lock, then its row (${iEditSup} < ${iEditFp} < ${iEditRow})`);
  assert((edit.match(/pg_advisory_xact_lock\(hashtextextended/g) ?? []).length === 1 && /IF p_content IS NOT NULL THEN\s+v_fingerprint := content_fingerprint_of\(p_content\);\s+PERFORM pg_advisory_xact_lock/.test(edit),
    "…the one fingerprint lock in the body, taken whenever content arrives rather than only when the row does not own the key");
  assert(/ob1:unchanged-edit-not-duplicate/.test(edit) && /v_existing\.content_fingerprint = v_fingerprint THEN/.test(edit), "…keeping 018's sentinel and its owns-the-key shortcut for the lookup");
  assert(/ob1:capture-takes-fingerprint-lock/.test(two) && /ob1:capture-takes-fingerprint-lock/.test(three), "…and both capture bodies carry the ob1:capture-takes-fingerprint-lock sentinel preflight reads");
  assert(!/ob1:capture-takes-fingerprint-lock/.test(four) && !/pg_advisory_xact_lock/.test(four) && /elem->>'context'/.test(four), "the 4-argument form is 013's, untouched: it delegates to the 3-argument body and takes its lock there");
  // Order in the 3-argument body: fingerprint lock, the row read, the INSERT
  // — by position in the source. 033 took the supersession lock first when
  // the envelope named supersedes; 035 dropped it with the fill ([35]).
  const at = (re: RegExp, src = three) => { const m = re.exec(src); return m ? m.index : -1; };
  const iSup = at(/hashtext\('ob1:supersession-review'\)/), iFp = at(/hashtextextended\(v_fingerprint, 0\)/), iRead = at(/content_fingerprint = v_fingerprint FOR NO KEY UPDATE/), iIns = at(/INSERT INTO thoughts/);
  assert(iSup === -1 && iFp > 0 && iFp < iRead && iRead < iIns, `the 3-argument body takes no supersession lock (035), acquires the fingerprint lock, then reads the row, then inserts (${iSup}; ${iFp} < ${iRead} < ${iIns})`);
  assert(at(/hashtextextended\(v_fingerprint, 0\)/, two) < at(/INSERT INTO thoughts/, two), "…and the 2-argument body locks before it inserts");
  // One owner per rule: 016's hash, 032's derived_from — no inline copy left.
  assert(/content_fingerprint_of\(p_content\)/.test(two) && /content_fingerprint_of\(p_content\)/.test(three) && !/regexp_replace/.test(two) && !/regexp_replace/.test(three),
    "both bodies hash through content_fingerprint_of — the last two inline copies of 003's rule are gone");
  assert(/validate_derived_from\(p_payload->'derived_from'\)/.test(three) && !/jsonb_array_elements\(v_derived\)/.test(three), "the 3-argument body validates derived_from through validate_derived_from — 025's inline copy is gone");
  // What a successor must carry, read out of pg_proc by name.
  for (const [re, what] of [
    [/jsonb_typeof\(p_payload\) <> 'object'/, "005's guard"], [/set_config\('ob1\.actor'/, "008's actor"], [/p_payload->>'embedding_model'/, "021's label"], [/ELSE EXCLUDED\.embedding_model END/, "021's ON CONFLICT label clause"],
    [/v_existed := FOUND/, "022's FOUND"], [/DELETE FROM thought_chunks WHERE thought_id = v_id/, "022's chunk DELETE"], [/ob1:vector-replaces-chunks/, "022's sentinel"],
    [/supersedes must be a thought UUID string/, "025's supersedes shape check"], [/v_supersedes::uuid/, "025's two columns in the INSERT (the ON CONFLICT fill is 035's to have removed — [35])"],
  ] as [RegExp, string][]) assert(re.test(three), `…the 3-argument body carrying ${what}`);
  assert(/jsonb_typeof\(p_payload\) <> 'object'/.test(two) && /set_config\('ob1\.actor'/.test(two), "…the 2-argument body carrying 005's guard and, since 033, 008's actor");

  // Behaviour that must not have moved: [6], [7], [11], [22], [23], [25]
  // passed over this body above; here the pieces closest to the change.
  const cap = async (content: string, payload: Record<string, unknown>, vec: string | null) =>
    (await db.query<{ r: { id: string; fingerprint: string } }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(payload), vec])).rows[0].r;
  const a = await cap("a locked capture", { metadata: { k: 1 }, embedding_model: "model-a" }, unit(0));
  assert(a.fingerprint === (await fpOf("a locked capture")), "the fingerprint returned is content_fingerprint_of's");
  const again = await cap("A   locked capture", { metadata: { j: 2 } }, null);
  assert(again.id === a.id && (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts`)).rows[0].c === 1, "a re-capture merges as before");
  const two2 = (await db.query<{ r: { id: string } }>(`SELECT upsert_thought('a two-argument capture 33', '{"metadata":{},"actor":{"name":"fallback-caller","source":"postgrest"}}'::jsonb) AS r`)).rows[0].r.id;
  const audit2 = (await db.query<{ actor_name: string | null }>(`SELECT actor_name FROM thought_audit WHERE thought_id = $1 AND action = 'capture'`, [two2])).rows[0];
  assert(audit2?.actor_name === "fallback-caller", `a capture through the 2-argument form is attributed — the envelope's actor reaches the audit trigger (${audit2?.actor_name})`);
  // The locks are transaction-scoped: nothing is held once the call returns
  // (every call above ran as its own transaction).
  const held = (await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].c;
  assert(held === 0, `no advisory lock outlives the call (${held} held)`);
  // A capture naming supersedes and derived_from still validates and writes
  // them, and the refusals are validate_derived_from's.
  const b = await cap("the newer locked capture", { metadata: {}, supersedes: a.id, derived_from: [a.id] }, unit(1));
  const rowB = (await db.query<{ s: string; d: unknown }>(`SELECT supersedes AS s, derived_from AS d FROM thoughts WHERE id = $1`, [b.id])).rows[0];
  assert(rowB.s === a.id && JSON.stringify(rowB.d) === JSON.stringify([a.id]), "a capture naming provenance writes it on its fresh row under the fingerprint lock");
  let raised = "";
  try { await cap("bad provenance 33", { metadata: {}, derived_from: ["nope"] }, unit(2)); } catch (e) { raised = (e as Error).message; }
  assert(/derived_from must contain only thought UUID strings/.test(raised) && !/^upsert_thought:/.test(raised.replace(/^error: /, "")), `a bad derived_from is refused with validate_derived_from's message (${raised.slice(0, 60)})`);
  try { await cap("bad supersedes 33", { metadata: {}, supersedes: "nope" }, unit(2)); } catch (e) { raised = (e as Error).message; }
  assert(/upsert_thought: supersedes must be a thought UUID string/.test(raised), "…and a bad supersedes with 025's own message, prefix kept");

  // The residue 033's header stated (SMD-1453) — a re-capture filling a NULL
  // pointer without a walk, R → X → R — is [35]'s now: 035 removed the fill.

  // The trap: 025 re-applied by hand puts an unlocked 3-argument body back
  // (its file defines that form; the 2-argument one keeps 033's = 035's);
  // 005 puts both back unlocked. 035, the last definer, restores both.
  await reapply("025");
  assert(!/ob1:capture-takes-fingerprint-lock/.test(await srcOf(THREE)) && /ob1:capture-takes-fingerprint-lock/.test(await srcOf(TWO)), "025 re-applied over 033 puts an unlocked 3-argument body back and leaves the 2-argument one locked");
  await reapply("005");
  assert(!/ob1:capture-takes-fingerprint-lock/.test(await srcOf(TWO)) && !/set_config\('ob1\.actor'/.test(await srcOf(TWO)), "005 re-applied puts 005's 2-argument body back: no lock, no actor");
  // 025 re-applied also put its per-path trace_provenance back over 026's —
  // read from the catalog, not the files ([25]'s note): restored with the rest.
  assert(!/ob1:provenance-walk-bounded/.test(await srcOf("trace_provenance(uuid, int, int)")), "(025 re-applied put its unbounded trace_provenance back too — 026's sentinel is gone)");
  await restoreShipped("upsert_thought", "trace_provenance");
  assert(/ob1:capture-takes-fingerprint-lock/.test(await srcOf(TWO)) && /ob1:capture-takes-fingerprint-lock/.test(await srcOf(THREE)) && (await functionsNamed("upsert_thought")) === 3, "035 re-applied: both bodies locked again, three overloads");
  assert(/ob1:provenance-walk-bounded/.test(await srcOf("trace_provenance(uuid, int, int)")), "…and 026 re-applied: the bounded walk's sentinel is back");
  // 032 re-applied by hand over 033 puts 032's update_thought back — the
  // row → fingerprint order, no sentinel to say so (the header states it);
  // 033 re-applied restores the order.
  await reapply("032");
  const edit032 = await srcOf(UPDATE_THOUGHT_SIGNATURE);
  assert(edit032.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") < edit032.indexOf(LOCK) && (await functionsNamed("update_thought")) === 1, "032 re-applied over 033 puts the row-then-fingerprint order back, one function still");
  // reapply("032") reverts update_thought AND review_supersession_proposal to
  // 032's bodies; restoring update_thought re-applies 033, which also rewrites
  // both capture forms as 033's. So restore all three shipped bodies:
  // update_thought (033), upsert_thought (035, recapture), and
  // review_supersession_proposal (036, its lock moved before the proposal row).
  await restoreShipped("update_thought", "upsert_thought", "review_supersession_proposal");
  const edit033 = await srcOf(UPDATE_THOUGHT_SIGNATURE);
  assert(edit033.indexOf(LOCK) < edit033.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") && (await functionsNamed("update_thought")) === 1, "…and 033 re-applied puts the fingerprint lock before the row again");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 34. Migration 034 — the opt-in query log ─────────────────────────────────
//
// A new table and one maintenance function, nothing on the capture path. This
// section is the table's shape (the two CHECKs that keep a search row and an
// action row honest), the two indexes the export join uses, the export join
// itself over hand-made rows, and prune_query_log's bounded delete. The
// server-side on/off behaviour is server-portable's e2e (this file has no
// server); here the table stands on its own, as [30]/[31] do for their tables.

console.log("\n[34] Migration 034: query_log shape + CHECKs, the export join, and prune_query_log's bounded delete (SMD-1295)");
{
  // The one spelling: the table and function this section drives are the names
  // config.mjs hands the server, preflight and the export tool.
  assert(QUERY_LOG.table === "query_log" && QUERY_LOG.prune === "prune_query_log", `config.mjs QUERY_LOG names the 034 objects (${QUERY_LOG.table}, ${QUERY_LOG.prune})`);

  const cols = (await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'query_log' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  const expected = ["id", "logged_at", "kind", "agent_id", "tool", "query", "match_count", "threshold", "recency_weight", "filter", "result_ids", "result_scores", "target_id"];
  assert(JSON.stringify(cols) === JSON.stringify(expected), `query_log has exactly its columns in order (${cols.join(", ")})`);

  // The two indexes the export join relies on: a btree on (agent_id, logged_at)
  // and a partial GIN on result_ids for the @> containment lookup.
  const idx = (await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'query_log'`)).rows;
  assert(idx.some((r) => /USING btree \(agent_id, logged_at\)/.test(r.indexdef)), "(agent_id, logged_at) btree exists for the join's agent-and-time narrowing");
  assert(idx.some((r) => /USING gin \(result_ids\)/.test(r.indexdef) && /WHERE \(kind = 'search'::text\)/.test(r.indexdef)), "a partial GIN on result_ids (search rows) answers the @> containment lookup");

  // The CHECKs: a search row must carry a query, an action row a target.
  let refusedSearch = false;
  try { await db.exec(`INSERT INTO query_log (kind, tool) VALUES ('search', 'search_thoughts')`); }
  catch { refusedSearch = true; }
  assert(refusedSearch, "a 'search' row with no query is refused by the CHECK");
  let refusedAction = false;
  try { await db.exec(`INSERT INTO query_log (kind, tool) VALUES ('action', 'fetch')`); }
  catch { refusedAction = true; }
  assert(refusedAction, "an 'action' row with no target_id is refused by the CHECK");
  let refusedKind = false;
  try { await db.exec(`INSERT INTO query_log (kind, tool, query) VALUES ('other', 'x', 'q')`); }
  catch { refusedKind = true; }
  assert(refusedKind, "an unknown kind is refused by the CHECK");

  // The export join over hand-made rows: an agent searches (id a and b returned,
  // a null score among them), then fetches b. The action links to the search by
  // (agent, id, window). A second, anonymous delete of a — returned by the same
  // search — does NOT link, because a NULL agent is its own bucket.
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const AG = "99999999-9999-4999-8999-999999999999";
  await db.exec(`
    INSERT INTO query_log (kind, tool, agent_id, query, match_count, threshold, recency_weight, filter, result_ids, result_scores)
      VALUES ('search', 'search_thoughts', '${AG}'::uuid, 'how many projects have I led', 10, 0, 0, '{}'::jsonb,
              ARRAY['${A}','${B}']::uuid[], ARRAY[0.42, NULL]::real[]);
    INSERT INTO query_log (kind, tool, agent_id, target_id) VALUES ('action', 'fetch', '${AG}'::uuid, '${B}'::uuid);
    INSERT INTO query_log (kind, tool, target_id)          VALUES ('action', 'delete_thought', '${A}'::uuid);`);

  const joined = (await db.query<{ action: string; from_query: string | null }>(`
    SELECT act.tool AS action,
           (SELECT s.query FROM query_log s
             WHERE s.kind='search' AND s.agent_id IS NOT DISTINCT FROM act.agent_id
               AND s.logged_at <= act.logged_at AND s.result_ids @> ARRAY[act.target_id]
             ORDER BY s.logged_at DESC LIMIT 1) AS from_query
      FROM query_log act WHERE act.kind='action' ORDER BY act.tool`)).rows;
  assert(joined.length === 2, "two action rows to attribute");
  const del = joined.find((r) => r.action === "delete_thought");
  const fetchRow = joined.find((r) => r.action === "fetch");
  assert(fetchRow?.from_query === "how many projects have I led", "the fetch of a returned id links to the search that returned it");
  assert(del?.from_query === null, "the anonymous delete does not link to an agent's search — a NULL agent is its own bucket");

  // A search row keeps its null score element and its empty-array shape.
  const scores = (await db.query<{ result_scores: (number | null)[] }>(
    `SELECT result_scores FROM query_log WHERE kind='search'`)).rows[0];
  // real is single-precision, so 0.42 comes back as its float4 rounding; a SQL
  // NULL element arrives as null, undefined or NaN depending on the driver
  // (PGlite gives NaN, Bun's Postgres gives null) — all mean "no score for this
  // returned id", which the export ignores anyway (it needs the ids, not scores).
  const s0 = scores.result_scores[0] as number;
  const s1 = scores.result_scores[1] as number | null | undefined;
  assert(Array.isArray(scores.result_scores) && Math.abs(s0 - 0.42) < 1e-6 && (s1 == null || Number.isNaN(s1)), `result_scores carries a score and a null element (${JSON.stringify(scores.result_scores)})`);

  // The window bound the export applies (export-queries.ts): a touch links only
  // to a search within OB1_EXPORT_WINDOW_MIN before it. A search older than the
  // window does not attribute, even though it returned the id — the clause
  // [33] mirrors from the export so the window's behaviour is not unexercised.
  const C = "33333333-3333-4333-8333-333333333333";
  const AG2 = "88888888-8888-4888-8888-888888888888";
  await db.exec(`
    INSERT INTO query_log (kind, tool, agent_id, query, match_count, threshold, recency_weight, filter, result_ids, result_scores, logged_at)
      VALUES ('search', 'search_thoughts', '${AG2}'::uuid, 'a stale search', 10, 0, 0, '{}'::jsonb,
              ARRAY['${C}']::uuid[], ARRAY[0.9]::real[], now() - interval '2 hours');
    INSERT INTO query_log (kind, tool, agent_id, target_id) VALUES ('action', 'fetch', '${AG2}'::uuid, '${C}'::uuid);`);
  const windowed = (await db.query<{ from_query: string | null }>(`
    SELECT (SELECT s.query FROM query_log s
             WHERE s.kind='search' AND s.query IS NOT NULL
               AND s.agent_id IS NOT DISTINCT FROM act.agent_id
               AND s.logged_at <= act.logged_at
               AND s.logged_at >= act.logged_at - make_interval(mins => 30)
               AND s.result_ids @> ARRAY[act.target_id]
             ORDER BY s.logged_at DESC LIMIT 1) AS from_query
      FROM query_log act WHERE act.kind='action' AND act.agent_id = '${AG2}'::uuid`)).rows[0];
  assert(windowed.from_query === null, "a search older than the export window does not attribute a later touch");

  // Positive control (a clean bucket): a search INSIDE the window does attribute,
  // so the null above is the window bound excluding, not the whole clause failing.
  const D = "44444444-4444-4444-8444-444444444444";
  const AG3 = "77777777-7777-4777-8777-777777777777";
  await db.exec(`
    INSERT INTO query_log (kind, tool, agent_id, query, match_count, threshold, recency_weight, filter, result_ids, result_scores, logged_at)
      VALUES ('search', 'search_thoughts', '${AG3}'::uuid, 'a fresh search', 10, 0, 0, '{}'::jsonb,
              ARRAY['${D}']::uuid[], ARRAY[0.9]::real[], now() - interval '5 minutes');
    INSERT INTO query_log (kind, tool, agent_id, target_id) VALUES ('action', 'fetch', '${AG3}'::uuid, '${D}'::uuid);`);
  const inWindow = (await db.query<{ from_query: string | null }>(`
    SELECT (SELECT s.query FROM query_log s
             WHERE s.kind='search' AND s.query IS NOT NULL
               AND s.agent_id IS NOT DISTINCT FROM act.agent_id
               AND s.logged_at <= act.logged_at
               AND s.logged_at >= act.logged_at - make_interval(mins => 30)
               AND s.result_ids @> ARRAY[act.target_id]
             ORDER BY s.logged_at DESC LIMIT 1) AS from_query
      FROM query_log act WHERE act.kind='action' AND act.agent_id = '${AG3}'::uuid`)).rows[0];
  assert(inWindow.from_query === "a fresh search", "a search within the window does attribute the touch");

  // prune_query_log: default arg, bounded delete, the strict bound, and a
  // refusal on a bad window.
  const nBefore = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n;
  const keptByDefault = (await db.query<{ n: number }>(`SELECT prune_query_log() AS n`)).rows[0].n;
  assert(keptByDefault === 0 && (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n === nBefore, "prune_query_log() with the default 30-day window deletes nothing fresh");
  // The bound is `logged_at < now()`, strict, and now() is the transaction's
  // start, read from a clock that under PGlite has millisecond grain, so a row
  // inserted a few statements earlier can share the prune's now() and survive
  // prune_query_log(0) (flaked once, SMD-1498). Age the rows; the assumption
  // was the flaw, not the function.
  await db.exec(`UPDATE query_log SET logged_at = logged_at - interval '1 hour'`);
  const wiped = (await db.query<{ n: number }>(`SELECT prune_query_log(0) AS n`)).rows[0].n;
  assert(Number(wiped) === nBefore && (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n === 0, `prune_query_log(0) deletes every row older than now() (${wiped} of ${nBefore})`);
  // The same now(), on purpose: a row logged in the prune's own transaction is
  // kept — the strict bound the COMMENT states ("older than now()"). now() is
  // the transaction's start on Postgres proper too; only the clock's grain
  // differs, and strictness decides only this equality: a `<=` bound, or one
  // read from clock_timestamp(), fails this assertion and no other here.
  await db.transaction(async (tx) => {
    await tx.exec(`INSERT INTO query_log (kind, tool, query) VALUES ('search', 'search_thoughts', 'logged in the prune''s own transaction')`);
    const sameTick = Number((await tx.query<{ n: number }>(`SELECT prune_query_log(0) AS n`)).rows[0].n);
    const left = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n;
    assert(sameTick === 0 && left === 1, "a row logged at the prune's own now() is kept — the bound is strict (logged_at < now())");
    await tx.rollback();
  });
  let refusedNeg = false;
  try { await db.exec(`SELECT prune_query_log(-1)`); } catch { refusedNeg = true; }
  assert(refusedNeg, "prune_query_log refuses a negative window");
}

console.log("\n[35] Migration 035: a re-capture writes no provenance — the envelope's derived_from and supersedes land on a first capture only, no capture takes the supersession lock, and the return says existed (SMD-1453)");
{
  await db.exec(`DELETE FROM thoughts`);
  const TWO = "upsert_thought(text, jsonb)";
  const THREE = "upsert_thought(text, jsonb, vector)";
  const FOUR = "upsert_thought(text, jsonb, vector, jsonb)";
  const REVIEW = "review_supersession_proposal(uuid, text, text, text, jsonb, boolean)";
  const srcOf = async (sig: string) => String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).rows[0].s);
  const commentOf = async (sig: string) => String((await db.query<{ d: string }>(`SELECT obj_description($1::regprocedure, 'pg_proc') AS d`, [sig])).rows[0].d);
  const three = await srcOf(THREE);
  type R = { id: string; fingerprint: string; existed?: boolean; supersedes?: string | null; chunks?: number };
  const cap = async (content: string, payload: Record<string, unknown>, vec: string | null) =>
    (await db.query<{ r: R }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(payload), vec])).rows[0].r;
  const prov = async (id: string) => (await db.query<{ s: string | null; d: unknown }>(`SELECT supersedes AS s, derived_from AS d FROM thoughts WHERE id = $1`, [id])).rows[0];
  const edit = async (id: string, envelope: Record<string, unknown>) =>
    (await db.query<{ r: { ok: boolean; error?: string } }>(`SELECT update_thought($1::uuid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2::jsonb) AS r`, [id, JSON.stringify(envelope)])).rows[0].r;
  const twoRowLoops = async () => Number((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts a JOIN thoughts b ON b.id = a.supersedes AND b.supersedes = a.id AND a.id < b.id`)).rows[0].c);

  // The shape: 035 the last definer of upsert_thought, 033 still of
  // update_thought, which this file does not touch.
  assert(lastDefinerOf("upsert_thought").startsWith("035") && lastDefinerOf("update_thought").startsWith("033") && (await functionsNamed("upsert_thought")) === 3,
    `035 is the last definer of upsert_thought and 033 of update_thought, three overloads (${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("update_thought")})`);
  // The 3-argument body, read from pg_proc: 035's sentinel beside 022's and
  // 033's; no supersession lock; an ON CONFLICT clause that sets neither
  // column while the INSERT still lists both; the row read for every
  // capture; `existed` in the return.
  assert(/ob1:re-capture-writes-no-provenance/.test(three) && /ob1:capture-takes-fingerprint-lock/.test(three) && /ob1:vector-replaces-chunks/.test(three), "the 3-argument body carries 035's sentinel beside 022's and 033's");
  assert(!/supersession-review/.test(three), "…and takes no supersession lock — hashtext('ob1:supersession-review') is gone from the body");
  const iDo = three.indexOf("DO UPDATE"), iRet = three.indexOf("RETURNING id, supersedes INTO v_id, v_supersedes_now");
  assert(iDo > 0 && iRet > iDo, `the ON CONFLICT clause and its RETURNING are both in the body, in that order (${iDo}, ${iRet}) — the slice below is bounded by real anchors, not -1 (third review pass)`);
  const onConflict = three.slice(iDo, iRet);
  assert(onConflict.length > 0 && !/supersedes\s*=/.test(onConflict) && !/derived_from\s*=/.test(onConflict) && !/COALESCE\(thoughts\.(supersedes|derived_from)/.test(three), "…its ON CONFLICT clause sets neither derived_from nor supersedes — 025's add-if-empty is gone");
  assert(/INSERT INTO thoughts \(content, content_fingerprint, metadata, embedding, embedding_model, derived_from, supersedes\)/.test(three) && /v_supersedes::uuid/.test(three) && /validate_derived_from\(p_payload->'derived_from'\)/.test(three), "…while the INSERT still writes both from the envelope, validated");
  assert(!/IF p_embedding IS NOT NULL THEN\s+SELECT embedding_model/.test(three) && /FOR NO KEY UPDATE;\s+v_existed := FOUND;/.test(three) && /'existed', v_existed, 'supersedes', v_supersedes_now\)/.test(three) && /RETURNING id, supersedes INTO v_id, v_supersedes_now/.test(three),
    "…the row read runs for every capture and the return carries existed and the row's supersedes after the write");
  assert(/IF p_embedding IS NOT NULL AND v_existed/.test(three), "…and the chunk DELETE keeps 022's condition — a vector arrived, a row was there");
  const four = await srcOf(FOUR);
  assert(/upsert_thought\(p_content, p_payload, p_embedding\)/.test(four) && /v_result \|\| jsonb_build_object/.test(four), "the 4-argument form still delegates and appends to the inner return, so existed passes through");
  const two = await srcOf(TWO);
  assert(/ob1:capture-takes-fingerprint-lock/.test(two) && /set_config\('ob1\.actor'/.test(two) && /jsonb_typeof\(p_payload\) <> 'object'/.test(two) && !/existed/.test(two), "the 2-argument body is 033's, carried: locked, attributed, guarded, no existed");

  // Behaviour. A first capture writes provenance and says existed: false.
  const a = await cap("035 the earlier note", { metadata: {} }, unit(0));
  assert(a.existed === false && a.supersedes === null && (await prov(a.id)).s === null, "a first capture says existed: false, supersedes: null");
  const b = await cap("035 the later note", { metadata: {}, supersedes: a.id, derived_from: [a.id] }, unit(1));
  const pb = await prov(b.id);
  assert(b.existed === false && b.supersedes === a.id && pb.s === a.id && JSON.stringify(pb.d) === JSON.stringify([a.id]), "a first capture naming provenance writes it on its fresh row, and the return carries the pointer");
  // A re-capture naming DIFFERENT provenance leaves what is there (025's
  // half that stays)…
  const c = await cap("035 a third note", { metadata: {} }, unit(2));
  const bAgain = await cap("035 the later note", { metadata: { k: 1 }, supersedes: c.id, derived_from: [c.id] }, unit(1));
  const pb2 = await prov(b.id);
  assert(bAgain.id === b.id && bAgain.existed === true && bAgain.supersedes === a.id && pb2.s === a.id && JSON.stringify(pb2.d) === JSON.stringify([a.id]), "a re-capture naming other provenance leaves the row's, and says existed: true with the pointer that STANDS, not the one named");
  assert((await db.query<{ k: number }>(`SELECT (metadata->>'k')::int AS k FROM thoughts WHERE id = $1`, [b.id])).rows[0].k === 1, "…while its metadata merged as before");
  // …and a re-capture of a row with NONE fills nothing — the half 035 removes.
  const aAgain = await cap("035 the earlier note", { metadata: {}, supersedes: c.id, derived_from: [c.id] }, unit(0));
  const pa = await prov(a.id);
  assert(aAgain.id === a.id && aAgain.existed === true && aAgain.supersedes === null && pa.s === null && pa.d === null, "a re-capture naming provenance over a row that has none writes none — 025's fill is gone — and returns supersedes: null");
  // A vectorless re-capture says existed too: the read runs without a vector.
  const aPlain = await cap("035 the earlier note", { metadata: {} }, null);
  assert(aPlain.id === a.id && aPlain.existed === true, "a vectorless re-capture says existed: true — the row read runs for every capture");
  // Through the 4-argument form `existed` passes beside `chunks` — asserted
  // from 013's source above and called on a real server in test-live [13],
  // not here: PGlite aborts with a WASM out-of-bounds on a windowed capture
  // through that form (at 033 as at 035 — a probe applying each and calling
  // it twice crashed on the second call under both), while every Postgres
  // suite that captures with windows passes.
  // Validation still runs on a dedup: the envelope is checked before the
  // write is known to be one.
  let raised = "";
  try { await cap("035 the earlier note", { metadata: {}, derived_from: ["nope"] }, unit(0)); } catch (e) { raised = (e as Error).message; }
  assert(/derived_from must contain only thought UUID strings/.test(raised), "a re-capture with a malformed derived_from is refused as a first one is");
  raised = "";
  try { await cap("035 the earlier note", { metadata: {}, supersedes: "nope" }, unit(0)); } catch (e) { raised = (e as Error).message; }
  assert(/upsert_thought: supersedes must be a thought UUID string/.test(raised), "…and a malformed supersedes likewise");
  // A supersedes that names NO thought on a dedup: the FK ran only on the fill,
  // so nothing refuses it here — existed, nothing written — and update_thought,
  // the path the tool's reply names, refuses it by name (stated in the header).
  const ghost = await cap("035 the earlier note", { metadata: {}, supersedes: "00000000-0000-4000-8000-000000000000" }, unit(0));
  assert(ghost.id === a.id && ghost.existed === true && (await prov(a.id)).s === null, "a re-capture naming a supersedes that names no thought is not refused: existed, nothing written");
  assert((await edit(a.id, { supersedes: "00000000-0000-4000-8000-000000000000" })).error === "SUPERSEDES_NOT_FOUND", "…and update_thought, the path the reply names, refuses it by name");
  let fkRaised = "";
  try { await cap("035 a fresh note naming a ghost", { metadata: {}, supersedes: "00000000-0000-4000-8000-000000000000" }, unit(6)); } catch (e) { fkRaised = (e as Error).message; }
  assert(/foreign key|violates/.test(fkRaised), `…while a first capture naming one still fails its FK check, as 025 left it (${fkRaised.slice(0, 60)})`);

  // SMD-1453's case, sequential: R with no pointer, X superseding R, then R's
  // text captured naming X. [33] wrote R → X → R at 033; now nothing is
  // written, and the one path left to that pointer walks and refuses it.
  const r = await cap("035 residue: the earlier note", { metadata: {} }, unit(3));
  const x = await cap("035 residue: the later note", { metadata: {}, supersedes: r.id }, unit(4));
  const rAgain = await cap("035 residue: the earlier note", { metadata: {}, supersedes: x.id }, unit(3));
  const loop = (await db.query<{ rs: string | null; xs: string }>(`SELECT (SELECT supersedes FROM thoughts WHERE id = $1) AS rs, (SELECT supersedes FROM thoughts WHERE id = $2) AS xs`, [r.id, x.id])).rows[0];
  assert(rAgain.existed === true && loop.rs === null && loop.xs === r.id, "R's text re-captured naming X writes no pointer: X → R stands alone, no loop — the residue 033 stated is closed");
  const refused = await edit(r.id, { supersedes: x.id });
  assert(refused.ok === false && refused.error === "WOULD_CYCLE", `…and update_thought's envelope, asked for the same pointer, walks and refuses it (${refused.error})`);
  assert((await twoRowLoops()) === 0, "…no two-row loop in the table (the header's query)");

  // No supersession lock: inside one transaction a capture naming supersedes
  // holds ONE advisory lock — the fingerprint's. At 033 it held two.
  let heldNaming = -1;
  await db.transaction(async (tx) => {
    await tx.query(`SELECT upsert_thought($1, $2::jsonb, $3::vector)`, ["035 a capture naming a pointer, held", JSON.stringify({ metadata: {}, supersedes: c.id }), unit(5)]);
    heldNaming = (await tx.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].c;
    await tx.rollback();
  });
  assert(heldNaming === 1, `a capture naming supersedes holds one advisory lock while its transaction is open — the fingerprint's, not the supersession lock (${heldNaming})`);
  assert(Number((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].c) === 0, "…and none once it ends");

  // The COMMENTs say so: the 3-argument form's states the rule and the
  // return; review_supersession_proposal's (032's, re-issued) no longer
  // carries the add-if-empty aside.
  const cThree = await commentOf(THREE), cReview = await commentOf(REVIEW);
  assert(/provenance is NOT written \(035\)/.test(cThree) && /existed/.test(cThree) && /no supersession lock \(035\)/.test(cThree), "the 3-argument COMMENT states the rule and the return");
  assert(!/add-if-empty/.test(cReview) && /since 035 a re-capture does not touch it/.test(cReview) && /Migration 029 \/ 032 \/ 035/.test(cReview), "…and review_supersession_proposal's COMMENT no longer carries 032's add-if-empty aside");

  // The trap: 033 re-applied by hand puts the fill and the supersession lock
  // back (its file defines both forms and update_thought) — 035's sentinel is
  // what says so; 035 re-applied restores.
  await reapply("033");
  const three033 = await srcOf(THREE);
  assert(!/ob1:re-capture-writes-no-provenance/.test(three033) && /supersession-review/.test(three033) && /COALESCE\(thoughts\.supersedes/.test(three033) && /ob1:capture-takes-fingerprint-lock/.test(three033), "033 re-applied over 035 puts the fill and the supersession lock back, the lock sentinel kept");
  const filled = await cap("035 residue: the earlier note", { metadata: {}, supersedes: x.id }, unit(3));
  assert(filled.existed === undefined && (await prov(r.id)).s === x.id && (await twoRowLoops()) === 1, "…and under it the same re-capture writes the loop and says nothing (no existed) — one row from the header's query");
  assert((await edit(r.id, { supersedes: null })).ok === true && (await twoRowLoops()) === 0, "…which the envelope clears (the header's remedy for a loop written before 035)");
  assert(!/add-if-empty/.test(await commentOf(REVIEW)), "(033 re-applied leaves review_supersession_proposal's COMMENT as 035 issued it — only 032's own file puts the aside back, as [33]'s trap did before 035 followed)");
  await restoreShipped("upsert_thought");
  const restored = await srcOf(THREE);
  assert(/ob1:re-capture-writes-no-provenance/.test(restored) && !/supersession-review/.test(restored) && !/COALESCE\(thoughts\.supersedes/.test(restored) && (await functionsNamed("upsert_thought")) === 3 && lastDefinerOf("update_thought").startsWith("033"),
    "035 re-applied: the fill and the lock gone again, three overloads, update_thought still 033's");
  assert(!/add-if-empty/.test(await commentOf(REVIEW)), "…and review_supersession_proposal's COMMENT re-issued without the aside");
  await db.exec(`DELETE FROM thoughts`);
}

console.log("\n[36] Migration 036: delete_thought and review_supersession_proposal both take the supersession lock before their contended row (SMD-1462)");
{
  // Self-contained: restore both bodies 036 last-defines rather than trusting
  // that an earlier block's reapply/restore left them shipped ([33] reapplies
  // 032, which defines review). A block inserted before this one that reapplied
  // 032/029/009 without restoring would otherwise silently give us a stale body.
  await restoreShipped("delete_thought", "review_supersession_proposal");
  await db.exec(`DELETE FROM thoughts`);
  // 036 is the only redefinition of delete_thought since 009; the body is
  // 009's plus one advisory-lock line, so a future edit that drops the lock —
  // reopening the accept-vs-delete deadlock db/test-live.ts [6g] proves — is
  // caught here, in the fast suite, without a live server.
  assert((await functionsNamed("delete_thought")) === 1 && lastDefinerOf("delete_thought").startsWith("036"),
    `one delete_thought, 036 the last definer (${lastDefinerOf("delete_thought")})`);
  const src = String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, ["delete_thought(uuid, jsonb)"])).rows[0].s);
  const iLock = src.indexOf("pg_advisory_xact_lock(hashtext('ob1:supersession-review'))");
  const iDelete = src.indexOf("DELETE FROM thoughts WHERE id = p_id");
  assert(iLock > 0 && iDelete > 0 && iLock < iDelete,
    `the supersession lock — the key review_supersession_proposal and update_thought take — is acquired before the DELETE (${iLock} < ${iDelete})`);
  assert((src.match(/pg_advisory_xact_lock/g) ?? []).length === 1, "…exactly one advisory lock: the supersession one, not the fingerprint one a delete has no fingerprint for");
  // 009's body, carried forward: 008's actor, the RETURNING that tells a
  // missing row from a deletion, and the NOT_FOUND that reports it.
  assert(/set_config\('ob1\.actor'/.test(src) && /DELETE FROM thoughts WHERE id = p_id RETURNING id INTO v_deleted/.test(src) && /'NOT_FOUND'/.test(src),
    "…and 009's body is intact: the actor set for the audit trigger, the RETURNING, the NOT_FOUND branch");
  // Behaviour: the lock does not change the contract. A present row deletes
  // and returns its id; a second delete of the same id is NOT_FOUND.
  const t = String((await db.query<{ id: string }>(`SELECT upsert_thought('a thought to delete', '{"metadata":{}}'::jsonb) ->> 'id' AS id`)).rows[0].id);
  const first = (await db.query<{ r: { ok: boolean; id?: string } }>(`SELECT delete_thought($1::uuid, NULL::jsonb) AS r`, [t])).rows[0].r;
  assert(first.ok === true && first.id === t, `delete_thought removes a present row and returns its id (${JSON.stringify(first)})`);
  const gone = (await db.query(`SELECT 1 FROM thoughts WHERE id = $1`, [t])).rows.length;
  const second = (await db.query<{ r: { ok: boolean; error?: string } }>(`SELECT delete_thought($1::uuid, NULL::jsonb) AS r`, [t])).rows[0].r;
  assert(gone === 0 && second.ok === false && second.error === "NOT_FOUND", `…and the row is gone, a second delete NOT_FOUND (${JSON.stringify(second)})`);

  // review_supersession_proposal takes the same lock before the proposal row
  // now (036): the delete-side lock alone left a second cycle — a delete
  // holding the lock and waiting on the proposal through 029's cascade, a
  // review holding the proposal and waiting on the lock (db/test-live.ts [6g]
  // reproduced it 10 of 40). Only both writers taking the lock first close it.
  assert((await functionsNamed("review_supersession_proposal")) === 1 && lastDefinerOf("review_supersession_proposal").startsWith("036"),
    `one review_supersession_proposal, 036 the last definer (${lastDefinerOf("review_supersession_proposal")})`);
  const review = String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, ["review_supersession_proposal(uuid, text, text, text, jsonb, boolean)"])).rows[0].s);
  const iRLock = review.indexOf("pg_advisory_xact_lock(hashtext('ob1:supersession-review'))");
  const iProposal = review.indexOf("FROM supersession_proposals WHERE id = p_id FOR UPDATE");
  assert(iRLock > 0 && iProposal > 0 && iRLock < iProposal,
    `review takes the supersession lock before it locks the proposal row (${iRLock} < ${iProposal})`);
  assert((review.match(/pg_advisory_xact_lock/g) ?? []).length === 1, "…acquired once, at the top, for accept and reject alike");
  // 032's shape, unmoved: writes through update_thought, no UPDATE of its own,
  // no walk of its own — [32] asserts this too, over the same source.
  assert(!/UPDATE\s+thoughts\b/i.test(review) && (review.match(/update_thought\(/g) ?? []).length === 2 && !/v_walk/.test(review),
    "…and 032's shape is intact: two update_thought calls, no UPDATE and no walk of its own");
  await db.exec(`DELETE FROM thoughts`);
}

report();
