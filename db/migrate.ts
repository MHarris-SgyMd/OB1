#!/usr/bin/env bun
/**
 * migrate.ts — apply db/migrations/*.sql in order, once each.
 *
 * Works against any Postgres 15+ with pgvector 0.8.0 or later — migration 014
 * declares HNSW settings that older pgvector rejects. Uses Bun's built-in SQL
 * client, so there is no driver dependency.
 *
 *   bun db/migrate.ts --url postgres://user:pass@host:5432/dbname
 *   DATABASE_URL=... bun db/migrate.ts
 *   bun db/migrate.ts --dry-run        # show what would run, touch nothing
 *   bun db/migrate.ts --reapply        # re-run every recorded migration, in one transaction
 *
 * Applied migrations are recorded in schema_migrations, so re-running is a no-op.
 * Every migration is also individually idempotent, so a database created by hand
 * from docs/01-getting-started.md can be adopted: mark the ones already applied
 * with --baseline, or just run them — they will not duplicate anything.
 *
 * --reapply re-runs EVERY migration — recorded or pending — in order, in ONE
 * transaction with a lock timeout (LOCK_TIMEOUT_S); recorded rows stay as they are, pending
 * ones are recorded in the same transaction. It is the remedy for a database
 * adopted with --baseline whose schema is older than its ledger says —
 * reembed.ts and preflight name the command where they find that. Every file,
 * not a range from the one a symptom names: a later migration may redefine what
 * an earlier one created (022, 025, 033 and 035 redefine 021's upsert_thought; 020 drops a
 * form 014 recreates), and a file's body may reference what only an earlier
 * file installs (025's upsert_thought reads a column 021 adds, resolved when the
 * function first RUNS, not when it is created) — so a start point is safe only
 * when everything before it is really present, which nothing can check cheaply;
 * and pending files in the same ordered transaction, because a ledger hole (a
 * row deleted or misspelt by hand) would otherwise have an earlier-numbered file
 * apply AFTER the re-run and put its definitions over the later ones the re-run
 * had just restored. Every file is idempotent, so the run restores the latest
 * definition of everything. One transaction, so a failure part-way leaves the
 * schema as it was rather than with some objects at an older definition than
 * before. What a re-run repeats from the CURRENT shell, and refuses to change
 * silently: 006 and 013 re-record ob1_config (refused when the record differs
 * from the shell), 011 builds the trigram index when OB1_TRGM_INDEX is on and
 * it is absent, 023 runs its backfill call under OB1_BACKFILL_LIMIT (SMD-1193).
 *
 * 021's evidence backfill — the one statement in the set that writes DATA from
 * a rule over other data, hashed and applied as written before SMD-1067 made an
 * operator's ACCEPTANCE of a failure a succeeded claim row — runs here with the
 * acceptances out of its sight, on a plain run or a re-run: a view of the claim
 * table without them shadows the real one for that file alone, so the block
 * labels from the latest row that is not an acceptance, or not at all. See
 * applyShadowed (SMD-1421). The session sets one lock_timeout, LOCK_TIMEOUT_S
 * (config.mjs), for everything the migrator does, so a held lock fails the run
 * rather than freezing it and every reader behind it.
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTED_CLAIM_SQL,
  LOCK_TIMEOUT_S,
  alignVectorSearchPath,
  migrationNameProblem,
  DB_LEVEL_SETTINGS_SQL,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HNSW_SEEDS,
  ROLE_GRANT_GROUPS,
  ROLE_LOCK_PREFIX,
  SHARED_SETTING_SOURCES,
  TRGM_INDEX,
  grantPresenceSql,
  grantStatements,
  grantVerifySql,
  grantedObjects,
  mergedGrants,
  migrationValues,
  parseSetConfig,
  quoteIdent,
  setPathWithoutTemp,
  substituteMigration,
  validateEmbeddingConfig,
  versionAtLeast,
} from "./config.mjs";
import { migrationSha, versionForMigration, readReleases } from "./version.mjs";
import { commandLine } from "./cli.ts";
import { databaseUrl, openSql } from "./connect.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Every argument accounted for (db/cli.ts): a flag the runner does not have, a
// value where no flag takes one, a flag that takes a value followed by none,
// or a flag given twice (`--url A --url B` would run against A), is refused
// rather than dropped — `--reapply=021`, or a misspelt flag, would otherwise be
// a silent plain run that exits 0. The refusal names the flag or the
// argument's position, never the argument: a URL carries a password.
const cli = commandLine("migrate.ts", {
  url: "one", grant: "one", groups: "one", exact: "none", "dry-run": "none", baseline: "none", reapply: "none", force: "none",
}, { hints: { url: "<postgres://…>", grant: "<role>", groups: "<group,group…> (with --grant)", exact: "(with --grant)", force: "(with --baseline)" } });

// Refused before the URL is read, so a stray --groups or --exact says so rather than "no database URL".
const groupsArg = cli.value("groups");
const exact = cli.has("exact");
if ((groupsArg !== undefined || exact) && cli.value("grant") === undefined) {
  console.error(`${groupsArg !== undefined ? "--groups narrows" : "--exact makes"} --grant ${groupsArg !== undefined ? "to some of its groups" : "all a role holds"}; it does nothing on its own. Pass it with --grant <role>.`);
  process.exit(2);
}
const url = databaseUrl(cli.value("url"));
const dryRun = cli.has("dry-run");
const baseline = cli.has("baseline");
const reapply = cli.has("reapply");
const force = cli.has("force");

if (reapply && baseline) {
  console.error("--reapply re-runs what the ledger records; --baseline records without running. One or the other.");
  process.exit(2);
}
// --force has one job: override --baseline's empty-database guard below. On its
// own it would change nothing, so it is refused rather than dropped — a plain
// run "forced" is still a plain run, and an operator who typed it meant --baseline.
if (force && !baseline) {
  console.error("--force overrides --baseline's empty-database guard; it does nothing on its own. Pass it with --baseline, or drop it.");
  process.exit(2);
}

/** A refusal inside --grant's transaction: exit 2, nothing committed. */
class GrantRefusal extends Error {}

/** --exact's revokes: the role's privileges on every schema's tables, sequences and routines (procedures and aggregates with the functions), on the schemas, and CREATE on this database. */
async function exactRevokes(sql: any, role: string): Promise<string[]> {
  const r = quoteIdent(role);
  const schemas = (await sql`SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`) as { nspname: string }[];
  const [{ db }] = (await sql`SELECT current_database() AS db`) as { db: string }[];
  return [
    ...schemas.flatMap(({ nspname }) => {
      const s = quoteIdent(nspname);
      return [...["TABLES", "SEQUENCES", "ROUTINES"].map((k) => `REVOKE ALL ON ALL ${k} IN SCHEMA ${s} FROM ${r};`), `REVOKE ALL ON SCHEMA ${s} FROM ${r};`];
    }),
    `REVOKE CREATE ON DATABASE ${quoteIdent(db)} FROM ${r};`,
  ];
}

