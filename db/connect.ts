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
  const problem = databaseUrlProblem(url);
  if (problem !== null) {
    console.error(problem);
    process.exit(2);
  }
  return url;
}

/**
 * The refusal of a URL that does not parse. Bun's client would throw a
 * TypeError whose dump prints the URL whole as its `input` — the password with
 * it, when an unencoded `/`, `#` or `?` in it breaks the parse (review pass 1;
 * so it did before SMD-2302). Nothing of it is shown here. (When the part
 * before that character reads as a port, the URL parses as another host and
 * path instead, as it did before; tier.ts's where() asks about that shape.)
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
 * The query keys a database URL may carry. Both readers of a URL here take
 * these the same way, and neither goes anywhere else for them. `options` is
 * the documented route for a session's search_path (`-c search_path=…`, the
 * value preflight prints when pgvector sits off the path, SMD-2238); it sets
 * settings on the server Bun and libpq both reach, and names no host,
 * database or user. Any other key is refused (SMD-2317), because the readers
 * split on it:
 *   • Bun 1.4.0 sends every key it does not consume to the server as a startup
 *     setting, and the server keeps the last one, so `…/stable?database=canary`
 *     connects to canary and `?user=` logs in as someone else, while the
 *     client's options still name the URL's. `?path=` connects over a unix
 *     socket whatever the host says.
 *   • libpq (pg_dump, pg_restore) follows `host=`, `hostaddr=`, `port=`,
 *     `dbname=` and `service=` wherever the URL's host points.
 * The repo and its docs put no other key on a database URL: a grep for
 * literal URLs found none (SMD-2302 review pass 3), and the suites that build
 * one at run time add `options=` alone (test-upgrade, test-search-path,
 * test-preflight).
 */
export const URL_QUERY_KEYS: ReadonlySet<string> = new Set(["sslmode", "application_name", "options"]);

/**
 * Why `url` is not a database URL every reader here takes to the same place,
 * or null when it is. The reason never quotes the URL; it names a query key
 * only when the key is a plain word.
 *   • It must parse (parsedDatabaseUrl), start with a lowercase `postgres://`
 *     or `postgresql://`, and hold no whitespace or control character.
 *   • No fragment. libpq has none, so `…/db#?host=prod` is a query to it and
 *     nothing to Bun.
 *   • No `@` but the one that ends the user. libpq ends the user at the first
 *     `@` and Bun at the last, so `u@prod:5432,x@localhost/db` sends libpq to
 *     prod first. libpq also reads up to an `@` past a `?`, so one in a query
 *     value splits it too.
 *   • No `,` (or `%2C`) in the host: libpq reads a host list, and Bun one name.
 *   • A path the parser leaves as written, decoded: it resolves `.` and `..`
 *     segments, and libpq does not.
 *   • No `+` in the query: Bun decodes it as a space, and libpq does not.
 *   • Every query part a `key=value` with one raw `=`, and sslmode in
 *     lowercase: libpq refuses the rest, which Bun reads.
 *   • Only URL_QUERY_KEYS in the query, each once.
 * Checked before the URL reaches a client, so a refused URL opens no
 * connection (test-connect.ts counts them).
 */
export function databaseUrlProblem(url: string): string | null {
  if (!parses(url)) return UNPARSEABLE_DATABASE_URL;
  const split = readersSplit(url);
  if (split === null) return null;
  return `The database URL ${split}. (Nothing ${split.includes("the query key ") ? "else " : ""}of it is printed.)`;
}

/** Whether `url` parses as a URL both readers take: parsedDatabaseUrl, an exact scheme, no whitespace. */
function parses(url: string): boolean {
  // The parser strips leading and trailing spaces and drops a tab or newline
  // anywhere, and lowercases the scheme; libpq does none of that, and takes a
  // URL only after an exact `postgres://` or `postgresql://`.
  return parsedDatabaseUrl(url) !== null && /^postgres(ql)?:\/\//.test(url) && !/[\s\x00-\x1f\x7f]/.test(url);
}

