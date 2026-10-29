#!/usr/bin/env bun
/**
 * test-coordinator.ts — the coordinator's first form (db/coordinator.ts,
 * SMD-3476), hermetic: no Postgres, no model, no network.
 *
 * What OB1_PASSES runs (sleep winning over workers, a name that is no pass
 * left out, none named none run); each child's settings (its own, the shared
 * ones, never another's or the coordinator's); each child's command line, as
 * its compose service ran it; and compose.yaml's coordinator handed every
 * setting some child owns, with none it does not account for.
 *
 * As root — CI runs it in the coordinator's own container — the planted
 * pair: two children run by coordinate() as their own users, one holding a
 * secret in its environment, the other trying to read it through
 * /proc/<pid>/environ. It must be refused, while the coordinator reads it
 * (so the pid read is the right one). Run as anyone else, that part says it
 * did not run, and `--require-root` makes that a failure.
 */

import { chmodSync, existsSync, lchownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILDREN, COORDINATOR_OWN, OWNED, PASSES, childEnv, childHome, coordinate, planPasses, runOnce, type Child } from "./coordinator.ts";
import { supervise } from "./supervise.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const names = (raw: string | undefined) => planPasses(raw).children.map((c) => c.name).join(",");

// ---------------------------------------------------------------------------
// planPasses — what OB1_PASSES runs.
// ---------------------------------------------------------------------------
{
  ok(names("sleep,board-sync") === "board-sync,sleep", `sleep and board-sync, board-sync first (${names("sleep,board-sync")})`);
  ok(names("workers") === "extract,consolidate", `workers is the two followers (${names("workers")})`);
  ok(names(" board-sync  workers ,") === "board-sync,extract,consolidate", "commas or spaces, either, around the names");
  ok(names("sleep sleep") === "sleep", "a name twice runs once");
  const both = planPasses("workers,sleep");
  ok(both.children.map((c) => c.name).join(",") === "sleep" && both.lines.length === 1 && /names both sleep and workers, which never run together — sleep runs/.test(both.lines[0]),
    `sleep and workers named together: sleep runs, the followers do not, and the log says so (${both.lines.join(" | ")})`);
  const odd = planPasses("sleep,extract");
  ok(odd.children.map((c) => c.name).join(",") === "sleep" && odd.lines.some((l) => /names 'extract', which is no pass \(sleep, workers, board-sync\) — it is left out, the rest run/.test(l)),
    `a name that is no pass is left out and said, the rest run (${odd.lines.join(" | ")})`);
  for (const raw of [undefined, "", " , "]) {
    const none = planPasses(raw);
    ok(none.children.length === 0 && none.lines.length === 1 && /names no pass, so none runs/.test(none.lines[0]), `nothing named (${JSON.stringify(raw)}): none runs, and the log says how to name them`);
  }
  ok(planPasses("sleep").lines.length === 0, "a list that holds only passes says nothing of it");
  const stale = planPasses("", "auth, sleep,board-sync");
  ok(stale.lines.some((l) => /^coordinator: COMPOSE_PROFILES names sleep and board-sync, a profile no longer \(SMD-3476\) — it starts nothing; the coordinator runs what OB1_PASSES names, so name them there/.test(l)) && planPasses("sleep", "auth,observability").lines.length === 0,
    `a COMPOSE_PROFILES still naming a retired profile is said, a live profile not (${stale.lines.join(" | ")})`);
  ok(JSON.stringify(PASSES) === JSON.stringify(["sleep", "workers", "board-sync"]), "the three passes");
}

