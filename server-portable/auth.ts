/**
 * auth.ts — named, scoped, hashed access keys.
 *
 * What this replaces: a single shared secret compared with `!==`, accepted from
 * either a header or a `?key=` query parameter, granting full read and write. One
 * key for every client, no way to revoke one without re-keying all of them, and
 * the key itself sitting in plaintext in the environment.
 *
 * What changes, and why each matters here:
 *
 *   Scopes. `capture_thought` is the only tool that writes. A read-only key means
 *   a leaked ChatGPT connector URL cannot add or alter anything. Read-only keys do
 *   not merely fail to write — the write tool is never registered for them, so it
 *   does not appear in tools/list at all.
 *
 *   Named keys, revocable independently. One per client, so retiring the key you
 *   pasted into a laptop does not break the rest.
 *
 *   Hashed at rest. The server stores SHA-256 digests, so a leaked environment or
 *   config file does not hand over a usable credential.
 *
 *   Timing-safe comparison. `!==` on a secret leaks its prefix through response
 *   timing. Realistically hard to exploit across the internet against a 256-bit
 *   key, and upstream issue #216 says as much — but the fix is four lines.
 *
 * What deliberately does NOT change: `?key=` is still accepted. Claude Desktop's
 * custom connectors are URL-only, so removing it would break the primary client.
 * It remains the weakest part of this design — query strings reach access logs,
 * browser history and shell history — which is why scopes matter: give the
 * URL-embedded key read-only access wherever the client only needs to read.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type Scope = "read" | "write";

export type Principal = {
  /** Which configured key authenticated, for logging. Never the key itself. */
  name: string;
  scope: Scope;
};

export type KeyRecord = { name: string; scope: Scope; sha256: string };

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Parse `MCP_ACCESS_KEYS`: one `name:scope:sha256` per entry, separated by commas
 * or newlines. Comments and blank entries are ignored so the value can be kept in
 * a readable multi-line secret.
 */
export function parseKeyRecords(spec: string): { keys: KeyRecord[]; problems: string[] } {
  const keys: KeyRecord[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of spec.split(/[,\n]/)) {
    const entry = rawEntry.trim();
    if (!entry || entry.startsWith("#")) continue;

    const parts = entry.split(":");
    if (parts.length !== 3) {
      problems.push(`"${entry}" is not name:scope:sha256`);
      continue;
    }
    const [name, scope, sha] = parts.map((p) => p.trim());
    if (!name) problems.push(`an entry has no name`);
    if (scope !== "read" && scope !== "write") problems.push(`key "${name}" has scope "${scope}" — expected read or write`);
    if (!SHA256_HEX.test(sha)) {
      problems.push(
        `key "${name}" does not carry a SHA-256 hex digest. Store the HASH, not the key — mint one with: bun keygen.ts --name ${name || "client"} --scope ${scope || "read"}`
      );
    }
    if (seen.has(name)) problems.push(`key name "${name}" is used more than once`);
    seen.add(name);

    if (name && (scope === "read" || scope === "write") && SHA256_HEX.test(sha)) {
      keys.push({ name, scope, sha256: sha.toLowerCase() });
    }
  }

  return { keys, problems };
}

/** Constant-time digest comparison. Both inputs are fixed-length hex. */
function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export type AuthConfig = {
  /** Named, hashed, scoped keys — the preferred form. */
  MCP_ACCESS_KEYS?: string;
  /** A single raw key. Legacy: full write access, unhashed. */
  MCP_ACCESS_KEY?: string;
};

/**
 * Resolve a presented key to a principal, or null.
 *
 * Every configured key is compared even after a match, so the work done does not
 * depend on which key matched or on how many are configured.
 */
export function authenticate(presented: string | null | undefined, cfg: AuthConfig): Principal | null {
  if (!presented) return null;
  const presentedHash = hashKey(presented);

  let found: Principal | null = null;

  if (cfg.MCP_ACCESS_KEYS) {
    for (const k of parseKeyRecords(cfg.MCP_ACCESS_KEYS).keys) {
      if (digestsMatch(presentedHash, k.sha256) && found === null) {
        found = { name: k.name, scope: k.scope };
      }
    }
  }

  // Legacy single key. Full write access, kept so an existing deployment keeps
  // working; preflight warns about it.
  if (cfg.MCP_ACCESS_KEY) {
    const legacyMatch = digestsMatch(presentedHash, hashKey(cfg.MCP_ACCESS_KEY));
    if (legacyMatch && found === null) found = { name: "MCP_ACCESS_KEY", scope: "write" };
  }

  return found;
}

/** True when the principal may use tools that modify data. */
export function canWrite(p: Principal): boolean {
  return p.scope === "write";
}
