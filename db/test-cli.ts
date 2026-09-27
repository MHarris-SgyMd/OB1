#!/usr/bin/env bun
/**
 * test-cli.ts — the one flag scanner every db/ script reads its arguments
 * through (db/cli.ts, SMD-2134), hermetic.
 *
 * No Postgres, no model, no network. Three parts: the scanner's rules as pure
 * functions; the tree's shape — every db/ entry point imports cli.ts, and no
 * other file reads process.argv; and every entry point run for real with a
 * flag it does not have (exit 2, the flag named) and with --help (exit 0),
 * before any database URL is resolved (SMD-2015: a mistyped flag on a worker
 * ran the shipped default and exited 0). Runs in the fast portable-server job.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandLine, flagList, readNumber, scanArgs, type Args, type FlagSpec } from "./cli.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const SPEC = { url: "one", compare: "two", follow: "optional", ids: "many", query: "repeated", "dry-run": "none" } as const satisfies FlagSpec;
type Name = keyof typeof SPEC;
const scan = (argv: string[], positionals = 0): Args<Name> | { error: string } => scanArgs(argv, SPEC, { positionals });
const refusal = (argv: string[], positionals = 0): string => { const r = scan(argv, positionals); return "error" in r ? r.error : ""; };

// ---------------------------------------------------------------------------
// The scanner, pure.
// ---------------------------------------------------------------------------
{
  const r = scan(["--url", "postgres://h/db", "--compare", "a", "b", "--follow", "--ids", "x", "y", "--query", "q1", "--dry-run", "--query", "q2"]);
  ok(!("error" in r) && r.value("url") === "postgres://h/db" && r.values("compare").join() === "a,b" && r.has("follow") && r.value("follow") === undefined
    && r.values("ids").join() === "x,y" && r.values("query").join() === "q1,q2" && r.value("query") === "q1" && r.has("dry-run"),
    "every kind lands: one, two, optional without its value, many, repeated (in order), none");
  const empty = scan([]);
  ok(!("error" in empty) && !empty.has("url") && empty.value("url") === undefined && empty.values("ids").length === 0, "no argument: nothing is had, nothing has a value");
  const opt = scan(["--follow", "30"]);
  ok(!("error" in opt) && opt.value("follow") === "30", "an optional flag takes the next argument when it is not a flag");
  const noIds = scan(["--ids", "--dry-run"]);
  ok(!("error" in noIds) && noIds.has("ids") && noIds.values("ids").length === 0 && noIds.has("dry-run"), "a many flag may take none, and stops at the next flag");

  ok(/^unknown argument: --bogus$/.test(refusal(["--bogus"])), "a flag the spec does not have is refused by name");
  ok(/^unknown argument: --URL$/.test(refusal(["--URL", "x"])), "…case and all: --URL is not --url");
  ok(/^--url given twice$/.test(refusal(["--url", "a", "--url", "b"])), "a one-value flag given twice is refused (a lookup would read the first)");
  ok(/^--dry-run given twice$/.test(refusal(["--dry-run", "--dry-run"])), "…a switch too");
  ok(/^--ids given twice$/.test(refusal(["--ids", "a", "--ids", "b"])), "…and a many flag, whose second list would be dropped");
  ok(refusal(["--query", "a", "--query", "b"]) === "", "a repeated flag is not refused for repeating");
  ok(/^--url needs a value; what follows it is nothing$/.test(refusal(["--url"])), "a one-value flag at the end is refused");
  ok(/^--url needs a value; what follows it is --dry-run$/.test(refusal(["--url", "--dry-run"])), "…and one followed by a flag, which is not read as the value");
  ok(/^--url is empty/.test(refusal(["--url", ""])), "an empty value is refused, not read as the flag absent");
  ok(/^--follow is empty/.test(refusal(["--follow", ""])), "…an optional flag's too");
  ok(/^--query is empty/.test(refusal(["--query", "a", "--query", ""])), "…and a repeated flag's");
  ok(/^--compare needs two values; what follows it is --dry-run$/.test(refusal(["--compare", "a", "--dry-run"])), "a two-value flag with one value is refused");
  ok(/^--compare needs two values; what follows it is nothing$/.test(refusal(["--compare"])), "…and with none");
  const joined = refusal(["--url=postgres://u:s3cret@h/db"]);
  ok(/^unknown argument: --url=… \(a value joined with "="; give it as --url <value>\)$/.test(joined) && !joined.includes("s3cret"), "a value joined with = is named by its flag and never echoed");
  ok(/^unknown argument: --nope=…/.test(refusal(["--nope=1"])), "…a flag the spec does not have, likewise");
  ok(/^unknown argument: stray \(a value where no flag takes one\)$/.test(refusal(["stray"])), "a value where no flag takes one is refused");
  ok(/^unknown argument: <a URL> \(a value where no flag takes one\)$/.test(refusal(["postgres://u:s3cret@h/db"])), "…a bare URL shown by its shape, never echoed");
  ok(/^unknown argument: b c \(values where no flag takes one\)$/.test(refusal(["--ids", "a", "--dry-run", "b", "c"])), "…every stray value named, the ids after another flag among them");
  ok(/^unknown argument: -- /.test(refusal(["--"])), "a bare -- is not a flag and not silently a separator");
  const two = scan(["x", "--dry-run", "y"], 2);
  ok(!("error" in two) && two.positionals.join() === "x,y", "declared positionals are kept, in order, around flags");
  ok(/^unknown argument: z/.test(refusal(["x", "y", "z"], 2)), "…and one more than declared is refused");
  ok(refusal(["--url", "-1"]) === "" && refusal(["--url", "-"]) === "", "a value beginning with one dash is a value (a negative number, stdin)");

  ok(flagList(SPEC) === "  flags: --url <value>, --compare <a> <b>, --follow [value], --ids <value> …, --query <value> (repeatable), --dry-run", "the flag list shows what each flag takes");
  ok(flagList({ url: "one", force: "none" }, { url: "<postgres://…>", force: "(with --baseline)" }) === "  flags: --url <postgres://…>, --force (with --baseline)", "…with a script's hints");
  ok(flagList({}) === "  flags: none", "…and says none for a script that takes none");
}

// ---------------------------------------------------------------------------
// Numbers: decimal digits only.
// ---------------------------------------------------------------------------
{
  const int = (raw: string, min = 1, max?: number) => readNumber("--n", raw, { min, max });
  const num = (raw: string, min = -1, max = 1) => readNumber("--n", raw, { min, max, fraction: true });
  ok(int("7") === 7 && int("500", 1, 500) === 500 && int("-3", -5) === -3, "an integer in range reads as itself");
  for (const raw of ["0x10", "1e2", " 7", "7 ", "7.0", "7.", "+7", "", "Infinity", "NaN", "1_000"]) {
    const r = int(raw);
    ok(typeof r !== "number" && /must be a decimal integer >= 1/.test(r.error), `an integer flag refuses ${JSON.stringify(raw)} — Number() would read some of these`);
  }
  ok(typeof int("0") !== "number" && typeof int("501", 1, 500) !== "number", "…and one out of range");
  ok(/must be a decimal integer >= 1 and <= 500, got "501"/.test((int("501", 1, 500) as { error: string }).error), "…saying the range and what it got");
  ok(num("0.5") === 0.5 && num("-0.5") === -0.5 && num(".5") === 0.5 && num("1") === 1 && num("0.") === 0, "a fraction flag reads decimals, signed");
  for (const raw of ["1e-1", "0x1", " .5", "1.5", "-1.5", ".", "-"]) ok(typeof num(raw) !== "number", `a fraction flag refuses ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// commandLine's typed reads, the paths that do not exit.
// ---------------------------------------------------------------------------
{
  const spec = { follow: "optional", limit: "one", k: "one", "min-sim": "one" } as const;
  const cl = (argv: string[]) => commandLine("x.ts", spec, {}, argv);
  ok(cl([]).int("follow", { absent: 0, bare: 15, min: 1 }) === 0, "an absent optional flag reads as its absent value");
  ok(cl(["--follow"]).int("follow", { absent: 0, bare: 15, min: 1 }) === 15, "…given bare, as its bare value");
  ok(cl(["--follow", "30"]).int("follow", { absent: 0, bare: 15, min: 1 }) === 30, "…given a value, as the value");
  ok(cl(["--k", "50"]).int("k", { absent: 10, min: 1, max: 50 }) === 50 && cl([]).int("k", { absent: 10, min: 1, max: 50 }) === 10, "a one-value integer reads its value or its absent value");
  ok(cl(["--min-sim", "-0.25"]).number("min-sim", { absent: 0.8, min: -1, max: 1, fraction: true }) === -0.25, "a fraction reads, negative included");
}

// ---------------------------------------------------------------------------
// The tree: every entry point goes through cli.ts, and nothing else reads argv.
// ---------------------------------------------------------------------------
const HERE = import.meta.dir;
const sources = readdirSync(HERE).filter((f) => /\.ts$/.test(f) && !/^test-/.test(f)).sort();
/**
 * A file run as a script: one with an `import.meta.main` guard, or a top-level
 * script — a shebang and nothing exported (a library with a shebang, as
 * brain-compare.ts has, exports what its caller runs).
 */