// ---------------------------------------------------------------------------
// childEnv — each child's own settings and the shared ones, never another's.
// ---------------------------------------------------------------------------
{
  const env = {
    PATH: "/usr/bin", DATABASE_URL: "postgres://x", OB1_LLM_BASE_URL: "http://m", OB1_EXTRACT_CHUNK_TOKENS: "900",
    MCP_ACCESS_KEYS: "keys", OB1_WORKER_KEY: "wk", LINEAR_API_KEY: "lin", LINEAR_COMMENT_API_KEY: "linc", OB1_BOARD_SYNC_INTERVAL: "300",
    OB1_SLEEP_QUIET: "60", OB1_SLEEP_DUMP_DIR: "/d", OB1_EXTRACT_FOLLOW: "30", OB1_CONSOLIDATE_WORKERS: "2",
    OB1_PASSES: "sleep", PORT: "", UNSET: undefined,
  };
  const of = (name: keyof typeof CHILDREN) => childEnv(CHILDREN[name], env);
  const board = of("board-sync");
  ok(board.LINEAR_API_KEY === "lin" && board.LINEAR_COMMENT_API_KEY === "linc" && board.OB1_BOARD_SYNC_INTERVAL === "300"
      && !("OB1_WORKER_KEY" in board) && !("MCP_ACCESS_KEYS" in board) && !("OB1_SLEEP_QUIET" in board) && !("OB1_EXTRACT_FOLLOW" in board),
    `board-sync: its Linear keys, never the worker key, the key list or another pass's settings (${Object.keys(board).sort().join(",")})`);
  const sleep = of("sleep");
  ok(sleep.OB1_WORKER_KEY === "wk" && sleep.MCP_ACCESS_KEYS === "keys" && sleep.OB1_SLEEP_QUIET === "60" && sleep.OB1_SLEEP_DUMP_DIR === "/d"
      && !("LINEAR_API_KEY" in sleep) && !("LINEAR_COMMENT_API_KEY" in sleep) && !("OB1_EXTRACT_FOLLOW" in sleep) && !("OB1_CONSOLIDATE_WORKERS" in sleep),
    `sleep: the worker key, the key list and its own settings, never Linear's or the followers' (${Object.keys(sleep).sort().join(",")})`);
  const extract = of("extract");
  ok(extract.OB1_EXTRACT_FOLLOW === "30" && extract.OB1_WORKER_KEY === "wk" && !("OB1_CONSOLIDATE_WORKERS" in extract) && !("OB1_SLEEP_QUIET" in extract) && !("LINEAR_API_KEY" in extract),
    "extract: its own two settings and the worker's, never consolidate's, sleep's or Linear's");
  for (const name of Object.keys(CHILDREN) as (keyof typeof CHILDREN)[]) {
    const e = of(name);
    ok(e.PATH === "/usr/bin" && e.DATABASE_URL === "postgres://x" && e.OB1_LLM_BASE_URL === "http://m" && e.OB1_EXTRACT_CHUNK_TOKENS === "900",
      `${name}: the shared settings, OB1_EXTRACT_CHUNK_TOKENS among them (the server's, though it starts like extract's own)`);
    ok(!("OB1_PASSES" in e) && !("PORT" in e) && !("UNSET" in e), `${name}: never the coordinator's own settings, nor an unset one`);
  }
  ok(childEnv(CHILDREN.sleep, env, { HOME: "/tmp/ob1-sleep-x" }).HOME === "/tmp/ob1-sleep-x" && childHome(CHILDREN.sleep) === "/tmp/ob1-sleep-", "a HOME of its own, given, beneath its prefix");
  const uids = Object.values(CHILDREN).map((c) => c.uid);
  ok(new Set(uids).size === uids.length && uids.every((u) => u > 1001 && u < 65534), `a uid each, none the CI runner's 1001 nor nobody's (${uids.join(",")})`);
}

// ---------------------------------------------------------------------------
// The command lines — the ones the four services ran.
// ---------------------------------------------------------------------------
{
  const args = (name: keyof typeof CHILDREN, env: Record<string, string> = {}) => CHILDREN[name].args(env).join(" ");
  ok(args("board-sync") === "--loop", "board-sync: --loop, its interval its own to read");
  ok(args("extract") === "--follow --workers 1" && args("extract", { OB1_EXTRACT_FOLLOW: "30", OB1_EXTRACT_WORKERS: "2" }) === "--follow 30 --workers 2",
    "extract: --follow with its seconds only when set, one worker unless set");
  ok(args("consolidate") === "--follow --workers 1" && args("consolidate", { OB1_CONSOLIDATE_FOLLOW: "45" }) === "--follow 45 --workers 1", "consolidate: the same");
  ok(args("sleep") === "--follow --quiet 300 --poll 5 --workers 1 --budget 60 --statement-timeout 300 --work-mem 4 --maintenance-work-mem 64",
    `sleep: the service's defaults (${args("sleep")})`);
  const dumped = CHILDREN.sleep.args({ OB1_SLEEP_DUMP_DIR: "/var/lib/ob1/no such dir", OB1_SLEEP_BUDGET: "0" });
  ok(dumped.slice(-2).join("|") === "--dump-dir|/var/lib/ob1/no such dir" && dumped[dumped.indexOf("--budget") + 1] === "0",
    "sleep: --dump-dir only when set, the path one argument with its space; a 0 kept, not the default");
  ok(CHILDREN.sleep.requireKey && CHILDREN.extract.requireKey && CHILDREN.consolidate.requireKey && !CHILDREN["board-sync"].requireKey,
    "the key guard on the three that name themselves by OB1_WORKER_KEY, not on board-sync");
  ok(CHILDREN.sleep.digits.length === 7 && CHILDREN.extract.digits.join() === "OB1_EXTRACT_FOLLOW,OB1_EXTRACT_WORKERS", "every number setting guarded digits only");
}

