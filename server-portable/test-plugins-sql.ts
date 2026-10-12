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
import type { PluginSql } from "./plugin-sdk.ts";
import { migrationSha } from "../db/version.mjs";
import { EMBEDDING_DIM, EMBEDDING_MODEL, pluginForeignOwned, pluginLoginUrl } from "../db/config.mjs";

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
const DELIVERIES_SHA = migrationSha(readFileSync(join(PLUGINS, "example", "migrations", "002_deliveries.sql"), "utf8"));

const { run: migrate } = await import("../db/migrate.ts");
/** One migrator run, its lines kept: out and err, and the exit code. */
async function runMigrate(opts: { plugins?: string; dryRun?: boolean; reapply?: boolean; pluginsDir?: string; pluginPassword?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await migrate({ url: URL_, pluginPassword: PLUGIN_PW, ...opts, writer: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const sql = new SQL({ url: URL_, max: 2 });
/** The plugin login role's password (OB1_PLUGIN_DB_PASSWORD): the migrator makes ob1_plugins with it, the servers log in with it. */
// URL-special characters, `%` among them, so the login URL's encoding is in every run (PR 3 review pass 2).
const PLUGIN_PW = "smd2310 %41@:/#?&=pw";
/** A connection as the plugin login role, as the servers' plugin pools and the migrator's plugin phase log in. */
const asLogin = new SQL({ url: pluginLoginUrl(URL_, PLUGIN_PW), max: 1 });
/** This run's suffix for the roles and plugins [8]–[10] make: a role is the cluster's and outlives dropSchema, so a rerun against a kept cluster finds none of them (review pass 2). */
const RUN = Date.now().toString(36);
/** Roles this run made, dropped at the end with what they own. */
const madeRoles: string[] = [];
const one = async <T>(q: Promise<unknown>): Promise<T> => ((await q) as T[])[0];

await dropSchema(URL_);

console.log("\n[1] A dry run lists the plugin's migrations under their own ledger, and makes nothing");
{
  const r = await runMigrate({ plugins: "example", dryRun: true });
  assert(r.code === 0, `exit 0 (${r.code}: ${r.err.slice(0, 200)})`);
  assert(/\nplugins: example — ledger plugin_migrations/.test(r.out), "the plugins' section names its ledger");
  assert(/ {2}plugin example {2}\(schema plugin_example, role ob1_plugin_example\)/.test(r.out), "the plugin, with its schema and its role");
  assert(r.out.includes(`  →  001_notes.sql  would apply (${NOTES_SHA}) as ob1_plugin_example in plugin_example`) && r.out.includes(`  →  002_deliveries.sql  would apply (${DELIVERIES_SHA}) as ob1_plugin_example in plugin_example`), "its migrations, their shas, and the role and schema they would run as");
  assert(/\nplugins: would apply 2, skipped 0$/m.test(r.out), "the plugins' own summary");
  assert(/\nwould apply \d+, skipped 0\n/.test(`${r.out}\n`), "the core's summary line, as it always reads, before the plugins'");
  const made = await one<{ schema: boolean; ledger: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'plugin_example') AS schema, to_regclass('public.plugin_migrations') IS NOT NULL AS ledger`);
  assert(!made.schema && !made.ledger, "nothing made: no schema, no ledger");
}

console.log("\n[2] A run makes the role and the schema, runs the file as the role, and records it in the plugin ledger alone");
{
  const r = await runMigrate({ plugins: "example" });
  assert(r.code === 0 && r.out.includes("  ✓  001_notes.sql  applied") && r.out.includes("  ✓  002_deliveries.sql  applied") && /plugins: applied 2, skipped 0/.test(r.out), `applied (${r.code}: ${r.err.slice(0, 300)})`);
  const owner = await one<{ schema_owner: string; table_owner: string; role_login: boolean }>(sql`
    SELECT (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'plugin_example') AS schema_owner,
           (SELECT tableowner FROM pg_tables WHERE schemaname = 'plugin_example' AND tablename = 'notes') AS table_owner,
           (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ob1_plugin_example') AS role_login`);
  assert(owner.schema_owner === "ob1_plugin_example" && owner.table_owner === "ob1_plugin_example", `the schema and its table are the plugin role's (${JSON.stringify(owner)})`);
  assert(owner.role_login === false, "the role cannot log in");
  const ledger = (await sql`SELECT plugin, name, sha256 FROM public.plugin_migrations ORDER BY name`) as { plugin: string; name: string; sha256: string }[];
  assert(JSON.stringify(ledger) === JSON.stringify([{ plugin: "example", name: "001_notes.sql", sha256: NOTES_SHA }, { plugin: "example", name: "002_deliveries.sql", sha256: DELIVERIES_SHA }]), `a ledger row a file, at its sha (${JSON.stringify(ledger)})`);
  const core = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '001_notes.sql'`);
  assert(core.n === 0, "the core's ledger records no plugin file");
  const again = await runMigrate({ plugins: "example" });
  assert(again.code === 0 && again.out.includes("  ·  001_notes.sql  already applied") && again.out.includes("  ·  002_deliveries.sql  already applied") && /plugins: applied 0, skipped 2/.test(again.out), "a second run skips them");
  const dry = await runMigrate({ plugins: "example", dryRun: true });
  assert(dry.code === 0 && /plugins: would apply 0, skipped 2/.test(dry.out), "and a dry run says so");
  const reapply = await runMigrate({ plugins: "example", reapply: true });
  assert(/plugins: example — not run under --reapply/.test(reapply.out), `--reapply leaves the plugins to a plain run, and says so (${reapply.code})`);
}

console.log("\n[3] The role's boundary: its own schema, and none of the core's tables — and undoing the role reaches none of them either");
{
  const login = await one<{ login: boolean; superuser: boolean; inherit: boolean }>(sql`SELECT rolcanlogin AS login, rolsuper AS superuser, rolinherit AS inherit FROM pg_roles WHERE rolname = 'ob1_plugins'`);
  assert(login.login && !login.superuser && !login.inherit, `the run made ob1_plugins: LOGIN, no superuser, NOINHERIT (${JSON.stringify(login)})`);
  const asRole = async (statement: string): Promise<string> => {
    try {
      await asLogin.begin(async (tx) => {
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
  // The SQL check 31 is meant to refuse, run anyway: it leaves the plugin's
  // role and lands on the login role, which holds nothing on the core.
  for (const escape of ["RESET ROLE; SELECT count(*) FROM thoughts", "SET ROLE NONE; SELECT count(*) FROM thoughts", "END; SELECT count(*) FROM thoughts", "SELECT set_config('role', 'none', true); SELECT count(*) FROM thoughts", "RESET ROLE; INSERT INTO thoughts (content) VALUES ('x')"]) {
    const said = await asRole(escape);
    assert(/permission denied/.test(said), `undoing the role reaches no core table: ${escape} (${said.slice(0, 80)})`);
  }
  const [{ who }] = (await asLogin`SELECT current_user AS who`) as { who: string }[];
  assert(who === "ob1_plugins", "and the connection it lands on is the login role's");
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
    assert(r.code === 1 && /✗ {2}nosy\/001_peek.sql {2}FAILED: .*permission denied/.test(r.err) && /runs as ob1_plugin_nosy on ob1_plugins, which hold its own schema alone/.test(r.err), `a migration reading a core table fails, and says why (${r.err.slice(0, 200)})`);
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
  // No password: refused where a file would run, not where the plugins have nothing to do (a by-hand core run).
  const idleNoPassword = await runMigrate({ plugins: "example", pluginPassword: "" });
  assert(idleNoPassword.code === 0, `nothing of the plugins' pending and the login role made: no password asked (${idleNoPassword.code}: ${idleNoPassword.err.slice(0, 120)})`);
  const pendingDir = mkdtempSync(join(tmpdir(), "smd2310-plugins-"));
  try {
    mkdirSync(join(pendingDir, "pendingone", "migrations"), { recursive: true });
    writeFileSync(join(pendingDir, "pendingone", "index.ts"), "export default {};\n");
    writeFileSync(join(pendingDir, "pendingone", "migrations", "001_x.sql"), "CREATE TABLE IF NOT EXISTS x (id int);\n");
    const noPassword = await runMigrate({ plugins: "pendingone", pluginsDir: pendingDir, pluginPassword: "" });
    assert(noPassword.code === 2 && /OB1_PLUGIN_DB_PASSWORD is not set/.test(noPassword.err), `a pending plugin file and no login role password: refused before anything runs, exit 2 (${noPassword.code})`);
  } finally {
    rmSync(pendingDir, { recursive: true, force: true });
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
  assert(kept.n === 1 && ledger.n === 2, "its row, its table and its ledger rows are still there");
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
process.env.OB1_PLUGIN_DB_PASSWORD = PLUGIN_PW;
const HOOK_SECRET = "smd2310-hook-secret";
process.env.OB1_HOOKS = "example";
process.env.OB1_HOOK_SECRETS = `example=${HOOK_SECRET}`;
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

console.log("\n[6b] The example's webhook through the REST core: a signed delivery captured as the hook's own caller; a stale one refused, and a resent id run once");
{
  const { hmacSha256Hex } = await import("./plugin-sdk.ts");
  /** A delivery as the example's sender signs it: the HMAC of "<timestamp>.<body>", the timestamp beside it (SMD-2755). */
  const deliver = (body: string, ts = Math.floor(Date.now() / 1000)) =>
    fetch(`${API}/hooks/example/capture`, { method: "POST", headers: { "content-type": "application/json", "x-example-timestamp": String(ts), "x-example-signature": hmacSha256Hex(HOOK_SECRET, `${ts}.${body}`) }, body });
  const body = JSON.stringify({ text: "smd2310: a capture through the example webhook" });
  const r = await deliver(body);
  const got = (await r.json()) as { id?: string };
  assert(r.status === 202 && typeof got.id === "string", `a signed delivery: 202 and the thought's id (${r.status} ${JSON.stringify(got)})`);
  const audit = await one<{ actor_name: string; trust: string; source: string }>(sql`
    SELECT a.actor_name, a.trust, t.metadata->>'source' AS source FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id
     WHERE a.thought_id = ${got.id ?? ""} ORDER BY a.seq LIMIT 1`);
  assert(audit?.actor_name === "hook:example" && audit.trust === "ingested" && audit.source === "example-hook", `its audit row names the hook as the writer, its trust ingested (${JSON.stringify(audit)})`);
  const unsigned = await fetch(`${API}/hooks/example/capture`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert(unsigned.status === 401, "an unsigned delivery: 401");
  const captures = async (text: string) => (await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE t.content = ${text} AND a.actor_name = 'hook:example'`)).n;
  const staleText = `smd2755: stale ${RUN}`;
  const stale = await deliver(JSON.stringify({ text: staleText }), Math.floor(Date.now() / 1000) - 301);
  assert(stale.status === 401 && ((await stale.json()) as { code?: string }).code === "STALE_DELIVERY" && (await captures(staleText)) === 0, "a delivery signed 301 s ago: 401 STALE_DELIVERY, nothing captured");
  // The same delivery, its id and all, sent twice inside the tolerance.
  const onceText = `smd2755: once ${RUN}`;
  const once = JSON.stringify({ id: `evt-${RUN}`, text: onceText });
  const first = await deliver(once);
  const firstBody = (await first.json()) as { id?: string };
  const again = await deliver(once);
  const againBody = (await again.json()) as { id?: string; duplicate?: boolean };
  assert(first.status === 202 && typeof firstBody.id === "string", `the first: 202 and its thought (${first.status} ${JSON.stringify(firstBody)})`);
  assert(again.status === 200 && againBody.duplicate === true && againBody.id === firstBody.id, `the resend: 200, the same thought, marked a duplicate (${again.status} ${JSON.stringify(againBody)})`);
  const kept = await one<{ thought_id: string }>(sql`SELECT thought_id::text FROM plugin_example.deliveries WHERE id = ${`evt-${RUN}`}`);
  assert(kept?.thought_id === firstBody.id, "the delivery's id is kept in the plugin's own table, with its thought");
  // Kept the whole window: nine minutes on, a resend signed afresh is still the first's.
  await sql`UPDATE plugin_example.deliveries SET claimed_at = now() - interval '9 minutes' WHERE id = ${`evt-${RUN}`}`;
  const late = await deliver(once);
  const lateBody = (await late.json()) as { id?: string; duplicate?: boolean };
  assert(late.status === 200 && lateBody.duplicate === true && lateBody.id === firstBody.id, `nine minutes on, a resend is still the first's thought (${late.status} ${JSON.stringify(lateBody)})`);
  // A claim older than the window is pruned by the next delivery: a resend of the same bytes is stale by then, so the table keeps no more.
  await sql`UPDATE plugin_example.deliveries SET claimed_at = now() - interval '12 minutes' WHERE id = ${`evt-${RUN}`}`;
  const afterPrune = await deliver(JSON.stringify({ id: `evt-${RUN}-2`, text: `smd2755: later ${RUN}` }));
  const left = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_example.deliveries WHERE id = ${`evt-${RUN}`}`);
  assert(afterPrune.status === 202 && left.n === 0, `the next delivery prunes the old claim (${afterPrune.status}, ${left.n} left)`);
  // An unfinished claim — a server that stopped mid-capture — holds its id for its lease, then a retry takes it.
  const orphanText = `smd2755: orphan ${RUN}`;
  const orphan = JSON.stringify({ id: `evt-${RUN}-orphan`, text: orphanText });
  await sql`INSERT INTO plugin_example.deliveries (id, claimed_at) VALUES (${`evt-${RUN}-orphan`}, now() - interval '1 minute')`;
  const held = await deliver(orphan);
  assert(held.status === 409 && (await captures(orphanText)) === 0, `inside its lease: 409, nothing captured (${held.status})`);
  await sql`UPDATE plugin_example.deliveries SET claimed_at = now() - interval '4 minutes' WHERE id = ${`evt-${RUN}-orphan`}`;
  const taken = await deliver(orphan);
  const takenBody = (await taken.json()) as { id?: string };
  const recorded = await one<{ thought_id: string | null }>(sql`SELECT thought_id::text FROM plugin_example.deliveries WHERE id = ${`evt-${RUN}-orphan`}`);
  assert(taken.status === 202 && (await captures(orphanText)) === 1 && recorded?.thought_id === takenBody.id, `past it, the retry takes the claim and captures (${taken.status}, recorded ${recorded?.thought_id})`);
  const fresh = await one<{ fresh: boolean }>(sql`SELECT claimed_at > now() - interval '1 minute' AS fresh FROM plugin_example.deliveries WHERE id = ${`evt-${RUN}-orphan`}`);
  assert(fresh?.fresh === true, "the claim taken is dated afresh: its lease and its window start again");
  // The example's hook run over the plugin's real table, its core's capture
  // scripted: the claim's release and record as Postgres holds them, not as
  // test-plugins' stand-in table does.
  const { enabledHooks, loadPlugins, runHook } = await import("./core/plugins.ts");
  const { ok: coreOk, refuse: coreRefuse } = await import("./core/refusal.ts");
  const { SqlStore } = await import("./store-sql.ts");
  const store = new SqlStore(URL_, { max: 1, pluginPassword: PLUGIN_PW });
  const [hook] = enabledHooks(loadPlugins("example"), "example");
  const rowOf = async (id: string) => one<{ thought_id: string | null; claimed_at: string } | undefined>(sql`SELECT thought_id::text, claimed_at::text FROM plugin_example.deliveries WHERE id = ${id}`);
  /** One signed delivery of `id` through the hook, its capture `capture`, under a core whose captures may run `captureSeconds`: the answer, or the message it threw. */
  const viaHook = async (id: string, capture: () => Promise<unknown>, captureSeconds = 120) => {
    const scripted = new Proxy({}, { get: (_t, prop) => (prop === "pluginTx" ? store.pluginTx.bind(store) : prop === "captureSeconds" ? () => captureSeconds : capture) }) as never;
    const text = JSON.stringify({ id, text: `smd2755: ${id}` });
    const ts = Math.floor(Date.now() / 1000);
    try {
      return await runHook(hook, { core: scripted, secret: HOOK_SECRET }, {
        headers: { "x-example-timestamp": String(ts), "x-example-signature": hmacSha256Hex(HOOK_SECRET, `${ts}.${text}`) },
        query: {},
        body: new TextEncoder().encode(text),
        text,
      });
    } catch (e) {
      return (e as Error).message;
    }
  };
  try {
    // A capture that throws gives its claim back, matched to the microsecond, so the sender's retry runs.
    const failId = `evt-${RUN}-fail`;
    const thrown = await viaHook(failId, async () => { throw new Error("embedder down"); });
    assert(thrown === "embedder down" && (await rowOf(failId)) === undefined, `a capture that throws gives its claim back (${JSON.stringify(thrown)})`);
    // One that throws after a retry took its claim past the lease leaves the retry's claim alone.
    const takenId = `evt-${RUN}-taken`;
    const retaken = await viaHook(takenId, async () => {
      await sql`UPDATE plugin_example.deliveries SET claimed_at = now() + interval '1 second' WHERE id = ${takenId}`;
      throw new Error("timed out after the lease");
    });
    const left = await rowOf(takenId);
    assert(retaken === "timed out after the lease" && left !== undefined && left.thought_id === null, `a first attempt failing after a retry took its claim leaves the retry's claim standing (${JSON.stringify(left)})`);
    // A capture that outlived the prune is recorded all the same: the record is an upsert.
    const prunedId = `evt-${RUN}-pruned`;
    const thought = crypto.randomUUID();
    const answered = await viaHook(prunedId, async () => {
      await sql`DELETE FROM plugin_example.deliveries WHERE id = ${prunedId}`;
      return coreOk({ id: thought });
    });
    const recorded = await rowOf(prunedId);
    assert(typeof answered === "object" && answered.status === 202 && recorded?.thought_id === thought, `a capture whose claim was pruned meanwhile is recorded, and answered 202 (${JSON.stringify(answered)}, ${JSON.stringify(recorded)})`);
    // The lease follows the core's deadline (SMD-2768): at OB1_LLM_TIMEOUT=600
    // a claim four minutes old is a capture that may still be running.
    const slowId = `evt-${RUN}-slow`;
    const never = async () => { throw new Error("the capture ran"); };
    await sql`INSERT INTO plugin_example.deliveries (id, claimed_at) VALUES (${slowId}, now() - interval '4 minutes')`;
    const slowHeld = await viaHook(slowId, never, 600);
    assert(typeof slowHeld === "object" && slowHeld.status === 409, `a core whose captures may run 600 s: a claim four minutes old is 409, not taken (${JSON.stringify(slowHeld)})`);
    await sql`UPDATE plugin_example.deliveries SET claimed_at = now() - interval '661 seconds' WHERE id = ${slowId}`;
    const slowTaken = await viaHook(slowId, async () => coreOk({ id: thought }), 600);
    assert(typeof slowTaken === "object" && slowTaken.status === 202 && (await rowOf(slowId))?.thought_id === thought, `past its 660 s lease, taken (${JSON.stringify(slowTaken)})`);
    // A lease longer than the window: the prune keeps an unfinished claim
    // until its lease ends, and still drops a captured id at the window.
    const longId = `evt-${RUN}-long`;
    const doneId = `evt-${RUN}-done`;
    await sql`INSERT INTO plugin_example.deliveries (id, claimed_at) VALUES (${longId}, now() - interval '12 minutes')`;
    await sql`INSERT INTO plugin_example.deliveries (id, thought_id, claimed_at) VALUES (${doneId}, ${thought}, now() - interval '12 minutes')`;
    const longHeld = await viaHook(longId, never, 1200);
    const kept = await rowOf(longId);
    assert(typeof longHeld === "object" && longHeld.status === 409 && kept !== undefined && kept.thought_id === null && (await rowOf(doneId)) === undefined,
      `a core whose captures may run 1200 s: a claim twelve minutes old outlives the eleven-minute window, 409, while a captured id that old is pruned (${JSON.stringify(longHeld)}, ${JSON.stringify(kept)})`);
    // Scopes: two hooks' ids in the one table, each pruned by its own window.
    const { onceById } = await import("./plugin-sdk.ts");
    const handle = { db: { tx: <R>(fn: (q: PluginSql) => Promise<R>): Promise<R> => store.pluginTx("example", fn) }, captureSeconds: 120 };
    const forGood = `rw-${RUN}`;
    const shortLived = `ev-${RUN}`;
    await sql`INSERT INTO plugin_example.deliveries (id, thought_id, claimed_at) VALUES (${`readwise ${forGood}`}, ${thought}, now() - interval '12 minutes'), (${`events ${shortLived}`}, ${thought}, now() - interval '12 minutes')`;
    const once = (scope: string, id: string, keepSeconds: number) => onceById(handle, id, async () => ({ value: "ran", thoughtId: thought }), { keepSeconds, scope });
    const fresh = await once("events", `ev-${RUN}-new`, 660);
    const survivors = (await sql`SELECT id FROM plugin_example.deliveries WHERE id IN (${`readwise ${forGood}`}, ${`events ${shortLived}`})`).map((r: { id: string }) => r.id);
    assert("ran" in fresh && JSON.stringify(survivors) === JSON.stringify([`readwise ${forGood}`]), `a scope's claim prunes its own scope's old ids, not another's (${JSON.stringify(survivors)})`);
    const again = await once("readwise", forGood, Infinity);
    const elsewhere = await once("events", forGood, 660);
    assert("duplicate" in again && again.duplicate === thought && "ran" in elsewhere, `so a hook kept for good still knows its id twelve minutes on, and the same id under another scope is another delivery (${JSON.stringify(again)}, ${JSON.stringify(elsewhere)})`);
    // The index onceById's doc comment gives a plugin keeping one scope for
    // good beside one that prunes: the prune, as onceById sends it, reads it
    // past a kept scope's old rows rather than scanning them.
    const docIndex = /`(CREATE INDEX IF NOT EXISTS deliveries_by_scope ON deliveries [^`]+)`/.exec(readFileSync(new URL("./plugin-sdk.ts", import.meta.url), "utf8"))?.[1] ?? "";
    await sql.unsafe(docIndex.replace(" ON deliveries ", " ON plugin_example.deliveries "));
    await sql`INSERT INTO plugin_example.deliveries (id, thought_id, claimed_at) SELECT 'kept ' || ${RUN} || '-' || n, ${thought}, now() - interval '1 day' FROM generate_series(1, 5000) n`;
    await sql`ANALYZE plugin_example.deliveries`;
    let plan = "";
    const explaining = {
      db: {
        tx: <R>(fn: (q: PluginSql) => Promise<R>): Promise<R> => store.pluginTx("example", (q) => fn(((strings: TemplateStringsArray, ...values: unknown[]) => {
          if (!strings[0].startsWith("DELETE FROM deliveries WHERE claimed_at")) return q(strings, ...values);
          // Frozen, as a template's are: pluginTx takes nothing else.
          const explain = Object.freeze(Object.assign(["EXPLAIN " + strings[0], ...strings.slice(1)], { raw: Object.freeze(["EXPLAIN " + strings.raw[0], ...strings.raw.slice(1)]) }));
          return q(explain as unknown as TemplateStringsArray, ...values).then((rows) => { plan = rows.map((r) => String(Object.values(r)[0])).join("\n"); return []; });
        }) as PluginSql)),
      },
      captureSeconds: 120,
    };
    await onceById(explaining, `ev-${RUN}-plan`, async () => ({ value: 0, thoughtId: thought }), { keepSeconds: 660, scope: "events" });
    assert(/deliveries_by_scope/.test(plan) && /Index Cond: .*CASE/.test(plan), `the doc comment's index is the one the scoped prune reads (${plan.replace(/\s+/g, " ").slice(0, 160)})`);
    await sql`DELETE FROM plugin_example.deliveries WHERE id LIKE ${`kept ${RUN}-%`}`;
    await sql.unsafe("DROP INDEX plugin_example.deliveries_by_scope");
    // A deferred capture (SMD-2767): a hook of the example's plugin that
    // answers once its id is claimed and leaves the capture to ctx.defer, run
    // through runHook over the real table — recorded against its id as an
    // awaited one is, and given back when it throws, with one fault line.
    const tracked: Promise<unknown>[] = [];
    const deferredFaults: string[] = [];
    const laterHook = {
      plugin: "example", name: "later", path: "/hooks/example/later", description: "Answers before its capture.",
      handler: async (ctx: Parameters<typeof hook.handler>[0], req: { text: string }) => {
        const { id } = JSON.parse(req.text) as { id: string };
        const once = await onceById(ctx, id, async () => {
          const captured = await ctx.call("capture_thought", { content: `smd2767: ${id}`, source: "example-hook", trust: "ingested" });
          return { value: captured, thoughtId: captured.ok ? captured.value.id : null };
        }, { keepSeconds: 660, defer: true });
        if ("duplicate" in once) return { status: 200 as const, body: { id: once.duplicate, duplicate: true } };
        if ("inFlight" in once) return { status: 409 as const, body: { code: "IN_FLIGHT", retryable: true } };
        return { status: 202 as const, body: { accepted: true } };
      },
    };
    const deferredVia = (id: string, capture: () => Promise<unknown>) => {
      const scripted = new Proxy({}, { get: (_t, prop) => (prop === "pluginTx" ? store.pluginTx.bind(store) : prop === "captureSeconds" ? () => 120 : capture) }) as never;
      const text = JSON.stringify({ id });
      return runHook(laterHook, { core: scripted, secret: HOOK_SECRET, track: (run) => { const p = run(); tracked.push(p); return p; }, deferredFault: (m) => deferredFaults.push(m) }, { headers: {}, query: {}, body: new TextEncoder().encode(text), text });
    };
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const laterId = `evt-${RUN}-later`;
    // With a deadline: an answer that waited for the capture would wait on `held` for good.
    const first = await Promise.race([
      deferredVia(laterId, async () => { await held; return coreOk({ id: thought }); }),
      Bun.sleep(5000).then(() => { throw new Error("the deferred capture's answer waited for the capture"); }),
    ]);
    const claimRow = await rowOf(laterId);
    const meanwhile = await deferredVia(laterId, async () => coreOk({ id: thought }));
    assert(first.status === 202 && claimRow !== undefined && claimRow.thought_id === null && meanwhile.status === 409,
      `a deferred capture: 202 once its id is claimed, and a resend while it runs is 409 (${first.status}, ${JSON.stringify(claimRow)}, ${meanwhile.status})`);
    release();
    await Promise.all(tracked);
    const afterwards = await deferredVia(laterId, async () => coreOk({ id: thought }));
    assert((await rowOf(laterId))?.thought_id === thought && afterwards.status === 200 && (afterwards.body as { id?: string }).id === thought && deferredFaults.length === 0,
      `once it ends, it is recorded against its id as an awaited capture is, and a resend is that thought's duplicate (${JSON.stringify(afterwards)})`);
    const failingId = `evt-${RUN}-later-fails`;
    const failing = await deferredVia(failingId, async () => { throw new Error("embedder down"); });
    await Promise.all(tracked);
    assert(failing.status === 202 && (await rowOf(failingId)) === undefined && JSON.stringify(deferredFaults) === JSON.stringify([`delivery ${failingId} (its id given back): embedder down`]),
      `a deferred capture that throws: answered 202 all the same, its claim given back, one fault naming the delivery (${failing.status}, ${JSON.stringify(deferredFaults)})`);
    const refusedId = `evt-${RUN}-later-refused`;
    const refused = await deferredVia(refusedId, async () => coreRefuse({ code: "EMBEDDING_NOT_ATTACHED", retryable: true, id: thought, detail: "d" } as never));
    await Promise.all(tracked);
    assert(refused.status === 202 && (await rowOf(refusedId)) === undefined && deferredFaults.at(-1) === `delivery ${refusedId} (its id given back): no thought captured`,
      `a deferred capture the core refuses: its claim given back and a fault naming the delivery, not lost without a word (${JSON.stringify(deferredFaults.at(-1))})`);
    // A handler that fails after claiming with defer: its sender is told 500
    // and retries, so the claim is given back now, not left to the lease.
    const brokenHook = { ...laterHook, name: "broken", path: "/hooks/example/broken",
      handler: async (ctx: Parameters<typeof hook.handler>[0], req: { text: string }) => {
        await laterHook.handler(ctx, req);
        throw new Error("the handler's own fault, after its claim");
      } };
    const brokenId = `evt-${RUN}-later-broken`;
    const brokenText = JSON.stringify({ id: brokenId });
    const scriptedOk = new Proxy({}, { get: (_t, prop) => (prop === "pluginTx" ? store.pluginTx.bind(store) : prop === "captureSeconds" ? () => 120 : async () => coreOk({ id: thought })) }) as never;
    const brokenSaid = await runHook(brokenHook, { core: scriptedOk, secret: HOOK_SECRET, track: (run) => { const p = run(); tracked.push(p); return p; }, deferredFault: (m) => deferredFaults.push(m) },
      { headers: {}, query: {}, body: new TextEncoder().encode(brokenText), text: brokenText }).then(() => "", (e: Error) => e.message);
    // Retried the moment the 500 is in hand, nothing awaited between (review pass 3). That the discard ran before the 500 is the unit suite's to hold, whose discard is slow: here the release reaches the table first either way.
    const retried = await deferredVia(brokenId, async () => coreOk({ id: thought }));
    await Promise.all(tracked);
    assert(brokenSaid === "the handler's own fault, after its claim" && retried.status === 202 && (await rowOf(brokenId))?.thought_id === thought,
      `a handler that fails after a deferred claim gives the id back at once: the sender's retry of its 500 is claimed and captured, not told 409 until the lease (${retried.status})`);
  } finally {
    await store.close();
  }
}

console.log("\n[7] The plugin's handle: its own table, named bare; a core table refused by Postgres");
{
  const { SqlStore } = await import("./store-sql.ts");
  const store = new SqlStore(URL_, { max: 1, pluginPassword: PLUGIN_PW });
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
    said = "";
    try { await store.pluginTx(`unmigrated${RUN}`, async () => 1); } catch (e) { said = (e as Error).message; }
    assert(said.startsWith(`plugin unmigrated${RUN} has no role ob1_plugin_unmigrated${RUN}: ctx.db reaches the tables its migrations make`), `a plugin with no role — no migrations, or none applied — is told so (${said.slice(0, 120)})`);
    // What a plugin's SQL leaves on its session — a temp table, which Postgres
    // searches before any schema, a session search_path — is on the plugin's
    // own connections: the core's queries, on a pool of one connection here,
    // never meet it.
    const before = await store.countThoughts();
    await store.pluginTx("example", (q) => q`CREATE TEMP TABLE thoughts AS SELECT generate_series(1, 50) AS id`);
    await store.pluginTx("example", (q) => q`SELECT set_config('search_path', 'plugin_example', false)`);
    assert((await store.countThoughts()) === before && before >= 1, `a temp table named thoughts and a session path, left by a plugin, do not reach the core's queries (${before} thoughts, as before)`);
    // The handle's own escape: undoing the plugin's role lands on ob1_plugins, never on the server's role.
    said = "";
    try { await store.pluginTx("example", async (q) => { await q`RESET ROLE`; return q`SELECT count(*) FROM thoughts`; }); } catch (e) { said = (e as Error).message; }
    assert(/permission denied/.test(said), `a handler that resets the role still reaches no core table: its pool logs in as ob1_plugins (${said.slice(0, 80)})`);
    const [{ who }] = await store.pluginTx("example", async (q) => { await q`RESET ROLE`; return q<{ who: string }>`SELECT current_user AS who`; });
    assert(who === "ob1_plugins", `and the role it lands on is the login role (${who})`);
    said = "";
    const built = "SELECT 1";
    try { await store.pluginTx("example", (q) => q(Object.assign([built], { raw: [built] }) as unknown as TemplateStringsArray)); } catch (e) { said = (e as Error).message; }
    assert(/is a tagged template/.test(said), "an array built at run time is refused: the handle takes a template's own strings");
  } finally {
    await store.close();
  }
}

console.log("\n[8] Preflight: the enabled plugin's tables in place; a migration the ledger lacks fails the row");
{
  const env = (plugins: string): Record<string, string> => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_PROXY$/i.test(k)) clean[k] = v;
    return { ...clean, OB1_PLUGINS: plugins, OB1_PLUGIN_DB_PASSWORD: PLUGIN_PW, MCP_ACCESS_KEY: "x".repeat(64), MCP_ACCESS_KEYS: "", OB1_LLM_BASE_URL: `http://127.0.0.1:${localStub.port}/v1` };
  };
  const localStub = Bun.serve({ port: 0, fetch: () => Response.json({ object: "list", data: [] }) });
  const row = (out: string) => out.split("\n").find((l) => /^\s*[✓✗!·]\s+plugin tables\s/.test(l)) ?? "";
  let r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✓\s+plugin tables\s+example — each plugin's role, schema and migrations in place/.test(row(r.out)), `in place: ok (${row(r.out) || (r.out).slice(-300)})`);
  await sql`DELETE FROM public.plugin_migrations WHERE plugin = 'example'`;
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+example: 2 migration\(s\) not applied \(001_notes.sql, 002_deliveries.sql\)/.test(row(r.out)), `migrations the ledger lacks: fail, named (${row(r.out)})`);
  await sql`INSERT INTO public.plugin_migrations (plugin, name, sha256) VALUES ('example', '001_notes.sql', ${NOTES_SHA}), ('example', '002_deliveries.sql', ${DELIVERIES_SHA})`;
  // A table owned by another role (a restore with --no-owner, say) is one the plugin's role cannot reach.
  await sql`ALTER TABLE plugin_example.notes OWNER TO postgres`;
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+example: not owned by ob1_plugin_example: plugin_example\.notes \(postgres\) — a migrator run that names the plugin hands them back/.test(row(r.out)), `a table owned by another role: fail, named (${row(r.out)})`);
  await sql`ALTER TABLE plugin_example.notes OWNER TO ob1_plugin_example`;
  await sql`ALTER SCHEMA plugin_example OWNER TO postgres`;
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+example: not owned by ob1_plugin_example: schema plugin_example \(postgres\) — /.test(row(r.out)), `a schema owned by another role: fail, named (${row(r.out)})`);
  await sql`ALTER SCHEMA plugin_example OWNER TO ob1_plugin_example`;
  // The login role a member without the SET option (PG 16): MEMBER would
  // pass it, and every ctx.db call would fail at SET ROLE.
  await sql.unsafe("REVOKE ob1_plugin_example FROM ob1_plugins");
  await sql.unsafe("GRANT ob1_plugin_example TO ob1_plugins WITH SET FALSE, INHERIT FALSE");
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+.*ob1_plugins cannot SET ROLE ob1_plugin_example/.test(row(r.out)), `the login role's membership without SET: fail, named (${row(r.out) || r.out.slice(-400)})`);
  await sql.unsafe("REVOKE ob1_plugin_example FROM ob1_plugins");
  await sql.unsafe("GRANT ob1_plugin_example TO ob1_plugins WITH SET TRUE, INHERIT FALSE");
  // The login role reaching a core table, or inheriting, or a password the server cannot log in with.
  await sql.unsafe("GRANT SELECT ON thoughts TO ob1_plugins");
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+.*ob1_plugins holds privileges on core relations \(thoughts\)/.test(row(r.out)), `a core privilege on the login role: fail, named (${row(r.out)})`);
  await sql.unsafe("REVOKE SELECT ON thoughts FROM ob1_plugins");
  await sql.unsafe("ALTER ROLE ob1_plugins INHERIT");
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+.*ob1_plugins inherits its plugin roles' rights/.test(row(r.out)), `an inheriting login role: fail, named (${row(r.out)})`);
  await sql.unsafe("ALTER ROLE ob1_plugins NOINHERIT");
  // A membership has_table_privilege cannot see: SQL that undoes the plugin's role could SET ROLE to it.
  await sql.unsafe("GRANT pg_read_all_data TO ob1_plugins WITH INHERIT FALSE");
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: env("example"), cwd: HERE });
  assert(/✗\s+plugin tables\s+.*ob1_plugins is a member of pg_read_all_data/.test(row(r.out)), `a membership past the plugin roles: fail, named (${row(r.out)})`);
  await sql.unsafe("REVOKE pg_read_all_data FROM ob1_plugins");
  r = await runScript(["bun", join(HERE, "preflight.ts")], { env: { ...env("example"), OB1_PLUGIN_DB_PASSWORD: "not-the-password" }, cwd: HERE });
  assert(/✗\s+plugin tables\s+.*cannot log in as ob1_plugins with OB1_PLUGIN_DB_PASSWORD/.test(row(r.out)), `a password the role was not made with: fail, named (${row(r.out)})`);
  localStub.stop(true);
}

