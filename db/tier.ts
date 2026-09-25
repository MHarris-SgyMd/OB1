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
 *              forward with the merged tree, replay the query log and diff the ids.
 *   working  — a per-worktree disposable copy of stable, migrated by the branch.
 *
 * This is the tooling half (slice 2); ingest-records.ts, OB1_TIER, the
 * query_log.tier column (migration 045) and the `tier` preflight check are slice 1.
 *
 *   # snapshot stable into the canary (or a working copy) and migrate it forward
 *   bun db/tier.ts --refresh --from <stable-url> --to <canary-url> [--tier canary|working]
 *
 *   # replay stable's logged searches against the canary and report the ranking
 *   bun db/tier.ts --replay --from <stable-url> --to <canary-url> [--since <iso-ts>]
 *
 *   # the same, but print ONLY what moved and exit non-zero if anything did (the gate)
 *   bun db/tier.ts --diff   --from <stable-url> --to <canary-url> [--since <iso-ts>]
 *
 *   # after a soak: stamp the canary's version onto stable
 *   bun db/tier.ts --promote --from <canary-url> --to <stable-url>
 *
 * --refresh uses pg_dump | pg_restore for a faithful whole-database snapshot
 * (thoughts, vectors, chunks, query_log, provenance, agents, audit — everything a
 * migration might touch), copies the source's database-level settings the dump
 * leaves out (SMD-2037), then runs migrate.ts against the target. It needs a
 * pg_dump / pg_restore whose major version is at least the source server's, AND
 * Bun: no image the stack runs has both, so deploy/tier.sh runs this file in one
 * that does (db/tier.Dockerfile, SMD-2036); a host that runs it directly needs
 * postgresql-client >= the server. It is destructive to --to, so it refuses a
 * --to that is the --from database (sameDatabase, whatever else is true); a
 * --to stamped tier=stable, holding thoughts under no canary/working stamp, or
 * holding some other application's schema, unless an earlier refresh marked it
 * (targetRefusal); and a non-loopback --to unless OB1_ALLOW_REMOTE_DB=1, the
 * same guard test-support's dropSchema uses.
 *
 * The replay is the LIVE half of the replay gate (SMD-1295, whose db/test-replay.ts
 * is the offline, model-free, fixture-vector half in CI). For each search row
 * stable logged, it re-runs the query against the canary through the SHIPPED
 * retrieval and diffs the returned ids against the ids stable recorded:
 *   • the keyword arm (search_thoughts_keyword) is model-free — the arm the CI
 *     end-to-end (test-live [20]) exercises;
 *   • the hybrid arm (search_thoughts_hybrid) needs a provider to embed the query
 *     text, so it is replayed only when a model is configured (OB1_EVAL_EMBED, as
 *     evals/eval-replay.ts uses) and skipped-with-a-note otherwise.
 * A row logged before migration 045 carries a NULL arm (no way to know which arm
 * produced its ids), so it is skipped rather than guessed.
 */

import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alignVectorSearchPath, DB_LEVEL_SETTINGS_SQL, parseSetConfig } from "./config.mjs";
import { stampTier, TIERS, type Tier } from "./ingest-records.ts";
import { parsePgUuidArray } from "../evals/query-log.ts";
import { embed } from "../evals/lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The replay gate — the reusable engine (imported by db/test-live.ts [20]).
// ---------------------------------------------------------------------------

/** One search the stable log recorded — everything a faithful replay needs, plus the answer to diff against. */
export type LoggedSearch = {
  id: string;
  query: string;
  arm: "hybrid" | "keyword" | null;
  matchCount: number | null;
  threshold: number | null;
  recencyWeight: number | null;
  filter: Record<string, unknown>;
  /** The ids stable returned, in rank order (query_log.result_ids). */
  resultIds: string[];
};