/** What the role holds that --exact's revokes did not reach, by catalog and database: every privilege row pg_shdepend keeps for it but CONNECT and TEMP on this database. */
async function heldBeyond(sql: any, role: string): Promise<string[]> {
  const rows = (await sql`
    SELECT d.classid::regclass::text AS catalog,
           CASE WHEN d.dbid = 0 THEN 'the cluster' ELSE coalesce(db.datname, d.dbid::text) END AS db,
           count(*)::int AS n
      FROM pg_shdepend d LEFT JOIN pg_database db ON db.oid = d.dbid
     WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'a'
       AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = ${role})
       AND NOT (d.classid = 'pg_database'::regclass AND d.objid = (SELECT oid FROM pg_database WHERE datname = current_database()))
     GROUP BY 1, 2 ORDER BY 2, 1`) as { catalog: string; db: string; n: number }[];
  return rows.map((x) => `${x.n} in ${x.catalog} (${x.db})`);
}


// --grant <role>: issue exactly the privileges db/config.mjs's ROLE_GRANTS
// documents — the one executable spelling of db/README.md's "Grants for a
// capturing role". A standalone mode: it records nothing in the ledger and runs
// no migration, so it is refused beside --baseline or --reapply. It grants only
// objects that already exist — tables, and since SMD-1796 the community
// schemas' views, sequences and functions too — so it is safe on a partially-migrated
// database, before a community schema is applied, and again after later
// migrations or schemas bring the rest. It never creates a role or sets a
// password — a missing role is an error naming CREATE ROLE, not a silent create
// — so no credential passes through it. --dry-run prints the statements without
// running them: the list, copyable, for a role you would rather grant by hand.
// After the GRANTs, in the same transaction, it asks the catalog whether the
// role now holds each privilege and rolls back if not: a grantor that holds a
// privilege without grant option "grants" it with a WARNING and no effect,
// which the driver does not surface (SMD-1796, third review pass).
// --groups a,b narrows it to those groups of ROLE_GRANTS (SMD-2289: the
// orchestration runner's role gets what its ingester and reembed run, not the
// whole list). It grants less; alone it revokes nothing, so a role granted more
// before keeps what it has. --exact makes the grant all the role holds in this
// database: in the grant's own transaction it first revokes the role's
// privileges on every schema's tables, sequences and routines, on the schemas,
// and CREATE on the database (CONNECT and TEMP stay: an operator may have
// granted CONNECT to a hardened brain), then refuses, rolling back, if it
// still holds any other (a default privilege naming it, a grant in another
// database or on a tablespace or parameter, one made by a grantor other than
// the object's owner), and only then grants. One transaction, so a run in
// flight as the role never meets a moment without its privileges, and a
// failure leaves what it had (SMD-2289 review pass 3: the revoke was a commit
// of its own, and each `up` took them away for ~60 ms). The role's advisory
// lock serialises two at once, and db/login-role.ts takes the same.
const grantRole = cli.value("grant");
const grantGroups = groupsArg === undefined ? ROLE_GRANT_GROUPS : [...new Set(groupsArg.split(",").map((g) => g.trim()).filter(Boolean))];
{
  const unknown = grantGroups.filter((g) => !(ROLE_GRANT_GROUPS as readonly string[]).includes(g));
  if (groupsArg !== undefined && (unknown.length || !grantGroups.length)) {
    console.error(`--groups takes a comma-separated list of ${ROLE_GRANT_GROUPS.join(", ")}${unknown.length ? `; not a group: ${unknown.map((g) => JSON.stringify(g)).join(", ")}` : "; none was given"}.`);
    process.exit(2);
  }
}
if (grantRole !== undefined) {
  if (baseline || reapply) {
    console.error("--grant issues privileges; it does not apply or record migrations. Run it on its own.");
    process.exit(2);
  }
  const gsql = openSql(url);
  try {
    const [{ present: roleExists }] = (await gsql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${grantRole}) AS present`) as { present: boolean }[];
    if (!roleExists) {
      console.error(
        `No role ${JSON.stringify(grantRole)} exists. Create it first, as a role that can:\n` +
          `  CREATE ROLE ${quoteIdent(grantRole)} LOGIN PASSWORD '…';\n` +
          "then re-run --grant. This step grants privileges only; it never creates a role or sets a password."
      );
      await gsql.close();
      process.exit(2);
    }
    const wanted = grantedObjects(grantGroups);
    const present = new Set<string>(
      ((await gsql.unsafe(grantPresenceSql(wanted))) as { kind: string; name: string; present: boolean }[]).filter((r) => r.present).map((r) => r.name)
    );
    const missing = wanted.filter((o) => !present.has(o.name)).map((o) => o.name);
    // "; " between names: a function's name carries ", " inside its argument list.
    const skippedHint = `not yet present, skipped (run --grant again after applying the migration, community schema or extension/recipe schema that creates them; a function listed here may instead exist under another argument list, which --grant does not reach${missing.includes("schema_migrations") ? "; schema_migrations is this migrator's own ledger, which its first run makes" : ""}): ${missing.join("; ")}`;
    const statements = [`GRANT USAGE ON SCHEMA public TO ${quoteIdent(grantRole)};`, ...grantStatements(grantRole, { groups: grantGroups, present })];
    const revokes = exact ? await exactRevokes(gsql, grantRole) : [];
    if (dryRun) {
      console.log(`\n--grant ${grantRole}${groupsArg === undefined ? "" : ` --groups ${grantGroups.join(",")}`}${exact ? " --exact" : ""}  (--dry-run: nothing run)\n`);
      for (const s of [...revokes, ...statements]) console.log(`  ${s}`);
      if (missing.length) console.log(`\n  ${skippedHint}`);
      await gsql.close();
      process.exit(0);
    }
    const merged = mergedGrants(grantGroups, present);
    await gsql.begin(async (tx) => {
      if (exact) {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${ROLE_LOCK_PREFIX + grantRole}))`;
        for (const s of await exactRevokes(tx, grantRole)) await tx.unsafe(s);
        const left = await heldBeyond(tx, grantRole);
        if (left.length) throw new GrantRefusal(`--exact: ${grantRole} still holds privileges a revoke here does not reach — ${left.join("; ")} — a default privilege naming it, a grant in another database, on a tablespace or parameter, or one made by a grantor other than the object's owner. Revoke them (as their grantor), or name another role. Nothing changed.`);
      }
      for (const s of statements) await tx.unsafe(s);
      const notHeld = ((await tx.unsafe(grantVerifySql(grantRole, merged))) as { kind: string; name: string; privilege: string; held: boolean }[]).filter((r) => !r.held);
      if (notHeld.length) {
        throw new Error(
          `the GRANTs ran but ${notHeld.length} privilege(s) were not granted — Postgres lets a role that holds a privilege without grant option issue the GRANT with only a warning ("no privileges were granted"), which this client does not see. Not held by ${grantRole}: ` +
            notHeld.map((r) => `${r.privilege} on ${r.kind} ${r.name}`).join("; ") +
            ". Connect as the objects' owner — the role that ran the migrations or applied the community schema — or a superuser, and run --grant again. Nothing was committed."
        );
      }
    });
    console.log(`\nGranted ${grantRole} ${groupsArg === undefined ? "the capturing-role privileges" : `the privileges of ${grantGroups.join(", ")}`} over ${present.size} object(s)${exact ? ", and nothing else in this database" : ""}:\n`);
    for (const s of statements) console.log(`  ${s}`);
    if (missing.length) console.log(`\n  ${skippedHint}`);
    await gsql.close();
    process.exit(0);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof GrantRefusal) {
      console.error(message);
      await gsql.close();
      process.exit(2);
    }
    // 42501 here is the grantor's, not the grantee's: it holds nothing on the
    // object at all, so it cannot grant it.
    const hint = /permission denied/.test(message) ? "\n  This connection's role may not grant that object: connect as its owner (the role that ran the migrations or applied the community schema) or a superuser." : "";
    console.error(`--grant failed: ${message}${hint}`);
    await gsql.close();
    process.exit(1);
  }
}

