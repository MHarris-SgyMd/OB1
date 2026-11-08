/**
 * gate-check.ts — the offline self-check of cut 2b-1 (SMD-4087): the run record (record.ts) and the gate (gate.ts),
 * on fixtures, with no Claude Code and no network. CI runs it (`bun scripts/agent-runner/gate-check.ts --self-check`). It
 * builds a real bare repository and a branch with git (see developerGit below), and runs the whole gate against it
 * with stubbed commitlint and secret scanners; the pure parsers are also unit-tested directly, including the
 * signed-commit case git can't make here without a key. The run orchestration that produces a real branch is cut 2b-2.
 *
 *   bun scripts/agent-runner/gate-check.ts --self-check
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEP_FILE, GateDeps, GateInput, REFUSED_EXT, checkWork, gate, mentionsVerify, parseCommits, parseNameStatus,
} from "./gate.ts";
import {
  branchFor, isFinished, listRuns, readRecord, readNoFollow, runId, slugOf, startRecord, updateRecord, writeNoFollow,
} from "./record.ts";

const BOT = { name: "Agent Runner Bot", email: "bot@agent-runner.invalid" };

/**
 * The git to run the fixtures with: on macOS the active developer git (so it isn't Apple's xcrun shim), on Linux (CI
 * runs this self-check on ubuntu) plain `git` from PATH. `xcode-select` isn't there on Linux and `Bun.spawnSync` throws
 * ENOENT on a missing binary, so the probe is guarded — the same Linux slip as cut 2a's `hostStamp` (`sw_vers`).
 */
