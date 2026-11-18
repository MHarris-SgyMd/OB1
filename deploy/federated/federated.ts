// The federated coordinator's runner (SMD-3379 PR 3a): reads and checks the registry with the slot broker's own reading,
// refuses a runtime no shape was measured on, and runs deploy/federated/compose.yaml as project ob1-federated with the
// project's settings alone; and mints a brain's broker key.
//
//   bun --no-env-file deploy/federated/federated.ts check [--registry PATH] [--runtime docker|podman]
//   bun --no-env-file deploy/federated/federated.ts up    [--registry PATH] [--runtime docker|podman]
//   bun --no-env-file deploy/federated/federated.ts down  [--runtime docker|podman]
//   bun --no-env-file deploy/federated/federated.ts logs  [--runtime docker|podman]   the broker's log, followed
//   bun deploy/federated/federated.ts key --brain NAME
//   bun deploy/federated/federated.ts --self-check
//
// The registry is deploy/federated/federation.local.yaml unless --registry names another (federation.example.yaml
// says what it holds). It holds each brain's key's hash, never the key, and the broker's container reads it, and
// broker.ts, as an unprivileged user: so both must be readable by others (0644), refused otherwise rather than changed
// (a checkout made under umask 077 leaves broker.ts 0600).
//
// The shape. A brain's container reaches the broker at the host alias, as it reaches the host's Ollama, and the broker's
// one port is published where that alias lands, nowhere else:
//   - podman machine (macOS, rootful), `loopback`: host.containers.internal reaches the host's loopback — measured for
//     the edge (deploy/edge/compose.yaml) and for this — so the port is on 127.0.0.1;
//   - Docker Engine on Linux (rootful), `gateway` (SMD-3379 PR 3b-3a): host.docker.internal is the default bridge's
//     gateway (compose's host-gateway), which a port on the host's loopback does not answer (Docker's documentation: a
//     port published on 127.0.0.1 is reached from the host alone; not measured here), so the port is published on
//     that address, read from the runtime at each check and up. The host and its containers reach it; so can a machine
//     beside the host that routes the bridge's subnet through it (Docker's own caveat for a port published on a host
//     address), so the key (a 401 before any upgrade) is the guard there, as it is against the containers. `up` then
//     has a container on the default bridge dial the broker at the alias and fails naming why where none answers (a
//     firewall, a daemon whose host-gateway-ip is not the bridge's, an IPv6 alias); a brain dials from its own network,
//     which a firewall may treat apart. A daemon of another host (a DOCKER_HOST or a context) is refused — it names
//     another host, or its gateway is no address of this one's — and so is a run from a container. A daemon restarted
//     with another bridge address leaves the broker's old address unbound: run `up` again.
// Any other runtime is refused.
//
// --no-env-file: as edge.ts's, since Bun would load a .env in the working directory, and deploy/.env holds a brain's
// secrets.
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { factsFrom, type Facts } from "../edge/edge.ts";
import { bunEnvProblem, listens, PS_ARGS, containersIn, holds, reason, shellQuote } from "../instance.ts";
import { brainOf, hashKey, isName, KEY_PREFIX, parseRegistry, type Registry } from "./broker.ts";

const HERE = import.meta.dir;
const COMPOSE = join(HERE, "compose.yaml");
const BROKER = join(HERE, "broker.ts");
const PROJECT = "ob1-federated";
const DEFAULT_REGISTRY = join(HERE, "federation.local.yaml");
const USAGE = `usage: bun --no-env-file deploy/federated/federated.ts check|up [--registry PATH] [--runtime docker|podman]
       bun --no-env-file deploy/federated/federated.ts down|logs [--runtime docker|podman]
       bun deploy/federated/federated.ts key --brain NAME
       bun deploy/federated/federated.ts --self-check`;

/** A measured shape: where the broker's port is published, and the alias a brain's container dials it at. */
export type Shape = { name: "loopback" | "gateway"; alias: string };
export const LOOPBACK: Shape = { name: "loopback", alias: "host.containers.internal" };
export const GATEWAY: Shape = { name: "gateway", alias: "host.docker.internal" };