/** Where Bun and libpq read a URL that parses differently, as the end of a sentence about it; null when they agree. */
function readersSplit(url: string): string | null {
  const u = new URL(url);
  if (url.includes("#")) return "has a fragment (a # not percent-encoded as %23): libpq reads what follows it as the query, and Bun drops it";
  const rest = url.slice(url.indexOf("//") + 2);
  const ats = [...rest].filter((c) => c === "@").length;
  const authorityEnd = rest.search(/[/?]/);
  if (ats > 1 || (ats === 1 && authorityEnd !== -1 && rest.indexOf("@") > authorityEnd)) {
    return "has an @ other than the one ending its user (percent-encode it as %40): libpq ends the user at the first @, and Bun at the last";
  }
  if (u.hostname.includes(",") || u.hostname.toLowerCase().includes("%2c")) return "names a host list (a , in its host, or %2C, which libpq decodes to one): libpq tries each host, and Bun reads one name";
  // The parser resolves dot segments in the path and libpq reads the path as
  // written: `/x/../canary` reaches canary in Bun and a database named
  // `x/../canary` in libpq (review pass 1, measured with both). Compared
  // decoded, since the parser also percent-encodes characters both readers
  // agree on (`/café` is `/caf%C3%A9` to it, café to both; review pass 2).
  if (authorityEnd !== -1 && rest[authorityEnd] === "/") {
    const q = rest.indexOf("?", authorityEnd);
    let same = false;
    try {
      same = decodeURIComponent(rest.slice(authorityEnd, q === -1 ? undefined : q)) === decodeURIComponent(u.pathname);
    } catch {
      /* a bad escape in the raw path: not the same */
    }
    if (!same) return "has a path the parser rewrites (a . or .. segment): Bun reads the rewritten path, and libpq the path as written";
  }
  // Bun decodes a + in a query value as a space, and libpq keeps it: an
  // options value of `-c+search_path=x` is `-c search_path=x` to one and a
  // setting named "+search_path" to the other (review pass 1).
  if (u.search.includes("+")) return "has a + in its query: Bun reads it as a space and libpq as a +, so write %20 or %2B";
  // libpq refuses a query part that is empty, has no `=`, or has a second
  // raw `=`, where Bun reads each: a refresh then dropped --to and failed its
  // restore on `?application_name=x=y` (review pass 2, measured).
  for (const part of u.search.slice(1).split("&")) {
    if (u.search === "") break;
    if (part === "" || !part.includes("=")) return "has a query part with no key=value (an empty part, or a key with no =): libpq refuses it, and Bun reads it";
    if (part.indexOf("=") !== part.lastIndexOf("=")) return "has a second = in a query value (percent-encode it as %3D): libpq refuses it, and Bun reads it";
  }
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode !== null && sslmode !== sslmode.toLowerCase()) return "gives sslmode in capitals: libpq reads its values in lowercase only, and Bun in either";
  const seen = new Set<string>();
  for (const key of u.searchParams.keys()) {
    const named = /^[A-Za-z_]{1,40}$/.test(key) ? `the query key ${key}` : "a query key";
    if (!URL_QUERY_KEYS.has(key)) {
      return `carries ${named}, and only sslmode, application_name and options are read here: Bun sends any other key to the server as a setting (database= and user= override the URL's), and libpq follows host=, port=, dbname= and service=. Put the database in the URL's path`;
    }
    if (seen.has(key)) return `gives ${named} twice`;
    seen.add(key);
  }
  return null;
}

/**
 * The database `url` names: its path, percent-decoded, as Bun reads it (a
 * path of `/c%61nary` reaches canary, and `/a/b` a database named `a/b`,
 * measured on Bun 1.4.0). `""` when the path names none, and the client then
 * takes PGDATABASE's, or the user's name. Call it on a URL
 * databaseUrlProblem has passed.
 */
export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/**
 * A client on `url`. One connection unless the script asks for more (a claim
 * worker takes one per worker and a spare for its heartbeat). A URL
 * databaseUrlProblem refuses throws that reason, never the client's own
 * error, which carries the URL.
 *
 * What the client makes of a URL that passes is still the client's: Bun 1.4.0
 * lets an exported PGDATABASE beat the URL's database. A command that drops a
 * schema asks the connection where it went (connectedResetRefusal) rather than
 * trusting the URL. Pinning the URL's database here instead split a run
 * across two databases, since the suites and sync-linear's SqlStore build
 * clients of their own (SMD-2302 review pass 3).
 */
