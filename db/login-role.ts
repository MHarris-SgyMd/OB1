#!/usr/bin/env bun
/**
 * login-role.ts — create or update one LOGIN role whose password comes from
 * an environment variable, for a compose service that connects as a role of
 * its own (SMD-2289: the orchestration runner's `ob1_orchestration_runner`).
 *
 *   bun db/login-role.ts --role <name> --password-env <VAR> [--url postgres://…]
 *
 * migrate.ts --grant never creates a role or sets a password, so that no
 * credential passes through it. This is the one step that does, for a role a
 * compose file names; the privileges are still --grant's (`--groups`).
 * - The role is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION
 *   and NOBYPASSRLS, with no connection limit, no expiry and no settings of
 *   its own in any database, whether it is created or already there.
 * - It refuses a role that is a superuser, a member of any other role (it
 *   would hold that role's privileges, and a member of postgres can SET ROLE
 *   to it), or the owner of anything in any database — a relation, schema,
 *   function, type, large object or the database itself (a schema's owner can
 *   drop the tables in it). Such a role is not one to give a service. It
 *   refuses, too, when a schema named for the role exists in this database
 *   (first on the role's search_path, "$user"), and when a setting outlives
 *   the reset (a migrator that is not a superuser cannot reset one only a
 *   superuser may set).
 * - Its privileges are not this step's: `migrate.ts --grant --groups …
 *   --exact`, run after it, replaces what the role's grants hold in this
 *   database (schema USAGE, CONNECT and TEMP stay) with the groups' privileges
 *   in one transaction, and refuses one holding a privilege it cannot revoke.
 *   This step commits first, so a refused grant leaves the password set.
 * - The password, read from the named variable, must be 24 or more of
 *   [A-Za-z0-9_-] (`provision.ts --init` writes 64 hex). It is sent as a
 *   SCRAM-SHA-256 verifier computed here, so the password itself is never in
 *   the statement text, which Postgres logs with an error.
 * - Run again, it sets the password again: rotating it is editing the env
 *   file and starting the service.
 * Exit 0 done, 2 refused (nothing changed), 1 failed.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { commandLine } from "./cli.ts";
import { GRANT_LOCK, quoteIdent } from "./config.mjs";
import { closeThenExit, databaseUrl, openSql } from "./connect.ts";

/** A refusal inside the transaction: exit 2, nothing changed. */
class Refusal extends Error {}

/** A role name this step takes: a plain lower-case identifier, so it is quoted the one way. */
export const ROLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
/** A password this step takes: long, and plain enough that no encoding or quoting question arises. */
export const PASSWORD_RE = /^[A-Za-z0-9_-]{24,}$/;
/** The attributes the role holds after this step, created or altered. */
export const ROLE_ATTRIBUTES = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

/**
 * Postgres's stored form of a SCRAM-SHA-256 password (RFC 5802/7677, as
 * `password_encryption = scram-sha-256` stores it): the server keeps this and
 * never the password. An ASCII password needs no SASLprep.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** What is wrong with the step's inputs, or null: the role's name, the variable's name, and the password it holds. */
export function loginRoleProblem(role: string, passwordEnv: string, env: Record<string, string | undefined>): string | null {
  if (!ROLE_NAME_RE.test(role)) return `--role ${JSON.stringify(role)} must be a lower-case identifier (${ROLE_NAME_RE.source})`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(passwordEnv)) return `--password-env ${JSON.stringify(passwordEnv)} must name an environment variable`;
  const password = env[passwordEnv] ?? "";
  if (!password) return `${passwordEnv} is not set: run \`bun deploy/orchestration/provision.ts --init\`, which writes it into deploy/.env`;
  if (!PASSWORD_RE.test(password)) return `${passwordEnv} must be 24 or more of A–Z a–z 0–9 _ - (provision.ts --init writes one)`;
  return null;
}