console.log("\n[9] A migrator that is no superuser, with CREATEROLE: it takes the SET membership PG 16 does not give it, and the plugin's schema is the plugin role's");
{
  const migrator = `smd2310_migrator_${RUN}`;
  const second = `second${RUN}`;
  madeRoles.push(migrator, `ob1_plugin_${second}`);
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
    mkdirSync(join(dir, second, "migrations"), { recursive: true });
    writeFileSync(join(dir, second, "index.ts"), "export default {};\n");
    writeFileSync(join(dir, second, "migrations", "001_items.sql"), "CREATE TABLE IF NOT EXISTS items (id int PRIMARY KEY);\n");
    const out: string[] = [];
    const errs: string[] = [];
    const code = await migrate({ url: asMigrator.toString(), pluginPassword: PLUGIN_PW, plugins: second, pluginsDir: dir, writer: { out: (l: string) => out.push(l), err: (l: string) => errs.push(l) } });
    assert(code === 0 && out.join("\n").includes("  ✓  001_items.sql  applied"), `applied as a CREATEROLE role (${code}: ${errs.join(" | ").slice(0, 300)})`);
    const owner = await one<{ schema_owner: string; table_owner: string }>(sql`
      SELECT (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = ${`plugin_${second}`}) AS schema_owner,
             (SELECT tableowner FROM pg_tables WHERE schemaname = ${`plugin_${second}`} AND tablename = 'items') AS table_owner`);
    assert(owner.schema_owner === `ob1_plugin_${second}` && owner.table_owner === `ob1_plugin_${second}`, `the schema and table are the plugin role's, not the migrator's (${JSON.stringify(owner)})`);
    const again = await migrate({ url: asMigrator.toString(), pluginPassword: PLUGIN_PW, plugins: second, pluginsDir: dir, writer: { out: () => {}, err: () => {} } });
    assert(again === 0, "and a second run as that role is clean");
    // With everything in place and nothing pending, a run asks the migrator no privilege: CREATE on the database taken back, it is still clean.
    const [{ db: dbName }] = (await sql`SELECT current_database() AS db`) as { db: string }[];
    await sql.unsafe(`REVOKE CREATE ON DATABASE "${dbName}" FROM ${migrator}`);
    const idle = await migrate({ url: asMigrator.toString(), pluginPassword: PLUGIN_PW, plugins: second, pluginsDir: dir, writer: { out: () => {}, err: () => {} } });
    assert(idle === 0, "a run with nothing to make or apply needs no CREATE on the database");
    // A plugin whose role another role made (postgres made ob1_plugin_example):
    // with nothing pending, the migrator is asked for no membership it cannot grant itself.
    const other = await migrate({ url: asMigrator.toString(), pluginPassword: PLUGIN_PW, plugins: "example", writer: { out: () => {}, err: (l: string) => errs.push(l) } });
    assert(other === 0, `a run naming a plugin whose role it cannot administer, nothing pending, is clean (${other}: ${errs.join(" | ").slice(-200)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n[10] A brain restored without the plugin's role: a run makes the role and hands it back its schema and all in it, though nothing is pending; one plugin file's temp table never meets the next plugin's");
{
  const dir = mkdtempSync(join(tmpdir(), "smd2310-plugins-"));
  try {
    const [restored, aa, bb] = [`restored${RUN}`, `aa${RUN}`, `bb${RUN}`];
    madeRoles.push(...[restored, aa, bb].map((n) => `ob1_plugin_${n}`));
    for (const [name, body] of [[restored, "CREATE TABLE IF NOT EXISTS kept (id int);\n"], [aa, "CREATE TEMP TABLE shadow_me (x int);\n"], [bb, "CREATE TABLE IF NOT EXISTS shadow_me (x int);\nINSERT INTO shadow_me VALUES (1);\n"]] as const) {
      mkdirSync(join(dir, name, "migrations"), { recursive: true });
      writeFileSync(join(dir, name, "index.ts"), "export default {};\n");
      writeFileSync(join(dir, name, "migrations", "001_x.sql"), body);
    }
    // A dump restored into a cluster that never had the role: the schema, a
    // table with its serial, a view, a function and an enum, all the restoring
    // role's (the dump's ALTER … OWNER failed, or --no-owner skipped it), and
    // the ledger recording the file.
    const [rs, rr] = [`plugin_${restored}`, `ob1_plugin_${restored}`];
    await sql.unsafe(`CREATE SCHEMA ${rs}; CREATE TABLE ${rs}.kept (id serial PRIMARY KEY, mood text); CREATE VIEW ${rs}.kept_ids AS SELECT id FROM ${rs}.kept;
      CREATE FUNCTION ${rs}.kept_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM ${rs}.kept'; CREATE TYPE ${rs}.mood AS ENUM ('calm');
      INSERT INTO ${rs}.kept (mood) VALUES ('calm')`);
    await sql`INSERT INTO public.plugin_migrations (plugin, name, sha256) VALUES (${restored}, '001_x.sql', ${migrationSha("CREATE TABLE IF NOT EXISTS kept (id int);\n")})`;
    const r = await runMigrate({ plugins: `${restored},${aa},${bb}`, pluginsDir: dir });
    assert(r.code === 0, `exit 0 (${r.code}: ${r.err.slice(0, 200)})`);
    const made = await one<{ role: boolean; schema_owner: string }>(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${rr}) AS role, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = ${rs}) AS schema_owner`);
    assert(made.role && made.schema_owner === rr, `the role is made again and owns the restored schema (${JSON.stringify(made)})`);
    const left = await pluginForeignOwned(sql, rs, rr);
    assert(left.length === 0, `the table, its sequence, the view, the function and the type are the role's (${JSON.stringify(left)})`);
    assert(r.out.includes(`  ✓  schema ${rs} and 4 object(s) in it handed back to ${rr}`), `the run says what it handed back (${r.out.split("\n").filter((l) => l.includes(restored)).join(" | ")})`);
    // As the plugin's role, on the restored rows: read, write through the serial, the function.
    const asRole = await one<{ n: number; c: number }>(sql.begin(async (tx: SQL) => {
      await tx.unsafe(`SET LOCAL ROLE ${rr}`);
      await tx.unsafe(`INSERT INTO ${rs}.kept (mood) VALUES ('calm')`);
      return tx.unsafe(`SELECT (SELECT count(*)::int FROM ${rs}.kept_ids) AS n, ${rs}.kept_count()::int AS c`);
    }).catch((e: Error) => [{ n: -1, c: -1, error: e.message }]));
    assert(asRole.n === 2 && asRole.c === 2, `the plugin's role reaches its restored rows (${JSON.stringify(asRole)})`);
    const quiet = await runMigrate({ plugins: restored, pluginsDir: dir });
    assert(quiet.code === 0 && !quiet.out.includes("handed back"), "a second run finds nothing to hand back");
    const landed = await one<{ n: number }>(sql.unsafe(`SELECT count(*)::int AS n FROM "plugin_${bb}".shadow_me`));
    assert(landed.n === 1, `the next plugin's row lands in its own table, not the temp table the one before left (${landed.n})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The roles this run made, with what they own, so a kept cluster is left as this run found it.
for (const role of madeRoles) {
  await sql.unsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$`);
}

mcpServer.stop(true);
apiServer.stop(true);
await asLogin.close();
await sql.close();
report();
