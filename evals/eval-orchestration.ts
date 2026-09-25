/**
 * eval-orchestration.ts — SMD-1863: the same two workflows, run on each
 * orchestration candidate beside a throwaway brain, and the criteria posted on
 * the ticket before any of them ran.
 *
 *   bun eval-orchestration.ts --up <tool> [--with <variant>]…   # brain + candidate, provisioned headlessly
 *   bun eval-orchestration.ts --verify <tool> [--json] [--wait-schedule]
 *   bun eval-orchestration.ts --down <tool>      # removes the project's containers AND volumes
 *   bun eval-orchestration.ts --self-check       # n8n's egress judge on a crafted log, no stack (CI)
 *
 * <tool> is one of n8n | activepieces | windmill. Each runs as its own compose
 * project, `ob1-orch-<tool>`: deploy/compose.yaml as shipped plus
 * orchestration/compose.<tool>.yaml, the brain on 127.0.0.1:8012 and the
 * candidate on its own loopback port. compose runs with an allowlisted
 * environment and orchestration/.env (stack.ts), so a dogfood deploy/.env on
 * the search path reaches neither.
 *
 * n8n is the shipped `orchestration` profile (SMD-2210): the driver passes
 * `--profile orchestration`, and compose.n8n.yaml changes only the pruning
 * cadence. `--with postgres` gives it a Postgres 17 of its own instead of
 * SQLite. `--with sealed` is the egress probe: n8n with no route out, and a
 * record of what it tried to reach (compose.n8n-sealed.yaml). `--verify`
 * reads the variants `--up` chose, and `--down` removes them all.
 *
 * What --verify checks (the ticket's comment of 2026-09-25 has the wording):
 *   C1  it first deletes the thoughts `orch-capture` wrote (delete_thought),
 *       then runs the ingestion workflow twice. Each run must report, from the
 *       TOOL's own run record, ten capture_thought calls answered; the brain
 *       must hold ten rows with ten distinct identifiers, all written by
 *       `orch-capture`, after the first and none more after the second. The
 *       reset makes every verify's first run prove itself (review pass 1: a dead
 *       workflow passed as "+0, +0" on a re-verify); the record makes the second
 *       (review pass 2: a skipped second run passed as a dedup's "+0"). A run
 *       that throws is a FAIL row, not an abort.
 *   C1s with --wait-schedule: those runs were on-demand, so the verifier then
 *       waits (up to 20 min, the schedule is every 15) for a run the SCHEDULE
 *       started since the verify began to succeed, by the tool's run history.
 *   C2  capture: those rows' writer is `orch-capture`, a CAPTURE-scope record
 *       in MCP_ACCESS_KEYS, carried by the TOOL's own MCP client — as the
 *       criteria were posted; a script of ours standing in where the tool has
 *       no such step (Windmill) is reported and does not pass. Read: the brain
 *       search on the candidate's endpoint answers, and the only credential on
 *       that path is `orch-read`.
 *   C3  the candidate's own MCP endpoint lists both tools, the brain search
 *       returns thoughts, the Linear lookup returns SMD-1863 with an
 *       `updatedAt` timestamp as values (the request carries both as text), and
 *       a session with no key and one whose key differs in its last character
 *       are each refused with HTTP 401 or 403.
 *   M1  memory per container at the start of --verify and after the runs, the
 *       image and its digest, the version, and the store's size where the
 *       adapter reads it.
 * A candidate adds its own checks after these (n8n's K, P and E: n8n.ts).
 * Under a sealed variant, the ingestion is the probe workflow (ten fixed
 * captures, nothing fetched). The act tool must FAIL, since reaching Linear
 * would mean an escape, and --wait-schedule is refused, since the schedule
 * fetches Linear.
 * C4 (no UI step) is --up's: it prints the steps it took. --up onto an existing
 * project skips what already exists; after editing a workflow file, --down first.
 * Needs LINEAR_API_KEY (the usual .env search path) and the host's Ollama.
 */
