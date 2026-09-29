#!/usr/bin/env bun
/**
 * runner.ts — the `orchestration` profile's import runner (SMD-2212;
 * docs/orchestration-tool.md, "Running a pipeline from a workflow").
 *
 *   bun deploy/orchestration/runner.ts                # the service (compose: orchestration-runner)
 *   bun deploy/orchestration/runner.ts --self-check   # the rules, against stand-in commands (CI)
 *
 * n8n's image has neither Bun nor python3, and n8n excludes its Execute Command
 * node by default. So an import template calls this service with an HTTP
 * Request node instead. The service runs one pipeline from a fixed allowlist
 * (pipelines.json), reached only on the compose network and behind a key of
 * its own:
 *
 *   POST /run/<pipeline>   x-runner-key: <OB1_RUNNER_KEY>
 *     1. the pipeline's emitter, over /imports/<pipeline>/ (read-only), as a
 *        user of its own, with no secret in its environment;
 *     2. every line it printed must be the pipeline's one source (its system)
 *        and scope, or the batch is refused whole and nothing is written;
 *     3. `bun db/ingest-records.ts --source items --items - --allow <scope>
 *        --actor orchestration-runner` on those lines;
 *     4. `bun db/reembed.ts`, then the pipeline's rows are counted: the run
 *        succeeds when every one of them has a vector.
 *   The answer is the run's report: the counts and the items the ingester
 *   named (skipped, stale, held), as JSON. A refusal or a failure is a non-2xx
 *   answer, so n8n marks the run failed. One deadline bounds the whole run.
 *   GET /health            no key; whether it is up, and how many pipelines it holds.
 *
 * The request names a pipeline and nothing else. The export is read from the
 * imports directory, never sent through n8n, so n8n's run data holds the
 * report and not the export.
 *
 * The bound on its key (decision 4 as amended): only the allowlisted
 * pipelines, one source each, and every row under its own actor. The key is
 * not a brain key. Provisioning refuses it in any other credential
 * (deploy/orchestration/provision.ts, sharedSecrets).
 *
 * In the image the service runs as root, with every capability dropped but
 * the three that change user and signal a step (compose), and it runs nothing
 * as root: each pipeline's emitter as a uid of its own, the ingester and
 * reembed as `bun` (su-exec). An emitter parses an outside export, and a
 * parser an export exploits then holds no secret: it cannot read the runner's
 * environment, the ingester's or another emitter's (/proc/<pid>/environ is its
 * owner's), and it gets no database URL or key in its own.
 *
 * Nor any network (SMD-2289). The image's command sets rules that refuse
 * every packet from an emitter uid (`--egress`, egressRules), then drops the
 * capability to change them before the runner starts. A live-API pipeline
 * names its hosts (`network` in pipelines.json), and its emitter reaches them
 * only through the runner's proxy for that pipeline (startProxy), found in
 * HTTPS_PROXY: TLS to a named host, held to it by the ClientHello's server
 * name, and nothing else.
 */
import { SQL } from "bun";
import { timingSafeEqual, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { BlockList, connect as tcpConnect, createServer, isIP } from "node:net";
import { tmpdir } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_RE } from "../../db/ingest-contract.ts";
import { RESERVED_SYSTEMS, scopeProblem } from "../../db/ingest-items.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
/** The allowlist. Compose mounts the checkout's copy read-only, so provisioning and the runner read the same file. Empty until an import recipe is converted (SMD-2147–2150, SMD-2021). */
export const PIPELINES_FILE = join(HERE, "pipelines.json");
/** The actor every row the runner writes carries (ingest-records.ts --actor). */
export const RUNNER_ACTOR = "orchestration-runner";
/** The user the image runs the ingester and reembed as (runner.Dockerfile). */
const PIPELINE_USER = "bun";

/**
 * Each pipeline's emitter runs as a uid of its own (review pass 2: with one
 * shared uid, an emitter an export had taken over could stay behind and write
 * lines, in the other's source, into another pipeline's batch through
 * /proc/<pid>/fd, or ptrace it). su-exec takes a numeric uid:gid with no
 * passwd entry, and then sets HOME to `/`, which no emitter can write (review
 * pass 3: a shared, writable HOME such as /tmp let one emitter plant Python
 * user site code that ran as another's). Derived from the name, so it survives
 * edits to the allowlist; the runner refuses two that collide.
 */
export function emitterUid(name: string): number {
  return EMITTER_UIDS[0] + (parseInt(createHash("sha256").update(name).digest("hex").slice(0, 8), 16) % (EMITTER_UIDS[1] - EMITTER_UIDS[0] + 1));
}
/** Every uid an emitter can have, first and last: the range the egress rules close (SMD-2289). */
export const EMITTER_UIDS = [20000, 59999] as const;
const DEFAULT_PORT = 8090;
export const DEFAULT_TIMEOUT_S = 3600;
/** After a step's first SIGTERM, how long before SIGKILL. */
const KILL_GRACE_MS = 6000;
/** reembed stops after the thought in hand on a first SIGTERM, which can be a 120 s provider call, and hands its leased rows back on a second; SIGKILL left them leased for its 900 s lease (review pass 3). So a step gets a second SIGTERM this long after the first. */
const SECOND_TERM_MS = 1000;
/** After a step exits, how long its pipes may stay open (a child it left holding them) before they are abandoned. */
const DRAIN_MS = 2000;

/** The steps running now, so that a runner being stopped can stop them the way a deadline does (review pass 4). */
const live = new Set<{ stop: () => void; exited: Promise<number> }>();

/**
 * Stop every live step as a deadline would: SIGTERM, a second SIGTERM, then
 * SIGKILL, and wait for them, bounded. A runner recreated mid-reembed (a
 * rebuild, a key rotation) killed its reembed outright, and the rows it had
 * claimed stayed leased for 900 s (review pass 4).
 */
async function stopLive(waitMs = 5000): Promise<void> {
  for (const x of live) x.stop();
  await Promise.race([Promise.all([...live].map((x) => x.exited)), Bun.sleep(waitMs)]);
}

export type Pipeline = {
  /** The URL segment, the imports subdirectory, and the n8n workflow's suffix. */
  name: string;
  /** The one source its items may carry (identity.system). */
  system: string;
  /** The one scope its items may carry, and the only one the ingester is told to allow. */
  scope: string;
  /** argv, run from the repository root; `{input}` becomes /imports/<name>. */
  emitter: string[];
  /** The import template's schedule for this pipeline, in hours. */
  everyHours: number;
  /** The hosts its emitter may reach, through the runner's proxy; empty, the emitter has no network at all (SMD-2289). */
  network: Host[];
};

/** A host a live-API emitter names: reached through the runner's proxy by CONNECT, on this port only. */
export type Host = { host: string; port: number };

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** What the image has to run an emitter with. */
const INTERPRETERS = ["python3", "bun"];

/** Parse and check the allowlist. Throws, naming the entry and the field, on anything it would not run. */
function parsePipelines(text: string, file = "pipelines.json"): Pipeline[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${file}: not JSON (${(e as Error).message})`); }
  if (!Array.isArray(raw)) throw new Error(`${file}: must be a JSON array of pipelines`);
  const seen = new Set<string>();
  const systems = new Map<string, string>();
  return raw.map((p: any, i) => {
    const at = `${file}[${i}]${typeof p?.name === "string" ? ` (${p.name})` : ""}`;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${at}: must be an object`);
    const extra = Object.keys(p).filter((k) => !["name", "system", "scope", "emitter", "everyHours", "network"].includes(k));
    if (extra.length) throw new Error(`${at}: unknown field ${extra[0]}`);
    if (typeof p.name !== "string" || !NAME_RE.test(p.name)) throw new Error(`${at}: name must match ${NAME_RE.source}`);
    if (seen.has(p.name)) throw new Error(`${at}: name ${p.name} is listed twice`);
    seen.add(p.name);
    // One pipeline, one source: its success counts that source's rows, and a
    // second pipeline on the same system could write over its rows (review pass 3).
    if (systems.has(p.system)) throw new Error(`${at}: system ${p.system} is already pipeline ${systems.get(p.system)}'s; each pipeline owns one source`);
    systems.set(p.system, p.name);
    if (typeof p.system !== "string" || !SYSTEM_RE.test(p.system)) throw new Error(`${at}: system must match ${SYSTEM_RE.source}`);
    if ((RESERVED_SYSTEMS as readonly string[]).includes(p.system)) throw new Error(`${at}: system ${p.system} is one the pipeline reads itself, not an emitter's`);
    // The item rule itself: a scope every item would fail is refused here, not on every run.
    const scopeWhy = scopeProblem(p.scope);
    if (scopeWhy) throw new Error(`${at}: scope ${JSON.stringify(p.scope)}: ${scopeWhy}`);
    if (!Array.isArray(p.emitter) || !p.emitter.length || !p.emitter.every((a: unknown) => typeof a === "string" && a.length)) throw new Error(`${at}: emitter must be a non-empty argv of strings`);
    if (!INTERPRETERS.includes(p.emitter[0])) throw new Error(`${at}: emitter must start with ${INTERPRETERS.join(" or ")}, the interpreters the image has`);
    if (!Number.isInteger(p.everyHours) || p.everyHours < 1 || (p.everyHours > 23 && (p.everyHours % 24 !== 0 || p.everyHours > 168))) throw new Error(`${at}: everyHours must be 1 to 23, or whole days in hours (24, 48, … 168): n8n counts an hourly schedule within one day, and ran a 24-hour one once, then never`);
    return { name: p.name, system: p.system, scope: p.scope, emitter: p.emitter, everyHours: p.everyHours, network: parseNetwork(p.network, at) };
  });
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^(${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`);

/**
 * A pipeline's `network`: absent or false, none at all; otherwise the hosts
 * its emitter needs, each "host" (port 443) or "host:port". `true` is refused,
 * so a pipeline cannot ask for the whole network. So is a loopback or
 * link-local name, the runner's own and a cloud metadata endpoint's.
 */
function parseNetwork(v: unknown, at: string): Host[] {
  if (v === undefined || v === false) return [];
  if (v === true) throw new Error(`${at}: network must name the hosts its emitter needs ("network": ["api.example.com"]), not true: an emitter reaches nothing else`);
  if (!Array.isArray(v) || !v.length) throw new Error(`${at}: network must be false or a non-empty list of hosts, each "host" or "host:port"`);
  const seen = new Set<string>();
  return v.map((h) => {
    const m = typeof h === "string" ? HOST_RE.exec(h.toLowerCase()) : null;
    const port = m ? Number(m[2] ?? 443) : NaN;
    if (!m || m[1].length > 253 || !(port >= 1 && port <= 65535)) throw new Error(`${at}: network entry ${JSON.stringify(h)} must be "host" or "host:port" (a DNS name or IPv4 address, a port 1 to 65535)`);
    // A numeric last label is an address, and only its dotted-quad spelling is read here: `127.1`, `2130706433` and `0x7f.1` are loopback too, which the proxy would refuse on every run (review pass 1).
    const last = m[1].split(".").at(-1)!;
    if ((/^\d+$/.test(last) || /^0x[0-9a-f]+$/.test(last)) && isIP(m[1]) !== 4) throw new Error(`${at}: network entry ${JSON.stringify(h)} is neither a DNS name nor an IPv4 address in dotted-quad form`);
    if (m[1] === "localhost" || m[1].endsWith(".localhost") || isLocalAddress(m[1])) throw new Error(`${at}: network entry ${JSON.stringify(h)} is a loopback or link-local address, which no emitter may reach`);
    const key = `${m[1]}:${port}`;
    if (seen.has(key)) throw new Error(`${at}: network names ${key} twice`);
    seen.add(key);
    return { host: m[1], port };
  });
}

/**
 * The addresses no emitter may reach, even under a name it names: loopback,
 * unspecified, link-local (169.254.169.254 among them), IPv4-compatible
 * IPv6, and the cloud metadata endpoints outside those (AWS's IPv6 one,
 * Alibaba's). An IPv4-mapped IPv6 address is read as its IPv4 address, in
 * either spelling. A private address is not among them: a compose service is
 * one (review pass 1 widened this from a pattern over the dotted spellings).
 */
const LOCAL = (() => {
  const b = new BlockList();
  for (const [a, bits] of [["127.0.0.0", 8], ["0.0.0.0", 8], ["169.254.0.0", 16], ["100.100.100.200", 32]] as const) b.addSubnet(a, bits, "ipv4");
  for (const [a, bits] of [["::", 96], ["fe80::", 10], ["fd00:ec2::254", 128]] as const) b.addSubnet(a, bits, "ipv6");
  return b;
})();
/** Whether an address is one LOCAL holds; a name, or anything that is not an address, is not. */
export function isLocalAddress(a: string): boolean {
  const kind = isIP(a);
  return kind !== 0 && LOCAL.check(a, kind === 6 ? "ipv6" : "ipv4");
}

export const loadPipelines = (file = PIPELINES_FILE) => parsePipelines(readFileSync(file, "utf8"), file);

/**
 * The import template's schedule for a pipeline, as n8n's Schedule Trigger
 * reads it: hours up to 23, whole days beyond. n8n 2.40.6 tests an hourly
 * interval as `(hour - last + 24) % 24 >= interval`, which a 24-hour or longer
 * interval never meets after its first run (review pass 2, read from the
 * image); its day interval counts days of the year.
 */
export function scheduleOf(everyHours: number): { field: "hours"; hoursInterval: number } | { field: "days"; daysInterval: number } {
  return everyHours < 24 ? { field: "hours", hoursInterval: everyHours } : { field: "days", daysInterval: everyHours / 24 };
}

/**
 * The emitter scripts an allowlist names that the image does not hold: a
 * line added to pipelines.json before the image was rebuilt with its emitter.
 * A script is an argument that is a relative path to a script file (.py,
 * .ts, .js, .mjs, .cjs), wherever it stands: after a flag, after `bun run`,
 * or bare. A flag's value (`-X utf8`, `-W ignore`, `--smol`) is never taken
 * for one (review pass 3: pass 2 read the first non-flag argument, and refused
 * a valid allowlist naming `utf8` as missing). An absolute path under the
 * image's /app is checked against the repository, and a module given as
 * `-m a.b.c` as a/b/c.py or a/b/c/__main__.py (review pass 6: both passed the
 * build, then failed every run).
 */
export function missingEmitters(pipelines: Pipeline[], root: string): string[] {
  return pipelines.flatMap((p) => {
    const args = p.emitter.slice(1);
    // A module given by `-m x`, by a short-flag cluster ending in m (`-um x`), or inline (`-mx`); the argument after it is not a script (review pass 7).
    const at = args.findIndex((a) => /^-[a-zA-Z]*m$/.test(a) || /^-m./.test(a));
    const mod = at < 0 ? undefined : /^-m./.test(args[at]) ? args[at].slice(2) : args[at + 1];
    const scripts = args
      .filter((_, i) => !(at >= 0 && i === at + 1 && !/^-m./.test(args[at])))
      .map((a) => (a.startsWith("/app/") ? a.slice(5) : a))
      // A script file (.py .ts .tsx .js .jsx .mjs .cjs), or any relative path with a directory in it (a script with no extension); a URL is neither, and is the natural argument of a networked pipeline's emitter (review pass 5: `https://…` was named a missing script, and the runner refused to start).
      .filter((a) => (/^[^-/][^\s]*\.(py|ts|tsx|js|jsx|mjs|cjs)$/.test(a) || /^[^-/{][^\s]*\/[^\s]+$/.test(a)) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) && !a.includes("{input}") && !existsSync(resolve(root, a)));
    // A module of the repository (its top package a directory here, e.g. recipes.x.emit); the standard library and installed packages are not checked.
    const missingModule = mod && /^[a-z_][\w.]*$/i.test(mod) && (mod.startsWith("recipes.") || existsSync(resolve(root, mod.split(".")[0]))) && ![`${mod.replaceAll(".", "/")}.py`, `${mod.replaceAll(".", "/")}/__main__.py`].some((x) => existsSync(resolve(root, x)));
    return [...scripts, ...(missingModule ? [`-m ${mod}`] : [])].map((a) => `${p.name}: ${a}`);
  });
}

