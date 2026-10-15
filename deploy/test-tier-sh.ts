#!/usr/bin/env bun
/**
 * test-tier-sh.ts — deploy/tier.sh against a stub runtime (SMD-2875), hermetic.
 *
 * A stub `docker` (and `podman`) first on PATH logs every call and the env file
 * each `create` is handed, and answers as a runtime would: compose's reading of
 * an env file is the file itself, a create is cid1, cid2, …, a half exits as
 * STUB_EXIT_<cid> says. So what tier.sh hands each half is read without a
 * runtime: one network and one side's password each, the target's settings by
 * name, the arguments to both halves, the source container removed before the
 * target starts, and each refusal it tries before anything is made.
 *
 *   bun deploy/test-tier-sh.ts
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TIER_SH = join(HERE, "tier.sh");

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string): void => {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${msg}`); }
};

const STUB = `#!/bin/bash
log="$STUB_LOG"
line="ARGV"; for a in "$@"; do line="$line $a"; done
printf '%s\\n' "$line" >> "$log"  # one append a call: the two cp halves of a pipe run at once
envf=""; prev=""
for a in "$@"; do [ "$prev" = --env-file ] && envf="$a"; prev="$a"; done
last="\${!#}"
case "$1" in
  compose)
    case " $* " in *" --environment "*) grep -v '^#' "$envf"; exit 0 ;; esac
    cat > /dev/null; echo "name: stubproject"; exit 0 ;;
  network) exit 0 ;;
  buildx) exit 1 ;;
  build) cat > /dev/null; exit 0 ;;
  create)
    n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/count"
    { echo "ENVFILE cid$n"; cat "$envf"; echo "END cid$n"; } >> "$log"
    echo "$envf" > "$STUB_DIR/envpath.cid$n"
    echo "cid$n"; exit 0 ;;
  start)
    [ ! -e "$(cat "$STUB_DIR/envpath.$last" 2>/dev/null)" ] || echo "ENVLEFT $last" >> "$log"
    v="STUB_EXIT_$last"; code="\${!v:-0}"; echo "$code" > "$STUB_DIR/exit.$last"; exit "$code" ;;
  inspect)
    case "$*" in
      *State.Status*) v="STUB_STATE_$last"; echo "\${!v:-exited}" ;;
      *State.ExitCode*) cat "$STUB_DIR/exit.$last" ;;
    esac
    exit 0 ;;
  wait) cat "$STUB_DIR/exit.$last"; exit 0 ;;
  # The source argument decides (cp -a - CID:/tmp/ reads the pipe): a receiver
  # that left it unread could exit first and SIGPIPE the sender (review pass 3).
  cp)
    if [ "\${@: -2:1}" = - ]; then
      case "$last" in
        *:/repo) tar -tf - > "$STUB_DIR/code.\${last%%:*}" 2>/dev/null || cat > /dev/null ;;
        *) cat > /dev/null ;;
      esac
    else echo tarbytes; fi
    exit 0 ;;
  rm) exit 0 ;;
esac
exit 0
`;

const root = mkdtempSync(join(tmpdir(), "ob1-test-tier-sh-"));
// Removed however the run ends, a kill included (its logs hold the fixtures' env files).
const cleanup = () => rmSync(root, { recursive: true, force: true });
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { cleanup(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const)[sig]); });
const bin = join(root, "bin");
Bun.spawnSync(["mkdir", "-p", bin]);
for (const name of ["docker", "podman"]) {
  writeFileSync(join(bin, name), STUB);
  chmodSync(join(bin, name), 0o755);
}
// Two brains' env files, each with a password of its own and keys tier.ts never reads.
const PA = "pa0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PB = "pb0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const envA = join(root, "a.env");
const envB = join(root, "b.env");
writeFileSync(envA, `POSTGRES_PASSWORD=${PA}\nOB1_COMPARE_KEY=ck-a\nOB1_EMBEDDING_MODEL=model-a\n`);
writeFileSync(envB, `OB1_EMBEDDING_MODEL=model-b\nOB1_EMBEDDING_API_KEY=ek-b\nOB1_METADATA_MODEL=mm-b\nOB1_LLM_API_KEY=lk-b\nOB1_WORKER_KEY=wk-b\nOB1_AUTH_OPERATOR_PASSWORD=op-b\nOB1_COMPARE_KEY=ck-b\nOB1_PLUGINS=x\nPOSTGRES_PASSWORD=${PB}\nOB1_TIER=canary\nOB1_LLM_BASE_URL=http://u:p@llm:11434/v1\n`);

type Run = { code: number; err: string; out: string; log: string };
let runN = 0;
const run = (args: string[], extraEnv: Record<string, string> = {}): Run => {
  const dir = join(root, `run${++runN}`);
  Bun.spawnSync(["mkdir", "-p", dir]);
  const logFile = join(dir, "log");
  writeFileSync(logFile, "");
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: dir, STUB_LOG: logFile, STUB_DIR: dir, ...extraEnv };
  const p = Bun.spawnSync(["bash", TIER_SH, "--runtime", "docker", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, err: p.stderr.toString(), out: p.stdout.toString(), log: readFileSync(logFile, "utf8") };
};
const argvLines = (r: Run) => r.log.split("\n").filter((l) => l.startsWith("ARGV "));
const creates = (r: Run) => argvLines(r).filter((l) => l.startsWith("ARGV create "));
const envOf = (r: Run, cid: string) => r.log.match(new RegExp(`ENVFILE ${cid}\\n([\\s\\S]*?)\\nEND ${cid}`))?.[1] ?? "";
const networksOf = (line: string) => [...line.matchAll(/--network (\S+)/g)].map((m) => m[1]);

// canary.sh's call: stable's env file for --from, the canary's for --to, each side's network named.
const CANARY = ["--env-file", envB, "--from-env-file", envA, "--project", "pb", "--network", "pb_data", "--from-network", "pa_data", "--refresh", "--from", "postgres", "--to", "postgres", "--tier", "canary"];
{
  const r = run(CANARY);
  const [src, dst] = creates(r);
  ok(r.code === 0, `canary.sh's call runs through (exit ${r.code}: ${r.err.trim().split("\n").pop()})`);
  ok(creates(r).length === 2 && JSON.stringify(networksOf(src ?? "")) === '["pa_data"]' && JSON.stringify(networksOf(dst ?? "")) === '["pb_data"]',
    `two containers, the source on the --from side's network alone and the target on the --to side's alone (${creates(r).map((l) => networksOf(l).join(",")).join(" | ")})`);
  const s = envOf(r, "cid1"), t = envOf(r, "cid2");
  ok(s.includes(PA) && !s.includes(PB) && s.split("\n").filter(Boolean).every((l) => /^(TIER_FROM_URL|OB1_ENV_FILES)=/.test(l)),
    `the source half's env file holds --from's URL alone, with stable's password and never the canary's (${s.split("\n").map((l) => l.split("=")[0]).join(",")})`);
  ok(t.includes(PB) && !t.includes(PA), "the target half's env file holds the canary's password and never stable's");
  const tNames = t.split("\n").filter(Boolean).map((l) => l.split("=")[0]).sort();
  ok(JSON.stringify(tNames) === JSON.stringify(["OB1_ALLOW_REMOTE_DB", "OB1_EMBEDDING_MODEL", "OB1_ENV_FILES", "OB1_PLUGINS", "OB1_TIER", "POSTGRES_PASSWORD", "TIER_TO_URL"]),
    `the target half gets the settings a migration reads, by name, and no key (${tNames.join(",")})`);
  ok(/sh -c .* tier --refresh --tier canary$/.test(src ?? "") && /sh -c .* tier --refresh --tier canary$/.test(dst ?? ""), "both halves get the arguments the wrapper does not read (a bad one is refused before the dump)");
  ok(/--label ob1\.tier-half=source/.test(src ?? "") && /--label ob1\.tier-half=target/.test(dst ?? ""), "each half is labelled with its side");
  // The checkout is not mounted: each half is handed git's list of the code,
  // which no env file is on (review pass 4: the mount carried both brains').
  ok(!creates(r).some((l) => / -v | --volume |--mount /.test(l)), "no create mounts anything (the checkout's env files would ride a mount)");
  const code = (cid: string) => { try { return readFileSync(join(root, `run${runN}`, `code.${cid}`), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  for (const cid of ["cid1", "cid2"]) {
    const files = code(cid);
    ok(files.includes("db/tier.ts") && files.includes("db/migrate.ts") && files.some((f) => f.startsWith("server-portable/")) && files.some((f) => /^plugins\/[^/]+\/index\.ts$/.test(f)) && !files.some((f) => /(^|\/)\.env($|\.)/.test(f) && !/\.example$/.test(f)) && !files.some((f) => f.startsWith("deploy/")),
      `${cid} is handed the code tier.ts runs, from git's list, and no env file (${files.length} files)`);
  }
  ok(/ build .*-t pb-tier:latest/.test(argvLines(r).find((l) => l.startsWith("ARGV build ")) ?? "") && /\bpb-tier:latest\b/.test(src ?? ""), "the image is the --to side's project's, pb-tier");
  const order = argvLines(r).map((l) => l.replace(/^ARGV /, "")).filter((l) => /^(start|cp|rm)\b/.test(l));
  const at = (re: RegExp) => order.findIndex((l) => re.test(l));
  // The two cp's are one pipe's halves, so their order between them is the
  // scheduler's; both come after the source half and before its removal.
  ok(at(/^cp - cid1:\/repo$/) < at(/^start -a cid1$/) && at(/^cp - cid2:\/repo$/) < at(/^start -a cid1$/) && at(/^start -a cid1$/) < at(/^cp cid1:/) && at(/^start -a cid1$/) < at(/^cp -a - cid2:\/tmp\/$/)
      && Math.max(at(/^cp cid1:/), at(/^cp -a - cid2:\/tmp\/$/)) < at(/^rm -f cid1$/) && at(/^rm -f cid1$/) < at(/^start -a cid2$/),
    `the source half runs, its hand-off passes, its container goes, then the target starts (${order.join(" ; ")})`);
  ok(!/pa0a|pb0b/.test(r.out + r.err), "no password on tier.sh's output");
  ok(!r.log.includes("ENVLEFT"), "each half's env file is gone from the host before that half starts");
  ok(!existsSync(join(root, `run${runN}`, "ob1-tier-env")) && Bun.spawnSync(["sh", "-c", `ls ${join(root, `run${runN}`)} | grep -c ob1-tier`]).stdout.toString().trim() === "0", "no temporary env file is left");
}

// The copy rule on a checkout of its own (review pass 5): every tracked file
// under the directories, an untracked one only when it is code, never an env
// file's name nor a directory whole (a nested repository's .env and .git), and
// a tracked file deleted in the work tree, listed last, left out without
// failing the copy.
{
  const scratch = join(root, "checkout");
  const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: scratch, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
  for (const d of ["deploy", "db", "evals", "plugins/demo", "scripts/nested", "server-portable"]) Bun.spawnSync(["mkdir", "-p", join(scratch, d)]);
  writeFileSync(join(scratch, "deploy/tier.sh"), readFileSync(TIER_SH, "utf8"));
  writeFileSync(join(scratch, "db/tier.Dockerfile"), "FROM scratch\n");
  for (const f of ["db/tier.ts", "evals/e.ts", "plugins/demo/index.ts", "server-portable/zz.ts"]) writeFileSync(join(scratch, f), "// tracked\n");
  sh(["git", "init", "-q"]);
  sh(["git", "add", "-A"]);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "t"]);
  rmSync(join(scratch, "server-portable/zz.ts"));
  writeFileSync(join(scratch, "db/092_new.sql"), "-- untracked migration\n");
  writeFileSync(join(scratch, "db/notes.json"), "{}\n");
  writeFileSync(join(scratch, "db/.env.test"), "POSTGRES_PASSWORD=leak\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: join(scratch, "scripts/nested") });
  writeFileSync(join(scratch, "scripts/nested/.env"), "SECRET=leak\n");
  writeFileSync(join(scratch, "scripts/nested/tool.ts"), "// a nested repository's file\n");
  const dir = join(root, `run${++runN}`);
  Bun.spawnSync(["mkdir", "-p", dir]);
  const logFile = join(dir, "log");
  writeFileSync(logFile, "");
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: dir, STUB_LOG: logFile, STUB_DIR: dir };
  const r = Bun.spawnSync(["bash", join(scratch, "deploy/tier.sh"), "--runtime", "docker", ...CANARY], { env, stdout: "pipe", stderr: "pipe" });
  let files: string[] = [];
  try { files = readFileSync(join(dir, "code.cid1"), "utf8").split("\n").filter(Boolean).sort(); } catch { /* none */ }
  ok(r.exitCode === 0, `a checkout with a tracked file deleted last in git's list still copies (exit ${r.exitCode}: ${r.stderr.toString().trim().split("\n").pop()})`);
  ok(JSON.stringify(files) === JSON.stringify(["db/092_new.sql", "db/tier.Dockerfile", "db/tier.ts", "evals/e.ts", "plugins/demo/index.ts"]),
    `only the tracked files and the untracked migration go in: no .json, no env file, nothing of a nested repository, no deleted file (${files.join(", ")})`);
  // With no untracked code, the deleted tracked file is the last thing listed:
  // the loop must not take its absence as its status (pipefail would fail the copy).
  rmSync(join(scratch, "db/092_new.sql"));
  const dir2 = join(root, `run${++runN}`);
  Bun.spawnSync(["mkdir", "-p", dir2]);
  writeFileSync(join(dir2, "log"), "");
  const r2 = Bun.spawnSync(["bash", join(scratch, "deploy/tier.sh"), "--runtime", "docker", ...CANARY], { env: { ...env, TMPDIR: dir2, STUB_LOG: join(dir2, "log"), STUB_DIR: dir2 }, stdout: "pipe", stderr: "pipe" });
  ok(r2.exitCode === 0, `…and copies when that deleted file is the last one git lists (exit ${r2.exitCode}: ${r2.stderr.toString().trim().split("\n").pop()})`);
}

