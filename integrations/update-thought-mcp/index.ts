// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: @supabase/supabase-js
// Revert with: node scripts/migrate-to-sql-shim.mjs --revert <file>
// ob1-fork (SMD-1228): a thought's content and vector are written through the
// functions that own them — update_thought for an edit, the 3-argument
// upsert_thought for a capture — so the fingerprint (003/018), the model label
// (021) and the chunk rows (022) follow the text and vector, and the actor
// reaches the audit (008). FORK.md change 69; extensions/test-writes.ts drives it
// against Postgres, and scripts/check-fork-consistency.mjs check 10 holds it.
// ob1-fork (SMD-1455): access keys go through ../_shared/auth.ts — the core server's
// server-portable/auth.ts, copied so Supabase bundles it with the function — named,
// scoped, hashed entries in MCP_ACCESS_KEYS (the older single MCP_ACCESS_KEY still
// works, compared by digest), and a read-scoped key is never given the tools
// that write. FORK.md change 67; extensions/test-auth.ts exercises it.
// ob1-fork (SMD-1497): the McpServer is built per request — one that outlived
// the request, connect()ed to a fresh transport each time, answered the first
// of two overlapping requests on the second's transport. FORK.md change 78;
// extensions/test-auth.ts fires three overlapping requests.
/**
 * update-thought-mcp — Standalone MCP Edge Function that adds a single tool:
 *   update_thought(id, content?, metadata_patch?, if_unchanged_since?)
 *
 * Why a separate Edge Function?
 *   The core `open-brain` MCP server (server/index.ts) is curated and does not
 *   expose an update path. This integration adds one without modifying the
 *   core server. Deploy it alongside your main MCP connector and register it
 *   as a separate custom connector in Claude Desktop (or your client of
 *   choice).
 *
 * Behavior:
 *   - `content` — when provided, overwrites the thought text and regenerates
 *     the embedding. Omit to leave content unchanged.
 *   - `metadata_patch` — shallow-merged into the existing metadata JSONB.
 *     Keys not present in the patch are left alone.
 *   - `if_unchanged_since` — optional ISO 8601 timestamp (with offset). When
 *     provided, the update is rejected with a STALE_READ error if the stored
 *     `updated_at` has advanced past that reference. Omit for last-write-wins
 *     behavior (backward compatible).
 *
 * Auth: named, scoped, hashed keys in MCP_ACCESS_KEYS through ../_shared/auth.ts
 * (the older single MCP_ACCESS_KEY still works, compared by digest), presented
 * as x-brain-key, x-access-key, ?key= or a bearer token — the core server's
 * path. update_thought writes, so a read-scoped key is given no tool at all
 * (SMD-1455, FORK.md change 67).
 *
 * Env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENROUTER_API_KEY        — only used when `content` is provided
 *   MCP_ACCESS_KEYS (or the older single MCP_ACCESS_KEY)
 */

import "../../compat/deno-on-bun.ts"; // ob1-original-types: jsr:@supabase/functions-js/edge-runtime.d.ts

// Deno reads the SDK's types through the extensionless subpath: its exports map
// names them `./dist/esm/*.d.ts`, unreachable from `.js` (FORK.md change 80).
// @ts-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-types="@modelcontextprotocol/sdk/types"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "../../compat/supabase-sql/index.ts";
import { authenticateRequest, canWrite, type Principal } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
// The label written beside every vector this function produces (021): the
// model name as OB1_EMBEDDING_MODEL spells it.
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

// --- MCP Server Setup ---

