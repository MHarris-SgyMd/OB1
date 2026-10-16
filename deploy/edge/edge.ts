// The edge proxy (SMD-2876): one origin in front of several brains, each its own compose project, reached through
// its published port and never its networks (docs/one-brain-per-stack.md). This reads the registry — the edge's
// port and domain, and each brain's name and published port — renders the edge's route table from it, picks the
// edge's shape for the runtime, and runs deploy/edge/compose.yaml as project ob1-edge.
//
//   bun --no-env-file deploy/edge/edge.ts check  [--registry PATH] [--runtime docker|podman] [--shape bridge|host]
//   bun --no-env-file deploy/edge/edge.ts render [--registry PATH] [--shape bridge|host]
//   bun --no-env-file deploy/edge/edge.ts up     [--registry PATH] [--runtime docker|podman] [--shape bridge|host]
//   bun --no-env-file deploy/edge/edge.ts down   [--runtime docker|podman]
//   bun deploy/edge/edge.ts --self-check
//
// The registry is deploy/edge/brains.local.yaml unless --registry names another (deploy/edge/brains.example.yaml
// says what it holds). Each brain is served at http://<name>.<domain>:<port>, routed by host, so its /mcp, its
// discovery documents and its authorization server stay its own; an unknown host is the edge's 404, and any 502 —
// a brain that is down, or one whose own proxy answers 502 — is a bare 404 on that brain's host alone. The edge
// holds no key: a client's own passes through. The domain is localhost or under it: the edge listens on loopback
// alone, and a name another resolver answers would carry a client's key off the box in the clear.
//
// The shape (deploy/edge/compose.yaml says why there are two): podman machine is `bridge`, Docker Engine on Linux
// `host`, each measured (2026-10-09, 2026-10-15); any other runtime — Docker Desktop, a rootless engine, podman on
// Linux — is refused until --shape names one, since neither was measured there.
//
// --no-env-file: compose is run with the edge's settings alone — no env file (`--env-file /dev/null`), and none of
// the shell's COMPOSE_* or EDGE_* — but Bun would load a .env in the working directory into this script, and
// deploy/.env holds a brain's secrets. Run without it, `check`, `up` and `down` refuse, naming the command.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { PS_ARGS, bunEnvProblem, containersIn, holds, listens, reason, shellQuote } from "../instance.ts";

const HERE = import.meta.dir;
const COMPOSE = join(HERE, "compose.yaml");
const ROUTES_DIR = join(HERE, "dynamic");
const PROJECT = "ob1-edge";
const DEFAULT_REGISTRY = join(HERE, "brains.local.yaml");
const USAGE = `usage: bun --no-env-file deploy/edge/edge.ts check|render|up [--registry PATH] [--runtime docker|podman] [--shape bridge|host]
       bun --no-env-file deploy/edge/edge.ts down [--runtime docker|podman]
       bun deploy/edge/edge.ts --self-check`;

export type Shape = "bridge" | "host";
export const SHAPES: Shape[] = ["bridge", "host"];
/** Where each shape dials a brain's loopback port: podman's name for the host from a container, written rooted so
 *  no search domain is tried for it (deploy/compose.yaml's rule; it is in the container's /etc/hosts, measured), or
 *  the host's own loopback. */
export const DIAL: Record<Shape, string> = { bridge: "host.containers.internal.", host: "127.0.0.1" };
/** The entrypoints a router takes: the host shape listens on both loopbacks, so no other process holds [::1]:port
 *  and takes the clients that try it first (a *.localhost name resolves to ::1 first, measured); podman machine
 *  publishes one port on one of them alone (it refuses the second, measured). */
export const ENTRYPOINTS: Record<Shape, string> = { bridge: "web", host: "web, web6" };
export type Registry = { port: number; pingPort: number; domain: string; brains: { name: string; port: number }[] };

