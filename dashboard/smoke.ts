#!/usr/bin/env bun
/**
 * smoke.ts — drive the operator GUI against a running brain the way a browser
 * would (SMD-2280). CI's full-stack job runs it through the stack's proxy:
 *
 *   bun smoke.ts --url http://127.0.0.1:8010/dashboard --key <write> --read-key <read> --capture-key <capture>
 *
 * With one cookie jar, it asserts:
 *   - signed out, every page and the sign-out redirect to /signin, and
 *     /health answers;
 *   - a wrong key and a capture-only key are refused at /signin and set no
 *     cookie; a cookie the server never issued is no session;
 *   - the write key signs in: a cookie scoped to /dashboard, httpOnly,
 *     SameSite=Lax, a day, Secure only on https; and the overview, the
 *     status page and a thought's page render from the REST core, naming
 *     what the core answers on its own (the total, the version, a thought's
 *     text);
 *   - no page, script or cookie holds the key;
 *   - sign-out ends the session on the server: the old cookie, presented
 *     again, is no session;
 *   - the read key signs in as a read key, and a thought the brain does not
 *     hold is a 404.
 *
 * Exit 0 when every assertion holds, 1 otherwise. Read-only against the
 * brain, but for the click-through each thought page's `fetch` logs.
 */

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = flag("url")?.replace(/\/$/, "");
const WRITE_KEY = flag("key");
const READ_KEY = flag("read-key");
const CAPTURE_KEY = flag("capture-key");
if (!BASE || !WRITE_KEY) {
  console.error("usage: bun smoke.ts --url <origin>/dashboard --key <write-key> [--read-key <read-key>] [--capture-key <capture-key>]");
  process.exit(2);
}
const ORIGIN = new URL(BASE).origin;
const COOKIE = "ob1_dashboard_session";

let pass = 0;
let fail = 0;
const ok = (msg: string) => { console.log(`  ✓  ${msg}`); pass++; };
const bad = (msg: string) => { console.log(`  ✗  ${msg}`); fail++; };
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : bad(msg));

// One cookie: the session, or nothing; and the last Set-Cookie line for it, attributes included.
let cookie = "";
let lastSetCookie = "";
const takeCookie = (r: Response) => {
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === COOKIE) {
      const value = pair.slice(eq + 1);
      cookie = value ? `${COOKIE}=${value}` : "";
      lastSetCookie = c;
    }
  }
};
const headers = (extra: Record<string, string> = {}) => (cookie ? { cookie, ...extra } : extra);
const get = async (path: string) => {
  const r = await fetch(`${BASE}${path}`, { redirect: "manual", headers: headers() });
  takeCookie(r);
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text(), headers: r.headers };
};
/** The cookie's attributes: scoped to the GUI, httpOnly, Lax, and Secure exactly where the origin is https. */
const https = ORIGIN.startsWith("https:");
const attributesHold = (line: string) =>
  /;\s*Path=\/dashboard(;|$)/i.test(line) && /HttpOnly/i.test(line) && /SameSite=Lax/i.test(line) && /;\s*Secure/i.test(line) === https;
const redacted = (line: string) => line.replace(/=[^;]*/, "=…");

// As a browser submits the form: HTML wanted (without `accept: text/html`,
// SvelteKit answers an action as JSON for a fetch), same-origin (its CSRF
// check reads `origin`).
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: ORIGIN };
const signIn = async (key: string) => {
  const r = await fetch(`${BASE}/signin`, { method: "POST", redirect: "manual", headers: headers(FORM), body: new URLSearchParams({ key }).toString() });
  takeCookie(r);
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text() };
};
const signOut = async () => {
  const r = await fetch(`${BASE}/signout`, { method: "POST", redirect: "manual", headers: headers({ origin: ORIGIN }) });
  takeCookie(r);
  return r;
};
const toSignin = (r: { status: number; location: string }) => r.status === 303 && r.location === "/dashboard/signin";
/** Every page the GUI renders, by its path under the base. */
const PAGES = ["/", "/status", "/thoughts/00000000-0000-0000-0000-000000000000"];

console.log(`▸ dashboard ${BASE}`);

