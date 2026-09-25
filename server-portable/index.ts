
import { displayDate, thoughtTitle, thoughtUrl, THOUGHT_TYPES } from "./thoughts.ts";
import { cleanForDisplay } from "./consolidate.ts";
import { createEmbedder, resolveEmbedConfig, type EmbedConfig, type EmbedKind, type EmbeddedCapture } from "./embed.ts";
import { extractMetadata as extractMetadataWith, metadataRefused, TAG_KEYS } from "./metadata.ts";
import { decideCalls, mayLeaveBox, type EgressDecision, type EgressSubject } from "./egress.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, postgrestOnBunNotice, storeKind, UUID_RE, type AuditChange, type Citation, type ThoughtStore, type ThoughtHybridMatch, type ThoughtKeywordMatch } from "./store.ts";
import { queryLogEnabled, tierProblem, trimmedEnv } from "../db/config.mjs";
import { authenticateRequest, canCapture, canRead, canWrite, SCOPES, type Principal } from "./auth.ts";
import { AgentResolver, cacheTtlFromEnv } from "./agents.ts";
import { FORK_VERSION, LATEST_MIGRATION, RELEASE_RANGE } from "./version.ts";
import { brainInfo, renderBrainInfo, type BrainInfo, type ReadOptions, type ServerFacts } from "./brain-info.ts";

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
   * Estimated tokens of thought text per entity-extraction call
   * (db/extract-entities.ts; SMD-1879). Unset, derived from the METADATA
   * model's served context (db/config.mjs, KNOWN_CHAT_MODEL_WINDOW) and never
   * above entities.ts's measured default. The server never extracts; preflight,
   * which runs in this container, prints the rule and where it came from.
   */
  OB1_EXTRACT_CHUNK_TOKENS?: string;
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
  /**
   * Which pipeline tier this server runs as (SMD-1806): stable | canary |
   * working. Stamped onto every query_log row the server writes, so the canary
   * — which replays stable's log — can tell a stable-written row from its own.
   * Unset is a plain brain (the row's tier is NULL); the tiers are one corpus
   * read through three schemas with one writer per tier. Read here as well as by
   * db/ingest-records.ts (which stamps ob1_config.tier) and preflight's `tier`.
   */
  OB1_TIER?: string;
  /**
   * The commit the image was built from — baked by server-portable/Dockerfile
   * from its OB1_GIT_SHA build arg, never forwarded at runtime (compose passes
   * the build arg; check 14 excuses the forward). Reported by brain_info and
   * the keyed /health body (SMD-2041); unset reads as `unknown`.
   */
  OB1_GIT_SHA?: string;
  /** Model for metadata extraction. No schema dependency — safe to change anytime. */
  OB1_METADATA_MODEL?: string;
  /** The supersession judge's model (db/consolidate.ts), when it is not OB1_METADATA_MODEL; the server never judges, but embed.ts reads one Env (SMD-1901). */
  OB1_JUDGE_MODEL?: string;
  /**
   * The typed-decision tier (jev.ts, SMD-2050): where it is served, the model
   * the caller expects, and 1/on when that endpoint is on this box (declared,
   * as OB1_LLM_LOCAL is). The server never decides; preflight, which runs in
   * this container, checks the tier when OB1_JEV_BASE_URL is set.
   */
  OB1_JEV_BASE_URL?: string;
  OB1_JEV_MODEL?: string;
  OB1_JEV_LOCAL?: string;
  /** Sampling temperature for extraction. Defaults to 0 — metadata.ts's extractMetadata says why; embed.ts's resolveEmbedConfig owns the default. */
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
  const candidate = trimmedEnv({ ...globals, ...(bindings ?? {}) }) as Env;
  // A wrong OB1_TIER (e.g. "Stable", "prod") fails migration 045's query_log.tier
  // CHECK, and the best-effort log write swallows the error — silently dropping
  // every query_log row and emptying SMD-1806's canary replay. Refuse it here,
  // at the one place the env is frozen, rather than lean on the DB CHECK. The
  // container also gates it earlier (preflight, the entrypoint's first command);
  // this covers Workers and any direct `bun index.ts` (SMD-1953).
  //
  // Validate BEFORE assigning ENV: the `if (ENV) return` above means a value
  // assigned here sticks, so throwing after assignment would fire on the first
  // call and then let every later call skip the guard — the bad tier would reach
  // the log write on the second request. Leaving ENV null on a bad value makes
  // every call re-run and re-throw.
  const tierIssue = tierProblem(candidate.OB1_TIER);
  if (tierIssue) throw new Error(tierIssue);
  ENV = candidate;
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

// What this brain is (SMD-2041): the server's own facts beside the database's,
// one read under the brain_info tool and the keyed /health body.
function serverFacts(): ServerFacts {
  const cfg = embedConfig();
  return {
    version: FORK_VERSION,
    releaseRange: RELEASE_RANGE,
    latestMigration: LATEST_MIGRATION,
    commit: env().OB1_GIT_SHA || "unknown",
    store: storeKind(env()),
    tier: env().OB1_TIER || null,
    embedding: { model: cfg.embeddingModel, dim: cfg.embeddingDim },
  };
}
// Bounded (review pass 1: a keyed probe at an unreachable database waited out
// the driver's 30-second connect and got no reply). The health body answers
// within a probe's usual timeout — its statements capped to fit, so a few
// locked tables cost their lock waits and not the whole record (review pass
// 2); the tool, kept alive by its stream (SMD-1864), waits longer for a large
// brain's counts, at brain-info.ts's default ceilings.
export const HEALTH_DEADLINE_MS = 2_500;
export const BRAIN_INFO_TOOL_DEADLINE_MS = 15_000;
type Surface = "health" | "tool";
const SURFACES: Record<Surface, { deadlineMs: number; opts: ReadOptions }> = {
  health: { deadlineMs: HEALTH_DEADLINE_MS, opts: { statementTimeoutMs: 800, lockTimeoutMs: 300 } },
  tool: { deadlineMs: BRAIN_INFO_TOOL_DEADLINE_MS, opts: {} },
};
// One read in flight per surface, so concurrent callers share one pool
// connection rather than taking one each (forty probes against a locked table
// once held the pool). Keyed by surface, so a probe never gets the tool's
// deadline and ceilings. Released when the answer settles: an abandoned read
// finishes its last statement within its ceiling (800 ms for health) beside the
// next caller's, and a read hung on a half-open connection pins nothing.
const inflight = new Map<Surface, Promise<BrainInfo>>();
function readBrainInfo(surface: Surface): Promise<BrainInfo> {
  const { deadlineMs, opts } = SURFACES[surface];
  const read = () => brainInfo(serverFacts(), async (progress) => (await db()).databaseFacts(opts, progress), deadlineMs);
  // Not shared on Workers (the PostgREST store): its read is a refusal with no
  // I/O to share, and a promise from one request is not another's to await.
  if (storeKind(env()) !== "sql") return read();
  const shared = inflight.get(surface);
  if (shared) return shared;
  const answer = read().finally(() => { if (inflight.get(surface) === answer) inflight.delete(surface); });
  inflight.set(surface, answer);
  return answer;
}

