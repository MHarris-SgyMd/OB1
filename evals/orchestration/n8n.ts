/**
 * n8n.ts — the n8n candidate's adapter. Since SMD-2210 this is the SHIPPED
 * profile: deploy/compose.yaml's `orchestration` service, run as it ships,
 * provisioned by the profile's own step (deploy/orchestration/provision.ts),
 * imported here so the kit tests the same code. SMD-1863's POC ran n8n on
 * the brain's database server, and had its own copy of that step.
 *
 * Provisioning loads the profile's credentials (the brain's capture key, and
 * separate inbound keys for the MCP endpoint and for on-demand runs), then
 * the kit's two extra credentials (Linear, and a read key for the eval's
 * brain tool), then the kit's workflows. On-demand runs go through a
 * workflow's own Webhook trigger, which takes the run key, never the MCP one.
 * What a run did is read back from `GET /executions`.
 *
 * On top of C1–C3, extraChecks covers what the profile adds:
 *   K  the two inbound keys are not interchangeable. After a rotation
 *      (provision --rotate) the replaced API key answers 401, the new one
 *      works and carries an expiry, and n8n holds exactly one provisioned key.
 *   P  a saved run older than the window is gone, from the API and from the
 *      store. One just inside the window is still there.
 *   E  under `--with sealed`: what n8n tried to reach, from the watcher's
 *      capture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api, ensureApiKey, keyExpiry, PROFILE_CREDENTIALS, provision, provisionedKeys, type Options } from "../../deploy/orchestration/provision.ts";
import { refuses } from "./mcp-client.ts";
import { compose, ENV_FILE, HERE } from "./stack.ts";
import type { Adapter, Check, Ctx } from "./adapter.ts";

const DIR = join(HERE, "n8n");
const BASE = "http://127.0.0.1:5678";
const INGEST = { name: "OB1 — Linear issues into the brain", path: "ob1-ingest" };
const PROBE = { name: "OB1 — egress probe captures", path: "ob1-probe" };
const SEALED = "sealed";
/** The outside hosts the kit's workflows name: the Linear fetch and the act tool. E allows these and no other. */
const TEMPLATE_HOSTS = ["api.linear.app"];
/** The profile's image, read from deploy/compose.yaml: the one place it is pinned. */
const IMAGE: string = (Bun.YAML.parse(readFileSync(join(HERE, "..", "..", "deploy", "compose.yaml"), "utf8")) as any).services.n8n.image;

const options = (env: Record<string, string>, rotate = false): Options => ({
  base: BASE, env, envFile: ENV_FILE, rotate,
  credentials: [PROFILE_CREDENTIALS, join(DIR, "credentials.template.json")],
  workflows: ["linear-ingest.json", "brain-tools.json", "probe-capture.json"].map((f) => join(DIR, f)),
});
const apiKey = async (env: Record<string, string>) => (await ensureApiKey(options(env))).key;
const sealed = (ctx: Ctx) => ctx.with.includes(SEALED);

async function workflowId(key: string, name: string): Promise<string | undefined> {
  const page = await api(BASE, key, "GET", `/workflows?limit=100&name=${encodeURIComponent(name)}`);
  return (page.data as any[]).find((w) => w.name === name)?.id;
}

/** The capture node's last run in an execution's data: one output item per answered call, if it succeeded. */
function answered(execution: any): number {
  if (execution?.status !== "success") return 0;
  const capture = execution.data?.resultData?.runData?.["Capture into the brain"]?.at(-1);
  if (!capture || capture.executionStatus !== "success") return 0;
  return capture.data?.main?.[0]?.length ?? 0;
}

/** Execution ids of this process's on-demand runs, oldest first. P moves two of them across the window. */
const runIds: string[] = [];

/**
 * One statement on n8n's store, from inside the container: node:sqlite
 * (Node 26 in the image) on the SQLite file, or psql on `--with postgres`'s
 * server. Rows come back as JSON lines (sqlite) or `|`-separated (psql), and
 * the callers read counts only.
 */
