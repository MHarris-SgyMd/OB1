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
 * run-history reads). It expires after N8N_API_KEY_DAYS (90). It is kept in
 * the env file with its id, scopes, the file's tag, and the fingerprint the
 * tag was made for (N8N_API_KEY, _ID, _SCOPES, _TAG, _TAG_OF), all written
 * at once. A later run reuses it. It mints again when:
 * - n8n refuses the key;
 * - the key has less than a week left (half its life, for a short one);
 * - its scopes are not exactly the ones asked for;
 * - its id is not one n8n lists as this file's key;
 * - or with --rotate.
 * Every provisioning run deletes every other key THIS env file minted (its
 * tag in the label), which is n8n's revocation: the old key answers 401 from
 * then on. That includes one a previous run failed to delete. A second env
 * file provisioning the same n8n keeps its own key, a copy of this one
 * included (it mints under a tag of its own). Every mint signs in as
 * the owner, so N8N_OWNER_PASSWORD is the profile's standing secret,
 * stronger than the key. A password over 72 bytes is refused: bcrypt reads
 * no further.
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
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
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
/** Every key this script mints carries this label prefix, then the env file's tag. A run revokes the others with its tag, never a key someone made by hand. */
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
  /** Revoke the live keys of a tag this file carries but was not made for (a moved file's old keys). */
  adopt?: boolean;
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
  setEnvValues(file, { [key]: value });
}

/**
 * Several lines in one write, so values that must agree (the key, its id,
 * its scopes, its tag) are never left half-written. A run killed between
 * separate writes left a key beside another key's id, and the next run's
 * sweep deleted the working key (review pass 2, measured). A line to replace
 * may carry `export ` or spaces around `=`.
 */
export function setEnvValues(given: string, values: Record<string, string>): void {
  // Written through a symlink to the file it names, so the link stays a link
  // and the secrets land where the operator keeps them (review pass 4: the
  // rename replaced the link with a regular file, and the target kept a dead
  // key and no encryption key).
  const file = existsSync(given) ? realpathSync(given) : given;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const keys = Object.keys(values);
  const lines = text.split("\n").filter((l) => !keys.some((k) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l)));
  if (lines.at(-1) === "") lines.pop();
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const added = keys.map((k) => {
    const v = values[k];
    if (v.includes("'") || /[\r\n]/.test(v)) throw new Error(`setEnvValue: ${k}'s value holds a single quote or a line break, which the env file cannot carry`);
    return /[$#\s"]/.test(v) ? `${k}='${v}'` : `${k}=${v}`;
  });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, [...lines, ...added, ""].join("\n"), { mode });
  renameSync(tmp, file);
}

/** Is KEY's line in the env file single-quoted? Compose interpolates a bare or double-quoted value, and a bcrypt hash's `$`s are then read as variables. */
export function singleQuoted(file: string, key: string): boolean {
  // The LAST such line, as parseEnv and compose read it (review pass 3: the first was read, and a later bare line won).
  const line = (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l)).at(-1);
  return line === undefined || /=\s*'[^']*'\s*$/.test(line);
}

/** bcrypt reads 72 bytes. Bun pre-hashes a longer password and n8n's bcrypt truncates it, so the two would never agree. */
const MAX_PASSWORD_BYTES = 72;

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
 * changes the password runs this again, then recreates n8n. Returns the names
 * written, never the values.
 */