type Migration = {
  name: string;
  sql: string;
  sha: string;
  /** From a `-- requires: pgvector >= X.Y.Z` line in the file's header, if any. */
  requiresPgvector: [number, number, number] | null;
  /** Database-level settings the file seeds through a DO block that can only warn — read from its text. */
  seeds: string[];
};

/**
 * A migration that needs a newer pgvector than the server may have says so in
 * its header — `-- requires: pgvector >= 0.8.0` — and the migrator judges the
 * floor from that line, so a later migration with the same need declares it
 * rather than being named here (the tenth review pass found 014's filename
 * hard-coded into four places of this loop).
 */
function requiresPgvector(template: string): [number, number, number] | null {
  const m = /^--\s*requires:\s*pgvector\s*>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/m.exec(template);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * Values substituted into the migration templates. Defined in config.mjs, not
 * here, because db/test-support.ts and db/test-schema.ts substitute the same
 * templates and each used to carry its own hardcoded pair of replacements.
 */
const SUBSTITUTIONS = migrationValues();

function substitute(sql: string, file: string): string {
  return substituteMigration(sql, SUBSTITUTIONS, file);
}

function loadMigrations(): Migration[] {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_, 002_, … lexical order is the intended order
  // The number is the file's identity — the order, and how prose names a file
  // — so every file carries one and two files may not share it: `021.sql`
  // would sort before `021_…` and run at its number, and a second 021_*.sql
  // sorting first would run before the one it collides with. The rule is
  // config.mjs's, shared with the fork checker, which refuses where the
  // collision is made.
  const problem = migrationNameProblem(names);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  return names.map((name) => {
      const template = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return {
        name,
        requiresPgvector: requiresPgvector(template),
        seeds: [...new Set([...template.matchAll(/ALTER DATABASE %I SET (hnsw\.\w+)/g)].map((x) => x[1]))],
        sql: substitute(template, name),
        // Hash the TEMPLATE, not the substituted SQL. Otherwise choosing a
        // different embedding dimension would look like an edited migration and
        // trip the drift check, when the file has not changed at all. The rule is
        // version.mjs's, shared with check-fork's frozen-range check (SMD-1804).
        sha: migrationSha(template),
      };
    });
}

const configProblems = validateEmbeddingConfig();
if (configProblems.length > 0) {
  console.error("Embedding configuration is not usable:\n");
  for (const p of configProblems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(2);
}

const migrations = loadMigrations();
if (migrations.length === 0) {
  console.error(`No .sql files in ${MIGRATIONS_DIR}`);
  process.exit(2);
}

/**
 * The file whose evidence backfill runs with the acceptances out of its sight
 * — by its whole name, as test-schema pins 030's: the number alone would find
 * any 021_*.sql. See applyShadowed.
 */
const FILE_021 = "021_embedding_model_per_row.sql";
if (!migrations.some((m) => m.name === FILE_021)) {
  console.error(`${FILE_021} is not in the set: it is the file whose evidence backfill the migrator shadows the claim table for, by its whole name — a renamed or renumbered file would run bare, reading the acceptances.`);
  process.exit(2);
}

console.log(`  embedding: ${EMBEDDING_MODEL} @ ${EMBEDDING_DIM} dimensions`);
// Printed because it is the one setting that changes what the schema CONTAINS
// rather than how wide a column is, and because it takes effect only when 011
// runs — the first apply, and every --reapply — see the note in that
// migration's header.
console.log(`  trigram index: ${TRGM_INDEX ? "on" : "off"} (OB1_TRGM_INDEX)`);
console.log(`  023/050/055 backfills: ${SUBSTITUTIONS.BACKFILL_LIMIT === "NULL" ? "every row waiting" : `one batch of ${SUBSTITUTIONS.BACKFILL_LIMIT} rows`} (OB1_BACKFILL_LIMIT)`);

const sql = openSql(url);
// One lock_timeout for the session — the checks' reads before a re-run, the
// ledger reads below — and again, LOCAL, inside every transaction (begin): a
// held lock fails the run rather than freezing it and every reader behind it.
// The session setting alone would not do: through a transaction-mode pooler
// it may be another server connection's by the time a transaction opens, and
// the bound must hold where the locks are taken. (A pooled URL is not the
// migrator's — README §5 says so: the search_path it aligns is session state
// too.) 023's call sets its own, locally, for its transaction.
await sql.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT_S}s'`);
/**
 * A transaction under READ COMMITTED with the run's lock_timeout set inside it,
 * as its first statements. READ COMMITTED whatever the database's default:
 * the migrations are written for it — 068's seed reads the rows after
 * CREATE TRIGGER's lock, and under REPEATABLE READ its snapshot would predate
 * the writes that lock waited for (SMD-2256, second review pass).
 */
const begin = <T>(fn: (tx: SQL) => Promise<T>): Promise<T> =>
  sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_S}s'`);
    return fn(tx);
  }) as Promise<T>;

