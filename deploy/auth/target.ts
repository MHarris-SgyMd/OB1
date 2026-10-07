/**
 * target.ts — the path the authorization server routes a request by, and the
 * guard that keeps one request from stopping it (SMD-2615).
 *
 * Bun's node:http hands the listener the request target as sent: an
 * absolute-form `GET http://x:99999/healthz` arrives as `req.url` unchanged,
 * and so does `//x/healthz`. server.ts read its path as
 * `new URL(req.url, "http://auth")`, which threw on the first (the listener's
 * throw ended the process, exit 1, after an empty 200) and resolved the second
 * as host `x`, path `/healthz`. The proxy never sends either (Traefik v3.7.13
 * rewrites an absolute-form target to its path, refuses one it cannot parse
 * and merges `//`, measured), but anything on the mesh can.
 *
 * The path is read the way the library reads it, so the gates in server.ts
 * (the token path, the registration cap) see the same path the library
 * routes. Koa takes the path from `parseurl`, which cuts a target that starts
 * with `/` at its first `?`, unless the target holds one of a few characters,
 * when it hands it to Node's legacy `url.parse` instead, and that turns a `\`
 * before the query into `/`. So a target that does not start with `/`, or
 * holds one of those characters, is refused; any other is cut at its first
 * `?`, never decoded or resolved. No client sends either kind: a browser
 * keeps a fragment to itself, and a request target holds no whitespace.
 * Refusing absolute-form departs from RFC 9112 3.2.2, which has a server
 * accept it, on purpose: nothing but a proxy sends it, and the proxy in front
 * of this server sends the path.
 *
 * The server is made by `serve`, which wraps its listener in the guard;
 * server.ts imports node:http for its types alone, so going back to
 * `http.createServer` there fails the typecheck. The guard covers the listener and the promises it returns.
 * A callback the listener or the library hands on (an event handler, a
 * request timeout, a timer) runs outside it.
 *
 * Dependency-free, but its self-check holds the rule against `parseurl` and
 * Koa's own `ctx.path`, which the install brings (oidc-provider's), so a bump
 * of either that reads a target another way fails it.
 *
 *   bun deploy/auth/target.ts --self-check   # CI, after the install
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";

/** A request target's path, and its query with the `?` (empty when it has none). */
export type Target = { path: string; search: string };

/** A request listener; it returns its promise wherever it goes async. */
type Listener = (req: IncomingMessage, res: ServerResponse) => unknown;

/** The characters on which `parseurl` (1.3.3, fastparse) hands a target to Node's legacy `url.parse`, which reads it another way. */
const REPARSED = /[\t\n\f\r #\u00a0\ufeff]/;

/** The target's path and query as the library reads them, or undefined when it is not a path or the library would read it another way (server.ts answers 400). */
export function targetOf(raw: string | undefined): Target | undefined {
  if (!raw?.startsWith("/") || REPARSED.test(raw)) return undefined;
  const q = raw.indexOf("?");
  return q < 0 ? { path: raw, search: "" } : { path: raw.slice(0, q), search: raw.slice(q) };
}

/**
 * The listener, with a throw or a rejection from it answered 500 (or, once an
 * answer has started, the connection closed) and logged. Bun's node:http ends
 * the process on either, exit 1, measured on 1.4.0: one request would stop the
 * server. The listener returns its promise wherever it goes async, so a
 * failure there reaches this too.
 */
function guarded(listener: Listener): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const failed = (e: unknown) => {
      // Built in a try of its own: String() throws on a value with no way to
      // become a string (Object.create(null)), and a throw here is uncaught.
      let why: string;
      try {
        why = e instanceof Error ? (e.stack ?? e.message) : String(e);
      } catch {
        why = "a value that cannot be printed";
      }
      console.error(`request failed: ${why}`);
      try {
        if (res.headersSent) return void res.destroy();
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("something went wrong on the server; see its log");
      } catch {
        res.destroy();
      }
    };
    try {
      const pending = listener(req, res);
      if (pending instanceof Promise) pending.catch(failed);
    } catch (e) {
      failed(e);
    }
  };
}

/** The node:http server for `listener`, guarded: the one way server.ts makes its server. */
export function serve(listener: Listener): http.Server {
  return http.createServer(guarded(listener));
}