function developerGit(): string {
  try {
    const r = Bun.spawnSync(["/usr/bin/xcode-select", "-p"], { stdout: "pipe", stderr: "ignore" });
    const git = `${r.stdout.toString().trim()}/usr/bin/git`;
    if (r.exitCode === 0 && existsSync(git)) return git;
  } catch {
    // No xcode-select (Linux): fall back to PATH git, which the fixture runs with /usr/bin:/bin.
  }
  return "git";
}

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = async (check: () => unknown, what: string): Promise<void> => {
    let pass = false;
    let note = "";
    try {
      pass = Boolean(await check());
    } catch (e) {
      note = ` (threw: ${String((e as Error)?.message ?? e).slice(0, 160)})`;
    }
    if (pass) passed++;
    else failed++;
    console.log(`  ${pass ? "✓" : "✗"} ${what}${note}`);
  };
  const section = async (name: string, body: () => Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: its setup threw (${String((e as Error)?.message ?? e).slice(0, 160)})`);
    }
  };

  const GIT = developerGit();
  const fixture = mkdtempSync(join(tmpdir(), "obr-gate-"));
  try {
    await section("the run record", async () => {
      const state = join(fixture, "state");
      await ok(() => runId(new Date("2026-11-08T04:05:06.700Z")) === "2026-11-08T04-05-06-700Z", "runId makes a safe, sortable name");
      await ok(() => slugOf("Fix the Thing (SMD-9)!!") === "fix-the-thing-smd-9" && slugOf("") === "work" && slugOf("!!!") === "work" && slugOf("a".repeat(60)).length <= 40, "slugOf lower-cases, joins, trims and caps; empty falls back to 'work'");
      await ok(() => branchFor("SMD-1234", "Do the thing") === "agent/smd-1234-do-the-thing" && branchFor("SMD-7", "") === "agent/smd-7-work", "branchFor is agent/smd-<n>-<slug>");
      const rec = startRecord(state, { run: "R1", ticket: "SMD-9", base: "abc123", branch: "agent/smd-9-x" });
      await ok(() => rec.step === "prepare" && rec.outcome === null && rec.owed.length === 0 && rec.claimId === null && existsSync(join(state, "runs", "R1", "record.json")), "startRecord makes the dir and a fresh record with the full null field set");
      await ok(() => { const r = readRecord(join(state, "runs", "R1")); return r.run === "R1" && r.ticket === "SMD-9" && r.base === "abc123"; }, "readRecord round-trips the record");
      await ok(() => { const r = updateRecord(join(state, "runs", "R1"), (x) => { x.step = "gate"; x.gate = { pass: true, failed: [], ciCheckFiles: [] }; }); return r.step === "gate" && readRecord(join(state, "runs", "R1")).gate?.pass === true; }, "updateRecord applies a change and writes it whole");
      await ok(() => !isFinished(readRecord(join(state, "runs", "R1"))) && isFinished({ ...readRecord(join(state, "runs", "R1")), outcome: "published", owed: [] }) && !isFinished({ ...readRecord(join(state, "runs", "R1")), outcome: "published", owed: [{ kind: "release", why: "x", at: "t" }] }), "isFinished needs an outcome and nothing owed");
      startRecord(state, { run: "R2", ticket: "SMD-9", base: "b", branch: "agent/smd-9-y" });
      writeFileSync(join(state, "runs", "notarun"), "x");
      await ok(() => { const l = listRuns(state); return JSON.stringify(l.runs) === JSON.stringify(["R2", "R1"]) && l.unreadable.includes("notarun"); }, "listRuns lists runs newest first and flags an unreadable entry");
      const nf = join(fixture, "nofollow.txt");
      writeNoFollow(nf, "whole");
      await ok(() => readNoFollow(nf) === "whole", "writeNoFollow/readNoFollow round-trip");
      symlinkSync(join(fixture, "elsewhere"), join(fixture, "nf-link"));
      await ok(() => { let threw = false; try { writeNoFollow(join(fixture, "nf-link"), "x"); } catch { threw = true; } return threw && !existsSync(join(fixture, "elsewhere")); }, "writeNoFollow refuses a symlink (O_NOFOLLOW)");
    });

    await section("the gate's pure parsers", async () => {
      const line = (h: string, parents: string, an: string, sign: string) => `${h}\0${parents}\0${an}\0${an}@x\0${an}\0${an}@x\0${sign}`;
      const log = [line("h1", "p0", "Bot", "N"), line("h2", "h1", "Bot", "N")].join("\n") + "\n";
      await ok(() => { const c = parseCommits(log); return c.length === 2 && c[0].parents === 1 && c[0].an === "Bot" && c[0].sign === "N"; }, "parseCommits reads the log format");
      await ok(() => parseCommits(line("m", "h1 h2", "Bot", "N"))[0].parents === 2, "parseCommits counts a merge's two parents");
      await ok(() => parseCommits("garbage line\n").length === 0 && parseCommits(`${line("h", "p", "B", "N")}\nshort\0line`).length === 1, "parseCommits skips a line that isn't seven fields");
      await ok(() => { const r = parseCommits(line("h", "", "B", "N"))[0]; return r.parents === 0; }, "a root commit has zero parents");
      const ns = parseNameStatus("A\0a.ts\0M\0b.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0");
      await ok(() => ns.length === 4 && ns[0].status === "A" && ns[2].path === "old.ts" && ns[2].path2 === "new.ts" && ns[3].status === "D", "parseNameStatus reads adds, edits, renames (two paths) and deletes");
      await ok(() => REFUSED_EXT.test("x.zip") && REFUSED_EXT.test("a/b.tar.gz") && REFUSED_EXT.test("i.png") && !REFUSED_EXT.test("x.ts") && !REFUSED_EXT.test("readme.md"), "REFUSED_EXT catches archives, binaries and images, not source");
      await ok(() => DEP_FILE.test("package.json") && DEP_FILE.test("x/bun.lock") && DEP_FILE.test("yarn.lock") && !DEP_FILE.test("x/config.json"), "DEP_FILE catches manifests and lockfiles");
      await ok(() => mentionsVerify("the report checks the sandbox denies the socket", "the sandbox denies the socket") && !mentionsVerify("unrelated text here entirely", "the sandbox denies the socket entirely"), "mentionsVerify is a loose word-overlap check");
    });

    // A real fixture: a bare "runner" repo, a base commit, and a session branch the bot committed, so the whole gate runs.
    const git = (args: string[], cwd: string) => {
      const r = Bun.spawnSync([GIT, ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: fixture, GIT_CONFIG_GLOBAL: join(fixture, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    writeFileSync(join(fixture, "gitconfig"), `[user]\n\tname = ${BOT.name}\n\temail = ${BOT.email}\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`);
    const bare = join(fixture, "runner.git");
    git(["init", "-q", "--bare", bare], fixture);
    const work = join(fixture, "work");
    git(["clone", "-q", bare, work], fixture);
    writeFileSync(join(work, "README.md"), "base\n");
    git(["add", "README.md"], work);
    git(["commit", "-q", "-m", "[core] base (SMD-1)"], work);
    const base = git(["rev-parse", "HEAD"], work).stdout.trim();
    git(["push", "-q", "origin", "main"], work); // so the later clones branch from base, not an unborn HEAD
    git(["switch", "-q", "-c", "agent/smd-9-x"], work);
    writeFileSync(join(work, "feature.txt"), "the change\n");
    git(["add", "feature.txt"], work);
    git(["commit", "-q", "-m", "[core] add the feature (SMD-9)"], work);
    git(["push", "-q", "origin", "agent/smd-9-x"], work);

    const deps = (over: Partial<GateDeps> = {}): GateDeps => ({
      git: (args) => git(args, fixture),
      commitlint: () => ({ ok: true, problems: [] }),
      scanSecrets: () => [],
      ...over,
    });
    const input = (over: Partial<GateInput> = {}): GateInput => ({
      bareRepo: bare, base, branch: "agent/smd-9-x", bot: BOT,
      ticket: { identifier: "SMD-9", verify: ["the change is in feature.txt"] },
      workerReport: "I added the change to feature.txt and checked it.", reviewFindings: [{ summary: "a nit", fixed: true }],
      sizeCapBytes: 1_000_000, deps: deps(), ...over,
    });

    await section("the gate passes a clean branch", async () => {
      const r = gate(input());
      await ok(() => r.pass, `clean branch passes${r.pass ? "" : `: ${r.checks.filter((c) => !c.pass).map((c) => c.name + " — " + c.detail).join("; ")}`}`);
      await ok(() => r.checks.some((c) => c.name.startsWith("branch descends") && c.pass) && r.checks.some((c) => c.name === "every commit is the bot's" && c.pass) && r.checks.some((c) => c.name === "no commit is signed" && c.pass), "the branch checks are present and pass");
      await ok(() => r.ciCheckFiles.length === 0, "a diff touching no CI-check file names none");
    });

    await section("the gate fails each bad branch or diff", async () => {
      // A commit by someone other than the bot.
      const w2 = join(fixture, "work2");
      git(["clone", "-q", bare, w2], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-notbot"], w2);
      writeFileSync(join(w2, "x.txt"), "x\n");
      git(["-c", "user.name=Someone Else", "-c", "user.email=else@x", "add", "x.txt"], w2);
      git(["-c", "user.name=Someone Else", "-c", "user.email=else@x", "commit", "-q", "-m", "[core] x (SMD-9)"], w2);
      git(["push", "-q", "origin", "agent/smd-9-notbot"], w2);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-notbot" })); return !r.pass && r.checks.some((c) => c.name === "every commit is the bot's" && !c.pass); }, "a commit not by the bot fails");

      // A subject not naming the ticket.
      const w3 = join(fixture, "work3");
      git(["clone", "-q", bare, w3], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-noticket"], w3);
      writeFileSync(join(w3, "y.txt"), "y\n");
      git(["add", "y.txt"], w3);
      git(["commit", "-q", "-m", "[core] a change with no ticket in the subject"], w3);
      git(["push", "-q", "origin", "agent/smd-9-noticket"], w3);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-noticket" })); return !r.pass && r.checks.some((c) => c.name.includes("names SMD-9") && !c.pass); }, "a subject not naming the ticket fails");

      // commitlint refuses a message.
      await ok(() => { const r = gate(input({ deps: deps({ commitlint: () => ({ ok: false, problems: ["subject may not be empty"] }) }) })); return !r.pass && r.checks.some((c) => c.name === "commit messages pass commitlint" && !c.pass); }, "a commitlint problem fails");

      // One branch each below, each failing exactly one diff check: a refused path, a dependency manifest, a symlink,
      // an oversize file, a refused file type, a binary blob, and a rename.
      const w4 = join(fixture, "work4");
      git(["clone", "-q", bare, w4], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-bad"], w4);
      mkdirSync(join(w4, "db", "migrations"), { recursive: true });
      writeFileSync(join(w4, "db", "migrations", "999_x.sql"), "SELECT 1;\n");
      git(["add", "db/migrations/999_x.sql"], w4);
      git(["commit", "-q", "-m", "[core] touch a migration (SMD-9)"], w4);
      git(["push", "-q", "origin", "agent/smd-9-bad"], w4);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-bad" })); return !r.pass && r.checks.some((c) => c.name === "no refused path in the diff" && !c.pass); }, "a refused path (db/migrations/) fails");

      const w5 = join(fixture, "work5");
      git(["clone", "-q", bare, w5], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-dep"], w5);
      writeFileSync(join(w5, "package.json"), '{"name":"x"}\n');
      git(["add", "package.json"], w5);
      git(["commit", "-q", "-m", "[core] add a dep file (SMD-9)"], w5);
      git(["push", "-q", "origin", "agent/smd-9-dep"], w5);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-dep" })); return !r.pass && r.checks.some((c) => c.name === "no new dependency" && !c.pass); }, "a dependency manifest fails");

      const w6 = join(fixture, "work6");
      git(["clone", "-q", bare, w6], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-link"], w6);
      symlinkSync("/etc/hosts", join(w6, "link"));
      git(["add", "link"], w6);
      git(["commit", "-q", "-m", "[core] add a symlink (SMD-9)"], w6);
      git(["push", "-q", "origin", "agent/smd-9-link"], w6);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-link" })); return !r.pass && r.checks.some((c) => c.name === "no symlink or submodule" && !c.pass); }, "a symlink fails");

      // A typechange: an existing tracked file turned into a symlink (git status "T", not "A"). The gate must still catch
      // it — a repointed file is a way to aim a link at a refused path or an external target.
      const w16 = join(fixture, "work16");
      git(["clone", "-q", bare, w16], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-typelink"], w16);
      rmSync(join(w16, "README.md"));
      symlinkSync("/etc/hosts", join(w16, "README.md"));
      git(["add", "README.md"], w16);
      git(["commit", "-q", "-m", "[core] turn the readme into a symlink (SMD-9)"], w16);
      git(["push", "-q", "origin", "agent/smd-9-typelink"], w16);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-typelink" })); return !r.pass && r.checks.some((c) => c.name === "no symlink or submodule" && !c.pass); }, "a file changed into a symlink (typechange) fails");

      // A submodule (gitlink, mode 160000): crafted with update-index, since a sandboxed session can't add one normally.
      // The gate catches it through the same mode check as a symlink (the other branch of that check).
      const w17 = join(fixture, "work17");
      git(["clone", "-q", bare, w17], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-submodule"], w17);
      git(["update-index", "--add", "--cacheinfo", `160000,${base},vendored-sub`], w17);
      git(["commit", "-q", "-m", "[core] add a gitlink (SMD-9)"], w17);
      git(["push", "-q", "origin", "agent/smd-9-submodule"], w17);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-submodule" })); return !r.pass && r.checks.some((c) => c.name === "no symlink or submodule" && !c.pass); }, "a submodule (gitlink) fails");

      const w7 = join(fixture, "work7");
      git(["clone", "-q", bare, w7], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-big"], w7);
      writeFileSync(join(w7, "big.txt"), "x".repeat(1_000_001));
      git(["add", "big.txt"], w7);
      git(["commit", "-q", "-m", "[core] add a big file (SMD-9)"], w7);
      git(["push", "-q", "origin", "agent/smd-9-big"], w7);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-big" })); return !r.pass && r.checks.some((c) => c.name === "no file over 1 MB" && !c.pass); }, "a file over 1 MB fails");

      // A refused file type: a text file with a refused extension, so only the type check fails (not the binary one).
      const w10 = join(fixture, "work10");
      git(["clone", "-q", bare, w10], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-type"], w10);
      writeFileSync(join(w10, "image.png"), "not really a png, just ascii text\n");
      git(["add", "image.png"], w10);
      git(["commit", "-q", "-m", "[core] add a .png (SMD-9)"], w10);
      git(["push", "-q", "origin", "agent/smd-9-type"], w10);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-type" })); return !r.pass && r.checks.some((c) => c.name === "no refused file type" && !c.pass); }, "a refused file type (.png) fails");

      // A binary blob: NUL bytes under a non-refused extension, so only the binary check fails.
      const w11 = join(fixture, "work11");
      git(["clone", "-q", bare, w11], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-bin"], w11);
      writeFileSync(join(w11, "data.dat"), Buffer.from([0, 1, 2, 0, 3, 255, 0, 7, 0]));
      git(["add", "data.dat"], w11);
      git(["commit", "-q", "-m", "[core] add a binary (SMD-9)"], w11);
      git(["push", "-q", "origin", "agent/smd-9-bin"], w11);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-bin" })); return !r.pass && r.checks.some((c) => c.name === "no binary file in the diff" && !c.pass); }, "a binary file in the diff fails");

      // A rename: the gate reads adds, edits and deletes, so a rename (two paths in one entry) is refused.
      const w12 = join(fixture, "work12");
      git(["clone", "-q", bare, w12], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-rename"], w12);
      git(["mv", "README.md", "READ.md"], w12);
      git(["commit", "-q", "-m", "[core] rename the readme (SMD-9)"], w12);
      git(["push", "-q", "origin", "agent/smd-9-rename"], w12);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-rename" })); return !r.pass && r.checks.some((c) => c.name === "no rename or copy" && !c.pass); }, "a rename fails");

      // A branch that doesn't descend from the base: an orphan root, no shared history (--orphan empties the tree).
      const w13 = join(fixture, "work13");
      git(["clone", "-q", bare, w13], fixture);
      git(["switch", "-q", "--orphan", "agent/smd-9-orphan"], w13);
      writeFileSync(join(w13, "orphan.txt"), "orphan\n");
      git(["add", "orphan.txt"], w13);
      git(["commit", "-q", "-m", "[core] orphan (SMD-9)"], w13);
      git(["push", "-q", "origin", "agent/smd-9-orphan"], w13);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-orphan" })); return !r.pass && r.checks.some((c) => c.name === "branch descends from the base" && !c.pass); }, "a branch not descending from the base fails");

      // A branch at the base with no new commits: nothing over the base (ancestry passes, the commits check fails).
      const w14 = join(fixture, "work14");
      git(["clone", "-q", bare, w14], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-empty"], w14);
      git(["push", "-q", "origin", "agent/smd-9-empty"], w14);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-empty" })); return !r.pass && r.checks.some((c) => c.name === "branch holds the session's commits" && !c.pass); }, "a branch with no commits over the base fails");
    });

    await section("the gate's secret, size, work and CI-file checks", async () => {
      await ok(() => { const r = gate(input({ deps: deps({ scanSecrets: (t) => (t.includes("the change") ? ["a wc_ token"] : []) }) })); return !r.pass && r.checks.some((c) => c.name.startsWith("no secret") && !c.pass); }, "a secret in the diff fails");
      await ok(() => { const r = gate(input({ workerReport: "a wc_ token leaked here", deps: deps({ scanSecrets: (t) => (t.includes("wc_") ? ["a wc_ token"] : []) }) })); return !r.pass && r.checks.find((c) => c.name.startsWith("no secret") && !c.pass)?.detail.includes("report"); }, "a secret in the worker's report fails, named as the report's");
      // A secret added in one commit and removed in the next: gone from the net diff, but in the pushed history. The scan
      // is per-commit, so it is still caught (this fails if the scan reverts to the net diff).
      const w15 = join(fixture, "work15");
      git(["clone", "-q", bare, w15], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-addremove"], w15);
      writeFileSync(join(w15, "leak.txt"), "SEEKRIT-VALUE-abc\n");
      git(["add", "leak.txt"], w15);
      git(["commit", "-q", "-m", "[core] wip add (SMD-9)"], w15);
      git(["rm", "-q", "leak.txt"], w15);
      git(["commit", "-q", "-m", "[core] cleanup (SMD-9)"], w15);
      git(["push", "-q", "origin", "agent/smd-9-addremove"], w15);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-addremove", deps: deps({ scanSecrets: (t) => (t.includes("SEEKRIT-VALUE-abc") ? ["a planted token"] : []) }) })); return !r.pass && r.checks.some((c) => c.name.startsWith("no secret") && !c.pass); }, "a secret added then removed on the branch is still caught");
      await ok(() => { const r = gate(input({ sizeCapBytes: 10 })); return !r.pass && r.checks.some((c) => c.name === "diff under the size cap" && !c.pass); }, "a diff over the size cap fails");
      await ok(() => { const r = gate(input({ workerReport: "" })); return !r.pass && r.checks.some((c) => c.name === "the worker left a report" && !c.pass); }, "an empty report fails");
      await ok(() => { const r = gate(input({ ticket: { identifier: "SMD-9", verify: ["something the report never mentions at all anywhere"] } })); return !r.pass && r.checks.some((c) => c.name === "the report addresses each Verify item" && !c.pass); }, "a Verify item the report never addresses fails");
      await ok(() => { const r = gate(input({ reviewFindings: [{ summary: "", fixed: false }] })); return !r.pass && r.checks.some((c) => c.name === "every review finding is fixed or listed" && !c.pass); }, "an open finding with no text to list fails");
      await ok(() => checkWork(input({ reviewFindings: [{ summary: "x", fixed: false }, { summary: "y", fixed: true }] })).every((c) => c.pass), "an open finding WITH text, and a fixed one, pass the work check");
      // A CI-check file touched: named for the PR body.
      const w8 = join(fixture, "work8");
      git(["clone", "-q", bare, w8], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-ci"], w8);
      mkdirSync(join(w8, "scripts"), { recursive: true });
      writeFileSync(join(w8, "scripts", "check-example.ts"), "export const x = 1;\n");
      git(["add", "scripts/check-example.ts"], w8);
      git(["commit", "-q", "-m", "[core] a checker (SMD-9)"], w8);
      git(["push", "-q", "origin", "agent/smd-9-ci"], w8);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-ci" })); return r.ciCheckFiles.includes("scripts/check-example.ts"); }, "a changed CI-check file is named for the PR body");

      // A merge commit on the branch.
      const w9 = join(fixture, "work9");
      git(["clone", "-q", bare, w9], fixture);
      git(["switch", "-q", "-c", "agent/smd-9-merge"], w9);
      writeFileSync(join(w9, "m.txt"), "m\n");
      git(["add", "m.txt"], w9);
      git(["commit", "-q", "-m", "[core] m (SMD-9)"], w9);
      git(["switch", "-q", "-c", "side", base], w9);
      writeFileSync(join(w9, "s.txt"), "s\n");
      git(["add", "s.txt"], w9);
      git(["commit", "-q", "-m", "[core] s (SMD-9)"], w9);
      git(["switch", "-q", "agent/smd-9-merge"], w9);
      git(["merge", "-q", "--no-ff", "side", "-m", "[core] merge side (SMD-9)"], w9);
      git(["push", "-q", "origin", "agent/smd-9-merge"], w9);
      await ok(() => { const r = gate(input({ branch: "agent/smd-9-merge" })); return !r.pass && r.checks.some((c) => c.name === "no merge commit" && !c.pass); }, "a merge commit fails");
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  if (!process.argv.slice(2).includes("--self-check")) {
    console.error("usage: bun scripts/agent-runner/gate-check.ts --self-check");
    process.exit(2);
  }
  process.exit(await selfCheck());
}
