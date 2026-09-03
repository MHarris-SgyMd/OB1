
import { chunkContent, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS } from "./chunk.ts";
import {
  EMBEDDING_PROMPTS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIM,
  resolveEmbeddingDimensions,
} from "../db/config.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, type ThoughtStore } from "./store.ts";
import { authenticate, canWrite, type Principal } from "./auth.ts";

/**
 * Runtime-portable env access.
 *
 * Workers has no module scope for secrets — bindings arrive on the request
 * context, so nothing can be read at import time. Deno, Bun and Node all expose
 * globals instead. Reading through this shim (seeded by the first middleware)
 * lets one file run on all four.
 */
type Env = {
  OPENROUTER_API_KEY: string;
  /** Named, scoped, hashed keys: `name:scope:sha256` entries. Preferred. */
  MCP_ACCESS_KEYS?: string;
  /** Legacy single raw key — full write access. See auth.ts. */
  MCP_ACCESS_KEY?: string;
  /** Which data layer to use: "postgrest" (default) or "sql". */
  OB1_STORE?: string;
  /** Required when OB1_STORE=postgrest. */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Required when OB1_STORE=sql. */
  DATABASE_URL?: string;
  /** Must match the width of thoughts.embedding — see db/config.mjs. */
  OB1_EMBEDDING_DIM?: string;
  OB1_EMBEDDING_MODEL?: string;
  /**
   * "on" to send the OpenAI `dimensions` parameter, asking the provider to return
   * OB1_EMBEDDING_DIM numbers instead of the model's native width. Off by default;
   * only safe for models trained for Matryoshka truncation.
   */
  OB1_EMBEDDING_DIMENSIONS?: string;
  /**
   * Chunking for captures too long to embed in one provider call. Tokens per
   * window and overlap between windows; see chunk.ts. Defaults suit Ollama's
   * 2048-token batch.
   */
  OB1_CHUNK_TOKENS?: string;
  OB1_CHUNK_OVERLAP?: string;
  /** Model for metadata extraction. No schema dependency — safe to change anytime. */
  OB1_METADATA_MODEL?: string;
  /** Sampling temperature for extraction. Defaults to 0 — see metadataTemperature. */
  OB1_METADATA_TEMPERATURE?: string;
  /** "on" to let a thinking model reason; anything else disables it. Default off. */
  OB1_METADATA_REASONING?: string;
  /** Any OpenAI-compatible base URL. Point it at Ollama for a fully local brain. */
  OB1_LLM_BASE_URL?: string;
  /** Preferred over OPENROUTER_API_KEY. Not needed for a loopback endpoint. */
  OB1_LLM_API_KEY?: string;
  OPEN_BRAIN_CITATION_BASE_URL?: string;
};

let ENV: Env | null = null;

function initEnv(bindings?: Record<string, unknown>): void {
  if (ENV) return;
  const globals = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};
  ENV = { ...globals, ...(bindings ?? {}) } as Env;
}

function env(): Env {
  if (!ENV) throw new Error("env accessed before initEnv() — is the seeding middleware registered?");
  return ENV;
}

// Built once, on first use. createStore() dynamically imports whichever backend
// is configured, so a Cloudflare build never pulls in the Postgres client.
let _store: Promise<ThoughtStore> | null = null;
function db(): Promise<ThoughtStore> {
  if (!_store) _store = createStore(env());
  return _store;
}

// The model provider. Anything speaking the OpenAI /embeddings and
// /chat/completions shapes works, which includes OpenRouter, OpenAI itself, and
// Ollama's compatibility layer — so a fully local brain is a URL change, not a
// code change.
const DEFAULT_LLM_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_METADATA_MODEL = "openai/gpt-4o-mini";

function llmBase(): string {
  return (env().OB1_LLM_BASE_URL || DEFAULT_LLM_BASE).replace(/\/+$/, "");
}

/**
 * A local endpoint needs no credential, so the key is optional there. Sending an
 * `Authorization: Bearer undefined` header to Ollama is harmless but confusing in
 * logs, so it is omitted entirely when there is no key.
 */
