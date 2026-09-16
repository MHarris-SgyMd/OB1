// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: @supabase/supabase-js
// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>
// ob1-fork (SMD-1455): access keys go through ../_shared/auth.ts — the core server's
// server-portable/auth.ts, copied so Supabase bundles it with the function — named,
// scoped, hashed entries in MCP_ACCESS_KEYS (the older single MCP_ACCESS_KEY still
// works, compared by digest), and a read-scoped key is never given the tools
// that write. FORK.md change 67; extensions/test-auth.ts exercises it.
/**
 * delete-thought-mcp — Standalone MCP Edge Function that adds a single tool:
 *   delete_thought(id)
 *
 * The core open-brain MCP server does not expose a delete path. This
 * integration adds one without modifying the core server — deploy alongside
 * your main MCP connector and register as a separate custom connector.
 *
 * Behavior:
 *   - Pre-flight fetch to confirm the thought exists (so the caller gets a
 *     clear "not found" instead of a silent success).
 *   - Hard delete — the row is gone once this returns. Recovery depends on
 *     your database backup strategy (see README).
 *
 * Auth: named, scoped, hashed keys in MCP_ACCESS_KEYS through ../_shared/auth.ts
 * (the older single MCP_ACCESS_KEY still works, compared by digest), presented
 * as x-brain-key, x-access-key, ?key= or a bearer token. delete_thought writes,
 * so a read-scoped key is given no tool at all (SMD-1455, FORK.md change 67).
 *
 * Env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MCP_ACCESS_KEYS (or the older single MCP_ACCESS_KEY)
 *
 * Extension hook:
 *   If you install the thought_audit schema (see `schemas/thought-audit`)
 *   you can extend this function to write an audit row before the delete
 *   so the prior content is preserved for recovery. Left out of the base
 *   integration to keep dependencies minimal.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "../../compat/supabase-sql/index.ts";
import { authenticateRequest, canWrite, type Principal } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- MCP Server Setup ---

/** The tool surface for one principal: delete_thought writes, so a read-scoped key is given no tool at all. */
function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "open-brain-delete-thought",
    version: "1.0.0",
  });

  if (canWrite(principal)) server.registerTool(
    "delete_thought",
    {
      title: "Delete Thought",
      description:
        "Permanently delete a thought by UUID. The row is hard-deleted — recovery depends on your database backups. Returns a confirmation including the prior content length so the caller can log what was removed.",
      inputSchema: {
        id: z.string().uuid().describe("UUID of the thought to delete"),
      },
    },
    async ({ id }) => {
      try {
        // Pre-flight fetch so "not found" is a clear, distinct outcome.
        const { data: existing, error: fetchError } = await supabase
          .from("thoughts")
          .select("id, content")
          .eq("id", id)
          .single();

        if (fetchError || !existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Thought not found: ${id}`,
              },
            ],
            isError: true,
          };
        }

        const { error } = await supabase.from("thoughts").delete().eq("id", id);

        if (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `delete_thought error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }

        const priorLength =
          typeof existing.content === "string" ? existing.content.length : 0;

        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted thought ${id} (prior content length: ${priorLength} chars).`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );

  if (!canWrite(principal)) {
    // No tool for this principal — but a tools capability with an empty list,
    // so a client sees a server with nothing to call, not a failed handshake.
    // (The SDK wires tools/list only when a tool is registered.)
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }

  return server;
}

// One server per key scope, built on first use — a read-scoped principal is
// handed a server on which the tool was never registered, and neither server
// is rebuilt per request.
const servers = new Map<boolean, McpServer>();
function serverFor(principal: Principal): McpServer {
  const write = canWrite(principal);
  let server = servers.get(write);
  if (!server) {
    server = buildServer(principal);
    servers.set(write, server);
  }
  return server;
}

// --- Hono app with auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, x-access-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

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

  // Named, scoped, hashed keys — the core server's auth path (_shared/auth.ts
  // is server-portable/auth.ts, held identical by extensions/test-auth.ts).
  // MCP_ACCESS_KEYS holds name:scope:sha256 entries; the older single
  // MCP_ACCESS_KEY still works, compared by digest. A read-scoped key is never
  // given the tool, so it cannot see it, let alone call it.
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"),
    MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),
  });
  if (!principal) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

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

  const transport = new StreamableHTTPTransport();
  await serverFor(principal).connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