const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Words YAML 1.1 reads as a boolean or a null, which a router or service name in the table would become. */
const YAML_WORDS = new Set(["y", "n", "yes", "no", "on", "off", "true", "false", "null"]);
const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/** The registry's text read, or every way it is not one. */
export function parseRegistry(text: string): { registry?: Registry; problems: string[] } {
  const problems: string[] = [];
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return { problems: [`does not parse as YAML: ${(e as Error).message}`] }; }
  if (!isMapping(doc)) return { problems: ["is not one YAML mapping"] };
  for (const k of Object.keys(doc)) if (k !== "edge" && k !== "brains") problems.push(`${k}: not a key the edge reads (edge, brains)`);
  const edge = doc.edge ?? {};
  if (!isMapping(edge)) problems.push("edge: not a mapping");
  const e = isMapping(edge) ? edge : {};
  for (const k of Object.keys(e)) if (!["port", "ping_port", "domain"].includes(k)) problems.push(`edge.${k}: not a key the edge reads (port, ping_port, domain)`);
  const port = e.port ?? 8090;
  if (!isPort(port)) problems.push(`edge.port: ${JSON.stringify(port)} is not a port (1-65535)`);
  const pingPort = e.ping_port ?? (isPort(port) ? port + 1 : 0);
  if (!isPort(pingPort)) problems.push(e.ping_port === undefined ? `edge.ping_port: unset, so one above edge.port, ${port as number + 1}, which is not a port — set it` : `edge.ping_port: ${JSON.stringify(pingPort)} is not a port (1-65535)`);
  else if (pingPort === port) problems.push("edge.ping_port: the edge's own port, where its ping would be a route");
  const domain = e.domain ?? "localhost";
  // The domain and each name go into a Host rule in a table Traefik renders as a Go template, so neither holds
  // anything but a host name's characters: no backtick, brace, quote or space.
  if (typeof domain !== "string" || domain.length > 200 || !domain.split(".").every((l) => LABEL.test(l))) problems.push(`edge.domain: ${JSON.stringify(domain)} is not a lower-case host name (letters, digits, hyphens, dots)`);
  else if (domain !== "localhost" && !domain.endsWith(".localhost")) problems.push(`edge.domain: ${domain} is not localhost or a name under it — the edge listens on loopback alone, and a name another resolver answers would send a client's key off the box over plain HTTP`);
  const brains: Registry["brains"] = [];
  if (!isMapping(doc.brains) || Object.keys(doc.brains).length === 0) problems.push("brains: names no brain");
  else for (const [name, def] of Object.entries(doc.brains)) {
    if (!NAME.test(name)) { problems.push(`brains.${JSON.stringify(name)}: a brain's name is lower-case letters, digits and hyphens, starting with a letter, as one label of a host name`); continue; }
    if (YAML_WORDS.has(name)) { problems.push(`brains.${name}: a word YAML reads as a boolean or a null, which the edge's table would name its router and service — choose another`); continue; }
    if (!isMapping(def)) { problems.push(`brains.${name}: not a mapping (port: N)`); continue; }
    for (const k of Object.keys(def)) if (k !== "port") problems.push(`brains.${name}.${k}: not a key the edge reads (port)`);
    if (!isPort(def.port)) { problems.push(`brains.${name}.port: ${JSON.stringify(def.port)} is not a port (1-65535) — the brain's SERVER_PORT`); continue; }
    if (def.port === port || def.port === pingPort) problems.push(`brains.${name}.port: ${def.port} is the edge's own`);
    const twin = brains.find((b) => b.port === def.port);
    if (twin) problems.push(`brains.${name}.port: ${def.port} is ${twin.name}'s too — one port is one brain`);
    brains.push({ name, port: def.port });
  }
  if (problems.length) return { problems };
  return { registry: { port: port as number, pingPort: pingPort as number, domain: domain as string, brains: brains.sort((a, b) => a.name < b.name ? -1 : 1) }, problems };
}

/** The host the table's own probe router answers at: two labels, one with an underscore, so no brain's name can take
 *  it. Its answer is noop@internal's 418, which no brain behind the edge is asked for — so `up` can tell a loaded table
 *  from Traefik's router miss without asking a brain whose own proxy may answer that same miss (review pass 2). */
export const PROBE_HOST = (domain: string) => `_edge.${domain}`;

/** The edge's route table for a registry and shape: its probe router, then a router by host per brain, its two middlewares, its service at the shape's dial host. No comment: Traefik renders the file as a Go template first. */
export function renderRoutes(r: Registry, shape: Shape): string {
  const probe = `    _edge-probe:\n      rule: "Host(\`${PROBE_HOST(r.domain)}\`)"\n      entryPoints: [${ENTRYPOINTS[shape]}]\n      service: noop@internal\n`;
  const routers = probe + r.brains.map((b) => `    ${b.name}:\n      rule: "Host(\`${b.name}.${r.domain}\`)"\n      entryPoints: [${ENTRYPOINTS[shape]}]\n      middlewares: [edge-strip, brain-absent]\n      service: ${b.name}\n`).join("");
  const services = r.brains.map((b) => `    ${b.name}:\n      loadBalancer:\n        servers:\n          - url: "http://${DIAL[shape]}:${b.port}"\n`).join("");
  return "http:\n  routers:\n" + routers
    + "  middlewares:\n"
    + "    edge-strip:\n      headers:\n        customRequestHeaders:\n          X-Brain-Forwarder: \"\"\n          X-OB1-Legacy-Route: \"\"\n"
    + "    brain-absent:\n      errors:\n        status: [\"502\"]\n        service: noop@internal\n        statusRewrites:\n          \"502\": 404\n"
    + "  services:\n" + services;
}

/** What the runtime is, as far as the shape turns on it. */
export type Facts = { runtime: string; platform: string; engine: "podman" | "docker" | "unknown"; rootless: boolean; desktop: boolean; osType: string };

/** The shape measured for these facts, or why none was. */
export function decideShape(f: Facts): { shape?: Shape; why: string } {
  if (f.engine === "podman" && f.platform === "darwin" && !f.rootless) return { shape: "bridge", why: "podman machine on macOS, rootful: the bridge shape, dialling host.containers.internal" };
  if (f.engine === "docker" && f.platform === "linux" && f.osType === "linux" && !f.desktop && !f.rootless) return { shape: "host", why: "Docker Engine on Linux, rootful: the host shape, on the host's loopback" };
  const what = f.engine === "unknown" ? `${f.runtime}, whose engine did not say what it is` : `${f.engine === "podman" ? "podman" : f.desktop ? "Docker Desktop" : "Docker Engine"}${f.rootless ? ", rootless," : ""} on ${f.platform}`;
  return { why: `${what}: no shape of the edge was measured there (deploy/edge/compose.yaml) — name one with --shape bridge or --shape host, and check that each brain answers through it` };
}

/** The facts in a runtime's own words: `podman info --format json`, or docker's `version --format '{{json .Server}}'` and `info --format '{{json .}}'`. */
export function factsFrom(runtime: string, platform: string, info: string, version = ""): Facts {
  if (runtime === "podman") {
    const i = JSON.parse(info) as { host?: { security?: { rootless?: boolean }; os?: string } };
    return { runtime, platform, engine: "podman", rootless: i.host?.security?.rootless === true, desktop: false, osType: i.host?.os ?? "" };
  }
  const server = JSON.parse(version || "null") as { Components?: { Name?: string }[] } | null;
  const i = JSON.parse(info) as { OperatingSystem?: string; OSType?: string; SecurityOptions?: string[] };
  const podman = (server?.Components ?? []).some((c) => /podman/i.test(c.Name ?? ""));
  return { runtime, platform, engine: podman ? "podman" : "docker", rootless: (i.SecurityOptions ?? []).some((s) => /rootless/.test(s)), desktop: /docker desktop/i.test(i.OperatingSystem ?? ""), osType: i.OSType ?? "" };
}

