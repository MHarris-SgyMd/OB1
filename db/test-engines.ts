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

listener.stop(true);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