export function openSql(url: string, opts: { max?: number } = {}): SQL {
  const problem = databaseUrlProblem(url);
  if (problem !== null) throw new Error(problem);
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
 * Why `url`'s host is not plainly this machine, or null when it is. An EMPTY
 * host is not: Bun's client resolves `postgres:///db` through PGHOST, as libpq
 * does, so it is whatever the shell says. A URL that does not parse is not
 * either (a libpq socket URL, `postgres://u@/db?host=/var/run/…`, is one). The
 * reason names the hostname at most, never the rest of the URL.
 *
 * It reads the URL's hostname, as both rules before SMD-2302 did. It is the
 * half of the rule OB1_ALLOW_REMOTE_DB lifts. The server's own address cannot
 * answer it instead: through a container's published port (with-postgres.sh,
 * CI's service container) a connection to 127.0.0.1 reaches a server whose
 * inet_server_addr() is the container's (10.88.x.x, measured), which is how
 * an ssh tunnel to a remote server looks too (SMD-2317).
 */
export function notThrowaway(url: string): string | null {
  const host = hostOf(url);
  if (host === null) return "the URL does not parse";
  if (host === "") return "the URL has no host (the client would resolve PGHOST)";
  if (!LOOPBACK_HOSTS.has(host)) return `${host} is not a loopback host`;
  return null;
}

/** Has the operator said a non-loopback database may be reset? Exactly "1". */
export function remoteDbAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[REMOTE_DB_FLAG] === "1";
}

/**
 * Why no override makes `url` resettable, or null. Two things decide which
 * database a command drops, and OB1_ALLOW_REMOTE_DB answers neither:
 *   • the URL must be one every reader takes to the same place
 *     (databaseUrlProblem), and name its host: with none, Bun and libpq go
 *     to different servers;
 *   • it must name its database. With none, the client takes PGDATABASE's, or
 *     the user's name, so the shell would choose what is dropped;
 *   • it must name its port while PGPORT is exported. Bun takes PGPORT for a
 *     URL that names none (measured: dropSchema dropped a second server's
 *     database of the same name), and the tools' connection names 5432
 *     (toolTarget).
 */
export function identityRefusal(url: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!parses(url)) return "the URL does not parse";
  const split = readersSplit(url);
  if (split !== null) return `the URL ${split}`;
  // An empty host is a split too: Bun connects to localhost over TCP (PGHOST
  // unset, measured), libpq to the unix socket, and those can be two servers.
  // A worker may still use one; a command that drops a schema may not, override
  // or not (review pass 1).
  if (new URL(url).hostname === "") return "the URL has no host (Bun would connect to localhost over TCP and libpq to the unix socket, or both to PGHOST's)";
  if (databaseOf(url) === "") return "the URL names no database (the client would take PGDATABASE's, or the user's name)";
  if (new URL(url).port === "" && (env.PGPORT ?? "") !== "") return "the URL names no port and PGPORT is exported, which Bun would use: name the port in the URL";
  return null;
}

/**
 * The one rule, as the refusal a script prints before it connects: null when
 * a command that drops a schema may run against `url`, else why not. The URL
 * must pin one database (identityRefusal), and its host must be loopback
 * unless OB1_ALLOW_REMOTE_DB=1. Once connected, connectedResetRefusal asks
 * the server the rest.
 */
export function resetRefusal(url: string, env: Record<string, string | undefined> = process.env): string | null {
  return identityRefusal(url, env) ?? (remoteDbAllowed(env) ? null : notThrowaway(url));
}

/** The one rule, before connecting: a command that drops a schema may run against `url`. */
export function mayReset(url: string, env: Record<string, string | undefined> = process.env): boolean {
  return resetRefusal(url, env) === null;
}

/** What connectedResetRefusal reads: the one query, so a suite can hand it a stand-in. */
export interface Queryable {
  unsafe(query: string): Promise<unknown[]>;
}

/**
 * Why the database `sql` reached is not the one `url` names, or null. The
 * server says where the connection went, and the URL is not asked: Bun lets
 * an exported PGDATABASE beat the URL's database, and `dropSchema(".../canary")`
 * with PGDATABASE=stable dropped stable's thoughts (SMD-2302 review pass 3).
 * No override lifts this. Call it on a URL identityRefusal has passed.
 */
export async function reachedDatabaseRefusal(sql: Queryable, url: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  // Qualified: `options=-c search_path=evil,pg_catalog` would otherwise let a
  // function of that name in the target database answer (review pass 1, run).
  const [row] = (await sql.unsafe("SELECT pg_catalog.current_database() AS db")) as { db: string }[];
  const named = databaseOf(url);
  if (row.db === named) return null;
  return `the connection reached database ${JSON.stringify(row.db)}, not ${JSON.stringify(named)}, the one the URL names${
    env.PGDATABASE !== undefined ? " — PGDATABASE is exported, and Bun lets it beat the URL's database; unset it" : ""
  }`;
}

