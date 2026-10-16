#!/usr/bin/env bun
/**
 * login-role.ts — create or update one LOGIN role whose password comes from
 * an environment variable, for a compose service that connects as a role of
 * its own (SMD-2289: the orchestration runner's `ob1_orchestration_runner`).
 *
 *   bun db/login-role.ts --role <name> --password-env <VAR> [--member-of pg_monitor] [--url postgres://…]
 *
 * migrate.ts --grant never creates a role or sets a password, so that no
 * credential passes through it. This is the one step that does, for a role a
 * compose file names; the privileges are --grant's (`--groups`), or the one
 * predefined role's that `--member-of` names (SMD-1849 PR 3b's `ob1_monitor`,
 * a member of pg_monitor, which no --grant runs for).
 * - The role is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION
 *   and NOBYPASSRLS, with no connection limit, no expiry and no settings of
 *   its own in any database, whether it is created or already there.
 * - It refuses a role that is a superuser, a member of any other role (it
 *   would hold that role's privileges, and a member of postgres can SET ROLE
 *   to it) but the one `--member-of` names, or of that one WITH ADMIN OPTION
 *   (it could hand the membership on), or the owner of anything in any
 *   database — a relation, schema, function, type, large object, user
 *   mapping or the database itself (a schema's owner can drop the tables in
 *   it). With `--member-of`, it refuses a role that has members of its own,
 *   who would hold the membership through it or could grant it themselves,
 *   but for the migrator's own rows when it is no superuser (Postgres 16
 *   makes a creator a member of each role it creates). The membership is
 *   granted without ADMIN OPTION, and inherited: the role INHERIT, and on
 *   Postgres 16 the grant WITH INHERIT TRUE, SET FALSE. Such a role is not
 *   one to give a service. It refuses, too, when a schema named for the role exists in
 *   this database (first on the role's search_path, "$user"), when the role
 *   holds an attribute this connection may not clear, and when a setting
 *   outlives the reset (a migrator that is not a superuser cannot reset one
 *   only a superuser may set).
 * - Its privileges on the brain are not this step's: `migrate.ts --grant --groups …
 *   --exact`, run after it, replaces what the role's grants hold in this
 *   database (schema USAGE, CONNECT and TEMP stay) with the groups' privileges
 *   in one transaction, and refuses one holding a privilege it cannot revoke.
 *   This step commits first, so a refused grant leaves the password set.
 * - The password, read from the named variable, must be 24 or more of
 *   [A-Za-z0-9_-] (`provision.ts --init` writes 64 hex for the runner's,
 *   `openssl rand -hex 32` makes one for any other). It is sent as a
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
/**
 * The roles `--member-of` may name: Postgres's predefined monitoring role
 * alone, which reads statistics and settings and writes nothing — what the
 * observability profile's exporter needs to see each role's statements in
 * pg_stat_statements and pg_stat_activity (SMD-1849 PR 3b). A role in any
 * other holds that role's privileges, so the list is held here, not given.
 */
export const MEMBER_OF_ALLOWED = ["pg_monitor"] as const;
/** The password variables a script writes, and the command that writes each; the rest are the operator's to set. */
export const PASSWORD_WRITERS: Record<string, string> = { OB1_RUNNER_DB_PASSWORD: "bun deploy/orchestration/provision.ts --init" };
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