import { loadEnv } from "./env.ts";
import type { Adapter, Check, Ctx } from "./orchestration/adapter.ts";
import { callTool, listTools, refuses } from "./orchestration/mcp-client.ts";
import { activepieces } from "./orchestration/activepieces.ts";
import { judgeEgress, n8n } from "./orchestration/n8n.ts";
import { windmill } from "./orchestration/windmill.ts";
import { brainSql, compose, ENV_FILE, ensureEnv, memoryByContainer, run, setEnvValue, setLayout, waitFor } from "./orchestration/stack.ts";
import { initSecrets } from "../deploy/orchestration/provision.ts";

const ADAPTERS: Record<string, Adapter> = { n8n, activepieces, windmill };
/** The ingestion workflow's fixed item set: ten SMD issues, or the probe's ten fixed thoughts (see each candidate's workflow). */
const EXPECTED_ISSUES = 10;
const WRITER = "orch-capture";

function usage(msg: string): never {
  console.error(`${msg}\nusage: bun eval-orchestration.ts --up|--verify|--down <${Object.keys(ADAPTERS).join("|")}> [--with <variant>]… [--json] [--wait-schedule]`);
  process.exit(2);
}

/**
 * `--self-check`: the egress judge (n8n's E) against a log in the watcher's
 * own format. The recorded run's shape passes. Each way out fails: a raw-IP
 * dial, an outside name, a foreign resolver, a UDP datagram, and a capture
 * that never saw the brain. No stack and no network (CI).
 */
