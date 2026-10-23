#!/usr/bin/env bun
/**
 * tier.ts — the promotion engine for SMD-1806's three-brain pipeline.
 *
 * SMD-1806 runs the fork's own code on the fork's own memory as three brains over
 * one corpus, so a migration meets real vectors before an operator's brain does
 * and every PR's "what moved" is measured rather than written by hand:
 *
 *   stable   — the record, the only writer; rebuilt from the sources by
 *              ingest-records.ts (slice 1). This tool never writes to it except on
 *              --promote.
 *   canary   — main's shadow. On every merge: refresh from stable's dump, migrate
 *              forward with the merged tree, then replay stable's query log on
 *              both brains and diff the ids.
 *   working  — a per-worktree disposable copy of stable, migrated by the branch.
 *
 * This is the tooling half (slice 2); ingest-records.ts, OB1_TIER, the
 * query_log.tier column (migration 045) and the `tier` preflight check are slice 1.
 *
 *   # snapshot stable into the canary (or a working copy) and migrate it forward
 *   bun db/tier.ts --refresh --from <stable-url> --to <canary-url> [--tier canary|working]
 *
 *   # replay stable's logged searches on stable and the canary, over HTTP, and report the ranking
 *   bun db/tier.ts --replay --from <stable> --to <canary> [--since <iso-ts>] [--json]
 *
 *   # the same, as a gate: exit 1 if a ranking moved (or a step failed), 3 if nothing was compared
 *   bun db/tier.ts --diff   --from <stable> --to <canary> [--since <iso-ts>] [--json]
 *
 *   # after a soak: stamp the canary's version onto stable
 *   bun db/tier.ts --promote --from <canary-url> --to <stable-url>
 *
 *   # compare two live brains over HTTP — version/migration/freshness/retrieval —
 *   # in one report (SMD-2109, db/brain-compare.ts). No Postgres, no writes.
 *   bun db/tier.ts --compare <a> <b> [--replay [--hybrid]] [--query <q> … | --from-log <brain> [--since <iso>]] [--json]
 *
 * Each of --refresh and --promote runs as two halves, a source and a target,
 * which share a directory (--handoff): deploy/tier.sh runs each half in a
 * container of its own, on its own brain's network with its own password, so
 * no container reaches both brains (SMD-2875). Given --from and --to, both
 * halves run here, the target's guards before anything is dumped.
 *
 * --refresh uses pg_dump | pg_restore for a faithful whole-database snapshot
 * (thoughts, vectors, chunks, query_log, provenance, agents, audit — everything a
 * migration might touch), copies the source's database-level settings the dump
 * leaves out (SMD-2037), then runs migrate.ts against the target. It needs a
 * pg_restore, a pg_dump whose major version is at least both servers' (the
 * source's for the dump, --to's for the probe that reads it), AND Bun: no
 * image the stack runs has all three, so deploy/tier.sh runs this file in one
 * that does (db/tier.Dockerfile, SMD-2036); a host that runs it directly needs
 * postgresql-client >= both servers. It is destructive to --to, so it refuses a
 * --to that is the --from database (sameDatabase, whatever else is true); a
 * --to stamped tier=stable, holding thoughts under no canary/working stamp, or
 * holding some other application's schema, unless an earlier refresh marked it
 * (targetRefusal); and a non-loopback --to unless OB1_ALLOW_REMOTE_DB=1, the
 * same guard test-support's dropSchema uses. No override lifts the refusal of
 * a URL that Bun and libpq read as different targets, or that names no host,
 * no database, or no port while PGPORT is exported, or whose connection
 * reached a database other than the one it names (an exported PGDATABASE
 * beats the URL's in Bun; SMD-2317). pg_dump and pg_restore get a connection
 * built from the URL's parts (connect.ts toolTarget), never the URL, and
 * pg_dump must find a table made through the dropping connection first. The
 * dump runs as pg_read_all_data where the login may take that role, so it
 * reads everything and can write nothing (SMD-2875).
 *
 * --replay and --diff reach the two brains over HTTP, never Postgres (SMD-2875):
 * --from and --to are each brain's MCP URL or Claude Code connector name, with
 * a read key found as --compare finds one (--from-key/--to-key, else the
 * connector's header or the URL's ?key=, else OB1_COMPARE_KEY). Stable's logged searches
 * (list_logged_searches, SMD-2245: the window --since names, else the most
 * recent page), each on the arm that ran it and each (query, arm) once, run
 * on both brains, and the ids the two return now are diffed
 * (db/brain-compare.ts runTierReplay). So a thought stable gained since the
 * refresh can read as a move, and each brain embeds its own query: no model
 * or egress gate is this tool's. A search both brains refuse is skipped; one
 * only one brain fails, the other answering, fails the run (exit 1); a
 * search a brain answers by exact literals alone because its embedding
 * provider did not answer counts as that brain's failure (SMD-2891). Rows
 * logged before migration 045 have no arm, and rows logged as arm literal
 * (106) ran without a vector; both are counted apart, not replayed. The replays are real searches, which a brain running with
 * OB1_QUERY_LOG=on logs. Both verbs print --compare's report, then the window
 * and how many searches were replayed and skipped. A window that replayed none
 * compared nothing, so --diff exits 3 on it rather than passing (SMD-2182).
 * Until SMD-2875 they read both databases from one container on both brains'
 * networks, and diffed the canary against the ids stable had logged.
 * db/test-replay.ts is still the replay gate's offline, model-free half in CI
 * (SMD-1295).
 */

import { SQL } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alignVectorSearchPath, DB_LEVEL_SETTINGS_SQL, parseSetConfig, quoteIdent, searchPathSchemas } from "./config.mjs";
import { stampTier, TIERS, type Tier } from "./ingest-records.ts";
import { runCompare, runTierReplay, type CompareArgs } from "./brain-compare.ts";
import { commandLine, scriptArgv } from "./cli.ts";
import { parseSince } from "../server-portable/core/since.ts";

/** A --since the brain's list_logged_searches reads (parseSince's time arm, SMD-2280 PR 2b): a date, or a time with its zone. */
const sinceReadable = (since: string) => {
  const t = parseSince(since);
  return !("refused" in t) && t.after === null && t.since !== null;
};
const SINCE_REFUSED = "--since must be an ISO-8601 time with its zone (e.g. 2026-09-24T00:00:00Z) or a date (2026-09-24); a clock with no Z or offset is refused, as the brain's query log refuses it.";
import { connectedResetRefusal, identityRefusal, openSql, reachedDatabaseRefusal, resetRefusal, toolTarget, type ToolTarget } from "./connect.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The refresh — a faithful whole-database snapshot, then migrate forward.
// ---------------------------------------------------------------------------