// Built on first use, for the same reason as the store: reading env() at module
// scope runs before initEnv() has seeded it.
let _agents: AgentResolver | null = null;
function agents(): AgentResolver {
  // Lookups are shared across requests only on the SQL store: on Workers (the
  // PostgREST store) a fetch belongs to the request that started it.
  if (!_agents) _agents = new AgentResolver(cacheTtlFromEnv(env().OB1_AGENT_CACHE_TTL_MS), Date.now, storeKind(env()) === "sql");
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
// The tag extraction is metadata.ts (shared with db/sync-linear.ts); this is
// the server's reader over it, lazy like embedConfig for the same reason.
const extractMetadata = (text: string, subject: EgressSubject) => extractMetadataWith(text, subject, embedConfig());

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
 * The shape of a `source` label a capture may carry (SMD-1298): what the egress
 * policy's `source:` term and a per-source weight can key on — lower-case, no
 * spaces, bounded. Not a vocabulary: the hook says `claude-code` or `codex`,
 * an importer says what it imports from, and the default stays `mcp`.
 */
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

// A caller-set metadata key (SMD-2014): lower-case, starts with a letter, 2-40
// characters — the shape a reader can filter on. The server owns some keys of
// `metadata`, and a caller naming one is refused rather than silently overruled
// by the merge below: `source` (the origin label, set from the `source` arg),
// the extractor's tag set (TAG_KEYS: type, topics, people…), the actor columns
// migration 050 stamps from the key, the embedding model migration 021 records,
// and the extractor's own failure marker. Everything else — `summary_model`,
// which the session hook sets when a local model wrote the summary — is the
// caller's to add.
const META_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const RESERVED_META = new Set<string>([...TAG_KEYS, "source", "actor_kind", "actor_name", "embedding_model", "metadata_extraction_failed"]);
const META_VALUE_MAX = 200;
const META_KEYS_MAX = 8;
/** The refusal for a bad `metadata` argument, or null when it is clean (or absent). Checked before the model calls, as the other shape refusals are. */
function refuseMetadataShape(metadata: Record<string, unknown> | undefined): string | null {
  if (metadata === undefined) return null;
  const keys = Object.keys(metadata);
  if (keys.length > META_KEYS_MAX) return `Refused: \`metadata\` carries ${keys.length} keys — at most ${META_KEYS_MAX}.`;
  for (const k of keys) {
    if (!META_KEY_RE.test(k)) return `Refused: the \`metadata\` key "${k.slice(0, 40)}" must be lower-case letters, digits and underscores, 2–40 characters, starting with a letter.`;
    if (RESERVED_META.has(k)) return `Refused: \`metadata.${k}\` is set by the server, not the caller — use the \`source\` argument for the origin label; drop the rest.`;
    const v = metadata[k];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return `Refused: \`metadata.${k}\` must be a string, number or boolean.`;
    if (typeof v === "string" && v.length > META_VALUE_MAX) return `Refused: \`metadata.${k}\` is ${v.length} characters — at most ${META_VALUE_MAX}.`;
  }
  return null;
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
 * thought_changes's `since` (SMD-1296): a uuid is a cursor — the audit row a
 * previous page ended with — and anything else must read as an ISO-8601 time
 * (a date at least, so a bare number is not a year), normalised so the reply
 * echoes one spelling. Neither is a refusal naming both forms, before any call.
 */
function parseSince(raw: string | undefined): { since: string | null; after: string | null } | { refused: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { since: null, after: null };
  if (UUID_RE.test(v)) return { since: null, after: v.toLowerCase() };
  const refused = { refused: `Refused: \`since\` must be an ISO-8601 time with its zone (2026-09-22T08:00:00Z), a date (2026-09-22), or the cursor a previous call ended with, not "${snipText(v, 40)}".` };
  // A date, or a date with a clock that names its zone — a clock with no Z or
  // offset would be read in the server's zone (13:00Z for 08:00 on a Chicago
  // laptop, 08:00Z in the container). Any ISO-8601 fraction (Python's
  // isoformat gives six digits) and an hour-only offset (psql prints `+00`)
  // are normalised to what Date parses: a T, three fraction digits, a colon in
  // the offset — completed only when the shape has one, since a bare date's
  // own `-01` is a day, not a zone.
  const shape = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?))?$/i.exec(v);
  if (!shape) return refused;
  // Upper-cased: the shape is matched case-blind, and a lowercase t or z is
  // ISO-8601 to JSC (Bun) but not to every Date parser the server runs on.
  let iso = v.toUpperCase().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (shape[2] && !/^z$/i.test(shape[2])) iso = iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  // The date part round-trips on its own, whatever the clock or zone beside it
  // (2026-02-30 would otherwise slide to March, at any hour), and the year
  // stays where timestamptz has room: a late time with an offset rolls past
  // 9999, an early one below 1, and either would come back as Postgres's raw
  // error (review passes 1–3).
  const day = new Date(`${shape[1]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== shape[1]) return refused;
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return refused;
  return { since: d.toISOString(), after: null };
}

/** The two metadata keys 050's trigger owns (SMD-1726): the writer's kind and name, stamped as the content moves. */
const ACTOR_MARKS: ReadonlySet<string> = new Set(["actor_kind", "actor_name"]);

/**
 * One change as a client reads it: when, what and who on the first line with
 * the thought's `ID:` (the label every read tool prints, SMD-1248, so fetch and
 * update_thought can reach what the line names); then what moved, bounded;
 * then the supersedes pointer, because "X now replaces Y" is the change a
 * resuming agent most needs. Untrusted text — a head, a metadata key — goes
 * through snipText, the one cleaner every reply quotes a thought through.
 */
function renderChange(c: AuditChange, n: number): string {
  // The full ISO form — the one spelling the header's `since` echoes, so a
  // client that checkpoints on a line's time re-reads nothing it need not.
  const when = c.createdAt;
  // Name and door are untrusted text (a writer sets its own envelope; a raw
  // INSERT sets either column), so both go through snipText: one line, and no
  // forged entry or Cursor line in a feed agents act on. No key but a door is
  // a worker that names itself alone — 050's backfill_thought_actors — and
  // reads by its door rather than as an anonymous edit.
  const who = c.actorName !== null ? `by ${snipText(c.actorName, 80)}${c.actorKind ? ` (${c.actorKind})` : ""}`
    : c.origin !== null ? `by ${snipText(c.origin, 80)} (no key)`
    : "from outside the server";
  // 050's stamp is not an edit (it holds the updated_at trigger): a row whose
  // only change is the two marks is "marked" — the backfill's row above all.
  const marksOnly = c.action === "update" && c.changed.length === 1 && c.changed[0] === "metadata" && c.metadataKeys.length > 0 && c.metadataKeys.every((k) => ACTOR_MARKS.has(k));
  const verb = c.action === "capture" ? "captured" : c.action === "update" ? (marksOnly ? "marked" : "edited") : "deleted";
  const gone = c.action !== "delete" && !c.present ? " (deleted since)" : "";
  const lines = [`${n}. ${when} — ${verb} ${who} — ID: ${c.thoughtId}${gone}`];
  const text = c.head === null ? null : snipText(c.head, 200);
  // A capture row carries no text of its own (008's capture diff is the
  // metadata), so the head is the thought's CURRENT text — say so, since an edit
  // since would otherwise read as what was captured; a deleted thought's text
  // is in its delete row, not gone (both caught: cold-read, pass 1).
  if (c.action === "capture") lines.push(text === null ? "   (the text is in its delete row)" : `   now: "${text}"`);
  if (c.action === "delete" && text !== null) lines.push(`   was: "${text}"`);
  if (c.action === "update") {
    const parts: string[] = [];
    if (c.changed.includes("content")) parts.push(text === null ? "content" : `content → "${text}"`);
    // 050 stamps the two marks into metadata whenever the content moves under
    // another key: the first line already says who, so beside a content change
    // they are not listed as keys the editor touched (a pre-050 row whose
    // caller wrote a mark of its own loses it the same way — the row cannot
    // tell the two apart; the raw diff stays reachable by the audit id). Alone
    // — the backfill's row — they are the whole change and stay. A side that is
    // not an object has no keys to name and still says "metadata".
    const keys = c.changed.includes("content") ? c.metadataKeys.filter((k) => !ACTOR_MARKS.has(k)) : c.metadataKeys;
    const bare = c.metadataKeys.length === 0;
    if (c.changed.includes("metadata") && (keys.length || bare)) parts.push(bare ? "metadata" : `metadata: ${keys.map((k) => snipText(k, 40)).join(", ")}`);
    if (c.changed.includes("embedding_present")) parts.push("embedding");
    if (parts.length) lines.push(`   ${parts.join("; ")}`);
    // 046: an unchanged edit that declared a stance, cites or a window is an
    // event with an empty diff — say so rather than print a bare header.
    else if (!c.changed.some((k) => k === "supersedes" || k === "derived_from")) lines.push("   restated — no field changed");
  }
  if (c.action === "capture" && c.supersedesAfter) lines.push(`   supersedes ${c.supersedesAfter}`);
  if (c.action === "update") {
    if (c.supersedesAfter) lines.push(`   now supersedes ${c.supersedesAfter}${c.supersedesBefore ? ` (was ${c.supersedesBefore})` : ""}`);
    else if (c.supersedesBefore) lines.push(`   no longer supersedes ${c.supersedesBefore} (pointer cleared)`);
  }
  // A point-in-time record: whether the superseded thought is current again
  // depends on what happened to it since, which this row cannot know.
  if (c.action === "delete" && c.supersedesBefore) lines.push(`   it superseded ${c.supersedesBefore}`);
  if (c.derivation) lines.push(c.action === "capture" ? "   captured with sources (derived_from)" : "   sources (derived_from) changed");
  return lines.join("\n");
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
 * write names in its actor (`via`), which migration 046 stamps as
 * thought_audit.origin (SMD-1730). One constant, so the two cannot drift.
 */
const SERVER_NAME = "open-brain";

// SMD-1490: the metadata filter a search tool exposes. Shallow by design —
// top-level keys to a scalar or an array of scalars — so `metadata @> filter`
// stays GIN-indexable and the row-level-security cost of exposing it (SMD-1625)
// is bounded, not open-ended. A nested object, or more than the caps below, is
// refused at the tool boundary rather than handed to jsonb.
const FILTER_MAX_KEYS = 20;
const FILTER_MAX_BYTES = 4096;
const filterScalar = z.union([z.string(), z.number(), z.boolean()]);
/** The zod surface of the filter argument; the caps and normalisation are parseFilter's. */
const filterInput = z
  .record(z.string(), z.union([filterScalar, z.array(filterScalar)]))
  .optional()
  .describe(
    'Optional metadata filter: an object whose top-level keys a thought\'s metadata must contain (jsonb containment). A value is a scalar or an array of scalars — {"type":"project"} keeps thoughts whose metadata.type is "project"; {"topics":["ob1"]} keeps those whose topics array contains "ob1". Nested objects are not accepted. Omit for an unfiltered search.',
  );

/**
 * Normalise and bound a metadata filter from a search tool (SMD-1490). Absent,
 * null or empty is `{}` (unfiltered). Throws on a shape the boundary should
 * refuse — a non-object, a nested object, a non-scalar value, or a filter over
 * the key/size caps — so the handler's catch turns it into a tool error rather
 * than a jsonb the store would run. Exported for the unit test.
 */
export function parseFilter(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("filter must be an object of metadata keys");
  const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > FILTER_MAX_KEYS) throw new Error(`filter has too many keys (max ${FILTER_MAX_KEYS})`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      if (!v.every(isScalar)) throw new Error(`filter.${k} must be an array of strings, numbers or booleans`);
    } else if (!isScalar(v)) {
      throw new Error(`filter.${k} must be a scalar or an array of scalars — nested objects are not accepted`);
    }
    out[k] = v;
  }
  // UTF-8 bytes, not JSON.stringify().length (UTF-16 code units) — multibyte
  // content (CJK, accents) is ~2x its code-unit count, so the code-unit check let
  // a filter past ~2x the byte bound the error names. TextEncoder is Workers-safe
  // where Buffer is not (SMD-1953).
  if (new TextEncoder().encode(JSON.stringify(out)).length > FILTER_MAX_BYTES) throw new Error(`filter is too large (max ${FILTER_MAX_BYTES} bytes)`);
  return out;
}

// SMD-1726: who wrote a thought's current text, on the read path. Migration 050
// stamps two reserved metadata keys from the write's key — `actor_kind`
// (ob1_agents.kind: operator | agent | ingested) and `actor_name` (the key's
// name) — so "only what the operator said" is the same jsonb containment every
// other filter key takes, on 014's route, and the hit can say who wrote it.
/** The three words the key registry holds (migration 046, `ob1_agents.kind`); `said_by` takes one. */
const SAID_BY = ["operator", "agent", "ingested"] as const;
const saidByInput = z.enum(SAID_BY).optional()
  .describe("Only thoughts whose current text was written through a key of this kind: operator (typed by the operator), agent (an agent's own output — a summary, a conclusion), or ingested (an importer copying outside text). Decided by the key that made the write, never by the thought's text. Omit for every writer.");
const actorInput = z.string().trim().min(1).max(200).optional()
  .describe("Only thoughts whose current text was written through the access key with this name — the name on a hit's `By:` line. Omit for every key.");

/**
 * `said_by` and `actor` folded into the metadata filter (SMD-1726): the two
 * are the keys migration 050 stamps, so the store, the query log and the plan
 * see one filter and the arguments are sugar over it. A `filter` that names
 * the same key with another value is a caller contradicting itself, refused
 * at the boundary as parseFilter refuses a nested object. Exported for the
 * unit test.
 */
export function withActorFilter(filter: Record<string, unknown>, saidBy: string | undefined, actor: string | undefined): Record<string, unknown> {
  const out = { ...filter };
  // The stamp trims the key's name (050), so the argument is trimmed here too —
  // a pasted "op-key " must find the rows op-key wrote (second review pass).
  for (const [key, value, arg] of [["actor_kind", saidBy, "said_by"], ["actor_name", actor?.trim() || undefined, "actor"]] as const) {
    if (value === undefined) continue;
    if (key in out && out[key] !== value) throw new Error(`${arg} is "${value}" but filter.${key} is ${JSON.stringify(out[key])} — pass one of the two`);
    out[key] = value;
  }
  // The caps are the filter's, so they hold over the folded object too (first
  // review pass: a 20-key filter plus the two was 22 keys the store ran).
  return parseFilter(out);
}

/**
 * The `By:` line under a hit — who wrote its current text, from the two keys
 * migration 050 stamps. Absent when the row carries neither (a write from
 * outside the server, or a brain whose backfill has not run), as `Captured:`
 * is absent for an undated row. A name with no kind is a key nobody has
 * classified yet (set_agent_kind), said so rather than guessed. The name is
 * the key's — the server's word, not the thought's — and is rendered through
 * the same cleaner every quoted text takes all the same. Exported for the
 * unit test.
 */
export function actorLine(m: Record<string, unknown>): string | null {
  const name = typeof m.actor_name === "string" && m.actor_name.trim() ? snipText(m.actor_name, 80) : null;
  const kind = typeof m.actor_kind === "string" && (SAID_BY as readonly string[]).includes(m.actor_kind) ? m.actor_kind : null;
  if (!name && !kind) return null;
  return `By: ${name ?? "an unnamed key"} (${kind ?? "kind not classified"})`;
}

function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    // The fork's version, generated from db/version.mjs (SMD-2041) — a literal
    // here said 1.0.0 from before the fork had a version scheme until 1.1.0.
    version: FORK_VERSION,
  });

  // The opt-in query log (migration 034, SMD-1295). Off unless OB1_QUERY_LOG=on,
  // and best-effort either way: a log write is never allowed to fail a search, a
  // fetch or a capture, so every call is guarded and every rejection swallowed.
  // The flag is read from the boot-time env snapshot (initEnv freezes it on the
  // first request), so it is set at start-up, not toggled per request. Nothing
  // here reads the log back — the export tool does, offline.
  //   The write is awaited on the request's hot path, deliberately (SMD-1492).
  // Fire-and-forget or an in-process queue would shave a local INSERT off the
  // latency, but either can drop a row when the isolate is torn down or the
  // process dies — and SMD-1806 replays this log to build the canary, where a
  // dropped row is a lost replay. The added cost is measured in db/bench-querylog.ts
  // and kept; a cheaper insert path (a BRIN prune index in place of 047's btree)
  // is the follow-up (SMD-1950), not a durability trade here. On Workers, executionCtx
  // .waitUntil would keep the write durable and off the response path, but it is
  // not plumbed to the handlers today and the dogfood runs Bun, which has no
  // equivalent (deferred).
  // The pipeline tier this server runs as (SMD-1806), stamped on every query_log
  // row so the canary — which replays stable's log — can tell a stable-written
  // row from its own. Unset is a plain brain (the row's tier is NULL).
  const serverTier = (): string | undefined => env().OB1_TIER?.trim() || undefined;
  const logSearchCall = async (
    tool: string,
    args: { query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown>; arm: string },
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
        arm: args.arm,
        tier: serverTier(),
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
      await (await db()).logActions(rows.map((r) => ({ tool: r.tool, agentId: principal.agentId, targetId: r.targetId, tier: serverTier() })));
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

  // The one search operation the three search tools share (SMD-1490). It owns
  // the policy that was copy-pasted across the handlers — and dropped the filter
  // in three places, and never logged keyword at all: the egress gate before a
  // query leaves for its embedding (hybrid only — a keyword search embeds
  // nothing, so nothing leaves the box), the arm dispatch, and the query-log
  // write with the filter, the arm and the tier on it. Each tool is a thin
  // adapter that maps its external interface in and renders its own output; the
  // rows come back typed per arm, so search_thoughts still gets its needle facts
  // and keyword its occurrence counts. A refusal (the egress gate) comes back as
  // a ready tool result for the adapter to return.
  type Refused = { refused: ReturnType<typeof toolError>; rows?: undefined; embedding?: undefined };
  interface RunSearch {
    // The hybrid arm hands back the query embedding it computed, so a caller
    // (search_thoughts's zero-result probe) reuses it without a second gate or
    // provider call.
    (opts: { tool: string; arm: "hybrid"; query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown> }):
      Promise<Refused | { refused?: undefined; rows: ThoughtHybridMatch[]; embedding: number[] }>;
    (opts: { tool: string; arm: "keyword"; query: string; limit: number; offset: number; filter: Record<string, unknown> }):
      Promise<{ refused?: undefined; rows: ThoughtKeywordMatch[] }>;
  }
  const runSearch: RunSearch = (async (opts: {
    tool: string; arm: "hybrid" | "keyword"; query: string; limit: number;
    threshold?: number; recencyWeight?: number; offset?: number; filter: Record<string, unknown>;
  }): Promise<{ refused?: ReturnType<typeof toolError>; rows: (ThoughtHybridMatch | ThoughtKeywordMatch)[]; embedding?: number[] }> => {
    if (opts.arm === "keyword") {
      const rows = await (await db()).keywordThoughts({ query: opts.query, limit: opts.limit, offset: opts.offset ?? 0, filter: opts.filter });
      // A keyword search takes no threshold or recency weight; log them as the
      // compat `search` does its fixed zeros, so the column is a number not a NULL.
      await logSearchCall(opts.tool, { query: opts.query, limit: opts.limit, threshold: 0, recencyWeight: 0, filter: opts.filter, arm: "keyword" }, rows);
      return { rows };
    }
    // The query text leaves for its embedding as a thought's does (SMD-1903).
    const q = gateQuery(opts.query, principal);
    if (q.refused) return { refused: toolError(q.refused), rows: [] };
    const embedding = await getEmbedding(opts.query, q.subject, "query");
    const rows = await (await db()).hybridThoughts({
      query: opts.query, embedding, threshold: opts.threshold ?? 0, limit: opts.limit,
      filter: opts.filter, recencyWeight: opts.recencyWeight ?? 0,
    });
    await logSearchCall(opts.tool, { query: opts.query, limit: opts.limit, threshold: opts.threshold ?? 0, recencyWeight: opts.recencyWeight ?? 0, filter: opts.filter, arm: "hybrid" }, rows);
    return { rows, embedding };
  }) as RunSearch;

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
  if (canRead(principal)) server.registerTool(
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
        // The one search op, hybrid arm (SMD-1490); this surface is fixed, so it
        // pins every knob and exposes none — no filter (filter: {}), no caller
        // threshold (0, not 0.5, SMD-1300: admission is relative to the top match
        // since 027, so a low absolute floor lets it govern), and the fixed
        // recency weight above. runSearch gates the query (SMD-1903) and logs.
        const r = await runSearch({ tool: "search", arm: "hybrid", query, limit: 10, threshold: 0, recencyWeight: SEARCH_COMPAT_RECENCY_WEIGHT, filter: {} });
        if (r.refused) return r.refused;
        const data = r.rows;

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

  if (canRead(principal)) server.registerTool(
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
  if (canRead(principal)) server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning, with exact matching for identifier-shaped tokens in the query (SMD-944, upsert_thought, db/config.mjs, getUserById) and for \"quoted\" spans. " +
        "Use this when the user asks about a topic, person, or idea they've previously captured, including one named by an error code or a ticket key. " +
        "A thought containing one of those literals is ranked with the strongest results found by meaning, never below them, whatever its own similarity — provided the literal is rare enough to match exactly (found in no more than one keyword page of thoughts) and the result fits within the limit. " +
        "Returns a fixed top-N; to page through every thought containing an exact string, or to match a literal that is too common here, use search_thoughts_keyword. " +
        "Every hit says who wrote it (`By: <key> (operator|agent|ingested)`); `said_by` keeps only what the operator typed, or only agents' output, and `actor` only one key's.",
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
        // SMD-1490: the metadata filter, populated end to end (query_log.filter,
        // eval-replay's filtered path). Absent is unfiltered. The store applies
        // `metadata @> filter` inside the scan (014); parseFilter bounds it.
        filter: filterInput,
        // SMD-1726: who wrote it, as two more keys of the same filter.
        said_by: saidByInput,
        actor: actorInput,
      },
    },
    async ({ query, limit, threshold, recency_weight, filter, said_by, actor }) => {
      try {
        // The one search op, hybrid arm (SMD-1490): it gates the query
        // (SMD-1903), embeds it, runs the filter and logs. parseFilter refuses a
        // shape jsonb should not run; a bad filter falls to the catch below.
        const r = await runSearch({ tool: "search_thoughts", arm: "hybrid", query, limit, threshold, recencyWeight: recency_weight, filter: withActorFilter(parseFilter(filter), said_by, actor) });
        if (r.refused) return r.refused;
        const data = r.rows;

        if (data.length === 0) {
          // Nothing cleared the threshold and no literal matched — but WHY is
          // worth saying, and the function reports it only on rows. One more
          // call with no threshold and one row returns the query-level facts
          // whenever the brain has any embedded thought at all (review pass:
          // the first version said "no thoughts found" about a literal that
          // 150 thoughts contained, because it was too common to match). Reuses
          // the arm's embedding, and stays unfiltered so the facts are the
          // query's, not the filtered scope's.
          const probe = await (await db()).hybridThoughts({ query, embedding: r.embedding, threshold: -1, limit: 1, filter: {} });
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
            // SMD-1726: who wrote the current text, from the key (050); its own
            // line, as every field of this block is — nothing parses `ID:`
            // past the id, and nothing should start to.
            const by = actorLine(m);
            if (by) parts.push(by);
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
  if (canRead(principal)) server.registerTool(
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
        // SMD-1490: the same metadata filter as search_thoughts, applied inside
        // the keyword scan (`metadata @> filter`). Absent is unfiltered.
        filter: filterInput,
        // SMD-1726: who wrote it, as two more keys of the same filter.
        said_by: saidByInput,
        actor: actorInput,
      },
    },
    async ({ query, limit, offset, filter, said_by, actor }) => {
      try {
        // The one search op, keyword arm (SMD-1490): no gate (a keyword search
        // embeds nothing, so nothing leaves the box), the filter applied inside
        // the scan, and — new since SMD-1490 — a query_log row written with
        // arm='keyword' (034 logged only the semantic path).
        const r = await runSearch({ tool: "search_thoughts_keyword", arm: "keyword", query, limit, offset, filter: withActorFilter(parseFilter(filter), said_by, actor) });
        const data = r.rows;

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
          // SMD-1726: who wrote it, the line search_thoughts prints.
          const by = actorLine(m);
          if (by) parts.push(by);
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
  if (canRead(principal)) server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "List recently captured thoughts with optional filters by type, topic, person, time range, or who wrote them (`said_by`: operator | agent | ingested; `actor`: a key's name). Each item says who wrote it on a `By:` line.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().optional().describe("Only thoughts from the last N days"),
        // SMD-1726: who wrote it — the two keys 050 stamps, as containment
        // clauses beside type, topic and person.
        said_by: saidByInput,
        actor: actorInput,
      },
    },
    async ({ limit, type, topic, person, days, said_by, actor }) => {
      try {
        const data = await (await db()).listThoughts({ limit, type, topic, person, days, saidBy: said_by, actor });

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
            // SMD-1726: who wrote it, AFTER the id line, indented as the block
            // is — the content-then-ID adjacency stays, which this repo's own
            // e2e suite ([8]) matched on and a client may too.
            const by = actorLine(m);
            const who = by ? `\n   ${by}` : "";
            // SMD-1328: the date bracket is structural here, so an undated row
            // reads `[undated]` (never `[1/1/1970]`); a sentinel shows its text.
            return `${i + 1}. [${displayDate(t.created_at) ?? "undated"}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}\n   ID: ${t.id}${who}${mark}`;
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
  if (canRead(principal)) server.registerTool(
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
  if (canRead(principal)) server.registerTool(
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

  // Tool 3b: the change feed (migration 052, SMD-1296) — what moved since a
  // time or a cursor, for an agent that returns after a break. Gated like the
  // other read tools (canRead: a read or a write key sees it, a capture-only
  // key does not). The store calls one SQL function that chooses the page
  // and bounds the rendering; this decides `since` and lays the rows out.
  if (canRead(principal)) server.registerTool(
    "thought_changes",
    {
      title: "What Changed",
      description:
        "List what changed in Open Brain — every capture, edit and deletion, oldest first, with who made it (by access-key name), the thought's ID, what moved, and whether it now supersedes another thought. " +
        "Start from `since`: an ISO-8601 time with Z or an offset (2026-09-22T08:00:00Z), a date (read as UTC midnight), or the cursor a previous call ended with (its last line) to continue where you left off with no repeats; leave it out for the most recent changes. " +
        "`others_only` leaves out this key's own writes — what everyone else did while you were away.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        since: z.string().optional().describe("An ISO-8601 time with its zone (changes at or after it; a clock with no Z or offset is refused), a date (UTC midnight), or the cursor the previous page ended with (changes after that row). Omit for the most recent changes."),
        others_only: z.boolean().optional().default(false).describe("Leave out this key's own writes"),
        agent: z.string().optional().describe("Only this writer's changes, by access-key name"),
        actions: z.array(z.enum(["capture", "update", "delete"])).optional().describe("Only these kinds of change"),
        limit: z.number().int().min(1).max(200).optional().default(50).describe("Changes per page, 1–200 (default 50); the reply's last line says whether more follow"),
      },
    },
    async ({ since, others_only, agent, actions, limit }) => {
      // `since` is decided here, before any call: a uuid is a cursor, anything
      // else must read as a time, and a word that is neither is refused naming
      // both forms rather than surfacing as a Postgres cast error.
      const start = parseSince(since);
      if ("refused" in start) return { content: [{ type: "text" as const, text: start.refused }], isError: true };
      // Both filters name themselves in the header, so `agent` set to the
      // caller's own key beside others_only reads as the empty set it is
      // (caught: cold-read, pass 1).
      // A name that cleans to nothing (all control characters) still names
      // itself in the header, as its JSON.
      const name = agent?.trim() || null;
      const named = name ? ` by ${snipText(name, 80) || JSON.stringify(name)}` : "";
      const who = named && others_only ? `${named} but not ${principal.name}` : others_only ? ` by everyone but ${principal.name}` : named;
      const kinds = actions?.length ? [...new Set(actions)] : null;
      const what = kinds ? `${kinds.join("/")} change(s)` : "change(s)";
      // Bounded — from a time or a cursor — the function pages forward; with
      // no bound it returns the newest rows. The two read differently below.
      const bounded = start.since !== null || start.after !== null;
      const where = start.after ? "after the cursor" : start.since ? `since ${start.since}` : "recorded yet";
      try {
        // One more than shown, so the reply can say whether more follow
        // without a count query; the function caps at 201.
        const rows = await (await db()).listChanges({
          since: start.since,
          after: start.after,
          agent: name,
          notAgent: others_only ? principal.name : null,
          actions: kinds,
          limit: limit + 1,
        });
        const more = rows.length > limit;
        // Forward from a bound the extra row is the NEWEST, past the page; with
        // no bound the function returns the newest limit+1 oldest first, so the
        // extra row is the OLDEST — slicing the same end would drop the latest
        // change, the one a resumer most needs (caught: cold-read, pass 1).
        const shown = !more ? rows : bounded ? rows.slice(0, limit) : rows.slice(1);
        if (shown.length === 0) {
          return { content: [{ type: "text" as const, text: `No ${what}${who} ${where}.${start.after ? " Keep the cursor." : ""}` }] };
        }
        const head = bounded ? `${shown.length} ${what}${who} ${where}, oldest first:` : `The ${shown.length} most recent ${what}${who}, oldest first:`;
        const cursor = shown[shown.length - 1].id;
        const onward = !more ? "" : bounded ? " More changes follow." : " Older changes exist — pass a time before the first entry above as `since` to read them.";
        const tail = `Cursor: ${cursor} — pass it as \`since\` to continue from here.${onward}`;
        return {
          content: [{ type: "text" as const, text: `${head}\n\n${shown.map((c, i) => renderChange(c, i + 1)).join("\n\n")}\n\n${tail}` }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        const hint = /thought_changes/.test(msg) && /does not exist|could not find/i.test(msg)
          ? " — migration 052 (db/migrations/052_thought_changes.sql) is not applied, or PostgREST has not reloaded its schema cache"
          : /permission denied for table thought_audit/i.test(msg)
          ? " — the server's role needs SELECT on thought_audit (db/README.md, Grants for a capturing role — the server group, which migrate.ts --grant issues)"
          : "";
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}${hint}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3c: what this brain is (SMD-2041) — version, commit, store, tier, the
  // database's versions, ledger, counts, size and HNSW parameters, one short
  // table. Gated like the other read tools. The same record is the keyed
  // /health body, as JSON; brainInfo never raises, so a database that cannot
  // answer is a line in the table, not a tool error.
  if (canRead(principal)) server.registerTool(
    "brain_info",
    {
      title: "Brain Info",
      description:
        "Say what this Open Brain is: the server's version and the release it belongs to, the commit it was built from, the store and tier, " +
        "the Postgres and pgvector versions, the schema version and highest migration applied (and whether that is this server's last), " +
        "row counts, database size and vector-index parameters. Use it to check which version you are talking to, or whether the brain has reached this server's last migration " +
        "(it compares the highest number applied; a skipped or edited migration is what `migrate.ts --dry-run` lists).",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: "text" as const, text: renderBrainInfo(await readBrainInfo("tool")) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // Tool 4: Capture Thought — the tool that adds.
  //
  // Registered for a key that may capture — write scope, or the capture-only
  // scope a session-end hook holds (SMD-1298). A read-only key does not get a
  // permission error from it; the tool is absent from tools/list entirely, so the
  // client never offers it and never tries. That is a smaller surface than
  // refusing the call, and it is honest about what the key can do. The read
  // tools above are gated the same way for a capture key: absent, not refused.
  if (canCapture(principal)) server.registerTool(
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
        // SMD-1298. Where the capture comes from, for metadata.source — "mcp"
        // when absent, as every capture before it. A session-end hook says
        // `claude-code` or `codex`; a per-source weight (SMD-1297) and the
        // egress policy's `source:` term key on the value. The shape is held
        // here so a label reaches the row, the audit trail and the policy as
        // one spelling.
        source: z.string().regex(SOURCE_RE, "lower-case letters, digits and hyphens, 2–40 characters, starting with a letter or digit").optional()
          .describe("Where this capture comes from, recorded as metadata.source — e.g. `claude-code` or `codex` for a session-end hook, `mcp` (the default) for an agent capturing in conversation. Lower-case letters, digits and hyphens, 2–40 characters. A label the caller gives; the audit row's actor says which key wrote."),
        // SMD-2014. Extra metadata keys the caller controls, merged UNDER the
        // server's own (source, the extractor's tags, the actor columns), so a
        // reserved name is refused, never silently overruled. The session hook
        // sets `summary_model` when a local model wrote the summary, so a reader
        // and a per-source weight (SMD-1297) can tell a model summary from the
        // derived one.
        metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("Extra metadata keys to store on the thought (e.g. `{\"summary_model\": \"llama3.1:8b\"}`). Lower-case keys, string/number/boolean values; at most 8 keys. Keys the server owns — `source` (use the `source` argument), `type`, `topics`, `people` and the like — are refused. Returned to readers alongside the server's own metadata."),
      },
    },
    async ({ content, derived_from, supersedes, source, metadata: clientMetadata }) => {
      // What a key that cannot read is told and allowed — decided once here
      // and read below, in the catch too (fifth review pass: six scattered
      // canRead tests; sixth: one survived in the catch).
      const reader = canRead(principal);
      try {
        // The row's origin label: the caller's, else the one every capture
        // through this tool carried before `source` existed (SMD-1298).
        const origin = source ?? "mcp";
        // The shape before the two model calls, in the tool's words — as
        // update_thought's `supersedes` is refused (032). upsert_thought would
        // raise on it after the embedding and the metadata were already paid for.
        if (supersedes !== undefined && !UUID_RE.test(supersedes)) return toolError(refuseSupersedesShape(supersedes));
        // derived_from's SHAPE likewise (fourth review pass): a non-id element
        // paid both model calls before validate_derived_from refused it.
        // Existence stays the write's.
        const badDerived = derived_from?.find((d) => !UUID_RE.test(d));
        if (badDerived !== undefined) return toolError(`Refused: every \`derived_from\` entry must be a thought id (the ID: line of a search result), not "${badDerived.slice(0, 40)}".`);
        // A caller `metadata` key that names a server-owned one, or a bad shape,
        // is refused BEFORE the two model calls are paid for (SMD-2014), as the
        // pointer shapes above are.
        const badMetadata = refuseMetadataShape(clientMetadata);
        if (badMetadata) return toolError(badMetadata);
        // A capture-only key's provenance is trimmed to the ids that exist
        // BEFORE the write, and the reply says nothing of it — not which
        // (third review pass: positions were an existence oracle on a key that
        // cannot read) and not how many (eighth: with one id sent, the count
        // was the answer). A reader is refused with positions and ids, and can
        // look. A summary with its live sources beats a refusal over one
        // deleted thought; the row's derived_from says what was recorded.
        let derivedFrom = derived_from;
        if (derivedFrom?.length && !reader) derivedFrom = await liveSubset(await db(), derivedFrom);
        // A capture-only key may replace only what it captured itself (SMD-1298,
        // first review pass): `supersedes` marks the target superseded in every
        // search result — an alteration of a thought the key did not write, the
        // one thing the scope promises it cannot do. Ownership is the target's
        // capture audit row (008/010): the same agent id when both sides have
        // one, else the same key name. One message whichever way it fails, so
        // the refusal is not an existence oracle for a key that cannot read.
        if (supersedes !== undefined && !reader) {
          let writer: { actorName: string | null; agentId: string | null } | null;
          try {
            writer = await (await db()).captureActorOf(supersedes);
          } catch (e) {
            // The read needs SELECT on thought_audit — the `server` grant group,
            // soft like the rest of it (second review pass: the capture group
            // holds INSERT alone). Refuse THIS pointer, name the grant, and let
            // the capture proceed without it on the caller's retry.
            // An ERROR of the server's, not a refusal of the request as shaped:
            // a caller keeps the pointer and tries again once the grant is
            // there (fifth review pass: "Refused:" made the hook drop it, and
            // the hook told the two apart by the sentence's wording).
            const why = String((e as Error).message ?? e).slice(0, 120);
            // The grant remedy only for a privilege error (42501); a dropped
            // connection, a timeout or a brain before 010 gets the store's own
            // words, since `--grant` would change nothing there (sixth review pass).
            const noPrivilege = (e as { code?: string }).code === "42501" || /permission denied/i.test(why);
            return toolError(`Error: this key's \`supersedes\` could not be checked against the target's capture record (${why})${noPrivilege ? " — the server role needs SELECT on thought_audit: cd db && bun migrate.ts --grant <role> --url $DATABASE_URL" : ""}.`);
          }
          // By agent id when both sides carry one; by name only when NEITHER
          // does (the registry away now, as it was at the write). A row without
          // an id met by a principal with one is not this key's to replace: a
          // later key minted under the same name would otherwise own every
          // thought captured while the registry was down (fourth review pass).
          // The registry away NOW while the row is attributed: nothing can be
          // said either way, and that is the server's condition, not the
          // caller's — an error to retry, not a refusal (fifth review pass).
          // Unless the registry ANSWERED and refused this key's argument (a
          // label the SQL rejects): that will not heal on a retry, so it is a
          // refusal, and the caller posts without the pointer (sixth review pass).
          if (writer !== null && writer.agentId !== null && principal.agentId === undefined) {
            if (principal.agentUnresolved === "refused") return toolError("Refused: a capture-scoped key may name as `supersedes` only a thought it captured itself, and this key's identity could not be resolved — the agent registry refused its name or digest; see the server log.");
            return toolError("Error: this key's `supersedes` could not be attributed while the agent registry is unavailable — retry when resolve_agent answers.");
          }
          const own = writer !== null && (
            writer.agentId !== null && principal.agentId !== undefined ? writer.agentId === principal.agentId
              : writer.agentId === null && principal.agentId === undefined ? writer.actorName === principal.name
                : false);
          if (!own) return toolError("Refused: a capture-scoped key may name as `supersedes` only a thought it captured itself.");
        }
        // What may leave the box (SMD-1903): asked once, for both calls, and
        // only the allowed ones are made — a refused capture costs no request
        // and lands all the same, without the vector or the tags the refused
        // call would have produced, with the decision on its audit row.
        const cfg = embedConfig();
        // The gate judges the label the ROW will carry — one value for the
        // row's lifetime, so a `source:` term decides the same at the capture
        // and at the re-embed and consolidation passes that read the row
        // (fourth review pass: judging `mcp` here and the label there let one
        // policy allow and refuse the same row). The label is the caller's, so
        // a term about WHO wrote names `actor`, which the key proves; SMD-1941
        // binds a label to the key.
        const subject: EgressSubject = { kind: "capture", actor: principal.name, metadata: { source: origin }, content };
        const gate = decideCalls(subject, cfg, cfg.egress);
        // Independent of each other, so they overlap.
        const [embedded, metadata] = await Promise.all([
          gate.embeddings.allowed ? embedCapture(content, subject) : Promise.resolve(undefined),
          gate.chat.allowed ? extractMetadata(content, subject) : Promise.resolve(metadataRefused()),
        ]);
        const chunks = embedded?.chunks ?? [];
        const contextFailures = embedded?.contextFailures ?? 0;

        // The caller's keys UNDER the server's: the extractor's tags and the
        // origin label win over anything a caller sent by the same name (the
        // shape check above has already refused a reserved key outright, so this
        // only orders the rest), and `summary_model` and its like survive
        // (SMD-2014).
        const payload = { metadata: { ...clientMetadata, ...metadata, source: origin } };

        // Atomicity is the store's problem now: the SQL path writes content,
        // metadata and vector in one statement, while the PostgREST path keeps the
        // 3-arg RPC with its two-step fallback. Either way a row committed without
        // its embedding is reported, never silently accepted.
        // A source deleted between the trim above and this write — the one path
        // left to 025's refusal for a key that cannot read — is met by trimming
        // once more and writing again, so the summary keeps its live sources;
        // the refusal that reaches such a key names no position, and the hook
        // could only drop the whole list (twelfth review pass). A reader is
        // refused as before, with positions, and decides.
        const store = await db();
        const captureArgs = {
          content,
          payload,
          chunks,
          // The audit trail's actor. `name` is the access key's name from
          // auth.ts; `agentId` is the stable id migration 010 resolved it to,
          // and is absent when the registry could not answer — see agents.ts.
          // Both are recorded: the name is what the agent was CALLED at the time
          // of writing, which a later rename would otherwise erase. `via` is
          // this server, the door (046's origin column); the row's source is
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
          supersedes,
        };
        let captured;
        try {
          captured = await store.captureThought({ ...captureArgs, derivedFrom });
        } catch (e) {
          if (reader || !derivedFrom?.length || !/derived_from references a thought that does not exist/.test(String((e as Error)?.message ?? e))) throw e;
          derivedFrom = await liveSubset(store, derivedFrom);
          captured = await store.captureThought({ ...captureArgs, derivedFrom });
        }

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
          await logActionCalls(citeRows("capture_thought", { derived_from: derivedFrom, supersedes }));
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
        // What a key that cannot read may be told about the row: not whether
        // the text was already a thought, nor what it points at (first review
        // pass — an existence oracle on a capture-only key). The id is returned
        // either way; a hook needs it to supersede its own earlier summary.
        const existed = reader ? captured.existed : undefined;
        if (!gate.embeddings.allowed) {
          confirmation += existed === true
            ? `\n\nNote: the embedding call for this capture was not made — ${gate.embeddings.reason}. This text was already a thought, and it keeps the vector it had.`
            : existed === false
              ? `\n\nNote: saved WITHOUT a vector — ${gate.embeddings.reason}. ` +
                `It is findable by exact text (search_thoughts_keyword) and joins semantic search after a re-embed pass ` +
                `(db/reembed.ts) against an endpoint the gate allows.`
              : `\n\nNote: the embedding call for this capture was not made — ${gate.embeddings.reason}. A new thought has no vector — findable by exact text ` +
                `(search_thoughts_keyword), filled in by a re-embed pass (db/reembed.ts) against an endpoint the gate allows; text already captured keeps the vector it had. ` +
                // A key that cannot read is not told which (SMD-1298); a database
                // from before 035 cannot say.
                (reader ? `This database does not say which this was.` : `This reply does not say which.`);
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
        const derivedNamed = derivedFrom !== undefined && derivedFrom.length > 0;
        if (existed === true && (derivedNamed || supersedes !== undefined)) {
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
        if (/derived_from references a thought that does not exist/.test(msg)) {
          // WHICH ones (second review pass): 025 names the whole list, so the
          // store is asked which exist and the reply names the POSITIONS that
          // do not — what a caller needs to drop exactly those and try again,
          // and nothing it did not send — with the ids beside them for a key
          // that can read. A capture key's list was trimmed before the write
          // (third review pass), so it reaches here only when a source was
          // deleted between the check and the write — and is told no position
          // even then (eighth review pass: the race was the one path that still
          // named one to a key that cannot read).
          const sent = derived_from ?? [];
          let missingAt: number[] = [];
          if (reader) { // a non-reader is told no position, so the store is not asked (tenth review pass)
            try {
              const have = await (await db()).existingIds(sent);
              missingAt = sent.map((d, i) => (have.has(d.toLowerCase()) ? -1 : i)).filter((i) => i >= 0);
            } catch { /* the store could not say: the list alone, then */ }
          }
          // The verb agrees with what is SAID: the plural leaked the count to a
          // non-reader through the placeholder (ninth review pass).
          const named = reader && missingAt.length ? missingAt : [];
          const where = named.length
            ? named.map((i) => `derived_from[${i}] (${sent[i]})`).join(", ")
            : "a `derived_from` id";
          return toolError(`Refused: ${where} name${named.length > 1 ? "" : "s"} no thought. Each entry must be an existing thought id (the ID: line of a search result).`);
        }
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

// A request refused for now, to be retried: the agent registry could not
// confirm the key in time (agents.ts's `busy`). Its own code, in the same
// implementation-defined range, so a client can tell "retry" from "denied".
const JSON_RPC_BUSY_CODE = -32003;

/**
 * The ids in `ids` that name a thought, or undefined when none does — the one
 * rule for trimming a capture-only key's `derived_from` before the write and
 * again on the retry (thirteenth review pass: it was spelled twice).
 */
async function liveSubset(store: ThoughtStore, ids: string[]): Promise<string[] | undefined> {
  const have = await store.existingIds(ids);
  const kept = ids.filter((d) => have.has(d.toLowerCase()));
  return kept.length ? kept : undefined;
}
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
 * The registry's lookup timed out on a lock (a migration; a transaction
 * holding a stale key's row) or failed to serialize, through its retries, and
 * has not confirmed the key. Says what to do — retry — and nothing about
 * the key, which may be valid or revoked.
 */
const BUSY_MESSAGE =
  "Temporarily unavailable: the agent registry is busy and could not confirm this key. Retry in a few seconds.";

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
  message: string = UNAUTHORIZED_MESSAGE,
  code: number = JSON_RPC_UNAUTHORIZED_CODE
): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code,
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
// GET with 405 (below). Without a key, like /.well-known/*: it says the process
// is serving and nothing else — no key, a wrong key, a capture-only key and a
// revoked one all get the literal `ok`, so nothing about the deployment reaches
// an unauthenticated probe. With a read or a write key it answers what the
// brain is, as JSON — brain_info's record (SMD-2041), for deploy/smoke.sh and an
// operator's curl — still a 200, since the process is serving: a database that
// refuses at once is the record's `database.error`; one that never answers
// leaves the registry check unanswered too, and the body is then `ok` (below).
// Readiness — is the database reachable —
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
app.get("*", async (c, next) => {
  if (!HEALTH_PATH.test(c.req.path)) return next();
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: SCOPES });
  if (!principal || !canRead(principal)) return c.text("ok", 200, corsHeaders);
  // A HEAD has no body to carry the record: liveness, as without a key, and no
  // read for nothing (review pass 1: it paid the whole read, and the deadline).
  if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
  // The registry check and the read start together, under one deadline, so the
  // answer comes within HEALTH_DEADLINE_MS whatever the database does — the
  // read runs for a revoked key too (serialising the two would not fit the
  // deadline), but a revoked key is shown nothing, as at the MCP route. A registry that has
  // not answered by the deadline could still say `revoked`, so the key gets
  // what an unknown key gets (review pass 2: a revoked key read the whole
  // record while the registry's tables were locked); one that answers that it
  // cannot reach the database (agents.ts: not a refusal) lets the record
  // through with the database's error. A registry whose lock outlasts the
  // lookup's retries answers `busy` for the same reason (agents.ts), and so is
  // `ok` here too.
  const info = readBrainInfo("health");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal), // one lookup in flight per key (agents.ts)
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  return c.json(await info, 200, corsHeaders);
});

// ── A tool call outlives the runtime's idle timeout (SMD-1864) ───────────────
//
// The transport answers a POST with an SSE stream at once and writes the tool's
// result to it when the tool returns; until then the stream carries nothing.
// Bun closes a connection that has been silent for `idleTimeout` seconds — 10
// by default — a streaming response included, at the next of its 4-second
// sweeps, so between 8 and 12 s of silence by phase; it never reaches into a
// handler that has not yet returned a response. Measured on 1.4.0, macOS and
// the Alpine image alike: a handler still pending at 12 s answers normally,
// body read or not, on a fresh or a reused socket; a streamed response silent
// for 13 s is closed at the sweep, the client sees ECONNRESET, and the handler
// runs on to write into a closed stream; a comment frame every 5 s keeps it
// open. A capture whose embedding and metadata calls ran past ten seconds was
// that second case (9.76 s, deterministically, on the dogfood brain), with no
// line in the server's log. So every SSE response leaves through
// withSseKeepalive: a `: keepalive` comment — a line SSE parsers discard by
// specification, so no client sees an event — every SSE_KEEPALIVE_MS for the
// life of the stream, until the transport closes it or the client goes, when
// the timer stops itself. The idle timeout itself stays at the runtime's
// default: its job is reaping dead keep-alive sockets, and raising it to the
// ceiling of 255 s would move the cliff a long capture falls off rather than
// remove it, and let a dead socket linger 25× longer. Half the default, so a
// stream is never silent for a whole sweep; a proxy's read timeout in front of
// the server (SMD-1846) is kept the same way.
export const SSE_KEEPALIVE_MS = 5_000;

/**
 * How long a stream is kept alive at most. A provider call is bounded by
 * OB1_LLM_TIMEOUT (120 s, embed.ts) and a capture makes a few; a database
 * write is bounded by nothing — a transaction stuck on upsert_thought's
 * fingerprint lock (033) would hold every concurrent capture of that thought,
 * and with an unbounded keepalive each would hold a stream and a timer for
 * hours with no line anywhere. Past this the timer stops, one line says so,
 * and the runtime's idle timeout takes over: a call this long is stuck, not
 * slow. (Review pass 1.)
 */
export const SSE_KEEPALIVE_MAX_MS = 10 * 60_000;

/** The SSE comment frame the keepalive writes. A line beginning `:` is a comment (WHATWG, "event stream interpretation"): every parser drops it. */
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

/**
 * The response with its SSE body kept alive: a comment frame every
 * `intervalMs` until the body ends (`onEnd` runs once, then), the client
 * leaves (`signal` aborts, or the next frame finds the stream closed — either
 * stops the timer, so an abandoned call leaks nothing), or `maxMs` passes
 * since `startedAt` (the timer stops, `stalledRequestLine` is logged for
 * `label` and `onStall` runs once — the route marks the request settled, so
 * the runtime's reap that follows on Bun is not logged as a client leaving; on
 * Node or Workers nothing reaps a silent stream, and it stays open until the
 * client or a proxy gives up). A response that is not an event stream is
 * returned as it is, `onEnd` run at once: it is complete.
 */
export function withSseKeepalive(
  response: Response,
  opts: { intervalMs?: number; maxMs?: number; startedAt?: number; signal?: AbortSignal; onEnd?: () => void; onStall?: () => void; label?: string } = {},
): Response {
  const body = response.body;
  if (!body || !/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
    opts.onEnd?.();
    return response;
  }
  const intervalMs = opts.intervalMs ?? SSE_KEEPALIVE_MS;
  const maxMs = opts.maxMs ?? SSE_KEEPALIVE_MAX_MS;
  const started = opts.startedAt ?? performance.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    opts.signal?.removeEventListener("abort", stop);
  };
  const keepalive = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        const elapsed = performance.now() - started;
        if (elapsed >= maxMs) {
          stop();
          console.warn(stalledRequestLine(opts.label ?? "?", elapsed));
          opts.onStall?.();
          return;
        }
        try {
          controller.enqueue(SSE_KEEPALIVE_FRAME);
        } catch {
          stop(); // the readable side closed under the timer: the client left
        }
      }, intervalMs);
    },
    flush() {
      stop(); // the transport closed the stream: the response is complete
      opts.onEnd?.();
    },
  });
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop(); // gone before the stream was built: nothing to keep alive
  return new Response(body.pipeThrough(keepalive), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A caller's string as a log line may carry it: printable ASCII only — a newline would forge a second line — and at most this many characters. */
const LABEL_PART_MAX = 64;
const labelPart = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, LABEL_PART_MAX);