/** The facts of a runtime, from its own `info` and `version`. */
function factsOf(runtime: string): Facts | string {
  const run = (args: string[]) => { const r = Bun.spawnSync([runtime, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const v = runtime === "podman" ? { ok: true, out: "", err: "" } : run(["version", "--format", "{{json .Server}}"]);
  if (!v.ok) return `${runtime} version failed: ${reason(v.err)}`;
  const i = runtime === "podman" ? run(["info", "--format", "json"]) : run(["info", "--format", "{{json .}}"]);
  if (!i.ok) return `${runtime} info failed: ${reason(i.err)}`;
  try { return factsFrom(runtime, process.platform, i.out, v.out); } catch { return `${runtime} info did not read as JSON`; }
}

/** The environment compose runs in: the shell's, but for anything that would steer compose or the edge's settings, and then the edge's. */
export function composeEnv(env: Record<string, string | undefined>, r: Registry, sha: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(COMPOSE_|EDGE_)/.test(k)) out[k] = v;
  return { ...out, EDGE_PORT: String(r.port), EDGE_PING_PORT: String(r.pingPort), EDGE_ROUTES_SHA256: sha };
}

/** Each shape's service in deploy/edge/compose.yaml. */
export const SERVICE: Record<Shape, string> = { bridge: "edge", host: "edge-host" };

/** An edge container: its service, its state, and the host addresses it holds (its `ob1.edge-addresses` label, `127.0.0.1:8090,[::1]:8090,…`). */
export type Edge = { service: string; state: string; addresses: string[] };
export function edgesIn(listing: string): Edge[] {
  return listing.split("\n").filter((l) => l.includes("|")).map((l) => {
    const [service = "", state = "", addresses = ""] = l.split("|");
    return { service, state: state.toLowerCase(), addresses: addresses.split(",").map((a) => a.trim()).filter(Boolean) };
  });
}
const EDGE_PS = ["ps", "-a", "--filter", `label=com.docker.compose.project=${PROJECT}`, "--format", '{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Label "ob1.edge-addresses"}}'];

/** The host addresses a shape takes for a registry, each with the registry key that sets it: compose.yaml's labels in the same order. */
export function edgeAddresses(r: Registry, shape: Shape): [string, string][] {
  return shape === "bridge" ? [[`127.0.0.1:${r.port}`, "edge.port"]]
    : [[`127.0.0.1:${r.port}`, "edge.port"], [`[::1]:${r.port}`, "edge.port"], [`127.0.0.1:${r.pingPort}`, "edge.ping_port"]];
}

/**
 * The addresses to ask before an up, each refused if anything answers: the shape's own, and in the bridge shape [::1]
 * at its port, which it cannot hold (podman machine publishes one loopback alone), so anything there would take every
 * client that tries ::1 first, its key with it. An address a running edge's label holds — this shape's or the other,
 * which up removes first — is skipped: the edge itself answers there, and lets go of it.
 */
export function addressesToAsk(r: Registry, shape: Shape, edges: Edge[]): [string, string][] {
  const held = new Set(edges.filter((e) => e.state === "running").flatMap((e) => e.addresses));
  const want: [string, string][] = shape === "bridge" ? [...edgeAddresses(r, shape), [`[::1]:${r.port}`, "edge.port"]] : edgeAddresses(r, shape);
  return want.filter(([a]) => !held.has(a));
}

/** The other shape's edge containers, in any state: compose treats none as an orphan (its profile is not named), so up removes them first. */
export const othersOf = (shape: Shape, edges: Edge[]) => [...new Set(edges.filter((e) => e.service === SERVICE[SHAPES.find((s) => s !== shape)!]).map((e) => e.service))];

/** A --shape that was measured not to work on these facts: the host shape under podman machine listens in the VM, where the Mac cannot reach it. */
export function forcedShapeProblem(f: Facts, shape: Shape): string {
  return shape === "host" && f.engine === "podman" && f.platform === "darwin" ? "--shape host under podman machine: the edge would listen on the VM's loopback, which the Mac cannot reach (measured) — use the bridge shape" : "";
}

/** What publishes a brain's port, from the runtime's container list: a compose project's service, or nothing. */
export function holderOf(listing: string, port: number): string {
  const c = containersIn(listing).find((x) => x.state === "running" && holds(x.ports, { hostIp: "127.0.0.1", port, protocol: "tcp" }));
  return c ? `is published by ${c.name}, of project ${c.project || "(none)"}` : "";
}

const composeArgs = (runtime: string, profiles: string[], extra: string[]) => [runtime, "compose", "--env-file", "/dev/null", "-p", PROJECT, "-f", COMPOSE, ...profiles.flatMap((p) => ["--profile", p]), ...extra];

type Options = { registry: string; runtime: string; shape?: Shape };
function options(cmd: string, args: string[]): Options {
  const o: Options = { registry: DEFAULT_REGISTRY, runtime: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    const value = () => { if (v === undefined || v.startsWith("-") || !v.trim()) { console.error(`${a} takes a value.`); process.exit(2); } i++; return v; };
    if (a === "--registry" && cmd !== "down") o.registry = resolve(value());
    else if (a === "--runtime" && cmd !== "render") o.runtime = value();
    else if (a === "--shape" && cmd !== "down") { const s = value(); if (!SHAPES.includes(s as Shape)) { console.error(`--shape takes bridge or host, not ${s}.`); process.exit(2); } o.shape = s as Shape; }
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(2); }
  }
  if (o.runtime && o.runtime !== "docker" && o.runtime !== "podman") { console.error(`--runtime takes docker or podman, not ${o.runtime}.`); process.exit(2); }
  if (o.runtime && !Bun.which(o.runtime)) { console.error(`--runtime ${o.runtime} is not on PATH.`); process.exit(2); }
  if (!o.runtime && cmd !== "render") o.runtime = ["docker", "podman"].find((r) => Bun.which(r)) ?? "";
  if (!o.runtime && cmd !== "render") { console.error("neither docker nor podman is on PATH."); process.exit(2); }
  return o;
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) { console.error(`no registry at ${path} — copy deploy/edge/brains.example.yaml there and name your brains, or give --registry PATH`); process.exit(2); }
  const { registry, problems } = parseRegistry(readFileSync(path, "utf8"));
  if (!registry) { console.error(`${path}:\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(2); }
  return registry;
}

function shapeFor(o: Options): { shape: Shape; why: string } {
  const facts = factsOf(o.runtime);
  if (o.shape) {
    const problem = typeof facts === "string" ? "" : forcedShapeProblem(facts, o.shape);
    if (problem) { console.error(problem); process.exit(2); }
    return { shape: o.shape, why: `--shape ${o.shape}` };
  }
  if (typeof facts === "string") { console.error(facts); process.exit(2); }
  const d = decideShape(facts);
  if (!d.shape) { console.error(d.why); process.exit(2); }
  return { shape: d.shape, why: d.why };
}

const spawn = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() }; };

/** Whether this host can listen on an address at all: the host shape listens on [::1], which a host with IPv6 off has not. */
function canListen(host: string): Promise<boolean> {
  return new Promise((ok) => {
    const s = net.createServer();
    s.once("error", () => ok(false));
    s.listen(0, host, () => s.close(() => ok(true)));
  });
}

/**
 * Each address the edge would take (addressesToAsk), refused when something not the edge answers there; in the host
 * shape, refused too when this host has no [::1] at all. Each brain's port is noted: what publishes it, or that
 * nothing answers.
 */
async function ports(o: Options, r: Registry, shape: Shape, edges: Edge[]): Promise<{ refusals: string[]; notes: string[] }> {
  const refusals: string[] = [];
  if (shape === "host" && !(await canListen("::1"))) refusals.push("this host has no [::1] (IPv6 is off), where the host shape listens beside 127.0.0.1 so no other process takes the clients that try ::1 first: turn IPv6 on for loopback");
  for (const [address, key] of addressesToAsk(r, shape, edges)) {
    const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(address)!;
    if (await listens(m[1], Number(m[2]))) refusals.push(`${address} (${key}) already answers, and not as this edge${m[1] === "::1" ? " — a client asking <name>.localhost tries ::1 first, so it would take each client's key" : ""}: stop it, or set ${key} in the registry to a port free on both loopbacks`);
  }
  const listing = spawn([o.runtime, ...PS_ARGS]);
  const notes: string[] = [];
  for (const b of r.brains) {
    const by = listing.ok ? holderOf(listing.out, b.port) : "";
    if (by) notes.push(`${b.name}: 127.0.0.1:${b.port} ${by}`);
    else if (await listens("127.0.0.1", b.port)) notes.push(`${b.name}: 127.0.0.1:${b.port} answers, but no container of ${o.runtime} publishes it — check the registry names this brain's port`);
    else notes.push(`${b.name}: nothing answers on 127.0.0.1:${b.port} now — its host is a 404 until the brain is up`);
  }
  return { refusals, notes };
}

/** What in the table's directory Traefik's file provider would load beside the table: any other .yaml, .yml or .toml
 *  file, in any case, and any directory, which it reads down (measured on v3.7.13; a .tmp or .DS_Store it skips). */
export function strayIn(entries: { name: string; dir: boolean }[]): string[] {
  return entries.filter((e) => e.dir || (e.name !== "routes.yaml" && /\.(ya?ml|toml)$/i.test(e.name))).map((e) => e.dir ? `${e.name}/` : e.name);
}

const urls = (r: Registry) => r.brains.map((b) => `  ${b.name}: http://${b.name}.${r.domain}:${r.port}/mcp`).join("\n");

async function main(cmd: string, args: string[]) {
  const o = options(cmd, args);
  if (cmd !== "render") {
    const loaded = bunEnvProblem(process.execArgv);
    if (loaded) { console.error(`${loaded}, and deploy/.env holds a brain's secrets. Run it as: bun --no-env-file ${[process.argv[1] ?? "deploy/edge/edge.ts", cmd, ...args].map(shellQuote).join(" ")}`); process.exit(2); }
  }
  if (cmd === "down") {
    const r = Bun.spawnSync(composeArgs(o.runtime, SHAPES, ["down", "--remove-orphans"]), { env: composeEnv(process.env, { port: 8090, pingPort: 8091, domain: "localhost", brains: [] }, "down"), stdout: "inherit", stderr: "inherit" });
    process.exit(r.exitCode === 0 ? 0 : 1);
  }
  const registry = readRegistry(o.registry);
  if (cmd === "render") { process.stdout.write(renderRoutes(registry, o.shape ?? "bridge")); return; }
  const { shape, why } = shapeFor(o);
  const table = renderRoutes(registry, shape);
  const ps = spawn([o.runtime, ...EDGE_PS]);
  if (!ps.ok) { console.error(`${o.runtime} ps failed: ${reason(ps.err)}`); process.exit(2); }
  const edges = edgesIn(ps.out);
  const { refusals, notes } = await ports(o, registry, shape, edges);
  const stray = existsSync(ROUTES_DIR) ? strayIn(readdirSync(ROUTES_DIR, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))) : [];
  if (stray.length) refusals.push(`${ROUTES_DIR} holds ${stray.join(", ")} beside routes.yaml — Traefik would load each as routes no check holds: move them out`);
  console.log(`edge: ${why}`);
  for (const n of notes) console.log(`note: ${n}`);
  if (refusals.length) { for (const x of refusals) console.error(x); process.exit(2); }
  if (cmd === "check") { console.log(`the brains, through the edge:\n${urls(registry)}`); return; }
  // up: the other shape's edge goes first (a service under a profile not named is no orphan to compose), then the
  // table into the file provider's directory, readable by the edge's user (65534) whatever the umask, and written
  // only when it changed — in place, not renamed over: on podman machine a rename racing the container's recreate
  // left Traefik's file provider never started, the edge healthy and every host a 404 (3 runs in 10, measured);
  // a changed table changes the digest label, so the container is recreated on it and no half-read one serves on.
  for (const other of othersOf(shape, edges)) {
    const rm = Bun.spawnSync(composeArgs(o.runtime, SHAPES, ["rm", "-s", "-f", other]), { env: composeEnv(process.env, registry, ""), stdout: "inherit", stderr: "inherit" });
    if (rm.exitCode !== 0) { console.error(`the other shape's edge (${other}) could not be removed first`); process.exit(1); }
  }
  mkdirSync(ROUTES_DIR, { recursive: true });
  chmodSync(ROUTES_DIR, 0o755);
  const file = join(ROUTES_DIR, "routes.yaml");
  if (!existsSync(file) || readFileSync(file, "utf8") !== table) writeFileSync(file, table);
  chmodSync(file, 0o644);
  const sha = new Bun.CryptoHasher("sha256").update(table).digest("hex");
  const upWith = (extra: string[]) => Bun.spawnSync(composeArgs(o.runtime, [shape], ["up", "-d", "--remove-orphans", ...extra, "--wait", "--wait-timeout", "60"]), { env: composeEnv(process.env, registry, sha), stdout: "inherit", stderr: "inherit" });
  const logs = composeArgs(o.runtime, [shape], ["logs"]).map(shellQuote).join(" ");
  if (upWith([]).exitCode !== 0) { console.error(`the edge did not come up; its log: ${logs}`); process.exit(1); }
  // Healthy says Traefik runs, not that it serves the table: its ping passes with no provider started. So ask it,
  // and when it does not serve, recreate it once — an unchanged table would never recreate it, so an up could not
  // mend an edge whose file provider never started (review pass 2).
  let served = await servedAt(registry);
  if (served !== "served") {
    console.error(`the edge is up but ${served}: recreating it once`);
    if (upWith(["--force-recreate"]).exitCode !== 0) { console.error(`the edge did not come up; its log: ${logs}`); process.exit(1); }
    served = await servedAt(registry);
  }
  if (served !== "served") { console.error(`the edge is up but ${served} — its log: ${logs}`); process.exit(1); }
  // The bridge shape cannot hold [::1]:port: said once more now it is up, since a process may have taken it since.
  if (shape === "bridge" && await listens("::1", registry.port)) { console.error(`[::1]:${registry.port} answers, and not as this edge — a client asking <name>.localhost tries ::1 first, so it would take each client's key: stop it, then up again`); process.exit(1); }
  console.log(`the brains, through the edge:\n${urls(registry)}`);
}