/**
 * Where a URL points, for a message: host:port/database, never its user or
 * password. An `@` after the host means the userinfo was not percent-encoded
 * and the parse split it early: a password holding `/`, `#` or `?` becomes
 * the host, port or path (`postgres:1234/secret@db` — host `postgres`, port
 * 1234), and Bun still tries that host. So no part of such a URL is shown,
 * and the message asks rather than says: an `@` in a query value or a
 * database name trips the same rule.
 */
export function where(url: string): string {
  try {
    const u = new URL(url);
    if (`${u.pathname}${u.search}${u.hash}`.includes("@")) return "a URL with an @ after its host — is its password percent-encoded?";
    // No host is PGHOST's to decide (Bun's client and libpq both read it), not
    // localhost; no port is PGPORT's when it is set, as both clients read it too.
    return `${u.hostname || "$PGHOST"}:${u.port || (process.env.PGPORT ? "$PGPORT" : "5432")}${u.pathname.length > 1 ? u.pathname : ""}`;
  } catch {
    return "a URL that does not parse";
  }
}

/**
 * Reach `sql` once, so a failure names the side and the host. Bun's own error
 * for a host that does not resolve or does not answer is a bare "Failed to
 * connect" (ERR_POSTGRES_CONNECTION_REFUSED, Bun 1.4), which from inside
 * deploy/tier.sh leaves a stale container name to guess (SMD-2182).
 */
async function reach(sql: SQL, url: string, side: string): Promise<void> {
  try {
    await sql`SELECT 1`;
  } catch (e) {
    throw new Error(`could not connect to ${side} at ${where(url)}: ${(e as Error).message}`);
  }
}

/** The server's major version (16 from 160004), so a pg_dump too old to read it is refused before it half-runs. */
async function serverMajor(sql: SQL): Promise<number> {
  const [{ n }] = await sql<{ n: string }[]>`SELECT current_setting('server_version_num') AS n`;
  return Math.floor(Number(n) / 10000);
}

