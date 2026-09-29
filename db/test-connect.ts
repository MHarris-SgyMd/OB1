#!/usr/bin/env bun
/**
 * test-connect.ts — how every db/ script reaches its database (db/connect.ts,
 * SMD-2302), hermetic.
 *
 * No Postgres, no model, no network. Four parts: the one loopback rule as a
 * truth table (tier.ts's --refresh and the test scaffolding answered it
 * differently until SMD-2302), with the refusals that print it, tier.ts's run
 * for real; the URL resolver and the client, neither printing a URL; the
 * close-then-exit door, run for real with pools that record their close; and
 * the tree's shape — no script outside connect.ts resolves DATABASE_URL, builds
 * a client or spells a loopback host of its own, and no body on the door exits
 * or closes (hnsw-graph.ts and tier.ts's --replay/--diff called process.exit
 * inside the `try` whose `finally` closed the pool). Runs beside test-cli.ts.
 * Every child runs with `--no-env-file`: a checkout's db/.env is not the test's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import {
  LOOPBACK_HOSTS, NO_DATABASE_URL, REMOTE_DB_FLAG, RETIRED_REMOTE_DB_FLAG, UNPARSEABLE_DATABASE_URL, URL_QUERY_KEYS,
  connectedResetRefusal, databaseOf, databaseUrl, databaseUrlProblem, hostOf, identityRefusal, mayReset, notThrowaway, openSql,
  reachedDatabaseRefusal, remoteDbAllowed, resetRefusal, socketRefusal,
} from "./connect.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const HERE = import.meta.dir;
const MARK = "SECRET-2302";
/** What a child inherits: this environment without anything the rule or the resolver reads. */
const BASE_ENV: Record<string, string> = {};
{
  const read = new Set(["DATABASE_URL", REMOTE_DB_FLAG, RETIRED_REMOTE_DB_FLAG]);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !read.has(k) && !k.startsWith("PG")) BASE_ENV[k] = v;
  BASE_ENV.OB1_ENV_FILES = "off";
}
function spawn(argv: string[], env: Record<string, string> = {}): { code: number; out: string; err: string; ms: number } {
  const t0 = Date.now();
  // A child that hangs fails its check rather than the suite: 30 s, then killed.
  const r = Bun.spawnSync(["bun", "--no-env-file", ...argv], { cwd: HERE, env: { ...BASE_ENV, ...env }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString(), ms: Date.now() - t0 };
}
const child = (code: string, env: Record<string, string> = {}) => spawn(["-e", code], env);

// ---------------------------------------------------------------------------
// May this database be reset? One truth table.
// ---------------------------------------------------------------------------
{
  // [url, plainly this machine?, what] — no override, nothing in the environment.
  const HOSTS: [string, boolean, string][] = [
    [`postgres://u:${MARK}@localhost:5432/db`, true, "localhost"],
    [`postgres://u:${MARK}@LOCALHOST:5432/db`, true, "localhost in capitals (a non-special scheme keeps the case)"],
    [`postgres://u:${MARK}@127.0.0.1:5432/db`, true, "127.0.0.1"],
    ["postgresql://127.0.0.1/db", true, "127.0.0.1 under postgresql://"],
    [`postgres://u:${MARK}@[::1]:5432/db`, true, "[::1]"],
    ["postgres://u@[0:0:0:0:0:0:0:1]:5432/db", true, "[::1] written out (the parser normalises it)"],
    [`postgres://u:${MARK}@0.0.0.0:5432/db`, true, "0.0.0.0 (tier.ts's rule did not know it)"],
    [`postgres://u:${MARK}@127.0.0.1:5432/db?application_name=x&sslmode=disable`, true, "a query that sends nothing elsewhere"],
    ["postgres:///db", false, "an empty host (resolves through PGHOST; tier.ts's rule trusted it)"],
    ["postgres://u@/db?host=/var/run/postgresql", false, "a libpq socket URL, which does not parse"],
    ["not a url", false, "a string that does not parse"],
    ["postgres://localhost:5432@evil.com/db", false, "localhost:5432 as userinfo before a remote host"],
    [`postgres://u:${MARK}@postgres:5432/db`, false, "a compose service name"],
    [`postgres://u:${MARK}@192.168.1.5:5432/db`, false, "an RFC1918 address (config.mjs's isLocalHostname would say local)"],
    [`postgres://u:${MARK}@host.docker.internal:5432/db`, false, "the container-to-host alias"],
    [`postgres://u:${MARK}@127.0.0.2:5432/db`, false, "127.0.0.2, not named"],
    ["postgres://u@db.localhost/db", false, "a name under localhost."],
    [`postgres://u:${MARK}@localhost.example.com:5432/db`, false, "a host that begins with localhost"],
    [`postgres://u:${MARK}@db.example.com:5432/db`, false, "a remote host"],
  ];
  const none = {};
  // The override lifts the host rule, never a URL that fails to pin one
  // database: here one that does not parse, and an empty host, which Bun and
  // libpq take to two servers (SMD-2317, review pass 1).
  const pins = (what: string) => !what.includes("does not parse") && !what.includes("an empty host");
  for (const [url, local, what] of HOSTS) {
    ok((notThrowaway(url) === null) === local, `notThrowaway: ${what} → ${local ? "no reason" : "a reason"}`);
    ok(mayReset(url, none) === local, `mayReset, no override: ${what} → ${local}`);
    ok(mayReset(url, { OB1_ALLOW_REMOTE_DB: "1" }) === pins(what), `mayReset, OB1_ALLOW_REMOTE_DB=1: ${what} → ${pins(what)}`);
    ok((identityRefusal(url) === null) === pins(what), `identityRefusal: ${what} → ${pins(what) ? "none" : "a reason"}`);
    // The eval-local name, which the scaffolding honoured and tier.ts did not:
    // read here it would pass deploy/tier.sh, which strips only the one name.
    ok(mayReset(url, { OB1_EVAL_ALLOW_REMOTE_DB: "1" }) === local, `mayReset, OB1_EVAL_ALLOW_REMOTE_DB=1 (retired): ${what} → ${local}`);
    const why = resetRefusal(url, none);
    ok(local ? why === null : typeof why === "string" && why.length > 0 && !why.includes(MARK), `resetRefusal: ${what} → ${local ? "none" : "a reason, without the password"}${why ? ` (${why})` : ""}`);
  }
  // The reason says what failed, in the reader's words.
  const reasons: [string, RegExp][] = [
    ["postgres://u@db.example.com/x", /^db\.example\.com is not a loopback host$/],
    ["postgres:///x", /no host .*PGHOST/],
    ["not a url", /does not parse/],
  ];
  for (const [url, re] of reasons) ok(re.test(notThrowaway(url) ?? ""), `notThrowaway(${url}) says ${re} (${notThrowaway(url)})`);
  // The rule reads the URL's host alone: a developer's PGSERVICE does not refuse
  // a suite, whose drop goes through Bun, which ignores it when the URL names a host.
  const LOCAL = "postgres://u@localhost/db";
  for (const v of ["PGHOSTADDR", "PGSERVICE", "PGHOST", "PGDATABASE"]) ok(mayReset(LOCAL, { [v]: "db.example.com" }), `${v} set: localhost stands`);

  ok(REMOTE_DB_FLAG === "OB1_ALLOW_REMOTE_DB" && RETIRED_REMOTE_DB_FLAG === "OB1_EVAL_ALLOW_REMOTE_DB", "the override is OB1_ALLOW_REMOTE_DB; the eval-local name is retired");
  for (const v of ["0", "", "true", "yes", " 1", "1 ", "01"])
    ok(!remoteDbAllowed({ OB1_ALLOW_REMOTE_DB: v }) && !mayReset("postgres:///db", { OB1_ALLOW_REMOTE_DB: v }), `OB1_ALLOW_REMOTE_DB=${JSON.stringify(v)} is not the override (exactly "1")`);
  ok(!remoteDbAllowed({ OB1_ALLOW_REMOTE: "1", ALLOW_REMOTE_DB: "1", OB1_EVAL_ALLOW_REMOTE_DB: "1" }), "a near name, or the retired one, is not the override");
  // The rule reads the environment it is given — process.env only by default.
  const given = child(`import { mayReset } from "./connect.ts"; console.log(mayReset("postgres://u@db.example.com/x", {}), mayReset("postgres://u@db.example.com/x"), mayReset("postgres://u@localhost/x", {}), mayReset("postgres://u@localhost/x"));`, { OB1_ALLOW_REMOTE_DB: "1" });
  ok(given.out.trim() === "false true true true", `an explicit environment is the one read; the default is process.env (${given.out.trim()})`);

  // deploy/tier.sh hands tier.ts every OB1_* variable of the stack's env file
  // except the ones it decides itself — the override among them, set only for
  // a short-form --to. The name the rule reads must be one it strips.
  const tierSh = readFileSync(join(HERE, "..", "deploy", "tier.sh"), "utf8");
  const stripped = tierSh.match(/^\s*([A-Z0-9_|]+)\) continue ;;$/m)?.[1].split("|") ?? [];
  ok(stripped.includes(REMOTE_DB_FLAG), `deploy/tier.sh strips ${REMOTE_DB_FLAG} from what it passes on, and sets it itself (stripped: ${stripped.join(", ") || "none found"})`);
  ok(/OB1_\*\|/.test(tierSh), "…while it passes every other OB1_* variable on — why a second override name would pass it");
  ok([...LOOPBACK_HOSTS].sort().join() === ["0.0.0.0", "127.0.0.1", "[::1]", "localhost"].join(), "the loopback set is the four named hosts, nothing more");
  ok(hostOf("postgres:///db") === "" && hostOf("not a url") === null && hostOf("postgres://Db.Example.COM/x") === "db.example.com", "hostOf: empty host \"\", unparseable null, lowercased");
}

