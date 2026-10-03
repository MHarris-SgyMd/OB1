/**
 * limits.ts — the authorization server's own abuse limits (SMD-2309's `/auth`
 * slice), kept in memory: a restart forgets them. Two layers.
 *
 * **Always on, safe when every client looks like one address.** A tunnel on
 * the host (cloudflared, `tailscale funnel`, caddy) dials the proxy from one
 * address, and the proxy forwards one address for the whole internet. So
 * nothing here may lock anyone out on an address it cannot trust:
 * - **Password checks** draw from one bucket: ten at once, then one a second
 *   (`SIGN_IN_RATE`). A right password gives its check back, so only wrong
 *   ones spend it. Past it a sign-in is answered 429 with a Retry-After of a
 *   second or so. That bounds a guesser to about 3,600 tries an hour across
 *   every address. It does not keep the operator in: a flood takes each
 *   check as it refills, and the right password is refused while the flood
 *   lasts (measured: none or one of twenty got in). It leaves nothing behind
 *   when the flood stops; the loopback sign-in that answers a flood is
 *   SMD-2286's.
 *   With a trusted proxy, an address that wins checks is locked out after six
 *   (below), so one address cannot hold the bucket long.
 * - **A sign-in flow** (one interaction) takes `TRIES_PER_SIGN_IN` wrong
 *   passwords, then must start again.
 * - **Registration** has the cap and the purge (registration.ts, store.ts).
 *
 * **Per address, only with a trusted proxy.** When OB1_AUTH_TRUSTED_PROXY
 * names the proxy (a host name or address, resolved at start and every five
 * minutes; while it does not resolve these limits are off), a request from
 * it is attributed to the entry of `X-Forwarded-For` that sits
 * OB1_AUTH_FORWARDED_HOPS from the right (1: the proxy's own record of its
 * peer; 2: a tunnel's record, when the tunnel writes one and the proxy
 * trusts it), and a request from anyone else to its own peer address. No
 * peer can choose its address by a header. A request whose entry is missing
 * is left to the first layer, never charged to the proxy's own address. An
 * IPv6 address counts by its /64. On that address:
 * - `SignInBackoff`: five wrong passwords are free; each one after locks the
 *   address out of signing in for a minute, doubling, at most fifteen. A
 *   right password clears it; fifteen minutes past both its last failure and
 *   the end of its lockout forgets it.
 * - failed client authentications, per address and client (`clientKey`):
 *   twenty in fifteen minutes refuse that client's token and revocation
 *   requests from that address until the oldest falls out. Only a request
 *   that presented a credential, for a client that exists and holds a
 *   secret, counts (server.ts), so a public client asking with a forgotten
 *   `client_id` never does.
 * - registrations: OB1_AUTH_REGISTRATIONS_PER_HOUR an hour (30 unless set).
 *
 * A sign-in or a registration is reserved before any await (the body read,
 * the verify, the library), so a burst of concurrent ones is held to the same
 * count as the same ones one at a time. A failed client authentication is
 * counted only once the library answers, so a burst can pass twenty by the
 * requests already in flight (SMD-2498). Each refusal here is a 429 (the
 * registration cap keeps its 503), with Retry-After where waiting helps (a
 * spent sign-in starts again instead).
 * Each map is bounded: entries past `MAX_ENTRIES` evict the oldest.
 *
 *   bun deploy/auth/limits.ts --self-check   # the rules, on a clock of their own (CI)
 */
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

const MIN = 60_000;
/** The most entries any per-address map keeps; the oldest go first past it. */
export const MAX_ENTRIES = 50_000;

/** Map insertion order is age order: re-inserting a key moves it to the end. */
function touch<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

/** A bucket of `capacity`, refilled one every `everyMs`: take() is 0 when it took one, or the ms until one is there. */
export class Bucket {
  #tokens: number;
  #at: number;

  constructor(
    readonly capacity: number,
    readonly everyMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#tokens = capacity;
    this.#at = now();
  }

  take(): number {
    const t = this.now();
    this.#tokens = Math.min(this.capacity, this.#tokens + (t - this.#at) / this.everyMs);
    this.#at = t;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.#tokens) * this.everyMs);
  }