// --baseline records every migration as applied WITHOUT running one: adoption of
// a schema already built by hand. On a database with no fork schema that is never
// adoption — it leaves a ledger over nothing, and every later plain run then skips
// every file (SMD-2237). Judge by public.thoughts (migration 001's table, by
// pg_class so a role's search_path does not hide it, as preflight's ledger row
// does), before the ledger table is created, so a refused --baseline touches
// nothing; --force is the escape hatch for an operator who means to record the
// ledger over a schema built some other way.
if (baseline && !force) {
  const [{ present }] = (await sql`
    SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'thoughts' AND c.relkind IN ('r', 'p')) AS present`) as { present: boolean }[];
  if (!present) {
    console.error(
      "--baseline refused: public.thoughts does not exist, so there is no schema to adopt.\n" +
        "  --baseline records every migration as applied WITHOUT running it; on an empty database that\n" +
        "  leaves a ledger over no schema, and every later plain run then skips every file.\n" +
        "  Apply the migrations instead: cd db && bun migrate.ts --url <the same connection string>.\n" +
        "  To record the ledger over a schema built some other way on purpose, pass --force."
    );
    await sql.close();
    process.exit(2);
  }
}

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Map<string, string>(
  (await sql`SELECT name, sha256 FROM schema_migrations`).map(
    (r: { name: string; sha256: string }) => [r.name, r.sha256]
  )
);

/** Recorded in the ledger under --reapply: re-run rather than skipped. */
const reapplies = (m: Migration): boolean => reapply && applied.has(m.name);

/**
 * Migration 014 declares HNSW settings that exist from pgvector 0.8.0. On an
 * older library its CREATE fails — by design, see its header — but "invalid
 * configuration parameter name" says nothing about versions, is localised, and
 * only appears once 001–013 have applied. So the floor each migration declares
 * is judged here, against the version the server's library REPORTS
 * (pg_available_extensions.default_version — the loaded code, whatever
 * pg_extension records for this database), and enforced in the loop: pending
 * migrations before it still apply and are recorded, --baseline still seeds
 * the ledger (it executes no SQL), and the migration itself is refused with a
 * message that names both versions. --dry-run reports the refusal the same
 * way. Unknown means proceed: a server whose control file is unreadable will
 * still say so on the migration.
 */
let pgvectorLibrary: string | null = null;
if (migrations.some((m) => m.requiresPgvector && (!applied.has(m.name) || reapplies(m)))) {
  try {
    const [ext] = await sql`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`;
    pgvectorLibrary = ext?.default_version == null ? null : String(ext.default_version);
  } catch {
    // Not every role may read pg_available_extensions. Unknown means proceed;
    // an old library still fails the migration itself, and the catch below
    // explains it.
  }
}
/** The version a migration requires, when the server's library is known to be older. */
const tooOldFor = (m: Migration): string | null =>
  m.requiresPgvector && pgvectorLibrary !== null && !versionAtLeast(pgvectorLibrary, ...m.requiresPgvector)
    ? m.requiresPgvector.join(".")
    : null;
const pgvectorRemedy = (then: string) =>
  "  Upgrade pgvector on the server to 0.8.0 or later — the compose stack pins pgvector/pgvector:0.8.6-pg16;\n" +
  "  on RDS, Aurora, Neon, Cloud SQL or Timescale, take the platform's newer pgvector — then, in this database,\n" +
  "    ALTER EXTENSION vector UPDATE;\n" +
  `  and re-run. ${then}`;
const PGVECTOR_REMEDY = pgvectorRemedy("Migrations before it are applied and recorded; nothing needs undoing.");
// Under --reapply the whole set is one transaction that has not begun when the
// floor refuses, so the plain remedy's last sentence would be false there.
const floorMessage = (m: Migration, reapplying = false) =>
  `\n  ${m.name} needs pgvector ${tooOldFor(m)} or later; this server's pgvector library is ${pgvectorLibrary}.\n` +
  (reapplying ? pgvectorRemedy("Nothing ran: the re-run is one transaction, and it had not begun.") : PGVECTOR_REMEDY);
// pgvector may be installed into a schema off this connection's search_path —
// how Supabase and several managed providers ship it (upstream #319). There,
// `CREATE EXTENSION IF NOT EXISTS vector` finds it and does nothing, and then
// 001's `vector({{EMBEDDING_DIM}})` fails with `type "vector" does not exist` on
// a database that has pgvector. Put the schema on this session's path before any
// migration runs; it survives into each per-migration transaction below. A no-op
// where `vector` already resolves. This heals the migrating session only — the
// server's own connection is separate, and preflight's `vector extension` check
// names the persistent fix (ALTER ROLE / ALTER DATABASE) for it.
const vectorSchema = await alignVectorSearchPath(sql);
if (vectorSchema) {
  console.log(
    `  pgvector: installed in schema "${vectorSchema}", off this connection's search_path — added to this session so the migrations resolve the vector type`
  );
  console.log(
    `            (if a migration still fails on the vector type, this role lacks USAGE on ${vectorSchema}; the running server needs the path too — preflight's "vector extension" check names both fixes)`
  );
}

let ran = 0;
let reapplied = 0;
let skipped = 0;
let drifted = 0;
let floorBlocked: Migration | null = null;

/**
 * What a failed statement means, beyond its message — read by the plain run's
 * catch and the re-run's alike. Bun exposes the SQLSTATE as `errno`; the
 * message is localised, the code is not. 42602 (invalid_name) on an hnsw.*
 * setting is the reserved-prefix rejection: the loaded library predates the
 * setting, and only a server upgrade helps — the re-run reaches it when the
 * floor probe could not read the library's version. 42501
 * (insufficient_privilege) on an hnsw.* setting is a non-superuser in a session
 * that has not loaded pgvector — 014 loads it first, so this is reachable only
 * from a hand-run statement, but say what it means. 55P03 (lock_not_available)
 * is a lock_timeout — LOCK_TIMEOUT_S, the session's (023's call sets its own
 * for its transaction). 40P01 (deadlock_detected) is the server choosing a victim
 * between two sessions taking the same tables in opposite orders — the
 * re-run's locks and a worker's start, which the banner says to stop first;
 * the victim may be the worker instead, and then this run goes on. What
 * follows a failure differs by mode: a plain run
 * has applied and recorded the files before it; a re-run rolled back whole. A
 * HINT the statement raised with — 030's names --reapply — is printed as it
 * came.
 */
