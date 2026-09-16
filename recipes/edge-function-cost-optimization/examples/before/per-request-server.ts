// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: @supabase/supabase-js
// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>
// ob1-fork (SMD-1455): the access key goes through ../_shared/auth.ts (examples/_shared/,
// the core server's server-portable/auth.ts) — FORK.md change 67. The anti-pattern this file
// teaches is the per-request construction below, not the key compare it used to carry.
// ❌ ANTI-PATTERN — McpServer reconstructed on every HTTP request.
//
// Every tool call by Claude triggers ~4 HTTP requests (initialize +
// notifications/initialized + tools/list + tools/call). With this pattern,
// each request rebuilds the McpServer, re-registers all tools, and creates a
// new Supabase client. Multiplied across multiple connectors and the MCP
// handshake fan-out, this drives invocation counts (and per-request CPU)
// orders of magnitude higher than necessary.

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "../../../../compat/supabase-sql/index.ts";
import { authenticateRequest } from "../_shared/auth.ts";

const app = new Hono();

app.post("*", async (c) => {
  // Auth check — named, scoped, hashed keys through the shared module; the one
  // tool here reads, so there is nothing to withhold from a read-scoped key.
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: Deno.env.get("MCP_ACCESS_KEYS"),
    MCP_ACCESS_KEY: Deno.env.get("MCP_ACCESS_KEY"),
  });
  if (!principal) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // ❌ New Supabase client per request
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ❌ New McpServer per request — rebuilds zod schemas, re-registers tools
  const server = new McpServer({ name: "household-knowledge", version: "1.0.0" });

  server.tool(
    "list_vendors",
    "List service providers, optionally filtered by service type",
    { service_type: z.string().optional() },
    async ({ service_type }) => {
      const { data } = await supabase
        .from("household_vendors")
        .select("*")
        .eq("user_id", Deno.env.get("DEFAULT_USER_ID")!)
        .ilike("service_type", `%${service_type ?? ""}%`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  // ❌ New transport per request, no session reuse
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// ❌ No OPTIONS handler — preflight 404s, clients retry, retries are billed.

Deno.serve(app.fetch);
