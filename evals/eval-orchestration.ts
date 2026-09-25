/**
 * eval-orchestration.ts — SMD-1863: the same two workflows, run on each
 * orchestration candidate beside a throwaway brain, and the criteria posted on
 * the ticket before any of them ran.
 *
 *   bun eval-orchestration.ts --up <tool>        # brain + candidate, provisioned headlessly
 *   bun eval-orchestration.ts --verify <tool> [--json]
 *   bun eval-orchestration.ts --down <tool>      # removes the project's containers AND volumes
 *
 * <tool> is one of n8n | activepieces | windmill. Each runs as its own compose
 * project, `ob1-orch-<tool>`: deploy/compose.yaml as shipped plus
 * orchestration/compose.<tool>.yaml, the brain on 127.0.0.1:8012 and the
 * candidate on its own loopback port. Nothing reaches a running dogfood stack.
 *
 * What --verify checks (the ticket's comment of 2026-09-25 has the wording):
 *   C1  the ingestion workflow, run twice: the first run lands one thought per
 *       issue, written by the key `orch-capture`; the second lands none.
 *   C2  that capture went through the candidate's MCP client with a CAPTURE-
 *       scope key (the rows' writer), and a read goes through it with a READ-
 *       scope key (the search tool below — the only credential on that node).
 *   C3  the candidate's own MCP endpoint lists both tools, answers a brain
 *       search and a Linear lookup, and refuses a session without its key.
 *   C4  provisioning took no UI step (the adapter's steps are printed).
 *   M1  memory per container after the runs, the image, the version.
 * Needs LINEAR_API_KEY (the usual .env search path) and the host's Ollama.
 */
import { loadEnv } from "./env.ts";
import type { Adapter } from "./orchestration/adapter.ts";
import { callTool, listTools, refuses } from "./orchestration/mcp-client.ts";
import { activepieces } from "./orchestration/activepieces.ts";
import { n8n } from "./orchestration/n8n.ts";
import { windmill } from "./orchestration/windmill.ts";
import { brainSql, compose, ensureEnv, memoryByContainer, run, waitFor } from "./orchestration/stack.ts";

const ADAPTERS: Record<string, Adapter> = { n8n, activepieces, windmill };
/** The ingestion workflow's fixed issue set: ten SMD numbers (see each candidate's workflow). */
const EXPECTED_ISSUES = 10;
const WRITER = "orch-capture";

type Check = { id: string; pass: boolean; detail: string };