function explainFailure(err: unknown, m: Migration | null, mode: "plain" | "reapply" | "checks"): string[] {
  const message = (err as Error).message;
  const { errno: sqlstate, hint } = err as { errno?: string; hint?: string };
  const lines: string[] = [];
  if (/hnsw\./.test(message) && sqlstate === "42602") {
    lines.push(
      `\n  ${m?.name ?? "the migration"} needs pgvector ${m?.requiresPgvector?.join(".") ?? "0.8.0"} or later, and the loaded library rejected an hnsw.* setting.\n` +
        (mode === "reapply" ? pgvectorRemedy("Nothing ran: the re-run is one transaction, and it rolled back.") : PGVECTOR_REMEDY)
    );
  } else if (/hnsw\./.test(message) && sqlstate === "42501") {
    lines.push(
      `\n  A non-superuser may set hnsw.* settings only after pgvector's library is loaded in the session.\n` +
        `  Run SELECT '[1]'::vector; first in the same session, then the statement that failed.`
    );
  } else if (sqlstate === "40P01") {
    lines.push(
      "  A deadlock: another session took the same tables in the other order while this ran — a worker's enqueue, or a re-embed pass's start,\n" +
        "  against the locks the run takes. Stop the workers and the server, then run again."
    );
  } else if (sqlstate === "55P03") {
    lines.push(
      mode === "reapply"
        ? `  A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout: a session holds one on a table the re-run alters — the server, a worker, or an idle transaction. End it first.`
        : mode === "checks"
          ? `  A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout, on the checks' reads before it: a session holds an exclusive lock on ob1_config — an idle transaction that altered it. End it first.`
          : `  A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout (023's call sets its own for its transaction): a session holds one on a table this migration alters — the server, a worker, or an idle transaction. End it first.`
    );
  }
  if (hint) lines.push(`  ${hint}`);
  return lines;
}

/**
 * A migration that seeds database-level settings does so from a DO block that
 * can only RAISE WARNING when the role does not own the database — and this
 * client surfaces no warnings. So look at the result rather than trust the
 * protocol. Called outside the applying transaction: the migration is applied
 * and recorded by then, and a catalog this role cannot read must not turn that
 * into "FAILED". Read on a first apply and on a re-run alike — a brain adopted
 * with --baseline never had the migrator run 014, so the re-run is the first
 * time it can say the walk bounds are unseeded.
 */
async function reportSeeds(m: Migration): Promise<void> {
  try {
    // "Set" means set where every role sees it: server configuration or the
    // database (SHARED_SETTING_SOURCES, as THIS session resolved them at
    // connect), or the database-level row the migration itself may just have
    // written — which this session, opened before the ALTER DATABASE, does
    // not yet see in pg_settings. A role-level value on the migrating role
    // is neither: it reaches this role alone (tenth review pass). The arrays
    // go through sql.array: a bare `${array}` is sent as comma-joined text,
    // and this whole check silently fell into the catch below on every run
    // until the eleventh review pass ran the migrator and read the output.
    const [row] = await sql`SELECT current_database() AS db`;
    const shared = (await sql`
      SELECT name FROM pg_settings
      WHERE name = ANY(${sql.array(m.seeds, "TEXT")}) AND source = ANY(${sql.array(SHARED_SETTING_SOURCES, "TEXT")})`) as { name: string }[];
    const [dbRow] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
    const dbLevel = parseSetConfig(dbRow?.cfg);
    const missing = m.seeds.filter((name) => !shared.some((r) => r.name === name) && !(name in dbLevel));
    if (missing.length) {
      const statements = missing
        .map((name) => `       ALTER DATABASE ${quoteIdent(row?.db)} SET ${name} = ${(HNSW_SEEDS as Record<string, number>)[name] ?? "<value>"};`)
        .join("\n");
      console.error(
        `  ⚠  ${m.name}  applied, but the database-level HNSW walk bounds were not seeded (${missing.join(", ")}) —\n` +
          `     the migrating role does not own the database, or the platform refused ALTER DATABASE. Run as the owner, in one session:\n` +
          `       SELECT '[1]'::vector;   -- loads pgvector so a non-superuser may set hnsw.* settings\n` +
          `${statements}\n` +
          `     Until then a broad filter's walk runs with pgvector's defaults, which return short on large tables; preflight warns about it.`
      );
    }
  } catch (e) {
    console.error(`  ⚠  ${m.name}  applied; could not read pg_settings to confirm the walk bounds (${(e as Error).message}). Preflight checks them at startup.`);
  }
}

/**
 * Run one migration's SQL in the caller's transaction — and 021's with the
 * operator's acceptances out of its sight (SMD-1421). 021's evidence backfill
 * labels an unlabelled thought from its latest succeeded claim row under a key
 * naming a model, when nothing has written the thought since the row finished;
 * the file is hashed and applied as written, from before SMD-1067 made an
 * operator's ACCEPTANCE of a failure a succeeded row — a thought that kept the
 * vector it had, by decision NOT at that key's model. Migration 030 takes such
 * a label back where it can tell it from the server's own (an acceptance under
 * the model's own key, and nothing written since the row's enqueue) and labels
 * the rest with accepted rows excluded — but 030 is a file too, applied once
 * and hashed, and cannot know which labels 021's block wrote a moment ago.
 *
 * The fix is at the block's INPUT, not its output. Before 021 runs, a TEMP
 * VIEW named thought_work_claims is created over the real table without the
 * accepted rows (ACCEPTED_CLAIM_SQL, the predicate 030's evidence rows carry)
 * — a view, not a copy: one catalog row, no rows materialised, and the block
 * reads the claim rows as they stand when it runs, through the filter, so no
 * window opens between a copy and the block. An unqualified name
 * resolves in pg_temp before any schema on the search_path, and 021's block is
 * a DO block, resolved when it runs — so it reads the view, and labels from
 * the latest row that is NOT an acceptance, or not at all: 030's rule, by
 * 021's own text, with no second spelling and nothing wrong ever written. The
 * view is dropped right after the file, in the same transaction (a failure
 * rolls it back with everything else), so 022 onward — 029's function, 030's
 * block — read the real table again. pg_temp is searched first for
 * relations exactly when the path does NOT list it: listed, it is searched
 * where listed, and listed first it is also where CREATE puts things,
 * functions included — 021's update_thought landed there and vanished with the
 * transaction when the fifth review pass tried naming it first — so a role's
 * path is set, for the transaction, to itself without pg_temp (read as
 * Postgres reads it, rebuilt quoted: setPathWithoutTemp, SMD-2247) — a
 * no-op where it is absent, and not restored: unlisted, pg_temp is still searched first and is never a
 * creation target, so nothing after 021 differs — and that the name resolves
 * to the view is checked before the file runs,
 * and the file is refused if not. Creation targets are then unaffected: 021's
 * column and functions go where they went. The view takes ACCESS SHARE on the
 * claim table when the block reads it, as 021's block did, and nothing on
 * thoughts before 021's own ADD COLUMN — no lock the file alone never took,
 * and no order a worker's enqueue inverts. Needs TEMP on the database (023's
 * backfill call does too), judged before any SQL runs. Where the claim table
 * is missing, the file runs bare and fails on it as it always did; where a
 * temp relation of that name already exists on the connection — a pooled
 * connection handed over with one — the file is refused, since the block
 * would read it (asked of pg_temp by name, whatever the search_path). The view
 * projects the four columns the block reads. The tie 030 breaks by key is
 * 021's unnamed pick here, and a label from before
 * 021 that 030's first statement would take back — a paste of the body over an
 * acceptance — waits for 030's own run, which on a hole at 021 alone is the
 * re-run.
 *
 * Reports how many thoughts the block labelled — the rows its one UPDATE of
 * thoughts touched, read from the transaction's own statistics
 * (pg_stat_xact_user_tables, before and after; "not counted" where
 * track_counts is off), so nothing here reads thoughts and no lock is taken on
 * it before the file's own — since the label is not an edit and nothing else
 * records the write. Returns the line to print beside the file, null for any
 * other file. What this replaced — a gate that refused the run on the rows 021
 * would label and 030 would leave (SMD-1193), then four shapes of a bracket
 * around 021's output — and why, is FORK.md changes 56 and 60; 030's header,
 * hashed, still describes the gate.
 */