/** The major version of a client tool (`pg_dump (PostgreSQL) 16.4` → 16), or null if the tool is absent. */
async function toolMajor(tool: string): Promise<number | null> {
  try {
    // env passed explicitly: without it Bun resolves the command against the
    // PATH it started with, not the process's current one (measured, Bun 1.4.0),
    // and test-live [20] puts stand-in tools on PATH at runtime. run() likewise.
    const proc = Bun.spawn([tool, "--version"], { stdout: "pipe", stderr: "pipe", env: process.env });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const m = out.match(/(\d+)(?:\.\d+)?\s*$/m) ?? out.match(/\)\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Where a database is, as its server says: the cluster's system_identifier,
 * the instant that cluster's postmaster started, and the database's name. A
 * refresh's or a promote's two halves (deploy/tier.sh runs each in a container
 * of its own, on its own brain's network, SMD-2875) compare them to tell
 * whether --from and --to are one database. No URL, host name or address is
 * compared, so a compose service name and its container name, an alias and an
 * IP, are still one database; a copy that shares the source's
 * system_identifier (a volume copy, a base backup) started at another instant,
 * so it is still another. Until SMD-2875 one process held both connections and
 * looked one's session up in the other's pg_stat_activity, which the halves,
 * one connection each, cannot. A server restarted between the two reads reads
 * as another; the target's own guards (targetRefusal) stand behind this one.
 * pg_control_system() is every role's to call on PostgreSQL 16.
 */
export type DatabaseIdentity = { system: string; started: string; database: string };

async function databaseIdentity(sql: SQL): Promise<DatabaseIdentity> {
  const [row] = await sql<DatabaseIdentity[]>`
    SELECT (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system,
           extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text AS started,
           pg_catalog.current_database() AS database`;
  return row;
}

export const sameDatabase = (a: DatabaseIdentity, b: DatabaseIdentity): boolean =>
  a.system === b.system && a.started === b.started && a.database === b.database;

const isIdentity = (v: unknown): v is DatabaseIdentity => {
  const o = v as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && typeof o.system === "string" && typeof o.started === "string" && typeof o.database === "string";
};

/**
 * The mark a refresh leaves on its target: the tier, as a database-level
 * setting (`ALTER DATABASE … SET ob1.refresh_target`), or null when unmarked.
 * It lives on the database, not in its schema, so the reset does not drop it
 * and pg_restore does not overwrite it — unlike ob1_config.tier, which the
 * restore copies from the SOURCE (stable's `stable`) before the final stamp,
 * so a refresh that failed after its restore would otherwise read as stable.
 * Read from the database's own row in pg_db_role_setting (setrole 0), through
 * config.mjs's DB_LEVEL_SETTINGS_SQL — not current_setting, since a session's
 * value also comes from ALTER ROLE, ALTER SYSTEM or a connection option, any of
 * which would make every database it reaches read as marked, a stable brain
 * included. Only a value a refresh writes (canary, working) is a mark: an
 * operator who sets it to `stable` or `off` to protect a database has not
 * armed its reset. It lasts until `ALTER DATABASE … RESET ob1.refresh_target`.
 */
async function refreshMark(sql: SQL): Promise<string | null> {
  const [row] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
  const mark = parseSetConfig(row?.cfg)["ob1.refresh_target"];
  return mark === "canary" || mark === "working" ? mark : null;
}

/**
 * Settings Postgres stores as a list of quoted names, so that a value is SQL
 * list syntax (`"$user", public`) rather than one literal. pg_dump's
 * variable_is_guc_list_quote names the same six.
 */
const LIST_SETTINGS = new Set(["local_preload_libraries", "search_path", "session_preload_libraries", "shared_preload_libraries", "temp_tablespaces", "unix_socket_directories"]);
/**
 * The two of them whose elements are identifiers, which Postgres reads with
 * SplitIdentifierString: searchPathSchemas, so an unquoted name folds and only
 * Postgres's whitespace separates (SMD-2247). A value stored by `SET … FROM
 * CURRENT` is the text as written — `NoWhere` is the schema nowhere, never
 * `"NoWhere"`. temp_tablespaces keeps an empty entry, the database's default
 * tablespace, which search_path's reading drops.
 */
const IDENTIFIER_LISTS = new Set(["search_path", "temp_tablespaces"]);
const SETTING_NAME = /^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)*$/i;

/**
 * The database's own settings (`ALTER DATABASE … SET`, pg_db_role_setting
 * setrole 0) as name → value, the refresh mark left out. pg_dump without
 * --create carries none of them, so a refresh copies them from --from onto
 * --to itself (SMD-2037): migration 014 seeds the HNSW walk's bounds there
 * once, and a copy without them answers a broad filtered search short. An
 * identifier list comes back re-spelled, each name quoted: read as this
 * server reads it (a vertical tab separates from PostgreSQL 17), so --to
 * keeps --from's meaning whatever its version.
 */
export async function databaseSettings(sql: SQL): Promise<Record<string, string>> {
  const [row] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
  const [{ version }] = await sql<{ version: number }[]>`SELECT current_setting('server_version_num')::int AS version`;
  const { ["ob1.refresh_target"]: _mark, ...settings } = parseSetConfig(row?.cfg);
  for (const [name, value] of Object.entries(settings)) {
    if (!SETTING_NAME.test(name)) throw new Error(`database setting ${JSON.stringify(name)} is not a name this tool can write back`);
    if (IDENTIFIER_LISTS.has(name)) settings[name] = searchPathSchemas(value, version, name === "temp_tablespaces").map(quoteIdent).join(", ");
  }
  return settings;
}

/**
 * A value as an E'' string literal, the same text whatever the session's
 * standard_conforming_strings: a plain '…' literal reads a backslash as an
 * escape with it off, and a refresh's target session may start with it off —
 * a setting of the source's that an earlier refresh copied.
 */
const literal = (v: string) => `E'${v.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/**
 * A list setting's stored value (`"$user", public`) as its elements. An
 * identifier list reaches here as databaseSettings re-spelled it, every name
 * quoted, so the split needs no case or whitespace rules of Postgres's.
 */
function listElements(value: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false, inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      if (ch === '"' && value[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') { inQuotes = true; quoted = true; }
    else if (ch === ",") { out.push(cur); cur = ""; quoted = false; }
    else if (ch !== " ") cur += ch;
  }
  if (cur !== "" || quoted || out.length) out.push(cur);
  return out;
}

/**
 * Make `dst`'s own settings equal `settings` — as databaseSettings returns
 * them — the refresh mark aside: each one `dst` has that `settings` lacks is
 * reset, and each in `settings` is set.
 * pgvector is loaded first, as migration 014's remedy does, so `hnsw.*` are
 * the library's settings, which a database owner may set, rather than
 * placeholders only a superuser may.
 */
export async function applyDatabaseSettings(dst: SQL, settings: Record<string, string>): Promise<void> {
  const current = await databaseSettings(dst);
  // A no-op where `vector` already resolves; else the path gains its schema.
  await alignVectorSearchPath(dst);
  const [{ db, loadable }] = await dst<{ db: string; loadable: boolean }[]>`SELECT pg_catalog.current_database() AS db, to_regtype('vector') IS NOT NULL AS loadable`;
  if (loadable) await dst`SELECT '[1]'::vector`;
  const target = `"${db.replaceAll('"', '""')}"`;
  for (const name of Object.keys(current)) {
    if (!(name in settings)) await dst.unsafe(`ALTER DATABASE ${target} RESET ${name}`);
  }
  for (const [name, value] of Object.entries(settings)) {
    // Each list element a string literal, never a quoted identifier: `""` is
    // no identifier, and temp_tablespaces' empty entry must be written. For
    // these settings Postgres stores a literal element as it would the
    // identifier, quoted where the name needs it — except that a literal is
    // not cut to 63 bytes, where a quoted identifier cut a library path.
    const elements = LIST_SETTINGS.has(name) ? listElements(value) : null;
    const rhs = elements === null ? literal(value) : elements.length === 0 ? "''" : elements.map(literal).join(", ");
    await dst.unsafe(`ALTER DATABASE ${target} SET ${name} = ${rhs}`);
  }
}

/**
 * Why `target` must not be reset by a refresh, or null when it may. A refresh
 * resets only a database that is plainly a tier or plainly empty:
 *   • marked by an earlier refresh (refreshMark) — whatever its ob1_config
 *     says, which is how a refresh that failed after its restore is retried;
 *   • stamped canary or working in ob1_config (a canary refreshed before the
 *     mark existed);
 *   • with nothing in its public schema but what extensions own (a new
 *     `createdb`, whatever its template installed);
 *   • an Open Brain schema — schema_migrations, ob1_config AND thoughts, since
 *     schema_migrations alone is Rails', Ecto's, golang-migrate's and dbmate's
 *     table too — holding no thoughts: a tier stack's database after `up`.
 * Anything else is refused: the record (tier=stable), a brain with thoughts
 * under no tier stamp (an untiered stable), and a schema that is not Open
 * Brain's at all (another application's database, one name away). The
 * refusal names no override: the likeliest cause is --from and --to the wrong
 * way round, and marking the target by hand would disarm this guard for it
 * for good. deploy/README.md says how to mark one deliberately.
 */
export async function targetRefusal(target: SQL): Promise<string | null> {
  if ((await refreshMark(target)) !== null) return null;
  const [{ db, relations, migrations, config, thoughts }] = await target<{ db: string; relations: number; migrations: boolean; config: boolean; thoughts: boolean }[]>`
    SELECT pg_catalog.current_database() AS db,
           (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              -- relations a schema is made of; an index, a composite type or a
              -- TOAST table follows its owner, and an extension's own (a PostGIS
              -- primary key, tablefunc's row types) carry no 'e' dependency
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')) AS relations,
           to_regclass('public.schema_migrations') IS NOT NULL AS migrations,
           to_regclass('public.ob1_config') IS NOT NULL AS config,
           to_regclass('public.thoughts') IS NOT NULL AS thoughts`;
  const tier = await configTier(target);
  if (tier === "canary" || tier === "working" || relations === 0) return null;
  const held = thoughts && (await target<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT 1 FROM thoughts LIMIT 1) t`)[0].n > 0;
  if (migrations && config && thoughts && !held && tier !== "stable") return null;
  const why =
    tier === "stable" ? "--to is stamped tier=stable, the record — are --from and --to the wrong way round?"
    : held ? `--to holds thoughts and ${tier === null ? "no tier stamp" : `tier=${tier}`}, a brain rather than a tier a refresh made — are --from and --to the wrong way round?`
    : "--to has tables in its public schema and is not an Open Brain schema — another database, one name away?";
  return `${why} (database ${db}, no refresh mark)`;
}

/**
 * Whether pg_dump AND pg_restore exist and pg_dump is new enough to read both
 * servers: the source's major `serverMaj` (the dump), and --to's `targetMaj`
 * (the probe asks pg_dump to read --to before it is reset; SMD-2317 review
 * pass 1 — before the probe a newer --to was restored into by an older
 * pg_restore, and now it is refused here, in words).
 */
export async function refreshToolsReady(serverMaj: number, targetMaj: number = serverMaj): Promise<{ ready: boolean; why?: string }> {
  const dump = await toolMajor("pg_dump");
  if (dump === null) return { ready: false, why: "pg_dump is not on PATH" };
  const restore = await toolMajor("pg_restore");
  if (restore === null) return { ready: false, why: "pg_restore is not on PATH" };
  if (dump < serverMaj) return { ready: false, why: `pg_dump is major ${dump} but the source server is major ${serverMaj} (pg_dump cannot read a newer server)` };
  if (dump < targetMaj) return { ready: false, why: `pg_dump is major ${dump} but --to's server is major ${targetMaj} (pg_dump reads --to before the reset, to show it reaches it, and cannot read a newer server)` };
  return { ready: true };
}

async function run(cmd: string[], opts: { stdio?: "inherit" | "pipe"; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: opts.stdio === "inherit" ? "inherit" : "pipe",
    stderr: opts.stdio === "inherit" ? "inherit" : "pipe",
    env: opts.env ?? process.env,
  });
  const out = opts.stdio === "inherit" ? "" : await new Response(proc.stdout).text();
  const err = opts.stdio === "inherit" ? "" : await new Response(proc.stderr).text();
  return { code: await proc.exited, out, err };
}

