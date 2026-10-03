/**
 * config.ts — everything the authorization server reads from its environment
 * (SMD-2285), checked at once: a deploy missing three settings hears about all
 * three on its first start, not one per restart.
 *
 * - OB1_PUBLIC_ORIGIN, OB1_AUTH_TIERS and OB1_AUTH_SERVICES: the layout
 *   (layout.ts);
 * - OB1_AUTH_JWKS: the signing keys, a JSON `{ "keys": [...] }` of P-256
 *   private JWKs (the server signs ES256 only);
 * - OB1_AUTH_COOKIE_KEYS: comma-separated, each at least 32 characters, the
 *   first signing and the rest still accepted (rotation);
 * - OB1_AUTH_OPERATOR_PASSWORD_HASH: the operator's password, argon2id;
 * - OB1_AUTH_SECRET_<ID>: each static client's secret, at least 32
 *   characters;
 * - OB1_AUTH_DB: the store's file, /data/auth.sqlite (the compose volume)
 *   unless set;
 * - OB1_AUTH_MAX_CLIENTS: how many registered clients the store may hold, 200
 *   unless set (1 to 100,000);
 * - OB1_AUTH_TRUSTED_PROXY: the proxy in front, a host name or address; set,
 *   it turns on the per-address limits (limits.ts) while it resolves, and
 *   they are off without it;
 * - OB1_AUTH_FORWARDED_HOPS: which X-Forwarded-For entry from the right is the
 *   client, 1 unless set (2 when the tunnel writes its client into the
 *   header and the proxy trusts it);
 * - OB1_AUTH_REGISTRATIONS_PER_HOUR: how many clients one address may register
 *   in an hour, 30 unless set (1 to 100,000; per-address, so only with a
 *   trusted proxy);
 * - OB1_AUTH_POC_ERROR_DETAIL: the proof of concept's switch (server.ts);
 * - COMPOSE_PROFILES: deploy/.env's (or the shell's, which compose prefers),
 *   interpolated into the container, which must name `auth`. That is the stack's *configured* state (ADR decision 16,
 *   SMD-2382): a server started by `--profile auth` on the command line alone
 *   is refused, since the proxy publishes `/auth` while this server answers
 *   (SMD-1846) and the services that key their rules on configured read
 *   deploy/.env, not the command line.
 *
 * `bun deploy/auth/provision.ts --init` writes every secret here into
 * deploy/.env; `bun deploy/auth/provision.ts` reads that file through this
 * module and says what the server would refuse.
 *
 * Dependency-free, so provision.ts runs from a checkout with no install.
 */
import { clientIds, layout, originFromEnv, secretName, servicesFromEnv, tiersFromEnv, type Layout, type Service, type TierName } from "./layout.ts";

type Env = Record<string, string | undefined>;

/** A P-256 private JWK, as oidc-provider and jose take it. */
export type SigningKey = { kty: "EC"; crv: "P-256"; x: string; y: string; d: string; kid?: string; [k: string]: unknown };

export type Config = {
  layout: Layout;
  jwks: { keys: SigningKey[] };
  cookieKeys: string[];
  passwordHash: string;
  /** Each static client's secret, by client id. */
  secrets: Record<string, string>;
  dbPath: string;
  /** The most registered clients the store may hold: a registration past it is refused until the purge frees room. */
  maxClients: number;
  /** The most clients one address may register in an hour (limits.ts). */
  registrationsPerHour: number;
  /** The proxy whose X-Forwarded-For is trusted; unset, the per-address limits are off. */
  trustedProxy?: string;
  /** Which X-Forwarded-For entry from the right is the client. */
  forwardedHops: number;
  pocErrorDetail: boolean;
};

export const MIN_SECRET = 32;
/**
 * An argon2id hash as Bun.password writes it: version 19, its costs, a 32-byte
 * salt and a 32-byte digest in unpadded base64 (43 characters each). The
 * lengths are what catch a hash cut short: cut inside its digest, a hash can
 * still verify, as false, and every sign-in would fail in silence.
 */
export const ARGON2ID = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]{43}\$[A-Za-z0-9+/]{43}$/;

