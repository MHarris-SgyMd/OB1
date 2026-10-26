/**
 * admin.ts — the authorization server's admin listener, which the operator
 * GUI's page of grants reads and revokes through (SMD-3307 PR 3; ADR decision
 * 15's revocation page). server.ts serves it on its own port, ADMIN_PORT, on
 * the `auth` service's networks: the `mesh`, where the GUI reaches it, and
 * `auth-egress`, which holds the authorization server alone. No proxy rule
 * routes to it (check 28 of scripts/check-fork-consistency.ts holds every
 * route table and who joins each network) and no host port publishes it. On a
 * Linux engine a process on the host can still reach the container's bridge
 * address, as it can port 3000's; the credential below is what guards it
 * (review pass 1).
 *
 * Every request presents the GUI client's credentials as HTTP Basic (the
 * client id and secret form-urlencoded, as RFC 6749 §2.3.1 has them for the
 * token endpoint): a `gui` client's id, and its secret from deploy/.env,
 * compared in constant time. Any other credential, another client's own
 * included, or none, is 401 before the path is read, so a caller without it
 * learns nothing of the routes. server.ts counts every failure against the
 * socket's address, 20 in 15 minutes (the token endpoint's numbers), and
 * answers that address 429 for the rest of the window.
 *
 * The routes:
 * - `GET /grants`: the live grants, newest first and bounded (store.ts
 *   `grants()`), as JSON `{ grants, more }`;
 * - `POST /grants/<id>/revoke`: the grant revoked whole (store.ts
 *   `dropGrant()`): its refresh tokens are refused from then on. An access
 *   token already issued is a JWT the REST core checks on its own, so the
 *   client's next call is refused once it lapses, within the access-token
 *   lifetime (600 s; the maintainer's choice of 2026-10-26). 204, or 404 when
 *   no live grant has that id.
 *
 *   bun deploy/auth/admin.ts --self-check   # the routes and the credential rule (CI)
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The admin listener's port in the `auth` container: on the mesh, routed by no proxy rule. */
export const ADMIN_PORT = 3001;

/** A grant id as the library makes one (nanoid's alphabet), bounded: anything else in the path is no route. */
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** What a request on the admin listener asks: the listing, a revocation, a route with another method, or nothing. */
export type AdminRoute = { kind: "list" } | { kind: "revoke"; id: string } | { kind: "method"; allow: string } | { kind: "none" };

/** The route a method and path name (the path as target.ts reads it: never decoded). */
export function adminRoute(method: string, path: string): AdminRoute {
  if (path === "/grants") return method === "GET" ? { kind: "list" } : { kind: "method", allow: "GET" };
  const revoke = /^\/grants\/([^/]+)\/revoke$/.exec(path);
  if (!revoke || !GRANT_ID.test(revoke[1])) return { kind: "none" };
  return method === "POST" ? { kind: "revoke", id: revoke[1] } : { kind: "method", allow: "POST" };
}

/** HTTP Basic credentials, each half form-urlencoded (RFC 6749 §2.3.1); null for any other header. */
export function basicCredentials(authorization: string | undefined): { id: string; secret: string } | null {
  const m = /^basic +([A-Za-z0-9+/]+={0,2}) *$/i.exec(authorization ?? "");
  if (!m) return null;
  const raw = Buffer.from(m[1], "base64").toString();
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  const decoded = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return null;
    }
  };
  const id = decoded(raw.slice(0, colon));
  const secret = decoded(raw.slice(colon + 1));
  return id === null || secret === null ? null : { id, secret };
}

/**
 * Whether the credentials are a GUI client's: its id one of `secrets`' own
 * keys (server.ts passes the `gui` clients' alone) and the secret that
 * client's, compared in constant time over their digests, so neither the
 * secret's bytes nor its length show in the time taken. A client with no
 * secret configured matches nothing.
 */
