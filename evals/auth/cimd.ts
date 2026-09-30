/**
 * cimd.ts — a client's metadata-document host, and the bait beside it (SMD-2285).
 *
 * `bun cimd.ts host` serves client ID metadata documents over TLS as
 * `https://cimd.test/…`. It sits on the kit's `internet` network, whose subnet
 * is outside every special-use range, so the authorization server's fetch
 * guard lets it through on its own rules with no exception for the POC. Its
 * documents, each under a run name (`<kind>/<run>.json`, any name the verifier
 * picks), so every verify asks for URLs the server has never fetched or cached
 * (the library keeps a document for at least 30 s) and every log line and
 * refusal is that run's:
 * - `client/<run>.json`, a public native client, the shape the SDK v2 client
 *   and claude.ai present, with the URL as its `client_id`;
 * - `cc/<run>.json`, a client asking for client credentials with
 *   private_key_jwt, which the server's third-party rule must refuse;
 * - `redirect/<run>.json`, a 302 to the bait. The server must not follow it;
 * - `big/<run>.json`, a valid document padded past the library's 5 KiB limit.
 *
 * `bun cimd.ts bait` listens on the mesh as `bait.ob1.internal` and
 * `private-host.test`, and logs every TCP connection it is offered. The
 * verifier opens one control connection to it from the server's container,
 * then expects that line and no other: a guarded fetch refuses before
 * connecting.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { NATIVE_REDIRECT } from "./policy.ts";

const ORIGIN = "https://cimd.test";

/** A document path: its kind and the run it was asked for. */
export const RUN_DOC = /^\/(client|cc|redirect|big)\/([a-z0-9-]{1,40})\.json$/;

function client(path: string, extra: Record<string, unknown> = {}) {
  return {
    client_id: `${ORIGIN}${path}`,
    client_name: "Open Brain POC client (metadata document)",
    redirect_uris: [NATIVE_REDIRECT],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
    ...extra,
  };
}

const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

/** The answer for a path: a document, a redirect, or nothing. */
export function answer(path: string): Response {
  const kind = RUN_DOC.exec(path)?.[1];
  const doc = (body: unknown) => Response.json(body, { headers: { "cache-control": "max-age=30" } });
  if (kind === "client") return doc(client(path));
  if (kind === "big") return doc(client(path, { client_uri: `${ORIGIN}/`, padding: "x".repeat(6 * 1024) }));
  if (kind === "cc") {
    return doc(client(path, {
      grant_types: ["authorization_code", "client_credentials"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "ES256", use: "sig" }] },
    }));
  }
  if (kind === "redirect") return new Response(null, { status: 302, headers: { location: `https://bait.ob1.internal${path}` } });
  return new Response("not found", { status: 404 });
}

if (import.meta.main && process.argv[2] === "host") {
  Bun.serve({
    hostname: "0.0.0.0",
    port: 443,
    tls: { cert: readFileSync("/poc/cimd.pem", "utf8"), key: readFileSync("/poc/cimd.key", "utf8") },
    fetch(req) {
      const path = new URL(req.url).pathname;
      console.log(`cimd: GET ${path}`);
      return answer(path);
    },
  });
  console.log("cimd: https://cimd.test on :443");
}

if (import.meta.main && process.argv[2] === "bait") {
  for (const port of [80, 443]) {
    Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: {
        open(s) {
          console.log(`bait: connection from ${s.remoteAddress} on :${port}`);
          s.end();
        },
        data() {},
      },
    });
  }
  console.log("bait: ready on :80 and :443");
}
