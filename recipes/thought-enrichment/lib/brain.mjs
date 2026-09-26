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

/** The `KEY=value` lines of an env file; a missing file is no lines. */
export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
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
 * stack; a URL that is not postgres:// is refused by the shim before any
 * query, with its own explanation. Nothing connects until the first query,
 * which answers `{ error }` (a refused connection, a wrong database) — the
 * callers turn that into a failure() and end the run.
 */
export function connect(env) {
  const url = env.SUPABASE_URL || "";
  if (!url) {
    throw new Error(
      "SUPABASE_URL must be set — the brain's postgres:// connection string on this fork, " +
        "in the environment or in .env.local beside the scripts."
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
  return Object.assign(new Error(`${what} → ${code}${error?.message || error}`), { code: error?.code });
}

/**
 * Whether a refused query is worth another try. The REST ladders retried
 * 429 and 5xx; their Postgres shape is a connection lost mid-run (class 08),
 * a serialization failure or deadlock (40001, 40P01) and a server shutting
 * down (57P01). A refused connection is not among them — an operator with the
 * wrong port reads one line now, not after the ladder's half minute — and a
 * 42xxx (an undefined column, a denied table) is structural and never is.
 */
export function isTransientDbError(error) {
  const code = String(error?.code ?? "");
  return code.startsWith("08") || code === "40001" || code === "40P01" || code === "57P01";
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
