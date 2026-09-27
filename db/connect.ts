/**
 * connect.ts — how every db/ script reaches its database: the one URL
 * resolver, the one client, the one loopback rule, and the one close-then-exit
 * door (SMD-2302, SMD-2134's second cut).
 *
 * Until this, each script carried its own `--url ?? DATABASE_URL` and its own
 * copy of the refusal, built its own client, and closed it — or did not:
 * hnsw-graph.ts and tier.ts's --replay/--diff called process.exit inside their
 * `try`, so the `finally` that closed the pool never ran. Two scripts asked
 * "may this database be dropped?" and answered differently: tier.ts's refresh
 * trusted an empty host and did not know 0.0.0.0, the test scaffolding refused
 * the one and admitted the other. There is one answer now, below.
 *
 * What a script does with its connection is its own; this module only opens
 * and closes it. The workers get no remote guard: on the dogfood stack they
 * reach `postgres:5432` by service name (SMD-1869), and the guard is for a
 * command that drops a schema.
 */

import { SQL } from "bun";

/** The refusal when no URL was given, the same words in every script. */
export const NO_DATABASE_URL = "No database URL. Pass --url or set DATABASE_URL.";

/**
 * The database URL: the script's `--url`, else DATABASE_URL; exit 2 without
 * one. A blank DATABASE_URL is none (the scanner refuses a blank `--url`). The
 * URL is never printed — it can carry a password (cli.ts's rule).
 */
export function databaseUrl(flag: string | undefined, env: Record<string, string | undefined> = process.env): string {
  const url = flag ?? env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    console.error(NO_DATABASE_URL);
    process.exit(2);
  }
  if (parsedDatabaseUrl(url) === null) {
    console.error(UNPARSEABLE_DATABASE_URL);
    process.exit(2);
  }
  return url;
}

/**
 * The refusal of a URL that does not parse. Bun's client would throw a
 * TypeError whose dump prints the URL whole as its `input` — the password with
 * it, when that holds an unencoded `/`, `#`, `?` or `@` (review pass 1; so it
 * did before SMD-2302). Nothing of it is shown here.
 */
export const UNPARSEABLE_DATABASE_URL = "The database URL does not parse — is its password percent-encoded? (Nothing of it is printed.)";

/**
 * `url` parsed, or null when it is not a Postgres URL the client can take: it
 * must parse, name postgres: or postgresql: (Bun picks another adapter for
 * mysql: or file:), and percent-decode in its user, password and database (a
 * password holding `50%off` parses, then threw a URIError from the client).
 */
function parsedDatabaseUrl(url: string): URL | null {
  if (!URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  try {
    decodeURIComponent(u.username);
    decodeURIComponent(u.password);
    decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  return u;
}

/**
 * A client on `url`. One connection unless the script asks for more (a claim
 * worker takes one per worker and a spare for its heartbeat). The database is
 * the URL's, when it names one: Bun 1.4.0 lets an exported PGDATABASE override
 * the URL's path — `--url …/canary` with PGDATABASE=stable reached stable —
 * where libpq, and the operator, read the URL (review pass 2). A URL that does
 * not parse throws UNPARSEABLE_DATABASE_URL, never the client's own error,
 * which carries the URL.
 */
export function openSql(url: string, opts: { max?: number } = {}): SQL {
  const u = parsedDatabaseUrl(url);
  if (u === null) throw new Error(UNPARSEABLE_DATABASE_URL);
  const database = u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : undefined;
  try {
    return new SQL({ url, max: opts.max ?? 1, ...(database !== undefined ? { database } : {}) });
  } catch {
    throw new Error("The database client refused the URL. (Nothing of it is printed.)");
  }
}

/**
 * The query parameters a libpq tool is handed with its target: transport and
 * labels, none of which choose a server or a database.
 */
export const LIBPQ_KEPT_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "sslcrl", "connect_timeout", "application_name"] as const;

/** The PG* variables a libpq tool keeps: the same kinds, plus the password file. */
const LIBPQ_KEPT_ENV = /^PG(SSL\w*|GSSENCMODE|CONNECT_TIMEOUT|APPNAME|PASSFILE|REQUIRESSL)$/;

/**
 * What a libpq tool (pg_dump, pg_restore) is given to reach the database `sql`
 * reached: a URL rebuilt from the host, port, database and user Bun's client
 * resolved, and an environment with every other PG* variable taken out — the
 * password passed as PGPASSWORD, not on the command line.
 *
 * Handing a libpq tool the operator's URL let it go elsewhere than the client
 * the guards had asked (review pass 2): libpq has no fragment, so
 * `…/db#?host=prod` is a query to it and nothing to Bun; it splits the
 * userinfo at the first `@`, Bun at the last, so `u@prod:5432,x@localhost/db`
 * is prod to one and localhost to the other; it follows `?host=`, `?hostaddr=`,
 * `?port=`, `?dbname=`, `?service=`, PGHOSTADDR and PGSERVICE, which Bun
 * ignores when the URL names a host. Pass 1 refused a list of those shapes,
 * and pass 2 found two more; rebuilding from what the client resolved leaves
 * nothing to list.
 */
export function libpqTarget(sql: SQL, url: string, env: Record<string, string | undefined> = process.env): { url: string; env: Record<string, string> } {
  const o = sql.options as { hostname?: string; port?: number | string; database?: string; username?: string; password?: string };
  const host = String(o.hostname ?? "localhost");
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const kept = new URLSearchParams();
  const given = parsedDatabaseUrl(url)?.searchParams;
  for (const p of LIBPQ_KEPT_PARAMS) { const v = given?.get(p); if (v !== null && v !== undefined) kept.set(p, v); }
  const query = kept.size > 0 ? `?${kept.toString()}` : "";
  const user = o.username ? `${encodeURIComponent(o.username)}@` : "";
  const target = `postgres://${user}${bracketed}:${o.port ?? 5432}/${encodeURIComponent(o.database ?? "")}${query}`;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (!k.startsWith("PG") || LIBPQ_KEPT_ENV.test(k))) childEnv[k] = v;
  if (o.password) childEnv.PGPASSWORD = o.password;
  return { url: target, env: childEnv };
}