// ---------------------------------------------------------------------------
// Where the readers split: a URL Bun and libpq take to different places is
// refused by the resolver, override or not (SMD-2317).
// ---------------------------------------------------------------------------
/** [url, the reason's words, what] — every one loopback by name, so only the resolver stands between it and a client. */
const SPLITS: [string, RegExp, string][] = [
  [`postgres://u:${MARK}@localhost:5432/canary#?host=db.example.com`, /has a fragment/, "a fragment, which libpq reads as the query (#?host=)"],
  [`postgres://u:${MARK}@localhost:5432/canary#`, /has a fragment/, "an empty fragment"],
  [`postgres://u@db.example.com:5432,x@localhost/canary`, /an @ other than the one ending its user/, "a first-@ host list: libpq's user ends at the first @, Bun's at the last"],
  [`postgres://u:p@ss${MARK}@localhost:5432/canary`, /an @ other than the one ending its user/, "an unencoded @ in the password"],
  [`postgres://localhost:5432/canary?application_name=a@db.example.com`, /an @ other than the one ending its user/, "an @ in a query value, which libpq reads as ending a user"],
  [`postgres://localhost:5432/can@ry`, /an @ other than the one ending its user/, "an @ in the database name"],
  [`postgres://u@localhost,db.example.com/canary`, /names a host list/, "a , host list"],
  [`postgres://u:${MARK}@localhost:5432/canary?host=db.example.com`, /the query key host,/, "?host= (libpq goes there)"],
  [`postgres://u:${MARK}@localhost:5432/canary?hostaddr=10.0.0.5`, /the query key hostaddr,/, "?hostaddr="],
  [`postgres://u:${MARK}@localhost:5432/canary?port=5433&dbname=openbrain`, /the query key port,/, "?port=&dbname= (the dogfood stack's other brain, no override needed)"],
  [`postgres://u:${MARK}@localhost:5432/canary?service=prod`, /the query key service,/, "?service="],
  [`postgres://u:${MARK}@localhost:5432/stable?database=canary`, /the query key database,/, "?database= (Bun connects to canary, its options still say stable)"],
  [`postgres://u:${MARK}@localhost:5432/canary?user=admin`, /the query key user,/, "?user= (Bun logs in as admin)"],
  [`postgres://u:${MARK}@localhost:5432/canary?path=/var/run/postgresql`, /the query key path,/, "?path= (Bun connects over that unix socket)"],
  [`postgres://u:${MARK}@localhost:5432/canary?data%62ase=stable`, /the query key database,/, "a percent-encoded key, decoded as both readers decode it"],
  [`postgres://u:${MARK}@localhost:5432/canary?${MARK}=1`, /carries a query key, and only/, "a key that is not a plain word, which is not printed"],
  [`postgres://u:${MARK}@localhost:5432/canary?sslmode=disable&sslmode=require`, /gives the query key sslmode twice/, "sslmode twice"],
  // Review pass 1: each measured with both readers, or a mutant survived without it.
  [`postgres://u:${MARK}@localhost:5432/x/../canary`, /a path the parser rewrites/, "a .. segment (Bun reaches canary, libpq x/../canary)"],
  [`postgres://u:${MARK}@localhost:5432/./canary`, /a path the parser rewrites/, "a . segment"],
  [`postgres://u:${MARK}@localhost:5432/%2e%2e/canary`, /a path the parser rewrites/, "an encoded .. segment (libpq reaches ../canary)"],
  [`postgres://u:${MARK}@localhost:5432/stable/%2e%2E/canary`, /a path the parser rewrites/, "a mixed-case encoded .. segment"],
  [`postgres://u:${MARK}@localhost:5432/canary?options=-c+search_path%3Dx`, /has a \+ in its query/, "a + in a query value (a space to Bun, a + to libpq)"],
  [`postgres://u@localhost%2Cdb.example.com/canary`, /names a host list/, "a %2C host list, which libpq decodes"],
  [`postgres://localhost?application_name=a@db.example.com:5432/canary`, /an @ other than the one ending its user/, "an @ past a ? with no path (libpq's user ends there, its host is db.example.com)"],
  [`postgres://localhost/@canary`, /an @ other than the one ending its user/, "an @ straight after the path's /"],
  [`postgres://u:${MARK}@localhost:5432/canary?SSLMODE=disable`, /the query key SSLMODE,/, "a key in capitals (the allowlist is exact)"],
  // Review pass 2: libpq refuses these query shapes, which Bun reads — a
  // refresh dropped --to and then failed its restore; and a lowercase %2c.
  [`postgres://u:${MARK}@localhost:5432/canary?application_name=x=y`, /a second = in a query value/, "a second raw = in a value (libpq: extra key/value separator)"],
  [`postgres://u:${MARK}@localhost:5432/canary?options=-c%20search_path=x`, /a second = in a query value/, "an options value with a raw ="],
  [`postgres://u:${MARK}@localhost:5432/canary?sslmode`, /no key=value/, "a key with no ="],
  [`postgres://u:${MARK}@localhost:5432/canary?&sslmode=disable`, /no key=value/, "an empty query part"],
  [`postgres://u:${MARK}@localhost:5432/canary?sslmode=disable&`, /no key=value/, "a trailing &"],
  [`postgres://u:${MARK}@localhost:5432/canary?sslmode=DISABLE`, /sslmode in capitals/, "an sslmode value in capitals"],
  [`postgres://u@nohost.invalid%2c127.0.0.1/canary`, /names a host list/, "a lowercase %2c host list (libpq reached canary through it)"],
];
{
  for (const [url, re, what] of SPLITS) {
    const problem = databaseUrlProblem(url);
    ok(problem !== null && re.test(problem) && !problem.includes(MARK) && problem.startsWith("The database URL "), `databaseUrlProblem: ${what} → refused, never quoting it (${problem?.slice(0, 90)})`);
    const fixed = identityRefusal(url);
    ok(fixed !== null && re.test(fixed) && !fixed.includes(MARK), `identityRefusal: ${what} → refused`);
    ok(!mayReset(url, { [REMOTE_DB_FLAG]: "1" }), `mayReset, ${REMOTE_DB_FLAG}=1: ${what} → false, no override lifts it`);
  }
  // Whitespace and a scheme's case: the parser forgives them, libpq does not.
  for (const [url, what] of [
    [" postgres://u@localhost/canary", "a leading space"],
    ["postgres://u@localhost/canary ", "a trailing space"],
    ["postgres://u@local\thost/canary", "a tab inside the host (the parser drops it)"],
    ["postgres://u@localhost/can\nary", "a newline inside the path"],
    ["POSTGRES://u@localhost/canary", "a scheme in capitals (libpq wants postgres:// exactly)"],
    ["postgres:u@localhost/canary", "no // after the scheme"],
    ["postgres://u@localhost/can\x7fary", "a DEL inside the path"],
  ] as const) {
    ok(databaseUrlProblem(url) === UNPARSEABLE_DATABASE_URL && identityRefusal(url) === "the URL does not parse", `${what}: refused as unparseable`);
  }
  // What stays open: the three keys, an encoded @ or # in the password, an encoded database.
  for (const [url, db, what] of [
    [`postgres://u:${MARK}@127.0.0.1:5432/canary?sslmode=disable&application_name=ob1`, "canary", "sslmode and application_name"],
    [`postgres://u:${MARK}@127.0.0.1:5432/canary?options=-csearch_path%3D%22extensions%22%2Cpublic`, "canary", "options=, the search_path value preflight prints (SMD-2238)"],
    [`postgresql://u:p%40ss%23${MARK}@localhost/canary`, "canary", "an @ and a # percent-encoded in the password"],
    ["postgres://u@localhost/c%61nary", "canary", "a percent-encoded database (Bun decodes it)"],
    ["postgres://u@localhost/a%2Fb", "a/b", "an encoded / in the database"],
    ["postgres://localhost/canary", "canary", "no user at all"],
    ["postgres://u@[::1]:5432/canary", "canary", "IPv6 loopback"],
    // Review pass 2: both readers agree on these (measured), so the resolver must too.
    ["postgres://u@localhost/café", "café", "a non-ASCII database the parser percent-encodes"],
    ['postgres://u@localhost/a"b', 'a"b', "a \" in the database the parser percent-encodes"],
    ["postgres://u@localhost/caf%c3%a9", "café", "a lowercase percent-escape"],
    ["postgres://a+b@localhost/a+b", "a+b", "a + in the user and the database (a + only splits the readers in the query)"],
    ["postgres://u@localhost/canary?options=-csearch_path%3Dx%20-cwork_mem%3D4MB", "canary", "an options value with every = and space encoded"],
  ] as const) {
    ok(databaseUrlProblem(url) === null && identityRefusal(url) === null && mayReset(url, {}), `${what}: accepted and resettable`);
    ok(databaseOf(url) === db, `databaseOf: ${what} → ${JSON.stringify(db)} (${JSON.stringify(databaseOf(url))})`);
  }
  ok([...URL_QUERY_KEYS].sort().join() === "application_name,options,sslmode", "the query allowlist is sslmode, application_name and options, nothing more");
  // A URL naming no database lets the shell choose what is dropped.
  for (const url of ["postgres://u@localhost", "postgres://u@localhost/", "postgres://u@localhost:5432/?sslmode=disable"]) {
    ok(databaseUrlProblem(url) === null, `${url}: a URL a worker may still use (the resolver passes it)`);
    ok(/names no database/.test(identityRefusal(url) ?? "") && !mayReset(url, { [REMOTE_DB_FLAG]: "1" }), `${url}: not resettable, override or not — PGDATABASE, or the user's name, would decide (${identityRefusal(url)})`);
  }
  // The resolver refuses each split, printing only its reason.
  for (const [url, re, what] of SPLITS.slice(0, 3).concat(SPLITS.slice(11, 14))) {
    const r = child(`import { databaseUrl } from "./connect.ts"; console.log("resolved " + databaseUrl(undefined));`, { DATABASE_URL: url });
    ok(r.code === 2 && re.test(r.err) && !r.err.includes(MARK) && !r.out.includes("resolved"), `DATABASE_URL with ${what}: exit 2, the reason, no word of the URL (exit ${r.code}: ${r.err.trim().slice(0, 70)})`);
    const o = child(`import { openSql } from "./connect.ts"; try { openSql(${JSON.stringify(url)}); console.log("opened"); } catch (e) { console.log("threw: " + e.message); }`);
    ok(re.test(o.out) && !o.out.includes("opened") && !o.out.includes(MARK) && !o.err.includes(MARK), `openSql on ${what} throws the reason (${o.out.trim().slice(0, 70)})`);
  }
}