function usage(msg: string): never {
  console.error(`${msg}\nusage: bun eval-orchestration.ts --up|--verify|--down <${Object.keys(ADAPTERS).join("|")}> [--json]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const mode = ["--up", "--verify", "--down"].find((m) => args.includes(m)) ?? usage("no mode");
const tool = args[args.indexOf(mode) + 1] ?? usage("no tool");
const adapter = ADAPTERS[tool] ?? usage(`unknown tool ${tool}`);
const json = args.includes("--json");

loadEnv();
const env = { ...ensureEnv(), LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "" };
const brainHealthy = async () => (await fetch("http://127.0.0.1:8012/health").catch(() => null))?.ok === true;

async function up(): Promise<void> {
  if (!env.LINEAR_API_KEY) usage("LINEAR_API_KEY is not set (evals/.env, <repo>/.env or deploy/.env)");
  const r = compose(tool, ["up", "-d", "--build", "postgres", "migrate", "server", ...adapter.services], { LINEAR_API_KEY: env.LINEAR_API_KEY });
  if (r.code !== 0) throw new Error(`compose up failed:\n${r.err.slice(-2000)}`);
  await waitFor("the brain's /health", brainHealthy);
  await waitFor(`${tool} to answer`, () => adapter.ready(env), 300_000);
  const steps = await adapter.provision(env);
  await waitFor(`${tool} after provisioning`, () => adapter.ready(env), 300_000);
  console.log(`${tool} up and provisioned: ${steps.join(", ")}`);
}

const writtenBy = () => Number(brainSql(tool, `SELECT count(*) FROM thoughts WHERE metadata->>'actor_name' = '${WRITER}'`));

async function verify(): Promise<void> {
  const checks: Check[] = [];
  const idle = memoryByContainer(tool);
  const before = writtenBy();
  const t0 = performance.now();
  await adapter.runIngestion(env);
  const firstMs = Math.round(performance.now() - t0);
  const afterFirst = writtenBy();
  await adapter.runIngestion(env);
  const afterSecond = writtenBy();
  const landed = afterFirst - before;
  checks.push({
    id: "C1",
    // On a fresh brain the first run lands the whole set; on a re-verify the set
    // is already there and the first run is itself a repeat. Either way the
    // second run adds nothing.
    pass: (before === 0 ? landed === EXPECTED_ISSUES : landed === 0) && afterSecond === afterFirst,
    detail: `before ${before}, after run 1 ${afterFirst} (+${landed} in ${firstMs} ms), after run 2 ${afterSecond} (+${afterSecond - afterFirst})`,
  });
  checks.push({ id: "C2", pass: afterFirst > 0, detail: `${afterFirst} rows written by ${WRITER} (capture scope) through the candidate's MCP client; read half under C3` });

  const { url, headers } = await adapter.mcpServer(env);
  const listed = await listTools(url, headers).catch((e: Error) => e);
  const names = listed instanceof Error ? [] : listed.map((t) => t.name);
  // The declared name, or the declared name plus a suffix the candidate adds
  // (Activepieces appends `_<id>_mcp` to a flow's tool name).
  const find = (declared: string) => names.find((n) => n === declared || n.startsWith(`${declared}_`));
  const call = async (declared: string, args: Record<string, unknown>) => {
    const name = find(declared);
    if (!name) return { isError: true, text: "not listed" };
    return callTool(url, headers, name, args).catch((e: Error) => ({ isError: true, text: e.message }));
  };
  const search = await call(adapter.tools.search, { query: "which orchestration tool for ingestion and sync", limit: 3 });
  const act = await call(adapter.tools.act, { identifier: "SMD-1863" });
  const anon = await refuses(url, {});
  const searchOk = !search.isError && /SMD-\d+/.test(search.text);
  const actOk = !act.isError && act.text.includes("SMD-1863");
  checks.push({
    id: "C3",
    pass: searchOk && actOk && anon.refused,
    detail: `tools [${names.join(", ")}]${listed instanceof Error ? ` (${listed.message.slice(0, 120)})` : ""}; search ${searchOk ? "ok" : `FAIL ${search.text.slice(0, 160)}`}; act ${actOk ? "ok" : `FAIL ${act.text.slice(0, 160)}`}; no key → ${anon.refused ? "refused" : "ADMITTED"} (${anon.detail.slice(0, 100)})`,
  });

  const busy = memoryByContainer(tool);
  const size = run(["docker", "image", "inspect", adapter.image, "--format", "{{.Size}}"]).out.trim();
  const digest = run(["docker", "image", "inspect", adapter.image, "--format", "{{index .RepoDigests 0}}"]).out.trim();
  const report = {
    tool, version: adapter.version(), image: adapter.image, digest, imageMiB: Math.round(Number(size) / 1048576),
    memoryMiB: { idle, afterRuns: busy }, checks, switches: adapter.switches, searchSample: search.text.slice(0, 400), actSample: act.text.slice(0, 400),
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${tool} ${report.version}  ${adapter.image}  ${report.imageMiB} MiB image`);
    for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}  ${c.detail}`);
    for (const [k, v] of Object.entries(busy)) console.log(`  M1   ${k} ${idle[k] ?? "?"} MiB idle, ${v} MiB after the runs`);
  }
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
}

function down(): void {
  const r = compose(tool, ["down", "-v", "--remove-orphans"]);
  if (r.code !== 0) throw new Error(`compose down failed: ${r.err.trim()}`);
  console.log(`${tool}: project ob1-orch-${tool} removed with its volumes`);
}

if (mode === "--up") await up();
else if (mode === "--verify") await verify();
else down();