/**
 * The rule's connected half, asked on the connection that is about to drop:
 * null when it may, else why not.
 *   • It must have reached the database the URL names (reachedDatabaseRefusal).
 *     No override lifts this.
 *   • It must be over TCP. A unix socket (inet_server_addr() is NULL) is not
 *     what a loopback hostname says: Bun connects through one for `?path=`,
 *     which databaseUrlProblem refuses, and this holds should another route
 *     appear. OB1_ALLOW_REMOTE_DB lifts it, as it lifts the host rule.
 * The server's address is not compared with loopback: through a container's
 * published port it is the container's (notThrowaway says why).
 */
export async function connectedResetRefusal(sql: Queryable, url: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  return (await reachedDatabaseRefusal(sql, url, env)) ?? (await socketRefusal(sql, env));
}

/** Why `sql` is not over TCP, or null — the half of connectedResetRefusal OB1_ALLOW_REMOTE_DB lifts. */
export async function socketRefusal(sql: Queryable, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const [row] = (await sql.unsafe("SELECT pg_catalog.inet_server_addr() IS NULL AS socket")) as { socket: boolean }[];
  if (row.socket && !remoteDbAllowed(env)) return "the connection is over a unix socket, not the TCP port the URL's host names";
  return null;
}

// ---------------------------------------------------------------------------
// The libpq tools' connection: built from the URL's parts, never the URL.
// ---------------------------------------------------------------------------

/**
 * What a libpq tool (pg_dump, pg_restore) connects with: a keyword/value
 * connection string, and the environment to run it in. SMD-2317's second
 * half. Handed the typed URL, libpq parsed it by rules of its own that each
 * review round found another of (a fragment, the first `@`, dot segments, `+`,
 * `%2C`, a second `=`), and followed PGHOSTADDR, PGSERVICE and the rest of its
 * environment wherever the URL's host pointed. Here it parses no URL:
 *   • host and port are the URL's as the parser read them (the host's
 *     brackets off, 5432 for none: identityRefusal refuses a portless URL
 *     while PGPORT is exported), so libpq dials what Bun dialled;
 *   • dbname and user are what the server told the guarded connection
 *     (`reached`), not what the URL says;
 *   • sslmode, application_name and options, decoded, are the only others;
 *   • the password is in PGPASSWORD, off the argv (`ps` shows argv to every
 *     user of a Linux host; SMD-2119 asks the same of tier.ts's other spawns);
 *   • the environment keeps only the PG* variables that authenticate
 *     (TOOL_PG_KEEP): PGHOST, PGHOSTADDR, PGPORT, PGDATABASE, PGUSER,
 *     PGSERVICE, PGSERVICEFILE, PGSYSCONFDIR, PGOPTIONS and the rest go, and
 *     a password from the environment stays only when the URL names none.
 * Where libpq and Bun could still resolve one name to two servers (a
 * `localhost` with one listener on ::1 and another on 127.0.0.1), tier.ts's
 * probe of --to asks pg_dump itself before anything is dropped.
 */
export interface ToolTarget {
  conninfo: string;
  env: Record<string, string>;
}

/** The PG* variables a libpq tool keeps: they authenticate or bound a connection, and choose no server, database or user. */
export const TOOL_PG_KEEP = /^PG(PASSFILE|CHANNELBINDING|REQUIREAUTH|SSL[A-Z]*|GSSENCMODE|KRBSRVNAME|CONNECT_TIMEOUT)$/;

/** A keyword/value value, quoted as libpq reads one: single quotes, with `\` and `'` escaped. */
export function conninfoValue(v: string): string {
  return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * The tools' connection to `url`'s database (ToolTarget). `reached` is what
 * the server reported on the connection the guards asked: its database and
 * user. Call it on a URL identityRefusal has passed. `env` is the environment
 * to derive the tool's from (process.env by default); nothing of the password
 * is in `conninfo`.
 */
export function toolTarget(url: string, reached: { database: string; user: string }, env: Record<string, string | undefined> = process.env): ToolTarget {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  const parts: [string, string][] = [["host", host], ["port", u.port || "5432"], ["dbname", reached.database], ["user", reached.user]];
  for (const key of ["sslmode", "application_name", "options"]) {
    const value = u.searchParams.get(key);
    if (value !== null) parts.push([key, value]);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith("PG") && !TOOL_PG_KEEP.test(k) && !(k === "PGPASSWORD" && u.password === "")) continue;
    out[k] = v;
  }
  if (u.password !== "") out.PGPASSWORD = decodeURIComponent(u.password);
  return { conninfo: parts.map(([k, v]) => `${k}=${conninfoValue(v)}`).join(" "), env: out };
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
