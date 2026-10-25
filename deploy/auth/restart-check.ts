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
 * prints both as JSON `{ mcp, api }`, for CI to present to the REST core.
 *
 *   compose exec -T -e OB1_AUTH_OPERATOR_PASSWORD auth bun restart-check.ts --gui-refresh
 *
 * `--gui-refresh` (SMD-3307) signs the operator in as the operator GUI does —
 * the confidential `gui` client (its secret from the container's environment),
 * S256, `offline_access` with `prompt=login consent`, for the REST core — and checks
 * what the GUI's session leans on: the code gives a refresh token, a refresh
 * gives a new pair (the refresh token rotated), and the refresh token revoked
 * as the GUI's sign-out revokes it is refused at the next refresh. It prints
 * one line saying so, or why not, and no token.
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
  console.log(JSON.stringify({ mcp: mcp.body.access_token, api: api.body.access_token }));
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
    prompt: "login consent",
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
  const asGui = (path: string, body: Record<string, string>) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`gui:${guiSecret}`)}` }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, string> }));
  const first = await asGui("/token", { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, resource });
  if (first.status !== 200 || !first.body.access_token || !first.body.refresh_token) fail(`the code answered ${first.status} ${first.body.error ?? ""}, ${first.body.refresh_token ? "with" : "without"} a refresh token`);
  const second = await asGui("/token", { grant_type: "refresh_token", refresh_token: first.body.refresh_token, resource });
  if (second.status !== 200 || !second.body.access_token || !second.body.refresh_token) fail(`the refresh answered ${second.status} ${second.body.error ?? ""}`);
  if (second.body.refresh_token === first.body.refresh_token || second.body.access_token === first.body.access_token) fail("the refresh handed back the same tokens: it did not rotate");
  const revoked = await fetch(`${BASE}/token/revocation`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`gui:${guiSecret}`)}` }, body: new URLSearchParams({ token: second.body.refresh_token, token_type_hint: "refresh_token" }) });
  if (revoked.status !== 200) fail(`the revocation answered ${revoked.status}`);
  const after = await asGui("/token", { grant_type: "refresh_token", refresh_token: second.body.refresh_token, resource });
  if (after.status !== 400 || after.body.error !== "invalid_grant") fail(`a refresh with the revoked token answered ${after.status} ${after.body.error ?? ""}, not 400 invalid_grant`);
  console.log("gui: the code gave a refresh token, the refresh rotated it, and once revoked it is refused");
} else {
  console.error("usage: bun restart-check.ts --register | --read | --session-cookie | --tokens <scope> | --gui-refresh");
  process.exit(2);
}