/** Whether the runtime is one a shape was measured on — its shape — and why not when it is not. */
export function measured(f: Facts): { ok: boolean; why: string; shape?: Shape } {
  if (f.engine === "podman" && f.platform === "darwin" && !f.rootless) return { ok: true, shape: LOOPBACK, why: "podman machine on macOS, rootful: brains reach the broker at host.containers.internal, its port on the host's loopback" };
  if (f.engine === "docker" && f.platform === "linux" && f.osType === "linux" && !f.desktop && !f.rootless) return { ok: true, shape: GATEWAY, why: "Docker Engine on Linux, rootful: brains reach the broker at host.docker.internal, its port on the default bridge's gateway" };
  const what = f.engine === "unknown" ? `${f.runtime}, whose engine did not say what it is` : `${f.engine === "podman" ? "podman" : f.desktop ? "Docker Desktop" : "Docker Engine"}${f.rootless ? ", rootless," : ""} on ${f.platform}`;
  const docker = f.engine === "podman" && f.platform === "linux" && f.runtime !== "docker" ? " — with Docker Engine beside it, pass --runtime docker" : "";
  return { ok: false, why: `${what}: no shape of the federated coordinator was measured there — a brain's container must reach the broker's port at its host alias (deploy/federated/federated.ts names the two measured)${docker}` };
}

/** The default bridge's IPv4 gateway from `docker network inspect bridge`'s IPAM gateways, or why none will do: a
 *  private or shared (100.64.0.0/10) address alone, the port's one host address — a public one would publish the broker
 *  to every network that routes to it. */
export function gatewayFrom(out: string): { host: string } | { why: string } {
  const v4 = out.split(/\s+/).filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
  if (!v4.length) return { why: "the default bridge names no IPv4 gateway (docker network inspect bridge)" };
  const private4 = v4.find((x) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(x));
  return private4 ? { host: private4 } : { why: `the default bridge's gateway ${v4[0]} is no private or shared (100.64.0.0/10) address: the broker is published only on one of those` };
}

/**
 * Why the daemon may not be this host's, or "": the shape publishes on the daemon's bridge and checks and dials it here,
 * so both must hold — the daemon names this host (`docker info`'s Name and this host's name read the same kernel name
 * for a local daemon, by any socket), and its gateway is an address of this host's (`owned`, ownsAddress's). A daemon
 * of another host (a DOCKER_HOST, a Docker context) fails the first, which the second alone missed whenever both hosts
 * kept Docker's default 172.17.0.1; a client in a container fails both, by design — the gateway is the daemon's, dialled
 * here (review passes 2–4 of 3b-3a). Two hosts of one name (an image's default, `ubuntu`) on Docker's default bridge
 * still pass: then `up` asks this host's gateway and says the broker did not come up.
 */
export function remoteDaemon(daemonName: string, here: string, gateway: string, owned: boolean | string): string {
  const where = "run federated.ts on the daemon's own host (a DOCKER_HOST or a Docker context points it elsewhere)";
  if (typeof owned === "string") return `whether the default bridge's gateway ${gateway} is this host's could not be told — binding it failed (${owned})`;
  const name = daemonName.trim().toLowerCase();
  if (!name) return "the Docker daemon did not name its host (docker info), so whether it is this host's cannot be told";
  if (name !== here.trim().toLowerCase()) return `the Docker daemon names its host ${daemonName.trim()}, not this host (${here}): ${where}`;
  return owned ? "" : `the default bridge's gateway ${gateway} is no address of this host's: the daemon is another host's, or this runs in a container — ${where}`;
}

/**
 * The gateway shape's address, or why there is none to publish on: the bridge's gateway read (`inspect`, its output),
 * then the daemon's name (`info`, asked only once the gateway is read) and the gateway's ownership (`owns`) held to this
 * host (`here`) by remoteDaemon. Its own function, so the self-check drives main's wiring (review pass 5 of 3b-3a: three
 * mutants of that wiring survived the self-check and CI's success path alike).
 */
