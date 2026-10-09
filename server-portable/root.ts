// The process root a serving entry owns (SMD-2284): the environment it reads,
// the one store it builds and closes, and the agent registry over it — moved
// out of index.ts, so the MCP server and the REST core (SMD-2284) each build
// their core over the same wiring rather than two copies of it. Nothing here
// answers a request; each entry registers its routes over these readers.

import { createStore, postgrestOnBunNotice, storeKind, type ThoughtStore } from "./store.ts";
import { tierProblem, trimmedEnv } from "../db/config.mjs";
import { AgentResolver, cacheTtlFromEnv } from "./agents.ts";
import { setJobSink } from "./jobs.ts";
import { loadPlugins, type LoadedPlugin } from "./core/plugins.ts";
import { knowTools } from "./telemetry.ts";

/**
 * Runtime-portable env access.
 *
 * Workers has no module scope for secrets — bindings arrive on the request
 * context, so nothing can be read at import time. Deno, Bun and Node all expose
 * globals instead. Reading through this shim (seeded by the first middleware)
 * lets one file run on all four.
 */
export type Env = {
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
  /**
   * The stack's one public origin (SMD-2382): scheme, host and port, no path —
   * `https://`, or `http://` on loopback. The authorization server's issuer is
   * `<origin>/auth`, and this server's public resource `<origin>/mcp`. The
   * server reads it only while COMPOSE_PROFILES names auth (oauth-edge.ts);
   * preflight warns whenever it is set and is not a sound origin.
   */
  OB1_PUBLIC_ORIGIN?: string;
  /**
   * deploy/.env's compose profiles, forwarded so this server knows whether the
   * stack is configured for OAuth — `auth` among them (ADR decision 16). A
   * profile cannot set another service's environment, so compose passes the
   * list itself, as it does to the authorization server.
   */
  COMPOSE_PROFILES?: string;
  /**
   * The plugins this brain runs (SMD-2310): comma-separated names from
   * plugins/registry.ts. Unset, none. A name that is no plugin refuses to
   * start — preflight first, then the entry (plugins.ts).
   */
  OB1_PLUGINS?: string;
  /**
   * The password of the login role plugins' SQL runs on, `ob1_plugins`
   * (SMD-2310): the migrator makes the role with it, and the servers' plugin
   * pools log in with it. Required while an enabled plugin keeps tables.
   */
  OB1_PLUGIN_DB_PASSWORD?: string;
};

let ENV: Env | null = null;

export function initEnv(bindings?: Record<string, unknown>): void {
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

export function env(): Env {
  if (!ENV) throw new Error("env accessed before initEnv() — is the seeding middleware registered?");
  return ENV;
}

/**
 * The server this process serves as, by its door (`open-brain`, the MCP
 * server; `open-brain-api`, the REST core): set by the entry module Bun runs,
 * before any request, and never by a suite that imports one. The store's
 * first build reads it to wire the durable job store (below) for that server
 * alone — its jobs carry the name, and its reconcile touches only those
 * (migration 078, SMD-2284).
 */
let serving: string | null = null;
export function serveHere(door: string): void {
  serving = door;
  // The store built now, not at the first keyed request, so the reconcile of
  // this server's jobs a prior run left live happens at start-up: an internal
  // REST core may wait long for its first caller, and meanwhile the other
  // server's polls would read those dead jobs as running (SMD-2284 PR 3
  // review pass 1). A store that fails to build here fails again, and says
  // so, at the first request.
  initEnv();
  // A name in OB1_PLUGINS that is no plugin stops the server here, not at its first request (SMD-2310).
  plugins();
  void db().catch(() => {});
}

// Built once, on first use. createStore() dynamically imports whichever backend
// is configured, so a Cloudflare build never pulls in the Postgres client. The
// PostgREST store selected where the SQL store runs is said once, here, at the
// moment the selection takes effect (change 97); preflight says it at the
// entrypoint as well, so a container sees it before the first request.
let _store: Promise<ThoughtStore> | null = null;
let jobStoreWired = false;
export function db(): Promise<ThoughtStore> {
  if (!_store) {
    const notice = postgrestOnBunNotice(storeKind(env()));
    if (notice) console.warn(notice);
    _store = createStore(env());
    // Once, in the process that serves (serveHere) and the moment the store is
    // first built (env() is seeded by then): wire the durable job store (SMD-2318) and reconcile jobs a
    // prior process left running — a clean stop's `lost` write that did not land,
    // or a hard crash — so a poll after the restart sees a terminal answer, not a
    // live job with no runner. Detached and best-effort: the handle routes never
    // gate on it, the SQL store returns a sink, the PostgREST store returns null
    // (the registry stays in-memory), and a store that fails to build leaves it
    // in-memory too. A suite drives the sink itself (it holds the store).
    const door = serving;
    if (door !== null && !jobStoreWired) {
      jobStoreWired = true;
      void _store.then(async (store) => {
        const s = store.jobSink(door);
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

/**
 * The stop's close: the pool the store opened — at a serving entry's start
 * (serveHere), or at the first request where nothing called that — while a
 * store that failed to build has none, and the PostgREST store holds no pooled
 * connection to close. True when a SQL pool was closed. Beside db(), so the
 * store is named in these two bodies alone (check 25).
 */
export function closeStore(): Promise<boolean> {
  return _store ? _store.then(async (s) => { await s.close(); return s.kind === "sql"; }, () => false) : Promise.resolve(false);
}

// Built on first use, for the same reason as the store: reading env() at module
// scope runs before initEnv() has seeded it.
let _agents: AgentResolver | null = null;
export function agents(): AgentResolver {
  // Lookups are shared across requests only on the SQL store: on Workers (the
  // PostgREST store) a fetch belongs to the request that started it.
  if (!_agents) _agents = new AgentResolver(cacheTtlFromEnv(env().OB1_AGENT_CACHE_TTL_MS), Date.now, storeKind(env()) === "sql");
  return _agents;
}

// The enabled plugins (SMD-2310), read once from the seeded environment: both
// entries serve the same set, and a serving entry asks at its start so a name
// that is no plugin stops it there rather than at its first request. Their
// tool names join the core's in the request line (telemetry.ts).
let _plugins: LoadedPlugin[] | null = null;
export function plugins(): LoadedPlugin[] {
  if (!_plugins) {
    _plugins = loadPlugins(env().OB1_PLUGINS);
    knowTools(_plugins.flatMap((p) => p.operations.map((op) => op.tool)));
  }
  return _plugins;
}
