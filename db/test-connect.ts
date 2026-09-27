#!/usr/bin/env bun
/**
 * test-connect.ts — how every db/ script reaches its database (db/connect.ts,
 * SMD-2302), hermetic.
 *
 * No Postgres, no model, no network. Four parts: the one loopback rule as a
 * truth table (tier.ts's --refresh and the test scaffolding answered it
 * differently until SMD-2302); the URL resolver and its refusal; the
 * close-then-exit door, run for real with pools that record their close; and
 * the tree's shape — no script outside connect.ts resolves DATABASE_URL, builds
 * a client or spells a loopback host of its own, and no body on the door calls
 * process.exit (hnsw-graph.ts and tier.ts's --replay/--diff did, inside the
 * `try` whose `finally` closed the pool). Runs beside test-cli.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOPBACK_HOSTS, NO_DATABASE_URL, REMOTE_DB_FLAG, RETIRED_REMOTE_DB_FLAG, databaseUrl, hostOf, isThrowawayHost, mayReset, openSql, remoteDbAllowed } from "./connect.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const HERE = import.meta.dir;

// ---------------------------------------------------------------------------
// May this database be reset? One truth table.
// ---------------------------------------------------------------------------
{
  // [url, a throwaway host?] — the host alone, no override.
  const HOSTS: [string, boolean, string][] = [
    ["postgres://u:p@localhost:5432/db", true, "localhost"],
    ["postgres://u:p@LOCALHOST:5432/db", true, "localhost in capitals (a non-special scheme keeps the case)"],
    ["postgres://u:p@127.0.0.1:5432/db", true, "127.0.0.1"],
    ["postgresql://127.0.0.1/db", true, "127.0.0.1 under postgresql://"],
    ["postgres://u:p@[::1]:5432/db", true, "[::1]"],
    ["postgres://u:p@0.0.0.0:5432/db", true, "0.0.0.0 (tier.ts's rule did not know it)"],
    ["postgres:///db", false, "an empty host (resolves through PGHOST; tier.ts's rule trusted it)"],
    ["postgres://u@/db?host=/var/run/postgresql", false, "a libpq socket URL, which does not parse"],
    ["not a url", false, "a string that does not parse"],
    ["postgres://u:p@postgres:5432/db", false, "a compose service name"],
    ["postgres://u:p@192.168.1.5:5432/db", false, "an RFC1918 address (config.mjs's isLocalHostname would say local)"],
    ["postgres://u:p@host.docker.internal:5432/db", false, "the container-to-host alias"],
    ["postgres://u:p@127.0.0.2:5432/db", false, "127.0.0.2, not named"],
    ["postgres://u:p@localhost.example.com:5432/db", false, "a host that begins with localhost"],
    ["postgres://u:p@db.example.com:5432/db", false, "a remote host"],
  ];
  const none = {};
  for (const [url, local, what] of HOSTS) {
    ok(isThrowawayHost(url) === local, `isThrowawayHost: ${what} → ${local}`);
    ok(mayReset(url, none) === local, `mayReset, no override: ${what} → ${local}`);
    ok(mayReset(url, { OB1_ALLOW_REMOTE_DB: "1" }) === true, `mayReset, OB1_ALLOW_REMOTE_DB=1: ${what} → true`);
    // The eval-local name, which the scaffolding honoured and tier.ts did not:
    // read here it would pass deploy/tier.sh, which strips only the one name.
    ok(mayReset(url, { OB1_EVAL_ALLOW_REMOTE_DB: "1" }) === local, `mayReset, OB1_EVAL_ALLOW_REMOTE_DB=1 (retired): ${what} → ${local}`);
  }
  ok(REMOTE_DB_FLAG === "OB1_ALLOW_REMOTE_DB" && RETIRED_REMOTE_DB_FLAG === "OB1_EVAL_ALLOW_REMOTE_DB", "the override is OB1_ALLOW_REMOTE_DB; the eval-local name is retired");
  for (const v of ["0", "", "true", "yes", " 1", "1 ", "01"])
    ok(!remoteDbAllowed({ OB1_ALLOW_REMOTE_DB: v }) && !mayReset("postgres:///db", { OB1_ALLOW_REMOTE_DB: v }), `OB1_ALLOW_REMOTE_DB=${JSON.stringify(v)} is not the override (exactly "1")`);
  ok(!remoteDbAllowed({ OB1_ALLOW_REMOTE: "1", ALLOW_REMOTE_DB: "1", OB1_EVAL_ALLOW_REMOTE_DB: "1" }), "a near name, or the retired one, is not the override");
  ok(mayReset("postgres://db.example.com/x", { ...process.env, OB1_ALLOW_REMOTE_DB: undefined, OB1_EVAL_ALLOW_REMOTE_DB: undefined }) === false, "the env defaults to process.env's shape: a remote host with neither set is refused");

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
// The URL: --url, else DATABASE_URL, else exit 2 with the one refusal.
// ---------------------------------------------------------------------------
function child(code: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "DATABASE_URL" && k !== REMOTE_DB_FLAG && k !== RETIRED_REMOTE_DB_FLAG) base[k] = v;
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: HERE, env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}
{
  ok(databaseUrl("postgres://flag/db", { DATABASE_URL: "postgres://env/db" }) === "postgres://flag/db", "--url wins over DATABASE_URL");
  ok(databaseUrl(undefined, { DATABASE_URL: "postgres://env/db" }) === "postgres://env/db", "DATABASE_URL when no --url");
  const RESOLVE = `import { databaseUrl } from "./connect.ts"; console.log("resolved " + databaseUrl(undefined));`;
  for (const [what, env] of [["unset", {}], ["empty", { DATABASE_URL: "" }], ["blank", { DATABASE_URL: "   " }]] as const) {
    const r = child(RESOLVE, env);
    ok(r.code === 2 && r.err.trim() === NO_DATABASE_URL && !r.out.includes("resolved"), `DATABASE_URL ${what} and no --url: exit 2, the one refusal (exit ${r.code}: ${r.err.trim()})`);
  }
  // The suites' refusal of the rule: a remote host exits 2 naming the host, and
  // a shell that still sets the retired name is told so.
  const GUARD = `import { assertThrowawayDatabase } from "./test-support.ts"; assertThrowawayDatabase("postgres://u:SECRET-2302@db.example.com/x"); console.log("dropped");`;
  const guarded = child(GUARD);
  ok(guarded.code === 2 && /Refusing to drop the schema at db\.example\.com/.test(guarded.err) && !guarded.out.includes("dropped") && !guarded.err.includes("SECRET-2302") && !guarded.err.includes(RETIRED_REMOTE_DB_FLAG), `assertThrowawayDatabase refuses a remote host by name, never its password (exit ${guarded.code})`);
  const retired = child(GUARD, { [RETIRED_REMOTE_DB_FLAG]: "1" });
  ok(retired.code === 2 && retired.err.includes(`${RETIRED_REMOTE_DB_FLAG} is set, and is no longer read: the name is ${REMOTE_DB_FLAG}`) && !retired.out.includes("dropped"), `…and with the retired name set it still refuses, and says the name to use (exit ${retired.code})`);
  const allowed = child(GUARD, { [REMOTE_DB_FLAG]: "1" });
  ok(allowed.code === 0 && allowed.out.trim() === "dropped", `…and ${REMOTE_DB_FLAG}=1 lets it through (exit ${allowed.code})`);
  // The client: one connection unless asked (opening one does not connect).
  const one = openSql("postgres://u@127.0.0.1:1/x"), five = openSql("postgres://u@127.0.0.1:1/x", { max: 5 });
  ok(one.options.max === 1 && five.options.max === 5, `openSql: one connection by default, the asked-for pool otherwise (${one.options.max}, ${five.options.max})`);
  await Promise.all([one.close(), five.close()]);
  const set = child(RESOLVE, { DATABASE_URL: "postgres://u:SECRET-2302@h/db" });
  ok(set.code === 0 && set.out.trim() === "resolved postgres://u:SECRET-2302@h/db" && !set.err.includes("SECRET-2302"), "a set DATABASE_URL resolves, and nothing is printed of it");
}

// ---------------------------------------------------------------------------
// The door: body, then every close, then the exit — whatever the body did.
// ---------------------------------------------------------------------------
{
  const pools = `const log = (s) => process.stdout.write(s + "\\n");
    const pool = (name, fails = false) => ({ close: async () => { await Bun.sleep(20); log("close " + name); if (fails) throw new Error("close failed"); } });
    process.on("exit", (c) => log("exit " + c));`;
  const door = (body: string, poolList = `[pool("a"), pool("b")]`) =>
    child(`import { closeThenExit } from "./connect.ts"; ${pools} await closeThenExit(${poolList}, async () => { ${body} }); log("after the door");`);

  const three = door(`log("body"); return 3;`);
  ok(three.code === 3 && three.out === "body\nclose a\nclose b\nexit 3\n", `a returned code: the body, both pools closed, then exit with it (${JSON.stringify(three.out)}, exit ${three.code})`);
  const zero = door(`log("body"); return 0;`);
  ok(zero.code === 0 && zero.out === "body\nclose a\nclose b\nexit 0\n", "0 exits 0, after both closes; nothing runs after the door");
  const one = child(`import { closeThenExit } from "./connect.ts"; ${pools} await closeThenExit(pool("only"), async () => 1);`);
  ok(one.code === 1 && one.out === "close only\nexit 1\n", `a single pool, not in an array, is closed (${JSON.stringify(one.out)})`);
  const thrown = door(`log("body"); throw new Error("body failed");`);
  ok(thrown.code === 1 && thrown.out.startsWith("body\nclose a\nclose b\n") && /body failed/.test(thrown.err) && !thrown.out.includes("after the door"), `a throw closes both pools, then reaches the handler (Bun's: exit 1) (${JSON.stringify(thrown.out)}, exit ${thrown.code})`);
  const caught = child(`import { closeThenExit } from "./connect.ts"; ${pools} try { await closeThenExit(pool("a"), async () => { throw new Error("x"); }); } catch { log("handler"); process.exit(4); }`);
  ok(caught.code === 4 && caught.out === "close a\nhandler\nexit 4\n", `a script's own handler sees the throw after the close (tier.ts's main catch) (${JSON.stringify(caught.out)})`);
  const badClose = door(`return 5;`, `[pool("a", true), pool("b")]`);
  ok(badClose.code === 5 && badClose.out.includes("close a\n") && badClose.out.includes("close b\n"), `a pool that fails to close does not keep the other open, and the code stands (${JSON.stringify(badClose.out)}, exit ${badClose.code})`);
}

// ---------------------------------------------------------------------------
// The tree: one resolver, one client, one loopback rule; no exit on the door.
// ---------------------------------------------------------------------------
const sources = readdirSync(HERE).filter((f) => /\.ts$/.test(f) && !/^test-/.test(f)).sort();
const read = (f: string) => readFileSync(join(HERE, f), "utf8");
/** The text of the call starting at `from` (an index of its name), up to its matching `)`. */
function callText(text: string, from: number): string {
  const open = text.indexOf("(", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}
{
  ok(sources.includes("connect.ts") && sources.length >= 30, `the census reads db/'s scripts and libraries (${sources.length})`);
  for (const f of sources.filter((s) => s !== "connect.ts")) {
    const text = read(f);
    ok(!/process\.env\.DATABASE_URL|process\.env\[["']DATABASE_URL["']\]/.test(text), `${f} does not read DATABASE_URL itself — connect.ts's databaseUrl (or test-support's requireDatabaseUrl) does`);
    ok(!/new\s+(Bun\.)?SQL\s*\(/.test(text), `${f} builds no client of its own — connect.ts's openSql does`);
    ok(!text.includes(NO_DATABASE_URL), `${f} carries no copy of the missing-URL refusal`);
  }
  // A script that takes --url resolves it through databaseUrl, and reads it nowhere else.
  const withUrl = sources.filter((f) => /\burl: "one"/.test(read(f)));
  ok(withUrl.length >= 9, `the census finds the scripts that take --url (${withUrl.length}: ${withUrl.join(", ")})`);
  for (const f of withUrl) {
    const text = read(f);
    const reads = (text.match(/\bcli\.value\("url"\)|\bparsed\.url\b/g) ?? []).length;
    const resolved = (text.match(/databaseUrl\((cli\.value\("url"\)|parsed\.url)\)/g) ?? []).length;
    ok(resolved >= 1 && reads === resolved, `${f} resolves --url through databaseUrl and reads it nowhere else (${resolved} of ${reads} reads)`);
  }
  // The loopback hosts are spelled once in db/'s TypeScript, suites included:
  // a second spelling is a second rule (config.mjs's isLocalHostname answers
  // another question and is not TypeScript).
  for (const f of readdirSync(HERE).filter((s) => /\.ts$/.test(s) && s !== "connect.ts" && s !== "test-connect.ts"))
    ok(!/["'](\[::1\]|::1|0\.0\.0\.0)["']/.test(read(f)), `${f} spells no loopback host of its own — connect.ts's rule is the one`);
  ok(/mayReset\(toUrl\)/.test(read("tier.ts")), "tier.ts's --refresh asks connect.ts's rule of --to");
  ok(/if \(mayReset\(url\)\) return;/.test(read("test-support.ts")), "test-support.ts's assertThrowawayDatabase asks the same rule");

  const onDoor = sources.filter((f) => f !== "connect.ts" && /closeThenExit\(/.test(read(f)));
  for (const must of ["hnsw-graph.ts", "graph-centrality.ts", "tier.ts"]) ok(onDoor.includes(must), `${must} exits through the door`);
  for (const f of onDoor) {
    const text = read(f);
    for (let at = text.indexOf("closeThenExit("); at !== -1; at = text.indexOf("closeThenExit(", at + 1)) {
      const call = callText(text, at);
      ok(call.includes("async () =>") && call.endsWith(")"), `${f}: the door's call parses (${call.length} chars)`);
      ok(!/process\.exit\(/.test(call), `${f}: no process.exit inside the door's body — it returns its code, and the door closes then exits`);
      ok(!/\.close\(\)/.test(call), `${f}: the door's body closes nothing itself`);
    }
  }
  // The census has teeth: a body with an exit in it is seen.
  const planted = callText(`await closeThenExit(sql, async () => { if (x) { process.exit(2); } return (a(b)) ? 1 : 0; }); after();`, 6);
  ok(/process\.exit\(/.test(planted) && planted.endsWith("});") === false && planted.endsWith("})"), "the census's call reader finds an exit planted in a body, and stops at the call's own parenthesis");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
