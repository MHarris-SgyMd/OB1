
import { normaliseType, thoughtTitle, thoughtUrl, THOUGHT_TYPES } from "./thoughts.ts";
import { createEmbedder, providerCall, ProviderError, resolveEmbedConfig, type EmbedConfig, type EmbedKind, type EmbeddedCapture } from "./embed.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, type ThoughtStore } from "./store.ts";
import { authenticate, canWrite, type Principal } from "./auth.ts";
import { AgentResolver, cacheTtlFromEnv } from "./agents.ts";

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
  /** "on" to generate a situating blurb per chunk before embedding it. Off by
   *  default, and measured off — see db/config.mjs and evals/eval-contextual.ts. */
  OB1_CHUNK_CONTEXT?: string;
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
  /** Seconds a single provider call — embedding, blurb or metadata extraction — may take. Default 120 — see embed.ts. */
  OB1_LLM_TIMEOUT?: string;
  OPEN_BRAIN_CITATION_BASE_URL?: string;
  /**
   * How long a resolved agent identity is cached, in milliseconds. Also the
   * delay before ob1_agent_keys.revoked_at takes effect. Default 60000; 0
   * resolves on every request. See agents.ts.
   */
  OB1_AGENT_CACHE_TTL_MS?: string;
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

// Built on first use, for the same reason as the store: reading env() at module
// scope runs before initEnv() has seeded it.
let _agents: AgentResolver | null = null;
function agents(): AgentResolver {
  if (!_agents) _agents = new AgentResolver(cacheTtlFromEnv(env().OB1_AGENT_CACHE_TTL_MS));
  return _agents;
}

// The model provider. Anything speaking the OpenAI /embeddings and
// /chat/completions shapes works, which includes OpenRouter, OpenAI itself, and
// Ollama's compatibility layer — so a fully local brain is a URL change, not a
// code change.
//
// How each provider-side setting is resolved from the environment lives in
// embed.ts (resolveEmbedConfig), because db/reembed.ts must resolve them the
// same way; these are the server's lazy readers over it, lazy so Cloudflare
// Workers bindings — which arrive per request — still apply.