// ---------------------------------------------------------------------------
// A child that cannot be started — a path that is not there, as a uid the
// runtime does not map would be — is said and tried again on the clock; the
// supervisor never throws, so the coordinator never exits into a crash loop.
// ---------------------------------------------------------------------------
{
  const said: string[] = [];
  const s = supervise({ worker: "board-sync", cmd: ["/nonexistent/ob1-no-such-binary"], sql: null, waits: { first: 60_000, max: 60_000, reset: 60_000 }, writer: { out: (l) => said.push(l), err: (l) => said.push(l) } });
  for (let i = 0; i < 50 && !said.some((l) => /exited 127/.test(l)); i++) await Bun.sleep(20);
  let settled: number | string = "pending";
  void s.done.then((c) => { settled = c; }, (e) => { settled = `threw: ${(e as Error).message}`; });
  await Bun.sleep(50);
  const pending = settled;
  s.stop("SIGTERM");
  const code = await Promise.race([s.done.catch((e) => `threw: ${(e as Error).message}`), Bun.sleep(1000).then(() => "hung")]);
  ok(said.some((l) => /^supervise: board-sync could not be started \(/.test(l)) && said.some((l) => /^supervise: board-sync exited 127 after \d+ s; it runs again at /.test(l)) && pending === "pending" && code === 0,
    `a child that cannot be started is said, held for its next try, and a stop ends it with 0 — never a throw (${said.join(" | ").slice(0, 200)}; then ${String(pending)}, ${String(code)})`);
}

// ---------------------------------------------------------------------------
// The CLI: no argument but `run <pass> [args…]`, which runs that pass's script
// once with those args and exits with its code; anything else is usage (2).
// ---------------------------------------------------------------------------
{
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "coordinator.ts"), ...args], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  const usage = cli("--passes", "sleep");
  const unknown = cli("run", "reembed");
  const help = cli("run", "sleep", "--help");
  ok(usage.exitCode === 2 && /takes no arguments — OB1_PASSES names the passes it runs/.test(usage.stderr.toString()) && unknown.exitCode === 2,
    `an argument other than run, or run of no pass, is usage (2) (${usage.exitCode}, ${unknown.exitCode})`);
  ok(help.exitCode === 0 && /^usage: bun db\/sleep\.ts/m.test(help.stdout.toString() + help.stderr.toString()),
    `run sleep --help runs the scheduler's own script with those args, and exits with its code (${help.exitCode})`);
}

