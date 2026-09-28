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
import {
  LOOPBACK_HOSTS, NO_DATABASE_URL, REMOTE_DB_FLAG, RETIRED_REMOTE_DB_FLAG, UNPARSEABLE_DATABASE_URL,
  databaseUrl, hostOf, mayReset, notThrowaway, openSql, remoteDbAllowed, resetRefusal,
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
  for (const [url, local, what] of HOSTS) {
    ok((notThrowaway(url) === null) === local, `notThrowaway: ${what} → ${local ? "no reason" : "a reason"}`);
    ok(mayReset(url, none) === local, `mayReset, no override: ${what} → ${local}`);
    ok(mayReset(url, { OB1_ALLOW_REMOTE_DB: "1" }) === true, `mayReset, OB1_ALLOW_REMOTE_DB=1: ${what} → true`);
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
// The refusals that print the rule, run: the suites' and tier.ts --refresh's.
// ---------------------------------------------------------------------------
{
  const guard = (url: string) => `import { assertThrowawayDatabase } from "./test-support.ts"; assertThrowawayDatabase(${JSON.stringify(url)}); console.log("dropped");`;
  const REMOTE = guard(`postgres://u:${MARK}@db.example.com/x`);
  const guarded = child(REMOTE);
  ok(guarded.code === 2 && /Refusing to drop the schema: db\.example\.com is not a loopback host/.test(guarded.err) && !guarded.out.includes("dropped") && !guarded.err.includes(MARK) && !guarded.err.includes(RETIRED_REMOTE_DB_FLAG), `assertThrowawayDatabase refuses a remote host by name, never its password (exit ${guarded.code})`);
  // The suites drop through Bun's client alone, which reaches the URL's host: a
  // developer's PGSERVICE or PGHOSTADDR does not refuse them (pass 1's list did).
  const viaEnv = child(guard("postgres://u@localhost/x"), { PGHOSTADDR: "10.0.0.5", PGSERVICE: "prod" });
  ok(viaEnv.code === 0 && viaEnv.out.trim() === "dropped", `…and localhost with PGHOSTADDR/PGSERVICE exported passes (exit ${viaEnv.code})`);
  const retired = child(REMOTE, { [RETIRED_REMOTE_DB_FLAG]: "1" });
  ok(retired.code === 2 && retired.err.includes(`${RETIRED_REMOTE_DB_FLAG} is set, and is no longer read: the name is ${REMOTE_DB_FLAG}`) && !retired.out.includes("dropped"), `…and with the retired name set it still refuses, and says the name to use (exit ${retired.code})`);
  const allowed = child(REMOTE, { [REMOTE_DB_FLAG]: "1" });
  ok(allowed.code === 0 && allowed.out.trim() === "dropped", `…and ${REMOTE_DB_FLAG}=1 lets it through (exit ${allowed.code})`);
  const local = child(guard("postgres://u@127.0.0.1:1/x"));
  ok(local.code === 0 && local.out.trim() === "dropped", `…and a loopback host passes (exit ${local.code})`);
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
    ["postgres:///b", /--to is not plainly this machine — the URL has no host/, "an empty host"],
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