export function gatewayPlacement(o: { inspect: { ok: boolean; out: string; err: string }; info: () => { ok: boolean; out: string }; here: string; owns: (address: string) => boolean | string; runtime: string }): { host: string } | { why: string } {
  const got = o.inspect.ok ? gatewayFrom(o.inspect.out) : { why: `${o.runtime} network inspect bridge failed: ${reason(o.inspect.err)}` };
  if ("why" in got) return got;
  const n = o.info();
  const remote = remoteDaemon(n.ok ? n.out : "", o.here, got.host, o.owns(got.host));
  return remote ? { why: remote } : { host: got.host };
}

/**
 * Whether `address` is assigned to this host: a socket bound there for an instant, true, or false where the address is
 * not available here (EADDRNOTAVAIL); any other failure (a policy denying bind) is its own words. Linux binds an address
 * assigned to an interface whatever its link state — the default bridge with no container on it is down, and the
 * interface list (os.networkInterfaces) leaves it out (CI, measured: the runner's own 172.17.0.1 refused).
 */
export function ownsAddress(address: string): boolean | string {
  try { const s = Bun.listen({ hostname: address, port: 0, socket: { data() {} } }); s.stop(true); return true; } catch (e) {
    const err = e as { code?: string; message?: string };
    return err.code === "EADDRNOTAVAIL" ? false : `${err.code ?? "an error"}: ${err.message ?? String(e)}`;
  }
}

/** The environment compose runs in: the shell's, less anything that would steer compose or the project's settings,
 *  then the project's. */
export function composeEnv(env: Record<string, string | undefined>, r: Pick<Registry, "port">, registryPath: string, brokerSha: string, registrySha: string, host = "127.0.0.1"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(COMPOSE_|FEDERATED_)/.test(k)) out[k] = v;
  return { ...out, FEDERATED_HOST: host, FEDERATED_PORT: String(r.port), FEDERATED_REGISTRY: registryPath, FEDERATED_BROKER_SHA256: brokerSha, FEDERATED_REGISTRY_SHA256: registrySha };
}

/** A new key for a brain, and the registry's lines for it: the key once, for the brain's deploy/.env; its hash, quoted,
 *  for the registry. */
export function mintKey(brain: string, bytes = randomBytes(32)): { key: string; lines: string } {
  const key = `${KEY_PREFIX}${bytes.toString("hex")}`;
  return { key, lines: `  ${brain}:\n    key: "${hashKey(key)}"\n` };
}

/** Why a file the broker's container mounts (the registry, broker.ts) can't be read by its unprivileged user, or "". */
export function modeProblem(mode: number, path: string): string {
  return (mode & 0o004) ? "" : `${path} is not readable by others (mode ${(mode & 0o777).toString(8)}), and the broker's container reads it as an unprivileged user: chmod 644 it (the registry holds only hashes; broker.ts no secret)`;
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const spawn = (cmd: string[], env?: Record<string, string>) => { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env }); return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() }; };
const composeArgs = (runtime: string, extra: string[]) => [runtime, "compose", "--env-file", "/dev/null", "-p", PROJECT, "-f", COMPOSE, ...extra];

type Options = { registry: string; runtime: string; brain?: string };
function options(cmd: string, args: string[]): Options {
  const o: Options = { registry: DEFAULT_REGISTRY, runtime: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    const value = () => { if (v === undefined || v.startsWith("-") || !v.trim()) { console.error(`${a} takes a value.`); process.exit(2); } i++; return v; };
    if (a === "--registry" && (cmd === "check" || cmd === "up")) o.registry = resolve(value());
    else if (a === "--runtime" && cmd !== "key") o.runtime = value();
    else if (a === "--brain" && cmd === "key") o.brain = value();
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(2); }
  }
  if (cmd === "key") return o;
  if (o.runtime && o.runtime !== "docker" && o.runtime !== "podman") { console.error(`--runtime takes docker or podman, not ${o.runtime}.`); process.exit(2); }
  if (o.runtime && !Bun.which(o.runtime)) { console.error(`--runtime ${o.runtime} is not on PATH.`); process.exit(2); }
  if (!o.runtime) o.runtime = ["podman", "docker"].find((r) => Bun.which(r)) ?? "";
  if (!o.runtime) { console.error("neither podman nor docker is on PATH."); process.exit(2); }
  return o;
}

