/**
 * The wiki's Test-counts page, from the count lines Brain Checks' jobs uploaded
 * (SMD-3614). A suite's assertion total is a fact about a commit's run, not
 * documentation: report() in db/test-support.ts appends one JSON line a run to
 * the file OB1_TEST_COUNTS names, each job uploads its file, and the workflow's
 * publish-test-counts job, on a push to main alone, runs this over them and
 * commits the page it prints to the wiki.
 *
 *   COUNTS_DIR=<dir> NEEDS=<toJSON(needs)> SHA=<sha> REPO=<owner/repo> RUN_URL=<url> bun .github/ci/test-counts-page.ts > Test-counts.md
 *   bun .github/ci/test-counts-page.ts --self-check
 *
 * The page holds a row a suite and variant (a shard, a width), sorted by path,
 * the commit and the run it came from, and every job the publish job needs
 * that did not succeed or reported no counts — so a missing row says why.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CountLine } from "../../db/test-support.ts";

/** A job's result as `toJSON(needs)` gives it. */
type Needs = Record<string, { result: string }>;

/** Every count line in the files under `dir`, at any depth (download-artifact puts each artifact in its own directory). A line that does not parse is an error naming its file. */
export function readCounts(dir: string): CountLine[] {
  const out: CountLine[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { out.push(...readCounts(path)); continue; }
    for (const [i, text] of readFileSync(path, "utf8").split("\n").entries()) {
      if (text.trim() === "") continue;
      try { out.push(JSON.parse(text) as CountLine); } catch { throw new Error(`${path}:${i + 1} is not a count line: ${text.slice(0, 80)}`); }
    }
  }
  return out;
}