/**
 * The one-source rule, over the emitter's lines before any is written: a line
 * whose identity.system or scope is not the pipeline's is named. A line that
 * is not JSON is left to the ingester, which refuses the whole batch for it.
 */
function strayLines(bytes: Uint8Array, p: Pipeline): string[] {
  const out: string[] = [];
  const lines = new TextDecoder().decode(bytes).split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let item: any;
    try { item = JSON.parse(line); } catch { return; }
    // A quoted value is cut: an emitter an export has taken over could otherwise put megabytes into the report n8n saves (review pass 3).
    const shown = (v: unknown) => { const t = JSON.stringify(v) ?? String(v); return t.length > 120 ? `${t.slice(0, 120)}…` : t; };
    const system = item?.identity?.system;
    if (system !== p.system) out.push(`line ${i + 1}: identity.system ${shown(system)} is not ${p.name}'s source, ${p.system}`);
    else if (item?.scope !== p.scope) out.push(`line ${i + 1}: scope ${shown(item?.scope)} is not ${p.name}'s scope, ${p.scope}`);
  });
  return out;
}

const TALLY_KEYS = ["inserted", "updated", "patched", "unchanged", "skipped", "held", "stale"] as const;
export type Tally = Record<(typeof TALLY_KEYS)[number], number>;
/** The ingester's count line (`tier=stable  inserted 5  updated 0 …`), or null when it printed none. */
function parseTally(stdout: string): Tally | null {
  const line = stdout.split("\n").find((l) => /^\s*tier=\S+\s+inserted \d+/.test(l));
  if (!line) return null;
  return Object.fromEntries(TALLY_KEYS.map((k) => [k, Number(new RegExp(`\\b${k} (\\d+)`).exec(line)?.[1] ?? NaN)])) as Tally;
}

/** Which commands a run spawns, and how it counts the pipeline's rows without a vector. The service's are the pipeline's own; the self-check puts stand-ins here. */
export type Commands = {
  ingest: (p: Pipeline) => string[];
  reembed: () => string[];
  unembedded: (p: Pipeline) => Promise<number>;
};
const PIPELINE_COMMANDS = (env: Record<string, string | undefined>): Commands => ({
  ingest: (p) => ["bun", "db/ingest-records.ts", "--source", "items", "--items", "-", "--allow", p.scope, "--actor", RUNNER_ACTOR],
  reembed: () => ["bun", "db/reembed.ts"],
  // The rows this pipeline's source holds with no vector. The ingester labels
  // each row with the item's system (metadata.source), and one pipeline owns
  // one system, so these are this pipeline's rows, from this run or an earlier one.
  async unembedded(p) {
    const sql = new SQL({ url: env.DATABASE_URL ?? "", max: 1 });
    try {
      // Bounded: the count runs inside the run's reembed turn (review pass 2).
      await sql`SELECT set_config('statement_timeout', '30000', false)`;
      const [row] = await sql`SELECT count(*)::int AS n FROM thoughts WHERE metadata->>'source' = ${p.system} AND embedding IS NULL`;
      return Number(row.n);
    } finally {
      await sql.close();
    }
  },
});

export type Config = {
  key: string;
  pipelines: Pipeline[];
  importsDir: string;
  /** Where commands run: the repository root, so the emitter's and the pipeline's relative paths resolve. */
  cwd: string;
  commands: Commands;
  /** One run's bound, emitter to reembed, in seconds. */
  timeoutS: number;
  /** The most an emitter may print, in bytes. */
  maxBytes: number;
  /** The environment the ingester and reembed get: the database and the model knobs. The emitter gets none of it. */
  env: Record<string, string | undefined>;
  /** Prefixes that run a pipeline's emitter and the pipeline as their own users (su-exec in the image); empty elsewhere. */
  asEmitter: (p: Pipeline) => string[];
  asPipeline: string[];
  /** After a pipeline's emitter step, the command that stops whatever its uid still runs (a child it left); null where emitters have no uid of their own. */
  sweep: (p: Pipeline) => string[] | null;
  /** The command that asks, as the pipeline's emitter uid, whether its imports directory can be read; null where emitters have no uid of their own (the runner's own access is asked). */
  probe: (p: Pipeline, dir: string) => string[] | null;
  /** The port a networked pipeline's proxy listens on: its emitter uid in the image, which the egress rules open to that uid alone; 0 (any) elsewhere. */
  proxyPort: (p: Pipeline) => number;
  /** Whether a named host may resolve to a loopback or link-local address: only the self-check's stand-in upstream, on 127.0.0.1. */
  allowLocal: boolean;
};

/** Whatever a step printed, cut to its end: enough to say why, not a copy of what it read. */
const tail = (s: string, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);
const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean);

type Step = { code: number; bytes: Uint8Array; out: string; err: string; timedOut: boolean; overflow: boolean };
/**
 * One step, bounded. At the deadline it gets SIGTERM, then SIGKILL after a
 * grace. Its stdout is capped; its stderr keeps only a rolling tail. Once it
 * has exited, its pipes get a moment to close, and are then abandoned. A child
 * it left holding them cannot keep the run, or the pipeline's busy mark,
 * waiting (review pass 1, run-it: an emitter that daemonised a child held its
 * pipeline at 409 until the runner restarted).
 */
async function step(argv: string[], o: { cwd: string; env: Record<string, string | undefined>; stdin?: Uint8Array; deadline: number; maxBytes?: number; errBytes?: number }): Promise<Step> {
  const proc = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false, overflow = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    try { proc.kill("SIGTERM"); } catch {}
    if (killer) return;
    setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, SECOND_TERM_MS);
    killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, o.deadline - Date.now()));
  const handle = { stop, exited: proc.exited };
  live.add(handle);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const drain = async (s: ReadableStream<Uint8Array>, take: (c: Uint8Array) => void) => {
    const r = s.getReader();
    readers.push(r);
    try { for (;;) { const { done, value } = await r.read(); if (done) return; take(value); } } catch {}
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let errTail = "";
  const errMax = o.errBytes ?? 16384;
  const dec = new TextDecoder();
  const reading = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, (c) => {
      if (overflow) return;
      size += c.length;
      if (o.maxBytes !== undefined && size > o.maxBytes) { overflow = true; stop(); return; }
      chunks.push(c);
    }),
    drain(proc.stderr as ReadableStream<Uint8Array>, (c) => { errTail = (errTail + dec.decode(c, { stream: true })).slice(-errMax); }),
  ]);
  const code = await proc.exited;
  live.delete(handle);
  clearTimeout(timer);
  if (killer) clearTimeout(killer);
  await Promise.race([reading, Bun.sleep(DRAIN_MS)]);
  for (const r of readers) r.cancel().catch(() => {});
  const bytes = Buffer.concat(chunks);
  return { code, bytes, out: new TextDecoder().decode(bytes), err: errTail, timedOut, overflow };
}

/**
 * A URL's userinfo, masked, in anything a step printed: reembed and the
 * ingester name the provider's URL, and an operator's may carry a password
 * (review pass 2). The report is saved in n8n's run history.
 */
// To the LAST `@` before the path, as maskUrl does: a raw `@` inside a password is masked with the rest (review pass 3).
export const redact = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, (_m, scheme: string) => `${scheme}***@`);
/** Masked first, then cut: cutting first could leave a password's tail with no scheme before it to mask (review pass 3). */
const shownTail = (text: string, n?: number) => lines(tail(redact(text), n));
const redactAll = (xs: string[]) => xs.map(redact);

/** The emitter's environment: enough to run, nothing the runner holds; and a networked pipeline's, its proxy (SMD-2289). */
// No HOME: su-exec sets `/` for an emitter's uid. No Python user site either, so nothing another uid could plant under a HOME is ever imported (review pass 3).
const EMITTER_ENV = (env: Record<string, string | undefined>, proxy?: Proxy) => ({
  PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
  // Both spellings: Python's urllib and requests read the lower case first, Bun's fetch either.
  ...(proxy ? { HTTPS_PROXY: proxy.url, https_proxy: proxy.url } : {}),
});

/**
 * The egress rules (SMD-2289), for `nft -f -`, which the image's command runs
 * as root before the runner starts and drops the capability to change them
 * (runner.Dockerfile). Every packet from an emitter uid is refused, loopback
 * and DNS included, except a networked pipeline's own uid to its own proxy
 * port on 127.0.0.1, which is the uid's number. The refusal is a reset or an
 * ICMP error, so a connect fails at once rather than timing out (measured: a
 * drop left it waiting). Replacing the table makes a rerun the same rules.
 */
export function egressRules(pipelines: Pipeline[]): string {
  const opened = pipelines.filter((p) => p.network.length).map((p) => `    meta skuid ${emitterUid(p.name)} ip daddr 127.0.0.1 tcp dport ${emitterUid(p.name)} accept`);
  return [
    "table inet ob1_emitters",
    "delete table inet ob1_emitters",
    "table inet ob1_emitters {",
    "  chain output {",
    "    type filter hook output priority 0; policy accept;",
    `    meta skuid ${EMITTER_UIDS[0]}-${EMITTER_UIDS[1]} jump emitters`,
    "  }",
    "  chain emitters {",
    ...opened,
    "    meta l4proto tcp reject with tcp reset",
    "    reject with icmpx type admin-prohibited",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** A networked pipeline's proxy: where its emitter's HTTPS_PROXY points; take() hands over what it refused since the last take (one run's worth: a pipeline runs once at a time). */
export type Proxy = { url: string; port: number; take: () => string[]; close: () => void };
/** The most refusals one run's report names; the rest are counted. */
const REFUSALS_SHOWN = 20;

/**
 * The server name a TLS ClientHello asks for (SNI), read from the first TLS
 * record: "more" until that record is whole, null when the hello names no
 * server, and an Error when the bytes are not one ClientHello in one record
 * (a hello split across records, which the TLS clients an emitter uses do not
 * send, is refused rather than followed).
 */
export function helloName(b: Buffer): string | null | "more" | Error {
  if (b.length < 5) return "more";
  if (b[0] !== 0x16 || b[1] !== 3) return new Error("not a TLS handshake");
  const len = b.readUInt16BE(3);
  if (len > 16384) return new Error("a TLS record past its maximum length");
  if (b.length < 5 + len) return "more";
  const r = b.subarray(5, 5 + len);
  try {
    if (r[0] !== 1) return new Error("a TLS handshake that is not a ClientHello");
    const end = 4 + r.readUIntBE(1, 3);
    if (end > r.length) return new Error("a ClientHello split across TLS records");
    let i = 4 + 2 + 32;
    i += 1 + r[i];
    i += 2 + r.readUInt16BE(i);
    i += 1 + r[i];
    if (i === end) return null;
    const extEnd = i + 2 + r.readUInt16BE(i);
    if (extEnd > end) return new Error("a malformed ClientHello");
    let name: string | null = null;
    for (i += 2; i + 4 <= extEnd;) {
      const [type, size] = [r.readUInt16BE(i), r.readUInt16BE(i + 2)];
      i += 4;
      if (i + size > extEnd) return new Error("a malformed ClientHello");
      // Encrypted ClientHello (and the draft ESNI before it) carries an inner server name the proxy cannot read, behind an outer one it would check; the TLS clients an emitter uses send neither (review pass 2).
      if (type === 0xfe0d || type === 0xffce) return new Error("a ClientHello carrying an encrypted inner one, whose server name the proxy cannot read");
      if (type === 0) {
        if (name !== null) return new Error("a ClientHello with two server_name extensions");
        // Read as servers read it: the list fills the extension, and its first entry is a host name (review pass 2: entries were read past the extension, and a host name after another type was taken).
        const listEnd = i + 2 + r.readUInt16BE(i);
        const n = r.readUInt16BE(i + 3);
        if (listEnd !== i + size || r[i + 2] !== 0 || i + 5 + n > listEnd || n === 0) return new Error("a malformed server_name extension");
        name = r.subarray(i + 5, i + 5 + n).toString("latin1").toLowerCase().replace(/\.$/, "");
      }
      i += size;
    }
    return name;
  } catch {
    return new Error("a malformed ClientHello");
  }
}

/** The proxy's bounds; the self-check shortens them, and stands in for DNS. */
export type ProxyOptions = {
  /** Whether a named host may resolve to a LOCAL address: only the self-check's stand-in upstream, on 127.0.0.1. */
  allowLocal?: boolean;
  /** Every address a name resolves to. */
  lookup?: (host: string) => Promise<string[]>;
  /** A connection's quiet bound until its tunnel opens (its request, the dial, its ClientHello), and an open tunnel's after either side ends. */
  headMs?: number;
  /** How long the named host has to answer the dial. */
  dialMs?: number;
  /** The most connections the proxy holds at once. */
  maxConnections?: number;
};

/**
 * A pipeline's proxy (SMD-2289): TLS to one of the hosts it names, on that
 * port, and nothing else.
 * - `CONNECT host:port` for a named host on its named port; another is 403, a
 *   request that is not CONNECT 405. It resolves the host itself, refuses one
 *   that resolves to a LOCAL address (the runner's own ports, a metadata
 *   endpoint), and dials the address it checked. A host that resolves to
 *   nothing or refuses the dial is 502, one that does not answer it 504.
 * - The tunnel's first bytes must be a TLS ClientHello whose server name is
 *   the named host (for a named IPv4 address, that address or none). Without
 *   this, a host behind a CDN that routes by server name made the tunnel a
 *   way to any site on that CDN (review pass 1).
 * Each refusal is kept for the run's report. It listens on 127.0.0.1 only,
 * and in the image the egress rules let the pipeline's uid reach this port
 * and nothing else.
 */
export function startProxy(p: Pipeline, port: number, o: ProxyOptions = {}): Promise<Proxy> {
  const refused: string[] = [];
  let dropped = 0;
  const cut = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
  const named = p.network.map((h) => `${h.host}:${h.port}`).join(", ");
  const resolve = o.lookup ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  const [headMs, dialMs] = [o.headMs ?? 30_000, o.dialMs ?? 10_000];
  const note = (why: string) => { if (refused.length < REFUSALS_SHOWN) refused.push(why); else dropped++; };
  // Half-open on both sides: a client that sends and then shuts its write side still gets the answer (review pass 1).
  const server = createServer({ allowHalfOpen: true }, (client) => {
    let head = Buffer.alloc(0);
    // Where the connection is, for what a quiet cut says: its request, the proxy's own lookup and dial, its ClientHello, answered, or tunneled (review pass 3: a slow lookup, and a refused client that stayed, were each reported as a request never sent).
    let stage: "request" | "dial" | "hello" | "answered" | "tunneled" = "request";
    let target = "";
    // Kept from the start: a client that shuts its write side while the name resolves has its end emitted before any pipe is there to pass it on (measured in Bun, a paused socket included), and its tunnel then never let go (review pass 2).
    let clientEnded = false;
    client.once("end", () => { clientEnded = true; });
    // Until the request and the ClientHello arrive, and reset by each byte (a quiet bound, not a deadline); an open tunnel lasts while both sides are open, and the same quiet bound after either ends.
    client.setTimeout(headMs, () => {
      const quiet = `${headMs / 1000} s of quiet`;
      if (stage === "request") note(`a connection sent no whole request in ${quiet}, and was closed`);
      else if (stage === "dial") note(`CONNECT ${target}: resolving and dialling it took past ${quiet}, and the connection was closed`);
      else if (stage === "hello") note(`CONNECT ${target}: no whole ClientHello in ${quiet}, and the tunnel was closed`);
      client.destroy();
    });
    client.on("error", () => {});
    const answer = (status: string, why: string) => {
      note(why);
      stage = "answered";
      client.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}\n`);
      // Answered: a client that stays is let go at once, not held to the quiet bound against the cap.
      client.setTimeout(1000);
    };
    const onData = async (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      // A head past 8 KB is refused whether or not its end has arrived: a whole one in one read was accepted at any size (review pass 4).
      if (end < 0 || end > 8192) { if (head.length > 8192) { client.off("data", onData); answer("431 Request Header Fields Too Large", "a request past 8 KB of headers"); } return; }
      client.off("data", onData);
      client.pause();
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
      if (!m) return answer("405 Method Not Allowed", `${cut(line)}: the runner's proxy tunnels HTTPS only (CONNECT host:port)`);
      const [host, want] = [m[1].toLowerCase(), Number(m[2])];
      if (!p.network.some((h) => h.host === host && h.port === want)) return answer("403 Forbidden", `CONNECT ${cut(`${host}:${want}`)}: not a host ${p.name} names (network: ${named})`);
      stage = "dial";
      target = `${host}:${want}`;
      let addresses: string[];
      try { addresses = await resolve(host); } catch { addresses = []; }
      // Gone while the name resolved (its emitter stopped, the quiet bound cut it): nothing to answer or tunnel for (review pass 4: a cut connection was answered a second time).
      if (client.destroyed) return;
      if (!addresses.length) return answer("502 Bad Gateway", `CONNECT ${host}:${want}: ${host} did not resolve`);
      // Every address is screened, not only the one dialled: an answer that mixes a public address with a loopback one is a rebinding answer (review pass 2). IPv4 first, since a container often has no IPv6 route.
      const local = addresses.find(isLocalAddress);
      if (!o.allowLocal && local) return answer("403 Forbidden", `CONNECT ${host}:${want}: ${host} resolves to ${local}, a loopback, link-local or metadata address, which no emitter may reach`);
      const address = addresses.find((a) => isIP(a) === 4) ?? addresses[0];
      const up = tcpConnect({ host: address, port: want, allowHalfOpen: true });
      const dialing = setTimeout(() => { up.destroy(); answer("504 Gateway Timeout", `CONNECT ${host}:${want}: ${address} did not answer within ${dialMs / 1000} s`); }, dialMs);
      up.once("connect", () => {
        stage = "hello";
        clearTimeout(dialing);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        let hello = rest;
        const check = () => {
          const name = helloName(hello);
          if (name === "more") return;
          client.off("data", onHello);
          const fits = isIP(host) ? name === null || name === host : name === host;
          if (name instanceof Error || !fits) {
            note(`CONNECT ${host}:${want}: ${name instanceof Error ? `the tunnel did not begin with a TLS ClientHello (${name.message}); the proxy carries TLS to the named host only` : `the TLS ClientHello names ${name === null ? "no server" : cut(name)}, not ${host}`}`);
            up.destroy();
            client.destroy();
            return;
          }
          stage = "tunneled";
          client.setTimeout(0);
          // Once either side has ended, the tunnel has the request's quiet bound before both go: a named host that never closes held a half-closed tunnel, and the pipeline's connections, until the runner restarted (review pass 2).
          const linger = () => { for (const x of [client, up]) x.setTimeout(headMs, () => { up.destroy(); client.destroy(); }); };
          up.once("end", linger);
          up.write(hello);
          up.pipe(client);
          if (clientEnded) {
            up.end();
            linger();
          } else {
            client.once("end", linger);
            client.pipe(up);
          }
        };
        const onHello = (c: Buffer) => { hello = Buffer.concat([hello, c]); check(); };
        client.on("data", onHello);
        client.resume();
        if (hello.length) check();
      });
      up.on("error", (e) => { clearTimeout(dialing); if (stage === "dial") answer("502 Bad Gateway", `CONNECT ${host}:${want}: ${(e as Error).message}`); else client.destroy(); });
      // A side that closes cleanly has ended the other through pipe; one that failed takes the other with it.
      client.once("close", () => { clearTimeout(dialing); up.destroy(); });
      up.once("close", (failed) => { if (failed) client.destroy(); });
    };
    client.on("data", onData);
  });
  // Bounded: a networked emitter an export has taken over cannot hold the runner's descriptors (review pass 1).
  server.maxConnections = o.maxConnections ?? 64;
  server.on("drop", () => note(`a connection past the proxy's ${server.maxConnections} at once, closed`));
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      const at = server.address() as { address: string; port: number };
      ok({
        url: `http://${at.address}:${at.port}`, port: at.port,
        take: () => { const out = refused.splice(0); const more = dropped; dropped = 0; return more ? [...out, `…and ${more} more`] : out; },
        close: () => server.close(),
      });
    });
  });
}