/** noop@internal's answer, which only the table's probe router gives (PROBE_HOST): Traefik's router miss is a 404. */
export const PROBE_ANSWER = 418;

/** One GET of / through the edge at 127.0.0.1 with a Host: its status, or null when nothing answers within 3 s. */
function ask(port: number, host: string): Promise<number | null> {
  return new Promise((ok) => {
    const timer = setTimeout(() => { req.destroy(); ok(null); }, 3000);
    const done = (v: number | null) => { clearTimeout(timer); ok(v); };
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", headers: { host } }, (res) => {
      res.on("error", () => done(null));
      res.on("end", () => done(res.statusCode ?? null));
      res.resume();
    });
    req.on("error", () => done(null));
    req.end();
  });
}

/** Whether the edge serves the table: "served" once its probe router answers, or what it does instead after up to ten seconds (the file provider loads the table a moment after Traefik starts). Asks no brain. */
export async function servedAt(r: Registry, get = ask, tries = 20, pauseMs = 500): Promise<string> {
  const host = PROBE_HOST(r.domain);
  let last = "";
  for (let i = 0; i < tries; i++) {
    const got = await get(r.port, `${host}:${r.port}`);
    if (got === PROBE_ANSWER) return "served";
    last = got === null ? `nothing answers on 127.0.0.1:${r.port}: the edge is not reachable from this host` : got === 404 ? `its probe host ${host} is Traefik's router miss: the table is not loaded` : `its probe host ${host} answers ${got}, not the table's ${PROBE_ANSWER}`;
    if (i < tries - 1) await Bun.sleep(pauseMs);
  }
  return last;
}

