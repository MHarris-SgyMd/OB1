#!/usr/bin/env bun
/**
 * provision.ts — the `auth` profile's secrets, and a check of its settings
 * (SMD-2285).
 *
 *   bun deploy/auth/provision.ts --init         # once, before the first start: the profile's secrets into deploy/.env
 *   bun deploy/auth/provision.ts                # what the server would refuse, read from deploy/.env
 *   bun deploy/auth/provision.ts --self-check   # the rules, on scratch files (CI)
 *
 * `--init` writes, where the env file has none:
 * - OB1_AUTH_JWKS, one P-256 signing key;
 * - OB1_AUTH_COOKIE_KEYS, two;
 * - OB1_AUTH_OPERATOR_PASSWORD, made when the file has none, and its argon2id
 *   hash OB1_AUTH_OPERATOR_PASSWORD_HASH;
 * - OB1_AUTH_SECRET_<ID> for every static client the file's OB1_AUTH_TIERS
 *   and OB1_AUTH_SERVICES name (layout.ts).
 * It never replaces a value, except a hash: one that does not verify against
 * the password, or is not a whole argon2id hash, is derived again, and one
 * whose line is not single-quoted (compose reads a bare `$` as a variable) is
 * rewritten quoted, as orchestration/provision.ts does for n8n's owner. Everything
 * goes in one write. It does not write OB1_PUBLIC_ORIGIN, which is the
 * operator's to choose. The container is given the hash, never the password.
 *
 * Without a flag it reads the env file through config.ts, as the server reads
 * its environment, and reports every problem at once. It also reports a hash
 * that does not match the password, a secret the server needs that
 * deploy/compose.yaml's `auth` service does not pass (a service client's,
 * which needs a line of its own there), and whether the profile is configured
 * (COMPOSE_PROFILES names `auth`; docs/operator-surface-tiers.md, decision 16).
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../../db/env.ts";
import { setEnvValues, singleQuoted } from "../env-file.ts";
import { argon2idProblem, configFromEnv, wholeArgon2id } from "./config.ts";
import { REGISTRATION_PATH, RegistrationGate } from "./registration.ts";
import { clientIds, originFromEnv, secretName, servicesFromEnv, TIER_PREFIX, tiersFromEnv, type TierName } from "./layout.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, "..", ".env");
export const COMPOSE_FILE = join(HERE, "..", "compose.yaml");

/** The shortest operator password --init accepts. */
const MIN_PASSWORD = 12;

/**
 * What deploy/compose.yaml's `auth` service passes, and nothing else: the
 * layout, the keys, the hash, the registration cap and the secrets of the
 * clients every deploy can have (the GUI and each tier's MCP server). A service client's secret is not
 * here, since its name is the operator's; it needs a line of its own.
 */
export const COMPOSE_PASSES = [
  "OB1_PUBLIC_ORIGIN",
  "OB1_AUTH_TIERS",
  "OB1_AUTH_SERVICES",
  "OB1_AUTH_JWKS",
  "OB1_AUTH_COOKIE_KEYS",
  "OB1_AUTH_OPERATOR_PASSWORD_HASH",
  "OB1_AUTH_MAX_CLIENTS",
  ...clientIds(Object.keys(TIER_PREFIX) as TierName[], {}).map(secretName),
];

const hex = (n: number) => randomBytes(n).toString("hex");

/** One P-256 signing key as a JWKS, the shape config.ts reads. */
export function newJwks(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return JSON.stringify({ keys: [{ ...privateKey.export({ format: "jwk" }), kid: `ob1-${hex(6)}`, alg: "ES256", use: "sig" }] });
}

/**
 * Why the password's line cannot stand as written, or "": no password may
 * hold `'`, and a line that is not single-quoted may not hold `#` or `$`. db/env.ts, which --init reads the
 * file with, keeps an unquoted ` # note` as part of the value, so the hash
 * would be of a password the operator does not type; and compose, which reads
 * the whole file, takes every unquoted `$` as a variable and warns on every
 * command. Quoted, both are literal. The check reports it too.
 */
