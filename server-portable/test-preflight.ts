#!/usr/bin/env bun
/**
 * test-preflight.ts — the deploy gate must actually catch bad configurations.
 *
 * A preflight that passes everything is worse than none: it converts an unchecked
 * deployment into a deployment someone believes was checked. Each case below is a
 * misconfiguration that previously produced a server which started, answered the
 * MCP handshake, and failed only on the first real tool call.
 *
 * Runs preflight as a subprocess so real exit codes are observed. The connectivity
 * cases need DATABASE_URL; without one they are skipped, not silently passed.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, createAssert, dropSchema, runScript } from "../db/test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.DATABASE_URL;

/** db/migrations/*.sql are templates; migrate.ts substitutes these at apply time. */
// Derived from the shipped defaults, not a copy of them, and exported to the
// environment so the preflight subprocess builds its expectation from the same
// values this suite builds the schema from. Hardcoding them here meant the schema
// said 1536 while preflight said 1024 the moment the default changed, and the gate
// failed against a database that was in fact correct.
const { DEFAULT_EMBEDDING_DIM, DEFAULT_EMBEDDING_MODEL } = await import("../db/config.mjs");
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? DEFAULT_EMBEDDING_DIM);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;

const { assert, skip: skipRaw, report } = createAssert();
const skip = (l: string) => skipRaw(l, "no DATABASE_URL");

const BASE_OK = { MCP_ACCESS_KEY: "x".repeat(64), OPENROUTER_API_KEY: "sk-stub" };

async function run(env: Record<string, string | undefined>, ...args: string[]) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) clean[k] = String(v);
  }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k];
  return runScript(["bun", join(HERE, "preflight.ts"), ...args], { env: clean, cwd: HERE });
}

const NO_DB = { DATABASE_URL: undefined, SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined };

console.log("[1] Missing configuration fails, with an actionable fix");
{
  const r = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql" });
  assert(r.code === 1, "OB1_STORE=sql without DATABASE_URL exits 1");
  assert(/DATABASE_URL/.test(r.out) && /→/.test(r.out), "…names the variable and suggests a fix");

  const p = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "postgrest" });
  assert(p.code === 1, "OB1_STORE=postgrest without SUPABASE_URL exits 1");

  const k = await run({ ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://x/y", OPENROUTER_API_KEY: "z", MCP_ACCESS_KEY: undefined });
  assert(k.code === 1, "a missing MCP_ACCESS_KEY exits 1");

  const b = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "typo" });
  assert(b.code === 1, "an unrecognised OB1_STORE exits 1 rather than defaulting");
}

console.log("\n[2] Weak secrets warn without blocking");
{
  const r = await run({ ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x",
                        OPENROUTER_API_KEY: "k", MCP_ACCESS_KEY: "short" });
  assert(/only thing protecting/.test(r.out), "a short access key is called out");
  assert(/openssl rand -hex 32/.test(r.out), "…with the command to generate a real one");
}

console.log("\n[3] Credentials are not echoed");
{
  const r = await run({ ...NO_DB, OB1_STORE: "sql", MCP_ACCESS_KEY: "s3cr3t-key-value-abcdefghijklmnop",
                        OPENROUTER_API_KEY: "sk-live-should-not-appear",
                        DATABASE_URL: "postgres://dbuser:hunter2@db.example:5432/ob" });
  assert(!/s3cr3t-key-value/.test(r.out), "the access key is never printed");
  assert(!/sk-live-should-not-appear/.test(r.out), "the OpenRouter key is never printed");
  assert(!/hunter2/.test(r.out), "the database password is masked");
  assert(/db\.example/.test(r.out), "…while the host stays visible for debugging");
}

console.log("\n[4] Unreachable database fails rather than hanging");
{
  const r = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql",
                        DATABASE_URL: "postgres://u:p@127.0.0.1:1/nope" });
  assert(r.code === 1, "a refused connection exits 1");
  assert(/schema/.test(r.out), "…and is reported against the schema check");
}

