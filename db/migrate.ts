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
 *   bun db/migrate.ts --reapply        # re-run every migration, recorded or not, in one transaction
 *   await run({ url, dryRun: true })   # the same, in-process: import { run } from "./migrate.ts" (SMD-2304)
 *
 * Applied migrations are recorded in schema_migrations, so re-running is a no-op.
 * Every migration is also individually idempotent, so a schema applied without
 * the migrator, which has no ledger yet, is brought under it by --reapply:
 * every file runs again over what is there, in one transaction, after the
 * checks that this shell agrees with the brain, and is recorded. A plain run
 * there is refused, --dry-run too, naming --reapply: it would give each file
 * its own transaction and check nothing first (SMD-3425). Recording the
 * ledger without running the files was retired (SMD-3325).
 *
 * --reapply re-runs EVERY migration — recorded or pending — in order, in ONE
 * transaction with a lock timeout (LOCK_TIMEOUT_S); recorded rows stay as they are, pending
 * ones are recorded in the same transaction. It is the remedy for a database
 * whose schema is older than its ledger says — a body removed or replaced from
 * outside the migrations — and for a schema with no ledger at all; reembed.ts
 * and preflight name the command where they find either. Every file,
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
 *
 * A run takes a session advisory lock, MIGRATE_LOCK (config.mjs), before it
 * writes anything, and holds it until it returns (SMD-3379): a pending file or
 * --reapply, judged from a read of the ledger before the ledger is made, so a
 * run refused there writes nothing; and, where the core had nothing to apply,
 * before each repair write later on — a plugin's ledger, login role, role,
 * schema, grant, hand-back or file, and 096's re-run. The ledger is read again
 * under the lock, so a run that took it after another let it go applies only
 * what that one left. A second run while one holds it is refused by name,
 * exit 2, naming the holding backend; before, the two raced on the ledger's
 * rows and the catalog's, and one failed at once on a duplicate key.
 * --dry-run, --grant and a run with nothing to write take no lock: the sleep
 * scheduler is to read it to stop its passes (SMD-3379 PR 1c), and a no-op run
 * on every `compose up` must not stop them.
 */

import type { SQL } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTED_CLAIM_SQL,
  LOCK_TIMEOUT_S,
  REAPPLY_COMMAND,
  PUBLIC_THOUGHTS_EXISTS,
  PLUGIN_LOGIN_ROLE,
  PLUGIN_NAME_RE,
  alignVectorSearchPath,
  pinPublicFirst,
  pluginForeignOwned,
  pluginIdents,
  pluginLoginUrl,
  migrationNameProblem,
  DB_LEVEL_SETTINGS_SQL,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HNSW_SEEDS,
  ROLE_GRANT_GROUPS,
  RETIRED_GRANT_GROUPS,
  GRANT_LOCK,
  MIGRATE_LOCK,
  MIGRATE_LOCK_HOLDER_SQL,
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
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
/** The plugins (SMD-2310): beside db/ in a checkout, and beside the migrator's /app in its image. */
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");

/**
 * What one migrator run is asked to do — the CLI's flags, typed (SMD-2304).
 * `sql`, when given, is the caller's client — used in place of `url`, and never
 * closed here. It must be a single connection, opened with the `max: 1`
 * option: the run sets session state that must hold on the connection its
 * statements run on, and leaves it there — lock_timeout, pgvector's schema on
 * search_path when it is off the path, the `ob1.acl_*` settings several
 * migrations set, and `application_name` `ob1-migrate` once the run asks for its
 * lock (SMD-3379). So pass a client dedicated to the run (the CLI passes its
 * own), not a connection a pool will hand to someone else after — and not a
 * transaction's handle, which the check passes but whose migrations then fail
 * on their own BEGIN. Without `sql`, the run opens one connection on `url` and
 * closes it. An absent option may also be null.
 */
export interface MigrateOptions {
  url?: string;
  sql?: SQL;
  dryRun?: boolean;
  reapply?: boolean;
  /** Retired with --force (SMD-3325): refused by name, nothing changed. */
  baseline?: boolean;
  /** Retired with --baseline (SMD-3325): refused by name, nothing changed. */
  force?: boolean;
  /** --grant <role>: issue the capturing-role privileges instead of migrating. */
  grant?: string;
  /** With grant: a comma-separated list of ROLE_GRANT_GROUPS to grant alone (SMD-2289). */
  groups?: string;
  /** With grant: revoke what else the role holds here, in the grant's transaction (SMD-2289). */
  exact?: boolean;
  /**
   * OB1_PLUGINS's value (SMD-2310): the plugins whose migrations a plain run
   * applies, after the core's, each in its own schema as its own role, into
   * the plugin_migrations ledger. A plugin not named is not read.
   */
  plugins?: string | null;
  /** Where plugins live; the tree's plugins/ unless a suite names another. */
  pluginsDir?: string;
  /**
   * OB1_PLUGIN_DB_PASSWORD (SMD-2310): the password of the login role plugin
   * migrations run on (PLUGIN_LOGIN_ROLE), which a run makes with it when the
   * role is missing. Required by a plain run that names a plugin with
   * migrations, with `url` — the plugin phase opens its own connection as
   * that role, beside `sql`.
   */
  pluginPassword?: string | null;
  writer?: Writer;
}

/**
 * The migrator, callable: the CLI's run, returning the exit code the CLI
 * exits with — 0 applied or nothing to do, 1 a failure, a drift or the pgvector
 * floor, 2 a refusal. Nothing happens at import; the migration files are read
 * here, per call, so a caller sees the tree as it is when it runs. The
 * embedding model, width, trigram choice and chunk-context flag are
 * config.mjs's, read from the environment when that module was first
 * imported — setting OB1_CHUNK_CONTEXT after the import does not change what
 * 013 records, nor what --reapply compares with it. A database error outside
 * a migration's own transaction — the ledger's CREATE TABLE refused, say —
 * rejects, as the CLI's stack dump always showed; run()'s own connection is
 * closed first.
 */
