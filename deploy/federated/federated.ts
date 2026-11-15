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
//     gateway (compose's host-gateway), which a port on the host's loopback does not answer, so the port is published on
//     that address, read from the runtime at each check and up — the host and its containers reach it, the network does
//     not. `up` then has a container dial the broker at the alias, as a brain's does, and fails naming why where none
//     answers (a firewall, a daemon whose host-gateway-ip is not the bridge's).
// Any other runtime is refused.
//
// --no-env-file: as edge.ts's, since Bun would load a .env in the working directory, and deploy/.env holds a brain's
// secrets.
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  return { ok: false, why: `${what}: no shape of the federated coordinator was measured there — a brain's container must reach the broker's port at its host alias (deploy/federated/federated.ts names the two measured)` };
}

/** The default bridge's IPv4 gateway from `docker network inspect bridge`'s IPAM gateways, or why none will do: a private
 *  address alone, the port's one host address. */
export function gatewayFrom(out: string): { host: string } | { why: string } {
  const v4 = out.split(/\s+/).filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
  if (!v4.length) return { why: "the default bridge names no IPv4 gateway (docker network inspect bridge)" };
  const private4 = v4.find((x) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x));
  return private4 ? { host: private4 } : { why: `the default bridge's gateway ${v4[0]} is not a private address: publishing the broker there would put it on the network` };
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
    const r = Bun.spawnSync(composeArgs(o.runtime, cmd === "down" ? ["down", "--remove-orphans"] : ["logs", "--follow", "slots"]), { env: composeEnv(process.env, { port: 1 }, BROKER, cmd, cmd, "127.0.0.1"), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
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
  if (shape?.name === "gateway") {
    const g = spawn([o.runtime, "network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"]);
    const got = g.ok ? gatewayFrom(g.out) : { why: `${o.runtime} network inspect bridge failed: ${reason(g.err)}` };
    if ("why" in got) refusals.push(got.why); else host = got.host;
  }
  // The port: free, or this project's broker's.
  const listing = spawn([o.runtime, ...PS_ARGS]);
  const ours = listing.ok && containersIn(listing.out).some((c) => c.project === PROJECT && c.state === "running" && holds(c.ports, { hostIp: host, port: registry.port, protocol: "tcp" }));
  if (!ours && await listens(host, registry.port)) refusals.push(`${host}:${registry.port} (broker.port) already answers, and not as this broker: stop it, or set broker.port in the registry to a free port`);
  if (refusals.length) { for (const x of refusals) console.error(x); process.exit(2); }
  const alias = shape?.alias ?? LOOPBACK.alias;
  const summary = `the slot broker: ${registry.brains.map((b) => b.name).join(", ")} on ${registry.servers.map((s) => `${s.name} (${s.slots} slots, ${s.reserve} reserved)`).join(", ")}; brains reach it at ws://${alias}:${registry.port}/v1/slots (published on ${host})`;
  if (cmd === "check") { console.log(summary); return; }
  const env = composeEnv(process.env, registry, o.registry, sha256(readFileSync(BROKER, "utf8")), sha256(text), host);
  const logs = `bun --no-env-file deploy/federated/federated.ts logs${o.runtime === "podman" ? "" : ` --runtime ${o.runtime}`}`;
  const up = Bun.spawnSync(composeArgs(o.runtime, ["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "60"]), { env, stdout: "inherit", stderr: "inherit" });
  if (up.exitCode !== 0 || !(await healthy(host, registry.port))) { console.error(`the broker did not come up; its log: ${logs}`); process.exit(1); }
  // The gateway shape, proved as a brain dials it: a container at host.docker.internal.
  if (shape?.name === "gateway") {
    const p = spawn(probeArgs(o.runtime, brokerImage(), registry.port));
    if (!p.ok || p.out !== "ok\n") {
      console.error(`the broker answers on ${host}:${registry.port}, but a container does not reach it at host.docker.internal (${reason(p.err) || p.out.trim() || "no answer"}): a firewall dropping the bridge's traffic to the host, or a daemon whose host-gateway-ip is not the default bridge's gateway — brains would not reach it either. It is still up: bun --no-env-file deploy/federated/federated.ts down --runtime ${o.runtime}`);
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
    ["rootless podman, rootless Docker Engine, Docker Desktop and podman on Linux are refused, naming why", !measured(facts({ rootless: true })).ok && !measured(facts({ runtime: "docker", engine: "docker", platform: "linux", rootless: true })).ok
      && !measured(facts({ engine: "docker", desktop: true })).ok && (() => { const m = measured(facts({ platform: "linux" })); return !m.ok && /podman on linux: no shape/.test(m.why); })()],
    ["the gateway is the bridge's private IPv4 one; none, or a public one, refused", (() => { const a = gatewayFrom("172.17.0.1 \n"), b = gatewayFrom("fd00::1 10.200.0.1 "), c = gatewayFrom(" "), d = gatewayFrom("203.0.113.1 "); return "host" in a && a.host === "172.17.0.1" && "host" in b && b.host === "10.200.0.1" && "why" in c && "why" in d && /not a private address/.test(d.why); })()],
    ["the gateway shape's proof dials host.docker.internal at host-gateway, with the broker's own image", (() => { const a = probeArgs("docker", "img@sha256:x", 8095); return a.join(" ").includes("--add-host host.docker.internal:host-gateway") && a.includes("img@sha256:x") && a.at(-1) === "http://host.docker.internal:8095/health"; })()],
    ["compose's environment drops the shell's COMPOSE_* and FEDERATED_* and sets the project's own, the port's host the loopback unless given", (() => { const e = composeEnv({ PATH: "/bin", COMPOSE_FILE: "x", FEDERATED_PORT: "1", FEDERATED_HOST: "0.0.0.0", DOCKER_HOST: "unix:///x" }, { port: 8095 }, "/r.yaml", "b", "r"); const g = composeEnv({}, { port: 8095 }, "/r.yaml", "b", "r", "172.17.0.1"); return e.PATH === "/bin" && e.DOCKER_HOST === "unix:///x" && !("COMPOSE_FILE" in e) && e.FEDERATED_HOST === "127.0.0.1" && g.FEDERATED_HOST === "172.17.0.1" && e.FEDERATED_PORT === "8095" && e.FEDERATED_REGISTRY === "/r.yaml" && e.FEDERATED_BROKER_SHA256 === "b" && e.FEDERATED_REGISTRY_SHA256 === "r"; })()],
    ["a minted key is marked, its lines read as a registry's brain, and the key finds it", minted.key.startsWith(KEY_PREFIX) && minted.key.length === KEY_PREFIX.length + 64 && !!reg && brainOf(reg.brains, minted.key)?.name === "canary" && !minted.lines.includes(minted.key)],
    ["two mints are two keys", mintKey("a").key !== mintKey("a").key],
    ["key takes the names the registry takes, and refuses the ones it refuses", isName("stable") && isName("canary-2") && ["on", "yes", "null", "Stable", "-x"].every((n) => !isName(n))],
    ["a registry not readable by others is refused, naming chmod 644", /chmod 644/.test(modeProblem(0o100600, "f")) && modeProblem(0o100644, "f") === ""],
    ["the project is ob1-federated, one service", compose.name === PROJECT && Object.keys(compose.services).join() === "slots"],
    ["the broker runs unprivileged, read-only, with no capability", slots.user === "65534:65534" && (slots.cap_drop as string[]).join() === "ALL" && slots.read_only === true && (slots.security_opt as string[]).includes("no-new-privileges:true")],
    ["its one port is on the shape's host address alone (FEDERATED_HOST), never every address", (slots.ports as string[]).length === 1 && (slots.ports as string[])[0].startsWith("${FEDERATED_HOST:?")],
    ["it joins no network but its project's own", !("networks" in slots) && !("network_mode" in slots)],
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
