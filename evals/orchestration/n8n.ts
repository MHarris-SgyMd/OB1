/**
 * n8n.ts — the n8n candidate's adapter. Since SMD-2210 this is the SHIPPED
 * profile: deploy/compose.yaml's `orchestration` service, run as it ships,
 * provisioned by the profile's own step (deploy/orchestration/provision.ts),
 * imported here so the kit tests the same code. SMD-1863's POC ran n8n on
 * the brain's database server, and had its own copy of that step.
 *
 * Provisioning loads the profile's credentials (the brain's capture key,
 * separate inbound keys for the MCP endpoint and for on-demand runs, the
 * runner's key, and the act tool's Linear key, which here is the kit's one
 * Linear key), then the kit's two extra credentials (Linear, and a read key
 * for the eval's brain tool). Then come the profile's own templates,
 * instanced for the kit's runner pipelines, then the kit's workflows. On-demand runs go through a
 * workflow's own Webhook trigger, which takes the run key, never the MCP one.
 * What a run did is read back from `GET /executions`.
 *
 * On top of C1–C3, extraChecks covers what the profile adds:
 *   K  the two inbound keys are not interchangeable. After a rotation
 *      (provision --rotate) the replaced API key answers 401, the new one
 *      works and carries an expiry, and this env file holds exactly one key.
 *   P  a saved run older than the window is gone, from the API and from the
 *      store. One just inside the window is still there.
 *   E  under `--with sealed`: the packets n8n sent, judged fail-closed, from the watcher's
 *      capture.
 * and what its first templates add (SMD-2212), loaded as they ship:
 *   A  the act endpoint lists exactly its tools, refuses a missing and a
 *      wrong key, and its tool runs its flow to Linear's own answer.
 *   I  the import template, through the runner, over the kit's fixture
 *      pipeline: five rows once, under the runner's actor, each with a
 *      vector; nothing on a rerun; a batch with a stray source refused whole.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api, ensureApiKey, keyExpiry, PROFILE_CREDENTIALS, PROFILE_TEMPLATES, provision, provisionedKeys, templatesIn, type Options } from "../../deploy/orchestration/provision.ts";
import { loadPipelines, RUNNER_ACTOR } from "../../deploy/orchestration/runner.ts";
import { callTool, listTools, refuses } from "./mcp-client.ts";
import { brainSql, compose, ENV_FILE, HERE, N8N_KIT_PORT, run } from "./stack.ts";
import type { Adapter, Check, Ctx } from "./adapter.ts";

const DIR = join(HERE, "n8n");
/** The kit's runner allowlist, which compose.n8n.yaml mounts over the shipped (empty) one. */
const KIT_PIPELINES = join(HERE, "runner", "pipelines.json");
const BASE = `http://127.0.0.1:${N8N_KIT_PORT}`;
const INGEST = { name: "OB1 — Linear issues into the brain", path: "ob1-ingest" };
const PROBE = { name: "OB1 — egress probe captures", path: "ob1-probe" };
const SEALED = "sealed";
/** The outside hosts the kit's workflows name: the Linear fetch and the act tool. E allows these and no other. */
const TEMPLATE_HOSTS = ["api.linear.app"];
/** The profile's image, read from deploy/compose.yaml: the one place it is pinned. */
const IMAGE: string = (Bun.YAML.parse(readFileSync(join(HERE, "..", "..", "deploy", "compose.yaml"), "utf8")) as any).services.n8n.image;