export async function initSecrets(envFile: string): Promise<string[]> {
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const hex = (n: number) => randomBytes(n).toString("hex");
  const written: string[] = [];
  const put = (k: string, v: string) => { setEnvValue(envFile, k, v); env[k] = v; written.push(k); };
  if (!env.N8N_ENCRYPTION_KEY) put("N8N_ENCRYPTION_KEY", hex(32));
  // n8n wants a capital and a number in the owner's password. With no
  // password at all, one is made, and the hash follows it below.
  if (!env.N8N_OWNER_PASSWORD) put("N8N_OWNER_PASSWORD", `Ob1-${hex(12)}`);
  if (Buffer.byteLength(env.N8N_OWNER_PASSWORD) > MAX_PASSWORD_BYTES) throw new Error(`N8N_OWNER_PASSWORD is over ${MAX_PASSWORD_BYTES} bytes: bcrypt reads no further, and n8n and this script would disagree about it — choose a shorter one`);
  const hash = env.N8N_OWNER_PASSWORD_HASH;
  // Re-derived when it does not match the password, and rewritten when its
  // line is not single-quoted: a hand-written bare hash reaches n8n mangled.
  if (!hash || !singleQuoted(envFile, "N8N_OWNER_PASSWORD_HASH") || !(await Bun.password.verify(env.N8N_OWNER_PASSWORD, hash).catch(() => false))) {
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
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error(`N8N_OWNER_PASSWORD is over ${MAX_PASSWORD_BYTES} bytes, which bcrypt does not read — choose a shorter one, run --init, and recreate n8n (compose --profile orchestration up -d n8n)`);
  // Checked here first: n8n's owner is the hash, and a hash out of step with
  // the password would otherwise read as n8n refusing the password.
  if (env.N8N_OWNER_PASSWORD_HASH && !(await Bun.password.verify(password, env.N8N_OWNER_PASSWORD_HASH).catch(() => false))) {
    throw new Error("N8N_OWNER_PASSWORD_HASH does not match N8N_OWNER_PASSWORD — run --init to re-derive it, then recreate n8n (compose --profile orchestration up -d n8n; a `compose restart` keeps the old hash), which sets the owner from it");
  }
  const email = env.N8N_OWNER_EMAIL || DEFAULT_OWNER_EMAIL;
  const login = await fetch(`${base}/rest/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ emailOrLdapLoginId: email, password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status === 429) throw new Error(`n8n rate-limits sign-in (5 a minute per email, n8n 2.40.6) and answered 429 — wait a minute and run again`);
  if (!login.ok || !cookie) {
    throw new Error(`n8n sign-in as ${email} failed (${login.status}): n8n sets its owner from N8N_OWNER_EMAIL and N8N_OWNER_PASSWORD_HASH at start — if either changed since n8n was created, recreate it (compose --profile orchestration up -d n8n; a 'compose restart' keeps the old values); an instance not managed that way has an owner of its own`);
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

/**
 * Is this key one THIS env file minted? Each file tags its keys
 * (N8N_API_KEY_TAG). Two files provisioning one n8n would otherwise each
 * revoke the other's key on every run (review pass 2, measured): a laptop's
 * checkout and a server's, or a copied deploy/.env. A copy carries the tag,
 * though (review pass 3, measured). So a tag counts only beside the
 * fingerprint of the file it was made for (N8N_API_KEY_TAG_OF: the machine's
 * stable id and the file's real path). A copied or moved file then mints under
 * a tag of its own and sweeps nothing it inherited. It names the old tag's
 * live keys, and --adopt revokes them (a moved file's, never a copy in use).
 */
const mine = (label: string, tag: string | undefined) => tag !== undefined && label.startsWith(`${KEY_LABEL}-${tag}-`);

/**
 * The machine's stable id, where it has one: /etc/machine-id (Linux), the
 * platform UUID (macOS). Not the hostname, which on a Mac with no HostName set
 * follows the network, and in a one-off container is random (review pass 4,
 * measured: three hostnames for one file, each a new tag and a key left live).
 * Empty where there is none, and then the path alone decides.
 */
let machine: string | undefined;
export function machineId(): string {
  if (machine !== undefined) return machine;
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const id = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    if (id) return (machine = id);
  }
  if (process.platform === "darwin") {
    const p = Bun.spawnSync(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], { stdout: "pipe", stderr: "ignore" });
    const id = /"IOPlatformUUID" = "([^"]+)"/.exec(p.stdout?.toString() ?? "")?.[1];
    if (id) return (machine = id);
  }
  return (machine = "");
}

/** The machine's id and the env file's real path, hashed: what a copy of the file, or the file moved, does not carry. */
export function fileFingerprint(envFile: string): string {
  const path = existsSync(envFile) ? realpathSync(envFile) : resolve(envFile);
  return createHash("sha256").update(`${machineId()}\0${path}`).digest("hex").slice(0, 12);
}

/** This file's own tag, or undefined when it has none or carries one made for another file. */
const ownTag = (o: Options) =>
  o.env.N8N_API_KEY_TAG && o.env.N8N_API_KEY_TAG_OF === fileFingerprint(o.envFile) ? o.env.N8N_API_KEY_TAG : undefined;

/**
 * Delete every other key this file minted: n8n's revocation. Returns how many
 * went, and whether `keep` was among the listed keys at all. A kept id n8n
 * does not list means the file's key and id disagree, and the caller mints
 * rather than trust either.
 */
async function revokeOthers(base: string, session: Record<string, string>, keep: string, tag: string | undefined): Promise<{ revoked: number; kept: boolean }> {
  const listed = await listKeys(base, session);
  const kept = listed.some((k) => k.id === keep && mine(k.label, tag));
  if (!kept) return { revoked: 0, kept };
  const stale = listed.filter((k) => mine(k.label, tag) && k.id !== keep);
  for (const k of stale) await call(base, `/rest/api-keys/${k.id}`, { method: "DELETE", headers: session }, "revoke key");
  return { revoked: stale.length, kept };
}

/** The keys this env file minted that n8n still holds, as the owner sees them: after a run, exactly one. */
export async function provisionedKeys(base: string, env: Record<string, string>, envFile: string): Promise<ListedKey[]> {
  const session = { ...JSON_HEADERS, cookie: await ownerSession(base, env) };
  const tag = env.N8N_API_KEY_TAG_OF === fileFingerprint(envFile) ? env.N8N_API_KEY_TAG : undefined;
  return (await listKeys(base, session)).filter((k) => mine(k.label, tag));
}

const wanted = (o: Options) => [...SCOPES, ...(o.extraScopes ?? [])];
/** The stored key's scopes are exactly the ones asked for: a broader key is replaced too, so a file the kit once used does not keep the kit's reads. */
const sameScopes = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

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
  const covers = sameScopes(wanted(o), (o.env.N8N_API_KEY_SCOPES ?? "").split(",").filter(Boolean));
  // A file carrying another file's tag (a copy) mints its own key rather than
  // share one: sharing is what let each file's next mint revoke the other's.
  const inherited = Boolean(o.env.N8N_API_KEY_TAG) && ownTag(o) === undefined;
  if (stored && !o.rotate && covers && !inherited) {
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
  const tag = ownTag(o) ?? randomBytes(4).toString("hex");
  const minted = await call(o.base, "/rest/api-keys", {
    method: "POST", headers: session,
    body: JSON.stringify({ label: `${KEY_LABEL}-${tag}-${new Date().toISOString()}`, scopes: wanted(o), expiresAt }),
  }, "mint key");
  const lines = {
    N8N_API_KEY: String(minted.data.rawApiKey), N8N_API_KEY_ID: String(minted.data.id), N8N_API_KEY_SCOPES: wanted(o).join(","),
    N8N_API_KEY_TAG: tag, N8N_API_KEY_TAG_OF: fileFingerprint(o.envFile),
  };
  setEnvValues(o.envFile, lines);
  Object.assign(o.env, lines);
  const { revoked } = await revokeOthers(o.base, session, lines.N8N_API_KEY_ID, tag);
  return { key: lines.N8N_API_KEY, minted: true, revoked, expiresAt: keyExpiry(lines.N8N_API_KEY) ?? expiresAt };
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
 * Every string anywhere under a value, and every token inside each. The brain
 * takes a key as `Authorization: Bearer <key>` and as `?key=<key>`
 * (server-portable/auth.ts presentedKeys), so a key inside a longer string
 * is still a key (review pass 2).
 */
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const candidates = (v: unknown) => [...new Set(strings(v).flatMap((s) => [s, ...s.split(/[\s?&=,;:"'\/#]+/)]).filter(Boolean))];

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
  const hits = candidates(credential.data).map(hashKey).flatMap((h) => records.filter((r) => r.sha256 === h));
  for (const r of hits) {
    if (r.scope === "write") throw new Error(`credential "${credential.name}": it holds ${r.name}, a WRITE-scope brain key — a workflow holds a capture key (or, for an eval's read tool, a read key), never a write key`);
    if (!declared) throw new Error(`credential "${credential.name}": it holds the brain key ${r.name} (${r.scope}) but declares no brainScope — if it is meant to carry a brain key, add "brainScope": "${r.scope}" to its template; if it is an inbound key or a vendor's, it must not reuse a brain key's value`);
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
  // Everything read and checked before anything is written. A hash line
  // compose would interpolate reaches n8n mangled, and every sign-in then
  // fails with no clue why (review pass 2).
  if (o.env.N8N_OWNER_PASSWORD_HASH && !singleQuoted(o.envFile, "N8N_OWNER_PASSWORD_HASH")) {
    throw new Error("N8N_OWNER_PASSWORD_HASH's line is not single-quoted, so compose reads its `$`s as variables and n8n gets a mangled hash — run --init, which rewrites it quoted, then recreate n8n (compose --profile orchestration up -d n8n)");
  }
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

  // A tag this file carries but was not made for: a copy, or the file moved.
  // Read before the mint below replaces it.
  const inheritedTag = o.env.N8N_API_KEY_TAG && ownTag(o) === undefined ? o.env.N8N_API_KEY_TAG : undefined;
  let key = await ensureApiKey(o);
  if (!key.minted) {
    // The sweep: a key a previous run minted and then failed to delete is
    // still valid. The stored id must be one n8n lists as this file's key:
    // without it, or with an id the listing lacks, the one to keep is
    // unknown, so the run mints a fresh key, which revokes the rest.
    const tag = ownTag(o);
    const swept = o.env.N8N_API_KEY_ID && tag
      ? await revokeOthers(o.base, { ...JSON_HEADERS, cookie: await ownerSession(o.base, o.env) }, o.env.N8N_API_KEY_ID, tag)
      : { revoked: 0, kept: false };
    key = swept.kept ? { ...key, revoked: swept.revoked } : await ensureApiKey({ ...o, rotate: true });
    // The listing is redacted, so a hand-edited file whose key and id name two
    // different live keys passes the check above, and the sweep deletes the
    // file's own key. It is probed once more, and replaced if n8n now refuses it.
    if (!key.minted) {
      const after = await fetch(`${o.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": key.key } });
      if (after.status === 401 || after.status === 403) key = await ensureApiKey({ ...o, rotate: true });
    }
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
  // The inherited tag's keys: named, so a moved file's leftovers are not
  // silent, and revoked with --adopt. A copy of a file still in use must NOT
  // adopt: that would revoke the original's key.
  const inheritedNote: string[] = [];
  if (inheritedTag) {
    const session = { ...JSON_HEADERS, cookie: await ownerSession(o.base, o.env) };
    const live = (await listKeys(o.base, session)).filter((l) => mine(l.label, inheritedTag));
    if (o.adopt) for (const l of live) await call(o.base, `/rest/api-keys/${l.id}`, { method: "DELETE", headers: session }, "revoke key");
    inheritedNote.push(o.adopt
      ? `adopted tag ${inheritedTag} (made for another path or machine): ${live.length} of its keys revoked`
      : `this file carried tag ${inheritedTag}, made for another path or machine, and now has its own; ${live.length} key(s) under the old tag still live — if this file was moved rather than copied, run again with --adopt to revoke them`);
  }
  const expires = key.expiresAt ? new Date(key.expiresAt * 1000).toISOString().slice(0, 10) : "never";
  return {
    key,
    steps: [
      `${key.minted ? "API key minted through the internal /rest endpoints" : "API key reused"} (expires ${expires}; ${key.revoked} earlier revoked)`,
      ...inheritedNote,
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
    keys: new Map<string, { raw: string; label: string; scopes: string[] }>(), logins: 0, deletes: 0, probeStatus: 0, loginStatus: 200, mintStatus: 200, next: 1,
    // The owner the fake knows: sign-in checks both, as n8n does.
    email: DEFAULT_OWNER_EMAIL, password: "Ob1-pw-1", cookie: `n8n-auth=${randomBytes(8).toString("hex")}`, lastScopes: [] as string[],
    jwt: (exp: number | null) => `h.${Buffer.from(JSON.stringify(exp === null ? { sub: "o" } : { sub: "o", exp })).toString("base64url")}.s${s.next++}`,
    add(label: string, exp: number | null, scopes: string[] = SCOPES) { const id = `k${s.next}`; const raw = s.jwt(exp); s.keys.set(id, { raw, label, scopes }); return { id, raw }; },
  };
  const valid = (raw: string | null) => [...s.keys.values()].some((k) => k.raw === raw);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const j = (b: unknown, status = 200) => Response.json(b, { status });
      if (u.pathname === "/rest/login") {
        s.logins++;
        if (s.loginStatus !== 200) return new Response("no", { status: s.loginStatus });
        const b = await req.json() as any;
        if (b.emailOrLdapLoginId !== s.email || b.password !== s.password) return new Response("Wrong username or password", { status: 401 });
        return new Response("{}", { headers: { "set-cookie": `${s.cookie}; Path=/` } });
      }
      // The internal endpoints take the session, never a key.
      if (u.pathname.startsWith("/rest/api-keys") && req.headers.get("cookie") !== s.cookie) return new Response("unauthorized", { status: 401 });
      if (u.pathname === "/rest/api-keys" && req.method === "POST") {
        if (s.mintStatus !== 200) return new Response("mint refused", { status: s.mintStatus });
        const b = await req.json() as any; s.lastScopes = b.scopes; const { id, raw } = s.add(b.label, b.expiresAt, b.scopes);
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
  expect("a key as `Bearer <key>` is seen", throws(() => checkBrainKey({ name: "a", type: "httpHeaderAuth", data: { name: "Authorization", value: `Bearer ${wr}` } }, env), /WRITE-scope/));
  expect("a key in a URL's ?key= is seen", throws(() => checkBrainKey({ name: "u", type: "httpQueryAuth", data: { url: `http://server:8000/mcp?key=${wr}&x=1` } }, env), /WRITE-scope/));
  expect("a key nested under another field is seen", throws(() => checkBrainKey({ name: "n", type: "custom", data: { outer: { inner: [cap] } } }, env), /declares no brainScope/));

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
    const good = parseEnv(readFileSync(fresh, "utf8")).N8N_OWNER_PASSWORD_HASH;
    writeFileSync(fresh, readFileSync(fresh, "utf8").replace(`N8N_OWNER_PASSWORD_HASH='${good}'`, `N8N_OWNER_PASSWORD_HASH="${good}"`), { mode: 0o600 });
    expect("--init rewrites a hash line compose would interpolate (double-quoted) single-quoted", (await initSecrets(fresh)).join() === "N8N_OWNER_PASSWORD_HASH" && singleQuoted(fresh, "N8N_OWNER_PASSWORD_HASH"));
    setEnvValue(fresh, "N8N_OWNER_PASSWORD", "Ob1-" + "é".repeat(40));
    expect("--init refuses a password over 72 bytes", await rejects(() => initSecrets(fresh), /over 72 bytes/));
    writeFileSync(fresh, `N8N_OWNER_PASSWORD_HASH='${good}'\nN8N_OWNER_PASSWORD_HASH=${good}\n`, { mode: 0o600 });
    expect("singleQuoted reads the last line, as parseEnv and compose do: a later bare hash is caught", !singleQuoted(fresh, "N8N_OWNER_PASSWORD_HASH"));
    writeFileSync(fresh, "export N8N_API_KEY=old\n", { mode: 0o600 });
    setEnvValues(fresh, { N8N_API_KEY: "new", N8N_API_KEY_ID: "k1" });
    expect("setEnvValues replaces an `export` line and writes several at once", readFileSync(fresh, "utf8") === "N8N_API_KEY=new\nN8N_API_KEY_ID=k1\n");
    expect("setEnvValue refuses a line break", throws(() => setEnvValue(fresh, "K", "a\nb"), /line break/));
    // A symlinked env file is written through, and stays a link; it fingerprints as its target (review pass 4).
    const link = `${fresh}.link`;
    try {
      writeFileSync(fresh, "A=1\n", { mode: 0o600 });
      symlinkSync(fresh, link);
      setEnvValue(link, "B", "2");
      expect("a symlinked env file stays a link, and its target gets the line", lstatSync(link).isSymbolicLink() && readFileSync(fresh, "utf8") === "A=1\nB=2\n");
      expect("a link fingerprints as the file it names", fileFingerprint(link) === fileFingerprint(fresh));
    } finally {
      rmSync(link, { force: true });
    }
  } finally {
    rmSync(file, { force: true });
    rmSync(fresh, { force: true });
  }

  // The compose service's owner block: without it a fresh n8n opens its owner
  // setup to whoever reaches the port first (review pass 2: a live mutant
  // with the block removed let a stranger claim the owner, and nothing in CI
  // noticed).
  const n8nService = (Bun.YAML.parse(readFileSync(join(HERE, "..", "compose.yaml"), "utf8")) as any)?.services?.n8n ?? {};
  const envBlock = n8nService.environment ?? {};
  expect("compose's n8n sets its owner from the environment", String(envBlock.N8N_INSTANCE_OWNER_MANAGED_BY_ENV) === "true"
    && envBlock.N8N_INSTANCE_OWNER_PASSWORD_HASH === "${N8N_OWNER_PASSWORD_HASH:-}"
    && String(envBlock.N8N_INSTANCE_OWNER_EMAIL).startsWith("${N8N_OWNER_EMAIL:-"));
  expect("compose's n8n entrypoint refuses a missing key or hash", /N8N_ENCRYPTION_KEY.*N8N_INSTANCE_OWNER_PASSWORD_HASH/s.test(JSON.stringify(n8nService.entrypoint ?? "")));

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

  // The key decisions, against a fake n8n that checks the owner's email, password and session.
  const f = fakeN8n();
  const keyFile = join(HERE, `.self-check.${process.pid}.keys.env`);
  try {
    const now = Math.floor(Date.now() / 1000);
    const opts = (env: Record<string, string>, more: Partial<Options> = {}): Options => ({ base: f.base, env, envFile: keyFile, credentials: [], workflows: [], ...more });
    const file = () => parseEnv(readFileSync(keyFile, "utf8"));
    const base = { N8N_OWNER_PASSWORD: "Ob1-pw-1" };
    writeFileSync(keyFile, "", { mode: 0o600 });
    const r1 = await ensureApiKey(opts({ ...base }));
    const saved = file();
    const tag = saved.N8N_API_KEY_TAG;
    expect("no stored key: a mint, kept with its id, scopes and tag, expiring in 90 days", r1.minted && saved.N8N_API_KEY === r1.key && saved.N8N_API_KEY_ID !== undefined && saved.N8N_API_KEY_SCOPES === SCOPES.join(",") && /^[0-9a-f]{8}$/.test(tag ?? "") && Math.abs((r1.expiresAt ?? 0) - (now + 90 * 86400)) < 60);
    expect("the mint asked n8n for exactly SCOPES, under the file's tag", sameScopes(f.s.lastScopes, SCOPES) && [...f.s.keys.values()].every((k) => k.label.startsWith(`${KEY_LABEL}-${tag}-`)));
    const logins = f.s.logins;
    const r2 = await ensureApiKey(opts({ ...base, ...saved }));
    expect("a good stored key is reused without a sign-in", !r2.minted && r2.key === r1.key && f.s.logins === logins);
    const r3 = await ensureApiKey(opts({ ...base, ...saved, N8N_API_KEY: "h.e30.forged" }));
    expect("a refused key: a mint, and the file's other keys revoked", r3.minted && f.s.keys.size === 1 && r3.revoked === 1);
    const near = f.s.add(`${KEY_LABEL}-${tag}-near`, now + 3 * 86400);
    const r4 = await ensureApiKey(opts({ ...base, N8N_API_KEY: near.raw, N8N_API_KEY_ID: near.id, N8N_API_KEY_SCOPES: SCOPES.join(","), N8N_API_KEY_TAG: tag, N8N_API_KEY_TAG_OF: saved.N8N_API_KEY_TAG_OF }));
    expect("a key with 3 of 90 days left is renewed", r4.minted);
    const shortKey = f.s.add(`${KEY_LABEL}-${tag}-short`, now + 2.5 * 86400);
    const r5 = await ensureApiKey(opts({ ...base, N8N_API_KEY_DAYS: "3", N8N_API_KEY: shortKey.raw, N8N_API_KEY_ID: shortKey.id, N8N_API_KEY_SCOPES: SCOPES.join(","), N8N_API_KEY_TAG: tag, N8N_API_KEY_TAG_OF: saved.N8N_API_KEY_TAG_OF }));
    expect("a 3-day key with 2.5 days left is kept, not re-minted each run", !r5.minted);
    const KIT = ["execution:list", "execution:read"];
    const r6 = await ensureApiKey(opts({ ...base, ...file() }, { extraScopes: KIT }));
    expect("a caller asking for more scopes gets a key minted with them", r6.minted && sameScopes(f.s.lastScopes, [...SCOPES, ...KIT]) && sameScopes(file().N8N_API_KEY_SCOPES.split(","), [...SCOPES, ...KIT]));
    const r6b = await ensureApiKey(opts({ ...base, ...file() }));
    expect("a broader key is replaced for a caller asking for less, so the file does not keep the kit's reads", r6b.minted && sameScopes(f.s.lastScopes, SCOPES));
    f.s.probeStatus = 503;
    expect("a busy n8n (503) is an error, not a mint", await rejects(() => ensureApiKey(opts({ ...base, ...file() })), /answered 503.*not minting/));
    f.s.probeStatus = 403;
    expect("a 403 to the stored key counts as refused: a mint", (await ensureApiKey(opts({ ...base, ...file() }))).minted);
    f.s.probeStatus = 0;
    const r7 = await ensureApiKey(opts({ ...base, ...file() }, { rotate: true }));
    expect("--rotate mints and revokes the key it replaces", r7.minted && r7.revoked >= 1 && f.s.keys.size === 1);
    // A previous run minted and failed to delete; a hand-made key; another env file's key.
    f.s.add(`${KEY_LABEL}-${tag}-left-behind`, now + 80 * 86400);
    const handMade = f.s.add("made-by-hand", now + 80 * 86400);
    const otherFile = f.s.add(`${KEY_LABEL}-0ther0ne-2026-09-26T00:00:00.000Z`, now + 80 * 86400);
    const r8 = await provision(opts({ ...base, ...file() }));
    expect("a plain run sweeps this file's leftover, and keeps a hand-made key and another file's", !r8.key.minted && r8.key.revoked === 1 && f.s.keys.size === 3 && f.s.keys.has(handMade.id) && f.s.keys.has(otherFile.id));
    // A copy of the file carries its tag. The copy mints under a tag of its own and revokes nothing;
    // after the original rotates, both keys still answer (review pass 3: they revoked each other).
    const copyFile = join(HERE, `.self-check.${process.pid}.copy.env`);
    try {
      writeFileSync(copyFile, readFileSync(keyFile, "utf8"), { mode: 0o600 });
      const cp = await ensureApiKey({ ...opts({ ...base, ...parseEnv(readFileSync(copyFile, "utf8")) }), envFile: copyFile });
      const cpEnv = parseEnv(readFileSync(copyFile, "utf8"));
      expect("a copied env file mints under a tag of its own and revokes nothing", cp.minted && cp.revoked === 0 && cpEnv.N8N_API_KEY_TAG !== tag);
      await ensureApiKey(opts({ ...base, ...file() }, { rotate: true }));
      const answers = async (k: string) => (await fetch(`${f.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": k } })).status;
      const again = await provision({ ...opts({ ...base, ...cpEnv }), envFile: copyFile });
      expect("after the original rotates, the copy's key and the original's both still answer", !again.key.minted && (await answers(cpEnv.N8N_API_KEY)) === 200 && (await answers(file().N8N_API_KEY)) === 200);
    } finally {
      rmSync(copyFile, { force: true });
    }
    // A moved file: without --adopt the old tag's keys are named and left; with it they are revoked.
    const movedFile = join(HERE, `.self-check.${process.pid}.moved.env`);
    try {
      const orig = file();
      writeFileSync(movedFile, readFileSync(keyFile, "utf8"), { mode: 0o600 });
      const told = await provision({ ...opts({ ...base, ...parseEnv(readFileSync(movedFile, "utf8")) }), envFile: movedFile });
      expect("a moved file's first run names the old tag and its live keys, and revokes none", told.steps.some((s) => s.includes(`carried tag ${orig.N8N_API_KEY_TAG}`) && /1 key\(s\) under the old tag still live/.test(s)));
      writeFileSync(movedFile, readFileSync(keyFile, "utf8"), { mode: 0o600 });
      const adopted = await provision({ ...opts({ ...base, ...parseEnv(readFileSync(movedFile, "utf8")) }, { adopt: true }), envFile: movedFile });
      const origNow = await fetch(`${f.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": orig.N8N_API_KEY } });
      expect("--adopt revokes the old tag's keys", adopted.steps.some((s) => s.includes(`adopted tag ${orig.N8N_API_KEY_TAG}`)) && origNow.status === 401);
    } finally {
      rmSync(movedFile, { force: true });
    }
    // The mint writes the file before revoking anything. When THIS file's write
    // fails (its directory read-only, the same tag), the old key still answers.
    const roDir = mkdtempSync(join(tmpdir(), "ob1-provision-"));
    const roFile = join(roDir, "deploy.env");
    try {
      writeFileSync(roFile, "", { mode: 0o600 });
      await ensureApiKey({ ...opts({ ...base }), envFile: roFile });
      const held = parseEnv(readFileSync(roFile, "utf8"));
      chmodSync(roDir, 0o500);
      await ensureApiKey({ ...opts({ ...base, ...held }, { rotate: true }), envFile: roFile }).catch(() => {});
      const oldStill = await fetch(`${f.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": held.N8N_API_KEY } });
      expect("a mint whose env write fails revokes nothing: the old key still answers", oldStill.status === 200);
    } finally {
      chmodSync(roDir, 0o700);
      rmSync(roDir, { recursive: true, force: true });
    }
    const noId = file();
    delete noId.N8N_API_KEY_ID;
    expect("a stored key without its id is replaced, so the sweep knows what to keep", (await provision(opts({ ...base, ...noId }))).key.minted);
    expect("a stored id n8n no longer lists is replaced, not trusted", (await provision(opts({ ...base, ...file(), N8N_API_KEY_ID: "k-gone" }))).key.minted);
    // The same, with the mint failing: nothing may have been deleted first, so the file's key still works.
    const beforeFail = file();
    f.s.mintStatus = 500;
    await provision(opts({ ...base, ...beforeFail, N8N_API_KEY_ID: "k-gone" })).catch(() => {});
    f.s.mintStatus = 200;
    const stillWorks = await fetch(`${f.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": beforeFail.N8N_API_KEY } });
    expect("a run that cannot mint deletes nothing first: the file's key still answers", stillWorks.status === 200);
    const live = file();
    const decoy = f.s.add(`${KEY_LABEL}-${tag}-decoy`, now + 80 * 86400);
    const r9 = await provision(opts({ ...base, ...live, N8N_API_KEY_ID: decoy.id }));
    const healed = await fetch(`${f.base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": file().N8N_API_KEY } });
    expect("a file whose key and id name two live keys ends with a working key", r9.key.minted && healed.status === 200);
    f.s.loginStatus = 429;
    expect("a rate-limited sign-in says so, not 'wrong password'", await rejects(() => ensureApiKey(opts({ ...base }, { rotate: true })), /rate-limits sign-in/));
    f.s.loginStatus = 200;
    f.s.email = "ops@example.org";
    expect("the owner's email comes from N8N_OWNER_EMAIL", (await ensureApiKey(opts({ ...base, N8N_OWNER_EMAIL: "ops@example.org" }, { rotate: true }))).minted);
    expect("without it, the default email is tried and refused, and the message says so", await rejects(() => ensureApiKey(opts({ ...base }, { rotate: true })), /sign-in as operator@ob1\.local failed \(401\)/));
    f.s.email = DEFAULT_OWNER_EMAIL;
    const otherHash = await Bun.password.hash("other", { algorithm: "bcrypt", cost: 4 });
    expect("a hash out of step with the password is refused before any sign-in", await rejects(() => ensureApiKey(opts({ ...base, N8N_OWNER_PASSWORD_HASH: otherHash }, { rotate: true })), /does not match N8N_OWNER_PASSWORD/));
    expect("a password over 72 bytes is refused", await rejects(() => ensureApiKey(opts({ N8N_OWNER_PASSWORD: "Ob1-" + "x".repeat(70) }, { rotate: true })), /over 72 bytes/));
    writeFileSync(keyFile, `N8N_OWNER_PASSWORD_HASH=${otherHash}\n`, { mode: 0o600 });
    expect("an unquoted hash line is refused before anything is written", await rejects(() => provision(opts({ ...base, N8N_OWNER_PASSWORD_HASH: otherHash })), /not single-quoted/));
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
  const usage = "usage: bun deploy/orchestration/provision.ts [--init] [--env-file deploy/.env] [--rotate] [--adopt] [--url http://127.0.0.1:5678]";
  const unknown = args.filter((a, i) => a.startsWith("--") && !["--env-file", "--rotate", "--url", "--init", "--adopt"].includes(a) && !["--env-file", "--url"].includes(args[i - 1]));
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
    console.log("back up N8N_ENCRYPTION_KEY and N8N_OWNER_PASSWORD with POSTGRES_PASSWORD; if n8n was running, recreate it (compose --profile orchestration up -d n8n; not `compose restart`, which keeps the old values)");
    process.exit(0);
  }
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const base = flag("url") ?? `http://127.0.0.1:${env.N8N_PORT || "5678"}`;
  try {
    await waitReady(base);
    const { steps } = await provision({ base, env, envFile, credentials: [PROFILE_CREDENTIALS], workflows: templatesIn(PROFILE_TEMPLATES), rotate: args.includes("--rotate"), adopt: args.includes("--adopt") });
    console.log(`n8n at ${base} provisioned:\n  ${steps.join("\n  ")}`);
  } catch (e) {
    console.error(`provision failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
