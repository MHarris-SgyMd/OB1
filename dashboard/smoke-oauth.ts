#!/usr/bin/env bun
/**
 * smoke-oauth.ts — the operator GUI's sign-in through the authorization server
 * (SMD-3307), driven as a browser would through the stack's proxy, on a stack
 * configured for the AS (COMPOSE_PROFILES naming auth). CI's deploy-stack-auth
 * job runs it:
 *
 *   OB1_AUTH_OPERATOR_PASSWORD=… bun smoke-oauth.ts --url http://127.0.0.1:8010/dashboard --origin https://brain.example.test
 *
 * The operator's password is read from the environment, never the command
 * line. Redirects the AS and the GUI write with the configured origin are
 * followed at --url's own origin, as deploy/auth/restart-check.ts follows
 * them; every form is posted with the configured origin, as a browser at it
 * would. It asserts:
 *   - the sign-in page offers the AS and no key field; the start is a POST
 *     whose answer sends the browser to the AS's authorize endpoint as `gui`,
 *     S256, prompt=login consent, offline_access, for the REST core, and sets a
 *     sign-in cookie on the GUI's auth paths alone, which a stray callback
 *     mid-sign-in leaves in place;
 *   - the password and the consent at the AS bring the browser back to the
 *     callback, which opens a session (a cookie scoped to /dashboard) and
 *     sends it home, where the who line names oauth:operator+gui (the
 *     operator through the GUI's own client, SMD-3064) with write;
 *   - the views render under the token session: overview, status, browse,
 *     the change feed, the workers; the nav offers the page of grants, which
 *     lists this sign-in's own grant (SMD-3307 PR 3), and a revoke posted
 *     from another origin is refused;
 *   - no page, header, navigation data, script module or cookie of the GUI's
 *     holds a token (nothing JWT-shaped), and the GUI's cookies are the
 *     session's alone (the Verify line: the browser holds no token);
 *   - the callback replayed, or answered with a state this browser was never
 *     given, signs no one in and says why; so does a real answer opened in
 *     another browser, one without the sign-in cookie (no login CSRF), or one
 *     whose cookie is set to the answer's state, as a thief of the URL could
 *     set it (the verifier comes only from the binding the real cookie holds);
 *   - signed in, a start starts nothing; a start or a sign-out posted from
 *     another origin, even with no body, is refused;
 *   - sign-out ends the session, and signing in again in that browser asks for
 *     the password (prompt=login: the AS's own session does not sign the next
 *     visitor in), and so does one whose URL drops prompt=login and asks a
 *     day's max_age (the AS asks gui every time, whatever the request says);
 *     a consent denied at the AS comes back in words and opens nothing; a
 *     refusal word the page does not know (`constructor`) is none.
 *
 * With `--revoke-client <id>` (CI: a client restart-check.ts --hold-grant
 * signed in), the page lists that client's grant, a revoke removes it and
 * says so, and a second revoke of it says it is gone; CI then holds the AS
 * to refusing that client's refresh token (restart-check.ts --refused).
 *
 * With `--renewal`, before signing out it waits past the session's access
 * token's expiry (620 s) and loads pages again: they render only if the GUI
 * renewed with the refresh token, unseen, and the session goes on. Some ten minutes, so CI does not run it; test-oauth.ts holds
 * the renewal's logic, and restart-check.ts --gui-refresh the AS's side.
 *
 * Exit 0 when every assertion holds, 1 otherwise. Each run adds a grant at the
 * AS (revoked by its sign-out) and a session it ends.
 */

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = flag("url")?.replace(/\/$/, "");
const ORIGIN = flag("origin")?.replace(/\/$/, "");
const PASSWORD = process.env.OB1_AUTH_OPERATOR_PASSWORD ?? "";
if (!BASE || !ORIGIN || !PASSWORD) {
  console.error("usage: OB1_AUTH_OPERATOR_PASSWORD=… bun smoke-oauth.ts --url <proxy>/dashboard --origin <configured origin>");
  process.exit(2);
}
const LOCAL = new URL(BASE).origin;
const RENEWAL = args.includes("--renewal");
const REVOKE_CLIENT = flag("revoke-client");
/** The session cookie, named for the configured origin's port when it names one (listener.ts sessionCookieName, SMD-3352). */
const COOKIE = new URL(ORIGIN).port ? `ob1_dashboard_session_${new URL(ORIGIN).port}` : "ob1_dashboard_session";
/** The sign-in binding's cookie, named by the same rule (session.ts signInCookieName). */
const SIGNIN_COOKIE = new URL(ORIGIN).port ? `ob1_dashboard_signin_${new URL(ORIGIN).port}` : "ob1_dashboard_signin";