/** The most a hash may cost (memory in KiB, passes, lanes): it is paid at start and on every sign-in POST, which anyone starting a sign-in can send. */
export const MAX_COST = { m: 262_144, t: 10, p: 16 };

const NOT_WHOLE = "is not a whole argon2id hash as Bun writes it (version 19, a 43-character salt and digest; one cut short, or another tool's, is refused)";

/**
 * Why `hash` is not one the server can use, or "": its form and lengths, its
 * costs (checked before any verify, so a hostile cost is never paid), then a
 * verify that must not throw, for characters the form allows and the decoder
 * does not. One verify, about 70 ms at the defaults.
 */
export function argon2idProblem(hash: string): string {
  const m = ARGON2ID.exec(hash);
  if (!m) return NOT_WHOLE;
  const [mem, t, p] = m.slice(1).map(Number);
  if (mem > MAX_COST.m || t > MAX_COST.t || p > MAX_COST.p) {
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    return `costs more than the server allows (${mem} KiB of memory, ${n(t, "pass", "passes")}, ${n(p, "lane", "lanes")}; at most ${MAX_COST.m} KiB, ${MAX_COST.t} passes and ${MAX_COST.p} lanes), and every sign-in pays it`;
  }
  try {
    Bun.password.verifySync("a-probe-not-the-password", hash);
    return "";
  } catch {
    return NOT_WHOLE;
  }
}

export const wholeArgon2id = (hash: string) => argon2idProblem(hash) === "";
export const DEFAULT_DB = "/data/auth.sqlite";
export const DEFAULT_MAX_CLIENTS = 200;
export const DEFAULT_REGISTRATIONS_PER_HOUR = 30;
/** The ceiling of every whole-number setting. */
const WHOLE_CEILING = 100_000;
const INIT = "run `bun deploy/auth/provision.ts --init`, which writes it into deploy/.env";
const INIT_THEM = "run `bun deploy/auth/provision.ts --init`, which writes them into deploy/.env";

/** The signing keys, or why not. */
function jwksProblem(raw: string | undefined): string | { keys: SigningKey[] } {
  if (!raw) return `OB1_AUTH_JWKS is not set — ${INIT}`;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return `OB1_AUTH_JWKS is not JSON (${(e as Error).message}) — in deploy/.env it is one single-quoted line, '{"keys":[…]}'`;
  }
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || !keys.length) return `OB1_AUTH_JWKS has no "keys" array, or an empty one — ${INIT}`;
  const bad = keys.findIndex((k) => !k || typeof k !== "object" || k.kty !== "EC" || k.crv !== "P-256" || ![k.x, k.y, k.d].every((v) => typeof v === "string" && v));
  if (bad >= 0) return `OB1_AUTH_JWKS key ${bad} is not a P-256 private key (kty EC, crv P-256, with x, y and d): the server signs ES256 only`;
  return { keys: keys as SigningKey[] };
}

/** Whether `env`'s COMPOSE_PROFILES names `auth`: the stack is configured (ADR decision 16). */
export const configuredIn = (env: Env) => (env.COMPOSE_PROFILES ?? "").split(",").some((p) => p.trim() === "auth");

/**
 * The server's configuration from `env`, or one Error naming every problem,
 * one per line. Where the tiers cannot be read, the static clients checked
 * are `gui` and `mcp`, which every layout has.
 */
