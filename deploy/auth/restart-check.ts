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
 * both on every restart. CI's full-stack job runs it (fork-checks.yml). Each
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
      url = local(r.headers.get("location") ?? "");
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
} else {
  console.error("usage: bun restart-check.ts --register | --read | --session-cookie");
  process.exit(2);
}
