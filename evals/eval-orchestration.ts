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
 *       then runs the ingestion workflow twice. Each run must report, from the
 *       TOOL's own run record, ten capture_thought calls answered; the brain
 *       must hold ten rows with ten distinct identifiers, all written by
 *       `orch-capture`, after the first and none more after the second. The
 *       reset makes every verify's first run prove itself (review pass 1: a dead
 *       workflow passed as "+0, +0" on a re-verify); the record makes the second
 *       (review pass 2: a skipped second run passed as a dedup's "+0"). A run
 *       that throws is a FAIL row, not an abort.
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
    const answered = await adapter.runIngestion(env);
    return { answered, after: written(), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { answered: 0, after: written(), ms: Math.round(performance.now() - t0), error: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
  }
}

async function verify(): Promise<void> {
  const checks: Check[] = [];
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
