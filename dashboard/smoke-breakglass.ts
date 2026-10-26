#!/usr/bin/env bun
/**
 * smoke-breakglass.ts — the operator GUI's break-glass key sign-in (SMD-3307;
 * ADR decision 15), on a stack configured with the authorization server whose
 * authorization server is down, driven as a browser would: the origin through
 * the forwarder's port, and the break-glass port the `breakglass` service
 * publishes on 127.0.0.1. CI's deploy-stack-auth job runs it after it has
 * removed the authorization server:
 *
 *   OB1_SMOKE_KEY=… bun smoke-breakglass.ts --url http://127.0.0.1:8010/dashboard \
 *     --breakglass http://127.0.0.1:8001/dashboard --origin https://brain.example.test
 *
 * The key, a read or write key, is read from the environment, never the
 * command line. It asserts:
 *   - on the origin, the page says sign-in is unavailable and names the
 *     break-glass port, and offers no key field — a forged X-OB1-Listener
 *     header, or its underscore spelling, included: the proxy's `web`
 *     entrypoint deletes it, so it never reaches the GUI;
 *   - a key posted on the origin is refused with no cookie: with the forged
 *     header, at `Host: 127.0.0.1` from that loopback origin, and at
 *     `Host: 127.0.0.1` from the configured origin;
 *   - on the break-glass port, the page offers the key and says it is the
 *     break-glass port; the key signs in, its cookie on /dashboard, httpOnly,
 *     not Secure (plain HTTP there), and the overview renders under it;
 *   - that session opens nothing on the origin, its cookie sent there;
 *   - a post on the break-glass port from another loopback port, or from no
 *     origin, is refused; a sign-in through the authorization server is not
 *     started there;
 *   - the break-glass port routes the GUI alone: /mcp, /auth, /health and the
 *     root are the proxy's 404;
 *   - sign-out there ends the session.
 *
 * Exit 0 when every assertion holds, 1 otherwise.
 */

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const MAIN = flag("url")?.replace(/\/$/, "");
const BG = flag("breakglass")?.replace(/\/$/, "");
const ORIGIN = flag("origin")?.replace(/\/$/, "");
const KEY = process.env.OB1_SMOKE_KEY ?? "";
if (!MAIN || !BG || !ORIGIN || !KEY) {
  console.error("usage: OB1_SMOKE_KEY=… bun smoke-breakglass.ts --url <origin's port>/dashboard --breakglass <break-glass port>/dashboard --origin <configured origin>");
  process.exit(2);
}
const MAIN_ORIGIN = new URL(MAIN).origin;
const BG_ORIGIN = new URL(BG).origin;
const COOKIE = "ob1_dashboard_session";

let pass = 0;
let fail = 0;
const assert = (cond: boolean, msg: string) => { console.log(`  ${cond ? "✓" : "✗"}  ${msg}`); if (cond) pass++; else fail++; };

async function req(url: string, init: { method?: string; headers?: Record<string, string>; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { accept: "text/html", ...init.headers };
  if (init.form) headers["content-type"] = "application/x-www-form-urlencoded";
  const r = await fetch(url, { method: init.method ?? (init.form ? "POST" : "GET"), redirect: "manual", headers, body: init.form ? new URLSearchParams(init.form).toString() : undefined });
  const setCookie = (r.headers.getSetCookie?.() ?? []).find((l) => l.startsWith(`${COOKIE}=`)) ?? "";
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text(), setCookie };
}
const sessionOf = (line: string) => /^ob1_dashboard_session=([^;]+)/.exec(line)?.[1] ?? "";

console.log(`▸ the origin ${MAIN}, the break-glass port ${BG}, configured at ${ORIGIN}`);