export function isGuiClient(creds: { id: string; secret: string } | null, secrets: Record<string, string | undefined>): boolean {
  if (!creds || !Object.hasOwn(secrets, creds.id)) return false;
  const want = secrets[creds.id];
  if (!want) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(creds.secret), digest(want));
}

/** The rules above, each a named probe. */
function selfCheck(): number {
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
  const secrets = { gui: "s3cret:with+symbols and space" };
  const cases: [string, boolean][] = [
    ["GET /grants lists", adminRoute("GET", "/grants").kind === "list"],
    ["POST /grants/<id>/revoke revokes that id", JSON.stringify(adminRoute("POST", "/grants/AbC_9-x/revoke")) === JSON.stringify({ kind: "revoke", id: "AbC_9-x" })],
    ["another method on a route is 405, naming the one it takes", JSON.stringify(adminRoute("DELETE", "/grants")) === JSON.stringify({ kind: "method", allow: "GET" }) && JSON.stringify(adminRoute("GET", "/grants/g1/revoke")) === JSON.stringify({ kind: "method", allow: "POST" })],
    ["a path of another shape is no route: a trailing slash on either route, an encoded or empty id, more segments, the bare root", ["/grants/", "/grants/g1/revoke/", "/grants/a%2Fb/revoke", "/grants//revoke", "/grants/g1/revoke/x", "/", "/Grants"].every((p) => adminRoute("POST", p).kind === "none" && adminRoute("GET", p).kind === "none")],
    ["an id past 128 characters is no route", adminRoute("POST", `/grants/${"a".repeat(129)}/revoke`).kind === "none" && adminRoute("POST", `/grants/${"a".repeat(128)}/revoke`).kind === "revoke"],
    ["Basic credentials are read form-urlencoded, a colon and a plus in the secret kept", JSON.stringify(basicCredentials(basic("gui", "s3cret:with+symbols and space"))) === JSON.stringify({ id: "gui", secret: "s3cret:with+symbols and space" })],
    ["a space sent as `+`, as the GUI's own Basic sends it (oauth.ts basic), is a space", basicCredentials(`Basic ${Buffer.from("gui:s3cret%3Awith%2Bsymbols+and+space").toString("base64")}`)?.secret === "s3cret:with+symbols and space"],
    ["the scheme in any case, and nothing else read as Basic", basicCredentials(basic("gui", "x")!.replace("Basic", "bAsIc")) !== null && basicCredentials(undefined) === null && basicCredentials("Bearer abc") === null && basicCredentials("Basic") === null && basicCredentials("Basic !!!") === null],
    ["a credential with no colon, or a half that will not decode, is none", basicCredentials(`Basic ${Buffer.from("gui").toString("base64")}`) === null && basicCredentials(`Basic ${Buffer.from("gui:%E0%A4%A").toString("base64")}`) === null],
    ["the GUI client's id and secret are the GUI's", isGuiClient(basicCredentials(basic("gui", "s3cret:with+symbols and space")), secrets)],
    ["a wrong secret, a prefix of it, or an empty one is not", !isGuiClient({ id: "gui", secret: "s3cret" }, secrets) && !isGuiClient({ id: "gui", secret: "" }, secrets) && !isGuiClient({ id: "gui", secret: "s3cret:with+symbols and spaceX" }, secrets)],
    ["another client with its own secret is not: only the ids handed in count", !isGuiClient({ id: "mcp", secret: "m" }, secrets) && !isGuiClient({ id: "__proto__", secret: "" }, secrets) && !isGuiClient({ id: "constructor", secret: "x" }, secrets)],
    ["a GUI client with no secret configured matches nothing, an empty secret included", !isGuiClient({ id: "gui", secret: "" }, { gui: undefined }) && !isGuiClient({ id: "gui", secret: "" }, { gui: "" })],
    ["no credential is not", !isGuiClient(null, secrets)],
  ];
  for (const [name, ok] of cases) console.log((ok ? "ok   " : "FAIL ") + name);
  const failed = cases.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} probe(s) failed` : "\nall probes hold");
  return failed ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(selfCheck());
