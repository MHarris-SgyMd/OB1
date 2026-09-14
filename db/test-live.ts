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
import { BOUNDS_IN_FORCE_SQL, DB_LEVEL_SETTINGS_SQL, EMBEDDING_DIM, HNSW_BOUNDS, MATCH_COUNT_CEILING, MATCH_THOUGHTS_SIGNATURE, parseSetConfig, versionAtLeast } from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFunctionSettings, createAssert, dropSchema, explainPrepared, extractBody, loadChunkRows, neverAnswers, plantLegacyRow, runScript, seededRandom, updatedAtTriggerState } from "./test-support.ts";
import { heartbeatFor, leaseRefusal } from "./lease.ts";

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


const { assert, skip, report } = createAssert();

/** Run migrate.ts as a subprocess so its real exit code and output are observed. */
function migrate(...extra: string[]): Promise<{ code: number; out: string }> {
  return runScript(["bun", join(HERE, "migrate.ts"), "--url", URL_!, ...extra], { cwd: HERE });
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
  const [cap] = await sql`
    SELECT upsert_thought(${"exact"}, ${{ metadata: { kind: "a" } }}::jsonb, ${unit(0)}::vector) AS r`;
  assert(cap.r?.id != null, "3-arg atomic capture returns an id");

  const blend = new Array(EMBEDDING_DIM).fill(0);
  blend[0] = 0.9;
  blend[1] = 0.44;
  await sql`SELECT upsert_thought(${"near"}, ${{ metadata: { kind: "a" } }}::jsonb, ${`[${blend.join(",")}]`}::vector)`;
  await sql`SELECT upsert_thought(${"distant"}, ${{ metadata: { kind: "b" } }}::jsonb, ${unit(1)}::vector)`;

  const rows = await sql`SELECT content, similarity FROM match_thoughts(${unit(0)}::vector, -1.0, 10, ${{}}::jsonb)`;
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
  const plan = await sql.begin(async (tx: SQL) => {
    await tx`SET LOCAL enable_seqscan = off`;
    return (await tx`EXPLAIN SELECT id FROM thoughts ORDER BY embedding <=> ${unit(0)}::vector LIMIT 1`)
      .map((r: Record<string, string>) => Object.values(r)[0])
      .join(" ");
  });
  assert(/thoughts_embedding_idx/.test(plan), "thoughts_embedding_idx appears in the plan");
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
  const QUERIES = 10;
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
  assert(walkOverlap >= 85, `…and ${walkOverlap}/100 of them are the exact top-10 (HNSW is approximate; random vectors are its hardest case)`);

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
      const limits = [...plan.matchAll(/Limit \(actual time=[^)]*rows=(\d+)/g)].map((m) => Number(m[1]));
      assert(limits.includes(count * 16), `…and the window is ${count * 16} candidates, four times the unweighted one (Limit rows: ${limits.join(", ")})`);
    }
  }

  // The estimates, on a real server (db/test-schema.ts [20] holds them under PGlite).
  const [{ mt, kw }] = await sql`
    SELECT (SELECT prorows FROM pg_proc WHERE oid = ${MATCH_THOUGHTS_SIGNATURE}::regprocedure) AS mt,
           (SELECT prorows FROM pg_proc WHERE oid = 'search_thoughts_keyword(text, int, int, jsonb)'::regprocedure) AS kw`;
  assert(Number(mt) === 10 && Number(kw) === 25, `match_thoughts declares ROWS 10 and search_thoughts_keyword ROWS 25 on a real server (${mt}, ${kw})`);
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
  // read before its INSERT, C at 018's FOR UPDATE, both ROW SHARE, which
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
   */
  const RECAP = "a long capture, re-captured through the 3-argument form";
  const [long] = await sql`
    SELECT upsert_thought(${RECAP}, ${{ metadata: {}, embedding_model: "old-model" }}::jsonb, ${unit(0)}::vector,
      ${chunkPayload([{ content: "first window", at: 1 }, { content: "second window", at: 2 }])}::jsonb) AS r`;
  const longId = long.r.id as string;
  const windows = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${longId}::uuid`)[0].c);
  const foundAt = async (axis: number) =>
    ((await sql`SELECT id FROM match_thoughts(${unit(axis)}::vector, 0.5, 10)`) as { id: string }[]).some((r) => r.id === longId);
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
  const pool = new Set((await sql`SELECT id FROM thoughts`).map((r: { id: string }) => r.id));

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
  const dead = (await sql`SELECT thought_id FROM claim_thoughts(${JOB2}, 'dead', 5, 2)`).map((r: { thought_id: string }) => r.thought_id);
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

  // (e) The heartbeat (migration 030, SMD-1023). A worker that renews across its
  // deadline keeps its rows — a claim made after the ORIGINAL deadline gets
  // none of them and its release succeeds — and a worker that stops renewing
  // loses them on the RENEWED deadline, not the original, to a second worker
  // that completes them. Five-second leases: the margins are two seconds and
  // more each side, as (c)'s.
  const JOB4 = "test:heartbeat";
  const six = [...pool].slice(8, 14);
  await sql`SELECT enqueue_thoughts(${JOB4}, ${sql.array(six, "TEXT")}::uuid[])`;
  const t0 = Date.now();
  const alive = (await sql`SELECT thought_id FROM claim_thoughts(${JOB4}, 'alive', 4, 5)`).map((r: { thought_id: string }) => r.thought_id);
  assert(alive.length === 4, `a worker takes four rows on a 5 s lease (got ${alive.length})`);
  await Bun.sleep(2500);
  const b0 = performance.now();
  const beat1 = (await sql`SELECT thought_id FROM renew_claims(${JOB4}, 'alive', 5)`).map((r: { thought_id: string }) => r.thought_id);
  const beatMs = performance.now() - b0;
  assert(beat1.length === 4 && alive.every((id) => beat1.includes(id)), `a beat at 2.5 s renews all four (${beat1.length})`);
  await Bun.sleep(3000); // 5.5 s: past the original deadline, 2 s before the renewed one
  const afterOriginal = (await sql`SELECT thought_id FROM claim_thoughts(${JOB4}, 'second', 10)`).map((r: { thought_id: string }) => r.thought_id);
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
  // The rule the three workers share, from the module they share.
  assert(heartbeatFor(900) === 60 && heartbeatFor(10) === 3 && heartbeatFor(1) === 1, "heartbeatFor: 60 s, or a third of the lease, at least one second");
  assert(leaseRefusal(900, 60) === null && leaseRefusal(4, 2) === null && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(leaseRefusal(3, 2) ?? ""),
    "leaseRefusal: a lease of two heartbeats passes, one under is refused with the arithmetic");

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
  // migration 030 the lease has to outlast a missed beat, not the batch.
  const shortLease = await reembed("--switch-model", "--ttl", "3", "--heartbeat", "2");
  assert(shortLease.code === 2 && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(shortLease.out) && /Raise --ttl or lower --heartbeat/.test(shortLease.out),
    `a --ttl under two heartbeats is refused with exit 2, showing the arithmetic (exit ${shortLease.code})`);
  assert(Object.keys(await claimCounts()).length === 0, "…before the pool exists");
  const statusShort = await reembed("--status", "--ttl", "3", "--heartbeat", "2");
  assert(statusShort.code === 0 && /status: \d+ thoughts/.test(statusShort.out), `…while --status answers whatever the lease, since it never claims (exit ${statusShort.code})`);
  // Neither the batch nor the timeout sizes the lease any more: eight rows at
  // any timeout run under the default 900 s lease and 60 s heartbeat (until 030
  // this derived a 1084 s lease from a 120.3 s timeout), and a lease given
  // without a heartbeat derives one of a third of it.
  const defaults = await reembedIn({ OB1_LLM_TIMEOUT: "120.3" }, "--dry-run");
  assert(defaults.code === 0 && /8 per claim, 900 s leases renewed every 60 s/.test(defaults.out),
    `the default lease is 900 s with a 60 s heartbeat whatever the batch and timeout (${defaults.out.match(/\d+ s leases[^,]*/)?.[0]})`);
  const derived = await reembed("--dry-run", "--ttl", "10");
  assert(derived.code === 0 && /8 per claim, 10 s leases renewed every 3 s/.test(derived.out),
    `a lease given without a heartbeat derives one of a third of it (${derived.out.match(/\d+ s leases[^,]*/)?.[0]})`);

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
  // vector where there was none — 008's trigger diffs presence, not value.
  const [{ auditAfter }] = await sql`SELECT count(*)::int AS "auditAfter" FROM thought_audit`;
  assert(Number(auditAfter) - Number(auditBefore) === 1, `the pass wrote one audit row, not thirty-seven (${Number(auditAfter) - Number(auditBefore)})`);
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
  const blocked = await reembed();
  assert(blocked.code === 1 && /1 row\(s\) are still leased/.test(blocked.out), `a run that finds only another process's lease exits 1 and says so (exit ${blocked.code})`);
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

  // The heartbeat end to end (migration 030): a batch whose work outlasts the
  // lease, under workers that beat. Every embedding takes 600 ms, eight per
  // claim, a 3 s lease with the 1 s heartbeat it derives: a batch runs near
  // five seconds, and until 030 its lease expired mid-way — the rows went to
  // the other worker on their second attempt, the first's releases returned
  // false, and three such batches marked rows failed. A fresh backfill key, so
  // the pool is every thought; the recorded model is the configured one here.
  slowMs = 600;
  const SLOW_KEY = `reembed:stub-embed@${DIM}:slow`;
  const slow = await reembed("--job", SLOW_KEY, "--workers", "2", "--batch", "8", "--ttl", "3");
  slowMs = 0;
  assert(slow.code === 0 && /42 re-embedded, 0 failed/.test(slow.out) && /8 per claim, 3 s leases renewed every 1 s/.test(slow.out),
    `two workers re-embed every thought in batches that outlast the lease, and nothing is repeated (exit ${slow.code}: ${slow.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  assert(!/attempt 2/.test(slow.out) && !/lease expired before release/.test(slow.out) && !/lost to an expired lease/.test(slow.out) && !/heartbeat failed/.test(slow.out),
    "…no row reached a second worker, no release found its lease gone, none was lost, every beat answered");
  const slowRows = (await sql`SELECT status, attempt_count::int AS attempts FROM thought_work_claims WHERE work_type = ${SLOW_KEY}`) as { status: string; attempts: number }[];
  assert(slowRows.length === 42 && slowRows.every((r) => r.status === "succeeded" && r.attempts === 1),
    `…and every claim row succeeded on its first attempt (${slowRows.filter((r) => r.attempts !== 1 || r.status !== "succeeded").length} otherwise)`);
  await sql`DELETE FROM thought_work_claims WHERE work_type = ${SLOW_KEY}`;

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
  const KEY = "extract:stub-meta@p1";
  const answers: Record<string, { entities: unknown[]; relationships: unknown[] }> = {
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
  let hemlockIsProse = true;
  const model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: { role: string; content: string }[]; model?: string };
      calls++;
      // The thought is the user message; the rules are the system message.
      const prompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
      await Bun.sleep(5);
      if (hemlockIsProse && /hemlock/.test(prompt)) {
        return Response.json({ choices: [{ message: { content: "I'm sorry, I can't help with that." } }] });
      }
      const key = Object.keys(answers).find((k) => prompt.includes(k));
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
  assert((await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE work_type = ${KEY}`)[0].c === 0,
         "before the worker has ever run, captures enqueue nothing — the trigger waits for the key");

  const rawKey = "a".repeat(64);
  const { hashKey } = await import("../server-portable/auth.ts");
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: URL_,
    OB1_LLM_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    OB1_METADATA_MODEL: "stub-meta",
    OB1_WORKER_KEY: rawKey,
    MCP_ACCESS_KEYS: `entity-worker:write:${hashKey(rawKey)}`,
  };
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
  assert(dry.code === 0 && /Nothing was written/.test(dry.out) && /add 10 thoughts to the pool/.test(dry.out),
         `--dry-run counts the ten thoughts and writes nothing (exit ${dry.code}: ${dry.out.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)})`);
  assert((await sql`SELECT count(*)::int AS c FROM ob1_config WHERE key = 'entity_extraction_key'`)[0].c === 0, "…including the key");
  assert((await sql`SELECT count(*)::int AS c FROM ob1_agents WHERE label = 'entity-worker'`)[0].c === 0, "…and it did not register the worker's agent either");
  const bareLimit = await extract("--limit");
  assert(bareLimit.code === 2 && /--limit needs a value/.test(bareLimit.out), "a bare --limit is refused rather than read as no limit");
  const shortLease = await extract("--ttl", "3", "--heartbeat", "2");
  assert(shortLease.code === 2 && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(shortLease.out), "a lease under two heartbeats is refused (migration 030)");
  const bigBatch = await extract("--dry-run", "--batch", "4", "--timeout", "300");
  assert(bigBatch.code === 0 && /Nothing was written/.test(bigBatch.out),
    `…while a batch of four at a 300 s timeout, refused until 030 as able to outlive the lease, is not: the heartbeat sizes the lease now (exit ${bigBatch.code})`);

  // A 6 s lease, so the 2 s heartbeat it derives beats during the run.
  const first = await extract("--workers", "2", "--batch", "2", "--ttl", "6");
  assert(!/heartbeat failed/.test(first.out) && !/attempt 2/.test(first.out), "the heartbeat runs through the first pass without error, and no row reaches a second worker");
  assert(first.code === 1 && /9 extracted, 1 failed/.test(first.out), `the first run extracts nine and fails the prose answer (exit ${first.code}: ${first.out.split("\n").find((l) => /extracted,/.test(l))?.trim()})`);
  assert(/not JSON of the expected shape/.test(first.out), "…naming the failure");
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
  // Anita, Open Brain, PostgreSQL, Dev, Priya, Redis, observability = 7 entities;
  // mentions 3 + 3 + 2 + 6 = 14; edges 2 + 2 + 1 = 5.
  assert(g1.entities === 7 && g1.mentions === 14 && g1.edges === 5, `the graph is exactly what the stub said: 7 entities, 14 mentions, 5 edges (${JSON.stringify(g1)})`);
  const anita = await entityByName("Anita");
  assert((await sql`SELECT count(*)::int AS c FROM thought_entities WHERE entity_id = ${anita.id}::uuid`)[0].c === 2, "Anita, named by two thoughts, is one entity with two mentions");
  const worksOn = await sql`
    SELECT count(*)::int AS support FROM ob1_entity_edges g
    WHERE g.relation = 'works_on' AND g.from_entity_id = ${anita.id}::uuid`;
  assert(Number(worksOn[0].support) === 2, `"Anita works_on Open Brain" has two evidence rows, one per thought (${worksOn[0].support})`);
  assert(((await entityByName("PostgreSQL")).aliases as string[]).includes("Postgres"), "the alias the model offered is recorded on the entity");
  const c1 = await claimCounts();
  assert(c1.succeeded === 9 && c1.failed === 1, `claims: 9 succeeded, 1 failed (${JSON.stringify(c1)})`);
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
  assert(Number(worksOnAfter[0].support) === 1, `…and the relation the other thought still evidences keeps that one row (${worksOnAfter[0].support})`);
  assert((await entityByName("PostgreSQL")) !== undefined, "…while the entity it introduced remains until pruned");
  const [{ n: prunedN }] = await sql`SELECT prune_orphan_entities() AS n`;
  assert(Number(prunedN) === 1 && (await entityByName("PostgreSQL")) === undefined, `prune_orphan_entities removes it (${prunedN})`);

  // --status, then --retry-failed with a --limit.
  const status = await extract("--status");
  assert(status.code === 0 && /8 extracted, 1 failed/.test(status.out) && /graph: \d+ entities/.test(status.out), "--status reports the pass and the graph");
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
  await sql`SELECT upsert_thought(${"exact"}, ${{ metadata: { kind: "a" } }}::jsonb, ${unit(0)}::vector)`;
  await sql`SELECT upsert_thought(${"distant, and it names SMD-507"}, ${{ metadata: { kind: "b" } }}::jsonb, ${unit(1)}::vector)`;
  // A chunked thought: its own vector is orthogonal but one chunk is close, so
  // the keyword hit's similarity must come from the chunk, as match_thoughts'
  // would — the direct probe scores the same rule.
  const [{ r: chunked }] = await sql`SELECT upsert_thought(${"long, mentions SMD-507 in a chunk"}, ${{ metadata: { kind: "b" } }}::jsonb, ${unit(2)}::vector) AS r`;
  const near = new Array(EMBEDDING_DIM).fill(0); near[0] = 0.8; near[3] = 0.6;
  await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES (${chunked.id}::uuid, 0, ${"chunk mentioning SMD-507"}, ${`[${near.join(",")}]`}::vector)`;

  const rows = await sql`SELECT content, similarity, matched_needles, literal_only FROM search_thoughts_hybrid(${unit(0)}::vector, ${"SMD-507"}, 0.5, 10, ${{}}::jsonb)`;
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
  const [one] = await sql`SELECT content, similarity FROM search_thoughts_hybrid(${unit(0)}::vector, ${"SMD-507"}, 0.5, 1, ${{}}::jsonb)`;
  assert(one.content === "long, mentions SMD-507 in a chunk", `with a window of one the chunked exact hit still leads (${one.content})`);
  const [mt] = await sql`SELECT similarity FROM match_thoughts(${unit(0)}::vector, -1.0, 10, ${{ kind: "b" }}::jsonb) WHERE content = ${"long, mentions SMD-507 in a chunk"}`;
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
  const cap = async (content: string, meta: Record<string, unknown>, at: number, prov?: { derived_from?: string[]; supersedes?: string }) =>
    ((await sql`SELECT upsert_thought(${content}, ${{ metadata: meta, ...(prov ?? {}) }}::jsonb, ${unit(at)}::vector) AS r`)[0].r as { id: string }).id;

  const gp = await cap("provenance grandparent: the raw note", { type: "observation" }, 0);
  const parent = await cap("provenance parent: a first digest", { type: "synthesis", derivation_method: "synthesis" }, 1, { derived_from: [gp] });
  const child = await cap("provenance child: a digest of the digest", { type: "synthesis", derivation_method: "synthesis" }, 2, { derived_from: [parent], supersedes: parent });

  // The columns read back as written (round-trip).
  const row = (await sql`SELECT derived_from, supersedes FROM thoughts WHERE id = ${child}`)[0];
  assert(JSON.stringify(row.derived_from) === JSON.stringify([parent]) && row.supersedes === parent, "capture wrote derived_from and supersedes to the columns");

  // ON CONFLICT is add-only: a re-capture of the child's exact text (a dedup)
  // that names DIFFERENT provenance does not overwrite the established
  // derivation — the existing value wins; changing it is update_thought's job
  // (review pass 2). A re-capture of a first-hand thought CAN fill provenance
  // it did not have.
  await cap("provenance child: a digest of the digest", { type: "synthesis" }, 2, { derived_from: [gp], supersedes: gp });
  const kept = (await sql`SELECT derived_from, supersedes FROM thoughts WHERE id = ${child}`)[0];
  assert(JSON.stringify(kept.derived_from) === JSON.stringify([parent]) && kept.supersedes === parent, "a re-capture with different provenance keeps the original, it does not overwrite");
  const plain = await cap("provenance plain: a first-hand note", { type: "note" }, 6);
  assert((await sql`SELECT derived_from FROM thoughts WHERE id = ${plain}`)[0].derived_from === null, "a first-hand capture has null derived_from");
  // Derives from `child` (not gp/parent, whose derivative counts are asserted below).
  await cap("provenance plain: a first-hand note", { type: "note" }, 6, { derived_from: [child] });
  assert(JSON.stringify((await sql`SELECT derived_from FROM thoughts WHERE id = ${plain}`)[0].derived_from) === JSON.stringify([child]), "…and a re-capture fills provenance the row did not have (add-only, not no-op)");

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
  const at = (wa: number, wb: number) => { const v = new Array(EMBEDDING_DIM).fill(0); v[0] = wa; v[1] = wb; return `[${v.join(",")}]`; };
  await sql`SELECT upsert_thought(${"top, still low"}, ${{ metadata: {} }}::jsonb, ${at(0.30, 0.9539)}::vector)`;
  await sql`SELECT upsert_thought(${"within half"}, ${{ metadata: {} }}::jsonb, ${at(0.18, 0.9837)}::vector)`;
  await sql`SELECT upsert_thought(${"far below"}, ${{ metadata: {} }}::jsonb, ${at(0.10, 0.9950)}::vector)`;

  // Threshold 0 — what the tools send now: the relative cutoff governs. The top
  // and the row within half of it come back; the far row is trimmed.
  const rel = await sql`SELECT content, similarity FROM search_thoughts_hybrid(${unit(0)}::vector, ${"a plain question with no identifiers"}, 0.0, 10, ${{}}::jsonb)`;
  const names = rel.map((r: { content: string }) => r.content);
  assert(rel.length === 2 && names.includes("top, still low") && names.includes("within half") && !names.includes("far below"),
    `threshold 0 keeps the top and the row within half of it, trims the far row (${names.join(" | ")})`);
  assert(Math.abs(Number(rel[0].similarity) - 0.30) < 0.02, `the reported % match is still the raw cosine (~0.30, ${rel[0].similarity})`);

  // The absolute floor is unchanged and still available: at 0.5 nothing here
  // clears it — the whole set the shipped tool silently dropped before SMD-1300.
  const floored = await sql`SELECT content FROM search_thoughts_hybrid(${unit(0)}::vector, ${"a plain question with no identifiers"}, 0.5, 10, ${{}}::jsonb)`;
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
  const KEY = "consolidate:stub-judge@p2";
  const EXTRACT = "extract:stub@p1";
  let calls = 0;
  let hemlockIsProse = true;
  const seen: { a: string; b: string }[] = [];
  const judge = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: { role: string; content: string }[]; model?: string };
      calls++;
      const prompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
      const a = /<thought_a>\n([\s\S]*?)\n<\/thought_a>/.exec(prompt)?.[1] ?? "";
      const b = /<thought_b>\n([\s\S]*?)\n<\/thought_b>/.exec(prompt)?.[1] ?? "";
      seen.push({ a, b });
      await Bun.sleep(5);
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
  assert(shortLease.code === 2 && /--ttl 3 s cannot cover two heartbeats of --heartbeat 2 s/.test(shortLease.out), "a lease under two heartbeats is refused (migration 030)");
  const bigBatch = await consolidate("--dry-run", "--batch", "4", "--k", "5", "--timeout", "120");
  assert(bigBatch.code === 0 && /Nothing was written/.test(bigBatch.out), `…while a batch whose k calls exceed the lease, refused until 030, is not: the heartbeat sizes the lease now (exit ${bigBatch.code})`);
  const badList = await consolidate("--list", "maybe");
  assert(badList.code === 2 && /--list takes pending/.test(badList.out), "a status outside the four is refused");

  // The first run. Five pairs are judged, one of them (the hemlock pair) drawing prose.
  // A 6 s lease, so the 2 s heartbeat it derives beats during the run.
  const first = await consolidate("--workers", "2", "--dump", dump, "--ttl", "6");
  assert(!/heartbeat failed/.test(first.out) && !/attempt 2/.test(first.out), "the heartbeat runs through the first pass without error, and no row reaches a second worker");
  assert(first.code === 1 && /10 thought\(s\) judged, 1 failed/.test(first.out),
         `the first run judges ten thoughts and fails the one whose pair drew prose (exit ${first.code}: ${first.out.split("\n").find((l) => /judged,/.test(l))?.trim()})`);
  assert(/5 pair\(s\) judged — 0\.50 per thought, 500 calls per thousand thoughts; 6 thought\(s\) had no candidate; verdicts: 1 agree, 0 unrelated, 3 conflict/.test(first.out) && /1 answer\(s\) not JSON of the expected shape/.test(first.out),
         `…five pairs (one per newer thought with an older neighbour), one malformed, and the six older thoughts with nothing older to compare against (${first.out.split("\n").find((l) => /pair\(s\) judged/.test(l))?.trim()})`);
  assert(/2 proposal\(s\) recorded \(1 without a direction\), 1 conflict\(s\) under confidence 0\.5 not recorded/.test(first.out),
         `…two proposals recorded, one undirected, one conflict too weak to record (${first.out.split("\n").find((l) => /proposal\(s\) recorded/.test(l))?.trim()})`);
  assert(/calls per thousand thoughts/.test(first.out) && /model time per pair/.test(first.out), "…and the cost line: calls per thousand thoughts and model time per pair");
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

  judge.stop(true);
  try { unlinkSync(dump); } catch { /* already gone */ }
  await sql`DELETE FROM thoughts`;
  await sql`DELETE FROM ob1_entities`;
}

await sql.close();

report();
