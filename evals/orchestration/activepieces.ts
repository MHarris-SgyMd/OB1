/**
 * activepieces.ts — the Activepieces candidate's adapter (SMD-1863). Everything
 * through its REST API, no UI: the first sign-up becomes the platform admin
 * (sign-up is invitation-only after it), three connections into its encrypted
 * store, the three flows from this directory imported and published. Its
 * project MCP server is on by default; the flows with an MCP Tool trigger
 * appear on it beside Activepieces' own flow-building tools.
 *
 * Running the ingestion once on demand goes through that same MCP server:
 * `ap_test_flow` runs the flow end to end in the test environment — the real
 * Linear call, the real captures — which is how the product itself runs a
 * scheduled flow now. The schedule trigger fires on its own besides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compose, HERE, waitFor } from "./stack.ts";
import type { Adapter } from "./adapter.ts";
import { callTool } from "./mcp-client.ts";

const DIR = join(HERE, "activepieces");
const BASE = "http://127.0.0.1:8080";
const FLOWS = ["linear-ingest.json", "brain-search.json", "linear-issue.json"];
const INGEST = "OB1 — Linear issues into the brain";
const PIECES = ["@activepieces/piece-schedule", "@activepieces/piece-linear", "@activepieces/piece-mcp", "@activepieces/piece-mcp-client"];

type Session = { token: string; projectId: string };

async function api(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** Sign up once (the platform's first user), sign in every time after. */
async function session(env: Record<string, string>): Promise<Session> {
  const creds = { email: "operator@ob1.local", password: env.ORCH_ADMIN_PASSWORD };
  const s = await api("POST", "/v1/authentication/sign-in", creds).catch(() =>
    api("POST", "/v1/authentication/sign-up", { ...creds, firstName: "OB1", lastName: "Operator", trackEvents: false, newsLetter: false }));
  return { token: s.token, projectId: s.projectId };
}

async function flowsByName(s: Session): Promise<Map<string, string>> {
  const page = await api("GET", `/v1/flows?projectId=${s.projectId}&limit=100`, undefined, s.token);
  return new Map((page.data as any[]).map((f) => [f.version.displayName as string, f.id as string]));
}

/**
 * The MCP endpoint takes an OAuth access token — the project record's static
 * `token` is refused (401, measured) — and the REST API issues a short-lived
 * one to a signed-in user, which is the headless path. An AI client goes
 * through the OAuth consent flow in a browser instead.
 */
async function mcpEndpoint(s: Session): Promise<{ url: string; headers: Record<string, string> }> {
  const m = await api("POST", `/v1/projects/${s.projectId}/mcp-server/token`, {}, s.token);
  return { url: m.mcpServerUrl, headers: { authorization: `Bearer ${m.mcpToken}` } };
}