// ---------------------------------------------------------------------------
// The connected half: the server says where the connection went.
// ---------------------------------------------------------------------------
{
  /** A stand-in connection answering the two questions the rule asks, and counting them. */
  const conn = (db: string, socket: boolean) => {
    const asked: string[] = [];
    return {
      asked,
      async unsafe(q: string) {
        asked.push(q);
        if (/current_database\(\)/.test(q)) return [{ db }];
        if (/inet_server_addr\(\) IS NULL/.test(q)) return [{ socket }];
        throw new Error(`unexpected query: ${q}`);
      },
    };
  };
  const URL_A = "postgres://u@localhost/canary";
  ok((await connectedResetRefusal(conn("canary", false), URL_A, {})) === null, "reached the named database over TCP: may reset");
  const off = await connectedResetRefusal(conn("stable", false), URL_A, {});
  ok(off === `the connection reached database "stable", not "canary", the one the URL names`, `reached another database: refused, naming both (${off})`);
  const hinted = await connectedResetRefusal(conn("stable", false), URL_A, { PGDATABASE: "stable" });
  ok(/PGDATABASE is exported, and Bun lets it beat the URL's database; unset it$/.test(hinted ?? ""), `…and with PGDATABASE exported it says so (${hinted})`);
  ok((await connectedResetRefusal(conn("stable", false), URL_A, { [REMOTE_DB_FLAG]: "1" })) !== null, `…and ${REMOTE_DB_FLAG}=1 does not lift it`);
  ok((await reachedDatabaseRefusal(conn("stable", false), URL_A, { [REMOTE_DB_FLAG]: "1" })) !== null && (await reachedDatabaseRefusal(conn("canary", true), URL_A, {})) === null, "reachedDatabaseRefusal asks the database alone: override or not, socket or not");
  ok((await connectedResetRefusal(conn("Canary", false), URL_A, {})) !== null, "the compare is exact: Canary is another database than canary");
  ok((await connectedResetRefusal(conn("a/b", false), "postgres://u@localhost/a%2Fb", {})) === null, "the URL's database decoded, as Bun decodes it (a%2Fb reaches a/b)");
  const sock = await connectedResetRefusal(conn("canary", true), URL_A, {});
  ok(/over a unix socket/.test(sock ?? ""), `over a unix socket: refused (${sock})`);
  ok((await connectedResetRefusal(conn("canary", true), URL_A, { [REMOTE_DB_FLAG]: "1" })) === null && (await socketRefusal(conn("x", true), { [REMOTE_DB_FLAG]: "1" })) === null, `…and ${REMOTE_DB_FLAG}=1 lifts that half, as it lifts the host rule`);
  const both = conn("stable", true);
  const bothWhy = await connectedResetRefusal(both, URL_A, { [REMOTE_DB_FLAG]: "1" });
  ok(/reached database "stable"/.test(bothWhy ?? "") && both.asked.length === 1, `the database is asked first, and a wrong one ends it (${both.asked.length} question(s))`);
}

// ---------------------------------------------------------------------------
// What reaches the server: a startup packet read off a listener. A refused URL
// sends none; an accepted one sends the URL's user and database once, and
// nothing a query could add (SMD-2317).
// ---------------------------------------------------------------------------
{
  type Startup = Record<string, string[]>;
  const packets: Startup[] = [];
  let connections = 0;
  /** The StartupMessage's key/value pairs; an SSLRequest (Bun's default "prefer") is answered N first. */
  const listener = Bun.listen<{ buf: Buffer }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) { connections++; s.data = { buf: Buffer.alloc(0) }; },
      data(s, chunk) {
        s.data.buf = Buffer.concat([s.data.buf, Buffer.from(chunk)]);
        for (;;) {
          const b = s.data.buf;
          if (b.length < 8) return;
          const len = b.readInt32BE(0);
          if (b.length < len) return;
          const code = b.readInt32BE(4);
          s.data.buf = b.subarray(len);
          if (code === 80877103) { s.write("N"); continue; }
          const fields = b.subarray(8, len).toString("utf8").split("\0");
          const pairs: Startup = {};
          for (let i = 0; i + 1 < fields.length && fields[i] !== ""; i += 2) (pairs[fields[i]] ??= []).push(fields[i + 1]);
          packets.push(pairs);
          s.end();
          return;
        }
      },
    },
  });
  const at = (rest: string) => `postgres://ob1u:${MARK}@127.0.0.1:${listener.port}/${rest}`;
  const send = async (url: string, env: Record<string, string> = {}) => {
    packets.length = 0;
    connections = 0;
    const p = Bun.spawn(["bun", "--no-env-file", "-e", `import { openSql } from "./connect.ts"; try { const s = openSql(${JSON.stringify(url)}); await s\`SELECT 1\`.catch(() => {}); await s.close(); } catch (e) { console.error(e.message); process.exit(3); }`], { cwd: HERE, env: { ...BASE_ENV, ...env }, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), 15_000);
    const watch = setInterval(() => { if (packets.length > 0) p.kill(); }, 20);
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    clearTimeout(killer);
    clearInterval(watch);
    await Bun.sleep(50);
    return { code, err, packet: packets[0], connections };
  };
  // Also the control for the rows below: the listener does read a packet.
  const plain = await send(at("canary?application_name=ob1probe&sslmode=disable"));
  ok(plain.packet !== undefined && plain.packet.user?.join() === "ob1u" && plain.packet.database?.join() === "canary" && plain.packet.application_name?.join() === "ob1probe",
    `an accepted URL sends its user and database once each, and application_name (${JSON.stringify(plain.packet)})`);
  // Bun 1.4.0's own keys beside them, measured; a key a URL could add would show here.
  const keys = Object.keys(plain.packet ?? {}).sort().join();
  ok(keys === "DateStyle,application_name,client_encoding,database,user", `…and nothing else: the client's client_encoding and DateStyle (${keys})`);
  // options= reaches the server as the one startup setting it is, and moves neither user nor database.
  const withOptions = await send(at("canary?options=-csearch_path%3Dx"));
  ok(withOptions.packet?.options?.join() === "-csearch_path=x" && withOptions.packet?.database?.join() === "canary" && withOptions.packet?.user?.join() === "ob1u",
    `options= is sent as options, the user and database the URL's (${JSON.stringify(withOptions.packet)})`);
  for (const [rest, what] of [["stable?database=canary", "?database="], ["canary?user=admin", "?user="], ["canary?path=/tmp", "?path="], ["canary?host=db.example.com", "?host="]] as const) {
    const r = await send(at(rest));
    ok(r.code === 3 && r.connections === 0 && /the query key/.test(r.err) && !r.err.includes(MARK), `${what}: refused before any connection (${r.connections} connection(s), exit ${r.code})`);
  }
  listener.stop(true);
}