/** A cell's text with the characters that would end it or break the table escaped. */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The page, as Markdown. `now` is the time it states. */
export function renderPage(lines: CountLine[], needs: Needs, at: { sha: string; repo: string; runUrl: string; now: Date }): string {
  // A run that reports twice (a suite a test spawns, say) is one row when the lines agree.
  const seen = new Set<string>();
  const rows = lines
    .filter((l) => { const k = JSON.stringify(l); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.suite.localeCompare(b.suite) || (a.variant ?? "").localeCompare(b.variant ?? "") || (a.job ?? "").localeCompare(b.job ?? ""));
  const reported = new Set(rows.map((r) => r.job));
  const notPassed = Object.entries(needs).filter(([, v]) => v.result !== "success").map(([k, v]) => `\`${k}\` (${v.result})`);
  const silent = Object.entries(needs).filter(([k, v]) => v.result === "success" && !reported.has(k)).map(([k]) => `\`${k}\``);
  const out = [
    "# Test counts",
    "",
    "Each Brain Checks suite's assertion total on `main`, as the run of the last push to `main` counted it. Brain Checks writes this page (SMD-3614); an edit by hand is replaced at the next push.",
    "",
    `Commit [\`${at.sha.slice(0, 12)}\`](https://github.com/${at.repo}/commit/${at.sha}) · [its run](${at.runUrl}) · ${at.now.toISOString().replace(/\.\d+Z$/, "Z")}`,
    "",
    "| Suite | Run | Assertions | Passed | Failed | Skipped | Job |",
    "|---|---|---:|---:|---:|---:|---|",
    ...rows.map((r) => `| \`${cell(r.suite)}\` | ${cell(r.variant ?? "whole")} | ${r.assertions} | ${r.passed} | ${r.failed}${r.docFailed ? ` (+${r.docFailed} doc)` : ""} | ${r.skipped} | ${cell(r.job ?? "")} |`),
    "",
    "A run's skipped cases could not run there (a group its Postgres lacks, say) and are not in its total.",
    "",
    notPassed.length ? `Jobs that did not succeed, whose rows may be missing or partial: ${notPassed.join(", ")}.` : "Every job that runs suites succeeded.",
  ];
  if (silent.length) out.push("", `Jobs that succeeded and reported no counts: ${silent.join(", ")}.`);
  return `${out.join("\n")}\n`;
}

function selfCheck(): never {
  let failed = 0;
  const check = (ok: boolean, label: string) => { console.log(`  ${ok ? "✓" : "✗"}  ${label}`); if (!ok) failed++; };
  const line = (suite: string, variant: string | null, job: string, n: number, extra: Partial<CountLine> = {}): CountLine =>
    ({ suite, variant, job, assertions: n, passed: n, failed: 0, skipped: 0, docFailed: 0, ...extra });
  const at = { sha: "0123456789abcdef0123456789abcdef01234567", repo: "o/r", runUrl: "https://github.com/o/r/actions/runs/1", now: new Date("2026-10-31T12:00:00.123Z") };
  const page = renderPage([
    line("db/test-live.ts", "shard sleep", "db-live", 121),
    line("db/test-live.ts", "shard rest", "db-live", 1048),
    line("db/test-schema.ts", "width 8", "db-schema", 3127),
    line("db/test-schema.ts", "width 8", "db-schema", 3127),
    line("compat/supabase-sql/test-compat.ts", null, "compat-shim", 295, { skipped: 2 }),
    line("a|b.ts", null, "x", 1, { failed: 1, passed: 0, docFailed: 1 }),
  ], { "db-live": { result: "success" }, "db-schema": { result: "success" }, "compat-shim": { result: "success" }, x: { result: "failure" }, "data-layer": { result: "success" }, "deploy-stack": { result: "skipped" } }, at);
  const rows = page.split("\n").filter((l) => l.startsWith("| `"));
  check(rows.length === 5, `one row a suite and variant, a repeated line once (${rows.length} rows)`);
  check(rows[0].startsWith("| `a\\|b.ts`") && rows[1].startsWith("| `compat/") && rows[2].includes("shard rest") && rows[3].includes("shard sleep") && rows[4].startsWith("| `db/test-schema.ts`"),
    "rows sorted by path, then variant; a pipe in a cell escaped");
  check(rows[1].includes("| whole | 295 | 295 | 0 | 2 | compat-shim |"), "a run with no variant is the whole suite, its skips in their column");
  check(rows[0].includes("| 0 | 1 (+1 doc) |"), "a failed doc check beside the failures");
  check(page.includes("[`0123456789ab`](https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567)") && page.includes("2026-10-31T12:00:00Z"), "the commit, linked, and the time, to the second");
  check(page.includes("did not succeed, whose rows may be missing or partial: `x` (failure), `deploy-stack` (skipped)."), "the jobs that did not succeed, by result");
  check(page.includes("reported no counts: `data-layer`.") && !page.includes("reported no counts: `deploy-stack`"), "a job that succeeded with no rows named; a skipped one is named once, among the jobs that did not succeed");
  const clean = renderPage([line("t.ts", null, "j", 1)], { j: { result: "success" } }, at);
  check(clean.includes("Every job that runs suites succeeded.") && !clean.includes("reported no counts"), "every job green and reporting: one line says so");
  let threw = "";
  try { renderPage(readCounts(join(import.meta.dir, "no-such-dir")), {}, at); } catch (e) { threw = String(e); }
  check(threw.includes("ENOENT"), "an absent counts directory is an error, not an empty page");
  // The writer end to end: a suite of report()'s, run as a job runs it, and its line read back.
  const dir = mkdtempSync(join(tmpdir(), "test-counts-"));
  try {
    const suite = join(dir, "test-tiny.ts");
    writeFileSync(suite, `import { createAssert } from ${JSON.stringify(join(import.meta.dir, "../../db/test-support.ts"))};\nconst { assert, skip, report } = createAssert();\nassert(true, "a");\nassert(true, "b");\nskip("c");\nif (process.argv[2] === "--named") report("shard x");\nreport();\n`);
    const run = (...args: string[]) => Bun.spawnSync(["bun", suite, ...args], { env: { ...process.env, OB1_TEST_COUNTS: join(dir, "out", "counts.jsonl"), GITHUB_JOB: "tiny-job" }, stdout: "ignore", stderr: "ignore" }).exitCode;
    const codes = [run("--named"), run("--gate"), run()];
    const got = readCounts(join(dir, "out"));
    check(codes.every((c) => c === 0) && got.length === 3, `each run of a suite writes one line (${got.length}, exits ${codes.join(",")})`);
    check(got.every((l) => l.suite.endsWith("test-tiny.ts") && l.job === "tiny-job" && l.assertions === 2 && l.passed === 2 && l.skipped === 1),
      "a line holds the suite, the job and the run's counts");
    check(JSON.stringify(got.map((l) => l.variant)) === JSON.stringify(["shard x", "--gate", null]), `the variant is the suite's own, else its flags, else none (${got.map((l) => l.variant).join(", ")})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed\nFAIL` : "\nPASS");
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) selfCheck();
  const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
  const page = renderPage(readCounts(need("COUNTS_DIR")), JSON.parse(need("NEEDS")) as Needs, { sha: need("SHA"), repo: need("REPO"), runUrl: need("RUN_URL"), now: new Date() });
  process.stdout.write(page);
}
