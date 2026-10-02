
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createStore, postgrestOnBunNotice, storeKind, type ThoughtStore } from "./store.ts";
import { tierProblem, trimmedEnv } from "../db/config.mjs";
import { authenticateRequest, canCapture, canRead, canWrite, SCOPES, type Principal } from "./auth.ts";
import { AgentResolver, cacheTtlFromEnv } from "./agents.ts";
import { FORK_VERSION } from "./version.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "./shutdown.ts";
import { subscribe as subscribeJob, markRunningLost, setJobSink } from "./jobs.ts";
import { createCore, SPECS, type Input, type Outcome, type RefusalCode } from "./core/index.ts";
import type { ToolName } from "./tools.ts";
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
/**
 * This server's name: what MCP clients see in `initialize`, and the door every
 * write names in its actor (`via`), which migration 046 stamps as
 * thought_audit.origin (SMD-1730). One constant, so the two cannot drift; the
 * core takes it as its door.
 */
const SERVER_NAME = "open-brain";
const core = createCore({ env, store: db, door: SERVER_NAME });

// --- MCP Server Setup ---

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

  // A tool whose logic is in core/ (SMD-2283): registered only when `allowed` —
  // the key's scope; a tool a key may not use is absent from its tools/list,
  // not refused — with the SDK validating the input against the tool's spec,
  // `run` calling the operation and rendering its outcome (render.ts), and
  // `fault` saying what an operation throws (review pass 6: sixteen copies of
  // that body before).
  const registerOp = <K extends ToolName>(name: K, allowed: boolean, run: (input: Input<K>) => Promise<say.Reply>, fault: (err: unknown, input: Input<K>) => say.Reply): void => {
    if (!allowed) return;
    // The generic K loses the SDK's per-tool inference of `input`; SPECS[name]'s
    // schema is what it validates against, and Input<K> is that schema's output.
    const register = server.registerTool as unknown as (name: string, spec: unknown, handler: (input: Input<K>) => Promise<say.Reply>) => unknown;
    register(name, SPECS[name], async (input) => {
      try {
        return await run(input);
      } catch (err: unknown) {
        return fault(err, input);
      }
    });
  };

  // The read tools: each is its operation in core/reads.ts — the search op
  // with its egress gate and query log, the store reads, the probes — and its
  // words in render.ts, for a key that may read; a fault is `Error: <message>`
  // with the tool's hint where it has one, FAILED beside it.
  const readTool = <K extends ToolName>(name: K, run: (input: Input<K>) => Promise<say.Reply>, hint?: (input: Input<K>) => ((msg: string) => string) | undefined): void =>
    registerOp(name, canRead(principal), run, (err, input) => say.failed(err, { hint: hint?.(input) }));

  // ChatGPT compatibility: restricted connector surfaces, company knowledge, and
  // deep research look for exact read-only `search` and `fetch` tool shapes. Why
  // the shape pins hybrid, no recency weight and no prefer_current: core/reads.ts.
  readTool("search", async (input) => say.renderSearch(await core.search(principal, input)));
  readTool("fetch", async (input) => say.renderFetch(await core.fetch(principal, input)));

  // Tool 1: Search — semantic, with the identifiers in the query matched exactly.
  //
  // Hybrid since migration 017 (SMD-958). The description says what is matched
  // literally, because that is the part the model reads before deciding whether
  // it still needs search_thoughts_keyword: it does, for paging through every
  // thought containing a string, and for a needle the extraction rule would not
  // pick out of a sentence on its own.
  readTool("search_thoughts",
    async (input) => say.renderSearchThoughts(await core.searchThoughts(principal, input), input.prefer_current),
    (input) => (input.prefer_current ? say.currentSearchHint : undefined));

  /**
   * Tool 1b: Exact keyword search. Migration 012, SMD-944.
   *
   * A separate tool rather than a `mode` on search_thoughts. The two have
   * different cost models, different result shapes and different failure modes,
   * and an LLM choosing between two clearly-described tools does better than one
   * choosing between two meanings of one tool. The description leads with WHEN to
   * reach for it, because that is the only part the model reads before deciding.
   */
  readTool("search_thoughts_keyword", async (input) => say.renderSearchThoughtsKeyword(await core.searchThoughtsKeyword(principal, input)));

  // Tool 2: List Recent
  readTool("list_thoughts", async (input) => say.renderListThoughts(await core.listThoughts(principal, input)));

  // Tool 2b: the supersession review queue (migration 029, SMD-1294)
  readTool("list_supersession_proposals", async (input) => say.renderSupersessionProposals(await core.listSupersessionProposals(principal, input)), () => say.proposalsHint);

  // Tool 3: Stats
  readTool("thought_stats", async (input) => say.renderThoughtStats(await core.thoughtStats(principal, input)));

  // Tool 3b: the change feed (migration 052, SMD-1296) — what moved since a
  // time or a cursor, for an agent that returns after a break. Gated like the
  // other read tools (canRead: a read or a write key sees it, a capture-only
  // key does not). The store calls one SQL function that chooses the page
  // and bounds the rendering; the operation decides `since`, render.ts lays the
  // rows out.
  readTool("thought_changes", async (input) => say.renderThoughtChanges(await core.thoughtChanges(principal, input)), () => say.changesHint);

  // Tool 3b-ii: the corpus's thought ids (SMD-2244) — ids only, in id order, for a
  // cheap cross-brain id-set diff (db/tier.ts --compare) that the prose read tools
  // cannot give (they page content, capped). One JSON object per page,
  // {total, digest, ids, cursor}: total and the whole-corpus md5 digest ride the
  // first page (SQL store; the PostgREST shim leaves digest null), and `after` =
  // the previous page's `cursor` pages on until it is null. Read-only, ids only —
  // no content, no vectors. Gated like the other read tools, so a capture-only key
  // never sees it.
  readTool("list_thought_ids", async (input) => say.renderThoughtIds(await core.listThoughtIds(principal, input)));

  // Tool 3b-iii: the brain's logged searches (SMD-2245) — the query_log rows a
  // cross-brain replay sources from (db/tier.ts --compare --from-log), so it can
  // replay what a brain ACTUALLY searched instead of a supplied set. Telemetry
  // (migration 034), read-key gated, no thought content, no keys. One JSON object
  // {searches, truncated}: the most recent searches at or after `since`, bounded by
  // `limit` (a replay is two searches per row, so a window is the unit, not the
  // whole log). Empty when OB1_QUERY_LOG was never on.
  readTool("list_logged_searches", async (input) => say.renderLoggedSearches(await core.listLoggedSearches(principal, input)), () => say.loggedSearchesHint);

  // Tool 3b-iv: the background-work queues (SMD-2131) — per work_type, what is
  // pending / in flight / done / failed / stalled over thought_work_claims, so an
  // operator or agent can ask a running brain about its queues without shelling into
  // Postgres (SMD-1844 closed the host port). Read-only, aggregated in SQL; SQL
  // backend only (the table is not on PostgREST). Gated like the other read tools.
  readTool("worker_status", async (input) => say.renderWorkerStatus(await core.workerStatus(principal, input)));

  // Tool 3c: what this brain is (SMD-2041) — version, commit, store, tier, the
  // database's versions, ledger, counts, size and HNSW parameters, one short
  // table. Gated like the other read tools. The same record is the keyed
  // /health body, as JSON; brainInfo never raises, so a database that cannot
  // answer is a line in the table, not a tool error.
  readTool("brain_info", async () => say.renderBrainInfoReply(await core.brainInfo("tool")));

  // Tool 4: Capture Thought — the tool that adds.
  //
  // Registered for a key that may capture — write scope, or the capture-only
  // scope a session-end hook holds (SMD-1298). A read-only key does not get a
  // permission error from it; the tool is absent from tools/list entirely, so the
  // client never offers it and never tries. That is a smaller surface than
  // refusing the call, and it is honest about what the key can do. The read
  // tools above are gated the same way for a capture key: absent, not refused.
  // Its rules — the shapes, the capture key's pointers and provenance, the
  // egress gate, the parallel model calls, the write and its cites — are
  // core/writes.ts's; a fault is STORE_UNAVAILABLE, a transient the session
  // hook keeps and retries (SMD-1978).
  registerOp("capture_thought", canCapture(principal),
    async (input) => say.renderCapture(await core.capture(principal, input)),
    (err) => say.storeUnavailable(err));

  /**
   * Both are writes, so both are gated on scope exactly as capture_thought is —
   * a read-scoped key does not merely get a permission error, the tools are
   * never registered and do not appear in tools/list. A fault keeps the tool's
   * own lead, `update_thought failed:`, FAILED beside it.
   */
  registerOp("update_thought", canWrite(principal),
    async (input) => say.renderUpdate(await core.updateThought(principal, input)),
    (err) => say.failed(err, { lead: "update_thought failed: " }));

  registerOp("delete_thought", canWrite(principal),
    async (input) => say.renderDelete(await core.deleteThought(principal, input)),
    (err) => say.failed(err, { lead: "delete_thought failed: " }));

  // Tool 12 & 13: the write half of worker_status (SMD-2132), and Tool 14,
  // run_worker's dry-run preview (SMD-2272) — core/workers.ts. Write-scoped,
  // like update/delete: a read or capture key is never registered them. The two
  // mutating actions stamp the calling key into the action log, one row per
  // affected thought; the preview mutates nothing and writes none. A fault keeps
  // the tool's lead, `<tool> failed:`, FAILED beside it — on a PostgREST
  // (Workers) deploy the store throws the SQL-only reason, which is permanent,
  // not the transient STORE_UNAVAILABLE capture's implies. The keyed REST mirror
  // is the app.post guard below, over the same operations.
  registerOp("retry_failed", canWrite(principal),
    async (input) => say.renderRetryFailed(await core.retryFailed(principal, input)),
    (err) => say.failed(err, { lead: "retry_failed failed: " }));

  registerOp("release_stale_leases", canWrite(principal),
    async (input) => say.renderReleaseStaleLeases(await core.releaseStaleLeases(principal, input)),
    (err) => say.failed(err, { lead: "release_stale_leases failed: " }));

  registerOp("run_worker", canWrite(principal),
    async (input) => say.renderRunWorker(await core.runWorker(principal, input)),
    (err) => say.failed(err, { lead: "run_worker failed: " }));

  // Tool 3b-v: poll an async job by its handle (SMD-2273). GET /jobs/<id> is the
  // curl mirror; an MCP client cannot reach a REST route, so this tool is how a
  // Claude Desktop / claude.ai client fetches the result of a job it started.
  // Ownership-scoped: a job is visible only to the key that started it (the
  // handle inherits that call's scope), so a wrong id or another key's job reads
  // as not found. Read-only. A registry fault (the durable jobs table away,
  // SMD-2318) is FAILED like every read tool's.
  readTool("job_status", async (input) => say.renderJobStatus(await core.jobStatus(principal, input)));

  // Tool 3b-vi: the first async-job-backed tool (SMD-2273) — a bounded, paged
  // scan of the corpus that returns a job HANDLE at once rather than blocking,
  // exercising the handle/poll/stream pattern end to end. Real and safe
  // (read-only) and long-capable on a large brain; the heavier consumers (a
  // re-embed backfill, the run_worker drain SMD-2272) build on the same
  // startJob. Read-only, but it starts background work, so it is gated like the
  // reads; the detached run is tracked, so the stop waits for it.
  readTool("scan_thoughts", async (input) => say.renderJobHandle(await core.scanThoughts(principal, input, { track: toolCalls.track })));

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
  // The MCP tools' own operations (core/workers.ts): the same refusals, said
  // here as a 400 carrying the code, and the same action-log rows, one per
  // affected thought, stamped with the resolved agent id (SMD-2132). A dry run
  // mutates nothing, so it writes none.
  const caller: Principal = { ...principal, agentId: identity.agentId };
  const said = <T extends object>(o: Outcome<T>, words: Partial<Record<RefusalCode, string>>) => o.ok
    ? c.json(o.value, 200, corsHeaders)
    : c.json({ error: words[o.refusal.code] ?? o.refusal.code, code: o.refusal.code }, 400, corsHeaders);
  const named = (v: unknown): string => (typeof v === "string" ? v : "");
  try {
    if (isRetry) return said(await core.retryFailed(caller, { work_type: named(args.work_type) }), {
      REFUSED_EMPTY_WORK_TYPE: "work_type is required — pass the exact workType worker_status reports.",
    });
    if (isRun) {
      // limit is accepted from the body when it is a positive integer, else omitted.
      const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
      return said(await core.runWorker(caller, { work_type: named(args.work_type), dry_run: args.dry_run === true, limit }), {
        REFUSED_EMPTY_WORK_TYPE: "work_type is required — pass the exact workType worker_status reports for the pool to drain.",
        RUN_WORKER_DRAIN_NOT_AVAILABLE: "the executing drain is not yet available — the server does not run the bulk LLM passes; the drain will land on a callable worker core (SMD-2304). Send dry_run: true to preview what a pass would claim.",
      });
    }
    return said(await core.releaseStaleLeases(caller, {
      work_type: args.work_type === undefined ? undefined : String(args.work_type),
      worker_id: args.worker_id === undefined ? undefined : String(args.worker_id),
      include_live: args.include_live === true,
    }), {
      REFUSED_EMPTY_WORK_TYPE: "work_type was given but blank — omit it to reap across all pools, or pass a real workType.",
      REFUSED_LIVE_LEASE_NEEDS_WORKER: "include_live requires worker_id — releasing a live lease risks the holder double-processing.",
    });
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