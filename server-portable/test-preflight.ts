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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyMigrations, createAssert, dropSchema, runScript } from "../db/test-support.ts";
import { ACCEPTED_CAVEAT_PREFIX, MATCH_THOUGHTS_SIGNATURE, SEARCH_THOUGHTS_HYBRID_SIGNATURE, UPDATE_THOUGHT_SIGNATURE } from "../db/config.mjs";

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
/** A literal for a RegExp source — model names carry dots and colons. */
const rx = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

console.log("\n[3b] The chunk window is derived from the model, and named");
{
  // Configuration checks print whether or not the database answers, so a
  // refused port is enough; the model is set explicitly because the suite
  // exports the default one to every run.
  const base = { ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x", OB1_CHUNK_TOKENS: undefined };
  const qwen = await run({ ...base, OB1_EMBEDDING_MODEL: "qwen3-embedding:4b", OB1_EMBEDDING_DIM: "1024" });
  assert(/chunk window\s+captures over 4096 tokens are windowed at 1200, derived from qwen3-embedding:4b's 40960-token window — the threshold capped at 4096/.test(qwen.out),
         "the default model windows above 4096 at the shipped 1200: the threshold from its window, capped, and the line says so");
  const gemma = await run({ ...base, OB1_EMBEDDING_MODEL: "embeddinggemma", OB1_EMBEDDING_DIM: "768" });
  assert(/chunk window\s+captures over 1200 tokens are windowed at 1200, derived from embeddinggemma's 2048-token window\s*$/m.test(gemma.out),
         "a 2048-token model derives the shipped 1200 for both, uncapped");
  const unknown = await run({ ...base, OB1_EMBEDDING_MODEL: "some-model", OB1_EMBEDDING_DIM: "1024" });
  assert(/chunk window\s+captures over 1200 tokens are windowed at 1200, the default for some-model's window, which db\/config\.mjs's KNOWN_MODEL_WINDOW does not list/.test(unknown.out),
         "an unknown model keeps 1200 and is told where the table is");
  const pinned = await run({ ...base, OB1_EMBEDDING_MODEL: "qwen3-embedding:4b", OB1_EMBEDDING_DIM: "1024", OB1_CHUNK_TOKENS: "1200" });
  assert(/chunk window\s+captures over 1200 tokens are windowed at 1200, from OB1_CHUNK_TOKENS \(qwen3-embedding:4b's 40960-token window\)/.test(pinned.out),
         "OB1_CHUNK_TOKENS sets both, as it always did, and the window is shown beside it");
  const over = await run({ ...base, OB1_EMBEDDING_MODEL: "embeddinggemma", OB1_EMBEDDING_DIM: "768", OB1_CHUNK_TOKENS: "3000" });
  assert(/chunk window\s+OB1_CHUNK_TOKENS=3000 is over embeddinggemma's 2048-token window — a window that long is cut at 2048 tokens silently/.test(over.out)
         && /Unset OB1_CHUNK_TOKENS to derive the rule from the window, or set it under 2048/.test(over.out),
         "a limit over the model's window is a warning naming the cut and the two ways out");
  const tight = await run({ ...base, OB1_EMBEDDING_MODEL: "embeddinggemma", OB1_EMBEDDING_DIM: "768", OB1_CHUNK_TOKENS: "2000" });
  assert(/chunk window\s+OB1_CHUNK_TOKENS=2000 leaves little headroom under embeddinggemma's 2048-token window/.test(tight.out) && /at or under 1200/.test(tight.out),
         "…and one under the window but over the headroom the estimate needs warns too, naming the ratio's value");
  const tagged = await run({ ...base, OB1_EMBEDDING_MODEL: "granite-embedding:278m", OB1_EMBEDDING_DIM: "384" });
  assert(/chunk window\s+captures over 300 tokens are windowed at 300, derived from granite-embedding:278m's 512-token window/.test(tagged.out),
         "a tagged local name finds its untagged entry — a miss here would be the silent cut");
}

console.log("\n[4] Unreachable database fails rather than hanging");
{
  const r = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql",
                        DATABASE_URL: "postgres://u:p@127.0.0.1:1/nope" });
  assert(r.code === 1, "a refused connection exits 1");
  assert(/schema/.test(r.out), "…and is reported against the schema check");
  // The direct-connection block's checks are one list, DIRECT_CHECKS: a
  // connection that fails before the first of them leaves each named — the
  // first carrying the error, the rest as not reached — and the list is kept
  // in step with the block's add() calls by reading the source, since nothing
  // else would (a renamed or added check would otherwise be blamed or silent).
  const src = readFileSync(join(HERE, "preflight.ts"), "utf8");
  const listed = [...src.match(/const DIRECT_CHECKS = \[([\s\S]*?)\];/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const from = src.indexOf('if (built.kind === "sql" && env.DATABASE_URL) {'), to = src.indexOf("const missing = DIRECT_CHECKS.filter");
  assert(from > 0 && to > from, "the block's two anchors are found in preflight.ts");
  const block = src.slice(from, to);
  // First appearance in the source is the order the block reports in, and the
  // catch blames the FIRST listed name not yet reported — so the list must be
  // in that order, not merely the same set.
  const added = [...new Set([...block.matchAll(/add\("([^"]+)"/g)].map((m) => m[1]))];
  assert(JSON.stringify(added) === JSON.stringify(listed), `DIRECT_CHECKS names exactly the checks the direct-connection block adds, in the order it adds them (block: ${added.join(", ")})`);
  assert(listed.every((n) => r.out.includes(n)), `…and an unreachable database names every one of them (${listed.filter((n) => !r.out.includes(n)).join(", ") || "all named"})`);
  assert(/vector extension\s+.*could not verify/.test(r.out) && /atomic capture\s+.*not checked — the direct connection failed before it/.test(r.out),
         "…the first carrying the error and the later ones saying they were not reached");
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
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present; the 3-argument body is 022's/.test(after.out), "…and that atomic capture is available, with the shipped body (a warn would also say \"present\")");
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
  await noHybrid.unsafe(`DROP FUNCTION IF EXISTS ${SEARCH_THOUGHTS_HYBRID_SIGNATURE}`);
  await noHybrid.close();
  const missingHy = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingHy.code === 1, "a database missing migration 017 does not start");
  assert(/search_thoughts_hybrid is missing/.test(missingHy.out), "…and names the function search and search_thoughts depend on");
  assert(/017_search_thoughts_hybrid\.sql/.test(missingHy.out) && /020_match_thoughts_recency\.sql/.test(missingHy.out), "…with the migration that defines it and the one that redefines it");
  assert(/search signatures.*not checked — a search function is missing/s.test(missingHy.out), "…and the signature check stands aside rather than repeating it");
  // 017 alone puts back the 5-argument form: present by name, and not the form
  // the server calls since 020 — which is its own failure, with 020 as the remedy.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("017") });
  const withHy = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/hybrid search.*present/s.test(withHy.out), "…and reports it present once applied");
  assert(withHy.code === 1 && /search signatures.*search_thoughts_hybrid\(vector,text,double precision,integer,jsonb\) is the form from before migration 020/s.test(withHy.out),
         "a 017-era search_thoughts_hybrid under a 020 server does not start, and is named by its signature");
  assert(/every search would fail/.test(withHy.out) && /Apply db\/migrations\/020_match_thoughts_recency\.sql/.test(withHy.out), "…with 020 as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("020") });
  const sigsOk = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(sigsOk.code === 0 && /search signatures.*the forms the servers call since migration 020, one of each/s.test(sigsOk.out), "with 020 re-applied both signatures are the ones the servers call, one of each");
  assert(/stats summary.*thought_stats_summary present/s.test(sigsOk.out), "…and a fully migrated database reports thought_stats_summary present (migration 024)");

  /**
   * Migration 024's function, the same shape of check on the SQL path: on the
   * SQL store thought_stats calls thought_stats_summary(), so a database that
   * stops at 023 serves that one tool broken while everything else is fine
   * (SMD-1249). LIVE is fully healthy here (sigsOk exited 0), so dropping only
   * this function isolates the fail to it.
   */
  const noStats = new SQL({ url: LIVE, max: 1 });
  await noStats.unsafe("DROP FUNCTION IF EXISTS thought_stats_summary()");
  await noStats.close();
  const missingStats = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingStats.code === 1, "a database missing migration 024 does not start");
  assert(/thought_stats_summary is missing/.test(missingStats.out), "…and names the function thought_stats depends on");
  assert(/024_thought_stats_summary\.sql/.test(missingStats.out), "…with the migration to apply");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("024") });
  const withStats = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(withStats.code === 0 && /stats summary.*present/s.test(withStats.out), "…and reports it present once applied, the database healthy again");

  /**
   * Migration 025's provenance functions (SMD-1253). capture_thought accepts
   * derived_from/supersedes, but the pre-025 upsert_thought drops those envelope
   * keys silently, and trace_provenance/find_derivatives (and the search label)
   * are absent — a recording tool taking input it cannot honour. A database that
   * stops at 024 must not start. LIVE is healthy here, so dropping one read
   * function isolates the fail to this check — and proves the per-function count
   * (a combined >= 2 would miss one missing function; review pass 1).
   */
  // Drop only ONE of the two, so the check's per-function count is what fails,
  // not a combined >=2 that a double-overload of the survivor could satisfy
  // (review pass 1).
  const noProv = new SQL({ url: LIVE, max: 1 });
  await noProv.unsafe("DROP FUNCTION IF EXISTS find_derivatives(uuid, int)");
  await noProv.close();
  const missingProv = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingProv.code === 1, "a database missing one of migration 025's functions does not start");
  assert(/provenance.*functions are missing/s.test(missingProv.out), "…and names the provenance functions the write path depends on");
  assert(/025_thought_provenance\.sql/.test(missingProv.out), "…with the migration to apply");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("025") });
  const withProv = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(withProv.code === 0 && /provenance.*present/s.test(withProv.out), "…and reports it present once applied, the database healthy again");

  /**
   * Migration 014 lives in a SET clause on match_thoughts, which a later
   * CREATE OR REPLACE drops without any error. Re-applying 007 is exactly that
   * event: same signature, no iterative scan. A warning, because every search
   * still answers — with the filtered recall it had before 014.
   */
  assert(/filtered search.*scans iteratively/s.test(withKw.out), "a fully migrated match_thoughts is reported as scanning iteratively");
  // This fixture just re-applied 012 ALONE, which is the trap 019's header names:
  // CREATE OR REPLACE reset search_thoughts_keyword's estimate to 1,000 while
  // match_thoughts still carries its clause and ROWS 10. The check says exactly that.
  assert(/candidate scan.*carries enable_seqscan = off but search_thoughts_keyword's row estimate is 1000 rather than 25/s.test(withKw.out), "…while 019's check reports the keyword estimate that re-applying 012 alone reset");
  // A database that predates 020 as well as 014: 020's function dropped first
  // (re-applying 007 over 020 would otherwise CREATE a second overload, the
  // state tested at the end), then 007's 4-argument body. The 014 check reads
  // the one function there is, whatever its arity, and still says what is
  // wrong with its body; the signature check separately fails the start.
  const pre020 = new SQL({ url: LIVE, max: 1 });
  await pre020.unsafe(`DROP FUNCTION ${MATCH_THOUGHTS_SIGNATURE}`);
  await pre020.close();
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("007") });
  const pre014 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(pre014.code === 1 && /search signatures.*match_thoughts\(vector,double precision,integer,jsonb\) is the form from before migration 020/s.test(pre014.out),
         "a 4-argument match_thoughts under a 020 server does not start, named by its signature");
  assert(/does not carry hnsw\.iterative_scan/.test(pre014.out), "…while 014's check still reads the body it found and says the filtered scan is not iterative");
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
  assert(/search signatures.*before migration 020/s.test(dropped.out), "a recorded 014 whose function was replaced by 007's is still the pre-020 form (the signature check says so)");
  // Re-applying 007 replaces the BODY as well as the clause, so this is the
  // "replaced its body" wording with the body re-run as the remedy.
  assert(/recorded as applied — --baseline recorded it without running it, or a later redefinition replaced its body/.test(dropped.out), "…and is described as recorded-but-not-in-effect (--baseline or a redefinition), not a missing migration");
  assert(/Re-apply the recorded migrations with the migrator — cd db && bun migrate\.ts --url … --reapply/.test(dropped.out), "…with a remedy a plain run will not turn into a no-op: the migrator's re-run");
  // The other branch: 014's body intact, its SET clause gone — what a successor
  // that redefined the function without the clause leaves. (An earlier draft
  // asserted this wording with a regex alternative that could never match the
  // singular the check prints, on a fixture that never reached the branch.)
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "013" });
  const reset = new SQL({ url: LIVE, max: 1 });
  await reset.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET ALL`);
  await reset.close();
  const noClause = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noClause.code === 0, "a recorded 014 whose function lost only its SET clause still starts");
  assert(/has 014's body but no iterative scan in force although migration 014 is recorded as applied — a later redefinition dropped its SET clause/.test(noClause.out), "…is described as 014's body without its clause");
  assert(/ALTER FUNCTION match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision\) SET hnsw\.iterative_scan = relaxed_order/.test(noClause.out), "…with the ALTER FUNCTION that puts the clause back as the remedy, naming the signature the catalog holds");
  // RESET ALL took 019's clause with it, and CREATE OR REPLACE would have
  // reset the row estimate too: the second check names both, as a warning, with
  // the migration as the remedy since this ledger does not record 019.
  assert(/candidate scan.*does not carry enable_seqscan = off — migration 019 is not applied/s.test(noClause.out), "the candidate-scan check reports 019's clause missing");
  assert(/019_match_thoughts_plan_and_rows\.sql/.test(noClause.out), "…with 019 as the remedy while the ledger does not record it");
  // The other remedy: 019 recorded, the clause gone — the ALTER that restores both.
  const led019 = new SQL({ url: LIVE, max: 1 });
  await led019.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('019_match_thoughts_plan_and_rows.sql', 'test')`);
  // RESET ALL leaves prorows alone; a CREATE OR REPLACE would not, so reset it by hand as a redefinition would —
  // and reset the keyword function's too, as re-applying 012 alone does.
  await led019.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} SET hnsw.iterative_scan = relaxed_order ROWS 1000`);
  await led019.unsafe(`ALTER FUNCTION search_thoughts_keyword(text, int, int, jsonb) ROWS 1000`);
  await led019.close();
  const noSeq = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noSeq.code === 0, "a recorded 019 whose function lost only its plan setting still starts");
  assert(/filtered search.*scans iteratively/s.test(noSeq.out) && /candidate scan.*although migration 019 is recorded as applied — a later redefinition dropped its SET clause, and match_thoughts' row estimate is 1000 rather than 10, and search_thoughts_keyword's row estimate is 1000 rather than 25/s.test(noSeq.out),
         "…014's check is satisfied while 019's names the dropped clause and both reset estimates");
  assert(/ALTER FUNCTION match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision\) SET enable_seqscan = off ROWS 10; ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(noSeq.out), "…with one ALTER FUNCTION per function as the remedy, after any body re-apply");
  // Only the keyword estimate gone: the clause is fine, one ALTER, the other function not named.
  const kwOnly = new SQL({ url: LIVE, max: 1 });
  await kwOnly.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} SET enable_seqscan = off ROWS 10`);
  await kwOnly.close();
  const kwReset = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/candidate scan.*carries enable_seqscan = off but search_thoughts_keyword's row estimate is 1000 rather than 25 — a redefinition reset what 019 declared/s.test(kwReset.out), "a reset keyword estimate alone is named alone");
  assert(/Put it back[^\n]*ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(kwReset.out) && !/Put it back[^\n]*ALTER FUNCTION match_thoughts/.test(kwReset.out), "…with only its own ALTER as the remedy");
  const unledger = new SQL({ url: LIVE, max: 1 });
  await unledger.unsafe(`DROP TABLE schema_migrations`);
  await unledger.close();
  // 007 also re-created the chunk writers without the context column, and the
  // RESET above took 014's clause: restore 013 and 014.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "013" });
  // Everything shipped again: both estimates and the clause, reported as ok.
  const shipped = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/candidate scan.*declares enable_seqscan = off and ROWS 10, search_thoughts_keyword ROWS 25/s.test(shipped.out), "with every migration re-applied, the candidate-scan check reports 019's clause and both row estimates");
  assert(shipped.code === 0 && /search signatures.*one of each/s.test(shipped.out), "…and the signature check is satisfied");

  /**
   * The other state 020's header names: an earlier migration re-applied by hand
   * OVER 020 re-creates the 4-argument form BESIDE the 6-argument one. The
   * server's own calls still resolve, so nothing above notices; every
   * 4-argument call is now "function is not unique". Failed, with the DROP 020
   * runs as the remedy, spelled with the signature the catalog holds.
   */
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("014") });
  const twoForms = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(twoForms.code === 1 && /search signatures.*beside the forms the servers call there is an earlier one: match_thoughts\(vector,double precision,integer,jsonb\)/s.test(twoForms.out),
         "a 4-argument match_thoughts re-created beside 020's does not start, and the earlier form is named");
  assert(/function is not unique/.test(twoForms.out) && /DROP FUNCTION match_thoughts\(vector,double precision,integer,jsonb\);/.test(twoForms.out), "…with the DROP as the remedy");
  assert(/filtered search.*scans iteratively/s.test(twoForms.out), "…while the 014 check reads 020's function, the one the servers call, not the re-created one");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "019" });
  const oneForm = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(oneForm.code === 0 && /search signatures.*one of each/s.test(oneForm.out), "re-applying 019 and 020 leaves one form again");

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
  assert(/--accept-failed <thought-id…> for one the provider refuses permanently/.test(mid.out),
         "…and --accept-failed for a row no retry will change (SMD-1067)");
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
  assert(other.code === 0 && new RegExp(`re-embed pass\\s+${rx(CTX)}: 6 thoughts — 0 succeeded, 0 failed, 0 in flight, 1 pending, 5 not yet in the pool — a pass under this key stopped before it finished`).test(other.out),
         "a backfill under --job that stopped is reported by its key, with its counts");
  assert(other.out.includes(`--job ${CTX}`), "…with the flag that resumes it");
  assert(!/the pass to .* has not finished/.test(other.out), "…while the finished pass to the configured model is not reported");
  assert(!/--switch-model/.test(other.out), "…and, with the record and the configuration agreeing, no --switch-model in the remedy");
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${CTX}`;
  const otherFailed = await run(SQL_ENV);
  assert(otherFailed.out.includes(`--job ${CTX} --accept-failed <thought-id…>`),
         "…and with a failed row its acceptance remedy carries the key, so the row is accepted under the pass it belongs to and not the shell's default key");
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
  assert(superseded.code === 0 && new RegExp(`${rx(OTHER)}: 6 thoughts — .* — a pass to other-model @ ${EMBEDDING_DIM}, which is no longer the recorded model \\(${EMBEDDING_MODEL} @ ${EMBEDDING_DIM}\\); its rows describe a switch that was abandoned or reverted`).test(superseded.out),
         "a pass to a model that is no longer the recorded one is described as an abandoned switch");
  assert(/OB1_EMBEDDING_MODEL=other-model OB1_EMBEDDING_DIM=\d+ bun reembed\.ts --url \$DATABASE_URL --switch-model/.test(superseded.out) && superseded.out.includes(`retire its record: cd db && bun reembed.ts --url $DATABASE_URL --retire ${OTHER}`) && !/DELETE FROM/.test(superseded.out),
         "…with the two remedies: finish that switch in its own environment, or retire its record with the tool's own flag — never a hand DELETE (SMD-1067)");
  assert(!superseded.out.includes(`--job ${OTHER}`), "…and never --job under the current model, which reembed.ts would refuse");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${OTHER}`;

  /**
   * The record disagrees with the configuration — a revert the server has not
   * followed, or a switch the server is ahead of — and the configured model's
   * pass is unfinished: the command preflight prints has to carry
   * --switch-model, or reembed.ts exits 2 on it (first review pass).
   */
  await claims.unsafe(`SELECT enqueue_thoughts('${KEY}', ARRAY['${ids[1]}']::uuid[])`);
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${KEY} AND thought_id = ${ids[1]}::uuid`;
  await claims`UPDATE ob1_config SET value = 'other-model' WHERE key = 'embedding_model'`;
  const reverted = await run(SQL_ENV);
  assert(/embedding contract\s+schema was built with other-model, now configured for/.test(reverted.out) && /re-embed pass\s+reembed:/.test(reverted.out),
         "with the record on another model and the configured model's pass unfinished, both lines warn");
  assert(new RegExp(`${rx(KEY)}: 6 thoughts — .* — a pass to ${rx(EMBEDDING_MODEL)} @ ${EMBEDDING_DIM}, which is no longer the recorded model \\(other-model @ ${EMBEDDING_DIM}\\); its rows describe a switch that was abandoned or reverted`).test(reverted.out),
         "…and the configured model's own key, which the record has moved on from, is a superseded key too — the record decides, not this server's environment");
  assert(new RegExp(`Either finish that switch — cd db && OB1_EMBEDDING_MODEL=${rx(EMBEDDING_MODEL)} OB1_EMBEDDING_DIM=${EMBEDDING_DIM} bun reembed\\.ts --url \\$DATABASE_URL --switch-model — or, if the revert stands, retire its record: cd db && bun reembed\\.ts --url \\$DATABASE_URL --retire ${rx(KEY)}`).test(reverted.out) && !/--accept-failed/.test(reverted.out),
         "…with both remedies — finish the switch, or retire the record — and not --accept-failed, which reembed.ts refuses under a model change");
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
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = NULL WHERE work_type = ${KEY} AND status IN ('pending', 'failed')`;

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
  const wrongDim = await run({ ...SQL_ENV, OB1_EMBEDDING_DIM: String(EMBEDDING_DIM + 1) });
  assert(wrongDim.out.includes(`--job ${CTX}`) && !/where the column and the record are/.test(wrongDim.out),
         "…and a server misconfigured for another width does not make it one nothing can finish: the width judged by is the column's, not this server's");
  await claims`INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', ${String(EMBEDDING_DIM + 1)})`;
  const wrongRecord = await run(SQL_ENV);
  assert(wrongRecord.out.includes(`--job ${CTX}`) && !/where the column and the record are/.test(wrongRecord.out),
         "…nor does a record that disagrees with the column: the column comes first, since a pass runs at its width and no other");
  await claims`DELETE FROM ob1_config WHERE key = 'embedding_dim'`;
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
  assert(new RegExp(`${rx(WIDE)}: 6 thoughts — .* — a pass to ${rx(EMBEDDING_MODEL)} at ${EMBEDDING_DIM + 1} dimensions, where the column and the record are ${EMBEDDING_DIM}`).test(wide.out),
         "a key at another width is described as one no run can finish");
  assert(/Nothing can complete it/.test(wide.out) && wide.out.includes(`--retire ${WIDE}`) && !/DELETE FROM/.test(wide.out) && !/--switch-model/.test(wide.out),
         "…with retiring the record as the only remedy, and no --switch-model that reembed.ts would refuse on the width");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${WIDE}`;

  /**
   * Nothing recorded (006 not applied, or the row deleted) and a stale key at
   * another model: this server's model stands in for the record, as
   * reembed.ts's --retire judges, so the key is an abandoned switch with
   * --retire as a remedy — not "finish it under X", which would have
   * re-embedded the corpus to X against a server configured for M.
   */
  await claims`DELETE FROM ob1_config WHERE key = 'embedding_model'`;
  await claims.unsafe(`SELECT enqueue_thoughts('${OTHER}', ARRAY['${ids[0]}']::uuid[])`);
  const noRecord = await run(SQL_ENV);
  assert(new RegExp(`${rx(OTHER)}: 6 thoughts — .* — a pass to other-model @ ${EMBEDDING_DIM}, which is not this server's model \\(${rx(EMBEDDING_MODEL)}; nothing is recorded\\); its rows describe a switch that was abandoned or reverted`).test(noRecord.out) && noRecord.out.includes(`--retire ${OTHER}`) && !noRecord.out.includes(`--job ${OTHER}`),
         `with nothing recorded, a stale key at another model is an abandoned switch judged against this server's model, with --retire as a remedy and never --job under it (${noRecord.out.split("\n").find((l) => /re-embed pass/.test(l))?.trim()})`);
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${OTHER}`;
  await claims`INSERT INTO ob1_config (key, value) VALUES ('embedding_model', ${EMBEDDING_MODEL})`;

  /**
   * The rows say which model they are at (migration 021, SMD-1068). The claim
   * table is a record of passes and vanishes when an operator clears it; the
   * column is a fact about each vector. Every fixture below has an EMPTY claim
   * table for the key, so `re-embed pass` says none unfinished throughout and
   * only the rows can speak: a corpus at two models warns with the counts and
   * the pass as the remedy; one wholly at the recorded model is ok, unlabelled
   * rows as detail; the record disagreeing with the configuration puts
   * --switch-model in the remedy; the column missing under this server fails;
   * and the eight-argument update_thought is checked alone — 018 re-applied by
   * hand beside it, or in its place, fails with the DROP or the migration.
   */
  const noVec = await run(SQL_ENV);
  assert(/vector models\s+no vectors stored yet/.test(noVec.out) && /re-embed pass\s+none unfinished/.test(noVec.out), "with no vectors stored the rows have nothing to say, and say so");
  assert(new RegExp(`edit signature\\s+update_thought\\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text\\): the form the servers and reembed\\.ts call since migration 021 \\(${rx(UPDATE_THOUGHT_SIGNATURE)}\\), alone`).test(noVec.out),
         "the eight-argument update_thought is the only form");
  const VEC = `('[' || array_to_string(array_fill(0.5::real, ARRAY[${EMBEDDING_DIM}]), ',') || ']')::vector`;
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = '${EMBEDDING_MODEL}' WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = 'other-model' WHERE id = '${ids[2]}'`);
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = NULL WHERE id = '${ids[3]}'`);
  const twoModels = await run(SQL_ENV);
  assert(twoModels.code === 0 && new RegExp(`vector models\\s+1 vector\\(s\\) at another model \\(other-model: 1\\) beside 2 at ${rx(EMBEDDING_MODEL)}, 1 unlabelled \\(model unknown\\) — searches rank across the two`).test(twoModels.out),
         "rows at two models, with an empty claim table, warn from the rows alone — with the counts by model");
  assert(/re-embed pass\s+none unfinished/.test(twoModels.out), "…while the claim table, empty, still says no pass is unfinished — the state SMD-1068 was filed for");
  assert(new RegExp(`Re-embed them: cd db && bun reembed\\.ts --url \\$DATABASE_URL — the pass takes exactly the rows not at ${rx(EMBEDDING_MODEL)}\\.`).test(twoModels.out) && !/vector models[^\n]*--switch-model/.test(twoModels.out),
         "…with the pass as the remedy, and no --switch-model while the record and the configuration agree");
  const twoJson = JSON.parse((await run(SQL_ENV, "--json")).out) as { ok: boolean; checks: { name: string; status: string }[] };
  assert(twoJson.ok === true && twoJson.checks.some((c) => c.name === "vector models" && c.status === "warn"), "--json carries it as a warning, under ok:true");
  /**
   * The operator accepts the row at the other model (SMD-1067): its row under
   * the recorded model's key becomes a succeeded row with the accepted caveat,
   * as `reembed.ts --accept-failed` writes it, and the vector is detail rather
   * than a warning — the acknowledgement is the operator's word about exactly
   * that vector. A second row at that model, not spoken for, warns, counting
   * only itself; and the acceptance holds only while nothing has written the
   * thought since (021's evidence rule) — an edit makes it a new question.
   */
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX} || 'stub: refused this text' WHERE work_type = ${KEY} AND thought_id = ${ids[2]}::uuid`;
  const acceptedOne = await run(SQL_ENV);
  assert(acceptedOne.code === 0 && new RegExp(`vector models\\s+2 at ${rx(EMBEDDING_MODEL)}, 1 at another model accepted by the operator \\(other-model: 1\\), 1 unlabelled \\(model unknown\\)\\s*$`, "m").test(acceptedOne.out) && !/vector\(s\) at another model/.test(acceptedOne.out),
         "a vector at another model whose thought the operator accepted is detail, not a warning — the acknowledgement SMD-1067 adds");
  assert(/re-embed pass\s+none unfinished/.test(acceptedOne.out), "…and its row, succeeded with the caveat, leaves the pass finished");
  // Every vector at the recorded model gone: a corpus whose only vectors are
  // accepted ones at another model is NOT ok — nothing is at the model the
  // server embeds with (first review pass).
  await claims.unsafe(`UPDATE thoughts SET embedding = NULL WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  const noneAt = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+no vector is known to be at ${rx(EMBEDDING_MODEL)}: 1 at another model accepted by the operator \\(other-model: 1\\), 1 unlabelled \\(model unknown\\) — nothing is at the model the record names`).test(noneAt.out) && /--retry-fallbacks/.test(noneAt.out),
         "…but with no vector at the recorded model at all, an accepted corpus is a warning, naming the way the accepted rows come back");
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC} WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  // The counts line says "accepted" only while the acceptance stands — the
  // same bound the readers apply — so one report gives one account.
  // (The head-window caveat on ids[1] was cleared by the reverted fixture
  // above, so the accepted row is the one caveat here. finished_at is put back
  // as it was: a fresh one would be evidence for 021's backfill below.)
  const [{ fin: pendingFin }] = await claims`SELECT finished_at::text AS fin FROM thought_work_claims WHERE work_type = ${KEY} AND thought_id = ${ids[3]}::uuid`;
  await claims`UPDATE thought_work_claims SET status = 'pending', finished_at = NULL WHERE work_type = ${KEY} AND thought_id = ${ids[3]}::uuid`;
  const pendingOne = await run(SQL_ENV);
  assert(/re-embed pass\s+the pass to .* has not finished: 6 thoughts — 5 succeeded \(1 with a caveat, 1 accepted by the operator\), 0 failed, 0 in flight, 1 pending/.test(pendingOne.out),
         `the pass counts name the accepted row inside the caveat count while its acceptance stands (${pendingOne.out.split("\n").filter((l) => /re-embed pass|vector models|could not/.test(l)).join(" | ").trim()})`);
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = 'other-model' WHERE id = '${ids[4]}'`);
  const oneMore = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+1 vector\\(s\\) at another model \\(other-model: 1\\) beside 2 at ${rx(EMBEDDING_MODEL)}, 1 at another model accepted by the operator \\(other-model: 1\\), 1 unlabelled`).test(oneMore.out),
         "a second row at that model, not accepted, warns — counting only the one the operator has not spoken for");
  await claims.unsafe(`UPDATE thoughts SET metadata = metadata || '{"edited":true}'::jsonb WHERE id = '${ids[2]}'`);
  const edited = await run(SQL_ENV);
  assert(/vector models\s+2 vector\(s\) at another model \(other-model: 2\)/.test(edited.out) && !/accepted by the operator/.test(edited.out),
         "…and a thought written since its acceptance is no longer spoken for: the acceptance held while nothing wrote the row");
  assert(/5 succeeded \(1 with a caveat\), 0 failed, 0 in flight, 1 pending/.test(edited.out), `…and the pass counts call it a caveat now, not an acceptance (${edited.out.split("\n").filter((l) => /re-embed pass/.test(l)).join(" | ").trim()})`);
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = ${pendingFin}::timestamptz WHERE work_type = ${KEY} AND thought_id = ${ids[3]}::uuid`;
  await claims`UPDATE thought_work_claims SET last_error = NULL WHERE work_type = ${KEY} AND thought_id = ${ids[2]}::uuid`;
  await claims.unsafe(`UPDATE thoughts SET embedding = NULL, embedding_model = NULL WHERE id = '${ids[4]}'`);
  await claims.unsafe(`UPDATE thoughts SET embedding_model = '${EMBEDDING_MODEL}' WHERE id = '${ids[2]}'`);
  const atModel = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+3 at ${rx(EMBEDDING_MODEL)}, 1 unlabelled \\(model unknown\\)\\s*$`, "m").test(atModel.out) && !/at another model/.test(atModel.out),
         "a corpus wholly at the recorded model is ok, the unlabelled row reported as detail rather than as wrong");
  await claims`UPDATE ob1_config SET value = 'other-model' WHERE key = 'embedding_model'`;
  const recordMoved = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+3 vector\\(s\\) at another model \\(${rx(EMBEDDING_MODEL)}: 3\\) beside 0 at other-model, 1 unlabelled[^\\n]*; the record says other-model and this server embeds with ${rx(EMBEDDING_MODEL)}`).test(recordMoved.out),
         "with the record on another model, the rows at the configured one are the ones out of place against the record");
  assert(/Finish the switch to other-model: cd db && OB1_EMBEDDING_MODEL=other-model bun reembed\.ts --url \$DATABASE_URL, and configure the server for it; or, if .* stands: cd db && bun reembed\.ts --url \$DATABASE_URL --switch-model, which re-embeds the rows at other-model instead\./.test(recordMoved.out),
         "…and the remedy gives both directions rather than a --switch-model from this shell that would revert the switch");
  await claims`UPDATE ob1_config SET value = ${EMBEDDING_MODEL} WHERE key = 'embedding_model'`;
  await claims.unsafe("ALTER TABLE thoughts DROP COLUMN embedding_model");
  const noColumn = await run(SQL_ENV);
  assert(noColumn.code === 1 && /vector models\s+thoughts\.embedding_model does not exist/.test(noColumn.out) && /021_embedding_model_per_row\.sql/.test(noColumn.out),
         "the column missing under this server does not start, naming 021");
  // 021 and 022 together: 021's CREATE OR REPLACE puts its 3-argument
  // upsert_thought back over 022's, which is the warning asserted below.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") || f.startsWith("022") });
  const restored = await run(SQL_ENV);
  assert(restored.code === 0 && new RegExp(`vector models\\s+no vector is known to be at ${rx(EMBEDDING_MODEL)}: 4 unlabelled \\(model unknown\\)`).test(restored.out) && /the pass takes every row nothing vouches for/.test(restored.out),
         `021 re-applied: the column is back, its labels gone — and a corpus with no vector known to be at its model is a warning with the pass as the remedy, not an ok (exit ${restored.code}: ${restored.out.split("\n").filter((l) => /vector models|fail/.test(l)).join(" | ").trim()})`);
  // 021's backfill holds the updated_at trigger off for one statement; a
  // hand run that stopped between DISABLE and ENABLE leaves it off.
  await claims.unsafe("ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at");
  const trgOff = await run(SQL_ENV);
  assert(trgOff.code === 1 && /updated_at trigger\s+thoughts_updated_at is disabled/.test(trgOff.out) && /ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;/.test(trgOff.out),
         "the updated_at trigger left disabled does not start, with the one-line remedy");
  await claims.unsafe("ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at");
  assert(/updated_at trigger\s+thoughts_updated_at enabled/.test((await run(SQL_ENV)).out), "…and enabled again it is ok");
  // 018 re-applied by hand puts the 7-argument form back BESIDE 021's.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("018") });
  const twoEdits = await run(SQL_ENV);
  assert(twoEdits.code === 1 && /edit signature\s+beside the form the servers call there is an earlier one: update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\)/.test(twoEdits.out),
         "018 re-applied over 021 leaves two update_thought forms, and the start is refused naming the extra one");
  assert(/DROP FUNCTION update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\);/.test(twoEdits.out), "…with the exact DROP as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") });
  const reapplied021 = await run(SQL_ENV);
  assert(reapplied021.code === 0, "…which 021 re-applied performs");
  // …and 021's CREATE OR REPLACE put its 3-argument upsert_thought back over
  // 022's: a chunkless re-capture would leave the previous vector's windows
  // again. A warning naming 022 — captures work, search is over-inclusive.
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 \(021 re-applied by hand puts it back\)/.test(reapplied021.out) && /Apply db\/migrations\/022_capture_replaces_chunks\.sql\./.test(reapplied021.out),
         "021 re-applied over 022 leaves 021's 3-argument upsert_thought, and the start warns naming 022 rather than refusing");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("022") });
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present; the 3-argument body is 022's, so a re-capture's windows stay only while the label vouches for them\s*$/m.test((await run(SQL_ENV)).out),
         "…and 022 re-applied is the shipped body again, said as such");
  // The 3-argument form gone from a 022 database: the remedy is the last
  // definer, not 004 — whose body would drop 005's guard, 008's actor, 021's
  // label and 022's rule.
  await claims.unsafe("DROP FUNCTION upsert_thought(text, jsonb, vector)");
  const noThree = await run(SQL_ENV);
  assert(noThree.code === 1 && /atomic capture\s+2 upsert_thought overload\(s\) — the 3-argument form, the atomic capture, is missing/.test(noThree.out) && /Apply db\/migrations\/022_capture_replaces_chunks\.sql — the last definer of the 3-argument form/.test(noThree.out) && !/Apply db\/migrations\/004_/.test(noThree.out),
         "the 3-argument form missing is a refusal whose remedy is 022, the last definer — not 004");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("022") });
  assert((await run(SQL_ENV)).code === 0, "…which 022 re-applied performs");
  // A database whose update_thought predates 021.
  await claims.unsafe(`DROP FUNCTION ${UPDATE_THOUGHT_SIGNATURE}`);
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("018") });
  const pre021 = await run(SQL_ENV);
  assert(pre021.code === 1 && /edit signature\s+update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\) is the form from before migration 021; the server sends p_embedding_model/.test(pre021.out) && /Apply db\/migrations\/021_embedding_model_per_row\.sql\./.test(pre021.out),
         "a 018-era update_thought under a 021 server does not start, and is named by its signature with 021 as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") || f.startsWith("022") });
  await claims.unsafe("UPDATE thoughts SET embedding = NULL");

  await claims.unsafe("DROP TABLE thought_work_claims");
  const pre015 = await run(SQL_ENV);
  assert(pre015.code === 0 && /re-embed pass\s+not checked — thought_work_claims does not exist/.test(pre015.out),
         "before migration 015 there is nothing to read, and the check says so rather than warning");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("015") });

  // The chunk writers run as the calling role. A role that can read
  // everything and write thoughts, but not delete from thought_chunks, would
  // fail every edit with content and every re-capture at another model — so
  // preflight refuses to start it, with the GRANT; granted, it starts. A
  // role is cluster-wide and dropSchema does not touch it, so an interrupted
  // run's leftover is dropped first and the fixture is cleaned up whatever
  // happens inside it.
  const CAPTURE_URL = LIVE.replace(/\/\/[^@]*@/, "//ob1_pf_capture:ob1pf@");
  const dropCaptureRole = () => claims.unsafe(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_pf_capture') THEN
      EXECUTE 'DROP OWNED BY ob1_pf_capture'; EXECUTE 'DROP ROLE ob1_pf_capture';
    END IF; END $$`);
  const [{ mayCreate }] = await claims`SELECT (rolsuper OR rolcreaterole) AS "mayCreate" FROM pg_roles WHERE rolname = current_user`;
  if (CAPTURE_URL === LIVE) {
    skipRaw("a capturing role without DELETE on thought_chunks does not start", "DATABASE_URL carries no credentials to swap for the role's");
  } else if (!mayCreate) {
    skipRaw("a capturing role without DELETE on thought_chunks does not start", "the connection's role cannot CREATE ROLE");
  } else {
    await dropCaptureRole();
    try {
      await claims.unsafe("CREATE ROLE ob1_pf_capture LOGIN PASSWORD 'ob1pf'");
      await claims.unsafe("GRANT USAGE ON SCHEMA public TO ob1_pf_capture");
      await claims.unsafe("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ob1_pf_capture");
      await claims.unsafe("GRANT INSERT, UPDATE, DELETE ON thoughts TO ob1_pf_capture");
      const noDelete = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(noDelete.code === 1 && /chunk delete privilege\s+this connection's role \(ob1_pf_capture\) cannot DELETE from thought_chunks/.test(noDelete.out) && /GRANT DELETE ON thought_chunks TO ob1_pf_capture;/.test(noDelete.out),
             `a capturing role without DELETE on thought_chunks does not start, with the GRANT as the remedy (exit ${noDelete.code})`);
      assert(/atomic capture\s+the 2- and 3-argument upsert_thought present; the 3-argument body is 022's/.test(noDelete.out), "…while atomic capture, a separate fact, is ok for it");
      await claims.unsafe("GRANT DELETE ON thought_chunks TO ob1_pf_capture");
      const granted = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(granted.code === 0 && /chunk delete privilege\s+ob1_pf_capture can DELETE from thought_chunks/.test(granted.out),
             `…and granted, it starts (exit ${granted.code}: ${granted.out.split("\n").filter((l) => /fail/.test(l)).join(" | ").trim()})`);
    } finally {
      await dropCaptureRole();
    }
  }

  // 003's missing half. A NULL-fingerprint row whose key no row holds is a
  // capture doubled in waiting; 023's function writes it, and the remedy is
  // that one statement — as the owner, since it holds the updated_at
  // trigger. After it a NULL row is a twin, or blocked by a stale key: ok.
  // Before 023 the same row's remedy is the migration.
  await claims.unsafe("DELETE FROM thoughts");
  await claims.unsafe("INSERT INTO thoughts (content, content_fingerprint) VALUES ('a legacy singleton', NULL)");
  const [{ owner }] = await claims`SELECT pg_get_userbyid(relowner)::text AS owner FROM pg_class WHERE oid = 'thoughts'::regclass`;
  const pending = await run(SQL_ENV);
  assert(pending.code === 0 && /fingerprint backfill\s+1 thought\(s\) without a fingerprint, at least one whose text no row holds — 023's call has not reached them/.test(pending.out) && pending.out.includes(`As ${owner}: SELECT backfill_content_fingerprints(); — or, keeping each lock short, SELECT backfill_content_fingerprints(10000); until it returns 0, each call its own transaction.`),
         `a NULL-fingerprint row whose key is free is a warning that claims no cause it cannot read, with the one-statement remedy and its batched form, naming the owner (exit ${pending.code})`);
  await claims.unsafe("SELECT backfill_content_fingerprints()");
  assert(/fingerprint backfill\s+no thought is missing a fingerprint \(a stale key on a row that has one is not read here\)/.test((await run(SQL_ENV)).out), "…which performs, and the ok says what it did not read");
  await claims.unsafe("INSERT INTO thoughts (content, content_fingerprint) VALUES ('a  legacy singleton', NULL)");
  const twin = await run(SQL_ENV);
  assert(twin.code === 0 && /fingerprint backfill\s+1 thought\(s\) without a fingerprint, each sharing its text with the row that holds it \(a twin, or a stale key\)/.test(twin.out),
         "a NULL row whose text a fingerprinted row holds is a twin, not pending — ok, pointing at the pairs list");
  await claims.unsafe("DROP FUNCTION backfill_content_fingerprints(integer)");
  await claims.unsafe("INSERT INTO thoughts (content, content_fingerprint) VALUES ('another legacy singleton', NULL)");
  const pre023 = await run(SQL_ENV);
  assert(pre023.code === 0 && /fingerprint backfill\s+2 thought\(s\) without a fingerprint, at least one whose text no row holds: a capture of that text inserts a second row/.test(pre023.out) && /Apply db\/migrations\/023_content_fingerprint_backfill\.sql\./.test(pre023.out),
         "before 023 the same row is a warning whose remedy is the migration");
  // Adopted with --baseline: the ledger says 023, the function is absent, and
  // "apply 023" would be a loop the migrator skips out of. The remedy is the
  // migrator's re-run, as reembed.ts says for 021 (SMD-1193).
  await claims.unsafe("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  await claims.unsafe("INSERT INTO schema_migrations (name, sha256) VALUES ('023_content_fingerprint_backfill.sql', 'baseline') ON CONFLICT DO NOTHING");
  const baselined = await run(SQL_ENV);
  assert(/fingerprint backfill\s+2 thought\(s\) without a fingerprint/.test(baselined.out) && /The ledger says 023 but backfill_content_fingerprints is absent \(adopted with --baseline\): re-apply the recorded migrations with the migrator — cd db && bun migrate\.ts --url … --reapply — which re-runs every recorded file in one transaction/.test(baselined.out),
         "…and where the ledger already says 023 the remedy is the migrator's re-run, not a migration a plain run would skip");
  await claims.unsafe("DROP TABLE schema_migrations");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("023") });
  assert(/fingerprint backfill\s+1 thought\(s\) without a fingerprint, each sharing its text/.test((await run(SQL_ENV)).out), "…and 023 applied writes it and is ok again, the twin still listed");

  await claims.unsafe("DELETE FROM thoughts");
  await claims.close();

  const j = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE }, "--json");
  const parsed = JSON.parse(j.out);
  assert(parsed.ok === true, "--json reports ok:true");
  assert(Array.isArray(parsed.checks) && parsed.checks.length > 5, "--json lists every check for a pipeline to consume");
}

report();