async function selfCheck() {
  const example = readFileSync(join(HERE, "brains.example.yaml"), "utf8");
  const ex = parseRegistry(example).registry;
  const problems = (text: string) => parseRegistry(text).problems.join(" | ");
  const facts = (o: Partial<Facts>): Facts => ({ runtime: "docker", platform: "linux", engine: "docker", rootless: false, desktop: false, osType: "linux", ...o });
  const cases: [string, boolean][] = [
    ["the example registry reads: port 8090, ping 8091, localhost, canary and stable by name", ex?.port === 8090 && ex.pingPort === 8091 && ex.domain === "localhost" && ex.brains.map((b) => `${b.name}:${b.port}`).join(",") === "canary:8011,stable:8010"],
    ["defaults: port 8090, ping one above it, localhost", (() => { const r = parseRegistry("brains:\n  a:\n    port: 9000\n").registry; return r?.port === 8090 && r.pingPort === 8091 && r.domain === "localhost"; })()],
    ["no brain is refused", /names no brain/.test(problems("edge:\n  port: 8090\n")) && /names no brain/.test(problems("brains: {}\n"))],
    ["an unknown key is refused, at each level", /nope: not a key/.test(problems("nope: 1\nbrains:\n  a:\n    port: 9000\n")) && /edge\.bind: not a key/.test(problems("edge:\n  bind: 0.0.0.0\nbrains:\n  a:\n    port: 9000\n")) && /brains\.a\.host: not a key/.test(problems("brains:\n  a:\n    port: 9000\n    host: x\n"))],
    ["a name that is no host label is refused: upper case, a dot, a backtick, a leading digit or hyphen, a trailing hyphen", ["A", "a.b", "a`b", "1a", "-a", "a-", "a b", "{{x}}"].every((n) => /a brain's name is/.test(problems(`brains:\n  ${JSON.stringify(n)}:\n    port: 9000\n`)))],
    ["a domain that is no host name is refused: a backtick, a brace, upper case, an empty label", ["local`host", "{{.}}", "Localhost", "a..b", ""].every((d) => /edge\.domain/.test(problems(`edge:\n  domain: ${JSON.stringify(d)}\nbrains:\n  a:\n    port: 9000\n`)))],
    ["a port that is no port is refused: 0, 65536, a string, a fraction", [0, 65536, '"8010"', 8010.5].every((p) => /is not a port/.test(problems(`brains:\n  a:\n    port: ${p}\n`)))],
    ["two brains on one port are refused", /is a's too/.test(problems("brains:\n  a:\n    port: 9000\n  b:\n    port: 9000\n"))],
    ["a brain on the edge's port or its ping's is refused", /is the edge's own/.test(problems("brains:\n  a:\n    port: 8090\n")) && /is the edge's own/.test(problems("brains:\n  a:\n    port: 8091\n"))],
    ["the ping on the edge's own port is refused", /where its ping would be a route/.test(problems("edge:\n  port: 9000\n  ping_port: 9000\nbrains:\n  a:\n    port: 9001\n"))],
    ["not YAML, or not a mapping, is refused", /does not parse/.test(problems("brains: [\n")) && /not one YAML mapping/.test(problems("- a\n"))],
    ["the bridge table dials host.containers.internal, the host table 127.0.0.1, each at the brain's port", ex !== undefined && renderRoutes(ex, "bridge").includes('url: "http://host.containers.internal.:8011"') && renderRoutes(ex, "host").includes('url: "http://127.0.0.1:8010"') && !renderRoutes(ex, "host").includes("host.containers.internal")],
    ["each brain's router is its host alone, with the strip and the 404 for a brain that is down", ex !== undefined && ex.brains.every((b) => renderRoutes(ex, "bridge").includes(`    ${b.name}:\n      rule: "Host(\`${b.name}.localhost\`)"\n      entryPoints: [web]\n      middlewares: [edge-strip, brain-absent]\n      service: ${b.name}\n`))],
    ["the table is YAML Traefik reads: the probe router, a router and a service per brain, the two middlewares, nothing else", (() => { if (!ex) return false; const t = Bun.YAML.parse(renderRoutes(ex, "bridge")) as { http: { routers: object; services: object; middlewares: object } }; return Object.keys(t).join() === "http" && Object.keys(t.http.routers).join() === "_edge-probe,canary,stable" && Object.keys(t.http.services).join() === "canary,stable" && Object.keys(t.http.middlewares).join() === "edge-strip,brain-absent"; })()],
    ["the table holds no comment and no Go template", ex !== undefined && !/#|\{\{/.test(renderRoutes(ex, "bridge"))],
    ["podman machine on macOS is the bridge shape; rootless, or on Linux, is no shape", decideShape(facts({ runtime: "podman", engine: "podman", platform: "darwin" })).shape === "bridge" && decideShape(facts({ engine: "podman", platform: "darwin", rootless: true })).shape === undefined && decideShape(facts({ engine: "podman", platform: "linux" })).shape === undefined],
    ["Docker Engine on Linux is the host shape; Docker Desktop, rootless or on macOS is no shape, and says to name one", decideShape(facts({})).shape === "host" && [facts({ desktop: true }), facts({ rootless: true }), facts({ platform: "darwin" })].every((f) => { const d = decideShape(f); return d.shape === undefined && /--shape bridge or --shape host/.test(d.why); })],
    ["the docker CLI on podman machine's engine is the bridge shape", decideShape(facts({ engine: "podman", platform: "darwin", osType: "linux" })).shape === "bridge"],
    ["compose's environment drops the shell's COMPOSE_* and EDGE_* and sets the edge's own", (() => { if (!ex) return false; const e = composeEnv({ PATH: "/bin", COMPOSE_PROFILES: "host", COMPOSE_FILE: "x.yaml", EDGE_PORT: "1", EDGE_BIND: "0.0.0.0", DOCKER_HOST: "unix:///x" }, ex, "abc"); return e.PATH === "/bin" && e.DOCKER_HOST === "unix:///x" && !("COMPOSE_PROFILES" in e) && !("COMPOSE_FILE" in e) && e.EDGE_PORT === "8090" && !("EDGE_BIND" in e) && e.EDGE_PING_PORT === "8091" && e.EDGE_ROUTES_SHA256 === "abc"; })()],
    ["a domain not localhost or under it is refused; one under it reads", /not localhost or a name under it/.test(problems("edge:\n  domain: example.com\nbrains:\n  a:\n    port: 9000\n")) && /not localhost or a name under it/.test(problems("edge:\n  domain: localhost.example.com\nbrains:\n  a:\n    port: 9000\n")) && parseRegistry("edge:\n  domain: brains.localhost\nbrains:\n  a:\n    port: 9000\n").registry?.domain === "brains.localhost"],
    ["a name YAML reads as a boolean or a null is refused", ["null", "true", "false", "yes", "no", "on", "off", "y", "n"].every((n) => /a word YAML reads/.test(problems(`brains:\n  ${n}:\n    port: 9000\n`)))],
    ["the host table's routers take both loopbacks' entrypoints, the bridge table's one; the bridge dials the host's name rooted", ex !== undefined && renderRoutes(ex, "host").includes("      entryPoints: [web, web6]\n") && !renderRoutes(ex, "bridge").includes("web6") && renderRoutes(ex, "bridge").includes('url: "http://host.containers.internal.:8010"')],
    ["edge not a mapping, a port or ping that is no port, a domain not a string or too long or with an edge hyphen, a brain not a mapping: each refused", /edge: not a mapping/.test(problems("edge: 1\nbrains:\n  a:\n    port: 9000\n")) && /edge\.port: .* is not a port/.test(problems("edge:\n  port: 0\nbrains:\n  a:\n    port: 9000\n")) && /edge\.ping_port: 70000 is not a port/.test(problems("edge:\n  ping_port: 70000\nbrains:\n  a:\n    port: 9000\n")) && /edge\.domain/.test(problems("edge:\n  domain: 5\nbrains:\n  a:\n    port: 9000\n")) && /edge\.domain/.test(problems(`edge:\n  domain: ${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(30)}.localhost\nbrains:\n  a:\n    port: 9000\n`)) && /edge\.domain/.test(problems("edge:\n  domain: -a.localhost\nbrains:\n  a:\n    port: 9000\n")) && /edge\.domain/.test(problems("edge:\n  domain: a-.localhost\nbrains:\n  a:\n    port: 9000\n")) && /brains\.a: not a mapping/.test(problems("brains:\n  a:\n"))],
    ["edge.port 65535 with no ping_port says the derived ping is the trouble, and to set it", /unset, so one above edge\.port, 65536, which is not a port — set it/.test(problems("edge:\n  port: 65535\nbrains:\n  a:\n    port: 9000\n"))],
    ["a Linux engine whose OSType is not linux is no shape", decideShape(facts({ osType: "" })).shape === undefined && decideShape(facts({ osType: "windows" })).shape === undefined],
    ["podman's info reads: rootful or rootless, its OS", (() => { const f = factsFrom("podman", "darwin", '{"host":{"os":"linux","security":{"rootless":false}}}'); const r = factsFrom("podman", "darwin", '{"host":{"os":"linux","security":{"rootless":true}}}'); return f.engine === "podman" && !f.rootless && f.osType === "linux" && decideShape(f).shape === "bridge" && r.rootless && decideShape(r).shape === undefined; })()],
    ["docker's version and info read: Engine, Desktop, rootless, the podman engine behind the docker CLI", (() => {
      const engine = '{"Components":[{"Name":"Engine"},{"Name":"containerd"}]}';
      const ubuntu = '{"OperatingSystem":"Ubuntu 24.04 LTS","OSType":"linux","SecurityOptions":["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]}';
      const e = factsFrom("docker", "linux", ubuntu, engine);
      const desk = factsFrom("docker", "darwin", '{"OperatingSystem":"Docker Desktop","OSType":"linux","SecurityOptions":[]}', engine);
      const rl = factsFrom("docker", "linux", '{"OperatingSystem":"Ubuntu","OSType":"linux","SecurityOptions":["name=seccomp","name=rootless"]}', engine);
      const pm = factsFrom("docker", "darwin", '{"OperatingSystem":"fedora","OSType":"linux","SecurityOptions":["name=seccomp,profile=default","name=selinux"]}', '{"Components":[{"Name":"Podman Engine"},{"Name":"Conmon"}]}');
      return e.engine === "docker" && decideShape(e).shape === "host" && desk.desktop && decideShape(desk).shape === undefined && rl.rootless && decideShape(rl).shape === undefined && pm.engine === "podman" && decideShape(pm).shape === "bridge";
    })()],
    ["served: the probe host's 418, asked at _edge.<domain>, never a brain; a 404 (Traefik's router miss), another status or no answer is not, and says which", await (async () => {
      const r = parseRegistry("brains:\n  a:\n    port: 9000\n").registry!;
      const seen: string[] = [];
      const ok = await servedAt(r, async (port, host) => { seen.push(`${port} ${host}`); return 418; }, 3, 0);
      const miss = await servedAt(r, async () => 404, 3, 0);
      const brain = await servedAt(r, async () => 200, 3, 0);
      const none = await servedAt(r, async () => null, 3, 0);
      let n = 0;
      const late = await servedAt(r, async () => (++n < 3 ? 404 : 418), 3, 0);
      return ok === "served" && seen.every((s) => s === "8090 _edge.localhost:8090") && /router miss: the table is not loaded/.test(miss) && /answers 200, not the table's 418/.test(brain) && /nothing answers on 127\.0\.0\.1:8090/.test(none) && late === "served" && n === 3;
    })()],
    ["the table's probe router answers _edge.<domain> with noop@internal, on the shape's entrypoints, before every brain's", ex !== undefined && renderRoutes(ex, "host").startsWith("http:\n  routers:\n    _edge-probe:\n      rule: \"Host(`_edge.localhost`)\"\n      entryPoints: [web, web6]\n      service: noop@internal\n    canary:\n") && renderRoutes(ex, "bridge").includes("    _edge-probe:\n      rule: \"Host(`_edge.localhost`)\"\n      entryPoints: [web]\n")],
    ["an edge's service, state and held addresses are read from its labels", JSON.stringify(edgesIn("edge-host|running|127.0.0.1:8090,[::1]:8090,127.0.0.1:8091\nedge|Exited|127.0.0.1:8095\n\n")) === JSON.stringify([{ service: "edge-host", state: "running", addresses: ["127.0.0.1:8090", "[::1]:8090", "127.0.0.1:8091"] }, { service: "edge", state: "exited", addresses: ["127.0.0.1:8095"] }])],
    ["each shape's addresses match compose.yaml's labels", (() => { const doc = Bun.YAML.parse(readFileSync(COMPOSE, "utf8")) as { services: Record<string, { labels: Record<string, string> }> }; const r = parseRegistry("brains:\n  a:\n    port: 9000\n").registry!; return SHAPES.every((s) => doc.services[SERVICE[s]].labels["ob1.edge-addresses"].replace(/\$\{EDGE_PORT:-8090\}/g, "8090").replace(/\$\{EDGE_PING_PORT:-8091\}/g, "8091") === edgeAddresses(r, s).map(([a]) => a).join(",")); })()],
    ["addresses to ask: the shape's own and, for the bridge, [::1]; skipped only where a running edge's label holds that very address", (() => {
      const r = parseRegistry("brains:\n  a:\n    port: 9000\n").registry!;
      const ask = (s: Shape, e: Edge[]) => addressesToAsk(r, s, e).map(([a]) => a).join(",");
      const bridgeEdge: Edge = { service: "edge", state: "running", addresses: ["127.0.0.1:8090"] };
      const hostEdge: Edge = { service: "edge-host", state: "running", addresses: ["127.0.0.1:8090", "[::1]:8090", "127.0.0.1:8091"] };
      return ask("bridge", []) === "127.0.0.1:8090,[::1]:8090" && ask("host", []) === "127.0.0.1:8090,[::1]:8090,127.0.0.1:8091"
        && ask("bridge", [bridgeEdge]) === "[::1]:8090"
        && ask("host", [bridgeEdge]) === "[::1]:8090,127.0.0.1:8091"
        && ask("bridge", [hostEdge]) === "" && ask("host", [hostEdge]) === ""
        && ask("host", [{ ...hostEdge, state: "restarting" }]) === "127.0.0.1:8090,[::1]:8090,127.0.0.1:8091"
        && ask("host", [{ service: "edge-host", state: "running", addresses: ["127.0.0.1:8095", "[::1]:8095", "127.0.0.1:8090"] }]) === "[::1]:8090,127.0.0.1:8091";
    })()],
    ["the other shape's edge is removed in any state, this shape's never", othersOf("host", [{ service: "edge", state: "restarting", addresses: [] }, { service: "edge-host", state: "running", addresses: [] }]).join() === "edge" && othersOf("bridge", [{ service: "edge", state: "running", addresses: [] }]).length === 0 && othersOf("bridge", [{ service: "edge-host", state: "exited", addresses: [] }]).join() === "edge-host"],
    ["--shape host is refused under podman machine, where it was measured unreachable; allowed elsewhere", /--shape host under podman machine/.test(forcedShapeProblem(facts({ engine: "podman", platform: "darwin" }), "host")) && forcedShapeProblem(facts({ engine: "podman", platform: "darwin" }), "bridge") === "" && forcedShapeProblem(facts({ desktop: true, platform: "darwin" }), "host") === ""],
    ["a brain's port is named by the running container that publishes it, not a stopped one", holderOf("id1|open-brain-forwarder-1|127.0.0.1:8010->8000/tcp|open-brain|forwarder|running||\nid2|old-forwarder-1|127.0.0.1:8011->8000/tcp|old|forwarder|exited||\n", 8010) === "is published by open-brain-forwarder-1, of project open-brain" && holderOf("id2|old-forwarder-1|127.0.0.1:8011->8000/tcp|old|forwarder|exited||\n", 8011) === ""],
    ["strays: another YAML or TOML file in any case, or a directory; not the table, a .tmp or a .DS_Store", (() => { const f = (name: string, dir = false) => ({ name, dir }); return strayIn([f("routes.yaml"), f(".routes.123.tmp"), f(".DS_Store"), f("routes.yaml~")]).length === 0 && strayIn([f("routes.yaml"), f("old.yaml"), f("x.toml"), f("E.YML"), f(".c.yaml"), f("sub", true)]).join() === "old.yaml,x.toml,E.YML,.c.yaml,sub/"; })()],
    ["compose is run with no env file, as ob1-edge, on the edge's own file", composeArgs("docker", ["host"], ["up"]).join(" ") === `docker compose --env-file /dev/null -p ob1-edge -f ${COMPOSE} --profile host up`],
  ];
  for (const [name, ok] of cases) console.log((ok ? "ok   " : "FAIL ") + name);
  process.exit(cases.every(([, ok]) => ok) ? 0 : 1);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--self-check") await selfCheck();
  else if (cmd === "check" || cmd === "render" || cmd === "up" || cmd === "down") await main(cmd, rest);
  else { console.error(USAGE); process.exit(2); }
}
