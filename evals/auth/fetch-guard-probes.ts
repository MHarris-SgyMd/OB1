/**
 * fetch-guard-probes.ts — the fetch guard's own probes, beside the guard they
 * hold (SMD-2285). `eval-auth.ts --self-check` runs them with no stack.
 *
 * The guard's name and address rules answer one question: what the
 * authorization server may fetch on a client's say-so. So they spell
 * `localhost`, the IPv6 loopback and the rest as inputs to refuse. That is not
 * db/connect.ts's question (is this database host on this machine), which
 * db/test-connect.ts holds to one spelling across db/ and evals/'s top level;
 * the guard and these probes live in evals/auth/ for that reason.
 */
import type { LookupAddress } from "node:dns";
import { guardedLookup, refusedName, refusedUrl, specialUse } from "./fetch-guard.ts";

export function guardProbes(expect: (what: string, ok: boolean) => void): void {
  const special = ["0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2001::1", "2002:a00:1::", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "fe80::1%eth0"];
  const routable = ["1.1.1.1", "8.8.8.8", "11.0.0.10", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450::1", "::ffff:8.8.8.8"];
  for (const a of special) expect(`${a} is special-use`, /^\S+ (is|maps) /.test(specialUse(a) ?? "") && !/not an IP address/.test(specialUse(a) ?? ""));
  for (const a of routable) expect(`${a} is routable`, specialUse(a) === null);
  expect("a name is not an address", specialUse("example.com") !== null);

  for (const h of ["localhost", "LOCALHOST", "a.localhost", "ob1.internal", "api.ob1.internal", "api.ob1.internal.", "postgres"]) expect(`${h} is refused by name`, refusedName(h) !== null);
  for (const h of ["cimd.test", "claude.ai", "example.com", "ob1.internal.example.com"]) expect(`${h} passes the name rule`, refusedName(h) === null);
  expect("http: is refused", refusedUrl(new URL("http://claude.ai/x")) !== null);
  expect("POST is refused", refusedUrl(new URL("https://claude.ai/x"), "POST") !== null);
  expect("an IPv6 loopback literal is refused", refusedUrl(new URL("https://[::1]/x")) !== null);
  expect("a mapped IPv4 loopback literal is refused", refusedUrl(new URL("https://[::ffff:127.0.0.1]/x")) !== null);
  expect("a routable literal passes", refusedUrl(new URL("https://1.1.1.1/x")) === null);
  expect("a public name passes to the lookup", refusedUrl(new URL("https://claude.ai/oauth/client.json")) === null);

  // The lookup: every answer is checked, one special-use answer refuses the name.
  const answer = (addrs: string[]) => ((_h: string, _o: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => cb(null, addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })))) as never;
  const lookedUp = (addrs: string[], all: boolean) => {
    const logs: string[] = [];
    let result: { err: Error | null; value: unknown } = { err: null, value: undefined };
    guardedLookup((l) => logs.push(l), "https://x.test/", answer(addrs))("x.test", { all }, (e, v) => {
      result = { err: e, value: v };
    });
    return { ...result, logs };
  };
  expect("a public answer passes", lookedUp(["1.1.1.1"], false).value === "1.1.1.1");
  expect("all public answers pass as a list", Array.isArray(lookedUp(["1.1.1.1", "2606:4700::1"], true).value));
  const mixed = lookedUp(["1.1.1.1", "10.0.0.5"], true);
  expect("one private answer among public ones refuses the name, and logs it", mixed.err !== null && mixed.logs.some((l) => l.includes("10.0.0.5")));
  expect("a loopback answer is refused", lookedUp(["127.0.0.1"], false).err !== null);
  expect("no answer is refused", lookedUp([], true).err !== null);
}