// A failed source half stops the run: no hand-off, no target, its status.
{
  const r = run(CANARY, { STUB_EXIT_cid1: "3" });
  const lines = argvLines(r);
  ok(r.code === 3 && !lines.some((l) => /^ARGV cp (cid1:\/tmp\/handoff|-a )/.test(l)) && !lines.some((l) => l === "ARGV start -a cid2"), `a source half that fails ends the run with its status, before the hand-off and the target (exit ${r.code})`);
  ok(lines.some((l) => /^ARGV rm -f cid1/.test(l)) && lines.some((l) => /^ARGV rm -f .*cid2|^ARGV rm -f cid2/.test(l)), "…and both containers are removed");
}
// A target half that never ran says so.
{
  const r = run(CANARY, { STUB_STATE_cid2: "created" });
  ok(r.code === 1 && /a tier half's container did not run to its end/.test(r.err), `a half whose container never ran is named and fails (exit ${r.code})`);
}
// One project, no --from flags: both halves on its network, one password.
{
  const r = run(["--env-file", envB, "--project", "pb", "--refresh", "--from", "postgres", "--to", "postgres/working", "--tier", "working"]);
  ok(r.code === 0 && creates(r).every((l) => JSON.stringify(networksOf(l)) === '["pb_data"]'), `one project: both halves on its data network (exit ${r.code})`);
}

// Refusals: exit 2, before anything is built or made.
const refused = (what: string, args: string[], re: RegExp, extraEnv: Record<string, string> = {}) => {
  const r = run(args, extraEnv);
  ok(r.code === 2 && re.test(r.err) && !argvLines(r).some((l) => /^ARGV (build|create) /.test(l)), `${what}: refused, exit 2, nothing made (exit ${r.code}: ${r.err.trim().split("\n")[0]})`);
};
refused("--from on another project's network with no --from-env-file", ["--env-file", envB, "--project", "pb", "--from-project", "pa", "--refresh", "--from", "postgres", "--to", "postgres"], /--from is on pa_data, not --to's network, and no --from-env-file gives its password/);
refused("…and by --from-network", ["--env-file", envB, "--project", "pb", "--from-network", "pa_data", "--refresh", "--from", "postgres", "--to", "postgres"], /no --from-env-file gives its password/);
refused("a shell COMPOSE_PROJECT_NAME beside --from-env-file", ["--env-file", envB, "--from-env-file", envA, "--refresh", "--from", "postgres", "--to", "postgres"], /COMPOSE_PROJECT_NAME is set in the shell/, { COMPOSE_PROJECT_NAME: "x" });
refused("--handoff", [...CANARY, "--handoff", "/x"], /--handoff is tier\.sh's own/);
refused("a list of networks", ["--env-file", envB, "--network", "pb_data,pa_data", "--refresh", "--from", "postgres", "--to", "postgres"], /--network takes one network name/);
for (const flag of ["--network", "--project", "--from-network", "--from-project", "--env-file", "--from-env-file", "--runtime", "--from", "--to"]) {
  refused(`${flag}=VALUE`, ["--env-file", envB, "--refresh", "--from", "postgres", "--to", "postgres", `${flag}=x`], new RegExp(`give ${flag} VALUE, not ${flag}=VALUE`));
}
refused("--diff", ["--env-file", envB, "--diff", "--from", "a", "--to", "b"], /--diff runs over HTTP now/);
refused("--diff ahead of a list of networks (an old command line)", ["--env-file", envB, "--network", "a_data,b_data", "--diff", "--from", "a", "--to", "b"], /--diff runs over HTTP now/);
refused("--from-env-file with both sides on one network (a canary file naming no project)", ["--env-file", envB, "--from-env-file", envA, "--refresh", "--from", "postgres", "--to", "postgres"], /--from-env-file names another brain, but both sides come out on stubproject_data/);
refused("no verb", ["--env-file", envB, "--from", "postgres", "--to", "postgres"], /tier\.sh runs one of --refresh and --promote/);
refused("POSTGRES_PASSWORD in the shell beside --from-env-file", CANARY, /POSTGRES_PASSWORD is set in the shell/, { POSTGRES_PASSWORD: "x" });
{
  // A postgres:// --from on another network carries its own password: not refused.
  const r = run(["--env-file", envB, "--project", "pb", "--from-network", "pa_data", "--refresh", "--from", "postgres://postgres:given@postgres:5432/openbrain", "--to", "postgres"]);
  ok(r.code === 0 && !envOf(r, "cid1").includes(PB), `a postgres:// --from on another network runs, with --to's password nowhere in the source half (exit ${r.code})`);
}

console.log(`test-tier-sh: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
