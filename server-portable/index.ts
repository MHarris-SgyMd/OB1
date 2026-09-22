
import { displayDate, normaliseType, thoughtTitle, thoughtUrl, THOUGHT_TYPES } from "./thoughts.ts";
import { cleanForDisplay } from "./consolidate.ts";
import { createEmbedder, providerCall, ProviderError, resolveEmbedConfig, type EmbedConfig, type EmbedKind, type EmbeddedCapture } from "./embed.ts";
import { decideCalls, mayLeaveBox, type EgressDecision, type EgressSubject } from "./egress.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, postgrestOnBunNotice, storeKind, UUID_RE, type Citation, type ThoughtStore } from "./store.ts";
import { queryLogEnabled, trimmedEnv } from "../db/config.mjs";
import { authenticateRequest, canWrite, type Principal } from "./auth.ts";
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
  /** Which data layer to use: "sql" (the default when unset) or "postgrest" (Cloudflare Workers). */
  OB1_STORE?: string;
  /**
   * Required when OB1_STORE=postgrest. Holding a postgres:// URL, SUPABASE_URL
   * also serves as the SQL store's connection string (store.ts:databaseUrl).
   */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** The SQL store's connection string — required unless SUPABASE_URL holds one. */
  DATABASE_URL?: string;
  /** The SQL store's connection pool size (store-sql.ts); default 10. */
  OB1_PG_POOL?: string;
  /**
   * The opt-in trigram index. The migrator builds it; in the server's process
   * db/config.mjs reads it (TRGM_INDEX), which preflight.ts imports to tell the
   * setting and the database apart. Declared here because this block is the
   * one list of what the container's process reads — check 14 holds
   * deploy/compose.yaml to it (SMD-1843).
   */
  OB1_TRGM_INDEX?: string;
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
   * window and overlap between windows; see chunk.ts. Unset, the length a
   * capture is windowed above and the window size are derived from the
   * embedding model's measured window (db/config.mjs, KNOWN_MODEL_WINDOW; 1200
   * and 1200 for a model it does not know) and preflight prints the rule and
   * where it came from.
   */
  OB1_CHUNK_TOKENS?: string;
  OB1_CHUNK_OVERLAP?: string;
  /** "on" to generate a situating blurb per chunk before embedding it. Off by
   *  default, and measured off — see db/config.mjs and evals/eval-contextual.ts. */
  OB1_CHUNK_CONTEXT?: string;
  /**
   * "on" to record the opt-in query log (migration 034, SMD-1295): one row per
   * search and one per follow-up fetch/edit/delete of a returned id — or, since
   * SMD-1719, per id a write cited as its source — so a
   * retrieval change can be replayed against real use (evals/eval-replay.ts).
   * Off by default — anything but "on" writes nothing. Personal data at rest
   * (every query typed); see SETUP.md. The write is best-effort and never fails
   * a search; prune_query_log() enforces the retention window below.
   */
  OB1_QUERY_LOG?: string;
  /** Days query_log rows are kept by prune_query_log(); default 30. See db/config.mjs. */
  OB1_QUERY_LOG_RETENTION_DAYS?: string;
  /** Model for metadata extraction. No schema dependency — safe to change anytime. */
  OB1_METADATA_MODEL?: string;
  /** The supersession judge's model (db/consolidate.ts), when it is not OB1_METADATA_MODEL; the server never judges, but embed.ts reads one Env (SMD-1901). */
  OB1_JUDGE_MODEL?: string;
  /** Sampling temperature for extraction. Defaults to 0 — see metadataTemperature. */
  OB1_METADATA_TEMPERATURE?: string;
  /**
   * Whether a thinking model reasons before extracting. Unset, off/false/0: no
   * reasoning pass (`reasoning_effort: none`); on/true/1: the model's default
   * effort; any other word (low, medium, high) is sent as the effort. See
   * embed.ts metadataReasoning.
   */
  OB1_METADATA_REASONING?: string;
  /** Any OpenAI-compatible base URL. Point it at Ollama for a fully local brain. Embeddings, and chat unless OB1_CHAT_BASE_URL says otherwise. */
  OB1_LLM_BASE_URL?: string;
  /** Preferred over OPENROUTER_API_KEY. Not needed for a loopback endpoint. */
  OB1_LLM_API_KEY?: string;
  /** Where the chat calls (metadata, blurbs, the judge) go when it is not OB1_LLM_BASE_URL — see embed.ts resolveProviderEndpoints (SMD-1902). */
  OB1_CHAT_BASE_URL?: string;
  /** The chat endpoint's own credential; a different chat endpoint never inherits OB1_LLM_API_KEY. */
  OB1_CHAT_API_KEY?: string;
  /**
   * 1/on: the endpoint OB1_LLM_BASE_URL names is on this machine or its
   * private network, so the egress gate does not apply to it (SMD-1903).
   * Declared, never guessed from the address — a loopback URL with this unset
   * is remote to the gate.
   */
  OB1_LLM_LOCAL?: string;
  /** Likewise for OB1_CHAT_BASE_URL; a chat endpoint at the same base is the same box, declared by either knob. */
  OB1_CHAT_LOCAL?: string;
  /**
   * What may leave the box for an endpoint not declared local: deny (the
   * default — only what an OB1_EGRESS_ALLOW term names), allow (everything
   * but what an OB1_EGRESS_DENY term names) or off. See egress.ts.
   */
  OB1_EGRESS_POLICY?: string;
  /** Comma-separated unit:value terms (actor, source, type, topic, marker) read under deny. */
  OB1_EGRESS_ALLOW?: string;
  /** The same, read under allow. */
  OB1_EGRESS_DENY?: string;
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
  // Trimmed once here, for every knob: a quoted `"sk-abc "` in deploy/.env
  // reaches the provider as the key, not the key and a space (SMD-1843).
  ENV = trimmedEnv({ ...globals, ...(bindings ?? {}) }) as Env;
}

function env(): Env {
  if (!ENV) throw new Error("env accessed before initEnv() — is the seeding middleware registered?");
  return ENV;
}