function llmHeaders(): Record<string, string> {
  const key = env().OB1_LLM_API_KEY || env().OPENROUTER_API_KEY;
  return key
    ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

function embeddingModel(): string {
  return env().OB1_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}
function embeddingDim(): number {
  const raw = env().OB1_EMBEDDING_DIM;
  return raw ? Number(raw) : DEFAULT_EMBEDDING_DIM;
}

/**
 * Whether to ask the provider for a narrower vector, via the OpenAI `dimensions`
 * parameter.
 *
 * This exists so a model whose native width exceeds pgvector's 2000-dimension
 * HNSW ceiling can be used at all. `qwen3-embedding:4b` emits 2560 and cannot be
 * indexed, but truncated to 1024 it scored the best retrieval result measured on
 * real data — better than every model that fits natively (evals/README.md).
 *
 * It is OFF by default and deliberately so. Providers apply the parameter to any
 * model, including ones never trained for Matryoshka truncation: Ollama returns
 * 256 numbers for `all-minilm` just as happily as for `embeddinggemma`, with no
 * error either way. The result is a valid-looking vector that retrieves worse, and
 * silent quality loss is the failure mode this fork exists to eliminate rather
 * than add to. Opting in is a claim that you checked.
 */
function embeddingDimensionsRequested(): boolean {
  return resolveEmbeddingDimensions(env().OB1_EMBEDDING_DIMENSIONS, embeddingDim(), embeddingModel());
}
function metadataModel(): string {
  return env().OB1_METADATA_MODEL || DEFAULT_METADATA_MODEL;
}

/**
 * Thinking-capable models reason before answering unless told not to, and a
 * growing share of open-weight models default to it — Gemma 4, Qwen 3,
 * DeepSeek-R1. For a fixed-schema extraction on the interactive path of every
 * capture, that is mostly cost: measured on gemma4, reasoning bought +3 points on
 * the extraction benchmark for 5.5x the latency (7.7s vs 1.4s per capture).
 *
 * So reasoning is OFF by default and opt-in. Note that `think: false` is silently
 * IGNORED on the OpenAI-compatible endpoint — `reasoning_effort` is what it
 * honours, and it is harmless to models with no reasoning mode.
 */
function metadataReasoning(): Record<string, unknown> {
  const raw = (env().OB1_METADATA_REASONING ?? "").toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return {};
  if (raw && raw !== "off" && raw !== "false" && raw !== "0") return { reasoning_effort: raw };
  return { reasoning_effort: "none" };
}

/** Deterministic by default; overridable for anyone who wants variety. */
function metadataTemperature(): number {
  const raw = env().OB1_METADATA_TEMPERATURE;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function citationBase(): string {
  return env().OPEN_BRAIN_CITATION_BASE_URL || "https://openbrain.local/thoughts";
}

// thought_stats pagination. Supabase caps an unbounded select at 1000 rows, so
// stats must page explicitly or they silently describe only the newest page.
// STATS_MAX_ROWS bounds the work so a very large brain cannot exhaust the Edge
// Function's time budget; hitting it is reported in the output, never hidden.
const STATS_PAGE_SIZE = 1000;
const STATS_MAX_ROWS = 100_000;

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${citationBase().replace(/\/$/, "")}/${id}`;
}

/**
 * Chunk sizing. The default is deliberately well under Ollama's 2048-token batch
 * rather than close to it: the token count is an estimate, and a chunk that
 * overshoots is silently truncated, which is the failure being fixed rather than a
 * degradation of it. Retrieval was measured perfect at 2000 tokens and at chance
 * by 4000, so crowding the ceiling buys nothing.
 */
function chunkTokens(): number {
  const raw = Number(env().OB1_CHUNK_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TOKENS;
}
function chunkOverlap(): number {
  const raw = Number(env().OB1_CHUNK_OVERLAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_OVERLAP_TOKENS;
}

/**
 * Embed a capture: one vector for `thoughts.embedding`, plus per-window vectors
 * when the content is too long to embed in a single provider call.
 *
 * Short content — nearly everything — takes exactly the path it always did: one
 * call, one vector, no chunk rows.
 *
 * For long content, `thoughts.embedding` becomes **the first chunk's** vector
 * rather than the whole content's. That matters: sending the whole content would
 * be a request over the provider's batch, which Ollama answers by silently
 * truncating — reintroducing the precise bug this is fixing, in the one column
 * that every pre-existing row and the PostgREST path still rely on. Using the
 * head chunk gives that column a defined meaning (the opening of the thought)
 * instead of an accidental one (however much of it happened to fit), and costs one
 * fewer provider call.
 *
 * Windows are embedded concurrently; they are independent, and serialising them
 * would multiply the latency of a long capture for no benefit.
 */
async function embedCapture(content: string): Promise<{
  embedding: number[];
  chunks: { content: string; embedding: number[] }[];
}> {
  const windows = chunkContent(content, { maxTokens: chunkTokens(), overlapTokens: chunkOverlap() });
  const texts = windows.length ? windows.map((w) => w.content) : [content];
  const embeddings = await Promise.all(texts.map((t) => getEmbedding(t)));
  return {
    embedding: embeddings[0],
    chunks: windows.map((w, i) => ({ content: w.content, embedding: embeddings[i] })),
  };
}

/**
 * Some embedding models are trained to see a query and a document differently, and
 * sending both bare is not a small loss: `qwen3-embedding:4b` scores 0.933 MRR on
 * 97 real issues with its query instruction and 0.860 without — unprompted, worse
 * than a model a quarter its size. The templates live in db/config.mjs, keyed by
 * model, so the migration runner and the server cannot disagree about them.
 *
 * A model with no entry is sent bare, which is right for most: `embeddinggemma`
 * gains 0.002 from its documented format, and nomic's prefixes measurably hurt.
 *
 * This is baked into stored vectors. Changing the template invalidates them
 * exactly as changing the model does — which is why it is keyed off the model name
 * rather than exposed as its own setting, so preflight's existing model-change
 * check already covers it.
 */
type EmbedKind = "query" | "document";
function applyPrompt(text: string, kind: EmbedKind): string {
  const tpl = (EMBEDDING_PROMPTS as Record<string, { query: string; document: string } | undefined>)[
    embeddingModel()
  ];
  if (!tpl) return text;
  return kind === "query" ? tpl.query.replace("{q}", text) : tpl.document.replace("{d}", text);
}

async function getEmbedding(text: string, kind: EmbedKind = "document"): Promise<number[]> {
  const r = await fetch(`${llmBase()}/embeddings`, {
    method: "POST",
    headers: llmHeaders(),
    body: JSON.stringify({
      model: embeddingModel(),
      input: applyPrompt(text, kind),
      ...(embeddingDimensionsRequested() ? { dimensions: embeddingDim() } : {}),
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embeddings request to ${llmBase()} failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  const embedding = d?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(`${llmBase()} returned no embedding for model ${embeddingModel()}`);
  }

  // Refuse a width the column cannot hold. Postgres would reject the insert
  // anyway, but the error surfaces as an opaque cast failure inside a tool
  // response; naming the model and both widths makes the cause obvious. A
  // same-width model from a different family is NOT detectable here — it produces
  // valid numbers that mean something else, which is why the model is recorded in
  // ob1_config and checked by preflight.
  const expected = embeddingDim();
  if (embedding.length !== expected) {
    // The cost of changing model is always worth stating; the truncation hint is
    // only worth stating when truncation could actually resolve it.
    const hint = embeddingDimensionsRequested()
      ? ` OB1_EMBEDDING_DIMENSIONS=on was set, so the provider was asked for ${expected} and ` +
        `ignored it — not every provider or model supports the parameter.`
      : embedding.length > expected
        ? ` If the model supports Matryoshka truncation, set OB1_EMBEDDING_DIMENSIONS=on to ` +
          `request ${expected} instead of ${embedding.length}.`
        : "";
    throw new Error(
      `Embedding width mismatch: model ${embeddingModel()} returned ${embedding.length} ` +
        `dimensions but thoughts.embedding is vector(${expected}). Changing embedding model ` +
        `requires a schema migration and re-embedding every existing row.${hint}`
    );
  }
  return embedding;
}

/**
 * The `type` field is a closed set, but only the prompt says so — nothing enforced
 * it, so a model free to invent one did. Observed for real: llama3.2 returned
 * "action_item" for a reminder.
 *
 * Unenforced, that fragments the taxonomy silently. `list_thoughts` filtering on
 * `type=task` misses the row, and `thought_stats` accumulates a long tail of
 * one-off types that look like categories but are model noise. A smaller local
 * model drifts more than a hosted one, which makes this matter more now that the
 * local path is supported.
 *
 * Unknown values are coerced to `observation` — the same neutral default the
 * failure path uses — and the model's original answer is kept in `type_raw` so
 * drift is visible rather than discarded.
 */
const THOUGHT_TYPES = ["observation", "task", "idea", "reference", "person_note"] as const;

const TYPE_ALIASES: Record<string, (typeof THOUGHT_TYPES)[number]> = {
  action_item: "task",
  action: "task",
  todo: "task",
  note: "observation",
  fact: "reference",
  person: "person_note",
  contact: "person_note",
};

function normaliseType(raw: unknown): { type: string; raw?: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { type: "observation" };
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((THOUGHT_TYPES as readonly string[]).includes(key)) return { type: key };
  const aliased = TYPE_ALIASES[key];
  if (aliased) return { type: aliased, raw: raw.trim() };
  console.warn(`extractMetadata: model returned type "${raw}", which is not one of ${THOUGHT_TYPES.join(", ")}; recorded as observation`);
  return { type: "observation", raw: raw.trim() };
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${llmBase()}/chat/completions`, {
    method: "POST",
    headers: llmHeaders(),
    body: JSON.stringify({
      model: metadataModel(),
      response_format: { type: "json_object" },
      // Structured extraction has one right answer, so sampling only adds
      // variance. No temperature was sent before, which meant the provider
      // default — 0.8 on Ollama. Measured over three runs of evals/: at the
      // default, scores ranged 79/84 to 82/84 and the same capture could gain or
      // lose a field between runs; at 0 the result was identical every time and
      // above the sampled mean. Determinism also makes a bad capture
      // reproducible, which matters more than the point of score.
      temperature: metadataTemperature(),
      ...metadataReasoning(),
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
  });

  // The original swallowed every failure into the fallback below: an auth error,
  // a rate limit, or a 500 from OpenRouter all produced a thought tagged
  // "uncategorized" and a success message to the user, with no way to tell a
  // genuinely uncategorisable thought from a broken API key. Capture must still
  // succeed — the content matters more than the tags — but the degradation is
  // now recorded on the thought and surfaced in the confirmation.
  const fallback = (reason: string): Record<string, unknown> => ({
    topics: ["uncategorized"],
    type: "observation",
    metadata_extraction_failed: reason,
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.error(`extractMetadata: ${llmBase()} returned ${r.status} ${msg.slice(0, 500)}`);
    return fallback(`provider_${r.status}`);
  }

  let d: { choices?: [{ message?: { content?: string } }] };
  try {
    d = await r.json();
  } catch {
    console.error("extractMetadata: provider returned a non-JSON body");
    return fallback("invalid_response_body");
  }

  const content = d?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    console.error("extractMetadata: provider response had no message content");
    return fallback("no_message_content");
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("extractMetadata: model returned JSON that is not an object");
      return fallback("unexpected_json_shape");
    }

    const out = parsed as Record<string, unknown>;
    const { type, raw } = normaliseType(out.type);
    out.type = type;
    if (raw) out.type_raw = raw;
    return out;
  } catch {
    console.error("extractMetadata: model content was not valid JSON");
    return fallback("unparseable_model_output");
  }
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
        const qEmb = await getEmbedding(query, "query");
        const data = await (await db()).matchThoughts({
          embedding: qEmb,
          threshold: 0.5,
          limit: 10,
          filter: {},
        });

        const results = data.map((t) => ({
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
        const thought = await (await db()).getThought(id);

        if (!thought) {
          return {
            content: [{ type: "text" as const, text: `Fetch error: no thought with id ${id}` }],
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
            updated_at: thought.updated_at,
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

  // Tool 1: Semantic Search
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
        const qEmb = await getEmbedding(query, "query");
        const data = await (await db()).matchThoughts({
          embedding: qEmb,
          threshold,
          limit,
          filter: {},
        });

        if (data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        const results = data.map(
          (t, i) => {
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
          }
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
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

  // Tool 2: List Recent
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
        const data = await (await db()).listThoughts({ limit, type, topic, person, days });

        if (!data.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        const results = data.map(
          (
            t: { content: string; metadata: Record<string, unknown>; created_at: string },
            i: number
          ) => {
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
          }
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
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

  // Tool 3: Stats
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
        const store = await db();
        const count = await store.countThoughts();

        // Supabase caps an unbounded select at 1000 rows by default, so a single
        // query silently aggregates only the newest page while `count` above
        // reports the whole corpus — the two halves of the response then describe
        // different datasets with no indication. Page explicitly instead, and
        // tally as we go so we never hold the corpus in memory.
        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        let aggregated = 0;
        let newest: string | null = null;
        let oldest: string | null = null;
        let truncated = false;

        for (let offset = 0; ; offset += STATS_PAGE_SIZE) {
          if (offset >= STATS_MAX_ROWS) {
            truncated = true;
            break;
          }

          const page = await store.pageThoughtMeta(offset, STATS_PAGE_SIZE);

          if (page.length === 0) break;

          for (const r of page) {
            const m = (r.metadata || {}) as Record<string, unknown>;
            if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
            if (Array.isArray(m.topics))
              for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
            if (Array.isArray(m.people))
              for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
          }

          // Ordered newest-first, so the first row seen is the newest overall and
          // the last row of the final page is the oldest.
          if (newest === null) newest = page[0].created_at;
          oldest = page[page.length - 1].created_at;
          aggregated += page.length;

          if (page.length < STATS_PAGE_SIZE) break; // short page — corpus exhausted
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            newest && oldest
              ? new Date(oldest).toLocaleDateString() +
                " → " +
                new Date(newest).toLocaleDateString()
              : "N/A"
          }`,
        ];

        // Never report aggregates as corpus-wide when they are not. If we stopped
        // at the safety cap, say so rather than quietly under-reporting.
        if (truncated) {
          lines.push(
            `Note: breakdowns below cover the ${aggregated.toLocaleString()} most recent thoughts ` +
              `(safety cap ${STATS_MAX_ROWS.toLocaleString()}), not all ${count?.toLocaleString() ?? "?"}.`
          );
        }

        lines.push("", "Types:", ...sort(types).map(([k, v]) => `  ${k}: ${v}`));

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

  // Tool 4: Capture Thought — the only tool that writes.
  //
  // Registered only for a write-scoped key. A read-only key does not get a
  // permission error from it; the tool is absent from tools/list entirely, so the
  // client never offers it and never tries. That is a smaller surface than
  // refusing the call, and it is honest about what the key can do.
  if (canWrite(principal)) server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
      },
    },
    async ({ content }) => {
      try {
        // Independent of each other, so they overlap.
        const [{ embedding, chunks }, metadata] = await Promise.all([
          embedCapture(content),
          extractMetadata(content),
        ]);

        const payload = { metadata: { ...metadata, source: "mcp" } };

        // Atomicity is the store's problem now: the SQL path writes content,
        // metadata and vector in one statement, while the PostgREST path keeps the
        // 3-arg RPC with its two-step fallback. Either way a row committed without
        // its embedding is reported, never silently accepted.
        const captured = await (await db()).captureThought({
          content,
          payload,
          chunks,
          embedding,
        });

        if (captured.embeddingFailed) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Thought saved (id ${captured.id}) but its embedding failed to attach: ` +
                  `${captured.embeddingFailed}. It will NOT appear in semantic search until re-captured.`,
              },
            ],
            isError: true,
          };
        }

        const meta = metadata as Record<string, unknown>;
        let confirmation = `Captured as ${meta.type || "thought"}`;
        if (Array.isArray(meta.topics) && meta.topics.length)
          confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
        if (Array.isArray(meta.people) && meta.people.length)
          confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
        if (Array.isArray(meta.action_items) && meta.action_items.length)
          confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

        // Tell the user when tags are placeholders rather than real extraction,
        // so a broken env().OPENROUTER_API_KEY does not look like a successful capture.
        if (typeof meta.metadata_extraction_failed === "string") {
          confirmation +=
            `\n\nNote: the thought was saved, but automatic tagging failed ` +
            `(${meta.metadata_extraction_failed}) — topics and people are placeholders. ` +
            `Check env().OPENROUTER_API_KEY and the function logs.`;
        }

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

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error code for unauthorized requests.
// Per the JSON-RPC 2.0 spec, the range -32099 to -32000 is reserved for
// implementation-defined server errors. -32001 is the conventional
// "Unauthorized" code used by MCP clients/servers in the wild.
//
// Why a JSON-RPC envelope (HTTP 200) instead of a bare HTTP 401?
// Strict MCP hosts (Codex CLI, Claude Code) treat bare HTTP 4xx responses
// as transport-level failures and tear the connection down rather than
// surfacing the failure to the application layer. Wrapping the auth
// rejection in a JSON-RPC error keeps the connection alive and lets
// clients recover (e.g. prompt the user for a new key, refetch a stale
// cache) instead of dying.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

/**
 * Read the request body as text without consuming the original request's
 * body stream for downstream handlers. Returns null on bodyless methods
 * or read failure.
 */
async function readBodyText(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") {
    return null;
  }
  try {
    return await req.text();
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of the JSON-RPC `id` from a raw request body.
 * Returns null when the body is missing, not JSON, or not a JSON-RPC
 * shape with an id. Per the JSON-RPC 2.0 spec, id may be a string,
 * number, or null — we preserve any of those; anything else becomes null.
 */
function extractJsonRpcId(bodyText: string | null): string | number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) {
        return id;
      }
    }
  } catch {
    // fall through — malformed body
  }
  return null;
}

/**
 * Build a JSON-RPC 2.0 error envelope response for auth failures.
 * Returns HTTP 200 — the JSON-RPC layer expresses the error so that
 * strict MCP clients keep the connection alive instead of treating
 * the failure as a transport-level fault.
 */
function unauthorizedResponse(id: string | number | null): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: JSON_RPC_UNAUTHORIZED_CODE,
      message: UNAUTHORIZED_MESSAGE,
    },
    id,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

const app = new Hono<{ Bindings: Env }>();

// Must run before anything reads env(). On Workers c.env carries the bindings;
// elsewhere it is undefined and initEnv falls back to process.env.
app.use("*", async (c, next) => {
  initEnv(c.env as unknown as Record<string, unknown>);
  await next();
});

// CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
app.options("*", (c) => {
  return c.text("ok", 200, corsHeaders);
});

app.all("*", async (c) => {
  // Accept the access key via header OR URL query parameter. The query form stays
  // because Claude Desktop custom connectors are URL-only; scopes are what limit
  // the damage when such a URL leaks. See auth.ts.
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");

  const principal = authenticate(provided, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  });

  if (!principal) {
    // Return a JSON-RPC 2.0 error envelope (HTTP 200) instead of a bare
    // HTTP 401 so strict MCP hosts treat this as an application-level
    // error rather than a transport fault and keep the connection alive.
    // Best-effort echo of the inbound request id keeps the response
    // correlated; malformed/missing bodies fall back to id: null.
    const bodyText = await readBodyText(c.req.raw);
    const id = extractJsonRpcId(bodyText);
    return unauthorizedResponse(id);
  }

  // Fix: Claude Desktop connectors don't send the Accept header that
  // StreamableHTTPTransport requires. Build a patched request if missing.
  // See: https://github.com/NateBJones-Projects/OB1/issues/33
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

  const server = buildServer(principal);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

export default {
  // Workers reads `fetch`; Bun also reads `port`. Node uses @hono/node-server.
  port: Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PORT ?? 8000),
  fetch: app.fetch,
};