#!/usr/bin/env bun
/**
 * provision.ts — the `orchestration` profile's one provisioning step (SMD-2210).
 *
 *   bun deploy/orchestration/provision.ts --init     # once, before the first start: the profile's secrets into deploy/.env
 *   podman compose -f deploy/compose.yaml --profile orchestration up -d
 *   bun deploy/orchestration/provision.ts [--env-file deploy/.env] [--rotate] [--url http://127.0.0.1:5678]
 *   bun deploy/orchestration/provision.ts --self-check    # the rules, against a fake n8n (CI)
 *
 * `--init` writes the secrets the profile needs, where the env file has none:
 * N8N_ENCRYPTION_KEY, N8N_OWNER_PASSWORD, its bcrypt hash
 * N8N_OWNER_PASSWORD_HASH, N8N_MCP_KEY and N8N_WEBHOOK_KEY. It never replaces
 * a value, except a hash that no longer matches the password. n8n sets its
 * owner from the environment at every start (N8N_INSTANCE_OWNER_MANAGED_BY_ENV).
 * So the owner exists from the first boot, and nobody who reaches the port
 * before provisioning runs can claim it.
 *
 * A provisioning run is an upsert, run from a checkout against n8n's loopback
 * port after the profile is up, and again after any change to deploy/.env's
 * orchestration keys or to a template.
 *
 * The one step outside n8n's public API is the key. The public API cannot
 * mint its own key, so a run signs in as the owner and mints one through the
 * internal endpoints the editor uses (`/rest/login`, `/rest/api-keys`). The
 * key carries the scopes the caller asks for (SCOPES; the eval kit adds its
 * run-history reads). It expires after N8N_API_KEY_DAYS (90), and is kept in
 * the env file with its id (N8N_API_KEY, N8N_API_KEY_ID). A later run reuses
 * it. It mints again when:
 * - n8n refuses the key;
 * - the key has less than a week left (half its life, for a short one);
 * - the key lacks a scope the caller asks for;
 * - or with --rotate.
 * Every run deletes every other key this script minted, which is n8n's
 * revocation: the old key answers 401 from then on. That includes one a
 * previous run failed to delete. Every mint signs in as the owner, so
 * N8N_OWNER_PASSWORD is the profile's standing secret, stronger than the key.
 *
 * Everything else goes through `/api/v1`. Credentials are created or patched
 * from the credential templates, with values read from the env file. They
 * land in n8n's encrypted store, and no workflow reads a secret from its
 * environment (N8N_BLOCK_ENV_ACCESS_IN_NODE). Workflows are created or
 * replaced from the templates, then published. A replaced workflow loses any
 * edit made in the editor: the template is the source.
 *
 * Nothing is written until every template checks out:
 * - A value that is a brain key (its hash in MCP_ACCESS_KEYS, or the legacy
 *   MCP_ACCESS_KEY, which is write) must sit in a credential that declares a
 *   `brainScope`. The key's scope must equal that declared scope, and it is
 *   never write.
 * - Every credential id a workflow names must be declared.
 *
 * Nothing secret is printed. The eval kit imports this module and provisions
 * through it (evals/orchestration/n8n.ts), so the kit tests these bytes.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../../db/env.ts";
import { hashKey, parseKeyRecords, type Scope } from "../../server-portable/auth.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** The profile's own credentials — the keys its templates reference by placeholder id. */
export const PROFILE_CREDENTIALS = join(HERE, "credentials.template.json");
/** The profile's workflow templates (SMD-2212 adds the first); none yet is not an error. */
export const PROFILE_TEMPLATES = join(HERE, "templates");

/**
 * What provisioning calls, out of the 106 scopes n8n 2.40.6 offers (measured):
 * credentials and workflows, nothing else. A caller that reads run history
 * (the eval kit) asks for execution:list and execution:read on top.
 */
export const SCOPES = [
  "credential:create", "credential:list", "credential:update",
  "workflow:create", "workflow:list", "workflow:read", "workflow:update", "workflow:activate",
];
/** Every key this script mints carries this label prefix. A run revokes the others with it, never a key someone made by hand. */
export const KEY_LABEL = "ob1-provision";
const DEFAULT_KEY_DAYS = 90;
const RENEW_WITHIN_DAYS = 7;
export const DEFAULT_OWNER_EMAIL = "operator@ob1.local";