/**
 * What a log line may say about a request: the JSON-RPC method and, for a
 * tool call, the tool's name — never the arguments, which are the thought —
 * each as `labelPart` admits it, since both are the caller's strings. A batch
 * is named by its first message; anything unreadable is `?`.
 */
export function requestLabel(bodyText: string | null): string {
  try {
    const parsed: unknown = JSON.parse(bodyText ?? "");
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const msg = (first ?? {}) as { method?: unknown; params?: { name?: unknown } };
    const method = typeof msg.method === "string" ? labelPart(msg.method) : "?";
    return typeof msg.params?.name === "string" ? `${method} ${labelPart(msg.params.name)}` : method;
  } catch {
    return "?";
  }
}

/** The line logged when a stream has been kept alive for SSE_KEEPALIVE_MAX_MS: the call is stuck, and the keepalive lets go. */
export function stalledRequestLine(label: string, elapsedMs: number): string {
  return `request still running after ${Math.round(elapsedMs / 1000)} s: ${label} — the keepalive stops here and the runtime's idle timeout takes over; a provider call is bounded by OB1_LLM_TIMEOUT, so look at the database (SMD-1864)`;
}

/**
 * The line the server logs when a client closes the connection before the
 * response is complete — the trace SMD-1864's captures never left. The tool
 * runs to its end regardless (a capture may still land), which the line says,
 * so an operator reading a duplicate row later knows where it came from.
 */
