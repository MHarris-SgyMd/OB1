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
import { EMBEDDING_DIM, versionAtLeast } from "./config.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, dropSchema, seededRandom } from "./test-support.ts";

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
async function migrate(...extra: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", join(HERE, "migrate.ts"), "--url", URL_!, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: HERE,
  });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
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

console.log("\n[5] The planner uses the HNSW index");
{
  await sql`SET enable_seqscan = off`;
  const plan = (await sql`EXPLAIN SELECT id FROM thoughts ORDER BY embedding <=> ${unit(0)}::vector LIMIT 1`)
    .map((r: Record<string, string>) => Object.values(r)[0])
    .join(" ");
  assert(/thoughts_embedding_idx/.test(plan), "thoughts_embedding_idx appears in the plan");
  await sql`SET enable_seqscan = on`;
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
  const [seeded] = await sql`
    SELECT s.setconfig AS cfg FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
    WHERE d.datname = current_database() AND s.setrole = 0`;
  const dbSettings: string[] = seeded?.cfg ?? [];
  const want = Object.fromEntries(dbSettings.filter((c) => c.startsWith("hnsw.")).map((c) => c.split("=") as [string, string]));
  const [{ t, mm }] = await sql`SELECT current_setting('hnsw.max_scan_tuples', true) AS t, current_setting('hnsw.scan_mem_multiplier', true) AS mm`;
  if (want["hnsw.max_scan_tuples"] && want["hnsw.scan_mem_multiplier"]) {
    assert(t === want["hnsw.max_scan_tuples"] && mm === want["hnsw.scan_mem_multiplier"],
      `a fresh session sees the database-level bounds (max_scan_tuples=${t}, scan_mem_multiplier=${mm})`);
  } else {
    skip("a fresh session sees the database-level bounds", "not seeded on this database — the migrating role does not own it");
  }
  // 1,000 random rows through a real HNSW index, 1% of them tagged. Under 007
  // the tagged rows were almost never among the 40 nearest, so a filtered
  // search returned almost nothing — db/bench-hnsw.ts has the numbers. Here
  // the function must return exactly what a full scan returns.
  await sql`DELETE FROM thoughts`;
  const { unitVector } = seededRandom(968);
  const random = () => `[${unitVector(EMBEDDING_DIM).join(",")}]`;
  const N = 1000;
  for (let i = 0; i < N; i += 100) {
    const values = Array.from({ length: 100 }, (_, k) => {
      const tagged = (i + k) % 100 === 7; // exactly 1%
      return `('row ${i + k}', '{"tagged": ${tagged}}'::jsonb, '${random()}'::vector)`;
    }).join(",");
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values}`);
  }
  await sql.unsafe(`VACUUM ANALYZE thoughts`);

  let agree = 0;
  const QUERIES = 10;
  for (let q = 0; q < QUERIES; q++) {
    const qv = random();
    const exact = await sql.begin(async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL enable_indexscan = off`);
      await tx.unsafe(`SET LOCAL enable_bitmapscan = off`);
      return tx.unsafe(
        `SELECT id FROM thoughts WHERE metadata @> '{"tagged": true}' ORDER BY embedding <=> '${qv}'::vector LIMIT 10`
      );
    });
    const got = await sql.unsafe(`SELECT id FROM match_thoughts('${qv}'::vector, -1.0, 10, '{"tagged": true}'::jsonb)`);
    const want = new Set(exact.map((r: { id: string }) => r.id));
    if (got.length === 10 && got.every((r: { id: string }) => want.has(r.id))) agree++;
  }
  assert(agree === QUERIES, `a 1% filter returns the exact top-10 on ${agree}/${QUERIES} random queries`);

  // match_count is clamped inside the function, as 012 clamps its p_limit: the
  // cost of a call is now proportional to it, and direct callers are unbounded.
  const many = await sql.unsafe(`SELECT count(*)::int AS c FROM match_thoughts('${random()}'::vector, -1.0, 500, '{}'::jsonb)`);
  assert(Number(many[0].c) === 100, `match_count 500 over ${N} rows returns 100 — the function's own ceiling (got ${many[0].c})`);

  const [{ cfg }] = await sql`
    SELECT array_to_string(proconfig, ',') AS cfg FROM pg_proc
    WHERE oid = 'match_thoughts(vector, float, int, jsonb)'::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg ?? "")), "match_thoughts carries hnsw.iterative_scan on a real server");
  // The LIBRARY's version, not the catalog record: a binary upgraded under an
  // old volume runs 014 fine while pg_extension still says 0.7.x — the state
  // the second review pass reproduced — and this section just proved it works.
  const [{ library }] = await sql`SELECT default_version AS library FROM pg_available_extensions WHERE name = 'vector'`;
  assert(versionAtLeast(String(library), 0, 8), `the server's pgvector library (${library}) supports the iterative scan 014 declares`);
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

await sql.close();

report();