/** What is wrong with the step's inputs, or null: the role's name, the variable's name, the password it holds, and the one membership asked for. */
export function loginRoleProblem(role: string, passwordEnv: string, env: Record<string, string | undefined>, memberOf?: string): string | null {
  if (!ROLE_NAME_RE.test(role)) return `--role ${JSON.stringify(role)} must be a lower-case identifier (${ROLE_NAME_RE.source})`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(passwordEnv)) return `--password-env ${JSON.stringify(passwordEnv)} must name an environment variable`;
  if (memberOf !== undefined && !(MEMBER_OF_ALLOWED as readonly string[]).includes(memberOf)) return `--member-of ${JSON.stringify(memberOf)} is not one this step grants (${MEMBER_OF_ALLOWED.join(", ")}): a member holds that role's privileges`;
  const password = env[passwordEnv] ?? "";
  const writer = PASSWORD_WRITERS[passwordEnv];
  if (!password) return `${passwordEnv} is not set: ${writer ? `run \`${writer}\`, which writes it into deploy/.env, or set` : "set"} 24 or more of A–Z a–z 0–9 _ - in deploy/.env${writer ? " yourself" : ""} (openssl rand -hex 32)`;
  if (!PASSWORD_RE.test(password)) return `${passwordEnv} must be 24 or more of A–Z a–z 0–9 _ - (${writer ? `${writer.replace(/^bun deploy\/orchestration\//, "")} writes one` : "openssl rand -hex 32 makes one"})`;
  return null;
}

if (import.meta.main) {
  const cli = commandLine("login-role.ts", { role: "one", "password-env": "one", "member-of": "one", url: "one" }, { hints: { role: "<name>", "password-env": "<VAR>", "member-of": "<pg_monitor>", url: "<postgres://…>" } });
  const role = cli.value("role");
  const passwordEnv = cli.value("password-env");
  const memberOfAsked = cli.value("member-of");
  if (role === undefined || passwordEnv === undefined) {
    console.error("login-role.ts needs --role <name> and --password-env <VAR>.");
    process.exit(2);
  }
  const problem = loginRoleProblem(role, passwordEnv, process.env, memberOfAsked);
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
        const [{ pg16 }] = (await tx`SELECT current_setting('server_version_num')::int >= 160000 AS pg16`) as { pg16: boolean }[];
        if (row) {
          // A role in another role holds what that one holds, and can SET ROLE into it (a member of postgres is a superuser in all but name); one that owns anything in any database can drop or replace it (a schema's owner drops the tables in it; the database's owns public). Both refused (review pass 1: each was taken).
          const memberships = (await tx`SELECT g.rolname, m.admin_option, pg_get_userbyid(m.grantor) AS grantor FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = ${row.oid} ORDER BY 1, 3`) as { rolname: string; admin_option: boolean; grantor: string }[];
          const memberOf = [...new Set(memberships.map((r) => r.rolname).filter((r) => r !== memberOfAsked))];
          if (memberOf.length) throw new Refusal(`${role} is a member of ${memberOf.join(", ")}, whose privileges it holds; this step gives a service a role that is a member of ${memberOfAsked ?? "none"}${memberOfAsked ? " alone" : ""}. Name another role, or revoke the membership. Nothing changed.`);
          // A membership WITH ADMIN OPTION lets the role grant it on, to any role it reaches (review pass 1 of PR 3b); GRANT again does not take the option back. Postgres 16 keeps one row per grantor, so each is named (review pass 2: a REVOKE without GRANTED BY left another grantor's).
          const admin = memberships.filter((r) => r.rolname === memberOfAsked && r.admin_option);
          if (admin.length) throw new Refusal(`${role} is a member of ${memberOfAsked} WITH ADMIN OPTION, so it could grant ${memberOfAsked} to another role; this step gives a service the membership alone. ${admin.map((r) => `As ${r.grantor} or a superuser: REVOKE ADMIN OPTION FOR ${quoteIdent(memberOfAsked!)} FROM ${ident} GRANTED BY ${quoteIdent(r.grantor)};`).join(" ")} Or name another role. Nothing changed.`);
          // A member of the role holds what it holds, the membership granted here among it, and one WITH ADMIN OPTION can grant itself the rest (review passes 1 and 3 of PR 3b) — every member but this connection's role: Postgres 16 makes a creator that is no superuser a member of each role it creates (ADMIN alone, or with INHERIT and SET under createrole_self_grant), and a role that grants the membership here holds it already or is a superuser (review passes 2 and 3: those rows refused every re-run as such a role).
          // A superuser migrator is never made a member of what it creates, so its own rows are exempt only when it is no superuser: one put there by hand would pass pg_monitor to its inheriting members (review pass 4). Each row's REVOKE is printed with its grantor, CASCADE taking a grant that depends on it (a creator's self-grant on its ADMIN row).
          const members = memberOfAsked === undefined ? [] : ((await tx`SELECT r.rolname, pg_get_userbyid(m.grantor) AS grantor FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = ${row.oid} AND NOT (r.rolname = current_user AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) ORDER BY 1, 2`) as { rolname: string; grantor: string }[]);
          if (members.length) {
            const names = [...new Set(members.map((r) => r.rolname))];
            throw new Refusal(`${names.join(", ")} ${names.length === 1 ? "is a member" : "are members"} of ${role}, and would hold ${memberOfAsked} through it or could grant it to itself. ${members.map((r) => `As ${r.grantor} or a superuser: REVOKE ${ident} FROM ${quoteIdent(r.rolname)} GRANTED BY ${quoteIdent(r.grantor)} CASCADE;`).join(" ")} Or name another role. Nothing changed.`);
          }
          // pg_shdepend is shared: it holds an owner row for every object the role owns in any database, the database itself included (review pass 2: a pg_class count beside it counted each table again).
          const [{ owned }] = (await tx`SELECT count(*)::int AS owned FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = ${row.oid} AND deptype = 'o'`) as { owned: number }[];
          if (owned > 0) throw new Refusal(`${role} owns ${owned} object(s) (a relation, schema, function, type, large object, user mapping or database, here or in another database), so it is a migrator's role, not one to give a service. Name another role. Nothing changed.`);
          // Who may clear an attribute: on Postgres 16 a role holding it (with ADMIN OPTION on the role); on 15 CREATEROLE clears CREATEDB, and REPLICATION or BYPASSRLS take a superuser. The driver shows only "permission denied to alter role", not which (review passes 6-8).
          const [me] = (await tx`SELECT rolsuper, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`) as { rolsuper: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean }[];
          const cannot = me.rolsuper ? [] : [row.rolcreatedb && pg16 && !me.rolcreatedb && "CREATEDB", row.rolreplication && !(pg16 && me.rolreplication) && "REPLICATION", row.rolbypassrls && !(pg16 && me.rolbypassrls) && "BYPASSRLS"].filter(Boolean);
          if (cannot.length) throw new Refusal(`${role} holds ${cannot.join(", ")}, which this connection's role may not clear (${pg16 ? "on Postgres 16 and later only a role holding the attribute may" : "on Postgres 15 REPLICATION and BYPASSRLS take a superuser"}). Clear it as a superuser, or name another role. Nothing changed.`);
        }
        found = row;
        // ALTER names only the attributes to clear: Postgres refuses NOCREATEDB, NOREPLICATION and NOBYPASSRLS from a migrator that is not a superuser even when nothing would change (review pass 5: every re-run on a managed Postgres failed "permission denied to alter role").
        // INHERIT where a membership is asked for: a NOINHERIT role holds none of its privileges (review pass 2).
        const attributes = (row ? ["LOGIN NOCREATEROLE", row.rolcreatedb && "NOCREATEDB", row.rolreplication && "NOREPLICATION", row.rolbypassrls && "NOBYPASSRLS"].filter(Boolean).join(" ") : ROLE_ATTRIBUTES) + (memberOfAsked !== undefined ? " INHERIT" : "");
        await tx.unsafe(`${row ? "ALTER" : "CREATE"} ROLE ${ident} ${attributes} CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD '${verifier}'`);
        // The one membership asked for, from the allow-list (loginRoleProblem), granted with no option to pass it on, and on Postgres 16 inherited, this grant with no SET ROLE into it (review pass 3; another grantor's row keeps its own), however an earlier grant set it (WITH INHERIT FALSE held none of its privileges, review pass 2); granting it again changes nothing.
        if (memberOfAsked !== undefined) {
          await tx.unsafe(`GRANT ${quoteIdent(memberOfAsked)} TO ${ident}${pg16 ? " WITH INHERIT TRUE, SET FALSE" : ""}`);
          const [{ holds }] = (await tx`SELECT pg_has_role(${role}, ${memberOfAsked}, 'USAGE') AS holds`) as { holds: boolean }[];
          if (!holds) throw new Refusal(`${role} is a member of ${memberOfAsked} but would not hold its privileges after this step (pg_has_role … USAGE is false). Name another role. Nothing changed.`);
        }
        if (!row) return;
        // A role that was there loses its settings, the role's own and each database's (review pass 2: a search_path set IN DATABASE survived RESET ALL and sent the runner's unqualified function calls to a planted schema). Its privileges are `migrate.ts --grant --exact`'s to replace, in the grant's own transaction, so a runner in flight never meets a moment without them (review pass 3).
        await tx.unsafe(`ALTER ROLE ${ident} RESET ALL`);
        const settingDbs = (await tx`SELECT d.datname FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = ${row.oid}`) as { datname: string }[];
        for (const { datname } of settingDbs) await tx.unsafe(`ALTER ROLE ${ident} IN DATABASE ${quoteIdent(datname)} RESET ALL`);
        // RESET ALL from a migrator that is not a superuser keeps, without a word, each setting only a superuser may change (review pass 6: session_replication_role = replica survived, and the runner's writes skipped the audit trigger).
        const kept = ((await tx`SELECT coalesce(d.datname, 'every database') AS db, unnest(s.setconfig) AS setting FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = ${row.oid} ORDER BY 1, 2`) as { db: string; setting: string }[]).map((r) => `${r.setting.split("=")[0]} (${r.db})`);
        if (kept.length) throw new Refusal(`${role} keeps setting(s) this connection's role may not reset: ${kept.join(", ")}. Reset them as a superuser (ALTER ROLE ${ident} [IN DATABASE …] RESET ALL), then run this again. Nothing changed.`);
      });
      console.log(`login-role.ts: ${role} ${found ? "updated, its settings cleared" : "created"} (${ROLE_ATTRIBUTES}${memberOfAsked ? `, a member of ${memberOfAsked}` : ""}; password from ${passwordEnv}, stored as a SCRAM verifier)`);
      return 0;
    } catch (e) {
      // A migrator that is not a superuser alters only a role it holds ADMIN OPTION on (Postgres 16: the roles it created); another's is refused so (an attribute it may not clear is refused by name before the ALTER).
      const message = (e as Error).message;
      const hint = /^permission denied to alter role/.test(message)
        ? ` — connect as a superuser, or as a role holding ADMIN OPTION on ${role} (the one that created it)`
        : /^permission denied to grant role/.test(message)
        ? ` — connect as a superuser, or as a role holding ${memberOfAsked ?? "that role"} WITH ADMIN OPTION (Postgres 16 and later)`
        : "";
      console.error(`login-role.ts: ${message}${hint}`);
      return e instanceof Refusal ? 2 : 1;
    }
  });
}
