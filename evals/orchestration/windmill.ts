/**
 * windmill.ts — the Windmill candidate's adapter (SMD-1863). Everything through
 * its REST API, no UI: the seeded superadmin (admin@windmill.dev / changeme)
 * signs in and its password is replaced at once, telemetry is switched off in
 * the instance settings, a workspace `ob1` gets a folder, three secret
 * variables and the three scripts from this directory (Bun; Windmill resolves
 * their npm imports into a lockfile when each is deployed), and the ingestion
 * script a schedule. The MCP token is scoped to the two tool scripts alone
 * (`mcp:scripts:` — Windmill's own least-privilege form): the endpoint lists
 * those two and `runScriptByPath`, which refuses any path outside the scope.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, waitFor } from "./stack.ts";
import type { Adapter } from "./adapter.ts";

const DIR = join(HERE, "windmill");
const BASE = "http://127.0.0.1:8090";
const WS = "ob1";
const SEED = { email: "admin@windmill.dev", password: "changeme" };

const SCRIPTS: { path: string; file: string; summary: string; schema: object }[] = [
  { path: "f/ob1/linear_ingest", file: "linear_ingest.ts", summary: "Linear issues into the brain", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, required: [] } },
  {
    path: "f/ob1/brain_search", file: "brain_search.ts", summary: "Search the Open Brain for thoughts about a topic",
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
  },
  {
    path: "f/ob1/linear_issue", file: "linear_issue.ts", summary: "A Linear issue's live state by identifier, e.g. SMD-1863",
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { identifier: { type: "string", description: "A Linear issue identifier such as SMD-1863" } }, required: ["identifier"] },
  },
];

async function api(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** Sign in with the operator's password; on a fresh instance, with the seed's, replacing it. */
async function login(env: Record<string, string>): Promise<string> {
  const mine = { email: SEED.email, password: env.ORCH_ADMIN_PASSWORD };
  const token = await api("POST", "/auth/login", mine).catch(() => null);
  if (token) return token;
  const seeded = await api("POST", "/auth/login", SEED);
  await api("POST", "/users/setpassword", { password: env.ORCH_ADMIN_PASSWORD }, seeded);
  return seeded;
}

async function orIgnoreExisting(p: Promise<unknown>): Promise<void> {
  await p.catch((e: Error) => { if (!/already exists|409|400.*exists/i.test(e.message)) throw e; });
}

export const windmill: Adapter = {
  tool: "windmill",
  services: ["orch-db", "windmill"],
  image: "ghcr.io/windmill-labs/windmill:1.817.0",
  async ready() {
    const r = await fetch(`${BASE}/api/version`).catch(() => null);
    return r?.ok === true;
  },
  async provision(env) {
    const t = await login(env);
    await api("POST", "/settings/global/disable_stats", { value: true }, t);
    await orIgnoreExisting(api("POST", "/workspaces/create", { id: WS, name: "OB1" }, t));
    await orIgnoreExisting(api("POST", `/w/${WS}/folders/create`, { name: "ob1" }, t));
    const secrets = { linear_api_key: env.LINEAR_API_KEY, brain_capture_key: env.ORCH_BRAIN_CAPTURE_KEY, brain_read_key: env.ORCH_BRAIN_READ_KEY };
    for (const [name, value] of Object.entries(secrets)) {
      await orIgnoreExisting(api("POST", `/w/${WS}/variables/create`, { path: `f/ob1/${name}`, value, is_secret: true, description: "SMD-1863 POC" }, t));
    }
    for (const s of SCRIPTS) {
      const exists = await api("GET", `/w/${WS}/scripts/exists/p/${s.path}`, undefined, t);
      if (exists === true) continue;
      await api("POST", `/w/${WS}/scripts/create`, {
        path: s.path, summary: s.summary, description: s.summary, content: readFileSync(join(DIR, s.file), "utf8"),
        language: "bun", kind: "script", schema: s.schema,
      }, t);
    }
    // A script is runnable once its dependency job has written the lockfile.
    for (const s of SCRIPTS) {
      await waitFor(`the lockfile of ${s.path}`, async () => {
        const got = await api("GET", `/w/${WS}/scripts/get/p/${s.path}`, undefined, t);
        if (got.lock_error_logs) throw new Error(`${s.path}: ${String(got.lock_error_logs).slice(0, 400)}`);
        return typeof got.lock === "string" && got.lock.length > 0;
      }, 300_000, 3_000);
    }
    await orIgnoreExisting(api("POST", `/w/${WS}/schedules/create`, {
      path: "f/ob1/linear_ingest_every_15m", schedule: "0 */15 * * * *", timezone: "UTC",
      script_path: "f/ob1/linear_ingest", is_flow: false, args: {}, enabled: true,
    }, t));
    return ["login (seeded superadmin, password replaced)", "disable_stats", "workspace + folder", "secret variables (3)", "scripts/create (3) + lockfiles", "schedule"];
  },
  async runIngestion(env) {
    const t = await login(env);
    // The job's own result: the script returns the identifiers it captured.
    const result = await api("POST", `/w/${WS}/jobs/run_wait_result/p/f/ob1/linear_ingest`, {}, t);
    return Array.isArray(result?.captured) ? result.captured.length : 0;
  },
  async scheduledRuns(env, since) {
    const t = await login(env);
    const jobs = await api("GET", `/w/${WS}/jobs/completed/list?schedule_path=f/ob1/linear_ingest_every_15m&success=true&created_or_started_after=${encodeURIComponent(since)}&per_page=100`, undefined, t);
    // The time bound is also read here, not left to the query parameter alone.
    return Array.isArray(jobs) ? jobs.filter((j: any) => Date.parse(j.started_at ?? j.created_at) >= Date.parse(since)).length : 0;
  },
  async mcpServer(env) {
    const t = await login(env);
    const token = await api("POST", "/users/tokens/create", {
      // One per --verify, so it expires within the hour rather than piling up.
      label: `ob1-mcp-${Date.now()}`, workspace_id: WS, scopes: ["mcp:scripts:f/ob1/brain_search,f/ob1/linear_issue"],
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
    }, t);
    return { url: `${BASE}/api/mcp/w/${WS}/mcp`, headers: { authorization: `Bearer ${token}` } };
  },
  // Windmill names a script's tool from its path: `s-`, then the path with `/`
  // as `_` and every `_` doubled (measured: f/ob1/brain_search → s-f_ob1_brain__search).
  mcpClient: "a script of ours importing the MCP SDK (Windmill has no MCP-client step)",
  nativeMcpClient: false,
  tools: { search: "s-f_ob1_brain__search", act: "s-f_ob1_linear__issue" },
  version() {
    return "CE v1.817.0";
  },
  switches: {
    telemetry: ["instance setting disable_stats=true through the API (no environment variable exists)"],
    runtimeFetch: "a script's npm imports resolved from the npm registry into a lockfile at deploy (the MCP SDK, windmill-client); the Hub is fetched only when asked",
  },
};