export type Stage = "emitter" | "one-source" | "ingest" | "reembed";
export type Report = {
  pipeline: string;
  ok: boolean;
  /** Where it stopped, when it did not finish, and that step's exit code (null when it was stopped). */
  stage?: Stage;
  exit?: number | null;
  why?: string;
  emitted: number;
  counts?: Tally | null;
  /** The ingester's count lines, and its stderr (the items it named, the refusals). */
  report?: string[];
  notes?: string[];
  reembed?: { exit: number; tail: string[]; unembedded?: number };
  /** What the pipeline's proxy refused or cut during the run (SMD-2289): a host or port it does not name, a request that is not CONNECT or too long, a ClientHello naming another server, a host that did not resolve or answer, a connection quiet too long or past the cap. */
  egress?: string[];
};

/** The HTTP status for a report: the input's fault is 422 (the emitter, the one-source rule, the ingester refusing the batch), anything else 500. */
export function statusOf(r: Report): number {
  if (r.ok) return 200;
  if (r.stage === "emitter" || r.stage === "one-source") return 422;
  if (r.stage === "ingest" && r.exit === 2) return 422;
  return 500;
}

/** reembed is one pass over the whole brain at a time: two pipelines' passes would see each other's leases. */
let reembedTurn: Promise<unknown> = Promise.resolve();

/** One run of one pipeline, and what its proxy refused the emitter meanwhile. */
async function runPipeline(c: Config, p: Pipeline, proxy?: Proxy): Promise<Report> {
  proxy?.take();
  const r = await runSteps(c, p, proxy);
  const refused = proxy?.take().map(redact) ?? [];
  return refused.length ? { ...r, egress: refused } : r;
}

/** One run of one pipeline, start to report, within one deadline. */
async function runSteps(c: Config, p: Pipeline, proxy: Proxy | undefined): Promise<Report> {
  const deadline = Date.now() + c.timeoutS * 1000;
  const past = `ran past the run's ${c.timeoutS} s and was stopped`;
  const input = join(c.importsDir, p.name);
  // An export the emitter's uid cannot read looked like no export at all: a
  // green run with nothing emitted (review pass 4: Python's glob answers an
  // unreadable directory with nothing). Asked as that uid, before it runs. A
  // pipeline with no directory (a live-API emitter) is not asked; one behind
  // an imports root the runner cannot search is refused, naming the root
  // (review pass 5: it read as absent and skipped the probe).
  const where = inputState(input);
  if (where === "blocked") return { pipeline: p.name, ok: false, stage: "emitter", exit: null, why: `the runner cannot search ${c.importsDir} to reach ${input}: the imports directory must be searchable (mode o+x) — deploy/imports/README.md`, emitted: 0 };
  if (typeof where === "object") return { pipeline: p.name, ok: false, stage: "emitter", exit: null, why: `${input} cannot be read as a directory (${where.code}): is IMPORTS_DIR a directory? — deploy/imports/README.md`, emitted: 0 };
  if (where === "present") {
    const probe = c.probe(p, input);
    const readable = probe ? (await step(probe, { cwd: c.cwd, env: EMITTER_ENV(c.env), deadline: Date.now() + 5000 })).code === 0 : canRead(input);
    if (!readable) return { pipeline: p.name, ok: false, stage: "emitter", exit: null, why: `${p.name}'s emitter${probe ? ` runs as uid ${emitterUid(p.name)}, which` : ""} cannot read ${input}: make the export readable to it (deploy/imports/README.md)`, emitted: 0 };
  }
  const argv = [...c.asEmitter(p), ...p.emitter.map((a) => a.replaceAll("{input}", input))];
  const e = await step(argv, { cwd: c.cwd, env: EMITTER_ENV(c.env, proxy), deadline, maxBytes: c.maxBytes });
  // Whatever the emitter left running as its uid is stopped, whether it exited well or not (review pass 2).
  const sweep = c.sweep(p);
  if (sweep) await step(sweep, { cwd: c.cwd, env: EMITTER_ENV(c.env), deadline: Date.now() + 5000 });
  if (e.timedOut || e.overflow || e.code !== 0) {
    const why = e.timedOut ? `the emitter ${past}` : e.overflow ? `the emitter printed more than ${c.maxBytes} bytes and was stopped` : `the emitter exited ${e.code}`;
    return { pipeline: p.name, ok: false, stage: "emitter", exit: e.timedOut || e.overflow ? null : e.code, why, emitted: 0, notes: shownTail(e.err) };
  }
  const emitted = lines(e.out).length;
  const stray = strayLines(e.bytes, p);
  if (stray.length) return { pipeline: p.name, ok: false, stage: "one-source", why: `${stray.length} line(s) are not ${p.name}'s source — the batch is refused whole; nothing written`, emitted, notes: stray.slice(0, 20) };
  if (emitted === 0) return { pipeline: p.name, ok: true, emitted, counts: null, report: [`${p.name}: the emitter printed nothing — no export under ${input}?`] };
  const ing = await step([...c.asPipeline, ...c.commands.ingest(p)], { cwd: c.cwd, env: c.env, stdin: e.bytes, deadline });
  if (ing.code !== 0 && passwordRefused(ing.err)) return { pipeline: p.name, ok: false, stage: "ingest", exit: ing.code, emitted, why: RUNNER_PASSWORD_WHY };
  // The ingester's own "next: bun db/reembed.ts" is the runner's next step, not the reader's.
  const base = { pipeline: p.name, emitted, counts: parseTally(ing.out), report: redactAll(lines(ing.out).filter((l) => !/^\s*next: /.test(l))), notes: shownTail(ing.err, 8000) };
  if (ing.timedOut || ing.code !== 0) return { ...base, ok: false, stage: "ingest", exit: ing.timedOut ? null : ing.code, why: ing.timedOut ? `the ingester ${past}` : `the ingester exited ${ing.code}${ing.code === 2 ? " (it refused the batch or its configuration; nothing written — the notes say which)" : ""}` };
  // One reembed pass at a time. The wait for another pipeline's pass counts
  // against this run's deadline too (review pass 2: two overlapping runs could
  // take nearly twice it, and n8n gave up first).
  const before = reembedTurn;
  let release!: () => void;
  reembedTurn = before.then(() => new Promise<void>((r) => { release = r; }));
  const ours = await Promise.race([before.then(() => true), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => false)]);
  let re: Step, unembedded: number;
  try {
    if (!ours) return { ...base, ok: false, stage: "reembed", exit: null, why: `the rows are written; the run's ${c.timeoutS} s ran out waiting for another pipeline's reembed, and the next run embeds them` };
    try { re = await step([...c.asPipeline, ...c.commands.reembed()], { cwd: c.cwd, env: c.env, deadline }); }
    catch (err) { return { ...base, ok: false, stage: "reembed", exit: null, why: `the rows are written, and reembed could not be started: ${(err as Error).message}` }; }
    // reembed exits 1 for any failed row it holds from any earlier pass, and
    // for another pass's leases (review pass 1: every import then failed for
    // good). What this run owes is its own source's rows with a vector.
    unembedded = await c.commands.unembedded(p);
  } catch (err) {
    return { ...base, ok: false, stage: "reembed", exit: null, why: `the rows are written, and counting ${p.system}'s rows without a vector failed: ${(err as Error).message}` };
  } finally {
    // Released once the chain reaches this run, whether it ran, gave up, or failed.
    before.then(() => release());
  }
  const reembed = { exit: re.code, tail: shownTail(`${re.out}\n${re.err}`, 1500), unembedded };
  // reembed exits 2 before embedding anything, for two kinds of reason
  // (review pass 5: pass 4 took every exit 2 for the first, and quoted
  // reembed's last line, which is advice, not the reason):
  // - a refusal no rerun fixes: a model switch it was not told of, a width
  //   mismatch, an unusable configuration, a missing migration, an egress
  //   policy refusing everything, a provider refusing the model or the route;
  // - a provider that did not answer, or a start that met another claimer:
  //   the next run tries again. Only these, by reembed's own rule; anything
  //   else is taken for the first kind (review pass 6).
  if (unembedded > 0 && re.code === 2) {
    const { reason, configuration } = reembedRefusal(re.err);
    return {
      ...base, ok: false, stage: "reembed", exit: 2, reembed,
      why: configuration
        ? `the rows are written, and reembed refused to run: ${sentence(reason)} So ${rowsLack(unembedded, p.system)} no vector, and no run embeds ${unembedded === 1 ? "it" : "them"} until that is fixed. The runner takes the server's model and egress settings when it is created: after changing them, recreate both (compose --profile orchestration up -d --force-recreate server orchestration-runner)`
        : `the rows are written, and reembed could not run this time: ${sentence(reason)} ${rowsLack(unembedded, p.system)} no vector yet; the next run tries again`,
    };
  }
  if (unembedded > 0) {
    return {
      ...base, ok: false, stage: "reembed", exit: re.timedOut ? null : re.code, reembed,
      why: `the rows are written, and ${rowsLack(unembedded, p.system)} no vector (reembed ${re.timedOut ? past : `exited ${re.code}`}). One still pending is embedded by the next run. One the provider refused waits for a retry, run in the runner: compose exec orchestration-runner su-exec bun bun db/reembed.ts --retry-failed. One it refuses every time is an item to fix or remove in the export, then delete its thought`,
    };
  }
  return { ...base, ok: true, reembed };
}

const digest = (s: string) => createHash("sha256").update(s).digest();
/** 401 without a key, 403 with a wrong one: the two answers the brain gives. Compared as digests, in constant time. */
function keyStatus(req: Request, key: string): 0 | 401 | 403 {
  const given = req.headers.get("x-runner-key");
  if (!given) return 401;
  return timingSafeEqual(digest(given), digest(key)) ? 0 : 403;
}

