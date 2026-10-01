#!/usr/bin/env bun
/**
 * test-engines.ts — the db/ scripts that are engines: importable without side
 * effects, and callable in-process through their run() (SMD-2304), hermetic.
 *
 * No Postgres, no model, no network beyond a loopback listener that counts
 * connections and closes each on arrival. For every engine in ENGINES:
 *   - importing it opens no connection, prints nothing and installs no
 *     process listener — the four scripts ran their whole pass at import;
 *   - its code — the whole file but the `if (import.meta.main)` block, which
 *     must come last, read as Bun's transpiler emits it (comments gone,
 *     strings intact) — holds none of the listed spellings of an exit, a
 *     process listener, an argv read, the CLI's URL resolver, the door, a
 *     console call or a stream write: run() returns its code and writes
 *     through the Writer it is given. What reads like one fails the census
 *     loudly — a string (`"will exit (code 1)"`), any `.exit(` method
 *     (`child.exit()`), a `worker.process.kill()`; reword it or name it apart.
 *     What it cannot see is an alias — `const p = process; p.on(…)`, a
 *     default import of node:process, `const c = console` — nor a read of
 *     process.env (DATABASE_URL, say) or a write to it: a spelling list over
 *     text is never complete, and those are left to review (review pass 4);
 *   - run() refuses what the CLI refuses, in the CLI's words (the spawned
 *     script's whole stdout and stderr) and with its exit code, before
 *     connecting;
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
const ENGINES = ["migrate.ts", "extract-entities.ts", "consolidate.ts", "reembed.ts"] as const;

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
  // The control: the same import, run, does reach the listener — so the zero
  // above counts. A dry run: extract's egress gate refuses a real one first here.
  const control = await counted(["-e", `const m = await import("./${engine}"); await m.run({ url: ${JSON.stringify(AT)}, dryRun: true });`], {}, true);
  ok(control.seen > 0, `…the control: ${engine}'s run() on that URL does connect (${control.seen} connection(s))`);

  const before = listenerCounts();
  const m = await import(`./${engine}`);
  ok(listenerCounts() === before && typeof m.run === "function", `${engine} installs no process listener when imported in-process (${before} → ${listenerCounts()})`);
}

// ---------------------------------------------------------------------------
// The engine's code: no exit, no process handler, no argv, no console.
// ---------------------------------------------------------------------------
/** process, reached by `.`, `?.`, a bracket or both: `process.x`, `process?.x`, `process["x"]`, `process?.["x"]`. */
const P = String.raw`\bprocess\s*(?:\??\.\s*(?:\[\s*["'\x60])?|\[\s*["'\x60])`;
const FORBIDDEN: [RegExp, string][] = [
  // test-connect's exit shapes (a bare exit( is an alias or a node:process import), plus the other ways to end the process.
  [new RegExp(String.raw`\bexit\s*\(|=\s*process\.exit\b|${P}(exit|exitCode|kill|abort|reallyExit)\b|\bBun\.exit\b`), "an exit"],
  [new RegExp(String.raw`${P}(on|once|addListener|prependListener|prependOnceListener)\b`), "a process listener"],
  [new RegExp(String.raw`\bcommandLine\(|\bscriptArgv\(|${P}argv\b|\bBun\.argv\b`), "an argv read"],
  [/import\s*\{[^}]*\b(argv|exit|exitCode|kill|abort|stdout|stderr|on|once)\b[^}]*\}\s*from\s*["'](node:)?process["']/, "a name imported from node:process"],
  [/\bdatabaseUrl\(/, "databaseUrl (the CLI's resolver, which exits)"],
  [/\bcloseThenExit\(/, "the door (it ends stdout and stderr, then exits)"],
  [/\bconsole\s*(\??\.|\[)|\{[^}]*\}\s*=\s*console\b/, "a console call (the Writer is the engine's output)"],
  [/\bconsoleWriter\s*(\??\.|\[)/, "a line written to the console past the Writer (only `opts.writer ?? consoleWriter` may name it)"],
  [new RegExp(String.raw`${P}(stdout|stderr)\b|\bBun\.(stdout|stderr)\b|\{[^}]*\b(stdout|stderr|exit|exitCode|argv|on|once|kill)\b[^}]*\}\s*=\s*(globalThis\.)?process\b|\b(writeSync|writeFileSync|appendFileSync|Bun\.write)\s*\(\s*[12]\s*,|\bBun\.file\s*\(\s*[12]\s*\)|["'\x60]\/dev\/std(out|err)["'\x60]`), "a direct stream write or a destructured process"],
];

/**
 * The file as Bun's transpiler emits it: comments gone — a doc comment naming
 * console.log( is prose, not a call — and strings intact, so a `/*` or a ` //`
 * inside one cannot hide the code after it (a regex strip could).
 */
const TRANSPILER = new Bun.Transpiler({ loader: "ts" });
function code(text: string): string {
  return TRANSPILER.transformSync(text);
}

/** The `if (import.meta.main) { … }` block and what follows it — the block read to its matching brace, braces inside strings not counted. */
function mainBlock(text: string): { block: string; after: string; before: string } | null {
  const at = text.indexOf("if (import.meta.main) {");
  if (at === -1) return null;
  let depth = 0;
  for (let i = text.indexOf("{", at); i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { before: text.slice(0, at), block: text.slice(at, i + 1), after: text.slice(i + 1) };
  }
  return null;
}

for (const engine of ENGINES) {
  const text = readFileSync(join(HERE, engine), "utf8");
  const mains = text.split("if (import.meta.main)").length - 1;
  ok(mains === 1, `${engine} has one \`if (import.meta.main)\` (${mains})`);
  ok(/export async function run\(/.test(text), `${engine} exports run()`);
  const main = mainBlock(code(text));
  ok(main !== null && main.after.trim() === "", `${engine}'s CLI block is the file's last thing — nothing after it escapes the census (${JSON.stringify(main?.after.trim().slice(0, 40))})`);
  const engineText = main ? main.before + main.after : code(text);
  for (const [re, what] of FORBIDDEN) {
    const hit = engineText.match(re);
    ok(hit === null, `${engine}'s engine code (all but its CLI block) holds no ${what}${hit ? ` — found ${JSON.stringify(hit[0])}` : ""}`);
  }
  const noImports = engineText.replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?$/gm, "");
  const named = (noImports.match(/\bconsoleWriter\b/g) ?? []).length, asDefault = (noImports.match(/\?\?\s*consoleWriter\b/g) ?? []).length;
  ok(named === asDefault && asDefault >= 1, `${engine} names consoleWriter only as the default writer (${named} use(s), ${asDefault} as the default)`);
  ok(main !== null && /closeThenExit\(/.test(main.block) && /\brun\(/.test(main.block), `${engine}'s CLI block exits through the door with run()'s code`);
  // lease.ts's reportLost writes to stderr unless given a writer; an engine
  // gives it the Writer's err (no suite loses a row in-process to see the line).
  const lostCalls = [...engineText.matchAll(/\breportLost\(([^()]*)\)/g)];
  ok(lostCalls.every((c) => /,\s*err\s*$/.test(c[1])), `${engine}'s every reportLost call passes the Writer's err (${lostCalls.length} call(s))`);
}
// The census has teeth: the shapes a regression would write are seen, and the
// shapes PRs 2-4's engines will need are not.
const censusSees = (s: string) => FORBIDDEN.some(([re]) => re.test(s));
for (const s of [
  "process.exit(2)", `process["exit"](2)`, "process?.exit(2)", `process?.["exit"](2)`, "const { exit } = process; exit(2)", "const { exit } = globalThis.process",
  "process.exitCode = 1", "Bun.exit(1)", `process.kill(process.pid, "SIGINT")`, "process.abort()",
  `process.on("SIGINT", stop)`, `process["on"]("SIGINT", stop)`, `process?.once("SIGTERM", stop)`, `process?.["on"]("SIGINT", stop)`, `process.prependListener("SIGINT", stop)`,
  `commandLine("x.ts", {})`, "process.argv.slice(2)", "Bun.argv", `import { argv, on } from "node:process"`,
  "databaseUrl(flag)", "closeThenExit(sql, async () => { return 0; })",
  "console.error(line)", `console["log"](line)`, "console?.log(line)", "const { log } = console", "consoleWriter.err(line)",
  "process.stdout.write(s)", "process?.stdout.write(s)", "await Bun.write(Bun.stdout, s)", `await Bun.write("/dev/stdout", s)`, "await Bun.write(Bun.file(1), s)", "await Bun.write(1, s)", "writeSync(2, s)", "writeFileSync(2, s)", "appendFileSync(1, s)", "const { stdout } = process; stdout.write(s)",
]) ok(censusSees(s), `the engine census sees ${s}`);
for (const s of [`signal.addEventListener("abort", stop)`, `opts.signal?.addEventListener("abort", stop)`, `emitter.on("x", f)`, "const { on } = hooks", "function onExit() {}", "const r = { exitCode: 0 }", "writeSync(fd, s)"])
  ok(!censusSees(s), `…and does not flag ${s}`);
ok(!FORBIDDEN[0][0].test("await closeThenExit(sql, body)"), "…and the door's name is not an exit");
ok(!censusSees(code("/** prints with console.log(line) and exits via process.exit(2) */\nconst u = \"postgres://h/x\"; // closeThenExit(sql)\n")), "…nor a comment naming them, nor a URL's //");
ok(censusSees(code(`const g = "migrations/*.sql";\nprocess.exit(2);\n/** doc */\nconst t = \`--url \${g} // bad\`; process.exit(3);\n`)), "…and a /* or a // inside a string hides no code after it");
ok(mainBlock("x;\nif (import.meta.main) {\n  a({ b: \"}\" });\n}\nfunction late() {}\n")?.after.trim() === "function late() {}", "…and code after the CLI block is found, a brace in a string not counted");

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
    // connect.ts's whole rule, not only the parse (SMD-2317): Bun would send
    // ?database= to the server and connect to another database (review pass 5).
    ["a URL the readers split (?database=)", { url: `${AT}?database=other` }, ["--url", `${AT}?database=other`], {}],
    ["--force alone", { url: AT, force: true }, ["--url", AT, "--force"], {}],
    ["--grant with --baseline", { url: AT, grant: "reader", baseline: true }, ["--url", AT, "--grant", "reader", "--baseline"], {}],
  ];
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess(opts);
    const cli = await counted(["migrate.ts", ...argv], env);
    ok(r.code === 2 && cli.code === 2, `migrate run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    // The whole of each stream, not a first line: the CLI printing more after
    // the refusal, or on stdout, would differ.
    ok(r.w.errs.length === 1 && cli.err === r.w.errs.map((l) => `${l}\n`).join("") && cli.out === "" && r.w.outs.length === 0, `…the refusal in the CLI's words, the whole of both streams (${JSON.stringify(firstErr(cli.err).slice(0, 90))})`);
    ok(r.seen === 0 && cli.seen === 0 && !r.w.errs.join("").includes(MARK) && !cli.err.includes(MARK) && !cli.out.includes(MARK), `…before connecting, and without the password, in-process or spawned (${r.seen}, ${cli.seen})`);
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

  // An option given as null is absent, as `sql: null` is: `url: null` is no
  // URL, and `grant: null` is no --grant — so `--baseline` beside it is a
  // baseline run (which queries the client), not --grant's refusal (review pass 4).
  const nullUrl = await inProcess({ url: null });
  // `sql: null` beside an unparseable URL: the URL's refusal, not a TypeError
  // reading null's options (review pass 5: nothing passed a null client).
  const nullSql = await inProcess({ sql: null, url: "mysql://h/x" });
  ok(nullSql.code === 2 && nullSql.w.errs[0] === UNPARSEABLE_DATABASE_URL, `migrate run() reads a null sql as absent, refusing the URL beside it (exit ${nullSql.code})`);
  const queried = Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 1 }, close: async () => {}, unsafe: () => { throw new Error("stub queried"); } });
  const nw = capture();
  const nullGrant = await run({ sql: queried, grant: null, baseline: true, writer: nw } as never).then((c) => String(c), (e: Error) => e.message);
  ok(nullUrl.code === 2 && nullUrl.w.errs[0] === NO_DATABASE_URL && !nw.errs.some((l) => l.startsWith("--grant")) && nullGrant !== "2", `migrate run() reads a null url or grant as absent (url: exit ${nullUrl.code}; grant: ${nullGrant.slice(0, 40)})`);
}

// ---------------------------------------------------------------------------
// extract-entities.ts: run() refuses in the CLI's words, before connecting.
// ---------------------------------------------------------------------------
{
  const { run } = await import("./extract-entities.ts");
  /** run() in-process under the child's environment, counting the listener's connections; its streams as a child's. */
  const inProcess = async (opts: Record<string, unknown>) => {
    seen = 0;
    const w = capture();
    const code = await run({ env: BASE_ENV, ...opts, writer: w } as never);
    await Bun.sleep(50);
    const lines = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
    return { code, out: lines(w.outs), err: lines(w.errs), seen };
  };

  const cases: [string, Record<string, unknown>, string[], Record<string, string>][] = [
    ["no URL", {}, [], {}],
    ["an unparseable URL", { url: `postgres://u:${MARK}/x@127.0.0.1:1/x` }, ["--url", `postgres://u:${MARK}/x@127.0.0.1:1/x`], {}],
    ["a URL the readers split (?database=)", { url: `${AT}?database=other` }, ["--url", `${AT}?database=other`], {}],
    ["--workers 0", { url: AT, workers: 0 }, ["--url", AT, "--workers", "0"], {}],
    ["--batch 1.5", { url: AT, batch: 1.5 }, ["--url", AT, "--batch", "1.5"], {}],
    ["--heartbeat past 2^53", { url: AT, heartbeat: 2 ** 60 }, ["--url", AT, "--heartbeat", String(2 ** 60)], {}],
    ["a lease under two heartbeats", { url: AT, ttl: 3, heartbeat: 2 }, ["--url", AT, "--ttl", "3", "--heartbeat", "2"], {}],
    ["a one-second lease (its heartbeat derived)", { url: AT, ttl: 1 }, ["--url", AT, "--ttl", "1"], {}],
    // Two rules broken: the lease pair is refused first, before --limit, as the script always did.
    ["a short lease and --limit 0", { url: AT, ttl: 3, heartbeat: 2, limit: 0 }, ["--url", AT, "--ttl", "3", "--heartbeat", "2", "--limit", "0"], {}],
    ["--timeout 0 and a short lease", { url: AT, timeout: 0, ttl: 1 }, ["--url", AT, "--timeout", "0", "--ttl", "1"], {}],
    ["--follow 0", { url: AT, follow: 0 }, ["--url", AT, "--follow", "0"], {}],
    ["--decide without the Jev tier", { url: AT, decide: true }, ["--url", AT, "--decide"], {}],
    // The banner on stdout, then the blanket gate (SMD-1903): the default policy with nothing declared local.
    ["an egress policy that refuses every row", { url: AT }, ["--url", AT], {}],
    // …under a model named in the environment run() is given: its banner names it, as the CLI's does.
    ["the gate's refusal under OB1_METADATA_MODEL from env", { url: AT }, ["--url", AT], { OB1_METADATA_MODEL: "env-model" }],
  ];
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess({ ...opts, env: { ...BASE_ENV, ...env } });
    const cli = await counted(["extract-entities.ts", ...argv], env);
    ok(r.code === 2 && cli.code === 2, `extract run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && r.err !== "", `…in the CLI's words, the whole of both streams (${JSON.stringify(cli.err.trim().split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // A caller's client: one short of a connection per worker and a spare is
  // refused, a worker key without the URL it resolves on is refused, and the
  // client is never closed.
  const narrow = openSql(AT, { max: 2 });
  const n = await inProcess({ sql: narrow });
  ok(n.code === 2 && /needs a client of at least 3 connections for 2 worker\(s\)/.test(n.err) && n.seen === 0, `extract run() refuses a client narrower than its workers and a spare (exit ${n.code}: ${n.err.slice(0, 70)})`);
  await narrow.close();
  let closed = false;
  const stub = Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 3 }, close: async () => { closed = true; }, unsafe: () => { throw new Error("stub queried"); } });
  const keyed = await inProcess({ sql: stub, env: { ...BASE_ENV, OB1_WORKER_KEY: "k" } });
  ok(keyed.code === 2 && /resolves OB1_WORKER_KEY on a connection of its own/.test(keyed.err) && !closed, `extract run() refuses a worker key beside a client without a URL, and leaves the client open (exit ${keyed.code})`);
  // A URL beside the client is the worker key's, held to connect.ts's rule too.
  const beside = await inProcess({ sql: stub, url: "mysql://h/x" });
  ok(beside.code === 2 && beside.err === `${UNPARSEABLE_DATABASE_URL}\n` && !closed, `extract run() refuses a bad URL beside a caller's client (exit ${beside.code})`);
  // A reserved connection (`release`) or a transaction's handle (`savepoint`)
  // reports its pool's max but is one connection: refused, and not closed.
  for (const [what, extra] of [["a reserved connection", { release: () => {} }], ["a transaction's handle", { savepoint: async () => {} }]] as const) {
    const handle = Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 10 }, close: async () => { closed = true; } }, extra);
    const h = await inProcess({ sql: handle, url: AT });
    ok(h.code === 2 && /needs a pool, not a reserved connection or a transaction's handle/.test(h.err) && !closed && h.seen === 0, `extract run() refuses ${what} as its client (exit ${h.code})`);
  }
  // A signal aborted before the call: 130, nothing opened.
  const early = await inProcess({ url: AT, signal: AbortSignal.abort() });
  ok(early.code === 130 && /stopped before the pass began: the caller's signal was aborted; nothing was claimed/.test(early.err) && early.out === "" && early.seen === 0, `extract run() with a signal already aborted returns 130 before connecting (exit ${early.code}, ${early.seen} connection(s))`);
  const late = await inProcess({ sql: stub });
  ok(late.code === 2 && /Nothing would be extracted/.test(late.err) && !closed, `…and the egress gate's refusal, after the client is accepted, does not close it either (exit ${late.code})`);
  // null is absent: no URL, the default workers (so a max-3 client passes the width check and is queried).
  const nullUrl = await inProcess({ url: null });
  const nullWorkers = await run({ sql: stub, workers: null, dryRun: true, env: BASE_ENV, writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  ok(nullUrl.code === 2 && nullUrl.err === `${NO_DATABASE_URL}\n` && nullWorkers === "stub queried", `extract run() reads a null url or workers as absent (url: exit ${nullUrl.code}; workers: ${nullWorkers.slice(0, 40)})`);
  ok(process.listenerCount("SIGINT") === 0 && process.listenerCount("SIGTERM") === 0, "…and leaves no signal listener after its refusals");
}

// ---------------------------------------------------------------------------
// consolidate.ts: run() refuses in the CLI's words, before connecting; its
// review flags' rules are a pure function the CLI and run() share.
// ---------------------------------------------------------------------------
{
  const { run, reviewProblem } = await import("./consolidate.ts");
  const inProcess = async (opts: Record<string, unknown>) => {
    seen = 0;
    const w = capture();
    const code = await run({ env: BASE_ENV, ...opts, writer: w } as never);
    await Bun.sleep(50);
    const lines = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
    return { code, out: lines(w.outs), err: lines(w.errs), seen };
  };
  const ID = "00000000-0000-0000-0000-000000000001";
  const cases: [string, Record<string, unknown>, string[], Record<string, string>][] = [
    ["no URL", {}, [], {}],
    ["an unparseable URL", { url: `postgres://u:${MARK}/x@127.0.0.1:1/x` }, ["--url", `postgres://u:${MARK}/x@127.0.0.1:1/x`], {}],
    ["a URL the readers split (?database=)", { url: `${AT}?database=other` }, ["--url", `${AT}?database=other`], {}],
    ["--workers 0", { url: AT, workers: 0 }, ["--url", AT, "--workers", "0"], {}],
    ["--k 51", { url: AT, k: 51 }, ["--url", AT, "--k", "51"], {}],
    ["--min-sim 1.5", { url: AT, minSim: 1.5 }, ["--url", AT, "--min-sim", "1.5"], {}],
    ["--min-confidence -0.1", { url: AT, minConfidence: -0.1 }, ["--url", AT, "--min-confidence", "-0.1"], {}],
    ["a lease under two heartbeats", { url: AT, ttl: 3, heartbeat: 2 }, ["--url", AT, "--ttl", "3", "--heartbeat", "2"], {}],
    // Two rules broken: the lease pair before --limit, and every number before a review flag, as the script always did.
    ["a short lease and --limit 0", { url: AT, ttl: 3, heartbeat: 2, limit: 0 }, ["--url", AT, "--ttl", "3", "--heartbeat", "2", "--limit", "0"], {}],
    ["--stale 0 and a bad --list word", { url: AT, stale: 0, list: "maybe" }, ["--url", AT, "--stale", "0", "--list", "maybe"], {}],
    ["a bad --list word", { url: AT, list: "maybe" }, ["--url", AT, "--list", "maybe"], {}],
    // Refused before the client opens, as main refused it: a URL Bun's client rejects meets the --list rule first (review pass 3).
    ["a bad --list word beside a URL Bun's client rejects", { url: `${AT}?sslmode=bogus`, list: "maybe" }, ["--url", `${AT}?sslmode=bogus`, "--list", "maybe"], {}],
    ["--accept not a UUID", { url: AT, accept: "12" }, ["--url", AT, "--accept", "12"], {}],
    ["--accept with --reject", { url: AT, accept: ID, reject: ID }, ["--url", AT, "--accept", ID, "--reject", ID], {}],
    ["--direction without --accept", { url: AT, direction: "newer" }, ["--url", AT, "--direction", "newer"], {}],
    ["--force without --accept", { url: AT, force: true }, ["--url", AT, "--force"], {}],
    ["--limit beside --list", { url: AT, limit: 5, list: "pending" }, ["--url", AT, "--limit", "5", "--list"], {}],
    ["--note alone", { url: AT, note: "hm" }, ["--url", AT, "--note", "hm"], {}],
    ["--note with the pass's marker", { url: AT, reject: ID, note: "settled by the pass: mine" }, ["--url", AT, "--reject", ID, "--note", "settled by the pass: mine"], {}],
    // The banner on stdout, then the blanket gate (SMD-1903), under a judge model named in env.
    ["the egress gate's refusal under OB1_JUDGE_MODEL from env", { url: AT }, ["--url", AT], { OB1_JUDGE_MODEL: "env-judge" }],
  ];
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess({ ...opts, env: { ...BASE_ENV, ...env } });
    const cli = await counted(["consolidate.ts", ...argv], env);
    ok(r.code === 2 && cli.code === 2, `consolidate run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && r.err !== "", `…in the CLI's words, the whole of both streams (${JSON.stringify(cli.err.trim().split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // reviewProblem is pure and the rule itself: null for the combinations the CLI admits.
  ok(reviewProblem({}) === null && reviewProblem({ list: "stale" }) === null && reviewProblem({ accept: ID, direction: "older", force: true, note: "read both" }) === null && reviewProblem({ reject: ID, note: "  a note" }) === null && reviewProblem({ list: null, accept: null, note: null } as never) === null,
     "consolidate's reviewProblem admits what the CLI admits, null as absent");
  ok(reviewProblem({ accept: ID, note: "  settled by the pass: x" })?.includes("marker is the pass's own") === true, "…and refuses a note carrying the pass's marker after leading spaces");
  // A caller's client: the narrow one, the handles, a keyed run or decision without a URL; never closed.
  let closed = false;
  const stub = (extra: Record<string, unknown> = {}) => Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 3 }, close: async () => { closed = true; }, unsafe: () => { throw new Error("stub queried"); } }, extra);
  const narrow = await inProcess({ sql: stub({ options: { max: 2 } }) });
  ok(narrow.code === 2 && /needs a client of at least 3 connections for 2 worker\(s\)/.test(narrow.err), `consolidate run() refuses a client narrower than its workers and a spare (exit ${narrow.code})`);
  const reserved = await inProcess({ sql: stub({ release: () => {} }), url: AT });
  const tx = await inProcess({ sql: stub({ savepoint: async () => {} }), url: AT });
  ok([reserved, tx].every((r) => r.code === 2 && /needs a pool, not a reserved connection or a transaction's handle/.test(r.err)), "…refuses a reserved connection and a transaction's handle");
  const keyedRun = await inProcess({ sql: stub(), env: { ...BASE_ENV, OB1_WORKER_KEY: "k" } });
  const keyedDecision = await inProcess({ sql: stub(), accept: ID, env: { ...BASE_ENV, OB1_WORKER_KEY: "k" } });
  const keyedList = await run({ sql: stub(), list: "pending", env: { ...BASE_ENV, OB1_WORKER_KEY: "k" }, writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  ok([keyedRun, keyedDecision].every((r) => r.code === 2 && /resolves OB1_WORKER_KEY on a connection of its own/.test(r.err)) && keyedList === "stub queried",
     `…refuses a worker key beside a client without a URL for a run and a decision, not for a listing, which resolves nothing (list: ${keyedList.slice(0, 30)})`);
  const early = await inProcess({ url: AT, signal: AbortSignal.abort() });
  ok(early.code === 130 && /stopped before the pass began/.test(early.err) && early.seen === 0, `consolidate run() with a signal already aborted returns 130 before connecting (exit ${early.code})`);
  const reviewAborted = await run({ sql: stub(), list: "pending", signal: AbortSignal.abort(), writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  ok(reviewAborted === "stub queried", `…and a listing under an aborted signal reads on — it only reads (${reviewAborted.slice(0, 30)})`);
  // A decision writes: an aborted signal stops it before anything opens, as it stops a run (review pass 1).
  const decisionAborted = await inProcess({ url: AT, accept: ID, signal: AbortSignal.abort() });
  ok(decisionAborted.code === 130 && decisionAborted.err === "\n  stopped before the decision was written: the caller's signal was aborted\n" && decisionAborted.seen === 0, `…while a decision under an aborted signal returns 130 before connecting, in words that name no pass (exit ${decisionAborted.code}, ${decisionAborted.seen} connection(s))`);
  // …beside --dry-run too: the decision writes whatever else is asked (review pass 2: it read the tables first).
  const dryDecision = await inProcess({ url: AT, reject: ID, dryRun: true, signal: AbortSignal.abort() });
  ok(dryDecision.code === 130 && dryDecision.seen === 0, `…and a decision beside --dry-run stops before connecting too (exit ${dryDecision.code}, ${dryDecision.seen} connection(s))`);
  ok(!closed, "…and never closes the caller's client");
}

// ---------------------------------------------------------------------------
// reembed.ts: run() refuses in the CLI's words, before connecting; its modes'
// rule is a pure function the CLI and run() share; its model is the env's.
// ---------------------------------------------------------------------------
{
  const { run, modeProblem } = await import("./reembed.ts");
  const inProcess = async (opts: Record<string, unknown>) => {
    seen = 0;
    const w = capture();
    const code = await run({ env: BASE_ENV, ...opts, writer: w } as never);
    await Bun.sleep(50);
    const lines = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
    return { code, out: lines(w.outs), err: lines(w.errs), seen };
  };
  const ID = "00000000-0000-0000-0000-000000000001";
  const LOCAL = { OB1_LLM_LOCAL: "1" };
  const BADDIM = { OB1_EMBEDDING_DIM: "99999" };
  const cases: [string, Record<string, unknown>, string[], Record<string, string>][] = [
    ["no URL", {}, [], {}],
    ["an unparseable URL", { url: `postgres://u:${MARK}/x@127.0.0.1:1/x` }, ["--url", `postgres://u:${MARK}/x@127.0.0.1:1/x`], {}],
    ["a URL the readers split (?database=)", { url: `${AT}?database=other` }, ["--url", `${AT}?database=other`], {}],
    ["--workers 0", { url: AT, workers: 0 }, ["--url", AT, "--workers", "0"], {}],
    ["--batch 1.5", { url: AT, batch: 1.5 }, ["--url", AT, "--batch", "1.5"], {}],
    // --ttl and --heartbeat are read after the configuration, as the script read them:
    // a bare key's note and the configuration's own refusal come first, the banner after.
    ["--ttl not a number (the CLI hands run() NaN)", { url: AT, ttl: NaN }, ["--url", AT, "--ttl", "abc"], LOCAL],
    ["--heartbeat past 2^53", { url: AT, heartbeat: 2 ** 60 }, ["--url", AT, "--heartbeat", String(2 ** 60)], LOCAL],
    ["a bare --job key's note, then --ttl 0", { url: AT, job: "bare", ttl: 0 }, ["--url", AT, "--job", "bare", "--ttl", "0"], LOCAL],
    ["a configuration refused, before --ttl", { url: AT, ttl: NaN }, ["--url", AT, "--ttl", "abc"], BADDIM],
    ["two modes", { url: AT, status: true, retire: "reembed:x@1024" }, ["--url", AT, "--status", "--retire", "reembed:x@1024"], {}],
    ["--accept-failed with --retry-failed", { url: AT, acceptFailed: [], retryFailed: true }, ["--url", AT, "--accept-failed", "--retry-failed"], {}],
    ["--retire with --switch-model", { url: AT, retire: "reembed:x@1024", switchModel: true }, ["--url", AT, "--retire", "reembed:x@1024", "--switch-model"], {}],
    ["--all alone", { url: AT, all: true }, ["--url", AT, "--all"], {}],
    // Every number before the modes, the modes before the configuration, as the script judged them.
    ["--workers 0 and two modes", { url: AT, workers: 0, status: true, acceptFailed: [ID] }, ["--url", AT, "--workers", "0", "--status", "--accept-failed", ID], {}],
    ["two modes and a configuration refused", { url: AT, status: true, retire: "k" }, ["--url", AT, "--status", "--retire", "k"], BADDIM],
    // Refused before the client opens, as main refused it: a URL Bun's client rejects meets the modes' rule first.
    ["two modes beside a URL Bun's client rejects", { url: `${AT}?sslmode=bogus`, status: true, retire: "k" }, ["--url", `${AT}?sslmode=bogus`, "--status", "--retire", "k"], {}],
    // The banner on stdout, then the blanket gate (SMD-1903): the default policy with nothing declared local.
    ["an egress policy that refuses every row", { url: AT }, ["--url", AT], {}],
    // A blank value the scanner refuses, before the URL, refused by run() in its words (review pass 1: run() pooled under the key '').
    ["--job blank", { job: "" }, ["--job", ""], {}],
    ["--retire blank", { url: AT, retire: "  " }, ["--url", AT, "--retire", "  "], {}],
    ["a blank --accept-failed id", { url: AT, acceptFailed: ["", "00000000-0000-0000-0000-000000000001"] }, ["--url", AT, "--accept-failed", "", "00000000-0000-0000-0000-000000000001"], {}],
    // …under a model named in the environment run() is given: its key and banner name it, as the CLI's do.
    ["the gate's refusal under OB1_EMBEDDING_MODEL from env", { url: AT }, ["--url", AT], { OB1_EMBEDDING_MODEL: "  env-model ", OB1_EMBEDDING_DIM: "768" }],
  ];
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess({ ...opts, env: { ...BASE_ENV, ...env } });
    const cli = await counted(["reembed.ts", ...argv], env);
    ok(r.code === 2 && cli.code === 2, `reembed run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && r.err !== "", `…in the CLI's words, the whole of both streams (${JSON.stringify(cli.err.trim().split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // modeProblem is pure and the rule itself: null for what the CLI admits, null as absent.
  ok(modeProblem({}) === null && modeProblem({ status: true }) === null && modeProblem({ acceptFailed: [], all: true }) === null && modeProblem({ retire: "k" }) === null && modeProblem({ switchModel: true, retryFailed: true, retryFallbacks: true }) === null && modeProblem({ acceptFailed: null, retire: null, all: null } as never) === null,
     "reembed's modeProblem admits what the CLI admits, null as absent");
  ok(modeProblem({ status: true, retryFallbacks: true }) === null && modeProblem({ acceptFailed: [ID], retryFallbacks: true })?.includes("--accept-failed and --retry-fallbacks do not combine") === true,
     "…--status beside a run flag (the script admitted it), not --accept-failed beside one");
  // A caller's client: the narrow one and the handles refused; never closed.
  let closed = false;
  const stub = (extra: Record<string, unknown> = {}) => Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 3 }, close: async () => { closed = true; }, unsafe: () => { throw new Error("stub queried"); } }, extra);
  const narrow = await inProcess({ sql: stub({ options: { max: 2 } }) });
  ok(narrow.code === 2 && /needs a client of at least 3 connections for 2 worker\(s\)/.test(narrow.err), `reembed run() refuses a client narrower than its workers and a spare (exit ${narrow.code})`);
  const reserved = await inProcess({ sql: stub({ release: () => {} }) });
  const tx = await inProcess({ sql: stub({ savepoint: async () => {} }) });
  ok([reserved, tx].every((r) => r.code === 2 && /needs a pool, not a reserved connection or a transaction's handle/.test(r.err)), "…refuses a reserved connection and a transaction's handle");
  const beside = await inProcess({ sql: stub(), url: "mysql://h/x" });
  ok(beside.code === 2 && beside.err === `${UNPARSEABLE_DATABASE_URL}\n`, `…and a bad URL beside a caller's client (exit ${beside.code})`);
  // Nothing needs a URL beside the client: reembed resolves no worker key.
  const noUrlBeside = await run({ sql: stub(), dryRun: true, env: { ...BASE_ENV, OB1_WORKER_KEY: "k" }, writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  ok(noUrlBeside === "stub queried", `…and a client alone is enough, a worker key set or not (${noUrlBeside.slice(0, 30)})`);
  // A signal aborted before the call: a run, --retire and --accept-failed write, and stop before connecting, each in its own words.
  const early = await inProcess({ url: AT, signal: AbortSignal.abort() });
  const earlyRetire = await inProcess({ url: AT, retire: "reembed:x@1024", signal: AbortSignal.abort() });
  const earlyAccept = await inProcess({ url: AT, acceptFailed: [ID], signal: AbortSignal.abort() });
  ok(early.code === 130 && /stopped before the pass began: the caller's signal was aborted; nothing was claimed/.test(early.err) && early.out === "" && early.seen === 0, `reembed run() with a signal already aborted returns 130 before connecting (exit ${early.code})`);
  ok(earlyRetire.code === 130 && earlyRetire.err === "\n  stopped before --retire wrote anything: the caller's signal was aborted\n" && earlyAccept.code === 130 && earlyAccept.err === "\n  stopped before --accept-failed wrote anything: the caller's signal was aborted\n" && earlyRetire.seen + earlyAccept.seen === 0,
     `…as do --retire and --accept-failed, in words that name no pass (exit ${earlyRetire.code}, ${earlyAccept.code})`);
  const statusAborted = await run({ sql: stub(), status: true, signal: AbortSignal.abort(), env: BASE_ENV, writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  const acceptDryAborted = await run({ sql: stub(), dryRun: true, acceptFailed: [ID], signal: AbortSignal.abort(), env: BASE_ENV, writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  ok(statusAborted === "stub queried" && acceptDryAborted === "stub queried", `…while --status and a --dry-run read on under an aborted signal — they only read (${statusAborted.slice(0, 20)}, ${acceptDryAborted.slice(0, 20)})`);
  // null is absent: no URL, the default workers (so a max-3 client passes the width check and is queried).
  const nullUrl = await inProcess({ url: null });
  const nullWorkers = await run({ sql: stub(), workers: null, ttl: null, dryRun: true, env: BASE_ENV, writer: capture() } as never).then((c) => String(c), (e: Error) => e.message);
  ok(nullUrl.code === 2 && nullUrl.err === `${NO_DATABASE_URL}\n` && nullWorkers === "stub queried", `reembed run() reads a null url, workers or ttl as absent (url: exit ${nullUrl.code}; workers: ${nullWorkers.slice(0, 40)})`);
  ok(!closed, "…and never closes the caller's client");
  ok(process.listenerCount("SIGINT") === 0 && process.listenerCount("SIGTERM") === 0, "…and leaves no signal listener after its refusals");
  // Every refusal of the maintenance modes is returned as run()'s code: a
  // `refuse(…)` not returned would let the mode run on past it (the script exited there).
  const text = readFileSync(join(HERE, "reembed.ts"), "utf8");
  const calls = [...text.matchAll(/\brefuse(?:Current)?\(/g)].map((m) => text.slice(0, m.index).trimEnd());
  // Returned, or an arrow's body (refuseCurrent's own call), which is.
  const unreturned = calls.filter((before) => !/\breturn$/.test(before) && !/=>$/.test(before));
  ok(calls.length >= 15 && unreturned.length === 0, `every refuse() call in reembed.ts is returned (${calls.length} calls, ${unreturned.length} not)`);
}

// config.mjs's embeddingContract: the constants' rule over any record — over
// the environment config.mjs is imported under, the constants themselves.
for (const env of [{}, { OB1_EMBEDDING_MODEL: "  m1  ", OB1_EMBEDDING_DIM: " 768 " }, { OB1_EMBEDDING_MODEL: "", OB1_EMBEDDING_DIM: "" }, { OB1_EMBEDDING_DIM: "abc" }, { OB1_EMBEDDING_MODEL: "qwen3-embedding:4b", OB1_EMBEDDING_DIM: "1024", OB1_EMBEDDING_DIMENSIONS: " off " }] as Record<string, string>[]) {
  const r = await counted(["-e", `const c = await import("./config.mjs"); console.log(JSON.stringify([[c.EMBEDDING_MODEL, c.EMBEDDING_DIM, c.EMBEDDING_DIMENSIONS], Object.values(c.embeddingContract(process.env))]));`], env);
  const [constants, contract] = JSON.parse(r.out || "[[],[1]]") as unknown[][];
  ok(r.code === 0 && JSON.stringify(constants) === JSON.stringify(contract), `embeddingContract(process.env) is config.mjs's constants under ${JSON.stringify(env)} (${JSON.stringify(contract)})`);
}

// ---------------------------------------------------------------------------
// server-portable/embed.ts's `log`: the embedder's own lines go where its
// caller says (reembed's run() passes its Writer), and a throw from it
// rejects the call with that error — through the blurbs' and the whole
// content's degrading catches — and stops the call's other lines (SMD-2304
// review passes 1 and 2). A loopback stub answers: every embedding a unit
// vector, every blurb empty, the whole content 413 when asked.
// ---------------------------------------------------------------------------
{
  const { createEmbedder, resolveEmbedConfig } = await import("../server-portable/embed.ts");
  let refuseWhole = false;
  const doc = Array.from({ length: 1500 }, (_, k) => `word${k}`).join(" ");
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input?: string; messages?: unknown };
      if (new URL(req.url).pathname.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "" } }] });
      if (refuseWhole && body.input === doc) return Response.json({ error: { message: "input too long" } }, { status: 413 });
      const v = new Array(8).fill(0);
      v[1] = 1;
      return Response.json({ data: [{ embedding: v }] });
    },
  });
  const cfgFor = (context: boolean) => resolveEmbedConfig({
    OB1_LLM_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OB1_LLM_LOCAL: "1",
    OB1_EMBEDDING_MODEL: "stub-embed", OB1_EMBEDDING_DIM: "8", OB1_CHUNK_CONTEXT: context ? "on" : "off",
  } as never);
  const subject = { kind: "re-embed" as const, content: doc };
  const lines: string[] = [];
  const quiet = createEmbedder(() => cfgFor(true), { rememberRefusal: false, log: (l) => lines.push(l) });
  const embedded = await quiet.embedCapture(doc, subject);
  const blurbLines = lines.filter((l) => l === "contextualiseChunk: the model returned an empty blurb").length;
  ok(embedded.chunks.length > 1 && blurbLines === embedded.chunks.length && embedded.contextFailures === embedded.chunks.length,
     `embed.ts's log receives the embedder's own lines — one empty blurb a window (${blurbLines} lines, ${embedded.chunks.length} windows)`);
  // A log that throws on the first blurb line: the call rejects with that very
  // error, not resolved with it as the blurb's reason, and no other line is written.
  const boom = new Error("log boom");
  let calls = 0;
  const throwing = createEmbedder(() => cfgFor(true), { rememberRefusal: false, log: () => { calls++; throw boom; } });
  const blurbOutcome = await throwing.embedCapture(doc, subject).then(() => "resolved", (e: unknown) => e);
  ok(blurbOutcome === boom && calls === 1, `…a throw from it on a blurb line rejects embedCapture with that error, and the call's other lines are not written (${blurbOutcome === boom ? "the error" : String(blurbOutcome)}, ${calls} call(s))`);
  // …and on the whole content's fallback line (a 413), through its degrading catch.
  refuseWhole = true;
  calls = 0;
  const wholeOutcome = await createEmbedder(() => cfgFor(false), { rememberRefusal: false, log: () => { calls++; throw boom; } }).embedCapture(doc, subject).then(() => "resolved", (e: unknown) => e);
  const fellBack: string[] = [];
  const fell = await createEmbedder(() => cfgFor(false), { rememberRefusal: false, log: (l) => fellBack.push(l) }).embedCapture(doc, subject);
  refuseWhole = false;
  ok(wholeOutcome === boom && calls === 1 && fell.wholeContentRefused && fellBack.some((l) => l.startsWith("embedCapture: stub-embed refused the whole content (413)")),
     `…and on the whole content's fallback line, where the same call with a quiet log falls back and says so (${wholeOutcome === boom ? "the error" : String(wholeOutcome)})`);
  stub.stop(true);
}

// cli.ts's numberProblem: the scanner's words, judged by value — the engines'
// in-process numbers — and readNumber's own rule for a digit string.
{
  const { numberIn, numberProblem, readNumber } = await import("./cli.ts");
  ok(Number.isNaN(numberIn("abc")) && Number.isNaN(numberIn("1.5")) && numberIn("1.5", true) === 1.5 && numberIn("007") === 7 && Number.isNaN(numberIn("0x10")) && Number.isNaN(numberIn(" 7")),
     "numberIn reads readNumber's shapes and nothing else — what reembed's CLI hands run() for --ttl and --heartbeat");
  ok(numberProblem("--min-sim", 1e-7, { min: -1, max: 1, fraction: true }) === null, "numberProblem reads 1e-7 as the decimal number it is (a digit string of it, 0.0000001, passes the scanner too)");
  ok(numberProblem("--workers", 1.5, { min: 1 }) === "--workers must be a decimal integer >= 1" && numberProblem("--k", 51, { min: 1, max: 50 }) === "--k must be a decimal integer >= 1 and <= 50" && numberProblem("--x", 2 ** 60, { min: 1 }) === "--x is too large to read exactly" && numberProblem("--x", NaN, { min: 1 }) !== null,
     "…and refuses a fraction for an integer, out of range, past 2^53 and NaN in the scanner's words");
  for (const [raw, rule] of [["0", { min: 1 }], ["51", { min: 1, max: 50 }], ["1.5", { min: 1 }], ["0.5", { min: 0, max: 1, fraction: true }], ["9007199254740993", { min: 1 }], ["-1", { min: -1, max: 1, fraction: true }]] as const) {
    const scanned = readNumber("--f", raw, rule);
    const direct = numberProblem("--f", Number(raw), rule);
    ok((typeof scanned === "number" ? null : scanned.error) === direct, `readNumber("${raw}") and numberProblem(${raw}) agree (${JSON.stringify(scanned)})`);
  }
}

// ---------------------------------------------------------------------------
// db/lease.ts's stopOnSignals: a first stop is the engine's, a hard one exits 130.
// ---------------------------------------------------------------------------
{
  const { stopOnSignals } = await import("./lease.ts");
  const exits: number[] = [];
  let calls = 0;
  let release: Promise<unknown> | null = null;
  const before = listenerCounts();
  const uninstall = stopOnSignals(() => { calls++; return release; }, (c) => exits.push(c), 60);
  process.emit("SIGINT");
  await Bun.sleep(80);
  ok(calls === 1 && exits.length === 0, `a stop that returns null is the engine's: SIGINT calls it, nothing exits (${calls} call(s), exits ${JSON.stringify(exits)})`);
  let settle = () => {};
  release = new Promise<void>((r) => { settle = r; });
  process.emit("SIGTERM");
  await Bun.sleep(10);
  ok(calls === 2 && exits.length === 0, "a hard stop waits for its release…");
  settle();
  await Bun.sleep(10);
  ok(exits.length === 1 && exits[0] === 130, `…and exits 130 once it settles (${JSON.stringify(exits)})`);
  release = Promise.reject(new Error("release failed"));
  process.emit("SIGINT");
  await Bun.sleep(10);
  ok(exits.length === 2 && exits[1] === 130, "a release that fails still exits 130");
  release = new Promise(() => {});
  process.emit("SIGINT");
  await Bun.sleep(30);
  const early = exits.length;
  await Bun.sleep(80);
  ok(early === 2 && exits.length === 3 && exits[2] === 130, `a release that never settles exits 130 after the grace (${early} → ${exits.length})`);
  uninstall();
  ok(listenerCounts() === before, `the uninstall takes both handlers off (${before} → ${listenerCounts()})`);
}

// ---------------------------------------------------------------------------
// db/lease.ts's sleepUnless: a stop wakes it, and a follower's thousands of
// polls keep nothing (review pass 3: a `.then` per sleep kept ~430 bytes each).
// ---------------------------------------------------------------------------
{
  const { sleepUnless } = await import("./lease.ts");
  const wake = new AbortController();
  const t0 = Date.now();
  const long = sleepUnless(10_000, wake.signal);
  setTimeout(() => wake.abort(), 30);
  await long;
  const woke = Date.now() - t0;
  ok(woke < 500, `sleepUnless wakes when its signal aborts, not at its end (${woke} ms of 10000)`);
  const t1 = Date.now();
  await sleepUnless(10_000, wake.signal);
  ok(Date.now() - t1 < 50, "…and returns at once on a signal already aborted");
  const never = new AbortController();
  const t2 = Date.now();
  await sleepUnless(40, never.signal);
  ok(Date.now() - t2 >= 35, "…and waits its time out when nothing aborts");
  // Past a timer's 32-bit ceiling it sleeps on, where one timer fires after 1 ms (review pass 4).
  const far = new AbortController();
  let farDone = false;
  const farSleep = sleepUnless(3e9, far.signal).then(() => { farDone = true; });
  await Bun.sleep(100);
  const stillAsleep = !farDone;
  far.abort();
  await farSleep;
  ok(stillAsleep && farDone, "…and a sleep past a timer's ceiling (3e9 ms) sleeps on until its signal aborts, not 1 ms");
  // The baseline settled first — garbage from the cases above would read as
  // negative growth — and the sleeps run at once, as many pauses can.
  await Bun.sleep(50);
  Bun.gc(true);
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  await Promise.all(Array.from({ length: 20_000 }, () => sleepUnless(0, never.signal)));
  Bun.gc(true);
  const grew = process.memoryUsage().heapUsed - before;
  ok(grew < 2_000_000, `20,000 sleeps on a signal that never aborts keep nothing (${(grew / 1e6).toFixed(2)} MB of heap after, under 2)`);
}

listener.stop(true);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