const options = (env: Record<string, string>, rotate = false): Options => {
  // The act tool's Linear key is the kit's one Linear key. Set on the env
  // itself, not a copy: provisioning writes a minted API key back into it.
  env.N8N_LINEAR_API_KEY ||= env.LINEAR_API_KEY ?? "";
  return {
    base: BASE, env, envFile: ENV_FILE, rotate,
    // The kit reads run history (C1, C1s, P); an operator's key does not carry these.
    extraScopes: ["execution:list", "execution:read"],
    credentials: [PROFILE_CREDENTIALS, join(DIR, "credentials.template.json")],
    // The profile's own templates as they ship (SMD-2212), instanced for the
    // kit's pipelines, then the POC's workflows the C checks run.
    workflows: [...templatesIn(PROFILE_TEMPLATES), ...["linear-ingest.json", "brain-tools.json", "probe-capture.json"].map((f) => join(DIR, f))],
    pipelines: loadPipelines(KIT_PIPELINES),
  };
};
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
  const held = await provisionedKeys(BASE, env, ENV_FILE);
  return {
    id: "K",
    pass: separate && rotated.key.minted && rotated.key.key !== before && oldStatus === 401 && newStatus === 200 && expiryOk && held.length === 1,
    detail: `run webhook with the MCP key → ${runWithMcpKey.status}; MCP endpoint with the run key → ${mcpWithRunKey.refused ? "refused" : "NOT REFUSED"} (${mcpWithRunKey.detail}); `
      + `--rotate: ${rotated.key.revoked} revoked, the replaced key → ${oldStatus}, the new one → ${newStatus}, expires ${exp ? new Date(exp * 1000).toISOString().slice(0, 10) : "NEVER"} (${days} days asked); this env file holds ${held.length} key(s)`,
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

/** The profile's act tools as the template ships them (SMD-2212): the MCP endpoint must list exactly these. */
const ACT = { path: "ob1-act", tools: ["linear_file_issue"] };
/** The kit's import pipelines (runner/pipelines.json): the fixture's five rows, a batch the runner must refuse, and an emitter that tries to read the runner's secrets. */
const IMPORT = { pipeline: "fixture", stray: "stray", snoop: "snoop", system: "orch-fixture", rows: 5, actor: RUNNER_ACTOR };

/**
 * A: the act endpoint lists exactly the template's tools and refuses a
 * missing key and a wrong one. The tool runs its multi-step flow: asked for
 * a team that does not exist, it answers Linear's own "no team" and files
 * nothing. Sealed, Linear is unreachable and the call must fail on that.
 */
async function actChecks(env: Record<string, string>, ctx: Ctx): Promise<Check> {
  const url = `${BASE}/mcp/${ACT.path}`;
  const key = { "x-n8n-key": env.N8N_MCP_KEY };
  const [none, wrong] = [await refuses(url, {}), await refuses(url, { "x-n8n-key": env.N8N_MCP_KEY.slice(0, -1) + (env.N8N_MCP_KEY.endsWith("a") ? "b" : "a") })];
  const tools = (await listTools(url, key).catch(() => [])).map((t) => t.name).sort();
  const exact = JSON.stringify(tools) === JSON.stringify([...ACT.tools].sort());
  const call = await callTool(url, key, "linear_file_issue", { team: "ZZQNOPE", title: "orchestration kit probe — never created", description: "", label: "" }, 120_000).catch((e) => ({ isError: true, text: String(e) }));
  const noTeam = /no Linear team with key ZZQNOPE/.test(call.text);
  const flowOk = sealed(ctx) ? call.isError && !noTeam : call.isError && noTeam;
  return {
    id: "A",
    pass: none.refused && wrong.refused && exact && flowOk,
    detail: `/mcp/${ACT.path}: no key → ${none.detail}; wrong key → ${wrong.detail}; tools ${JSON.stringify(tools)} (the template ships ${JSON.stringify(ACT.tools)}); `
      + `linear_file_issue for an absent team → ${call.text.slice(0, 160)}${sealed(ctx) ? " (sealed: Linear must be unreachable)" : ""}`,
  };
}

/** One on-demand run of an import instance: the door's answer, which is the runner's report, or the reason the run failed. */
async function importRun(env: Record<string, string>, pipeline: string): Promise<{ status: number; report: any }> {
  const r = await fetch(`${BASE}/webhook/ob1-import-${pipeline}`, { method: "POST", headers: { "x-n8n-run-key": env.N8N_WEBHOOK_KEY, "content-type": "application/json" }, body: "{}" });
  const text = await r.text();
  let report: any;
  try { report = JSON.parse(text); } catch { report = { ok: false, why: text.slice(0, 300) }; }
  return { status: r.status, report };
}

/**
 * Whether a value appears anywhere in the saved runs of the given workflows,
 * the data included. Returns how many runs were read and how many held it.
 * The value is never printed.
 */
async function inRunData(env: Record<string, string>, names: string[], value: string): Promise<{ runs: number; holding: number }> {
  const key = await apiKey(env);
  let runs = 0, holding = 0;
  for (const name of names) {
    const id = await workflowId(key, name);
    if (!id) continue;
    const page = await api(BASE, key, "GET", `/executions?workflowId=${id}&includeData=true&limit=50`);
    for (const e of page.data as any[]) { runs++; if (JSON.stringify(e).includes(value)) holding++; }
  }
  return { runs, holding };
}

/**
 * I: the import template, through the runner. The fixture's rows are deleted
 * through the brain's own delete path first, so the first run proves itself.
 * Then:
 * - the first run inserts the five, under the runner's actor, each with a
 *   vector, and the door answers the report;
 * - a rerun writes nothing;
 * - `stray`, whose third line claims another source, is refused whole with
 *   nothing written, and the door answers the runner's reason;
 * - `snoop`'s emitter cannot read any process's environment: it runs as its
 *   pipeline's own uid (review pass 1). The child it leaves behind is gone
 *   once the run answers (review pass 2);
 * - the instance's schedule is n8n days for 24 hours (review pass 2: an
 *   hourly 24 fires once, then never);
 * - neither the run key nor the runner's key is anywhere in n8n's saved runs
 *   of the import workflows (review pass 1: the webhook saved its headers).
 */
async function importChecks(env: Record<string, string>, ctx: Ctx): Promise<Check> {
  const rows = () => brainSql("n8n", `SELECT count(*), count(*) FILTER (WHERE metadata->>'actor_name' = '${IMPORT.actor}'), count(*) FILTER (WHERE embedding IS NOT NULL) FROM thoughts WHERE metadata->>'source' = '${IMPORT.system}'`).split("|").map(Number);
  const reset = brainSql("n8n", `SELECT count(*) FILTER (WHERE (r->>'ok')::boolean) FROM (SELECT delete_thought(id) AS r FROM thoughts WHERE metadata->>'source' = '${IMPORT.system}') d`);
  const first = await importRun(env, IMPORT.pipeline);
  const [n1, byRunner, embedded] = rows();
  const second = await importRun(env, IMPORT.pipeline);
  const [n2] = rows();
  const stray = await importRun(env, IMPORT.stray);
  const [n3] = rows();
  const snoop = await importRun(env, IMPORT.snoop);
  // The listing must be read: a failed exec read as "no leftovers" (review pass 3).
  const ps = compose("n8n", ["exec", "-T", "orchestration-runner", "ps", "-o", "args"]);
  const leftovers = ps.code === 0 && /runner\.ts/.test(ps.out) ? ps.out.split("\n").filter((l) => /sleep 900/.test(l)).length : NaN;
  // The runner down: the door answers 502, and the import's saved run holds
  // neither its key nor the header (review pass 3). Not under sealed: a
  // restart can give the runner a new address inside E's window, and E would
  // count the old one as a dial outside (review pass 4). The plain run holds it.
  let down: { status: number; report: any } | null = null;
  if (!sealed(ctx)) {
    compose("n8n", ["stop", "orchestration-runner"]);
    down = await importRun(env, IMPORT.pipeline).finally(() => compose("n8n", ["start", "orchestration-runner"]));
    const runnerUp = async () => (await importRun(env, IMPORT.snoop)).status === 200;
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000 && !(await runnerUp().catch(() => false))) await Bun.sleep(2000);
  }
  const key = await apiKey(env);
  const fixtureId = await workflowId(key, `OB1 import — ${IMPORT.pipeline}`);
  const fixtureFlow = fixtureId ? await api(BASE, key, "GET", `/workflows/${fixtureId}`) : null;
  const schedule = fixtureFlow?.nodes?.find((n: any) => n.name === "Schedule")?.parameters?.rule?.interval?.[0];
  const daily = schedule?.field === "days" && schedule?.daysInterval === 1;
  const leaked = Number(brainSql("n8n", `SELECT count(*) FROM thoughts WHERE metadata->>'source' = 'gmail' AND metadata->>'actor_name' = '${IMPORT.actor}'`));
  // Read after the runner-down run, so its saved error is among them.
  const flows = [IMPORT.pipeline, IMPORT.stray, IMPORT.snoop].flatMap((p) => [`OB1 import — ${p}`, `OB1 import — ${p} (on demand)`]);
  const [runKey, runnerKey] = [await inRunData(env, flows, env.N8N_WEBHOOK_KEY), await inRunData(env, flows, env.OB1_RUNNER_KEY)];
  const c1 = first.report?.counts, c2 = second.report?.counts;
  const pass = first.status === 200 && c1?.inserted === IMPORT.rows && n1 === IMPORT.rows && byRunner === IMPORT.rows && embedded === IMPORT.rows
    && second.status === 200 && c2?.inserted === 0 && c2?.updated === 0 && c2?.patched === 0 && c2?.unchanged === IMPORT.rows && n2 === IMPORT.rows
    && stray.status === 422 && /the runner answered 422: one-source/.test(stray.report?.why ?? "") && /identity\.system "gmail"/.test(stray.report?.why ?? "") && n3 === IMPORT.rows && leaked === 0
    && snoop.status === 200 && snoop.report?.emitted === 0 && leftovers === 0 && daily
    && (down === null || (down.status === 502 && /did not answer/.test(down.report?.why ?? "")))
    && runKey.runs > 0 && runKey.holding === 0 && runnerKey.holding === 0;
  const fmt = (r: { status: number; report: any }) => `${r.status}${r.report?.counts ? ` inserted ${r.report.counts.inserted} unchanged ${r.report.counts.unchanged}` : ""}${r.report?.ok === false ? ` ${r.report.why}` : ""}`;
  return {
    id: "I",
    pass,
    detail: `${reset} earlier fixture row(s) deleted; first run → ${fmt(first)}: ${n1} rows, ${byRunner} by ${IMPORT.actor}, ${embedded} with a vector; `
      + `rerun → ${fmt(second)}, ${n2} rows; stray → ${fmt(stray)}, ${n3} rows, ${leaked} of another source; `
      + `snoop → ${snoop.status}, ${snoop.report?.emitted === 0 ? "no environment readable" : `READABLE: ${JSON.stringify(snoop.report).slice(0, 200)}`}, ${leftovers} of its leftover children still running; `
      + `the fixture's schedule ${JSON.stringify(schedule)}; runner down → ${down ? `${down.status} ${String(down.report?.why ?? "").slice(0, 80)}` : "not run (sealed)"}; `
      + `the run key in ${runKey.holding} of ${runKey.runs} saved import runs, the runner's key in ${runnerKey.holding}`,
  };
}