// Built once, on first use. createStore() dynamically imports whichever backend
// is configured, so a Cloudflare build never pulls in the Postgres client. The
// PostgREST store selected where the SQL store runs is said once, here, at the
// moment the selection takes effect (change 97); preflight says it at the
// entrypoint as well, so a container sees it before the first request.
let _store: Promise<ThoughtStore> | null = null;
function db(): Promise<ThoughtStore> {
  if (!_store) {
    const notice = postgrestOnBunNotice(storeKind(env()));
    if (notice) console.warn(notice);
    _store = createStore(env());
  }
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

// How a capture becomes vectors — chunking, the blurb rule, the prompt
// template, the whole-content-then-head-window fallback, the width check — is
// embed.ts, shared with db/reembed.ts so a re-embed produces exactly what a
// capture would. The embedder remembers one thing across calls: whether the
// provider refused a whole-content embedding, which is a property of the model.
const embedder = createEmbedder(embedConfig);
const embedCapture = (content: string, subject: EgressSubject) => embedder.embedCapture(content, subject);
const getEmbedding = (text: string, subject: EgressSubject, kind: EmbedKind = "document") => embedder.getEmbedding(text, subject, kind);

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

/**
 * What a capture records when the egress gate did not let its text reach the
 * chat endpoint (SMD-1903): the reason under the key the other failures use,
 * and NO topics and NO type — the call never happened, so it produced none,
 * and "observation" or the "uncategorized" placeholder would be a tag set
 * dressed as an extraction. Nothing here but the marker, also because
 * upsert_thought MERGES a re-capture's metadata over the row's (035): a
 * placeholder topic would have replaced an existing thought's real tags on
 * every re-capture under a refusing policy (first review pass). The capture
 * path writes this without calling extractMetadata; extractMetadata returns
 * it too should a refusal reach providerCall, so no path fabricates a tag set.
 */
function metadataRefused(): Record<string, unknown> {
  return { metadata_extraction_failed: "egress_denied" };
}

/**
 * A search the egress gate refused (SMD-1903): the query text would leave for
 * its embedding, and the policy says it may not. The caller's way through is
 * the keyword tool, which makes no model call; the operator's are named.
 */
function refuseQuery(gate: EgressDecision, actor: string): string {
  // The remedy follows the rule that refused (first review pass): under
  // `allow` a deny term matched, and adding an allow term would change
  // nothing; a second opinion is the operator's hook to read.
  const remedy = gate.rule === "deny-term"
    ? "or removes the OB1_EGRESS_DENY term the reason names"
    : gate.rule === "second-opinion"
      ? "or reads what the second opinion refused"
      : `or allows this key (OB1_EGRESS_ALLOW=actor:${actor})`;
  return (
    `Refused: the query text would be sent for its embedding, and ${gate.reason}. ` +
    `Use search_thoughts_keyword (exact text, no model call). To allow semantic search here, the operator declares the endpoint local ` +
    `(OB1_LLM_LOCAL=1) when it is, ${remedy}.`
  );
}

/**
 * The question both search tools ask before embedding a query (SMD-1903): the
 * subject the embedding will be judged and sent under, and the refusal text
 * when it may not leave. One helper, since the two tools had the four lines
 * each (boyscout).
 */
function gateQuery(query: string, principal: Principal): { subject: EgressSubject; refused?: string } {
  const cfg = embedConfig();
  const subject: EgressSubject = { kind: "query", actor: principal.name, content: query };
  const gate = mayLeaveBox(subject, cfg.embeddings, cfg.egress);
  return gate.allowed ? { subject } : { subject, refused: refuseQuery(gate, principal.name) };
}

async function extractMetadata(text: string, subject: EgressSubject): Promise<Record<string, unknown>> {
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
    }, subject);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.error(`extractMetadata: ${e.message}`);
      if (e.kind === "egress") return metadataRefused();
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
function explainRefusal(
  r: { error: string; currentUpdatedAt?: string; citedBy?: number; citations?: Citation[] },
  id: string,
): string {
  switch (r.error) {
    case "NOT_FOUND":
      return `No thought with id ${id}. It may already have been deleted — check the audit trail, which keeps the previous content.`;
    case "STALE_READ":
      return `Refused: ${id} changed after the if_unchanged_since you passed${
        r.currentUpdatedAt ? ` (it is now ${r.currentUpdatedAt})` : ""
      }. Re-read the thought and retry, so you amend the current text rather than overwrite someone else's edit.`;
    case "DUPLICATE_CONTENT":
      return `Refused: that text already exists as another thought, and two identical thoughts would break deduplication. Edit one of them, or delete the other first.`;
    // Migration 032: the provenance envelope.
    case "SUPERSEDES_NOT_FOUND":
      return `Refused: no thought with the id given as supersedes. Pass the id of an existing thought — the ID: line of a search result — or null to clear the pointer.`;
    case "WOULD_CYCLE":
      return `Refused: that supersedes pointer would close a loop — the thought named already supersedes ${id}, directly or through a chain (or is ${id} itself). A version chain runs one way; point the newer thought at the older, or clear the older's pointer first.`;
    // Migration 042: statements in other thoughts rest on this one. The rows
    // are the function's sample (ten, newest first); the count is the whole.
    case "CITED": {
      const rows = (r.citations ?? []).map((c) => `  - ${c.thoughtId} (${c.stance}): ${snipText(c.text, 120)}`);
      const total = r.citedBy ?? rows.length;
      const more = total - rows.length;
      // One subject, one way through, three shapes: the number and its grammar
      // spelled once (seventh review pass).
      const one = total === 1;
      const subject = `${total} citation${one ? "" : "s"} on other thoughts rest${one ? "s" : ""} on ${id} as ${one ? "its" : "their"} source`;
      const through = `To delete anyway, pass detach_citations: true`;
      const reread = `re-read the thought (fetch takes the id) before deciding. ${through}.`;
      // The count and rows come from the guard's own refusal (042 carries them
      // in the error), so a CITED envelope with neither is one the function did
      // not write — a proxy, a truncated body. Say so rather than "0 citations".
      if (total <= 0) return `Refused: other thoughts cite ${id} as their source, but the reply carried no count and no citing rows — ${reread}`;
      // A count with no rows (a proxy that dropped the array): no list, no
      // dangling colon, the same advice.
      if (rows.length === 0) return `Refused: ${subject}, but the citing rows were not returned — ${reread}`;
      return `Refused: ${subject} — deleting it would leave ${one ? "that statement" : "those statements"} resting on nothing:\n${rows.join("\n")}${more > 0 ? `\n  …and ${more} more` : ""}\nRead the citing thoughts first (fetch takes the id). ${through} — each citation keeps its text and stance, loses its source, and records ${id} and the time as the deleted source.`;
    }
    default:
      return `Refused: ${r.error}`;
  }
}

/**
 * Untrusted text — a thought's, a citation's, a judge's reason — on one line
 * of a reply: the same cleaner the CLI renders through
 * (server-portable/consolidate.ts), whitespace collapsed, cut with an ellipsis
 * past `max` characters. One spelling for every place a reply quotes a thought.
 */
