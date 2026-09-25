#!/usr/bin/env bun
/**
 * provision.ts — the `orchestration` profile's one provisioning step (SMD-2210).
 *
 *   podman compose -f deploy/compose.yaml --profile orchestration up -d
 *   bun deploy/orchestration/provision.ts [--env-file deploy/.env] [--rotate] [--url http://127.0.0.1:5678]
 *   bun deploy/orchestration/provision.ts --self-check    # the pure rules, no n8n (CI)
 *
 * Run from a checkout against n8n's loopback port, after the profile is up,
 * and again after any change to deploy/.env's orchestration keys or to a
 * template. It is an upsert, so a second run replaces what the first made.
 *
 * The one step outside n8n's public API is the key. A fresh n8n has no owner,
 * and the public API cannot mint its own key, so the first run sets the owner
 * up, signs in and mints one through the internal endpoints the editor uses
 * (`/rest/owner/setup`, `/rest/login`, `/rest/api-keys`). The key is scoped to
 * what this script and the eval kit call, expires after N8N_API_KEY_DAYS (90),
 * and is kept in the env file as N8N_API_KEY. A later run reuses it. It mints
 * again when the key is refused, when fewer than seven days are left, or with
 * --rotate, and it then deletes every earlier key this script minted. The
 * delete is n8n's revocation: the old key answers 401 from then on. Every mint
 * signs in as the owner, which makes N8N_OWNER_PASSWORD the profile's
 * standing secret, stronger than the key.
 *
 * Everything else goes through `/api/v1`. Credentials are created or patched
 * from the credentials template, with values read from the env file. They land
 * in n8n's encrypted store, and no workflow reads a secret from its
 * environment (N8N_BLOCK_ENV_ACCESS_IN_NODE). Workflows are created or
 * replaced from the templates, then published. Before any brain key reaches a
 * credential, it is checked against MCP_ACCESS_KEYS in the same file: it must
 * be listed there, and not at write scope. No workflow holds a write key.
 *
 * Nothing secret is printed. The eval kit imports this module and provisions
 * through it (evals/orchestration/n8n.ts), so the kit tests these bytes.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../../db/env.ts";
import { hashKey, parseKeyRecords } from "../../server-portable/auth.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** The profile's own credentials — the keys its templates reference by placeholder id. */
export const PROFILE_CREDENTIALS = join(HERE, "credentials.template.json");
/** The profile's workflow templates (SMD-2212 adds the first); none yet is not an error. */
export const PROFILE_TEMPLATES = join(HERE, "templates");

/**
 * The key's scopes. Out of the roughly 90 n8n offers, these are what this
 * script calls, plus the run history the kit reads.
 */
export const SCOPES = [
  "credential:create", "credential:list", "credential:update",
  "workflow:create", "workflow:list", "workflow:read", "workflow:update", "workflow:activate",
  "execution:list", "execution:read",
];
/** Every key this script mints carries this label prefix. A re-mint revokes the others with it, never a key someone made by hand. */
export const KEY_LABEL = "ob1-provision";
const DEFAULT_KEY_DAYS = 90;
const RENEW_WITHIN_DAYS = 7;
const DEFAULT_OWNER_EMAIL = "operator@ob1.local";

export type Options = {
  /** n8n's origin, e.g. http://127.0.0.1:5678. */
  base: string;
  /** The env file's values: owner password, keys, template variables. */
  env: Record<string, string>;
  /** Where N8N_API_KEY is kept; a mint rewrites that one line. */
  envFile: string;
  /** Credential template files, in order; a later file may not reuse a name. */
  credentials: string[];
  /** Workflow template files. */
  workflows: string[];
  /** Mint a new key even when the stored one is good, and revoke the rest. */
  rotate?: boolean;
};

export type KeyResult = { key: string; minted: boolean; revoked: number; expiresAt: number | null };

/** Replace or append one KEY=value line, written beside the file and renamed over it so a crash cannot truncate the operator's secrets. */
export function setEnvValue(file: string, key: string, value: string): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n").filter((l) => !l.startsWith(`${key}=`));
  if (lines.at(-1) === "") lines.pop();
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, [...lines, `${key}=${value}`, ""].join("\n"), { mode });
  renameSync(tmp, file);
}

/** A JWT's `exp` claim, unverified: n8n's keys are JWTs, and the verdict on one is n8n's. Null when there is none. */
export function keyExpiry(key: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

async function call(base: string, path: string, init: RequestInit, what: string): Promise<any> {
  const r = await fetch(`${base}${path}`, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`${what} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${what} ${path} → ${r.status}, not JSON: ${text.slice(0, 200)}`);
  }
}