export type Options = {
  /** n8n's origin, e.g. http://127.0.0.1:5678. */
  base: string;
  /** The env file's values: owner password, keys, template variables. */
  env: Record<string, string>;
  /** Where N8N_API_KEY is kept; a mint rewrites those lines. */
  envFile: string;
  /** Credential template files, in order; a later file may not reuse a name. */
  credentials: string[];
  /** Workflow template files. */
  workflows: string[];
  /** Mint a new key even when the stored one is good, and revoke the rest. */
  rotate?: boolean;
  /** Scopes beyond SCOPES this caller needs (the kit: its run-history reads). */
  extraScopes?: string[];
};

export type KeyResult = { key: string; minted: boolean; revoked: number; expiresAt: number | null };

/**
 * Replace or append one KEY=value line, written beside the file and renamed
 * over it so a crash cannot truncate the operator's secrets. A value holding
 * `$`, `#` or whitespace is single-quoted. Compose reads a quoted value
 * literally, and an unquoted bcrypt hash reached the container mangled
 * (measured). A new file is 0600.
 */
export function setEnvValue(file: string, key: string, value: string): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n").filter((l) => !l.startsWith(`${key}=`));
  if (lines.at(-1) === "") lines.pop();
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  if (value.includes("'")) throw new Error(`setEnvValue: ${key}'s value holds a single quote, which the env file cannot carry quoted`);
  const line = /[$#\s"]/.test(value) ? `${key}='${value}'` : `${key}=${value}`;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, [...lines, line, ""].join("\n"), { mode });
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

/**
 * `--init`: the profile's secrets, written where the env file has none. The
 * hash is re-derived when it does not match the password; an operator who
 * changes the password runs this again, then restarts n8n. Returns the names
 * written, never the values.
 */
export async function initSecrets(envFile: string): Promise<string[]> {
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const hex = (n: number) => randomBytes(n).toString("hex");
  const written: string[] = [];
  const put = (k: string, v: string) => { setEnvValue(envFile, k, v); env[k] = v; written.push(k); };
  if (!env.N8N_ENCRYPTION_KEY) put("N8N_ENCRYPTION_KEY", hex(32));
  // n8n wants a capital and a number in the owner's password.
  if (!env.N8N_OWNER_PASSWORD) put("N8N_OWNER_PASSWORD", `Ob1-${hex(12)}`);
  const hash = env.N8N_OWNER_PASSWORD_HASH;
  if (!hash || !(await Bun.password.verify(env.N8N_OWNER_PASSWORD, hash).catch(() => false))) {
    put("N8N_OWNER_PASSWORD_HASH", await Bun.password.hash(env.N8N_OWNER_PASSWORD, { algorithm: "bcrypt", cost: 10 }));
  }
  if (!env.N8N_MCP_KEY) put("N8N_MCP_KEY", hex(32));
  if (!env.N8N_WEBHOOK_KEY) put("N8N_WEBHOOK_KEY", hex(32));
  return written;
}

/** Signed in as the owner n8n set from the environment: the session cookie the internal endpoints take. */
async function ownerSession(base: string, env: Record<string, string>): Promise<string> {
  const password = env.N8N_OWNER_PASSWORD;
  if (!password) throw new Error("N8N_OWNER_PASSWORD is not set in the env file — run `bun deploy/orchestration/provision.ts --init` (deploy/README.md, \"Orchestration\")");
  // Checked here first: n8n's owner is the hash, and a hash out of step with
  // the password would otherwise read as n8n refusing the password.
  if (env.N8N_OWNER_PASSWORD_HASH && !(await Bun.password.verify(password, env.N8N_OWNER_PASSWORD_HASH).catch(() => false))) {
    throw new Error("N8N_OWNER_PASSWORD_HASH does not match N8N_OWNER_PASSWORD — run --init to re-derive it, then restart n8n (compose --profile orchestration up -d n8n), which sets the owner from it");
  }
  const email = env.N8N_OWNER_EMAIL || DEFAULT_OWNER_EMAIL;
  const login = await fetch(`${base}/rest/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ emailOrLdapLoginId: email, password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status === 429) throw new Error(`n8n rate-limits sign-in (5 a minute per email, n8n 2.40.6) and answered 429 — wait a minute and run again`);
  if (!login.ok || !cookie) {
    throw new Error(`n8n sign-in as ${email} failed (${login.status}): n8n sets its owner from N8N_OWNER_EMAIL and N8N_OWNER_PASSWORD_HASH at start — if either changed since n8n started, restart it; an instance not managed that way has an owner of its own`);
  }
  return cookie;
}

type ListedKey = { id: string; label: string; expiresAt: number | null };
/** The owner's keys whose label contains KEY_LABEL (n8n's filter is a substring match; callers check the prefix). The list is paginated: one page of 250. */
async function listKeys(base: string, session: Record<string, string>): Promise<ListedKey[]> {
  const listed = await call(base, `/rest/api-keys?take=250&ownership=mine&label=${KEY_LABEL}`, { headers: session }, "list keys");
  const items = listed?.data?.items;
  if (!Array.isArray(items)) throw new Error(`list keys: n8n answered without data.items (${JSON.stringify(Object.keys(listed?.data ?? listed ?? {}))}) — the internal endpoint changed shape; re-run the eval kit against this image`);
  return items.map((k: any) => ({ id: String(k.id), label: String(k.label ?? ""), expiresAt: k.expiresAt ?? null }));
}

/** Delete every key this script minted except `keep`: n8n's revocation. Returns how many went. */
async function revokeOthers(base: string, session: Record<string, string>, keep: string): Promise<number> {
  const stale = (await listKeys(base, session)).filter((k) => k.label.startsWith(KEY_LABEL) && k.id !== keep);
  for (const k of stale) await call(base, `/rest/api-keys/${k.id}`, { method: "DELETE", headers: session }, "revoke key");
  return stale.length;
}

/** The keys this script minted that n8n still holds, as the owner sees them: after a run, exactly one. */
export async function provisionedKeys(base: string, env: Record<string, string>): Promise<ListedKey[]> {
  const session = { ...JSON_HEADERS, cookie: await ownerSession(base, env) };
  return (await listKeys(base, session)).filter((k) => k.label.startsWith(KEY_LABEL));
}

const wanted = (o: Options) => [...SCOPES, ...(o.extraScopes ?? [])];

/**
 * The stored key if n8n honours it, it covers the scopes asked for, and it is
 * not near its end. Otherwise a new one, written to the env file (with its id
 * and scopes) before any old key is revoked, so a run cut short never leaves
 * the file without a working key. Only a 401 or 403 counts as "not honoured".
 * A 503 while n8n starts, or a 429, is an error, not a reason to mint. No
 * sign-in on the reuse path: `provision` sweeps, not every caller.
 */
export async function ensureApiKey(o: Options): Promise<KeyResult> {
  const days = Number(o.env.N8N_API_KEY_DAYS || DEFAULT_KEY_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`N8N_API_KEY_DAYS must be a positive number of days, got "${o.env.N8N_API_KEY_DAYS}"`);
  const stored = o.env.N8N_API_KEY;
  const covers = wanted(o).every((s) => (o.env.N8N_API_KEY_SCOPES ?? "").split(",").includes(s));
  if (stored && !o.rotate && covers) {
    const probe = await fetch(`${o.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": stored } });
    const exp = keyExpiry(stored);
    // A week, or half the key's life when N8N_API_KEY_DAYS is shorter than two:
    // a 3-day key would otherwise be re-minted on every run.
    const fresh = exp === null || exp - Date.now() / 1000 > Math.min(RENEW_WITHIN_DAYS, days / 2) * 86400;
    if (probe.ok && fresh) return { key: stored, minted: false, revoked: 0, expiresAt: exp };
    if (!probe.ok && probe.status !== 401 && probe.status !== 403) throw new Error(`n8n's API answered ${probe.status} to the stored key; not minting another`);
  }
  const session = { ...JSON_HEADERS, cookie: await ownerSession(o.base, o.env) };
  const expiresAt = Math.floor(Date.now() / 1000 + days * 86400);
  const minted = await call(o.base, "/rest/api-keys", {
    method: "POST", headers: session,
    body: JSON.stringify({ label: `${KEY_LABEL}-${new Date().toISOString()}`, scopes: wanted(o), expiresAt }),
  }, "mint key");
  const key: string = minted.data.rawApiKey;
  const id = String(minted.data.id);
  setEnvValue(o.envFile, "N8N_API_KEY", key);
  setEnvValue(o.envFile, "N8N_API_KEY_ID", id);
  setEnvValue(o.envFile, "N8N_API_KEY_SCOPES", wanted(o).join(","));
  Object.assign(o.env, { N8N_API_KEY: key, N8N_API_KEY_ID: id, N8N_API_KEY_SCOPES: wanted(o).join(",") });
  return { key, minted: true, revoked: await revokeOthers(o.base, session, id), expiresAt: keyExpiry(key) ?? expiresAt };
}

/** A template's `${NAME}` placeholders filled from the env. The rendered text is never written to disk. */
function render(template: string, env: Record<string, string>, file: string): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${file} names ${k}, which the env file does not set`);
    return JSON.stringify(v).slice(1, -1);
  });
}

/** Every string anywhere under a value. */
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

/**
 * The brain-key rule. Any string in a credential whose hash is a brain key
 * makes it a brain credential, whatever the credential's type or header. It
 * must declare `brainScope` (capture or read), and the key's scope must be
 * exactly that. A declared brain credential whose key is not listed would
 * fail at run time, so it is refused too. The legacy single MCP_ACCESS_KEY
 * is write scope (server-portable/auth.ts). No workflow holds a write key
 * (decision 4 of docs/orchestration-tool.md), and ingestion's credential
 * cannot silently carry a read key (decision 7).
 */
export function checkBrainKey(credential: any, env: Record<string, string>): void {
  const records: { name: string; scope: Scope; sha256: string }[] = [...parseKeyRecords(env.MCP_ACCESS_KEYS ?? "").keys];
  if (env.MCP_ACCESS_KEY) records.push({ name: "MCP_ACCESS_KEY (legacy)", scope: "write", sha256: hashKey(env.MCP_ACCESS_KEY) });
  const declared: string | undefined = credential.brainScope;
  const hits = strings(credential.data).map(hashKey).flatMap((h) => records.filter((r) => r.sha256 === h));
  for (const r of hits) {
    if (r.scope === "write") throw new Error(`credential "${credential.name}": it holds ${r.name}, a WRITE-scope brain key — a workflow holds a capture key (or, for an eval's read tool, a read key), never a write key`);
    if (!declared) throw new Error(`credential "${credential.name}": it holds the brain key ${r.name} (${r.scope}) but declares no brainScope — add "brainScope": "${r.scope}" to its template, deliberately`);
    if (r.scope !== declared) throw new Error(`credential "${credential.name}" declares brainScope ${declared} and holds ${r.name}, a ${r.scope}-scope key — mint a ${declared} key (server-portable/keygen.ts --scope ${declared})`);
  }
  if (declared && hits.length === 0) throw new Error(`credential "${credential.name}": its brain key's hash is not in MCP_ACCESS_KEYS — mint it with server-portable/keygen.ts --scope ${declared} and add the line keygen prints`);
}

/** Every credential id a workflow's nodes name must be one the credential templates declare. Returns the problems. */
export function undeclaredCredentials(workflow: any, declared: Set<string>, file: string): string[] {
  return (workflow.nodes ?? []).flatMap((node: any) => (Object.values(node.credentials ?? {}) as any[])
    .filter((c) => !declared.has(c.id))
    .map((c) => `${file}: node "${node.name}" names credential ${c.id}, which no credential template declares`));
}

/** Workflow template files under a directory, sorted; none when it does not exist. */
export function templatesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f));
}

