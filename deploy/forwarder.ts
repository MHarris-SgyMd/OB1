// The stack's published port (SMD-2583). The proxy is on internal networks alone, so a backend name
// nothing holds is never asked of the host's resolvers; this forwarder holds the port, on `edge`, and
// reaches the proxy on `front`, internal. Its own lookups reach the host's resolvers while the proxy
// is down, so it dials only an address inside the subnet of an interface no default route leaves by,
// front's. It sends the PROXY protocol's v1 line first, so the proxy, and the authorization server's
// per-address limits behind it, see each client's address rather than this one's. No dollar sign in
// this file, which compose would read as a variable, and no exclamation mark, which check 27 refuses
// in compose.tiers.yaml (compose reads one as a YAML tag): the script is inline in both.
import net from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { readFileSync } from "node:fs";

const PROXY = "proxy.ob1.internal.";
const PORT = 8000;
const DEADLINE_MS = 5000;

const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

/** The interfaces a default route leaves by, IPv4 and IPv6: never front's, which is internal. */
export function defaultRouteInterfaces(route4 = read("/proc/net/route"), route6 = read("/proc/net/ipv6_route")): Set<string> {
  const out = new Set<string>();
  for (const line of route4.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length > 7 && f[1] === "00000000" && f[7] === "00000000") out.add(f[0]);
  }
  for (const line of route6.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length > 9 && f[0] === "0".repeat(32) && f[1] === "00") out.add(f[9]);
  }
  return out;
}

const v4 = (a: string) => a.split(".").reduce((n, o) => n * 256n + BigInt(Number(o)), 0n);
function v6(a: string): bigint {
  const [head, tail = ""] = a.split("::");
  const parts = (s: string) => (s ? s.split(":") : []);
  const h = parts(head), t = a.includes("::") ? parts(tail) : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.reduce((n, g) => n * 65536n + BigInt(parseInt(g || "0", 16)), 0n);
}
/** Whether ADDRESS lies inside CIDR, both of one family. */
export function inside(address: string, cidr: string): boolean {
  const [base, len] = cidr.split("/");
  const bits = Number(len);
  if (net.isIPv4(address) && net.isIPv4(base)) return bits >= 0 && (v4(address) >> BigInt(32 - bits)) === (v4(base) >> BigInt(32 - bits));
  if (net.isIPv6(address) && net.isIPv6(base) && address.includes("%") === false) return bits >= 0 && (v6(address) >> BigInt(128 - bits)) === (v6(base) >> BigInt(128 - bits));
  return false;
}

/**
 * Whether ADDRESS is one of CIDR's own: its network address, its first host (the engine's gateway, which
 * Docker and podman both give a network, so the host's own listeners), or, for IPv4, its broadcast.
 */
export function reserved(address: string, cidr: string): boolean {
  const [base, len] = cidr.split("/");
  const width = net.isIPv4(base) ? 32n : 128n;
  const shift = width - BigInt(Number(len));
  const n = net.isIPv4(base) ? v4(address) : v6(address);
  const network = ((net.isIPv4(base) ? v4(base) : v6(base)) >> shift) << shift;
  return n === network || n === network + 1n || (width === 32n && n === network + (1n << shift) - 1n);
}

/**
 * The first of ADDRESSES inside the subnet of an interface that is neither loopback nor left by a default
 * route (front), and none of: the forwarder's own addresses (it would dial itself, each hop asking again,
 * measured in the thousands of sockets a second), the subnet's network, gateway and broadcast addresses
 * (the gateway is the host, and answers on its own ports, measured), or a link-local address. None at all
 * when no default route was read: then which interface is front is not known (review pass 1).
 */
