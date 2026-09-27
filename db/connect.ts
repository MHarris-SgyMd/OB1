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
  if (!URL.canParse(url)) {
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
 * A client on `url`. One connection unless the script asks for more (a claim
 * worker takes one per worker and a spare for its heartbeat). A URL that does
 * not parse throws UNPARSEABLE_DATABASE_URL, never the client's own error,
 * which carries the URL.
 */
export function openSql(url: string, opts: { max?: number } = {}): SQL {
  if (!URL.canParse(url)) throw new Error(UNPARSEABLE_DATABASE_URL);
  try {
    return new SQL({ url, max: opts.max ?? 1 });
  } catch {
    throw new Error("The database client refused the URL. (Nothing of it is printed.)");
  }
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
 * The query parameters and environment variables that send a libpq client
 * somewhere other than the URL's host. Bun's client ignores all of them when
 * the URL names a host, but tier.ts --refresh hands the same URL to
 * pg_restore, which is libpq and follows them — so `--to
 * postgres://localhost/b?host=prod` would pass a hostname-only rule, have its
 * schema dropped on localhost, and be restored into prod (review pass 1; the
 * rule before SMD-2302 read the hostname alone too). `service` reads a
 * pg_service.conf entry, which can name a hostaddr.
 */
export const LIBPQ_REDIRECT_PARAMS = ["host", "hostaddr", "service"] as const;
export const LIBPQ_REDIRECT_ENV = ["PGHOSTADDR", "PGSERVICE"] as const;

/**
 * Why `url` is not plainly this machine, or null when it is. Plainly: a
 * loopback host by name, and nothing a libpq tool would follow elsewhere. An
 * EMPTY host is not: Bun's client resolves `postgres:///db` through PGHOST, as
 * libpq does, so it is whatever the shell says. A URL that does not parse is
 * not either (a libpq socket URL, `postgres://u@/db?host=/var/run/…`, is one;
 * the client does not honour that form, and the override is the way through
 * for it). The reason names the hostname at most, never the rest of the URL.
 */
export function notThrowaway(url: string, env: Record<string, string | undefined> = process.env): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the URL does not parse";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "") return "the URL has no host (the client would resolve PGHOST)";
  if (!LOOPBACK_HOSTS.has(host)) return `${host} is not a loopback host`;
  const param = LIBPQ_REDIRECT_PARAMS.find((p) => parsed.searchParams.has(p));
  if (param) return `the URL's query sets ${param}=, which pg_restore and psql follow instead of its host`;
  const variable = LIBPQ_REDIRECT_ENV.find((v) => (env[v] ?? "") !== "");
  if (variable) return `${variable} is set, which pg_restore and psql follow instead of the URL's host`;
  return null;
}

/** Is `url` plainly this machine, in this environment? (notThrowaway's yes.) */
export function isThrowawayHost(url: string, env: Record<string, string | undefined> = process.env): boolean {
  return notThrowaway(url, env) === null;
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
  return remoteDbAllowed(env) ? null : notThrowaway(url, env);
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
 * rather than rejecting, does not keep the others open. What the body wrote
 * reaches a pipe before the exit: process.stdout.write is asynchronous there,
 * and an exit cut a 5 MB write short (review pass 1). A code that is not an
 * exit status (0–255) exits 1, not whatever the runtime makes of it.
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
 * written after — the next statement is the exit.
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
