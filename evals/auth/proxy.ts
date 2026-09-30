/**
 * proxy.ts — the POC's stand-in for the SMD-1846 reverse proxy (SMD-2285).
 *
 * Which proxy ships is SMD-1846's choice, so the POC does not make it. What
 * the authorization server needs from any proxy is this route table, a
 * preserved `Host` and the `X-Forwarded-*` headers. The table carries the ADR's
 * paths: the issuer's own `/auth`, the three discovery paths outside it
 * (decision 16 routes them only while the `auth` profile is configured), each
 * tier's MCP endpoint and protected-resource metadata, and the opt-in `/api`.
 * Anything else is a 404, so nothing reaches a service the table does not
 * name. This is the only container with a published port.
 */
import { INTERNAL, type Tier } from "./policy.ts";

const DISCOVERY = new Set(["/.well-known/oauth-authorization-server/auth", "/.well-known/openid-configuration/auth", "/.well-known/oauth-authorization-server"]);
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The upstream origin for a request path, or null for a 404. */
export function route(path: string): string | null {
  if (under(path, "/auth") || DISCOVERY.has(path)) return INTERNAL.auth;
  for (const tier of ["/canary", ""] as Tier[]) {
    if (path === `/.well-known/oauth-protected-resource${tier}/mcp` || path === `${tier}/mcp`) return INTERNAL.mcp(tier);
    if (under(path, `${tier}/api`)) return INTERNAL.api(tier);
  }
  return null;
}

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "accept-encoding", "content-length", "proxy-authorization", "te", "trailer"];

if (import.meta.main) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: 8000,
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const upstream = route(url.pathname);
      if (!upstream) return new Response("not found", { status: 404 });
      const headers = new Headers(req.headers);
      for (const h of HOP) headers.delete(h);
      const host = req.headers.get("host") ?? url.host;
      headers.set("host", host);
      headers.set("x-forwarded-host", host);
      headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
      headers.set("x-forwarded-for", server.requestIP(req)?.address ?? "");
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const r = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual",
        // @ts-expect-error Bun's fetch takes a streamed request body with duplex
        duplex: "half",
      }).catch((e: Error) => new Response(`proxy: upstream unreachable: ${e.message}`, { status: 502 }));
      const out = new Headers(r.headers);
      for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(h);
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
    },
  });
  console.log("proxy: 0.0.0.0:8000");
}
