#!/usr/bin/env bun
/**
 * test-cli.ts — the one flag scanner every db/ script reads its arguments
 * through (db/cli.ts, SMD-2134), hermetic.
 *
 * No Postgres, no model, no network. Three parts: the scanner's rules as pure
 * functions, a refusal never repeating what was typed among them; the tree's
 * shape — every db/ entry point imports cli.ts, and no other file reads
 * process.argv; and every entry point run for real with a flag it does not
 * have (exit 2) and with --help (exit 0), before any database URL is resolved
 * (SMD-2015: a mistyped flag on a worker ran the shipped default and exited 0).
 * Runs in the fast portable-server job.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandLine, flagList, readNumber, scanArgs, type Args, type FlagSpec } from "./cli.ts";
import { parseArgs as graphArgs } from "./graph-centrality.ts";

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

  ok(/^unknown argument 1: not a flag this script has$/.test(refusal(["--bogus"])), "a flag the spec does not have is refused by position");
  ok(/^unknown argument 3: not a flag this script has$/.test(refusal(["--dry-run", "--ids", "--URL", "x"])), "…case and all: --URL is not --url");
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) ok(/^unknown argument 1:/.test(refusal([`--${name}`])), `--${name}, a name every object answers to, is not a flag`);
  ok(/^--url given twice$/.test(refusal(["--url", "a", "--url", "b"])), "a one-value flag given twice is refused (a lookup would read the first)");
  ok(/^--dry-run given twice$/.test(refusal(["--dry-run", "--dry-run"])), "…a switch too");
  ok(/^--ids given twice$/.test(refusal(["--ids", "a", "--ids", "b"])), "…a many flag, whose second list would be dropped");
  ok(/^--follow given twice$/.test(refusal(["--follow", "5", "--follow", "6"])), "…an optional flag");
  ok(/^--compare given twice$/.test(refusal(["--compare", "a", "b", "--compare", "c", "d"])), "…and a two-value flag");
  ok(refusal(["--query", "a", "--query", "b"]) === "", "a repeated flag is not refused for repeating");
  ok(/^--url needs a value; nothing follows it$/.test(refusal(["--url"])), "a one-value flag at the end is refused");
  ok(/^--url needs a value; a flag follows it$/.test(refusal(["--url", "--dry-run"])), "…and one followed by a flag, which is not read as the value");
  for (const blank of ["", " ", "\t"]) {
    ok(/^--url is empty; give it a value$/.test(refusal(["--url", blank])), `a blank value (${JSON.stringify(blank)}) is refused, not read as the flag absent`);
    ok(/^--follow is empty/.test(refusal(["--follow", blank])), `…an optional flag's too (${JSON.stringify(blank)})`);
    ok(/^--query is empty/.test(refusal(["--query", "a", "--query", blank])), `…a repeated flag's (${JSON.stringify(blank)})`);
    ok(/^one of --ids's values is empty$/.test(refusal(["--ids", "a", blank])), `…a many flag's (${JSON.stringify(blank)})`);
    ok(/^--compare is empty; give it two values$/.test(refusal(["--compare", "a", blank])), `…and a two-value flag's second (${JSON.stringify(blank)})`);
  }
  ok(/^--compare needs two values; a flag follows it$/.test(refusal(["--compare", "a", "--dry-run"])), "a two-value flag with one value is refused");
  ok(/^--compare needs two values; nothing follows it$/.test(refusal(["--compare"])), "…and with none");
  ok(/^argument 1 joins a value to --url with "="; give it as --url <value>$/.test(refusal(["--url=x"])), "a value joined with = to a flag that takes one: give it as the next argument");
  ok(/^argument 1 joins a value to --follow with "="/.test(refusal(["--follow=30"])) && /^argument 1 joins a value to --ids with "="/.test(refusal(["--ids=x"])) && /^argument 1 joins a value to --compare with "="/.test(refusal(["--compare=a"])),
    "…to an optional, many or two-value flag likewise — each takes a value, so none is told it takes none");
  ok(/^argument 1 gives --dry-run a value with "=", and --dry-run takes none$/.test(refusal(["--dry-run=1"])), "…to a switch: it takes none");
  ok(/^unknown argument 2: a flag this script does not have, with a value joined by "="$/.test(refusal(["--dry-run", "--rul=x"])), "…to a flag the spec does not have, by position");
  ok(/^unknown argument 1: a value where no flag takes one$/.test(refusal(["stray"])), "a value where no flag takes one is refused by position");
  ok(/^unknown arguments 4 and 5: values where no flag takes one$/.test(refusal(["--ids", "a", "--dry-run", "b", "c"])), "…every stray value's position, the ids after another flag among them");
  ok(/^unknown arguments 1, 3 and 4: values where no flag takes one$/.test(refusal(["a", "--dry-run", "b", "c"])), "…three of them listed, the last after \"and\"");
  const dashes = scan(["--ids", "-1", "-", "--follow", "-"]);
  ok(!("error" in dashes) && dashes.values("ids").join() === "-1,-" && dashes.value("follow") === "-", "a many or optional flag takes a value beginning with one dash, as a one-value flag does");
  ok(/^unknown argument 2: a bare "--"/.test(refusal(["x", "--"], Infinity)), "a bare -- is refused, not read as a separator — even where positionals are declared, so it never becomes graph-centrality's subject");
  const two = scan(["x", "--dry-run", "y"], 2);
  ok(!("error" in two) && two.positionals.join() === "x,y", "declared positionals are kept, in order, around flags");
  ok(/^unknown argument 4: a value where/.test(refusal(["x", "--dry-run", "y", "z"], 2)), "…and one more than declared is refused at its position");
  ok(refusal(["--url", "-1"]) === "" && refusal(["--url", "-"]) === "", "a value beginning with one dash is a value (a negative number, stdin)");

  // The rule the three leaks of review passes 1 and 2 broke: a refusal never
  // repeats an argument. Every shape an operator can put a secret in.
  const SECRET = "s3cret-not-a-real-key";
  const leaks: string[][] = [
    [`--url=postgres://u:${SECRET}@h/db`], [`--nope=${SECRET}`], [`--url${SECRET}`], [`--a-key${SECRET}`], [`--${SECRET}`],
    [SECRET], [`OB1_KEY=${SECRET}`], [`host=h password=${SECRET}`], [`postgres://u:${SECRET}@h/db`],
    ["--url", `--x=${SECRET}`], ["--url", `--${SECRET}`], ["--compare", "a", `--${SECRET}`], ["--ids", "a", "--dry-run", SECRET],
    ["--url", "a", "--dry-run", `--dry-run=${SECRET}`], ["x", "--", SECRET],
  ];
  for (const argv of leaks) {
    const said = refusal(argv);
    ok(said !== "" && !said.includes(SECRET) && !said.includes("s3cret"), `refused without repeating what was typed: ${JSON.stringify(argv).replaceAll(SECRET, "<secret>")} → ${said.replaceAll(SECRET, "<LEAKED>")}`);
  }
  // …and graph-centrality's own checks of a value it takes as-is (review pass 3).
  for (const argv of [["--types", SECRET], ["--types", `topic,${SECRET}`], ["--status", SECRET], [`postgres://u:${SECRET}@h/db`, "Open Brain"]]) {
    const r = graphArgs(argv);
    ok("error" in r && !r.error.includes(SECRET), `graph-centrality refuses ${JSON.stringify(argv).replaceAll(SECRET, "<secret>")} naming what is allowed, not what was given`);
  }
  const three = graphArgs(["a", "b", "c"]);
  ok("error" in three && /one subject at a time; got 3/.test(three.error), "graph-centrality counts three subjects as three");

  ok(flagList(SPEC) === "  flags: --url <value>, --compare <a> <b>, --follow [value], --ids <value> …, --query <value> (repeatable), --dry-run", "the flag list shows what each flag takes");
  ok(flagList({ url: "one", force: "none", query: "repeated" }, { url: "<postgres://…>", force: "(with --baseline)", query: "<q>" }) === "  flags: --url <postgres://…>, --force (with --baseline), --query <q> (repeatable)", "…with a script's hints, a repeated flag still said to repeat");
  ok(flagList({}) === "  flags: none", "…and says none for a script that takes none");
}

// ---------------------------------------------------------------------------
// Numbers: decimal digits only.
// ---------------------------------------------------------------------------
{
  const int = (raw: string, min = 1, max?: number) => readNumber("--n", raw, { min, max });
  const num = (raw: string, min = -1, max = 1) => readNumber("--n", raw, { min, max, fraction: true });
  ok(int("7") === 7 && int("500", 1, 500) === 500 && int("-3", -5) === -3, "an integer in range reads as itself");
  ok(int("1", 1) === 1 && int("10", 10) === 10 && num("-1") === -1 && num("1") === 1, "…the bounds included");
  for (const raw of ["0x10", "1e2", " 7", "7 ", "7.0", "7.", "+7", "", "Infinity", "NaN", "1_000"]) {
    const r = int(raw);
    ok(typeof r !== "number" && /must be a decimal integer >= 1/.test(r.error), `an integer flag refuses ${JSON.stringify(raw)} — Number() would read some of these`);
  }
  ok(typeof int("0") !== "number" && typeof int("501", 1, 500) !== "number", "…and one out of range");
  ok((int("501", 1, 500) as { error: string }).error === "--n must be a decimal integer >= 1 and <= 500", "…saying the range, not repeating the value");
  ok(int("9007199254740991") === 9007199254740991, "the largest exact integer reads");
  const big = int("9007199254740993");
  ok(typeof big !== "number" && /too large to read exactly/.test(big.error), "…one past it is refused, not rounded to 9007199254740992");
  ok(/<= 500$/.test((int("99999999999999999999", 1, 500) as { error: string }).error) && /must be a decimal integer >= 1$/.test((int("-9007199254740993") as { error: string }).error), "…but a value out of the flag's own range is told the range first");
  ok(num("0.5") === 0.5 && num("-0.5") === -0.5 && num(".5") === 0.5 && num("0.") === 0, "a fraction flag reads decimals, signed");
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
  /** A URL nothing listens on: numbers are read after the URL is resolved and before it is dialled. */
  const DEAD = "postgres://127.0.0.1:1/none";
  for (const f of entries) {
    const bogus = run(f, "--bogus-flag");
    ok(bogus.code === 2 && bogus.err.split("\n")[0] === "unknown argument 1: not a flag this script has", `${f} refuses a flag it does not have, first thing, exit 2 (exit ${bogus.code}: ${bogus.err.split("\n")[0].slice(0, 100)})`);
    const help = run(f, "--help");
    ok(help.code === 0 && /usage/.test(help.out), `${f} --help lists what it takes, exit 0 (exit ${help.code}: ${(help.out || help.err).split("\n")[0].slice(0, 100)})`);
  }
  // The SMD-2015 shapes, on the two workers it named: a typo of a real flag, refused with the list that has the real one.
  const typo = run("consolidate.ts", "--K", "10");
  ok(typo.code === 2 && /^unknown argument 1: not a flag this script has$/m.test(typo.err) && /--k <value>/.test(typo.err), `consolidate.ts refuses --K and lists --k (exit ${typo.code})`);
  const minsim = run("consolidate.ts", "--minsim", "0.5");
  ok(minsim.code === 2 && /^unknown argument 1:/m.test(minsim.err) && /--min-sim <value>/.test(minsim.err), `consolidate.ts refuses --minsim and lists --min-sim (exit ${minsim.code})`);
  const workers = run("extract-entities.ts", "--worker", "4");
  ok(workers.code === 2 && /^unknown argument 1:/m.test(workers.err), `extract-entities.ts refuses --worker for --workers (exit ${workers.code})`);
  // A flag that takes a value, given bare, is refused — whichever script, whatever the flag guards.
  for (const [script, flag] of [["extract-entities.ts", "--job"], ["reembed.ts", "--retire"], ["consolidate.ts", "--accept"], ["ingest-records.ts", "--items"], ["sync-linear.ts", "--interval"], ["hnsw-graph.ts", "--index"], ["migrate.ts", "--grant"]]) {
    const bare = run(script, flag);
    ok(bare.code === 2 && new RegExp(`^${flag} needs a value; nothing follows it$`, "m").test(bare.err), `${script} ${flag}, bare, is refused rather than read as absent (exit ${bare.code}: ${bare.err.split("\n")[0]})`);
  }
  // --help anywhere, and a script's note with the list.
  const helpLate = run("consolidate.ts", "--dry-run", "--help");
  ok(helpLate.code === 0 && /usage: bun db\/consolidate\.ts/.test(helpLate.out), `--help after another flag still prints the list and exits 0 (exit ${helpLate.code})`);
  const benchHelp = run("bench-keyword.ts", "--help");
  ok(benchHelp.code === 0 && /flags: none/.test(benchHelp.out) && /OB1_BENCH_\* environment variables/.test(benchHelp.out), `a script's note prints with --help (exit ${benchHelp.code})`);
  const idsHint = run("reembed.ts", "--bogus");
  ok(/--accept-failed <thought-id …> \(right after it, before any other flag\)/.test(idsHint.err) && !/^  thought ids/m.test(idsHint.err), `reembed.ts says where ids go beside --accept-failed in the list, not as a note on every refusal (exit ${idsHint.code})`);
  // A flag read only beside another is refused alone rather than dropped (SMD-2015's kind; review pass 3).
  const tableAlone = run("hnsw-graph.ts", "--url", DEAD, "--table", "thought_chunks");
  ok(tableAlone.code === 2 && /--table goes with --index/.test(tableAlone.err), `hnsw-graph.ts refuses --table without --index (exit ${tableAlone.code})`);
  const noteAlone = run("consolidate.ts", "--url", DEAD, "--list", "--note", "why");
  ok(noteAlone.code === 2 && /--note goes with --accept or --reject/.test(noteAlone.err), `consolidate.ts refuses --note without a decision (exit ${noteAlone.code})`);
  const limitList = run("consolidate.ts", "--url", DEAD, "--list", "--limit", "5");
  ok(limitList.code === 2 && /--limit is the pass's thought cap and goes with a run; --list prints up to 50 of a status/.test(limitList.err), `consolidate.ts refuses --limit beside --list rather than dropping it (exit ${limitList.code})`);
  const listWord = run("consolidate.ts", "--url", DEAD, "--list", "postgres://u:s3cret@h/db");
  ok(listWord.code === 2 && /--list takes pending, accepted, rejected, stale, lineage or all/.test(listWord.err) && !listWord.err.includes("s3cret"), `consolidate.ts refuses a --list value by the words it takes, not repeating it (exit ${listWord.code})`);
  const hex = run("extract-entities.ts", "--url", DEAD, "--workers", "0x10");
  ok(hex.code === 2 && /--workers must be a decimal integer >= 1$/m.test(hex.err), `extract-entities.ts refuses a hex --workers, which Number() read as 16 (exit ${hex.code})`);
  const dump = run("extract-entities.ts", "--dump");
  ok(dump.code === 2 && /^--dump needs a value/m.test(dump.err), `extract-entities.ts refuses a bare --dump, which read as no dump (exit ${dump.code})`);
  // The documented bare forms: --follow [SECONDS] and --stale [DAYS] take their value optionally.
  for (const [script, ...argv] of [["extract-entities.ts", "--follow"], ["consolidate.ts", "--follow"], ["consolidate.ts", "--stale"], ["consolidate.ts", "--list"]]) {
    const bare = run(script, ...argv);
    ok(bare.code === 2 && /No database URL/.test(bare.err), `${script} ${argv.join(" ")}, bare, passes the scanner to the script's own first check (exit ${bare.code}: ${bare.err.split("\n")[0]})`);
  }
  const fraction = run("consolidate.ts", "--url", DEAD, "--min-sim", "0.85", "--min-confidence", "0.5", "--status");
  ok(!/must be a decimal/.test(fraction.err) && !/unknown argument/.test(fraction.err), `consolidate.ts reads a fractional --min-sim and --min-confidence (exit ${fraction.code}: ${fraction.err.split("\n")[0]})`);
  // What a refusal names, run for real: nothing the operator typed.
  const strayKey = run("tier.ts", "--compare", "a", "b", "sk-not-a-real-key");
  ok(strayKey.code === 2 && /^unknown argument 4: a value where no flag takes one$/m.test(strayKey.err) && !strayKey.err.includes("sk-not-a-real-key") && /connector name/.test(strayKey.err), `tier.ts --compare refuses a stray value by position, with the compare usage, not echoing it (exit ${strayKey.code})`);
  const grant = run("migrate.ts", "--grant", "--url=postgres://u:s3cret@h/db");
  ok(grant.code === 2 && /^--grant needs a value; a flag follows it$/m.test(grant.err) && !grant.err.includes("s3cret"), `migrate.ts --grant with a joined --url after it does not echo the password (exit ${grant.code})`);
  // SMD-2289: --groups narrows --grant, is refused on its own before the URL is read, and names an unknown group from the list.
  const lone = run("migrate.ts", "--groups", "capture");
  ok(lone.code === 2 && /^--groups narrows --grant to some of its groups; it does nothing on its own/m.test(lone.err), `migrate.ts --groups without --grant is refused as that, not as a missing URL (exit ${lone.code}: ${lone.err.split("\n")[0]})`);
  const unknownGroup = run("migrate.ts", "--grant", "r", "--groups", "capture,bogus", "--url", "postgres://u:s3cret@127.0.0.1:1/db");
  ok(unknownGroup.code === 2 && /not a group: "bogus"/.test(unknownGroup.err) && /capture, server, worker/.test(unknownGroup.err) && !unknownGroup.err.includes("s3cret"), `migrate.ts --groups names an unknown group and the list, before connecting (exit ${unknownGroup.code})`);
  const loneExact = run("migrate.ts", "--exact");
  ok(loneExact.code === 2 && /^--exact makes --grant all a role holds; it does nothing on its own/m.test(loneExact.err), `migrate.ts --exact without --grant is refused as that, not as a missing URL (exit ${loneExact.code}: ${loneExact.err.split("\n")[0]})`);
  const noGroups = run("migrate.ts", "--grant", "r", "--groups", ",", "--url", "postgres://u@127.0.0.1:1/db");
  ok(noGroups.code === 2 && /none was given/.test(noGroups.err), `migrate.ts --groups with no group in it is refused (exit ${noGroups.code})`);
  // SMD-2289: login-role.ts refuses what it would not make, before connecting, and never echoes the password.
  const noPw = run("login-role.ts", "--role", "ob1_x", "--password-env", "OB1_TEST_UNSET_PW", "--url", "postgres://u@127.0.0.1:1/db");
  ok(noPw.code === 2 && /OB1_TEST_UNSET_PW is not set: run `bun deploy\/orchestration\/provision.ts --init`/.test(noPw.err), `login-role.ts refuses an unset password variable, naming --init (exit ${noPw.code})`);
  const badName = run("login-role.ts", "--role", "Postgres; DROP", "--password-env", "PATH");
  ok(badName.code === 2 && /must be a lower-case identifier/.test(badName.err), `login-role.ts refuses a role name that is not a plain identifier (exit ${badName.code})`);
  const onlyRole = run("login-role.ts", "--role", "ob1_x");
  ok(onlyRole.code === 2 && /needs --role <name> and --password-env <VAR>/.test(onlyRole.err), `login-role.ts needs both flags (exit ${onlyRole.code})`);
  const glued = run("migrate.ts", "--urlpostgres://u:s3cret@h/db");
  ok(glued.code === 2 && !glued.err.includes("s3cret"), `migrate.ts with the space after --url missed does not echo the password (exit ${glued.code})`);
  const ids = run("reembed.ts", "--accept-failed", "a", "--dry-run", "b");
  ok(ids.code === 2 && /^unknown argument 4: a value where no flag takes one$/m.test(ids.err) && /--accept-failed <thought-id …> \(right after it, before any other flag\)/.test(ids.err), `reembed.ts says where ids go when one is stray (exit ${ids.code})`);
  const subjects = run("graph-centrality.ts", "postgres://u:s3cret@h/db", "Open Brain");
  ok(subjects.code === 2 && /one subject at a time; got 2/.test(subjects.err) && !subjects.err.includes("s3cret"), `graph-centrality.ts counts two subjects, a URL given without --url among them, without repeating them (exit ${subjects.code})`);
  // rebuild.ts (SMD-1732's door, moved onto the scanner at the merge of main): a typo refused, a value repeated nowhere.
  const rebuildTypo = run("rebuild.ts", "--url", DEAD, "--orphan");
  ok(rebuildTypo.code === 2 && /^unknown argument 3: not a flag this script has$/m.test(rebuildTypo.err), `rebuild.ts refuses --orphan for --orphans rather than ignoring it (exit ${rebuildTypo.code})`);
  const rebuildInput = run("rebuild.ts", "--url", DEAD, "--input", "postgres://u:s3cret@h/db");
  ok(rebuildInput.code === 2 && /--input takes a thought id \(a UUID\)/.test(rebuildInput.err) && !rebuildInput.err.includes("s3cret"), `rebuild.ts refuses a non-id --input without repeating it (exit ${rebuildInput.code})`);
  const rebuildLimit = run("rebuild.ts", "--url", DEAD, "--orphans", "--limit", "1e3");
  ok(rebuildLimit.code === 2 && /--limit must be a decimal integer >= 0/.test(rebuildLimit.err), `rebuild.ts refuses --limit 1e3 by the digits rule (exit ${rebuildLimit.code})`);
  const rebuildReason = run("rebuild.ts", "--url", DEAD, "--input", "00000000-0000-0000-0000-000000000000", "--reason", "  ");
  ok(rebuildReason.code === 2 && /^--reason is empty/m.test(rebuildReason.err), `rebuild.ts refuses a blank --reason (exit ${rebuildReason.code})`);
  // sync-linear's interval, from the flag or the environment, by the digits rule; the key and URL only get it past the checks before.
  const interval = Bun.spawnSync(["bun", "--no-env-file", "sync-linear.ts", "--url", DEAD, "--interval", "0x10"], { cwd: HERE, env: { ...env, LINEAR_API_KEY: "not-a-real-key" } });
  ok(interval.exitCode === 2 && /--interval \/ OB1_BOARD_SYNC_INTERVAL must be a decimal integer >= 10/.test(interval.stderr.toString()), `sync-linear.ts refuses a hex --interval, which Number() read as 16 (exit ${interval.exitCode})`);
  // Past the scanner, a well-formed command reaches the script's own first need.
  const reached = run("extract-entities.ts", "--workers", "1", "--dry-run");
  ok(reached.code === 2 && /No database URL/.test(reached.err), `a command the scanner accepts reaches the script's own first check (exit ${reached.code}: ${reached.err.split("\n")[0]})`);
}

console.log(`\ntest-cli: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