/** The tool surface for one principal: update_thought writes, so a read-scoped key is given no tool at all. */
function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "open-brain-update-thought",
    version: "1.0.0",
  });

  if (canWrite(principal)) server.registerTool(
    "update_thought",
    {
      title: "Update Thought",
      description:
        "Update an existing thought by ID. Provide `content` to overwrite the text and regenerate its embedding, `metadata_patch` to shallow-merge changes into the existing metadata, or both. Keys not mentioned in `metadata_patch` are left unchanged. Pass `if_unchanged_since` (ISO 8601 timestamp from your last read) for optimistic concurrency — the update is rejected with STALE_READ if another writer has touched the row since then.",
      inputSchema: {
        id: z.string().uuid().describe("UUID of the thought to update"),
        content: z
          .string()
          .min(1)
          .max(50_000)
          .optional()
          .describe("New text content — triggers re-embedding when provided"),
        metadata_patch: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Partial metadata to shallow-merge into the existing metadata JSONB. New keys are added; existing keys are overwritten; keys not mentioned are left alone.",
          ),
        if_unchanged_since: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "Optional ISO 8601 timestamp (with timezone). When provided, the update is rejected with STALE_READ if the stored updated_at has advanced past this reference. Pass the updated_at value from your most recent read to guard against lost-update conflicts. Omit to keep last-write-wins behavior.",
          ),
      },
    },
    async ({ id, content, metadata_patch, if_unchanged_since }) => {
      try {
        let embedding: number[] | null = null;
        if (content !== undefined) {
          if (!OPENROUTER_API_KEY) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "OPENROUTER_API_KEY is not set on this Edge Function; content updates cannot re-embed.",
                },
              ],
              isError: true,
            };
          }
          embedding = await getEmbedding(content);
        }

        if (content === undefined && metadata_patch === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No changes supplied; thought ${id} unchanged.`,
              },
            ],
          };
        }

        // One call, one statement. update_thought (db/migrations/033) locks the
        // row, decides `if_unchanged_since` against it as it is now — the check
        // this tool used to make from a read a moment earlier — writes the new
        // fingerprint with the text (003/018), the label with the vector (021),
        // replaces the chunk rows (022; none here, so none stay), shallow-merges
        // the patch into metadata as this tool always did, and refuses an edit
        // into another row's text as DUPLICATE_CONTENT rather than as a
        // constraint error. A raw update of `thoughts` left all four stale.
        const { data, error } = await supabase.rpc("update_thought", {
          p_id: id,
          p_content: content ?? null,
          p_metadata_patch: metadata_patch ?? null,
          p_embedding: embedding,
          p_if_unchanged_since: if_unchanged_since ?? null,
          p_embedding_model: embedding ? EMBEDDING_MODEL : null,
        });

        if (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `update_thought error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }

        const result = (data ?? {}) as Record<string, unknown>;
        if (result.ok !== true) {
          const reason = String(result.error ?? "unknown");
          const text =
            reason === "NOT_FOUND"
              ? `Thought not found: ${id}`
              : reason === "STALE_READ"
                ? `STALE_READ: thought has been modified since ${if_unchanged_since}. ` +
                  `Current updated_at: ${result.current_updated_at ?? "unknown (the row moved as this edit was written)"}. Re-fetch and retry.`
                : reason === "DUPLICATE_CONTENT"
                  ? `DUPLICATE_CONTENT: another thought already holds this exact text; edit that one, or delete it first.`
                  : `update_thought refused: ${reason}`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const parts = [
          `Updated thought ${id}`,
          content !== undefined ? "  · content replaced and re-embedded" : null,
          metadata_patch !== undefined ? "  · metadata merged" : null,
          `  · updated_at: ${result.updated_at}`,
          result.duplicate_of
            ? `  · note: thought ${result.duplicate_of} holds the same text (a twin, not refused — the text did not change)`
            : null,
          result.fingerprint_held_by
            ? `  · note: thought ${result.fingerprint_held_by} holds a stale fingerprint for this text; this row's stays unset until that is repaired`
            : null,
        ].filter(Boolean);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
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

  // One server per request, connected to this request's transport and dropped
  // with it — a read-scoped principal is handed a server on which the tool was
  // never registered. Not one per key scope (change 67's cache): a server that
  // outlives the request answers on the wrong transport — the header note
  // above, and FORK.md change 78 for the mechanism and the build cost (tens of
  // microseconds).
  const transport = new StreamableHTTPTransport();
  await buildServer(principal).connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
