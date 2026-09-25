/**
 * n8n.ts — the n8n candidate's adapter (SMD-1863), on n8n's public REST API
 * (`/api/v1`, OpenAPI-described, versioned, an `X-N8N-API-KEY` header).
 *
 * One step is not the public API: minting its key. A fresh instance has no
 * owner and the public API cannot create a key, so `apiKey()` sets the owner
 * up, signs in and mints one through the internal endpoints the editor uses
 * (`/rest/owner/setup`, `/rest/login`, `/rest/api-keys`), scoped to what the
 * kit calls, and keeps it in orchestration/.env as ORCH_N8N_API_KEY. After
 * that: credentials into n8n's encrypted store (`POST /credentials` — each
 * gets an id of n8n's choosing, which replaces the placeholder the workflow
 * files reference), the two workflows (`POST /workflows`), published
 * (`POST /workflows/{id}/publish`, the v1 "activate"). No restart: publishing
 * registers the schedule, the webhook and the MCP endpoint.
 *
 * An on-demand run is the workflow's own Webhook trigger (`POST
 * /webhook/ob1-ingest`, header auth, answering when the last node finishes),
 * and what it did is read back from `GET /executions` — no second n8n process
 * and no parsing of the CLI's printout. The same history answers whether the
 * schedule fired (executions whose mode is `trigger`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compose, HERE, setEnvValue } from "./stack.ts";
import type { Adapter } from "./adapter.ts";

const DIR = join(HERE, "n8n");
const BASE = "http://127.0.0.1:5678";
const OWNER = { email: "operator@ob1.local", firstName: "OB1", lastName: "Operator" };
const INGEST = "OB1 — Linear issues into the brain";
const WORKFLOW_FILES = ["linear-ingest.json", "brain-tools.json"];
/** The key's scopes: what this adapter calls, and nothing else of the ~90 n8n offers. */
const SCOPES = ["credential:create", "credential:list", "workflow:create", "workflow:list", "workflow:read", "workflow:activate", "execution:list", "execution:read"];

/** The committed template with `${NAME}` filled from the env — the rendered text never touches disk. */
export function render(template: string, env: Record<string, string>): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
    const v = env[k];
    if (!v) throw new Error(`credentials template names ${k}, which the environment does not set`);
    return JSON.stringify(v).slice(1, -1);
  });
}

async function call(path: string, init: RequestInit, what: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`${what} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${what} ${path} → ${r.status}, not JSON: ${text.slice(0, 200)}`);
  }
}

const api = (key: string, method: string, path: string, body?: unknown) =>
  call(`/api/v1${path}`, { method, headers: { "content-type": "application/json", "X-N8N-API-KEY": key }, body: body === undefined ? undefined : JSON.stringify(body) }, method);