/**
 * The database and login the server says `sql` is connected as: what a tool's
 * connection names (toolTarget). session_user, not current_user: a role set
 * after login (`ALTER ROLE … SET role`, or `options=-c role=…`) is
 * current_user, and a tool logging in as it was refused, or with a matching
 * PGPASSFILE line got in as someone the URL does not name (review pass 1,
 * run). The URL's options still set that role inside the tool's session.
 */
async function reachedAs(sql: SQL): Promise<{ database: string; user: string }> {
  const [row] = await sql<{ db: string; u: string }[]>`SELECT pg_catalog.current_database() AS db, session_user AS u`;
  return { database: row.db, user: row.u };
}

/**
 * Why pg_dump, handed `tool`, does not reach the database `dst` is connected
 * to, or null when it does. The server cannot say where a client dialled from
 * (behind a published port its address is the container's), so the tool is
 * asked directly: a table only this run knows is created through `dst`, and
 * pg_dump's schema of that one table must name it. A tool that went anywhere
 * else finds nothing (SMD-2317). The table sits in a schema of its own, not
 * public: a refresh killed between its DROP SCHEMA public and CREATE SCHEMA
 * leaves a marked target with no public, which the next run must still reset
 * (review pass 1, run). The schema is dropped either way.
 */
export async function toolReachRefusal(dst: SQL, tool: ToolTarget): Promise<string | null> {
  const probe = `ob1_refresh_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await dst.unsafe(`CREATE SCHEMA ${probe}; CREATE TABLE ${probe}.${probe} ()`);
  } catch (e) {
    // One implicit transaction: a refused CREATE TABLE leaves no schema.
    return `the probe could not create a schema through the connection that drops (${(e as Error).message}), and the reset would need to create one`;
  }
  let refusal: string | null;
  try {
    const r = await run(["pg_dump", "--schema-only", "--no-owner", "--no-privileges", "--no-password", "-t", `${probe}.${probe}`, "-d", tool.conninfo], { env: tool.env });
    const why = r.err.trim() ? `: ${r.err.trim().split("\n")[0]}` : "";
    // A pg_dump that reached a database without the table says so and exits 1
    // (measured, pg_dump 16: "no matching tables were found").
    if (r.code === 0 && r.out.includes(probe)) refusal = null;
    else if (r.code === 0 || /no matching tables were found/.test(r.err)) refusal = "pg_dump, given the connection the guards judged, did not find a table just created there: it reaches another database or server, where pg_restore would write";
    else refusal = `pg_dump, given the connection the guards judged, failed (exit ${r.code}${why}), so it cannot be shown to reach --to`;
  } finally {
    // A failed drop must not replace the answer; the sweep after the mark
    // takes a probe schema this run (or a killed one) left behind.
    try {
      await dst.unsafe(`DROP SCHEMA IF EXISTS ${probe} CASCADE`);
    } catch {
      /* swept after the mark */
    }
  }
  return refusal;
}

/** A refresh's or a promote's hand-off between its halves: these files, in one directory. */
const HANDOFF = { source: "source.json", dump: "stable.dump", promote: "promote.json" } as const;

/** What a refresh's source half hands its target half, beside the dump. */
export type RefreshSource = { identity: DatabaseIdentity; major: number; settings: Record<string, string> };

/**
 * Make a hand-off directory, mode 700, refusing one that exists: an existing
 * directory keeps its own mode (/tmp's is world-readable), and the dump of the
 * whole source is about to go in it (review pass 1).
 */
async function makeHandoff(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "EEXIST"
      ? `--handoff: ${dir} already exists; name a directory this run can make, mode 700 (the source's dump goes in it).`
      : `--handoff: could not make ${dir} (${code ?? (e as Error).message}).`);
  }
}

/** The URL rules a refresh asks of a side before it opens either (connect.ts). */
function refuseRefreshUrl(side: "--from" | "--to", url: string): void {
  // connect.ts's one rule, the test scaffolding's too. Each URL must be one
  // Bun (the guards, the drop) and libpq (pg_dump, pg_restore) take to the
  // same place, naming its database: no override lifts that (SMD-2317). Then
  // --to's host must be loopback by name, not an empty host (it resolves
  // through PGHOST), or the override set.
  const fixed = identityRefusal(url);
  if (fixed !== null) throw new Error(`${side}: ${fixed}. Refusing: --refresh dumps --from and drops --to's schema, so each must name one database every client reaches.`);
  if (side === "--to") {
    const refusal = resetRefusal(url);
    if (refusal !== null) throw new Error(`--to is not plainly this machine — ${refusal} — and OB1_ALLOW_REMOTE_DB is not 1. Refusing to reset it. (--refresh drops the target's schema.)`);
  }
}

/**
 * The source's facts, read before anything is dumped: where it is, its major,
 * its database-level settings, and who the server says the connection is (the
 * login pg_dump is handed). Bun lets an exported PGDATABASE beat the URL's
 * database, so the server is asked which one it reached: pg_dump keeps the URL's.
 */
async function readRefreshSource(fromUrl: string): Promise<{ source: RefreshSource; fromAs: { database: string; user: string }; readOnly: boolean }> {
  const src = openSql(fromUrl);
  try {
    await reach(src, fromUrl, "--from");
    const fromReached = await reachedDatabaseRefusal(src, fromUrl);
    if (fromReached !== null) throw new Error(`--from: ${fromReached}. Refusing: pg_dump would read the URL's database, not the one checked.`);
    // A CASE, since AND need not stop before pg_has_role, which errors on a
    // role that does not exist (before PostgreSQL 14); taking a role by SET
    // ROLE is the 'SET' privilege from 16, membership before it. And not where
    // the role reads less than the login: pg_read_all_data does not bypass
    // row-level security, which pg_dump refuses to dump under, nor read large
    // objects (review pass 4: either refused the whole refresh, which ran
    // before as the login).
    const [{ readOnly }] = await src<{ readOnly: boolean }[]>`
      SELECT CASE WHEN pg_catalog.to_regrole('pg_read_all_data') IS NULL THEN false
                  WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relrowsecurity AND relkind IN ('r', 'p')) THEN false
                  WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata) THEN false
                  WHEN current_setting('server_version_num')::int >= 160000 THEN pg_catalog.pg_has_role(session_user, 'pg_read_all_data', 'SET')
                  ELSE pg_catalog.pg_has_role(session_user, 'pg_read_all_data', 'MEMBER') END AS "readOnly"`;
    return {
      source: { identity: await databaseIdentity(src), major: await serverMajor(src), settings: await databaseSettings(src) },
      fromAs: await reachedAs(src),
      readOnly,
    };
  } finally {
    await src.close();
  }
}