console.log("\n[5] Against a real database");
if (!LIVE) { skip("healthy configuration passes"); skip("missing schema is distinguished from bad credentials"); }
else {
  const { SQL } = await import("bun");
  // Drop and apply are separate calls on purpose: the two assertions between them
  // observe the un-migrated state, which is the thing this section tests.
  await dropSchema(LIVE);

  const before = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(before.code === 1, "an un-migrated database exits 1");
  assert(/bun migrate\.ts/.test(before.out), "…and tells you to run the migrations");

  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

  const after = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(after.code === 0, "a migrated database passes");
  assert(/thoughts table reachable/.test(after.out), "…and confirms the table is reachable");
  assert(/both upsert_thought overloads present/.test(after.out), "…and that atomic capture is available");
  assert(/no schema_migrations table/.test(after.out), "…and warns the schema was applied outside the runner");
  assert(/resolve_agent present/.test(after.out), "…and that the agent registry is available");

  /**
   * The agent registry is a WARNING where the audit trigger is fatal, and the
   * difference has to be asserted rather than asserted-in-a-comment: without
   * 010 every mutation is still attributed by key name, so refusing to start
   * would make applying a migration a hostage situation.
   *
   * Dropping just the function leaves the rest of the schema intact, which is
   * exactly the state a deployment on 009 is in.
   */
  const admin = new SQL({ url: LIVE, max: 1 });
  await admin.unsafe("DROP FUNCTION IF EXISTS resolve_agent(text, text, text)");
  await admin.close();

  const noRegistry = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noRegistry.code === 0, "a database without migration 010 still starts");
  assert(/resolve_agent is missing/.test(noRegistry.out), "…while saying the registry is absent");
  assert(/attributed by key name only/.test(noRegistry.out), "…and what that costs");

  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

  /**
   * Migration 012, and the reason it is checked at all: the tool is registered
   * unconditionally, so a database without the function serves a tool that
   * errors on every call while everything else looks healthy.
   */
  const noKeyword = new SQL({ url: LIVE, max: 1 });
  await noKeyword.unsafe("DROP FUNCTION IF EXISTS search_thoughts_keyword(text, int, int, jsonb)");
  await noKeyword.close();

  const missingKw = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingKw.code === 1, "a database missing migration 012 does not start");
  assert(/search_thoughts_keyword is missing/.test(missingKw.out),
         "…and names the function rather than the symptom");
  assert(/012_search_thoughts_keyword\.sql/.test(missingKw.out), "…with the migration to apply");

  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("012") });
  const withKw = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/keyword search.*present/s.test(withKw.out), "…and reports it present once applied");

  /**
   * Migration 017, the same shape of check on a bigger surface: search and
   * search_thoughts call search_thoughts_hybrid unconditionally, so a database
   * without it serves the two most-used tools broken while the handshake and
   * every other tool look fine. The PostgREST branch probes by RPC and cannot
   * be exercised here; this holds the SQL branch's message and remedy.
   */
  const noHybrid = new SQL({ url: LIVE, max: 1 });
  await noHybrid.unsafe("DROP FUNCTION IF EXISTS search_thoughts_hybrid(vector, text, float, int, jsonb)");
  await noHybrid.close();
  const missingHy = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingHy.code === 1, "a database missing migration 017 does not start");
  assert(/search_thoughts_hybrid is missing/.test(missingHy.out), "…and names the function search and search_thoughts depend on");
  assert(/017_search_thoughts_hybrid\.sql/.test(missingHy.out), "…with the migration to apply");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("017") });
  const withHy = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/hybrid search.*present/s.test(withHy.out), "…and reports it present once applied");

  /**
   * Migration 014 lives in a SET clause on match_thoughts, which a later
   * CREATE OR REPLACE drops without any error. Re-applying 007 is exactly that
   * event: same signature, no iterative scan. A warning, because every search
   * still answers — with the filtered recall it had before 014.
   */
  assert(/filtered search.*scans iteratively/s.test(withKw.out), "a fully migrated match_thoughts is reported as scanning iteratively");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("007") });
  const pre014 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(pre014.code === 0, "a match_thoughts without 014's SET clause still starts");
  assert(/does not carry hnsw\.iterative_scan/.test(pre014.out), "…while saying the filtered scan is not iterative");
  assert(/migration 014 is not applied/.test(pre014.out), "…and, with no ledger, calls it not applied");
  assert(/014_filtered_match_thoughts\.sql/.test(pre014.out), "…with the migration to apply");

  /**
   * The other wording. With 014 RECORDED in the ledger and the function still
   * 007's, "apply 014" is a no-op — migrate.ts skips it — so the remedy has to
   * be the ALTER FUNCTION that puts the clauses back (or the body, when that
   * was dropped too). This database has no ledger; one is created for the
   * probe and removed after, so the earlier "no schema_migrations table"
   * assertions stay true of the same fixture.
   */
  const ledger = new SQL({ url: LIVE, max: 1 });
  await ledger.unsafe(`CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await ledger.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('014_filtered_match_thoughts.sql', 'test')`);
  await ledger.close();
  const dropped = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(dropped.code === 0, "a recorded 014 whose function was replaced still starts");
  // Re-applying 007 replaces the BODY as well as the clause, so this is the
  // "replaced its body" wording with the body re-run as the remedy.
  assert(/recorded as applied — --baseline recorded it without running it, or a later redefinition replaced its body/.test(dropped.out), "…and is described as recorded-but-not-in-effect (--baseline or a redefinition), not a missing migration");
  assert(/Re-run the body of db\/migrations\/014/.test(dropped.out), "…with a remedy the migrator will not turn into a no-op");
  // The other branch: 014's body intact, its SET clause gone — what a successor
  // that redefined the function without the clause leaves. (An earlier draft
  // asserted this wording with a regex alternative that could never match the
  // singular the check prints, on a fixture that never reached the branch.)
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "013" });
  const reset = new SQL({ url: LIVE, max: 1 });
  await reset.unsafe(`ALTER FUNCTION match_thoughts(vector, float, int, jsonb) RESET ALL`);
  await reset.close();
  const noClause = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noClause.code === 0, "a recorded 014 whose function lost only its SET clause still starts");
  assert(/has 014's body but no iterative scan in force although migration 014 is recorded as applied — a later redefinition dropped its SET clause/.test(noClause.out), "…is described as 014's body without its clause");
  assert(/ALTER FUNCTION match_thoughts\(vector, float, int, jsonb\) SET hnsw\.iterative_scan = relaxed_order/.test(noClause.out), "…with the ALTER FUNCTION that puts the clause back as the remedy");
  const unledger = new SQL({ url: LIVE, max: 1 });
  await unledger.unsafe(`DROP TABLE schema_migrations`);
  await unledger.close();
  // 007 also re-created the chunk writers without the context column, and the
  // RESET above took 014's clause: restore 013 and 014.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "013" });

  /**
   * The trigram flag is read only when 011 APPLIES. Migrations run once, so a
   * deployment that flips it afterwards and re-runs the migrator gets a clean
   * "already applied" and no change to the index — a silent no-op on an explicit
   * instruction, in both directions. Preflight is the only thing that notices,
   * so all four combinations are covered here.
   *
   * SMD-944 flipped the default from off to on, which inverts which of these
   * states the schema starts in: applyMigrations above now builds the index.
   */
  const agreeOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/trigram index.*enabled and present/s.test(agreeOn.out),
         "with the flag unset, the default builds the index and preflight agrees");

  // Present, but this deployment says it does not want it. A small brain that
  // turned it off is paying the write cost for nothing, and only preflight can
  // say so — the migrator will not drop it.
  const unwanted = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_TRGM_INDEX: "off" });
  assert(unwanted.code === 0, "a trigram mismatch is a warning, not a refusal to serve");
  assert(/exists but OB1_TRGM_INDEX is off/.test(unwanted.out),
         "an index nobody asked for is reported — it costs every capture");
  assert(/DROP INDEX CONCURRENTLY/.test(unwanted.out), "…with the statement that fixes it");

  // The mirror, and the one that matters most after the default flip: every
  // deployment that applied 011 before SMD-944 is in exactly this state — the
  // default now wants the index, the ledger says 011 is done, and no index
  // exists. Their keyword search works and sequentially scans.
  const idx = new SQL({ url: LIVE, max: 1 });
  await idx.unsafe("DROP INDEX IF EXISTS idx_thoughts_content_trgm");
  await idx.close();

  const wantOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(wantOn.code === 0, "a database upgraded from before the flip still starts");
  assert(/OB1_TRGM_INDEX is on but idx_thoughts_content_trgm does not exist/.test(wantOn.out),
         "…and names the disagreement between the setting and the database");
  assert(/CREATE INDEX CONCURRENTLY/.test(wantOn.out), "…with the statement that fixes it");

  // And the fourth state: both off, which is a supported configuration rather
  // than a problem, so it must not warn.
  const agreeOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_TRGM_INDEX: "off" });
  assert(/trigram index.*disabled/s.test(agreeOff.out),
         "asking for it off, with it absent, is reported as agreement and not a warning");

  /**
   * Chunk context, in the four states it can be in.
   *
   * The one that has to FAIL is the flag on against a database without
   * migration 013: the column the blurbs go into does not exist, the
   * chunk-writing functions from 007 and 009 simply do not select the key, and
   * every capture succeeds while the context is generated, embedded and
   * dropped. Nothing else in the system would ever mention it.
   */
  const ctx = new SQL({ url: LIVE, max: 1 });
  await ctx.unsafe("ALTER TABLE thought_chunks DROP COLUMN IF EXISTS context");

  const noColumnOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/chunk context.*off \(migration 013 not applied\)/s.test(noColumnOff.out),
         "off against a database without 013 is agreement, not a warning");

  const noColumnOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_CHUNK_CONTEXT: "on" });
  assert(noColumnOn.code !== 0, "the flag on without 013 refuses to start");
  assert(/every blurb would reach the VECTOR and none would be recorded/.test(noColumnOn.out),
         "…and says what would silently happen — the blurb lands in the embedding, only the record is lost");
  assert(/013_chunk_context\.sql/.test(noColumnOn.out), "…with the migration that fixes it");

  await ctx.unsafe("ALTER TABLE thought_chunks ADD COLUMN IF NOT EXISTS context text");
  await ctx.unsafe("DELETE FROM thoughts");

  const empty = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_CHUNK_CONTEXT: "on" });
  assert(/chunk context.*on, no chunks stored yet/s.test(empty.out),
         "on with 013 applied and nothing captured is reported as ok");

  /**
   * The mixed corpus — the state SMD-951 exists to make visible. Written
   * directly rather than captured, because producing it through the server
   * would mean running two servers with different settings; what preflight
   * reads is the rows, and this is the rows.
   */
  const [row] = await ctx.unsafe(
    "SELECT upsert_thought('a chunked thought', '{\"metadata\":{}}'::jsonb, NULL::vector) AS r"
  );
  const tid = (row.r as { id: string }).id;
  const vec = `('[' || array_to_string(array_fill(0.5::real, ARRAY[${EMBEDDING_DIM}]), ',') || ']')::vector`;
  await ctx.unsafe(
    `INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
     VALUES ('${tid}'::uuid, 0, 'first window',  ${vec}, 'Situating blurb.'),
            ('${tid}'::uuid, 1, 'second window', ${vec}, NULL)`
  );

  const mixed = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_CHUNK_CONTEXT: "on" });
  assert(mixed.code === 0, "a mixed corpus is a warning, not a refusal — every query still works");
  assert(/1 of 2 chunks carry a situating context and 1 do not/.test(mixed.out),
         "…and it is counted from the rows rather than trusted from ob1_config");

  await ctx.unsafe(`UPDATE thought_chunks SET context = 'Situating blurb.' WHERE context IS NULL`);
  const allCtxOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/all 2 chunks carry a context but OB1_CHUNK_CONTEXT is off/.test(allCtxOff.out),
         "turning it back off with a contextualized corpus warns about the next capture");

  await ctx.unsafe("DELETE FROM thoughts");
  await ctx.close();

  /**
   * An unfinished re-embed pass (SMD-1024). `reembed.ts --switch-model` records
   * the new model in ob1_config before the first row is re-embedded — on
   * purpose, so a server configured for it can be switched while the pass runs
   * — and the embedding-contract check then says "matching" for a pass that
   * died at 5%. The claim table is the record of the pass, so the states are
   * written to it directly, as the tool would leave them: mid-pass (pending,
   * failed and succeeded rows, one with a caveat) warns with the counts in the
   * tool's own words; a capture during the pass is counted as not yet pooled;
   * a finished pass with such a capture is finished — after a switch every new
   * capture is one; a row another process holds is unfinished work; a backfill
   * under another key is reported by its key; a fresh install and a schema
   * before 015 are not warnings.
   */
  const SQL_ENV = { ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE };
  const KEY = `reembed:${EMBEDDING_MODEL}@${EMBEDDING_DIM}`;
  const claims = new SQL({ url: LIVE, max: 1 });

  const fresh = await run(SQL_ENV);
  assert(/embedding contract.*matching/s.test(fresh.out) && /re-embed pass\s+none unfinished/.test(fresh.out),
         "a fresh install — no claim rows — reports no unfinished pass beside a matching contract");

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const [r] = await claims.unsafe(`SELECT upsert_thought('pass thought ${i}', '{"metadata":{}}'::jsonb, NULL::vector) AS r`);
    ids.push((r.r as { id: string }).id);
  }
  await claims`SELECT enqueue_thoughts(${KEY})`;
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${KEY} AND thought_id = ${ids[0]}::uuid`;
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = 'whole-content embedding refused by the provider (413 stub)' WHERE work_type = ${KEY} AND thought_id = ${ids[1]}::uuid`;
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${KEY} AND thought_id = ${ids[2]}::uuid`;

  const mid = await run(SQL_ENV);
  assert(mid.code === 0, "a database mid-pass still starts — a warning, as the model mismatch beside it is");
  assert(/re-embed pass\s+the pass to .* has not finished: 5 thoughts — 2 succeeded \(1 with a caveat\), 1 failed, 0 in flight, 2 pending, 0 not yet in the pool/.test(mid.out),
         "…and warns with the counts, in the words reembed.ts prints under --status");
  assert(/--retry-failed for the 1 failed row/.test(mid.out) && /--status shows where it stands/.test(mid.out),
         "…with the run that finishes it, --retry-failed while a row is failed, and --status as the remedy");
  assert(/embedding contract.*matching/s.test(mid.out), "…beside a contract line that still says matching, which is true of the record");
  const midJson = await run(SQL_ENV, "--json");
  const midParsed = JSON.parse(midJson.out) as { ok: boolean; checks: { name: string; status: string }[] };
  assert(midParsed.ok === true && midParsed.checks.some((c) => c.name === "re-embed pass" && c.status === "warn"),
         "--json carries the warning for a pipeline, under ok:true");

  await claims.unsafe(`SELECT upsert_thought('captured during the pass', '{"metadata":{}}'::jsonb, NULL::vector)`);
  const during = await run(SQL_ENV);
  assert(/6 thoughts — 2 succeeded \(1 with a caveat\), 1 failed, 0 in flight, 2 pending, 1 not yet in the pool/.test(during.out),
         "a thought captured during the pass is counted as not yet in the pool");

  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = NULL WHERE work_type = ${KEY} AND status IN ('pending', 'failed')`;
  const finished = await run(SQL_ENV);
  assert(/re-embed pass\s+none unfinished/.test(finished.out) && !/not yet in the pool/.test(finished.out),
         "a finished pass with a thought captured since is finished — after a switch every new capture is such a thought");

  await claims`SELECT enqueue_thoughts(${KEY})`;
  const [{ thought_id: leasedId }] = await claims`SELECT thought_id FROM claim_thoughts(${KEY}, 'preflight-test', 1)`;
  const leased = await run(SQL_ENV);
  assert(/6 thoughts — 5 succeeded \(1 with a caveat\), 0 failed, 1 in flight, 0 pending, 0 not yet in the pool/.test(leased.out),
         "a row another process holds is unfinished work, counted in flight");
  await claims`SELECT release_thought(${leasedId}::uuid, ${KEY}, 'preflight-test', 'succeeded')`;

  const CTX = `${KEY}:ctx`;
  await claims.unsafe(`SELECT enqueue_thoughts('${CTX}', ARRAY['${ids[0]}']::uuid[])`);
  const other = await run(SQL_ENV);
  assert(other.code === 0 && new RegExp(`re-embed pass\\s+${CTX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: 6 thoughts — 0 succeeded, 0 failed, 0 in flight, 1 pending, 5 not yet in the pool — a pass under this key stopped before it finished`).test(other.out),
         "a backfill under --job that stopped is reported by its key, with its counts");
  assert(other.out.includes(`--job ${CTX}`), "…with the flag that resumes it");
  assert(!/the pass to .* has not finished/.test(other.out), "…while the finished pass to the configured model is not reported");
  assert(!/--switch-model/.test(other.out), "…and, with the record and the configuration agreeing, no --switch-model in the remedy");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${CTX}`;

  /**
   * A switch that was abandoned or reverted. The corpus was moving to "other",
   * the operator went back, and other's key keeps its pending rows for ever.
   * Finishing "that pass" under this shell would write this model's vectors
   * under other's key — reembed.ts refuses the --job — so the remedy is to
   * complete that switch in other's environment or retire its record, never
   * `--job` under the current model (first review pass).
   */
  const OTHER = `reembed:other-model@${EMBEDDING_DIM}`;
  await claims.unsafe(`SELECT enqueue_thoughts('${OTHER}', ARRAY['${ids[0]}']::uuid[])`);
  const superseded = await run(SQL_ENV);
  assert(superseded.code === 0 && new RegExp(`${OTHER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: 6 thoughts — .* — a pass to other-model @ ${EMBEDDING_DIM}, which is no longer the recorded model \\(${EMBEDDING_MODEL} @ ${EMBEDDING_DIM}\\); its rows describe a switch that was abandoned or reverted`).test(superseded.out),
         "a pass to a model that is no longer the recorded one is described as an abandoned switch");
  assert(/OB1_EMBEDDING_MODEL=other-model OB1_EMBEDDING_DIM=\d+ bun reembed\.ts --url \$DATABASE_URL --switch-model/.test(superseded.out) && superseded.out.includes(`DELETE FROM thought_work_claims WHERE work_type = '${OTHER}';`),
         "…with the two remedies: finish that switch in its own environment, or retire its record");
  assert(!superseded.out.includes(`--job ${OTHER}`), "…and never --job under the current model, which reembed.ts would refuse");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${OTHER}`;

  /**
   * The record disagrees with the configuration — a revert the server has not
   * followed, or a switch the server is ahead of — and the configured model's
   * pass is unfinished: the command preflight prints has to carry
   * --switch-model, or reembed.ts exits 2 on it (first review pass).
   */
  await claims.unsafe(`SELECT enqueue_thoughts('${KEY}', ARRAY['${ids[1]}']::uuid[])`);
  await claims`UPDATE thought_work_claims SET status = 'pending', finished_at = NULL, last_error = NULL WHERE work_type = ${KEY} AND thought_id = ${ids[1]}::uuid`;
  await claims`UPDATE ob1_config SET value = 'other-model' WHERE key = 'embedding_model'`;
  const reverted = await run(SQL_ENV);
  assert(/embedding contract\s+schema was built with other-model, now configured for/.test(reverted.out) && /the pass to .* has not finished/.test(reverted.out),
         "with the record on another model and the configured model's pass unfinished, both lines warn");
  assert(/Finish it: cd db && bun reembed\.ts --url \$DATABASE_URL --switch-model;/.test(reverted.out),
         "…and the finishing command carries --switch-model, which reembed.ts would otherwise refuse");
  /**
   * The same disagreement, with an unfinished key preflight cannot read a
   * model from: the command still needs --switch-model, since the shell it
   * runs in is the configured one (second review pass — the first pass's
   * expression for this could never be true).
   */
  await claims.unsafe(`SELECT enqueue_thoughts('reembed:nightly', ARRAY['${ids[0]}']::uuid[])`);
  const nightly = await run(SQL_ENV);
  assert(/reembed:nightly: 6 thoughts — .* — a pass under this key stopped before it finished/.test(nightly.out) && /bun reembed\.ts --url \$DATABASE_URL --job reembed:nightly --switch-model/.test(nightly.out),
         "an unfinished key naming no model, while the record disagrees with the configuration, gets --switch-model too");
  await claims`DELETE FROM thought_work_claims WHERE work_type = 'reembed:nightly'`;
  await claims`UPDATE ob1_config SET value = ${EMBEDDING_MODEL} WHERE key = 'embedding_model'`;
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${KEY} AND status = 'pending'`;

  /**
   * A hand-applied schema can carry the model row without the width row. The
   * width then says nothing, and the configured model's own backfill must be
   * a resumable pass, not "a switch that was abandoned" with a DELETE as its
   * remedy (second review pass: `dim !== Number(undefined)` is always true).
   */
  await claims`DELETE FROM ob1_config WHERE key = 'embedding_dim'`;
  await claims.unsafe(`SELECT enqueue_thoughts('${CTX}', ARRAY['${ids[0]}']::uuid[])`);
  const noDim = await run(SQL_ENV);
  assert(noDim.out.includes(`--job ${CTX}`) && !/abandoned or reverted/.test(noDim.out),
         "with no width recorded, the configured model's backfill is still a pass to resume, not an abandoned switch");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${CTX}`;
  await claims`INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', ${String(EMBEDDING_DIM)})`;

  /**
   * The same model at another width. Migration 006 keeps the recorded width
   * equal to the column's and reembed.ts refuses any other, so "finish that
   * switch" can never run; the only remedy is to retire the record.
   */
  const WIDE = `reembed:${EMBEDDING_MODEL}@${EMBEDDING_DIM + 1}`;
  await claims.unsafe(`SELECT enqueue_thoughts('${WIDE}', ARRAY['${ids[0]}']::uuid[])`);
  const wide = await run(SQL_ENV);
  assert(new RegExp(`${WIDE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: 6 thoughts — .* — a pass to ${EMBEDDING_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at ${EMBEDDING_DIM + 1} dimensions, where the column and the record are ${EMBEDDING_DIM}`).test(wide.out),
         "a key at another width is described as one no run can finish");
  assert(/Nothing can complete it/.test(wide.out) && wide.out.includes(`DELETE FROM thought_work_claims WHERE work_type = '${WIDE}';`) && !/--switch-model/.test(wide.out),
         "…with retiring the record as the only remedy, and no --switch-model that reembed.ts would refuse on the width");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${WIDE}`;

  await claims.unsafe("DROP TABLE thought_work_claims");
  const pre015 = await run(SQL_ENV);
  assert(pre015.code === 0 && /re-embed pass\s+not checked — thought_work_claims does not exist/.test(pre015.out),
         "before migration 015 there is nothing to read, and the check says so rather than warning");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("015") });

  await claims.unsafe("DELETE FROM thoughts");
  await claims.close();

  const j = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE }, "--json");
  const parsed = JSON.parse(j.out);
  assert(parsed.ok === true, "--json reports ok:true");
  assert(Array.isArray(parsed.checks) && parsed.checks.length > 5, "--json lists every check for a pipeline to consume");
}

report();