export function pick(addresses: string[], interfaces: Record<string, NetworkInterfaceInfo[] | undefined>, defaults: Set<string>): string | undefined {
  // A default route counts only by an interface the forwarder has: a route with no device reads as `*`.
  if ([...defaults].some((name) => name === "lo" === false && name in interfaces) === false) return undefined;
  const own = new Set(Object.values(interfaces).flatMap((infos) => (infos ?? []).map((i) => i.address.toLowerCase())));
  const subnets = Object.entries(interfaces).filter(([name]) => defaults.has(name) === false)
    .flatMap(([, infos]) => (infos ?? []).filter((i) => i.internal === false && Boolean(i.cidr)).map((i) => i.cidr as string));
  return addresses.find((a) => own.has(a.toLowerCase()) === false && /^fe[89ab]/i.test(a) === false
    && subnets.some((c) => inside(a, c) && reserved(a, c) === false));
}

/** An address as the PROXY line names it: an IPv4-mapped IPv6 address as plain IPv4. */
const plain = (a?: string) => (a && a.startsWith("::ffff:") && net.isIPv4(a.slice(7)) ? a.slice(7) : a ?? "");
/** The PROXY protocol's v1 line for a client connection. */
export function proxyLine(s: { remoteAddress?: string; localAddress?: string; remotePort?: number; localPort?: number }): string {
  const src = plain(s.remoteAddress), dst = plain(s.localAddress);
  const family = net.isIPv4(src) && net.isIPv4(dst) ? "TCP4" : net.isIPv6(src) && net.isIPv6(dst) ? "TCP6" : "";
  return family && s.remotePort && s.localPort ? ["PROXY", family, src, dst, s.remotePort, s.localPort].join(" ") + "\r\n" : "PROXY UNKNOWN\r\n";
}

/**
 * One line per kind of refusal at most every 10 s, so a flood does not fill the log. Keyed by the kind,
 * not the line, which may name addresses: a resolver rotating its answers would otherwise log each one
 * and grow the map without end (review pass 2, measured).
 */
type Kind = "unresolved" | "outside" | "slow" | "unreachable";
const warned = new Map<Kind, number>();
function note(kind: Kind, why: string) {
  const at = warned.get(kind) ?? 0;
  if (Date.now() - at > 10_000) { warned.set(kind, Date.now()); console.error("forwarder: " + why + "; connection closed"); }
}
function refuse(client: net.Socket, kind: Kind, why: string) {
  note(kind, why);
  client.destroy();
}
/** A deadline as a promise, and its timer, so the caller clears it however the race ends. */
function deadline(ms: number): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timeout")), ms); });
  return { promise, clear: () => clearTimeout(timer) };
}

async function forward(client: net.Socket) {
  client.pause();
  client.on("error", () => client.destroy());
  let found: string[] = [];
  const limit = deadline(DEADLINE_MS);
  try {
    found = (await Promise.race([lookup(PROXY, { all: true }), limit.promise])).map((a) => a.address);
  } catch { /* no answer: refused below */ } finally { limit.clear(); }
  const target = pick(found, networkInterfaces(), defaultRouteInterfaces());
  if (target === undefined) {
    return found.length === 0
      ? refuse(client, "unresolved", PROXY + " does not resolve (the proxy is down or still starting)")
      : refuse(client, "outside", PROXY + " resolved only to addresses the forwarder does not dial (" + found.join(", ") + "): its own, or something outside the stack answering for it");
  }
  if (client.destroyed) return;
  const up = net.connect({ host: target, port: PORT, allowHalfOpen: true });
  const late = setTimeout(() => { up.destroy(); refuse(client, "slow", "the proxy at " + target + " did not answer in " + DEADLINE_MS / 1000 + " s"); }, DEADLINE_MS);
  let connected = false;
  up.once("connect", () => { connected = true; clearTimeout(late); });
  up.once("close", () => clearTimeout(late));
  up.once("error", (e: NodeJS.ErrnoException) => {
    if (connected === false) note("unreachable", "the proxy at " + target + " could not be reached (" + (e.code ?? e.message) + ")");
  });
  join(client, up);
}