/**
 * The target's guards, before anything is written to it, and its major. The
 * reset below drops --to's schema, so --to must be neither the source nor the
 * record. The loopback guard covers neither — deploy/tier.sh sets
 * OB1_ALLOW_REMOTE_DB, since from its container every database is remote — and
 * the likeliest slips are both: stable under the other name it answers to on
 * the network, and --from and --to the wrong way round.
 */
async function checkRefreshTarget(toUrl: string, source: RefreshSource): Promise<number> {
  const target = openSql(toUrl);
  try {
    await reach(target, toUrl, "--to");
    const toReached = await connectedResetRefusal(target, toUrl);
    if (toReached !== null) throw new Error(`--to: ${toReached}. Refusing: --refresh drops the target's schema.`);
    if (sameDatabase(source.identity, await databaseIdentity(target))) throw new Error(`--from and --to name the same database. Refusing: --refresh drops the target's schema.`);
    const refusal = await targetRefusal(target);
    if (refusal) throw new Error(`${refusal}. Refusing: --refresh drops the target's schema.`);
    return await serverMajor(target);
  } finally {
    await target.close();
  }
}

async function requireRefreshTools(sourceMaj: number, targetMaj: number = sourceMaj): Promise<void> {
  const ready = await refreshToolsReady(sourceMaj, targetMaj);
  if (!ready.ready) throw new Error(`--refresh needs pg_dump / pg_restore: ${ready.why}. deploy/tier.sh runs this in an image with both (db/tier.Dockerfile, postgresql16-client); on a host install postgresql-client >= ${Math.max(sourceMaj, targetMaj)}.`);
}

/**
 * pg_dump the source to `file`: custom format, no owner or privileges (the
 * target's role may differ; ROLE_GRANTS are re-issued by migrate --grant, not
 * carried). The tool gets a connection built from the URL's parts and the
 * server's answer, never the URL: libpq read URLs by rules of its own and
 * followed PGHOSTADDR/PGSERVICE past the guards (connect.ts toolTarget,
 * SMD-2317). --no-password: a missing password fails rather than waits on a
 * prompt. As pg_read_all_data when the login may take it (a superuser, or a
 * member; PostgreSQL 14+) and that role reads all the login would: the dump
 * reads every table and sequence and can write nothing (SMD-2875; measured on
 * a migrated brain, the same contents as the superuser's dump). Where a table
 * has row-level security or a large object exists, which the role cannot
 * dump, it runs as the login, as before.
 */
async function dumpSource(fromUrl: string, fromAs: { database: string; user: string }, readOnly: boolean, file: string): Promise<void> {
  const fromTool = toolTarget(fromUrl, fromAs);
  const dumped = await run(["pg_dump", "-Fc", "--no-owner", "--no-privileges", "--no-password", ...(readOnly ? ["--role=pg_read_all_data"] : []), "-f", file, "-d", fromTool.conninfo], { env: fromTool.env });
  if (dumped.code !== 0) throw new Error(`pg_dump failed (exit ${dumped.code}): ${dumped.err.trim()}`);
}

/**
 * Restore `dumpFile` into `toUrl` and migrate it forward with this tree:
 *   1. mark the target as a refresh target (refreshMark), then reset its public
 *      schema (the destructive step, guarded by checkRefreshTarget, the
 *      loopback check, the connected check asked on the connection that drops,
 *      and a probe showing pg_dump reaches that same database, toolReachRefusal).
 *      pg_restore gets toolTarget's connection, never the URL.
 *   2. pg_restore the dump.
 *   3. copy the source's database-level settings (databaseSettings), which the
 *      dump does not carry — 014's HNSW bounds among them (SMD-2037).
 *   4. migrate.ts forward — the point of the canary: a migration meets real data.
 *   5. stamp the tier and this refresh's time in ob1_config.
 */
async function restoreTarget(dumpFile: string, toUrl: string, tier: Tier, settings: Record<string, string>): Promise<void> {
  // Reset the target so the restore lands on a clean schema. DROP … CASCADE is
  // the destructive act --refresh exists to perform; it is guarded above. The
  // mark goes first, so a refresh that dies from here on — a migration that
  // fails on the copy, a Ctrl-C mid-restore — leaves a target the next one
  // recognises as its own (refreshMark). `tier` is one of TIERS, checked by
  // the caller; ALTER DATABASE takes no bind parameters.
  const dst = openSql(toUrl);
  let toTool: ToolTarget;
  try {
    if (!TIERS.includes(tier)) throw new Error(`not a tier: ${tier}`);
    // Asked again on this connection, the one that marks and drops: the
    // guard's own connection is closed, and this one is a new resolution.
    const again = await connectedResetRefusal(dst, toUrl);
    if (again !== null) throw new Error(`--to: ${again}. Refusing: --refresh drops the target's schema. --to is untouched.`);
    // pg_restore will write where its connection goes, so pg_dump is asked,
    // on that same connection string, to find a table made on this one.
    toTool = toolTarget(toUrl, await reachedAs(dst));
    const unreached = await toolReachRefusal(dst, toTool);
    if (unreached !== null) throw new Error(`--to: ${unreached}. Refusing before the reset: --to is untouched.`);
    try {
      // pg_catalog's, not the path's: a URL's options= may set search_path,
      // and a planted current_database() would put the mark on another
      // database, where it disarms targetRefusal (review pass 2).
      await dst.unsafe(`DO $mark$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I SET ob1.refresh_target = %L', pg_catalog.current_database(), '${tier}'); END $mark$`);
    } catch (e) {
      // Nothing is reset yet. A database-level setting of a custom name needs a
      // superuser, or on PG15+ a role granted SET on the parameter; restoring
      // pgvector into a public schema the reset emptied needs a superuser in
      // the default install too, so a role that cannot mark could rarely finish.
      throw new Error(`--refresh marks --to before resetting it (ALTER DATABASE … SET ob1.refresh_target) and could not: ${(e as Error).message}. That needs a superuser on --to, or GRANT SET ON PARAMETER ob1.refresh_target (PG15+); restoring pgvector needs a superuser in the default install anyway. --to is untouched.`);
    }
    // A probe schema a killed run left (Ctrl-C during the probe's pg_dump, or
    // a drop that failed) sits outside public, so the reset below would
    // never take it: sweep them here, on the target that is being reset.
    const leftovers = await dst<{ n: string }[]>`SELECT nspname AS n FROM pg_catalog.pg_namespace WHERE pg_catalog.starts_with(nspname, 'ob1_refresh_probe_')`;
    for (const { n } of leftovers) await dst.unsafe(`DROP SCHEMA IF EXISTS "${n.replaceAll('"', '""')}" CASCADE`);
    await dst`DROP SCHEMA IF EXISTS public CASCADE`;
    await dst`CREATE SCHEMA public`;
  } finally {
    await dst.close();
  }

  const restored = await run(["pg_restore", "--no-owner", "--no-privileges", "--no-password", "-d", toTool.conninfo, dumpFile], { env: toTool.env });
  // pg_restore exits non-zero on benign warnings (e.g. a comment on an extension
  // it did not create); treat a restore that produced the core table as success,
  // otherwise surface it.
  const check = openSql(toUrl);
  let hasThoughts = false;
  try {
    const [{ present }] = await check<{ present: boolean }[]>`SELECT to_regclass('public.thoughts') IS NOT NULL AS present`;
    hasThoughts = present;
  } finally {
    await check.close();
  }
  if (!hasThoughts) throw new Error(`pg_restore did not produce the thoughts table (exit ${restored.code}): ${restored.err.trim()}`);
  // pg_restore commonly exits non-zero on benign warnings (a comment on an
  // extension it did not create, an already-present object). The core table is
  // present, so proceed — but show the warnings rather than swallow them, so a
  // partial restore is not silent.
  if (restored.code !== 0 && restored.err.trim()) console.error(`pg_restore warnings (exit ${restored.code}):\n${restored.err.trim()}`);

  // Before the migration, so a migration that reads a setting sees the
  // source's; each later session on --to — migrate.ts's, the server's — does.
  const settle = openSql(toUrl);
  try {
    await applyDatabaseSettings(settle, settings);
  } catch (e) {
    throw new Error(`copying --from's database settings onto --to failed: ${(e as Error).message}. --to is restored and still marked, so re-run the refresh once that is fixed.`);
  } finally {
    await settle.close();
  }

  const migrated = await run(["bun", join(HERE, "migrate.ts"), "--url", toUrl], { stdio: "inherit" });
  if (migrated.code !== 0) throw new Error(`migrate.ts failed on the refreshed target (exit ${migrated.code})`);

  const stamp = openSql(toUrl);
  try {
    await settleRefreshed(stamp, tier);
  } finally {
    await stamp.close();
  }
}

