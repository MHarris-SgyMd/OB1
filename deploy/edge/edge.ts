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
// discovery documents and its authorization server stay its own; an unknown host is the edge's 404, and a brain
// that is down is a bare 404 on its own host alone. The edge holds no key: a client's own passes through.
//
// The shape (deploy/edge/compose.yaml says why there are two): podman machine is `bridge`, Docker Engine on Linux
// `host`, each measured (2026-10-09, 2026-10-15); any other runtime — Docker Desktop, a rootless engine, podman on
// Linux — is refused until --shape names one, since neither was measured there.
//
// --no-env-file: compose is run with the edge's settings alone — no env file (`--env-file /dev/null`), and none of
// the shell's COMPOSE_* or EDGE_* — but Bun would load a .env in the working directory into this script, and
// deploy/.env holds a brain's secrets. Run without it, `check` and `up` refuse, naming the command.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bunEnvProblem, listens, reason, shellQuote } from "../instance.ts";

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
/** Where each shape dials a brain's loopback port: podman's name for the host from a container, or the host's own loopback. */
export const DIAL: Record<Shape, string> = { bridge: "host.containers.internal", host: "127.0.0.1" };
export type Registry = { port: number; pingPort: number; domain: string; brains: { name: string; port: number }[] };

const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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
  if (!isPort(pingPort)) problems.push(`edge.ping_port: ${JSON.stringify(pingPort)} is not a port (1-65535)`);
  else if (pingPort === port) problems.push("edge.ping_port: the edge's own port, where its ping would be a route");
  const domain = e.domain ?? "localhost";
  // The domain and each name go into a Host rule in a table Traefik renders as a Go template, so neither holds
  // anything but a host name's characters: no backtick, brace, quote or space.
  if (typeof domain !== "string" || domain.length > 200 || !domain.split(".").every((l) => LABEL.test(l))) problems.push(`edge.domain: ${JSON.stringify(domain)} is not a lower-case host name (letters, digits, hyphens, dots)`);
  const brains: Registry["brains"] = [];
  if (!isMapping(doc.brains) || Object.keys(doc.brains).length === 0) problems.push("brains: names no brain");
  else for (const [name, def] of Object.entries(doc.brains)) {
    if (!NAME.test(name)) { problems.push(`brains.${JSON.stringify(name)}: a brain's name is lower-case letters, digits and hyphens, starting with a letter, as one label of a host name`); continue; }
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

/** The edge's route table for a registry and shape: a router by host per brain, its two middlewares, its service at the shape's dial host. No comment: Traefik renders the file as a Go template first. */
export function renderRoutes(r: Registry, shape: Shape): string {
  const routers = r.brains.map((b) => `    ${b.name}:\n      rule: "Host(\`${b.name}.${r.domain}\`)"\n      entryPoints: [web]\n      middlewares: [edge-strip, brain-absent]\n      service: ${b.name}\n`).join("");
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

/** The facts of a runtime, from its own `info` and `version`. */
function factsOf(runtime: string): Facts | string {
  const run = (args: string[]) => { const r = Bun.spawnSync([runtime, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const base = { runtime, platform: process.platform };
  if (runtime === "podman") {
    const i = run(["info", "--format", "json"]);
    if (!i.ok) return `podman info failed: ${reason(i.err)}`;
    const info = JSON.parse(i.out) as { host?: { security?: { rootless?: boolean }; os?: string } };
    return { ...base, engine: "podman", rootless: info.host?.security?.rootless === true, desktop: false, osType: info.host?.os ?? "" };
  }
  const v = run(["version", "--format", "{{json .Server}}"]);
  if (!v.ok) return `${runtime} version failed: ${reason(v.err)}`;
  const server = JSON.parse(v.out) as { Components?: { Name?: string }[] } | null;
  const podman = (server?.Components ?? []).some((c) => /podman/i.test(c.Name ?? ""));
  const i = run(["info", "--format", "{{json .}}"]);
  if (!i.ok) return `${runtime} info failed: ${reason(i.err)}`;
  const info = JSON.parse(i.out) as { OperatingSystem?: string; OSType?: string; SecurityOptions?: string[] };
  return { ...base, engine: podman ? "podman" : "docker", rootless: (info.SecurityOptions ?? []).some((s) => /rootless/.test(s)), desktop: /docker desktop/i.test(info.OperatingSystem ?? ""), osType: info.OSType ?? "" };
}

/** The environment compose runs in: the shell's, but for anything that would steer compose or the edge's settings, and then the edge's. */
export function composeEnv(env: Record<string, string | undefined>, r: Registry, sha: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(COMPOSE_|EDGE_)/.test(k)) out[k] = v;
  return { ...out, EDGE_BIND: "127.0.0.1", EDGE_PORT: String(r.port), EDGE_PING_PORT: String(r.pingPort), EDGE_ROUTES_SHA256: sha };
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
  if (o.shape) return { shape: o.shape, why: `--shape ${o.shape}` };
  const facts = factsOf(o.runtime);
  if (typeof facts === "string") { console.error(facts); process.exit(2); }
  const d = decideShape(facts);
  if (!d.shape) { console.error(d.why); process.exit(2); }
  return { shape: d.shape, why: d.why };
}

/** The edge's own container, running: it holds the edge's ports, so an `up` over it is no clash. */
function edgeRunning(runtime: string): boolean {
  const r = Bun.spawnSync([runtime, "ps", "--filter", `label=com.docker.compose.project=${PROJECT}`, "--filter", "status=running", "--format", "{{.Names}}"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 && r.stdout.toString().trim() !== "";
}

/** Each port the edge would take, refused when something not the edge listens there; each brain's port, noted when nothing does. */
async function ports(o: Options, r: Registry, shape: Shape): Promise<{ refusals: string[]; notes: string[] }> {
  const own = edgeRunning(o.runtime);
  const refusals: string[] = [];
  const mine: [string, number][] = shape === "host" ? [["edge.port", r.port], ["edge.ping_port", r.pingPort]] : [["edge.port", r.port]];
  if (!own) for (const [key, port] of mine) if (await listens("127.0.0.1", port)) refusals.push(`127.0.0.1:${port} (${key}) already answers, and not as this edge: set ${key} in the registry to a free port`);
  const notes: string[] = [];
  for (const b of r.brains) if (!(await listens("127.0.0.1", b.port))) notes.push(`${b.name}: nothing answers on 127.0.0.1:${b.port} now — its host is a 404 until the brain is up`);
  return { refusals, notes };
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
  const { refusals, notes } = await ports(o, registry, shape);
  console.log(`edge: ${why}`);
  for (const n of notes) console.log(`note: ${n}`);
  if (refusals.length) { for (const x of refusals) console.error(x); process.exit(2); }
  if (cmd === "check") { console.log(`the brains, through the edge:\n${urls(registry)}`); return; }
  // up: the table into the file provider's directory (written beside it and renamed over, so Traefik never reads
  // half a file), then compose, with the table's digest as a label so a changed table recreates the container.
  mkdirSync(ROUTES_DIR, { recursive: true, mode: 0o755 });
  const tmp = join(ROUTES_DIR, `.routes.${process.pid}.tmp`);
  writeFileSync(tmp, table, { mode: 0o644 });
  renameSync(tmp, join(ROUTES_DIR, "routes.yaml"));
  const sha = new Bun.CryptoHasher("sha256").update(table).digest("hex");
  const up = Bun.spawnSync(composeArgs(o.runtime, [shape], ["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "60"]), { env: composeEnv(process.env, registry, sha), stdout: "inherit", stderr: "inherit" });
  if (up.exitCode !== 0) { console.error(`the edge did not come up; its log: ${composeArgs(o.runtime, [shape], ["logs"]).map(shellQuote).join(" ")}`); process.exit(1); }
  console.log(`the brains, through the edge:\n${urls(registry)}`);
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
    ["the bridge table dials host.containers.internal, the host table 127.0.0.1, each at the brain's port", ex !== undefined && renderRoutes(ex, "bridge").includes('url: "http://host.containers.internal:8011"') && renderRoutes(ex, "host").includes('url: "http://127.0.0.1:8010"') && !renderRoutes(ex, "host").includes("host.containers.internal")],
    ["each brain's router is its host alone, with the strip and the 404 for a brain that is down", ex !== undefined && ex.brains.every((b) => renderRoutes(ex, "bridge").includes(`    ${b.name}:\n      rule: "Host(\`${b.name}.localhost\`)"\n      entryPoints: [web]\n      middlewares: [edge-strip, brain-absent]\n      service: ${b.name}\n`))],
    ["the table is YAML Traefik reads: a router, a service per brain, the two middlewares, nothing else", (() => { if (!ex) return false; const t = Bun.YAML.parse(renderRoutes(ex, "bridge")) as { http: { routers: object; services: object; middlewares: object } }; return Object.keys(t).join() === "http" && Object.keys(t.http.routers).join() === "canary,stable" && Object.keys(t.http.services).join() === "canary,stable" && Object.keys(t.http.middlewares).join() === "edge-strip,brain-absent"; })()],
    ["the table holds no comment and no Go template", ex !== undefined && !/#|\{\{/.test(renderRoutes(ex, "bridge"))],
    ["podman machine on macOS is the bridge shape; rootless, or on Linux, is no shape", decideShape(facts({ runtime: "podman", engine: "podman", platform: "darwin" })).shape === "bridge" && decideShape(facts({ engine: "podman", platform: "darwin", rootless: true })).shape === undefined && decideShape(facts({ engine: "podman", platform: "linux" })).shape === undefined],
    ["Docker Engine on Linux is the host shape; Docker Desktop, rootless or on macOS is no shape, and says to name one", decideShape(facts({})).shape === "host" && [facts({ desktop: true }), facts({ rootless: true }), facts({ platform: "darwin" })].every((f) => { const d = decideShape(f); return d.shape === undefined && /--shape bridge or --shape host/.test(d.why); })],
    ["the docker CLI on podman machine's engine is the bridge shape", decideShape(facts({ engine: "podman", platform: "darwin", osType: "linux" })).shape === "bridge"],
    ["compose's environment drops the shell's COMPOSE_* and EDGE_* and sets the edge's own", (() => { if (!ex) return false; const e = composeEnv({ PATH: "/bin", COMPOSE_PROFILES: "host", COMPOSE_FILE: "x.yaml", EDGE_PORT: "1", EDGE_BIND: "0.0.0.0", DOCKER_HOST: "unix:///x" }, ex, "abc"); return e.PATH === "/bin" && e.DOCKER_HOST === "unix:///x" && !("COMPOSE_PROFILES" in e) && !("COMPOSE_FILE" in e) && e.EDGE_PORT === "8090" && e.EDGE_BIND === "127.0.0.1" && e.EDGE_PING_PORT === "8091" && e.EDGE_ROUTES_SHA256 === "abc"; })()],
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
