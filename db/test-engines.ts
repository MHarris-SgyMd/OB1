#!/usr/bin/env bun
/**
 * test-engines.ts — the db/ scripts that are engines: importable without side
 * effects, and callable in-process through their run() (SMD-2304), hermetic.
 *
 * No Postgres, no model, no network beyond a loopback listener that counts
 * connections and closes each on arrival. For every engine in ENGINES:
 *   - importing it opens no connection, prints nothing and installs no
 *     process listener — the four scripts ran their whole pass at import;
 *   - the text before its `if (import.meta.main)` holds no process.exit,
 *     process.on, argv scan, URL resolution, door or console call: run()
 *     returns its code and writes through the Writer it is given;
 *   - run() refuses what the CLI refuses, in the CLI's words (the spawned
 *     script's first stderr line) and with its exit code, before connecting;
 *   - run() never closes a client the caller passed it.
 * Runs beside test-cli.ts and test-connect.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Writer } from "./cli.ts";
import { NO_DATABASE_URL, UNPARSEABLE_DATABASE_URL, openSql } from "./connect.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const HERE = import.meta.dir;
const MARK = "SECRET-2304";
/** The engines, one more per SMD-2304 PR. */
const ENGINES = ["migrate.ts"] as const;

/** A child's environment: this one without a database URL, any OB1_* knob or PG* variable; no .env file read. */
const BASE_ENV: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "DATABASE_URL" && !k.startsWith("OB1_") && !k.startsWith("PG")) BASE_ENV[k] = v;
BASE_ENV.OB1_ENV_FILES = "off";

// A loopback listener that counts connections and closes each on arrival.
let seen = 0;
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { seen++; s.end(); }, data() {} } });
const AT = `postgres://u:${MARK}@127.0.0.1:${listener.port}/x`;

/**
 * A child `bun --no-env-file` run asynchronously, so the listener accepts while
 * it runs, with the connections it opened counted. A control is stopped at its
 * first connection: Bun's client retries a socket closed on arrival.
 */
async function counted(argv: string[], env: Record<string, string> = {}, control = false) {
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
}

/** A writer that keeps what it is given. */
function capture(): Writer & { outs: string[]; errs: string[] } {
  const outs: string[] = [], errs: string[] = [];
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l) };
}

const SIGNALS = ["SIGINT", "SIGTERM", "exit", "beforeExit", "uncaughtException", "unhandledRejection"] as const;
const listenerCounts = () => SIGNALS.map((s) => process.listenerCount(s)).join(",");

// ---------------------------------------------------------------------------
// Importing an engine does nothing but define it.
// ---------------------------------------------------------------------------
for (const engine of ENGINES) {
  const r = await counted(["-e", `const m = await import("./${engine}"); console.log(typeof m.run);`], { DATABASE_URL: AT });
  ok(r.code === 0 && r.out === "function\n" && r.err === "" && r.seen === 0, `${engine} imports with no side effect: run is exported, nothing printed, no connection opened with DATABASE_URL set (exit ${r.code}, out ${JSON.stringify(r.out)}, err ${JSON.stringify(r.err.slice(0, 120))}, ${r.seen} connection(s))`);
  // The control: the same import, run, does reach the listener — so the zero above counts.
  const control = await counted(["-e", `const m = await import("./${engine}"); await m.run({ url: ${JSON.stringify(AT)} });`], {}, true);
  ok(control.seen > 0, `…the control: ${engine}'s run() on that URL does connect (${control.seen} connection(s))`);

  const before = listenerCounts();
  const m = await import(`./${engine}`);
  ok(listenerCounts() === before && typeof m.run === "function", `${engine} installs no process listener when imported in-process (${before} → ${listenerCounts()})`);
}