function selfCheck(): number {
  const base = [
    "t eth0  Out IP 10.89.4.2.39771 > 10.89.4.1.53: 59194+ A? server.dns.podman. (35)",
    "t eth0  In  IP 10.89.4.1.53 > 10.89.4.2.39771: 59194 1/0/0 A 10.89.4.3 (51)",
    "t eth0  Out IP 10.89.4.2.51086 > 10.89.4.3.8000: Flags [S], seq 1, win 64240, length 0",
    "t eth0  In  IP 10.89.4.4.40026 > 10.89.4.2.5678: Flags [S], seq 2, win 64240, length 0",
    "t lo    In  IP 127.0.0.1.46852 > 127.0.0.1.5679: Flags [S], seq 3, win 65495, length 0",
    "t eth0  Out IP 10.89.4.2.48800 > 10.89.4.1.53: 9152+ A? api.linear.app. (32)",
    "t eth0  In  IP 10.89.4.1.53 > 10.89.4.2.48800: 9152 NXDomain 0/0/0 (32)",
  ];
  const cases: [string, string[], boolean, RegExp][] = [
    ["the recorded shape passes", base, true, /names inside: server\.dns\.podman/],
    ["a raw-IP dial fails", [...base, "t eth0 Out IP 10.89.4.2.5555 > 9.9.9.9.443: Flags [S], seq 4, length 0"], false, /DIALLED OUTSIDE THE COMPOSE NETWORK: 9\.9\.9\.9:443/],
    ["an outside name fails", [...base, "t eth0 Out IP 10.89.4.2.4 > 10.89.4.1.53: 1+ A? api.n8n.io. (28)"], false, /NOT A TEMPLATE'S HOST: api\.n8n\.io/],
    ["a foreign resolver fails", [...base, "t eth0 Out IP 10.89.4.2.4 > 8.8.8.8.53: 2+ A? api.linear.app. (32)"], false, /8\.8\.8\.8:53\/dns/],
    ["a UDP datagram out fails", [...base, "t eth0 Out IP 10.89.4.2.4 > 1.1.1.1.443: UDP, length 1200"], false, /1\.1\.1\.1:443\/udp/],
    ["a capture without the brain fails", base.filter((l) => !l.includes(".8000:")), false, /NO SYN to the brain/],
  ];
  let failed = 0;
  for (const [what, lines, pass, re] of cases) {
    const r = judgeEgress(lines.join("\n"));
    if (r.pass !== pass || !re.test(r.detail)) { failed++; console.error(`FAIL ${what}: ${r.pass ? "PASS" : "FAIL"} ${r.detail.slice(0, 200)}`); }
  }
  console.log(failed ? `eval-orchestration self-check: ${failed} failed` : "eval-orchestration self-check: OK");
  return failed ? 1 : 0;
}
if (process.argv.includes("--self-check")) process.exit(selfCheck());

const args = process.argv.slice(2);
const mode = ["--up", "--verify", "--down"].find((m) => args.includes(m)) ?? usage("no mode");
const tool = args[args.indexOf(mode) + 1] ?? usage("no tool");
const adapter = ADAPTERS[tool] ?? usage(`unknown tool ${tool}`);
const json = args.includes("--json");
const waitSchedule = args.includes("--wait-schedule");
/** A 15-minute schedule, measured from after C3, and room for a slow run to finish (review pass 3: 16 left ~1 min). */
const SCHEDULE_WAIT_MS = 20 * 60_000;

loadEnv();
ensureEnv();
// The profile's own secrets, made by its own --init: the kit's file is the
// profile's deploy/.env as far as n8n can tell.
if (adapter.profile === "orchestration") await initSecrets(ENV_FILE);
const env: Record<string, string> = { ...ensureEnv(), LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "" };

// The variants: chosen by --up and kept in orchestration/.env, so --verify
// runs against what is up rather than what its own flags say.
const WITH_KEY = `ORCH_WITH_${tool.toUpperCase()}`;
const asked = args.flatMap((a, i) => (a === "--with" ? [args[i + 1] ?? usage("--with needs a variant")] : []));
for (const v of asked) if (!adapter.variants?.[v]) usage(`${tool} has no variant ${v}${adapter.variants ? ` (it has ${Object.keys(adapter.variants).join(", ")})` : ""}`);
for (const v of asked) for (const x of adapter.variants![v].excludes ?? []) if (asked.includes(x)) usage(`--with ${v} and --with ${x} do not combine: ${adapter.variants![v].why ?? "see the overlays"}`);
if (asked.length && mode !== "--up") usage("--with is --up's: --verify reads what --up chose, and --down removes every variant");
const ctx: Ctx = { with: mode === "--up" ? asked : (env[WITH_KEY] ?? "").split(",").filter(Boolean) };
const sealed = adapter.sealedVariant !== undefined && ctx.with.includes(adapter.sealedVariant);
if (sealed && waitSchedule) usage("--wait-schedule under the sealed variant: the schedule fetches Linear, which the probe exists to make unreachable");
const overlays = (names: string[]) => names.map((v) => adapter.variants![v].file);
setLayout(tool, adapter.profile, overlays(mode === "--down" ? Object.keys(adapter.variants ?? {}) : ctx.with));
const brainHealthy = async () => (await fetch("http://127.0.0.1:8012/health").catch(() => null))?.ok === true;

async function up(): Promise<void> {
  if (!env.LINEAR_API_KEY) usage("LINEAR_API_KEY is not set (evals/.env, <repo>/.env or deploy/.env)");
  // Kept before compose runs: a failed --up is followed by --down, which removes every variant anyway.
  setEnvValue(WITH_KEY, ctx.with.join(","));
  const variantServices = ctx.with.flatMap((v) => adapter.variants![v].services);
  // The brain is built from this checkout, and --up proves it started what
  // it built. The build is stamped with a value unique to this run, which
  // the keyed /health must report back. On podman, a build loaded as
  // `ob1-orch-n8n-server` sat beside a day-old `localhost/ob1-orch-n8n-server`,
  // and compose started the old one: a brain two migrations behind the tree,
  // with `--build` in the command (SMD-2210, measured).
  const stamp = `${run(["git", "rev-parse", "--short=12", "HEAD"]).out.trim() || "nogit"}+orch${Date.now()}`;
  const r = compose(tool, ["up", "-d", "--build", "postgres", "migrate", "server", ...adapter.services, ...variantServices], { OB1_GIT_SHA: stamp });
  if (r.code !== 0) throw new Error(`compose up failed:\n${r.err.slice(-2000)}`);
  await waitFor("the brain's /health", brainHealthy);
  const reported = await fetch("http://127.0.0.1:8012/health", { headers: { "x-brain-key": env.ORCH_BRAIN_READ_KEY } }).then((h) => h.json()).then((j: any) => String(j.commit), () => "unreadable");
  if (reported !== stamp) {
    // What the engine holds under the project's names, so the likely stale copy can be seen rather than guessed at.
    const held = run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}"]).out.split("\n").filter((l) => l.includes(`ob1-orch-${tool}-`)).join("; ");
    throw new Error(`the brain reports commit ${reported}, not this --up's build (${stamp}): the running server is not the image this --up built — likely a stale copy the engine resolves the name to first. Images under the project's names: ${held || "none"}. Remove the stale ones (docker image rm <name>), then --down and --up again`);
  }
  await waitFor(`${tool} to answer`, () => adapter.ready(env), 300_000);
  const steps = await adapter.provision(env, ctx);
  await waitFor(`${tool} after provisioning`, () => adapter.ready(env), 300_000);
  console.log(`${tool}${ctx.with.length ? ` (with ${ctx.with.join(", ")})` : ""} up and provisioned: ${steps.join(", ")}`);
}