const entries = sources.filter((f) => {
  const text = readFileSync(join(HERE, f), "utf8");
  return /import\.meta\.main/.test(text) || (text.startsWith("#!") && !/^export /m.test(text));
});
{
  ok(entries.length >= 20, `the entry-point census finds the scripts (${entries.length}: ${entries.join(", ")})`);
  for (const must of ["extract-entities.ts", "consolidate.ts", "reembed.ts", "migrate.ts", "tier.ts", "sync-linear.ts", "graph-centrality.ts", "bench-hnsw.ts"])
    ok(entries.includes(must), `the census counts ${must} as an entry point`);
  for (const lib of ["cli.ts", "lease.ts", "env.ts", "brain-compare.ts", "ingest-contract.ts", "bench-oracle.ts"])
    ok(!entries.includes(lib), `the census does not count the library ${lib}`);
  for (const f of entries) ok(/from "\.\/cli\.ts"/.test(readFileSync(join(HERE, f), "utf8")), `${f} imports ./cli.ts`);
  for (const f of sources.filter((s) => s !== "cli.ts"))
    ok(!/process\.argv/.test(readFileSync(join(HERE, f), "utf8")), `${f} reads no process.argv of its own — its arguments go through cli.ts`);
}

// ---------------------------------------------------------------------------
// Every entry point, run: a flag it does not have is refused before anything
// else happens, and --help lists what it takes.
// ---------------------------------------------------------------------------
{
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "DATABASE_URL") env[k] = v;
  env.OB1_ENV_FILES = "off";
  const run = (script: string, ...argv: string[]) => {
    const child = Bun.spawnSync(["bun", "--no-env-file", script, ...argv], { cwd: HERE, env });
    return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
  };
  for (const f of entries) {
    const bogus = run(f, "--bogus-flag");
    ok(bogus.code === 2 && bogus.err.split("\n")[0] === "unknown argument: --bogus-flag", `${f} refuses a flag it does not have, first thing, exit 2 (exit ${bogus.code}: ${bogus.err.split("\n")[0].slice(0, 100)})`);
    const help = run(f, "--help");
    ok(help.code === 0 && /usage/.test(help.out), `${f} --help lists what it takes, exit 0 (exit ${help.code}: ${(help.out || help.err).split("\n")[0].slice(0, 100)})`);
  }
  // The SMD-2015 shapes, on the two workers it named: a typo of a real flag.
  const typo = run("consolidate.ts", "--K", "10");
  ok(typo.code === 2 && /^unknown argument: --K$/m.test(typo.err) && /--k <value>/.test(typo.err), `consolidate.ts refuses --K for --k and lists --k (exit ${typo.code})`);
  const minsim = run("consolidate.ts", "--minsim", "0.5");
  ok(minsim.code === 2 && /^unknown argument: --minsim$/m.test(minsim.err), `consolidate.ts refuses --minsim for --min-sim (exit ${minsim.code})`);
  const workers = run("extract-entities.ts", "--worker", "4");
  ok(workers.code === 2 && /^unknown argument: --worker$/m.test(workers.err), `extract-entities.ts refuses --worker for --workers (exit ${workers.code})`);
  // A URL nothing listens on: the numbers are read after the URL is resolved and before it is dialled.
  const hex = run("extract-entities.ts", "--url", "postgres://127.0.0.1:1/none", "--workers", "0x10");
  ok(hex.code === 2 && /--workers must be a decimal integer >= 1, got "0x10"/.test(hex.err), `extract-entities.ts refuses a hex --workers, which Number() read as 16 (exit ${hex.code})`);
  const dump = run("extract-entities.ts", "--dump");
  ok(dump.code === 2 && /^--dump needs a value/m.test(dump.err), `extract-entities.ts refuses a bare --dump, which read as no dump (exit ${dump.code})`);
  // Past the scanner, a well-formed command reaches the script's own first need.
  const reached = run("extract-entities.ts", "--workers", "1", "--dry-run");
  ok(reached.code === 2 && /No database URL/.test(reached.err), `a command the scanner accepts reaches the script's own first check (exit ${reached.code}: ${reached.err.split("\n")[0]})`);
}

console.log(`\ntest-cli: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