/** How a canary's replay of one row differs from what stable logged. */
export type RowDiff = {
  id: string;
  query: string;
  logged: string[];
  replayed: string[];
  /** ids the canary returned that stable did not. */
  added: string[];
  /** ids stable returned that the canary did not. */
  dropped: string[];
  /** the same set, a different order. */
  reordered: boolean;
  changed: boolean;
};

export type ReplaySummary = {
  /** search rows in the window. */
  total: number;
  /** rows actually replayed (hybrid rows skip when no model is configured; NULL-arm rows always skip). */
  replayed: number;
  skipped: number;
  /** the reasons rows were skipped, counted. */
  skips: Record<string, number>;
  /** rows whose ids moved. */
  changed: number;
  /** the moved rows — the per-PR "what moved". */
  diffs: RowDiff[];
};

/** An embed function for the hybrid arm — injected so the engine has no provider dependency of its own (and the model-free CI path passes none). */
export type EmbedFn = (query: string) => Promise<number[]>;

/**
 * The stable searches to replay: every search row in the window, stable's own
 * (tier 'stable', or NULL for a brain that predates the column). Ordered oldest
 * first so a printed diff reads in the order the queries were asked. Kept pure —
 * no requireQueryLog / process.exit — so a test can drive it; the CLI checks the
 * table exists before calling.
 */
export async function readLoggedSearches(sql: SQL, since: string | null): Promise<LoggedSearch[]> {
  const rows = await sql`
    SELECT id, query, arm, match_count, threshold, recency_weight, filter, result_ids
    FROM query_log
    WHERE kind = 'search'
      AND query IS NOT NULL
      AND (tier = 'stable' OR tier IS NULL)
      AND (${since}::timestamptz IS NULL OR logged_at > ${since}::timestamptz)
    ORDER BY logged_at ASC, id ASC`;
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    query: r.query as string,
    arm: (r.arm as LoggedSearch["arm"]) ?? null,
    matchCount: (r.match_count as number | null) ?? null,
    threshold: (r.threshold as number | null) ?? null,
    recencyWeight: (r.recency_weight as number | null) ?? null,
    filter: (r.filter as Record<string, unknown> | null) ?? {},
    resultIds: parsePgUuidArray(r.result_ids),
  }));
}

/**
 * Re-run one logged search against the target brain through the shipped
 * retrieval, returning the ids in rank order. `ran` is false when the row cannot
 * be replayed faithfully: a hybrid row with no embed function, or a NULL-arm row.
 */
export async function replayOne(
  sql: SQL,
  row: LoggedSearch,
  embedFn?: EmbedFn,
): Promise<{ ids: string[]; ran: boolean; reason?: string }> {
  const filter = row.filter ?? {};
  if (row.arm === "keyword") {
    // The exact-string arm — no vector, so it replays with no model. match_count
    // maps to the function's p_limit; the logged filter is threaded so the
    // filtered path (SMD-1490) is replayed as it ran.
    const limit = row.matchCount ?? 25;
    const rows = await sql`SELECT id FROM search_thoughts_keyword(${row.query}, ${limit}, 0, ${filter}::jsonb)`;
    return { ids: rows.map((r: { id: string }) => r.id), ran: true };
  }
  if (row.arm === "hybrid") {
    if (!embedFn) return { ids: [], ran: false, reason: "hybrid needs a provider (set OB1_EVAL_EMBED)" };
    const qv = await embedFn(row.query);
    const threshold = row.threshold ?? -1;
    const count = row.matchCount ?? 10;
    const recency = row.recencyWeight ?? 0;
    const rows = await sql`
      SELECT id FROM search_thoughts_hybrid(
        ${`[${qv.join(",")}]`}::vector, ${row.query}, ${threshold}, ${count}, ${filter}::jsonb, ${recency})`;
    return { ids: rows.map((r: { id: string }) => r.id), ran: true };
  }
  return { ids: [], ran: false, reason: "arm is NULL (logged before migration 045) — which arm produced its ids is unknown" };
}