function storeSql(ctx: Ctx, sql: string): string {
  const r = ctx.with.includes("postgres")
    ? compose("n8n", ["exec", "-T", "n8n-db", "psql", "-U", "n8n", "-d", "n8n", "-v", "ON_ERROR_STOP=1", "-Atc", sql])
    : compose("n8n", ["exec", "-T", "n8n", "node", "-e",
      "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/home/node/.n8n/database.sqlite', { timeout: 10000 });" +
      " const sql = require('fs').readFileSync(0, 'utf8'); const st = db.prepare(sql);" +
      " if (/^\\s*select/i.test(sql)) for (const row of st.all()) console.log(Object.values(row).join('|')); else st.run();"], {}, sql);
  if (r.code !== 0) throw new Error(`store query failed: ${r.err.trim().slice(0, 300)}`);
  return r.out.trim();
}

/** Backdate one execution's start and stop by `hours`, in the store's own date format. */
function backdate(ctx: Ctx, id: string, hours: number): void {
  const at = ctx.with.includes("postgres") ? `now() - interval '${hours} hours'` : `strftime('%Y-%m-%d %H:%M:%f', 'now', '-${hours} hours')`;
  storeSql(ctx, `UPDATE execution_entity SET "startedAt" = ${at}, "stoppedAt" = ${at} WHERE id = ${Number(id)}`);
}

/** The window the running service was given (EXECUTIONS_DATA_MAX_AGE, hours), from compose's rendered config. */
function windowHours(): number {
  const cfg = JSON.parse(compose("n8n", ["config", "--format", "json"]).out || "{}");
  return Number(cfg.services?.n8n?.environment?.EXECUTIONS_DATA_MAX_AGE ?? NaN);
}