// ---------------------------------------------------------------------------
// The engine's code: no exit, no process handler, no argv, no console.
// ---------------------------------------------------------------------------
const FORBIDDEN: [RegExp, string][] = [
  [/\bprocess\.exit\b/, "process.exit"],
  [/\bprocess\.on\(|\bprocess\.once\(|\bprocess\.addListener\(/, "a process listener"],
  [/\bcommandLine\(|\bscriptArgv\(|\bprocess\.argv\b/, "an argv scan"],
  [/\bdatabaseUrl\(/, "databaseUrl (the CLI's resolver, which exits)"],
  [/\bcloseThenExit\(/, "the door (it ends stdout and stderr, then exits)"],
  [/\bconsole\.(log|error|warn|info|debug)\(/, "a console call (the Writer is the engine's output)"],
  [/\bprocess\.(stdout|stderr)\b/, "a direct stream write"],
];
for (const engine of ENGINES) {
  const text = readFileSync(join(HERE, engine), "utf8");
  const mains = text.split("if (import.meta.main)").length - 1;
  ok(mains === 1, `${engine} has one \`if (import.meta.main)\` (${mains})`);
  ok(/export async function run\(/.test(text), `${engine} exports run()`);
  const engineText = text.slice(0, text.indexOf("if (import.meta.main)"));
  for (const [re, what] of FORBIDDEN) {
    const hit = engineText.match(re);
    ok(hit === null, `${engine}'s engine code (before \`if (import.meta.main)\`) holds no ${what}${hit ? ` — found ${JSON.stringify(hit[0])}` : ""}`);
  }
  const mainText = text.slice(text.indexOf("if (import.meta.main)"));
  ok(/closeThenExit\(/.test(mainText) && /\brun\(/.test(mainText), `${engine}'s CLI block exits through the door with run()'s code`);
}
// The census has teeth: the shapes it forbids are seen.
for (const [s, i] of [["process.exit(2)", 0], [`process.on("SIGINT", stop)`, 1], [`commandLine("x.ts", {})`, 2], ["databaseUrl(flag)", 3], ["closeThenExit(sql, async () => { return 0; })", 4], ["console.error(line)", 5], ["process.stdout.write(s)", 6]] as const)
  ok(FORBIDDEN[i][0].test(s), `the engine census sees ${s}`);

// ---------------------------------------------------------------------------
// run() refuses in the CLI's words, before connecting.
// ---------------------------------------------------------------------------
{
  const { run } = await import("./migrate.ts");
  /** run() in-process, counting the listener's connections. */
  const inProcess = async (opts: Record<string, unknown>) => {
    seen = 0;
    const w = capture();
    const code = await run({ ...opts, writer: w } as never);
    await Bun.sleep(50);
    return { code, w, seen };
  };
  const firstErr = (s: string) => s.split("\n").find((l) => l.trim() !== "") ?? "";
  const cases: [string, Record<string, unknown>, string[], Record<string, string>][] = [
    ["no URL", {}, [], {}],
    ["an unparseable URL", { url: `postgres://u:${MARK}/x@127.0.0.1:1/x` }, ["--url", `postgres://u:${MARK}/x@127.0.0.1:1/x`], {}],
    ["--reapply with --baseline", { url: AT, reapply: true, baseline: true }, ["--url", AT, "--reapply", "--baseline"], {}],
    ["--force alone", { url: AT, force: true }, ["--url", AT, "--force"], {}],
    ["--grant with --baseline", { url: AT, grant: "reader", baseline: true }, ["--url", AT, "--grant", "reader", "--baseline"], {}],
  ];
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess(opts);
    const cli = await counted(["migrate.ts", ...argv], env);
    ok(r.code === 2 && cli.code === 2, `migrate run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.w.errs.length === 1 && r.w.errs[0] === firstErr(cli.err) && r.w.outs.length === 0, `…the refusal in the CLI's words (${JSON.stringify(r.w.errs[0]?.slice(0, 90))})`);
    ok(r.seen === 0 && cli.seen === 0 && !r.w.errs.join("").includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  ok((await inProcess({})).w.errs[0] === NO_DATABASE_URL && (await inProcess({ url: "mysql://h/x" })).w.errs[0] === UNPARSEABLE_DATABASE_URL, "migrate run()'s URL refusals are connect.ts's own");

  // A caller's client: a pool wider than one is refused (session state), and it is never closed.
  const wide = openSql(AT, { max: 2 });
  const w = await inProcess({ sql: wide });
  ok(w.code === 2 && /needs a single connection/.test(w.w.errs[0] ?? "") && w.seen === 0, `migrate run() refuses a client wider than one connection (exit ${w.code}: ${w.w.errs[0]?.slice(0, 60)})`);
  await wide.close();
  let closed = false;
  const stub = { options: { max: 1 }, close: async () => { closed = true; } };
  const refused = await inProcess({ sql: stub, reapply: true, baseline: true });
  ok(refused.code === 2 && !closed, "migrate run() does not close a client the caller passed it");
  ok(process.listenerCount("SIGINT") === 0 && process.listenerCount("SIGTERM") === 0, "…and leaves no signal listener after its refusals");
}

listener.stop(true);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