async function applyShadowed(tx: SQL, m: Migration): Promise<string | null> {
  if (m.name !== FILE_021) {
    await tx.unsafe(m.sql);
    return null;
  }
  // Catalog reads only: no lock on thoughts before the file's own ADD COLUMN.
  const [{ nsp, stale, counted }] = (await tx`
    SELECT (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('thought_work_claims')) AS nsp,
           to_regclass('pg_temp.thought_work_claims') IS NOT NULL AS stale,
           current_setting('track_counts') = 'on' AS counted`) as { nsp: string | null; stale: boolean; counted: boolean }[];
  if (stale) {
    // Not ours: nothing here creates one before this point, and a pooled
    // connection handed over with one is not a state to read the block from.
    throw new Error("a temp relation named thought_work_claims already exists on this connection; 021's backfill would read it in place of the claim table. Drop it and run again");
  }
  if (nsp === null) {
    await tx.unsafe(m.sql);
    return null;
  }
  // The rows 021's one UPDATE of thoughts touches, from the transaction's own
  // statistics: O(1), visible before commit, and no read of thoughts.
  const updated = async () => Number(((await tx`SELECT n_tup_upd AS n FROM pg_stat_xact_user_tables WHERE relid = to_regclass('thoughts')`) as { n: number }[])[0]?.n ?? 0);
  const before = await updated();
  // The four columns the block reads (021:214-217), over the source named by
  // its schema — once the view exists, an unqualified name is the view.
  await tx.unsafe(
    `CREATE TEMP VIEW thought_work_claims AS SELECT c.thought_id, c.work_type, c.status, c.finished_at FROM ${quoteIdent(nsp)}.thought_work_claims c WHERE NOT ${ACCEPTED_CLAIM_SQL}`
  );
  // pg_temp first for relations exactly when unlisted: the path, for the
  // transaction, without it — a no-op where it is absent, never added first
  // (see above), not restored (nothing after 021 differs).
  const path = await setPathWithoutTemp(tx);
  const [{ shadowed }] = (await tx`SELECT to_regclass('thought_work_claims') = 'pg_temp.thought_work_claims'::regclass AS shadowed`) as { shadowed: boolean }[];
  if (!shadowed) {
    throw new Error(`the view of thought_work_claims without the acceptances does not shadow the table for 021 (search_path: ${path}); its backfill would have read them`);
  }
  await tx.unsafe(m.sql);
  await tx.unsafe("DROP VIEW pg_temp.thought_work_claims");
  // At zero too: a silent 021 is also what a claim table not found, or an
  // older migrator, prints. The label is not an edit, and nothing else
  // records the write.
  return counted
    ? `  ·  021's evidence backfill labelled ${(await updated()) - before} thought(s) from the claim rows, the operator's acceptances out of its sight`
    : "  ·  021's evidence backfill ran with the operator's acceptances out of its sight; what it labelled is not counted (track_counts is off)";
}

// ── Judged before any SQL runs ──────────────────────────────────────────────
// Every refusal, in one list with one tail — both modes, "would refuse" under
// --dry-run — so a green dry run is never followed by a red run and every
// refusal is reported, not the first. What 021's shadow needs: a temp table,
// which a hardened database may deny the role (023's backfill call needs one
// too, and orders after 021, so a fresh upgrade meets the need here first).
// Then the re-run's own judgements, below.
const refusals: { code: number; text: string }[] = [];
const shadows021 = !baseline && (reapply || !applied.has(FILE_021));
if (shadows021) {
  const [{ temp }] = (await sql`SELECT has_database_privilege(current_database(), 'TEMP') AS temp`) as { temp: boolean }[];
  if (!temp) {
    const [{ db, role }] = (await sql`SELECT current_database() AS db, current_user AS role`) as { db: string; role: string }[];
    refusals.push({
      code: 2,
      text:
        `this role may not create a temp relation, and 021's evidence backfill needs one — a view of the claim table without the operator's acceptances,\n` +
        `  for that file to read — as 023's backfill call does. GRANT TEMPORARY ON DATABASE ${quoteIdent(db)} TO ${quoteIdent(role)}; then run again.`,
    });
  }
}

