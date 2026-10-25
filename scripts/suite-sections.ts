#!/usr/bin/env bun
/**
 * suite-sections.ts — a suite's numbered sections by wall time, slowest first (SMD-3305).
 *
 * The fork's suites print each section's header as a line that starts with its number in brackets ("[12] The REST
 * core's spans …"). This runs a suite, stamps each stdout line as it arrives, and gives each section the time from
 * its header to the next one's (the first span, before any header, is "(start)"). It prints the suite's tally line,
 * then the sections slowest first, then the total. What to cut in a suite starts here: SMD-3263 found test-rest's
 * [12] at 38 of its 44 s this way.
 *
 *   bun scripts/suite-sections.ts --cwd server-portable -- bun test-rest.ts
 *   bun scripts/suite-sections.ts --top 3 --cwd server-portable -- ../db/with-postgres.sh bun test-egress.ts
 *   bun scripts/suite-sections.ts --self-check        # the section reading, on fixtures
 *
 * Options, before `--`:
 *   --top <n>     how many sections to print, default 8 (0: all)
 *   --cwd <dir>   where the command runs, default the current directory
 * Everything after `--` is the command. Its stderr passes through as it comes; its exit code is this script's.
 */

const KNOWN: Record<string, "value" | "flag"> = { "--top": "value", "--cwd": "value", "--self-check": "flag" };
type Opts = { error?: string; command: string[]; [name: string]: string | true | string[] | undefined };

/** Options up to `--`, the command after it; anything unknown before `--` is refused. */
export function parseArgs(argv: string[]): Opts {
  const out: Opts = { command: [] };
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  out.command = end < 0 ? [] : argv.slice(end + 1);
  for (let i = 0; i < own.length; i++) {
    const tok = own[i];
    const eq = tok.indexOf("=");
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const kind = KNOWN[name];
    if (!kind) return { error: `unknown option ${tok}; known: ${Object.keys(KNOWN).join(" ")}, then -- and the command`, command: [] };
    if (kind === "flag") {
      if (eq > 0) return { error: `${name} takes no value`, command: [] };
      out[name] = true;
      continue;
    }
    const value = eq > 0 ? tok.slice(eq + 1) : own[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value`, command: [] };
    out[name] = value;
  }
  return out;
}

/** A section header: a line that starts with a bracketed section number, "[12]", "[13d]", "[16a]". */
const HEADER = /^\[\d{1,3}[a-z]{0,2}\]/;
/** The suites' tally line ("480 assertions: 480 passed, 0 failed", or "test-cli: 452 passed, 0 failed"). */
const TALLY = /\d+ assertions:|\d+ passed, \d+ failed/;

/** Each section's seconds, from its header's arrival to the next header's or the end; "(start)" before the first. */
export function sections(lines: { at: number; text: string }[], end: number): { name: string; s: number }[] {
  const out: { name: string; s: number }[] = [];
  let name = "(start)";
  let from = lines.length ? Math.min(lines[0].at, end) : end;
  for (const l of lines) {
    if (!HEADER.test(l.text)) continue;
    out.push({ name, s: (l.at - from) / 1000 });
    name = l.text.trim();
    from = l.at;
  }
  out.push({ name, s: (end - from) / 1000 });
  return out.filter((sec) => sec.name !== "(start)" || sec.s > 0);
}

function refuse(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function selfCheck(): number {
  let failed = 0;
  const ok = (cond: boolean, what: string) => {
    if (!cond) failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const a = parseArgs(["--top", "3", "--cwd=server-portable", "--", "bun", "test-rest.ts", "--x"]);
  ok(a["--top"] === "3" && a["--cwd"] === "server-portable" && a.command.join(" ") === "bun test-rest.ts --x", "options before --, the command after, its own flags untouched");
  ok(!!parseArgs(["--tops", "3", "--", "bun"]).error && !!parseArgs(["--top"]).error, "an unknown option and a missing value are refused");
  const got = sections([
    { at: 0, text: "[1] Every tool has one route" },
    { at: 500, text: "  ✓ a row" },
    { at: 2_000, text: "[12] The REST core's spans" },
    { at: 11_000, text: "[16a] tierProblem" },
    { at: 11_500, text: "480 assertions: 480 passed, 0 failed" },
  ], 12_000);
  ok(got.map((s) => `${s.name.slice(0, 4)}=${s.s}`).join(" ") === "[1] =2 [12]=9 [16a=1", "each section from its header to the next, the last to the end; no empty (start)");
  const early = sections([{ at: 1_000, text: "preamble" }, { at: 3_000, text: "[1] first" }], 4_000);
  ok(early[0].name === "(start)" && early[0].s === 2 && early[1].s === 1, "lines before the first header are (start)");
  ok(!HEADER.test("  [12] indented") && HEADER.test("[13d] a lettered section") && TALLY.test("test-cli: 452 passed, 0 failed"), "headers start the line; both tally forms read");
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) refuse(opts.error);
  if (opts["--self-check"]) process.exit(selfCheck());
  if (opts.command.length === 0) refuse("usage: bun scripts/suite-sections.ts [--top n] [--cwd dir] -- <command …>");
  const top = Number(opts["--top"] ?? 8);
  if (!Number.isInteger(top) || top < 0) refuse(`--top takes a whole number, got ${opts["--top"]}`);
  const t0 = performance.now();
  const proc = Bun.spawn(opts.command, { cwd: typeof opts["--cwd"] === "string" ? opts["--cwd"] : undefined, stdout: "pipe", stderr: "inherit" });
  const lines: { at: number; text: string }[] = [];
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of proc.stdout) {
    const at = performance.now() - t0;
    const parts = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = parts.pop() ?? "";
    for (const text of parts) lines.push({ at, text });
  }
  if (rest) lines.push({ at: performance.now() - t0, text: rest });
  const code = await proc.exited;
  const end = performance.now() - t0;
  for (const l of lines) if (TALLY.test(l.text)) console.log(l.text.trim());
  const ranked = sections(lines, end).sort((x, y) => y.s - x.s);
  for (const sec of top ? ranked.slice(0, top) : ranked) console.log(`${sec.s.toFixed(1).padStart(7)} s  ${sec.name.slice(0, 110)}`);
  console.log(`  total ${(end / 1000).toFixed(1)} s${code ? `, exit ${code}` : ""}`);
  process.exit(code);
}
