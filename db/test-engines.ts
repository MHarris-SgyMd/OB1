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
/** The engines, one more per SMD-2304 PR, the sleep scheduler that drives two of them (SMD-1794), and rebuild_derived's door (SMD-2679). */
const ENGINES = ["migrate.ts", "extract-entities.ts", "consolidate.ts", "reembed.ts", "sleep.ts", "rebuild.ts"] as const;
/** The control's run, by engine: a dry run, but for rebuild.ts, whose dry run needs a mode — its --status only reads. */
const CONTROL: Partial<Record<(typeof ENGINES)[number], string>> = { "rebuild.ts": "status: true" };

/** A child's environment: this one without a database URL, any OB1_* knob or PG* variable; no .env file read. */
const BASE_ENV: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "DATABASE_URL" && !k.startsWith("OB1_") && !k.startsWith("PG")) BASE_ENV[k] = v;
BASE_ENV.OB1_ENV_FILES = "off";
// But the suite's background slots, off in CI and ci-parity.sh, as its PATH (SMD-3379 PR 2b-2b).
if (process.env.OB1_BACKGROUND_SLOTS !== undefined) BASE_ENV.OB1_BACKGROUND_SLOTS = process.env.OB1_BACKGROUND_SLOTS;

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
  const control = await counted(["-e", `const m = await import("./${engine}"); await m.run({ url: ${JSON.stringify(AT)}, ${CONTROL[engine] ?? "dryRun: true"} });`], {}, true);
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
// An engine's own library, which its CLI and an in-process caller both call
// (subject-sweep.ts: extract-entities.ts --subjects, SMD-3306): no CLI block,
// and held to the census over the whole file; its import does nothing, and
// its entry refuses a missing URL in the CLI's words before connecting.
for (const [lib, entry] of [["subject-sweep.ts", "sweepSubjects"]] as const) {
  const text = code(readFileSync(join(HERE, lib), "utf8"));
  ok(!text.includes("import.meta.main"), `${lib} is a library: no CLI block of its own`);
  for (const [re, what] of FORBIDDEN) {
    const hit = text.match(re);
    ok(hit === null, `${lib}'s code holds no ${what}${hit ? ` — found ${JSON.stringify(hit[0])}` : ""}`);
  }
  const noImports = text.replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?$/gm, "");
  const named = (noImports.match(/\bconsoleWriter\b/g) ?? []).length, asDefault = (noImports.match(/\?\?\s*consoleWriter\b/g) ?? []).length;
  ok(named === asDefault && asDefault >= 1, `${lib} names consoleWriter only as the default writer (${named} use(s), ${asDefault} as the default)`);
  const quiet = await counted(["-e", `const m = await import("./${lib}"); console.log(typeof m.${entry});`], { DATABASE_URL: AT });
  ok(quiet.code === 0 && quiet.out === "function\n" && quiet.err === "" && quiet.seen === 0, `${lib} imports with no side effect, nothing printed and no connection opened with DATABASE_URL set (exit ${quiet.code}, ${quiet.seen} connection(s))`);
  const control = await counted(["-e", `const m = await import("./${lib}"); await m.${entry}({ url: ${JSON.stringify(AT)}, dryRun: true });`], {}, true);
  ok(control.seen > 0, `…the control: ${entry}() on that URL does connect (${control.seen} connection(s))`);
  const before = listenerCounts();
  const m = (await import(`./${lib}`)) as Record<string, (o: object) => Promise<number>>;
  ok(listenerCounts() === before, `${lib} installs no process listener when imported in-process (${before} → ${listenerCounts()})`);
  const w = capture();
  const code2 = await m[entry]({ writer: w });
  ok(code2 === 2 && w.errs.join("\n") === NO_DATABASE_URL && w.outs.length === 0, `${entry}() with no URL refuses in the CLI's words, exit 2, before connecting (${code2}: ${JSON.stringify(w.errs.join(" | ").slice(0, 80))})`);
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

/**
 * The scanner's words for a number past its flag's bound (SMD-2304 PR 5): a
 * bound case must open with them, not with a later rule both paths fall
 * through to when a bound is dropped from the CLI and run() at once — the
 * egress gate, the lease pair (review pass 1: five of six such doubles passed).
 */