// ── The re-run, one transaction ─────────────────────────────────────────────
// Every migration — recorded or pending — in order, in ONE transaction: a
// failure part-way would otherwise leave the files before it at their own
// definitions while a later file's redefinition of the same objects — 022's and
// 025's, 033's and 035's of 021's upsert_thought; 020's drop of the 4-argument match_thoughts
// that 014 and 019 recreate — was not yet restored, with nothing in the catalog
// to say so; and a pending file left for the loop would apply AFTER the re-run,
// over what it restored. All or nothing, and the output says which. Judged
// before BEGIN, into the one list above: the drift, the pgvector floor, and
// the two things 006 would do inside the transaction from a shell configured
// differently from the brain — refuse the column's width, or re-record
// ob1_config's model (its INSERT … ON CONFLICT DO UPDATE, run again).
// The session's lock_timeout (LOCK_TIMEOUT_S) bounds every wait, so an idle session holding a
// lock on thoughts fails the re-run at once rather than freezing every reader
// behind 001's ACCESS EXCLUSIVE for ever — the banner says to stop the writers
// first. The seeds check runs after the commit for every file that seeds, as on
// a first apply. 021's evidence backfill runs as written, the acceptances out
// of its sight (applyShadowed), as on a plain run.
if (reapply) {
  const changed = migrations.filter((m) => reapplies(m) && applied.get(m.name) !== m.sha);
  if (changed.length > 0) {
    refusals.push({
      code: 1,
      text:
        `${changed.map((m) => `${m.name} (was ${applied.get(m.name)}, now ${m.sha})`).join(", ")} changed after being applied.\n` +
        "  Migrations are append-only. If the edit was intentional and the database already reflects it, update schema_migrations.sha256 by hand, then re-run.",
    });
  }
  const floor = migrations.find((m) => tooOldFor(m));
  if (floor) refusals.push({ code: 1, text: `${floor.name} would fail on the pgvector floor.` + floorMessage(floor, true) });
  // The catalog, read by relation (to_regclass) rather than by name in
  // information_schema, which sees a `thoughts` in any schema the role can
  // read. Both reads are guarded: a role without SELECT on ob1_config is a
  // refusal that names the error, not a stack trace with the connection open.
  let probe: { has_config: boolean; width: number | null };
  let record: Record<string, string> = {};
  try {
    // The read of ob1_config takes ACCESS SHARE; behind a session holding
    // ACCESS EXCLUSIVE on it, it waits — the session's lock_timeout bounds it.
    [probe] = (await sql`
      SELECT to_regclass('ob1_config') IS NOT NULL AS has_config,
             (SELECT atttypmod FROM pg_attribute WHERE attrelid = to_regclass('thoughts') AND attname = 'embedding' AND NOT attisdropped) AS width`) as
      { has_config: boolean; width: number | null }[];
    if (probe.has_config) {
      const rows = (await sql`SELECT key, value::text AS value FROM ob1_config WHERE key IN ('embedding_model')`) as { key: string; value: string }[];
      record = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }
  } catch (err) {
    console.error(`  ✗  --reapply  could not be judged: ${(err as Error).message}`);
    for (const line of explainFailure(err, null, "checks")) console.error(line);
    console.error("  The checks before the run read pg_attribute and ob1_config; this role could not, or was made to wait. Nothing was written.");
    await sql.close();
    process.exit(1);
  }
  const { has_config, width } = probe;
  // The column is the width's authority (ob1_config's copy can be edited by
  // hand); 006 refuses a shell whose width differs from it — inside the
  // transaction, after a dry run had said green. Judged here, both modes.
  if (width !== null && Number(width) <= 0) {
    // pgvector allows a bare `vector` column (atttypmod -1); 006 requires the
    // declared width, so the re-run would refuse inside the transaction.
    refusals.push({
      code: 2,
      text:
        "thoughts.embedding declares no width (a bare vector column) and 006 requires vector(OB1_EMBEDDING_DIM), so the re-run would\n" +
        `  refuse inside the transaction. Declare it first — ALTER TABLE thoughts ALTER COLUMN embedding TYPE vector(${SUBSTITUTIONS.EMBEDDING_DIM}); — with\n` +
        "  every stored vector at that width.",
    });
  } else if (width !== null && Number(width) !== Number(SUBSTITUTIONS.EMBEDDING_DIM)) {
    refusals.push({
      code: 2,
      text:
        `thoughts.embedding is vector(${width}) and this shell says OB1_EMBEDDING_DIM=${SUBSTITUTIONS.EMBEDDING_DIM} — 006 would refuse the mismatch inside\n` +
        `  the transaction. Set OB1_EMBEDDING_DIM=${width}; changing the width is a re-embed of every row, not a re-run.`,
    });
  }
  // The record 006 would write again from this shell. The model only: the
  // width is the column's (above), and 013's chunk_context IS "what was
  // configured when the schema was last migrated" — a flag the operator may
  // flip between runs by 013's own header, so re-recording it is the update,
  // not a change to refuse.
  if (has_config && "embedding_model" in record && record.embedding_model !== SUBSTITUTIONS.EMBEDDING_MODEL) {
    refusals.push({
      code: 2,
      text:
        `ob1_config records embedding_model = ${record.embedding_model} and this shell would re-record it as ${SUBSTITUTIONS.EMBEDDING_MODEL} —\n` +
        "  006 writes its INSERT … ON CONFLICT DO UPDATE again on a re-run, and every reader of the record would follow the shell.\n" +
        "  Run from a shell configured as the brain is (OB1_EMBEDDING_MODEL), or change the record on purpose with\n" +
        "  reembed.ts --switch-model, which moves the corpus with it.",
    });
  }
}
if (refusals.length) {
  for (const r of refusals) console.error(`\n  ${dryRun ? "would refuse" : "refusing"} ${reapply ? "--reapply" : `to apply ${FILE_021}`}: ${r.text}`);
  console.error(`\n  Nothing was written.`);
  await sql.close();
  process.exit(Math.max(...refusals.map((r) => r.code)));
}
// Announced only once nothing refuses: a banner before a refusal read as a
// run that never began.
if (reapply) {
  const recorded = migrations.filter(reapplies).length;
  console.log(
    `  ${dryRun ? "would re-apply" : "re-applying"} every migration (${recorded} recorded, ${migrations.length - recorded} pending), in order, in one transaction with a ${LOCK_TIMEOUT_S} s lock timeout —\n` +
      "  recorded rows stay as they are, pending ones are recorded. Stop the server and any re-embed or extraction worker first:\n" +
      "  001 and 003 take ACCESS EXCLUSIVE locks on thoughts, 011 builds the trigram index if OB1_TRGM_INDEX is on and it is absent,\n" +
      "  023's and 050's backfill calls take thoughts EXCLUSIVE, 055's locks the audit rows it fills (OB1_BACKFILL_LIMIT bounds each, as on a first apply),\n" +
      "  025 re-validates its constraints, 055 builds its partial index on thought_audit after its pass (SHARE, tens of milliseconds),\n" +
      "  060 seeds the vector snapshot from thoughts (a read; ON CONFLICT DO NOTHING on a re-apply),\n" +
      "  061 backfills the lineage table from the proposals, the mentions and edges, the chunks and the vectors (reads; ON CONFLICT DO NOTHING on a re-apply)."
  );
}

