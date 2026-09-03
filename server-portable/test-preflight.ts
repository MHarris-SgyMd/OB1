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
import { applyMigrations, createAssert, dropSchema } from "../db/test-support.ts";

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
  const p = Bun.spawn(["bun", join(HERE, "preflight.ts"), ...args], {
    env: clean, stdout: "pipe", stderr: "pipe", cwd: HERE,
  });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
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
   * The trigram index is opt-in, and its flag is only read when 011 applies. So
   * the state that actually needs catching is the one a migrator run cannot fix:
   * the setting says on, the ledger says 011 is done, and nothing built an index.
   * Left undetected that is a silent no-op on an explicit instruction.
   *
   * The schema above was built with the default (off), so simply asking for it
   * reproduces the mismatch exactly — no sabotage needed.
   */
  const offOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/trigram index.*disabled/s.test(offOff.out), "with the flag unset, preflight reports the index disabled");

  const wantOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_TRGM_INDEX: "on" });
  assert(wantOn.code === 0, "a trigram mismatch is a warning, not a refusal to serve");
  assert(/OB1_TRGM_INDEX is on but idx_thoughts_content_trgm does not exist/.test(wantOn.out),
         "…and names the disagreement between the setting and the database");
  assert(/CREATE INDEX CONCURRENTLY/.test(wantOn.out), "…with the statement that fixes it");

  // The mirror: build it, leave the flag off, and the warning must invert rather
  // than the check simply going quiet whenever the two differ.
  const idx = new SQL({ url: LIVE, max: 1 });
  await idx.unsafe("CREATE INDEX IF NOT EXISTS idx_thoughts_content_trgm ON thoughts USING gin (content gin_trgm_ops)");
  await idx.close();

  const nowOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_TRGM_INDEX: "on" });
  assert(/trigram index.*enabled and present/s.test(nowOn.out), "once built, the setting and the database agree");

  const unwanted = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/exists but OB1_TRGM_INDEX is off/.test(unwanted.out),
         "an index nobody asked for is reported too — it costs every capture");

  const drop = new SQL({ url: LIVE, max: 1 });
  await drop.unsafe("DROP INDEX IF EXISTS idx_thoughts_content_trgm");
  await drop.close();

  const j = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE }, "--json");
  const parsed = JSON.parse(j.out);
  assert(parsed.ok === true, "--json reports ok:true");
  assert(Array.isArray(parsed.checks) && parsed.checks.length > 5, "--json lists every check for a pipeline to consume");
}

report();