  /** Puts one back (take() caps the bucket): a right password costs nothing. */
  giveBack() {
    this.#tokens += 1;
  }
}

/** Password checks across every address: ten at once, then one a second. */
export const SIGN_IN_RATE = { capacity: 10, everyMs: 1_000 };
/** Wrong passwords one sign-in flow takes before it must start again. */
export const TRIES_PER_SIGN_IN = 5;

/** Attempts per key (a sign-in flow), each reserved before its verify, forgotten after `ttlMs`. */
export class Tries {
  readonly #byKey = new Map<string, { n: number; at: number }>();

  constructor(
    readonly limit: number,
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the key has a try left, reserving nothing (to check every limit before reserving any). */
  has(key: string): boolean {
    return this.#used(key) < this.limit;
  }

  /** Reserve a try: false when the key has used its limit. */
  take(key: string): boolean {
    const n = this.#used(key);
    if (n >= this.limit) return false;
    touch(this.#byKey, key, { n: n + 1, at: this.now() });
    return true;
  }

  #used(key: string): number {
    const e = this.#byKey.get(key);
    return e && this.now() - e.at < this.ttlMs ? e.n : 0;
  }

  /** The right password: the key's tries are spent with it. */
  clear(key: string): void {
    this.#byKey.delete(key);
  }
}

/** Wrong passwords per address, with a lockout that doubles past the free ones. Reserve with attempt(), then settle with succeeded() on the right password. */
export class SignInBackoff {
  static readonly FREE = 5;
  static readonly FIRST_LOCK_MS = MIN;
  static readonly MAX_LOCK_MS = 15 * MIN;
  static readonly FORGET_MS = 15 * MIN;
  readonly #byAddress = new Map<string, { failures: number; last: number; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Before the verify: 0 and the attempt counted as a failure (so a burst is
   * held as one at a time is), or the ms the address must wait. succeeded()
   * takes the count back.
   */
  attempt(address: string): number {
    const wait = this.wait(address);
    if (wait) return wait;
    this.failed(address);
    return 0;
  }

  /** Milliseconds the address must wait before trying again, or 0. */
  wait(address: string): number {
    const e = this.#live(address);
    return e ? Math.max(0, e.until - this.now()) : 0;
  }

  /** A wrong password from the address: counted, and past the free ones a lockout. */
  failed(address: string): void {
    const t = this.now();
    const e = this.#live(address) ?? { failures: 0, last: t, until: 0 };
    e.failures++;
    e.last = t;
    const over = e.failures - SignInBackoff.FREE;
    if (over > 0) e.until = t + Math.min(SignInBackoff.MAX_LOCK_MS, SignInBackoff.FIRST_LOCK_MS * 2 ** (over - 1));
    touch(this.#byAddress, address, e);
  }

  /** The right password: the address starts clean. */
  succeeded(address: string): void {
    this.#byAddress.delete(address);
  }

  /** The entry if it is still remembered: forgotten once FORGET_MS has passed since both its last failure and the end of its lockout. */
  #live(address: string) {
    const e = this.#byAddress.get(address);
    if (!e) return undefined;
    if (this.now() - Math.max(e.last, e.until) >= SignInBackoff.FORGET_MS) {
      this.#byAddress.delete(address);
      return undefined;
    }
    return e;
  }
}

/** Events per address in a sliding window: at `limit`, refused until the oldest falls out. take() reserves one; giveBack() returns it. */
export class WindowLimit {
  readonly #byAddress = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until the address may act again, or 0. */
  wait(address: string): number {
    const times = this.#live(address);
    return times.length < this.limit ? 0 : Math.max(1, times[0] + this.windowMs - this.now());
  }

  /** Reserve one event: 0 and counted, or the ms until the address may act. */
  take(address: string): number {
    const wait = this.wait(address);
    if (wait) return wait;
    this.record(address);
    return 0;
  }

  /** One event from the address; only the last `limit` are kept, all the window needs. */
  record(address: string): void {
    const times = this.#live(address);
    times.push(this.now());
    touch(this.#byAddress, address, times.slice(-this.limit));
  }