let pass = 0;
let fail = 0;
const assert = (cond: boolean, msg: string) => { console.log(`  ${cond ? "✓" : "✗"}  ${msg}`); if (cond) pass++; else fail++; };

/** A browser's cookie jar, by name: each cookie's value and Path, sent to the paths under it, as a browser sends them (the host is one here). */
type Jar = Map<string, { value: string; path: string; line: string }>;
const newJar = (): Jar => new Map();
function take(jar: Jar, r: Response) {
  for (const line of r.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? "/";
    if (!value || attrs.some((a) => /^max-age=0$/i.test(a) || /^expires=thu, 01 jan 1970/i.test(a))) jar.delete(name);
    else jar.set(name, { value, path, line });
  }
}
const cookieFor = (jar: Jar, path: string) => [...jar].filter(([, c]) => path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)).map(([n, c]) => `${n}=${c.value}`).join("; ");
/** An address the configured origin wrote, at --url's own origin; a relative one against it. */
const local = (href: string) => new URL(href.startsWith(ORIGIN) ? `${LOCAL}${href.slice(ORIGIN.length)}` : href, LOCAL);

async function go(jar: Jar, href: string, init: { method?: string; form?: Record<string, string> } = {}) {
  const url = local(href);
  const headers: Record<string, string> = { accept: "text/html" };
  const cookie = cookieFor(jar, url.pathname);
  if (cookie) headers.cookie = cookie;
  if (init.form) Object.assign(headers, { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN });
  const r = await fetch(url, { method: init.method ?? (init.form ? "POST" : "GET"), redirect: "manual", headers, body: init.form ? new URLSearchParams(init.form).toString() : undefined });
  take(jar, r);
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text(), headers: r.headers };
}

/**
 * The browser at the AS, from the authorize redirect to the answer it sends
 * back to `back`: the sign-in page's password, then the consent page's
 * confirm (or its abort). Returns the redirect to `back`, or why it stopped.
 */
