#!/usr/bin/env bun
/**
 * restart-check.ts — the authorization server keeps its state across a
 * restart (SMD-2285): run inside the `auth` container, against its own port.
 *
 *   compose exec -T auth bun restart-check.ts --register > client.json   # before the restart
 *   compose restart auth
 *   compose exec -T auth bun restart-check.ts --read < client.json        # after it
 *
 * `--register` registers a client by DCR and prints its id and registration
 * token; `--read` reads it back with that token (RFC 7592), which answers 200
 * only when the store kept the client and the token. The memory adapter forgot
 * both on every restart. CI's deploy-stack-auth job runs it (fork-checks.yml). Each
 * `--register` leaves a client in the store, so it is for a test stack, not a
 * running deploy.
 *
 *   compose exec -T -e OB1_AUTH_OPERATOR_PASSWORD auth bun restart-check.ts --session-cookie < client.json
 *
 * `--session-cookie` signs the operator in for that client (an authorization
 * request, the sign-in page, the password) and prints the Path of the session
 * cookie the server sets: `/auth`, so behind the proxy it never rides a
 * request to `/mcp` or any other route on the origin (SMD-1846 PR 2). The
 * password comes from the environment `exec -e` hands it; the container is
 * given only the hash.
 *
 *   compose exec -T -e OB1_AUTH_OPERATOR_PASSWORD auth bun restart-check.ts --tokens 'brain:read'
 *
 * `--tokens <scope>` (SMD-2286) registers a public client, signs the operator
 * in, allows the consent, takes the code for an `/mcp` token with that scope,
 * and exchanges it as the MCP service (`mcp`, its secret from the container's
 * environment) for a REST-core token, as the MCP server does at the hop. It
 * prints them as JSON `{ mcp, api, client }`, `client` the id it registered,
 * for CI to present to the REST core, which names the caller by that client
 * (SMD-3064).
 *
 *   compose exec -T -e OB1_AUTH_OPERATOR_PASSWORD auth bun restart-check.ts --gui-refresh
 *
 * `--gui-refresh` (SMD-3307) signs the operator in as the operator GUI does —
 * the confidential `gui` client (its secret from the container's environment),
 * S256, `offline_access` with `prompt=login consent`, for the REST core — and checks
 * what the GUI's session leans on: the code gives a refresh token, a refresh
 * gives a new pair (the refresh token rotated), and the refresh token revoked
 * as the GUI's sign-out revokes it is refused at the next refresh; a second
 * sign-in in the same browser, prompt=login dropped and a day's max_age asked,
 * is asked the password all the same, and is on a grant of its own, which the
 * first one's revocation — sent while its consent page is up — leaves; and
 * with the AS's session live, prompt=none is answered login_required (review
 * passes 4 and 5). It prints one line saying so, or why not, and no token.
 *
 *   compose exec -T -e OB1_AUTH_OPERATOR_PASSWORD auth bun restart-check.ts --hold-grant > held.json
 *   compose exec -T auth bun restart-check.ts --admin
 *   compose exec -T auth bun restart-check.ts --refused < held.json
 *   compose exec -T auth bun restart-check.ts --admin-lockout   # locks the container's own address out for 15 min
 *
 * The page of grants (SMD-3307 PR 3). `--hold-grant` registers a public
 * client that may refresh, signs the operator in for it with
 * `offline_access`, refreshes once (so the token it holds is one the server
 * took: `--refused` has its control), and prints its id and refresh token as
 * JSON, for CI to revoke its grant on the GUI's page. `--admin` holds the
 * admin listener (admin.ts, on 3001) to its rules: no credential, another
 * client's own and a wrong secret are 401, the GUI's lists the grants, and the
 * routes refuse other methods and shapes. `--refused` refreshes with the held
 * token and passes only on 400 `invalid_grant`, which the grant's revocation
 * makes. `--admin-lockout` dials the container's own address (its first
 * non-loopback interface, on the mesh or on auth-egress: the listener is on
 * both), not 127.0.0.1, so the listener sees an address --admin never used: 20
 * wrong secrets each 401, the 21st 429 with a Retry-After, and the GUI's own
 * credentials from that address 429 too — the failure limit, 20 in the window
 * (review passes 1 and 2). It leaves that address locked out for the window;
 * nothing else dials it.
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = "http://127.0.0.1:3000/auth";

if (process.argv.includes("--register")) {
  const r = await fetch(`${BASE}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "restart-check", redirect_uris: ["https://client.example/callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const body = (await r.json()) as { client_id?: string; registration_access_token?: string };
  if (r.status !== 201 || !body.client_id || !body.registration_access_token) {
    console.error(`registration answered ${r.status}: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ client_id: body.client_id, registration_access_token: body.registration_access_token }));
} else if (process.argv.includes("--read")) {
  const { client_id, registration_access_token } = JSON.parse(await Bun.stdin.text()) as { client_id: string; registration_access_token: string };
  const r = await fetch(`${BASE}/reg/${encodeURIComponent(client_id)}`, { headers: { authorization: `Bearer ${registration_access_token}` } });
  const body = (await r.json()) as { client_id?: string; client_name?: string };
  if (r.status !== 200 || body.client_id !== client_id || body.client_name !== "restart-check") {
    console.error(`reading ${client_id} back answered ${r.status}: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`${client_id} and its registration token survived the restart`);
} else if (process.argv.includes("--session-cookie")) {
  const { client_id } = JSON.parse(await Bun.stdin.text()) as { client_id: string };
  const password = process.env.OB1_AUTH_OPERATOR_PASSWORD ?? "";
  const origin = process.env.OB1_PUBLIC_ORIGIN ?? "";
  if (!password || !origin) {
    console.error("--session-cookie needs OB1_AUTH_OPERATOR_PASSWORD (exec -e) and OB1_PUBLIC_ORIGIN in its environment");
    process.exit(2);
  }
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id,
    response_type: "code",
    redirect_uri: "https://client.example/callback",
    scope: "openid",
    state: "session-cookie-check",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  // The server writes its own origin into every redirect; this side dials its port.
  const local = (href: string) => new URL(href.startsWith(origin) ? `http://127.0.0.1:3000${href.slice(origin.length)}` : href, BASE);
  const jar = new Map<string, string>();
  let url = new URL(`${BASE}/authorize?${query}`);
  let init: RequestInit = {};
  for (let step = 0; step < 10; step++) {
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") } });
    for (const line of r.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const name = pair.slice(0, pair.indexOf("="));
      jar.set(name, pair.slice(pair.indexOf("=") + 1));
      if (name === "_session") {
        console.log(attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? "(no Path)");
        process.exit(0);
      }
    }
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get("location") ?? "";
      // Back at the client before any session: the server refused the request, and says why in the query.
      if (location.startsWith("https://client.example/callback")) {
        console.error(`the authorization request came back to the client with no session cookie set: ${new URL(location).search}`);
        process.exit(1);
      }
      url = local(location);
      init = {};
      continue;
    }
    const page = await r.text();
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
    if (r.status !== 200 || !/data-prompt="login"/.test(page) || !action) {
      console.error(`the sign-in stopped at ${url.pathname}: HTTP ${r.status} ${page.slice(0, 200).replace(/\s+/g, " ")}`);
      process.exit(1);
    }
    url = local(action.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
    init = { method: "POST", body: new URLSearchParams({ password }), headers: { origin, "content-type": "application/x-www-form-urlencoded" } };
  }
  console.error("the sign-in set no session cookie in 10 steps");
  process.exit(1);
} else if (process.argv.includes("--tokens")) {
  const scope = process.argv[process.argv.indexOf("--tokens") + 1] ?? "";
  const password = process.env.OB1_AUTH_OPERATOR_PASSWORD ?? "";
  const origin = process.env.OB1_PUBLIC_ORIGIN ?? "";
  const mcpSecret = process.env.OB1_AUTH_SECRET_MCP ?? "";
  if (!scope || !password || !origin || !mcpSecret) {
    console.error("--tokens <scope> needs OB1_AUTH_OPERATOR_PASSWORD (exec -e), and OB1_PUBLIC_ORIGIN and OB1_AUTH_SECRET_MCP in its environment");
    process.exit(2);
  }
  const fail = (why: string): never => {
    console.error(why);
    process.exit(1);
  };
  const redirect = "https://client.example/callback";
  const reg = await fetch(`${BASE}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "token-check", redirect_uris: [redirect], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id?: string };
  if (reg.status !== 201 || !client_id) fail(`registration answered ${reg.status}`);
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client_id!,
    response_type: "code",
    redirect_uri: redirect,
    scope,
    state: "token-check",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const local = (href: string) => new URL(href.startsWith(origin) ? `http://127.0.0.1:3000${href.slice(origin.length)}` : href, BASE);
  const jar = new Map<string, string>();
  let url = new URL(`${BASE}/authorize?${query}`);
  let init: RequestInit = {};
  let code = "";
  // The sign-in page takes the password, the consent page its Allow (its first form); the code comes back to the client.
  for (let step = 0; step < 16 && !code; step++) {
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") } });
    for (const line of r.headers.getSetCookie()) {
      const pair = line.split(";")[0].trim();
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get("location") ?? "";
      if (location.startsWith(redirect)) {
        const back = new URL(location).searchParams;
        code = back.get("code") ?? fail(`the authorization request came back with no code: ${back.get("error")} ${back.get("error_description")}`);
        break;
      }
      url = local(location);
      init = {};
      continue;
    }
    const page = await r.text();
    const prompt = /data-prompt="([a-z]+)"/.exec(page)?.[1];
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
    if (r.status !== 200 || (prompt !== "login" && prompt !== "consent") || !action) fail(`the sign-in stopped at ${url.pathname}: HTTP ${r.status} ${page.slice(0, 200).replace(/\s+/g, " ")}`);
    url = local(action!.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
    init = { method: "POST", body: new URLSearchParams(prompt === "login" ? { password } : {}), headers: { origin, "content-type": "application/x-www-form-urlencoded" } };
  }
  if (!code) fail("the sign-in and consent gave no code in 16 steps");
  const form = (body: Record<string, string>, basic?: string) =>
    fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(basic ? { authorization: `Basic ${btoa(basic)}` } : {}) }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, string> }));
  const mcp = await form({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: client_id!, resource: `${origin}/mcp` });
  if (mcp.status !== 200 || !mcp.body.access_token) fail(`the code answered ${mcp.status} ${mcp.body.error ?? ""}`);
  const api = await form(
    { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: mcp.body.access_token, subject_token_type: "urn:ietf:params:oauth:token-type:access_token", resource: `${origin}/api` },
    `mcp:${mcpSecret}`,
  );
  if (api.status !== 200 || !api.body.access_token) fail(`the exchange answered ${api.status} ${api.body.error ?? ""}`);
  console.log(JSON.stringify({ mcp: mcp.body.access_token, api: api.body.access_token, client: client_id }));
} else if (process.argv.includes("--gui-refresh")) {
  const password = process.env.OB1_AUTH_OPERATOR_PASSWORD ?? "";
  const origin = process.env.OB1_PUBLIC_ORIGIN ?? "";
  const guiSecret = process.env.OB1_AUTH_SECRET_GUI ?? "";
  if (!password || !origin || !guiSecret) {
    console.error("--gui-refresh needs OB1_AUTH_OPERATOR_PASSWORD (exec -e), and OB1_PUBLIC_ORIGIN and OB1_AUTH_SECRET_GUI in its environment");
    process.exit(2);
  }
  const fail = (why: string): never => {
    console.error(why);
    process.exit(1);
  };
  const redirect = `${origin}/dashboard/auth/callback`;
  const resource = `${origin}/api`;
  const local = (href: string) => new URL(href.startsWith(origin) ? `http://127.0.0.1:3000${href.slice(origin.length)}` : href, BASE);
  // One browser: the AS's session cookie is kept between the two sign-ins below.
  const jar = new Map<string, string>();
  /** A sign-in as the GUI's, with `extra` in its request, `atConsent` run once its consent page is up: the code, its verifier, and the pages the AS showed on the way. */
  const signIn = async (extra: Record<string, string>, atConsent?: () => Promise<void>) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: "gui",
      response_type: "code",
      redirect_uri: redirect,
      scope: "openid offline_access brain:write",
      state: "gui-refresh-check",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource,
      ...extra,
    });
    let url = new URL(`${BASE}/authorize?${query}`);
    let init: RequestInit = {};
    const prompts: string[] = [];
    for (let step = 0; step < 16; step++) {
      const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") } });
      for (const line of r.headers.getSetCookie()) {
        const pair = line.split(";")[0].trim();
        jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
      }
      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location") ?? "";
        if (location.startsWith(redirect)) {
          const back = new URL(location).searchParams;
          return { code: back.get("code") ?? fail(`the authorization request came back with no code: ${back.get("error")} ${back.get("error_description")}`), verifier, prompts };
        }
        url = local(location);
        init = {};
        continue;
      }
      const page = await r.text();
      const prompt = /data-prompt="([a-z]+)"/.exec(page)?.[1];
      const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
      if (r.status !== 200 || (prompt !== "login" && prompt !== "consent") || !action) fail(`the sign-in stopped at ${url.pathname}: HTTP ${r.status} ${page.slice(0, 200).replace(/\s+/g, " ")}`);
      prompts.push(prompt!);
      if (prompt === "consent" && atConsent) await atConsent();
      url = local(action!.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
      init = { method: "POST", body: new URLSearchParams(prompt === "login" ? { password } : {}), headers: { origin, "content-type": "application/x-www-form-urlencoded" } };
    }
    return fail("the sign-in and consent gave no code in 16 steps");
  };
  const asGui = (path: string, body: Record<string, string>) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`gui:${guiSecret}`)}` }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, string> }));
  const exchange = async (s: { code: string; verifier: string }) => {
    const t = await asGui("/token", { grant_type: "authorization_code", code: s.code, redirect_uri: redirect, code_verifier: s.verifier, resource });
    if (t.status !== 200 || !t.body.access_token || !t.body.refresh_token) fail(`the code answered ${t.status} ${t.body.error ?? ""}, ${t.body.refresh_token ? "with" : "without"} a refresh token`);
    return t.body;
  };
  const revoke = async (token: string) => {
    const r = await fetch(`${BASE}/token/revocation`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`gui:${guiSecret}`)}` }, body: new URLSearchParams({ token, token_type_hint: "refresh_token" }) });
    if (r.status !== 200) fail(`the revocation answered ${r.status}`);
  };
  const first = await exchange(await signIn({ prompt: "login consent" }));
  const second = await asGui("/token", { grant_type: "refresh_token", refresh_token: first.refresh_token, resource });
  if (second.status !== 200 || !second.body.access_token || !second.body.refresh_token) fail(`the refresh answered ${second.status} ${second.body.error ?? ""}`);
  if (second.body.refresh_token === first.refresh_token || second.body.access_token === first.access_token) fail("the refresh handed back the same tokens: it did not rotate");
  // The same browser again, prompt=login dropped from the request and a day's max_age asked: the AS asks gui the password all the same (review pass 4).
  // The first sign-in is revoked while this one's consent page is up, as the GUI's revoker may after an outage: this one is made all the same (review pass 5).
  const again = await signIn({ prompt: "consent", max_age: "86400" }, () => revoke(second.body.refresh_token));
  if (again.prompts[0] !== "login") fail(`a sign-in as gui without prompt=login was let through on the AS's session, no password asked (${again.prompts.join(" → ") || "no page"})`);
  // One consent: the grant made at it holds what the request asks, or the AS asks again (review pass 5).
  if (again.prompts.join(" → ") !== "login → consent") fail(`the sign-in's pages were ${again.prompts.join(" → ")}, not the password then one consent: the grant made at the consent fell short of the request`);
  const next = await exchange(again);
  // With the AS's session live, prompt=none is answered login_required, as OpenID Connect has it, not let through (review pass 5).
  const silentQuery = new URLSearchParams({ client_id: "gui", response_type: "code", redirect_uri: redirect, scope: "openid offline_access brain:write", state: "gui-refresh-check", code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"), code_challenge_method: "S256", resource, prompt: "none" });
  const silent = await fetch(`${BASE}/authorize?${silentQuery}`, { redirect: "manual", headers: { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") } });
  const silentAt = silent.headers.get("location") ?? "";
  if (!silentAt.startsWith(redirect) || new URL(silentAt).searchParams.get("error") !== "login_required") fail(`a gui authorization with prompt=none answered ${silent.status} ${silentAt.startsWith(redirect) ? `error=${new URL(silentAt).searchParams.get("error")}` : "elsewhere"}, not login_required`);
  const after = await asGui("/token", { grant_type: "refresh_token", refresh_token: second.body.refresh_token, resource });
  if (after.status !== 400 || after.body.error !== "invalid_grant") fail(`a refresh with the revoked token answered ${after.status} ${after.body.error ?? ""}, not 400 invalid_grant`);
  // Each sign-in on a grant of its own: revoking the first ended its grant, not the next one's (review pass 4).
  const nextRefreshed = await asGui("/token", { grant_type: "refresh_token", refresh_token: next.refresh_token, resource });
  if (nextRefreshed.status !== 200 || !nextRefreshed.body.refresh_token) fail(`revoking one sign-in's refresh token ended the next one's too (${nextRefreshed.status} ${nextRefreshed.body.error ?? ""}): they shared a grant`);
  await revoke(nextRefreshed.body.refresh_token);
  console.log("gui: the code gave a refresh token, the refresh rotated it, once revoked it is refused; a sign-in without prompt=login was asked the password, on a grant of its own");
} else if (process.argv.includes("--hold-grant")) {
  const password = process.env.OB1_AUTH_OPERATOR_PASSWORD ?? "";
  const origin = process.env.OB1_PUBLIC_ORIGIN ?? "";
  if (!password || !origin) {
    console.error("--hold-grant needs OB1_AUTH_OPERATOR_PASSWORD (exec -e) and OB1_PUBLIC_ORIGIN in its environment");
    process.exit(2);
  }
  const fail = (why: string): never => {
    console.error(why);
    process.exit(1);
  };
  const redirect = "https://client.example/callback";
  const reg = await fetch(`${BASE}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "grant-check", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id?: string };
  if (reg.status !== 201 || !client_id) fail(`registration answered ${reg.status}`);
  const verifier = randomBytes(32).toString("base64url");
  // offline_access is honoured only with a consent asked for (OpenID Connect Core §11).
  const query = new URLSearchParams({
    client_id: client_id!,
    response_type: "code",
    redirect_uri: redirect,
    scope: "openid offline_access brain:read",
    prompt: "consent",
    state: "grant-check",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const local = (href: string) => new URL(href.startsWith(origin) ? `http://127.0.0.1:3000${href.slice(origin.length)}` : href, BASE);
  const jar = new Map<string, string>();
  let url = new URL(`${BASE}/authorize?${query}`);
  let init: RequestInit = {};
  let code = "";
  for (let step = 0; step < 16 && !code; step++) {
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") } });
    for (const line of r.headers.getSetCookie()) {
      const pair = line.split(";")[0].trim();
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get("location") ?? "";
      if (location.startsWith(redirect)) {
        const back = new URL(location).searchParams;
        code = back.get("code") ?? fail(`the authorization request came back with no code: ${back.get("error")} ${back.get("error_description")}`);
        break;
      }
      url = local(location);
      init = {};
      continue;
    }
    const page = await r.text();
    const prompt = /data-prompt="([a-z]+)"/.exec(page)?.[1];
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
    if (r.status !== 200 || (prompt !== "login" && prompt !== "consent") || !action) fail(`the sign-in stopped at ${url.pathname}: HTTP ${r.status} ${page.slice(0, 200).replace(/\s+/g, " ")}`);
    url = local(action!.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
    init = { method: "POST", body: new URLSearchParams(prompt === "login" ? { password } : {}), headers: { origin, "content-type": "application/x-www-form-urlencoded" } };
  }
  if (!code) fail("the sign-in and consent gave no code in 16 steps");
  const t = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: client_id!, resource: `${origin}/mcp` }) });
  const tokens = (await t.json()) as { refresh_token?: string; error?: string };
  if (t.status !== 200 || !tokens.refresh_token) fail(`the code answered ${t.status} ${tokens.error ?? ""}, ${tokens.refresh_token ? "with" : "without"} a refresh token`);
  // Refreshed once before it is held: the token printed is one the server has just taken, so its refusal after the revoke is the revoke's.
  const r = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: client_id!, resource: `${origin}/mcp` }) });
  const rotated = (await r.json()) as { refresh_token?: string; error?: string };
  if (r.status !== 200 || !rotated.refresh_token) fail(`the held grant's first refresh answered ${r.status} ${rotated.error ?? ""}: it was never a working grant`);
  console.log(JSON.stringify({ client_id, refresh_token: rotated.refresh_token, resource: `${origin}/mcp` }));
} else if (process.argv.includes("--refused")) {
  const { client_id, refresh_token, resource } = JSON.parse(await Bun.stdin.text()) as { client_id: string; refresh_token: string; resource: string };
  const r = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id, resource }) });
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (r.status !== 400 || body.error !== "invalid_grant") {
    console.error(`a refresh on the revoked grant answered ${r.status} ${body.error ?? ""}, not 400 invalid_grant`);
    process.exit(1);
  }
  console.log(`${client_id}: its refresh token is refused (invalid_grant), its grant revoked`);
} else if (process.argv.includes("--admin")) {
  const guiSecret = process.env.OB1_AUTH_SECRET_GUI ?? "";
  const mcpSecret = process.env.OB1_AUTH_SECRET_MCP ?? "";
  if (!guiSecret || !mcpSecret) {
    console.error("--admin needs OB1_AUTH_SECRET_GUI and OB1_AUTH_SECRET_MCP in its environment");
    process.exit(2);
  }
  const ADMIN = "http://127.0.0.1:3001";
  const basic = (id: string, secret: string) => `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
  const gui = basic("gui", guiSecret);
  const call = (path: string, init: RequestInit = {}) => fetch(`${ADMIN}${path}`, init).then(async (r) => ({ status: r.status, allow: r.headers.get("allow"), body: (await r.json().catch(() => null)) as { grants?: unknown[]; more?: boolean } | null }));
  const rows: [string, boolean][] = [];
  const none = await call("/grants");
  rows.push(["no credential is 401", none.status === 401]);
  rows.push(["the MCP service's own credentials are 401", (await call("/grants", { headers: { authorization: basic("mcp", mcpSecret) } })).status === 401]);
  rows.push(["the GUI's id with a wrong secret is 401", (await call("/grants", { headers: { authorization: basic("gui", `${guiSecret}x`) } })).status === 401]);
  rows.push(["no credential is 401 on any path, the route unread", (await call("/no-such-route")).status === 401 && (await call("/grants/x/revoke", { method: "POST" })).status === 401]);
  const listed = await call("/grants", { headers: { authorization: gui } });
  rows.push(["the GUI's credentials list the grants", listed.status === 200 && Array.isArray(listed.body?.grants) && typeof listed.body?.more === "boolean"]);
  const wrong = await call("/grants", { method: "POST", headers: { authorization: gui } });
  rows.push(["another method on the listing is 405, naming GET", wrong.status === 405 && wrong.allow === "GET"]);
  const byGet = await call("/grants/x/revoke", { headers: { authorization: gui } });
  rows.push(["a revoke by GET is 405, naming POST", byGet.status === 405 && byGet.allow === "POST"]);
  rows.push(["a revoke of no live grant is 404", (await call("/grants/no-such-grant/revoke", { method: "POST", headers: { authorization: gui } })).status === 404]);
  rows.push(["an unknown path is 404", (await call("/auth/token", { headers: { authorization: gui } })).status === 404]);
  const bad = rows.filter(([, ok]) => !ok).map(([name]) => name);
  if (bad.length) {
    console.error(`the admin listener: ${bad.join("; ")} — does not hold`);
    process.exit(1);
  }
  console.log(`the admin listener: ${rows.length} rules hold (${listed.body?.grants?.length} grant(s) listed)`);
} else if (process.argv.includes("--admin-lockout")) {
  const guiSecret = process.env.OB1_AUTH_SECRET_GUI ?? "";
  // The container's own address on its networks: a source no other mode uses, so its count starts at none.
  const own = Object.values((await import("node:os")).networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!guiSecret || !own) {
    console.error(`--admin-lockout needs OB1_AUTH_SECRET_GUI in its environment and an address of its own (${own ?? "none found"})`);
    process.exit(2);
  }
  const at = (secret: string) => fetch(`http://${own}:3001/grants`, { headers: { authorization: `Basic ${btoa(`gui:${encodeURIComponent(secret)}`)}` } }).then(async (r) => {
    await r.body?.cancel();
    return { status: r.status, retry: r.headers.get("retry-after") };
  });
  const refused: number[] = [];
  for (let i = 0; i < 20; i++) refused.push((await at(`${guiSecret}-wrong-${i}`)).status);
  const past = await at(`${guiSecret}-wrong`);
  const right = await at(guiSecret);
  const holds = refused.every((c) => c === 401) && past.status === 429 && Number(past.retry) > 0 && right.status === 429;
  if (!holds) {
    console.error(`the admin listener's failure limit from ${own}: 20 wrong secrets answered ${[...new Set(refused)].join("/")}, the 21st ${past.status} (Retry-After ${past.retry ?? "none"}), the right one after them ${right.status}: not 401 x20, then 429 for the address`);
    process.exit(1);
  }
  console.log(`the admin listener: 20 wrong secrets 401, the 21st turned away (429, Retry-After ${past.retry} s), the GUI's own credentials from that address too`);
} else {
  console.error("usage: bun restart-check.ts --register | --read | --session-cookie | --tokens <scope> | --gui-refresh | --hold-grant | --refused | --admin | --admin-lockout");
  process.exit(2);
}