  /** An event reserved and not used (the request failed): the newest one goes back. */
  giveBack(address: string): void {
    const times = this.#byAddress.get(address);
    if (times?.length) times.pop();
  }

  #live(address: string): number[] {
    const since = this.now() - this.windowMs;
    const times = (this.#byAddress.get(address) ?? []).filter((t) => t > since);
    if (!times.length) this.#byAddress.delete(address);
    return times;
  }
}

/** Failed client authentications at the token and revocation endpoints, per address and client. */
export const TOKEN_FAILURES = { limit: 20, windowMs: 15 * MIN };

/** The token and revocation endpoints as the library routes them: any case, a trailing slash (registration.ts says why). */
export const TOKEN_PATH = /^\/auth\/token(\/revocation)?\/?$/i;

/**
 * The client a token or revocation request names: the id in its Basic header
 * (form-encoded, RFC 6749 2.3.1), else its body's `client_id`, else the `sub`
 * of its `client_assertion` (read, not verified: it only picks the key), else
 * none. Failed authentications count per address and client, so one client
 * failing from an address shared by many (a platform's egress) refuses no
 * other.
 */
export function clientIdOf(authorization: string | undefined, bodyClientId: unknown, assertion?: unknown): string {
  const basic = /^basic\s+(\S+)/i.exec(authorization ?? "");
  if (basic) {
    const id = Buffer.from(basic[1], "base64").toString().split(":")[0];
    try {
      return decodeURIComponent(id.replace(/\+/g, " "));
    } catch {
      return id;
    }
  }
  if (typeof bodyClientId === "string") return bodyClientId;
  if (typeof assertion !== "string") return "";
  try {
    const sub = (JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}

/** The key failed client authentications are counted under. */
export const clientKey = (address: string, clientId: string) => `${address} ${clientId}`;

/**
 * Whether a token- or revocation-endpoint error counts against its address and client:
 * a failed client authentication by a request that presented a credential
 * (a Basic header, a client_secret or a client_assertion). A public client
 * asking with a client_id the purge removed presents none, and never counts.
 */
export function countsAgainstClient(error: { error?: string } | undefined, presented: { authorization?: string; client_secret?: unknown; client_assertion?: unknown }): boolean {
  return error?.error === "invalid_client" && !!(presented.authorization || presented.client_secret || presented.client_assertion);
}

/**
 * An address in one form, however it was written, so the trusted proxy's and
 * a peer's compare equal: no brackets, port or zone; IPv6 as a URL writes it
 * (lower case, zeros compressed, no dotted tail); a v4-mapped one as IPv4.
 * Undefined when it is not an address.
 */
function plainAddress(raw: string): string | undefined {
  let a = raw.trim();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") >>> 0);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.slice(0, a.indexOf(":"));
  a = a.replace(/%.*$/, "");
  const family = isIP(a);
  if (family === 4) return a;
  if (family !== 6) return undefined;
  a = new URL(`http://[${a}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (!mapped) return a;
  const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * The key an address is limited under: an IPv4 address whole, an IPv6 one by
 * its /64, the block one subscriber is handed, so a new address from the same
 * block is the same key.
 */
export function addressKey(raw: string): string | undefined {
  const a = plainAddress(raw);
  if (!a || isIP(a) === 4) return a;
  const [head, tail = ""] = a.split("::");
  const h = head.split(":").filter(Boolean);
  const t = tail.split(":").filter(Boolean);
  const full = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/**
 * The client's address key (addressKey). Without a trusted proxy, the
 * socket's: a peer is its own address and no header changes that. A request
 * from a trusted proxy is its X-Forwarded-For entry `hops` from the right;
 * with that entry missing or not an address, undefined, and the per-address
 * limits leave the request alone, since the proxy's own address would make
 * every client one.
 */
export function clientAddress(req: IncomingMessage, trusted: ReadonlySet<string>, hops: number): string | undefined {
  const peer = plainAddress(req.socket.remoteAddress ?? "");
  if (peer === undefined) return undefined;
  if (!trusted.has(peer)) return addressKey(peer);
  const xff = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
  const entry = chain[chain.length - hops];
  return entry === undefined ? undefined : addressKey(entry);
}

type Lookup = (name: string) => Promise<{ address: string }[]>;
const lookupAll: Lookup = (name) => lookup(name, { all: true });

/**
 * The trusted proxy's addresses, resolved from a host name or taken as given;
 * re-resolved every five minutes, since compose can move a container. A
 * failed resolution empties the set (the per-address limits go off) rather
 * than keep an address compose may have handed to another container.
 */
export function trustedProxy(name: string | undefined, find: Lookup = lookupAll, everyMs = 5 * MIN): { set: ReadonlySet<string>; resolve: () => Promise<void> } {
  const set = new Set<string>();
  if (!name) return { set, resolve: async () => {} };
  const resolve = () =>
    find(name).then(
      (found) => {
        set.clear();
        for (const a of found) set.add(plainAddress(a.address) ?? a.address);
      },
      (e: Error) => {
        set.clear();
        console.error(`OB1_AUTH_TRUSTED_PROXY ${name} did not resolve (${e.message}); the per-address limits are off until it does`);
      },
    );
  void resolve();
  setInterval(resolve, everyMs).unref();
  return { set, resolve };
}

/** Whole seconds for Retry-After, rounded up, at least 1. */
export const retryAfter = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

async function selfCheck(): Promise<number> {
  let failed = 0;
  const expect = (what: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  let t = 1_000_000_000;
  const clock = () => t;

  // the global bucket
  const b = new Bucket(SIGN_IN_RATE.capacity, SIGN_IN_RATE.everyMs, clock);
  const burst = Array.from({ length: 12 }, () => b.take());
  expect("the password bucket takes ten at once, then refuses with the ms until the next", burst.slice(0, 10).every((w) => w === 0) && burst[10] === 1_000 && burst[11] === 1_000, burst.join(","));
  t += 1_000;
  expect("a second later it takes one more, and refuses the next", b.take() === 0 && b.take() > 0);
  t += 60_000;
  expect("it refills to ten, never more", Array.from({ length: 11 }, () => b.take()).filter((w) => w === 0).length === 10);
  b.giveBack();
  const back = [b.take(), b.take()];
  t += 60_000;
  b.giveBack();
  expect("one given back is taken at once, and none past ten", back[0] === 0 && back[1] > 0 && Array.from({ length: 11 }, () => b.take()).filter((w) => w === 0).length === 10);

  // tries per sign-in flow
  const tr = new Tries(TRIES_PER_SIGN_IN, 600_000, clock);
  const flow = Array.from({ length: 7 }, () => tr.take("uid-1"));
  expect("a sign-in flow takes five tries, then must start again", flow.filter(Boolean).length === 5 && !flow[5] && !flow[6]);
  expect("a spent flow has no try left, and checking reserves none", !tr.has("uid-1") && tr.has("uid-3") && tr.has("uid-3") && Array.from({ length: 5 }, () => tr.take("uid-3")).every(Boolean));
  expect("another flow is untouched", tr.take("uid-2"));
  tr.clear("uid-1");
  expect("a right password spends the flow's tries", tr.take("uid-1"));
  t += 600_000;
  expect("a flow's tries are forgotten with the flow", Array.from({ length: 5 }, () => tr.take("uid-2")).every(Boolean));

  // per address
  const s = new SignInBackoff(clock);
  const first = Array.from({ length: 8 }, () => s.attempt("a"));
  expect("a burst of eight from one address: five free, the sixth reserved and locking, the rest refused", first.slice(0, 6).every((w) => w === 0) && first[6] === MIN && first[7] === MIN, first.join(","));
  expect("another address is untouched", s.wait("b") === 0);
  t += MIN;
  s.failed("a");
  expect("each one after doubles the lockout", s.wait("a") === 2 * MIN);
  for (let i = 0; i < 10; i++) {
    t += s.wait("a");
    s.failed("a");
  }
  expect("the lockout stops at fifteen minutes", s.wait("a") === 15 * MIN, String(s.wait("a")));
  t += s.wait("a");
  s.failed("a");
  expect("a lockout's end hands back no free tries: the next wrong password locks again at once", s.wait("a") === 15 * MIN, String(s.wait("a")));
  s.succeeded("a");
  expect("a right password clears the address", s.wait("a") === 0);
  for (let i = 0; i < SignInBackoff.FREE; i++) s.failed("c");
  t += 15 * MIN;
  s.failed("c");
  expect("fifteen minutes with no wrong password forgets the earlier ones", s.wait("c") === 0);
  for (let i = 0; i < SignInBackoff.FREE; i++) s.failed("d");
  t += 15 * MIN - 1;
  s.failed("d");
  expect("a wrong password a millisecond inside the fifteen minutes still counts", s.wait("d") === MIN);
  const ok = new SignInBackoff(clock);
  for (let i = 0; i < 5; i++) ok.attempt("e");
  ok.attempt("e");
  ok.succeeded("e");
  expect("a right sixth password, reserved like the rest, still clears", ok.wait("e") === 0);

  const w = new WindowLimit(3, 10 * MIN, clock);
  const takes = Array.from({ length: 5 }, () => w.take("x"));
  expect("a burst takes up to the limit and is refused past it", takes.slice(0, 3).every((v) => v === 0) && takes[3] > 0 && takes[4] > 0, takes.join(","));
  w.giveBack("x");
  expect("a reserved event given back frees its place", w.take("x") === 0 && w.take("x") > 0);
  expect("another address is untouched", w.wait("y") === 0);
  t += 10 * MIN;
  expect("the window passes and the address may act again", w.wait("x") === 0);
  for (let i = 0; i < 4; i++, t += MIN) w.record("z");
  t -= MIN;
  expect("past the limit (failures already in flight), the wait is until the count is under it again", w.wait("z") === 8 * MIN, String(w.wait("z")));

  // the token path and what counts
  const routed = ["/auth/token", "/auth/TOKEN/", "/auth/token/revocation", "/auth/Token/Revocation/"];
  const notRouted = ["/auth/tokens", "/auth/token//", "/auth/token/introspection", "/x/auth/token", "/auth/token/revocation/x"];
  expect("the token path matches the library's spellings and nothing else", routed.every((p) => TOKEN_PATH.test(p)) && notRouted.every((p) => !TOKEN_PATH.test(p)));
  expect(
    "only invalid_client with a credential presented counts",
    countsAgainstClient({ error: "invalid_client" }, { authorization: "Basic x" }) &&
      countsAgainstClient({ error: "invalid_client" }, { client_secret: "s" }) &&
      countsAgainstClient({ error: "invalid_client" }, { client_assertion: "a" }) &&
      !countsAgainstClient({ error: "invalid_client" }, {}) &&
      !countsAgainstClient({ error: "invalid_grant" }, { authorization: "Basic x" }) &&
      !countsAgainstClient({ error: "server_error" }, { authorization: "Basic x" }),
  );

  // the address rule
  const req = (peer: string, xff?: string | string[]) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  const none = new Set<string>();
  const proxy = new Set(["172.20.0.5"]);
  expect("with no trusted proxy, the peer's address, whatever X-Forwarded-For says", clientAddress(req("172.20.0.5", "203.0.113.7"), none, 1) === "172.20.0.5");
  expect("from the trusted proxy, one hop: the last entry", clientAddress(req("172.20.0.5", "198.51.100.1, 203.0.113.7"), proxy, 1) === "203.0.113.7");
  expect("from the trusted proxy, two hops: the entry before it (the tunnel's record of its client)", clientAddress(req("172.20.0.5", "198.51.100.1, 203.0.113.7"), proxy, 2) === "198.51.100.1");
  expect("another peer cannot choose its address by a header", clientAddress(req("172.20.0.9", "203.0.113.7"), proxy, 1) === "172.20.0.9");
  expect("from the trusted proxy with the entry missing or not an address, none (never the proxy's own)", clientAddress(req("172.20.0.5"), proxy, 1) === undefined && clientAddress(req("172.20.0.5", "203.0.113.7"), proxy, 2) === undefined && clientAddress(req("172.20.0.5", "unknown"), proxy, 1) === undefined);
  expect("a repeated header reads as one list, and a v4-mapped peer as v4", clientAddress(req("::ffff:172.20.0.5", ["198.51.100.1", "203.0.113.8"]), proxy, 1) === "203.0.113.8");
  expect(
    "an entry written with a port, brackets or v4-mapped is the address alone",
    clientAddress(req("172.20.0.5", "203.0.113.7:51234"), proxy, 1) === "203.0.113.7" && clientAddress(req("172.20.0.5", "[2001:db8::1]:443"), proxy, 1) === "2001:db8:0:0::/64" && clientAddress(req("172.20.0.5", "::FFFF:203.0.113.7"), proxy, 1) === "203.0.113.7" && clientAddress(req("172.20.0.5", "::ffff:cb00:7107"), proxy, 1) === "203.0.113.7",
  );
  expect(
    "an IPv6 address is limited by its /64, however it is written",
    addressKey("2001:db8:aa:bb:1::2") === "2001:db8:aa:bb::/64" && addressKey("2001:0DB8:00aa:00bb:ffff::9") === "2001:db8:aa:bb::/64" && addressKey("2001:db8::") === "2001:db8:0:0::/64" && addressKey("::1") === "0:0:0:0::/64" && addressKey("fe80::1%eth0") === "fe80:0:0:0::/64" && addressKey("2001:db8::5:6:7:1.2.3.4") === "2001:db8:0:5::/64" && addressKey("1:2:3:4:5:6:7:8%a:b") === "1:2:3:4::/64" && addressKey("2001:db8:aa:bc::1") !== addressKey("2001:db8:aa:bb::1"),
  );
  expect("a peer on IPv6 is keyed by its /64 too", clientAddress(req("2001:db8:aa:bb::5"), none, 1) === "2001:db8:aa:bb::/64");
  expect(
    "a trusted proxy written in any form matches its peer",
    clientAddress(req("fd00::5", "203.0.113.7"), new Set([plainAddress("FD00:0:0:0:0:0:0:5")!]), 1) === "203.0.113.7" && clientAddress(req("::ffff:172.20.0.5", "203.0.113.7"), new Set([plainAddress("::FFFF:AC14:5")!]), 1) === "203.0.113.7",
  );
  expect(
    "a request names its client by its Basic header, else its body",
    clientIdOf(`Basic ${btoa("my%20app:secret")}`, "other") === "my app" && clientIdOf("basic " + btoa("gui:s"), undefined) === "gui" && clientIdOf(undefined, "dcr-1") === "dcr-1" && clientIdOf(undefined, ["x"]) === "" && clientKey("203.0.113.7", "gui") !== clientKey("203.0.113.7", "mcp"),
  );
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  expect(
    "an assertion with no client_id is keyed by its sub, and garbage by none",
    clientIdOf(undefined, undefined, jwt({ sub: "jwt-client", iss: "jwt-client" })) === "jwt-client" && clientIdOf(undefined, "named", jwt({ sub: "jwt-client" })) === "named" && clientIdOf(undefined, undefined, "not-a-jwt") === "" && clientIdOf(undefined, undefined, jwt({ sub: 7 })) === "",
  );

  // the trusted proxy's resolution
  let answer: { address: string }[] | Error = [{ address: "::ffff:172.20.0.5" }];
  const tp = trustedProxy(
    "proxy",
    async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    3_600_000,
  );
  await tp.resolve();
  const resolved = [...tp.set].join(",");
  answer = new Error("ENOTFOUND");
  const logged = console.error;
  console.error = () => {};
  await tp.resolve();
  console.error = logged;
  expect("the proxy's name resolves to its addresses, and a failed resolution empties the set", resolved === "172.20.0.5" && tp.set.size === 0, resolved);

  // bounded maps
  const big = new WindowLimit(1, 10 * MIN, clock);
  for (let i = 0; i < MAX_ENTRIES + 10; i++) big.record(`a${i}`);
  expect("a per-address map keeps at most MAX_ENTRIES, the oldest going first", big.wait("a0") === 0 && big.wait(`a${MAX_ENTRIES + 9}`) > 0);

  expect("Retry-After is whole seconds rounded up, at least one", retryAfter(1) === "1" && retryAfter(61_000) === "61" && retryAfter(60_500) === "61" && retryAfter(0) === "1");

  console.log(failed ? `\n${failed} probe(s) failed` : "\nall probes hold");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());
