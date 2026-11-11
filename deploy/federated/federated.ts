// The federated coordinator's runner (SMD-3379 PR 3a): reads and checks the registry with the slot broker's own reading,
// refuses a runtime no shape was measured on, and runs deploy/federated/compose.yaml as project ob1-federated with the
// project's settings alone; and mints a brain's broker key.
//
//   bun --no-env-file deploy/federated/federated.ts check [--registry PATH] [--runtime docker|podman]
//   bun --no-env-file deploy/federated/federated.ts up    [--registry PATH] [--runtime docker|podman]
//   bun --no-env-file deploy/federated/federated.ts down  [--runtime docker|podman]
//   bun deploy/federated/federated.ts key --brain NAME
//   bun deploy/federated/federated.ts --self-check
//
// The registry is deploy/federated/federation.local.yaml unless --registry names another (federation.example.yaml
// says what it holds). It holds each brain's key's hash, never the key, and the broker's container reads it, and
// broker.ts, as an unprivileged user: so both must be readable by others (0644), refused otherwise rather than changed
// (a checkout made under umask 077 leaves broker.ts 0600).
//
// The shape. A brain's container reaches the broker at the host alias, as it reaches the host's Ollama, and the broker's
// port is published on the host's loopback. Under podman machine (macOS, rootful) the host alias reaches the host's
// loopback — measured for the edge (deploy/edge/compose.yaml) and for this. Under Docker Engine on Linux the alias is
// the bridge's gateway, which a port on the host's loopback does not answer: refused until SMD-3379 PR 3b measures a
// shape there. Any other runtime is refused the same way.
//
// --no-env-file: as edge.ts's, since Bun would load a .env in the working directory, and deploy/.env holds a brain's
// secrets.
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { factsFrom, type Facts } from "../edge/edge.ts";
import { bunEnvProblem, listens, PS_ARGS, containersIn, holds, reason, shellQuote } from "../instance.ts";
import { brainOf, hashKey, KEY_PREFIX, parseRegistry, type Registry } from "./broker.ts";

const HERE = import.meta.dir;
const COMPOSE = join(HERE, "compose.yaml");
const BROKER = join(HERE, "broker.ts");
const PROJECT = "ob1-federated";
const DEFAULT_REGISTRY = join(HERE, "federation.local.yaml");
const USAGE = `usage: bun --no-env-file deploy/federated/federated.ts check|up [--registry PATH] [--runtime docker|podman]
       bun --no-env-file deploy/federated/federated.ts down [--runtime docker|podman]
       bun deploy/federated/federated.ts key --brain NAME
       bun deploy/federated/federated.ts --self-check`;
const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether the runtime is one a shape was measured on, and why not when it is not. */
export function measured(f: Facts): { ok: boolean; why: string } {
  if (f.engine === "podman" && f.platform === "darwin" && !f.rootless) return { ok: true, why: "podman machine on macOS, rootful: brains reach the broker at host.containers.internal" };
  const what = f.engine === "unknown" ? `${f.runtime}, whose engine did not say what it is` : `${f.engine === "podman" ? "podman" : f.desktop ? "Docker Desktop" : "Docker Engine"}${f.rootless ? ", rootless," : ""} on ${f.platform}`;
  return { ok: false, why: `${what}: no shape of the federated coordinator was measured there — a brain's container must reach the broker's port at its host alias (deploy/federated/federated.ts says why Docker Engine on Linux is not yet)` };
}

/** The environment compose runs in: the shell's, less anything that would steer compose or the project's settings, then the project's. */
export function composeEnv(env: Record<string, string | undefined>, r: Pick<Registry, "port">, registryPath: string, brokerSha: string, registrySha: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(COMPOSE_|FEDERATED_)/.test(k)) out[k] = v;
  return { ...out, FEDERATED_PORT: String(r.port), FEDERATED_REGISTRY: registryPath, FEDERATED_BROKER_SHA256: brokerSha, FEDERATED_REGISTRY_SHA256: registrySha };
}

/** A new key for a brain, and the registry's lines for it: the key once, for the brain's deploy/.env; its hash, quoted, for the registry. */
export function mintKey(brain: string, bytes = randomBytes(32)): { key: string; lines: string } {
  const key = `${KEY_PREFIX}${bytes.toString("hex")}`;
  return { key, lines: `  ${brain}:\n    key: "${hashKey(key)}"\n` };
}

/** Why the registry's file can't be read by the broker's unprivileged user, or "". */
export function modeProblem(mode: number, path: string): string {
  return (mode & 0o004) ? "" : `${path} is not readable by others (mode ${(mode & 0o777).toString(8)}), and the broker's container reads it as an unprivileged user: chmod 644 it (a registry holds only hashes)`;
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

/** One GET of /health on the host's loopback: whether the broker answers ok within 2 s. */
async function healthy(port: number): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok && (await r.text()) === "ok\n"; } catch { return false; }
}