/**
 * Snapshot `fromUrl` into `toUrl` and migrate it forward with this tree: both
 * halves in one process, the target's guards before anything is dumped.
 * Throws with a plain message on any failed step.
 */
export async function refresh(fromUrl: string, toUrl: string, tier: Tier): Promise<void> {
  refuseRefreshUrl("--from", fromUrl);
  refuseRefreshUrl("--to", toUrl);
  const { source, fromAs, readOnly } = await readRefreshSource(fromUrl);
  const targetMaj = await checkRefreshTarget(toUrl, source);
  await requireRefreshTools(source.major, targetMaj);
  const dir = await mkdtemp(join(tmpdir(), "ob1-tier-"));
  try {
    const dumpFile = join(dir, HANDOFF.dump);
    await dumpSource(fromUrl, fromAs, readOnly, dumpFile);
    await restoreTarget(dumpFile, toUrl, tier, source.settings);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A refresh's source half (deploy/tier.sh's container on the source's network
 * alone, SMD-2875): the source's facts and its dump, written into `dir` for
 * the target half. Nothing is written to the source.
 */
export async function refreshSource(fromUrl: string, dir: string): Promise<void> {
  refuseRefreshUrl("--from", fromUrl);
  const { source, fromAs, readOnly } = await readRefreshSource(fromUrl);
  await requireRefreshTools(source.major);
  await makeHandoff(dir);
  await dumpSource(fromUrl, fromAs, readOnly, join(dir, HANDOFF.dump));
  await writeFile(join(dir, HANDOFF.source), JSON.stringify(source), { mode: 0o600 });
}

/** A refresh source as the target half reads it from the hand-off, or null when it is not one. */
export function parseRefreshSource(v: unknown): RefreshSource | null {
  const o = v as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || !isIdentity(o.identity) || !Number.isInteger(o.major)) return null;
  const settings = o.settings as Record<string, unknown> | null;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  // The names are written into ALTER DATABASE … SET, so each must be one
  // databaseSettings would have read; never the refresh mark, the target's own.
  for (const [name, value] of Object.entries(settings)) {
    // Postgres folds a setting's name to lower case, so the mark in any case is the mark.
    if (!SETTING_NAME.test(name) || name.toLowerCase() === "ob1.refresh_target" || typeof value !== "string") return null;
  }
  return { identity: o.identity, major: o.major as number, settings: settings as Record<string, string> };
}

/** Read one file of a hand-off, as `parse` reads it. */
function readHandoff<T>(dir: string, file: string, verb: string, parse: (v: unknown) => T | null): T {
  let text: string;
  try {
    text = readFileSync(join(dir, file), "utf8");
  } catch (e) {
    throw new Error(`--handoff: ${join(dir, file)} could not be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); a --${verb} source half writes it.`);
  }
  let value: unknown = null;
  try { value = JSON.parse(text); } catch { /* refused below */ }
  const parsed = parse(value);
  if (parsed === null) throw new Error(`--handoff: ${join(dir, file)} is not what a --${verb} source half writes.`);
  return parsed;
}

/**
 * A refresh's target half (deploy/tier.sh's container on the target's network
 * alone, SMD-2875): the source half's facts and dump from `dir`, the target's
 * guards, then the restore, the settings, the migration and the stamp.
 */
export async function refreshTarget(dir: string, toUrl: string, tier: Tier): Promise<void> {
  refuseRefreshUrl("--to", toUrl);
  const source = readHandoff(dir, HANDOFF.source, "refresh", parseRefreshSource);
  const dumpFile = join(dir, HANDOFF.dump);
  if (!existsSync(dumpFile)) throw new Error(`--handoff: ${dumpFile} is missing; the --refresh source half writes it beside ${HANDOFF.source}.`);
  const targetMaj = await checkRefreshTarget(toUrl, source);
  await requireRefreshTools(source.major, targetMaj);
  await restoreTarget(dumpFile, toUrl, tier, source.settings);
}

// ---------------------------------------------------------------------------
// Promote — stamp the soaked canary's version onto stable.
// ---------------------------------------------------------------------------

/** Read an ob1_config value, or null when the key is absent. */
async function readConfig(sql: SQL, key: string): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`SELECT value FROM ob1_config WHERE key = ${key}`;
  return rows.length ? rows[0].value : null;
}

/** The tier ob1_config is stamped with, or null when unstamped or there is no ob1_config (a new database). */
async function configTier(sql: SQL): Promise<string | null> {
  const [{ present }] = await sql<{ present: boolean }[]>`SELECT to_regclass('public.ob1_config') IS NOT NULL AS present`;
  return present ? readConfig(sql, "tier") : null;
}

/**
 * A refreshed target's own stamps, once its restore and migrations are done:
 * its tier and the refresh's time, and none of --from's heartbeats (SMD-2261).
 * The dump copies ob1_config whole, so the source's `heartbeat:` rows would
 * report its workers as this brain's — alive for three intervals, stale for
 * ever after — and preflight would name a restart for a worker that is not
 * this brain's (review pass 1). A worker of this tier stamps its own.
 */