/** Rows `orch-capture` wrote, and how many distinct identifiers (SMD-1863, PROBE-3) they open with. */
function written(): { rows: number; ids: number } {
  const [rows, ids] = brainSql(tool, `SELECT count(*), count(DISTINCT substring(content from '^([A-Z]+-[0-9]+)')) FROM thoughts WHERE metadata->>'actor_name' = '${WRITER}'`).split("|").map(Number);
  return { rows, ids };
}

/**
 * Delete what `orch-capture` wrote, through the brain's own delete path.
 * delete_thought answers every call — `{ok:false, error:…}` for a row it
 * refuses — so the deletions are the `ok` answers, not the calls.
 */
function reset(): { deleted: number; asked: number } {
  const [deleted, asked] = brainSql(tool, `SELECT count(*) FILTER (WHERE (r->>'ok')::boolean), count(*) FROM (SELECT delete_thought(id) AS r FROM thoughts WHERE metadata->>'actor_name' = '${WRITER}') d`).split("|").map(Number);
  return { deleted, asked };
}

/**
 * Each header's value with its last character changed: a key or token of the
 * right shape that is not the right one. A literal "wrong-key" is not a JWT, so
 * a bearer endpoint that decoded a token without checking its signature would
 * refuse it as malformed and still pass (review pass 2).
 */
const wrongKey = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.slice(0, -1) + (v.endsWith("A") ? "B" : "A")]));

