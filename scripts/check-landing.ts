#!/usr/bin/env bun
/**
 * check-landing.ts — what a landing must carry (SMD-1857).
 *
 * A landing is one pull request's worth of change reaching `main`. CI sees it
 * as the `pull_request` event, whose range is the PR's base and head; and, the
 * day `main` merges through GitHub's merge queue (refused on this user-owned
 * repository — SMD-1984 moves it), as the `merge_group` event, whose range is
 * `main`'s tip and the merge result the queue built, one first-parent commit
 * per queued PR (the record pins the queue's merge method to MERGE, so each is
 * that PR's merge commit, and `git diff c^1 c` is exactly what the PR added; a
 * first-parent commit with one parent means the live queue is not merging as
 * the record says, and the run stops on that rather than reading each commit
 * as a PR).
 *
 * The rule, CONTRIBUTING.md's "Changelog & versioning": every PR that touches
 * db/migrations/, server-portable/ or evals/ ships a changes/smd-NNNN.md
 * fragment — added, or extended when a ticket lands in slices (SMD-1806 did);
 * a deleted one is not shipped. Tests and docs are exempt by PATH — a
 * `test-*.ts` / `*.test.ts` file or a Markdown file inside those directories
 * asks no fragment — rather than by a label, because the merge group's run
 * carries no pull request and the workflow's token reads none. The rule is
 * landingProblem, one pure function over a landing's change list, and the git
 * reading is the thin part around it: `--name-status -z --no-renames`, so a
 * non-ASCII path is not C-quoted past the prefix test and a file moved out of
 * a directory shows as its deletion there.
 *
 * Run: bun scripts/check-landing.ts --event pull_request|merge_group --from <sha> --to <sha>
 * Exit: 0 every landing carries what it must; 1 one did not (each named with
 * the files that asked); 2 the arguments, the range or this script's own
 * probes did not make sense — never the PR's fault.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One changed path with git's one-letter status: A added, M modified, D deleted, T type changed (renames are not detected, so none). */
export type Change = [status: string, path: string];

/** The directories whose change is a change to the fork itself, as CONTRIBUTING.md names them. */
export const FRAGMENT_DIRS = ["db/migrations/", "server-portable/", "evals/"];
/** Inside those directories, what asks no fragment: a test file in the tree's spelling (`test-x.ts`, `x.test.ts`) or a Markdown file. */
export const FRAGMENT_EXEMPT = /(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.(?:ts|mjs|js|py|sh)$|\.md$/i;
/** A fragment, as changes/README.md names one — a numbered `changes/NNN-slug.md` is the release step's, and ships with no PR. */
export const FRAGMENT_FILE = /^changes\/smd-\d+\.md$/;

/**
 * What is wrong with a landing whose changes are `changes` — nothing when it
 * touches none of the fragment directories beyond tests and docs (any status:
 * a deleted migration is a change too), or when it touches one and carries a
 * fragment added or modified. Otherwise the files that asked, so the refusal
 * names them.
 */
export function landingProblem(changes: readonly Change[]): string | null {
  const asking = changes.filter(([, f]) => FRAGMENT_DIRS.some((d) => f.startsWith(d)) && !FRAGMENT_EXEMPT.test(f)).map(([, f]) => f);
  if (!asking.length) return null;
  if (shippedFragments(changes).length) return null;
  return `touches ${asking.join(", ")} and ships no changes/smd-NNNN.md fragment — every PR that changes ${FRAGMENT_DIRS.join(", ")} beyond tests and docs records itself (CONTRIBUTING.md, "Changelog & versioning"; SMD-1857)`;
}
/** The fragments a landing ships: added or modified, not deleted. */
export function shippedFragments(changes: readonly Change[]) {
  return changes.filter(([s, f]) => (s === "A" || s === "M") && FRAGMENT_FILE.test(f)).map(([, f]) => f);
}

/** [why, changes, a phrase the problem must carry — or null for no problem]. */
export const LANDING_PROBES: [why: string, changes: Change[], says: string | null][] = [
  ["a migration with no fragment", [["A", "db/migrations/048_x.sql"], ["M", "db/README.md"]], "touches db/migrations/048_x.sql and ships no"],
  ["a server file with no fragment", [["M", "server-portable/store.ts"]], "touches server-portable/store.ts"],
  ["an eval with no fragment", [["M", "evals/eval-replay.ts"]], "touches evals/eval-replay.ts"],
  ["two asking files, both named", [["M", "server-portable/store.ts"], ["M", "evals/lib.ts"]], "server-portable/store.ts, evals/lib.ts"],
  ["a deleted migration", [["D", "db/migrations/047_x.sql"]], "touches db/migrations/047_x.sql"],
  ["a migration with a fragment", [["A", "db/migrations/048_x.sql"], ["A", "changes/smd-1857.md"]], null],
  ["a server change extending a fragment — a ticket landing in slices", [["M", "server-portable/store.ts"], ["M", "changes/smd-1806.md"]], null],
  ["a migration beside a DELETED fragment", [["A", "db/migrations/048_x.sql"], ["D", "changes/smd-1490.md"]], "ships no"],
  ["a migration with a numbered change file, which is not a fragment", [["A", "db/migrations/048_x.sql"], ["A", "changes/018-long-captures-stay-searchable.md"]], "ships no"],
  ["a fragment for a change outside the directories", [["A", "changes/smd-1857.md"], ["M", "scripts/x.ts"]], null],
  ["a test alone", [["M", "server-portable/test-store-sql.ts"], ["A", "evals/x.test.ts"]], null],
  ["a test helper — test-support.ts is a test file by the tree's spelling", [["M", "server-portable/test-support.ts"]], null],
  ["docs alone", [["M", "server-portable/README.md"], ["M", "evals/README.md"]], null],
  ["db/ outside migrations", [["M", "db/migrate.ts"], ["M", "db/config.mjs"]], null],
  ["a lockfile pin in the server", [["M", "server-portable/bun.lock"]], "touches server-portable/bun.lock"],
  ["a fixture — data an eval reads is not a test file", [["M", "evals/fixtures/replay.json"]], "touches evals/fixtures/replay.json"],
  ["a directory-shaped name that only starts like one", [["M", "evals-old/x.ts"], ["M", "server-portable-docs/x.ts"]], null],
  ["nothing", [], null],
];

/** Self-test: each probe says what it must, and no more; the -z parser reads a status, a path with a space and a non-ASCII path. Returns the failures, in words. */
export function selfTest(): string[] {
  const out: string[] = [];
  for (const [why, changes, says] of LANDING_PROBES) {
    const got = landingProblem(changes);
    if (says === null ? got !== null : !got?.includes(says)) out.push(`landingProblem for ${why}: expected ${says === null ? "no problem" : `"${says}"`}, got ${JSON.stringify(got)}`);
  }
  const parsed = parseNameStatus("A\0server-portable/café.ts\0M\0evals/a b.ts\0D\0changes/smd-1.md\0");
  if (JSON.stringify(parsed) !== JSON.stringify([["A", "server-portable/café.ts"], ["M", "evals/a b.ts"], ["D", "changes/smd-1.md"]])) out.push(`parseNameStatus reads ${JSON.stringify(parsed)}`);
  return out;
}

/** `git diff --name-status -z` output as changes: status NUL path NUL, repeated; paths are raw, never C-quoted. */
export function parseNameStatus(out: string): Change[] {
  const parts = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) changes.push([parts[i][0], parts[i + 1]]);
  return changes;
}