const BOUND_WORDS: [RegExp, string][] = [
  [/^--batch past/, "--batch must be a decimal integer >= 1 and <= 2147483647"],
  [/^--timeout past/, "--timeout must be a decimal integer >= 1 and <= 9007199254740"],
  [/^--stale past/, "--stale must be a decimal integer >= 1 and <= 2000000"],
  [/^--workers past/, "--workers must be a decimal integer >= 1 and <= 2147483647"],
];
const boundWords = (what: string): string | undefined => BOUND_WORDS.find(([re]) => re.test(what))?.[1];

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
    // Retired, refused first: before the URL, and before --groups' own refusal (review pass 1).
    ["the retired --baseline with no URL", { baseline: true }, ["--baseline"], {}],
    ["the retired --force beside --groups", { url: AT, force: true, groups: "capture" }, ["--url", AT, "--force", "--groups", "capture"], {}],
    ["the retired --baseline beside --reapply",{ url: AT, reapply: true, baseline: true }, ["--url", AT, "--reapply", "--baseline"], {}],
    // connect.ts's whole rule, not only the parse (SMD-2317): Bun would send
    // ?database= to the server and connect to another database (review pass 5).
    ["a URL the readers split (?database=)", { url: `${AT}?database=other` }, ["--url", `${AT}?database=other`], {}],
    ["the retired --force", { url: AT, force: true }, ["--url", AT, "--force"], {}],
    ["the retired --baseline beside --grant", { url: AT, grant: "reader", baseline: true }, ["--url", AT, "--grant", "reader", "--baseline"], {}],
    ["--grant with --reapply", { url: AT, grant: "reader", reapply: true }, ["--url", AT, "--grant", "reader", "--reapply"], {}],
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
  // URL, and `grant: null` is no --grant — so `--reapply` beside it is a
  // re-run (which queries the client), not --grant's refusal (review pass 4).
  const nullUrl = await inProcess({ url: null });
  // `sql: null` beside an unparseable URL: the URL's refusal, not a TypeError
  // reading null's options (review pass 5: nothing passed a null client).
  const nullSql = await inProcess({ sql: null, url: "mysql://h/x" });
  ok(nullSql.code === 2 && nullSql.w.errs[0] === UNPARSEABLE_DATABASE_URL, `migrate run() reads a null sql as absent, refusing the URL beside it (exit ${nullSql.code})`);
  const queried = Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 1 }, close: async () => {}, unsafe: () => { throw new Error("stub queried"); } });
  const nw = capture();
  const nullGrant = await run({ sql: queried, grant: null, reapply: true, writer: nw } as never).then((c) => String(c), (e: Error) => e.message);
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
    // The bounds the CLI never had (SMD-2304 PR 5): claim_thoughts' int, Bun's pool max, and AbortSignal.timeout's range.
    ["--batch past claim_thoughts' int", { url: AT, batch: 2147483648 }, ["--url", AT, "--batch", "2147483648"], {}],
    ["--workers past the pool's max", { url: AT, workers: 2147483648 }, ["--url", AT, "--workers", "2147483648"], {}],
    ["--timeout past a call signal's range", { url: AT, timeout: 9007199254741 }, ["--url", AT, "--timeout", "9007199254741"], {}],
    // …each where the script read its number, before the lease pair the CLI checks after them.
    ["--batch past its bound and a short lease", { url: AT, batch: 2147483648, ttl: 3, heartbeat: 2 }, ["--url", AT, "--batch", "2147483648", "--ttl", "3", "--heartbeat", "2"], {}],
    ["--timeout past its bound and a short lease", { url: AT, timeout: 9007199254741, ttl: 3, heartbeat: 2 }, ["--url", AT, "--timeout", "9007199254741", "--ttl", "3", "--heartbeat", "2"], {}],
    ["--decide without the Jev tier", { url: AT, decide: true }, ["--url", AT, "--decide"], {}],
    // A blank value the scanner refuses, first — before the URL and the numbers — refused by run() in its words (SMD-2425: run() pooled and recorded under the key '').
    ["--job blank, before the URL", { job: "" }, ["--job", ""], {}],
    ["--dump blank", { url: AT, dump: "  " }, ["--url", AT, "--dump", "  "], {}],
    ["a blank --job before --workers 0", { url: AT, workers: 0, job: " " }, ["--url", AT, "--workers", "0", "--job", " "], {}],
    // The banner on stdout, then the blanket gate (SMD-1903): the default policy with nothing declared local.
    ["an egress policy that refuses every row", { url: AT }, ["--url", AT], {}],
    // …under a model named in the environment run() is given: its banner names it, as the CLI's does.
    ["the gate's refusal under OB1_METADATA_MODEL from env", { url: AT }, ["--url", AT], { OB1_METADATA_MODEL: "env-model" }],
  ];
  // Every bound case is checked for its refusal words: counted, so one renamed past BOUND_WORDS' patterns is seen (review pass 2).
  const boundCases = cases.filter(([w]) => boundWords(w) !== undefined).length;
  ok(boundCases === 5, `extract's bound cases all meet BOUND_WORDS (${boundCases} of 5)`);
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess({ ...opts, env: { ...BASE_ENV, ...env } });
    const cli = await counted(["extract-entities.ts", ...argv], env);
    const words = boundWords(what);
    if (words) ok(cli.err.startsWith(words) && r.err.startsWith(words), `…refused for its bound, in the scanner's words (${JSON.stringify(cli.err.split("\n")[0].slice(0, 80))})`);
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
    // The bounds the CLI never had (SMD-2304 PR 5): claim_thoughts' int, Bun's pool max, a call signal's range, and --stale's reach back.
    ["--batch past claim_thoughts' int", { url: AT, batch: 2147483648 }, ["--url", AT, "--batch", "2147483648"], {}],
    ["--workers past the pool's max", { url: AT, workers: 2147483648 }, ["--url", AT, "--workers", "2147483648"], {}],
    ["--timeout past a call signal's range", { url: AT, timeout: 9007199254741 }, ["--url", AT, "--timeout", "9007199254741"], {}],
    // …each where the script read its number, before the lease pair the CLI checks after them.
    ["--batch past its bound and a short lease", { url: AT, batch: 2147483648, ttl: 3, heartbeat: 2 }, ["--url", AT, "--batch", "2147483648", "--ttl", "3", "--heartbeat", "2"], {}],
    ["--timeout past its bound and a short lease", { url: AT, timeout: 9007199254741, ttl: 3, heartbeat: 2 }, ["--url", AT, "--timeout", "9007199254741", "--ttl", "3", "--heartbeat", "2"], {}],
    ["--stale past the timestamp floor", { url: AT, stale: 2000001 }, ["--url", AT, "--stale", "2000001"], {}],
    ["--note with the pass's marker", { url: AT, reject: ID, note: "settled by the pass: mine" }, ["--url", AT, "--reject", ID, "--note", "settled by the pass: mine"], {}],
    // A blank value the scanner refuses, first — before the URL, the numbers and the review rules — refused by run() in its words (SMD-2425: a blank note reached the decision).
    ["--dump blank, before the URL", { dump: "" }, ["--dump", ""], {}],
    ["--list blank", { url: AT, list: " " }, ["--url", AT, "--list", " "], {}],
    ["--accept blank", { url: AT, accept: "" }, ["--url", AT, "--accept", ""], {}],
    ["--reject blank", { url: AT, reject: "  " }, ["--url", AT, "--reject", "  "], {}],
    ["--direction blank", { url: AT, accept: ID, direction: " " }, ["--url", AT, "--accept", ID, "--direction", " "], {}],
    ["--note blank", { url: AT, reject: ID, note: "  " }, ["--url", AT, "--reject", ID, "--note", "  "], {}],
    // The pass's report beside a review (SMD-2405): beside a decision it never stopped the write (`--accept <id> --dry-run` accepted the proposal), beside a listing it was dropped without a word.
    ["--accept with --dry-run", { url: AT, accept: ID, dryRun: true }, ["--url", AT, "--accept", ID, "--dry-run"], {}],
    ["--reject with --status", { url: AT, reject: ID, status: true }, ["--url", AT, "--reject", ID, "--status"], {}],
    ["--status beside --list", { url: AT, status: true, list: "pending" }, ["--url", AT, "--status", "--list"], {}],
    ["--dry-run beside --stale", { url: AT, dryRun: true, stale: 90 }, ["--url", AT, "--dry-run", "--stale"], {}],
    ["a blank --note before --workers 0", { url: AT, workers: 0, reject: ID, note: " " }, ["--url", AT, "--workers", "0", "--reject", ID, "--note", " "], {}],
    // The banner on stdout, then the blanket gate (SMD-1903), under a judge model named in env.
    ["the egress gate's refusal under OB1_JUDGE_MODEL from env", { url: AT }, ["--url", AT], { OB1_JUDGE_MODEL: "env-judge" }],
  ];
  // Every bound case is checked for its refusal words: counted, so one renamed past BOUND_WORDS' patterns is seen (review pass 2).
  const boundCases = cases.filter(([w]) => boundWords(w) !== undefined).length;
  ok(boundCases === 6, `consolidate's bound cases all meet BOUND_WORDS (${boundCases} of 6)`);
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess({ ...opts, env: { ...BASE_ENV, ...env } });
    const cli = await counted(["consolidate.ts", ...argv], env);
    const words = boundWords(what);
    if (words) ok(cli.err.startsWith(words) && r.err.startsWith(words), `…refused for its bound, in the scanner's words (${JSON.stringify(cli.err.split("\n")[0].slice(0, 80))})`);
    ok(r.code === 2 && cli.code === 2, `consolidate run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && r.err !== "", `…in the CLI's words, the whole of both streams (${JSON.stringify(cli.err.trim().split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // reviewProblem is pure and the rule itself: null for the combinations the CLI admits.
  ok(reviewProblem({}) === null && reviewProblem({ list: "stale" }) === null && reviewProblem({ accept: ID, direction: "older", force: true, note: "read both" }) === null && reviewProblem({ reject: ID, note: "  a note" }) === null && reviewProblem({ list: null, accept: null, note: null } as never) === null,
     "consolidate's reviewProblem admits what the CLI admits, null as absent");
  ok(reviewProblem({ accept: ID, note: "  settled by the pass: x" })?.includes("marker is the pass's own") === true, "…and refuses a note carrying the pass's marker after leading spaces");
  // SMD-2405: a decision combines with the reads (--list, --stale), which run after it; not with the pass's report.
  ok(reviewProblem({ accept: ID, list: "pending" }) === null && reviewProblem({ reject: ID, stale: 30 }) === null && reviewProblem({ status: true }) === null && reviewProblem({ dryRun: true, stale: 0 }) === null,
     "consolidate's reviewProblem admits a decision beside --list or --stale, and --status or --dry-run alone");
  ok(reviewProblem({ accept: ID, status: true, dryRun: true })?.startsWith("--dry-run writes nothing, and --accept writes a decision") === true && reviewProblem({ reject: ID, list: "all", status: true })?.startsWith("--status writes nothing, and --reject") === true,
     "…refuses the pass's report beside a decision first — before a listing beside it");
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
  // …beside --dry-run, refused before the signal is read: a decision beside the pass's report is a usage error (SMD-2405; before it, the decision wrote whatever else was asked).
  const dryDecision = await inProcess({ url: AT, reject: ID, dryRun: true, signal: AbortSignal.abort() });
  ok(dryDecision.code === 2 && /^--dry-run writes nothing, and --reject writes a decision/.test(dryDecision.err) && dryDecision.seen === 0, `…and a decision beside --dry-run is refused before connecting, whatever the signal (exit ${dryDecision.code}, ${dryDecision.seen} connection(s))`);
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
    // The bounds the CLI never had (SMD-2304 PR 5): claim_thoughts' int and Bun's pool max — read before the modes' rule.
    ["--batch past claim_thoughts' int", { url: AT, batch: 2147483648 }, ["--url", AT, "--batch", "2147483648"], {}],
    ["--workers past the pool's max", { url: AT, workers: 2147483648 }, ["--url", AT, "--workers", "2147483648"], {}],
    ["--batch past its bound and two modes", { url: AT, batch: 2147483648, status: true, retire: "k" }, ["--url", AT, "--batch", "2147483648", "--status", "--retire", "k"], {}],
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
    ["a blank --accept-failed id", { url: AT, acceptFailed: ["", ID] }, ["--url", AT, "--accept-failed", "", ID], {}],
    // …under a model named in the environment run() is given: its key and banner name it, as the CLI's do.
    ["the gate's refusal under OB1_EMBEDDING_MODEL from env", { url: AT }, ["--url", AT], { OB1_EMBEDDING_MODEL: "  env-model ", OB1_EMBEDDING_DIM: "768" }],
    // --follow (SMD-2679): its number, and the modes a follower does not combine with.
    ["--follow 0", { url: AT, follow: 0 }, ["--url", AT, "--follow", "0"], {}],
    ["--follow with --switch-model", { url: AT, follow: 5, switchModel: true }, ["--url", AT, "--follow", "5", "--switch-model"], {}],
    ["a bare --follow with --retire", { url: AT, follow: 15, retire: "reembed:x@1024" }, ["--url", AT, "--follow", "--retire", "reembed:x@1024"], {}],
    ["--follow with --accept-failed", { url: AT, follow: 5, acceptFailed: [ID] }, ["--url", AT, "--follow", "5", "--accept-failed", ID], {}],
  ];
  // Every bound case is checked for its refusal words: counted, so one renamed past BOUND_WORDS' patterns is seen (review pass 2).
  const boundCases = cases.filter(([w]) => boundWords(w) !== undefined).length;
  ok(boundCases === 3, `reembed's bound cases all meet BOUND_WORDS (${boundCases} of 3)`);
  for (const [what, opts, argv, env] of cases) {
    const r = await inProcess({ ...opts, env: { ...BASE_ENV, ...env } });
    const cli = await counted(["reembed.ts", ...argv], env);
    const words = boundWords(what);
    if (words) ok(cli.err.startsWith(words) && r.err.startsWith(words), `…refused for its bound, in the scanner's words (${JSON.stringify(cli.err.split("\n")[0].slice(0, 80))})`);
    ok(r.code === 2 && cli.code === 2, `reembed run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && r.err !== "", `…in the CLI's words, the whole of both streams (${JSON.stringify(cli.err.trim().split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // modeProblem is pure and the rule itself: null for what the CLI admits, null as absent.
  ok(modeProblem({}) === null && modeProblem({ status: true }) === null && modeProblem({ acceptFailed: [], all: true }) === null && modeProblem({ retire: "k" }) === null && modeProblem({ switchModel: true, retryFailed: true, retryFallbacks: true }) === null && modeProblem({ acceptFailed: null, retire: null, all: null } as never) === null,
     "reembed's modeProblem admits what the CLI admits, null as absent");
  ok(modeProblem({ status: true, retryFallbacks: true }) === null && modeProblem({ acceptFailed: [ID], retryFallbacks: true })?.includes("--accept-failed and --retry-fallbacks do not combine") === true,
     "…--status beside a run flag (the script admitted it), not --accept-failed beside one");
  ok(modeProblem({ follow: 5 }) === null && modeProblem({ follow: 5, retryFailed: true, status: true }) === null && modeProblem({ follow: 0, switchModel: true }) === null
      && modeProblem({ follow: 5, switchModel: true })?.includes("--follow and --switch-model do not combine — a follower never switches the model") === true,
     "…--follow beside a run's own flags and --status, never beside --switch-model (SMD-2679); a --follow of 0 is no follower");
  // The follower's own options, which the CLI does not take (SMD-2679): the
  // check needs follow and no read-only mode; session needs a client of its own.
  const heardStart: unknown[] = [];
  const checkAlone = await inProcess({ url: AT, check: true, onStart: (r: unknown) => heardStart.push(r) });
  const checkStatus = await inProcess({ url: AT, check: true, follow: 5, status: true });
  ok(checkAlone.code === 2 && checkStatus.code === 2 && /check is a follower's start — pass follow beside it, and no --status or --dry-run/.test(checkAlone.err + checkStatus.err) && JSON.stringify(heardStart) === JSON.stringify([{ ok: false, refused: "usage" }]) && checkAlone.seen + checkStatus.seen === 0,
     `reembed run() refuses check without follow, or beside --status, as the start's usage, before connecting (exit ${checkAlone.code}, ${checkStatus.code}; heard ${JSON.stringify(heardStart)})`);
  // A caller's client: the narrow one and the handles refused; never closed.
  let closed = false;
  const stub = (extra: Record<string, unknown> = {}) => Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 3 }, close: async () => { closed = true; }, unsafe: () => { throw new Error("stub queried"); } }, extra);
  const narrow = await inProcess({ sql: stub({ options: { max: 2 } }) });
  ok(narrow.code === 2 && /needs a client of at least 3 connections for 2 worker\(s\)/.test(narrow.err), `reembed run() refuses a client narrower than its workers and a spare (exit ${narrow.code})`);
  const reserved = await inProcess({ sql: stub({ release: () => {} }) });
  const tx = await inProcess({ sql: stub({ savepoint: async () => {} }) });
  ok([reserved, tx].every((r) => r.code === 2 && /needs a pool, not a reserved connection or a transaction's handle/.test(r.err)), "…refuses a reserved connection and a transaction's handle");
  const sessionBeside = await inProcess({ sql: stub(), session: { statement_timeout: "7s" } });
  ok(sessionBeside.code === 2 && /applies session settings to a client of its own: pass url without sql, or no session/.test(sessionBeside.err), `…refuses session beside a caller's client, which it would not reach (exit ${sessionBeside.code})`);
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

// ---------------------------------------------------------------------------
// rebuild.ts: run() refuses in the CLI's words, before connecting (SMD-2679).
// ---------------------------------------------------------------------------
{
  const { run } = await import("./rebuild.ts");
  const inProcess = async (opts: Record<string, unknown>) => {
    seen = 0;
    const w = capture();
    const code = await run({ ...opts, writer: w } as never);
    await Bun.sleep(50);
    const lines = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
    return { code, out: lines(w.outs), err: lines(w.errs), seen };
  };
  const ID = "00000000-0000-0000-0000-000000000001";
  // The CLI hands run() --fingerprints split on its commas, and --limit as its number. Each case is held to
  // main's own first line of stderr: the CLI goes through run() now, so the two agreeing pins nothing alone —
  // a refusal reworded, or two swapped where a command breaks both, changed both sides (review pass 1, mutants).
  const MODES = "Say one thing: --input <id> [--reason …] [--gone [--fingerprints …]] [--force] [--dry-run] | --orphans [--limit N] [--dry-run] | --status";
  const WITH_INPUT = "--gone, --force and --fingerprints go with --input";
  const WITH_GONE = "--fingerprints goes with --gone: the earlier texts' fingerprints are what a leaving thought's snapshot rows are found by";
  const REASON_OUT = "--reason goes with --input: the sweep marks no row and --status writes nothing, so there is nothing to record it on";
  const LIMIT_OUT = "--limit goes with --orphans";
  const DRY_STATUS = "--dry-run goes with --input or --orphans: --status writes nothing";
  const DIGITS = "--limit must be a decimal integer >= 0";
  const cases: [string, Record<string, unknown>, string[], string][] = [
    ["no URL", { status: true }, ["--status"], NO_DATABASE_URL.split("\n")[0]],
    ["an unparseable URL", { url: `postgres://u:${MARK}/x@127.0.0.1:1/x`, status: true }, ["--url", `postgres://u:${MARK}/x@127.0.0.1:1/x`, "--status"], UNPARSEABLE_DATABASE_URL.split("\n")[0]],
    ["no mode", { url: AT }, ["--url", AT], MODES],
    ["two modes", { url: AT, status: true, orphans: true }, ["--url", AT, "--status", "--orphans"], MODES],
    ["--input and --orphans", { url: AT, input: ID, orphans: true }, ["--url", AT, "--input", ID, "--orphans"], MODES],
    ["--input not a UUID", { url: AT, input: `postgres://u:${MARK}@h/db` }, ["--url", AT, "--input", `postgres://u:${MARK}@h/db`], "--input takes a thought id (a UUID)"],
    ["--gone without --input", { url: AT, orphans: true, gone: true }, ["--url", AT, "--orphans", "--gone"], WITH_INPUT],
    ["--force without --input", { url: AT, status: true, force: true }, ["--url", AT, "--status", "--force"], WITH_INPUT],
    ["--fingerprints without --input (nor --gone)", { url: AT, orphans: true, fingerprints: ["a"] }, ["--url", AT, "--orphans", "--fingerprints", "a"], WITH_INPUT],
    ["--fingerprints without --gone", { url: AT, input: ID, fingerprints: ["a", "b"] }, ["--url", AT, "--input", ID, "--fingerprints", "a,b"], WITH_GONE],
    // `--fingerprints ","` splits to no fingerprint, which is still the flag given: refused, as main refused it.
    ["--fingerprints \",\" without --gone", { url: AT, input: ID, fingerprints: [] }, ["--url", AT, "--input", ID, "--fingerprints", ","], WITH_GONE],
    ["--reason on the sweep", { url: AT, orphans: true, reason: "why" }, ["--url", AT, "--orphans", "--reason", "why"], REASON_OUT],
    ["--limit outside --orphans", { url: AT, status: true, limit: 5 }, ["--url", AT, "--status", "--limit", "5"], LIMIT_OUT],
    ["--dry-run with --status", { url: AT, status: true, dryRun: true }, ["--url", AT, "--status", "--dry-run"], DRY_STATUS],
    ["--reason blank", { url: AT, input: ID, reason: "  " }, ["--url", AT, "--input", ID, "--reason", "  "], "--reason is empty; give it a value"],
    // Two rules broken at once: the first in main's order wins.
    ["no URL and --reason blank", { status: true, reason: "  " }, ["--status", "--reason", "  "], "--reason is empty; give it a value"],
    ["no URL and --limit 1.5", { status: true, limit: 1.5 }, ["--status", "--limit", "1.5"], NO_DATABASE_URL.split("\n")[0]],
    ["--limit 1.5 and two modes", { url: AT, limit: 1.5, status: true, orphans: true }, ["--url", AT, "--limit", "1.5", "--status", "--orphans"], DIGITS],
    ["two modes and --input not a UUID", { url: AT, input: "nope", orphans: true }, ["--url", AT, "--input", "nope", "--orphans"], MODES],
    ["--reason and --limit outside their modes", { url: AT, status: true, reason: "why", limit: 5 }, ["--url", AT, "--status", "--reason", "why", "--limit", "5"], REASON_OUT],
    ["--limit outside --orphans and --dry-run with --status", { url: AT, status: true, limit: 5, dryRun: true }, ["--url", AT, "--status", "--limit", "5", "--dry-run"], LIMIT_OUT],
    // …and pairs further apart in it, so a rule moved past more than one neighbour is seen too (review pass 2).
    ["--gone without --input and --reason on the sweep", { url: AT, orphans: true, gone: true, reason: "why" }, ["--url", AT, "--orphans", "--gone", "--reason", "why"], WITH_INPUT],
    ["--force without --input and --limit outside --orphans", { url: AT, status: true, force: true, limit: 5 }, ["--url", AT, "--status", "--force", "--limit", "5"], WITH_INPUT],
    ["--force without --input and --dry-run with --status", { url: AT, status: true, force: true, dryRun: true }, ["--url", AT, "--status", "--force", "--dry-run"], WITH_INPUT],
    ["--reason outside --input and --dry-run with --status", { url: AT, status: true, reason: "why", dryRun: true }, ["--url", AT, "--status", "--reason", "why", "--dry-run"], REASON_OUT],
    ["--fingerprints without --gone and --limit outside --orphans", { url: AT, input: ID, fingerprints: ["a"], limit: 5 }, ["--url", AT, "--input", ID, "--fingerprints", "a", "--limit", "5"], WITH_GONE],
  ];
  for (const [what, opts, argv, first] of cases) {
    const r = await inProcess(opts);
    const cli = await counted(["rebuild.ts", ...argv]);
    ok(r.code === 2 && cli.code === 2, `rebuild run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && cli.err.split("\n")[0] === first, `…in main's words, the whole of both streams alike (${JSON.stringify(cli.err.trim().split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // A caller's client: queried, never closed; a URL beside it held to the rule; null read as absent.
  let closed = false;
  const stub = () => Object.assign(() => { throw new Error("stub queried"); }, { options: { max: 1 }, close: async () => { closed = true; }, unsafe: () => { throw new Error("stub queried"); } });
  const queried = await inProcess({ sql: stub(), status: true });
  ok(queried.code === 1 && queried.err === "  failed: stub queried\n", `rebuild run() runs on a caller's client alone, its error the CLI's "failed" line (exit ${queried.code}: ${JSON.stringify(queried.err.slice(0, 40))})`);
  const beside = await inProcess({ sql: stub(), url: "mysql://h/x", status: true });
  ok(beside.code === 2 && beside.err === `${UNPARSEABLE_DATABASE_URL}\n`, `…refuses a bad URL beside a caller's client (exit ${beside.code})`);
  const nullUrl = await inProcess({ url: null, status: true });
  ok(nullUrl.code === 2 && nullUrl.err === `${NO_DATABASE_URL}\n`, `…reads a null url as absent (exit ${nullUrl.code})`);
  // Read as present, a null input was a second mode, a null reason or limit a flag outside its mode, a null fingerprint list a flag without --input.
  const nulls = await inProcess({ sql: stub(), status: true, input: null, reason: null, fingerprints: null, limit: null });
  ok(nulls.code === 1 && nulls.err === "  failed: stub queried\n", `…and a null input, reason, fingerprints or limit: --status runs on (exit ${nulls.code}: ${JSON.stringify(nulls.err.slice(0, 50))})`);
  // A transaction's handle cannot hold the dry run's own transaction: refused before a query, by run() and by sweepOrphans.
  const tx = () => Object.assign(stub(), { savepoint: async () => {} });
  const inTx = await inProcess({ sql: tx(), orphans: true, dryRun: true });
  ok(inTx.code === 2 && /dry run is a transaction of its own, rolled back: pass the client itself or a reserved connection, not a transaction's handle/.test(inTx.err) && inTx.out === "", `rebuild run() refuses a dry run on a transaction's handle before querying it (exit ${inTx.code}: ${inTx.err.slice(0, 60)})`);
  const txRun = await inProcess({ sql: tx(), status: true });
  ok(txRun.code === 1 && txRun.err === "  failed: stub queried\n", `…and runs a mode that is no dry run on one (exit ${txRun.code})`);
  const { sweepOrphans } = await import("./rebuild.ts");
  const swept = (o: Record<string, unknown>, sql: unknown = stub()) => sweepOrphans(sql as never, { writer: capture(), ...o }).then(() => "resolved", (e: Error) => e.message);
  const [txSweep, fraction, nan, plain] = await Promise.all([swept({ dryRun: true }, tx()), swept({ limit: 1.5 }), swept({ limit: NaN }), swept({ limit: 0 })]);
  ok(/not a transaction's handle/.test(txSweep) && /limit must be an integer \(1\.5\)/.test(fraction) && /limit must be an integer \(NaN\)/.test(nan) && plain === "stub queried",
     `sweepOrphans refuses a dry run on a transaction's handle and a limit that is no integer before querying, and queries for 0 (${[txSweep, fraction, nan, plain].map((m) => m.slice(0, 30)).join(" | ")})`);
  // A signal aborted already stops the sweep before its read: the sleep scheduler's wake (SMD-2679).
  const early = await sweepOrphans(stub() as never, { writer: capture(), signal: AbortSignal.abort() }).then((r) => JSON.stringify(r), (e: Error) => e.message);
  ok(early === JSON.stringify({ thoughts: 0, touched: 0, deleted: 0, refused: 0, failed: 0, windowed: false, stopped: true, whole: false, last: null }), `…and a signal aborted already stops it before its read (${early})`);
  ok(!closed, "…and never closes the caller's client");
}

// ---------------------------------------------------------------------------
// sleep.ts's settings (SMD-2679; SMD-3379 PR 1c-4b): the flags refused by
// run() in the CLI's words before connecting, and the session settings they make.
// ---------------------------------------------------------------------------
{
  const { run, budgetSession, budgetMemory, schedulerSession, SCHEDULER_TAG, statementTimedOut } = await import("./sleep.ts");
  const inProcess = async (opts: Record<string, unknown>) => {
    seen = 0;
    const w = capture();
    const code = await run({ env: BASE_ENV, ...opts, writer: w } as never);
    await Bun.sleep(50);
    const lines = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
    return { code, out: lines(w.outs), err: lines(w.errs), seen };
  };
  const cases: [string, Record<string, unknown>, string[], string][] = [
    // The flags v2.0.0 removed (SMD-3379 PR 1c-4b): refused, naming what replaced each, not taken for unknown.
    ["--quiet, removed", { url: AT, quiet: 300 }, ["--url", AT, "--quiet", "300"], "--quiet (OB1_SLEEP_QUIET) was removed in v2.0.0: a work period begins once a pass has work"],
    ["--budget, removed", { url: AT, budget: 60 }, ["--url", AT, "--budget=60"], "--budget (OB1_SLEEP_BUDGET) was removed in v2.0.0: a work period runs until its pools drain"],
    // The idle scheduler's rescan (PR 1c-4b): a minute at least, a day at most.
    ["--rescan under a minute", { url: AT, rescan: 59 }, ["--url", AT, "--rescan", "59"], "--rescan must be a decimal integer >= 60 and <= 86400"],
    ["--rescan past a day", { url: AT, rescan: 86401 }, ["--url", AT, "--rescan", "86401"], "--rescan must be a decimal integer >= 60 and <= 86400"],
    // The pause's quiet (SMD-3379 PR 1c-3b): a second at least, a day at most.
    ["--capture 0", { url: AT, capture: 0 }, ["--url", AT, "--capture", "0"], "--capture must be a decimal integer >= 1 and <= 86400"],
    ["--capture past a day", { url: AT, capture: 86401 }, ["--url", AT, "--capture", "86401"], "--capture must be a decimal integer >= 1 and <= 86400"],
    // N12's bound (SMD-3379 PR 1c-4a): at or above extraction's 60 s stall floor, a day at most.
    ["--abort-after under the stall floor", { url: AT, abortAfter: 59 }, ["--url", AT, "--abort-after", "59"], "--abort-after must be a decimal integer >= 60 and <= 86400"],
    ["--abort-after past a day", { url: AT, abortAfter: 86401 }, ["--url", AT, "--abort-after", "86401"], "--abort-after must be a decimal integer >= 60 and <= 86400"],
    ["--statement-timeout past a day", { url: AT, statementTimeout: 86401 }, ["--url", AT, "--statement-timeout", "86401"], "--statement-timeout must be a decimal integer >= 0 and <= 86400"],
    ["--work-mem 0", { url: AT, workMem: 0 }, ["--url", AT, "--work-mem", "0"], "--work-mem must be a decimal integer >= 1 and <= 2097151"],
    ["--maintenance-work-mem past Postgres's bound", { url: AT, maintenanceWorkMem: 2097152 }, ["--url", AT, "--maintenance-work-mem", "2097152"], "--maintenance-work-mem must be a decimal integer >= 1 and <= 2097151"],
    // In the CLI's order: --rescan before --workers, --workers before the session settings.
    ["--rescan past a day and --workers 0", { url: AT, rescan: 86401, workers: 0 }, ["--url", AT, "--workers", "0", "--rescan", "86401"], "--rescan must be a decimal integer >= 60 and <= 86400"],
    ["--workers 0 and --work-mem 0", { url: AT, workers: 0, workMem: 0 }, ["--url", AT, "--work-mem", "0", "--workers", "0"], "--workers must be a decimal integer >= 1"],
  ];
  for (const [what, opts, argv, first] of cases) {
    const r = await inProcess(opts);
    const cli = await counted(["sleep.ts", ...argv]);
    ok(r.code === 2 && cli.code === 2, `sleep run() with ${what}: exit 2, as the CLI (${r.code}, ${cli.code})`);
    ok(r.out === cli.out && r.err === cli.err && cli.err.startsWith(first), `…in the scanner's words, the whole of both streams alike (${JSON.stringify(cli.err.split("\n")[0].slice(0, 90))}${r.err === cli.err ? "" : ` — run() said ${JSON.stringify(r.err.slice(0, 90))}`})`);
    ok(r.seen === 0 && cli.seen === 0 && !(r.out + r.err + cli.out + cli.err).includes(MARK), `…before connecting, and without the password (${r.seen}, ${cli.seen})`);
  }
  // --max-wait (SMD-3379 PR 2c-2): the CLI's alone — the order of the slots' hook, which the CLI installs and run() does
  // not — refused in its words before connecting, a second at least and a day at most.
  for (const v of ["0", "86401", "1.5"]) {
    const cli = await counted(["sleep.ts", "--url", AT, "--max-wait", v]);
    ok(cli.code === 2 && cli.err.startsWith("--max-wait must be a decimal integer >= 1 and <= 86400") && cli.seen === 0 && !(cli.out + cli.err).includes(MARK),
      `sleep.ts --max-wait ${v}: exit 2 in the scanner's words, before connecting (${cli.code}, ${JSON.stringify(cli.err.split("\n")[0].slice(0, 90))}, ${cli.seen})`);
  }
  const session = budgetSession({ statementTimeout: 300, workMem: 4, maintenanceWorkMem: 64 });
  const noTimeout = budgetSession({ statementTimeout: 0, workMem: 1, maintenanceWorkMem: 1 });
  ok(JSON.stringify(session) === JSON.stringify({ statement_timeout: "300s", work_mem: "4MB", maintenance_work_mem: "64MB" }) && !("statement_timeout" in noTimeout)
      && JSON.stringify(budgetMemory({ workMem: 4, maintenanceWorkMem: 64 })) === JSON.stringify({ work_mem: "4MB", maintenance_work_mem: "64MB" })
      // The scheduler's own: the memory settings and statement_timeout 0, beating a role's or database's own (review pass 2),
      // its name, which a migration's stop cancels by (SMD-3379 PR 1c-1), and each statement planned afresh (PR 1d).
      && JSON.stringify(schedulerSession({ workMem: 4, maintenanceWorkMem: 64 })) === JSON.stringify({ statement_timeout: "0", work_mem: "4MB", maintenance_work_mem: "64MB", application_name: SCHEDULER_TAG, plan_cache_mode: "force_custom_plan" })
      && /^ob1-sleep [0-9a-f]{8}$/.test(SCHEDULER_TAG),
     `sleep's budgetSession makes the three settings a pass's connections open with — no timeout at 0, so the role's or the database's own stands — and budgetMemory the two the scheduler's own take (${JSON.stringify(session)}; ${JSON.stringify(noTimeout)})`);
  // A statement timed out is 57014 in statement_timeout's words; an operator's cancel is 57014 too, and no budget's (review pass 1).
  const timedOut = { name: "PostgresError", errno: "57014", message: "canceling statement due to statement timeout" };
  const cancelled = { name: "PostgresError", errno: "57014", message: "canceling statement due to user request" };
  ok(statementTimedOut(timedOut) && !statementTimedOut(cancelled) && !statementTimedOut({ errno: "57P01", message: "statement timeout" }) && !statementTimedOut(null),
     "sleep's statementTimedOut reads statement_timeout's cancel, not an operator's, nor another code");
  // connect.ts's session takes settings by name: no startup parameter that is
  // no setting, no name of another shape, no NUL — thrown before connecting (review pass 3).
  const opened = (session: Record<string, string>) => { try { const c = openSql(AT, { session }); void c.close(); return "opened"; } catch (e) { return (e as Error).message; } };
  const refusals = ([{ user: "postgres" }, { Database: "other" }, { replication: "true" }, { "bad name": "1" }, { work_mem: "4MB\0x" }] as Record<string, string>[]).map(opened);
  ok(refusals.every((m) => /^openSql: session takes Postgres settings by name/.test(m)) && opened({ work_mem: "4MB", "app.custom_x": "1" }) === "opened" && seen === 0,
     `openSql refuses a session naming the user, the database or replication, a name of another shape and a NUL, and takes settings (${refusals.map((m) => m.slice(0, 20)).join(" | ")})`);
  // The tests' hooks are held to a rule, as passFollowS is: thrown, a caller's not an operator's.
  // Bounded: a hook the rule let through runs, and waits on its database, rather than failing (SMD-3196's mutant).
  const thrown = (o: Record<string, number>) => Promise.race([
    run({ url: AT, ...o, writer: capture() } as never).then((c) => String(c), (e: Error) => `${e.name}: ${e.message}`),
    Bun.sleep(5000).then(() => "still running after 5 s"),
  ]);
  // rescanMs and pollMs, positive (0) and whole (700.5) milliseconds (SMD-3196; PR 1c-4b).
  const [rescanHook, pollHook, partHook] = [await thrown({ rescanMs: 0 }), await thrown({ pollMs: 0.5 }), await thrown({ pollMs: 700.5 })];
  ok(/^RangeError: rescanMs must be/.test(rescanHook) && /^RangeError: pollMs must be/.test(pollHook) && /^RangeError: pollMs must be/.test(partHook),
     `…and a rescanMs of 0 and a pollMs of half a millisecond or of 700.5 are thrown, not run (${[rescanHook, pollHook, partHook].map((h) => h.slice(0, 40)).join(" | ")})`);
  // The pause's hooks (SMD-3379 PR 1c-3b): a capture of 0 ms, and N12's bound below the stall floor — the
  // shipped minute, or a test's own — where an abort would be a short stop and a thought never stall.
  const [captureHook, belowFloor, belowOwnFloor] = [await thrown({ captureMs: 0 }), await thrown({ abortAfterMs: 59_999 }), await thrown({ abortAfterMs: 999, stallFloorMs: 1000 })];
  ok(/^RangeError: captureMs must be/.test(captureHook) && /^RangeError: abortAfterMs must be .*>= 60000/.test(belowFloor) && /^RangeError: abortAfterMs must be .*>= 1000/.test(belowOwnFloor),
     `…and a captureMs of 0, or an abortAfterMs below the stall floor, are thrown, not run (${[captureHook, belowFloor, belowOwnFloor].map((h) => h.slice(0, 60)).join(" | ")})`);
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

// worker-bootstrap.ts's MAX_CALL_TIMEOUT_S is AbortSignal.timeout's edge in
// seconds: the largest --timeout makes a signal, one more throws (SMD-2304 PR 5).
{
  const { MAX_CALL_TIMEOUT_S } = await import("./worker-bootstrap.ts");
  const atMax = (() => { try { AbortSignal.timeout(MAX_CALL_TIMEOUT_S * 1000); return "made"; } catch (e) { return (e as Error).message; } })();
  const past = (() => { try { AbortSignal.timeout((MAX_CALL_TIMEOUT_S + 1) * 1000); return "made"; } catch (e) { return (e as Error).message; } })();
  ok(atMax === "made" && past !== "made", `MAX_CALL_TIMEOUT_S (${MAX_CALL_TIMEOUT_S} s) makes a call's timeout signal and one second more throws (${past.slice(0, 60)})`);
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
  // SMD-4308: the engines' one option reader — the copy each numbers() held.
  const { flagList, optionReader } = await import("./cli.ts");
  const spec = { workers: "one", "min-sim": "one" } as const;
  const hints = { workers: "<n>" };
  const read = optionReader(spec, hints);
  ok(read("--workers", null, 2) === 2 && read("--workers", undefined, 2) === 2 && read("--workers", 3, 2) === 3 && read("--min-sim", 0.5, 0, { min: -1, max: 1, fraction: true }) === 0.5 && read("--workers", 0, 2, { min: 0 }) === 0,
     "optionReader gives the default for an absent option and the option when its rule holds (a rule of its own, a fraction and 0 included)");
  ok(read("--workers", 0, 2) === `--workers must be a decimal integer >= 1\n${flagList(spec, hints)}` && read("--workers", 9, 2, { min: 1, max: 8 }) === `--workers must be a decimal integer >= 1 and <= 8\n${flagList(spec, hints)}`,
     "…and refuses a broken rule in numberProblem's words with the script's flag list under them, the default rule a whole number >= 1");
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

// The live gate (SMD-3379 PR 1c-3a): db/lease.ts' liveGate, the admit gate
// the sleep scheduler closes while its brain is live, as Admit's contract
// asks — an open ask settled at once, a closed one waiting until open() or
// its signal aborts, its listener taken off either way — and closedSince,
// which admitted's lastAsk reads a closure that opened again by.
{
  const { admitted, liveGate } = await import("./lease.ts");
  const gate = liveGate();
  const run = new AbortController();
  const began = performance.now();
  ok(!gate.closed && (await admitted(gate.admit, run.signal)) === "open" && gate.admit.closedSince?.(began) === false,
    "a live gate begins open: an ask goes through at once, and it has not closed since");
  /** A signal that counts the listeners on it, to see each taken off. */
  const counted = () => {
    const ac = new AbortController();
    let live = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => { live++; add(...a); }) as typeof add;
    ac.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { live--; remove(...a); }) as typeof remove;
    return { ac, get live() { return live; } };
  };
  const waiter = counted();
  gate.close();
  const asked = admitted(gate.admit, waiter.ac.signal);
  const early = await Promise.race([asked, Bun.sleep(50).then(() => "pending" as const)]);
  const listening = waiter.live;
  const held = gate.waiting;
  gate.open();
  ok(early === "pending" && listening === 1 && held === 1 && (await asked) === "waited" && waiter.live === 0 && gate.waiting === 0 && !gate.closed,
    `closed, an ask waits until the gate opens and reads waited, held and let go, its listener taken off (${early}, ${listening} → ${waiter.live}, ${held} held)`);
  await Bun.sleep(2);
  const since = performance.now();
  ok((await admitted(gate.admit, run.signal, began)) === "waited" && (await admitted(gate.admit, run.signal, since)) === "open"
      && gate.admit.closedSince?.(began) === true && gate.admit.closedSince?.(since) === false,
    "open again, an ask whose worker last passed before the closure reads waited — the closure opened again during its call — and one after it open");
  const stopping = counted();
  gate.close();
  const stoppedAsk = admitted(gate.admit, stopping.ac.signal);
  stopping.ac.abort();
  // Its listener goes with the abort it heard (`once`), which the count does not see; the gate keeps no hold on it.
  ok((await stoppedAsk) === false && gate.waiting === 0 && (await admitted(gate.admit, stopping.ac.signal)) === false && gate.waiting === 0 && gate.admit.closedSince?.(performance.now()) === true,
    "a stop turns a waiting ask away, and an ask whose signal has already aborted at once, while closed, the gate holding neither");
  gate.open();
  gate.open();
  ok(!gate.closed && (await admitted(gate.admit, stopping.ac.signal)) === "open", "opened twice, it stays open; an open gate lets an aborted signal's ask through, as Admit's contract has it");
  // On its own clock (review pass 1): a closure that opened again at t counts
  // from t itself; opening an open gate moves nothing.
  let clock = 10;
  const timed = liveGate(() => clock);
  timed.close();
  timed.open();
  const atOpen = [timed.admit.closedSince?.(10), timed.admit.closedSince?.(11)];
  clock = 20;
  timed.open();
  ok(atOpen[0] === true && atOpen[1] === false && timed.admit.closedSince?.(11) === false,
    `a closure that opened again at t counts from t on, and opening an open gate moves nothing (${JSON.stringify(atOpen)}, ${timed.admit.closedSince?.(11)})`);
}

// The scheduler's pause on its heartbeat (SMD-3379 PR 1c-3a): db/pass-stamp.ts'
// paused(), `paused { since }` while set, left out once cleared or ended.
{
  const { passStamper } = await import("./pass-stamp.ts");
  const writes: string[] = [];
  const fake = ((_s: TemplateStringsArray, ...v: unknown[]) => { writes.push(String(v[1])); return Promise.resolve([]); }) as never;
  const st = passStamper({ sql: fake, worker: "sleep", intervalS: 60 });
  const since = "2026-10-31T12:00:00.000Z";
  st.paused?.(since);
  await st.alive();
  const pausedValue = JSON.parse(writes.at(-1) ?? "{}");
  st.paused?.(null);
  await st.alive();
  const clearedValue = JSON.parse(writes.at(-1) ?? "{}");
  st.paused?.(since);
  await st.end("stopped");
  const endedValue = JSON.parse(writes.at(-1) ?? "{}");
  ok(pausedValue.paused?.since === since && !("paused" in clearedValue) && !("paused" in endedValue) && endedValue.ended === true,
    `the stamper writes paused { since } while set, and leaves it out once cleared or the row ends (${JSON.stringify([pausedValue.paused, clearedValue.paused, endedValue.paused])})`);
}

// The scheduler's holds on its heartbeat (SMD-3379 PR 1c-4a): db/pass-stamp.ts'
// holds(), `holds` while one is, left out once cleared or emptied, kept on the
// row's end as its last word, and a copy, so a caller's later change is not written.
{
  const { passStamper } = await import("./pass-stamp.ts");
  const writes: string[] = [];
  const fake = ((_s: TemplateStringsArray, ...v: unknown[]) => { writes.push(String(v[1])); return Promise.resolve([]); }) as never;
  const st = passStamper({ sql: fake, worker: "sleep", intervalS: 60 });
  const list = [{ pass: "reembed" as const, why: "model-switch" as const, until: null }, { pass: "extract" as const, why: "lookup" as const, until: "2026-11-02T12:00:00.000Z" }];
  st.holds?.(list);
  list[0].why = "provider" as never;
  await st.alive();
  const heldValue = JSON.parse(writes.at(-1) ?? "{}");
  st.holds?.([]);
  await st.alive();
  const emptyValue = JSON.parse(writes.at(-1) ?? "{}");
  st.holds?.([{ pass: "reembed", why: "outage", until: null }]);
  st.holds?.(null);
  await st.alive();
  const clearedValue = JSON.parse(writes.at(-1) ?? "{}");
  st.holds?.([{ pass: "consolidate", why: "provider", until: null }]);
  await st.end("stopped");
  const endedValue = JSON.parse(writes.at(-1) ?? "{}");
  ok(JSON.stringify(heldValue.holds) === JSON.stringify([{ pass: "reembed", why: "model-switch", until: null }, { pass: "extract", why: "lookup", until: "2026-11-02T12:00:00.000Z" }])
      && !("holds" in emptyValue) && !("holds" in clearedValue) && JSON.stringify(endedValue.holds) === JSON.stringify([{ pass: "consolidate", why: "provider", until: null }]) && endedValue.ended === true,
    `the stamper writes holds as given, a copy, leaves them out once emptied or cleared, and keeps them on the row's end (${JSON.stringify([heldValue.holds, emptyValue.holds, clearedValue.holds, endedValue.holds])})`);
}

// ---------------------------------------------------------------------------
// db/claim-loop.ts's claimWorker (SMD-4308): the loop around a thought, over a
// stand-in for the database. Each statement is told apart by its text.
// ---------------------------------------------------------------------------
{
  const { claimWorker } = await import("./claim-loop.ts");
  const { ProviderOutage, SUSPECT_WINDOW_MS, Unreturned } = await import("./worker-bootstrap.ts");
  type Row = { id: string };
  /** A database of claim batches: what each claim_thoughts call asked for, how many leases the worker's return freed, and the lost row's status. */
  const database = (batches: string[][], o: { lostStatus?: string | null; claimThrows?: Error; returnThrows?: Error } = {}) => {
    const wants: number[] = [];
    const statements: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("claim_thoughts(")) {
        statements.push("claim");
        wants.push(values[2] as number);
        if (o.claimThrows) return Promise.reject(o.claimThrows);
        return Promise.resolve((batches.shift() ?? []).slice(0, values[2] as number).map((thought_id) => ({ thought_id, attempt: 1 })));
      }
      if (text.includes("release_claims_for_worker(")) {
        statements.push("return");
        if (o.returnThrows) return Promise.reject(o.returnThrows);
        return Promise.resolve([{ n: 2 }]);
      }
      // reportLost's read of the row: none for a deleted thought.
      statements.push("lost-read");
      return Promise.resolve(o.lostStatus == null ? [] : [{ status: o.lostStatus, worker_id: null }]);
    }) as unknown as import("bun").SQL;
    return { sql, wants, statements };
  };
  const drive = async (db: ReturnType<typeof database>, o: { batch?: number; limit?: number; follow?: boolean; isolated?: boolean; outage?: InstanceType<typeof ProviderOutage>; admit?: import("./lease.ts").Admit; gate?: AbortSignal; row?: (id: string, hand: import("./claim-loop.ts").ClaimHand) => "stop" | "next"; extra?: Pick<import("./claim-loop.ts").ClaimWorkerOptions<Row>, "afterGate" | "beforeClaim" | "leaseReturn">; active?: Set<string>; errThrows?: RegExp } = {}) => {
    const seen: string[] = [];
    const errs: string[] = [];
    const counts = { lost: 0, vanished: 0, beats: -1 };
    const taken = new Set<string>();
    const claiming = { n: 0 };
    const limit = o.limit ?? 0;
    const activeWorkers = o.active ?? new Set<string>();
    /** The Writer's err: it throws on a line a test names, as a caller's may. */
    const err = (l: string): void => {
      errs.push(l);
      if (o.errThrows?.test(l)) throw new Error("the Writer threw");
    };
    let polled = false;
    let workerId = "";
    let activeInRow = false;
    await claimWorker<Row>({
      sql: db.sql, job: "test:job", prefix: "probe", n: 3, ttlS: 900, heartbeatS: 60, batch: o.batch ?? 2, limit, follow: o.follow ?? false, admit: o.admit,
      gate: () => o.gate ?? new AbortController().signal, err, errAside: (l) => errs.push(l), ...o.extra,
      outage: o.outage ?? new ProviderOutage(), taken, claiming, limitReached: () => limit > 0 && taken.size + claiming.n >= limit, activeWorkers, unreturned: new Unreturned(async () => null), inCall: { end: () => {} },
      stopping: () => false, hardStopped: () => false, isolated: () => o.isolated ?? false, pollNow: () => { polled = true; },
      count: { lost: () => { counts.lost++; }, vanished: () => { counts.vanished++; }, beats: (k) => { counts.beats = k; } },
      readRows: async (ids) => ids.map((id) => ({ id })),
      row: async (b, row, hand) => {
        seen.push(`${b.thought_id}:${row?.id}`);
        workerId = hand.workerId;
        activeInRow = activeWorkers.has(hand.workerId) && hand.hb.held.has(b.thought_id);
        const answer = o.row?.(b.thought_id, hand) ?? "next";
        // An engine takes a thought out of the heartbeat's set as it releases it.
        if (answer === "next") hand.hb.held.delete(b.thought_id);
        return answer;
      },
    });
    return { seen, errs, counts, taken, activeWorkers, polled, workerId, activeInRow };
  };

  const plain = database([["a", "b"], ["c"]]);
  const p = await drive(plain);
  ok(p.seen.join(" ") === "a:a b:b c:c" && plain.wants.join(",") === "2,2,2" && plain.statements.join(" ") === "claim claim claim return",
     `claimWorker claims a batch at a time until the pool is empty, hands the engine each thought with its row, and returns its leases last (${p.seen.join(" ")}; ${plain.statements.join(" ")})`);
  ok(/^probe-.+-\d+-3-[0-9a-f]{8}$/.test(p.workerId) && p.activeInRow && p.activeWorkers.size === 0 && p.counts.beats === 0 && p.errs.join("") === "  " + p.workerId + ": returned 2 unfinished row(s) to the pool",
     `…under an id of the engine's name, the host, the process and the worker's number, active and beating for the thought while it is in hand, and neither once it ends; a run without --follow says what it returned (${p.errs.join(" | ")})`);
  const quiet = await drive(database([["a"]]), { follow: true });
  ok(quiet.errs.length === 0, `…and a follower's return says nothing (${quiet.errs.join(" | ")})`);

  // The row a beat found no longer this worker's is skipped, and counted by what the row says.
  for (const [status, want] of [["pending", "lost"], [null, "vanished"]] as const) {
    const db = database([["a", "b", "c"]], { lostStatus: status });
    const r = await drive(db, { batch: 3, row: (id, hand) => { if (id === "a") { hand.hb.held.delete("b"); hand.hb.lost.add("b"); } return "next"; } });
    ok(r.seen.join(" ") === "a:a c:c" && r.counts[want] === 1 && r.counts.lost + r.counts.vanished === 1 && db.statements.join(" ") === "claim lost-read claim return" && r.errs.some((l) => l.startsWith("  b: ")),
       `a thought a beat found lost before the loop reached it is not handed to the engine: its row is read, it is named, and it counts as ${want} (${r.seen.join(" ")}; ${JSON.stringify(r.counts)}; ${db.statements.join(" ")})`);
  }

  // "stop" ends the worker where it is; the rest of the batch goes back with its leases.
  const stopped = database([["a", "b"], ["c"]]);
  const s = await drive(stopped, { follow: true, row: () => "stop" });
  ok(s.seen.join(" ") === "a:a" && stopped.statements.join(" ") === "claim return", `an engine's "stop" ends the worker at that thought: no later thought, no further claim, the leases returned (${s.seen.join(" ")}; ${stopped.statements.join(" ")})`);

  // --limit: what is taken counts against it, and a claim asks for no more than is left.
  const limited = database([["a", "b"], ["c", "d"], ["e"]]);
  const l = await drive(limited, { limit: 3, follow: true });
  ok(l.seen.join(" ") === "a:a b:b c:c" && limited.wants.join(",") === "2,1" && l.taken.size === 3, `under --limit 3 a worker of batch 2 claims two, then the one left, and no more (asked for ${limited.wants.join(",")}; ${l.seen.join(" ")})`);

  // An isolated pass (SMD-2641) claims one thought at a time, and ends once no suspect is left to retry.
  const outage = new ProviderOutage(() => 0, SUSPECT_WINDOW_MS, true);
  outage.begin("500", "s1");
  outage.end();
  const iso = database([["s1"], ["x"], ["y"]]);
  const i = await drive(iso, { batch: 5, isolated: true, outage, follow: true });
  ok(outage.reason === null && iso.wants.join(",") === "1,1" && i.seen.join(" ") === "s1:s1 x:x" && i.polled && !outage.isolating(),
     `a pass retrying an outage's suspects claims one thought a claim whatever --batch is, and once a claim brings a thought that is no suspect it ends, the next pass polled at once (asked for ${iso.wants.join(",")}; ${i.seen.join(" ")}; polled ${i.polled})`);
  const whole = database([["a"]]);
  await drive(whole, { batch: 5, follow: true });
  ok(whole.wants[0] === 5, `…and any other pass claims its whole batch (asked for ${whole.wants[0]})`);

  // What re-embed passes beside the claim passes (SMD-4308 PR 3): a check before each claim, a reason of its own after the gate, and its own return of its leases.
  const checked = database([["a"]]);
  let asks = 0;
  const c1 = await drive(checked, { follow: true, extra: { beforeClaim: async () => ++asks > 1 } });
  ok(c1.seen.join(" ") === "a:a" && asks === 2 && checked.statements.join(" ") === "claim return", `an engine's check before each claim lets the claim through while it says no, and ends the worker with nothing claimed once it says yes (${asks} check(s); ${checked.statements.join(" ")})`);
  const checkFails = database([["a"]]);
  const c2 = await drive(checkFails, { follow: false, extra: { beforeClaim: () => Promise.reject(Object.assign(new Error("could not serialize access"), { name: "PostgresError", errno: "40001" })) } });
  ok(c2.seen.length === 0 && checkFails.statements.join(" ") === "return" && c2.errs.some((e) => /could not serialize access — this worker stops$/.test(e)), `…and a check the database refuses is the claim's own refusal: this worker stops with it said (${c2.errs.join(" | ")})`);
  const { liveGate: openGate } = await import("./lease.ts");
  const moved = database([["a"]]);
  const c3 = await drive(moved, { follow: true, admit: openGate().admit, extra: { afterGate: () => true } });
  const ungated = database([["a"]]);
  const c4 = await drive(ungated, { follow: true, extra: { afterGate: () => true } });
  ok(c3.seen.length === 0 && moved.statements.join(" ") === "return" && c4.seen.join(" ") === "a:a", `an engine's own reason after the admit gate ends the worker before its claim, and is not asked where there is no gate (${moved.statements.join(" ")}; ${c4.seen.join(" ")})`);
  const cut = () => Object.assign(new Error("connection closed"), { name: "PostgresError", errno: "08006" });
  const plainRefused = await drive(database([["a"]], { returnThrows: cut() }), { follow: true });
  const oneShotRefused = await drive(database([["a"]], { returnThrows: cut() }), { follow: false });
  const ownWords = await drive(database([["a"]], { returnThrows: cut() }), { follow: true, extra: { leaseReturn: { refusedLine: (w, m) => `  ${w}: its own words (${m})` } } });
  ok(plainRefused.errs.join() === `  ${plainRefused.workerId}: could not return its leases (connection closed); they expire within 900 s, or return when the database answers again`
     && oneShotRefused.errs.join() === `  ${oneShotRefused.workerId}: could not return its leases (connection closed); they expire within 900 s`
     && ownWords.errs.join() === `  ${ownWords.workerId}: its own words (connection closed)`,
     `a return of the leases the database refuses is said in the loop's words, a follower's naming the database's answer, or in the engine's own (${plainRefused.errs.join()} | ${ownWords.errs.join()})`);
  const loud = await drive(database([["a"]]), { follow: true, extra: { leaseReturn: { saysReturned: true } } });
  ok(loud.errs.join() === `  ${loud.workerId}: returned 2 unfinished row(s) to the pool`, `an engine that says every return says a follower's too (${loud.errs.join()})`);
  const kept = new Set<string>();
  const keptThrow = await drive(database([["a"]], { returnThrows: cut() }), { follow: true, active: kept, errThrows: /could not return its leases/ }).then(() => "none", (e: Error) => e.message);
  const left = new Set<string>();
  const leftThrow = await drive(database([["a"]], { returnThrows: cut() }), { follow: true, active: left, errThrows: /could not return its leases/, extra: { leaseReturn: { inactiveWhateverTheWriter: true } } }).then(() => "none", (e: Error) => e.message);
  ok(keptThrow === "the Writer threw" && kept.size === 1 && leftThrow === "the Writer threw" && left.size === 0,
     `a Writer that throws on the refusal's line is the caller's error either way; the worker stays in the pass's active set as the claim passes have it, and leaves it where the engine asks (${kept.size} kept, ${left.size} left)`);

  // The admit gate before each claim (SMD-3379 PR 1b): closed, a worker waits holding no claim, and a stop ends it there.
  const { liveGate } = await import("./lease.ts");
  const moment = () => new Promise((r) => setTimeout(r, 20));
  const door = liveGate();
  door.close();
  const gated = database([["a"]]);
  const waiting = drive(gated, { follow: true, admit: door.admit, gate: new AbortController().signal });
  await moment();
  const heldBack = gated.statements.join(" ") === "" && door.waiting === 1;
  door.open();
  const g = await waiting;
  ok(heldBack && g.seen.join(" ") === "a:a" && gated.statements.join(" ") === "claim claim return", `a worker at a closed admit gate waits there, nothing claimed, and claims once it opens (held back ${heldBack}; ${g.seen.join(" ")}; ${gated.statements.join(" ")})`);
  door.close();
  const passEnds = new AbortController();
  const ended = database([["a"]]);
  const endingAtGate = drive(ended, { follow: true, admit: door.admit, gate: passEnds.signal });
  await moment();
  passEnds.abort();
  const atGate = await endingAtGate;
  ok(atGate.seen.length === 0 && ended.statements.join(" ") === "return" && door.waiting === 0, `…and a stop while it waits ends the worker with no claim made (${ended.statements.join(" ")}; ${door.waiting} still waiting)`);

  // A claim the database refuses: a passing error costs the worker its poll; the end of the database's patience ends a follower.
  const passing = database([], { claimThrows: Object.assign(new Error("could not serialize access"), { name: "PostgresError", errno: "40001" }) });
  const pe = await drive(passing, { follow: true });
  ok(pe.seen.length === 0 && passing.statements.join(" ") === "claim return" && pe.errs.some((e) => /could not serialize access — this worker stops$/.test(e)), `a claim that meets a passing error stops this worker with the error said, its leases returned (${pe.errs.join(" | ")})`);
  const ending = database([], { claimThrows: Object.assign(new Error("permission denied for function claim_thoughts"), { name: "PostgresError", errno: "42501" }) });
  const thrown = await drive(ending, { follow: true }).then(() => "none", (e: Error) => e.message);
  const oneShot = await drive(database([], { claimThrows: Object.assign(new Error("permission denied for function claim_thoughts"), { name: "PostgresError", errno: "42501" }) }), { follow: false }).then((r) => r.errs.join(""), (e: Error) => `threw ${e.message}`);
  ok(thrown === "permission denied for function claim_thoughts" && ending.statements.join(" ") === "claim return" && oneShot.includes("permission denied for function claim_thoughts — this worker stops"),
     `a follower's claim refused for good throws the refusal for its caller, its leases returned first; a one-shot run's worker stops with it said (${thrown}; ${oneShot})`);
}

// ---------------------------------------------------------------------------
// db/claim-loop.ts's thoughtFault and recordFailedAndStop (SMD-4308): what a
// thought's streak does with an error, over a stand-in engine.
// ---------------------------------------------------------------------------
{
  const { thoughtFault, recordFailedAndStop } = await import("./claim-loop.ts");
  const { ProviderOutage, SUSPECT_WINDOW_MS, ALONE_OUTAGES } = await import("./worker-bootstrap.ts");
  type Host = import("./claim-loop.ts").FaultHost;
  type Probe = import("./worker-bootstrap.ts").Probe;
  type Act = import("./worker-bootstrap.ts").FollowerFault["act"];
  const pg = (errno: string, message = `database error ${errno}`) => Object.assign(new Error(message), { name: "PostgresError", errno });
  /** A stand-in engine: what it was told, and the state a test turns. */
  const engine = (o: { follow?: boolean; act?: Act; suspect?: boolean; probes?: Probe[]; probedOut?: boolean; released?: boolean | Error } = {}) => {
    const s = {
      errs: [] as string[], stopping: false, hardStopped: false, halt: new AbortController(), outage: new ProviderOutage(() => 0, SUSPECT_WINDOW_MS, true),
      reads: 0, probed: 0, providerStops: 0, failed: 0, lost: 0, fatal: null as string | null, refusedProbes: 0, outages: [] as boolean[], paused: 0, back: [] as string[], unrecorded: 0, statements: 0,
      onRead: () => {}, duringPause: () => {},
    };
    const probes = [...(o.probes ?? [])];
    const sql = (() => {
      s.statements++;
      return o.released instanceof Error ? Promise.reject(o.released) : Promise.resolve([{ ok: o.released ?? true }]);
    }) as unknown as import("bun").SQL;
    const host: Host = {
      sql, job: "test:job", follow: o.follow ?? true, err: (l) => s.errs.push(l), outage: s.outage, halt: () => s.halt,
      stopping: () => s.stopping, hardStopped: () => s.hardStopped, inCall: { get: () => undefined },
      read: () => { s.reads++; s.onRead(); return { act: o.act ?? "thought", suspect: o.suspect ?? false }; },
      probe: async () => { s.probed++; return probes.shift() ?? { state: "up" }; },
      ...(o.probedOut === undefined ? {} : { probedOut: () => o.probedOut as boolean }),
      onProbeRefused: () => { s.refusedProbes++; },
      onOutage: (_e, begins) => { s.outages.push(begins); },
      fatal: (_e, why) => { s.fatal = why; s.stopping = true; },
      onPaused: () => { s.paused++; s.duringPause(); },
      count: { providerStop: () => { s.providerStops++; }, failed: () => { s.failed++; }, lost: () => { s.lost++; } },
      pausesMs: [1, 1],
    };
    const fault = (e: unknown, attempt = 0, streak = { suspect: false }) =>
      thoughtFault(host, { id: "t1", workerId: "w1", attempt, streak, backFirst: async (id) => { s.back.push(id); } }, e).then((turn) => ({ turn, streak }));
    return { s, host, fault };
  };
  const said = (s: { errs: string[] }, re: RegExp) => s.errs.some((l) => re.test(l));

  // The database's errors come first, under --follow: gone, the worker stops; its end is thrown; its moment sends the thought back.
  const gone = engine();
  const g = await gone.fault(pg("57P01"));
  ok(g.turn.then === "stop" && gone.s.reads === 0 && said(gone.s, /^  w1: the database is not answering \(database error 57P01\) — this worker stops, recording nothing for t1$/),
     `thoughtFault: the database gone under a follower's thought stops the worker with nothing recorded, the provider's rules unread (${gone.s.errs.join(" | ")})`);
  const end = engine();
  const ended = await end.fault(pg("42501", "permission denied for table entities")).then(() => "none", (e: Error) => e.message);
  const moment = engine();
  const m = await moment.fault(pg("40P01", "deadlock detected\nDETAIL: more"));
  ok(ended === "permission denied for table entities" && end.s.reads === 0 && m.turn.then === "stop" && moment.s.reads === 0 && said(moment.s, /the write met the database's moment \(deadlock detected\) — t1 goes back to the pool unrecorded$/),
     `…the database's end is thrown for the follower to end on, and its moment sends the thought back unrecorded, its first line said (${ended}; ${moment.s.errs.join(" | ")})`);
  const oneShot = engine({ follow: false, act: "thought" });
  const os = await oneShot.fault(pg("57P01"));
  const hard = engine({ act: "thought" });
  hard.s.hardStopped = true;
  const hd = await hard.fault(pg("57014", "canceling statement due to user request")).then((r) => r.turn.then, () => "threw");
  ok(os.turn.then === "failed" && oneShot.s.reads === 1 && hd === "failed" && hard.s.reads === 1,
     `…a run without --follow reads no database error apart, and past the hard stop a cancelled statement is no end (${os.turn.then}, ${hd})`);

  // The thought's own, the request's, and the probe's three answers.
  const own = engine({ act: "thought" });
  const o1 = await own.fault(new Error("x".repeat(600)));
  ok(o1.turn.then === "failed" && o1.turn.error.length === 500 && !o1.turn.stopAfter && own.s.probed === 0 && own.s.errs.length === 0,
     `an error that is the thought's fails it with the error's first 500 characters, the worker going on (${o1.turn.then}, ${o1.turn.then === "failed" ? o1.turn.error.length : ""})`);
  const shape = engine({ act: "fatal" });
  const f1 = await shape.fault(new Error("400 response_format"));
  ok(f1.turn.then === "stop" && shape.s.fatal === "400 response_format" && said(shape.s, /^  w1: the provider refuses the request itself \(400 response_format\) — stopping every worker; nothing is marked failed$/),
     `a request the provider refuses stops every worker through the engine, what to fix kept, nothing failed (${shape.s.fatal})`);
  const answered = engine({ act: "probe", probes: [{ state: "up" }] });
  const a1 = await answered.fault(new Error("401"));
  ok(a1.turn.then === "failed" && a1.turn.error === "401 (a one-token call right after answered, so this thought's; --retry-failed revisits it)" && answered.s.probed === 1 && !a1.turn.stopAfter,
     `an error the probe decides, the probe answering: the thought's, and said so (${a1.turn.then === "failed" ? a1.turn.error : a1.turn.then})`);
  const refused = engine({ act: "probe", probes: [{ state: "refused", why: "no such key" }] });
  const r1 = await refused.fault(new Error("401"));
  ok(r1.turn.then === "stop" && refused.s.fatal === "a one-token call was refused (no such key), right after 401" && refused.s.refusedProbes === 1,
     `…the probe refused: the request's, the probe's refusal said beside the call's and the engine told whose it was (${refused.s.fatal})`);
  const unanswered = engine({ act: "probe", suspect: true, probes: [{ state: "out", why: "no answer" }] });
  const u1 = await unanswered.fault(new Error("deadline"));
  ok(u1.turn.then === "stop" && unanswered.s.outage.reason === "deadline" && unanswered.s.providerStops === 1 && unanswered.s.halt.signal.aborted && unanswered.s.outages.join() === "true" && unanswered.s.back.join() === "t1" && u1.streak.suspect
     && said(unanswered.s, /^  w1: the provider is not answering \(deadline\) — t1 goes back to the pool unrecorded, and the follower waits for the provider$/),
     `…the probe unanswered: an outage begins, counted, the pass halted, the engine told, and the suspect back at the pool's front (${unanswered.s.errs.join(" | ")})`);
  const notSuspect = engine({ act: "outage", suspect: false });
  const n1 = await notSuspect.fault(new Error("model not found"));
  ok(n1.turn.then === "stop" && notSuspect.s.providerStops === 1 && notSuspect.s.back.length === 0 && notSuspect.s.probed === 0, `an outage at once, on an error that says nothing of the thought, begins one with no suspect set forward and no probe (${notSuspect.s.back.length} set forward)`);
  const stoppingProbe = engine({ act: "probe" });
  stoppingProbe.s.stopping = true;
  const sp = await stoppingProbe.fault(new Error("401"));
  const joined = engine({ act: "probe", suspect: true });
  joined.s.outage.begin("another worker's");
  const j1 = await joined.fault(new Error("401"));
  ok(sp.turn.then === "stop" && stoppingProbe.s.probed === 0 && j1.turn.then === "stop" && joined.s.probed === 0 && joined.s.outages.join() === "false" && joined.s.providerStops === 1,
     `a stopping pass hands the thought back unprobed, and another worker's outage is joined unprobed, the engine told it began none (${joined.s.outages.join()})`);

  // The pauses: called again after each, an outage past them under --follow, the thought's failure without.
  const pausing = engine({ act: "pause", suspect: true });
  const p0 = await pausing.fault(new Error("503"), 0);
  ok(p0.turn.then === "again" && pausing.s.paused === 1 && p0.streak.suspect && said(pausing.s, /^  w1: provider unavailable \(503\); pausing 0\.001 s$/), `a failing provider is paused for and called again, the engine told the pause ended (${pausing.s.errs.join(" | ")})`);
  const past = await pausing.fault(new Error("503"), 2, p0.streak);
  const pastOneShot = engine({ follow: false, act: "pause" });
  const po = await pastOneShot.fault(new Error("503"), 2);
  ok(past.turn.then === "stop" && pausing.s.outage.reason === "503" && pausing.s.back.join() === "t1" && po.turn.then === "failed" && po.turn.error === "provider error after 2 retries: 503" && po.turn.stopAfter,
     `…past the pauses a follower begins an outage, and a one-shot run fails the thought and stops after it (${past.turn.then}; ${po.turn.then === "failed" ? po.turn.error : po.turn.then})`);
  const woken = engine({ act: "pause", suspect: true });
  woken.s.duringPause = () => { woken.s.stopping = true; };
  const w1 = await woken.fault(new Error("503"), 0);
  const halted = engine({ act: "pause", suspect: true });
  halted.s.duringPause = () => { halted.s.outage.begin("another worker's"); };
  const h1 = await halted.fault(new Error("503"), 0);
  const haltedNoSuspect = engine({ act: "pause", suspect: false });
  haltedNoSuspect.s.duringPause = () => { haltedNoSuspect.s.outage.begin("another worker's"); };
  const h2 = await haltedNoSuspect.fault(new Error("429"), 0);
  ok(w1.turn.then === "stop" && woken.s.back.length === 0 && h1.turn.then === "stop" && halted.s.back.join() === "t1" && said(halted.s, /t1 was pausing on the provider when it stopped answering — a suspect of the outage too, back in the pool unrecorded$/) && h2.turn.then === "stop" && haltedNoSuspect.s.back.length === 0,
     `a stop during a pause hands the thought back; another worker's outage during it makes a thought whose streak could be its own a suspect of that outage, set forward and said, and no other (${halted.s.errs.at(-1)})`);

  const stoppingPause = engine({ act: "pause", suspect: true });
  stoppingPause.s.stopping = true;
  stoppingPause.s.outage.begin("another worker's");
  const s1 = await stoppingPause.fault(new Error("503"), 0);
  const standing = engine({ act: "pause", suspect: true });
  standing.s.outage.begin("another worker's");
  const s2 = await standing.fault(new Error("503"), 0);
  ok(s1.turn.then === "stop" && stoppingPause.s.paused === 0 && stoppingPause.s.errs.length === 0 && stoppingPause.s.back.length === 0 && s2.turn.then === "stop" && standing.s.paused === 0 && standing.s.back.join() === "t1" && !said(standing.s, /; pausing /),
     `a transient error on a stopping pass is not paused for, and joins no outage; one met while another worker's outage stands is not paused for either, and joins it as its suspect (${stoppingPause.s.errs.length} line(s); ${standing.s.errs.join(" | ")})`);

  // A suspect retried alone that errs again (SMD-2641): blamed on a probe made at once.
  const alone = (o: Parameters<typeof engine>[0], before = 0) => {
    const e = engine({ act: "outage", suspect: true, ...o });
    e.s.outage.begin("the first outage", "t1");
    e.s.outage.end();
    for (let k = 0; k < before; k++) {
      e.s.outage.blame("t1", "alone again", false);
      e.s.outage.end();
    }
    return e;
  };
  const aloneUp = alone({ probes: [{ state: "up" }] });
  const au = await aloneUp.fault(new Error("500"));
  ok(au.turn.then === "failed" && au.turn.error === "provider error again with this thought alone in flight, and a one-token call right after answered, so this thought's: 500 (--retry-failed revisits it)" && !au.turn.stopAfter && aloneUp.s.outage.reason === null && aloneUp.s.providerStops === 0,
     `a suspect alone that errs again, the probe made at once answering: its own, no outage (${au.turn.then === "failed" ? au.turn.error : au.turn.then})`);
  const aloneOut = alone({ probes: [{ state: "out", why: "no answer" }] });
  const ao = await aloneOut.fault(new Error("500"));
  ok(ao.turn.then === "stop" && aloneOut.s.outage.reason === "500" && aloneOut.s.back.join() === "t1" && said(aloneOut.s, new RegExp(`t1 goes back to the pool unrecorded — alone in flight, the one-token call after it unanswered \\(1 of ${ALONE_OUTAGES} before it is recorded failed\\), and the follower waits for the provider$`)),
     `…the probe unanswered: an outage it was alone at, counted against it and said (${aloneOut.s.errs.join(" | ")})`);
  const aloneLast = alone({ probes: [{ state: "out", why: "no answer" }] }, ALONE_OUTAGES - 1);
  const al = await aloneLast.fault(new Error("500"));
  ok(al.turn.then === "failed" && al.turn.stopAfter && al.turn.error === `provider error again with this thought alone in flight at ${ALONE_OUTAGES} outages, the one-token call after each unanswered, so this thought's: 500 (--retry-failed revisits it)` && aloneLast.s.outage.reason === "500" && aloneLast.s.providerStops === 1 && aloneLast.s.halt.signal.aborted && aloneLast.s.back.length === 0,
     `…and at the ${ALONE_OUTAGES}rd such outage its own: failed, the outage begun with no suspect set forward, the worker stopping after it (${al.turn.then === "failed" ? al.turn.error : al.turn.then})`);
  const aloneRefused = alone({ probes: [{ state: "refused", why: "bad key" }] });
  const ar = await aloneRefused.fault(new Error("500"));
  const aloneProbed = alone({ probedOut: true });
  const ap = await aloneProbed.fault(new Error("500"));
  ok(ar.turn.then === "stop" && aloneRefused.s.fatal === "a one-token call was refused (bad key), right after 500" && aloneRefused.s.refusedProbes === 1 && aloneRefused.s.outage.reason === null && ap.turn.then === "stop" && aloneProbed.s.probed === 0 && aloneProbed.s.outage.reason === "500",
     `…the probe refused: the request's, no outage; and an engine whose own probe already found no answer is not probed twice (${aloneRefused.s.fatal}; ${aloneProbed.s.probed} probe(s))`);

  // The record of a failure the worker stops after.
  const record = async (o: Parameters<typeof engine>[0], turn: (s: ReturnType<typeof engine>["s"]) => void = () => {}) => {
    const e = engine(o);
    turn(e.s);
    e.s.outage.begin("an outage", "t1");
    e.s.outage.end();
    const hb = { held: new Set(["t1"]), lost: new Set<string>(), beats: 0, consecutiveErrors: 0, claimed: () => {}, stop: () => {} };
    await recordFailedAndStop(e.host, { id: "t1", workerId: "w1", hb, error: "provider error after 3 retries: 503", unrecorded: () => { e.s.unrecorded++; } });
    return { s: e.s, hb };
  };
  const rec = await record({ released: true });
  ok(rec.s.failed === 1 && rec.s.lost === 0 && !rec.hb.held.has("t1") && !rec.s.outage.blames("t1") && rec.s.errs.join(" | ") === "  w1: provider still failing — this worker stops after this thought; the next poll goes on |   t1: provider error after 3 retries: 503",
     `recordFailedAndStop records the failure, counts it, settles the suspect and says both lines (${rec.s.errs.join(" | ")})`);
  const notOurs = await record({ released: false, follow: false });
  ok(notOurs.s.failed === 0 && notOurs.s.lost === 1 && notOurs.s.outage.blames("t1") && notOurs.s.errs.length === 3 && /the claim was no longer this worker's at release; the failure below was not recorded$/.test(notOurs.s.errs[0]) && /re-run when it is back$/.test(notOurs.s.errs[1]),
     `…a claim no longer this worker's is counted lost, said, and the suspect kept; a one-shot run says to re-run (${notOurs.s.errs.join(" | ")})`);
  const beaten = await record({ released: false }, (s) => { s.hardStopped = true; });
  const cut = await record({ released: pg("57P01") });
  const refusedRecord = await record({ released: pg("23514", "check constraint") });
  ok(beaten.s.errs.length === 0 && beaten.s.lost === 0 && cut.hb.held.has("t1") && cut.s.unrecorded === 1 && cut.s.lost === 0 && cut.s.errs.length === 1 && /recording nothing for t1; it returns to the pool when the database answers$/.test(cut.s.errs[0])
     && refusedRecord.s.lost === 1 && /^  t1: could not record the failure \(check constraint\)$/.test(refusedRecord.s.errs[0]) && refusedRecord.s.unrecorded === 0,
     `…the hard stop's release beating it says nothing; the database gone keeps the row this worker's, the engine's count taken back; any other refusal is said and the row counted lost (${cut.s.errs.join(" | ")}; ${refusedRecord.s.errs[0]})`);
}

// ---------------------------------------------------------------------------
// db/claim-loop.ts's setBackAborted and releaseFinished (SMD-4308): a call
// its caller aborted, and a finished claim's release, over a stand-in engine.
// ---------------------------------------------------------------------------
{
  const { setBackAborted, releaseFinished } = await import("./claim-loop.ts");
  const { ProviderOutage, SUSPECT_WINDOW_MS } = await import("./worker-bootstrap.ts");
  const pg = (errno: string, message = `database error ${errno}`) => Object.assign(new Error(message), { name: "PostgresError", errno });
  /** A stand-in engine and database: `setBack` is what the set-back's UPDATE returns, `row` the claim's row a lost read finds, `exists` whether the thought is still there. */
  const engine = (o: { follow?: boolean; limit?: number; setBack?: boolean | Error; row?: string | null; exists?: boolean } = {}) => {
    const s = { errs: [] as string[], hardStopped: false, failed: 0, lost: 0, vanished: 0, progress: 0, statements: [] as string[], outage: new ProviderOutage(() => 0, SUSPECT_WINDOW_MS, true), taken: new Set(["t1", "t2"]) };
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("UPDATE thought_work_claims")) {
        s.statements.push("set-back");
        return o.setBack instanceof Error ? Promise.reject(o.setBack) : Promise.resolve(o.setBack === false ? [] : [{ ok: 1 }]);
      }
      if (text.includes("SELECT EXISTS")) {
        s.statements.push("exists");
        return Promise.resolve([{ exists: o.exists ?? true }]);
      }
      s.statements.push("lost-read");
      return Promise.resolve(o.row == null ? [] : [{ status: o.row, worker_id: null }]);
    }) as unknown as import("bun").SQL;
    const host: import("./claim-loop.ts").ReleaseHost = {
      sql, job: "test:job", follow: o.follow ?? true, err: (l) => s.errs.push(l), hardStopped: () => s.hardStopped, outage: s.outage, limit: o.limit ?? 0, taken: s.taken,
      count: { failed: () => { s.failed++; }, lost: () => { s.lost++; }, vanished: () => { s.vanished++; } }, progress: () => { s.progress++; },
    };
    const hb = { held: new Set(["t1"]), lost: new Set<string>(), beats: 0, consecutiveErrors: 0, claimed: () => {}, stop: () => {} };
    return { s, host, hb, t: { id: "t1", workerId: "w1", hb } };
  };

  // A call the pass's caller aborted: the thought to the back of the queue.
  const back = engine({ limit: 5 });
  const b1 = await setBackAborted(back.host, back.t, "judge call");
  const noLimit = engine();
  await setBackAborted(noLimit.host, noLimit.t, "call");
  ok(JSON.stringify(b1) === "{}" && !back.hb.held.has("t1") && !back.s.taken.has("t1") && back.s.taken.has("t2") && back.s.statements.join() === "set-back" && back.s.errs.length === 0 && noLimit.s.taken.has("t1"),
     `setBackAborted sets the thought back, out of the heartbeat's set, and out of --limit's count where there is a limit (${JSON.stringify(b1)}; taken ${[...back.s.taken].join()}, without a limit ${[...noLimit.s.taken].join()})`);
  const reaped = engine({ limit: 5, setBack: false, row: "pending" });
  const b2 = await setBackAborted(reaped.host, reaped.t, "call");
  const deleted = engine({ setBack: false, row: null });
  const b3 = await setBackAborted(deleted.host, deleted.t, "call");
  ok(b2 !== "stop" && b2.gone === "lost" && reaped.s.taken.has("t1") && reaped.s.statements.join() === "set-back,lost-read" && reaped.s.errs.length === 1 && /^  t1: back in the pool/.test(reaped.s.errs[0]) && b3 !== "stop" && b3.gone === "deleted",
     `…a claim no longer this worker's is not set back: its row is read and said, and it is lost or deleted by what the row says, still in --limit's count (${JSON.stringify(b2)}, ${JSON.stringify(b3)}; ${reaped.s.errs[0]})`);
  const refusedBack = engine({ setBack: pg("57P01") });
  const b4 = await setBackAborted(refusedBack.host, refusedBack.t, "judge call");
  ok(b4 === "stop" && refusedBack.hb.held.has("t1") && refusedBack.s.errs.join() === "  w1: could not set t1 back in the queue after its judge call was aborted (database error 57P01) — this worker stops, returning it with its leases",
     `…and a set-back the database refuses stops the worker, the thought this worker's again, the engine's word for the call in the line (${refusedBack.s.errs.join()})`);

  // The release of a finished claim.
  const finish = async (o: Parameters<typeof engine>[0] & { release?: boolean | Error; failed?: string | null; hardStopped?: boolean }) => {
    const e = engine(o);
    e.s.hardStopped = o.hardStopped ?? false;
    e.hb.held.delete("t1");
    e.s.outage.begin("an outage", "t1");
    e.s.outage.end();
    let succeeded = 0;
    const answer = await releaseFinished(e.host, e.t, {
      release: () => (o.release instanceof Error ? Promise.reject(o.release) : Promise.resolve(o.release ?? true)),
      failed: o.failed ?? null, doing: "judged", lapsedWhy: "its lease lapsed", succeeded: () => { succeeded++; },
    });
    return { answer, succeeded, s: e.s, hb: e.hb };
  };
  const good = await finish({});
  const bad = await finish({ failed: "the judge refused it" });
  ok(good.answer === "next" && good.succeeded === 1 && good.s.failed === 0 && good.s.errs.length === 0 && good.s.progress === 1 && !good.s.outage.blames("t1") && good.s.statements.length === 0
     && bad.answer === "next" && bad.succeeded === 0 && bad.s.failed === 1 && bad.s.errs.join() === "  t1: the judge refused it" && bad.s.progress === 1 && !bad.s.outage.blames("t1"),
     `releaseFinished: a release that went through counts the thought the engine's way when it succeeded, failed and said when it failed, a suspect no longer either way, and the progress line told (${bad.s.errs.join()})`);
  const lapsed = await finish({ release: false, failed: "the judge refused it" });
  const lapsedGood = await finish({ release: false });
  ok(lapsed.answer === "next" && lapsed.s.lost === 1 && lapsed.s.failed === 0 && lapsed.s.progress === 1 && lapsed.s.outage.blames("t1") && lapsed.s.statements.join() === "exists"
     && lapsed.s.errs.join(" | ") === "  t1: the claim was no longer this worker's at release — its lease lapsed; the row is the pool's or another worker's now |   t1: the judge refused it (not recorded — the row was not this worker's)"
     && lapsedGood.s.errs.length === 1 && lapsedGood.succeeded === 0 && lapsedGood.s.lost === 1,
     `…a claim no longer this worker's at release is counted lost, with the engine's reasons, a failure said as not recorded, and the suspect kept (${lapsed.s.errs.join(" | ")})`);
  const goneNow = await finish({ release: false, exists: false });
  const beaten = await finish({ release: false, hardStopped: true });
  ok(goneNow.answer === "next" && goneNow.s.vanished === 1 && goneNow.s.lost === 0 && goneNow.s.progress === 0 && goneNow.s.errs.join() === "  t1: deleted while it was being judged" && beaten.answer === "stop" && beaten.s.errs.length === 0 && beaten.s.lost === 0,
     `…a thought deleted meanwhile is counted so and said in the engine's word; the hard stop's release beating this one stops the worker with nothing said (${goneNow.s.errs.join()}; ${beaten.answer})`);
  const cut = await finish({ release: pg("57P01") });
  const cutOneShot = await finish({ release: pg("57P01"), follow: false });
  const refusedRelease = await finish({ release: pg("42501", "permission denied for function release_thought") });
  ok(cut.answer === "stop" && cut.hb.held.has("t1") && cut.s.errs.join() === "  t1: could not release the claim (database error 57P01) — this worker stops" && cut.s.progress === 0
     && cutOneShot.answer === "stop" && !cutOneShot.hb.held.has("t1") && refusedRelease.answer === "stop" && !refusedRelease.hb.held.has("t1") && /could not release the claim \(permission denied for function release_thought\)/.test(refusedRelease.s.errs[0]),
     `…and a release the database refuses stops the worker with it said; under --follow with the database gone the thought is this worker's again, for the finally to return (${cut.s.errs.join()})`);
}

listener.stop(true);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