/** The stored key if n8n still honours it; otherwise the one-time bootstrap, and the new key stored. */
async function apiKey(env: Record<string, string>): Promise<string> {
  const stored = env.ORCH_N8N_API_KEY;
  if (stored && (await fetch(`${BASE}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": stored } })).ok) return stored;
  const json = { "content-type": "application/json" };
  const password = env.ORCH_ADMIN_PASSWORD;
  // A fresh database has no owner; one that has an owner answers 400, and signing in follows either way.
  await fetch(`${BASE}/rest/owner/setup`, { method: "POST", headers: json, body: JSON.stringify({ ...OWNER, password }) });
  const login = await fetch(`${BASE}/rest/login`, { method: "POST", headers: json, body: JSON.stringify({ emailOrLdapLoginId: OWNER.email, password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!login.ok || !cookie) throw new Error(`n8n sign-in failed (${login.status})`);
  const minted = await call("/rest/api-keys", {
    method: "POST", headers: { ...json, cookie },
    body: JSON.stringify({ label: `ob1-orchestration-${Date.now()}`, scopes: SCOPES, expiresAt: null }),
  }, "mint key");
  const key: string = minted.data.rawApiKey;
  setEnvValue("ORCH_N8N_API_KEY", key);
  env.ORCH_N8N_API_KEY = key;
  return key;
}

async function workflowId(key: string, name: string): Promise<string | undefined> {
  const page = await api(key, "GET", `/workflows?limit=100&name=${encodeURIComponent(name)}`);
  return (page.data as any[]).find((w) => w.name === name)?.id;
}

/** The capture node's last run in an execution's data: one output item per answered call, if it succeeded. */
export function answered(execution: any): number {
  if (execution?.status !== "success") return 0;
  const capture = execution.data?.resultData?.runData?.["Capture into the brain"]?.at(-1);
  if (!capture || capture.executionStatus !== "success") return 0;
  return capture.data?.main?.[0]?.length ?? 0;
}

export const n8n: Adapter = {
  tool: "n8n",
  services: ["orch-db", "n8n"],
  image: "docker.io/n8nio/n8n:2.40.6",
  async ready() {
    // /healthz answers while n8n is still starting; its API then returns the
    // text "n8n is starting up…" (measured on a fresh boot). Readiness waits
    // for the database and the server.
    const r = await fetch(`${BASE}/healthz/readiness`).catch(() => null);
    return r?.ok === true;
  },
  async provision(env) {
    const key = await apiKey(env);
    // Credentials: create the ones not there by name, and map each template
    // placeholder id to the id n8n gave it.
    const existing = new Map(((await api(key, "GET", "/credentials?limit=100")).data as any[]).map((c) => [c.name as string, c.id as string]));
    const ids = new Map<string, string>();
    for (const c of JSON.parse(render(readFileSync(join(DIR, "credentials.template.json"), "utf8"), env))) {
      const id = existing.get(c.name) ?? (await api(key, "POST", "/credentials", { name: c.name, type: c.type, data: c.data })).id;
      ids.set(c.id, id);
    }
    for (const f of WORKFLOW_FILES) {
      let text = readFileSync(join(DIR, f), "utf8");
      for (const [placeholder, id] of ids) text = text.replaceAll(`"${placeholder}"`, JSON.stringify(id));
      const w = JSON.parse(text);
      const id = (await workflowId(key, w.name)) ?? (await api(key, "POST", "/workflows", { name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings })).id;
      await api(key, "POST", `/workflows/${id}/publish`, {});
    }
    return ["owner + API key (internal /rest, once)", "POST /credentials (4)", "POST /workflows (2)", "POST /workflows/{id}/publish (2)"];
  },
  async runIngestion(env) {
    const key = await apiKey(env);
    const id = await workflowId(key, INGEST);
    if (!id) throw new Error(`no workflow named "${INGEST}" — run --up first`);
    const since = new Date(Date.now() - 1000).toISOString();
    await call("/webhook/ob1-ingest", { method: "POST", headers: { "x-orch-key": env.ORCH_MCP_KEY, "content-type": "application/json" }, body: "{}" }, "webhook");
    // The run the webhook started: newest first, started after the call, mode webhook.
    const page = await api(key, "GET", `/executions?workflowId=${id}&includeData=true&limit=20&startedAfter=${encodeURIComponent(since)}`);
    const run = (page.data as any[]).find((e) => e.mode === "webhook");
    if (!run) throw new Error("the webhook answered but no webhook execution is in the history");
    return answered(run);
  },
  async scheduledRuns(env, since) {
    const key = await apiKey(env);
    const id = await workflowId(key, INGEST);
    if (!id) return 0;
    const page = await api(key, "GET", `/executions?workflowId=${id}&status=success&limit=100&startedAfter=${encodeURIComponent(since)}`);
    return (page.data as any[]).filter((e) => e.mode === "trigger").length;
  },
  async mcpServer(env) {
    return { url: `${BASE}/mcp/ob1`, headers: { "x-orch-key": env.ORCH_MCP_KEY } };
  },
  mcpClient: "n8n's MCP Client node",
  nativeMcpClient: true,
  tools: { search: "brain_search_thoughts", act: "linear_issue" },
  version() {
    return compose("n8n", ["exec", "-T", "n8n", "n8n", "--version"]).out.trim();
  },
  switches: {
    telemetry: ["N8N_DIAGNOSTICS_ENABLED=false", "N8N_VERSION_NOTIFICATIONS_ENABLED=false", "N8N_TEMPLATES_ENABLED=false", "N8N_PERSONALIZATION_ENABLED=false", "N8N_DIAGNOSTICS_CONFIG_FRONTEND/BACKEND empty"],
    runtimeFetch: "none: 918 node types ship in the image; community nodes install only when an owner asks",
  },
};