// ---------------------------------------------------------------------------
// compose.yaml's coordinator: every setting some child owns handed in, and
// none it does not account for — the server's anchor, a child's, its own.
// ---------------------------------------------------------------------------
const composePath = join(import.meta.dir, "../deploy/compose.yaml");
// In the coordinator's container only db/ and server-portable/ are mounted: there, --require-root runs the planted pair alone.
if (!existsSync(composePath)) {
  ok(process.argv.includes("--require-root"), `${composePath} is where a checkout has it`);
} else {
  const compose = Bun.YAML.parse(readFileSync(composePath, "utf8")) as {
    services: Record<string, { environment?: Record<string, unknown>; command?: string[]; profiles?: string[]; "x-env"?: Record<string, unknown> }>;
  };
  const server = Object.keys(compose.services.api["x-env"] ?? {});
  const coordinator = compose.services.coordinator;
  const keys = Object.keys(coordinator?.environment ?? {});
  const unaccounted = keys.filter((k) => !server.includes(k) && !OWNED.has(k) && !COORDINATOR_OWN.includes(k));
  const missing = [...OWNED, "OB1_PASSES"].filter((k) => !keys.includes(k));
  ok(server.length > 20 && keys.length > server.length, `the server's anchor read (${server.length} settings), the coordinator's environment holding it and more (${keys.length})`);
  ok(unaccounted.length === 0, `every setting the coordinator is handed is the server's, a child's or its own (unaccounted: ${unaccounted.join(", ") || "none"})`);
  ok(missing.length === 0, `every setting a child owns is handed to the coordinator (missing: ${missing.join(", ") || "none"})`);
  ok(JSON.stringify(coordinator?.command) === JSON.stringify(["db/coordinator.ts"]) && coordinator?.profiles === undefined, "its command is the coordinator, and it is a default service");

  // The image carries what the passes import: every db/ module in their graph is
  // a top-level file .dockerignore lets into the server image's context and its
  // Dockerfile copies by name — and it copies no db/ script beyond them.
  const out = mkdtempSync(join(tmpdir(), "ob1-coordinator-graph-"));
  try {
    const entries = ["coordinator.ts", ...new Set(Object.values(CHILDREN).map((c) => c.script))].map((f) => join(import.meta.dir, f));
    const built = Bun.spawnSync([process.execPath, "build", ...entries, "--target", "bun", "--packages", "external", "--outdir", out, `--metafile=${join(out, "meta.json")}`], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" });
    const inputs = built.exitCode === 0 ? Object.keys(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")).inputs as Record<string, unknown>) : [];
    const dbFiles = inputs.filter((f) => f.startsWith("db/"));
    const rules = readFileSync(join(import.meta.dir, "../.dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*")}$`);
    const kept = (file: string) => rules.reduce((keep, rule) => (rule.startsWith("!") ? (glob(rule.slice(1)).test(file) ? true : keep) : glob(rule).test(file) ? false : keep), true);
    const dockerfile = readFileSync(join(import.meta.dir, "../server-portable/Dockerfile"), "utf8");
    // Every db/ file a COPY into /app/db/ names, continuation lines joined.
    const copied = new Set(dockerfile.replace(/\\\n\s*/g, " ").split("\n").filter((l) => /^COPY .* \/app\/db\/$/.test(l)).flatMap((l) => l.split(/\s+/).slice(1, -1)));
    const missing = dbFiles.filter((f) => f.split("/").length !== 2 || !kept(f) || !copied.has(f));
    const extra = [...copied].filter((f) => f.endsWith(".ts") && !dbFiles.includes(f));
    ok(built.exitCode === 0 && dbFiles.length >= 15 && dbFiles.includes("db/sleep.ts") && dbFiles.includes("db/supervise.ts"), `the passes' import graph read (${dbFiles.length} db/ modules${built.exitCode === 0 ? "" : `; bun build: ${built.stderr.toString().slice(0, 200)}`})`);
    ok(missing.length === 0, `every db/ module the passes import reaches the server image: .dockerignore lets it in and the Dockerfile copies it (missing: ${missing.join(", ") || "none"})`);
    ok(extra.length === 0 && copied.has("db/config.mjs"), `…and the image copies no db/ script the passes do not import, beside the contract the server reads (extra: ${extra.join(", ") || "none"})`);
    ok(!kept("db/test-coordinator.ts") && !kept("db/test-live.ts"), "…and the suites stay out of it (the guard's teeth: the rules do exclude)");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  ok(!["sleep", "extract", "consolidate", "board-sync"].some((s) => s in compose.services), "the four services it replaced are gone");
}

// ---------------------------------------------------------------------------
// As root: the planted pair. One child holds a secret; the other, its own
// user, cannot read it from /proc; the coordinator can.
// ---------------------------------------------------------------------------
const root = process.getuid?.() === 0;
if (!root) {
  console.log("  (the planted /proc check runs as root only — CI runs this file in the coordinator's container)");
  ok(!process.argv.includes("--require-root"), "--require-root: the planted /proc check must run here, as root");
} else {
  /** The pair, run by coordinate(): the holder's pid, uid and HOME, and what the reader got from the holder's environ. */
  // A dump directory beneath /var/lib/ob1/ holding a dump and a link to a root-owned file, as a compromised sleep could plant.
  const dumps = `/var/lib/ob1/test-coordinator-${process.pid}`;
  const target = join(tmpdir(), `ob1-coordinator-target-${process.pid}`);
  mkdirSync(dumps, { recursive: true });
  writeFileSync(join(dumps, "a.jsonl"), "{}\n");
  writeFileSync(target, "root's\n");
  symlinkSync(target, join(dumps, "link"));
  const plant = async (asOwnUsers: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "ob1-coordinator-"));
    chmodSync(dir, 0o777);
    const holder = join(dir, "holder.ts");
    const reader = join(dir, "reader.ts");
    const pidFile = join(dir, "holder.pid");
    const outFile = join(dir, "reader.out");
    writeFileSync(holder, `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, uid: process.getuid(), home: process.env.HOME, secret: "LINEAR_API_KEY" in process.env, groups: readFileSync("/proc/self/status", "utf8").match(/^Groups:(.*)$/m)?.[1].trim() ?? null }));\nsetInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n`);
    writeFileSync(reader, `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nwhile (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(20);\nconst { pid } = JSON.parse(readFileSync(${JSON.stringify(pidFile)}, "utf8"));\nlet got;\ntry { got = readFileSync("/proc/" + pid + "/environ", "utf8").includes("LINEAR_API_KEY=planted-secret") ? "the secret" : "read, no secret"; } catch (e) { got = e.code; }\nwriteFileSync(${JSON.stringify(outFile)}, JSON.stringify({ got, uid: process.getuid(), secret: "LINEAR_API_KEY" in process.env }));\nsetInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n`);
    chmodSync(holder, 0o644);
    chmodSync(reader, 0o644);
    const planted: Child[] = [
      { ...CHILDREN["board-sync"], script: holder, args: () => [] },
      { ...CHILDREN.sleep, script: reader, args: () => [], requireKey: false, digits: [] },
    ];
    const said: string[] = [];
    const c = coordinate({ env: { ...process.env, LINEAR_API_KEY: "planted-secret", OB1_PASSES: "", OB1_SLEEP_DUMP_DIR: dumps }, sql: null, asOwnUsers, children: planted, writer: { out: (l) => said.push(l), err: (l) => said.push(l) } });
    try {
      for (let i = 0; i < 200 && !existsSync(outFile); i++) await Bun.sleep(50);
      const h = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) : null;
      const r = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
      // World-readable: the holder's own uid as the kernel has it, so the pid is the right one.
      const status = h ? readFileSync(`/proc/${h.pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1] : undefined;
      return { h, r, said, status };
    } finally {
      c.stop("SIGTERM");
      await Promise.race([c.done, Bun.sleep(5000)]);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // A directory at the path a HOME once had, made ahead by another user, open to all: never a pass's HOME.
  const planted = "/tmp/ob1-board-sync";
  mkdirSync(planted, { recursive: true });
  chmodSync(planted, 0o777);
  // A HOME an earlier start left — the child's, 0700, holding a file of its own — removed at the next start.
  const old = "/tmp/ob1-board-sync-oldhom";
  mkdirSync(join(old, "inner"), { recursive: true, mode: 0o700 });
  writeFileSync(join(old, "inner", "cache"), "x");
  // Made 0700 by mkdir; root, with no capability to chmod what is not its own, hands it over last.
  for (const at of [join(old, "inner", "cache"), join(old, "inner"), old]) lchownSync(at, CHILDREN["board-sync"].uid, CHILDREN["board-sync"].uid);
  const own = await plant(true);
  ok(!existsSync(old), `a HOME an earlier start left is removed at the next, though its uid's and 0700 (${old} ${existsSync(old) ? "still there" : "gone"})`);
  ok(own.h?.uid === CHILDREN["board-sync"].uid && own.status === String(CHILDREN["board-sync"].uid) && own.r?.uid === CHILDREN.sleep.uid,
    `each child runs as its own user (holder ${own.h?.uid}, the kernel's ${own.status}; reader ${own.r?.uid})`);
  const homeAt = own.h?.home ? statSync(own.h.home) : null;
  ok(/^\/tmp\/ob1-board-sync-\w{6}$/.test(own.h?.home ?? "") && homeAt?.uid === CHILDREN["board-sync"].uid && (homeAt.mode & 0o777) === 0o700 && own.h?.secret === true && own.r?.secret === false,
    `each its own HOME, made afresh — its uid's, 0700, never the directory planted at ${planted} — the secret in the holder's settings and not the reader's (${own.h?.home}, ${homeAt?.uid}, ${homeAt ? (homeAt.mode & 0o777).toString(8) : "none"})`);
  rmSync(planted, { recursive: true, force: true });
  ok(own.h?.groups === "", `no supplementary group kept from root (Groups: '${own.h?.groups}')`);
  ok(statSync(dumps).uid === CHILDREN.sleep.uid && statSync(join(dumps, "a.jsonl")).uid === CHILDREN.sleep.uid && statSync(target).uid === 0,
    `the dump directory and its dump are sleep's, and a link in it is not followed — its target stays root's (dir ${statSync(dumps).uid}, dump ${statSync(join(dumps, "a.jsonl")).uid}, target ${statSync(target).uid})`);
  ok(own.r?.got === "EACCES", `the reader cannot read the holder's /proc/<pid>/environ (got ${own.r?.got ?? "no answer"})`);
  ok(own.said.some((l) => /^coordinator: runs board-sync \(uid 1101\) and sleep \(uid 1104\)$/.test(l)), `the log says who runs as whom (${own.said.find((l) => l.startsWith("coordinator: runs"))})`);
  // A one-off as root runs as the pass's own user, with its settings alone.
  const probeDir = mkdtempSync(join(tmpdir(), "ob1-coordinator-once-"));
  chmodSync(probeDir, 0o777);
  const probe = join(probeDir, "probe.ts");
  writeFileSync(probe, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(probeDir, "seen.json"))}, JSON.stringify({ uid: process.getuid(), args: process.argv.slice(2), linear: "LINEAR_API_KEY" in process.env, worker: process.env.OB1_WORKER_KEY ?? null, home: process.env.HOME }));\nprocess.exit(3);\n`);
  chmodSync(probe, 0o644);
  const onceCode = await runOnce({ ...CHILDREN.extract, script: probe }, ["--status"], { env: { ...process.env, LINEAR_API_KEY: "planted-secret", OB1_WORKER_KEY: "given-for-this-run" } });
  const seen = existsSync(join(probeDir, "seen.json")) ? JSON.parse(readFileSync(join(probeDir, "seen.json"), "utf8")) : null;
  ok(typeof seen?.home === "string" && !existsSync(seen.home), `a one-off's HOME goes when it ends (${seen?.home})`);
  // A sleep one-off: --dump-dir=DIR handed over when DIR is directly in /var/lib/ob1, a nested one never (its parent could be a child's link).
  const direct = `/var/lib/ob1/test-once-${process.pid}`;
  const nested = join(direct, "nested");
  mkdirSync(nested, { recursive: true });
  const noop = join(tmpdir(), `ob1-coordinator-noop-${process.pid}.ts`);
  writeFileSync(noop, "process.exit(0);\n");
  chmodSync(noop, 0o644);
  await runOnce({ ...CHILDREN.sleep, script: noop }, [`--dump-dir=${direct}`], { env: { PATH: process.env.PATH ?? "" } });
  await runOnce({ ...CHILDREN.sleep, script: noop }, [`--dump-dir=${nested}`], { env: { PATH: process.env.PATH ?? "" } });
  rmSync(noop, { force: true });
  ok(statSync(direct).uid === CHILDREN.sleep.uid && statSync(nested).uid === 0,
    `a sleep one-off's --dump-dir=DIR is handed over directly in /var/lib/ob1, a nested one never (direct ${statSync(direct).uid}, nested ${statSync(nested).uid})`);
  lchownSync(direct, 0, 0);
  rmSync(direct, { recursive: true, force: true });
  rmSync(probeDir, { recursive: true, force: true });
  ok(onceCode === 3 && seen?.uid === CHILDREN.extract.uid && JSON.stringify(seen?.args) === JSON.stringify(["--status"]) && seen?.linear === false && seen?.worker === "given-for-this-run" && /^\/tmp\/ob1-extract-\w{6}$/.test(seen?.home ?? ""),
    `a one-off runs as the pass's user, with its args and its settings alone — the worker key given it, no Linear key — and exits with its code (${onceCode}, ${JSON.stringify(seen)})`);

  // The mechanism dropped — both as this process's user — and the same reader gets the secret: the refusal above is the users', not /proc's.
  const shared = await plant(false);
  // Root here may not delete in a directory it handed away (no CAP_DAC_OVERRIDE): taken back first.
  lchownSync(dumps, 0, 0);
  rmSync(dumps, { recursive: true, force: true });
  rmSync(target, { force: true });
  ok(shared.h?.uid === 0 && shared.r?.uid === 0 && shared.r?.got === "the secret",
    `without users of their own the reader reads the holder's secret, so the refusal is the users' doing (got ${shared.r?.got ?? "no answer"})`);
}

console.log(`\ntest-coordinator: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