/** The compose services whose names are n8n's own network's, bare or with one of its search domains. */
const SERVICES = ["server", "n8n", "n8n-front", "egress-watch", "postgres", "orchestration-runner"];

/** What the judge is told rather than infers: read from n8n's /etc/resolv.conf and the engine. `problem` is set when a read failed. */
export type EgressFacts = { resolvers: string[]; searchDomains: string[]; brain: string[]; runner?: string[]; problem?: string };

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
 * addresses). Every OUTBOUND packet line on n8n's interfaces (tcpdump's `Out`;
 * loopback stays in the container) must be one of three things:
 * - a DNS question to a listed resolver whose name is read, over UDP or TCP.
 *   A packet to the resolver's :53 carrying data but no readable question is
 *   unreadable (review pass 3: a CD-flag, notify, CHAOS-class, unknown-type
 *   or TCP query hid its name, and the resolver forwarded it);
 * - an empty TCP segment on such a connection (the SYN, an ACK, the FIN);
 * - a connection attempt to the brain's :8000.
 * Anything else is a dial outside, including a packet line the judge cannot
 * read. A resolver on loopback is Docker's embedded DNS: the questions there
 * are rewritten to another port before the capture sees them, so E cannot
 * judge names, and says so rather than pass.
 *
 * A name is inside when it is a service's, bare or with a search domain.
 * Expansions with the host's own search domains (`server.<isp domain>`) are
 * reported apart: fixed names, carrying nothing. Anything else fails unless a
 * kit template names its host. The brain must have been seen, or the capture
 * proves nothing.
 * Exported for the self-check: pure over the log and the facts.
 */