if (import.meta.main) {
  const cli = commandLine("login-role.ts", { role: "one", "password-env": "one", url: "one" }, { hints: { role: "<name>", "password-env": "<VAR>", url: "<postgres://…>" } });
  const role = cli.value("role");
  const passwordEnv = cli.value("password-env");
  if (role === undefined || passwordEnv === undefined) {
    console.error("login-role.ts needs --role <name> and --password-env <VAR>.");
    process.exit(2);
  }
  const problem = loginRoleProblem(role, passwordEnv, process.env);
  if (problem) {
    console.error(`login-role.ts: ${problem}. Nothing changed.`);
    process.exit(2);
  }
  const sql = openSql(databaseUrl(cli.value("url")), { max: 1 });
  await closeThenExit(sql, async () => {
    // The verifier holds only base64 and `$:`, so it quotes as it stands; the doubled quote is the rule all the same.
    const verifier = scramVerifier(process.env[passwordEnv]!).replaceAll("'", "''");
    const ident = quoteIdent(role);
    let found: { oid: number } | undefined;
    try {
      await sql.begin(async (tx) => {
        // The one lock every `migrate.ts --grant` takes too, taken before the role is looked up: two role steps at once in one database queue rather than both finding no role and colliding on CREATE, or on "tuple concurrently updated" (review passes 3 and 4; an advisory lock is per database, so steps for two databases of one cluster do not queue, and the loser fails and is run again).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${GRANT_LOCK}))`;
        const [row] = (await tx`SELECT oid, rolsuper, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ${role}`) as { oid: number; rolsuper: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean }[];
        if (row?.rolsuper) throw new Refusal(`${role} is a superuser; this step makes a role that is not one, and will not take one that is. Name another role. Nothing changed.`);
        // A schema named for the role is first on its search_path ("$user"), ahead of public: whoever made it decides what the runner's unqualified calls reach (review pass 5, pass 2's attack by another door).
        const [plant] = (await tx`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${role}`) as { owner: string }[];
        if (plant) throw new Refusal(`a schema named ${role} (owned by ${plant.owner}) exists in this database; it comes before public on the role's search_path, so its functions would take the runner's calls. Drop or rename it, or name another role. Nothing changed.`);
        if (row) {
          // A role in another role holds what that one holds, and can SET ROLE into it (a member of postgres is a superuser in all but name); one that owns anything in any database can drop or replace it (a schema's owner drops the tables in it; the database's owns public). Both refused (review pass 1: each was taken).
          const memberOf = ((await tx`SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = ${row.oid} ORDER BY 1`) as { rolname: string }[]).map((r) => r.rolname);
          if (memberOf.length) throw new Refusal(`${role} is a member of ${memberOf.join(", ")}, whose privileges it holds; this step gives a service a role that is a member of none. Name another role, or revoke the membership. Nothing changed.`);
          // pg_shdepend is shared: it holds an owner row for every object the role owns in any database, the database itself included (review pass 2: a pg_class count beside it counted each table again).
          const [{ owned }] = (await tx`SELECT count(*)::int AS owned FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = ${row.oid} AND deptype = 'o'`) as { owned: number }[];
          if (owned > 0) throw new Refusal(`${role} owns ${owned} object(s) (a relation, schema, function, type, large object or database, here or in another database), so it is a migrator's role, not one to give a service. Name another role. Nothing changed.`);
        }
        found = row;
        if (row) {
          // Clearing CREATEDB takes CREATEDB, and REPLICATION or BYPASSRLS a superuser; the driver shows only "permission denied to alter role", not which (review pass 6).
          const [me] = (await tx`SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user`) as { rolsuper: boolean; rolcreatedb: boolean }[];
          const cannot = [row.rolcreatedb && !me.rolsuper && !me.rolcreatedb && "CREATEDB", row.rolreplication && !me.rolsuper && "REPLICATION", row.rolbypassrls && !me.rolsuper && "BYPASSRLS"].filter(Boolean);
          if (cannot.length) throw new Refusal(`${role} holds ${cannot.join(", ")}, which this connection's role may not clear (CREATEDB takes CREATEDB; REPLICATION and BYPASSRLS a superuser). Clear it as a superuser, or name another role. Nothing changed.`);
        }
        // ALTER names only the attributes to clear: Postgres refuses NOCREATEDB, NOREPLICATION and NOBYPASSRLS from a migrator that is not a superuser even when nothing would change (review pass 5: every re-run on a managed Postgres failed "permission denied to alter role").
        const attributes = row ? ["LOGIN NOCREATEROLE", row.rolcreatedb && "NOCREATEDB", row.rolreplication && "NOREPLICATION", row.rolbypassrls && "NOBYPASSRLS"].filter(Boolean).join(" ") : ROLE_ATTRIBUTES;
        await tx.unsafe(`${row ? "ALTER" : "CREATE"} ROLE ${ident} ${attributes} CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD '${verifier}'`);
        if (!row) return;
        // A role that was there loses its settings, the role's own and each database's (review pass 2: a search_path set IN DATABASE survived RESET ALL and sent the runner's unqualified function calls to a planted schema). Its privileges are `migrate.ts --grant --exact`'s to replace, in the grant's own transaction, so a runner in flight never meets a moment without them (review pass 3).
        await tx.unsafe(`ALTER ROLE ${ident} RESET ALL`);
        const settingDbs = (await tx`SELECT d.datname FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = ${row.oid}`) as { datname: string }[];
        for (const { datname } of settingDbs) await tx.unsafe(`ALTER ROLE ${ident} IN DATABASE ${quoteIdent(datname)} RESET ALL`);
        // RESET ALL from a migrator that is not a superuser keeps, without a word, each setting only a superuser may change (review pass 6: session_replication_role = replica survived, and the runner's writes skipped the audit trigger).
        const kept = ((await tx`SELECT coalesce(d.datname, 'every database') AS db, unnest(s.setconfig) AS setting FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = ${row.oid} ORDER BY 1, 2`) as { db: string; setting: string }[]).map((r) => `${r.setting.split("=")[0]} (${r.db})`);
        if (kept.length) throw new Refusal(`${role} keeps setting(s) this connection's role may not reset: ${kept.join(", ")}. Reset them as a superuser (ALTER ROLE ${ident} [IN DATABASE …] RESET ALL), then run this again. Nothing changed.`);
      });
      console.log(`login-role.ts: ${role} ${found ? "updated, its settings cleared" : "created"} (${ROLE_ATTRIBUTES}; password from ${passwordEnv}, stored as a SCRAM verifier)`);
      return 0;
    } catch (e) {
      // A migrator that is not a superuser alters only a role it holds ADMIN OPTION on (Postgres 16: the roles it created); another's is refused so (an attribute it may not clear is refused by name before the ALTER).
      const hint = /^permission denied to alter role/.test((e as Error).message) ? ` — connect as a superuser, or as a role holding ADMIN OPTION on ${role} (the one that created it)` : "";
      console.error(`login-role.ts: ${(e as Error).message}${hint}`);
      return e instanceof Refusal ? 2 : 1;
    }
  });
}
