/**
 * Open Brain MCP Server - Kubernetes Self-Hosted Version
 *
 * This is a modified version of the OB1 server that connects directly to
 * PostgreSQL + pgvector instead of Supabase. All MCP tools and the Hono
 * HTTP layer are preserved; only the data access layer is changed.
 *
 * Environment variables:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - PostgreSQL connection
 *   EMBEDDING_API_BASE - Base URL for OpenAI-compatible embedding API
 *   EMBEDDING_API_KEY - API key for the embedding service
 *   EMBEDDING_MODEL - Model name for embeddings (default: text-embedding-3-small)
 *   CHAT_API_BASE - Base URL for OpenAI-compatible chat API (defaults to EMBEDDING_API_BASE)
 *   CHAT_API_KEY - API key for chat service (defaults to EMBEDDING_API_KEY)
 *   CHAT_MODEL - Model name for metadata extraction (default: gpt-4o-mini)
 *   OB1_LLM_TIMEOUT - seconds each embedding or chat call may take (default 120, the core server's)
 *   MCP_ACCESS_KEYS - name:scope:sha256 access keys (the older single MCP_ACCESS_KEY still works);
 *                     capture_thought is registered only for a write-scoped key
 *   OPEN_BRAIN_CITATION_BASE_URL - Optional base URL for search/fetch citation links
 *   PORT - the port the export at the tail listens on (default 8000; the image and k8s/openbrain.yml leave it)
 *   OB1_STOP_GRACE - the pod's terminationGracePeriodSeconds, whole seconds (default 10, Docker's; k8s/openbrain.yml sets 30); a stop drains for 2 s less
 */

// ob1-fork (SMD-1455): access keys go through ../_shared/auth.ts — the core server's
// server-portable/auth.ts, copied so the Docker build has it in its context — named,
// scoped, hashed entries in MCP_ACCESS_KEYS (the older single MCP_ACCESS_KEY still
// works, compared by digest), and a read-scoped key is never given the tools
// that write. FORK.md change 67; extensions/test-auth.ts exercises it.
// The import is this file's first from outside its own directory (see the Dockerfile).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { SQL } from "bun";
import { authenticateRequest, canWrite, type Principal } from "../_shared/auth.ts";
import { mcpReply } from "../_shared/sse.ts";

// ob1-fork (SMD-1524): capture_thought writes `thoughts` with a raw INSERT, by design —
// this deployment's Postgres is its own, built by k8s/init.sql from the guide's shape,
// and this fork's upsert_thought is not in it. The row carries no content fingerprint,
// no model label and no audit actor; the README says so. Listed in
// scripts/check-fork-consistency.ts check 10's exceptions (FORK.md change 71).

// --- Configuration ---

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = parseInt(process.env.DB_PORT || "5432", 10);
const DB_NAME = process.env.DB_NAME || "openbrain";
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD!;

const EMBEDDING_API_BASE = process.env.EMBEDDING_API_BASE || "https://openrouter.ai/api/v1";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || process.env.OPENROUTER_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";

const CHAT_API_BASE = process.env.CHAT_API_BASE || EMBEDDING_API_BASE;
const CHAT_API_KEY = process.env.CHAT_API_KEY || EMBEDDING_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || "openai/gpt-4o-mini";

// --- PostgreSQL Connection Pool ---

// Bun's own Postgres client (SMD-1800; the Deno driver from deno.land/x went with
// the Deno image): a pool of up to 20 connections, opened on the first query, so
// importing this module — as extensions/test-auth.ts does — dials nothing.
const sql = new SQL({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  username: DB_USER,
  password: DB_PASSWORD,
  max: 20,
});

/**
 * One statement with positional parameters, its rows. Not named `query`: two
 * tools take an argument of that name, which would shadow it in their handlers.
 */
async function pgQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await sql.unsafe(text, params)) as unknown as T[];
}

type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: Date;
};

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

const CITATION_BASE_URL =
  process.env.OPEN_BRAIN_CITATION_BASE_URL || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: Date): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

// --- Embedding & Metadata Extraction ---