export function judgeEgress(log: string, facts: EgressFacts): Check {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The network's own domain is the first search domain (podman's dns.podman); the rest are the host's.
  const [own, ...hostDomains] = facts.searchDomains;
  const bare = new RegExp(`^(${SERVICES.map(esc).join("|")})(${own ? `\\.${esc(own)}` : "(?!)"})?\\.?$`);
  const expanded = new RegExp(`^(${SERVICES.map(esc).join("|")})\\.(${hostDomains.map(esc).join("|") || "(?!)"})\\.?$`);
  const names = new Map<string, number>();
  const dials = new Map<string, number>();
  const unreadable: string[] = [];
  let toBrain = 0, toRunner = 0;
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const hostPort = (a: string) => { const i = a.lastIndexOf("."); return { host: a.slice(0, i), port: a.slice(i + 1) }; };
  const loopbackResolver = facts.resolvers.find((r) => /^(127\.|::1$)/.test(r));
  for (const line of log.split("\n")) {
    // tcpdump's own messages carry no timestamp; every packet line does (-tttt).
    if (!/^\d{4}-\d\d-\d\d /.test(line)) continue;
    const p = /^\S+ \S+ (\S+)\s+(\S+)\s+IP6? (\S+) > (\S+): (.*)$/.exec(line);
    if (!p) { unreadable.push(line.slice(0, 120)); continue; }
    const [, iface, dir, , dstRaw, rest] = p;
    if (iface === "lo" || dir !== "Out") continue;
    const dst = hostPort(dstRaw);
    const tcp = /^Flags \[/.test(rest);
    const syn = /^Flags \[S\]/.test(rest);
    // A question in any of tcpdump's shapes: `4242+ A? x. (29)`, `4242+% A?`,
    // `4242 notify+ A?`, `4242+ TXT CHAOS? x.`, `Type65400? x.`, `[1au]`, and
    // inside a TCP segment's decode.
    const q = /\S+\? (\S+?)\.? \(\d+\)/.exec(rest);
    if (dst.port === "53" && facts.resolvers.includes(dst.host)) {
      if (q) { count(names, q[1].toLowerCase()); continue; }
      if (tcp && / length 0$/.test(rest)) continue;
      unreadable.push(line.slice(0, 120));
      continue;
    }
    if (syn && dst.port === "8000" && facts.brain.includes(dst.host)) { toBrain++; continue; }
    // The import runner (SMD-2212) is the profile's own service on the same network: an import template dials it and nothing else.
    if (syn && dst.port === "8090" && (facts.runner ?? []).includes(dst.host)) { toRunner++; continue; }
    count(dials, `${dst.host}:${dst.port} (${tcp ? "tcp" : q ? "dns" : rest.split(/[ ,]/)[0] || "udp"})`);
  }
  const outside = [...names.keys()].filter((n) => !bare.test(n) && !expanded.test(n));
  const expansions = [...names.keys()].filter((n) => !bare.test(n) && expanded.test(n));
  // What the kit's own templates name, and nothing else: n8n itself must
  // dial no one. Before N8N_DISABLED_MODULES=mcp-registry it asked for
  // api.n8n.io at boot (measured), and a bump that adds a caller fails here.
  const unexpectedNames = outside.filter((n) => !TEMPLATE_HOSTS.includes(n));
  const fmt = (m: Map<string, number>, keep: (k: string) => boolean) => [...m].filter(([k]) => keep(k)).map(([k, v]) => `${k} ×${v}`).join(", ") || "none";
  // The capture itself must have run once, for the whole window: one
  // `listening on` header (two means tcpdump restarted, none that it never
  // opened) and no exit summary (tcpdump prints it only when it stops).
  const opened = log.split("\n").filter((l) => /^listening on /.test(l)).length;
  const ended = /^\d+ packets (captured|received by filter|dropped by kernel)/m.test(log);
  const capture = opened !== 1 ? `the watcher's capture opened ${opened} times: it restarted, or never opened` : ended ? "the watcher's capture ended before it was read" : undefined;
  const blocked = facts.problem ?? capture ?? (loopbackResolver ? `the resolver is on loopback (${loopbackResolver}, Docker's embedded DNS): its questions are rewritten to another port before the capture, so names cannot be judged — E is measured on podman` : undefined);
  return {
    id: "E",
    pass: !blocked && toBrain > 0 && unexpectedNames.length === 0 && dials.size === 0 && unreadable.length === 0,
    detail: `${blocked ? `CANNOT JUDGE: ${blocked}; ` : ""}`
      + `${toBrain ? "" : "NO SYN to the brain's :8000 — the watcher saw nothing; "}`
      + `${unexpectedNames.length ? `NOT A TEMPLATE'S HOST: ${unexpectedNames.join(", ")}; ` : ""}`
      + `${dials.size ? `DIALLED OUTSIDE THE COMPOSE NETWORK: ${fmt(dials, () => true)}; ` : ""}`
      + `${unreadable.length ? `UNREADABLE PACKET LINES (${unreadable.length}): ${unreadable[0]}; ` : ""}`
      + `names asked outside the compose network: ${fmt(names, (n) => outside.includes(n))} (the templates name ${TEMPLATE_HOSTS.join(", ")}); `
      + `the network's own names: ${fmt(names, (n) => bare.test(n))}; `
      + `search-domain expansions: ${fmt(names, (n) => expansions.includes(n))}; `
      + `connection attempts to the brain (${facts.brain.join(", ")}:8000): ${toBrain}; to the import runner (${(facts.runner ?? []).join(", ") || "not running"}:8090): ${toRunner}; DNS only to ${facts.resolvers.join(", ")}`,
  };
}

