/**
 * stack.ts — the throwaway brain each candidate runs beside (SMD-1863).
 *
 * One compose project per candidate: deploy/compose.yaml as it ships (the
 * reference deployment, built from this checkout) plus the candidate's overlay
 * from this directory, under the project name `ob1-orch-<tool>` so its volumes,
 * network and containers are its own and `--down` removes all of them. Nothing
 * here touches a running dogfood stack: another project name, another port.
 *
 * The secrets live in evals/orchestration/.env (gitignored — `.env` at any
 * depth), written once by `ensureEnv`: the database passwords, the candidate's
 * encryption key, and two brain keys minted the way keygen.ts mints them —
 * `orch-capture` (capture scope: the ingestion workflow's, can add, cannot
 * read) and `orch-read` (read scope: the retrieval tool's). Only their hashes
 * reach MCP_ACCESS_KEYS. LINEAR_API_KEY is not copied into it: the driver reads
 * it from the usual search path (db/env.ts) and each adapter hands it to its
 * tool's credential store; compose never sees it.
 *
 * compose and docker run with an ALLOWLISTED environment, never the driver's
 * whole one. loadEnv() fills process.env from deploy/.env and <repo>/.env —
 * the dogfood stack's POSTGRES_PASSWORD, MCP_ACCESS_KEYS and SERVER_PORT among
 * them — and compose ranks a shell variable above --env-file, so inheriting it
 * would hand the throwaway brain the dogfood's port and keys (review pass 1).
 * A knob for a run (ORCH_AP_PIECES_SYNC_MODE) goes in orchestration/.env.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "../../server-portable/auth.ts";
import { parseEnv } from "../../db/env.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ENV_FILE = join(HERE, ".env");

type Keys = { capture: string; read: string };

/** What docker and compose need from the caller's environment to reach the engine — and nothing else. */
const PASS_THROUGH = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_BUILDKIT", "CONTAINER_HOST", "CONTAINER_CONNECTION",
  "XDG_CONFIG_HOME", "SSL_CERT_FILE",
  // A build behind a proxy (the brain's images run bun install), and the
  // commit the server image stamps itself with (deploy/compose.yaml's build arg).
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "OB1_GIT_SHA",
];

/**
 * The POC's .env: created on first use, reused after, so a second `--up`
 * meets the database its first one initialised. Returns the parsed values.
 */
export function ensureEnv(): Record<string, string> {
  const hex = (n: number) => randomBytes(n).toString("hex");
  if (existsSync(ENV_FILE)) {
    const env = parseEnv(readFileSync(ENV_FILE, "utf8"));
    // A value a later candidate needs is appended, never a rewrite: the
    // database passwords are the ones the volume was initialised with.
    const later: Record<string, () => string> = { ORCH_MCP_KEY: () => hex(32), ORCH_KEY16: () => hex(16), ORCH_JWT_SECRET: () => hex(32) };
    const missing = Object.keys(later).filter((k) => !env[k]);
    if (missing.length) {
      writeFileSync(ENV_FILE, readFileSync(ENV_FILE, "utf8") + missing.map((k) => `${k}=${later[k]()}\n`).join(""), { mode: 0o600 });
      return parseEnv(readFileSync(ENV_FILE, "utf8"));
    }
    return env;
  }
  const keys: Keys = { capture: hex(32), read: hex(32) };
  const lines = [
    "# SMD-1863 orchestration POC — throwaway brain + candidate. Generated; gitignored.",
    `POSTGRES_PASSWORD=${hex(16)}`,
    `ORCH_DB_PASSWORD=${hex(16)}`,
    `ORCH_ENCRYPTION_KEY=${hex(24)}`,
    // Activepieces wants exactly 32 hex characters for its encryption key.
    `ORCH_KEY16=${hex(16)}`,
    `ORCH_JWT_SECRET=${hex(32)}`,
    `ORCH_ADMIN_PASSWORD=Orch-${hex(8)}`,
    // The candidate's own MCP endpoint's key — what an AI client presents to it.
    `ORCH_MCP_KEY=${hex(32)}`,
    `MCP_ACCESS_KEYS=orch-capture:capture:${hashKey(keys.capture)},orch-read:read:${hashKey(keys.read)}`,
    `ORCH_BRAIN_CAPTURE_KEY=${keys.capture}`,
    `ORCH_BRAIN_READ_KEY=${keys.read}`,
    // The brain's models: the host's Ollama, declared local to the egress gate.
    "SERVER_PORT=8012",
    "OB1_LLM_BASE_URL=http://host.docker.internal:11434/v1",
    "OB1_LLM_LOCAL=1",
    "OB1_EMBEDDING_MODEL=qwen3-embedding:4b",
    "OB1_EMBEDDING_DIM=1024",
    "OB1_METADATA_MODEL=qwen2.5:7b",
    "",
  ];
  writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
  return parseEnv(readFileSync(ENV_FILE, "utf8"));
}

/**
 * Set one value in orchestration/.env, replacing its line or appending one —
 * for a secret a candidate mints at provisioning (n8n's API key), which the
 * next process (`--verify`) must find.
 */
export function setEnvValue(key: string, value: string): void {
  const lines = readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => !l.startsWith(`${key}=`));
  if (lines.at(-1) === "") lines.pop();
  // Written beside it and renamed over it: the file holds the database
  // passwords every candidate's volume was made with, and a truncate-then-write
  // cut short would lose them (review pass 3).
  const tmp = `${ENV_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, [...lines, `${key}=${value}`, ""].join("\n"), { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
}

const project = (tool: string) => `ob1-orch-${tool}`;

/** `docker compose` with this candidate's project, env file and the two -f files. */
function composeArgs(tool: string): string[] {
  return [
    "compose", "-p", project(tool), "--env-file", ENV_FILE,
    "-f", join(REPO, "deploy", "compose.yaml"),
    "-f", join(HERE, `compose.${tool}.yaml`),
  ];
}

export type Run = { code: number; out: string; err: string };

export function run(cmd: string[], env: Record<string, string> = {}, input?: string): Run {
  const base = Object.fromEntries(PASS_THROUGH.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] as string]])));
  const p = Bun.spawnSync(cmd, { env: { ...base, ...env }, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

export function compose(tool: string, args: string[], env: Record<string, string> = {}, input?: string): Run {
  return run(["docker", ...composeArgs(tool), ...args], env, input);
}

/** One SQL statement on the brain's database, unaligned, tuples only. */
export function brainSql(tool: string, sql: string): string {
  const r = compose(tool, ["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "openbrain", "-Atc", sql]);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err.trim()}`);
  return r.out.trim();
}

export async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 180_000, everyMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await probe().catch(() => false)) return;
    await Bun.sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

/** Memory per container of the project — `docker stats`' MemUsage, the cgroup's usage (page cache included), in MiB. */
export function memoryByContainer(tool: string): Record<string, number> {
  const ids = compose(tool, ["ps", "-q"]).out.trim().split("\n").filter(Boolean);
  if (!ids.length) return {};
  const r = run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}", ...ids]);
  const out: Record<string, number> = {};
  for (const line of r.out.trim().split("\n").filter(Boolean)) {
    const [name, usage] = line.split("\t");
    out[name] = toMiB(usage.split("/")[0].trim());
  }
  return out;
}

function toMiB(s: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(s.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase().replace("I", "");
  const f: Record<string, number> = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 };
  return Math.round(n * (f[unit] ?? NaN) * 10) / 10;
}