export function configFromEnv(env: Env = process.env): Config {
  const problems: string[] = [];
  const attempt = <T>(f: () => T): T | undefined => {
    try {
      return f();
    } catch (e) {
      problems.push((e as Error).message);
      return undefined;
    }
  };
  const origin = attempt(() => originFromEnv(env));
  const tiers = attempt(() => tiersFromEnv(env));
  const services = tiers ? attempt(() => servicesFromEnv(tiers, env)) : undefined;
  const ids = clientIds(tiers ?? ["stable"], services ?? {});

  const jwks = jwksProblem(env.OB1_AUTH_JWKS);
  if (typeof jwks === "string") problems.push(jwks);

  const cookieRaw = env.OB1_AUTH_COOKIE_KEYS?.trim();
  const cookieKeys = cookieRaw ? cookieRaw.split(",").map((k) => k.trim()) : [];
  if (!cookieRaw) problems.push(`OB1_AUTH_COOKIE_KEYS is not set — ${INIT}`);
  else if (cookieKeys.some((k) => k.length < MIN_SECRET)) problems.push(`OB1_AUTH_COOKIE_KEYS has a key shorter than ${MIN_SECRET} characters, or an empty one — ${INIT} after removing the line`);

  const passwordHash = env.OB1_AUTH_OPERATOR_PASSWORD_HASH?.trim() ?? "";
  if (!passwordHash) problems.push(`OB1_AUTH_OPERATOR_PASSWORD_HASH is not set — ${INIT}`);
  else if (argon2idProblem(passwordHash)) problems.push(`OB1_AUTH_OPERATOR_PASSWORD_HASH ${argon2idProblem(passwordHash)} — run \`bun deploy/auth/provision.ts --init\` to derive it again from OB1_AUTH_OPERATOR_PASSWORD`);

  const secrets: Record<string, string> = {};
  const missing = ids.filter((id) => !env[secretName(id)]);
  const serviceMissing = missing.some((id) => Object.hasOwn(services ?? {}, id));
  if (missing.length) {
    const where = serviceMissing ? "; a service client's secret also needs a line of its own in the auth service's environment (deploy/compose.yaml)" : "";
    problems.push(`${missing.map(secretName).join(", ")} ${missing.length === 1 ? `is not set — ${INIT}` : `are not set — ${INIT_THEM}`}${where}`);
  }
  const short = ids.filter((id) => env[secretName(id)] && env[secretName(id)]!.length < MIN_SECRET);
  if (short.length) problems.push(`${short.map(secretName).join(", ")} ${short.length === 1 ? "is" : "are"} shorter than ${MIN_SECRET} characters`);
  for (const id of ids) secrets[id] = env[secretName(id)] ?? "";

  if (!configuredIn(env)) {
    problems.push(`COMPOSE_PROFILES does not name auth ("${env.COMPOSE_PROFILES ?? ""}") — add auth to COMPOSE_PROFILES in deploy/.env (comma-separated with any other profiles), so every \`up\` starts this server and the stack reads as configured; \`--profile auth\` on the command line alone is refused, and a COMPOSE_PROFILES set in the shell takes compose's precedence over the file's (unset it, or have it name auth too)`);
  }

  /** A whole-number setting from 1 to WHOLE_CEILING, its fallback when unset or blank; a problem otherwise. */
  const whole = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    const n = raw ? Number(raw) : fallback;
    if (raw && !(/^\d+$/.test(raw) && n >= 1 && n <= WHOLE_CEILING)) problems.push(`${name} is not a whole number from 1 to ${WHOLE_CEILING} ("${raw}"; unset, it is ${fallback})`);
    return n;
  };
  const maxClients = whole("OB1_AUTH_MAX_CLIENTS", DEFAULT_MAX_CLIENTS);
  const registrationsPerHour = whole("OB1_AUTH_REGISTRATIONS_PER_HOUR", DEFAULT_REGISTRATIONS_PER_HOUR);
  const forwardedHops = whole("OB1_AUTH_FORWARDED_HOPS", 1);
  const trustedProxy = env.OB1_AUTH_TRUSTED_PROXY?.trim() || undefined;
  if (trustedProxy && !/^[A-Za-z0-9.:_-]+$/.test(trustedProxy)) problems.push(`OB1_AUTH_TRUSTED_PROXY is not a host name or an address ("${trustedProxy}")`);

  if (problems.length) throw new Error(`the authorization server cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return {
    layout: layout(origin!, tiers as TierName[], services as Record<string, Service>),
    jwks: jwks as { keys: SigningKey[] },
    cookieKeys,
    passwordHash,
    secrets,
    dbPath: env.OB1_AUTH_DB?.trim() || DEFAULT_DB,
    maxClients,
    registrationsPerHour,
    trustedProxy,
    forwardedHops,
    pocErrorDetail: env.OB1_AUTH_POC_ERROR_DETAIL === "1",
  };
}