export function abandonedRequestLine(label: string, elapsedMs: number): string {
  return `request abandoned by the client after ${(elapsedMs / 1000).toFixed(1)} s: ${label} — the connection closed before the response was complete; the call runs to its end on this side, so a capture may still have landed (SMD-1864)`;
}

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
  // The one thing this server logs per request (SMD-1849 has the rest): a
  // client that closes the connection before the response is complete, named
  // by method and tool, never by content. Registered first, so a client that
  // leaves during the key check, the registry resolve or the body read is
  // logged too (a listener added to a signal already aborted never fires — so
  // that case is checked by hand); the label is filled in once the body is
  // read. The signal aborts when the client goes, not when a complete
  // response's socket is later reaped (measured), and `settled` keeps the line
  // to the former anyway.
  const signal = c.req.raw.signal;
  const started = performance.now();
  let label = "?";
  let settled = false;
  const abandoned = () => {
    if (!settled) console.warn(abandonedRequestLine(label, performance.now() - started));
  };
  signal.addEventListener("abort", abandoned, { once: true });
  if (signal.aborted) {
    // Gone before the route ran: the line, and nothing else — no key check, no
    // registry resolve, no tool run for a client that will never read it. The
    // status reaches no one; 408 is the nearest name for what happened.
    abandoned();
    return c.body(null, 408);
  }

  // Accept the access key via header, bearer token OR URL query parameter — every
  // form presented is tried, so a gateway's own bearer token beside the client's
  // `?key=` does not shadow it. The query form stays because Claude Desktop
  // custom connectors are URL-only; scopes are what limit the damage when such a
  // URL leaks. See auth.ts.
  // Every scope: this is the one server that registers a tool group for a
  // capture-only key. A consumer that does not say admits read and write alone.
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: SCOPES });

  if (!principal) {
    // Return a JSON-RPC 2.0 error envelope (HTTP 200) instead of a bare
    // HTTP 401 so strict MCP hosts treat this as an application-level
    // error rather than a transport fault and keep the connection alive.
    // Best-effort echo of the inbound request id keeps the response
    // correlated; malformed/missing bodies fall back to id: null.
    const bodyText = await readBodyText(c.req.raw);
    const id = extractJsonRpcId(bodyText);
    settled = true;
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
   * when the registry cannot answer, which is deliberately NOT a refusal —
   * except when it is locked (`busy`, a refusal for now), or for a key whose
   * revocation this process has already read.
   */
  const identity = await agents().resolve(db(), principal);
  if (identity.status === "revoked" || identity.status === "busy") {
    const bodyText = await readBodyText(c.req.raw);
    settled = true;
    return identity.status === "revoked"
      ? unauthorizedResponse(extractJsonRpcId(bodyText), REVOKED_MESSAGE)
      : unauthorizedResponse(extractJsonRpcId(bodyText), BUSY_MESSAGE, JSON_RPC_BUSY_CODE);
  }
  principal.agentId = identity.agentId;
  principal.agentUnresolved = identity.unresolved;

  // The label, read through Hono's request, which caches the body for the
  // transport's own read of it — the same text, the same rejection: a body
  // that cannot be read (the client gone mid-upload) is `?` here and the
  // transport's 400 there, as before this read existed.
  label = requestLabel(await c.req.text().catch(() => null));

  const server = buildServer(principal);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) {
    settled = true;
    return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  }
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  // Kept alive for as long as the tool runs, up to SSE_KEEPALIVE_MAX_MS from the
  // route's entry (SMD-1864, above); a stall settles the request too, so the
  // reap that follows it is not a second line blaming the client.
  const settle = () => { settled = true; };
  return withSseKeepalive(response, { signal, label, startedAt: started, onEnd: settle, onStall: settle });
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
  // No `idleTimeout`: a tool call outlives the default by the keepalive above,
  // and the default is the right reaper for a dead socket (SMD-1864).
  // An empty PORT is unset, not port 0 (a random port, silently) — `||`, the rule the vendored servers' tails share (SMD-1799).
  port: Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PORT || 8000),
  fetch: app.fetch,
};