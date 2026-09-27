/**
 * The brain's client for the three scripts (SMD-2139): compat/supabase-sql
 * under bun. Until SMD-2139 each script spoke to PostgREST's `/thoughts` route
 * with a service-role key, and this fork's stack runs no PostgREST. Here
 * SUPABASE_URL is the brain's postgres:// connection string (the name did not
 * change), SUPABASE_SERVICE_ROLE_KEY is accepted and ignored — the credentials
 * live in the URL — and a variable in the environment wins over the recipe's
 * `.env.local`, as it does in the other ported recipes.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "../../../compat/supabase-sql/index.ts";

/**
 * The `KEY=value` lines of an env file; a missing file is no lines. A leading
 * `export ` is dropped, a quoted value is unquoted, and an unquoted value ends
 * at a ` #` comment — the three spellings a shell-style file carries that the
 * original loader read as part of the value (a trailing comment reached
 * Postgres inside the database name).
 */
export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let val = trimmed.slice(eq + 1).trim();
    const quoted = /^(["'])(.*)\1\s*(#.*)?$/.exec(val);
    val = quoted ? quoted[2] : val.replace(/\s+#.*$/, "");
    env[trimmed.slice(0, eq).trim()] = val;
  }
  return env;
}

/**
 * The recipe's configuration: `.env.local` beside the scripts (`recipeDir`),
 * every name the process environment sets on top of it.
 */
export function readEnv(recipeDir) {
  return { ...loadEnvFile(path.join(recipeDir, ".env.local")), ...process.env };
}

/**
 * The shim's client for the brain `env` names. No URL is one line, not a
 * stack. A value that is not a postgres:// string is refused HERE, naming its
 * scheme and never the value: the shim's own refusal quotes the first forty
 * characters of what it was given, which since this port carry the role's
 * password (a mistyped scheme printed it). Nothing
 * connects until the first query, which answers `{ error }` (a refused
 * connection, a wrong database) — the callers turn that into a failure() and
 * end the run.
 */
export function connect(env) {
  const url = (env.SUPABASE_URL || "").trim();
  if (!url) {
    throw new Error(
      "SUPABASE_URL must be set — the brain's postgres:// connection string on this fork, " +
        "in the environment or in .env.local beside the scripts."
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    // A scheme is named only when `://` follows it: the first colon-delimited
    // token of a value pasted without its scheme is the user name, or the
    // password.
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1];
    throw new Error(
      `SUPABASE_URL must be a postgres:// connection string; the value's scheme is ${scheme ? `"${scheme}:"` : "missing"} ` +
        "(a Supabase project URL from an older .env.local is not this fork's value). " +
        "The value is not printed: it carries the role's password."
    );
  }
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY || undefined);
}

/**
 * The error a refused query becomes: the message names the operation and
 * Postgres's code (the driver's own name for a connection that never opened),
 * and the code rides along for a caller that branches on it.
 */
export function failure(what, error) {
  const code = error?.code ? `${error.code} ` : "";
  // `brain: true` marks the error as the database's: a caller that ends a run
  // on a structural refusal tests the mark, not the code — Bun's fetch errors
  // carry codes too (ConnectionRefused, ENOTFOUND), and a model outage is a
  // per-row failure, not a refusal.
  return Object.assign(new Error(`${what} → ${code}${error?.message || error}`), { code: error?.code, brain: true });
}

/**
 * Whether a refused query is worth another try. The REST ladders retried
 * 429 and 5xx; their Postgres shape is a serialization failure or deadlock
 * (40001, 40P01), a server shutting down (57P01), a server-sent connection
 * exception (class 08) and the driver's own name for a socket that closed
 * under a query (ERR_POSTGRES_CONNECTION_CLOSED — Bun reports a dropped
 * connection that way, with no SQLSTATE, and it is what the query after a
 * 57P01 answers; probed). A refused connection is not among them — an
 * operator with the wrong port reads one line now, not after the ladder's
 * half minute — and a 42xxx (an undefined column, a denied table) is
 * structural and never is. A pool reconnecting to a server that is still
 * starting answers ERR_POSTGRES_CONNECTION_FAILED ("closed before the
 * connection was established"), so it rides along. The live suite drives
 * neither closed-socket case: it would take killing a backend mid-run.
 */
export function isTransientDbError(error) {
  const code = String(error?.code ?? "");
  return code.startsWith("08") || code === "40001" || code === "40P01" || code === "57P01" || code === "ERR_POSTGRES_CONNECTION_CLOSED" || code === "ERR_POSTGRES_CONNECTION_FAILED";
}

/**
 * An integer flag's value: digits alone, at least `min`; anything else is
 * refused naming the flag (`parseInt` read `1.5` as 1 and `foo` as NaN, and
 * `--concurrency 0` spun forever).
 */
export function intFlag(raw, flag, min = 0) {
  if (raw === undefined || !/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min) {
    throw new Error(`${flag} must be an integer${min > 0 ? ` of at least ${min}` : ""}; got "${raw ?? ""}"`);
  }
  return Number(raw);
}

/**
 * A flag no script knows is refused, not ignored: `--dryrun` for `--dry-run`
 * would have written every row. `known` names the
 * flags; `withValue` the ones whose next token is their value — which must be
 * there and not another flag, and is never given as `--flag=value`: both
 * forms passed this check and were then ignored by the scripts' parsers, so
 * `--limit=2` and a trailing `--limit` ran unbounded.
 */
export function refuseUnknownFlags(argv, known, withValue = []) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.includes("=") && a.startsWith("--")) {
      const name = a.slice(0, a.indexOf("="));
      throw new Error(known.includes(name) ? `${name} takes its value as the next argument, not after "="` : `unknown flag "${name}" (flags: ${known.join(", ")})`);
    }
    if (known.includes(a)) {
      if (withValue.includes(a)) {
        if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${a} needs a value`);
        i++;
      }
      continue;
    }
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}" (flags: ${known.join(", ")})`);
    throw new Error(`unknown flag "${a}" (flags: ${known.join(", ")})`);
  }
}

/**
 * A run's end, on both paths: the pool is closed so the process ends on its
 * own with the code set (its connections would keep it alive), and a failure
 * is one line on stderr — `ERROR: <message>` — with the stack under DEBUG.
 * `client` is read at the end, so a run that never connected closes nothing.
 */
export function endWith(run, client) {
  return run
    .then(
      () => client()?.close(),
      async (err) => {
        console.error(`ERROR: ${err?.message || err}`);
        if (process.env.DEBUG) console.error(err);
        process.exitCode = 1;
        await client()?.close();
      }
    )
    .catch((err) => {
      console.error(`ERROR: failed to close the pool: ${err?.message || err}`);
      process.exitCode = 1;
    });
}