/** What the engine said, raw: each read's output and exit code. `watcher` is `<running> <startedAt>`, and `n8nStarted` n8n's startedAt. */
export type RawFacts = {
  resolv: { out: string; code: number };
  brain: { out: string; code: number } | null;
  /** The import runner's addresses, when it runs. */
  runner?: { out: string; code: number } | null;
  watcher: { out: string; code: number } | null;
  n8nStarted: string;
};

/**
 * The facts, parsed. Pure, so the self-check holds it on canned output (review
 * pass 4: three mutants of the live reader survived with nothing testing it).
 * The watcher must still be running and have started no later than n8n,
 * because a capture that stopped or began late saw only part of what n8n sent,
 * and E would pass on it. On podman, stopping the watcher also cut n8n off
 * (measured), but an unrecorded engine behaviour is not a check.
 */
/** An engine's timestamp: Docker's RFC 3339, or podman's Go form `2026-09-26 06:12:26.451290425 -0500 CDT`. NaN when neither. */
export function engineTime(s: string): number {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?\s*(Z|[+-]\d\d:?\d\d)?/.exec(s.trim());
  if (!m) return NaN;
  const zone = !m[4] || m[4] === "Z" ? "Z" : m[4].includes(":") ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  return Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}${zone}`);
}

export function factsFrom(raw: RawFacts): EgressFacts {
  const resolvers = [...raw.resolv.out.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
  const searchDomains = raw.resolv.out.match(/^search\s+(.+)$/m)?.[1].trim().split(/\s+/) ?? [];
  // Addresses only: podman prints "invalid IP" for an unset IPv6 address (measured).
  const addresses = (r: { out: string } | null | undefined) => r?.out.trim().split(/\s+/).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) || /^[0-9a-f]*:[0-9a-f:]+$/i.test(a)) ?? [];
  const brain = addresses(raw.brain);
  const runner = raw.runner?.code === 0 ? addresses(raw.runner) : [];
  const [running, ...startedWords] = (raw.watcher?.out.trim() ?? "").split(/\s+/);
  const watcherStarted = startedWords.join(" ");
  const problem = raw.resolv.code !== 0 ? "n8n's resolv.conf could not be read"
    : !raw.brain || raw.brain.code !== 0 ? "the brain's addresses could not be read"
    : !resolvers.length || !brain.length ? `the facts are empty (resolvers: ${resolvers.length}, brain addresses: ${brain.length})`
    : !raw.watcher || raw.watcher.code !== 0 ? "the watcher's state could not be read"
    : running !== "true" ? "the watcher is not running: the capture stopped before it was read"
    : !(engineTime(watcherStarted) <= engineTime(raw.n8nStarted)) ? `the watcher started (${watcherStarted}) after n8n (${raw.n8nStarted}): the capture missed n8n's start`
    : undefined;
  return { resolvers, searchDomains, brain, runner, problem };
}

