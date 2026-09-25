/**
 * n8n.ts — the n8n candidate's adapter (SMD-1863). Everything through n8n's
 * own CLI inside its container, no UI: credentials into its encrypted store
 * (`import:credentials` encrypts a plain `data` object with the instance's
 * key), the two workflows from this directory, published, then a restart so
 * the running process registers the MCP endpoint and the schedule.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compose, HERE } from "./stack.ts";
import type { Adapter } from "./adapter.ts";

const DIR = join(HERE, "n8n");
const WORKFLOWS = { ingest: "ob1LinearIngest1", tools: "ob1BrainToolsMcp" };

function exec(args: string[], input?: string): string {
  const r = compose("n8n", ["exec", "-T", "n8n", ...args], {}, input);
  if (r.code !== 0) throw new Error(`n8n ${args.join(" ")} failed (${r.code}): ${(r.err || r.out).trim().slice(-600)}`);
  return r.out;
}

/** The committed template with `${NAME}` filled from the env — the rendered text never touches disk. */
export function render(template: string, env: Record<string, string>): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
    const v = env[k];
    if (!v) throw new Error(`credentials template names ${k}, which the environment does not set`);
    return JSON.stringify(v).slice(1, -1);
  });
}

/**
 * `n8n execute` prints the run's data after a fixed rule line: the capture
 * node's last run, if it succeeded, output one item per answered call.
 */
export function answered(out: string): number {
  const rule = "====================================\n";
  const at = out.indexOf(rule);
  if (at < 0) throw new Error(`n8n execute printed no run data: ${out.slice(-300)}`);
  const run = JSON.parse(out.slice(at + rule.length));
  if (run.data?.resultData?.error) throw new Error(`the run failed: ${run.data.resultData.error.message}`);
  const capture = run.data?.resultData?.runData?.["Capture into the brain"]?.at(-1);
  if (!capture || capture.executionStatus !== "success") return 0;
  return capture.data?.main?.[0]?.length ?? 0;
}

export const n8n: Adapter = {
  tool: "n8n",
  services: ["orch-db", "n8n"],
  image: "docker.io/n8nio/n8n:2.40.6",
  async ready() {
    const r = await fetch("http://127.0.0.1:5678/healthz").catch(() => null);
    return r?.ok === true;
  },
  async provision(env) {
    const creds = render(readFileSync(join(DIR, "credentials.template.json"), "utf8"), env);
    exec(["sh", "-c", "umask 077; cat > /tmp/c.json && n8n import:credentials --input=/tmp/c.json; rc=$?; rm -f /tmp/c.json; exit $rc"], creds);
    for (const f of ["linear-ingest.json", "brain-tools.json"]) exec(["n8n", "import:workflow", `--input=/import/${f}`]);
    exec(["n8n", "publish:workflow", `--id=${WORKFLOWS.tools}`]);
    exec(["n8n", "publish:workflow", `--id=${WORKFLOWS.ingest}`]);
    const r = compose("n8n", ["restart", "n8n"]);
    if (r.code !== 0) throw new Error(`restart failed: ${r.err.trim()}`);
    return ["import:credentials (4)", "import:workflow (2)", "publish:workflow (2)", "restart"];
  },
  async runIngestion() {
    // A second n8n process beside the running one: its task broker needs a
    // port of its own, or it refuses to start (5679 is the server's).
    const out = exec(["env", "N8N_RUNNERS_BROKER_PORT=5690", "n8n", "execute", `--id=${WORKFLOWS.ingest}`]);
    return answered(out);
  },
  async mcpServer(env) {
    return { url: "http://127.0.0.1:5678/mcp/ob1", headers: { "x-orch-key": env.ORCH_MCP_KEY } };
  },
  mcpClient: "n8n's MCP Client node",
  nativeMcpClient: true,
  tools: { search: "brain_search_thoughts", act: "linear_issue" },
  version() {
    return exec(["n8n", "--version"]).trim();
  },
  switches: {
    telemetry: ["N8N_DIAGNOSTICS_ENABLED=false", "N8N_VERSION_NOTIFICATIONS_ENABLED=false", "N8N_TEMPLATES_ENABLED=false", "N8N_PERSONALIZATION_ENABLED=false", "N8N_DIAGNOSTICS_CONFIG_FRONTEND/BACKEND empty"],
    runtimeFetch: "none: 918 node types ship in the image; community nodes install only when an owner asks",
  },
};