async function main(cmd: string, args: string[]) {
  const o = options(cmd, args);
  if (cmd === "key") {
    if (!o.brain || !NAME.test(o.brain)) { console.error("key --brain NAME: a name is lower-case letters, digits and hyphens, starting with a letter"); process.exit(2); }
    const { key, lines } = mintKey(o.brain);
    console.log(`\n  The broker key for brain "${o.brain}" — shown once, not recoverable:\n\n    ${key}\n\n  For that brain's deploy/.env (SMD-3379 PR 3b reads it; until then nothing does).\n  Under brains: in the registry (its hash, never the key):\n\n${lines}`);
    return;
  }
  const loaded = bunEnvProblem(process.execArgv);
  if (loaded) { console.error(`${loaded}, and deploy/.env holds a brain's secrets. Run it as: bun --no-env-file ${[process.argv[1] ?? "deploy/federated/federated.ts", cmd, ...args].map(shellQuote).join(" ")}`); process.exit(2); }
  if (cmd === "down") {
    const r = Bun.spawnSync(composeArgs(o.runtime, ["down", "--remove-orphans"]), { env: composeEnv(process.env, { port: 1 }, BROKER, "down", "down"), stdout: "inherit", stderr: "inherit" });
    process.exit(r.exitCode === 0 ? 0 : 1);
  }
  if (!existsSync(o.registry)) { console.error(`no registry at ${o.registry} — copy deploy/federated/federation.example.yaml there and name your servers and brains, or give --registry PATH`); process.exit(2); }
  const text = readFileSync(o.registry, "utf8");
  const { registry, problems } = parseRegistry(text);
  if (!registry) { console.error(`${o.registry}:\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(2); }
  const refusals: string[] = [];
  for (const path of [o.registry, BROKER]) { const mode = modeProblem(statSync(path).mode, path); if (mode) refusals.push(mode); }
  const facts = factsOf(o.runtime);
  if (typeof facts === "string") refusals.push(facts);
  else { const m = measured(facts); if (!m.ok) refusals.push(m.why); else console.log(`federated: ${m.why}`); }
  // The port: free, or this project's broker's.
  const listing = spawn([o.runtime, ...PS_ARGS]);
  const ours = listing.ok && containersIn(listing.out).some((c) => c.project === PROJECT && c.state === "running" && holds(c.ports, { hostIp: "127.0.0.1", port: registry.port, protocol: "tcp" }));
  if (!ours && await listens("127.0.0.1", registry.port)) refusals.push(`127.0.0.1:${registry.port} (broker.port) already answers, and not as this broker: stop it, or set broker.port in the registry to a free port`);
  if (refusals.length) { for (const x of refusals) console.error(x); process.exit(2); }
  const summary = `the slot broker: ${registry.brains.map((b) => b.name).join(", ")} on ${registry.servers.map((s) => `${s.name} (${s.slots} slots, ${s.reserve} reserved)`).join(", ")}; brains reach it at http://host.containers.internal:${registry.port}`;
  if (cmd === "check") { console.log(summary); return; }
  const env = composeEnv(process.env, registry, o.registry, sha256(readFileSync(BROKER, "utf8")), sha256(text));
  const logs = composeArgs(o.runtime, ["logs"]).map(shellQuote).join(" ");
  const up = Bun.spawnSync(composeArgs(o.runtime, ["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "60"]), { env, stdout: "inherit", stderr: "inherit" });
  if (up.exitCode !== 0 || !(await healthy(registry.port))) { console.error(`the broker did not come up; its log: ${logs}`); process.exit(1); }
  console.log(summary);
}

function selfCheck() {
  const facts = (o: Partial<Facts>): Facts => ({ runtime: "podman", platform: "darwin", engine: "podman", rootless: false, desktop: false, osType: "linux", ...o });
  const compose = Bun.YAML.parse(readFileSync(COMPOSE, "utf8")) as { name: string; services: Record<string, Record<string, unknown>> };
  const slots = compose.services.slots;
  const minted = mintKey("canary", Buffer.alloc(32, 7));
  const reg = parseRegistry(`servers:\n  o:\n    bases: [http://h:1/v1]\n    slots: 1\nbrains:\n${minted.lines}`).registry;
  const cases: [string, boolean][] = [
    ["podman machine, rootful, on macOS is the measured shape", measured(facts({})).ok],
    ["Docker Engine on Linux is refused, naming why", (() => { const m = measured(facts({ runtime: "docker", engine: "docker", platform: "linux" })); return !m.ok && /Docker Engine on linux/.test(m.why); })()],
    ["rootless podman and Docker Desktop are refused", !measured(facts({ rootless: true })).ok && !measured(facts({ engine: "docker", desktop: true })).ok],
    ["compose's environment drops the shell's COMPOSE_* and FEDERATED_* and sets the project's own", (() => { const e = composeEnv({ PATH: "/bin", COMPOSE_FILE: "x", FEDERATED_PORT: "1", DOCKER_HOST: "unix:///x" }, { port: 8095 }, "/r.yaml", "b", "r"); return e.PATH === "/bin" && e.DOCKER_HOST === "unix:///x" && !("COMPOSE_FILE" in e) && e.FEDERATED_PORT === "8095" && e.FEDERATED_REGISTRY === "/r.yaml" && e.FEDERATED_BROKER_SHA256 === "b" && e.FEDERATED_REGISTRY_SHA256 === "r"; })()],
    ["a minted key is marked, its lines read as a registry's brain, and the key finds it", minted.key.startsWith(KEY_PREFIX) && minted.key.length === KEY_PREFIX.length + 64 && !!reg && brainOf(reg.brains, minted.key)?.name === "canary" && !minted.lines.includes(minted.key)],
    ["two mints are two keys", mintKey("a").key !== mintKey("a").key],
    ["a registry not readable by others is refused, naming chmod 644", /chmod 644/.test(modeProblem(0o100600, "f")) && modeProblem(0o100644, "f") === ""],
    ["the project is ob1-federated, one service", compose.name === PROJECT && Object.keys(compose.services).join() === "slots"],
    ["the broker runs unprivileged, read-only, with no capability", slots.user === "65534:65534" && (slots.cap_drop as string[]).join() === "ALL" && slots.read_only === true && (slots.security_opt as string[]).includes("no-new-privileges:true")],
    ["its one port is on the host's loopback alone", (slots.ports as string[]).length === 1 && (slots.ports as string[])[0].startsWith("127.0.0.1:")],
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
  else if (cmd === "check" || cmd === "up" || cmd === "down" || cmd === "key") await main(cmd, rest);
  else { console.error(USAGE); process.exit(2); }
}