// The origin: no key, whatever a client says of its listener.
const page = await req(`${MAIN}/signin`);
assert(page.status === 200 && page.html.includes('data-testid="unavailable"') && !page.html.includes('name="key"') && page.html.includes(`${new URL(BG).port}/dashboard/`), `on the origin, with the authorization server down, the page says sign-in is unavailable, names the break-glass port and offers no key (${page.status})`);
const forged = await Promise.all([{ "X-OB1-Listener": "breakglass" }, { "X_OB1_Listener": "breakglass" }].map((h) => req(`${MAIN}/signin`, { headers: h })));
assert(forged.every((r) => r.status === 200 && !r.html.includes('name="key"') && !r.html.includes('data-testid="breakglass"')), `…and a forged X-OB1-Listener, or its underscore spelling, never reaches the GUI: no key offered (${forged.map((r) => r.status).join(", ")})`);
const mainPort = new URL(MAIN).port || "80";
const posts = await Promise.all([
  req(`${MAIN}/signin`, { form: { key: KEY }, headers: { origin: ORIGIN, "X-OB1-Listener": "breakglass" } }),
  req(`${MAIN}/signin`, { form: { key: KEY }, headers: { origin: `http://127.0.0.1:${mainPort}`, host: `127.0.0.1:${mainPort}` } }),
  req(`${MAIN}/signin`, { form: { key: KEY }, headers: { origin: ORIGIN, host: `127.0.0.1:${mainPort}` } }),
]);
assert(posts.every((r) => r.status === 403 && !sessionOf(r.setCookie)), `a key posted on the origin is refused with no session — with a forged listener, at Host: 127.0.0.1 from that origin, and at Host: 127.0.0.1 from the configured origin (${posts.map((r) => r.status).join(", ")})`);

// The break-glass port: the key, signed in, bound to it.
const bgPage = await req(`${BG}/signin`);
assert(bgPage.status === 200 && bgPage.html.includes('data-testid="breakglass"') && bgPage.html.includes('name="key"') && !bgPage.html.includes('data-testid="oauth"'), `on the break-glass port the page offers the key and says it is the break-glass port (${bgPage.status})`);
const signedIn = await req(`${BG}/signin`, { form: { key: KEY }, headers: { origin: BG_ORIGIN } });
const sid = sessionOf(signedIn.setCookie);
assert(signedIn.status === 303 && signedIn.location === "/dashboard/" && sid.length > 20 && /Path=\/dashboard/i.test(signedIn.setCookie) && /HttpOnly/i.test(signedIn.setCookie) && !/;\s*Secure/i.test(signedIn.setCookie), `…the key signs in there with the authorization server down: a session cookie on /dashboard, httpOnly, not Secure on plain HTTP (${signedIn.status} → ${signedIn.location}; ${signedIn.setCookie.replace(/=[^;]*/, "=…")})`);
const home = await req(`${BG}/`, { headers: { cookie: `${COOKIE}=${sid}` } });
assert(home.status === 200 && home.html.includes('data-testid="who"'), `…and the overview renders under it (${home.status})`);
const elsewhere = await req(`${MAIN}/`, { headers: { cookie: `${COOKIE}=${sid}` } });
assert(elsewhere.status === 303 && elsewhere.location === "/dashboard/signin", `that session opens nothing on the origin, its cookie sent there (${elsewhere.status} → ${elsewhere.location})`);
const stillHome = await req(`${BG}/`, { headers: { cookie: `${COOKIE}=${sid}` } });
assert(stillHome.status === 200, `…and is still the break-glass port's after (${stillHome.status})`);

// What the break-glass port refuses.
const crossPosts = await Promise.all([
  req(`${BG}/signin`, { form: { key: KEY }, headers: { origin: "http://127.0.0.1:3000" } }),
  req(`${BG}/signin`, { form: { key: KEY } }),
  req(`${BG}/signout`, { method: "POST", headers: { origin: "http://127.0.0.1:3000", cookie: `${COOKIE}=${sid}` } }),
]);
assert(crossPosts.every((r) => r.status === 403 && !sessionOf(r.setCookie)), `on the break-glass port, a post from another loopback port or from no origin is refused, a sign-out too (${crossPosts.map((r) => r.status).join(", ")})`);
const start = await req(`${BG}/auth/start`, { method: "POST", headers: { origin: BG_ORIGIN } });
assert(start.status === 303 && start.location === "/dashboard/signin", `no sign-in through the authorization server starts there (${start.status} → ${start.location})`);
const others = await Promise.all(["/mcp", "/auth/authorize", "/health", "/", "/api/v1/whoami"].map(async (p) => [p, await fetch(`${BG_ORIGIN}${p}`, { redirect: "manual" })] as const));
assert(others.every(([, r]) => r.status === 404), `the break-glass port routes the GUI alone (${others.map(([p, r]) => `${p} ${r.status}`).join(", ")})`);

// Sign-out.
const out = await req(`${BG}/signout`, { method: "POST", headers: { origin: BG_ORIGIN, cookie: `${COOKIE}=${sid}` } });
const after = await req(`${BG}/`, { headers: { cookie: `${COOKIE}=${sid}` } });
assert(out.status === 303 && out.location === "/dashboard/signin" && after.status === 303 && after.location === "/dashboard/signin", `sign-out there ends the session (${out.status}; then / → ${after.status} ${after.location})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
