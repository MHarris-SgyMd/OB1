#!/usr/bin/env bun
/**
 * test-live.ts — verify the migrations against a REAL Postgres server.
 *
 * test-schema.ts covers schema semantics using PGlite, which is genuine
 * PostgreSQL but runs in-process over WASM. Three things it structurally cannot
 * reach, and all three have already hidden a defect:
 *
 *   1. The migration runner. migrate.ts speaks to a server over TCP with Bun.sql.
 *      PGlite is not a server, so the ledger, --dry-run, --baseline and drift
 *      detection were entirely untested until this file existed.
 *
 *   2. Driver-level parameter binding. The double-encoding bug that migration 005
 *      now rejects is invisible to a test that writes SQL literals — it only
 *      appears when a client binds a JS value to a jsonb parameter. Bun.sql binds
 *      a JS string as jsonb_typeof = 'string', silently emptying metadata.
 *
 *   3. The real planner on a real index. Whether HNSW is actually chosen.
 *
 * Requires DATABASE_URL pointing at a Postgres 15+ with pgvector 0.8+, on a
 * database this file may freely modify. It DROPS and recreates the schema, so
 * `dropSchema` refuses any host that is not loopback unless
 * OB1_ALLOW_REMOTE_DB=1 is set — that refusal is the safety net, the variable
 * is the override, and the override is a thing you have to mean.
 *
 *   ./with-postgres.sh bun test-live.ts        # starts a throwaway container
 *   DATABASE_URL=... bun test-live.ts          # against a LOCAL one you already have
 *   OB1_ALLOW_REMOTE_DB=1 DATABASE_URL=... bun test-live.ts   # anything else
 */

import { SQL } from "bun";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { BOUNDS_IN_FORCE_SQL, DB_LEVEL_SETTINGS_SQL, EMBEDDING_DIM, EMBEDDING_MODEL, HNSW_BOUNDS, MATCH_COUNT_CEILING, MATCH_THOUGHTS_SIGNATURE, ROUTE_ESTIMATE_MIN_PAGES, ROUTE_SAMPLE_PAGES, grantedFunctions, grantedSequences, grantedTables, grantedViews, parseSetConfig, versionAtLeast } from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SCHEMAS_DIR, TID_PROBE, applyFunctionSettings, applyMigrations, buffersOf, communitySchemaFiles, createAssert, sampleStatementOf, dropSchema, explainPrepared, extractBody, loadChunkRows, neverAnswers, plantLegacyRow, runMigrator, runScript, seededRandom, updatedAtTriggerState } from "./test-support.ts";
import { heartbeatFor, leaseRefusal } from "./lease.ts";
import { consolidateKey } from "../server-portable/consolidate.ts";
import { reachabilityReport, readHnswGraph, reachableFromEntry, type HnswElement, type HnswGraph } from "./hnsw-graph.ts";
import { corpusIngested, docOf, docsOf, INGEST_ACTOR, recordId, recordStructure, stampTier, upsertRecord, type Doc } from "./ingest-records.ts";
import { labelNames, linearAdapter, renderIssue, SAMPLE_ISSUE, type LinearIssue } from "./ingest-linear.ts";
import { ACTOR_NAME as SYNC_ACTOR, groupTicketRows, readTicketRows, syncIssue, type BrainRow, type Writer } from "./sync-linear.ts";
import type { LinearDoc } from "../evals/linear-corpus.ts";
import { SqlStore } from "../server-portable/store-sql.ts";
import { resolveEmbedConfig } from "../server-portable/embed.ts";
import { promote, refresh, refreshToolsReady, replayAndDiff } from "./tier.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.DATABASE_URL;

if (!URL_) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "  ./with-postgres.sh bun test-live.ts   (starts a throwaway container)\n" +
      "  DATABASE_URL=postgres://… bun test-live.ts   (loopback host; OB1_ALLOW_REMOTE_DB=1 for anything else)"
  );
  process.exit(2);
}


const { assert, skip, total, skipped, docCheck, report } = createAssert();

/** Run migrate.ts as a subprocess so its real exit code and output are observed. */
function migrate(...extra: string[]): Promise<{ code: number; out: string }> {
  return runMigrator(URL_!, undefined, ...extra);
}

const unit = (i: number) => {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i] = 1;
  return `[${v.join(",")}]`;
};

// Start from an empty database so the run is repeatable.
await dropSchema(URL_);

let sql = new SQL({ url: URL_, max: 4 });
console.log(`  server: ${(await sql`SELECT version() AS v`)[0].v.split(" on ")[0]}\n`);

// ── 1. The runner ────────────────────────────────────────────────────────────

console.log("[1] migrate.ts against a real server");
{
  const dry = await migrate("--dry-run");
  assert(dry.code === 0, "--dry-run exits 0");
  assert(/would apply \d+, skipped 0/.test(dry.out), "--dry-run reports everything pending");
  const none = await sql`SELECT to_regclass('public.thoughts') IS NULL AS absent`;
  assert(none[0].absent === true, "--dry-run created nothing");

  const run = await migrate();
  assert(run.code === 0, "apply exits 0");
  assert(/applied \d+, skipped 0/.test(run.out), "apply reports every migration applied");
  // The post-014 bounds check must actually run. It is wrapped in a catch that
  // turns any error into a soft warning, and for a whole commit that catch
  // swallowed a malformed-array-literal error on every run — so the check
  // never confirmed anything and the remedy branch was unreachable — while
  // this suite, asserting only the exit code and "applied N", stayed green
  // (eleventh review pass). This role owns the throwaway database, so the
  // seed lands and neither warning may appear.
  assert(!/could not read pg_settings/.test(run.out), "the migrator's walk-bounds check runs without falling into its catch");
  assert(!/were not seeded/.test(run.out), "…and, as the database owner, finds the bounds seeded");

  const again = await migrate();
  assert(again.code === 0, "re-run exits 0");
  assert(/applied 0, skipped \d+/.test(again.out), "re-run is a no-op — the ledger holds");

  const ledger = await sql`SELECT count(*)::int AS c FROM schema_migrations`;
  assert(ledger[0].c > 0, `schema_migrations records ${ledger[0].c} migrations`);
}

console.log("\n[2] Append-only enforcement");
{
  const target = join(HERE, "migrations", "002_match_thoughts.sql");
  const original = readFileSync(target, "utf8");
  try {
    writeFileSync(target, original + "\n-- edited after being applied\n");
    const drifted = await migrate();
    assert(drifted.code === 1, "editing an applied migration exits 1");
    assert(/DRIFTED 1/.test(drifted.out), "…and reports which one drifted");
    assert(/append-only/.test(drifted.out), "…and explains the rule");
  } finally {
    writeFileSync(target, original);
  }
  const restored = await migrate();
  assert(restored.code === 0, "restoring the file clears the drift");
}

// ── 3. Driver-level binding — the class PGlite cannot reach ──────────────────

console.log("\n[3] jsonb parameter binding through a real driver");
{
  await sql`DELETE FROM thoughts`;

  // Bun.sql binds a JS string to jsonb as a JSON *string*. Before migration 005
  // this silently stored {} and returned success.
  const [probe] = await sql`SELECT jsonb_typeof(${'{"metadata":{"k":1}}'}::jsonb) AS t`;
  assert(probe.t === "string", `a JS string binds as jsonb_typeof='${probe.t}' — the trap`);

  const [probe2] = await sql`SELECT jsonb_typeof(${{ metadata: { k: 1 } }}::jsonb) AS t`;
  assert(probe2.t === "object", "a JS object binds as jsonb_typeof='object' — the fix");

  let raised = false;
  let msg = "";
  try {
    await sql`SELECT upsert_thought(${"str payload"}, ${'{"metadata":{"k":1}}'}::jsonb)`;
  } catch (e) {
    raised = true;
    msg = (e as Error).message;
  }
  assert(raised, "the string form now raises instead of losing metadata");
  assert(/must be a JSON object/.test(msg), "…with a message naming the cause");
  assert((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c === 0, "…and writes nothing");

  await sql`SELECT upsert_thought(${"obj payload"}, ${{ metadata: { k: 1 } }}::jsonb)`;
  const [row] = await sql`SELECT metadata FROM thoughts WHERE content = ${"obj payload"}`;
  assert(row.metadata?.k === 1, `the object form stores metadata (${JSON.stringify(row.metadata)})`);
}

// ── 4. Real pgvector round trip ──────────────────────────────────────────────

console.log("\n[4] Capture and search through Bun.sql and real pgvector");
{
  await sql`DELETE FROM thoughts`;
  // Every row of this section also carries a shared fixture key, so the
  // ordering read below filters on it and takes match_thoughts' exact branch
  // (014/037: at most v_exact = 1,000 matching thoughts are scored by id, no
  // HNSW walk) — the same move [7] makes, and for the same reason. [7]'s
  // found-by reads flaked in CI because a walk over the tied unit-axis corpus
  // returned live rows short (SMD-1632, FORK.md's known-issues entry); this
  // section's vectors are less degenerate, but it asserts an exact order over
  // three rows, so the walk is not what it means to test — [5b] holds that.
  const S = { s: "04" } as const;
  const [cap] = await sql`
    SELECT upsert_thought(${"exact"}, ${{ metadata: { kind: "a", ...S } }}::jsonb, ${unit(0)}::vector) AS r`;
  assert(cap.r?.id != null, "3-arg atomic capture returns an id");

  const blend = new Array(EMBEDDING_DIM).fill(0);
  blend[0] = 0.9;
  blend[1] = 0.44;
  await sql`SELECT upsert_thought(${"near"}, ${{ metadata: { kind: "a", ...S } }}::jsonb, ${`[${blend.join(",")}]`}::vector)`;
  await sql`SELECT upsert_thought(${"distant"}, ${{ metadata: { kind: "b", ...S } }}::jsonb, ${unit(1)}::vector)`;

  const rows = await sql`SELECT content, similarity FROM match_thoughts(${unit(0)}::vector, -1.0, 10, ${S}::jsonb)`;
  assert(rows.length === 3, `match_thoughts returned ${rows.length} rows`);
  assert(rows[0].content === "exact", `closest first (${rows[0].content})`);
  assert(rows[1].content === "near", `then the blend (${rows[1].content})`);
  assert(Math.abs(Number(rows[0].similarity) - 1) < 1e-6, "exact scores ~1.0");

  const filtered = await sql`SELECT content FROM match_thoughts(${unit(0)}::vector, -1.0, 10, ${{ kind: "b" }}::jsonb)`;
  assert(filtered.length === 1 && filtered[0].content === "distant", "jsonb containment filter narrows correctly");

  // A metadata-only re-capture must not blank a stored vector.
  await sql`SELECT upsert_thought(${"  EXACT  "}, ${{ metadata: { extra: 1 } }}::jsonb, NULL::vector)`;
  const [merged] = await sql`SELECT metadata, embedding IS NOT NULL AS has FROM thoughts WHERE content = ${"exact"}`;
  assert((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c === 3, "normalised re-capture added no row");
  assert(merged.metadata?.kind === "a" && merged.metadata?.extra === 1, "metadata merged, not replaced");
  assert(merged.has === true, "a NULL embedding did not blank the stored vector");
}

console.log("\n[5] The planner can reach the HNSW index");
{
  // Reachable, not chosen: with sequential scans disabled the index is the
  // plan, which proves it exists and fits the operator class. Whether the
  // planner CHOOSES it on the function's own statements, at a size where it
  // has a real alternative, is [5c].
  // SET LOCAL inside one transaction, not a session SET on this max-4 pool: the
  // pool does not promise the EXPLAIN the connection that received the SET,
  // and a connection left with seq scans off would reach later sections.
  const explainOrdered = (orderBy: string) => sql.begin(async (tx: SQL) => {
    await tx`SET LOCAL enable_seqscan = off`;
    return (await tx.unsafe(`EXPLAIN SELECT id FROM thoughts ORDER BY ${orderBy} LIMIT 1`))
      .map((r: Record<string, string>) => Object.values(r)[0])
      .join(" ");
  });
  // Since 039 the index is over `embedding::halfvec(D)`, so the ORDER BY that
  // reaches it carries the cast on both sides — the function's own — and an
  // ORDER BY on the raw column, which had the index until 039, no longer does.
  const plan = await explainOrdered(`embedding::halfvec(${EMBEDDING_DIM}) <=> '${unit(0)}'::vector::halfvec(${EMBEDDING_DIM})`);
  assert(/thoughts_embedding_idx/.test(plan), "thoughts_embedding_idx appears in the plan for the body's ORDER BY (the halfvec cast on both sides — 039)");
  assert(!/thoughts_embedding_idx/.test(await explainOrdered(`embedding <=> '${unit(0)}'::vector`)), "…and not in the plan for an ORDER BY on the raw column: the cast is the index's key");
}

console.log("\n[5b] A filtered match_thoughts agrees with an exact scan at scale (migration 014)");
{
  // 014 seeds the walk's bounds with ALTER DATABASE, which a session reads at
  // connect. This pool predates the migration, so open a fresh one — and assert
  // the bounds are in force, since the section claims to exercise them.
  await sql.close();
  sql = new SQL({ url: URL_, max: 1 });
  // What the DATABASE has, not the shipped literals: 014 leaves an operator's
  // earlier value alone, and a non-owner role cannot seed at all. Assert that
  // whatever pg_db_role_setting holds is what a fresh session sees.
  const [seeded] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
  const want = parseSetConfig(seeded?.cfg);
  const inForce = Object.fromEntries((await sql.unsafe(BOUNDS_IN_FORCE_SQL)).map((r: { name: string; value: string | null }) => [r.name, r.value]));
  if (HNSW_BOUNDS.every((b) => want[b])) {
    assert(HNSW_BOUNDS.every((b) => inForce[b] === want[b]),
      `a fresh session sees the database-level bounds (${HNSW_BOUNDS.map((b) => `${b}=${inForce[b]}`).join(", ")})`);
  } else {
    skip("a fresh session sees the database-level bounds", "not seeded on this database — the migrating role does not own it");
  }
  // 2,000 random rows through a real HNSW index, 1% of them tagged. Under 007
  // the tagged rows were almost never among the 40 nearest, so a filtered
  // search returned almost nothing — db/bench-hnsw.ts has the numbers. The
  // tagged filter matches 20 rows, under the exact threshold, so it MUST return
  // what a full scan returns; the untagged filter matches 1,980, above it, so
  // it takes the HNSW walk with the predicate inside the scan and is held to
  // the exact answer within the index's approximation.
  await sql`DELETE FROM thoughts`;
  const { unitVector } = seededRandom(968);
  const random = () => `[${unitVector(EMBEDDING_DIM).join(",")}]`;
  const N = 2000;
  for (let i = 0; i < N; i += 100) {
    const values = Array.from({ length: 100 }, (_, k) => {
      const tagged = (i + k) % 100 === 7; // exactly 1%
      return `('row ${i + k}', '{"tagged": ${tagged}}'::jsonb, '${random()}'::vector)`;
    }).join(",");
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  // Chunk rows for one thought in five, carrying the parent's own vector, so
  // the chunk CTE has an index to reach and a table to scan in [5c] (the
  // assertions below are unaffected — the helper says why).
  await loadChunkRows(sql, 5);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`VACUUM ANALYZE thought_chunks`);

  const exactTop = (qv: string, filter: string) =>
    sql.begin(async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL enable_indexscan = off`);
      await tx.unsafe(`SET LOCAL enable_bitmapscan = off`);
      return tx.unsafe(`SELECT id FROM thoughts WHERE metadata @> '${filter}' ORDER BY embedding <=> '${qv}'::vector LIMIT 10`);
    });
  let agree = 0;
  let walkOverlap = 0;
  let walkShort = 0;
  // Fifty queries, not ten. On this fixture the planner priced the vector
  // index out of the walk branch — every call read the GIN bitmap, which is
  // exact, under both plan modes — and the ten-query sum sat at 100. Since
  // 039 the halfvec index, a third of the pages, wins the CUSTOM plans
  // plpgsql gives the first five calls of a session: those five walk (2,000
  // random unit vectors at 1,024 dimensions, HNSW's hardest case, about 7 of
  // 10 exact ids at ef_search 40 under either index) and every call after
  // the generic plan is adopted reads the bitmap again. Measured per query
  // over 100: calls one to five lost two to six ids each on every build,
  // calls six to a hundred lost none; under the vector index none did. Ten
  // queries are therefore the five that walk plus five that do not; fifty
  // put the statistic where the walk's failure shape — short, or wrong rows
  // — is what moves it, and 039's header has the plan reads.
  const QUERIES = 50;
  for (let q = 0; q < QUERIES; q++) {
    const qv = random();
    const thin = new Set((await exactTop(qv, '{"tagged": true}')).map((r: { id: string }) => r.id));
    const got = await sql.unsafe(`SELECT id FROM match_thoughts('${qv}'::vector, -1.0, 10, '{"tagged": true}'::jsonb)`);
    if (got.length === 10 && got.every((r: { id: string }) => thin.has(r.id))) agree++;
    const broad = new Set((await exactTop(qv, '{"tagged": false}')).map((r: { id: string }) => r.id));
    const walked = await sql.unsafe(`SELECT id FROM match_thoughts('${qv}'::vector, -1.0, 10, '{"tagged": false}'::jsonb)`);
    if (walked.length !== 10) walkShort++;
    walkOverlap += walked.filter((r: { id: string }) => broad.has(r.id)).length;
  }
  assert(agree === QUERIES, `a 1% filter (20 rows, the exact branch) returns the exact top-10 on ${agree}/${QUERIES} random queries`);
  assert(walkShort === 0, `a 99% filter (1,980 rows, the walk branch) returns 10 rows on every query (${walkShort} short)`);
  assert(walkOverlap >= 0.9 * QUERIES * 10, `…and ${walkOverlap}/${QUERIES * 10} of them are the exact top-10 (HNSW is approximate and random vectors are its hardest case; the first five calls of a session walk the halfvec index under custom plans, the rest read the GIN bitmap — 039's header)`);

  // match_count is clamped inside the function, as 012 clamps its p_limit: the
  // cost of a call is now proportional to it, and direct callers are unbounded.
  // The ceiling is the one config.mjs defines, so the doc and the body agree.
  const many = await sql.unsafe(`SELECT count(*)::int AS c FROM match_thoughts('${random()}'::vector, -1.0, ${MATCH_COUNT_CEILING * 2}, '{}'::jsonb)`);
  assert(Number(many[0].c) === MATCH_COUNT_CEILING, `match_count ${MATCH_COUNT_CEILING * 2} over ${N} rows returns ${MATCH_COUNT_CEILING} — the function's own ceiling (got ${many[0].c})`);

  const [{ cfg }] = await sql`
    SELECT array_to_string(proconfig, ',') AS cfg FROM pg_proc
    WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg ?? "")), "match_thoughts carries hnsw.iterative_scan on a real server");
  // The LIBRARY's version, not the catalog record: a binary upgraded under an
  // old volume runs 014 fine while pg_extension still says 0.7.x — the state
  // the second review pass reproduced — and this section just proved it works.
  const [{ library }] = await sql`SELECT default_version AS library FROM pg_available_extensions WHERE name = 'vector'`;
  assert(versionAtLeast(String(library), 0, 8), `the server's pgvector library (${library}) supports the iterative scan 014 declares`);
}

console.log("\n[5c] The unfiltered candidate scan reaches both HNSW indexes at the configured width, with and without a recency weight (migrations 019, 020)");
{
  // SMD-969 (upstream #469). At the shipped width a vector is TOASTed, and the
  // planner's sequential-scan estimate counts heap pages and never the detoast
  // reads — so on 014's function it chose a seq scan of the chunk table at
  // every count and of `thoughts` above the default one, reading ten times the
  // buffers the index reads. 019 puts `SET enable_seqscan = off` on the
  // function. This section is the CI form of db/bench-plan.ts, at the smallest
  // scale that reproduces the decision: [5b]'s 2,000 rows and 400 chunk rows
  // at the configured width. The statement is the function's own unfiltered
  // RETURN QUERY, read from the catalog (EXPLAIN cannot see into plpgsql), run
  // under the function's own SET clauses so the plan is the one a call gets —
  // under both plan modes, since plpgsql may use either after five calls.
  //
  // The control comes first and is asserted too: the same statement WITHOUT
  // 019's setting must leave at least one candidate CTE off its HNSW index at
  // this scale — judged by the two index names, not by any `Seq Scan` in the
  // plan, since the outer merge's join seq-scans the heap on a small table
  // whether or not the CTEs did (first review pass). Where the planner already
  // takes both indexes unaided — a narrower width whose vectors are inline, a
  // server tuned differently — the scale does not reproduce the decision, and
  // the control is SKIPPED with the reason rather than failing a correct 019;
  // the assertions after it still hold what the setting must deliver.
  const body = await extractBody(sql, "unfiltered", EMBEDDING_DIM);
  const qv = `[${seededRandom(969).unitVector(EMBEDDING_DIM).join(",")}]`;
  const explain = async (count: number, mode: "force_custom_plan" | "force_generic_plan", withSettings: boolean, weight = 0) =>
    sql.begin(async (tx: SQL) => {
      if (withSettings) await applyFunctionSettings(tx);
      else await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`); // 014's one setting: the function before 019
      return explainPrepared(tx, { body, dim: EMBEDDING_DIM, args: `'${qv}'::vector, -1.0, ${count}, '{}'::jsonb, ${weight}, 90.0`, mode, warm: true });
    });
  const onIndex = (plan: string) => ({
    thoughts: /Index Scan using thoughts_embedding_idx on thoughts/.test(plan),
    chunks: /Index Scan using thought_chunks_embedding_idx on thought_chunks/.test(plan),
  });
  // Named by table and alias, for the message: the direct CTE reads `thoughts
  // t` (renamed `t_1` when the outer merge also reads `thoughts t`), the chunk
  // CTE `thought_chunks c`; the merge's own join is listed when it seq-scans.
  const seqOn = (plan: string) => [...new Set([...plan.matchAll(/Seq Scan on (thoughts|thought_chunks) (\w+)/g)].map((m) => `${m[1]} ${m[2]}`))];

  const [{ storage }] = await sql`SELECT typstorage AS storage FROM pg_type WHERE typname = 'vector'`;
  // The TOAST relation alone: total less the heap less every index (the HNSW
  // index is of the same order as the TOAST here, and is not out-of-line data).
  const [{ toast }] = await sql`SELECT pg_size_pretty(pg_total_relation_size('thoughts') - pg_relation_size('thoughts') - pg_indexes_size('thoughts')) AS toast`;
  for (const count of [10, 50]) {
    const control = await explain(count, "force_custom_plan", false);
    const off = onIndex(control.text);
    const label = `count ${count}: without 019's setting the planner leaves ${[!off.thoughts && "the thoughts CTE", !off.chunks && "the chunk CTE"].filter(Boolean).join(" and ") || "neither CTE"} off its HNSW index at ${EMBEDDING_DIM} dimensions (seq scans: ${seqOn(control.text).join(", ") || "none"}; ${control.buffers} buffers; vector storage '${storage}', ${toast} of TOAST)`;
    if (!off.thoughts || !off.chunks) assert(true, `${label} — the scale reproduces the decision`);
    else skip(label, "the planner already takes both indexes unaided here, so this scale and width do not reproduce the decision; the assertions below still hold what 019 must deliver");
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      const { text: plan, buffers } = await explain(count, mode, true);
      const on = onIndex(plan);
      assert(on.thoughts,
        `count ${count}, ${mode.replace("force_", "").replace("_plan", "")} plan: the thoughts CTE is an Index Scan using thoughts_embedding_idx (${buffers} buffers)`);
      assert(on.chunks, `…and the chunk CTE an Index Scan using thought_chunks_embedding_idx`);
      assert(seqOn(plan).length === 0, `…and nothing in the statement seq-scans (${seqOn(plan).join(", ") || "none"})`);
    }
  }

  // 020 (SMD-945): under a recency weight the candidate window widens fourfold
  // and the plan must not change — the ticket's "still an index scan with a
  // non-zero recency weight", at the scale and width above. The CTEs' Limit
  // nodes show the window: 16 * count candidates from `thoughts` (the chunk
  // table has 400 rows here, so its CTE is capped by the table at count 50).
  for (const count of [10, 50]) {
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      const { text: plan, buffers } = await explain(count, mode, true, 0.3);
      const on = onIndex(plan);
      assert(on.thoughts && on.chunks && seqOn(plan).length === 0,
        `count ${count}, ${mode.replace("force_", "").replace("_plan", "")} plan, recency_weight 0.3: both candidate CTEs are Index Scans on their HNSW indexes and nothing seq-scans (${buffers} buffers)`);
      // `Limit  (cost=…) (actual time=… rows=N …)` since explainPrepared prints
      // costs; the estimate's own `rows=` sits inside the cost parens, so the
      // match reaches past them to the actual clause (SMD-1018 review pass).
      const limits = [...plan.matchAll(/Limit(?:\s+\(cost=[^)]*\))?\s+\(actual time=[^)]*rows=(\d+)/g)].map((m) => Number(m[1]));
      assert(limits.includes(count * 16), `…and the window is ${count * 16} candidates, four times the unweighted one (Limit rows: ${limits.join(", ")})`);
    }
  }

  // The estimates, on a real server (db/test-schema.ts [20] holds them under PGlite).
  const [{ mt, kw }] = await sql`
    SELECT (SELECT prorows FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure) AS mt,
           (SELECT prorows FROM pg_proc WHERE oid = 'search_thoughts_keyword(text, int, int, jsonb)'::regprocedure) AS kw`;
  assert(Number(mt) === 10 && Number(kw) === 25, `match_thoughts declares ROWS 10 and search_thoughts_keyword ROWS 25 on a real server (${mt}, ${kw})`);
}

console.log("\n[5d] The routing count is skipped when a sample of the heap says the filter is far too broad, and runs otherwise exactly as before (migrations 037 and 038)");
{
  // 037 gates 014's capped GIN collection — the statement every filtered call
  // opened with, whose cost is the number of matching rows — behind a sample
  // of ROUTE_SAMPLE_PAGES pages, skipping it when the sample puts the filter
  // at ten times the exact threshold on eight hits over three pages; 038 draws
  // those pages by TID range, one block per probe, so every draw reaches its
  // pages. The skip needs a table past ten times the threshold, which PGlite's
  // [8e] cannot hold; this section can. 25,000 rows at the configured width, generated on
  // the server (a client round trip per row would be the slow part), every row
  // tagged broad and one in 250 also tagged thin. The HNSW index is dropped for
  // the load and put back on the emptied table at the end: maintaining it on
  // 25,000 inserts at the shipped width is a minute the assertions here do not
  // need, and without it the walk is a GIN bitmap and a sort — exact, and slow
  // in a way that does not matter to a section about the statement BEFORE it.
  await sql`DELETE FROM thoughts`;
  const [{ hnswDef }] = await sql.unsafe(`SELECT pg_get_indexdef('thoughts_embedding_idx'::regclass) AS "hnswDef"`);
  // Read by the finally block below as well as the section: the last definer
  // of match_thoughts — 041, 039's body (038's gate, the half-precision walk)
  // run with jit off and its two planner paths pinned — applied through
  // test-support with the one override SchemaOptions carries.
  const opts041 = { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f: string) => f.startsWith("041") };
  const body = async () => String((await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure`)[0].s);
  // 040's clause and 041's pins, read with the body: 039's body satisfies
  // every other check here, so without this a slip back to applying 039 or
  // 040 would leave that as the shipped state for the sections after and
  // nothing would say (review pass 5 of SMD-1624).
  const hasClauses = async () => {
    const cfg = String((await sql`SELECT array_to_string(proconfig, ',') AS c FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure`)[0].c ?? "");
    return /(^|,)jit=off(,|$)/.test(cfg) && /(^|,)enable_nestloop=on(,|$)/.test(cfg) && /(^|,)enable_tidscan=on(,|$)/.test(cfg);
  };
  // The floor lowered to 0 for the section, so the gate runs on this heap.
  // Applied BEFORE the index is dropped and the rows loaded. 039 needed that
  // order — its swap block builds the index when the shipped name is missing,
  // and a build over 25,000 rows at the shipped width is the minute this
  // section avoids — and 040 and 041, which carry no swap, keep it.
  await applyMigrations(URL_, { ...opts041, routeEstimateMinPages: 0 });
  assert(/IF v_pages >= 0 THEN/.test(await body()) && TID_PROBE.test(await body()) && (await hasClauses()), "041 is installed with its floor at 0 (038's gate, carried through 039), jit = off and both pins on the function: the sample runs on every filtered call to this table");
  await sql.unsafe(`DROP INDEX thoughts_embedding_idx`);
  // User triggers off for the load, as the bench does: 008's audit trigger
  // would write a row per row (25,000 here, then 25,000 more for the DELETE)
  // into a table later sections read differentially — nothing this section
  // measures — and the heap they leave behind moves a timing-sensitive race
  // that follows ([6g]). Re-enabled in the finally block.
  await sql.unsafe(`ALTER TABLE thoughts DISABLE TRIGGER USER`);
  let failure: unknown;
  try {
    const N = 25_000;
    await sql.unsafe(`
      INSERT INTO thoughts (content, metadata, embedding)
      SELECT 'gate ' || r.i,
             CASE WHEN r.i % 250 = 0 THEN '{"broad": true, "thin": true}' ELSE '{"broad": true}' END::jsonb,
             -- correlated through r.i so the subquery runs per row: uncorrelated
             -- it is an InitPlan evaluated once, and every row gets one vector
             (SELECT ('[' || string_agg((random() - 0.5)::text, ',') || ']')::vector FROM generate_series(1, ${EMBEDDING_DIM} + 0 * r.i))
      FROM generate_series(1, ${N}) AS r(i)`);
    await sql.unsafe(`VACUUM ANALYZE thoughts`);
    const [{ pages }] = await sql.unsafe(`SELECT (pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int)::int AS pages`);
    assert(Number(pages) > 0 && Number(pages) < ROUTE_ESTIMATE_MIN_PAGES, `${N.toLocaleString()} rows at ${EMBEDDING_DIM} dimensions are ${pages} heap pages (the vectors are TOASTed), under the shipped floor of ${ROUTE_ESTIMATE_MIN_PAGES}`);

    // The deployed body — 041, carrying 038's sample — kept for the timing at the end: by then 020's re-apply has replaced it.
    const bodyGate = await body();

    // The observable: 014's collection is one scan of the GIN index per call,
    // and nothing else in a call to this table scans it the same way twice — so
    // the difference in GIN scans per call between 020's body and 038's, on the
    // same table, is the collection skipped. pg_stat counts are flushed on
    // request (PG 15+), then read after one more statement.
    const ginScans = async () => {
      await sql`SELECT pg_stat_force_next_flush()`;
      await sql`SELECT 1`;
      return Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'thoughts_metadata_idx'`)[0].idx_scan);
    };
    const { unitVector } = seededRandom(1463);
    // Twenty calls. Under 037 the gate missed a broad filter when its
    // TABLESAMPLE draw reached fewer than three pages — 17 in 1,000 draws on
    // this fixture — and the band below was 0.75–1.0; 038 draws eight blocks
    // and reads each, so a draw reaches fewer than three pages only when all
    // eight land on one or two of some 400 (about 3e-14), and the band is
    // exact.
    const QUERIES = 20;
    const queries = Array.from({ length: QUERIES }, () => `[${unitVector(EMBEDDING_DIM).join(",")}]`);
    const exactTop = (qv: string, filter: string) =>
      sql.begin(async (tx: SQL) => {
        await tx.unsafe(`SET LOCAL enable_indexscan = off`);
        await tx.unsafe(`SET LOCAL enable_bitmapscan = off`);
        return tx.unsafe(`SELECT id FROM thoughts WHERE metadata @> '${filter}' ORDER BY embedding <=> '${qv}'::vector, id LIMIT 10`);
      });
    /**
     * GIN scans per call and exact-answer agreement, for one filter under the
     * installed body. Every call runs on its own connection, so each is the
     * function's FIRST execution in its session and every statement in the
     * body gets a fresh custom plan: on one connection plpgsql plans the first
     * five calls custom and may switch the WALK to a generic plan from the
     * sixth, and the two plans do not scan the GIN index the same number of
     * times (the chunk join by GIN bitmap on the parent, or by primary key) —
     * so a run's per-call count depended on where in that trajectory each
     * arm was, and the arms need not agree (this section's first CI run read
     * 020 at 2.00 a call and 038 at 1.50 where the same tree read 2.75 and
     * 1.75 locally and 2.00 and 1.00 on a freshly reset schema). A backend
     * flushes its own statistics: the flush is forced on the calling
     * connection before it closes, then the count is read here.
     */
    const measure = async (filter: string): Promise<{ scans: number; scansPerCall: number; agree: number; perCall: number[] }> => {
      let agree = 0;
      const perCall: number[] = [];
      const g0 = await ginScans();
      let last = g0;
      for (const qv of queries) {
        const want = new Set((await exactTop(qv, filter)).map((r: { id: string }) => r.id));
        const one = new SQL({ url: URL_, max: 1 });
        let got: { id: string }[];
        try {
          got = await one.unsafe(`SELECT id FROM match_thoughts('${qv}'::vector, -1.0, 10, '${filter}'::jsonb)`);
          await one`SELECT pg_stat_force_next_flush()`;
          await one`SELECT 1`;
        } finally {
          await one.close();
        }
        if (got.length === 10 && got.every((r) => want.has(r.id))) agree++;
        const now = await ginScans();
        perCall.push(now - last);
        last = now;
      }
      // The oracle runs inside the bracket too, but with index and bitmap scans
      // off it seq-scans and touches no GIN index; what the bracket counts is
      // the function's own scans.
      const scans = last - g0;
      return { scans, scansPerCall: scans / QUERIES, agree, perCall };
    };
    const BROAD = '{"broad": true}';
    const THIN = '{"thin": true}';
    const gatedBroad = await measure(BROAD);
    const gatedThin = await measure(THIN);
    assert(gatedBroad.agree === QUERIES, `under the gate (041, carrying 038's), a filter matching every row (${N.toLocaleString()}, the walk) returns the exact top-10 on ${gatedBroad.agree}/${QUERIES} queries — without an HNSW index the walk is exact`);
    assert(gatedThin.agree === QUERIES, `…and a filter matching ${N / 250} rows (the exact branch) on ${gatedThin.agree}/${QUERIES}`);

    // 020's body on the same table — the collection on every filtered call.
    await applyMigrations(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("020") });
    assert(!TID_PROBE.test(await body()) && !/v_broad/.test(await body()), "020 re-applied over 041: the body has no sample and no gate (the state a hand re-apply of 020 leaves; preflight's remedy names 041, the last definer, for that reason)");
    const plainBroad = await measure(BROAD);
    const plainThin = await measure(THIN);
    // The raw scan counts, not the per-call quotients: x/20 − y/20 is not
    // exactly 1 in IEEE arithmetic for every x − y = 20 (41/20 − 21/20 is
    // 0.9999999999999998), so the property is asserted on the integers
    // (SMD-1526 review pass 3).
    const saved = plainBroad.scans - gatedBroad.scans;
    // Every draw reads eight pages of some 65 rows each, all broad, so every
    // call meets the three conditions (condition 1 needs about 200 hits on
    // this heap; eight pages hold some 500) and skips the collection; the
    // rest of a call's GIN scans (the walk's bitmap) are the same under both
    // bodies and cancel. Exactly one fewer per call is the band — 037's draw
    // could reach fewer than three pages and missed, which is why this
    // section once accepted five misses in twenty.
    assert(saved === QUERIES, `on the broad filter the gate makes exactly one fewer GIN scan per call than 020 over ${QUERIES} calls — the collection skipped on every call (020: ${plainBroad.scansPerCall.toFixed(2)} a call, 041: ${gatedBroad.scansPerCall.toFixed(2)}; per call 020 [${plainBroad.perCall.join(" ")}], 041 [${gatedBroad.perCall.join(" ")}])`);
    assert(plainThin.scans === gatedThin.scans, `on the thin filter both bodies scan the GIN index the same ${gatedThin.scansPerCall.toFixed(2)} times a call — the collection ran, and the exact branch answered (per call 020 [${plainThin.perCall.join(" ")}], 041 [${gatedThin.perCall.join(" ")}])`);
    assert(plainBroad.agree === QUERIES && plainThin.agree === QUERIES, "…and 020's answers are the same exact top-10 (the gate changed the route, not the answer)");

    // The sample's cost against the collection's on this table, printed for the
    // record: the header's numbers are a bench's, this is one server on one day.
    const timed = async (stmt: string, n = 20): Promise<number> => {
      const ts: number[] = [];
      for (let i = 0; i < n; i++) { const t0 = performance.now(); await sql.unsafe(stmt); ts.push(performance.now() - t0); }
      return ts.sort((a, b) => a - b)[Math.floor(n / 2)];
    };
    // The deployed statement, read out of 038's body rather than a copy kept
    // here — the class of thing review pass 1 removed from [8e].
    const sampleText = sampleStatementOf(bodyGate, Number(pages), BROAD);
    const sampleMs = sampleText === null ? NaN : await timed(sampleText);
    const collectMs = await timed(`SELECT array_agg(s.id) FROM (SELECT t.id FROM thoughts t WHERE t.metadata @> '${BROAD}'::jsonb AND (t.embedding IS NOT NULL OR EXISTS (SELECT 1 FROM thought_chunks k WHERE k.thought_id = t.id)) LIMIT 1001) s`);
    console.log(`      (${ROUTE_SAMPLE_PAGES} pages of ${pages} read by TID range: ${sampleMs.toFixed(2)} ms a call; the collection on the ${N.toLocaleString()}-row filter: ${collectMs.toFixed(2)} ms — round trip included in both)`);

  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // The shipped state back on every path — a throw above would otherwise
    // leave 25,000 rows and no HNSW index to [6]..[16] (SMD-1463's first review pass): 041
    // with its floor, and 027, because 020's file also redefines
    // search_thoughts_hybrid as 020 had it, without 027's relative floor, and
    // [15] holds that floor (the first run of this section left 020's hybrid
    // behind and [15] failed on it); the table emptied; the index rebuilt
    // (instant on no rows). The table and the index first — they depend on
    // nothing — so a throw from the re-apply cannot leave them behind (second
    // review pass); and when the section itself threw, a cleanup that fails
    // on the same fault is reported, not thrown, so the cause is what the
    // run shows (SMD-1463's fourth review pass).
    try {
      await sql`DELETE FROM thoughts`;
      await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER USER`);
      // The 25,000 dead tuples and their pages go too, so the sections after
      // start from the heap they would have had without this one.
      await sql.unsafe(`VACUUM thoughts`);
      await sql.unsafe(String(hnswDef));
      await applyMigrations(URL_, { ...opts041, only: (f) => f.startsWith("027") || f.startsWith("041") });
      assert(new RegExp(`IF v_pages >= ${ROUTE_ESTIMATE_MIN_PAGES} THEN`).test(await body()) && TID_PROBE.test(await body()) && (await hasClauses()), `041 restored with the shipped floor of ${ROUTE_ESTIMATE_MIN_PAGES} pages, jit = off and both pins`);
      assert(/ob1:relative-floor/.test(String((await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = 'search_thoughts_hybrid(vector, text, float, int, jsonb, float, float)'::regprocedure`)[0].s)),
        "…and search_thoughts_hybrid carries 027's sentinel again, not the 020 body the re-apply above installed");
    } catch (cleanup) {
      if (failure === undefined) throw cleanup;
      console.error(`      [5d] cleanup failed after the section did: ${(cleanup as Error).message}`);
    }
  }
}

console.log("\n[5e] A planner path disabled at session level no longer JIT-compiles the gate's sample, and the two the sample is built around are pinned: match_thoughts runs with jit = off (migration 040, SMD-1624) and enable_nestloop = on, enable_tidscan = on (migration 041, SMD-1677 and SMD-1703)");
{
  // 038's sample statement has one viable path per piece — a TID Range Scan
  // for the block, a Nested Loop for the LATERAL join, Sort/Unique or
  // HashAggregate for the DISTINCT draw — and a session, role or database
  // that turns one off adds disable_cost (1e10) to the plan, which carries
  // the statement past every JIT threshold: the same plan, the same eight
  // buffers, and ~50 ms of compiler on every filtered call (038's header;
  // 040's has the table). 040 puts `jit = off` on the function. Three checks
  // per disabled path, on a small heap with the floor lowered so the sample
  // runs: the statement read out of the installed body, EXPLAINed under the
  // function's own settings, has no JIT block; the same statement with jit
  // forced back on has one — the trigger is real on this server, so the
  // first check has teeth; and through the function, the median call under
  // 040 is within the default's while the mutant — 040's clause RESET on the
  // function, what a redefinition without it leaves — pays the compile. The
  // forced-on plan and the timing run only where the server has JIT
  // (pg_jit_available()); the catalog and plan checks run everywhere.
  // Since 041 two of the three paths are pinned on the function
  // (enable_nestloop = on, enable_tidscan = on — SMD-1677, SMD-1703): under
  // those two settings the plan is the DEFAULT's, at an ordinary cost, with
  // no Disabled node on 18 and the sample's buffers, not the heap's — and the
  // pin's mutant (RESET, what 040's file re-applied by hand leaves) is what
  // brings disable_cost, or 18's Seq Scan of the heap per probe, back. The
  // one path left unpinned, hashagg with sort, keeps the compile story: its
  // cost is still disable_cost on 14–17, and the JIT teeth run against it.
  // Both: a build with JIT, and a server whose own `jit` is on — an operator
  // may have set it off at database level (the header calls that a valid
  // setting), and then the mutant below has nothing to compile and the timing
  // would fail for the wrong reason (review pass 1).
  // Read on a FRESH connection, the kind the timing below measures on: the
  // suite's pool connected before this section, and a database- or
  // role-level `jit` set since would read as the pool's stale value while
  // every measured call saw the new one (review pass 2, run-it).
  const jitAvailable = await (async () => {
    const one = new SQL({ url: URL_, max: 1 });
    try {
      return Boolean((await one.unsafe(`SELECT pg_jit_available() AND current_setting('jit') = 'on' AS ok`))[0].ok);
    } finally {
      await one.close();
    }
  })();
  // PostgreSQL 18 replaced the disable_cost penalty with a count of disabled
  // nodes kept beside the cost (`Disabled: true` in the plan), so a disabled
  // path no longer carries a statement past jit_above_cost and the compile
  // this section exists for cannot be triggered that way there: on 18 the
  // checks below assert its ABSENCE with and without the clause, and the
  // mutant timing has nothing to measure (review pass 2, run on 18.6). The
  // clause stands on 18 for the generic plan's flat estimate (040's header).
  const disableCost = Number((await sql.unsafe(`SELECT current_setting('server_version_num')::int AS v`))[0].v) < 180000;
  const N = 3_000;
  await sql`DELETE FROM thoughts`;
  const [{ hnswDef }] = await sql.unsafe(`SELECT pg_get_indexdef('thoughts_embedding_idx'::regclass) AS "hnswDef"`);
  await sql.unsafe(`DROP INDEX thoughts_embedding_idx`);
  await sql.unsafe(`ALTER TABLE thoughts DISABLE TRIGGER USER`);
  const opts041 = { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f: string) => f.startsWith("041") };
  const body = async () => String((await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure`)[0].s);
  const proconfig = async () => String((await sql`SELECT array_to_string(proconfig, ',') AS c FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure`)[0].c ?? "");
  let failure: unknown;
  try {
    await sql.unsafe(`
      INSERT INTO thoughts (content, metadata, embedding)
      SELECT 'jit ' || r.i, '{"broad": true}'::jsonb,
             (SELECT ('[' || string_agg((random() - 0.5)::text, ',') || ']')::vector FROM generate_series(1, ${EMBEDDING_DIM} + 0 * r.i))
      FROM generate_series(1, ${N}) AS r(i)`);
    await sql.unsafe(`VACUUM ANALYZE thoughts`);
    // The index back on the loaded rows (seconds at this size), so the walk
    // through the function is the shipped walk and its cost is not the
    // fixture's.
    await sql.unsafe(String(hnswDef));
    const [{ pages }] = await sql.unsafe(`SELECT (pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int)::int AS pages`);
    await applyMigrations(URL_, { ...opts041, routeEstimateMinPages: 0 });
    assert(/(^|,)jit=off(,|$)/.test(await proconfig()) && /(^|,)enable_nestloop=on(,|$)/.test(await proconfig()) && /(^|,)enable_tidscan=on(,|$)/.test(await proconfig()) && /IF v_pages >= 0 THEN/.test(await body()), `041 is installed with its floor at 0, jit = off and both pins on the function (proconfig ${await proconfig()})`);
    const BROAD = '{"broad": true}';
    const sampleText = sampleStatementOf(await body(), Number(pages), BROAD);
    assert(sampleText !== null, "the sample statement reads out of the installed body (039's, byte for byte)");
    const { unitVector } = seededRandom(1624);
    const queries = Array.from({ length: 12 }, () => `[${unitVector(EMBEDDING_DIM).join(",")}]`);
    // The third column is the node 18 takes WITHOUT the pin: with
    // enable_tidscan off, 18 does not build the TID Range path at all
    // (tidpath.c returns before it) and the probe is a sequential scan of the
    // heap per block — 13's state, the cost the gate exists to avoid, which
    // 041's `enable_tidscan = on` reaches (SMD-1703); the other two disable a
    // node above the probe and the probe keeps its TID Range Scan (review
    // pass 3 of SMD-1624). The fourth is whether 041 pins the path.
    const CASES: [string, string[], RegExp, boolean][] = [
      ["enable_tidscan = off", ["enable_tidscan"], /Seq Scan on thoughts/, true],
      ["enable_nestloop = off", ["enable_nestloop"], /Tid Range Scan on thoughts/, true],
      ["enable_hashagg = off, enable_sort = off", ["enable_hashagg", "enable_sort"], /Tid Range Scan on thoughts/, false],
    ];
    /**
     * EXPLAIN (ANALYZE) of the sample statement in one transaction: the paths
     * disabled, then the function's own settings (jit = off among them since
     * 040), then `jit` forced where asked — the order a session GUC, a
     * function-level SET and a later SET LOCAL take in the call too.
     */
    const explained = async (gucs: string[], jit?: "on" | "off"): Promise<string> =>
      sql.begin(async (tx: SQL) => {
        for (const g of gucs) await tx.unsafe(`SET LOCAL ${g} = off`);
        await applyFunctionSettings(tx);
        if (jit) await tx.unsafe(`SET LOCAL jit = ${jit}`);
        const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, COSTS, SUMMARY) ${sampleText}`);
        return rows.map((r: Record<string, string>) => Object.values(r)[0]).join("\n");
      });
    const topCost = (plan: string) => Number(/cost=[\d.]+\.\.([\d.]+)/.exec(plan.split("\n")[0])?.[1] ?? 0);
    /** Median wall time of nine calls after three warm ones, on one connection with the paths disabled at session level. */
    const median = async (gucs: string[]): Promise<number> => {
      const one = new SQL({ url: URL_, max: 1 });
      try {
        for (const g of gucs) await one.unsafe(`SET ${g} = off`);
        const ts: number[] = [];
        for (const [i, q] of queries.entries()) {
          const t0 = performance.now();
          await one.unsafe(`SELECT id FROM match_thoughts('${q}'::vector, -1.0, 10, '${BROAD}'::jsonb)`);
          if (i >= 3) ts.push(performance.now() - t0);
        }
        return ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)];
      } finally {
        await one.close();
      }
    };
    const plain = await explained([]);
    assert(!/JIT:/.test(plain) && topCost(plain) < 1e6 && /Tid Range Scan on thoughts/.test(plain), `with every path enabled the sample's plan is the TID Range Scan at a cost far under disable_cost (${topCost(plain)}) with no JIT block`);
    // EXPLAIN's JIT total for each forced-on plan: the compile's size on THIS
    // machine, which the timing teeth below scale their bounds from (run-it,
    // pass 6 — a literal 20 ms was a machine constant written down).
    const jitTotals: number[] = [];
    for (const [label, gucs, node18, pinned] of CASES) {
      const under = await explained(gucs);
      if (pinned) {
        // 041's pin beats the session's setting for the call: the plan is the
        // default's — TID Range Scan, ordinary cost, no Disabled node, no JIT
        // block — and its buffers are the sample's, not the heap's. Then the
        // mutant, the pin RESET (what 040's file re-applied by hand leaves):
        // on 14–17 the disabled path comes back at disable_cost; on 18 the
        // node is Disabled and, for tidscan, the probe is the Seq Scan of the
        // whole heap per block that SMD-1703 filed.
        const cost = topCost(under);
        assert(cost < 1e6 && /Tid Range Scan on thoughts/.test(under) && !/Disabled: true/.test(under) && !/JIT:/.test(under) && buffersOf(under) < Number(pages),
          `${label}: pinned on the function, the sample's plan is the default's — the probe is a ${/(Seq Scan|Tid Range Scan) on thoughts/.exec(under)?.[1] ?? "no scan of thoughts"} at cost ${cost.toExponential(2)}${/Disabled: true/.test(under) ? " with a Disabled node" : ", no Disabled node"}${/JIT:/.test(under) ? ", a JIT block" : ", no JIT block"}, ${buffersOf(under)} buffers on a ${pages}-page heap (expected: TID Range Scan, an ordinary cost, neither, fewer buffers than pages)`);
        await sql.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET ${gucs[0]}`);
        const mutant = await explained(gucs);
        const mutantCost = topCost(mutant);
        if (disableCost) {
          assert(mutantCost >= 1e10 && /Tid Range Scan on thoughts/.test(mutant) && !/JIT:/.test(mutant),
            `…and with the pin RESET the same statement is priced at disable_cost again (${mutantCost.toExponential(2)}), the plan unchanged and still not compiled (040's clause) — the pin is what keeps the cost ordinary`);
        } else {
          const seen = /(Seq Scan|Tid Range Scan) on thoughts/.exec(mutant)?.[1] ?? "no scan of thoughts";
          assert(/Disabled: true/.test(mutant) && node18.test(mutant) && (gucs[0] !== "enable_tidscan" || buffersOf(mutant) >= Number(pages)),
            `…and with the pin RESET PostgreSQL 18 counts the disabled node again (Disabled: true) and the probe is a ${seen}${gucs[0] === "enable_tidscan" ? ` reading ${buffersOf(mutant)} buffers on a ${pages}-page heap — the whole heap per block, the state SMD-1703 filed` : ""}`);
        }
        await applyMigrations(URL_, { ...opts041, routeEstimateMinPages: 0 });
        assert(new RegExp(`(^|,)${gucs[0]}=on(,|$)`).test(await proconfig()), `…and 041 re-applied puts the ${gucs[0]} pin back`);
        continue;
      }
      // One tooth, not two: "no JIT block" means something only at a cost past
      // jit_above_cost — without the function's settings the tidscan case is a
      // cheap sequential scan (enable_seqscan back on) that no JIT would touch,
      // and a bare `!/JIT:/` passed with the clause absent (review pass 1, run-it).
      const cost = topCost(under);
      if (!disableCost) {
        // On 18 these three lines say nothing about 040's clause — nothing
        // compiles here with it or without it (run-it, pass 3); the clause's
        // teeth on 18 are the proconfig assertions above and below, test-schema
        // [20]/[21] and test-upgrade [18]. They record what 18 does with each
        // path, and name the failing term (review pass 3).
        const forced = jitAvailable ? await explained(gucs, "on") : under;
        const failed = [
          ...(cost < 1e6 ? [] : [`cost ${cost.toExponential(2)}`]),
          ...(/JIT:/.test(under) ? ["a JIT block under the function's settings"] : []),
          ...(jitAvailable && /JIT:/.test(forced) ? ["a JIT block with jit forced on"] : []),
          ...(/Disabled: true/.test(under) ? [] : ["no Disabled: true"]),
          ...(node18.test(under) ? [] : [`no ${node18.source.replace(" on thoughts", "")}`]),
        ];
        const seen = /(Seq Scan|Tid Range Scan) on thoughts/.exec(under)?.[1] ?? "no scan of thoughts";
        assert(failed.length === 0,
          `${label}: on PostgreSQL 18 a disabled path is a disabled-node count (Disabled: true), not disable_cost — the probe is a ${seen} at cost ${cost.toExponential(2)}${failed.length ? `; expected a ${node18.source.replace(" on thoughts", "")}, not JIT-compiled with the clause or without it — but: ${failed.join(", ")}` : " and is not JIT-compiled with the clause or without it; the trigger this section exists for is 14–17's"}`);
        continue;
      }
      // The JIT term can bite only where this server would compile at all:
      // with no JIT, or its own jit off, it is true whatever the clause says,
      // and the proconfig assertions are the clause's teeth (run-it, pass 4).
      assert(cost >= 1e10 && /Tid Range Scan on thoughts/.test(under) && !/JIT:/.test(under),
        `${label}: the planner still takes the TID Range Scan, prices the plan at disable_cost (${cost.toExponential(2)}), and under the function's settings ${/JIT:/.test(under) ? "JIT-compiles it — a JIT block is in the plan" : jitAvailable ? "does not JIT-compile it" : "does not JIT-compile it (this server would not compile it whatever the clause said: no JIT, or its own jit off)"}`);
      if (jitAvailable) {
        const forced = await explained(gucs, "on");
        jitTotals.push(Number(/JIT:[\s\S]*?Timing:[^\n]*?Total ([\d.]+) ms/.exec(forced)?.[1] ?? NaN));
        assert(/JIT:/.test(forced) && /Functions: \d+/.test(forced), `…while the same statement with jit forced on IS compiled (${/JIT:[\s\S]*?Timing: ([^\n]*)/.exec(forced)?.[1] ?? "no timing line"}) — the trigger is real here, so the check above has teeth`);
      }
    }
    if (jitAvailable && disableCost) {
      // The one path 041 leaves unpinned: since 041 the compile story is its
      // alone, and the two pinned paths have no disable_cost to compile on.
      const [label, gucs] = CASES.find((c) => !c[3])!;
      // The default and the fixed arm back to back, so a load spike on the
      // shared machine lands on both or neither (run-it, pass 6).
      const baseline = await median([]);
      const fixed = await median(gucs);
      await sql.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET jit`);
      assert(!/jit=off/.test(await proconfig()), "the mutant: 040's clause RESET on the function — what a redefinition without it leaves, and what the ledger cannot see");
      const mutant = await median(gucs);
      await applyMigrations(URL_, { ...opts041, routeEstimateMinPages: 0 });
      assert(/(^|,)jit=off(,|$)/.test(await proconfig()), "…and 041 re-applied puts the clause back");
      // Each arm is judged against the default, never against the other:
      // with the clause deleted from 040 both arms compile and differed by
      // 12.9 ms in one run and 0.4 in another — the compiled call's own noise
      // (two compiled medians in one run were 31 ms apart) — so a
      // `mutant - fixed >= 10` passed with the mechanism removed (run-it,
      // pass 5). The gap that separates "compiled" from "not" is half the
      // smallest compile this run saw (EXPLAIN's JIT total, 36–70 ms on the
      // machines this ran on, so 18–35), never under 10: the fixed arm has
      // read 0.04–4 ms over the default across every run, the compiled arm
      // 35–95 over it, and a bound that scales with the machine's compile
      // keeps both margins on a faster or slower host (run-it, pass 6).
      const compile = Math.min(...jitTotals.filter(Number.isFinite));
      // The bound is scaled from a measurement this run made; with no JIT
      // total pushed (the pinned cases skip the forced-on arm, and the
      // unpinned one pushes only where the server compiles) Math.min() is
      // Infinity and the two lines below would say nothing — the jitAvailable
      // guard above keeps that out, and this says so if the guard ever moves
      // (review pass 2, run-it).
      assert(Number.isFinite(compile), `the forced-on plan of the unpinned path gave EXPLAIN a JIT total to scale the bound from (${jitTotals.length} measured)`);
      const gap = Math.max(10, compile / 2);
      assert(mutant >= baseline + gap, `the trigger through the function under ${label}: the mutant (040's clause RESET) pays the compile on every call, ${mutant.toFixed(2)} ms against a default of ${baseline.toFixed(2)} (EXPLAIN's smallest JIT total this run ${compile.toFixed(1)} ms, the bound half of it) — the clause's own tooth is the next line`);
      assert(fixed <= baseline + gap, `…and with the clause the disabled path costs what the default costs: ${fixed.toFixed(2)} ms against ${baseline.toFixed(2)}, within ${gap.toFixed(1)} (the compiled call is 45–105 ms)`);
    } else if (!disableCost) {
      skip("[5e] the mutant arm through the function", "PostgreSQL 18: a disabled path is counted, not costed, so there is no compile to time");
    } else {
      skip("[5e] the forced-on plan and the mutant arm", "this server has no JIT, or its own jit is off");
    }
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // The shipped state back on every path, as [5d] does: rows out, trigger
    // on, the heap compacted, the index present, 041 with its floor and pins.
    try {
      await sql`DELETE FROM thoughts`;
      await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER USER`);
      await sql.unsafe(`VACUUM thoughts`);
      if (!(await sql.unsafe(`SELECT to_regclass('thoughts_embedding_idx') IS NOT NULL AS ok`))[0].ok) await sql.unsafe(String(hnswDef));
      await applyMigrations(URL_, opts041);
      assert(new RegExp(`IF v_pages >= ${ROUTE_ESTIMATE_MIN_PAGES} THEN`).test(await body()) && /(^|,)jit=off(,|$)/.test(await proconfig()) && /(^|,)enable_nestloop=on(,|$)/.test(await proconfig()) && /(^|,)enable_tidscan=on(,|$)/.test(await proconfig()), `041 restored with the shipped floor of ${ROUTE_ESTIMATE_MIN_PAGES} pages, jit = off and both pins`);
    } catch (cleanup) {
      if (failure === undefined) throw cleanup;
      console.error(`      [5e] cleanup failed after the section did: ${(cleanup as Error).message}`);
    }
  }
}

console.log("\n[5f] Every join in the body keeps its nested loop under an operator's enable_nestloop = off: match_thoughts pins the path on the function, and the mutant shows what the setting did (migration 041, SMD-1677)");
{
  // Under `enable_nestloop = off` — the spelling an operator uses at database
  // level to tame a misestimated nested loop elsewhere — the planner had
  // replaced every join in the body: the parent lookup that closes each
  // branch (a Nested Loop over at most 2 x v_fetch or v_exact rows, one
  // primary-key probe each) with a Merge Join whose inner side is an Index
  // Scan over the WHOLE primary key, and the walk's chunk side (an
  // HNSW-ordered scan with a primary-key probe per candidate) with a Sort over
  // a Hash Join of every chunk row against every filtered parent — 1.3–2.2 s a
  // call at a million rows, the unfiltered call included, and on the walk a
  // different answer (an exact top-v_fetch over all chunks, not the HNSW's).
  // 041 pins `enable_nestloop = on` on the function (and `enable_tidscan =
  // on`, [5e]): every join here is a primary-key probe driven by an outer the
  // statement bounds itself, so the disaster the setting exists to tame
  // cannot occur inside the call. Held here on a small heap by the BUFFER
  // count, which does not depend on the machine: the three RETURN QUERY
  // statements read out of the body, EXPLAIN (ANALYZE, BUFFERS)ed under the
  // function's own settings with the session's nestloop off, keep their
  // Nested Loops and touch about what they touch by default; the mutant — the
  // pin RESET, what 040's file re-applied by hand leaves — has a Merge or
  // Hash Join and touches the heap several times over; and through the
  // function the pinned call returns the default's rows. Timing at scale is
  // the bench's and FORK.md change 94's.
  const N = 12_000;
  await sql`DELETE FROM thoughts`;
  const defs = (await sql.unsafe(`SELECT indexname AS n, indexdef AS d FROM pg_indexes WHERE indexname IN ('thoughts_embedding_idx', 'thought_chunks_embedding_idx') ORDER BY 1`)) as { n: string; d: string }[];
  assert(defs.length === 2, "both HNSW indexes exist to drop for the load and rebuild after it");
  for (const { n } of defs) await sql.unsafe(`DROP INDEX ${n}`);
  await sql.unsafe(`ALTER TABLE thoughts DISABLE TRIGGER USER`);
  const opts041 = { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f: string) => f.startsWith("041") };
  const proconfig = async () => String((await sql`SELECT array_to_string(proconfig, ',') AS c FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure`)[0].c ?? "");
  let failure: unknown;
  try {
    // Every row broad (the walk's filter, matching all of them — past v_exact,
    // so the filtered call walks); the first 500 also thin (the exact
    // branch's, under v_exact); every second row with one chunk carrying its
    // parent's vector (loadChunkRows), so the walk's chunk side has rows to
    // join. Rows 'row N' as loadChunkRows expects.
    await sql.unsafe(`
      INSERT INTO thoughts (content, metadata, embedding)
      SELECT 'row ' || r.i, CASE WHEN r.i <= 500 THEN '{"broad": true, "thin": true}' ELSE '{"broad": true}' END::jsonb,
             (SELECT ('[' || string_agg((random() - 0.5)::text, ',') || ']')::vector FROM generate_series(1, ${EMBEDDING_DIM} + 0 * r.i))
      FROM generate_series(1, ${N}) AS r(i)`);
    await loadChunkRows(sql, 2);
    await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER USER`);
    // Both indexes back over the loaded rows, in memory (the graph over
    // 18,000 vectors at the shipped width wants a few hundred MB; the
    // server's 64 MB maintenance_work_mem default would build it on disk).
    await sql.begin(async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL maintenance_work_mem = '512MB'`);
      for (const { d } of defs) await tx.unsafe(d);
    });
    await sql.unsafe(`VACUUM ANALYZE thoughts`);
    await sql.unsafe(`VACUUM ANALYZE thought_chunks`);
    assert(/(^|,)enable_nestloop=on(,|$)/.test(await proconfig()), `041's nestloop pin is on the function (proconfig ${await proconfig()})`);
    // The heap's size in pages: what a full scan of the primary key touches
    // over and above the probes, whatever the width — the vectors are TOASTed
    // at the shipped width, so the default arm's buffers are mostly TOAST
    // reads and a ratio would be the fixture's, not the mechanism's.
    const [{ pages }] = await sql.unsafe(`SELECT (pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int)::int AS pages`);
    const { unitVector } = seededRandom(1677);
    const q = `[${unitVector(EMBEDDING_DIM).join(",")}]`;
    const FILTERS = [["unfiltered", "{}"], ["walk", '{"broad": true}'], ["exact", '{"thin": true}']] as const;
    /**
     * EXPLAIN (ANALYZE, BUFFERS) of one branch's statement in one transaction:
     * the session's setting first, then the function's own (the pin among
     * them while it is on the function) — the order a session GUC and a
     * function-level SET take in the call too.
     */
    const explainUnder = async (body: string, filter: string, nestloopOff: boolean) =>
      sql.begin(async (tx: SQL) => {
        if (nestloopOff) await tx.unsafe(`SET LOCAL enable_nestloop = off`);
        await applyFunctionSettings(tx);
        return explainPrepared(tx, { body, dim: EMBEDDING_DIM, args: `'${q}'::vector, -1.0, 10, '${filter}'::jsonb, 0.0, 90.0`, mode: "force_custom_plan", warm: true });
      });
    const joinsOf = (plan: string) => [...plan.matchAll(/(Nested Loop|Merge Join|Hash Join)/g)].map((m) => m[1]);
    const bodies = new Map<string, string>();
    for (const [branch, filter] of FILTERS) {
      const body = await extractBody(sql, branch, EMBEDDING_DIM);
      bodies.set(branch, body);
      const byDefault = await explainUnder(body, filter, false);
      // The default arm's own plan first, so a failure below names its cause:
      // were the planner ever to prefer a hash join by cost on this fixture,
      // the pinned arm would fail for a reason that is not the pin's (review
      // pass 1, cut for space).
      const defaultJoins = joinsOf(byDefault.text);
      assert(defaultJoins.length > 0 && defaultJoins.every((j) => j === "Nested Loop"), `${branch}: by default every join is a Nested Loop (${defaultJoins.join(", ")}) — the plan the pin keeps`);
      const pinnedOff = await explainUnder(body, filter, true);
      const joins = joinsOf(pinnedOff.text);
      assert(joins.length > 0 && joins.every((j) => j === "Nested Loop") && pinnedOff.buffers <= byDefault.buffers * 1.1 + 64,
        `${branch}: with the session's enable_nestloop off and 041's pin in force, every join is a Nested Loop (${joins.join(", ")}) and the statement touches ${pinnedOff.buffers} buffers against ${byDefault.buffers} by default — the same plan`);
    }
    // The mutant: the pin RESET, what 040's file re-applied by hand leaves.
    await sql.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET enable_nestloop`);
    assert(!/enable_nestloop/.test(await proconfig()), "the mutant: 041's nestloop pin RESET on the function — what a redefinition without it leaves, and what the ledger cannot see");
    for (const [branch, filter] of FILTERS) {
      const byDefault = await explainUnder(bodies.get(branch)!, filter, false);
      const off = await explainUnder(bodies.get(branch)!, filter, true);
      const joins = joinsOf(off.text);
      assert(joins.some((j) => j !== "Nested Loop") && off.buffers >= byDefault.buffers + Number(pages),
        `${branch}: without the pin the session's setting reaches the statement — ${joins.join(", ")} — and it touches ${off.buffers} buffers against ${byDefault.buffers} with its nested loops, at least the heap's ${pages} pages more: the whole primary key${branch === "walk" ? " and every chunk row" : ""}`);
    }
    await applyMigrations(URL_, opts041);
    assert(/(^|,)enable_nestloop=on(,|$)/.test(await proconfig()), "…and 041 re-applied puts the pin back");
    // Through the function, on a fresh connection per cell as an operator's
    // session would be: the rows under the setting are the default's. A
    // no-harm check, not a tooth — on a fixture this size the walk may return
    // the same rows without the pin too; the join and buffer pair above is
    // what bites (review pass 1, cut for space).
    const rowsUnder = async (filter: string, session: string[]) => {
      const one = new SQL({ url: URL_, max: 1 });
      try {
        for (const st of session) await one.unsafe(st);
        return (await one.unsafe(`SELECT id FROM match_thoughts('${q}'::vector, -1.0, 10, '${filter}'::jsonb)`)).map((r: { id: string }) => r.id).join(",");
      } finally {
        await one.close();
      }
    };
    for (const [branch, filter] of FILTERS) {
      const byDefault = await rowsUnder(filter, []);
      const pinnedOff = await rowsUnder(filter, ["SET enable_nestloop = off"]);
      assert(byDefault.split(",").length === 10 && pinnedOff === byDefault, `${branch}: through the function under a session enable_nestloop = off the call returns the default's ten rows, in order`);
    }
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // The shipped state back on every path: rows out, trigger on, the heap
    // compacted, both indexes present, 041 with its floor and pins.
    try {
      await sql`DELETE FROM thoughts`;
      await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER USER`);
      await sql.unsafe(`VACUUM thoughts`);
      await sql.unsafe(`VACUUM thought_chunks`);
      for (const { n, d } of defs) {
        if (!(await sql.unsafe(`SELECT to_regclass('${n}') IS NOT NULL AS ok`))[0].ok) await sql.unsafe(d);
      }
      await applyMigrations(URL_, opts041);
      assert(/(^|,)enable_nestloop=on(,|$)/.test(await proconfig()) && /(^|,)enable_tidscan=on(,|$)/.test(await proconfig()) && /(^|,)jit=off(,|$)/.test(await proconfig()), "041 restored with jit = off and both pins");
    } catch (cleanup) {
      if (failure === undefined) throw cleanup;
      console.error(`      [5f] cleanup failed after the section did: ${(cleanup as Error).message}`);
    }
  }
}

console.log("\n[6] The unique partial index is enforced by the server");
{
  await sql`DELETE FROM thoughts`;
  await sql`INSERT INTO thoughts (content, content_fingerprint) VALUES ('a', 'dup')`;
  let rejected = false;
  try {
    await sql`INSERT INTO thoughts (content, content_fingerprint) VALUES ('b', 'dup')`;
  } catch {
    rejected = true;
  }
  assert(rejected, "a duplicate fingerprint is rejected");

  // NULL fingerprints must not collide — that is why the index is partial.
  await sql`INSERT INTO thoughts (content, content_fingerprint) VALUES ('c', NULL)`;
  await sql`INSERT INTO thoughts (content, content_fingerprint) VALUES ('d', NULL)`;
  assert(true, "multiple NULL fingerprints coexist");
}

// ── 6b. Migration 018 — two legacy twins fingerprinted at the same moment ────
//
// db/test-schema.ts [19] holds the sequential half: the second twin is accepted
// and told, not refused. This is the concurrent half, which PGlite's single
// session cannot run. Connection A re-embeds the first twin and holds its
// transaction open; connection B re-embeds the second. Without 018's advisory
// lock B would pass the duplicate check (A's fingerprint is uncommitted), then
// block on the unique index and raise 23505 when A commits. With it B waits on
// the ADVISORY lock — pg_locks says which — and, once A commits, sees A's row
// and returns ok with duplicate_of. A statement_timeout bounds the wait, so a
// lock that never released fails the test rather than hanging it.

console.log("\n[6b] Two legacy twins fingerprinted at once: the second waits, then is told, not refused (migration 018)");
{
  await sql`DELETE FROM thoughts`;
  const [a] = await sql`INSERT INTO thoughts (content, content_fingerprint, embedding) VALUES ('Legacy Twin', NULL, ${unit(0)}::vector) RETURNING id`;
  const [b] = await sql`INSERT INTO thoughts (content, content_fingerprint, embedding) VALUES ('legacy   twin', NULL, ${unit(0)}::vector) RETURNING id`;
  type R = { ok: boolean; error?: string; duplicate_of?: string };
  // One connection each, as [8] does: a transaction held open on a shared pool
  // queues the pool's other work behind it.
  const connA = new SQL({ url: URL_, max: 1 });
  const connB = new SQL({ url: URL_, max: 1 });

  let releaseA: () => void = () => {};
  const held = new Promise<void>((resolve) => { releaseA = resolve; });
  let aResult: R | undefined;
  let aError = "";
  const aDone = connA.begin(async (tx: SQL) => {
    aResult = ((await tx`SELECT update_thought(${a.id}::uuid, 'Legacy Twin', NULL, ${unit(1)}::vector) AS r`) as { r: R }[])[0].r;
    await held;
  }).catch((e: Error) => { aError = e.message; releaseA(); });
  // A has taken the lock before B starts: wait for its result, not a sleep.
  for (let i = 0; i < 250 && aResult === undefined && aError === ""; i++) await Bun.sleep(20);
  assert(aResult?.ok === true && aResult.duplicate_of === undefined, `A re-embeds the first twin inside an open transaction (${aError || JSON.stringify(aResult)})`);

  let bError = "";
  let bPid = -1;
  const bDone = connB.begin(async (tx: SQL) => {
    await tx`SET LOCAL statement_timeout = '5s'`;
    bPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    return ((await tx`SELECT update_thought(${b.id}::uuid, 'legacy   twin', NULL, ${unit(2)}::vector) AS r`) as { r: R }[])[0].r;
  }).catch((e: Error) => { bError = e.message; return undefined; });

  // B's own backend, not "any advisory waiter on the server": the suite
  // accepts any DATABASE_URL, and a shared server may have others.
  let waitingOnAdvisory = 0;
  for (let i = 0; i < 250 && waitingOnAdvisory === 0; i++) {
    await Bun.sleep(20);
    if (bPid < 0) continue;
    waitingOnAdvisory = Number((await sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = ${bPid}`)[0].n);
  }
  assert(waitingOnAdvisory === 1, `B's backend waits on the advisory lock, not on the unique index (${waitingOnAdvisory} advisory waiter for pid ${bPid})`);

  releaseA();
  await aDone;
  const bResult = await bDone;
  assert(bResult !== undefined, `B's call returned rather than raising (${bError.slice(0, 80)})`);
  assert(bResult?.ok === true && bResult.duplicate_of === a.id, `…accepted once A committed, and told which row it duplicates (${JSON.stringify(bResult)})`);
  const fps = (await sql`SELECT id, content_fingerprint AS fp, array_position(embedding::real[], 1::real) - 1 AS axis FROM thoughts WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`) as { id: string; fp: string | null; axis: number }[];
  const fa = fps.find((r) => r.id === a.id)!, fb = fps.find((r) => r.id === b.id)!;
  assert(fa.fp !== null && fb.fp === null, "the first twin carries the fingerprint, the second stays NULL — the partial index was never violated");
  assert(fa.axis === 1 && fb.axis === 2, `…and both carry their new vectors (${fa.axis}, ${fb.axis})`);
  await connA.close();
  await connB.close();
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6c] The backfill holds the table: a capture and an edit wait for it, then merge and are told (migration 023)");
{
  await sql`DELETE FROM thoughts`;
  const legacy = (content: string, createdAt: string) => plantLegacyRow(sql, content, unit(0), createdAt);
  const singleton = await legacy("A Legacy Singleton", "2024-01-01");
  const twinOld = await legacy("Legacy Twin", "2024-01-01");
  const twinNew = await legacy("legacy   twin", "2024-06-01");
  type R = { ok: boolean; error?: string; duplicate_of?: string };
  // reembed.ts --status is read-only and makes no provider call; the pairs
  // list is the one query the backfill must leave meaning the same thing.
  const statusEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, DATABASE_URL: URL_ })) if (v !== undefined && !/^OB1_(EMBEDDING_DIMENSIONS|CHUNK_CONTEXT|LLM_API_KEY)$/.test(k)) statusEnv[k] = String(v);
  const status = () => runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_!, "--status"], { env: statusEnv, cwd: HERE });
  const before = await status();
  assert(before.code === 0 && /1 group\(s\) of thoughts share one normalised text/.test(before.out), `before the backfill --status lists the twins as one group (exit ${before.code})`);

  // One connection each, as [6b]: A holds the backfill's transaction open; B
  // captures the singleton's text; C re-embeds the newer twin with its own
  // text. Both must wait on the TABLE lock — B at 022's FOR NO KEY UPDATE
  // read before its INSERT, C at update_thought's row lock (018's, FOR NO KEY UPDATE since 032), both ROW SHARE, which
  // conflicts with EXCLUSIVE — and then act on the committed keys: B merges
  // instead of inserting a second row, C is told duplicate_of instead of
  // raising 23505 at its UPDATE.
  const connA = new SQL({ url: URL_, max: 1 });
  const connB = new SQL({ url: URL_, max: 1 });
  const connC = new SQL({ url: URL_, max: 1 });
  let releaseA: () => void = () => {};
  const held = new Promise<void>((resolve) => { releaseA = resolve; });
  let aFound: number | undefined;
  let aError = "";
  const aDone = connA.begin(async (tx: SQL) => {
    aFound = Number((await tx`SELECT backfill_content_fingerprints() AS n`)[0].n);
    await held;
  }).catch((e: Error) => { aError = e.message; releaseA(); });
  for (let i = 0; i < 250 && aFound === undefined && aError === ""; i++) await Bun.sleep(20);
  assert(aFound === 2, `A runs the backfill inside an open transaction: the singleton and the older twin are found and take their keys (${aError || aFound})`);

  let bError = "", cError = "";
  let bPid = -1, cPid = -1;
  const bDone = connB.begin(async (tx: SQL) => {
    await tx`SET LOCAL statement_timeout = '5s'`;
    bPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    return ((await tx`SELECT upsert_thought('a legacy  singleton', ${{ metadata: { k: 1 } }}::jsonb, ${unit(1)}::vector) AS r`) as { r: { id: string } }[])[0].r;
  }).catch((e: Error) => { bError = e.message; return undefined; });
  const cDone = connC.begin(async (tx: SQL) => {
    await tx`SET LOCAL statement_timeout = '5s'`;
    cPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    return ((await tx`SELECT update_thought(${twinNew}::uuid, 'legacy   twin', NULL, ${unit(2)}::vector) AS r`) as { r: R }[])[0].r;
  }).catch((e: Error) => { cError = e.message; return undefined; });

  let waitingOnTable = 0;
  for (let i = 0; i < 250 && waitingOnTable < 2; i++) {
    await Bun.sleep(20);
    if (bPid < 0 || cPid < 0) continue;
    waitingOnTable = Number((await sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'relation' AND relation = 'thoughts'::regclass AND NOT granted AND pid IN (${bPid}, ${cPid})`)[0].n);
  }
  assert(waitingOnTable === 2, `B's INSERT and C's FOR UPDATE both wait on the table lock, not on the unique index (${waitingOnTable} relation waiter(s) for pids ${bPid}, ${cPid})`);

  releaseA();
  await aDone;
  const bResult = await bDone;
  const cResult = await cDone;
  assert(bResult?.id === singleton, `once A commits, B's capture merges into the former singleton instead of inserting a second row (${bError.slice(0, 80) || bResult?.id})`);
  assert(cResult?.ok === true && cResult.duplicate_of === twinOld, `…and C's edit is told duplicate_of the older twin rather than raising 23505 (${cError.slice(0, 80) || JSON.stringify(cResult)})`);
  const state = (await sql`SELECT id, content_fingerprint AS fp, array_position(embedding::real[], 1::real) - 1 AS axis, metadata FROM thoughts`) as { id: string; fp: string | null; axis: number; metadata: Record<string, unknown> }[];
  const s = state.find((r) => r.id === singleton)!, o = state.find((r) => r.id === twinOld)!, n = state.find((r) => r.id === twinNew)!;
  assert(state.length === 3 && s.fp !== null && s.axis === 1 && (s.metadata as { k?: number }).k === 1, `three rows: the singleton carries its key and B's vector and metadata (axis ${s.axis})`);
  assert(o.fp !== null && n.fp === null && n.axis === 2, `the older twin carries the key, the newer stays NULL with C's vector (axis ${n.axis})`);
  const after = await status();
  assert(after.code === 0 && /1 group\(s\) of thoughts share one normalised text/.test(after.out), "after the backfill --status lists the same one group — the pair is NULL/fingerprinted now, and the list means what it meant");
  assert((await updatedAtTriggerState(sql)) === "O", "…and the updated_at trigger is enabled again");
  await connA.close();
  await connB.close();
  await connC.close();
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6d] An edit naming supersedes meets an edit of its target: FOR UPDATE on the target deadlocks with the FK's KEY SHARE, update_thought's FOR NO KEY UPDATE does not (migration 032)");
{
  await sql`DELETE FROM thoughts`;
  // Q is about to supersede Z and take the text T; Z is being edited to T at
  // the same moment. A stands where update_thought stands mid-call with
  // content T and supersedes Z — the supersession lock, Q's row, the
  // fingerprint lock for T held — and then writes the pointer, whose FK check
  // takes FOR KEY SHARE on Z. B holds Z and waits on the fingerprint lock.
  const T = "the text both edits take";
  const zId = ((await sql`SELECT upsert_thought('the target, before', '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id;
  const qId = ((await sql`SELECT upsert_thought('the newer note', '{"metadata":{}}'::jsonb, ${unit(1)}::vector) AS r`)[0].r as { id: string }).id;
  type R = { ok: boolean; error?: string; duplicate_of?: string };
  const fpT = (await sql`SELECT content_fingerprint_of(${T}) AS f`)[0].f as string;

  /**
   * A's stance — `out.holding` set once every lock is held, so B is started
   * only then ([6b]'s rule: wait for the other side's observable state, not a
   * sleep; B reaching the fingerprint lock first would leave nothing to wait
   * on) — then its pointer write once `go` resolves; the transaction is held
   * until `done` resolves.
   */
  const standAsA = (conn: SQL, go: Promise<void>, done: Promise<void>, out: { holding?: boolean; wrote?: boolean; error?: string }) =>
    conn.begin(async (tx: SQL) => {
      await tx`SET LOCAL statement_timeout = '8s'`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('ob1:supersession-review'))`;
      await tx`SELECT 1 FROM thoughts WHERE id = ${qId}::uuid FOR NO KEY UPDATE`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fpT}, 0))`;
      out.holding = true;
      await go;
      await tx`UPDATE thoughts SET supersedes = ${zId}::uuid WHERE id = ${qId}::uuid`;
      out.wrote = true;
      await done;
    }).catch((e: Error) => { out.error = e.message; });
  const waitFor = async (pred: () => boolean | Promise<boolean>, ticks = 400) => { for (let i = 0; i < ticks && !(await pred()); i++) await Bun.sleep(20); };
  const advisoryWaiters = async (pid: number) => Number((await sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}`)[0].n);
  /** A one-shot gate: the promise A awaits, and the call that opens it. */
  const gate = () => { let open: () => void = () => {}; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

  // Arm 1 — the lock 018 took, by hand in B's place: a deadlock, detected and
  // raised (40P01) in one of the two, where the tool promised DUPLICATE_CONTENT
  // or a clean edit.
  {
    const connA = new SQL({ url: URL_, max: 1 });
    const connB = new SQL({ url: URL_, max: 1 });
    const { p: goP, open: go } = gate();
    const { p: doneP, open: done } = gate();
    const a: { holding?: boolean; wrote?: boolean; error?: string } = {};
    const aDone = standAsA(connA, goP, doneP, a);
    await waitFor(() => a.holding === true || a.error !== undefined);
    assert(a.holding === true, `A holds the supersession lock, Q's row and the fingerprint lock for T (${a.error ?? "holding"})`);
    let bPid = -1; let bError = "";
    const bDone = connB.begin(async (tx: SQL) => {
      await tx`SET LOCAL statement_timeout = '8s'`;
      bPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT 1 FROM thoughts WHERE id = ${zId}::uuid FOR UPDATE`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fpT}, 0))`;
    }).catch((e: Error) => { bError = e.message; });
    await waitFor(async () => bPid > 0 && (await advisoryWaiters(bPid)) === 1);
    assert((await advisoryWaiters(bPid)) === 1, "B holds Z FOR UPDATE and waits on the fingerprint lock A holds");
    go();
    await waitFor(() => a.wrote === true || a.error !== undefined || bError !== "");
    done();
    await aDone; await bDone;
    assert(/deadlock detected/.test(a.error ?? "") || /deadlock detected/.test(bError), `with Z held FOR UPDATE, A's pointer write — KEY SHARE on Z — and B's wait close a cycle Postgres has to break (A: ${(a.error ?? "wrote").slice(0, 40)}; B: ${(bError || "ok").slice(0, 40)})`);
    await connA.close(); await connB.close();
    await sql`UPDATE thoughts SET supersedes = NULL WHERE id = ${qId}::uuid`;
  }

  // Arm 2 — B is update_thought itself, whose row lock is FOR NO KEY UPDATE
  // since 032: A's KEY SHARE on Z is granted under it, A commits, B follows
  // and edits Z cleanly. Since 033 B takes the fingerprint lock BEFORE its
  // row read, so while it waits on A it holds nothing on Z at all — A's KEY
  // SHARE is granted either way; the assertion below reads the wait, not
  // the row.
  {
    const connA = new SQL({ url: URL_, max: 1 });
    const connB = new SQL({ url: URL_, max: 1 });
    const { p: goP, open: go } = gate();
    const { p: doneP, open: done } = gate();
    const a: { holding?: boolean; wrote?: boolean; error?: string } = {};
    const aDone = standAsA(connA, goP, doneP, a);
    await waitFor(() => a.holding === true || a.error !== undefined);
    assert(a.holding === true, `A holds its three locks again (${a.error ?? "holding"})`);
    let bPid = -1; let bError = "";
    const bDone = connB.begin(async (tx: SQL) => {
      await tx`SET LOCAL statement_timeout = '8s'`;
      bPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      return ((await tx`SELECT update_thought(${zId}::uuid, ${T}, NULL::jsonb, ${unit(2)}::vector) AS r`) as { r: R }[])[0].r;
    }).catch((e: Error) => { bError = e.message; return undefined; });
    await waitFor(async () => bPid > 0 && (await advisoryWaiters(bPid)) === 1);
    assert((await advisoryWaiters(bPid)) === 1, "update_thought on Z waits on the fingerprint lock A holds (before its row read, since 033)");
    go();
    await waitFor(() => a.wrote === true || a.error !== undefined);
    assert(a.wrote === true && a.error === undefined, `A's pointer write is granted its KEY SHARE on Z while update_thought on Z is in flight (${a.error ?? "wrote"})`);
    done();
    await aDone;
    const bResult = await bDone;
    assert(bResult?.ok === true && bError === "", `…and B's edit of Z completes once A commits (${bError || JSON.stringify(bResult)})`);
    const [after] = await sql`SELECT (SELECT supersedes FROM thoughts WHERE id = ${qId}::uuid) AS s, (SELECT content FROM thoughts WHERE id = ${zId}::uuid) AS c`;
    assert(after.s === zId && after.c === T, "Q supersedes Z and Z carries the new text — both writes landed");
    await connA.close(); await connB.close();
  }
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6e] A capture and an edit of one text: the edit waits on the advisory lock the capture holds, then is told, not refused — and 022's two races find the row (migration 033)");
{
  await sql`DELETE FROM thoughts`;
  type R = { ok: boolean; error?: string; duplicate_of?: string };
  const waitFor = async (pred: () => boolean | Promise<boolean>, ticks = 400) => { for (let i = 0; i < ticks && !(await pred()); i++) await Bun.sleep(20); };
  const advisoryWaiters = async (pid: number) => Number((await sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}`)[0].n);
  const gate = () => { let open: () => void = () => {}; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** A holds one statement's result inside an open transaction until `done` resolves; `out.result` says it ran. */
  const hold = <T,>(conn: SQL, stmt: (tx: SQL) => Promise<T>, done: Promise<void>, out: { result?: T; error?: string }) =>
    conn.begin(async (tx: SQL) => {
      await tx`SET LOCAL statement_timeout = '8s'`;
      out.result = await stmt(tx);
      await done;
    }).catch((e: Error) => { out.error = e.message; });
  /** B runs one statement in its own transaction, reporting its pid first so the wait can be read from pg_locks. */
  const runB = <T,>(conn: SQL, stmt: (tx: SQL) => Promise<T>, out: { pid: number; error?: string }) =>
    conn.begin(async (tx: SQL) => {
      await tx`SET LOCAL statement_timeout = '8s'`;
      out.pid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      return stmt(tx);
    }).catch((e: Error) => { out.error = e.message; return undefined; });

  // Arm 1 — 018's header's own case: A captures X through the 2-argument form
  // and holds its transaction; B edits another row INTO X. Before 033 B's
  // lookup found no row, B waited on A's transaction id at the unique index
  // and raised 23505 when A committed. Now B waits on the ADVISORY lock and,
  // once A commits, its lookup finds A's row: DUPLICATE_CONTENT.
  {
    const X = "the text a capture and an edit both take";
    const otherId = ((await sql`SELECT upsert_thought('an unrelated note to edit', '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id;
    const connA = new SQL({ url: URL_, max: 1 });
    const connB = new SQL({ url: URL_, max: 1 });
    const { p: doneP, open: done } = gate();
    const a: { result?: { id: string }; error?: string } = {};
    const aDone = hold(connA, async (tx) => (await tx`SELECT upsert_thought(${X}, '{"metadata":{}}'::jsonb) AS r`)[0].r as { id: string }, doneP, a);
    await waitFor(() => a.result !== undefined || a.error !== undefined);
    assert(a.result?.id !== undefined && a.error === undefined, `A captures X through the 2-argument form inside an open transaction (${a.error ?? a.result?.id})`);
    const b: { pid: number; error?: string } = { pid: -1 };
    const bDone = runB(connB, async (tx) => (await tx`SELECT update_thought(${otherId}::uuid, ${X}, NULL::jsonb, ${unit(1)}::vector) AS r`)[0].r as R, b);
    await waitFor(async () => b.pid > 0 && (await advisoryWaiters(b.pid)) === 1);
    assert((await advisoryWaiters(b.pid)) === 1, `B's edit into X waits on the ADVISORY lock A's capture holds, not on the unique index (${await advisoryWaiters(b.pid)} advisory waiter for pid ${b.pid})`);
    done();
    await aDone;
    const bResult = await bDone;
    assert(bResult !== undefined && b.error === undefined, `B's call returned rather than raising (${(b.error ?? "").slice(0, 80)})`);
    assert(bResult?.ok === false && bResult.error === "DUPLICATE_CONTENT", `…and is told DUPLICATE_CONTENT once A committed — the case 018's header left to this migration (${JSON.stringify(bResult)})`);
    const [after] = await sql`SELECT (SELECT count(*)::int FROM thoughts WHERE content_fingerprint = content_fingerprint_of(${X})) AS holders, (SELECT content FROM thoughts WHERE id = ${otherId}::uuid) AS c`;
    assert(Number(after.holders) === 1 && after.c === "an unrelated note to edit", "one row holds X — A's — and B's row is unchanged");
    await connA.close(); await connB.close();
  }

  // Arm 2 — the race 022's header conceded: A's FIRST capture of Y carries
  // windows (the 4-argument form, delegating to the 3-argument body) and is
  // held open; B re-captures Y through the 3-argument form with no windows.
  // Before 033 B's label read found no row (A uncommitted), v_existed was
  // false, and B's INSERT landed on A's row leaving A's windows under B's
  // vector whatever the labels said. Now B waits on the advisory lock, reads
  // A's committed row, and 022's rule decides: same label keeps the windows.
  const armTwo = async (Y: string, labelA: string, labelB: string) => {
    const connA = new SQL({ url: URL_, max: 1 });
    const connB = new SQL({ url: URL_, max: 1 });
    const { p: doneP, open: done } = gate();
    const a: { result?: { id: string }; error?: string } = {};
    const aDone = hold(connA, async (tx) => (await tx`SELECT upsert_thought(${Y}, ${{ metadata: {}, embedding_model: labelA }}::jsonb, ${unit(2)}::vector, ${[{ content: "window", embedding: unit(3) }]}::jsonb) AS r`)[0].r as { id: string }, doneP, a);
    await waitFor(() => a.result !== undefined || a.error !== undefined);
    assert(a.result?.id !== undefined, `A's first capture of the text, with a window, is held open (${a.error ?? "held"})`);
    const b: { pid: number; error?: string } = { pid: -1 };
    const bDone = runB(connB, async (tx) => (await tx`SELECT upsert_thought(${Y}, ${{ metadata: {}, embedding_model: labelB }}::jsonb, ${unit(4)}::vector) AS r`)[0].r as { id: string }, b);
    await waitFor(async () => b.pid > 0 && (await advisoryWaiters(b.pid)) === 1);
    assert((await advisoryWaiters(b.pid)) === 1, "B's chunkless re-capture waits on the advisory lock rather than inserting beside it");
    done();
    await aDone;
    const bResult = await bDone;
    assert(bResult?.id === a.result?.id && b.error === undefined, `…and lands on A's row once A commits (${b.error ?? bResult?.id})`);
    const [row] = await sql`SELECT (SELECT count(*)::int FROM thought_chunks WHERE thought_id = ${a.result!.id}::uuid) AS windows, embedding_model AS m, array_position(embedding::real[], 1::real) - 1 AS axis FROM thoughts WHERE id = ${a.result!.id}::uuid`;
    await connA.close(); await connB.close();
    return { windows: Number(row.windows), label: row.m as string, axis: Number(row.axis) };
  };
  const same = await armTwo("a first capture with a window, re-captured at the same model", "model-a", "model-a");
  assert(same.windows === 1 && same.label === "model-a" && same.axis === 4, `at the same model B's re-capture moves the vector and keeps A's window — the label vouches for it (${same.windows} window, axis ${same.axis})`);
  const other = await armTwo("a first capture with a window, re-captured at another model", "model-a", "model-b");
  assert(other.windows === 0 && other.label === "model-b" && other.axis === 4, `at another model it removes the window as it moves the vector and label — where before 033 the read found no row and left it (${other.windows} windows, ${other.label})`);

  // Arm 3 — the supersession lock is not the capture path's (035; 033 took it
  // first when the envelope named a pointer, to order the ON CONFLICT fill
  // against update_thought's walk, and the fill is gone): A stands where
  // update_thought or the review path stands, holding 029's lock; B's
  // capture naming supersedes is not held by it — it completes, its pointer
  // written on its fresh row, while A still holds the lock. Under 033 B
  // waited here (an 8 s statement_timeout would turn that into b.error).
  {
    const rId = ((await sql`SELECT upsert_thought('the note a capture will supersede', '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id;
    const connA = new SQL({ url: URL_, max: 1 });
    const connB = new SQL({ url: URL_, max: 1 });
    const { p: doneP, open: done } = gate();
    const a: { result?: unknown; error?: string } = {};
    const aDone = hold(connA, async (tx) => tx`SELECT pg_advisory_xact_lock(hashtext('ob1:supersession-review'))`, doneP, a);
    await waitFor(() => a.result !== undefined || a.error !== undefined);
    const b: { pid: number; error?: string } = { pid: -1 };
    const bResult = await runB(connB, async (tx) => (await tx`SELECT upsert_thought('the note that supersedes it', ${{ metadata: {}, supersedes: rId }}::jsonb, ${unit(5)}::vector) AS r`)[0].r as { id: string; existed?: boolean }, b);
    assert(bResult?.id !== undefined && b.error === undefined && a.result !== undefined && a.error === undefined,
           `a capture naming supersedes is not held by the supersession lock an edit or a review holds — it completes while A still holds the lock (035; at 033 it waited) (${b.error ?? "ok"})`);
    assert(bResult?.existed === false && (await sql`SELECT supersedes AS s FROM thoughts WHERE id = ${bResult!.id}::uuid`)[0].s === rId, "…with its pointer written on its fresh row, existed: false");
    const [{ c: waiting }] = await sql`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    assert(Number(waiting) === 0, `…and nothing waits on any advisory lock (${waiting})`);
    const plain: { pid: number; error?: string } = { pid: -1 };
    const connC = new SQL({ url: URL_, max: 1 });
    const cResult = await runB(connC, async (tx) => (await tx`SELECT upsert_thought('a capture naming no pointer meanwhile', '{"metadata":{}}'::jsonb, ${unit(6)}::vector) AS r`)[0].r as { id: string }, plain);
    assert(cResult?.id !== undefined && plain.error === undefined, "…while a capture naming no pointer is not held by it either, as before");
    done();
    await aDone;
    await connA.close(); await connB.close(); await connC.close();
  }
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6f] Four writers on two texts: the row-then-fingerprint order 018 wrote deadlocks, the one order every writer takes since 033 does not (migration 033)");
{
  await sql`DELETE FROM thoughts`;
  // R owns Y and R' owns X. Two edits swap the rows' texts — edit(R → X),
  // edit(R' → Y) — while both texts are re-captured. Found by the first
  // review pass of this change: with the edit at row → fingerprint lock and
  // the capture at fingerprint lock → row, each edit holds its row and waits
  // on the lock a capture holds, and each capture holds its lock and waits
  // on the row the other edit holds. A cycle of four, which Postgres breaks
  // with 40P01 in one of them.
  type R = { ok: boolean; error?: string; duplicate_of?: string };
  const X = "text x, swapped and re-captured", Y = "text y, swapped and re-captured";
  const rPrime = ((await sql`SELECT upsert_thought(${X}, '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id;
  const r = ((await sql`SELECT upsert_thought(${Y}, '{"metadata":{}}'::jsonb, ${unit(1)}::vector) AS r`)[0].r as { id: string }).id;
  const fpX = (await sql`SELECT content_fingerprint_of(${X}) AS f`)[0].f as string;
  const fpY = (await sql`SELECT content_fingerprint_of(${Y}) AS f`)[0].f as string;
  const gate = () => { let open: () => void = () => {}; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const waitFor = async (pred: () => boolean | Promise<boolean>, ticks = 400) => { for (let i = 0; i < ticks && !(await pred()); i++) await Bun.sleep(20); };
  const waiters = async (pid: number) => Number((await sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid = ${pid}`)[0].n);
  type Out = { pid: number; first?: boolean; done?: boolean; error?: string; result?: unknown };
  /** One transaction: `first` at once, `rest` once `go` resolves, held until `hold` resolves. */
  const run = (conn: SQL, out: Out, first: (t: SQL) => Promise<unknown>, go: Promise<void>, rest: (t: SQL) => Promise<unknown>, hold: Promise<void>) =>
    conn.begin(async (t: SQL) => {
      await t`SET LOCAL statement_timeout = '15s'`;
      out.pid = Number((await t`SELECT pg_backend_pid() AS pid`)[0].pid);
      await first(t); out.first = true;
      await go;
      out.result = await rest(t); out.done = true;
      await hold;
    }).catch((e: Error) => { out.error = e.message; });

  // Arm 1 — 018's order, by hand: each edit locks its row first, then the
  // fingerprint lock for its new text; each capture is the shipped function
  // after a hand-taken fingerprint lock (which it re-enters).
  {
    const conns = [0, 1, 2, 3].map(() => new SQL({ url: URL_, max: 1 }));
    const [e1, e2, c1, c2]: Out[] = [{ pid: -1 }, { pid: -1 }, { pid: -1 }, { pid: -1 }];
    const hold = gate(); const gE1 = gate(), gE2 = gate(), gC1 = gate(), gC2 = gate();
    const pE1 = run(conns[0], e1, (t) => t`SELECT 1 FROM thoughts WHERE id = ${r}::uuid FOR NO KEY UPDATE`, gE1.p, (t) => t`SELECT pg_advisory_xact_lock(hashtextextended(${fpX}, 0))`, hold.p);
    const pE2 = run(conns[1], e2, (t) => t`SELECT 1 FROM thoughts WHERE id = ${rPrime}::uuid FOR NO KEY UPDATE`, gE2.p, (t) => t`SELECT pg_advisory_xact_lock(hashtextextended(${fpY}, 0))`, hold.p);
    await waitFor(() => e1.first === true && e2.first === true);
    const pC1 = run(conns[2], c1, (t) => t`SELECT pg_advisory_xact_lock(hashtextextended(${fpX}, 0))`, gC1.p, (t) => t`SELECT upsert_thought(${X}, '{"metadata":{},"embedding_model":"m"}'::jsonb, ${unit(2)}::vector) AS r`, hold.p);
    const pC2 = run(conns[3], c2, (t) => t`SELECT pg_advisory_xact_lock(hashtextextended(${fpY}, 0))`, gC2.p, (t) => t`SELECT upsert_thought(${Y}, '{"metadata":{},"embedding_model":"m"}'::jsonb, ${unit(3)}::vector) AS r`, hold.p);
    await waitFor(() => c1.first === true && c2.first === true);
    assert(e1.first && e2.first && c1.first && c2.first, "two edits hold their rows, two captures hold the fingerprint locks for the rows' texts");
    gC1.open(); gC2.open();
    await waitFor(async () => c1.pid > 0 && c2.pid > 0 && (await waiters(c1.pid)) === 1 && (await waiters(c2.pid)) === 1);
    assert((await waiters(c1.pid)) === 1 && (await waiters(c2.pid)) === 1, "…each capture's label read waits on the row the other edit holds");
    gE2.open();
    await waitFor(async () => (await waiters(e2.pid)) === 1);
    gE1.open();
    await waitFor(() => [e1, e2, c1, c2].some((o) => o.error !== undefined), 600);
    const errors = [e1, e2, c1, c2].map((o) => o.error ?? "");
    assert(errors.some((m) => /deadlock detected/.test(m)), `…and the edits' wait on the captures' locks closes a cycle of four Postgres has to break (${errors.filter(Boolean).map((m) => m.slice(0, 30)).join(" | ") || "no error"})`);
    hold.open();
    await Promise.all([pE1, pE2, pC1, pC2]);
    await Promise.all(conns.map((c) => c.close()));
  }

  // Arm 2 — the shipped functions: the captures held open (each holding its
  // fingerprint lock and its row), then the two edits through update_thought,
  // which since 033 takes the fingerprint lock before its row. Each edit
  // waits on a capture holding nothing; when the captures commit, the edits
  // find the rows that own their new texts and are told, not deadlocked.
  {
    const conns = [0, 1, 2, 3].map(() => new SQL({ url: URL_, max: 1 }));
    const [c1, c2, e1, e2]: Out[] = [{ pid: -1 }, { pid: -1 }, { pid: -1 }, { pid: -1 }];
    const holdC = gate(); const never = gate();
    const pC1 = run(conns[0], c1, (t) => t`SELECT upsert_thought(${X}, '{"metadata":{},"embedding_model":"m"}'::jsonb, ${unit(4)}::vector) AS r`, Promise.resolve(), (t) => t`SELECT 1`, holdC.p);
    const pC2 = run(conns[1], c2, (t) => t`SELECT upsert_thought(${Y}, '{"metadata":{},"embedding_model":"m"}'::jsonb, ${unit(5)}::vector) AS r`, Promise.resolve(), (t) => t`SELECT 1`, holdC.p);
    await waitFor(() => c1.done === true && c2.done === true);
    assert(c1.done && c2.done && c1.error === undefined && c2.error === undefined, "both re-captures ran and are held open, each holding its text's lock and row");
    const pE1 = run(conns[2], e1, (t) => t`SELECT 1`, Promise.resolve(), async (t) => ((await t`SELECT update_thought(${r}::uuid, ${X}, NULL::jsonb, ${unit(6)}::vector) AS r`)[0].r as R), never.p);
    const pE2 = run(conns[3], e2, (t) => t`SELECT 1`, Promise.resolve(), async (t) => ((await t`SELECT update_thought(${rPrime}::uuid, ${Y}, NULL::jsonb, ${unit(7)}::vector) AS r`)[0].r as R), never.p);
    await waitFor(async () => e1.pid > 0 && e2.pid > 0 && (await waiters(e1.pid)) === 1 && (await waiters(e2.pid)) === 1);
    const [held] = await sql`SELECT count(*)::int AS n FROM pg_locks WHERE granted AND locktype IN ('tuple', 'transactionid', 'advisory') AND pid IN (${e1.pid}, ${e2.pid})`;
    assert((await waiters(e1.pid)) === 1 && (await waiters(e2.pid)) === 1 && Number(held.n) === 0, `both edits wait on the fingerprint locks the captures hold and hold no lock of their own meanwhile (${held.n} granted)`);
    holdC.open();
    await Promise.all([pC1, pC2]);
    await waitFor(() => (e1.done === true || e1.error !== undefined) && (e2.done === true || e2.error !== undefined));
    never.open();
    await Promise.all([pE1, pE2]);
    const results = [e1.result as R | undefined, e2.result as R | undefined];
    assert(e1.error === undefined && e2.error === undefined && results.every((x) => x?.ok === false && x.error === "DUPLICATE_CONTENT"),
      `…and once the captures commit both edits complete — told DUPLICATE_CONTENT, since each text's row is the other's — with no deadlock (${e1.error ?? JSON.stringify(results[0])}; ${e2.error ?? JSON.stringify(results[1])})`);
    await Promise.all(conns.map((c) => c.close()));
  }
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6g] delete_thought joins the lock order: an accept racing a delete of the superseded thought deadlocks without the advisory lock and does not with it, forty tries each (migration 036, SMD-1462)");
{
  await sql`DELETE FROM thoughts`;
  // Z is the older, superseded thought — the delete's target, and the row the
  // accept's FK check takes KEY SHARE on; S the newer that supersedes it; P a
  // pending directed proposal. review(P,'accept') writes S.supersedes = Z
  // through update_thought. A small 0–3 ms stagger on each side, as 033's pass
  // ran it. Every arm builds a fresh pair, so a deadlock's rollback leaves
  // nothing behind, and DELETE FROM thoughts between tries clears the rest.
  let n = 0;
  const mkCase = async () => {
    n += 1;
    const z = ((await sql`SELECT upsert_thought(${"older, superseded — case " + n}, '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id;
    const s = ((await sql`SELECT upsert_thought(${"newer, supersedes it — case " + n}, '{"metadata":{}}'::jsonb, ${unit(1)}::vector) AS r`)[0].r as { id: string }).id;
    const p = (await sql`SELECT record_supersession_proposal(${z}::uuid, ${s}::uuid, 'newer_supersedes_older', 0.9, 'raced by test [6g]', 0.9, 'test:1462') AS id`)[0].id as string;
    return { z, s, p };
  };
  const jitter = () => Bun.sleep(Math.random() * 3);
  type R = { ok: boolean; error?: string };

  // Arm 1 — the pre-036 delete, by hand: a single DELETE FROM thoughts holding
  // no advisory lock, racing the shipped review. This is 009's body minus the
  // one line 036 adds, so the cycle it reproduces is exactly the one the fix
  // closes. (033's pass measured 23 of 40 against the 032 review; this arm
  // races the shipped 036 review, but the cycle is on the rows Z and P and does
  // not depend on where the review takes the advisory lock — so the count
  // varies run to run and the arm only asserts it happens at all.) This is the
  // one deliberately stochastic assertion in the suite: with the delete fully
  // lockless the per-try cycle rate is roughly half, so P(0 deadlocks in 40) is
  // on the order of 1e-15 — a spurious pass is not a practical risk.
  {
    const connR = new SQL({ url: URL_, max: 1 });
    const connD = new SQL({ url: URL_, max: 1 });
    let deadlocks = 0;
    for (let i = 0; i < 40; i++) {
      const { z, p } = await mkCase();
      const review = (async () => { await jitter(); try { await connR`SELECT review_supersession_proposal(${p}::uuid, 'accept') AS r`; return ""; } catch (e) { return (e as Error).message; } })();
      const del = (async () => { await jitter(); try { await connD.begin(async (tx: SQL) => { await tx`SET LOCAL statement_timeout = '8s'`; await tx`DELETE FROM thoughts WHERE id = ${z}::uuid`; }); return ""; } catch (e) { return (e as Error).message; } })();
      const [er, ed] = await Promise.all([review, del]);
      if (/deadlock detected/.test(er) || /deadlock detected/.test(ed)) deadlocks += 1;
      await sql`DELETE FROM thoughts`;
    }
    await connR.close(); await connD.close();
    assert(deadlocks > 0, `the lockless delete (009's body, pre-036) racing an accept closes the cycle the ticket measured — ${deadlocks} of 40 deadlocked`);
  }

  // Arm 2 — the shipped delete_thought (036), which takes the supersession lock
  // before the DELETE: forty tries, no 40P01. The delete is never the victim
  // now; whichever writer runs first, its cascade still takes the proposal.
  {
    const connR = new SQL({ url: URL_, max: 1 });
    const connD = new SQL({ url: URL_, max: 1 });
    let deadlocks = 0, deleteVictim = 0, proposalLeft = 0;
    for (let i = 0; i < 40; i++) {
      const { z, p } = await mkCase();
      const review = (async () => { await jitter(); try { return ((await connR`SELECT review_supersession_proposal(${p}::uuid, 'accept') AS r`) as { r: R }[])[0].r; } catch (e) { return { ok: false, error: (e as Error).message } as R; } })();
      const del = (async () => { await jitter(); try { return ((await connD`SELECT delete_thought(${z}::uuid, NULL::jsonb) AS r`) as { r: R }[])[0].r; } catch (e) { return { ok: false, error: (e as Error).message } as R; } })();
      const [rr, rd] = await Promise.all([review, del]);
      if (/deadlock detected/.test(rr.error ?? "") || /deadlock detected/.test(rd.error ?? "")) deadlocks += 1;
      if (rd.ok !== true) deleteVictim += 1;
      if (Number((await sql`SELECT count(*)::int AS c FROM supersession_proposals WHERE id = ${p}::uuid`)[0].c) !== 0) proposalLeft += 1;
      await sql`DELETE FROM thoughts`;
    }
    await connR.close(); await connD.close();
    assert(deadlocks === 0, `forty accepts raced forty shipped deletes, no 40P01 (${deadlocks})`);
    assert(deleteVictim === 0, `the shipped delete was never the deadlock victim — it completed every try (${deleteVictim})`);
    assert(proposalLeft === 0, `the delete's cascade still removed the proposal every try (${proposalLeft})`);
  }
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6h] update_thought naming supersedes races a delete of that target: never a raw 23503, always SUPERSEDES_NOT_FOUND or a clean write — the same lock closes it (migration 036, SMD-1462)");
{
  await sql`DELETE FROM thoughts`;
  // No proposal row here (a plain edit naming supersedes deadlocked 0 of 40
  // pre-fix, the ticket says — nothing for the cascade to fight over). What
  // the delete-side lock closes is the OTHER thing the same probe found: a
  // target deleted between update_thought's existence walk and its UPDATE
  // surfaced as a raw 23503 rather than the SUPERSEDES_NOT_FOUND 032's COMMENT
  // promises. update_thought holds the supersession lock across both its walk
  // and its UPDATE whenever supersedes is named (033); with delete_thought now
  // contending on it, a delete can no longer slip between the two.
  let n = 0;
  const mkPair = async () => {
    n += 1;
    const z = ((await sql`SELECT upsert_thought(${"supersedes target — pair " + n}, '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id;
    const s = ((await sql`SELECT upsert_thought(${"the newer note — pair " + n}, '{"metadata":{}}'::jsonb, ${unit(1)}::vector) AS r`)[0].r as { id: string }).id;
    return { z, s };
  };
  const jitter = () => Bun.sleep(Math.random() * 3);
  type R = { ok: boolean; error?: string };
  const connU = new SQL({ url: URL_, max: 1 });
  const connD = new SQL({ url: URL_, max: 1 });
  let fkViolations = 0, unexpected = 0, pointerLeft = 0, notFound = 0, wrote = 0, deleteFailed = 0;
  for (let i = 0; i < 40; i++) {
    const { z, s } = await mkPair();
    // Build the provenance jsonb server-side: binding a JS string and casting
    // ::jsonb double-encodes it (jsonb_typeof 'string'), which update_thought's
    // 032 guard refuses — the Bun binding trap 005 rejects.
    const upd = (async () => { await jitter(); try { return ((await connU`SELECT update_thought(${s}::uuid, p_provenance => jsonb_build_object('supersedes', ${z}::uuid)) AS r`) as { r: R }[])[0].r; } catch (e) { return { ok: false, error: (e as Error).message } as R; } })();
    const del = (async () => { await jitter(); try { return ((await connD`SELECT delete_thought(${z}::uuid, NULL::jsonb) AS r`) as { r: R }[])[0].r; } catch (e) { return { ok: false, error: (e as Error).message } as R; } })();
    const [ru, rd] = await Promise.all([upd, del]);
    if (/\b23503\b|thoughts_supersedes_fkey/.test(ru.error ?? "")) fkViolations += 1;
    else if (ru.ok === true) wrote += 1;
    else if (ru.error === "SUPERSEDES_NOT_FOUND") notFound += 1;
    else unexpected += 1;
    if (rd.ok !== true) deleteFailed += 1;
    // Whichever way it fell, Z is gone and S points at nothing: never set (the
    // walk found Z already deleted), or set then cleared by 025's SET NULL.
    const after = (await sql`SELECT supersedes FROM thoughts WHERE id = ${s}::uuid`)[0] as { supersedes: string | null } | undefined;
    if (!after || after.supersedes !== null) pointerLeft += 1;
    await sql`DELETE FROM thoughts`;
  }
  await connU.close(); await connD.close();
  assert(fkViolations === 0, `no raw 23503 in forty tries — 032's COMMENT is honoured, not tightened (${fkViolations})`);
  assert(unexpected === 0, `every update_thought answered SUPERSEDES_NOT_FOUND or wrote cleanly — ${notFound} not-found, ${wrote} wrote, ${unexpected} other`);
  assert(deleteFailed === 0, `the delete completed every try (${deleteFailed})`);
  assert(pointerLeft === 0, `S.supersedes is NULL after every race — never set, or set then cleared by the delete's SET NULL (${pointerLeft})`);
  await sql`DELETE FROM thoughts`;
}

console.log("\n[6i] A citation written while a delete of its source is in flight: the citation's transaction holds the source KEY SHARE (a raw insert) or the writers' advisory lock (record_citation), the delete waits and then sees it — refused, never a dangling source; and the raw-writer residue the lock order exists for, reproduced (migration 042, SMD-1712)");
{
  await sql`DELETE FROM thoughts`;
  const mk = async (tag: string) => ({
    s: ((await sql`SELECT upsert_thought(${"a source about to be cited — " + tag}, '{"metadata":{}}'::jsonb, ${unit(0)}::vector) AS r`)[0].r as { id: string }).id,
    c: ((await sql`SELECT upsert_thought(${"the note that cites it — " + tag}, '{"metadata":{}}'::jsonb, ${unit(1)}::vector) AS r`)[0].r as { id: string }).id,
    x: ((await sql`SELECT upsert_thought(${"an older version the note supersedes — " + tag}, '{"metadata":{}}'::jsonb, ${unit(2)}::vector) AS r`)[0].r as { id: string }).id,
  });
  type Env = { ok: boolean; error?: string; cited_by?: number };
  const connW = new SQL({ url: URL_, max: 1 });
  const connD = new SQL({ url: URL_, max: 1 });
  // A wait that never ends would hang the suite: cap both sides.
  await connW.unsafe("SET statement_timeout = '8s'");
  await connD.unsafe("SET statement_timeout = '8s'");
  const startDelete = (s: string) => {
    const t0 = Date.now();
    return (async () => {
      try { return { r: ((await connD`SELECT delete_thought(${s}::uuid, NULL::jsonb) AS r`) as { r: Env }[])[0].r, ms: Date.now() - t0 }; }
      catch (e) { return { r: { ok: false, error: (e as Error).message } as Env, ms: Date.now() - t0 }; }
    })();
  };
  const stillWaiting = async (p: Promise<unknown>) => (await Promise.race([p.then(() => "settled"), Bun.sleep(400).then(() => "waiting")])) === "waiting";
  const dangling = async (s: string) => Number((await sql`SELECT count(*)::int AS c FROM thought_facets f WHERE f.payload->>'source_id' = ${s} AND NOT EXISTS (SELECT 1 FROM thoughts WHERE id = ${s}::uuid)`)[0].c);

  // Arm 1 — a raw INSERT holds KEY SHARE on the source; the delete waits on the row.
  {
    const { s, c } = await mk("raw");
    await connW.unsafe("BEGIN");
    await connW`INSERT INTO thought_facets (thought_id, kind, payload) VALUES (${c}::uuid, 'citation', jsonb_build_object('text', 'rests on it', 'stance', 'retrieved', 'source_id', ${s}::uuid))`;
    const del = startDelete(s);
    assert(await stillWaiting(del), "with the raw citation's transaction open, the delete has not returned — it waits on the source row the validate trigger locked KEY SHARE");
    await connW.unsafe("COMMIT");
    const d = await del;
    assert(d.r.ok === false && d.r.error === "CITED" && d.r.cited_by === 1 && d.ms >= 400, `…and once it commits the delete sees the citation and is refused (${JSON.stringify(d.r)}, after ${d.ms} ms)`);
    assert((await dangling(s)) === 0 && Number((await sql`SELECT count(*)::int AS c FROM thoughts WHERE id = ${s}::uuid`)[0].c) === 1, "the source stands and no citation names a thought that is gone");
  }
  // Arm 2 — record_citation in a transaction that goes on to write supersedes:
  // the writers' order, the lock re-entrant, no cycle.
  {
    const { s, c, x } = await mk("ordered");
    await connW.unsafe("BEGIN");
    const wrote = ((await connW`SELECT record_citation(${c}::uuid, ${s}::uuid, 'rests on it', 'retrieved') AS r`) as { r: Env }[])[0].r;
    const del = startDelete(s);
    assert(wrote.ok === true && (await stillWaiting(del)), "the citation is written under the advisory lock and the delete waits on that lock");
    const upd = ((await connW`SELECT update_thought(${c}::uuid, p_provenance => jsonb_build_object('supersedes', ${x}::uuid)) AS r`) as { r: Env }[])[0].r;
    await connW.unsafe("COMMIT");
    const d = await del;
    assert(upd.ok === true && d.r.ok === false && d.r.error === "CITED", `the same transaction's supersedes write proceeds — no deadlock — and the delete is refused after the commit (update ${JSON.stringify(upd)}, delete ${JSON.stringify(d.r)})`);
    assert((await dangling(s)) === 0, "…nothing dangles");
  }
  // Arm 3 — the residue, reproduced: a raw INSERT takes KEY SHARE and no
  // advisory lock, the waiting delete holds the advisory lock, and the raw
  // writer's transaction then wants it through update_thought — a cycle
  // Postgres has to break. This is what record_citation's lock order avoids
  // (arm 2); the header states it as the raw writer's residue.
  {
    const { s, c, x } = await mk("residue");
    await connW.unsafe("BEGIN");
    await connW`INSERT INTO thought_facets (thought_id, kind, payload) VALUES (${c}::uuid, 'citation', jsonb_build_object('text', 'rests on it', 'stance', 'retrieved', 'source_id', ${s}::uuid))`;
    const del = startDelete(s);
    assert(await stillWaiting(del), "the delete waits on the raw citation's KEY SHARE");
    let updErr = "";
    try { await connW`SELECT update_thought(${c}::uuid, p_provenance => jsonb_build_object('supersedes', ${x}::uuid)) AS r`; } catch (e) { updErr = (e as Error).message; }
    const d = await del;
    try { await connW.unsafe("COMMIT"); } catch { /* an aborted transaction: the ROLLBACK below ends it */ }
    try { await connW.unsafe("ROLLBACK"); } catch { /* no transaction in progress */ }
    assert(/deadlock detected/.test(updErr) || /deadlock detected/.test(d.r.error ?? ""),
      `a raw writer that takes the advisory lock after the row closes the cycle record_citation avoids — deadlock detected in one of the two (update: ${updErr.slice(0, 40) || "ok"}; delete: ${(d.r.error ?? "ok").slice(0, 40)})`);
    assert((await dangling(s)) === 0, "…and whichever writer Postgres chose, no citation names a thought that is gone");
  }
  // Arm 4 — a citation revived under a concurrent writer: T1 clears the
  // expiry of an expired citation of S and holds the row; the delete of S in
  // refuse mode meets that row lock in the guard's locked read (FOR NO KEY
  // UPDATE), waits, and reads the revived version — refused, where an
  // unlocked count followed by a rewrite counted the old version as expired
  // and rewrote the new.
  {
    const { s, c } = await mk("revived");
    const f = ((await sql`SELECT record_citation(${c}::uuid, ${s}::uuid, 'was expired', 'retrieved') AS r`)[0].r as { id: string }).id;
    await sql`UPDATE thought_facets SET valid_until = now() - interval '1 day' WHERE id = ${f}::uuid`;
    await connW.unsafe("BEGIN");
    await connW`UPDATE thought_facets SET valid_until = NULL WHERE id = ${f}::uuid`;
    const del = startDelete(s);
    assert(await stillWaiting(del), "with the revival uncommitted, the delete waits on the citation's row");
    await connW.unsafe("COMMIT");
    const d = await del;
    assert(d.r.ok === false && d.r.error === "CITED" && d.r.cited_by === 1, `…and reads the revived citation as active: refused, not detached as expired (${JSON.stringify(d.r)})`);
    const [after] = (await sql`SELECT payload->>'source_id' AS src FROM thought_facets WHERE id = ${f}::uuid`) as { src: string | null }[];
    assert(after?.src === s && (await dangling(s)) === 0, "the citation still names its source, which stands");
  }
  // Arm 5 — record_citation against a raw delete of the source in flight: its
  // precheck locks the source KEY SHARE, waits, and answers SOURCE_NOT_FOUND as
  // a value once the delete commits — not the validate trigger's check_violation
  // an unlocked EXISTS would have run into.
  {
    const { s, c } = await mk("vanishing");
    await connW.unsafe("BEGIN");
    await connW`DELETE FROM thoughts WHERE id = ${s}::uuid`;
    const t0 = Date.now();
    const cite = (async () => {
      try { return { r: ((await connD`SELECT record_citation(${c}::uuid, ${s}::uuid, 'about to vanish', 'stated') AS r`) as { r: Env }[])[0].r, ms: Date.now() - t0 }; }
      catch (e) { return { r: { ok: false, error: (e as Error).message } as Env, ms: Date.now() - t0 }; }
    })();
    assert(await stillWaiting(cite), "with the raw delete uncommitted, record_citation waits on the source row");
    await connW.unsafe("COMMIT");
    const w = await cite;
    assert(w.r.ok === false && w.r.error === "SOURCE_NOT_FOUND", `…and once it commits the writer answers SOURCE_NOT_FOUND as a value, not a raised check_violation (${JSON.stringify(w.r)})`);
    assert(Number((await sql`SELECT count(*)::int AS c FROM thought_facets WHERE thought_id = ${c}::uuid`)[0].c) === 0, "nothing was written");
  }
  // Arm 6 — a raw delete of the CITING thought while a detaching delete of the
  // source runs. The guard locks the citing thoughts' rows before any facet:
  // here it waits on the note's row the other transaction holds, that
  // transaction's cascade takes the facets freely, and the detach finds nothing
  // left to mark. With the facets locked first (the fifth pass's order) the
  // cascade waited on the guard and the guard on the note — a deadlock.
  {
    const { s, c } = await mk("citing-note-deleted");
    const wrote = (await sql`SELECT record_citation(${c}::uuid, ${s}::uuid, 'about to lose its note', 'stated') AS r`)[0].r as { ok: boolean };
    await connW.unsafe("BEGIN");
    await connW`SELECT 1 FROM thoughts WHERE id = ${c}::uuid FOR UPDATE`;
    const t0 = Date.now();
    const del = (async () => {
      try { return { r: ((await connD`SELECT delete_thought(${s}::uuid, NULL::jsonb, true) AS r`) as { r: Env & { detached?: number } }[])[0].r, ms: Date.now() - t0 }; }
      catch (e) { return { r: { ok: false, error: (e as Error).message } as Env, ms: Date.now() - t0 }; }
    })();
    assert(wrote.ok === true && (await stillWaiting(del)), "with the note's row held, the detaching delete of the source waits on it — before it has touched a facet");
    let rawErr = "";
    try { await connW`DELETE FROM thoughts WHERE id = ${c}::uuid`; } catch (e) { rawErr = (e as Error).message; }
    await connW.unsafe(rawErr ? "ROLLBACK" : "COMMIT");
    const d = await del;
    assert(rawErr === "" && d.r.ok === true && !/deadlock/.test(d.r.error ?? ""), `the raw delete of the note runs — its cascade takes the facets, which the guard has not locked — and the source's delete then completes with nothing to detach (raw: ${rawErr || "ok"}; delete: ${JSON.stringify(d.r)})`);
    assert(Number((await sql`SELECT count(*)::int AS c FROM thoughts WHERE id IN (${s}::uuid, ${c}::uuid)`)[0].c) === 0 && (await dangling(s)) === 0, "both thoughts are gone and nothing dangles");
  }
  await connW.close();
  await connD.close();
  await sql`DELETE FROM thoughts`;
}

console.log("\n[7] Chunk context survives capture, edit and a payload without it");
{
  await sql`DELETE FROM thoughts`;

  /**
   * The behavioural half of migration 013, here rather than in test-schema.ts
   * because PGlite cannot run it: writing chunk rows through the 4-argument
   * upsert_thought crashes the WASM build in-process, with migrations 001-012
   * applied and no 013, so it is the harness rather than the migration. This is
   * the suite that talks to a real server, which is where the round trip
   * belongs anyway.
   */
  const chunkPayload = (specs: { content: string; at: number; context?: string }[]) =>
    specs.map((c) => ({
      content: c.content,
      embedding: unit(c.at),
      ...(c.context !== undefined ? { context: c.context } : {}),
    }));

  const [cap] = await sql`
    SELECT upsert_thought(
      ${"a long capture"}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector,
      ${chunkPayload([
        { content: "first window", at: 1, context: "Notes on the payments rollout." },
        { content: "second window", at: 2 },
      ])}::jsonb
    ) AS r`;
  assert(cap.r?.chunks === 2, `both chunks written (got ${cap.r?.chunks})`);

  const stored = await sql`SELECT chunk_index, context FROM thought_chunks ORDER BY chunk_index`;
  assert(stored[0].context === "Notes on the payments rollout.", "the context sent with a chunk is stored");
  assert(stored[1].context === null, "…and a chunk sent without the key is NULL, not an empty string");

  /**
   * The half that would otherwise rot silently. An edit replaces every chunk, so
   * an update_thought that did not select `context` would strip it from a
   * contextualized thought through ordinary use — embeddings intact, the record
   * of what produced them gone, and nothing reporting it.
   */
  const [upd] = await sql`
    SELECT update_thought(
      ${cap.r.id}::uuid, ${"a longer capture, edited"}, NULL::jsonb, ${unit(3)}::vector,
      ${chunkPayload([{ content: "rewritten window", at: 3, context: "Revised notes on the payments rollout." }])}::jsonb
    ) AS r`;
  assert(upd.r?.ok === true, `the edit succeeds (${JSON.stringify(upd.r)})`);
  const after = await sql`SELECT context FROM thought_chunks ORDER BY chunk_index`;
  assert(after.length === 1, `chunks replaced wholesale (got ${after.length})`);
  assert(after[0].context === "Revised notes on the payments rollout.",
         "…and update_thought carries context through rather than dropping it");

  // A caller that has never heard of context — every client older than 013, and
  // every capture with OB1_CHUNK_CONTEXT off — keeps working unchanged.
  await sql`
    SELECT upsert_thought(
      ${"a second long capture"}, ${{ metadata: {} }}::jsonb, ${unit(4)}::vector,
      ${chunkPayload([{ content: "old-style window", at: 4 }])}::jsonb
    )`;
  const [legacy] = await sql`
    SELECT c.context FROM thought_chunks c JOIN thoughts t ON t.id = c.thought_id
    WHERE t.content = ${"a second long capture"}`;
  assert(legacy.context === null, "a chunk payload with no context key is accepted and stored bare");

  /**
   * 022: the windows stay while the label vouches for them. A long thought
   * captured with two windows and re-captured with the same text through the
   * form every caller uses when the capture made no windows — the Edge
   * server, a window that grew — used to keep the windows of a vector it no
   * longer had, and match_thoughts found it by them. At the same model the
   * windows are still that model's vectors of this text, and stay. (Axes 0–4
   * only, as the rest of this section: the suite's floor on the width.)
   *
   * The found-by reads are exact (SMD-1574). A metadata key only this thought
   * carries sends match_thoughts down its filtered branch, where 014 scores
   * the matching thoughts and their chunks BY ID, no index walk — so "found"
   * is this thought's own vectors against the query and nothing else, and
   * "not found" after the model change is the thought in the scored set with
   * no vector that answers. Read unfiltered — an HNSW walk over the thoughts
   * and chunk indexes — the same-model assertion below missed in five CI
   * attempts on three trees that touched nothing here and in a local loop,
   * where the dumps showed the thoughts index scan returning one or none of
   * three live rows: SMD-1632, and FORK.md's known-issues entry for it, hold
   * that. This section no longer exercises the walk at all; [5b] holds its
   * recall on random vectors, [5c] its plan, and [4], [15], [11]'s hybrid
   * reads and [5b]'s two walk reads still read it unfiltered.
   *
   * 035's re-capture merges metadata (`||`), so the key survives every
   * re-capture below — the last assertion reads `k` beside it. The filter
   * object is the one the first capture stores: `as const`, so a later edit
   * cannot mutate it and part the filter from the stored metadata silently.
   */
  const RECAP = "a long capture, re-captured through the 3-argument form";
  const ONLY_RECAP = { fixture: "022-recap" } as const;
  const [long] = await sql`
    SELECT upsert_thought(${RECAP}, ${{ metadata: ONLY_RECAP, embedding_model: "old-model" }}::jsonb, ${unit(0)}::vector,
      ${chunkPayload([{ content: "first window", at: 1 }, { content: "second window", at: 2 }])}::jsonb) AS r`;
  const longId = long.r.id as string;
  const windows = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${longId}::uuid`)[0].c);
  const foundAt = async (axis: number) =>
    ((await sql`SELECT id FROM match_thoughts(${unit(axis)}::vector, 0.5, 10, ${ONLY_RECAP}::jsonb)`) as { id: string }[]).some((r) => r.id === longId);
  const labelled = async () => (await sql`SELECT embedding_model AS m FROM thoughts WHERE id = ${longId}::uuid`)[0].m as string | null;
  assert((await windows()) === 2 && (await foundAt(2)), "a thought at old-model with two windows, found by its second window");
  await sql`SELECT upsert_thought(${RECAP}, ${{ metadata: {}, embedding_model: "old-model" }}::jsonb, ${unit(3)}::vector)`;
  let n = await windows();
  assert(n === 2 && (await foundAt(2)) && (await foundAt(3)), `a chunkless re-capture at the SAME model moves the vector and keeps the windows: found by the window and by the new vector (${n} windows)`);
  await sql`SELECT upsert_thought(${RECAP}, ${{ metadata: {}, embedding_model: "new-model" }}::jsonb, ${unit(4)}::vector)`;
  n = await windows();
  const m = await labelled();
  assert(n === 0 && m === "new-model", `…at ANOTHER model it moves the vector and label and leaves no windows under them (${n} windows, ${m})`);
  assert(!(await foundAt(2)) && (await foundAt(4)), "…so the thought is no longer found by a window of the vector it no longer has, and is found by the one it has");
  await sql`SELECT upsert_thought(${RECAP}, ${{ metadata: {}, embedding_model: "new-model" }}::jsonb, ${unit(4)}::vector, ${chunkPayload([{ content: "one window", at: 1 }])}::jsonb)`;
  await sql`SELECT upsert_thought(${RECAP}, ${{ metadata: { k: 1 }, embedding_model: "other-model" }}::jsonb, NULL::vector)`;
  n = await windows();
  const [kept] = await sql`SELECT embedding_model AS m, metadata->>'k' AS k FROM thoughts WHERE id = ${longId}::uuid`;
  assert(n === 1 && kept.m === "new-model" && kept.k === "1",
         `a re-capture with no vector keeps the windows with the vector and its label, whatever label it names (${n} window, ${kept.m})`);

  // Deleting still takes the chunks with it — the CASCADE from 007 is unaffected
  // by the new column, and an orphaned vector would keep answering searches.
  await sql`DELETE FROM thoughts`;
  const [orphans] = await sql`SELECT count(*)::int AS c FROM thought_chunks`;
  assert(orphans.c === 0, `no chunk rows survive their thought (got ${orphans.c})`);
}

// ── 8. thought_work_claims under real concurrency (migration 015) ────────────
//
// The property the table exists for cannot be shown on one connection: two
// claims made in a row are disjoint whether or not FOR UPDATE SKIP LOCKED does
// anything, so a sequential test passes against a broken implementation. Here
// the claimers overlap in time — first deterministically, with one transaction
// holding ten uncommitted leases while another claims under a lock_timeout that
// would fire if the second had to wait; then four workers on four connections
// racing through the pool — and the assertions are on ids, not counts.

console.log("\n[8] thought_work_claims: concurrent claimers are disjoint, leases expire, the claim stays cheap");
{
  await sql`DELETE FROM thoughts`;
  const JOB = "test:concurrent";
  await sql.unsafe(`INSERT INTO thoughts (content) SELECT 'pool ' || g FROM generate_series(1, 600) g`);
  const [{ n }] = await sql`SELECT enqueue_thoughts(${JOB}) AS n`;
  assert(Number(n) === 600, `enqueue_thoughts pools all 600 thoughts (got ${n})`);
  const pool = new Set<string>((await sql`SELECT id FROM thoughts`).map((r: { id: string }) => r.id));

  // (a) A lease held open across another worker's claim.
  const holder = new SQL({ url: URL_, max: 1 });
  const other = new SQL({ url: URL_, max: 1 });
  let mine: string[] = [];
  let theirs: string[] = [];
  let otherError = "";
  await holder.begin(async (tx: SQL) => {
    mine = (await tx`SELECT thought_id FROM claim_thoughts(${JOB}, 'holder', 10)`).map((r: { thought_id: string }) => r.thought_id);
    try {
      theirs = await other.begin(async (tx2: SQL) => {
        // Without SKIP LOCKED the second claim would wait on the first's rows
        // until it commits; this turns that wait into a failure.
        await tx2.unsafe(`SET LOCAL lock_timeout = '2s'`);
        return (await tx2`SELECT thought_id FROM claim_thoughts(${JOB}, 'other', 10)`).map((r: { thought_id: string }) => r.thought_id);
      });
    } catch (e) {
      otherError = (e as Error).message;
    }
  });
  assert(mine.length === 10, `one transaction claims ten rows and holds them uncommitted (got ${mine.length})`);
  assert(otherError === "" && theirs.length === 10,
    `a claim made meanwhile returns ten rows inside a 2 s lock_timeout instead of waiting (${otherError || "no error"}, ${theirs.length} rows)`);
  assert(theirs.every((id) => !mine.includes(id)), "…and none of them is a row the open transaction holds");
  await sql`SELECT release_claims_for_worker(${JOB}, 'holder')`;
  await sql`SELECT release_claims_for_worker(${JOB}, 'other')`;
  await holder.close();
  await other.close();

  // (b) Four workers at once, each on its own connection, until the pool is empty.
  const W = 4;
  const conns = Array.from({ length: W }, () => new SQL({ url: URL_, max: 1 }));
  const seen: string[][] = Array.from({ length: W }, () => []);
  await Promise.all(
    conns.map(async (c, i) => {
      const me = `hammer-${i}`;
      for (;;) {
        const batch = (await c`SELECT thought_id FROM claim_thoughts(${JOB}, ${me}, 7)`) as { thought_id: string }[];
        if (batch.length === 0) break;
        for (const r of batch) {
          seen[i].push(r.thought_id);
          await c`SELECT release_thought(${r.thought_id}::uuid, ${JOB}, ${me}, 'succeeded')`;
        }
      }
    })
  );
  for (const c of conns) await c.close();
  const all = seen.flat();
  const distinct = new Set(all);
  assert(distinct.size === all.length, `four concurrent workers claimed ${all.length} rows and no id was claimed twice (${all.length - distinct.size} duplicates)`);
  assert(distinct.size === pool.size && [...pool].every((id) => distinct.has(id)), `…and their union is exactly the pool (${distinct.size} of ${pool.size})`);
  assert(seen.filter((s) => s.length > 0).length >= 2, `…with the work actually shared (${seen.map((s) => s.length).join("/")} rows per worker)`);
  const [{ left }] = await sql`SELECT count(*)::int AS left FROM thought_work_claims WHERE work_type = ${JOB} AND status <> 'succeeded'`;
  assert(Number(left) === 0, "every row ended succeeded");
  const [{ again }] = await sql`SELECT enqueue_thoughts(${JOB}) AS again`;
  const rerun = await sql`SELECT thought_id FROM claim_thoughts(${JOB}, 'rerun', 100)`;
  assert(Number(again) === 0 && rerun.length === 0, "re-running the pass adds nothing and claims nothing: processed rows are not reprocessed");

  // (c) A worker dies holding leases; the TTL returns them; a second worker completes them.
  const JOB2 = "test:crash";
  const eight = [...pool].slice(0, 8);
  await sql`SELECT enqueue_thoughts(${JOB2}, ${sql.array(eight, "TEXT")}::uuid[])`;
  // Two seconds, not one: the "before it expires" claim below is a separate
  // round trip, and a one-second lease is a cliff a stalled CI runner can fall
  // off with no defect in the migration.
  const dead: string[] = (await sql`SELECT thought_id FROM claim_thoughts(${JOB2}, 'dead', 5, 2)`).map((r: { thought_id: string }) => r.thought_id);
  assert(dead.length === 5, `a worker takes five rows on a 2 s lease and dies (got ${dead.length})`);
  const tooSoon = await sql`SELECT thought_id FROM claim_thoughts(${JOB2}, 'second', 10)`;
  assert(tooSoon.length === 3, `before the lease expires a second worker gets only the three unclaimed rows (got ${tooSoon.length})`);
  await Bun.sleep(2200);
  const second = (await sql`SELECT thought_id, attempt FROM claim_thoughts(${JOB2}, 'second', 10)`) as { thought_id: string; attempt: number }[];
  assert(second.length === 5, `after it expires the second worker receives the dead worker's five (got ${second.length})`);
  assert(dead.every((id) => second.find((r) => r.thought_id === id)?.attempt === 2), "…each on its second attempt");
  const [{ late }] = await sql`SELECT release_thought(${dead[0]}::uuid, ${JOB2}, 'dead', 'succeeded') AS late`;
  assert(late === false, "the dead worker, back late, cannot release a row the second worker now holds");
  for (const id of eight) await sql`SELECT release_thought(${id}::uuid, ${JOB2}, 'second', 'succeeded')`;
  const [{ complete }] = await sql`SELECT count(*)::int AS complete FROM thought_work_claims WHERE work_type = ${JOB2} AND status = 'succeeded'`;
  assert(Number(complete) === 8, `…and the second worker completes all eight (${complete})`);

  // (d) The cost of a claim does not grow as the pass proceeds. 10,000 rows, one
  // caller, batches of 16: the last hundred claims are compared to the first
  // hundred by median. The claim's first draft took any sixteen pending rows,
  // which the planner served with a sequential scan that stopped at sixteen
  // hits — 0.48 ms at the start of a 100,000-row pass and 2.90 ms at its end,
  // with VACUUM changing nothing, because the done rows sit at the front of the
  // heap. ORDER BY enqueued_at makes that scan sort the pool, so the partial
  // index wins whatever the statistics say (015's header has the table). The
  // plan is asserted on the same statement shape with a literal key; the
  // statistics are refreshed by enqueue_thoughts itself. Medians, because a
  // single slow round trip is noise, not a trend.
  const JOB3 = "test:cost";
  await sql.unsafe(`INSERT INTO thoughts (content) SELECT 'cost ' || g FROM generate_series(1, 9400) g`);
  await sql`SELECT enqueue_thoughts(${JOB3})`;
  const [{ pooled }] = await sql`SELECT count(*)::int AS pooled FROM thought_work_claims WHERE work_type = ${JOB3} AND status = 'pending'`;
  assert(Number(pooled) === 10000, `10,000 rows pooled for the timing run (got ${pooled})`);
  const [{ body }] = await sql`SELECT prosrc AS body FROM pg_proc WHERE oid = 'claim_thoughts(text, text, int, int, int)'::regprocedure`;
  assert(/ORDER BY c\.enqueued_at/.test(String(body)), "claim_thoughts orders the pool by enqueued_at — the clause that keeps the planner off a sequential scan");
  const plan = (await sql.unsafe(
    `EXPLAIN SELECT c.thought_id FROM thought_work_claims c WHERE c.work_type = 'test:cost' AND c.status = 'pending' ORDER BY c.enqueued_at LIMIT 16 FOR UPDATE SKIP LOCKED`
  )).map((r: Record<string, string>) => Object.values(r)[0]).join(" ");
  assert(/thought_work_claims_pending_idx/.test(plan), `…and the claim's statement plans through the partial pending index (${plan.replace(/\s+/g, " ").slice(0, 120)})`);
  const lat: number[] = [];
  for (;;) {
    const t0 = performance.now();
    const batch = await sql`SELECT thought_id FROM claim_thoughts(${JOB3}, 'timer', 16)`;
    lat.push(performance.now() - t0);
    if (batch.length === 0) break;
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const first = median(lat.slice(0, 100));
  const last = median(lat.slice(-101, -1));
  const p99 = [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.99)];
  console.log(`     ${lat.length} claims of 16: median ${median(lat).toFixed(2)} ms, p99 ${p99.toFixed(2)} ms; first hundred ${first.toFixed(2)} ms, last hundred ${last.toFixed(2)} ms`);
  assert(lat.length === 626, `626 calls empty the pool — 625 batches and one empty answer (got ${lat.length})`);
  assert(last <= first * 2, `the last hundred claims are within twice the first hundred (${last.toFixed(2)} ms vs ${first.toFixed(2)} ms)`);

  // (e) The heartbeat (migration 031, SMD-1023). A worker that renews across its
  // deadline keeps its rows — a claim made after the ORIGINAL deadline gets
  // none of them and its release succeeds — and a worker that stops renewing
  // loses them on the RENEWED deadline, not the original, to a second worker
  // that completes them. Five-second leases. Every wait is a lower bound from
  // Bun.sleep, so a slow runner only makes the "after" claims later; the one
  // step with an upper bound — the claim at 5.5 s must land before the renewed
  // deadline at 9.5 s — has four seconds. The beat at 4.5 s has no upper
  // bound: a lease past its deadline that no claim has reaped is still the
  // holder's, and the beat renews it ([30] asserts that).
  const JOB4 = "test:heartbeat";
  const six = [...pool].slice(8, 14);
  await sql`SELECT enqueue_thoughts(${JOB4}, ${sql.array(six, "TEXT")}::uuid[])`;
  const t0 = Date.now();
  const alive: string[] = (await sql`SELECT thought_id FROM claim_thoughts(${JOB4}, 'alive', 4, 5)`).map((r: { thought_id: string }) => r.thought_id);
  assert(alive.length === 4, `a worker takes four rows on a 5 s lease (got ${alive.length})`);
  await Bun.sleep(4500);
  const b0 = performance.now();
  const beat1 = (await sql`SELECT thought_id FROM renew_claims(${JOB4}, 'alive', 5)`).map((r: { thought_id: string }) => r.thought_id);
  const beatMs = performance.now() - b0;
  assert(beat1.length === 4 && alive.every((id) => beat1.includes(id)), `a beat at 4.5 s renews all four (${beat1.length})`);
  await Bun.sleep(1000); // 5.5 s: past the original deadline, 4 s before the renewed one
  const afterOriginal: string[] = (await sql`SELECT thought_id FROM claim_thoughts(${JOB4}, 'second', 10)`).map((r: { thought_id: string }) => r.thought_id);
  assert(afterOriginal.length === 2 && afterOriginal.every((id) => !alive.includes(id)),
    `a claim after the original deadline gets only the two unclaimed rows — none of the heartbeating worker's (${afterOriginal.length}, at ${Date.now() - t0} ms)`);
  const [{ ok: released }] = await sql`SELECT release_thought(${alive[0]}::uuid, ${JOB4}, 'alive', 'succeeded') AS ok`;
  assert(released === true, "…and the heartbeating worker's release succeeds past the original deadline");
  const b1 = performance.now();
  const beat2 = (await sql`SELECT thought_id FROM renew_claims(${JOB4}, 'alive', 5)`).map((r: { thought_id: string }) => r.thought_id);
  const beat2Ms = performance.now() - b1;
  assert(beat2.length === 3 && !beat2.includes(alive[0]), `the next beat renews the three still held (${beat2.length})`);
  // The worker dies here: no more beats. Its rows expire 5 s after beat2.
  const tooSoonHb = (await sql`SELECT thought_id FROM claim_thoughts(${JOB4}, 'second', 10)`).length;
  assert(tooSoonHb === 0, "before the renewed deadline a second worker gets nothing");
  await Bun.sleep(5300);
  const inherited = (await sql`SELECT thought_id, attempt FROM claim_thoughts(${JOB4}, 'second', 10)`) as { thought_id: string; attempt: number }[];
  assert(inherited.length === 3 && inherited.every((r) => beat2.includes(r.thought_id) && r.attempt === 2),
    `after the renewed deadline the second worker receives the dead worker's three, on their second attempt (${inherited.length})`);
  for (const id of [...afterOriginal, ...inherited.map((r) => r.thought_id)]) await sql`SELECT release_thought(${id}::uuid, ${JOB4}, 'second', 'succeeded')`;
  const [{ hbDone, hbFailed }] = await sql`
    SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS "hbDone", count(*) FILTER (WHERE status = 'failed')::int AS "hbFailed"
      FROM thought_work_claims WHERE work_type = ${JOB4}`;
  assert(Number(hbDone) === 6 && Number(hbFailed) === 0, `…and every row ends succeeded, none failed (${hbDone}/${hbFailed})`);
  console.log(`     a beat renewing four leases: ${beatMs.toFixed(2)} ms on the function's first call (plan included), ${beat2Ms.toFixed(2)} ms renewing three on the next`);
  // The beat's statement plans through 015's partial worker index, as the
  // claim's does through the pending one — asserted on the same statement
  // shape with literal values, as (d) asserts the claim's.
  const beatPlan = (await sql.unsafe(
    `EXPLAIN UPDATE thought_work_claims c SET ttl_expires_at = GREATEST(c.ttl_expires_at, now() + make_interval(secs => 5)) WHERE c.work_type = 'test:heartbeat' AND c.worker_id = 'alive' AND c.status = 'claimed'`
  )).map((r: Record<string, string>) => Object.values(r)[0]).join(" ");
  assert(/thought_work_claims_worker_idx/.test(beatPlan), `…and the beat's statement plans through the partial worker index (${beatPlan.replace(/\s+/g, " ").slice(0, 120)})`);
  // The rule the three workers share, from the module they share.
  assert(heartbeatFor(900) === 60 && heartbeatFor(10) === 3 && heartbeatFor(2) === 1 && heartbeatFor(1) === 1, "heartbeatFor: 60 s, or a third of the lease, at least one second");
  assert(leaseRefusal(900, 60) === null && leaseRefusal(4, 2) === null && leaseRefusal(2, 1) === null && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(leaseRefusal(3, 2) ?? "") && /Raise --ttl or lower --heartbeat\.$/.test(leaseRefusal(3, 2) ?? ""),
    "leaseRefusal: a lease of two heartbeats passes — two seconds at the one-second floor included — and one under is refused with the arithmetic");
  assert(/--ttl 1 s cannot cover two beats of the 1 s heartbeat derived from it/.test(leaseRefusal(1, 1, true) ?? "") && /Raise --ttl\.$/.test(leaseRefusal(1, 1, true) ?? ""),
    "…and at the heartbeat's floor, derived, the text quotes no flag the operator did not pass and the remedy is the lease alone");
  assert(/more than claim_thoughts and renew_claims take \(an int, at most 2147483647 s\)/.test(leaseRefusal(2147483648, 60) ?? "") && /more than a timer can hold \(at most 2147483 s/.test(leaseRefusal(5000000, 2500000) ?? "") && leaseRefusal(2147483647, 2147483) === null,
    "leaseRefusal: a lease above int4 and a heartbeat above the timer's 32-bit millisecond ceiling are refused with the reason; the largest pair that fits passes");

  await sql`DELETE FROM thoughts`;
}

// ── 9. db/reembed.ts — the consumer, end to end ──────────────────────────────
//
// A stub provider stands in for the model: each text embeds onto an axis chosen
// from its characters and never axis 0, so a corpus seeded on axis 0 shows
// exactly which rows the pass rewrote. One text is poison — refused with a 500
// until the test says otherwise — to exercise the failed path and
// --retry-failed. The first whole-content request for either of two long
// thoughts is throttled with a 429, once: the other must still end with the
// whole content's vector (a latch on any 4xx, which the first review found,
// would give both the head window), and the throttled one must carry its head
// window AND be recorded failed rather than succeeded, so --retry-failed can
// give it the whole content once the provider is willing (second review). A
// third long thought is REFUSED whole with a 413 every time until the test says
// otherwise: it must end succeeded with its head window and the refusal on the
// claim row, be listed under --status, cost the other two nothing (a pass that
// remembered the refusal would give them head windows unasked), and get its
// whole-content vector from --retry-fallbacks (SMD-1021). One short thought is
// a tarpit — its first request is never answered — and must fail with the
// timeout named while the run finishes. Two rows are legacy twins — NULL
// fingerprints, the same text but for whitespace, inserted around
// upsert_thought as a brain from before migration 003 holds them — and both
// must end succeeded, one fingerprinted and one not, with the pair named in the
// summary and under --status (SMD-1022; 013's update_thought refused the second
// for ever). Ten milliseconds per embedding so two workers really overlap.
//
// Preflight is run as a subprocess against the same database at four points
// (SMD-1024): after a run killed just after it recorded the new model (the
// record and the pool are one transaction, so the kill leaves a pool preflight
// reports, never a bare record), after the first run (three failed rows), while
// another process holds a lease, and once the pass is finished — and each time
// the counts it prints are the counts the tool printed. Last, the recorded
// model is switched back and --switch-model to it again must start the key's
// pool over rather than find every thought's terminal row and do nothing.

console.log("\n[9] db/reembed.ts: a full re-embed through the claims, against a stub provider");
{
  await sql`DELETE FROM thoughts`;
  // Prefixed as preflight attributes a pass to the tool — see reembed.ts's
  // header. The configured model's key is reembed:stub-embed@<dim>; this one
  // exercises preflight's "another key" wording.
  const REEMBED_JOB = "reembed:test";
  const DIM = EMBEDDING_DIM;
  let poison = true;
  let throttled = false;
  let refusing = true;
  let tarpitOpen = true;
  // While set, every embedding request but the run's provider probe hangs, so
  // a run can be killed between recording the model and its first write.
  let frozen = false;
  // While set, every embedding takes this long: the heartbeat run at the end.
  let slowMs = 0;
  const modelsSeen = new Set<string>();
  const axisFor = (text: string) => {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 1 + (h % (DIM - 1));
  };
  // Long enough to chunk at the default 1,200-token window.
  const long = Array.from({ length: 1500 }, (_, k) => `word${k}`).join(" ");
  const long2 = Array.from({ length: 1500 }, (_, k) => `term${k}`).join(" ");
  const long3 = Array.from({ length: 1500 }, (_, k) => `item${k}`).join(" ");
  const tarpitText = "the tarpit note";
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      // preflight's reachability probe (SMD-1875): a bare GET of /models.
      if (req.method === "GET") return Response.json({ object: "list", data: [] });
      const body = (await req.json()) as { input?: string; model?: string };
      modelsSeen.add(String(body.model));
      const input = String(body.input ?? "");
      if (frozen && input !== "reembed.ts provider probe") await neverAnswers();
      if (poison && input.includes("hemlock")) {
        return Response.json({ error: { message: "stub: refused this text" } }, { status: 500 });
      }
      if (!throttled && (input === long || input === long2)) {
        throttled = true;
        return Response.json({ error: { message: "stub: rate limited" } }, { status: 429 });
      }
      if (refusing && input === long3) {
        return Response.json({ error: { message: "stub: input too long for this model" } }, { status: 413 });
      }
      if (tarpitOpen && input === tarpitText) {
        tarpitOpen = false;
        await neverAnswers();
      }
      if (slowMs > 0) await Bun.sleep(slowMs);
      await Bun.sleep(10);
      const v = new Array(DIM).fill(0);
      v[axisFor(input)] = 1;
      return Response.json({ data: [{ embedding: v }] });
    },
  });
  const axisOf = (vectorText: string | null) => {
    if (vectorText === null) return null;
    const v = JSON.parse(vectorText) as number[];
    return v.indexOf(1);
  };

  const shorts = Array.from({ length: 30 }, (_, i) => `short thought ${i} about topic ${i}`);
  for (const s of shorts) await sql`SELECT upsert_thought(${s}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${long}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${long2}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${long3}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${tarpitText}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  const poisonText = "the hemlock note";
  await sql`SELECT upsert_thought(${poisonText}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  const bare = "captured through the two-argument fallback";
  await sql`SELECT upsert_thought(${bare}, ${{ metadata: {} }}::jsonb)`;
  const twins = ["Legacy Twin Note", "legacy   twin note"];
  for (const t of twins) await sql`INSERT INTO thoughts (content, content_fingerprint, embedding) VALUES (${t}, NULL, ${unit(0)}::vector)`;
  const [{ auditBefore }] = await sql`SELECT count(*)::int AS "auditBefore" FROM thought_audit`;
  const updatedBefore = new Map(
    (await sql`SELECT content, updated_at::text AS u FROM thoughts`).map((r: { content: string; u: string }) => [r.content, r.u])
  );
  const [{ model: recordedModel }] = await sql`SELECT value AS model FROM ob1_config WHERE key = 'embedding_model'`;

  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: URL_,
    OB1_LLM_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    OB1_LLM_LOCAL: "1", // declared to the egress gate (SMD-1903); the stub is on this box
    OB1_EMBEDDING_MODEL: "stub-embed",
    OB1_EMBEDDING_DIM: String(DIM),
    // The tarpit answers never; two seconds is what the run may wait for it.
    OB1_LLM_TIMEOUT: "2",
  };
  delete env.OB1_EMBEDDING_DIMENSIONS;
  delete env.OB1_CHUNK_CONTEXT;
  delete env.OB1_LLM_API_KEY;
  const reembedIn = (extraEnv: Record<string, string>, ...extra: string[]): Promise<{ code: number; out: string }> => {
    // The suite's key unless the call names its own (flag() reads the first --job).
    const job = extra.includes("--job") ? [] : ["--job", REEMBED_JOB];
    return runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_!, ...job, ...extra], { env: { ...env, ...extraEnv } as Record<string, string>, cwd: HERE });
  };
  const reembed = (...extra: string[]) => reembedIn({}, ...extra);
  const claimCounts = async () =>
    Object.fromEntries(
      (await sql`SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${REEMBED_JOB} GROUP BY status`)
        .map((r: { status: string; c: number }) => [r.status, Number(r.c)])
    ) as Record<string, number>;

  // server-portable/preflight.ts against the same database, configured as the
  // run is (the stub is a loopback endpoint, so no credential is needed).
  const preflight = (): Promise<{ code: number; out: string }> => {
    const penv: Record<string, string | undefined> = { ...env, OB1_STORE: "sql", MCP_ACCESS_KEY: "x".repeat(64) };
    for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY", "OB1_LLM_API_KEY"]) delete penv[k];
    const dir = join(HERE, "..", "server-portable");
    return runScript(["bun", join(dir, "preflight.ts")], { env: penv as Record<string, string>, cwd: dir });
  };
  const PASS_LINE = /re-embed pass\s+reembed:test: (\d+ thoughts — [^\n]*not yet in the pool) — a pass under this key stopped before it finished/;

  // The ticket's crash: a run killed after it recorded the new model. The stub
  // freezes every request but the probe, so the one worker hangs on its first
  // row and nothing is written; the kill lands between the record and the
  // first write. The record and the pool are one transaction, so what is left
  // is a pool — every row pending, or all but the one the dead worker had
  // claimed, depending on where the kill landed — that
  // preflight reports, and never a record with nothing behind it.
  frozen = true;
  {
    const p = Bun.spawn(["bun", join(HERE, "reembed.ts"), "--url", URL_!, "--job", REEMBED_JOB, "--switch-model", "--workers", "1", "--batch", "1"], {
      env, stdout: "pipe", stderr: "pipe", cwd: HERE,
    });
    const reader = p.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!/ob1_config\.embedding_model = stub-embed/.test(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    p.kill(9);
    await p.exited;
    assert(/ob1_config\.embedding_model = stub-embed/.test(seen), "a run was killed just after it recorded the new model");
    const [{ model: afterKill }] = await sql`SELECT value AS model FROM ob1_config WHERE key = 'embedding_model'`;
    const killed = await claimCounts();
    const pooled = Object.values(killed).reduce((a, b) => a + b, 0);
    assert(afterKill === "stub-embed" && pooled === 38 && (killed.pending ?? 0) + (killed.claimed ?? 0) === 38,
      `…leaving the record AND the whole pool, nothing written: ${JSON.stringify(killed)} (${afterKill})`);
    const pf = await preflight();
    const line = PASS_LINE.exec(pf.out);
    assert(pf.code === 0 && /embedding contract\s+stub-embed @ \d+ dimensions, matching/.test(pf.out), `preflight still passes, with the contract matching (exit ${pf.code})`);
    assert(line !== null && /38 thoughts — 0 succeeded, 0 failed, (1 in flight, 37 pending|0 in flight, 38 pending), 0 not yet in the pool/.test(line?.[1] ?? ""),
      `…and warns that the pass under this key has not finished, with the counts (${line?.[1] ?? pf.out.split("\n").find((l) => /re-embed pass/.test(l))})`);
    assert(/--job reembed:test/.test(pf.out) && /--status/.test(pf.out), "…naming the key's flag and --status as the remedy");
    await sql`UPDATE ob1_config SET value = ${recordedModel} WHERE key = 'embedding_model'`;
    await sql`DELETE FROM thought_work_claims WHERE work_type = ${REEMBED_JOB}`;
  }
  frozen = false;
  // The killed run's probe reached the stub; the model assertion below is
  // about the first real pass.
  modelsSeen.clear();

  // A --job that names a model must name the configured one: the run would
  // otherwise write this shell's vectors and record them as the other's.
  const wrongKey = await reembed("--job", `reembed:other-model@${DIM}`);
  assert(wrongKey.code === 2 && /names a pass to other-model @ \d+, but this shell is configured for stub-embed/.test(wrongKey.out),
    `a --job naming another model is refused with exit 2 (exit ${wrongKey.code})`);
  assert(Object.keys(await claimCounts()).length === 0 && (await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type LIKE 'reembed:other-model%'`)[0].c === 0, "…before anything is written");
  const wrongKeyDry = await reembed("--dry-run", "--job", `reembed:other-model@${DIM}`);
  assert(wrongKeyDry.code === 2 && /would: refuse\. --job reembed:other-model@\d+ names a pass to other-model/.test(wrongKeyDry.out), `…--dry-run reports that refusal (exit ${wrongKeyDry.code})`);
  const wrongKeyStatus = await reembed("--status", "--job", `reembed:other-model@${DIM}`);
  assert(wrongKeyStatus.code === 0 && /status: 38 thoughts — 0 succeeded, 0 failed, 0 in flight, 0 pending, 38 not yet in the pool/.test(wrongKeyStatus.out),
    `…while --status answers for the key from any shell, since it writes nothing — counting the pool against the KEY's model, as preflight does for it (exit ${wrongKeyStatus.code}: ${wrongKeyStatus.out.split("\n").find((l) => /status:/.test(l))?.trim()})`);
  const bareKey = await reembed("--status", "--job", "test:bare");
  assert(bareKey.code === 0 && /preflight will not report this pass unfinished — its key does not start with reembed:/.test(bareKey.out) && !/preflight will warn/.test(bareKey.out),
    `a key without the prefix is accepted with a note, and is never said to be something preflight will warn about (exit ${bareKey.code})`);

  const dry = await reembed("--dry-run");
  assert(dry.code === 0 && /Nothing was written/.test(dry.out), `--dry-run exits 0 and says it wrote nothing (exit ${dry.code})`);
  assert(/model change/.test(dry.out) && /would: refuse without --switch-model; with it: record stub-embed/.test(dry.out),
    "…names the model change it would make, and that the run itself would refuse without the flag");
  assert(Object.keys(await claimCounts()).length === 0, "…and pooled nothing");

  const refused = await reembed();
  assert(refused.code === 2 && /--switch-model/.test(refused.out), `a model change without --switch-model is refused with exit 2 (exit ${refused.code})`);
  const [{ model: stillRecorded }] = await sql`SELECT value AS model FROM ob1_config WHERE key = 'embedding_model'`;
  assert(stillRecorded === recordedModel && Object.keys(await claimCounts()).length === 0, "…touching neither ob1_config nor the pool");
  // A lease under two heartbeats is refused before anything is touched: since
  // migration 031 the lease has to outlast a missed beat, not the batch.
  const shortLease = await reembed("--switch-model", "--ttl", "3", "--heartbeat", "2");
  assert(shortLease.code === 2 && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(shortLease.out) && /Raise --ttl or lower --heartbeat/.test(shortLease.out),
    `a --ttl under two heartbeats is refused with exit 2, showing the arithmetic (exit ${shortLease.code})`);
  assert(Object.keys(await claimCounts()).length === 0, "…before the pool exists");
  const statusShort = await reembed("--status", "--ttl", "3", "--heartbeat", "2");
  assert(statusShort.code === 0 && /status: \d+ thoughts/.test(statusShort.out), `…while --status answers whatever the lease, since it never claims (exit ${statusShort.code})`);
  // Neither the batch nor the timeout sizes the lease any more: eight rows at
  // any timeout run under the default 900 s lease and 60 s heartbeat (until 031
  // this derived a 1084 s lease from a 120.3 s timeout), and a lease given
  // without a heartbeat derives one of a third of it.
  const defaults = await reembedIn({ OB1_LLM_TIMEOUT: "120.3" }, "--dry-run");
  assert(defaults.code === 0 && /8 per claim, 900 s leases renewed every 60 s/.test(defaults.out),
    `the default lease is 900 s with a 60 s heartbeat whatever the batch and timeout (${defaults.out.match(/\d+ s leases[^,]*/)?.[0]})`);
  const derived = await reembed("--dry-run", "--ttl", "10");
  assert(derived.code === 0 && /8 per claim, 10 s leases renewed every 3 s/.test(derived.out),
    `a lease given without a heartbeat derives one of a third of it (${derived.out.match(/\d+ s leases[^,]*/)?.[0]})`);
  // The runtime's bounds, refused before a run rather than found by it: a
  // lease above int4 failed every claim on its signature after --dry-run had
  // accepted it; a heartbeat above the timer's ceiling beat every millisecond.
  const hugeTtl = await reembed("--dry-run", "--ttl", "2147483648");
  assert(hugeTtl.code === 2 && /--ttl 2147483648 s is more than claim_thoughts and renew_claims take/.test(hugeTtl.out), `a lease above int4 is refused by --dry-run too (exit ${hugeTtl.code})`);
  const hugeBeat = await reembed("--dry-run", "--ttl", "5000000", "--heartbeat", "2500000");
  assert(hugeBeat.code === 2 && /--heartbeat 2500000 s is more than a timer can hold/.test(hugeBeat.out), `a heartbeat above the timer's ceiling is refused (exit ${hugeBeat.code})`);

  const first = await reembed("--switch-model", "--workers", "2", "--batch", "3");
  assert(first.code === 1, `the run exits 1 because rows failed (exit ${first.code})`);
  assert(/35 re-embedded, 3 failed/.test(first.out), `…and says so: 35 re-embedded, 3 failed (${first.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  assert(/stub: refused this text/.test(first.out), "…naming the provider's error for the poisoned row");
  assert(/whole-content embedding failed transiently \(.*429 .*stub: rate limited/.test(first.out), "…and, for the throttled long thought, that its head window stands in until a retry, with the 429 named");
  assert(/timed out after 2 s \(OB1_LLM_TIMEOUT\)/.test(first.out), "…and, for the tarpit, that its call timed out, naming the setting");
  assert(/1 succeeded row\(s\) carry a caveat/.test(first.out) && /413 .*stub: input too long/.test(first.out),
    "…and lists the one long thought the provider refused whole, with the 413");
  assert(/35 succeeded \(1 with a caveat\)/.test(first.out), "…which the counts show as succeeded with a caveat, not as failed");
  const FIRST_COUNTS = "38 thoughts — 35 succeeded (1 with a caveat), 3 failed, 0 in flight, 0 pending, 0 not yet in the pool";
  assert(first.out.includes(`preflight will warn until this finishes: reembed:test — ${FIRST_COUNTS}`), "…and says what preflight will say until the failed rows are retried");
  {
    const pf = await preflight();
    const line = PASS_LINE.exec(pf.out);
    assert(pf.code === 0 && line?.[1] === FIRST_COUNTS, `preflight says the same, in the same words, as a warning (exit ${pf.code}: ${line?.[1] ?? "no re-embed pass line"})`);
    assert(/--retry-failed for the 3 failed/.test(pf.out), "…with --retry-failed in the remedy while rows are failed");
  }
  const [{ model: nowRecorded }] = await sql`SELECT value AS model FROM ob1_config WHERE key = 'embedding_model'`;
  assert(nowRecorded === "stub-embed", `ob1_config now records the new model (${nowRecorded})`);
  assert(modelsSeen.has("stub-embed"), "the provider was asked for the configured model");

  const rows = (await sql`SELECT content, embedding::text AS e, updated_at::text AS u FROM thoughts`) as { content: string; e: string | null; u: string }[];
  const byContent = new Map(rows.map((r) => [r.content, r]));
  assert(shorts.every((s) => axisOf(byContent.get(s)!.e) === axisFor(s)), "every short thought carries the stub's vector for its own text");
  assert(axisOf(byContent.get(poisonText)!.e) === 0, "the poison row keeps its old vector");
  assert(axisOf(byContent.get(bare)!.e) === axisFor(bare), "the row that had no vector has one now");
  const chunksOf = async (doc: string) =>
    (await sql`
      SELECT c.content, c.embedding::text AS e, c.context FROM thought_chunks c JOIN thoughts t ON t.id = c.thought_id
      WHERE t.content = ${doc} ORDER BY c.chunk_index`) as { content: string; e: string; context: string | null }[];
  const chunks = await chunksOf(long);
  const chunks2 = await chunksOf(long2);
  const chunks3 = await chunksOf(long3);
  assert(chunks.length >= 2 && chunks2.length >= 2 && chunks3.length >= 2, `all three long thoughts gained chunk rows they never had (${chunks.length}, ${chunks2.length}, ${chunks3.length})`);
  assert([...chunks, ...chunks2, ...chunks3].every((c) => axisOf(c.e) === axisFor(c.content) && c.context === null), "…each embedded from its own window text, bare, as the server would with context off");
  // One whole-content call was throttled, so one of the two carries its head
  // window and the other the whole content. Both would carry the head window
  // if a 429 latched the fallback for the rest of the process — or if the
  // third's 413 did, whichever worker reached it first.
  const whole = [long, long2].filter((d) => axisOf(byContent.get(d)!.e) === axisFor(d));
  const head = [long, long2].filter((d) => axisOf(byContent.get(d)!.e) === axisFor((d === long ? chunks : chunks2)[0].content));
  assert(whole.length === 1 && head.length === 1, `one long thought carries the whole-content vector and the throttled one its head window (${whole.length} whole, ${head.length} head)`);
  const throttledDoc = head[0];
  // The refused one: head window, succeeded, the refusal on the row.
  assert(axisOf(byContent.get(long3)!.e) === axisFor(chunks3[0].content), "the long thought refused whole carries its head window's vector");
  const [refusedClaim] = await sql`
    SELECT c.status, c.last_error AS err FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id
    WHERE c.work_type = ${REEMBED_JOB} AND t.content = ${long3}`;
  assert(refusedClaim?.status === "succeeded" && /refused by the provider \(.*413 .*stub: input too long/.test(refusedClaim?.err ?? "") && /--retry-fallbacks/.test(refusedClaim?.err ?? ""),
    `…and its claim is succeeded with the refusal as its caveat, naming the flag (${refusedClaim?.status}: ${refusedClaim?.err})`);
  assert(axisOf(byContent.get(tarpitText)!.e) === 0, "the tarpit row keeps its old vector");
  assert(shorts.every((s) => byContent.get(s)!.u > updatedBefore.get(s)!), "updated_at moved on every re-embedded row");
  assert(byContent.get(poisonText)!.u === updatedBefore.get(poisonText), "…and not on the one that failed");

  // The legacy twins: both re-embedded, whichever worker reached which first;
  // one gained the fingerprint 003 never backfilled and the other was told
  // rather than refused, so it stays NULL and the partial index holds.
  const twinRows = (await sql`
    SELECT t.content, t.content_fingerprint AS fp, t.embedding::text AS e, c.status FROM thoughts t
    JOIN thought_work_claims c ON c.thought_id = t.id AND c.work_type = ${REEMBED_JOB}
    WHERE t.content = ANY(${sql.array(twins, "TEXT")})`) as { content: string; fp: string | null; e: string; status: string }[];
  assert(twinRows.length === 2 && twinRows.every((r) => r.status === "succeeded"), `both legacy twins are succeeded, not one failed with DUPLICATE_CONTENT (${twinRows.map((r) => r.status).join(", ")})`);
  assert(twinRows.every((r) => axisOf(r.e) === axisFor(r.content)), "…both carry the stub's vector for their own text");
  assert(twinRows.filter((r) => r.fp !== null).length === 1, `…exactly one of them carries a fingerprint (${twinRows.filter((r) => r.fp !== null).length})`);
  assert(/duplicates [0-9a-f-]{36} — the same text/.test(first.out), "…the run named the pair as it found it");
  assert(/1 group\(s\) of thoughts share one normalised text/.test(first.out), "…and the summary counts the group");

  const after1 = await claimCounts();
  assert(after1.succeeded === 35 && after1.failed === 3 && !after1.pending && !after1.claimed, `the claims record 35 succeeded and 3 failed (${JSON.stringify(after1)})`);
  const errs = (await sql`
    SELECT t.content, c.last_error AS err FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id
    WHERE c.work_type = ${REEMBED_JOB} AND c.status = 'failed'`) as { content: string; err: string }[];
  assert(/stub: refused this text/.test(errs.find((e) => e.content === poisonText)?.err ?? ""), "…with the provider's error on the poisoned row");
  assert(/failed transiently \(.*429/.test(errs.find((e) => e.content === throttledDoc)?.err ?? ""), "…the transient whole-content failure on the throttled one, with its status");
  assert(/timed out after 2 s \(OB1_LLM_TIMEOUT\)/.test(errs.find((e) => e.content === tarpitText)?.err ?? ""), "…and the timeout on the tarpit");
  const [{ caveats }] = await sql`
    SELECT count(*)::int AS caveats FROM thought_work_claims WHERE work_type = ${REEMBED_JOB} AND status = 'succeeded' AND last_error IS NOT NULL`;
  assert(Number(caveats) === 1, `exactly one succeeded row carries a caveat — the refused long thought, no other (${caveats})`);
  const [{ workers }] = await sql`SELECT count(DISTINCT worker_id)::int AS workers FROM thought_work_claims WHERE work_type = ${REEMBED_JOB}`;
  assert(Number(workers) === 2, `both workers took rows (${workers} distinct worker ids)`);

  // The audit log: nothing for a vector replaced by a vector, one row for a
  // vector where there was none — 008's trigger diffs presence, not value —
  // and, since 055 (SMD-2115), one for the legacy twin update_thought keyed
  // as it passed (the first of the pair it reached takes 003's key, the other
  // stays NULL under 018): the key's move is the third thing the event
  // carries, and before 055 that fill left no trace.
  const [{ auditAfter }] = await sql`SELECT count(*)::int AS "auditAfter" FROM thought_audit`;
  assert(Number(auditAfter) - Number(auditBefore) === 2, `the pass wrote two audit rows, not thirty-seven — the vector where there was none, and the key the first legacy twin gained (${Number(auditAfter) - Number(auditBefore)})`);
  const keyRows = await sql`
    SELECT a.actor_name, a.author_session_id, a.diff FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id
    WHERE t.content IN (${twins[0]}, ${twins[1]}) AND a.action = 'update'`;
  assert(keyRows.length === 1 && keyRows[0].actor_name === "reembed" && keyRows[0].author_session_id === REEMBED_JOB && Object.keys(keyRows[0].diff).join(",") === "content_fingerprint" && keyRows[0].diff.content_fingerprint.before === null && typeof keyRows[0].diff.content_fingerprint.after === "string",
    `…one of them the twin that took the key: the move alone — before NULL, after 003's key — attributed to the pass (${JSON.stringify(keyRows.map((r: { diff: unknown }) => r.diff))})`);
  const [auditRow] = await sql`
    SELECT a.actor_name, a.author_session_id, a.diff FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id
    WHERE t.content = ${bare} AND a.action = 'update'`;
  assert(auditRow?.actor_name === "reembed" && auditRow?.author_session_id === REEMBED_JOB && auditRow?.diff?.embedding_present === true,
    `…for the row that gained a vector, attributed to the tool and the job (${JSON.stringify(auditRow)})`);

  const status = await reembed("--status");
  assert(status.code === 0 && /35 succeeded \(1 with a caveat\), 3 failed/.test(status.out), "--status reports the pass, caveat included");
  assert(status.out.includes(`preflight will warn until this finishes: reembed:test — ${FIRST_COUNTS}`), "…and what preflight will say meanwhile");
  assert(/1 succeeded row\(s\) carry a caveat/.test(status.out) && /--retry-fallbacks/.test(status.out), "…lists the refused long thought and names the flag that revisits it");
  assert(/1 group\(s\) of thoughts share one normalised text/.test(status.out) && /delete_thought/.test(status.out), "…and lists the legacy pair as a dedup task, with what to do about it");
  const dryFallbacks = await reembed("--dry-run", "--retry-fallbacks");
  assert(dryFallbacks.code === 0 && /return 1 rows succeeded with a caveat to the pool/.test(dryFallbacks.out) && /over 1 rows/.test(dryFallbacks.out),
    `--dry-run --retry-fallbacks says what it would return, and writes nothing (exit ${dryFallbacks.code})`);
  assert((await claimCounts()).succeeded === 35, "…and the claim row is untouched");

  // A capture made after the first run, then a re-run: only the new row is
  // processed, the failed one stays failed, and the exit code says so.
  const late = "captured after the first pass";
  await sql`SELECT upsert_thought(${late}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  const rerun = await reembed();
  assert(rerun.code === 1 && /1 thought\(s\) added/.test(rerun.out) && /1 re-embedded/.test(rerun.out), `a re-run pools and processes only the new capture (exit ${rerun.code})`);
  assert(/--retry-failed/.test(rerun.out), "…and points at --retry-failed for the row that stays failed");
  const [{ e: lateVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${late}`;
  assert(axisOf(lateVec) === axisFor(late), "…the new capture carries the new vector");

  // The operator says "I know" about the poisoned row (SMD-1067): the provider
  // refuses it on every attempt, no retry will change that, and until now its
  // failed row kept preflight warning on every start for ever. --accept-failed
  // marks it succeeded with the caveat, the row keeps the vector it had,
  // --status lists it among the caveats, and --retry-fallbacks is the way back.
  // The refusals first: no ids, an id whose row is not failed, a flag
  // combination — each writes nothing.
  const [{ id: poisonId }] = await sql`SELECT id::text AS id FROM thoughts WHERE content = ${poisonText}`;
  const [{ id: lateId }] = await sql`SELECT id::text AS id FROM thoughts WHERE content = ${late}`;
  const noIds = await reembed("--accept-failed");
  assert(noIds.code === 2 && /needs the rows to accept, by id/.test(noIds.out) && /--all/.test(noIds.out) && noIds.out.includes(poisonId) && /3 failed row\(s\) under reembed:test/.test(noIds.out),
    `--accept-failed with no ids refuses, listing the failed rows and both forms (exit ${noIds.code})`);
  // The egress gate (SMD-1903): with the stub not declared local under the
  // default, a run stops before claiming; --accept-failed and --retire write
  // claim rows and dial nothing, so the gate has no say and each reaches its
  // own refusal (second review pass).
  const gateEnv = { ...env } as Record<string, string>;
  for (const k of ["OB1_LLM_LOCAL", "OB1_CHAT_LOCAL", "OB1_EGRESS_POLICY", "OB1_EGRESS_ALLOW", "OB1_EGRESS_DENY"]) delete gateEnv[k];
  const gated = (...extra: string[]) => runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_!, "--job", REEMBED_JOB, ...extra], { env: gateEnv, cwd: HERE });
  const gateStop = await gated();
  assert(gateStop.code === 2 && /Nothing would be re-embedded: OB1_EGRESS_POLICY=deny \(the default\) with no OB1_EGRESS_ALLOW term, and 127\.0\.0\.1:\d+ is not declared local/.test(gateStop.out),
    `a run against an endpoint not declared local stops before claiming, naming the rule (exit ${gateStop.code})`);
  const gateAccept = await gated("--accept-failed");
  assert(gateAccept.code === 2 && !/Nothing would be re-embedded/.test(gateAccept.out) && /needs the rows to accept, by id/.test(gateAccept.out),
    "…while --accept-failed, which dials nothing, passes the gate and reaches its own refusal");
  // With a key, so the run passes argument parsing and reaches the gate before
  // its own refusal (third review pass: keyless, it exited before either).
  const gateRetire = await gated("--retire", "reembed:nonexistent@1024");
  assert(gateRetire.code === 2 && !/Nothing would be re-embedded/.test(gateRetire.out) && /Refusing --retire reembed:nonexistent@1024/.test(gateRetire.out) && /Nothing was written/.test(gateRetire.out),
    `…as does --retire, which reaches its own refusal past the gate (exit ${gateRetire.code}: ${gateRetire.out.split("\n").filter(Boolean).slice(-1)[0]?.trim().slice(0, 120)})`);
  const notFailed = await reembed("--accept-failed", poisonId, lateId);
  assert(notFailed.code === 2 && notFailed.out.includes(`not a failed row under reembed:test: ${lateId} (succeeded)`) && (await claimCounts()).failed === 3,
    `…an id whose row is not failed refuses the whole command, and nothing is written (exit ${notFailed.code})`);
  const combined = await reembed("--accept-failed", poisonId, "--retry-failed");
  assert(combined.code === 2 && /do not combine/.test(combined.out), "…and it does not combine with a run's flags");
  const stray = await reembed("--accept-failed", poisonId, "--dry-run", lateId);
  assert(stray.code === 2 && /not understood: /.test(stray.out) && stray.out.includes(lateId), "…and an id after another flag is refused rather than dropped");
  const twice = await reembed("--accept-failed", poisonId, "--accept-failed", lateId);
  assert(twice.code === 2 && /--accept-failed is given twice/.test(twice.out), "…as is the flag given twice, whose second list would otherwise be dropped");
  const jobless = await reembedIn({}, "--job", "--switch-model");
  assert(jobless.code === 2 && /--job needs a value/.test(jobless.out) && (await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = '--switch-model'`)[0].c === 0,
    `a flag that takes a value followed by another flag is refused, not read as the value — no pass runs under the key "--switch-model" (exit ${jobless.code})`);
  // A thought written since the attempt read it, not at the target: the
  // acceptance would be void as written, so it is refused and --retry-failed
  // named; a thought AT the target (the worker wrote its head window before
  // the row failed) is accepted whatever its timestamps.
  await sql`SELECT update_thought((SELECT id FROM thoughts WHERE content = ${poisonText}), NULL::text, ${{ edited: true }}::jsonb)`;
  const editedSince = await reembed("--accept-failed", poisonId);
  assert(editedSince.code === 2 && /written since the attempt read it/.test(editedSince.out) && /--retry-failed tries the new content/.test(editedSince.out) && (await claimCounts()).failed === 3,
    `a failed row whose thought was written since the attempt read it is refused — the content the provider refused is not the row's now (exit ${editedSince.code})`);
  const [{ id: throttledId }] = await sql`SELECT id::text AS id FROM thoughts WHERE content = ${throttledDoc}`;
  const atTargetDry = await reembed("--dry-run", "--accept-failed", throttledId);
  assert(atTargetDry.code === 0 && /would: accept 1 failed row\(s\)/.test(atTargetDry.out),
    `…while a failed row whose thought is at the target — its head window written by the worker before it failed — can be accepted whatever its timestamps (exit ${atTargetDry.code})`);
  // A fresh attempt would stamp claimed_at past the edit; stamped by hand here,
  // since the stub still refuses the text and a retry would change the flow.
  await sql`UPDATE thought_work_claims SET claimed_at = now() WHERE work_type = ${REEMBED_JOB} AND thought_id = ${poisonId}::uuid`;
  // A failed row whose thought has no vector: nothing to keep, and an accepted
  // row would be the last thing to say the thought is invisible to search.
  const vectorless = "refused, and never embedded";
  const [{ r: vectorlessRow }] = await sql`SELECT upsert_thought(${vectorless}, ${{ metadata: {} }}::jsonb, NULL::vector) AS r`;
  const vectorlessId = (vectorlessRow as { id: string }).id;
  await sql`SELECT enqueue_thoughts(${REEMBED_JOB}, ARRAY[${vectorlessId}::uuid])`;
  await sql`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${REEMBED_JOB} AND thought_id = ${vectorlessId}::uuid`;
  const noVector = await reembed("--accept-failed", vectorlessId);
  assert(noVector.code === 2 && /no vector to keep/.test(noVector.out) && (await claimCounts()).failed === 4,
    `a failed row whose thought has no vector is refused — acceptance keeps a vector, and a thought with none would vanish from search with nothing to say so (exit ${noVector.code})`);
  const allDry = await reembed("--dry-run", "--accept-failed", "--all");
  assert(allDry.code === 0 && /would: accept 3 failed row\(s\)/.test(allDry.out) && /1 failed row\(s\) were not accepted — a thought with no vector has nothing to keep/.test(allDry.out) && allDry.out.includes(`${vectorlessId}  (no vector)`),
    `…and --all passes over it, saying so (exit ${allDry.code})`);
  await sql`DELETE FROM thoughts WHERE id = ${vectorlessId}::uuid`;
  const allAndIds = await reembed("--accept-failed", "--all", poisonId);
  assert(allAndIds.code === 2 && /not understood: /.test(allAndIds.out) && allAndIds.out.includes(poisonId) && (await claimCounts()).failed === 3,
    `…nor does --all take ids beside it — an id after it is a stray argument, refused (exit ${allAndIds.code})`);
  const idsAndAll = await reembed("--accept-failed", poisonId, "--all");
  assert(idsAndAll.code === 2 && /--all takes no ids beside it/.test(idsAndAll.out) && (await claimCounts()).failed === 3,
    `…and ids before it are refused too — one or the other, never a list read silently as either (exit ${idsAndAll.code})`);
  const [{ fin: failedAt }] = await sql`SELECT finished_at::text AS fin FROM thought_work_claims WHERE work_type = ${REEMBED_JOB} AND thought_id = ${poisonId}::uuid`;
  const acceptDry = await reembed("--dry-run", "--accept-failed", poisonId);
  assert(acceptDry.code === 0 && /would: accept 1 failed row\(s\) under reembed:test/.test(acceptDry.out) && /Nothing was written/.test(acceptDry.out) && (await claimCounts()).failed === 3,
    `--dry-run --accept-failed says what it would accept and writes nothing (exit ${acceptDry.code})`);
  const accepted = await reembed("--accept-failed", poisonId);
  assert(accepted.code === 0 && /1 failed row\(s\) accepted under reembed:test/.test(accepted.out) && /kept the vector it had; accepted by the operator: .*stub: refused this text/.test(accepted.out),
    `--accept-failed marks the poisoned row succeeded with the caveat naming the failure (exit ${accepted.code})`);
  assert(/37 succeeded \(2 with a caveat, 1 accepted by the operator\), 2 failed/.test(accepted.out), `…and the counts say so, the accepted row inside the caveat count (${accepted.out.split("\n").find((l) => /status:/.test(l))?.trim()})`);
  const [acceptedRow] = await sql`SELECT status, last_error AS err, finished_at::text AS fin FROM thought_work_claims WHERE work_type = ${REEMBED_JOB} AND thought_id = ${poisonId}::uuid`;
  assert(acceptedRow?.status === "succeeded" && /^kept the vector it had; accepted by the operator: .*stub: refused this text/.test(acceptedRow?.err ?? ""), `…on the row itself (${acceptedRow?.status}: ${acceptedRow?.err})`);
  assert(acceptedRow?.fin === failedAt, "…with the failure's own finished_at kept, so the bound is measured from the refusal and not from the acceptance");
  const [{ e: keptVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${poisonText}`;
  assert(axisOf(keptVec) === 0, "…which keeps the vector it had");
  const acceptedStatus = await reembed("--status");
  assert(/2 succeeded row\(s\) carry a caveat/.test(acceptedStatus.out) && /accepted by the operator/.test(acceptedStatus.out) && /--retry-fallbacks/.test(acceptedStatus.out),
    "--status lists the accepted row among the caveats, with --retry-fallbacks as the way back");
  // The bound is claimed_at — when the attempt read the content — and not the
  // release: with the claim dated before the thought's last write, the
  // acceptance no longer stands and the counts drop it (second review pass).
  await sql`UPDATE thought_work_claims SET claimed_at = claimed_at - interval '1 day' WHERE work_type = ${REEMBED_JOB} AND thought_id = ${poisonId}::uuid`;
  const movedBound = await reembed("--status");
  const movedLine = movedBound.out.split("\n").find((l) => /status:/.test(l)) ?? "";
  assert(/37 succeeded \(2 with a caveat\), 2 failed/.test(movedLine) && !/accepted/.test(movedLine),
    `the acceptance stands from claimed_at, the attempt's read, not from the release: dated before the thought's last write it no longer counts (${movedLine.trim()})`);
  await sql`UPDATE thought_work_claims SET claimed_at = claimed_at + interval '1 day' WHERE work_type = ${REEMBED_JOB} AND thought_id = ${poisonId}::uuid`;
  const acceptedAgain = await reembed("--accept-failed", poisonId);
  assert(acceptedAgain.code === 2 && /\(succeeded\)/.test(acceptedAgain.out), "accepting it twice refuses: it is no longer a failed row");
  const dryFallbacks2 = await reembed("--dry-run", "--retry-fallbacks");
  assert(/return 2 rows succeeded with a caveat to the pool/.test(dryFallbacks2.out) && /over 2 rows/.test(dryFallbacks2.out), "…and --dry-run --retry-fallbacks counts it as a caveat it would return");

  poison = false;
  const retried = await reembed("--retry-failed");
  assert(retried.code === 0 && /2 re-embedded, 0 failed/.test(retried.out), `--retry-failed re-embeds the two failed rows once the provider recovers, and does not see the accepted one (exit ${retried.code})`);
  const [{ e: throttledVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${throttledDoc}`;
  assert(axisOf(throttledVec) === axisFor(throttledDoc), "…and the throttled long thought now carries its whole-content vector");
  const [{ e: tarpitVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${tarpitText}`;
  assert(axisOf(tarpitVec) === axisFor(tarpitText), "…as does the tarpit, answered this time");
  assert(/2 succeeded row\(s\) carry a caveat/.test(retried.out), "…while the refused one and the accepted one are still listed — --retry-failed does not touch a succeeded row");
  const [{ e: poisonVec, attempts: throttledAttempts }] = await sql`
    SELECT (SELECT embedding::text FROM thoughts WHERE content = ${poisonText}) AS e, c.attempt_count AS attempts FROM thoughts t
    JOIN thought_work_claims c ON c.thought_id = t.id AND c.work_type = ${REEMBED_JOB} WHERE t.content = ${throttledDoc}`;
  assert(axisOf(poisonVec) === 0, "…and the accepted row keeps the vector it had");
  assert(Number(throttledAttempts) === 1, `…while a retried row is on what counts as its first attempt: --retry-failed reset the count (${throttledAttempts})`);
  const final = await claimCounts();
  assert(final.succeeded === 39 && !final.failed, `every row is succeeded (${JSON.stringify(final)})`);

  // The provider's limit "changes": the refused long thought is asked again
  // through --retry-fallbacks, gets its whole-content vector, and the caveat
  // goes with it. A run without the flag would have had nothing to do.
  refusing = false;
  const fallbacks = await reembed("--retry-fallbacks");
  assert(fallbacks.code === 0 && /--retry-fallbacks: 2 row\(s\)/.test(fallbacks.out) && /2 re-embedded, 0 failed/.test(fallbacks.out),
    `--retry-fallbacks returns the refused row and the accepted one to the pool and re-embeds both (exit ${fallbacks.code})`);
  const [{ e: poisonNow, attempts: poisonAttempts, err: poisonErr }] = await sql`
    SELECT t.embedding::text AS e, c.attempt_count AS attempts, c.last_error AS err FROM thoughts t
    JOIN thought_work_claims c ON c.thought_id = t.id AND c.work_type = ${REEMBED_JOB} WHERE t.content = ${poisonText}`;
  assert(axisOf(poisonNow) === axisFor(poisonText) && poisonErr === null, `…the accepted row, asked again once the provider relented, carries its own vector and no caveat (${poisonErr})`);
  assert(Number(poisonAttempts) === 1, `…on what counts as its first attempt: the acceptance is spent (${poisonAttempts})`);
  const [{ e: long3Vec, err: long3Err, status: long3Status }] = await sql`
    SELECT t.embedding::text AS e, c.last_error AS err, c.status FROM thoughts t
    JOIN thought_work_claims c ON c.thought_id = t.id AND c.work_type = ${REEMBED_JOB} WHERE t.content = ${long3}`;
  assert(axisOf(long3Vec) === axisFor(long3), "…it now carries its whole-content vector");
  assert(long3Status === "succeeded" && long3Err === null, `…succeeded with no caveat left (${long3Status}, ${long3Err})`);
  assert(!/carry a caveat/.test(fallbacks.out) && /39 succeeded, 0 failed/.test(fallbacks.out), "…and nothing is listed as a fallback any more");

  // A lease held by some other process: this run must not report the pass done.
  const held = "held by another process";
  await sql`SELECT upsert_thought(${held}, ${{ metadata: {} }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT enqueue_thoughts(${REEMBED_JOB})`;
  const ghost = await sql`SELECT thought_id FROM claim_thoughts(${REEMBED_JOB}, 'ghost', 1)`;
  assert(ghost.length === 1, "another process holds the one pending row");
  {
    const pf = await preflight();
    assert(PASS_LINE.exec(pf.out)?.[1] === "40 thoughts — 39 succeeded, 0 failed, 1 in flight, 0 pending, 0 not yet in the pool",
      `preflight reports the lease another process holds as unfinished work (${PASS_LINE.exec(pf.out)?.[1] ?? "no re-embed pass line"})`);
  }
  const ghostStatus = await reembed("--status");
  assert(/held by ghost: 1 rows, earliest lease deadline \d{4}-\d\d-\d\d [^\n]*release_claims_for_worker/.test(ghostStatus.out),
    "--status names the holder, its rows, its deadline and the remedy for a dead one");
  const blocked = await reembed();
  assert(blocked.code === 1 && /1 row\(s\) are still leased/.test(blocked.out) && /--status/.test(blocked.out) && /release_claims_for_worker/.test(blocked.out),
    `a run that finds only another process's lease exits 1, says so, and names --status and the remedy (exit ${blocked.code})`);
  const [{ e: heldVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${held}`;
  assert(axisOf(heldVec) === 0, "…and did not touch the held row");
  await sql`SELECT release_claims_for_worker(${REEMBED_JOB}, 'ghost')`;
  const finish = await reembed();
  assert(finish.code === 0 && /1 re-embedded, 0 failed/.test(finish.out), `once the lease is returned a run finishes the row and exits 0 (exit ${finish.code})`);
  assert(!/preflight will warn/.test(finish.out), "…and no longer says preflight will warn");
  {
    const pf = await preflight();
    assert(pf.code === 0 && /re-embed pass\s+none unfinished/.test(pf.out) && !PASS_LINE.test(pf.out), "preflight reports no unfinished pass once every row is terminal without failure");
  }
  const noop = await reembed();
  assert(noop.code === 0 && /Nothing to do/.test(noop.out), "a further run has nothing to do and exits 0");

  // The rows say which model they are at (migration 021) — the state change 35
  // could only describe at the end of a run: a server still on the old model
  // re-captures one text and captures a new one AFTER the pass finished. Their
  // rows say old-model; preflight sees it from the rows with nothing in the
  // claim table to say so. Under the model's OWN key a plain run pools exactly
  // the rows not at the model and re-embeds those two; a capture the switched
  // server made is at the target and is never pooled. The suite's key,
  // `reembed:test`, names no model and is a backfill: it pools every thought
  // without a row, as every pass did before 021 (first review pass — a
  // backfill under a --job key had pooled nothing), and the data rule returns
  // its finished row for the re-captured thought under either key.
  const DEFAULT_KEY = `reembed:stub-embed@${DIM}`;
  const reembedDefault = (...extra: string[]) => reembedIn({}, "--job", DEFAULT_KEY, ...extra);
  const labels = (await sql`SELECT embedding_model AS m FROM thoughts`) as { m: string | null }[];
  assert(labels.length === 40 && labels.every((r) => r.m === "stub-embed"), `every re-embedded row carries the model that produced its vector (${[...new Set(labels.map((r) => r.m))].join(", ")})`);
  // "hemlock": the stub refuses it while `poison` is set, below.
  const stale = "captured by a server still on the old model — the hemlock note, again";
  const fresh = "captured by the switched server";
  await sql`SELECT upsert_thought(${shorts[0]}, ${{ metadata: {}, embedding_model: "old-model" }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${stale}, ${{ metadata: {}, embedding_model: "old-model" }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${fresh}, ${{ metadata: {}, embedding_model: "stub-embed" }}::jsonb, ${unit(0)}::vector)`;
  const [{ m: relabelled }] = await sql`SELECT embedding_model AS m FROM thoughts WHERE content = ${shorts[0]}`;
  assert(relabelled === "old-model", "a re-capture with a vector takes the capturing server's label with it");
  {
    const pf = await preflight();
    assert(pf.code === 0 && /vector models\s+2 vector\(s\) at another model \(old-model: 2\) beside 40 at stub-embed — searches rank across the two/.test(pf.out),
      `preflight reports the two rows at the old model from the rows themselves (${pf.out.split("\n").find((l) => /vector models/.test(l))?.trim()})`);
    assert(/re-embed pass\s+none unfinished/.test(pf.out), "…while the claim table, which has a finished row for one of them and none for the other, says nothing");
    assert(/bun reembed\.ts --url \$DATABASE_URL — the pass takes exactly the rows not at stub-embed/.test(pf.out), "…and names the pass as the remedy");
  }
  const byModel = await reembedDefault("--status");
  assert(/corpus:\s+40 at stub-embed, 2 at another model \(old-model: 2\)/.test(byModel.out), `--status prints the corpus by model (${byModel.out.split("\n").find((l) => /corpus:/.test(l))?.trim()})`);
  assert(/42 thoughts — 0 succeeded, 0 failed, 0 in flight, 0 pending, 2 not yet in the pool/.test(byModel.out),
    `…and under the model's own key "not yet in the pool" is the two thoughts not at the model — the one at it is not counted (${byModel.out.split("\n").find((l) => /status:/.test(l))?.trim()})`);
  assert(/preflight will warn until they are re-embedded: 2 vector\(s\) at another model/.test(byModel.out), "…and --status says what preflight's vector models line will say meanwhile");
  const backfillStatus = await reembed("--status");
  assert(/42 thoughts — 40 succeeded, 0 failed, 0 in flight, 0 pending, 2 not yet in the pool/.test(backfillStatus.out),
    `…while under the suite's backfill key every thought without a row counts, the one at the model included (${backfillStatus.out.split("\n").find((l) => /status:/.test(l))?.trim()})`);
  const backfillDry = await reembed("--dry-run");
  assert(/return 1 succeeded row\(s\) whose thought is not at stub-embed to the pool; add 2 thoughts to the pool/.test(backfillDry.out) && /over 3 rows/.test(backfillDry.out),
    `…and a backfill run would return the finished row whose thought moved and pool both unpooled thoughts (${backfillDry.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  const dryData = await reembedDefault("--dry-run");
  assert(!/succeeded row\(s\) whose thought/.test(dryData.out) && /add 2 thoughts to the pool/.test(dryData.out) && /over 2 rows/.test(dryData.out),
    `--dry-run under the model's own key pools exactly the two rows not at it (${dryData.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  // One of the two is the poisoned text: the pass takes exactly the two rows
  // the old server wrote, re-embeds one and is refused the other — which then
  // keeps the old server's vector AND its label, since the label follows the
  // vector. That is the ticket's row under the model's own key (SMD-1067):
  // preflight warns from the claim row and from the label; the operator
  // accepts it; both readers treat the acceptance as the operator's word — the
  // data rule, which returns a finished row whose thought is not at the model,
  // stops at it, and `vector models` counts the vector as detail — until the
  // thought is written again, which reopens the question (021's evidence rule,
  // one rule for both readers).
  poison = true;
  const caught = await reembedDefault();
  assert(caught.code === 1 && /2 thought\(s\) added/.test(caught.out) && /1 re-embedded, 1 failed/.test(caught.out),
    `a plain run under the model's own key takes exactly the two rows the old server wrote — one re-embedded, one the provider refuses (exit ${caught.code}: ${caught.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  assert(!/nothing here can tell/.test(caught.out) && !/captured while the pass ran/.test(caught.out), "…and nothing is left to guess about");
  const moved = (await sql`SELECT content, embedding::text AS e, embedding_model AS m FROM thoughts WHERE content = ANY(${sql.array([shorts[0], stale, fresh], "TEXT")})`) as { content: string; e: string; m: string }[];
  const rowNamed = (c: string) => moved.find((r) => r.content === c)!;
  assert(axisOf(rowNamed(shorts[0]).e) === axisFor(shorts[0]) && rowNamed(shorts[0]).m === "stub-embed", "…the re-captured one carries the stub's vector for its own text and the target's label");
  assert(axisOf(rowNamed(stale).e) === 0 && rowNamed(stale).m === "old-model", "…while the refused one keeps the old server's vector and its label — the label follows the vector");
  assert(axisOf(rowNamed(fresh).e) === 0 && rowNamed(fresh).m === "stub-embed", "…and the switched server's capture, already at the target, was not touched");
  const [{ c: freshRows }] = await sql`SELECT count(*)::int AS c FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id WHERE t.content = ${fresh}`;
  assert(Number(freshRows) === 0, "…and never entered the pool");
  {
    const pf = await preflight();
    assert(new RegExp(`re-embed pass\\s+the pass to stub-embed @ ${DIM} has not finished: 42 thoughts — 1 succeeded, 1 failed, 0 in flight, 0 pending, 0 not yet in the pool`).test(pf.out) && /--accept-failed <thought-id…> for one the provider refuses permanently/.test(pf.out),
      `preflight reports the failed row under the model's own key, naming --accept-failed beside --retry-failed (${pf.out.split("\n").find((l) => /re-embed pass/.test(l))?.trim()})`);
    assert(/vector models\s+1 vector\(s\) at another model \(old-model: 1\) beside 41 at stub-embed/.test(pf.out), "…and the rows say one vector is still at the old model");
  }
  const [{ id: staleId }] = await sql`SELECT id::text AS id FROM thoughts WHERE content = ${stale}`;
  const acceptOwn = await reembedDefault("--accept-failed", staleId);
  assert(acceptOwn.code === 0 && /1 failed row\(s\) accepted under reembed:stub-embed@/.test(acceptOwn.out) && !/preflight will warn/.test(acceptOwn.out),
    `the operator accepts it under the model's own key, and the tool says preflight has nothing left to warn about (exit ${acceptOwn.code})`);
  assert(/corpus:\s+41 at stub-embed, 1 at another model \(old-model: 1\), 1 of them accepted by the operator/.test(acceptOwn.out),
    `…printing the corpus with the acceptance (${acceptOwn.out.split("\n").find((l) => /corpus:/.test(l))?.trim()})`);
  {
    const pf = await preflight();
    assert(pf.code === 0 && /re-embed pass\s+none unfinished/.test(pf.out), "preflight reports no unfinished pass — the row is succeeded, with the caveat");
    assert(/vector models\s+41 at stub-embed, 1 at another model accepted by the operator \(old-model: 1\)\s*$/m.test(pf.out) && !/vector\(s\) at another model/.test(pf.out),
      `…and the vector at the old model is detail, not a warning: the operator has spoken for it (${pf.out.split("\n").find((l) => /vector models/.test(l))?.trim()})`);
  }
  const leaves = await reembedDefault();
  assert(leaves.code === 0 && /Nothing to do/.test(leaves.out) && !/succeeded row\(s\) whose thought/.test(leaves.out),
    `a plain run under the model's own key leaves the accepted row — the data rule stops at the operator's word (exit ${leaves.code})`);
  // The old server saves metadata on it: an edit since the acceptance, and
  // the acceptance held only while nothing wrote the thought.
  await sql`SELECT update_thought((SELECT id FROM thoughts WHERE content = ${stale}), NULL::text, ${{ edited: true }}::jsonb)`;
  const reopened = await reembedDefault("--dry-run");
  assert(/return 1 succeeded row\(s\) whose thought is not at stub-embed to the pool/.test(reopened.out) && /over 1 rows/.test(reopened.out),
    `…until the thought is written again: an edit since the acceptance is a new question, and the row returns to the pool (${reopened.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  {
    const pf = await preflight();
    assert(/vector models\s+1 vector\(s\) at another model \(old-model: 1\) beside 41 at stub-embed/.test(pf.out), "…and preflight no longer counts the acceptance either — one evidence rule for both readers");
  }
  const reopenedStatus = await reembedDefault("--status");
  const reopenedLine = reopenedStatus.out.split("\n").find((l) => /status:/.test(l)) ?? "";
  assert(/2 succeeded \(1 with a caveat\), 0 failed/.test(reopenedLine) && !/accepted/.test(reopenedLine), `…and the counts call it a caveat, not an acceptance — one report, one account (${reopenedLine.trim()})`);
  poison = false;
  const relented = await reembedDefault();
  assert(relented.code === 0 && /1 succeeded row\(s\) whose thought is not at stub-embed returned to the pool/.test(relented.out) && /1 re-embedded, 0 failed/.test(relented.out),
    `…and a run once the provider relents re-embeds it (exit ${relented.code})`);
  const [{ m: staleLabel, e: staleVec }] = await sql`SELECT embedding_model AS m, embedding::text AS e FROM thoughts WHERE content = ${stale}`;
  assert(staleLabel === "stub-embed" && axisOf(staleVec) === axisFor(stale), "…which then carries the stub's vector for its own text and the target's label");
  {
    const pf = await preflight();
    assert(/vector models\s+42 at stub-embed\s*$/m.test(pf.out) && !/at another model/.test(pf.out), "preflight then sees the whole corpus at the model");
  }
  const noop2 = await reembedDefault();
  assert(noop2.code === 0 && /Nothing to do/.test(noop2.out), "a further run under the model's own key has nothing to do");
  // A finished row with no caveat whose thought is not at the model, with the
  // thought's updated_at not past the row's finished_at — the state a thought
  // edited between update_thought and release_thought leaves. The acceptance
  // test inside the data rule must be NULL-safe for a row with no caveat, or
  // this row is never returned (first review pass).
  await sql`ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at`;
  await sql`UPDATE thoughts SET embedding_model = 'old-model' WHERE content = ${stale}`;
  await sql`ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at`;
  const quietMove = await reembedDefault("--dry-run");
  assert(/return 1 succeeded row\(s\) whose thought is not at stub-embed to the pool/.test(quietMove.out),
    `a finished row without a caveat whose thought is not at the model returns whatever its timestamps say (${quietMove.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  await sql`ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at`;
  await sql`UPDATE thoughts SET embedding_model = 'stub-embed' WHERE content = ${stale}`;
  await sql`ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at`;

  // --retire (SMD-1067): the record of a superseded pass — a switch to
  // other-model that was abandoned — is removed by the tool, as the remedy
  // preflight now prints in place of the hand DELETE; the recorded model's
  // key, another tool's key, an empty key and a running pass are refused.
  const OTHER_KEY = `reembed:other-model@${DIM}`;
  await sql`SELECT enqueue_thoughts(${OTHER_KEY}, (SELECT array_agg(id) FROM (SELECT id FROM thoughts ORDER BY created_at LIMIT 2) s))`;
  {
    const pf = await preflight();
    assert(new RegExp(`re-embed pass\\s+${OTHER_KEY}: 42 thoughts — 0 succeeded, 0 failed, 0 in flight, 2 pending, 40 not yet in the pool — a pass to other-model @ ${DIM}, which is no longer the recorded model`).test(pf.out) && pf.out.includes(`retire its record: cd db && bun reembed.ts --url $DATABASE_URL --retire ${OTHER_KEY}`) && !/DELETE FROM/.test(pf.out),
      `preflight reports the abandoned switch with --retire as its remedy, not a hand DELETE (${pf.out.split("\n").find((l) => /re-embed pass/.test(l))?.trim()})`);
  }
  const retireOwn = await reembed("--retire", DEFAULT_KEY);
  assert(retireOwn.code === 2 && /names the recorded model/.test(retireOwn.out) && /--accept-failed/.test(retireOwn.out), `--retire refuses the recorded model's own key: its pass can be finished, or its failed rows accepted (exit ${retireOwn.code})`);
  const retireForeign = await reembed("--retire", "extract:entities");
  assert(retireForeign.code === 2 && /another tool's pass/.test(retireForeign.out), "…a key without the reembed: prefix, which is another tool's");
  const retireEmpty = await reembed("--retire", `reembed:nobody@${DIM}`);
  assert(retireEmpty.code === 2 && /nothing to retire/.test(retireEmpty.out), "…and a key with no rows — a typo is the likelier cause");
  // No width recorded (a hand-applied schema): the column's width stands in,
  // in both tools, so a key at another width has a remedy that runs.
  const WIDE_KEY = `reembed:stub-embed@${DIM + 1}`;
  await sql`SELECT enqueue_thoughts(${WIDE_KEY}, (SELECT array_agg(id) FROM (SELECT id FROM thoughts ORDER BY created_at LIMIT 1) s))`;
  await sql`DELETE FROM ob1_config WHERE key = 'embedding_dim'`;
  {
    const pf = await preflight();
    assert(new RegExp(`${WIDE_KEY}: 42 thoughts — .* a pass to stub-embed at ${DIM + 1} dimensions, where the column and the record are ${DIM}`).test(pf.out) && pf.out.includes(`--retire ${WIDE_KEY}`),
      `with no width recorded, a key at another width is still one nothing can finish, with --retire as the remedy (${pf.out.split("\n").find((l) => /re-embed pass/.test(l))?.trim()})`);
  }
  const retireWide = await reembed("--retire", WIDE_KEY);
  assert(retireWide.code === 0 && /1 row\(s\) removed/.test(retireWide.out), `…and --retire takes it, judging the width by the column's (exit ${retireWide.code})`);
  await sql`INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', ${String(DIM)})`;
  // No model recorded: this shell's own key is still not retireable — a record
  // deleted by hand does not make a running pass a superseded one.
  // A record that disagrees with the column (a hand edit): the column is the
  // width authority, so the one finishable key is still not retireable.
  await sql`UPDATE ob1_config SET value = ${String(DIM + 1)} WHERE key = 'embedding_dim'`;
  const retireWrongRecord = await reembed("--retire", DEFAULT_KEY);
  assert(retireWrongRecord.code === 2 && /names the recorded model/.test(retireWrongRecord.out), `…and a record that disagrees with the column does not make the column-width key superseded (exit ${retireWrongRecord.code})`);
  await sql`UPDATE ob1_config SET value = ${String(DIM)} WHERE key = 'embedding_dim'`;
  await sql`DELETE FROM ob1_config WHERE key = 'embedding_model'`;
  const retireOwnNoRecord = await reembed("--retire", DEFAULT_KEY);
  assert(retireOwnNoRecord.code === 2 && /names the configured model/.test(retireOwnNoRecord.out), `…while with no model recorded this shell's own key is refused as the configured model's (exit ${retireOwnNoRecord.code})`);
  await sql`INSERT INTO ob1_config (key, value) VALUES ('embedding_model', 'stub-embed')`;
  const retireDry = await reembed("--dry-run", "--retire", REEMBED_JOB);
  assert(retireDry.code === 0 && /would: retire reembed:test — remove its \d+ row\(s\) \(\d+ succeeded\)/.test(retireDry.out) && (await claimCounts()).succeeded > 0,
    `--dry-run --retire says what it would remove — a key naming no model is retireable — and removes nothing (exit ${retireDry.code})`);
  await sql`SELECT claim_thoughts(${OTHER_KEY}, 'other-worker', 1)`;
  const retireLive = await reembed("--retire", OTHER_KEY);
  assert(retireLive.code === 2 && /leased right now/.test(retireLive.out), `…and a key with a live lease: a pass under it is running (exit ${retireLive.code})`);
  await sql`SELECT release_claims_for_worker(${OTHER_KEY}, 'other-worker')`;
  // From the shell that ran the abandoned switch — still configured for
  // other-model: the record, not this shell, says which model is current.
  const retired = await reembedIn({ OB1_EMBEDDING_MODEL: "other-model" }, "--retire", OTHER_KEY);
  assert(retired.code === 0 && new RegExp(`retired ${OTHER_KEY}: 2 row\\(s\\) removed \\(2 pending\\)`).test(retired.out) && /wrote no vector/.test(retired.out) && /corpus:\s+42 at stub-embed\s*$/m.test(retired.out),
    `--retire removes the superseded key's rows, from the shell that ran that switch, and reports the corpus against the recorded model — not this shell's (exit ${retired.code}: ${retired.out.split("\n").find((l) => /corpus:/.test(l))?.trim()})`);
  const [{ c: otherLeft }] = await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = ${OTHER_KEY}`;
  assert(Number(otherLeft) === 0, "…leaving nothing under it");
  {
    const pf = await preflight();
    assert(/re-embed pass\s+none unfinished/.test(pf.out), "…and preflight has nothing left to report");
  }

  // The model's own key on a model change: the start-over returns failed rows
  // and expired leases only, and the data rule the finished rows whose
  // thought is not at the target — here two rows relabelled to the old model
  // with the record moved back, as a real switch back leaves them. Under the
  // suite's backfill key (below) every terminal row returns instead; without
  // this block the narrow rule was never exercised (fifth review pass).
  await sql`UPDATE ob1_config SET value = ${recordedModel} WHERE key = 'embedding_model'`;
  await sql`UPDATE thoughts SET embedding_model = ${recordedModel} WHERE content = ANY(${sql.array([shorts[0], stale], "TEXT")})`;
  const ownDry = await reembedDefault("--dry-run");
  assert(/would: refuse without --switch-model; with it: record stub-embed in ob1_config; return 2 succeeded row\(s\) whose thought is not at stub-embed to the pool; add 0 thoughts to the pool/.test(ownDry.out) && !/start this pass over/.test(ownDry.out) && /over 2 rows/.test(ownDry.out),
    `under the model's own key a switch back returns only the finished rows whose thought is not at the model — no start-over of the rest (${ownDry.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  const own = await reembedDefault("--switch-model");
  assert(own.code === 0 && /2 succeeded row\(s\) whose thought is not at stub-embed returned to the pool/.test(own.out) && !/starts over/.test(own.out) && /2 re-embedded, 0 failed/.test(own.out),
    `…and the run re-embeds exactly those two (exit ${own.code}: ${own.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  const [{ m: ownLabel }] = await sql`SELECT embedding_model AS m FROM thoughts WHERE content = ${stale}`;
  assert(ownLabel === "stub-embed", "…which carry the target's label again");

  // Switching back to a model used before. The key holds a finished pass's
  // terminal row for every thought, and enqueue_thoughts skips them by primary
  // key — so until SMD-1024 a --switch-model to this model enqueued nothing and
  // reported nothing to do while every vector was the other model's. A model
  // change starts THIS pass over. Another key of the same model — here a
  // backfill key with one finished row — is left as it is: once this pass has
  // finished the corpus is at the model again, which is what that row says,
  // and returning it too would only demand a second pass (second review pass).
  // One row is left as a dead worker of the earlier pass would leave it —
  // claimed, lease long expired, attempts used up — and must be restarted too,
  // not reaped as failed for the earlier pass's reason (first review pass).
  // Since 021 the start-over returns only that row and any failed ones: the
  // succeeded rows are the data rule's, returned because the rows say the
  // corpus is at the other model — here made so, as a real switch back would
  // leave it — and not re-embedded on a record moved by hand alone (021's
  // first review pass: every succeeded row was returned regardless).
  const CTX_KEY = `reembed:stub-embed@${DIM}:ctx`;
  await sql`SELECT enqueue_thoughts(${CTX_KEY}, (SELECT array_agg(id) FROM (SELECT id FROM thoughts ORDER BY created_at LIMIT 1) s))`;
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${CTX_KEY}`;
  await sql`
    UPDATE thought_work_claims SET status = 'claimed', finished_at = NULL, ttl_expires_at = now() - interval '1 minute', attempt_count = 3, worker_id = 'dead'
    WHERE work_type = ${REEMBED_JOB} AND thought_id = (SELECT id FROM thoughts WHERE content = ${held})`;
  await sql`UPDATE ob1_config SET value = ${recordedModel} WHERE key = 'embedding_model'`;
  const recordOnly = await reembed("--dry-run");
  assert(/start this pass over \(40 terminal row\(s\) or expired lease\(s\) from before the change return to the pool\)/.test(recordOnly.out) && !/succeeded row\(s\) whose thought/.test(recordOnly.out) && /over 42 rows/.test(recordOnly.out),
    `under the suite's backfill key a model change starts the pass over whatever the rows say — the key cannot judge by label, since 021 labels nothing from a key naming no model (${recordOnly.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  await sql`UPDATE thoughts SET embedding_model = ${recordedModel}`;
  const backDry = await reembed("--dry-run");
  assert(backDry.code === 0 && /would: refuse without --switch-model; with it: record stub-embed in ob1_config; start this pass over \(40 terminal row\(s\) or expired lease\(s\) from before the change return to the pool\); add 2 thoughts to the pool/.test(backDry.out) && /over 42 rows/.test(backDry.out),
    `--dry-run of a switch back with the rows moved too says every terminal row and the dead lease restart, and the unpooled thoughts are added (${backDry.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  const back = await reembed("--switch-model");
  assert(back.code === 0 && /model change: this pass starts over — 40 terminal row\(s\) or expired lease\(s\) from before the change returned to the pool/.test(back.out) && !/succeeded row\(s\) whose thought/.test(back.out) && /42 re-embedded, 0 failed/.test(back.out),
    `…and the run re-embeds every thought rather than finding nothing to do (exit ${back.code}: ${back.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  const backCounts = await claimCounts();
  assert(backCounts.succeeded === 42 && Object.keys(backCounts).length === 1, `…leaving every row succeeded again, the expired lease and the two pooled thoughts included (${JSON.stringify(backCounts)})`);
  const [{ deadAttempts }] = await sql`
    SELECT attempt_count AS "deadAttempts" FROM thought_work_claims WHERE work_type = ${REEMBED_JOB} AND thought_id = (SELECT id FROM thoughts WHERE content = ${held})`;
  assert(Number(deadAttempts) === 1, `…the dead worker's row on what counts as its first attempt (${deadAttempts})`);
  const [{ ctxStatus }] = await sql`SELECT status AS "ctxStatus" FROM thought_work_claims WHERE work_type = ${CTX_KEY}`;
  assert(ctxStatus === "succeeded", `…and the backfill key's finished row untouched (${ctxStatus})`);
  {
    const pf = await preflight();
    assert(/re-embed pass\s+none unfinished/.test(pf.out), "…so preflight has nothing to report once the pass is done");
  }
  await sql`DELETE FROM thought_work_claims WHERE work_type = ${CTX_KEY}`;

  // The heartbeat end to end (migration 031): a batch whose work outlasts the
  // lease, under workers that beat. Every embedding takes 600 ms, sixteen per
  // claim, a 6 s lease with a 1 s heartbeat: a batch runs near ten seconds,
  // and until 031 its lease expired mid-way — the rows went to the other
  // worker on their second attempt, the first's releases returned false, and
  // three such batches marked rows failed. Six seconds, not three, because a
  // runner that pauses the process for two seconds must not read as a lapse —
  // a beat is missed only when the process is, and the lease covers five — and
  // sixteen, not eight, because eight rows fit inside six seconds and the run
  // would then pass with renewal a no-op (third review pass). A fresh backfill
  // key, so the pool is every thought; the recorded model is the configured
  // one here.
  slowMs = 600;
  const SLOW_KEY = `reembed:stub-embed@${DIM}:slow`;
  const slow = await reembed("--job", SLOW_KEY, "--workers", "2", "--batch", "16", "--ttl", "6", "--heartbeat", "1");
  slowMs = 0;
  assert(slow.code === 0 && /42 re-embedded, 0 failed/.test(slow.out) && /16 per claim, 6 s leases renewed every 1 s/.test(slow.out),
    `two workers re-embed every thought in batches that outlast the lease, and nothing is repeated (exit ${slow.code}: ${slow.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  assert(!/attempt 2/.test(slow.out) && !/no longer this worker's at release/.test(slow.out) && !/no longer this worker's/.test(slow.out) && !/heartbeat failed/.test(slow.out),
    "…no row reached a second worker, no release found its lease gone, none was lost, every beat answered");
  const slowBeats = Number(/, (\d+) heartbeat\(s\)/.exec(slow.out)?.[1] ?? 0);
  assert(slowBeats >= 10, `…and the summary counts the beats that kept them — two workers, one a second, over some fifteen seconds (${slowBeats})`);
  const slowRows = (await sql`SELECT status, attempt_count::int AS attempts FROM thought_work_claims WHERE work_type = ${SLOW_KEY}`) as { status: string; attempts: number }[];
  assert(slowRows.length === 42 && slowRows.every((r) => r.status === "succeeded" && r.attempts === 1),
    `…and every claim row succeeded on its first attempt (${slowRows.filter((r) => r.attempts !== 1 || r.status !== "succeeded").length} otherwise)`);
  await sql`DELETE FROM thought_work_claims WHERE work_type = ${SLOW_KEY}`;

  // A lease taken from under a running worker: the batch a one-worker run
  // holds is re-assigned by hand to a holder whose lease is far ahead — what
  // another worker's claim after a reap does to it. The row in hand learns it at
  // release; the rest at a beat or at their release (which, depends on the
  // 1 s beat against 610 ms rows, and is not asserted). Every stolen row is
  // counted lost and none finished, the worker finishes the rest, and the run
  // says the rows are still leased; --status names the thief.
  slowMs = 600;
  const THIEF_KEY = `reembed:stub-embed@${DIM}:thief`;
  const thiefRun = reembed("--job", THIEF_KEY, "--workers", "1", "--batch", "4", "--ttl", "6", "--heartbeat", "1");
  let stolen: { thought_id: string }[] = [];
  for (let i = 0; i < 100 && stolen.length === 0; i++) {
    await Bun.sleep(100);
    // The thief beats too, in effect: a deadline far ahead, or the worker's own
    // next claim would reap the rows back after 6 s and finish them itself.
    stolen = (await sql`UPDATE thought_work_claims SET worker_id = 'thief', ttl_expires_at = now() + interval '10 minutes' WHERE work_type = ${THIEF_KEY} AND status = 'claimed' RETURNING thought_id`) as { thought_id: string }[];
  }
  const theft = await thiefRun;
  slowMs = 0;
  assert(stolen.length >= 1 && stolen.length <= 4, `the thief takes the batch a running worker holds (${stolen.length} rows)`);
  assert(theft.code === 1 && new RegExp(`${42 - stolen.length} re-embedded, 0 failed, 0 deleted mid-pass, ${stolen.length} no longer this worker's when checked`).test(theft.out) && new RegExp(`${stolen.length} row\\(s\\) are still leased`).test(theft.out),
    `…the worker finishes the rest, counts exactly the stolen rows as no longer its own, none as finished, and exits 1 naming them as still leased (exit ${theft.code}: ${theft.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  assert(/no longer this worker's at release — its lease lapsed/.test(theft.out), "…the row in hand learns it at release, and the line names what it can know");
  const thiefStatus = await reembed("--status", "--job", THIEF_KEY);
  assert(new RegExp(`held by thief: ${stolen.length} rows`).test(thiefStatus.out), "…and --status names the thief");
  const [{ thiefRows }] = await sql`SELECT count(*)::int AS "thiefRows" FROM thought_work_claims WHERE work_type = ${THIEF_KEY} AND status = 'claimed' AND worker_id = 'thief'`;
  assert(Number(thiefRows) === stolen.length, `…whose rows stay claimed under its name, untouched by the worker's finally (${thiefRows})`);
  await sql`SELECT release_claims_for_worker(${THIEF_KEY}, 'thief')`;
  await sql`DELETE FROM thought_work_claims WHERE work_type = ${THIEF_KEY}`;

  provider.stop(true);
  await sql`UPDATE ob1_config SET value = ${recordedModel} WHERE key = 'embedding_model'`;
  await sql`DELETE FROM thoughts`;
}

// ── 10. db/extract-entities.ts — the second consumer, end to end ─────────────
//
// A stub model answers from a table keyed by a word in each thought, so the
// expected graph is known exactly; one thought gets prose instead of JSON to
// exercise the failed path. The worker authenticates with a minted key, so the
// rows carry a stable agent id. Then the four things SMD-947 asks to verify:
// a second run writes nothing, an edit re-extracts and the stale entity goes,
// a delete leaves no edge citing the thought, and the cost is recorded.

console.log("\n[10] db/extract-entities.ts: extraction through the claims, against a stub model");
{
  await sql`DELETE FROM thoughts`;
  await sql`DELETE FROM ob1_config WHERE key = 'entity_extraction_key'`;
  const KEY = "extract:stub-meta@p2";
  const answers: Record<string, { entities: unknown[]; relationships: unknown[] }> = {
    // Every window of the long thought below names this pair (SMD-1879): the
    // merge and the database must make ONE entity and ONE mention of them.
    ledger: {
      entities: [{ name: "Anita", type: "person", confidence: 0.9 }, { name: "Ledger", type: "project", confidence: 0.8 }],
      relationships: [{ from: "Anita", to: "Ledger", relation: "works_on", confidence: 0.8 }],
    },
    migrated: {
      entities: [
        { name: "Anita", type: "person", confidence: 0.9 },
        { name: "Open Brain", type: "project", confidence: 0.9 },
        { name: "PostgreSQL", type: "tool", confidence: 0.95, aliases: ["Postgres"] },
      ],
      relationships: [
        { from: "Anita", to: "Open Brain", relation: "works_on", confidence: 0.8 },
        { from: "Open Brain", to: "PostgreSQL", relation: "uses", confidence: 0.9 },
      ],
    },
    paired: {
      entities: [
        { name: "Dev", type: "person", confidence: 0.9 },
        { name: "Anita", type: "person", confidence: 0.9 },
        { name: "Open Brain", type: "project", confidence: 0.8 },
      ],
      relationships: [
        { from: "Dev", to: "Open Brain", relation: "works_on", confidence: 0.8 },
        { from: "Anita", to: "Open Brain", relation: "works_on", confidence: 0.8 },
      ],
    },
    session: {
      entities: [{ name: "Priya", type: "person", confidence: 0.9 }, { name: "Redis", type: "tool", confidence: 0.9 }],
      relationships: [{ from: "Priya", to: "Redis", relation: "uses", confidence: 0.8 }],
    },
    memcached: {
      entities: [{ name: "Priya", type: "person", confidence: 0.9 }, { name: "Memcached", type: "tool", confidence: 0.9 }],
      relationships: [{ from: "Priya", to: "Memcached", relation: "uses", confidence: 0.8 }],
    },
    grafana: {
      entities: [{ name: "Sam", type: "person", confidence: 0.9 }, { name: "Grafana", type: "tool", confidence: 0.9 }],
      relationships: [],
    },
    observability: {
      entities: [{ name: "observability", type: "topic", confidence: 0.7 }],
      relationships: [],
    },
  };
  let calls = 0;
  let ledgerCalls = 0;
  let hemlockIsProse = true;
  // While set, every answer takes this long: the first run, so the heartbeat
  // (migration 031) has time to beat.
  let slowMs = 0;
  const model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: { role: string; content: string }[]; model?: string };
      calls++;
      // The thought is the user message; the rules are the system message.
      const prompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
      await Bun.sleep(5 + slowMs);
      if (hemlockIsProse && /hemlock/.test(prompt)) {
        return Response.json({ choices: [{ message: { content: "I'm sorry, I can't help with that." } }] });
      }
      const key = Object.keys(answers).find((k) => prompt.includes(k));
      if (key === "ledger") ledgerCalls++;
      const answer = key ? answers[key] : { entities: [], relationships: [] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], model: body.model });
    },
  });

  const seed = async (content: string) =>
    ((await sql`SELECT upsert_thought(${content}, ${{ metadata: {} }}::jsonb) AS r`)[0].r as { id: string }).id;
  const t1 = await seed("Anita migrated Open Brain to PostgreSQL 16 last week.");
  const t2 = await seed("Dev paired with Anita on the Open Brain search index.");
  const t3 = await seed("Priya prefers Redis for the session cache.");
  const poison = await seed("The hemlock note.");
  for (let i = 0; i < 6; i++) await seed(`Filler ${i} about observability dashboards.`);
  // A thought over the extraction window (SMD-1879): six paragraphs of ~130
  // estimated tokens, each naming the ledger, against OB1_EXTRACT_CHUNK_TOKENS=300
  // in the worker's environment below — three or more windows, every one of
  // which the stub answers with the same Anita and Ledger.
  const ledgerText = Array.from({ length: 6 }, (_, p) => `The ledger rewrite, part ${p}. ${Array.from({ length: 24 }, (__, i) => `Anita noted point ${p}.${i} about the ledger.`).join(" ")}`).join("\n\n");
  const ledger = await seed(ledgerText);
  assert((await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = ${KEY}`)[0].c === 0,
         "before the worker has ever run, captures enqueue nothing — the trigger waits for the key");

  const rawKey = "a".repeat(64);
  const { hashKey } = await import("../server-portable/auth.ts");
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: URL_,
    OB1_LLM_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    OB1_LLM_LOCAL: "1",
    OB1_METADATA_MODEL: "stub-meta",
    OB1_EXTRACT_CHUNK_TOKENS: "300",
    OB1_WORKER_KEY: rawKey,
    MCP_ACCESS_KEYS: `entity-worker:write:${hashKey(rawKey)}`,
  };
  const dumpPath = join(tmpdir(), `ob1-test-live-extract-${process.pid}.jsonl`);
  const extract = (...extra: string[]): Promise<{ code: number; out: string }> =>
    runScript(["bun", join(HERE, "extract-entities.ts"), "--url", URL_!, ...extra], { env: env as Record<string, string>, cwd: HERE });
  const graph = async () => (await sql`
    SELECT (SELECT count(*)::int FROM ob1_entities) AS entities,
           (SELECT count(*)::int FROM thought_entities) AS mentions,
           (SELECT count(*)::int FROM ob1_entity_edges) AS edges`)[0] as { entities: number; mentions: number; edges: number };
  const entityByName = async (n: string) => (await sql`SELECT id, name, aliases FROM ob1_entities WHERE normalized_name = normalize_entity_name(${n})`)[0];
  const claimCounts = async () =>
    Object.fromEntries((await sql`SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${KEY} GROUP BY status`)
      .map((r: { status: string; c: number }) => [r.status, Number(r.c)])) as Record<string, number>;

  const dry = await extract("--dry-run");
  assert(dry.code === 0 && /Nothing was written/.test(dry.out) && /add 11 thoughts to the pool/.test(dry.out),
         `--dry-run counts the eleven thoughts and writes nothing (exit ${dry.code}: ${dry.out.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)})`);
  assert(/window: thoughts over 300 estimated tokens are extracted in 300-token windows \(overlap 37\), from OB1_EXTRACT_CHUNK_TOKENS \(stub-meta's served context, which db\/config\.mjs's KNOWN_CHAT_MODEL_WINDOW does not list\)/.test(dry.out),
         "the banner states the window rule and where it came from — the sentence preflight prints (SMD-1879)");
  assert((await sql`SELECT count(*)::int AS c FROM ob1_config WHERE key = 'entity_extraction_key'`)[0].c === 0, "…including the key");
  assert((await sql`SELECT count(*)::int AS c FROM ob1_agents WHERE label = 'entity-worker'`)[0].c === 0, "…and it did not register the worker's agent either");
  const bareLimit = await extract("--limit");
  assert(bareLimit.code === 2 && /--limit needs a value/.test(bareLimit.out), "a bare --limit is refused rather than read as no limit");
  const shortLease = await extract("--ttl", "3", "--heartbeat", "2");
  assert(shortLease.code === 2 && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(shortLease.out), "a lease under two heartbeats is refused (migration 031)");
  const bigBatch = await extract("--dry-run", "--batch", "4", "--timeout", "300");
  assert(bigBatch.code === 0 && /Nothing was written/.test(bigBatch.out) && /900 s leases renewed every 60 s\. Nothing was written/.test(bigBatch.out),
    `…while a batch of four at a 300 s timeout, refused until 031 as able to outlive the lease, is not: the heartbeat sizes the lease now, and --dry-run says which (exit ${bigBatch.code})`);

  // A 6 s lease with a 1 s heartbeat, and 400 ms answers — ten thoughts across
  // two workers, some two seconds each — so the beats fire during the run, and
  // the summary counts them.
  slowMs = 400;
  const first = await extract("--workers", "2", "--batch", "2", "--ttl", "6", "--heartbeat", "1", "--dump", dumpPath);
  slowMs = 0;
  const firstBeats = Number(/, (\d+) heartbeat\(s\)/.exec(first.out)?.[1] ?? 0);
  assert(firstBeats >= 1 && !/heartbeat failed/.test(first.out) && !/attempt 2/.test(first.out),
    `the heartbeat beats through the first pass without error, and no row reaches a second worker (${firstBeats} beat(s))`);
  assert(first.code === 1 && /10 extracted, 1 failed/.test(first.out), `the first run extracts ten and fails the prose answer (exit ${first.code}: ${first.out.split("\n").find((l) => /extracted,/.test(l))?.trim()})`);
  assert(/not JSON of the expected shape/.test(first.out), "…naming the failure");
  // The long thought went in windows (SMD-1879): several calls, one thought,
  // and the summary and the dump both say so.
  assert(ledgerCalls >= 3, `the ledger thought took ${ledgerCalls} model calls — one per window`);
  assert(new RegExp(`in ${calls} model call\\(s\\) across 2 worker\\(s\\), 1 thought\\(s\\) in windows`).test(first.out), `the summary counts every call (${calls}) and the one windowed thought`);
  const dumped = (await Bun.file(dumpPath).text()).trim().split("\n").map((l) => JSON.parse(l) as { id: string; windows: number; parts?: { index: number; entities: unknown[] }[]; entities: unknown[]; relations: unknown[] });
  const ledgerLine = dumped.find((l) => l.id === ledger);
  assert(ledgerLine !== undefined && ledgerLine.windows === ledgerCalls && ledgerLine.parts?.length === ledgerCalls && ledgerLine.parts.every((p, i) => p.index === i && p.entities.length === 2),
         "the dump line carries each window's own answer beside the merged one — the derivation record");
  assert(ledgerLine !== undefined && ledgerLine.entities.length === 2 && ledgerLine.relations.length === 1, `…and the merged answer names Anita and Ledger once each, with one edge (${JSON.stringify(ledgerLine?.entities)})`);
  assert(dumped.filter((l) => l.id !== ledger).every((l) => l.windows === 1 && l.parts === undefined), "a thought within the window dumps as one window with no per-window record");
  try { unlinkSync(dumpPath); } catch { /* already gone */ }
  const [{ key }] = await sql`SELECT value AS key FROM ob1_config WHERE key = 'entity_extraction_key'`;
  assert(key === KEY, `the run recorded the extraction key (${key})`);
  const [agent] = await sql`SELECT canonical_agent_id AS id, label FROM ob1_agents WHERE label = 'entity-worker'`;
  assert(agent?.id != null, "the worker resolved itself to a stable agent id under its key's name");
  const [{ scope: agentScope }] = await sql`SELECT scope FROM ob1_agent_keys WHERE canonical_agent_id = ${agent.id}::uuid`;
  assert(agentScope === "write", `…registering the key record's own scope (${agentScope})`);
  const [{ attributed, total }] = await sql`
    SELECT count(*) FILTER (WHERE canonical_agent_id = ${agent.id}::uuid)::int AS attributed, count(*)::int AS total FROM thought_entities`;
  assert(Number(total) > 0 && Number(attributed) === Number(total), `every mention carries that agent id (${attributed} of ${total})`);
  const g1 = await graph();
  // Anita, Open Brain, PostgreSQL, Dev, Priya, Redis, observability, Ledger =
  // 8 entities; mentions 3 + 3 + 2 + 6 + 2 = 16; edges 2 + 2 + 1 + 1 = 6.
  assert(g1.entities === 8 && g1.mentions === 16 && g1.edges === 6, `the graph is exactly what the stub said: 8 entities, 16 mentions, 6 edges (${JSON.stringify(g1)})`);
  const anita = await entityByName("Anita");
  assert((await sql`SELECT count(*)::int AS c FROM thought_entities WHERE entity_id = ${anita.id}::uuid`)[0].c === 3, "Anita, named by three thoughts, is one entity with three mentions");
  const ledgerEntity = await entityByName("Ledger");
  assert(ledgerEntity !== undefined && (await sql`SELECT count(*)::int AS c FROM thought_entities WHERE entity_id = ${ledgerEntity.id}::uuid AND thought_id = ${ledger}::uuid`)[0].c === 1
         && (await sql`SELECT count(*)::int AS c FROM ob1_entities WHERE normalized_name = normalize_entity_name('Ledger')`)[0].c === 1,
         `an entity named in every one of the ${ledgerCalls} windows is ONE entity row with ONE mention of the thought, not ${ledgerCalls} (SMD-1879)`);
  assert((await sql`SELECT count(*)::int AS c FROM ob1_entity_edges WHERE thought_id = ${ledger}::uuid`)[0].c === 1, "…and the relation every window stated is one edge");
  const worksOn = await sql`
    SELECT count(*)::int AS support FROM ob1_entity_edges g
    WHERE g.relation = 'works_on' AND g.from_entity_id = ${anita.id}::uuid`;
  assert(Number(worksOn[0].support) === 3, `"Anita works_on …" has three evidence rows, one per thought (${worksOn[0].support})`);
  assert(((await entityByName("PostgreSQL")).aliases as string[]).includes("Postgres"), "the alias the model offered is recorded on the entity");
  const c1 = await claimCounts();
  assert(c1.succeeded === 10 && c1.failed === 1, `claims: 10 succeeded, 1 failed (${JSON.stringify(c1)})`);
  const callsAfterFirst = calls;

  // Another model's key, without saying so: refused before anything is touched.
  const otherModel = Bun.spawn(["bun", join(HERE, "extract-entities.ts"), "--url", URL_!, "--limit", "1"], {
    env: { ...env, OB1_METADATA_MODEL: "other-model" }, stdout: "pipe", stderr: "pipe", cwd: HERE,
  });
  const otherOut = (await new Response(otherModel.stdout).text()) + (await new Response(otherModel.stderr).text());
  assert((await otherModel.exited) === 2 && /--switch-key/.test(otherOut), "a run under a different model's key is refused without --switch-key");
  const [{ key: stillKey }] = await sql`SELECT value AS key FROM ob1_config WHERE key = 'entity_extraction_key'`;
  assert(stillKey === KEY, "…and the recorded key is untouched");

  // A second run over an unchanged corpus.
  const ids1 = (await sql`SELECT id FROM ob1_entities ORDER BY id`).map((r: { id: string }) => r.id);
  const second = await extract();
  assert(second.code === 1 && /0 extracted, 0 failed/.test(second.out), "a second run has nothing to extract (and still exits 1 for the failed row)");
  assert(calls === callsAfterFirst, "…and made no model call");
  const ids2 = (await sql`SELECT id FROM ob1_entities ORDER BY id`).map((r: { id: string }) => r.id);
  assert(JSON.stringify(ids1) === JSON.stringify(ids2) && JSON.stringify(await graph()) === JSON.stringify(g1), "…the graph is unchanged, entity ids included");

  // An edit: Priya moves to Memcached, so Redis must not survive.
  const [{ r: edit }] = await sql`SELECT update_thought(${t3}::uuid, ${"Priya moved the cache to memcached."}, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb) AS r`;
  assert(edit.ok === true, "the thought is edited through update_thought");
  const [{ status: requeued }] = await sql`SELECT status FROM thought_work_claims WHERE thought_id = ${t3}::uuid AND work_type = ${KEY}`;
  assert(requeued === "pending", "…and the trigger put it back in the pool");
  const third = await extract();
  assert(/1 extracted/.test(third.out), "the next run extracts exactly the edited thought");
  assert((await entityByName("Redis")) === undefined && (await entityByName("Memcached")) !== undefined, "Redis is gone and Memcached is here: the stale entity did not survive the edit");
  assert((await sql`SELECT count(*)::int AS c FROM ob1_entity_edges WHERE thought_id = ${t3}::uuid`)[0].c === 1, "…and the edited thought has exactly its new edge");

  // A delete: the edges it evidenced go with it.
  await sql`SELECT delete_thought(${t1}::uuid, NULL::jsonb)`;
  assert((await sql`SELECT count(*)::int AS c FROM ob1_entity_edges WHERE thought_id = ${t1}::uuid`)[0].c === 0, "deleting a thought leaves no edge citing it");
  const worksOnAfter = await sql`SELECT count(*)::int AS support FROM ob1_entity_edges WHERE relation = 'works_on' AND from_entity_id = ${anita.id}::uuid`;
  assert(Number(worksOnAfter[0].support) === 2, `…and the relations the other thoughts still evidence keep their rows (${worksOnAfter[0].support})`);
  assert((await entityByName("PostgreSQL")) !== undefined, "…while the entity it introduced remains until pruned");
  const [{ n: prunedN }] = await sql`SELECT prune_orphan_entities() AS n`;
  assert(Number(prunedN) === 1 && (await entityByName("PostgreSQL")) === undefined, `prune_orphan_entities removes it (${prunedN})`);

  // --status, then --retry-failed with a --limit.
  const status = await extract("--status");
  assert(status.code === 0 && /9 extracted, 1 failed/.test(status.out) && /graph: \d+ entities/.test(status.out), "--status reports the pass and the graph");
  hemlockIsProse = false;
  answers.hemlock = { entities: [{ name: "Socrates", type: "person", confidence: 0.9 }], relationships: [] };
  const retried = await extract("--retry-failed", "--limit", "1");
  assert(retried.code === 0 && /1 extracted, 0 failed/.test(retried.out), `--retry-failed with --limit 1 extracts the one failed row and exits 0 (exit ${retried.code})`);
  assert((await entityByName("Socrates")) !== undefined, "…and its entity is in the graph");

  // --follow: a capture made while the worker is polling is extracted without a
  // new run, and the first signal ends the process with exit 0.
  const follower = Bun.spawn(["bun", join(HERE, "extract-entities.ts"), "--url", URL_!, "--follow", "1"], { env, stdout: "pipe", stderr: "pipe", cwd: HERE });
  await Bun.sleep(1500);
  const sam = await seed("Sam adopted grafana for the on-call dashboards.");
  let extracted = false;
  for (let i = 0; i < 40 && !extracted; i++) {
    await Bun.sleep(250);
    extracted = (await sql`SELECT count(*)::int AS c FROM thought_entities WHERE thought_id = ${sam}::uuid`)[0].c > 0;
  }
  follower.kill("SIGINT");
  const followOut = (await new Response(follower.stdout).text()) + (await new Response(follower.stderr).text());
  const followCode = await follower.exited;
  assert(extracted, "a thought captured while --follow polls is extracted by the trigger and the poll, with no new run");
  assert(followCode === 0, `the follower exits 0 on SIGINT (exit ${followCode}; ${followOut.split("\n").filter(Boolean).slice(-2).join(" | ")})`);
  assert((await entityByName("Grafana")) !== undefined, "…and Grafana is in the graph");

  // Nothing in this section wrote thought_audit through the worker: it writes
  // entities, not thoughts. The edit and delete above are audited as the tools
  // that made them.
  const [{ actors }] = await sql`SELECT count(*) FILTER (WHERE actor_name = 'entity-worker')::int AS actors FROM thought_audit`;
  assert(Number(actors) === 0, "the worker writes no thought_audit rows — it never mutates thoughts; its rows carry its agent id instead");

  model.stop(true);
  await sql`DELETE FROM ob1_config WHERE key = 'entity_extraction_key'`;
  await sql`DELETE FROM thoughts`;
}

console.log("\n[11] search_thoughts_hybrid through Bun.sql on real pgvector (migration 017)");
{
  await sql`DELETE FROM thoughts`;
  // A shared fixture key on every row, so the hybrid reads below filter on it
  // and the vector arm — match_thoughts with the filter passed through (017/027)
  // — takes the exact branch rather than the HNSW walk over these tied unit
  // axes (SMD-1632; the same move [7] makes). The keyword arm is filtered by
  // the same key, which every row carries, so what the section tests — a
  // keyword hit outside the vector window, and the window-of-one probe — is
  // unchanged; only the walk is taken out of the vector arm.
  const S = { s: "11" } as const;
  await sql`SELECT upsert_thought(${"exact"}, ${{ metadata: { kind: "a", ...S } }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${"distant, and it names SMD-507"}, ${{ metadata: { kind: "b", ...S } }}::jsonb, ${unit(1)}::vector)`;
  // A chunked thought: its own vector is orthogonal but one chunk is close, so
  // the keyword hit's similarity must come from the chunk, as match_thoughts'
  // would — the direct probe scores the same rule.
  const [{ r: chunked }] = await sql`SELECT upsert_thought(${"long, mentions SMD-507 in a chunk"}, ${{ metadata: { kind: "b", ...S } }}::jsonb, ${unit(2)}::vector) AS r`;
  const near = new Array(EMBEDDING_DIM).fill(0); near[0] = 0.8; near[3] = 0.6;
  await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES (${chunked.id}::uuid, 0, ${"chunk mentioning SMD-507"}, ${`[${near.join(",")}]`}::vector)`;

  const rows = await sql`SELECT content, similarity, matched_needles, literal_only FROM search_thoughts_hybrid(${unit(0)}::vector, ${"SMD-507"}, 0.5, 10, ${S}::jsonb)`;
  assert(rows.length === 3, `both exact hits and the one vector row above 0.5 come back (${rows.length})`);
  assert(rows[0].content === "long, mentions SMD-507 in a chunk", `the chunk-scored hit ranks first among the exact hits (${rows.map((r: { content: string }) => r.content).join(" | ")})`);
  assert(Math.abs(Number(rows[0].similarity) - 0.8) < 1e-6, `…with the chunk's similarity, 0.8, not the parent's 0 (${rows[0].similarity})`);
  assert(Math.abs(Number(rows[1].similarity) - 0) < 1e-6 && rows[1].matched_needles.join() === "SMD-507", "the orthogonal exact hit is second, similarity 0");
  assert(rows[2].content === "exact" && rows[2].matched_needles.length === 0 && rows[2].literal_only === true, "the vector arm fills after, and the query was literal-only");

  // The direct probe and match_thoughts agree on what a keyword hit's
  // similarity is. With a window of ONE the vector arm returns only "exact",
  // so the chunked hit's 0.8 can only have come from 017's own probe — the
  // copy of match_thoughts' best-of-vector-and-chunks rule that the header
  // marks as the one to mirror (review pass: the first version of this test
  // used a window of ten, every row was in it, and the probe never ran).
  const [one] = await sql`SELECT content, similarity FROM search_thoughts_hybrid(${unit(0)}::vector, ${"SMD-507"}, 0.5, 1, ${S}::jsonb)`;
  assert(one.content === "long, mentions SMD-507 in a chunk", `with a window of one the chunked exact hit still leads (${one.content})`);
  const [mt] = await sql`SELECT similarity FROM match_thoughts(${unit(0)}::vector, -1.0, 10, ${{ kind: "b", ...S }}::jsonb) WHERE content = ${"long, mentions SMD-507 in a chunk"}`;
  assert(Math.abs(Number(mt.similarity) - Number(one.similarity)) < 1e-9, `…scored by the probe to exactly match_thoughts' number (${one.similarity} vs ${mt.similarity})`);
  await sql`DELETE FROM thoughts`;
}

console.log("\n[12] thought_stats_summary() equals the page walk, proves the old cap truncated, and full-scans as its header says (migration 024)");
{
  // Seed a known corpus, oldest → newest, chosen to exercise every arm:
  //   - two types, so a newest-only prefix misses one (the truncation proof);
  //   - a topic on three rows and another on one (the count aggregation);
  //   - a JSON null inside a topics array (s3), which must be dropped, not
  //     crash jsonb_object_agg on a NULL key;
  //   - topics that is NOT an array (s5, a bare string), which must be skipped,
  //     not raise from jsonb_array_elements_text — the tool's Array.isArray guard;
  //   - a row with no topics/people at all (s4).
  await sql.unsafe(`
    INSERT INTO thoughts (content, metadata, created_at) VALUES
      ('s1', '{"type":"old","topics":["x","y"],"people":["Ada"]}'::jsonb, now() - interval '5 min'),
      ('s2', '{"type":"old","topics":["x"],"people":["Bob"]}'::jsonb,     now() - interval '4 min'),
      ('s3', '{"type":"old","topics":["x",null]}'::jsonb,                 now() - interval '3 min'),
      ('s4', '{"type":"new"}'::jsonb,                                      now() - interval '2 min'),
      ('s5', '{"type":"new","topics":"notarray","people":["Ada"]}'::jsonb, now() - interval '1 min')`);

  // The application walk the PostgREST store runs (store-postgrest.ts) — page
  // metadata newest-first and tally, optionally stopping at a cap, with the same
  // null-element guard that store and migration 024 both apply. This is the
  // reference the SQL function must reproduce, and it is faithful to the
  // PostgREST path too, so [12] covers both stores' aggregation.
  const walk = async (cap = Infinity) => {
    const types: Record<string, number> = {};
    const topics: Record<string, number> = {};
    const people: Record<string, number> = {};
    let aggregated = 0;
    const PAGE = 2; // small, so paging is actually exercised
    for (let off = 0; off < cap; off += PAGE) {
      const page = await sql`SELECT metadata FROM thoughts ORDER BY created_at DESC LIMIT ${Math.min(PAGE, cap - off)}::int OFFSET ${off}::int`;
      if (page.length === 0) break;
      for (const r of page) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics)) for (const t of m.topics) if (t != null) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people)) for (const p of m.people) if (p != null) people[p as string] = (people[p as string] || 0) + 1;
      }
      aggregated += page.length;
      if (page.length < PAGE) break;
    }
    return { types, topics, people, aggregated };
  };

  const fn = (await sql`SELECT thought_stats_summary() AS s`)[0].s as {
    total: number; first_ts: string | null; last_ts: string | null;
    types: Record<string, number>; topics: Record<string, number>; people: Record<string, number>;
  };
  const full = await walk();

  assert(fn.total === 5, `function counts the whole corpus (${fn.total})`);
  assert(full.aggregated === 5, "the uncapped walk covers the whole corpus");
  assert(JSON.stringify(fn.types) === JSON.stringify(full.types), `types agree with the walk (${JSON.stringify(fn.types)} vs ${JSON.stringify(full.types)})`);
  assert(JSON.stringify(fn.topics) === JSON.stringify(full.topics), `topics agree with the walk (${JSON.stringify(fn.topics)} vs ${JSON.stringify(full.topics)})`);
  assert(JSON.stringify(fn.people) === JSON.stringify(full.people), `people agree with the walk (${JSON.stringify(fn.people)} vs ${JSON.stringify(full.people)})`);
  assert(fn.types.old === 3 && fn.types.new === 2, "type counts are exact across two types");
  assert(fn.topics.x === 3 && fn.topics.y === 1, "topic counts unnest and aggregate, null element dropped");
  assert(!("notarray" in fn.topics), "a non-array topics value is skipped, not unnested char-by-char or raised");
  assert(fn.people.Ada === 2 && fn.people.Bob === 1, "people counts aggregate across rows");
  assert(fn.first_ts !== null && fn.last_ts !== null && fn.first_ts < fn.last_ts, "first/last span the corpus, oldest before newest");

  // The old cap was a real correctness cliff: a walk that stops before the end
  // reports breakdowns from an arbitrary newest prefix beside a true total. Cap
  // at 2 (the two newest, both type 'new') and the 'old' type vanishes, while
  // the function still sees all three. That divergence is exactly what happened
  // past 100,000 rows before this migration — proven here without seeding 100k.
  const capped = await walk(2);
  assert(capped.aggregated === 2, "a walk capped at 2 covers only two rows");
  assert(capped.types.old === undefined && fn.types.old === 3, "…and its breakdowns disagree with the whole-corpus function — the truncation was real");

  // The plan, as migration 024's header claims: the topic/people unnest is a
  // full scan of thoughts, and that is accepted for a once-called summary.
  const plan = (await sql.unsafe(
    `EXPLAIN SELECT count(*) FROM thoughts, jsonb_array_elements_text(CASE WHEN jsonb_typeof(metadata->'topics')='array' THEN metadata->'topics' ELSE '[]'::jsonb END)`
  )).map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  assert(/Seq Scan on thoughts/.test(plan), `the unnest arm is a full scan, as the header records (${plan.split("\n")[0]})`);

  // Empty corpus: a total of zero, every map empty, no date range.
  await sql`DELETE FROM thoughts`;
  const empty = (await sql`SELECT thought_stats_summary() AS s`)[0].s as typeof fn;
  assert(empty.total === 0, "empty corpus totals zero");
  assert(empty.first_ts === null && empty.last_ts === null, "…with a null date range, not an error");
  assert(JSON.stringify(empty.types) === "{}" && JSON.stringify(empty.topics) === "{}" && JSON.stringify(empty.people) === "{}", "…and empty breakdown maps, not null");
}

console.log("\n[13] Provenance through the real write path: the chain traces both ways, a deleted parent behaves as 008/009 say, and a bad reference is refused (migration 025)");
{
  // Round-trip through upsert_thought, as 016's eval does — not a raw INSERT.
  // A three-thought chain: grandparent ← parent ← child, and the child also
  // supersedes the parent.
  const capR = async (content: string, meta: Record<string, unknown>, at: number, prov?: { derived_from?: string[]; supersedes?: string }) =>
    (await sql`SELECT upsert_thought(${content}, ${{ metadata: meta, ...(prov ?? {}) }}::jsonb, ${unit(at)}::vector) AS r`)[0].r as { id: string; existed?: boolean; supersedes?: string | null };
  const cap = async (content: string, meta: Record<string, unknown>, at: number, prov?: { derived_from?: string[]; supersedes?: string }) => (await capR(content, meta, at, prov)).id;

  const gp = await cap("provenance grandparent: the raw note", { type: "observation" }, 0);
  const parent = await cap("provenance parent: a first digest", { type: "synthesis", derivation_method: "synthesis" }, 1, { derived_from: [gp] });
  const child = await cap("provenance child: a digest of the digest", { type: "synthesis", derivation_method: "synthesis" }, 2, { derived_from: [parent], supersedes: parent });

  // The columns read back as written (round-trip).
  const row = (await sql`SELECT derived_from, supersedes FROM thoughts WHERE id = ${child}`)[0];
  assert(JSON.stringify(row.derived_from) === JSON.stringify([parent]) && row.supersedes === parent, "capture wrote derived_from and supersedes to the columns");

  // A re-capture writes no provenance (035). A re-capture of the child's exact
  // text (a dedup) that names DIFFERENT provenance does not overwrite the
  // established derivation (025, review pass 2), and since 035 a re-capture of
  // a first-hand thought does not fill provenance it did not have either —
  // the envelope's provenance lands on a first capture only, and the return
  // says `existed`. Recording it afterwards is update_thought's envelope
  // (032): walked, audited, one function.
  const childAgain = await capR("provenance child: a digest of the digest", { type: "synthesis" }, 2, { derived_from: [gp], supersedes: gp });
  const kept = (await sql`SELECT derived_from, supersedes FROM thoughts WHERE id = ${child}`)[0];
  assert(childAgain.id === child && childAgain.existed === true && childAgain.supersedes === parent && JSON.stringify(kept.derived_from) === JSON.stringify([parent]) && kept.supersedes === parent, "a re-capture with different provenance keeps the original, it does not overwrite — and says existed: true with the pointer that stands");
  const first = await capR("provenance plain: a first-hand note", { type: "note" }, 6);
  const plain = first.id;
  assert(first.existed === false && (await sql`SELECT derived_from FROM thoughts WHERE id = ${plain}`)[0].derived_from === null, "a first-hand capture has null derived_from, existed: false");
  const plainAgain = await capR("provenance plain: a first-hand note", { type: "note" }, 6, { derived_from: [child] });
  assert(plainAgain.id === plain && plainAgain.existed === true && (await sql`SELECT derived_from FROM thoughts WHERE id = ${plain}`)[0].derived_from === null, "…and a re-capture naming provenance over it fills nothing (035: a re-capture writes no provenance) and says existed: true");
  // Derives from `child` (not gp/parent, whose derivative counts are asserted
  // below) — recorded the one way there is now.
  const recorded = (await sql`SELECT update_thought(${plain}::uuid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${{ derived_from: [child] }}::jsonb) AS r`)[0].r as { ok: boolean };
  assert(recorded.ok === true && JSON.stringify((await sql`SELECT derived_from FROM thoughts WHERE id = ${plain}`)[0].derived_from) === JSON.stringify([child]), "…update_thought's envelope records it");
  // Through the 4-argument form — the one the servers call — `existed` rides
  // beside `chunks` (013 appends to the inner return); on a real server, since
  // PGlite aborts on a windowed capture through it (test-schema [35]'s note).
  const viaFour = (await sql`SELECT upsert_thought(${"provenance plain: a first-hand note"}, ${{ metadata: { type: "note" }, supersedes: child }}::jsonb, ${unit(6)}::vector, ${[{ content: "a window", embedding: unit(6) }]}::jsonb) AS r`)[0].r as { id: string; existed?: boolean; chunks?: number };
  assert(viaFour.id === plain && viaFour.existed === true && viaFour.chunks === 1 && (await sql`SELECT supersedes FROM thoughts WHERE id = ${plain}`)[0].supersedes === null,
         `…and through the 4-argument form existed rides beside chunks, the pointer named still not written (${JSON.stringify({ existed: viaFour.existed, chunks: viaFour.chunks })})`);
  await sql`DELETE FROM thought_chunks WHERE thought_id = ${plain}`;

  // trace UP: child(0) → parent(1) → grandparent(2), the whole chain.
  const up = await sql`SELECT thought_id, depth, parent_id, cycle FROM trace_provenance(${child}::uuid)`;
  const byId = Object.fromEntries(up.map((r: Record<string, unknown>) => [r.thought_id, r]));
  assert(Number(byId[child]?.depth) === 0 && Number(byId[parent]?.depth) === 1 && Number(byId[gp]?.depth) === 2,
         `trace_provenance walks the full chain up (child 0, parent 1, grandparent 2) — got ${up.map((r: Record<string, unknown>) => `${(r.thought_id as string).slice(0,4)}@${r.depth}`).join(",")}`);
  assert(String(byId[parent]?.parent_id) === child && String(byId[gp]?.parent_id) === parent, "…each node parented by the thought that derived from it");
  assert(up.every((r: Record<string, unknown>) => r.cycle === false), "…and no node is a cycle on an acyclic chain");

  // trace DOWN: each level's one derivative.
  const derGp = await sql`SELECT id FROM find_derivatives(${gp}::uuid)`;
  const derParent = await sql`SELECT id FROM find_derivatives(${parent}::uuid)`;
  assert(derGp.length === 1 && String(derGp[0].id) === parent, "find_derivatives finds the parent below the grandparent");
  assert(derParent.length === 1 && String(derParent[0].id) === child, "…and the child below the parent — the chain traces both directions");

  // The cycle guard. A cycle cannot form through the validated write path (each
  // derived_from element must already exist), so it is forced by a raw UPDATE —
  // exactly the hand-written row the guard exists for. grandparent now derives
  // from child, closing gp → child → parent → gp.
  await sql`UPDATE thoughts SET derived_from = ${[child]}::jsonb WHERE id = ${gp}`;
  const cyc = await sql`SELECT thought_id, cycle FROM trace_provenance(${child}::uuid, 10)`;
  assert(cyc.some((r: Record<string, unknown>) => r.cycle === true), "a forced cycle is flagged, not looped forever");
  assert(cyc.length <= 6, `…and the walk terminates (${cyc.length} nodes, capped)`);
  await sql`UPDATE thoughts SET derived_from = NULL WHERE id = ${gp}`; // break the forced cycle again

  // A deleted parent behaves as 008/009 say: the hard delete removes the row and
  // its content survives in the append-only audit; the self-FK SET NULLs the
  // child's pointer (009 stays "delete is always allowed"); and 025's extended
  // audit trigger records BOTH — the delete, and the child's supersedes clearing.
  const auditBefore = Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  await sql`DELETE FROM thoughts WHERE id = ${parent}`;
  const childAfter = (await sql`SELECT count(*)::int AS c, max(supersedes::text) AS s, max(derived_from::text) AS d FROM thoughts WHERE id = ${child}`)[0];
  assert(Number(childAfter.c) === 1, "the child survives its parent's deletion");
  assert(childAfter.s === null, "…its supersedes is SET NULL, not left dangling and not cascaded to a delete");
  assert(childAfter.d === JSON.stringify([parent]), "…while derived_from keeps the id: it is a historical record, not a live FK");

  const del = (await sql`SELECT diff FROM thought_audit WHERE thought_id = ${parent} AND action = 'delete'`)[0];
  assert(del !== undefined, "the delete is audited (008)");
  assert((del.diff as Record<string, unknown>).previous_content === "provenance parent: a first digest", "…with the prior content in full, so the row is recoverable");
  assert("previous_derived_from" in (del.diff as Record<string, unknown>) && "previous_supersedes" in (del.diff as Record<string, unknown>), "…and 025 keeps the prior provenance in the recovery record");

  const childUpdate = await sql`SELECT diff FROM thought_audit WHERE thought_id = ${child} AND action = 'update' AND diff ? 'supersedes'`;
  assert(childUpdate.length === 1, "the SET NULL is itself audited on the child — an update the pre-025 diff could not see");
  const sd = (childUpdate[0].diff as { supersedes: { before: string | null; after: string | null } }).supersedes;
  assert(sd.before === parent && sd.after === null, `…recording supersedes cleared from the parent to null (${sd.before?.slice(0,4)} → ${sd.after})`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) > auditBefore, "audit grew, it was not silent");

  // Validation is at the write path — a non-existent reference is refused, and
  // no row is written for it.
  let missing = "";
  try { await cap("provenance orphan: derived from nothing real", {}, 3, { derived_from: ["11111111-1111-1111-1111-111111111111"] }); }
  catch (e) { missing = (e as Error).message; }
  assert(/does not exist/.test(missing), `a derived_from naming no thought is refused (${missing.slice(0, 60)})`);
  let nonUuid = "";
  try { await cap("provenance junk: derived from junk", {}, 3, { derived_from: ["nope"] }); }
  catch (e) { nonUuid = (e as Error).message; }
  assert(/only thought UUID strings/.test(nonUuid), "…and a non-UUID element is refused before any write");
  assert(Number((await sql`SELECT count(*)::int AS c FROM thoughts WHERE content LIKE 'provenance orphan%' OR content LIKE 'provenance junk%'`)[0].c) === 0, "…and neither refused capture left a row");

  await sql`DELETE FROM thoughts`;
}

console.log("\n[14] trace_provenance bounds its WORK on a dense DAG: each node expanded once, diamonds keep every edge, no path explosion (migration 026, SMD-1288)");
{
  const cap = async (content: string, at: number, derived?: string[]) =>
    ((await sql`SELECT upsert_thought(${content}, ${{ metadata: { type: "synthesis" }, ...(derived ? { derived_from: derived } : {}) }}::jsonb, ${unit(at)}::vector) AS r`)[0].r as { id: string }).id;

  // A dense, cycle-free DAG built through the real write path: WIDTH nodes per
  // layer for DEPTH layers, each node deriving from EVERY node of the next-deeper
  // layer, plus a root over layer 1. Root→leaf paths = WIDTH^DEPTH; distinct
  // nodes = WIDTH*DEPTH+1. The per-path 025 walk materialised a row per PATH (and
  // spent its cap on shallow repeats); 026 expands each node once. Bottom-up,
  // because upsert_thought validates that every derived_from element exists.
  const WIDTH = 3, DEPTH = 4;
  let k = 0;
  let deeper: string[] = [];
  const layers: string[][] = [];  // layers[0] = the layer just under root; layers[DEPTH-1] = the leaves.
  for (let layer = DEPTH; layer >= 1; layer--) {
    const here: string[] = [];
    for (let w = 0; w < WIDTH; w++) here.push(await cap(`dense L${layer} n${w}`, k++, deeper.length ? deeper : undefined));
    layers.unshift(here);
    deeper = here;
  }
  const root = await cap("dense root", k++, deeper);
  const distinctNodes = WIDTH * DEPTH + 1;
  const paths = WIDTH ** DEPTH;

  const walk = await sql`SELECT thought_id, depth, parent_id, cycle FROM trace_provenance(${root}::uuid, ${DEPTH})`;
  const nodeSet = new Set(walk.map((r: Record<string, unknown>) => r.thought_id as string));
  assert(nodeSet.size === distinctNodes, `every distinct ancestor is reached, deep layers included (${nodeSet.size} of ${distinctNodes})`);
  // The work bound, pinned EXACTLY, not by the weak `< paths` proxy: because each
  // node is expanded once, the walk emits the root plus one row per derivation
  // EDGE and no more. This DAG has WIDTH root→L1 edges and WIDTH*WIDTH edges into
  // each of the DEPTH-1 deeper layers. A regression that re-expanded a shared
  // node — the exact defect 026 exists to prevent — would emit that node's
  // subtree edges again and overshoot this count, so the equality is the guard.
  const edges = WIDTH + WIDTH * WIDTH * (DEPTH - 1);
  assert(walk.length === 1 + edges,
    `no re-expansion: exactly ${1 + edges} rows (root + ${edges} edges), not the ${paths} paths a per-path walk would count — got ${walk.length}`);
  assert(walk.every((r: Record<string, unknown>) => r.cycle === false), "an acyclic dense DAG has no cycle rows — diamonds included");

  // The diamond: a leaf is a source of EVERY node of the layer above it, so it is
  // reached at its one true depth from WIDTH distinct parents. Each derivation
  // edge is kept (025's per-path parent info), though the node is EXPANDED once —
  // the whole point of the walk-global set. cycle stays false: a same-level
  // convergence is not a cycle.
  const leaf = layers[DEPTH - 1][0];
  const leafRows = walk.filter((r: Record<string, unknown>) => r.thought_id === leaf);
  const leafParents = new Set(leafRows.map((r: Record<string, unknown>) => r.parent_id as string));
  assert(leafRows.length === WIDTH && leafParents.size === WIDTH,
    `a shared ancestor keeps an edge from each of its ${WIDTH} parents (${leafRows.length} edges, ${leafParents.size} distinct parents)`);
  assert(leafRows.every((r: Record<string, unknown>) => Number(r.depth) === DEPTH && r.cycle === false),
    "…at its true depth, none flagged a cycle");
  await sql`DELETE FROM thoughts`;

  // Cross-depth re-convergence (no cycle): a node reachable by a SHORT and a LONG
  // path. 026 discovers it at its shallowest depth and expands it once there; the
  // deeper re-encounter is flagged cycle=true — the documented imprecision of a
  // walk-global set (it cannot tell a re-convergence from a real cycle without the
  // per-path ancestry that is the blow-up itself). It only over-flags a repeat: no
  // distinct ancestor is dropped, and none of D's own ancestors go missing because
  // D was expanded from the short path.
  const dd = await cap("recon D", 0);                  // depth 1 (short) and 3 (long)
  const bb = await cap("recon B", 1, [dd]);
  const aa = await cap("recon A", 2, [bb]);
  const rr = await cap("recon root", 3, [aa, dd]);     // root derives from A and D
  const recon = await sql`SELECT thought_id, depth, cycle FROM trace_provenance(${rr}::uuid, 10)`;
  assert(new Set(recon.map((x: Record<string, unknown>) => x.thought_id)).size === 4, "every node of a re-converging DAG is reached (root, A, B, D)");
  const dRows = recon.filter((x: Record<string, unknown>) => x.thought_id === dd);
  assert(dRows.some((x: Record<string, unknown>) => Number(x.depth) === 1 && x.cycle === false), "…the shared node is expanded once at its SHALLOWEST depth (1), cycle=false");
  assert(dRows.some((x: Record<string, unknown>) => Number(x.depth) === 3 && x.cycle === true), "…and its deeper re-encounter is flagged cycle=true, not looped");
  assert(recon.some((x: Record<string, unknown>) => x.thought_id === bb), "…and B — reachable only through the long path — is still present (no ancestor dropped)");
  await sql`DELETE FROM thoughts`;

  // The node cap keeps real ancestors over repeat markers. A chain d←c←b←a with a
  // forced back-edge a→d (a cycle); trace from d with a cap of 4 fills the four
  // real ancestors (d@0,c@1,b@2,a@3) and the loop stops before the depth-4 cycle
  // marker is emitted — the cap spends itself on ancestors, not on the repeat.
  const ca = await cap("cap a", 0);
  const cb = await cap("cap b", 1, [ca]);
  const cc = await cap("cap c", 2, [cb]);
  const cd = await cap("cap d", 3, [cc]);
  await sql`UPDATE thoughts SET derived_from = ${[cd]}::jsonb WHERE id = ${ca}`;  // a→d closes the cycle
  const capped = await sql`SELECT thought_id, cycle FROM trace_provenance(${cd}::uuid, 10, 4)`;
  assert(capped.length === 4 && capped.every((x: Record<string, unknown>) => x.cycle === false),
    `a small node cap keeps the ${capped.length} real ancestors and drops the repeat marker (${capped.filter((x: Record<string, unknown>) => x.cycle === true).length} cycle rows)`);
  await sql`UPDATE thoughts SET derived_from = NULL WHERE id = ${ca}`;  // break the cycle
  await sql`DELETE FROM thoughts`;
}

console.log("\n[15] search_thoughts_hybrid admits relative to the top match on real pgvector (migration 027, SMD-1300)");
{
  await sql`DELETE FROM thoughts`;
  // Three rows at known cosines to the query unit(0): top 0.30, near 0.18
  // (≥ 0.5×top, kept), far 0.10 (< 0.5×top, trimmed). All sit BELOW the old 0.5
  // floor — the long-capture case, where a short question scores a low cosine
  // against a big document, and the floor dropped the right answer.
  // A shared fixture key on all three rows, so the reads filter on it and the
  // vector arm takes match_thoughts' exact branch (017/027 pass the filter
  // through) instead of the HNSW walk — this section runs after the suite's
  // mass deletes, the shape that flaked [7] (SMD-1632). The relative cutoff is
  // computed over whatever the vector arm returns, so filtering all three rows
  // in changes nothing it asserts; a key on ONE row would defeat the cutoff.
  const S = { s: "15" } as const;
  const at = (wa: number, wb: number) => { const v = new Array(EMBEDDING_DIM).fill(0); v[0] = wa; v[1] = wb; return `[${v.join(",")}]`; };
  await sql`SELECT upsert_thought(${"top, still low"}, ${{ metadata: { ...S } }}::jsonb, ${at(0.30, 0.9539)}::vector)`;
  await sql`SELECT upsert_thought(${"within half"}, ${{ metadata: { ...S } }}::jsonb, ${at(0.18, 0.9837)}::vector)`;
  await sql`SELECT upsert_thought(${"far below"}, ${{ metadata: { ...S } }}::jsonb, ${at(0.10, 0.9950)}::vector)`;

  // Threshold 0 — what the tools send now: the relative cutoff governs. The top
  // and the row within half of it come back; the far row is trimmed.
  const rel = await sql`SELECT content, similarity FROM search_thoughts_hybrid(${unit(0)}::vector, ${"a plain question with no identifiers"}, 0.0, 10, ${S}::jsonb)`;
  const names = rel.map((r: { content: string }) => r.content);
  assert(rel.length === 2 && names.includes("top, still low") && names.includes("within half") && !names.includes("far below"),
    `threshold 0 keeps the top and the row within half of it, trims the far row (${names.join(" | ")})`);
  assert(Math.abs(Number(rel[0].similarity) - 0.30) < 0.02, `the reported % match is still the raw cosine (~0.30, ${rel[0].similarity})`);

  // The absolute floor is unchanged and still available: at 0.5 nothing here
  // clears it — the whole set the shipped tool silently dropped before SMD-1300.
  const floored = await sql`SELECT content FROM search_thoughts_hybrid(${unit(0)}::vector, ${"a plain question with no identifiers"}, 0.5, 10, ${S}::jsonb)`;
  assert(floored.length === 0, `an explicit 0.5 floor still excludes every sub-floor row (${floored.length})`);
  await sql`DELETE FROM thoughts`;
}

// ── 16. db/consolidate.ts — the third consumer, end to end ───────────────────
//
// A stub judge answers from the two thoughts it is shown, so the proposals
// are known exactly; one pair draws prose to exercise the failed path. The
// worker authenticates with a minted key, so proposals carry a stable agent
// id and an acceptance is audited under the key's name. Then what SMD-1294's
// Verify asks: the states, the accept path writing supersedes with an audit
// row, a reject leaving thoughts untouched, a second run not re-proposing a
// rejected pair, and the cost line.

console.log("\n[16] db/consolidate.ts: proposals through the claims, against a stub judge (migration 029, SMD-1294)");
{
  await sql`DELETE FROM thoughts`;
  await sql`DELETE FROM ob1_entities`;
  // The pass key from the one function that spells it (a hand-written "@p2"
  // here broke the day SMD-1726 moved the prompt to 3).
  const KEY = consolidateKey("stub-judge");
  const keyRe = (model: string) => new RegExp(`job:\\s+${consolidateKey(model).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const EXTRACT = "extract:stub@p1";
  let calls = 0;
  let hemlockIsProse = true;
  const seen: { a: string; b: string }[] = [];
  /** The models the judge requests named; the knob under test in SMD-1901's cases below. */
  const modelsSeen = new Set<string>();
  // While set, every verdict takes this long: the first run, so the heartbeat
  // (migration 031) has time to beat.
  let slowMs = 0;
  const judge = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: { role: string; content: string }[]; model?: string };
      calls++;
      modelsSeen.add(String(body.model));
      const prompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
      const a = /<thought_a>\n([\s\S]*?)\n<\/thought_a>/.exec(prompt)?.[1] ?? "";
      const b = /<thought_b>\n([\s\S]*?)\n<\/thought_b>/.exec(prompt)?.[1] ?? "";
      seen.push({ a, b });
      await Bun.sleep(5 + slowMs);
      if (hemlockIsProse && /hemlock/.test(a + b)) return Response.json({ choices: [{ message: { content: "I'd rather not say." } }] });
      let answer: Record<string, unknown>;
      if (/monthly/.test(a) && /annually/.test(b)) answer = { verdict: "conflict", supersedes: "B", confidence: 0.92, reason: "monthly billing against annual" };
      else if (/blue/.test(a) && /green/.test(b)) answer = { verdict: "conflict", supersedes: "unknown", confidence: 0.7, reason: "two brand colours, neither says which stands" };
      else if (/lowconf/.test(a) && /lowconf/.test(b)) answer = { verdict: "conflict", supersedes: "B", confidence: 0.3, reason: "guessing" };
      else if (/deploy/.test(a) && /deploy/.test(b)) answer = { verdict: "agree", supersedes: "unknown", confidence: 0.8, reason: "both describe the deploy" };
      else answer = { verdict: "unrelated", supersedes: "unknown", confidence: 0.9, reason: "different subjects" };
      return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], model: body.model });
    },
  });

  const seed = async (content: string, axis: number, daysAgo: number, names: string[] = []) => {
    const id = ((await sql`SELECT upsert_thought(${content}, ${{ metadata: { source: "test" } }}::jsonb, ${unit(axis)}::vector) AS r`)[0].r as { id: string }).id;
    await sql`UPDATE thoughts SET created_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${id}::uuid`;
    if (names.length) {
      await sql`SELECT record_thought_entities(${id}::uuid, ${EXTRACT}, ${names.map((n) => ({ name: n, type: "topic", confidence: 0.9 }))}::jsonb, '[]'::jsonb, NULL, NULL)`;
    }
    return id;
  };
  const decision = await seed("We bill monthly, decided in March.", 0, 10, ["billing"]);
  const reversal = await seed("We bill annually now; the monthly plan is withdrawn.", 0, 0, ["billing", "pricing"]);
  const blue = await seed("The brand colour is blue.", 1, 7, ["palette"]);
  const green = await seed("The brand colour is green.", 1, 0, ["palette"]);
  await seed("The deploy runs from main.", 2, 5, ["deploy"]);
  await seed("The deploy runs from main, gated on the tests.", 2, 0, ["deploy"]);
  await seed("The hemlock note, the first.", 3, 3, ["hemlock"]);
  const hemlockNewer = await seed("The hemlock note, the second.", 3, 0, ["hemlock"]);
  await seed("lowconf: the first reading", 4, 4, ["readings"]);
  await seed("lowconf: the second reading", 4, 0, ["readings"]);
  const noEntities = await seed("A thought nothing has extracted yet.", 5, 0);
  await seed("The archive migration, long finished.", 6, 30, ["archive"]);
  // Entities but no vector: extracted, embedding failed at capture. Out of the
  // pool until reembed.ts fills the vector (review pass 1's gate, pinned here).
  const vectorless = ((await sql`SELECT upsert_thought(${"A billing note whose embedding failed."}, ${{ metadata: {} }}::jsonb, NULL::vector) AS r`)[0].r as { id: string }).id;
  await sql`SELECT record_thought_entities(${vectorless}::uuid, ${EXTRACT}, ${[{ name: "billing", type: "topic", confidence: 0.9 }]}::jsonb, '[]'::jsonb, NULL, NULL)`;

  const rawKey = "b".repeat(64);
  const { hashKey } = await import("../server-portable/auth.ts");
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: URL_,
    OB1_LLM_BASE_URL: `http://127.0.0.1:${judge.port}/v1`,
    OB1_LLM_LOCAL: "1",
    OB1_METADATA_MODEL: "stub-judge",
    OB1_WORKER_KEY: rawKey,
    MCP_ACCESS_KEYS: `consolidator:write:${hashKey(rawKey)}`,
  };
  const dump = `/tmp/ob1-consolidate-test-${process.pid}.jsonl`;
  const consolidate = (...extra: string[]): Promise<{ code: number; out: string }> =>
    runScript(["bun", join(HERE, "consolidate.ts"), "--url", URL_!, ...extra], { env: env as Record<string, string>, cwd: HERE });
  const claimCounts = async () =>
    Object.fromEntries((await sql`SELECT status, count(*)::int AS c FROM thought_work_claims WHERE work_type = ${KEY} GROUP BY status`)
      .map((r: { status: string; c: number }) => [r.status, Number(r.c)])) as Record<string, number>;
  const proposals = async () => (await sql`
    SELECT id, older_id, newer_id, verdict, confidence, status, judge_key, canonical_agent_id, superseding_id
    FROM supersession_proposals ORDER BY confidence DESC`) as
    { id: string; older_id: string; newer_id: string; verdict: string; confidence: string; status: string; judge_key: string; canonical_agent_id: string | null; superseding_id: string | null }[];
  const supersedesOf = async (id: string) => (await sql`SELECT supersedes FROM thoughts WHERE id = ${id}::uuid`)[0].supersedes as string | null;

  const dry = await consolidate("--dry-run");
  assert(dry.code === 0 && /Nothing was written/.test(dry.out) && /add 11 thoughts to the pool/.test(dry.out),
         `--dry-run counts the eleven thoughts with entities and a vector — not the one without entities, nor the one without a vector — and writes nothing (exit ${dry.code}: ${dry.out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300)})`);
  assert((await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = ${KEY}`)[0].c === 0 && (await proposals()).length === 0, "…no claim row, no proposal");
  assert((await sql`SELECT count(*)::int AS c FROM ob1_agents WHERE label = 'consolidator'`)[0].c === 0, "…and it did not register the worker's agent either");
  const shortLease = await consolidate("--ttl", "3", "--heartbeat", "2");
  assert(shortLease.code === 2 && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(shortLease.out), "a lease under two heartbeats is refused (migration 031)");
  const bigBatch = await consolidate("--dry-run", "--batch", "4", "--k", "5", "--timeout", "120");
  assert(bigBatch.code === 0 && /Nothing was written/.test(bigBatch.out) && /900 s leases renewed every 60 s\. Nothing was written/.test(bigBatch.out),
    `…while a batch whose k calls exceed the lease, refused until 031, is not: the heartbeat sizes the lease now, and --dry-run says which (exit ${bigBatch.code})`);
  const badList = await consolidate("--list", "maybe");
  assert(badList.code === 2 && /--list takes pending/.test(badList.out), "a status outside the four is refused");

  // The judge's own model (SMD-1901): unset, the key and the model line name
  // the metadata model and say the knob exists; set, OB1_JUDGE_MODEL moves the
  // pass key and the model line — a fresh pass — while OB1_METADATA_MODEL, the
  // extractor's, stays where it is. A dry run, so nothing is pooled under it.
  assert(keyRe("stub-judge").test(dry.out) && /model:\s+stub-judge \(the metadata model; OB1_JUDGE_MODEL gives the judge its own\) via/.test(dry.out),
         `OB1_JUDGE_MODEL unset: the pass key and the model line name the metadata model (${dry.out.split("\n").filter((l) => /job:|model:/.test(l)).join(" | ").trim().slice(0, 200)})`);
  const ownJudge = await runScript(["bun", join(HERE, "consolidate.ts"), "--url", URL_!, "--dry-run"], { env: { ...env, OB1_JUDGE_MODEL: "judge-b" } as Record<string, string>, cwd: HERE });
  assert(ownJudge.code === 0 && keyRe("judge-b").test(ownJudge.out) && /model:\s+judge-b \(OB1_JUDGE_MODEL\) via/.test(ownJudge.out),
         `OB1_JUDGE_MODEL set: the pass key and the model line name the judge's model (exit ${ownJudge.code}: ${ownJudge.out.split("\n").filter((l) => /job:|model:/.test(l)).join(" | ").trim().slice(0, 200)})`);
  assert(/each with judge-b and/.test(ownJudge.out) && calls === 0, "…the plan names it, and a dry run called no model");

  // The egress gate's blanket refusal (SMD-1903): the stub not declared local
  // under the default would fail every row it claims, so a run stops before
  // claiming; a dry run still reports, its egress line saying why a run would not.
  const undeclared = { ...env } as Record<string, string>;
  // Every gate knob unset, whatever the shell carries (second review pass).
  for (const k of ["OB1_LLM_LOCAL", "OB1_CHAT_LOCAL", "OB1_EGRESS_POLICY", "OB1_EGRESS_ALLOW", "OB1_EGRESS_DENY"]) delete undeclared[k];
  const blanket = await runScript(["bun", join(HERE, "consolidate.ts"), "--url", URL_!], { env: undeclared, cwd: HERE });
  assert(blanket.code === 2 && /Nothing would be judged: OB1_EGRESS_POLICY=deny \(the default\) with no OB1_EGRESS_ALLOW term, and 127\.0\.0\.1:\d+ is not declared local — every call is refused/.test(blanket.out) && /Declare the endpoint local \(OB1_LLM_LOCAL=1\)/.test(blanket.out) && calls === 0,
         `an endpoint not declared local under the default refuses to start the pass rather than fail every row (exit ${blanket.code}: ${blanket.out.split("\n").find((l) => /Nothing would/.test(l))?.trim().slice(0, 160)})`);
  assert((await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = ${KEY}`)[0].c === 0, "…and it claimed nothing");
  // Without a worker key at all (fourth review pass: every keyless invocation
  // had died before connecting on a constant read before its declaration,
  // and no case here ran the worker without one — this is the tooth).
  const keyless = { ...undeclared, OB1_LLM_LOCAL: "1" } as Record<string, string>;
  delete keyless.OB1_WORKER_KEY;
  delete keyless.MCP_ACCESS_KEYS;
  const keylessDry = await runScript(["bun", join(HERE, "consolidate.ts"), "--url", URL_!, "--dry-run"], { env: keyless, cwd: HERE });
  assert(keylessDry.code === 0 && /Nothing was written/.test(keylessDry.out) && !/ReferenceError|before initialization/.test(keylessDry.out),
         `a keyless --dry-run runs to its report (exit ${keylessDry.code}: ${keylessDry.out.split("\n").filter(Boolean).slice(-1)[0]?.trim().slice(0, 120)})`);
  const keylessBlanket = await runScript(["bun", join(HERE, "consolidate.ts"), "--url", URL_!], { env: { ...keyless, OB1_LLM_LOCAL: "", OB1_EGRESS_ALLOW: "actor:someone" } as Record<string, string>, cwd: HERE });
  assert(keylessBlanket.code === 2 && /Nothing would be judged: .*every OB1_EGRESS_ALLOW term \(actor:someone\) names a unit this caller never carries \(it carries source, type, topic, marker\)/.test(keylessBlanket.out),
         `…and a keyless run under actor-only allow terms is refused up front, since it carries no actor (exit ${keylessBlanket.code})`);
  const blanketDry = await runScript(["bun", join(HERE, "consolidate.ts"), "--url", URL_!, "--dry-run"], { env: undeclared, cwd: HERE });
  assert(blanketDry.code === 0 && /egress: deny \(the default\) — the text reaches 127\.0\.0\.1:\d+ only under OB1_EGRESS_ALLOW \(no terms: every call is refused\)/.test(blanketDry.out),
         `…while --dry-run still reports, with the egress line saying so (exit ${blanketDry.code})`);

  // The first run. Five pairs are judged, one of them (the hemlock pair) drawing prose.
  // A 6 s lease with a 1 s heartbeat, and 700 ms verdicts — five pairs across
  // two workers, some three and a half seconds of model time — so the beats
  // fire during the run, and the summary counts them.
  slowMs = 700;
  const first = await consolidate("--workers", "2", "--dump", dump, "--ttl", "6", "--heartbeat", "1");
  slowMs = 0;
  const firstBeats = Number(/, (\d+) heartbeat\(s\)/.exec(first.out)?.[1] ?? 0);
  assert(firstBeats >= 1 && !/heartbeat failed/.test(first.out) && !/attempt 2/.test(first.out),
    `the heartbeat beats through the first pass without error, and no row reaches a second worker (${firstBeats} beat(s))`);
  assert(first.code === 1 && /10 thought\(s\) judged, 1 failed/.test(first.out),
         `the first run judges ten thoughts and fails the one whose pair drew prose (exit ${first.code}: ${first.out.split("\n").find((l) => /judged,/.test(l))?.trim()})`);
  assert(/5 pair\(s\) judged — 0\.45 per thought judged, 455 calls per thousand thoughts; 6 thought\(s\) had no candidate; verdicts: 1 agree, 0 unrelated, 3 conflict/.test(first.out) && /1 answer\(s\) not JSON of the expected shape/.test(first.out),
         `…five pairs (one per newer thought with an older neighbour), one malformed, and the six older thoughts with nothing older to compare against (${first.out.split("\n").find((l) => /pair\(s\) judged/.test(l))?.trim()})`);
  assert(/2 proposal\(s\) recorded \(1 without a direction\), 1 conflict\(s\) under confidence 0\.5 not recorded/.test(first.out),
         `…two proposals recorded, one undirected, one conflict too weak to record (${first.out.split("\n").find((l) => /proposal\(s\) recorded/.test(l))?.trim()})`);
  assert(/calls per thousand thoughts/.test(first.out) && /model time per pair/.test(first.out), "…and the cost line: calls per thousand thoughts and model time per pair");
  assert(modelsSeen.size === 1 && modelsSeen.has("stub-judge"), `every judge request named the metadata model, OB1_JUDGE_MODEL being unset (${[...modelsSeen].join(", ")})`);
  const callsAfterFirst = calls;
  assert(seen.every((p) => !/nothing has extracted/.test(p.a + p.b) && !/embedding failed/.test(p.a + p.b)), "neither the thought without entities nor the one without a vector was shown to the judge");
  assert(seen.some((p) => /monthly/.test(p.a) && /annually/.test(p.b)) && !seen.some((p) => /annually/.test(p.a)),
         "each pair is shown older as A and newer as B");
  const [agent] = await sql`SELECT canonical_agent_id AS id FROM ob1_agents WHERE label = 'consolidator'`;
  assert(agent?.id != null, "the worker resolved itself to a stable agent id under its key's name");
  const p1 = await proposals();
  assert(p1.length === 2 && p1.every((p) => p.status === "pending" && p.judge_key === KEY && p.canonical_agent_id === agent.id),
         `two pending proposals, each carrying the judge key and the agent id (${JSON.stringify(p1.map((p) => [p.verdict, p.confidence, p.judge_key])) })`);
  const directed = p1.find((p) => p.verdict === "newer_supersedes_older")!;
  const undirected = p1.find((p) => p.verdict === "conflict_undirected")!;
  assert(directed?.older_id === decision && directed.newer_id === reversal && Number(directed.confidence) === 0.92, "the billing pair is proposed newer-supersedes-older at the judge's confidence");
  assert(undirected?.older_id === blue && undirected.newer_id === green, "the colour pair is proposed without a direction");
  const c1 = await claimCounts();
  assert(c1.succeeded === 10 && c1.failed === 1, `claims: 10 succeeded, 1 failed (${JSON.stringify(c1)})`);
  const [{ err }] = await sql`SELECT last_error AS err FROM thought_work_claims WHERE work_type = ${KEY} AND thought_id = ${hemlockNewer}::uuid`;
  assert(/1 of 1 pair\(s\) not judged/.test(err) && /not JSON/.test(err), `the failed row says which pair and why (${err})`);
  const lines = readFileSync(dump, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { verdict: string; recorded: string | null; proposal: string | null; key: string });
  assert(lines.length === 4 && lines.every((l) => l.key === KEY), `the dump holds every parseable verdict, four, under the key — the malformed answer is not a verdict (${lines.length})`);
  assert(lines.filter((l) => l.recorded === "proposed").length === 2 && lines.filter((l) => l.recorded === "under-confidence").length === 1 && lines.filter((l) => l.verdict === "agree").length === 1,
         "…two proposed, one under confidence, one agree");
  assert((await sql`SELECT count(*)::int AS c FROM thoughts WHERE supersedes IS NOT NULL`)[0].c === 0, "the pass wrote nothing to thoughts.supersedes — it proposes");

  // --status, then a second run over an unchanged corpus.
  const status = await consolidate("--status");
  assert(status.code === 0 && /11 thoughts with entities — 10 judged, 1 failed/.test(status.out) && /queue: 2 pending \(1 without a direction\), 0 accepted, 0 rejected/.test(status.out),
         `--status reports the pass and the queue (${status.out.split("\n").filter((l) => /status:|queue:/.test(l)).join(" | ").trim()})`);
  const second = await consolidate();
  assert(second.code === 1 && /0 thought\(s\) judged, 0 failed/.test(second.out) && calls === callsAfterFirst, "a second run has nothing to judge, makes no call, and still exits 1 for the failed row");

  // --list prints both thoughts, the IDs, and the decision each row takes.
  const list = await consolidate("--list");
  assert(list.code === 0 && /2 pending proposal\(s\)/.test(list.out) && /the NEWER thought supersedes the older/.test(list.out) && /conflict, direction not stated/.test(list.out),
         "--list names both verdicts");
  assert(list.out.includes(`ID: ${reversal}`) && list.out.includes(`ID: ${decision}`) && list.out.includes(`--accept ${directed.id}`) && list.out.includes(`--accept ${undirected.id} --direction <newer|older>`),
         "…with the thought ids and the accept command, asking for a direction where the judge gave none");

  // The review path, through the worker's flags, audited under the key's name.
  const needDir = await consolidate("--accept", undirected.id);
  assert(needDir.code === 1 && /pass --direction newer or --direction older/.test(needDir.out), "accepting the undirected proposal without a direction is refused with the fix");
  assert((await supersedesOf(green)) === null, "…and nothing was written");
  const accUndirected = await consolidate("--accept", undirected.id, "--direction", "newer");
  assert(accUndirected.code === 0 && new RegExp(`accepted ${undirected.id}: ${green} now supersedes ${blue}`).test(accUndirected.out), "…with a direction it is accepted");
  assert((await supersedesOf(green)) === blue, "…and green supersedes blue");
  const accDirected = await consolidate("--accept", directed.id, "--note", "confirmed in the June minutes");
  assert(accDirected.code === 0 && (await supersedesOf(reversal)) === decision, "the directed proposal is accepted as the judge directed it");
  const audits = await sql`
    SELECT actor_name, canonical_agent_id, author_session_id, diff FROM thought_audit
    WHERE action = 'update' AND thought_id IN (${green}::uuid, ${reversal}::uuid) ORDER BY id`;
  assert(audits.length === 2 && audits.every((a: { actor_name: string; canonical_agent_id: string; author_session_id: string }) => a.actor_name === "consolidator" && a.canonical_agent_id === agent.id && a.author_session_id === KEY),
         `each acceptance is one audit row under the worker's key name, agent id and pass key (${JSON.stringify(audits.map((a: { actor_name: string }) => a.actor_name))})`);
  assert(audits.every((a: { diff: { supersedes?: { after?: string } } }) => a.diff.supersedes?.after !== undefined), "…whose diff is the supersedes pointer");
  const again = await consolidate("--accept", directed.id);
  assert(again.code === 1 && /already accepted/.test(again.out), "accepting twice is refused");
  const rej = await consolidate("--reject", directed.id, "--note", "misread");
  assert(rej.code === 0 && /the supersedes pointer this proposal had set is cleared/.test(rej.out) && (await supersedesOf(reversal)) === null,
         "rejecting an accepted proposal clears the pointer it set");
  const p2 = await proposals();
  assert(p2.find((p) => p.id === directed.id)?.status === "rejected" && p2.find((p) => p.id === undirected.id)?.status === "accepted" && p2.find((p) => p.id === undirected.id)?.superseding_id === green,
         "the rows say rejected and accepted, the accepted one naming the thought it wrote");
  // The staleness guard through the CLI: edit the older thought after the
  // verdict, and the queue marks it, accept refuses with the fix, --force
  // without --accept is refused, --accept --force writes, and a reject
  // clears (review pass 4 pinned what pass 3 promised).
  await sql`SELECT update_thought(${decision}::uuid, ${"We bill monthly, decided in March (minutes attached)."}, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text)`;
  const listEdited = await consolidate("--list", "all");
  assert(/older \[[0-9-]+\] EDITED SINCE JUDGED/.test(listEdited.out) && listEdited.out.includes(`--accept ${directed.id} --force`) === false,
         `--list marks the edited side (the directed pair is rejected, so no accept line for it) (${listEdited.out.split("\n").find((l) => /EDITED SINCE/.test(l))?.trim()})`);
  const staleAccept = await consolidate("--accept", directed.id);
  assert(staleAccept.code === 1 && /older thought has been edited since the pair was judged/.test(staleAccept.out) && /pass --force/.test(staleAccept.out) && (await supersedesOf(reversal)) === null,
         "accepting a pair whose text moved is refused, naming the side and the flag, and writes nothing");
  const forceAlone = await consolidate("--reject", directed.id, "--force");
  assert(forceAlone.code === 2 && /--force goes with --accept/.test(forceAlone.out), "--force without --accept is refused");
  const forced = await consolidate("--accept", directed.id, "--force");
  assert(forced.code === 0 && (await supersedesOf(reversal)) === decision, "--accept --force writes the pointer");
  const unforced = await consolidate("--reject", directed.id);
  assert(unforced.code === 0 && (await supersedesOf(reversal)) === null, "…and the reject clears it again");

  const statusAfter = await consolidate("--status");
  assert(/queue: 0 pending \(0 without a direction\), 1 accepted, 1 rejected/.test(statusAfter.out), "--status counts the decisions");

  // --retry-failed re-judges the failed thought's pairs.
  hemlockIsProse = false;
  const retried = await consolidate("--retry-failed");
  assert(retried.code === 0 && /1 thought\(s\) judged, 0 failed/.test(retried.out) && /1 pair\(s\) judged/.test(retried.out), `--retry-failed judges the one failed thought and exits 0 (exit ${retried.code})`);

  // Start over (the claim rows cleared by hand, 015's rule): the rejected pair
  // and the accepted pair are never judged again — the candidate rule, not
  // the claim table, remembers — and the rest are.
  await sql`DELETE FROM thought_work_claims WHERE work_type = ${KEY}`;
  seen.length = 0;
  const over = await consolidate();
  // Nine, not eleven: blue, which green now supersedes, and the decision,
  // whose edit through update_thought above replaced its text with no vector
  // (the tool's re-embed is the server's job) — both out by the pool rule.
  assert(over.code === 0 && /9 thought\(s\) judged/.test(over.out), `with the claim rows cleared every pooled thought is judged again — all but the superseded one and the one whose edit left it vectorless (exit ${over.code}: ${over.out.split("\n").find((l) => /judged,/.test(l))?.trim()})`);
  assert(!seen.some((p) => /monthly/.test(p.a) && /annually/.test(p.b)), "…but the rejected pair is not shown to the judge again");
  assert(!seen.some((p) => /blue/.test(p.a) || /green/.test(p.b)), "…nor the accepted pair, whose thoughts are now superseded and superseding");
  assert(seen.some((p) => /deploy/.test(p.a)), "…while an undecided pair is");
  assert((await proposals()).length === 2, "…and no proposal was added: the pairs that would conflict are decided");

  // The pool rule: a thought extracted after the run is judged by the next one.
  await sql`SELECT record_thought_entities(${noEntities}::uuid, ${EXTRACT}, ${[{ name: "billing", type: "topic", confidence: 0.9 }]}::jsonb, '[]'::jsonb, NULL, NULL)`;
  const late = await consolidate();
  assert(late.code === 0 && /pool: 1 thought\(s\) added/.test(late.out) && /1 thought\(s\) judged/.test(late.out), "a thought extracted since the last run is pooled and judged by the next");

  // Staleness: reported, not acted on.
  const stale = await consolidate("--stale", "20");
  assert(stale.code === 0 && /1 entity nothing has mentioned in 20 days/.test(stale.out) && /archive/.test(stale.out), `--stale names the quiet subject (${stale.out.split("\n").find((l) => /stale:/.test(l))?.trim()})`);
  assert(/no entity has gone 60 days/.test((await consolidate("--stale", "60")).out), "…and none at a wider window");

  // The worker never wrote thought_audit itself: the three rows under its name
  // are the two acceptances and the rejection's clearing.
  const [{ n: actorRows }] = await sql`SELECT count(*)::int AS n FROM thought_audit WHERE actor_name = 'consolidator'`;
  assert(Number(actorRows) === 5, `the worker's audit rows are exactly the reviews: three accepts and two cleared rejects (${actorRows})`);

  // SMD-1803: the CLI's day() over a proposal thought with no ISO-form date.
  // Every --list above ran on real dates, where the pre-fix new Date().toISOString()
  // and the fix agree — so a revert of db/consolidate.ts's null/infinity handling
  // survives every assertion so far. Plant an infinity- and a NULL-dated thought,
  // propose the pair, and list it: pre-fix, day() throws on the infinity row and
  // the whole --list exits non-zero; the NULL row fabricates 1970-01-01.
  {
    const infId = await seed("smd-1803 live: proposal thought dated infinity", 7, 0);
    const nullId = await seed("smd-1803 live: proposal thought undated", 8, 0);
    await sql`UPDATE thoughts SET created_at = 'infinity' WHERE id = ${infId}::uuid`;
    await sql`UPDATE thoughts SET created_at = NULL WHERE id = ${nullId}::uuid`;
    await sql`SELECT record_supersession_proposal(${infId}::uuid, ${nullId}::uuid, 'conflict_undirected', 0.7, 'infinity vs undated', 0.9, ${KEY}, NULL)`;
    const oddList = await consolidate("--list", "all");
    assert(oddList.code === 0, `--list does not crash on a proposal thought with no ISO-form date (exit ${oddList.code}: ${oddList.out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200)})`);
    assert(/older \[infinity\]/.test(oddList.out) && /newer \[undated\]/.test(oddList.out),
           `…the CLI's day() renders infinity and NULL as their own text (${oddList.out.split("\n").filter((l) => /\[(infinity|undated|Invalid|1970)/.test(l)).join(" | ").slice(0, 200)})`);
    assert(!/\[1970-01-01\]/.test(oddList.out) && !/Invalid Date/.test(oddList.out), "…and fabricates no epoch date");
  }

  judge.stop(true);
  try { unlinkSync(dump); } catch { /* already gone */ }
  await sql`DELETE FROM thoughts`;
  await sql`DELETE FROM ob1_entities`;
}

console.log("\n[17] Over near-equidistant vectors the HNSW walk misses live rows an exact scan would find, and db/hnsw-graph.ts reads why from the index itself (SMD-1632)");
{
  // Why [7]'s found-by reads flaked, reproduced deterministically. Over the
  // suite's orthogonal unit axes (every pair at cosine distance 1.0) pgvector's
  // HNSW graph is not connected, so a search from the entry point misses a live
  // row its own vector matches — the mechanism db/hnsw-graph.ts and FORK change
  // 83 explain, and the shape [4]/[11]/[15] share, which is why their reads
  // moved to match_thoughts' exact branch. Two things are asserted here: the
  // OBSERVABLE (a search of a row's own axis does not return it), robust at well
  // over 100 of 120 misses whatever the build; and that the decoder is SOUND
  // (every row it calls unreachable is one the walk misses). The hole's size
  // varies build to build (0 to ~860 of 1024), so it is reported, not gated on.
  //
  // First, deterministic teeth for the reachability logic from a synthetic
  // graph: a search reaches a node through edges at the right level, so
  // `reachableFromEntry` must follow every level's lists, not level 0 alone (the
  // DB soundness sample below cannot enforce that — on the degenerate corpus a
  // level-0-only walk is nearly indistinguishable). E reaches A only via its
  // level-1 edge and B only via A's level-0 edge, so a level-0-only walk from E
  // misses both. (Byte-offset coverage of the page decode is SMD-1673.)
  {
    const el = (tid: string, level: number, neighbors: string[][]): HnswElement =>
      ({ tid, blkno: 1, offno: 1, level, deleted: false, version: 1, heaptids: [tid], neighborTid: tid, neighbors, level0Slots: 32 });
    const g: HnswGraph = {
      index: "synthetic", pages: 0,
      meta: { magic: 0, version: 1, dimensions: EMBEDDING_DIM, m: 16, efConstruction: 64, entry: "E", entryLevel: 1, insertPage: 0 },
      elements: new Map<string, HnswElement>([
        ["E", el("E", 1, [[], ["A"]])], // level-0 list empty; level-1 list → A
        ["A", el("A", 1, [["B"], []])], // level-0 list → B
        ["B", el("B", 0, [[]])],
      ]),
    };
    const reach = reachableFromEntry(g);
    assert(reach.has("A") && reach.has("B"),
           `reachableFromEntry follows upper-level edges: E→A (level 1)→B (level 0) both reached (${[...reach].sort().join(",")}) — a level-0-only walk would miss them`);
  }

  await sql`CREATE EXTENSION IF NOT EXISTS pageinspect`;

  // Orthogonal unit vectors, one per axis, all mutually at distance 1.0 — as
  // many as the width, the scale where a hole is all but certain. One INSERT so
  // the section stays quick; REINDEX first so the graph is exactly this corpus,
  // not this plus the dead elements earlier sections left unvacuumed.
  await sql`DELETE FROM thoughts`;
  await sql.unsafe(`REINDEX INDEX thoughts_embedding_idx`);
  const N = EMBEDDING_DIM;
  const unitVals = Array.from({ length: N }, (_, i) => `('axis ${i}', '${unit(i)}'::vector)`).join(",");
  await sql.unsafe(`INSERT INTO thoughts (content, embedding) VALUES ${unitVals}`);
  const axisOfCtid = new Map<string, number>();
  for (const r of (await sql`SELECT content, ctid::text AS c FROM thoughts`) as { content: string; c: string }[]) axisOfCtid.set(r.c, Number(r.content.slice(5)));

  // Since migration 039 the index is over `embedding::halfvec(D)`, so a walk
  // that uses it must order by that cast (as match_thoughts does); the raw
  // `embedding <=> query` seqscans and would find every row exactly, which is
  // not the index walk this section is about ([5] asserts the cast is the key).
  const idxWalk = (q: string) => `embedding::halfvec(${EMBEDDING_DIM}) <=> '${q}'::vector::halfvec(${EMBEDDING_DIM})`;
  /** Does a bounded relaxed walk of `axis` return the row whose vector is unit(axis)? */
  const walkFinds = async (axis: number, want: string) => {
    const got = await sql.begin(async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL enable_seqscan = off`);
      await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return (await tx.unsafe(`SELECT ctid::text AS c FROM thoughts ORDER BY ${idxWalk(unit(axis))} LIMIT 1`)) as { c: string }[];
    });
    return got.length > 0 && got[0].c === want;
  };
  const ctidOfAxis = new Map<number, string>();
  for (const [c, a] of axisOfCtid) ctidOfAxis.set(a, c);
  const sampleMiss = async () => { let miss = 0; const S = 120; for (let i = 0; i < S; i++) { const a = Math.floor((i * N) / S); if (!(await walkFinds(a, ctidOfAxis.get(a)!))) miss++; } return { miss, S }; };

  const before = await sampleMiss();
  const holed = await reachabilityReport(sql, "thoughts_embedding_idx", "thoughts");
  assert(holed.entry !== null && holed.visible === N && holed.rowsWithoutElement === 0,
         `the ${N}-row index parsed: an entry point and an element for every live row (entry ${holed.entry}, ${holed.visible} visible of ${holed.elements} elements, ${holed.rowsWithoutElement} rows without)`);
  // The degenerate-geometry miss needs more orthogonal axes than the ef≈40 beam
  // explores; the default width (1024) has them, a small OB1_EMBEDDING_DIM might
  // not — below 256 the beam finds a large fraction and this observable would
  // not bite, so it is skipped rather than flaked. CI runs the default width;
  // the synthetic assertion above and [5b] are width-independent.
  const wideEnough = N >= 256;
  if (wideEnough)
    assert(before.miss >= before.S / 2,
           `a search of a row's own axis misses it on most axes: ${before.miss} of ${before.S} — the walk over the tied corpus [7] met (decoder reports ${holed.unreachableVisible.length}/${holed.visible} unreachable) (SMD-1632)`);
  else
    skip("a search of a row's own axis misses it on most axes", `OB1_EMBEDDING_DIM=${N} is below 256 — too few orthogonal axes to disconnect the graph past the ef beam`);

  // The decoder is SOUND: every row it calls unreachable is one the walk misses.
  // (Reachable is not found — the bounded beam misses more — so this checks the
  // one direction that must hold; vacuous only in the rare fully connected build.)
  let checked = 0, foundAnUnreachable = false;
  for (const u of holed.unreachableVisible) {
    if (checked >= 100) break; // a sample bounds the round trips
    const axis = axisOfCtid.get(u.heaptids[0]);
    if (axis === undefined) continue;
    checked++;
    if (await walkFinds(axis, u.heaptids[0])) { foundAnUnreachable = true; break; }
  }
  assert(!foundAnUnreachable,
         `every row the decoder calls unreachable is one the walk misses (${checked} of ${holed.unreachableVisible.length} checked) — unreachable ⇒ not found`);

  // REINDEX is not the remedy for this geometry: a rebuild of an all-equidistant
  // graph misses just as much, so the observable does not improve — the ticket's
  // assumed fix does not hold for near-degenerate data.
  await sql.unsafe(`REINDEX INDEX thoughts_embedding_idx`);
  const after = await sampleMiss();
  if (wideEnough)
    assert(after.miss >= after.S / 2,
           `after REINDEX the walk still misses most axes (${after.miss} of ${after.S}) — a rebuild of an equidistant graph is no more reachable, so REINDEX is not the fix the ticket assumed`);
  else
    skip("after REINDEX the walk still misses most axes", `OB1_EMBEDDING_DIM=${N} is below 256`);

  // A production-shaped corpus — random unit vectors, a range of distances — is
  // fully reachable AND fully found: the pathology needs a corpus DOMINATED by
  // near-equidistant vectors, which real embeddings are not.
  await sql`DELETE FROM thoughts`;
  await sql.unsafe(`REINDEX INDEX thoughts_embedding_idx`);
  const { unitVector } = seededRandom(1632);
  const R = 2000;
  const randVecs: string[] = [];
  for (let i = 0; i < R; i += 100) {
    const vals = Array.from({ length: 100 }, (_, k) => { const v = `[${unitVector(EMBEDDING_DIM).join(",")}]`; randVecs.push(v); return `('rr ${i + k}', '${v}'::vector)`; }).join(",");
    await sql.unsafe(`INSERT INTO thoughts (content, embedding) VALUES ${vals}`);
  }
  const ctidOfRr = new Map<number, string>();
  for (const r of (await sql`SELECT content, ctid::text AS c FROM thoughts`) as { content: string; c: string }[]) ctidOfRr.set(Number(r.content.slice(3)), r.c);
  const random = await reachabilityReport(sql, "thoughts_embedding_idx", "thoughts");
  assert(random.visible === R && random.unreachableVisible.length === 0,
         `a ${R}-row random corpus is fully reachable (${random.reachable}/${random.visible}, ${random.unreachableVisible.length} unreachable) — the hole is the degenerate geometry's, not the index's`);
  let rMiss = 0; const RS = 120;
  for (let i = 0; i < RS; i++) {
    const idx = Math.floor((i * R) / RS);
    const got = await sql.begin(async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL enable_seqscan = off`);
      await tx.unsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return (await tx.unsafe(`SELECT ctid::text AS c FROM thoughts ORDER BY ${idxWalk(randVecs[idx])} LIMIT 1`)) as { c: string }[];
    });
    if (!(got.length > 0 && got[0].c === ctidOfRr.get(idx))) rMiss++;
  }
  assert(rMiss <= 2, `and a search of each random row's own vector returns it (${rMiss} of ${RS} missed; a rare bounded-beam miss is allowed, the contrast with the ${before.miss} unit misses is the point) — the walk is sound where the geometry is not degenerate`);

  // The reader also gives the meta page a next occurrence should dump (entry
  // block and level) — proven callable here.
  const g = await readHnswGraph(sql, "thoughts_embedding_idx");
  assert(g.meta.entry !== null && reachableFromEntry(g).size > 0, "the decoder reads the meta page's entry point and walks from it");

  await sql`DELETE FROM thoughts`;
}

// ── 18. The community schemas over TCP ───────────────────────────────────────

console.log("\n[18] Every schemas/*.sql applies over TCP with no Supabase role present, and migrate.ts --grant makes a LOGIN role able to use them (SMD-1796)");
{
  // test-schema [40] is the PGlite half of this; here is what PGlite cannot do:
  // the migrator's --grant over TCP — its presence probe against a real
  // server's to_regclass/to_regprocedure, its "not yet present, skipped" list
  // before the files are applied and its full list after — and a role that
  // CONNECTS as itself rather than SET ROLE. Same files, same order as [40].
  // Last in the suite because the files add a trigger and columns to `thoughts`.
  // In CI one service container serves every live suite in turn, so this
  // section puts the database back as it found it: the tables, views and
  // functions the files added are read from the catalog before and after and
  // dropped in the finally. What it cannot put back goes with the next suite's
  // dropSchema (which also names the community tables should a run die here):
  // the columns the files add to `thoughts`, and the indexes they build on
  // migration-owned tables — enhanced-thoughts' five and provenance-chains'
  // one on `thoughts`, entity-extraction's two on thought_entities,
  // thought-audit's one whose name 008 does not already use
  // (thought_audit_session_id_idx; its other two and text-search-trgm's are
  // the migrations' own names, so IF NOT EXISTS adds nothing) — a kept
  // database (OB1_PG_KEEP) keeps those.
  const catalog = async () => ({
    tables: new Set(((await sql`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`) as { n: string }[]).map((r) => r.n)),
    views: new Set(((await sql`SELECT viewname AS n FROM pg_views WHERE schemaname = 'public'`) as { n: string }[]).map((r) => r.n)),
    fns: new Set(((await sql`SELECT p.oid::regprocedure::text AS n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`) as { n: string }[]).map((r) => r.n)),
  });
  const before18 = await catalog();
  const restore = async () => {
    const after18 = await catalog();
    for (const v of after18.views) if (!before18.views.has(v)) await sql.unsafe(`DROP VIEW IF EXISTS ${v} CASCADE`);
    for (const t of after18.tables) if (!before18.tables.has(t)) await sql.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
    for (const f of after18.fns) if (!before18.fns.has(f)) await sql.unsafe(`DROP FUNCTION IF EXISTS ${f} CASCADE`);
  };
  const SCHEMAS = SCHEMAS_DIR;
  const schemaFiles = communitySchemaFiles();
  const [{ c: supabaseRoles }] = (await sql`SELECT count(*)::int AS c FROM pg_roles WHERE rolname IN ('authenticated', 'anon', 'service_role')`) as { c: number }[];
  assert(supabaseRoles === 0, "no Supabase role exists on this server");

  const ROLE = "ob1_live_community";
  const ROLE_URL = URL_.replace(/\/\/[^@]*@/, `//${ROLE}:ob1community@`);
  const [{ mayCreate }] = (await sql`SELECT (rolsuper OR rolcreaterole) AS "mayCreate" FROM pg_roles WHERE rolname = current_user`) as { mayCreate: boolean }[];
  const dropRole = () => sql.unsafe(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      EXECUTE 'DROP OWNED BY ${ROLE}'; EXECUTE 'DROP ROLE ${ROLE}';
    END IF; END $$`);
  if (ROLE_URL === URL_) {
    skip("a LOGIN role granted by migrate.ts --grant uses the community schemas", "DATABASE_URL carries no credentials to swap for the role's");
  } else if (!mayCreate) {
    skip("a LOGIN role granted by migrate.ts --grant uses the community schemas", "the connection's role cannot CREATE ROLE");
  } else {
    await dropRole();
    let asRole: SQL | null = null;
    try {
      await sql.unsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'ob1community'`);

      // Before the files: --grant --dry-run knows the community objects are
      // absent — every one named as skipped, none granted — while the
      // migrations' own tables are granted. The presence probe, over TCP.
      const dry = await migrate("--grant", ROLE, "--dry-run");
      const skippedLine = dry.out.split("\n").find((l) => /not yet present, skipped/.test(l)) ?? "";
      const communityTables = grantedTables(["community"]).filter((t) => t !== "thought_audit" && t !== "thought_entities");
      assert(dry.code === 0 && communityTables.every((t) => skippedLine.includes(t)) && grantedViews(["community"]).every((v) => skippedLine.includes(v)) && grantedSequences(["community"]).every((s) => skippedLine.includes(s)) && grantedFunctions(["community"]).every((f) => skippedLine.includes(f)),
             `before the files are applied, --grant --dry-run names every community table, view, sequence and function as not yet present (exit ${dry.code}; ${skippedLine.length} chars of skipped list)`);
      assert(!/ON SEQUENCE|ON FUNCTION|agent_memories/.test(dry.out.replace(skippedLine, "")) && /GRANT SELECT, INSERT, UPDATE, DELETE ON thoughts TO "ob1_live_community";/.test(dry.out),
             "…grants nothing of the community group, and grants the migrations' tables");

      const failed: string[] = [];
      for (const f of schemaFiles) {
        try { await sql.unsafe(readFileSync(join(SCHEMAS, f), "utf8")); }
        catch (e) { failed.push(`${f}: ${(e as Error).message.split("\n")[0]}`); }
      }
      assert(schemaFiles.length >= 14 && failed.length === 0, `every schemas/*.sql applies over TCP with no Supabase role (${schemaFiles.length} files; failed: ${failed.join(" | ") || "none"})`);

      // After: --grant issues the whole community group, over TCP, in one
      // transaction — views as tables, sequences and functions spelled as GRANT
      // takes them.
      const grant = await migrate("--grant", ROLE);
      assert(grant.code === 0 && !/not yet present/.test(grant.out) && /over \d+ object\(s\)/.test(grant.out),
             `--grant issues everything, nothing skipped (exit ${grant.code}: ${grant.out.trim().split("\n").find((l) => /Granted/.test(l)) ?? grant.out.trim().split("\n").slice(-1)[0]})`);
      assert(/GRANT USAGE, SELECT ON SEQUENCE ingestion_jobs_id_seq TO "ob1_live_community";/.test(grant.out) && /GRANT EXECUTE ON FUNCTION wiki_accept_pending\(uuid, text\) TO "ob1_live_community";/.test(grant.out) && /GRANT SELECT, INSERT ON thought_audit TO "ob1_live_community";/.test(grant.out),
             "…a sequence, a function with its argument types, and thought_audit's merged capture + community privileges among them");

      // The role, connecting as itself. An INSERT of DEFAULT VALUES asks for
      // every privilege an insert needs and nothing else ([40]'s probe): a
      // permission error means the grant is short; a NOT NULL or foreign-key
      // error, or success, means it is not.
      asRole = new SQL({ url: ROLE_URL, max: 1 });
      const denied: string[] = [];
      for (const t of grantedTables(["community"])) {
        try { await asRole.unsafe(`INSERT INTO ${t} DEFAULT VALUES`); }
        catch (e) { if (/permission denied/.test((e as Error).message)) denied.push(`${t}: ${(e as Error).message.split("\n")[0]}`); }
      }
      assert(denied.length === 0, `the role's INSERT into every community table gets past privileges (${grantedTables(["community"]).length} tables; denied: ${denied.join("; ") || "none"})`);
      let viewDenied = "";
      for (const v of grantedViews(["community"])) {
        try { await asRole.unsafe(`SELECT 1 FROM ${v} LIMIT 0`); } catch (e) { viewDenied += `${v}: ${(e as Error).message.split("\n")[0]}; `; }
      }
      assert(viewDenied === "", `…and reads the community view through its own SELECT grant (denied: ${viewDenied || "none"})`);
      const seqDenied: string[] = [];
      for (const s of grantedSequences(["community"])) {
        try { await asRole.unsafe(`SELECT nextval('${s}')`); } catch (e) { seqDenied.push(s); }
      }
      assert(seqDenied.length === 0, `…and takes a value from each of the ${grantedSequences(["community"]).length} listed sequences (denied: ${seqDenied.join(", ") || "none"})`);
      // (one call per function: Bun binds a JS array as a comma-joined string,
      // not a Postgres array — migrate.ts's sql.array() is the other way round)
      const fnDenied: string[] = [];
      for (const n of grantedFunctions(["community"])) {
        const [{ ok }] = (await sql`SELECT has_function_privilege(${ROLE}, to_regprocedure(${"public." + n}), 'EXECUTE') AS ok`) as { ok: boolean }[];
        if (!ok) fnDenied.push(n);
      }
      assert(fnDenied.length === 0, `…and may EXECUTE each of the ${grantedFunctions(["community"]).length} listed functions (denied: ${fnDenied.join(", ") || "none"})`);
      // and the one call a community RPC makes for real: wiki_upsert_page, as
      // the role — SECURITY INVOKER, REVOKEd FROM PUBLIC, writing wiki_pages
      const page = (await asRole.unsafe(`SELECT wiki_upsert_page('smd-1796', 'Granted', 'topic', '{}'::jsonb, 'test-live') AS r`)) as { r: { page_id: string; created: boolean } }[];
      assert(typeof page[0]?.r?.page_id === "string", `…and calls wiki_upsert_page through its grant, writing wiki_pages as itself (${JSON.stringify(page[0]?.r)})`);
      let rewrite = "";
      try { await asRole.unsafe(`UPDATE wiki_section_revisions SET body_md = '' WHERE false`); } catch (e) { rewrite = (e as Error).message; }
      assert(/permission denied/.test(rewrite), `…but cannot UPDATE wiki_section_revisions — append-only, as upstream had it (${rewrite.split("\n")[0] || "the UPDATE was allowed"})`);

      // The rollback path, over TCP: --grant connected as THIS role — every
      // privilege held, none with grant option — granting a third role. Every
      // GRANT "succeeds" with a warning and no effect, the verify inside the
      // transaction finds the third role holding nothing, and --grant exits 1
      // naming it, with nothing committed (the third pass's check, run through
      // Bun's begin/rollback rather than reasoned about — fourth pass).
      await sql.unsafe(`CREATE ROLE ob1_live_third NOLOGIN`);
      try {
        const weak = await runMigrator(ROLE_URL, undefined, "--grant", "ob1_live_third");
        assert(weak.code === 1 && /were not granted/.test(weak.out) && /Not held by ob1_live_third/.test(weak.out) && /Connect as the objects' owner/.test(weak.out) && !/permission denied/.test(weak.out),
               `--grant run as a role without grant option exits 1 and names what was not granted, without the 42501 hint (exit ${weak.code}: ${(weak.out.split("\n").find((l) => /not granted/.test(l)) ?? weak.out).trim().slice(0, 140)})`);
        const [{ held }] = (await sql`SELECT has_table_privilege('ob1_live_third', 'public.thought_audit', 'SELECT') AS held`) as { held: boolean }[];
        assert(held === false, "…and the third role holds nothing: the transaction rolled back");
      } finally {
        await sql.unsafe(`DROP OWNED BY ob1_live_third; DROP ROLE ob1_live_third`);
      }
    } finally {
      if (asRole) await asRole.close();
      await dropRole();
    }
  }
  await restore();
  const left = await catalog();
  assert(left.tables.size === before18.tables.size && left.views.size === before18.views.size && left.fns.size === before18.fns.size,
    `the section leaves the database's tables, views and functions as it found them (${left.tables.size}/${left.views.size}/${left.fns.size})`);
}

/** A corpus dump's record for an issue (SMD-1958): the shape the sync fetches, through the same adapter; `fetchedAt` is the dump's build instant, absent for a dump with no second clock. [19], [22] and [23]. */
const dumpOf = (issue: LinearIssue, fetchedAt?: string): LinearDoc => ({ id: issue.identifier, title: issue.title, text: issue.description ?? "", labels: labelNames(issue), createdAt: issue.createdAt, issue, ...(fetchedAt ? { fetchedAt } : {}) });

/**
 * The board sync's per-ticket unit over the REAL store (server-portable/store-sql.ts
 * — upsert_thought, update_thought, 050's stamp, 053's structure hook and
 * identity lookup) with the two model calls faked and counted: what [22] and
 * [23] converge on is the text, the facets and the structure the two writers
 * write, which the self-check's fakes cannot show. `syncIssue` is the sync's
 * per-ticket unit; the census and the fetch it sits behind are Linear's side.
 * `unitIndex` picks the fake vector, so two harnesses' rows stay distinct.
 */
function syncHarness(unitIndex: number) {
  const store = new SqlStore(URL_!, { max: 1 });
  const calls: string[] = [];
  const brainRow = async (rows: Promise<unknown[]>) => ((await rows)[0] as BrainRow | undefined) ?? null;
  const writer: Writer = {
    store,
    cfg: resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_EGRESS_POLICY: "off" }),
    embed: async () => { calls.push("embed"); return { embedding: JSON.parse(unit(unitIndex)) as number[], model: EMBEDDING_MODEL, chunks: [] }; },
    tags: async () => { calls.push("tags"); return { type: "task", topics: ["zqtopic"] }; },
    fingerprintOf: async (t) => (await sql`SELECT content_fingerprint_of(${t}) AS f`)[0].f as string,
    holderOf: (fp) => brainRow(sql`SELECT id::text AS id, content, metadata, created_at::text AS created_at, supersedes::text AS supersedes, content_fingerprint AS fingerprint FROM thoughts WHERE content_fingerprint = ${fp} LIMIT 1`),
    holderOfIdentity: (system, key) => brainRow(sql`SELECT id::text AS id, content, metadata, created_at::text AS created_at, supersedes::text AS supersedes, content_fingerprint AS fingerprint FROM thoughts WHERE id = source_thought(${system}, ${key})`),
    actor: { name: SYNC_ACTOR, via: "test-live" },
    dryRun: false,
    log: () => {},
    structure: async (id, s) => { await sql.begin(async (tx) => { await recordStructure(tx, id, s, "test-live@sync", { take: true }); }); },
  };
  // A dump built NOW, by the brain's clock — `fetchedAt` is compared with the
  // row's updated_at, and the container's clock is the one that stamps it.
  const dbNow = async () => (await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)[0].t as string;
  const rowsFor = async (identifier: string) => groupTicketRows(await readTicketRows(sql, { scanHeaders: true })).get(identifier) ?? [];
  const sync = async (issue: LinearIssue) => { calls.length = 0; return syncIssue(writer, issue, await rowsFor(issue.identifier)); };
  return { store, calls, writer, dbNow, sync };
}

console.log("\n[19] db/ingest-records.ts: the records upsert is source-labelled and idempotent, an edit moves one row, duplicate content is skipped (SMD-1806)");
{
  const count = (s: string) => sql`SELECT count(*)::int AS c FROM thoughts WHERE metadata->>'source' = ${s}`.then((r) => r[0].c);
  const mk = (source: Doc["source"], key: string, content: string): Doc => ({ id: recordId(source, key), content, source, meta: {} });

  // A tiny record set, one of each source, distinct content — no temp files: the
  // adapters that read files are covered by ingest-records.ts's --self-check; this
  // exercises the DB write path against real pgvector.
  const docs: Doc[] = [
    mk("fork", "999", "A synthetic fork change body for the ingester test."),
    mk("commit", "deadbeef", "A synthetic commit message.\n\nWith a body."),
    mk("memory", "test-note-a", "Test note A: the first synthetic memory file."),
    mk("memory", "test-note-b", "Test note B: the second synthetic memory file."),
  ];
  const ids = docs.map((d) => d.id);

  const first: string[] = [];
  for (const d of docs) first.push((await upsertRecord(sql, d)).outcome);
  assert(first.every((r) => r === "inserted"), `first ingest inserts every record (${first.join(",")})`);
  assert((await count("fork")) === 1 && (await count("commit")) === 1 && (await count("memory")) === 2, "each row carries its metadata.source label (SMD-1806 rule 5)");
  const [forkRow] = await sql`SELECT metadata, embedding IS NULL AS bare FROM thoughts WHERE id = ${docs[0].id}::uuid`;
  assert(forkRow.metadata.source === "fork" && forkRow.bare === true, "a row is source-labelled and written bare — no embedding, which is reembed.ts's job");

  // An unchanged re-ingest is a no-op. The tooth is the classification: the
  // fingerprint WHERE guard makes each row 'unchanged'; remove the guard and the
  // DO UPDATE fires and each is 'updated'. Because no UPDATE runs, the updated_at
  // trigger never fires either — and the 1.1s gap gives that second assertion its
  // own teeth: an UPDATE here (guard removed) would move updated_at by over a
  // second, where a within-millisecond re-ingest would not (now() truncates to the
  // JS Date's millisecond).
  const before = (await sql`SELECT updated_at FROM thoughts WHERE id = ${docs[2].id}::uuid`)[0].updated_at;
  await Bun.sleep(1100);
  const second: string[] = [];
  for (const d of docs) second.push((await upsertRecord(sql, d)).outcome);
  assert(second.every((r) => r === "unchanged"), `a re-ingest of the same records is a no-op — every row 'unchanged', not 'updated' (${second.join(",")})`);
  const afterNoop = (await sql`SELECT updated_at FROM thoughts WHERE id = ${docs[2].id}::uuid`)[0].updated_at;
  assert(String(before) === String(afterNoop), "…and updated_at is untouched: no UPDATE ran (the 1.1s gap would surface one if it had)");

  // Editing one record updates exactly that row.
  // A vector and a chunk row planted on the row about to be edited: the edit
  // must clear both — they were the old text's — so reembed.ts pools the row
  // (SMD-1958's second half; before, a rebuild over an embedded brain left a
  // stale vector under new text that nothing re-embedded). And a key another
  // writer put on the row (the sync's facets, the extractor's tags) survives
  // the edit: metadata is merged, not replaced.
  await sql`UPDATE thoughts SET embedding = ${unit(3)}::vector, embedding_model = 'planted', metadata = metadata || '{"topics": ["kept"]}'::jsonb WHERE id = ${docs[2].id}::uuid`;
  await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES (${docs[2].id}::uuid, 0, 'a window', ${unit(3)}::vector)`;
  const edited: Doc = { ...docs[2], content: "Test note A: EDITED body." };
  const third: string[] = [];
  for (const d of [edited, docs[3]]) third.push((await upsertRecord(sql, d)).outcome);
  assert(third[0] === "updated" && third[1] === "unchanged", `editing one record updates only it (${third.join(",")})`);
  const [editedRow] = await sql`SELECT content, embedding IS NULL AS bare, embedding_model AS m, metadata, (SELECT count(*)::int FROM thought_chunks WHERE thought_id = ${docs[2].id}::uuid) AS chunks FROM thoughts WHERE id = ${docs[2].id}::uuid`;
  assert(/EDITED/.test(editedRow.content), "the edited row carries the new content");
  assert(editedRow.bare === true && editedRow.m === null && editedRow.chunks === 0, `…its vector, label and chunk rows are cleared for reembed.ts to pool (bare=${editedRow.bare} model=${editedRow.m} chunks=${editedRow.chunks})`);
  assert(JSON.stringify(editedRow.metadata.topics) === '["kept"]' && editedRow.metadata.source === "memory", "…and metadata another writer put on the row survives: merged, not replaced (SMD-1958)");
  // A record that stands but gains a key is 'patched': the merge writes the key, the text and its (absent) vector are untouched.
  const patched = await upsertRecord(sql, { ...edited, meta: { file: "test-note-a" } });
  assert(patched.outcome === "patched" && (await sql`SELECT metadata->>'file' AS f FROM thoughts WHERE id = ${docs[2].id}::uuid`)[0].f === "test-note-a", `a record whose text stands and whose metadata gained a key is 'patched' (${patched.outcome})`);
  assert((await upsertRecord(sql, { ...edited, meta: { file: "test-note-a" } })).outcome === "unchanged", "…and the same record again is 'unchanged' — a key already held is not a patch");

  // A different record whose content is byte-identical to one already stored
  // collides on the partial-unique content_fingerprint index → skipped, not a crash.
  const twin = mk("fork", "1000", docs[1].content);
  assert((await upsertRecord(sql, twin)).outcome === "skipped", "a different record with identical content is skipped");
  assert((await count("fork")) === 1, "…and no second row was written for it");

  // SMD-1726: the ingester names itself in each record's transaction, so
  // 050's stamp marks every record with its name (the kind once the operator
  // classifies it) and 046's audit rows carry its door; without it a re-ingest
  // stripped the mark an operator's edit had placed (run-it, first review
  // pass), and a session-level setting died with the connection (second).
  const named = mk("memory", "test-note-c", "Test note C: written under the ingester's own name.");
  assert((await upsertRecord(sql, named)).outcome === "inserted", "a record under the ingester's envelope inserts");
  const [namedRow] = await sql`SELECT metadata->>'actor_name' AS n, metadata->>'actor_kind' AS k FROM thoughts WHERE id = ${named.id}::uuid`;
  assert(namedRow.n === INGEST_ACTOR.name && namedRow.k === null, `…stamped with the ingester's name and no kind until the operator classifies the label (${namedRow.n}/${namedRow.k})`);
  const [namedAudit] = await sql`SELECT origin, actor_name FROM thought_audit WHERE thought_id = ${named.id}::uuid AND action = 'capture'`;
  assert(namedAudit?.origin === INGEST_ACTOR.via && namedAudit.actor_name === INGEST_ACTOR.name, "…and its audit row names the ingester as writer and door");
  assert((await sql`SELECT current_setting('ob1.actor', true) AS a`)[0].a === "" || (await sql`SELECT current_setting('ob1.actor', true) AS a`)[0].a === null, "…and the envelope does not outlive the record's transaction on the connection");
  ids.push(named.id);

  // A record an adapter mapped (SMD-1867): the row, and in its transaction the
  // canonical, the links and the structured mentions; the same record again
  // writes nothing at any of the four; a record whose identity another thought
  // holds is 'held' before any write — no second row (the in-function
  // IDENTITY_HELD, the backstop for the race between that look and the write,
  // is test-schema [48]'s).
  const structured = docOf(corpusIngested(dumpOf({ ...SAMPLE_ISSUE, identifier: "SMD-90001", title: "A synthetic ticket", description: "Names <issue id=\"a\" href=\"h\">SMD-90002</issue> twice: <issue id=\"b\" href=\"h\">SMD-90002</issue>.", project: null, labels: { nodes: [{ name: "zqlabel" }] }, createdAt: "2026-09-01T00:00:00.000Z" })));
  ids.push(structured.id);
  const s1 = await upsertRecord(sql, structured, "test-live@1");
  assert(s1.outcome === "inserted" && s1.structure?.canonical === "inserted" && s1.structure.links.added === 1 && s1.structure.mentions === 1, `a structured record inserts its row, canonical, one link and one mention (${JSON.stringify(s1)})`);
  const [srcRow] = await sql`SELECT system, identity, media_type, ingest_run, canonical FROM thought_sources WHERE thought_id = ${structured.id}::uuid`;
  assert(srcRow?.system === "linear" && srcRow.identity === "SMD-90001" && srcRow.ingest_run === "test-live@1" && /<issue id=/.test(srcRow.canonical) && !/<issue/.test(structured.content), "the canonical keeps the markup the row's text lost");
  const [linkRow] = await sql`SELECT payload FROM thought_facets WHERE thought_id = ${structured.id}::uuid AND kind = 'link'`;
  assert(linkRow?.payload?.relation === "references" && linkRow.payload.target === "SMD-90002" && linkRow.payload.origin === "structured", `the link names its target by identity, origin structured (${JSON.stringify(linkRow?.payload)})`);
  const [mentionRow] = await sql`SELECT m.extraction_key AS k, en.name FROM thought_entities m JOIN ob1_entities en ON en.id = m.entity_id WHERE m.thought_id = ${structured.id}::uuid`;
  assert(mentionRow?.k === "source:linear" && mentionRow.name === "zqlabel", "the label is a mention under source:linear");
  const s2 = await upsertRecord(sql, structured, "test-live@2");
  assert(s2.outcome === "unchanged" && s2.structure?.canonical === "unchanged" && s2.structure.links.added === 0 && s2.structure.links.kept === 1 && s2.structure.links.closed === 0 && s2.structure.mentions === 0, `the same record again writes nothing at any of the four — the mention count is 0 written, not 1 re-inserted (${JSON.stringify(s2)})`);
  // A shrinking array facet is a change the merge must write: containment would have called ["a"] contained in ["a","b"] and kept the stale list (first review pass).
  await sql`UPDATE thoughts SET metadata = metadata || '{"labels": ["a", "b"]}'::jsonb WHERE id = ${structured.id}::uuid`;
  const shrunk = await upsertRecord(sql, { ...structured, meta: { ...structured.meta, labels: ["a"] } }, "test-live@3");
  assert(shrunk.outcome === "patched" && JSON.stringify((await sql`SELECT metadata->'labels' AS l FROM thoughts WHERE id = ${structured.id}::uuid`)[0].l) === '["a"]', `an array facet that shrank is patched to the new list, not kept by containment (${shrunk.outcome})`);
  // Another thought already IS this source item — the board sync's row for the ticket: held, nothing written, no second row.
  const syncRow = (await sql`INSERT INTO thoughts (id, content, metadata, content_fingerprint) VALUES (gen_random_uuid(), 'SMD-90003 — held by the sync', '{"source":"linear","issue":"SMD-90003"}'::jsonb, content_fingerprint_of('SMD-90003 — held by the sync')) RETURNING id`)[0].id as string;
  ids.push(syncRow);
  await sql`SELECT record_thought_source(${syncRow}::uuid, 'linear', 'SMD-90003', '{}', 'application/json', 'sync')`;
  const heldDoc = docOf(corpusIngested(dumpOf({ ...SAMPLE_ISSUE, identifier: "SMD-90003", title: "The same ticket, from the dump", description: "a different text", labels: { nodes: [] } })));
  const held = await upsertRecord(sql, heldDoc, "test-live@4");
  assert(held.outcome === "held" && held.heldBy === syncRow, `an identity another thought holds is 'held', naming it (${JSON.stringify(held)})`);
  assert((await sql`SELECT count(*)::int AS c FROM thoughts WHERE id = ${heldDoc.id}::uuid`)[0].c === 0, "…and no second row for the ticket: the identity is asked about before any write");
  // Tier identity, for preflight's `tier` check.
  await stampTier(sql, "stable");
  const cfg = Object.fromEntries((await sql`SELECT key, value FROM ob1_config WHERE key IN ('tier','last_ingest')`).map((r: { key: string; value: string }) => [r.key, r.value]));
  assert(cfg.tier === "stable" && /^\d{4}-\d\d-\d\dT/.test(cfg.last_ingest ?? ""), "ob1_config records tier=stable and a last_ingest timestamp");

  for (const id of ids) await sql`DELETE FROM thoughts WHERE id = ${id}::uuid`; // per-id: Bun binds a JS array as a comma string, not a {…} literal
}

console.log("\n[20] db/tier.ts: the canary reproduces stable's rankings on the same corpus, and a perturbed canary is caught — the live replay gate's engine (SMD-1806)");
{
  // The live replay gate (SMD-1295's live half): stable logs a search and the ids
  // it returned; the canary, refreshed from stable, replays that search and its
  // ids are diffed against stable's. This drives the ENGINE (readLoggedSearches →
  // replayOne → diffResult) end to end over the KEYWORD arm, which needs no model
  // — the arm CI can run. The pg_dump-based refresh() and the hybrid arm need
  // client tools / a provider CI does not have; they are exercised by the compose
  // stack and documented, the same split as eval-replay.ts vs test-replay.ts.
  await sql`DELETE FROM query_log`; // scope the replay window to this section's rows
  const put = (s: SQL, id: string, content: string) =>
    s`INSERT INTO thoughts (id, content, metadata, content_fingerprint)
      VALUES (${id}::uuid, ${content}, ${{ source: "fork" }}::jsonb, content_fingerprint_of(${content}))`;

  // A tiny corpus with two distinctive needles: "zqcanary" in three rows, "zqdelta"
  // in one, so no unrelated row a prior section left behind matches either.
  const corpus = [
    { id: recordId("fork", "tier-a"), content: "zqcanary alpha — a migration meets real vectors before an operator does" },
    { id: recordId("fork", "tier-b"), content: "zqcanary beta — a lost query_log row is a lost replay" },
    { id: recordId("fork", "tier-c"), content: "zqcanary gamma — three brains as a promotion pipeline over one corpus" },
    { id: recordId("fork", "tier-d"), content: "zqdelta — unrelated content about pruning old rows" },
  ];
  for (const c of corpus) await put(sql, c.id, c.content);

  // Log what STABLE returns for each needle — the answer the canary is diffed against.
  const loggedFor = async (needle: string): Promise<string[]> => {
    const rows = await sql`SELECT id FROM search_thoughts_keyword(${needle}, 25, 0, '{}'::jsonb)`;
    const ids = rows.map((r: { id: string }) => r.id);
    await sql`
      INSERT INTO query_log (kind, tool, agent_id, query, match_count, threshold, recency_weight, filter, result_ids, result_scores, arm, tier)
      VALUES ('search', 'search_thoughts_keyword', NULL, ${needle}, 25, NULL, NULL, '{}'::jsonb, ${`{${ids.join(",")}}`}::uuid[], NULL, 'keyword', 'stable')`;
    return ids;
  };
  const canaryHits = await loggedFor("zqcanary");
  await loggedFor("zqdelta");
  assert(canaryHits.length === 3, `stable's "zqcanary" search returned the three matching rows (${canaryHits.length})`);

  // Build the canary as a genuinely separate database on this cluster, migrated
  // forward and given the identical corpus — the refresh's shape without pg_dump,
  // which CI has no compatible client for.
  const canaryDb = "ob1_tier_canary";
  const canaryUrl = (() => { const u = new URL(URL_!); u.pathname = `/${canaryDb}`; return u.toString(); })();
  let canarySql: SQL | null = null;
  try {
    await sql.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${canaryDb}' AND pid <> pg_backend_pid()`);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${canaryDb}`);
    await sql.unsafe(`CREATE DATABASE ${canaryDb}`);
    const migrated = await runMigrator(canaryUrl, undefined);
    assert(migrated.code === 0, "the canary database migrates forward with this tree");
    canarySql = new SQL({ url: canaryUrl, max: 4 });
    for (const c of corpus) await put(canarySql, c.id, c.content);

    // An identical canary reproduces stable's rankings — the diff is empty.
    const clean = await replayAndDiff(sql, canarySql, { since: null });
    assert(clean.replayed === 2 && clean.skipped === 0, `both logged keyword searches replay model-free (replayed ${clean.replayed}, skipped ${clean.skipped})`);
    assert(clean.changed === 0, "an identical canary reproduces stable's logged rankings — the diff is empty");

    // Perturb the canary: drop one "zqcanary" row. Now that query — and only that
    // query — moves, and the diff names the dropped id. The gate has teeth.
    await canarySql`DELETE FROM thoughts WHERE id = ${corpus[0].id}::uuid`;
    const perturbed = await replayAndDiff(sql, canarySql, { since: null });
    assert(perturbed.changed === 1, `deleting one canary row moves exactly the query that returned it (${perturbed.changed} changed)`);
    const moved = perturbed.diffs[0];
    assert(moved?.dropped.includes(corpus[0].id) && moved.added.length === 0, "the diff names the dropped id and adds none — a real difference, measured");

    // --promote, the data half: it reads the soaked canary's schema_version (044,
    // stamped when the canary migrated) and records it on stable as
    // promoted_schema_version — NOT schema_version, which is the migrated-under
    // version preflight reads and stable is not migrated here.
    const canaryVer = (await canarySql`SELECT value FROM ob1_config WHERE key = 'schema_version'`)[0]?.value;
    const { version } = await promote(canaryUrl, URL_!);
    assert(canaryVer != null && version === canaryVer, "promote reads the canary's schema_version (migration 044), not an absent 'version' key");
    const stableCfg = Object.fromEntries((await sql`SELECT key, value FROM ob1_config WHERE key IN ('tier','promoted_schema_version','promoted_at')`).map((r: { key: string; value: string }) => [r.key, r.value]));
    assert(stableCfg.tier === "stable" && stableCfg.promoted_schema_version === canaryVer && /^\d{4}-\d\d-\d\dT/.test(stableCfg.promoted_at ?? ""), "promote stamps stable: tier=stable, promoted_schema_version and a promoted_at time");
    await sql`DELETE FROM ob1_config WHERE key IN ('promoted_schema_version','promoted_at')`;
  } finally {
    if (canarySql) await canarySql.close();
    await sql.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${canaryDb}' AND pid <> pg_backend_pid()`);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${canaryDb}`);
  }

  // The refresh guards, without needing client tools: a pg_dump older than the
  // server is refused, and a non-loopback target is refused without the opt-in.
  assert((await refreshToolsReady(9999)).ready === false, "refreshToolsReady refuses when pg_dump cannot read the server's major version");
  const savedAllow = process.env.OB1_ALLOW_REMOTE_DB;
  delete process.env.OB1_ALLOW_REMOTE_DB;
  let refusedRemote = false;
  try { await refresh("postgres://u@example.com:5432/a", "postgres://u@example.com:5432/b", "canary"); }
  catch { refusedRemote = true; }
  finally { if (savedAllow !== undefined) process.env.OB1_ALLOW_REMOTE_DB = savedAllow; }
  assert(refusedRemote, "refresh refuses a non-loopback target unless OB1_ALLOW_REMOTE_DB=1 (it drops the target's schema)");

  for (const c of corpus) await sql`DELETE FROM thoughts WHERE id = ${c.id}::uuid`;
  await sql`DELETE FROM query_log`;
}

console.log("\n[21] said_by on real pgvector: the mark 050 stamps is filtered through 014's route — 001's GIN index, scanned inside the call — and the answer is the operator's rows alone (SMD-1726)");
{
  // The ticket's verification: EXPLAIN cannot see into plpgsql, so the route
  // is read the way [5] reads it — the GIN index's scan count before and after
  // one call. Rows through two classified keys, stamped by 050's trigger as
  // they land (the envelope set once for the session, as a bulk writer would).
  await sql`SELECT set_agent_kind('op-live', 'operator')`;
  await sql`SELECT set_agent_kind('bot-live', 'agent')`;
  const { unitVector } = seededRandom(1726);
  const load = async (key: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = (await sql`SELECT upsert_thought(${`live 050 ${key} row ${i}`}, ${{ metadata: { source: "live" }, actor: { name: key, via: "test-live" } }}::jsonb, ${`[${unitVector(EMBEDDING_DIM).join(",")}]`}::vector) AS r`)[0].r as { id: string };
      ids.push(r.id);
    }
    return ids;
  };
  const opIds = await load("op-live", 60), botIds = await load("bot-live", 60);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  assert((await sql`SELECT count(*)::int AS c FROM thoughts WHERE id = ANY(${sql.array(opIds, "TEXT")}::uuid[]) AND metadata @> '{"actor_kind": "operator", "actor_name": "op-live"}'`)[0].c === 60, "every row through the operator's key carries its mark, stamped by the trigger as it landed");
  const ginScans = async () => {
    await sql`SELECT pg_stat_force_next_flush()`;
    await sql`SELECT 1`;
    return Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'thoughts_metadata_idx'`)[0].idx_scan);
  };
  const q = `[${unitVector(EMBEDDING_DIM).join(",")}]`;
  const before = await ginScans();
  const hits = (await sql.unsafe(`SELECT id FROM match_thoughts('${q}'::vector, -1.0, 100, '{"actor_kind": "operator"}'::jsonb)`)) as { id: string }[];
  const scans = (await ginScans()) - before;
  assert(scans >= 1, `the said_by filter is answered through 001's GIN index inside match_thoughts — 014's route, ${scans} scan(s) in the call`);
  const opSet = new Set(opIds);
  assert(hits.length === 60 && hits.every((h) => opSet.has(h.id)), `…and the answer is exactly the operator's rows: ${hits.length} of 60, none of the agent's`);
  const kw = (await sql.unsafe(`SELECT id FROM search_thoughts_keyword('live 050', 200, 0, '{"actor_name": "bot-live"}'::jsonb)`)) as { id: string }[];
  const botSet = new Set(botIds);
  assert(kw.length === 60 && kw.every((h) => botSet.has(h.id)), `the keyword arm under actor: bot-live returns exactly that key's rows (${kw.length})`);
  for (const id of [...opIds, ...botIds]) await sql`DELETE FROM thoughts WHERE id = ${id}::uuid`;
}

console.log("\n[22] one renderer, one merge rule: a corpus dump through ingest-records.ts and the board sync through sync-linear.ts converge on one row in both orders, and an older dump does not move a ticket back (SMD-1958)");
{
  const { store, calls, dbNow, sync } = syncHarness(7);
  const ticketRows = async (identifier: string) => (await sql`SELECT count(*)::int AS c FROM thoughts WHERE metadata->>'issue' = ${identifier}`)[0].c as number;
  const holderOf = async (identifier: string) => (await sql`SELECT thought_id::text AS t, canonical FROM thought_sources WHERE system = 'linear' AND identity = ${identifier}`)[0] as { t: string; canonical: string } | undefined;
  const mentionsOf = async (id: string) => (await sql`SELECT en.name FROM thought_entities m JOIN ob1_entities en ON en.id = m.entity_id WHERE m.thought_id = ${id}::uuid AND m.extraction_key = 'source:linear' ORDER BY en.name`).map((r: { name: string }) => r.name).join(",");
  const ids: string[] = [];

  const issue: LinearIssue = { ...SAMPLE_ISSUE, identifier: "SMD-90010", title: "Converges from the dump", description: "Names <issue id=\"a\" href=\"h\">SMD-90011</issue>.", project: { id: "p", name: "zqproject" }, labels: { nodes: [{ name: "zqlabel" }] }, updatedAt: "2026-09-22T01:00:00.000Z" };

  // Order A: the dump first, then the sync.
  const docA = docOf(corpusIngested(dumpOf(issue, await dbNow())));
  ids.push(docA.id);
  const a1 = await upsertRecord(sql, docA, "test-live@dumpA");
  assert(a1.outcome === "inserted" && a1.structure?.canonical === "inserted" && a1.structure.links.added === 1 && a1.structure.mentions === 2, `the dump inserts the ticket's row with its canonical, one link and two mentions (${JSON.stringify(a1)})`);
  const beforeA = (await sql`SELECT updated_at::text AS u, content, metadata FROM thoughts WHERE id = ${docA.id}::uuid`)[0];
  const sA = await sync(issue);
  const afterA = (await sql`SELECT updated_at::text AS u, content, metadata FROM thoughts WHERE id = ${docA.id}::uuid`)[0];
  assert(sA.outcome === "unchanged" && calls.length === 0, `the sync over the dump's row reads the ticket unchanged and makes no model call (${sA.outcome}; calls ${calls.join(",") || "none"})`);
  assert(afterA.u === beforeA.u && afterA.content === beforeA.content && JSON.stringify(afterA.metadata) === JSON.stringify(beforeA.metadata), "…and wrote nothing: updated_at, content and metadata as the dump left them");
  assert((await ticketRows("SMD-90010")) === 1 && (await holderOf("SMD-90010"))?.t === docA.id, "…one row for the ticket, the identity still the dump's row's");
  assert(beforeA.content === renderIssue(issue), "the dump's text IS the sync's render — the one renderer, byte for byte");

  // The ticket moves in Linear: the sync updates the row (a real edit — vector
  // and tags); the dump rebuilt after the move is unchanged; the OLD dump is
  // stale — the row is not moved back, and its structure stands.
  const moved: LinearIssue = { ...issue, state: { name: "Done", type: "completed" }, labels: { nodes: [{ name: "zqlabel" }, { name: "zqother" }] }, updatedAt: "2026-09-22T02:00:00.000Z" };
  const sM = await sync(moved);
  assert(sM.outcome === "updated" && calls.join(",") === "embed,tags", `the ticket moved: the sync edits the row, embedding and tagging once (${sM.outcome}; ${calls.join(",")})`);
  const rowM = (await sql`SELECT content, metadata, embedding IS NOT NULL AS vec FROM thoughts WHERE id = ${docA.id}::uuid`)[0];
  assert(rowM.content === renderIssue(moved) && rowM.metadata.status === "Done" && rowM.metadata.type === "task" && rowM.vec === true, `…on the dump's row: the moved text, the facets, the tags and a vector (${rowM.metadata.status}/${rowM.metadata.type}/vec=${rowM.vec})`);
  assert((await mentionsOf(docA.id)) === "zqlabel,zqother,zqproject", `…and the structure moved with it (${await mentionsOf(docA.id)})`);
  const viewOfMoved = await dbNow(); // a dump built now would see `moved`
  const fresh = await upsertRecord(sql, docOf(corpusIngested(dumpOf(moved, viewOfMoved))), "test-live@dumpB");
  assert(fresh.outcome === "unchanged" && fresh.structure?.canonical === "unchanged" && fresh.structure.links.kept === 1 && fresh.structure.mentions === 0, `a dump rebuilt after the move finds nothing to write — row, canonical, links or mentions (${JSON.stringify(fresh)})`);
  const stale = await upsertRecord(sql, docA, "test-live@dumpA-again");
  const rowS = (await sql`SELECT content, metadata, embedding IS NOT NULL AS vec FROM thoughts WHERE id = ${docA.id}::uuid`)[0];
  assert(stale.outcome === "stale" && stale.structure === undefined, `the OLD dump over the moved row is 'stale' and records no structure (${JSON.stringify(stale)})`);
  assert(rowS.content === renderIssue(moved) && rowS.metadata.status === "Done" && rowS.vec === true && (await mentionsOf(docA.id)) === "zqlabel,zqother,zqproject" && /Done/.test((await holderOf("SMD-90010"))?.canonical ?? ""), "…and moved nothing back: text, status, vector, mentions and canonical are the sync's");
  // The tooth: with the watermark clause removed from the guard, the old dump
  // is 'updated' and the row reads Backlog again (drop-the-mechanism mutant).

  // The source's clock cannot settle a RENAME: Linear renames a project, a
  // state or a label without touching updatedAt, and the sync re-renders the
  // ticket from the census. The brain's clock does — a dump built before the
  // rename is stale, one built after it is unchanged, and one with no build
  // instant (no second clock) writes, as the contract says (first review
  // pass, independent read: the equal case let a Monday dump undo a rename).
  const renamed: LinearIssue = { ...moved, project: { id: "p", name: "zqproject-renamed" } };
  const sR = await sync(renamed);
  assert(sR.outcome === "updated" && calls.join(",") === "embed,tags" && (await sql`SELECT content FROM thoughts WHERE id = ${docA.id}::uuid`)[0].content === renderIssue(renamed), `a renamed project (same updatedAt) re-renders the row through the sync (${sR.outcome})`);
  const beforeRename = await upsertRecord(sql, docOf(corpusIngested(dumpOf(moved, viewOfMoved))), "test-live@dumpB-again");
  assert(beforeRename.outcome === "stale" && (await sql`SELECT content FROM thoughts WHERE id = ${docA.id}::uuid`)[0].content === renderIssue(renamed), `the dump built before the rename, same updatedAt, is 'stale' by the brain's clock — the row keeps the new name (${beforeRename.outcome})`);
  const afterRename = await upsertRecord(sql, docOf(corpusIngested(dumpOf(renamed, await dbNow()))), "test-live@dumpD");
  assert(afterRename.outcome === "unchanged", `a dump built after the rename is 'unchanged' (${afterRename.outcome})`);
  const noClock = await upsertRecord(sql, docOf(corpusIngested(dumpOf(moved))), "test-live@dumpE");
  assert(noClock.outcome === "updated" && (await sql`SELECT content FROM thoughts WHERE id = ${docA.id}::uuid`)[0].content === renderIssue(moved), `…and a dump with NO build instant writes at an equal clock, as documented — the second clock is what held the line above (${noClock.outcome})`);
  // Blocked by the clock AND nothing to write: the same view again, after a
  // later write left the row exactly as the view has it, is 'unchanged', not
  // 'stale' — the word is for a record that had something to say (second
  // review pass; the fragment claimed it and nothing held it).
  const sameAgain = await upsertRecord(sql, docOf(corpusIngested(dumpOf(moved, viewOfMoved))), "test-live@dumpB-third");
  assert(sameAgain.outcome === "unchanged", `a view the brain's clock would refuse, with nothing to write, is 'unchanged' — 'stale' is for a record with something to say (${sameAgain.outcome})`);

  // Order B: the sync first, then the dump.
  const issueB: LinearIssue = { ...issue, identifier: "SMD-90020", title: "Converges from the sync", description: "Plain.", updatedAt: "2026-09-22T03:00:00.000Z" };
  const sB = await sync(issueB);
  assert(sB.outcome === "captured" && calls.join(",") === "embed,tags", `the sync captures a ticket the brain lacks (${sB.outcome}; ${calls.join(",")})`);
  const syncRow = (await holderOf("SMD-90020"))?.t;
  assert(typeof syncRow === "string" && syncRow !== recordId("linear", "SMD-90020"), "…on its own id, which holds the identity");
  ids.push(syncRow!);
  const held = await upsertRecord(sql, docOf(corpusIngested(dumpOf(issueB, await dbNow()))), "test-live@dumpC");
  assert(held.outcome === "held" && held.heldBy === syncRow, `the dump for that ticket is 'held' by the sync's row (${JSON.stringify(held)})`);
  assert((await ticketRows("SMD-90020")) === 1 && (await sql`SELECT count(*)::int AS c FROM thoughts WHERE id = ${recordId("linear", "SMD-90020")}::uuid`)[0].c === 0, "…no second row, none on the dump's id");
  const sB2 = await sync(issueB);
  assert(sB2.outcome === "unchanged" && calls.length === 0, `and the sync again reads it unchanged (${sB2.outcome}; calls ${calls.join(",") || "none"})`);

  await store.close();
  for (const id of ids) await sql`DELETE FROM thoughts WHERE id = ${id}::uuid`;
}

console.log("\n[23] a ticket's dated sections are thoughts of their own — derived_from the ticket, type observation, one row per section from either writer, and both writers converge on them (SMD-2059)");
{
  const { store, calls, dbNow, sync } = syncHarness(9);
  const holderOf = async (identifier: string) => (await sql`SELECT thought_id::text AS t FROM thought_sources WHERE system = 'linear' AND identity = ${identifier}`)[0]?.t as string | undefined;
  const partsOf = async (identifier: string) => (await sql`SELECT count(*)::int AS c FROM thoughts WHERE metadata->>'ticket' = ${identifier}`)[0].c as number;
  const ids: string[] = [];

  const issue: LinearIssue = { ...SAMPLE_ISSUE, identifier: "SMD-90030", title: "Sectioned", description: "## Problem\n\nThe plan.\n\n## Update 2026-09-19 (board audit)\n\nStill open; see <issue id=\"a\" href=\"h\">SMD-90031</issue>.", project: null, labels: { nodes: [] }, updatedAt: "2026-09-22T01:00:00.000Z" };
  const partKey = "SMD-90030#update-2026-09-19-board-audit";
  const partId = recordId("linear", partKey);
  const partText = linearAdapter.map(issue).derived![0].text;

  // Order A: the dump first. The ticket and its section, two rows, the section derived_from the ticket.
  const family = docsOf(corpusIngested(dumpOf(issue, await dbNow())));
  assert(family.length === 2 && family[1].id === partId && family[1].derivedFrom?.key === "SMD-90030", `the dump yields the ticket and one part on its own id (${family.map((d) => d.id.slice(0, 8)).join(",")})`);
  const written: string[] = [];
  for (const d of family) { written.push((await upsertRecord(sql, d, "test-live@sections")).outcome); ids.push(d.id); }
  assert(written.join(",") === "inserted,inserted", `both insert (${written.join(",")})`);
  const partRow = (await sql`SELECT content, metadata, derived_from, created_at::text AS c FROM thoughts WHERE id = ${partId}::uuid`)[0];
  assert(JSON.stringify(partRow.derived_from) === JSON.stringify([family[0].id]) && partRow.metadata.type === "observation" && partRow.metadata.ticket === "SMD-90030" && partRow.metadata.issue === undefined && partRow.metadata.observed_at === "2026-09-19" && /^2026-09-19/.test(partRow.c), `the part is derived_from the ticket's row, an observation dated by its heading, naming the ticket under \`ticket\` (${JSON.stringify(partRow.metadata)})`);
  assert(partRow.content === partText && /^SMD-90030 — Sectioned · Update 2026-09-19/.test(partRow.content) && !/<issue/.test(partRow.content), "…its text is the ticket's identifier and title, the heading, the body with markup stripped");
  assert((await sql`SELECT content FROM thoughts WHERE id = ${family[0].id}::uuid`)[0].content === renderIssue(issue), "…and the ticket's own text is unchanged — the section is still inside it");
  const links = (await sql`SELECT payload->>'relation' AS r, payload->>'target' AS t FROM thought_facets WHERE thought_id = ${partId}::uuid AND kind = 'link' ORDER BY 1`).map((l: { r: string; t: string }) => `${l.r}=${l.t}`).join(",");
  assert(links === "child_of=SMD-90030,references=SMD-90031" && (await holderOf(partKey)) === partId, `the part's links: child_of the ticket, references its autolink; the identity is the part's row's (${links})`);
  const trace = (await sql`SELECT thought_id::text AS t, depth FROM trace_provenance(${partId}::uuid)`).map((r: { t: string; depth: number }) => `${r.depth}:${r.t === family[0].id ? "ticket" : r.t === partId ? "part" : r.t}`).join(" ");
  assert(trace === "0:part 1:ticket", `trace_provenance walks the part to its ticket (${trace})`);
  // The sync over both: nothing to write, no model call, the part read unchanged.
  const sA = await sync(issue);
  assert(sA.outcome === "unchanged" && calls.length === 0 && sA.derived?.unchanged === 1 && sA.derived.captured === 0 && (await partsOf("SMD-90030")) === 1, `the sync reads the ticket and its section unchanged with no model call, one part row (${sA.outcome}; ${JSON.stringify(sA.derived)}; calls ${calls.join(",") || "none"})`);
  // The section is edited in Linear: the ticket's text moves and so does the part's; each is one edit.
  const edited: LinearIssue = { ...issue, description: issue.description!.replace("Still open", "Now closed"), updatedAt: "2026-09-22T02:00:00.000Z" };
  const sE = await sync(edited);
  assert(sE.outcome === "updated" && sE.derived?.updated === 1 && calls.join(",") === "embed,tags,embed,tags" && (await partsOf("SMD-90030")) === 1, `an edited section: the ticket and the part are each edited once, on their own rows — no second part row (${sE.outcome}; ${JSON.stringify(sE.derived)}; ${calls.join(",")})`);
  assert(/Now closed/.test((await sql`SELECT content FROM thoughts WHERE id = ${partId}::uuid`)[0].content), "…the part's row carries the new text");
  const fresh = docsOf(corpusIngested(dumpOf(edited, await dbNow())));
  assert((await upsertRecord(sql, fresh[1], "test-live@sections2")).outcome === "unchanged", "a dump rebuilt after the edit finds the part unchanged");

  // Order B: the sync first.
  const issueB: LinearIssue = { ...issue, identifier: "SMD-90040", title: "Sync first", description: "## Update 2026-09-20 (In Review)\n\nMerged.", updatedAt: "2026-09-22T03:00:00.000Z" };
  const sB = await sync(issueB);
  const headB = await holderOf("SMD-90040");
  const partB = await holderOf("SMD-90040#update-2026-09-20-in-review");
  assert(sB.outcome === "captured" && sB.derived?.captured === 1 && calls.join(",") === "embed,tags,embed,tags" && typeof headB === "string" && typeof partB === "string" && partB !== headB, `the sync captures the ticket and its section, each with a vector and tags (${sB.outcome}; ${JSON.stringify(sB.derived)})`);
  ids.push(headB!, partB!);
  const partBRow = (await sql`SELECT metadata, derived_from FROM thoughts WHERE id = ${partB}::uuid`)[0];
  assert(JSON.stringify(partBRow.derived_from) === JSON.stringify([headB]) && partBRow.metadata.type === "observation" && partBRow.metadata.source === "linear" && partBRow.metadata.issue === undefined, `…the part derived_from the sync's ticket row, an observation, no row claim (${JSON.stringify(partBRow.derived_from)})`);
  const famB = docsOf(corpusIngested(dumpOf(issueB, await dbNow())));
  const heldB: string[] = [];
  for (const d of famB) heldB.push((await upsertRecord(sql, d, "test-live@sections3")).outcome);
  assert(heldB.join(",") === "held,held" && (await sql`SELECT count(*)::int AS c FROM thoughts WHERE id IN (${famB[0].id}::uuid, ${famB[1].id}::uuid)`)[0].c === 0, `the dump for that ticket is held for the ticket AND its part, no row on either dump id (${heldB.join(",")})`);
  const sB2 = await sync(issueB);
  assert(sB2.outcome === "unchanged" && sB2.derived?.unchanged === 1 && calls.length === 0, `and the sync again reads both unchanged (${sB2.outcome}; ${JSON.stringify(sB2.derived)})`);

  await store.close();
  for (const id of ids) await sql`DELETE FROM thoughts WHERE id = ${id}::uuid`;
}

await sql.close();

// db/README.md's Testing block quotes this suite's assertion total. The count
// is lower when a group is skipped (PostgreSQL 18, or JIT off), so only a full
// run — as CI's pg16-with-JIT job is — is compared to the headline (SMD-1805).
console.log("\n[25] Migration 055's payload backfill under two connections: a second pass beside a held one skips what the first filled and counts only its own; the derivation of a capture whose update was stamped before it by an older transaction reads that update (SMD-2115)");
{
  // PGlite is one connection, so test-schema [51] cannot hold what the
  // header promises of two passes at once — the fill's re-read under the row
  // lock (`NOT COALESCE(a.diff ? 'content', false)`) is what makes the second
  // pass skip rather than trip the gate's "nothing is filled" (run-it, first
  // review pass: the mutant that dropped it survived 1,658 assertions).
  // Its own pool: the section before closes the shared one.
  const sql = new SQL({ url: URL_, max: 4 });
  await sql`DELETE FROM thoughts`;
  const N = 300;
  for (let i = 0; i < N; i++) {
    await sql`INSERT INTO thoughts (content, metadata) VALUES (${`concurrent pass row ${i}`}, '{"source": "plant"}'::jsonb)`;
  }
  // 046's shape: a second capture row per thought, without content, older than the real one would be irrelevant — plant them as the thought's only capture by stripping 055's.
  await sql.unsafe(`ALTER TABLE thought_audit DISABLE TRIGGER thought_audit_immutable`);
  await sql.unsafe(`UPDATE thought_audit SET diff = diff - 'content' - 'created_at' WHERE action = 'capture' AND diff->'metadata'->>'source' = 'plant'`);
  await sql.unsafe(`ALTER TABLE thought_audit ENABLE TRIGGER thought_audit_immutable`);
  const waiting = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit WHERE action = 'capture' AND NOT COALESCE(diff ? 'content', false)`)[0].c);
  assert((await waiting()) === N, `${N} capture rows wait for their payload (${await waiting()})`);
  type Bf = { rows: number; from_row: number; skipped: number; unrecoverable: number; awaiting: number };
  const held = new SQL({ url: URL_, max: 1 });
  await held`BEGIN`;
  const first = (await held`SELECT backfill_thought_payloads() AS r`)[0].r as Bf;
  // The second pass, while the first holds its rows: it waits on the row
  // locks — seen waiting, not assumed after a sleep (cold read, second review
  // pass) — re-reads each row as filled, and writes nothing.
  const pending = sql`SELECT backfill_thought_payloads() AS r`.execute();
  let waited = false;
  for (let i = 0; i < 200 && !waited; i++) {
    const [w] = await held`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT backfill_thought_payloads()%'`;
    waited = Number(w.n) > 0;
    if (!waited) await new Promise((r) => setTimeout(r, 50));
  }
  await held`COMMIT`;
  await held.close();
  const second = (await pending)[0].r as Bf;
  assert(waited, "the second pass was seen waiting on the first's row locks before the first committed");
  assert(first.rows === N && first.from_row === N && first.skipped === 0, `the held pass filled every row from the live rows (${JSON.stringify(first)})`);
  assert(second.rows === 0 && second.from_row === 0 && second.skipped === N && second.awaiting === 0, `the second pass, beside it, filled nothing, counted every candidate as skipped — not as its own — and raised nothing (${JSON.stringify(second)})`);
  assert((await waiting()) === 0 && Number((await sql`SELECT count(*)::int AS c FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.action = 'capture' AND a.diff->>'content' IS DISTINCT FROM t.content`)[0].c) === 0, "…and every capture row carries its row's text, once");

  // Two connections, the older transaction's edit committed after the newer
  // one's capture: the update event's created_at (the transaction's start)
  // precedes the capture's, its seq follows. The derivation reads it — the
  // text as captured — not the live text (run-it, first review pass).
  const older = new SQL({ url: URL_, max: 1 });
  await older`BEGIN`;
  await older`SELECT now()`;  // the transaction's clock starts here
  await new Promise((r) => setTimeout(r, 1100));
  const [{ id: inverted }] = (await sql`INSERT INTO thoughts (content, metadata) VALUES ('inverted: the first text', '{"source": "inverted"}'::jsonb) RETURNING id`) as { id: string }[];
  await older`UPDATE thoughts SET content = 'inverted: the second text' WHERE id = ${inverted}::uuid`;
  await older`COMMIT`;
  await older.close();
  const events = (await sql`SELECT action, created_at, seq FROM thought_audit WHERE thought_id = ${inverted}::uuid ORDER BY seq`) as { action: string; created_at: Date; seq: string }[];
  assert(events.length === 2 && events[0].action === "capture" && events[1].action === "update" && events[1].created_at < events[0].created_at, `the update is stamped before the capture and numbered after it (${JSON.stringify(events.map((e) => [e.action, e.created_at.toISOString(), e.seq]))})`);
  await sql.unsafe(`ALTER TABLE thought_audit DISABLE TRIGGER thought_audit_immutable`);
  await sql`UPDATE thought_audit SET diff = diff - 'content' WHERE thought_id = ${inverted}::uuid AND action = 'capture'`;
  await sql.unsafe(`ALTER TABLE thought_audit ENABLE TRIGGER thought_audit_immutable`);
  const [derived] = (await sql`SELECT p.content, p.source FROM thought_audit a CROSS JOIN LATERAL ob1_capture_payload(a.thought_id, a.created_at, a.seq) p WHERE a.thought_id = ${inverted}::uuid AND a.action = 'capture'`) as { content: string; source: string }[];
  assert(derived.content === "inverted: the first text" && derived.source === "update", `the capture derives from the older-stamped update's before — the text as captured (${JSON.stringify(derived)})`);
  const fill = (await sql`SELECT backfill_thought_payloads() AS r`)[0].r as Bf & { from_update: number };
  assert(fill.rows === 1 && fill.from_update === 1 && fill.from_row === 0, `…and the pass writes that text, from the update (${JSON.stringify(fill)})`);

  // A pass beside ordinary delete_thought calls (run-it, second review pass:
  // one delete from a live server during the apply failed the whole
  // migration — the gate, reading under a fresh snapshot, derived a deleted
  // thought's created_at as gone and refused, and the statement was the
  // pass). The pass catches the refusal, sets the moved rows aside and runs
  // again; nothing it filled is lost, and the next pass fills the deleted
  // thoughts' captures from their tombstones.
  await sql`DELETE FROM thoughts`;
  const M = 2000;
  await sql.unsafe(`INSERT INTO thoughts (content, metadata, created_at) SELECT 'racing pass row ' || g, '{"source": "race"}'::jsonb, now() - interval '1 day' FROM generate_series(1, ${M}) g`);
  await sql.unsafe(`ALTER TABLE thought_audit DISABLE TRIGGER thought_audit_immutable`);
  await sql.unsafe(`UPDATE thought_audit SET diff = diff - 'content' - 'created_at' WHERE action = 'capture' AND diff->'metadata'->>'source' = 'race'`);
  await sql.unsafe(`ALTER TABLE thought_audit ENABLE TRIGGER thought_audit_immutable`);
  assert((await waiting()) === M, `${M} capture rows wait, every one with a created_at the pass would fill (${await waiting()})`);
  const victims = (await sql`SELECT id FROM thoughts WHERE metadata->>'source' = 'race' ORDER BY random() LIMIT 40`).map((r: { id: string }) => r.id);
  const deleter = new SQL({ url: URL_, max: 1 });
  const racingPass = sql`SELECT backfill_thought_payloads() AS r`.execute();
  let deleted = 0;
  for (const id of victims) {
    const [{ r }] = await deleter`SELECT delete_thought(${id}::uuid, NULL::jsonb, false) AS r`;
    if ((r as { ok: boolean }).ok) deleted++;
  }
  const raced = (await racingPass)[0].r as Bf & { unrecoverable: number };
  await deleter.close();
  assert(raced.rows + raced.skipped + raced.unrecoverable === M, `the pass beside ${deleted} deletes returned rather than raising, and accounts for every candidate — ${raced.rows} filled, ${raced.skipped} set aside, ${raced.unrecoverable} nothing derives for (${JSON.stringify(raced)})`);
  const after = (await sql`SELECT backfill_thought_payloads() AS r`)[0].r as Bf & { from_tombstone: number };
  assert(after.rows === raced.skipped && after.from_tombstone === raced.skipped && after.awaiting === 0, `…and the next pass fills what was set aside, from the tombstones, leaving nothing waiting (${JSON.stringify(after)})`);
  await sql`DELETE FROM thoughts`;
  await sql.close();
}

console.log("\n[doc] db/README.md states this suite's assertion total (full runs only)");
{
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const n = total();
  const claims = [...readme.matchAll(/^.*\btest-live\.ts\b.*$/gm)]
    .flatMap((line) => [...line[0].matchAll(/(\d+)\s+assertions/g)].map((x) => Number(x[1])));
  if (skipped() === 0) {
    docCheck(claims.length > 0 && claims.every((c) => c === n),
      `db/README.md quotes test-live.ts's ${n} assertions for a full run (found ${[...new Set(claims)].join(", ") || "none"})`);
  } else {
    console.log(`  ·  (doc) skipped — ${skipped()} group(s) did not run, so this ${n}-assertion run is not the full count the README states`);
  }
}

report();