export async function run(opts: MigrateOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const retired = retiredFlagRefusal(opts.baseline, opts.force);
  if (retired) {
    err(retired);
    return 2;
  }
  if (opts.sql == null) {
    // databaseUrl's two refusals without its exit: none (absent, null or
    // blank), then connect.ts's rule for the URL itself.
    const problem = opts.url == null || opts.url.trim() === "" ? NO_DATABASE_URL : databaseUrlProblem(opts.url);
    if (problem !== null) {
      err(problem);
      return 2;
    }
  } else if (Number((opts.sql as { options?: { max?: number } }).options?.max ?? 1) !== 1) {
    err("migrate.ts needs a single connection: the run sets session state (lock_timeout, search_path) that must hold where its statements run. Pass a client opened with the max: 1 option (not ?max= in the URL), or a URL.");
    return 2;
  }
  const sql = opts.sql ?? openSql(opts.url as string);
  const lock = { held: false };
  try {
    return await migrateWith(sql, opts, out, err, lock);
  } finally {
    // The run's lock goes with it, however it ends: a caller's own connection
    // lives on past the run (test-live's), and would hold it for the session.
    // A failing unlock or close must not mask the run's own error.
    if (lock.held) await sql`SELECT pg_advisory_unlock(hashtext(${MIGRATE_LOCK}))`.catch(() => {});
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/**
 * Put public first on `conn`'s path for this run (pinPublicFirst, config.mjs),
 * or write the refusal and return false — the caller returns 2, and the
 * connection is closed by whoever opened it. --grant's statements are
 * unqualified too, so it runs this before them, as the run does before its
 * ledger; `grant` words the refusal for it. A brain in another schema is
 * refused in words, not with statements to run: moving one into public is
 * the operator's, who knows what else public holds (SMD-2247, second review
 * pass: a printed schema rename moved another app out of public).
 */
async function publicFirst(conn: SQL, out: Writer["out"], err: Writer["err"], grant = false): Promise<boolean> {
  const pinned = await pinPublicFirst(conn);
  if (pinned.refused === "ledger") {
    const other = quoteIdent(pinned.schema);
    const named = pinned.viaUser ? ` (the path's "$user")` : "";
    err(
      `Refused: this connection's search_path reaches a brain in schema ${other}${named} — this migrator's ledger — and public holds no brain of its own (a ledger beside thoughts).\n` +
        (grant
          ? "  --grant grants on the brain's objects in public, and there are none there.\n"
          : "  This migrator builds in public, where preflight looks; run on, it would start a second brain there.\n") +
        `  If ${other} is another brain, take ${other} off this connection's search_path. If it is this brain, built in ${other} by a path that put it first,\n` +
        "  it has to move into public before the migrator can go on: a move by hand, as the owner of both schemas, minding whatever else public holds. Nothing was changed."
    );
    return false;
  }
  if (pinned.refused === "public") {
    err(
      pinned.missing
        ? grant
          ? "Refused: this database has no schema named public, where --grant grants on the brain's objects, so there are none to grant on.\n" +
            "  CREATE SCHEMA public;  as the database's owner, apply the migrations, then run --grant. Nothing was changed."
          : "Refused: this database has no schema named public, and this migrator builds the brain there.\n" +
            "  CREATE SCHEMA public;  as the database's owner, then run again. Nothing was changed."
        : grant
        ? `Refused: role ${pinned.role} has no USAGE on schema public, so Postgres leaves public off its search_path, and --grant grants on the brain's objects there.\n` +
            "  Run --grant as the objects' owner — the role that ran the migrations — or a superuser. Nothing was changed."
        : `Refused: role ${pinned.role} has no USAGE on schema public, so Postgres leaves public off its search_path, and this migrator builds the brain there.\n` +
            `  Run the migrator as the database's owner, ${pinned.owner}, or a role that is a member of it. To build as ${pinned.role} instead, as the schema's owner:\n` +
            `    GRANT USAGE, CREATE ON SCHEMA public TO ${pinned.role};\n` +
            "  Either way, 001's vector needs a superuser unless it is installed, and 011's pg_trgm needs CREATE on the database, which its owner has;\n" +
            "  096's pg_stat_statements needs a superuser too, and is left out without one. Nothing was changed."
    );
    return false;
  }
  if (pinned.was !== null) {
    out(
      `  search_path: public put first for this run only (it was ${pinned.was === "" || pinned.was === '""' ? "empty" : pinned.was}); ` +
        "the server's connection keeps its own path, and preflight's schema row names the fix where that does not reach public.thoughts"
    );
  }
  return true;
}

/** A refusal inside --grant's transaction: exit 2, nothing committed. */
class GrantRefusal extends Error {}
/** Thrown to roll a --dry-run's transaction back. */
class RolledBack extends Error {}
/** A 42501 from a GRANT is the grantor's: it holds nothing on the object, so it cannot grant it. */
const grantorHint = "This connection's role may not grant that object: connect as its owner (the role that ran the migrations or applied the community schema) or a superuser.";

/**
 * --exact's revokes, one per object whose ACL names the role (review pass 4:
 * a blanket REVOKE over every schema rewrote every ACL in the brain, took
 * schema USAGE that --grant never gives back, and fails outright for a
 * grantor that is not a superuser): a table, view or foreign table with a
 * grant to it (a column's included), a sequence, a routine (procedures and
 * aggregates with the functions), CREATE on a schema, CREATE on this database.
 * Schema USAGE and CONNECT and TEMP on the database stay: an operator may have
 * granted USAGE on pgvector's own schema, or CONNECT to a hardened brain.
 */
async function exactRevokes(sql: any, role: string): Promise<string[]> {
  const rows = (await sql`
    WITH me AS (SELECT oid FROM pg_roles WHERE rolname = ${role})
    SELECT stmt FROM (
      SELECT 1 AS ord, format('REVOKE ALL ON TABLE %s FROM %I;', c.oid::regclass, ${role}::text) AS stmt
        FROM pg_class c, me
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = me.oid)
           OR EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid = c.oid AND a.grantee = me.oid))
      UNION ALL
      SELECT 1, format('REVOKE ALL ON SEQUENCE %s FROM %I;', c.oid::regclass, ${role}::text)
        FROM pg_class c, me
       WHERE c.relkind = 'S' AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = me.oid)
      UNION ALL
      SELECT 1, format('REVOKE ALL ON ROUTINE %s FROM %I;', p.oid::regprocedure, ${role}::text)
        FROM pg_proc p, me
       WHERE EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = me.oid)
      UNION ALL
      SELECT 2, format('REVOKE CREATE ON SCHEMA %I FROM %I;', n.nspname, ${role}::text)
        FROM pg_namespace n, me
       WHERE EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = me.oid AND a.privilege_type = 'CREATE')
      UNION ALL
      SELECT 2, format('REVOKE CREATE ON DATABASE %I FROM %I;', d.datname, ${role}::text)
        FROM pg_database d, me
       WHERE d.datname = current_database() AND EXISTS (SELECT 1 FROM aclexplode(d.datacl) a WHERE a.grantee = me.oid AND a.privilege_type = 'CREATE')
    ) s ORDER BY ord, stmt`) as { stmt: string }[];
  return rows.map((r) => r.stmt);
}

/**
 * What the role holds that --exact's revokes did not reach, named: a
 * privilege row pg_shdepend keeps for it anywhere (a default privilege naming
 * it, another database's objects, a type, a parameter, a large object, one
 * made by a grantor other than the object's owner) but its USAGE on this
 * database's schemas and CONNECT or TEMP on this database; CREATE on any
 * schema; and any other privilege on this database, whoever granted it
 * (review pass 4: a non-owner's CREATE on the database survived, and the run
 * said "nothing else").
 */
async function heldBeyond(sql: any, role: string): Promise<string[]> {
  const rows = (await sql`
    WITH me AS (SELECT oid FROM pg_roles WHERE rolname = ${role}),
         here AS (SELECT oid FROM pg_database WHERE datname = current_database())
    SELECT what, n FROM (
      SELECT format('%s in %s (%s)', count(*), d.classid::regclass,
                    CASE WHEN d.dbid = 0 THEN 'the cluster' ELSE coalesce(db.datname, d.dbid::text) END) AS what, count(*) AS n
        FROM pg_shdepend d LEFT JOIN pg_database db ON db.oid = d.dbid, me, here
       WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'a' AND d.refobjid = me.oid
         AND NOT (d.classid = 'pg_database'::regclass AND d.objid = here.oid)
         AND NOT (d.classid = 'pg_namespace'::regclass AND d.dbid = here.oid)
       GROUP BY d.classid, d.dbid, db.datname
      UNION ALL
      SELECT format('CREATE on schema %I', n.nspname), 1
        FROM pg_namespace n, me WHERE EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = me.oid AND a.privilege_type = 'CREATE')
      UNION ALL
      SELECT format('%s on this database', a.privilege_type), 1
        FROM pg_database d, aclexplode(d.datacl) a, me
       WHERE d.datname = current_database() AND a.grantee = me.oid AND a.privilege_type NOT IN ('CONNECT', 'TEMPORARY')
    ) s ORDER BY 1`) as { what: string }[];
  return rows.map((r) => r.what);
}

/**
 * A role --exact cannot make hold only the groups': a member of another role
 * holds that role's privileges, which no revoke here reaches, and an owner's
 * rights are its ownership, not an ACL entry, so a revoke would strip the
 * owner's own privileges on its tables and leave it able to grant them back
 * (review pass 5: both ran and said "nothing else"). The same two refusals as
 * db/login-role.ts, here so --exact alone keeps its word.
 */
async function exactRoleRefusal(tx: any, role: string): Promise<string | null> {
  const memberOf = ((await tx`SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ${role} ORDER BY 1`) as { rolname: string }[]).map((r) => r.rolname);
  if (memberOf.length) return `--exact: ${role} is a member of ${memberOf.join(", ")}, whose privileges it holds and no revoke here reaches. Revoke the membership, or name another role. Nothing changed.`;
  const [{ owned }] = (await tx`SELECT count(*)::int AS owned FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o' AND r.rolname = ${role}`) as { owned: number }[];
  if (owned > 0) return `--exact: ${role} owns ${owned} object(s) (a relation, schema, function, type, large object, user mapping or database), here or in another database; an owner's rights are not a grant to revoke. Name a role that owns nothing. Nothing changed.`;
  return null;
}

/** --exact's work inside a transaction: the role checked, the revokes, then what is left refused. Returns the revokes it ran. */
async function exactTransaction(tx: any, role: string): Promise<string[]> {
  const refusal = await exactRoleRefusal(tx, role);
  if (refusal) throw new GrantRefusal(refusal);
  const revokes = await exactRevokes(tx, role);
  try {
    for (const s of revokes) await tx.unsafe(s);
  } catch (e) {
    // The role handed on a privilege it held WITH GRANT OPTION: revoking it needs the grants made from it gone first (review pass 4: exit 1, unnamed).
    if (/dependent privileges exist/.test((e as Error).message)) throw new GrantRefusal(`--exact: ${role} has granted to others a privilege it held WITH GRANT OPTION, so it cannot be revoked here without theirs. Revoke those grants first, or name another role. Nothing changed.`);
    // A grantor holding nothing at all on the object is refused the revoke outright, where one holding something gets a warning and heldBeyond names the leftover (review pass 5: exit 1, as if the grant had failed).
    if ((e as { errno?: string }).errno === "42501") throw new GrantRefusal(`--exact: ${role} holds a privilege this connection's role may not revoke (${(e as Error).message}). Revoke it as its grantor or a superuser, or name another role. Nothing changed.`);
    throw e;
  }
  const left = await heldBeyond(tx, role);
  if (left.length) throw new GrantRefusal(`--exact: ${role} still holds what a revoke here does not reach — ${left.join("; ")}. Revoke it as its grantor, or name another role. Nothing changed.`);
  return revokes;
}

/**
 * The refusal of --baseline or --force, worded, or null. --baseline recorded
 * every migration as applied without running one, to adopt a schema built by
 * hand; --force overrode its refusal on a database with no schema. Both were
 * retired (SMD-3325): the compose stack builds every brain by running the
 * files, and a schema with no ledger is brought under the migrator by
 * --reapply. The CLI asks this before anything else, the URL included, and run()
 * before its own checks, so an old command is refused in the same words either
 * way and changes nothing rather than falling through to another mode.
 */
export function retiredFlagRefusal(baseline: boolean | undefined | null, force: boolean | undefined | null): string | null {
  const lines = [
    baseline === true ? "--baseline was retired (SMD-3325): it recorded every migration as applied without running one, to adopt a schema built by hand. On an empty database run the migrations plainly; to bring a schema with no ledger under the migrator, re-apply them with --reapply, the server and every worker stopped: every file runs again over what is there, in one transaction, and is recorded." : null,
    force === true ? "--force was retired with --baseline (SMD-3325): its one job was overriding --baseline's refusal on a database with no schema. Drop it." : null,
  ].filter((line): line is string => line !== null);
  return lines.length ? `${lines.join("\n")}\nNothing was changed.` : null;
}

/** A --groups or --exact without --grant, worded, or null: each shapes --grant and does nothing alone. */
export function lonelyGrantFlag(groups: string | undefined | null, exact: boolean | undefined | null): string | null {
  if ((groups == null && !exact)) return null;
  return `${groups != null ? "--groups names the groups --grant issues" : "--exact makes --grant all a role holds"}; it does nothing on its own. Pass it with --grant <role>.`;
}

async function migrateWith(sql: SQL, opts: MigrateOptions, out: Writer["out"], err: Writer["err"], lock: { held: boolean }): Promise<number> {
  const dryRun = opts.dryRun === true;
  const reapply = opts.reapply === true;

  // --grant <role>: issue exactly the privileges db/config.mjs's ROLE_GRANTS
  // documents — the one executable spelling of db/README.md's "Grants for a
  // capturing role". A standalone mode: it records nothing in the ledger and runs
  // no migration, so it is refused beside --reapply. It grants only
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
  // A plain --grant issues every group of ROLE_GRANTS; a retired group's name
  // (RETIRED_GRANT_GROUPS: `sleep`, SMD-3315) is refused as such. --groups a,b
  // grants those groups of ROLE_GRANTS alone (SMD-2289:
  // the orchestration runner's role gets what its ingester and reembed run, not
  // the whole list). Alone it revokes nothing, so a role granted more
  // before keeps what it has. --exact makes the grant all the role holds in this
  // database: in the grant's own transaction it refuses a member of another role
  // or an owner of anything (review pass 5), then revokes, object by object,
  // what an ACL grants the role (a table's or column's, a sequence's, a
  // routine's, CREATE on a schema or on the database; schema USAGE, CONNECT and
  // TEMP stay, which an operator may have granted on pgvector's schema or a
  // hardened brain), then refuses, rolling back, if it still holds anything
  // else (a default privilege naming it, a grant in another database, on a
  // type, tablespace or parameter, one a grantor other than the owner made, any
  // database privilege but CONNECT and TEMP), and only then grants. One
  // transaction, so a run in flight as the role never meets a moment without
  // its privileges, and a failure leaves what it had (SMD-2289 review passes 3
  // and 4). Every --grant, and db/login-role.ts, holds one advisory lock
  // (GRANT_LOCK), so two at once in one database queue rather than deadlock (an
  // advisory lock is per database; a role is the cluster's). --dry-run --exact
  // runs the revokes, the check and the grants in a transaction it rolls back,
  // so it shows a refusal or a failure to come.
  const grantRole = opts.grant;
  const lonely = lonelyGrantFlag(opts.groups, opts.exact);
  if (lonely && grantRole == null) {
    err(lonely);
    return 2;
  }
  if (grantRole != null) {
    if (reapply) {
      err("--grant issues privileges; it does not apply or record migrations. Run it on its own.");
      return 2;
    }
    const groupsArg = opts.groups ?? undefined;
    const exact = opts.exact === true;
    const grantGroups = groupsArg === undefined ? ROLE_GRANT_GROUPS : [...new Set(groupsArg.split(",").map((g) => g.trim()).filter(Boolean))];
    const unknown = grantGroups.filter((g) => !(ROLE_GRANT_GROUPS as readonly string[]).includes(g));
    if (groupsArg !== undefined && (unknown.length || !grantGroups.length)) {
      const retired = unknown.filter((g) => Object.hasOwn(RETIRED_GRANT_GROUPS, g));
      const strange = unknown.filter((g) => !retired.includes(g));
      err(`--groups takes a comma-separated list of ${ROLE_GRANT_GROUPS.join(", ")}${strange.length ? `; not a group: ${strange.map((g) => JSON.stringify(g)).join(", ")}` : ""}${retired.map((g) => `; ${JSON.stringify(g)} was ${RETIRED_GRANT_GROUPS[g]} — drop it from --groups`).join("")}${unknown.length ? "" : "; none was given"}. Nothing was granted.`);
      return 2;
    }
    const flags = `${groupsArg === undefined ? "" : ` --groups ${grantGroups.join(",")}`}`;
    try {
      const [{ present: roleExists }] = (await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${grantRole}) AS present`) as { present: boolean }[];
      if (!roleExists) {
        err(
          `No role ${JSON.stringify(grantRole)} exists. Create it first, as a role that can:\n` +
            `  CREATE ROLE ${quoteIdent(grantRole)} LOGIN PASSWORD '…';\n` +
            "then re-run --grant. This step grants privileges only; it never creates a role or sets a password."
        );
        return 2;
      }
      if (!(await publicFirst(sql, out, err, true))) return 2;
      const wanted = grantedObjects(grantGroups);
      const present = new Set<string>(
        ((await sql.unsafe(grantPresenceSql(wanted))) as { kind: string; name: string; present: boolean }[]).filter((r) => r.present).map((r) => r.name)
      );
      const missing = wanted.filter((o) => !present.has(o.name)).map((o) => o.name);
      // "; " between names: a function's name carries ", " inside its argument list.
      const skippedHint = `not yet present, skipped (run --grant again after applying the migration, community schema or extension/recipe schema that creates them; a function listed here may instead exist under another argument list, which --grant does not reach${missing.includes("schema_migrations") ? "; schema_migrations is this migrator's own ledger, which its first run makes" : ""}): ${missing.join("; ")}`;
      const statements = [`GRANT USAGE ON SCHEMA public TO ${quoteIdent(grantRole)};`, ...grantStatements(grantRole, { groups: grantGroups, present })];
      const merged = mergedGrants(grantGroups, present);
      // The grants, then the catalog asked whether the role holds each: the real run's and --dry-run --exact's alike.
      const grantAndVerify = async (tx: any) => {
        for (const s of statements) await tx.unsafe(s);
        const notHeld = ((await tx.unsafe(grantVerifySql(grantRole, merged))) as { kind: string; name: string; privilege: string; held: boolean }[]).filter((r) => !r.held);
        if (notHeld.length) {
          throw new Error(
            `the GRANTs ran but ${notHeld.length} privilege(s) were not granted — Postgres lets a role that holds a privilege without grant option issue the GRANT with only a warning ("no privileges were granted"), which this client does not see. Not held by ${grantRole}: ` +
              notHeld.map((r) => `${r.privilege} on ${r.kind} ${r.name}`).join("; ") +
              ". Connect as the objects' owner — the role that ran the migrations or applied the community schema — or a superuser, and run --grant again. Nothing was committed."
          );
        }
      };
      if (dryRun && exact) {
        // A preview in a transaction that is rolled back: the revokes it would run, a refusal it would meet (review pass 4), and a grant that would fail (review pass 6: the preview ran no grant, and said 0 where the run failed).
        let preview: string[] = [];
        let refusal: string | null = null;
        let failure: string | null = null;
        await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${GRANT_LOCK}))`;
          try {
            preview = await exactTransaction(tx, grantRole);
            await grantAndVerify(tx);
          } catch (e) {
            if (e instanceof GrantRefusal) refusal = e.message;
            else failure = (e as Error).message;
          }
          throw new RolledBack();
        }).catch((e) => { if (!(e instanceof RolledBack)) throw e; });
        out(`\n--grant ${grantRole}${flags} --exact  (--dry-run: nothing kept)\n`);
        for (const st of [...preview, ...statements]) out(`  ${st}`);
        if (refusal) out(`\n  ${refusal}`);
        if (failure) out(`\n  --grant would fail: ${failure}${/permission denied/.test(failure) ? `\n  ${grantorHint}` : ""}`);
        if (missing.length) out(`\n  ${skippedHint}`);
        return refusal ? 2 : failure ? 1 : 0;
      }
      if (dryRun) {
        out(`\n--grant ${grantRole}${flags}  (--dry-run: nothing run)\n`);
        for (const s of statements) out(`  ${s}`);
        if (missing.length) out(`\n  ${skippedHint}`);
        return 0;
      }
      let revoked: string[] = [];
      await sql.begin(async (tx) => {
        // Every --grant, and login-role.ts, holds one lock: two at once queue rather than deadlock on the same catalog rows (review pass 4: a plain --grant for another role deadlocked with --exact).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${GRANT_LOCK}))`;
        if (exact) revoked = await exactTransaction(tx, grantRole);
        await grantAndVerify(tx);
      });
      out(`\nGranted ${grantRole} ${groupsArg === undefined ? "the capturing-role privileges" : `the privileges of ${grantGroups.join(", ")}`} over ${present.size} object(s)${exact ? ", and nothing else in this database" : ""}:\n`);
      for (const s of [...revoked, ...statements]) out(`  ${s}`);
      if (missing.length) out(`\n  ${skippedHint}`);
      return 0;
    } catch (caught) {
      const message = (caught as Error).message;
      if (caught instanceof GrantRefusal) {
        err(message);
        return 2;
      }
      const hint = /permission denied/.test(message) ? `\n  ${grantorHint}` : "";
      err(`--grant failed: ${message}${hint}`);
      return 1;
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

  /** An enabled plugin's migrations (SMD-2310): its schema and its role (db/config.mjs's pluginIdents), and its files in order. */
  type PluginMigrations = { name: string; schema: string; role: string; files: { name: string; sql: string; sha: string }[] };

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

  /** The migration files, read and hashed now; null (the problem printed) when their names collide. */
  function loadMigrations(): Migration[] | null {
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
      err(problem);
      return null;
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
    err("Embedding configuration is not usable:\n");
    for (const p of configProblems) err(`  ✗ ${p}`);
    err("");
    return 2;
  }

  /**
   * The enabled plugins' migrations (SMD-2310): OB1_PLUGINS's names, each a
   * plugin's directory (its manifest there), its files NNN_name.sql in
   * plugins/<name>/migrations/ under the core's naming rule, read and hashed
   * as the core's are. Null, the problem printed, on a name that is no
   * plugin, a name given twice, or a listing whose names collide — refused
   * before anything runs.
   */
  function loadPluginMigrations(): PluginMigrations[] | null {
    const dir = opts.pluginsDir ?? PLUGINS_DIR;
    const names = (opts.plugins ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    const found: PluginMigrations[] = [];
    for (const name of names) {
      if (!PLUGIN_NAME_RE.test(name) || name.length > 32 || !existsSync(join(dir, name, "index.ts"))) {
        err(`OB1_PLUGINS names ${JSON.stringify(name)}, which is no plugin in ${dir}`);
        return null;
      }
      if (found.some((p) => p.name === name)) {
        err(`OB1_PLUGINS names ${JSON.stringify(name)} twice`);
        return null;
      }
      const migrationsDir = join(dir, name, "migrations");
      const files = existsSync(migrationsDir) ? readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort() : [];
      const problem = migrationNameProblem(files);
      if (problem) {
        err(`plugin ${name}: ${problem}`);
        return null;
      }
      found.push({
        name,
        ...pluginIdents(name),
        files: files.map((file) => {
          const template = readFileSync(join(migrationsDir, file), "utf8");
          return { name: file, sql: substitute(template, file), sha: migrationSha(template) };
        }),
      });
    }
    return found;
  }

  /** Whether a plugin phase would log in: a file the plugin ledger lacks, or no login role yet. Read-only. */
  async function pluginsNeedLogin(found: PluginMigrations[]): Promise<boolean> {
    const [{ ledger, login }] = (await sql`SELECT to_regclass('public.plugin_migrations') IS NOT NULL AS ledger, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${PLUGIN_LOGIN_ROLE}) AS login`) as { ledger: boolean; login: boolean }[];
    if (!login) return true;
    const recorded = new Set<string>(ledger ? ((await sql`SELECT plugin, name FROM public.plugin_migrations`) as { plugin: string; name: string }[]).map((r) => `${r.plugin}/${r.name}`) : []);
    return found.some((p) => p.files.some((m) => !recorded.has(`${p.name}/${m.name}`)));
  }

  const migrations = loadMigrations();
  if (migrations === null) return 2;
  const plugins = loadPluginMigrations();
  if (plugins === null) return 2;
  if (migrations.length === 0) {
    err(`No .sql files in ${MIGRATIONS_DIR}`);
    return 2;
  }

  /**
   * The file whose evidence backfill runs with the acceptances out of its sight
   * — by its whole name, as test-schema pins 030's: the number alone would find
   * any 021_*.sql. See applyShadowed.
   */
  const FILE_021 = "021_embedding_model_per_row.sql";
  if (!migrations.some((m) => m.name === FILE_021)) {
    err(`${FILE_021} is not in the set: it is the file whose evidence backfill the migrator shadows the claim table for, by its whole name — a renamed or renumbered file would run bare, reading the acceptances.`);
    return 2;
  }

  out(`  embedding: ${EMBEDDING_MODEL} @ ${EMBEDDING_DIM} dimensions`);
  // Printed because it is the one setting that changes what the schema CONTAINS
  // rather than how wide a column is, and because it takes effect only when 011
  // runs — the first apply, and every --reapply — see the note in that
  // migration's header.
  out(`  trigram index: ${TRGM_INDEX ? "on" : "off"} (OB1_TRGM_INDEX)`);
  out(`  023/050/055/073 backfills: ${SUBSTITUTIONS.BACKFILL_LIMIT === "NULL" ? "every row waiting" : `one batch of ${SUBSTITUTIONS.BACKFILL_LIMIT} rows`} (OB1_BACKFILL_LIMIT)`);

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

  // The brain is built in public, where preflight looks, whatever
  // the session's search_path puts first (SMD-2247): every migration and the
  // ledger below are unqualified, and land in the path's first schema. Before
  // the ledger, so its CREATE neither fails with 3F000 on a path that names no
  // schema nor lands in another. See pinPublicFirst (config.mjs).
  if (!(await publicFirst(sql, out, err))) return 2;

  // A schema applied without the migrator — public.thoughts there, and a ledger
  // missing or recording no migration — is brought under it by --reapply alone
  // (SMD-3425): one transaction, after the checks that this shell agrees with
  // the brain. A plain run would give each file its own, check nothing, and
  // from a shell of another model have 006 re-record ob1_config's. Refused,
  // its dry run too, once public is put first (whose own refusals, a role
  // without USAGE on public or another brain on the path, are the more exact
  // and come first), and before the plugins' checks and the ledger's CREATE:
  // nothing is written, and the plugins' password is not asked for by a run
  // that cannot apply them (review pass 1). Judged in public by name, as
  // preflight's ledger row reads it (PUBLIC_THOUGHTS_EXISTS); a migration is
  // a row whose name starts with three digits, as brain_info counts the
  // highest. An empty database (no thoughts) is a first build and goes on.
  if (!reapply) {
    const [state] = (await sql.unsafe(
      `SELECT ${PUBLIC_THOUGHTS_EXISTS} AS thoughts, to_regclass('public.schema_migrations') IS NOT NULL AS ledger`
    )) as { thoughts: boolean; ledger: boolean }[];
    const recorded = state.thoughts && state.ledger
      ? Number(((await sql`SELECT count(*)::int AS c FROM public.schema_migrations WHERE substr(name, 1, 3) ~ '^[0-9]{3}$'`) as { c: number }[])[0].c)
      : 0;
    if (state.thoughts && recorded === 0) {
      err(
        `${dryRun ? "--dry-run" : "A plain run"} refused: public.thoughts is here and the migration ledger records no migration (${state.ledger ? "schema_migrations holds none" : "no schema_migrations table"}) — a schema applied without the migrator,\n` +
          "  or another application's table named thoughts, in which case point the migrator at a database of its own.\n" +
          "  A plain run would re-run every file in a transaction of its own, checking nothing first: from a shell of another\n" +
          "  OB1_EMBEDDING_MODEL, 006 would re-record the brain's model, and a run stopped part-way would leave older definitions committed.\n" +
          "  Re-apply the migrations instead, with the server and every worker stopped — every file in one transaction, after checking\n" +
          `  this shell agrees with the brain, each recorded (SMD-3425): ${REAPPLY_COMMAND}, or in the compose stack:\n` +
          "  docker compose run --rm migrate bun migrate.ts --reapply. Nothing was changed."
      );
      return 2;
    }
  }

  // A plain run that would apply a plugin's file, or make the login role, needs
  // the login role's password and the URL its connection is built from:
  // refused before anything runs, so a run never applies the core and stops
  // at the plugins. One with nothing of the plugins' to do asks neither (PR 3
  // review pass 2: it blocked a by-hand core-only run).
  if (!dryRun && !reapply && plugins.some((p) => p.files.length > 0) && (await pluginsNeedLogin(plugins))) {
    if (!opts.pluginPassword?.trim()) {
      err(`OB1_PLUGINS names a plugin with migrations, and OB1_PLUGIN_DB_PASSWORD is not set: a plugin's SQL runs as ${PLUGIN_LOGIN_ROLE}, a login role the migrator makes with that password. Set it in deploy/.env (openssl rand -hex 32) and run again.`);
      return 2;
    }
    if (!opts.url) {
      err(`the plugin phase opens its own connection as ${PLUGIN_LOGIN_ROLE}, built from the database URL: pass url beside sql.`);
      return 2;
    }
  }

  // The run's lock (SMD-3379), taken before it writes anything. Taken once,
  // held until run() returns; a run refused for it has written nothing, as
  // each call stands before the first write of its kind and a run that took
  // none earlier wrote none. "took" when it was taken just now: what the
  // caller read to decide on its write was read without it, and another run
  // may have done that write and let the lock go since, so the caller reads
  // it again (review pass 2). "had" when this run held it already. The
  // refusal names the holding backend: a run that was killed keeps it until
  // its statement ends on the server.
  let lockRefused = false;
  const takeLock = async (): Promise<"took" | "had" | false> => {
    if (lock.held) return "had";
    await sql.unsafe("SET application_name = 'ob1-migrate'");
    const [{ got }] = (await sql`SELECT pg_try_advisory_lock(hashtext(${MIGRATE_LOCK})) AS got`) as { got: boolean }[];
    if (got) {
      lock.held = true;
      return "took";
    }
    // Who holds it, read without taking it. No row: it was let go between the
    // try and this read. A read that failed: the holder is unknown, not gone.
    let holder: { pid: number; backend_start: Date | null } | undefined;
    let unread = false;
    try {
      [holder] = (await sql.unsafe(MIGRATE_LOCK_HOLDER_SQL, [MIGRATE_LOCK])) as { pid: number; backend_start: Date | null }[];
    } catch {
      unread = true;
    }
    const who = holder
      ? `backend ${holder.pid}${holder.backend_start ? `, connected ${new Date(holder.backend_start).toISOString()},` : ""} holds`
      : unread ? "a backend this role could not read holds" : "a backend held, and has just let go,";
    err(
      `Refused: another migrate.ts run is applying to this database now — ${who} the ${MIGRATE_LOCK} advisory lock (SMD-3379).\n` +
        "  Wait for it to finish, then run this again: it applies only what that run leaves. Nothing was changed." +
        (holder ? `\n  A run that was killed keeps the lock until its statement ends on the server; to end it now: SELECT pg_terminate_backend(${holder.pid});` : "")
    );
    lockRefused = true;
    return false;
  };
  // The core's work, and --reapply, judged before the ledger is made, so a run
  // refused here writes nothing; the read that decides what runs comes after,
  // under the lock. In public by name, as the refusal above reads it. The
  // plugins' files and repairs take it where they write.
  if (!dryRun) {
    const corePending = async (): Promise<boolean> => {
      if (reapply) return true;
      const [{ ledger }] = (await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger`) as { ledger: boolean }[];
      const recorded = new Set<string>(ledger ? ((await sql`SELECT name FROM public.schema_migrations`) as { name: string }[]).map((r) => r.name) : []);
      return migrations.some((m) => !recorded.has(m.name));
    };
    if ((await corePending()) && !(await takeLock())) return 2;
  }

  const LEDGER_DDL = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      sha256      text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`;
  // A live --reapply over a database with no ledger makes it inside its one
  // transaction, not here: its checks may refuse and a file may fail, and an
  // empty ledger left behind reads to preflight as a migrated brain recording
  // none, so "Nothing was written" must hold (SMD-3325, review pass 3). In
  // public by name: another tool's schema_migrations further along the path
  // is not this ledger (review pass 4).
  const ledgerInTransaction =
    reapply && !dryRun && ((await sql`SELECT to_regclass('public.schema_migrations') IS NULL AS absent`) as { absent: boolean }[])[0].absent;
  if (!ledgerInTransaction) await sql.unsafe(LEDGER_DDL);

  const applied = new Map<string, string>(
    ledgerInTransaction
      ? []
      : (await sql`SELECT name, sha256 FROM schema_migrations`).map(
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
   * migrations before it still apply and are recorded, and the migration itself is refused with a
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
    out(
      `  pgvector: installed in schema "${vectorSchema}", off this connection's search_path — added to this session so the migrations resolve the vector type`
    );
    out(
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
  function explainFailure(caught: unknown, m: Migration | null, mode: "plain" | "reapply" | "checks"): string[] {
    const message = (caught as Error).message;
    const { errno: sqlstate, hint } = caught as { errno?: string; hint?: string };
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
   * into "FAILED". Read on a first apply and on a re-run alike — a brain whose
   * 014 was recorded but never ran here has the re-run as the first time it
   * can say the walk bounds are unseeded.
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
        err(
          `  ⚠  ${m.name}  applied, but the database-level HNSW walk bounds were not seeded (${missing.join(", ")}) —\n` +
            `     the migrating role does not own the database, or the platform refused ALTER DATABASE. Run as the owner, in one session:\n` +
            `       SELECT '[1]'::vector;   -- loads pgvector so a non-superuser may set hnsw.* settings\n` +
            `${statements}\n` +
            `     Until then a broad filter's walk runs with pgvector's defaults, which return short on large tables; preflight warns about it.`
        );
      }
    } catch (e) {
      err(`  ⚠  ${m.name}  applied; could not read pg_settings to confirm the walk bounds (${(e as Error).message}). Preflight checks them at startup.`);
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
  // Every refusal judged here, in one list with one tail — both modes, "would
  // refuse" under --dry-run — so a green dry run is never followed by a red
  // run on these, and every one is reported, not the first. A file's own
  // refusals inside its body (097's prerequisites, 100's index under its
  // name) run only with the file: a dry run reads no body. What 021's shadow needs: a temp table,
  // which a hardened database may deny the role (023's backfill call needs one
  // too, and orders after 021, so a fresh upgrade meets the need here first).
  // Then the re-run's own judgements, below.
  const refusals: { code: number; text: string }[] = [];
  const shadows021 = reapply || !applied.has(FILE_021);
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
    } catch (caught) {
      err(`  ✗  --reapply  could not be judged: ${(caught as Error).message}`);
      for (const line of explainFailure(caught, null, "checks")) err(line);
      err("  The checks before the run read pg_attribute and ob1_config; this role could not, or was made to wait. Nothing was written.");
      return 1;
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
    for (const r of refusals) err(`\n  ${dryRun ? "would refuse" : "refusing"} ${reapply ? "--reapply" : `to apply ${FILE_021}`}: ${r.text}`);
    err(`\n  Nothing was written.`);
    return Math.max(...refusals.map((r) => r.code));
  }
  // Announced only once nothing refuses: a banner before a refusal read as a
  // run that never began.
  if (reapply) {
    const recorded = migrations.filter(reapplies).length;
    out(
      `  ${dryRun ? "would re-apply" : "re-applying"} every migration (${recorded} recorded, ${migrations.length - recorded} pending), in order, in one transaction with a ${LOCK_TIMEOUT_S} s lock timeout —\n` +
        "  recorded rows stay as they are, pending ones are recorded. Stop the server and any re-embed or extraction worker first:\n" +
        "  001 and 003 take ACCESS EXCLUSIVE locks on thoughts, 011 builds the trigram index if OB1_TRGM_INDEX is on and it is absent,\n" +
        "  023's, 050's and 073's backfill calls take thoughts EXCLUSIVE, 055's locks the audit rows it fills (OB1_BACKFILL_LIMIT bounds each, as on a first apply),\n" +
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
        if (ledgerInTransaction) await tx.unsafe(LEDGER_DDL);
        for (const m of migrations) {
          progress.current = m;
          const note = await applyShadowed(tx, m);
          if (note !== null) notes.set(m.name, note);
          if (!applied.has(m.name)) await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
        }
      });
    } catch (caught) {
      err(`  ✗  ${progress.current?.name ?? "--reapply"}  FAILED: ${(caught as Error).message}`);
      for (const line of explainFailure(caught, progress.current, "reapply")) err(line);
      err(
        "  The re-run is one transaction: it rolled back, nothing was re-applied or applied, and the schema is as it was.\n" +
          "  Fix the cause and run --reapply again."
      );
      return 1;
    }
    for (const m of migrations) {
      const again = applied.has(m.name);
      out(`  ✓  ${m.name}  ${again ? "re-applied" : "applied"}`);
      if (notes.has(m.name)) out(notes.get(m.name) as string);
      if (again) reapplied++;
      else ran++;
    }
    for (const m of migrations) if (m.seeds.length) await reportSeeds(m);
  }

  // --dry-run names the release each pending migration belongs to (SMD-1804);
  // read the manifest once here rather than per file, and only when it is used, so
  // a plain run never fails on a malformed releases.json.
  const releases = dryRun ? readReleases() : [];

  /** The files this run applied for the first time, for the notes read after the loop. */
  const appliedNow = new Set<string>();
  // Under a live --reapply every file ran above; this loop is the plain run's and --dry-run's.
  for (const m of reapply && !dryRun ? [] : migrations) {
    const prior = applied.get(m.name);

    if (prior && prior !== m.sha) {
      // The file changed after being applied. Do not silently re-run it — that is
      // how a "working" migration set stops matching the database it produced.
      err(`  ⚠  ${m.name}  ALREADY APPLIED BUT FILE CHANGED (was ${prior}, now ${m.sha})`);
      drifted++;
      continue;
    }
    if (prior && !reapplies(m)) {
      out(`  ·  ${m.name}  already applied`);
      skipped++;
      continue;
    }
    if (dryRun) {
      // The plain run's judgement. A recorded file under --reapply reaches here
      // too — as "would re-apply" — but never with a floor: the checks above
      // refuse the whole re-run on one before this loop runs.
      if (tooOldFor(m)) {
        out(`  ✗  ${m.name}  would FAIL: pgvector ${pgvectorLibrary} < ${tooOldFor(m)}`);
        floorBlocked ??= m;
        continue;
      }
      // The live run exits at the first refusal, so nothing after it applies;
      // saying "would apply" for those would promise what the run cannot do.
      if (floorBlocked) {
        out(`  ·  ${m.name}  blocked behind ${floorBlocked.name}`);
        continue;
      }
      const version = versionForMigration(Number(m.name.slice(0, 3)), releases) ?? "Unreleased";
      out(`  →  ${m.name}  would ${prior ? "re-apply" : "apply"} (${m.sha}) · ${version}`);
      if (prior) reapplied++;
      else ran++;
      continue;
    }
    // The version floor, enforced only where it bites: earlier pending migrations
    // have already applied above.
    if (tooOldFor(m)) {
      err(`  ✗  ${m.name}  refused` + floorMessage(m));
      return 1;
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
      out(`  …  ${m.name}  builds two HNSW indexes over about ${(Number(r.t) + Number(r.c)).toLocaleString()} vectors (thoughts ${Number(r.t).toLocaleString()}, windows ${Number(r.c).toLocaleString()}) under maintenance_work_mem = ${r.mem} with ${r.workers} parallel workers — the graph wants about ${perVector.toFixed(1)} KB a vector at ${EMBEDDING_DIM} dimensions, ${Math.ceil(((Number(r.t) + Number(r.c)) * perVector) / 1024)} MB here (the file's header)`);
    }

    // Each migration runs in its own transaction: a failure leaves earlier ones
    // applied and recorded, so a rerun resumes rather than starting over. The
    // line saying so is written after the catch, not inside it: a writer that
    // throws there (a caller's stream gone away) is not the migration failing,
    // and must not be reported as one when the file is applied and recorded.
    let note: string | null;
    try {
      note = await begin(async (tx: SQL) => {
        const n = await applyShadowed(tx, m);
        await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
        return n;
      });
    } catch (caught) {
      err(`  ✗  ${m.name}  FAILED: ${(caught as Error).message}`);
      for (const line of explainFailure(caught, m, "plain")) err(line);
      return 1;
    }
    out(`  ✓  ${m.name}  applied`);
    if (note !== null) out(note);
    ran++;
    appliedNow.add(m.name);

    if (m.seeds.length) await reportSeeds(m);
  }

  const verb = dryRun ? "would apply" : "applied";
  out(`\n${verb} ${ran}${reapplied ? `, ${dryRun ? "would re-apply" : "re-applied"} ${reapplied}` : ""}, skipped ${skipped}${drifted ? `, DRIFTED ${drifted}` : ""}`);

  // Both conditions can hold in one --dry-run (the live path exits inside the
  // loop). Say everything before exiting: a floor message that hid the drift
  // remedy sent the operator to upgrade pgvector and back here for the sha.
  if (floorBlocked) err(floorMessage(floorBlocked));
  if (drifted > 0) {
    err(
      "\nA migration file changed after it was applied. Migrations are append-only:\n" +
        "add a new file rather than editing an old one. If the edit was intentional and\n" +
        "the database already reflects it, update schema_migrations.sha256 by hand."
    );
  }
  const coreCode = floorBlocked || drifted > 0 ? 1 : 0;
  if (coreCode === 0 && !dryRun) await confineStatStatements();
  if (lockRefused) return 2;
  if (plugins.length === 0) return coreCode;
  const named = plugins.map((p) => p.name).join(", ");
  if (reapply) {
    out(`\nplugins: ${named} — not run under --reapply; a plain run applies their migrations`);
    return coreCode;
  }
  if (coreCode !== 0 && !dryRun) {
    err(`\nplugins: ${named} — not applied while the core's migrations are not clean`);
    return coreCode;
  }
  return Math.max(coreCode, await migratePlugins());

  /**
   * pg_stat_statements' views and functions kept from PUBLIC on every run, not
   * on 096's alone (SMD-1849 PR 3b, review pass 1). A restore without
   * privileges — a tier refresh's pg_restore -x (db/tier.ts) — creates the
   * extension again with its own grants, PUBLIC's among them, under a ledger
   * that already records 096, so nothing else would run it again; and
   * readable by PUBLIC they are core relations the plugins' login role holds,
   * which preflight's "plugin tables" row refuses. So read the grants, and run
   * 096 again where PUBLIC holds one. Read after the fact, as reportSeeds
   * reads: 096's grants left as they were where this role does not own the
   * objects, and its skip where this role may not create the extension, are
   * warnings, which this client does not surface. Said, never fatal: the
   * brain runs without the extension, and preflight refuses what needs
   * refusing. The file is found by its name, not its number, which main may
   * take (review pass 2: 092 was taken, and "092_" would have found that file).
   */
  async function confineStatStatements(): Promise<void> {
    const file = migrations!.find((m) => m.name.endsWith("_pg_stat_statements.sql"));
    if (!file) return;
    // The objects 096 revokes, by name among the extension's members, wherever it lives.
    const state = async () =>
      ((await sql`
        SELECT current_database() AS db,
               (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements') AS ns,
               COALESCE((SELECT has_schema_privilege('public', e.extnamespace, 'USAGE') FROM pg_extension e WHERE e.extname = 'pg_stat_statements'), false) AS public_usage,
               EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed,
               EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS offered,
               EXISTS (SELECT 1 FROM pg_extension e
                         JOIN pg_depend d ON d.refobjid = e.oid AND d.deptype = 'e' AND d.classid = 'pg_class'::regclass
                         JOIN pg_class c ON c.oid = d.objid AND c.relname IN ('pg_stat_statements', 'pg_stat_statements_info')
                         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                        WHERE e.extname = 'pg_stat_statements' AND a.grantee = 0)
            OR EXISTS (SELECT 1 FROM pg_extension e
                         JOIN pg_depend d ON d.refobjid = e.oid AND d.deptype = 'e' AND d.classid = 'pg_proc'::regclass
                         JOIN pg_proc p ON p.oid = d.objid AND p.proname IN ('pg_stat_statements', 'pg_stat_statements_info')
                         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                        WHERE e.extname = 'pg_stat_statements' AND a.grantee = 0) AS to_public`) as { db: string; ns: string | null; public_usage: boolean; installed: boolean; offered: boolean; to_public: boolean }[])[0];
    // The file applied by hand, into this database, from the repository's root or into the compose stack's Postgres (review pass 3: a psql with no database named created it in another).
    // The database's name in a shell's single quotes, so a name with `$`, a backquote or a double quote pastes as itself (review pass 4: an identifier's double quotes ran a command substitution).
    const shq = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
    const byHand = (db: string) => `psql -d ${shq(db)} -v ON_ERROR_STOP=1 -f db/migrations/${file.name}, or in the compose stack compose exec -T postgres psql -U postgres -d ${shq(db)} -v ON_ERROR_STOP=1 -f - < db/migrations/${file.name}`;
    try {
      const before = await state();
      if (!before.installed) {
        if (before.offered && appliedNow.has(file.name)) {
          out(`  ·  ${file.name}  left pg_stat_statements out: the server offers it, and this role could not create it — a superuser may, unless the server keeps extensions to an allow-list. Applied once as a superuser, from the repository's root (${byHand(before.db)}), it creates the extension and keeps its views from PUBLIC, and the observability profile's exporter reads each statement's times. Said on this run alone`);
        }
        return;
      }
      if (!before.to_public) return;
      // A write on a run that may have had nothing else to apply (SMD-3379);
      // read again once the lock is taken, as another run may have done it.
      const taken = await takeLock();
      if (!taken) return;
      if (taken === "took" && !(await state()).to_public) return;
      await begin((tx: SQL) => tx.unsafe(file.sql));
      if ((await state()).to_public) {
        // A warning where every role reaches the view: in public, where preflight's "plugin tables" row reads, or in a
        // schema PUBLIC may use, which that row does not read (review pass 4). Behind a schema PUBLIC may not use (a
        // managed Postgres's own, its owner the provider's) a note: a run that cannot act need not alarm on every start
        // (review pass 3).
        if (before.ns === "public" || before.public_usage) {
          err(
            `  ⚠  ${file.name}  ran again, as PUBLIC could read pg_stat_statements, and PUBLIC still can: this role does not own its views, so it may not change their grants.\n` +
              `  Apply the file once as their owner or a superuser, from the repository's root (${byHand(before.db)}). Until then every role here reads the view, ` +
              (before.ns === "public" ? `and with a plugin enabled preflight's "plugin tables" row refuses the server.` : `the plugins' login role among them, which preflight's "plugin tables" row, reading public alone, does not see.`)
          );
        } else {
          out(`  ·  ${file.name}  pg_stat_statements, in schema ${before.ns}, keeps PUBLIC's grant behind a schema PUBLIC may not use: this role does not own it, so may not change its grants (its owner may, applying the file)`);
        }
      } else {
        out(`  ↻  ${file.name}  ran again: PUBLIC could read pg_stat_statements (a restore without privileges gives it back), and now cannot`);
      }
    } catch (caught) {
      err(`  ⚠  ${file.name}  pg_stat_statements' grants could not be read or set: ${(caught as Error).message}`);
    }
  }

  /**
   * The enabled plugins' migrations (SMD-2310), after the core's: each plugin
   * in a schema of its own (plugin_<name>) owned by a role of its own
   * (ob1_plugin_<name>, NOLOGIN), and recorded in plugin_migrations, a ledger
   * of its own beside schema_migrations, which nothing that reads the core's
   * ledger sees. Every file runs on a connection logged in as the plugin
   * login role (PLUGIN_LOGIN_ROLE: NOINHERIT, no superuser, SET on each
   * plugin's role and nothing on the core), then as the plugin's role with
   * its schema first on the path: a plugin's SQL names its tables bare, and
   * Postgres refuses it the core's — even SQL that undoes the role, which
   * lands on the login role, not the migrator (PR 3 review pass 1: a file
   * that said END; ran its rest as the migrator). A plugin not enabled is not
   * read: its schema, tables and rows stay as they are. 0, or 1 on a failure
   * (the line names it; files before it stay applied and recorded, as the
   * core's do) or a drift.
   */
  async function migratePlugins(): Promise<number> {
    out(`\nplugins: ${named} — ledger plugin_migrations, run as ${PLUGIN_LOGIN_ROLE}`);
    // Each repair below is a write on a run whose core may have had nothing to
    // apply, so each takes the run's lock before it (SMD-3379); the ledger is
    // made only where it is missing, so a run with it in place takes none.
    if (!dryRun && ((await sql`SELECT to_regclass('public.plugin_migrations') IS NULL AS absent`) as { absent: boolean }[])[0].absent) {
      if (!(await takeLock())) return 2;
      await sql`
        CREATE TABLE IF NOT EXISTS public.plugin_migrations (
          plugin      text NOT NULL,
          name        text NOT NULL,
          sha256      text NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (plugin, name)
        )
      `;
    }
    const [{ ledger }] = (await sql`SELECT to_regclass('public.plugin_migrations') IS NOT NULL AS ledger`) as { ledger: boolean }[];
    /** Whether the ledger below was read under the run's lock: a file decided from a read without it is read again once the lock is taken (review pass 2). */
    const recordedLocked = lock.held;
    const recorded = new Map<string, string>(
      ledger ? ((await sql`SELECT plugin, name, sha256 FROM public.plugin_migrations`) as { plugin: string; name: string; sha256: string }[]).map((r) => [`${r.plugin}/${r.name}`, r.sha256]) : []
    );
    const [me] = (await sql`SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser, current_setting('server_version_num')::int AS version`) as { who: string; superuser: boolean; version: number }[];
    /** SET ROLE's own privilege: the SET option from PG 16, membership before. */
    const setPrivilege = me.version >= 160000 ? "SET" : "MEMBER";
    /** The grant that gives SET and nothing else: on PG 16 the options say so; before, the member's NOINHERIT does. */
    const setGrant = (role: string, to: string) => `GRANT ${quoteIdent(role)} TO ${to}${me.version >= 160000 ? " WITH SET TRUE, INHERIT FALSE" : ""}`;
    const can = async (q: SQL, who: string, role: string): Promise<boolean> =>
      // A CASE, not AND: Postgres may evaluate either side of AND first, and pg_has_role on a missing role errors.
      ((await q.unsafe(`SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) THEN pg_has_role($1, $2, '${setPrivilege}') ELSE false END AS can`, [who, role])) as { can: boolean }[])[0].can;
    const hasFiles = (plugins as PluginMigrations[]).some((p) => p.files.length > 0);

    // The login role, made once with the operator's password and never altered
    // after: a second password would lock out the servers still holding the
    // first. Preflight logs in as it, so a password that does not match is
    // said there.
    let pluginSql: SQL | null = null;
    /** The login connection, opened at the first file that runs, its login checked: plugin SQL never runs as the migrator (PR 3 review pass 2). */
    const loginSql = async (): Promise<SQL> => {
      if (pluginSql) return pluginSql;
      pluginSql = openSql(pluginLoginUrl(opts.url as string, opts.pluginPassword as string));
      const [{ who }] = (await pluginSql`SELECT session_user AS who`) as { who: string }[];
      if (who !== PLUGIN_LOGIN_ROLE) throw new Error(`the plugins' connection logged in as ${who}, not ${PLUGIN_LOGIN_ROLE}`);
      return pluginSql;
    };
    if (!dryRun && hasFiles) {
      try {
        const [{ present }] = (await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${PLUGIN_LOGIN_ROLE}) AS present`) as { present: boolean }[];
        const taken = !present && (await takeLock());
        if (!present && !taken) return 2;
        const madeMeanwhile = taken === "took" && ((await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${PLUGIN_LOGIN_ROLE}) AS present`) as { present: boolean }[])[0].present;
        if (!present && !madeMeanwhile) {
          const [{ statement }] = (await sql`SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', ${PLUGIN_LOGIN_ROLE}::text, ${opts.pluginPassword ?? ""}::text) AS statement`) as { statement: string }[];
          await sql.unsafe(statement);
          out(`  ✓  role ${PLUGIN_LOGIN_ROLE}  made (LOGIN, NOINHERIT; SET on each plugin's role, nothing else)`);
        }
      } catch (caught) {
        err(`  ✗  role ${PLUGIN_LOGIN_ROLE} could not be made: ${(caught as Error).message}`);
        err("  The migrating role must be able to CREATE ROLE; the compose stack's postgres can.");
        return 1;
      }
    }
    try {
      let pluginRan = 0;
      let pluginSkipped = 0;
      let pluginDrifted = 0;
      for (const p of plugins as PluginMigrations[]) {
        out(`  plugin ${p.name}  (schema ${p.schema}, role ${p.role})`);
        if (p.files.length === 0) {
          out("  ·  no migrations");
          continue;
        }
        // The role, its schema and the login role's SET on it, made by any
        // run that names the plugin and finds one missing — not only before a
        // pending file: a brain restored into a new cluster (roles are not in
        // a dump) records every file and has no role (review pass 1). Read
        // first, so a run with all in place and nothing pending asks no
        // privilege of the migrator (review pass 2: CREATE SCHEMA IF NOT
        // EXISTS checks the database's CREATE before it looks). The role owns
        // what the plugin makes, the schema holds it; neither is ever dropped.
        // A migrator that is no superuser takes SET on the role to hand it a
        // new schema (CREATE SCHEMA … AUTHORIZATION needs it): on PG 16 a
        // CREATEROLE role's own grant on a role it makes has ADMIN alone
        // (createrole_self_grant unset). The files themselves run on the
        // login role, so the migrator needs no SET to run them.
        const readState = async () => {
          const [s] = (await sql`
            SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${p.role}) AS role,
                   EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${p.schema}) AS schema`) as { role: boolean; schema: boolean }[];
          return { ...s, loginCan: s.role && (await can(sql, PLUGIN_LOGIN_ROLE, p.role)) };
        };
        let state = await readState();
        const missing = () => !state.role || !state.schema || !state.loginCan;
        if (!dryRun && missing()) {
          const taken = await takeLock();
          if (!taken) return 2;
          if (taken === "took") state = await readState();
        }
        if (!dryRun && missing()) {
          try {
            await begin(async (tx: SQL) => {
              if (!state.role) await tx.unsafe(`CREATE ROLE ${quoteIdent(p.role)} NOLOGIN`);
              if (!state.schema) {
                if (!me.superuser && !(await can(tx, me.who, p.role))) await tx.unsafe(setGrant(p.role, "CURRENT_USER"));
                await tx.unsafe(`CREATE SCHEMA ${quoteIdent(p.schema)} AUTHORIZATION ${quoteIdent(p.role)}`);
              }
              if (!(await can(tx, PLUGIN_LOGIN_ROLE, p.role))) await tx.unsafe(setGrant(p.role, quoteIdent(PLUGIN_LOGIN_ROLE)));
            });
          } catch (caught) {
            err(`  ✗  plugin ${p.name}: its role and schema could not be made: ${(caught as Error).message}`);
            err(`  The migrating role must be able to CREATE ROLE and CREATE SCHEMA, to SET ROLE to what it creates, and to grant it to ${PLUGIN_LOGIN_ROLE}; the compose stack's postgres can.`);
            return 1;
          }
        }
        // A schema that was here, and what is in it, handed back to the role
        // where another owns it: a brain restored without its owners
        // (--no-owner, as a tier's refresh restores, or into a cluster
        // without the role, where the dump's ALTER … OWNER fails) comes back
        // the restoring role's, and the plugin's role reaches none of it
        // (final review). Read first, as above; an ALTER … OWNER needs the
        // migrator to own the object, or be a superuser, and to SET ROLE to
        // the role.
        if (!dryRun && state.schema) {
          const readOwners = async () => ({
            owner: ((await sql`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${p.schema}`) as { owner: string }[])[0].owner,
            foreign: await pluginForeignOwned(sql, p.schema, p.role),
          });
          let { owner, foreign } = await readOwners();
          if (owner !== p.role || foreign.length > 0) {
            const taken = await takeLock();
            if (!taken) return 2;
            if (taken === "took") ({ owner, foreign } = await readOwners());
          }
          if (owner !== p.role || foreign.length > 0) {
            try {
              await begin(async (tx: SQL) => {
                if (!me.superuser && !(await can(tx, me.who, p.role))) await tx.unsafe(setGrant(p.role, "CURRENT_USER"));
                if (owner !== p.role) await tx.unsafe(`ALTER SCHEMA ${quoteIdent(p.schema)} OWNER TO ${quoteIdent(p.role)}`);
                for (const f of foreign) await tx.unsafe(`ALTER ${f.kind} ${f.ident} OWNER TO ${quoteIdent(p.role)}`);
              });
              out(`  ✓  ${owner !== p.role ? `schema ${p.schema} and ` : ""}${foreign.length} object(s) in it handed back to ${p.role}`);
            } catch (caught) {
              err(`  ✗  plugin ${p.name}: what another role owns in ${p.schema} could not be handed back to ${p.role}: ${(caught as Error).message}`);
              err("  The migrating role must own them, or be a superuser, and be able to SET ROLE to the plugin's role.");
              return 1;
            }
          }
        }
        for (const m of p.files) {
          const prior = recorded.get(`${p.name}/${m.name}`);
          if (prior && prior !== m.sha) {
            err(`  ⚠  ${p.name}/${m.name}  ALREADY APPLIED BUT FILE CHANGED (was ${prior}, now ${m.sha})`);
            pluginDrifted++;
            continue;
          }
          if (prior) {
            out(`  ·  ${m.name}  already applied`);
            pluginSkipped++;
            continue;
          }
          if (dryRun) {
            out(`  →  ${m.name}  would apply (${m.sha}) as ${p.role} in ${p.schema}`);
            pluginRan++;
            continue;
          }
          if (!(await takeLock())) return 2;
          // The ledger was read before the lock: another run may have applied
          // this file and let the lock go since (review pass 2).
          if (!recordedLocked) {
            const [now] = (await sql`SELECT sha256 FROM public.plugin_migrations WHERE plugin = ${p.name} AND name = ${m.name}`) as { sha256: string }[];
            if (now && now.sha256 !== m.sha) {
              err(`  ⚠  ${p.name}/${m.name}  ALREADY APPLIED BUT FILE CHANGED (was ${now.sha256}, now ${m.sha})`);
              pluginDrifted++;
              continue;
            }
            if (now) {
              out(`  ·  ${m.name}  already applied`);
              pluginSkipped++;
              continue;
            }
          }
          try {
            await (await loginSql()).begin(async (tx: SQL) => {
              await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
              await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_S}s'`);
              await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(p.role)}`);
              await tx.unsafe(`SET LOCAL search_path TO ${quoteIdent(p.schema)}, public`);
              await tx.unsafe(m.sql);
            });
            // The ledger is the core's, written by the migrator's own
            // connection once the file has committed: the login role holds
            // nothing on it. A ledger write that fails after the file
            // committed leaves the file to run again — which is why a
            // plugin's migration says IF NOT EXISTS, as the core's do.
            await sql`INSERT INTO public.plugin_migrations (plugin, name, sha256) VALUES (${p.name}, ${m.name}, ${m.sha})`;
          } catch (caught) {
            const message = (caught as Error).message;
            err(`  ✗  ${p.name}/${m.name}  FAILED: ${message}`);
            if (/permission denied/.test(message)) err(`  A plugin's migration runs as ${p.role} on ${PLUGIN_LOGIN_ROLE}, which hold its own schema alone: a core table, or a schema not its own, is refused.`);
            if (/password authentication failed/.test(message)) err(`  ${PLUGIN_LOGIN_ROLE} keeps the password it was made with: set OB1_PLUGIN_DB_PASSWORD to it, or change the role's password and the variable together.`);
            return 1;
          } finally {
            // A temp table the file left past its transaction goes: Postgres
            // searches temp before any schema, so it would stand in for the
            // next plugin's table of that name (review pass 1).
            if (pluginSql) await (pluginSql as SQL).unsafe("DISCARD TEMP").catch(() => {});
          }
          out(`  ✓  ${m.name}  applied`);
          pluginRan++;
        }
      }
      out(`\nplugins: ${dryRun ? "would apply" : "applied"} ${pluginRan}, skipped ${pluginSkipped}${pluginDrifted ? `, DRIFTED ${pluginDrifted}` : ""}`);
      if (pluginDrifted > 0) err("\nA plugin's migration file changed after it was applied: add a new file rather than editing an old one, as with the core's.");
      return pluginDrifted > 0 ? 1 : 0;
    } finally {
      // Widened: assigned inside loginSql, which the checker's flow analysis does not follow.
      const opened = pluginSql as SQL | null;
      if (opened) await opened.close().catch(() => {});
    }
  }
}

if (import.meta.main) {
  // Every argument accounted for (db/cli.ts): a flag the runner does not have, a
  // value where no flag takes one, a flag that takes a value followed by none,
  // or a flag given twice (`--url A --url B` would run against A), is refused
  // rather than dropped — `--reapply=021`, or a misspelt flag, would otherwise be
  // a silent plain run that exits 0. The refusal names the flag or the
  // argument's position, never the argument: a URL carries a password.
  const cli = commandLine("migrate.ts", {
    url: "one", grant: "one", groups: "one", exact: "none", "dry-run": "none", baseline: "none", reapply: "none", force: "none",
  }, { hints: { url: "<postgres://…>", grant: "<role>", groups: "<group,group…> (with --grant)", exact: "(with --grant)", baseline: "(retired: refused, SMD-3325)", force: "(retired: refused, SMD-3325)" } });
  // Refused before the URL is read, so a retired flag, or a stray --groups or --exact, says so rather than "no database URL".
  const retired = retiredFlagRefusal(cli.has("baseline"), cli.has("force"));
  if (retired) {
    console.error(retired);
    process.exit(2);
  }
  const lonely = cli.value("grant") === undefined ? lonelyGrantFlag(cli.value("groups"), cli.has("exact")) : null;
  if (lonely) {
    console.error(lonely);
    process.exit(2);
  }
  const url = databaseUrl(cli.value("url"));
  // One connection, opened lazily: a refusal before the first query opens none.
  const sql = openSql(url);
  await closeThenExit(sql, async () => {
    return run({
      sql,
      dryRun: cli.has("dry-run"),
      reapply: cli.has("reapply"),
      grant: cli.value("grant"),
      groups: cli.value("groups"),
      exact: cli.has("exact"),
      // The plugins the brain runs, as the server reads them, and the
      // password of the login role their SQL runs on (SMD-2310); the URL too,
      // which that role's connection is built from.
      plugins: process.env.OB1_PLUGINS,
      pluginPassword: process.env.OB1_PLUGIN_DB_PASSWORD,
      url,
    });
  });
}