async function atTheAs(jar: Jar, authorize: string, back: string, choice: "confirm" | "abort", prompts: string[] = []): Promise<string> {
  let next = authorize;
  let form: Record<string, string> | undefined;
  for (let step = 0; step < 12; step++) {
    const r = await go(jar, next, form ? { form } : {});
    form = undefined;
    if (r.status >= 300 && r.status < 400) {
      if (r.location.startsWith(back)) return r.location;
      next = r.location;
      continue;
    }
    const prompt = /data-prompt="([a-z]+)"/.exec(r.html)?.[1];
    if (prompt) prompts.push(prompt);
    const actions = [...r.html.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
    if (r.status === 200 && prompt === "login" && actions[0]) {
      next = actions[0];
      form = { password: PASSWORD };
      continue;
    }
    if (r.status === 200 && prompt === "consent") {
      const action = actions.find((a) => a.endsWith(`/${choice}`));
      if (!action) return `the consent page has no ${choice} form`;
      next = action;
      form = {};
      continue;
    }
    return `the AS stopped at ${local(next).pathname}: HTTP ${r.status} ${r.html.slice(0, 160).replace(/\s+/g, " ")}`;
  }
  return "the AS sent no answer back in 12 steps";
}

const newJarC = newJar();
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

console.log(`▸ dashboard ${BASE}, signing in through the authorization server at ${ORIGIN}`);
const jar = newJar();

// The sign-in page.
const signin = await go(jar, `${BASE}/signin`);
assert(signin.status === 200 && signin.html.includes('data-testid="oauth"') && !signin.html.includes('name="key"'), `the sign-in page offers the authorization server and no key field (${signin.status})`);

// The start: a POST, answered with the AS's authorize endpoint.
const start = await go(jar, `${BASE}/auth/start`, { form: {} });
const authz = start.location ? new URL(start.location, ORIGIN) : null;
const q = authz?.searchParams;
assert(start.status === 303 && authz !== null && `${authz.origin}${authz.pathname}` === `${ORIGIN}/auth/authorize`, `the start answers 303 to the AS's authorize endpoint (${start.status} → ${authz ? authz.origin + authz.pathname : "-"})`);
assert(q?.get("client_id") === "gui" && q.get("code_challenge_method") === "S256" && Boolean(q.get("code_challenge")) && !q.has("code_verifier") && q.get("prompt") === "login consent" && q.get("resource") === `${ORIGIN}/api` && (q.get("scope") ?? "").split(" ").includes("offline_access") && q.get("redirect_uri") === `${ORIGIN}/dashboard/auth/callback`, "…as gui, an S256 challenge and no verifier, prompt=login consent, offline_access, for the REST core, back to the registered callback");
const signinCookie = jar.get(SIGNIN_COOKIE);
/** The sign-in cookie as the start set it, kept to put back for the replay below. */
const keptSignin = signinCookie ? { ...signinCookie } : undefined;
assert(signinCookie !== undefined && signinCookie.path === "/dashboard/auth" && /HttpOnly/i.test(signinCookie.line) && /;\s*Secure/i.test(signinCookie.line) === ORIGIN.startsWith("https:"), `…and a sign-in cookie on the GUI's auth paths alone, HttpOnly, Secure on an https origin (${signinCookie ? signinCookie.line.replace(/=[^;]*/, "=…") : "none"})`);
// A stray callback mid-sign-in (an old link, another tab's answer) is refused and leaves this sign-in's cookie alone.
const stray = await go(jar, `${BASE}/auth/callback?state=stray&code=x`);
assert(stray.status === 303 && stray.location === "/dashboard/signin?refused=stale" && jar.get(SIGNIN_COOKIE)?.value === signinCookie?.value, `a stray callback mid-sign-in is refused and leaves the sign-in's cookie in place (${stray.status} → ${stray.location})`);
const getStart = await go(jar, `${BASE}/auth/start`);
assert(getStart.status === 405 || getStart.status === 404, `a GET of the start starts nothing (${getStart.status})`);

// At the AS: the password, the consent, and back.
const callback = await atTheAs(jar, start.location, `${ORIGIN}/dashboard/auth/callback`, "confirm");
assert(callback.startsWith(`${ORIGIN}/dashboard/auth/callback?`) && new URL(callback).searchParams.has("code"), `the password and the consent bring the browser back to the callback with a code (${callback.startsWith(ORIGIN) ? new URL(callback).pathname : callback})`);
const landed = callback.startsWith(ORIGIN) ? await go(jar, callback) : { status: 0, location: "", html: "", headers: new Headers() };
const session = jar.get(COOKIE);
assert(landed.status === 303 && landed.location === "/dashboard/" && session !== undefined && session.path === "/dashboard" && /HttpOnly/i.test(session.line) && /SameSite=Lax/i.test(session.line), `the callback opens a session — a cookie on /dashboard, HttpOnly, Lax — and sends the browser home (${landed.status} → ${landed.location})`);
assert(!jar.has(SIGNIN_COOKIE), "…and drops the sign-in cookie");

// Signed in, a start starts nothing; and neither a start nor a sign-out is taken from another origin, even with no body (SvelteKit checks a form's).
const startSignedIn = await go(jar, `${BASE}/auth/start`, { form: {} });
assert(startSignedIn.status === 303 && startSignedIn.location === "/dashboard/signin" && !jar.has(SIGNIN_COOKIE), `signed in, the start starts nothing (${startSignedIn.status} → ${startSignedIn.location})`);
const fromElsewhere = await Promise.all(["auth/start", "signout"].map((p) => fetch(`${BASE}/${p}`, { method: "POST", redirect: "manual", headers: { origin: "https://elsewhere.example", cookie: cookieFor(jar, `/dashboard/${p}`) } }).then((r) => r.status)));
assert(fromElsewhere.every((c) => c === 403) && jar.has(COOKIE), `a start or a sign-out posted with no body from another origin is refused, the session kept (${fromElsewhere.join(", ")})`);

// Under the token session.
const home = await go(jar, `${BASE}/`);
const who = /data-testid="who">([^<]*)</.exec(home.html)?.[1] ?? "";
assert(home.status === 200 && /oauth:operator\+gui\b/.test(who) && /write key/.test(who), `the overview renders under the token, the who line naming oauth:operator+gui with write (${home.status}, "${who.trim()}")`);
const views = await Promise.all(["/status", "/thoughts", "/changes", "/workers", "/query-log"].map(async (p) => [p, await go(jar, `${BASE}${p}`)] as const));
assert(views.every(([, r]) => r.status === 200), `…and so do the status, browse, the change feed, the workers and the query log (${views.map(([p, r]) => `${p} ${r.status}`).join(", ")})`);

// The page of grants (SMD-3307 PR 3): offered in the nav, listing this sign-in's own grant among the rest.
const grantsOf = (html: string) => html.split('data-testid="grant"').slice(1).map((li) => ({ id: /data-grant="([^"]+)"/.exec(li)?.[1] ?? "", text: li.slice(0, li.indexOf("</li>")) }));
const grants = await go(jar, `${BASE}/grants`);
const listed = grantsOf(grants.html);
// The label exactly: a GUI grant holding no refresh token reads "This dashboard, no refresh token", and this sign-in holds one.
assert(home.html.includes('href="/dashboard/grants"') && grants.status === 200 && listed.some((g) => g.text.includes(">This dashboard<")), `the nav offers the page of grants, which lists this dashboard's own sign-in (${grants.status}, ${listed.length} grant(s))`);
const revokeElsewhere = await fetch(`${BASE}/grants?/revoke`, { method: "POST", redirect: "manual", headers: { origin: "https://elsewhere.example", "content-type": "application/x-www-form-urlencoded", cookie: cookieFor(jar, "/dashboard/grants") }, body: new URLSearchParams({ grant: listed[0]?.id ?? "x" }).toString() });
assert(revokeElsewhere.status === 403, `…a revoke posted from another origin is refused (${revokeElsewhere.status})`);
const notAForm = await fetch(`${BASE}/grants?/revoke`, { method: "POST", redirect: "manual", headers: { origin: ORIGIN, "content-type": "text/plain", accept: "text/html", cookie: cookieFor(jar, "/dashboard/grants") }, body: "grant=x" });
assert(notAForm.status === 400, `…and one whose body is not a form is a 400, not the server's fault (${notAForm.status})`);
if (REVOKE_CLIENT) {
  const theirs = listed.find((g) => g.text.includes(`registered client ${REVOKE_CLIENT}`));
  const revoked = theirs ? await go(jar, `${BASE}/grants?/revoke`, { form: { grant: theirs.id } }) : { status: 0, location: "", html: "", headers: new Headers() };
  const afterRevoke = await go(jar, `${BASE}/grants?revoked=1`);
  assert(!!theirs && revoked.status === 303 && revoked.location === "/dashboard/grants?revoked=1" && afterRevoke.html.includes('data-testid="revoked"') && !grantsOf(afterRevoke.html).some((g) => g.id === theirs.id), `--revoke-client: its grant is listed, a revoke removes it and says so (${theirs ? revoked.status : "not listed"} → ${revoked.location})`);
  const twice = theirs ? await go(jar, `${BASE}/grants?/revoke`, { form: { grant: theirs.id } }) : { status: 0, location: "" };
  assert(twice.status === 303 && twice.location === "/dashboard/grants?gone=1", `…and revoked again, it is gone, nothing more done (${twice.status} → ${twice.location})`);
}

// No token where the browser can see it.
const pages = [signin, home, grants, ...views.map(([, r]) => r), await go(jar, `${BASE}/__data.json`), await go(jar, `${BASE}/status/__data.json`)];
const queue = pages.flatMap((p) => [...p.html.matchAll(/["'](\/dashboard\/_app\/[^"']+\.js)["']/g)].map((m) => m[1]));
const scripts = new Set<string>();
let leaked = pages.some((p) => JWT.test(p.html) || [...p.headers.values()].some((v) => JWT.test(v)));
while (queue.length) {
  const s = queue.pop()!;
  if (scripts.has(s)) continue;
  scripts.add(s);
  const text = await (await fetch(`${LOCAL}${s}`)).text();
  if (JWT.test(text)) leaked = true;
  for (const m of text.matchAll(/["'](\.{1,2}\/[^"']+\.js)["']/g)) queue.push(new URL(m[1], `${LOCAL}${s}`).pathname);
}
const guiCookies = [...jar].filter(([, c]) => c.path.startsWith("/dashboard"));
assert(!leaked && scripts.size > 2, `no page, header, navigation data or script (${scripts.size} modules) holds a token`);
assert(guiCookies.length === 1 && guiCookies[0][0] === COOKIE && !JWT.test(guiCookies[0][1].value) && guiCookies[0][1].value.length < 60, `…and the GUI's one cookie is the session's id, no token (${guiCookies.map(([n]) => n).join(", ")})`);

if (RENEWAL) {
  // 600 s tokens: past their expiry, so a page works only if the GUI renewed (an unrenewed token is the REST core's 401, which ends the session).
  console.log("  ·  --renewal: waiting 620 s, past the access token's expiry: only a renewed token works then");
  await Bun.sleep(620_000);
  const [a, b] = await Promise.all([go(jar, `${BASE}/status`), go(jar, `${BASE}/thoughts`)]);
  const again = await go(jar, `${BASE}/`);
  assert(a.status === 200 && b.status === 200 && again.status === 200 && /oauth:operator\+gui\b/.test(again.html) && jar.has(COOKIE), `past the token's renewal, two pages at once and the overview still render, the session renewed unseen (${a.status}, ${b.status}, ${again.status})`);
  // Past the AS's 10 s grace for a reused refresh token: a renewer that renewed twice from one token forked the chain, which the AS ends here (review pass 4).
  await Bun.sleep(15_000);
  const later = await go(jar, `${BASE}/status`);
  assert(later.status === 200 && jar.has(COOKIE), `…and 15 s on, past the AS's grace for a reused refresh token, still (${later.status})`);
}

// The callback replayed, and one with a state this browser was never given.
const replay = await go(jar, callback);
assert(replay.status === 303 && replay.location === "/dashboard/signin?refused=stale", `the callback replayed signs no one in: back to /signin as stale (${replay.status} → ${replay.location})`);
// Even with the sign-in cookie put back, the answer is taken once: its verifier was spent (the cookie alone does not hold it).
const withCookie = newJar();
if (keptSignin) withCookie.set(SIGNIN_COOKIE, keptSignin);
const replayedWithCookie = await go(withCookie, callback);
assert(replayedWithCookie.status === 303 && replayedWithCookie.location === "/dashboard/signin?refused=stale" && !withCookie.has(COOKIE), `…even with its sign-in cookie put back: the verifier was spent, stale before the AS is asked (${replayedWithCookie.status} → ${replayedWithCookie.location})`);
const forged = await go(newJar(), `${BASE}/auth/callback?code=x&state=never-given`);
assert(forged.status === 303 && forged.location === "/dashboard/signin?refused=stale", `…nor one with a state this browser was never given (${forged.status} → ${forged.location})`);
// A real answer, opened in a browser that did not start the sign-in: refused, so no one can sign another browser in as themselves.
const startC = await go(newJarC, `${BASE}/auth/start`, { form: {} });
const answerC = await atTheAs(newJarC, startC.location, `${ORIGIN}/dashboard/auth/callback`, "confirm");
const elsewhere = newJar();
const openedElsewhere = answerC.startsWith(ORIGIN) ? await go(elsewhere, answerC) : { status: 0, location: answerC, html: "", headers: new Headers() };
const thief = newJar();
const stolenState = answerC.startsWith(ORIGIN) ? new URL(answerC).searchParams.get("state") ?? "" : "";
thief.set(SIGNIN_COOKIE, { value: stolenState, path: "/dashboard/auth", line: "" });
const openedByThief = answerC.startsWith(ORIGIN) ? await go(thief, answerC) : { status: 0, location: answerC, html: "", headers: new Headers() };
assert(openedByThief.status === 303 && openedByThief.location === "/dashboard/signin?refused=stale" && !thief.has(COOKIE), `…nor that answer opened with a cookie set to its state, as a thief of the URL could: the verifier comes from the real cookie's binding alone (${openedByThief.status} → ${openedByThief.location})`);
assert(new URL(answerC.startsWith(ORIGIN) ? answerC : `${ORIGIN}/x`).searchParams.has("code") && openedElsewhere.status === 303 && openedElsewhere.location === "/dashboard/signin?refused=stale" && !elsewhere.has(COOKIE), `…nor a real answer opened in another browser, one without the sign-in cookie (${openedElsewhere.status} → ${openedElsewhere.location})`);
const said = await go(newJar(), `${BASE}/signin?refused=stale`);
assert(said.html.includes('data-testid="refused"') && said.html.includes("expired, or was not started in this browser"), "…and the sign-in page says why in its own words");

// Sign-out.
const out = await go(jar, `${BASE}/signout`, { form: {} });
const after = await go(jar, `${BASE}/`);
assert(out.status === 303 && !jar.has(COOKIE) && after.status === 303 && after.location === "/dashboard/signin", `sign-out ends the session (${out.status}; then / → ${after.status} ${after.location})`);

// Signing in again in the same browser asks for the password: the AS's session outlived the GUI's, prompt=login does not let it sign anyone in.
const againPrompts: string[] = [];
const startNext = await go(jar, `${BASE}/auth/start`, { form: {} });
await atTheAs(jar, startNext.location, `${ORIGIN}/dashboard/auth/callback`, "abort", againPrompts);
assert(againPrompts[0] === "login" && againPrompts.includes("consent"), `signing in again after sign-out asks for the password first (${againPrompts.join(" → ")})`);
// …and so does one whose URL drops prompt=login and asks a day's max_age, as the next visitor could edit it: the AS asks gui the password every time, whatever the request says (review pass 4).
const skipPrompts: string[] = [];
const startSkip = await go(jar, `${BASE}/auth/start`, { form: {} });
const skipUrl = startSkip.location ? new URL(startSkip.location, ORIGIN) : null;
skipUrl?.searchParams.set("prompt", "consent");
skipUrl?.searchParams.set("max_age", "86400");
const skipped = skipUrl ? await atTheAs(jar, skipUrl.href, `${ORIGIN}/dashboard/auth/callback`, "abort", skipPrompts) : "no start";
const skippedAt = skipped.startsWith(ORIGIN) ? await go(jar, skipped) : { status: 0, location: skipped, html: "", headers: new Headers() };
assert(skipPrompts[0] === "login" && !jar.has(COOKIE), `…and so does one whose URL drops prompt=login and asks max_age=86400 (${skipPrompts.join(" → ")}; ${skippedAt.status} → ${skippedAt.location})`);
const unknownWord = await go(newJar(), `${BASE}/signin?refused=constructor`);
assert(unknownWord.status === 200 && !unknownWord.html.includes('data-testid="refused"'), `a refusal word the page does not know (constructor) says nothing, and no 500 (${unknownWord.status})`);

// A consent denied at the AS.
const denyJar = newJar();
const startAgain = await go(denyJar, `${BASE}/auth/start`, { form: {} });
const denied = await atTheAs(denyJar, startAgain.location, `${ORIGIN}/dashboard/auth/callback`, "abort");
const deniedAt = denied.startsWith(ORIGIN) ? await go(denyJar, denied) : { status: 0, location: "", html: "", headers: new Headers() };
assert(new URL(denied.startsWith(ORIGIN) ? denied : `${ORIGIN}/x`).searchParams.get("error") === "access_denied" && deniedAt.status === 303 && deniedAt.location === "/dashboard/signin?refused=denied" && !denyJar.has(COOKIE), `a consent denied at the AS comes back as denied and opens nothing (${deniedAt.status} → ${deniedAt.location})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
