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
import { readFileSync, writeFileSync } from "node:fs";
import { BOUNDS_IN_FORCE_SQL, DB_LEVEL_SETTINGS_SQL, EMBEDDING_DIM, HNSW_BOUNDS, MATCH_COUNT_CEILING, MATCH_THOUGHTS_SIGNATURE, parseSetConfig, versionAtLeast } from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFunctionSettings, createAssert, dropSchema, explainPrepared, extractBody, loadChunkRows, neverAnswers, runScript, seededRandom } from "./test-support.ts";

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
  assert(wrongKeyStatus.code === 0 && /status: \d+ thoughts/.test(wrongKeyStatus.out), `…while --status answers for the key from any shell, since it writes nothing (exit ${wrongKeyStatus.code})`);
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
  // A lease shorter than a batch's worst case — eight rows at the 2 s timeout —
  // is refused before anything is touched.
  const shortLease = await reembed("--switch-model", "--ttl", "1");
  assert(shortLease.code === 2 && /--ttl 1 s cannot cover --batch 8 × 2 s per call \(16 s\)/.test(shortLease.out) && /Raise --ttl or lower --batch/.test(shortLease.out),
    `a --ttl the batch can outlive is refused with exit 2, showing the arithmetic (exit ${shortLease.code})`);
  assert(Object.keys(await claimCounts()).length === 0, "…before the pool exists");
  const statusShort = await reembed("--status", "--ttl", "1");
  assert(statusShort.code === 0 && /status: \d+ thoughts/.test(statusShort.out), `…while --status answers whatever the lease, since it never claims (exit ${statusShort.code})`);
  // claim_thoughts takes whole seconds, and OB1_LLM_TIMEOUT=120.3 is legal: the
  // derived default lease is an integer — the floor rounded up, plus one row's
  // worth of slack for a re-read — or every claim would fail on its signature.
  const fractional = await reembedIn({ OB1_LLM_TIMEOUT: "120.3" }, "--dry-run");
  assert(fractional.code === 0 && /8 per claim, 1084 s leases/.test(fractional.out),
    `a fractional timeout gives a whole-second default lease: ceil(ceil(8 × 120.3) + 120.3) = 1084 (${fractional.out.match(/\d+ s leases/)?.[0]})`);

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

  poison = false;
  const retried = await reembed("--retry-failed");
  assert(retried.code === 0 && /3 re-embedded, 0 failed/.test(retried.out), `--retry-failed re-embeds all three failed rows once the provider recovers (exit ${retried.code})`);
  const [{ e: throttledVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${throttledDoc}`;
  assert(axisOf(throttledVec) === axisFor(throttledDoc), "…and the throttled long thought now carries its whole-content vector");
  const [{ e: tarpitVec }] = await sql`SELECT embedding::text AS e FROM thoughts WHERE content = ${tarpitText}`;
  assert(axisOf(tarpitVec) === axisFor(tarpitText), "…as does the tarpit, answered this time");
  assert(/1 succeeded row\(s\) carry a caveat/.test(retried.out), "…while the refused one is still listed — --retry-failed does not touch a succeeded row");
  const [{ e: poisonVec, attempts: poisonAttempts }] = await sql`
    SELECT t.embedding::text AS e, c.attempt_count AS attempts FROM thoughts t
    JOIN thought_work_claims c ON c.thought_id = t.id AND c.work_type = ${REEMBED_JOB} WHERE t.content = ${poisonText}`;
  assert(axisOf(poisonVec) === axisFor(poisonText), "…and it now carries the new vector");
  assert(Number(poisonAttempts) === 1, `…on what counts as its first attempt: --retry-failed reset the count (${poisonAttempts})`);
  const final = await claimCounts();
  assert(final.succeeded === 39 && !final.failed, `every row is succeeded (${JSON.stringify(final)})`);

  // The provider's limit "changes": the refused long thought is asked again
  // through --retry-fallbacks, gets its whole-content vector, and the caveat
  // goes with it. A run without the flag would have had nothing to do.
  refusing = false;
  const fallbacks = await reembed("--retry-fallbacks");
  assert(fallbacks.code === 0 && /--retry-fallbacks: 1 row\(s\)/.test(fallbacks.out) && /1 re-embedded, 0 failed/.test(fallbacks.out),
    `--retry-fallbacks returns the refused row to the pool and re-embeds it (exit ${fallbacks.code})`);
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
  // claim table to say so; a plain re-run returns the finished row whose
  // thought moved and pools the new one, and re-embeds exactly those two. A
  // capture the switched server made is at the target and is never pooled.
  const labels = (await sql`SELECT embedding_model AS m FROM thoughts`) as { m: string | null }[];
  assert(labels.length === 40 && labels.every((r) => r.m === "stub-embed"), `every re-embedded row carries the model that produced its vector (${[...new Set(labels.map((r) => r.m))].join(", ")})`);
  const stale = "captured by a server still on the old model";
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
  const byModel = await reembed("--status");
  assert(/corpus:\s+40 at stub-embed, 2 at another model \(old-model: 2\)/.test(byModel.out), `--status prints the corpus by model (${byModel.out.split("\n").find((l) => /corpus:/.test(l))?.trim()})`);
  assert(/42 thoughts — 40 succeeded, 0 failed, 0 in flight, 0 pending, 1 not yet in the pool/.test(byModel.out),
    `…and "not yet in the pool" is the one thought not at the model with no row — the one at it is not counted (${byModel.out.split("\n").find((l) => /status:/.test(l))?.trim()})`);
  const dryData = await reembed("--dry-run");
  assert(/return 1 succeeded row\(s\) whose thought is not at stub-embed to the pool; add 1 thoughts to the pool/.test(dryData.out) && /over 2 rows/.test(dryData.out),
    `--dry-run says the finished row whose thought moved returns and the new one is added (${dryData.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  const caught = await reembed();
  assert(caught.code === 0 && /1 succeeded row\(s\) whose thought is not at stub-embed returned to the pool/.test(caught.out) && /1 thought\(s\) added/.test(caught.out) && /2 re-embedded, 0 failed/.test(caught.out),
    `a plain re-run re-embeds exactly the two rows the old server wrote (exit ${caught.code}: ${caught.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  assert(!/nothing here can tell/.test(caught.out) && !/captured while the pass ran/.test(caught.out), "…and nothing is left to guess about");
  const moved = (await sql`SELECT content, embedding::text AS e, embedding_model AS m FROM thoughts WHERE content = ANY(${sql.array([shorts[0], stale, fresh], "TEXT")})`) as { content: string; e: string; m: string }[];
  const rowNamed = (c: string) => moved.find((r) => r.content === c)!;
  assert(axisOf(rowNamed(shorts[0]).e) === axisFor(shorts[0]) && rowNamed(shorts[0]).m === "stub-embed" && axisOf(rowNamed(stale).e) === axisFor(stale) && rowNamed(stale).m === "stub-embed",
    "…both carry the stub's vector for their own text and the target's label");
  assert(axisOf(rowNamed(fresh).e) === 0 && rowNamed(fresh).m === "stub-embed", "…while the switched server's capture, already at the target, was not touched");
  const [{ c: freshRows }] = await sql`SELECT count(*)::int AS c FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id WHERE t.content = ${fresh}`;
  assert(Number(freshRows) === 0, "…and never entered the pool");
  {
    const pf = await preflight();
    assert(/vector models\s+42 at stub-embed\s*$/m.test(pf.out) && !/at another model/.test(pf.out), "preflight then sees the whole corpus at the model");
  }
  const noop2 = await reembed();
  assert(noop2.code === 0 && /Nothing to do/.test(noop2.out), "a further run has nothing to do");

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
  const CTX_KEY = `reembed:stub-embed@${DIM}:ctx`;
  await sql`SELECT enqueue_thoughts(${CTX_KEY}, (SELECT array_agg(id) FROM (SELECT id FROM thoughts ORDER BY created_at LIMIT 1) s))`;
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${CTX_KEY}`;
  await sql`
    UPDATE thought_work_claims SET status = 'claimed', finished_at = NULL, ttl_expires_at = now() - interval '1 minute', attempt_count = 3, worker_id = 'dead'
    WHERE work_type = ${REEMBED_JOB} AND thought_id = (SELECT id FROM thoughts WHERE content = ${held})`;
  await sql`UPDATE ob1_config SET value = ${recordedModel} WHERE key = 'embedding_model'`;
  const backDry = await reembed("--dry-run");
  assert(backDry.code === 0 && /would: refuse without --switch-model; with it: record stub-embed in ob1_config; start this pass over \(41 row\(s\) from before the change return to the pool\)/.test(backDry.out) && /over 41 rows/.test(backDry.out),
    `--dry-run of a switch back to a model used before says this pass starts over, the expired lease counted (${backDry.out.split("\n").find((l) => /would:/.test(l))?.trim()})`);
  const back = await reembed("--switch-model");
  assert(back.code === 0 && /model change: this pass starts over — 41 row\(s\) from before the change returned to the pool/.test(back.out) && /41 re-embedded, 0 failed/.test(back.out),
    `…and the run re-embeds every pooled thought rather than finding nothing to do — the one the switched server captured is at the model by its row and has no row under the key, so 41 (exit ${back.code}: ${back.out.split("\n").find((l) => /re-embedded/.test(l))?.trim()})`);
  const backCounts = await claimCounts();
  assert(backCounts.succeeded === 41 && Object.keys(backCounts).length === 1, `…leaving every row succeeded again, the expired lease included (${JSON.stringify(backCounts)})`);
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
  const tooLong = await extract("--batch", "4", "--timeout", "300");
  assert(tooLong.code === 2 && /exceed the --ttl/.test(tooLong.out), "a batch that could outlive its lease is refused");

  const first = await extract("--workers", "2", "--batch", "2");
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

await sql.close();

report();