// ---------------------------------------------------------------------------
// May this database be reset? Loopback, or an override you have to mean.
// ---------------------------------------------------------------------------

/**
 * The hosts that are this machine, as `new URL(...).hostname` reports them
 * (IPv6 keeps its brackets). Loopback, not "local": config.mjs's
 * isLocalHostname also admits RFC1918 addresses and compose service names,
 * and a LAN-hosted stack holding a real brain is a documented deployment, so
 * that is a different question with a different answer (test-support.ts's
 * sixth review pass). 0.0.0.0 reaches this machine's own listener.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * The override of the loopback rule, named once so a suite that spawns another
 * checked script can pass it on. One name: the test scaffolding also honoured
 * `OB1_EVAL_ALLOW_REMOTE_DB`, the eval-local copy's, but deploy/tier.sh hands
 * tier.ts every OB1_* variable of the stack's env file except this one — it
 * sets this one itself, and never for a --to given as a URL — so a second name
 * read here would have been a way past the wrapper (SMD-2302).
 */
export const REMOTE_DB_FLAG = "OB1_ALLOW_REMOTE_DB";

/** The name no longer read, so a refusal can say so to a shell profile that still sets it. */
export const RETIRED_REMOTE_DB_FLAG = "OB1_EVAL_ALLOW_REMOTE_DB";

/** The URL's hostname, lowercased; `""` for none, `null` when it does not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why `url`'s host is not plainly this machine, or null when it is — the host
 * Bun's client reaches, which is the one the rule is about: a libpq tool gets
 * the same host from libpqTarget, not the operator's URL. An EMPTY host is
 * not: Bun's client resolves `postgres:///db` through PGHOST, as libpq does,
 * so it is whatever the shell says. A URL that does not parse is not either (a
 * libpq socket URL, `postgres://u@/db?host=/var/run/…`, is one; the client
 * does not honour that form, and the override is the way through for it). The
 * reason names the hostname at most, never the rest of the URL.
 */
export function notThrowaway(url: string): string | null {
  const host = hostOf(url);
  if (host === null) return "the URL does not parse";
  if (host === "") return "the URL has no host (the client would resolve PGHOST)";
  if (!LOOPBACK_HOSTS.has(host)) return `${host} is not a loopback host`;
  return null;
}

/** Is `url`'s host plainly this machine? (notThrowaway's yes.) */
export function isThrowawayHost(url: string): boolean {
  return notThrowaway(url) === null;
}

/** Has the operator said a non-loopback database may be reset? Exactly "1". */
export function remoteDbAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[REMOTE_DB_FLAG] === "1";
}

/**
 * The one rule, as the refusal a script prints: null when a command that drops
 * a schema may run against `url`, else why not.
 */
export function resetRefusal(url: string, env: Record<string, string | undefined> = process.env): string | null {
  return remoteDbAllowed(env) ? null : notThrowaway(url);
}

/** The one rule: a command that drops a schema may run against `url`. */
export function mayReset(url: string, env: Record<string, string | undefined> = process.env): boolean {
  return resetRefusal(url, env) === null;
}

// ---------------------------------------------------------------------------
// Close, then exit.
// ---------------------------------------------------------------------------

/** What the door closes: a client (Bun's SQL has this shape). */
export interface Closeable {
  close(): Promise<unknown>;
}

/**
 * Run `body`, close every pool, then exit with the code `body` returned. The
 * body decides a code and returns it; it does not call process.exit, which
 * would skip the close (test-connect.ts holds that for every script on the
 * door). A throw still closes, then propagates — to the script's own handler,
 * or to Bun's, which exits 1. A pool that fails to close, even by throwing
 * rather than rejecting, does not keep the others open. When the body returns,
 * what it wrote reaches a pipe before the exit: process.stdout.write is
 * asynchronous there, and an exit cut a 5 MB write short (review pass 1). (A
 * throw is not flushed here: its handler still has to write.) A code that is
 * not an exit status (0–255) exits 1, not whatever the runtime makes of it —
 * 256 would read as 0. An exit handler's own process.stdout.write after the
 * door is dropped; console.* and crash messages still print.
 */
export async function closeThenExit(pools: Closeable | readonly Closeable[], body: () => Promise<number>): Promise<never> {
  const all = Array.isArray(pools) ? pools : [pools as Closeable];
  let code: number;
  try {
    code = await body();
  } finally {
    await Promise.allSettled(all.map((p) => Promise.resolve().then(() => p.close())));
  }
  await Promise.all([ended(process.stdout), ended(process.stderr)]);
  process.exit(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1);
}

/**
 * Resolves once everything written to `stream` has been handed on. Ending it
 * is the one signal Bun keeps: an empty write's callback, writableLength and
 * writableNeedDrain all said "done" with 4 MB of 5 still queued. Nothing is
 * written after — the next statement is the exit. (A body that destroys
 * process.stdout hangs here: Bun then neither calls back nor reports the
 * stream destroyed, and no bound on the wait would spare a slow reader. No
 * script does that; review pass 2.)
 */
function ended(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.end(() => resolve());
    } catch {
      resolve();
    }
  });
}