/**
 * Joins CLIENT to UP, the connection to the proxy: once UP connects, the PROXY line, then each way piped,
 * a half-close passed on. The proxy's reset, or a close before its end, ends both at once. Once the proxy
 * has ended its side, what it sent is first flushed to the client, however slowly the client reads, up to
 * DRAIN_MS (review pass 2: a client that had half-closed lost the tail of a large reply when the proxy's
 * close destroyed it, measured); then the client has LINGER_MS to end its own side, since one that
 * ignores the end would otherwise hold both sockets for good (review pass 1).
 */
export function join(client: net.Socket, up: net.Socket, lingerMs = 10000, drainMs = 60000): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => { clearTimeout(timer); up.destroy(); client.destroy(); };
  const after = (ms: number) => { clearTimeout(timer); timer = setTimeout(done, ms); };
  up.once("connect", () => {
    up.write(proxyLine(client));
    client.pipe(up);
    up.pipe(client);
    client.resume();
  });
  // Registered before the pipe's own end handler, which ends the client: so its finish is not missed.
  up.once("end", () => { after(drainMs); client.once("finish", () => after(lingerMs)); });
  up.on("error", done);
  up.on("close", () => { if (up.readableEnded === false) done(); });
  client.on("close", done);
}

/** join() between real sockets on loopback, its timers short: a stand-in proxy, then a client. */
async function joinCases(): Promise<[string, boolean][]> {
  const listen = (server: net.Server) => new Promise<number>((ok) => server.listen(0, "127.0.0.1", () => ok((server.address() as net.AddressInfo).port)));
  const via = async (proxy: (s: net.Socket) => void) => {
    const stand = net.createServer({ allowHalfOpen: true }, proxy);
    const standPort = await listen(stand);
    const front = net.createServer({ allowHalfOpen: true }, (c) => { c.pause(); join(c, net.connect({ host: "127.0.0.1", port: standPort, allowHalfOpen: true }), 100, 2000); });
    const port = await listen(front);
    return { port, stop: () => { stand.close(); front.close(); } };
  };
  // A client that half-closes and reads slowly throughout, so the forwarder may still hold part of the
  // reply when the proxy, having sent it all, closes: all of it arrives. Five times, since whether part is
  // still held at the close is a race (a close that destroyed the client cut one run in three, measured).
  const size = 16 * 1024 * 1024;
  const big = await via((s) => { s.resume(); s.once("end", () => s.end(Buffer.alloc(size))); });
  const got: number[] = [];
  for (let run = 0; run < 5; run++) {
    got.push(await new Promise<number>((ok) => {
      let n = 0;
      const c = net.connect({ host: "127.0.0.1", port: big.port, allowHalfOpen: true });
      c.on("data", (d) => { n += d.length; c.pause(); setTimeout(() => c.resume(), 1); });
      c.on("error", () => {});
      c.on("close", () => ok(n));
      c.end("request");
    }));
  }
  big.stop();
  // A client that never ends its side, after the proxy ended its own: let go once the linger is over, so
  // its write after it is refused.
  const ends = await via((s) => { s.once("data", () => s.end()); });
  const freed = await new Promise<boolean>((ok) => {
    const c = net.connect({ host: "127.0.0.1", port: ends.port, allowHalfOpen: true });
    c.on("error", () => {});
    c.on("close", () => ok(true));
    setTimeout(() => c.write("more"), 400);
    setTimeout(() => ok(false), 1500);
  });
  ends.stop();
  return [
    ["a reply after the client's half-close arrives whole, five times (" + got.join(", ") + " of " + size + " bytes)", got.every((n) => n === size)],
    ["a client that never ends its side is let go after the linger", freed],
  ];
}

