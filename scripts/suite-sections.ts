#!/usr/bin/env bun
/**
 * suite-sections.ts — a suite's bracketed sections by wall time, slowest first (SMD-3305).
 *
 * The fork's suites print each section's header as a line that starts with a bracketed number or name ("[12] The
 * REST core's spans …", "[8e2] …", "[file]", "[where the key may travel]"); a suite that prints none
 * (db/test-cli.ts) reads as one "(start)" span, which the output says. This runs a suite, stamps each stdout line as
 * it arrives, and gives each section the time from its header to the next one's; the time from the launch to the first
 * header is "(start)". It prints the suite's tally line, then the sections slowest first, then the total. What to cut
 * in a suite starts here: SMD-3263 found test-rest's [12] at 38 of its 44 s this way. The times are only as good as
 * the child's flushing: Bun flushes each line, but a child that buffers its stdout (python3 writing to a pipe) hands
 * every line over at its end, so all the time reads as (start) and every section as 0 s. Work a suite runs across
 * sections (test-rest's [16] probes start at import) counts toward whichever sections are printing while it runs.
 *
 *   bun scripts/suite-sections.ts --cwd server-portable -- bun test-rest.ts
 *   bun scripts/suite-sections.ts --top 3 --cwd server-portable -- ../db/with-postgres.sh bun test-egress.ts
 *   bun scripts/suite-sections.ts --self-check        # the section reading, on fixtures
 *
 * Options (before the command):
 *   --top <n>     how many sections to print, default 8 (0: all)
 *   --cwd <dir>   where the command runs, default the current directory
 * The command follows, after `--` or from the first word that is not an option (Bun drops a `--` that comes first,
 * so `bun scripts/suite-sections.ts -- bun test-rest.ts` reaches this as `bun test-rest.ts`). Its stderr passes
 * through as it comes; its exit code is this script's.
 */

const KNOWN: Record<string, "value" | "flag"> = { "--top": "value", "--cwd": "value", "--self-check": "flag" };
type Opts = { error?: string; command: string[]; [name: string]: string | true | string[] | undefined };

/**
 * Options first, then the command: after `--`, or from the first word that does not start with `--`. A word that
 * starts with `--` and is no option is refused, so a misspelt option is never run as a command.
 */