if (reapply && !dryRun) {
  // An object, not a `let`: an assignment inside the callback is invisible to
  // the type checker's flow analysis, which would narrow a `let` to null.
  const progress: { current: Migration | null } = { current: null };
  /** What a file said beside its line, by name — 021's, with the acceptances out of its sight. */
  const notes = new Map<string, string>();
  try {
    await begin(async (tx: SQL) => {
      for (const m of migrations) {
        progress.current = m;
        const note = await applyShadowed(tx, m);
        if (note !== null) notes.set(m.name, note);
        if (!applied.has(m.name)) await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
      }
    });
  } catch (err) {
    console.error(`  ✗  ${progress.current?.name ?? "--reapply"}  FAILED: ${(err as Error).message}`);
    for (const line of explainFailure(err, progress.current, "reapply")) console.error(line);
    console.error(
      "  The re-run is one transaction: it rolled back, nothing was re-applied or applied, and the schema is as it was.\n" +
        "  Fix the cause and run --reapply again."
    );
    await sql.close();
    process.exit(1);
  }
  for (const m of migrations) {
    const again = applied.has(m.name);
    console.log(`  ✓  ${m.name}  ${again ? "re-applied" : "applied"}`);
    if (notes.has(m.name)) console.log(notes.get(m.name));
    if (again) reapplied++;
    else ran++;
  }
  for (const m of migrations) if (m.seeds.length) await reportSeeds(m);
}

// --dry-run names the release each pending migration belongs to (SMD-1804);
// read the manifest once here rather than per file, and only when it is used, so
// a plain run never fails on a malformed releases.json.
const releases = dryRun ? readReleases() : [];

// Under a live --reapply every file ran above; this loop is the plain run's and --dry-run's.
for (const m of reapply && !dryRun ? [] : migrations) {
  const prior = applied.get(m.name);

  if (prior && prior !== m.sha) {
    // The file changed after being applied. Do not silently re-run it — that is
    // how a "working" migration set stops matching the database it produced.
    console.error(`  ⚠  ${m.name}  ALREADY APPLIED BUT FILE CHANGED (was ${prior}, now ${m.sha})`);
    drifted++;
    continue;
  }
  if (prior && !reapplies(m)) {
    console.log(`  ·  ${m.name}  already applied`);
    skipped++;
    continue;
  }
  if (dryRun) {
    // The plain run's judgement. A recorded file under --reapply reaches here
    // too — as "would re-apply" — but never with a floor: the checks above
    // refuse the whole re-run on one before this loop runs.
    if (tooOldFor(m)) {
      console.log(`  ✗  ${m.name}  would FAIL: pgvector ${pgvectorLibrary} < ${tooOldFor(m)}`);
      floorBlocked ??= m;
      continue;
    }
    // The live run exits at the first refusal, so nothing after it applies;
    // saying "would apply" for those would promise what the run cannot do.
    if (floorBlocked) {
      console.log(`  ·  ${m.name}  blocked behind ${floorBlocked.name}`);
      continue;
    }
    const version = versionForMigration(Number(m.name.slice(0, 3)), releases) ?? "Unreleased";
    console.log(`  →  ${m.name}  would ${prior ? "re-apply" : "apply"} (${m.sha}) · ${version}`);
    if (prior) reapplied++;
    else ran++;
    continue;
  }
  if (baseline) {
    await sql`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
    console.log(`  ✓  ${m.name}  marked applied without running (--baseline)`);
    ran++;
    continue;
  }

  // The version floor, enforced only where it bites: earlier pending migrations
  // have already applied above, and --baseline never reaches here.
  if (tooOldFor(m)) {
    console.error(`  ✗  ${m.name}  refused` + floorMessage(m));
    await sql.close();
    process.exit(1);
  }

  // 039 builds two HNSW graphs over every vector the brain holds, in the
  // session's maintenance_work_mem — 64 MB unless the operator sized it (its
  // header has the rule: 2.5 KB a vector at 1,024 dimensions) — and prints
  // nothing while it runs. Say what it is about to do, and with what, so the
  // two can be compared before the wait rather than after it.
  if (m.name.startsWith("039_")) {
    // The larger of the planner's count and the statistics collector's: a
    // restored or bulk-loaded brain that autovacuum has not analysed reports
    // reltuples -1 or a stale figure, and that is the brain this line is for.
    const count = (rel: string) => `GREATEST(COALESCE((SELECT c.reltuples FROM pg_class c WHERE c.oid = to_regclass('${rel}')), 0), COALESCE((SELECT s.n_live_tup FROM pg_stat_user_tables s WHERE s.relid = to_regclass('${rel}')), 0), 0)::bigint`;
    const [r] = await sql.unsafe(`
      SELECT ${count("thoughts")} AS t, ${count("thought_chunks")} AS c,
             current_setting('maintenance_work_mem') AS mem,
             current_setting('max_parallel_maintenance_workers') AS workers`);
    const perVector = (2 * EMBEDDING_DIM + 450) / 1024; // a halfvec element and its neighbour lists, about
    console.log(`  …  ${m.name}  builds two HNSW indexes over about ${(Number(r.t) + Number(r.c)).toLocaleString()} vectors (thoughts ${Number(r.t).toLocaleString()}, windows ${Number(r.c).toLocaleString()}) under maintenance_work_mem = ${r.mem} with ${r.workers} parallel workers — the graph wants about ${perVector.toFixed(1)} KB a vector at ${EMBEDDING_DIM} dimensions, ${Math.ceil(((Number(r.t) + Number(r.c)) * perVector) / 1024)} MB here (the file's header)`);
  }

  // Each migration runs in its own transaction: a failure leaves earlier ones
  // applied and recorded, so a rerun resumes rather than starting over.
  try {
    const note = await begin(async (tx: SQL) => {
      const n = await applyShadowed(tx, m);
      await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
      return n;
    });
    console.log(`  ✓  ${m.name}  applied`);
    if (note !== null) console.log(note);
    ran++;
  } catch (err) {
    console.error(`  ✗  ${m.name}  FAILED: ${(err as Error).message}`);
    for (const line of explainFailure(err, m, "plain")) console.error(line);
    await sql.close();
    process.exit(1);
  }

  if (m.seeds.length) await reportSeeds(m);
}

await sql.close();

const verb = dryRun ? "would apply" : baseline ? "baselined" : "applied";
console.log(`\n${verb} ${ran}${reapplied ? `, ${dryRun ? "would re-apply" : "re-applied"} ${reapplied}` : ""}, skipped ${skipped}${drifted ? `, DRIFTED ${drifted}` : ""}`);

// Both conditions can hold in one --dry-run (the live path exits inside the
// loop). Say everything before exiting: a floor message that hid the drift
// remedy sent the operator to upgrade pgvector and back here for the sha.
if (floorBlocked) console.error(floorMessage(floorBlocked));
if (drifted > 0) {
  console.error(
    "\nA migration file changed after it was applied. Migrations are append-only:\n" +
      "add a new file rather than editing an old one. If the edit was intentional and\n" +
      "the database already reflects it, update schema_migrations.sha256 by hand."
  );
}
if (floorBlocked || drifted > 0) process.exit(1);