// Signed out.
{
  for (const p of PAGES) {
    const r = await get(p);
    assert(toSignin(r), `signed out, ${p} redirects to /signin (${r.status} → ${r.location})`);
  }
  const out = await signOut();
  assert(out.status === 303 && out.headers.get("location") === "/dashboard/signin", `signed out, sign-out redirects to /signin (${out.status})`);
  const health = await get("/health");
  assert(health.status === 200 && health.html.trim() === "ok", `/health answers ok signed out (${health.status})`);
  const signin = await get("/signin");
  assert(signin.status === 200 && signin.html.includes('name="key"'), `/signin offers key sign-in (${signin.status})`);
  assert(/content-security-policy/i.test([...signin.headers.keys()].join(" ")) && signin.headers.get("x-frame-options") === "DENY", "…with a Content-Security-Policy, and no framing");
  // same-origin, never no-referrer: under no-referrer a browser posts a plain form with `Origin: null`, which
  // SvelteKit refuses as cross-site, and sign-out — a form with no script — failed in every browser (review pass 1).
  // This smoke sets Origin itself, so it holds the header that decides what a browser sends.
  assert(signin.headers.get("referrer-policy") === "same-origin", `…and Referrer-Policy same-origin, so a browser's form post carries its origin (${signin.headers.get("referrer-policy")})`);
  const nullOrigin = await fetch(`${BASE}/signin`, { method: "POST", redirect: "manual", headers: { ...FORM, origin: "null" }, body: new URLSearchParams({ key: WRITE_KEY }).toString() });
  assert(nullOrigin.status === 403, `…since a form posted with Origin null is refused (${nullOrigin.status})`);
}

// Keys the brain must not take.
{
  const wrong = await signIn("not-a-key");
  assert(wrong.status === 401 && cookie === "", `a wrong key is refused at /signin with 401 and no cookie (${wrong.status})`);
  assert(wrong.html.includes("The brain refused that access key"), "…and the page says the brain refused it");
  if (CAPTURE_KEY) {
    const cap = await signIn(CAPTURE_KEY);
    assert(cap.status === 403 && cookie === "", `a capture-only key is refused at /signin with 403 and no cookie (${cap.status})`);
    assert(cap.html.includes("This key cannot read"), "…and the page says why");
  } else {
    console.log("  ·  no --capture-key: the capture-key arm skipped");
  }
  // A cookie the server never issued: random, and the key itself as the value.
  for (const [value, what] of [["A".repeat(43), "a random value"], [WRITE_KEY, "the write key itself"]] as const) {
    cookie = `${COOKIE}=${value}`;
    const r = await get("/");
    assert(toSignin(r) && /Max-Age=0/i.test(lastSetCookie) && attributesHold(lastSetCookie), `a cookie holding ${what} is no session: / redirects to /signin and the cookie is dropped with the session's attributes (${r.status}; ${redacted(lastSetCookie)})`);
    cookie = "";
  }
  const cross = await fetch(`${BASE}/signin`, { method: "POST", redirect: "manual", headers: { ...FORM, origin: "https://elsewhere.example" }, body: new URLSearchParams({ key: WRITE_KEY }).toString() });
  takeCookie(cross);
  assert(cross.status === 403 && cookie === "", `a sign-in posted from another origin is refused, with no cookie (${cross.status})`);
}