/** One ingestion run: what the tool says it answered, what the brain holds after, how long. */
async function ingest(): Promise<{ answered: number; after: { rows: number; ids: number }; ms: number; error?: string }> {
  const t0 = performance.now();
  try {
    const answered = await adapter.runIngestion(env, ctx);
    return { answered, after: written(), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { answered: 0, after: written(), ms: Math.round(performance.now() - t0), error: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
  }
}

async function verify(): Promise<void> {
  const checks: Check[] = [];
  const startedAt = new Date().toISOString();
  const idle = memoryByContainer(tool);
  const cleared = reset();
  const before = written();
  const first = await ingest();
  const second = first.error ? null : await ingest();
  // Both runs must say they answered the whole set — the tool's own record,
  // so a run that did not execute cannot pass as a dedup's "+0" — and the
  // brain must hold the set after the first and nothing more after the second.
  const c1 = before.rows === 0
    && first.answered === EXPECTED_ISSUES && first.after.rows === EXPECTED_ISSUES && first.after.ids === EXPECTED_ISSUES
    && second !== null && !second.error && second.answered === EXPECTED_ISSUES && second.after.rows === first.after.rows;
  const run2 = second === null ? "not run" : second.error ? `ERROR ${second.error}` : `the tool answered ${second.answered}, +${second.after.rows - first.after.rows} rows`;
  checks.push({
    id: "C1",
    pass: c1,
    detail: `reset deleted ${cleared.deleted} of ${cleared.asked} → ${before.rows}; run 1 ${first.error ? `ERROR ${first.error}` : `the tool answered ${first.answered}, +${first.after.rows - before.rows} rows, ${first.after.ids} distinct issues in ${first.ms} ms (wall clock, the brain's model calls included)`}; run 2 ${run2}`,
  });

  const captureScoped = (env.MCP_ACCESS_KEYS ?? "").split(/[,\n]/).some((r) => r.trim().startsWith(`${WRITER}:capture:`));
  const { url, headers } = await adapter.mcpServer(env);
  // The endpoint can lag the candidate's own readiness (n8n registered its MCP
  // webhook after /healthz answered, before the API moved to readiness): list
  // until it answers.
  let listed: Awaited<ReturnType<typeof listTools>> | Error = new Error("not tried");
  await waitFor(`${tool}'s MCP endpoint`, async () => {
    listed = await listTools(url, headers).catch((e: Error) => e);
    return !(listed instanceof Error);
  }, 60_000, 3_000).catch(() => {});
  const names = listed instanceof Error ? [] : (listed as { name: string }[]).map((t) => t.name);
  // The declared name, or the declared name plus a suffix the candidate adds
  // (Activepieces appends `_<id>_mcp` to a flow's tool name).
  const find = (declared: string) => names.find((n) => n === declared || n.startsWith(`${declared}_`));
  const call = async (declared: string, args: Record<string, unknown>) => {
    const name = find(declared);
    if (!name) return { isError: true, text: "not listed" };
    return callTool(url, headers, name, args, 120_000).catch((e: Error) => ({ isError: true, text: e.message }));
  };
  const search = await call(adapter.tools.search, { query: "which orchestration tool for ingestion and sync", limit: 3 });
  const act = await call(adapter.tools.act, { identifier: "SMD-1863" });
  const anon = await refuses(url, {});
  const wrong = await refuses(url, wrongKey(headers));
  const searchOk = !search.isError && /\b(SMD|PROBE)-\d+/.test(search.text);
  // Values, not names: the request itself carries `updatedAt` (in the query)
  // and "SMD-1863" (in the variables), so an error echoing the request must
  // not pass. A timestamp and the identifier as a value come only from Linear.
  // `\\?"` allows a tool that returns the JSON as an escaped string.
  const actOk = !act.isError
    && /"identifier\\?"\s*:\s*\\?"SMD-1863/.test(act.text)
    && /"updatedAt\\?"\s*:\s*\\?"\d{4}-\d\d-\d\dT/.test(act.text);
  checks.push({
    id: "C2",
    pass: adapter.nativeMcpClient && first.after.rows === EXPECTED_ISSUES && captureScoped && searchOk,
    detail: `capture: ${first.after.rows} rows by ${WRITER} (${captureScoped ? "a capture-scope record" : "NOT a capture-scope record"}) through ${adapter.mcpClient}${adapter.nativeMcpClient ? "" : " — not the tool's MCP client, which C2 as posted requires"}; read: brain search through orch-read ${searchOk ? "answered" : "FAILED"}`,
  });
  // Sealed, the brain-side half must pass and the act tool must not: Linear
  // answering means the seal leaked. The tool must still be listed, so a
  // failure is a refused call, not a missing tool.
  const actVerdict = sealed
    ? (find(adapter.tools.act) && !actOk ? `failed, as sealed it must (${act.text.slice(0, 160)})` : actOk ? "ANSWERED — Linear reached from the sealed network" : "NOT LISTED")
    : actOk ? "ok" : `FAIL ${act.text.slice(0, 160)}`;
  checks.push({
    id: "C3",
    pass: searchOk && (sealed ? Boolean(find(adapter.tools.act)) && !actOk : actOk) && anon.refused && wrong.refused,
    detail: `tools [${names.join(", ")}]${listed instanceof Error ? ` (${(listed as Error).message.slice(0, 120)})` : ""}; search ${searchOk ? "ok" : `FAIL ${search.text.slice(0, 160)}`}; act ${actVerdict}; no key → ${anon.refused ? "refused" : "NOT REFUSED"} (${anon.detail}); wrong key → ${wrong.refused ? "refused" : "NOT REFUSED"} (${wrong.detail})`,
  });

  // C1's schedule half: the on-demand runs above say nothing about whether the
  // schedule fires. With --wait-schedule, wait for a run the schedule started
  // since this verify began to succeed, by the tool's own run history.
  if (waitSchedule) {
    let fired = 0;
    let lastError = "";
    const t0 = Date.now();
    // An error reading the history is kept and reported: swallowed, a verifier
    // fault read as "the schedule never fired" (review pass 3).
    await waitFor("a scheduled run", async () => {
      try {
        fired = await adapter.scheduledRuns(env, startedAt);
        lastError = "";
      } catch (e) {
        lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      return fired > 0;
    }, SCHEDULE_WAIT_MS, 30_000).catch(() => {});
    checks.push({
      id: "C1s",
      pass: fired > 0,
      detail: fired > 0
        ? `${fired} scheduled run(s) succeeded since the verify began, the first seen after ${Math.round((Date.now() - t0) / 1000)} s of waiting`
        : `no scheduled run succeeded in ${SCHEDULE_WAIT_MS / 60_000} min${lastError ? ` — the last read of the history failed: ${lastError}` : ""}`,
    });
  }

  // The tool's own checks, after the shared ones: they may rotate a key or
  // move a run's timestamps, which nothing above should see.
  for (const c of (await adapter.extraChecks?.(env, ctx).catch((e: Error) => [{ id: "extra", pass: false, detail: `threw: ${e.message.slice(0, 240)}` }])) ?? []) checks.push(c);

  const busy = memoryByContainer(tool);
  const size = run(["docker", "image", "inspect", adapter.image, "--format", "{{.Size}}"]).out.trim();
  const digest = run(["docker", "image", "inspect", adapter.image, "--format", "{{index .RepoDigests 0}}"]).out.trim();
  const store = adapter.storeFootprint?.(ctx);
  const report = {
    tool, with: ctx.with, version: adapter.version(), image: adapter.image, digest, imageMiB: Math.round(Number(size) / 1048576), store,
    memoryMiB: { atStart: idle, afterRuns: busy }, checks, switches: adapter.switches, searchSample: search.text.slice(0, 400), actSample: act.text.slice(0, 400),
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${tool} ${report.version}${ctx.with.length ? ` (with ${ctx.with.join(", ")})` : ""}  ${adapter.image}  ${report.imageMiB} MiB image`);
    for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}  ${c.detail}`);
    if (!waitSchedule) console.log(`  ---- C1s  not checked: ${sealed ? "sealed, the schedule cannot reach Linear" : "the schedule firing needs --wait-schedule (up to 20 min)"}`);
    for (const [k, v] of Object.entries(busy)) console.log(`  M1   ${k} ${idle[k] ?? "?"} MiB at the start, ${v} MiB after the runs`);
    if (store) console.log(`  M1   store: ${store}`);
  }
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
}

function down(): void {
  const r = compose(tool, ["down", "-v", "--remove-orphans"]);
  if (r.code !== 0) throw new Error(`compose down failed: ${r.err.trim()}`);
  setEnvValue(WITH_KEY, "");
  console.log(`${tool}: project ob1-orch-${tool} removed with its volumes`);
}

if (mode === "--up") await up();
else if (mode === "--verify") await verify();
else down();
