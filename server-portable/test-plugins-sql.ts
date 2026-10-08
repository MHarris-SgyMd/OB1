#!/usr/bin/env bun
/**
 * test-plugins-sql.ts — a plugin's tables against real Postgres (SMD-2310):
 * the migrator's plugin ledger (a dry run lists a plugin's migrations under
 * it and makes nothing; a run makes the plugin's role and schema and records
 * each file; a second run skips; an edited file is a drift; a name that is no
 * plugin is refused before anything runs; a plugin not named is left as it
 * is), the role's boundary (its migration and its handle reach its own schema
 * and are refused the core's tables), and the example plugin's operations
 * through both servers on one database — a note pinned to a captured thought
 * over REST and read back over MCP, behind each key's scope — and preflight's
 * row for the plugin's tables.
 *
 *   ../db/with-postgres.sh bun test-plugins-sql.ts
 */

import { SQL } from "bun";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssert, dropSchema, runScript } from "../db/test-support.ts";
import { hashKey } from "./auth.ts";
import { migrationSha } from "../db/version.mjs";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../db/config.mjs";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-plugins-sql.ts");
  process.exit(2);
}

// The width and model db/config.mjs read when the static imports above loaded
// it — the migrator's and, pinned here, the servers' — so the schema and the
// stub's vectors agree.
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;

const { assert, report } = createAssert();
const HERE = import.meta.dir;
const PLUGINS = join(HERE, "..", "plugins");
const NOTES_SHA = migrationSha(readFileSync(join(PLUGINS, "example", "migrations", "001_notes.sql"), "utf8"));