export const activepieces: Adapter = {
  tool: "activepieces",
  services: ["orch-db", "activepieces"],
  image: "ghcr.io/activepieces/activepieces:0.91.3",
  async ready() {
    const r = await fetch(`${BASE}/api/v1/flags`).catch(() => null);
    return r?.ok === true;
  },
  async provision(env) {
    let s = await session(env);
    const steps: string[] = ["sign-up (first user = admin)"];
    // On first boot the piece catalogue arrives from Activepieces' cloud after
    // the API already answers — about 12,800 piece versions written to its
    // database in the background — and a connection for a piece the server does
    // not yet know is refused (404 piece_metadata_not_found). Of nine fresh
    // boots behind this wait, the pieces appeared within it once; eight times
    // they stayed 404 (once watched for 300 s with the rows already in
    // piece_metadata) until a restart rebuilt the server's index from the
    // database. So: wait, and restart once if needed.
    const known = async (sess: Session) => {
      for (const piece of PIECES) await api("GET", `/v1/pieces/${encodeURIComponent(piece)}?projectId=${sess.projectId}`, undefined, sess.token);
      return true;
    };
    try {
      await waitFor("the pieces in the catalogue", () => known(s), 120_000, 5_000);
    } catch {
      const r = compose("activepieces", ["restart", "activepieces"]);
      if (r.code !== 0) throw new Error(`restart failed: ${r.err.trim()}`);
      await waitFor("activepieces after the restart", () => this.ready(env), 300_000);
      s = await session(env);
      await waitFor("the pieces in the catalogue after the restart", () => known(s), 300_000, 5_000);
      steps.push("restart (piece index stale at first boot)");
    }
    const brain = (key: string) => ({
      type: "CUSTOM_AUTH",
      props: { serverUrl: "http://server:8000/", protocol: "streamable-http", authType: "api_key", apiKey: key, apiKeyHeader: "x-brain-key" },
    });
    const connections = [
      { externalId: "linear", displayName: "Linear (read)", pieceName: "@activepieces/piece-linear", value: { type: "SECRET_TEXT", secret_text: env.LINEAR_API_KEY } },
      { externalId: "brain-capture", displayName: "Brain — capture key", pieceName: "@activepieces/piece-mcp-client", value: brain(env.ORCH_BRAIN_CAPTURE_KEY) },
      { externalId: "brain-read", displayName: "Brain — read key", pieceName: "@activepieces/piece-mcp-client", value: brain(env.ORCH_BRAIN_READ_KEY) },
    ];
    for (const c of connections) {
      await api("POST", "/v1/app-connections", { ...c, projectId: s.projectId, type: c.value.type }, s.token);
    }
    const existing = await flowsByName(s);
    for (const f of FLOWS) {
      const request = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      if (existing.has(request.displayName)) continue;
      const flow = await api("POST", "/v1/flows", { displayName: request.displayName, projectId: s.projectId }, s.token);
      await api("POST", `/v1/flows/${flow.id}`, { type: "IMPORT_FLOW", request }, s.token);
      await api("POST", `/v1/flows/${flow.id}`, { type: "LOCK_AND_PUBLISH", request: {} }, s.token);
    }
    return [...steps, "app-connections (3)", "flows: create + IMPORT_FLOW + LOCK_AND_PUBLISH (3)"];
  },
  async runIngestion(env) {
    const s = await session(env);
    const id = (await flowsByName(s)).get(INGEST);
    if (!id) throw new Error(`no flow named "${INGEST}" — run --up first`);
    const { url, headers } = await mcpEndpoint(s);
    const r = await callTool(url, headers, "ap_test_flow", { flowId: id }, 300_000);
    // Success is asserted, not failure denied, and read from the status line
    // ap_test_flow opens with ("✅ Run <id> — SUCCEEDED (21.7s)", measured) —
    // anchored, since the steps it echoes below carry the issues' own text
    // (review passes 1 and 2).
    const run = /^✅ Run (\S+) — SUCCEEDED \(/m.exec(r.text);
    if (r.isError || !run) throw new Error(`ap_test_flow: ${r.text.slice(0, 600)}`);
    // The run record: one loop iteration per issue, each with the capture step's status.
    const record = await api("GET", `/v1/flow-runs/${run[1]}`, undefined, s.token);
    const iterations: any[] = record.steps?.step_3?.output?.iterations ?? [];
    return iterations.filter((i) => i?.step_4?.status === "SUCCEEDED").length;
  },
  async mcpServer(env) {
    return mcpEndpoint(await session(env));
  },
  mcpClient: "the MCP Client piece's call-tool action",
  nativeMcpClient: true,
  tools: { search: "brain_search", act: "linear_issue" },
  version() {
    return "0.91.3";
  },
  switches: {
    telemetry: ["AP_TELEMETRY_ENABLED=false (the starting value only; the UI can re-enable)", "AP_CLOUD_AUTH_ENABLED=false (no Activepieces-hosted OAuth apps)"],
    runtimeFetch: "piece metadata synced from Activepieces' cloud at boot (AP_PIECES_SYNC_MODE=OFFICIAL_AUTO); piece code installed from the npm registry with bun at first use",
  },
};