export function parseArgs(argv: string[]): Opts {
  const out: Opts = { command: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      out.command = argv.slice(i + 1);
      return out;
    }
    if (!tok.startsWith("--")) {
      out.command = argv.slice(i);
      return out;
    }
    const eq = tok.indexOf("=");
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const kind = KNOWN[name];
    if (!kind) return { error: `unknown option ${tok}; known: ${Object.keys(KNOWN).join(" ")}, then the command`, command: [] };
    if (kind === "flag") {
      if (eq > 0) return { error: `${name} takes no value`, command: [] };
      out[name] = true;
      continue;
    }
    const value = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value`, command: [] };
    out[name] = value;
  }
  return out;
}

/**
 * A section header: a line that starts with a bracketed number or name, "[12]", "[8e2]", "[file]", however long, its
 * closing bracket followed by a space or the line's end; not one indented, unclosed, empty or space-led (`[ 1, 2 ]`,
 * an array printed raw).
 */
const HEADER = /^\[[^\]\s][^\]]*\](?=\s|$)/;
/** The suites' tally line ("480 assertions: 480 passed, 0 failed", or "test-cli: 452 passed, 0 failed"). */
const TALLY = /\d+ assertions:|\d+ passed, \d+ failed/;

/**
 * A stream's lines, each stamped with the arrival of the chunk it began in, the last one too when no newline ends it.
 * `chunks` is what arrived, decoded, with its time since the launch.
 */
export function toLines(chunks: { at: number; text: string }[]): { at: number; text: string }[] {
  const lines: { at: number; text: string }[] = [];
  let rest = "", restAt = 0;
  for (const c of chunks) {
    if (rest === "") restAt = c.at;
    const parts = (rest + c.text).split("\n");
    rest = parts.pop() ?? "";
    for (const [i, text] of parts.entries()) lines.push({ at: i === 0 ? restAt : c.at, text });
    if (parts.length) restAt = c.at;
  }
  if (rest) lines.push({ at: restAt, text: rest });
  return lines;
}

/** Each section's seconds, from its header's arrival to the next header's or the end; "(start)" from the launch on. */
export function sections(lines: { at: number; text: string }[], end: number): { name: string; s: number }[] {
  const out: { name: string; s: number }[] = [];
  let name = "(start)";
  let from = 0;
  for (const l of lines) {
    if (!HEADER.test(l.text)) continue;
    out.push({ name, s: (l.at - from) / 1000 });
    name = l.text.trim();
    from = l.at;
  }
  out.push({ name, s: (end - from) / 1000 });
  // A (start) under 50 ms is the spawn itself, not a span worth a row.
  return out.filter((sec) => sec.name !== "(start)" || sec.s >= 0.05);
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
  const bare = parseArgs(["bun", "test-rest.ts"]), lead = parseArgs(["--cwd", "db", "bun", "test-cli.ts"]);
  ok(bare.command.join(" ") === "bun test-rest.ts" && lead["--cwd"] === "db" && lead.command.join(" ") === "bun test-cli.ts", "with no --, the command starts at the first word that is not an option (Bun drops a leading --)");
  const got = sections([
    { at: 0, text: "[1] Every tool has one route" },
    { at: 500, text: "  ✓ a row" },
    { at: 2_000, text: "[12] The REST core's spans" },
    { at: 11_000, text: "[16a] tierProblem" },
    { at: 11_500, text: "480 assertions: 480 passed, 0 failed" },
  ], 12_000);
  ok(got.map((s) => `${s.name.slice(0, 4)}=${s.s}`).join(" ") === "[1] =2 [12]=9 [16a=1", "each section from its header to the next, the last to the end; no empty (start)");
  const early = sections([{ at: 1_000, text: "preamble" }, { at: 3_000, text: "[1] first" }], 4_000);
  ok(early[0].name === "(start)" && early[0].s === 3 && early[1].s === 1, "the launch to the first header is (start), the time before any output included");
  ok(HEADER.test("[13d] a lettered section") && HEADER.test("[8e2] two levels") && HEADER.test("[where the key may travel]"), "a bracketed number, a lettered one or a name heads a section");
  ok(HEADER.test(`[${"a Host the URL parser refuses, ".repeat(5)}(SMD-2595)]`), "a name of any length (test-auth's run past 120 characters)");
  ok(!HEADER.test("  [12] indented") && !HEADER.test("[12 unclosed") && !HEADER.test("[] empty") && !HEADER.test("[ spaced]") && !HEADER.test("[1,2]x"), "not an indented, unclosed, empty or space-led bracket, nor one run into the next word");
  ok(TALLY.test("480 assertions: 480 passed, 0 failed") && TALLY.test("test-cli: 452 passed, 0 failed"), "both tally forms read");
  const joined = toLines([{ at: 0, text: "[1] a\n[2" }, { at: 800, text: "] b\n" }, { at: 1_600, text: "[3] c" }]);
  ok(joined.map((l) => `${l.text}@${l.at}`).join(" ") === "[1] a@0 [2] b@0 [3] c@1600", "a line split across chunks takes the time it began; a last line with no newline, its own");
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
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(opts.command, { cwd: typeof opts["--cwd"] === "string" ? opts["--cwd"] : undefined, stdout: "pipe", stderr: "inherit" });
  } catch (e) {
    refuse(`cannot run ${opts.command[0]}${typeof opts["--cwd"] === "string" ? ` in ${opts["--cwd"]}` : ""}: ${(e as Error).message}`);
  }
  const chunks: { at: number; text: string }[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) chunks.push({ at: performance.now() - t0, text: decoder.decode(chunk, { stream: true }) });
  chunks.push({ at: performance.now() - t0, text: decoder.decode() });
  const lines = toLines(chunks);
  const code = await proc.exited;
  const end = performance.now() - t0;
  for (const l of lines) if (TALLY.test(l.text)) console.log(l.text.trim());
  if (!lines.some((l) => HEADER.test(l.text))) console.log("  no bracketed section header in its output: one (start) span");
  const ranked = sections(lines, end).sort((x, y) => y.s - x.s);
  for (const sec of top ? ranked.slice(0, top) : ranked) console.log(`${sec.s.toFixed(1).padStart(7)} s  ${sec.name.slice(0, 110)}`);
  console.log(`  total ${(end / 1000).toFixed(1)} s${code ? `, exit ${code}` : ""}`);
  process.exit(code);
}