/** server-portable/embed.ts's, held equal by extensions/test-auth.ts. */
const DEFAULT_LLM_TIMEOUT_S = 120;
/** OB1_LLM_TIMEOUT's seconds if it is a finite positive number (embed.ts's rule), else undefined. */
function llmTimeoutOf(text: string | undefined): number | undefined {
  const n = text ? Number(text) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
// Read per call below; a value it cannot use is said once here, as OB1_STOP_GRACE's is (review passes 4 and 5).
const llmTimeoutText = process.env.OB1_LLM_TIMEOUT?.trim() ?? "";
if (llmTimeoutText && llmTimeoutOf(llmTimeoutText) === undefined) console.warn(`OB1_LLM_TIMEOUT="${llmTimeoutText}" is not a positive number of seconds, with no unit; provider calls are given ${DEFAULT_LLM_TIMEOUT_S} s (SMD-2692)`);

/** A provider answer's body: empty if it fails to arrive, unless the deadline passed during it (embed.ts providerCall). */
function bodyOf(r: Response): Promise<string> {
  return r.text().catch((e: Error) => { if (e.name === "TimeoutError") throw e; return ""; });
}

/** A provider call that ran past OB1_LLM_TIMEOUT, its message naming the knob. */
class ProviderTimeout extends Error {}

/**
 * A provider call under the core server's deadline (SMD-2692): OB1_LLM_TIMEOUT
 * seconds, DEFAULT_LLM_TIMEOUT_S unless set to a positive number (embed.ts's
 * rule), over the answer's headers and body both. Until then Bun's own 300 s
 * fetch cut was the only bound, and since SMD-2001 keeps the reply alive a
 * client sat through all of it. Read per call, as the keys are.
 */
async function withDeadline<T>(what: string, base: string, call: (deadline: { signal: AbortSignal; timeout: false }) => Promise<T>): Promise<T> {
  const seconds = llmTimeoutOf(process.env.OB1_LLM_TIMEOUT) ?? DEFAULT_LLM_TIMEOUT_S;
  try {
    // `timeout: false` makes this the one deadline: Bun's fetch would otherwise
    // cut the call at its 300 s idle timeout, so a longer value never applied (embed.ts).
    return await call({ signal: AbortSignal.timeout(seconds * 1000), timeout: false });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new ProviderTimeout(`${what} request to ${base} timed out after ${seconds} s (OB1_LLM_TIMEOUT)`);
    throw e;
  }
}

async function getEmbedding(text: string): Promise<number[]> {
  return withDeadline("Embeddings", EMBEDDING_API_BASE, async (deadline) => {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EMBEDDING_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
      }),
      ...deadline,
    });
    // Read as the chat call's below, and an error body capped (review pass 3).
    const body = await bodyOf(r);
    if (!r.ok) throw new Error(`Embeddings request to ${EMBEDDING_API_BASE} failed: ${r.status} ${body.slice(0, 500)}`);
    let d: { data?: [{ embedding?: unknown }] } | null;
    try {
      d = JSON.parse(body);
    } catch {
      throw new Error(`Embeddings request to ${EMBEDDING_API_BASE} answered a body that is not JSON`);
    }
    const embedding = d?.data?.[0]?.embedding;
    // A vector of numbers, or Postgres refuses it later with a cast error that names no provider (review pass 4).
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error(`Embeddings request to ${EMBEDDING_API_BASE} answered no embedding`);
    return embedding as number[];
  });
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  // The capture goes on without its tags when the chat call times out,
  // answers a status outside 2xx, or answers with no usable tags, the embedding
  // being what it needs: logged, and recorded on the thought in the core
  // server's reasons (server-portable/metadata.ts). A deadline that failed the
  // capture instead would lose one that a model slower than it had always
  // completed (review pass 1). A chat endpoint that cannot be reached at all
  // still fails the capture, as on the core server.
  const fallback = (reason: string, why: string): Record<string, unknown> => {
    console.error(`extractMetadata: ${why}`);
    return { topics: ["uncategorized"], type: "observation", metadata_extraction_failed: reason };
  };
  let answer: { ok: boolean; status: number; text: string };
  try {
    answer = await withDeadline("Chat completion", CHAT_API_BASE, async (deadline) => {
      const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CHAT_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
            },
            { role: "user", content: text },
          ],
        }),
        ...deadline,
      });
      return { ok: r.ok, status: r.status, text: await bodyOf(r) };
    });
  } catch (e) {
    if (e instanceof ProviderTimeout) return fallback("provider_timeout", e.message);
    throw e;
  }
  if (!answer.ok) return fallback(`provider_${answer.status}`, `Chat completion request to ${CHAT_API_BASE} failed: ${answer.status} ${answer.text.slice(0, 500)}`);
  let d: { choices?: [{ message?: { content?: unknown } }] } | null;
  try {
    d = JSON.parse(answer.text);
  } catch {
    return fallback("invalid_response_body", `Chat completion request to ${CHAT_API_BASE} answered a body that is not JSON`);
  }
  const content = d?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return fallback("no_message_content", "provider response had no message content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return fallback("unparseable_model_output", "model content was not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback("unexpected_json_shape", "model returned JSON that is not an object");
  // The marker is the server's to set, never the model's: the confirmation prints it (review pass 2).
  const { metadata_extraction_failed: _, ...tags } = parsed as Record<string, unknown>;
  return tags;
}