async function selfCheck(): Promise<number> {
  let failed = 0;
  const expect = (what: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  const show = (t: Target | undefined) => (t ? `${t.path}|${t.search}` : "refused");

  // the path
  const read: [string, string][] = [
    ["/healthz", "/healthz|"],
    ["/auth/token?x=1", "/auth/token|?x=1"],
    ["/a?b?c", "/a|?b?c"],
    ["/auth", "/auth|"],
    ["/auth?", "/auth|?"],
    ["//x/healthz", "//x/healthz|"],
    ["/auth/../healthz", "/auth/../healthz|"],
    ["/auth/%74oken", "/auth/%74oken|"],
    ["/auth\\token", "/auth\\token|"],
  ];
  const wrong = read.filter(([t, want]) => show(targetOf(t)) !== want);
  expect("a target that starts with / is cut at its first ?, never resolved or decoded, so //x/healthz is not /healthz", !wrong.length, wrong.map(([t]) => `${t} → ${show(targetOf(t))}`).join(", "));
  const refused = [undefined, "", "*", "x", "?a=1", "http://x:99999/healthz", "http://[::1/x", "http://evil.test/healthz", "/a#b", "/a?b#c", "/a b", "/a\tb", "/a\nb", "/a\fb", "/a\rb", "/a\u00a0b", "/a\ufeffb", "/auth\\token#", "/auth\\token\f"];
  const let_ = refused.filter((t) => targetOf(t) !== undefined);
  expect("a target that is not a path, or holds a character the library reads another way, is refused", !let_.length, let_.map((t) => JSON.stringify(t)).join(", "));

  // the path is the library's
  const { default: parseurl } = (await import("parseurl" as string)) as { default: (req: { url: string }) => { pathname: string | null } };
  const libraryPath = (t: string) => parseurl({ url: t }).pathname;
  const alphabet = ["/", "/", "a", "A", "?", "#", "\\", ".", "%2e", "%2F", " ", "\t", "\n", "\f", "\r", "\u00a0", "\ufeff", ":", "@", "x:99999", "//"];
  // mulberry32: every bit of its output varies. An LCG reduced by % read its low bits alone, which
  // alternate, and gave 1,927 distinct targets in 20,000 (review pass 2).
  let seed = 2615;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const fuzzed = Array.from({ length: 20_000 }, () => "/" + Array.from({ length: next() % 10 }, () => alphabet[next() % alphabet.length]).join(""));
  const distinct = new Set(fuzzed).size;
  const accepted = [...read.map(([t]) => t), ...fuzzed].filter((t) => targetOf(t));
  const differ = accepted.filter((t) => targetOf(t)!.path !== libraryPath(t));
  expect(`every target it reads, the library reads as the same path (${accepted.length} accepted of ${read.length + fuzzed.length}, ${distinct} fuzzed targets distinct)`, accepted.length > 1000 && distinct > 12_000 && !differ.length, differ.slice(0, 5).map((t) => JSON.stringify(t)).join(", "));
  // What the library routes on is Koa's ctx.path, so it is held to that too:
  // every UTF-16 code unit inside a path before a `\` and at a path's end.
  // Exactly the eight characters above are refused; a koa or parseurl bump
  // that read another one differently, or a refusal that grew, fails here.
  const { default: Koa } = (await import("koa" as string)) as { default: new () => { createContext(req: object, res: object): { path: string } } };
  const koa = new Koa();
  const koaPath = (url: string) => koa.createContext({ url, headers: {}, socket: {} }, {}).path;
  let swept = 0;
  const koaDiffer: string[] = [];
  for (let c = 0; c < 0x10000; c++) {
    for (const t of [`/a${String.fromCharCode(c)}\\b?q`, `/auth/token${String.fromCharCode(c)}`]) {
      const got = targetOf(t);
      if (!got) continue;
      swept++;
      if (got.path !== koaPath(t)) koaDiffer.push(`U+${c.toString(16).padStart(4, "0")}`);
    }
  }
  expect(`every code unit but the eight it refuses, Koa routes as the same path (${swept} targets)`, swept === 2 * (0x10000 - 8) && !koaDiffer.length, `${swept} read; differ at ${koaDiffer.slice(0, 5).join(", ")}`);
  const reread = ["/auth\\token#", "/auth\\reg#x", "/auth\\token?a#"].map((t) => `${t} → ${libraryPath(t)}`);
  expect("the refusal is needed: with a # the library reads /auth\\token as /auth/token", reread.join() === "/auth\\token# → /auth/token,/auth\\reg#x → /auth/reg,/auth\\token?a# → /auth/token", reread.join(", "));

  // the guard
  const server = serve((req, res) => {
    if (req.url === "/throw") throw new Error("thrown in the listener (expected)");
    if (req.url === "/reject") return Promise.reject(new Error("rejected in the listener (expected)"));
    // A value String() cannot print: the guard's log line must not throw on it.
    if (req.url === "/unprintable") throw Object.create(null);
    if (req.url === "/unprintable-reject") return Promise.reject(Object.create(null));
    if (req.url === "/late") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part");
      return Promise.reject(new Error("rejected after the answer started (expected)"));
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fine");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // What came back. A connection the server leaves open is cut after 3 s and
  // marked, so no row reads its own timeout as the server's close.
  const ask = (target: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      const s = connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      s.on("data", (d) => (out += d.toString("latin1")));
      const timer = setTimeout(() => {
        out = `TIMED OUT ${out}`;
        s.destroy();
      }, 3000);
      s.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
      s.on("error", () => resolve(out));
    });
  const status = (answer: string) => answer.split("\r\n")[0];
  const logged = console.error;
  console.error = () => {};
  const thrown = await ask("/throw");
  const rejected = await ask("/reject");
  const late = await ask("/late");
  const unprintable = await ask("/unprintable");
  const unprintableRejected = await ask("/unprintable-reject");
  const after = await ask("/");
  console.error = logged;
  expect("a throw in the listener is a 500 that says nothing of it", status(thrown) === "HTTP/1.1 500 Internal Server Error" && !thrown.includes("expected"), status(thrown));
  expect("a rejection from the listener is a 500", status(rejected) === "HTTP/1.1 500 Internal Server Error", status(rejected));
  // Bun may not have flushed the started answer before the close: nothing, or the 200's start, and never a 500.
  // A connection left open reads "TIMED OUT …", which neither allows.
  expect("a failure after the answer started closes the connection with no 500", (late === "" || status(late) === "HTTP/1.1 200 OK") && !late.includes(" 500 ") && !late.includes("something went wrong"), JSON.stringify(late.slice(0, 80)));
  expect("a thrown or rejected value that cannot be printed is a 500 too", status(unprintable) === "HTTP/1.1 500 Internal Server Error" && status(unprintableRejected) === "HTTP/1.1 500 Internal Server Error", `${status(unprintable)} | ${status(unprintableRejected)}`);
  expect("and the server goes on answering", status(after) === "HTTP/1.1 200 OK" && after.includes("fine"), status(after));
  server.close();

  console.log(failed ? `\n${failed} probe(s) failed` : "\nall probes hold");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());
