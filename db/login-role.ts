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
 *   its own, whether it is created or already there.
 * - It refuses a role that is a superuser, a member of any other role (it
 *   would hold that role's privileges, and a member of postgres can SET ROLE
 *   to it), or the owner of anything in any database — a relation, schema,
 *   function, type or the database itself (a schema's owner can drop the
 *   tables in it). Such a role is a migrator's, not one to give a service.
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
        const [{ owned }] = (await sql`SELECT (SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = ${found.oid} AND deptype = 'o') + (SELECT count(*) FROM pg_class WHERE relowner = ${found.oid}) AS owned`) as { owned: number }[];
        if (Number(owned) > 0) {
          console.error(`login-role.ts: ${role} owns ${owned} object(s) (a relation, schema, function, type or database, here or in another database), so it is a migrator's role, not one to give a service. Name another role. Nothing changed.`);
          return 2;
        }
      }
      // The verifier holds only base64 and `$:`, so it quotes as it stands; the doubled quote is the rule all the same.
      const verifier = scramVerifier(process.env[passwordEnv]!).replaceAll("'", "''");
      await sql.begin(async (tx) => {
        await tx.unsafe(`${found ? "ALTER" : "CREATE"} ROLE ${quoteIdent(role)} ${ROLE_ATTRIBUTES} CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD '${verifier}'`);
        // A setting made on the role by hand (a search_path, a statement timeout) goes with the rest of what this step does not make.
        if (found) await tx.unsafe(`ALTER ROLE ${quoteIdent(role)} RESET ALL`);
      });
      console.log(`login-role.ts: ${role} ${found ? "updated" : "created"} (${ROLE_ATTRIBUTES}; password from ${passwordEnv}, stored as a SCRAM verifier)`);
      return 0;
    } catch (e) {
      console.error(`login-role.ts: ${(e as Error).message}`);
      return 1;
    }
  });
}
