/**
 * probes-check.ts — the offline self-check of the runner sessions' profile (SMD-4088): the guard's decisions, the
 * profile's settings, environment and command line, the launcher's checks (on a stand-in for Claude Code that prints a
 * scripted stream), the mock Messages API, and the probe stamp. It needs no Claude Code and no network, so CI runs it
 * (`bun scripts/agent-runner/probes.ts --self-check`); the probes themselves run on the pinned Claude Code, on macOS.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  GIT_LOCAL, INPUTS, REAL_FS, START_FLAGS, TOOLS, appendLog, decide, globProblem, joined, main as guardMain, parseGuardArgs, plainPath, realOf, refusedPart, shapeVerdict, shownText, within, words,
  type Fs, type GuardConfig, type Role,
} from "./guard.ts";
import { callId, reply, requestText, startMock, systemText } from "./mock-api.ts";
import {
  CREDENTIAL_VARS, GUARD_TIMEOUT_S, PROFILE_FILES, guardLog, pathsProblem, profileHashes, profileProblem, sessionArgs, sessionEnv, settingsFile, settingsFor, settingsText, sha256Hex, tmpMax,
  type SessionPaths,
} from "./profile.ts";
import { BRIEF_PROBE, BRIEF_TICKET, DEFERRED, PROBES, briefVerdict, hostStamp, main as probesMain, parseArgs, stampProblem } from "./probes.ts";
import { REAL_DEPS, descendantsOf, fileSha256, initProblem, loggedIds, readNoFollow, resultText, runSession, writeNoFollow, type Pinned, type SessionOutcome, type SessionSpec } from "./session.ts";
import { buildBrief, ticketProblem } from "./brief.ts";

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  /** One case. Its check runs inside, so a throw fails this case by name and the cases after it still run. */
  const ok = async (check: () => unknown, what: string): Promise<void> => {
    let pass = false;
    let note = "";
    try {
      pass = Boolean(await check());
    } catch (e) {
      note = ` (it threw: ${shownText((e as Error)?.message ?? e, 160)})`;
    }
    if (pass) passed++;
    else failed++;
    console.log(`  ${pass ? "✓" : "✗"} ${what}${note}`);
  };
  /** A group of cases. A throw in its setup fails the group by name, and the next group still runs. */
  const section = async (name: string, body: () => Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: its setup threw (${shownText((e as Error)?.message ?? e, 160)})`);
    }
  };
  const chr = (cp: number) => String.fromCodePoint(cp);
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "obr-check-")));

  try {
    await section("the guard's words", async () => {
      const w = (s: string) => words(s);
      const refused = (s: string) => !Array.isArray(w(s));
      await ok(() => JSON.stringify(w("git status")) === JSON.stringify(["git", "status"]), "plain words, split on spaces");
      await ok(() => JSON.stringify(w("git commit -m \"[core] Fix it (SMD-1)\"")) === JSON.stringify(["git", "commit", "-m", "[core] Fix it (SMD-1)"]), "double quotes keep brackets, parentheses and spaces");
      await ok(() => JSON.stringify(w("git commit -m 'a; b | c > d'")) === JSON.stringify(["git", "commit", "-m", "a; b | c > d"]), "single quotes keep everything to the next quote");
      await ok(() => JSON.stringify(w("git commit -m 'it''s'")) === JSON.stringify(["git", "commit", "-m", "its"]) && JSON.stringify(w("a\"b\"'c'")) === JSON.stringify(["abc"]), "quoted parts join into one word, as the shell joins them");
      await ok(() => JSON.stringify(w(`git commit -m "${chr(0xe9)}t${chr(0xe9)}"`)) === JSON.stringify(["git", "commit", "-m", `${chr(0xe9)}t${chr(0xe9)}`]) && refused(`git log ${chr(0xe9)}`), "letters past ASCII in quotes, never outside them");
      for (const [s, what] of [
        ["git status; git push", "`;`"], ["git status && git push", "`&&`"], ["git log | head", "a pipe"], ["git log > out", "a redirection"], ["git apply < p", "an input redirection"],
        ["git log $(id)", "a command substitution"], ["git log `id`", "a backtick"], ["git log $HOME", "a variable"], ["git add *.ts", "a glob"], ["git add file?.ts", "a ? glob"],
        ["git add [ab].ts", "a bracket glob"], ["cd ~", "a tilde"], ["git add a\\ b", "a backslash"], ["git status # x", "a comment"], ["git add {a,b}", "braces"],
        ["(git status)", "a subshell"], ["=git status", "a word starting with ="], ["git commit -m \"$x\"", "$ in double quotes"], ["git commit -m \"a`b`\"", "a backtick in double quotes"],
        ["git commit -m \"a\\b\"", "a backslash in double quotes"], ["git commit -m \"a!\"", "! in double quotes"], ["git commit -m \"open", "an unclosed double quote"], ["git commit -m 'open", "an unclosed single quote"],
        ["git status\ngit push", "a newline"], ["git\tstatus", "a tab"], ["", "an empty command"], ["   ", "spaces alone"], [`git status${chr(0x2800)}`, "a Braille blank"], [`git st${chr(0x200b)}atus`, "a zero-width space"],
        ["git log ^HEAD", "a caret (a zsh glob)"], ["git log !x", "a bare ! outside quotes"], ['""=foo', "= after an empty quote (zsh EQUALS expansion)"], ["''=foo", "= after an empty single quote"],
        [`git commit -m 'a${chr(0x0a)}b'`, "a newline inside single quotes"], [`git commit -m "a${chr(0x202e)}b"`, "a bidi override inside double quotes"], [`git commit -m 'a${chr(0x2800)}b'`, "a Braille blank inside quotes"],
      ] as const) await ok(() => refused(s), `refuses ${what}`);
      // A `=` that is NOT at the word's start, and a quoted `=`, are allowed: those don't trigger zsh's EQUALS expansion.
      await ok(() => JSON.stringify(w("bun run --out=x a.ts")) === JSON.stringify(["bun", "run", "--out=x", "a.ts"]) && JSON.stringify(w("git commit -m \"a=b\"")) === JSON.stringify(["git", "commit", "-m", "a=b"]), "a = later in the word, or inside quotes, is kept");
    });

    await section("the guard's paths", async () => {
      await ok(() => plainPath("/a/b") === "/a/b" && plainPath("/a-b/c.d_e@f+g") === "/a-b/c.d_e@f+g", "plain absolute paths pass");
      await ok(() => [plainPath("a/b"), plainPath("/a//b"), plainPath("/a/./b"), plainPath("/a/../b"), plainPath("/"), plainPath("/a/"), plainPath(`/a${chr(0x200b)}`), plainPath(3), plainPath("")].every((x) => x === null), "relative, doubled, dot, dot-dot, root, trailing-slash, hidden and non-string paths fail");
      await ok(() => within("/a/b", "/a") && within("/a", "/a") && !within("/ab", "/a") && !within("/a", "/a/b"), "within: the base or under it, never a sibling that shares its prefix");
      await ok(() => joined("x/y", "/r") === "/r/x/y" && joined("/abs", "/r") === "/abs" && joined("../x", "/r") === null && joined("", "/r") === null && joined(1, "/r") === null, "joined: relative to the working directory, plain, or null");
      const root = join(fixture, "paths", "root");
      const outside = join(fixture, "paths", "outside");
      mkdirSync(join(root, "sub"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(root, "a.ts"), "x");
      writeFileSync(join(outside, "secret.txt"), "s");
      symlinkSync(outside, join(root, "link"));
      symlinkSync(join(fixture, "paths", "nowhere"), join(root, "dangling"));
      await ok(() => realOf(join(root, "a.ts")) === join(root, "a.ts") && realOf(join(root, "new", "deeper.ts")) === join(root, "new", "deeper.ts"), "a real path, and one whose tail doesn't exist yet");
      await ok(() => realOf(join(root, "link", "secret.txt")) === join(outside, "secret.txt") && realOf(join(root, "link", "new.txt")) === join(outside, "new.txt"), "through a link, to where it really leads");
      await ok(() => realOf(join(root, "dangling", "x")) === null && realOf(join(root, "dangling")) === null, "a dangling link can't be followed: null");
      await ok(() => realOf(join(root, "a.ts", "x")) === null, "a path through a file: null");
      await ok(() => realOf("/obr-surely-not-a-top-level-directory/x") === null, "a path none of which exists: null");
      if (process.platform === "darwin") await ok(() => realOf(join(root, "A.TS").replace(fixture, fixture.toUpperCase())) === join(root, "a.ts"), "macOS: a path in another case resolves to the real one");
      const fakeFs: Fs = { realpath: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, lstat: () => ({}), isDir: () => false };
      await ok(() => realOf("/a/b", fakeFs) === null, "a part the guard can't read: null");
    });

    await section("the refused paths", async () => {
      for (const p of [
        ".git/config", "sub/.git/hooks/pre-commit", ".git", ".claude/settings.json", "x/.claude/skills/s/SKILL.md", ".github/workflows/a.yml", "deploy/compose.yaml", "scripts/agent-runner/guard.ts",
        "db/migrations/001_x.sql", "server-portable/auth/x.ts", "plugins/p/auth/y.ts", "server-portable/auth.ts", "x/auth.ts", "server-portable/keygen.ts", "server-portable/pass-key.ts",
        "server-portable/oauth-as.ts", "server-portable/core/caller.ts", "CLAUDE.md", "docs/CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "bunfig.toml", "x/bunfig.toml", "package.json",
        "rest-client/package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", ".mcp.json", "x/.mcp.json",
        ".GIT/config", "Package.JSON", "Deploy/x", "SCRIPTS/Agent-Runner/x", "claude.md", "DB/Migrations/1.sql", "Server-Portable/KeyGen.ts",
      ]) await ok(() => refusedPart(p) !== null, `refuses ${p}`);
      for (const p of [
        "docs/agent-runner.md", "scripts/check-consistency.ts", "server-portable/core/reads.ts", "server-portable/oauth.md", "server-portable/sub/oauth-x.ts", "authors.md", "author/x.ts",
        "deployment.md", "db/migrations.md", "scripts/agent-runner.md", "github/x", "my.git.md", "claude.mdx", "docs/package.md", "x.claude",
      ]) await ok(() => refusedPart(p) === null, `allows ${p}`);
    });

    // A session's reach for the guard's decisions: a root with files, a link out, a link to a refused place, a temp directory, a record.
    const g = join(fixture, "guard");
    const gRoot = join(g, "root");
    const gTmp = join(g, "tmp");
    const gOut = join(g, "outside");
    const gRecord = join(g, "record");
    for (const d of [join(gRoot, "sub"), join(gRoot, ".git"), join(gRoot, ".github"), join(gRoot, "docs"), gTmp, gOut, gRecord]) mkdirSync(d, { recursive: true });
    writeFileSync(join(gRoot, "a.ts"), "x");
    writeFileSync(join(gRoot, ".git", "config"), "[core]\n");
    writeFileSync(join(gOut, "x.ts"), "x");
    symlinkSync(gOut, join(gRoot, "link"));
    symlinkSync(join(gRoot, ".github"), join(gRoot, "docslink"));
    const worker: GuardConfig = { role: "worker", root: gRoot, tmp: gTmp, log: join(gRecord, "guard-worker.log") };
    const review: GuardConfig = { ...worker, role: "review", log: join(gRecord, "guard-review.log") };
    const call = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_1", cwd: gRoot, session_id: "s", ...extra });
    const passes = (raw: unknown, cfg = worker) => !decide(raw, cfg).deny;
    const denies = (raw: unknown, cfg = worker) => decide(raw, cfg).deny;
    const bash = (command: string, extra: Record<string, unknown> = {}) => call("Bash", { command, description: "d", ...extra });

    await section("the guard's Bash shapes", async () => {
      const shape = (cmd: string, cwd = gRoot) => {
        const argv = words(cmd);
        return Array.isArray(argv) && !shapeVerdict(argv, cwd, worker, REAL_FS).deny;
      };
      for (const c of ["cd sub", `cd ${gRoot}/sub`, `cd ${gTmp}`, "git status", "git diff --stat", "git log -1 --format=%s", "git add a.ts", "git commit -m \"[core] x (SMD-1)\"", `git bundle create ${gTmp}/b.bundle HEAD`, "bun a.ts", "bun a.ts --self-check", `bun ${START_FLAGS.join(" ")} a.ts`, "bun test", "bun test x.test.ts", "bun run check", "bun run a.ts", "bunx tsc --noEmit", "bunx tsc", "bun x tsc -p scripts/tsconfig.json"]) await ok(() => shape(c), `passes ${c}`);
      for (const c of ["cd", "cd a b", "cd sub extra", "cd link", "cd a.ts", `cd ${gOut}`, "git", "git push origin HEAD", "git -C . push", "git config user.name x", "git remote -v", "git fetch", "git pull", "git clone x", "git submodule add x", "git worktree add ../w", "git ls-remote", "git tag v9", `git bundle create ${gRoot}/b.bundle HEAD`, `git bundle create ${gOut}/b.bundle HEAD`, `git bundle create ${gTmp} HEAD`, `git bundle create ${gTmp}/b.bundle`, "git bundle verify x", "git bundle unbundle x", "bun", "bun -e 'x'", "bun --eval x", "bun install", "bun add x", "bun link/x.ts", `bun ${gOut}/x.ts`, `bun ${gTmp}/x.ts`, "bun --preload=/tmp/x.ts a.ts", "bun --cwd /tmp a.ts", "bun run", `bun run ${gOut}/x.ts`, `bun run ${gTmp}/x.ts`, "bunx eslint", "bun x eslint", "bun a.txt", "ls", "curl x", "env git status", "sh -c 'git push'", "gh pr list", "podman ps", "./git status"]) await ok(() => !shape(c), `refuses ${c}`);
      await ok(() => [...GIT_LOCAL].every((s) => !["push", "fetch", "pull", "clone", "remote", "config", "submodule", "worktree", "ls-remote", "send-email", "daemon", "credential", "tag"].includes(s)), "no remote, config, worktree, submodule or tag subcommand is among git's local ones");
    });

    await section("the guard's decisions", async () => {
      await ok(() => passes(call("Read", { file_path: join(gRoot, "a.ts") })) && passes(call("Read", { file_path: join(gTmp, "out.txt") })), "Read in the clone and the temp directory passes");
      await ok(() => denies(call("Read", { file_path: join(gOut, "x.ts") })) && denies(call("Read", { file_path: join(gRoot, "link", "x.ts") })), "Read outside, or through a link out, is denied");
      await ok(() => denies(call("Read", { file_path: "a.ts" })) && denies(call("Read", { file_path: `${gRoot}/sub/../a.ts` })) && denies(call("Read", { file_path: `${gRoot}/./a.ts` })), "Read of a relative path, or one with a . or .. part, is denied");
      await ok(() => passes(call("Edit", { file_path: join(gRoot, "a.ts"), old_string: "x", new_string: "y" })) && passes(call("Write", { file_path: join(gRoot, "new", "n.ts"), content: "x" })), "Edit and Write in the clone, a new directory too, pass");
      await ok(() => denies(call("Write", { file_path: join(gTmp, "msg.txt"), content: "x" })) && denies(call("Edit", { file_path: join(gTmp, "claude-501", "bash-edit-diff"), old_string: "a", new_string: "b" })), "Edit and Write to the temp directory are denied (only the shell writes it; it is Claude Code's staging)");
      await ok(() => denies(call("Edit", { file_path: join(gRoot, ".git", "config"), old_string: "a", new_string: "b" })) && denies(call("Write", { file_path: join(gRoot, "CLAUDE.md"), content: "x" })) && denies(call("Write", { file_path: join(gRoot, ".claude", "settings.json"), content: "x" })), "Edit and Write of .git/config, CLAUDE.md and .claude/settings.json are denied");
      await ok(() => denies(call("Write", { file_path: join(gRoot, "docslink", "w.yml"), content: "x" })), "a Write through a link into a refused path is denied (where it really lands)");
      rmSync(join(gRoot, ".github"), { recursive: true });
      symlinkSync(join(gRoot, "docs"), join(gRoot, ".github"));
      await ok(() => denies(call("Write", { file_path: join(gRoot, ".github", "w.yml"), content: "x" })), "a Write to a refused name that is a link elsewhere is denied (as written)");
      await ok(() => denies(call("Write", { file_path: gRoot, content: "x" })) && denies(call("Write", { file_path: join(gOut, "x.ts"), content: "x" })), "a Write to the root itself, or outside, is denied");
      await ok(() => passes(call("Grep", { pattern: "x" })) && passes(call("Grep", { pattern: "x", path: "sub" })) && passes(call("Grep", { pattern: "x", path: gRoot, glob: "**/*.ts" })), "Grep in the clone passes, its path relative or absolute");
      await ok(() => denies(call("Grep", { pattern: "x", path: gOut })) && denies(call("Grep", { pattern: "x", glob: "../**" })) && denies(call("Grep", { pattern: "x", glob: "/etc/*" })) && denies(call("Grep", { pattern: "x", glob: "~/x" })), "Grep outside, or with a glob that climbs out, is denied");
      await ok(() => passes(call("Glob", { pattern: "**/*.ts" })) && denies(call("Glob", { pattern: "../**" })) && denies(call("Glob", { pattern: "*", path: gOut })), "Glob in the clone passes; one climbing out or rooted outside is denied");
      await ok(() => passes(bash("git status")) && passes(bash("git status", { dangerouslyDisableSandbox: false, allowed_domains: [], run_in_background: false, timeout: 1000 })), "Bash of a listed shape passes, with its harmless inputs at their defaults");
      await ok(() => denies(bash("git status", { dangerouslyDisableSandbox: true })) && denies(bash("git status", { allowed_domains: ["example.com"] })) && denies(bash("git status", { run_in_background: true })), "dangerouslyDisableSandbox, allowed_domains and run_in_background are denied");
      await ok(() => denies(call("Bash", { command: 3 })) && denies(bash("git status; ls")), "a command that isn't a string, or has shell syntax, is denied");
      await ok(() => denies(call("Bash", { command: "git status", shell: "/bin/sh" })) && denies(call("Read", { file_path: join(gRoot, "a.ts"), follow: true })), "an input the guard doesn't know is denied");
      await ok(() => ["Task", "Agent", "WebFetch", "WebSearch", "NotebookEdit", "mcp__brain__search", "MultiEdit", "constructor", "toString"].every((t) => denies(call(t, {}))), "a tool outside the worker's list, a prototype name among them, is denied");
      await ok(() => passes(call("Read", { file_path: join(gRoot, "a.ts") }), review) && passes(call("Grep", { pattern: "x" }), review) && ["Bash", "Edit", "Write"].every((t) => denies(call(t, { command: "git status", file_path: join(gRoot, "a.ts"), content: "x", old_string: "a", new_string: "b" }), review)), "the review reads and searches, and runs and writes nothing");
      await ok(() => denies("text") && denies(null) && denies([]) && denies({ ...call("Read", { file_path: join(gRoot, "a.ts") }), hook_event_name: "PostToolUse" }), "a call that isn't an object, or another hook event, is denied");
      await ok(() => denies(call("Read", { file_path: join(gRoot, "a.ts") }, { tool_use_id: "" })) && denies(call("Read", { file_path: join(gRoot, "a.ts") }, { tool_use_id: `t${chr(0x202e)}` })) && denies(call("Read", { file_path: join(gRoot, "a.ts") }, { tool_use_id: undefined })), "a call without a plain tool_use_id is denied: its decision couldn't be logged by it");
      await ok(() => denies(call("Read", { file_path: join(gRoot, "a.ts") }, { cwd: gOut })) && denies(call("Read", { file_path: join(gRoot, "a.ts") }, { cwd: undefined })) && passes(call("Read", { file_path: join(gRoot, "a.ts") }, { cwd: gTmp })), "a working directory outside the root and temp directory denies every call");
      await ok(() => decide(bash("ls /"), worker).why.length > 0 && decide(bash("ls /"), worker).id === "toolu_1" && decide(bash("ls /"), worker).tool === "Bash", "a decision carries the call's id, its tool and its reason");
      await ok(() => Object.keys(INPUTS).every((t) => TOOLS.worker.includes(t)) && TOOLS.review.every((t) => TOOLS.worker.includes(t)), "every tool with inputs is the worker's, and the review's are a part of them");
      await ok(() => globProblem(undefined) === null && globProblem("") !== null && globProblem(3) !== null && globProblem("a/../b") !== null && globProblem("a\\..\\b") !== null, "a glob: absent is fine; empty, non-string or climbing is not");
    });

    await section("the guard's options and its run", async () => {
      const args = ["--role", "worker", "--root", gRoot, "--tmp", gTmp, "--log", worker.log];
      const parsed = parseGuardArgs(args);
      await ok(() => !("error" in parsed) && parsed.root === gRoot && parsed.role === "worker", "its options parse");
      const err = (a: string[]) => "error" in parseGuardArgs(a);
      await ok(() => err(args.slice(0, 6)) && err([...args, "--role", "review"]) && err([...args, "--x", "y"]) && err(["--role", "boss", ...args.slice(2)]), "a missing, repeated or unknown option, or another role, is refused");
      await ok(() => err(["--role", "worker", "--root", join(gRoot, "link"), "--tmp", gTmp, "--log", worker.log]) && err(["--role", "worker", "--root", join(g, "none"), "--tmp", gTmp, "--log", worker.log]), "a root that isn't a directory's real path is refused");
      await ok(() => err(["--role", "worker", "--root", gRoot, "--tmp", join(gRoot, "sub"), "--log", worker.log]) && err(["--role", "worker", "--root", gRoot, "--tmp", gTmp, "--log", join(gRoot, "g.log")]) && err(["--role", "worker", "--root", gRoot, "--tmp", gTmp, "--log", join(g, "none", "g.log")]), "a temp directory inside the root, a log inside the reach, or a log in no directory is refused");
      const lines: string[] = [];
      const errs: string[] = [];
      const run = (stdin: string, extra: Partial<Parameters<typeof guardMain>[0]> = {}) => guardMain({ argv: args, execArgv: START_FLAGS, stdin: async () => stdin, err: (s) => errs.push(s), now: () => "T", append: (_p, l) => lines.push(l), ...extra });
      await ok(async () => (await run(JSON.stringify(bash("git status")))) === 0 && JSON.parse(lines.at(-1) ?? "{}").decision === "pass" && JSON.parse(lines.at(-1) ?? "{}").id === "toolu_1", "a pass exits 0, says nothing and logs the pass by id");
      await ok(async () => (await run(JSON.stringify(bash("ls /")))) === 2 && (errs.at(-1) ?? "").startsWith("The agent runner's guard refused this call") && JSON.parse(lines.at(-1) ?? "{}").decision === "deny", "a deny exits 2, its reason on stderr, and logs the deny");
      await ok(async () => (await run("{not json")) === 2 && JSON.parse(lines.at(-1) ?? "{}").id === null, "input that isn't JSON is denied and logged without an id");
      await ok(async () => (await run(JSON.stringify(bash("git status")), { execArgv: [] })) === 2 && (errs.at(-1) ?? "").includes("--no-env-file"), "a guard started without the start flags denies");
      await ok(async () => (await run(JSON.stringify(bash("git status")), { argv: ["--role", "worker"] })) === 2, "a guard with wrong options denies");
      await ok(async () => (await run(JSON.stringify(bash("git status")), { append: () => { throw new Error("disk full"); } })) === 2 && (errs.at(-1) ?? "").includes("couldn't log"), "a decision it can't log is a deny");
      const throwing: Fs = { ...REAL_FS, isDir: (d) => { if (d.endsWith("/sub")) throw new Error("boom"); return REAL_FS.isDir(d); } };
      await ok(async () => (await run(JSON.stringify(bash("cd sub")), { fs: throwing })) === 2 && JSON.parse(lines.at(-1) ?? "{}").why.includes("own error"), "an error of its own while deciding is a logged deny");
      const before = lines.length;
      await ok(async () => (await run(JSON.stringify(bash("git status")), { fs: { ...REAL_FS, isDir: () => { throw new Error("boom"); } } })) === 2 && lines.length === before, "an error of its own before it has its options is a deny with nothing logged, which the runner's log check catches");
    });

    const p = (over: Partial<SessionPaths> = {}): SessionPaths => ({
      install: "/inst", bun: "/b/bin/bun", git: "/dev/usr/bin/git", root: "/runs/r1/root", tmp: "/private/tmp/obr-1234abcd", record: "/runs/r1/record", configDir: "/runs/r1/config",
      keyFile: "/cfg/anthropic.key", gitConfig: "/inst/gitconfig", home: "/Users/m", ...over,
    });

    await section("the profile is exactly the golden literal", async () => {
      // The profile's settings, environment and command line are compared to a literal written out here, not to the
      // function that produces them: a circular check (settingsFor vs settingsFor) catches no edit to settingsFor. A
      // deep, strict equal means any widening — CLAUDE_CONFIG_DIR -> ~/.claude, GIT_CONFIG_GLOBAL -> ~/.gitconfig,
      // Bash(git *) -> Bash(*), an extra --add-dir, additionalDirectories -> ["/"] — fails this section by name.
      const guardCmd = (role: Role) => `cd '/inst' && exec /usr/bin/env -i HOME='/Users/m' BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 '/b/bin/bun' --no-env-file --config=/dev/null '/inst/scripts/agent-runner/guard.ts' --role ${role} --root '/runs/r1/root' --tmp '/private/tmp/obr-1234abcd' --log '/runs/r1/record/guard-${role}.log'`;
      const sandbox = (allowWrite: string[]) => ({
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false,
        filesystem: {
          allowWrite,
          denyRead: ["/Users/m", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
          allowRead: ["/runs/r1/root", "/private/tmp/obr-1234abcd", "/inst/gitconfig", "/b/bin/bun", "/b/bin/bunx"],
        },
        network: { allowedDomains: [] },
        credentials: { envVars: CREDENTIAL_VARS.map((name) => ({ name, mode: "deny" })) },
      });
      const permissions = (allow: string[]) => ({
        allow, deny: ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"],
        blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true, disableBypassPermissionsMode: "disable",
      });
      const goldenWorker = {
        apiKeyHelper: "/bin/cat '/cfg/anthropic.key'",
        sandbox: sandbox(["/runs/r1/root", "/private/tmp/obr-1234abcd"]),
        // The leading `//` is required by Claude Code's permission matcher (a single slash denies every write); the
        // commit-as-bot and guard-exit-0-nonsense live probes prove it, and this golden pins the exact strings.
        permissions: permissions(["Edit(//runs/r1/root/**)", "Write(//runs/r1/root/**)", "Bash(cd *)", "Bash(git *)", "Bash(bun *)", "Bash(bunx tsc)", "Bash(bunx tsc *)"]),
        autoMemoryEnabled: false,
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCmd("worker"), timeout: 15, onFailure: "block" }] }] },
      };
      const goldenReview = {
        apiKeyHelper: "/bin/cat '/cfg/anthropic.key'",
        sandbox: sandbox(["/private/tmp/obr-1234abcd"]),
        permissions: permissions([]),
        autoMemoryEnabled: false,
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCmd("review"), timeout: 15, onFailure: "block" }] }] },
      };
      await ok(() => Bun.deepEquals(settingsFor("worker", p()), goldenWorker, true), "the worker's settings deep-equal the golden literal");
      await ok(() => Bun.deepEquals(settingsFor("review", p()), goldenReview, true), "the review's settings deep-equal the golden literal");
      await ok(() => GUARD_TIMEOUT_S === 15, "the guard timeout is 15 s (pinned in the golden above)");

      const goldenEnv: Record<string, string> = {
        HOME: "/Users/m", PATH: "/b/bin:/dev/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin", USER: "m", LOGNAME: "m", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
        TMPDIR: "/private/tmp/obr-1234abcd", CLAUDE_CODE_TMPDIR: "/private/tmp/obr-1234abcd", CLAUDE_CONFIG_DIR: "/runs/r1/config",
        GIT_CONFIG_GLOBAL: "/inst/gitconfig", GIT_CONFIG_NOSYSTEM: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        XDG_CONFIG_HOME: "/private/tmp/obr-1234abcd/xdg/config", XDG_CACHE_HOME: "/private/tmp/obr-1234abcd/xdg/cache",
        XDG_DATA_HOME: "/private/tmp/obr-1234abcd/xdg/data", XDG_STATE_HOME: "/private/tmp/obr-1234abcd/xdg/state",
      };
      await ok(() => Bun.deepEquals(sessionEnv(p(), "m"), goldenEnv, true), "the session environment deep-equals the golden literal (no credential, no SSH agent, exact values)");
      await ok(() => Bun.deepEquals(sessionEnv(p(), "m", "http://127.0.0.1:1"), { ...goldenEnv, ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }, true), "a base URL adds exactly ANTHROPIC_BASE_URL and nothing else");

      const limits = { model: "claude-opus-5-5", effort: "xhigh", maxTurns: 40, maxBudgetUsd: 10 };
      const goldenArgs = (role: Role, resume?: string) => [
        "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--settings", `/runs/r1/record/settings-${role}.json`, "--setting-sources", "user", "--strict-mcp-config",
        "--tools", role === "worker" ? "Read,Grep,Glob,Edit,Write,Bash" : "Read,Grep,Glob",
        "--max-turns", "40", "--max-budget-usd", "10", "--model", "claude-opus-5-5", "--effort", "xhigh",
        ...(resume === undefined ? [] : ["--resume", resume]),
      ];
      await ok(() => Bun.deepEquals(sessionArgs("worker", p(), limits), goldenArgs("worker"), true), "the worker's command line deep-equals the golden literal");
      await ok(() => Bun.deepEquals(sessionArgs("review", p(), limits), goldenArgs("review"), true), "the review's command line deep-equals the golden literal");
      await ok(() => Bun.deepEquals(sessionArgs("worker", p(), limits, "sess-1"), goldenArgs("worker", "sess-1"), true), "a resume adds exactly --resume <id> at the end");
      await ok(() => !settingsText("worker", p()).includes("bypassPermissions") && !settingsText("worker", p()).includes("dangerously") && !JSON.stringify(sessionArgs("worker", p(), limits)).includes("dangerously"), "the profile never names a skip-all-permissions mode");
      await ok(() => guardLog("/r", "worker") === "/r/guard-worker.log" && settingsFile("/r", "review") === "/r/settings-review.json", "the guard's log and the settings file sit in the record, one per role");
    });

    await section("the frozen allowlists", async () => {
      // Each allowlist is compared to a literal, not to its own length or a denylist of known-bad names: adding a
      // dangerous git subcommand or a tool input would otherwise slip (it is absent from a denylist, and the length grew).
      await ok(() => Bun.deepEquals([...GIT_LOCAL].sort(), [
        "add", "apply", "blame", "branch", "bundle", "cat-file", "checkout", "cherry-pick", "clean", "commit", "describe", "diff", "diff-tree", "grep",
        "log", "ls-files", "merge-base", "mv", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "stash", "status", "switch",
      ].sort()), "GIT_LOCAL is exactly the expected set (no push/fetch/remote/config/worktree/submodule/tag)");
      await ok(() => Bun.deepEquals(INPUTS.Read, ["file_path", "offset", "limit", "pages", "allow_large"]) && Bun.deepEquals(INPUTS.Glob, ["pattern", "path"]) && Bun.deepEquals(INPUTS.Edit, ["file_path", "old_string", "new_string", "replace_all"]) && Bun.deepEquals(INPUTS.Write, ["file_path", "content"]), "the Read/Glob/Edit/Write input allowlists are exactly as expected");
      await ok(() => Bun.deepEquals(INPUTS.Grep, ["pattern", "path", "glob", "output_mode", "-B", "-A", "-C", "context", "-n", "-i", "-o", "type", "head_limit", "offset", "multiline"]) && Bun.deepEquals(INPUTS.Bash, ["command", "timeout", "description", "run_in_background", "dangerouslyDisableSandbox", "allowed_domains"]), "the Grep and Bash input allowlists are exactly as expected (no extra input slips)");
      await ok(() => Bun.deepEquals(TOOLS.worker, ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]) && Bun.deepEquals(TOOLS.review, ["Read", "Grep", "Glob"]), "the worker's and review's tool sets are exactly as expected");
      await ok(() => Bun.deepEquals([...CREDENTIAL_VARS].sort(), [
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DATABASE_URL", "GH_ENTERPRISE_TOKEN",
        "GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "LINEAR_COMMENT_API_KEY", "MCP_ACCESS_KEYS", "NPM_TOKEN", "OPENAI_API_KEY", "PGPASSWORD", "SSH_AUTH_SOCK",
      ].sort()), "CREDENTIAL_VARS names every credential by name (dropping one, or lowercasing it, fails here)");
      await ok(() => Bun.deepEquals(PROFILE_FILES, [
        "scripts/agent-runner/guard.ts", "scripts/agent-runner/profile.ts", "scripts/agent-runner/session.ts",
        "scripts/agent-runner/select.ts", "scripts/agent-runner/probes.ts", "scripts/agent-runner/mock-api.ts",
      ]), "PROFILE_FILES is exactly the session's layers and the probes (dropping guard.ts would let an edited guard run unre-probed)");
    });

    await section("paths and the written-profile check", async () => {
      await ok(() => pathsProblem(p(), 501) === null && tmpMax(501) === 33 && tmpMax(1000) === 32, "plain paths pass; the temp directory's limit follows the uid");
      for (const [over, what] of [
        [{ root: "/runs/r 1/root" }, "a space"], [{ root: "/runs/r'1/root" }, "a quote"], [{ root: "runs/root" }, "a relative path"], [{ root: "/runs/../root" }, "a .. part"],
        [{ tmp: "/private/tmp/obr-1234abcd-and-more-x" }, "a temp directory too long for Claude Code"], [{ tmp: "/runs/r1/root/tmp" }, "a temp directory in the root"],
        [{ record: "/runs/r1/root/record" }, "a record in the root"], [{ tmp: "/runs/r1/record/t" }, "a temp directory in the record"], [{ record: "/private/tmp/obr-1234abcd/rec" }, "a record in the temp directory"],
        [{ install: "/runs/r1/root" }, "an install that is the root"], [{ configDir: "/private/tmp/obr-1234abcd/c" }, "a config directory in the temp directory"],
        [{ configDir: "/runs/r1/root/cfg" }, "a config directory in the root"], [{ configDir: "/runs/r1/record/cfg" }, "a config directory in the record"], [{ install: "/private/tmp/obr-1234abcd/i" }, "an install inside the temp directory"],
      ] as const) await ok(() => pathsProblem(p(over), 501) !== null, `refuses paths with ${what}`);
      // profileProblem must reject even when the written text matches its template but the paths are bad: pass the same
      // bad root to both the written text and the paths, so only the pathsProblem branch can catch it.
      const badRoot = p({ root: "/x y" });
      await ok(() => profileProblem(settingsText("worker", p()), "worker", p(), 501) === null && profileProblem(`${settingsText("worker", p())} `, "worker", p(), 501) !== null && profileProblem(settingsText("review", p()), "worker", p(), 501) !== null && profileProblem(settingsText("worker", p()), "worker", badRoot, 501) !== null && profileProblem(settingsText("worker", badRoot), "worker", badRoot, 501) !== null, "a written profile is its template with valid session paths, byte for byte, or it is refused (bad paths too, even when the text matches)");
      await ok(() => JSON.stringify(Object.keys(profileHashes("/inst", (f) => f))) === JSON.stringify(PROFILE_FILES) && profileHashes("/inst", (f) => f)[PROFILE_FILES[0]] === sha256Hex(`/inst/${PROFILE_FILES[0]}`), "the stamp hashes every profile file of the install");
    });

    await section("the launcher's checks", async () => {
      const pinned: Pinned = { path: "/c", sha256: "x", version: "2.1.319" };
      const limits = { model: "claude-opus-5-5", effort: "low", maxTurns: 3, maxBudgetUsd: 1 };
      const init = { type: "system", subtype: "init", claude_code_version: "2.1.319", permissionMode: "dontAsk", apiKeySource: "apiKeyHelper", tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"], mcp_servers: [], model: "claude-opus-5-5", cwd: "/root" };
      await ok(() => initProblem(init, "worker", pinned, limits, "/root") === null, "a good init passes");
      for (const [over, what] of [
        [{ claude_code_version: "2.1.320" }, "another version"], [{ permissionMode: "default" }, "another permission mode"], [{ apiKeySource: "none" }, "a key that isn't the helper's (settings that didn't load)"],
        [{ tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write", "Task"] }, "an extra tool"], [{ tools: ["Bash", "Read"] }, "a missing tool"], [{ tools: ["Bash", "Edit", "Glob", "Grep", "Read"] }, "the worker's tools missing only the last sorted one (a sorted prefix)"], [{ tools: "Bash" }, "tools that aren't a list"], [{ tools: [1, 2, 3, 4, 5, 6] }, "tools that aren't names"],
        [{ mcp_servers: [{ name: "x" }] }, "an MCP server"], [{ mcp_servers: undefined }, "no MCP list"], [{ model: "claude-haiku" }, "another model"], [{ cwd: "/elsewhere" }, "another working directory"],
      ] as const) await ok(() => initProblem({ ...init, ...over }, "worker", pinned, limits, "/root") !== null, `an init with ${what} is refused`);
      await ok(() => initProblem({ ...init, tools: ["Glob", "Grep", "Read"] }, "review", pinned, limits, "/root") === null, "the review's init carries its three tools");
      const logFile = join(fixture, "ids.log");
      writeFileSync(logFile, `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "b" })}\n{"id": "c`);
      await ok(() => loggedIds(logFile).has("a") && loggedIds(logFile).has("b") && !loggedIds(logFile).has("c") && loggedIds(join(fixture, "none.log")).size === 0, "the log's ids; a partial line, or no log, names none");
      // The boundary is pinned at 20,001 (the smallest input that must be cut) and 20,000 (the largest kept whole), so a
      // widened threshold that leaves 20,001 untruncated is caught.
      await ok(() => resultText("x") === "x" && resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]) === "a\n\nb" && resultText(3) === "" && resultText("y".repeat(20_001)) === `${"y".repeat(20_000)}…` && resultText("y".repeat(20_000)) === "y".repeat(20_000) && resultText("y".repeat(30_000)).endsWith("…"), "a result's text from a string or blocks, cut at 20,000 with an ellipsis (20,000 kept whole, 20,001 cut)");
      await ok(() => JSON.stringify(descendantsOf(1, "  2   1\n  3   2\n  4   1\n  5   9\n  1   3\n").sort()) === JSON.stringify([2, 3, 4]), "descendants from ps output, to the leaves, a cycle back to the start ignored");
    });

    await section("the launcher's file helpers, run (not stubbed)", async () => {
      // runSession stubs sha256 and append in the stand-in test below, so the real streaming checksum and the
      // O_NOFOLLOW append go untested there; exercise them directly here over temp files.
      const shaFile = join(fixture, "sha.bin");
      writeFileSync(shaFile, "hello world");
      await ok(async () => (await fileSha256(shaFile)) === sha256Hex("hello world"), "fileSha256 streams a file to the same digest as sha256Hex of its bytes");
      const big = join(fixture, "big.bin");
      writeFileSync(big, Buffer.alloc(5_000_000, 7));
      await ok(async () => (await fileSha256(big)) === sha256Hex(Buffer.alloc(5_000_000, 7)), "fileSha256 is right for a file larger than one chunk");
      const logp = join(fixture, "helper.log");
      appendLog(logp, "a\n");
      appendLog(logp, "b\n");
      await ok(() => readFileSync(logp, "utf8") === "a\nb\n", "appendLog appends, creating the file owner-only");
      const linkp = join(fixture, "helper-link");
      symlinkSync(join(fixture, "appendlog-elsewhere"), linkp);
      await ok(() => { let threw = false; try { appendLog(linkp, "x\n"); } catch { threw = true; } return threw && !existsSync(join(fixture, "appendlog-elsewhere")); }, "appendLog refuses a symlink (O_NOFOLLOW): nothing is written through it");
      // writeNoFollow / readNoFollow round-trip, and refuse a symlink target.
      const wf = join(fixture, "nofollow.txt");
      writeNoFollow(wf, "round-trip");
      await ok(() => readNoFollow(wf) === "round-trip", "writeNoFollow then readNoFollow round-trips");
      const wlink = join(fixture, "nofollow-link");
      symlinkSync(join(fixture, "nofollow-elsewhere"), wlink);
      await ok(() => { let threw = false; try { writeNoFollow(wlink, "x"); } catch { threw = true; } return threw && !existsSync(join(fixture, "nofollow-elsewhere")); }, "writeNoFollow refuses a symlink (O_NOFOLLOW)");
    });

    await section("the launcher, on a stand-in for Claude Code", async () => {
      const l = join(fixture, "launch");
      const tmpRoot = realpathSync("/tmp");
      const lTmp = `${tmpRoot}/obr-${randomBytes(4).toString("hex")}`;
      mkdirSync(lTmp, { mode: 0o700 });
      const paths: SessionPaths = {
        install: join(l, "install"), bun: process.execPath, git: "/usr/bin/git", root: join(l, "root"), tmp: lTmp, record: join(l, "record"), configDir: join(l, "config"),
        keyFile: join(l, "key"), gitConfig: join(l, "gitconfig"), home: join(l, "home"),
      };
      try {
        for (const d of [paths.install, paths.root, paths.record, paths.configDir, paths.home]) mkdirSync(d, { recursive: true });
        // The stand-in reads its scenario from the clone and prints a stream; it records its argv, env and stdin there.
        const fakeJs = join(l, "fake.ts");
        writeFileSync(fakeJs, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
const cwd = process.cwd();
writeFileSync(cwd + "/argv.json", JSON.stringify(process.argv.slice(2)));
writeFileSync(cwd + "/env.json", JSON.stringify(Object.keys(process.env).sort()));
writeFileSync(cwd + "/stdin.txt", await Bun.stdin.text());
const scenario = readFileSync(cwd + "/scenario", "utf8").trim();
const record = dirname(process.argv[process.argv.indexOf("--settings") + 1]);
const out = (o) => console.log(JSON.stringify(o));
const init = { type: "system", subtype: "init", claude_code_version: "2.1.319", permissionMode: "dontAsk", apiKeySource: "apiKeyHelper", tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"], mcp_servers: [], model: "claude-opus-5-5", cwd, session_id: "s1" };
const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } }] } };
const res = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "clean", is_error: false }] } };
if (scenario === "turn-first") {
  out(use);
  await Bun.sleep(30000);
} else if (scenario === "bad-init") {
  out({ ...init, permissionMode: "default" });
  await Bun.sleep(30000);
} else {
  out(init);
  if (scenario === "ok") {
    out(use);
    appendFileSync(record + "/guard-worker.log", JSON.stringify({ id: "t1", decision: "pass" }) + "\\n");
    out(res);
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] });
  } else if (scenario === "unlogged") {
    out(use);
    out(res);
    await Bun.sleep(30000);
  } else if (scenario === "hang") {
    const kid = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    const loose = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    loose.unref();
    writeFileSync(cwd + "/kids.json", JSON.stringify([kid.pid, loose.pid]));
    await Bun.sleep(60000);
  } else if (scenario === "sigterm-trap") {
    // A child in the session's group that ignores SIGTERM: only the SIGKILL escalation ends it.
    const trap = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 0.2; done"], { stdio: "ignore" });
    writeFileSync(cwd + "/trap.json", JSON.stringify(trap.pid));
    await Bun.sleep(60000);
  } else if (scenario === "sigterm-clean") {
    // This fake ignores SIGTERM so it stays alive through the grace window (SIGKILL ends it); a child in its group
    // records that SIGTERM reached it and exits. If end() skipped the SIGTERM step, the child never records it.
    process.on("SIGTERM", () => {});
    const kid = spawn("/bin/sh", ["-c", "trap 'echo 1 > " + cwd + "/term.json; exit 0' TERM; while :; do sleep 0.05; done"], { stdio: "ignore" });
    writeFileSync(cwd + "/clean-pid.json", JSON.stringify(kid.pid));
    await Bun.sleep(60000);
  } else if (scenario === "exit") {
    process.exitCode = 3;
  }
}
`);
        const fake = join(l, "claude");
        writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${fakeJs}' "$@"\n`);
        chmodSync(fake, 0o755);
        const pinned: Pinned = { path: fake, sha256: sha256Hex(readFileSync(fake)), version: "2.1.319" };
        const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
          role: "worker", paths, limits: { model: "claude-opus-5-5", effort: "low", maxTurns: 3, maxBudgetUsd: 1 }, pinned, prompt: "the brief", settings: settingsText("worker", paths),
          timeLimitMs: 10_000, user: "m", uid: process.getuid?.() ?? 0, ...over,
        });
        const deps = { ...REAL_DEPS, sha256: async (f: string) => sha256Hex(readFileSync(f)), graceMs: 200 };
        const scenario = (s: string) => writeFileSync(join(paths.root, "scenario"), s);
        const clean = () => {
          for (const f of ["guard-worker.log", "stream-worker.jsonl"]) rmSync(join(paths.record, f), { force: true });
        };

        scenario("ok");
        clean();
        const okOut = await runSession(spec(), deps);
        await ok(() => okOut.ended === "result" && okOut.calls.length === 1 && okOut.results.length === 1 && okOut.result?.subtype === "success" && okOut.exitCode === 0, "a session that ends with its result: its call, its result and its cost recorded");
        await ok(() => readFileSync(join(paths.root, "stdin.txt"), "utf8") === "the brief", "the prompt goes on stdin");
        await ok(() => JSON.stringify(JSON.parse(readFileSync(join(paths.root, "argv.json"), "utf8"))) === JSON.stringify(sessionArgs("worker", paths, spec().limits)), "the command line is profile.ts's");
        await ok(() => { const keys: string[] = JSON.parse(readFileSync(join(paths.root, "env.json"), "utf8")); const want = Object.keys(sessionEnv(paths, "m")); return want.every((k) => keys.includes(k)) && keys.filter((k) => !want.includes(k)).every((k) => ["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(k)); }, "the environment is profile.ts's, with nothing of the runner's own");
        await ok(() => readFileSync(settingsFile(paths.record, "worker"), "utf8") === settingsText("worker", paths) && readFileSync(join(paths.record, "stream-worker.jsonl"), "utf8").split("\n").filter(Boolean).length === 4, "the settings and the stream are written into the record");

        scenario("bad-init");
        clean();
        let t = Date.now();
        const badInit = await runSession(spec(), deps);
        await ok(() => badInit.ended === "init" && badInit.why.includes("permission mode") && Date.now() - t < 5_000, "an init that isn't the session's ends it at once");
        scenario("turn-first");
        clean();
        const turnFirst = await runSession(spec(), deps);
        await ok(() => turnFirst.ended === "init" && turnFirst.why.includes("before the init"), "a turn before the init ends the session");
        scenario("unlogged");
        clean();
        const unlogged = await runSession(spec(), deps);
        await ok(() => unlogged.ended === "unlogged-call" && unlogged.why.includes("t1"), "a result for a call the guard never logged ends the session");
        scenario("hang");
        clean();
        t = Date.now();
        const hang = await runSession(spec({ timeLimitMs: 1_500 }), deps);
        await ok(() => hang.ended === "time" && Date.now() - t < 6_000, "the time limit ends the session");
        await ok(async () => {
          await Bun.sleep(300);
          const kids: number[] = JSON.parse(readFileSync(join(paths.root, "kids.json"), "utf8"));
          return kids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } });
        }, "its children end with it, one that left its process group among them");
        scenario("sigterm-trap");
        clean();
        const trapRun = await runSession(spec({ timeLimitMs: 1_500 }), deps);
        await ok(async () => {
          await Bun.sleep(400);
          const pid: number = JSON.parse(readFileSync(join(paths.root, "trap.json"), "utf8"));
          const dead = (() => { try { process.kill(pid, 0); return false; } catch { return true; } })();
          if (!dead) { try { process.kill(pid, "SIGKILL"); } catch { /* clean up a mutant's survivor */ } }
          return trapRun.ended === "time" && dead;
        }, "a child that ignores SIGTERM is ended by the SIGKILL escalation");
        scenario("sigterm-clean");
        clean();
        rmSync(join(paths.root, "term.json"), { force: true });
        const depsSlow = { ...deps, graceMs: 1_500 };
        const cleanRun = await runSession(spec({ timeLimitMs: 1_500 }), depsSlow);
        await ok(async () => {
          await Bun.sleep(400);
          const pid: number = JSON.parse(readFileSync(join(paths.root, "clean-pid.json"), "utf8"));
          const dead = (() => { try { process.kill(pid, 0); return false; } catch { return true; } })();
          if (!dead) { try { process.kill(pid, "SIGKILL"); } catch { /* clean up */ } }
          return cleanRun.ended === "time" && existsSync(join(paths.root, "term.json")) && dead;
        }, "end() sends SIGTERM before SIGKILL: a child that exits on SIGTERM records it within the grace window");
        scenario("exit");
        clean();
        const exit = await runSession(spec(), deps);
        await ok(() => exit.ended === "exit" && exit.exitCode === 3, "a session that exits without a result says so, with its code");

        await ok(async () => (await runSession(spec({ pinned: { ...pinned, sha256: "0".repeat(64) } }), deps)).ended === "refused", "a binary whose checksum isn't the pinned one is refused before it starts");
        writeFileSync(join(paths.configDir, "settings.json"), "{}");
        await ok(async () => (await runSession(spec(), deps)).why.includes("settings.json"), "a config directory holding settings.json is refused");
        rmSync(join(paths.configDir, "settings.json"));
        writeFileSync(join(paths.configDir, "settings.local.json"), "{}");
        await ok(async () => (await runSession(spec(), deps)).why.includes("settings.local.json"), "a config directory holding settings.local.json is refused too");
        rmSync(join(paths.configDir, "settings.local.json"));
        rmSync(settingsFile(paths.record, "worker"));
        symlinkSync(join(l, "elsewhere.json"), settingsFile(paths.record, "worker"));
        await ok(async () => (await runSession(spec(), deps)).ended === "refused" && !existsSync(join(l, "elsewhere.json")), "a settings file that is a link is refused, and nothing is written through it");
        rmSync(settingsFile(paths.record, "worker"));
        await ok(async () => (await runSession(spec({ paths: { ...paths, root: `${paths.root} x` } }), deps)).ended === "refused", "paths that can't make a profile are refused");
      } finally {
        rmSync(lTmp, { recursive: true, force: true });
      }
    });

    await section("the mock Messages API", async () => {
      const mock = startMock([{ tool: "Bash", input: { command: "git status" } }, { text: "end" }], "k");
      try {
        const post = (body: Record<string, unknown>, key = "k", path = "/v1/messages") => fetch(`${mock.url}${path}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
        const events = async (res: Response) => (await res.text()).split("\n\n").filter(Boolean).map((e) => JSON.parse(e.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "null"));
        const tools = [{ name: "Bash" }];
        const first = await events(await post({ stream: true, tools, system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "go" }] }));
        await ok(() => first[0].type === "message_start" && first.at(-1).type === "message_stop" && first.find((e) => e.type === "content_block_start")?.content_block?.id === callId(0) && JSON.parse(first.find((e) => e.type === "content_block_delta")?.delta?.partial_json ?? "{}").command === "git status" && first.find((e) => e.type === "message_delta")?.delta?.stop_reason === "tool_use", "step 0 is a streamed tool call, its id callId(0)");
        const second = await events(await post({ stream: true, tools, messages: [{ role: "user", content: "go" }, { role: "assistant", content: [] }, { role: "user", content: [] }] }));
        await ok(() => second.find((e) => e.type === "content_block_delta")?.delta?.text === "end" && second.find((e) => e.type === "message_delta")?.delta?.stop_reason === "end_turn", "step 1 is text that ends the turn");
        const past = await (await post({ stream: false, tools, messages: [{ role: "assistant" }, { role: "assistant" }, { role: "assistant" }] })).json();
        await ok(() => past.content[0].text === "done" && past.stop_reason === "end_turn", "past the script, a plain reply says done");
        const side = await (await post({ stream: false, messages: [] })).json();
        await ok(() => side.content[0].text === "ok" && mock.requests.filter((r) => !r.main).length === 1, "a request without tools is a side call: ok");
        const emptyTools = await (await post({ stream: false, tools: [], messages: [] })).json();
        await ok(() => emptyTools.content[0].text === "ok" && mock.requests.filter((r) => !r.main).length === 2, "a request with an empty tools list is a side call too, not the main loop");
        await ok(async () => (await post({ tools }, "wrong")).status === 401 && mock.wrongKey() === 1, "a request without the stand-in key is refused and counted");
        await ok(async () => (await (await post({}, "k", "/v1/messages/count_tokens")).json()).input_tokens === 10 && (await post({}, "k", "/v1/other")).status === 404 && (await fetch(`${mock.url}/v1/messages`, { headers: { "x-api-key": "k" } })).status === 404, "token counts answer; other paths and methods don't");
        await ok(async () => (await fetch(`${mock.url}/v1/messages`, { method: "POST", headers: { "x-api-key": "k" }, body: "{not json" })).status === 400, "a body that isn't JSON is refused");
        await ok(() => mock.requests[0].system === "sys" && requestText(mock.requests[0]).includes("go") && systemText("plain") === "plain" && systemText(3) === "", "requests are recorded with their system prompt and messages");
        await ok(async () => (await reply([{ type: "text", text: "x" }], "end_turn", "m", false).json()).content[0].text === "x", "a plain reply is one JSON body");
      } finally {
        mock.stop();
      }
    });

    await section("the probes and their stamp", async () => {
      const pinned: Pinned = { path: "/c", sha256: "a".repeat(64), version: "2.1.319" };
      const host = { bunSha: "bun-sha", gitSha: "git-sha", osBuild: "24X" };
      const hashes = { "scripts/agent-runner/guard.ts": "h1", "scripts/agent-runner/profile.ts": "h2" };
      const probeNames = ["init", "unlisted-command"];
      const stamp = { at: "T", claude: pinned, host, install: "/inst", profile: hashes, probes: probeNames };
      const bad = (over: Record<string, unknown>, curHost = host, curHashes = hashes, expected = probeNames) => stampProblem({ ...stamp, ...over }, pinned, curHost, "/inst", curHashes, expected);
      await ok(() => stampProblem(stamp, pinned, host, "/inst", hashes, probeNames) === null, "a stamp for this binary, host, install, profile and probe set passes");
      // hostStamp (the write side of the host facts) is exercised directly: it hashes the two files it is given, and the
      // two differ. osBuild is `sw_vers` output (empty off macOS), so it isn't asserted here.
      const fa = join(fixture, "host-a.bin");
      const fb = join(fixture, "host-b.bin");
      writeFileSync(fa, "bun-stand-in");
      writeFileSync(fb, "git-stand-in");
      await ok(async () => { const h = await hostStamp(fa, fb); return h.bunSha === sha256Hex("bun-stand-in") && h.gitSha === sha256Hex("git-stand-in") && h.bunSha !== h.gitSha; }, "hostStamp hashes Bun and git into distinct checksums (the write side of the stamp's host facts)");
      await ok(() => [
        stampProblem(null, pinned, host, "/inst", hashes, probeNames),
        bad({ claude: { ...pinned, sha256: "b".repeat(64) } }), bad({ claude: { ...pinned, version: "2.1.320" } }), bad({ claude: { ...pinned, path: "/d" } }),
        bad({ host: { ...host, bunSha: "other" } }), bad({ host: { ...host, gitSha: "other" } }), bad({ host: { ...host, osBuild: "other" } }),
        stampProblem(stamp, pinned, { ...host, bunSha: "now-newer" }, "/inst", hashes, probeNames),
        stampProblem(stamp, pinned, host, "/other", hashes, probeNames),
        stampProblem(stamp, pinned, host, "/inst", { ...hashes, "scripts/agent-runner/guard.ts": "changed" }, probeNames),
        bad({ profile: { ...hashes, extra: "x" } }),
        bad({ probes: ["init"] }), bad({ probes: ["init", "unlisted-command", "extra"] }), bad({ probes: [] }), bad({ probes: "init" as unknown as string[] }),
      ].every((x) => x !== null), "a missing stamp, or a changed binary/Bun/git/OS/install/profile-file/probe-set: each refused");
      const names = PROBES.map((x) => x.name);
      await ok(() => new Set(names).size === names.length && PROBES.every((x) => x.what.length > 0), "probe names are unique, each with its line");
      await ok(() => ["init", "unlisted-command", "disable-sandbox-guard", "disable-sandbox-alone", "sandbox-reads", "sandbox-writes", "network", "unix-sockets", "bun-spawns-podman", "env", "keychain", "read-outside", "read-outside-rules", "edit-outside", "edit-outside-rules", "tmp-not-tool-writable", "edit-protected", "review-reach", "clone-config-ignored", "outward-refused", "outward-sandboxed", "commit-as-bot", "max-turns", "guard-exit-1", "guard-crash", "guard-hang", "unlogged-call", "invalid-settings"].every((n) => names.includes(n)) && !names.includes(BRIEF_PROBE) && BRIEF_PROBE === "brief-step-1" && DEFERRED.length === 0, "every mock probe docs/agent-runner.md lists is here; the brief probe (model) is the --brief-probe mode, not in the offline sweep, and none remain deferred");
      const a = parseArgs(["--claude", "/c", "--sha256=x", "--self-check"]);
      await ok(() => !("error" in a) && a["--claude"] === "/c" && a["--sha256"] === "x" && a["--self-check"] === true, "options by space and by =");
      await ok(() => "error" in parseArgs(["--nope"]) && "error" in parseArgs(["--claude"]) && "error" in parseArgs(["--self-check=1"]) && "error" in parseArgs(["constructor", "x"]) && "error" in parseArgs(["constructor"]), "an unknown option, a missing value, a flag with a value, and a prototype name with a value or without are refused");
      // A --claude that doesn't resolve is a refused start (exit 2), not a probe failure (exit 1). On macOS this reaches
      // the path check; on Linux main returns 2 at the platform gate first, so the case is a macOS-only teeth check.
      await ok(async () => (await probesMain(["--claude", "/obr-nonexistent-xyz-probe", "--sha256", "x".repeat(64), "--version", "2.1.319", "--state", join(fixture, "exit2-state")], START_FLAGS)) === 2, "a --claude path that doesn't resolve exits 2 (a refused start), not 1");
    });

    await section("the brief probe (the model probe, brief-step-1)", async () => {
      await ok(() => BRIEF_PROBE === "brief-step-1" && ticketProblem(BRIEF_TICKET) === null, "its name is the design's, and its test ticket is clean (briefable)");
      const brief = buildBrief({ ticket: BRIEF_TICKET, clonePath: "/c/root", branch: "agent/smd-1-x", base: "abc123", claimId: "brief-probe-no-claim", bundlePath: "/t/b.bundle" });
      await ok(() => brief.includes(BRIEF_TICKET.title) && brief.includes("Do not re-check or re-claim") && brief.includes("/c/root"), "the brief carries the ticket, the runner's do-not-re-claim line, and the clone path");
      const out = (over: Partial<SessionOutcome>): SessionOutcome => ({ ended: "result", why: "", init: null, result: null, report: "", exitCode: 0, signal: null, calls: [], results: [], stderr: "", ...over });
      const call = (name: string, file_path: string) => ({ id: "t", name, input: { file_path } });
      await ok(() => briefVerdict(out({ calls: [call("Read", "/c/root/NOTES.md"), call("Edit", "/c/root/NOTES.md")] }), "/c/root") === null, "an Edit in the clone passes: the worker reached the task past step 1");
      await ok(() => briefVerdict(out({ calls: [call("Write", "/c/root/new.md")] }), "/c/root") === null, "a Write in the clone passes too");
      await ok(() => { const v = briefVerdict(out({ calls: [call("Bash", "")], report: "I cannot run git fetch or list_claims here, so I am stopping." }), "/c/root"); return typeof v === "string" && v.includes("did not reach the task") && v.includes("CLAUDE.md step 1"); }, "no Edit or Write — a stall at step 1 — fails, naming the task and step 1");
      await ok(() => briefVerdict(out({ calls: [call("Edit", "/elsewhere/x")] }), "/c/root") !== null, "an Edit outside the clone does not count");
      await ok(() => briefVerdict(out({ calls: [call("Edit", "/c/rootX/y")] }), "/c/root") !== null, "a sibling path sharing the root's name (/c/rootX) does not count");
      await ok(() => typeof briefVerdict(out({ ended: "refused", why: "the binary's checksum" }), "/c/root") === "string" && typeof briefVerdict(out({ ended: "init", why: "the model was wrong" }), "/c/root") === "string", "a refused or init-rejected session fails");
      await ok(() => { const v = briefVerdict(out({ report: `stopped\u0007here`, calls: [] }), "/c/root"); return typeof v === "string" && !v.includes("\u0007"); }, "the reason shows the session's text with control characters escaped (value-safe)");
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}