/** The facts E is judged against, read live: n8n's resolv.conf, the brain's addresses (v4 and v6), and the watcher's and n8n's state, from the engine. */
function egressFacts(): EgressFacts {
  const idOf = (service: string) => compose("n8n", ["ps", "-q", service]).out.trim();
  const inspect = (id: string, format: string) => (id ? run(["docker", "inspect", id, "--format", format]) : null);
  const [server, watcher, n8nId, runnerId] = [idOf("server"), idOf("egress-watch"), idOf("n8n"), idOf("orchestration-runner")];
  return factsFrom({
    resolv: compose("n8n", ["exec", "-T", "n8n", "cat", "/etc/resolv.conf"]),
    brain: inspect(server, "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}"),
    runner: inspect(runnerId, "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}"),
    watcher: inspect(watcher, "{{.State.Running}} {{.State.StartedAt}}"),
    n8nStarted: inspect(n8nId, "{{.State.StartedAt}}")?.out.trim() ?? "",
  });
}

const egressRecord = (): Check => judgeEgress(compose("n8n", ["logs", "--no-log-prefix", "egress-watch"]).out, egressFacts());

export const n8n: Adapter = {
  tool: "n8n",
  services: ["n8n", "orchestration-runner"],
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
    const checks = [await keyChecks(env, ctx), await pruningCheck(env, ctx), await actChecks(env, ctx), await importChecks(env, ctx)];
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
