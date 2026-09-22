#!/usr/bin/env bun
/**
 * check-landing.ts — what a landing must carry (SMD-1857).
 *
 * A landing is one pull request's worth of change reaching `main`. CI sees it
 * twice: as the `pull_request` event, whose range is the PR's base and head,
 * and — since `main` merges through GitHub's merge queue — as the `merge_group`
 * event, whose range is `main`'s tip and the merge result the queue built, one
 * first-parent commit per queued PR (the record pins the queue's merge method
 * to MERGE, so each is that PR's merge commit, and `git diff c^1 c` is exactly
 * what the PR added).
 *
 * The rule, CONTRIBUTING.md's "Changelog & versioning": every PR that touches
 * db/migrations/, server-portable/ or evals/ ships a changes/smd-NNNN.md
 * fragment. Tests and docs are exempt by PATH — a `test-*.ts` / `*.test.ts`
 * file or a Markdown file inside those directories asks no fragment — rather
 * than by a label, because the merge group's run carries no pull request and
 * the workflow's token reads none. The rule is landingProblem, one pure
 * function over a landing's file list, and the git reading is the thin part
 * around it.
 *
 * Run: bun scripts/check-landing.ts --event pull_request|merge_group --from <sha> --to <sha>
 * Exit: 0 every landing carries what it must; 1 one did not (each named with
 * the files that asked); 2 the arguments or the range did not make sense.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The directories whose change is a change to the fork itself, as CONTRIBUTING.md names them. */
export const FRAGMENT_DIRS = ["db/migrations/", "server-portable/", "evals/"];
/** Inside those directories, what asks no fragment: a test file in the tree's spelling (`test-x.ts`, `x.test.ts`) or a Markdown file. */
export const FRAGMENT_EXEMPT = /(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.(?:ts|mjs|js|py|sh)$|\.md$/i;
/** A fragment, as changes/README.md names one — a numbered `changes/NNN-slug.md` is the release step's, and ships with no PR. */
export const FRAGMENT_FILE = /^changes\/smd-\d+\.md$/;

/**
 * What is wrong with a landing whose changed files are `files` — nothing when
 * it touches none of the fragment directories beyond tests and docs, or when
 * it touches one and carries a fragment. Otherwise the files that asked, so the
 * refusal names them.
 */
export function landingProblem(files: readonly string[]): string | null {
  const asking = files.filter((f) => FRAGMENT_DIRS.some((d) => f.startsWith(d)) && !FRAGMENT_EXEMPT.test(f));
  if (!asking.length) return null;
  const fragments = files.filter((f) => FRAGMENT_FILE.test(f));
  if (fragments.length) return null;
  return `touches ${asking.join(", ")} and ships no changes/smd-NNNN.md fragment — every PR that changes ${FRAGMENT_DIRS.join(", ")} beyond tests and docs records itself (CONTRIBUTING.md, "Changelog & versioning"; SMD-1857)`;
}

/** [why, files, a phrase the problem must carry — or null for no problem]. */
export const LANDING_PROBES: [why: string, files: string[], says: string | null][] = [
  ["a migration with no fragment", ["db/migrations/048_x.sql", "db/README.md"], "touches db/migrations/048_x.sql and ships no"],
  ["a server file with no fragment", ["server-portable/store.ts"], "touches server-portable/store.ts"],
  ["an eval with no fragment", ["evals/eval-replay.ts"], "touches evals/eval-replay.ts"],
  ["two asking files, both named", ["server-portable/store.ts", "evals/lib.ts"], "server-portable/store.ts, evals/lib.ts"],
  ["a migration with a fragment", ["db/migrations/048_x.sql", "changes/smd-1857.md"], null],
  ["a migration with a numbered change file, which is not a fragment", ["db/migrations/048_x.sql", "changes/018-long-captures-stay-searchable.md"], "ships no"],
  ["a fragment for a change outside the directories", ["changes/smd-1857.md", "scripts/x.ts"], null],
  ["a test alone", ["server-portable/test-store-sql.ts", "evals/x.test.ts"], null],
  ["a test helper — test-support.ts is a test file by the tree's spelling", ["server-portable/test-support.ts"], null],
  ["docs alone", ["server-portable/README.md", "evals/README.md"], null],
  ["db/ outside migrations", ["db/migrate.ts", "db/config.mjs"], null],
  ["a lockfile pin in the server", ["server-portable/bun.lock"], "touches server-portable/bun.lock"],
  ["a fixture — data an eval reads is not a test file", ["evals/fixtures/replay.json"], "touches evals/fixtures/replay.json"],
  ["a directory-shaped name that only starts like one", ["evals-old/x.ts", "server-portable-docs/x.ts"], null],
  ["nothing", [], null],
];

/** Self-test: each probe says what it must, and no more. Returns the failures, in words. */
export function selfTest(): string[] {
  const out: string[] = [];
  for (const [why, files, says] of LANDING_PROBES) {
    const got = landingProblem(files);
    if (says === null ? got !== null : !got?.includes(says)) out.push(`landingProblem for ${why}: expected ${says === null ? "no problem" : `"${says}"`}, got ${JSON.stringify(got)}`);
  }
  return out;
}

function git(args: string[]) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity }).trim();
}

/** The landings in a range, each as [label, files]: one for a pull request; one per first-parent commit for a merge group. */
function landings(event: string, from: string, to: string): [label: string, files: string[]][] {
  if (event === "pull_request") {
    const base = git(["merge-base", from, to]);
    return [[`${from.slice(0, 8)}...${to.slice(0, 8)} (merge base ${base.slice(0, 8)})`, git(["diff", "--name-only", base, to]).split("\n").filter(Boolean)]];
  }
  const commits = git(["rev-list", "--first-parent", "--reverse", `${from}..${to}`]).split("\n").filter(Boolean);
  return commits.map((c) => {
    const subject = git(["log", "-1", "--format=%s", c]);
    return [`${c.slice(0, 8)} ${subject}`, git(["diff", "--name-only", `${c}^1`, c]).split("\n").filter(Boolean)];
  });
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const event = arg("event"), from = arg("from"), to = arg("to");
  if (!event || !["pull_request", "merge_group"].includes(event) || !from || !to) {
    console.error("usage: bun scripts/check-landing.ts --event pull_request|merge_group --from <sha> --to <sha>");
    process.exit(2);
  }
  const self = selfTest();
  if (self.length) { for (const s of self) console.error(`  ${s}`); console.error("\nFAIL — check-landing's own probes."); process.exit(1); }
  let found: [string, string[]][];
  try { found = landings(event, from, to); } catch (e) { console.error(`cannot read the range ${from}..${to}: ${(e as Error).message}`); process.exit(2); }
  if (!found.length) { console.error(`the range ${from}..${to} holds no landing — a merge group with nothing in it, or the wrong shas`); process.exit(2); }
  const problems: string[] = [];
  for (const [label, files] of found) {
    const problem = landingProblem(files);
    const fragments = files.filter((f) => FRAGMENT_FILE.test(f));
    console.log(`${problem ? "FAIL" : "ok  "} ${label}: ${files.length} file(s)${fragments.length ? `, fragment ${fragments.join(", ")}` : problem ? "" : ", no fragment needed"}`);
    if (problem) problems.push(`${label}\n    ${problem}`);
  }
  if (problems.length) { console.error(`\nFAIL — ${problems.length} landing(s) carry less than they must:\n`); for (const p of problems) console.error(`  ${p}`); process.exit(1); }
  console.log(`PASS — ${found.length} landing(s).`);
}