async function keyChecks(env: Record<string, string>, ctx: Ctx): Promise<Check> {
  // The two inbound keys are not interchangeable: the MCP key does not start
  // a run, and the run key does not open the MCP endpoint.
  const path = sealed(ctx) ? PROBE.path : INGEST.path;
  const runWithMcpKey = await fetch(`${BASE}/webhook/${path}`, { method: "POST", headers: { "x-n8n-run-key": env.N8N_MCP_KEY, "content-type": "application/json" }, body: "{}" });
  const mcpWithRunKey = await refuses(`${BASE}/mcp/ob1`, { "x-n8n-key": env.N8N_WEBHOOK_KEY });
  const separate = (runWithMcpKey.status === 401 || runWithMcpKey.status === 403) && mcpWithRunKey.refused;
  // A rotation: the key it replaces answers 401, the new one works and expires when N8N_API_KEY_DAYS says.
  const before = await apiKey(env);
  const rotated = await provision(options(env, true));
  const probe = async (k: string) => (await fetch(`${BASE}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": k } })).status;
  const [oldStatus, newStatus] = [await probe(before), await probe(rotated.key.key)];
  const exp = keyExpiry(rotated.key.key);
  const days = Number(env.N8N_API_KEY_DAYS || 90);
  const expiryOk = exp !== null && Math.abs(exp - (Date.now() / 1000 + days * 86400)) < 86400;
  const held = await provisionedKeys(BASE, env);
  return {
    id: "K",
    pass: separate && rotated.key.minted && rotated.key.key !== before && oldStatus === 401 && newStatus === 200 && expiryOk && held.length === 1,
    detail: `run webhook with the MCP key → ${runWithMcpKey.status}; MCP endpoint with the run key → ${mcpWithRunKey.refused ? "refused" : "NOT REFUSED"} (${mcpWithRunKey.detail}); `
      + `--rotate: ${rotated.key.revoked} revoked, the replaced key → ${oldStatus}, the new one → ${newStatus}, expires ${exp ? new Date(exp * 1000).toISOString().slice(0, 10) : "NEVER"} (${days} days asked); n8n holds ${held.length} provisioned key(s)`,
  };
}

async function pruningCheck(env: Record<string, string>, ctx: Ctx): Promise<Check> {
  const hours = windowHours();
  if (runIds.length < 2 || !Number.isFinite(hours)) return { id: "P", pass: false, detail: `needs two runs and the window (${runIds.length} run(s); window ${hours} h)` };
  const [past, inside] = runIds;
  backdate(ctx, past, hours + 1);
  backdate(ctx, inside, hours - 1);
  const key = await apiKey(env);
  const status = async (id: string) => (await fetch(`${BASE}/api/v1/executions/${id}`, { headers: { "X-N8N-API-KEY": key } })).status;
  const stored = (id: string) => Number(storeSql(ctx, `SELECT count(*) FROM execution_entity WHERE id = ${Number(id)}`));
  const t0 = Date.now();
  let gone = false;
  // One minute to soft-delete (the overlay's interval), one to hard-delete, and room.
  while (Date.now() - t0 < 240_000) {
    if ((await status(past)) === 404 && stored(past) === 0) { gone = true; break; }
    await Bun.sleep(10_000);
  }
  const [insideStatus, insideStored] = [await status(inside), stored(inside)];
  return {
    id: "P",
    pass: gone && insideStatus === 200 && insideStored === 1,
    detail: `window ${hours} h: run ${past} moved ${hours + 1} h back → ${gone ? `gone from the API and the store after ${Math.round((Date.now() - t0) / 1000)} s` : "STILL THERE after 240 s"}; run ${inside} moved ${hours - 1} h back → API ${insideStatus}, ${insideStored} row(s) in the store`,
  };
}

/**
 * The watcher's capture read back: each DNS name n8n asked for, and each TCP
 * connection it tried, by destination. It must include n8n's calls to the
 * brain (a SYN to port 8000). A capture without them saw nothing, and
 * proves nothing.
 */
function egressRecord(): Check {
  const log = compose("n8n", ["logs", "--no-log-prefix", "egress-watch"]).out;
  const names = new Map<string, number>();
  const dials = new Map<string, number>();
  for (const line of log.split("\n")) {
    // A query line: `… > 10.89.0.1.53: 4711+ A? api.n8n.io. (28)`. An answer does not repeat the question.
    const q = / (?:A|AAAA|HTTPS|SVCB|PTR|SRV|TXT|MX)\? (\S+?)\.? \(\d+\)/.exec(line);
    if (q) names.set(q[1], (names.get(q[1]) ?? 0) + 1);
    // A SYN to port 5678 is someone connecting TO n8n (the front, the
    // healthcheck). One to loopback stays inside the container (n8n's task
    // runner, the healthcheck). Neither is n8n reaching out.
    const s = / > (\S+)\.(\d+): Flags \[S\]/.exec(line);
    if (s && s[2] !== "5678" && !/^(127\.|::1$)/.test(s[1])) dials.set(`${s[1]}:${s[2]}`, (dials.get(`${s[1]}:${s[2]}`) ?? 0) + 1);
  }
  const INTERNAL = /^(server|n8n|n8n-front|egress-watch|postgres)(\.|$)/;
  const external = [...names.keys()].filter((n) => !INTERNAL.test(n));
  // What the kit's own templates name, and nothing else: n8n itself must
  // dial no one. Before N8N_DISABLED_MODULES=mcp-registry it asked for
  // api.n8n.io at boot (measured), and a bump that adds a caller fails here.
  const unexpected = external.filter((n) => !TEMPLATE_HOSTS.includes(n));
  const toBrain = [...dials.keys()].some((d) => d.endsWith(":8000"));
  const fmt = (m: Map<string, number>, keep: (k: string) => boolean) => [...m].filter(([k]) => keep(k)).map(([k, v]) => `${k} ×${v}`).join(", ") || "none";
  return {
    id: "E",
    pass: toBrain && unexpected.length === 0,
    detail: `${toBrain ? "" : "NO SYN to the brain's port 8000 — the watcher saw nothing; "}${unexpected.length ? `NOT A TEMPLATE'S HOST: ${unexpected.join(", ")}; ` : ""}names asked outside the compose network: ${fmt(names, (n) => external.includes(n))} (the templates name ${TEMPLATE_HOSTS.join(", ")}); names inside: ${fmt(names, (n) => !external.includes(n))}; outbound TCP attempts: ${fmt(dials, () => true)}`,
  };
}

export const n8n: Adapter = {
  tool: "n8n",
  services: ["n8n"],
  image: IMAGE,
  profile: "orchestration",
  variants: {
    postgres: { file: "compose.n8n-postgres.yaml", services: ["n8n-db"] },
    sealed: { file: "compose.n8n-sealed.yaml", services: ["egress-watch", "n8n-front"] },
  },
  sealedVariant: SEALED,
  async ready() {
    // /healthz answers while n8n is still starting, and its API then answers
    // "n8n is starting up…" (measured). Readiness waits for the database and
    // the server.
    const r = await fetch(`${BASE}/healthz/readiness`).catch(() => null);
    return r?.ok === true;
  },
  async provision(env) {
    const { steps } = await provision(options(env));
    return steps;
  },
  async runIngestion(env, ctx) {
    const flow = sealed(ctx) ? PROBE : INGEST;
    const key = await apiKey(env);
    const id = await workflowId(key, flow.name);
    if (!id) throw new Error(`no workflow named "${flow.name}" — run --up first`);
    // The run the webhook starts is the first webhook execution with an id past
    // the newest one before the call. Ids, not times: a time bound compares the
    // host's clock with the podman VM's, and a VM behind by a second would hide
    // the run (review pass 3).
    const newest = Number((await api(BASE, key, "GET", `/executions?workflowId=${id}&limit=1`)).data?.[0]?.id ?? 0);
    const r = await fetch(`${BASE}/webhook/${flow.path}`, { method: "POST", headers: { "x-n8n-run-key": env.N8N_WEBHOOK_KEY, "content-type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(`webhook /webhook/${flow.path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const page = await api(BASE, key, "GET", `/executions?workflowId=${id}&includeData=true&limit=20`);
    const run = (page.data as any[]).find((e) => e.mode === "webhook" && Number(e.id) > newest);
    if (!run) throw new Error("the webhook answered but no new webhook execution is in the history");
    runIds.push(String(run.id));
    return answered(run);
  },
  async scheduledRuns(env, since) {
    const key = await apiKey(env);
    const id = await workflowId(key, INGEST.name);
    if (!id) return 0;
    const page = await api(BASE, key, "GET", `/executions?workflowId=${id}&status=success&limit=100&startedAfter=${encodeURIComponent(since)}`);
    // The time bound is also read here, not left to the query parameter alone.
    return (page.data as any[]).filter((e) => e.mode === "trigger" && Date.parse(e.startedAt) >= Date.parse(since)).length;
  },
  async mcpServer(env) {
    return { url: `${BASE}/mcp/ob1`, headers: { "x-n8n-key": env.N8N_MCP_KEY } };
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
  async extraChecks(env, ctx) {
    const checks = [await keyChecks(env, ctx), await pruningCheck(env, ctx)];
    if (sealed(ctx)) checks.push(egressRecord());
    return checks;
  },
  storeFootprint(ctx) {
    if (ctx.with.includes("postgres")) {
      const r = compose("n8n", ["exec", "-T", "n8n-db", "psql", "-U", "n8n", "-d", "n8n", "-Atc", "SELECT pg_database_size('n8n')"]);
      return `Postgres 17 database n8n: ${(Number(r.out.trim()) / 1048576).toFixed(1)} MiB`;
    }
    const r = compose("n8n", ["exec", "-T", "n8n", "node", "-e",
      "const fs = require('fs'); const d = '/home/node/.n8n'; console.log(fs.readdirSync(d).filter((f) => f.startsWith('database.sqlite')).map((f) => f + '=' + fs.statSync(d + '/' + f).size).join(' '))"]);
    const parts = r.out.trim().split(" ").filter(Boolean).map((p) => p.split("="));
    const total = parts.reduce((s, [, b]) => s + Number(b), 0);
    return `SQLite ${(total / 1048576).toFixed(1)} MiB (${parts.map(([f, b]) => `${f} ${(Number(b) / 1048576).toFixed(1)}`).join(", ")})`;
  },
};