/** The service, and a proxy for each networked pipeline. `port: 0` picks one (the self-check). */
export async function serve(c: Config, port = DEFAULT_PORT): Promise<{ port: number; stop: (force?: boolean) => void }> {
  const byName = new Map(c.pipelines.map((p) => [p.name, p]));
  const busy = new Set<string>();
  const proxies = new Map<string, Proxy>();
  try {
    for (const p of c.pipelines) if (p.network.length) proxies.set(p.name, await startProxy(p, c.proxyPort(p), { allowLocal: c.allowLocal }));
  } catch (e) {
    for (const x of proxies.values()) x.close();
    throw e;
  }
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    // Never Bun's development error page, which shows source and a stack.
    development: false,
    // A pipeline's run can take a while; the connection waits for it.
    idleTimeout: 0,
    error(err) {
      console.error(`runner: ${err.message}`);
      return Response.json({ ok: false, why: "the runner failed on this request; its log says why" }, { status: 500 });
    },
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ ok: true, pipelines: byName.size });
      const m = /^\/run\/([^/]+)$/.exec(u.pathname);
      if (!m) return new Response("not here", { status: 404 });
      // The key first, so an unkeyed caller learns nothing, not even which pipelines exist.
      const refused = keyStatus(req, c.key);
      if (refused) return Response.json({ ok: false, why: refused === 401 ? "no x-runner-key" : "wrong x-runner-key" }, { status: refused });
      if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
      // A name is a plain label (NAME_RE), so an escape that does not decode names nothing.
      let name: string;
      try { name = decodeURIComponent(m[1]); } catch { name = ""; }
      const p = byName.get(name);
      if (!p) return Response.json({ ok: false, why: `no pipeline ${JSON.stringify(m[1])} in the allowlist` }, { status: 404 });
      if (busy.has(p.name)) return Response.json({ ok: false, pipeline: p.name, why: "a run of this pipeline is already going" }, { status: 409 });
      busy.add(p.name);
      try {
        const r = await runPipeline(c, p, proxies.get(p.name));
        console.log(`${new Date().toISOString()} ${p.name}: ${r.ok ? "ok" : `${r.stage}: ${r.why}`} (emitted ${r.emitted}${r.counts ? `, inserted ${r.counts.inserted}, updated ${r.counts.updated}, unchanged ${r.counts.unchanged}` : ""})`);
        return Response.json(r, { status: statusOf(r) });
      } finally {
        busy.delete(p.name);
      }
    },
  });
  return {
    port: server.port ?? port,
    stop: (force) => { server.stop(force); for (const x of proxies.values()) x.close(); },
  };
}

/** su-exec, where the image installs it. */
const SU_EXEC = ["/sbin/su-exec", "/usr/bin/su-exec"].find((f) => existsSync(f));

/**
 * The phrases reembedRefusal reads, as reembed and the embedder print them.
 * The self-check fails when one disappears from their source, so a reworded
 * message cannot silently change a refusal's kind (review pass 6).
 */
const REEMBED_PHRASES = {
  retryable: ["The embedding provider is not usable", "Could not start the pass"],
  // reembed's own configShaped rule for a provider failure (db/reembed.ts), as the embedder words each case (server-portable/embed.ts).
  configShaped: ["Embedding width mismatch", "returned no embedding", "with a body that is not JSON", "refused by the egress gate"],
} as const;

/**
 * reembed's reason for an exit 2: the first line of the last paragraph it
 * printed to stderr (its refusals are a paragraph, the reason first and advice
 * after), with a `✗` list joined onto the line that heads it; masked. And
 * whether it is a refusal of the configuration, which no rerun fixes. Only a
 * start that met another claimer, or a provider failure reembed's own rule
 * does not call configuration-shaped (a timeout, a dropped connection, a 408,
 * 429 or 5xx), is retryable. Anything else is configuration (review pass 6:
 * the other way round, an unusable embedding configuration and a missing
 * migration were promised a retry).
 */
function reembedRefusal(stderr: string): { reason: string; configuration: boolean } {
  const paragraphs = redact(stderr).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const last = paragraphs.at(-1) ?? "";
  const reason = (last.startsWith("✗")
    ? `${paragraphs.at(-2)?.split("\n")[0].trim() ?? ""} ${last.split("\n").map((l) => l.trim().replace(/\.$/, "")).join("; ")}`.trim()
    : last.split("\n")[0].trim()) || "no reason printed";
  const providerRetryable = reason.startsWith(REEMBED_PHRASES.retryable[0])
    && !REEMBED_PHRASES.configShaped.some((x) => reason.includes(x))
    && !/ failed: 40[0-4]\b/.test(reason);
  return { reason, configuration: !(providerRetryable || reason.startsWith(REEMBED_PHRASES.retryable[1])) };
}

/** A reason as a sentence: ended with a full stop when it has none. */
const sentence = (t: string) => (/[.!?)]$/.test(t) ? t : `${t}.`);
/** "1 of s's rows has" / "3 of s's rows have". */
const rowsLack = (n: number, system: string) => `${n} of ${system}'s rows ${n === 1 ? "has" : "have"}`;

/** Where a pipeline's imports directory stands, as the runner sees it: there, not there, behind a directory the runner cannot search, or something else that is not a directory it can reach (a file where the directory should be, a loop). */
function inputState(dir: string): "present" | "absent" | "blocked" | { code: string } {
  try { statSync(dir); return "present"; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return code === "ENOENT" ? "absent" : code === "EACCES" || code === "EPERM" ? "blocked" : { code };
  }
}

/** Whether this process can list a directory: the runner's own access, where emitters share its uid. */
function canRead(dir: string): boolean {
  try { accessSync(dir, constants.R_OK | constants.X_OK); return true; } catch { return false; }
}

/** What a missing emitter needs, said the same way at build and at start (review pass 4: "rebuild" was the advice at both, and a rebuild can never add it). */
const missingEmitterHelp = (missing: string[]) => `pipelines.json names an emitter the image does not hold (${missing.join("; ")}). Copy it into the image: a COPY line in deploy/orchestration/runner.Dockerfile, and a \`!<its path>\` line in the repo root's .dockerignore (which keeps recipes/ and evals/ out); then rebuild the runner: compose --profile orchestration up -d --build orchestration-runner`;

/** Whether a step's stderr is Postgres refusing the runner's password: its role's was changed and the runner not recreated (review pass 1: a bare stack trace). */
const passwordRefused = (stderr: string) => /password authentication failed for user/.test(stderr);
/** What the runner says then. */
const RUNNER_PASSWORD_WHY = "Postgres refused the runner's database password: OB1_RUNNER_DB_PASSWORD was changed and the runner not recreated with it. Start the profile again (compose --profile orchestration up -d), which resets the role's password and recreates the runner; nothing was written";

/** A postgres URL's password, "" when it has none; null when there is no URL to read. */
export function databasePassword(url: string | undefined): string | null {
  if (!url) return null;
  try { return decodeURIComponent(new URL(url).password); } catch { return null; }
}

/** The service's configuration from its environment; throws with the reason. */
function configFrom(env: Record<string, string | undefined>, uid = process.getuid?.() ?? -1, file = PIPELINES_FILE): Config {
  const key = env.OB1_RUNNER_KEY?.trim() ?? "";
  if (key.length < 32) throw new Error("OB1_RUNNER_KEY is not set, or shorter than 32 characters — run `bun deploy/orchestration/provision.ts --init`, which writes it into deploy/.env");
  const timeoutS = Number(env.OB1_RUNNER_TIMEOUT_S?.trim() || DEFAULT_TIMEOUT_S);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error(`OB1_RUNNER_TIMEOUT_S must be a positive number of seconds, got "${env.OB1_RUNNER_TIMEOUT_S}"`);
  // As root (the image), nothing runs as root: without su-exec the runner refuses to start.
  if (uid === 0 && !SU_EXEC) throw new Error("running as root without su-exec: an emitter would run as root and could read every secret — use the runner's image (deploy/orchestration/runner.Dockerfile)");
  // In the image the runner connects as its own role, whose password compose puts in the URL from OB1_RUNNER_DB_PASSWORD (SMD-2289); unset, every run would fail on its first query instead.
  if (uid === 0 && databasePassword(env.DATABASE_URL) === "") throw new Error("DATABASE_URL carries no password: OB1_RUNNER_DB_PASSWORD, the runner's database role's, is not set — run `bun deploy/orchestration/provision.ts --init`, which writes it into deploy/.env, then start the profile again so its role step sets it");
  const pipelines = loadPipelines(file);
  const byUid = new Map<number, string>();
  for (const p of pipelines) {
    const other = byUid.get(emitterUid(p.name));
    if (other) throw new Error(`pipelines ${other} and ${p.name} would share an emitter uid (${emitterUid(p.name)}) — rename one`);
    byUid.set(emitterUid(p.name), p.name);
  }
  const missing = missingEmitters(pipelines, REPO);
  if (missing.length) throw new Error(missingEmitterHelp(missing));
  return {
    key,
    pipelines,
    // The container's own path; compose mounts IMPORTS_DIR (a host path) here.
    importsDir: "/imports",
    cwd: REPO,
    commands: PIPELINE_COMMANDS(env),
    timeoutS,
    maxBytes: 256 * 1024 * 1024,
    // The ingester and reembed need the database and the model knobs, not the runner's own key (review pass 2).
    env: { ...env, OB1_RUNNER_KEY: undefined, ...(uid === 0 ? { HOME: `/home/${PIPELINE_USER}` } : {}) },
    asEmitter: (p) => (uid === 0 ? [SU_EXEC!, `${emitterUid(p.name)}:${emitterUid(p.name)}`] : []),
    asPipeline: uid === 0 ? [SU_EXEC!, PIPELINE_USER] : [],
    sweep: (p) => (uid === 0 ? [SU_EXEC!, `${emitterUid(p.name)}:${emitterUid(p.name)}`, "kill", "-9", "-1"] : null),
    // The kernel's own answer, as that uid: busybox's `test -r` reads the mode bits and ignores ACLs, so it refused an export the documented setfacl made readable (review pass 5).
    probe: (p, dir) => (uid === 0 ? [SU_EXEC!, `${emitterUid(p.name)}:${emitterUid(p.name)}`, "python3", "-c", "import os, sys; sys.exit(0 if os.access(sys.argv[1], os.R_OK | os.X_OK) else 1)", dir] : null),
    proxyPort: (p) => (uid === 0 ? emitterUid(p.name) : 0),
    allowLocal: false,
  };
}

/** A start that is refused: said, and after 30 s exit 2, which the restart policy retries without a hot loop filling the log (review pass 4: 229 restarts in 30 s). */
async function refuseStart(why: string): Promise<never> {
  console.error(`runner: ${why} (exiting in 30 s; the restart policy retries)`);
  await Bun.sleep(30_000);
  process.exit(2);
}

/** Capabilities this process holds that the image's command drops before the runner starts: the two that change the egress rules (SMD-2289). */
function heldEgressCaps(status = existsSync("/proc/self/status") ? readFileSync("/proc/self/status", "utf8") : ""): string[] {
  const eff = /^CapEff:\s*([0-9a-f]+)$/m.exec(status)?.[1];
  if (!eff) return [];
  const bits = BigInt(`0x${eff}`);
  return ([["NET_ADMIN", 12n], ["SETPCAP", 8n]] as const).filter(([, b]) => (bits >> b) & 1n).map(([n]) => n);
}

/**
 * Whether an emitter uid can reach a port of the runner's on 127.0.0.1,
 * asked as that uid (the range's last) before the service listens, against a
 * listener opened for the question: "reached" means the egress rules are not
 * in place. The image's command sets them; a runner started another way, or
 * an engine that dropped them, would otherwise give every emitter the
 * network. Only a refusal counts as refused; a probe that could not ask (su-exec
 * or python failing, a timeout) is its own answer, and the start is refused
 * for it too (review pass 1: any failure read as refused, and the service was
 * already listening).
 */
async function emittersReach(): Promise<"reached" | "refused" | Error> {
  const listener = createServer((s) => s.destroy());
  await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
  try {
    const port = (listener.address() as { port: number }).port;
    const r = await step([SU_EXEC!, `${EMITTER_UIDS[1]}:${EMITTER_UIDS[1]}`, "python3", "-c", EMITTER_PROBE, String(port)], { cwd: "/", env: EMITTER_ENV(process.env), deadline: Date.now() + 10_000 });
    return r.code === 0 ? "reached" : r.code === 3 ? "refused" : new Error(`the probe as uid ${EMITTER_UIDS[1]} exited ${r.code}${r.timedOut ? " (timed out)" : ""}: ${tail(r.err, 300).trim()}`);
  } finally {
    listener.close();
  }
}
/** Exits 0 when the connection opens, 3 when it is refused or reset, as the egress rules refuse it; anything else is a traceback. */
const EMITTER_PROBE = [
  "import socket, sys",
  "try:",
  "    socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=3).close()",
  "except (ConnectionRefusedError, ConnectionResetError, PermissionError):",
  "    sys.exit(3)",
].join("\n");

/**
 * `--self-check`: the allowlist's rules, the one-source rule, the count line,
 * the status mapping, and the service against stand-in commands (no
 * database):
 * - the key's two refusals, an unknown pipeline, and a malformed escape;
 * - a run that writes, and one whose rows are left without a vector
 *   whatever reembed's exit;
 * - a stray line refused before the ingester runs;
 * - an emitter that fails, and an emitter that cannot see the runner's
 *   environment;
 * - the bounds on a run: a second call while one is going (409), a step past
 *   the deadline, one that ignores SIGTERM, one that leaves a child holding
 *   its pipes, and output past the cap;
 * - an export its uid cannot read and an imports root the runner cannot
 *   search, each refused; reembed's refusals told apart (configuration or
 *   retryable), by phrases that must still be in reembed's source; live steps
 *   stopped when the runner stops;
 * - SMD-2289: a pipeline's `network` parsed and refused, the address screen,
 *   the egress rules' text and the capabilities read from CapEff; the proxy
 *   through the service and on its own, against a stand-in for DNS and
 *   stand-in hosts on 127.0.0.1: the ClientHello's server name read and held
 *   to the named host, what it refuses and reports, the bounds on a
 *   connection and a tunnel, half-open tunnels, and what a host that never
 *   closes or ends first does to them.
 * Running as another user, and the egress rules themselves, are the image's,
 * and the eval kit holds them live (evals/orchestration/n8n.ts, I).
 */