const { run: migrate } = await import("../db/migrate.ts");
/** One migrator run, its lines kept: out and err, and the exit code. */
async function runMigrate(opts: { plugins?: string; dryRun?: boolean; reapply?: boolean; pluginsDir?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await migrate({ url: URL_, ...opts, writer: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const sql = new SQL({ url: URL_, max: 2 });
const one = async <T>(q: Promise<unknown>): Promise<T> => ((await q) as T[])[0];

await dropSchema(URL_);

console.log("\n[1] A dry run lists the plugin's migrations under their own ledger, and makes nothing");
{
  const r = await runMigrate({ plugins: "example", dryRun: true });
  assert(r.code === 0, `exit 0 (${r.code}: ${r.err.slice(0, 200)})`);
  assert(/\nplugins: example — ledger plugin_migrations/.test(r.out), "the plugins' section names its ledger");
  assert(/ {2}plugin example {2}\(schema plugin_example, role ob1_plugin_example\)/.test(r.out), "the plugin, with its schema and its role");
  assert(r.out.includes(`  →  001_notes.sql  would apply (${NOTES_SHA}) as ob1_plugin_example in plugin_example`), "its migration, its sha, and the role and schema it would run as");
  assert(/\nplugins: would apply 1, skipped 0$/m.test(r.out), "the plugins' own summary");
  assert(/\nwould apply \d+, skipped 0\n/.test(`${r.out}\n`), "the core's summary line, as it always reads, before the plugins'");
  const made = await one<{ schema: boolean; ledger: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'plugin_example') AS schema, to_regclass('public.plugin_migrations') IS NOT NULL AS ledger`);
  assert(!made.schema && !made.ledger, "nothing made: no schema, no ledger");
}

console.log("\n[2] A run makes the role and the schema, runs the file as the role, and records it in the plugin ledger alone");
{
  const r = await runMigrate({ plugins: "example" });
  assert(r.code === 0 && r.out.includes("  ✓  001_notes.sql  applied") && /plugins: applied 1, skipped 0/.test(r.out), `applied (${r.code}: ${r.err.slice(0, 300)})`);
  const owner = await one<{ schema_owner: string; table_owner: string; role_login: boolean }>(sql`
    SELECT (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'plugin_example') AS schema_owner,
           (SELECT tableowner FROM pg_tables WHERE schemaname = 'plugin_example' AND tablename = 'notes') AS table_owner,
           (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ob1_plugin_example') AS role_login`);
  assert(owner.schema_owner === "ob1_plugin_example" && owner.table_owner === "ob1_plugin_example", `the schema and its table are the plugin role's (${JSON.stringify(owner)})`);
  assert(owner.role_login === false, "the role cannot log in");
  const ledger = (await sql`SELECT plugin, name, sha256 FROM public.plugin_migrations`) as { plugin: string; name: string; sha256: string }[];
  assert(ledger.length === 1 && ledger[0].plugin === "example" && ledger[0].name === "001_notes.sql" && ledger[0].sha256 === NOTES_SHA, `one ledger row, at the file's sha (${JSON.stringify(ledger)})`);
  const core = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '001_notes.sql'`);
  assert(core.n === 0, "the core's ledger records no plugin file");
  const again = await runMigrate({ plugins: "example" });
  assert(again.code === 0 && again.out.includes("  ·  001_notes.sql  already applied") && /plugins: applied 0, skipped 1/.test(again.out), "a second run skips it");
  const dry = await runMigrate({ plugins: "example", dryRun: true });
  assert(dry.code === 0 && /plugins: would apply 0, skipped 1/.test(dry.out), "and a dry run says so");
  const reapply = await runMigrate({ plugins: "example", reapply: true });
  assert(/plugins: example — not run under --reapply/.test(reapply.out), `--reapply leaves the plugins to a plain run, and says so (${reapply.code})`);
}

console.log("\n[3] The role's boundary: its own schema, and none of the core's tables");
{
  const asRole = async (statement: string): Promise<string> => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE ob1_plugin_example");
        await tx.unsafe("SET LOCAL search_path TO plugin_example, public");
        await tx.unsafe(statement);
        throw new Error("ROLLBACK-OK");
      });
      return "ran";
    } catch (e) {
      const m = (e as Error).message;
      return m === "ROLLBACK-OK" ? "ran" : m;
    }
  };
  assert((await asRole("INSERT INTO notes (thought_id, note, written_by) VALUES (gen_random_uuid(), 'x', 'k')")) === "ran", "it writes its own table, named bare");
  for (const statement of ["SELECT count(*) FROM thoughts", "SELECT count(*) FROM public.thought_audit", "INSERT INTO thoughts (content) VALUES ('x')", "SELECT count(*) FROM schema_migrations", "CREATE TABLE public.squat (x int)"]) {
    const said = await asRole(statement);
    assert(/permission denied/.test(said), `refused by Postgres: ${statement} (${said.slice(0, 80)})`);
  }
}

console.log("\n[4] A plugin migration that reaches for a core table fails, and records nothing; an edited file is a drift; a name that is no plugin is refused");
{
  const dir = mkdtempSync(join(tmpdir(), "smd2310-plugins-"));
  try {
    cpSync(join(PLUGINS, "example"), join(dir, "example"), { recursive: true });
    mkdirSync(join(dir, "nosy", "migrations"), { recursive: true });
    writeFileSync(join(dir, "nosy", "index.ts"), "export default {};\n");
    writeFileSync(join(dir, "nosy", "migrations", "001_peek.sql"), "CREATE TABLE IF NOT EXISTS peek AS SELECT id FROM thoughts;\n");
    let r = await runMigrate({ plugins: "nosy", pluginsDir: dir });
    assert(r.code === 1 && /✗ {2}nosy\/001_peek.sql {2}FAILED: .*permission denied/.test(r.err) && /runs as ob1_plugin_nosy, which holds its own schema alone/.test(r.err), `a migration reading a core table fails, and says why (${r.err.slice(0, 200)})`);
    const recorded = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.plugin_migrations WHERE plugin = 'nosy'`);
    assert(recorded.n === 0, "and nothing is recorded for it");
    writeFileSync(join(dir, "example", "migrations", "001_notes.sql"), `${readFileSync(join(dir, "example", "migrations", "001_notes.sql"), "utf8")}-- edited\n`);
    r = await runMigrate({ plugins: "example", pluginsDir: dir });
    assert(r.code === 1 && /⚠ {2}example\/001_notes.sql {2}ALREADY APPLIED BUT FILE CHANGED/.test(r.err) && /DRIFTED 1/.test(r.out), "an edited file is a drift: exit 1, named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const before = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM schema_migrations`);
  for (const [label, plugins] of [["a name that is no plugin", "example,nope"], ["a name given twice", "example,example"], ["a name that is no plugin's shape", "../db"]] as const) {
    const r = await runMigrate({ plugins });
    assert(r.code === 2 && /OB1_PLUGINS names/.test(r.err), `${label} is refused, exit 2 (${r.code}: ${r.err.slice(0, 120)})`);
  }
  const after = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM schema_migrations`);
  assert(before.n === after.n, "and refused before anything ran");
}

console.log("\n[5] A plugin not named is left as it is: no line, its schema and rows kept");
{
  await sql`INSERT INTO plugin_example.notes (thought_id, note, written_by) VALUES (gen_random_uuid(), 'kept while off', 'suite')`;
  const r = await runMigrate({});
  assert(r.code === 0 && !/plugins:/.test(r.out), "a run with no plugin named says nothing of plugins");
  const kept = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_example.notes WHERE note = 'kept while off'`);
  const ledger = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.plugin_migrations WHERE plugin = 'example'`);
  assert(kept.n === 1 && ledger.n === 1, "its row, its table and its ledger row are still there");
  await sql`DELETE FROM plugin_example.notes WHERE note = 'kept while off'`;
}

// ── Both servers, the example enabled, over this database ────────────────────
const STUB_BASE = "https://stub.invalid/v1";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(STUB_BASE)) {
    if (url.endsWith("/embeddings")) {
      const v = new Array(EMBEDDING_DIM).fill(0);
      v[0] = 1;
      return Response.json({ data: [{ embedding: v }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ topics: ["stubbed"], type: "idea" }) } }] });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;
process.env.OB1_LLM_BASE_URL = STUB_BASE;
process.env.OB1_LLM_LOCAL = "1";
process.env.OPENROUTER_API_KEY = "stub";
delete process.env.OB1_STORE;
delete process.env.MCP_ACCESS_KEY;
process.env.DATABASE_URL = URL_;
process.env.OB1_PLUGINS = "example";
const KEYS = { writer: "writer-raw", reader: "reader-raw", hook: "hook-raw" } as const;
process.env.MCP_ACCESS_KEYS = [`writer:write:${hashKey(KEYS.writer)}`, `reader:read:${hashKey(KEYS.reader)}`, `hook:capture:${hashKey(KEYS.hook)}`].join(",");
const mcpServer = Bun.serve({ port: 0, fetch: (await import("./index.ts")).default.fetch });
const apiServer = Bun.serve({ port: 0, fetch: (await import("./api.ts")).default.fetch });
const MCP = `http://localhost:${mcpServer.port}`;
const API = `http://localhost:${apiServer.port}`;
async function rest(method: string, path: string, body: unknown, key: string) {
  const r = await fetch(`${API}${path}`, { method, headers: { "x-brain-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function mcp(method: string, params: Record<string, unknown>, key: string) {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const t = await r.text();
  return JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6)) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean; tools?: { name: string }[]; content?: { text: string }[] }; error?: { message: string } };
}

console.log("\n[6] The example's operations through both servers: a note pinned over REST, read back over MCP, each behind its key's scope");
{
  const captured = await rest("POST", "/v1/thoughts", { content: "alpha: a thought to pin a note to" }, KEYS.writer);
  const thoughtId = String(captured.body.id);
  assert(captured.status === 201, `a thought to pin to (${captured.status} ${JSON.stringify(captured.body)})`);
  const added = await rest("POST", "/v1/plugins/example/notes", { thought_id: thoughtId, note: "  checked with the team  " }, KEYS.writer);
  const note = added.body.note as Record<string, unknown> | undefined;
  assert(added.status === 200 && note?.thought_id === thoughtId && note?.note === "checked with the team" && note?.written_by === "writer", `a write key pins a note, trimmed, written by its key (${JSON.stringify(added.body)})`);
  const row = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_example.notes WHERE thought_id = ${thoughtId}`);
  assert(row.n === 1, "the row is in the plugin's own table");
  const listed = await mcp("tools/call", { name: "example_list_notes", arguments: { thought_id: thoughtId } }, KEYS.reader);
  const notes = (listed.result?.structuredContent?.notes ?? []) as Record<string, unknown>[];
  assert(listed.result?.isError !== true && notes.length === 1 && notes[0].id === note?.id && notes[0].created_at === note?.created_at, `a read key reads it back over MCP, the same note (${JSON.stringify(listed).slice(0, 200)})`);
  const viaRest = await rest("GET", `/v1/plugins/example/notes?thought_id=${thoughtId}`, undefined, KEYS.reader);
  assert(JSON.stringify(viaRest.body) === JSON.stringify(listed.result?.structuredContent), "and the REST answer is the MCP structured content");
  const recent = await mcp("tools/call", { name: "example_recent", arguments: { limit: 3 } }, KEYS.reader);
  assert(((recent.result?.structuredContent?.thoughts ?? []) as { id: string }[]).some((t) => t.id === thoughtId), "example_recent finds the captured thought, through the core");
  const readerAdd = await rest("POST", "/v1/plugins/example/notes", { thought_id: thoughtId, note: "x" }, KEYS.reader);
  assert(readerAdd.status === 403 && readerAdd.body.needs === "write", "a read key cannot pin a note: 403 needs write");
  const hookTools = ((await mcp("tools/list", {}, KEYS.hook)).result?.tools ?? []).map((t) => t.name);
  assert(!hookTools.some((t) => t.startsWith("example_")), "a capture key sees no example tool");
  const nowhere = await rest("POST", "/v1/plugins/example/notes", { thought_id: "00000000-0000-4000-8000-000000000000", note: "x" }, KEYS.writer);
  assert(nowhere.status === 404 && nowhere.body.code === "NO_SUCH_THOUGHT", `a thought that is not there: 404 NO_SUCH_THOUGHT, nothing written (${JSON.stringify(nowhere.body)})`);
  const viaMcp = await mcp("tools/call", { name: "example_add_note", arguments: { thought_id: thoughtId, note: "second" } }, KEYS.writer);
  assert(viaMcp.result?.isError !== true && (viaMcp.result?.structuredContent?.note as Record<string, unknown>)?.written_by === "writer", "a write key pins one over MCP too");
}

console.log("\n[7] The plugin's handle: its own table, named bare; a core table refused by Postgres");
{
  const { SqlStore } = await import("./store-sql.ts");
  const store = new SqlStore(URL_, { max: 1 });
  try {
    const mine = await store.pluginTx("example", (q) => q<{ n: number }>`SELECT count(*)::int AS n FROM notes`);
    assert(mine[0].n >= 2, `its own table, named bare (${mine[0].n})`);
    let said = "";
    try { await store.pluginTx("example", (q) => q`SELECT count(*) FROM thoughts`); } catch (e) { said = (e as Error).message; }
    assert(/permission denied/.test(said), `a core table through the handle: refused by Postgres (${said.slice(0, 80)})`);
    said = "";
    try { await store.pluginTx("example", (q) => q`SELECT count(*) FROM public.thought_audit`); } catch (e) { said = (e as Error).message; }
    assert(/permission denied/.test(said), "a core table named with its schema: refused too");
    const value = await store.pluginTx("example", (q) => q<{ v: string }>`SELECT ${"x'); DROP TABLE notes; --"}::text AS v`);
    assert(value[0].v === "x'); DROP TABLE notes; --", "a value is a bound parameter, never SQL");
    said = "";
    try { await store.pluginTx("Example", async () => 1); } catch (e) { said = (e as Error).message; }
    assert(/is not a plugin name/.test(said), "a name that is no plugin's shape is refused before it reaches SQL");
    // What a plugin's SQL leaves on its session — a temp table, which Postgres
    // searches before any schema, a session search_path — is on the plugin's
    // own connections: the core's queries, on a pool of one connection here,
    // never meet it.
    const before = await store.countThoughts();
    await store.pluginTx("example", (q) => q`CREATE TEMP TABLE thoughts AS SELECT generate_series(1, 50) AS id`);
    await store.pluginTx("example", (q) => q`SELECT set_config('search_path', 'plugin_example', false)`);
    assert((await store.countThoughts()) === before && before >= 1, `a temp table named thoughts and a session path, left by a plugin, do not reach the core's queries (${before} thoughts, as before)`);
  } finally {
    await store.close();
  }
}

console.log("\n[8] Preflight: the enabled plugin's tables in place; a migration the ledger lacks fails the row");
{
  const env = (plugins: string): Record<string, string> => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_PROXY$/i.test(k)) clean[k] = v;
    return { ...clean, OB1_PLUGINS: plugins, MCP_ACCESS_KEY: "x".repeat(64), MCP_ACCESS_KEYS: "", OB1_LLM_BASE_URL: `http://127.0.0.1:${localStub.port}/v1` };
  };
  const localStub = Bun.serve({ port: 0, fetch: () => Response.json({ object: "list", data: [] }) });
  const row = (out: string) => out.split("\n").find((l) => /^\s*[✓✗!·]\s+plugin tables\s/.test(l)) ?? "";
  let r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✓\s+plugin tables\s+example — each plugin's role, schema and migrations in place/.test(row(r.out)), `in place: ok (${row(r.out) || (r.out).slice(-300)})`);
  await sql`DELETE FROM public.plugin_migrations WHERE plugin = 'example'`;
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+example: 1 migration\(s\) not applied \(001_notes.sql\)/.test(row(r.out)), `a migration the ledger lacks: fail, named (${row(r.out)})`);
  await sql`INSERT INTO public.plugin_migrations (plugin, name, sha256) VALUES ('example', '001_notes.sql', ${NOTES_SHA})`;
  // A table owned by another role (a restore with --no-owner, say) is one the plugin's role cannot reach.
  await sql`ALTER TABLE plugin_example.notes OWNER TO postgres`;
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+example: in plugin_example, not owned by ob1_plugin_example: notes \(postgres\)/.test(row(r.out)), `a table owned by another role: fail, named (${row(r.out)})`);
  await sql`ALTER TABLE plugin_example.notes OWNER TO ob1_plugin_example`;
  localStub.stop(true);
}

