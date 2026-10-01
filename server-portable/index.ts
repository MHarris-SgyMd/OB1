
import { type EmbeddedCapture } from "./embed.ts";
import { extractMetadata as extractMetadataWith, metadataRefused, TAG_KEYS } from "./metadata.ts";
import { captureLineage } from "./lineage.ts";
import { classifyGenre } from "./genre.ts";
import { resolveJevConfig } from "./jev.ts";
import { decideCalls, type EgressSubject } from "./egress.ts";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createStore, postgrestOnBunNotice, storeKind, UUID_RE, type Citation, type ThoughtStore } from "./store.ts";
import { tierProblem, trimmedEnv } from "../db/config.mjs";
import { authenticateRequest, canCapture, canRead, canWrite, SCOPES, type Principal } from "./auth.ts";
import { AgentResolver, cacheTtlFromEnv } from "./agents.ts";
import { FORK_VERSION } from "./version.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "./shutdown.ts";
import { subscribe as subscribeJob, markRunningLost, setJobSink } from "./jobs.ts";
import { createCore, SPECS } from "./core/index.ts";
import { citeRows } from "./core/context.ts";
import { HEALTH_DEADLINE_MS } from "./core/reads.ts";
import * as say from "./render.ts";

// What the suites import from the module they drive; each now lives beside the
// core or the renderer it belongs to (SMD-2283).
export { parseFilter, withActorFilter } from "./core/filter.ts";
export { actorLine, demotedLine, currentNote, currentSearchHint } from "./render.ts";
export { HEALTH_DEADLINE_MS, BRAIN_INFO_TOOL_DEADLINE_MS } from "./core/reads.ts";

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
   * The platform's grace period for a stop, in seconds; the server drains for
   * 2 s less (shutdown.ts). Default 10, Docker's. Read once, at start-up, from
   * the process's environment: the handlers go in before the first request
   * seeds the rest.
   */
  OB1_STOP_GRACE?: string;
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
   * The most windows one thought is extracted in (SMD-2240); a longer one is
   * extracted over its first this many and recorded with a caveat. Unset:
   * db/config.mjs's EXTRACT_MAX_WINDOWS, 24. Read here only by preflight,
   * for the same reason as the window above.
   */
  OB1_EXTRACT_MAX_WINDOWS?: string;
  /**
   * The larger local model a runaway extraction call escalates to instead of the
   * penalised same-model retry (SMD-2000). Read here only by preflight, which
   * names it on the extraction window row and probes it with --deep; the server
   * never extracts. Unset (or equal to the metadata model): the retry is unchanged.
   */
  OB1_EXTRACT_ESCALATE_MODEL?: string;
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
let jobStoreWired = false;
function db(): Promise<ThoughtStore> {
  if (!_store) {
    const notice = postgrestOnBunNotice(storeKind(env()));
    if (notice) console.warn(notice);
    _store = createStore(env());
    // Once, on the Bun server and the moment the store is first built (env() is
    // seeded by then): wire the durable job store (SMD-2318) and reconcile jobs a
    // prior process left running — a clean stop's `lost` write that did not land,
    // or a hard crash — so a poll after the restart sees a terminal answer, not a
    // live job with no runner. Detached and best-effort: the handle routes never
    // gate on it, the SQL store returns a sink, the PostgREST store returns null
    // (the registry stays in-memory), and a store that fails to build leaves it
    // in-memory too. A suite drives the sink itself (it holds the store).
    if (SERVES_ON_BUN && !jobStoreWired) {
      jobStoreWired = true;
      void _store.then(async (store) => {
        const s = store.jobSink();
        if (!s) return;
        // Reconcile BEFORE wiring the sink: only after setJobSink does a job of
        // this process get persisted as running, so running the reconcile first
        // means it can only touch a prior process's rows — never a job this
        // process just started (which would race the reconcile's UPDATE and be
        // wrongly cut to lost).
        const lost = await s.reconcileRunningLost();
        setJobSink(s);
        if (lost > 0) console.warn(`startup reconciled ${lost} job${lost === 1 ? "" : "s"} left running by a prior process: marked lost (SMD-2318)`);
      }).catch(() => { /* no durable store: the registry stays in-memory */ });
    }
  }
  return _store;
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

// The core (SMD-2283): every tool's logic over the store and the model
// provider, as functions of a principal and a typed input (core/index.ts). Built
// once, at import; it reads the environment and the store through the two
// lazy readers above, so Cloudflare Workers bindings — which arrive per
// request — still apply. The model provider is anything speaking the OpenAI
// /embeddings and /chat/completions shapes, which includes OpenRouter, OpenAI
// itself, and Ollama's compatibility layer — so a fully local brain is a URL
// change, not a code change.
const core = createCore({ env, store: db });
const { embedConfig, embedder } = core.ctx;
// The tag extraction is metadata.ts (shared with db/sync-linear.ts); this is
// the server's reader over it, lazy like embedConfig for the same reason.
const extractMetadata = (text: string, subject: EgressSubject) => extractMetadataWith(text, subject, embedConfig());

// The genre classifier (SMD-2323): a deterministic pre-signal over the metadata
// first, then the typed-decision tier when OB1_JEV_BASE_URL names one — opt-in
// and null-by-default, so a capture pays nothing for it unless the tier is
// configured (the classifier is pre-signal-only and falls back to `other`).
const jevConfig = () => resolveJevConfig(env());
const classifyThoughtGenre = (content: string, metadata: Record<string, unknown>, subject: EgressSubject) =>
  classifyGenre(content, metadata, jevConfig(), subject);

const embedCapture = (content: string, subject: EgressSubject) => embedder.embedCapture(content, subject);

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

// --- MCP Server Setup ---

/**
 * A machine-readable verdict carried in `structuredContent` beside the prose
 * (SMD-1978), so a client — the session-capture hook — need not parse English
 * to tell a refusal from a transient, which pointer to drop, or which
 * `derived_from` positions named no thought. `retryable` is the transient/final
 * split; `positions` are the derived_from indices to drop, present only for a
 * caller allowed to know they exist (the existence-oracle rule, SMD-1298).
 */
type ToolErrorCode =
  | "REFUSED_SUPERSEDES_OWNERSHIP" // a capture key named a supersedes it did not write
  | "REFUSED_SUPERSEDES_UNKNOWN"   // the supersedes names no thought
  | "DERIVED_FROM_MISSING"         // a derived_from id names no thought
  | "SUPERSEDES_UNJUDGED"          // the server could not check/attribute the supersedes; retry
  | "REFUSED_EMPTY_WORK_TYPE"      // retry_failed / release_stale_leases given a blank work_type
  | "REFUSED_LIVE_LEASE_NEEDS_WORKER" // release_stale_leases include_live without a worker_id
  | "RUN_WORKER_DRAIN_NOT_AVAILABLE"  // run_worker called without dry_run:true; the executing drain is deferred (SMD-2272/2304)
  | "STORE_UNAVAILABLE";           // the store did not answer; retry
type ToolErrorInfo = { code: ToolErrorCode; retryable: boolean; positions?: number[] };

/**
 * The `{ isError: true }` envelope the write tools return, in one place; with a
 * code, its machine-readable verdict rides `structuredContent` (SMD-1978), the
 * words beside it as `text` — Claude Code, VS Code and Codex show the model the
 * value alone when there is one (render.ts), and a refusal's words name which
 * pointer or position to drop (SMD-2283 review pass 3).
 */
function toolError(text: string, info?: ToolErrorInfo) {
  return { content: [{ type: "text" as const, text }], isError: true as const, ...(info ? { structuredContent: { text, ...info } } : {}) };
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
      const rows = (r.citations ?? []).map((c) => `  - ${c.thoughtId} (${c.stance}): ${say.snipText(c.text, 120)}`);
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

/**
 * The tool calls running, counted for the stop (SMD-2250, review pass 3): a
 * call runs on after its client has gone, and a stop that waited only on the
 * requests Bun counts exited under it.
 */
const toolCalls = createCallCount();
/** How many tool calls are running now, for test-server [13d]. */
export const toolCallsRunning = (): number => toolCalls.running;
function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    // The fork's version, generated from db/version.mjs (SMD-2041) — a literal
    // here said 1.0.0 from before the fork had a version scheme until 1.1.0.
    version: FORK_VERSION,
  });
  // Every tool registered below runs inside toolCalls.track: registerTool's
  // last argument is the handler, whatever its overload.
  const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
    const handler = args[args.length - 1] as (...call: unknown[]) => unknown;
    return registerTool(...args.slice(0, -1), (...call: unknown[]) => toolCalls.track(() => handler(...call)));
  };

  // The action log of a write (034's click-through, SMD-1719's cites), stamped
  // with this caller's agent id — core/context.ts owns the write and its rules.
  const logActionCalls = (rows: { tool: string; targetId: string }[]): Promise<void> => core.ctx.logActions(principal, rows);
  const logActionCall = (tool: string, targetId: string): Promise<void> => logActionCalls([{ tool, targetId }]);

  // The read tools (SMD-2283): each is its operation in core/reads.ts — the
  // search op with its egress gate and query log, the store reads, the probes —
  // and its words in render.ts. The handler validates (the SDK runs SPECS' zod
  // schema), calls the operation and renders the outcome; a fault the operation
  // throws is `Error: <message>`, with the tool's hint where it has one.

  // ChatGPT compatibility: restricted connector surfaces, company knowledge, and
  // deep research look for exact read-only `search` and `fetch` tool shapes. Why
  // the shape pins hybrid, no recency weight and no prefer_current: core/reads.ts.
  if (canRead(principal)) server.registerTool(
    "search",
    SPECS.search,
    async (input) => {
      try {
        return say.renderSearch(await core.search(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
      }
    }
  );

  if (canRead(principal)) server.registerTool(
    "fetch",
    SPECS.fetch,
    async (input) => {
      try {
        return say.renderFetch(await core.fetch(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
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
    SPECS.search_thoughts,
    async (input) => {
      try {
        return say.renderSearchThoughts(await core.searchThoughts(principal, input), input.prefer_current);
      } catch (err: unknown) {
        return say.failed(err, input.prefer_current ? say.currentSearchHint : undefined);
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
    SPECS.search_thoughts_keyword,
    async (input) => {
      try {
        return say.renderSearchThoughtsKeyword(await core.searchThoughtsKeyword(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
      }
    }
  );

  // Tool 2: List Recent
  if (canRead(principal)) server.registerTool(
    "list_thoughts",
    SPECS.list_thoughts,
    async (input) => {
      try {
        return say.renderListThoughts(await core.listThoughts(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
      }
    }
  );

  // Tool 2b: the supersession review queue (migration 029, SMD-1294)
  if (canRead(principal)) server.registerTool(
    "list_supersession_proposals",
    SPECS.list_supersession_proposals,
    async (input) => {
      try {
        return say.renderSupersessionProposals(await core.listSupersessionProposals(principal, input));
      } catch (err: unknown) {
        return say.failed(err, say.proposalsHint);
      }
    }
  );

  // Tool 3: Stats
  if (canRead(principal)) server.registerTool(
    "thought_stats",
    SPECS.thought_stats,
    async (input) => {
      try {
        return say.renderThoughtStats(await core.thoughtStats(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
      }
    }
  );

  // Tool 3b: the change feed (migration 052, SMD-1296) — what moved since a
  // time or a cursor, for an agent that returns after a break. Gated like the
  // other read tools (canRead: a read or a write key sees it, a capture-only
  // key does not). The store calls one SQL function that chooses the page
  // and bounds the rendering; the operation decides `since`, render.ts lays the
  // rows out.
  if (canRead(principal)) server.registerTool(
    "thought_changes",
    SPECS.thought_changes,
    async (input) => {
      try {
        return say.renderThoughtChanges(await core.thoughtChanges(principal, input));
      } catch (err: unknown) {
        return say.failed(err, say.changesHint);
      }
    }
  );

  // Tool 3b-ii: the corpus's thought ids (SMD-2244) — ids only, in id order, for a
  // cheap cross-brain id-set diff (db/tier.ts --compare) that the prose read tools
  // cannot give (they page content, capped). One JSON object per page,
  // {total, digest, ids, cursor}: total and the whole-corpus md5 digest ride the
  // first page (SQL store; the PostgREST shim leaves digest null), and `after` =
  // the previous page's `cursor` pages on until it is null. Read-only, ids only —
  // no content, no vectors. Gated like the other read tools, so a capture-only key
  // never sees it.
  if (canRead(principal)) server.registerTool(
    "list_thought_ids",
    SPECS.list_thought_ids,
    async (input) => {
      try {
        return say.renderThoughtIds(await core.listThoughtIds(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
      }
    }
  );

  // Tool 3b-iii: the brain's logged searches (SMD-2245) — the query_log rows a
  // cross-brain replay sources from (db/tier.ts --compare --from-log), so it can
  // replay what a brain ACTUALLY searched instead of a supplied set. Telemetry
  // (migration 034), read-key gated, no thought content, no keys. One JSON object
  // {searches, truncated}: the most recent searches at or after `since`, bounded by
  // `limit` (a replay is two searches per row, so a window is the unit, not the
  // whole log). Empty when OB1_QUERY_LOG was never on.
  if (canRead(principal)) server.registerTool(
    "list_logged_searches",
    SPECS.list_logged_searches,
    async (input) => {
      try {
        return say.renderLoggedSearches(await core.listLoggedSearches(principal, input));
      } catch (err: unknown) {
        return say.failed(err, say.loggedSearchesHint);
      }
    }
  );

  // Tool 3b-iv: the background-work queues (SMD-2131) — per work_type, what is
  // pending / in flight / done / failed / stalled over thought_work_claims, so an
  // operator or agent can ask a running brain about its queues without shelling into
  // Postgres (SMD-1844 closed the host port). Read-only, aggregated in SQL; SQL
  // backend only (the table is not on PostgREST). Gated like the other read tools.
  if (canRead(principal)) server.registerTool(
    "worker_status",
    SPECS.worker_status,
    async (input) => {
      try {
        return say.renderWorkerStatus(await core.workerStatus(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
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
    SPECS.brain_info,
    async () => {
      try {
        return say.renderBrainInfoReply(await core.brainInfo("tool"));
      } catch (err: unknown) {
        return say.failed(err);
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
    SPECS.capture_thought,
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
            return toolError(`Error: this key's \`supersedes\` could not be checked against the target's capture record (${why})${noPrivilege ? " — the server role needs SELECT on thought_audit: cd db && bun migrate.ts --grant <role> --url $DATABASE_URL" : ""}.`, { code: "SUPERSEDES_UNJUDGED", retryable: true });
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
            if (principal.agentUnresolved === "refused") return toolError("Refused: a capture-scoped key may name as `supersedes` only a thought it captured itself, and this key's identity could not be resolved — the agent registry refused its name or digest; see the server log.", { code: "REFUSED_SUPERSEDES_OWNERSHIP", retryable: false });
            return toolError("Error: this key's `supersedes` could not be attributed while the agent registry is unavailable — retry when resolve_agent answers.", { code: "SUPERSEDES_UNJUDGED", retryable: true });
          }
          const own = writer !== null && (
            writer.agentId !== null && principal.agentId !== undefined ? writer.agentId === principal.agentId
              : writer.agentId === null && principal.agentId === undefined ? writer.actorName === principal.name
                : false);
          if (!own) return toolError("Refused: a capture-scoped key may name as `supersedes` only a thought it captured itself.", { code: "REFUSED_SUPERSEDES_OWNERSHIP", retryable: false });
        }
        // What may leave the box (SMD-1903): asked once, for both calls, and
        // only the allowed ones are made — a refused capture costs no request
        // and lands all the same, without the vector or the tags the refused
        // call would have produced, with the decision on its audit row.
        const cfg = embedConfig();
        // Gated on `actor` (the key, proven) and `marker` (the text), NOT
        // `source`: a capture's `source` is the caller's claim, so the subject
        // carries none and no `source:` term can match this call — re-adding it
        // here reopens the dodge (SMD-1941; egress.ts EGRESS_UNITS). The row
        // still RECORDS the label below, for the passes and the per-source weight.
        const subject: EgressSubject = { kind: "capture", actor: principal.name, content };
        const gate = decideCalls(subject, cfg, cfg.egress);
        // Independent of each other, so they overlap. The genre classifier reads
        // the caller's metadata (a `source:linear`/arXiv pre-signal) and, only
        // when the tier is configured, the content — never the extractor's tags,
        // so it need not wait for extractMetadata (SMD-2323). Its own egress is
        // the tier's, so it runs regardless of the capture's chat gate; a tier
        // outage falls back to `other` inside the classifier, never here.
        const [embedded, metadata, genre] = await Promise.all([
          gate.embeddings.allowed ? embedCapture(content, subject) : Promise.resolve(undefined),
          gate.chat.allowed ? extractMetadata(content, subject) : Promise.resolve(metadataRefused()),
          classifyThoughtGenre(content, { ...clientMetadata, source: origin }, subject),
        ]);
        const chunks = embedded?.chunks ?? [];
        const contextFailures = embedded?.contextFailures ?? 0;

        // The caller's keys UNDER the server's: the extractor's tags and the
        // origin label win over anything a caller sent by the same name (the
        // shape check above has already refused a reserved key outright, so this
        // only orders the rest), and `summary_model` and its like survive
        // (SMD-2014).
        // `genre` last, over both spreads: the classifier already honours a valid
        // caller-supplied genre (its pre-signal returns it), so placing the
        // classified value here lets that one round-trip while a bogus one is
        // overwritten by the classification (SMD-2323).
        const payload = { metadata: { ...clientMetadata, ...metadata, source: origin, genre: genre.genre } };

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
          // 061: what this capture derived and how — the windows' split and
          // the extractor's model, prompt version and hash — recorded with
          // the write (SMD-1731). Nothing when it made no windows and the
          // extraction failed or was refused: a caller's tags are not a
          // derivation.
          lineage: captureLineage(cfg, embedded, metadata),
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
        if (/thoughts_supersedes_fkey/.test(msg)) return toolError("Refused: no thought with the id given as supersedes. Pass the id of an existing thought — the ID: line of a search result.", { code: "REFUSED_SUPERSEDES_UNKNOWN", retryable: false });
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
          // The positions ride the code only when they are NAMED in the prose —
          // a caller allowed to know a source exists (the existence-oracle rule);
          // a capture key gets the code with no positions, as it gets no prose
          // position (SMD-1978).
          return toolError(`Refused: ${where} name${named.length > 1 ? "" : "s"} no thought. Each entry must be an existing thought id (the ID: line of a search result).`, { code: "DERIVED_FROM_MISSING", retryable: false, ...(named.length ? { positions: named } : {}) });
        }
        // The store did not answer as itself — down, a missing function, a front
        // returning 401: a transient the caller keeps and retries (SMD-1978).
        return toolError(`Error: ${msg}`, { code: "STORE_UNAVAILABLE", retryable: true });
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
    SPECS.update_thought,
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
        // Here a `source:` term DOES gate: the label is the row's, written by
        // the server at its capture, not a claim on this call — the opposite of
        // capture_thought, which keeps its caller-claimed `source` off the
        // subject so it cannot gate (SMD-1941).
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
          // 061: the windows' recipe when the new text made windows; the patch
          // is the caller's, so no tag recipe (SMD-1731).
          lineage: captureLineage(cfg, embedded, undefined),
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
    SPECS.delete_thought,
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

  // Tool 12 & 13: the write half of worker_status (SMD-2132). Both mutate
  // thought_work_claims and consume nothing on the model — they are the control
  // plane over the EXISTING claim machinery (migration 015), not a new worker or
  // scheduler, and never run the LLM drain (the server does not; entities.ts).
  // Write-scoped, like update/delete: a read or capture key is refused, and the
  // tool is never registered for it. Each stamps the calling key as actor into
  // the action log, one row per affected thought (logActionCalls; the id is the
  // UUID it needs). The keyed REST mirror is the app.post guard below.
  if (canWrite(principal)) server.registerTool(
    "retry_failed",
    SPECS.retry_failed,
    async ({ work_type }) => {
      try {
        if (work_type.trim() === "") return toolError("Refused: work_type is required — pass the exact `workType` worker_status reports for the pool to retry.", { code: "REFUSED_EMPTY_WORK_TYPE", retryable: false });
        const result = await (await db()).retryFailed(work_type);
        // Audit: one action row per requeued thought, actor = this key (SMD-2132).
        await logActionCalls(result.ids.map((id) => ({ tool: "retry_failed", targetId: id })));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        // Codeless, as delete_thought/update_thought and worker_status are: on a
        // PostgREST (Workers) deploy the store throws the SQL-only reason, which is
        // permanent, not the transient STORE_UNAVAILABLE a code would imply.
        return toolError(`retry_failed failed: ${(e as Error).message}`);
      }
    }
  );

  if (canWrite(principal)) server.registerTool(
    "release_stale_leases",
    SPECS.release_stale_leases,
    async ({ work_type, worker_id, include_live }) => {
      try {
        if (work_type !== undefined && work_type.trim() === "") return toolError("Refused: work_type was given but blank — omit it to reap across all pools, or pass a real `workType`.", { code: "REFUSED_EMPTY_WORK_TYPE", retryable: false });
        if (include_live === true && (worker_id === undefined || worker_id.trim() === "")) {
          return toolError("Refused: include_live releases a lease that has not lapsed, which risks the holder double-processing — name the worker_id whose live lease to release (worker_status reports the holder).", { code: "REFUSED_LIVE_LEASE_NEEDS_WORKER", retryable: false });
        }
        const result = await (await db()).releaseStaleLeases({ workType: work_type, workerId: worker_id, includeLive: include_live === true });
        await logActionCalls(result.ids.map((id) => ({ tool: "release_stale_leases", targetId: id })));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return toolError(`release_stale_leases failed: ${(e as Error).message}`);
      }
    }
  );

  // Tool 14: run_worker — the drain SMD-2132 carved out (SMD-2272). The third
  // worker action, write-scoped like its two siblings. Only its dry_run half is
  // built: a pure-SQL preview of what a pass over `work_type` would claim,
  // matching worker_status, claiming nothing. The EXECUTING drain is deferred —
  // the server deliberately never runs the bulk LLM passes (entities.ts,
  // consolidate.ts), and the claim loop has no importable core yet (it is inline
  // in each db/*.ts main(), SMD-2304). So dry_run must be EXPLICITLY true; any
  // other call is refused as a value (RUN_WORKER_DRAIN_NOT_AVAILABLE), so an
  // operator never mistakes a silent no-op for a real drain. dry_run mutates
  // nothing, so — unlike retry_failed/release_stale_leases — it writes no action
  // log row; the write gate still refuses a read/capture key, and the scope will
  // not change when the drain lands.
  if (canWrite(principal)) server.registerTool(
    "run_worker",
    SPECS.run_worker,
    async ({ work_type, dry_run, limit }) => {
      try {
        if (work_type.trim() === "") return toolError("Refused: work_type is required — pass the exact `workType` worker_status reports for the pool to drain.", { code: "REFUSED_EMPTY_WORK_TYPE", retryable: false });
        if (dry_run !== true) {
          return toolError("Refused: the executing drain is not yet available — the server does not run the bulk LLM passes, and the drain will land on a callable worker core (SMD-2304). Call with dry_run: true to preview what a pass would claim.", { code: "RUN_WORKER_DRAIN_NOT_AVAILABLE", retryable: false });
        }
        const result = await (await db()).dryRunClaim(work_type, limit);
        // No audit row: a dry run claims and mutates nothing (unlike the two
        // sibling write actions), so there is no thought to record an action against.
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        // Codeless, as retry_failed/release_stale_leases are: on a PostgREST
        // (Workers) deploy the store throws the permanent SQL-only reason.
        return toolError(`run_worker failed: ${(e as Error).message}`);
      }
    }
  );

  // Tool 3b-v: poll an async job by its handle (SMD-2273). GET /jobs/<id> is the
  // curl mirror; an MCP client cannot reach a REST route, so this tool is how a
  // Claude Desktop / claude.ai client fetches the result of a job it started.
  // Ownership-scoped: a job is visible only to the key that started it (the
  // handle inherits that call's scope), so a wrong id or another key's job reads
  // as not found. Read-only. A registry fault (the durable jobs table away,
  // SMD-2318) is FAILED like every read tool's (review pass 4: it reached the
  // SDK's default error result, with no code).
  if (canRead(principal)) server.registerTool(
    "job_status",
    SPECS.job_status,
    async (input) => {
      try {
        return say.renderJobStatus(await core.jobStatus(principal, input));
      } catch (err: unknown) {
        return say.failed(err);
      }
    }
  );

  // Tool 3b-vi: the first async-job-backed tool (SMD-2273) — a bounded, paged
  // scan of the corpus that returns a job HANDLE at once rather than blocking,
  // exercising the handle/poll/stream pattern end to end. Real and safe
  // (read-only) and long-capable on a large brain; the heavier consumers (a
  // re-embed backfill, the run_worker drain SMD-2272) build on the same
  // startJob. Read-only, but it starts background work, so it is gated like the
  // reads; the detached run is tracked, so the stop waits for it.
  if (canRead(principal)) server.registerTool(
    "scan_thoughts",
    SPECS.scan_thoughts,
    async (input) => {
      try {
        return say.renderJobHandle(await core.scanThoughts(principal, input, { track: toolCalls.track }));
      } catch (err: unknown) {
        return say.failed(err);
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
  // Retry-After is not a CORS-safelisted response header, so a browser-hosted
  // client (claude.ai, the Claude Desktop connector) cannot read it off a fetch
  // without this. It is the one header the fork means such a client to read —
  // the busy refusal's retry delay (SMD-2106) — so it is exposed; on a response
  // that carries no Retry-After this says nothing.
  "Access-Control-Expose-Headers": "Retry-After",
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

// How long a client should wait before retrying a refusal that can change —
// the busy case (a registry lock; agents.ts retries within its own deadline).
// Advisory, as `Retry-After` is: it names "a few seconds" as BUSY_MESSAGE says.
const RETRY_AFTER_SECONDS = 2;

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
 * Whether a refused body expects a JSON-RPC reply, and the id to echo if it
 * does. A Request expects one; a Notification (JSON-RPC 2.0: "the Server MUST
 * NOT reply") does not, and neither does a batch that is all notifications.
 *
 * Conservative: `expectsReply` is false ONLY when the body is positively
 * notification-only — every message a plain object with a string `method` and
 * NO `id` member (a genuine notification; the `id`'s VALUE does not matter, its
 * presence does — `id: null` is a request). Anything else — a request, a
 * response, a malformed body, a mixed or empty batch — keeps the 200 envelope,
 * so this only ever suppresses a reply where the spec forbids one. `id` is the
 * best-effort inbound id for the envelope (null for a batch or a bad body), as
 * before this helper existed.
 */
function refusalTarget(bodyText: string | null): { expectsReply: boolean; id: string | number | null } {
  const id = extractJsonRpcId(bodyText);
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    return { expectsReply: true, id };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const isNotification = (m: unknown): boolean =>
    typeof m === "object" && m !== null && !Array.isArray(m)
    && typeof (m as { method?: unknown }).method === "string"
    && !("id" in (m as object));
  const notificationOnly = messages.length > 0 && messages.every(isNotification);
  return { expectsReply: !notificationOnly, id };
}

/**
 * Build a JSON-RPC 2.0 error envelope response for auth failures on a REQUEST.
 * Returns HTTP 200 — the JSON-RPC layer expresses the error so that
 * strict MCP clients keep the connection alive instead of treating
 * the failure as a transport-level fault. This is the REQUEST shape; a refused
 * notification has no envelope (notificationRefusedResponse). `retryAfter` adds
 * the header on the busy request, as its bodyless twin sets it too (SMD-2106).
 */
function unauthorizedResponse(
  id: string | number | null,
  message: string = UNAUTHORIZED_MESSAGE,
  code: number = JSON_RPC_UNAUTHORIZED_CODE,
  opts: { retryAfter?: number } = {}
): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...corsHeaders,
  };
  if (opts.retryAfter !== undefined) headers["Retry-After"] = String(opts.retryAfter);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/**
 * The refusal for a NOTIFICATION-only body (SMD-2106): no JSON-RPC body, since
 * the spec forbids a reply to a notification and the MCP TS SDK cancels the
 * body of a 200 that held no request (dropping the notification silently). A
 * refusal that cannot change on retry — no, wrong or revoked key — answers 202
 * Accepted (the notification is taken and discarded); one that can — the
 * registry busy — answers 503 with `Retry-After`, so the client retries rather
 * than believing it was delivered.
 */
function notificationRefusedResponse(opts: { retryAfter?: number } = {}): Response {
  const headers: Record<string, string> = { ...corsHeaders };
  if (opts.retryAfter !== undefined) headers["Retry-After"] = String(opts.retryAfter);
  return new Response(null, { status: opts.retryAfter !== undefined ? 503 : 202, headers });
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
  const info = core.brainInfo("health");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal), // one lookup in flight per key (agents.ts)
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  return c.json(await info, 200, corsHeaders);
});

// The worker-queue status as a keyed GET (SMD-2131) — the REST mirror of the
// worker_status tool, the same authentication as /health (keyed reader → the JSON,
// capture/wrong/no/revoked key → plain "ok", HEAD → "ok"). Kept off the /health
// BrainInfo body deliberately: this read is SQL-backend only and would otherwise
// couple a work-queue read into the health path's identity budget.
const WORKER_STATUS_PATH = /(^|\/)worker-status\/?$/;
app.get("*", async (c, next) => {
  if (!WORKER_STATUS_PATH.test(c.req.path)) return next();
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: SCOPES });
  if (!principal || !canRead(principal)) return c.text("ok", 200, corsHeaders);
  if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
  // The same identity gate as /health: a revoked or unresolved key is shown nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  try {
    // The operation answers an object (a tool result is one); this route has always answered the bare rows.
    const status = await core.workerStatus(principal, {});
    return c.json(status.ok ? status.value.pools : [], 200, corsHeaders);
  } catch (e) {
    // SQL-only: a PostgREST (Workers) deployment cannot serve this — a reason, not a bare 500.
    return c.json({ error: (e as Error).message }, 200, corsHeaders);
  }
});

// The worker-queue ACTIONS as keyed POSTs (SMD-2132, SMD-2272) — the REST mirror
// of the retry_failed, release_stale_leases and run_worker tools. POST at every path is the MCP
// endpoint (app.on(MCP_METHODS, "*") below), so this guard is registered BEFORE
// it and falls through with next() for any path it does not own; the two action
// paths it handles never reach the transport, and no MCP client posts JSON-RPC
// there. WRITE-scoped (canWrite) — stricter than /worker-status's read mirror; a
// read/capture/no/wrong/revoked key is shown and does nothing (plain "ok",
// parity with /health and /worker-status). Args ride the JSON body; the
// refusals-as-values are the tool's, as a 400 carrying the same code, and the
// SQL-only reason (the PostgREST shim throws) is a 200 body as the read mirror's.
const WORKER_RETRY_PATH = /(^|\/)worker-retry-failed\/?$/;
const WORKER_RELEASE_PATH = /(^|\/)worker-release-leases\/?$/;
const WORKER_RUN_PATH = /(^|\/)worker-run\/?$/;
app.post("*", async (c, next) => {
  const isRetry = WORKER_RETRY_PATH.test(c.req.path);
  const isRelease = WORKER_RELEASE_PATH.test(c.req.path);
  const isRun = WORKER_RUN_PATH.test(c.req.path);
  if (!isRetry && !isRelease && !isRun) return next();
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: SCOPES });
  if (!principal || !canWrite(principal)) return c.text("ok", 200, corsHeaders);
  // The same identity gate as /worker-status: a revoked or unresolved key does nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  const body = await c.req.json().catch(() => null);
  const args: Record<string, unknown> = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // Actor audit, one action-log row per affected thought (SMD-2132): the resolved
  // agent id, tier and tool name, through the MCP tools' one writer (core/context.ts;
  // review pass 4 — a copy of its rules lived here).
  const audit = (tool: string, ids: string[]): Promise<void> =>
    core.ctx.logActions({ agentId: identity.agentId }, ids.map((id) => ({ tool, targetId: id })));
  try {
    if (isRetry) {
      const workType = typeof args.work_type === "string" ? args.work_type : "";
      if (workType.trim() === "") return c.json({ error: "work_type is required — pass the exact workType worker_status reports.", code: "REFUSED_EMPTY_WORK_TYPE" }, 400, corsHeaders);
      const result = await (await db()).retryFailed(workType);
      await audit("retry_failed", result.ids);
      return c.json(result, 200, corsHeaders);
    }
    if (isRun) {
      // run_worker's dry_run preview (SMD-2272): the same refusals as the tool —
      // a missing work_type, and the executing drain being unavailable — as 400s
      // carrying the same codes. A dry run mutates nothing, so no audit row (the
      // sibling actions above audit because they requeue/release). limit is
      // accepted from the body when it is a positive integer, else omitted.
      const runWorkType = typeof args.work_type === "string" ? args.work_type : "";
      if (runWorkType.trim() === "") return c.json({ error: "work_type is required — pass the exact workType worker_status reports for the pool to drain.", code: "REFUSED_EMPTY_WORK_TYPE" }, 400, corsHeaders);
      if (args.dry_run !== true) return c.json({ error: "the executing drain is not yet available — the server does not run the bulk LLM passes; the drain will land on a callable worker core (SMD-2304). Send dry_run: true to preview what a pass would claim.", code: "RUN_WORKER_DRAIN_NOT_AVAILABLE" }, 400, corsHeaders);
      const runLimit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
      const runResult = await (await db()).dryRunClaim(runWorkType, runLimit);
      return c.json(runResult, 200, corsHeaders);
    }
    const workType = args.work_type === undefined ? undefined : String(args.work_type);
    const workerId = args.worker_id === undefined ? undefined : String(args.worker_id);
    const includeLive = args.include_live === true;
    if (workType !== undefined && workType.trim() === "") return c.json({ error: "work_type was given but blank — omit it to reap across all pools, or pass a real workType.", code: "REFUSED_EMPTY_WORK_TYPE" }, 400, corsHeaders);
    if (includeLive && (workerId === undefined || workerId.trim() === "")) return c.json({ error: "include_live requires worker_id — releasing a live lease risks the holder double-processing.", code: "REFUSED_LIVE_LEASE_NEEDS_WORKER" }, 400, corsHeaders);
    const result = await (await db()).releaseStaleLeases({ workType, workerId, includeLive });
    await audit("release_stale_leases", result.ids);
    return c.json(result, 200, corsHeaders);
  } catch (e) {
    // SQL-only (the PostgREST shim throws), or a store failure: a reason, not a bare 500 (parity with /worker-status).
    return c.json({ error: (e as Error).message }, 200, corsHeaders);
  }
});

// The async job handle's poll and stream, as keyed GETs (SMD-2273). A tool like
// scan_thoughts returns { jobId, poll: "/jobs/<id>", stream: "/jobs/<id>/stream" }
// at once; these routes serve the follow-up for a REST/curl client (an MCP
// client cannot reach a REST route — it uses the job_status tool). Registered
// BEFORE the MCP handler (POST at every path) like the worker mirrors, and
// falling through with next() for any path they do not own; a GET that matches
// neither lands on notFound's 405. Ownership rides the key: a job is visible to
// the key that started it (its keyHash), so a valid key that is not the owner —
// or an unknown/aged-out id — gets `not found`, and a no/again wrong/capture key
// gets plain "ok" (parity with /worker-status). The stream path is tested first,
// being the more specific of the two.
const JOBS_STREAM_PATH = /(^|\/)jobs\/([^/]+)\/stream\/?$/;
const JOBS_PATH = /(^|\/)jobs\/([^/]+)\/?$/;
app.get("*", async (c, next) => {
  const streamMatch = JOBS_STREAM_PATH.exec(c.req.path);
  const pollMatch = streamMatch ? null : JOBS_PATH.exec(c.req.path);
  if (!streamMatch && !pollMatch) return next();
  const id = (streamMatch ?? pollMatch)![2];
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: env().MCP_ACCESS_KEY,
  }, { admit: SCOPES });
  if (!principal || !canRead(principal)) return c.text("ok", 200, corsHeaders);
  // HEAD carries no body for a job's state or stream: liveness, before the
  // identity resolve, exactly as /health and the worker mirrors answer it.
  if (c.req.method === "HEAD") return c.text("ok", 200, corsHeaders);
  // The same identity gate as the worker mirrors: a revoked or unresolved key is shown nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identity = await Promise.race([
    agents().resolve(db(), principal),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (!identity || identity.status !== "ok") return c.text("ok", 200, corsHeaders);
  if (streamMatch) {
    const stream = await subscribeJob(principal, id);
    if (!stream) return c.json({ error: "not found" }, 404, corsHeaders);
    const response = new Response(stream, { status: 200, headers: { ...corsHeaders, "content-type": "text/event-stream", "cache-control": "no-cache" } });
    // Kept alive by the same wrapper as the MCP stream (SMD-1864): the job's
    // events may be minutes apart, and a silent stream is reaped otherwise.
    return withSseKeepalive(response, { signal: c.req.raw.signal, label: `jobs/${labelPart(id)}/stream` });
  }
  const job = await core.jobStatus(principal, { job_id: id });
  if (!job.ok) return c.json({ error: "not found" }, 404, corsHeaders);
  return c.json(job.value, 200, corsHeaders);
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

/**
 * The same close when the server's own stop made it: the request was still
 * running when the stop closed it — at the drain bound, or on a second
 * signal (shutdown.ts) — and the process exits next, so the call does not run
 * to its end (review pass 1 of SMD-2250 — before, this was logged as the
 * client leaving).
 */
export function cutByStopLine(label: string, elapsedMs: number): string {
  return `request cut off by the server's stop after ${(elapsedMs / 1000).toFixed(1)} s: ${label} — still running when the stop closed it, and the process exits now; a capture may or may not have landed (SMD-2250)`;
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
    if (!settled) console.warn((cutByStop ? cutByStopLine : abandonedRequestLine)(label, performance.now() - started));
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
    const target = refusalTarget(bodyText);
    settled = true;
    // A notification (no id) gets no JSON-RPC body: 202, since no key never
    // changes on a retry (SMD-2106). A request keeps the 200 envelope.
    return target.expectsReply ? unauthorizedResponse(target.id) : notificationRefusedResponse();
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
    const target = refusalTarget(bodyText);
    settled = true;
    // Revoked never changes on a retry, so a notification gets a bare 202; busy
    // can, so it gets 503 + Retry-After (and a busy REQUEST keeps the 200
    // envelope but gains Retry-After too). A request stays the 200 envelope,
    // answering its id (SMD-2106).
    if (identity.status === "revoked") {
      return target.expectsReply ? unauthorizedResponse(target.id, REVOKED_MESSAGE) : notificationRefusedResponse();
    }
    return target.expectsReply
      ? unauthorizedResponse(target.id, BUSY_MESSAGE, JSON_RPC_BUSY_CODE, { retryAfter: RETRY_AFTER_SECONDS })
      : notificationRefusedResponse({ retryAfter: RETRY_AFTER_SECONDS });
  }
  principal.agentId = identity.agentId;
  principal.agentUnresolved = identity.unresolved;

  // The label, read once from the request body. v2's transport reads the raw
  // Request stream (v1's @hono/mcp read Hono's cached body, so a double-read was
  // harmless), so we cache the text here and hand a reconstructed Request to the
  // transport below — otherwise its parse sees an empty stream and every call
  // returns -32700 (SMD-2278). A body that cannot be read (the client gone
  // mid-upload) is `?` here and the transport's 400 there, as before.
  const rawBody = await c.req.text().catch(() => null);
  label = requestLabel(rawBody);

  const server = buildServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  // Hand the transport the body reconstructed from the cached text above. The
  // client-abort signal is deliberately not carried onto it: this route already
  // observes a disconnect through `c.req.raw.signal` at entry (the
  // abandoned-request log, and `withSseKeepalive` below), and the server runs a
  // started tool to completion (the keepalive comment below), so the transport
  // is not handed a signal that would cancel it mid-run.
  const mcpRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: rawBody ?? undefined,
  });
  const response = await transport.handleRequest(mcpRequest);
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

// Stopping on SIGTERM, what is in flight finished (SMD-2250; shutdown.ts says
// why the image needs it). Bun serves the default export below itself and
// hands the server to no one but the fetch handler, as its second argument, so
// the first request passes it on; before that nothing can be in flight. Only
// when this module is Bun's entry: never on Workers, whose second argument is
// its bindings, nor in a suite that imports the module.
const SERVES_ON_BUN = typeof Bun !== "undefined" && import.meta.main === true;
let bunServer: Stoppable | undefined;
/** Set once the stop closes what is still in flight at its bound, so the route's close line names the stop, not the client. */
let cutByStop = false;
if (SERVES_ON_BUN) {
  const grace = drainBoundFrom(process.env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls: toolCalls,
    // The pool only if a request opened one: a store that failed to build has
    // none, and the PostgREST store holds no pooled connection to close.
    close: async () => (_store ? _store.then(async (s) => { await s.close(); return s.kind === "sql"; }, () => false) : false),
    onCut: () => {
      cutByStop = true;
      // Jobs still running when the stop cuts what is in flight are marked lost,
      // so a poll or stream in flight sees a terminal answer rather than hanging.
      // The job bodies are tracked through toolCalls (startJob's `track`), so the
      // drain above already waited on them up to its bound; this cuts what did
      // not finish. With a durable store (SMD-2318) the `lost` is written through
      // and survives the restart; without one it is in-memory and a poll after a
      // restart gets `not found` (SMD-2273). Either way the startup reconcile is
      // the backstop for a write cut off before it landed.
      const lost = markRunningLost();
      if (lost > 0) console.warn(`stop cut ${lost} running job${lost === 1 ? "" : "s"}: marked lost (SMD-2273)`);
    },
  });
}

export default {
  // Workers reads `fetch`; Bun also reads `port`. Node uses @hono/node-server.
  // No `idleTimeout`: a tool call outlives the default by the keepalive above,
  // and the default is the right reaper for a dead socket (SMD-1864).
  // An empty PORT is unset, not port 0 (a random port, silently) — `||`, the rule the vendored servers' tails share (SMD-1799).
  port: Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PORT || 8000),
  fetch: (...args: Parameters<typeof app.fetch>) => {
    if (SERVES_ON_BUN && !bunServer && isStoppable(args[1])) bunServer = args[1];
    return app.fetch(...args);
  },
};