// The write key.
let thoughtId = "";
{
  const r = await signIn(WRITE_KEY);
  assert(r.status === 303 && r.location === "/dashboard/", `the write key signs in: 303 to /dashboard/ (${r.status} → ${r.location})`);
  assert(cookie !== "" && attributesHold(lastSetCookie) && /Max-Age=86400/.test(lastSetCookie), `…its cookie scoped to /dashboard, HttpOnly, SameSite=Lax, a day, Secure ${https ? "on https" : "not on plain HTTP"} (${redacted(lastSetCookie)})`);
  assert(!cookie.includes(WRITE_KEY) && !lastSetCookie.includes(WRITE_KEY), "…and it does not hold the key");
  const sessionCookie = cookie;

  const home = await get("/");
  assert(home.status === 200 && home.html.includes('data-testid="who"') && home.html.includes("write key"), `the overview renders for the write key and names its scope (${home.status})`);
  const total = /data-testid="total">([\d,.\s]+)</.exec(home.html)?.[1];
  assert(total !== undefined, `…with the brain's total from the REST core (${total ?? "none"})`);
  assert(home.headers.get("cache-control") === "no-store" && home.headers.get("referrer-policy") === "same-origin", "…no-store, so no copy is kept, and Referrer-Policy same-origin");
  thoughtId = /href="\/dashboard\/thoughts\/([0-9a-f-]{36})"/.exec(home.html)?.[1] ?? "";

  const status = await get("/status");
  const version = /data-testid="version">([^<]+)</.exec(status.html)?.[1];
  assert(status.status === 200 && /^\d+\.\d+\.\d+/.test(version ?? ""), `the status page renders the server's version (${status.status}: ${version ?? "none"})`);
  assert(/data-testid="ledger">\s*\d+/.test(status.html), "…and the ledger's highest migration");

  if (thoughtId) {
    const t = await get(`/thoughts/${thoughtId}`);
    assert(t.status === 200 && t.html.includes('data-testid="text"') && t.html.includes(thoughtId), `a thought's page renders its text and id (${t.status})`);
  } else {
    console.log("  ·  the brain holds no thought: the thought page's arm skipped");
  }

  // The key reaches no page, no header, no script the pages load — the
  // entries SvelteKit imports inline, and every module they import in turn —
  // and none of the data a client-side navigation fetches (__data.json).
  const pages = [home, status, await get("/__data.json"), await get("/status/__data.json")];
  const queue = pages.flatMap((p) => [...p.html.matchAll(/["'](\/dashboard\/_app\/[^"']+\.js)["']/g)].map((m) => m[1]));
  const scripts = new Set<string>();
  let leaked = pages.some((p) => p.html.includes(WRITE_KEY) || [...p.headers.values()].some((v) => v.includes(WRITE_KEY)));
  while (queue.length) {
    const s = queue.pop()!;
    if (scripts.has(s)) continue;
    scripts.add(s);
    const text = await (await fetch(`${ORIGIN}${s}`)).text();
    if (text.includes(WRITE_KEY)) leaked = true;
    // A chunk names the others it imports relative to itself: "./x.js", "../chunks/y.js".
    for (const m of text.matchAll(/["'](\.{1,2}\/[^"']+\.js)["']/g)) queue.push(new URL(m[1], `${ORIGIN}${s}`).pathname);
  }
  assert(pages[2].status === 200 && pages[3].status === 200, `the pages' navigation data answers for the session (${pages[2].status}, ${pages[3].status})`);
  assert(!leaked && scripts.size > 2, `no page, header, navigation data or script (${scripts.size} modules) holds the key`);

  const out = await signOut();
  assert(out.status === 303 && cookie === "" && /Max-Age=0/i.test(lastSetCookie) && attributesHold(lastSetCookie), `sign-out is a POST that clears the cookie with the session's attributes (${out.status})`);
  cookie = sessionCookie;
  const again = await get("/");
  assert(toSignin(again), `…and ends the session on the server: the old cookie presented again is no session (${again.status} → ${again.location})`);
  cookie = "";

  // A sign-in over a live session replaces it: the first id is no session once the second is issued (review pass 1).
  await signIn(WRITE_KEY);
  const first = cookie;
  await signIn(WRITE_KEY);
  const second = cookie;
  cookie = first;
  const stale = await get("/");
  cookie = second;
  const fresh = await get("/");
  assert(first !== second && toSignin(stale) && fresh.status === 200, `a second sign-in ends the first session on the server (first ${stale.status}, second ${fresh.status})`);
  await signOut();
  cookie = "";
}

// The read key.
if (READ_KEY) {
  const r = await signIn(READ_KEY);
  assert(r.status === 303 && cookie !== "", `the read key signs in (${r.status})`);
  const home = await get("/");
  assert(home.status === 200 && home.html.includes("read key"), `the overview renders for the read key and names its scope (${home.status})`);
  const missing = await get("/thoughts/00000000-0000-0000-0000-000000000000");
  assert(missing.status === 404, `a thought the brain does not hold is a 404 (${missing.status})`);
  const out = await signOut();
  assert(out.status === 303 && cookie === "", "…and signs out");
} else {
  console.log("  ·  no --read-key: the read-key arm skipped");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
