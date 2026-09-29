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
 * - A role that was there has every privilege it holds in this database
 *   revoked first (tables, sequences, functions, schemas, the database), so
 *   what `migrate.ts --grant` gives it next is all it holds.
 * - It refuses a role that is a superuser, a member of any other role (it
 *   would hold that role's privileges, and a member of postgres can SET ROLE
 *   to it), the owner of anything in any database — a relation, schema,
 *   function, type, large object or the database itself (a schema's owner can
 *   drop the tables in it) — or one still holding a privilege a revoke here
 *   cannot reach (a default privilege naming it, a grant in another
 *   database). Such a role is not one to give a service.
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
import { quoteIdent } from "./config.mjs";
import { closeThenExit, databaseUrl, openSql } from "./connect.ts";

/** A refusal found inside the transaction: exit 2, and the transaction rolled back. */
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
    try {
      const [found] = (await sql`SELECT oid, rolsuper FROM pg_roles WHERE rolname = ${role}`) as { oid: number; rolsuper: boolean }[];
      if (found?.rolsuper) {
        console.error(`login-role.ts: ${role} is a superuser; this step makes a role that is not one, and will not take one that is. Name another role. Nothing changed.`);
        return 2;
      }
      if (found) {
        // A role in another role holds what that one holds, and can SET ROLE into it (a member of postgres is a superuser in all but name); one that owns anything in any database can drop or replace it (a schema's owner drops the tables in it; the database's owns public). Both refused (review pass 1: each was taken).
        const memberOf = ((await sql`SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = ${found.oid} ORDER BY 1`) as { rolname: string }[]).map((r) => r.rolname);
        if (memberOf.length) {
          console.error(`login-role.ts: ${role} is a member of ${memberOf.join(", ")}, whose privileges it holds; this step gives a service a role that is a member of none. Name another role, or revoke the membership. Nothing changed.`);
          return 2;
        }
        // pg_shdepend is shared: it holds an owner row for every object the role owns in any database, the database itself included (review pass 2: a pg_class count beside it counted each table again).
        const [{ owned }] = (await sql`SELECT count(*)::int AS owned FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = ${found.oid} AND deptype = 'o'`) as { owned: number }[];
        if (owned > 0) {
          console.error(`login-role.ts: ${role} owns ${owned} object(s) (a relation, schema, function, type, large object or database, here or in another database), so it is a migrator's role, not one to give a service. Name another role. Nothing changed.`);
          return 2;
        }
      }
      // The verifier holds only base64 and `$:`, so it quotes as it stands; the doubled quote is the rule all the same.
      const verifier = scramVerifier(process.env[passwordEnv]!).replaceAll("'", "''");
      const ident = quoteIdent(role);
      await sql.begin(async (tx) => {
        await tx.unsafe(`${found ? "ALTER" : "CREATE"} ROLE ${ident} ${ROLE_ATTRIBUTES} CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD '${verifier}'`);
        if (!found) return;
        // What this step does not make goes, for a role that was there: its settings, the role's own and each database's (review pass 2: a search_path set IN DATABASE survived RESET ALL and sent the runner's unqualified function calls to a planted schema) ...
        await tx.unsafe(`ALTER ROLE ${ident} RESET ALL`);
        const settingDbs = (await tx`SELECT d.datname FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = ${found.oid}`) as { datname: string }[];
        for (const { datname } of settingDbs) await tx.unsafe(`ALTER ROLE ${ident} IN DATABASE ${quoteIdent(datname)} RESET ALL`);
        // ... and every privilege it holds in this database, so what --grant gives next is all it holds (review pass 2: --groups revokes nothing, and a role granted more before kept it).
        const schemas = (await tx`SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'`) as { nspname: string }[];
        for (const { nspname } of schemas) {
          const s = quoteIdent(nspname);
          for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) await tx.unsafe(`REVOKE ALL ON ALL ${kind} IN SCHEMA ${s} FROM ${ident}`);
          await tx.unsafe(`REVOKE ALL ON SCHEMA ${s} FROM ${ident}`);
        }
        const [{ db }] = (await tx`SELECT current_database() AS db`) as { db: string }[];
        await tx.unsafe(`REVOKE ALL ON DATABASE ${quoteIdent(db)} FROM ${ident}`);
        // What a REVOKE here cannot reach — a default privilege naming it, a grant in another database, on a type or a large object — is refused, and the transaction with it.
        const [{ left }] = (await tx`SELECT count(*)::int AS left FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = ${found.oid} AND deptype = 'a'`) as { left: number }[];
        if (left > 0) throw new Refusal(`${role} still holds ${left} privilege(s) this step cannot revoke here (a default privilege naming it, or a grant in another database, on a type or on a large object); a service's role holds only what --grant gives it. Revoke them, or name another role. Nothing changed.`);
      });
      console.log(`login-role.ts: ${role} ${found ? "updated, its settings and privileges cleared for --grant" : "created"} (${ROLE_ATTRIBUTES}; password from ${passwordEnv}, stored as a SCRAM verifier)`);
      return 0;
    } catch (e) {
      console.error(`login-role.ts: ${(e as Error).message}`);
      return e instanceof Refusal ? 2 : 1;
    }
  });
}
