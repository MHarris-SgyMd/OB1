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
  ROUTE_ESTIMATE_MIN_PAGES,
  ROUTE_SAMPLE_PAGES,
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
  grantPresenceSql,
  grantStatements,
  grantVerifySql,
  mergedGrants,
  grantedFunctions,
  grantedObjects,
  grantedSequences,
  grantedTables,
  grantedViews,
  stripSqlComments,
  supabaseIsmsIn,
  UPDATE_THOUGHT_SIGNATURE_9,
} from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buffersOf, COLUMN_COMMENT_SQL, communitySchemaFiles, createAssert, FUNCTION_COMMENT_SQL, ISO_RE, SAMPLE_STATEMENT, sampleStatementOf, SCHEMA_FILES_FIRST, SCHEMAS_DIR, seededRandom, TABLE_COMMENT_SQL, TID_PROBE } from "./test-support.ts";
import { markerAnswers } from "./bench-oracle.ts";
import {
  DEFAULT_OPTIONS, DONE_WEIGHT, FUZZY_FLOOR, coverage as graphCoverage, lifecycleCaveat, neighbourhood, parseArgs, pgArray, rankedSubjects, render, report as graphReport,
  resolveSubject, subjectThoughts, topEntities, topThoughts, weightsSql, type Options as GraphOptions, type Runner,
} from "./graph-centrality.ts";
import { agentLabel, armOf, attribute, citePointerOf, goldFromFixture, renderReport, summarise, toActionRow, toSearchRow, type ActionRow, type SearchRow } from "../evals/utilization.ts";
import { ENTITY_TYPES, NUMERIC_NAME_RE, RELATIONS } from "../server-portable/entities.ts";
import { linearAdapter, SAMPLE_ISSUE } from "./ingest-linear.ts";
import { LINK_RELATIONS } from "./ingest-contract.ts";

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
    // this suite applies ([24] asks for a batch by passing it explicitly);
    // chunkContext pinned for the same reason — [13] asserts the default 013
    // records, and a shell's OB1_CHUNK_CONTEXT must not be what it recorded.
    migrationValues({ dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, trgm, chunkContext: DEFAULT_CHUNK_CONTEXT, backfillLimit: null })
  );
}

const { assert, total, docCheck, report } = createAssert();

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
/** Every function a migration file defines, by the same reading lastDefinerOf makes. */
function definedIn(file: string): string[] {
  return [...readFileSync(join(MIGRATIONS, file), "utf8").matchAll(/^\s*CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?(\w+)\(/gm)].map((m) => m[1]);
}
/**
 * Re-apply the last definer of each named function. A file re-applied for one
 * function redefines EVERY function it holds, and some of those a later file
 * last defines — 046 holds the audit trigger and the refusal trigger with
 * 046's bodies while 055 is their last definer (SMD-2115) — so the closure is
 * taken: for each file re-applied, the last definer of each function it
 * defines is re-applied too, until nothing new joins, in file order. Before
 * SMD-2115 every restore of upsert_thought or update_thought put 046's audit
 * trigger back over 055's silently, and the sections after ran against a body
 * the suite did not know it had.
 */
async function restoreShipped(...fns: string[]): Promise<string[]> {
  const latest = new Set(fns.map(lastDefinerOf));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of [...latest]) for (const g of definedIn(f)) { const d = lastDefinerOf(g); if (!latest.has(d)) { latest.add(d); grew = true; } }
  }
  const files = [...latest].sort();
  for (const f of files) await db.exec(subst(readFileSync(join(MIGRATIONS, f), "utf8")));
  return files;
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
    new RegExp(`\\(\\(embedding\\)::halfvec\\(${EMBEDDING_DIM}\\)\\) halfvec_cosine_ops`).test(byName["thoughts_embedding_idx"] ?? ""),
    "…over (embedding)::halfvec(D) with halfvec_cosine_ops — 039's expression, the <=> the RPC's walk orders by ([38] holds the pair)"
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

  const none = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"z"}'::jsonb)`, [unit(0)]);
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
  const oddFiltered = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, '{"kind":"a"}'::jsonb)`, [unit(0)]);
  assert(oddFiltered.rows[0].c === 10, `…and a filter simply does not match them, without error (got ${oddFiltered.rows[0].c} of the 58 remaining kind "a")`);

  // 007 evaluated `NULL = '{}' OR metadata @> NULL` → NULL → every row excluded.
  const nul = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, NULL::jsonb)`, [unit(0)]);
  assert(nul.rows[0].c === 10, `a NULL filter is unfiltered (got ${nul.rows[0].c} rows, 007 gave 0)`);

  // The overfetch is honoured above the default: 62 rows stored, 50 asked, 50 back.
  // Under 007 each CTE stopped at hnsw.ef_search (40) candidates.
  const big = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 50, '{}'::jsonb)`, [unit(0)]);
  assert(big.rows[0].c === 50, `match_count 50 returns 50 of 62 rows (got ${big.rows[0].c})`);

  // The clamp's edges, named in the header: 0 and negative give 1 row, NULL
  // gives the default 10. 007 gave 0, an error, and the whole candidate set.
  for (const [arg, want, label] of [["0", 1, "match_count 0 returns 1 row"], ["-5", 1, "a negative match_count returns 1 row, not an error"], ["NULL", 10, "a NULL match_count returns the default 10"]] as const) {
    const r = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, ${arg}, '{}'::jsonb)`, [unit(0)]);
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

// ── 8e. Migrations 037 and 038 — a sample of the heap before the routing count
//
// Every filtered call opened with the capped GIN collection, whose cost is the
// number of matching rows — 240 ms at 50% of ten million (SMD-1018). 037 reads
// eight random pages first, on a heap of ROUTE_ESTIMATE_MIN_PAGES pages or
// more, and skips the collection when the sample puts the filter at ten times
// the exact threshold on at least eight hits over at least three pages; 038
// draws those eight pages by TID range — one block per probe, eight page reads
// whatever the heap holds, where 037's TABLESAMPLE SYSTEM decided page by page
// over the whole heap — and counts the pages it drew, empty ones included.
// PGlite holds the shape and what a small table can show: under the floor
// nothing runs but 014's collection; with the floor lowered to zero the gate
// runs on every filtered call, cannot skip — condition 1 needs a table past
// ten times the threshold — and the answers are still exact. The skip itself
// is db/test-live.ts [5d]'s, on a real server with rows enough to reach it.

console.log("\n[8e] Migrations 037 and 038: the routing count is gated by a sample of the heap, drawn by TID range — the shape, the floor, and exactness with the gate reached");
{
  const shipped = async () => String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = '${MATCH_THOUGHTS_SIGNATURE}'::regprocedure`)).rows[0].s);
  const src = await shipped();
  assert(lastDefinerOf("match_thoughts").startsWith("041"), `041 is the last definer of match_thoughts — 039's body, run with jit off (040) and its two planner paths pinned (041), carrying 038's gate (${lastDefinerOf("match_thoughts")})`);
  assert(TID_PROBE.test(src) && /INTO v_hits, v_hit_pages, v_pages_seen/.test(src) && !/TABLESAMPLE/.test(src),
    "the shipped body samples the heap by TID range — every tuple of one block, half-open at the next — into the three counts the gate reads, and carries no TABLESAMPLE");
  assert(new RegExp(`floor\\(random\\(\\) \\* v_pages\\)::bigint AS blk\\s+FROM generate_series\\(1, ${ROUTE_SAMPLE_PAGES}\\)`).test(src) && new RegExp(`IF v_pages >= ${ROUTE_ESTIMATE_MIN_PAGES} THEN`).test(src),
    `…with config.mjs's constants substituted: ${ROUTE_SAMPLE_PAGES} blocks drawn from the heap's page count, no sample under ${ROUTE_ESTIMATE_MIN_PAGES} heap pages`);
  assert(/v_hits >= 8\s+AND v_hit_pages >= 3\s+AND v_hits \* v_pages >= 10 \* v_exact \* v_pages_seen/.test(src),
    "…and the three conditions as the header states them: eight hits, on three pages, at ten times the threshold");
  assert(/IF NOT v_broad THEN\s+SELECT array_agg\(s\.id\) INTO v_ids/.test(src) && /IF NOT v_broad AND COALESCE\(cardinality\(v_ids\), 0\) <= v_exact THEN/.test(src),
    "…the collection runs only when the gate did not decide, and the exact branch only when the collection ran");
  // The statement itself, not the source around it: the body's comments
  // mention EXISTS and the sample in the same breath (review pass 1). Read
  // once here — the three counts and the FROM clause — for the token checks
  // now and the draws further down.
  const stmt = SAMPLE_STATEMENT.exec(src);
  const sampleStmt = stmt?.[2] ?? "";
  assert(/embedding IS NOT NULL\) AS hit/.test(sampleStmt) && !/EXISTS/.test(sampleStmt) && !/thought_chunks/.test(sampleStmt),
    "the sample counts rows with a vector and probes no chunk table (the EXISTS became a hashed subplan there — 037's header says)");
  // 038's three load-bearing tokens (its header, Design): DISTINCT blocks so a
  // block drawn twice is read and counted once; a LEFT join so a page with no
  // live row still counts among the pages drawn (037 counted only pages that
  // returned a row, which biased the estimate up on a bloated heap); and the
  // probe's LIMIT at the 8 KB page's tuple ceiling, which never cuts a page
  // and keeps the probe a subquery — pulled up into the join, the ctid
  // bounds are join quals no TID Range path reads, and the plan is a
  // sequential scan of the heap.
  assert(/^FROM \(\s*SELECT DISTINCT floor/.test(sampleStmt) && /\) b\s+LEFT JOIN LATERAL \(/.test(sampleStmt) && /LIMIT 291\s+\) p ON true$/.test(sampleStmt),
    "…the blocks are DISTINCT, the join is LEFT, and the probe carries LIMIT 291 — MaxHeapTuplesPerPage on an 8 KB page");

  // 1,000 random rows, 990 of one kind and 10 of another: both filters are
  // under the exact threshold, so both answers must be the exact top-10.
  // Emptied AND vacuumed: the sections before leave their dead rows behind,
  // and without the VACUUM this fixture sat on the tail of a 55-page heap whose
  // first 38 pages were already empty — the "emptied band" below was then
  // mostly pre-empty and the probe passed on an incidental layout (review
  // pass 2). Compacted, 1,000 rows are some sixteen pages, every one live.
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`VACUUM thoughts`);
  const { unitVector } = seededRandom(1463);
  for (let i = 0; i < 1000; i += 100) {
    const values = Array.from({ length: 100 }, (_, k) => `('gate ${i + k}', '{"kind":"${(i + k) % 100 === 0 ? "thin" : "broad"}"}'::jsonb, '[${unitVector(EMBEDDING_DIM).join(",")}]'::vector)`).join(",");
    await db.exec(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  const exactTop = async (qv: string, filter: string) => {
    await db.exec(`SET enable_indexscan = off`);
    await db.exec(`SET enable_bitmapscan = off`);
    try {
      return (await db.query<{ id: string }>(`SELECT id FROM thoughts WHERE metadata @> '${filter}' ORDER BY embedding <=> $1::vector, id LIMIT 10`, [qv])).rows.map((x) => x.id);
    } finally {
      await db.exec(`RESET enable_indexscan`);
      await db.exec(`RESET enable_bitmapscan`);
    }
  };
  const agree = async (label: string) => {
    let ok = 0;
    for (let q = 0; q < 3; q++) {
      const qv = `[${unitVector(EMBEDDING_DIM).join(",")}]`;
      for (const f of ['{"kind":"broad"}', '{"kind":"thin"}']) {
        const want = await exactTop(qv, f);
        const got = (await db.query<{ id: string }>(`SELECT id FROM match_thoughts($1::vector, -1.0, 10, '${f}'::jsonb)`, [qv])).rows.map((x) => x.id);
        if (got.length === want.length && got.every((id) => want.includes(id))) ok++;
      }
    }
    assert(ok === 6, `${label}: the 990-row and the 10-row filter — both under the threshold — return the exact top-10 on 3 random queries (${ok}/6 agree)`);
  };
  // Under the shipped floor: this heap is a few dozen pages, and the sample never runs.
  const [{ pages }] = (await db.query<{ pages: number }>(`SELECT (pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int)::int AS pages`)).rows;
  assert(pages > 0 && pages < ROUTE_ESTIMATE_MIN_PAGES, `the fixture's heap is ${pages} pages, under the floor of ${ROUTE_ESTIMATE_MIN_PAGES}: the sample does not run and the call is 020's`);
  await agree("under the floor");
  // The floor lowered to zero: the gate runs on every filtered call. It cannot
  // skip — condition 1 needs the table at ten times the threshold, and 1,000
  // rows are not — so the collection still runs and the answers hold.
  const definer = lastDefinerOf("match_thoughts");
  await db.exec(substituteMigration(readFileSync(join(MIGRATIONS, definer), "utf8"), migrationValues({ dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, trgm: DEFAULT_TRGM_INDEX, backfillLimit: null, routeEstimateMinPages: 0 })));
  assert(/IF v_pages >= 0 THEN/.test(await shipped()), `${definer.slice(0, 3)} applied with SchemaOptions.routeEstimateMinPages = 0: the sample runs on any heap`);
  await agree("with the gate reached");
  // The gate's own input on this table, run as the body runs it: the sample
  // statement is read out of the installed body (pg_proc.prosrc) with the two
  // things plpgsql would supply — the page count and the filter — substituted
  // as literals, so what runs here is the deployed text and not a copy kept in
  // this file: a copy passed every drop-the-mechanism mutant (INNER join, no
  // LIMIT, a constant block) and left the tokens to the regexes above (review
  // pass 1). A body the regex cannot read fails the one assertion and skips
  // the rest, rather than throwing the suite away from [9] on (review pass 2).
  assert(stmt !== null, "the sample statement reads out of the installed body (SELECT <three counts> INTO v_hits, v_hit_pages, v_pages_seen FROM (<the draw>) b LEFT JOIN LATERAL (<the probe>) p ON true)");
  if (stmt) {
    type Draw = { hits: number; hit_pages: number; pages_seen: number };
    /**
     * The body's sample with its locals substituted. `drawn` pins the blocks in
     * place of the random draw — only `floor(random() * N) … FROM
     * generate_series(1, N)` is replaced, so the body's DISTINCT, its join and
     * its probe are what run; null (with a failed assertion) when the body's
     * draw is not that shape.
     */
    const deployedSample = (filter: string, pageCount: number, drawn?: number[]): string | null => {
      let text = sampleStatementOf(src, pageCount, filter)!;
      if (drawn) {
        const pinned = text.replace(/floor\(random\(\) \* \d+\)::bigint AS blk\s+FROM generate_series\(1, \d+\)/, () => `unnest(ARRAY[${drawn.join(",")}])::bigint AS blk`);
        if (pinned === text) {
          assert(false, "the body draws its blocks as `floor(random() * v_pages)::bigint AS blk FROM generate_series(1, N)`, so a test can pin them");
          return null;
        }
        text = pinned;
      }
      return text;
    };
    const runText = async (text: string | null): Promise<Draw | null> =>
      text === null ? null : (await db.query<Draw>(`SELECT x.c1::int AS hits, x.c2::int AS hit_pages, x.c3::int AS pages_seen FROM (${text}) x(c1, c2, c3)`)).rows[0];
    const drawOnce = (filter: string, pageCount: number, drawn?: number[]) => runText(deployedSample(filter, pageCount, drawn));
    // The body's three conditions at the default count (v_exact = GREATEST(v_base * 4, 1000) = 1,000).
    const skips = (r: Draw, pageCount: number) => r.hits >= 8 && r.hit_pages >= 3 && r.hits * pageCount >= 10 * 1000 * r.pages_seen;
    // A draw is sound when it reached between two and ROUTE_SAMPLE_PAGES distinct
    // pages: eight draws over P pages land on ONE page with probability P^-7
    // (under 1e-8 at sixteen pages), and a draw that read one block eight times
    // would report one. (A draw without DISTINCT is the same-block probe's to
    // catch below: its page count stays a DISTINCT count, its hits come back
    // eightfold.) 037's TABLESAMPLE drew no page at all on one run.
    const sound = (r: Draw) => r.pages_seen >= 2 && r.pages_seen <= ROUTE_SAMPLE_PAGES;
    const BROAD = '{"kind":"broad"}';
    // Five draws, each judged by the body's own three conditions: the rule
    // must say "collect" whatever it drew — on 1,000 rows the scaled estimate
    // can never reach ten times the threshold (second review pass of 037).
    const draws: string[] = [];
    let wouldSkip = 0;
    let soundDraws = 0;
    for (let i = 0; i < 5; i++) {
      const r = (await drawOnce(BROAD, pages))!;
      draws.push(`${r.hits}/${r.hit_pages}/${r.pages_seen}`);
      if (skips(r, pages)) wouldSkip++;
      if (sound(r)) soundDraws++;
    }
    assert(wouldSkip === 0 && soundDraws === 5,
      `five draws of the body's own sample on 1,000 rows (hits/hit pages/pages drawn: ${draws.join(", ")}) — none meets the three conditions on ${pages} pages, so the gate cannot skip here, and every draw reached 2 to ${ROUTE_SAMPLE_PAGES} distinct pages`);
    // The plan the statement gets: TID Range Scans of the heap and no scan of
    // it. Without the probe's LIMIT the planner pulls the probe up into the
    // join, the ctid bounds become join quals no TID Range path reads, and the
    // plan is a sequential scan of thoughts under Materialize (038's header) —
    // a property of the plan, which the text assertion above cannot hold.
    const plan = (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${deployedSample(BROAD, pages)}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert(/Tid Range Scan on thoughts/.test(plan) && !/Seq Scan on thoughts/.test(plan) && !/Materialize/.test(plan),
      `the body's sample plans as TID Range Scans of thoughts — no sequential scan, no Materialize (${plan.split("\n").filter((l) => /Scan|Materialize/.test(l)).map((l) => l.trim().replace(/\s+\(cost.*$/, "")).join("; ")})`);
    // DISTINCT: the same block drawn eight times is read and counted once. The
    // last block holds the tail of the load; its broad rows counted by ctid,
    // then the body's sample pinned to eight copies of it — one page drawn,
    // that many hits. Without DISTINCT the probe runs eight times and the
    // hits come back eightfold.
    const last = pages - 1;
    const [{ on_last }] = (await db.query<{ on_last: number }>(
      `SELECT count(*)::int AS on_last FROM thoughts WHERE ctid >= ('(' || ${last} || ',0)')::tid AND ctid < ('(' || ${last + 1} || ',0)')::tid AND metadata @> '${BROAD}' AND embedding IS NOT NULL`)).rows;
    const same = await drawOnce(BROAD, pages, Array.from({ length: ROUTE_SAMPLE_PAGES }, () => last));
    assert(on_last > 0 && same !== null && same.pages_seen === 1 && same.hits === on_last && same.hit_pages === 1,
      `block ${last} drawn ${ROUTE_SAMPLE_PAGES} times over: one page drawn, its ${on_last} broad rows counted once (drew ${same?.pages_seen} pages, ${same?.hits} hits on ${same?.hit_pages}) — the DISTINCT`);
    // The pages drawn are counted whether or not they hold a row — the LEFT
    // join. An eight-block band starting a quarter of the way in, with live
    // rows beyond it so a plain VACUUM cannot truncate it away, is emptied
    // (its rows deleted, then vacuumed: dead tuples gone, the pages kept), and
    // the body's probe pinned to those eight blocks draws eight pages and
    // answers nothing; an INNER join — 037's count of the pages that RETURNED
    // a row — reports none drawn. The same probe under EXPLAIN (ANALYZE,
    // BUFFERS) touches exactly eight buffers: one page per block and no more,
    // which a bound of `<= '(b+1,0)'` would double (it reads into the next
    // block) — the cost the whole change exists to bound.
    const lo = Math.floor(pages / 4);
    const hi = lo + ROUTE_SAMPLE_PAGES;
    const [{ beyond, inside }] = (await db.query<{ beyond: number; inside: number }>(
      `SELECT count(*) FILTER (WHERE ctid >= ('(' || ${hi} || ',0)')::tid)::int AS beyond,
              count(*) FILTER (WHERE ctid >= ('(' || ${lo} || ',0)')::tid AND ctid < ('(' || ${hi} || ',0)')::tid)::int AS inside
       FROM thoughts`)).rows;
    assert(inside > 0 && beyond > 0, `the band [${lo}, ${hi}) holds ${inside} live rows and ${beyond} live rows lie beyond it, so emptying it leaves the heap its size (the fixture's ${pages} pages need to be at least ${ROUTE_SAMPLE_PAGES + 3} with the last one live — a narrower EMBEDDING_DIM packs more rows a page)`);
    const deleted = (await db.query(`DELETE FROM thoughts WHERE ctid >= ('(' || ${lo} || ',0)')::tid AND ctid < ('(' || ${hi} || ',0)')::tid`)).affectedRows ?? -1;
    await db.exec(`VACUUM thoughts`);
    const [{ live_pages, heap_pages }] = (await db.query<{ live_pages: number; heap_pages: number }>(
      `SELECT count(DISTINCT (ctid::text::point)[0])::int AS live_pages, (pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int)::int AS heap_pages FROM thoughts`)).rows;
    assert(deleted === inside && heap_pages === pages && live_pages <= pages - ROUTE_SAMPLE_PAGES,
      `the band's ${deleted} rows deleted and the heap vacuumed: still ${heap_pages} pages, ${live_pages} of them with a live row`);
    const empties = Array.from({ length: ROUTE_SAMPLE_PAGES }, (_, i) => lo + i);
    const pinnedText = deployedSample(BROAD, pages, empties);
    const pinned = await runText(pinnedText);
    assert(pinned !== null && pinned.hits === 0 && pinned.hit_pages === 0 && pinned.pages_seen === ROUTE_SAMPLE_PAGES,
      `the body's probe pinned to the ${ROUTE_SAMPLE_PAGES} emptied blocks [${lo}, ${hi}) draws ${pinned?.pages_seen} pages and answers ${pinned?.hits} hits on ${pinned?.hit_pages} — the pages drawn are counted, not the pages that answered`);
    // The scan node's own Buffers line (its total across the eight loops), not
    // the top node's: the top node's is cumulative over the whole tree, and
    // the DISTINCT draw's subtree reads catalog buffers when the syscache is
    // cold (measured: 5 at the top on a first run, 2 at the scan) — the count
    // would then hold only because the same statement ran just before
    // (review pass 3). buffersOf reads one node's line when given the node.
    const buffers = pinnedText === null ? "" : (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${pinnedText}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    const touched = buffersOf(buffers, /Tid Range Scan on thoughts/);
    assert(touched === ROUTE_SAMPLE_PAGES,
      `…and the probe touches ${touched} buffers doing it — one page per block, ${ROUTE_SAMPLE_PAGES} in all, on the Tid Range Scan's own line`);
    // And the random draw over the heap with its band emptied: it still
    // reaches its pages and the rule still says "collect".
    const sparse: string[] = [];
    let stillSound = 0;
    for (let i = 0; i < 5; i++) {
      const r = (await drawOnce(BROAD, pages))!;
      sparse.push(`${r.hits}/${r.hit_pages}/${r.pages_seen}`);
      if (sound(r) && !skips(r, pages)) stillSound++;
    }
    assert(stillSound === 5,
      `on the heap with ${ROUTE_SAMPLE_PAGES} of ${pages} pages emptied every random draw still reaches 2 to ${ROUTE_SAMPLE_PAGES} pages and the rule still says "collect" (hits/hit pages/pages drawn: ${sparse.join(", ")})`);
  }
  const restored = await restoreShipped("match_thoughts");
  assert(restored.length === 1 && restored[0].startsWith("041") && new RegExp(`IF v_pages >= ${ROUTE_ESTIMATE_MIN_PAGES} THEN`).test(await shipped()),
    "…and the shipped floor is back for the sections after");
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
   * one. The strip is config.mjs's stripSqlComments, literal-aware since
   * SMD-1796 (what SMD-1316 asked for): a `--` inside a string literal no
   * longer hides the rest of its line, and a dollar-quoted body is scanned
   * within, its own comments stripped. The rules are SUPABASE_SQL_RULES — the
   * list check-fork-consistency holds every .sql under schemas/ and db/ to —
   * so the migrations and the community schemas answer to one spelling, and
   * [40] runs the same scan over schemas/ from inside this suite.
   */
  const hits = files.flatMap((f) => supabaseIsmsIn(subst(readFileSync(join(MIGRATIONS, f), "utf8"))).map((h) => `${f}:${h.line} ${h.rule}`));
  assert(hits.length === 0, `no migration runs a Supabase-ism — no auth.uid()/auth.role() (GoTrue), no service_role/authenticated/anon (Supabase's roles), no RLS (it never fired anyway) (${hits.join("; ") || "none"})`);
  const all = files.map((f) => stripSqlComments(subst(readFileSync(join(MIGRATIONS, f), "utf8")))).join("\n");
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
  // The index too, not only the table: PGlite never vacuums, so by now the
  // HNSW index holds every row the sections before deleted — thousands of
  // dead elements the walk still traverses — around the three live rows below.
  // Once, in CI under 039's half-precision index, the default path returned
  // the two rows behind the exact match and not the exact match at cosine 1.0,
  // on a run that passed locally every time. The likeliest cause is that
  // graph: whether a walk through the dead elements reaches every live row
  // depends on how they link it, which turns on the level each insert drew at
  // random — inferred from the symptom, not shown: a local probe with 2,500
  // dead elements over four seeds returned all three rows each time. Either
  // way the vector arm is measured here over the rows it is given, so the
  // index holds only them.
  await db.exec(`VACUUM thoughts`);
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
  // Exactly five clauses — 014's scan mode, 019's plan setting, 040's jit
  // off, 041's two pinned paths — and no walk bound or plan mode (019's
  // rule). A successor that adds or drops one fails here on purpose.
  assert(Object.keys(mt.settings).sort().join(",") === "enable_nestloop,enable_seqscan,enable_tidscan,hnsw.iterative_scan,jit" && mt.settings["enable_seqscan"] === "off" && mt.settings["hnsw.iterative_scan"] === "relaxed_order" && mt.settings["jit"] === "off" && mt.settings["enable_nestloop"] === "on" && mt.settings["enable_tidscan"] === "on",
         `match_thoughts carries exactly the scan mode, the plan setting, jit off and the two pinned paths (${JSON.stringify(mt.settings)})`);
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

  // The candidate scan is 014's, byte for byte, through 019, 020, 037 and
  // 038: the three RETURN QUERY blocks' CTEs (direct, chunked, best) and the
  // routing statement. 020 changed each branch's final SELECT and nothing
  // above it; 037 wrapped the routing statement in the gate's IF (so it is
  // indented two more spaces — compared with whitespace collapsed) and
  // changed nothing in it; 038 changed the gate's sample and nothing in the
  // collection; this holds "carried verbatim" for the part that decides the
  // plan.
  // Re-applying 014 gives 014's text to compare against — as a SECOND
  // function, since 014's signature is the 4-argument one 020 dropped.
  const cteBlocks = (src: string) => [...src.matchAll(/WITH direct AS \([\s\S]*?GROUP BY u\.tid\s*\)/g)].map((m) => m[0]);
  const routing = (src: string) => (/SELECT array_agg\(s\.id\) INTO v_ids[\s\S]*?\) s;/.exec(src)?.[0] ?? "").replace(/\s+/g, " ");
  await reapply("014");
  assert((await functionsNamed("match_thoughts")) === 2, "re-applying 014 puts the 4-argument function back BESIDE 020's — the overload 020's header names");
  const mt014 = await proc(MT_4);
  // 039 casts the two walk branches' ORDER BYs to halfvec on both sides — the
  // expression its indexes are built over — and touches nothing else in the
  // CTEs: with that cast taken out they are 014's, and the exact branch's
  // carry none ([38] pairs the cast with the index's plan).
  const CAST = `embedding::halfvec(${EMBEDDING_DIM}) <=> query_embedding::halfvec(${EMBEDDING_DIM})`;
  const casts = (src: string) => src.split(CAST).length - 1;
  const uncast = (src: string) => src.split(CAST).join("embedding <=> query_embedding");
  const blocks = cteBlocks(mt.prosrc);
  assert(blocks.length === 3 && casts(blocks[0]) === 2 && casts(blocks[1]) === 0 && casts(blocks[2]) === 2 && casts(mt.prosrc) === 4,
         "039's cast is on both sides of each walk branch's two ORDER BYs — the unfiltered and the broad-filter CTEs, thoughts and chunks — and nowhere in the exact branch");
  assert(cteBlocks(uncast(mt.prosrc)).join("\n---\n") === cteBlocks(mt014.prosrc).join("\n---\n"),
         "with 039's cast taken out, the three candidate CTEs of the shipped body are 014's, byte for byte");
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
  // 041's body is 039's byte for byte — 040's clause and 041's two are the
  // whole change — and 039's file re-applied alone (its index swap is
  // idempotent; its CREATE carries 019's clauses and neither 040's nor 041's)
  // drops all three, 040's alone drops 041's two: each is what a hand
  // re-apply leaves and preflight's candidate scan reports (test-upgrade [18]
  // and [19] hold the same across an upgrade; this is the fast loop's copy).
  await reapply("039");
  const mt039 = await proc(MT);
  assert(mt039.prosrc === mt.prosrc, "041's body is 039's byte for byte — 040's clause and 041's two are the whole change");
  assert(!("jit" in mt039.settings) && !("enable_nestloop" in mt039.settings) && !("enable_tidscan" in mt039.settings) && mt039.settings["enable_seqscan"] === "off",
         `…and 039 re-applied alone carries 019's clauses without 040's or 041's, the state a hand re-apply leaves (proconfig ${JSON.stringify(mt039.settings)})`);
  await reapply("040");
  const mt040 = await proc(MT);
  assert(mt040.prosrc === mt.prosrc && mt040.settings["jit"] === "off" && !("enable_nestloop" in mt040.settings) && !("enable_tidscan" in mt040.settings),
         `…and 040 re-applied alone carries jit = off without 041's two pins, the state that hand re-apply leaves (proconfig ${JSON.stringify(mt040.settings)})`);
  await reapply("012");
  const kw012 = await proc(KW);
  assert(kw012.prosrc === kw.prosrc, "019's search_thoughts_keyword body is 012's, byte for byte");
  assert(Number(kw012.prorows) === 1000, `…and re-applying 012 alone resets its estimate to 1,000 (prorows ${kw012.prorows})`);
  const restored = await restoreShipped("match_thoughts", "search_thoughts_keyword");
  const back = await proc(MT);
  assert(Number(back.prorows) === 10 && back.settings["enable_seqscan"] === "off" && back.settings["jit"] === "off" && back.settings["enable_nestloop"] === "on" && back.settings["enable_tidscan"] === "on" && Number((await proc(KW)).prorows) === 25,
         `re-applying the migrations that last define each (${restored.join(", ")}) restores both — the shipped state, for whatever runs after`);
  assert((await functionsNamed("match_thoughts")) === 1 && (await functionsNamed("search_thoughts_keyword")) === 1, "…and 020's DROP removed the 4-argument function again: one match_thoughts, one search_thoughts_keyword");
  // Deliberately pinned, as [20] pinned 019 before 020 landed, 020 before
  // 037, 037 before 038, 038 before 039, 039 before 040 and 040 before 041:
  // 019 last defines the keyword function, 041 match_thoughts. A successor that redefines
  // either fails here on purpose, and the expectations move with the clauses
  // it must carry.
  assert(restored.length === 2 && restored[0].startsWith("019") && restored[1].startsWith("041"),
         `019 is the last definer of search_thoughts_keyword and 041 of match_thoughts (${restored.join(", ")})`);

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
  // The shipped body: 020's clauses as 019 handed them over, 040's jit off
  // and 041's two pinned paths beside them — five settings and no other ([20]
  // pins the same set).
  assert(Number(proc.prorows) === 10 && settings["enable_seqscan"] === "off" && settings["hnsw.iterative_scan"] === "relaxed_order" && settings["jit"] === "off" && settings["enable_nestloop"] === "on" && settings["enable_tidscan"] === "on" && Object.keys(settings).length === 5 && /ob1:filter-inside-scan/.test(proc.prosrc),
         "the shipped body carries what 019 handed 020: ROWS 10, its two settings and the sentinel — 040's jit = off and 041's enable_nestloop = on and enable_tidscan = on, exactly five settings");
  const cols = (await db.query<{ n: string }>(
    `SELECT a.attname AS n FROM pg_proc p, unnest(p.proallargtypes, p.proargmodes, p.proargnames) WITH ORDINALITY AS a(t, m, attname, o)
     WHERE p.oid = $1::regprocedure AND a.m = 't' ORDER BY a.o`, [MT])).rows.map((r) => r.n);
  assert(cols.join(",") === "id,content,metadata,similarity,created_at,score", `the return shape is 019's five columns plus score (${cols.join(",")})`);

  // ── The fixture: 200 thoughts at known similarities, all old, plus the
  // special rows below. Row i sits at cosine 0.95 - 0.003 i to the query
  // unit(0) — a second axis carries the rest of the unit length — so the
  // ranking by similarity is known exactly, and the candidate window's edge
  // (40 at count 10 without a weight, 160 with one) falls between rows. The
  // rest of each row's unit length points in a random direction within axes
  // 1–32 — a subspace the rows share, so their pairwise distances vary and
  // the HNSW graph over them is connected. The first draft put it on one axis
  // per row: every row nearly equidistant from every other, a graph the walk
  // reached 34 of 200 rows of under either index — and this section passed,
  // because the two functions it compared walked the same graph. 039 showed
  // it up (its comparison function had no index), and the guard below holds
  // the fixture connected.
  await db.exec(`DELETE FROM thoughts`);
  const Q = unit(0);
  const { rnd: rnd21 } = seededRandom(2021);
  const at = (cos: number) => {
    const r = Array.from({ length: 32 }, () => rnd21() - 0.5);
    const n = Math.hypot(...r);
    const s = Math.sqrt(1 - cos * cos);
    const v = new Array(EMBEDDING_DIM).fill(0);
    for (let k = 0; k < 32; k++) v[1 + k] = (r[k] / n) * s;
    v[0] = cos;
    return `[${v.join(",")}]`;
  };
  for (let i = 0; i < 200; i += 50) {
    const values = Array.from({ length: 50 }, (_, k) => {
      const n = i + k;
      return `('row ${n}', '{"kind":"${n % 3 === 0 ? "a" : "b"}"}'::jsonb, '${at(0.95 - 0.003 * n)}'::vector, now() - interval '400 days' - (${n} || ' hours')::interval)`;
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
    [at(0.10)])).rows[0].id;
  await db.query(`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES ($1::uuid, 0, 'the near chunk', $2::vector)`, [chunkOnly, at(0.99)]);
  // The recent row: 61st by similarity — outside the 40-candidate window an
  // unweighted default call has, inside the 160 a weighted one has.
  const recent = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, metadata, embedding, created_at) VALUES ('recent', '{"kind":"b"}'::jsonb, $1::vector, now()) RETURNING id`,
    [at(0.95 - 0.003 * 60 + 0.001)])).rows[0].id;
  const rankOf = async (id: string) =>
    (await db.query<{ r: number }>(`SELECT (SELECT count(*)::int FROM thoughts o WHERE o.embedding <=> $1::vector < t.embedding <=> $1::vector) + 1 AS r FROM thoughts t WHERE t.id = $2::uuid`, [Q, id])).rows[0].r;
  const recentRank = await rankOf(recent);
  assert(recentRank > 40 && recentRank <= 160, `the recent row ranks ${recentRank} by similarity alone: outside the unweighted window of 40, inside the weighted one of 160`);
  const [{ walked }] = (await db.query<{ walked: number }>(`SELECT count(*)::int AS walked FROM match_thoughts($1::vector, -1.0, 500, '{}'::jsonb)`, [Q])).rows;
  const [{ total }] = (await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM thoughts`)).rows;
  assert(walked === total, `the walk reaches every row of the fixture (${walked} of ${total}): the graph over it is connected, so what follows measures the blend and not the index`);

  // ── Backward compatibility, exactly. 019's own function, installed from its
  // file under another name, answers the same calls; rows and order must match
  // and `score` must equal `similarity` on every row. Filters reach the
  // unfiltered and the exact branch here; [8c] holds the walk against an exact
  // scan on 1,200 rows, and its final SELECT is the same edit. 019's four
  // walk ORDER BYs take 039's cast — the raw column has no index since 039,
  // and the point is the blend, so both functions must walk the same index;
  // the similarity stays 019's, on the full vector, as 039's own does.
  const m019 = files.find((f) => f.startsWith("019"))!;
  const text019 = subst(readFileSync(join(MIGRATIONS, m019), "utf8"));
  assert(text019.split("FUNCTION match_thoughts(").length === 2, "019's file defines match_thoughts once, so it can be installed under another name");
  const WALK_019 = /ORDER BY (t|c)\.embedding <=> query_embedding/g;
  assert((text019.match(WALK_019) ?? []).length === 4, "019's body has four walk ORDER BYs — thoughts and chunks, unfiltered and filtered — which take 039's cast for the comparison");
  await db.exec(text019.replace(WALK_019, (_, a: string) => `ORDER BY ${a}.embedding::halfvec(${EMBEDDING_DIM}) <=> query_embedding::halfvec(${EMBEDDING_DIM})`).replace("FUNCTION match_thoughts(", "FUNCTION match_thoughts_019("));
  type Row = { id: string; similarity: number; score: number | null };
  let compared = 0;
  let same = true;
  let scoreIsSim = true;
  for (const [th, n, filter] of [[-1.0, 10, "{}"], [0.0, 50, "{}"], [0.5, 10, "{}"], [-1.0, 10, '{"kind":"a"}'], [0.3, 50, '{"kind":"b"}'], [-1.0, 500, "{}"]] as const) {
    // Three queries whose similarities are distinct over the fixture: `unit(3)`
    // would tie every row off axis 3 at 0, and 020 breaks ties by id where
    // 019 left them to the plan — a difference in the tiebreak, not the ranking,
    // and one [21] asserts separately below.
    for (const q of [Q, at(0.5), at(0.3)]) {
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
  const fourArg = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [Q]);
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
  const A = (await db.query<{ id: string }>(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('A: older, closer', $1::vector, now() - interval '365 days') RETURNING id`, [at(0.90)])).rows[0].id;
  const B = (await db.query<{ id: string }>(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('B: newer, farther', $1::vector, now() - interval '40 days') RETURNING id`, [at(0.80)])).rows[0].id;
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
  const nullAge = (await db.query<{ id: string }>(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('no date', $1::vector, NULL) RETURNING id`, [at(0.85)])).rows[0].id;
  const dated = (await db.query<{ id: string; similarity: number; score: number }>(`SELECT id, similarity, score FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb, 0.5, 90.0)`, [Q])).rows.find((r) => r.id === nullAge)!;
  assert(dated !== undefined && Math.abs(dated.score - dated.similarity * 0.5) < 1e-9, `a row with no created_at scores as infinitely old (${dated?.score} = ${dated?.similarity} * 0.5)`);
  // Infinite timestamps (the column accepts them): -infinity is infinitely old,
  // +infinity brand new — and at weight 0 the age is never computed, which is
  // what keeps PostgreSQL 16 (the pinned server; PGlite here is 17) from
  // raising "cannot subtract infinite timestamps" on a call 019 answered fine.
  const [past, future] = (await db.query<{ id: string }>(
    `INSERT INTO thoughts (content, embedding, created_at) VALUES ('from -infinity', $1::vector, '-infinity'), ('from +infinity', $2::vector, 'infinity') RETURNING id`,
    [at(0.84), at(0.83)])).rows.map((r) => r.id);
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
    `INSERT INTO thoughts (content, embedding) VALUES ('tie a', $1::vector), ('tie b', $1::vector), ('tie c', $1::vector) RETURNING id`, [at(0.7)])).rows.map((r) => r.id).sort();
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
  await db.query(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('N: names SMD-9450, below the threshold', $1::vector, now())`, [at(0.45)]);
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
  await db.query(`INSERT INTO thoughts (content, embedding, created_at) VALUES ('O: old embedded, names SMD-9450', $1::vector, now() - interval '3 years'), ('P: unembedded today, names SMD-9450', NULL, now())`, [at(0.9)]);
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
  assert(Number(proc?.n) === 10, `…of ten parameters since 046 (nine since 032) (${proc?.n})`);
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
  assert(lastDefinerOf("update_thought").startsWith("046") && lastDefinerOf("upsert_thought").startsWith("046") && lastDefinerOf("thoughts_write_audit").startsWith("055"),
         `046 is the last definer of update_thought (033's body — 032's, 021's, the provenance envelope, the fingerprint lock before the row — under a 10-argument signature with the write event) and of upsert_thought (035's bodies — 022's chunk rule, 021's label, 025's envelope, the fingerprint lock, provenance on a first capture only — with the event set beside the actor); 055 of the audit trigger (046's body — 025's, 010's id, the provenance diff — stamping the event and the key-derived columns) (${lastDefinerOf("update_thought")}, ${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("thoughts_write_audit")})`);

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
  assert(lastDefinerOf("upsert_thought").startsWith("046"), `046 is the last definer of upsert_thought (it carries 035's bodies — 033's, 022's rule, 025's envelope, the fingerprint lock, provenance on a first capture only — with the write event set beside the actor) (${lastDefinerOf("upsert_thought")})`);

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
  // 055 (SMD-2115): the key's move is the third addition to the event, so each
  // row keyed leaves one update row carrying that key alone — before 055 the
  // pass wrote none (008 diffed content, metadata and the vector's presence).
  assert((await audit()) === auditBefore + 3, `…and one audit row per row keyed — the key's move, which the event carries since 055 (${(await audit()) - auditBefore})`);
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
  await db.exec(`VACUUM thoughts`); // the dead elements out of the index before a three-row walk ([17b] says why)
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
  const colComment = (await db.query<{ c: string | null }>(COLUMN_COMMENT_SQL, ["thought_work_claims", "last_error"])).rows[0]?.c ?? "";
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

  const fnComment = (await db.query<{ c: string | null }>(FUNCTION_COMMENT_SQL, ["release_thought(uuid, text, text, text, text)"])).rows[0]?.c ?? "";
  // 015's comment, whole — purpose, holder rule and the three-case enumeration —
  // so a successor that keeps only the middle clause is caught.
  assert(fnComment.includes("Mark one claim succeeded or failed. Only the holder of a still-claimed row may; returns false otherwise (expired and re-leased, deleted, or never held)."),
    "release_thought's comment keeps 015's text whole (purpose, holder rule, the three cases)");
  assert(/p_error is stored in last_error whatever p_status is/.test(fnComment), "…and says p_error is stored whatever the status");
  assert(/on succeeded, when given, a caveat/.test(fnComment) && /the write stands/.test(fnComment) && /Pass NULL for a clean success/.test(fnComment),
    "…what it means on success, and what to pass for a clean one");
  // [10]'s strip has been literal-aware since SMD-1796 (SMD-1316's ask), so a
  // `--` inside one of these literals would no longer hide the rest of its
  // line from the scan; the contract is still plainer without one. Asserted
  // of the LIVE text, so it holds whichever file wrote the comment.
  assert(!/--/.test(colComment) && !/--/.test(fnComment), "neither comment carries `--` — the comment-stripping scan does not need to be literal-aware for these two, though it is");
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
  // `!`: the assert on the next line holds it, and assert counts rather than narrows.
  const pid = (await propose(decision, reversal, "newer_supersedes_older"))!;
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
  const colComment = (await db.query<{ c: string | null }>(COLUMN_COMMENT_SQL, ["thought_work_claims", "ttl_expires_at"])).rows[0]?.c ?? "";
  assert(/renew_claims/.test(colComment) && /missed heartbeat/.test(colComment), "ttl_expires_at's comment names the heartbeat and what the lease now means");
  const fnComment = (await db.query<{ c: string | null }>(FUNCTION_COMMENT_SQL, ["renew_claims(text, text, int)"])).rows[0]?.c ?? "";
  assert(/never backward/.test(fnComment) && !/--/.test(fnComment) && !/--/.test(colComment), "renew_claims's comment states the rule, and neither literal spells a flag with its dashes");
  await db.exec(`DELETE FROM thoughts`);
}

// ── 31. A vendored schema on a migrated brain ────────────────────────────────

console.log("\n[31] A vendored schema applied to a migrated brain replaces no function a migration owns — and what upstream's did (SMD-1250)");
{
  // The owned set, read from the files as scripts/check-fork-consistency.ts
  // check 7 reads it. Three names preflight's remedies spell as the last
  // definer are pinned here: when one moves, so must the remedy.
  const owned = ownedFunctionsIn(files.map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")] as const));
  // 37 at migration 032; the set can only grow, so a smaller one means the
  // reader lost definitions (a comment or body it failed to strip), not that
  // a migration went away.
  assert(owned.size >= 37 && [...owned.keys()].every((n) => /^[a-z][a-z0-9_]*$/.test(n)) && !owned.has("and") && !owned.has("keeps"),
    `the owned set is read from the migrations: ${owned.size} functions (37 at 032, never fewer), names only — no word from a header comment quoting a statement`);
  assert(owned.get("upsert_thought") === "046_thought_audit_event_shape.sql" && owned.get("trace_provenance") === "026_trace_provenance_bounded.sql" && owned.get("release_thought") === "015_thought_work_claims.sql",
    "…and the last definers preflight's remedies name: upsert_thought 046, trace_provenance 026, release_thought 015");
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

  // The vendored file as fixed — its section 6 gone, and since SMD-1796 its
  // GRANTs to Supabase's roles gone too — applied whole. This block used to
  // create authenticated, service_role and anon first so those GRANTs would
  // run; no role is created now, and [40] applies every schemas/*.sql the
  // same way.
  const vendored = readFileSync(join(HERE, "..", "schemas", "enhanced-thoughts", "schema.sql"), "utf8");
  assert(![...owned.keys()].some((fn) => coreFunctionStatement(fn).test(vendored)) && ![...ownedCols.keys()].some((col) => coreColumnCommentStatement(col).test(vendored)),
    "schemas/enhanced-thoughts/schema.sql names no owned function or column comment in a statement, by check 7's own rules");
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
  // 025 re-applied also put its audit trigger back over 055's (SMD-2115: 046
  // restored it as a side effect while it was the last definer of both; it
  // is not any more), so the trigger is restored by name.
  await restoreShipped("upsert_thought", "trace_provenance", "thoughts_write_audit");
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

  // The shape: one function of ten parameters (nine until 046), no older form
  // beside it, 046 the last definer of update_thought and 032/036 of the two
  // names this section otherwise touches.
  assert((await functionsNamed("update_thought")) === 1 && Number((await db.query<{ n: number }>(`SELECT pronargs AS n FROM pg_proc WHERE oid = $1::regprocedure`, [UT])).rows[0].n) === 10,
    "one update_thought, of ten parameters");
  assert(!(await exists(UT_8)) && !(await exists(UT_7)), "…neither the 8- nor the 7-argument form beside it");
  assert(lastDefinerOf("update_thought").startsWith("046") && lastDefinerOf("review_supersession_proposal").startsWith("036") && lastDefinerOf("validate_derived_from").startsWith("032"),
    `046 is the last definer of update_thought (033's body, carried), 036 of review_supersession_proposal (its lock moved before the proposal row, SMD-1462 [36]), 032 of validate_derived_from (${lastDefinerOf("update_thought")}, ${lastDefinerOf("review_supersession_proposal")})`);
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
  assert((await functionsNamed("upsert_thought")) === 3 && (await functionsNamed("update_thought")) === 1 && lastDefinerOf("upsert_thought").startsWith("046") && lastDefinerOf("update_thought").startsWith("046"),
    `three upsert_thought overloads and one update_thought, 046 the last definer of both (it carries 033's update_thought and 035's upsert_thought bodies — [35] — with the write event) (${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("update_thought")})`);
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
  assert(!/ob1:capture-event-carries-content/.test(await srcOf("thoughts_write_audit()")), "(and 025's audit trigger over 055's — the payload sentinel is gone; SMD-2115)");
  await restoreShipped("upsert_thought", "trace_provenance", "thoughts_write_audit");
  assert(/ob1:capture-event-carries-content/.test(await srcOf("thoughts_write_audit()")), "…055 re-applied: the audit trigger carries the payload again");
  assert(/ob1:capture-takes-fingerprint-lock/.test(await srcOf(TWO)) && /ob1:capture-takes-fingerprint-lock/.test(await srcOf(THREE)) && (await functionsNamed("upsert_thought")) === 3, "035 re-applied: both bodies locked again, three overloads");
  assert(/ob1:provenance-walk-bounded/.test(await srcOf("trace_provenance(uuid, int, int)")), "…and 026 re-applied: the bounded walk's sentinel is back");
  // 032 re-applied by hand puts 032's update_thought back — the row →
  // fingerprint order, no sentinel to say so (the header states it). On a
  // brain before 046: its 10-argument form dropped first, or 032's 9-argument
  // one lands BESIDE it and every 9-argument call is "function is not unique"
  // ([22]'s trap, one form later; 046's DROP chain is what clears it). The
  // last definer re-applied restores the order — 046, carrying 033's body.
  await db.exec(`DROP FUNCTION ${UPDATE_THOUGHT_SIGNATURE}`);
  await reapply("032");
  const edit032 = await srcOf(UPDATE_THOUGHT_SIGNATURE_9);
  assert(edit032.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") < edit032.indexOf(LOCK) && (await functionsNamed("update_thought")) === 1, "032 re-applied on a brain before 046 puts the row-then-fingerprint order back, one function (its 9-argument form)");
  // reapply("032") reverts update_thought AND review_supersession_proposal to
  // 032's bodies; restoring update_thought re-applies 046, which also rewrites
  // both capture forms (035's bodies with the event). So restore all three
  // shipped bodies: update_thought and upsert_thought (046) and
  // review_supersession_proposal (036, its lock moved before the proposal row).
  await restoreShipped("update_thought", "upsert_thought", "review_supersession_proposal");
  const edit033 = await srcOf(UPDATE_THOUGHT_SIGNATURE);
  assert(edit033.indexOf(LOCK) < edit033.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") && (await functionsNamed("update_thought")) === 1, "…and the last definer re-applied (046, 033's body) puts the fingerprint lock before the row again and drops 032's form");
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
  // 045 (SMD-1490) appended `tier` (the pipeline tier the writer runs as) and
  // `arm` (the retrieval arm a search ran) after 034's thirteen.
  const expected = ["id", "logged_at", "kind", "agent_id", "tool", "query", "match_count", "threshold", "recency_weight", "filter", "result_ids", "result_scores", "target_id", "tier", "arm"];
  assert(JSON.stringify(cols) === JSON.stringify(expected), `query_log has exactly its columns in order (${cols.join(", ")})`);

  // The three indexes: 034's btree on (agent_id, logged_at) and partial GIN on
  // result_ids for the export join, plus 047's (SMD-1492) plain btree on
  // logged_at so prune's bare time-range DELETE range-scans instead of
  // sequentially scanning (the composite's leading column is agent_id, so it
  // cannot serve a logged_at-only range). The planner won't pick the logged_at
  // index on this tiny table — that it exists is asserted here; that prune uses
  // it at volume is bench-querylog.ts's job.
  const idx = (await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'query_log'`)).rows;
  assert(idx.some((r) => /USING btree \(agent_id, logged_at\)/.test(r.indexdef)), "(agent_id, logged_at) btree exists for the join's agent-and-time narrowing");
  assert(idx.some((r) => /USING gin \(result_ids\)/.test(r.indexdef) && /WHERE \(kind = 'search'::text\)/.test(r.indexdef)), "a partial GIN on result_ids (search rows) answers the @> containment lookup");
  assert(idx.some((r) => /USING btree \(logged_at\)/.test(r.indexdef)), "a plain btree on (logged_at) exists so prune's time-range DELETE range-scans (047, SMD-1492)");

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

  // 045 (SMD-1490): tier and arm, each enumerated by a CHECK that also admits
  // NULL. A valid pair inserts; an out-of-set value on either is refused. The
  // rows are cleaned up so the export join below counts only its own.
  await db.exec(`
    INSERT INTO query_log (kind, tool, query, tier, arm) VALUES ('search', 'search_thoughts', 'q', 'canary', 'hybrid');
    INSERT INTO query_log (kind, tool, query, tier, arm) VALUES ('search', 'search_thoughts_keyword', 'q', 'stable', 'keyword');`);
  const enumd = (await db.query<{ tier: string; arm: string }>(
    `SELECT tier, arm FROM query_log WHERE arm IS NOT NULL ORDER BY arm`)).rows;
  assert(enumd.length === 2 && enumd[0].arm === "hybrid" && enumd[0].tier === "canary" && enumd[1].arm === "keyword" && enumd[1].tier === "stable",
    `a search row carries its tier and arm (${JSON.stringify(enumd)})`);
  let refusedTier = false;
  try { await db.exec(`INSERT INTO query_log (kind, tool, query, tier) VALUES ('search', 'search_thoughts', 'q', 'prod')`); }
  catch { refusedTier = true; }
  assert(refusedTier, "a tier outside stable|canary|working is refused by the CHECK");
  let refusedArm = false;
  try { await db.exec(`INSERT INTO query_log (kind, tool, query, arm) VALUES ('search', 'search_thoughts', 'q', 'vector')`); }
  catch { refusedArm = true; }
  assert(refusedArm, "an arm outside hybrid|keyword is refused by the CHECK");
  await db.exec(`DELETE FROM query_log WHERE arm IS NOT NULL OR query = 'q'`);

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

  // prune_query_log: default arg, bounded delete, the default window's unit,
  // the strict bound, and a refusal on a bad window.
  const nBefore = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n;
  const deletedFresh = (await db.query<{ n: number }>(`SELECT prune_query_log() AS n`)).rows[0].n;
  assert(deletedFresh === 0 && (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n === nBefore, "prune_query_log() with the default 30-day window deletes nothing fresh");
  // The bound is `logged_at < now()`, strict, and now() is the transaction's
  // start, read from a clock that under PGlite has millisecond grain, so a row
  // inserted a few statements earlier can share the prune's now() and survive
  // prune_query_log(0) (flaked once, SMD-1498). Age the rows; the assumption
  // was the flaw, not the function.
  await db.exec(`UPDATE query_log SET logged_at = logged_at - interval '1 hour'`);
  const wiped = (await db.query<{ n: number }>(`SELECT prune_query_log(0) AS n`)).rows[0].n;
  assert(Number(wiped) === nBefore && (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM query_log`)).rows[0].n === 0, `prune_query_log(0) deletes every row older than now() (${wiped} of ${nBefore})`);
  // The default window, unit and number. "deletes nothing fresh" above ran
  // over rows at most two hours old, and rows going was asserted only at 0,
  // so a body reading `make_interval(hours => p_keep_days)` — 30 hours keeps
  // a 2-hour-old row, 0 wipes — passed every prune line here (SMD-1515). One
  // row each side of the 30-day edge, half a day out: 30.5 days goes, 29.5
  // stays. Half a day, not a day: rows at 31 and 29 days sit exactly on a
  // 31- or 29-day bound whenever the INSERT and the prune share a now(), and
  // one ms under it when they do not, so the tick decides those mutants — a
  // 29-day default slips on the shared tick (its row equals the bound, and
  // `<` keeps it), a 31-day default on the drift (its row falls under the
  // bound and goes); this ticket's first review pass saw the first slip 3 of
  // 3 runs and the second 2 of 3. Twelve hours dwarf the tick and a DST hour
  // both; the hours body deletes both rows, a weeks body neither.
  await db.exec(`
    INSERT INTO query_log (kind, tool, query, logged_at) VALUES
      ('search', 'search_thoughts', 'half a day past the window', now() - interval '30 days 12 hours'),
      ('search', 'search_thoughts', 'half a day inside the window', now() - interval '29 days 12 hours')`);
  const deletedByDefault = Number((await db.query<{ n: number }>(`SELECT prune_query_log() AS n`)).rows[0].n);
  const leftByDefault = (await db.query<{ q: string }>(`SELECT query AS q FROM query_log`)).rows.map((r) => r.q);
  assert(deletedByDefault === 1 && leftByDefault.length === 1 && leftByDefault[0] === "half a day inside the window",
    `prune_query_log()'s default window is 30 days: the 30.5-day row goes, the 29.5-day row stays (deleted ${deletedByDefault}, left: ${leftByDefault.join(", ") || "none"})`);
  // Both by name, whatever the prune did, so the same-transaction keep below
  // (left === 1) is judged alone.
  await db.exec(`DELETE FROM query_log WHERE query IN ('half a day past the window', 'half a day inside the window')`);
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
  const commentOf = async (sig: string) => (await db.query<{ c: string | null }>(FUNCTION_COMMENT_SQL, [sig])).rows[0]?.c ?? "";
  const three = await srcOf(THREE);
  type R = { id: string; fingerprint: string; existed?: boolean; supersedes?: string | null; chunks?: number };
  const cap = async (content: string, payload: Record<string, unknown>, vec: string | null) =>
    (await db.query<{ r: R }>(`SELECT upsert_thought($1, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(payload), vec])).rows[0].r;
  const prov = async (id: string) => (await db.query<{ s: string | null; d: unknown }>(`SELECT supersedes AS s, derived_from AS d FROM thoughts WHERE id = $1`, [id])).rows[0];
  const edit = async (id: string, envelope: Record<string, unknown>) =>
    (await db.query<{ r: { ok: boolean; error?: string } }>(`SELECT update_thought($1::uuid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2::jsonb) AS r`, [id, JSON.stringify(envelope)])).rows[0].r;
  const twoRowLoops = async () => Number((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts a JOIN thoughts b ON b.id = a.supersedes AND b.supersedes = a.id AND a.id < b.id`)).rows[0].c);

  // The shape: 046 the last definer of upsert_thought (035's bodies, with the
  // write event) and of update_thought (033's body, a tenth parameter).
  assert(lastDefinerOf("upsert_thought").startsWith("046") && lastDefinerOf("update_thought").startsWith("046") && (await functionsNamed("upsert_thought")) === 3,
    `046 is the last definer of upsert_thought and of update_thought, three overloads (${lastDefinerOf("upsert_thought")}, ${lastDefinerOf("update_thought")})`);
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
  // what says so; the last definer (046) re-applied restores. On a brain
  // before 046 — its 10-argument update_thought dropped first, or 033's
  // 9-argument form lands beside it and the 9-argument edit below is
  // "function is not unique" ([33]'s note).
  await db.exec(`DROP FUNCTION ${UPDATE_THOUGHT_SIGNATURE}`);
  await reapply("033");
  const three033 = await srcOf(THREE);
  assert(!/ob1:re-capture-writes-no-provenance/.test(three033) && /supersession-review/.test(three033) && /COALESCE\(thoughts\.supersedes/.test(three033) && /ob1:capture-takes-fingerprint-lock/.test(three033), "033 re-applied over 035 puts the fill and the supersession lock back, the lock sentinel kept");
  const filled = await cap("035 residue: the earlier note", { metadata: {}, supersedes: x.id }, unit(3));
  assert(filled.existed === undefined && (await prov(r.id)).s === x.id && (await twoRowLoops()) === 1, "…and under it the same re-capture writes the loop and says nothing (no existed) — one row from the header's query");
  assert((await edit(r.id, { supersedes: null })).ok === true && (await twoRowLoops()) === 0, "…which the envelope clears (the header's remedy for a loop written before 035)");
  assert(!/add-if-empty/.test(await commentOf(REVIEW)), "(033 re-applied leaves review_supersession_proposal's COMMENT as 035 issued it — only 032's own file puts the aside back, as [33]'s trap did before 035 followed)");
  await restoreShipped("upsert_thought");
  const restored = await srcOf(THREE);
  assert(/ob1:re-capture-writes-no-provenance/.test(restored) && !/supersession-review/.test(restored) && !/COALESCE\(thoughts\.supersedes/.test(restored) && (await functionsNamed("upsert_thought")) === 3 && (await functionsNamed("update_thought")) === 1 && /ob1\.event/.test(await srcOf(UPDATE_THOUGHT_SIGNATURE)),
    "046 re-applied: the fill and the lock gone again, three overloads, one update_thought — 046's 10-argument form, 033's dropped");
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
  // 036 added one advisory-lock line to 009's body; 042 carried that body
  // forward under a third parameter, the two-argument form dropped so there is
  // still one function. A future edit that drops the lock — reopening the
  // accept-vs-delete deadlock db/test-live.ts [6g] proves — is caught here, in
  // the fast suite, without a live server. [41] holds what 042 added.
  assert((await functionsNamed("delete_thought")) === 1 && lastDefinerOf("delete_thought").startsWith("042"),
    `one delete_thought, 042 the last definer carrying 036's lock (${lastDefinerOf("delete_thought")})`);
  const src = String((await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, ["delete_thought(uuid, jsonb, boolean)"])).rows[0].s);
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

console.log("\n[37] bench-hnsw's oracle cache: what of a marker's entry a run may trust (SMD-1562, bench-oracle.ts)");
{
  // A pure function of the entry: the container suite drives the bench's
  // reads and writes; the guards are held here, in milliseconds, with the
  // mechanism removed one clause at a time (review passes counted five of
  // seven mutant-blind under the container suite's two planted cases).
  const keys = ["t50", "whole table"];
  const size = (key: string) => (key === "whole table" ? 3 : 2);
  const answer = (i: number, n: number) => ({ ids: Array.from({ length: n }, (_, j) => `id-${i}-${j}`), top: 0.5 + i / 100 });
  const entry = (q: number) => ({ queries: Array.from({ length: q }, (_, i) => `d${i}`), answers: { t50: Array.from({ length: q }, (_, i) => answer(i, 2)), "whole table": Array.from({ length: q }, (_, i) => answer(i, 3)) } });
  const digests = ["d0", "d1", "d2"];
  const whole = markerAnswers(entry(5), keys, digests, size);
  assert(whole.have === 3 && whole.had === 5 && whole.taken["whole table"].length === 3 && whole.taken["whole table"][2].ids[0] === "id-2-0", `a whole entry answers for this run's leading queries (have ${whole.have}, had ${whole.had})`);
  const longer = markerAnswers(entry(2), keys, digests, size);
  assert(longer.have === 2 && longer.had === 2 && longer.taken.t50.length === 2, "an entry shorter than the run answers for what it holds");
  const drifted = markerAnswers(entry(5), keys, ["d0", "x1", "d2"], size);
  assert(drifted.have === 1 && drifted.had === 5, `a digest that stops matching ends the prefix there (have ${drifted.have})`);
  const foreign = markerAnswers(entry(5), keys, ["x0", "d1", "d2"], size);
  assert(foreign.have === 0 && foreign.had === 5, "a first digest that differs answers for nothing, and the entry is still counted");
  for (const [what, e] of [
    ["absent", undefined],
    ["null", null],
    ["a string", "oracle"],
    ["no queries", { answers: {} }],
    ["empty queries", { queries: [], answers: {} }],
  ] as const) {
    const r = markerAnswers(e, keys, digests, size);
    assert(r.have === 0 && r.had === 0 && r.taken.t50.length === 0, `${what}: nothing, had none`);
  }
  const broken = (mutate: (e: ReturnType<typeof entry>) => void) => {
    const e = entry(3);
    mutate(e);
    return markerAnswers(e, keys, digests, size);
  };
  for (const [what, mutate] of [
    ["a key missing", (e) => delete (e.answers as Record<string, unknown>).t50],
    ["a key with fewer answers than queries", (e) => e.answers.t50.pop()],
    ["a tier answer one id short", (e) => e.answers.t50[1].ids.pop()],
    ["a whole-table answer one id short", (e) => e.answers["whole table"][0].ids.pop()],
    ["an answer one id long", (e) => e.answers.t50[0].ids.push("extra")],
    ["a duplicated id", (e) => (e.answers["whole table"][2].ids[2] = e.answers["whole table"][2].ids[0])],
    ["a non-string id", (e) => ((e.answers.t50[0].ids as unknown[])[0] = 7)],
    ["a null cosine", (e) => ((e.answers["whole table"][1] as { top: unknown }).top = null)],
    ["an infinite cosine", (e) => (e.answers["whole table"][1].top = Infinity)],
    ["a non-string digest", (e) => ((e.queries as unknown[])[0] = 0)],
    ["an answer that is not an object", (e) => ((e.answers.t50 as unknown[])[2] = "x")],
  ] as [string, (e: ReturnType<typeof entry>) => void][]) {
    const r = broken(mutate);
    assert(r.have === 0 && r.had === 3 && r.taken["whole table"].length === 0, `${what}: the entry answers for nothing, and is counted as found (had ${r.had})`);
  }
  assert(markerAnswers(entry(3), keys, digests, () => 2).have === 0, "an expected size the entry does not meet answers for nothing");
}

// ── 38. Migration 039 — the walk's index is half precision ───────────────────
//
// At the shipped width pgvector fits one float4 vector to an index page and
// three halfvec ones; 039 rebuilds the two HNSW indexes over
// `embedding::halfvec(D)` under 001/007's names and casts the walk branches'
// ORDER BYs to match. The index expression and the body's ORDER BY are one
// contract — the planner matches them structurally — so this section holds
// the swap's every case the header names and pairs the cast with the plan.
// The recall and the bytes are evals/eval-quant.ts's, on real vectors.

console.log("\n[38] Migration 039: the walk's index is half precision — the swap under 001/007's names, what a re-run, a hand rebuild, a staging index and an invalid one each meet, and the plan that pairs the body's cast with the index");
{
  const def = async (name: string) => String((await db.query<{ d: string | null }>(`SELECT pg_get_indexdef(to_regclass($1)) AS d`, [name])).rows[0].d ?? "");
  const oid = async (name: string) => (await db.query<{ o: string | null }>(`SELECT to_regclass($1)::oid::text AS o`, [name])).rows[0].o;
  const HALF = new RegExp(`USING hnsw \\(\\(\\(embedding\\)::halfvec\\(${EMBEDDING_DIM}\\)\\) halfvec_cosine_ops\\)$`);
  for (const [t, name] of [["thoughts", "thoughts_embedding_idx"], ["thought_chunks", "thought_chunks_embedding_idx"]]) {
    const d = await def(name);
    assert(HALF.test(d) && d.includes(` ON public.${t} `), `${name} is HNSW over (embedding)::halfvec(${EMBEDDING_DIM}) with halfvec_cosine_ops, under the name 001/007 gave it (${d})`);
    assert((await oid(`${t}_embedding_halfvec_idx`)) === null, `…and no staging index is left on ${t}`);
  }
  const oids = async () => JSON.stringify([await oid("thoughts_embedding_idx"), await oid("thought_chunks_embedding_idx")]);
  const kept = await oids();
  await reapply("039");
  assert((await oids()) === kept, "re-applying 039 rebuilds nothing: both indexes keep their OIDs (the swap finds halfvec under the shipped name and does nothing)");
  await reapply("001");
  assert((await oids()) === kept && HALF.test(await def("thoughts_embedding_idx")), "001 re-applied by hand leaves it: its CREATE INDEX IF NOT EXISTS finds the name");

  // The pair: the body's ORDER BY reaches the index; the raw column's, which
  // had it until 039, does not; nor does a cast on one side only.
  await db.exec(`DELETE FROM thoughts`);
  const { unitVector } = seededRandom(1501);
  const values = Array.from({ length: 60 }, (_, k) => `('half ${k}', '{}'::jsonb, '[${unitVector(EMBEDDING_DIM).join(",")}]'::vector)`).join(",");
  await db.exec(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  const q = `[${unitVector(EMBEDDING_DIM).join(",")}]`;
  const plan = async (orderBy: string) => {
    await db.exec(`SET enable_seqscan = off`);
    try {
      return (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT id FROM thoughts ORDER BY ${orderBy} LIMIT 5`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    } finally {
      await db.exec(`RESET enable_seqscan`);
    }
  };
  const cast = `embedding::halfvec(${EMBEDDING_DIM}) <=> '${q}'::vector::halfvec(${EMBEDDING_DIM})`;
  assert(/Index Scan using thoughts_embedding_idx/.test(await plan(cast)), "ordered by the cast on both sides — the body's ORDER BY — the walk is an Index Scan using thoughts_embedding_idx");
  assert(!/Index Scan using thoughts_embedding_idx/.test(await plan(`embedding <=> '${q}'::vector`)), "ordered by the raw column it is not: since 039 the cast is the index's key (the header's first failure mode)");
  const exact = (await db.query<{ id: string }>(`SELECT id FROM thoughts ORDER BY embedding <=> $1::vector, id LIMIT 10`, [q])).rows.map((x) => x.id);
  const got = (await db.query<{ id: string }>(`SELECT id FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [q])).rows.map((x) => x.id);
  assert(got.length === 10 && got.every((id) => exact.includes(id)), "match_thoughts over the half-precision index returns the exact top-10 on 60 rows (the walk finds them all; the score is the full vector's)");

  // A hand rebuild from 001's DDL puts a vector index under the name: the
  // body's ORDER BY has no index path until 039 is re-applied.
  await db.exec(`DROP INDEX thoughts_embedding_idx`);
  await db.exec(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
  assert(!/Index Scan/.test(await plan(cast)), "with a vector index back under the name, the body's ORDER BY has no index path (the second failure mode: 019's sequential scan — exact, slow)");
  await reapply("039");
  assert(HALF.test(await def("thoughts_embedding_idx")) && /Index Scan using thoughts_embedding_idx/.test(await plan(cast)), "re-applying 039 swaps it back, and the walk has its index again");

  // A staging index built beforehand — the CONCURRENTLY path for a large
  // brain — is adopted under the shipped name, the same relation.
  const stage = async () => {
    await db.exec(`DROP INDEX thoughts_embedding_idx`);
    await db.exec(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
    await db.exec(`CREATE INDEX thoughts_embedding_halfvec_idx ON thoughts USING hnsw ((embedding::halfvec(${EMBEDDING_DIM})) halfvec_cosine_ops)`);
    return oid("thoughts_embedding_halfvec_idx");
  };
  const staged = await stage();
  await reapply("039");
  assert((await oid("thoughts_embedding_idx")) === staged && (await oid("thoughts_embedding_halfvec_idx")) === null && HALF.test(await def("thoughts_embedding_idx")),
         "a valid staging index built by hand is adopted: renamed under the shipped name, the same relation, nothing rebuilt");
  // A valid index of another shape under the staging name is refused by name,
  // never renamed into place (review pass 1); dropped by hand, the re-run
  // builds and swaps as on a fresh table.
  await db.exec(`DROP INDEX thoughts_embedding_idx`);
  await db.exec(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
  await db.exec(`CREATE INDEX thoughts_embedding_halfvec_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
  let refused = "";
  try {
    await reapply("039");
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(new RegExp(`migration 039: thoughts_embedding_halfvec_idx exists but is not an HNSW index over \\(embedding::halfvec\\(${EMBEDDING_DIM}\\)\\)`).test(refused) && !HALF.test(await def("thoughts_embedding_idx")),
         `a staging index of another shape is refused by name and nothing is renamed (${refused.split("\n")[0] || "it was adopted"})`);
  await db.exec(`DROP INDEX thoughts_embedding_halfvec_idx`);
  await reapply("039");
  assert(HALF.test(await def("thoughts_embedding_idx")) && (await oid("thoughts_embedding_halfvec_idx")) === null, "…dropped by hand, the re-run builds and swaps as on a fresh table");
  // The same under the SHIPPED name: a valid index that names halfvec but is
  // not this shape — an IVFFlat over the cast, from pgvector's docs — is
  // refused, not taken for done; 001's vector index is swapped (review pass 2).
  await db.exec(`DROP INDEX thoughts_embedding_idx`);
  await db.exec(`CREATE INDEX thoughts_embedding_idx ON thoughts USING ivfflat ((embedding::halfvec(${EMBEDDING_DIM})) halfvec_cosine_ops) WITH (lists = 1)`);
  refused = "";
  try {
    await reapply("039");
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(new RegExp(`migration 039: thoughts_embedding_idx exists but is not an HNSW index over \\(embedding::halfvec\\(${EMBEDDING_DIM}\\)\\)`).test(refused) && /USING ivfflat/.test(await def("thoughts_embedding_idx")),
         `an IVFFlat index over the cast under the shipped name is refused by name, not taken for done (${refused.split("\n")[0] || "it was kept"})`);
  await db.exec(`DROP INDEX thoughts_embedding_idx`);
  await reapply("039");
  assert(HALF.test(await def("thoughts_embedding_idx")), "…dropped by hand, the re-run builds the HNSW index under the name");
  // An INVALID staging index — what an interrupted CREATE INDEX CONCURRENTLY
  // leaves — is dropped and a fresh one built, and an INVALID halfvec index
  // under the shipped name is rebuilt rather than kept. Both cases are
  // db/test-upgrade.ts [16]'s: they are made by flipping pg_index.indisvalid,
  // and PGlite refuses the catalog write ("tuple concurrently updated") where
  // a server does not.
  await db.exec(`DELETE FROM thoughts`);
}

console.log("\n[39] Memory utilization over the query log: attribution, the cited/opened split, the rates, and what the report refuses to print (SMD-1719, evals/utilization.ts)");
{
  // No database: the pure module over hand-made rows. The fixture is one agent
  // (AG) who searches twice, an anonymous caller who searches once, and the
  // touches that follow. Times are minutes on one clock so the window is exact.
  const t = (min: number) => new Date(Date.UTC(2026, 8, 18, 12, min)).toISOString();
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "aaaaaaaa-0000-4000-8000-000000000002";
  const C = "aaaaaaaa-0000-4000-8000-000000000003";
  const D = "aaaaaaaa-0000-4000-8000-000000000004";
  const AG = "99999999-9999-4999-8999-999999999999";
  const search = (id: string, agentId: string | null, min: number, query: string, ids: string[], tokens: number | null, tool = "search_thoughts"): SearchRow =>
    ({ id, agentId, loggedAt: t(min), tool, query, matchCount: 5, threshold: 0, recencyWeight: 0, resultIds: ids, resultTokens: tokens });
  const act = (agentId: string | null, min: number, tool: string, targetId: string): ActionRow => ({ agentId, loggedAt: t(min), tool, targetId });

  const searches: SearchRow[] = [
    search("s1", AG, 0, "first", [A, B, C], 300),   // AG's first search: A B C returned, ~300 tokens
    search("s2", AG, 10, "second", [C, D], 100),    // AG's second: C D
    search("s3", null, 0, "anon", [A, B], null),    // anonymous: A B, no token estimate
  ];
  const actions: ActionRow[] = [
    act(AG, 2, "fetch", A),                              // opened A → s1
    act(AG, 3, "capture_thought/derived_from", B),       // cited B → s1
    act(AG, 12, "update_thought/supersedes", C),         // cited C → s2 (most recent prior search returning C, not s1); an edit's pointer is a cite too
    act(AG, 50, "fetch", D),                             // 40 min after s2 → outside a 30-min window → unattributed
    act(null, 1, "fetch", A),                            // anonymous fetch of A → s3, never AG's s1 (NULL agent is its own bucket)
    act(AG, 4, "delete_thought", "aaaaaaaa-0000-4000-8000-00000000ffff"), // an id no search returned → unattributed
  ];

  // The split is read from the tool's shape alone: `<writer>/<pointer>` is a
  // cite whatever the writer, a plain name is an open.
  assert(citePointerOf("capture_thought/derived_from") === "derived_from" && citePointerOf("update_thought/supersedes") === "supersedes" && citePointerOf("some_future_tool/derived_from") === "derived_from",
    "a `<writer>/<pointer>` tool names its pointer, for any writer");
  assert(citePointerOf("fetch") === null && citePointerOf("update_thought") === null && citePointerOf("odd/") === null && citePointerOf("/x") === null,
    "a plain tool, or a malformed slash form, is not a cite");

  const attr = attribute(searches, actions, 30);
  const s1 = attr.bySearch.get("s1")!;
  const s2 = attr.bySearch.get("s2")!;
  const s3 = attr.bySearch.get("s3")!;
  assert([...s1.used].sort().join() === [A, B].join() && s1.opened.has(A) && s1.cited.has(B) && !s1.cited.has(A), "s1: A opened, B cited — the tool column splits the two kinds of use");
  assert([...s2.used].join() === C && s2.cited.has(C) && !s1.used.has(C), "a cite of C goes to the MOST RECENT prior search that returned it (s2), not the older s1");
  assert([...s3.used].join() === A && s3.opened.has(A), "the anonymous fetch attributes to the anonymous search");
  assert(s3.used.size === 1 && s1.used.size === 2 && !s1.used.has(D), "…and a NULL agent is its own bucket: AG's search did not absorb the anonymous touch, nor the anonymous search AG's");
  assert(attr.unattributed.length === 2 && attr.unattributed.some((a) => a.targetId === D) && attr.unattributed.some((a) => a.tool === "delete_thought"),
    `a touch 40 min after its search, and a touch of an id no search returned, attribute to nothing and are counted (${attr.unattributed.length})`);

  const sum = summarise(searches, actions, 30);
  assert(sum.overall.searches === 3 && sum.overall.returned === 7 && sum.overall.used === 4, `overall: 3 searches, 7 ids returned, 4 used (${sum.overall.returned}, ${sum.overall.used})`);
  assert(Math.abs((sum.overall.utilization ?? 0) - 4 / 7) < 1e-9, `utilization = used / returned = 4/7 (${sum.overall.utilization})`);
  assert(sum.overall.useRate === 1, "every search had at least one use → use rate 1");
  assert(sum.overall.cited === 2 && sum.overall.opened === 2, `cited 2, opened 2 (${sum.overall.cited}, ${sum.overall.opened})`);
  assert(sum.actionsTotal === 6 && sum.unattributed === 2, "the report carries the action count and how many attributed to nothing");
  // Tokens per used id is computed only over searches that carry an estimate:
  // s1 (300 tokens, 2 used) and s2 (100 tokens, 1 used) → 400 / 3; s3 has none.
  assert(Math.abs((sum.overall.tokensPerUsed ?? 0) - 400 / 3) < 1e-9 && sum.overall.searchesWithTokens === 2, `tokens per used id over the searches with an estimate (${sum.overall.tokensPerUsed})`);
  // Per arm: the fixture is one arm; per agent: AG and (anonymous).
  assert(sum.arms.size === 1 && [...sum.arms.keys()][0] === "search_thoughts k=5 thr=0 rw=0", `one arm, named from the row's tool and arguments (${[...sum.arms.keys()][0]})`);
  assert(sum.agents.get(AG)?.searches === 2 && sum.agents.get("(anonymous)")?.searches === 1, "per-agent rows: AG's two searches and the anonymous one");

  // The mutant this section is for: drop the cite rows (the SMD-1719 server
  // change) and the number moves — utilization falls to the opened-only 2/7 and
  // cited reads 0. A report that did not move here would not be measuring cites.
  const noCites = summarise(searches, actions.filter((a) => citePointerOf(a.tool) === null), 30);
  assert(noCites.overall.cited === 0 && Math.abs((noCites.overall.utilization ?? 0) - 2 / 7) < 1e-9, `without the cite rows: cited 0, utilization 2/7 (${noCites.overall.utilization}) — the cites are what the number measures`);

  // Gold: a hand-labelled map says s1's relevant id was C (never used) and s2's
  // was C (used). Ignore rate over searches whose results held a gold id: 1 of 2.
  const gold = new Map<string, Set<string>>([["first", new Set([C])], ["second", new Set([C])]]);
  const withGold = summarise(searches, actions, 30, gold);
  assert(withGold.overall.gold?.withGold === 2 && withGold.overall.gold?.ignored === 1 && withGold.overall.gold?.ignoreRate === 0.5,
    `ignore rate: of 2 searches that returned a gold id, 1 used none of them (${JSON.stringify(withGold.overall.gold)})`);

  // What the report refuses to print: with no action rows at all it says n/a
  // and asks whether the log is on, rather than 0% over an empty join.
  const none = renderReport(summarise(searches, [], 30));
  assert(/utilization: n\/a/.test(none) && /NO action rows/.test(none) && !/0%/.test(none), "no action rows → 'n/a', not 0%");
  const full = renderReport(sum);
  assert(/all\s+3\s+7\s+4\s+57%/.test(full) && /2 attributed to no search/.test(full), `the rendered table carries the overall row and the unattributed count (${full.split("\n").find((l) => l.startsWith("all"))})`);
  assert(/token estimate for 2 of 3 search/.test(full), "…and says how many searches carry a token estimate, so tok/used is read over the right denominator");
  assert(/by agent/.test(full) && /\(anonymous\)/.test(full), "two agents → a by-agent block naming the anonymous bucket");
  assert(!/WARN/.test(full) && sum.unknownTools.size === 0, "every plain tool in the fixture is a known open — no warning");

  // A plain tool name outside the known opens is counted as opened (never
  // dropped) AND flagged: a writer that forgot the `<writer>/<pointer>` form
  // is seen, not folded silently into click-through.
  // B was already cited by s1's capture, so this open of B changes nothing in
  // the partition (cited wins); an unknown tool on an UNCITED id is counted as
  // opened — both shown.
  const odd = summarise(searches, [...actions, act(AG, 5, "new_tool_that_forgot", B)], 30);
  assert(odd.unknownTools.get("new_tool_that_forgot") === 1 && odd.overall.opened === 2 && odd.overall.cited === 2, `an unknown plain tool is reported, and an open of an already-cited id leaves the partition alone (${JSON.stringify([...odd.unknownTools])}, opened ${odd.overall.opened})`);
  const oddUncited = summarise(searches, [...actions, act(AG, 11, "new_tool_that_forgot", D)], 30);
  assert(oddUncited.overall.opened === 3 && oddUncited.unknownTools.get("new_tool_that_forgot") === 1, `an unknown plain tool on an uncited id is counted as opened (${oddUncited.overall.opened})`);
  assert(/WARN new_tool_that_forgot ×1/.test(renderReport(odd)), "…and the report warns by name");
  // The by-agent table (two or more agents) names a row from the registry
  // when the reader hands the names over, id prefix beside it; an id the
  // registry does not know, and the anonymous bucket, keep their labels.
  {
    const named = renderReport(sum, new Map([[AG, "laptop"]]));
    assert(new RegExp(`^laptop \\(${AG.slice(0, 8)}\\)\\s+\\d`, "m").test(named), "a by-agent row reads `label (id prefix)` when the registry names the id");
    assert(/^\(anonymous\)\s+\d/m.test(named) && !new RegExp(`^${AG}\\s`, "m").test(named), "the anonymous bucket keeps its name, and the named id no longer prints bare");
    assert(new RegExp(`^${AG}\\s+\\d`, "m").test(renderReport(sum)), "…while without names the id prints as itself");
    assert(agentLabel("x", new Map()) === "x" && agentLabel("(anonymous)") === "(anonymous)", "agentLabel falls back to the key itself");
  }

  // The database-row coercions the report script relies on, driven here
  // without a database (third review pass: the script itself runs in no CI
  // job). bigint columns arrive as strings under Bun; uuid[] as the `{a,b}`
  // literal; the token estimate is whole or absent.
  const dbRow = (over: Partial<Parameters<typeof toSearchRow>[0]> = {}) => toSearchRow({
    id: "s9", agent_id: AG, logged_at: t(0), at_us: "1789816800000000", tool: "search_thoughts", query: "q",
    match_count: 5, threshold: 0.30000001192092896, recency_weight: 0, result_ids: `{${A},${B}}`, chars: "1200", surviving: "2", ...over,
  });
  const whole = dbRow();
  assert(whole.resultIds.join() === [A, B].join() && whole.resultTokens === 300 && whole.atUs === 1789816800000000, `a whole result set: ids parsed from the literal, chars/4 as tokens, at_us as a number (${JSON.stringify([whole.resultIds.length, whole.resultTokens, whole.atUs])})`);
  assert(dbRow({ surviving: "1" }).resultTokens === null, "one returned id since deleted → no estimate, not a partial one");
  assert(dbRow({ chars: null, surviving: "0", result_ids: "{}" }).resultTokens === null, "nothing returned → no estimate");
  assert(armOf(whole) === "search_thoughts k=5 thr=0.3 rw=0", `a real's float32 noise does not reach the arm name (${armOf(whole)})`);
  const actDb = toActionRow({ agent_id: null, logged_at: t(1), at_us: "1789816860000000", tool: "fetch", target_id: A });
  assert(actDb.agentId === null && actDb.atUs === 1789816860000000, "an action row's NULL agent and at_us survive the coercion");
  const goldFx = goldFromFixture({ queries: [{ query: "first", relevant: `{${C},"${D}"}` }, { query: "second", relevant: [C] }] });
  assert(goldFx.get("first")?.has(C) && goldFx.get("first")?.has(D) && goldFx.get("second")?.size === 1, "a gold fixture reads a `{a,b}` literal (quoted or not) and an array alike");
  assert(goldFromFixture({ queries: [{ query: "up", relevant: [C.toUpperCase()] }] }).get("up")?.has(C) === true, "a gold id spelled upper-case matches the lower-case id the log holds (seventh pass)");
  // An instant that does not parse credits nothing and takes nothing: a
  // search row with an unreadable timestamp is never a hit, an action row
  // with one is unattributed — not attributed to the agent's newest search
  // because every comparison against NaN is false (seventh pass).
  {
    const badSearch = { ...search("bad", AG, 0, "q", [A], null), loggedAt: "not a date" };
    const goodSearch = search("good", AG, 0, "q", [A], null);
    const r1 = attribute([badSearch], [act(AG, 1, "fetch", A)], 30);
    assert(r1.unattributed.length === 1 && !r1.bySearch.has("bad"), "a search with an unreadable instant is never credited");
    const r2 = attribute([goodSearch], [{ ...act(AG, 1, "fetch", A), loggedAt: "" }], 30);
    assert(r2.unattributed.length === 1 && !r2.bySearch.has("good"), "an action with an unreadable instant is unattributed, not handed to the newest search");
  }

  // Microsecond grain: two searches by one agent 400 µs apart both return X,
  // then a fetch of X. The SQL join (ORDER BY logged_at DESC) credits the
  // later one; so does attribute() when the rows carry at_us — a Date alone
  // would tie them at the millisecond.
  const base = 1789816800000000;
  const closeSearches: SearchRow[] = [
    { ...search("c1", AG, 0, "q", [A], null), atUs: base },
    { ...search("c2", AG, 0, "q", [A], null), atUs: base + 400 },
  ];
  const closeAttr = attribute(closeSearches, [{ ...act(AG, 0, "fetch", A), atUs: base + 800 }], 30);
  assert(closeAttr.bySearch.has("c2") && !closeAttr.bySearch.has("c1"), "with at_us, the fetch attributes to the later of two searches 400 µs apart, as the SQL join does");
  assert(attribute(closeSearches, [{ ...act(AG, 0, "fetch", A), atUs: base + 200 }], 30).bySearch.has("c1"), "…and a fetch between them attributes to the earlier one, not the one 200 µs later");

  // The rendered rows align: a numeric util and an n/a util print at the
  // same width, so the columns under the header line up (third pass).
  // cited and opened partition used (fourth pass): an id fetched AND then cited
  // within one search's window is cited, not both; cited + opened = used.
  const both = summarise([search("p1", AG, 0, "p", [A, B], null)], [act(AG, 1, "fetch", A), act(AG, 2, "capture_thought/derived_from", A), act(AG, 3, "fetch", B)], 30);
  assert(both.overall.used === 2 && both.overall.cited === 1 && both.overall.opened === 1, `opened then cited → cited 1, opened 1 (B only), used 2 (${both.overall.cited}, ${both.overall.opened}, ${both.overall.used})`);
  const citedFirst = summarise([search("p2", AG, 0, "p", [A], null)], [act(AG, 1, "capture_thought/derived_from", A), act(AG, 2, "fetch", A)], 30);
  assert(citedFirst.overall.cited === 1 && citedFirst.overall.opened === 0, "cited then opened → still cited, not opened: order does not matter");

  // A duplicate id in a logged result set is one id returned: utilization can
  // reach 1 and the whole-set estimate holds (the reader counts distinct ids).
  const dup = summarise([search("d1", AG, 0, "d", [A, A, B], 120)], [act(AG, 1, "fetch", A), act(AG, 2, "fetch", B)], 30);
  assert(dup.overall.returned === 2 && dup.overall.utilization === 1, `duplicates collapse: returned 2, utilization 1 (${dup.overall.returned}, ${dup.overall.utilization})`);
  assert(dbRow({ result_ids: `{${A},${A},${B}}`, surviving: "2" }).resultTokens === 300, "a database row with a duplicated id keeps its whole estimate: the reader counts distinct ids and they match the survivors");

  // A log with actions but no cite-shaped tool anywhere reads as "unknown, not
  // zero use": either nothing has cited yet or the brain lacks 035 (fifth pass).
  assert(sum.citeRows === 2 && !/no cite row in the log/.test(renderReport(sum)), `the fixture's two cite rows are counted, so no schema warning (${sum.citeRows})`);
  const opensOnly = summarise(searches, actions.filter((a) => citePointerOf(a.tool) === null), 30);
  assert(opensOnly.citeRows === 0 && /WARN no cite row in the log/.test(renderReport(opensOnly)) && /migration 035/.test(renderReport(opensOnly)), "actions but no cite row → the report warns and names 035");

  const aligned = renderReport(summarise([...searches, search("s0", AG, 20, "empty", [], null)], actions, 30));
  const rowLines = aligned.split("\n").filter((l) => /^(search_thoughts|all|9999|\(anon)/.test(l));
  assert(rowLines.length >= 2 && new Set(rowLines.map((l) => l.length)).size === 1, `every table row is the same width (${[...new Set(rowLines.map((l) => l.length))].join(",")})`);
}

// ── 40. The community schemas on a plain-Postgres brain ──────────────────────

console.log("\n[40] Every schemas/*.sql applies to a migrated brain with no Supabase role present, and --grant's community group is what makes it usable (SMD-1796)");
{
  // A second PGlite: the files add a trigger on `thoughts` (entity-extraction's
  // queue) and columns to it (enhanced-thoughts, provenance-chains), and the
  // sections above must not meet them. Fresh migrations, then every SQL file
  // under schemas/ in the order test-support's communitySchemaFiles gives —
  // the four with a prerequisite first, the rest alphabetical. Most of the
  // upstream files ended with GRANTs TO service_role, RLS and policies for it, and
  // two with policies on auth.uid(): on any Postgres that is not Supabase the
  // first such statement stopped the file (`role "service_role" does not
  // exist`). [31] used to create the three roles for the one file it applied;
  // nothing does now.
  const SCHEMAS = SCHEMAS_DIR;
  const schemaFiles = communitySchemaFiles();
  assert(schemaFiles.length >= 14 && SCHEMA_FILES_FIRST.every((f) => schemaFiles.includes(f)), `${schemaFiles.length} SQL files under schemas/ (17 when written, 14 after SMD-1924 removed three; the set otherwise grows), the four with prerequisites among them`);

  // The rule check-fork-consistency holds these files to, from inside the
  // suite: none runs a Supabase-ism, comments excepted. And the strip's teeth,
  // on the three shapes the old `--`-to-end-of-line strip could not tell apart:
  // a literal carrying `--` followed by a statement on the same line, a
  // comment inside a dollar-quoted body, and a statement inside an EXECUTE
  // string (recipes/brain-health-monitoring runs its grants that way).
  const isms = schemaFiles.flatMap((f) => supabaseIsmsIn(readFileSync(join(SCHEMAS, f), "utf8")).map((h) => `${f}:${h.line} ${h.rule}`));
  assert(isms.length === 0, `no schemas/*.sql runs a Supabase-ism (${isms.length}: ${isms.slice(0, 4).join("; ") || "none"})`);
  const probe = "-- GRANT x TO service_role, in a comment\nSELECT 'a -- literal', 1; GRANT x TO service_role;\nDO $b$ BEGIN -- service_role, in a body's comment\n  EXECUTE 'ALTER TABLE t ENABLE ROW LEVEL SECURITY'; END $b$;\nCREATE POLICY p ON t\n  FOR SELECT\n  TO authenticated USING (true);\nSELECT E'\\'' AS one_quote; -- service_role in a comment after an E-string\ngrant execute on function f()\n  to\n  \"authenticated\";\nALTER TABLE t ENABLE ROW LEVEL\n  SECURITY;";
  const probeHits = supabaseIsmsIn(probe).map((h) => `${h.rule}@${h.line}`);
  assert(JSON.stringify(probeHits) === JSON.stringify(["service_role@2", "rls@4", "rls@5", "supabase-api-role@7", "supabase-api-role@10", "rls@12"]),
    `the scan reads past a literal's -- to the statement after it, skips a body's comment, reads a body's EXECUTE string, finds a policy's TO on its own line, keeps its parity through an E'\\'' string, and follows a TO and an ENABLE ROW LEVEL across a line break (${probeHits.join(", ")})`);

  const cdb = new PGlite({ extensions: { vector, pg_trgm } });
  for (const f of files) await cdb.exec(subst(readFileSync(join(MIGRATIONS, f), "utf8")));
  const roles = (await cdb.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_roles WHERE rolname IN ('authenticated', 'anon', 'service_role')`)).rows[0].c;
  assert(roles === 0, "no Supabase role exists in this database");
  const tablesNow = async () => new Set((await cdb.query<{ n: string }>(`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.n));
  const viewsNow = async () => new Set((await cdb.query<{ n: string }>(`SELECT viewname AS n FROM pg_views WHERE schemaname = 'public'`)).rows.map((r) => r.n));
  const coreTables = await tablesNow();
  const coreViews = await viewsNow();
  const failed: string[] = [];
  for (const f of schemaFiles) {
    try {
      await cdb.exec(readFileSync(join(SCHEMAS, f), "utf8"));
    } catch (e) {
      failed.push(`${f}: ${(e as Error).message.split("\n")[0]}`);
      try { await cdb.exec("ROLLBACK"); } catch { /* the file opened no transaction */ }
    }
  }
  assert(failed.length === 0, `every file applies, in that order (${failed.length} failed: ${failed.join(" | ") || "none"})`);

  // What the community group names is present — by the probe migrate.ts
  // --grant runs — and the group names everything the files created that a
  // grant can reach: every new table, every bigserial sequence (an identity
  // column's sequence needs no grant, measured below), and every function the
  // files REVOKEd FROM PUBLIC. A new community table or definer with no row in
  // ROLE_GRANTS.community would be one --grant does not reach.
  const objects = grantedObjects(["community"]);
  const presence = (await cdb.query<{ kind: string; name: string; present: boolean }>(grantPresenceSql(objects))).rows;
  const absent = presence.filter((r) => !r.present).map((r) => `${r.kind} ${r.name}`);
  assert(presence.length === objects.length && absent.length === 0, `every object the community group names exists once the files are applied (${objects.length}; absent: ${absent.join(", ") || "none"})`);
  const communityTables = new Set(grantedTables(["community"]));
  const newTables = [...(await tablesNow())].filter((t) => !coreTables.has(t));
  const unlisted = newTables.filter((t) => !communityTables.has(t));
  // 25 listed, 23 created: thought_audit is 008's and thought_entities 016's
  // (upstream's entity-extraction file names the same table under IF NOT
  // EXISTS, so on a migrated brain it is 016's shape the grant reaches), and
  // the first run of this section found the second of those.
  const preExisting = [...communityTables].filter((t) => coreTables.has(t)).sort();
  assert(newTables.length === communityTables.size - 2 && unlisted.length === 0 && JSON.stringify(preExisting) === JSON.stringify(["thought_audit", "thought_entities"]),
    `every table the files created is in the community group (${newTables.length} created of ${communityTables.size} listed; ${preExisting.join(" and ")} were the migrations' already; unlisted: ${unlisted.join(", ") || "none"})`);
  // A view is not in pg_tables, and a role's SELECT on the table beneath does
  // not reach it — the first review pass found author-session-id.sql's
  // thought_provenance in no row, so a granted role got `permission denied for
  // view`. Every view the files created is a row of its own kind.
  const communityViews = new Set(grantedViews(["community"]));
  const newViews = [...(await viewsNow())].filter((v) => !coreViews.has(v));
  assert(newViews.length === 1 && newViews[0] === "thought_provenance" && communityViews.size === 1 && communityViews.has("thought_provenance"),
    `every view the files created is in the community group, as a view (${newViews.join(", ")})`);
  const seqs = (await cdb.query<{ seq: string; identity: boolean; tbl: string }>(
    `SELECT c.relname AS seq, a.attidentity <> '' AS identity, d.refobjid::regclass::text AS tbl
       FROM pg_class c
       JOIN pg_depend d ON d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace`)).rows;
  const listedSeqs = new Set(grantedSequences(["community"]));
  const serialSeqs = seqs.filter((s) => !s.identity && communityTables.has(s.tbl)).map((s) => s.seq);
  const identitySeqs = seqs.filter((s) => s.identity && communityTables.has(s.tbl)).map((s) => s.seq);
  assert(serialSeqs.length === 6 && serialSeqs.every((s) => listedSeqs.has(s)) && listedSeqs.size === serialSeqs.length,
    `the community group names exactly the bigserial sequences the files created (${serialSeqs.length}: ${serialSeqs.sort().join(", ")})`);
  assert(identitySeqs.length === 2 && identitySeqs.sort().join() === "thought_audit_seq_seq,wiki_section_revisions_id_seq" && identitySeqs.every((s) => !listedSeqs.has(s)),
    `…and not the two identity columns' — a schema's and 050's thought_audit.seq (${identitySeqs.join(", ")})`);

  // The role: created here with nothing, granted USAGE on the schema, then
  // probed as the connecting role. An INSERT of DEFAULT VALUES asks for every
  // privilege an insert needs and nothing else: it answers 42501 when the
  // table or its sequence is not granted, and some other code (23502 not-null,
  // 23503 foreign key, 23514 check) or success when they are — so the probe
  // separates the grant from the row's shape. Before any grant every community
  // table answers 42501: the drop-the-mechanism mutant, run first.
  await cdb.exec(`CREATE ROLE ob1_community NOLOGIN`);
  await cdb.exec(`GRANT USAGE ON SCHEMA public TO ob1_community`);
  const asRole = async (sql: string): Promise<{ code: string | null; message: string }> => {
    try {
      await cdb.exec(`BEGIN; SET ROLE ob1_community; ${sql}; ROLLBACK;`);
      return { code: null, message: "" };
    } catch (e) {
      try { await cdb.exec("ROLLBACK"); } catch { /* already rolled back */ }
      return { code: String((e as { code?: string }).code ?? "?"), message: (e as Error).message.split("\n")[0] };
    }
  };
  const insertCodes = async () => {
    const out = new Map<string, { code: string | null; message: string }>();
    for (const t of communityTables) out.set(t, await asRole(`INSERT INTO ${t} DEFAULT VALUES`));
    return out;
  };
  const before = await insertCodes();
  const notDenied = [...before].filter(([, r]) => r.code !== "42501").map(([t, r]) => `${t}=${r.code}`);
  assert(notDenied.length === 0, `ungranted, the role's INSERT into every community table is refused with 42501 (${before.size} tables; exceptions: ${notDenied.join(", ") || "none"})`);
  const viewBefore = await asRole(`SELECT 1 FROM thought_provenance LIMIT 0`);
  assert(viewBefore.code === "42501" && /view thought_provenance/.test(viewBefore.message), `…and so is its SELECT on the view, in the view's name (${viewBefore.code}: ${viewBefore.message})`);
  const fnOids = async (names: string[]) => (await cdb.query<{ o: number }>(`SELECT to_regprocedure('public.' || n)::oid AS o FROM unnest($1::text[]) AS u(n)`, [names])).rows.map((r) => r.o);
  const listedFns = grantedFunctions(["community"]);
  const listedOids = new Set(await fnOids(listedFns));
  const definersWithoutPublic = (await cdb.query<{ sig: string; oid: number }>(
    `SELECT p.oid::regprocedure::text AS sig, p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND NOT has_function_privilege('ob1_community', p.oid, 'EXECUTE') ORDER BY 1`)).rows;
  const unlistedFns = definersWithoutPublic.filter((f) => !listedOids.has(f.oid)).map((f) => f.sig);
  assert(definersWithoutPublic.length === listedFns.length && unlistedFns.length === 0,
    `every function the files REVOKEd FROM PUBLIC is in the community group, and nothing else is (${definersWithoutPublic.length}: ${definersWithoutPublic.map((f) => f.sig.split("(")[0]).join(", ")}; unlisted: ${unlistedFns.join(", ") || "none"})`);

  // Tables alone, first: the bigserial tables are still refused — on the
  // sequence, not the table — and the identity table is not. That is the
  // measurement db/README.md and ROLE_GRANTS.community cite for why six
  // sequences are listed and the seventh is not.
  const present = new Set(presence.map((r) => r.name));
  const statements = grantStatements("ob1_community", { groups: ["community"], present });
  const tableGrants = statements.filter((s) => !/ ON (SEQUENCE|FUNCTION) /.test(s));
  const restGrants = statements.filter((s) => / ON (SEQUENCE|FUNCTION) /.test(s));
  assert(tableGrants.length === communityTables.size + communityViews.size && restGrants.length === listedSeqs.size + listedFns.length && statements.every((s) => /TO "ob1_community";$/.test(s)) && statements.includes(`GRANT SELECT ON thought_provenance TO "ob1_community";`),
    `--grant's community statements: one per table and view (${tableGrants.length}), one per sequence and function (${restGrants.length}), the role quoted, the view granted as a table is`);
  for (const s of tableGrants) await cdb.exec(s);
  // --grant's own check of what it granted (grantVerifySql): with the tables
  // and view granted and the rest not, it reports exactly the sequence and
  // function privileges as not held, and USAGE on the schema as held — the
  // statement migrate.ts rolls back on when a grantor without grant option
  // "granted" with no effect (third review pass).
  const merged = mergedGrants(["community"], present);
  const verify = async () => (await cdb.query<{ kind: string; name: string; privilege: string; held: boolean }>(grantVerifySql("ob1_community", merged))).rows;
  const partial = await verify();
  const notHeld = partial.filter((r) => !r.held);
  assert(partial.length === 1 + merged.reduce((n, m) => n + m.privileges.length, 0) && partial[0].kind === "schema" && partial[0].held &&
         notHeld.length === listedSeqs.size * 2 + listedFns.length && notHeld.every((r) => r.kind === "sequence" || r.kind === "function") &&
         partial.filter((r) => r.kind === "table" || r.kind === "view").every((r) => r.held),
    `grantVerifySql reports one row per privilege (${partial.length}): with tables and view granted it holds every table, view and schema privilege and none of the ${notHeld.length} sequence and function ones`);
  const serialOnly = await asRole(`INSERT INTO ingestion_jobs DEFAULT VALUES`);
  assert(serialOnly.code === "42501" && /sequence ingestion_jobs_id_seq/.test(serialOnly.message), `with the tables granted and the sequences not, an INSERT into a bigserial table is refused on the sequence (${serialOnly.code}: ${serialOnly.message})`);
  const identityOnly = await asRole(`INSERT INTO wiki_section_revisions DEFAULT VALUES`);
  assert(identityOnly.code === "23502", `…and an INSERT into the identity-column table gets past privileges to its NOT NULL columns with no sequence grant (${identityOnly.code}: ${identityOnly.message})`);
  const stillDenied = [...(await insertCodes())].filter(([, r]) => r.code === "42501").map(([t]) => t).sort();
  assert(JSON.stringify(stillDenied) === JSON.stringify(["consolidation_log", "edges", "entities", "ingestion_items", "ingestion_jobs", "thought_edges"]),
    `exactly the six bigserial tables are still refused (${stillDenied.join(", ")})`);
  for (const s of restGrants) await cdb.exec(s);
  const full = await verify();
  assert(full.every((r) => r.held), `…and with the whole group granted every privilege is held (${full.filter((r) => !r.held).map((r) => `${r.privilege} on ${r.name}`).join(", ") || "none missing"})`);
  // The silent no-op the check exists for, reproduced: a role that holds
  // SELECT on a table without grant option "grants" INSERT on it to another
  // — no error — and the grantee holds nothing.
  await cdb.exec(`CREATE ROLE ob1_weak_grantor NOLOGIN; CREATE ROLE ob1_grantee NOLOGIN; GRANT USAGE ON SCHEMA public TO ob1_weak_grantor; GRANT SELECT ON crm_persons TO ob1_weak_grantor`);
  let weakError = "";
  try { await cdb.exec(`SET ROLE ob1_weak_grantor; GRANT INSERT ON crm_persons TO ob1_grantee; RESET ROLE`); } catch (e) { await cdb.exec("RESET ROLE"); weakError = (e as Error).message; }
  const [{ held: granteeHolds }] = (await cdb.query<{ held: boolean }>(`SELECT has_table_privilege('ob1_grantee', 'public.crm_persons', 'INSERT') AS held`)).rows;
  assert(weakError === "" && granteeHolds === false, `a grantor holding SELECT without grant option issues GRANT INSERT with no error and no effect (error: ${weakError || "none"}; grantee holds INSERT: ${granteeHolds}) — why --grant verifies`);
  // Both roles' privileges revoked before the drops: were the GRANT ever to
  // take effect (the assertion's own mutant), DROP ROLE ob1_grantee would
  // raise 2BP01 and abort the suite instead of leaving one recorded failure.
  await cdb.exec(`DROP OWNED BY ob1_weak_grantor, ob1_grantee; DROP ROLE ob1_weak_grantor; DROP ROLE ob1_grantee`);
  const after = await insertCodes();
  const denied = [...after].filter(([, r]) => r.code === "42501").map(([t, r]) => `${t}: ${r.message}`);
  assert(denied.length === 0, `granted the whole community group, no community table refuses the role's INSERT (${after.size} tables; still refused: ${denied.join("; ") || "none"})`);
  const unreadable: string[] = [];
  for (const t of [...communityTables, ...communityViews]) if ((await asRole(`SELECT 1 FROM ${t} LIMIT 0`)).code !== null) unreadable.push(t);
  assert(unreadable.length === 0, `…and reads every one, the view included (unreadable: ${unreadable.join(", ") || "none"})`);
  const seqDenied: string[] = [];
  for (const s of listedSeqs) if ((await asRole(`SELECT nextval('${s}')`)).code !== null) seqDenied.push(s);
  assert(seqDenied.length === 0, `…and takes a value from each listed sequence (refused: ${seqDenied.join(", ") || "none"})`);
  const fnDenied = (await cdb.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.oid = ANY($1::oid[]) AND NOT has_function_privilege('ob1_community', p.oid, 'EXECUTE')`, [[...listedOids]])).rows.map((r) => r.sig);
  assert(fnDenied.length === 0, `…and may EXECUTE every listed function (refused: ${fnDenied.join(", ") || "none"})`);
  // Upstream's append-only intent, kept: the revision history takes SELECT and
  // INSERT only, so the role cannot rewrite it.
  const rewrite = await asRole(`UPDATE wiki_section_revisions SET body_md = '' WHERE false`);
  assert(rewrite.code === "42501", `the role cannot UPDATE wiki_section_revisions — the append-only grant upstream gave its service role is kept (${rewrite.code})`);
  await cdb.close();
}

console.log("\n[41] Migration 042: a cited source is refused as a value and detached on request, a citation on a thought the same statement deletes never counts, history never blocks, the writer joins the lock order, and the shape re-applies (SMD-1712)");
{
  await restoreShipped("delete_thought");
  await db.exec(`DELETE FROM thoughts`);
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  type Env = { ok: boolean; id?: string; error?: string; cited_by?: number; citations?: { id: string; thought_id: string; stance: string; text: string }[]; detached?: number; inactive?: number };
  const thought = async (content: string) => String((await one<{ id: string }>(`SELECT upsert_thought($1, '{"metadata":{}}'::jsonb) ->> 'id' AS id`, [content])).id);
  const del = async (id: string, detach?: boolean): Promise<Env> =>
    (await one<{ r: Env }>(detach === undefined ? `SELECT delete_thought($1::uuid, NULL::jsonb) AS r` : `SELECT delete_thought($1::uuid, NULL::jsonb, $2::boolean) AS r`, detach === undefined ? [id] : [id, detach])).r;
  const cite = async (t: string, s: string, text = "a statement", stance = "retrieved"): Promise<Env> =>
    (await one<{ r: Env }>(`SELECT record_citation($1::uuid, $2::uuid, $3, $4) AS r`, [t, s, text, stance])).r;
  const exists = async (id: string) => (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts WHERE id = $1::uuid`, [id])).c === 1;
  const refuses = async (sql: string, params: unknown[] = []): Promise<string> => { try { await db.query(sql, params); return ""; } catch (e) { return (e as Error).message; } };
  const refusesExec = async (sql: string): Promise<string> => { try { await db.exec(sql); return ""; } catch (e) { return (e as Error).message; } };
  const GHOST = "00000000-0000-4000-8000-000000000000";

  // The shape: two triggers, the guard per statement over the deleted rows;
  // one delete_thought of three arguments; the function catches only the
  // guard's SQLSTATE; the lock is outside the block; the writer's order.
  const trg = await q<{ tgname: string; rel: string; tgtype: number; e: string; old_table: string | null }>(
    `SELECT tgname, tgrelid::regclass::text AS rel, tgtype, tgenabled AS e, tgoldtable AS old_table FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('thoughts_guard_citation_sources', 'thought_facets_validate') ORDER BY 1`);
  assert(trg.length === 2 && trg[0].tgname === "thought_facets_validate" && trg[0].rel === "thought_facets" && trg[1].tgname === "thoughts_guard_citation_sources" && trg[1].rel === "thoughts" && trg.every((t) => t.e === "O"),
    `the validate trigger is on thought_facets and the guard on thoughts, both enabled (${trg.map((t) => `${t.tgname}@${t.rel}`).join(", ")})`);
  // tgtype bits: 1 row-level, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  assert(Number(trg[1].tgtype) === 8 && trg[1].old_table === "deleted", `the guard fires AFTER DELETE FOR EACH STATEMENT with the deleted rows as a transition table (tgtype ${trg[1].tgtype}, old table ${trg[1].old_table})`);
  assert((Number(trg[0].tgtype) & 3) === 3 && (Number(trg[0].tgtype) & 20) === 20, `the validate trigger is BEFORE INSERT OR UPDATE FOR EACH ROW (tgtype ${trg[0].tgtype})`);
  const forms = await one<{ three: boolean; two: boolean }>(`SELECT to_regprocedure('delete_thought(uuid, jsonb, boolean)') IS NOT NULL AS three, to_regprocedure('delete_thought(uuid, jsonb)') IS NULL AS two`);
  assert((await functionsNamed("delete_thought")) === 1 && forms.three && forms.two && lastDefinerOf("delete_thought").startsWith("042"), `one delete_thought, of three arguments, the two-argument form dropped (${lastDefinerOf("delete_thought")})`);
  const src = String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'delete_thought(uuid, jsonb, boolean)'::regprocedure`)).s);
  // The one EXCEPTION clause names the one SQLSTATE; the body's comments may
  // mention foreign_key_violation as what it does NOT catch.
  const caught = src.slice(src.indexOf("DELETE FROM thoughts WHERE id = p_id")).match(/EXCEPTION\s+WHEN\s+(.+?)\s+THEN/)?.[1];
  const clauses = [...src.matchAll(/EXCEPTION\s+WHEN\s+(.+?)\s+THEN/g)].map((m) => m[1]);
  assert(caught === "SQLSTATE 'OB001'" && clauses.filter((c) => c !== "SQLSTATE 'OB001'").every((c) => c === "OTHERS") && /v_json := v_detail::jsonb;\s+EXCEPTION WHEN OTHERS THEN/.test(src),
    `the DELETE's block catches the guard's own SQLSTATE and nothing else — a real foreign-key failure is not its to answer — and the only other handler is the detail parse's (${clauses.join(" | ") || "no EXCEPTION clause"})`);
  assert(src.indexOf("pg_advisory_xact_lock(hashtext('ob1:supersession-review'))") > 0 && src.indexOf("pg_advisory_xact_lock") < src.indexOf("  BEGIN\n    DELETE FROM thoughts WHERE id = p_id") && /GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL/.test(src),
    "the supersession lock is taken before the block the DELETE runs in, so a refusal's rollback does not release it — and the refusal's detail is read from the error, not re-read");
  const idx = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'thought_facets' ORDER BY 1`);
  assert(idx.some((i) => /\(\(payload ->> 'source_id'::text\)\)/.test(i.indexdef) && /WHERE \(kind = 'citation'::text\)/.test(i.indexdef)), `the guard's lookup has its partial expression index (${idx.map((i) => i.indexdef.replace(/^CREATE INDEX /, "").split(" ON ")[0]).join(", ")})`);
  const w = String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'record_citation(uuid, uuid, text, text)'::regprocedure`)).s);
  assert(w.indexOf("pg_advisory_xact_lock(hashtext('ob1:supersession-review'))") > 0 && w.indexOf("pg_advisory_xact_lock") < w.indexOf("INSERT INTO thought_facets"), "record_citation takes the supersession lock before its INSERT — the writers' order");
  const v = String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'thought_facets_validate()'::regprocedure`)).s);
  assert(/FROM thoughts WHERE id = v_source::uuid FOR KEY SHARE/.test(v), "the validate trigger locks the source KEY SHARE, as a foreign key would");

  // Refuse, as a value; nothing written.
  const S = await thought("the source: the API allows 600 calls a minute");
  const C = await thought("the note: the ceiling is 500 because of the limit");
  const wrote = await cite(C, S, "the limit is 600 a minute");
  assert(wrote.ok === true && typeof wrote.id === "string", `record_citation writes the row (${JSON.stringify(wrote)})`);
  const refused = await del(S);
  assert(refused.ok === false && refused.error === "CITED" && refused.id === S && refused.cited_by === 1 && refused.citations?.length === 1 && refused.citations[0].thought_id === C && refused.citations[0].stance === "retrieved" && refused.citations[0].text === "the limit is 600 a minute",
    `deleting the source is refused as CITED with the count and the citing row (${JSON.stringify(refused)})`);
  assert((await exists(S)) && (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = $1::uuid AND action = 'delete'`, [S])).c === 0, "…the source stands and no audit delete row was written");
  const ghost = await del(GHOST);
  assert(ghost.ok === false && ghost.error === "NOT_FOUND", `a two-argument call resolves through the default, and a missing row is still NOT_FOUND (${JSON.stringify(ghost)})`);
  assert((await cite(C, C)).error === "SELF_CITATION" && (await cite(C, S, "x", "guessed")).error === "BAD_STANCE" && (await cite(C, S, "   ")).error === "EMPTY_TEXT" && (await cite(C, GHOST)).error === "SOURCE_NOT_FOUND" && (await cite(GHOST, S)).error === "NOT_FOUND",
    "record_citation refuses a self-citation, a stance outside the three, an empty text, a ghost source and a ghost thought, each by name");
  // Detach: the row goes, the citation keeps its text and records the source.
  const detached = await del(S, true);
  assert(detached.ok === true && detached.detached === 1 && detached.inactive === undefined && !(await exists(S)), `with p_detach the source is deleted and one citation detached (${JSON.stringify(detached)})`);
  const facet = (await one<{ payload: Record<string, unknown> }>(`SELECT payload FROM thought_facets WHERE thought_id = $1::uuid`, [C])).payload;
  assert(facet.source_id === null && facet.source_deleted_id === S && typeof facet.source_deleted_at === "string" && facet.text === "the limit is 600 a minute" && facet.stance === "retrieved", `the citation keeps its text and stance and records the deleted source (${JSON.stringify(facet)})`);
  assert((await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = $1::uuid AND action = 'delete'`, [S])).c === 1, "…and the delete is audited — the settings were made outside the block the refusal rolls back");
  assert(/must be a thought id \(null only with source_deleted_id/.test(await refuses(`UPDATE thought_facets SET payload = payload - 'source_deleted_id' WHERE thought_id = $1::uuid`, [C])), "the detached shape needs source_deleted_id — a citation cannot simply lose its source");
  assert((await del(C)).ok === true && (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_facets`)).c === 0, "deleting the citing thought cascades its facets");

  // History never blocks, and is marked when the source goes.
  const S2 = await thought("a second source with only stale citations");
  const C2 = await thought("a note whose citations of the second source are history");
  const expired = (await cite(C2, S2, "an old claim")).id!;
  await db.query(`UPDATE thought_facets SET valid_until = now() - interval '1 day' WHERE id = $1::uuid`, [expired]);
  const replaced = (await cite(C2, S2, "a replaced claim")).id!;
  const replacing = (await cite(C2, S2, "the replacing claim")).id!;
  await db.query(`UPDATE thought_facets SET superseded_by = $2::uuid WHERE id = $1::uuid`, [replaced, replacing]);
  const oneActive = await del(S2);
  assert(oneActive.error === "CITED" && oneActive.cited_by === 1 && oneActive.citations?.[0].text === "the replacing claim", `only the active citation counts and is sampled (${JSON.stringify(oneActive)})`);
  await db.query(`UPDATE thought_facets SET valid_until = now() - interval '1 hour' WHERE id = $1::uuid`, [replacing]);
  const clean = await del(S2);
  assert(clean.ok === true && clean.detached === 0 && clean.inactive === 3, `with every citation expired or superseded the delete goes through and says three were marked (${JSON.stringify(clean)})`);
  const marked = await q<{ s: string | null; d: string }>(`SELECT payload->>'source_id' AS s, payload->>'source_deleted_id' AS d FROM thought_facets WHERE thought_id = $1::uuid`, [C2]);
  assert(marked.length === 3 && marked.every((m) => m.s === null && m.d === S2), "…and all three record the deleted source, so no row names a thought that is gone");
  assert(/violates check constraint/.test(await refuses(`UPDATE thought_facets SET superseded_by = id WHERE id = $1::uuid`, [replacing])), "a facet cannot supersede itself");
  // The detached shape is the guard's alone: a raw UPDATE cannot detach a live
  // citation, name another thought as the one deleted, or write a time that is
  // not one; a row the guard detached can still be edited but keeps what it lost.
  const live = await thought("a live source someone tries to detach by hand");
  const liveNote = await thought("the note resting on the live source");
  await cite(liveNote, live, "rests on a live source");
  assert(/detached only when its source is gone; thought/.test(await refuses(`UPDATE thought_facets SET payload = payload || jsonb_build_object('source_id', NULL, 'source_deleted_id', $2::uuid, 'source_deleted_at', now()) WHERE thought_id = $1::uuid`, [liveNote, live])),
    "a raw UPDATE cannot detach a citation whose source still exists");
  assert(/detached only from the source it had/.test(await refuses(`UPDATE thought_facets SET payload = payload || jsonb_build_object('source_id', NULL, 'source_deleted_id', $2::uuid, 'source_deleted_at', now()) WHERE thought_id = $1::uuid`, [liveNote, GHOST])),
    "…nor name another thought as the one deleted");
  assert(/source_deleted_at must be a timestamp/.test(await refuses(`UPDATE thought_facets SET payload = payload || '{"source_id":null,"source_deleted_at":"soon"}'::jsonb || jsonb_build_object('source_deleted_id', $2::uuid) WHERE thought_id = $1::uuid`, [liveNote, live])),
    "…nor write a time that is not one");
  // A detached row arrives whole — a restore, an import — under the same checks:
  // the thought it lost must be gone.
  assert((await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 'restored', 'stance', 'stated', 'source_id', NULL, 'source_deleted_id', $2::uuid, 'source_deleted_at', now()))`, [liveNote, S])) === "",
    "a detached citation can be inserted whole — a restore keeps the history the detach kept");
  // …and one naming a thought that exists as its deleted source is re-attached
  // to it on arrival: whether a restore that brought the thoughts back first
  // or a forgery, what lands is a live citation of a live thought, which any
  // writer could have inserted — nothing false remains.
  assert((await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 'forged', 'stance', 'stated', 'source_id', NULL, 'source_deleted_id', $2::uuid, 'source_deleted_at', now()))`, [liveNote, live])) === "" &&
           (await one<{ payload: Record<string, unknown> }>(`SELECT payload FROM thought_facets WHERE thought_id = $1::uuid AND payload->>'text' = 'forged'`, [liveNote])).payload.source_id === live,
    "…and one naming a live thought as its deleted source arrives as a live citation of it, the deletion keys gone");
  assert((await refuses(`UPDATE thought_facets SET valid_until = now() WHERE thought_id = $1::uuid`, [C2])) === "" && (await del(live)).error === "CITED",
    "a citation the guard detached can still be edited and keeps its shape, and the live source is still refused");
  assert(/keeps the source it lost/.test(await refuses(`UPDATE thought_facets SET payload = payload || jsonb_build_object('source_deleted_id', $2::uuid) WHERE thought_id = $1::uuid`, [C2, GHOST])), "…but a detached citation cannot be re-pointed at a different lost source");
  // A raw writer's upper-case source id is stored canonical, so the guard's compare finds it.
  const upper = await thought("a source cited in upper case");
  const upperNote = await thought("the note that spells the id in upper case");
  await db.query(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 't', 'stance', 'stated', 'source_id', upper($2::text)))`, [upperNote, upper]);
  assert((await one<{ s: string }>(`SELECT payload->>'source_id' AS s FROM thought_facets WHERE thought_id = $1::uuid`, [upperNote])).s === upper, "an upper-case source_id from a raw writer is stored canonical");
  assert((await del(upper)).error === "CITED" && (await exists(upper)), "…so the guard finds the citation and refuses the source's delete");
  // A detached citation is not re-pointed: the reverse transition would leave
  // the deletion keys beside a live source.
  assert(/is not re-pointed at a new source/.test(await refuses(`UPDATE thought_facets SET payload = payload || jsonb_build_object('source_id', $2::uuid) WHERE thought_id = $1::uuid AND payload->>'text' = 'an old claim'`, [C2, upper])), "a detached citation cannot be given a new source — that is a new citation");
  // …but it follows its own source back when 008/009's recovery restores that
  // thought under its id: re-attached, the deletion keys gone with the deletion.
  await db.query(`INSERT INTO thoughts (id, content, metadata) VALUES ($1::uuid, 'the second source, restored from the audit trail', '{}'::jsonb)`, [S2]);
  assert((await refuses(`UPDATE thought_facets SET payload = payload || jsonb_build_object('source_id', $2::uuid) WHERE thought_id = $1::uuid AND payload->>'text' = 'an old claim'`, [C2, S2])) === "",
    "a detached citation is re-attached to the source it lost once that thought exists again");
  const reattached = (await one<{ payload: Record<string, unknown> }>(`SELECT payload FROM thought_facets WHERE thought_id = $1::uuid AND payload->>'text' = 'an old claim'`, [C2])).payload;
  assert(reattached.source_id === S2 && !("source_deleted_id" in reattached) && !("source_deleted_at" in reattached), `…and the deletion keys are gone with the deletion (${JSON.stringify(reattached)})`);
  // A detached row inserted whole whose lost source exists again (S2, restored above) is re-attached to it, as the UPDATE path does.
  await db.query(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 'restored after its source', 'stance', 'stated', 'source_id', NULL, 'source_deleted_id', $2::uuid, 'source_deleted_at', now()))`, [liveNote, S2]);
  const restoredWhole = (await one<{ payload: Record<string, unknown> }>(`SELECT payload FROM thought_facets WHERE thought_id = $1::uuid AND payload->>'text' = 'restored after its source'`, [liveNote])).payload;
  assert(restoredWhole.source_id === S2 && !("source_deleted_id" in restoredWhole), `a detached row inserted whole after its source was restored is re-attached to it (${JSON.stringify(restoredWhole)})`);
  // A live citation carries no deletion keys, written or added.
  assert(/carries no source_deleted_id or source_deleted_at/.test(await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 'forged history', 'stance', 'stated', 'source_id', $2::uuid, 'source_deleted_id', $3::uuid, 'source_deleted_at', now()))`, [liveNote, live, GHOST])), "a live citation cannot be inserted with deletion keys beside its source");
  assert(/carries no source_deleted_id or source_deleted_at/.test(await refuses(`UPDATE thought_facets SET payload = payload || jsonb_build_object('source_deleted_id', $2::uuid) WHERE thought_id = $1::uuid AND payload->>'text' = 'rests on a live source'`, [liveNote, GHOST])), "…nor given them by a raw UPDATE");
  // A detached row inserted whole with an upper-case deleted id is stored canonical, as a live source_id is.
  await db.query(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 'restored in caps', 'stance', 'stated', 'source_id', NULL, 'source_deleted_id', upper($2::text), 'source_deleted_at', now()))`, [liveNote, S]);
  assert((await one<{ d: string }>(`SELECT payload->>'source_deleted_id' AS d FROM thought_facets WHERE thought_id = $1::uuid AND payload->>'text' = 'restored in caps'`, [liveNote])).d === S, "an upper-case source_deleted_id on a restored row is stored canonical");
  // A detach changes the citing thought's record: its updated_at moves, so a
  // reader holding an older if_unchanged_since is told STALE_READ, not let through.
  const U1 = await thought("a source whose detach moves the note's clock");
  const UN = await thought("the note whose clock moves");
  await cite(UN, U1, "clocked");
  const clockBefore = (await one<{ u: string }>(`SELECT updated_at::text AS u FROM thoughts WHERE id = $1::uuid`, [UN])).u;
  await db.query(`SELECT pg_sleep(0.02)`);
  assert((await del(U1, true)).detached === 1 && (await one<{ u: string }>(`SELECT updated_at::text AS u FROM thoughts WHERE id = $1::uuid`, [UN])).u > clockBefore, "detaching a note's citation moves the note's updated_at");
  // …but marking an expired one is history's bookkeeping: a plain delete of a
  // source cited only in the past leaves the note's clock alone.
  const U2 = await thought("a source cited only in the past");
  const expiredF = (await cite(UN, U2, "once")).id!;
  await db.query(`UPDATE thought_facets SET valid_until = now() - interval '1 day' WHERE id = $1::uuid`, [expiredF]);
  const clockAfter = (await one<{ u: string }>(`SELECT updated_at::text AS u FROM thoughts WHERE id = $1::uuid`, [UN])).u;
  await db.query(`SELECT pg_sleep(0.02)`);
  const past = await del(U2);
  assert(past.ok === true && past.inactive === 1 && (await one<{ u: string }>(`SELECT updated_at::text AS u FROM thoughts WHERE id = $1::uuid`, [UN])).u === clockAfter, `deleting a source with only an expired citation marks it and leaves the note's updated_at where it was (${JSON.stringify(past)})`);
  // superseded_by's SET NULL has an index to find the pointing rows by.
  assert(idx.some((i) => /thought_facets_superseded_by_idx/.test(i.indexdef) && /\(superseded_by\)/.test(i.indexdef) && /WHERE \(superseded_by IS NOT NULL\)/.test(i.indexdef)), "the superseder pointer has its partial index, so the SET NULL cascade probes instead of scanning");
  // delete_thought puts the caller's running totals back with its own added: a
  // raw detach transaction that calls it in the middle keeps the sum.
  const T1 = await thought("total one"), T2 = await thought("total two"), T3 = await thought("total three"), TN = await thought("the note citing all three");
  await cite(TN, T1, "one"); await cite(TN, T2, "two"); await cite(TN, T3, "three");
  await db.exec(`BEGIN; SELECT set_config('ob1.cited_delete', 'detach', true); SELECT set_config('ob1.citations_detached', '0', true); DELETE FROM thoughts WHERE id IN ('${T1}', '${T2}'); SELECT delete_thought('${T3}'::uuid, NULL::jsonb, true); CREATE TEMP TABLE zz_1712_sum AS SELECT current_setting('ob1.citations_detached', true) AS n; COMMIT`);
  assert((await one<{ n: string }>(`SELECT n FROM zz_1712_sum`)).n === "3", "a raw detach of two sources and a delete_thought of a third in one transaction total 3 — the call adds its own to the caller's, not over it");
  await db.exec(`DROP TABLE zz_1712_sum`);

  // Thirteen: the count is the whole, the sample ten.
  const S3 = await thought("a source thirteen notes cite");
  for (let i = 0; i < 13; i++) await cite(await thought(`citing note number ${i} of thirteen`), S3, `statement ${i}`);
  const many = await del(S3);
  assert(many.error === "CITED" && many.cited_by === 13 && many.citations?.length === 10 && new Set(many.citations.map((c) => c.id)).size === 10, `thirteen citations: cited_by 13, ten distinct rows sampled (${many.citations?.length})`);

  // One statement, the note and its source together: nothing survives resting
  // on nothing → clean, whatever the row order; a third thought's citation
  // refuses it and the statement writes nothing.
  const S4 = await thought("source deleted together with its note");
  const C4 = await thought("note deleted together with its source");
  await cite(C4, S4, "together");
  const C5 = await thought("a note that survives, citing the same source");
  await cite(C5, S4, "survives");
  assert(/is cited as a source by 1 active citation\(s\) on thoughts this delete leaves standing/.test(await refuses(`DELETE FROM thoughts WHERE id IN ($1::uuid, $2::uuid)`, [S4, C4])) && (await exists(S4)) && (await exists(C4)),
    "deleting note and source together while a third thought cites the source is refused, and the statement wrote nothing");
  await db.query(`DELETE FROM thoughts WHERE id = $1::uuid`, [C5]);
  assert((await refuses(`DELETE FROM thoughts WHERE id IN ($1::uuid, $2::uuid)`, [S4, C4])) === "" && !(await exists(S4)) && !(await exists(C4)), "…with the survivor gone, note and source delete together in one statement");
  // Two cited sources in one raw detach statement: one total, each citation its own source.
  const S5 = await thought("source five");
  const S6 = await thought("source six");
  const C6 = await thought("a note citing five and six");
  await cite(C6, S5, "five");
  await cite(C6, S6, "six");
  await db.exec(`BEGIN; SELECT set_config('ob1.cited_delete', 'detach', true); SELECT set_config('ob1.citations_detached', '0', true); DELETE FROM thoughts WHERE id IN ('${S5}', '${S6}'); CREATE TEMP TABLE zz_1712_total AS SELECT current_setting('ob1.citations_detached', true) AS n; COMMIT`);
  const total = (await one<{ n: string }>(`SELECT n FROM zz_1712_total`)).n;
  const perSource = await q<{ d: string }>(`SELECT payload->>'source_deleted_id' AS d FROM thought_facets WHERE thought_id = $1::uuid`, [C6]);
  assert(total === "2" && perSource.length === 2 && new Set(perSource.map((p) => p.d)).size === 2 && !(await exists(S5)) && !(await exists(S6)), `a raw detach of two cited sources in one statement totals 2 and each citation records its own source (${total})`);
  await db.exec(`DROP TABLE zz_1712_total`);
  // The guard is the table's: a raw DELETE meets it; a mode that is neither is refused by name.
  const S7 = await thought("raw-deleted source");
  await cite(await thought("raw note"), S7);
  assert(/is cited as a source by 1 active citation/.test(await refuses(`DELETE FROM thoughts WHERE id = $1::uuid`, [S7])) && (await exists(S7)), "a raw DELETE meets the same refusal — the guard is the table's, not the function's");
  assert(/must be refuse or detach, got 'sometimes'/.test(await refusesExec(`BEGIN; SELECT set_config('ob1.cited_delete', 'sometimes', true); DELETE FROM thoughts WHERE id = '${S7}'; COMMIT`)), "a mode that is neither is refused by name");
  await db.exec(`ROLLBACK`);
  assert((await exists(S7)), "…and nothing was deleted under it");
  // Raw insert shapes the trigger refuses without the writer.
  assert(/is not a registered facet kind/.test(await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'procedure', '{}')`, [S7])), "an unregistered kind is refused by name");
  assert(/must be a thought id/.test(await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', '{"text":"t","stance":"stated"}')`, [S7])), "a citation without a source is refused");
  assert(/must be a JSON object, got array/.test(await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', '[1]')`, [S7])), "a payload that is not an object is refused before any key is read");
  assert(/is not a thought/.test(await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', '{"text":"t","stance":"stated","source_id":"${GHOST}"}')`, [S7])), "a raw insert naming a ghost source is refused by the trigger, not only by the writer");
  assert(/cannot cite itself/.test(await refuses(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', jsonb_build_object('text', 't', 'stance', 'stated', 'source_id', $1::uuid))`, [S7])), "…and a raw self-citation likewise");
  // A real foreign-key failure is a fault, not CITED.
  await db.exec(`CREATE TABLE zz_1712_pin (thought_id uuid REFERENCES thoughts(id))`);
  const S8 = await thought("a thought a foreign table pins");
  await db.query(`INSERT INTO zz_1712_pin VALUES ($1::uuid)`, [S8]);
  assert(/violates foreign key constraint "zz_1712_pin_thought_id_fkey"/.test(await refuses(`SELECT delete_thought($1::uuid, NULL::jsonb)`, [S8])) && (await exists(S8)), "a foreign-key violation on the DELETE propagates as the fault it is");
  await db.exec(`DROP TABLE zz_1712_pin`);

  // The guard judges the state the statement LEAVES: deleting the citing
  // thought of a replacing facet in the same statement as the source clears
  // the replaced facet's superseded_by (SET NULL, a row-level action that runs
  // first) and revives it — a surviving note then rests on the deleted source,
  // so the statement is refused, and the SET NULL is rolled back with it; with
  // that note in the statement too, clean.
  const S9 = await thought("a source whose replacing citer goes with it");
  const C9a = await thought("the note with the replaced citation");
  const C9b = await thought("the note with the replacing citation");
  const oldF = (await cite(C9a, S9, "the replaced statement")).id!;
  const newF = (await cite(C9b, S9, "the replacing statement")).id!;
  await db.query(`UPDATE thought_facets SET superseded_by = $2::uuid WHERE id = $1::uuid`, [oldF, newF]);
  assert(/1 active citation/.test(await refuses(`DELETE FROM thoughts WHERE id IN ($1::uuid, $2::uuid)`, [S9, C9b])) && (await exists(S9)) && (await exists(C9b)) &&
           (await one<{ s: string | null }>(`SELECT superseded_by AS s FROM thought_facets WHERE id = $1::uuid`, [oldF])).s === newF,
    "deleting the source with its replacing citer revives the replaced citation on a surviving note — refused, the SET NULL rolled back with the statement");
  assert((await refuses(`DELETE FROM thoughts WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`, [S9, C9a, C9b])) === "" && !(await exists(S9)), "…and with both notes in the statement, clean");
  // delete_thought's mode is the call's, not the transaction's: a raw DELETE
  // after a detaching call in the same transaction meets the default again.
  const S10 = await thought("detached by the call");
  const S11 = await thought("cited, deleted raw after it");
  const C10 = await thought("a note citing both");
  await cite(C10, S10, "ten");
  await cite(C10, S11, "eleven");
  const leak = await refusesExec(`BEGIN; SELECT delete_thought('${S10}'::uuid, NULL::jsonb, true); DELETE FROM thoughts WHERE id = '${S11}'; COMMIT`);
  await db.exec(`ROLLBACK`);
  assert(/is cited as a source by 1 active citation/.test(leak) && (await exists(S10)) && (await exists(S11)),
    "a raw DELETE after a detaching delete_thought in one transaction is refused — the call put the mode back — and the rollback keeps both");
  // …and a caller's own detach setting survives a refuse-mode call inside it:
  // the call is refused on its own mode (a value, the transaction continues),
  // then the raw DELETE that follows runs on the caller's and detaches.
  const kept = await refusesExec(`BEGIN; SELECT set_config('ob1.cited_delete', 'detach', true); SELECT delete_thought('${S10}'::uuid, NULL::jsonb, false); DELETE FROM thoughts WHERE id = '${S11}'; COMMIT`);
  assert(kept === "" && (await exists(S10)) && !(await exists(S11)) &&
           (await one<{ d: string | null }>(`SELECT payload->>'source_deleted_id' AS d FROM thought_facets WHERE thought_id = $1::uuid AND payload->>'text' = 'eleven'`, [C10])).d === S11,
    "…and a caller's own detach setting is put back after a refuse-mode call: that call is refused, the raw DELETE after it detaches");

  // Re-applying 042 changes nothing: one function, two triggers, every row kept.
  const before = (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_facets`)).c;
  await reapply("042");
  await reapply("042");
  const again = await q<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('thoughts_guard_citation_sources', 'thought_facets_validate')`);
  assert(again.length === 2 && (await functionsNamed("delete_thought")) === 1 && before > 0 && (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_facets`)).c === before, `042 re-applied twice leaves two triggers, one delete_thought and every facet row (${before})`);
  // 042's file put 042's validator back; the shipped one is 053's (the `link` kind) — restored for the sections after.
  await restoreShipped("thought_facets_validate");
  // A reset of the whole table: every citing thought goes with its source, so nothing survives and the statement is clean.
  await db.exec(`DELETE FROM thoughts`);
  assert((await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_facets`)).c === 0, "DELETE FROM thoughts with citations among the rows is clean — nothing survives to rest on nothing — and the facets cascade");
}

console.log("\n[42] Migration 043: query_log.tool's two shapes, and the table's cite clause, are stated at the table in the live text (SMD-1749)");
{
  // 034 commented the table and not the column: the three action names were a
  // SQL comment in the file, invisible to a reader of the live table, and the
  // table's text said fetch/edit/delete. SMD-1719 (change 90) made
  // `<writer>/<pointer>` a cite — a write that named the target as its source
  // and the pointer was accepted — and utilization.ts splits cited from opened
  // on the first slash. A reader of the table (\d+, a future writer of action rows,
  // an operator auditing what personal data the table holds) must be able to
  // learn both shapes from the table, so both comments are asserted here
  // rather than trusted to prose — of the LIVE text after every file applied,
  // so a later migration that re-comments either and re-issues 034's text
  // drops the clause and fails here whichever file it is; no number pinned.
  const colComment = (await db.query<{ c: string | null }>(COLUMN_COMMENT_SQL, ["query_log", "tool"])).rows[0]?.c ?? "";
  const tblComment = (await db.query<{ c: string | null }>(TABLE_COMMENT_SQL, ["query_log"])).rows[0]?.c ?? "";
  assert(colComment.length > 0, "query_log.tool carries a comment (034 wrote none)");
  assert(/<writer>\/<pointer>/.test(colComment) && /<writer>\/<pointer>/.test(tblComment), "both comments name <writer>/<pointer>");
  // Each shape anchored inside its own sentence ([^.]*, not a dot-all span
  // that reaches the other sentence), so a re-issue that inverts the two
  // meanings fails here (second review pass).
  assert(/plain tool name[^.]*is an OPEN/.test(colComment) && /<writer>\/<pointer>[^.]*is a CITE/.test(colComment),
    "…the column's gives both shapes, each in its own sentence: a plain name is an open, a slashed name a cite");
  assert(/named the target as its source and the database accepted the pointer/.test(colComment), "…and what a cite is: the writer named the target as its source, and the database accepted the pointer");
  assert(/any value with a non-empty name either side of its first slash is a cite, whatever the writer/.test(colComment) && /a slash at either end is not a cite/.test(colComment),
    "…the rule as the column's — a non-empty name either side of the first slash is a cite, a slash at either end is not (citePointerOf's rule, [39])");
  assert(/Neither this server's tool names nor the MCP tool-name grammar \(\[A-Za-z0-9._-\]\) carry a slash/.test(colComment) && /would be read as a cite/.test(colComment) && /OPEN_TOOLS/.test(colComment),
    "…why the shapes do not collide here, stated as this server's rule and not a protocol guarantee, with what a foreign slashed name would read as and where an unknown plain name is reported");
  assert(/server-portable\/index\.ts/.test(colComment) && /evals\/utilization\.ts/.test(colComment),
    "…and sends a reader to index.ts and utilization.ts for when a cite is logged and how it is attributed, rather than restating them");
  // The values the comment names are the ones index.ts writes today, and [39]
  // already drives each through the reader; this section asks only that the
  // applied text names them — as the two enumerated lists beside their
  // shapes, not as words somewhere in the prose ("follow-up fetch" would
  // satisfy a word search; second review pass). Hard-coded as [39] hard-codes
  // them: a renamed writer that stranded the applied text fails here, and the
  // fix is a migration that re-comments, not an edit (a first pass had these
  // re-assert the reader's results too, a second copy of [39]'s tooth).
  assert(colComment.includes("(capture_thought/derived_from, capture_thought/supersedes, update_thought/supersedes) is a CITE"),
    "…names the three cite values written today as one list beside their shape");
  assert(colComment.includes("(fetch, update_thought, delete_thought) is an OPEN"),
    "…and the three plain names as one list beside theirs");
  // 034's table text, whole — the opt-in flag, the personal-data sentence, the
  // export-time link and the pruning — so a successor that keeps only the
  // cite clause is caught too.
  for (const sentence of [
    "Opt-in (OB1_QUERY_LOG=on), off by default",
    "one per follow-up fetch/edit/delete of a returned id",
    "Personal data at rest — every query typed",
    "the write is best-effort and never fails a search",
    "linked to its search at export time by (agent_id, target_id, time window), not at write time",
    "Pruned by prune_query_log(); default retention 30 days (OB1_QUERY_LOG_RETENTION_DAYS)",
  ]) assert(tblComment.includes(sentence), `the table's comment keeps 034's text: "${sentence.slice(0, 40)}…"`);
  assert(/or a write that cited a returned id as its source/.test(tblComment) && /SMD-1719/.test(tblComment), "…and adds the cite beside fetch/edit/delete, naming the ticket");
  // 028's convention for a COMMENT literal, from when [10]'s scan stripped `--`
  // to end of line; the scan is literal-aware since change 93 (SMD-1796), so
  // nothing depends on it now, and it is kept as the convention — asserted of
  // the LIVE text, so it holds whichever file wrote it.
  assert(!/--/.test(colComment) && !/--/.test(tblComment), "neither comment carries `--` — 028's convention for a COMMENT literal, kept");

  // The shape the comment describes is one the table admits: 034's only
  // constraint on the column is tool <> '', so a cite row lands as written and
  // reads back as a cite. [34] and [39] exercise the join and the split.
  const T = "33333333-3333-4333-8333-333333333333";
  const cite = (await db.query<{ id: string; tool: string }>(
    `INSERT INTO query_log (kind, tool, target_id) VALUES ('action', 'capture_thought/derived_from', $1) RETURNING id, tool`, [T])).rows[0];
  assert(citePointerOf(cite.tool) === "derived_from", "a cite row inserted under the documented shape reads back as a cite with its pointer");
  await db.query(`DELETE FROM query_log WHERE id = $1`, [cite.id]);
}

console.log("\n[43] Migration 046: the event shape at the write boundary — who from the key, the door, the ceiling on the content, stance, cites, the window; immutable by rule (SMD-1730)");
{
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const refused = async (sql: string, params: unknown[] = []) => { try { await db.query(sql, params); return ""; } catch (e) { return (e as Error).message; } };
  type Ev = { actor_name: string | null; canonical_agent_id: string | null; actor_kind: string | null; trust: string | null; origin: string | null; source: string | null;
              stance: string | null; cites: string[] | null; valid_from: string | null; valid_until: string | null; backfilled_at: string | null; actor_context: Record<string, unknown> | null };
  const EV = "actor_name, canonical_agent_id, actor_kind, trust, origin, source, stance, cites, valid_from::text AS valid_from, valid_until::text AS valid_until, backfilled_at::text AS backfilled_at, actor_context";
  const rowsOf = async (id: string, action: string) => q<Ev>(`SELECT ${EV} FROM thought_audit WHERE thought_id = $1::uuid AND action = $2 ORDER BY created_at`, [id, action]);
  const last = async (id: string, action: string) => { const r = await rowsOf(id, action); return r[r.length - 1]; };
  const cap = async (content: string, envelope: Record<string, unknown>, at = 1) =>
    (await one<{ r: { id: string; existed: boolean } }>(`SELECT upsert_thought($1::text, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(envelope), unit(at)])).r;
  const edit = async (id: string, content: string | null, actor: Record<string, unknown> | null, event: Record<string, unknown> | null) =>
    (await one<{ r: { ok: boolean; error?: string } }>(
      `SELECT update_thought($1::uuid, $2::text, NULL, NULL, NULL, NULL, $3::jsonb, NULL, NULL, $4::jsonb) AS r`,
      [id, content, actor === null ? null : JSON.stringify(actor), event === null ? null : JSON.stringify(event)])).r;
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_agents`);

  // The shape: eight nullable columns, the CHECKs, the two indexes, the kind on
  // the registry, and the last definers this file takes over.
  const cols = await q<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'thought_audit'
      AND column_name IN ('actor_kind', 'trust', 'origin', 'stance', 'cites', 'valid_from', 'valid_until', 'backfilled_at') ORDER BY column_name`);
  assert(cols.length === 8 && cols.every((c) => c.is_nullable === "YES"), `thought_audit gains eight nullable columns (${cols.map((c) => c.column_name).join(", ")})`);
  assert(cols.find((c) => c.column_name === "cites")?.data_type === "ARRAY" && cols.filter((c) => /^valid_|backfilled_at/.test(c.column_name)).every((c) => c.data_type === "timestamp with time zone"),
    "…cites a uuid[], the window and backfilled_at timestamptz");
  assert((await one<{ e: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ob1_agents' AND column_name = 'kind') AS e`)).e, "ob1_agents gains kind");
  assert(/ob1_agents_kind_check/.test(await refused(`INSERT INTO ob1_agents (label, kind) VALUES ('robot-key', 'robot')`)), "…which the CHECK holds to operator, agent or ingested");
  const idx = await q<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'thought_audit' AND indexname LIKE 'thought_audit_%' AND indexname NOT IN ('thought_audit_thought_id_idx', 'thought_audit_created_at_idx', 'thought_audit_actor_idx', 'thought_audit_session_idx', 'thought_audit_agent_idx', 'thought_audit_pkey')`);
  assert(idx.length === 3 && idx.map((i) => i.indexname).sort().join(",") === "thought_audit_awaiting_door_idx,thought_audit_awaiting_kind_idx,thought_audit_awaiting_payload_idx",
    `three partial indexes and no more: the rows still waiting for a kind or a trust, by name, for a door, and (055) for their payload — the census, the backfills and the gate read them; none on actor_kind, trust or origin until a read exists (${idx.map((i) => i.indexname).join(", ")})`);
  assert(/INCLUDE \(canonical_agent_id, actor_kind\)/.test(idx.find((i) => i.indexname === "thought_audit_awaiting_kind_idx")?.indexdef ?? "") && /WHERE \(\(origin IS NULL\) AND \(actor_context \? 'via'::text\) AND \(ob1_door_of\(actor_context\) IS NOT NULL\)\)/.test(idx.find((i) => i.indexname === "thought_audit_awaiting_door_idx")?.indexdef ?? ""),
    `…the kind index carrying the agent id and the kind so the census filters and groups without the heap, the door index holding only rows whose via IS a door, by the one reading (seventh review pass; ${idx.map((i) => i.indexdef.replace(/.*USING btree /, "")).join(" | ")})`);
  assert(lastDefinerOf("thoughts_write_audit").startsWith("055") && lastDefinerOf("thought_audit_refuse_mutation").startsWith("055") && lastDefinerOf("upsert_thought").startsWith("046") && lastDefinerOf("update_thought").startsWith("046") && lastDefinerOf("delete_thought").startsWith("042"),
    `046 is the last definer of both writers; 055 of the audit trigger and the refusal trigger (046's bodies with the rules as functions and the payload arm — [51]); delete_thought stays 042's — a tombstone declares nothing (${lastDefinerOf("delete_thought")})`);
  const tbl = (await one<{ c: string | null }>(TABLE_COMMENT_SQL, ["thought_audit"])).c ?? "";
  assert(/RANGE on created_at by month/.test(tbl) && /not applied/.test(tbl) && /SMD-1697/.test(tbl), "the table's comment states the partition key chosen and not applied, and what decides when");
  const src = async (sig: string) => String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).s);
  const trig = await src("thoughts_write_audit()");
  // 055 (SMD-2115) lifts 046's tail into ob1_append_thought_event; the rule
  // and its sentinel stand there, and the trigger names the sentinel and
  // calls the function — so the pins below read the function's source.
  const tail = await src("ob1_append_thought_event(uuid, text, text, jsonb, jsonb)");
  assert(/ob1:audit-event-from-the-key/.test(trig) && /PERFORM ob1_append_thought_event\(v_id, v_action, v_source, v_diff, event\)/.test(trig), "the trigger names 046's sentinel and appends through ob1_append_thought_event (055)");
  assert(/ob1:audit-event-from-the-key/.test(tail) && /ob1_registry_kind\(v_agent, actor->>'name'\)/.test(tail) && /ob1_trust_ceiling\(v_kind, v_declared\)/.test(tail),
    "the append carries 046's sentinel and reads the kind and the trust through the two shared rules — the registry by id then by label, the ceiling");
  const registry = await src("ob1_registry_kind(uuid, text)"), ceiling = await src("ob1_trust_ceiling(text, text)");
  assert(/canonical_agent_id = p_agent/.test(registry) && /label = p_label/.test(registry) && /array_position/.test(ceiling),
    "…which the amendment gate and the backfill call too, so the three cannot drift");
  assert(/ob1_registry_kind\(OLD\.canonical_agent_id, OLD\.actor_name\)/.test(await src("thought_audit_refuse_mutation()")) && /ob1_registry_kind\(w\.agent, w\.name\)/.test(await src("backfill_thought_audit_events(integer)")) && /kinds AS MATERIALIZED/.test(await src("backfill_thought_audit_events(integer)")),
    "(the gate and the backfill do call them — the backfill once per distinct writer, materialised, not once per row: eighth review pass)");
  assert(!/actor->>'source'/.test(tail) && /- 'via'/.test(tail) && !/- 'source'/.test(tail), "…reads no actor source (the column is the row's own), strips via into origin and leaves an actor's source in the blob");
  assert(/IF v_agent IS NOT NULL OR actor->>'name' IS NOT NULL THEN\s+v_kind := ob1_registry_kind/.test(tail), "…and probes the registry only when an envelope names an id or a name (a JSON null is neither) — a raw write with no actor set needs no SELECT on ob1_agents");
  assert(/Lost the race[\s\S]*?PERFORM set_config\('ob1\.event', '', true\);[\s\S]*?'STALE_READ'/.test(await src(UPDATE_THOUGHT_SIGNATURE)), "update_thought clears the event on the one refusal that follows its write of the setting — the UPDATE that matched no row");
  const diffRule = await src("ob1_thought_diff(text, text, text, jsonb, jsonb, boolean, boolean, uuid, uuid, jsonb, jsonb, text, text, timestamptz)");
  for (const [re, body, what] of [[/jsonb_build_object\('content', p_new_content, 'metadata', p_new_metadata\)/, diffRule, "008's capture diff, with 055's content"], [/v_diff = '\{\}'::jsonb/, trig, "008's no-op guard"], [/actor->>'agent_id'/, tail, "010's agent id"], [/'previous_derived_from'/, diffRule, "025's provenance in the delete row"]] as [RegExp, string, string][])
    assert(re.test(body), `…carrying ${what}`);
  assert(/ob1:audit-amend-fills-null-only/.test(await src("thought_audit_refuse_mutation()")), "the refusal trigger carries the amendment's sentinel");
  for (const sig of ["upsert_thought(text, jsonb)", "upsert_thought(text, jsonb, vector)", UPDATE_THOUGHT_SIGNATURE])
    assert(/validate_write_event\(/.test(await src(sig)) && /set_config\('ob1\.event'/.test(await src(sig)), `${sig} validates the event and sets it beside the actor`);
  for (const sig of ["upsert_thought(text, jsonb)", "upsert_thought(text, jsonb, vector)"])
    assert(/ob1:capture-sets-write-event/.test(await src(sig)), `${sig} carries the sentinel preflight's atomic-capture check reads, so a 035 body put back by hand is named (sixth review pass)`);

  // The registry: classify by label — before first use — and the resolver
  // meets the row.
  const HASH_OP = "a".repeat(64), HASH_BOT = "b".repeat(64);
  let r = await one<{ r: Record<string, unknown> }>(`SELECT set_agent_kind('op-key', 'operator') AS r`);
  assert(r.r.ok === true && r.r.created === true && r.r.previous_kind === null && r.r.kind === "operator", `set_agent_kind classifies a key nobody has used yet — created, no previous kind (${JSON.stringify(r.r)})`);
  r = await one<{ r: Record<string, unknown> }>(`SELECT set_agent_kind('op-key', 'agent') AS r`);
  assert(r.r.ok === true && r.r.created === false && r.r.previous_kind === "operator", "…a reclassification reports the kind it replaced");
  await db.exec(`SELECT set_agent_kind('op-key', 'operator')`);
  assert((await one<{ r: { ok: boolean; error: string } }>(`SELECT set_agent_kind('op-key', 'root') AS r`)).r.error === "BAD_KIND" && (await one<{ r: { ok: boolean; error: string } }>(`SELECT set_agent_kind('  ', 'agent') AS r`)).r.error === "BAD_LABEL",
    "…and refuses a fourth word and an empty label as values");
  const res = (await one<{ r: { ok: boolean; agent_id: string; rotated: boolean; created: boolean } }>(`SELECT resolve_agent($1, 'op-key', 'write') AS r`, [HASH_OP])).r;
  assert(res.ok && res.rotated === true && res.created === false, "resolve_agent (010) meets the pre-classified label as a known agent with a new digest — its rotation branch — and attaches the hash");
  const OP = res.agent_id;
  assert((await one<{ k: string }>(`SELECT kind AS k FROM ob1_agents WHERE canonical_agent_id = $1::uuid`, [OP])).k === "operator", "…leaving the kind in place");
  await db.exec(`SELECT set_agent_kind('bot-key', 'agent'); SELECT set_agent_kind('feed-key', 'ingested')`);
  const BOT = (await one<{ r: { agent_id: string } }>(`SELECT resolve_agent($1, 'bot-key', 'write') AS r`, [HASH_BOT])).r.agent_id;
  const MYSTERY = (await one<{ r: { agent_id: string } }>(`SELECT resolve_agent($1, 'mystery-key', 'write') AS r`, ["c".repeat(64)])).r.agent_id;
  assert((await one<{ k: string | null }>(`SELECT kind AS k FROM ob1_agents WHERE canonical_agent_id = $1::uuid`, [MYSTERY])).k === null, "a key resolved and never classified has no kind — unknown, not guessed");

  // The settling case (SMD-1724): the operator's key hands in an ingested page.
  const cited = await cap("046: a source the next write cites", { metadata: { source: "planted" }, actor: { name: "op-key", agent_id: OP, via: "test-door" } }, 2);
  const paste = await cap("046: a page the operator pasted", {
    metadata: { source: "web" }, actor: { name: "op-key", agent_id: OP, via: "test-door" },
    event: { stance: "retrieved", cites: [cited.id.toUpperCase(), cited.id], valid_from: "2026-01-01T00:00:00Z", valid_until: "2026-06-30T00:00:00Z", trust: "ingested" },
  }, 3);
  let ev = await last(paste.id, "capture");
  assert(ev?.actor_kind === "operator" && ev?.trust === "ingested", `the settling case: actor operator, trust ingested — two columns, because one read two ways cannot say it (${ev?.actor_kind}, ${ev?.trust})`);
  assert(ev?.origin === "test-door" && ev?.actor_context === null, `the door is the origin column, promoted from actor_context, which is NULL when nothing else rode along (${ev?.origin}, ${JSON.stringify(ev?.actor_context)})`);
  assert(ev?.source === "web", `source is the row's own metadata.source (${ev?.source})`);
  assert(ev?.stance === "retrieved" && ev?.cites?.length === 1 && ev?.cites[0] === cited.id, `stance and cites as declared — cites lowercased and de-duplicated (${ev?.stance}, ${JSON.stringify(ev?.cites)})`);
  assert(ev?.valid_from?.startsWith("2026-01-01") && ev?.valid_until?.startsWith("2026-06-30"), `the valid window as declared (${ev?.valid_from} → ${ev?.valid_until})`);
  assert(ev?.canonical_agent_id === OP && ev?.actor_name === "op-key" && ev?.backfilled_at === null, "…010's id and 008's name beside them, and backfilled_at NULL: the write set them itself");
  ev = await last(cited.id, "capture");
  assert(ev?.actor_kind === "operator" && ev?.trust === "operator" && ev?.stance === null && ev?.cites === null && ev?.valid_from === null && ev?.valid_until === null,
    `no event declared: trust IS the kind, stance, cites and the window NULL — unknown, and the read says unknown (${ev?.trust})`);

  // The Verify fixture: a payload claiming what the key cannot support is
  // stored as the key says, with the attempt on the same row.
  const claim = await cap("046: an agent's conclusion dressed as the operator's word", {
    metadata: {}, actor: { name: "bot-key", agent_id: BOT, via: "test-door" }, event: { actor_kind: "operator", trust: "operator", stance: "inferred" },
  }, 4);
  ev = await last(claim.id, "capture");
  assert(ev?.actor_kind === "agent" && ev?.trust === "agent", `an agent key claiming actor_kind operator and trust operator is stored as agent, agent — the key decides (${ev?.actor_kind}, ${ev?.trust})`);
  assert((ev?.actor_context as { claimed?: Record<string, string> })?.claimed?.actor_kind === "operator" && (ev?.actor_context as { claimed?: Record<string, string> })?.claimed?.trust === "operator" && ev?.stance === "inferred",
    `…and the attempt is recorded on the same row under actor_context.claimed, the stance kept (${JSON.stringify(ev?.actor_context)})`);
  const lowered = await cap("046: an agent hands in a page it fetched", { metadata: {}, actor: { name: "bot-key", agent_id: BOT }, event: { trust: "ingested" } }, 5);
  ev = await last(lowered.id, "capture");
  assert(ev?.trust === "ingested" && ev?.actor_kind === "agent" && ev?.actor_context === null && ev?.origin === null, "a lowering stands, nothing is claimed, and a caller naming no door has a NULL origin");

  // The label fallback: a writer that never resolved an id (SMD-1541's five,
  // the workers) is classified by the key's name.
  const feed = await cap("046: an importer's row", { metadata: { source: "rss" }, actor: { name: "feed-key", via: "readwise-capture" } }, 6);
  ev = await last(feed.id, "capture");
  assert(ev?.canonical_agent_id === null && ev?.actor_kind === "ingested" && ev?.trust === "ingested" && ev?.origin === "readwise-capture", `no agent_id in the envelope: the kind is read by the key's name — ingested, from the registry (${ev?.actor_kind})`);
  const feedRaise = await cap("046: an importer claiming the operator typed it", { metadata: {}, actor: { name: "feed-key" }, event: { trust: "operator" } }, 7);
  ev = await last(feedRaise.id, "capture");
  assert(ev?.trust === "ingested" && (ev?.actor_context as { claimed?: Record<string, string> })?.claimed?.trust === "operator", "…and the clamp works by name as by id");

  // Unknown kind: nothing is invented.
  const unk = await cap("046: a write through a key nobody classified", { metadata: {}, actor: { name: "mystery-key", agent_id: MYSTERY }, event: { trust: "agent" } }, 8);
  ev = await last(unk.id, "capture");
  assert(ev?.actor_kind === null && ev?.trust === null && (ev?.actor_context as { claimed?: Record<string, string> })?.claimed?.trust === "agent", `an unclassified key: actor_kind NULL, trust NULL — a claim above the floor is not honoured, and is recorded (${ev?.trust})`);
  const unkLow = await cap("046: an unclassified key lowering itself", { metadata: {}, actor: { name: "mystery-key", agent_id: MYSTERY }, event: { trust: "ingested" } }, 9);
  ev = await last(unkLow.id, "capture");
  assert(ev?.actor_kind === null && ev?.trust === "ingested" && ev?.actor_context === null, "…but a declared ingested is kept: a lowering nobody can abuse");
  const nobody = await cap("046: a name the registry has never seen", { metadata: {}, actor: { name: "nobody-key" } }, 10);
  ev = await last(nobody.id, "capture");
  assert(ev?.actor_kind === null && ev?.trust === null && ev?.actor_name === "nobody-key", "a name with no registry row: NULL kind and trust, the name kept (008)");
  const ghost = await cap("046: a cached id the registry no longer knows", { metadata: {}, actor: { name: "feed-key", agent_id: "99999999-9999-4999-8999-999999999999" } }, 14);
  ev = await last(ghost.id, "capture");
  assert(ev?.actor_kind === "ingested" && ev?.canonical_agent_id === "99999999-9999-4999-8999-999999999999", `an agent_id the registry does not know — a rebuilt registry under a server's cached id — falls back to the name, the id kept as 010 keeps it (${ev?.actor_kind})`);
  const shadowed = await cap("046: an id the registry knows but has not classified, under a classified name", { metadata: {}, actor: { name: "op-key", agent_id: MYSTERY } }, 19);
  ev = await last(shadowed.id, "capture");
  assert(ev?.actor_kind === "operator" && ev?.canonical_agent_id === MYSTERY, `an id the registry knows but has not classified takes the name's kind — the row a key renamed in the env and pre-classified under its new name leaves when 010's rename meets label_conflict (${ev?.actor_kind})`);
  const stale = await cap("046: a caller still sending an actor source", { metadata: { source: "own" }, actor: { name: "op-key", agent_id: OP, source: "mcp", via: "old-caller" } }, 11);
  ev = await last(stale.id, "capture");
  assert(ev?.source === "own" && (ev?.actor_context as { source?: string })?.source === "mcp", `an actor's source is no longer read into the column — it lands in actor_context, visible (${ev?.source}, ${JSON.stringify(ev?.actor_context)})`);
  const oddDoor = await cap("046: a door that is not a string", { metadata: {}, actor: { name: "op-key", agent_id: OP, via: { server: "x" } } }, 16);
  ev = await last(oddDoor.id, "capture");
  assert(ev?.origin === null && JSON.stringify((ev?.actor_context as { via?: unknown })?.via) === '{"server":"x"}', `a via that is not a string is no door: origin NULL, the value left in the blob (${JSON.stringify(ev?.actor_context)})`);
  const ownClaim = await cap("046: a caller with a claimed key of its own", { metadata: {}, actor: { name: "bot-key", agent_id: BOT, claimed: { foo: 1 } }, event: { trust: "operator" } }, 17);
  ev = await last(ownClaim.id, "capture");
  assert(JSON.stringify((ev?.actor_context as { claimed?: unknown })?.claimed) === '{"trust":"operator"}' && JSON.stringify((ev?.actor_context as { caller_claimed?: unknown })?.caller_claimed) === '{"foo":1}',
    `the trigger owns claimed: a caller's own moves under caller_claimed, whatever its shape, so the gate and the backfill read only what the trigger filed (eighth review pass; ${JSON.stringify(ev?.actor_context)})`);

  // The other doors: the 2-argument form, the 4-argument form, and the edit.
  const two = (await one<{ r: { id: string } }>(`SELECT upsert_thought($1::text, $2::jsonb) AS r`, ["046: through the 2-argument form", JSON.stringify({ metadata: {}, actor: { name: "op-key", agent_id: OP, via: "postgrest-fallback" }, event: { stance: "stated" } })])).r;
  ev = await last(two.id, "capture");
  assert(ev?.actor_kind === "operator" && ev?.origin === "postgrest-fallback" && ev?.stance === "stated", "the 2-argument form (PostgREST's fallback) stamps the event too");
  // 013's 4-argument form is not redefined: it delegates to the 3-argument
  // body, so it inherits the event — read from its source rather than driven
  // with windows, which PGlite's build has crashed on here (a WASM
  // out-of-bounds in the chunk INSERT, not a Postgres error); test-live
  // drives the windowed capture against a real server.
  assert(/upsert_thought\(p_content, p_payload, p_embedding\)/.test(await src("upsert_thought(text, jsonb, vector, jsonb)")) && lastDefinerOf("upsert_thought").startsWith("046"),
    "…and the 4-argument form, 013's and untouched, delegates to the 3-argument body and so inherits the event");
  let e = await edit(paste.id, "046: a page the operator pasted, corrected", { name: "op-key", agent_id: OP, via: "edit-door" }, { stance: "stated", valid_until: "2026-09-01T00:00:00Z", trust: "ingested" });
  ev = await last(paste.id, "update");
  assert(e.ok === true && ev?.actor_kind === "operator" && ev?.trust === "ingested" && ev?.origin === "edit-door" && ev?.stance === "stated" && ev?.valid_from === null && ev?.valid_until?.startsWith("2026-09-01"),
    `update_thought's p_event reaches the update row — the window as declared on THIS write, not inherited from the capture (${ev?.valid_from} → ${ev?.valid_until})`);
  const before = (await rowsOf(paste.id, "update")).length;
  e = await edit(paste.id, "046: a page the operator pasted, corrected", { name: "op-key", agent_id: OP }, null);
  assert(e.ok === true && (await rowsOf(paste.id, "update")).length === before, "an edit that changes nothing and declares nothing writes no row (008's guard)");
  e = await edit(paste.id, "046: a page the operator pasted, corrected", { name: "op-key", agent_id: OP }, { stance: "retrieved", cites: [cited.id] });
  const restated = await one<{ diff: Record<string, unknown>; stance: string | null; cites: string[] | null }>(`SELECT diff, stance, cites FROM thought_audit WHERE thought_id = $1::uuid AND action = 'update' ORDER BY created_at DESC LIMIT 1`, [paste.id]);
  assert(e.ok === true && (await rowsOf(paste.id, "update")).length === before + 1 && JSON.stringify(restated?.diff) === "{}" && restated?.stance === "retrieved" && restated?.cites?.[0] === cited.id,
    `…but an unchanged edit that DECLARES an event is an event: one row, the diff empty, the declaration on it — the restatement SMD-1722 counts (${JSON.stringify(restated?.diff)}, ${restated?.stance})`);
  e = await edit(paste.id, "046: a page the operator pasted, corrected", { name: "op-key", agent_id: OP }, { trust: "ingested" });
  assert(e.ok === true && (await rowsOf(paste.id, "update")).length === before + 1, "…while an unchanged edit declaring only a trust the key supports — a lowering, honoured, nothing to record — writes no row (run-it, fifth review pass)");
  // …but a claim the key does NOT support is a fact about the caller: the
  // clamp is the record, and this row is the only place SMD-1724 can count it
  // (seventh review pass — the sixth had let identical over-claims leave no
  // trace). Counted by its mark, not read as "the latest" (PGlite's now() ties).
  e = await edit(paste.id, "046: a page the operator pasted, corrected", { name: "bot-key" }, { trust: "operator" });
  const clampRows = await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = $1::uuid AND action = 'update' AND diff = '{}'::jsonb AND trust = 'agent' AND actor_kind = 'agent' AND actor_context->'claimed'->>'trust' = 'operator'`, [paste.id]);
  assert(e.ok === true && (await rowsOf(paste.id, "update")).length === before + 2 && clampRows.c === 1,
    `…and an unchanged edit claiming a trust ABOVE its key writes a row: the diff empty, trust the key's, the claim under claimed — the over-claim is recorded (${clampRows.c} row)`);
  // A tombstone's ON DELETE SET NULL updates the successors, and their audit
  // rows are written BEFORE the delete's own trigger run (RI triggers sort
  // first) — so an event left on the transaction would land on them, were it
  // not for the BEFORE DELETE statement trigger that clears it (eighth review
  // pass: the header had claimed the read-once rule covered this; it did not).
  const par = await cap("046: a parent about to be deleted", { metadata: {}, actor: { name: "op-key", agent_id: OP } }, 34);
  const kid = await cap("046: a successor pointing at the parent", { metadata: {}, actor: { name: "op-key", agent_id: OP }, supersedes: par.id }, 35);
  await db.transaction(async (tx) => {
    await tx.exec(`SELECT set_config('ob1.event', '{"stance": "inferred"}', true)`);
    await tx.exec(`SELECT delete_thought('${par.id}'::uuid)`);
    const left = await tx.query<{ v: string }>(`SELECT current_setting('ob1.event', true) AS v`);
    assert(left.rows[0]?.v === "", "…and the setting is cleared by the delete statement itself, before its row work");
  });
  const kidRows = await q<{ action: string; stance: string | null; diff: Record<string, unknown> }>(`SELECT action, stance, diff FROM thought_audit WHERE thought_id = $1::uuid ORDER BY created_at`, [kid.id]);
  assert(kidRows.some((r) => r.action === "update" && JSON.stringify(r.diff).includes("supersedes")) && kidRows.every((r) => r.stance === null),
    `the successor's pointer-cleared row carries no event left on the transaction: the BEFORE DELETE trigger cleared it before the RI action ran (${kidRows.map((r) => `${r.action}:${r.stance}`).join(", ")})`);
  assert((await one<{ c: number }>(`SELECT count(*)::int AS c FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_delete_clears_event' AND NOT tgisinternal AND tgtype & 1 = 0 AND tgtype & 2 = 2 AND tgtype & 8 = 8`)).c === 1,
    "…by a statement-level BEFORE DELETE trigger on thoughts, once per statement, not per row");
  const restatedCap = await cap("046: a page the operator pasted, corrected", { metadata: {}, actor: { name: "op-key", agent_id: OP }, event: { stance: "inferred" } }, 3);
  // Counted, not "the latest": PGlite's now() is millisecond-grained, so two
  // statements can tie on created_at and "latest" is arbitrary (a mutant run
  // found this arm flaky by that tie).
  // (The earlier content-only edits left the row without a vector, so this
  // re-capture's vector is a change of its own: the diff says embedding_present
  // and the row would exist event or not — the event rides it.)
  assert(restatedCap.existed === true && (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = $1::uuid AND action = 'update' AND stance = 'inferred'`, [paste.id]))?.c === 1,
    "…and a re-capture of stored text with an event carries it on its update row, through the ON CONFLICT branch");
  const nine = (await one<{ r: { ok: boolean } }>(`SELECT update_thought($1::uuid, $2::text, NULL, NULL, NULL, NULL, $3::jsonb, NULL, NULL) AS r`, [paste.id, "046: a page the operator pasted, nine arguments", JSON.stringify({ name: "op-key", agent_id: OP })])).r;
  ev = await last(paste.id, "update");
  assert(nine.ok === true && ev?.actor_kind === "operator" && ev?.stance === null, "a 9-argument call — every caller before this change — resolves through the default and declares no event");

  // No inheritance inside one transaction: the second write's event is its
  // own (none), and a tombstone declares nothing even after an event.
  await db.exec(`BEGIN;
    SELECT update_thought('${lowered.id}'::uuid, '046: an agent hands in a page it fetched, edited', NULL, NULL, NULL, NULL, '{"name": "bot-key", "agent_id": "${BOT}"}'::jsonb, NULL, NULL, '{"stance": "inferred", "valid_from": "2020-01-01T00:00:00Z"}'::jsonb);
    SELECT update_thought('${feed.id}'::uuid, '046: an importer''s row, edited', NULL, NULL, NULL, NULL, '{"name": "feed-key"}'::jsonb, NULL, NULL, NULL::jsonb);
    SELECT delete_thought('${unk.id}'::uuid, '{"name": "mystery-key", "agent_id": "${MYSTERY}", "via": "tombstone-door"}'::jsonb);
    COMMIT;`);
  ev = await last(lowered.id, "update");
  assert(ev?.stance === "inferred" && ev?.valid_from?.startsWith("2020-01-01"), "in one transaction, the first edit's event is stamped on its row…");
  ev = await last(feed.id, "update");
  assert(ev?.stance === null && ev?.valid_from === null && ev?.actor_kind === "ingested", "…the second edit, declaring none, inherits nothing — the setting is written empty, not left");
  ev = await last(unk.id, "delete");
  assert(ev !== undefined && ev.stance === null && ev.cites === null && ev.origin === "tombstone-door" && ev.actor_kind === null, "…and the tombstone carries the door and the kind, and declares no stance: delete_thought is 042's, unchanged");
  // The event is read once — and this arm is the read-once rule's own tooth:
  // a capture declaring an event, then a RAW update of another row in the
  // same transaction, with NO delete between (eighth review pass: the arm
  // below has a tombstone in the middle, and thoughts_delete_clears_event now
  // clears the setting there, so it no longer tells a trigger that forgot to
  // clear from one that did — the `inherit` mutant went quiet on it).
  await db.exec(`BEGIN;
    SELECT upsert_thought('046: a page pasted before a raw update', '{"metadata": {}, "actor": {"name": "op-key", "agent_id": "${OP}"}, "event": {"stance": "retrieved", "valid_from": "2026-02-01"}}'::jsonb, '${unit(36)}'::vector);
    UPDATE thoughts SET metadata = metadata || '{"raw_after_capture": true}'::jsonb WHERE id = '${feed.id}'::uuid;
    COMMIT;`);
  const rawAfter = await one<{ stance: string | null; valid_from: string | null }>(`SELECT stance, valid_from FROM thought_audit WHERE thought_id = $1::uuid AND action = 'update' AND diff::text LIKE '%raw_after_capture%'`, [feed.id]);
  assert(rawAfter !== undefined && rawAfter.stance === null && rawAfter.valid_from === null,
    `a raw UPDATE right after an event-bearing capture, no tombstone between, inherits no event: the trigger cleared the setting when it read it (${rawAfter?.stance}, ${rawAfter?.valid_from})`);
  // …and with a tombstone between: a capture declaring a lowered trust, then a
  // tombstone and a RAW update in the same transaction — the tombstone's trust
  // is the key's, unclaimed, and the raw update's row carries no event.
  await db.exec(`BEGIN;
    SELECT upsert_thought('046: a page pasted before a delete', '{"metadata": {}, "actor": {"name": "op-key", "agent_id": "${OP}"}, "event": {"trust": "ingested", "stance": "retrieved"}}'::jsonb, '${unit(15)}'::vector);
    SELECT delete_thought('${stale.id}'::uuid, '{"name": "op-key", "agent_id": "${OP}", "via": "tombstone-door"}'::jsonb);
    UPDATE thoughts SET metadata = metadata || '{"raw": true}'::jsonb WHERE id = '${feed.id}'::uuid;
    COMMIT;`);
  ev = await last(stale.id, "delete");
  assert(ev?.trust === "operator" && ev?.actor_kind === "operator" && ev?.actor_context === null, `a tombstone after an event-bearing capture in one transaction: trust is the key's, nothing claimed — the tombstone reads no event (${ev?.trust}, ${JSON.stringify(ev?.actor_context)})`);
  ev = await last(feed.id, "update");
  assert(ev?.stance === null && ev?.cites === null && ev?.valid_from === null && ev?.actor_kind === "operator",
    `…and a raw UPDATE of thoughts after it inherits no event either — the trigger cleared the setting when it read it — while the ACTOR, 008's and transaction-scoped by design, is still the last call's (${ev?.stance}, ${ev?.actor_kind})`);
  // A call the function refuses before its write — NOT_FOUND here — fires no
  // trigger; the functions write the setting only just before their write
  // (second review pass), so a refused call leaves no event on the transaction:
  // a raw UPDATE right after it, and a capture after that, both declare none.
  const rawBefore = (await rowsOf(feed.id, "update")).length;
  await db.exec(`BEGIN;
    SELECT update_thought('11111111-1111-4111-8111-111111111111'::uuid, 'nobody', NULL, NULL, NULL, NULL, '{"name": "op-key", "agent_id": "${OP}"}'::jsonb, NULL, NULL, '{"stance": "inferred", "cites": ["${cited.id}"]}'::jsonb);
    UPDATE thoughts SET metadata = metadata || '{"raw_after_refusal": true}'::jsonb WHERE id = '${feed.id}'::uuid;
    SELECT upsert_thought('046: a capture after a refused call', '{"metadata": {}, "actor": {"name": "op-key", "agent_id": "${OP}"}}'::jsonb, '${unit(18)}'::vector);
    COMMIT;`);
  ev = await last(feed.id, "update");
  assert((await rowsOf(feed.id, "update")).length === rawBefore + 1 && ev?.stance === null && ev?.cites === null, `a raw UPDATE right after a call refused before its write inherits no event: the refused call never wrote the setting (${ev?.stance}, ${JSON.stringify(ev?.cites)})`);
  ev = await last((await one<{ id: string }>(`SELECT id FROM thoughts WHERE content = '046: a capture after a refused call'`)).id, "capture");
  assert(ev?.stance === null && ev?.actor_kind === "operator", `…and neither does the next function call (${ev?.stance})`);

  // A bad SHAPE is refused, as 025 refuses a bad derived_from; the message
  // names the field.
  const bad = async (event: Record<string, unknown> | string, form: "cap" | "edit" = "cap") =>
    form === "cap"
      ? refused(`SELECT upsert_thought($1::text, $2::jsonb, $3::vector)`, ["046: refused", JSON.stringify({ metadata: {}, actor: { name: "op-key" }, event }), unit(13)])
      : refused(`SELECT update_thought($1::uuid, 'x', NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2::jsonb)`, [paste.id, JSON.stringify(event)]);
  assert(/event\.stance must be stated, retrieved or inferred/.test(await bad({ stance: "guess" })), "a fourth stance is refused, naming the three");
  assert(/event\.trust must be operator, agent or ingested/.test(await bad({ trust: "root" })), "a fourth trust word is refused");
  assert(/event\.cites must contain only thought UUID strings/.test(await bad({ cites: ["not-a-uuid"] })), "a cite that is not a UUID is refused");
  assert(/event\.cites references a thought that does not exist/.test(await bad({ cites: ["11111111-1111-4111-8111-111111111111"] })), "a cite naming no thought is refused — the write is the choke point (025)");
  assert(/event\.cites must be a JSON array/.test(await bad({ cites: cited.id })), "a cite that is not an array is refused");
  assert(/event\.valid_from \(.*\) is after valid_until/.test(await bad({ valid_from: "2026-06-01T00:00:00Z", valid_until: "2026-01-01T00:00:00Z" })), "a window that ends before it starts is refused");
  assert(/event\.valid_from must be a timestamp string beginning YYYY-MM-DD, got "last spring"/.test(await bad({ valid_from: "last spring" })), "a window that is not a timestamp is refused with a message about the event, not a raw cast");
  assert(/must be a timestamp string beginning YYYY-MM-DD, got "now"/.test(await bad({ valid_until: "now" })) && /beginning YYYY-MM-DD, got 0\./.test(await bad({ valid_from: 0 })) && /beginning YYYY-MM-DD, got "infinity"/.test(await bad({ valid_from: "infinity" })),
    "…and so are Postgres's own words for a time — now, a number, infinity — which its reader would otherwise take as a fact about the world");
  assert(/event\.valid_from must be a timestamp, got "2026-13-45T00:00:00Z"/.test(await bad({ valid_from: "2026-13-45T00:00:00Z" })), "a string shaped as a date that is not one is refused by the cast, with the event's message");
  await db.exec(`SET TIME ZONE 'America/Chicago'`);
  const zoned = await cap("046: a window declared without an offset", { metadata: {}, actor: { name: "op-key", agent_id: OP }, event: { valid_from: "2026-03-01", valid_until: "2026-03-02T00:00:00-06:00" } }, 20);
  await db.exec(`SET TIME ZONE 'UTC'`);
  const win = await one<{ f: string; u: string }>(`SELECT (valid_from AT TIME ZONE 'UTC')::text AS f, (valid_until AT TIME ZONE 'UTC')::text AS u FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [zoned.id]);
  assert(win?.f === "2026-03-01 00:00:00" && win?.u === "2026-03-02 06:00:00", `a window with no offset is read as UTC whatever the session's TimeZone, one with an offset as written (${win?.f}, ${win?.u})`);
  await db.exec(`SET TIME ZONE 'Asia/Tokyo'`);
  const named = await cap("046: a window declared with a named zone", { metadata: {}, actor: { name: "op-key", agent_id: OP }, event: { valid_from: "2026-03-01 09:00:00 EST", valid_until: "2026-03-01 09:00:00 America/Chicago" } }, 21);
  await db.exec(`SET TIME ZONE 'UTC'`);
  const namedWin = await one<{ f: string; u: string }>(`SELECT (valid_from AT TIME ZONE 'UTC')::text AS f, (valid_until AT TIME ZONE 'UTC')::text AS u FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [named.id]);
  assert(namedWin?.f === "2026-03-01 14:00:00" && namedWin?.u === "2026-03-01 15:00:00", `a zone spelled as a name or an abbreviation is honoured, not dropped — EST and America/Chicago read as themselves (${namedWin?.f}, ${namedWin?.u})`);
  assert(/must be a timestamp, got/.test(await bad({ valid_from: "2026-03-01 09:00:00 Mars/Olympus" })), "…and a zone Postgres does not know is refused, not read as UTC");
  // Which inputs carry a zone is Postgres's call, not a pattern's: ' UTC' is
  // appended and the cast tried first — it fails only when a zone was already
  // there — and then the input as it came (sixth review pass: the fifth's
  // pattern took AM, PM, BC and a weekday for zones and read "10:00 PM" in the
  // session's zone). So a one- or three-digit offset, or a zone after an AM/PM
  // mark, is read as Postgres reads it, never dropped (run-it, fifth review
  // pass); a bare UTC+5 is POSIX's, hours WEST, as the file says.
  const winUtc = async (s: string) => (await one<{ f: string }>(`SELECT ((validate_write_event(jsonb_build_object('valid_from', $1::text))->>'valid_from')::timestamptz AT TIME ZONE 'UTC')::text AS f`, [s]))?.f;
  await db.exec(`SET TIME ZONE 'Asia/Tokyo'`);
  const odd = [await winUtc("2026-01-01 10:00:00 -5"), await winUtc("2026-01-01 10:00:00+123"), await winUtc("2026-01-01 10:00 PM PST"), await winUtc("2026-01-01 10:00:00 Thu"), await winUtc("2026-01-01 10:00:00 BC"), await winUtc("2026-01-01 10:00:00 UTC+5")];
  await db.exec(`SET TIME ZONE 'UTC'`);
  assert(JSON.stringify(odd) === JSON.stringify(["2026-01-01 15:00:00", "2026-01-01 08:37:00", "2026-01-02 06:00:00", "2026-01-01 10:00:00", "2026-01-01 10:00:00 BC", "2026-01-01 15:00:00"]),
    `…and a zone in any form Postgres reads is read as Postgres reads it — -5 is -05:00, +123 is +01:23, PM PST is an evening in the Pacific, UTC+5 is POSIX's five hours west — while a weekday or an era is not a zone and reads as UTC, not the session's (${JSON.stringify(odd)})`);
  await db.exec(`SET TIME ZONE 'Asia/Tokyo'`);
  const meridian = await cap("046: a window declared with a meridian and no zone", { metadata: {}, actor: { name: "op-key", agent_id: OP }, event: { valid_from: "2026-03-01 10:00 PM" } }, 22);
  await db.exec(`SET TIME ZONE 'UTC'`);
  assert((await one<{ f: string }>(`SELECT (valid_from AT TIME ZONE 'UTC')::text AS f FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [meridian.id]))?.f === "2026-03-01 22:00:00",
    "…and PM is not a zone: an evening with no zone is UTC, not the session's (sixth review pass)");
  assert(/event carries a key the shape does not have: stances/.test(await bad({ stances: "stated" })), "a misspelt key is refused, so it cannot vanish");
  assert(/event must be a JSON object, got string/.test(await bad("stated")), "a double-encoded event is refused with 005's message");
  assert(/event\.stance must be/.test(await bad({ stance: "guess" }, "edit")), "…and update_thought refuses through the same rule");
  assert((await one<{ c: number }>(`SELECT count(*)::int AS c FROM thoughts WHERE content = '046: refused'`)).c === 0, "a refused capture wrote no row");
  assert((await one<{ r: Record<string, unknown> | null }>(`SELECT validate_write_event('{"stance": null, "cites": []}'::jsonb) AS r`)).r === null && (await one<{ r: Record<string, unknown> | null }>(`SELECT validate_write_event('null'::jsonb) AS r`)).r === null,
    "JSON nulls and an empty cites are no event: validate_write_event returns NULL");
  // The setting by hand: not an object is no event; an object that is not JSON
  // is a bug in whoever set it and fails the write — unlike 008's actor,
  // which a NULL records honestly (fifth and sixth review passes).
  await db.exec(`BEGIN; SELECT set_config('ob1.event', 'garbage', true); UPDATE thoughts SET metadata = metadata || '{"hand": 1}'::jsonb WHERE id = '${feed.id}'::uuid; COMMIT;`);
  ev = await last(feed.id, "update");
  assert(ev?.stance === null, "a hand-set value that is not an object reads as no event, and the write goes through");
  let handMalformed = "";
  try { await db.transaction(async (tx) => { await tx.exec(`SELECT set_config('ob1.event', '{"stance": "stated"', true)`); await tx.exec(`UPDATE thoughts SET metadata = metadata || '{"hand": 2}'::jsonb WHERE id = '${feed.id}'::uuid`); }); } catch (err) { handMalformed = (err as Error).message; }
  assert(/invalid input syntax for type json/.test(handMalformed), `a hand-set object that is not JSON fails the write loudly rather than recording no event for it (${handMalformed.slice(0, 60)})`);

  // Immutable by rule: the one amendment, and nothing beside it.
  const paperRow = (await one<{ id: string }>(`SELECT id FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [paste.id])).id;
  assert(/append-only/.test(await refused(`UPDATE thought_audit SET action = 'capture' WHERE id = $1::uuid`, [paperRow])), "UPDATE without the setting is refused, as 008 refused it");
  // One transaction per attempt (the setting is transaction-local); a refusal
  // rolls it back and its message is what the assertion reads.
  const amend = async (stmt: string) => { try { await db.transaction(async (tx) => { await tx.exec(`SELECT set_config('ob1.audit_amend', 'backfill', true)`); await tx.exec(stmt); }); return ""; } catch (err) { return (err as Error).message; } };
  assert(/here a column other than actor_kind, trust, origin and backfilled_at changes/.test(await amend(`UPDATE thought_audit SET diff = '{}'::jsonb WHERE id = '${paperRow}'`)), "under the setting, an UPDATE of diff is refused, the condition named — the amendment fills the derived columns and nothing else");
  assert(/derives to/.test(await amend(`UPDATE thought_audit SET actor_kind = 'agent', backfilled_at = now() WHERE id = '${paperRow}'`)), "…a set actor_kind is never changed");
  assert(/append-only: DELETE/.test(await amend(`DELETE FROM thought_audit WHERE id = '${paperRow}'`)), "…and DELETE is refused under the setting as without it");
  assert(/append-only: TRUNCATE/.test(await refused(`TRUNCATE thought_audit`)) && /append-only: TRUNCATE/.test(await amend(`TRUNCATE thought_audit`)), "…and TRUNCATE, which fires no row trigger, is refused by the statement trigger, setting or no setting");
  const nobodyRow = (await one<{ id: string }>(`SELECT id FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [nobody.id])).id;
  assert(/derives to/.test(await amend(`UPDATE thought_audit SET actor_kind = 'agent' WHERE id = '${nobodyRow}'`)), "…a fill without backfilled_at is refused: the row must say it was derived after the fact");
  assert(/derives to/.test(await amend(`UPDATE thought_audit SET actor_kind = 'agent', trust = 'agent', backfilled_at = now() WHERE id = '${nobodyRow}'`)), "…a kind the registry does not hold for the row's key is refused — the amendment invents nothing");
  await db.exec(`SELECT set_agent_kind('nobody-key', 'agent')`);
  assert(/derives to/.test(await amend(`UPDATE thought_audit SET actor_kind = 'agent', trust = 'operator', backfilled_at = now() WHERE id = '${nobodyRow}'`)), "…a fill that puts trust above the kind is refused — the amendment holds the write path's rule");
  assert(/derives to/.test(await amend(`UPDATE thought_audit SET actor_kind = 'agent', trust = 'agent', origin = 'made-up', backfilled_at = now() WHERE id = '${nobodyRow}'`)), "…a door the row's blob does not carry is refused");
  assert(/derives to/.test(await amend(`UPDATE thought_audit SET actor_kind = 'agent', trust = 'agent', backfilled_at = '1999-01-01' WHERE id = '${nobodyRow}'`)), "…and a back-dated stamp: the stamp is this transaction's time");
  assert((await amend(`UPDATE thought_audit SET actor_kind = 'agent', backfilled_at = now() WHERE id = '${nobodyRow}'`)) === "", "a fill of the kind alone, trust left as it was, is lawful — a value left unchanged is not invented (a pass and a key classified mid-pass must not collide; fourth review pass)");
  assert((await amend(`UPDATE thought_audit SET trust = 'agent', backfilled_at = now() WHERE id = '${nobodyRow}'`)) === "", "…and the trust after it, from the kind the row now has");
  ev = (await rowsOf(nobody.id, "capture"))[0];
  assert(ev?.actor_kind === "agent" && ev?.trust === "agent" && ev?.backfilled_at !== null, "…and both land");
  assert(/here nothing is filled/.test(await amend(`UPDATE thought_audit SET backfilled_at = now() WHERE id = '${nobodyRow}'`)), "…and the same row cannot be stamped again with nothing to fill");
  // A row a tool INSERTed with a kind and no trust (the trigger never writes
  // one) and a door in the blob: the backfill must fill trust and origin, not
  // meet its own gate — one such row would otherwise fail every pass for the
  // whole brain (run-it, second review pass).
  const HALF_ROW = "55555555-5555-4555-8555-555555555555";
  await db.exec(`INSERT INTO thought_audit (thought_id, action, actor_name, actor_kind, diff, actor_context) VALUES ('${HALF_ROW}', 'capture', 'bot-key', 'agent', '{}'::jsonb, '{"via": "tool-door"}'::jsonb)`);
  const half = (await one<{ r: { rows: number } }>(`SELECT backfill_thought_audit_events() AS r`)).r;
  ev = (await rowsOf(HALF_ROW, "capture"))[0];
  assert(half.rows >= 1 && ev?.trust === "agent" && ev?.origin === "tool-door" && ev?.backfilled_at !== null, `a row with a kind and no trust is filled by the backfill — trust from the kind it has, origin from its blob — rather than refused by the gate (${ev?.trust}, ${ev?.origin})`);
  const EMPTY_DOOR = "66666666-6666-4666-8666-666666666666";
  await db.exec(`INSERT INTO thought_audit (thought_id, action, actor_name, diff, actor_context) VALUES ('${EMPTY_DOOR}', 'capture', 'bot-key', '{}'::jsonb, '{"via": ""}'::jsonb)`);
  await db.exec(`SELECT backfill_thought_audit_events()`);
  ev = (await rowsOf(EMPTY_DOOR, "capture"))[0];
  assert(ev?.origin === null && ev?.actor_kind === "agent" && (ev?.actor_context as { via?: string })?.via === "", "…and an empty via is no door: origin stays NULL, the kind is filled, the blob keeps the empty string");
  assert((await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE origin IS NULL AND ob1_door_of(actor_context) IS NOT NULL`)).c === 0,
    "…and the door index's predicate is empty after the pass — the row with the empty via is not in it, so no later pass re-reads a row it can never fill (seventh review pass)");
  const doors = await one<{ a: string | null; b: string | null }>(`SELECT ob1_door_of('{"via": "  "}'::jsonb) AS a, ob1_door_of('{"via": " rest-api "}'::jsonb) AS b`);
  assert(doors.a === null && doors.b === "rest-api",
    "…a via of blanks is no door and a door is trimmed — a name, not bytes (run-it, eighth review pass)");
  assert(/append-only/.test(await refused(`UPDATE thought_audit SET actor_kind = NULL WHERE id = $1::uuid`, [nobodyRow])), "…after which the ordinary refusal stands again — the setting was transaction-local");

  // The backfill: a SMD-1541-shaped row (via in the blob, no origin) and rows
  // whose key is classified after the fact.
  const OLD = "44444444-4444-4444-8444-444444444444";
  await db.exec(`INSERT INTO thought_audit (thought_id, action, source, actor_name, diff, actor_context) VALUES ('${OLD}', 'capture', 'planted', 'MCP_ACCESS_KEY', '{}'::jsonb, '{"via": "rest-api", "runtime": "test"}'::jsonb)`);
  const awaitingBefore = (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE actor_kind IS NULL AND actor_name IS NOT NULL`)).c;
  let bf = (await one<{ r: { ok: boolean; rows: number; awaiting_kind: number } }>(`SELECT backfill_thought_audit_events() AS r`)).r;
  ev = (await rowsOf(OLD, "capture"))[0];
  assert(bf.ok && bf.rows >= 1 && ev?.origin === "rest-api" && ev?.backfilled_at !== null && (ev?.actor_context as { via?: string; runtime?: string })?.via === "rest-api" && (ev?.actor_context as { runtime?: string })?.runtime === "test",
    `a row from before 046 gains its origin from actor_context.via, stamped, the blob untouched (${bf.rows} row(s))`);
  assert(ev?.actor_kind === null && bf.awaiting_kind === awaitingBefore, `…and no kind: MCP_ACCESS_KEY is a name the registry has not classified — ${bf.awaiting_kind} row(s) still wait on one`);
  // A caller's own `claimed` cannot steer the backfill: an envelope that
  // pre-seeds {claimed: {trust: "ingested"}} through an unclassified key has
  // it moved under caller_claimed, so once the key is an operator's the row
  // comes out `operator`, not `ingested` (eighth review pass — the first draft
  // merged the caller's object into the trigger's key and the backfill read it).
  await db.exec(`SELECT resolve_agent(repeat('e', 64), 'seeded-key', 'write')`);
  const seeded = await cap("046: a write whose envelope pre-seeds a claim", { metadata: {}, actor: { name: "seeded-key", claimed: { trust: "ingested" } } }, 33);
  ev = (await rowsOf(seeded.id, "capture"))[0];
  assert(ev?.trust === null && (ev?.actor_context as { claimed?: unknown; caller_claimed?: { trust?: string } })?.claimed === undefined && (ev?.actor_context as { caller_claimed?: { trust?: string } })?.caller_claimed?.trust === "ingested",
    `a caller's claimed moves under caller_claimed and the trigger's key stays empty when nothing was clamped (${JSON.stringify(ev?.actor_context)})`);
  await db.exec(`SELECT set_agent_kind('seeded-key', 'operator')`);
  // mystery-key becomes an OPERATOR's key: the row that declared `agent` while
  // it was unclassified (claimed, not honoured) must come out `agent`, not
  // `operator` — the trigger's rule applied late, not a raise.
  const ID_ONLY = "77777777-7777-4777-8777-777777777777";
  await db.exec(`INSERT INTO thought_audit (thought_id, action, canonical_agent_id, diff) VALUES ('${ID_ONLY}', 'capture', '${MYSTERY}', '{}'::jsonb)`);
  await db.exec(`SELECT set_agent_kind('mystery-key', 'operator'); SELECT set_agent_kind('MCP_ACCESS_KEY', 'operator')`);
  const mysteryRows = (await q<{ id: string }>(`SELECT id FROM thought_audit WHERE actor_name = 'mystery-key' AND actor_kind IS NULL`)).length;
  bf = (await one<{ r: { ok: boolean; rows: number; awaiting_kind: number } }>(`SELECT backfill_thought_audit_events(1) AS r`)).r;
  assert(bf.rows === 1, `p_limit bounds a pass (${bf.rows})`);
  bf = (await one<{ r: { ok: boolean; rows: number; awaiting_kind: number } }>(`SELECT backfill_thought_audit_events() AS r`)).r;
  ev = (await rowsOf(unk.id, "capture"))[0];
  assert(ev?.actor_kind === "operator" && ev?.trust === "agent" && ev?.backfilled_at !== null && (ev?.actor_context as { claimed?: Record<string, string> })?.claimed?.trust === "agent",
    `once the key is classified, its rows gain the kind by id, stamped — and the trust the write DECLARED while unclassified, now that the kind supports it, the claim left in the blob (${ev?.actor_kind}, ${ev?.trust})`);
  assert((await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture' AND actor_context->'claimed'->>'trust' IS DISTINCT FROM trust`, [unk.id])).c === 0,
    "…and by the column's rule — a clamp is claimed.trust IS DISTINCT FROM trust — that row is no longer a clamp: the mark means 'declared while unknown', and the backfill made them equal (eighth review pass)");
  ev = (await rowsOf(unkLow.id, "capture"))[0];
  assert(ev?.actor_kind === "operator" && ev?.trust === "ingested", "…a row that had declared ingested keeps it: a set value is never changed");
  ev = (await rowsOf(seeded.id, "capture"))[0];
  assert(ev?.actor_kind === "operator" && ev?.trust === "operator" && (ev?.actor_context as { caller_claimed?: { trust?: string } })?.caller_claimed?.trust === "ingested",
    `…and the pre-seeded claim decided nothing: the backfill reads the trigger's key only, so the row is the operator's (${ev?.trust})`);
  ev = (await rowsOf(unk.id, "delete"))[0];
  assert(ev?.actor_kind === "operator" && ev?.trust === "operator", "…and a row that declared nothing takes the kind as its trust");
  ev = (await rowsOf(OLD, "capture"))[0];
  assert(ev?.actor_kind === "operator" && ev?.trust === "operator", "…and a row with no agent id is classified by its actor_name — the five servers' rows");
  ev = (await rowsOf(ID_ONLY, "capture"))[0];
  assert(ev?.actor_kind === "operator" && ev?.trust === "operator" && ev?.backfilled_at !== null, "…and a row with an id and no name by its id — the backfill and the census count what the trigger derives from (fourth review pass)");
  assert(bf.awaiting_kind === (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE actor_kind IS NULL AND (actor_name IS NOT NULL OR canonical_agent_id IS NOT NULL)`)).c && mysteryRows + 1 >= 2,
    `awaiting_kind is the rows that still name an unclassified key (${bf.awaiting_kind})`);
  bf = (await one<{ r: { ok: boolean; rows: number; awaiting_kind: number } }>(`SELECT backfill_thought_audit_events() AS r`)).r;
  assert(bf.rows === 0, "a second pass finds nothing: idempotent, as the migration's own call is on re-apply");
  assert((await one<{ s: string }>(`SELECT current_setting('ob1.audit_amend', true) AS s`)).s === "" || (await one<{ s: string | null }>(`SELECT current_setting('ob1.audit_amend', true) AS s`)).s === null, "…and leaves the amendment setting cleared");
  assert(/append-only/.test(await refused(`DELETE FROM thought_audit WHERE thought_id = $1::uuid`, [OLD])), "the planted row cannot be removed either — it stays, as every row does");

  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_agents`);
}

// ── 44. db/graph-centrality.ts — the counts, the ladder, the control, the lifecycle ──
//
// The script's exported SQL builders run here under PGlite through a Runner, so
// the text the CLI sends is the text asserted. A small graph whose every count
// is known by construction: the subject, three neighbours that separate under
// each ranking, one numeric-noise entity (SMD-1935) that must count nowhere,
// and a merged entity for the merged_from rung. The thoughts carry the
// lifecycle board-sync stamps (SMD-1994): every count in the first half is read
// with every weight 1, so the default run IS the drop-the-filter control, and
// the lifecycle block reads the same graph under each filter and under decay.

console.log("\n[44] db/graph-centrality.ts: mentions, degree and support as defined; the resolution ladder; numeric names out of every count; edges on vs off is the drop-the-graph control (SMD-1938); a thought's lifecycle is a weight — the filter, the decay, and the unstamped passing every filter (SMD-1994)");
{
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_config WHERE key = 'entity_extraction_key'`);
  await db.exec(`SELECT prune_orphan_entities()`);
  const KEY = "extract:stub@p1";
  const run: Runner = async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows;
  const thought = async (content: string) =>
    (await db.query<{ r: { id: string } }>(`SELECT upsert_thought($1, '{}'::jsonb) AS r`, [content])).rows[0].r.id;
  const record = (id: string, entities: unknown[], relations: unknown[] = []) =>
    db.query(`SELECT record_thought_entities($1::uuid, $2, $3::jsonb, $4::jsonb, NULL, NULL)`, [id, KEY, JSON.stringify(entities), JSON.stringify(relations)]);
  const E = (name: string, type: string, aliases?: string[]) => ({ name, type, confidence: 0.9, ...(aliases ? { aliases } : {}) });
  const R = (from: string, to: string, relation: string, confidence = 1.0) => ({ from, to, relation, confidence });

  // The fixture. Open Brain (OB) is the subject, mentioned by t1–t5.
  //   PostgreSQL: co-mentioned with OB in t1,t2,t3; OB→PG depends_on evidenced by t1,t2,t3   → co 3, support 3
  //   Bun:        co-mentioned in t2,t3,t4; no edge to OB                                    → co 3, support 0
  //   Anita:      co-mentioned in t1,t4; Anita→OB works_on evidenced by t1,t4                → co 2, support 2
  //   021 (a numeric-named `person`, SMD-1935's shape): t5, with an edge to OB → out of scope by default
  //   t6 mentions Bun alone (Bun's mentions 4 ≠ its co-mentions 3); t8 mentions "PG" alone, merged into PostgreSQL below.
  const t1 = await thought("Open Brain depends on PostgreSQL; Anita works on it.");
  const t2 = await thought("Open Brain depends on PostgreSQL and runs under Bun.");
  const t3 = await thought("Open Brain on PostgreSQL, with Bun.");
  const t4 = await thought("Anita works on Open Brain, in Bun.");
  const t5 = await thought("Migration 021 in Open Brain.");
  const t6 = await thought("Bun\talone,\n\n  really.");
  const t8 = await thought("PG alone.");
  await record(t1, [E("Open Brain", "project"), E("PostgreSQL", "tool", ["Postgres"]), E("Anita", "person")],
    [R("Open Brain", "PostgreSQL", "depends_on", 0.8), R("Anita", "Open Brain", "works_on")]);
  await record(t2, [E("Open Brain", "project"), E("PostgreSQL", "tool"), E("Bun", "tool")], [R("Open Brain", "PostgreSQL", "depends_on")]);
  await record(t3, [E("Open Brain", "project"), E("PostgreSQL", "tool"), E("Bun", "tool")], [R("Open Brain", "PostgreSQL", "depends_on")]);
  await record(t4, [E("Open Brain", "project"), E("Anita", "person"), E("Bun", "tool")], [R("Anita", "Open Brain", "works_on")]);
  await record(t5, [E("Open Brain", "project"), E("021", "person")], [R("021", "Open Brain", "works_on")]);
  await record(t6, [E("Bun", "tool")]);
  await record(t8, [E("PG", "tool")]);
  /** A fixture thought out again, and the entities only it held with it. */
  const drop = async (id: string) => { await db.query(`DELETE FROM thoughts WHERE id = $1`, [id]); await db.exec(`SELECT prune_orphan_entities()`); };
  const idOf = async (nname: string, type = "tool") =>
    (await db.query<{ id: string }>(`SELECT id FROM ob1_entities WHERE normalized_name = $1 AND entity_type = $2`, [nname, type])).rows[0].id;
  const OB = await idOf("open brain", "project");
  const PG = await idOf("postgresql");
  const BUN = await idOf("bun");
  const ANITA = await idOf("anita", "person");
  const NUM = await idOf("021", "person");
  await db.query(`SELECT merge_entities($1::uuid, $2::uuid)`, [PG, await idOf("pg")]);
  // The lifecycles, as board-sync stamps them (the three keys, source linear):
  // t1 Done, t2 In Progress, t3 Backlog, t4 Todo, t5 Canceled; t6 none; t8 a
  // status_type this tool does not know. Stamped BEFORE the counts below, which
  // read every thought at weight 1 — the default — and so pin that the
  // lifecycle read is additive.
  const SYNCED = "2026-09-24T10:00:00.000Z";
  const LATEST = "2026-09-24T11:00:00.000Z";
  const stamp = (id: string, status: string, status_type: string, at = SYNCED) =>
    db.query(`UPDATE thoughts SET metadata = metadata || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ source: "linear", status, status_type, linear_updated_at: at })]);
  await stamp(t1, "Done", "completed", LATEST);
  await stamp(t2, "In Progress", "started");
  await stamp(t3, "Backlog", "backlog");
  await stamp(t4, "Todo", "unstarted");
  await stamp(t5, "Canceled", "canceled");
  await db.query(`UPDATE thoughts SET metadata = metadata || '{"status_type": "weird"}'::jsonb WHERE id = $1`, [t8]);
  // t6 carries a `status` key with no status_type — a hand note's own word, not a lifecycle (first review pass).
  await db.query(`UPDATE thoughts SET metadata = metadata || '{"status": "draft"}'::jsonb WHERE id = $1`, [t6]);
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);
  const on: GraphOptions = { ...DEFAULT_OPTIONS, limit: 10 };
  const off: GraphOptions = { ...on, edges: false };
  const keep: GraphOptions = { ...on, excludeNumeric: false };

  // Coverage: the numbers the caveats print are the fixture's.
  const cov = await graphCoverage(run, on);
  assert(cov.thoughts === 7 && cov.extracted === 7, `coverage counts the thoughts and the extracted ones (${cov.thoughts}, ${cov.extracted})`);
  assert(cov.entities === 4 && cov.numeric_names === 1, `four entities in scope — the merged PG is PostgreSQL's, 021 is numeric (${cov.entities} in scope, ${cov.numeric_names} numeric)`);
  assert(cov.edges === 6 && cov.unit_edges === 5, `six edge rows, five at confidence 1.00 — the SMD-1925 caveat is a count, not a claim (${cov.edges}, ${cov.unit_edges})`);
  assert(cov.extraction_key === null, "no extraction key: the coverage line says the worker has not set one");
  assert((await graphCoverage(run, keep)).entities === 5, "…and with numerics kept the fifth entity is in scope");
  assert((await graphCoverage(run, { ...on, types: ["tool"] })).numeric_names === 0 && (await graphCoverage(run, { ...on, types: ["person"] })).numeric_names === 1,
    "numeric_names counts the rule's own effect — numeric names among the ranked types, so under --types tool the person 021 is not counted (third review pass)");

  // The three counts, as the header defines them.
  const top = await topEntities(run, on);
  const byM = top.byMentions;
  const ob = byM.find((e) => e.id === OB)!;
  assert(ob.mentions === 5 && ob.degree === 2 && ob.support === 4,
    `Open Brain: 5 mentions; degree 2 (PostgreSQL, Anita — 021 is out of scope and adds none); support 4 (t1–t4 evidence its in-scope edges; t5's does not count) (${ob.mentions}/${ob.degree}/${ob.support})`);
  const keptTop = await topEntities(run, keep);
  const obKept = keptTop.byMentions.find((e) => e.id === OB)!;
  assert(obKept.degree === 3 && obKept.support === 5, `…with numerics kept, 021 is a third neighbour and t5 a fifth supporting thought (${obKept.degree}/${obKept.support})`);
  const pg = byM.find((e) => e.id === PG)!;
  assert(pg.mentions === 4 && pg.name === "PostgreSQL", `PostgreSQL has 4 mentions after the merge re-pointed PG's (${pg.mentions})`);
  assert(byM.every((e) => e.id !== NUM) && keptTop.byMentions.some((e) => e.id === NUM), "the numeric entity is in no list by default, and listed when kept");
  assert(names(byM).join(",") === "Open Brain,PostgreSQL,Bun,Anita",
    `by mentions with edges on: PostgreSQL before Bun at 4 mentions each, on degree (${names(byM).join(",")})`);
  const offTop = await topEntities(run, off);
  const byMOff = offTop.byMentions;
  assert(names(byMOff).join(",") === "Open Brain,Bun,PostgreSQL,Anita" && byMOff.every((e) => e.degree === undefined && e.support === undefined),
    `…edges off: the tie breaks on the name, and no edge column is read (${names(byMOff).join(",")})`);
  const hubs = top.byDegree;
  assert(names(hubs).join(",") === "Open Brain,PostgreSQL,Anita,Bun" && hubs[1].degree === 1 && hubs[3].degree === 0,
    `by degree: the subject, then its two edge neighbours, then Bun with none (${names(hubs).join(",")})`);
  assert(offTop.byDegree.length === 0, "…and there is no hub list with edges off");
  const tools = (await topEntities(run, { ...on, types: ["tool"] })).byMentions;
  assert(names(tools).join(",") === "Bun,PostgreSQL" && tools[1].degree === 0 && tools[1].support === 0 && tools[1].mentions === 4,
    `--types tool: the two tools, and the scope IS the graph — PostgreSQL's only edge neighbour is a project, so its degree and support are 0 here while its mentions are its own, and the tie with Bun breaks on the name (${names(tools).join(",")}, ${tools[1].degree}/${tools[1].support}/${tools[1].mentions})`);

  // Top thoughts: entities mentioned plus edges evidenced, both in scope.
  const tt = await topThoughts(run, on);
  assert(tt[0].id === t1 && tt[0].entities === 3 && tt[0].edges === 2, `t1 leads the whole graph: three entities and two edges (${tt[0].entities}+${tt[0].edges})`);
  const t5row = tt.find((t) => t.id === t5)!;
  assert(t5row.entities === 1 && t5row.edges === 0, `t5 counts one entity and no edge — 021 is out of both counts (${t5row.entities}+${t5row.edges})`);
  assert(tt.length === 7 && tt[0].excerpt.startsWith("Open Brain depends") && tt.every((t) => ISO_RE.test(t.created_at ?? "")),
    `every extracted thought is listed with an excerpt and its timestamp as the server renders one — ISO, UTC, not the session's TimeZone (${tt[0].created_at})`);
  assert(tt.find((t) => t.id === t6)!.excerpt === "Bun alone, really.", `the excerpt collapses tabs, newlines and runs of spaces to one space — so the '\\s+' reached Postgres as written (${JSON.stringify(tt.find((t) => t.id === t6)!.excerpt)})`);
  const ttOff = await topThoughts(run, off);
  assert(ttOff.slice(0, 4).map((t) => t.id).sort().join() === [t1, t2, t3, t4].sort().join() && ttOff.every((t) => t.edges === undefined),
    "…edges off: t1–t4 tie at three entities, and the edge column is absent");

  // The resolution ladder.
  const exact = await resolveSubject(run, "Open Brain", on);
  assert(exact.how === "exact" && exact.subjects.length === 1 && exact.subjects[0].id === OB && exact.subjects[0].mentions === 5, "exact: the normalised name, one subject, with its mentions");
  assert((await resolveSubject(run, " open-brain ", on)).subjects[0]?.id === OB, "…through normalize_entity_name, so a hyphen and padding still find it");
  const alias = await resolveSubject(run, "Postgres", on);
  assert(alias.how === "alias" && alias.subjects.length === 1 && alias.subjects[0].id === PG, `alias: "Postgres" is an alias PostgreSQL carries (${alias.how})`);
  const merged = await resolveSubject(run, "PG", on);
  assert(merged.how === "alias" && merged.subjects[0]?.id === PG, `alias: "PG" is a name a human merged in, and merged_from resolves (${merged.how})`);
  const fuzzy = await resolveSubject(run, "Open Brian", on);
  assert(fuzzy.how === "fuzzy" && fuzzy.subjects[0]?.id === OB && fuzzy.subjects[0].score >= FUZZY_FLOOR && fuzzy.subjects[0].score < 1,
    `fuzzy: a transposition is offered as a guess with its similarity (${fuzzy.how}, ${fuzzy.subjects[0]?.score})`);
  assert(fuzzy.normalized === "open brian", "…and the resolution says what the rule made of the input");
  const none = await resolveSubject(run, "qqqq", on);
  assert(none.how === "none" && none.subjects.length === 0 && none.normalized === "qqqq", "none: nothing on any rung");
  const punct = await resolveSubject(run, "...", on);
  assert(punct.how === "none" && punct.normalized === null, "none: a name that is only punctuation normalises to NULL and no rung is tried");
  assert((await resolveSubject(run, OB, on)).how === "id", "a uuid resolves by id");
  const noId = await resolveSubject(run, "0f1e2d3c-4b5a-6789-abcd-0123456789ab", on);
  assert(noId.how === "none" && !noId.excluded && render(await graphReport(run, "0f1e2d3c-4b5a-6789-abcd-0123456789ab", on)).includes("No entity has the id"),
    "a uuid no entity has: none, and the report says so rather than calling it punctuation (first review pass)");
  const numSubject = await resolveSubject(run, "021", on);
  assert(numSubject.how === "none" && numSubject.excluded === true && (await resolveSubject(run, "021", keep)).how === "exact",
    "the numeric rule applies to the subject: 021 is no subject by default, the resolution says the rule excluded it, and it is a subject when kept");
  const numText = render(await graphReport(run, "021", on));
  assert(numText.includes("pass --keep-numeric") && !numText.includes("nothing exact"),
    "…and the report names the flag instead of claiming nothing matched (first review pass)");
  const numById = await resolveSubject(run, NUM, on);
  assert(numById.how === "none" && numById.excluded === true && (await resolveSubject(run, NUM, keep)).how === "id", "…by id as well");
  assert(none.excluded === false && punct.excluded === false, "a name nothing matches is not called excluded");
  const typed = await resolveSubject(run, "Open Brain", { ...on, types: ["tool"] });
  assert(typed.how === "exact" && typed.subjects[0].id === OB, "--types does not apply to the subject: a project is found under a tool scope");

  // The neighbourhood, and the control. Edges on: PostgreSQL 3+3, Anita 2+2,
  // Bun 3+0. Edges off: PostgreSQL 3 and Bun 3 tie at 4 mentions each and the
  // name decides, then Anita 2. Every position differs, so a build that ranks
  // on co-mentions and calls it the graph fails here.
  const nOn = await neighbourhood(run, [OB], on);
  assert(names(nOn).join(",") === "PostgreSQL,Anita,Bun", `edges on: ranked by co_mentions + support (${names(nOn).join(",")})`);
  assert(nOn[0].co_mentions === 3 && nOn[0].support === 3 && nOn[0].relations === "depends_on×3", `PostgreSQL: 3 co-mentions, 3 supporting thoughts, the relation named with its count (${JSON.stringify(nOn[0])})`);
  // Support is distinct THOUGHTS; the per-relation counts are per relation, so
  // one thought asserting two relations counts once in support and once under
  // each relation (the definitional pass). Add such a thought, read, remove.
  const t12 = await thought("Open Brain uses and depends on PostgreSQL, says one thought.");
  await record(t12, [E("Open Brain", "project"), E("PostgreSQL", "tool")], [R("Open Brain", "PostgreSQL", "depends_on"), R("Open Brain", "PostgreSQL", "uses")]);
  const twoRel = (await neighbourhood(run, [OB], on))[0];
  assert(twoRel.name === "PostgreSQL" && twoRel.support === 4 && twoRel.co_mentions === 4 && twoRel.relations === "depends_on×4, uses×1",
    `a thought asserting two relations adds one to support and one under each relation, so the relation counts sum to 5 past a support of 4 (${JSON.stringify(twoRel)})`);
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [t12]);
  assert(nOn[1].co_mentions === 2 && nOn[1].support === 2 && nOn[1].relations === "works_on×2" && nOn[1].mentions === 2, `Anita: 2 and 2, works_on both times (${JSON.stringify(nOn[1])})`);
  assert(nOn[2].co_mentions === 3 && nOn[2].support === 0 && nOn[2].relations === null && nOn[2].mentions === 4, `Bun: 3 co-mentions, no edge, 4 mentions in all (${JSON.stringify(nOn[2])})`);
  assert(nOn.every((n) => n.id !== NUM && n.id !== OB), "the subject is not its own neighbour, and the numeric entity is nobody's");
  const nOff = await neighbourhood(run, [OB], off);
  assert(names(nOff).join(",") === "Bun,PostgreSQL,Anita" && nOff.every((n) => n.support === undefined && n.relations === undefined),
    `edges off: co-occurrence alone, no edge column read (${names(nOff).join(",")})`);
  const nKept = await neighbourhood(run, [OB], keep);
  assert(nKept.length === 4 && nKept[3].id === NUM && nKept[3].co_mentions === 1 && nKept[3].support === 1, `with numerics kept, 021 is the fourth neighbour at 1+1 (${names(nKept).join(",")})`);
  const nTools = await neighbourhood(run, [OB], { ...on, types: ["tool"] });
  assert(names(nTools).join(",") === "PostgreSQL,Bun", `--types tool around the project: the two tools (${names(nTools).join(",")})`);
  assert((await neighbourhood(run, [OB], { ...on, limit: 1 })).length === 1, "the limit bounds the neighbourhood");
  assert((await neighbourhood(run, [], on)).length === 0, "no subject, no neighbourhood — and no query");

  // Thoughts around the subject: neighbours among the ranked ones, plus edges
  // with the subject at one end and an in-scope entity at the other.
  const st = await subjectThoughts(run, [OB], nOn.map((n) => n.id), on);
  assert(st[0].id === t1 && st[0].entities === 2 && st[0].edges === 2, `t1 first: two neighbours (PostgreSQL, Anita) and two subject edges (${st[0].entities}+${st[0].edges})`);
  const st5 = st.find((t) => t.id === t5)!;
  assert(st5.entities === 0 && st5.edges === 0, `t5: no ranked neighbour, and its 021 edge is out of scope (${st5.entities}+${st5.edges})`);
  assert(st.length === 5 && st.every((t) => t.id !== t6 && t.id !== t8), "only thoughts mentioning the subject are ranked");
  const st5kept = (await subjectThoughts(run, [OB], nKept.map((n) => n.id), keep)).find((t) => t.id === t5)!;
  assert(st5kept.entities === 1 && st5kept.edges === 1, `…kept, t5's 021 counts as a neighbour and as an edge (${st5kept.entities}+${st5kept.edges})`);
  const stOff = await subjectThoughts(run, [OB], nOff.map((n) => n.id), off);
  assert(stOff.every((t) => t.edges === undefined) && stOff.slice(0, 4).every((t) => t.entities === 2), "edges off: t1–t4 each mention two neighbours and no edge column is read");

  // The report is deterministic, and what it prints names the caveats.
  const r1 = await graphReport(run, "Open Brain", on);
  const r2 = await graphReport(run, "Open Brain", on);
  assert(JSON.stringify(r1) === JSON.stringify(r2), "two runs over the same rows are byte-identical");
  const text = render(r1);
  for (const needle of ["SMD-1925", "5 of 6 edge rows carry confidence 1.00", "SMD-1935", "1 entity of the ranked types named only by digits, dots, colons and spaces is out of scope", "admits it;", "Ticket status is read from synced metadata (board-sync, SMD-1954)", "No recency term", "Coverage: 7 of 7 thoughts", "db/extract-entities.ts has not run", "--status tells the two apart", "can sum past support"])
    assert(text.includes(needle), `the rendered report says: ${needle}`);
  assert(text.includes("depends_on×3") && text.includes("exact match on the normalised name"), "…and shows the relation counts and how the subject resolved");
  assert(text.includes(r1.thoughts[0].created_at!) && text.split("\n").filter((l) => l.includes(r1.thoughts[0].id)).every((l) => !l.includes("…")),
    `the captured column carries the whole ISO stamp, Z included, uncut (${r1.thoughts[0].created_at})`);
  const long = render({ ...r1, neighbours: [{ ...r1.neighbours![0], relations: "depends_on×3, works_on×2, uses×1, related_to×1, co_occurs_with×1, member_of×1" }] });
  const cutLine = long.split("\n").find((l) => l.includes("depends_on×3, works_on×2"))!;
  assert(cutLine !== undefined && /related_to×1, co_occurs_w…/.test(cutLine) && !cutLine.includes("member_of"),
    `a cell over its column's cap (60) is cut at 59 and marked, never silently — 77 characters of relations end "co_occurs_w…" (third review pass) (${cutLine?.trim().slice(-30)})`);
  const rOff = render(await graphReport(run, "Open Brain", off));
  assert(rOff.includes("--no-edges: ranked by co-occurrence alone") && /co_mentions  mentions/.test(rOff) && !/co_mentions  support/.test(rOff) && !/relations \(/.test(rOff),
    "edges off, the report says it is the control and the neighbourhood table has no support or relations column");
  assert(/co_mentions  support  mentions/.test(text) && /relations \(thoughts asserting each; can sum past support\)/.test(text), "…which edges on has, the column head saying the counts can sum past support");
  const rNone = await graphReport(run, "qqqq", on);
  assert(rNone.resolution?.how === "none" && rNone.neighbours?.length === 0 && rNone.thoughts.length === 0 && render(rNone).includes(`nothing within trigram similarity ${FUZZY_FLOOR}`), "an unresolved subject: empty lists and a line saying which rungs were tried");
  const whole = await graphReport(run, null, off);
  assert(whole.resolution === null && whole.by_mentions?.length === 4 && whole.by_degree?.length === 0 && render(whole).includes("the whole graph"), "no subject: the whole graph, and no hub list with edges off");

  // ── The lifecycle (SMD-1994). One rule, a per-thought weight, carries the
  // filter (0 or 1) and the decay (DONE_WEIGHT for a completed or canceled
  // thought); a thought with no lifecycle, or one this tool does not know,
  // weighs 1 under every flag. Every count above was read at weight 1, so the
  // default run is the control; here the same graph under each filter.
  const open: GraphOptions = { ...on, status: "open" };
  const active: GraphOptions = { ...on, status: "active" };
  const doneOnly: GraphOptions = { ...on, status: "done" };
  const decay: GraphOptions = { ...on, decayDone: true };
  assert(cov.with_lifecycle === 5 && cov.done === 2 && cov.unknown_status === 1 && cov.weighed === 7 && cov.last_sync === LATEST,
    `coverage: five thoughts carry a lifecycle, two of them settled, one an unknown status_type; every thought weighs in by default; the latest linear_updated_at is the freshness (${cov.with_lifecycle}/${cov.done}/${cov.unknown_status}/${cov.weighed}, ${cov.last_sync})`);
  assert((await graphCoverage(run, open)).weighed === 5 && (await graphCoverage(run, active)).weighed === 4 && (await graphCoverage(run, doneOnly)).weighed === 4 && (await graphCoverage(run, decay)).weighed === 7,
    "weighed: open drops t1 and t5; active drops t3 too; done keeps t1, t5 and the two without a lifecycle; decay drops none");
  assert(r1.thoughts[0].id === t1 && r1.thoughts[0].status === "Done" && r1.thoughts[0].status_type === "completed" && r1.thoughts[0].weight === 1 && r1.thoughts.find((t) => t.id === t5)!.status === "Canceled",
    "the JSON carries each thought's status, status_type and weight — t1 Done at weight 1 by default");
  assert(text.includes(`latest linear_updated_at ${LATEST}: 5 of 7 thoughts carry a lifecycle, 2 of them completed or canceled, and 1 carries a status_type this tool does not know (weighed 1). Every thought weighs 1: a Done ticket counts as a live one`)
      && text.includes("5 of 5 listed thoughts carry a lifecycle.") && text.includes("lifecycle all;") && !text.includes("holds no ticket status") && /status {7}thought/.test(text) && !text.includes("  weight  "),
    "the default report: the lifecycle line has the source, the freshness and the counts, says every thought weighs 1, the thought table has a status column and no weight column, and the old claim that the graph holds no status is gone");
  assert(lifecycleCaveat({ ...cov, with_lifecycle: 0, done: 0, unknown_status: 0, last_sync: null }, on).includes("none is stamped here: 0 of 7 thoughts carry a lifecycle"), "a brain board-sync has not reached says so instead of a freshness");
  assert(lifecycleCaveat({ ...cov, last_sync: null }, on).includes("no linear_updated_at is stamped beside them: 5 of 7"), "…and statuses with their watermarks cleared say that, not nothing (second review pass)");

  // --status open: t1 and t5 weigh 0, so the graph is the one t2, t3, t4, t6
  // and t8 build. Open Brain 3 mentions (t2–t4), degree 2 still (t2, t3 reach
  // PostgreSQL, t4 Anita), support 3; Bun's four are all live and lead.
  const openTop = await topEntities(run, open);
  const obOpen = openTop.byMentions.find((e) => e.id === OB)!;
  const pgOpen = openTop.byMentions.find((e) => e.id === PG)!;
  assert(names(openTop.byMentions).join(",") === "Bun,Open Brain,PostgreSQL,Anita" && obOpen.mentions === 3 && obOpen.degree === 2 && obOpen.support === 3 && pgOpen.mentions === 3 && pgOpen.support === 2,
    `--status open by mentions: Bun's four live thoughts lead; Open Brain 3/2/3 — the Done t1 and Canceled t5 evidence nothing; PostgreSQL 3 mentions (t2, t3 and the unstamped t8), support 2 (${names(openTop.byMentions).join(",")}; ${obOpen.mentions}/${obOpen.degree}/${obOpen.support})`);
  const nOpen = await neighbourhood(run, [OB], open);
  assert(names(nOpen).join(",") === "PostgreSQL,Bun,Anita" && nOpen[0].co_mentions === 2 && nOpen[0].support === 2 && nOpen[0].relations === "depends_on×2" && nOpen[2].co_mentions === 1 && nOpen[2].support === 1 && nOpen[2].mentions === 1,
    `--status open around the subject: PostgreSQL 2+2, Bun 3+0, Anita 1+1 — Anita drops below Bun once t1 is settled, the relation counts follow (${names(nOpen).join(",")}; ${JSON.stringify(nOpen[0])})`);
  const stOpen = await subjectThoughts(run, [OB], nOpen.map((n) => n.id), open);
  assert(stOpen.length === 3 && stOpen.every((t) => t.id !== t1 && t.id !== t5 && t.weight === 1) && stOpen.map((t) => t.status_type).sort().join() === "backlog,started,unstarted",
    `--status open lists the three live thoughts about the subject, each at weight 1 (${stOpen.map((t) => t.status).join(", ")})`);
  const ttOpen = await topThoughts(run, open);
  assert(ttOpen.length === 5 && ttOpen.every((t) => t.id !== t1 && t.id !== t5) && ttOpen.find((t) => t.id === t6)!.status === null && ttOpen.find((t) => t.id === t8)!.status_type === "weird",
    "…and the whole graph's thoughts: t1 and t5 gone; t6 with no lifecycle (its own `status: draft` is not shown as one) and t8 with an unknown one listed — a thought without a lifecycle passes every filter");
  assert((await resolveSubject(run, "Open Brain", open)).subjects[0].mentions === 3, "the subject line's mention count is the run's — 3 under open, not 5");
  const rOpen = render(await graphReport(run, null, open));
  assert(rOpen.includes("lifecycle open;") && rOpen.includes("3 of 5 listed thoughts carry a lifecycle.") && rOpen.includes("--status open: 5 of 7 thoughts weigh in this run (triage, backlog, unstarted, started, plus every thought without a lifecycle"),
    "the open report: the header names the filter, the thought table says how many listed carry a lifecycle, the caveat says what weighed in and that the unstamped pass");
  assert(names(await neighbourhood(run, [ANITA], active)).join() === "Open Brain,Bun" && render(await graphReport(run, "Anita", { ...on, types: ["place"], status: "open" })).includes("shares a --status open thought"),
    "around Anita under active: t4 alone — Open Brain 1+1, Bun 1+0; and a subject with no neighbour under a filter is told which filter emptied it");

  // --status active: t2 and t4 alone; three neighbours tie at 2 and mentions decide.
  const nActive = await neighbourhood(run, [OB], active);
  assert(names(nActive).join(",") === "Bun,PostgreSQL,Anita" && nActive.every((n) => n.co_mentions! + n.support! === 2) && nActive.map((n) => n.mentions).join() === "3,2,1",
    `--status active: a three-way tie at 2 breaks on mentions — Bun 3 (t2, t4, t6), PostgreSQL 2, Anita 1 (${names(nActive).join(",")})`);
  // --status done: t1 alone evidences the neighbourhood; Bun, co-mentioned in
  // live thoughts only, is no candidate — yet keeps the mention the unstamped t6 gives it.
  const nDone = await neighbourhood(run, [OB], doneOnly);
  assert(names(nDone).join(",") === "PostgreSQL,Anita" && nDone.every((n) => n.co_mentions === 1 && n.support === 1),
    `--status done around the subject: PostgreSQL and Anita at 1+1 from t1; Bun is nobody's neighbour (${names(nDone).join(",")})`);
  const doneTop = await topEntities(run, doneOnly);
  assert(doneTop.byMentions.find((e) => e.id === BUN)!.mentions === 1 && doneTop.byMentions.find((e) => e.id === OB)!.support === 1 && (await topThoughts(run, doneOnly)).map((t) => t.id).sort().join() === [t1, t5, t6, t8].sort().join(),
    "--status done in the whole graph: Bun keeps t6's mention (no lifecycle, so it passes), Open Brain's support is t1 alone, and the thoughts are t1, t5 and the two unstamped");

  // --decay-done: t1 and t5 weigh DONE_WEIGHT. Evidence is weighted; degree
  // — neighbours — is not. Sums of quarters are exact, so the equalities are.
  const nDecay = await neighbourhood(run, [OB], decay);
  assert(names(nDecay).join(",") === "PostgreSQL,Bun,Anita" && nDecay[0].co_mentions === 2.25 && nDecay[0].support === 2.25 && nDecay[0].relations === "depends_on×2.25" && nDecay[2].co_mentions === 1.25 && nDecay[2].support === 1.25 && nDecay[1].co_mentions === 3,
    `--decay-done around the subject: PostgreSQL 2.25+2.25, Bun 3+0, Anita 1.25+1.25 — the settled t1 counts a quarter and Anita drops below Bun (${names(nDecay).join(",")}; ${JSON.stringify(nDecay[0])})`);
  const decayTop = await topEntities(run, decay);
  const obDecay = decayTop.byMentions.find((e) => e.id === OB)!;
  assert(obDecay.mentions === 3.5 && obDecay.degree === 2 && obDecay.support === 3.25 && names(decayTop.byMentions)[0] === "Bun" && DONE_WEIGHT === 0.25,
    `…Open Brain 3.5 mentions and 3.25 support with its degree unchanged at 2 — decay weighs evidence, not neighbours — and Bun's four live thoughts lead (${obDecay.mentions}/${obDecay.degree}/${obDecay.support})`);
  const stDecay = await subjectThoughts(run, [OB], nDecay.map((n) => n.id), decay);
  assert(st[0].id === t1 && stDecay[3].id === t1 && stDecay[3].weight === 0.25 && stDecay[3].entities === 2 && stDecay[3].edges === 2 && stDecay[4].id === t5,
    `…and t1, first by default with the most neighbours and edges, ranks fourth at a quarter of its score, t5 last (${stDecay.map((t) => t.weight).join(",")})`);
  const rDecay = render(await graphReport(run, "Open Brain", decay));
  assert(rDecay.includes("lifecycle all (done ×0.25)") && /2\.25 {5}2\.25/.test(rDecay) && rDecay.includes("depends_on×2.25") && /weight  status/.test(rDecay) && rDecay.includes("3.50 mentions") && rDecay.includes("--decay-done: a completed or canceled thought weighs 0.25 in every count (pre-registered, one weight)"),
    "the decayed report: the header says the weight, the quarter counts render to two places in the table, the relation list and the subject line alike (3.50, not 3.5), the weight column appears, and the caveat pre-registers the one weight");
  let threwW = "";
  try { weightsSql({ status: "open", decayDone: true }, []); } catch (e) { threwW = (e as Error).message; }
  assert(/pass one or the other/.test(threwW), "weightsSql refuses decay beside a filter as parseArgs does — a caller building its own Options gets the rule, not decay semantics silently (first review pass)");

  // A row's lifecycle is its TICKET's (first review pass). t1 is the head of
  // SMD-1936 (Done). tSec is a dated section derived from it (`ticket`, no
  // status, its own newer watermark); tPrev is the ticket's earlier row, In
  // Progress when t1 superseded it; tOrphan is derived from a ticket no row holds;
  // tDone is a Done ticket whose edge is Open Brain's only path to Redis.
  await db.query(`UPDATE thoughts SET metadata = metadata || '{"issue": "SMD-1936"}'::jsonb WHERE id = $1`, [t1]);
  const tSec = await thought("SMD-1936 — the ticket · Update 2026-09-20\n\nOpen Brain moved onto PostgreSQL 17.");
  await record(tSec, [E("Open Brain", "project"), E("PostgreSQL", "tool")]);
  await db.query(`UPDATE thoughts SET metadata = metadata || $2::jsonb WHERE id = $1`, [tSec, JSON.stringify({ source: "linear", ticket: "SMD-1936", type: "observation", linear_updated_at: "2026-09-24T12:00:00.000Z" })]);
  const tPrev = await thought("SMD-1936 — the ticket's earlier text, about Open Brain.");
  await record(tPrev, [E("Open Brain", "project")]);
  await db.query(`UPDATE thoughts SET metadata = metadata || $2::jsonb WHERE id = $1`, [tPrev, JSON.stringify({ source: "linear", issue: "SMD-1936", status: "In Progress", status_type: "started", linear_updated_at: "2026-09-25T00:00:00.000Z" })]);
  // tPrev's watermark is NEWER than the head's: only the supersession puts t1 first (second review pass).
  await db.query(`UPDATE thoughts SET supersedes = $2 WHERE id = $1`, [t1, tPrev]);
  const tOrphan = await thought("SMD-9999 — a ticket no row holds · Update 2026-09-21\n\nOpen Brain, noted.");
  await record(tOrphan, [E("Open Brain", "project")]);
  await db.query(`UPDATE thoughts SET metadata = metadata || '{"source": "linear", "ticket": "SMD-9999", "type": "observation", "linear_updated_at": "2026-09-26T00:00:00.000Z"}'::jsonb WHERE id = $1`, [tOrphan]);
  // …and carries the newest watermark of all with no lifecycle: the freshness must not read it (second review pass).
  const tDone = await thought("Open Brain uses Redis, said a settled ticket.");
  await record(tDone, [E("Open Brain", "project"), E("Redis", "tool")], [R("Open Brain", "Redis", "uses")]);
  await stamp(tDone, "Done", "completed");
  // Eleven thoughts now, four of them tied at one entity and no edge, so a
  // read at the default limit of ten would drop one of the four by its uuid —
  // a coin toss per run (the merge's CI run lost tOrphan). Every list in this
  // block is read wide enough to hold every row.
  const wide: GraphOptions = { ...on, limit: 50 };
  const covH = await graphCoverage(run, on);
  assert(covH.thoughts === 11 && covH.with_lifecycle === 8 && covH.done === 5 && covH.last_sync === LATEST && (await graphCoverage(run, open)).weighed === 6,
    `the derived row and the superseded row take the head's lifecycle: 8 of 11 carry one, 5 settled (t1, t5, tSec, tPrev, tDone); the head is the un-superseded row though tPrev's watermark is newer; neither the derived row's own newer watermark nor the lifecycle-less tOrphan's newest is the freshness, the head's is; open weighs t2, t3, t4, t6, t8 and the orphan-ticket tOrphan (${covH.with_lifecycle}/${covH.done}/${covH.last_sync}/${(await graphCoverage(run, open)).weighed})`);
  const ttH = await topThoughts(run, wide);
  assert(ttH.find((t) => t.id === tSec)!.status === "Done" && ttH.find((t) => t.id === tSec)!.status_type === "completed" && ttH.find((t) => t.id === tPrev)!.status === "Done" && ttH.find((t) => t.id === tOrphan)!.status === null,
    "listed by default, the section row and the superseded row show the head's status, Done — not none and not the In Progress tPrev froze at — and the row derived from an unknown ticket shows none");
  const ttOpenH = await topThoughts(run, { ...wide, status: "open" });
  assert(ttOpenH.every((t) => t.id !== tSec && t.id !== tPrev && t.id !== tDone) && ttOpenH.some((t) => t.id === tOrphan),
    "--status open lists neither the Done ticket's section nor its earlier row nor the Done tDone, and lists the row whose ticket no row holds (its own lifecycle: none)");
  const obAll = (await topEntities(run, on)).byMentions.find((e) => e.id === OB)!;
  const obOpenH = (await topEntities(run, open)).byMentions.find((e) => e.id === OB)!;
  const obDecayH = (await topEntities(run, decay)).byMentions.find((e) => e.id === OB)!;
  assert(obAll.degree === 3 && obOpenH.degree === 2 && obDecayH.degree === 3 && obOpenH.mentions === 4,
    `Open Brain's degree: 3 by default (PostgreSQL, Anita, Redis), 2 under open — Redis is reached by the Done tDone alone, so the filter removes the edge — and 3 under decay, which weighs evidence and leaves neighbours; open mentions 4 (t2, t3, t4, tOrphan) (${obAll.degree}/${obOpenH.degree}/${obDecayH.degree}, ${obOpenH.mentions})`);
  const nOpenH = await neighbourhood(run, [OB], open);
  const nAllH = await neighbourhood(run, [OB], on);
  assert(names(nOpenH).join(",") === "PostgreSQL,Bun,Anita" && nOpenH[0].co_mentions === 2 && nAllH.find((n) => n.name === "PostgreSQL")!.co_mentions === 4 && nAllH.some((n) => n.name === "Redis"),
    `under open the section row adds nothing to PostgreSQL (co 2, not 3) and Redis is no neighbour; by default the section counts (co 4) and Redis is one (${names(nOpenH).join(",")}; ${nAllH.find((n) => n.name === "PostgreSQL")!.co_mentions})`);
  assert((await topThoughts(run, { ...wide, status: "done" })).map((t) => t.id).sort().join() === [t1, t5, t6, t8, tSec, tDone, tPrev, tOrphan].sort().join(),
    "--status done lists the section row and the earlier row with their Done head, the Done tDone, and — passing every filter — the two without a lifecycle and the row whose ticket no row holds");
  await db.query(`UPDATE thoughts SET supersedes = NULL, metadata = metadata - 'issue' WHERE id = $1`, [t1]);
  for (const id of [tSec, tDone, tPrev, tOrphan]) await drop(id);
  assert((await graphCoverage(run, on)).thoughts === 7 && (await graphCoverage(run, on)).entities === 4, "the ticket rows are gone again");

  // The default lists every in-scope entity, an orphan at 0 included — the
  // filter alone drops what no kept thought mentions (first review pass).
  const tZed = await thought("Zed alone.");
  await record(tZed, [E("Zed", "tool")]);
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [tZed]);
  assert((await graphCoverage(run, on)).entities === 5 && (await topEntities(run, on)).byMentions.some((e) => e.name === "Zed" && e.mentions === 0) && !(await topEntities(run, open)).byMentions.some((e) => e.name === "Zed"),
    "an entity whose thought was deleted and not yet pruned is in scope, listed at 0 by default as before, and absent under a filter");
  await db.exec(`SELECT prune_orphan_entities()`);
  assert((await graphCoverage(run, on)).entities === 4, "…and pruned away");

  // The flags, and the helpers the SQL rests on.
  const p = parseArgs(["--url", "postgres://x", "Open Brain", "--limit", "5", "--types", "tool,project", "--no-edges", "--keep-numeric", "--json", "--status", "open"]);
  assert(!("error" in p) && p.subject === "Open Brain" && p.opts.limit === 5 && p.opts.types.join() === "tool,project" && !p.opts.edges && !p.opts.excludeNumeric && p.json && p.url === "postgres://x" && p.opts.status === "open" && !p.opts.decayDone, "every flag lands");
  const pd = parseArgs(["--decay-done"]);
  assert(!("error" in pd) && pd.opts.decayDone && pd.opts.status === "all" && !("error" in parseArgs(["--decay-done", "--status", "all"])), "--decay-done lands, alone or with --status all");
  const bare = parseArgs([]);
  assert(!("error" in bare) && bare.subject === null, "no argument is the whole graph");
  for (const [argv, why] of [[["--limit", "0"], "limit"], [["--limit"], "needs a value"], [["--types", "vegetable"], "vegetable"], [["a", "b"], "one subject"], [["--bogus"], "unknown flag"], [["--types", ""], "none given"],
                             [["--limit", "5", "--limit", "50"], "given twice"], [["--json", "x", "--json"], "given twice"], [[""], "subject is empty"], [["  "], "subject is empty"],
                             [["--limit", "0x10"], "decimal"], [["--limit", "1e2"], "decimal"], [["--limit", " 7"], "decimal"], [["--limit", "7.0"], "decimal"],
                             [["--status", "closed"], "one of all, open, active, done"], [["--status"], "needs a value"], [["--status", "Open"], "one of"], [["--status", "toString"], "one of"], [["--status", "__proto__"], "one of"], [["--decay-done", "--status", "open"], "pass one or the other"], [["--status", "done", "--decay-done"], "already decides them"]] as [string[], string][])
    assert("error" in parseArgs(argv) && (parseArgs(argv) as { error: string }).error.includes(why), `refused: ${argv.join(" ")} (${why})`);
  assert(pgArray(["a", "b"]) === "{a,b}" && pgArray([]) === "{}", "pgArray builds the literal");
  let threw = "";
  try { pgArray(["a b"]); } catch (e) { threw = (e as Error).message; }
  assert(/needs quoting/.test(threw), "…and refuses a value it cannot write unquoted");
  // The numeric rule, shape by shape — bare numbers, ports, addresses and
  // spaced digits in; anything with a letter, or an empty or padded name,
  // out. Postgres is the one engine that reads the pattern since the sixth
  // pass (every rung marks its own rows), so it is asked of Postgres.
  const numeric = async (s: string) => (await db.query<{ m: boolean }>(`SELECT $1 ~ $2 AS m`, [s, NUMERIC_NAME_RE])).rows[0].m;
  for (const [name, expected] of [["021", true], ["11434", true], ["127.0.0.1", true], ["10 000", true], ["0:0", true], ["1.", true],
                                  ["pg16", false], ["smd 1938", false], ["migration 021", false], ["x021", false], ["", false], [" 21", false], ["2 1x", false]] as [string, boolean][])
    assert((await numeric(name)) === expected, `${JSON.stringify(name)} is ${expected ? "" : "not "}a numeric name`);
  const dup = parseArgs(["--types", "tool,tool,tool,tool,tool,tool"]);
  assert(!("error" in dup) && dup.opts.types.join() === "tool", "a repeated type is one type");
  assert(!render(await graphReport(run, null, { ...on, types: ["tool", "tool", "tool", "tool", "tool", "tool"] as GraphOptions["types"] })).includes("every type"),
    "…and six copies of one type are not \"every type\" in the header line — membership, not length (first review pass)");
  assert(render(await graphReport(run, null, on)).includes("scope every type"), "…while the full list is");

  // The whole-graph lists come from one pass, each cut at the limit.
  const two = await topEntities(run, { ...on, limit: 2 });
  assert(names(two.byMentions).join(",") === "Open Brain,PostgreSQL" && names(two.byDegree).join(",") === "Open Brain,PostgreSQL" && two.byMentions.every((e) => !("rm" in e)),
    `…each cut at the limit, the rank columns stripped (${names(two.byMentions).join(",")} / ${names(two.byDegree).join(",")})`);
  const one = await topEntities(run, { ...on, limit: 1, types: ["tool"] });
  assert(names(one.byMentions).join() === "Bun" && names(one.byDegree).join() === "Bun", "…and a row in one list only is in that list only");

  // A fuzzy resolution with several guesses ranks around the FIRST alone
  // (second review pass): "Open Brian" is near "open brain" (0.47) and near a
  // second project "open brains" (0.40) that shares a thought with Bun. Under
  // a union of the guesses Bun would count that thought as a co-mention of the
  // subject; ranked around the first, the neighbourhood is exactly the exact
  // run's.
  const t9 = await thought("Open Brains uses Bun.");
  await record(t9, [E("Open Brains", "project"), E("Bun", "tool")], [R("Open Brains", "Bun", "uses")]);
  const guessed = await graphReport(run, "Open Brian", on);
  assert(guessed.resolution?.how === "fuzzy" && guessed.resolution.subjects.length === 2 && guessed.resolution.subjects[0].id === OB && guessed.resolution.subjects[1].name === "Open Brains",
    `two guesses, the nearer first (${guessed.resolution?.subjects.map((s) => `${s.name} ${s.score.toFixed(2)}`).join(", ")})`);
  assert(guessed.subject_ids.join() === OB, "…and only the first is ranked around");
  const shape = (ns: { name: string; co_mentions: number; support?: number }[] | undefined) => JSON.stringify((ns ?? []).map((n) => [n.name, n.co_mentions, n.support]));
  assert(shape(guessed.neighbours) === shape(r1.neighbours) && guessed.neighbours![2].name === "Bun" && guessed.neighbours![2].co_mentions === 3,
    `…so every neighbour's co_mentions and support are the exact run's — Bun at 3, not 4 (${shape(guessed.neighbours)})`);
  assert(JSON.stringify(guessed.thoughts.map((t) => t.id)) === JSON.stringify(r1.thoughts.map((t) => t.id)), "…and the thoughts are the exact run's");
  const guessedText = render(guessed);
  assert(guessedText.includes("ranked around the first") && /\n {2}▸ project "Open Brain"/.test(guessedText) && /\n {4}project "Open Brains"/.test(guessedText),
    "the report says guesses are ranked around the first and marks which one");
  assert((await graphReport(run, "Open Brain", on)).subject_ids.join() === OB && (await graphReport(run, "Linear", on)).subject_ids.length === 0, "an exact subject is ranked around whole; a miss around nothing");
  await drop(t9);
  assert((await graphCoverage(run, on)).entities === 4, "the extra guess is gone again");

  // The alias rung can return several different names too — two entities the
  // model gave the same alias — and the same rule applies: ranked around the
  // first name's entities, the rest listed (third review pass).
  const t10 = await thought("Supabase Postgres, hosted.");
  await record(t10, [E("Supabase Postgres", "tool", ["Postgres"])]);
  const aliased = await resolveSubject(run, "Postgres", on);
  assert(aliased.how === "alias" && aliased.subjects.length === 2 && aliased.subjects[0].id === PG && aliased.subjects[1].name === "Supabase Postgres",
    `alias: two entities carry the alias, the more-mentioned first (${aliased.subjects.map((s) => s.name).join(", ")})`);
  assert(rankedSubjects(aliased).join() === PG, "…and only the first name's entity is ranked around");
  const aliasedReport = await graphReport(run, "Postgres", on);
  assert(aliasedReport.subject_ids.join() === PG && render(aliasedReport).includes("several names match; ranked around the first") && /\n {4}tool "Supabase Postgres"/.test(render(aliasedReport)),
    "…the report says so and leaves the second unmarked");
  assert(rankedSubjects(exact).join() === OB && rankedSubjects(none).length === 0, "an exact subject is ranked whole; nothing, nothing");
  await drop(t10);

  // A numeric name that IS an entity stops the ladder before the guesses: with
  // a near name "021x" in the graph, "021" must not be guessed past to it
  // (third review pass).
  const t11 = await thought("021x is a tool.");
  await record(t11, [E("021x", "tool")]);
  const near = await resolveSubject(run, "021x", on);
  assert(near.how === "exact" && near.subjects[0].name === "021x", "021x has a letter, so it is a subject under the default scope");
  const stopped = await resolveSubject(run, "021", on);
  assert(stopped.how === "none" && stopped.excluded === true, `021 is not guessed past to 021x: none, excluded (${stopped.how})`);
  assert(render(await graphReport(run, "021", on)).includes("pass --keep-numeric") && (await resolveSubject(run, "021", keep)).how === "exact", "…the flag is named, and kept it is exact");
  const noNeighbour = render(await graphReport(run, "021x", { ...on, types: ["place"] }));
  assert(noNeighbour.includes("No neighbour:") && !noNeighbour.includes("\n\n\n"), "a subject with nothing in scope beside it says so, with one blank line, not two (fourth review pass)");
  const guessedNumeric = await resolveSubject(run, "0219", on);
  assert(guessedNumeric.how === "fuzzy" && guessedNumeric.subjects[0].name === "021x", `a numeric name that is NOT an entity still reaches the guesses (${guessedNumeric.how})`);
  // The fuzzy rung under the same rule as the others: "02" is near "021" (0.4)
  // and near "021x" (0.33); with 021 out of the rule the one guess is 021x,
  // and no guess counts as hidden while a guess in the rule exists.
  const nearNumeric = await resolveSubject(run, "02", on);
  assert(nearNumeric.how === "fuzzy" && nearNumeric.subjects.map((s) => s.name).join() === "021x" && nearNumeric.hidden_guesses === 0,
    `under the rule the one guess for "02" is 021x — 021 is never offered (${nearNumeric.how}, ${nearNumeric.subjects.map((s) => s.name).join(",")})`);
  const nearKept = await resolveSubject(run, "02", keep);
  assert(nearKept.how === "fuzzy" && nearKept.subjects.some((s) => s.name === "021"), `…and kept, 021 is among the guesses (${nearKept.subjects.map((s) => s.name).join(",")})`);
  await drop(t11);
  assert((await graphCoverage(run, on)).entities === 4, "the fixture is back to four");
  // With no near name in the rule's scope, the only guess for "02" is 021: a
  // miss (no entity, exit 1's case — "02" is not 021), and the miss counts the
  // guess the rule hid, so the reader knows --keep-numeric would offer one
  // (seventh review pass: exit 3 is for a subject that IS an entity).
  const onlyNumeric = await resolveSubject(run, "02", on);
  assert(onlyNumeric.how === "none" && onlyNumeric.excluded === false && onlyNumeric.hidden_guesses === 1,
    `a fuzzy near-miss whose only guess is numeric is a miss with one hidden guess, not an exclusion (${onlyNumeric.how}, ${onlyNumeric.excluded}, ${onlyNumeric.hidden_guesses})`);
  const onlyNumericText = render(await graphReport(run, "02", on));
  assert(onlyNumericText.includes("except 1 numeric-named entity the rule hides — --keep-numeric offers it as guesses") && !onlyNumericText.includes("pass --keep-numeric to rank it"),
    "…the miss line counts the hidden guess and does not claim the subject is an entity");
  assert((await resolveSubject(run, "02", keep)).how === "fuzzy", "…and kept, it is a guess");
  assert((await resolveSubject(run, "qqqq", on)).hidden_guesses === 0 && numSubject.hidden_guesses === 0, "a plain miss and an exclusion hide no guess");

  // "Rows in the rule sort first, so a LIMIT keeps them": five numeric near
  // names beside two lettered ones. Without that ordering the fuzzy rung's
  // LIMIT 5 would fill with the numeric rows, every one excluded, and report
  // five hidden guesses and no entity where two guesses exist.
  const t15 = await thought("Five numeric near names and two lettered ones.");
  await record(t15, [E("0211", "tool"), E("0212", "tool"), E("0213", "tool"), E("0214", "tool"), E("0215", "tool"), E("021x", "tool"), E("021y", "tool")]);
  const cut = await resolveSubject(run, "021z", on);
  assert(cut.how === "fuzzy" && cut.subjects.map((s) => s.name).sort().join() === "021x,021y",
    `the two lettered near names are the guesses, the five numeric ones sorted past the limit (${cut.how}: ${cut.subjects.map((s) => s.name).join(",")})`);
  const cutKept = await resolveSubject(run, "021z", keep);
  assert(cutKept.how === "fuzzy" && cutKept.subjects.length === 5, `kept, the limit's five come from all seven (${cutKept.subjects.length})`);
  await drop(t15);

  // Model output is rendered clean: a control sequence in a name never reaches
  // the terminal, and a newline in one never breaks a row (sixth review pass).
  const t14 = await thought("An entity with a hostile name.");
  await record(t14, [E("Evil\u001b[31mName\nSplit", "tool")]);
  const hostile = render(await graphReport(run, null, on));
  assert(!hostile.includes("\u001b") && hostile.includes("Evil[31mName Split"), "the rendered table carries no control character — the escape is gone, its bare text stays — and one space for the newline");
  await drop(t14);

  // A non-numeric name that is an ALIAS of a numeric-named entity is the same
  // stop: the match exists, the rule hid it, exit 3 not 1 (fifth review pass).
  const t13 = await thought("021, the twenty-first migration.");
  await record(t13, [E("021", "person", ["twentyfirst"])]);
  const viaAlias = await resolveSubject(run, "twentyfirst", on);
  assert(viaAlias.how === "none" && viaAlias.excluded === true, `an alias of 021 resolves to none, excluded — not "no alias or merged name" (${viaAlias.how}, ${viaAlias.excluded})`);
  assert((await resolveSubject(run, "twentyfirst", keep)).how === "alias", "…and kept, the alias rung finds it");
  await db.query(`DELETE FROM thoughts WHERE id = $1`, [t13]);
  await db.query(`UPDATE ob1_entities SET aliases = '{}' WHERE id = $1`, [NUM]);
}

console.log("\n[45] Migration 049: the agent registry records a capture-only key's scope, and the CHECK still refuses a scope the server does not mint (SMD-1298)");
{
  // 010's CHECK named read and write. resolve_agent() writes the presented
  // scope into ob1_agent_keys; a capture key (SMD-1298) would have failed the
  // CHECK and landed every capture unattributed. Asserted of the LIVE
  // constraint after every file applied.
  const hash = "e".repeat(64);
  const r = (await db.query<{ r: Record<string, unknown> }>(`SELECT resolve_agent($1, 'session-hook', 'capture') AS r`, [hash])).rows[0].r;
  assert(r.ok === true && typeof r.agent_id === "string", `resolve_agent registers a capture-scoped key (${JSON.stringify(r)})`);
  const scope = (await db.query<{ scope: string }>(`SELECT scope FROM ob1_agent_keys WHERE key_hash = $1`, [hash])).rows[0]?.scope;
  assert(scope === "capture", `…and records the scope as presented (${scope})`);
  const again = (await db.query<{ r: Record<string, unknown> }>(`SELECT resolve_agent($1, 'session-hook', 'capture') AS r`, [hash])).rows[0].r;
  assert(again.ok === true && again.agent_id === r.agent_id && again.created === false, "a second request resolves to the same agent");
  // The mirror: the widening admitted one value, not any. The refusal names
  // the constraint, so a caller reading the error knows where the rule lives.
  let refused = "";
  try { await db.query(`SELECT resolve_agent($1, 'stranger', 'admin')`, ["f".repeat(64)]); } catch (e) { refused = (e as Error).message; }
  assert(/ob1_agent_keys_scope_check/.test(refused), `a scope the server does not mint is still refused by the named CHECK (${refused.slice(0, 90)})`);
  // Every CHECK on the scope column ALONE (conkey = {scope}) — the shape 049 drops and preflight reads (ninth and tenth review passes).
  const CHECK_DEF_SQL = `SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'scope' WHERE t.relname = 'ob1_agent_keys' AND n.nspname = 'public' AND c.contype = 'c' AND c.conkey = ARRAY[a.attnum]`;
  const def = (await db.query<{ d: string }>(CHECK_DEF_SQL)).rows.map((x) => x.d);
  assert(def.length === 1, `one constraint under the name (${def.length})`);
  assert(/'read'/.test(def[0] ?? "") && /'write'/.test(def[0] ?? "") && /'capture'/.test(def[0] ?? ""), `the live CHECK names read, write and capture (${def[0]})`);
  // Re-applying lands the same shape: still one constraint, still the three.
  await reapply("049");
  const after = (await db.query<{ d: string }>(CHECK_DEF_SQL)).rows.map((x) => x.d);
  assert(after.length === 1 && after[0] === def[0], "re-applying 049 leaves one constraint with the same definition");
  // The two-value rule under ANOTHER name — a restore, a hand-written 010 — is
  // dropped too, else it would stand beside the new one and refuse capture keys still (ninth review pass).
  await db.query(`ALTER TABLE ob1_agent_keys RENAME CONSTRAINT ob1_agent_keys_scope_check TO ob1_agent_keys_scope_check_old`);
  await db.query(`ALTER TABLE ob1_agent_keys DROP CONSTRAINT ob1_agent_keys_scope_check_old`);
  await db.query(`ALTER TABLE ob1_agent_keys ADD CONSTRAINT scope_two_values CHECK (scope IN ('read', 'write')) NOT VALID`); // a capture row exists by now
  await reapply("049");
  const renamed = (await db.query<{ d: string }>(CHECK_DEF_SQL)).rows.map((x) => x.d);
  assert(renamed.length === 1 && renamed[0] === def[0], `049 drops a two-value CHECK under another name and leaves the three-value one alone (${renamed.length} constraint(s))`);
  // A rule spanning scope and another column is not the scope rule: 049 leaves it (tenth review pass — a match on the word dropped it).
  await db.query(`ALTER TABLE ob1_agent_keys ADD CONSTRAINT scope_with_hash CHECK (key_hash IS NOT NULL OR scope IS NULL) NOT VALID`);
  await reapply("049");
  const spanning = (await db.query<{ n: string }>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = 'ob1_agent_keys'::regclass AND contype = 'c' ORDER BY conname`)).rows.map((x) => x.n);
  assert(spanning.includes("scope_with_hash") && spanning.includes("ob1_agent_keys_scope_check"), `a CHECK spanning scope and another column survives 049 beside the scope rule (${spanning.join(", ")})`);
  await db.query(`ALTER TABLE ob1_agent_keys DROP CONSTRAINT scope_with_hash`);
  // The table without its scope column — a hand-built registry — is refused by name, not with a bare "column does not exist" (eleventh review pass).
  await db.query(`ALTER TABLE ob1_agent_keys RENAME COLUMN scope TO scope_gone`);
  let noColumn = "";
  try { await reapply("049"); } catch (e) { noColumn = (e as Error).message; }
  assert(/migration 049 needs 010 \(ob1_agent_keys\.scope\); this schema lacks it/.test(noColumn), `049 on a registry without the column refuses by name (${noColumn.slice(0, 80)})`);
  await db.query(`ALTER TABLE ob1_agent_keys RENAME COLUMN scope_gone TO scope`);
  await reapply("049");
  assert((await db.query<{ d: string }>(CHECK_DEF_SQL)).rows.length === 1, "…and applies again once the column is back");
  const c = (await db.query<{ c: string | null }>(COLUMN_COMMENT_SQL, ["ob1_agent_keys", "scope"])).rows[0]?.c ?? "";
  assert(/\bcapture\b/.test(c) && /SMD-1298/.test(c) && /Recorded rather than enforced/.test(c),
    "the column's live comment names the third scope, the ticket, and keeps 010's rule that the scope is recorded, not enforced");
}

console.log("\n[46] Migration 050: the actor on the row — who wrote the current text, from the key, in metadata where 014's route filters on it; the actor follows the content; the backfill makes the row agree with the log (SMD-1726)");
{
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const refused = async (sql: string, params: unknown[] = []) => { try { await db.query(sql, params); return ""; } catch (e) { return (e as Error).message; } };
  type Meta = Record<string, unknown>;
  type Bf = { ok: boolean; rows: number; differing: number; awaiting: number };
  type Audit = { action: string; actor_name: string | null; origin: string | null; diff: { content?: { after?: string }; metadata?: Meta & { before?: Meta; after?: Meta } } };
  const metaOf = async (id: string) => one<{ m: Meta | null; u: string }>(`SELECT metadata AS m, updated_at::text AS u FROM thoughts WHERE id = $1::uuid`, [id]);
  /** The two keys as "kind/name", "-" for absent — the shape every assertion below compares. */
  const marks = async (id: string) => { const r = await metaOf(id); return `${r?.m?.actor_kind ?? "-"}/${r?.m?.actor_name ?? "-"}`; };
  const audits = async (id: string) => q<Audit>(`SELECT action, actor_name, origin, diff FROM thought_audit WHERE thought_id = $1::uuid ORDER BY created_at, id`, [id]);
  const auditCount = async () => (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).c;
  const cap = async (content: string, envelope: Record<string, unknown>, at: number) =>
    (await one<{ r: { id: string; existed: boolean } }>(`SELECT upsert_thought($1::text, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(envelope), unit(at)])).r;
  const edit = async (id: string, content: string | null, patch: Meta | null, actor: Record<string, unknown> | null) =>
    (await one<{ r: { ok: boolean; error?: string } }>(
      `SELECT update_thought($1::uuid, $2::text, $3::jsonb, NULL, NULL, NULL, $4::jsonb, NULL, NULL, NULL) AS r`,
      [id, content, patch === null ? null : JSON.stringify(patch), actor === null ? null : JSON.stringify(actor)])).r;
  const src = async (sig: string) => String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).s);
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_agents`);
  await db.exec(`SELECT set_agent_kind('op-key', 'operator'); SELECT set_agent_kind('bot-key', 'agent'); SELECT set_agent_kind('imp-key', 'ingested'); SELECT set_agent_kind('id-key', 'agent')`);
  const idKey = (await one<{ r: { agent_id: string } }>(`SELECT resolve_agent($1, 'id-key', 'write') AS r`, ["c".repeat(64)])).r;

  // The shape: a BEFORE row trigger on INSERT OR UPDATE beside 046's writers,
  // reading the envelope through 008's reader and the kind through 046's one
  // lookup; the column's comment names the keys the database owns.
  const trg = await one<{ tgtype: number }>(`SELECT tgtype FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_stamp_actor'`);
  assert(trg?.tgtype === 23, `thoughts_stamp_actor is a BEFORE INSERT OR UPDATE row trigger (tgtype ${trg?.tgtype}: row 1 + before 2 + insert 4 + update 16)`);
  const stamp = await src("ob1_stamp_actor()");
  // 055 (SMD-2115) lifts the two arms into ob1_actor_stamp (a new text) and
  // ob1_actor_stamp_kept (the same text); the trigger keeps the pass-through
  // and the same-text detection and calls them, so the pins read the arm.
  const arm = await src("ob1_actor_stamp(jsonb)");
  assert(/ob1:actor-on-the-row-from-the-key/.test(arm) && /ob1_current_actor\(\)/.test(arm) && /ob1_registry_kind\(v_agent, v_name\)/.test(arm),
    "the stamp's new-text arm carries 050's sentinel, reads the envelope through 008's reader and the kind through 046's one lookup — the three cannot drift");
  assert(/IF v_agent IS NOT NULL OR v_name IS NOT NULL THEN\s+v_kind := ob1_registry_kind/.test(arm), "…and probes the registry only when the envelope names an id or a name (a raw write needs no SELECT on ob1_agents)");
  assert(/NEW\.metadata := ob1_actor_stamp_kept\(NEW\.metadata, OLD\.metadata\)/.test(stamp) && /NEW\.metadata := ob1_actor_stamp\(NEW\.metadata\)/.test(stamp) && /content_fingerprint_of\(OLD\.content\)/.test(stamp),
    "…the trigger calls the kept arm on the same text and the new-text arm otherwise, the two-hash detection still its own (055)");
  assert(lastDefinerOf("upsert_thought").startsWith("046") && lastDefinerOf("update_thought").startsWith("046") && lastDefinerOf("thoughts_write_audit").startsWith("055") && lastDefinerOf("ob1_stamp_actor").startsWith("055"),
    "050 redefined no writer and not the audit trigger — the stamp is a trigger of its own beside them; 055 is the last definer of both triggers, calling the rules as functions");
  const colc = (await one<{ c: string | null }>(COLUMN_COMMENT_SQL, ["thoughts", "metadata"])).c ?? "";
  assert(/actor_kind/.test(colc) && /actor_name/.test(colc) && /050/.test(colc) && /cannot set them/.test(colc), "thoughts.metadata's comment names the two keys the database writes and a caller cannot");
  const bfSrc = await src("backfill_thought_actors(integer)");
  assert(/WHERE a\.action = 'capture' OR a\.fb IS DISTINCT FROM a\.fa/.test(bfSrc) && /content_fingerprint_of\(a\.diff->'content'->>'after'\)\s+AS fa\s+FROM thought_audit a[\s\S]*?OFFSET 0\s+\) a/.test(bfSrc) && /a\.fa IS NOT DISTINCT FROM f\.fp\) DESC,\s+a\.created_at DESC, a\.seq DESC/.test(bfSrc) && /t\.updated_at IS NOT DISTINCT FROM d\.updated_at/.test(bfSrc),
    "the backfill reads the audit row that changed the text by 003's rule — the trigger's rule — the one whose text stands first, then by created_at, then seq (never seq alone: a pre-050 seq is heap order — second review pass), and re-checks updated_at on the locked row, so a thought edited since the scan is left to the next pass");
  assert(/\(a\.action = 'capture' AND NOT bool_or\(a\.action = 'update'\) OVER \(\)\)\) AS vouched/.test(bfSrc), "a capture is vouched from the set — no update ever changed the text — not from sorting first (fourth review pass)");
  assert(/CROSS JOIN LATERAL \([\s\S]*?THEN content_fingerprint_of\(t\.content\) END AS fp\s+OFFSET 0\) f/.test(bfSrc), "the thought's own text is hashed once per thought behind an OFFSET 0 fence, and each candidate row's two texts once behind another — without them the planner ran the hashes in every place the value is read (third review pass)");
  assert(/COALESCE\(ob1_registry_kind\(w\.canonical_agent_id, w\.name\), w\.actor_kind\)/.test(bfSrc) && /NULLIF\(btrim\(a\.actor_name\), ''\) AS name/.test(bfSrc), "…the registry's kind now first, the audit row's stamp as the fallback — a reclassified key reaches its rows — and the name trimmed as the stamp trims it (first review pass)");
  assert(!/DROP TABLE/.test(bfSrc) && /CREATE TEMP TABLE %I ON COMMIT DROP/.test(bfSrc), "…and names its temp table per call, dropped at commit, with nothing dropped by hand (023's shape; CLAUDE.md's rail)");
  assert(/LOCK TABLE thoughts IN EXCLUSIVE MODE;\s+-- A stamp is not an edit[\s\S]*?ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at/.test(bfSrc), "…and takes thoughts IN EXCLUSIVE MODE before holding the trigger off, as 023 does — the ALTER's own lock deadlocked against an edit in flight (run-it, first review pass)");
  assert(/AND \(t\.metadata->>'actor_kind' IS DISTINCT FROM d\.kind/.test(bfSrc), "…and re-checks the marks themselves under the lock, so a row another pass marked meanwhile is neither written nor counted");
  const seqCol = await one<{ is_identity: string; data_type: string }>(`SELECT is_identity, data_type FROM information_schema.columns WHERE table_name = 'thought_audit' AND column_name = 'seq'`);
  assert(seqCol?.is_identity === "YES" && seqCol.data_type === "bigint", "thought_audit gains seq, a bigint identity: the order rows were written in, which created_at (one value per transaction) and id (random) are not");
  assert(/non-DEFAULT value into column "seq"/.test(await refused(`INSERT INTO thought_audit (thought_id, action, diff, seq) VALUES (gen_random_uuid(), 'capture', '{}', 5)`)), "…assigned by the table, not the writer (second review pass: the first spelling of this line passed on `|| true`)");

  // The stamp: from the key, never the payload.
  const op = await cap("050: the operator typed this", { metadata: { source: "mcp" }, actor: { name: "op-key", via: "open-brain" } }, 40);
  assert((await marks(op.id)) === "operator/op-key", `a capture through a classified key carries actor_kind and actor_name in metadata (${await marks(op.id)})`);
  let a = await audits(op.id);
  assert(a.length === 1 && a[0].diff.metadata?.actor_kind === "operator" && a[0].diff.metadata?.actor_name === "op-key" && a[0].actor_name === "op-key",
    "…and the capture's audit row records the stamped metadata: the mark is in the log as it is on the row");
  const claim = await cap("050: an agent claiming to be the operator", { metadata: { actor_kind: "operator", actor_name: "op-key", source: "mcp" }, actor: { name: "bot-key", via: "open-brain" } }, 41);
  assert((await marks(claim.id)) === "agent/bot-key", `a payload's own actor_kind and actor_name are overwritten from the key — the mutant that trusts the payload fails here (${await marks(claim.id)})`);
  assert((await metaOf(claim.id))?.m?.source === "mcp", "…and the rest of the payload's metadata is kept");
  const ghost = await cap("050: an unclassified key claiming a kind", { metadata: { actor_kind: "operator" }, actor: { name: "ghost-key" } }, 42);
  assert((await marks(ghost.id)) === "-/ghost-key", `an unclassified key stamps its name and no kind: the claim removed, nothing invented (${await marks(ghost.id)})`);
  const byId = await cap("050: a writer known by id alone", { metadata: {}, actor: { agent_id: idKey.agent_id } }, 43);
  assert((await marks(byId.id)) === "agent/-", `an envelope carrying only an agent id stamps the id's kind and no name (${await marks(byId.id)})`);
  const badId = await cap("050: a malformed id falls to the name", { metadata: {}, actor: { name: "imp-key", agent_id: "not-a-uuid" } }, 44);
  assert((await marks(badId.id)) === "ingested/imp-key", `a malformed agent_id is no id: the name decides (${await marks(badId.id)})`);
  const RAW = "47474747-4747-4747-8747-474747474747", NUL = "47474747-4747-4747-8747-474747474748", ORPHAN = "47474747-4747-4747-8747-474747474749";
  await db.exec(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${RAW}', '050: a raw insert claiming a kind', '{"actor_kind": "operator", "actor_name": "op-key", "keep": 1}'::jsonb, '${unit(45)}'::vector)`);
  let m = await metaOf(RAW);
  assert(m?.m?.actor_kind === undefined && m?.m?.actor_name === undefined && m?.m?.keep === 1, `a raw write with no envelope keeps neither key — a mutation from outside the server names nobody — and the rest of its metadata (${JSON.stringify(m?.m)})`);
  await db.exec(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${NUL}', '050: a raw insert with null metadata', NULL, '${unit(46)}'::vector)`);
  assert((await metaOf(NUL))?.m === null, "…and a NULL metadata stays NULL: the stamp adds keys, it does not decide the column");

  // The actor follows the content.
  let r = await edit(op.id, null, { topics: ["x"], actor_kind: "agent", actor_name: "bot-key" }, { name: "bot-key" });
  assert(r.ok === true && (await marks(op.id)) === "operator/op-key" && ((await metaOf(op.id))?.m?.topics as string[])?.[0] === "x",
    `a metadata-only edit by another key keeps the mark whatever the patch said, and lands the rest of the patch (${await marks(op.id)})`);
  a = await audits(op.id);
  assert(a.length === 2 && a[1].diff.metadata?.after?.actor_kind === "operator" && a[1].actor_name === "bot-key", "…the audit row shows the patch landing around the mark, under the editor's name");
  r = await edit(op.id, null, { actor_kind: "agent" }, { name: "bot-key" });
  assert(r.ok === true && (await audits(op.id)).length === 2, "…a patch that tries only the two keys changes nothing, so 008 writes no row");
  r = await edit(op.id, "050: the agent rewrote the operator's note", null, { name: "bot-key", via: "open-brain" });
  assert(r.ok === true && (await marks(op.id)) === "agent/bot-key", `an edit that changes the content re-stamps from the editor's key: the text is the agent's now (${await marks(op.id)})`);
  a = await audits(op.id);
  assert(a.length === 3 && a[2].diff.content?.after === "050: the agent rewrote the operator's note" && a[2].diff.metadata?.before?.actor_kind === "operator" && a[2].diff.metadata?.after?.actor_kind === "agent",
    "…and the log holds the handover — content and mark in one diff");
  r = await edit(op.id, "050: the agent rewrote the operator's note", { note: "same text" }, { name: "op-key" });
  assert(r.ok === true && (await marks(op.id)) === "agent/bot-key", "018's unchanged edit — the same text, from the operator's key — keeps the agent's mark: the content did not move");
  const reCap = await cap("050: an agent claiming to be the operator", { metadata: { actor_kind: "ingested", actor_name: "x", extra: true }, actor: { name: "op-key" } }, 41);
  assert(reCap.existed === true && (await marks(claim.id)) === "agent/bot-key" && (await metaOf(claim.id))?.m?.extra === true,
    `a re-capture merges the payload's metadata and keeps the mark: the text is unchanged, so its first writer's — through EXCLUDED, which the INSERT's stamp had already rewritten (${await marks(claim.id)})`);
  await db.exec(`UPDATE thoughts SET content = '050: a raw content update' WHERE id = '${op.id}'`);
  assert((await marks(op.id)) === "-/-", `a raw content update with no envelope removes the mark: nobody vouches for this text (${await marks(op.id)})`);
  await db.exec(`UPDATE thoughts SET embedding = '${unit(47)}'::vector WHERE id = '${claim.id}'`);
  assert((await marks(claim.id)) === "agent/bot-key", "a raw write that leaves the content — a re-embed — leaves the mark");
  r = await edit(claim.id, "050:   AN AGENT claiming to be the operator", null, { name: "op-key" });
  assert(r.ok === true && (await marks(claim.id)) === "agent/bot-key", `the same text by 003's rule — case and whitespace folded, 018's "unchanged" edit — keeps the mark whoever sent it (${await marks(claim.id)}; first review pass)`);
  const ARR = "47474747-4747-4747-8747-474747474751", SCL = "47474747-4747-4747-8747-474747474752";
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('ob1.actor', '{"name": "op-key"}', true)`);
    await tx.query(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${ARR}', '050: an array for metadata', '[1]'::jsonb, '${unit(55)}'::vector)`);
    await tx.query(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${SCL}', '050: a scalar for metadata', '"str"'::jsonb, '${unit(56)}'::vector)`);
  });
  assert(JSON.stringify((await metaOf(ARR))?.m) === "[1]" && JSON.stringify((await metaOf(SCL))?.m) === '"str"', "a raw writer's non-object metadata passes the stamp untouched — not mangled into an array of marks, not refused (first review pass)");
  await db.exec(`UPDATE thoughts SET content = '050: an array for metadata, edited' WHERE id = '${ARR}'`);
  assert(JSON.stringify((await metaOf(ARR))?.m) === "[1]", "…on a content edit too");
  // Two content writes in ONE transaction share created_at (now()) and their
  // ids are random: the backfill must still read the later one — by seq.
  const same = await db.transaction(async (tx) => {
    const c = (await tx.query<{ r: { id: string } }>(`SELECT upsert_thought($1::text, $2::jsonb, $3::vector) AS r`, ["050: typed then edited in one transaction", JSON.stringify({ metadata: {}, actor: { name: "op-key" } }), unit(57)])).rows[0].r;
    await tx.query(`SELECT update_thought($1::uuid, $2::text, NULL, NULL, NULL, NULL, $3::jsonb, NULL, NULL, NULL)`, [c.id, "050: edited by the agent in the same transaction", JSON.stringify({ name: "bot-key" })]);
    return c;
  });
  assert((await marks(same.id)) === "agent/bot-key", "in one transaction, a capture then a content edit: the trigger's stamp is the editor's");
  const sameRows = await q<{ created_at: string; seq: number }>(`SELECT created_at::text AS created_at, seq FROM thought_audit WHERE thought_id = $1::uuid ORDER BY seq`, [same.id]);
  assert(sameRows.length === 2 && sameRows[0].created_at === sameRows[1].created_at && Number(sameRows[1].seq) > Number(sameRows[0].seq), "…the two audit rows share created_at and differ in seq");
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`UPDATE thoughts SET metadata = metadata - 'actor_kind' - 'actor_name' WHERE id = '${same.id}'`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  assert(((await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r.rows >= 1) && (await marks(same.id)) === "agent/bot-key",
    `the backfill reads the same pair by seq and derives the editor, every time — by created_at and id it was a coin flip that rewrote the trigger's stamp (${await marks(same.id)}; first review pass, reproduced 6 of 12)`);
  // …and when seq lies — a pre-050 row's is heap order, and 046's amendments
  // plus a VACUUM put an agent's later rewrite on an earlier page than the
  // operator's capture (second review pass, reproduced) — the text anchors
  // it: the update row whose after-text is the row's text wrote what stands.
  // Planted by hand (OVERRIDING SYSTEM VALUE — the one door to a chosen seq):
  // one created_at for both rows, the rewrite's seq below the capture's.
  const ANCH = "47474747-4747-4747-8747-474747474755";
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_audit; ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${ANCH}', '050: rewritten by the agent, seq inverted', '{}'::jsonb, '${unit(60)}'::vector)`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_audit; ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`INSERT INTO thought_audit (thought_id, action, actor_name, diff, created_at, seq) OVERRIDING SYSTEM VALUE VALUES
    ('${ANCH}', 'capture', 'op-key', '{"metadata": {}}'::jsonb, '2026-01-01 00:00:00+00', 900001),
    ('${ANCH}', 'update', 'bot-key', '{"content": {"before": "050: typed by the operator", "after": "050: rewritten by the agent, seq inverted"}}'::jsonb, '2026-01-01 00:00:00+00', 900000)`);
  await db.exec(`SELECT backfill_thought_actors()`);
  assert((await marks(ANCH)) === "agent/bot-key", `with one created_at and the rewrite's seq BELOW the capture's, the row whose after-text is the thought's text still decides: the agent's (${await marks(ANCH)}; second review pass)`);
  // The same inverted pair, but the text that stands matches neither: the
  // capture sorts first and must NOT stand for it — an update changed the
  // text once, so the capturer's text is gone (fourth review pass, planted).
  const TIE = "47474747-4747-4747-8747-474747474758";
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_audit; ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${TIE}', '050: Z, written unaudited', '{"actor_kind": "operator", "actor_name": "op-key"}'::jsonb, '${unit(65)}'::vector)`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_audit; ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`INSERT INTO thought_audit (thought_id, action, actor_name, diff, created_at, seq) OVERRIDING SYSTEM VALUE VALUES
    ('${TIE}', 'capture', 'op-key', '{"metadata": {}}'::jsonb, '2026-01-02 00:00:00+00', 900003),
    ('${TIE}', 'update', 'bot-key', '{"content": {"before": "050: X", "after": "050: Y"}}'::jsonb, '2026-01-02 00:00:00+00', 900002)`);
  await db.exec(`SELECT backfill_thought_actors()`);
  assert((await marks(TIE)) === "-/-", `a capture sorting above an unmatched update, on a created_at tie with the seq inverted, does not stand for a text nobody logged: nobody does (${await marks(TIE)}; fourth review pass)`);
  // Two rows can both have written the text that stands — X, then Y, then X
  // again, then Y, then X: the second and the fourth edits end on X. Then the
  // order decides, newest first, and the ordering mutant (oldest first) fails
  // here and nowhere else, since the anchor carried every other arm.
  const flip = await cap("050: flip X", { metadata: {}, actor: { name: "op-key" } }, 61);
  await edit(flip.id, "050: flip Y", null, { name: "bot-key" });
  await edit(flip.id, "050: flip X", null, { name: "imp-key" });
  await edit(flip.id, "050: flip Y", null, { name: "op-key" });
  await edit(flip.id, "050: flip X", null, { name: "bot-key" });
  assert((await marks(flip.id)) === "agent/bot-key", "X → Y → X → Y → X through four keys: the trigger's stamp is the last editor's");
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`UPDATE thoughts SET metadata = metadata - 'actor_kind' - 'actor_name' WHERE id = '${flip.id}'`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`SELECT backfill_thought_actors()`);
  assert((await marks(flip.id)) === "agent/bot-key", `…and the backfill, with two update rows whose after-text is the row's text (imp-key's and bot-key's), takes the newer by created_at then seq (${await marks(flip.id)})`);
  // A text nobody logged: the operator's X, the agent's audited rewrite to Y,
  // then Z written with the audit trigger off. Update rows exist and none has
  // the text that stands, so the writer is nobody — as for a thought with no
  // row at all — not the agent, whose text is gone (third review pass).
  const awBefore = (await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r.awaiting;
  const unv = await cap("050: unvouched X", { metadata: {}, actor: { name: "op-key" } }, 62);
  await edit(unv.id, "050: unvouched Y", null, { name: "bot-key" });
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_audit; ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`UPDATE thoughts SET content = '050: unvouched Z' WHERE id = '${unv.id}'`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_audit; ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  const unvBf = (await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r;
  assert((await marks(unv.id)) === "-/-" && unvBf.awaiting === awBefore,
    `a text no audit row vouches for is nobody's, and does not count as awaiting a classification (${await marks(unv.id)})`);
  // A row 023's batches have not reached — content_fingerprint NULL — re-spelled
  // through update_thought: the column moves from NULL to a value while the
  // text does not change; the mark stays (third review pass: the moved-column
  // shortcut had taken NULL → set for a change of text).
  const LEG = "47474747-4747-4747-8747-474747474756";
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('ob1.actor', '{"name": "op-key"}', true)`);
    await tx.query(`INSERT INTO thoughts (id, content, content_fingerprint, metadata, embedding) VALUES ('${LEG}', '050: A Legacy Row', NULL, '{}'::jsonb, '${unit(63)}'::vector)`);
  });
  r = await edit(LEG, "050:   a legacy   ROW", null, { name: "bot-key" });
  // The column stale after a raw content UPDATE, then an unchanged edit
  // through update_thought moves it to the right value: bytes differ, the
  // column moved between two values — and the text did not (fourth review
  // pass: read as a change, it re-stamped, and the backfill stripped it).
  const STALE = "47474747-4747-4747-8747-474747474757";
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('ob1.actor', '{"name": "op-key"}', true)`);
    await tx.query(`INSERT INTO thoughts (id, content, content_fingerprint, metadata, embedding) VALUES ('${STALE}', '050: stale, typed by the operator', content_fingerprint_of('050: stale, typed by the operator'), '{}'::jsonb, '${unit(64)}'::vector)`);
  });
  await db.exec(`UPDATE thoughts SET content = '050: stale, rewritten by hand' WHERE id = '${STALE}'`);
  assert((await marks(STALE)) === "-/-", "a raw content UPDATE strips the mark and leaves the fingerprint column stale");
  const staleEdit = await edit(STALE, "050:   STALE, rewritten BY hand", null, { name: "bot-key" });
  assert(staleEdit.ok === true && (await marks(STALE)) === "-/-" && (await one<{ f: string }>(`SELECT content_fingerprint AS f FROM thoughts WHERE id = $1::uuid`, [STALE]))?.f === (await one<{ f: string }>(`SELECT content_fingerprint_of('050: stale, rewritten by hand') AS f`))?.f,
    `an unchanged edit that moves the stale column to the right value keeps the mark as it was — nobody's — while the column is corrected (${await marks(STALE)})`);
  await db.exec(`SELECT backfill_thought_actors()`);
  assert((await marks(STALE)) === "-/-", "…and the backfill agrees: the raw update's row wrote the text that stands, and it names nobody");
  assert(r.ok === true && (await marks(LEG)) === "operator/op-key" && (await one<{ f: string | null }>(`SELECT content_fingerprint AS f FROM thoughts WHERE id = $1::uuid`, [LEG]))?.f !== null,
    `a re-spelling of a row with no fingerprint yet keeps the operator's mark while the column takes its first value (${await marks(LEG)})`);
  assert(/content_fingerprint_of\(OLD\.content\) IS NOT DISTINCT FROM\s+CASE WHEN NEW\.content_fingerprint IS NOT NULL\s+AND NEW\.content_fingerprint IS DISTINCT FROM OLD\.content_fingerprint\s+THEN NEW\.content_fingerprint\s+ELSE content_fingerprint_of\(NEW\.content\) END/.test(stamp),
    "the stamp hashes OLD's text always and trusts NEW's column only when it moved to a value (fourth review pass)");

  // The filter: 014's route reaches the keys through the GIN it already has,
  // on the walk and on the exact branch, and the keyword arm's filter too.
  // The two content edits above went through update_thought with no vector, which
  // nulls the embedding (a re-embed's job); give them one so the walk sees them.
  await db.exec(`UPDATE thoughts SET embedding = '${unit(47)}'::vector WHERE id = '${claim.id}'; UPDATE thoughts SET embedding = '${unit(57)}'::vector WHERE id = '${same.id}'`);
  const op2 = await cap("050: the operator's second note", { metadata: { source: "mcp" }, actor: { name: "op-key" } }, 48);
  const bySaid = await q<{ id: string }>(`SELECT id FROM match_thoughts($1::vector, -1.0, 10, '{"actor_kind": "operator"}'::jsonb)`, [unit(41)]);
  assert(bySaid.length === 1 && bySaid[0].id === op2.id, `match_thoughts under {"actor_kind": "operator"} returns the operator's rows and none of the agent's, the claim's or the unmarked (${bySaid.length})`);
  const byActor = await q<{ id: string }>(`SELECT id FROM match_thoughts($1::vector, -1.0, 10, '{"actor_name": "bot-key"}'::jsonb)`, [unit(41)]);
  assert(byActor.map((x) => x.id).sort().join() === [claim.id, same.id, ANCH].sort().join(), `…and {"actor_name": "bot-key"} the three rows that key wrote — its capture, its edit of the operator's, the planted rewrite (${byActor.length})`);
  const kw = await q<{ id: string }>(`SELECT id FROM search_thoughts_keyword('050:', 50, 0, '{"actor_kind": "agent"}'::jsonb)`);
  assert(kw.map((x) => x.id).sort().join() === [claim.id, byId.id, same.id, ANCH, flip.id].sort().join(), `the keyword arm's filter reaches the same key — the agent's five rows: by name, by id, the edit, the planted rewrite, the flip (${kw.length})`);
  assert((await q(`SELECT id FROM thoughts WHERE metadata @> jsonb_build_object('actor_kind', 'operator'::text)`)).length === 2, "…as does the list tool's containment clause — the operator's second note and the re-spelled legacy row");

  // The backfill: a brain from before 050 — rows unmarked, one with a planted
  // claim, one typed then rewritten, one an unclassified key's, one with no
  // log at all — the stamp trigger off and the audit trigger on, as it was.
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  const pre1 = await cap("050: pre-050, the operator's", { metadata: { source: "mcp" }, actor: { name: "op-key" } }, 50);
  const pre2 = await cap("050: pre-050, an agent's with a planted claim", { metadata: { actor_kind: "operator", actor_name: "op-key" }, actor: { name: "bot-key" } }, 51);
  const pre3 = await cap("050: pre-050, an unclassified key's", { metadata: {}, actor: { name: "late-key" } }, 52);
  const pre4 = await cap("050: pre-050, typed by the operator then rewritten", { metadata: {}, actor: { name: "op-key" } }, 53);
  await edit(pre4.id, "050: pre-050, rewritten by an agent", null, { name: "bot-key" });
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_audit`);
  await db.exec(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${ORPHAN}', '050: no log, a planted claim', '{"actor_kind": "operator", "actor_name": "op-key", "keep": true}'::jsonb, '${unit(54)}'::vector)`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_audit`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  assert((await marks(pre1.id)) === "-/-" && (await marks(pre2.id)) === "operator/op-key" && (await marks(pre4.id)) === "-/-" && (await marks(ORPHAN)) === "operator/op-key",
    "the fixture: unmarked rows and planted claims, as a brain from before 050 holds them");
  // Two more shapes the run-it reviewer found: an envelope naming a padded or
  // empty key (the audit row keeps it as sent; the stamp trims), and an orphan
  // carrying the two keys as JSON null (`->>` reads NULL, as for absent).
  const PAD = "47474747-4747-4747-8747-474747474753", NULLKEYS = "47474747-4747-4747-8747-474747474754";
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('ob1.actor', '{"name": "  op-key  "}', true)`);
    await tx.query(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${PAD}', '050: a padded key name', '{}'::jsonb, '${unit(58)}'::vector)`);
  });
  assert((await marks(PAD)) === "operator/op-key" && (await one<{ n: string }>(`SELECT actor_name AS n FROM thought_audit WHERE thought_id = $1::uuid`, [PAD]))?.n === "  op-key  ", "a padded name is trimmed by the stamp and kept as sent on the audit row");
  await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_audit; ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await db.exec(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${NULLKEYS}', '050: no log, the keys as json null', '{"actor_kind": null, "actor_name": null, "keep": 2}'::jsonb, '${unit(59)}'::vector)`);
  await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_audit; ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  const u1 = (await metaOf(pre1.id))?.u;
  const auditsBefore = await auditCount();
  const first = await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('ob1.actor', '{"name": "hand"}', true)`);
    const bf = (await tx.query<{ r: Bf }>(`SELECT backfill_thought_actors(1) AS r`)).rows[0].r;
    const s = (await tx.query<{ a: string | null; b: string | null }>(`SELECT current_setting('ob1.actor', true) AS a, current_setting('ob1.actor_amend', true) AS b`)).rows[0];
    return { bf, s };
  });
  assert(first.bf.ok === true && first.bf.rows === 1 && first.bf.differing === 6 && first.bf.awaiting === 2,
    `p_limit bounds the rows written; the return counts every row that disagrees with the log and every row whose writer waits on a classification (${JSON.stringify(first.bf)})`);
  assert(first.s.a === '{"name": "hand"}' && (first.s.b === "" || first.s.b === null), `…and the pass hands the transaction's actor back as it found it, the amendment setting cleared (${first.s.a}, ${JSON.stringify(first.s.b)})`);
  let bf = (await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r;
  assert(bf.rows === 5 && bf.differing === 5 && bf.awaiting === 2, `the rest in one pass (${JSON.stringify(bf)})`);
  m = await metaOf(NULLKEYS);
  assert(!("actor_kind" in (m?.m ?? {})) && !("actor_name" in (m?.m ?? {})) && m?.m?.keep === 2, `the two keys planted as JSON null on a row no log vouches for are removed, not kept as nulls (${JSON.stringify(m?.m)}; run-it, first review pass)`);
  assert((await marks(PAD)) === "operator/op-key", "the padded name's row already agrees with the log — the backfill trims as the stamp does, so it is not rewritten every pass (run-it, first review pass)");
  assert((await marks(pre1.id)) === "operator/op-key", `an unmarked pre-050 row takes its capture's writer (${await marks(pre1.id)})`);
  assert((await marks(pre2.id)) === "agent/bot-key", `a planted claim is corrected to the log's writer (${await marks(pre2.id)})`);
  assert((await marks(pre3.id)) === "-/late-key", `an unclassified writer's row gains the name and waits for the kind (${await marks(pre3.id)})`);
  assert((await marks(pre4.id)) === "agent/bot-key", `the latest CONTENT writer decides, not the capture — the mutant that reads the first row fails here (${await marks(pre4.id)})`);
  m = await metaOf(ORPHAN);
  assert((await marks(ORPHAN)) === "-/-" && m?.m?.keep === true, `a mark no audit row vouches for is stripped, the rest of the metadata kept (${JSON.stringify(m?.m)})`);
  assert((await marks(claim.id)) === "agent/bot-key" && (await marks(byId.id)) === "agent/-" && (await marks(ghost.id)) === "-/ghost-key" && (await marks(op.id)) === "-/-",
    "rows the trigger stamped — by name, by id, an unclassified name, a raw content update — already agree with the log and are not touched (the raw update's row: its content_fingerprint column is stale, so the anchor hashes the text — second review pass)");
  assert((await metaOf(pre1.id))?.u === u1, "updated_at is not bumped: a stamp is not an edit (018's guard and 021's rule read it)");
  assert((await auditCount()) === auditsBefore + 6, `each row written left one audit row, the record the ticket asks for (${(await auditCount()) - auditsBefore})`);
  const bfRow = (await audits(pre1.id)).at(-1);
  assert(bfRow?.action === "update" && bfRow.origin === "backfill_thought_actors" && bfRow.actor_name === null && bfRow.diff.metadata?.after?.actor_kind === "operator" && bfRow.diff.metadata?.before?.actor_kind === undefined,
    `…whose door is the backfill, whose actor is nobody, and whose diff is the mark arriving (${JSON.stringify(bfRow?.origin)}, ${JSON.stringify(bfRow?.actor_name)})`);
  bf = (await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r;
  assert(bf.rows === 0 && bf.differing === 0 && bf.awaiting === 2, `a second pass finds nothing: idempotent, as the migration's own call is on re-apply (${JSON.stringify(bf)})`);
  await db.exec(`SELECT set_agent_kind('late-key', 'ingested')`);
  bf = (await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r;
  assert(bf.rows === 1 && bf.awaiting === 1 && (await marks(pre3.id)) === "ingested/late-key",
    `once the key is classified the next pass fills its rows from the registry — before 046's backfill has touched the audit row (${JSON.stringify(bf)}, ${await marks(pre3.id)})`);
  // A key classified WRONG and corrected: the audit rows keep the kind they
  // were stamped with (046: history), the marks follow the registry (a view).
  await db.exec(`SELECT set_agent_kind('late-key', 'agent')`);
  bf = (await one<{ r: Bf }>(`SELECT backfill_thought_actors() AS r`)).r;
  assert(bf.rows === 1 && (await marks(pre3.id)) === "agent/late-key" && (await one<{ k: string | null }>(`SELECT actor_kind AS k FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [pre3.id]))?.k === null,
    `a reclassified key reaches its rows on the next pass — the registry's kind first, the audit row's stamp only when the registry has none (${await marks(pre3.id)}; first review pass)`);
  assert(/at least 1/.test(await refused(`SELECT backfill_thought_actors(0)`)), "p_limit 0 is refused as a value");
  assert(/^\s*$|actor/.test(String((await one<{ s: string | null }>(`SELECT current_setting('ob1.actor_amend', true) AS s`)).s ?? "")), "the amendment setting is not left on the session");

  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_agents`);
}

console.log("\n[47] Migration 052: thought_changes — one page of the log, oldest first, from a time or a cursor; the keyset walks a tie without a gap or a repeat; each row rendered bounded (SMD-1296)");
{
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const refused = async (sql: string, params: unknown[] = []) => { try { await db.query(sql, params); return ""; } catch (e) { return (e as Error).message; } };
  type Row = { id: string; created_at: unknown; action: string; thought_id: string; actor_name: string | null; actor_kind: string | null; origin: string | null; source: string | null;
               present: boolean; head: string | null; changed: unknown; metadata_keys: unknown; supersedes_before: string | null; supersedes_after: string | null; derivation: boolean };
  // A text[] reads back as an array, or as its literal on a driver that does not parse the type — one spelling here.
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : [];
  const ts = (r: Row) => new Date(r.created_at as string).getTime();
  const changes = (args: string, params: unknown[] = []) => q<Row>(`SELECT * FROM thought_changes(${args})`, params);
  // PGlite's now() is millisecond-grained ([9]'s lesson): a few ms between writes keeps
  // each statement's row on its own tick, so the order asserted is the mechanism's, not the clock's.
  const tick = () => new Promise((r) => setTimeout(r, 3));
  const cap = async (content: string, envelope: Record<string, unknown>, at = 1) =>
    String((await one<{ r: { id: string } }>(`SELECT upsert_thought($1::text, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(envelope), unit(at)])).r.id);
  const asActor = (name: string, statement: string) => db.exec(`BEGIN; SELECT set_config('ob1.actor', '${JSON.stringify({ name })}', true); ${statement}; COMMIT`);
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`SELECT set_agent_kind('alice', 'operator'); SELECT set_agent_kind('bob', 'agent')`);
  // The log is append-only, so earlier sections' rows stay: every read below starts after the newest of them — a cursor, the strict bound.
  const cursor0 = String((await one<{ id: string }>(`SELECT id FROM thought_audit ORDER BY created_at DESC, id DESC LIMIT 1`)).id);

  const A = await cap("the first note about 052", { metadata: { type: "idea", topics: ["a"] }, actor: { name: "alice" } }, 1); await tick();
  const B = await cap("a second note, replacing the first", { metadata: { type: "idea" }, actor: { name: "bob" }, supersedes: A }, 2); await tick();
  await asActor("bob", `UPDATE thoughts SET content = 'the first note, edited', metadata = metadata || '{"topics": ["b"], "status": "open"}'::jsonb WHERE id = '${A}'`); await tick();
  await db.exec(`UPDATE thoughts SET metadata = metadata || '{"hand": 1}'::jsonb WHERE id = '${B}'`); await tick();
  await asActor("alice", `DELETE FROM thoughts WHERE id = '${A}'`); await tick();
  const C = await cap("a third note, derived from the second", { metadata: {}, actor: { name: "alice" }, derived_from: [B] }, 3); await tick();

  const all = await changes(`NULL, $1::uuid`, [cursor0]);
  assert(all.length === 7, `after the cursor: seven rows — two captures, two edits, a delete, the pointer 025's SET NULL cleared, a third capture (${all.length})`);
  const verbs = all.map((r) => r.action);
  assert(verbs.slice(0, 4).join(",") === "capture,capture,update,update" && verbs[6] === "capture" && [verbs[4], verbs[5]].sort().join(",") === "delete,update",
    `…oldest first: ${verbs.join(", ")} (the delete and the pointer it cleared share one transaction, so one created_at, and read in id order)`);
  assert(all.every((r, i) => i === 0 || ts(all[i - 1]) < ts(r) || (ts(all[i - 1]) === ts(r) && all[i - 1].id < r.id)), "…strictly increasing in (created_at, id)");
  const [capA, capB, editA, handB] = all;
  const delA = all.find((r) => r.action === "delete")!, ptrB = all.slice(4, 6).find((r) => r.action === "update")!, capC = all[6];
  assert(capA.thought_id === A && capA.actor_name === "alice" && capA.actor_kind === "operator" && capA.present === false && capA.head === null && capA.supersedes_after === null && arr(capA.changed).length === 0,
    "the first capture: alice (operator), the thought gone since, so no head and present false, no pointer");
  assert(capB.thought_id === B && capB.actor_name === "bob" && capB.actor_kind === "agent" && capB.present === true && capB.head === "a second note, replacing the first" && capB.supersedes_after === A && capB.supersedes_before === null,
    "the second capture: bob (agent), its current text as the head, and the pointer it was captured with");
  // 050 (SMD-1726): the actor follows the content, so bob's edit of alice's
  // text moves the row's actor_kind and actor_name marks too — two more keys
  // the feed reports, beside the two the statement set; `type` stays unmoved.
  // (055 records a key's move as a diff key beside these; bob's edit is a raw
  // UPDATE of content, which leaves 003's key stale and so moves none — the
  // log is faithful, not corrective. An edit through update_thought would
  // list content_fingerprint here too; [51] holds that.)
  assert(editA.thought_id === A && editA.actor_name === "bob" && arr(editA.changed).join(",") === "content,metadata" && arr(editA.metadata_keys).join(",") === "actor_kind,actor_name,status,topics" && editA.head === "the first note, edited",
    `the edit: changed content and metadata, the keys that moved (050's two marks, status, topics — not type), the new text as the head (${arr(editA.changed).join("/")}; ${arr(editA.metadata_keys).join("/")})`);
  assert(handB.actor_name === null && handB.actor_kind === null && arr(handB.metadata_keys).join(",") === "hand" && handB.head === null,
    "a raw write with no actor: null name and kind, the one key it added, no head (the content did not move)");
  assert(delA.thought_id === A && delA.actor_name === "alice" && delA.head === "the first note, edited" && delA.present === false && delA.supersedes_before === null,
    "the delete: the previous text as the head, present false, and no pointer of its own");
  assert(ptrB.thought_id === B && ptrB.actor_name === "alice" && arr(ptrB.changed).join(",") === "supersedes" && ptrB.supersedes_before === A && ptrB.supersedes_after === null,
    "the cascade: B's pointer cleared by 025's SET NULL reads as an edit by the deleter with supersedes before A, after null");
  assert(capC.thought_id === C && capC.derivation === true && capB.derivation === false && capC.present === true, "a capture with derived_from says so; one without does not");
  assert(all.every((r) => Number.isFinite(ts(r)) && (r.source === null || typeof r.source === "string")), "created_at and source ride along");

  // Who: keep one key's rows; drop one key's — a row with no actor is not the caller, so it stays.
  assert((await changes(`NULL, $1::uuid, 'alice'`, [cursor0])).length === 4, "p_agent alice: her two captures, the delete and the cascade row it wrote");
  assert((await changes(`NULL, $1::uuid, NULL, 'alice'`, [cursor0])).length === 3, "p_not_agent alice: bob's two and the actorless one");
  assert((await changes(`NULL, $1::uuid, NULL, 'bob'`, [cursor0])).length === 5, "p_not_agent bob: alice's four and the actorless one");
  assert((await changes(`NULL, $1::uuid, NULL, NULL, ARRAY['delete']`, [cursor0])).length === 1 && (await changes(`NULL, $1::uuid, NULL, NULL, ARRAY['capture', 'delete']`, [cursor0])).length === 4,
    "p_actions keeps a subset");
  assert(/unknown action nope; the actions are capture, update and delete/.test(await refused(`SELECT * FROM thought_changes(NULL, NULL, NULL, NULL, ARRAY['nope'])`)) && /unknown action NULL/.test(await refused(`SELECT * FROM thought_changes(NULL, NULL, NULL, NULL, ARRAY[NULL]::text[])`)),
    "…and refuses a fourth word or a null element by name");
  assert(/pass a time \(p_since\) or a cursor \(p_after\), not both/.test(await refused(`SELECT * FROM thought_changes(now(), $1::uuid)`, [cursor0])), "a time beside a cursor is refused");
  assert(/no audit row 00000000-0000-4000-8000-0000000000ff; a cursor is the id the previous page ended with/.test(await refused(`SELECT * FROM thought_changes(NULL, '00000000-0000-4000-8000-0000000000ff'::uuid)`)), "a cursor naming no row is refused by name");

  // The walk: pages of five from the cursor — the boundary falls between the two rows that share a created_at.
  const p1 = await changes(`NULL, $1::uuid, NULL, NULL, NULL, 5`, [cursor0]);
  const p2 = await changes(`NULL, $1::uuid, NULL, NULL, NULL, 5`, [p1[p1.length - 1].id]);
  const p3 = await changes(`NULL, $1::uuid, NULL, NULL, NULL, 5`, [p2[p2.length - 1].id]);
  assert(p1.length === 5 && p2.length === 2 && p3.length === 0 && ts(p1[4]) === ts(p2[0]), `pages of five: 5, 2, 0 — the boundary on a tie (${p1.length}, ${p2.length}, ${p3.length}; ${ts(p1[4]) === ts(p2[0]) ? "tied" : "not tied"})`);
  assert(JSON.stringify([...p1, ...p2].map((r) => r.id)) === JSON.stringify(all.map((r) => r.id)), "…and the pages joined are the whole list: no gap, no repeat");
  // Since a time: at or after.
  assert((await changes(`$1::timestamptz`, [all[2].created_at])).filter((r) => all.some((a) => a.id === r.id)).length === 5, "p_since is at-or-after: from the edit's tick, five of the seven");
  // The tail: no bound, the newest three, still oldest first.
  const tail = await changes(`NULL, NULL, NULL, NULL, NULL, 3`);
  assert(JSON.stringify(tail.map((r) => r.id)) === JSON.stringify(all.slice(4).map((r) => r.id)), "no bound: the newest three rows, in the same order the walk gives them");
  // The three filters are spelled once per branch; a mutant that dropped the
  // no-bound copy survived every suite (third review pass), so each branch
  // drives its own copies. The cursor branch's are the counts above.
  const ids = (rows: Row[]) => JSON.stringify(rows.map((r) => r.id));
  assert(ids(await changes(`NULL, NULL, 'bob', NULL, NULL, 2`)) === ids([capB, editA]) && ids(await changes(`NULL, NULL, NULL, 'alice', NULL, 3`)) === ids([capB, editA, handB]) && ids(await changes(`NULL, NULL, NULL, NULL, ARRAY['delete'], 1`)) === ids([delA]),
    "no bound: p_agent, p_not_agent and p_actions each narrow the newest rows");
  const t0 = all[0].created_at;
  assert((await changes(`$1::timestamptz, NULL, 'bob'`, [t0])).length === 2 && (await changes(`$1::timestamptz, NULL, NULL, 'alice'`, [t0])).length === 3 && (await changes(`$1::timestamptz, NULL, NULL, NULL, ARRAY['capture']`, [t0])).length === 3,
    "since a time: p_agent, p_not_agent and p_actions each narrow the rows at or after it");
  assert((await changes(`NULL, $1::uuid, NULL, NULL, NULL, 0`, [cursor0])).length === 1, "p_limit is clamped up to one");

  // A hand-written row cannot break the feed: a metadata side that is not an object, a pointer that is not a uuid.
  await db.exec(`INSERT INTO thought_audit (thought_id, action, diff) VALUES ('${B}', 'update', '{"metadata": {"before": {"a": 1}, "after": [1]}, "supersedes": {"before": "not-a-uuid", "after": 7}}')`);
  const planted = (await changes(`NULL, NULL, NULL, NULL, NULL, 1`))[0];
  assert(planted.thought_id === B && arr(planted.changed).join(",") === "metadata,supersedes" && arr(planted.metadata_keys).length === 0 && planted.supersedes_before === null && planted.supersedes_after === null,
    "a planted row with a non-object metadata side and non-uuid pointers renders with no keys and no pointer, and raises nothing");
  const fn = await one<{ v: string; r: number }>(`SELECT provolatile AS v, prorows AS r FROM pg_proc WHERE proname = 'thought_changes'`);
  assert(fn.v === "s" && Number(fn.r) === 50, "the function is STABLE with ROWS 50");
  await db.exec(`DELETE FROM thoughts`);
}

console.log("\n[48] Migration 053: the source beside the thought — the canonical round-trips and is written once, links are a set the validator shapes and an index holds, an identity resolves, and a structured pass and an extracted pass coexist with the structured row standing (SMD-1867)");
{
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const refused = async (sql: string, params: unknown[] = []) => { try { await db.query(sql, params); return ""; } catch (e) { return (e as Error).message; } };
  const put = async (content: string, metadata: Record<string, unknown> = {}, supersedes: string | null = null) =>
    (await one<{ id: string }>(`INSERT INTO thoughts (id, content, metadata, content_fingerprint, supersedes) VALUES (gen_random_uuid(), $1, $2::jsonb, content_fingerprint_of($1), $3::uuid) RETURNING id`, [content, JSON.stringify(metadata), supersedes])).id;
  type J = Record<string, unknown>;
  const src = async (sig: string) => String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).s);
  const links = async (id: string, active = true) => q<{ p: J; open: boolean }>(`SELECT payload AS p, valid_until IS NULL AS open FROM thought_facets WHERE thought_id = $1::uuid AND kind = 'link' ${active ? "AND valid_until IS NULL" : ""} ORDER BY payload->>'relation', payload->>'target', created_at`, [id]);
  const mentions = async (id: string) => q<{ name: string; type: string; key: string; c: string }>(`SELECT en.name, en.entity_type AS type, m.extraction_key AS key, m.confidence::text AS c FROM thought_entities m JOIN ob1_entities en ON en.id = m.entity_id WHERE m.thought_id = $1::uuid ORDER BY en.entity_type, en.name`, [id]);
  const edgesOf = async (id: string) => q<{ key: string; relation: string; c: string }>(`SELECT extraction_key AS key, relation, confidence::text AS c FROM ob1_entity_edges WHERE thought_id = $1::uuid ORDER BY relation`, [id]);
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_entities`);

  // The shape: the table and its identity rule, the two indexes, and the
  // functions 053 defines — the two it redefines carry sentinels so a test
  // can tell 053's body from 016's / 042's.
  const cols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'thought_sources' ORDER BY ordinal_position`)).map((c) => c.column_name);
  assert(cols.join(",") === "thought_id,system,identity,canonical,media_type,canonical_hash,ingest_run,ingested_at", `thought_sources has the eight columns (${cols.join(",")})`);
  const uniq = (await q<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'thought_sources'::regclass AND contype = 'u'`)).map((x) => x.d);
  assert(uniq.length === 1 && /UNIQUE \(system, identity\)/.test(uniq[0]), `an identity names one thought: UNIQUE (system, identity) (${uniq.join("; ")})`);
  const idx = (await q<{ n: string }>(`SELECT indexname AS n FROM pg_indexes WHERE tablename = 'thought_facets' AND indexname LIKE 'thought_facets_link%' ORDER BY 1`)).map((x) => x.n);
  assert(idx.join(",") === "thought_facets_link_active_uniq,thought_facets_link_target_idx", `the active-link unique index and the target probe exist (${idx.join(",")})`);
  const rteSrc = await src("record_thought_entities(uuid, text, jsonb, jsonb, text, uuid)");
  assert(lastDefinerOf("record_thought_entities").startsWith("053") && /ob1:structured-wins/.test(rteSrc), "053 is the last definer of record_thought_entities and its body carries the structured-wins sentinel");
  const validatorSrc = await src("thought_facets_validate()");
  assert(lastDefinerOf("thought_facets_validate").startsWith("053") && /ob1:link-facet/.test(validatorSrc), "…and of thought_facets_validate, which carries the link-facet sentinel");
  assert(/CASE WHEN v_structured THEN extraction_key = p_extraction_key ELSE extraction_key NOT LIKE 'source:%' END/.test(rteSrc) && (rteSrc.match(/WHERE (?:thought_entities|ob1_entity_edges)\.extraction_key NOT LIKE 'source:%'/g) ?? []).length === 2,
    "the rule is spelled on the key prefix: a source: pass replaces its own rows, an extraction the rest, and both conflict clauses yield to source:");
  assert(/link \(migration 053\)/.test(validatorSrc) && LINK_RELATIONS.every((r) => validatorSrc.includes(`'${r}'`)) && LINK_RELATIONS.length === 6, `the validator's hint names the new kind, and every relation the contract names it admits (${LINK_RELATIONS.join(", ")})`);
  const tc = (await one<{ c: string | null }>(TABLE_COMMENT_SQL, ["thought_sources"])).c ?? "";
  assert(/SMD-1867/.test(tc) && /byte for byte/.test(tc) && /derived/.test(tc), "the table's comment states the round-trip rule: the canonical is the truth, the text and links derived");

  // The Linear adapter's output, end to end: N autolinks → zero markup in the
  // text, a references link per distinct target, the canonical intact.
  const out = linearAdapter.map(SAMPLE_ISSUE);
  const t1 = await put(out.text, out.facets);
  const t2 = await put("SMD-1730 — the event shape\nProject: x · Status: Done\nhttps://linear.app/x", { source: "linear", issue: "SMD-1730" });
  const recordSource = async (id: string, form: string, run: string) => (await one<{ r: J }>(`SELECT record_thought_source($1::uuid, $2, $3, $4, $5, $6) AS r`, [id, out.identity.system, out.identity.key, form, out.canonical.mediaType, run])).r;
  const r1 = await recordSource(t1, out.canonical.form, "test@1");
  assert(r1.ok === true && r1.outcome === "inserted", `the canonical is recorded (${JSON.stringify(r1)})`);
  const stored = await one<{ c: string; h: string; hh: string; run: string }>(`SELECT canonical AS c, canonical_hash AS h, encode(sha256(convert_to(canonical, 'UTF8')), 'hex') AS hh, ingest_run AS run FROM thought_sources WHERE thought_id = $1::uuid`, [t1]);
  assert(stored.c === out.canonical.form && /<issue id=/.test(stored.c) && !/<issue/.test((await one<{ c: string }>(`SELECT content FROM thoughts WHERE id = $1::uuid`, [t1])).c), "the stored canonical IS the adapter's, markup included, while the row's text has none — the round trip is the canonical's");
  assert(stored.h === stored.hh && stored.h.length === 64 && stored.run === "test@1", "the hash is the canonical's sha256, written beside it; the run is recorded");
  const r2 = await recordSource(t1, out.canonical.form, "test@2");
  assert(r2.outcome === "unchanged" && (await one<{ run: string }>(`SELECT ingest_run AS run FROM thought_sources WHERE thought_id = $1::uuid`, [t1])).run === "test@1", "the same canonical again writes nothing — not even the run");
  const r3 = await recordSource(t1, out.canonical.form + " ", "test@3");
  assert(r3.outcome === "updated" && (await one<{ run: string }>(`SELECT ingest_run AS run FROM thought_sources WHERE thought_id = $1::uuid`, [t1])).run === "test@3", "a canonical that moved by one byte is updated, with its run");
  await recordSource(t1, out.canonical.form, "test@4");
  const held = (await one<{ r: J }>(`SELECT record_thought_source($1::uuid, 'linear', 'SMD-1936', 'x', 'text/plain') AS r`, [t2])).r;
  assert(held.ok === false && held.error === "IDENTITY_HELD" && held.held_by === t1, `an identity another thought holds is refused and the holder named, not re-pointed (${JSON.stringify(held)})`);
  assert(((await one<{ r: J }>(`SELECT record_thought_source(gen_random_uuid(), 'linear', 'SMD-0', 'x', 'text/plain') AS r`)).r).error === "NOT_FOUND", "a thought that is not there is NOT_FOUND");
  assert(/thought_sources_system_check/.test(await refused(`SELECT record_thought_source($1::uuid, 'Linear', 'SMD-1730', 'x', 'text/plain')`, [t2])), "a system that is not one lower-case word is refused by the table's CHECK");

  // Resolution: the table first; the board sync's claim for linear, at the
  // head of a twin chain; nothing for an identity nobody holds.
  const sourceThought = async (system: string, key: string) => (await one<{ id: string | null }>(`SELECT source_thought($1, $2) AS id`, [system, key])).id;
  assert((await sourceThought("linear", "SMD-1936")) === t1, "source_thought resolves through thought_sources");
  assert((await sourceThought("linear", "SMD-1730")) === t2, "…and, for linear, through the sync's metadata.issue claim when no source row exists (SMD-1954's brain)");
  const t2b = await put("SMD-1730 — the event shape (newer)\nProject: x · Status: Done\nhttps://linear.app/x", { source: "linear", issue: "SMD-1730" }, t2);
  assert((await sourceThought("linear", "SMD-1730")) === t2b, "…the head of a twin chain — the row nothing supersedes — not the older twin");
  assert((await sourceThought("linear", "SMD-9999")) === null && (await sourceThought("markdown", "SMD-1730")) === null, "an identity nobody holds resolves to nothing; the claim is linear's alone");

  // Links as a set: the adapter's one references link; the same set again is
  // a no-op; a wider set adds; a narrower set closes (history kept, active
  // gone); malformed, unknown and self-referencing items are dropped and counted.
  const recordLinks = async (id: string, system: string, ls: unknown) => (await one<{ r: J }>(`SELECT record_source_links($1::uuid, $2, $3::jsonb) AS r`, [id, system, JSON.stringify(ls)])).r;
  const l1 = await recordLinks(t1, "linear", out.links);
  assert(JSON.stringify(out.links) === '[{"relation":"references","target":"SMD-1730"}]' && l1.added === 1 && l1.closed === 0 && l1.kept === 0 && l1.dropped === 0, `the adapter's links land: two autolinks to one issue are one references link (${JSON.stringify(l1)})`);
  const first = await links(t1);
  assert(first.length === 1 && first[0].p.origin === "structured" && first[0].p.system === "linear" && first[0].p.target === "SMD-1730", `the validator writes origin = structured (${JSON.stringify(first[0]?.p)})`);
  const l2 = await recordLinks(t1, "linear", out.links);
  assert(l2.added === 0 && l2.closed === 0 && l2.kept === 1 && (await links(t1, false)).length === 1, "the same set again writes nothing — one row, still");
  const l3 = await recordLinks(t1, "linear", [...out.links, { relation: "blocks", target: "SMD-1730" }, { relation: "child_of", target: "SMD-949" }]);
  assert(l3.added === 2 && l3.kept === 1 && l3.closed === 0 && (await links(t1)).length === 3, "a wider set adds what is new and keeps what stood");
  const l4 = await recordLinks(t1, "linear", [{ relation: "child_of", target: "SMD-949" }]);
  const after4 = await links(t1, false);
  assert(l4.closed === 2 && l4.kept === 1 && l4.added === 0 && after4.filter((r) => r.open).length === 1 && after4.filter((r) => !r.open).length === 2, `a narrower set closes the rest — valid_until set, rows kept as history (${after4.filter((r) => !r.open).length} closed)`);
  const l5 = await recordLinks(t1, "linear", [{ relation: "child_of", target: "SMD-949" }, { relation: "references", target: "SMD-1730" }]);
  assert(l5.added === 1 && (await links(t1, false)).length === 4 && (await links(t1)).length === 2, "a link stated again after closing is a new active row beside the closed one");
  const l6 = await recordLinks(t1, "linear", [{ relation: "child_of", target: "SMD-949" }, { relation: "references", target: "SMD-1730" }, { relation: "references", target: "SMD-1936" }, { relation: "loves", target: "SMD-1" }, { relation: "blocks", target: "" }, "junk", { relation: "REFERENCES", target: " SMD-1730 " }]);
  assert(l6.dropped === 5 && l6.kept === 2 && l6.added === 0, `a self-reference, an unknown relation, an empty target, a non-object and a duplicate after normalisation (REFERENCES / padded target) are dropped and counted; the two real links kept (${JSON.stringify(l6)})`);
  const other = await recordLinks(t1, "markdown", [{ relation: "references", target: "Note" }]);
  assert(other.added === 1 && (await links(t1)).length === 3 && (await recordLinks(t1, "linear", [{ relation: "child_of", target: "SMD-949" }, { relation: "references", target: "SMD-1730" }])).closed === 0, "another system's links on the same thought are its own set: a linear pass neither closes nor counts them");
  assert(((await one<{ r: J }>(`SELECT record_source_links(gen_random_uuid(), 'linear', '[]'::jsonb) AS r`)).r).error === "NOT_FOUND", "links on a thought that is not there: NOT_FOUND");
  assert(/must be a JSON array/.test(await refused(`SELECT record_source_links($1::uuid, 'linear', '{}'::jsonb)`, [t1])) && /one lower-case word/.test(await refused(`SELECT record_source_links($1::uuid, 'Linear', '[]'::jsonb)`, [t1])), "a non-array or a malformed system is an error, not a silent no-op");

  // The validator's own refusals, on a raw write; the unique index behind the
  // set; citations untouched beside links.
  const raw = (payload: unknown) => refused(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'link', $2::jsonb)`, [t1, JSON.stringify(payload)]);
  assert(/relation must be references, child_of/.test(await raw({ relation: "loves", system: "linear", target: "SMD-1" })), "a relation outside the six is refused");
  assert(/one lower-case word/.test(await raw({ relation: "blocks", system: "Linear", target: "SMD-1" })), "a system that is not one word is refused");
  assert(/target by identity/.test(await raw({ relation: "blocks", system: "linear", target: "" })) && /target by identity/.test(await raw({ relation: "blocks", system: "linear", target: 7 })), "an empty or non-string target is refused");
  assert(/does not link to itself/.test(await raw({ relation: "references", system: "linear", target: "SMD-1936" })), "a link to the thought's own identity is refused by the validator too");
  assert(/thought_facets_link_active_uniq/.test(await raw({ relation: "child_of", system: "linear", target: "SMD-949" })), "a second active row for one (thought, system, relation, target) is refused by the index — idempotency is the schema's");
  assert(/not a registered facet kind/.test(await refused(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'tag', '{}'::jsonb)`, [t1])), "an unregistered kind is still refused");
  const cit = (await one<{ r: J }>(`SELECT record_citation($1::uuid, $2::uuid, 'rests on it', 'stated') AS r`, [t1, t2])).r;
  assert(cit.ok === true, `a citation beside links still records (${JSON.stringify(cit)})`);
  assert(/needs a non-empty text/.test(await refused(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'citation', $2::jsonb)`, [t1, JSON.stringify({ text: " ", stance: "stated", source_id: t2 })])), "…and 042's own refusals stand in the extended validator's citation branch");

  // The resolution rule. A structured pass writes the project and the label
  // as mentions with no model call; an extraction that names the same label
  // does not displace it and its other rows land; the structured pass re-run
  // replaces only its own rows; an extraction re-run replaces only its own.
  const rte = async (id: string, key: string, ents: unknown, rels: unknown = []) => (await one<{ r: J }>(`SELECT record_thought_entities($1::uuid, $2, $3::jsonb, $4::jsonb, NULL, NULL) AS r`, [id, key, JSON.stringify(ents), JSON.stringify(rels)])).r;
  const structured = out.mentions.map((m) => ({ name: m.name, type: m.type, confidence: 1 }));
  const s1 = await rte(t1, "source:linear", structured);
  assert(s1.ok === true && s1.mentions === 2 && s1.new_entities === 2, `the structured pass writes the project and the label as mentions (${JSON.stringify(s1)})`);
  let m = await mentions(t1);
  assert(m.length === 2 && m.every((x) => x.key === "source:linear" && x.c === "1.00"), `…under source:linear at confidence 1 (${JSON.stringify(m)})`);
  // The same structured set again writes no row: the mentions' extracted_at
  // and the entities' last_seen_at stand where the first pass put them (third
  // review pass, independent read — the pass deleted and re-inserted its own
  // rows every call, and a sync pass over an unchanged ticket stamped the
  // project entity every five minutes).
  const stamps = async () => q<{ x: string; s: string }>(`SELECT m.extracted_at::text AS x, en.last_seen_at::text AS s FROM thought_entities m JOIN ob1_entities en ON en.id = m.entity_id WHERE m.thought_id = $1::uuid ORDER BY en.name`, [t1]);
  const stampsBefore = await stamps();
  await db.query(`SELECT pg_sleep(0.02)`);
  const s1b = await rte(t1, "source:linear", structured);
  assert(s1b.ok === true && s1b.mentions === 0 && s1b.new_entities === 0 && s1b.entities === 2 && JSON.stringify(await stamps()) === JSON.stringify(stampsBefore), `the same structured set again writes nothing: 0 mentions written, extracted_at and last_seen_at unmoved, the two entities still counted (${JSON.stringify(s1b)})`);
  // …nor an entity ROW: the upsert's WHERE holds the tuple where it was (xmin unmoved), so a no-op sync pass leaves no dead tuple per entity (fourth review pass, independent read).
  const xmins = async () => q<{ x: string }>(`SELECT en.xmin::text AS x FROM ob1_entities en JOIN thought_entities m ON m.entity_id = en.id WHERE m.thought_id = $1::uuid ORDER BY en.name`, [t1]);
  const xBefore = await xmins();
  await rte(t1, "source:linear", structured);
  assert(JSON.stringify(await xmins()) === JSON.stringify(xBefore), "…and no entity row is rewritten (xmin unmoved) by a structured pass that brings no new alias");
  await rte(t1, "source:linear", structured.map((x) => (x.type === "topic" ? { ...x, aliases: ["infra"] } : x)));
  assert(JSON.stringify(await xmins()) !== JSON.stringify(xBefore) && (await one<{ a: string[] }>(`SELECT aliases AS a FROM ob1_entities WHERE name = 'infrastructure'`)).a.includes("infra"), "…while a structured pass that brings a new alias writes it");
  const s1c = await rte(t1, "source:linear", [...structured, { name: "Extra Topic", type: "topic", confidence: 1 }]);
  assert(s1c.mentions === 1 && (await mentions(t1)).length === 3, `a wider structured set writes only what is new (${JSON.stringify(s1c)})`);
  const extraSeen = (await one<{ s: string }>(`SELECT last_seen_at::text AS s FROM ob1_entities WHERE name = 'Extra Topic'`)).s;
  const projectSeen = (await one<{ s: string }>(`SELECT last_seen_at::text AS s FROM ob1_entities WHERE name = $1`, [SAMPLE_ISSUE.project!.name])).s;
  assert(extraSeen > projectSeen, "…and a mention written is a sighting (the new topic's last_seen_at is later than the untouched project's)");
  await rte(t1, "source:linear", structured);
  assert((await mentions(t1)).length === 2, "…a narrower set removes the row it no longer names");
  const e1 = await rte(t1, "extract:m@p1", [{ name: "infrastructure", type: "topic", confidence: 0.6 }, { name: "Bob", type: "person", confidence: 0.9 }], [{ from: "Bob", to: "infrastructure", relation: "works_on", confidence: 0.8 }]);
  m = await mentions(t1);
  assert(e1.ok === true && e1.mentions === 1 && e1.edges === 1 && m.length === 3, `the extraction lands its own rows — Bob and one edge — and reports one mention, not two (${JSON.stringify(e1)})`);
  assert(m.find((x) => x.name === "infrastructure")?.key === "source:linear" && m.find((x) => x.name === "infrastructure")?.c === "1.00", "…and the label it also named stays the structured row: source:linear, confidence 1 — structured wins");
  assert(m.find((x) => x.name === "Bob")?.key === "extract:m@p1", "…while Bob is the extraction's");
  const s2 = await rte(t1, "source:linear", structured.filter((x) => x.type === "project"));
  m = await mentions(t1);
  assert(s2.ok === true && m.length === 2 && !m.some((x) => x.name === "infrastructure") && m.some((x) => x.name === "Bob"), `a structured pass that no longer names the label removes ITS row and leaves the extraction's (${m.map((x) => x.name).join(",")})`);
  assert((await edgesOf(t1)).length === 1, "…and the extraction's edge stands (the label entity is kept by it)");
  const e2 = await rte(t1, "extract:m@p1", [{ name: "Alice", type: "person", confidence: 0.7 }]);
  m = await mentions(t1);
  assert(e2.ok === true && m.map((x) => x.name).sort().join(",") === ["Alice", SAMPLE_ISSUE.project!.name].sort().join(",") && !m.some((x) => x.name === "Bob"), `an extraction re-run replaces only the extracted rows — Bob gone, Alice in, the project untouched (${m.map((x) => x.name).join(",")})`);
  assert((await edgesOf(t1)).length === 0, "…its old edge gone with it");

  // The takeover and the standing, on the edge layer as on the mentions: an
  // extraction first, then the structured pass naming the same pair.
  const e3 = await rte(t2, "extract:m@p1", [{ name: "Open Brain", type: "project", confidence: 0.5 }, { name: "Carol", type: "person", confidence: 0.5 }], [{ from: "Carol", to: "Open Brain", relation: "member_of", confidence: 0.5 }]);
  assert(e3.ok === true && e3.edges === 1, "an extraction on a fresh thought lands a mention pair and an edge");
  const s3 = await rte(t2, "source:test", [{ name: "Open Brain", type: "project", confidence: 1 }, { name: "Carol", type: "person", confidence: 1 }], [{ from: "Carol", to: "Open Brain", relation: "member_of", confidence: 1 }]);
  let edges = await edgesOf(t2);
  m = await mentions(t2);
  assert(s3.ok === true && s3.mentions === 2 && s3.edges === 1 && m.every((x) => x.key === "source:test" && x.c === "1.00") && edges.length === 1 && edges[0].key === "source:test" && edges[0].c === "1.00", `a structured pass onto extracted rows takes them over — mentions and the edge (${JSON.stringify(m)} ${JSON.stringify(edges)})`);
  const e4 = await rte(t2, "extract:m@p2", [{ name: "Open Brain", type: "project", confidence: 0.4 }, { name: "Carol", type: "person", confidence: 0.4 }, { name: "Dave", type: "person", confidence: 0.4 }], [{ from: "Carol", to: "Open Brain", relation: "member_of", confidence: 0.4 }, { from: "Dave", to: "Open Brain", relation: "works_on", confidence: 0.4 }]);
  m = await mentions(t2);
  edges = await edgesOf(t2);
  assert(e4.ok === true && e4.mentions === 1 && e4.edges === 1 && m.filter((x) => x.key === "source:test").length === 2 && m.find((x) => x.name === "Dave")?.key === "extract:m@p2", `an extraction onto structured rows leaves them and lands its own (${JSON.stringify(m)})`);
  assert(edges.length === 2 && edges.find((x) => x.relation === "member_of")?.key === "source:test" && edges.find((x) => x.relation === "works_on")?.key === "extract:m@p2", `…the shared edge stays structured, the new one is the extraction's (${JSON.stringify(edges)})`);
  const cleared = await rte(t2, "source:test", []);
  m = await mentions(t2);
  edges = await edgesOf(t2);
  assert(cleared.ok === true && m.length === 1 && m[0].name === "Dave" && edges.length === 1 && edges[0].relation === "works_on", `a structured pass stating nothing removes its own rows only — the extraction's Dave and its works_on edge stand (${m.map((x) => x.name).join(",")}; ${edges.map((x) => x.relation).join(",")})`);
  // The entity the structured rows alone held is pruned; the ones an extracted row still names are not.
  assert(!(await q(`SELECT 1 FROM ob1_entities WHERE name = 'Carol'`)).length && (await q(`SELECT 1 FROM ob1_entities WHERE name = 'Open Brain'`)).length === 1, "Carol, referenced by nothing now, is pruned; Open Brain, the extraction's edge end, stays");

  // Re-applying 053 lands the same shape and the rows stand.
  await reapply("053");
  assert((await links(t1)).length === 3 && (await q(`SELECT 1 FROM thought_sources WHERE thought_id = $1::uuid`, [t1])).length === 1 && lastDefinerOf("record_thought_entities").startsWith("053"), "re-applying 053 keeps every row and every definition");

  // The takeover (first review pass): the board sync's head row for a ticket
  // moves when an older paste becomes the chain's head, so the identity must
  // be able to follow — p_take moves it and names the row it left; without
  // p_take the refusal stands. The structure goes with it (second review
  // pass): the old holder's active linear links are closed and its
  // source:linear mentions removed — its markdown links and its extracted
  // mention stand — so the ticket's edges are read once, on the new head. A
  // self-link the moved identity now makes on the new holder is refused.
  const beforeTake = { links: (await links(t1)).length, mentions: (await mentions(t1)).map((m) => `${m.key}:${m.name}`).sort() };
  assert(beforeTake.links === 3 && beforeTake.mentions.length === 2 && beforeTake.mentions.some((m) => m.startsWith("source:linear:")), `before the takeover the old head carries three active links and a source:linear mention beside the extracted one (${JSON.stringify(beforeTake)})`);
  const took = (await one<{ r: J }>(`SELECT record_thought_source($1::uuid, 'linear', 'SMD-1936', 'the same issue, newer head', 'text/plain', 'test@take', true) AS r`, [t2b])).r;
  assert(took.ok === true && took.outcome === "inserted" && took.taken_from === t1, `p_take moves the identity to the new head and names the row it left (${JSON.stringify(took)})`);
  assert((await sourceThought("linear", "SMD-1936")) === t2b && (await q(`SELECT 1 FROM thought_sources WHERE thought_id = $1::uuid`, [t1])).length === 0, "…so the identity resolves to the new holder and the old holder has no source row");
  const afterTake = await links(t1, false);
  assert(afterTake.filter((r) => r.open).length === 1 && afterTake.filter((r) => r.open)[0].p.system === "markdown" && afterTake.filter((r) => !r.open && r.p.system === "linear").length === 4, `…its active linear links are closed (history kept), its markdown link stands (${afterTake.filter((r) => r.open).length} open, ${afterTake.filter((r) => !r.open).length} closed)`);
  const afterMentions = (await mentions(t1)).map((m) => `${m.key}:${m.name}`);
  assert(afterMentions.length === 1 && afterMentions[0] === "extract:m@p1:Alice", `…its source:linear mention is gone and the extracted one stands (${afterMentions.join(",")})`);
  assert(((await one<{ r: J }>(`SELECT record_thought_source($1::uuid, 'linear', 'SMD-1936', 'x', 'text/plain', 'test@nt') AS r`, [t1])).r).error === "IDENTITY_HELD", "…and without p_take the old holder is refused in its turn");
  assert(/does not link to itself/.test(await refused(`INSERT INTO thought_facets (thought_id, kind, payload) VALUES ($1::uuid, 'link', '{"relation":"references","system":"linear","target":"SMD-1936"}'::jsonb)`, [t2b])), "the moved identity guards the new holder against a self-link");
  const plain = (await one<{ r: J }>(`SELECT record_thought_source($1::uuid, 'linear', 'SMD-1936', 'the same issue, newer head', 'text/plain', 'test@again', true) AS r`, [t2b])).r;
  assert(plain.outcome === "unchanged" && plain.taken_from === null, "p_take with nothing to take is the plain write: unchanged, taken from nobody");
  // A NULL p_take is not a take (fourth review pass: `NOT NULL` is NULL and the guard fell through).
  const nullTake = (await one<{ r: J }>(`SELECT record_thought_source($1::uuid, 'linear', 'SMD-1936', 'x', 'text/plain', NULL, NULL::boolean) AS r`, [t1])).r;
  assert(nullTake.ok === false && nullTake.error === "IDENTITY_HELD" && nullTake.held_by === t2b, `a NULL p_take is refused as IDENTITY_HELD, not read as a take (${JSON.stringify(nullTake)})`);
  // Closing a link is not re-judged: an identity re-pointed onto a link's
  // target since (the same thought, another identity) would otherwise make
  // the row impossible to close and every structure write on the thought fail
  // (fourth review pass, independent read).
  const tA = await put("A note", {});
  await db.query(`SELECT record_thought_source($1::uuid, 'markdown', 'a', 'A', 'text/markdown', 'r')`, [tA]);
  await recordLinks(tA, "markdown", [{ relation: "references", target: "b" }]);
  await db.query(`SELECT record_thought_source($1::uuid, 'markdown', 'b', 'A', 'text/markdown', 'r')`, [tA]);
  const closing = await recordLinks(tA, "markdown", []);
  assert(closing.ok === true && closing.closed === 1 && (await links(tA)).length === 0, `a link to what is now the thought's own identity can still be closed (${JSON.stringify(closing)})`);
  const anew = await recordLinks(tA, "markdown", [{ relation: "references", target: "b" }]);
  assert(anew.ok === true && anew.dropped === 1 && anew.added === 0, `…while stating it anew is dropped as a self-reference (${JSON.stringify(anew)})`);
  // The shortcut is exactly a close (sixth review pass — the mutant that
  // admitted any payload-unchanged UPDATE passed the suite): a re-open of the
  // closed self-link, a move of the row to another thought whose identity is
  // its target, and a kind change beside a close are all judged.
  const closedLink = (await one<{ id: string }>(`SELECT id FROM thought_facets WHERE thought_id = $1::uuid AND kind = 'link' AND valid_until IS NOT NULL`, [tA])).id;
  assert(/does not link to itself/.test(await refused(`UPDATE thought_facets SET valid_until = NULL WHERE id = $1::uuid`, [closedLink])), "re-opening the closed link, now a self-link, is judged and refused");
  const tB = await put("B note", {});
  await db.query(`SELECT record_thought_source($1::uuid, 'markdown', 'c', 'B', 'text/markdown', 'r')`, [tB]);
  const tC = await put("C note", {});
  const onC = (await one<{ r: J }>(`SELECT record_source_links($1::uuid, 'markdown', '[{"relation":"references","target":"c"}]'::jsonb) AS r`, [tC])).r;
  const cLink = (await one<{ id: string }>(`SELECT id FROM thought_facets WHERE thought_id = $1::uuid AND kind = 'link'`, [tC])).id;
  assert(onC.added === 1 && /does not link to itself/.test(await refused(`UPDATE thought_facets SET thought_id = $1::uuid WHERE id = $2::uuid`, [tB, cLink])), "moving a link row onto the thought whose identity it names is judged and refused");
  assert(/needs a non-empty text|not a registered facet kind|stance/.test(await refused(`UPDATE thought_facets SET kind = 'citation', valid_until = now() WHERE id = $1::uuid`, [cLink])), "a kind change beside a close is judged as the new kind, and a link payload is no citation");
  assert(((await one<{ r: J }>(`SELECT record_source_links($1::uuid, 'markdown', '[]'::jsonb) AS r`, [tC])).r).closed === 1, "…and the legitimate close still takes the shortcut");
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_entities`);
}

// ── 51. Migration 055: the capture event carries the payload ─────────────────
//
// The three additions to 046's event (a capture's content and a backdating
// writer's created_at, an update's key move) and nothing else — one scripted
// set of writes under 046's trigger and under 055's compared on every column
// outside the three keys; 046's rules as functions the triggers call; the
// third amendment of the append-only table (the payload arm, key by key) and
// the backfill that uses it, source by source (SMD-2115, step 1 of SMD-1997).
console.log("\n[51] Migration 055: the capture event carries the payload — a capture's content and a backdating writer's created_at, an update's key move; 046's rules as functions the triggers call; the payload amendment and its backfill (SMD-2115)");
{
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const refused = async (sql: string, params: unknown[] = []) => { try { await db.query(sql, params); return ""; } catch (e) { return (e as Error).message; } };
  const src = async (sig: string) => String((await one<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).s);
  type Diff = Record<string, unknown> & { content?: unknown; created_at?: string; metadata?: Record<string, unknown>; content_fingerprint?: { before: string | null; after: string | null } };
  type Ev = { id: string; action: string; diff: Diff; source: string | null; actor_name: string | null; actor_kind: string | null; trust: string | null; origin: string | null;
              stance: string | null; cites: string[] | null; valid_from: string | null; valid_until: string | null; actor_context: Record<string, unknown> | null; created_at: string; seq: number };
  const EV = "id, action, diff, source, actor_name, actor_kind, trust, origin, stance, cites, valid_from::text AS valid_from, valid_until::text AS valid_until, actor_context, created_at::text AS created_at, seq";
  const eventsOf = async (id: string) => q<Ev>(`SELECT ${EV} FROM thought_audit WHERE thought_id = $1::uuid ORDER BY created_at, seq`, [id]);
  const audits = async () => (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit`)).c;
  const cap = async (content: string, envelope: Record<string, unknown>, at: number) =>
    (await one<{ r: { id: string; existed: boolean } }>(`SELECT upsert_thought($1::text, $2::jsonb, $3::vector) AS r`, [content, JSON.stringify(envelope), unit(at)])).r;
  const edit = async (id: string, content: string | null, metadata: Record<string, unknown> | null, actor: Record<string, unknown>, vec: string | null = null) =>
    (await one<{ r: { ok: boolean; error?: string; duplicate_of?: string; fingerprint_held_by?: string } }>(
      `SELECT update_thought($1::uuid, $2::text, $3::jsonb, $5::vector, NULL, NULL, $4::jsonb, CASE WHEN $5::vector IS NULL THEN NULL ELSE 'stub-embed' END, NULL, NULL) AS r`,
      [id, content, metadata === null ? null : JSON.stringify(metadata), JSON.stringify(actor), vec])).r;
  // One transaction per attempt (the setting is transaction-local); a refusal
  // rolls it back and its message is what the assertion reads.
  const amend = async (setting: string, stmt: string) => { try { await db.transaction(async (tx) => { await tx.exec(`SELECT set_config('ob1.audit_amend', '${setting}', true)`); await tx.exec(stmt); }); return ""; } catch (err) { return (err as Error).message; } };
  const DIFF_SIG = "ob1_thought_diff(text, text, text, jsonb, jsonb, boolean, boolean, uuid, uuid, jsonb, jsonb, text, text, timestamptz)";
  const ACTOR = { name: "op-key", via: "test-door" };
  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_agents`);
  await db.exec(`SELECT set_agent_kind('op-key', 'operator')`);

  // The shape: the rules as functions, the sentinels where the readers look,
  // the index, the comments.
  for (const fn of ["ob1_thought_diff", "ob1_append_thought_event", "ob1_actor_stamp", "ob1_actor_stamp_kept", "ob1_capture_payload", "backfill_thought_payloads"])
    assert((await functionsNamed(fn)) === 1, `one ${fn}`);
  const trig = await src("thoughts_write_audit()"), diffRule = await src(DIFF_SIG), refuse = await src("thought_audit_refuse_mutation()");
  assert(/ob1:capture-event-carries-content/.test(trig) && /ob1:capture-event-carries-content/.test(diffRule), "the payload sentinel stands in the trigger and in the diff rule — what preflight's recogniser and this suite read");
  assert(/ob1:audit-amend-fills-payload-only/.test(refuse) && /ob1:audit-amend-fills-null-only/.test(refuse), "the refusal trigger carries both amendments' sentinels");
  assert(/CASE WHEN TG_OP = 'INSERT' AND NEW\.created_at IS DISTINCT FROM now\(\) THEN NEW\.created_at END/.test(trig), "the trigger passes the row's created_at only when it differs from the transaction's now() — a defaulted column says nothing the event's clock does not");
  assert((await one<{ v: string }>(`SELECT provolatile AS v FROM pg_proc WHERE oid = $1::regprocedure`, [DIFF_SIG])).v === "s", "ob1_thought_diff is STABLE, not the prototype's IMMUTABLE — a timestamptz inside jsonb renders in the session's TimeZone");
  const pidx = (await one<{ d: string }>(`SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'thought_audit_awaiting_payload_idx'`))?.d ?? "";
  assert(/\(created_at, seq\)/.test(pidx) && /WHERE \(\(action = 'capture'::text\) AND \(NOT COALESCE\(\(diff \? 'content'::text\), false\)\)\)/.test(pidx), `the payload index holds exactly the capture rows without content — a NULL diff among them — in (created_at, seq) order (${pidx})`);
  const since = (await one<{ v: string | null }>(`SELECT value AS v FROM ob1_config WHERE key = 'audit_seq_exact_since'`))?.v ?? null;
  assert(since !== null && new Date(since).getTime() <= Date.now() && /^\d{4}-\d{2}-\d{2}/.test(since), `055 records the boundary from which seq is exact insertion order — the apply's own time here, where no ledger names 050 (${since})`);
  const sinceMs = new Date(since!).getTime();
  const colc = (await one<{ c: string | null }>(COLUMN_COMMENT_SQL, ["thought_audit", "diff"])).c ?? "";
  assert(/since 055, the content/.test(colc) && /content_fingerprint when the key moved/.test(colc) && /backfill_thought_payloads/.test(colc), "diff's comment states the three additions and the backfill that fills the rows from before");
  assert(/two lawful amendments/.test((await one<{ c: string | null }>(TABLE_COMMENT_SQL, ["thought_audit"])).c ?? "") && /RANGE on created_at by month/.test((await one<{ c: string | null }>(TABLE_COMMENT_SQL, ["thought_audit"])).c ?? ""), "the table's comment counts two amendments and keeps the partition key it chose");

  // The first addition: a capture carries the content (and no created_at for a
  // row that took now()).
  const a = await cap("055: a note the log can rebuild", { metadata: { source: "mcp" }, actor: ACTOR }, 1);
  let ev = await eventsOf(a.id);
  assert(ev.length === 1 && ev[0].action === "capture" && ev[0].diff.content === "055: a note the log can rebuild" && ev[0].diff.metadata?.source === "mcp" && ev[0].diff.metadata?.actor_kind === "operator" && !("created_at" in ev[0].diff),
    `a capture's audit row carries the content beside the stamped metadata, and no created_at for a row that took now() (${JSON.stringify(ev[0]?.diff)})`);
  assert(ev[0].actor_kind === "operator" && ev[0].trust === "operator" && ev[0].origin === "test-door" && ev[0].actor_context === null, "…the kind, the ceiling and the door as 046 wrote them, now through ob1_append_thought_event");
  // The second: a raw insert with a backdated created_at carries it; one at now() does not.
  const RAW_OLD = "54545454-0001-4000-8000-000000000001", RAW_NOW = "54545454-0001-4000-8000-000000000002";
  await db.exec(`INSERT INTO thoughts (id, content, metadata, created_at) VALUES ('${RAW_OLD}', '055: a backdated raw load', '{"source": "load"}'::jsonb, '2024-01-02T03:04:05Z')`);
  await db.exec(`INSERT INTO thoughts (id, content, metadata) VALUES ('${RAW_NOW}', '055: a raw load at now()', '{"source": "load"}'::jsonb)`);
  ev = await eventsOf(RAW_OLD);
  const carried = await one<{ same: boolean }>(`SELECT (a.diff->>'created_at')::timestamptz = t.created_at AS same FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.thought_id = $1::uuid AND a.action = 'capture'`, [RAW_OLD]);
  assert(ev.length === 1 && ev[0].diff.content === "055: a backdated raw load" && carried.same === true && ev[0].actor_name === null, "a raw insert with a backdated created_at carries it in the diff, equal to the row's — db/ingest-records.ts's path, with no actor");
  ev = await eventsOf(RAW_NOW);
  assert(ev.length === 1 && ev[0].diff.content === "055: a raw load at now()" && !("created_at" in ev[0].diff), "…and one at now() carries the content and no created_at");
  // The third: an update that moves the text carries the key's before/after;
  // one that leaves the text carries none.
  const fpA = await fpOf("055: a note the log can rebuild"), fpA2 = await fpOf("055: the note, rewritten");
  let r = await edit(a.id, "055: the note, rewritten", null, ACTOR);
  ev = await eventsOf(a.id);
  assert(r.ok === true && ev.length === 2 && ev[1].action === "update" && (ev[1].diff.content as { after: string }).after === "055: the note, rewritten" && ev[1].diff.content_fingerprint?.before === fpA && ev[1].diff.content_fingerprint?.after === fpA2,
    `an edit that moves the text carries the key's before/after beside the content (${JSON.stringify(ev[1]?.diff.content_fingerprint)})`);
  r = await edit(a.id, null, { source: "mcp", note: 1 }, ACTOR);
  ev = await eventsOf(a.id);
  assert(r.ok === true && ev.length === 3 && "metadata" in ev[2].diff && !("content_fingerprint" in ev[2].diff) && !("content" in ev[2].diff), "a metadata-only edit carries no key and no content — the diff is still only what changed");
  // A re-embed goes through update_thought with the text AND the vector
  // (021: a vector is written with content, reembed.ts passes both). The
  // rewrite above cleared the vector, so the first re-embed flips presence
  // — 008's rule, recorded — and moves no key; the second changes nothing
  // the event records and writes no row.
  r = await edit(a.id, "055: the note, rewritten", null, ACTOR, unit(7));
  ev = await eventsOf(a.id);
  assert(r.ok === true && ev.length === 4 && ev[3].diff.embedding_present === true && !("content_fingerprint" in ev[3].diff) && !("content" in ev[3].diff),
    `a re-embed of the same text records the vector's presence returning and no key move — the text did not change, so the key did not (${JSON.stringify(ev[3]?.diff)})`);
  let n = await audits();
  r = await edit(a.id, "055: the note, rewritten", null, ACTOR, unit(8));
  assert(r.ok === true && (await audits()) === n, "a re-embed onto a row that has a vector writes no audit row, as 008 decided: the key did not move and the vector's presence did not flip");
  // 018's NULL, included: a row whose stale key differs from its text, edited
  // to a text another row holds — the function sets the key NULL, and the
  // event says so (before the stale key, after NULL). A replay could not
  // re-derive that from the content it lands.
  const h = await cap("055: the text two rows will hold", { metadata: { source: "mcp" }, actor: ACTOR }, 2);
  const b = await cap("055: a note about to be rewritten by hand", { metadata: { source: "mcp" }, actor: ACTOR }, 3);
  const fpB = await fpOf("055: a note about to be rewritten by hand");
  await db.exec(`UPDATE thoughts SET content = '055: the text two rows will hold' WHERE id = '${b.id}'`);
  ev = await eventsOf(b.id);
  assert(ev.length === 2 && "content" in ev[1].diff && !("content_fingerprint" in ev[1].diff), "a raw content edit that leaves the key stale records the text's move and no key move — the log is faithful, not corrective");
  r = await edit(b.id, "055: the text  two rows will hold", null, ACTOR);
  ev = await eventsOf(b.id);
  const bKey = (await one<{ fp: string | null }>(`SELECT content_fingerprint AS fp FROM thoughts WHERE id = $1::uuid`, [b.id])).fp;
  assert(r.ok === true && r.duplicate_of === h.id && bKey === null && ev.length === 3 && ev[2].diff.content_fingerprint?.before === fpB && ev[2].diff.content_fingerprint?.after === null,
    `018's unchanged edit onto a text another row holds sets the key NULL, and the event carries the move — before the stale key, after NULL (${JSON.stringify(ev[2]?.diff.content_fingerprint)}; ${JSON.stringify(r)})`);
  // An identical re-capture writes nothing new (008's guard stands: the diff
  // rule moves no key for the same text).
  n = await audits();
  const again = await cap("055: the note, rewritten", { metadata: { source: "mcp" }, actor: ACTOR }, 1);
  const lastA = (await eventsOf(a.id)).at(-1);
  assert(again.existed === true && again.id === a.id && (await audits()) === n, `an identical re-capture writes no audit row: the key did not move, the diff is empty, 008's guard holds (${JSON.stringify(again)}; ${(await audits()) - n} row(s); last ${lastA?.action} ${JSON.stringify(lastA?.diff)})`);
  // 023's fill is a key move, and the log says so now (before 055 it wrote no
  // row: 008 diffed content, metadata and the vector's presence — [24]).
  const LEGACY = "54545454-0001-4000-8000-000000000003";
  await db.exec(`INSERT INTO thoughts (id, content, metadata, content_fingerprint) VALUES ('${LEGACY}', '055: a legacy row without a key', '{"source": "legacy"}'::jsonb, NULL)`);
  const filled = (await one<{ n: number }>(`SELECT backfill_content_fingerprints() AS n`)).n;
  ev = await eventsOf(LEGACY);
  assert(filled === 3 && ev.length === 2 && ev[1].action === "update" && Object.keys(ev[1].diff).join(",") === "content_fingerprint" && ev[1].diff.content_fingerprint?.before === null && ev[1].diff.content_fingerprint?.after === (await fpOf("055: a legacy row without a key")),
    `023's fingerprint fill (three rows: this one and the two raw loads above, none keyed by a raw INSERT) records each key's move as an update event carrying that key alone (${filled}; ${JSON.stringify(ev[1]?.diff)})`);

  // The differential against 046's trigger: one scripted set of writes under
  // 055's trigger and under 046's, every audit column outside the three keys
  // equal (SMD-1999's comparableEvent is the rule). 046 re-applied by hand
  // puts its trigger and its refusal trigger back — the state preflight warns
  // about — and restoreShipped puts 055's back after.
  type Shape = Omit<Ev, "id" | "created_at" | "seq"> & { thought: string };
  const comparable = (rows: (Ev & { thought_id: string })[], names: Map<string, string>): Shape[] => rows.map(({ id: _id, created_at: _c, seq: _s, thought_id, ...e }) => {
    const diff: Diff = { ...e.diff };
    if (e.action === "capture") { delete diff.content; delete diff.created_at; }
    if (e.action === "update") delete diff.content_fingerprint;
    return { ...e, diff, thought: names.get(thought_id) ?? "?" };
  });
  const script = async (tag: string): Promise<{ events: Shape[]; captureDiff: Diff }> => {
    const names = new Map<string, string>();
    // The log is append-only and the raw id is reused, so this run's events
    // are the rows the identity numbers after this point — the sequence's next
    // value, not max(seq): [46] plants rows with explicit seq values beyond it
    // (OVERRIDING SYSTEM VALUE), which max(seq) would read as the bound.
    const since = Number((await one<{ s: string }>(`SELECT nextval(pg_get_serial_sequence('thought_audit', 'seq'))::text AS s`)).s);
    // The same texts and the same raw id both times: the run deletes its two
    // thoughts at the end, so the fingerprints and the id are free again.
    const c1 = await cap("055 differential: a cited page", { metadata: { source: "web" }, actor: ACTOR, event: { stance: "retrieved", cites: [h.id], valid_from: "2026-01-01T00:00:00Z", valid_until: "2026-06-01T00:00:00Z", trust: "ingested" } }, 4);
    names.set(c1.id, "c1");
    const RAW = "54545454-0002-4000-8000-000000000001";
    await db.exec(`INSERT INTO thoughts (id, content, metadata, created_at) VALUES ('${RAW}', '055 differential: a backdated record', '{"source": "load"}'::jsonb, '2024-03-04T05:06:07Z')`);
    names.set(RAW, "raw");
    await edit(c1.id, "055 differential: the page, restated", null, ACTOR);
    await edit(c1.id, null, { source: "web", reviewed: true }, ACTOR);
    await edit(c1.id, null, null, { name: "op-key", via: "test-door", claimed: { trust: "operator" } });
    await db.exec(`UPDATE thoughts SET metadata = metadata || '{"hand": true}'::jsonb WHERE id = '${RAW}'`);  // a raw metadata touch: an update event with no content
    await db.query(`SELECT delete_thought($1::uuid, $2::jsonb, false)`, [c1.id, JSON.stringify(ACTOR)]);
    await db.query(`SELECT delete_thought($1::uuid, $2::jsonb, false)`, [RAW, JSON.stringify(ACTOR)]);
    const rows = await q<Ev & { thought_id: string }>(`SELECT thought_id, ${EV} FROM thought_audit WHERE thought_id IN ($1::uuid, $2::uuid) AND seq > $3::bigint ORDER BY created_at, seq`, [c1.id, RAW, since]);
    return { events: comparable(rows, names), captureDiff: rows[0]?.diff ?? {} };
  };
  const under054 = await script("under 055");
  assert(under054.events.length === 7 && "content" in under054.captureDiff, `the scripted set writes seven events under 055's trigger, the capture carrying its content (${under054.events.length})`);
  const files046 = await reapply("046");
  assert(!/ob1:capture-event-carries-content/.test(await src("thoughts_write_audit()")) && lastDefinerOf("thoughts_write_audit").startsWith("055"), `${files046} re-applied by hand puts 046's trigger back — the state preflight's audit events check warns about — while 055 stays the last definer`);
  const under046 = await script("under 046");
  assert(!("content" in under046.captureDiff) && !("created_at" in under046.captureDiff), "…under which a capture records no content and no created_at (the differential is between two different logs)");
  const restored = await restoreShipped("thoughts_write_audit", "thought_audit_refuse_mutation");
  assert(restored.length === 1 && restored[0].startsWith("055") && /ob1:capture-event-carries-content/.test(await src("thoughts_write_audit()")), `…and the last definer re-applied (${restored.join(", ")}) puts 055's trigger back`);
  const mismatches = under054.events.map((e, i) => [JSON.stringify(e), JSON.stringify(under046.events[i])]).filter(([x, y]) => x !== y);
  assert(under046.events.length === 7 && mismatches.length === 0,
    `the two logs are equal on every column outside the three additions — action, source, actor, kind, trust, door, stance, cites, window, context, the diff's other keys (${mismatches.length} mismatch(es)${mismatches.length ? `: ${mismatches[0][0].slice(0, 160)} / ${mismatches[0][1].slice(0, 160)}` : ""})`);

  // The payload amendment: a capture row from before 055 — planted in 046's
  // shape for a thought that stands (L), one whose text later moved (M), one
  // deleted (D), one with no row and no later event (U), and one whose id was
  // re-captured after a delete (R) — and the gate that admits exactly the fill
  // the backfill would make.
  // The run under 046's trigger wrote two content-less captures whose
  // thoughts are since deleted — and restoreShipped re-applied 055, whose
  // apply-time call filled them (the raw row's from its tombstone): the state
  // a brain reaches when 046 is re-applied by hand and 055 after it. What
  // still waits is earlier sections' planted capture rows (046's shape,
  // thoughts that never existed): the log is append-only, so one pass here
  // reports them as nothing to derive from, and every count below is
  // relative to them.
  const rawCaptures = await q<{ c: string | null }>(`SELECT diff->>'content' AS c FROM thought_audit WHERE thought_id = '54545454-0002-4000-8000-000000000001'::uuid AND action = 'capture' ORDER BY created_at, seq`);
  assert(rawCaptures.length === 2 && rawCaptures.every((r) => r.c === "055 differential: a backdated record"), `re-applying 055 ran its backfill: the content-less capture the 046 run wrote for the raw row carries the text now, from its tombstone (${JSON.stringify(rawCaptures)})`);
  type Bf = { ok: boolean; rows: number; from_update: number; from_tombstone: number; from_row: number; with_created_at: number; unrecoverable: number; skipped: number; awaiting: number };
  const settle = (await one<{ r: Bf }>(`SELECT backfill_thought_payloads() AS r`)).r;
  const strangers = settle.awaiting;
  assert(settle.rows === 0 && settle.awaiting === settle.unrecoverable, `what still waits is earlier sections' planted rows, which nothing derives for (${JSON.stringify(settle)})`);
  const plantRow = async (id: string, content: string, createdAt: string) => {
    await db.exec(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_audit`);
    await db.exec(`INSERT INTO thoughts (id, content, metadata, created_at) VALUES ('${id}', '${content}', '{"source": "plant"}'::jsonb, '${createdAt}')`);
    await db.exec(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_audit`);
  };
  const plantCapture = async (id: string, createdAt: string) =>
    (await one<{ id: string }>(`INSERT INTO thought_audit (thought_id, action, source, actor_name, diff, created_at) VALUES ($1::uuid, 'capture', 'plant', 'op-key', '{"metadata": {"source": "plant"}}'::jsonb, $2::timestamptz) RETURNING id`, [id, createdAt])).id;
  const L = "54545454-0003-4000-8000-00000000000a", M = "54545454-0003-4000-8000-00000000000b", D = "54545454-0003-4000-8000-00000000000c", U = "54545454-0003-4000-8000-00000000000d", R = "54545454-0003-4000-8000-00000000000e";
  await plantRow(L, "055: planted, still standing", "2024-05-01T00:00:00Z");
  const lRow = await plantCapture(L, "2024-05-01T00:00:01Z");  // the event a second after the row: a backdating writer's shape
  await plantRow(M, "055: planted, then moved", "2024-05-02T00:00:00Z");
  const mRow = await plantCapture(M, "2024-05-02T00:00:00Z");  // the event at the row's own time: nothing to fill for created_at
  await plantRow(D, "055: planted, then deleted", "2024-05-03T00:00:00Z");
  const dRow = await plantCapture(D, "2024-05-03T00:00:00Z");
  const uRow = await plantCapture(U, "2024-05-04T00:00:00Z");
  await plantRow(R, "055: planted, deleted, re-captured — the first text", "2024-05-05T00:00:00Z");
  const rRow = await plantCapture(R, "2024-05-05T00:00:00Z");
  // V: an edit whose transaction began before the capture's and committed
  // after it — created_at is the transaction's start, so the update event is
  // stamped EARLIER than the capture while its seq is later (run-it, first
  // review pass: reproduced with two connections on Postgres; planted here).
  // Planted since the boundary — stamped from the boundary the suite read
  // above, not from the wall clock (third review pass: a fast run could have
  // reached this section inside the plants' 25 s and put V's update before
  // the boundary, onto the clock path) — so seq decides the order and an
  // older transaction's stamp cannot mislead it.
  const past = (ms: number) => new Date(sinceMs + ms).toISOString();
  const V = "54545454-0003-4000-8000-00000000000f";
  const tV = past(10_000);
  await plantRow(V, "055: planted, edited by an older transaction — the second text", tV);
  const vRow = await plantCapture(V, tV);
  await db.exec(`INSERT INTO thought_audit (thought_id, action, diff, created_at) VALUES ('${V}', 'update', '{"content": {"before": "055: planted, edited by an older transaction — the first text", "after": "055: planted, edited by an older transaction — the second text"}}'::jsonb, '${past(5_000)}')`);
  // W: two edits after the capture, the SECOND one stamped before them all —
  // a transaction that began before the capture's and committed after the
  // first edit. Ordered by the clock it would read first and hand the first
  // edit's after-text to the capture (cold read, second review pass); by seq
  // it is second, and the capture derives the text as captured.
  const W = "54545454-0003-4000-8000-000000000011";
  const tW = past(10_000);
  await plantRow(W, "055: planted, edited twice — the third text", tW);
  const wRow = await plantCapture(W, tW);
  await db.exec(`INSERT INTO thought_audit (thought_id, action, diff, created_at) VALUES ('${W}', 'update', '{"content": {"before": "055: planted, edited twice — the first text", "after": "055: planted, edited twice — the second text"}}'::jsonb, '${past(11_000)}')`);
  await db.exec(`INSERT INTO thought_audit (thought_id, action, diff, created_at) VALUES ('${W}', 'update', '{"content": {"before": "055: planted, edited twice — the second text", "after": "055: planted, edited twice — the third text"}}'::jsonb, '${past(1_000)}')`);
  // P: a brain with pre-050 history — rows before the boundary, whose seq is
  // heap order: a PRIOR incarnation of the id (captured, then deleted) whose
  // tombstone took a seq far above the standing capture's at 050's ALTER.
  // Admitting rows by seq alone read that tombstone as this capture's edge
  // and wrote the old incarnation's text onto a standing thought (both
  // readers, second review pass); before the boundary the clock rules.
  const P = "54545454-0003-4000-8000-000000000012";
  const pPrevRow = await plantCapture(P, "2024-05-08T00:00:00Z");
  await db.exec(`INSERT INTO thought_audit (thought_id, action, diff, created_at, seq) OVERRIDING SYSTEM VALUE VALUES ('${P}', 'delete', '{"previous_content": "055: planted, a prior incarnation long deleted", "previous_metadata": {}}'::jsonb, '2024-05-08T01:00:00Z', 900000000)`);
  await plantRow(P, "055: planted, the standing text after a prior incarnation", "2024-05-08T02:00:00Z");
  const pRow = await plantCapture(P, "2024-05-08T02:00:00Z");
  // N: a capture row whose diff is NULL — a hand INSERT's shape; every
  // writer's is an object — filled by hand below; N2 the same, filled by the pass.
  const N = "54545454-0003-4000-8000-000000000010";
  await plantRow(N, "055: planted with a NULL diff", "2024-05-07T00:00:00Z");
  const nRow = (await one<{ id: string }>(`INSERT INTO thought_audit (thought_id, action, created_at) VALUES ($1::uuid, 'capture', '2024-05-07T00:00:01Z') RETURNING id`, [N])).id;
  const N2 = "54545454-0003-4000-8000-000000000013";
  await plantRow(N2, "055: planted with a NULL diff, filled by the pass", "2024-05-09T00:00:00Z");
  const n2Row = (await one<{ id: string }>(`INSERT INTO thought_audit (thought_id, action, created_at) VALUES ($1::uuid, 'capture', '2024-05-09T00:00:01Z') RETURNING id`, [N2])).id;
  r = await edit(M, "055: planted, then moved — the second text", null, ACTOR);
  assert(r.ok === true, "M's text moves through update_thought (the event's before is the text as captured)");
  await db.query(`SELECT delete_thought($1::uuid, $2::jsonb, false)`, [D, JSON.stringify(ACTOR)]);
  await db.query(`SELECT delete_thought($1::uuid, $2::jsonb, false)`, [R, JSON.stringify(ACTOR)]);
  await db.exec(`INSERT INTO thoughts (id, content, metadata) VALUES ('${R}', '055: planted, deleted, re-captured — the second text', '{"source": "load"}'::jsonb)`);
  const waiting = async () => (await one<{ c: number }>(`SELECT count(*)::int AS c FROM thought_audit WHERE action = 'capture' AND NOT COALESCE(diff ? 'content', false)`)).c;
  assert((await waiting()) === strangers + 11, `eleven planted capture rows wait for their payload beside the ${strangers} stranger(s) — the two NULL diffs among them (${await waiting()})`);
  // What each derives to — the one reading the gate and the backfill share.
  type Pay = { content: string | null; row_created_at: string | null; source: string };
  const derive = async (id: string, rowId: string) => one<Pay>(`SELECT p.content, p.row_created_at::text AS row_created_at, p.source FROM thought_audit a CROSS JOIN LATERAL ob1_capture_payload(a.thought_id, a.created_at, a.seq) p WHERE a.id = $1::uuid`, [rowId]);
  let d = await derive(L, lRow);
  assert(d.content === "055: planted, still standing" && d.source === "row" && d.row_created_at !== null && /2024-05-01/.test(d.row_created_at), `L derives from the live row, with the row's own created_at since it differs from the event's (${JSON.stringify(d)})`);
  d = await derive(M, mRow);
  assert(d.content === "055: planted, then moved" && d.source === "update" && d.row_created_at === null, `M derives from the first content-moving update's before — the text as captured, not the text that stands — and no created_at, the row's equal to the event's (${JSON.stringify(d)})`);
  d = await derive(D, dRow);
  assert(d.content === "055: planted, then deleted" && d.source === "delete" && d.row_created_at === null, `D derives from the tombstone's previous_content; its created_at is gone with the row (${JSON.stringify(d)})`);
  d = await derive(U, uRow);
  assert(d.content === null && d.source === "none", `U derives to nothing: no later event, no row (${JSON.stringify(d)})`);
  r = await edit(R, "055: planted, deleted, re-captured — the second text, edited", null, ACTOR);
  assert(r.ok === true, "R's second incarnation is edited through update_thought — an update event with a `before` that is not the first capture's text");
  d = await derive(R, rRow);
  assert(d.content === "055: planted, deleted, re-captured — the first text" && d.source === "delete", `R's first capture derives from its own tombstone — the events stop at the first later tombstone or capture, so the second incarnation's edit is not read (cold read, first review pass: the first draft derived the second text) — and never from the live row a later capture re-took the id with (${JSON.stringify(d)})`);
  d = await derive(V, vRow);
  assert(d.content === "055: planted, edited by an older transaction — the first text" && d.source === "update", `an update written after the capture but stamped before it (the transaction's start) is still this capture's — since the boundary, seq decides (run-it, first review pass) (${JSON.stringify(d)})`);
  d = await derive(W, wRow);
  assert(d.content === "055: planted, edited twice — the first text" && d.source === "update", `two edits, the second stamped before them all: the FIRST by seq gives the text as captured — the clock would have read the second and handed the first edit's after-text to the capture (cold read, second review pass) (${JSON.stringify(d)})`);
  d = await derive(P, pRow);
  assert(d.content === "055: planted, the standing text after a prior incarnation" && d.source === "row", `before the boundary the clock rules: a prior incarnation's tombstone with a heap seq far above this capture's is not this capture's, and the standing text derives from the live row (both readers, second review pass — seq alone wrote the old incarnation's text here) (${JSON.stringify(d)})`);
  d = await derive(P, pPrevRow);
  assert(d.content === "055: planted, a prior incarnation long deleted" && d.source === "delete", `…and the prior incarnation's own capture derives from its tombstone, which is its edge (${JSON.stringify(d)})`);
  d = await derive(N, nRow);
  assert(d.content === "055: planted with a NULL diff" && d.source === "row" && d.row_created_at !== null, `a capture row with a NULL diff derives like any other (${JSON.stringify(d)})`);
  assert(/here nothing is filled/.test(await amend("payload", `UPDATE thought_audit SET diff = diff WHERE id = '${n2Row}'`)), "…and a write that leaves a NULL diff NULL fills nothing (run-it, second review pass: it read as a shape complaint)");
  // The gate, condition by condition.
  assert(/append-only: UPDATE/.test(await refused(`UPDATE thought_audit SET diff = diff || '{"content": "055: planted, still standing"}'::jsonb WHERE id = $1::uuid`, [lRow])), "without the setting an UPDATE of diff is refused, as 008 refused it");
  assert(/here a column other than actor_kind, trust, origin and backfilled_at changes/.test(await amend("backfill", `UPDATE thought_audit SET diff = diff || '{"content": "055: planted, still standing"}'::jsonb WHERE id = '${lRow}'`)), "under 046's value an UPDATE of diff stays refused — the payload is not that amendment's");
  assert(/here content must be the text the log and the row derive to \(from the row\)/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "something else"}'::jsonb WHERE id = '${lRow}'`)), "under the payload value a content that is not what the row derives to is refused, the source named");
  assert(/here a column other than diff changes/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "055: planted, still standing"}'::jsonb, actor_kind = 'agent' WHERE id = '${lRow}'`)), "…a fill beside another column is refused: diff is the fifth column removed from the byte-equal compare under this value alone");
  assert(/here a key of diff other than content and created_at changes/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "055: planted, still standing", "metadata": {"source": "x"}}'::jsonb WHERE id = '${lRow}'`)), "…a fill that touches another key of diff is refused");
  assert(/here created_at must be the live row's own/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "055: planted, still standing", "created_at": "2020-01-01T00:00:00Z"}'::jsonb WHERE id = '${lRow}'`)), "…a created_at that is not the live row's is refused");
  assert(/here content must be a string/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": null}'::jsonb WHERE id = '${lRow}'`)), "…a JSON-null content is refused as a type, not as the wrong text (run-it, first review pass)");
  assert(/here created_at must be a timestamp/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "055: planted, still standing", "created_at": "not-a-date"}'::jsonb WHERE id = '${lRow}'`)), "…a created_at that is no timestamp is refused by name, not by the cast's own error (run-it, first review pass)");
  assert(/here only a capture row takes a payload/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "x"}'::jsonb WHERE thought_id = '${M}' AND action = 'update'`)), "…an update row takes no payload");
  assert(/here no content derives for this row/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "invented"}'::jsonb WHERE id = '${uRow}'`)), "…a row nothing derives for cannot be filled with an invented text");
  assert(/here no created_at derives for this row/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || jsonb_build_object('created_at', (SELECT created_at FROM thoughts WHERE id = '${M}')) WHERE id = '${mRow}'`)), "…a created_at equal to the event's is not a fill: nothing derives");
  assert(/here nothing is filled/.test(await amend("payload", `UPDATE thought_audit SET diff = diff WHERE id = '${lRow}'`)), "…and a write that fills nothing is refused");
  assert((await amend("payload", `UPDATE thought_audit SET diff = COALESCE(diff, '{}'::jsonb) || '{"content": "055: planted with a NULL diff"}'::jsonb WHERE id = '${nRow}'`)) === "", "the lawful fill by hand — the derived content, onto a NULL diff read as empty — goes through");
  assert((await amend("payload", `UPDATE thought_audit SET diff = diff || jsonb_build_object('created_at', (SELECT created_at FROM thoughts WHERE id = '${L}')) WHERE id = '${lRow}'`)) === "", "…and a created_at alone, before the content, from the live row");
  assert(/here nothing is filled/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"content": "055: planted with a NULL diff"}'::jsonb WHERE id = '${nRow}'`)), "…the same fill again fills nothing");
  assert(/here a content once set is never changed/.test(await amend("payload", `UPDATE thought_audit SET diff = jsonb_set(diff, '{content}', '"another text"') WHERE id = '${nRow}'`)), "…and a content once set is never changed");
  assert(/here a created_at is filled with the content or before it/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || jsonb_build_object('created_at', (SELECT created_at FROM thoughts WHERE id = '${N}')) WHERE id = '${nRow}'`)), "…a row that carries its content gains no created_at after the fact (run-it, first review pass)");
  await db.exec(`UPDATE thoughts SET created_at = '2001-02-03T04:05:06Z' WHERE id = '${a.id}'`);
  const aRow = (await one<{ id: string }>(`SELECT id FROM thought_audit WHERE thought_id = $1::uuid AND action = 'capture'`, [a.id])).id;
  assert(/here a created_at is filled with the content or before it/.test(await amend("payload", `UPDATE thought_audit SET diff = diff || '{"created_at": "2001-02-03T04:05:06+00:00"}'::jsonb WHERE id = '${aRow}'`)), "…nor does a complete 055 capture whose row's created_at was moved by hand later — no time it never had");
  assert(/append-only: DELETE/.test(await amend("payload", `DELETE FROM thought_audit WHERE id = '${lRow}'`)) && /append-only: TRUNCATE/.test(await amend("payload", `TRUNCATE thought_audit`)), "…DELETE and TRUNCATE are refused under the setting as without it");
  // The backfill: bounded, by source, idempotent, its report exact.
  assert(/p_limit must be at least 1/.test(await refused(`SELECT backfill_thought_payloads(0)`)), "backfill_thought_payloads(0) is refused as a value");
  let bf = (await one<{ r: Bf }>(`SELECT backfill_thought_payloads(1) AS r`)).r;
  assert(bf.ok && bf.rows === 1 && bf.from_row === 1 && bf.with_created_at === 0 && bf.skipped === 0 && bf.awaiting === strangers + 9,
    `p_limit bounds a pass to the oldest waiting row — L's (the planted rows predate the strangers), from the live row, its hand-filled created_at kept and not counted as this pass's (${JSON.stringify(bf)})`);
  const lDiff = (await one<{ d: Diff }>(`SELECT diff AS d FROM thought_audit WHERE id = $1::uuid`, [lRow])).d;
  const lSame = await one<{ same: boolean }>(`SELECT (a.diff->>'created_at')::timestamptz = t.created_at AS same FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.id = $1::uuid`, [lRow]);
  assert(lDiff.content === "055: planted, still standing" && lSame.same === true && lDiff.metadata?.source === "plant", "L's row now carries the content beside the created_at the hand fill set, its other keys untouched — the pass did not re-write the time (cold read, first review pass)");
  bf = (await one<{ r: Bf }>(`SELECT backfill_thought_payloads(1) AS r`)).r;
  assert(bf.rows === 1 && bf.from_update === 1 && bf.awaiting === strangers + 8, `…the next bounded pass takes M's, from the update (${JSON.stringify(bf)})`);
  bf = (await one<{ r: Bf }>(`SELECT backfill_thought_payloads() AS r`)).r;
  assert(bf.rows === 7 && bf.from_tombstone === 3 && bf.from_update === 2 && bf.from_row === 2 && bf.unrecoverable === strangers + 1 && bf.skipped === 0 && bf.awaiting === strangers + 1 && bf.with_created_at === 1,
    `the pass fills D's, R's first and P's prior capture from their tombstones, V's and W's from the right update, P's standing and N2's NULL-diff capture from the live row (N2's with the row's created_at), reports U (and the strangers) as unrecoverable and leaves them waiting (${JSON.stringify(bf)})`);
  const texts = await q<{ thought_id: string; c: string | null; k: string }>(`SELECT thought_id, diff->>'content' AS c, COALESCE(diff ? 'created_at', false)::text AS k FROM thought_audit WHERE thought_id IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid) AND action = 'capture' ORDER BY created_at, seq`, [M, D, U, R, V, W, P]);
  assert(texts.find((t) => t.thought_id === M)?.c === "055: planted, then moved" && texts.find((t) => t.thought_id === D)?.c === "055: planted, then deleted" && texts.find((t) => t.thought_id === U)?.c === null
    && texts.find((t) => t.thought_id === V)?.c === "055: planted, edited by an older transaction — the first text"
    && texts.find((t) => t.thought_id === W)?.c === "055: planted, edited twice — the first text"
    && texts.filter((t) => t.thought_id === P).map((t) => t.c).join(" | ") === "055: planted, a prior incarnation long deleted | 055: planted, the standing text after a prior incarnation"
    && texts.filter((t) => t.thought_id === R).map((t) => t.c).join(" | ") === "055: planted, deleted, re-captured — the first text | 055: planted, deleted, re-captured — the second text" && texts.every((t) => t.k === "false"),
    `each capture row holds the text as it was captured — M's first text, D's, R's first and second, V's first, W's first, P's prior and standing, U's none — and none gained a created_at (${JSON.stringify(texts.map((t) => t.c))})`);
  const n2Diff = (await one<{ d: Diff; same: boolean }>(`SELECT a.diff AS d, (a.diff->>'created_at')::timestamptz = t.created_at AS same FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.id = $1::uuid`, [n2Row]));
  assert(n2Diff.d !== null && n2Diff.d.content === "055: planted with a NULL diff, filled by the pass" && n2Diff.same === true && Object.keys(n2Diff.d).sort().join(",") === "content,created_at",
    `the pass filled the NULL-diff capture onto an empty object — the content and the row's created_at, nothing else (cold read and run-it, second review pass: the mutant that dropped the COALESCE survived) (${JSON.stringify(n2Diff.d)})`);
  bf = (await one<{ r: Bf }>(`SELECT backfill_thought_payloads() AS r`)).r;
  assert(bf.rows === 0 && bf.unrecoverable === strangers + 1 && bf.skipped === 0 && bf.awaiting === strangers + 1, `a second pass fills nothing and still names the rows nothing derives for (${JSON.stringify(bf)})`);
  assert((await one<{ s: string | null }>(`SELECT current_setting('ob1.audit_amend', true) AS s`)).s === "" || (await one<{ s: string | null }>(`SELECT current_setting('ob1.audit_amend', true) AS s`)).s === null, "…and leaves the amendment setting as it found it");
  // Re-applying 055 is a no-op: the same bodies, no row moved, the pass finds nothing.
  n = await audits();
  const bodiesBefore = JSON.stringify(await q<{ f: string; s: string }>(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f, p.prosrc AS s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname IN ('thoughts_write_audit', 'thought_audit_refuse_mutation', 'ob1_stamp_actor', 'ob1_thought_diff', 'ob1_append_thought_event', 'ob1_actor_stamp', 'ob1_actor_stamp_kept', 'ob1_capture_payload', 'backfill_thought_payloads') ORDER BY 1`));
  await reapply("055");
  assert(JSON.stringify(await q<{ f: string; s: string }>(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f, p.prosrc AS s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname IN ('thoughts_write_audit', 'thought_audit_refuse_mutation', 'ob1_stamp_actor', 'ob1_thought_diff', 'ob1_append_thought_event', 'ob1_actor_stamp', 'ob1_actor_stamp_kept', 'ob1_capture_payload', 'backfill_thought_payloads') ORDER BY 1`)) === bodiesBefore
    && (await audits()) === n && (await waiting()) === strangers + 1, "re-applying 055 keeps every body byte for byte, writes no audit row, and its own backfill call finds nothing to fill");

  await db.exec(`DELETE FROM thoughts`);
  await db.exec(`DELETE FROM ob1_agents`);
}

// db/README.md quotes this suite's assertion total in two places ("Expected
// outcome" and the Testing block). It used to be edited by hand and drifted;
// this holds every count the README gives for test-schema.ts to what the suite
// actually ran (SMD-1805). A doc check, so it does not move the number it reads.
console.log("\n[doc] db/README.md states this suite's own assertion total");
{
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const n = total();
  const claims = [...readme.matchAll(/^.*\btest-schema\.ts\b.*$/gm)]
    .flatMap((line) => [...line[0].matchAll(/(\d+)\s+(?:assertions|passed)/g)].map((x) => Number(x[1])));
  docCheck(claims.length > 0, "db/README.md quotes test-schema.ts's assertion total at least once");
  docCheck(claims.every((c) => c === n),
    `every assertion count db/README.md gives for test-schema.ts is this run's ${n} (found ${[...new Set(claims)].join(", ") || "none"})`);
}

report();