function snipText(text: string, max: number): string {
  const t = cleanForDisplay(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * What a successful delete did to the citations that named the thought
 * (migration 042): the active ones it detached — only when asked — and the
 * expired or superseded ones it marked in either mode. Silent when neither.
 */
function explainDetached(r: { detached?: number; inactive?: number }, id: string): string {
  const parts: string[] = [];
  if (r.detached) parts.push(`${r.detached} citation${r.detached === 1 ? "" : "s"} on other thoughts rested on it and ${r.detached === 1 ? "was" : "were"} detached: each keeps its text and stance and records ${id} as its deleted source.`);
  if (r.inactive) parts.push(`${r.inactive} expired or superseded citation${r.inactive === 1 ? "" : "s"} that named it ${r.inactive === 1 ? "was" : "were"} marked with the deletion.`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * A `supersedes` that is not a thought id, refused at the tool before any model
 * call or database write (032) — both tools, one sentence; `orNull` is the
 * edit tool's clause, since only it takes null.
 */
function refuseSupersedesShape(value: string, orNull = ""): string {
  return `Refused: \`supersedes\` must be a thought id (the ID: line of a search result)${orNull}, not "${value.slice(0, 40)}".`;
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

/**
 * This server's name: what MCP clients see in `initialize`, and the door every
 * write names in its actor (`via`), which migration 045 stamps as
 * thought_audit.origin (SMD-1730). One constant, so the two cannot drift.
 */
const SERVER_NAME = "open-brain";

function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "1.0.0",
  });

  // The opt-in query log (migration 034, SMD-1295). Off unless OB1_QUERY_LOG=on,
  // and best-effort either way: a log write is never allowed to fail a search, a
  // fetch or a capture, so every call is guarded and every rejection swallowed.
  // The flag is read from the boot-time env snapshot (initEnv freezes it on the
  // first request), so it is set at start-up, not toggled per request. Nothing
  // here reads the log back — the export tool does, offline.
  const logSearchCall = async (
    tool: string,
    args: { query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown> },
    data: { id: string; score?: number | null }[],
  ): Promise<void> => {
    if (!queryLogEnabled(env())) return;
    try {
      await (await db()).logSearch({
        tool,
        agentId: principal.agentId,
        query: args.query,
        matchCount: args.limit,
        threshold: args.threshold,
        recencyWeight: args.recencyWeight,
        filter: args.filter,
        resultIds: data.map((t) => t.id),
        resultScores: data.map((t) => t.score ?? null),
      });
    } catch {
      // best-effort: a log failure must never reach the caller.
    }
  };
  // `tool` is the action's kind as well as its writer. A plain tool name —
  // `fetch`, `update_thought`, `delete_thought` — says the caller opened or
  // touched the target (034's click-through). `<writer>/<pointer>` —
  // `capture_thought/derived_from`, `capture_thought/supersedes`,
  // `update_thought/supersedes` — says the writer named the target as a source
  // and the database accepted the pointer (SMD-1719's cite). evals/utilization.ts
  // splits cited from opened on the `/` alone, so a new writer that cites names
  // itself the same way and is counted without a code change there.
  const logActionCalls = async (rows: { tool: string; targetId: string }[]): Promise<void> => {
    if (!queryLogEnabled(env()) || rows.length === 0) return;
    try {
      // One round trip and one writer for the batch, whatever its size: a
      // synthesis citing forty sources is forty rows in one INSERT, not forty
      // on the pool, and there is one INSERT shape per store to keep right,
      // no single-row twin to drift from it. Best-effort as a whole: a
      // failure drops the batch, never the write it followed.
      await (await db()).logActions(rows.map((r) => ({ tool: r.tool, agentId: principal.agentId, targetId: r.targetId })));
    } catch {
      // best-effort.
    }
  };
  const logActionCall = (tool: string, targetId: string): Promise<void> => logActionCalls([{ tool, targetId }]);
  // The cite rows of one write: one per distinct id it named as a source,
  // lower-cased before the dedup (UUID_RE admits either case, and two spellings
  // of one id are one cite), tool `<writer>/<pointer>`, first pointer wins for
  // an id named twice. Returns the rows so a caller can batch them with its own.
  const citeRows = (writer: string, pointers: { derived_from?: string[]; supersedes?: string }): { tool: string; targetId: string }[] => {
    const rows = new Map<string, string>();
    for (const id of pointers.derived_from ?? []) rows.set(id.toLowerCase(), `${writer}/derived_from`);
    if (pointers.supersedes) {
      const id = pointers.supersedes.toLowerCase();
      if (!rows.has(id)) rows.set(id, `${writer}/supersedes`);
    }
    return [...rows].map(([targetId, tool]) => ({ tool, targetId }));
  };

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
        // The query text leaves for its embedding as a thought's does (SMD-1903).
        const q = gateQuery(query, principal);
        if (q.refused) return toolError(q.refused);
        const qEmb = await getEmbedding(query, q.subject, "query");
        const data = await (await db()).hybridThoughts({
          query,
          embedding: qEmb,
          // 0, not 0.5 (SMD-1300): admission is relative to the top match now
          // (migration 027), so sending a low absolute floor lets it govern.
          // This tool takes no threshold from the caller, so it could not follow
          // the fix any other way — the whole point of the ticket's step 3.
          threshold: 0,
          limit: 10,
          filter: {},
          recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT,
        });

        await logSearchCall("search", { query, limit: 10, threshold: 0, recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT, filter: {} }, data);

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

        // Click-through relevance (034): the caller opened this id after a
        // search. Only on a hit — a fetch of a missing id labels nothing.
        await logActionCall("fetch", id);

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
        // Default 0, not 0.5 (SMD-1300): admission is now RELATIVE to the top
        // match (migration 027 keeps every row within half of the best result's
        // similarity), because an absolute floor drops the right answer on a
        // long capture — it scores low cosine against a short question. This
        // value is an OPTIONAL absolute minimum layered on top; 0 lets the
        // relative cutoff govern. An exact hit on an identifier or quoted span
        // is exempt either way (017).
        threshold: z.number().optional().default(0)
          .describe("Optional absolute minimum similarity, 0-1, on top of the relative cutoff (results are kept within half of the best match's similarity). 0 (default) lets the relative cutoff decide. An exact hit on an identifier or quoted span from the query is exempt."),
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
        // The query text leaves for its embedding as a thought's does (SMD-1903).
        const q = gateQuery(query, principal);
        if (q.refused) return toolError(q.refused);
        const qEmb = await getEmbedding(query, q.subject, "query");
        const data = await (await db()).hybridThoughts({
          query,
          embedding: qEmb,
          threshold,
          limit,
          filter: {},
          recencyWeight: recency_weight,
        });

        await logSearchCall("search_thoughts", { query, limit, threshold, recencyWeight: recency_weight, filter: {} }, data);

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

        // 025 (SMD-1253): which of these hits a newer thought has superseded,
        // and by which. One extra query; the labelling half of the retrieval
        // decision (the ranking change is gated on eval-supersession.ts). A hit
        // ranked beside the version that replaced it is the failure this ticket
        // is about — say so on the row rather than let it pass as current.
        const superseded = await (await db()).supersededAmong(data.map((t) => t.id));

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
            ];
            // 025: mark a hit a newer thought replaces, and name the replacement,
            // so the reader is not left ranking a superseded version as current.
            if (superseded[t.id]) parts.push(`⚠ Superseded by a newer thought — ID ${superseded[t.id]}`);
            // SMD-1328: an undated row shows no Captured line rather than a
            // fabricated 1/1/1970; infinity/a no-ISO-form date shows its text.
            const captured = displayDate(t.created_at);
            parts.push(
              ...(captured ? [`Captured: ${captured}`] : []),
              `Type: ${m.type || "unknown"}`,
            );
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
          // SMD-1328: as the search block above — absent, not a fake 1970.
          const captured = displayDate(t.created_at);
          const parts = [
            `--- Result ${offset + i + 1} (${t.occurrences} occurrence${t.occurrences === 1 ? "" : "s"}) ---`,
            `ID: ${t.id}`,
            ...(captured ? [`Captured: ${captured}`] : []),
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

        // 025 (SMD-1253): mark the listed thoughts a newer thought supersedes,
        // and name the replacement — the same label search_thoughts prints.
        const superseded = await (await db()).supersededAmong(data.map((t) => t.id));

        const results = data.map(
          (t, i) => {
            // `data` is ThoughtListItem[] — id, content, metadata, created_at all
            // inferred, as the search_thoughts map is written.
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            // An `ID:` line, the same label the two search tools print — it is what
            // update_thought and delete_thought take. This compact format has no
            // header group, so it trails the content. SMD-1248.
            const mark = superseded[t.id] ? `\n   ⚠ Superseded by a newer thought — ID ${superseded[t.id]}` : "";
            // SMD-1328: the date bracket is structural here, so an undated row
            // reads `[undated]` (never `[1/1/1970]`); a sentinel shows its text.
            return `${i + 1}. [${displayDate(t.created_at) ?? "undated"}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}\n   ID: ${t.id}${mark}`;
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

  // Tool 2b: the supersession review queue (migration 029, SMD-1294)
  server.registerTool(
    "list_supersession_proposals",
    {
      title: "List Supersession Proposals",
      description:
        "List the pairs of thoughts the consolidation pass (db/consolidate.ts) judged to CONFLICT — a decision and its reversal, a value and its update — with its verdict on which is current. Nothing is applied until a reviewer accepts a proposal (`cd db && bun consolidate.ts --url $DATABASE_URL --accept <proposal id>`), which sets `supersedes` on the current thought so search labels the other as superseded. Pending by default; `status` lists accepted or rejected ones, or all.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        status: z.enum(["pending", "accepted", "rejected", "all"]).optional().default("pending"),
        limit: z.number().int().min(1).max(200).optional().default(10),
      },
    },
    async ({ status, limit }) => {
      try {
        const data = await (await db()).listSupersessionProposals({ status: status === "all" ? null : status, limit });
        if (!data.length) {
          return { content: [{ type: "text" as const, text: `No ${status === "all" ? "" : status + " "}supersession proposals. The consolidation pass proposes them: cd db && bun consolidate.ts --url $DATABASE_URL (after db/extract-entities.ts, which it pairs thoughts by).` }] };
        }
        // SMD-1803: through displayDate, never new Date() on a raw column — an
        // undated thought reads "undated", an infinity/BC one its own text, not
        // a fabricated 12/31/1969 or "Invalid Date". (older/newer.created_at are
        // string | null now; judgedAt/reviewedAt are non-null where rendered.)
        const day = (d: string | null) => displayDate(d) ?? "undated";
        // Thought content and the judge's reason are untrusted text; snipText
        // is the one cleaner every reply quotes a thought through.
        const snip = (c: string) => snipText(c, 200);
        const phrase = (v: string) =>
          v === "newer_supersedes_older" ? "the NEWER thought supersedes the older"
          : v === "older_supersedes_newer" ? "the OLDER thought supersedes the newer"
          : "conflict, direction not stated — accepting needs --direction newer or older";
        const results = data.map((p, i) => {
          const edited = p.older.edited || p.newer.edited;
          const dir = p.verdict === "conflict_undirected" ? " --direction <newer|older>" : "";
          const review = p.status === "pending"
            ? `   accept: cd db && bun consolidate.ts --url $DATABASE_URL --accept ${p.id}${dir}${edited ? " --force" : ""}   reject: … --reject ${p.id}` +
              (edited ? "\n   (a thought was edited after the pair was judged, so the verdict is about an earlier text; --force accepts it anyway)" : "")
            : `   ${p.status}${p.reviewedAt ? ` on ${day(p.reviewedAt)}` : ""}${p.reviewNote ? `: ${cleanForDisplay(p.reviewNote)}` : ""}`;
          return `${i + 1}. [confidence ${p.confidence.toFixed(2)}] ${phrase(p.verdict)}${p.reason ? `\n   ${cleanForDisplay(p.reason)}` : ""}` +
            `\n   newer [${day(p.newer.created_at)}]${p.newer.edited ? " (edited since judged)" : ""}: ${snip(p.newer.content)}\n      ID: ${p.newer.id}` +
            `\n   older [${day(p.older.created_at)}]${p.older.edited ? " (edited since judged)" : ""}: ${snip(p.older.content)}\n      ID: ${p.older.id}` +
            `\n   proposal ${p.id} — judged by ${p.judgeKey} on ${day(p.judgedAt)}\n${review}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${data.length} ${status === "all" ? "" : status + " "}supersession proposal(s), most confident first. The pass proposes; nothing is written to a thought until a proposal is accepted.\n\n${results.join("\n\n")}`,
          }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        const hint = /list_supersession_proposals|supersession_proposals/.test(msg)
          ? " — migration 029 (db/migrations/029_supersession_proposals.sql) is not applied, or PostgREST has not reloaded its schema cache"
          : "";
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}${hint}` }],
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

        // The store aggregates. On the SQL path that is migration 024's
        // thought_stats_summary() over the whole corpus in one statement; on
        // PostgREST it is the capped page walk. Either way we get the total, the
        // date range, and the count maps, plus how many rows the breakdowns
        // actually cover — this tool only renders them. (See store.ts:ThoughtStats.)
        const { total, oldest, newest, types, topics, people, aggregated } =
          await store.statsSummary();

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${total}`,
          `Date range: ${
            // SMD-1328: min/max already skip NULLs (024), so a real range here
            // is two real dates; displayDate keeps an infinity edge legible.
            newest && oldest
              ? `${displayDate(oldest)} → ${displayDate(newest)}`
              : "N/A"
          }`,
        ];

        // Never report aggregates as corpus-wide when they are not. The SQL path
        // covers the whole corpus (aggregated === total) and this never fires; a
        // capped PostgREST walk that stopped short says so rather than quietly
        // under-reporting.
        if (aggregated < total) {
          lines.push(
            `Note: breakdowns below cover the ${aggregated.toLocaleString()} most recent thoughts, ` +
              `not all ${total.toLocaleString()}.`
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
        // Migration 025 (SMD-1253). Both optional; a first-hand capture sets
        // neither. Validated at the write — an id that is not an existing thought
        // is refused, so a synthesis cannot claim a source it does not have.
        derived_from: z.array(z.string()).optional()
          .describe("For a thought SYNTHESISED from others (a digest, consolidation, summary): the ids of the source thoughts it was built from. Each must be an existing thought id (from a search or capture result). Recorded when the thought is new; if this text was already captured, the existing thought's provenance is left as it is."),
        supersedes: z.string().optional()
          .describe("The id of a prior thought this one REPLACES (a corrected or updated version). Search will label the older thought as superseded. Recorded when the thought is new; for text already captured, use update_thought's `supersedes` on that thought instead."),
      },
    },
    async ({ content, derived_from, supersedes }) => {
      try {
        // The shape before the two model calls, in the tool's words — as
        // update_thought's `supersedes` is refused (032). upsert_thought would
        // raise on it after the embedding and the metadata were already paid for.
        if (supersedes !== undefined && !UUID_RE.test(supersedes)) return toolError(refuseSupersedesShape(supersedes));
        // derived_from's SHAPE likewise (fourth review pass): a non-id element
        // paid both model calls before validate_derived_from refused it.
        // Existence stays the write's.
        const badDerived = derived_from?.find((d) => !UUID_RE.test(d));
        if (badDerived !== undefined) return toolError(`Refused: every \`derived_from\` entry must be a thought id (the ID: line of a search result), not "${badDerived.slice(0, 40)}".`);
        // What may leave the box (SMD-1903): asked once, for both calls, and
        // only the allowed ones are made — a refused capture costs no request
        // and lands all the same, without the vector or the tags the refused
        // call would have produced, with the decision on its audit row.
        const cfg = embedConfig();
        const subject: EgressSubject = { kind: "capture", actor: principal.name, metadata: { source: "mcp" }, content };
        const gate = decideCalls(subject, cfg, cfg.egress);
        // Independent of each other, so they overlap.
        const [embedded, metadata] = await Promise.all([
          gate.embeddings.allowed ? embedCapture(content, subject) : Promise.resolve(undefined),
          gate.chat.allowed ? extractMetadata(content, subject) : Promise.resolve(metadataRefused()),
        ]);
        const chunks = embedded?.chunks ?? [];
        const contextFailures = embedded?.contextFailures ?? 0;

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
          // of writing, which a later rename would otherwise erase. `via` is
          // this server, the door (045's origin column); the row's source is
          // its own metadata.source, "mcp" above, which the trigger reads
          // itself (SMD-1730).
          actor: {
            name: principal.name,
            agentId: principal.agentId,
            via: SERVER_NAME,
            // The gate's decisions for this write, on the audit row (SMD-1903);
            // absent when both endpoints are declared local and nothing was judged.
            ...(gate.record ? { egress: gate.record } : {}),
          },
          // NULL when the gate refused the embedding call: the row lands with
          // its text and fingerprint and no vector, as the reply says.
          embedding: embedded?.embedding ?? null,
          // The model this vector came from, recorded on the row (021) — the
          // one the embedder used, not the one ob1_config records: they differ
          // exactly while a re-embed to another model is under way.
          embeddingModel: embedded?.model,
          // 025: provenance, if the caller named any. upsert_thought validates
          // derived_from and refuses a bad reference, so a malformed value
          // fails the capture with a clear message rather than storing a lie.
          derivedFrom: derived_from,
          supersedes,
        });

        // Memory utilization (SMD-1719, over 034's log): a capture that names a
        // returned id as its source — `derived_from`, or `supersedes` — is the
        // caller USING a search result in a write, the signal MERIT calls memory
        // utilization and this fork's fetch/edit/delete rows cannot carry (they
        // say the caller looked, not that the fact reached a write). A cite row
        // is a pointer the database ACCEPTED: on a fresh row upsert_thought
        // validated every id (a ghost or a loop threw, and nothing reaches
        // here); on a re-capture (`existed`) 035 wrote no pointer and validated
        // none, so nothing is logged — the note below sends the caller to
        // update_thought, which logs the cite when it writes the pointer. The
        // store says `existed: false` only when 035's function answered; a
        // brain without 035 reports nothing, and nothing is logged there
        // either (second review pass: `!== true` had read an absent flag as
        // "fresh" on the one schema where the pointer's fate is unknown). The
        // vector attaching or not does not change what was written.
        if (captured.existed === false) {
          await logActionCalls(citeRows("capture_thought", { derived_from, supersedes }));
        }

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

        // The gate's refusal first among the notes (SMD-1903): a thought
        // without its vector is the one fact a caller must not miss. Not an
        // error — the policy did what it says — but said in full. On a
        // RE-CAPTURE the row keeps the vector it had (upsert_thought
        // coalesces), so the note says that instead of "no vector" (first
        // review pass). A database from before 035, or the PostgREST
        // two-step, does not say which this was — and the coalesce holds
        // there too (033), so the note hedges rather than tell the fresh-row
        // story of a row that may be keeping its vector (second review pass).
        const existed = captured.existed;
        if (!gate.embeddings.allowed) {
          confirmation += existed === true
            ? `\n\nNote: the embedding call for this capture was not made — ${gate.embeddings.reason}. This text was already a thought, and it keeps the vector it had.`
            : existed === false
              ? `\n\nNote: saved WITHOUT a vector — ${gate.embeddings.reason}. ` +
                `It is findable by exact text (search_thoughts_keyword) and joins semantic search after a re-embed pass ` +
                `(db/reembed.ts) against an endpoint the gate allows.`
              : `\n\nNote: the embedding call for this capture was not made — ${gate.embeddings.reason}. A new thought has no vector — findable by exact text ` +
                `(search_thoughts_keyword), filled in by a re-embed pass (db/reembed.ts) against an endpoint the gate allows; text already captured keeps the vector it had. ` +
                `This database does not say which this was.`;
        }

        // A chunk whose situating blurb could not be generated is embedded bare
        // and stored with a NULL context, which is a legitimate state and a
        // silent one. Saying so here is half of what keeps it from being silent
        // — preflight, which counts both kinds across the whole corpus, is the
        // other half.
        if (contextFailures > 0) {
          confirmation += gate.chat.allowed
            ? `\n\nNote: ${contextFailures} of ${chunks.length} search chunks were embedded without ` +
              `their situating context — the call failed, or returned a blurb too long to be one. ` +
              `They are stored and searchable; re-capture to regenerate, or check the model at ` +
              `${embedConfig().chat.base}.`
            // The blurbs are chat calls, and the gate refused the chat endpoint
            // (SMD-1903): not a model to check, and the reason is the one the
            // tagging note below carries.
            : `\n\nNote: the ${chunks.length} search chunks were embedded without their situating context — ` +
              `the blurb calls were not made: ${gate.chat.reason}. They are stored and searchable.`;
        }
        confirmation += explainHeadWindow(embedded);

        // Migration 035 (SMD-1453): a re-capture writes no provenance. The text
        // was already a thought, so the derived_from / supersedes named here
        // were not written; say so and name the edit that records it, since
        // otherwise nothing would — the trace would show nothing and no
        // error would say why.
        const derivedNamed = derived_from !== undefined && derived_from.length > 0;
        if (captured.existed === true && (derivedNamed || supersedes !== undefined)) {
          const named = [derivedNamed ? "`derived_from`" : null, supersedes !== undefined ? "`supersedes`" : null].filter(Boolean);
          // What stands, from the row's pointer the store returned beside
          // `existed` (035) — not from the caller's inputs alone, which the
          // second review pass found advising a redundant edit, a replacement
          // it did not mention, or one update_thought would refuse.
          const current = captured.supersedes ?? null;
          // Postgres hands ids back lower-case; the shape check admits either
          // case, so compare — and print — the caller's in lower case (third
          // review pass: an upper-case self-pointer slipped past to an edit
          // update_thought refuses).
          const given = supersedes?.toLowerCase();
          const advice = given === undefined ? ""
            : given === captured.id ? ` The \`supersedes\` given names the thought itself; a thought cannot supersede itself.`
            : current === given ? ` It already supersedes ${given}; there is nothing to record.`
            : current !== null ? ` It currently supersedes ${current}; to replace that pointer with ${given}, call update_thought with id ${captured.id} and \`supersedes\` ${given}; it records the pointer if that thought exists and closes no loop.`
            : ` To record that it supersedes ${given}, call update_thought with id ${captured.id} and \`supersedes\` ${given}; it records the pointer if that thought exists and closes no loop.`;
          confirmation +=
            `\n\nNote: this text was already captured as ${captured.id}, so the ${named.join(" and ")} given here ${named.length > 1 ? "were" : "was"} not written — ` +
            `a re-capture leaves an existing thought's provenance as it is.` + advice +
            (derivedNamed ? ` \`derived_from\` cannot be set on an existing thought through these tools.` : "");
        }

        // Tell the user when tags are placeholders rather than real extraction,
        // so a broken credential does not look like a successful capture. The
        // remedy names the endpoint the tagging call dialled — the chat one,
        // which since SMD-1902 need not be where the embedding went.
        if (meta.metadata_extraction_failed === "egress_denied") {
          // Not a failure to check the endpoint for: the call was not made.
          // The reason is the decision made here; providerCall's own refusal
          // (the belt) reaching this branch would mean the two disagreed,
          // which the shared function makes impossible — but say so rather
          // than print an "allowed" sentence under a refusal.
          const why = gate.chat.allowed ? "the egress gate refused the tagging call" : gate.chat.reason;
          confirmation += existed === true
            ? `\n\nNote: the tagging call for this capture was not made — ${why}. The existing thought keeps its tags; its metadata now carries the refusal marker.`
            : existed === false
              ? `\n\nNote: no topics, people or type were extracted — ${why}.`
              : `\n\nNote: the tagging call for this capture was not made — ${why}. A new thought has no topics or type; text already captured keeps its tags, with the refusal marker merged in.`;
        } else if (typeof meta.metadata_extraction_failed === "string") {
          confirmation +=
            `\n\nNote: the thought was saved, but automatic tagging failed ` +
            `(${meta.metadata_extraction_failed}) — topics and people are placeholders. ` +
            `Check the chat endpoint (${embedConfig().chat.base}), its credential, and the server logs.`;
        }

        return {
          content: [{ type: "text" as const, text: confirmation }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // 025's self-FK is what refuses a first capture's supersedes naming no
        // thought (a re-capture writes no pointer, so it never fires there —
        // migration 035). Said as update_thought says it, not as Postgres does
        // (fourth review pass).
        if (/thoughts_supersedes_fkey/.test(msg)) return toolError("Refused: no thought with the id given as supersedes. Pass the id of an existing thought — the ID: line of a search result.");
        // Its sibling: validate_derived_from's existence refusal (032), the
        // one provenance refusal that still reached the caller as a raw error
        // (fifth review pass).
        if (/derived_from references a thought that does not exist/.test(msg)) return toolError(`Refused: a \`derived_from\` id names no thought — ${msg.replace(/^.*?\(in /, "(in ").replace(/\.$/, "")}. Each must be an existing thought id (the ID: line of a search result).`);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
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
        "Correct or amend an existing thought by id. `search_thoughts`, `search_thoughts_keyword`, and `list_thoughts` print the id on an `ID:` line under each hit, and `capture_thought` reports it when it saves — so a thought found by search can be edited without re-capturing it. Provide `content` to replace the text — the embedding and its search chunks are regenerated to match. Provide `metadata_patch` to shallow-merge keys into the existing metadata, leaving unmentioned keys alone. Provide `supersedes` to record that this thought REPLACES an older one (search will label the older as superseded), or `null` to clear a pointer set wrongly. Pass `if_unchanged_since` with the `updated_at` you last read to avoid overwriting a concurrent edit.",
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
        // Migration 032 (SMD-1323): the visible half of the provenance
        // envelope. Tri-state: absent leaves the pointer, null clears it, an
        // id sets it — validated at the write (an id no thought has, or a
        // pointer that would close a loop, is refused by name). derived_from
        // is not offered here: an edit to a synthesis's source list is a
        // store-level operation with no client asking for it yet.
        supersedes: z.string().nullable().optional()
          .describe("The id of a prior thought this one REPLACES (a corrected or updated version), as capture_thought's `supersedes`; search will label the older thought as superseded. Pass null to clear a pointer recorded wrongly. Omit to leave it as it is."),
      },
    },
    async ({ id, content, metadata_patch, if_unchanged_since, supersedes }) => {
      try {
        if (content === undefined && metadata_patch === undefined && supersedes === undefined) {
          return toolError("Provide `content`, `metadata_patch`, `supersedes`, or any of them — an update with none would do nothing.");
        }
        // The shape here, in the tool's words, as the two named refusals are;
        // the function would raise on it, and a raised message reads as a
        // failure rather than a refusal. The string "null" is not a clear —
        // clearing is JSON null, and a client that sends the word meant an id.
        if (typeof supersedes === "string" && !UUID_RE.test(supersedes)) return toolError(refuseSupersedesShape(supersedes, " or null to clear it"));

        // Only re-embed when the text actually changed. A metadata-only edit
        // must not spend two model calls, nor risk replacing a good vector.
        // The gate as at capture (SMD-1903), asked only when the text moves:
        // refused, the new text is stored and the stale vector cleared with it
        // (update_thought's rule: content and no vector is NULL), and the
        // reply says so.
        // The subject is the ROW — its own source, type and topics, which a
        // capture cannot know but an edit can: one read, only when the text
        // moves (first review pass: an edit judged under the capture's bare
        // {source: "mcp"} let a row a type: or source: term names slip past).
        // A row that is not there is judged as bare and refused by the write.
        const cfg = embedConfig();
        const existing = content !== undefined ? await (await db()).getThought(id) : null;
        const subject: EgressSubject = { kind: "edit", actor: principal.name, metadata: existing?.metadata ?? { source: "mcp" }, content };
        const gate = content !== undefined ? decideCalls(subject, cfg, cfg.egress) : undefined;
        const embedded = content !== undefined && gate?.embeddings.allowed ? await embedCapture(content, subject) : undefined;

        const result = await (await db()).updateThought({
          id,
          content,
          metadataPatch: metadata_patch,
          embedding: embedded?.embedding,
          chunks: embedded?.chunks,
          ifUnchangedSince: if_unchanged_since,
          actor: { name: principal.name, agentId: principal.agentId, via: SERVER_NAME, ...(gate?.record ? { egress: gate.record } : {}) },
          // Read by update_thought only with content, when the vector moves (021).
          embeddingModel: embedded?.model,
          // 032: only the key the caller named reaches the envelope — absent
          // must stay absent, since null means CLEAR at the function.
          provenance: supersedes !== undefined ? { supersedes } : undefined,
        });

        if (!result.ok) return toolError(explainRefusal(result, id));

        // Click-through relevance (034): the caller edited this id after a
        // search. Only on a written edit, not a refusal. SMD-1719: an edit that
        // sets `supersedes` also names a returned id as this thought's source —
        // the same act as a capture's pointer, and the path capture_thought's
        // re-capture note sends the caller down. The function accepted the
        // pointer (a ghost or a loop was refused above), so it is a cite of the
        // SUPERSEDED id; the edited id stays "opened". One batch, one round trip.
        await logActionCalls([
          { tool: "update_thought", targetId: id },
          ...(typeof supersedes === "string" ? citeRows("update_thought", { supersedes }) : []),
        ]);

        const what = [
          content !== undefined ? (gate?.embeddings.allowed ? "content re-embedded" : "content saved without a vector") : null,
          metadata_patch !== undefined ? "metadata merged" : null,
          supersedes === null ? "supersedes cleared" : supersedes !== undefined ? `now supersedes ${supersedes}` : null,
          // An edit replaces every chunk, so a failure here leaves the SAME
          // half-contextualized state a capture can, and is worth the same
          // sentence rather than a silent partial rewrite.
          embedded?.contextFailures ? `${embedded.contextFailures} chunks without context` : null,
        ].filter(Boolean).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `Updated ${id} (${what}).\nupdated_at: ${result.updatedAt}\nPass that value as if_unchanged_since on your next edit.${explainPair(result)}${explainHeadWindow(embedded)}${
              gate && !gate.embeddings.allowed
                ? `\n\nNote: saved WITHOUT a vector — ${gate.embeddings.reason}. It is findable by exact text and joins semantic search after a re-embed pass (db/reembed.ts) against an endpoint the gate allows.`
                : ""}`,
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
        "Permanently remove a thought by id, along with its search chunks. `search_thoughts`, `search_thoughts_keyword`, and `list_thoughts` print the id on an `ID:` line under each hit, and `capture_thought` reports it when it saves; read the thought back first to confirm it is the one to remove. The deletion is recorded in the audit trail with the thought's previous content, so it can be reconstructed if removed in error. Refused while statements in other thoughts cite this one as their source — the reply names them — unless `detach_citations` is true.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.string().describe("UUID of the thought to delete — the id on an `ID:` line of a search_thoughts, search_thoughts_keyword, or list_thoughts result, or the one capture_thought reported when it saved"),
        detach_citations: z.boolean().optional().describe(
          "When statements in other thoughts cite this one as their source, the delete is refused and the reply names them. Pass true to delete anyway: each citation keeps its text and stance, loses its source, and records this id and the time as the deleted source. Default false.",
        ),
      },
    },
    async ({ id, detach_citations }) => {
      try {
        const result = await (await db()).deleteThought({
          id,
          actor: { name: principal.name, agentId: principal.agentId, via: SERVER_NAME },
          // 042: the refusal is the default; the way through is named here.
          detach: detach_citations === true,
        });
        if (!result.ok) return toolError(explainRefusal(result, id));

        // Click-through relevance (034): the caller deleted this id after a
        // search — a strong signal it was the one they meant. Only on success.
        await logActionCall("delete_thought", id);

        return {
          content: [{
            type: "text" as const,
            text: `Deleted ${id}. Its previous content is preserved in the audit trail.${explainDetached(result, id)}`,
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

// The methods the MCP endpoint serves. The transport is offered POST only: it is
// built per request and is sessionless, so there is no server stream for a GET
// to open and no session for a DELETE to end. One list registers the handler
// and names the 405's `Allow`, so the two cannot drift. FORK.md change 75.
const MCP_METHODS = ["POST"];
const ALLOWED_METHODS = [...MCP_METHODS, "OPTIONS"].join(", ");
// A health path serves GET and HEAD (the route below) AND the MCP methods, since
// the MCP handler is registered at every path. Derived from the same list.
const HEALTH_ALLOWED_METHODS = ["GET", "HEAD", ...MCP_METHODS, "OPTIONS"].join(", ");

// The CORS list is a different question — what a browser may send so it can
// hear our answer — so it keeps GET and DELETE: a browser-hosted SDK client
// given a session id by its constructor sends DELETE from terminateSession()
// and accepts the 405 it gets here; a preflight that hid DELETE would turn that
// into a network error instead.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, x-access-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// The two 405 header sets, built once; the refusal path spreads nothing per request.
const METHOD_NOT_ALLOWED_HEADERS = { ...corsHeaders, Allow: ALLOWED_METHODS };
const HEALTH_METHOD_NOT_ALLOWED_HEADERS = { ...corsHeaders, Allow: HEALTH_ALLOWED_METHODS };

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
 * Read the request body as text. This CONSUMES the body: both callers return a
 * refusal right after, so nothing downstream needs it. Returns null on read
 * failure. No
 * bodyless-method branch: `req.text()` on a request without a body resolves to
 * "", and extractJsonRpcId("") is null, so the method never mattered here.
 */
async function readBodyText(req: Request): Promise<string | null> {
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
// 200 + JSON-RPC envelope, or notFound's 405 (change 75; before it, the GET
// reached the transport and hung) — sends it into a Dynamic Client
// Registration it cannot complete. Upstream cannot fix this on
// Supabase, where the gateway answers the path first (#340); we own the route
// table. Ordered after the OPTIONS preflight and before the MCP handler, so it
// runs before authenticate() and the agent resolve — the answer is about the
// server, not the caller, and a revoked key gets the same 404. Terminal for the
// whole prefix: a future /.well-known/ route (real RFC 9728 metadata, say) must
// be registered ABOVE this line or it never fires. FORK.md change 42.
app.all("/.well-known/*", (c) => c.text("Not Found", 404, corsHeaders));

// Liveness for platform probes (Kubernetes httpGet, load-balancer target checks,
// uptime monitors), which can only GET and expect 2xx — the MCP endpoint answers
// GET with 405 (below). Before authenticate(), like /.well-known/*: it says the
// process is serving and nothing else. Readiness — is the database reachable —
// is preflight's job at the entrypoint. HEAD is routed here as GET by Hono, so a
// HEAD probe gets a bodiless 200. Matched as the last path segment under any
// prefix a proxy leaves on the request (`/mcp/health`,
// `/functions/v1/open-brain-mcp/health`) except `/.well-known/`, which the
// route above owns, with at most one trailing slash —
// deploy/README.md anticipates an unstripped prefix, and a probe aimed at
// `<base>/health` must not 405 there. The breadth ("health under anything") is
// a stand-in for a base-path setting the server does not have; a mount (the
// path-axis decision change 42 defers) would match `${base}/health` exactly.
// The name is exact after Hono's decodeURI (`/he%61lth` is it; /healthz and
// /Health are not; an encoded slash `%2F` stays encoded and is not a slash; an
// empty segment `//health` passes). Tested against the path rather than
// written as a route pattern because on Hono 4.9.2 a `:param` route that shares
// the root with a static route (`/.well-known/*` here) makes the RegExpRouter
// throw UnsupportedPathError at registration, SmartRouter then falls back to
// the TrieRouter, and the TrieRouter miscounts a `{.+}` prefix of three or more
// segments — so `/:prefix{.+}/health` matched `/a/b/health` and not
// `/functions/v1/open-brain-mcp/health`. Anything else falls through to
// notFound's 405. POST /health is the MCP endpoint, as POST at every path is.
// FORK.md change 75.
const HEALTH_PATH = /(^|\/)health\/?$/;
app.get("*", async (c, next) => (HEALTH_PATH.test(c.req.path) ? c.text("ok", 200, corsHeaders) : next()));

// The MCP endpoint, registered for MCP_METHODS only. The transport is built per
// request and is sessionless, so a GET has no server stream to open: before
// change 75 an authenticated GET cost an agent-registry resolve and a server
// build, then reached the transport, which opened an SSE stream nothing wrote
// to — pinged every 30 s, closed only by the client or by Bun's idle reset —
// from a browser opening the connector URL or any client echoing `?key=` on GET
// (upstream #424). The SDK client sets `Accept: text/event-stream` on its own
// GET, so gating the Accept patch this handler carried then (change 84 removed
// it) would not have been enough; it treats the 405 notFound gives as "no
// stream here". FORK.md change 75.
app.on(MCP_METHODS, "*", async (c) => {
  // Accept the access key via header, bearer token OR URL query parameter — every
  // form presented is tried, so a gateway's own bearer token beside the client's
  // `?key=` does not shadow it. The query form stays because Claude Desktop
  // custom connectors are URL-only; scopes are what limit the damage when such a
  // URL leaks. See auth.ts.
  const principal = authenticateRequest(c.req.raw, {
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

  const server = buildServer(principal);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

// Whatever no route above matched: 405 with `Allow`, before authenticate(), so
// no key shape reaches the agent registry or builds a server and the answer is
// the same for no key, a wrong key and a revoked one. Since the MCP handler
// serves POST at every path, an unmatched request is always a method the
// endpoint does not serve, never an unknown path — hence 405, not 404. This is
// where GET, HEAD, PUT, PATCH and DELETE land; a keyless GET or HEAD used to get
// the 200 JSON-RPC refusal, so a platform probe uses /health above. Hono's
// notFound rather than a trailing app.all("*"), so a route registered later is
// not silently shadowed by dispatch order. `Allow` names the target resource's
// methods (RFC 9110 §10.2.1): at a health path, GET and HEAD beside the MCP
// methods. FORK.md change 75.
app.notFound((c) =>
  c.text("Method Not Allowed", 405, HEALTH_PATH.test(c.req.path) ? HEALTH_METHOD_NOT_ALLOWED_HEADERS : METHOD_NOT_ALLOWED_HEADERS),
);

export default {
  // Workers reads `fetch`; Bun also reads `port`. Node uses @hono/node-server.
  port: Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PORT ?? 8000),
  fetch: app.fetch,
};