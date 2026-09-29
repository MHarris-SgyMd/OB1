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
 *   and NOBYPASSRLS, whether it is created or already there.
 * - It refuses a role that is a superuser or owns a relation in this
 *   database: that is a migrator's role, and making it a runner's would take
 *   what the migrator needs.
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
      const [found] = (await sql`SELECT rolsuper FROM pg_roles WHERE rolname = ${role}`) as { rolsuper: boolean }[];
      if (found?.rolsuper) {
        console.error(`login-role.ts: ${role} is a superuser; this step makes a role that is not one, and will not take one that is. Name another role. Nothing changed.`);
        return 2;
      }
      const [{ n }] = (await sql`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = ${role}`) as { n: number }[];
      if (n > 0) {
        console.error(`login-role.ts: ${role} owns ${n} relation(s) in this database, so it is a migrator's role, not one to give a service. Name another role. Nothing changed.`);
        return 2;
      }
      // The verifier holds only base64 and `$:`, so it quotes as it stands; the doubled quote is the rule all the same.
      const verifier = scramVerifier(process.env[passwordEnv]!).replaceAll("'", "''");
      await sql.unsafe(`${found ? "ALTER" : "CREATE"} ROLE ${quoteIdent(role)} ${ROLE_ATTRIBUTES} PASSWORD '${verifier}'`);
      console.log(`login-role.ts: ${role} ${found ? "updated" : "created"} (${ROLE_ATTRIBUTES}; password from ${passwordEnv}, stored as a SCRAM verifier)`);
      return 0;
    } catch (e) {
      console.error(`login-role.ts: ${(e as Error).message}`);
      return 1;
    }
  });
}