export async function settleRefreshed(sql: SQL, tier: Tier): Promise<void> {
  await stampTier(sql, tier);
  await setConfig(sql, "last_refresh", new Date().toISOString());
  await sql`DELETE FROM ob1_config WHERE key LIKE 'heartbeat:%'`;
}

/** Upsert an ob1_config KV row — the write half beside readConfig. */
async function setConfig(sql: SQL, key: string, value: string): Promise<void> {
  await sql`INSERT INTO ob1_config (key, value) VALUES (${key}, ${value})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** What a promote's source half (the canary's side) hands its target half. */
export type PromoteSource = { identity: DatabaseIdentity; version: string | null };

/** The canary's side of a promote: where it is, and the schema version it carries. Nothing is written. */
async function readPromoteSource(canaryUrl: string): Promise<PromoteSource> {
  const canary = openSql(canaryUrl);
  try {
    await reach(canary, canaryUrl, "--from (canary)");
    return { identity: await databaseIdentity(canary), version: await readConfig(canary, "schema_version") };
  } finally {
    await canary.close();
  }
}

/**
 * Promotion, the data half: record that stable was promoted to the soaked
 * canary's schema version (migration 044's `ob1_config.schema_version`, SMD-1804),
 * and the time. It records under `promoted_schema_version`, NOT `schema_version`
 * — that key is the version the schema was migrated UNDER, which preflight reads,
 * and stable is not migrated here; the actual retag (pointing the stable stack at
 * the published image and migrating it) is SMD-1860's step, named rather than
 * performed because no image is published yet.
 */
async function applyPromote(stableUrl: string, source: PromoteSource): Promise<{ version: string | null }> {
  const stable = openSql(stableUrl);
  try {
    await reach(stable, stableUrl, "--to (stable)");
    // The mirror of refresh's guard: promote stamps --to as stable, so --to must
    // not be the canary itself, nor a tier — the shape of --from and --to the
    // wrong way round, which would make the canary read as the record.
    if (sameDatabase(source.identity, await databaseIdentity(stable))) throw new Error(`--from and --to name the same database. Refusing: --promote stamps --to as stable.`);
    const mark = await refreshMark(stable);
    const tier = await configTier(stable);
    if (mark !== null || tier === "canary" || tier === "working") {
      const [{ db }] = await stable<{ db: string }[]>`SELECT pg_catalog.quote_ident(pg_catalog.current_database()) AS db`;
      throw new Error(`--to is a tier (${mark !== null ? `refresh mark ${mark}` : `tier=${tier}`}), not the record — are --from and --to the wrong way round? Refusing: --promote stamps --to as stable.${mark !== null ? ` If --to really is to be the record now, clear the mark first: ALTER DATABASE ${db} RESET ob1.refresh_target` : ""}`);
    }
    // Assert the target is stable — but only the tier key, not stampTier's
    // last_ingest: a promotion is not an ingest, and stable's last_ingest must
    // keep naming the real rebuild time (preflight's `tier` check reads it).
    await setConfig(stable, "tier", "stable");
    if (source.version !== null) await setConfig(stable, "promoted_schema_version", source.version);
    await setConfig(stable, "promoted_at", new Date().toISOString());
    return { version: source.version };
  } finally {
    await stable.close();
  }
}

/** Promote in one process: the canary read, then stable stamped. */
export async function promote(canaryUrl: string, stableUrl: string): Promise<{ version: string | null }> {
  return applyPromote(stableUrl, await readPromoteSource(canaryUrl));
}

/** A promote's source half (deploy/tier.sh's container on the canary's network alone, SMD-2875). */
export async function promoteSource(canaryUrl: string, dir: string): Promise<void> {
  const source = await readPromoteSource(canaryUrl);
  await makeHandoff(dir);
  await writeFile(join(dir, HANDOFF.promote), JSON.stringify(source), { mode: 0o600 });
}

export function parsePromoteSource(v: unknown): PromoteSource | null {
  const o = v as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || !isIdentity(o.identity) || !(o.version === null || typeof o.version === "string")) return null;
  return { identity: o.identity, version: o.version as string | null };
}

/** A promote's target half (deploy/tier.sh's container on stable's network alone, SMD-2875). */
export async function promoteTarget(dir: string, stableUrl: string): Promise<{ version: string | null }> {
  return applyPromote(stableUrl, readHandoff(dir, HANDOFF.promote, "promote", parsePromoteSource));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const COMPARE_USAGE =
  "  db/tier.ts --compare <a> <b> [--replay [--hybrid]] [--query <q> ...] [--queries-file <path>] [--from-log <brain> [--since <iso>]] [--json]\n" +
  "  <a>/<b>: an http(s):// URL (key from --a-key/--b-key, else ?key=, else OB1_COMPARE_KEY) or a connector name (open-brain, open-brain-canary; its own key)";
const VERB_USAGE =
  "  db/tier.ts --refresh | --promote (one verb) --from <postgres://…> --to <postgres://…> [--tier <canary|working>]\n" +
  "    or one half: --from <postgres://…> --handoff <dir>, then --handoff <dir> --to <postgres://…> (deploy/tier.sh's two containers)\n" +
  "  db/tier.ts --replay | --diff (one verb) --from <stable> --to <canary> [--from-key <key>] [--to-key <key>] [--since <iso-ts>] [--json]\n" +
  "  <stable>/<canary>: an http(s):// MCP URL (key from --from-key/--to-key, else ?key=, else OB1_COMPARE_KEY) or a connector name (its own key)";

/**
 * Parse the --compare arguments: `--compare <a> <b>` names the two brains (a URL
 * or a connector name each), then --a-key/--b-key, a repeatable --query and a
 * --queries-file (a file of one query per line, blanks and #-comments skipped),
 * and the bare --replay, --hybrid and --json. A read key never rides argv here by
 * default — it comes from OB1_COMPARE_KEY, the connector, or the URL's ?key= —
 * but --a-key/--b-key are accepted for a URL that has none.
 */
export function parseCompareArgs(args: string[]): CompareArgs {
  // Every argument accounted for (db/cli.ts); the two values after --compare are the brain references.
  const cli = commandLine("tier.ts", {
    compare: "two", "a-key": "one", "b-key": "one", "queries-file": "one", "from-log": "one", since: "one", query: "repeated",
    replay: "none", hybrid: "none", json: "none",
  }, { hints: { compare: "<a> <b>", "a-key": "<key>", "b-key": "<key>", "queries-file": "<path>", "from-log": "<brain>", since: "<iso>", query: "<q>" }, note: COMPARE_USAGE.trimStart() }, args);
  const refuse = (why: string): never => { console.error(`${why}\n${COMPARE_USAGE}`); process.exit(2); };
  if (!cli.has("compare")) refuse("--compare needs two brains.");
  const [a, b] = cli.values("compare");
  const out: CompareArgs = { a, b, replay: cli.has("replay"), hybrid: cli.has("hybrid"), queries: [], json: cli.has("json") };
  if (cli.has("a-key")) out.aKey = cli.value("a-key");
  if (cli.has("b-key")) out.bKey = cli.value("b-key");
  // A blank --query or --from-log is refused by the scanner, as every flag's blank value is.
  out.queries.push(...cli.values("query"));
  const file = cli.value("queries-file");
  if (file !== undefined) out.queries.push(...readQueriesFile(file));
  out.fromLog = cli.value("from-log");
  const since = cli.value("since");
  if (since !== undefined) {
    if (!sinceReadable(since)) refuse(SINCE_REFUSED);
    out.since = since;
  }
  if (out.hybrid && !out.replay) refuse("--hybrid only applies with --replay.");
  if (out.fromLog && out.queries.length > 0) refuse("--from-log and --query/--queries-file are two query sources; pass one.");
  if (out.fromLog && out.hybrid) refuse("--hybrid does not apply to --from-log: each logged search replays on the arm that ran it.");
  if (out.fromLog && !out.replay) refuse("--from-log only applies with --replay.");
  if (out.since && !out.fromLog) refuse("--since only applies with --from-log (it windows the logged searches).");
  if (out.queries.length > 0 && !out.replay) refuse("--query/--queries-file only apply with --replay (without it, no retrieval runs).");
  if (out.replay && out.queries.length === 0 && !out.fromLog) refuse("--replay needs a query source: --query <q> (repeatable), --queries-file <path>, or --from-log <brain>.");
  return out;
}

/** A query file: one query per line, blank lines and #-comment lines skipped. */
function readQueriesFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`--queries-file: cannot read ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}