if (process.argv.includes("--self-check")) {
  const ifs = { lo: [{ address: "127.0.0.1", cidr: "127.0.0.1/8", internal: true }], eth0: [{ address: "10.89.9.2", cidr: "10.89.9.2/24", internal: false }], eth1: [{ address: "10.89.10.3", cidr: "10.89.10.3/24", internal: false }, { address: "fd00:a::3", cidr: "fd00:a::3/64", internal: false }] } as unknown as Record<string, NetworkInterfaceInfo[]>;
  const route4 = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t00000000\t0109590A\t0003\t0\t0\t100\t00000000\t0\t0\t0\neth0\t0009590A\t00000000\t0001\t0\t0\t0\t00FFFFFF\neth1\t000A590A\t00000000\t0001\t0\t0\t0\t00FFFFFF";
  const defaults = defaultRouteInterfaces(route4, "0".repeat(32) + " 00 " + "0".repeat(32) + " 00 " + "0".repeat(32) + " ffffffff 00000001 00000000 00200200 lo");
  const cases: [string, boolean][] = [
    ["the default route leaves by eth0 (and lo's unreachable route)", defaults.has("eth0") && defaults.has("eth1") === false],
    ["the proxy's front address is taken", pick(["10.89.10.2"], ifs, defaults) === "10.89.10.2"],
    ["an address on edge, the default route's network, is refused", pick(["10.89.9.7"], ifs, defaults) === undefined],
    ["a public answer is refused", pick(["104.20.23.154"], ifs, defaults) === undefined],
    ["loopback is refused", pick(["127.0.0.1"], ifs, defaults) === undefined],
    ["the first front address of several is taken", pick(["104.20.23.154", "10.89.10.2"], ifs, defaults) === "10.89.10.2"],
    ["an IPv6 front address is taken, another refused", pick(["fd00:a::2"], ifs, defaults) === "fd00:a::2" && pick(["fd00:b::2"], ifs, defaults) === undefined],
    ["the forwarder's own front address is refused", pick(["10.89.10.3"], ifs, defaults) === undefined && pick(["FD00:A::3"], ifs, defaults) === undefined],
    ["front's network, gateway and broadcast addresses are refused", ["10.89.10.0", "10.89.10.1", "10.89.10.255", "fd00:a::", "fd00:a::1"].every((a) => pick([a], ifs, defaults) === undefined)],
    ["a link-local address is refused", pick(["fe80::1234"], { ...ifs, eth1: [...(ifs.eth1 ?? []), { address: "fe80::3", cidr: "fe80::3/64", internal: false } as NetworkInterfaceInfo] }, defaults) === undefined],
    ["nothing is taken when no default route was read", pick(["10.89.10.2"], ifs, new Set()) === undefined && pick(["10.89.10.2"], ifs, new Set(["lo"])) === undefined],
    ["a default route with no device (Iface *) is not one", pick(["10.89.10.2"], ifs, defaultRouteInterfaces(route4.split("\n")[0] + "\n*\t00000000\t00000000\t0201\t0\t0\t0\t00000000", "")) === undefined],
    ["the loopback interface's subnet is not front's, though no route leaves by it", pick(["127.0.0.2"], ifs, new Set(["eth0"])) === undefined],
    ["a v4 PROXY line, the mapped address plain", proxyLine({ remoteAddress: "::ffff:203.0.113.7", localAddress: "::ffff:10.89.9.2", remotePort: 51234, localPort: 8000 }) === "PROXY TCP4 203.0.113.7 10.89.9.2 51234 8000\r\n"],
    ["a v6 PROXY line", proxyLine({ remoteAddress: "2001:db8::7", localAddress: "fd00::1", remotePort: 1, localPort: 8000 }) === "PROXY TCP6 2001:db8::7 fd00::1 1 8000\r\n"],
    ["mixed families are UNKNOWN", proxyLine({ remoteAddress: "203.0.113.7", localAddress: "fd00::1", remotePort: 1, localPort: 8000 }) === "PROXY UNKNOWN\r\n"],
    ...(await joinCases()),
  ];
  for (const [name, ok] of cases) console.log((ok ? "ok   " : "FAIL ") + name);
  process.exit(cases.every(([, ok]) => ok) ? 0 : 1);
}

net.createServer({ allowHalfOpen: true }, (client) => { void forward(client); })
  .listen(PORT, () => console.error("forwarder: listening on " + PORT + ", to " + PROXY + ":" + PORT + " on an internal network"));