function embedConfig(): EmbedConfig {
  return resolveEmbedConfig(env());
}
function metadataModel(): string {
  return embedConfig().metadataModel;
}
function metadataReasoning(): Record<string, unknown> {
  return embedConfig().metadataReasoning;
}
function metadataTemperature(): number {
  return embedConfig().metadataTemperature;
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

// How a capture becomes vectors — chunking, the blurb rule, the prompt
// template, the whole-content-then-head-window fallback, the width check — is
// embed.ts, shared with db/reembed.ts so a re-embed produces exactly what a
// capture would. The embedder remembers one thing across calls: whether the
// provider refused a whole-content embedding, which is a property of the model.
const embedder = createEmbedder(embedConfig);
const embedCapture = (content: string) => embedder.embedCapture(content);
const getEmbedding = (text: string, kind: EmbedKind = "document") => embedder.getEmbedding(text, kind);

/**
 * What a capture or an edit reply says when the whole-content vector could
 * not be had for a reason that says nothing about the next attempt — a 429, a
 * 5xx, a lost connection, OB1_LLM_TIMEOUT. The head window stands in, which is
 * a legitimate state and a silent one, and unlike the re-embed there is no
 * claim row here to record it. A provider that REFUSED the length stays silent,
 * as change 27 decided: that is the vector every long capture gets there.
 */
function explainHeadWindow(e: EmbeddedCapture | undefined): string {
  if (!e?.wholeContentFellBack || e.wholeContentRefused) return "";
  return (
    `\n\nNote: the whole content could not be embedded in one call (${e.wholeContentError ?? "no detail"}); ` +
    `the head window's vector stands in for it. The thought is stored and searchable, and every search chunk ` +
    `has its vector; re-capture, or a re-embed pass, gives it the whole-content vector once the provider answers.`
  );
}


async function extractMetadata(text: string): Promise<Record<string, unknown>> {
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

  // Through the one provider call embed.ts owns, so this is bounded like the
  // embedding calls and by the same setting: a capture awaits this and the
  // embedding together, so a chat call that never returned held the capture —
  // and discarded the embedding that had finished — for as long as the
  // platform allowed. A timeout is one more recorded way the tags can be
  // missing, told apart from a refused status and from a body that is not JSON.
  let d: { choices?: [{ message?: { content?: string } }] };
  try {
    d = await providerCall(embedConfig(), "/chat/completions", {
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
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      console.error(`extractMetadata: ${e.message}`);
      return fallback(e.kind === "timeout" ? "provider_timeout" : e.kind === "http" ? `provider_${e.status}` : "invalid_response_body");
    }
    throw e;
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

/** The `{ isError: true }` envelope the other tools return, in one place. */
function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Turn a refusal into something the caller can act on. A stale read is not a
 * fault — it is a race the caller can resolve by refetching — so the message
 * says what to do rather than only what went wrong.
 */
function explainRefusal(r: { error: string; currentUpdatedAt?: string }, id: string): string {
  switch (r.error) {
    case "NOT_FOUND":
      return `No thought with id ${id}. It may already have been deleted — check the audit trail, which keeps the previous content.`;
    case "STALE_READ":
      return `Refused: ${id} changed after the if_unchanged_since you passed${
        r.currentUpdatedAt ? ` (it is now ${r.currentUpdatedAt})` : ""
      }. Re-read the thought and retry, so you amend the current text rather than overwrite someone else's edit.`;
    case "DUPLICATE_CONTENT":
      return `Refused: that text already exists as another thought, and two identical thoughts would break deduplication. Edit one of them, or delete the other first.`;
    default:
      return `Refused: ${r.error}`;
  }
}

/**
 * The two things migration 018 reports on a successful edit that the caller
 * should hear about: the edit's unchanged text is also another thought's, or
 * another thought's stale fingerprint blocks this one's. Neither says which
 * row is older — a capture merged around a legacy row produces the same pair —
 * so neither tells the caller which to delete.
 */
function explainPair(r: { duplicateOf?: string; fingerprintHeldBy?: string }): string {
  if (r.duplicateOf) {
    return `\nNote: this thought holds the same text as ${r.duplicateOf}. Deduplication could not see this one because it had no fingerprint, so the edit was kept and no fingerprint was written. Read both before deciding whether they should be one thought; delete_thought keeps the removed text in the audit trail.`;
  }
  if (r.fingerprintHeldBy) {
    return `\nNote: ${r.fingerprintHeldBy} carries a stale fingerprint for this text under different content, so this thought could not take its own. Re-saving that thought's text corrects it.`;
  }
  return "";
}

function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "1.0.0",
  });

  // ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
  // research look for exact read-only `search` and `fetch` tool shapes.
  //
  // Hybrid (migration 017, SMD-958), not vector-only: this tool cannot grow a
  // `mode` parameter without breaking the shape ChatGPT matches on, so it is the
  // one surface that could never reach search_thoughts_keyword. For an
  // identifier it got what 012 measured — the containing thought outside the
  // top ten 37 times in 60. The fused function returns exactly what
  // match_thoughts returned for any query without an identifier in it.
  //
  // Nor can it grow `recency_weight` (migration 020, SMD-945), so it sends a
  // fixed one — 0, by measurement: on the 486-issue corpus a weight lowered
  // MRR at every setting tried (0.899 → 0.894 at 0.1 over 365 days, 0.811 at
  // 0.2 over 90; evals/eval-recency.ts), and this surface has no caller who
  // can turn it off. An operator whose brain is a working log rather than a
  // reference can ask search_thoughts for a weight; this tool stays where
  // every result is the one the query names.
  const SEARCH_COMPAT_RECENCY_WEIGHT = 0;
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories by meaning and by exact text — identifier-shaped tokens and \"quoted\" spans in the query are also matched literally. " +
        "Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
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
        const data = await (await db()).hybridThoughts({
          query,
          embedding: qEmb,
          threshold: 0.5,
          limit: 10,
          filter: {},
          recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT,
        });

        const results = data.map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(citationBase(), t.id),
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
          url: thoughtUrl(citationBase(), thought.id),
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

  // Tool 1: Search — semantic, with the identifiers in the query matched exactly.
  //
  // Hybrid since migration 017 (SMD-958). The description says what is matched
  // literally, because that is the part the model reads before deciding whether
  // it still needs search_thoughts_keyword: it does, for paging through every
  // thought containing a string, and for a needle the extraction rule would not
  // pick out of a sentence on its own.
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning, with exact matching for identifier-shaped tokens in the query (SMD-944, upsert_thought, db/config.mjs, getUserById) and for \"quoted\" spans. " +
        "Use this when the user asks about a topic, person, or idea they've previously captured, including one named by an error code or a ticket key. " +
        "A thought containing one of those literals is ranked with the strongest results found by meaning, never below them, whatever its own similarity — provided the literal is rare enough to match exactly (found in no more than one keyword page of thoughts) and the result fits within the limit. " +
        "Returns a fixed top-N; to page through every thought containing an exact string, or to match a literal that is too common here, use search_thoughts_keyword.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("What to search for"),
        // Clamped, not rejected: any number a client sends lands in 1–100, so an
        // existing connector that always asked for 200, or 7.5, keeps working.
        // match_thoughts clamps too, to its own ceiling of 500 (migration 014);
        // this one is about what to hand a model, and keeps a non-integer from
        // ever reaching the function's int parameter.
        limit: z.number().optional().default(10).describe("Results to return, clamped to 1-100.")
          .transform((n) => Math.min(Math.max(Math.trunc(n), 1), 100)),
        // Described, because 017 narrowed what it means: match_thoughts
        // guaranteed every row cleared it, the fused function exempts exact hits.
        threshold: z.number().optional().default(0.5)
          .describe("Minimum similarity, 0-1, for results found by meaning alone. An exact hit on an identifier or quoted span from the query is exempt from it."),
        // Migration 020 (SMD-945): age blended into the order, after the
        // candidate scan, with the threshold still on raw similarity — so a
        // weight reorders relevant thoughts and cannot surface irrelevant recent
        // ones. 0 is the ranking by meaning alone. Clamped, as limit is; the
        // half-life stays the function's 90 days for this tool.
        recency_weight: z.number().optional().default(0)
          .describe("How much a thought's age counts against its similarity, 0-1. 0 (default) ranks by meaning alone; 0.2 is a gentle preference for recent captures; 1 ranks the relevant thoughts newest first. A thought's recency halves every 90 days.")
          .transform((w) => Math.min(Math.max(w, 0), 1)),
      },
    },
    async ({ query, limit, threshold, recency_weight }) => {
      try {
        const qEmb = await getEmbedding(query, "query");
        const data = await (await db()).hybridThoughts({
          query,
          embedding: qEmb,
          threshold,
          limit,
          filter: {},
          recencyWeight: recency_weight,
        });

        if (data.length === 0) {
          // Nothing cleared the threshold and no literal matched — but WHY is
          // worth saying, and the function reports it only on rows. One more
          // call with no threshold and one row returns the query-level facts
          // whenever the brain has any embedded thought at all (review pass:
          // the first version said "no thoughts found" about a literal that
          // 150 thoughts contained, because it was too common to match).
          const probe = await (await db()).hybridThoughts({ query, embedding: qEmb, threshold: -1, limit: 1, filter: {} });
          const facts = probe[0];
          const why: string[] = [];
          if (facts) {
            const absent = facts.needles.filter((_, i) => facts.needleCounts[i] === 0);
            if (absent.length) why.push(`No thought contains: ${absent.join(", ")}.`);
            if (facts.commonNeedles.length) why.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${facts.commonNeedles.join(", ")} — use search_thoughts_keyword to page through them.`);
          }
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".${why.length ? ` ${why.join(" ")}` : ""}` }],
          };
        }

        const results = data.map(
          (t, i) => {
            const m = t.metadata || {};
            // A keyword hit with no vector has no similarity to report; it is
            // here because it contains the literal, and the header says which.
            const match = t.similarity == null ? "exact match, no vector" : `${(t.similarity * 100).toFixed(1)}% match`;
            const parts = [
              `--- Result ${i + 1} (${match}) ---`,
              // The id, so update_thought and delete_thought can be aimed at a hit
              // the caller never captured — without it those two tools reach only
              // what capture_thought just returned. In the header group and cased
              // `ID:` to match search_thoughts_keyword, which prints the id the
              // same way for the same block format. SMD-1248.
              `ID: ${t.id}`,
              `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
              `Type: ${m.type || "unknown"}`,
            ];
            if (t.matchedNeedles.length) parts.push(`Contains: ${t.matchedNeedles.join(", ")}`);
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

        // What the query was taken to mean, from the first row (every row
        // carries the same three): which literals were searched for exactly —
        // and, separately, which of those no thought contains, because
        // `needles` lists every literal that was asked for and a literal with
        // zero hits is asked for too (review pass) — which were too common to
        // use, and whether there was anything to embed.
        const head = data[0];
        const matchedAny = new Set(data.flatMap((t) => t.matchedNeedles));
        // Absent and truncated are different facts, and only the count tells
        // them apart: a literal with hits that all fell outside the limit was
        // once reported as "no thought contains" (review pass).
        const absent = head.needles.filter((n, i) => head.needleCounts[i] === 0);
        const truncated = head.needles.filter((n, i) => head.needleCounts[i] > 0 && !matchedAny.has(n));
        const notes: string[] = [];
        if (head.needles.length) notes.push(`Searched exactly for: ${head.needles.join(", ")}.`);
        if (absent.length) notes.push(`No thought contains: ${absent.join(", ")}.`);
        if (truncated.length) notes.push(`Outside the top ${data.length}: ${truncated.map((n, ) => `${n} (in ${head.needleCounts[head.needles.indexOf(n)]} thought${head.needleCounts[head.needles.indexOf(n)] === 1 ? "" : "s"})`).join(", ")} — raise limit or use search_thoughts_keyword.`);
        if (head.commonNeedles.length) notes.push(`Too common to match exactly (more thoughts contain it than one keyword page returns): ${head.commonNeedles.join(", ")}.`);
        if (head.literalOnly) {
          notes.push(matchedAny.size
            ? "The query is only literals, so exact matches are ranked first and the rest by similarity."
            : head.commonNeedles.length
              ? "The query is only literals, and too common to match exactly, so these results are by similarity alone."
              : "The query is only literals and no thought contains them, so these results are by similarity alone.");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.length} thought(s):${notes.length ? ` ${notes.join(" ")}` : ""}\n\n${results.join("\n\n")}`,
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

  /**
   * Tool 1b: Exact keyword search. Migration 012, SMD-944.
   *
   * A separate tool rather than a `mode` on search_thoughts. The two have
   * different cost models, different result shapes and different failure modes,
   * and an LLM choosing between two clearly-described tools does better than one
   * choosing between two meanings of one tool. The description leads with WHEN to
   * reach for it, because that is the only part the model reads before deciding.
   */
  server.registerTool(
    "search_thoughts_keyword",
    {
      title: "Search Thoughts by Exact Text",
      description:
        "Find thoughts containing an exact string — an error code, a ticket key, a commit SHA, a function name, a rare proper noun. " +
        "Case-insensitive substring match, not semantic: it will not find paraphrases, and it has no boolean operators. " +
        "Use search_thoughts when you know the meaning; use this when you know the literal text.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("The literal text to find. Matched as a substring; % and _ are literal, not wildcards."),
        // Bounded in the schema, not merely clamped in SQL. The function clamps
        // too, because the store is callable directly — but a bound here is
        // enforced where the caller can see it, and it keeps `offset` sane for
        // the result numbering below, which is plain arithmetic on it. Without
        // it, offset: -5 renders "Result -4".
        limit: z.number().int().min(1).max(100).optional().default(10).describe("Results per page, 1-100."),
        offset: z.number().int().min(0).optional().default(0).describe("Skip this many results, for paging."),
      },
    },
    async ({ query, limit, offset }) => {
      try {
        const data = await (await db()).keywordThoughts({
          query,
          limit,
          offset,
          filter: {},
        });

        if (data.length === 0) {
          // Two different nothings, and the difference is actionable: an empty
          // needle is a caller bug, no matches is an answer. Saying "no thoughts
          // found" for the first sends the model looking for different words.
          if (query.trim() === "") {
            return {
              content: [{ type: "text" as const, text: "Empty query — pass the literal text to search for." }],
            };
          }
          // The needle is matched exactly as given, whitespace included, because
          // trimming it would silently widen "SMD-944 " into "SMD-944". That is
          // the right trade, but it makes a pasted string with a stray space
          // fail for a reason the caller cannot see — so say it.
          const padded = query !== query.trim();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No thoughts contain "${query}". This is an exact substring match — ` +
                  (padded
                    ? `note the leading or trailing whitespace in your query, which is matched literally. Try "${query.trim()}", or `
                    : `try `) +
                  `search_thoughts for a match by meaning, or a shorter fragment of the same string.`,
              },
            ],
          };
        }

        const total = data[0].totalCount;
        const results = data.map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${offset + i + 1} (${t.occurrences} occurrence${t.occurrences === 1 ? "" : "s"}) ---`,
            `ID: ${t.id}`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        });

        // The header states the whole match set, not the page. Without it a
        // model that gets ten results cannot tell "these are all of them" from
        // "there are four hundred more", and will not page.
        const shown = `${offset + 1}-${offset + data.length} of ${total}`;
        const more =
          offset + data.length < total
            ? ` Call again with offset=${offset + data.length} for the next page.`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `Showing ${shown} thought(s) containing "${query}".${more}\n\n${results.join("\n\n")}`,
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
          (t, i) => {
            // `data` is ThoughtListItem[] — id, content, metadata, created_at all
            // inferred, as the search_thoughts map is written.
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            // An `ID:` line, the same label the two search tools print — it is what
            // update_thought and delete_thought take. This compact format has no
            // header group, so it trails the content. SMD-1248.
            return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}\n   ID: ${t.id}`;
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
        const [embedded, metadata] = await Promise.all([
          embedCapture(content),
          extractMetadata(content),
        ]);
        const { embedding, chunks, contextFailures } = embedded;

        const payload = { metadata: { ...metadata, source: "mcp" } };

        // Atomicity is the store's problem now: the SQL path writes content,
        // metadata and vector in one statement, while the PostgREST path keeps the
        // 3-arg RPC with its two-step fallback. Either way a row committed without
        // its embedding is reported, never silently accepted.
        const captured = await (await db()).captureThought({
          content,
          payload,
          chunks,
          // The audit trail's actor. `name` is the access key's name from
          // auth.ts; `agentId` is the stable id migration 010 resolved it to,
          // and is absent when the registry could not answer — see agents.ts.
          // Both are recorded: the name is what the agent was CALLED at the time
          // of writing, which a later rename would otherwise erase.
          actor: {
            name: principal.name,
            agentId: principal.agentId,
            source: String(payload.metadata.source ?? "mcp"),
          },
          embedding,
          // The model this vector came from, recorded on the row (021) — the
          // one the embedder used, not the one ob1_config records: they differ
          // exactly while a re-embed to another model is under way.
          embeddingModel: embedded.model,
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
        // The id, because update_thought and delete_thought take one. Without it
        // an agent that captures a typo has to search for its own thought to fix
        // it, and the two new tools are only usable against things it did not
        // just write.
        let confirmation = `Captured as ${meta.type || "thought"} — id ${captured.id}`;
        if (Array.isArray(meta.topics) && meta.topics.length)
          confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
        if (Array.isArray(meta.people) && meta.people.length)
          confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
        if (Array.isArray(meta.action_items) && meta.action_items.length)
          confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

        // A chunk whose situating blurb could not be generated is embedded bare
        // and stored with a NULL context, which is a legitimate state and a
        // silent one. Saying so here is half of what keeps it from being silent
        // — preflight, which counts both kinds across the whole corpus, is the
        // other half.
        if (contextFailures > 0) {
          confirmation +=
            `\n\nNote: ${contextFailures} of ${chunks.length} search chunks were embedded without ` +
            `their situating context — the call failed, or returned a blurb too long to be one. ` +
            `They are stored and searchable; re-capture to regenerate, or check the model at ` +
            `OB1_LLM_BASE_URL.`;
        }
        confirmation += explainHeadWindow(embedded);

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


  /**
   * Both are writes, so both are gated on scope exactly as capture_thought is —
   * a read-scoped key does not merely get a permission error, the tools are
   * never registered and do not appear in tools/list.
   */
  if (canWrite(principal)) server.registerTool(
    "update_thought",
    {
      title: "Update Thought",
      description:
        "Correct or amend an existing thought by id. `search_thoughts`, `search_thoughts_keyword`, and `list_thoughts` print the id on an `ID:` line under each hit, and `capture_thought` reports it when it saves — so a thought found by search can be edited without re-capturing it. Provide `content` to replace the text — the embedding and its search chunks are regenerated to match. Provide `metadata_patch` to shallow-merge keys into the existing metadata, leaving unmentioned keys alone. Pass `if_unchanged_since` with the `updated_at` you last read to avoid overwriting a concurrent edit.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        // Not destructive: an update is recoverable from the audit trail, which
        // records the previous content.
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.string().describe("UUID of the thought to update — the id on an `ID:` line of a search_thoughts, search_thoughts_keyword, or list_thoughts result, or the one capture_thought reported when it saved"),
        content: z.string().min(1).optional()
          .describe("Replacement text. Omit to leave the text, embedding and chunks untouched"),
        metadata_patch: z.record(z.string(), z.unknown()).optional()
          .describe("Keys to merge into the existing metadata. Unmentioned keys are left alone"),
        if_unchanged_since: z.string().optional()
          .describe("The updated_at from your last read. The update is refused as STALE_READ if the thought changed since"),
      },
    },
    async ({ id, content, metadata_patch, if_unchanged_since }) => {
      try {
        if (content === undefined && metadata_patch === undefined) {
          return toolError("Provide `content`, `metadata_patch`, or both — an update with neither would do nothing.");
        }

        // Only re-embed when the text actually changed. A metadata-only edit
        // must not spend two model calls, nor risk replacing a good vector.
        const embedded = content !== undefined ? await embedCapture(content) : undefined;

        const result = await (await db()).updateThought({
          id,
          content,
          metadataPatch: metadata_patch,
          embedding: embedded?.embedding,
          chunks: embedded?.chunks,
          ifUnchangedSince: if_unchanged_since,
          actor: { name: principal.name, agentId: principal.agentId, source: "mcp" },
          // Read by update_thought only with content, when the vector moves (021).
          embeddingModel: embedded?.model,
        });

        if (!result.ok) return toolError(explainRefusal(result, id));

        const what = [
          content !== undefined ? "content re-embedded" : null,
          metadata_patch !== undefined ? "metadata merged" : null,
          // An edit replaces every chunk, so a failure here leaves the SAME
          // half-contextualized state a capture can, and is worth the same
          // sentence rather than a silent partial rewrite.
          embedded?.contextFailures ? `${embedded.contextFailures} chunks without context` : null,
        ].filter(Boolean).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `Updated ${id} (${what}).\nupdated_at: ${result.updatedAt}\nPass that value as if_unchanged_since on your next edit.${explainPair(result)}${explainHeadWindow(embedded)}`,
          }],
        };
      } catch (e) {
        return toolError(`update_thought failed: ${(e as Error).message}`);
      }
    }
  );

  if (canWrite(principal)) server.registerTool(
    "delete_thought",
    {
      title: "Delete Thought",
      description:
        "Permanently remove a thought by id, along with its search chunks. `search_thoughts`, `search_thoughts_keyword`, and `list_thoughts` print the id on an `ID:` line under each hit, and `capture_thought` reports it when it saves; read the thought back first to confirm it is the one to remove. The deletion is recorded in the audit trail with the thought's previous content, so it can be reconstructed if removed in error.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.string().describe("UUID of the thought to delete — the id on an `ID:` line of a search_thoughts, search_thoughts_keyword, or list_thoughts result, or the one capture_thought reported when it saved"),
      },
    },
    async ({ id }) => {
      try {
        const result = await (await db()).deleteThought({
          id,
          actor: { name: principal.name, agentId: principal.agentId, source: "mcp" },
        });
        if (!result.ok) return toolError(explainRefusal(result, id));
        return {
          content: [{
            type: "text" as const,
            text: `Deleted ${id}. Its previous content is preserved in the audit trail.`,
          }],
        };
      } catch (e) {
        return toolError(`delete_thought failed: ${(e as Error).message}`);
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
 * A key the environment still accepts but the registry has revoked.
 *
 * Worded differently from the generic failure on purpose. "Missing or invalid"
 * sends the holder of a revoked key looking for a typo; naming the revocation
 * tells them the key was valid and has been withdrawn, which is the one fact
 * that changes what they do next. It leaks nothing an attacker could use —
 * they already hold the key and already know it stopped working.
 */
const REVOKED_MESSAGE =
  "Unauthorized: this access key has been revoked. Its history is retained; request a new key.";

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
function unauthorizedResponse(
  id: string | number | null,
  message: string = UNAUTHORIZED_MESSAGE
): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: JSON_RPC_UNAUTHORIZED_CODE,
      message,
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

// OAuth discovery is a 404, not an auth challenge. claude.ai fetches
// /.well-known/oauth-protected-resource before opening a custom connector: 404
// means "no OAuth here" and it proceeds on the key; anything else — a 401, our
// 200 + JSON-RPC envelope, or the GET reaching the transport — sends it into a
// Dynamic Client Registration it cannot complete. Upstream cannot fix this on
// Supabase, where the gateway answers the path first (#340); we own the route
// table. Ordered after the OPTIONS preflight and before the catch-all, so it
// runs before authenticate() and the agent resolve — the answer is about the
// server, not the caller, and a revoked key gets the same 404. Terminal for the
// whole prefix: a future /.well-known/ route (real RFC 9728 metadata, say) must
// be registered ABOVE this line or it never fires. FORK.md change 42.
app.all("/.well-known/*", (c) => c.text("Not Found", 404, corsHeaders));

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

  /**
   * Resolve the stable agent id, and honour a revocation.
   *
   * At the request boundary rather than inside the write tools, because a
   * revoked key must not read either — a leaked read-only connector URL is the
   * likeliest thing anyone ever revokes.
   *
   * Cached, so the steady state adds no query; see agents.ts for what happens
   * when the registry cannot answer, which is deliberately NOT a refusal.
   */
  const identity = await agents().resolve(db(), principal);
  if (identity.status === "revoked") {
    const bodyText = await readBodyText(c.req.raw);
    return unauthorizedResponse(extractJsonRpcId(bodyText), REVOKED_MESSAGE);
  }
  principal.agentId = identity.agentId;

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