console.log("\n[9] A migrator that is no superuser, with CREATEROLE: it takes the SET membership PG 16 does not give it, and the plugin's schema is the plugin role's");
{
  const migrator = "smd2310_migrator";
  const [{ db }] = (await sql`SELECT current_database() AS db`) as { db: string }[];
  await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${migrator}') THEN CREATE ROLE ${migrator} LOGIN CREATEROLE PASSWORD 'smd2310-pw'; END IF; END $$`);
  await sql.unsafe(`GRANT CREATE ON DATABASE "${db}" TO ${migrator}`);
  await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrator}`);
  await sql.unsafe(`GRANT SELECT ON schema_migrations TO ${migrator}`);
  await sql.unsafe(`GRANT SELECT, INSERT ON public.plugin_migrations TO ${migrator}`);
  const asMigrator = new URL(URL_);
  asMigrator.username = migrator;
  asMigrator.password = "smd2310-pw";
  const dir = mkdtempSync(join(tmpdir(), "smd2310-plugins-"));
  try {
    mkdirSync(join(dir, "second", "migrations"), { recursive: true });
    writeFileSync(join(dir, "second", "index.ts"), "export default {};\n");
    writeFileSync(join(dir, "second", "migrations", "001_items.sql"), "CREATE TABLE IF NOT EXISTS items (id int PRIMARY KEY);\n");
    const out: string[] = [];
    const errs: string[] = [];
    const code = await migrate({ url: asMigrator.toString(), plugins: "second", pluginsDir: dir, writer: { out: (l: string) => out.push(l), err: (l: string) => errs.push(l) } });
    assert(code === 0 && out.join("\n").includes("  ✓  001_items.sql  applied"), `applied as a CREATEROLE role (${code}: ${errs.join(" | ").slice(0, 300)})`);
    const owner = await one<{ schema_owner: string; table_owner: string }>(sql`
      SELECT (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'plugin_second') AS schema_owner,
             (SELECT tableowner FROM pg_tables WHERE schemaname = 'plugin_second' AND tablename = 'items') AS table_owner`);
    assert(owner.schema_owner === "ob1_plugin_second" && owner.table_owner === "ob1_plugin_second", `the schema and table are the plugin role's, not the migrator's (${JSON.stringify(owner)})`);
    const again = await migrate({ url: asMigrator.toString(), plugins: "second", pluginsDir: dir, writer: { out: () => {}, err: () => {} } });
    assert(again === 0, "and a second run as that role is clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n[10] A run that names a plugin makes its role and schema though nothing is pending; one plugin file's temp table never meets the next plugin's");
{
  const dir = mkdtempSync(join(tmpdir(), "smd2310-plugins-"));
  try {
    for (const [name, body] of [["restored", "CREATE TABLE IF NOT EXISTS kept (id int);\n"], ["aa", "CREATE TEMP TABLE shadow_me (x int);\n"], ["bb", "CREATE TABLE IF NOT EXISTS shadow_me (x int);\nINSERT INTO shadow_me VALUES (1);\n"]] as const) {
      mkdirSync(join(dir, name, "migrations"), { recursive: true });
      writeFileSync(join(dir, name, "index.ts"), "export default {};\n");
      writeFileSync(join(dir, name, "migrations", "001_x.sql"), body);
    }
    // Recorded, with no role and no schema: a brain restored into a cluster that never had them.
    await sql`INSERT INTO public.plugin_migrations (plugin, name, sha256) VALUES ('restored', '001_x.sql', ${migrationSha("CREATE TABLE IF NOT EXISTS kept (id int);\n")})`;
    const r = await runMigrate({ plugins: "restored,aa,bb", pluginsDir: dir });
    assert(r.code === 0, `exit 0 (${r.code}: ${r.err.slice(0, 200)})`);
    const made = await one<{ role: boolean; schema: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_plugin_restored') AS role, EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'plugin_restored') AS schema`);
    assert(made.role && made.schema, `the recorded plugin's role and schema are made again (${JSON.stringify(made)})`);
    const landed = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_bb.shadow_me`);
    assert(landed.n === 1, `the next plugin's row lands in its own table, not the temp table the one before left (${landed.n})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mcpServer.stop(true);
apiServer.stop(true);
await sql.close();
report();
