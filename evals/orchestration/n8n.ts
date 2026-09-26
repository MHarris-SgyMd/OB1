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
import { compose, ENV_FILE, HERE, N8N_KIT_PORT, run } from "./stack.ts";
import type { Adapter, Check, Ctx } from "./adapter.ts";

const DIR = join(HERE, "n8n");
const BASE = `http://127.0.0.1:${N8N_KIT_PORT}`;
const INGEST = { name: "OB1 — Linear issues into the brain", path: "ob1-ingest" };
const PROBE = { name: "OB1 — egress probe captures", path: "ob1-probe" };
const SEALED = "sealed";
/** The outside hosts the kit's workflows name: the Linear fetch and the act tool. E allows these and no other. */
const TEMPLATE_HOSTS = ["api.linear.app"];
/** The profile's image, read from deploy/compose.yaml: the one place it is pinned. */
const IMAGE: string = (Bun.YAML.parse(readFileSync(join(HERE, "..", "..", "deploy", "compose.yaml"), "utf8")) as any).services.n8n.image;

const options = (env: Record<string, string>, rotate = false): Options => ({
  base: BASE, env, envFile: ENV_FILE, rotate,
  // The kit reads run history (C1, C1s, P); an operator's key does not carry these.
  extraScopes: ["execution:list", "execution:read"],
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

/** The compose services whose names are n8n's own network's, bare or with one of its search domains. */
const SERVICES = ["server", "n8n", "n8n-front", "egress-watch", "postgres"];

/** What the judge is told rather than infers: read from n8n's /etc/resolv.conf and the engine. */
export type EgressFacts = { resolvers: string[]; searchDomains: string[]; brain: string[] };

/**
 * The watcher's capture judged, failing closed. Pass 2 found the name-and-answer
 * inference passing real escapes:
 * - a name starting `server.` or `n8n.` counted as internal, so `n8n.io`'s
 *   answer became an allowed address;
 * - an EDNS or NS query was invisible;
 * - a UDP datagram tcpdump decodes (NTP, QUIC) was not counted;
 * - port 5678 was exempt on every address.
 *
 * So the facts come from outside (resolvers, search domains, the brain's
 * addresses), and every OUTBOUND packet line on n8n's network interface
 * (tcpdump's `Out`; loopback stays in the container) must be one of two
 * things:
 * - DNS to a listed resolver (UDP, or TCP port 53 for a truncated answer);
 * - a connection attempt to the brain's :8000.
 * Anything else is a dial outside, including a packet line the judge cannot
 * read. Every DNS query of any type is read for its name, on any interface.
 * A name outside the network — a service name bare, or with one of the
 * search domains the resolver appends — fails unless a kit template names
 * its host. The brain must have been seen, or the capture proves nothing.
 * Exported for the self-check: pure over the log and the facts.
 */
export function judgeEgress(log: string, facts: EgressFacts): Check {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const internal = new RegExp(`^(${SERVICES.map(esc).join("|")})(\\.(${facts.searchDomains.map(esc).join("|") || "(?!)"}))?\\.?$`);
  const names = new Map<string, number>();
  const dials = new Map<string, number>();
  const unreadable: string[] = [];
  let toBrain = 0;
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const hostPort = (a: string) => { const i = a.lastIndexOf("."); return { host: a.slice(0, i), port: a.slice(i + 1) }; };
  for (const line of log.split("\n")) {
    // tcpdump's own messages carry no timestamp; every packet line does (-tttt).
    if (!/^\d{4}-\d\d-\d\d /.test(line)) continue;
    const p = /^\S+ \S+ (\S+)\s+(\S+)\s+IP6? (\S+) > (\S+): (.*)$/.exec(line);
    if (!p) { unreadable.push(line.slice(0, 120)); continue; }
    const [, iface, dir, , dstRaw, rest] = p;
    const dst = hostPort(dstRaw);
    // A query of any type, EDNS flags and all: `4711+ [1au] A? name. (40)`.
    const q = /^\d+\+?(?: \[[^\]]*\])* [A-Z0-9-]+\? (\S+?)\.? \(\d+\)/.exec(rest);
    if (q && dst.port === "53" && (dir === "Out" || iface === "lo")) count(names, q[1].toLowerCase());
    if (iface === "lo" || dir !== "Out") continue;
    const syn = /^Flags \[S\]/.test(rest);
    if (dst.port === "53" && facts.resolvers.includes(dst.host)) continue;
    if (syn && dst.port === "8000" && facts.brain.includes(dst.host)) { toBrain++; continue; }
    count(dials, `${dst.host}:${dst.port} (${syn ? "tcp" : rest.split(/[ ,]/)[0] || "udp"})`);
  }
  const external = [...names.keys()].filter((n) => !internal.test(n));
  // What the kit's own templates name, and nothing else: n8n itself must
  // dial no one. Before N8N_DISABLED_MODULES=mcp-registry it asked for
  // api.n8n.io at boot (measured), and a bump that adds a caller fails here.
  const unexpectedNames = external.filter((n) => !TEMPLATE_HOSTS.includes(n));
  const fmt = (m: Map<string, number>, keep: (k: string) => boolean) => [...m].filter(([k]) => keep(k)).map(([k, v]) => `${k} ×${v}`).join(", ") || "none";
  return {
    id: "E",
    pass: toBrain > 0 && unexpectedNames.length === 0 && dials.size === 0 && unreadable.length === 0,
    detail: `${toBrain ? "" : "NO SYN to the brain's :8000 — the watcher saw nothing; "}`
      + `${unexpectedNames.length ? `NOT A TEMPLATE'S HOST: ${unexpectedNames.join(", ")}; ` : ""}`
      + `${dials.size ? `DIALLED OUTSIDE THE COMPOSE NETWORK: ${fmt(dials, () => true)}; ` : ""}`
      + `${unreadable.length ? `UNREADABLE PACKET LINES (${unreadable.length}): ${unreadable[0]}; ` : ""}`
      + `names asked outside the compose network: ${fmt(names, (n) => external.includes(n))} (the templates name ${TEMPLATE_HOSTS.join(", ")}); names inside: ${fmt(names, (n) => !external.includes(n))}; `
      + `connection attempts to the brain (${facts.brain.join(", ")}:8000): ${toBrain}; DNS only to ${facts.resolvers.join(", ")}`,
  };
}

/** The facts E is judged against, read live: n8n's resolv.conf, and the brain's addresses from the engine. */
function egressFacts(): EgressFacts {
  const conf = compose("n8n", ["exec", "-T", "n8n", "cat", "/etc/resolv.conf"]).out;
  const resolvers = [...conf.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
  const searchDomains = conf.match(/^search\s+(.+)$/m)?.[1].trim().split(/\s+/) ?? [];
  const id = compose("n8n", ["ps", "-q", "server"]).out.trim();
  const brain = id ? run(["docker", "inspect", id, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"]).out.trim().split(/\s+/).filter(Boolean) : [];
  return { resolvers, searchDomains, brain };
}

const egressRecord = (): Check => judgeEgress(compose("n8n", ["logs", "--no-log-prefix", "egress-watch"]).out, egressFacts());

export const n8n: Adapter = {
  tool: "n8n",
  services: ["n8n"],
  image: IMAGE,
  profile: "orchestration",
  variants: {
    postgres: {
      file: "compose.n8n-postgres.yaml", services: ["n8n-db"], excludes: ["sealed"],
      why: "sealed, n8n is on the sealed network alone and n8n-db is not on it; the probe measures the shipped store, SQLite",
    },
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