// --- MCP Server Setup ---

function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "1.0.0",
  });

  // ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
  // research look for exact read-only `search` and `fetch` tool shapes.
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("The search query to run against Open Brain thoughts"),
      },
    },
    async ({ query }) => {
      try {
        const qEmb = await getEmbedding(query);
        const embStr = `[${qEmb.join(",")}]`;

        const rows = await pgQuery<ThoughtMatch>(
          `SELECT id, content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [embStr, 0.5, 10]
        );

        const results = rows.map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Open Brain Thought",
      description:
        "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        id: z.string().describe("The Open Brain thought ID returned by the search tool"),
      },
    },
    async ({ id }) => {
      try {
        const rows = await pgQuery<ThoughtRecord>(
          `SELECT id, content, metadata, created_at
           FROM thoughts
           WHERE id = $1
           LIMIT 1`,
          [id]
        );

        const thought = rows[0];
        if (!thought) {
          return {
            content: [{ type: "text" as const, text: `No thought found for ID ${id}.` }],
            isError: true,
          };
        }

        const document = {
          id: thought.id,
          title: thoughtTitle(thought.content, thought.created_at),
          text: thought.content,
          url: thoughtUrl(thought.id),
          metadata: {
            ...thought.metadata,
            created_at: thought.created_at,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(document) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 1: Semantic Search (replaces supabase.rpc with raw SQL)
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const qEmb = await getEmbedding(query);
        const embStr = `[${qEmb.join(",")}]`;

        const rows = await pgQuery<ThoughtMatch>(
          `SELECT id, content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [embStr, threshold, limit]
        );

        if (!rows.length) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        const results = rows.map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${rows.length} thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: List Recent (replaces supabase query builder with raw SQL)
  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "List recently captured thoughts with optional filters by type, topic, person, or time range.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().optional().describe("Only thoughts from the last N days"),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (type) {
          conditions.push(`metadata->>'type' = $${paramIdx}`);
          params.push(type);
          paramIdx++;
        }
        if (topic) {
          conditions.push(`metadata->'topics' ? $${paramIdx}`);
          params.push(topic);
          paramIdx++;
        }
        if (person) {
          conditions.push(`metadata->'people' ? $${paramIdx}`);
          params.push(person);
          paramIdx++;
        }
        if (days) {
          conditions.push(`created_at >= NOW() - INTERVAL '${days} days'`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const rows = await pgQuery<{
          content: string;
          metadata: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT content, metadata, created_at
           FROM thoughts
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${paramIdx}`,
          [...params, limit]
        );

        if (!rows.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        const results = rows.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${rows.length} recent thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Stats (replaces supabase queries with raw SQL)
  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const countRows = await pgQuery<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM thoughts"
        );

        const data = await pgQuery<{
          metadata: Record<string, unknown>;
          created_at: Date;
        }>(
          "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC"
        );

        const count = countRows[0]?.count || 0;

        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        for (const r of data) {
          const m = r.metadata || {};
          if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
          if (Array.isArray(m.topics))
            for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
          if (Array.isArray(m.people))
            for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            data.length
              ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
                " -> " +
                new Date(data[0].created_at).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 4: Capture Thought (replaces supabase insert with raw SQL)
  if (canWrite(principal)) server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        content: z.string().describe("The thought to capture"),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const embStr = `[${embedding.join(",")}]`;
        const meta: Record<string, unknown> = { ...metadata, source: "mcp" };

        await pgQuery(
          `INSERT INTO thoughts (content, embedding, metadata)
           VALUES ($1, $2::vector, $3::jsonb)`,
          [content, embStr, meta]
        );

        let confirmation = `Captured as ${meta.type || "thought"}`;
        if (Array.isArray(meta.topics) && meta.topics.length)
          confirmation += ` -- ${(meta.topics as string[]).join(", ")}`;
        if (Array.isArray(meta.people) && meta.people.length)
          confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
        if (Array.isArray(meta.action_items) && meta.action_items.length)
          confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
        if (meta.metadata_extraction_failed)
          confirmation += ` | Tags not extracted: ${meta.metadata_extraction_failed}`;

        return {
          content: [{ type: "text" as const, text: confirmation }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- Hono App with Auth Check ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-brain-key, x-access-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
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
  // given the tool that writes, so it cannot see it, let alone call it.
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: process.env.MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: process.env.MCP_ACCESS_KEY,
  });
  if (!principal) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  const server = buildServer(principal);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  // The reply kept alive while the tool runs, and a client that leaves logged (SMD-2001, _shared/sse.ts).
  const response = await mcpReply(c, () => transport.handleRequest(c));
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

// ob1-fork (SMD-2250): stopping on SIGTERM. The image runs this as the container's PID 1,
// where the kernel gives SIGTERM no default action, so until this handler every rollout and
// pod deletion waited out terminationGracePeriodSeconds (30 s) and ended in SIGKILL, with
// requests cut off. server-portable/shutdown.ts is the core server's handler and says more;
// this is it cut to what this server has. Bun hands the server it serves from the export
// below to no one but the fetch handler, so the first request passes it on; before that
// nothing can be in flight. Only as the entry: extensions/test-auth.ts imports the module.
// The pod's grace period less 2 s for the pool's close and the exit, read as the core server
// reads OB1_STOP_GRACE (server-portable/shutdown.ts drainBoundFrom): whole seconds from 1 to
// 3600, 10 unless set, anything else said and read as 10. k8s/openbrain.yml sets it to 30
// beside terminationGracePeriodSeconds.
const graceText = process.env.OB1_STOP_GRACE?.trim() ?? "";
const graceValid = /^\d+$/.test(graceText) && Number(graceText) >= 1 && Number(graceText) <= 3_600;
if (graceText && !graceValid) console.warn(`OB1_STOP_GRACE="${graceText}" is not a whole number of seconds from 1 to 3600, with no unit; the stop drains as for 10 s (SMD-2250)`);
const DRAIN_BOUND_MS = Math.max(500, (graceValid ? Number(graceText) : 10) * 1000 - 2_000);
let bunServer: { stop(closeActiveConnections?: boolean): Promise<void>; readonly pendingRequests: number } | undefined;
if (import.meta.main) {
  let stopping = false;
  let drained = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (stopping) process.exit(drained ? 0 : 1); // a second signal: not waiting for the rest, 0 once everything was answered
      stopping = true;
      const t0 = performance.now();
      console.log(`${signal}: no longer accepting; ${bunServer?.pendingRequests ?? 0} in flight, waited on for up to ${DRAIN_BOUND_MS / 1000} s (SMD-2250)`);
      // A stop() that rejects has stopped accepting all the same (review pass 3).
      drained = await Promise.race([bunServer ? bunServer.stop().then(() => true, () => true) : true, Bun.sleep(DRAIN_BOUND_MS).then(() => false)]);
      // 250 ms after a cut, as the core's CLOSE_AFTER_CUT_MS: the cut calls' queries hold close() (review pass 4).
      await Promise.race([sql.close().catch(() => {}), Bun.sleep(drained ? 1_000 : 250)]);
      console.log(`${signal}: stopped in ${((performance.now() - t0) / 1000).toFixed(1)} s${drained ? "" : `, ${bunServer?.pendingRequests} cut off at the bound`}; exit ${drained ? 0 : 1}`);
      process.exit(drained ? 0 : 1);
    });
  }
}

// Bun's entry shape, the core server's (SMD-1799): `bun index.ts` serves it on PORT, default 8000 —
// what the image runs (SMD-1800), so k8s/openbrain.yml names no PORT.
export default {
  port: Number(process.env.PORT || 8000),
  fetch: (...args: Parameters<typeof app.fetch>) => {
    if (!bunServer && typeof (args[1] as typeof bunServer)?.stop === "function") bunServer = args[1] as typeof bunServer;
    return app.fetch(...args);
  },
};
