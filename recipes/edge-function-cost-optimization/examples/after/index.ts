// ✅ Unified edge function with Mcp-Session-Id reuse.
//
// Key elements:
//  - One McpServer per session, built with the session's transport when the
//    session is minted (not per request — and not one per key scope shared
//    across sessions, which hangs every session but the last minted: a server
//    holds one transport; ob1-fork, SMD-1497, FORK.md change 77); the Supabase
//    client at module scope
//  - app.options("*") returns CORS preflights cheaply BEFORE auth
//  - Mcp-Session-Id header is minted on first request and reused on
//    subsequent ones, collapsing the 4-step MCP handshake
//  - Access-Control-Expose-Headers includes mcp-session-id so browser
//    clients (Claude Desktop, claude.ai) can read it off the response
//  - Access keys through ../_shared/auth.ts (examples/_shared/, the core
//    server's server-portable/auth.ts): named, scoped, hashed entries in
//    MCP_ACCESS_KEYS, and a read-scoped key is handed a server on which the
//    tools that write were never registered (ob1-fork, SMD-1455, FORK.md
//    change 67)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "./server.ts";
import { authenticateRequest, type Scope } from "../_shared/auth.ts";

// ── Session reuse ──────────────────────────────────────────────────────────
// A session remembers the scope it was minted under: a session id is not a
// credential, so a request under a key of another scope does not resume it.
// Each session owns its server as well as its transport: the two are bound one
// to one, and a server shared between sessions answers on the wrong transport.
type Session = { server: McpServer; transport: StreamableHTTPTransport; lastSeen: number; scope: Scope };
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000;

function pruneExpiredSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(id);
  }
}

// ── CORS ───────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, x-access-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Expose-Headers": "mcp-session-id", // ← critical for browser clients
};

const app = new Hono();

// Preflight returned BEFORE auth — Supabase doesn't bill OPTIONS, but
// unhandled OPTIONS cause client retries that DO bill.
app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  // Reject non-POST requests up front. This server is stateless over
  // streamable HTTP: there is no standalone SSE stream (GET) or session
  // termination (DELETE) to serve. Without this guard a GET falls through to
  // StreamableHTTPTransport.handleRequest, which parks it on an SSE stream
  // that never emits and never closes. mcp-remote always sends a GET probe
  // (OAuth discovery) before its initialize POST, so that probe hangs and
  // the MCP handshake times out at the client with no error server-side.
  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405, { ...corsHeaders, Allow: "POST, OPTIONS" });
  }

  // ✅ Named, scoped, hashed keys through the shared module: every presented
  // form tried, digests compared timing-safe, and the server this principal
  // gets is built for its session with its scope's tools (server.ts).
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"),
    MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),
  });
  if (!principal) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  pruneExpiredSessions();

  // Patch missing Accept header for Claude Desktop compatibility (PR #94).
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  // ── Session lookup or mint ───────────────────────────────────────────────
  const sid = c.req.header("mcp-session-id") || undefined;
  let session = sid ? sessions.get(sid) : undefined;
  if (session && session.scope !== principal.scope) session = undefined; // another scope's session: mint a new one
  let id = session ? sid : undefined;

  if (!session) {
    id = crypto.randomUUID();
    const transport = new StreamableHTTPTransport();
    const server = buildServer(principal); // one server AND one transport per session, bound once
    await server.connect(transport);
    session = { server, transport, lastSeen: Date.now(), scope: principal.scope };
    sessions.set(id, session);
  } else {
    session.lastSeen = Date.now();
  }

  c.header("Mcp-Session-Id", id!);
  for (const [k, v] of Object.entries(corsHeaders)) c.header(k, v);

  return session.transport.handleRequest(c);
});

Deno.serve(app.fetch);