/** The set/order difference between what stable logged and what the canary returned. */
export function diffResult(logged: string[], replayed: string[]): Omit<RowDiff, "id" | "query" | "logged" | "replayed"> {
  const loggedSet = new Set(logged);
  const replayedSet = new Set(replayed);
  const added = replayed.filter((id) => !loggedSet.has(id));
  const dropped = logged.filter((id) => !replayedSet.has(id));
  const sameSet = added.length === 0 && dropped.length === 0;
  const reordered = sameSet && logged.join(",") !== replayed.join(",");
  return { added, dropped, reordered, changed: added.length > 0 || dropped.length > 0 || reordered };
}

/**
 * Replay every stable search in the window against the canary and collect the
 * rows whose ids moved — the measured "what moved" a PR would otherwise write by
 * hand. `stable` supplies the logged searches and answers; `canary` is replayed.
 */
export async function replayAndDiff(
  stable: SQL,
  canary: SQL,
  opts: { since: string | null; embedFn?: EmbedFn } = { since: null },
): Promise<ReplaySummary> {
  const searches = await readLoggedSearches(stable, opts.since);
  const summary: ReplaySummary = { total: searches.length, replayed: 0, skipped: 0, skips: {}, changed: 0, diffs: [] };
  for (const row of searches) {
    const { ids, ran, reason } = await replayOne(canary, row, opts.embedFn);
    if (!ran) {
      summary.skipped++;
      const key = reason ?? "skipped";
      summary.skips[key] = (summary.skips[key] ?? 0) + 1;
      continue;
    }
    summary.replayed++;
    const d = diffResult(row.resultIds, ids);
    if (d.changed) {
      summary.changed++;
      summary.diffs.push({ id: row.id, query: row.query, logged: row.resultIds, replayed: ids, ...d });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// The refresh — a faithful whole-database snapshot, then migrate forward.
// ---------------------------------------------------------------------------

/** A host that is safe to reset without OB1_ALLOW_REMOTE_DB — refresh drops the target's schema. */
function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "" || h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
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
 * Whether `a` and `b` reached the same database. The test is exact: `a`'s own
 * session — its backend pid and the instant it started, the pair no two live
 * sessions on one cluster share — is looked up in `b`'s pg_stat_activity, which
 * lists every session on `b`'s cluster. Found means one cluster, and then the
 * database names decide. No URL, host name or address is compared, so a compose
 * service name and its container name, an alias and an IP, are still one
 * database; and a copy that shares the source's system_identifier (a volume
 * copy, a base backup) is still another. A role that may not read another
 * role's backend_start sees it NULL, and a matching pid is then taken as a
 * match: the error falls on the side of refusing.
 */
async function sameDatabase(a: SQL, b: SQL): Promise<boolean> {
  const [me] = await a<{ pid: number; started: string; db: string }[]>`
    SELECT pid, extract(epoch FROM backend_start)::text AS started, current_database() AS db
    FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
  const [seen] = await b<{ found: boolean; db: string }[]>`
    SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE pid = ${me.pid}
               AND (backend_start IS NULL OR extract(epoch FROM backend_start)::text = ${me.started})
           ) AS found,
           current_database() AS db`;
  return seen.found && seen.db === me.db;
}

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
const SETTING_NAME = /^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)*$/i;

/**
 * The database's own settings (`ALTER DATABASE … SET`, pg_db_role_setting
 * setrole 0) as name → value, the refresh mark left out. pg_dump without
 * --create carries none of them, so a refresh copies them from --from onto
 * --to itself (SMD-2037): migration 014 seeds the HNSW walk's bounds there
 * once, and a copy without them answers a broad filtered search short.
 */
export async function databaseSettings(sql: SQL): Promise<Record<string, string>> {
  const [row] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
  const { ["ob1.refresh_target"]: _mark, ...settings } = parseSetConfig(row?.cfg);
  for (const name of Object.keys(settings)) {
    if (!SETTING_NAME.test(name)) throw new Error(`database setting ${JSON.stringify(name)} is not a name this tool can write back`);
  }
  return settings;
}

/** A list setting's stored value (`"$user", public`) as its elements. */
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
 * Make `dst`'s own settings equal `settings`, the refresh mark aside: each one
 * `dst` has that `settings` lacks is reset, and each in `settings` is set.
 * pgvector is loaded first, as migration 014's remedy does, so `hnsw.*` are
 * the library's settings, which a database owner may set, rather than
 * placeholders only a superuser may.
 */
export async function applyDatabaseSettings(dst: SQL, settings: Record<string, string>): Promise<void> {
  const current = await databaseSettings(dst);
  // A no-op where `vector` already resolves; else the path gains its schema.
  await alignVectorSearchPath(dst);
  const [{ db, loadable }] = await dst<{ db: string; loadable: boolean }[]>`SELECT current_database() AS db, to_regtype('vector') IS NOT NULL AS loadable`;
  if (loadable) await dst`SELECT '[1]'::vector`;
  const target = `"${db.replaceAll('"', '""')}"`;
  for (const name of Object.keys(current)) {
    if (!(name in settings)) await dst.unsafe(`ALTER DATABASE ${target} RESET ${name}`);
  }
  for (const [name, value] of Object.entries(settings)) {
    const elements = LIST_SETTINGS.has(name) ? listElements(value) : null;
    const rhs = elements === null ? `'${value.replaceAll("'", "''")}'`
      : elements.length === 0 || (elements.length === 1 && elements[0] === "") ? "''"
      : elements.map((e) => `"${e.replaceAll('"', '""')}"`).join(", ");
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
    SELECT current_database() AS db,
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

/** Whether pg_dump AND pg_restore exist and are new enough to read `serverMaj` — refresh needs both. */
export async function refreshToolsReady(serverMaj: number): Promise<{ ready: boolean; why?: string }> {
  const dump = await toolMajor("pg_dump");
  if (dump === null) return { ready: false, why: "pg_dump is not on PATH" };
  const restore = await toolMajor("pg_restore");
  if (restore === null) return { ready: false, why: "pg_restore is not on PATH" };
  if (dump < serverMaj) return { ready: false, why: `pg_dump is major ${dump} but the source server is major ${serverMaj} (pg_dump cannot read a newer server)` };
  return { ready: true };
}

async function run(cmd: string[], opts: { stdio?: "inherit" | "pipe" } = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: opts.stdio === "inherit" ? "inherit" : "pipe",
    stderr: opts.stdio === "inherit" ? "inherit" : "pipe",
    env: process.env,
  });
  const out = opts.stdio === "inherit" ? "" : await new Response(proc.stdout).text();
  const err = opts.stdio === "inherit" ? "" : await new Response(proc.stderr).text();
  return { code: await proc.exited, out, err };
}

/**
 * Snapshot `fromUrl` into `toUrl` and migrate it forward with this tree.
 *   1. pg_dump the source (custom format, no owner/privileges — the target's role
 *      may differ; ROLE_GRANTS are re-issued by migrate --grant, not carried).
 *   2. mark the target as a refresh target (refreshMark), then reset its public
 *      schema (the destructive step, guarded by targetRefusal and the loopback check).
 *   3. pg_restore the dump.
 *   4. copy the source's database-level settings (databaseSettings), which the
 *      dump does not carry — 014's HNSW bounds among them (SMD-2037).
 *   5. migrate.ts forward — the point of the canary: a migration meets real data.
 *   6. stamp the tier and this refresh's time in ob1_config.
 * Throws with a plain message on any failed step.
 */
export async function refresh(fromUrl: string, toUrl: string, tier: Tier): Promise<void> {
  if (!isLoopback(toUrl) && process.env.OB1_ALLOW_REMOTE_DB !== "1") {
    throw new Error(`--to is not loopback and OB1_ALLOW_REMOTE_DB is not 1. Refusing to reset a remote database. (--refresh drops the target's schema.)`);
  }
  const src = new SQL({ url: fromUrl, max: 1 });
  const target = new SQL({ url: toUrl, max: 1 });
  let serverMaj: number;
  let settings: Record<string, string>;
  try {
    serverMaj = await serverMajor(src);
    settings = await databaseSettings(src);
    // The reset below drops --to's schema, so --to must be neither the source
    // nor the record. The loopback guard covers neither — deploy/tier.sh sets
    // OB1_ALLOW_REMOTE_DB, since from its container every database is remote —
    // and the likeliest slips are both: stable under the other name it answers
    // to on the network, and --from and --to the wrong way round.
    if (await sameDatabase(src, target)) throw new Error(`--from and --to name the same database. Refusing: --refresh drops the target's schema.`);
    const refusal = await targetRefusal(target);
    if (refusal) throw new Error(`${refusal}. Refusing: --refresh drops the target's schema.`);
  } finally {
    await src.close();
    await target.close();
  }
  const ready = await refreshToolsReady(serverMaj);
  if (!ready.ready) throw new Error(`--refresh needs pg_dump / pg_restore: ${ready.why}. deploy/tier.sh runs this in an image with both (db/tier.Dockerfile, postgresql16-client); on a host install postgresql-client >= ${serverMaj}.`);

  const dir = await mkdtemp(join(tmpdir(), "ob1-tier-"));
  const dumpFile = join(dir, "stable.dump");
  try {
    const dumped = await run(["pg_dump", "-Fc", "--no-owner", "--no-privileges", "-f", dumpFile, fromUrl]);
    if (dumped.code !== 0) throw new Error(`pg_dump failed (exit ${dumped.code}): ${dumped.err.trim()}`);

    // Reset the target so the restore lands on a clean schema. DROP … CASCADE is
    // the destructive act --refresh exists to perform; it is guarded above. The
    // mark goes first, so a refresh that dies from here on — a migration that
    // fails on the copy, a Ctrl-C mid-restore — leaves a target the next one
    // recognises as its own (refreshMark). `tier` is one of TIERS, checked by
    // the caller; ALTER DATABASE takes no bind parameters.
    const dst = new SQL({ url: toUrl, max: 1 });
    try {
      if (!TIERS.includes(tier)) throw new Error(`not a tier: ${tier}`);
      try {
        await dst.unsafe(`DO $mark$ BEGIN EXECUTE format('ALTER DATABASE %I SET ob1.refresh_target = %L', current_database(), '${tier}'); END $mark$`);
      } catch (e) {
        // Nothing is reset yet. A database-level setting of a custom name needs a
        // superuser, or on PG15+ a role granted SET on the parameter; restoring
        // pgvector into a public schema the reset emptied needs a superuser in
        // the default install too, so a role that cannot mark could rarely finish.
        throw new Error(`--refresh marks --to before resetting it (ALTER DATABASE … SET ob1.refresh_target) and could not: ${(e as Error).message}. That needs a superuser on --to, or GRANT SET ON PARAMETER ob1.refresh_target (PG15+); restoring pgvector needs a superuser in the default install anyway. --to is untouched.`);
      }
      await dst`DROP SCHEMA IF EXISTS public CASCADE`;
      await dst`CREATE SCHEMA public`;
    } finally {
      await dst.close();
    }

    const restored = await run(["pg_restore", "--no-owner", "--no-privileges", "-d", toUrl, dumpFile]);
    // pg_restore exits non-zero on benign warnings (e.g. a comment on an extension
    // it did not create); treat a restore that produced the core table as success,
    // otherwise surface it.
    const check = new SQL({ url: toUrl, max: 1 });
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
    const settle = new SQL({ url: toUrl, max: 1 });
    try {
      await applyDatabaseSettings(settle, settings);
    } catch (e) {
      throw new Error(`copying --from's database settings onto --to failed: ${(e as Error).message}. --to is restored and still marked, so re-run the refresh once that is fixed.`);
    } finally {
      await settle.close();
    }

    const migrated = await run(["bun", join(HERE, "migrate.ts"), "--url", toUrl], { stdio: "inherit" });
    if (migrated.code !== 0) throw new Error(`migrate.ts failed on the refreshed target (exit ${migrated.code})`);

    const stamp = new SQL({ url: toUrl, max: 1 });
    try {
      await stampTier(stamp, tier);
      await setConfig(stamp, "last_refresh", new Date().toISOString());
    } finally {
      await stamp.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

/** Upsert an ob1_config KV row — the write half beside readConfig. */
async function setConfig(sql: SQL, key: string, value: string): Promise<void> {
  await sql`INSERT INTO ob1_config (key, value) VALUES (${key}, ${value})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
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
export async function promote(canaryUrl: string, stableUrl: string): Promise<{ version: string | null }> {
  const canary = new SQL({ url: canaryUrl, max: 1 });
  const stable = new SQL({ url: stableUrl, max: 1 });
  try {
    // The mirror of refresh's guard: promote stamps --to as stable, so --to must
    // not be the canary itself, nor a tier — the shape of --from and --to the
    // wrong way round, which would make the canary read as the record.
    if (await sameDatabase(canary, stable)) throw new Error(`--from and --to name the same database. Refusing: --promote stamps --to as stable.`);
    const mark = await refreshMark(stable);
    const tier = await configTier(stable);
    if (mark !== null || tier === "canary" || tier === "working") {
      const [{ db }] = await stable<{ db: string }[]>`SELECT quote_ident(current_database()) AS db`;
      throw new Error(`--to is a tier (${mark !== null ? `refresh mark ${mark}` : `tier=${tier}`}), not the record — are --from and --to the wrong way round? Refusing: --promote stamps --to as stable.${mark !== null ? ` If --to really is to be the record now, clear the mark first: ALTER DATABASE ${db} RESET ob1.refresh_target` : ""}`);
    }
    const version = await readConfig(canary, "schema_version");
    // Assert the target is stable — but only the tier key, not stampTier's
    // last_ingest: a promotion is not an ingest, and stable's last_ingest must
    // keep naming the real rebuild time (preflight's `tier` check reads it).
    await setConfig(stable, "tier", "stable");
    if (version !== null) await setConfig(stable, "promoted_schema_version", version);
    await setConfig(stable, "promoted_at", new Date().toISOString());
    return { version };
  } finally {
    await canary.close();
    await stable.close();
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(s: ReplaySummary, onlyChanged: boolean): void {
  const short = (id: string) => id.slice(0, 8);
  if (!onlyChanged) {
    console.log(`replayed ${s.replayed} of ${s.total} logged searches (${s.skipped} skipped)`);
    for (const [reason, n] of Object.entries(s.skips)) console.log(`  skipped ${n}: ${reason}`);
  }
  if (s.changed === 0) {
    console.log(onlyChanged ? "what moved: nothing — the canary reproduces stable's rankings." : "no ranking moved.");
    return;
  }
  console.log(`\nwhat moved — ${s.changed} of ${s.replayed} replayed queries returned different ids:`);
  for (const d of s.diffs) {
    const bits: string[] = [];
    if (d.dropped.length) bits.push(`dropped ${d.dropped.map(short).join(",")}`);
    if (d.added.length) bits.push(`added ${d.added.map(short).join(",")}`);
    if (d.reordered) bits.push("reordered");
    console.log(`  • ${JSON.stringify(d.query.slice(0, 70))}: ${bits.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(`--${name}`);

  // Every argument accounted for, the way migrate.ts and ingest-records.ts do it.
  {
    const TAKES_ONE = new Set(["from", "to", "since", "tier"]);
    const TAKES_NONE = new Set(["refresh", "replay", "diff", "promote"]);
    const USAGE =
      "  one verb: --refresh | --replay | --diff | --promote\n" +
      "  flags: --from <postgres://…>, --to <postgres://…>, --since <iso-ts>, --tier <canary|working>";
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const name = a.startsWith("--") ? a.slice(2) : null;
      if (name !== null && (TAKES_ONE.has(name) || TAKES_NONE.has(name))) {
        if (seen.has(name)) { console.error(`--${name} given twice.\n${USAGE}`); process.exit(2); }
        seen.add(name);
      }
      if (name !== null && TAKES_ONE.has(name)) {
        if (i + 1 >= args.length || args[i + 1].startsWith("--")) { console.error(`--${name} takes a value.\n${USAGE}`); process.exit(2); }
        i++;
        continue;
      }
      if (name !== null && TAKES_NONE.has(name)) continue;
      const shown = name !== null ? a : /:\/\//.test(a) ? "<a URL>" : a;
      console.error(`unknown argument: ${shown}${name === null ? " (a value where no flag takes one)" : ""}\n${USAGE}`);
      process.exit(2);
    }
  }

  const verbs = ["refresh", "replay", "diff", "promote"].filter((v) => has(v));
  if (verbs.length !== 1) {
    console.error(`Give exactly one verb (--refresh, --replay, --diff, --promote), not ${verbs.length}.`);
    process.exit(2);
  }
  const verb = verbs[0];
  const from = flag("from");
  const to = flag("to");
  if (!from || !to) {
    console.error(`--${verb} needs --from and --to.`);
    process.exit(2);
  }

  if (verb === "refresh") {
    const tier = (flag("tier") ?? "canary") as Tier;
    if (!TIERS.includes(tier) || tier === "stable") {
      console.error(`--tier must be canary or working (stable is the source, ingest-records.ts writes it).`);
      process.exit(2);
    }
    await refresh(from, to, tier);
    console.log(`refreshed ${tier} from stable and migrated forward.`);
    return;
  }

  if (verb === "promote") {
    const { version } = await promote(from, to);
    console.log(`promoted: stable stamped tier=stable${version ? `, promoted_schema_version=${version}` : " (canary recorded no schema_version — pre-migration-044)"}.`);
    console.log(`remaining: point the stable stack at the published image and migrate it (SMD-1860) — no image is published yet.`);
    return;
  }

  // replay | diff
  const since = flag("since") ?? null;
  const stable = new SQL({ url: from, max: 4 });
  const canary = new SQL({ url: to, max: 4 });
  try {
    // The table must exist on both ends; say so in the reader's words, not a driver trace.
    for (const [sql, label] of [[stable, "--from (stable)"], [canary, "--to (canary)"]] as const) {
      const [{ present }] = await sql<{ present: boolean }[]>`SELECT to_regclass('public.query_log') IS NOT NULL AS present`;
      if (!present) {
        console.error(`tier.ts --${verb}: query_log is not present on ${label} — migration 034 is not applied there.`);
        process.exit(2);
      }
    }
    // The default window is since the canary was last refreshed; else everything.
    const window = since ?? (await readConfig(canary, "last_refresh"));
    const embedModel = process.env.OB1_EVAL_EMBED;
    const embedFn: EmbedFn | undefined = embedModel ? (q) => embed(embedModel, q, true) : undefined;
    if (!embedFn) console.error(`note: OB1_EVAL_EMBED is not set — hybrid-arm searches will be skipped (keyword arm replays without a model).`);
    const summary = await replayAndDiff(stable, canary, { since: window, embedFn });
    printSummary(summary, verb === "diff");
    if (verb === "diff" && summary.changed > 0) process.exit(1);
  } finally {
    await stable.close();
    await canary.close();
  }
}

// A refusal or a failed step is a sentence for the operator, not a stack trace
// with Bun's source excerpt around it. Exit 1, as before: --diff's "moved" is
// also 1, and either one fails a gate.
if (import.meta.main) {
  await main().catch((e: unknown) => {
    console.error(`tier.ts: error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