function factsOf(runtime: string): Facts | string {
  const v = runtime === "podman" ? { ok: true, out: "", err: "" } : spawn([runtime, "version", "--format", "{{json .Server}}"]);
  if (!v.ok) return `${runtime} version failed: ${reason(v.err)}`;
  const i = runtime === "podman" ? spawn([runtime, "info", "--format", "json"]) : spawn([runtime, "info", "--format", "{{json .}}"]);
  if (!i.ok) return `${runtime} info failed: ${reason(i.err)}`;
  try { return factsFrom(runtime, process.platform, i.out, v.out); } catch { return `${runtime} info did not read as JSON`; }
}

/** One GET of /health at the broker's host address: whether it answers ok within 2 s. */
async function healthy(host: string, port: number): Promise<boolean> {
  try { const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok && (await r.text()) === "ok\n"; } catch { return false; }
}

/** The broker's image, compose.yaml's own: the reachability probe runs it, so nothing new is pulled. */
const brokerImage = () => String((Bun.YAML.parse(readFileSync(COMPOSE, "utf8")) as { services: { slots: { image: string } } }).services.slots.image);

/** The gateway shape's proof: a container on the default bridge, as a brain's would be on its own, dials the broker at
 *  host.docker.internal (host-gateway) and reads its /health — "ok", or why not. */
export function probeArgs(runtime: string, image: string, port: number): string[] {
  return [runtime, "run", "--rm", "--add-host", "host.docker.internal:host-gateway", "--entrypoint", "wget", image, "-q", "-T", "5", "-O", "-", `http://host.docker.internal:${port}/health`];
}