/** One public-API call with the key. */
export const api = (base: string, key: string, method: string, path: string, body?: unknown) =>
  call(base, `/api/v1${path}`, { method, headers: { "content-type": "application/json", "X-N8N-API-KEY": key }, body: body === undefined ? undefined : JSON.stringify(body) }, method);

const JSON_HEADERS = { "content-type": "application/json" };

/** Owner set up on a fresh instance, then signed in: the session cookie the internal endpoints take. */
async function ownerSession(base: string, env: Record<string, string>): Promise<string> {
  const password = env.N8N_OWNER_PASSWORD;
  if (!password) throw new Error("N8N_OWNER_PASSWORD is not set in the env file — deploy/README.md, \"Orchestration\", has the line to add");
  const email = env.N8N_OWNER_EMAIL || DEFAULT_OWNER_EMAIL;
  // A fresh instance answers 200 and makes the owner. One that has an owner
  // answers 400, and signing in follows either way. Anything else is n8n
  // failing, not an owner already there.
  const setup = await fetch(`${base}/rest/owner/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, firstName: "OB1", lastName: "Operator", password }) });
  if (!setup.ok && setup.status !== 400) throw new Error(`owner setup → ${setup.status}: ${(await setup.text()).slice(0, 200)}`);
  const login = await fetch(`${base}/rest/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ emailOrLdapLoginId: email, password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!login.ok || !cookie) {
    throw new Error(`n8n sign-in as ${email} failed (${login.status}): N8N_OWNER_PASSWORD is not this instance's owner password, or its first setup refused it (n8n wants 8+ characters with a number and a capital)`);
  }
  return cookie;
}

/**
 * The stored key if n8n honours it and it has a week left. Otherwise a new
 * one, which is written to the env file before any old key is revoked, so a
 * run cut short never leaves the file without a working key. Only a 401 or
 * 403 counts as "not honoured". A 503 while n8n starts, or a 429, is an
 * error, not a reason to mint.
 */
export async function ensureApiKey(o: Options): Promise<KeyResult> {
  const stored = o.env.N8N_API_KEY;
  if (stored && !o.rotate) {
    const probe = await fetch(`${o.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": stored } });
    const exp = keyExpiry(stored);
    const fresh = exp === null || exp - Date.now() / 1000 > RENEW_WITHIN_DAYS * 86400;
    if (probe.ok && fresh) return { key: stored, minted: false, revoked: 0, expiresAt: exp };
    if (!probe.ok && probe.status !== 401 && probe.status !== 403) throw new Error(`n8n's API answered ${probe.status} to the stored key; not minting another`);
  }
  const days = Number(o.env.N8N_API_KEY_DAYS || DEFAULT_KEY_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`N8N_API_KEY_DAYS must be a positive number of days, got "${o.env.N8N_API_KEY_DAYS}"`);
  const cookie = await ownerSession(o.base, o.env);
  const session = { ...JSON_HEADERS, cookie };
  const expiresAt = Math.floor(Date.now() / 1000 + days * 86400);
  const minted = await call(o.base, "/rest/api-keys", {
    method: "POST", headers: session,
    body: JSON.stringify({ label: `${KEY_LABEL}-${new Date().toISOString()}`, scopes: SCOPES, expiresAt }),
  }, "mint key");
  const key: string = minted.data.rawApiKey;
  setEnvValue(o.envFile, "N8N_API_KEY", key);
  o.env.N8N_API_KEY = key;
  const stale = (await listKeys(o.base, session)).filter((k) => k.label.startsWith(KEY_LABEL) && k.id !== minted.data.id);
  for (const k of stale) await call(o.base, `/rest/api-keys/${k.id}`, { method: "DELETE", headers: session }, "revoke key");
  return { key, minted: true, revoked: stale.length, expiresAt: keyExpiry(key) ?? expiresAt };
}

type ListedKey = { id: string; label: string; expiresAt: number | null };
/** The owner's keys whose label contains KEY_LABEL (n8n's filter is a substring match; callers check the prefix). The list is paginated: one page of 250. */
async function listKeys(base: string, session: Record<string, string>): Promise<ListedKey[]> {
  const listed = await call(base, `/rest/api-keys?take=250&ownership=mine&label=${KEY_LABEL}`, { headers: session }, "list keys");
  const items = listed?.data?.items;
  if (!Array.isArray(items)) throw new Error(`list keys: n8n answered without data.items (${JSON.stringify(Object.keys(listed?.data ?? listed ?? {}))}) — the internal endpoint changed shape; re-run the eval kit against this image`);
  return items.map((k: any) => ({ id: String(k.id), label: String(k.label ?? ""), expiresAt: k.expiresAt ?? null }));
}

/** The keys this script minted that n8n still holds, as the owner sees them: after a mint, exactly one. */
export async function provisionedKeys(base: string, env: Record<string, string>): Promise<ListedKey[]> {
  const session = { ...JSON_HEADERS, cookie: await ownerSession(base, env) };
  return (await listKeys(base, session)).filter((k) => k.label.startsWith(KEY_LABEL));
}

/** A template's `${NAME}` placeholders filled from the env. The rendered text is never written to disk. */
function render(template: string, env: Record<string, string>, file: string): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${file} names ${k}, which the env file does not set`);
    return JSON.stringify(v).slice(1, -1);
  });
}

/**
 * Every brain key a credential carries must be in MCP_ACCESS_KEYS, and at read
 * or capture scope. A key that is not listed would fail at run time. One at
 * write scope would break decision 4 of docs/orchestration-tool.md.
 */
function checkBrainKey(credential: any, env: Record<string, string>): void {
  if (credential.type !== "httpHeaderAuth" || String(credential.data?.name).toLowerCase() !== "x-brain-key") return;
  const record = parseKeyRecords(env.MCP_ACCESS_KEYS ?? "").keys.find((k) => k.sha256 === hashKey(String(credential.data.value)));
  if (!record) throw new Error(`credential "${credential.name}": its brain key's hash is not in MCP_ACCESS_KEYS — mint it with server-portable/keygen.ts --scope capture and add the line keygen prints`);
  if (record.scope === "write") throw new Error(`credential "${credential.name}": its brain key is ${record.name}, a WRITE-scope key — a workflow holds a capture key (or read), never a write key`);
}

