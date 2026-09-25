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
 * candidate on its own loopback port. compose runs with an allowlisted
 * environment and orchestration/.env (stack.ts), so a dogfood deploy/.env on
 * the search path reaches neither.
 *
 * What --verify checks (the ticket's comment of 2026-09-25 has the wording):
 *   C1  it first deletes the thoughts `orch-capture` wrote (delete_thought),
 *       then runs the ingestion workflow twice: the first run must land the
 *       whole fixed set — ten rows, ten distinct identifiers, all written by
 *       `orch-capture` — and the second none. The reset is what makes every
 *       verify prove a run executed: without it a dead workflow passed as
 *       "+0, +0" on any verify after the first (review pass 1, a mutant).
 *   C2  capture: those rows' writer is `orch-capture`, a CAPTURE-scope record
 *       in MCP_ACCESS_KEYS, reached by the path the adapter names (a native
 *       MCP-client step, or a script of our own where the tool has none); read:
 *       the brain search on the candidate's endpoint answers, and the only
 *       credential on that path is `orch-read`.
 *   C3  the candidate's own MCP endpoint lists both tools, the brain search
 *       returns thoughts, the Linear lookup returns a field only Linear has
 *       (`updatedAt`), and a session with no key and one with a wrong key are
 *       each refused with HTTP 401 or 403.
 *   M1  memory per container at the start of --verify and after the runs, the
 *       image and its digest, the version.
 * C4 (no UI step) is --up's: it prints the steps it took. --up onto an existing
 * project skips what already exists; after editing a workflow file, --down first.
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
const env: Record<string, string> = { ...ensureEnv(), LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "" };
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

/** Rows `orch-capture` wrote, and how many distinct SMD identifiers they open with. */
function written(): { rows: number; ids: number } {
  const [rows, ids] = brainSql(tool, `SELECT count(*), count(DISTINCT substring(content from '^(SMD-[0-9]+)')) FROM thoughts WHERE metadata->>'actor_name' = '${WRITER}'`).split("|").map(Number);
  return { rows, ids };
}

/** Delete what `orch-capture` wrote, through the brain's own delete path; returns how many. */
function reset(): number {
  return Number(brainSql(tool, `SELECT count(*) FROM (SELECT delete_thought(id) FROM thoughts WHERE metadata->>'actor_name' = '${WRITER}') d`));
}

/** The header values replaced by a wrong one: the key an AI client might mistype. */
const wrongKey = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /^Bearer /i.test(v) ? "Bearer wrong-key" : "wrong-key"]));

async function verify(): Promise<void> {
  const checks: Check[] = [];
  const idle = memoryByContainer(tool);
  const cleared = reset();
  const before = written();
  const t0 = performance.now();
  await adapter.runIngestion(env);
  const firstMs = Math.round(performance.now() - t0);
  const first = written();
  await adapter.runIngestion(env);
  const second = written();
  checks.push({
    id: "C1",
    pass: before.rows === 0 && first.rows === EXPECTED_ISSUES && first.ids === EXPECTED_ISSUES && second.rows === first.rows,
    detail: `reset ${cleared} → ${before.rows}; run 1 +${first.rows} rows, ${first.ids} distinct issues in ${firstMs} ms (wall clock, the brain's model calls included); run 2 +${second.rows - first.rows}`,
  });

  const captureScoped = (env.MCP_ACCESS_KEYS ?? "").split(/[,\n]/).some((r) => r.trim().startsWith(`${WRITER}:capture:`));
  const { url, headers } = await adapter.mcpServer(env);
  // The endpoint can lag the candidate's health check after a restart (n8n
  // registers the MCP webhook after /healthz answers): list until it answers.
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
  const searchOk = !search.isError && /SMD-\d+/.test(search.text);
  // The identifier alone could be the probe's own argument echoed back;
  // `updatedAt` comes only from Linear's answer.
  const actOk = !act.isError && act.text.includes("SMD-1863") && act.text.includes("updatedAt");
  checks.push({
    id: "C2",
    pass: first.rows === EXPECTED_ISSUES && captureScoped && searchOk,
    detail: `capture: ${first.rows} rows by ${WRITER} (${captureScoped ? "a capture-scope record" : "NOT a capture-scope record"}) through ${adapter.mcpClient}; read: brain search through orch-read ${searchOk ? "answered" : "FAILED"}`,
  });
  checks.push({
    id: "C3",
    pass: searchOk && actOk && anon.refused && wrong.refused,
    detail: `tools [${names.join(", ")}]${listed instanceof Error ? ` (${(listed as Error).message.slice(0, 120)})` : ""}; search ${searchOk ? "ok" : `FAIL ${search.text.slice(0, 160)}`}; act ${actOk ? "ok" : `FAIL ${act.text.slice(0, 160)}`}; no key → ${anon.refused ? "refused" : "NOT REFUSED"} (${anon.detail}); wrong key → ${wrong.refused ? "refused" : "NOT REFUSED"} (${wrong.detail})`,
  });

  const busy = memoryByContainer(tool);
  const size = run(["docker", "image", "inspect", adapter.image, "--format", "{{.Size}}"]).out.trim();
  const digest = run(["docker", "image", "inspect", adapter.image, "--format", "{{index .RepoDigests 0}}"]).out.trim();
  const report = {
    tool, version: adapter.version(), image: adapter.image, digest, imageMiB: Math.round(Number(size) / 1048576),
    memoryMiB: { atStart: idle, afterRuns: busy }, checks, switches: adapter.switches, searchSample: search.text.slice(0, 400), actSample: act.text.slice(0, 400),
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${tool} ${report.version}  ${adapter.image}  ${report.imageMiB} MiB image`);
    for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}  ${c.detail}`);
    for (const [k, v] of Object.entries(busy)) console.log(`  M1   ${k} ${idle[k] ?? "?"} MiB at the start, ${v} MiB after the runs`);
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