async function main(cmd: string, args: string[]) {
  const o = options(cmd, args);
  if (cmd === "key") {
    if (!o.brain || !isName(o.brain)) { console.error("key --brain NAME: a name is lower-case letters, digits and hyphens, starting with a letter, and no word YAML reads as a boolean or a null (on, yes, null…)"); process.exit(2); }
    const { key, lines } = mintKey(o.brain);
    console.log(`\n  The broker key for brain "${o.brain}" — shown once, not recoverable:\n\n    ${key}\n\n  For that brain's deploy/.env, as OB1_SLOT_BROKER_KEY, beside OB1_SLOT_BROKER_URL=ws://host.containers.internal:<port>/v1/slots\n  (host.docker.internal under Docker Engine on Linux; the registry's broker.port, 8095 unset); its coordinator reads both.\n  Under brains: in the registry (its hash, never the key):\n\n${lines}`);
    return;
  }
  const loaded = bunEnvProblem(process.execArgv);
  if (loaded) { console.error(`${loaded}, and deploy/.env holds a brain's secrets. Run it as: bun --no-env-file ${[process.argv[1] ?? "deploy/federated/federated.ts", cmd, ...args].map(shellQuote).join(" ")}`); process.exit(2); }
  // down and logs read compose.yaml, whose settings are all required: they are given placeholders, which neither
  // command uses (review pass 4: a bare `compose logs` the operator was told to paste refused on each).
  if (cmd === "down" || cmd === "logs") {
    const r = Bun.spawnSync(composeArgs(o.runtime, cmd === "down" ? ["down", "--remove-orphans"] : ["logs", "--follow", "slots"]), { env: composeEnv(process.env, { port: 1 }, BROKER, cmd, cmd), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(r.exitCode === 0 ? 0 : 1);
  }
  if (!existsSync(o.registry)) { console.error(`no registry at ${o.registry} — copy deploy/federated/federation.example.yaml there and name your servers and brains, or give --registry PATH`); process.exit(2); }
  const text = readFileSync(o.registry, "utf8");
  const { registry, problems } = parseRegistry(text);
  if (!registry) { console.error(`${o.registry}:\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(2); }
  const refusals: string[] = [];
  for (const path of [o.registry, BROKER]) { const problem = modeProblem(statSync(path).mode, path); if (problem) refusals.push(problem); }
  const facts = factsOf(o.runtime);
  let shape: Shape | undefined;
  if (typeof facts === "string") refusals.push(facts);
  else { const m = measured(facts); if (!m.ok) refusals.push(m.why); else { shape = m.shape; console.log(`federated: ${m.why}`); } }
  // Where the port goes: the host's loopback, or the default bridge's gateway, read now (a daemon restarted with another
  // bridge address moves it).
  let host = "127.0.0.1";
  // No shape, no address of its own to ask either (review pass 4 of 3b-3a: the loopback asked for a runtime refused).
  let unknown = shape === undefined;
  if (shape?.name === "gateway") {
    const placed = gatewayPlacement({
      inspect: spawn([o.runtime, "network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"]),
      info: () => spawn([o.runtime, "info", "--format", "{{.Name}}"]),
      here: hostname(),
      owns: ownsAddress,
      runtime: o.runtime,
    });
    if ("why" in placed) { refusals.push(placed.why); unknown = true; } else host = placed.host;
  }
  // The port: free, or this project's broker's — asked only where its address is known and this host's (review passes 2
  // and 3 of 3b-3a: a gateway unread left the loopback asked; an exit before it for any refusal hid the port's).
  if (unknown) { for (const x of refusals) console.error(x); process.exit(2); }
  const listing = spawn([o.runtime, ...PS_ARGS]);
  const ours = listing.ok && containersIn(listing.out).some((c) => c.project === PROJECT && c.state === "running" && holds(c.ports, { hostIp: host, port: registry.port, protocol: "tcp" }));
  if (!ours && await listens(host, registry.port)) refusals.push(`${host}:${registry.port} (broker.port) already answers, and not as this broker: stop it, or set broker.port in the registry to a free port`);
  if (refusals.length) { for (const x of refusals) console.error(x); process.exit(2); }
  const alias = shape?.alias ?? LOOPBACK.alias;
  const summary = `the slot broker: ${registry.brains.map((b) => b.name).join(", ")} on ${registry.servers.map((s) => `${s.name} (${s.slots} slots, ${s.reserve} reserved${s.ps ? ", its loaded models read" : ""})`).join(", ")}; brains reach it at ws://${alias}:${registry.port}/v1/slots (published on ${host})`;
  if (cmd === "check") { console.log(summary); return; }
  const env = composeEnv(process.env, registry, o.registry, sha256(readFileSync(BROKER, "utf8")), sha256(text), host);
  const rt = o.runtime === "podman" ? "" : ` --runtime ${o.runtime}`;
  const logs = `bun --no-env-file deploy/federated/federated.ts logs${rt}`;
  const up = Bun.spawnSync(composeArgs(o.runtime, ["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "60"]), { env, stdout: "inherit", stderr: "inherit" });
  if (up.exitCode !== 0 || !(await healthy(host, registry.port))) { console.error(`the broker did not come up (or does not answer on ${host}:${registry.port}); its log: ${logs} — its container may still be up: bun --no-env-file deploy/federated/federated.ts down${rt}`); process.exit(1); }
  // The gateway shape, proved as a brain dials it: a container at host.docker.internal.
  if (shape?.name === "gateway") {
    const p = spawn(probeArgs(o.runtime, brokerImage(), registry.port));
    if (!p.ok || p.out !== "ok\n") {
      console.error(`the broker answers on ${host}:${registry.port}, but a container does not reach it at host.docker.internal (${reason(p.err) || p.out.trim() || "no answer"}): a firewall dropping the bridge's traffic to the host, a daemon whose host-gateway-ip is not the default bridge's gateway, or an alias that resolves to IPv6 first (a dual-stack bridge) — brains would not reach it either. It is still up: bun --no-env-file deploy/federated/federated.ts down --runtime ${o.runtime}`);
      process.exit(1);
    }
    console.log(`federated: a container reached the broker at host.docker.internal:${registry.port}`);
  }
  console.log(summary);
}

function selfCheck() {
  const facts = (o: Partial<Facts>): Facts => ({ runtime: "podman", platform: "darwin", engine: "podman", rootless: false, desktop: false, osType: "linux", ...o });
  const compose = Bun.YAML.parse(readFileSync(COMPOSE, "utf8")) as { name: string; services: Record<string, Record<string, unknown>> };
  const slots = compose.services.slots;
  const minted = mintKey("canary", Buffer.alloc(32, 7));
  const reg = parseRegistry(`servers:\n  o:\n    bases: [http://h:1/v1]\n    slots: 1\nbrains:\n${minted.lines}`).registry;
  const cases: [string, boolean][] = [
    ["podman machine, rootful, on macOS is the loopback shape, at host.containers.internal", (() => { const m = measured(facts({})); return m.ok && m.shape === LOOPBACK && m.shape.alias === "host.containers.internal"; })()],
    ["Docker Engine on Linux, rootful, is the gateway shape, at host.docker.internal (SMD-3379 PR 3b-3a)", (() => { const m = measured(facts({ runtime: "docker", engine: "docker", platform: "linux" })); return m.ok && m.shape === GATEWAY && m.shape.alias === "host.docker.internal"; })()],
    ["rootless podman, rootless Docker Engine, Docker Desktop and podman on Linux are refused, the last naming why", !measured(facts({ rootless: true })).ok && !measured(facts({ runtime: "docker", engine: "docker", platform: "linux", rootless: true })).ok
      && !measured(facts({ engine: "docker", desktop: true })).ok && (() => { const m = measured(facts({ platform: "linux" })); return !m.ok && /podman on linux: no shape/.test(m.why); })()],
    ["the gateway is the bridge's private or shared IPv4 one; none, or any other, refused", (() => { const a = gatewayFrom("172.17.0.1 \n"), b = gatewayFrom("fd00::1 10.200.0.1 "), c = gatewayFrom(" "), d = gatewayFrom("203.0.113.1 "), e = gatewayFrom("100.64.0.1 "), f = gatewayFrom("100.128.0.1 "), g = gatewayFrom("127.0.0.1 "); return "host" in a && a.host === "172.17.0.1" && "host" in b && b.host === "10.200.0.1" && "why" in c && "why" in d && /no private or shared/.test(d.why) && "host" in e && e.host === "100.64.0.1" && "why" in f && "why" in g; })()],
    ["a daemon of another host is refused by its name even where this host holds the same gateway; a gateway not this host's by its address; no name, or a failed bind, cannot tell; this host's daemon passes", /names its host prod-box, not this host/.test(remoteDaemon("prod-box\n", "dev-box", "172.17.0.1", true)) && /no address of this host's/.test(remoteDaemon("dev-box\n", "dev-box", "172.17.0.1", false)) && remoteDaemon("Dev-Box\n", "dev-box", "172.17.0.1", true) === "" && /cannot be told/.test(remoteDaemon("", "dev-box", "172.17.0.1", true)) && /could not be told — binding it failed \(EACCES/.test(remoteDaemon("dev-box", "dev-box", "172.17.0.1", "EACCES: denied"))],
    ["an address is this host's where a socket binds there: the loopback is, a documentation address is not (EADDRNOTAVAIL)", ownsAddress("127.0.0.1") === true && ownsAddress("203.0.113.1") === false],
    ["Docker Desktop on Linux is refused", !measured(facts({ runtime: "docker", engine: "docker", platform: "linux", osType: "linux", desktop: true })).ok],
    ["Docker Engine on macOS (colima, OrbStack: not Desktop, a Linux VM) is refused", !measured(facts({ runtime: "docker", engine: "docker", platform: "darwin", osType: "linux", desktop: false })).ok],
    ["the gateway's private and shared ranges at their bounds, 192.168 among them", ["10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.5.1", "100.64.0.1", "100.127.255.254"].every((a) => { const g = gatewayFrom(a); return "host" in g && g.host === a; })
      && ["172.15.0.1", "172.32.0.1", "172.160.0.1", "192.169.0.1", "100.63.255.1", "100.128.0.1", "11.10.0.1", "169.254.0.1"].every((a) => "why" in gatewayFrom(a))],
    ["the daemon's name is held to this host's whole, not a part of it", remoteDaemon("box.example\n", "box", "172.17.0.1", true) !== "" && remoteDaemon("box\n", "box.example", "172.17.0.1", true) !== ""],
    ["main's gateway wiring: the gateway read, the daemon's name and the bind each refuse; all three hold, the gateway is the address", (() => {
      const ok = (out: string) => ({ ok: true, out, err: "" });
      const run = (o: Partial<Parameters<typeof gatewayPlacement>[0]>) => gatewayPlacement({ inspect: ok("172.17.0.1 "), info: () => ok("runner\n"), here: "runner", owns: () => true, runtime: "docker", ...o });
      const good = run({}), unread = run({ inspect: { ok: false, out: "", err: "no such network" } }), other = run({ info: () => ok("prod\n") }), unbound = run({ owns: () => false }), denied = run({ owns: () => "EACCES: denied" });
      return "host" in good && good.host === "172.17.0.1" && "why" in unread && /inspect bridge failed/.test(unread.why) && "why" in other && /names its host prod/.test(other.why) && "why" in unbound && /no address of this host's/.test(unbound.why) && "why" in denied && /binding it failed/.test(denied.why);
    })()],
    ["podman on Linux is refused pointing at --runtime docker, unless docker is that podman (podman-docker)", (() => { const m = measured(facts({ platform: "linux" })), s = measured(facts({ runtime: "docker", platform: "linux" })); return !m.ok && /--runtime docker/.test(m.why) && !s.ok && !/--runtime docker/.test(s.why); })()],
    ["Docker Engine whose OS type is not linux is refused", !measured(facts({ runtime: "docker", engine: "docker", platform: "linux", osType: "windows" })).ok],
    ["a re-up under the gateway shape knows its own port: ps's binding on the gateway address is this broker's", (() => { const line = `abc|ob1-federated-slots-1|172.17.0.1:8095->8095/tcp|${PROJECT}|slots|running|||`; const c = containersIn(line)[0]; return !!c && c.project === PROJECT && holds(c.ports, { hostIp: "172.17.0.1", port: 8095, protocol: "tcp" }) && !holds(c.ports, { hostIp: "127.0.0.1", port: 8095, protocol: "tcp" }); })()],
    ["down's and logs' placeholder settings name every value compose.yaml requires", (() => { const need = [...readFileSync(COMPOSE, "utf8").matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]); const e = composeEnv({}, { port: 1 }, BROKER, "down", "down"); return need.length > 0 && need.every((k) => typeof e[k] === "string" && e[k] !== ""); })()],
    ["the gateway shape's proof dials host.docker.internal at host-gateway, with the broker's own image, removed after, bounded", (() => { const a = probeArgs("docker", "img@sha256:x", 8095), j = a.join(" "); return j.includes("--add-host host.docker.internal:host-gateway") && a.includes("img@sha256:x") && a.at(-1) === "http://host.docker.internal:8095/health" && a.includes("--rm") && j.includes("-T 5") && j.includes("--entrypoint wget") && j.includes("-O -"); })()],
    ["compose's environment drops the shell's COMPOSE_* and FEDERATED_* and sets the project's own, the port's host the loopback unless given", (() => { const e = composeEnv({ PATH: "/bin", COMPOSE_FILE: "x", FEDERATED_PORT: "1", FEDERATED_HOST: "0.0.0.0", DOCKER_HOST: "unix:///x" }, { port: 8095 }, "/r.yaml", "b", "r"); const g = composeEnv({}, { port: 8095 }, "/r.yaml", "b", "r", "172.17.0.1"); return e.PATH === "/bin" && e.DOCKER_HOST === "unix:///x" && !("COMPOSE_FILE" in e) && e.FEDERATED_HOST === "127.0.0.1" && g.FEDERATED_HOST === "172.17.0.1" && e.FEDERATED_PORT === "8095" && e.FEDERATED_REGISTRY === "/r.yaml" && e.FEDERATED_BROKER_SHA256 === "b" && e.FEDERATED_REGISTRY_SHA256 === "r"; })()],
    ["a minted key is marked, its lines read as a registry's brain, and the key finds it", minted.key.startsWith(KEY_PREFIX) && minted.key.length === KEY_PREFIX.length + 64 && !!reg && brainOf(reg.brains, minted.key)?.name === "canary" && !minted.lines.includes(minted.key)],
    ["two mints are two keys", mintKey("a").key !== mintKey("a").key],
    ["key takes the names the registry takes, and refuses the ones it refuses", isName("stable") && isName("canary-2") && ["on", "yes", "null", "Stable", "-x"].every((n) => !isName(n))],
    ["a registry not readable by others, readable by its group alone included, is refused, naming chmod 644", /chmod 644/.test(modeProblem(0o100600, "f")) && /chmod 644/.test(modeProblem(0o100640, "f")) && modeProblem(0o100644, "f") === ""],
    ["the project is ob1-federated, one service", compose.name === PROJECT && Object.keys(compose.services).join() === "slots"],
    ["the broker runs unprivileged, read-only, with no capability", slots.user === "65534:65534" && (slots.cap_drop as string[]).join() === "ALL" && slots.read_only === true && (slots.security_opt as string[]).includes("no-new-privileges:true")],
    ["its one port is on the shape's host address alone (FEDERATED_HOST), never every address", (slots.ports as string[]).length === 1 && (slots.ports as string[])[0].startsWith("${FEDERATED_HOST:?")],
    ["it joins no network but its project's own", !("networks" in slots) && !("network_mode" in slots)],
    ["it names the host as the stack's api does, for a model server's list (SMD-3379 PR 3c-1)", (() => { const stack = Bun.YAML.parse(readFileSync(join(HERE, "..", "compose.yaml"), "utf8")) as { services: Record<string, { extra_hosts?: string[] }> }; return JSON.stringify(slots.extra_hosts) === JSON.stringify(["host.docker.internal:host-gateway"]) && JSON.stringify(stack.services.api.extra_hosts) === JSON.stringify(slots.extra_hosts); })()],
    ["it runs the mounted broker on the mounted registry, no .env, no install", JSON.stringify(slots.command) === JSON.stringify(["bun", "--no-install", "--no-env-file", "/broker.ts", "--registry", "/federation.yaml", "--host", "0.0.0.0"])],
    ["its image is the stack's forwarder's, by digest", (() => { const stack = Bun.YAML.parse(readFileSync(join(HERE, "..", "compose.yaml"), "utf8")) as { services: Record<string, { image?: string }> }; return slots.image === stack.services.forwarder.image && /@sha256:[0-9a-f]{64}$/.test(String(slots.image)); })()],
  ];
  for (const [name, ok] of cases) console.log((ok ? "ok   " : "FAIL ") + name);
  process.exit(cases.every(([, ok]) => ok) ? 0 : 1);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--self-check") selfCheck();
  else if (cmd === "check" || cmd === "up" || cmd === "down" || cmd === "logs" || cmd === "key") await main(cmd, rest);
  else { console.error(USAGE); process.exit(2); }
}