/** Workflow template files under a directory, sorted; none when it does not exist. */
export function templatesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f));
}

/** The whole step: key, credentials, workflows, publish. Returns what it did, for the summary. Prints nothing secret. */
export async function provision(o: Options): Promise<{ steps: string[]; key: KeyResult }> {
  const key = await ensureApiKey(o);
  const k = key.key;
  const existing = new Map(((await api(o.base, k, "GET", "/credentials?limit=250")).data as any[]).map((c) => [c.name as string, c.id as string]));
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  const n = { created: 0, patched: 0, workflowsCreated: 0, workflowsReplaced: 0 };
  for (const file of o.credentials) {
    for (const c of JSON.parse(render(readFileSync(file, "utf8"), o.env, file))) {
      if (seen.has(c.name)) throw new Error(`${file}: credential "${c.name}" is named twice across the credential files`);
      seen.add(c.name);
      checkBrainKey(c, o.env);
      let id = existing.get(c.name);
      // Patched every run, not kept: a key rotated in the env file reaches
      // n8n's store on the next run instead of waiting for a volume reset.
      if (id) { await api(o.base, k, "PATCH", `/credentials/${id}`, { name: c.name, type: c.type, data: c.data }); n.patched++; }
      else { id = (await api(o.base, k, "POST", "/credentials", { name: c.name, type: c.type, data: c.data })).id; n.created++; }
      ids.set(c.id, id as string);
    }
  }
  for (const file of o.workflows) {
    let text = readFileSync(file, "utf8");
    for (const [placeholder, id] of ids) text = text.replaceAll(`"${placeholder}"`, JSON.stringify(id));
    const w = JSON.parse(text);
    const body = { name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings };
    const page = await api(o.base, k, "GET", `/workflows?limit=250&name=${encodeURIComponent(w.name)}`);
    let id: string | undefined = (page.data as any[]).find((x) => x.name === w.name)?.id;
    if (id) { await api(o.base, k, "PUT", `/workflows/${id}`, body); n.workflowsReplaced++; }
    else { id = (await api(o.base, k, "POST", "/workflows", body)).id; n.workflowsCreated++; }
    await api(o.base, k, "POST", `/workflows/${id}/publish`, {});
  }
  const expires = key.expiresAt ? new Date(key.expiresAt * 1000).toISOString().slice(0, 10) : "never";
  return {
    key,
    steps: [
      key.minted ? `API key minted through the internal /rest endpoints (expires ${expires}; ${key.revoked} earlier revoked)` : `API key reused (expires ${expires})`,
      `credentials: ${n.created} created, ${n.patched} patched`,
      `workflows: ${n.workflowsCreated} created, ${n.workflowsReplaced} replaced, ${o.workflows.length} published`,
    ],
  };
}

/** Wait for n8n's readiness (the database migrated, the server up), not /healthz, which answers while n8n is still starting. */
export async function waitReady(base: string, timeoutMs = 180_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await fetch(`${base}/healthz/readiness`).catch(() => null))?.ok) return;
    await Bun.sleep(2_000);
  }
  throw new Error(`n8n at ${base} was not ready after ${timeoutMs / 1000}s — is the profile up? (compose --profile orchestration ps)`);
}