function git(args: string[]) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: Infinity });
}
function changesBetween(a: string, b: string): Change[] {
  return parseNameStatus(git(["diff", "--name-status", "-z", "--no-renames", a, b]));
}
/** A sha shortened for a label; anything else (a ref name) as given. */
const short = (s: string) => (/^[0-9a-f]{40}$/.test(s) ? s.slice(0, 8) : s);

/** The landings in a range, each as [label, changes]: one for a pull request; one per first-parent commit for a merge group. Throws, in words, on a range that is not what the event promises. */
function landings(event: string, from: string, to: string): [label: string, changes: Change[]][] {
  if (event === "pull_request") {
    const base = git(["merge-base", from, to]).trim();
    const changes = changesBetween(base, to);
    if (!changes.length) throw new Error(`the range ${from}...${to} (merge base ${short(base)}) changes nothing — a pull request has a diff; these are the wrong shas`);
    return [[`${short(from)}...${short(to)} (merge base ${short(base)})`, changes]];
  }
  const commits = git(["rev-list", "--first-parent", "--reverse", `${from}..${to}`]).split("\n").filter(Boolean);
  if (!commits.length) throw new Error(`the range ${from}..${to} holds no landing — a merge group with nothing in it, or the wrong shas`);
  return commits.map((c) => {
    const [, ...parents] = git(["rev-list", "--parents", "-n", "1", c]).trim().split(" ");
    const subject = git(["log", "-1", "--format=%s", c]).trim();
    if (parents.length < 2) throw new Error(`${short(c)} "${subject}" has one parent — the queue did not merge it; the record pins merge_method MERGE, under which every first-parent commit of a group is one PR's merge commit, so the live ruleset has drifted from .github/rulesets/main.json (re-apply it)`);
    return [`${short(c)} ${subject}`, changesBetween(`${c}^1`, c)];
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
  if (self.length) { for (const s of self) console.error(`  ${s}`); console.error("\ncheck-landing's own probes fail — the script, not the landing."); process.exit(2); }
  let found: [string, Change[]][];
  try { found = landings(event, from, to); } catch (e) { console.error(`cannot read the range as a ${event}: ${(e as Error).message}`); process.exit(2); }
  const problems: string[] = [];
  for (const [label, changes] of found) {
    const problem = landingProblem(changes);
    const fragments = shippedFragments(changes);
    console.log(`${problem ? "FAIL" : "ok  "} ${label}: ${changes.length} file(s)${fragments.length ? `, fragment ${fragments.join(", ")}` : problem ? "" : ", no fragment needed"}`);
    if (problem) problems.push(`${label}\n    ${problem}`);
  }
  if (problems.length) { console.error(`\nFAIL — ${problems.length} landing(s) carry less than they must:\n`); for (const p of problems) console.error(`  ${p}`); process.exit(1); }
  console.log(`PASS — ${found.length} landing(s).`);
}
