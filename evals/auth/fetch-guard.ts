/**
 * fetch-guard.ts — the authorization server's only way out (SMD-2285).
 *
 * oidc-provider fetches three kinds of document on a client's say-so: a client
 * ID metadata document (the `client_id` itself is the URL), a `jwks_uri` and a
 * `sector_identifier_uri`. All three go through its `fetch` option. Its own SSRF
 * protection is an undici dispatcher that drops a socket connected to a
 * special-use address, and Bun has no undici dispatcher. Under Bun 1.4.0,
 * oidc-provider 9.12.2 prints "failed to setup SSRF protection for fetch" and
 * then dials whatever the URL names (measured: an authorization request whose
 * `client_id` was `https://127.0.0.1:4443/client.json` opened two connections to
 * that port). So the service passes this function as `fetch`, and the check is
 * ours on every runtime.
 *
 * The rules, each refused BEFORE a connection is opened:
 * - https only, GET only;
 * - a host that names the mesh (`*.ob1.internal`), `localhost` or a single-label
 *   name (a compose service name such as `postgres`) is refused by name;
 * - an IP literal, and every address a name resolves to, must be globally
 *   routable. One special-use answer refuses the whole name.
 * The check runs inside the socket's own DNS lookup, so the address checked is
 * the address dialled, and a name that rebinds between two lookups gains
 * nothing. No redirect is followed (the provider refuses a non-200 anyway), the
 * body is capped, and the provider's own 2.5 s abort signal is honoured.
 *
 * Dependency-free (node: built-ins only), so `eval-auth.ts --self-check` holds
 * the classifier without a stack.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/** What the provider may read from one fetch at most, whatever the purpose's own limit (jwks_uri has none). */
export const BODY_CAP = 64 * 1024;

/** [first address, prefix length, why] — IANA's special-purpose registries, plus multicast and the reserved block. */
const V4: [string, number, string][] = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private (RFC 1918)"],
  ["100.64.0.0", 10, "shared address space, CGNAT and Tailscale (RFC 6598)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local, cloud metadata"],
  ["172.16.0.0", 12, "private (RFC 1918)"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay anycast"],
  ["192.168.0.0", 16, "private (RFC 1918)"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved, broadcast"],
];

const V6: [string, number, string][] = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["::", 96, "IPv4-compatible (deprecated)"],
  ["64:ff9b::", 96, "NAT64, embeds an IPv4 address"],
  ["64:ff9b:1::", 48, "local-use NAT64"],
  ["100::", 64, "discard-only"],
  ["2001::", 23, "IETF protocol assignments, Teredo among them"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4, embeds an IPv4 address"],
  ["3fff::", 20, "documentation"],
  ["5f00::", 16, "segment routing"],
  ["fc00::", 7, "unique local (ULA)"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local (deprecated)"],
  ["ff00::", 8, "multicast"],
];

function v4ToInt(ip: string): bigint {
  return ip.split(".").reduce((n, octet) => (n << 8n) | BigInt(Number(octet)), 0n);
}

function v6ToInt(ip: string): bigint {
  let text = ip.toLowerCase().split("%")[0];
  // A dotted tail (::ffff:10.0.0.1) becomes its two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

function inRange(value: bigint, first: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === first >> shift;
}

/** Why an address may not be dialled, or null when it is globally routable. */
export function specialUse(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const n = v4ToInt(address);
    for (const [first, prefix, why] of V4) if (inRange(n, v4ToInt(first), prefix, 32)) return `${address} is ${why}`;
    return null;
  }
  if (family === 6) {
    const n = v6ToInt(address);
    // An IPv4-mapped address (::ffff:a.b.c.d) is its IPv4 address.
    if (n >> 32n === 0xffffn) {
      const v4 = [24n, 16n, 8n, 0n].map((s) => ((n >> s) & 0xffn).toString()).join(".");
      const why = specialUse(v4);
      return why ? `${address} maps ${why}` : null;
    }
    for (const [first, prefix, why] of V6) if (inRange(n, v6ToInt(first), prefix, 128)) return `${address} is ${why}`;
    return null;
  }
  return `${address} is not an IP address`;
}

/** Why a host may not be fetched by its name alone, or null. An IP literal is judged by specialUse instead. */
export function refusedName(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return `${host} names this machine`;
  if (name === "ob1.internal" || name.endsWith(".ob1.internal")) return `${host} names the mesh`;
  if (!name.includes(".")) return `${host} is a single-label name, as a compose service is`;
  return null;
}

/** The host of a URL as a bare name or address (an IPv6 literal loses its brackets). */
function bareHost(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/** Why a URL is refused before any lookup, or null. */
export function refusedUrl(url: URL, method = "GET"): string | null {
  if (url.protocol !== "https:") return `${url.protocol} is not https:`;
  if (method.toUpperCase() !== "GET") return `${method} is not GET`;
  const host = bareHost(url);
  return isIP(host) ? specialUse(host) : refusedName(host);
}

export type Log = (line: string) => void;

/**
 * The socket's DNS lookup, checking every answer before the socket dials one.
 * `resolve` stands in for the system resolver in the self-check.
 */
export function guardedLookup(log: Log, url: string, resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  return ((host: string, options: { all?: boolean; family?: number }, done: (e: Error | null, a?: string | LookupAddress[], f?: number) => void) => {
    resolve(host, { all: true, family: options.family ?? 0 }, (err, answers) => {
      if (err) return done(err);
      const list = answers as LookupAddress[];
      const why = list.length ? list.map((a) => specialUse(a.address)).find((w) => w !== null) : `${host} resolved to nothing`;
      if (why) {
        log(`fetch-guard: refused ${url} — ${why}`);
        return done(Object.assign(new Error(`fetch refused: ${why}`), { code: "EREFUSED_BY_GUARD" }));
      }
      if (options.all) return done(null, list);
      done(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

/** A fetch() for oidc-provider's `fetch` option, with every rule above. */
export function guardedFetch(log: Log = (l) => console.log(l)) {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? "GET";
    const early = refusedUrl(url, method);
    if (early) {
      log(`fetch-guard: refused ${url.href} — ${early}`);
      throw new Error(`fetch refused: ${early}`);
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { if (v !== "") headers[k] = v; });
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: "GET", headers, lookup: guardedLookup(log, url.href), signal: init.signal ?? undefined, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BODY_CAP) {
            log(`fetch-guard: cut ${url.href} — body over ${BODY_CAP} bytes`);
            res.destroy(new Error(`fetch refused: body over ${BODY_CAP} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
          const status = res.statusCode ?? 502;
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: out }));
        });
      });
      req.on("error", reject);
      req.end();
    });
  };
}