/**
 * `--self-check`: the pure rules, with no n8n and no network. It covers the
 * brain-key refusals, the renderer's escaping and missing names, the
 * expiry reader, the env writer's replace, append and mode, and the shipped
 * templates' ids: each placeholder a template names is a credential that
 * credentials.template.json declares.
 */
function selfCheck(): number {
  const fails: string[] = [];
  const expect = (what: string, ok: boolean) => { if (!ok) fails.push(what); };
  const throws = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (e) { return re.test(String((e as Error).message)); } };
  const cap = "c".repeat(64), wr = "w".repeat(64);
  const env = { MCP_ACCESS_KEYS: `n8n:capture:${hashKey(cap)},laptop:write:${hashKey(wr)}` };
  const brain = (value: string) => ({ name: "b", type: "httpHeaderAuth", data: { name: "X-Brain-Key", value } });
  expect("a capture-scope brain key passes", !throws(() => checkBrainKey(brain(cap), env), /./));
  expect("a write-scope brain key is refused", throws(() => checkBrainKey(brain(wr), env), /WRITE-scope/));
  expect("an unlisted brain key is refused", throws(() => checkBrainKey(brain("u".repeat(64)), env), /not in MCP_ACCESS_KEYS/));
  expect("a credential that is not a brain key is not checked", !throws(() => checkBrainKey({ type: "httpHeaderAuth", data: { name: "x-n8n-key", value: "anything" } }, env), /./));
  const tricky = 'a"b\\c\nd';
  expect("render escapes a value into JSON", JSON.parse(render('{"v":"${K}"}', { K: tricky }, "t")).v === tricky);
  expect("render refuses a name the env does not set", throws(() => render('"${MISSING}"', {}, "t"), /names MISSING/));
  const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  expect("keyExpiry reads exp", keyExpiry(jwt({ exp: 1_900_000_000 })) === 1_900_000_000);
  expect("keyExpiry is null without exp, or for a non-JWT", keyExpiry(jwt({ sub: "x" })) === null && keyExpiry("not-a-jwt") === null);
  const file = join(HERE, `.self-check.${process.pid}.env`);
  try {
    writeFileSync(file, "A=1\nN8N_API_KEY=old\nB=2\n", { mode: 0o600 });
    setEnvValue(file, "N8N_API_KEY", "new");
    setEnvValue(file, "C", "3");
    const after = readFileSync(file, "utf8");
    expect("setEnvValue replaces one line and appends another, keeping the rest", after === "A=1\nB=2\nN8N_API_KEY=new\nC=3\n");
    expect("setEnvValue keeps the file's mode", (statSync(file).mode & 0o777) === 0o600);
  } finally {
    rmSync(file, { force: true });
  }
  const declared = new Set((JSON.parse(readFileSync(PROFILE_CREDENTIALS, "utf8")) as any[]).map((c) => c.id));
  expect("credentials.template.json declares ids of 16 characters, each once", declared.size === 3 && [...declared].every((id) => /^[A-Za-z0-9]{16}$/.test(id)));
  for (const t of templatesIn(PROFILE_TEMPLATES)) {
    for (const node of JSON.parse(readFileSync(t, "utf8")).nodes ?? []) {
      for (const cred of Object.values(node.credentials ?? {}) as any[]) expect(`${t}: node "${node.name}" names credential ${cred.id}, which credentials.template.json declares`, declared.has(cred.id));
    }
  }
  for (const f of fails) console.error(`FAIL ${f}`);
  console.log(fails.length ? `provision self-check: ${fails.length} failed` : "provision self-check: OK");
  return fails.length ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(selfCheck());

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const unknown = args.filter((a, i) => a.startsWith("--") && !["--env-file", "--rotate", "--url"].includes(a) && !["--env-file", "--url"].includes(args[i - 1]));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\nusage: bun deploy/orchestration/provision.ts [--env-file deploy/.env] [--rotate] [--url http://127.0.0.1:5678]`);
    process.exit(2);
  }
  const envFile = resolve(flag("env-file") ?? join(HERE, "..", ".env"));
  if (!existsSync(envFile)) {
    console.error(`${envFile} does not exist — the profile's keys live in the stack's env file (deploy/.env; --env-file names another)`);
    process.exit(2);
  }
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const base = flag("url") ?? `http://127.0.0.1:${env.N8N_PORT || "5678"}`;
  try {
    await waitReady(base);
    const { steps } = await provision({ base, env, envFile, credentials: [PROFILE_CREDENTIALS], workflows: templatesIn(PROFILE_TEMPLATES), rotate: args.includes("--rotate") });
    console.log(`n8n at ${base} provisioned:\n  ${steps.join("\n  ")}`);
  } catch (e) {
    console.error(`provision failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