// ---------------------------------------------------------------------------
// The refusals that print the rule, run: the suites' and tier.ts --refresh's.
// ---------------------------------------------------------------------------
{
  const guard = (url: string) => `import { assertThrowawayDatabase } from "./test-support.ts"; await assertThrowawayDatabase(${JSON.stringify(url)}); console.log("dropped");`;
  const REMOTE = guard(`postgres://u:${MARK}@db.example.com/x`);
  const guarded = child(REMOTE);
  ok(guarded.code === 2 && /Refusing to drop the schema: db\.example\.com is not a loopback host/.test(guarded.err) && /or set\n\s+OB1_ALLOW_REMOTE_DB=1 if you are certain/.test(guarded.err) && !guarded.out.includes("dropped") && !guarded.err.includes(MARK) && !guarded.err.includes(RETIRED_REMOTE_DB_FLAG), `assertThrowawayDatabase refuses a remote host by name, never its password, and names the override (exit ${guarded.code})`);
  // A URL that passes the rule goes on to ask the server (SMD-2317): here
  // nothing answers, so it fails connecting — past the URL half, not refused by it.
  const pastTheUrl = (r: { code: number; out: string; err: string }) => r.code !== 0 && r.code !== 2 && !/Refusing/.test(r.err) && !r.out.includes("dropped") && !r.err.includes(MARK);
  // The suites drop through Bun's client alone, which reaches the URL's host: a
  // developer's PGSERVICE or PGHOSTADDR does not refuse them (pass 1's list did).
  const viaEnv = child(guard("postgres://u@127.0.0.1:1/x"), { PGHOSTADDR: "10.0.0.5", PGSERVICE: "prod" });
  ok(pastTheUrl(viaEnv), `…and a loopback host with PGHOSTADDR/PGSERVICE exported passes the URL half, on to connect (exit ${viaEnv.code}: ${viaEnv.err.trim().split("\n")[0]})`);
  const retired = child(REMOTE, { [RETIRED_REMOTE_DB_FLAG]: "1" });
  ok(retired.code === 2 && retired.err.includes(`${RETIRED_REMOTE_DB_FLAG} is set, and is no longer read: the name is ${REMOTE_DB_FLAG}`) && !retired.out.includes("dropped"), `…and with the retired name set it still refuses, and says the name to use (exit ${retired.code})`);
  const allowed = child(guard(`postgres://u:${MARK}@127.0.0.2:1/x`), { [REMOTE_DB_FLAG]: "1" });
  ok(pastTheUrl(allowed), `…and ${REMOTE_DB_FLAG}=1 lets a non-loopback host through the URL half (exit ${allowed.code}: ${allowed.err.trim().split("\n")[0]})`);
  const local = child(guard("postgres://u@127.0.0.1:1/x"));
  ok(pastTheUrl(local), `…and a loopback host passes it (exit ${local.code})`);
  // What no override lifts: a URL the readers split on, one naming no
  // database. Refused before connecting, and the message says the override
  // is not the way through.
  for (const [url, re, what] of [
    [`postgres://u:${MARK}@localhost:5432/stable?database=canary`, /the URL carries the query key database/, "?database="],
    [`postgres://u:${MARK}@localhost:5432/canary#?host=db.example.com`, /the URL has a fragment/, "a fragment"],
    [`postgres://u:${MARK}@localhost:5432`, /the URL names no database/, "no database"],
  ] as const) {
    const r = child(guard(url), { [REMOTE_DB_FLAG]: "1" });
    ok(r.code === 2 && re.test(r.err) && /OB1_ALLOW_REMOTE_DB does not lift this/.test(r.err) && !/if you are certain/.test(r.err) && !r.err.includes(MARK) && !r.out.includes("dropped"), `assertThrowawayDatabase, ${REMOTE_DB_FLAG}=1, ${what}: refused, and the override is not offered (exit ${r.code}: ${r.err.trim().split("\n")[0]})`);
  }
  // The drop itself asks: dropSchema, and resetSchema through it, refuse a
  // remote host before they connect — the one call between every suite and a
  // DROP TABLE … CASCADE of a real database (review pass 5).
  for (const fn of ["dropSchema", "resetSchema"] as const) {
    const r = child(`import { ${fn} } from "./test-support.ts"; await ${fn}("postgres://u:${MARK}@db.example.invalid:5432/x", {} as never); console.log("dropped");`);
    ok(r.code === 2 && /Refusing to drop the schema: db\.example\.invalid is not a loopback host/.test(r.err) && !/connect/i.test(r.err) && !r.err.includes(MARK) && !r.out.includes("dropped"), `${fn} refuses a remote host itself, before connecting, never its password (exit ${r.code}: ${r.err.trim().split("\n")[0]})`);
  }

  // tier.ts --refresh refuses before it connects to either side.
  const FROM = `postgres://u:${MARK}@127.0.0.1:1/a`;
  const refresh = (to: string, env: Record<string, string> = {}) => spawn(["tier.ts", "--refresh", "--from", FROM, "--to", to], env);
  for (const [to, re, what] of [
    ["postgres:///b", /--to: the URL has no host \(Bun would connect to localhost over TCP and libpq to the unix socket/, "an empty host"],
    ["postgres://u@db.example.com:5432/b", /--to is not plainly this machine — db\.example\.com is not a loopback host — and OB1_ALLOW_REMOTE_DB is not 1/, "a remote host"],
    ["postgres://u@192.168.1.5:5432/b", /--to is not plainly this machine — 192\.168\.1\.5 is not a loopback host/, "an RFC1918 host"],
  ] as const) {
    const r = refresh(to);
    ok(r.code === 1 && re.test(r.err) && !/could not connect/.test(r.err) && !r.err.includes(MARK) && !r.out.includes(MARK), `tier.ts --refresh --to ${what}: exit 1, refused before connecting, no password (exit ${r.code}, ${r.ms} ms: ${r.err.trim().split("\n")[0]})`);
  }
  const through = refresh("postgres://u@db.example.com:5432/b", { [REMOTE_DB_FLAG]: "1" });
  ok(through.code === 1 && /could not connect to --from/.test(through.err) && !through.err.includes(MARK), `…and with ${REMOTE_DB_FLAG}=1 it goes on, to the unreachable --from (exit ${through.code}: ${through.err.trim().split("\n")[0]})`);
  const retiredTier = refresh("postgres://u@db.example.com:5432/b", { [RETIRED_REMOTE_DB_FLAG]: "1" });
  ok(retiredTier.code === 1 && /not plainly this machine/.test(retiredTier.err), `…but not with the retired name (exit ${retiredTier.code})`);
  // The SMD-2302 review's shapes: each passed every guard against one
  // database while pg_restore, or Bun, went to another. Refused on either
  // side, override or not, before anything connects (SMD-2317).
  for (const [url, re, what] of [
    [`postgres://u:${MARK}@localhost:5432/canary?host=stable-host`, /the URL carries the query key host/, "?host= (pg_restore went to stable-host)"],
    [`postgres://u:${MARK}@localhost:5432/canary?port=5433&dbname=openbrain`, /the URL carries the query key port/, "?port=&dbname="],
    [`postgres://u:${MARK}@localhost:5432/stable?database=canary`, /the URL carries the query key database/, "?database="],
    [`postgres://u:${MARK}@localhost:5432/canary#?host=stable-host`, /the URL has a fragment/, "#?host="],
    [`postgres://u@stable-host:5432,x@localhost/canary`, /the URL has an @ other than/, "a first-@ host list"],
    [`postgres://u:${MARK}@localhost:5432`, /the URL names no database/, "no database"],
    [`postgres://u:${MARK}@localhost:5432/x/../canary`, /the URL has a path the parser rewrites/, "a .. segment (the guards judged canary, pg_restore wrote x/../canary)"],
    ["postgres:///canary", /the URL has no host/, "an empty host (Bun over TCP, libpq over the socket)"],
    [`postgres://u:${MARK}@localhost:5432/canary?application_name=x=y`, /the URL has a second = in a query value/, "a second raw = (the guards passed, canary was dropped, pg_restore refused the URL)"],
  ] as const) {
    for (const side of ["--to", "--from"] as const) {
      const argv = side === "--to" ? ["tier.ts", "--refresh", "--from", FROM, "--to", url] : ["tier.ts", "--refresh", "--from", url, "--to", "postgres://u@127.0.0.1:1/b"];
      const r = spawn(argv, { [REMOTE_DB_FLAG]: "1" });
      ok(r.code === 1 && r.err.includes(`${side}: `) && re.test(r.err) && /Refusing: --refresh dumps --from and drops --to's schema/.test(r.err) && !/could not connect/.test(r.err) && !r.err.includes(MARK), `tier.ts --refresh, ${REMOTE_DB_FLAG}=1, ${side} with ${what}: refused before connecting, the side named (exit ${r.code}: ${r.err.trim().split("\n")[0].slice(0, 110)})`);
    }
  }

  // "Before connecting", counted. The names above do not resolve, so a
  // connection opened before the guard would fail unseen; a listener on this
  // machine's own non-loopback address is remote to the rule and reachable, so
  // one is counted. The children run asynchronously so the listener accepts
  // while they run; each socket is closed on arrival (review pass 6).
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (lan === undefined) {
    console.log("  (no non-loopback IPv4 address here: the counted refusals are skipped)");
  } else {
    let seen = 0;
    const listener = Bun.listen({ hostname: lan, port: 0, socket: { open(s) { seen++; s.end(); }, data() {} } });
    // A control only has to show the listener is reached: Bun's client retries
    // a socket closed on arrival, so the child is stopped at its first connection.
    const counted = async (argv: string[], env: Record<string, string> = {}, control = false) => {
      seen = 0;
      const p = Bun.spawn(["bun", "--no-env-file", ...argv], { cwd: HERE, env: { ...BASE_ENV, ...env }, stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => p.kill(), 30_000);
      const watch = control ? setInterval(() => { if (seen > 0) p.kill(); }, 20) : undefined;
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = await p.exited;
      clearTimeout(killer);
      if (watch) clearInterval(watch);
      await Bun.sleep(50);
      return { code, out, err, seen };
    };
    const at = (db: string) => `postgres://u:${MARK}@${lan}:${listener.port}/${db}`;
    for (const fn of ["dropSchema", "resetSchema"] as const) {
      const r = await counted(["-e", `import { ${fn} } from "./test-support.ts"; await ${fn}(${JSON.stringify(at("x"))}, {} as never); console.log("dropped");`]);
      ok(r.code === 2 && r.seen === 0 && /Refusing to drop the schema: .* is not a loopback host/.test(r.err) && !r.err.includes(MARK) && !r.out.includes("dropped"), `${fn} at a reachable non-loopback address refuses with no connection opened (exit ${r.code}, ${r.seen} connection(s))`);
    }
    const dropControl = await counted(["-e", `import { dropSchema } from "./test-support.ts"; await dropSchema(${JSON.stringify(at("x"))});`], { [REMOTE_DB_FLAG]: "1" }, true);
    ok(dropControl.seen > 0, `…the control: with ${REMOTE_DB_FLAG}=1 dropSchema does reach the listener (${dropControl.seen} connection(s), exit ${dropControl.code})`);
    const REFRESH = ["tier.ts", "--refresh", "--from", at("a"), "--to", at("b")];
    const tierRefused = await counted(REFRESH);
    ok(tierRefused.code === 1 && tierRefused.seen === 0 && /--to is not plainly this machine/.test(tierRefused.err) && !tierRefused.err.includes(MARK), `tier.ts --refresh with both sides at a reachable non-loopback address refuses with no connection to either (exit ${tierRefused.code}, ${tierRefused.seen} connection(s))`);
    const tierControl = await counted(REFRESH, { [REMOTE_DB_FLAG]: "1" }, true);
    ok(tierControl.seen > 0, `…the control: with ${REMOTE_DB_FLAG}=1 --refresh does reach the listener (${tierControl.seen} connection(s), exit ${tierControl.code})`);
    // The override opens the host rule, and a URL the readers split on still
    // opens no connection (SMD-2317); the controls above show the listener is reached.
    for (const q of ["?database=b", "?host=db.example.com", "?path=/tmp"]) {
      const r = await counted(["-e", `import { dropSchema } from "./test-support.ts"; await dropSchema(${JSON.stringify(at("x") + q)}); console.log("dropped");`], { [REMOTE_DB_FLAG]: "1" });
      ok(r.code === 2 && r.seen === 0 && /the query key/.test(r.err) && !r.err.includes(MARK), `dropSchema, ${REMOTE_DB_FLAG}=1, ${q}: refused with no connection opened (exit ${r.code}, ${r.seen} connection(s))`);
      const t = await counted(["tier.ts", "--refresh", "--from", at("a"), "--to", at("b") + q], { [REMOTE_DB_FLAG]: "1" });
      ok(t.code === 1 && t.seen === 0 && /--to: the URL carries the query key/.test(t.err) && !t.err.includes(MARK), `tier.ts --refresh, ${REMOTE_DB_FLAG}=1, --to …${q}: refused with no connection to either side (exit ${t.code}, ${t.seen} connection(s))`);
    }
    listener.stop(true);
  }
}

// ---------------------------------------------------------------------------
// The URL and the client: --url, else DATABASE_URL, else exit 2; nothing printed of it.
// ---------------------------------------------------------------------------
{
  ok(databaseUrl("postgres://flag/db", { DATABASE_URL: "postgres://env/db" }) === "postgres://flag/db", "--url wins over DATABASE_URL");
  ok(databaseUrl(undefined, { DATABASE_URL: "postgres://env/db" }) === "postgres://env/db", "DATABASE_URL when no --url");
  const RESOLVE = `import { databaseUrl } from "./connect.ts"; console.log("resolved " + databaseUrl(undefined));`;
  for (const [what, env] of [
    ["unset", {}], ["empty", { DATABASE_URL: "" }], ["blank", { DATABASE_URL: "   " }],
    ["unset, with the other names a client might read set", { POSTGRES_URL: "postgres://u@h/db", PGURL: "postgres://u@h/db", DB_URL: "postgres://u@h/db", PGHOST: "h", PGDATABASE: "db" }],
  ] as const) {
    const r = child(RESOLVE, env);
    ok(r.code === 2 && r.err.trim() === NO_DATABASE_URL && !r.out.includes("resolved"), `DATABASE_URL ${what}, no --url: exit 2, the one refusal (exit ${r.code}: ${r.err.trim()})`);
  }
  const set = child(RESOLVE, { DATABASE_URL: `postgres://u:${MARK}@h/db` });
  ok(set.code === 0 && set.out.trim() === `resolved postgres://u:${MARK}@h/db` && !set.err.includes(MARK), "a set DATABASE_URL resolves, and nothing is printed of it");
  // postgresql:// is the other name libpq and deploy/tier.sh write.
  const pgql = child(`import { databaseUrl, openSql } from "./connect.ts"; const u = databaseUrl(undefined); const s = openSql(u); console.log("opened " + s.options.hostname); await s.close();`, { DATABASE_URL: `postgresql://u:${MARK}@127.0.0.1:1/x` });
  ok(pgql.code === 0 && pgql.out.trim() === "opened 127.0.0.1", `a postgresql:// URL resolves and opens, like postgres:// (exit ${pgql.code}: ${pgql.err.trim().split("\n")[0]})`);
  // The suites' own resolver has the same blank rule (review pass 1).
  const blankSuite = child(`import { requireDatabaseUrl } from "./test-support.ts"; console.log("resolved " + requireDatabaseUrl("x.ts"));`, { DATABASE_URL: "   " });
  ok(blankSuite.code === 2 && /DATABASE_URL is not set/.test(blankSuite.err) && !blankSuite.out.includes("resolved"), `requireDatabaseUrl reads a blank DATABASE_URL as unset (exit ${blankSuite.code})`);
  // A password holding an unencoded / # ? usually makes the URL unparseable —
  // not when what comes before it reads as a port, which parses as another
  // host and path (tier.ts's where() asks about that shape); the client's own
  // error printed an unparseable one whole as `input` (review pass 1).
  // A password with a bad percent-escape parses, then the client threw a
  // URIError; another scheme built a MySQL or SQLite client (review pass 2).
  for (const [bad, what] of [
    [`postgres://u:${MARK}/x@127.0.0.1:1/x`, "an unencoded / in the password"],
    [`postgres://u:${MARK}#x@127.0.0.1:1/x`, "an unencoded # in the password"],
    [`postgres://u:${MARK}@127.0.0.1:99999/x`, "a port past 65535"],
    [`postgres://u:50%zz${MARK}@127.0.0.1:1/x`, "a bad percent-escape in the password"],
    [`postgres://u%zz:${MARK}@127.0.0.1:1/x`, "a bad percent-escape in the user"],
    [`postgres://u:${MARK}@127.0.0.1:1/x%zz`, "a bad percent-escape in the database"],
    [`mysql://u:${MARK}@127.0.0.1:1/x`, "a mysql: URL"],
    [`file:///tmp/${MARK}.db`, "a file: URL"],
  ] as const) {
    const r = child(RESOLVE, { DATABASE_URL: bad });
    ok(r.code === 2 && r.err.trim() === UNPARSEABLE_DATABASE_URL && !r.err.includes(MARK) && !r.out.includes(MARK), `DATABASE_URL with ${what}: exit 2, refused without a word of it (exit ${r.code}: ${r.err.trim().slice(0, 80)})`);
    const f = child(`import { databaseUrl } from "./connect.ts"; console.log("resolved " + databaseUrl(${JSON.stringify(bad)}, {}));`);
    ok(f.code === 2 && f.err.trim() === UNPARSEABLE_DATABASE_URL && !f.out.includes("resolved"), `--url with ${what}: the same refusal (exit ${f.code})`);
    const o = child(`import { openSql } from "./connect.ts"; openSql(${JSON.stringify(bad)}); console.log("opened");`);
    ok(o.code !== 0 && o.err.includes(UNPARSEABLE_DATABASE_URL) && !o.err.includes(MARK) && !o.out.includes("opened"), `openSql on ${what} throws the fixed message, not the client's error (exit ${o.code})`);
  }
  // A URL that parses but the client refuses: its own error is not what is thrown.
  const refused = child(`import { openSql } from "./connect.ts"; try { openSql("postgres://u:${MARK}@127.0.0.1:1/x?sslmode=bogus"); console.log("opened"); } catch (e) { console.log("threw: " + e.message); }`);
  ok(refused.out.trim() === "threw: The database client refused the URL. (Nothing of it is printed.)" && !refused.err.includes(MARK), `openSql on a URL the client refuses (sslmode=bogus) throws its own fixed message (${refused.out.trim()})`);
  // The client: one connection unless asked (opening one does not connect).
  const one = openSql("postgres://u@127.0.0.1:1/x"), five = openSql("postgres://u@127.0.0.1:1/x", { max: 5 });
  ok(one.options.max === 1 && five.options.max === 5, `openSql: one connection by default, the asked-for pool otherwise (${one.options.max}, ${five.options.max})`);
  await Promise.all([one.close(), five.close()]);
}

// ---------------------------------------------------------------------------
// The door: body, then every close, then the exit — whatever the body did.
// ---------------------------------------------------------------------------
{
  // The exit handler writes past the door's end of stdout, so it writes to fd 1 directly.
  const pools = `const log = (s) => process.stdout.write(s + "\\n");
    const pool = (name, fails = false) => ({ close: async () => { await Bun.sleep(20); log("close " + name); if (fails) throw new Error("close failed"); } });
    process.on("exit", (c) => require("node:fs").writeSync(1, "exit " + c + "\\n"));`;
  const door = (body: string, poolList = `[pool("a"), pool("b")]`) =>
    child(`import { closeThenExit } from "./connect.ts"; ${pools} await closeThenExit(${poolList}, async () => { ${body} }); log("after the door");`);

  const three = door(`log("body"); return 3;`);
  ok(three.code === 3 && three.out === "body\nclose a\nclose b\nexit 3\n", `a returned code: the body, both pools closed, then exit with it (${JSON.stringify(three.out)}, exit ${three.code})`);
  const zero = door(`log("body"); return 0;`);
  ok(zero.code === 0 && zero.out === "body\nclose a\nclose b\nexit 0\n", "0 exits 0, after both closes; nothing runs after the door");
  const top = door(`return 255;`);
  ok(top.code === 255, `255, the top exit status, stands (exit ${top.code})`);
  for (const [bad, what] of [["NaN", "NaN"], ["2.7", "a fraction"], ["256", "256, which the runtime would exit as 0"], ["300", "past 255"], ["-1", "negative"], ["undefined", "no code"], [`"3"`, "a string"]] as const) {
    const r = door(`return ${bad};`);
    ok(r.code === 1 && r.out.includes("close a\nclose b\n"), `a code that is not an exit status (${what}) exits 1, after the closes (exit ${r.code})`);
  }
  const one = child(`import { closeThenExit } from "./connect.ts"; ${pools} await closeThenExit(pool("only"), async () => 1);`);
  ok(one.code === 1 && one.out === "close only\nexit 1\n", `a single pool, not in an array, is closed (${JSON.stringify(one.out)})`);
  const thrown = door(`log("body"); throw new Error("body failed");`);
  ok(thrown.code === 1 && thrown.out.startsWith("body\nclose a\nclose b\n") && /body failed/.test(thrown.err) && !thrown.out.includes("after the door"), `a throw closes both pools, then reaches the handler (Bun's: exit 1) (${JSON.stringify(thrown.out)}, exit ${thrown.code})`);
  const caught = child(`import { closeThenExit } from "./connect.ts"; ${pools} try { await closeThenExit(pool("a"), async () => { throw new Error("x"); }); } catch { log("handler"); process.exit(4); }`);
  ok(caught.code === 4 && caught.out === "close a\nhandler\nexit 4\n", `a script's own handler sees the throw after the close (tier.ts's main catch) (${JSON.stringify(caught.out)})`);
  const badClose = door(`return 5;`, `[pool("a", true), pool("b")]`);
  ok(badClose.code === 5 && badClose.out.includes("close a\n") && badClose.out.includes("close b\n"), `a pool that fails to close does not keep the other open, and the code stands (${JSON.stringify(badClose.out)}, exit ${badClose.code})`);
  const syncThrow = door(`return 6;`, `[{ close: () => { throw new Error("sync close"); } }, pool("b")]`);
  ok(syncThrow.code === 6 && syncThrow.out.includes("close b\n"), `a close that throws rather than rejecting does not strand the other pool or replace the code (${JSON.stringify(syncThrow.out)}, exit ${syncThrow.code})`);

  // What the body wrote reaches a slow pipe whole: an exit cut a 5 MB
  // process.stdout.write short, since Bun hands it on asynchronously.
  // A failing code flushes too: --diff prints its moved rankings, then exits 1.
  const BYTES = 100 * 50000;
  for (const [how, stream, exit] of [["process.stdout.write", "stdout", 0], ["console.log", "stdout", 0], ["process.stderr.write", "stderr", 0], ["process.stdout.write", "stdout", 1]] as const) {
    const write = how === "console.log" ? `for (let i = 0; i < 50000; i++) console.log(line);` : `${how}((line + "\\n").repeat(50000));`;
    const p = Bun.spawn(["bun", "--no-env-file", "-e", `import { closeThenExit } from "./connect.ts"; await closeThenExit([], async () => { const line = "x".repeat(99); ${write} return ${exit}; });`], { cwd: HERE, env: BASE_ENV, stdout: "pipe", stderr: "pipe" });
    // A door that never flushes fails this check rather than hanging the suite.
    const killer = setTimeout(() => p.kill(), 30_000);
    const drain = async (s: ReadableStream<Uint8Array>, slow: boolean) => { const reader = s.getReader(); let n = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (slow) await Bun.sleep(1); } return n; };
    const [nOut, nErr] = await Promise.all([drain(p.stdout, stream === "stdout"), drain(p.stderr, stream === "stderr")]);
    const code = await p.exited;
    clearTimeout(killer);
    const n = stream === "stdout" ? nOut : nErr;
    ok(code === exit && n === BYTES, `${how} of 5 MB through the door, exiting ${exit}, reaches a slow reader of ${stream} whole (${n} of ${BYTES} bytes, exit ${code})`);
  }

  // A script on the door keeps its codes: graph-centrality's rule is 2 for a
  // failure, never 1 (which means "not in the graph"), and a dead port is one.
  const failed = spawn(["graph-centrality.ts", "--url", `postgres://u:${MARK}@127.0.0.1:1/x`]);
  ok(failed.code === 2 && /graph-centrality failed:/.test(failed.err) && !failed.err.includes(MARK), `graph-centrality.ts at a dead port: exit 2 through the door, not 1 (exit ${failed.code}: ${failed.err.trim().split("\n")[0]})`);
}

// ---------------------------------------------------------------------------
// The tree: one resolver, one client, one loopback rule; no exit on the door.
// ---------------------------------------------------------------------------
const sources = readdirSync(HERE).filter((f) => /\.ts$/.test(f) && !/^test-/.test(f)).sort();
const read = (f: string) => readFileSync(join(HERE, f), "utf8");
/**
 * The text of the call starting at `from` (an index of its name), up to its
 * matching `)` — parentheses inside a string, a template or a comment not counted.
 */
function callText(text: string, from: number): string {
  const open = text.indexOf("(", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i === -1) break; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; if (i === 0) break; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}
{
  ok(sources.includes("connect.ts") && sources.length >= 30, `the census reads db/'s scripts and libraries (${sources.length})`);
  const READS_URL = /(process\.env|Bun\.env|import\.meta\.env)\s*(\.\s*DATABASE_URL\b|\[\s*["'`]DATABASE_URL["'`]\s*\])|\{[^}]*\bDATABASE_URL\b[^}]*\}\s*=\s*(process\.env|Bun\.env|import\.meta\.env)/;
  const BUILDS_CLIENT = /new\s+SQL\s*\(|\bBun\.(sql|SQL)\b|import\s*\*\s*as\s+\w+\s+from\s*["']bun["']|import\s*\{[^}]*(\bsql\b|(?<!\btype\s+)\bSQL\s+as\s+\w+)[^}]*\}\s*from\s*["']bun["']/;
  for (const f of sources.filter((s) => s !== "connect.ts")) {
    const text = read(f);
    ok(!READS_URL.test(text), `${f} does not read DATABASE_URL itself — connect.ts's databaseUrl (or test-support's requireDatabaseUrl) does`);
    ok(!BUILDS_CLIENT.test(text), `${f} builds no client of its own, nor imports Bun's ambient one — connect.ts's openSql does`);
    ok(!text.includes(NO_DATABASE_URL) && !text.includes(UNPARSEABLE_DATABASE_URL), `${f} carries no copy of the resolver's refusals`);
  }
  // The census's patterns have teeth, on the shapes a refactor would write.
  for (const s of ["process.env.DATABASE_URL", "process.env['DATABASE_URL']", "process.env[`DATABASE_URL`]", "Bun.env.DATABASE_URL", "import.meta.env.DATABASE_URL", "const { DATABASE_URL } = process.env"])
    ok(READS_URL.test(s), `the census sees ${s}`);
  for (const s of ["new SQL(url)", "new Bun.SQL({ url })", "const Pg = Bun.SQL; new Pg(url)", `import * as B from "bun"; new B.SQL(url)`, `import { sql } from "bun"`, `import { SQL as Pg } from "bun"`, "Bun.sql`SELECT 1`"])
    ok(BUILDS_CLIENT.test(s), `the census sees ${s}`);
  for (const s of [`import { SQL } from "bun"; async function f(sql: SQL) {}`, `import { type SQL as T } from "bun"`])
    ok(!BUILDS_CLIENT.test(s), `…and not a type-only use: ${s}`);

  // A script that takes --url resolves it through databaseUrl, and reads it nowhere else.
  const withUrl = sources.filter((f) => /\burl: "one"/.test(read(f)));
  ok(withUrl.length >= 9, `the census finds the scripts that take --url (${withUrl.length}: ${withUrl.join(", ")})`);
  for (const f of withUrl) {
    const text = read(f);
    const reads = (text.match(/\bcli\.value\("url"\)|\bparsed\.url\b/g) ?? []).length;
    const resolved = (text.match(/databaseUrl\((cli\.value\("url"\)|parsed\.url)\)/g) ?? []).length;
    ok(resolved >= 1 && reads === resolved, `${f} resolves --url through databaseUrl and reads it nowhere else (${resolved} of ${reads} reads)`);
  }
  // The loopback names are spelled once, in db/'s and evals/'s TypeScript,
  // suites included: a second spelling is a second rule (eval-quant.ts had
  // one). "127.0.0.1" is left out: servers in the suites bind it. config.mjs's
  // isLocalHostname answers another question and is not TypeScript.
  // Quotes, not a backtick: the docs quote hosts that way (`[::1]`).
  const LOOPBACK_SPELLING = /["'](localhost|\[::1\]|::1|0\.0\.0\.0)["']/;
  const EVALS = join(HERE, "..", "evals");
  const spellers = [
    ...readdirSync(HERE).filter((s) => /\.ts$/.test(s) && s !== "connect.ts" && s !== "test-connect.ts").map((s) => [s, join(HERE, s)]),
    ...readdirSync(EVALS).filter((s) => /\.ts$/.test(s)).map((s) => [`evals/${s}`, join(EVALS, s)]),
  ];
  ok(spellers.length >= 60, `the loopback census reads db/ and evals/ (${spellers.length} files)`);
  for (const [name, path] of spellers) ok(!LOOPBACK_SPELLING.test(readFileSync(path, "utf8")), `${name} spells no loopback host of its own — connect.ts's rule is the one`);
  ok(LOOPBACK_SPELLING.test(`["localhost", "127.0.0.1"].includes(h)`), "the loopback census sees a regrown two-name rule");

  // assertThrowawayDatabase is async since it asks the server (SMD-2317): a
  // call without `await` would let its caller's drops run while the check was
  // still out, and its refusal land after them. Every call in db/ and evals/,
  // suites included, is awaited. Only a call is counted: an import or the
  // definition is not followed by `(`.
  const UNAWAITED = /(?<!\bawait\s+)\bassertThrowawayDatabase\s*\(/g;
  const everyTs = [
    ...readdirSync(HERE).filter((s) => /\.ts$/.test(s) && s !== "test-connect.ts").map((s) => [s, join(HERE, s)]),
    ...readdirSync(EVALS).filter((s) => /\.ts$/.test(s)).map((s) => [`evals/${s}`, join(EVALS, s)]),
  ];
  let calls = 0;
  for (const [name, path] of everyTs) {
    const text = readFileSync(path, "utf8").replace(/export async function assertThrowawayDatabase\(/, "");
    calls += (text.match(/\bawait\s+assertThrowawayDatabase\s*\(/g) ?? []).length;
    const bare = [...text.matchAll(UNAWAITED)].length;
    ok(bare === 0, `${name}: every assertThrowawayDatabase call is awaited (${bare} not)`);
  }
  ok(calls >= 5, `the await census finds the calls (${calls}: bench-hnsw, test-bench-reuse and three evals)`);
  for (const s of ["assertThrowawayDatabase(URL_);", "void assertThrowawayDatabase(u)", "assertThrowawayDatabase (u).then(run)"]) ok([...s.matchAll(UNAWAITED)].length === 1, `the await census sees ${s}`);
  ok([...`await assertThrowawayDatabase(URL_);`.matchAll(UNAWAITED)].length === 0, "…and not an awaited call");

  const onDoor = sources.filter((f) => f !== "connect.ts" && /closeThenExit\(/.test(read(f)));
  for (const must of ["hnsw-graph.ts", "graph-centrality.ts", "tier.ts"]) ok(onDoor.includes(must), `${must} exits through the door`);
  const EXITS = /\bexit\s*\(|process\s*\[\s*["'`]exit["'`]\s*\]|=\s*process\.exit\b/;
  const CLOSES = /\.\s*(close|end)\s*\(/;
  /**
   * The pools a door is handed: its first argument must name only clients from
   * openSql, at least one, and every such client its body uses — a pool left
   * out is the unclosed pool the door exists to prevent (review pass 4).
   */
  const doorPools = (text: string, call: string): { handed: string[]; bound: string[]; used: string[] } => {
    const bound = [...text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*openSql\(/g)].map((m) => m[1]);
    const first = call.slice("closeThenExit(".length, call.indexOf(", async () =>"));
    const handed = [...first.matchAll(/\w+/g)].map((m) => m[0]);
    const body = call.slice(call.indexOf(", async () =>"));
    return { handed, bound, used: bound.filter((b) => new RegExp(`\\b${b}\\b`).test(body)) };
  };
  for (const f of onDoor) {
    const text = read(f);
    for (let at = text.indexOf("closeThenExit("); at !== -1; at = text.indexOf("closeThenExit(", at + 1)) {
      const call = callText(text, at);
      ok(call.includes("async () =>") && /\}\s*\)$/.test(call), `${f}: the door's call reads to its own close (${call.length} chars)`);
      ok(!EXITS.test(call), `${f}: nothing inside the door's body exits — it returns its code, and the door closes then exits`);
      ok(!CLOSES.test(call), `${f}: the door's body closes nothing itself`);
      const { handed, bound, used } = doorPools(text, call);
      ok(handed.length > 0 && handed.every((h) => bound.includes(h)) && used.every((u) => handed.includes(u)), `${f}: the door is handed its clients — [${handed.join(", ")}], every one from openSql, none its body uses left out (uses: ${used.join(", ") || "none by name"})`);
    }
  }
  // …with teeth: a pool dropped from the door, or none handed, is seen.
  const TWO = `const stable = openSql(a); const canary = openSql(b);`;
  const dropped = doorPools(TWO, `closeThenExit([stable], async () => { await reach(stable); await reach(canary); return 0; })`);
  ok(!dropped.used.every((u) => dropped.handed.includes(u)), "the door census sees a pool its body uses left out of the door");
  const none = doorPools(TWO, `closeThenExit([], async () => { return 0; })`);
  ok(none.handed.length === 0, "…and a door handed no pool");
  // The census has teeth: the shapes an exit or a close takes in a body are seen,
  // and a parenthesis in a string or a comment does not end the call early.
  for (const s of ["process.exit(2)", "process.exit (2)", `process["exit"](2)`, "const exit = process.exit; exit(2)", "quitWith(); process.exit(1)"]) ok(EXITS.test(s), `the door census sees ${s}`);
  for (const s of ["sql.close()", "sql.close({ timeout: 1 })", "sql.end()"]) ok(CLOSES.test(s), `the door census sees ${s}`);
  const planted = callText(`await closeThenExit(sql, async () => { console.log("a ) b"); // c ) d\n /* e ) f */ if (x) { process.exit(2); } return (a(b)) ? 1 : 0; }); after();`, 6);
  ok(EXITS.test(planted) && /\}\)$/.test(planted) && !planted.includes("after"), `the call reader skips parentheses in strings and comments, finds the planted exit, and stops at the call's own parenthesis (${JSON.stringify(planted.slice(-20))})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