export function passwordLineProblem(envFile: string, password: string | undefined): string {
  // A ' cannot sit inside a single-quoted line, and compose then fails to read the whole file.
  if (password?.includes("'")) return "OB1_AUTH_OPERATOR_PASSWORD holds a ' — choose a password without one: compose cannot read one inside a single-quoted line (and then reads no line of deploy/.env), and a password with # or $ must be single-quoted";
  if (!password || singleQuoted(envFile, "OB1_AUTH_OPERATOR_PASSWORD") || !/[#$]/.test(password)) return "";
  return "OB1_AUTH_OPERATOR_PASSWORD holds # or $ on a line that is not single-quoted, where a # starts a comment the hash would include and compose reads $ as a variable — single-quote it: OB1_AUTH_OPERATOR_PASSWORD='…'";
}

/**
 * `--init`: the profile's secrets, written where the env file has none, in
 * one write. Returns the names written, never the values. Refuses, writing
 * nothing, when the layout settings do not read, the password's line cannot
 * stand (passwordLineProblem), or a password it must hash is too short.
 *
 * The password is made only when the file has neither it nor a hash: an
 * operator who removed the plain line after the first run keeps their
 * password, and only a hash compose would mangle is rewritten, quoted. A hash
 * with no password that is not argon2id cannot be re-derived, and is refused.
 */
export async function initSecrets(envFile: string): Promise<string[]> {
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const tiers = tiersFromEnv(env);
  const services = servicesFromEnv(tiers, env);
  const out: Record<string, string> = {};
  if (!env.OB1_AUTH_JWKS) out.OB1_AUTH_JWKS = newJwks();
  if (!env.OB1_AUTH_COOKIE_KEYS) out.OB1_AUTH_COOKIE_KEYS = `${hex(32)},${hex(32)}`;
  const hash = env.OB1_AUTH_OPERATOR_PASSWORD_HASH?.trim();
  const argon = !!hash && wholeArgon2id(hash);
  const quoted = singleQuoted(envFile, "OB1_AUTH_OPERATOR_PASSWORD_HASH");
  if (!env.OB1_AUTH_OPERATOR_PASSWORD && hash) {
    if (!argon) throw new Error(`OB1_AUTH_OPERATOR_PASSWORD_HASH ${argon2idProblem(hash)}, and there is no OB1_AUTH_OPERATOR_PASSWORD to derive one from — set the password and run --init again`);
    if (!quoted) out.OB1_AUTH_OPERATOR_PASSWORD_HASH = hash;
  } else {
    const line = passwordLineProblem(envFile, env.OB1_AUTH_OPERATOR_PASSWORD);
    if (line) throw new Error(line);
    const password = env.OB1_AUTH_OPERATOR_PASSWORD || (out.OB1_AUTH_OPERATOR_PASSWORD = hex(16));
    if (hash && argon && (await Bun.password.verify(password, hash).catch(() => false))) {
      // In place and verifying: kept, its line quoted if bare. Its password's length was the operator's call.
      if (!quoted) out.OB1_AUTH_OPERATOR_PASSWORD_HASH = hash;
    } else {
      if (password.length < MIN_PASSWORD) throw new Error(`OB1_AUTH_OPERATOR_PASSWORD is shorter than ${MIN_PASSWORD} characters: the sign-in page is on the public origin`);
      out.OB1_AUTH_OPERATOR_PASSWORD_HASH = await Bun.password.hash(password, { algorithm: "argon2id" });
    }
  }
  for (const id of clientIds(tiers, services)) if (!env[secretName(id)]) out[secretName(id)] = hex(32);
  if (Object.keys(out).length) setEnvValues(envFile, out);
  return Object.keys(out);
}

/** The warning --init prints when anyone but its owner may read or write the env file, or "": it holds the signing key, and a writer could swap it. */
export function readableWarning(envFile: string): string {
  const mode = statSync(envFile).mode & 0o777;
  return mode & 0o077 ? `warning: ${envFile} is readable or writable by others (mode ${mode.toString(8)}) and holds the signing key — chmod 600 it` : "";
}

/** The variables deploy/compose.yaml's `auth` service passes into its container. */
export function composePasses(composeFile: string): string[] {
  const doc = Bun.YAML.parse(readFileSync(composeFile, "utf8")) as { services?: Record<string, { environment?: Record<string, unknown> }> };
  return Object.keys(doc?.services?.auth?.environment ?? {});
}

/** What the server would refuse, read from the env file; `notes` are not problems. */
export async function checkEnvFile(envFile: string, composeFile = COMPOSE_FILE): Promise<{ problems: string[]; notes: string[] }> {
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const problems: string[] = [];
  const notes: string[] = [];
  try {
    configFromEnv(env);
  } catch (e) {
    problems.push(...(e as Error).message.split("\n").slice(1).map((l) => l.replace(/^\s*- /, "")));
  }
  const password = env.OB1_AUTH_OPERATOR_PASSWORD;
  // Trimmed as config.ts trims it, so the check and the server agree.
  const hash = env.OB1_AUTH_OPERATOR_PASSWORD_HASH?.trim();
  const line = passwordLineProblem(envFile, password);
  if (line) problems.push(line);
  if (hash && !singleQuoted(envFile, "OB1_AUTH_OPERATOR_PASSWORD_HASH")) problems.push("OB1_AUTH_OPERATOR_PASSWORD_HASH's line is not single-quoted, so compose reads its `$`s as variables — run --init, which rewrites it");
  else if (password && hash && !(await Bun.password.verify(password, hash).catch(() => false))) problems.push("OB1_AUTH_OPERATOR_PASSWORD_HASH does not match OB1_AUTH_OPERATOR_PASSWORD — run --init to re-derive it, then recreate the service (compose up -d --wait auth, with compose as in deploy/README.md; a restart keeps the old hash)");
  try {
    const tiers = tiersFromEnv(env);
    const passed = new Set(composePasses(composeFile));
    for (const id of clientIds(tiers, servicesFromEnv(tiers, env))) {
      const name = secretName(id);
      if (!passed.has(name)) problems.push(`${composeFile}'s auth service does not pass ${name}: add \`${name}: \${${name}:-}\` to its environment`);
    }
  } catch {
    // The layout's own problems are reported above.
  }
  const profiles = (env.COMPOSE_PROFILES ?? "").split(",").map((p) => p.trim());
  notes.push(profiles.includes("auth") ? "configured: COMPOSE_PROFILES names auth, so every `up` starts the server" : "not configured: COMPOSE_PROFILES does not name auth — start it with --profile auth, or add auth to COMPOSE_PROFILES");
  return { problems, notes };
}

// --- the rules --------------------------------------------------------------

/** Every probe of the profile's rules, the run failing on any that does not hold. */
async function selfCheck(): Promise<number> {
  let failed = 0;
  const expect = (what: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  const refusal = (f: () => unknown): string => {
    try {
      f();
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const dir = mkdtempSync(join(tmpdir(), "ob1-auth-provision-"));
  // --init where a probe expects it to run: a refusal is that probe's FAIL, by name, not a crash that skips the rest.
  const initOk = (file: string) =>
    initSecrets(file).then(
      (w) => w,
      (e) => {
        expect(`--init ran on ${file.slice(dir.length + 1)}`, false, (e as Error).message);
        return [] as string[];
      },
    );
  try {
    const argon2i = await Bun.password.hash("a-long-password", { algorithm: "argon2i" });
    const good = {
      OB1_PUBLIC_ORIGIN: "https://brain.example.com",
      OB1_AUTH_JWKS: newJwks(),
      OB1_AUTH_COOKIE_KEYS: `${hex(32)},${hex(32)}`,
      OB1_AUTH_OPERATOR_PASSWORD_HASH: await Bun.password.hash("a-long-password", { algorithm: "argon2id" }),
      OB1_AUTH_SECRET_GUI: hex(32),
      OB1_AUTH_SECRET_MCP: hex(32),
    };

    // config.ts: every problem at once.
    const c = configFromEnv(good);
    expect("a complete environment is accepted, with the volume's store, the POC switch off and each client's own secret", c.layout.issuer === "https://brain.example.com/auth" && c.dbPath === "/data/auth.sqlite" && !c.pocErrorDetail && c.secrets.gui === good.OB1_AUTH_SECRET_GUI && c.secrets.mcp === good.OB1_AUTH_SECRET_MCP);
    const none = refusal(() => configFromEnv({}));
    const lines = none.split("\n").slice(1);
    expect(
      "an empty environment is refused once, naming the origin, the keys, the cookie keys, the hash and both secrets",
      lines.length === 5 && ["OB1_PUBLIC_ORIGIN", "OB1_AUTH_JWKS", "OB1_AUTH_COOKIE_KEYS", "OB1_AUTH_OPERATOR_PASSWORD_HASH", "OB1_AUTH_SECRET_GUI, OB1_AUTH_SECRET_MCP are not set"].every((n) => none.includes(n)),
      none,
    );
    const both = refusal(() => configFromEnv({ ...good, OB1_AUTH_TIERS: "stable,nope", OB1_AUTH_OPERATOR_PASSWORD_HASH: "" }));
    expect("an unreadable OB1_AUTH_TIERS is reported beside the other problems", /no such tier: nope/.test(both) && /OB1_AUTH_OPERATOR_PASSWORD_HASH is not set/.test(both), both);
    const cases: [string, Record<string, string>, RegExp][] = [
      ["a JWKS that is not JSON is named", { OB1_AUTH_JWKS: "{keys:" }, /OB1_AUTH_JWKS is not JSON/],
      ["a JWKS with no keys", { OB1_AUTH_JWKS: '{"keys":[]}' }, /no "keys" array, or an empty one/],
      ["a JWKS with an RSA key", { OB1_AUTH_JWKS: JSON.stringify({ keys: [{ kty: "RSA", n: "x", e: "AQAB", d: "y" }] }) }, /key 0 is not a P-256 private key/],
      ["a JWKS with a P-384 key", { OB1_AUTH_JWKS: JSON.stringify({ keys: [{ ...JSON.parse(good.OB1_AUTH_JWKS).keys[0], crv: "P-384" }] }) }, /key 0 is not a P-256 private key/],
      ["a JWKS with a public key alone", { OB1_AUTH_JWKS: JSON.stringify({ keys: [{ ...JSON.parse(good.OB1_AUTH_JWKS).keys[0], d: undefined }] }) }, /key 0 is not a P-256 private key/],
      ["a short cookie key", { OB1_AUTH_COOKIE_KEYS: `${hex(32)},short` }, /OB1_AUTH_COOKIE_KEYS has a key shorter than 32/],
      ["an empty cookie key", { OB1_AUTH_COOKIE_KEYS: `${hex(32)},` }, /OB1_AUTH_COOKIE_KEYS has a key shorter than 32 characters, or an empty one/],
      ["a bcrypt hash", { OB1_AUTH_OPERATOR_PASSWORD_HASH: "$2b$10$abcdefghijklmnopqrstuuJ0123456789abcdefghijklmnopqrst" }, /not a whole argon2id hash/],
      ["a truncated argon2id hash", { OB1_AUTH_OPERATOR_PASSWORD_HASH: "$argon2id$v=19$m=65536" }, /not a whole argon2id hash/],
      ["an argon2id hash cut at its last $", { OB1_AUTH_OPERATOR_PASSWORD_HASH: good.OB1_AUTH_OPERATOR_PASSWORD_HASH.slice(0, good.OB1_AUTH_OPERATOR_PASSWORD_HASH.lastIndexOf("$")) }, /not a whole argon2id hash/],
      ["an argon2id hash cut inside its digest", { OB1_AUTH_OPERATOR_PASSWORD_HASH: good.OB1_AUTH_OPERATOR_PASSWORD_HASH.slice(0, -10) }, /not a whole argon2id hash/],
      ["an argon2i hash", { OB1_AUTH_OPERATOR_PASSWORD_HASH: argon2i }, /not a whole argon2id hash/],
      ["a short secret", { OB1_AUTH_SECRET_MCP: "short" }, /OB1_AUTH_SECRET_MCP is shorter than 32/],
      ["a canary tier's secret", { OB1_AUTH_TIERS: "stable,canary" }, /OB1_AUTH_SECRET_MCP_CANARY is not set/],
      ["a service's secret, with where it goes", { OB1_AUTH_SERVICES: "runner=brain:capture@stable" }, /OB1_AUTH_SECRET_RUNNER is not set .*a line of its own in the auth service's environment/],
      ["a tier's secret, with no word of compose (the service passes it)", { OB1_AUTH_TIERS: "stable,working" }, /OB1_AUTH_SECRET_MCP_WORKING is not set — run `bun deploy\/auth\/provision.ts --init`, which writes it into deploy\/.env$/],
    ];
    for (const [what, over, want] of cases) {
      const got = refusal(() => configFromEnv({ ...good, ...over }));
      expect(`refused: ${what}`, want.test(got), got || "accepted");
    }
    const h = good.OB1_AUTH_OPERATOR_PASSWORD_HASH;
    const cutsTaken = Array.from({ length: h.length - 1 }, (_, i) => h.slice(0, i + 1)).filter((cut) => argon2idProblem(cut) === "");
    expect("every cut of a whole hash, at every length, is refused", cutsTaken.length === 0, `${cutsTaken.length} cut(s) taken, e.g. ${cutsTaken[0]?.length ?? ""} characters`);
    // The form allows any base64 character last; the decoder wants the digest's two spare bits clear. Only the verify sees it.
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const spareBits = h.slice(0, -1) + B64[(B64.indexOf(h.at(-1)!) & ~3) + 1];
    expect("a hash whose last character the decoder refuses is refused", /not a whole argon2id hash/.test(argon2idProblem(spareBits)), argon2idProblem(spareBits) || "accepted");
    // Costs set on a hash the decoder refuses: a cost refusal says "costs more", and a verify that ran first would
    // say "not whole" instead, in no time and no memory, so the order is held and no probe pays a costly verify.
    const costly = (m: number, t: number, p: number) => spareBits.replace(/m=\d+,t=\d+,p=\d+/, `m=${m},t=${t},p=${p}`);
    const said = [costly(1_048_576, 2, 1), costly(65_536, 11, 1), costly(65_536, 2, 17)].map(argon2idProblem);
    expect(
      "a hash asking for more than 256 MiB, 10 passes or 16 lanes is refused for its cost, before any verify",
      /costs more than the server allows \(1048576 KiB of memory, 2 passes, 1 lane;/.test(said[0]) && /\b11 passes\b/.test(said[1]) && /\b17 lanes\b/.test(said[2]),
      said.join(" | "),
    );
    expect("a hash at every bound is not refused for its cost", /not a whole argon2id hash/.test(argon2idProblem(costly(262_144, 10, 16))), argon2idProblem(costly(262_144, 10, 16)));
    const costlyOnly = join(dir, "costly-only.env");
    writeFileSync(costlyOnly, `OB1_AUTH_OPERATOR_PASSWORD_HASH='${costly(1_048_576, 2, 1)}'\n`);
    expect("--init names a costly hash it has no password for as costly", /costs more than the server allows[^]*, and there is no OB1_AUTH_OPERATOR_PASSWORD/.test(await initSecrets(costlyOnly).then(() => "", (e) => (e as Error).message)));
    expect("the POC switch is on for 1 alone", configFromEnv({ ...good, OB1_AUTH_POC_ERROR_DETAIL: "1" }).pocErrorDetail && !configFromEnv({ ...good, OB1_AUTH_POC_ERROR_DETAIL: "true" }).pocErrorDetail);
    expect("OB1_AUTH_DB names another file", configFromEnv({ ...good, OB1_AUTH_DB: "/tmp/x.sqlite" }).dbPath === "/tmp/x.sqlite");
    const maxOf = (v: string | undefined) => {
      try {
        return configFromEnv(v === undefined ? good : { ...good, OB1_AUTH_MAX_CLIENTS: v }).maxClients;
      } catch (e) {
        return (e as Error).message;
      }
    };
    const maxes = [maxOf(undefined), maxOf(" "), maxOf("1"), maxOf("100000")];
    expect("OB1_AUTH_MAX_CLIENTS is 200 unset or blank, and takes a whole number from 1 to 100,000", JSON.stringify(maxes) === "[200,200,1,100000]", JSON.stringify(maxes));
    for (const bad of ["0", "100001", "-5", "2.5", "1e3", "lots"]) {
      const said = refusal(() => configFromEnv({ ...good, OB1_AUTH_MAX_CLIENTS: bad }));
      expect(`OB1_AUTH_MAX_CLIENTS "${bad}" is refused`, said.includes(`OB1_AUTH_MAX_CLIENTS is not a whole number from 1 to 100000 ("${bad}"`), said || "accepted");
    }

    // layout.ts: the origin, strictly.
    const origins: [string, string | RegExp][] = [
      ["https://brain.example.com", "https://brain.example.com"],
      ["https://brain.example.com/", "https://brain.example.com"],
      ["https://brain.example.com:8443", "https://brain.example.com:8443"],
      ["http://localhost:8020", "http://localhost:8020"],
      ["http://127.0.0.1:8020", "http://127.0.0.1:8020"],
      ["http://[::1]:8020", "http://[::1]:8020"],
      ["https://brain.example.com/auth", /an origin alone/],
      ["https://brain.example.com/?x=1", /an origin alone/],
      ["https://brain.example.com/#top", /an origin alone/],
      ["https://user:not-echoed@brain.example.com", /^OB1_PUBLIC_ORIGIN holds an @, so it may hold credentials \(not shown\): give the origin alone, e\.g\. https:\/\/brain\.example\.com$/],
      ["user:not-echoed@brain.example.com", /^OB1_PUBLIC_ORIGIN holds an @, so it may hold credentials \(not shown\)/],
      ["https://user:not-echoed@", /^OB1_PUBLIC_ORIGIN holds an @, so it may hold credentials \(not shown\)/],
      ["postgres://db.example.com", /^OB1_PUBLIC_ORIGIN must be https:\/\/ \("postgres:\/\/db\.example\.com"\)$/],
      ["https://Brain.Example.com", /the origin is https:\/\/brain\.example\.com/],
      ["https://brain.example.com:443", /the origin is https:\/\/brain\.example\.com\)/],
      ["brain.example.com", /not a URL/],
      ["http://brain.example.com", /must be https:\/\/ unless its host is loopback/],
      ["ftp://brain.example.com", /must be https:\/\//],
    ];
    for (const [given, want] of origins) {
      let got: string;
      try {
        got = originFromEnv({ OB1_PUBLIC_ORIGIN: given });
      } catch (e) {
        got = (e as Error).message;
      }
      expect(`OB1_PUBLIC_ORIGIN "${given}" ${typeof want === "string" ? "reads as its origin" : "is refused"}`, typeof want === "string" ? got === want : want.test(got), got);
    }

    // --init.
    const file = join(dir, "fresh.env");
    const first = await initOk(file);
    expect("--init writes the keys, the cookie keys, a password, its hash and both secrets", first.join() === "OB1_AUTH_JWKS,OB1_AUTH_COOKIE_KEYS,OB1_AUTH_OPERATOR_PASSWORD,OB1_AUTH_OPERATOR_PASSWORD_HASH,OB1_AUTH_SECRET_GUI,OB1_AUTH_SECRET_MCP", first.join());
    expect("a new env file is 0600, and draws no warning", (statSync(file).mode & 0o777) === 0o600 && readableWarning(file) === "");
    const shared = join(dir, "shared.env");
    writeFileSync(shared, "", { mode: 0o644 });
    chmodSync(shared, 0o644);
    expect("an env file others can read draws the warning", /readable or writable by others \(mode 644\)/.test(readableWarning(shared)));
    chmodSync(shared, 0o640);
    expect("an env file its group can read draws the warning too", /readable or writable by others \(mode 640\)/.test(readableWarning(shared)));
    chmodSync(shared, 0o604);
    expect("an env file only others can read draws the warning too", /readable or writable by others \(mode 604\)/.test(readableWarning(shared)));
    chmodSync(shared, 0o602);
    expect("an env file others can write but not read draws the warning too", /readable or writable by others \(mode 602\)/.test(readableWarning(shared)));
    writeFileSync(file, `OB1_PUBLIC_ORIGIN=https://brain.example.com\n${readFileSync(file, "utf8")}`);
    const written = parseEnv(readFileSync(file, "utf8"));
    expect("what --init writes is what the server accepts", refusal(() => configFromEnv(written)) === "", refusal(() => configFromEnv(written)));
    expect("the hash verifies the password, and its line and the keys' are single-quoted", (await Bun.password.verify(written.OB1_AUTH_OPERATOR_PASSWORD, written.OB1_AUTH_OPERATOR_PASSWORD_HASH)) && singleQuoted(file, "OB1_AUTH_OPERATOR_PASSWORD_HASH") && singleQuoted(file, "OB1_AUTH_JWKS"));
    expect("--init a second time writes nothing", (await initOk(file)).length === 0);
    const checked = await checkEnvFile(file);
    expect("the check passes what --init wrote, and says the profile is not configured", checked.problems.length === 0 && /^not configured/.test(checked.notes[0]), checked.problems.join("; "));

    writeFileSync(file, `${readFileSync(file, "utf8")}OB1_AUTH_OPERATOR_PASSWORD=another-long-password\nCOMPOSE_PROFILES=local-models,auth\n`);
    const mismatch = await checkEnvFile(file);
    expect("the check reports a hash that no longer matches the password, and says the profile is configured", mismatch.problems.some((p) => /does not match/.test(p)) && /^configured/.test(mismatch.notes[0]), mismatch.problems.join("; "));
    expect("--init re-derives a hash that no longer matches the password", (await initOk(file)).join() === "OB1_AUTH_OPERATOR_PASSWORD_HASH");
    const rewritten = parseEnv(readFileSync(file, "utf8"));
    writeFileSync(file, readFileSync(file, "utf8").replace(`OB1_AUTH_OPERATOR_PASSWORD_HASH='${rewritten.OB1_AUTH_OPERATOR_PASSWORD_HASH}'`, `OB1_AUTH_OPERATOR_PASSWORD_HASH=${rewritten.OB1_AUTH_OPERATOR_PASSWORD_HASH}`));
    expect("the check reports a hash line compose would interpolate", (await checkEnvFile(file)).problems.some((p) => /not single-quoted/.test(p)));
    expect("--init rewrites a hash line compose would interpolate, single-quoted", (await initOk(file)).join() === "OB1_AUTH_OPERATOR_PASSWORD_HASH" && singleQuoted(file, "OB1_AUTH_OPERATOR_PASSWORD_HASH"));

    const kept = parseEnv(readFileSync(file, "utf8"));
    writeFileSync(file, `${readFileSync(file, "utf8")}OB1_AUTH_TIERS=stable,canary\nOB1_AUTH_SERVICES=runner=brain:capture@stable\n`);
    expect("--init writes only what a new tier and a new service need", (await initOk(file)).join() === "OB1_AUTH_SECRET_MCP_CANARY,OB1_AUTH_SECRET_RUNNER");
    const after = parseEnv(readFileSync(file, "utf8"));
    expect("--init kept every value it found", ["OB1_AUTH_JWKS", "OB1_AUTH_COOKIE_KEYS", "OB1_AUTH_OPERATOR_PASSWORD_HASH", "OB1_AUTH_SECRET_GUI", "OB1_AUTH_SECRET_MCP"].every((k) => after[k] === kept[k]));
    const service = await checkEnvFile(file);
    expect("the check names a service secret compose does not pass, and the line to add", service.problems.length === 1 && /does not pass OB1_AUTH_SECRET_RUNNER: add `OB1_AUTH_SECRET_RUNNER: \$\{OB1_AUTH_SECRET_RUNNER:-\}`/.test(service.problems[0]), service.problems.join("; "));
    const withLine = join(dir, "compose.yaml");
    const anchor = "      OB1_AUTH_SECRET_MCP_WORKING: ${OB1_AUTH_SECRET_MCP_WORKING:-}\n";
    writeFileSync(withLine, readFileSync(COMPOSE_FILE, "utf8").replace(anchor, `${anchor}      OB1_AUTH_SECRET_RUNNER: \${OB1_AUTH_SECRET_RUNNER:-}\n`));
    const added = await checkEnvFile(file, withLine);
    expect("the check passes once the service's line is added to compose", readFileSync(withLine, "utf8").includes("OB1_AUTH_SECRET_RUNNER:") && added.problems.length === 0, added.problems.join("; "));

    const hashOnly = join(dir, "hash-only.env");
    await initOk(hashOnly);
    const before = parseEnv(readFileSync(hashOnly, "utf8"));
    writeFileSync(hashOnly, readFileSync(hashOnly, "utf8").replace(/^OB1_AUTH_OPERATOR_PASSWORD=.*\n/m, "") + "OB1_AUTH_TIERS=stable,canary\n");
    expect("--init keeps the hash when the plain password was removed, and makes no new password", (await initOk(hashOnly)).join() === "OB1_AUTH_SECRET_MCP_CANARY" && parseEnv(readFileSync(hashOnly, "utf8")).OB1_AUTH_OPERATOR_PASSWORD_HASH === before.OB1_AUTH_OPERATOR_PASSWORD_HASH);
    writeFileSync(hashOnly, readFileSync(hashOnly, "utf8").replace(`OB1_AUTH_OPERATOR_PASSWORD_HASH='${before.OB1_AUTH_OPERATOR_PASSWORD_HASH}'`, `OB1_AUTH_OPERATOR_PASSWORD_HASH=${before.OB1_AUTH_OPERATOR_PASSWORD_HASH}`));
    expect("--init quotes a bare hash it has no password for, keeping its value", (await initOk(hashOnly)).join() === "OB1_AUTH_OPERATOR_PASSWORD_HASH" && singleQuoted(hashOnly, "OB1_AUTH_OPERATOR_PASSWORD_HASH") && parseEnv(readFileSync(hashOnly, "utf8")).OB1_AUTH_OPERATOR_PASSWORD_HASH === before.OB1_AUTH_OPERATOR_PASSWORD_HASH);
    const bcryptOnly = join(dir, "bcrypt-only.env");
    writeFileSync(bcryptOnly, `OB1_AUTH_OPERATOR_PASSWORD_HASH='${await Bun.password.hash("a-long-password", { algorithm: "bcrypt", cost: 4 })}'\n`);
    expect("--init refuses a bcrypt hash with no password to re-derive from, writing nothing", /not a whole argon2id hash[^]*, and there is no OB1_AUTH_OPERATOR_PASSWORD/.test(await initSecrets(bcryptOnly).then(() => "", (e) => (e as Error).message)) && !parseEnv(readFileSync(bcryptOnly, "utf8")).OB1_AUTH_JWKS);
    const quote = join(dir, "quote.env");
    writeFileSync(quote, "OB1_PUBLIC_ORIGIN=https://brain.example.com\nOB1_AUTH_OPERATOR_PASSWORD='it's-a-long-password'\n");
    expect("a password with a ' is refused by --init, writing nothing, and reported by the check", /holds a '/.test(await initSecrets(quote).then(() => "", (e) => (e as Error).message)) && !parseEnv(readFileSync(quote, "utf8")).OB1_AUTH_JWKS && (await checkEnvFile(quote)).problems.some((p) => /holds a '/.test(p)));
    const shortBare = join(dir, "short-bare.env");
    const shortHash = await Bun.password.hash("shortpw", { algorithm: "argon2id" });
    writeFileSync(shortBare, `OB1_PUBLIC_ORIGIN=https://brain.example.com\nOB1_AUTH_OPERATOR_PASSWORD=shortpw\nOB1_AUTH_OPERATOR_PASSWORD_HASH=${shortHash}\n`);
    const shortBareInit = await initOk(shortBare);
    expect("a short password's verifying hash on a bare line is quoted, not re-hashed or refused", shortBareInit.includes("OB1_AUTH_OPERATOR_PASSWORD_HASH") && parseEnv(readFileSync(shortBare, "utf8")).OB1_AUTH_OPERATOR_PASSWORD_HASH === shortHash && singleQuoted(shortBare, "OB1_AUTH_OPERATOR_PASSWORD_HASH"), shortBareInit.join());
    const spacedHash = join(dir, "spaced-hash.env");
    writeFileSync(spacedHash, `OB1_PUBLIC_ORIGIN=https://brain.example.com\nOB1_AUTH_OPERATOR_PASSWORD=a-long-password\nOB1_AUTH_OPERATOR_PASSWORD_HASH='${good.OB1_AUTH_OPERATOR_PASSWORD_HASH} '\n`);
    const spacedBefore = readFileSync(spacedHash, "utf8");
    const spacedInit = await initOk(spacedHash);
    const spacedChecked = await checkEnvFile(spacedHash);
    expect("a hash with a space after it reads as the server reads it: --init keeps it and the check finds no mismatch", !spacedInit.includes("OB1_AUTH_OPERATOR_PASSWORD_HASH") && readFileSync(spacedHash, "utf8").includes(spacedBefore.split("\n")[2]) && !spacedChecked.problems.some((p) => /does not match|not a whole/.test(p)), `${spacedInit.join()} / ${spacedChecked.problems.join("; ")}`);
    const truncated = join(dir, "truncated.env");
    writeFileSync(truncated, "OB1_AUTH_OPERATOR_PASSWORD_HASH='$argon2id$v=19$m=65536'\n");
    expect("--init refuses a truncated argon2id hash with no password, writing nothing", /not a whole argon2id hash[^]*, and there is no/.test(await initSecrets(truncated).then(() => "", (e) => (e as Error).message)) && !parseEnv(readFileSync(truncated, "utf8")).OB1_AUTH_JWKS);
    const bcrypt = join(dir, "bcrypt.env");
    writeFileSync(bcrypt, `OB1_AUTH_OPERATOR_PASSWORD=a-long-password\nOB1_AUTH_OPERATOR_PASSWORD_HASH='${await Bun.password.hash("a-long-password", { algorithm: "bcrypt", cost: 4 })}'\n`);
    await initOk(bcrypt);
    expect("--init re-derives a bcrypt hash that verifies, as argon2id", parseEnv(readFileSync(bcrypt, "utf8")).OB1_AUTH_OPERATOR_PASSWORD_HASH.startsWith("$argon2id$"));
    for (const [what, line] of [["a # comment", "correct-horse-battery # mine"], ["a $", "correct-horse$battery"]]) {
      const bare = join(dir, "bare-password.env");
      writeFileSync(bare, `OB1_PUBLIC_ORIGIN=https://brain.example.com\nOB1_AUTH_OPERATOR_PASSWORD=${line}\n`);
      const refusedInit = await initSecrets(bare).then(() => "", (e) => (e as Error).message);
      const checkSays = (await checkEnvFile(bare)).problems.some((p) => /single-quote it/.test(p));
      expect(`an unquoted password with ${what} is refused by --init, writing nothing, and reported by the check`, /single-quote it/.test(refusedInit) && !parseEnv(readFileSync(bare, "utf8")).OB1_AUTH_JWKS && checkSays, refusedInit || "accepted");
    }
    const phrase = join(dir, "passphrase.env");
    writeFileSync(phrase, "OB1_PUBLIC_ORIGIN=https://brain.example.com\nOB1_AUTH_OPERATOR_PASSWORD='correct horse # battery $staple'\n");
    await initOk(phrase);
    const phraseEnv = parseEnv(readFileSync(phrase, "utf8"));
    writeFileSync(phrase, `${readFileSync(phrase, "utf8")}OB1_AUTH_TIERS=stable,canary\n`);
    const phraseAgain = await initOk(phrase);
    expect(
      "a single-quoted passphrase with spaces, # and $ is hashed as written, and a later --init adds a tier's secret beside it, the check agreeing",
      (await Bun.password.verify("correct horse # battery $staple", phraseEnv.OB1_AUTH_OPERATOR_PASSWORD_HASH)) && phraseAgain.join() === "OB1_AUTH_SECRET_MCP_CANARY" && (await checkEnvFile(phrase)).problems.length === 0,
      phraseAgain.join(),
    );
    const spaced = join(dir, "spaced.env");
    writeFileSync(spaced, "OB1_AUTH_OPERATOR_PASSWORD=correct horse battery\n");
    await initOk(spaced);
    expect("an unquoted password with spaces alone is hashed as written", await Bun.password.verify("correct horse battery", parseEnv(readFileSync(spaced, "utf8")).OB1_AUTH_OPERATOR_PASSWORD_HASH));
    const shortKept = join(dir, "short-kept.env");
    writeFileSync(shortKept, `OB1_PUBLIC_ORIGIN=https://brain.example.com\nOB1_AUTH_OPERATOR_PASSWORD=shortpw\nOB1_AUTH_OPERATOR_PASSWORD_HASH='${await Bun.password.hash("shortpw", { algorithm: "argon2id" })}'\n`);
    expect("a short password whose hash is already in place does not stop --init", (await initOk(shortKept)).includes("OB1_AUTH_JWKS"));

    const short = join(dir, "short.env");
    writeFileSync(short, "OB1_AUTH_OPERATOR_PASSWORD=short\n");
    expect("--init refuses a short password and writes nothing", /shorter than 12/.test(await initSecrets(short).then(() => "", (e) => (e as Error).message)) && readFileSync(short, "utf8") === "OB1_AUTH_OPERATOR_PASSWORD=short\n");
    const badTier = join(dir, "tier.env");
    writeFileSync(badTier, "OB1_AUTH_TIERS=stable,nope\n");
    expect("--init refuses an unreadable OB1_AUTH_TIERS and writes nothing", /no such tier: nope/.test(await initSecrets(badTier).then(() => "", (e) => (e as Error).message)) && readFileSync(badTier, "utf8") === "OB1_AUTH_TIERS=stable,nope\n");

    // registration.ts: every spelling the library routes to registration, and the gate.
    const routed = ["/auth/reg", "/auth/REG", "/auth/Reg", "/auth/reg/", "/AUTH/reg"];
    const notRouted = ["/auth/reg/abc", "/auth/register", "/auth//reg", "/auth/regx", "/reg", "/auth/reg//", "/x/auth/reg"];
    expect(
      "the registration path matches every spelling the library's router takes under /auth (any case, a trailing slash; server.ts forwards /auth/ in lower case alone, so an upper-case /AUTH is a 404 before it) and nothing else",
      routed.every((p) => REGISTRATION_PATH.test(p)) && notRouted.every((p) => !REGISTRATION_PATH.test(p)),
      `${routed.filter((p) => !REGISTRATION_PATH.test(p)).join(", ")} | ${notRouted.filter((p) => REGISTRATION_PATH.test(p)).join(", ")}`,
    );
    let stored = 1;
    const gate = new RegistrationGate(3, () => stored);
    const firstTwo = gate.admit() && gate.admit();
    expect("the gate admits while the stored and the under-way stay under the bound, and counts the ones under way", firstTwo && gate.underWay === 2 && !gate.admit());
    gate.release();
    stored = 2; // one of the two saved its client before its response closed
    expect("a released place is given back, and a saved client still counts against it", !gate.admit());
    gate.release();
    expect("with nothing under way, room is the stored clients' alone", gate.underWay === 0 && gate.admit() && !gate.admit());
    gate.release();
    gate.release();
    expect("a release with nothing under way does not go below zero", gate.underWay === 0);

    // deploy/tier.sh's own filter, run: what it hands tier.ts's container.
    const tierSh = readFileSync(join(HERE, "..", "tier.sh"), "utf8");
    // The loop that reads compose's environment, wherever it sits: the one
    // whose `case` names OB1_* (a comment moved above it must not fail this).
    const loop = [...tierSh.matchAll(/while IFS= read -r line; do\n[\s\S]*?\ndone <<< "\$RESOLVED"\n/g)].map((m) => m[0]).find((l) => l.includes("OB1_*"));
    const handed = join(dir, "tier-handed.env");
    const resolved = ["OB1_TIER=canary", "OB1_AUTH_JWKS={}", "OB1_AUTH_COOKIE_KEYS=c", "OB1_AUTH_OPERATOR_PASSWORD=x", "OB1_AUTH_OPERATOR_PASSWORD_HASH=h", "OB1_AUTH_SECRET_GUI=y", "OB1_ENV_FILE=f", "POSTGRES_PASSWORD=p", "OPENROUTER_API_KEY=o", "MCP_ACCESS_KEYS=k"].join("\n");
    const ran = loop ? Bun.spawnSync(["bash", "-c", `TMP_ENV="$1"; RESOLVED="$2"; POSTGRES_PASSWORD=""\n${loop}`, "tier", handed, resolved]) : undefined;
    const got = ran?.exitCode === 0 && existsSync(handed) ? readFileSync(handed, "utf8").trim().split("\n") : [];
    expect("deploy/tier.sh hands tier.ts no OB1_AUTH_* setting, and still hands its own", JSON.stringify(got) === '["OB1_TIER=canary","POSTGRES_PASSWORD=p","OPENROUTER_API_KEY=o"]', loop ? JSON.stringify(got) : "the loop was not found in tier.sh");

    // deploy/compose.yaml's `auth` service, as written.
    const doc = Bun.YAML.parse(readFileSync(COMPOSE_FILE, "utf8")) as any;
    const auth = doc?.services?.auth ?? {};
    const env = auth.environment ?? {};
    expect("compose: the auth service is in the auth profile alone", JSON.stringify(auth.profiles) === '["auth"]');
    expect(
      "compose: it passes exactly the layout, the keys, the hash, the registration cap and the fixed clients' secrets, each as ${X:-}",
      JSON.stringify(Object.keys(env).sort()) === JSON.stringify([...COMPOSE_PASSES].sort()) && Object.entries(env).every(([k, v]) => v === `\${${k}:-}`),
      Object.keys(env).join(", "),
    );
    expect("compose: no password, POC switch or Postgres credential reaches it", !Object.keys(env).some((k) => /PASSWORD$|POC|POSTGRES|DATABASE/.test(k)) && auth.env_file === undefined);
    expect("compose: it publishes no port", auth.ports === undefined);
    expect(
      "compose: it is on the internal mesh as auth.ob1.internal and on the egress network, and nowhere else",
      JSON.stringify(Object.keys(auth.networks ?? {}).sort()) === '["egress","mesh"]' && JSON.stringify(auth.networks.mesh?.aliases) === '["auth.ob1.internal"]' && doc.networks?.mesh?.internal === true && !doc.networks?.egress?.internal,
    );
    expect(
      "compose: its files are read-only, it keeps no capability or new privilege, and init forwards the stop",
      auth.read_only === true && JSON.stringify(auth.cap_drop) === '["ALL"]' && auth.cap_add === undefined && JSON.stringify(auth.security_opt) === '["no-new-privileges:true"]' && auth.init === true && auth.privileged === undefined,
    );
    expect(
      "compose: it restarts unless stopped, and its health is /healthz answering ok, on its timings",
      auth.restart === "unless-stopped" &&
        JSON.stringify(auth.healthcheck) === JSON.stringify({ test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], interval: "10s", timeout: "3s", retries: 3, start_period: "10s" }),
      JSON.stringify(auth.healthcheck),
    );
    expect(
      "compose: it builds deploy/auth/, its networks are this project's own (mesh internal) and joined as written, and its volume is a plain named one",
      JSON.stringify(auth.build) === '{"context":"./auth"}' && JSON.stringify(doc.networks) === '{"mesh":{"internal":true},"egress":{}}' && JSON.stringify(auth.networks) === '{"mesh":{"aliases":["auth.ob1.internal"]},"egress":{}}' && doc.volumes?.["auth-data"] === null,
      `build ${JSON.stringify(auth.build)}, networks ${JSON.stringify(doc.networks)}, joined ${JSON.stringify(auth.networks)}, volume ${JSON.stringify(doc.volumes?.["auth-data"])}`,
    );
    expect("compose: its one mount is the auth-data volume at /data", JSON.stringify(auth.volumes) === '["auth-data:/data"]' && JSON.stringify(auth.tmpfs) === '["/tmp"]' && "auth-data" in (doc.volumes ?? {}));
    const keys = ["build", "cap_drop", "environment", "healthcheck", "init", "networks", "profiles", "read_only", "restart", "security_opt", "tmpfs", "volumes"];
    const extra = Object.keys(auth).filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !Object.hasOwn(auth, k));
    expect("compose: the service sets these keys and no other (no user, mount, pid, privilege or host entry beside them)", !extra.length && !missing.length, `added ${extra.join(", ") || "none"}; missing ${missing.join(", ") || "none"} — a new key is a decision: add it to this list with the reason`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} probe(s) failed` : "\nauth provision self-check: OK");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = "usage: bun deploy/auth/provision.ts [--init] [--env-file deploy/.env]";
  const unknown = args.filter((a, i) => a.startsWith("--") && !["--env-file", "--init"].includes(a) && args[i - 1] !== "--env-file");
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}\n${usage}`);
    process.exit(2);
  }
  const i = args.indexOf("--env-file");
  const envFile = resolve(i >= 0 ? args[i + 1] : ENV_FILE);
  if (!existsSync(envFile)) {
    console.error(`${envFile} does not exist — the profile's secrets live in the stack's env file (deploy/.env; --env-file names another)`);
    process.exit(2);
  }
  if (args.includes("--init")) {
    try {
      const written = await initSecrets(envFile);
      console.log(written.length ? `wrote ${written.join(", ")} to ${envFile}` : `${envFile} already holds the profile's secrets`);
      const warning = readableWarning(envFile);
      if (warning) console.log(warning);
    } catch (e) {
      console.error(`--init wrote nothing: ${(e as Error).message}`);
      process.exit(2);
    }
    const env = parseEnv(readFileSync(envFile, "utf8"));
    if (!env.OB1_PUBLIC_ORIGIN) console.log("still to set: OB1_PUBLIC_ORIGIN, the brain's public origin (https://…), which the server will not start without");
    console.log("back up OB1_AUTH_JWKS, OB1_AUTH_COOKIE_KEYS, OB1_AUTH_OPERATOR_PASSWORD and every OB1_AUTH_SECRET_* with POSTGRES_PASSWORD; if the server was running, recreate it (compose up -d --wait auth, with compose as in deploy/README.md, Authorization server; not `compose restart`, which keeps the old values)");
    process.exit(0);
  }
  const { problems, notes } = await checkEnvFile(envFile);
  for (const n of notes) console.log(n);
  if (problems.length) {
    console.error(`${envFile}: the authorization server would not start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${envFile}: the authorization server would start with these settings`);
}