async function selfCheck(): Promise<number> {
  const fails: string[] = [];
  const expect = (what: string, ok: boolean) => { if (!ok) fails.push(what); };
  const throws = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (e) { return re.test((e as Error).message); } };
  const good = { name: "fixture", system: "fixture", scope: "fixture:export", emitter: ["bun", "x.ts", "{input}"], everyHours: 24 };
  const one = (p: object) => JSON.stringify([{ ...good, ...p }]);
  expect("a good pipeline parses", parsePipelines(one({}))[0].name === "fixture");
  // In the image this runs before pipelines.json is copied (its own layer, then --check-emitters); from a checkout it is there.
  expect("the shipped allowlist parses", !existsSync(PIPELINES_FILE) || Array.isArray(loadPipelines()));
  expect("a name that is not a label is refused", throws(() => parsePipelines(one({ name: "../x" })), /name must match/));
  expect("a name listed twice is refused", throws(() => parsePipelines(JSON.stringify([good, good])), /listed twice/));
  // Stand-in pipelines below share the stand-in system; each is parsed on its own.
  const each = (xs: object[]) => xs.flatMap((x) => parsePipelines(JSON.stringify([x])));
  expect("two pipelines on one system are refused: each owns one source", throws(() => parsePipelines(JSON.stringify([good, { ...good, name: "other" }])), /already pipeline fixture's; each pipeline owns one source/));
  expect("a reserved system is refused", throws(() => parsePipelines(one({ system: "linear" })), /reads itself/));
  expect("two scopes are refused", throws(() => parsePipelines(one({ scope: "a,b" })), /separator between scopes/));
  expect("a scope the ingester would refuse (a `/`, surrounding space) is refused here", throws(() => parsePipelines(one({ scope: "a/b" })), /holds a `\/`/) && throws(() => parsePipelines(one({ scope: " a:b" })), /surrounding whitespace/));
  expect("an interpreter the image lacks is refused", throws(() => parsePipelines(one({ emitter: ["sh", "-c", "x"] })), /must start with python3 or bun/));
  expect("an unknown field is refused", throws(() => parsePipelines(one({ env: ["TOKEN"] })), /unknown field env/));
  expect("a schedule past a week is refused", throws(() => parsePipelines(one({ everyHours: 200 })), /everyHours/));
  expect("a schedule of 24 hours or more that is not whole days is refused", throws(() => parsePipelines(one({ everyHours: 25 })), /whole days/) && parsePipelines(one({ everyHours: 23 })).length === 1 && parsePipelines(one({ everyHours: 168 })).length === 1);
  expect("hours up to 23 are n8n hours, whole days are n8n days (an hourly 24 fires once, then never)", JSON.stringify([scheduleOf(1), scheduleOf(23), scheduleOf(24), scheduleOf(168)]) === JSON.stringify([{ field: "hours", hoursInterval: 1 }, { field: "hours", hoursInterval: 23 }, { field: "days", daysInterval: 1 }, { field: "days", daysInterval: 7 }]));
  expect("an emitter uid is its pipeline's own, stable, and outside the image's users", emitterUid("fixture") === emitterUid("fixture") && emitterUid("fixture") !== emitterUid("stray") && emitterUid("x") >= 20000 && emitterUid("x") < 60000);
  expect("a URL's userinfo is masked in anything a step printed", redact("via https://u:SECRET@host/v1, postgres://p:q@db/x, https://plain/") === "via https://***@host/v1, postgres://***@db/x, https://plain/");
  expect("a raw @ inside a password is masked with the rest", redact("https://u:p@ss@host/v1") === "https://***@host/v1");
  // The shipped file is not read here: at build time it may name an emitter the image does not hold yet, which the build's own --check-emitters step reports (review pass 4).
  const emptyFile = join(tmpdir(), `ob1-runner-self-check.${process.pid}.pipelines.json`);
  writeFileSync(emptyFile, "[]");
  let shipped: Config;
  try { shipped = configFrom({ OB1_RUNNER_KEY: "k".repeat(40), DATABASE_URL: "postgres://x" }, 1000, emptyFile); } finally { rmSync(emptyFile, { force: true }); }
  const transient = reembedRefusal("\n  job: x\n\n  The embedding provider is not usable: fetch failed http://u:SECRET@host/v1\n");
  const width = reembedRefusal("\n  thoughts.embedding is vector(1024) but OB1_EMBEDDING_DIM=768.\n  This tool re-embeds at the column's width.\n  (with OB1_EMBEDDING_DIMENSIONS=on …) or stop here.");
  expect("a provider that did not answer is not a configuration refusal, and its reason is masked", !transient.configuration && /^The embedding provider is not usable: fetch failed http:\/\/\*\*\*@host/.test(transient.reason));
  expect("a width mismatch is a configuration refusal, named by its first line", width.configuration && width.reason.startsWith("thoughts.embedding is vector(1024)"));
  // Review pass 6: the default is configuration; only reembed's own retryable kinds promise a retry.
  const listed = reembedRefusal("Embedding configuration is not usable:\n\n  ✗ OB1_EMBEDDING_DIM=5000 exceeds pgvector's HNSW limit of 2000\n  ✗ a second problem\n");
  expect(`an unusable embedding configuration is a configuration refusal, its ✗ list joined onto its heading (${listed.reason})`, listed.configuration && listed.reason === "Embedding configuration is not usable: ✗ OB1_EMBEDDING_DIM=5000 exceeds pgvector's HNSW limit of 2000; ✗ a second problem");
  expect("a ✗ item's own full stop does not run into the join", reembedRefusal("Heading:\n\n  ✗ one.\n  ✗ two.").reason === "Heading: ✗ one; ✗ two");
  expect("a missing migration is a configuration refusal", reembedRefusal("\n  thought_work_claims does not exist. Apply migration 015 first:\n    cd db && bun migrate.ts --url …").configuration);
  expect("a provider refusing the model (404) or answering no JSON is configuration; one that timed out is retryable, as is a start that met another claimer",
    reembedRefusal("\n  The embedding provider is not usable: Embeddings request to http://h/v1 failed: 404 model not found").configuration
    && reembedRefusal("\n  The embedding provider is not usable: http://h/v1 answered 200 with a body that is not JSON").configuration
    && !reembedRefusal("\n  The embedding provider is not usable: Embeddings request to http://h/v1 timed out after 120 s (OB1_LLM_TIMEOUT)").configuration
    && !reembedRefusal("\n  The embedding provider is not usable: Embeddings request to http://h/v1 failed: 503 busy").configuration
    && !reembedRefusal("\n  Could not start the pass: deadlock detected\n  Nothing was written — run again.").configuration);
  expect("a message it does not know is taken for a configuration refusal, not promised a retry", reembedRefusal("\n  Something new went wrong.").configuration && reembedRefusal("").configuration);
  const reembedSource = readFileSync(join(REPO, "db", "reembed.ts"), "utf8") + readFileSync(join(REPO, "server-portable", "embed.ts"), "utf8");
  const gone = [...REEMBED_PHRASES.retryable, ...REEMBED_PHRASES.configShaped].filter((x) => !reembedSource.includes(x));
  expect(`every phrase the refusal kinds are read by is still in reembed's or the embedder's source (${gone.join(", ") || "all there"})`, gone.length === 0);
  const aFile = join(tmpdir(), `ob1-runner-file.${process.pid}`);
  writeFileSync(aFile, "x");
  try {
    const odd = inputState(join(aFile, "p"));
    expect(`a file where the imports directory should be is neither absent nor 'cannot search' (${JSON.stringify(odd)})`, typeof odd === "object" && odd.code === "ENOTDIR");
  } finally {
    rmSync(aFile, { force: true });
  }
  const blockedRoot = join(tmpdir(), `ob1-runner-blocked.${process.pid}`);
  mkdirSync(join(blockedRoot, "p"), { recursive: true });
  chmodSync(blockedRoot, 0o000);
  try {
    expect("an imports root the runner cannot search is 'blocked', not 'absent'", process.getuid?.() === 0 || (inputState(join(blockedRoot, "p")) === "blocked" && inputState(join(tmpdir(), "ob1-nowhere-" + process.pid)) === "absent"));
  } finally {
    chmodSync(blockedRoot, 0o700);
    rmSync(blockedRoot, { recursive: true, force: true });
  }
  expect("a missing emitter is told to go into the image by runner.Dockerfile and .dockerignore, not only to rebuild", /runner\.Dockerfile/.test(missingEmitterHelp(["x: y.py"])) && /\.dockerignore/.test(missingEmitterHelp(["x: y.py"])));
  expect("the ingester and reembed get the database, not the runner's own key", shipped.env.OB1_RUNNER_KEY === undefined && shipped.env.DATABASE_URL === "postgres://x" && shipped.asEmitter(parsePipelines(one({}))[0]).length === 0 && shipped.sweep(parsePipelines(one({}))[0]) === null);
  expect("an emitter script the image lacks is named, after a flag, after `bun run`, or bare; an inline one, a module, a present one and a URL argument are not", JSON.stringify(missingEmitters(each([
    { ...good, name: "gone", emitter: ["python3", "recipes/nowhere/emit.py", "{input}"] },
    { ...good, name: "flagged", emitter: ["python3", "-u", "recipes/nowhere/emit.py"] },
    { ...good, name: "run", emitter: ["bun", "run", "nowhere.ts"] },
    { ...good, name: "bare", emitter: ["python3", "emit.py"] },
    { ...good, name: "here", emitter: ["bun", "deploy/orchestration/runner.ts"] },
    { ...good, name: "inline", emitter: ["bun", "-e", "1"] },
    { ...good, name: "module", emitter: ["python3", "-m", "json.tool"] },
    { ...good, name: "xflag", emitter: ["python3", "-X", "utf8", "-W", "ignore", "recipes/nowhere/x.py"] },
    { ...good, name: "smol", emitter: ["bun", "--smol", "run", "deploy/orchestration/runner.ts"] },
    { ...good, name: "print", emitter: ["bun", "-p", "1"] },
    { ...good, name: "absolute", emitter: ["python3", "/app/recipes/nowhere/a.py"] },
    { ...good, name: "repomod", emitter: ["python3", "-m", "recipes.nowhere.emit"] },
    { ...good, name: "cluster", emitter: ["python3", "-um", "recipes.nowhere.clustered"] },
    { ...good, name: "inline", emitter: ["python3", "-mrecipes.nowhere.inline"] },
    { ...good, name: "noext", emitter: ["python3", "recipes/nowhere/emit"] },
    { ...good, name: "tsx", emitter: ["bun", "recipes/nowhere/emit.tsx"] },
    { ...good, name: "absinput", emitter: ["bun", "deploy/orchestration/runner.ts", "/imports/fixture"] },
    { ...good, name: "url", emitter: ["python3", "deploy/orchestration/runner.ts", "https://api.example.com/v1/export.json"] },
  ]), REPO)) === JSON.stringify(["gone: recipes/nowhere/emit.py", "flagged: recipes/nowhere/emit.py", "run: nowhere.ts", "bare: emit.py", "xflag: recipes/nowhere/x.py", "absolute: recipes/nowhere/a.py", "repomod: -m recipes.nowhere.emit", "cluster: -m recipes.nowhere.clustered", "inline: -m recipes.nowhere.inline", "noext: recipes/nowhere/emit", "tsx: recipes/nowhere/emit.tsx"]));
  const item = (system: string, scope = "fixture:export") => JSON.stringify({ identity: { system, key: "k" }, scope, text: "t" });
  const p = parsePipelines(one({}))[0];
  expect("the pipeline's own lines are not stray", strayLines(new TextEncoder().encode(`${item("fixture")}\n\n${item("fixture")}\n`), p).length === 0);
  const stray = strayLines(new TextEncoder().encode(`${item("fixture")}\n${item("linear")}\n${item("fixture", "other:scope")}\nnot json\n`), p);
  expect("another source's line and another scope's are named, a non-JSON line is left to the ingester", stray.length === 2 && /^line 2: identity.system "linear"/.test(stray[0]) && /^line 3: scope "other:scope"/.test(stray[1]));
  const t = parseTally("  items: 3 record(s) (fixture 3)\n  tier=stable  inserted 3  updated 0  patched 0  unchanged 0  skipped 0  held 0  stale 0\n");
  expect("the count line is read", t?.inserted === 3 && t.unchanged === 0 && parseTally("nothing") === null);
  expect("configFrom refuses a missing or short key", throws(() => configFrom({}), /OB1_RUNNER_KEY/) && throws(() => configFrom({ OB1_RUNNER_KEY: "short" }), /OB1_RUNNER_KEY/));
  expect("a database URL's password is read, and a URL with none is told from no URL", databasePassword("postgres://r:p%40ss@db:5432/x") === "p@ss" && databasePassword("postgres://r:@db/x") === "" && databasePassword("postgres://r@db/x") === "" && databasePassword(undefined) === null && databasePassword("not a url") === null);
  if (SU_EXEC) expect("in the image, a DATABASE_URL with no password (OB1_RUNNER_DB_PASSWORD unset) is refused, naming --init", throws(() => configFrom({ OB1_RUNNER_KEY: "k".repeat(40), DATABASE_URL: "postgres://ob1_orchestration_runner:@postgres:5432/openbrain" }, 0), /OB1_RUNNER_DB_PASSWORD.*--init/));
  if (!SU_EXEC) expect("as root without su-exec it refuses to start", throws(() => configFrom({ OB1_RUNNER_KEY: "k".repeat(40) }, 0), /without su-exec/));
  const r = (x: Partial<Report>) => statusOf({ pipeline: "p", ok: false, emitted: 0, ...x });
  expect("status follows the stage and the exit code, not the text", r({ ok: true }) === 200 && r({ stage: "emitter", exit: 3 }) === 422 && r({ stage: "one-source" }) === 422
    && r({ stage: "ingest", exit: 2 }) === 422 && r({ stage: "ingest", exit: 20, why: "exited 2" }) === 500 && r({ stage: "ingest", exit: 1 }) === 500 && r({ stage: "reembed", exit: 1 }) === 500);

  // The service, with stand-in commands: an emitter per case, an "ingester"
  // that counts stdin's lines, a reembed that says it ran and exits as told,
  // and an unembedded count the case sets.
  const dir = join(tmpdir(), `ob1-runner-self-check.${process.pid}`);
  const emit = (body: string) => ["bun", "-e", body];
  const pipelines = each([
    { ...good, name: "writes", emitter: emit(`const at = process.argv.at(-1); for (const k of ["a", "b"]) console.log(JSON.stringify({ identity: { system: "fixture", key: k }, scope: "fixture:export", text: at }))`).concat("{input}") },
    { ...good, name: "unembedded", emitter: emit(`console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "stray", emitter: emit(`console.log(${JSON.stringify(item("fixture"))}); console.log(${JSON.stringify(item("gmail"))})`) },
    { ...good, name: "fails", emitter: emit(`console.error("cannot read the export"); process.exit(3)`) },
    { ...good, name: "snoops", emitter: emit(`console.log(JSON.stringify({ identity: { system: "fixture", key: "k" }, scope: "fixture:export", text: String(process.env.DATABASE_URL ?? "") + "|" + String(process.env.OB1_RUNNER_KEY ?? "") }))`) },
    { ...good, name: "envcheck", emitter: emit(`if (process.env.HOME !== undefined || process.env.PYTHONNOUSERSITE !== "1" || process.env.HTTPS_PROXY !== undefined || process.env.https_proxy !== undefined) process.exit(5); console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "longpad", emitter: emit(`console.error("https://u:" + "P".repeat(2100) + "TAILSECRET@host/v1"); process.exit(3)`) },
    { ...good, name: "huge", emitter: emit(`console.log(JSON.stringify({ identity: { system: "s".repeat(100000), key: "k" }, scope: "fixture:export", text: "t" }))`) },
  ]);
  let ingested = 0;
  let reembedExit = 0;
  const leftWithout = new Map<string, number>([["unembedded", 1]]);
  const key = "k".repeat(40);
  const commands: Commands = {
    ingest: () => { ingested++; return ["bun", "-e", `const t = await Bun.stdin.text(); const n = t.split("\\n").filter(Boolean).length; if (t.includes("postgres://") || t.includes(${JSON.stringify(key)})) { console.error("leaked"); process.exit(9); } console.error("first text " + JSON.parse(t.split("\\n")[0]).text); console.log("  tier=stable  inserted " + n + "  updated 0  patched 0  unchanged 0  skipped 0  held 0  stale 0"); console.log("  next: bun db/reembed.ts --url … — embed the new rows")`]; },
    reembed: () => ["bun", "-e", `console.log("reembed ran"); process.exit(${reembedExit})`],
    unembedded: async (x) => leftWithout.get(x.name) ?? 0,
  };
  const config = (over: Partial<Config>): Config => ({ key, pipelines, importsDir: dir, cwd: REPO, commands, timeoutS: 30, maxBytes: 1 << 20, env: { ...process.env, DATABASE_URL: "postgres://secret@db/x", OB1_RUNNER_KEY: key }, asEmitter: () => [], asPipeline: [], sweep: () => null, probe: () => null, proxyPort: () => 0, allowLocal: true, ...over });
  const server = await serve(config({}), 0);
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (path: string, headers: Record<string, string> = { "x-runner-key": key }) => fetch(url(path), { method: "POST", headers });
  try {
    expect("health answers without a key", (await fetch(url("/health"))).status === 200);
    expect("no key is 401", (await post("/run/writes", {})).status === 401);
    expect("a wrong key is 403", (await post("/run/writes", { "x-runner-key": key.slice(0, -1) + "x" })).status === 403);
    expect("an unkeyed caller cannot tell an unknown pipeline from a known one", (await post("/run/nope", {})).status === 401);
    expect("an unknown pipeline is 404", (await post("/run/nope")).status === 404);
    const bad = await post("/run/%E0%A4%A");
    expect(`a malformed escape is 404 and JSON, not an error page (${bad.status})`, bad.status === 404 && /application\/json/.test(bad.headers.get("content-type") ?? ""));
    expect("GET on a run is 405", (await fetch(url("/run/writes"), { headers: { "x-runner-key": key } })).status === 405);
    const w = await post("/run/writes");
    const wr = await w.json() as Report;
    expect(`a run writes and reports: 200, two emitted, inserted 2, reembed ran (${w.status} ${JSON.stringify(wr).slice(0, 200)})`, w.status === 200 && wr.ok && wr.emitted === 2 && wr.counts?.inserted === 2 && wr.reembed?.exit === 0 && wr.egress === undefined);
    expect(`the emitter's {input} is the pipeline's imports directory (${wr.notes?.[0]})`, wr.notes?.[0] === `first text ${join(dir, "writes")}`);
    expect("the ingester's own `next:` line is not in the report", !wr.report?.some((l) => /next:/.test(l)));
    reembedExit = 1;
    const w1 = await post("/run/writes");
    const w1r = await w1.json() as Report;
    expect(`reembed exiting 1 (an old failed row, another pass's leases) does not fail a run whose rows all have a vector (${w1.status})`, w1.status === 200 && w1r.ok && w1r.reembed?.exit === 1);
    reembedExit = 0;
    const u = await post("/run/unembedded");
    const ur = await u.json() as Report;
    expect(`a row of the pipeline's source left without a vector fails the run even when reembed exits 0, and says how to retry (${u.status} ${ur.why})`, u.status === 500 && ur.stage === "reembed" && ur.reembed?.unembedded === 1 && /--retry-failed/.test(ur.why ?? ""));
    const before = ingested;
    const s = await post("/run/stray");
    const sr = await s.json() as Report;
    expect("a batch with another source's line is 422, refused whole, and the ingester never runs", s.status === 422 && sr.stage === "one-source" && /identity.system "gmail"/.test(sr.notes?.[0] ?? "") && ingested === before);
    const f = await post("/run/fails");
    const fr = await f.json() as Report;
    expect("an emitter that fails is 422 with its reason and exit code", f.status === 422 && fr.stage === "emitter" && fr.exit === 3 && fr.notes?.[0] === "cannot read the export");
    const ev = await post("/run/envcheck");
    expect(`the emitter's environment has no HOME, no Python user site, and no proxy when its pipeline names no host (${ev.status})`, ev.status === 200);
    const lp = await post("/run/longpad");
    const lpr = await lp.json() as Report;
    expect(`a password the 2000-character cut lands inside is masked, not left as a tail (${(lpr.notes ?? []).join(" ").slice(-40)})`, lp.status === 422 && !(lpr.notes ?? []).some((l) => /TAILSECRET|PPPP/.test(l)));
    const hg = await post("/run/huge");
    const hgr = await hg.json() as Report;
    expect(`a stray line's quoted value is cut in the report (${(hgr.notes?.[0] ?? "").length} chars)`, hg.status === 422 && (hgr.notes?.[0] ?? "").length < 300);
    const n = await post("/run/snoops");
    const nr = await n.json() as Report;
    expect(`the emitter's environment holds neither the database URL nor the key (${n.status} ${nr.why ?? ""})`, n.status === 200 && nr.ok);
  } finally {
    server.stop(true);
  }

  // The bounds on one run: a second call while one is going, a step past the
  // deadline, one that ignores SIGTERM, one that leaves a child holding its
  // pipes, and an emitter printing past the cap. None reaches the ingester.
  const bounded = each([
    { ...good, name: "slow", emitter: emit(`await Bun.sleep(1500); console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "hangs", emitter: emit(`await Bun.sleep(20000)`) },
    { ...good, name: "deaf", emitter: emit(`process.on("SIGTERM", () => {}); await Bun.sleep(30000)`) },
    { ...good, name: "twice", emitter: emit(`let n = 0; process.on("SIGTERM", () => { if (++n === 2) process.exit(0); }); await Bun.sleep(30000)`) },
    { ...good, name: "orphans", emitter: emit(`Bun.spawn(["bun", "-e", "await Bun.sleep(30000)"], { stdout: "inherit", stderr: "inherit" }).unref(); process.exit(0)`) },
    { ...good, name: "floods", emitter: emit(`const l = ${JSON.stringify(item("fixture"))} + "\\n"; for (let i = 0; i < 200; i++) process.stdout.write(l)`) },
  ]);
  const before = ingested;
  const small = await serve(config({ pipelines: bounded, timeoutS: 3, maxBytes: 2000, env: process.env }), 0);
  const at = (path: string) => fetch(`http://127.0.0.1:${small.port}${path}`, { method: "POST", headers: { "x-runner-key": key } });
  try {
    const [a, b] = await Promise.all([at("/run/slow"), Bun.sleep(300).then(() => at("/run/slow"))]);
    expect(`a second run of a pipeline already going is 409, and the first finishes (${a.status}, ${b.status})`, a.status === 200 && b.status === 409);
    const timed = async (name: string) => { const t0 = Date.now(); const res = await at(`/run/${name}`); return { res, rep: await res.json() as Report, s: (Date.now() - t0) / 1000 }; };
    const h = await timed("hangs");
    expect(`an emitter past the deadline is stopped and refused (${h.res.status}, ${h.s.toFixed(1)} s, ${h.rep.why})`, h.res.status === 422 && /ran past the run's 3 s/.test(h.rep.why ?? "") && h.s < 6);
    const tw = await timed("twice");
    expect(`a step that hands back on a second SIGTERM gets one, well before SIGKILL (${tw.s.toFixed(1)} s)`, tw.res.status === 422 && tw.s < 3 + SECOND_TERM_MS / 1000 + 2);
    const d = await timed("deaf");
    expect(`an emitter that ignores SIGTERM is killed after the grace (${d.res.status}, ${d.s.toFixed(1)} s)`, d.res.status === 422 && d.s < 3 + KILL_GRACE_MS / 1000 + 3);
    const o = await timed("orphans");
    expect(`an emitter that leaves a child holding its pipes still answers (${o.res.status}, ${o.s.toFixed(1)} s)`, o.s < DRAIN_MS / 1000 + 3);
    const again = await at("/run/orphans");
    expect(`…and its pipeline is free for the next run, not held at 409 (${again.status})`, again.status !== 409);
    const fl = await timed("floods");
    expect(`an emitter past the output cap is stopped and refused (${fl.res.status}, ${fl.rep.why})`, fl.res.status === 422 && /more than 2000 bytes/.test(fl.rep.why ?? ""));
    expect("of the bounded runs only the slow one reached the ingester", ingested === before + 1);
  } finally {
    small.stop(true);
  }

  // Review pass 4: an export the emitter's uid cannot read is refused, not a
  // green run with nothing emitted; reembed refusing to start is said as
  // that; and a runner being stopped stops its live steps.
  const four = each([
    { ...good, name: "locked", emitter: emit(`console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "refused", emitter: emit(`console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "longrun", emitter: emit(`await Bun.sleep(20000)`) },
  ]);
  const lockedDir = join(dir, "locked");
  mkdirSync(lockedDir, { recursive: true });
  const refusing = await serve(config({
    pipelines: four, env: process.env,
    commands: { ...commands, reembed: () => ["bun", "-e", `console.error("\\n  Refusing to re-embed with a model other than the one ob1_config records without --switch-model.\\n  Every vector in the corpus would be replaced.\\n  If OB1_EMBEDDING_MODEL is simply set wrong in this shell, fix it instead."); process.exit(2)`], unembedded: async (x) => (x.name === "refused" ? 3 : 0) },
    probe: (x) => (x.name === "locked" ? ["bun", "-e", "process.exit(1)"] : null),
  }), 0);
  const go = (path: string) => fetch(`http://127.0.0.1:${refusing.port}${path}`, { method: "POST", headers: { "x-runner-key": key } });
  try {
    const lk = await go("/run/locked");
    const lkr = await lk.json() as Report;
    expect(`an export its emitter's uid cannot read is 422 naming the path, not a run with nothing emitted (${lk.status} ${lkr.why})`, lk.status === 422 && /cannot read .*locked/.test(lkr.why ?? ""));
    const rf = await go("/run/refused");
    const rfr = await rf.json() as Report;
    expect(`reembed refusing to start is said as that, with its reason (the paragraph's first line, not its advice), and no "next run" promise (${rfr.why?.slice(0, 120)})`, rf.status === 500 && /reembed refused to run: Refusing to re-embed with a model other than/.test(rfr.why ?? "") && !/simply set wrong/.test(rfr.why ?? "") && !/next run/.test(rfr.why ?? ""));
    const t0 = Date.now();
    const running = go("/run/longrun");
    await Bun.sleep(500);
    await stopLive(3000);
    const lr = await running;
    expect(`a runner being stopped stops its live steps, which answer at once (${lr.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`, lr.status === 422 && Date.now() - t0 < 5000);
  } finally {
    refusing.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }

  // After every emitter step, its uid's leftovers are swept (the image kills
  // them; here a stand-in records that it ran), whether the emitter
  // succeeded or failed. And a run waiting on another pipeline's reembed
  // gives up at its own deadline (review pass 2).
  const marker = `${dir}.swept`;
  const swept = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : []);
  const two = each([
    { ...good, name: "first", emitter: emit(`console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "second", emitter: emit(`await Bun.sleep(200); console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "broken", emitter: emit(`process.exit(4)`) },
  ]);
  const waits = await serve(config({
    pipelines: two, timeoutS: 3, env: process.env,
    // A reembed that outlasts the other run's deadline: it ignores SIGTERM, so it holds the turn until SIGKILL.
    commands: { ...commands, reembed: () => ["bun", "-e", "process.on('SIGTERM', () => {}); await Bun.sleep(20000)"] },
    sweep: (x) => ["bun", "-e", `require("fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${x.name}\n`)})`],
  }), 0);
  const on = (path: string) => fetch(`http://127.0.0.1:${waits.port}${path}`, { method: "POST", headers: { "x-runner-key": key } });
  try {
    await on("/run/broken");
    const t0 = Date.now();
    const timedOn = async (path: string) => { const res = await on(path); return { res, rep: await res.json() as Report, s: (Date.now() - t0) / 1000 }; };
    const [{ res: a, rep: ar }, { res: b, rep: br, s }] = await Promise.all([timedOn("/run/first"), timedOn("/run/second")]);
    expect(`the sweep runs after every emitter step, a failed one included (${swept().join(",")})`, ["broken", "first", "second"].every((n) => swept().includes(n)));
    expect(`a run waiting on another pipeline's reembed gives up at its own deadline, and says so (${b.status}: ${br.why}; ${s.toFixed(1)} s)`, /ran out waiting for another pipeline's reembed/.test(br.why ?? "") && s < 3 + 2 && a.status === 200 && ar.ok);
  } finally {
    waits.stop(true);
    rmSync(marker, { force: true });
  }

  // SMD-2289: a pipeline's network, the egress rules, and its proxy. The
  // rules themselves are the image's, and the eval kit holds them live
  // (evals/orchestration/n8n.ts, I); here, their text.
  const net = (network: unknown) => parsePipelines(one({ network }))[0].network;
  expect("no network field, or false, is no network", net(undefined).length === 0 && net(false).length === 0);
  expect("a named host is port 443, a host:port its own port, both lower-cased", JSON.stringify(net(["API.example.com", "h.example:8443"])) === JSON.stringify([{ host: "api.example.com", port: 443 }, { host: "h.example", port: 8443 }]));
  expect("network true is refused: a pipeline names its hosts", throws(() => net(true), /name the hosts/));
  expect("an empty list, a malformed host and a port out of range are refused", throws(() => net([]), /non-empty list/) && throws(() => net(["a b"]), /"host" or "host:port"/) && throws(() => net(["h:0"]), /port 1 to 65535/) && throws(() => net(["h:70000"]), /port 1 to 65535/) && throws(() => net([7]), /"host" or "host:port"/));
  expect("a loopback or link-local name is refused (the runner's own ports, a metadata endpoint)", ["localhost", "x.localhost", "127.0.0.1:8090", "169.254.169.254", "0.0.0.0"].every((h) => throws(() => net([h]), /loopback or link-local/)));
  expect("a host named twice is refused", throws(() => net(["h.example", "H.example:443"]), /names h\.example:443 twice/));
  expect("an address spelled other than as a dotted quad is refused (127.1 and 0x7f.1 are loopback); a dotted quad and a private address are not", ["127.1:8090", "2130706433", "0x7f.1", "0x7f000001", "1.2.3", "0"].every((h) => throws(() => net([h]), /neither a DNS name nor an IPv4 address/)) && net(["10.0.0.1", "1.2.3.4:8443", "api2.example"]).length === 3);
  expect("loopback, unspecified, link-local, IPv4-compatible and metadata addresses are local, in every IPv4-mapped spelling; private and public ones are not",
    ["127.0.0.1", "127.9.9.9", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "FEBF::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "fd00:ec2::254", "100.100.100.200", "0.1.2.3"].every(isLocalAddress)
    && !["10.0.0.1", "172.17.0.1", "192.168.1.1", "100.100.100.201", "8.8.8.8", "fec0::1", "fd00:ec2::253", "2001:db8::1", "api.example.com", ""].some(isLocalAddress));
  const onNet = parsePipelines(JSON.stringify([{ ...good, name: "online", system: "online", network: ["h.example"] }, { ...good, name: "offline", system: "offline" }]));
  const rules = egressRules(onNet);
  const [uOn, uOff] = [emitterUid("online"), emitterUid("offline")];
  const accept = rules.indexOf(`meta skuid ${uOn} ip daddr 127.0.0.1 tcp dport ${uOn} accept`);
  expect(`the egress rules send every emitter uid to the refusals, open a networked pipeline's uid to its own proxy port and nothing else, before the refusals, and replace any earlier table\n${rules}`,
    rules.startsWith("table inet ob1_emitters\ndelete table inet ob1_emitters\n") && rules.includes(`meta skuid ${EMITTER_UIDS[0]}-${EMITTER_UIDS[1]} jump emitters`)
    && accept > 0 && accept < rules.indexOf("reject with tcp reset") && rules.indexOf("reject with tcp reset") < rules.indexOf("reject with icmpx") && !rules.includes(`skuid ${uOff} `) && (rules.match(/ accept$/gm) ?? []).length === 1);
  expect("with no networked pipeline, the rules open nothing", !/ accept$/m.test(egressRules(parsePipelines(one({})))));
  expect("every emitter uid is inside the range the rules close", [uOn, uOff, emitterUid("x"), emitterUid("fixture")].every((u) => u >= EMITTER_UIDS[0] && u <= EMITTER_UIDS[1]));
  expect("the capabilities the image's command drops are read from CapEff", heldEgressCaps("CapEff:\t00000000000000e0\n").length === 0 && JSON.stringify(heldEgressCaps("CapPrm:\t0\nCapEff:\t00000000000011e0\n")) === JSON.stringify(["NET_ADMIN", "SETPCAP"]) && heldEgressCaps("") .length === 0);

  // SMD-2289 part 2: an ingester Postgres refused on the password is said as that, with the fix, not as a bare exit.
  const pwFail = await serve(config({
    pipelines: [parsePipelines(one({ name: "pwfail", emitter: emit(`console.log(${JSON.stringify(item("fixture"))})`) }))[0]], env: process.env,
    commands: { ...commands, ingest: () => ["bun", "-e", `console.error('PostgresError: password authentication failed for user "ob1_orchestration_runner"'); process.exit(1)`] },
  }), 0);
  try {
    const pr = await (await fetch(`http://127.0.0.1:${pwFail.port}/run/pwfail`, { method: "POST", headers: { "x-runner-key": key } })).json() as Report;
    expect(`an ingester refused on the database password says so and how to fix it (${pr.why})`, pr.stage === "ingest" && /refused the runner's database password/.test(pr.why ?? "") && /up -d/.test(pr.why ?? ""));
  } finally {
    pwFail.stop(true);
  }

  // The proxy. Its upstream stand-in echoes what it gets, and says BYE when
  // the client has shut its write side, so a tunnel that drops a half-closed
  // client's answer is seen (review pass 1).
  const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
  const clientHello = (sni: string | null) => {
    const name = sni === null ? Buffer.alloc(0) : Buffer.from(sni);
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    const ext = sni === null ? Buffer.alloc(0) : Buffer.concat([u16(0), u16(entry.length + 2), u16(entry.length), entry]);
    const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), u16(ext.length), ext]);
    const hs = Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
    return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
  };
  // A real ClientHello, as Bun's TLS client sends it, captured by a listener that never answers.
  const captured = await new Promise<Buffer>((ok) => {
    const cap = createServer((s) => { let b = Buffer.alloc(0); s.on("data", (d: Buffer) => { b = Buffer.concat([b, d]); if (helloName(b) !== "more") { ok(b); s.destroy(); cap.close(); } }); });
    cap.listen(0, "127.0.0.1", () => { const t = tlsConnect({ host: "127.0.0.1", port: (cap.address() as { port: number }).port, servername: "api.example.com", rejectUnauthorized: false }); t.on("error", () => {}); });
  });
  const split = clientHello("x.example");
  split.writeUInt16BE(split.readUInt16BE(3) - 4, 3);
  expect(`a ClientHello's server name is read: Bun's own, one naming none, one not yet whole; a non-TLS start, a hello split across records and a truncated one are refused (${helloName(captured)})`,
    helloName(captured) === "api.example.com" && helloName(clientHello("API.Example.com.")) === "api.example.com" && helloName(clientHello(null)) === null
    && helloName(captured.subarray(0, 20)) === "more" && helloName(Buffer.from("GET / HTTP/1.1\r\n\r\n")) instanceof Error
    && String(helloName(split.subarray(0, split.length - 4))).includes("split across") && helloName(Buffer.concat([Buffer.from([0x16, 3, 1, 0, 6]), Buffer.from([1, 0, 0, 40, 3, 3])])) instanceof Error);
  // Review pass 2: extensions spliced into a hello naming x.example.
  const withExt = (extra: Buffer, sni: Buffer | null = null) => {
    const h = clientHello("x.example");
    const sniExt = sni ?? h.subarray(h.length - (4 + 2 + 3 + "x.example".length));
    const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0])]);
    const exts = Buffer.concat([sniExt, extra]);
    const all = Buffer.concat([body, u16(exts.length), exts]);
    const hs = Buffer.concat([Buffer.from([1, 0]), u16(all.length), all]);
    return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
  };
  const nameExt = (entries: Buffer, listLen = entries.length, extLen = entries.length + 2) => Buffer.concat([u16(0), u16(extLen), u16(listLen), entries]);
  const entry = (type: number, n: string) => Buffer.concat([Buffer.from([type]), u16(n.length), Buffer.from(n)]);
  expect(`a ClientHello carrying an encrypted inner hello (ECH, or draft ESNI), a second server_name, a name list that does not fill its extension, or a first entry that is not a host name is refused; a plain one reads (${helloName(withExt(Buffer.alloc(0)))})`,
    helloName(withExt(Buffer.alloc(0))) === "x.example"
    && String(helloName(withExt(Buffer.concat([u16(0xfe0d), u16(1), Buffer.from([0])])))).includes("encrypted inner") && String(helloName(withExt(Buffer.concat([u16(0xffce), u16(1), Buffer.from([0])])))).includes("encrypted inner")
    && String(helloName(withExt(nameExt(entry(0, "y.example"))))).includes("two server_name")
    && String(helloName(withExt(Buffer.alloc(0), nameExt(Buffer.concat([entry(0, "x.example"), entry(0, "y.example")]), 12)))).includes("malformed server_name")
    && String(helloName(withExt(Buffer.alloc(0), nameExt(Buffer.concat([entry(1, "z"), entry(0, "x.example")]))))).includes("malformed server_name"));

  const echo = createServer({ allowHalfOpen: true }, (s) => { s.on("data", (d) => s.write(d)); s.on("end", () => s.end("BYE")); s.on("error", () => {}); });
  await new Promise<void>((ok) => echo.listen(0, "127.0.0.1", ok));
  const echoPort = (echo.address() as { port: number }).port;
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const gonePort = closed.port!;
  closed.stop(true);
  const helloHex = (sni: string | null) => clientHello(sni).toString("hex");

  // Through the service: a networked pipeline's emitter reaches its named
  // host (127.0.0.1 here, which only the self-check's allowLocal lets
  // through) with TLS, and nothing else; the run's report names what was refused.
  const raw = `const net = require("node:net"); const u = new URL(process.env.HTTPS_PROXY ?? "http://127.0.0.1:1"); const ask = (req) => new Promise((ok) => { let b = ""; const s = net.connect(Number(u.port), u.hostname, () => s.end(req)); s.on("data", (d) => (b += d.toString("latin1"))); s.on("close", () => ok(b)); s.on("error", () => ok(b)); });`;
  const reachesEmitter = emit(`${raw} if (!process.env.HTTPS_PROXY || process.env.https_proxy !== process.env.HTTPS_PROXY) { console.error("no proxy in the environment"); process.exit(6); }
    const t = await ask(Buffer.concat([Buffer.from("CONNECT 127.0.0.1:${echoPort} HTTP/1.1\\r\\nhost: 127.0.0.1\\r\\n\\r\\n"), Buffer.from("${helloHex(null)}", "hex"), Buffer.from("ping")]));
    const f = await ask("CONNECT elsewhere.example:443 HTTP/1.1\\r\\n\\r\\n");
    const g = await ask("GET http://127.0.0.1:${echoPort}/ HTTP/1.1\\r\\n\\r\\n");
    const h = await ask("CONNECT 127.0.0.1:${echoPort} HTTP/1.1\\r\\n\\r\\nGET / HTTP/1.1\\r\\nhost: x\\r\\n\\r\\n");
    const ok = t.startsWith("HTTP/1.1 200") && t.endsWith("pingBYE") && f.startsWith("HTTP/1.1 403") && g.startsWith("HTTP/1.1 405") && h === "HTTP/1.1 200 Connection Established\\r\\n\\r\\n";
    if (!ok) { console.error(JSON.stringify([t, f, g, h].map((x) => x.slice(-90)))); process.exit(7); }
    console.log(${JSON.stringify(item("fixture"))})`);
  const reaches: Pipeline = { ...parsePipelines(one({ name: "reaches", emitter: reachesEmitter }))[0], network: [{ host: "127.0.0.1", port: echoPort }] };
  const netted = await serve(config({ pipelines: [reaches], env: process.env }), 0);
  try {
    const rr = await fetch(`http://127.0.0.1:${netted.port}/run/reaches`, { method: "POST", headers: { "x-runner-key": key } });
    const rrr = await rr.json() as Report;
    expect(`a networked pipeline's emitter reaches its named host through its proxy with TLS, and the report names what was refused: a CONNECT elsewhere (403), a plain request (405), a tunnel that did not begin with a ClientHello (${rr.status} ${rrr.why ?? ""} ${JSON.stringify(rrr.notes ?? []).slice(0, 200)} ${JSON.stringify(rrr.egress)})`,
      rr.status === 200 && rrr.ok && rrr.emitted === 1 && rrr.egress?.length === 3
      && /^CONNECT elsewhere\.example:443: not a host reaches names \(network: 127\.0\.0\.1:\d+\)$/.test(rrr.egress[0]) && /^GET http:\/\/127\.0\.0\.1:\d+\/ HTTP\/1\.1: the runner's proxy tunnels HTTPS only/.test(rrr.egress[1])
      && /^CONNECT 127\.0\.0\.1:\d+: the tunnel did not begin with a TLS ClientHello \(not a TLS handshake\)/.test(rrr.egress[2]));
    const again = await (await fetch(`http://127.0.0.1:${netted.port}/run/reaches`, { method: "POST", headers: { "x-runner-key": key } })).json() as Report;
    expect(`each run's report names its own refusals, not an earlier run's (${again.egress?.length})`, again.egress?.length === 3);
  } finally {
    netted.stop(true);
  }

  // The proxy on its own. `up.test` resolves, through the stand-in for DNS,
  // to the echo on 127.0.0.1, after 100 ms; a proxy dialling the name rather
  // than the address it checked finds no such host.
  type Say = [number, Buffer | string | "END"];
  const session = (port: number, says: Say[], waitMs = 3000, halfOpen = false) => new Promise<{ text: string; closedAt: number }>((ok) => {
    const t0 = Date.now();
    let b = "";
    const s = tcpConnect({ port, host: "127.0.0.1", allowHalfOpen: halfOpen }, async () => { for (const [ms, what] of says) { await Bun.sleep(ms); if (s.destroyed) break; if (what === "END") s.end(); else s.write(what); } });
    const done = () => ok({ text: b, closedAt: Date.now() - t0 });
    s.on("data", (d) => (b += d.toString("latin1")));
    s.on("close", done);
    s.on("error", () => {});
    setTimeout(() => { s.destroy(); }, waitMs);
  });
  const connectTo = (host: string, port = echoPort) => `CONNECT ${host}:${port} HTTP/1.1\r\n\r\n`;
  const dns: Record<string, string[]> = { "up.test": ["127.0.0.1"], "10.9.9.9": ["127.0.0.1"], "dark.test": ["192.0.2.1"], "v6first.test": ["::1", "127.0.0.1"], "mixed.test": ["192.0.2.7", "127.0.0.1"], "empty.test": [], "slow.test": ["127.0.0.1"], "slow-empty.test": [], "late.test": ["127.0.0.1"] };
  const standIn = async (h: string) => { await Bun.sleep(h.startsWith("slow") ? 700 : h === "late.test" ? 300 : 100); if (!dns[h]) throw new Error("no such host"); return dns[h]; };
  const own = await startProxy({ ...reaches, network: ["up.test", "10.9.9.9", "dark.test", "v6first.test", "empty.test", "slow.test", "slow-empty.test"].map((host) => ({ host, port: echoPort })) }, 0,
    { allowLocal: true, lookup: standIn, headMs: 400, dialMs: 200, maxConnections: 4 });
  const strict = await startProxy({ ...reaches, network: [{ host: "localhost", port: echoPort }] }, 0);
  const loose = await startProxy({ ...reaches, network: [{ host: "127.0.0.1", port: gonePort }] }, 0, { allowLocal: true });
  const ok200 = "HTTP/1.1 200 Connection Established\r\n\r\n";
  try {
    expect(`the proxy listens on 127.0.0.1 alone (${own.url})`, own.url === `http://127.0.0.1:${own.port}`);
    const named = await session(own.port, [[0, connectTo("up.test")], [0, clientHello("up.test")], [0, "ping"], [50, "END"]]);
    expect(`TLS naming the named host reaches it, at the address checked, and a client that shuts its write side still gets the answer (${JSON.stringify(named.text.slice(-12))})`, named.text.startsWith(ok200) && named.text.endsWith("pingBYE") && own.take().length === 0);
    const early = await session(own.port, [[0, connectTo("up.test")], [30, clientHello("up.test")], [0, "ping"], [0, "END"]]);
    expect(`a ClientHello sent while the name is still resolving is kept, not dropped (${JSON.stringify(early.text.slice(-12))})`, early.text.endsWith("pingBYE"));
    const other = await session(own.port, [[0, connectTo("up.test")], [0, clientHello("other.example")], [0, "ping"], [0, "END"]]);
    const none = await session(own.port, [[0, connectTo("up.test")], [0, clientHello(null)], [0, "END"]]);
    const refusedSni = own.take();
    expect(`a ClientHello naming another server, or none, closes the tunnel before anything reaches the host, and is named (${JSON.stringify(refusedSni)})`,
      other.text === ok200 && none.text === ok200 && refusedSni.length === 2 && /^CONNECT up\.test:\d+: the TLS ClientHello names other\.example, not up\.test$/.test(refusedSni[0]) && /names no server, not up\.test$/.test(refusedSni[1]));
    const literal = await session(own.port, [[0, connectTo("10.9.9.9")], [0, clientHello(null)], [0, "ping"], [0, "END"]]);
    expect(`a named IPv4 address takes a ClientHello naming no server (${JSON.stringify(literal.text.slice(-12))})`, literal.text.endsWith("pingBYE"));
    const port2 = await session(own.port, [[0, connectTo("up.test", echoPort + 1)]]);
    expect(`a named host on a port it does not name is 403 (${port2.text.split("\r\n")[0]})`, port2.text.startsWith("HTTP/1.1 403") && /not a host reaches names/.test(own.take()[0] ?? ""));
    const idle = await session(own.port, [[0, connectTo("up.test")], [0, clientHello("up.test")], [700, "late"], [0, "END"]]);
    expect(`an open tunnel outlives the request's 400 ms bound (${JSON.stringify(idle.text.slice(-12))})`, idle.text.endsWith("lateBYE"));
    const mute = await session(own.port, []);
    expect(`a connection that sends no request is closed at the bound, and the report says so (${mute.closedAt} ms)`, mute.text === "" && mute.closedAt >= 350 && mute.closedAt < 1500 && /^a connection sent no whole request in 0\.4 s of quiet/.test(own.take()[0] ?? ""));
    // Review pass 3: a quiet cut says where the connection was, and a refused client that stays is let go without a second note.
    const slow = await session(own.port, [[0, connectTo("slow.test")]]);
    const hushed = await session(own.port, [[0, connectTo("up.test")]]);
    // Cut while its name resolves to nothing: the cut is its one note, not a "did not resolve" after it (review pass 4).
    await session(own.port, [[0, connectTo("slow-empty.test")]]);
    await Bun.sleep(400);
    const stages = own.take();
    expect(`a quiet cut says where the connection was: the proxy's own lookup and dial, the ClientHello (${JSON.stringify(stages)}; ${slow.closedAt}, ${hushed.closedAt} ms)`,
      stages.length === 3 && /^CONNECT slow\.test:\d+: resolving and dialling it took past 0\.4 s of quiet/.test(stages[0]) && /^CONNECT up\.test:\d+: no whole ClientHello in 0\.4 s of quiet/.test(stages[1])
      && /^CONNECT slow-empty\.test:\d+: resolving and dialling it took past/.test(stages[2]));
    const patient = await startProxy({ ...reaches, network: [{ host: "up.test", port: echoPort }] }, 0, { allowLocal: true, lookup: standIn, headMs: 5000 });
    try {
      const stayed = await session(patient.port, [[0, connectTo("elsewhere.test")], [1500, "x"], [300, "x"]], 3500, true);
      const once = patient.take();
      expect(`a refused client that stays is let go after a second, not held to the quiet bound, and noted once (${stayed.closedAt} ms; ${JSON.stringify(once)})`, stayed.text.startsWith("HTTP/1.1 403") && stayed.closedAt >= 1400 && stayed.closedAt < 2600 && once.length === 1);
    } finally {
      patient.close();
    }
    const empty = await session(own.port, [[0, connectTo("empty.test")]]);
    expect(`a named host that resolves to no address is 502, never dialled (${empty.text.split("\r\n")[0]})`, empty.text.startsWith("HTTP/1.1 502") && /empty\.test did not resolve/.test(own.take()[0] ?? ""));
    const ipSni = await session(own.port, [[0, connectTo("10.9.9.9")], [0, clientHello("up.test")], [0, "ping"], [0, "END"]]);
    expect(`a named IPv4 address with TLS naming another server is cut off: a CDN's address is not a way to the names it serves (${JSON.stringify(ipSni.text.slice(-12))})`, ipSni.text === ok200 && /names up\.test, not 10\.9\.9\.9$/.test(own.take()[0] ?? ""));
    const v6 = await session(own.port, [[0, connectTo("v6first.test")], [0, clientHello("v6first.test")], [0, "ping"], [0, "END"]]);
    expect(`of a name's addresses, IPv4 is dialled first (${JSON.stringify(v6.text.slice(-12))})`, v6.text.endsWith("pingBYE"));
    const dark = await session(own.port, [[0, connectTo("dark.test")]]);
    const darkNote = own.take()[0] ?? "";
    expect(`a named host that does not answer the dial is 504, named (${dark.text.split("\r\n")[0]}; ${darkNote})`, (dark.text.startsWith("HTTP/1.1 504") && /did not answer within 0\.2 s/.test(darkNote)) || (dark.text.startsWith("HTTP/1.1 502") && /unreach/i.test(darkNote)));
    const held = await Promise.all([0, 1, 2, 3, 4].map((i) => session(own.port, [[i * 20, ""]], 250)));
    expect(`the proxy holds ${4} connections at once and closes the next, and the report says so (${held.map((h) => h.closedAt).join(", ")} ms)`, held.filter((h) => h.closedAt < 150).length === 1 && held.filter((h) => h.closedAt >= 240).length === 4 && own.take().some((x) => /past the proxy's 4 at once/.test(x)));
    // A named host that never closes and never answers: a half-closed tunnel to it is let go after the quiet bound, and a client that resets takes its upstream with it (review pass 2).
    // It reads, but never answers and keeps its own side open whatever the proxy does, so what is counted is each tunnel it saw end (a FIN, a reset or a close).
    let silentEnds = 0;
    let silentConns = 0;
    const silent = createServer({ allowHalfOpen: true }, (x) => { silentConns++; let seen = false; const count = () => { if (!seen) { seen = true; silentEnds++; } }; x.resume(); x.on("end", count); x.on("error", count); x.on("close", count); });
    await new Promise<void>((ok) => silent.listen(0, "127.0.0.1", ok));
    const silentPort = (silent.address() as { port: number }).port;
    // A named host that ends its side first and still reads: what the client sends after that must arrive.
    let lateBytes = "";
    const shut = createServer({ allowHalfOpen: true }, (x) => { x.once("data", () => x.end("BYE")); x.on("data", (d) => (lateBytes += d.toString("latin1"))); x.on("error", () => {}); });
    await new Promise<void>((ok) => shut.listen(0, "127.0.0.1", ok));
    const shutPort = (shut.address() as { port: number }).port;
    const tight = await startProxy({ ...reaches, network: [{ host: "up.test", port: silentPort }, { host: "up.test", port: shutPort }, { host: "late.test", port: silentPort }] }, 0, { allowLocal: true, lookup: standIn, headMs: 600, maxConnections: 8 });
    const screened = await startProxy({ ...reaches, network: [{ host: "mixed.test", port: echoPort }] }, 0, { lookup: standIn });
    try {
      // Eight clients send the request and the ClientHello in one write and shut their write side 20 ms in, while late.test is still resolving (300 ms): each end must still reach the host. Bun hands a paused socket's end on at once only when nothing is buffered, so the hello must not trail in a read of its own (review pass 4: sent apart, the fix's mutant survived 2 of 5 runs under load).
      const halves = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(() => session(tight.port, [[0, Buffer.concat([Buffer.from(connectTo("late.test", silentPort)), clientHello("late.test")])], [20, "END"]], 3000)));
      await Bun.sleep(100);
      const sawEnds = silentEnds;
      const after = await session(tight.port, [[0, connectTo("up.test", silentPort)]], 400);
      expect(`a half-closed tunnel to a host that never closes is let go after the quiet bound, its end passed on, and the proxy's connections freed (closed after ${halves.map((h) => h.closedAt).join(", ")} ms; the host saw ${sawEnds} end; the next request ${JSON.stringify(after.text.split("\r\n")[0])})`,
        halves.every((h) => h.closedAt >= 600 && h.closedAt < 2500) && sawEnds === 8 && after.text.startsWith(ok200));
      tight.take();
      await Bun.sleep(100);
      const reset = tcpConnect(tight.port, "127.0.0.1", () => reset.write(Buffer.concat([Buffer.from(connectTo("up.test", silentPort)), clientHello("up.test")])));
      reset.on("error", () => {});
      await Bun.sleep(300);
      const endsBefore = silentEnds;
      reset.resetAndDestroy();
      await Bun.sleep(150);
      expect(`a client that resets takes its upstream with it (the host saw ${silentEnds - endsBefore} end)`, silentEnds - endsBefore === 1);
      const shutSaid = await session(tight.port, [[0, connectTo("up.test", shutPort)], [0, clientHello("up.test")], [150, "more"], [50, "END"]], 1500, true);
      await Bun.sleep(100);
      expect(`a host that ends its side first still gets what the client sends after (${JSON.stringify(shutSaid.text.slice(-3))}, it read ${JSON.stringify(lateBytes.slice(-4))})`, shutSaid.text.endsWith("BYE") && lateBytes.endsWith("more"));
      const connsBefore = silentConns;
      const gone = tcpConnect(tight.port, "127.0.0.1", () => gone.write(connectTo("up.test", silentPort)));
      gone.on("error", () => {});
      await Bun.sleep(20);
      gone.resetAndDestroy();
      await Bun.sleep(250);
      expect(`a client gone while its name resolves is not dialled for (${silentConns - connsBefore} dialled)`, silentConns === connsBefore);
      // The client stays silent, half-open; a write it sends at 1.3 s is reset only if the proxy has let the tunnel go (its bound here is 600 ms).
      const silentClient = await session(tight.port, [[0, connectTo("up.test", shutPort)], [0, clientHello("up.test")], [1300, "x"], [200, "x"]], 3500, true);
      expect(`a host that ends first while its client stays silent is let go after the quiet bound (the client's late write reset at ${silentClient.closedAt} ms)`, silentClient.text.endsWith("BYE") && silentClient.closedAt >= 1250 && silentClient.closedAt < 2800);
      const mixed = await session(screened.port, [[0, connectTo("mixed.test")]]);
      expect(`a name whose answer mixes a public address with a loopback one is refused (${mixed.text.split("\r\n")[0]})`, mixed.text.startsWith("HTTP/1.1 403") && /mixed\.test resolves to 127\.0\.0\.1/.test(screened.take()[0] ?? ""));
    } finally {
      tight.close();
      screened.close();
      silent.close();
      shut.close();
    }
    const lo = await session(strict.port, [[0, connectTo("localhost")]]);
    expect(`a named host that resolves to a loopback address is refused (${lo.text.split("\r\n")[0]})`, lo.text.startsWith("HTTP/1.1 403") && /resolves to (127\.0\.0\.1|::1), a loopback, link-local or metadata address/.test(strict.take()[0] ?? ""));
    const down = await session(loose.port, [[0, connectTo("127.0.0.1", gonePort)]]);
    expect(`a named host that refuses the dial is 502, named (${down.text.split("\r\n")[0]})`, down.text.startsWith("HTTP/1.1 502") && /^CONNECT 127\.0\.0\.1:\d+: /.test(loose.take()[0] ?? ""));
    for (let i = 0; i < REFUSALS_SHOWN + 5; i++) await session(strict.port, [[0, connectTo(`x${i}.example`, 443)]]);
    const many = strict.take();
    expect(`one report lists ${REFUSALS_SHOWN} refusals and counts the rest, and take() clears them (${many.length}: ${many.at(-1)})`, many.length === REFUSALS_SHOWN + 1 && many.at(-1) === "…and 5 more" && strict.take().length === 0);
    const long = await session(strict.port, [[0, "A".repeat(9000)]]);
    const whole = await session(strict.port, [[0, `CONNECT localhost:${echoPort} HTTP/1.1\r\nx-pad: ${"a".repeat(9000)}\r\n\r\n`]]);
    expect(`a request past 8 KB of headers is refused, not buffered, whether or not its end has arrived (${long.text.split("\r\n")[0]}; whole, in one write: ${whole.text.split("\r\n")[0]})`, long.text.startsWith("HTTP/1.1 431") && whole.text.startsWith("HTTP/1.1 431"));
  } finally {
    own.close();
    strict.close();
    loose.close();
    echo.close();
  }

  for (const x of fails) console.error(`FAIL ${x}`);
  console.log(fails.length ? `runner self-check: ${fails.length} failed` : "runner self-check: OK");
  return fails.length ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());

// The image's build: every emitter the baked allowlist names is in the image (runner.Dockerfile).
if (import.meta.main && process.argv.includes("--check-emitters")) {
  // Said plainly in the build log, not as a stack (review pass 6).
  let missing: string[];
  try { missing = missingEmitters(loadPipelines(), REPO); } catch (e) { console.error(`runner: ${(e as Error).message}`); process.exit(1); }
  if (missing.length) console.error(`runner: ${missingEmitterHelp(missing)}`);
  process.exit(missing.length ? 1 : 0);
}

// The image's command, as root and before the runner starts: the egress rules for the allowlist it mounts (runner.Dockerfile, SMD-2289).
if (import.meta.main && process.argv.includes("--egress")) {
  let pipelines: Pipeline[] = [];
  try { pipelines = loadPipelines(); } catch (e) { await refuseStart((e as Error).message); }
  // Both, before anything is set: without SETPCAP the setpriv that follows fails at once, and the container restarts in a hot loop.
  const held = heldEgressCaps();
  if (held.length < 2) await refuseStart(`the image's command needs NET_ADMIN and SETPCAP at start (compose cap_add), to set the egress rules that close emitters' network and then drop both; it holds ${held.length ? `only ${held[0]}` : "neither"}`);
  const nft = Bun.spawnSync(["nft", "-f", "-"], { stdin: new TextEncoder().encode(egressRules(pipelines)), stdout: "pipe", stderr: "pipe" });
  if (nft.exitCode !== 0) await refuseStart(`could not set the egress rules that close emitters' network (nft: ${nft.stderr.toString().trim().split("\n")[0] || `exit ${nft.exitCode}`}): does the engine's kernel have nf_tables?`);
  const opened = pipelines.filter((p) => p.network.length);
  console.log(`runner: emitter uids ${EMITTER_UIDS[0]}–${EMITTER_UIDS[1]} have no network${opened.length ? `, but for each networked pipeline's proxy: ${opened.map((p) => `${p.name} → ${p.network.map((h) => `${h.host}:${h.port}`).join(", ")}`).join("; ")}` : ""}`);
  process.exit(0);
}

if (import.meta.main) {
  let c!: Config;
  try {
    c = configFrom(process.env);
  } catch (e) {
    await refuseStart((e as Error).message);
  }
  const root = process.getuid?.() === 0;
  if (root) {
    const held = heldEgressCaps();
    if (held.length) await refuseStart(`started holding ${held.join(" and ")}, which the image's command drops once it has closed emitters' network: start the runner with its image's command (runner.Dockerfile), not another`);
    const reach = await emittersReach();
    // An engine whose user namespace does not map the emitter uids fails here, as su-exec: setgroups(59999): Invalid argument (review pass 5), so the refusal names the range.
    if (reach instanceof Error) await refuseStart(`could not ask whether an emitter uid has network: ${reach.message}. Emitters run as uids ${EMITTER_UIDS[0]}–${EMITTER_UIDS[1]}, which the engine's user namespace must map (a 65536-uid range does)`);
    if (reach === "reached") await refuseStart(`an emitter uid reached a port of the runner's on 127.0.0.1: the egress rules that close emitters' network are not in place. The image's command sets them (runner.Dockerfile); start the runner with it`);
  }
  if (!existsSync(c.importsDir)) console.error(`runner: ${c.importsDir} does not exist; every emitter will find no export`);
  let s!: Awaited<ReturnType<typeof serve>>;
  try { s = await serve(c); } catch (e) { await refuseStart(`could not listen: ${(e as Error).message}`); }
  console.log(`runner: listening on :${s.port}, ${c.pipelines.length} pipeline(s)${c.pipelines.length ? `: ${c.pipelines.map((p) => `${p.name} (uid ${emitterUid(p.name)}${p.network.length ? `, network ${p.network.map((h) => `${h.host}:${h.port}`).join(", ")} through its proxy` : ""})`).join(", ")}` : " (none converted yet — deploy/orchestration/pipelines.json)"}`);
  if (root) {
    // An emitter's files in /tmp are its own.
    process.umask(0o077);
    console.log(`runner: each emitter runs as its pipeline's uid with no network but its proxy, the pipeline as ${PIPELINE_USER}`);
  } else {
    console.error("runner: not root, so every emitter runs as this user, can read the runner's environment and has its network — the runner's image runs it as root to separate them");
  }
  // New requests are refused at once; a step still running is stopped the way a deadline stops it, so reembed hands its leases back (review pass 4).
  const stop = async () => {
    s.stop(true);
    // Said, so a run the stop cut off leaves a trace here as well as a 502 at the door (review pass 5).
    if (live.size) console.error(`runner: stopping; ${live.size} running step(s) stopped, and the run(s) they belong to get no report`);
    await stopLive();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