async function main(): Promise<void> {
  const args = scriptArgv(`usage:\n${VERB_USAGE}\n${COMPARE_USAGE}\n  The header of db/tier.ts says what each does.`);

  // --compare is a different animal from the SQL verbs: it reaches two brains over
  // HTTP as a read client (brain_info + the read tools), never Postgres, so it
  // takes brain references and its own flags rather than --from/--to. Handled and
  // returned before the SQL-verb parser ever sees these arguments (SMD-2109).
  if (args.includes("--compare")) {
    for (const v of ["refresh", "diff", "promote"]) {
      if (args.includes(`--${v}`)) { console.error(`--compare does not combine with --${v}.`); process.exit(2); }
    }
    process.exit(await runCompare(parseCompareArgs(args)));
  }

  const oneVerb = (n: number): void => {
    if (n !== 1) {
      console.error(`Give exactly one verb (--refresh, --replay, --diff, --promote), not ${n}.\n${VERB_USAGE}`);
      process.exit(2);
    }
  };

  // --replay and --diff reach the two brains over HTTP (SMD-2875), so they take
  // brain references, as --compare does, and flags of their own.
  if (args.includes("--replay") || args.includes("--diff")) {
    const cli = commandLine("tier.ts", {
      from: "one", to: "one", "from-key": "one", "to-key": "one", since: "one", json: "none", replay: "none", diff: "none", refresh: "none", promote: "none",
    }, { hints: { from: "<stable>", to: "<canary>", "from-key": "<key>", "to-key": "<key>", since: "<iso-ts>" } }, args);
    const verbs = (["refresh", "replay", "diff", "promote"] as const).filter((v) => cli.has(v));
    oneVerb(verbs.length);
    const verb = verbs[0];
    const from = cli.value("from");
    const to = cli.value("to");
    if (!from || !to) {
      console.error(`--${verb} needs --from and --to.`);
      process.exit(2);
    }
    for (const [flag, ref] of [["--from", from], ["--to", to]] as const) {
      if (/^postgres(ql)?:\/\//i.test(ref)) {
        console.error(`--${verb} runs over HTTP now (SMD-2875): ${flag} is a brain's MCP URL or connector name, not a database.\n${VERB_USAGE}`);
        process.exit(2);
      }
    }
    const since = cli.value("since");
    if (since !== undefined && !sinceReadable(since)) {
      console.error(SINCE_REFUSED);
      process.exit(2);
    }
    process.exit(await runTierReplay({ from, to, fromKey: cli.value("from-key"), toKey: cli.value("to-key"), since, gate: verb === "diff", json: cli.has("json") }));
  }

  // Every argument accounted for (db/cli.ts), as the other db/ scripts do it.
  const cli = commandLine("tier.ts", {
    from: "one", to: "one", handoff: "one", tier: "one", refresh: "none", promote: "none",
  }, { hints: { from: "<postgres://…>", to: "<postgres://…>", handoff: "<dir>", tier: "<canary|working>" } }, args);

  const verbs = (["refresh", "promote"] as const).filter((v) => cli.has(v));
  oneVerb(verbs.length);
  const verb = verbs[0];
  const from = cli.value("from");
  const to = cli.value("to");
  // Both sides in one process, or one half with the directory the halves
  // share: deploy/tier.sh runs each half in a container of its own, on its
  // own brain's network alone (SMD-2875).
  const handoff = cli.value("handoff");
  if (handoff === undefined ? !from || !to : !from === !to) {
    console.error(`--${verb} needs --from and --to, or one of them with --handoff <dir>.\n${VERB_USAGE}`);
    process.exit(2);
  }

  if (verb === "refresh") {
    const tier = (cli.value("tier") ?? "canary") as Tier;
    if (!TIERS.includes(tier) || tier === "stable") {
      console.error(`--tier must be canary or working (stable is the source, ingest-records.ts writes it).`);
      process.exit(2);
    }
    if (handoff !== undefined && from) {
      await refreshSource(from, handoff);
      console.log(`dumped --from into ${handoff} for the refresh's target half.`);
      return;
    }
    if (handoff !== undefined) await refreshTarget(handoff, to!, tier);
    else await refresh(from!, to!, tier);
    console.log(`refreshed ${tier} from stable and migrated forward.`);
    return;
  }

  if (handoff !== undefined && from) {
    await promoteSource(from, handoff);
    console.log(`read the canary's schema version into ${handoff} for the promote's target half.`);
    return;
  }
  const { version } = handoff !== undefined ? await promoteTarget(handoff, to!) : await promote(from!, to!);
  console.log(`promoted: stable stamped tier=stable${version ? `, promoted_schema_version=${version}` : " (canary recorded no schema_version — pre-migration-044)"}.`);
  console.log(`remaining: point the stable stack at the published image and migrate it (SMD-1860) — no image is published yet.`);
}

// A refusal or a failed step is a sentence for the operator, not a stack trace
// with Bun's source excerpt around it. Exit 1, as before: --diff's "moved" is
// also 1, and either one fails a gate (as does its 3, nothing compared).
if (import.meta.main) {
  await main().catch((e: unknown) => {
    console.error(`tier.ts: error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