/**
 * The whole step: check every template, then the key, the sweep,
 * credentials, workflows and publish. Returns what it did, for the summary.
 * Prints nothing secret.
 */
export async function provision(o: Options): Promise<{ steps: string[]; key: KeyResult }> {
  // Everything read and checked before anything is written.
  const creds: { file: string; c: any }[] = [];
  for (const file of o.credentials) for (const c of JSON.parse(render(readFileSync(file, "utf8"), o.env, file))) creds.push({ file, c });
  const names = new Set<string>();
  for (const { file, c } of creds) {
    if (names.has(c.name)) throw new Error(`${file}: credential "${c.name}" is named twice across the credential files`);
    names.add(c.name);
    checkBrainKey(c, o.env);
  }
  const declared = new Set(creds.map(({ c }) => c.id as string));
  const flows = o.workflows.map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const problems = flows.flatMap(({ file, text }) => undeclaredCredentials(JSON.parse(text), declared, file));
  if (problems.length) throw new Error(problems.join("; "));

  let key = await ensureApiKey(o);
  if (!key.minted) {
    // The sweep: a key a previous run minted and then failed to delete is
    // still valid. Without the stored key's id, the one to keep is unknown,
    // so the run mints a fresh one, which revokes the rest.
    if (!o.env.N8N_API_KEY_ID) key = await ensureApiKey({ ...o, rotate: true });
    else key = { ...key, revoked: await revokeOthers(o.base, { ...JSON_HEADERS, cookie: await ownerSession(o.base, o.env) }, o.env.N8N_API_KEY_ID) };
  }
  const k = key.key;
  const existing = new Map(((await api(o.base, k, "GET", "/credentials?limit=250")).data as any[]).map((c) => [c.name as string, c.id as string]));
  const ids = new Map<string, string>();
  const n = { created: 0, patched: 0, workflowsCreated: 0, workflowsReplaced: 0 };
  for (const { c } of creds) {
    let id = existing.get(c.name);
    // Patched every run, not kept: a key rotated in the env file reaches
    // n8n's store on the next run instead of waiting for a volume reset.
    if (id) { await api(o.base, k, "PATCH", `/credentials/${id}`, { name: c.name, type: c.type, data: c.data }); n.patched++; }
    else { id = (await api(o.base, k, "POST", "/credentials", { name: c.name, type: c.type, data: c.data })).id; n.created++; }
    ids.set(c.id, id as string);
  }
  for (const { text: raw } of flows) {
    let text = raw;
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
      `${key.minted ? "API key minted through the internal /rest endpoints" : "API key reused"} (expires ${expires}; ${key.revoked} earlier revoked)`,
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
 * A fake n8n for the self-check: the endpoints provisioning calls, with keys
 * as JWT-shaped strings whose `exp` it chooses, and a switch per failure. It
 * holds state: the keys it holds, and the sign-ins and deletes it saw.
 */
function fakeN8n() {
  const s = {
    keys: new Map<string, { raw: string; label: string }>(), logins: 0, deletes: 0, probeStatus: 0, loginStatus: 200, next: 1,
    jwt: (exp: number | null) => `h.${Buffer.from(JSON.stringify(exp === null ? { sub: "o" } : { sub: "o", exp })).toString("base64url")}.s${s.next++}`,
    add(label: string, exp: number | null) { const id = `k${s.next}`; const raw = s.jwt(exp); s.keys.set(id, { raw, label }); return { id, raw }; },
  };
  const valid = (raw: string | null) => [...s.keys.values()].some((k) => k.raw === raw);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const j = (b: unknown, status = 200) => Response.json(b, { status });
      if (u.pathname === "/rest/login") { s.logins++; return s.loginStatus === 200 ? new Response("{}", { headers: { "set-cookie": "n8n-auth=x; Path=/" } }) : new Response("no", { status: s.loginStatus }); }
      if (u.pathname === "/rest/api-keys" && req.method === "POST") {
        const b = await req.json() as any; const { id, raw } = s.add(b.label, b.expiresAt);
        return j({ data: { id, rawApiKey: raw } });
      }
      if (u.pathname === "/rest/api-keys") return j({ data: { items: [...s.keys].map(([id, k]) => ({ id, label: k.label })) } });
      if (u.pathname.startsWith("/rest/api-keys/") && req.method === "DELETE") { s.deletes++; s.keys.delete(u.pathname.split("/").pop()!); return j({ data: { success: true } }); }
      if (u.pathname.startsWith("/api/v1/")) {
        if (s.probeStatus) return new Response("busy", { status: s.probeStatus });
        if (!valid(req.headers.get("x-n8n-api-key"))) return new Response("unauthorized", { status: 401 });
        if (u.pathname === "/api/v1/credentials" && req.method === "POST") return j({ id: `c${s.next++}` });
        if (u.pathname === "/api/v1/workflows" && req.method === "POST") return j({ id: `w${s.next++}` });
        return j({ data: [] });
      }
      return new Response("not here", { status: 404 });
    },
  });
  return { s, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * `--self-check`, with no real n8n and no network. It covers:
 * - the brain-key rule;
 * - the renderer's escaping and missing names;
 * - the expiry reader;
 * - the env writer's replace, append, quoting and modes;
 * - `--init`;
 * - every shipped template's credential ids, the profile's and the kit's;
 * - the key decisions against a fake n8n: reuse, renewal, a refused key, a
 *   busy n8n, rotation, missing scopes, the sweep of a key a failed run left,
 *   and a rate-limited sign-in.
 */
async function selfCheck(): Promise<number> {
  const fails: string[] = [];
  const expect = (what: string, ok: boolean) => { if (!ok) fails.push(what); };
  const throws = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (e) { return re.test(String((e as Error).message)); } };
  const rejects = async (fn: () => Promise<unknown>, re: RegExp) => { try { await fn(); return false; } catch (e) { return re.test(String((e as Error).message)); } };

  const cap = "c".repeat(64), rd = "r".repeat(64), wr = "w".repeat(64), legacy = "l".repeat(64);
  const env = { MCP_ACCESS_KEYS: `n8n:capture:${hashKey(cap)},eval:read:${hashKey(rd)},laptop:write:${hashKey(wr)}`, MCP_ACCESS_KEY: legacy };
  const brain = (value: string, brainScope?: string, type = "httpHeaderAuth") => ({ name: "b", type, brainScope, data: { name: "X-Brain-Key", value } });
  expect("a capture key in a capture credential passes", !throws(() => checkBrainKey(brain(cap, "capture"), env), /./));
  expect("a read key in a read credential passes", !throws(() => checkBrainKey(brain(rd, "read"), env), /./));
  expect("a write key is refused", throws(() => checkBrainKey(brain(wr, "capture"), env), /WRITE-scope/));
  expect("the legacy MCP_ACCESS_KEY is refused as write", throws(() => checkBrainKey(brain(legacy, "capture"), env), /WRITE-scope/));
  expect("a read key in a capture credential is refused", throws(() => checkBrainKey(brain(rd, "capture"), env), /declares brainScope capture and holds eval, a read-scope key/));
  expect("a brain key in a credential that declares no brainScope is refused", throws(() => checkBrainKey(brain(cap), env), /declares no brainScope/));
  expect("a brain key under another type or field name is still seen", throws(() => checkBrainKey({ name: "q", type: "httpQueryAuth", data: { name: "key", value: wr } }, env), /WRITE-scope/));
  expect("a declared brain credential with an unlisted key is refused", throws(() => checkBrainKey(brain("u".repeat(64), "capture"), env), /not in MCP_ACCESS_KEYS/));
  expect("a credential holding no brain key and declaring none passes", !throws(() => checkBrainKey({ name: "x", type: "httpHeaderAuth", data: { name: "x-n8n-key", value: "anything" } }, env), /./));

  const tricky = 'a"b\\c\nd';
  expect("render escapes a value into JSON", JSON.parse(render('{"v":"${K}"}', { K: tricky }, "t")).v === tricky);
  expect("render refuses a name the env does not set", throws(() => render('"${MISSING}"', {}, "t"), /names MISSING/));
  const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  expect("keyExpiry reads exp", keyExpiry(jwt({ exp: 1_900_000_000 })) === 1_900_000_000);
  expect("keyExpiry is null without exp, or for a non-JWT", keyExpiry(jwt({ sub: "x" })) === null && keyExpiry("not-a-jwt") === null);

  const file = join(HERE, `.self-check.${process.pid}.env`);
  const fresh = join(HERE, `.self-check.${process.pid}.new.env`);
  try {
    writeFileSync(file, "A=1\nN8N_API_KEY=old\nB=2\n", { mode: 0o640 });
    setEnvValue(file, "N8N_API_KEY", "new");
    setEnvValue(file, "C", "3");
    setEnvValue(file, "H", "$2b$10$abc");
    expect("setEnvValue replaces one line, appends others, quotes a `$` value, keeps the rest", readFileSync(file, "utf8") === "A=1\nB=2\nN8N_API_KEY=new\nC=3\nH='$2b$10$abc'\n");
    expect("setEnvValue keeps an existing file's mode", (statSync(file).mode & 0o777) === 0o640);
    expect("parseEnv reads the quoted value back literally", parseEnv(readFileSync(file, "utf8")).H === "$2b$10$abc");
    setEnvValue(fresh, "K", "v");
    expect("setEnvValue makes a new file 0600", (statSync(fresh).mode & 0o777) === 0o600);
    rmSync(fresh, { force: true });
    writeFileSync(fresh, "N8N_MCP_KEY=keep-me\n", { mode: 0o600 });
    const first = await initSecrets(fresh);
    const second = await initSecrets(fresh);
    const got = parseEnv(readFileSync(fresh, "utf8"));
    expect("--init writes what is missing and keeps what is set", first.join() === "N8N_ENCRYPTION_KEY,N8N_OWNER_PASSWORD,N8N_OWNER_PASSWORD_HASH,N8N_WEBHOOK_KEY" && got.N8N_MCP_KEY === "keep-me");
    expect("--init's hash is bcrypt and verifies the password", /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(got.N8N_OWNER_PASSWORD_HASH) && await Bun.password.verify(got.N8N_OWNER_PASSWORD, got.N8N_OWNER_PASSWORD_HASH));
    expect("--init a second time writes nothing", second.length === 0);
    setEnvValue(fresh, "N8N_OWNER_PASSWORD", "Ob1-changed-9");
    expect("--init re-derives a hash that no longer matches the password", (await initSecrets(fresh)).join() === "N8N_OWNER_PASSWORD_HASH");
  } finally {
    rmSync(file, { force: true });
    rmSync(fresh, { force: true });
  }

  // Every shipped template's credential ids: the profile's, and the kit's against both credential files.
  const idsOf = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as any[]).map((c) => c.id as string);
  const profileIds = idsOf(PROFILE_CREDENTIALS);
  expect("credentials.template.json declares ids of 16 characters, each once", new Set(profileIds).size === profileIds.length && profileIds.every((id) => /^[A-Za-z0-9]{16}$/.test(id)));
  const KIT = join(HERE, "..", "..", "evals", "orchestration", "n8n");
  const kitIds = existsSync(join(KIT, "credentials.template.json")) ? idsOf(join(KIT, "credentials.template.json")) : [];
  const declaredIds = new Set([...profileIds, ...kitIds]);
  const shipped = [...templatesIn(PROFILE_TEMPLATES), ...templatesIn(KIT).filter((f) => !f.endsWith("credentials.template.json"))];
  expect("there is a shipped template to check (the kit's, until SMD-2212's)", shipped.length > 0);
  for (const t of shipped) for (const p of undeclaredCredentials(JSON.parse(readFileSync(t, "utf8")), declaredIds, t)) fails.push(p);
  expect("an undeclared credential id is reported", undeclaredCredentials({ nodes: [{ name: "n", credentials: { x: { id: "nope" } } }] }, declaredIds, "t").length === 1);

  // The key decisions, against a fake n8n.
  const f = fakeN8n();
  const keyFile = join(HERE, `.self-check.${process.pid}.keys.env`);
  try {
    const now = Math.floor(Date.now() / 1000);
    const opts = (env: Record<string, string>, more: Partial<Options> = {}): Options => ({ base: f.base, env, envFile: keyFile, credentials: [], workflows: [], ...more });
    const base = { N8N_OWNER_PASSWORD: "Ob1-pw-1" };
    writeFileSync(keyFile, "", { mode: 0o600 });
    const e1: Record<string, string> = { ...base };
    const r1 = await ensureApiKey(opts(e1));
    const saved = parseEnv(readFileSync(keyFile, "utf8"));
    expect("no stored key: a mint, kept with its id and scopes, expiring in 90 days", r1.minted && saved.N8N_API_KEY === r1.key && saved.N8N_API_KEY_ID !== undefined && saved.N8N_API_KEY_SCOPES === SCOPES.join(",") && Math.abs((r1.expiresAt ?? 0) - (now + 90 * 86400)) < 60);
    const logins = f.s.logins;
    const r2 = await ensureApiKey(opts({ ...base, ...saved }));
    expect("a good stored key is reused without a sign-in", !r2.minted && r2.key === r1.key && f.s.logins === logins);
    const r3 = await ensureApiKey(opts({ ...base, ...saved, N8N_API_KEY: "h.e30.forged" }));
    expect("a refused key: a mint, and the rest revoked", r3.minted && f.s.keys.size === 1 && r3.revoked === 1);
    const near = f.s.add(`${KEY_LABEL}-near`, now + 3 * 86400);
    const r4 = await ensureApiKey(opts({ ...base, N8N_API_KEY: near.raw, N8N_API_KEY_ID: near.id, N8N_API_KEY_SCOPES: SCOPES.join(",") }));
    expect("a key with 3 of 90 days left is renewed", r4.minted);
    const shortKey = f.s.add(`${KEY_LABEL}-short`, now + 2.5 * 86400);
    const r5 = await ensureApiKey(opts({ ...base, N8N_API_KEY_DAYS: "3", N8N_API_KEY: shortKey.raw, N8N_API_KEY_ID: shortKey.id, N8N_API_KEY_SCOPES: SCOPES.join(",") }));
    expect("a 3-day key with 2.5 days left is kept, not re-minted each run", !r5.minted);
    const cur = parseEnv(readFileSync(keyFile, "utf8"));
    const r6 = await ensureApiKey(opts({ ...base, ...cur }, { extraScopes: ["execution:list", "execution:read"] }));
    expect("a key without a scope the caller asks for is replaced by one with it", r6.minted && parseEnv(readFileSync(keyFile, "utf8")).N8N_API_KEY_SCOPES.endsWith("execution:read"));
    f.s.probeStatus = 503;
    expect("a busy n8n (503) is an error, not a mint", await rejects(() => ensureApiKey(opts({ ...base, ...parseEnv(readFileSync(keyFile, "utf8")) }, { extraScopes: ["execution:list", "execution:read"] })), /answered 503.*not minting/));
    f.s.probeStatus = 0;
    const r7 = await ensureApiKey(opts({ ...base, ...parseEnv(readFileSync(keyFile, "utf8")) }, { rotate: true }));
    expect("--rotate mints and revokes the key it replaces", r7.minted && r7.revoked >= 1 && f.s.keys.size === 1);
    // A previous run minted and failed to delete: a stale key beside the stored one. A plain provision sweeps it.
    f.s.add(`${KEY_LABEL}-left-behind`, now + 80 * 86400);
    const handMade = f.s.add("made-by-hand", now + 80 * 86400);
    const r8 = await provision(opts({ ...base, ...parseEnv(readFileSync(keyFile, "utf8")) }));
    expect("a plain run sweeps a key a failed run left, and keeps a hand-made one", !r8.key.minted && r8.key.revoked === 1 && f.s.keys.size === 2 && f.s.keys.has(handMade.id));
    const noId = parseEnv(readFileSync(keyFile, "utf8"));
    delete noId.N8N_API_KEY_ID;
    const r9 = await provision(opts({ ...base, ...noId }));
    expect("a stored key without its id is replaced, so the sweep knows what to keep", r9.key.minted);
    f.s.loginStatus = 429;
    expect("a rate-limited sign-in says so, not 'wrong password'", await rejects(() => ensureApiKey(opts({ ...base }, { rotate: true })), /rate-limits sign-in/));
    f.s.loginStatus = 200;
    const otherHash = await Bun.password.hash("other", { algorithm: "bcrypt", cost: 4 });
    expect("a hash out of step with the password is refused before any sign-in", await rejects(() => ensureApiKey(opts({ ...base, N8N_OWNER_PASSWORD_HASH: otherHash }, { rotate: true })), /does not match N8N_OWNER_PASSWORD/));
  } finally {
    f.stop();
    rmSync(keyFile, { force: true });
  }

  for (const x of fails) console.error(`FAIL ${x}`);
  console.log(fails.length ? `provision self-check: ${fails.length} failed` : "provision self-check: OK");
  return fails.length ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const usage = "usage: bun deploy/orchestration/provision.ts [--init] [--env-file deploy/.env] [--rotate] [--url http://127.0.0.1:5678]";
  const unknown = args.filter((a, i) => a.startsWith("--") && !["--env-file", "--rotate", "--url", "--init"].includes(a) && !["--env-file", "--url"].includes(args[i - 1]));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n${usage}`);
    process.exit(2);
  }
  const envFile = resolve(flag("env-file") ?? join(HERE, "..", ".env"));
  if (!existsSync(envFile)) {
    console.error(`${envFile} does not exist — the profile's keys live in the stack's env file (deploy/.env; --env-file names another)`);
    process.exit(2);
  }
  if (args.includes("--init")) {
    const written = await initSecrets(envFile);
    console.log(written.length ? `wrote ${written.join(", ")} to ${envFile}` : `${envFile} already holds the profile's secrets`);
    const env = parseEnv(readFileSync(envFile, "utf8"));
    if (!env.N8N_BRAIN_CAPTURE_KEY) console.log("still needed: N8N_BRAIN_CAPTURE_KEY — cd server-portable && bun keygen.ts --name n8n --scope capture; the key into N8N_BRAIN_CAPTURE_KEY, the line it prints into MCP_ACCESS_KEYS (and restart the server)");
    console.log("back up N8N_ENCRYPTION_KEY and N8N_OWNER_PASSWORD with POSTGRES_PASSWORD; if n8n was running, restart it (compose --profile orchestration up -d n8n)");
    process.exit(0);
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
