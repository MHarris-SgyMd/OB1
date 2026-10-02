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
 */
export {};

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
} else {
  console.error("usage: bun restart-check.ts --register | --read");
  process.exit(2);
}
